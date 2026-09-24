import { basename } from 'node:path';
import { Secret, fingerprint, redact } from '../core/secret.js';
import { mapEnv, type EnvMapping } from '../core/envmap.js';
import type { Adapter, AuthStatus, Axis, Capabilities, CheckResult, Ctx, EnvStore, EnvTarget, Finding, OutputKey, Outputs, OutputsProvider, Risk, Step, StepContext, StepResult, Value } from '../core/types.js';

// ── Provider resolution ───────────────────────────────────────────────────────────────────────────
// Same semantics as registry.adapterFor/cap (resolve through ctx.adapters). Kept local because
// registry.ts imports links/index.ts, so importing it from here would create an import cycle that
// leaves LINKS in its temporal dead zone when a link module is loaded first (e.g. in tests).

export { adapterFor, cap } from '../core/caps.js';
import { adapterFor, cap } from '../core/caps.js';

export type AxisStatus =
  | { kind: 'none' }
  | { kind: 'guided'; provider: string; title: string }
  | { kind: 'unauthed'; adapter: Adapter; status: AuthStatus }
  | { kind: 'ready'; adapter: Adapter };

/** How far golive can go on an axis: not chosen, guided (no automation), not logged in, or ready. */
export async function axisStatus(ctx: Ctx, axis: Axis): Promise<AxisStatus> {
  const id = ctx.config.stack[axis];
  if (!id) return { kind: 'none' };
  const adapter = adapterFor(ctx, axis);
  if (!adapter || !adapter.automated) return { kind: 'guided', provider: id, title: adapter?.title ?? id };
  const status = await authOf(ctx, adapter);
  return status.ok ? { kind: 'ready', adapter } : { kind: 'unauthed', adapter, status };
}

/** The adapter for `axis` if it is automated, logged in, and has capability `k`. */
export async function ready<K extends keyof Capabilities>(ctx: Ctx, axis: Axis, k: K): Promise<{ adapter: Adapter; cap: Capabilities[K] } | undefined> {
  const s = await axisStatus(ctx, axis);
  if (s.kind !== 'ready') return undefined;
  const c = s.adapter.capabilities[k];
  return c ? { adapter: s.adapter, cap: c as Capabilities[K] } : undefined;
}

// ── Per-plan memo ─────────────────────────────────────────────────────────────────────────────────
// Links run in order within one buildPlan(ctx). The memo lets later links see what earlier ones
// decided (auth results, planned step ids, pending projects). The accounts link resets it first.

export interface PlanMemo {
  auth: Map<string, Promise<AuthStatus>>;
  /** Step ids emitted so far in this plan. */
  planned: Set<string>;
  /** The emitted steps themselves (the deploy link reads their dependencies to order deploys). */
  steps: Map<string, Step>;
  /** Step ids after which production must be redeployed (production host env writes). */
  redeployAfter: Set<string>;
  /** Axes whose project will be selected/created by a step in this plan. */
  pendingProjects: Map<Axis, 'select' | 'create'>;
  /** projectIdentity() results while planning, per adapter id. */
  identity: Map<string, Promise<string | null>>;
}

const memos = new WeakMap<Ctx, PlanMemo>();

export function memo(ctx: Ctx): PlanMemo {
  let m = memos.get(ctx);
  if (!m) {
    m = { auth: new Map(), planned: new Set(), steps: new Map(), redeployAfter: new Set(), pendingProjects: new Map(), identity: new Map() };
    memos.set(ctx, m);
  }
  return m;
}

export function resetMemo(ctx: Ctx): void {
  memos.delete(ctx);
}

/** auth() once per provider per plan. Never throws: a throwing adapter counts as "not logged in". */
export function authOf(ctx: Ctx, adapter: Adapter): Promise<AuthStatus> {
  const m = memo(ctx);
  let p = m.auth.get(adapter.id);
  if (!p) {
    p = adapter.auth(ctx).catch((e: unknown) => ({ ok: false, howToFix: `checking ${adapter.title} access failed: ${errMsg(e)}` }));
    m.auth.set(adapter.id, p);
  }
  return p;
}

