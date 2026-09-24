import type { Link } from '../core/plan.js';
import type { Adapter, Ctx, Deployer, EnvTarget, HandoffItem, Mode, Step, StepResult } from '../core/types.js';
import { modeFor } from '../core/config.js';
import { runCheck } from '../core/runner.js';
import { productionReleaseCheck, previewBundleCheck, previewDeployCheck } from '../checks/release.js';
import {
  cap,
  deps,
  intentOf,
  memo,
  previousProductionDeploy,
  projectIdentity,
  projectIntent,
  readDeployHistory,
  readRecordedDeploy,
  readRelease,
  ready,
  recordDeploy,
  recordRelease,
  step,
  track,
  type DeploymentRecord,
  type RecordedDeploy,
} from './util.js';

const DEPLOY_STEP = 'preview:deploy';
const CHECK_STEP = 'release:check';
const PROMOTE_STEP = 'promote:production';
const ROLLBACK_STEP = 'release:rollback';

/**
 * Preview deployments, the release check that gates them, and the two production re-points built on
 * top of that record. Planned only when the human opted in — `release.preview: true` in golive.yaml
 * (plus `targets` managing preview for the preview steps) — so a stack that did not opt in produces
 * exactly the plan it produced before this link existed.
 *
 * A preview is a CREATE: `preview:deploy` is never `replayable`, always makes a new deployment and
 * records the provider's own identity for it (`deployed:preview:id`). `release:check` writes nothing:
 * it re-reads what the provider says about the recorded deployment and scans the bundle it serves, so
 * a failing check fails the step and stops the plan. That check is the gate.
 *
 * `promote:production` (opt-in `release.promote`, on top of `release.preview`) re-points production at
 * the preview deployment golive recorded and re-checks in the same plan — never at a deployment golive
 * did not create. Its plan names that exact id, so the approval is the binding: no separate
 * confirmation flag exists, the plan id and the dependency on `release:check` do the gating.
 * `release:rollback` (its own opt-in, no preview needed) re-points production at an earlier deployment
 * from `deployed:history`. Both re-read the target and production before writing and prove what
 * production serves afterwards, and both refuse when the provider cannot answer those reads. Neither
 * is `destroy` (nothing is deleted) and neither is `replayable`: a production re-point keeps the
 * cross-release reconciliation stop.
 */
