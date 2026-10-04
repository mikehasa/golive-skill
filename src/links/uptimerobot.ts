import type { Link } from '../core/plan.js';
import type { Adapter, Ctx, HandoffItem, ProjectDestination, ProjectLinker, ProjectRef, Step } from '../core/types.js';
import { repoIdentity } from '../core/repo.js';
import { sameWatchedUrl, uptimeOf, type UptimeMonitor, type UptimeProvider } from '../adapters/uptimerobot.js';
import { authOf, errMsg, intentOf, lastDeployAt, productionUrl, ready, step, track } from './util.js';

/**
 * Monitoring provider → the uptime monitor that watches this app, for a provider that reports one
 * (today UptimeRobot).
 *
 * The monitor is a resource golive may create — it gets a creation marker, and teardown deletes only
 * what that marker names — so this link plans on the `monitoring` axis only when `stack.monitoring`
 * names an automated adapter with a project surface AND a monitor surface. Adopting always beats
 * creating: the monitor this repo is already linked to is pinned; a configured one is selected; a
 * monitor that already watches the production URL, or is named like the repository, is adopted; only
 * then is one created, and only for a production URL golive can name (the configured `domain`, or the
 * host's own URL once golive has deployed production). Without such a URL the link says what to do
 * and plans nothing — a monitor is never pointed at a guessed address.
 *
 * There is no app-code half: an external monitor watches the site from outside, so the link writes no
 * env, no snippet and no DNS record. Its work ends with the provider's own read of the monitor it
 * linked or created.
 */
const STEP_ID = 'uptimerobot:monitor';

export const uptimerobotLink: Link = {
  id: 'uptimerobot',
  async plan(ctx) {
    const configured = ctx.config.stack.monitoring;
    if (!configured) return null;
    const r = await ready(ctx, 'monitoring', 'project');
    // A guided monitoring provider stays guided (the accounts link carries the `guided:<axis>`
    // handoff), and an unusable login is named by the accounts link too: neither is repeated here.
    if (!r) return null;
    const provider = uptimeOf(r.adapter);
    // A monitoring adapter with another shape is owned by its own link; nothing is said twice here.
    if (!provider) return null;

    const warnings: string[] = [];
    const planned = await planMonitor(ctx, r.adapter, r.cap, provider, warnings);
    return { steps: track(ctx, planned.steps), handoffs: planned.handoffs, warnings };
  },
};

interface Planned {
  monitor: ProjectRef | null;
  steps: Step[];
  handoffs: HandoffItem[];
}

/**
 * Which monitor watches this app. An already linked one is pinned (a zero-write step naming the
 * destination, so the approved plan id covers it); a configured, URL-matching or same-named one is
 * selected; only then does golive create one, named from the repository.
 */
