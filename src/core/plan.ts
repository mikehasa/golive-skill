import { createHash } from 'node:crypto';
import type { Ctx, HandoffItem, Plan, ReleaseIdentity, Step } from './types.js';
import { assertCompatibleState } from './state.js';
import { canonicalReleaseJson } from './release.js';

/**
 * A plan's id is a hash of everything the human approves: step ids, previews and risk flags.
 * `apply --plan <id>` refuses to run if the recomputed plan differs, so the agent can never apply
 * something other than what the human saw.
 */
export function planId(steps: Step[], handoffs: HandoffItem[], release: ReleaseIdentity): string {
  const canon = canonicalReleaseJson({
    release,
    steps: steps.map((s) => ({ id: s.id, kind: s.kind, preview: s.preview, intent: s.intent ?? '', destination: s.destination, risk: s.risk, dependsOn: s.dependsOn })),
    handoffs: handoffs.map((h) => h.id),
  });
  return createHash('sha256').update(canon).digest('hex').slice(0, 12);
}

/** Topologically order steps; throws on unknown deps or cycles. Stable w.r.t. input order. */
export function orderSteps(steps: Step[]): Step[] {
  const byId = new Map(steps.map((s) => [s.id, s]));
  const out: Step[] = [];
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (s: Step, path: string[]): void => {
    const st = state.get(s.id);
    if (st === 'done') return;
    if (st === 'visiting') throw new Error(`plan has a dependency cycle: ${[...path, s.id].join(' → ')}`);
    state.set(s.id, 'visiting');
    for (const d of s.dependsOn) {
      const dep = byId.get(d);
      if (!dep) throw new Error(`step ${s.id} depends on unknown step ${d}`);
      visit(dep, [...path, s.id]);
    }
    state.set(s.id, 'done');
    out.push(s);
  };
  for (const s of steps) visit(s, []);
  return out;
}

/** A link contributes steps + handoffs to the plan, given the chosen stack and what's observed. */
export interface Link {
  id: string;
  /** Returns nothing when the link does not apply to this stack. */
  plan(ctx: Ctx): Promise<{ steps: Step[]; handoffs: HandoffItem[]; warnings?: string[] } | null>;
}

export async function buildPlan(ctx: Ctx, links: Link[], extra: { unmappedEnv: string[]; warnings: string[] }): Promise<Plan> {
  assertCompatibleState(ctx.state.get(), ctx.release);
  if (ctx.config.version !== ctx.release.schemas.config) throw new Error('Configuration schema is incompatible with this release. Preserve config and state; use a compatible release before planning.');
  const steps: Step[] = [];
  const handoffs: HandoffItem[] = [];
  const warnings = [...extra.warnings];
  for (const link of links) {
    const part = await link.plan(ctx);
    if (!part) continue;
    steps.push(...part.steps);
    handoffs.push(...part.handoffs);
    warnings.push(...(part.warnings ?? []));
  }
  const ids = new Set<string>();
  for (const s of steps) {
    if (ids.has(s.id)) throw new Error(`duplicate step id ${s.id}`);
    ids.add(s.id);
  }
  const ordered = orderSteps(steps);
  return { id: planId(ordered, handoffs, ctx.release), release: structuredClone(ctx.release), steps: ordered, handoffs, unmappedEnv: extra.unmappedEnv, warnings };
}

/** The approval view: everything the human needs to say yes/no, secret-free and serialisable. */
export function planView(plan: Plan) {
  return {
    planId: plan.id,
    release: plan.release,
    targets: plan.steps.flatMap((s) => s.destination ? [{ stepId: s.id, ...s.destination }] : []),
    steps: plan.steps.map((s) => ({
      id: s.id,
      title: s.title,
      kind: s.kind,
      writes: s.risk.writes,
      needs: [s.risk.live && '--confirm-live', s.risk.dns && '--confirm-dns'].filter(Boolean),
      preview: s.preview,
      dependsOn: s.dependsOn,
    })),
    handoffs: plan.handoffs,
    unmappedEnv: plan.unmappedEnv,
    warnings: plan.warnings,
  };
}
