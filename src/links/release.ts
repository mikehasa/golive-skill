import type { Link } from '../core/plan.js';
import type { Adapter, Ctx, Deployer, EnvTarget, Mode, Step } from '../core/types.js';
import { modeFor } from '../core/config.js';
import { runCheck } from '../core/runner.js';
import { previewBundleCheck, previewDeployCheck } from '../checks/release.js';
import { deps, intentOf, memo, projectIdentity, projectIntent, ready, readRecordedDeploy, recordDeploy, step, track, type RecordedDeploy } from './util.js';

const DEPLOY_STEP = 'preview:deploy';
const CHECK_STEP = 'release:check';

/**
 * Preview deployments and the release check that gates them. Planned only when the human opted in —
 * `release.preview: true` in golive.yaml AND `targets` managing preview — so a stack that did not opt
 * in produces exactly the plan it produced before this link existed.
 *
 * A preview is a CREATE: `preview:deploy` is never `replayable`, always makes a new deployment and
 * records the provider's own identity for it (`deployed:preview:id`, the same shape production
 * records). `release:check` writes nothing: it re-reads what the provider says about that deployment
 * and scans the bundle it serves, running those checks inline, so a failing check fails the step and
 * stops the plan. That check is the gate. Promoting a checked preview to production is a later slice:
 * a promotion step would depend on `release:check`.
 */
export const releaseLink: Link = {
  id: 'release',
  async plan(ctx) {
    if (ctx.config.release?.preview !== true) return null;
    if (!ctx.config.targets.includes('preview')) {
      return { steps: [], handoffs: [], warnings: ['release.preview is set, but `targets` in golive.yaml does not manage preview: no preview deployment is planned'] };
    }
    const h = await ready(ctx, 'hosting', 'deploy');
    if (!h) {
      return { steps: [], handoffs: [], warnings: [`release.preview is set, but golive cannot deploy a preview on ${ctx.config.stack.hosting ?? 'the chosen hosting provider'}: the host is guided, not logged in, or exposes no deploy capability`] };
    }

    const m = memo(ctx);
    const env = m.steps.get('env:preview');
    const steps = ctx.state.get().steps;
    const previous = readRecordedDeploy(ctx, 'preview');
    const reasons: string[] = [];
    if (env) reasons.push(`the preview env changes in this plan (${env.id}) and only reaches a new deployment`);
    if (steps[DEPLOY_STEP]?.status === 'failed') reasons.push(`the last preview deploy failed (${steps[DEPLOY_STEP]!.at})`);
    if (steps[CHECK_STEP]?.status === 'failed') reasons.push(`the last release check failed (${steps[CHECK_STEP]!.at}); a new preview gets a fresh check`);
    if (!previous) reasons.push('golive has never deployed a preview for this app');
    if (!reasons.length) return null;

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
    const deploy = await deployStep(ctx, h.adapter, h.cap, { reasons, intent, live, previous });
    const check = checkStep(ctx, h.adapter, { intent, project: await projectLabel(ctx, h.adapter) });
    return { steps: track(ctx, [deploy, check]), handoffs: [] };
  },
};

interface DeployFacts {
  /** Why this plan deploys a preview (the human approves these words). */
  reasons: string[];
  /** What this deploy picks up beyond its preview text (project, env writes, live sources). */
  intent: string;
  /** Preview env names a live-mode source fills: the deploy then needs --confirm-live. */
  live: string[];
  /** The preview deployment golive recorded before this plan, if any. */
  previous: RecordedDeploy | null;
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
      'nothing is promoted: this deploys a preview and checks it, and production is unchanged — golive never replays or replaces a preview',
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

/**
 * The gate: re-read the preview deployment the provider reports and scan the bundle it serves, running
 * both checks inline so a failure fails this step and stops the plan. Its intent is the deploy step's
 * intent plus the previous attempt time, so a re-planned step runs again instead of being skipped as
 * "already done" (the `domain:verify` idiom).
 */
function checkStep(ctx: Ctx, adapter: Adapter, facts: { intent: string; project: string }): Step {
  const prev = ctx.state.get().steps[CHECK_STEP];
  return step({
    id: CHECK_STEP,
    title: `Release check for the preview deployment on ${adapter.title}`,
    kind: 'wire',
    risk: { writes: false },
    dependsOn: deps(ctx, [DEPLOY_STEP]),
    preview: [
      `check the preview deployment ${DEPLOY_STEP} records on ${adapter.title} (${facts.project}) without writing anything: the provider's own read (it exists, is ready, belongs to the project golive links, and is not the production deployment) and a scan of the HTML/JavaScript it serves for known credential patterns`,
      ...(prev ? [`previous release check: ${prev.at}`] : []),
      'a failing check fails this step and stops the plan: that is the gate. Promoting a checked preview to production is not part of this plan',
    ],
    intent: intentOf({ deploy: facts.intent, previous: prev?.at }),
    async run() {
      return { changes: ['no writes: the checks re-read the preview deployment the provider reports and scan what it serves'] };
    },
    // The runner fails this step on any `fail` result here (skips and warns do not fail it), which is
    // what stops the plan before any promotion: a promotion step would depend on release:check.
    verifyInline: async (vctx) => await Promise.all([runCheck(vctx, previewDeployCheck), runCheck(vctx, previewBundleCheck)]),
  });
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
