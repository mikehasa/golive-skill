/**
 * Inventory: what golive can prove it created, from state plus provider reads.
 *
 * `teardown` turns this into deletion steps and the handover document reports it, so an entry exists
 * only when golive can point at the proof it made the resource — the DNS provider's own
 * golive-owned record list, the endpoint or key id recorded in state, or the host project's creation
 * marker. A database project or sending domain that state records without a creation marker is
 * inventoried too, but explicitly as NOT proven golive's (`created: false`), so no consumer can turn
 * an adopted resource into a deletion. Nothing here writes, and no timestamp enters a plan, so
 * re-reading the same account yields the same inventory.
 *
 * A resource recorded in state that golive cannot remove right now (the provider is not signed in,
 * another provider is configured, or it has no removal capability) is inventoried without a removal
 * handle: a consumer hands it back to the human instead of silently dropping it. The same rule covers
 * an axis golive cannot read at all — a DNS zone whose provider is unusable, cannot tell golive-owned
 * records apart or cannot delete one, and a host project golive cannot remove now — as an
 * `InventoryGap` naming what remains, why golive cannot remove it and the exact fix. An inventory
 * that could not be verified is reported, never silently dropped.
 */
import type { Adapter, Axis, Ctx, DnsRecord, DnsZone, EnvTarget, KeyIssuer, Mode, WebhookRegistry } from './types.js';
import { readDnsBaselines, type DnsBaseline } from './dns-baseline.js';
import { formatRecord } from '../links/email.js';
import { axisStatus, type AxisStatus } from '../links/util.js';

/** Payment modes golive can hold an endpoint for; state keys are `<adapterId>.<mode>.webhookEndpointId`. */
const MODES: readonly Mode[] = ['test', 'live'];
const ENV_TARGETS: readonly EnvTarget[] = ['development', 'preview', 'production'];

/** A provider's project-deletion capability (see ProjectLinker.remove). */
export type ProjectRemove = (ctx: Ctx) => Promise<{ removed: boolean; reason?: string }>;

/** A provider's "is this project still there?" read (see ProjectLinker.exists). */
export type ProjectExists = (ctx: Ctx) => Promise<boolean>;

/**
 * Where a hosting adapter records the project it resolved. The id key doubles as "a project is
 * linked"; the name key is only used to make the preview readable.
 */
const PROJECT_STATE: Record<string, { id: string; name: string }> = {
  vercel: { id: 'vercel.projectId', name: 'vercel.projectName' },
  netlify: { id: 'netlify.siteId', name: 'netlify.siteName' },
};

/** `<provider>.createdProjectId` marks the project golive itself created — never an adopted one. */
export function createdProjectKey(provider: string): string {
  return `${provider}.createdProjectId`;
}

/** The state keys that record the project golive resolved for `provider`. */
export function projectStateKeys(provider: string): { id: string; name: string } {
  return PROJECT_STATE[provider] ?? { id: `${provider}.projectId`, name: `${provider}.projectName` };
}

// ── Entries ─────────────────────────────────────────────────────────────────────────────────────

/** A webhook endpoint golive registered, recorded in state. */
export interface InventoryWebhook {
  provider: string;
  providerTitle: string;
  /** State key recording the endpoint id. */
  key: string;
  mode: Mode;
  id: string;
  /**
   * Present only when golive can delete the endpoint right now: the adapter, its removal call and the
   * provider's own list, which is what proves the endpoint is gone after the delete.
   */
  removal?: { adapter: Adapter; remove: NonNullable<WebhookRegistry['remove']>; list: WebhookRegistry['list'] };
}

/** A DNS record the DNS provider itself reports as golive-owned. */
export interface InventoryDnsRecord {
  provider: string;
  providerTitle: string;
  /** The zone the record lives in. */
  domain: string;
  record: DnsRecord;
  adapter: Adapter;
  listOwned: NonNullable<DnsZone['listOwned']>;
  remove: NonNullable<DnsZone['remove']>;
}

/**
 * What a recorded sending key serves: an env target's app key, or `smtp` — the key golive sets as the
 * auth project's SMTP password (state key `<provider>.keyId@smtp`).
 */
export type KeySlot = EnvTarget | 'smtp';

/** A sending key golive issued, recorded in state. */
export interface InventorySendingKey {
  provider: string;
  providerTitle: string;
  /** State key recording the key id. */
  key: string;
  target: KeySlot;
  id: string;
  /** Present only when golive can revoke the key right now: the adapter and its capability. */
  revocation?: { adapter: Adapter; revoke: NonNullable<KeyIssuer['revoke']> };
}

