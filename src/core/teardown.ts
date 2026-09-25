/**
 * Teardown: the deterministic inverse of what golive created.
 *
 * This is NOT cross-provider rollback. `src/core/inventory.ts` enumerates only resources golive can
 * prove it created — the host project whose creation marker matches, the webhook endpoints and
 * sending keys recorded in state, and the DNS records the DNS provider itself reports as golive-owned
 * — so an approved teardown can never delete an adopted project, a record golive did not write or a
 * key it did not issue. This module turns that inventory into plan steps; the steps are assembled in
 * a fixed order, so re-planning the same account yields the same plan id.
 *
 * Every step is `kind: 'destroy'` with `risk.destroy` (DNS records also `risk.dns`, live-mode
 * webhooks `risk.live`), so the runner refuses to delete anything without the matching explicit
 * confirmations. An inventoried resource golive cannot remove right now (the provider is not signed
 * in, another provider is configured, or it has no removal capability) becomes a manual, non-blocking
 * handoff instead of silently missing from the plan — including the zones and the host project the
 * inventory could not even read (`inventory.gaps`). Supabase, Neon and the Resend sending domain
 * have no delete capability at all, so they always become manual handoffs — and one state records
 * without a creation marker is handed back as adopted, with wording that never claims golive made it.
 *
 * Teardown is itself the approved write, so the baseline of a resource it provably removed goes with
 * it: the `dns:<zone>|<TYPE>|<name>` baseline, the webhook endpoint id and the sending key id are
 * forgotten once the provider's own answer (or its own read) says the resource is gone. Left behind,
 * a later `golive status` would report golive's own teardown as a change to reconcile. Nothing is
 * forgotten when the removal could not be confirmed or was refused.
 */
import type { Ctx, DnsRecord, HandoffItem, Plan, Step } from './types.js';
import { buildInventory, createdProjectKey, type InventoryDnsRecord, type InventoryGap, type InventoryProject, type InventoryRecorded, type InventorySendingKey, type InventoryWebhook } from './inventory.js';
import { dnsBaselineKey } from './dns-baseline.js';
import { orderSteps, planId } from './plan.js';
import { redact } from './secret.js';
import { assertCompatibleState } from './state.js';
import { formatRecord } from '../links/email.js';
import { errMsg, forgetDeployFacts, intentOf, step } from '../links/util.js';

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
  const inventory = await buildInventory(ctx);
  const webhooks = webhookTeardown(inventory.webhooks);
  const keys = keyTeardown(inventory.sendingKeys);
  const project = projectTeardown(inventory.project);
  const steps: Step[] = [...webhooks.steps, ...dnsSteps(inventory.dnsRecords), ...keys.steps, ...project.steps];
  // One step per resource: a repeated id would silently drop a step when the plan is ordered.
  const stepIds = new Set<string>();
  for (const s of steps) {
    if (stepIds.has(s.id)) throw new Error(`teardown: two resources map to step ${s.id}, so golive cannot plan an unambiguous deletion. Resolve the duplicate and re-run.`);
    stepIds.add(s.id);
  }
  const handoffs: HandoffItem[] = [...dbHandoffs(inventory.recorded), ...emailHandoffs(inventory.recorded), ...webhooks.handoffs, ...keys.handoffs, ...project.handoffs, ...gapHandoffs(inventory.gaps)];
  const ordered = orderSteps(steps);
  return { id: planId(ordered, handoffs, ctx.release), release: structuredClone(ctx.release), steps: ordered, handoffs, unmappedEnv: [], warnings: [] };
}

// ── Webhook endpoints ───────────────────────────────────────────────────────────────────────────

