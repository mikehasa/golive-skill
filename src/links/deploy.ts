import type { Link } from '../core/plan.js';
import type { Adapter, Ctx, Deployer, Step } from '../core/types.js';
import { deps, intentOf, lastDeployAt, memo, pendingRedeploy, ready, recordDeploy, step, track } from './util.js';

const WEBHOOK_STEP = 'payments:webhook:production';

/**
 * Env changes only apply to NEW deployments, so production is (re)deployed when:
 *   - this plan writes production env (steps tracked with needsRedeploy),
 *   - state says a production env write is still waiting for a deploy (REDEPLOY_KEY — survives a
 *     failed or skipped deploy step),
 *   - the last production deploy failed, or
 *   - golive has never deployed production (state; a host URL alone proves nothing — some hosts
 *     report one for projects that were never deployed).
 *
 * When production was never deployed, the deploy runs BEFORE domain:attach (hosts may refuse to
 * attach a domain without a successful production deployment); env writes that depend on the domain
 * (e.g. the webhook secret) then get a final redeploy after them.
 */
export const deployLink: Link = {
  id: 'deploy',
  async plan(ctx) {
    if (!ctx.config.targets.includes('production')) return null;
    const h = await ready(ctx, 'hosting', 'deploy');
    if (!h) return null;
    const m = memo(ctx);
    const after = [...m.redeployAfter];
    const lastOk = lastDeployAt(ctx);
    const pending = pendingRedeploy(ctx);
    const steps = ctx.state.get().steps;
    // A failed deploy counts until a later deploy succeeds.
    const failed = ['deploy:production', 'deploy:production:final']
      .map((id) => steps[id])
      .filter((r) => r?.status === 'failed' && (!lastOk || r.at > lastOk))
      .sort((a, b) => b!.at.localeCompare(a!.at))[0];
    if (!after.length && lastOk && !pending && !failed) return null;

    // Steps that must wait for a first deployment: domain:attach and everything depending on it.
    const attach = lastOk ? undefined : m.steps.get('domain:attach');
    const late = attach ? dependents(m.steps, attach.id) : new Set<string>();
    const early = after.filter((id) => !late.has(id));
    const lateWriters = after.filter((id) => late.has(id));

    const reasons: string[] = [];
    if (early.length) reasons.push(`so the env changes above take effect (${early.join(', ')}); env vars only apply to new deployments`);
    if (pending) reasons.push(`production env changed at ${pending} and no deploy has picked it up yet`);
    if (failed) reasons.push(`the last production deploy failed (${failed.at}); deploying again`);
    if (!lastOk) reasons.push(`golive has not deployed production yet${attach ? '; the domain is attached after this deploy' : ''}`);

    // Which writes this deploy picks up (their intents): two deploys with identical preview text (e.g.
    // two project switches within the same clock tick) are still different deploys.
    const picks = (ids: string[]): string[] => ids.map((id) => `${id}#${m.steps.get(id)?.intent ?? ''}`);
    const first = step({
      id: 'deploy:production',
      title: `Deploy production on ${h.adapter.title}`,
      kind: 'deploy',
      risk: { writes: true },
      dependsOn: deps(ctx, ['project:hosting', ...early]),
      preview: [`deploy production on ${h.adapter.title}: ${reasons.join('; ')}`, `last successful golive deploy: ${lastOk ?? 'none'}`],
      intent: intentOf({ picks: picks(early), pending, failed: failed?.at }),
      verifyWith: verifiers(ctx, early, lateWriters.length > 0),
      run: deployRun(h.adapter, h.cap),
    });
    const out: Step[] = track(ctx, [first]);
    if (attach && !attach.dependsOn.includes(first.id)) attach.dependsOn.push(first.id);

    if (lateWriters.length) {
      out.push(
        ...track(ctx, [step({
          id: 'deploy:production:final',
          title: `Redeploy production on ${h.adapter.title}`,
          kind: 'deploy',
          risk: { writes: true },
          dependsOn: deps(ctx, [first.id, ...lateWriters]),
          preview: [`redeploy production on ${h.adapter.title} after ${lateWriters.join(', ')}, which need the first deployment, so their env changes take effect`, `last successful golive deploy: ${lastOk ?? 'none'}`],
          intent: intentOf({ picks: picks(lateWriters) }),
          verifyWith: verifiers(ctx, lateWriters, false),
          run: deployRun(h.adapter, h.cap),
        })]),
      );
    }
    return { steps: out, handoffs: [] };
  },
};

/** Ids of steps that (transitively) depend on `root`, including root. */
function dependents(steps: Map<string, Step>, root: string): Set<string> {
  const out = new Set([root]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const s of steps.values()) {
      if (!out.has(s.id) && s.dependsOn.some((d) => out.has(d))) {
        out.add(s.id);
        grew = true;
      }
    }
  }
  return out;
}

/**
 * Probe the unsigned webhook only on a deploy that has the signing secret: one that follows the
 * webhook step, or — when no webhook step is planned — once golive has registered an endpoint before.
 * Otherwise the handler may 500 for lack of STRIPE_WEBHOOK_SECRET and fail a deploy that is fine;
 * `verify` runs that check anyway.
 */
function verifiers(ctx: Ctx, dependsOn: string[], moreFollows: boolean): string[] {
  const webhookPlanned = memo(ctx).planned.has(WEBHOOK_STEP);
  const registeredBefore = Object.keys(ctx.state.get().resources).some((k) => k.endsWith('.webhookEndpointId'));
  const hasSecret = webhookPlanned ? dependsOn.includes(WEBHOOK_STEP) : registeredBefore && !moreFollows;
  return hasSecret ? ['bundle-secrets', 'webhook-unsigned'] : ['bundle-secrets'];
}

function deployRun(adapter: Adapter, deployer: Deployer): Step['run'] {
  return async (sctx) => {
    const deployment = await deployer.deploy(sctx, 'production');
    recordDeploy(sctx, adapter.id, 'production', deployment);
    return { changes: [`deployed production on ${adapter.title}: ${deployment.url}`] };
  };
}
