import type { Link } from '../core/plan.js';
import type { Adapter, Ctx, EnvStore, EnvTarget, HandoffItem, OutputKey, Outputs, OutputsProvider, Step, Value } from '../core/types.js';
import type { EnvMapping } from '../core/envmap.js';
import { fingerprint } from '../core/secret.js';
import { modeFor } from '../core/config.js';
import { adapterFor, availableKeys, axisStatus, intentOf, projectIntent, decideEnv, deps, envPreview, envSourceKey, errMsg, hostUrl, isManaged, lastDeployAt, mappedEnv, memo, observeNames, productionUrl, projectIdentity, ready, SECRET_KEYS, secretBlocked, step, track, uniq, verifyEnvWritten, writeEnv, writesProduction } from './util.js';

type Target = Exclude<EnvTarget, 'development'>;
interface Source {
  adapter: Adapter;
  outputs: OutputsProvider;
}

const isDbKey = (k: OutputKey): boolean => k === 'db.url' || k === 'db.directUrl';
const ownsKey = (k: OutputKey): boolean => k.startsWith('supabase.') || k.startsWith('db.') || k === 'app.url';

export const DB_PASSWORD_HELP =
  'The database password is only shown once, when the database is created, so golive cannot read it back. Either (a) the human copies the connection string from the database dashboard and pastes it straight into the host dashboard (never into this chat), or (b) the human resets the database password in the database dashboard and you run `plan` again (a reset breaks anything else still using the old password).';

/**
 * db / auth outputs + the app URL → host env, per target. Fills only the names the code references,
 * never touches names someone else set, and updates names golive wrote before (fingerprints in state).
 */
export const envLink: Link = {
  id: 'env',
  async plan(ctx) {
    const host = await axisStatus(ctx, 'hosting');
    if (host.kind === 'none' || host.kind === 'unauthed') return null;
    const mapped = mappedEnv(ctx);
    if (host.kind === 'guided') return guidedHost(ctx, host.title, mapped);
    const env = host.adapter.capabilities.env;
    const mine = mapped.filter((m) => ownsKey(m.key));
    if (!env || mine.length === 0) return null;

    const db = await ready(ctx, 'db', 'outputs');
    const au = await ready(ctx, 'auth', 'outputs');
    const sources: Source[] = [db, au && au.adapter.id !== db?.adapter.id ? au : undefined].filter((s): s is NonNullable<typeof s> => Boolean(s)).map((s) => ({ adapter: s.adapter, outputs: s.cap }));

    const steps: Step[] = [];
    const warnings: string[] = [];
    const dbMissing = new Set<string>();
    for (const target of ctx.config.targets) {
      const r = await planTarget(ctx, target, host.adapter, env, mine, sources);
      if (r.step) steps.push(r.step);
      warnings.push(...r.warnings);
      r.dbMissing.forEach((n) => dbMissing.add(n));
    }
    const handoffs: HandoffItem[] = [];
    if (dbMissing.size) {
      handoffs.push({
        id: 'db:password',
        why: `The code needs ${[...dbMissing].join(', ')}, but ${db?.adapter.title ?? 'the database provider'} can't hand golive a connection string for an existing database.`,
        action: `${DB_PASSWORD_HELP} Names to set in ${host.adapter.title}: ${[...dbMissing].join(', ')}.`,
        blocking: true,
        verifiedBy: 'env-parity',
      });
    }
    return { steps: track(ctx, steps, { needsRedeploy: writesProduction }), handoffs, warnings };
  },
};

/**
 * Identity of the projects values come from (e.g. the Supabase project ref), so switching the db/auth
 * project rewrites the names golive manages instead of leaving production on the old project.
 */
async function identities(ctx: Ctx, sources: Source[], planning: boolean): Promise<string | null> {
  const ids: string[] = [];
  for (const s of sources) {
    const id = await projectIdentity(ctx, s.adapter, { planning });
    if (id === null) return null;
    const selectors = await s.outputs.identity?.(ctx);
    ids.push(selectors ? `${id}[${selectors}]` : id);
  }
  return ids.join('+');
}

