import { createHash } from 'node:crypto';
import type { Check, CheckResult, Ctx, Plan, Step, StepContext, Value } from './types.js';
import { Secret, fingerprint, redact } from './secret.js';
import { planId as currentPlanId } from './plan.js';
import { sameRelease } from './release.js';
import { assertCompatibleState } from './state.js';

export interface ApplyOptions {
  /** The plan id the human approved. Required. */
  approvedPlanId: string;
  /** Explicit approval flags. */
  yes: boolean;
  confirmLive: boolean;
  confirmDns: boolean;
  /** Required for steps that delete a resource golive created (risk.destroy). */
  confirmDestroy?: boolean;
  /** Only run these step ids; their read-only project destination guards still run. */
  only?: string[];
  /** Re-run steps even if state says they are done. */
  force?: boolean;
}

export interface StepOutcome {
  id: string;
  status: 'done' | 'skipped' | 'failed' | 'blocked';
  changes: string[];
  checks: CheckResult[];
  error?: string;
  /** What to do next when failed/blocked (secret-free). */
  next?: string;
}

export class PlanMismatchError extends Error {}

/** Error text that may reach state, a report or outcomes: redacted first, like every adapter does. */
function errMsg(e: unknown): string {
  return redact(e instanceof Error ? e.message : String(e));
}

export async function runCheck(ctx: Ctx, check: Check): Promise<CheckResult> {
  const t0 = Date.now();
  if (!check.applies(ctx)) return { id: check.id, title: check.title, status: 'skip', severity: check.severity, evidence: ['not applicable to this stack'], durationMs: 0 };
  try {
    const r = await check.run(ctx);
    return { id: check.id, title: check.title, ...r, durationMs: Date.now() - t0 };
  } catch (e) {
    return { id: check.id, title: check.title, status: 'fail', severity: check.severity, evidence: [`check errored: ${errMsg(e)}`], durationMs: Date.now() - t0 };
  }
}

/**
 * Execute an approved plan step by step: run → verify → record. Stops at the first failure so the
 * next invocation resumes exactly there (done steps are skipped via state). Never runs a step whose
 * risk flags were not explicitly confirmed.
 */