export const releaseLink: Link = {
  id: 'release',
  async plan(ctx) {
    const release = ctx.config.release;
    const preview = release?.preview === true;
    const promote = release?.promote === true;
    const rollback = release?.rollback === true;
    if (!preview && !promote && !rollback) return null;
    // A release and a rollback of the same app in one plan would contradict each other, and choosing
    // one would be golive's decision rather than the human's.
    if (promote && rollback) {
      return { steps: [], handoffs: [], warnings: ['release.promote and release.rollback are both set: golive will not plan a release and a rollback of the same app in one plan — keep one of them in golive.yaml, then re-plan'] };
    }
    // A rollback needs no preview: its target is an earlier deployment golive recorded for production.
    if (rollback) return rollbackPlan(ctx);
    if (promote && !preview) {
      return { steps: [], handoffs: [], warnings: ['release.promote is set, but release.preview is not: golive promotes a preview deployment it deployed and checked, and nothing else — set release.preview: true too, then re-plan'] };
    }

    if (!ctx.config.targets.includes('preview')) {
      return { steps: [], handoffs: [], warnings: ['release.preview is set, but `targets` in golive.yaml does not manage preview: no preview deployment is planned'] };
    }
    const h = await ready(ctx, 'hosting', 'deploy');
    if (!h) {
      return { steps: [], handoffs: [], warnings: [`release.preview is set, but golive cannot deploy a preview on ${ctx.config.stack.hosting ?? 'the chosen hosting provider'}: the host is guided, not logged in, or exposes no deploy capability`] };
    }

    const m = memo(ctx);
    const env = m.steps.get('env:preview');
    const previous = readRecordedDeploy(ctx, 'preview');
    const production = readRecordedDeploy(ctx, 'production');
    const warnings: string[] = [];
    // Promotion rides on the same opt-in: without `release.preview` there is no checked preview and
    // nothing golive is allowed to promote, and without `release` on the host golive cannot re-read
    // what production serves — so it says so rather than planning a step it would have to refuse.
    const rel = promote ? await ready(ctx, 'hosting', 'release') : undefined;
    if (promote && !rel) {
      warnings.push(`release.promote is set, but golive cannot re-point production on ${ctx.config.stack.hosting ?? 'the chosen hosting provider'}: the host is guided, not logged in, or exposes no release capability (a read of what production serves plus a re-point call) — no promotion is planned`);
    }

    // Release phase: a preview deployment golive recorded is not what production serves yet, so this
    // plan promotes exactly THAT deployment — the one the plan can name, re-checked in this plan. A
    // preview env write in this plan makes the recorded deployment stale, so the preview is re-cut and
    // checked first and the promotion follows in the next approved plan.
    if (rel && promote && previous && previous.provider === h.adapter.id && production?.id !== previous.id && !env) {
      const check = checkStep(ctx, h.adapter, {
        deploy: null,
        coveredId: `${previous.provider}|${previous.id}`,
        covers: `the preview deployment golive recorded (${previous.provider} ${previous.id}, ${previous.url}, recorded ${previous.at})`,
        project: await projectLabel(ctx, h.adapter),
        promotes: true,
      });
      const promotion = promoteStep(ctx, h.adapter, {
        target: previous,
        built: builtForDeployment(ctx, previous),
        production,
        checkedAt: ctx.state.get().steps[CHECK_STEP]?.status === 'done' ? ctx.state.get().steps[CHECK_STEP]!.at : undefined,
        checkIntent: check.intent ?? '',
        project: await projectLabel(ctx, h.adapter),
      });
      return { steps: track(ctx, [check, promotion]), handoffs: [], warnings };
    }

    const steps = ctx.state.get().steps;
    const reasons: string[] = [];
    if (env) reasons.push(`the preview env changes in this plan (${env.id}) and only reaches a new deployment`);
    if (steps[DEPLOY_STEP]?.status === 'failed') reasons.push(`the last preview deploy failed (${steps[DEPLOY_STEP]!.at})`);
    if (steps[CHECK_STEP]?.status === 'failed') reasons.push(`the last release check failed (${steps[CHECK_STEP]!.at}); a new preview gets a fresh check`);
    if (!previous) reasons.push('golive has never deployed a preview for this app');
    // Promotion is a release request, and the provider reports a deployment id only once the
    // deployment is made: the plan that can NAME the deployment to promote is therefore the one after
    // the deploy, so this plan cuts the candidate.
    if (rel) reasons.push(`release.promote is set: golive releases by promoting a checked preview, so this plan deploys and checks the preview that the next approved plan promotes to production`);
    // Nothing to plan, but a warning of our own still has to reach the human (e.g. the promotion the
    // opt-in asks for is impossible on this host).
    if (!reasons.length) return warnings.length ? { steps: [], handoffs: [], warnings } : null;

    const live = livePreviewNames(ctx, [...m.steps.values()]);
    // The deploy's identity: the project it goes to, the preview env writes it picks up, live-mode
    // sources, and the preview before it — a re-planned preview deploy is a NEW deployment (the gate
    // then checks that deployment), never a skip that would re-check a bundle golive did not replace.
    const intent = intentOf({
      project: await projectIntent(ctx, h.adapter),
      env: env ? `${env.id}#${env.intent ?? ''}` : '',
      live: live.join(','),
      previous: previous?.at,
    });
    const deploy = await deployStep(ctx, h.adapter, h.cap, { reasons, intent, live, previous, promotes: Boolean(rel) });
    const check = checkStep(ctx, h.adapter, {
      deploy: intent,
      coveredId: 'this-plan',
      covers: `the preview deployment ${DEPLOY_STEP} records`,
      project: await projectLabel(ctx, h.adapter),
      promotes: Boolean(rel),
    });
    return { steps: track(ctx, [deploy, check]), handoffs: [], warnings };
  },
};

