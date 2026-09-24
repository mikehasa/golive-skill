/**
 * Supabase adapter (db + auth). See docs/PROVIDERS.md.
 *
 * Management API using an explicit SUPABASE_ACCESS_TOKEN or the official CLI browser-login credential.
 * One supported CLI login covers creation, outputs, auth configuration and read-only verification.
 * The limited CLI fallback remains when no reusable credential is available.
 */
import { randomBytes } from 'node:crypto';
import { basename } from 'node:path';
import { credentialVia, SupabaseCredentialError } from './supabase-credentials.js';
import { supabaseAuthUsers } from './supabase-auth.js';
import type {
  Adapter,
  AuthSettings,
  AuthSmtp,
  AuthStatus,
  AuthWrite,
  AuthWriteOutcome,
  Ctx,
  DetectResult,
  EnvTarget,
  Finding,
  OutputKey,
  Outputs,
  ProjectRef,
  ProjectCreateTarget,
  Severity,
  ShipConfig,
  StepContext,
  TableInfo,
  Value,
} from '../core/types.js';
import { Secret, redact, registerSecretValue, vaultGet, vaultPut } from '../core/secret.js';
import {
  CLI_COVERS,
  LOGIN_HELP,
  REF_RE,
  STATE_REF,
  SupabaseError,
  TOKEN_ONLY,
  api,
  apiStatus,
  assertRef,
  cli,
  linkedRef,
  needToken,
  sleep,
  token,
  tokenHelp,
} from './supabase-api.js';

export { SupabaseError } from './supabase-api.js';

/**
 * Poll timing; tests shrink it. `timeoutMs` bounds the wait for an existing project that is starting;
 * `createTimeoutMs` the wait for one golive just created (1–3 min is typical, longer happens).
 */
export const supabaseTiming = { pollMs: 5_000, timeoutMs: 5 * 60_000, createTimeoutMs: 15 * 60_000 };

const dbPassKey = (ref: string): string => `supabase.dbPass:${ref}`;

/**
 * State marker (non-secret): the ref of the project golive itself created. Only such a project may have
 * its database password reset by golive, and only while no env write has used the old one.
 */
export const STATE_CREATED = 'supabase.createdByGolive';

// ── Response shapes (only the fields we read) ───────────────────────────────────────────────────

interface ApiProject {
  id?: string;
  ref?: string;
  name?: string;
  organization_slug?: string;
  organization_id?: string;
  status?: string;
}
interface ApiKey {
  name?: string;
  type?: string | null;
  api_key?: string | null;
}
interface PoolerEntry {
  database_type?: string;
  db_user?: string;
  db_host?: string;
  db_name?: string;
  connection_string?: string;
}
interface Lint {
  name?: string;
  title?: string;
  level?: string;
  detail?: string;
  description?: string;
  remediation?: string;
  cache_key?: string;
}

// ── auth ────────────────────────────────────────────────────────────────────────────────────────

async function auth(ctx: Ctx): Promise<AuthStatus> {
  let tok: Secret | undefined;
  try { tok = await token(ctx); } catch (e) {
    if (e instanceof SupabaseCredentialError) return { ok: false, howToFix: e.message };
    return { ok: false, howToFix: `Could not safely read the Supabase CLI login. ${LOGIN_HELP}.` };
  }
  const via = credentialVia(ctx);
  // When a token is set every operation uses it, so a broken token is a failure even if the CLI works.
  if (tok) {
    let problem: string;
    try {
      const r = await apiStatus(ctx, tok, '/profile');
      if (r.status === 200) {
        const p = (r.json ?? {}) as { username?: unknown; primary_email?: unknown };
        const who = typeof p.username === 'string' ? p.username : typeof p.primary_email === 'string' ? p.primary_email : undefined;
        return { ok: true, via: `${via}${who ? ` (${who})` : ''}` };
      }
      // /profile requires user-scoped access. A project-scoped token can legitimately get 403
      // here while it can operate on its selected project; listing alone never proves create access.
      if (r.status === 403) return await scopedAuth(ctx, tok);
      problem = r.status === 401 ? `${via} is invalid or expired` : `Supabase refused ${via} (HTTP ${r.status})`;
    } catch (e) {
      problem = `could not reach api.supabase.com to check ${via} (${redact(e instanceof Error ? e.message : String(e)).slice(0, 200)})`;
    }
    return {
      ok: false,
      howToFix: ctx.envToken('SUPABASE_ACCESS_TOKEN')
        ? `${problem}. Replace it: ${tokenHelp()} Or, to reuse your supabase CLI browser login, remove the SUPABASE_ACCESS_TOKEN line from that file (and from the agent's environment), then re-run. golive never falls back after a rejected explicit token.`
        : `${problem}. Refresh the browser login: ${LOGIN_HELP}. golive will not try another stored credential after a rejection.`,
    };
  }
  if (!(await cliLoggedIn(ctx))) {
    return {
      ok: false,
      howToFix: `Not logged in to Supabase. ${LOGIN_HELP.charAt(0).toUpperCase()}${LOGIN_HELP.slice(1)} (preferred; one login covers the complete flow on supported credential stores). For CI or an unsupported store, ${tokenHelp()} Then re-run.`,
    };
  }
  const needs = await tokenNeeds(ctx);
  if (needs.length) {
    return {
      ok: false,
      howToFix: `Your supabase CLI login works, but its stored credential could not be reused on this installation. The limited CLI fallback covers ${CLI_COVERS}. This app also needs ${needs.join(' and ')}, which requires a reusable CLI credential or an explicit token. Update to a supported Supabase v2 CLI and browser login, or use the explicit token fallback. ${tokenHelp()} Then re-run.`,
    };
  }
  return { ok: true, via: `supabase CLI (limited fallback; covers ${CLI_COVERS}). ${TOKEN_ONLY.charAt(0).toUpperCase()}${TOKEN_ONLY.slice(1)} need a reusable CLI credential or SUPABASE_ACCESS_TOKEN` };
}

async function scopedAuth(ctx: Ctx, tok: Secret): Promise<AuthStatus> {
  const via = credentialVia(ctx);
  const help = ctx.envToken('SUPABASE_ACCESS_TOKEN') ? tokenHelp() : `Check the account selected by your CLI browser login; ${LOGIN_HELP} to refresh it. golive will not switch credentials after a rejection.`;
  const r = await apiStatus(ctx, tok, '/projects');
  if (r.status !== 200) {
    const problem = r.status === 401 ? `${via} is invalid or expired (HTTP 401)` : `The token cannot list accessible Supabase projects (HTTP ${r.status}); /profile HTTP 403 alone does not mean the token is invalid`;
    return { ok: false, howToFix: `${problem}. Check its selected projects and Project Settings Read permission. ${help}` };
  }
  if (!Array.isArray(r.json) || r.json.some((p) => !p || typeof p !== 'object' || !refOf(p as ApiProject))) {
    return { ok: false, howToFix: 'Supabase returned an unexpected project-list response; golive could not verify this token\'s project access. Re-run later or check Supabase service status.' };
  }
  let ref: string | null;
  try {
    ref = await resolveRef(ctx);
  } catch {
    return { ok: false, howToFix: 'This token can list Supabase projects, but the configured project name is missing or ambiguous. Select an existing accessible project by its exact ref with `golive init --project db=<ref>` and re-run; golive has not verified organization or project-creation access.' };
  }
  if (!ref) {
    // Organization-scoped tokens can also lack /profile. Reuse the read-only plan destination
    // checks; this proves the free-plan destination is visible, never that POST /projects is allowed.
    try {
      const target = await creationTarget(ctx);
      return { ok: true, via: `${via} (organization-scoped read access verified for Free organization ${target.scope.id}; creation write permission unverified; plan/apply checks the destination and permissions)` };
    } catch {
      return { ok: false, howToFix: `This token can list projects but cannot read the user profile (HTTP 403), and no existing project is explicitly selected. golive could not verify one eligible Free organization through organization discovery and plan details. Select an accessible existing project with \`golive init --project db=<ref>\`, or check Organizations Read and Organization Settings Read access to the intended Free organization (with Organization Projects Read-write to create). An empty or denied organization list does not prove creation access; project-scoped Full access does not grant that. ${help}` };
    }
  }
  if (!(r.json as ApiProject[]).some((p) => refOf(p) === ref && p.status !== 'REMOVED' && p.status !== 'GOING_DOWN')) {
    return { ok: false, howToFix: `The selected Supabase project ${ref} is not visible to this token. Check the token's selected project and Project Settings Read permission, or select an accessible existing project with \`golive init --project db=<ref>\`. ${help}` };
  }
  return { ok: true, via: `${via} (project-scoped access verified for ${ref}; each operation checks its own permissions; organization/creation access not verified)` };
}