async function planMonitor(ctx: Ctx, adapter: Adapter, linker: ProjectLinker, provider: UptimeProvider, warnings: string[]): Promise<Planned> {
  const account = await accountLine(ctx, adapter);
  const chosen = ctx.config.projects?.monitoring;
  let current = await linker.current(ctx).catch((e: unknown) => {
    throw new Error(`reading the ${adapter.title} monitor linked to this repo failed: ${errMsg(e)}`);
  });
  if (current) {
    if (linker.resolve) current = await linker.resolve(ctx, current.id);
    const fromConfig = chosen !== undefined && (chosen === current.id || chosen === current.name);
    if (chosen !== undefined && !fromConfig) {
      warnings.push(
        `golive.yaml projects.monitoring is "${chosen}", but this repo is already linked to ${adapter.title} monitor ${current.name} (${current.id}); golive uses the linked one. To switch, remove the recorded monitor (or the golive.yaml entry), then run \`plan\` again.`,
      );
    }
    return {
      monitor: current,
      steps: [pinStep(adapter, linker, current, fromConfig ? 'golive.yaml projects.monitoring' : 'the monitor already linked to this repo (golive state)', account)],
      handoffs: [],
    };
  }
  if (chosen) {
    const resolved = linker.resolve ? await linker.resolve(ctx, chosen) : undefined;
    return { monitor: resolved ?? { id: chosen, name: chosen }, steps: [selectStep(adapter, linker, resolved?.id ?? chosen, resolved?.name ?? chosen, account, undefined, resolved)], handoffs: [] };
  }

  // A failed inventory is not an empty account: never turn a refusal into approval to create.
  const monitors = await provider.list(ctx).catch((e: unknown) => {
    throw new Error(`listing ${adapter.title} monitors failed: ${errMsg(e)}`);
  });
  const identity = await repoIdentity(ctx);
  const url = await productionUrl(ctx);
  if (!url) {
    // The payments link words this the same way: apply this plan, re-plan, and the create is planned
    // then. golive never points a monitor at an address it cannot name.
    warnings.push(
      `${adapter.title} monitor: the production URL isn't known yet (no \`domain\` in golive.yaml, and ${lastDeployAt(ctx) ? 'the host reports no production URL' : "golive hasn't deployed production yet"}). Apply this plan, then run \`plan\` again — golive creates the monitor then.`,
    );
    return { monitor: null, steps: [], handoffs: [] };
  }
  // A monitor that already watches this URL, or is named like the repository, is adopted rather than
  // duplicated. Several watching the same URL are equivalent, so the first by id is taken with a
  // warning; several carrying the name are NOT picked between — the human names one in
  // projects.monitoring instead, and golive says so.
  const watching = monitors.filter((m) => sameWatchedUrl(m.url, url)).sort(byMonitorId);
  if (watching.length === 1) {
    const only = watching[0]!;
    return { monitor: ref(only), steps: [selectStep(adapter, linker, only.id, only.name, account, `it already watches ${url}`, ref(only))], handoffs: [] };
  }
  if (watching.length > 1) {
    const chosen = watching[0]!;
    warnings.push(
      `${watching.length} ${adapter.title} monitors watch ${url} (${watching.map((m) => `${m.name} (${m.id})`).join(', ')}); golive adopts ${chosen.name} (${chosen.id}), the first by id. Set projects.monitoring to another one and run \`plan\` again to use that instead.`,
    );
    return { monitor: ref(chosen), steps: [selectStep(adapter, linker, chosen.id, chosen.name, account, `it already watches ${url}`, ref(chosen))], handoffs: [] };
  }
  const same = monitors.filter((m) => m.name.toLowerCase() === identity.name.toLowerCase()).sort(byMonitorId);
  if (same.length === 1) {
    const only = same[0]!;
    return { monitor: ref(only), steps: [selectStep(adapter, linker, only.id, only.name, account, 'its name matches this repository', ref(only))], handoffs: [] };
  }
  if (same.length > 1) {
    // Picking one of several would be a guess about which account this app is; the human names it.
    const listed = same.map((m) => `${m.name} (${m.id})`).join(', ');
    return {
      monitor: null,
      steps: [],
      handoffs: [
        {
          id: STEP_ID,
          why: `${same.length} ${adapter.title} monitors are named like this repository (${listed}), so golive will not guess which one watches this app.`,
          action: `Set \`projects.monitoring\` in golive.yaml to the monitor to use (${listed}) and run \`golive plan\` again — or rename or remove the others in the ${adapter.title} dashboard.`,
          blocking: true,
        },
      ],
    };
  }

  if (!provider.createMonitor) {
    return {
      monitor: null,
      steps: [],
      handoffs: [
        {
          id: STEP_ID,
          why: `golive doesn't create ${adapter.title} monitors on this account, and none is linked to this repo.`,
          action: `Create the monitor for ${url} in the ${adapter.title} dashboard, then set \`projects.monitoring\` in golive.yaml to its id or friendly name and run \`golive plan\` again.`,
          blocking: true,
        },
      ],
    };
  }
  const listed = nameList(monitors);
  if (listed.length) {
    warnings.push(
      `${adapter.title} already has ${listed.length} monitor(s) in this account (${listed.slice(0, 10).join(', ')}${listed.length > 10 ? ', …' : ''}). golive plans to create one more; when the plan refuses a new monitor, set projects.monitoring to the one to use and run \`plan\` again.`,
    );
  }
  return { monitor: { id: '', name: identity.name }, steps: [createStep(adapter, provider, identity.name, url, listed, account)], handoffs: [] };
}

const ref = (m: UptimeMonitor): ProjectRef => ({ id: m.id, name: m.name });
const nameList = (monitors: UptimeMonitor[]): string[] => [...new Set(monitors.map((m) => `${m.name} (${m.id})`))].sort();
/** Deterministic order over provider ids (numeric when the provider's ids are numbers). */
const byMonitorId = (a: UptimeMonitor, b: UptimeMonitor): number => {
  const na = /^[0-9]{1,20}$/.test(a.id) ? Number(a.id) : null;
  const nb = /^[0-9]{1,20}$/.test(b.id) ? Number(b.id) : null;
  if (na !== null && nb !== null && na !== nb) return na - nb;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
};

/** "which account" line from the provider's own auth status (never a credential). */
async function accountLine(ctx: Ctx, adapter: Adapter): Promise<string | undefined> {
  const via = (await authOf(ctx, adapter)).via;
  return via ? `${adapter.title} access: ${via}` : undefined;
}