/**
 * The host project state links. `created` is false for an adopted/selected project: the provider
 * reports the project, but no creation marker covers it, so golive must not delete it. `remove` is
 * the host's deletion capability, present because a host without one is not inventoried at all.
 */
export interface InventoryProject {
  provider: string;
  providerTitle: string;
  keys: { id: string; name: string };
  id: string;
  name?: string;
  created: boolean;
  remove: ProjectRemove;
  /**
   * Read-only existence probe bound to `id`, present when the host exposes one. Absent means golive
   * cannot re-read the project after a delete — reported as a warning, never as a confirmed deletion.
   */
  exists?: ProjectExists;
}

/**
 * A database project or sending domain recorded in state. `created` is true only when the recorded
 * creation markers prove golive made the resource; `markers` names them, `needs` and `where` say
 * where a human finishes a removal by hand, and `extra` carries the provider's remaining caveat.
 */
export interface InventoryRecorded {
  axis: Axis;
  provider: string;
  providerTitle: string;
  kind: 'database-project' | 'sending-domain';
  key: string;
  id: string;
  name: string;
  created: boolean;
  /** State keys whose recorded value proved (or would have proved) that golive created it. */
  markers: string[];
  needs: string;
  where: string;
  extra?: string;
}

export interface Inventory {
  webhooks: InventoryWebhook[];
  dnsRecords: InventoryDnsRecord[];
  sendingKeys: InventorySendingKey[];
  /** null when nothing is linked or the host cannot be read; a linked host golive cannot remove is in `gaps`. */
  project: InventoryProject | null;
  recorded: InventoryRecorded[];
  /** Every recorded resource this run could not read or remove: a handoff, never a silent gap. */
  gaps: InventoryGap[];
}

/**
 * A recorded resource golive could not read or remove in this run — the provider is not signed in,
 * `golive.yaml` names no (usable) provider or no domain for it, or the adapter lacks the read or the
 * removal the inventory needs. `subject` names what remains from state (the records golive recorded
 * writing, the project id state links), never from a guess, so a consumer can hand the human a row
 * that names the resource, why golive cannot remove it and the exact fix.
 */
export interface InventoryGap {
  /** The handoff row this gap becomes: `teardown:<axis>` (no provider named) or `teardown:<axis>:<provider>`. */
  id: string;
  axis: Axis;
  /** Provider id, or '' when `golive.yaml` names none for the axis. */
  provider: string;
  providerTitle: string;
  /** What remains, in one secret-free phrase. */
  subject: string;
  /** Why golive cannot read or remove it in this run. */
  why: string;
  /** What the human does about it. */
  fix: string;
  /** True when state itself records the resource this gap names (a baseline or a resource id). */
  recorded: boolean;
}

/** Database projects and the sending domain: the state keys golive records when it creates them. */
interface RecordedSpec {
  axis: Axis;
  provider: string;
  providerTitle: string;
  kind: InventoryRecorded['kind'];
  /** State key holding the resource id. */
  idKey: string;
  /** State key holding its name, when the provider records one. */
  nameKey?: string;
  /**
   * State keys that must ALL record the same id for it to prove golive created the resource. An empty
   * list means no such marker exists — the resource is recorded, golive only adopted it — and an empty
   * `every()` is true, so that case is spelled out as "not proven" at the check below.
   */
  createdBy: string[];
  needs: string;
  where: string;
  extra?: string;
}

const RECORDED: RecordedSpec[] = [
  { axis: 'db', provider: 'supabase', providerTitle: 'Supabase', kind: 'database-project', idKey: 'supabase.ref', createdBy: ['supabase.createdByGolive'], needs: 'the Supabase dashboard', where: 'the dashboard' },
  { axis: 'db', provider: 'neon', providerTitle: 'Neon', kind: 'database-project', idKey: 'neon.projectId', nameKey: 'neon.createdProjectName', createdBy: ['neon.createdProjectId'], needs: 'the Neon console', where: 'the Neon console', extra: '; Neon may keep a recovery window' },
  { axis: 'email', provider: 'resend', providerTitle: 'Resend', kind: 'sending-domain', idKey: 'resend.domainId', createdBy: ['resend.createdDomainId'], needs: 'the Resend dashboard', where: 'the Resend dashboard', extra: '; any keys golive issued are revoked in the steps of this plan when applicable' },
];