/**
 * The rollback plan: re-point production at an earlier deployment from golive's own record. Planned
 * only while `release.rollback` is set AND such a deployment exists, so the flag is a request golive
 * carries out once and then reports as already done — nothing rolls back on its own, and no failed
 * check ever triggers one.
 */
async function rollbackPlan(ctx: Ctx): Promise<{ steps: Step[]; handoffs: HandoffItem[]; warnings: string[] }> {
  const none = (why: string): { steps: Step[]; handoffs: HandoffItem[]; warnings: string[] } => ({ steps: [], handoffs: [], warnings: [why] });
  if (!ctx.config.targets.includes('production')) return none('release.rollback is set, but `targets` in golive.yaml does not manage production: no rollback is planned');
  const h = await ready(ctx, 'hosting', 'release');
  if (!h) {
    return none(`release.rollback is set, but golive cannot re-point production on ${ctx.config.stack.hosting ?? 'the chosen hosting provider'}: the host is guided, not logged in, or exposes no release capability (a read of what production serves plus a re-point call)`);
  }
  const prod = readRecordedDeploy(ctx, 'production');
  if (!prod || prod.provider !== h.adapter.id) {
    return none(`release.rollback is set, but golive has no production deployment recorded on ${h.adapter.title}: a rollback only ever re-points production at a deployment golive itself made and recorded`);
  }
  const history = readDeployHistory(ctx);
  const target = previousProductionDeploy(history, prod);
  if (!target) {
    return none(`release.rollback is set, but golive's record of its own deployments (deployed:history, the last ${history.length}) holds no earlier production deployment to go back to`);
  }
  const released = readRelease(ctx);
  if (released?.kind === 'rollback' && released.displaced === target.id) {
    return none(`golive already rolled production back to ${released.id} at ${released.at}; it will not roll forward to ${target.id} on its own — review production in ${h.adapter.title}, then re-plan without release.rollback if nothing is needed`);
  }
  return { steps: track(ctx, [await rollbackStep(ctx, h.adapter, { target, prod })]), handoffs: [], warnings: [] };
}

// ── Preview deploy + its gate ─────────────────────────────────────────────────────────────────────

interface DeployFacts {
  /** Why this plan deploys a preview (the human approves these words). */
  reasons: string[];
  /** What this deploy picks up beyond its preview text (project, env writes, live sources). */
  intent: string;
  /** Preview env names a live-mode source fills: the deploy then needs --confirm-live. */
  live: string[];
  /** The preview deployment golive recorded before this plan, if any. */
  previous: RecordedDeploy | null;
  /** A promotion follows in the next approved plan (the opt-in is set and the host can re-point). */
  promotes: boolean;
}

/**
 * The create: deploy the working tree to the host's preview target and record the provider's own
 * identity for the deployment it made. The preview names what an approval covers (project, tree, env
 * target, the source project the preview shares with production, the URL the provider will report).
 */
