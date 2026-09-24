/**
 * Teardown: the deterministic inverse of what golive created.
 *
 * This is NOT cross-provider rollback. It enumerates only resources golive can prove it created — the
 * host project whose creation marker matches, the webhook endpoints and sending keys recorded in
 * state, and the DNS records the DNS provider itself reports as golive-owned — so an approved
 * teardown can never delete an adopted project, a record golive did not write or a key it did not
 * issue. Everything is derived from state plus provider reads (no timestamps), and the steps are
 * assembled in a fixed order, so re-planning the same account yields the same plan id.
 *
 * Every step is `kind: 'destroy'` with `risk.destroy` (DNS records also `risk.dns`, live-mode
 * webhooks `risk.live`), so the runner refuses to delete anything without the matching explicit
 * confirmations. Providers without `listOwned`/`remove` — or without `project.remove` — are skipped
 * silently: an inventory golive cannot verify is worse than no inventory. Supabase, Neon and the
 * Resend sending domain have no delete capability at all, so they become manual, non-blocking
 * handoffs.
 */
import type { Adapter, Ctx, DnsRecord, DnsZone, EnvTarget, HandoffItem, KeyIssuer, Mode, Plan, Step, WebhookRegistry } from './types.js';
import { orderSteps, planId } from './plan.js';
import { redact } from './secret.js';
import { assertCompatibleState } from './state.js';
import { formatRecord } from '../links/email.js';
import { axisStatus, errMsg, intentOf, step } from '../links/util.js';

/** Payment modes golive can hold an endpoint for; state keys are `<adapterId>.<mode>.webhookEndpointId`. */
const MODES: readonly Mode[] = ['test', 'live'];
const ENV_TARGETS: readonly EnvTarget[] = ['development', 'preview', 'production'];

/**
 * Where a hosting adapter records the project it resolved. The id key doubles as "a project is
 * linked"; the name key is only used to make the preview readable.
 */
const PROJECT_STATE: Record<string, { id: string; name: string }> = {
  vercel: { id: 'vercel.projectId', name: 'vercel.projectName' },
  netlify: { id: 'netlify.siteId', name: 'netlify.siteName' },
};

/** `<provider>.createdProjectId` marks the project golive itself created — never an adopted one. */
const createdKey = (provider: string): string => `${provider}.createdProjectId`;

/**
 * Build the teardown plan: webhooks, DNS records, sending keys, then the host project. Smallest blast
 * radius first, so a failure part-way leaves the app running rather than pointing at a deleted host
 * project. Nothing here writes; `apply --plan <id>` plus the risk confirmations does.
 */
export async function buildTeardownPlan(ctx: Ctx): Promise<Plan> {
  assertCompatibleState(ctx.state.get(), ctx.release);
  if (ctx.config.version !== ctx.release.schemas.config) {
    throw new Error('Configuration schema is incompatible with this release. Preserve config and state; use a compatible release before planning.');
  }
  const webhooks = await webhookTeardown(ctx);
  const dns = await dnsSteps(ctx);
  const keys = await emailKeyTeardown(ctx);
  const project = await projectTeardown(ctx);
  const steps: Step[] = [...webhooks.steps, ...dns, ...keys.steps, ...project.steps];
  // One step per resource: a repeated id would silently drop a step when the plan is ordered.
  const stepIds = new Set<string>();
  for (const s of steps) {
    if (stepIds.has(s.id)) throw new Error(`teardown: two resources map to step ${s.id}, so golive cannot plan an unambiguous deletion. Resolve the duplicate and re-run.`);
    stepIds.add(s.id);
  }
  const handoffs: HandoffItem[] = [...dbHandoffs(ctx), ...emailHandoffs(ctx), ...webhooks.handoffs, ...keys.handoffs, ...project.handoffs];
  const ordered = orderSteps(steps);
  return { id: planId(ordered, handoffs, ctx.release), release: structuredClone(ctx.release), steps: ordered, handoffs, unmappedEnv: [], warnings: [] };
}