export async function applyPlan(ctx: Ctx, plan: Plan, checks: Map<string, Check>, opts: ApplyOptions): Promise<StepOutcome[]> {
  if (!sameRelease(plan.release, ctx.release)) throw new PlanMismatchError('release changed since approval. Re-observe with this complete release, run `plan` again and get a new approval; old approvals cannot be resumed.');
  assertCompatibleState(ctx.state.get(), ctx.release);
  if (ctx.config.version !== ctx.release.schemas.config) throw new PlanMismatchError('Configuration schema is incompatible with this release; preserve config/state and generate a new plan with a compatible release.');
  if (plan.id !== currentPlanId(plan.steps, plan.handoffs, ctx.release)) throw new PlanMismatchError('plan changed since approval. Run `plan` again and re-approve.');
  if (plan.id !== opts.approvedPlanId) {
    throw new PlanMismatchError(`plan changed since approval (approved ${opts.approvedPlanId}, current ${plan.id}). Run \`plan\` again and re-approve.`);
  }
  if (!opts.yes) throw new PlanMismatchError('refusing to write without --yes (the human must approve the plan first)');

  // A completed project pin is a live destination guard, not durable proof of ownership.
  // Include relevant pins even for --only: dependent writes must not bypass them via old state.
  const requiredPins = new Set<string>();
  const byId = new Map(plan.steps.map((s) => [s.id, s]));
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visited.has(id)) return;
    visited.add(id);
    const s = byId.get(id);
    if (!s) return;
    if (s.destination?.action === 'pin') requiredPins.add(id);
    for (const dependency of s.dependsOn) visit(dependency);
  };
  for (const s of plan.steps) if (!opts.only || opts.only.includes(s.id)) visit(s.id);

  // A new release may safely retain completed identical steps. Inspect the entire selected
  // dependency graph before ANY step, including dependencies omitted by --only: an old done
  // record cannot authorize a downstream deploy when the approved prerequisite has changed.
  // Two declared exemptions resume a historical write under the newer release instead of stopping
  // for reconciliation: `destroy` (a deletion re-observes ownership and is idempotent) and
  // `replayable` (the step declared the same properties for its write). Everything else stops here.
  for (const step of plan.steps) {
    if (!visited.has(step.id)) continue;
    const rec = ctx.state.get().steps[step.id];
    const selected = !opts.only || opts.only.includes(step.id);
    if (step.risk.writes && !step.risk.destroy && !step.risk.replayable && rec && !sameRelease(rec.release, ctx.release)
      && (rec.status !== 'done' || rec.hash !== stepHash(step) || (opts.force && selected))) {
      throw new PlanMismatchError(`historical step ${step.id} belongs to another or unknown release. Preserve state and reconcile its remote outcome before a new plan; automatic write replay is blocked.`);
    }
    if (!selected && !requiredPins.has(step.id) && (rec?.status !== 'done' || rec.hash !== stepHash(step))) {
      throw new PlanMismatchError(`prerequisite ${step.id} does not have matching completed evidence for this plan. Re-observe and include that prerequisite in a newly approved plan before running dependent writes.`);
    }
  }

  const outcomes: StepOutcome[] = [];
  for (const step of plan.steps) {
    if (opts.only && !opts.only.includes(step.id) && !requiredPins.has(step.id)) continue;

    const rec = ctx.state.get().steps[step.id];
    // Skip only if the SAME approved content already ran. If the step changed (e.g. payments switched
    // from test to live), its hash differs and it runs again.
    if (rec?.status === 'done' && rec.hash === stepHash(step) && !opts.force && !requiredPins.has(step.id)) {
      outcomes.push({ id: step.id, status: 'skipped', changes: ['already done'], checks: [] });
      continue;
    }
    // Completed steps are recorded in state immediately, so state is the single source of truth —
    // this also covers --only runs whose dependencies finished in an earlier invocation.
    const blockedBy = step.dependsOn.find((d) => {
      const prior = ctx.state.get().steps[d];
      const dependency = byId.get(d);
      return prior?.status !== 'done' || !dependency || prior.hash !== stepHash(dependency);
    });
    if (blockedBy) {
      outcomes.push({ id: step.id, status: 'blocked', changes: [], checks: [], next: `finish ${blockedBy} first` });
      break;
    }
    const missing = gateFlags(step, opts);
    if (missing.length) {
      outcomes.push({ id: step.id, status: 'blocked', changes: [], checks: [], next: `needs explicit human confirmation: ${missing.join(' ')}` });
      break;
    }
    if (step.kind === 'handoff') {
      // Handoffs are closed only by their verifying checks.
      const results = await Promise.all(step.verifyWith.map((id) => runOptional(ctx, checks, id)));
      const ok = results.length > 0 && results.every((r) => r.status === 'pass');
      outcomes.push({ id: step.id, status: ok ? 'done' : 'blocked', changes: [], checks: results, next: ok ? undefined : step.preview.join(' ') });
      record(ctx, step, plan.id, ok ? 'done' : 'failed', [], ok ? undefined : 'waiting on human');
      if (!ok) {
          break;
      }
      continue;
    }

    const sctx = stepContext(ctx);
    try {
      ctx.log.info(`→ ${step.title}`);
      const res = await step.run(sctx);
      const results = await Promise.all(step.verifyWith.map((id) => runOptional(ctx, checks, id)));
      if (step.verifyInline) {
        try {
          results.push(...(await step.verifyInline(ctx)));
        } catch (e) {
          results.push({ id: `${step.id}:verify`, title: `verify ${step.id}`, status: 'fail', severity: 'high', evidence: [`verification errored: ${errMsg(e)}`] });
        }
      }
      const bad = results.filter((r) => r.status === 'fail');
      if (bad.length) {
        record(ctx, step, plan.id, 'failed', res.changes, `verification failed: ${bad.map((b) => b.id).join(', ')}`);
        outcomes.push({ id: step.id, status: 'failed', changes: res.changes, checks: results, next: bad.map((b) => b.fix).filter(Boolean).join(' ') || 'see check evidence' });
          break;
      }
      record(ctx, step, plan.id, 'done', res.changes);
      outcomes.push({ id: step.id, status: 'done', changes: res.changes, checks: results });
    } catch (e) {
      const msg = errMsg(e);
      record(ctx, step, plan.id, 'failed', [], msg);
      outcomes.push({ id: step.id, status: 'failed', changes: [], checks: [], error: msg, next: 'fix the error above, then re-run apply (completed steps are skipped)' });
      break;
    }
  }
  return outcomes;
}

function gateFlags(step: Step, o: ApplyOptions): string[] {
  const missing: string[] = [];
  if (step.risk.live && !o.confirmLive) missing.push('--confirm-live');
  if (step.risk.dns && !o.confirmDns) missing.push('--confirm-dns');
  if (step.risk.destroy && !o.confirmDestroy) missing.push('--confirm-destroy');
  if (step.risk.spend) missing.push('(spend steps are never automated — this should be a handoff)');
  return missing;
}

async function runOptional(ctx: Ctx, checks: Map<string, Check>, id: string): Promise<CheckResult> {
  const c = checks.get(id);
  if (!c) return { id, title: id, status: 'skip', severity: 'info', evidence: ['check not registered'] };
  return runCheck(ctx, c);
}

function stepContext(ctx: Ctx): StepContext {
  return {
    ...ctx,
    remember(key, value) {
      ctx.state.save((s) => {
        s.resources[key] = value;
      });
    },
    rememberSecret(name, target, secret: Secret) {
      ctx.state.save((s) => {
        s.secrets[`${name}@${target}`] = { fp: secret.fingerprint, at: new Date().toISOString() };
      });
    },
    rememberValue(name, target, value: Value) {
      const fp = value instanceof Secret ? value.fingerprint : fingerprint(value);
      ctx.state.save((s) => {
        s.secrets[`${name}@${target}`] = { fp, at: new Date().toISOString() };
      });
    },
  };
}

/** Identity of what the human approved for a step. */
export function stepHash(step: Step): string {
  return createHash('sha256').update(JSON.stringify({ preview: step.preview, intent: step.intent ?? '', destination: step.destination, risk: step.risk, dependsOn: step.dependsOn, kind: step.kind })).digest('hex').slice(0, 12);
}

function record(ctx: Ctx, step: Step, planId: string, status: 'done' | 'failed', changes: string[], error?: string): void {
  ctx.state.save((s) => {
    s.release = structuredClone(ctx.release);
    s.steps[step.id] = { status, hash: stepHash(step), at: new Date().toISOString(), planId, release: structuredClone(ctx.release), changes, ...(error ? { error } : {}) };
  });
}