/**
 * Read the whole inventory: webhooks, DNS records, sending keys, the host project, then the recorded
 * database/sending resources. Read-only, in that fixed order, so the same account always reads the
 * same way. What could not be read or removed is reported in `gaps` instead of being dropped.
 */
export async function buildInventory(ctx: Ctx): Promise<Inventory> {
  const webhooks = await webhookInventory(ctx);
  const dns = await dnsInventory(ctx);
  const sendingKeys = await keyInventory(ctx);
  const host = await projectInventory(ctx);
  return { webhooks, dnsRecords: dns.records, sendingKeys, project: host.project, recorded: recordedInventory(ctx), gaps: [...dns.gaps, ...host.gaps] };
}

/** A provider's display title, from the registered adapters. Never a credential or an account read. */
function titleOf(ctx: Ctx, provider: string): string {
  return ctx.adapters.find((a) => a.id === provider)?.title ?? provider;
}

// ── Webhook endpoints ───────────────────────────────────────────────────────────────────────────

const WEBHOOK_KEY = /^([a-z0-9-]+)\.(test|live)\.webhookEndpointId$/;

async function webhookInventory(ctx: Ctx): Promise<InventoryWebhook[]> {
  const s = await axisStatus(ctx, 'payments');
  const ready = s.kind === 'ready' ? s : null;
  const out: InventoryWebhook[] = [];
  const stateKeys = Object.keys(ctx.state.get().resources).sort();
  // test before live, then provider id: the same resources always produce the same order.
  for (const mode of MODES) {
    for (const stateKey of stateKeys) {
      const m = WEBHOOK_KEY.exec(stateKey);
      if (!m || m[2] !== mode) continue;
      const provider = m[1]!;
      const id = ctx.state.resource(stateKey);
      if (!id) continue;
      const caps = ready && ready.adapter.id === provider ? ready.adapter.capabilities.webhooks : undefined;
      const remove = caps?.remove;
      // A recorded endpoint golive cannot remove right now (signed out, a different provider, or no
      // capability) keeps no removal handle, so teardown hands it back explicitly.
      out.push({ provider, providerTitle: titleOf(ctx, provider), key: stateKey, mode, id, ...(ready && remove && caps ? { removal: { adapter: ready.adapter, remove, list: caps.list } } : {}) });
    }
  }
  return out;
}

// ── DNS records ─────────────────────────────────────────────────────────────────────────────────

async function dnsInventory(ctx: Ctx): Promise<{ records: InventoryDnsRecord[]; gaps: InventoryGap[] }> {
  const baselines = readDnsBaselines(ctx.state.get());
  const { read, foreign } = dnsZones(ctx, baselines);
  const known = [...read, ...foreign.map((f) => f.zone)];
  // Neither configured nor recorded: there is no zone golive could even name, so there is no gap.
  if (!known.length) return { records: [], gaps: [] };
  const s = await axisStatus(ctx, 'dns');
  const zone = s.kind === 'ready' ? s.adapter.capabilities.dns : undefined;
  const listOwned = zone?.listOwned;
  const remove = zone?.remove;
  // Nothing can tell golive-owned records apart (or delete one): the zones are handed back with the
  // records state recorded writing into them — silence here would leave them pointing at a host
  // project teardown may delete next.
  if (s.kind !== 'ready' || !zone || !listOwned || !remove) return { records: [], gaps: [dnsGap(known, baselines, s)] };
  // A zone golive wrote through another provider is never read here (that provider's API would refuse
  // the zone) and is handed back instead: the records are still there, just not reachable from this one.
  const gaps = foreign.length ? foreignDnsGaps(ctx, foreign, baselines) : [];

  const candidates: Array<{ domain: string; record: DnsRecord }> = [];
  for (const domain of read) {
    for (const record of await listOwned(ctx, domain)) candidates.push({ domain, record });
  }
  candidates.sort((a, b) => {
    const ka = recordKey(a.record);
    const kb = recordKey(b.record);
    if (ka !== kb) return ka < kb ? -1 : 1;
    return a.domain === b.domain ? 0 : a.domain < b.domain ? -1 : 1;
  });

  const out: InventoryDnsRecord[] = [];
  const seen = new Set<string>();
  for (const c of candidates) {
    const unique = `${c.domain}|${recordKey(c.record)}`;
    if (seen.has(unique)) continue; // the same record listed twice is not a conflict
    seen.add(unique);
    out.push({ provider: s.adapter.id, providerTitle: s.adapter.title, domain: c.domain, record: c.record, adapter: s.adapter, listOwned, remove });
  }
  return { records: out, gaps };
}

