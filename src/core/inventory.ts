/**
 * Inventory: what golive can prove it created, from state plus provider reads.
 *
 * `teardown` turns this into deletion steps and the handover document reports it, so an entry exists
 * only when golive can point at the proof it made the resource — the DNS provider's own
 * golive-owned record list, the endpoint or key id recorded in state, or the host project's creation
 * marker. Nothing here writes, and no timestamp enters a plan, so re-reading the same account yields
 * the same inventory.
 *
 * A resource recorded in state that golive cannot remove right now (the provider is not signed in,
 * another provider is configured, or it has no removal capability) is inventoried without a removal
 * handle: a consumer hands it back to the human instead of silently dropping it. Providers that
 * cannot tell golive-owned records apart contribute nothing at all — an inventory golive cannot
 * verify is worse than no inventory.
 */
import type { Adapter, Axis, Ctx, DnsRecord, DnsZone, EnvTarget, KeyIssuer, Mode, WebhookRegistry } from './types.js';
import { axisStatus } from '../links/util.js';

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
  /** Present only when golive can delete the endpoint right now: the adapter and its capability. */
  removal?: { adapter: Adapter; remove: NonNullable<WebhookRegistry['remove']> };
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
 * A database project or sending domain recorded in state. `created` follows the recorded creation
 * marker; `needs` and `where` name the place a human finishes a removal by hand, and `extra` carries
 * the provider's remaining caveat.
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
  needs: string;
  where: string;
  extra?: string;
}

export interface Inventory {
  webhooks: InventoryWebhook[];
  dnsRecords: InventoryDnsRecord[];
  sendingKeys: InventorySendingKey[];
  /** null when nothing is linked, the host is not usable, or it cannot delete projects. */
  project: InventoryProject | null;
  recorded: InventoryRecorded[];
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
  /** State keys that must all record the same id for it to prove golive created the resource. */
  createdBy: string[];
  needs: string;
  where: string;
  extra?: string;
}

const RECORDED: RecordedSpec[] = [
  { axis: 'db', provider: 'supabase', providerTitle: 'Supabase', kind: 'database-project', idKey: 'supabase.ref', createdBy: ['supabase.createdByGolive'], needs: 'the Supabase dashboard', where: 'the dashboard' },
  { axis: 'db', provider: 'neon', providerTitle: 'Neon', kind: 'database-project', idKey: 'neon.projectId', nameKey: 'neon.createdProjectName', createdBy: ['neon.createdProjectId'], needs: 'the Neon console', where: 'the Neon console', extra: '; Neon may keep a recovery window' },
  { axis: 'email', provider: 'resend', providerTitle: 'Resend', kind: 'sending-domain', idKey: 'resend.domainId', createdBy: [], needs: 'the Resend dashboard', where: 'the Resend dashboard', extra: '; any keys golive issued are revoked in the steps of this plan when applicable' },
];

/**
 * Read the whole inventory: webhooks, DNS records, sending keys, the host project, then the recorded
 * database/sending resources. Read-only, in that fixed order, so the same account always reads the
 * same way.
 */
export async function buildInventory(ctx: Ctx): Promise<Inventory> {
  const webhooks = await webhookInventory(ctx);
  const dnsRecords = await dnsInventory(ctx);
  const sendingKeys = await keyInventory(ctx);
  const project = await projectInventory(ctx);
  return { webhooks, dnsRecords, sendingKeys, project, recorded: recordedInventory(ctx) };
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
      const remove = ready && ready.adapter.id === provider ? ready.adapter.capabilities.webhooks?.remove : undefined;
      // A recorded endpoint golive cannot remove right now (signed out, a different provider, or no
      // capability) keeps no removal handle, so teardown hands it back explicitly.
      out.push({ provider, providerTitle: titleOf(ctx, provider), key: stateKey, mode, id, ...(ready && remove ? { removal: { adapter: ready.adapter, remove } } : {}) });
    }
  }
  return out;
}

// ── DNS records ─────────────────────────────────────────────────────────────────────────────────

async function dnsInventory(ctx: Ctx): Promise<InventoryDnsRecord[]> {
  const domains = inventoryDomains(ctx);
  if (!domains.length) return [];
  const s = await axisStatus(ctx, 'dns');
  if (s.kind !== 'ready') return [];
  const zone = s.adapter.capabilities.dns;
  const listOwned = zone?.listOwned;
  const remove = zone?.remove;
  // No way to tell golive-owned records apart (or to delete one): nothing to inventory, no handoff.
  if (!zone || !listOwned || !remove) return [];

  const candidates: Array<{ domain: string; record: DnsRecord }> = [];
  for (const domain of domains) {
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
  return out;
}

/** The app domain and the email sending domain: the names golive may have written records for. */
function inventoryDomains(ctx: Ctx): string[] {
  const byZone = new Map<string, string>(); // lowercase -> as configured, so each zone is read once
  for (const d of [ctx.config.domain, ctx.config.email?.domain]) {
    if (d && !byZone.has(d.toLowerCase())) byZone.set(d.toLowerCase(), d);
  }
  return [...byZone.values()];
}

const recordKey = (r: DnsRecord): string => `${r.type} ${r.name} ${r.content}`;

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

async function projectInventory(ctx: Ctx): Promise<InventoryProject | null> {
  const s = await axisStatus(ctx, 'hosting');
  if (s.kind !== 'ready') return null;
  const adapter = s.adapter;
  const remove = adapter.capabilities.project?.remove;
  if (!remove) return null;
  const read = adapter.capabilities.project?.exists;
  const keys = projectStateKeys(adapter.id);
  const current = ctx.state.resource(keys.id);
  if (!current) return null; // nothing linked (in state): nothing to report
  const name = ctx.state.resource(keys.name);
  // State holds the adopt/select path too, so a missing or different creation marker means the
  // human's project: report it, but never as golive's to delete.
  const created = ctx.state.resource(createdProjectKey(adapter.id)) === current;
  return { provider: adapter.id, providerTitle: adapter.title, keys, id: current, ...(name ? { name } : {}), created, remove, ...(read ? { exists: (x: Ctx) => read(x, current) } : {}) };
}

// ── Recorded database projects and sending domains ───────────────────────────────────────────────

function recordedInventory(ctx: Ctx): InventoryRecorded[] {
  const out: InventoryRecorded[] = [];
  for (const spec of RECORDED) {
    const id = ctx.state.resource(spec.idKey);
    if (!id) continue;
    const created = spec.createdBy.every((k) => ctx.state.resource(k) === id);
    const name = spec.kind === 'sending-domain' ? (ctx.config.email?.domain ?? id) : ((spec.nameKey ? ctx.state.resource(spec.nameKey) : undefined) ?? id);
    out.push({ axis: spec.axis, provider: spec.provider, providerTitle: spec.providerTitle, kind: spec.kind, key: spec.idKey, id, name, created, needs: spec.needs, where: spec.where, ...(spec.extra ? { extra: spec.extra } : {}) });
  }
  return out;
}