async function deployStep(ctx: Ctx, adapter: Adapter, deploy: Deployer, facts: DeployFacts): Promise<Step> {
  const { reasons, intent, live, previous } = facts;
  return step({
    id: DEPLOY_STEP,
    title: `Deploy preview on ${adapter.title}`,
    kind: 'deploy',
    // A preview is a create: never `replayable`, and live only when a live-mode source fills a preview name.
    risk: { writes: true, ...(live.length ? { live: true } : {}) },
    dependsOn: deps(ctx, ['project:hosting', 'env:preview']),
    preview: [
      `deploy a preview on ${adapter.title}: ${reasons.join('; ')}`,
      `project: ${await projectLabel(ctx, adapter)}`,
      `source: ${await treeLine(ctx)}`,
      'env target: preview — the env:preview writes in this plan apply to the next preview deployment only, never to production',
      `data: ${await sourceLine(ctx)}`,
      `preview URL: ${adapter.title} reports this deployment's own URL and id, which golive records under deployed:preview:id${previous ? `; the preview it recorded before: ${previous.url} (${previous.at})` : ' (golive has not deployed a preview yet)'}`,
      ...(live.length
        ? [`live-mode values behind preview env names (${live.join(', ')}): a preview built with them can reach live payments or live data, so approving this deploy needs --confirm-live`]
        : []),
      ...(facts.promotes
        ? [`release.promote is set: the deployment this plan records and checks is the candidate the next approved plan promotes to production — golive names one exact deployment id there, and the provider reports that id only once this deploy has made it`]
        : []),
      facts.promotes
        ? 'nothing is promoted by this step: the next approved plan promotes the deployment this one records, and until then production is unchanged — golive never replays or replaces a preview'
        : 'nothing is promoted: this deploys a preview and checks it, and production is unchanged — golive never replays or replaces a preview',
    ],
    intent,
    verifyWith: [previewDeployCheck.id],
    async run(sctx) {
      const deployment = await deploy.deploy(sctx, 'preview');
      recordDeploy(sctx, adapter.id, 'preview', deployment);
      return { changes: [`deployed preview on ${adapter.title}: ${deployment.url}`] };
    },
  });
}

interface CheckFacts {
  /** The deploy step's intent when this plan deploys a preview, else null (nothing is deployed here). */
  deploy: string | null;
  /** Which deployment this check covers, as a re-plan can compare it: 'this-plan' or `<provider>|<id>`. */
  coveredId: string;
  /** The same, as the human reads it in the plan. */
  covers: string;
  /** The project golive links, as the human reads it. */
  project: string;
  /** The promote opt-in is set: the plan text says whether the promotion is in this plan or a later one. */
  promotes: boolean;
}

/**
 * The gate. It runs in two plans and stops a different thing in each:
 *   - after this plan's own preview deploy (the cut plan): it re-reads the deployment that deploy made
 *     and scans the bundle it serves. Nothing follows it there — the production deploy this plan emits
 *     comes earlier — so what it gates is the promotion, and the plan that promotes re-runs this check
 *     against the recorded deployment before it writes;
 *   - as the promotion's prerequisite: nothing is deployed here, it re-reads the preview deployment
 *     golive already recorded — the exact deployment `promote:production` would make production — and a
 *     red gate stops that plan before production changes.
 * Its edge on this plan's own deploy is declared, never filtered: `util.deps` keeps only step ids that
 * are already tracked, so building the gate before its deploy was tracked declared no prerequisite at
 * all, and `apply --only release:check` ran the check without the deployment it checks.
 * Its intent is that plus the previous attempt time, so a re-planned step runs again instead of being
 * skipped as "already done" (the `domain:verify` idiom).
 */
