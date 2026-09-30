import type { Link } from '../core/plan.js';
import type { Adapter, Ctx, EnvStore, EnvTarget, HandoffItem, OutputKey, ProjectCreateTarget, ProjectLinker, ProjectRef, Step } from '../core/types.js';
import type { EnvMapping } from '../core/envmap.js';
import { fingerprint } from '../core/secret.js';
import { repoIdentity } from '../core/repo.js';
import { analyticsOf, posthogIngestHost, regionOf, type AnalyticsProvider } from '../adapters/posthog.js';
import { authOf, decideEnv, deps, envPreview, errMsg, intentOf, mappedEnv, memo, observeNames, projectIntent, ready, step, track, verifyEnvWritten, writeEnv, writesProduction } from './util.js';

type Target = Exclude<EnvTarget, 'development'>;

/** The semantic keys this link fills. Both are PUBLIC (the project token ships in the browser). */
const KEY_NAMES: OutputKey[] = ['posthog.key', 'posthog.host'];
/** Memo/plan identity for a project this plan creates: its id does not exist until the step runs. */
const PENDING = 'pending';

/**
 * Monitoring provider → host env: the analytics project the app reports to, and the app-facing env
 * names that carry its public project token and ingestion host.
 *
 * The project is a resource golive may create (that is what makes it a managed one: it gets a creation
 * marker, and teardown deletes only what that marker names), so this link plans on the `monitoring`
 * axis only when `stack.monitoring` names an automated adapter with a project surface AND a
 * capture/read-back surface — today PostHog. Adopting an already linked project always beats creating
 * one; a create is only planned when nothing is linked, configured or same-named.
 *
 * The project token is NOT a server secret: PostHog designs it to be embedded in a client bundle (see
 * docs/PROVIDERS.md), so it is written as a plain, non-sensitive host variable, exactly the way the
 * Supabase anon/publishable key is — `bundle-secrets` and the exposure guard must not flag it, and a
 * critical exposure finding never blocks it. What proves the wiring is `posthog-ingest` (a synthetic
 * capture plus the provider's own read-back), which is also what closes the app-code handoff below.
 */
