import type { Link } from '../core/plan.js';
import type { Adapter, Ctx, EnvStore, EnvTarget, HandoffItem, OutputKey, ProjectCreateTarget, ProjectLinker, ProjectRef, Step } from '../core/types.js';
import type { EnvMapping } from '../core/envmap.js';
import { fingerprint } from '../core/secret.js';
import { repoIdentity } from '../core/repo.js';
import { SentryTeamChoiceError, monitoringOf, regionOf, sentryApiHost, type MonitoringProvider } from '../adapters/sentry.js';
import { authOf, decideEnv, deps, envPreview, errMsg, intentOf, mappedEnv, memo, observeNames, projectIntent, ready, step, track, verifyEnvWritten, writeEnv, writesProduction } from './util.js';

type Target = Exclude<EnvTarget, 'development'>;

/** The semantic key this link fills. It is PUBLIC: the DSN ships in the browser. */
const KEY_NAMES: OutputKey[] = ['sentry.dsn'];
/** Memo/plan identity for a project this plan creates: its id does not exist until the step runs. */
const PENDING = 'pending';

/**
 * Monitoring provider → host env: the Sentry project the app reports errors to, and the app-facing
 * env name that carries its public DSN.
 *
 * The project is a resource golive may create (that is what makes it a managed one: it gets a creation
 * marker, and teardown deletes only what that marker names), so this link plans on the `monitoring`
 * axis only when `stack.monitoring` names an automated adapter with a project surface AND a
 * store/read-back surface — today Sentry. Adopting an already linked project always beats creating
 * one; a create is only planned when nothing is linked, configured or same-named, and it names the
 * organization, region and team it would use (never a guessed one).
 *
 * The DSN is NOT a server secret: Sentry designs it to be embedded in a client bundle (see
 * docs/PROVIDERS.md), so it is written as a plain, non-sensitive host variable, exactly the way the
 * Supabase anon/publishable key is. `sentry-ingest` proves the wiring from outside (a synthetic event
 * plus the provider's own event read); it cannot see the app's own code, so it never closes the
 * app-code handoff below — that one ends when the app reads the name golive fills.
 */
export const sentryLink: Link = {
  id: 'sentry',
  async plan(ctx) {
    const configured = ctx.config.stack.monitoring;
    if (!configured) return null;
    const r = await ready(ctx, 'monitoring', 'project');
    // A guided monitoring provider stays guided (the accounts link carries the `guided:<axis>`
    // handoff), and an unusable login is named by the accounts link too: neither is repeated here.
    if (!r) return null;
    const adapter = r.adapter;
    const provider = monitoringOf(adapter);
    // A monitoring adapter with the other capture/read-back shape is owned by its own link; the
    // analytics link warns for an adapter with no surface at all, so nothing is said twice here.
    if (!provider) return null;

    const warnings: string[] = [];
    const handoffs: HandoffItem[] = [];
    const planned = await planProject(ctx, adapter, r.cap, warnings);
    if (!planned.project) return { steps: [], handoffs: planned.handoffs, warnings };
    // Registered before the env steps are planned: `deps()` keeps only ids this plan has already
    // tracked, so the env steps can only declare the project step as a prerequisite once it is here.
    const steps: Step[] = track(ctx, planned.steps);

    const mapped = mappedEnv(ctx).filter((m) => KEY_NAMES.includes(m.key));
    const host = await ready(ctx, 'hosting', 'env');
    if (!mapped.length) {
      // The app reads none of the names golive would fill: the wiring waits for the app code, and this
      // non-blocking handoff carries that task (it closes when the app reads the name).
      handoffs.push(snippetHandoff(adapter, planned.project));
    } else if (!host) {
      for (const target of ctx.config.targets) handoffs.push(envHandoff(ctx, adapter, mapped, target));
    } else {
      for (const target of ctx.config.targets) {
        const s = await envStep(ctx, adapter, provider, r.cap, planned, host.adapter, host.cap, target, mapped);
        if (s) steps.push(s);
      }
    }
    return { steps: track(ctx, steps, { needsRedeploy: writesProduction }), handoffs, warnings };
  },
};

// ── The project ─────────────────────────────────────────────────────────────────────────────────