function checkStep(ctx: Ctx, adapter: Adapter, facts: CheckFacts): Step {
  const prev = ctx.state.get().steps[CHECK_STEP];
  // The production deploy(s) a cut plan emits before the preview steps (deploy.ts): the gate cannot stop
  // them, so its text says so instead of implying the plan's production work waits on it.
  const production = [...memo(ctx).steps.keys()].filter((id) => id.startsWith('deploy:production'));
  return step({
    id: CHECK_STEP,
    title: `Release check for the preview deployment on ${adapter.title}`,
    kind: 'wire',
    risk: { writes: false },
    dependsOn: facts.deploy ? [DEPLOY_STEP] : deps(ctx, ['project:hosting']),
    preview: [
      `check ${facts.covers} on ${adapter.title} (${facts.project}) without writing anything: the provider's own read (it exists, is ready, belongs to the project golive links, and is not the production deployment) and a scan of the HTML/JavaScript it serves for known credential patterns`,
      ...(facts.deploy ? [] : [`this check gates ${PROMOTE_STEP} in this plan: it re-reads the exact deployment that step would make production, before production changes`]),
      ...(facts.deploy && facts.promotes
        ? [`this check does not gate the promotion itself: ${PROMOTE_STEP} is a later plan's step (the provider reports a deployment's id only once the deployment is made) and that plan runs its own fresh ${CHECK_STEP} against the deployment this one records before any production write`]
        : []),
      ...(prev ? [`previous release check: ${prev.at}`] : []),
      facts.deploy
        ? `a failing check fails this step and stops the plan there — nothing follows the gate in this plan${production.length ? `, and the production deploy this plan emits earlier (${production.join(' and ')}) is not gated by it` : ''}. The failure is recorded, so a later plan does not treat this preview as checked`
        : `a failing check fails this step and stops the plan before ${PROMOTE_STEP}: that is the gate, and production stays as it is`,
    ],
    intent: intentOf({ deploy: facts.deploy ?? '', covered: facts.coveredId, previous: prev?.at }),
    async run() {
      return { changes: ['no writes: the checks re-read the preview deployment the provider reports and scan what it serves'] };
    },
    // The runner fails this step on any `fail` result here (skips and warns do not fail it), which is
    // what stops the plan before any promotion: `promote:production` depends on this step.
    verifyInline: async (vctx) => await Promise.all([runCheck(vctx, previewDeployCheck), runCheck(vctx, previewBundleCheck)]),
  });
}

// ── Production re-points: promotion and rollback ──────────────────────────────────────────────────

/** The deployment a re-point acts on: golive's own record of it, plus the env target it was built for. */
interface ReleaseTarget {
  provider: string;
  id: string;
  url: string;
  /** The env target the deployment was BUILT for (a promotion makes a preview deployment production). */
  built: Exclude<EnvTarget, 'development'>;
  /** When golive recorded it (ISO). */
  at: string;
}

interface PromoteFacts {
  /** The preview deployment golive recorded: the exact one this approval names. */
  target: RecordedDeploy;
  built: Exclude<EnvTarget, 'development'>;
  /** What golive recorded for production before this promotion, if anything. */
  production: RecordedDeploy | null;
  /** When golive's last release check ran, if state has a completed one. */
  checkedAt?: string;
  /** The check step's intent: a re-planned check re-runs the promotion too. */
  checkIntent: string;
  project: string;
}

/**
 * The promotion: point production at the checked preview deployment. It names that deployment by the
 * provider's own id (never a URL golive derived), what production serves now, the env target the
 * deployment was built with, and the check that gates it — so the approval is the binding and no
 * separate confirmation flag exists. `run` re-reads both sides around the write (see releaseRun).
 */