// ── Webhook endpoints ───────────────────────────────────────────────────────────────────────────

const WEBHOOK_KEY = /^([a-z0-9-]+)\.(test|live)\.webhookEndpointId$/;

async function webhookTeardown(ctx: Ctx): Promise<{ steps: Step[]; handoffs: HandoffItem[] }> {
  const s = await axisStatus(ctx, 'payments');
  const ready = s.kind === 'ready' ? s : null;
  const steps: Step[] = [];
  const handoffs: HandoffItem[] = [];
  const stateKeys = Object.keys(ctx.state.get().resources).sort();
  // test before live, then provider id: the same resources always produce the same step order.
  for (const mode of MODES) {
    for (const stateKey of stateKeys) {
      const m = WEBHOOK_KEY.exec(stateKey);
      if (!m || m[2] !== mode) continue;
      const providerId = m[1]!;
      const id = ctx.state.resource(stateKey);
      if (!id) continue;
      const remove = ready && ready.adapter.id === providerId ? ready.adapter.capabilities.webhooks?.remove : undefined;
      if (ready && remove) {
        steps.push(webhookStep(ready.adapter, remove, mode, id));
        continue;
      }
      // Recorded but not removable right now (signed out, a different provider, or no capability):
      // hand it back explicitly — silently leaving a live endpoint behind would be worse.
      handoffs.push({
        id: `teardown:webhook:${providerId}:${mode}`,
        why: `a ${providerId} ${mode}-mode webhook endpoint golive created (${id}) is recorded, but golive cannot remove it right now (the provider is not signed in or has no removal support)`,
        action: `Delete the endpoint ${id} in the ${providerId} dashboard if intended; it still points at the URL it was registered with.`,
        blocking: false,
        manual: true,
      });
    }
  }
  return { steps, handoffs };
}

function webhookStep(adapter: Adapter, remove: NonNullable<WebhookRegistry['remove']>, mode: Mode, id: string): Step {
  return step({
    id: `teardown:webhook:${adapter.id}:${mode}`,
    title: `Delete the ${adapter.title} ${mode}-mode webhook endpoint golive created`,
    kind: 'destroy',
    risk: { writes: true, destroy: true, live: mode === 'live' },
    preview: [`delete the ${adapter.title} ${mode}-mode webhook endpoint golive created (${id})`],
    intent: intentOf({ provider: adapter.id, mode, endpoint: id }),
    async run(sctx) {
      // A refusal is not a failure: the endpoint was already gone, or it turns out not to be golive's
      // to delete. Every other non-deletion — including a caught auth, network or provider error the
      // adapter reported instead of throwing — leaves the endpoint registered, so the step fails.
      const r = await remove(sctx, id, mode);
      if (r.deleted) return { changes: [`deleted webhook ${id}`] };
      if (r.reason === 'endpoint not found') return { changes: [`already gone: ${id}`] };
      if (r.reason === 'not created by golive') return { changes: [`left as is: ${r.reason}`] };
      throw new Error(`could not delete the ${adapter.title} ${mode}-mode webhook endpoint ${id}: ${redact(r.reason ?? 'the provider did not delete it')}`);
    },
  });
}

// ── DNS records ─────────────────────────────────────────────────────────────────────────────────

