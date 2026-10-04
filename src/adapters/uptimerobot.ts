/**
 * UptimeRobot (monitoring): the HTTP monitor golive points at this app's production URL, the status
 * it reports, and the creation marker that is the only thing teardown may delete.
 *
 * One credential: the account's API key in UPTIMEROBOT_API_KEY, sent in every request's form body
 * (the v2 API is a form-encoded POST to /v2/<method>) and never in a URL, an error or state. What the
 * key may do is the key type the docs describe (see uptimerobot-api.ts): a read-only key reads, the
 * account's main key creates and deletes. The account is the one the key belongs to — the v2 API
 * names no team or sub-account, so there is nothing to guess between.
 *
 * A monitor golive creates carries a creation marker (`uptimerobot.createdMonitorId`) that teardown
 * reads before deleting anything; a monitor it adopted records no marker and is never deleted. A
 * deleted monitor is gone from the provider's own read (the docs publish no scheduled-deletion
 * state), so the confirmation read has two states.
 *
 * Deliberately untouched by golive: who gets alerted. `newMonitor`'s documented `alert_contacts`
 * parameter is optional and golive does not send it, so the account's own alert-contact rules decide
 * recipients — golive never adds, removes or redirects an alert. The reference records that the docs
 * do not spell the default out. `editMonitor` (pause/resume) exists in the docs but golive performs
 * no pause/resume, so it is not encoded.
 *
 * Beyond the shared contracts, the `uptime-monitor` check and the link need exactly this: the
 * account's monitor list and one exact monitor read, the approved create, and the state a teardown
 * confirmation reads. It is an optional member on the adapter's capabilities object (like
 * `OutputsProvider.provides`), not a new global capability: only a provider that watches a URL from
 * outside has anything to implement here.
 */
import type { Adapter, AuthStatus, Ctx, ProjectLinker, ProjectRef } from '../core/types.js';
import { isRegisteredSecret, redact } from '../core/secret.js';
import {
  UPTIMEROBOT_KEY_TYPES,
  UPTIMEROBOT_TOKEN,
  UptimerobotApiError,
  affectedMonitorId,
  uptimerobotCall,
  uptimerobotHelp,
} from './uptimerobot-api.js';

export { UPTIMEROBOT_API_HOST, UPTIMEROBOT_KEY_TYPES, UPTIMEROBOT_TOKEN, UptimerobotApiError, uptimerobotHelp } from './uptimerobot-api.js';

const errMsg = (e: unknown): string => redact(e instanceof Error ? e.message : String(e));

export const MONITOR_ID_KEY = 'uptimerobot.monitorId';
export const MONITOR_NAME_KEY = 'uptimerobot.monitorName';
/** The creation marker (`<provider>.createdMonitorId`): only a monitor this names is golive's to delete. */
export const CREATED_MONITOR_KEY = 'uptimerobot.createdMonitorId';

/** A selection, validation or destination problem. Provider refusals are UptimerobotApiError instead. */
export class UptimerobotError extends Error {}

/** Monitor type codes (docs: 1 - HTTP(s), 2 - Keyword, 3 - Ping, 4 - Port, 5 - Heartbeat). */
export const MONITOR_TYPE_HTTP = 1;
/** Status codes as the docs list them: 0 paused, 1 not checked yet, 2 up, 8 seems down, 9 down. */
export const MONITOR_STATUS_TEXT: Record<number, string> = { 0: 'paused', 1: 'not checked yet', 2: 'up', 8: 'seems down', 9: 'down' };
export const monitorStatusText = (code: number): string => MONITOR_STATUS_TEXT[code] ?? `unknown status ${code}`;
/** Log/event codes (`log>type`): 1 down, 2 up, 98 started, 99 paused. */
export const LOG_EVENT_TEXT: Record<number, string> = { 1: 'down', 2: 'up', 98: 'started', 99: 'paused' };

/** One monitor as UptimeRobot reports it. Never a credential. */
export interface UptimeMonitor {
  id: string;
  name: string;
  url: string;
  type: number;
  status: number;
  /** Seconds between checks, when the provider reported one (docs: 300 by default). */
  interval?: number;
  /** The provider's most recent log line for this monitor, when it returned one. */
  lastLog?: { type: number; datetime: number; duration?: number; reason?: string };
}