function promoteStep(ctx: Ctx, adapter: Adapter, facts: PromoteFacts): Step {
  const { target, built, production } = facts;
  return step({
    id: PROMOTE_STEP,
    title: `Promote the checked preview deployment to production on ${adapter.title}`,
    kind: 'deploy',
    // A production re-point: a real write, no extra category flag (the plan names the exact deployment
    // and depends on the gate), never `replayable` and never a deletion.
    risk: { writes: true },
    // The gate is this step's prerequisite by construction, like the gate's own deploy edge: `util.deps`
    // would drop it if the gate were not tracked yet, and a promotion without its check is no release.
    dependsOn: [CHECK_STEP, ...deps(ctx, ['project:hosting'])],
    preview: [
      `promote ${target.provider} deployment ${target.id} to production: ${target.url} (recorded by golive ${target.at}) becomes what ${adapter.title} serves publicly`,
      `project: ${facts.project}`,
      `that deployment was built for the ${built} env target and keeps the env it was built with: a promotion re-points production, it does not rebuild or rewrite anything`,
      `production before this promotion: ${production ? `${production.provider} deployment ${production.id} (${production.url}, recorded by golive ${production.at})` : 'golive recorded no production deployment; this step reads what the provider says it serves now'}`,
      `gated by ${CHECK_STEP} in this plan: the provider's own read of that exact deployment and a credential scan of the HTML/JavaScript it serves${facts.checkedAt ? ` (golive's last release check ran ${facts.checkedAt})` : ''} — a failing check fails that step and stops the plan before production changes`,
      `before writing, this step re-reads the deployment and what ${adapter.title} serves as production; after writing it re-reads production and records what it serves now (check ${productionReleaseCheck.id})`,
      `production will change: the app's production URL is served by that deployment. No data, DNS, payments or email is touched, and no new deployment is built`,
      `golive promotes only a deployment it created and recorded: one ${adapter.title} built from a Git push, a pull request or its dashboard is not in golive's record and stays with that provider`,
    ],
    intent: intentOf({
      release: 'promote',
      target: `${target.provider}|${target.id}`,
      production: production ? `${production.provider}|${production.id}` : 'none',
      check: facts.checkIntent,
    }),
    verifyWith: [productionReleaseCheck.id],
    run: releaseRun('promote', adapter, { provider: target.provider, id: target.id, url: target.url, built, at: target.at }),
  });
}

interface RollbackFacts {
  /** The earlier production deployment golive recorded: this approval names it exactly. */
  target: DeploymentRecord;
  /** What golive recorded production serves now (what this rollback replaces). */
  prod: RecordedDeploy;
}

/**
 * The rollback: point production back at an earlier deployment golive recorded for production. Its
 * target comes from golive's own record only, so a deployment from a dashboard, a Git push or a pull
 * request is never rolled back to — the plan says where such a deployment stays. Deliberately neither
 * `destroy` (nothing is deleted, and that exemption is for golive's own removals) nor `replayable`: a
 * production re-point must keep the cross-release reconciliation stop.
 */
async function rollbackStep(ctx: Ctx, adapter: Adapter, facts: RollbackFacts): Promise<Step> {
  const { target, prod } = facts;
  return step({
    id: ROLLBACK_STEP,
    title: `Roll production back on ${adapter.title}`,
    kind: 'deploy',
    risk: { writes: true },
    dependsOn: deps(ctx, ['project:hosting']),
    preview: [
      `roll production back to ${target.provider} deployment ${target.id}: ${target.url} (built for the ${target.target} env target, recorded by golive ${target.at}) becomes what ${adapter.title} serves again`,
      `project: ${await projectLabel(ctx, adapter)}`,
      `production now serves ${prod.provider} deployment ${prod.id} (${prod.url}, recorded by golive ${prod.at}) — this rollback replaces it`,
      `the target comes from golive's own record (deployed:history): golive rolls production back only to a deployment it created and recorded, and a deployment from a dashboard, a Git push or a pull request is never a target`,
      `before writing, this step re-reads that deployment and what ${adapter.title} serves as production; after writing it re-reads production and records what it serves now (check ${productionReleaseCheck.id}). Nothing is rebuilt, no env is rewritten and nothing is deleted — a rollback re-points production`,
      `production will change: the app's production URL serves an earlier deployment again. No data, DNS, payments or email is touched`,
      `this step is a production re-point, so it is neither replayable nor a deletion: if its record belongs to an older release, apply refuses to resume it instead of re-pointing production from a stale approval`,
      `never automatic: golive plans a rollback only while release.rollback is set, and only an approved plan run performs one — a failed check never triggers a rollback`,
    ],
    intent: intentOf({ release: 'rollback', target: `${target.provider}|${target.id}`, production: `${prod.provider}|${prod.id}` }),
    verifyWith: [productionReleaseCheck.id],
    run: releaseRun('rollback', adapter, { provider: target.provider, id: target.id, url: target.url, built: target.target, at: target.at }),
  });
}

/** `<provider>|<deployment id>` shortened for evidence lines that only need to name the deployment. */
const shortId = (provider: string, id: string): string => `${provider} ${id}`;

/**
 * The write both re-points share: re-read the target deployment and what production serves BEFORE the
 * write, refuse rather than act blind when the provider cannot answer either, re-point, then re-read
 * production and prove what it serves now. A provider that reports the deployment is already serving
 * is a no-op (nothing is written, and golive records no release it did not perform); a write the
 * provider does not confirm fails the step with nothing recorded.
 */
function releaseRun(kind: 'promote' | 'rollback', adapter: Adapter, target: ReleaseTarget): Step['run'] {
  const verb = kind === 'promote' ? 'promote' : 'roll';
  const done = kind === 'promote' ? 'promoted' : 'rolled production back to';
  return async (sctx): Promise<StepResult> => {
    const host = cap(sctx, 'hosting', 'release');
    if (!host) {
      throw new Error(`${adapter.title} exposes no release capability here: golive cannot re-read what production serves or point it at a deployment, so it will not ${verb} blind.`);
    }
    if (!host.promote) {
      throw new Error(`${adapter.title} can read its deployments but exposes no call to point production at one, so golive cannot ${verb}: nothing was written.`);
    }
    // 1. The target: the exact deployment the approval named, re-read from the provider.
    const deployment = await host.read(sctx, target.id);
    if (!deployment) {
      throw new Error(`${adapter.title} no longer has deployment ${shortId(target.provider, target.id)} (${target.url}), so there is nothing to ${verb}: nothing was written. Re-plan for a deployment the provider still serves.`);
    }
    if (deployment.id !== target.id) {
      throw new Error(`${adapter.title} answered with deployment ${deployment.id} instead of ${target.id}; golive will not ${verb} a deployment the approval did not name. Nothing was written.`);
    }
    if (!deployment.ready) {
      throw new Error(`${adapter.title} reports deployment ${deployment.id} as not ready, so it cannot serve production: nothing was written.`);
    }
    // 2. What production serves now: without this read golive cannot say what the write replaces.
    const before = await host.production(sctx);
    if (!before) {
      throw new Error(`${adapter.title} reports no deployment for production, so golive cannot read what this ${verb} would replace: nothing was written. Deploy production first (the deploy:production step), then re-plan.`);
    }
    if (before.id === deployment.id) {
      return { changes: [`${adapter.title} already serves deployment ${deployment.id} as production (read again now); nothing was written${kind === 'rollback' ? ' — production is already where this rollback would put it' : ''}`] };
    }
    // 3. The write, then the provider's own read of what production serves now.
    await host.promote(sctx, deployment.id);
    const after = await host.production(sctx);
    if (!after || after.id !== deployment.id) {
      throw new Error(`${adapter.title} did not report deployment ${deployment.id} as what production serves after the write (it reports ${after ? after.id : 'no deployment'}); golive recorded nothing and will not repeat the write blindly — check ${adapter.title}'s dashboard before re-running.`);
    }
    recordRelease(sctx, {
      kind,
      provider: adapter.id,
      id: deployment.id,
      url: after.url ?? target.url,
      target: target.built,
      displaced: before.id,
    });
    return {
      changes: [
        `${done} ${shortId(adapter.id, deployment.id)} as production: ${after.url ?? target.url}`,
        `${adapter.title} reported production serving ${before.id} before the write and ${after.id} after it`,
      ],
    };
  };
}

// ── Shared plan text ─────────────────────────────────────────────────────────────────────────────

/** The env target a recorded deployment was built for, from golive's own history. */
function builtForDeployment(ctx: Ctx, deployment: RecordedDeploy): Exclude<EnvTarget, 'development'> {
  // Called only for the deployment recorded under `deployed:preview:id`: its history record keeps the
  // target that deploy was made for, and a state written before the history existed means preview.
  return readDeployHistory(ctx).find((e) => e.provider === deployment.provider && e.id === deployment.id)?.target ?? 'preview';
}

/** The project this deploys to, as the human should read it. */
async function projectLabel(ctx: Ctx, adapter: Adapter): Promise<string> {
  const linker = adapter.capabilities.project;
  const current = linker ? await linker.current(ctx).catch(() => null) : null;
  if (current) return `${adapter.title} project ${current.name} (${current.id})`;
  return memo(ctx).pendingProjects.has('hosting')
    ? `${adapter.title} project this plan creates or selects (see project:hosting)`
    : `${adapter.title} project is not linked yet (this plan's project:hosting step decides it)`;
}

/**
 * The working tree this deploys: both hosts build what is on disk (Vercel `vercel deploy`, Netlify
 * `netlify deploy`), not a commit, so the plan names the branch when the local git can report one.
 */
async function treeLine(ctx: Ctx): Promise<string> {
  const where = 'the current working tree on disk, uncommitted changes included (golive deploys no commit)';
  let branch: string | null = null;
  try {
    const r = await ctx.exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: ctx.cwd, timeoutMs: 5_000 });
    branch = r.code === 0 ? (r.stdout.trim().split('\n')[0] ?? '') || null : null;
  } catch {
    branch = null;
  }
  if (branch === 'HEAD') return `${where}, on a detached HEAD`;
  return branch ? `${where}, on branch ${branch}` : `${where}; golive could not read the git branch`;
}