/**
 * With only a CLI login: what this app needs that golive's CLI fallback does not implement. Auth redirects (auth=supabase)
 * and creating the project (nothing linked, nothing to adopt) would otherwise fail at apply time.
 */
async function tokenNeeds(ctx: Ctx): Promise<string[]> {
  const needs: string[] = [];
  if (ctx.config.stack.auth === 'supabase') needs.push('Supabase auth redirect settings (site URL and allowed redirect URLs)');
  if (ctx.config.stack.db === 'supabase') {
    let needsCreate: boolean;
    try {
      if (await resolveRef(ctx)) needsCreate = false;
      else {
        const name = repoName(ctx);
        needsCreate = !(await adoptable(ctx)).some((p) => p.name.toLowerCase() === name);
      }
    } catch {
      needsCreate = false; // listing failed: plan surfaces that error itself; don't guess
    }
    if (needsCreate) needs.push(`creating the Supabase project (none is linked and no project named "${repoName(ctx)}" can be adopted)`);
  }
  return needs;
}

/** Same rule as links/util repoName (adapters don't import links). */
function repoName(ctx: Ctx): string {
  const s = basename(ctx.cwd)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63);
  return s || 'app';
}

/** Org slugs the logged-in CLI can see (null = not logged in / not installed). Memoized per run. */
async function cliOrgs(ctx: Ctx): Promise<string[] | null> {
  const key = 'supabase.cliOrgs';
  if (ctx.cache.has(key)) return ctx.cache.get(key) as string[] | null;
  let out: string[] | null = null;
  try {
    const r = await ctx.exec('supabase', ['orgs', 'list', '-o', 'json'], { cwd: ctx.cwd, timeoutMs: 30_000 });
    if (r.code === 0) {
      out = [];
      try {
        const raw = JSON.parse(r.stdout.trim() || '[]') as unknown;
        for (const o of Array.isArray(raw) ? (raw as Array<{ id?: unknown; slug?: unknown }>) : []) {
          const slug = typeof o.slug === 'string' ? o.slug : typeof o.id === 'string' ? o.id : undefined;
          if (slug) out.push(slug);
        }
      } catch {
        /* logged in, org list unreadable: treat as unknown orgs */
      }
    }
  } catch {
    out = null;
  }
  ctx.cache.set(key, out);
  return out;
}

async function cliLoggedIn(ctx: Ctx): Promise<boolean> {
  return (await cliOrgs(ctx)) !== null;
}

// ── project ─────────────────────────────────────────────────────────────────────────────────────

const refOf = (p: ApiProject): string | undefined => [p.ref, p.id].find((x) => typeof x === 'string' && REF_RE.test(x));

type Listed = ProjectRef & { org?: string; status?: string };

/** Paused (free projects pause after inactivity): needs a restore, which is the human's call. */
const PAUSED = new Set(['INACTIVE', 'PAUSING', 'PAUSED']);
/** Will never become usable without human action. */
const BROKEN = new Set(['INIT_FAILED', 'RESTORE_FAILED', 'PAUSE_FAILED']);
/** On its way to ACTIVE_HEALTHY: wait for it before using it. */
const STARTING = new Set(['COMING_UP', 'RESTORING', 'UPGRADING', 'RESIZING']);

async function listProjects(ctx: Ctx): Promise<Listed[]> {
  const what = 'Listing Supabase projects';
  const tok = await token(ctx);
  const raw = tok ? await api<ApiProject[]>(ctx, tok, 'GET', '/projects', what) : await cli<ApiProject[]>(ctx, ['projects', 'list', '-o', 'json'], what);
  const out: Listed[] = [];
  for (const p of Array.isArray(raw) ? raw : []) {
    const ref = refOf(p);
    if (!ref || p.status === 'REMOVED' || p.status === 'GOING_DOWN') continue;
    // Older CLIs print the org slug as organization_id.
    const org = typeof p.organization_slug === 'string' ? p.organization_slug : typeof p.organization_id === 'string' ? p.organization_id : undefined;
    out.push({ id: ref, name: typeof p.name === 'string' ? p.name : ref, ...(org ? { org } : {}), ...(typeof p.status === 'string' ? { status: p.status } : {}) });
  }
  return out;
}

function remember(ctx: Ctx, ref: string): void {
  ctx.state.save((s) => {
    s.resources[STATE_REF] = ref;
  });
}

/** Resolve the project ref without enriching it (state → config → supabase link file). */
async function resolveRef(ctx: Ctx): Promise<string | null> {
  const fromState = ctx.state.resource(STATE_REF);
  if (fromState && REF_RE.test(fromState)) return fromState;
  const cfg = ctx.config.projects?.db;
  if (cfg) {
    if (REF_RE.test(cfg)) return cfg;
    const byName = (await listProjects(ctx)).filter((p) => p.name === cfg);
    if (byName.length === 1) return byName[0]!.id;
    if (byName.length > 1) throw new SupabaseError(`golive.yaml projects.db "${cfg}" matches several Supabase projects (${byName.map((p) => p.id).join(', ')}); set it to the project ref instead.`);
    throw new SupabaseError(`golive.yaml projects.db "${cfg}" does not match any Supabase project this account can see; set it to an existing project ref or name.`);
  }
  return linkedRef(ctx.cwd) ?? null;
}

async function requireRef(ctx: Ctx): Promise<string> {
  const ref = await resolveRef(ctx);
  if (!ref) {
    throw new SupabaseError('No Supabase project is selected for this app. Select one (golive plan lists candidates), set `projects.db` in golive.yaml to a project ref, or run `supabase link` in the repo.');
  }
  return ref;
}

async function current(ctx: Ctx): Promise<ProjectRef | null> {
  const ref = await resolveRef(ctx);
  if (!ref) return null;
  const tok = await token(ctx);
  if (tok) {
    try {
      const r = await apiStatus(ctx, tok, `/projects/${ref}`);
      const name = (r.json as ApiProject | undefined)?.name;
      if (r.status === 200 && typeof name === 'string') return { id: ref, name };
    } catch {
      /* best effort: the ref alone is enough */
    }
  }
  return { id: ref, name: ref };
}

/**
 * The org this app's project belongs in: the account's only org, else its single free org (where
 * create() would put it). undefined = ambiguous, so nothing is adopted by name alone. Memoized.
 */
async function homeOrg(ctx: Ctx): Promise<string | undefined> {
  const key = 'supabase.homeOrg';
  if (ctx.cache.has(key)) return ctx.cache.get(key) as string | undefined;
  let home: string | undefined;
  const tok = await token(ctx);
  if (tok) {
    const slugs = await orgSlugs(ctx, tok);
    if (slugs.length === 1) home = slugs[0];
    else if (slugs.length > 1) {
      const free = await freeOrgs(ctx, tok, slugs);
      if (free.length === 1) home = free[0];
    }
  } else {
    const slugs = await cliOrgs(ctx);
    if (slugs && slugs.length === 1) home = slugs[0];
  }
  ctx.cache.set(key, home);
  return home;
}