/**
 * Where golive may have written DNS records: the app and email domains from `golive.yaml` plus every
 * zone state recorded a write into. `read` holds the zones the provider configured now can be asked
 * about; `foreign` those state recorded through a DIFFERENT provider, which nothing here may read.
 */
function dnsZones(ctx: Ctx, baselines: DnsBaseline[]): { read: string[]; foreign: Array<{ zone: string; provider: string }> } {
  const configured = ctx.config.stack.dns;
  const read = new Map<string, string>(); // lowercase -> as configured, so each zone is read once
  for (const d of [ctx.config.domain, ctx.config.email?.domain]) {
    if (d && !read.has(d.toLowerCase())) read.set(d.toLowerCase(), d);
  }
  const foreign = new Map<string, string>(); // zone -> the provider golive wrote it through
  for (const b of baselines) {
    if (b.provider === configured || read.has(b.zone)) continue;
    if (!foreign.has(b.zone)) foreign.set(b.zone, b.provider);
  }
  for (const b of baselines) if (b.provider === configured && !read.has(b.zone)) read.set(b.zone, b.zone);
  return { read: [...read.values()], foreign: [...foreign.entries()].map(([zone, provider]) => ({ zone, provider })) };
}

/**
 * A zone golive wrote records into through a provider `golive.yaml` no longer names: one row per
 * recorded provider, naming the zones and the records state recorded, so they are not left pointing
 * at a host project the same teardown may delete.
 */
function foreignDnsGaps(ctx: Ctx, foreign: Array<{ zone: string; provider: string }>, baselines: DnsBaseline[]): InventoryGap[] {
  const byProvider = new Map<string, string[]>();
  for (const f of foreign) byProvider.set(f.provider, [...(byProvider.get(f.provider) ?? []), f.zone]);
  return [...byProvider.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([provider, zones]) => {
      const written = baselines.filter((b) => zones.includes(b.zone));
      const providerTitle = titleOf(ctx, provider);
      return {
        id: `teardown:dns:${provider}`,
        axis: 'dns' as const,
        provider,
        providerTitle,
        subject: written.length
          ? `the ${written.length} DNS record(s) golive wrote in ${zones.join(', ')} (${written.map((b) => formatRecord(asRecord(b))).join('; ')})`
          : `any DNS records golive wrote in ${zones.join(', ')}`,
        why: `state recorded those writes through ${providerTitle}, which golive.yaml does not name as the DNS provider now, so golive cannot read or remove them here`,
        fix: `Set ${providerTitle} as the DNS provider again and run \`golive teardown\`, or delete those records in the ${providerTitle} dashboard yourself.`,
        recorded: written.length > 0,
      };
    });
}

/**
 * The zone golive could not read or remove this run, with what state records writing there. Reported
 * instead of dropping the zone: a record golive wrote and cannot remove is the human's to delete, and
 * an unusable provider must be named as the reason rather than looking like "there is nothing there".
 */
function dnsGap(zones: string[], baselines: DnsBaseline[], s: AxisStatus): InventoryGap {
  const provider = s.kind === 'guided' ? s.provider : s.kind === 'none' ? '' : s.adapter.id;
  const providerTitle = s.kind === 'ready' || s.kind === 'unauthed' ? s.adapter.title : s.kind === 'guided' ? s.title : 'the DNS provider';
  const written = baselines.filter((b) => zones.some((z) => normName(z) === b.zone));
  const listed = [...new Set(written.map((b) => b.zone))];
  const subject = written.length
    ? `the ${written.length} DNS record(s) golive wrote in ${listed.join(', ')} (${written.map((b) => formatRecord(asRecord(b))).join('; ')})`
    : `any DNS records golive wrote in ${zones.join(', ')}`;
  let why: string;
  let fix: string;
  if (s.kind === 'none') {
    why = 'golive.yaml names no DNS provider for this app, so nothing here could read the zone or remove a record';
    fix = `Name the provider that serves ${zones.join(', ')} in golive.yaml and sign in to it, then run \`golive teardown\`; or delete those records in the provider's own dashboard.`;
  } else if (s.kind === 'guided') {
    why = `the DNS provider (${providerTitle}) is guided, so golive has no DNS read or removal for it`;
    fix = `Delete those records in the ${providerTitle} dashboard by hand; golive has no adapter for this provider, so no release can remove them.`;
  } else if (s.kind === 'unauthed') {
    why = `the ${providerTitle} login is not usable, so golive could not read the zone or remove anything`;
    fix = `Reconnect ${providerTitle} (${s.status.howToFix ?? 'sign in again in your own terminal window'}), then run \`golive teardown\`: it re-reads the zone and removes the records golive owns.`;
  } else {
    const missing = [
      !s.adapter.capabilities.dns && 'no DNS capability',
      s.adapter.capabilities.dns && !s.adapter.capabilities.dns.listOwned && 'no read that reports which records golive owns',
      s.adapter.capabilities.dns && !s.adapter.capabilities.dns.remove && 'no way to delete a record',
    ].filter(Boolean);
    why = `the ${providerTitle} adapter has ${missing.join(' and ')}, so golive cannot name or remove the records it wrote`;
    fix = `Delete those records in the ${providerTitle} dashboard by hand; no golive release can remove records at this provider.`;
  }
  return { id: `teardown:dns${provider ? `:${provider}` : ''}`, axis: 'dns', provider, providerTitle, subject, why, fix, recorded: written.length > 0 };
}