async function dnsSteps(ctx: Ctx): Promise<Step[]> {
  const domains = teardownDomains(ctx);
  if (!domains.length) return [];
  const s = await axisStatus(ctx, 'dns');
  if (s.kind !== 'ready') return [];
  const zone = s.adapter.capabilities.dns;
  const listOwned = zone?.listOwned;
  const remove = zone?.remove;
  // No way to tell golive-owned records apart (or to delete one): skip silently, no handoff.
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

  const steps: Step[] = [];
  const seenCandidates = new Set<string>();
  const byStepId = new Map<string, { domain: string; record: DnsRecord }>();
  for (const c of candidates) {
    const unique = `${c.domain}|${recordKey(c.record)}`;
    if (seenCandidates.has(unique)) continue; // the same record listed twice is not a conflict
    seenCandidates.add(unique);
    const id = `teardown:dns:${s.adapter.id}:${c.record.type}:${c.record.name.toLowerCase()}`;
    const prior = byStepId.get(id);
    if (prior) {
      throw new Error(
        `teardown: ${formatRecord(prior.record)} in ${prior.domain} and ${formatRecord(c.record)} in ${c.domain} would both be step ${id}, so golive cannot tell which record to delete. Delete the extra record yourself in the provider dashboard, then run teardown again.`,
      );
    }
    byStepId.set(id, c);
    steps.push(dnsStep(s.adapter, c.domain, c.record, id, listOwned, remove));
  }
  return steps;
}

/** The app domain and the email sending domain: the names golive may have written records for. */
function teardownDomains(ctx: Ctx): string[] {
  const byZone = new Map<string, string>(); // lowercase -> as configured, so each zone is read once
  for (const d of [ctx.config.domain, ctx.config.email?.domain]) {
    if (d && !byZone.has(d.toLowerCase())) byZone.set(d.toLowerCase(), d);
  }
  return [...byZone.values()];
}

const recordKey = (r: DnsRecord): string => `${r.type} ${r.name} ${r.content}`;

/** Identity of a record for the inline check: the same fields `remove` matches on. */
const sameRecord = (a: DnsRecord, b: DnsRecord): boolean => a.type === b.type && a.content === b.content && a.name.toLowerCase() === b.name.toLowerCase();

function dnsStep(
  adapter: Adapter,
  domain: string,
  record: DnsRecord,
  id: string,
  listOwned: NonNullable<DnsZone['listOwned']>,
  remove: NonNullable<DnsZone['remove']>,
): Step {
  return step({
    id,
    title: `Delete the ${adapter.title} record golive created (${record.type} ${record.name})`,
    kind: 'destroy',
    risk: { writes: true, destroy: true, dns: true },
    preview: [`delete the ${adapter.title} record golive created: ${formatRecord(record)}`],
    intent: intentOf({ provider: adapter.id, domain, type: record.type, name: record.name, content: record.content }),
    async run(sctx) {
      const outcome = await remove(sctx, domain, record);
      return { changes: [outcome === 'removed' ? `deleted: ${formatRecord(record)}` : `already gone: ${formatRecord(record)}`] };
    },
    // A delete is only reported as done once the provider's own owned-record list no longer has it.
    async verifyInline(vctx) {
      const checkId = `${id}:removed`;
      const title = `${adapter.title} no longer lists the record golive created: ${formatRecord(record)}`;
      let owned: DnsRecord[];
      try {
        owned = await listOwned(vctx, domain);
      } catch (e) {
        return [{
          id: checkId,
          title,
          status: 'warn',
          severity: 'medium',
          evidence: [`could not re-read the records ${adapter.title} reports as golive-owned in ${domain}: ${errMsg(e)}`],
          fix: `Check ${adapter.title} access, then confirm ${formatRecord(record)} is gone.`,
        }];
      }
      if (owned.some((r) => sameRecord(r, record))) {
        return [{
          id: checkId,
          title,
          status: 'fail',
          severity: 'high',
          evidence: [`${adapter.title} still lists ${formatRecord(record)} in ${domain} after the delete`],
          fix: `Delete it in the ${adapter.title} dashboard; golive does not report a delete it cannot confirm.`,
        }];
      }
      return [{ id: checkId, title, status: 'pass', severity: 'info', evidence: [`${formatRecord(record)} is gone from the records ${adapter.title} reports as golive-owned in ${domain}`] }];
    },
  });
}

// ── Sending keys ────────────────────────────────────────────────────────────────────────────────

const KEY_STATE = /^([a-z0-9-]+)\.keyId@([a-z-]+)$/;