/** Why an existing project won't be adopted automatically, or null if it can be. */
function notAdoptable(p: Listed, home: string | undefined): string | null {
  if (p.status && PAUSED.has(p.status)) return `it is paused (status ${p.status}); restore it at https://supabase.com/dashboard/project/${p.id} first (restoring a free project costs nothing)`;
  if (p.status && BROKEN.has(p.status)) return `it is not usable (status ${p.status}); check it at https://supabase.com/dashboard/project/${p.id}`;
  if (!home) return `it is in organization ${p.org ?? '(unknown)'} and this account has several organizations, so golive can't tell whether that is this app's`;
  if (p.org && p.org !== home) return `it is in organization ${p.org}, not ${home} (where golive would create this app's project)`;
  return null;
}

/** Existing projects that may be adopted by name: in the home org, not paused or failed. */
async function adoptable(ctx: Ctx): Promise<Listed[]> {
  const all = await listProjects(ctx);
  const home = all.length ? await homeOrg(ctx) : undefined;
  return all.filter((p) => notAdoptable(p, home) === null);
}

/**
 * Candidates are what the plan may adopt BY NAME, so only projects that are safe to adopt without
 * asking: same org as this app's, and not paused/failed. Others are named by create() when it
 * refuses to make a duplicate, and can always be chosen explicitly (`init --project db=<ref>`).
 */
async function candidates(ctx: Ctx): Promise<ProjectRef[]> {
  return (await adoptable(ctx)).map(({ id, name }) => ({ id, name }));
}

async function select(ctx: Ctx, idOrName: string): Promise<ProjectRef> {
  const all = await listProjects(ctx);
  const byId = all.find((p) => p.id === idOrName);
  const matches = byId ? [byId] : all.filter((p) => p.name === idOrName);
  if (matches.length > 1) throw new SupabaseError(`Several Supabase projects are named "${idOrName}" (${matches.map((p) => `${p.id} in ${p.org ?? '?'}`).join(', ')}); select one by its ref.`);
  const p = matches[0];
  if (!p) {
    const names = all.map((x) => `${x.name} (${x.id})`).join(', ') || 'none';
    throw new SupabaseError(`No Supabase project "${idOrName}" in this account. Available: ${names}.`);
  }
  await ensureUsable(ctx, p);
  remember(ctx, p.id);
  return { id: p.id, name: p.name, ...(p.org ? { scope: { kind: 'organization' as const, id: p.org } } : {}) };
}

/** Resolve without linking state, so the project owner is visible before approval. */
async function resolveProject(ctx: Ctx, idOrName: string): Promise<ProjectRef> {
  const all = await listProjects(ctx);
  const byId = all.find((p) => p.id === idOrName);
  const matches = byId ? [byId] : all.filter((p) => p.name === idOrName);
  if (matches.length !== 1 || !matches[0]!.org) throw new SupabaseError('Supabase could not confirm one exact project and its organization. Select an accessible project ref and re-plan.');
  const p = matches[0]!;
  return { id: p.id, name: p.name, scope: { kind: 'organization', id: p.org! } };
}

/** Refuse a paused/failed project (with what to do); wait for one that is still starting. */
async function ensureUsable(ctx: Ctx, p: Listed): Promise<void> {
  if (p.status && PAUSED.has(p.status)) {
    throw new SupabaseError(`Supabase project ${p.name} (${p.id}) is paused (status ${p.status}). Restore it at https://supabase.com/dashboard/project/${p.id} (free for free projects), wait until it is active, then re-run.`);
  }
  if (p.status && BROKEN.has(p.status)) {
    throw new SupabaseError(`Supabase project ${p.name} (${p.id}) is not usable (status ${p.status}). Check it at https://supabase.com/dashboard/project/${p.id}, or choose another project.`);
  }
  if (p.status && STARTING.has(p.status)) {
    ctx.log.info(`Supabase project ${p.name} (${p.id}) is ${p.status}; waiting for it to become healthy`);
    await waitHealthy(ctx, p.id);
  }
}

function regionSelection(cfg: ShipConfig): { type: 'smartGroup' | 'specific'; code: string } {
  const code = cfg.supabase?.region;
  if (typeof code !== 'string' || !code) return { type: 'smartGroup', code: 'americas' };
  return ['americas', 'emea', 'apac'].includes(code) ? { type: 'smartGroup', code } : { type: 'specific', code };
}

async function orgSlugs(ctx: Ctx, tok: Secret): Promise<string[]> {
  const orgs = await api<Array<{ slug?: string; name?: string }>>(ctx, tok, 'GET', '/organizations', 'Listing Supabase organizations');
  for (const o of Array.isArray(orgs) ? orgs : []) {
    if (typeof o.slug === 'string' && typeof o.name === 'string') ctx.cache.set(`supabase.orgName:${o.slug}`, o.name);
  }
  return (Array.isArray(orgs) ? orgs : []).map((o) => o.slug).filter((s): s is string => typeof s === 'string' && s.length > 0);
}

async function freeOrgs(ctx: Ctx, tok: Secret, slugs: string[]): Promise<string[]> {
  const free: string[] = [];
  for (const slug of slugs) {
    const o = await api<{ plan?: string }>(ctx, tok, 'GET', `/organizations/${encodeURIComponent(slug)}`, `Reading Supabase organization ${slug}`);
    if (o?.plan === 'free') free.push(slug);
  }
  return free;
}

/** The single free-plan org to create in; anything else is a human decision (cost / choice). */
async function freeOrg(ctx: Ctx, tok: Secret): Promise<string> {
  const slugs = await orgSlugs(ctx, tok);
  if (!slugs.length) throw new SupabaseError('This Supabase account has no organization. Create one at https://supabase.com/dashboard/new, then re-run.');
  const free = await freeOrgs(ctx, tok, slugs);
  if (!free.length) {
    throw new SupabaseError(
      `Every Supabase organization here (${slugs.join(', ')}) is on a paid plan, so a new project may cost money (about $10/month of compute). golive will not create it: create the project yourself at https://supabase.com/dashboard/new, then select it.`,
    );
  }
  if (free.length > 1) throw new SupabaseError(`Several free Supabase organizations (${free.join(', ')}); create the project in the one you want at https://supabase.com/dashboard/new, then select it.`);
  return free[0]!;
}

async function creationTarget(ctx: Ctx): Promise<ProjectCreateTarget> {
  const tok = await token(ctx);
  if (!tok) throw needToken('Selecting a Supabase organization for creation');
  const id = await freeOrg(ctx, tok);
  const label = ctx.cache.get(`supabase.orgName:${id}`);
  return { scope: { kind: 'organization', id, ...(typeof label === 'string' ? { name: label } : {}) }, region: regionSelection(ctx.config).code };
}

/** Current status of a project: Management API with a token, else the CLI project list. */
async function projectStatus(ctx: Ctx, ref: string): Promise<string> {
  const tok = await token(ctx);
  if (tok) return (await api<ApiProject>(ctx, tok, 'GET', `/projects/${ref}`, 'Checking the Supabase project'))?.status ?? 'unknown';
  return (await listProjects(ctx)).find((p) => p.id === ref)?.status ?? 'REMOVED';
}