const recordKey = (r: DnsRecord): string => `${r.type} ${r.name} ${r.content}`;

const normName = (n: string): string => n.trim().replace(/\.$/, '').toLowerCase();

/** A recorded baseline as the record it describes, for the wording a human acts on. */
const asRecord = (b: DnsBaseline): DnsRecord => ({ type: b.type, name: b.name, content: b.content, ...(b.priority !== undefined ? { priority: b.priority } : {}) });

// ── Sending keys ────────────────────────────────────────────────────────────────────────────────

const KEY_STATE = /^([a-z0-9-]+)\.keyId@([a-z-]+)$/;

async function keyInventory(ctx: Ctx): Promise<InventorySendingKey[]> {
  const s = await axisStatus(ctx, 'email');
  const ready = s.kind === 'ready' ? s : null;
  const out: InventorySendingKey[] = [];
  // Sorted state keys: the same resources always produce the same order.
  for (const stateKey of Object.keys(ctx.state.get().resources).sort()) {
    const m = KEY_STATE.exec(stateKey);
    if (!m) continue;
    const provider = m[1]!;
    const target = m[2]!;
    const id = ctx.state.resource(stateKey);
    if (!id || !isKeySlot(target)) continue;
    const revoke = ready && ready.adapter.id === provider ? ready.adapter.capabilities.keys?.revoke : undefined;
    out.push({ provider, providerTitle: titleOf(ctx, provider), key: stateKey, target, id, ...(ready && revoke ? { revocation: { adapter: ready.adapter, revoke } } : {}) });
  }
  return out;
}

const isEnvTarget = (v: string): v is EnvTarget => (ENV_TARGETS as readonly string[]).includes(v);
/** The slots a recorded sending key can serve: the env targets, plus `smtp` for the auth mailer. */
const isKeySlot = (v: string): v is KeySlot => isEnvTarget(v) || v === 'smtp';

// ── Host project ────────────────────────────────────────────────────────────────────────────────

interface LinkedHostProject {
  provider: string;
  providerTitle: string;
  keys: { id: string; name: string };
  id: string;
  name?: string;
  /** State's creation marker names this exact project, so golive created it. */
  created: boolean;
}

async function projectInventory(ctx: Ctx): Promise<{ project: InventoryProject | null; gaps: InventoryGap[] }> {
  const s = await axisStatus(ctx, 'hosting');
  const linked = linkedHostProjects(ctx);
  const ready = s.kind === 'ready' ? s : null;
  const remove = ready?.adapter.capabilities.project?.remove;
  const mine = ready && remove ? linked.find((l) => l.provider === ready.adapter.id) : undefined;
  if (ready && remove && mine) {
    const read = ready.adapter.capabilities.project?.exists;
    return {
      project: {
        provider: ready.adapter.id,
        providerTitle: ready.adapter.title,
        keys: mine.keys,
        id: mine.id,
        ...(mine.name ? { name: mine.name } : {}),
        created: mine.created,
        remove,
        ...(read ? { exists: (x: Ctx) => read(x, mine.id) } : {}),
      },
      gaps: linked.filter((l) => l !== mine).map((l) => hostGap(s, l)),
    };
  }
  // The host cannot be read, cannot delete, or is not the provider state links: hand every linked
  // project back instead of leaving it out of the plan silently.
  return { project: null, gaps: linked.map((l) => hostGap(s, l)) };
}

/**
 * Every host project state still links, in a fixed order: the provider `golive.yaml` names first, then
 * every adapter that serves hosting. A project golive created stays golive's to report even when that
 * axis is signed out, guided, or another hosting provider is configured now — the project itself is
 * still there, and the human is the one who removes it.
 */