const scopeOf = (p: ProjectRef): string => (p.scope ? ` in ${p.scope.kind} ${p.scope.name ? `${p.scope.name} (${p.scope.id})` : p.scope.id}` : '');
const sameScope = (a: ProjectRef['scope'], b: ProjectRef['scope']): boolean => a?.kind === b?.kind && a?.id === b?.id;
const sameTarget = (a: ProjectCreateTarget, b: ProjectCreateTarget): boolean => sameScope(a.scope, b.scope) && a.region === b.region && a.team === b.team;
const nameList = (refs: ProjectRef[]): string[] => [...new Set(refs.map((c) => `${c.name} (${c.id})`))].sort();

interface Planned {
  project: ProjectRef | null;
  /** The project does not exist yet: this plan's own create step makes it. */
  created: boolean;
  steps: Step[];
  handoffs: HandoffItem[];
}

/**
 * Which Sentry project the app reports errors to. An already linked project is pinned (a zero-write
 * step naming the destination, so the approved plan id covers it); a configured or same-named one is
 * selected; only then does golive create one, named from the repository — and only when the team the
 * create needs is unambiguous (one team, or `sentry.team` names one), else a handoff says so.
 */
async function planProject(ctx: Ctx, adapter: Adapter, linker: ProjectLinker, warnings: string[]): Promise<Planned> {
  const account = await accountLine(ctx, adapter);
  const chosen = ctx.config.projects?.monitoring;
  let current = await linker.current(ctx).catch((e: unknown) => {
    throw new Error(`reading the ${adapter.title} project linked to this repo failed: ${errMsg(e)}`);
  });
  if (current) {
    if (linker.resolve) current = await linker.resolve(ctx, current.id);
    const fromConfig = chosen !== undefined && (chosen === current.id || chosen === current.name);
    if (chosen !== undefined && !fromConfig) {
      warnings.push(
        `golive.yaml projects.monitoring is "${chosen}", but this repo is already linked to ${adapter.title} project ${current.name} (${current.id}); golive uses the linked one. To switch, remove the recorded project (or the golive.yaml entry), then run \`plan\` again.`,
      );
    }
    return { project: current, created: false, steps: [pinStep(adapter, linker, current, fromConfig ? 'golive.yaml projects.monitoring' : 'the project already linked to this repo (golive state)', account)], handoffs: [] };
  }
  if (chosen) {
    const resolved = linker.resolve ? await linker.resolve(ctx, chosen) : undefined;
    return { project: resolved ?? { id: chosen, name: chosen }, created: false, steps: [selectStep(adapter, linker, resolved?.id ?? chosen, resolved?.name ?? chosen, account, resolved)], handoffs: [] };
  }

  const identity = await repoIdentity(ctx);
  // A failed inventory is not an empty account: never turn a refusal into approval to create.
  const candidates = await linker.candidates(ctx).catch((e: unknown) => {
    throw new Error(`listing ${adapter.title} project candidates failed: ${errMsg(e)}`);
  });
  const same = candidates.find((c) => c.name.toLowerCase() === identity.name.toLowerCase());
  if (same) {
    const resolved = linker.resolve ? await linker.resolve(ctx, same.id) : same;
    return { project: resolved, created: false, steps: [selectStep(adapter, linker, resolved.id, resolved.name, account, resolved)], handoffs: [] };
  }
  if (linker.create) {
    let target: ProjectCreateTarget | undefined;
    if (linker.creationTarget) {
      try {
        target = await linker.creationTarget(ctx);
      } catch (e) {
        // A create that cannot name its team is the human's choice, not golive's: hand it over with
        // the teams it saw instead of failing the whole plan.
        if (e instanceof SentryTeamChoiceError) return { project: null, created: false, steps: [], handoffs: [teamHandoff(adapter, e)] };
        throw new Error(`reading the ${adapter.title} creation destination failed: ${errMsg(e)}`);
      }
    }
    const listed = nameList(candidates);
    if (listed.length) {
      warnings.push(
        `${adapter.title} already has ${listed.length} project(s) in this organization (${listed.slice(0, 10).join(', ')}${listed.length > 10 ? ', …' : ''}). golive plans to create one more; when the plan refuses a new project, set projects.monitoring to the one to use and run \`plan\` again.`,
      );
    }
    return { project: { id: '', name: identity.name }, created: true, steps: [createStep(adapter, linker, identity.name, listed, account, target)], handoffs: [] };
  }
  return {
    project: null,
    created: false,
    steps: [],
    handoffs: [
      {
        id: 'sentry:project',
        why: `golive doesn't create ${adapter.title} projects on this account, and none is linked to this repo.`,
        action: `Choose (or create) the ${adapter.title} project for this app in its dashboard, then set \`projects.monitoring\` in golive.yaml to its id, slug or name and run \`golive plan\` again.`,
        blocking: true,
      },
    ],
  };
}