async function waitHealthy(ctx: Ctx, ref: string, opts: { created?: boolean } = {}): Promise<void> {
  const timeoutMs = opts.created ? supabaseTiming.createTimeoutMs : supabaseTiming.timeoutMs;
  const deadline = Date.now() + timeoutMs;
  let status = 'unknown';
  for (;;) {
    status = await projectStatus(ctx, ref);
    if (status === 'ACTIVE_HEALTHY') return;
    if (BROKEN.has(status) || status === 'REMOVED' || PAUSED.has(status)) throw new SupabaseError(`Supabase project ${ref} failed to start (status ${status}). Check it at https://supabase.com/dashboard/project/${ref}.`);
    if (Date.now() >= deadline) break;
    await sleep(supabaseTiming.pollMs);
  }
  const mins = Math.round(timeoutMs / 60_000);
  if (opts.created) {
    throw new SupabaseError(
      `Supabase project ${ref} (created by golive) is still starting (status ${status}) after ${mins} min. It is recorded in golive state: re-run later and golive waits for it and carries on. The database password generated for it lives only in this run's memory; if it is gone by then, golive sets a new one on this project (nothing can be using it yet).`,
    );
  }
  throw new SupabaseError(`Supabase project ${ref} is still starting (status ${status}) after ${mins} min; re-run later — golive will adopt it by name.`);
}

/** POST /v1/projects can take a while and must never be re-sent (no idempotency key exists). */
const CREATE_TIMEOUT_MS = 90_000;

async function create(ctx: Ctx, name: string, approvedTarget?: ProjectCreateTarget): Promise<ProjectRef> {
  const tok = await token(ctx);
  if (!tok) throw needToken('Creating a Supabase project');
  if (approvedTarget) {
    const now = await creationTarget(ctx);
    if (now.scope.kind !== approvedTarget.scope.kind || now.scope.id !== approvedTarget.scope.id || now.region !== approvedTarget.region) {
      throw new SupabaseError('Supabase project organization or region changed since approval; run `plan` again and re-approve. Nothing was created.');
    }
  }
  const all = await listProjects(ctx);
  // Case-insensitive, like planAxis and tokenNeeds: "Demo-App" is this app's "demo-app".
  const sameName = all.filter((p) => p.name.toLowerCase() === name.toLowerCase());
  if (sameName.length) {
    if (approvedTarget) throw new SupabaseError('A Supabase project with this name appeared after approval. Run `plan` again and approve the exact existing project or choose another name.');
    const home = await homeOrg(ctx);
    const ok = sameName.find((p) => notAdoptable(p, home) === null);
    if (ok) {
      ctx.log.info(`adopting existing Supabase project ${ok.name} (${ok.id})`);
      await ensureUsable(ctx, ok);
      remember(ctx, ok.id);
      return { id: ok.id, name: ok.name };
    }
    // Never adopt across orgs or a paused project silently, and never make a same-named duplicate.
    const why = sameName.map((p) => `${p.id}: ${notAdoptable(p, home)}`).join('; ');
    throw new SupabaseError(
      `A Supabase project named "${name}" already exists but golive won't adopt it automatically (${why}). Ask the human which project to use: to use it, run \`init --project db=<ref>\` and \`plan\` again; to get a new project instead, pick another name with \`init --project db=<new-name>\` after creating it at https://supabase.com/dashboard/new.`,
    );
  }
  const org = approvedTarget?.scope.id ?? await freeOrg(ctx, tok);
  const before = new Set(all.map((p) => p.id));
  const dbPass = new Secret('SUPABASE_DB_PASSWORD', randomBytes(24).toString('base64url'));
  let created: ApiProject;
  try {
    created = await api<ApiProject>(
      ctx,
      tok,
      'POST',
      '/projects',
      'Creating the Supabase project',
      { name, organization_slug: org, db_pass: dbPass, region_selection: regionSelection(approvedTarget?.region ? { ...ctx.config, supabase: { ...ctx.config.supabase, region: approvedTarget.region } } : ctx.config) },
      { idempotent: false, timeoutMs: CREATE_TIMEOUT_MS },
    );
  } catch (e) {
    // Timeout / dropped connection / 5xx: Supabase may have created it anyway. Look before failing.
    const status = e instanceof SupabaseError && e.status !== undefined ? e.status : 0;
    if (status > 0 && status < 500) throw e; // a definite refusal: nothing was created
    const found = await findCreated(ctx, name, org, before, !!approvedTarget);
    if (!found) {
      const msg = e instanceof Error ? redact(e.message).slice(0, 300) : 'unknown error';
      throw new SupabaseError(`Creating the Supabase project did not complete (${msg}) and no new project "${name}" is listed in ${org} yet. Check https://supabase.com/dashboard/org/${org} before re-running; a re-run adopts it by name if it appears.`);
    }
    ctx.log.info(`the create request for Supabase project ${name} failed in transit, but Supabase created it (${found}); using it`);
    created = { ref: found, name, organization_slug: org };
  }
  const ref = assertRef(refOf(created ?? {}));
  if (approvedTarget) {
    // A response without its canonical slug needs an independent owner readback before success.
    // organization_id can vary across API/CLI versions, so don't compare that field to a slug here.
    const actualOrg = typeof created.organization_slug === 'string' ? created.organization_slug : (await resolveProject(ctx, ref)).scope?.id;
    if (actualOrg !== approvedTarget.scope.id) throw new SupabaseError('Supabase returned an unexpected project organization; inspect the created resource before continuing.');
  }
  vaultPut(dbPassKey(ref), dbPass); // the password we sent is the one the project got
  ctx.state.save((s) => {
    s.resources[STATE_REF] = ref;
    s.resources[STATE_CREATED] = ref;
  });
  ctx.log.info(`created Supabase project ${name} (${ref}) in ${org}; waiting for it to become healthy`);
  await waitHealthy(ctx, ref, { created: true });
  return { id: ref, name: typeof created.name === 'string' ? created.name : name, ...(approvedTarget ? { scope: approvedTarget.scope } : {}) };
}

/** The ref of exactly one project named `name` in `org` that wasn't there before the create, or null. */
async function findCreated(ctx: Ctx, name: string, org: string, before: Set<string>, requireOrg = false): Promise<string | null> {
  try {
    const fresh = (await listProjects(ctx)).filter((p) => p.name.toLowerCase() === name.toLowerCase() && (p.org === org || !requireOrg && p.org === undefined) && !before.has(p.id));
    return fresh.length === 1 ? fresh[0]!.id : null;
  } catch {
    return null;
  }
}

// ── outputs ─────────────────────────────────────────────────────────────────────────────────────

async function listKeys(ctx: Ctx, ref: string): Promise<ApiKey[]> {
  const what = 'Reading Supabase API keys';
  const tok = await token(ctx);
  const raw = tok
    ? await api<ApiKey[]>(ctx, tok, 'GET', `/projects/${ref}/api-keys?reveal=true`, what)
    : await cli<ApiKey[]>(ctx, ['projects', 'api-keys', '--project-ref', ref, '--reveal', '-o', 'json'], what);
  return Array.isArray(raw) ? raw : [];
}

const usableKey = (k: ApiKey): k is ApiKey & { api_key: string } => typeof k.api_key === 'string' && k.api_key.length > 0 && !k.api_key.includes('*');
const preferDefault = <T extends ApiKey>(ks: T[]): T | undefined => ks.find((k) => k.name === 'default') ?? ks[0];