function destination(adapter: Adapter, action: ProjectDestination['action'], project: { id?: string; name: string }, account?: string) {
  return { axis: 'monitoring' as const, provider: adapter.id, providerTitle: adapter.title, action, project, ...(account ? { access: account } : {}) };
}

/** Zero-write step naming the destination of this plan's writes; re-reads it before pinning it in state. */
function pinStep(adapter: Adapter, linker: ProjectLinker, planned: ProjectRef, source: string, account: string | undefined): Step {
  return step({
    id: STEP_ID,
    title: `Use ${adapter.title} monitor ${planned.name} for monitoring`,
    kind: 'provision',
    risk: { writes: false },
    preview: [`monitoring: ${adapter.title} monitor ${planned.name} (${planned.id}), from ${source}; the uptime check re-reads this monitor`, ...(account ? [account] : [])],
    intent: intentOf({ pin: `${adapter.id}:${planned.id}` }),
    destination: destination(adapter, 'pin', { id: planned.id, name: planned.name }, account),
    async run(sctx) {
      let now = await linker.current(sctx);
      if (now && linker.resolve) now = await linker.resolve(sctx, now.id);
      if (!now || now.id !== planned.id) {
        throw new Error(`the ${adapter.title} monitor changed since the plan was approved (planned ${planned.name} (${planned.id}), now ${now ? `${now.name} (${now.id})` : 'none'}); nothing was written. Run \`plan\` again and re-approve.`);
      }
      const p = await linker.select(sctx, planned.id);
      if (p.id !== planned.id) throw new Error(`the ${adapter.title} monitor destination changed; run \`plan\` again and re-approve before any remote writes.`);
      return { changes: [`using ${adapter.title} monitor ${p.name} (${p.id}) for monitoring (pinned in golive state)`] };
    },
  });
}

function selectStep(adapter: Adapter, linker: ProjectLinker, idOrName: string, label: string, account: string | undefined, why?: string, planned?: ProjectRef): Step {
  return step({
    id: STEP_ID,
    title: `Use existing ${adapter.title} monitor ${label}`,
    kind: 'provision',
    risk: { writes: true },
    preview: [
      `Use existing ${adapter.title} monitor ${label}${why ? ` (${why})` : ''} for monitoring (links it in golive state; nothing is changed at ${adapter.title})`,
      ...(account ? [account] : []),
    ],
    intent: intentOf({ select: `${adapter.id}:${idOrName}` }),
    destination: destination(adapter, 'select', { ...(planned ? { id: planned.id } : {}), name: label }, account),
    async run(sctx) {
      const p = await linker.select(sctx, idOrName);
      if (planned && (p.id !== planned.id || p.name !== planned.name)) {
        throw new Error(`the ${adapter.title} monitor destination changed (planned ${planned.name} (${planned.id}), now ${p.name} (${p.id})); run \`plan\` again and re-approve before any remote writes.`);
      }
      return { changes: [`linked ${adapter.title} monitor ${p.name} (${p.id}) for monitoring`] };
    },
  });
}

/**
 * The create. Its approved URL is part of the plan, so the run re-reads the production URL and
 * refuses a changed one before writing; the adapter then re-reads the monitor the provider returned
 * and records the creation marker that teardown reads.
 */
function createStep(adapter: Adapter, provider: UptimeProvider, name: string, url: string, listed: string[], account: string | undefined): Step {
  return step({
    id: STEP_ID,
    title: `Create ${adapter.title} monitor ${name}`,
    kind: 'provision',
    risk: { writes: true },
    preview: [
      `Create ${adapter.title} monitor ${name} for ${url} (the production URL golive can name; HTTP(S), checked at the provider's own default interval — no existing monitor watches it)`,
      ...(listed.length ? [`existing ${adapter.title} monitors that could be used instead: ${listed.slice(0, 10).join(', ')}${listed.length > 10 ? ', …' : ''} — ask the human; to use one, set \`projects.monitoring\` in golive.yaml and run \`plan\` again`] : []),
      ...(account ? [account] : []),
    ],
    intent: intentOf({ create: `${adapter.id}:${name}`, url }),
    destination: destination(adapter, 'create', { name }, account),
    async run(sctx) {
      const now = await productionUrl(sctx);
      if (!now || !sameWatchedUrl(now, url)) {
        throw new Error(`the production URL changed since the plan was approved (planned ${url}, now ${now ?? 'none'}); nothing was created. Run \`plan\` again and re-approve.`);
      }
      try {
        const m = await provider.createMonitor!(sctx, { name, url });
        return { changes: [`created ${adapter.title} monitor ${m.name} (${m.id}) for ${m.url}`] };
      } catch (e) {
        throw new Error(`creating ${adapter.title} monitor ${name} failed: ${errMsg(e)}`);
      }
    },
  });
}