/** "which account" line from the provider's own auth status (never a credential). */
async function accountLine(ctx: Ctx, adapter: Adapter): Promise<string | undefined> {
  const via = (await authOf(ctx, adapter)).via;
  return via ? `${adapter.title} access: ${via}` : undefined;
}

function destination(adapter: Adapter, action: 'pin' | 'select' | 'create', project: { id?: string; name: string }, scope: ProjectRef['scope'], account?: string, region?: string) {
  return { axis: 'monitoring' as const, provider: adapter.id, providerTitle: adapter.title, action, project, ...(scope ? { scope } : {}), ...(region ? { region } : {}), ...(account ? { access: account } : {}) };
}

/** Zero-write step naming the destination of this plan's writes; re-reads it before pinning it in state. */
function pinStep(adapter: Adapter, linker: ProjectLinker, planned: ProjectRef, source: string, account: string | undefined): Step {
  return step({
    id: 'sentry:project',
    title: `Use ${adapter.title} project ${planned.name} for monitoring`,
    kind: 'provision',
    risk: { writes: false },
    preview: [`monitoring: ${adapter.title} project ${planned.name} (${planned.id})${scopeOf(planned)}, from ${source}; every ${adapter.title} write in this plan goes there`, ...(account ? [account] : [])],
    intent: intentOf({ pin: `${adapter.id}:${planned.id}` }),
    destination: destination(adapter, 'pin', { id: planned.id, name: planned.name }, planned.scope, account),
    async run(sctx) {
      let now = await linker.current(sctx);
      if (now && linker.resolve) now = await linker.resolve(sctx, now.id);
      if (!now || now.id !== planned.id || !sameScope(now.scope, planned.scope)) {
        throw new Error(`the ${adapter.title} monitoring project changed since the plan was approved (planned ${planned.name} (${planned.id}), now ${now ? `${now.name} (${now.id})` : 'none'}); nothing was written. Run \`plan\` again and re-approve.`);
      }
      const p = await linker.select(sctx, planned.id);
      if (p.id !== planned.id || (planned.scope && !sameScope(p.scope, planned.scope))) throw new Error(`the ${adapter.title} project destination changed; run \`plan\` again and re-approve before any remote writes.`);
      return { changes: [`using ${adapter.title} project ${p.name} (${p.id}) for monitoring (pinned in golive state)`] };
    },
  });
}

function selectStep(adapter: Adapter, linker: ProjectLinker, idOrName: string, label: string, account: string | undefined, planned?: ProjectRef): Step {
  return step({
    id: 'sentry:project',
    title: `Use existing ${adapter.title} project ${label}`,
    kind: 'provision',
    risk: { writes: true },
    preview: [`Use existing ${adapter.title} project ${label}${planned ? ` (${planned.id})${scopeOf(planned)}` : ''} for monitoring (links it in golive state; nothing is changed at ${adapter.title})`, ...(account ? [account] : [])],
    intent: intentOf({ select: `${adapter.id}:${idOrName}` }),
    destination: destination(adapter, 'select', { ...(planned ? { id: planned.id } : {}), name: label }, planned?.scope, account),
    async run(sctx) {
      if (planned && linker.resolve) {
        const now = await linker.resolve(sctx, planned.id);
        if (now.id !== planned.id || !sameScope(now.scope, planned.scope)) throw new Error(`the ${adapter.title} project destination changed; run \`plan\` again and re-approve.`);
      }
      const p = await linker.select(sctx, idOrName);
      if (planned && (p.id !== planned.id || (planned.scope && !sameScope(p.scope, planned.scope)))) throw new Error(`the ${adapter.title} project destination changed; run \`plan\` again and re-approve before any remote writes.`);
      return { changes: [`linked ${adapter.title} project ${p.name} (${p.id}) for monitoring`] };
    },
  });
}

/** What a create destination reads as in a preview: organization, team and region, never a guess. */
function createScope(target: ProjectCreateTarget | undefined): string {
  if (!target) return '';
  const where = ` in ${target.scope.kind} ${target.scope.name ? `${target.scope.name} (${target.scope.id})` : target.scope.id}`;
  return `${where}${target.team ? ` → team ${target.team}` : ''}${target.region ? ` (${target.region})` : ''}`;
}

