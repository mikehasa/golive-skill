import type { Link } from '../core/plan.js';
import type { Adapter, Axis, Ctx, HandoffItem, ProjectCreateTarget, ProjectLinker, ProjectRef, Step } from '../core/types.js';
import { authOf, errMsg, intentOf, memo, ready, repoName, step, track } from './util.js';

const PROJECT_AXES: Axis[] = ['hosting', 'db'];
const MAX_LISTED = 10;

/** Optional extras an adapter may attach to a ProjectRef (non-contract; printed when present). */
type RichRef = ProjectRef & { team?: string; org?: string };

/**
 * Which project at the host / database provider this app uses. Adopting beats creating: an already
 * linked project is pinned (a zero-write step that names it, so the approved plan id covers the
 * destination of every write); a configured or same-named one is selected; only then do we create.
 */
export const projectsLink: Link = {
  id: 'projects',
  async plan(ctx) {
    const steps: Step[] = [];
    const handoffs: HandoffItem[] = [];
    const warnings: string[] = [];
    let applies = false;
    for (const axis of PROJECT_AXES) {
      const r = await ready(ctx, axis, 'project');
      if (!r) continue;
      applies = true;
      const part = await planAxis(ctx, axis, r.adapter, r.cap);
      if (part.step) steps.push(part.step);
      if (part.handoff) handoffs.push(part.handoff);
      if (part.warning) warnings.push(part.warning);
    }
    return applies ? { steps: track(ctx, steps), handoffs, warnings } : null;
  },
};

async function planAxis(ctx: Ctx, axis: Axis, adapter: Adapter, linker: ProjectLinker): Promise<{ step?: Step; handoff?: HandoffItem; warning?: string }> {
  let current = await linker.current(ctx).catch((e: unknown) => {
    throw new Error(`reading the ${adapter.title} project linked to this repo failed: ${errMsg(e)}`);
  });
  const account = await accountLine(ctx, adapter);
  const chosen = ctx.config.projects?.[axis];
  if (current) {
    if (linker.resolve) current = await linker.resolve(ctx, current.id);
    const fromConfig = chosen !== undefined && (chosen === current.id || chosen === current.name);
    const warning =
      chosen !== undefined && !fromConfig
        ? `golive.yaml projects.${axis} is "${chosen}", but this repo is already linked to ${adapter.title} project ${current.name} (${current.id}); golive uses the linked one. To switch, relink the repo to "${chosen}" (or remove the link), then run \`plan\` again.`
        : undefined;
    return { step: pinStep(axis, adapter, linker, current, fromConfig ? `golive.yaml projects.${axis}` : `the project already linked to this repo (golive state or ${adapter.title}'s local link file)`, account), warning };
  }
  if (chosen) {
    const resolved = linker.resolve ? await linker.resolve(ctx, chosen) : undefined;
    return { step: selectStep(ctx, axis, adapter, linker, resolved?.id ?? chosen, resolved?.name ?? chosen, account, resolved) };
  }

  const name = repoName(ctx);
  // A failed inventory is not an empty account. In particular, a provider may refuse ambiguous
  // branch/scope discovery; never turn that refusal into approval to create a different resource.
  const candidates = await linker.candidates(ctx).catch((e: unknown) => {
    throw new Error(`listing ${adapter.title} project candidates failed: ${errMsg(e)}`);
  });
  const same = candidates.find((c) => c.name.toLowerCase() === name);
  if (same) {
    const resolved = linker.resolve ? await linker.resolve(ctx, same.id) : same;
    return { step: selectStep(ctx, axis, adapter, linker, resolved.id, resolved.name, account, resolved) };
  }

  const names = [...new Set(candidates.map((c) => c.name))].sort();
  const listed = names.length ? `${names.slice(0, MAX_LISTED).join(', ')}${names.length > MAX_LISTED ? ', …' : ''}` : '';
  if (linker.create) {
    const target = linker.creationTarget ? await linker.creationTarget(ctx) : undefined;
    return { step: createStep(ctx, axis, adapter, linker, name, listed, account, target) };
  }

  return {
    handoff: {
      id: `project:${axis}`,
      why: `golive doesn't create ${adapter.title} projects (it can cost money or needs choices only a human can make), and none is linked to this repo.`,
      action:
        (listed ? `Ask the human which existing ${adapter.title} project to use (${listed}), ` : `Have the human create a ${adapter.title} project in its dashboard, `) +
        `then run \`init --project ${axis}=<name>\` and \`plan\` again.`,
      blocking: true,
    },
  };
}

/** "which account" line from the provider's auth status (e.g. "vercel CLI (logged in as alice, team acme)"). */
async function accountLine(ctx: Ctx, adapter: Adapter): Promise<string | undefined> {
  const via = (await authOf(ctx, adapter)).via;
  return via ? `${adapter.title} access: ${via}` : undefined;
}

const scopeOf = (p: ProjectRef): string => {
  if (p.scope) return ` in ${p.scope.kind} ${p.scope.name ? `${p.scope.name} (${p.scope.id})` : p.scope.id}`;
  const r = p as RichRef;
  const s = r.team ?? r.org;
  return s ? ` in ${s}` : '';
};

const sameScope = (a: ProjectRef['scope'], b: ProjectRef['scope']): boolean =>
  a?.kind === b?.kind && a?.id === b?.id;
const sameTarget = (a: ProjectCreateTarget, b: ProjectCreateTarget): boolean =>
  sameScope(a.scope, b.scope) && a.region === b.region;

