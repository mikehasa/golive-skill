/**
 * Supabase Auth (GoTrue): the project's own `https://<ref>.supabase.co/auth/v1` user surface.
 *
 * Only this file talks GoTrue. It proves what the management API never can: that a real signup sends
 * a confirmation email, that an unconfirmed account cannot sign in, and that a confirmed one can.
 * The project's publishable and secret keys are read in-process through the Management API transport
 * (`supabase.ts` injects the readers) and travel only as HTTP headers or in a request body — never on
 * argv, in state, logs, evidence or reports.
 *
 * GoTrue answers a refusal with a status and an `error_code`; those come back as *outcomes* so a check
 * can tell "the provider said no" from a broken transport. An unusable credential or an unlinked
 * project throws `SupabaseAuthPrereqError`: that is a prerequisite, and callers skip on it.
 */
import { randomBytes } from 'node:crypto';
import type { AuthLoginOutcome, AuthSession, AuthSignupOutcome, AuthUserView, AuthUsers, Ctx, Value } from '../core/types.js';
import { Secret, redact } from '../core/secret.js';
import { SupabaseError } from './supabase-api.js';

/**
 * No reusable Supabase login, or no selected project: the journey cannot run, and the checks skip
 * with the reason instead of failing. Distinct from a provider refusal, which is a real finding.
 */
export class SupabaseAuthPrereqError extends SupabaseError {}

/** The project's keys, read in-process. Only the publishable one is public; the secret one is a Secret. */
export interface SupabaseAuthKeys {
  publishable?: Value;
  secret?: Value;
}

export interface SupabaseAuthDeps {
  /** The project ref this app uses (state → golive.yaml → the `supabase link` file), or null. */
  ref(ctx: Ctx): Promise<string | null>;
  /** The project's keys. May throw `needToken` when no reusable CLI credential/token is available. */
  keys(ctx: Ctx, ref: string): Promise<SupabaseAuthKeys>;
}

const CHARS = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#$%^&*-_';

/**
 * A throwaway password for a test account: 32 random characters over every class GoTrue may require,
 * long enough for any project minimum. It lives in memory (the run vault) and is never recorded.
 */
export function testPassword(): Secret {
  return new Secret('GOLIVE_TEST_PASSWORD', [...randomBytes(32)].map((b) => CHARS[b % CHARS.length]).join(''));
}

// ── Response shapes (only the fields golive reads) ───────────────────────────────────────────────

interface GoTrueUser {
  id?: unknown;
  email?: unknown;
  email_confirmed_at?: unknown;
  confirmed_at?: unknown;
  identities?: unknown;
  access_token?: unknown;
  user?: unknown;
  error_code?: unknown;
  code?: unknown;
  msg?: unknown;
  message?: unknown;
  error?: unknown;
  error_description?: unknown;
}

const asObject = (v: unknown): GoTrueUser => (v && typeof v === 'object' && !Array.isArray(v) ? (v as GoTrueUser) : {});
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

/** The provider's error code (`email_not_confirmed`, `over_email_send_rate_limit`, …). */
function codeOf(json: unknown): string | undefined {
  const o = asObject(json);
  return str(o.error_code) ?? (typeof o.code === 'string' ? o.code : undefined);
}

/** Secret-free provider wording for evidence. GoTrue echoes an address, never a credential. */
function detailOf(json: unknown): string {
  const o = asObject(json);
  const text = [str(o.error_code), str(o.msg), str(o.message), str(o.error_description), str(o.error)].filter(Boolean).join(' ');
  return redact(text).slice(0, 200);
}

const isCaptcha = (code: string | undefined, detail: string): boolean => /captcha|challenge/i.test(`${code ?? ''} ${detail}`);

/** `email_confirmed_at` (or the legacy `confirmed_at`) is set. */
const confirmedOf = (u: GoTrueUser): boolean => Boolean(str(u.email_confirmed_at) ?? str(u.confirmed_at));

function view(status: number, u: GoTrueUser): AuthUserView {
  const id = str(u.id);
  const email = str(u.email);
  return { status, ...(id ? { id } : {}), ...(email ? { email } : {}), ...(id ? { emailConfirmed: confirmedOf(u) } : {}) };
}

// ── Requests ─────────────────────────────────────────────────────────────────────────────────────