function createStep(adapter: Adapter, linker: ProjectLinker, name: string, listed: string[], account: string | undefined, target?: ProjectCreateTarget): Step {
  return step({
    id: 'sentry:project',
    title: `Create ${adapter.title} project ${name}`,
    kind: 'provision',
    risk: { writes: true },
    preview: [
      `Create ${adapter.title} project ${name} for monitoring${createScope(target)} (no existing project matched this repo)`,
      ...(listed.length ? [`existing ${adapter.title} projects that could be used instead: ${listed.slice(0, 10).join(', ')}${listed.length > 10 ? ', …' : ''} — ask the human; to use one, set \`projects.monitoring\` in golive.yaml and run \`plan\` again`] : []),
      ...(account ? [account] : []),
    ],
    intent: intentOf({ create: `${adapter.id}:${name}` }),
    destination: destination(adapter, 'create', { name }, target?.scope, account, target?.region),
    async run(sctx) {
      try {
        if (target && linker.creationTarget && !sameTarget(target, await linker.creationTarget(sctx))) {
          throw new Error('the destination organization, team or region changed; run `plan` again and re-approve. Nothing was created.');
        }
        const p = await linker.create!(sctx, name, target);
        if (target && !sameScope(p.scope, target.scope)) throw new Error('the provider returned an unexpected project destination; inspect the created resource before continuing.');
        return { changes: [`created ${adapter.title} project ${p.name} (${p.id}) for monitoring`] };
      } catch (e) {
        throw new Error(`creating ${adapter.title} project ${name} failed: ${errMsg(e)}`);
      }
    },
  });
}

/** The create the human must disambiguate: several teams, none chosen. Never guessed. */
function teamHandoff(adapter: Adapter, e: SentryTeamChoiceError): HandoffItem {
  const listed = e.teams.map((t) => `${t.name ?? t.slug} (${t.slug})`).join(', ');
  return {
    id: 'sentry:project',
    why: `${adapter.title} cannot create the project without a team: ${e.message}`,
    action: e.teams.length
      ? `Set \`sentry.team: <slug>\` in golive.yaml to one of ${listed} and run \`golive plan\` again — or create the project in Sentry yourself and set \`projects.monitoring\` to it. golive never picks a team for you.`
      : `Create a team in Sentry and set \`sentry.team\` in golive.yaml, then run \`golive plan\` again — or create the project in Sentry yourself and set \`projects.monitoring\` to it.`,
    blocking: true,
  };
}

// ── The app-facing env ──────────────────────────────────────────────────────────────────────────

interface DsnIdentity {
  /** The public DSN's fingerprint (secret-free: it is what a plan identity may carry). */
  fingerprint: string;
  /** `<project id>|<dsn fp>` — what a managed name's recorded source compares against. */
  identity: string;
}

/**
 * Read the project's public DSN now, so its fingerprint can enter the plan (a rotated DSN then
 * rewrites a managed name) without the value itself ever reaching a preview, an intent or state. A
 * project this plan creates has no id yet: its identity is `pending`, and the DSN is read at run
 * time, after the create step recorded the project in state.
 */
async function dsnIdentity(ctx: Ctx, provider: MonitoringProvider, project: ProjectRef): Promise<DsnIdentity> {
  const cached = ctx.cache.get(`sentry.dsn:${project.id}`);
  if (cached) return cached as DsnIdentity;
  const dsn = await provider.dsn(ctx, project.id);
  const out: DsnIdentity = { fingerprint: fingerprint(dsn), identity: `${project.id}|${fingerprint(dsn)}` };
  ctx.cache.set(`sentry.dsn:${project.id}`, out);
  return out;
}