async function emailKeyTeardown(ctx: Ctx): Promise<{ steps: Step[]; handoffs: HandoffItem[] }> {
  const s = await axisStatus(ctx, 'email');
  const ready = s.kind === 'ready' ? s : null;
  const steps: Step[] = [];
  const handoffs: HandoffItem[] = [];
  // Sorted state keys: the same resources always produce the same step order.
  for (const stateKey of Object.keys(ctx.state.get().resources).sort()) {
    const m = KEY_STATE.exec(stateKey);
    if (!m) continue;
    const providerId = m[1]!;
    const target = m[2]!;
    const id = ctx.state.resource(stateKey);
    if (!id || !isEnvTarget(target)) continue;
    const revoke = ready && ready.adapter.id === providerId ? ready.adapter.capabilities.keys?.revoke : undefined;
    if (ready && revoke) {
      steps.push(emailKeyStep(ready.adapter, target, id, revoke));
      continue;
    }
    // Recorded but not revocable right now (signed out, a different provider, or no capability).
    handoffs.push({
      id: `teardown:key:${providerId}:${target}`,
      why: `a ${providerId} sending key golive issued for ${target} (${id}) is recorded, but golive cannot revoke it right now (the provider is not signed in or has no revoke support)`,
      action: `Revoke the key ${id} in the ${providerId} dashboard if intended.`,
      blocking: false,
      manual: true,
    });
  }
  return { steps, handoffs };
}

const isEnvTarget = (v: string): v is EnvTarget => (ENV_TARGETS as readonly string[]).includes(v);

function emailKeyStep(adapter: Adapter, target: EnvTarget, id: string, revoke: NonNullable<KeyIssuer['revoke']>): Step {
  return step({
    id: `teardown:key:${adapter.id}:${target}`,
    title: `Revoke the ${adapter.title} sending key golive issued for ${target}`,
    kind: 'destroy',
    risk: { writes: true, destroy: true },
    preview: [`revoke the ${adapter.title} sending key golive issued for ${target} (${id})`],
    intent: intentOf({ provider: adapter.id, target, key: id }),
    async run(sctx) {
      // A refusal is not a failure: the key was already revoked (in the provider dashboard, or by an
      // earlier teardown whose state record never landed). Any other non-revocation leaves the key
      // usable, so the step fails instead of reporting success.
      const r = await revoke(sctx, id);
      if (r.revoked) return { changes: [`revoked ${id}`] };
      if (r.reason === 'key not found') return { changes: [`already gone: ${id}`] };
      throw new Error(`could not revoke the ${adapter.title} sending key ${id}: ${redact(r.reason ?? 'the provider did not revoke it')}`);
    },
  });
}

// ── Host project ────────────────────────────────────────────────────────────────────────────────

async function projectTeardown(ctx: Ctx): Promise<{ steps: Step[]; handoffs: HandoffItem[] }> {
  const s = await axisStatus(ctx, 'hosting');
  if (s.kind !== 'ready') return { steps: [], handoffs: [] };
  const adapter = s.adapter;
  const remove = adapter.capabilities.project?.remove;
  if (!remove) return { steps: [], handoffs: [] };
  const keys = PROJECT_STATE[adapter.id] ?? { id: `${adapter.id}.projectId`, name: `${adapter.id}.projectName` };
  const current = ctx.state.resource(keys.id);
  if (!current) return { steps: [], handoffs: [] }; // nothing linked (in state): nothing to delete
  const name = ctx.state.resource(keys.name);
  // Only a project golive created may be deleted. State holds the adopt/select path too, so a missing
  // or different creation marker means the human's project: hand it back rather than deleting it.
  if (ctx.state.resource(createdKey(adapter.id)) !== current) {
    return {
      steps: [],
      handoffs: [{
        id: 'teardown:project:hosting',
        why: `the ${adapter.title} project ${current} was adopted (not created by golive), so golive will not delete it`,
        action: `If the project should go away, delete it in the ${adapter.title} dashboard; keep it if the app continues elsewhere.`,
        blocking: false,
        manual: true,
      }],
    };
  }
  return { steps: [projectStep(adapter, current, name, keys, remove)], handoffs: [] };
}