/** What golive's account read needs: the account the key belongs to, and its monitor budget. */
export interface UptimeAccount {
  email: string;
  monitorLimit?: number;
  /** The minimum interval (seconds) the plan supports; reported, never used to write a monitor. */
  monitorIntervalSeconds?: number;
  up?: number;
  down?: number;
  paused?: number;
}

// ── Parsing ──────────────────────────────────────────────────────────────────────────────────────

function obj(v: unknown, what: string): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new UptimerobotError(`UptimeRobot returned an unexpected ${what}; nothing was inferred.`);
  return v as Record<string, unknown>;
}
function text(v: unknown, what: string): string {
  if (typeof v !== 'string' || !v || v.length > 200 || /[\r\n\x00-\x1f]/.test(v) || isRegisteredSecret(v)) throw new UptimerobotError(`UptimeRobot returned an invalid ${what}.`);
  return v;
}
/** Monitor ids are integers; state may hold either form. */
function numericId(v: unknown, what: string): string {
  const s = typeof v === 'number' ? String(v) : v;
  if (typeof s !== 'string' || !/^[0-9]{1,20}$/.test(s)) throw new UptimerobotError(`UptimeRobot returned an invalid ${what} id.`);
  return s;
}
function integer(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isInteger(v)) return v;
  if (typeof v === 'string' && /^[0-9]{1,6}$/.test(v)) return Number(v);
  return undefined;
}
/** A monitor's URL/IP as the docs call it. golive only ever watches http(s). */
function urlText(v: unknown): string {
  const s = typeof v === 'string' ? v : '';
  if (!s || s.length > 2048 || /[\r\n\x00-\x1f]/.test(s) || isRegisteredSecret(s)) throw new UptimerobotError('UptimeRobot returned an invalid monitor URL.');
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw new UptimerobotError('UptimeRobot returned an invalid monitor URL.');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new UptimerobotError('The UptimeRobot monitor is not an HTTP(S) URL; golive only manages HTTP(S) monitors.');
  return s;
}
/** `log>reason` is a text in the docs' field table and an object with `detail` in some responses. */
function reasonText(v: unknown): string | undefined {
  const raw = typeof v === 'string' ? v : v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>).detail : undefined;
  return typeof raw === 'string' && raw && raw.length <= 300 && !/[\r\n\x00-\x1f]/.test(raw) && !isRegisteredSecret(raw) ? raw : undefined;
}

function monitorsOf(json: unknown, what: string): Record<string, unknown>[] {
  const list = obj(json, what).monitors;
  if (!Array.isArray(list)) throw new UptimerobotError(`UptimeRobot returned an unexpected ${what} list; nothing was inferred.`);
  return list.map((m) => obj(m, 'monitor'));
}

function monitorOf(v: unknown): UptimeMonitor {
  const m = obj(v, 'monitor');
  const type = integer(m.type);
  const status = integer(m.status);
  if (type === undefined) throw new UptimerobotError('UptimeRobot returned a monitor without a type; nothing was inferred.');
  if (status === undefined) throw new UptimerobotError('UptimeRobot returned a monitor without a status; nothing was inferred.');
  const interval = integer(m.interval);
  const logs = Array.isArray(m.logs) ? m.logs : [];
  const first = logs.length ? obj(logs[0], 'monitor log') : undefined;
  const logType = first ? integer(first.type) : undefined;
  const logAt = first ? integer(first.datetime) : undefined;
  const logFor = first ? integer(first.duration) : undefined;
  const reason = first ? reasonText(first.reason) : undefined;
  return {
    id: numericId(m.id, 'monitor'),
    name: text(m.friendly_name, 'monitor name'),
    url: urlText(m.url),
    type,
    status,
    ...(interval !== undefined ? { interval } : {}),
    ...(logType !== undefined && logAt !== undefined
      ? { lastLog: { type: logType, datetime: logAt, ...(logFor !== undefined ? { duration: logFor } : {}), ...(reason ? { reason } : {}) } }
      : {}),
  };
}