/**
 * Whether the preview shares production's sources. golive fills env from ONE project per axis for every
 * target (src/links/env.ts), so the preview deployment reads and writes the same database and auth
 * project as production; the payment keys are the per-target values (by mode).
 */
async function sourceLine(ctx: Ctx): Promise<string> {
  const sources: Adapter[] = [];
  for (const axis of ['db', 'auth'] as const) {
    const s = await ready(ctx, axis, 'outputs');
    if (s && !sources.some((a) => a.id === s.adapter.id)) sources.push(s.adapter);
  }
  const parts: string[] = [];
  if (!sources.length) parts.push('no database/auth provider is chosen, so there is no shared source project to report');
  else {
    const named = await Promise.all(sources.map(async (a) => `${a.title} ${(await projectIdentity(ctx, a, { planning: true })) ?? '(project unreadable now)'}`));
    parts.push(`golive fills the preview env from the same ${named.join(' and ')} that production uses (golive has one project per axis for the whole app), so a preview reads and writes the same database and auth project as production`);
  }
  const pay = await ready(ctx, 'payments', 'outputs');
  if (pay) parts.push(`payments keys in preview come from ${pay.adapter.title} ${modeFor(ctx.config, 'preview')} mode`);
  return parts.join('; ');
}

/**
 * Mode a recorded env source names. Payment sources are `<output key>|<provider>|<mode>|<fingerprint>|
 * <account>` (src/links/payments.ts); every other source shape carries no mode (src/core/drift.ts reads
 * the same five fields).
 */