async function planTarget(ctx: Ctx, target: Target, hostAdapter: Adapter, env: EnvStore, mine: EnvMapping[], sources: Source[]) {
  const warnings: string[] = [];
  const dbMissing: string[] = [];
  const present = await observeNames(ctx, env, target, memo(ctx).pendingProjects.has('hosting'));
  const keys = await keysFor(ctx, target, sources, mine.map((m) => m.key));
  const appUrl = target === 'production' ? await productionUrl(ctx) : await hostUrl(ctx, target);

  const wanted: EnvMapping[] = [];
  for (const m of mine) {
    if (m.key === 'app.url') {
      if (appUrl) wanted.push(m);
      else if (target === 'production') warnings.push(`${m.name} (production): the production URL isn't known until ${lastDeployAt(ctx) ? 'the host reports it' : 'golive has deployed production once'}; run \`plan\` again after the deploy`);
      continue;
    }
    if (secretBlocked(ctx, m.name, m.key)) continue; // a critical exposure finding blocks it (see the secrets:exposed handoff)
    if (!sources.length) {
      warnings.push(`${m.name}: no chosen provider supplies ${m.key}`);
      continue;
    }
    if (keys && !keys.has(m.key)) {
      if (present?.has(m.name)) continue; // someone already set it; leave it
      if (isDbKey(m.key)) dbMissing.push(m.name);
      else warnings.push(`${m.name} (${target}): ${sources.map((s) => s.adapter.title).join('/')} doesn't provide ${m.key}`);
      continue;
    }
    wanted.push(m);
  }

  const keyOf = new Map(wanted.map((m) => [m.name, m.key]));
  const srcIds = sources.map((s) => s.adapter.id).join('+');
  const sourceAt = (name: string, identity: string | null): string => {
    const k = keyOf.get(name)!;
    if (k === 'app.url') return `app.url|${fingerprint(appUrl ?? '')}`;
    // Identity unreadable right now: keep what state says rather than forcing a rewrite.
    if (identity === null) return ctx.state.resource(envSourceKey(name, target)) ?? `${k}|${srcIds}|?`;
    return `${k}|${srcIds}|${identity}`;
  };
  const planIdentity = await identities(ctx, sources, true);
  const decision = decideEnv(ctx, target, wanted.map((m) => m.name), present, (n) => sourceAt(n, planIdentity));
  if (decision.write.length === 0) return { warnings, dbMissing };

  // What the writes take their values from (incl. the source project id) and where they go: a second
  // project switch with the same preview text must still run (see Step.intent).
  const intent = intentOf({ host: await projectIntent(ctx, hostAdapter), write: decision.write.map((w) => `${w.name}=${sourceAt(w.name, planIdentity)}`) });
  const from = (k: OutputKey): string => (k === 'app.url' ? `${appUrl} (public)` : `${k} from ${sources.map((s) => s.adapter.title).join('/')}${SECRET_KEYS.has(k) ? ' (sensitive)' : ''}`);
  const selectors = await Promise.all(sources.filter((s) => s.outputs.identity).map(async (s) => ({
    ...s, identity: await s.outputs.identity!(ctx),
    creating: s.adapter.id === ctx.config.stack.db && memo(ctx).pendingProjects.get('db') === 'create',
  })));
  let written: string[] = [];
  const s = step({
    id: `env:${target}`,
    title: `Set ${target} env vars on ${hostAdapter.title}`,
    kind: 'wire',
    risk: { writes: true },
    dependsOn: deps(ctx, ['project:hosting', 'project:db']),
    preview: [
      ...envPreview(decision, (n) => from(keyOf.get(n)!)),
      ...selectors.map((s) => `${s.adapter.title} connection: ${s.identity}`),
    ],
    intent,
    async run(sctx) {
      for (const source of selectors) {
        if (!source.creating && await source.outputs.identity!(sctx) !== source.identity) {
          throw new Error(`${source.adapter.title} connection selectors changed after approval. Run plan again and re-approve before writing env.`);
        }
      }
      // Resolve provisional writes before asking for outputs: DB URL recovery can itself write.
      // A human-owned value discovered now must be kept without touching its source password.
      const presentNow = decision.recheck ? new Set(await env.listNames(sctx, target)) : null;
      const kept = decision.write.filter((w) => presentNow?.has(w.name) && !isManaged(sctx, w.name, target));
      const needed = decision.write.filter((w) => !kept.includes(w)).map((w) => ({ name: w.name, key: keyOf.get(w.name)! }));
      const outs = needed.some((n) => n.key !== 'app.url') ? await fetchOutputs(sctx, target, sources, needed.map((n) => n.key)) : {};
      // Re-read the identity now: a project step earlier in this apply may have just linked it.
      const runIdentity = await identities(sctx, sources, false);
      const entries: Array<{ name: string; key: OutputKey; value: Value; source: string }> = [];
      const missing: Array<{ name: string; key: OutputKey }> = [];
      for (const n of needed) {
        const value = n.key === 'app.url' ? appUrl ?? undefined : outs[n.key];
        if (value === undefined || value === '') missing.push(n);
        else entries.push({ ...n, value, source: sourceAt(n.name, runIdentity) });
      }
      if (missing.length) throw missingError(target, missing, sources);
      const r = await writeEnv(sctx, env, target, entries, decision.recheck);
      written = r.written;
      return { changes: [...kept.map((w) => `kept ${w.name} (${target}): already set, not managed by golive`), ...r.changes] };
    },
    verifyInline: (vctx) => verifyEnvWritten(vctx, env, target, written, `env:${target}`, hostAdapter.title),
  });
  return { step: s, warnings, dbMissing };
}