/**
 * Record emitted steps in the memo; returns them for convenience. `needsRedeploy` marks steps whose
 * effect only reaches production through a new deployment (production env writes); pass a predicate
 * when only some of the steps qualify.
 */
export function track(ctx: Ctx, steps: Step[], opts: { needsRedeploy?: boolean | ((s: Step) => boolean) } = {}): Step[] {
  const m = memo(ctx);
  for (const s of steps) {
    m.planned.add(s.id);
    m.steps.set(s.id, s);
    const redeploy = typeof opts.needsRedeploy === 'function' ? opts.needsRedeploy(s) : opts.needsRedeploy;
    if (redeploy) m.redeployAfter.add(s.id);
  }
  return steps;
}

/** Production env writes need a production redeploy; preview env only applies to new previews. */
export const writesProduction = (s: Step): boolean => s.id.endsWith(':production');

/** Keep only dependencies that exist in this plan (unknown deps would fail plan ordering). */
export function deps(ctx: Ctx, ids: string[]): string[] {
  const planned = memo(ctx).planned;
  return [...new Set(ids)].filter((id) => planned.has(id));
}

// ── Steps ─────────────────────────────────────────────────────────────────────────────────────────

export function step(s: {
  id: string;
  title: string;
  kind: Step['kind'];
  risk: Risk;
  dependsOn?: string[];
  preview: string[];
  /** Secret-free identity of what this run writes beyond its preview (see Step.intent). */
  intent?: string;
  destination?: Step['destination'];
  verifyWith?: string[];
  run: (ctx: StepContext) => Promise<StepResult>;
  verifyInline?: (ctx: Ctx) => Promise<CheckResult[]>;
}): Step {
  return { dependsOn: [], verifyWith: [], ...s };
}

/**
 * Deterministic Step.intent from labelled parts (sorted, so map/set iteration order never changes a
 * plan id). Values must be secret-free: ids, URLs, modes, fingerprints.
 */
export function intentOf(parts: Record<string, string | string[] | null | undefined>): string {
  return Object.keys(parts)
    .sort()
    .map((k) => {
      const v = parts[k];
      return `${k}=${Array.isArray(v) ? [...v].sort().join(',') : (v ?? '')}`;
    })
    .join(';');
}

export function errMsg(e: unknown): string {
  return redact(e instanceof Error ? e.message : String(e));
}

// ── URLs / names ──────────────────────────────────────────────────────────────────────────────────

/** Project name derived from the repo directory (lowercase, dash-separated). */
export function repoName(ctx: Ctx): string {
  const s = basename(ctx.cwd)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63);
  return s || 'app';
}

/**
 * Production base URL: the configured domain, else the host's production URL — but the host's URL
 * only once golive has deployed production successfully. Some hosts report a URL for a project that
 * was never deployed (Vercel falls back to `<name>.vercel.app`, a global name that may belong to
 * another account), and this URL is where webhooks, auth redirects and the site URL get pointed.
 * Read-only.
 */
export async function productionUrl(ctx: Ctx): Promise<string | null> {
  if (ctx.config.domain) return `https://${ctx.config.domain}`;
  if (!lastDeployAt(ctx)) return null;
  return hostUrl(ctx, 'production');
}

// ── Deploy bookkeeping (state) ────────────────────────────────────────────────────────────────────

/** resources key: time of the last successful deploy of `target`. */
export const deployedKey = (target: Exclude<EnvTarget, 'development'>): string => `deployed:${target}`;
/** resources key: a `target` env write that no deploy has picked up yet. */
export const redeployKey = (target: Exclude<EnvTarget, 'development'>): string => `redeploy:${target}`;
/** resources key: the provider's own identity of the deployment golive recorded for `target`. */
export const deployedIdKey = (target: Exclude<EnvTarget, 'development'>): string => `${deployedKey(target)}:id`;
/** resources key: time of the last successful production deploy by golive. */
export const DEPLOYED_KEY = deployedKey('production');
/** resources key: time of a production env write that no deploy has picked up yet. */
export const REDEPLOY_KEY = redeployKey('production');
/** resources key: the bounded log of deployment identities golive recorded (JSON, newest first). */
export const DEPLOY_HISTORY_KEY = 'deployed:history';
/** resources key: the last production re-point golive performed (`promote:production`/`release:rollback`). */
export const RELEASED_KEY = 'deployed:release';
/** How many deployment identities the history keeps. A short trail of what golive itself made, not a deploy log. */
export const DEPLOY_HISTORY_LIMIT = 8;
/** The step ids a deploy records (see deployLink and releaseLink): forgotten with the project's facts. */
const DEPLOY_STEPS = ['deploy:production', 'deploy:production:final', 'preview:deploy'];