function linkedHostProjects(ctx: Ctx): LinkedHostProject[] {
  const out: LinkedHostProject[] = [];
  const seen = new Set<string>();
  for (const provider of [ctx.config.stack.hosting, ...ctx.adapters.filter((a) => a.axes.includes('hosting')).map((a) => a.id)]) {
    if (!provider || seen.has(provider)) continue;
    seen.add(provider);
    const keys = projectStateKeys(provider);
    const id = ctx.state.resource(keys.id);
    if (!id) continue; // nothing linked (in state) for this provider: nothing to report
    const name = ctx.state.resource(keys.name);
    // State holds the adopt/select path too, so a missing or different creation marker means the
    // human's project: report it, but never as golive's to delete.
    out.push({ provider, providerTitle: titleOf(ctx, provider), keys, id, ...(name ? { name } : {}), created: ctx.state.resource(createdProjectKey(provider)) === id });
  }
  return out;
}

/**
 * A host project golive cannot turn into a deletion step this run. Names the project from state and
 * says whether golive's creation marker covers it, so the human is never invited to delete an adopted
 * project on golive's word.
 */
function hostGap(s: AxisStatus, p: LinkedHostProject): InventoryGap {
  const configuredId = s.kind === 'guided' ? s.provider : s.kind === 'none' ? '' : s.adapter.id;
  const configuredTitle = s.kind === 'guided' ? s.title : s.kind === 'none' ? '' : s.adapter.title;
  let why: string;
  let how: string;
  if (configuredId && configuredId !== p.provider) {
    why = `golive.yaml names ${configuredTitle} for hosting now, while state still links this project through ${p.providerTitle}`;
    how = `Set ${p.providerTitle} as the hosting provider again and run \`golive teardown\`, or delete the project in the ${p.providerTitle} dashboard yourself`;
  } else if (s.kind === 'none' || s.kind === 'guided') {
    why = s.kind === 'none'
      ? 'golive.yaml names no hosting provider now, so golive has nothing it could delete it with'
      : `the hosting provider (${configuredTitle}) is guided, so golive has no project deletion for it`;
    how = `Delete the project in the ${p.providerTitle} dashboard yourself if it should go away`;
  } else if (s.kind === 'unauthed') {
    why = `the ${p.providerTitle} login is not usable, so golive could not delete it in this run`;
    how = `Reconnect ${p.providerTitle} (${s.status.howToFix ?? 'sign in again in your own terminal window'}), then run \`golive teardown\``;
  } else {
    why = `the ${p.providerTitle} adapter exposes no project deletion, so no golive release can remove it`;
    how = `Delete the project in the ${p.providerTitle} dashboard yourself if it should go away`;
  }
  const ownership = p.created
    ? `golive's creation marker (${createdProjectKey(p.provider)}) names this project, so an approved teardown removes it once that works`
    : 'state holds no creation marker naming it, so golive treats it as adopted and would not delete it even when reachable';
  return {
    id: `teardown:hosting:${p.provider}`,
    axis: 'hosting',
    provider: p.provider,
    providerTitle: p.providerTitle,
    subject: `the ${p.providerTitle} project ${p.name ? `${p.name} (${p.id})` : p.id}`,
    why,
    fix: `${how} — ${ownership}.`,
    recorded: true,
  };
}

// ── Recorded database projects and sending domains ───────────────────────────────────────────────

function recordedInventory(ctx: Ctx): InventoryRecorded[] {
  const out: InventoryRecorded[] = [];
  for (const spec of RECORDED) {
    const id = ctx.state.resource(spec.idKey);
    if (!id) continue;
    // Every marker must name this exact resource. With no marker declared nothing is proven —
    // `[].every()` is true, which would claim an adopted resource as golive's own.
    const created = spec.createdBy.length > 0 && spec.createdBy.every((k) => ctx.state.resource(k) === id);
    const name = spec.kind === 'sending-domain' ? (ctx.config.email?.domain ?? id) : ((spec.nameKey ? ctx.state.resource(spec.nameKey) : undefined) ?? id);
    out.push({ axis: spec.axis, provider: spec.provider, providerTitle: spec.providerTitle, kind: spec.kind, key: spec.idKey, id, name, created, markers: [...spec.createdBy], needs: spec.needs, where: spec.where, ...(spec.extra ? { extra: spec.extra } : {}) });
  }
  return out;
}