function projectStep(adapter: Adapter, current: string, name: string | undefined, keys: { id: string; name: string }, remove: (ctx: Ctx) => Promise<{ removed: boolean; reason?: string }>): Step {
  const label = name ? `${name} (${current})` : current;
  return step({
    id: 'teardown:project:hosting',
    title: `Delete the ${adapter.title} project golive created`,
    kind: 'destroy',
    risk: { writes: true, destroy: true },
    preview: [`delete the ${adapter.title} project ${label} — golive created it`],
    intent: intentOf({ provider: adapter.id, project: current }),
    async run(sctx) {
      const r = await remove(sctx);
      if (r.removed) return { changes: [`deleted project ${current}`] };
      // A refusal is not a failure: state no longer links this exact project, or the creation marker
      // no longer proves golive created it, so golive must not delete it and did not. Any other
      // non-deletion means the project is still there, so the step fails instead of reporting success.
      const reason = r.reason ?? 'the provider kept the project';
      if (sctx.state.resource(keys.id) !== current || sctx.state.resource(createdKey(adapter.id)) !== current) return { changes: [`left as is: ${reason}`] };
      throw new Error(`could not delete the ${adapter.title} project ${current}: ${redact(reason)}`);
    },
  });
}

// ── Handoffs for resources golive created but cannot delete yet ──────────────────────────────────

function dbHandoffs(ctx: Ctx): HandoffItem[] {
  const out: HandoffItem[] = [];
  const supabaseRef = ctx.state.resource('supabase.ref');
  if (supabaseRef && ctx.state.resource('supabase.createdByGolive') === supabaseRef) {
    out.push({
      id: 'teardown:db:supabase',
      why: `the Supabase project ${supabaseRef} was created by golive, and deleting it needs the Supabase dashboard`,
      action: `Delete the Supabase project ${supabaseRef} in the dashboard if intended.`,
      blocking: false,
      manual: true,
    });
  }
  const neonProject = ctx.state.resource('neon.projectId');
  if (neonProject && ctx.state.resource('neon.createdProjectId') === neonProject) {
    out.push({
      id: 'teardown:db:neon',
      why: `the Neon project ${neonProject} was created by golive, and deleting it needs the Neon console`,
      action: `Delete the Neon project ${neonProject} in the Neon console if intended; Neon may keep a recovery window.`,
      blocking: false,
      manual: true,
    });
  }
  return out;
}

function emailHandoffs(ctx: Ctx): HandoffItem[] {
  const domainId = ctx.state.resource('resend.domainId');
  if (!domainId) return [];
  const label = ctx.config.email?.domain ?? domainId;
  return [{
    id: 'teardown:email:resend',
    why: `the Resend sending domain ${label} was created by golive, and deleting it needs the Resend dashboard`,
    action: `Delete the sending domain ${label} in the Resend dashboard if intended; any keys golive issued are revoked in the steps of this plan when applicable.`,
    blocking: false,
    manual: true,
  }];
}

/**
 * The plan `apply --plan <id>` should execute: the forward plan when it still matches, otherwise a
 * teardown plan whose id matches. A forward rebuild that FAILS (e.g. state points at a project that
 * was already deleted) must not block an approved teardown — but when nothing matches, the original
 * forward error is what the human should see.
 */
export async function approvedPlan(ctx: Ctx, approvedId: string, forward: () => Promise<Plan>): Promise<Plan> {
  let plan: Plan | null = null;
  let failure: unknown = null;
  try {
    plan = await forward();
  } catch (e) {
    failure = e;
  }
  if (!plan || plan.id !== approvedId) {
    const teardown = await buildTeardownPlan(ctx).catch(() => null);
    if (teardown && teardown.id === approvedId) plan = teardown;
  }
  if (!plan) throw failure;
  return plan;
}