/**
 * Record a successful deploy of `target`: the `deployed:<target>` time marker the deploy link reads,
 * plus — only when the provider reported one — its own deployment identity under
 * `deployed:<target>:id` as `provider|id|url|<time>`, the name a promotion or rollback of exactly
 * that deployment would use. A provider that reports no id records the marker alone; golive never
 * derives an identity from the URL, and a deploy that reports none clears a stale one. The same
 * identity is pushed onto `deployed:history` (newest first, bounded), which is what a rollback picks
 * its target from. Also clears this target's pending-redeploy marker: this deployment picked up
 * every env write so far.
 */
export function recordDeploy(ctx: Ctx, provider: string, target: Exclude<EnvTarget, 'development'>, deployment: { url: string; id?: string }): void {
  ctx.state.save((s) => {
    const at = new Date().toISOString();
    s.resources[deployedKey(target)] = at;
    delete s.resources[redeployKey(target)];
    if (deployment.id) {
      s.resources[deployedIdKey(target)] = [provider, deployment.id, deployment.url, at].join('|');
      s.resources[DEPLOY_HISTORY_KEY] = withHistory(s.resources[DEPLOY_HISTORY_KEY], { target, provider, id: deployment.id, url: deployment.url, at, production: target === 'production' });
    } else delete s.resources[deployedIdKey(target)];
  });
}

/**
 * One deployment golive recorded: the provider's own identity, the env target it was BUILT for, and
 * whether production has served it. Secret-free (provider ids, deployment ids, URLs, times).
 */
export interface DeploymentRecord {
  target: Exclude<EnvTarget, 'development'>;
  provider: string;
  id: string;
  url: string;
  /** When golive recorded this deployment's identity (ISO). */
  at: string;
  /** A production deploy, or a deployment a promotion/rollback made production. */
  production: boolean;
}

/** Parse the history, dropping anything that is not a complete record: unreadable history is no history. */
function parseHistory(raw: string | undefined): DeploymentRecord[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((e): e is DeploymentRecord => {
    const r = e as Partial<DeploymentRecord>;
    if (!r || typeof r !== 'object') return false;
    if (r.target !== 'preview' && r.target !== 'production') return false;
    return typeof r.provider === 'string' && typeof r.id === 'string' && typeof r.url === 'string' && typeof r.at === 'string' && typeof r.production === 'boolean';
  });
}

/** `<entry>` in front of the history, its own earlier record replaced, capped at DEPLOY_HISTORY_LIMIT. */
function withHistory(raw: string | undefined, entry: DeploymentRecord): string {
  const previous = parseHistory(raw);
  const rest = previous.filter((e) => !(e.provider === entry.provider && e.id === entry.id));
  // A deployment that ever reached production keeps that stamp when it is recorded again.
  const production = entry.production || previous.some((e) => e.provider === entry.provider && e.id === entry.id && e.production);
  return JSON.stringify([{ ...entry, production }, ...rest].slice(0, DEPLOY_HISTORY_LIMIT));
}

/** The deployment identities golive recorded, newest first. */
export function readDeployHistory(ctx: Ctx): DeploymentRecord[] {
  return parseHistory(ctx.state.resource(DEPLOY_HISTORY_KEY));
}

/**
 * The deployment production served before `prod` according to golive's own record: the next record
 * after it that reached production through the same provider. A rollback target is never anything
 * golive did not create and record, so this is the only source the rollback step takes one from.
 */
export function previousProductionDeploy(history: DeploymentRecord[], prod: { provider: string; id: string }): DeploymentRecord | null {
  const at = history.findIndex((e) => e.provider === prod.provider && e.id === prod.id);
  const rest = at >= 0 ? history.slice(at + 1) : history.filter((e) => !(e.provider === prod.provider && e.id === prod.id));
  return rest.find((e) => e.production && e.provider === prod.provider) ?? null;
}