/** New sb_ keys first; legacy anon/service_role only if the new ones are absent. */
function pickKeys(keys: ApiKey[]): Outputs {
  const usable = keys.filter(usableKey);
  const isSecret = (k: ApiKey & { api_key: string }): boolean => k.type === 'secret' || k.api_key.startsWith('sb_secret_');
  // Defense in depth: every secret-grade value in the response becomes redactable, even unused ones.
  for (const k of usable) if (isSecret(k) || k.name === 'service_role') registerSecretValue(k.api_key, 'supabase-secret-key');

  const pub = preferDefault(usable.filter((k) => k.type === 'publishable' || k.api_key.startsWith('sb_publishable_')));
  const sec = preferDefault(usable.filter(isSecret));
  const anon = usable.find((k) => k.name === 'anon');
  const serviceRole = usable.find((k) => k.name === 'service_role');

  const out: Outputs = {};
  const publishable = pub?.api_key ?? anon?.api_key;
  if (publishable) out['supabase.publishableKey'] = publishable;
  if (sec) out['supabase.secretKey'] = new Secret('SUPABASE_SECRET_KEY', sec.api_key);
  else if (serviceRole) out['supabase.secretKey'] = new Secret('SUPABASE_SERVICE_ROLE_KEY', serviceRole.api_key);
  return out;
}

/**
 * Transaction-mode pooled URL (shared Supavisor, port 6543) from the PRIMARY pooler entry, password
 * substituted in-process. Transaction mode is the right one for serverless hosts: session mode
 * (5432) pins one pooled connection per client and runs out ("max clients reached") under modest
 * concurrency. It has no prepared statements, so Prisma gets `?pgbouncer=true`; other clients are
 * told to disable them (postgres.js / Drizzle: `prepare: false`).
 */