const base = (ref: string): string => `https://${ref}.supabase.co/auth/v1`;

/**
 * The public key as the browser client sends it: on `apikey`, and on `Authorization` unless a session
 * token replaces it. Both key shapes work this way (sb_publishable_… and a legacy anon JWT).
 */
function publicHeaders(key: Value, token?: Secret): Record<string, string | Secret> {
  const bearer = token ?? (key instanceof Secret ? new Secret(key.name, `Bearer ${key.reveal()}`) : `Bearer ${key}`);
  return { apikey: key, Authorization: bearer, Accept: 'application/json' };
}

/** Admin endpoints authenticate with the project's secret key, never a user token. */
function adminHeaders(key: Value): Record<string, string | Secret> {
  const bearer = key instanceof Secret ? new Secret(key.name, `Bearer ${key.reveal()}`) : `Bearer ${key}`;
  return { apikey: key, Authorization: bearer, Accept: 'application/json' };
}

function requirePublic(keys: SupabaseAuthKeys): Value {
  if (!keys.publishable) {
    throw new SupabaseAuthPrereqError(
      'Supabase did not return a publishable (anon) key for this project, so its auth endpoints cannot be called. Check API Keys Read and API Key Secrets Read for this project, then re-run.',
    );
  }
  return keys.publishable;
}

function requireSecret(keys: SupabaseAuthKeys): Value {
  if (!keys.secret) {
    throw new SupabaseAuthPrereqError(
      "Supabase did not return the project's secret key, so its admin user endpoints cannot be called. Check API Keys Read and API Key Secrets Read for this project, then re-run.",
    );
  }
  return keys.secret;
}

function fail(status: number, json: unknown, what: string): never {
  const code = codeOf(json);
  const detail = detailOf(json);
  const tail = [code, detail].filter(Boolean).join(' ');
  if (status === 429) throw new SupabaseError(`${what} failed: Supabase rate limit hit (429). Wait a minute and re-run.`, status);
  if (status === 401 || status === 403) {
    throw new SupabaseError(`${what} failed: the project key was ${status === 401 ? 'rejected (401)' : 'not allowed to do this (403)'}${tail ? ` (${tail})` : ''}. Check the publishable and secret keys of the linked project (\`golive doctor\` re-checks the Supabase credential).`, status);
  }
  throw new SupabaseError(`${what} failed: HTTP ${status}${tail ? ` (${tail})` : ''}.`, status);
}

function expectOk(status: number, json: unknown, what: string): void {
  if (status < 200 || status >= 300) fail(status, json, what);
}

// ── Operations ───────────────────────────────────────────────────────────────────────────────────

async function require(deps: SupabaseAuthDeps, ctx: Ctx): Promise<{ ref: string; keys: SupabaseAuthKeys }> {
  const ref = await deps.ref(ctx);
  if (!ref) {
    throw new SupabaseAuthPrereqError('No Supabase project is selected for this app, so its auth users cannot be reached. Run `golive plan` to select one, or set `projects.db` in golive.yaml.');
  }
  // The Management API read happens once per run: the checks call several operations in a row.
  const memo = `supabaseAuth.keys:${ref}`;
  let keys = ctx.cache.get(memo) as Promise<SupabaseAuthKeys> | undefined;
  if (!keys) {
    keys = deps.keys(ctx, ref).catch((e: unknown) => {
      // A credential golive cannot use is a prerequisite for this whole capability, not a refusal.
      if (e instanceof SupabaseError) throw new SupabaseAuthPrereqError(e.message, e.status);
      throw e;
    });
    ctx.cache.set(memo, keys);
  }
  return { ref, keys: await keys };
}