/** The last production re-point golive performed, as state records it. */
export interface RecordedRelease {
  kind: 'promote' | 'rollback';
  /** The hosting provider golive re-pointed through. */
  provider: string;
  /** The deployment golive made production. */
  id: string;
  url: string;
  /** The provider's id for what production served before this release, or null when it reported none. */
  displaced: string | null;
  /** When golive released it (ISO). */
  at: string;
}

/**
 * Record a production re-point golive performed (`promote:production`/`release:rollback`): the release
 * itself (`deployed:release` = `kind|provider|id|url|displaced|<time>`, the evidence the
 * `production-release` check re-reads against the provider) and the production pointer, so the deploy
 * bookkeeping keeps describing what production serves. The deployment's own history record moves to
 * the front and is marked production — it keeps the env target it was built for, and the newest-first
 * order is what makes the previous production deployment readable for a later rollback.
 */
export function recordRelease(ctx: Ctx, release: Omit<RecordedRelease, 'at'> & { target: Exclude<EnvTarget, 'development'> }): void {
  ctx.state.save((s) => {
    const at = new Date().toISOString();
    s.resources[RELEASED_KEY] = [release.kind, release.provider, release.id, release.url, release.displaced ?? '', at].join('|');
    s.resources[DEPLOYED_KEY] = at;
    s.resources[deployedIdKey('production')] = [release.provider, release.id, release.url, at].join('|');
    s.resources[DEPLOY_HISTORY_KEY] = withHistory(s.resources[DEPLOY_HISTORY_KEY], { target: release.target, provider: release.provider, id: release.id, url: release.url, at, production: true });
  });
}

/** The last release golive recorded, or null when state has none (or an unreadable one). */
export function readRelease(ctx: Ctx): RecordedRelease | null {
  const raw = ctx.state.resource(RELEASED_KEY);
  if (!raw) return null;
  const [kind, provider, id, url, displaced, at] = raw.split('|');
  if ((kind !== 'promote' && kind !== 'rollback') || !provider || !id || !url || !at) return null;
  return { kind, provider, id, url, displaced: displaced || null, at };
}

/** When golive last deployed production successfully (state), or undefined if it never did. */
export function lastDeployAt(ctx: Ctx): string | undefined {
  const at = ctx.state.resource(DEPLOYED_KEY);
  if (at) return at;
  // State written before DEPLOYED_KEY existed: a done deploy step counts.
  const steps = ctx.state.get().steps;
  const done = DEPLOY_STEPS.map((id) => steps[id]).filter((r) => r?.status === 'done');
  return done.map((r) => r!.at).sort().at(-1);
}

/** The deployment golive recorded for `target`: the provider's own identity and the URL it made. */
export interface RecordedDeploy {
  /** Provider id golive deployed through (e.g. `vercel`). */
  provider: string;
  /** The deployment id the provider itself reported. */
  id: string;
  url: string;
  /** When golive recorded it (ISO). */
  at: string;
}

/**
 * Read back what `recordDeploy` recorded for `target` (`<provider>|<deployment id>|<url>|<time>`), or
 * null when state has none. Only a provider-reported identity is ever stored here, so a value that
 * does not parse is treated as nothing recorded rather than as a deployment golive can name.
 */
export function readRecordedDeploy(ctx: Ctx, target: Exclude<EnvTarget, 'development'>): RecordedDeploy | null {
  const raw = ctx.state.resource(deployedIdKey(target));
  if (!raw) return null;
  const [provider, id, url, at] = raw.split('|');
  return provider && id && url && at ? { provider, id, url, at } : null;
}

/**
 * Forget the deploy facts that belonged to a host project golive just removed: the recorded deploy
 * time(s), the recorded deployment identity (`deployed:<target>:id`), the bounded deployment history
 * (`deployed:history`), the recorded release (`deployed:release`) and the completed deploy step
 * evidence (production and the opt-in preview). A project created again in the same repo must be
 * deployed again instead of inheriting "production was deployed" (which plans no deploy at all), and
 * the identity of a deployment that project no longer serves must not outlive it — nor may a later
 * rollback name one. Failed records and every other key are left as they are.
 */