function accountOf(json: unknown): UptimeAccount {
  const a = obj(obj(json, 'account answer').account, 'account');
  const email = text(a.email, 'account email');
  const limit = integer(a.monitor_limit);
  const interval = integer(a.monitor_interval);
  const up = integer(a.up_monitors);
  const down = integer(a.down_monitors);
  // The docs' field table spells this `pause_monitors` while both response examples spell it
  // `paused_monitors`; either is accepted, and a missing count leaves the budget pre-check out.
  const paused = integer(a.paused_monitors) ?? integer(a.pause_monitors);
  return {
    email,
    ...(limit !== undefined ? { monitorLimit: limit } : {}),
    ...(interval !== undefined ? { monitorIntervalSeconds: interval } : {}),
    ...(up !== undefined ? { up } : {}),
    ...(down !== undefined ? { down } : {}),
    ...(paused !== undefined ? { paused } : {}),
  };
}

// ── Reads ────────────────────────────────────────────────────────────────────────────────────────

async function accountDetails(ctx: Ctx): Promise<UptimeAccount> {
  return accountOf(await uptimerobotCall(ctx, { method: 'getAccountDetails', what: 'read the account', idempotent: true }));
}

/** The API's documented page size (default and maximum are both 50). */
const PAGE_LIMIT = 50;
/** A bound, not a policy: 20 pages is 1000 monitors, far beyond what choosing one should read. */
const MAX_PAGES = 20;

/** Every monitor in the account, paginated by the documented offset/limit/total. */
async function listMonitors(ctx: Ctx): Promise<UptimeMonitor[]> {
  const out: UptimeMonitor[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const json = await uptimerobotCall(ctx, {
      method: 'getMonitors',
      form: { offset: out.length, limit: PAGE_LIMIT },
      what: 'list monitors',
      idempotent: true,
    });
    const rows = monitorsOf(json, 'monitor').map(monitorOf);
    out.push(...rows);
    const pagination = obj(json, 'answer').pagination;
    const total = pagination && typeof pagination === 'object' && !Array.isArray(pagination) ? integer((pagination as Record<string, unknown>).total) : undefined;
    if (rows.length < PAGE_LIMIT || (total !== undefined && out.length >= total)) break;
    if (page === MAX_PAGES - 1) ctx.log.info(`uptimerobot: read the first ${out.length} monitors only; an account this large needs projects.monitoring to name the monitor`);
  }
  return out;
}

/** One exact monitor by id, with its latest log line; null when the provider no longer has it. */
async function exactMonitor(ctx: Ctx, idValue: string): Promise<UptimeMonitor | null> {
  const id = numericId(idValue, 'monitor');
  const rows = monitorsOf(
    await uptimerobotCall(ctx, { method: 'getMonitors', form: { monitors: id, logs: 1, logs_limit: 1 }, what: `read monitor ${id}`, idempotent: true }),
    'monitor',
  ).map(monitorOf);
  if (!rows.length) return null;
  const match = rows.filter((m) => m.id === id);
  if (!match.length) throw new UptimerobotError(`UptimeRobot answered a monitor read for ${id} with a different monitor; nothing was inferred.`);
  return match[0]!;
}

const refOf = (m: UptimeMonitor): ProjectRef => ({ id: m.id, name: m.name });