async function signup(deps: SupabaseAuthDeps, ctx: Ctx, email: string, password: Secret): Promise<AuthSignupOutcome> {
  const { ref, keys } = await require(deps, ctx);
  const res = await ctx.http<GoTrueUser>({
    url: `${base(ref)}/signup`,
    method: 'POST',
    headers: publicHeaders(requirePublic(keys)),
    body: { email, password },
  });
  const body = asObject(res.json);
  const ok = res.status >= 200 && res.status < 300;
  // A 2xx with a session means the project confirms users for you; `identities: []` is how GoTrue
  // answers a signup for an address that already has an account (nothing is sent).
  const session = ok && Boolean(str(body.access_token));
  const identities = Array.isArray(body.identities) ? body.identities : undefined;
  const existing = ok && !session && identities?.length === 0;
  const userId = str(body.id) ?? str(asObject(body.user).id);
  const detail = detailOf(res.json);
  return {
    status: res.status,
    ...(userId ? { userId } : {}),
    confirmationSent: ok && !session && !existing,
    existing: Boolean(existing),
    rateLimited: res.status === 429,
    captchaRequired: !ok && isCaptcha(codeOf(res.json), detail),
    ...(ok ? {} : { code: [codeOf(res.json), detail].filter(Boolean).join(' | ').slice(0, 200) || `HTTP ${res.status}` }),
  };
}

async function login(deps: SupabaseAuthDeps, ctx: Ctx, email: string, password: Secret): Promise<AuthLoginOutcome> {
  const { ref, keys } = await require(deps, ctx);
  const res = await ctx.http<GoTrueUser>({
    url: `${base(ref)}/token?grant_type=password`,
    method: 'POST',
    headers: publicHeaders(requirePublic(keys)),
    body: { email, password },
  });
  const body = asObject(res.json);
  const who = asObject(body.user);
  const token = str(body.access_token);
  const userId = str(who.id);
  if (res.status >= 200 && res.status < 300 && token && userId) {
    const session: AuthSession = { accessToken: new Secret('SUPABASE_AUTH_TOKEN', token), userId, emailConfirmed: confirmedOf(who) };
    return { status: res.status, session, rateLimited: false };
  }
  const detail = detailOf(res.json);
  return { status: res.status, rateLimited: res.status === 429, code: [codeOf(res.json), detail].filter(Boolean).join(' | ').slice(0, 200) || `HTTP ${res.status}` };
}

async function user(deps: SupabaseAuthDeps, ctx: Ctx, token?: Secret): Promise<AuthUserView> {
  const { ref, keys } = await require(deps, ctx);
  const res = await ctx.http<GoTrueUser>({ url: `${base(ref)}/user`, headers: publicHeaders(requirePublic(keys), token) });
  return view(res.status, asObject(res.json));
}

async function adminUser(deps: SupabaseAuthDeps, ctx: Ctx, id: string): Promise<AuthUserView | null> {
  const { ref, keys } = await require(deps, ctx);
  const res = await ctx.http<GoTrueUser>({ url: `${base(ref)}/admin/users/${encodeURIComponent(id)}`, headers: adminHeaders(requireSecret(keys)) });
  if (res.status === 404) return null;
  expectOk(res.status, res.json, `Reading Supabase auth user ${id}`);
  return view(res.status, asObject(res.json));
}

async function setPassword(deps: SupabaseAuthDeps, ctx: Ctx, id: string, password: Secret): Promise<void> {
  const { ref, keys } = await require(deps, ctx);
  const res = await ctx.http<GoTrueUser>({
    url: `${base(ref)}/admin/users/${encodeURIComponent(id)}`,
    method: 'PUT',
    headers: adminHeaders(requireSecret(keys)),
    body: { password },
  });
  expectOk(res.status, res.json, `Setting a new password on the Supabase test user ${id}`);
}

async function destination(deps: SupabaseAuthDeps, ctx: Ctx): Promise<{ ref: string; url: string } | null> {
  let ref: string | null = null;
  try {
    ref = await deps.ref(ctx);
  } catch {
    return null; // a destination read is a convenience: the checks name the missing prerequisite themselves
  }
  return ref ? { ref, url: `https://${ref}.supabase.co` } : null;
}

/** The `authUsers` capability, wired to the project readers the Supabase adapter owns. */
export function supabaseAuthUsers(deps: SupabaseAuthDeps): AuthUsers {
  return {
    signup: (ctx, email, password) => signup(deps, ctx, email, password),
    login: (ctx, email, password) => login(deps, ctx, email, password),
    user: (ctx, token) => user(deps, ctx, token),
    adminUser: (ctx, id) => adminUser(deps, ctx, id),
    setPassword: (ctx, id, password) => setPassword(deps, ctx, id, password),
    destination: (ctx) => destination(deps, ctx),
  };
}