export function forgetDeployFacts(ctx: Ctx): void {
  ctx.state.save((s) => {
    // Every deploy fact lives under `deployed:`, so one prefix rule covers the whole family.
    for (const key of Object.keys(s.resources)) if (key.startsWith('deployed:')) delete s.resources[key];
    for (const id of DEPLOY_STEPS) if (s.steps[id]?.status === 'done') delete s.steps[id];
  });
}

/** Time of a production env write not yet deployed, if any. */
export function pendingRedeploy(ctx: Ctx): string | undefined {
  return ctx.state.resource(REDEPLOY_KEY);
}

export async function hostUrl(ctx: Ctx, target: EnvTarget): Promise<string | null> {
  const h = await ready(ctx, 'hosting', 'url');
  if (!h) return null;
  try {
    const u = await h.cap.get(ctx, target);
    return u ? u.replace(/\/+$/, '') : null;
  } catch {
    return null;
  }
}

export function joinUrl(base: string, path: string): string {
  if (/^https?:\/\//.test(path)) return path;
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

export function uniq<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

// ── Env planning (shared by env, payments keys, email keys, webhook) ───────────────────────────────

export const SECRET_KEYS: ReadonlySet<OutputKey> = new Set<OutputKey>(['supabase.secretKey', 'db.url', 'db.directUrl', 'stripe.secretKey', 'stripe.webhookSecret', 'resend.apiKey']);

/** Env names the code references, mapped to semantic keys (client-exposed secrets are never mapped). */
export function mappedEnv(ctx: Ctx): EnvMapping[] {
  return mapEnv(ctx.detect.envRefs).mapped;
}

export function namesFor(ctx: Ctx, key: OutputKey): string[] {
  return mappedEnv(ctx)
    .filter((m) => m.key === key)
    .map((m) => m.name);
}

export function isManaged(ctx: Ctx, name: string, target: EnvTarget): boolean {
  return Boolean(ctx.state.get().secrets[`${name}@${target}`]);
}

/** Names present on the host for `target`, or null when they can't be observed yet. */
export async function observeNames(ctx: Ctx, env: EnvStore, target: EnvTarget, hostPending: boolean): Promise<Set<string> | null> {
  if (hostPending) return null;
  try {
    return new Set(await env.listNames(ctx, target));
  } catch {
    return null;
  }
}

export interface EnvDecision {
  /** Names to write, with whether they are new or golive-managed updates. */
  write: Array<{ name: string; action: 'add' | 'update' }>;
  /** Present on the host but not written by golive: left alone. */
  keep: string[];
  /** The host couldn't be observed at plan time; run() re-checks before writing. */
  recheck: boolean;
}

/** State key recording WHAT filled an env var (e.g. "stripe.secretKey|stripe|live"), never its value. */
export const envSourceKey = (name: string, target: EnvTarget): string => `env:${name}@${target}`;

/**
 * A name is written if missing, or if golive wrote it before (fingerprint in state) and what should
 * fill it changed (`sourceOf`: provider, mode, public-value fingerprint). Without `sourceOf`, managed
 * names are always rewritten. Names someone else set are never touched.
 */
export function decideEnv(ctx: Ctx, target: EnvTarget, names: string[], present: Set<string> | null, sourceOf?: (name: string) => string): EnvDecision {
  const out: EnvDecision = { write: [], keep: [], recheck: present === null };
  for (const name of uniq(names)) {
    if (!present || !present.has(name)) out.write.push({ name, action: 'add' });
    else if (!isManaged(ctx, name, target)) out.keep.push(name);
    else if (!sourceOf || ctx.state.resource(envSourceKey(name, target)) !== sourceOf(name)) out.write.push({ name, action: 'update' });
  }
  return out;
}

export function envPreview(d: EnvDecision, describe: (name: string) => string): string[] {
  const lines = d.write.map((w) => `${w.action === 'add' ? 'add' : 'update (managed by golive)'} ${w.name} ← ${describe(w.name)}`);
  for (const k of d.keep) lines.push(`keep ${k} (already set, not managed by golive)`);
  if (d.recheck) lines.push('host project not observable yet: names found already set (and not managed by golive) at apply time are kept');
  return lines;
}

export function asSecret(name: string, value: Value): Secret {
  return value instanceof Secret ? value : new Secret(name, value);
}

/**
 * Write env vars on the host. Secret values go as Secret (the adapter delivers them via body/stdin)
 * and are marked sensitive; every written value is fingerprinted into state (golive-managed).
 * A production write also records a pending redeploy in state (cleared by a successful deploy), so
 * the need to redeploy survives a failed or skipped deploy step.
 */
export async function writeEnv(
  sctx: StepContext,
  env: EnvStore,
  target: EnvTarget,
  entries: Array<{ name: string; key: OutputKey; value: Value; source?: string }>,
  recheck: boolean,
): Promise<{ changes: string[]; written: string[] }> {
  const changes: string[] = [];
  const written: string[] = [];
  const present = recheck ? new Set(await env.listNames(sctx, target)) : null;
  for (const e of entries) {
    if (present?.has(e.name) && !isManaged(sctx, e.name, target)) {
      changes.push(`kept ${e.name} (${target}): already set, not managed by golive`);
      continue;
    }
    const secret = SECRET_KEYS.has(e.key) || e.value instanceof Secret;
    const value: Value = secret ? asSecret(e.name, e.value) : e.value;
    await env.set(sctx, e.name, value, [target], { sensitive: secret });
    if (target === 'production') sctx.remember(REDEPLOY_KEY, new Date().toISOString());
    if (value instanceof Secret) sctx.rememberSecret(e.name, target, value);
    else sctx.rememberValue(e.name, target, value);
    if (e.source) sctx.remember(envSourceKey(e.name, target), e.source);
    written.push(e.name);
    changes.push(`set ${e.name} (${target})${value instanceof Secret ? ` fp:${value.fingerprint}` : ''}`);
  }
  return { changes, written };
}

/**
 * Step-scoped verification: the names THIS step wrote now exist in `target`. (The cross-target
 * env-parity check stays for `verify`: it also covers names later steps haven't written yet.)
 */
export async function verifyEnvWritten(ctx: Ctx, env: EnvStore, target: EnvTarget, names: string[], stepId: string, hostTitle: string): Promise<CheckResult[]> {
  if (!names.length) return [];
  const id = `${stepId}:env-written`;
  const title = `${hostTitle} ${target} env has the names this step set`;
  let present: Set<string>;
  try {
    present = new Set(await env.listNames(ctx, target));
  } catch (e) {
    return [{ id, title, status: 'fail', severity: 'high', evidence: [`could not list ${target} env names: ${errMsg(e)}`], fix: 'Check the hosting login, then re-run apply.' }];
  }
  const missing = names.filter((n) => !present.has(n));
  if (missing.length) {
    return [{ id, title, status: 'fail', severity: 'high', evidence: [`${target}: still missing after the write: ${missing.join(', ')}`], fix: `${hostTitle} did not keep ${missing.join(', ')} (${target}); check its dashboard, then re-run apply.` }];
  }
  return [{ id, title, status: 'pass', severity: 'info', evidence: [`${target}: ${names.join(', ')} present`] }];
}

// ── Outputs availability ──────────────────────────────────────────────────────────────────────────

/** Optional, non-contract extension: declare which keys `outputs()` can supply without fetching them. */
type OutputsWithProvides = OutputsProvider & { provides?(ctx: Ctx, target: EnvTarget, requestedKeys?: readonly OutputKey[]): Promise<OutputKey[]> };

/**
 * Which output keys a provider can supply for `target`, or null if unknown. Prefers a `provides()`
 * declaration; otherwise calls outputs() and keeps only the key names (values are dropped at once).
 */
export async function availableKeys(ctx: Ctx, outputs: OutputsProvider, target: EnvTarget, requestedKeys?: readonly OutputKey[]): Promise<Set<OutputKey> | null> {
  const o = outputs as OutputsWithProvides;
  try {
    if (o.provides) return new Set(await o.provides(ctx, target, requestedKeys));
    const out: Outputs = await o.outputs(ctx, target, requestedKeys);
    return new Set((Object.keys(out) as OutputKey[]).filter((k) => out[k] !== undefined));
  } catch {
    return null;
  }
}

// ── Secret-exposure guard ─────────────────────────────────────────────────────────────────────────

export interface Exposure {
  /** Critical offline findings (detect + env mapping), deduplicated. */
  findings: Finding[];
  /** Every secret write is blocked (a critical finding names no specific variable). */
  all: boolean;
  /** Env names whose secret writes are blocked. */
  names: Set<string>;
}

const OUTPUT_KEYS: OutputKey[] = ['supabase.url', 'supabase.publishableKey', 'supabase.secretKey', 'db.url', 'db.directUrl', 'stripe.secretKey', 'stripe.publishableKey', 'stripe.webhookSecret', 'resend.apiKey', 'app.url'];

/**
 * A CRITICAL offline finding (e.g. a framework config that inlines a server secret into the browser
 * bundle, or a client-prefixed secret name) means writing that secret to the host would publish it
 * with the next deploy. Affected names = env names the finding mentions, plus every name mapped to a
 * semantic key it mentions (e.g. "(stripe.secretKey)"); a finding that names neither blocks all
 * secret writes.
 */
export function exposure(ctx: Ctx): Exposure {
  const seen = new Set<string>();
  const findings: Finding[] = [];
  for (const f of [...(ctx.detect.findings ?? []), ...mapEnv(ctx.detect.envRefs).findings]) {
    if (f.severity !== 'critical') continue;
    const k = `${f.id}|${f.title}`;
    if (seen.has(k)) continue;
    seen.add(k);
    findings.push(f);
  }
  const out: Exposure = { findings, all: false, names: new Set() };
  if (!findings.length) return out;
  const mapped = mappedEnv(ctx);
  const known = new Set([...ctx.detect.envRefs.map((r) => r.name), ...mapped.map((m) => m.name)]);
  for (const f of findings) {
    const text = [f.title, ...f.evidence].join(' ');
    const tokens = new Set(text.split(/[^A-Za-z0-9_]+/).filter(Boolean));
    const names = [...known].filter((n) => tokens.has(n));
    const keys = OUTPUT_KEYS.filter((k) => text.includes(k));
    for (const m of mapped) if (keys.includes(m.key)) names.push(m.name);
    if (!names.length && !keys.length) out.all = true;
    names.forEach((n) => out.names.add(n));
  }
  return out;
}

/** Is writing `name` (filled from `key`) blocked by a critical exposure finding? */
export function secretBlocked(ctx: Ctx, name: string, key: OutputKey): boolean {
  if (!SECRET_KEYS.has(key)) return false;
  const e = exposure(ctx);
  return e.all || e.names.has(name);
}

// ── Destination identity ──────────────────────────────────────────────────────────────────────────

/** The project axis (hosting/db) an adapter serves, if any. */
export function projectAxisFor(ctx: Ctx, adapter: Adapter): Axis | undefined {
  return (['db', 'hosting'] as Axis[]).find((a) => adapterFor(ctx, a)?.id === adapter.id);
}

/**
 * Which project at `adapter` values come from, for env source identity: its id, 'pending' when a step
 * in this plan selects/creates it, '' when the adapter has no project concept, or null when it can't
 * be read right now (callers then keep what state says instead of forcing a rewrite).
 */
export async function projectIdentity(ctx: Ctx, adapter: Adapter, opts: { planning: boolean }): Promise<string | null> {
  const linker = adapter.capabilities.project;
  if (!linker) return '';
  const axis = projectAxisFor(ctx, adapter);
  if (opts.planning && axis && memo(ctx).pendingProjects.has(axis)) return 'pending';
  const read = (): Promise<string | null> =>
    linker.current(ctx).then(
      (p) => p?.id ?? null,
      () => null,
    );
  if (!opts.planning) return read();
  const m = memo(ctx);
  let p = m.identity.get(adapter.id);
  if (!p) m.identity.set(adapter.id, (p = read()));
  return p;
}

/** "<adapter>:<project id>" for a step's intent ('?' when unreadable, 'pending' when this plan links it). */
export async function projectIntent(ctx: Ctx, adapter: Adapter): Promise<string> {
  return `${adapter.id}:${(await projectIdentity(ctx, adapter, { planning: true })) ?? '?'}`;
}