function webhookTeardown(webhooks: InventoryWebhook[]): { steps: Step[]; handoffs: HandoffItem[] } {
  const steps: Step[] = [];
  const handoffs: HandoffItem[] = [];
  for (const w of webhooks) {
    if (w.removal) {
      steps.push(webhookStep(w, w.removal));
      continue;
    }
    // Recorded but not removable right now (signed out, a different provider, or no capability):
    // hand it back explicitly — silently leaving a live endpoint behind would be worse.
    handoffs.push({
      id: `teardown:webhook:${w.provider}:${w.mode}`,
      why: `a ${w.provider} ${w.mode}-mode webhook endpoint golive created (${w.id}) is recorded, but golive cannot remove it right now (the provider is not signed in or has no removal support)`,
      action: `Delete the endpoint ${w.id} in the ${w.provider} dashboard if intended; it still points at the URL it was registered with.`,
      blocking: false,
      manual: true,
    });
  }
  return { steps, handoffs };
}

function webhookStep(w: InventoryWebhook, removal: NonNullable<InventoryWebhook['removal']>): Step {
  const { adapter, remove, list } = removal;
  const { mode, id, key } = w;
  const stepId = `teardown:webhook:${adapter.id}:${mode}`;
  // Whether this run left the endpoint registered on purpose (the provider says it is not golive's):
  // the recorded id then still describes a live endpoint, so neither it nor its state record may go.
  let left = false;
  return step({
    id: stepId,
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
      if (r.reason === 'not created by golive') {
        left = true;
        return { changes: [`left as is: ${r.reason}`] };
      }
      throw new Error(`could not delete the ${adapter.title} ${mode}-mode webhook endpoint ${id}: ${redact(r.reason ?? 'the provider did not delete it')}`);
    },
    // A delete is only reported as done once the provider's own list no longer has the endpoint (the
    // DNS steps confirm a removal the same way). A provider that cannot be re-read warns instead of
    // failing, and one that still lists the endpoint fails: golive does not report a delete it cannot
    // confirm. Either way the recorded id is forgotten only once the provider's answer says the
    // endpoint is gone — teardown is the approved write, so its own record must not outlive it.
    async verifyInline(vctx) {
      if (left) return [];
      const checkId = `${stepId}:removed`;
      const title = `${adapter.title} no longer lists the ${mode}-mode webhook endpoint golive created (${id})`;
      let endpoints: Awaited<ReturnType<typeof list>>;
      try {
        endpoints = await list(vctx, mode);
      } catch (e) {
        forgetWebhookRecord(vctx, key);
        return [{
          id: checkId,
          title,
          status: 'warn',
          severity: 'medium',
          evidence: [`the delete was reported, but the ${adapter.title} ${mode}-mode endpoints could not be re-read: ${errMsg(e)}`],
          fix: `Check ${adapter.title} access, then confirm the endpoint ${id} is gone.`,
        }];
      }
      if (endpoints.some((e) => e.id === id)) {
        return [{
          id: checkId,
          title,
          status: 'fail',
          severity: 'high',
          evidence: [`${adapter.title} still lists the ${mode}-mode endpoint ${id} after the delete`],
          fix: `Delete it in the ${adapter.title} dashboard; golive does not report a delete it cannot confirm.`,
        }];
      }
      forgetWebhookRecord(vctx, key);
      return [{ id: checkId, title, status: 'pass', severity: 'info', evidence: [`${adapter.title} no longer lists the ${mode}-mode endpoint ${id}`] }];
    },
  });
}

/** Forget the endpoint id teardown provably removed: only an approved write moves what state records. */
function forgetWebhookRecord(ctx: Ctx, key: string): void {
  ctx.state.save((s) => {
    delete s.resources[key];
  });
}

// ── DNS records ─────────────────────────────────────────────────────────────────────────────────

function dnsSteps(records: InventoryDnsRecord[]): Step[] {
  const steps: Step[] = [];
  const byStepId = new Map<string, InventoryDnsRecord>();
  for (const r of records) {
    const id = `teardown:dns:${r.provider}:${r.record.type}:${r.record.name.toLowerCase()}`;
    const prior = byStepId.get(id);
    if (prior) {
      throw new Error(
        `teardown: ${formatRecord(prior.record)} in ${prior.domain} and ${formatRecord(r.record)} in ${r.domain} would both be step ${id}, so golive cannot tell which record to delete. Delete the extra record yourself in the provider dashboard, then run teardown again.`,
      );
    }
    byStepId.set(id, r);
    steps.push(dnsStep(r, id));
  }
  return steps;
}