/** Canonical form for comparing watched URLs: scheme, host (lowercased), path without a trailing slash. */
function canonicalUrl(raw: string): string | null {
  try {
    const u = new URL(raw);
    return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}${u.search}`;
  } catch {
    return null;
  }
}
/** Whether two URLs point at the same thing as far as a monitor is concerned. */
export function sameWatchedUrl(a: string, b: string): boolean {
  const ca = canonicalUrl(a);
  const cb = canonicalUrl(b);
  return ca !== null && ca === cb;
}

async function resolve(ctx: Ctx, selected: string): Promise<ProjectRef> {
  // A numeric selection is a monitor id: read it through the documented `monitors` filter (one
  // monitor, not the whole account). Anything else is a friendly name, matched exactly.
  if (/^[0-9]{1,20}$/.test(selected)) {
    const exact = await exactMonitor(ctx, selected);
    if (exact) return refOf(exact);
  } else {
    const matches = (await listMonitors(ctx)).filter((m) => m.name.toLowerCase() === selected.toLowerCase());
    if (matches.length > 1) {
      throw new UptimerobotError(
        `UptimeRobot has ${matches.length} monitors matching "${selected}" in this account; set projects.monitoring to one exact monitor id or friendly name (an ambiguous or missing selection is never guessed).`,
      );
    }
    if (matches.length === 1) return refOf(matches[0]!);
  }
  throw new UptimerobotError(`UptimeRobot has no monitor matching "${selected}" in this account; set projects.monitoring to one exact monitor id or friendly name (an ambiguous or missing selection is never guessed).`);
}

async function current(ctx: Ctx): Promise<ProjectRef | null> {
  const chosen = ctx.config.projects?.monitoring ?? ctx.state.resource(MONITOR_ID_KEY);
  return chosen ? resolve(ctx, chosen) : null;
}

async function candidates(ctx: Ctx): Promise<ProjectRef[]> {
  return (await listMonitors(ctx)).map(refOf);
}

// ── Writes (only ever called from an approved step) ──────────────────────────────────────────────

function remember(ctx: Ctx, m: UptimeMonitor, opts: { created?: boolean } = {}): void {
  ctx.state.save((s) => {
    s.resources[MONITOR_ID_KEY] = m.id;
    s.resources[MONITOR_NAME_KEY] = m.name;
    // The creation marker never survives a switch to another monitor: teardown reads it as proof
    // that THIS id is golive's to delete.
    if (opts.created) s.resources[CREATED_MONITOR_KEY] = m.id;
    else if (s.resources[CREATED_MONITOR_KEY] !== m.id) delete s.resources[CREATED_MONITOR_KEY];
  });
}

/**
 * Create the HTTP(s) monitor for the URL the approved plan names. The account's own budget is read
 * first (refusing with the documented reuse/delete/upgrade outcome beats an opaque provider error),
 * an existing monitor on the same URL is never duplicated, and the provider's read of the created
 * monitor is what confirms the name, type and URL before anything is recorded.
 */
async function createMonitor(ctx: Ctx, spec: { name: string; url: string }): Promise<UptimeMonitor> {
  if (!spec.name || spec.name.length > 200 || /[\r\n\x00-\x1f]/.test(spec.name)) throw new UptimerobotError('Invalid UptimeRobot monitor name.');
  const url = urlText(spec.url);
  const account = await accountDetails(ctx);
  const used = (account.up ?? 0) + (account.down ?? 0) + (account.paused ?? 0);
  if (account.monitorLimit !== undefined && account.up !== undefined && account.down !== undefined && account.paused !== undefined && used >= account.monitorLimit) {
    throw new UptimerobotError(
      `The UptimeRobot account already has ${used} of its ${account.monitorLimit} monitors, so nothing was created. Reuse the monitor that already watches this URL (set projects.monitoring to its id or name and re-run \`golive plan\`), delete one you no longer need (a golive-created one goes with \`golive teardown\`), or upgrade the plan yourself — golive never changes a plan or spends money.`,
    );
  }
  const existing = (await listMonitors(ctx)).find((m) => sameWatchedUrl(m.url, url));
  if (existing) {
    throw new UptimerobotError(`A UptimeRobot monitor already watches ${url}: ${existing.name} (${existing.id}). Re-plan and approve adopting it; no duplicate was created.`);
  }
  const made = affectedMonitorId(
    await uptimerobotCall(ctx, { method: 'newMonitor', form: { friendly_name: spec.name, url, type: MONITOR_TYPE_HTTP }, what: `create the monitor ${spec.name}` }),
  );
  const confirmed = await exactMonitor(ctx, made);
  if (!confirmed) throw new UptimerobotError('UptimeRobot did not return the monitor it just created; inspect the account and re-plan. Nothing was linked.');
  if (confirmed.name !== spec.name || !sameWatchedUrl(confirmed.url, url) || confirmed.type !== MONITOR_TYPE_HTTP) {
    throw new UptimerobotError('The created UptimeRobot monitor does not match what was approved (its name, URL or type differs); inspect it and re-plan before linking anything.');
  }
  remember(ctx, confirmed, { created: true });
  ctx.log.info(`created UptimeRobot monitor ${confirmed.name} (${confirmed.id}) for ${confirmed.url}`);
  return confirmed;
}

