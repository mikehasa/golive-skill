/**
 * Supabase Auth (GoTrue): the project's own `https://<ref>.supabase.co/auth/v1` user surface.
 *
 * Only this file talks GoTrue. It proves what the management API never can: that a real signup sends
 * a confirmation email, that an unconfirmed account cannot sign in, that a confirmed one can, and
 * that a password can be recovered and replaced the way the app's own recovery page does.
 * The project's publishable and secret keys are read in-process through the Management API transport
 * (`supabase.ts` injects the readers) and travel only as HTTP headers or in a request body — never on
 * argv, in state, logs, evidence or reports.
 *
 * GoTrue answers a refusal with a status and an `error_code`; those come back as *outcomes* so a check
 * can tell "the provider said no" from a broken transport. An unusable credential or an unlinked
 * project throws `SupabaseAuthPrereqError`: that is a prerequisite, and callers skip on it.
 */
import { randomBytes } from 'node:crypto';
import type { AuthLoginOutcome, AuthRecoveryLink, AuthRecoveryOutcome, AuthSession, AuthSignupOutcome, AuthUserView, AuthUsers, Ctx, Value } from '../core/types.js';
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
  /** Admin generate-link answers: the one-time token, and the link that embeds it. */
  hashed_token?: unknown;
  action_link?: unknown;
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
 *
 * Whatever travels on `Authorization` carries the `Bearer` scheme, the key and a session token alike.
 * GoTrue reads a scheme-less value as no token at all and answers 401 `no_authorization` ("This
 * endpoint requires a valid Bearer token"), which makes an authenticated call indistinguishable from
 * an anonymous one. The header value stays inside a `Secret` (under the name of the value it carries)
 * so only the transport boundary reveals it.
 */
function publicHeaders(key: Value, token?: Secret): Record<string, string | Secret> {
  const value = token ?? key;
  const bearer = value instanceof Secret ? new Secret(value.name, `Bearer ${value.reveal()}`) : `Bearer ${value}`;
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
  return sessionOutcome(res.status, res.json);
}

/**
 * The session shape GoTrue answers the password grant and the verify endpoints with. The token grant
 * nests the user (live-proven); `id` is also read at the top level, the shape signup answers with, so
 * an endpoint that carries the id flat is not misread as a refusal. A session still needs both the
 * token and an id: neither is ever invented to make one.
 */
function sessionOutcome(status: number, json: unknown): AuthLoginOutcome {
  const body = asObject(json);
  const who = asObject(body.user);
  const token = str(body.access_token);
  const userId = str(who.id) ?? str(body.id);
  if (status >= 200 && status < 300 && token && userId) {
    const session: AuthSession = { accessToken: new Secret('SUPABASE_AUTH_TOKEN', token), userId, emailConfirmed: confirmedOf(who) };
    return { status, session, rateLimited: false };
  }
  const detail = detailOf(json);
  return { status, rateLimited: status === 429, code: [codeOf(json), detail].filter(Boolean).join(' | ').slice(0, 200) || `HTTP ${status}` };
}

/**
 * `POST /auth/v1/recover`: GoTrue sends a recovery email and answers every accepted request with the
 * same 200, whether or not the address has an account (account enumeration is refused by design), so
 * `accepted` and `emailSent` are that one answer for both. A captcha or the mail throttle is the only
 * refusal it reports here.
 */
async function requestRecovery(deps: SupabaseAuthDeps, ctx: Ctx, email: string): Promise<AuthRecoveryOutcome> {
  const { ref, keys } = await require(deps, ctx);
  const res = await ctx.http<GoTrueUser>({
    url: `${base(ref)}/recover`,
    method: 'POST',
    headers: publicHeaders(requirePublic(keys)),
    body: { email },
  });
  const ok = res.status >= 200 && res.status < 300;
  const detail = detailOf(res.json);
  return {
    status: res.status,
    accepted: ok,
    emailSent: ok,
    rateLimited: res.status === 429,
    captchaRequired: !ok && isCaptcha(codeOf(res.json), detail),
    ...(ok ? {} : { code: [codeOf(res.json), detail].filter(Boolean).join(' | ').slice(0, 200) || `HTTP ${res.status}` }),
  };
}

/**
 * The admin generate-link endpoint: golive mints the token the provider would have emailed, which is
 * what lets a run prove the recovery flow without reading an inbox. The live answer is a FLAT user
 * object — `id` and `hashed_token` at the top level, with no `user` key at all (probed 2026-09-24) —
 * so the id is read from both shapes, flat first, and never invented. The token rides as
 * `hashed_token`; older responses only embed it in `action_link` as `token=…`, read as the fallback.
 * null = the provider has no account for that address.
 */
async function recoveryLink(deps: SupabaseAuthDeps, ctx: Ctx, email: string): Promise<AuthRecoveryLink | null> {
  const { ref, keys } = await require(deps, ctx);
  const res = await ctx.http<GoTrueUser>({
    url: `${base(ref)}/admin/generate_link`,
    method: 'POST',
    headers: adminHeaders(requireSecret(keys)),
    body: { type: 'recovery', email },
  });
  if (res.status === 404) return null;
  expectOk(res.status, res.json, `Minting a Supabase recovery link for ${email}`);
  const body = asObject(res.json);
  const userId = str(body.id) ?? str(asObject(body.user).id);
  const token = str(body.hashed_token) ?? tokenParam(str(body.action_link));
  if (!userId || !token) {
    throw new SupabaseError(`Supabase answered the recovery link for ${email} without a user id${token ? '' : ' or a token'}, so golive cannot use it.`);
  }
  return { userId, token: new Secret('SUPABASE_RECOVERY_TOKEN', token) };
}

/** The `token` query parameter of a GoTrue `action_link` (an old response shape). */
function tokenParam(actionLink: string | undefined): string | undefined {
  if (!actionLink) return undefined;
  try {
    return str(new URL(actionLink).searchParams.get('token') ?? undefined);
  } catch {
    return undefined;
  }
}

/** `POST /auth/v1/verify` with `type=recovery`: the one-time token becomes a session, once. */
async function recoverySession(deps: SupabaseAuthDeps, ctx: Ctx, token: Secret): Promise<AuthLoginOutcome> {
  const { ref, keys } = await require(deps, ctx);
  const res = await ctx.http<GoTrueUser>({
    url: `${base(ref)}/verify`,
    method: 'POST',
    headers: publicHeaders(requirePublic(keys)),
    body: { type: 'recovery', token_hash: token },
  });
  return sessionOutcome(res.status, res.json);
}

/**
 * `PUT /auth/v1/user` with the session token: the signed-in user's own password. Unlike the admin
 * `setPassword` this needs no secret key — it is exactly the call a recovery page makes, so it also
 * proves the session the recovery token produced is usable for a write.
 */
async function updateOwnPassword(deps: SupabaseAuthDeps, ctx: Ctx, session: Secret, password: Secret): Promise<void> {
  const { ref, keys } = await require(deps, ctx);
  const res = await ctx.http<GoTrueUser>({
    url: `${base(ref)}/user`,
    method: 'PUT',
    headers: publicHeaders(requirePublic(keys), session),
    body: { password },
  });
  expectOk(res.status, res.json, 'Setting a new password on the signed-in Supabase user');
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

/**
 * `PUT /auth/v1/admin/users/{id}` with `email_confirm`: the provider-admin confirmation of an account
 * golive seeded and controls. The isolation journey needs a second signed-in account, and asking the
 * human for a second inbox click would spend the provider's mail throttle on a journey whose point is
 * the app's data, not delivery. It is a provider-side fact the caller re-reads — never a claim that
 * the address received or that anyone clicked anything.
 */
async function confirmEmail(deps: SupabaseAuthDeps, ctx: Ctx, id: string): Promise<void> {
  const { ref, keys } = await require(deps, ctx);
  const res = await ctx.http<GoTrueUser>({
    url: `${base(ref)}/admin/users/${encodeURIComponent(id)}`,
    method: 'PUT',
    headers: adminHeaders(requireSecret(keys)),
    body: { email_confirm: true },
  });
  expectOk(res.status, res.json, `Confirming the Supabase auth user ${id}`);
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
    confirmEmail: (ctx, id) => confirmEmail(deps, ctx, id),
    requestRecovery: (ctx, email) => requestRecovery(deps, ctx, email),
    recoveryLink: (ctx, email) => recoveryLink(deps, ctx, email),
    recoverySession: (ctx, token) => recoverySession(deps, ctx, token),
    updateOwnPassword: (ctx, session, password) => updateOwnPassword(deps, ctx, session, password),
    destination: (ctx) => destination(deps, ctx),
  };
}
