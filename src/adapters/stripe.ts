/**
 * Stripe payments adapter: account readiness, semantic outputs (keys), and the webhook registry.
 *
 * Transport is REST (form bodies) with a key from the human's environment. Stripe reveals a webhook
 * signing secret ONLY in the create response, so it is wrapped in a Secret immediately and returned
 * to the caller (the link pipes it straight into the host env). Nothing after a successful create
 * may throw, or that secret would be lost.
 */
import { createHash, randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import { modeFor } from '../core/config.js';
import { Secret } from '../core/secret.js';
import { tokenHowTo } from '../core/credentials.js';
import type { Adapter, AuthStatus, Ctx, EnvTarget, Mode, OutputKey, Outputs, PaymentAccount, PaymentAccountIdentity, WebhookEnsureResult, WebhookRegistry } from '../core/types.js';
import { APP_KEY_ENV, MODE_KEY_ENV, SHARED_KEY_ENV, isRestrictedKey, keyHowToFix, lookupAppKey, lookupKey, stripeCall, stripeKeyFor, stripeRaw, RESTRICTED_KEY_PERMS } from './stripe-api.js';

export { stripeKeyFor } from './stripe-api.js';

/** Stripe's cap on webhook endpoints per mode (or sandbox). */
export const MAX_ENDPOINTS_PER_MODE = 16;

// ── Modes / auth ────────────────────────────────────────────────────────────────────────────────

function modesInUse(ctx: Ctx): Mode[] {
  const modes = new Set<Mode>(ctx.config.targets.map((t) => modeFor(ctx.config, t)));
  if (modes.size === 0) modes.add('test');
  return (['test', 'live'] as const).filter((m) => modes.has(m));
}

function targetMode(ctx: Ctx, target: EnvTarget): Mode {
  return target === 'development' ? 'test' : modeFor(ctx.config, target);
}

interface RawAccount {
  id?: string;
  charges_enabled?: boolean;
  details_submitted?: boolean;
  requirements?: { currently_due?: string[]; disabled_reason?: string | null };
  settings?: { dashboard?: { display_name?: string } };
}

export interface StripeAccountStatus {
  accountId?: string;
  chargesEnabled: boolean;
  detailsSubmitted: boolean;
  /** The human's outstanding KYC tasks (Stripe requirement names). */
  currentlyDue: string[];
  disabledReason?: string;
}

/** GET /v1/account for the given mode — for the live-readiness check. */
export async function stripeAccountStatus(ctx: Ctx, mode: Mode): Promise<StripeAccountStatus> {
  const res = await stripeCall<RawAccount>(ctx, mode, { path: '/v1/account', what: `read Stripe ${mode}-mode account` });
  const a = res.json ?? {};
  const out: StripeAccountStatus = {
    chargesEnabled: a.charges_enabled === true,
    detailsSubmitted: a.details_submitted === true,
    currentlyDue: a.requirements?.currently_due ?? [],
  };
  if (a.id) out.accountId = a.id;
  if (a.requirements?.disabled_reason) out.disabledReason = a.requirements.disabled_reason;
  return out;
}

const validAccountId = (id: unknown): id is string => typeof id === 'string' && /^acct_[A-Za-z0-9]+$/.test(id);
const operatorFingerprint = (key: Secret): string => createHash('sha256').update(key.reveal()).digest('hex');

/** Capture only this mode's inputs; other providers still use their normal credential source. */
function pinnedCredentials<T extends Ctx>(ctx: T, mode: Mode): T {
  const names = [MODE_KEY_ENV[mode], SHARED_KEY_ENV, APP_KEY_ENV[mode]];
  const captured = new Map(names.map((name) => [name, ctx.envToken(name)]));
  return { ...ctx, envToken: (name) => captured.has(name) ? captured.get(name) : ctx.envToken(name) };
}

async function paymentIdentity(ctx: Ctx, mode: Mode): Promise<PaymentAccountIdentity> {
  const key = stripeKeyFor(ctx, mode);
  if (!key) throw new Error(`Stripe ${mode} account cannot be established without a valid operator key. ${keyHowToFix([mode])}`);
  const result = await stripeCall<RawAccount>(ctx, mode, { path: '/v1/account', what: `verify Stripe ${mode}-mode approval account` });
  if (!validAccountId(result.json?.id)) throw new Error(`Stripe ${mode}-mode response did not establish a valid account ID; no payment writes are allowed. Check Account: Read permission and run plan again.`);
  return { accountId: result.json.id, mode, operatorFingerprint: operatorFingerprint(key) };
}

const paymentAccount: PaymentAccount = {
  identify: (ctx, mode) => paymentIdentity(pinnedCredentials(ctx, mode), mode),
  async bind(ctx, approved, options) {
    const bound = pinnedCredentials(ctx, approved.mode);
    const current = await paymentIdentity(bound, approved.mode);
    if (current.accountId !== approved.accountId || current.operatorFingerprint !== approved.operatorFingerprint) {
      throw new Error(`Stripe ${approved.mode}-mode account or operator key changed since approval; nothing was written. Run plan again and approve the exact account.`);
    }
    if (options?.appKey) {
      const app = lookupAppKey(bound, approved.mode).key;
      if (!app) throw new Error(`The approved Stripe ${approved.mode}-mode app key is unavailable; no env write was performed. Run plan again.`);
      if (operatorFingerprint(app) !== current.operatorFingerprint) {
        const appContext: Ctx = { ...bound, envToken: (name) => name === MODE_KEY_ENV[approved.mode] ? app : bound.envToken(name) };
        const appIdentity = await paymentIdentity(appContext, approved.mode);
        if (appIdentity.accountId !== approved.accountId) throw new Error(`The Stripe ${approved.mode}-mode app key belongs to another account; no env write was performed. Use an app key from the approved account and run plan again.`);
      }
    }
    return bound;
  },
};

/** Only to enrich the not-logged-in message; the CLI's credentials aren't used for writes. */
async function cliHint(ctx: Ctx): Promise<string> {
  try {
    const r = await ctx.exec('stripe', ['whoami', '--format', 'json'], { timeoutMs: 15_000 });
    if (r.code !== 0) return '';
    const w = JSON.parse(r.stdout) as { authenticated?: boolean; account_id?: string; display_name?: string };
    if (!w.authenticated) return '';
    const who = [w.display_name, w.account_id].filter((x) => typeof x === 'string' && x).join(', ');
    return ` (The Stripe CLI is logged in${who ? ` as ${who}` : ''}, but its credentials are short-lived and may lack live-mode write access, so golive needs its own key as described above.)`;
  } catch {
    return '';
  }
}

async function auth(ctx: Ctx): Promise<AuthStatus> {
  const modes = modesInUse(ctx);
  const missing: Mode[] = [];
  const problems: string[] = [];
  for (const m of modes) {
    const k = lookupKey(ctx, m);
    if (!k.key) missing.push(m);
    if (k.problem) problems.push(k.problem);
  }
  if (missing.length) {
    const prefix = problems.length ? `${problems.join('; ')}. ` : '';
    return { ok: false, howToFix: prefix + keyHowToFix(missing) + (await cliHint(ctx)) };
  }

  const via: string[] = [];
  for (const m of modes) {
    const res = await stripeRaw<RawAccount>(ctx, m, { path: '/v1/account', what: `read Stripe ${m}-mode account` });
    const source = res.keySource;
    const key = stripeKeyFor(ctx, m);
    const restricted = Boolean(key && isRestrictedKey(key));
    if (res.status === 401) {
      return { ok: false, howToFix: `Stripe rejected the ${m}-mode key in ${source} (invalid, expired or revoked). ${keyHowToFix([m])}` };
    }
    if (res.status === 403) {
      if (restricted) {
        return {
          ok: false,
          howToFix: `The ${m}-mode restricted key in ${source} cannot read its account. Account: Read is required to bind payment writes to the account the human approves; webhook access alone is insufficient. In Dashboard → Developers → API keys, grant it ${RESTRICTED_KEY_PERMS}, or use the standard secret key instead. ${tokenHowTo(source)}`,
        };
      }
      return { ok: false, howToFix: `Stripe refused the ${m}-mode key in ${source} (HTTP 403 reading the account). Check in Dashboard → Developers → API keys that it is a current key for an active account. ${tokenHowTo(source)}` };
    }
    if (res.status !== 200) {
      return { ok: false, howToFix: `Could not reach Stripe with the ${m}-mode key in ${source} (HTTP ${res.status}). Check your network and https://status.stripe.com, then re-run.` };
    }
    if (!validAccountId(res.json?.id)) return { ok: false, howToFix: `Stripe returned no valid ${m}-mode account ID. Account identity must be established before payment writes; check Account: Read permission and retry doctor.` };
    const name = res.json?.settings?.dashboard?.display_name;
    const acct = [res.json?.id, name ? `"${name}"` : ''].filter(Boolean).join(' ');
    via.push(`${source} (${m}${acct ? `, ${acct}` : ''}${restricted ? ', restricted key' : ''}${appKeyNote(ctx, m, restricted)})`);
  }
  return { ok: true, via: via.join('; ') };
}

/** Secret-free note on which key the app will get (only when it isn't simply the operator key). */
function appKeyNote(ctx: Ctx, mode: Mode, restricted: boolean): string {
  const app = lookupAppKey(ctx, mode);
  if (app.key && app.source === APP_KEY_ENV[mode]) return `; app key from ${app.source}`;
  if (app.problem && !app.restrictedOperator) return `; app key unusable: ${app.problem}`;
  if (restricted) return `; not given to the app — set ${APP_KEY_ENV[mode]} for that`;
  return '';
}

// ── Outputs ─────────────────────────────────────────────────────────────────────────────────────

async function outputs(ctx: Ctx, target: EnvTarget): Promise<Outputs> {
  const mode = targetMode(ctx, target);
  const out: Outputs = {};
  // Never the restricted operator key: it lacks the app's permissions (see lookupAppKey).
  const k = lookupAppKey(ctx, mode);
  if (k.key) out['stripe.secretKey'] = k.key;
  else if (k.problem) ctx.log.warn(`${k.problem}; no Stripe ${mode}-mode secret key for the app (${target}).`);
  const pk = ctx.config.payments?.publishableKeys?.[mode];
  if (pk) out['stripe.publishableKey'] = pk;
  return out;
}

/** Which outputs exist for `target`, without revealing or logging anything (keeps plan() quiet). */
async function provides(ctx: Ctx, target: EnvTarget): Promise<OutputKey[]> {
  const mode = targetMode(ctx, target);
  const keys: OutputKey[] = [];
  if (lookupAppKey(ctx, mode).key) keys.push('stripe.secretKey');
  if (ctx.config.payments?.publishableKeys?.[mode]) keys.push('stripe.publishableKey');
  return keys;
}

// ── Webhooks ────────────────────────────────────────────────────────────────────────────────────

interface RawEndpoint {
  id: string;
  url: string;
  enabled_events?: string[];
  status?: string;
  metadata?: Record<string, string>;
  /** Present ONLY in the create response. Never copied into an Endpoint. */
  secret?: string;
}

interface Endpoint {
  id: string;
  url: string;
  events: string[];
  enabled: boolean;
  metadata: Record<string, string>;
}

function pick(raw: RawEndpoint): Endpoint {
  return { id: raw.id, url: raw.url, events: raw.enabled_events ?? [], enabled: raw.status === 'enabled', metadata: raw.metadata ?? {} };
}

function appName(ctx: Ctx): string {
  return basename(ctx.cwd) || 'app';
}

function isGolive(e: Endpoint): boolean {
  return e.metadata.managed_by === 'golive';
}

/** Created by golive for THIS app (endpoints tagged for another app on the same account are not ours). */
function ownedByUs(ctx: Ctx, e: Endpoint): boolean {
  return isGolive(e) && (!e.metadata.golive_app || e.metadata.golive_app === appName(ctx));
}

function normUrl(u: string): string {
  try {
    return new URL(u).href;
  } catch {
    return u;
  }
}

/** Untagged endpoint we still consider this app's: remembered in state, or configured path on our domain. */
function managedUrl(ctx: Ctx, e: Endpoint, mode: Mode): boolean {
  if (ctx.state.resource(`stripe.${mode}.webhookEndpointId`) === e.id) return true;
  const path = ctx.config.payments?.webhook?.path;
  const domain = ctx.config.domain?.toLowerCase();
  if (!path || !domain) return false;
  try {
    const u = new URL(e.url);
    const host = u.hostname.toLowerCase();
    return u.pathname.replace(/\/+$/, '') === path.replace(/\/+$/, '') && (host === domain || host.endsWith(`.${domain}`));
  } catch {
    return false;
  }
}

async function listAll(ctx: Ctx, mode: Mode): Promise<Endpoint[]> {
  const out: Endpoint[] = [];
  let after: string | undefined;
  for (let page = 0; page < 50; page++) {
    const q = new URLSearchParams({ limit: '100' });
    if (after) q.set('starting_after', after);
    const res = await stripeCall<{ data?: RawEndpoint[]; has_more?: boolean }>(ctx, mode, {
      path: `/v1/webhook_endpoints?${q.toString()}`,
      what: `list Stripe ${mode}-mode webhook endpoints`,
    });
    const data = res.json?.data ?? [];
    out.push(...data.map(pick));
    const last = data[data.length - 1];
    if (!res.json?.has_more || !last) break;
    after = last.id;
  }
  return out;
}

function eventsForm(events: string[]): Record<string, string> {
  // Indexed keys (enabled_events[0]=…) — the form map can't repeat a key, and Stripe accepts both.
  return Object.fromEntries(events.map((e, i) => [`enabled_events[${i}]`, e]));
}

function uniq(xs: string[]): string[] {
  return [...new Set(xs)];
}

function sameSet(a: string[], b: string[]): boolean {
  const sa = new Set(a);
  return sa.size === new Set(b).size && b.every((x) => sa.has(x));
}

function limitError(mode: Mode, all: Endpoint[]): Error {
  const ours = all.filter(isGolive).length;
  return new Error(
    `Stripe allows at most ${MAX_ENDPOINTS_PER_MODE} webhook endpoints per mode and the ${mode}-mode account already has ${all.length}` +
      ` (${ours} created by golive). Delete unused ones in Stripe Dashboard → Developers → Webhooks${ours ? ' (stale golive ones are tagged managed_by=golive)' : ''}, then re-run.`,
  );
}

function validateSpec(spec: { url: string; events: string[] }): void {
  let u: URL;
  try {
    u = new URL(spec.url);
  } catch {
    throw new Error(`Stripe webhook URL "${spec.url}" is not a valid absolute URL`);
  }
  if (u.protocol !== 'https:') throw new Error(`Stripe webhook URL must be https (got ${u.protocol}//${u.host})`);
  if (!spec.events.length) throw new Error('Stripe webhook needs at least one event (payments.webhook.events in golive.yaml)');
}

async function createEndpoint(ctx: Ctx, mode: Mode, url: string, events: string[]): Promise<{ id: string; secret: Secret }> {
  const form = {
    url,
    ...eventsForm(uniq(events)),
    description: `Managed by golive for ${appName(ctx)} (${mode})`,
    'metadata[managed_by]': 'golive',
    'metadata[golive_app]': appName(ctx),
  };
  const what = `create Stripe ${mode}-mode webhook endpoint for ${url}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    // A fresh key per call: dedupes transport retries of THIS request, but never replays a cached
    // response for an endpoint that has since been deleted. Cross-run retries are caught by list-first.
    const idempotencyKey = `golive-${mode}-${randomUUID()}`;
    const res = await stripeCall<RawEndpoint>(ctx, mode, { method: 'POST', path: '/v1/webhook_endpoints', form, idempotencyKey, what });
    const id = res.json?.id;
    const raw = res.json?.secret;
    if (!id) throw new Error(`${what}: Stripe returned no endpoint id; check Dashboard → Developers → Webhooks before re-running`);
    if (typeof raw !== 'string' || !raw) {
      throw new Error(`${what}: endpoint ${id} was created but Stripe returned no signing secret; re-run so golive replaces it`);
    }
    const secret = new Secret('STRIPE_WEBHOOK_SECRET', raw);
    if (res.headers['idempotent-replayed'] === 'true' && attempt === 0 && !(await endpointExists(ctx, mode, id))) continue;
    ctx.log.info(`created Stripe ${mode}-mode webhook endpoint ${id} → ${url}`);
    return { id, secret };
  }
  throw new Error(`${what}: Stripe kept replaying a deleted endpoint; wait a minute and re-run`);
}

/** Best effort; true unless Stripe positively says 404 (never throws: a secret may be in flight). */
async function endpointExists(ctx: Ctx, mode: Mode, id: string): Promise<boolean> {
  try {
    const r = await stripeRaw(ctx, mode, { path: `/v1/webhook_endpoints/${encodeURIComponent(id)}`, what: `read Stripe webhook endpoint ${id}` });
    return r.status !== 404;
  } catch {
    return true;
  }
}

/** THE matching rule shared by ensure() and find(): owned by this app → any golive-tagged → any same-URL. */
function selectMatch(ctx: Ctx, all: Endpoint[], url: string): Endpoint | undefined {
  const target = normUrl(url);
  const same = all.filter((e) => normUrl(e.url) === target);
  return same.find((e) => ownedByUs(ctx, e)) ?? same.find(isGolive) ?? same[0];
}

async function ensure(ctx: Ctx, spec: { url: string; events: string[]; mode: Mode }): Promise<WebhookEnsureResult> {
  validateSpec(spec);
  const { mode } = spec;
  const all = await listAll(ctx, mode);
  const match = selectMatch(ctx, all, spec.url);
  if (!match) {
    if (all.length >= MAX_ENDPOINTS_PER_MODE) throw limitError(mode, all);
    const c = await createEndpoint(ctx, mode, spec.url, spec.events);
    return { id: c.id, created: true, secret: c.secret };
  }

  const owned = isGolive(match);
  const wanted = uniq(spec.events);
  // Never drop events from an endpoint someone else set up; only add what the app needs.
  const covers = (e: string): boolean => match.events.includes('*') || match.events.includes(e);
  const events = owned ? wanted : uniq([...match.events, ...wanted]);
  const eventsDrift = owned ? !sameSet(match.events, wanted) : !wanted.every(covers);
  if (eventsDrift || !match.enabled) {
    const form: Record<string, string> = eventsDrift ? eventsForm(events) : {};
    if (!match.enabled) form.disabled = 'false';
    // Sets fixed values, so a re-send after a timeout is harmless.
    await stripeCall(ctx, mode, { method: 'POST', path: `/v1/webhook_endpoints/${encodeURIComponent(match.id)}`, form, idempotent: true, what: `update Stripe ${mode}-mode webhook endpoint ${match.id}` });
    ctx.log.info(`updated Stripe ${mode}-mode webhook endpoint ${match.id}${eventsDrift ? ` (events: ${events.join(', ')})` : ''}${match.enabled ? '' : ' (re-enabled)'}`);
  }
  if (!owned) ctx.log.info(`adopted existing Stripe ${mode}-mode webhook endpoint ${match.id} (not created by golive; golive will never delete it)`);
  return { id: match.id, created: false };
}

/** `owned` = created by golive for THIS app, i.e. what replace() would delete. */
async function list(ctx: Ctx, mode: Mode): Promise<Array<{ id: string; url: string; events: string[]; enabled: boolean; owned: boolean }>> {
  const all = await listAll(ctx, mode);
  return all.filter((e) => ownedByUs(ctx, e) || managedUrl(ctx, e, mode)).map((e) => ({ id: e.id, url: e.url, events: e.events, enabled: e.enabled, owned: ownedByUs(ctx, e) }));
}

/** Read-only: the endpoint ensure() would adopt for `url` (same rule), so plan previews match apply. */
async function find(ctx: Ctx, url: string, mode: Mode): Promise<{ id: string; url: string; events: string[]; enabled: boolean; owned: boolean } | null> {
  const m = selectMatch(ctx, await listAll(ctx, mode), url);
  return m ? { id: m.id, url: m.url, events: m.events, enabled: m.enabled, owned: ownedByUs(ctx, m) } : null;
}

async function replace(ctx: Ctx, id: string, mode: Mode, opts: { deleteOld?: boolean } = {}): Promise<WebhookEnsureResult & { oldDeleted: boolean; oldLeft?: string }> {
  const res = await stripeCall<RawEndpoint>(ctx, mode, { path: `/v1/webhook_endpoints/${encodeURIComponent(id)}`, what: `read Stripe ${mode}-mode webhook endpoint ${id}` });
  if (!res.json?.id) throw new Error(`read Stripe ${mode}-mode webhook endpoint ${id}: unexpected empty response`);
  const old = pick(res.json);
  const all = await listAll(ctx, mode);
  if (all.length >= MAX_ENDPOINTS_PER_MODE) throw limitError(mode, all);

  const created = await createEndpoint(ctx, mode, old.url, old.events.length ? old.events : ['*']);
  // From here on, never throw: the new signing secret must reach the caller.
  let oldDeleted = false;
  let oldLeft: string | undefined;
  if (opts.deleteOld === false) {
    oldLeft = 'kept until the new signing secret is stored';
  } else if (ownedByUs(ctx, old)) {
    try {
      await stripeCall(ctx, mode, { method: 'DELETE', path: `/v1/webhook_endpoints/${encodeURIComponent(old.id)}`, what: `delete Stripe ${mode}-mode webhook endpoint ${old.id}` });
      ctx.log.info(`deleted old golive-managed Stripe ${mode}-mode webhook endpoint ${old.id}`);
      oldDeleted = true;
    } catch (e) {
      oldLeft = `delete failed: ${e instanceof Error ? e.message : String(e)}`;
      ctx.log.warn(`could not delete old Stripe webhook endpoint ${old.id} (${e instanceof Error ? e.message : String(e)}); delete it in Dashboard → Developers → Webhooks.`);
    }
  } else {
    oldLeft = 'not created by golive';
    ctx.log.warn(
      `left Stripe ${mode}-mode webhook endpoint ${old.id} in place because golive did not create it; once the new endpoint ${created.id} works, delete ${old.id} in Dashboard → Developers → Webhooks (until then Stripe delivers events to both).`,
    );
  }
  return { id: created.id, created: true, secret: created.secret, oldDeleted, ...(oldLeft ? { oldLeft } : {}) };
}

/** Delete an endpoint only if golive owns it (see WebhookRegistry.remove). Never throws. */
async function remove(ctx: Ctx, id: string, mode: Mode): Promise<{ deleted: boolean; reason?: string }> {
  try {
    const res = await stripeCall<RawEndpoint>(ctx, mode, { path: `/v1/webhook_endpoints/${encodeURIComponent(id)}`, what: `read Stripe ${mode}-mode webhook endpoint ${id}` });
    if (!res.json?.id) return { deleted: false, reason: 'endpoint not found' };
    if (!ownedByUs(ctx, pick(res.json))) return { deleted: false, reason: 'not created by golive' };
    await stripeCall(ctx, mode, { method: 'DELETE', path: `/v1/webhook_endpoints/${encodeURIComponent(id)}`, what: `delete Stripe ${mode}-mode webhook endpoint ${id}` });
    return { deleted: true };
  } catch (e) {
    return { deleted: false, reason: `delete failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}

const webhooks: WebhookRegistry = { ensure, list, replace, find, remove };

export const stripeAdapter: Adapter = {
  id: 'stripe',
  title: 'Stripe',
  axes: ['payments'],
  automated: true,
  detect: (d) => d.providers.payments?.includes('stripe') ?? false,
  auth,
  capabilities: { outputs: { outputs, provides }, webhooks, paymentAccount },
};

export { APP_KEY_ENV, MODE_KEY_ENV };