/** Identity of a record for the inline check: the same fields `remove` matches on. */
const sameRecord = (a: DnsRecord, b: DnsRecord): boolean => a.type === b.type && a.content === b.content && a.name.toLowerCase() === b.name.toLowerCase();

function dnsStep(r: InventoryDnsRecord, id: string): Step {
  const { adapter, domain, record, listOwned, remove } = r;
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
    // The recorded baseline goes with the record in both confirmed-absence cases (a provider that
    // cannot be re-read included: the delete itself was reported), and stays when the provider still
    // lists the record — a baseline is never dropped for a record that is still there.
    async verifyInline(vctx) {
      const checkId = `${id}:removed`;
      const title = `${adapter.title} no longer lists the record golive created: ${formatRecord(record)}`;
      let owned: DnsRecord[];
      try {
        owned = await listOwned(vctx, domain);
      } catch (e) {
        forgetDnsBaseline(vctx, domain, record);
        return [{
          id: checkId,
          title,
          status: 'warn',
          severity: 'medium',
          evidence: [`could not re-read the records ${adapter.title} reports as golive-owned in ${domain}: ${errMsg(e)}`],
          fix: `Check ${adapter.title} access, then confirm ${formatRecord(record)} is gone.`,
        }];
      }
      if (owned.some((x) => sameRecord(x, record))) {
        return [{
          id: checkId,
          title,
          status: 'fail',
          severity: 'high',
          evidence: [`${adapter.title} still lists ${formatRecord(record)} in ${domain} after the delete`],
          fix: `Delete it in the ${adapter.title} dashboard; golive does not report a delete it cannot confirm.`,
        }];
      }
      forgetDnsBaseline(vctx, domain, record);
      return [{ id: checkId, title, status: 'pass', severity: 'info', evidence: [`${formatRecord(record)} is gone from the records ${adapter.title} reports as golive-owned in ${domain}`] }];
    },
  });
}

/**
 * Forget the baseline of a record teardown just removed. The baseline says "golive wrote this and
 * expects it in the zone"; once the provider's own list confirms it is gone, keeping it would make a
 * later `golive status` report golive's own teardown as a record to reconcile. Teardown is the
 * approved write here, so this is not a silent re-baseline.
 */
function forgetDnsBaseline(ctx: Ctx, zone: string, record: DnsRecord): void {
  const key = dnsBaselineKey(zone, record);
  ctx.state.save((s) => {
    delete s.resources[key];
  });
}

// ── Sending keys ────────────────────────────────────────────────────────────────────────────────

function keyTeardown(keys: InventorySendingKey[]): { steps: Step[]; handoffs: HandoffItem[] } {
  const steps: Step[] = [];
  const handoffs: HandoffItem[] = [];
  for (const k of keys) {
    if (k.revocation) {
      steps.push(emailKeyStep(k, k.revocation));
      continue;
    }
    // Recorded but not revocable right now (signed out, a different provider, or no capability).
    handoffs.push({
      id: `teardown:key:${k.provider}:${k.target}`,
      why: `a ${k.provider} sending key golive issued for ${k.target} (${k.id}) is recorded, but golive cannot revoke it right now (the provider is not signed in or has no revoke support)`,
      action: `Revoke the key ${k.id} in the ${k.provider} dashboard if intended.`,
      blocking: false,
      manual: true,
    });
  }
  return { steps, handoffs };
}