async function envStep(
  ctx: Ctx,
  adapter: Adapter,
  provider: MonitoringProvider,
  linker: ProjectLinker,
  planned: Planned,
  hostAdapter: Adapter,
  env: EnvStore,
  target: Target,
  mapped: EnvMapping[],
): Promise<Step | null> {
  const project = planned.project!;
  let approved: DsnIdentity;
  if (planned.created) {
    approved = { fingerprint: PENDING, identity: PENDING };
  } else {
    try {
      approved = await dsnIdentity(ctx, provider, project);
    } catch (e) {
      throw new Error(`reading the ${adapter.title} project DSN for ${target} failed: ${errMsg(e)}`);
    }
  }
  const sourceOf = (key: OutputKey): string =>
    key === 'sentry.dsn' && planned.created ? `sentry.dsn|${adapter.id}|${PENDING}|${project.name}` : `sentry.dsn|${adapter.id}|${approved.identity}`;
  const byName = new Map(mapped.map((m) => [m.name, m.key] as const));
  const present = await observeNames(ctx, env, target, memo(ctx).pendingProjects.has('hosting'));
  const decision = decideEnv(ctx, target, [...byName.keys()], present, (n) => sourceOf(byName.get(n)!));
  if (!decision.write.length) return null;

  let written: string[] = [];
  return step({
    id: `sentry:env:${target}`,
    title: `Set ${adapter.title} monitoring env for ${target} on ${hostAdapter.title}`,
    kind: 'wire',
    risk: { writes: true },
    dependsOn: deps(ctx, ['sentry:project', 'project:hosting']),
    preview: [
      ...envPreview(decision, (n) => `sentry.dsn from ${adapter.title} project ${project.name || project.id}${planned.created ? ' (created by this plan)' : ''} (public: the DSN ships in the browser by design)`),
      `writes the ${adapter.title} project's public DSN (client key); no server secret is written`,
    ],
    intent: intentOf({ host: await projectIntent(ctx, hostAdapter), project: planned.created ? `${adapter.id}:create:${project.name}` : `${adapter.id}:${project.id}`, dsn: approved.fingerprint, write: decision.write.map((w) => `${w.name}=${sourceOf(byName.get(w.name)!)})`) }),
    async run(runCtx) {
      // Re-read the project and its DSN now: the value approved by fingerprint must still be the
      // value written, and a project this plan created exists only since its own step ran.
      const now = planned.created ? await linker.current(runCtx) : project;
      if (!now) throw new Error(`the ${adapter.title} project this plan created could not be read back; no env write was performed. Re-run \`golive plan\`.`);
      const dsn = await provider.dsn(runCtx, now.id);
      if (!planned.created && fingerprint(dsn) !== approved.fingerprint) {
        throw new Error(`the ${adapter.title} project DSN changed since approval (fp:${approved.fingerprint} → fp:${fingerprint(dsn)}); no env write was performed. Run \`plan\` again and approve the new DSN.`);
      }
      const entries = decision.write.map((w) => {
        const key = byName.get(w.name)!;
        const source = key === 'sentry.dsn' ? `sentry.dsn|${adapter.id}|${now.id}|${fingerprint(dsn)}` : sourceOf(key);
        return { name: w.name, key, value: dsn, source };
      });
      const r = await writeEnv(runCtx, env, target, entries, decision.recheck);
      written = r.written;
      return { changes: r.changes };
    },
    verifyInline: (vctx) => verifyEnvWritten(vctx, env, target, written, `sentry:env:${target}`, hostAdapter.title),
  });
}

function snippetHandoff(adapter: Adapter, project: ProjectRef): HandoffItem {
  return {
    id: 'sentry:snippet',
    why: `the app reads no env name golive fills for ${adapter.title}, so nothing in it reports errors yet`,
    action: `Initialize the ${adapter.title} SDK in the app with the env name golive writes (SENTRY_DSN, or this framework's client-prefixed spelling, e.g. NEXT_PUBLIC_SENTRY_DSN) and send an error; then re-run \`golive plan\` so the env wiring is planned. This handoff ends when the app reads that name — no check can see the app's own code, and \`golive verify --only sentry-ingest\` proves ${adapter.title} ingests an event, not that the app sends one. The project is ${project.name || project.id}${project.id ? ` (${project.id})` : ''}.`,
    blocking: false,
  };
}

/**
 * The host env golive cannot write (a guided or unusable host): the names come from the plan, the
 * values from the Sentry dashboard, and the `env-parity` check is what closes this handoff.
 */
function envHandoff(ctx: Ctx, adapter: Adapter, mapped: EnvMapping[], target: Target): HandoffItem {
  return {
    id: `sentry:env:${target}`,
    why: `${adapter.title}'s DSN must reach the app, but golive cannot write this host's ${target} env.`,
    action: `In the host's dashboard, add these env vars for ${target}: ${mapped.map((m) => m.name).join(', ')}. Copy the DSN from ${adapter.title} (${sentryApiHost(regionOf(ctx))} → the project → Project Settings → Client Keys (DSN)), never through this chat. The DSN is public by design — it ships in the browser bundle.`,
    blocking: true,
    verifiedBy: 'env-parity',
  };
}