export const analyticsLink: Link = {
  id: 'analytics',
  async plan(ctx) {
    const configured = ctx.config.stack.monitoring;
    if (!configured) return null;
    const r = await ready(ctx, 'monitoring', 'project');
    // A guided monitoring provider stays guided (the accounts link carries the `guided:<axis>`
    // handoff), and an unusable login is named by the accounts link too: neither is repeated here.
    if (!r) return null;
    const adapter = r.adapter;
    const provider = analyticsOf(adapter);
    // An automated monitoring adapter without a capture/read-back surface has nothing golive could
    // verify, so nothing is planned and the reason is said out loud.
    if (!provider) {
      return { steps: [], handoffs: [], warnings: [`${adapter.title}: the adapter exposes no capture + read-back surface, so golive cannot wire or verify monitoring for it`] };
    }

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
      // non-blocking handoff carries that task (it closes when `posthog-ingest` passes).
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
const sameTarget = (a: ProjectCreateTarget, b: ProjectCreateTarget): boolean => sameScope(a.scope, b.scope) && a.region === b.region;
const nameList = (refs: ProjectRef[]): string[] => [...new Set(refs.map((c) => `${c.name} (${c.id})`))].sort();

interface Planned {
  project: ProjectRef | null;
  /** The project does not exist yet: this plan's own create step makes it. */
  created: boolean;
  steps: Step[];
  handoffs: HandoffItem[];
}

/**
 * Which analytics project the app reports to. An already linked project is pinned (a zero-write step
 * naming the destination, so the approved plan id covers it); a configured or same-named one is
 * selected; only then does golive create one, named from the repository.
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
    const target = linker.creationTarget ? await linker.creationTarget(ctx) : undefined;
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
        id: 'analytics:project',
        why: `golive doesn't create ${adapter.title} projects on this account, and none is linked to this repo.`,
        action: `Choose (or create) the ${adapter.title} project for this app in its dashboard, then set \`projects.monitoring\` in golive.yaml to its id or name and run \`golive plan\` again.`,
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

function destination(adapter: Adapter, action: 'pin' | 'select' | 'create', project: { id?: string; name: string }, scope: ProjectRef['scope'], account?: string) {
  return { axis: 'monitoring' as const, provider: adapter.id, providerTitle: adapter.title, action, project, ...(scope ? { scope } : {}), ...(account ? { access: account } : {}) };
}

/** Zero-write step naming the destination of this plan's writes; re-reads it before pinning it in state. */
function pinStep(adapter: Adapter, linker: ProjectLinker, planned: ProjectRef, source: string, account: string | undefined): Step {
  return step({
    id: 'analytics:project',
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
    id: 'analytics:project',
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

function createStep(adapter: Adapter, linker: ProjectLinker, name: string, listed: string[], account: string | undefined, target?: ProjectCreateTarget): Step {
  return step({
    id: 'analytics:project',
    title: `Create ${adapter.title} project ${name}`,
    kind: 'provision',
    risk: { writes: true },
    preview: [
      `Create ${adapter.title} project ${name} for monitoring${target ? scopeOf({ id: '', name, scope: target.scope }) : ''} (no existing project matched this repo)`,
      ...(listed.length ? [`existing ${adapter.title} projects that could be used instead: ${listed.slice(0, 10).join(', ')}${listed.length > 10 ? ', …' : ''} — ask the human; to use one, set \`projects.monitoring\` in golive.yaml and run \`plan\` again`] : []),
      ...(account ? [account] : []),
    ],
    intent: intentOf({ create: `${adapter.id}:${name}` }),
    destination: destination(adapter, 'create', { name }, target?.scope, account),
    async run(sctx) {
      try {
        if (target && linker.creationTarget && !sameTarget(target, await linker.creationTarget(sctx))) {
          throw new Error('the destination organization changed; run `plan` again and re-approve. Nothing was created.');
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

// ── The app-facing env ──────────────────────────────────────────────────────────────────────────

interface TokenIdentity {
  /** The public token's fingerprint (secret-free: it is what a plan identity may carry). */
  fingerprint: string;
  /** `<project id>|<token fp>` — what a managed name's recorded source compares against. */
  identity: string;
}

/**
 * Read the project's public token now, so its fingerprint can enter the plan (a rotated token then
 * rewrites a managed name) without the value itself ever reaching a preview, an intent or state. A
 * project this plan creates has no id yet: its identity is `pending`, and the token is read at run
 * time, after the create step recorded the project in state.
 */
async function tokenIdentity(ctx: Ctx, provider: AnalyticsProvider, project: ProjectRef): Promise<TokenIdentity> {
  const cached = ctx.cache.get(`analytics.token:${project.id}`);
  if (cached) return cached as TokenIdentity;
  const token = await provider.token(ctx, project.id);
  const out: TokenIdentity = { fingerprint: fingerprint(token), identity: `${project.id}|${fingerprint(token)}` };
  ctx.cache.set(`analytics.token:${project.id}`, out);
  return out;
}

async function envStep(
  ctx: Ctx,
  adapter: Adapter,
  provider: AnalyticsProvider,
  linker: ProjectLinker,
  planned: Planned,
  hostAdapter: Adapter,
  env: EnvStore,
  target: Target,
  mapped: EnvMapping[],
): Promise<Step | null> {
  const project = planned.project!;
  const host = posthogIngestHost(regionOf(ctx));
  let approved: TokenIdentity;
  if (planned.created) {
    approved = { fingerprint: PENDING, identity: PENDING };
  } else {
    try {
      approved = await tokenIdentity(ctx, provider, project);
    } catch (e) {
      throw new Error(`reading the ${adapter.title} project token for ${target} failed: ${errMsg(e)}`);
    }
  }
  const sourceOf = (key: OutputKey): string =>
    key === 'posthog.key' ? (planned.created ? `posthog.key|${adapter.id}|${PENDING}|${project.name}` : `posthog.key|${adapter.id}|${approved.identity}`) : `posthog.host|${adapter.id}|${host}`;
  const byName = new Map(mapped.map((m) => [m.name, m.key] as const));
  const present = await observeNames(ctx, env, target, memo(ctx).pendingProjects.has('hosting'));
  const decision = decideEnv(ctx, target, [...byName.keys()], present, (n) => sourceOf(byName.get(n)!));
  if (!decision.write.length) return null;

  let written: string[] = [];
  return step({
    id: `analytics:env:${target}`,
    title: `Set ${adapter.title} analytics env for ${target} on ${hostAdapter.title}`,
    kind: 'wire',
    risk: { writes: true },
    dependsOn: deps(ctx, ['analytics:project', 'project:hosting']),
    preview: [
      ...envPreview(decision, (n) => `${byName.get(n)!} from ${adapter.title} project ${project.name || project.id}${planned.created ? ' (created by this plan)' : ''} (public: the project token ships in the browser by design)`),
      `writes the ${adapter.title} project's public ingestion token and the ${regionOf(ctx)} ingestion host (${host}); no server secret is written`,
    ],
    intent: intentOf({ host: await projectIntent(ctx, hostAdapter), project: planned.created ? `${adapter.id}:create:${project.name}` : `${adapter.id}:${project.id}`, token: approved.fingerprint, write: decision.write.map((w) => `${w.name}=${sourceOf(byName.get(w.name)!)})`) }),
    async run(runCtx) {
      // Re-read the project and its token now: the values approved by fingerprint must still be the
      // values written, and a project this plan created exists only since its own step ran.
      const now = planned.created ? await linker.current(runCtx) : project;
      if (!now) throw new Error(`the ${adapter.title} project this plan created could not be read back; no env write was performed. Re-run \`golive plan\`.`);
      const token = await provider.token(runCtx, now.id);
      if (!planned.created && fingerprint(token) !== approved.fingerprint) {
        throw new Error(`the ${adapter.title} project token changed since approval (fp:${approved.fingerprint} → fp:${fingerprint(token)}); no env write was performed. Run \`plan\` again and approve the new token.`);
      }
      const entries = decision.write.map((w) => {
        const key = byName.get(w.name)!;
        const source = key === 'posthog.key' ? `posthog.key|${adapter.id}|${now.id}|${fingerprint(token)}` : sourceOf(key);
        return { name: w.name, key, value: key === 'posthog.key' ? token : host, source };
      });
      const r = await writeEnv(runCtx, env, target, entries, decision.recheck);
      written = r.written;
      return { changes: r.changes };
    },
    verifyInline: (vctx) => verifyEnvWritten(vctx, env, target, written, `analytics:env:${target}`, hostAdapter.title),
  });
}

function snippetHandoff(adapter: Adapter, project: ProjectRef): HandoffItem {
  return {
    id: 'analytics:snippet',
    why: `the app reads no env name golive fills for ${adapter.title}, so nothing in it reports analytics events yet`,
    action: `Initialize the ${adapter.title} SDK in the app with the env names golive writes (POSTHOG_KEY and POSTHOG_HOST, or this framework's client-prefixed spelling, e.g. NEXT_PUBLIC_POSTHOG_KEY / NEXT_PUBLIC_POSTHOG_HOST) and send an event; then run \`golive plan\`, apply the new plan and \`golive verify --only posthog-ingest\`. The project is ${project.name || project.id}${project.id ? ` (${project.id})` : ''}.`,
    blocking: false,
    verifiedBy: 'posthog-ingest',
  };
}

/**
 * The host env golive cannot write (a guided or unusable host): the names come from the plan, the
 * values from the PostHog dashboard, and the `env-parity` check is what closes this handoff.
 */
function envHandoff(ctx: Ctx, adapter: Adapter, mapped: EnvMapping[], target: Target): HandoffItem {
  return {
    id: `analytics:env:${target}`,
    why: `${adapter.title}'s project token must reach the app, but golive cannot write this host's ${target} env.`,
    action: `In the host's dashboard, add these env vars for ${target}: ${mapped.map((m) => m.name).join(', ')}. Copy the value from ${adapter.title} (Project settings → Project API key; the ingestion host is ${posthogIngestHost(regionOf(ctx))}), never through this chat. Both values are public by design — they ship in the browser bundle.`,
    blocking: true,
    verifiedBy: 'env-parity',
  };
}