/**
 * Zero-write step naming the destination of this plan's writes. At apply time it refuses if the repo
 * now resolves to a different project (link file changed, state edited), then pins the project in
 * golive state so later runs don't depend on local link files.
 */
function pinStep(axis: Axis, adapter: Adapter, linker: ProjectLinker, planned: ProjectRef, source: string, account: string | undefined): Step {
  return step({
    id: `project:${axis}`,
    title: `Use ${adapter.title} project ${planned.name} for ${axis}`,
    kind: 'provision',
    risk: { writes: false },
    preview: [`${axis}: ${adapter.title} project ${planned.name} (${planned.id})${scopeOf(planned)}, from ${source}; every ${adapter.title} write in this plan goes there`, ...(account ? [account] : [])],
    intent: intentOf({ pin: `${adapter.id}:${planned.id}` }),
    destination: { axis, provider: adapter.id, providerTitle: adapter.title, action: 'pin', project: { id: planned.id, name: planned.name }, ...(planned.scope ? { scope: planned.scope } : {}), ...(account ? { access: account } : {}) },
    async run(sctx) {
      let now = await linker.current(sctx);
      if (now && linker.resolve) now = await linker.resolve(sctx, now.id);
      if (!now || now.id !== planned.id || !sameScope(now.scope, planned.scope)) {
        throw new Error(`the ${adapter.title} project for ${axis} changed since the plan was approved (planned ${planned.name} (${planned.id}), now ${now ? `${now.name} (${now.id})` : 'none'}); nothing was written. Run \`plan\` again and re-approve.`);
      }
      const p = await linker.select(sctx, planned.id);
      if (p.id !== planned.id || planned.scope && !sameScope(p.scope, planned.scope)) throw new Error(`the ${adapter.title} project destination changed; run \`plan\` again and re-approve before any remote writes.`);
      return { changes: [`using ${adapter.title} project ${p.name} (${p.id}) for ${axis} (pinned in golive state)`] };
    },
  });
}

function selectStep(ctx: Ctx, axis: Axis, adapter: Adapter, linker: ProjectLinker, idOrName: string, label: string, account: string | undefined, planned?: ProjectRef): Step {
  memo(ctx).pendingProjects.set(axis, 'select');
  return step({
    id: `project:${axis}`,
    title: `Use existing ${adapter.title} project ${label}`,
    kind: 'provision',
    risk: { writes: true },
    preview: [`Use existing ${adapter.title} project ${label}${planned ? ` (${planned.id})${scopeOf(planned)}` : ''} for ${axis} (links it locally; nothing is changed at ${adapter.title})`, ...(account ? [account] : [])],
    intent: intentOf({ select: `${adapter.id}:${idOrName}` }),
    destination: { axis, provider: adapter.id, providerTitle: adapter.title, action: 'select', project: { ...(planned ? { id: planned.id } : {}), name: label }, ...(planned?.scope ? { scope: planned.scope } : {}), ...(account ? { access: account } : {}) },
    async run(sctx) {
      if (planned && linker.resolve) {
        const now = await linker.resolve(sctx, planned.id);
        if (now.id !== planned.id || !sameScope(now.scope, planned.scope)) throw new Error(`the ${adapter.title} project destination changed; run \`plan\` again and re-approve.`);
      }
      const p = await linker.select(sctx, idOrName);
      if (planned && (p.id !== planned.id || planned.scope && !sameScope(p.scope, planned.scope))) throw new Error(`the ${adapter.title} project destination changed; run \`plan\` again and re-approve before any remote writes.`);
      return { changes: [`linked ${adapter.title} project ${p.name} (${p.id}) for ${axis}`] };
    },
  });
}

function createStep(ctx: Ctx, axis: Axis, adapter: Adapter, linker: ProjectLinker, name: string, listed: string, account: string | undefined, target?: ProjectCreateTarget): Step {
  memo(ctx).pendingProjects.set(axis, 'create');
  return step({
    id: `project:${axis}`,
    title: `Create ${adapter.title} project ${name}`,
    kind: 'provision',
    risk: { writes: true },
    preview: [
      `Create ${adapter.title} project ${name} for ${axis}${target ? scopeOf({ id: '', name, scope: target.scope }) : ''} (no existing project matched this repo)`,
      ...(target?.region ? [`region: ${target.region}`] : []),
      ...(listed ? [`existing ${adapter.title} projects that could be used instead: ${listed} — ask the human; to use one, run \`init --project ${axis}=<name>\` and \`plan\` again`] : []),
      ...(account ? [account] : []),
    ],
    intent: intentOf({ create: `${adapter.id}:${name}` }),
    destination: { axis, provider: adapter.id, providerTitle: adapter.title, action: 'create', project: { name }, ...(target ? { scope: target.scope, ...(target.region ? { region: target.region } : {}) } : {}), ...(account ? { access: account } : {}) },
    async run(sctx) {
      try {
        if (target && linker.creationTarget && !sameTarget(target, await linker.creationTarget(sctx))) {
          throw new Error('the destination account/team/organization or region changed; run `plan` again and re-approve. Nothing was created.');
        }
        const p = await linker.create!(sctx, name, target);
        if (target && !sameScope(p.scope, target.scope)) throw new Error('the provider returned an unexpected project destination; inspect the created resource before continuing.');
        return { changes: [`created ${adapter.title} project ${p.name} (${p.id}) for ${axis}`] };
      } catch (e) {
        throw new Error(`creating ${adapter.title} project ${name} failed: ${errMsg(e)}`);
      }
    },
  });
}