function emailKeyStep(k: InventorySendingKey, revocation: NonNullable<InventorySendingKey['revocation']>): Step {
  const { adapter, revoke } = revocation;
  const { target, id, key } = k;
  const stepId = `teardown:key:${adapter.id}:${target}`;
  return step({
    id: stepId,
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
    // Nothing can re-read a revoked key: the capability is issue-and-revoke only (Resend exposes no
    // key read), so this is reported as unverified — never as a pass — and the recorded key id goes
    // with the key the provider's answer says is gone. Keeping it would leave `golive status` calling
    // a revoked key the app's key, and a later teardown planning a revocation that cannot happen.
    async verifyInline(vctx) {
      forgetKeyRecord(vctx, key);
      return [{
        id: `${stepId}:revoked`,
        title: `${adapter.title} cannot confirm the ${target} sending key golive revoked`,
        status: 'warn',
        severity: 'medium',
        evidence: [
          `the provider reported ${id} revoked, but ${adapter.title} exposes no read for an issued key (issue and revoke only), so golive cannot re-check it`,
        ],
        fix: `Confirm the key ${id} is gone in the ${adapter.title} dashboard.`,
      }];
    },
  });
}

/** Forget the key id teardown revoked: see the DNS baseline note above; same reasoning, same approval. */
function forgetKeyRecord(ctx: Ctx, key: string): void {
  ctx.state.save((s) => {
    delete s.resources[key];
  });
}

// ── Host project ────────────────────────────────────────────────────────────────────────────────

function projectTeardown(project: InventoryProject | null): { steps: Step[]; handoffs: HandoffItem[] } {
  if (!project) return { steps: [], handoffs: [] };
  // Only a project golive created may be deleted. State holds the adopt/select path too, so a missing
  // or different creation marker means the human's project: hand it back rather than deleting it.
  if (!project.created) {
    return {
      steps: [],
      handoffs: [{
        id: 'teardown:project:hosting',
        why: `the ${project.providerTitle} project ${project.id} was adopted (not created by golive), so golive will not delete it`,
        action: `If the project should go away, delete it in the ${project.providerTitle} dashboard; keep it if the app continues elsewhere.`,
        blocking: false,
        manual: true,
      }],
    };
  }
  return { steps: [projectStep(project)], handoffs: [] };
}

function projectStep(p: InventoryProject): Step {
  const id = 'teardown:project:hosting';
  const label = p.name ? `${p.name} (${p.id})` : p.id;
  // Whether this run deleted the project. A refusal ("left as is") leaves it in place on purpose, so
  // the absence re-read below only applies to an actual deletion.
  let deleted = false;
  return step({
    id,
    title: `Delete the ${p.providerTitle} project golive created`,
    kind: 'destroy',
    risk: { writes: true, destroy: true },
    preview: [`delete the ${p.providerTitle} project ${label} — golive created it`],
    intent: intentOf({ provider: p.provider, project: p.id }),
    async run(sctx) {
      const r = await p.remove(sctx);
      deleted = r.removed;
      if (r.removed) {
        // The deploy facts described the project that just went away. Left behind, a project created
        // again in this repo would inherit "production was deployed" and plan no deploy at all.
        forgetDeployFacts(sctx);
        return { changes: [`deleted project ${p.id}`] };
      }
      // A refusal is not a failure: state no longer links this exact project, or the creation marker
      // no longer proves golive created it, so golive must not delete it and did not. Any other
      // non-deletion means the project is still there, so the step fails instead of reporting success.
      const reason = r.reason ?? 'the provider kept the project';
      if (sctx.state.resource(p.keys.id) !== p.id || sctx.state.resource(createdProjectKey(p.provider)) !== p.id) return { changes: [`left as is: ${reason}`] };
      throw new Error(`could not delete the ${p.providerTitle} project ${p.id}: ${redact(reason)}`);
    },
    // A delete is only reported as done once the host itself no longer resolves the project (the DNS
    // steps confirm a removal the same way). A host golive cannot re-read warns instead of failing.
    async verifyInline(vctx) {
      if (!deleted) return [];
      const checkId = `${id}:removed`;
      const title = `${p.providerTitle} no longer reports the project golive created: ${label}`;
      if (!p.exists) {
        return [{
          id: checkId,
          title,
          status: 'warn',
          severity: 'medium',
          evidence: [`${p.providerTitle} has no read that could re-check the project after the delete`],
          fix: `Confirm ${label} is gone in the ${p.providerTitle} dashboard.`,
        }];
      }
      let still: boolean;
      try {
        still = await p.exists(vctx);
      } catch (e) {
        return [{
          id: checkId,
          title,
          status: 'warn',
          severity: 'medium',
          evidence: [`could not re-read the ${p.providerTitle} project ${label} after the delete: ${errMsg(e)}`],
          fix: `Check ${p.providerTitle} access, then confirm ${label} is gone.`,
        }];
      }
      if (still) {
        return [{
          id: checkId,
          title,
          status: 'fail',
          severity: 'high',
          evidence: [`${p.providerTitle} still resolves the project ${label} after the delete`],
          fix: `Delete it in the ${p.providerTitle} dashboard; golive does not report a delete it cannot confirm.`,
        }];
      }
      return [{ id: checkId, title, status: 'pass', severity: 'info', evidence: [`${p.providerTitle} no longer resolves the project ${label}`] }];
    },
  });
}