/** Union of keys the sources can supply, or null if any source can't say (then we assume yes). */
async function keysFor(ctx: Ctx, target: Target, sources: Source[], requestedKeys: readonly OutputKey[]): Promise<Set<OutputKey> | null> {
  // Not linked yet, so not observable. (A database created by this plan hands its connection string
  // over in-process; a selected one that can't is reported by run() with the same guidance.)
  if (memo(ctx).pendingProjects.has('db')) return null;
  const all = new Set<OutputKey>();
  for (const s of sources) {
    const k = await availableKeys(ctx, s.outputs, target, requestedKeys);
    if (!k) return null;
    k.forEach((x) => all.add(x));
  }
  return all;
}

/** Earlier sources win (db over auth). */
async function fetchOutputs(ctx: Ctx, target: Target, sources: Source[], requestedKeys: readonly OutputKey[]): Promise<Outputs> {
  const merged: Outputs = {};
  for (const s of [...sources].reverse()) {
    try {
      Object.assign(merged, await s.outputs.outputs(ctx, target, requestedKeys));
    } catch (e) {
      throw new Error(`reading ${target} outputs from ${s.adapter.title} failed: ${errMsg(e)}`);
    }
  }
  return merged;
}

function missingError(target: Target, missing: Array<{ name: string; key: OutputKey }>, sources: Source[]): Error {
  const who = sources.map((s) => s.adapter.title).join('/') || 'no provider';
  const names = missing.map((m) => `${m.name} (${m.key})`).join(', ');
  const hint = missing.some((m) => isDbKey(m.key)) ? DB_PASSWORD_HELP : 'Check that the provider project is linked (see the project step), then re-run apply.';
  return new Error(`${who} returned no value for ${names} (${target}). ${hint}`);
}

/**
 * Guided host: the human adds the names per target. Per target, because golive's own rules differ by
 * target: the webhook signing secret is production-only (env-parity doesn't expect it elsewhere), and
 * payment keys must come from the mode that target uses (test keys in preview, live in production).
 */
function guidedHost(ctx: Ctx, title: string, mapped: EnvMapping[]) {
  if (!mapped.length) return null;
  const pay = ctx.config.stack.payments ? (adapterFor(ctx, 'payments')?.title ?? ctx.config.stack.payments) : null;
  const handoffs: HandoffItem[] = [];
  for (const t of ctx.config.targets) {
    const forTarget = mapped.filter((m) => !(m.key === 'stripe.webhookSecret' && t !== 'production'));
    const names = uniq(forTarget.map((m) => m.name));
    if (!names.length) continue;
    const mode = modeFor(ctx.config, t);
    const label = (n: string): string => {
      const key = forTarget.find((m) => m.name === n)?.key;
      if (pay && (key === 'stripe.secretKey' || key === 'stripe.publishableKey')) return `${n} (${pay} ${mode}-mode key: ${key === 'stripe.secretKey' ? `sk_${mode}_…` : `pk_${mode}_…`})`;
      if (pay && key === 'stripe.webhookSecret') return `${n} (signing secret of the ${mode}-mode production webhook endpoint)`;
      return n;
    };
    const skipped = mapped.some((m) => m.key === 'stripe.webhookSecret') && t !== 'production' ? ' The webhook signing secret is production-only: leave it out here.' : '';
    handoffs.push({
      id: `env:${t}`,
      why: `${title} isn't automated by golive, so the app's env vars must be added in its dashboard.`,
      action: `In ${title}, add these env vars for the ${t} environment: ${names.map(label).join(', ')}.${skipped} The human copies each value from its provider's dashboard straight into ${title}'s dashboard, never through this chat.`,
      blocking: true,
      verifiedBy: 'env-parity',
    });
  }
  return { steps: [], handoffs };
}