export function pooledUrl(entries: PoolerEntry[], password: string, opts: { prisma?: boolean } = {}): string | undefined {
  const primary = entries.filter((e) => e.database_type === 'PRIMARY');
  const e = primary.find((x) => x.db_host?.includes('pooler.supabase.com')) ?? primary[0];
  if (!e) return undefined;
  const enc = encodeURIComponent(password);
  let url: string | undefined;
  if (typeof e.connection_string === 'string' && e.connection_string.includes(':[YOUR-PASSWORD]@')) {
    url = e.connection_string.replace(':[YOUR-PASSWORD]@', `:${enc}@`);
  } else if (e.db_user && e.db_host && e.db_name) {
    url = `postgresql://${e.db_user}:${enc}@${e.db_host}:6543/${e.db_name}`;
  }
  if (!url) return undefined;
  // On the shared pooler host 5432 is session mode; always hand out the transaction-mode port.
  if (e.db_host?.includes('pooler.supabase.com')) url = url.replace(/:5432\//, ':6543/');
  if (opts.prisma && !/[?&]pgbouncer=/.test(url)) url += `${url.includes('?') ? '&' : '?'}pgbouncer=true`;
  return url;
}

/**
 * Session-mode URL on the shared Supavisor pooler (same PRIMARY host as pooledUrl, port 5432, user
 * postgres.<ref>), for DIRECT_URL and friends. Unlike db.<ref>.supabase.co (IPv6-only without the
 * IPv4 add-on) it is reachable over IPv4 on every plan, so Vercel builds (`prisma migrate deploy`)
 * and functions can use it; session mode supports prepared statements and migrations.
 */
export function sessionUrl(entries: PoolerEntry[], password: string): string | undefined {
  const e = entries.filter((x) => x.database_type === 'PRIMARY').find((x) => x.db_host?.includes('pooler.supabase.com'));
  if (!e) return undefined;
  const enc = encodeURIComponent(password);
  let url: string | undefined;
  if (typeof e.connection_string === 'string' && e.connection_string.includes(':[YOUR-PASSWORD]@')) {
    url = e.connection_string.replace(':[YOUR-PASSWORD]@', `:${enc}@`);
  } else if (e.db_user && e.db_host && e.db_name) {
    url = `postgresql://${e.db_user}:${enc}@${e.db_host}:5432/${e.db_name}`;
  }
  if (!url) return undefined;
  url = url.replace(/:6543\//, ':5432/');
  // pgbouncer=true is a transaction-mode hint for Prisma; session mode has prepared statements.
  return url.replace(/([?&])pgbouncer=[^&]*(&|$)/, (_m, pre: string, post: string) => (post ? pre : '')).replace(/[?&]$/, '');
}

/**
 * Prisma in the repo. Tolerant of every signal detect may give: a schema or config file (root
 * schema.prisma, anything under prisma/ including the prisma/schema/ folder layout, a custom *.prisma
 * path, prisma.config.*), a note or provider id naming Prisma, or a Prisma-style env name referenced.
 */
export function usesPrisma(d: DetectResult): boolean {
  const cfg = Object.keys(d.configs).some((k) => k === 'schema.prisma' || k.startsWith('prisma/') || k.endsWith('.prisma') || /(^|\/)prisma\.config\.[cm]?[jt]s$/.test(k));
  const note = d.notes.some((n) => /\bprisma\b/i.test(n));
  const provider = Object.values(d.providers).some((ids) => ids?.some((id) => /prisma/i.test(id)));
  return cfg || note || provider || d.envRefs.some((r) => r.name === 'POSTGRES_PRISMA_URL');
}

/** Only a step run (StepContext) may write; plan (provides) and checks (outputs) must not. */
const isStepRun = (ctx: Ctx): boolean => typeof (ctx as Partial<StepContext>).rememberSecret === 'function';

/**
 * Has an env write already delivered a DB URL built from `ref`'s current password? Read from the env
 * link's source records ("env:<NAME>@<target>" = "db.url|<sources>|<identities>"; identities are the
 * project ids joined by "+"), plus an explicit "supabase.dbUrlWritten@<target>" marker if present.
 * When the identity is unreadable ("?", "pending") it counts as written: resetting the password
 * under a live DATABASE_URL would break the app, a handoff only delays it.
 */
function dbUrlWritten(ctx: Ctx, ref: string): boolean {
  for (const [k, v] of Object.entries(ctx.state.get().resources)) {
    if (k.startsWith('supabase.dbUrlWritten@') && v === ref) return true;
    if (!k.startsWith('env:')) continue;
    const m = /^db\.(?:url|directUrl)\|[^|]*\|(.*)$/.exec(v);
    if (!m) continue;
    const ids = m[1]!.split('+');
    if (ids.includes(ref) || !ids.some((id) => REF_RE.test(id))) return true;
  }
  return false;
}

/**
 * The generated password of a project golive created is gone (the run vault is in-memory only and the
 * run that created it stopped before any DB URL was written). Nothing can be using that password, so
 * golive may set a new one. Never for an adopted project, never once a DB URL has been written.
 */
async function passwordResettable(ctx: Ctx, ref: string): Promise<boolean> {
  return ctx.state.resource(STATE_CREATED) === ref && !vaultGet(dbPassKey(ref)) && !dbUrlWritten(ctx, ref) && (await token(ctx)) !== undefined;
}

async function resetDbPassword(ctx: Ctx, tok: Secret, ref: string): Promise<Secret> {
  const pass = new Secret('SUPABASE_DB_PASSWORD', randomBytes(24).toString('base64url'));
  await api<unknown>(ctx, tok, 'PATCH', `/projects/${ref}/database/password`, 'Setting a new database password on the Supabase project golive created', { password: pass }, { idempotent: true });
  vaultPut(dbPassKey(ref), pass);
  ctx.log.info(`set a new generated database password on Supabase project ${ref} (created by golive; the one generated at creation was lost with the run that created it, and nothing used it yet)`);
  return pass;
}

async function dbUrls(ctx: Ctx, ref: string, mayReset: boolean): Promise<Outputs> {
  let pass = vaultGet(dbPassKey(ref));
  if (!pass && mayReset && await passwordResettable(ctx, ref)) pass = await resetDbPassword(ctx, (await token(ctx))!, ref);
  if (!pass) return {}; // password unknown (adopted project): the link turns this into a handoff
  const pw = pass.reveal();
  const out: Outputs = {};
  const tok = await token(ctx);
  const entries = tok ? await api<PoolerEntry[]>(ctx, tok, 'GET', `/projects/${ref}/config/database/pooler`, 'Reading Supabase pooler config') : [];
  const list = Array.isArray(entries) ? entries : [];

  const session = sessionUrl(list, pw);
  if (session) out['db.directUrl'] = new Secret('DIRECT_URL', session);
  else {
    out['db.directUrl'] = new Secret('DIRECT_URL', `postgresql://postgres:${encodeURIComponent(pw)}@db.${ref}.supabase.co:5432/postgres`);
    ctx.log.warn(
      `DIRECT_URL for ${ref} falls back to the direct host db.${ref}.supabase.co, which is IPv6-only unless the project has the IPv4 add-on: Vercel builds and functions (IPv4 only) can't reach it (Prisma: P1001). ${tok ? 'Supabase returned no shared-pooler entry' : 'The IPv4 session-pooler URL needs a reusable CLI credential or SUPABASE_ACCESS_TOKEN'}; use it only for migrations from an IPv6-capable machine.`,
    );
  }

  if (!tok) {
    ctx.log.warn(`pooled DATABASE_URL for ${ref} needs a reusable CLI credential or SUPABASE_ACCESS_TOKEN`);
    return out;
  }
  const prisma = usesPrisma(ctx.detect);
  const url = pooledUrl(list, pw, { prisma });
  if (url) {
    out['db.url'] = new Secret('DATABASE_URL', url);
    if (!prisma) {
      ctx.log.warn(
        `DATABASE_URL uses Supabase's transaction pooler (port 6543), which has no prepared statements: with postgres.js or Drizzle pass \`prepare: false\` to the client (node-postgres needs nothing)`,
      );
    }
  } else ctx.log.warn(`Supabase returned no PRIMARY pooler entry for ${ref}; DATABASE_URL not produced`);
  return out;
}

const wantsDbUrls = (keys?: readonly OutputKey[]): boolean => keys === undefined || keys.some((k) => k === 'db.url' || k === 'db.directUrl');

async function collect(ctx: Ctx, ref: string, mayReset: boolean, requestedKeys?: readonly OutputKey[]): Promise<Outputs> {
  const wantsKeys = requestedKeys === undefined || requestedKeys.some((k) => k === 'supabase.publishableKey' || k === 'supabase.secretKey');
  const out: Outputs = {
    'supabase.url': `https://${ref}.supabase.co`,
    ...(wantsKeys ? pickKeys(await listKeys(ctx, ref)) : {}),
    ...(wantsDbUrls(requestedKeys) ? await dbUrls(ctx, ref, mayReset) : {}),
  };
  if (requestedKeys === undefined) return out;
  return Object.fromEntries(Object.entries(out).filter(([k]) => requestedKeys.includes(k as OutputKey))) as Outputs;
}

/** Values for the app. May set a new DB password (see passwordResettable) only inside a step run. */
async function outputs(ctx: Ctx, _target: EnvTarget, requestedKeys?: readonly OutputKey[]): Promise<Outputs> {
  return collect(ctx, await requireRef(ctx), isStepRun(ctx), requestedKeys);
}

/**
 * Keys outputs() will supply at apply time, without writing anything. Same as outputs() (values are
 * read in-process and dropped), plus the DB URLs when the password of a project golive created can be
 * reset during the env write because it was lost before any DB URL was written.
 */
async function provides(ctx: Ctx, _target: EnvTarget, requestedKeys?: readonly OutputKey[]): Promise<OutputKey[]> {
  const ref = await requireRef(ctx);
  const out = await collect(ctx, ref, false, requestedKeys);
  const keys = (Object.keys(out) as OutputKey[]).filter((k) => out[k] !== undefined);
  if (wantsDbUrls(requestedKeys) && !out['db.url'] && !out['db.directUrl'] && await passwordResettable(ctx, ref)) {
    const warned = 'supabase.resetWarned';
    if (!ctx.cache.has(warned)) {
      ctx.cache.set(warned, true);
      ctx.log.warn(
        `Supabase project ${ref} was created by golive, but the database password generated for it is gone (it is kept only in memory, and the run that created the project stopped before DATABASE_URL/DIRECT_URL were written). Nothing can be using that password yet, so apply will set a new generated password on the project when it writes the database URLs.`,
      );
    }
    keys.push(...(['db.url', 'db.directUrl'] as const).filter((k) => requestedKeys === undefined || requestedKeys.includes(k)));
  }
  return keys;
}

// ── dbAdmin ─────────────────────────────────────────────────────────────────────────────────────

/** Exposed schemas from PostgREST config. The response also carries jwt_secret: read db_schema only. */
async function exposedSchemas(ctx: Ctx, tok: Secret, ref: string): Promise<string[]> {
  const res = await api<Record<string, unknown>>(ctx, tok, 'GET', `/projects/${ref}/postgrest`, 'Reading Supabase Data API settings');
  const raw = res && typeof res === 'object' ? res.db_schema : undefined;
  if (typeof raw !== 'string') return ['public'];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => /^[\w$-]+$/.test(s));
}

export function tablesSql(schemas: string[]): string {
  const list = schemas.map((s) => `'${s.replace(/'/g, "''")}'`).join(', ');
  return `select n.nspname as schema, c.relname as name, c.relrowsecurity as rls,
  coalesce((select json_agg(json_build_object('name', p.policyname, 'cmd', p.cmd, 'permissive', p.permissive,
      'roles', p.roles, 'qual', p.qual, 'with_check', p.with_check) order by p.policyname)
    from pg_catalog.pg_policies p where p.schemaname = n.nspname and p.tablename = c.relname), '[]'::json) as policies
from pg_catalog.pg_class c
join pg_catalog.pg_namespace n on n.oid = c.relnamespace
where c.relkind in ('r', 'p') and n.nspname = any(array[${list}]::text[])
order by 1, 2;`;
}

interface PolicyRow {
  name?: unknown;
  cmd?: unknown;
  permissive?: unknown;
  roles?: unknown;
  qual?: unknown;
  with_check?: unknown;
}

function toTableInfo(row: Record<string, unknown>): TableInfo {
  let policies: unknown = row.policies;
  if (typeof policies === 'string') {
    try {
      policies = JSON.parse(policies);
    } catch {
      policies = [];
    }
  }
  return {
    schema: String(row.schema),
    name: String(row.name),
    rls: row.rls === true || row.rls === 't' || row.rls === 'true',
    policies: (Array.isArray(policies) ? (policies as PolicyRow[]) : []).map((p) => ({
      name: String(p.name ?? ''),
      command: String(p.cmd ?? ''),
      permissive: p.permissive === true || String(p.permissive).toUpperCase() === 'PERMISSIVE',
      roles: Array.isArray(p.roles) ? p.roles.map(String) : typeof p.roles === 'string' ? p.roles.replace(/^\{|\}$/g, '').split(',').filter(Boolean) : [],
      ...(typeof p.qual === 'string' ? { using: p.qual } : {}),
      ...(typeof p.with_check === 'string' ? { check: p.with_check } : {}),
    })),
  };
}

function rowsOf(raw: unknown): Array<Record<string, unknown>> {
  const rows = Array.isArray(raw) ? raw : raw && typeof raw === 'object' && Array.isArray((raw as { rows?: unknown }).rows) ? (raw as { rows: unknown[] }).rows : [];
  return rows.filter((r): r is Record<string, unknown> => !!r && typeof r === 'object');
}

async function tables(ctx: Ctx): Promise<TableInfo[]> {
  const ref = await requireRef(ctx);
  const tok = await token(ctx);
  const what = 'Reading Supabase tables and RLS policies';
  const schemas = tok ? await exposedSchemas(ctx, tok, ref) : ['public'];
  if (!schemas.length) return [];
  const sql = tablesSql(schemas);
  const raw = tok
    ? await api<unknown>(ctx, tok, 'POST', `/projects/${ref}/database/query/read-only`, what, { query: sql }, { idempotent: true })
    : await cli<unknown>(ctx, ['db', 'query', '--linked', '--project-ref', ref, '-o', 'json'], what, sql);
  return rowsOf(raw).map(toTableInfo);
}

const LEVEL: Record<string, Severity> = { ERROR: 'high', WARN: 'medium', INFO: 'info' };

async function advisors(ctx: Ctx): Promise<Finding[]> {
  const ref = await requireRef(ctx);
  const tok = await token(ctx);
  if (!tok) throw needToken('Reading Supabase security advisors');
  const res = await api<{ lints?: Lint[] }>(ctx, tok, 'GET', `/projects/${ref}/advisors/security`, 'Reading Supabase security advisors');
  const lints = Array.isArray(res?.lints) ? res.lints : [];
  return lints.map((l) => {
    const name = l.name ?? 'unknown';
    const evidence = [l.detail, l.description].filter((x): x is string => typeof x === 'string' && x.length > 0).map((x) => redact(x));
    return {
      id: `supabase.advisor.${name}${l.cache_key ? `:${l.cache_key}` : ''}`,
      severity: LEVEL[l.level ?? ''] ?? 'info',
      title: l.title ?? name,
      evidence,
      ...(l.remediation ? { fix: `See ${l.remediation}` } : {}),
    };
  });
}

// ── authConfig ──────────────────────────────────────────────────────────────────────────────────

/**
 * The only auth-config fields golive reads or writes, as Supabase names them, and how the two sides
 * map. The same response also carries OAuth provider secrets and an `smtp_pass` hash; a field outside
 * this table is never read, sent or copied into state, evidence or logs.
 */
interface AuthField {
  /** Field name in golive's vocabulary (`smtp.host` is nested in the read shape). */
  name: string;
  /** Management API field name. */
  key: string;
  /** Provider value -> golive value. `undefined` = the provider did not report this field. */
  read(raw: unknown, res: Record<string, unknown>): unknown;
  /** golive value -> request body value. Only fields golive may write have one. */
  write?(value: unknown): unknown;
  /** The provider never returns the value (a write-only secret), so the write cannot be re-read. */
  writeOnly?: boolean;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const bool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined);
const int = (v: unknown): number | undefined => (typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : undefined);
/** Supabase reports some settings in the negative (`disable_signup`, `mailer_autoconfirm`). */
const flip = (v: boolean | undefined): boolean | undefined => (v === undefined ? undefined : !v);
/** A string field a provider may report as unset: '' when present but empty, undefined when absent. */
const optionalStr = (key: string) => (raw: unknown, res: Record<string, unknown>): string | undefined => (Object.hasOwn(res, key) ? (str(raw) ?? '') : undefined);

/** Comma-separated provider list, normalized the same way in both directions. */
const splitList = (raw: string): string[] => raw.split(',').map((s) => s.trim()).filter(Boolean);
function joinList(value: unknown, what: string): string {
  const items = (Array.isArray(value) ? value : []).map((v) => (typeof v === 'string' ? v.trim() : '')).filter(Boolean);
  const bad = items.find((v) => v.includes(','));
  if (bad) throw new SupabaseError(`Supabase ${what} cannot contain commas: ${JSON.stringify(bad)}.`);
  return [...new Set(items)].join(',');
}

function boolOf(key: string, v: unknown): boolean {
  const b = bool(v);
  if (b === undefined) throw new SupabaseError(`Supabase ${key} must be true or false (got ${JSON.stringify(v)}).`);
  return b;
}
function intOf(key: string, v: unknown): number {
  const n = int(v);
  if (n === undefined) throw new SupabaseError(`Supabase ${key} must be a positive whole number (got ${JSON.stringify(v)}).`);
  return n;
}
/** The management API has answered `smtp_port` both as a number and as a numeric string. */
const smtpPort = (v: unknown): number | undefined => int(typeof v === 'string' && /^\d+$/.test(v.trim()) ? Number(v.trim()) : v);

/** The SMTP password is write-only: it must arrive as a Secret and is never read back. */
function smtpPasswordOf(v: unknown): Secret {
  if (!(v instanceof Secret)) throw new SupabaseError(`The Supabase SMTP password must be a Secret (got ${typeof v}).`);
  return v;
}

const AUTH_FIELDS: AuthField[] = [
  {
    name: 'siteUrl',
    key: 'site_url',
    read: (raw) => str(raw) ?? null,
    write: (v) => {
      const url = str(v);
      if (!url || url.includes(',')) throw new SupabaseError(`Supabase site URL must be a single URL without commas (got ${JSON.stringify(v)}).`);
      return url;
    },
  },
  { name: 'redirectUrls', key: 'uri_allow_list', read: (raw) => (typeof raw === 'string' ? splitList(raw) : undefined), write: (v) => joinList(v, 'redirect URLs') },
  { name: 'signupEnabled', key: 'disable_signup', read: (raw) => flip(bool(raw)), write: (v) => flip(boolOf('disable_signup', v)) },
  { name: 'emailConfirmRequired', key: 'mailer_autoconfirm', read: (raw) => flip(bool(raw)), write: (v) => flip(boolOf('mailer_autoconfirm', v)) },
  { name: 'minPasswordLength', key: 'password_min_length', read: int, write: (v) => intOf('password_min_length', v) },
  { name: 'jwtExpirySeconds', key: 'jwt_exp', read: int, write: (v) => intOf('jwt_exp', v) },
  { name: 'otpExpirySeconds', key: 'mailer_otp_exp', read: int, write: (v) => intOf('mailer_otp_exp', v) },
  { name: 'otpLength', key: 'mailer_otp_length', read: int, write: (v) => intOf('mailer_otp_length', v) },
  { name: 'emailRateLimitPerHour', key: 'rate_limit_email_sent', read: int, write: (v) => intOf('rate_limit_email_sent', v) },
  { name: 'smtp.host', key: 'smtp_host', read: optionalStr('smtp_host'), write: (v) => str(v) },
  { name: 'smtp.port', key: 'smtp_port', read: smtpPort, write: (v) => intOf('smtp_port', v) },
  { name: 'smtp.user', key: 'smtp_user', read: optionalStr('smtp_user'), write: (v) => str(v) },
  { name: 'smtp.senderEmail', key: 'smtp_admin_email', read: optionalStr('smtp_admin_email'), write: (v) => str(v) },
  { name: 'smtp.senderName', key: 'smtp_sender_name', read: optionalStr('smtp_sender_name'), write: (v) => str(v) },
  // Write-only: GET answers `smtp_pass` with a hash, never the value.
  { name: 'smtpPassword', key: 'smtp_pass', read: () => undefined, write: smtpPasswordOf, writeOnly: true },
];

/**
 * The SMTP group as golive reports it: `configured` from the host alone, and the blank answers the
 * provider gives for unset fields dropped, so callers never see a `host: ''` that looks like a value.
 */
function smtpOf(reported: AuthSmtp): AuthSmtp {
  const host = str(reported.host);
  const user = str(reported.user);
  const senderEmail = str(reported.senderEmail);
  const senderName = str(reported.senderName);
  return {
    configured: Boolean(host),
    ...(host ? { host } : {}),
    ...(reported.port ? { port: reported.port } : {}),
    ...(user ? { user } : {}),
    ...(senderEmail ? { senderEmail } : {}),
    ...(senderName ? { senderName } : {}),
  };
}

/** Dotted access (`smtp.host`) into the read or write shape. */
function fieldValue(obj: unknown, name: string): unknown {
  const [head, tail] = name.split('.');
  if (!obj || typeof obj !== 'object') return undefined;
  const value = (obj as Record<string, unknown>)[head!];
  if (!tail) return value;
  return value && typeof value === 'object' ? (value as Record<string, unknown>)[tail] : undefined;
}

function setField(obj: AuthSettings, name: string, value: unknown): void {
  const [head, tail] = name.split('.');
  const rec = obj as unknown as Record<string, unknown>;
  if (!tail) {
    rec[head!] = value;
    return;
  }
  const nested = (rec[head!] ??= { configured: false }) as Record<string, unknown>;
  nested[tail] = value;
}

const sameValue = (a: unknown, b: unknown): boolean =>
  Array.isArray(a) && Array.isArray(b) ? a.length === b.length && a.every((x, i) => x === b[i]) : a === b;

/** Secret-free rendering of a non-secret setting value for an evidence line. */
const show = (v: unknown): string => (Array.isArray(v) ? v.join(', ') : v === null || v === undefined ? '(unset)' : String(v));

/** Reads only the whitelisted fields: the rest of the response (provider secrets, the SMTP hash) stops here. */
async function getAuth(ctx: Ctx): Promise<AuthSettings> {
  const ref = await requireRef(ctx);
  const tok = await token(ctx);
  if (!tok) throw needToken('Reading Supabase auth settings');
  const res = await api<Record<string, unknown>>(ctx, tok, 'GET', `/projects/${ref}/config/auth`, 'Reading Supabase auth settings');
  const body = res && typeof res === 'object' && !Array.isArray(res) ? res : {};
  const out: AuthSettings = { siteUrl: null, redirectUrls: [] };
  for (const f of AUTH_FIELDS) {
    const value = f.read(body[f.key], body);
    if (value !== undefined) setField(out, f.name, value);
  }
  if (out.smtp) out.smtp = smtpOf(out.smtp);
  return out;
}

/**
 * PATCH the whitelisted fields this patch requests, then re-read the settings and report what the
 * provider actually kept. A 2xx only means the request was accepted. A field the provider does not
 * report back is listed as unconfirmed (`skipped`) rather than failing the rest of the write, and a
 * reported value that still differs is evidence for the caller, not a silent success.
 */
async function setAuth(ctx: Ctx, patch: AuthWrite): Promise<AuthWriteOutcome> {
  const body: Record<string, unknown> = {};
  const requested: AuthField[] = [];
  for (const f of AUTH_FIELDS) {
    const value = fieldValue(patch, f.name);
    if (value === undefined || !f.write) continue;
    const encoded = f.write(value);
    if (encoded === undefined) continue; // an empty value (e.g. a blank SMTP field) is nothing to write
    body[f.key] = encoded;
    requested.push(f);
  }
  if (!requested.length) return { applied: [], skipped: [] };
  const ref = await requireRef(ctx);
  const tok = await token(ctx);
  if (!tok) throw needToken('Changing Supabase auth settings');
  await api<unknown>(ctx, tok, 'PATCH', `/projects/${ref}/config/auth`, 'Updating Supabase auth settings', body);

  const after = await getAuth(ctx);
  const applied: string[] = [];
  const skipped: string[] = [];
  for (const f of requested) {
    if (f.writeOnly) {
      skipped.push(`${f.name} (write-only: the provider never returns the value, so golive cannot confirm it)`);
      continue;
    }
    const want = f.read(body[f.key], body);
    const got = fieldValue(after, f.name);
    if (sameValue(want, got)) applied.push(f.name);
    else if (got === undefined) skipped.push(`${f.name} (the provider does not report this setting back)`);
    else skipped.push(`${f.name} (the provider reports ${show(got)} instead of ${show(want)})`);
  }
  return { after, applied, skipped };
}

// ── RLS probe helper ────────────────────────────────────────────────────────────────────────────

/**
 * Read-only anonymous probe of one table through the Data API, as a browser visitor would. New
 * sb_publishable_ keys go on `apikey` only; legacy anon JWTs also on Authorization.
 */
export async function supabaseRestProbe(
  ctx: Ctx,
  ref: string,
  table: string,
  schema: string,
  publishableKey: Value,
): Promise<{ status: number; rows: number; code?: string }> {
  assertRef(ref);
  const key = typeof publishableKey === 'string' ? publishableKey : publishableKey.reveal();
  const headers: Record<string, string | Secret> = { apikey: publishableKey, Accept: 'application/json' };
  if (key.startsWith('eyJ')) headers.Authorization = typeof publishableKey === 'string' ? `Bearer ${key}` : new Secret(publishableKey.name, `Bearer ${key}`);
  if (schema && schema !== 'public') headers['Accept-Profile'] = schema;
  const res = await ctx.http<unknown>({ url: `https://${ref}.supabase.co/rest/v1/${encodeURIComponent(table)}?select=*&limit=1`, headers });
  const rows = res.status === 200 && Array.isArray(res.json) ? res.json.length : 0;
  const code = res.json && typeof res.json === 'object' && !Array.isArray(res.json) ? (res.json as { code?: unknown }).code : undefined;
  return { status: res.status, rows, ...(typeof code === 'string' ? { code } : {}) };
}

/**
 * Read-only probe of one table as a SIGNED-IN user: the app's publishable key plus that user's
 * session token. Used to tell "the authenticated role cannot reach any exposed table" (a missing
 * `GRANT`) from tables being reachable; the anonymous view of the same tables is `supabaseRestProbe`.
 */
export async function supabaseAuthedProbe(
  ctx: Ctx,
  ref: string,
  table: string,
  schema: string,
  publishableKey: Value,
  accessToken: Secret,
): Promise<{ status: number; rows: number; code?: string }> {
  assertRef(ref);
  // The user's token replaces the key on Authorization; the key stays on apikey, as the JS client
  // sends. The token carries the `Bearer` scheme: PostgREST and GoTrue read the value after it, so a
  // scheme-less header would resolve the request to the anonymous role instead of this user.
  const headers: Record<string, string | Secret> = { apikey: publishableKey, Authorization: new Secret(accessToken.name, `Bearer ${accessToken.reveal()}`), Accept: 'application/json' };
  if (schema && schema !== 'public') headers['Accept-Profile'] = schema;
  const res = await ctx.http<unknown>({ url: `https://${ref}.supabase.co/rest/v1/${encodeURIComponent(table)}?select=*&limit=1`, headers });
  const rows = res.status === 200 && Array.isArray(res.json) ? res.json.length : 0;
  const code = res.json && typeof res.json === 'object' && !Array.isArray(res.json) ? (res.json as { code?: unknown }).code : undefined;
  return { status: res.status, rows, ...(typeof code === 'string' ? { code } : {}) };
}

// ── adapter ─────────────────────────────────────────────────────────────────────────────────────

function detect(d: DetectResult): boolean {
  return (
    !!d.providers.db?.includes('supabase') ||
    !!d.providers.auth?.includes('supabase') ||
    Object.keys(d.configs).some((k) => k.startsWith('supabase/')) ||
    d.envRefs.some((e) => e.name.includes('SUPABASE'))
  );
}

export const supabaseAdapter: Adapter = {
  id: 'supabase',
  title: 'Supabase',
  axes: ['db', 'auth'],
  automated: true,
  detect,
  auth,
  capabilities: {
    project: { current, candidates, select, create, resolve: resolveProject, creationTarget },
    outputs: { outputs, provides },
    dbAdmin: { tables, advisors },
    authConfig: { get: getAuth, set: setAuth },
    // The GoTrue surface (signup, password grant, admin users), wired to this adapter's project
    // readers so the auth adapter never touches the Management API itself.
    authUsers: supabaseAuthUsers({
      ref: resolveRef,
      keys: async (ctx, ref) => {
        const picked = pickKeys(await listKeys(ctx, ref));
        return { publishable: picked['supabase.publishableKey'], secret: picked['supabase.secretKey'] };
      },
    }),
  },
};