async function remove(ctx: Ctx): Promise<{ removed: boolean; reason?: string }> {
  const id = ctx.state.resource(MONITOR_ID_KEY);
  if (!id) return { removed: false, reason: 'no UptimeRobot monitor is linked in state' };
  if (ctx.state.resource(CREATED_MONITOR_KEY) !== id) return { removed: false, reason: 'the UptimeRobot monitor was adopted or selected, not created by golive' };
  try {
    await uptimerobotCall(ctx, { method: 'deleteMonitor', form: { id }, what: `delete monitor ${id}` });
  } catch (e) {
    // Already gone is the outcome teardown asked for; the provider's own read below is what confirms
    // that, so only an unambiguous not-found answer is swallowed here.
    if (!(e instanceof UptimerobotApiError) || !/not found|no such|does not exist/i.test(e.message)) throw e;
  }
  const state = await monitorState(ctx, id);
  if (state === 'present') return { removed: false, reason: 'UptimeRobot still reports the monitor' };
  ctx.state.save((s) => {
    delete s.resources[MONITOR_ID_KEY];
    delete s.resources[MONITOR_NAME_KEY];
    delete s.resources[CREATED_MONITOR_KEY];
  });
  ctx.log.info(`uptimerobot: deleted monitor ${id}`);
  return { removed: true };
}

/** `present` | `gone` for a caller confirming a removal: UptimeRobot deletes a monitor at once. */
async function monitorState(ctx: Ctx, id: string): Promise<'present' | 'gone'> {
  return (await exactMonitor(ctx, id)) ? 'present' : 'gone';
}

// ── The monitor-facing surface (non-contract extension) ──────────────────────────────────────────

export interface UptimeProvider {
  /** Every monitor in the account (paginated), for choosing one to adopt. */
  list(ctx: Ctx): Promise<UptimeMonitor[]>;
  /** One exact monitor by id, as UptimeRobot reports it; null when the provider no longer has it. */
  monitor(ctx: Ctx, monitorId: string): Promise<UptimeMonitor | null>;
  /**
   * Create an HTTP(s) monitor for `url` (a WRITE, only ever called from an approved step). Omitted by
   * a provider that cannot create monitors; the link then hands the task over instead.
   */
  createMonitor?(ctx: Ctx, spec: { name: string; url: string }): Promise<UptimeMonitor>;
  /** `present` | `gone` for a teardown confirmation: UptimeRobot deletes a monitor at once. */
  monitorState(ctx: Ctx, monitorId: string): Promise<'present' | 'gone'>;
}

/** The monitor surface of `adapter`, when it exposes one. */
export function uptimeOf(adapter: Adapter): UptimeProvider | undefined {
  return (adapter.capabilities as { uptime?: UptimeProvider }).uptime;
}

const uptime: UptimeProvider = {
  list: listMonitors,
  monitor: (ctx, monitorId) => exactMonitor(ctx, monitorId),
  createMonitor,
  monitorState,
};

/** The ProjectLinker surface, plus the monitor extension in one object literal. */
const project: ProjectLinker = {
  current,
  candidates,
  resolve,
  select: async (ctx, idOrName) => {
    const ref = await resolve(ctx, idOrName);
    const m = await exactMonitor(ctx, ref.id);
    if (!m) throw new UptimerobotError(`UptimeRobot no longer has monitor ${ref.id}; re-plan.`);
    remember(ctx, m);
    return refOf(m);
  },
  remove,
};

async function auth(ctx: Ctx): Promise<AuthStatus> {
  if (!ctx.envToken(UPTIMEROBOT_TOKEN)) return { ok: false, howToFix: uptimerobotHelp() };
  try {
    const account = await accountDetails(ctx);
    const used = (account.up ?? 0) + (account.down ?? 0) + (account.paused ?? 0);
    const budget = account.monitorLimit !== undefined ? `${used}/${account.monitorLimit} monitors` : 'monitor count not reported';
    return { ok: true, via: `${UPTIMEROBOT_TOKEN} env (${account.email}, ${budget})` };
  } catch (e) {
    const msg = errMsg(e);
    return { ok: false, howToFix: /api[_-]?key|invalid[_ ]?parameter|missing[_ ]?parameter|getMonitors/i.test(msg) ? `${msg} ${UPTIMEROBOT_KEY_TYPES}` : msg };
  }
}

export const uptimerobotAdapter: Adapter = {
  id: 'uptimerobot',
  title: 'UptimeRobot',
  axes: ['monitoring'],
  automated: true,
  auth,
  capabilities: { project, uptime } as Adapter['capabilities'],
};