function sourceMode(value: string): Mode | null {
  const parts = value.split('|');
  if (parts.length !== 5 || !/^stripe\.(secretKey|publishableKey)$/.test(parts[0] ?? '')) return null;
  return parts[2] === 'test' || parts[2] === 'live' ? parts[2] : null;
}

/** `<name>=<source>` entries a step's intent names for a live-mode source. */
function liveWritesIn(intent: string | undefined): string[] {
  const part = intent?.split(';').find((p) => p.startsWith('write='));
  if (!part) return [];
  const out: string[] = [];
  for (const entry of part.slice('write='.length).split(',')) {
    const eq = entry.indexOf('=');
    if (eq > 0 && sourceMode(entry.slice(eq + 1)) === 'live') out.push(entry.slice(0, eq));
  }
  return out;
}

/**
 * Preview env names a LIVE-mode source fills — recorded already, or written by a step of this plan.
 * A preview built with live keys can reach live payments or live data, so its deploy needs
 * `--confirm-live` (the same bar `Risk.live` sets for production).
 */
function livePreviewNames(ctx: Ctx, planned: Step[]): string[] {
  const names = new Set<string>();
  for (const [key, value] of Object.entries(ctx.state.get().resources)) {
    const m = /^env:(.+)@preview$/.exec(key);
    if (m && sourceMode(value) === 'live') names.add(m[1]!);
  }
  for (const s of planned) {
    if (!s.id.endsWith(':preview')) continue;
    for (const name of liveWritesIn(s.intent)) names.add(name);
  }
  return [...names].sort();
}