// ── Handoffs for resources golive created but cannot delete yet ──────────────────────────────────

/**
 * Every recorded resource this run could not even read or reach, as a handoff: the zone whose DNS
 * provider is unusable (or cannot tell golive-owned records apart) and the linked host project golive
 * cannot remove now. The subject names what remains and the action says exactly what to do, so a
 * teardown can never delete the host project while silently leaving records or a project behind.
 */
function gapHandoffs(gaps: InventoryGap[]): HandoffItem[] {
  return gaps.map((g) => ({
    id: g.id,
    why: `${g.subject}: ${g.why}`,
    action: g.fix,
    blocking: false,
    manual: true,
  }));
}

function dbHandoffs(recorded: InventoryRecorded[]): HandoffItem[] {
  return recorded.filter((r) => r.axis === 'db').map(manualHandoff);
}

function emailHandoffs(recorded: InventoryRecorded[]): HandoffItem[] {
  return recorded.filter((r) => r.kind === 'sending-domain').map(manualHandoff);
}

/**
 * The inventoried resource a human deletes by hand, in the provider's own dashboard or console. A
 * resource golive only adopted (its creation marker is absent or names another id) is handed back the
 * same way — silently dropping it would hide that state still records it — but the wording never
 * claims golive made it, so nobody deletes an account's own project or sending domain on golive's word.
 */
function manualHandoff(r: InventoryRecorded): HandoffItem {
  const subject = r.kind === 'database-project' ? `${r.providerTitle} project ${r.id}` : `${r.providerTitle} sending domain ${r.name}`;
  const thing = r.kind === 'database-project' ? `the ${r.providerTitle} project ${r.id}` : `the sending domain ${r.name}`;
  if (!r.created) {
    return {
      id: `teardown:${r.axis === 'db' ? 'db' : 'email'}:${r.provider}`,
      why: `the ${subject} is recorded in .golive/state.json, but no creation marker (${r.markers.join(', ') || 'none declared'}) covers it, so golive cannot prove it created it: it was adopted`,
      action: `Check ${thing} in ${r.where} before touching it: golive adopted it, so it may belong to this account already and predate this app. Delete it by hand there only if it is really disposable.`,
      blocking: false,
      manual: true,
    };
  }
  return {
    id: `teardown:${r.axis === 'db' ? 'db' : 'email'}:${r.provider}`,
    why: `the ${subject} was created by golive, and deleting it needs ${r.needs}`,
    action: `Delete ${thing} in ${r.where} if intended${r.extra ?? ''}.`,
    blocking: false,
    manual: true,
  };
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
