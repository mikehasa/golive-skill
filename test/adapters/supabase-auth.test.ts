/**
 * The Supabase Auth (GoTrue) adapter: request shapes, both API-key shapes, response parsing and the
 * refusals the checks read. Offline only: scripted HTTP, no project, no account.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mockHttp, testCtx, type HttpCall } from '../helpers.js';
import { Secret, _resetSecretRegistry } from '../../src/core/secret.js';
import { SupabaseAuthPrereqError, supabaseAuthUsers, testPassword, type SupabaseAuthDeps } from '../../src/adapters/supabase-auth.js';
import { SupabaseError } from '../../src/adapters/supabase-api.js';

const REF = 'abcdefghijklmnopqrst';
const AUTH = `https://${REF}.supabase.co/auth/v1`;
const PUB_KEY = 'sb_publishable_PUBLICvalue1234567890';
const SECRET_KEY = 'sb_secret_SUPERSECRETvalue1234567890';
const PASSWORD = 'generated-password-never-echoed-1234';
// Unsigned, deliberately invalid JWT fixtures; no provider account or signing key is involved.
const unsignedFixtureJwt = (role: string) => [Buffer.from(JSON.stringify({ alg: 'HS256' })).toString('base64url'), Buffer.from(JSON.stringify({ role })).toString('base64url'), Buffer.from('synthetic-signature').toString('base64url')].join('.');
const SERVICE_ROLE = unsignedFixtureJwt('service_role');
const ANON = unsignedFixtureJwt('anon');

beforeEach(() => _resetSecretRegistry());

const deps = (over: Partial<SupabaseAuthDeps> = {}): SupabaseAuthDeps => ({
  ref: async () => REF,
  keys: async () => ({ publishable: PUB_KEY, secret: new Secret('SUPABASE_SECRET_KEY', SECRET_KEY) }),
  ...over,
});

const cap = (over: Partial<SupabaseAuthDeps> = {}) => supabaseAuthUsers(deps(over));
const secret = () => new Secret('GOLIVE_TEST_PASSWORD', PASSWORD);

/** What a message must never contain: the password or the project's secret key. */
function expectNoSecret(text: string): void {
  expect(text).not.toContain(PASSWORD);
  expect(text).not.toContain(SECRET_KEY);
}

// ── signup ───────────────────────────────────────────────────────────────────────────────────────

describe('signup', () => {
  it('posts the address and the password, and reports that a confirmation email was sent', async () => {
    const { http, calls } = mockHttp([['POST', `${AUTH}/signup`, () => ({ json: { id: 'usr_1', email: 'you+gl-1@example.com', identities: [{ id: 'id-1' }], email_confirmed_at: null } })]]);
    const out = await cap().signup(testCtx({ http }), 'you+gl-1@example.com', secret());
    expect(out).toEqual({ status: 200, userId: 'usr_1', confirmationSent: true, existing: false, rateLimited: false, captchaRequired: false });
    expect(calls[0]!.url).toBe(`${AUTH}/signup`);
    expect(calls[0]!.body).toEqual({ email: 'you+gl-1@example.com', password: PASSWORD });
    // The publishable key goes on apikey and, with no session, on Authorization: the browser shape.
    expect(calls[0]!.headers.apikey).toBe(PUB_KEY);
    expect(calls[0]!.headers.authorization).toBe(`Bearer ${PUB_KEY}`);
  });

  it('uses the legacy anon key on both headers when that is what the project has', async () => {
    const { http, calls } = mockHttp([['POST', `${AUTH}/signup`, () => ({ json: { id: 'usr_1', identities: [{}] } })]]);
    await cap({ keys: async () => ({ publishable: ANON, secret: new Secret('SUPABASE_SERVICE_ROLE_KEY', SERVICE_ROLE) }) }).signup(testCtx({ http }), 'a@example.com', secret());
    expect(calls[0]!.headers.apikey).toBe(ANON);
    expect(calls[0]!.headers.authorization).toBe(`Bearer ${ANON}`);
  });

  it('reads a session answer as "no confirmation needed" (the project confirms users itself)', async () => {
    const { http } = mockHttp([['POST', `${AUTH}/signup`, () => ({ json: { access_token: 'tok', user: { id: 'usr_2', email_confirmed_at: '2026-09-23T00:00:00Z' } } })]]);
    const out = await cap().signup(testCtx({ http }), 'a@example.com', secret());
    expect(out).toMatchObject({ userId: 'usr_2', confirmationSent: false, existing: false });
  });

  it('reads the obfuscated answer for an address that already has an account', async () => {
    const { http } = mockHttp([['POST', `${AUTH}/signup`, () => ({ json: { id: 'usr_3', email: 'a@example.com', identities: [] } })]]);
    expect(await cap().signup(testCtx({ http }), 'a@example.com', secret())).toMatchObject({ confirmationSent: false, existing: true });
  });

  it('names a captcha requirement, a rate limit and a refusal code', async () => {
    const captcha = mockHttp([['POST', `${AUTH}/signup`, () => ({ status: 400, json: { code: 400, error_code: 'captcha_failed', msg: 'captcha protection: request disallowed' } })]]);
    expect(await cap().signup(testCtx({ http: captcha.http }), 'a@example.com', secret())).toMatchObject({ status: 400, captchaRequired: true, confirmationSent: false });

    const limited = mockHttp([['POST', `${AUTH}/signup`, () => ({ status: 429, json: { error_code: 'over_email_send_rate_limit', msg: 'Email rate limit exceeded' } })]]);
    expect(await cap().signup(testCtx({ http: limited.http }), 'a@example.com', secret())).toMatchObject({ rateLimited: true, confirmationSent: false, code: expect.stringContaining('over_email_send_rate_limit') });

    const closed = mockHttp([['POST', `${AUTH}/signup`, () => ({ status: 422, json: { error_code: 'signup_disabled', msg: 'Signups not allowed for this instance' } })]]);
    expect(await cap().signup(testCtx({ http: closed.http }), 'a@example.com', secret())).toMatchObject({ status: 422, confirmationSent: false, code: expect.stringContaining('signup_disabled') });
  });
});

// ── login / user ─────────────────────────────────────────────────────────────────────────────────

describe('login', () => {
  it('returns a session whose token is a Secret (never a printable value)', async () => {
    const { http, calls } = mockHttp([['POST', `${AUTH}/token`, () => ({ json: { access_token: 'issued-token-value', user: { id: 'usr_1', email: 'a@example.com', email_confirmed_at: '2026-09-23T00:00:00Z' } } })]]);
    const out = await cap().login(testCtx({ http }), 'a@example.com', secret());
    expect(out.status).toBe(200);
    expect(out.session).toMatchObject({ userId: 'usr_1', emailConfirmed: true });
    expect(out.session!.accessToken).toBeInstanceOf(Secret);
    expect(JSON.stringify(out)).not.toContain('issued-token-value');
    expect(calls[0]!.url).toBe(`${AUTH}/token?grant_type=password`);
    expect(calls[0]!.body).toEqual({ email: 'a@example.com', password: PASSWORD });
  });

  it('reports a refusal as a code, not as an exception, and echoes no password', async () => {
    const { http } = mockHttp([['POST', `${AUTH}/token`, () => ({ status: 400, json: { error_code: 'email_not_confirmed', msg: `Email not confirmed for ${PASSWORD}` } })]]);
    const out = await cap().login(testCtx({ http }), 'a@example.com', secret());
    expect(out).toMatchObject({ status: 400, rateLimited: false });
    expect(out.session).toBeUndefined();
    expect(out.code).toContain('email_not_confirmed');
    expectNoSecret(JSON.stringify(out));
  });

  it('flags a rate-limited login', async () => {
    const { http } = mockHttp([['POST', `${AUTH}/token`, () => ({ status: 429, json: { error_code: 'over_request_rate_limit' } })]]);
    expect(await cap().login(testCtx({ http }), 'a@example.com', secret())).toMatchObject({ rateLimited: true, status: 429 });
  });
});

/**
 * A route shaped like the live GoTrue endpoint: it reads `Authorization` the way the real service
 * does, where the value after the `Bearer` scheme is the token and a scheme-less value is no token at
 * all. A request without the scheme gets the exact 401 the live project returned.
 */
const gotrueAuthed = (body: Record<string, unknown>) => (c: HttpCall) =>
  /^Bearer\s/i.test(c.headers.authorization ?? '')
    ? { json: body }
    : { status: 401, json: { code: 401, error_code: 'no_authorization', msg: 'This endpoint requires a valid Bearer token' } };

describe('user', () => {
  it('without a token asks as an anonymous client and reports the refusal', async () => {
    const { http, calls } = mockHttp([['GET', `${AUTH}/user`, () => ({ status: 401, json: { msg: 'invalid claim: missing sub claim' } })]]);
    expect(await cap().user(testCtx({ http }))).toEqual({ status: 401 });
    expect(calls[0]!.headers.apikey).toBe(PUB_KEY);
    expect(calls[0]!.headers.authorization).toBe(`Bearer ${PUB_KEY}`);
  });

  it('with a session token sends it as the bearer and returns the same user', async () => {
    const token = new Secret('SUPABASE_AUTH_TOKEN', 'session-token-value-1234');
    // The route refuses a scheme-less header, so a token presented without `Bearer` fails here as it
    // did against the live project instead of passing as an anonymous request.
    const { http, calls } = mockHttp([['GET', `${AUTH}/user`, gotrueAuthed({ id: 'usr_1', email: 'a@example.com', confirmed_at: '2026-09-23T00:00:00Z' })]]);
    expect(await cap().user(testCtx({ http }), token)).toEqual({ status: 200, id: 'usr_1', email: 'a@example.com', emailConfirmed: true });
    expect(calls[0]!.headers.apikey).toBe(PUB_KEY);
    expect(calls[0]!.headers.authorization).toBe(`Bearer ${token.reveal()}`);
  });

  it('turns the live `no_authorization` refusal into a 401 outcome the checks read, not an exception', async () => {
    const { http } = mockHttp([['GET', `${AUTH}/user`, () => ({ status: 401, json: { code: 401, error_code: 'no_authorization', msg: 'This endpoint requires a valid Bearer token' } })]]);
    expect(await cap().user(testCtx({ http }), new Secret('SUPABASE_AUTH_TOKEN', 'session-token-value-1234'))).toEqual({ status: 401 });
  });
});

// ── admin user endpoints ─────────────────────────────────────────────────────────────────────────

describe('adminUser / setPassword', () => {
  it('reads one user with the project secret key on both headers', async () => {
    const { http, calls } = mockHttp([['GET', `${AUTH}/admin/users/usr_1`, () => ({ json: { id: 'usr_1', email: 'a@example.com', email_confirmed_at: '2026-09-23T00:00:00Z' } })]]);
    expect(await cap().adminUser(testCtx({ http }), 'usr_1')).toEqual({ status: 200, id: 'usr_1', email: 'a@example.com', emailConfirmed: true });
    expect(calls[0]!.headers.apikey).toBe(SECRET_KEY);
    expect(calls[0]!.headers.authorization).toBe(`Bearer ${SECRET_KEY}`);
  });

  it('returns null for a user the provider no longer has', async () => {
    const { http } = mockHttp([['GET', `${AUTH}/admin/users/usr_gone`, () => ({ status: 404, json: { msg: 'User not found' } })]]);
    expect(await cap().adminUser(testCtx({ http }), 'usr_gone')).toBeNull();
  });

  it('sets a new password on a seeded user with a PUT, and never echoes it in an error', async () => {
    const { http, calls } = mockHttp([['PUT', `${AUTH}/admin/users/usr_1`, () => ({ json: { id: 'usr_1' } })]]);
    await cap().setPassword(testCtx({ http }), 'usr_1', secret());
    expect(calls[0]!.body).toEqual({ password: PASSWORD });

    // A rejection that echoes the body must not put the password into the error the agent reads.
    const bad = mockHttp([['PUT', `${AUTH}/admin/users/usr_1`, () => ({ status: 500, text: `boom ${PASSWORD}`, json: { msg: `failed for ${PASSWORD}` } })]]);
    const e = await cap().setPassword(testCtx({ http: bad.http }), 'usr_1', secret()).catch((x: unknown) => x as Error);
    expect(e).toBeInstanceOf(SupabaseError);
    expect((e as Error).message).toMatch(/HTTP 500/);
    expectNoSecret((e as Error).message);
  });

  it('confirms a seeded user with the admin API and the `email_confirm` field', async () => {
    const { http, calls } = mockHttp([['PUT', `${AUTH}/admin/users/usr_2`, () => ({ json: { id: 'usr_2', email_confirmed_at: '2026-09-24T00:00:00Z' } })]]);
    await cap().confirmEmail!(testCtx({ http }), 'usr_2');
    expect(calls[0]!.body).toEqual({ email_confirm: true });
    expect(calls[0]!.headers.authorization).toBe(`Bearer ${SECRET_KEY}`);

    // The refusal a key problem produces reads like every other admin call, and names no secret.
    const bad = mockHttp([['PUT', `${AUTH}/admin/users/usr_2`, () => ({ status: 403, json: { msg: `forbidden for ${SECRET_KEY}` } })]]);
    const e = await cap().confirmEmail!(testCtx({ http: bad.http }), 'usr_2').catch((x: unknown) => x as Error);
    expect(e).toBeInstanceOf(SupabaseError);
    expect((e as Error).message).toMatch(/the project key was not allowed to do this \(403\)/);
    expectNoSecret((e as Error).message);
  });

  it('a rejected admin read names the key problem and stays secret-free', async () => {
    const { http } = mockHttp([['GET', `${AUTH}/admin/users/usr_1`, () => ({ status: 403, json: { msg: `forbidden for ${SECRET_KEY}` } })]]);
    const e = await cap().adminUser(testCtx({ http }), 'usr_1').catch((x: unknown) => x as Error);
    expect((e as Error).message).toMatch(/the project key was not allowed to do this \(403\)/);
    expect((e as Error).message).toMatch(/golive doctor/);
    expectNoSecret((e as Error).message);
  });
});

// ── password recovery ────────────────────────────────────────────────────────────────────────────

const RECOVERY_TOKEN = 'hashed-recovery-token-value';
const recoveryToken = () => new Secret('SUPABASE_RECOVERY_TOKEN', RECOVERY_TOKEN);
const sessionToken = () => new Secret('SUPABASE_AUTH_TOKEN', 'session-token-value-1234');

describe('recover', () => {
  it('asks for the recovery email and reads GoTrue\'s one 2xx answer as accepted for sending', async () => {
    // The same answer is what an address WITH an account gets: GoTrue does not say which is which, so
    // the adapter reports it as-is and the check compares two of these instead of trusting a flag.
    const { http, calls } = mockHttp([['POST', `${AUTH}/recover`, () => ({ json: {} })]]);
    const out = await cap().requestRecovery(testCtx({ http }), 'a@example.com');
    expect(out).toEqual({ status: 200, accepted: true, emailSent: true, rateLimited: false, captchaRequired: false });
    expect(calls[0]!.url).toBe(`${AUTH}/recover`);
    expect(calls[0]!.body).toEqual({ email: 'a@example.com' });
    expect(calls[0]!.headers.apikey).toBe(PUB_KEY);
    expect(calls[0]!.headers.authorization).toBe(`Bearer ${PUB_KEY}`);
  });

  it('names a rate limit, a captcha and a refusal code', async () => {
    const limited = mockHttp([['POST', `${AUTH}/recover`, () => ({ status: 429, json: { error_code: 'over_email_send_rate_limit', msg: 'Email rate limit exceeded' } })]]);
    expect(await cap().requestRecovery(testCtx({ http: limited.http }), 'a@example.com')).toMatchObject({
      status: 429,
      accepted: false,
      emailSent: false,
      rateLimited: true,
      code: expect.stringContaining('over_email_send_rate_limit'),
    });

    const captcha = mockHttp([['POST', `${AUTH}/recover`, () => ({ status: 400, json: { error_code: 'captcha_failed', msg: 'captcha protection: request disallowed' } })]]);
    expect(await cap().requestRecovery(testCtx({ http: captcha.http }), 'a@example.com')).toMatchObject({ accepted: false, captchaRequired: true, rateLimited: false });

    const closed = mockHttp([['POST', `${AUTH}/recover`, () => ({ status: 422, json: { error_code: 'email_address_invalid', msg: 'Email address is invalid' } })]]);
    expect(await cap().requestRecovery(testCtx({ http: closed.http }), 'nope' )).toMatchObject({ status: 422, accepted: false, code: expect.stringContaining('email_address_invalid') });
  });
});

describe('recoveryLink / recoverySession / updateOwnPassword', () => {
  it('mints a link with the admin key and keeps the hashed token in a Secret', async () => {
    const { http, calls } = mockHttp([
      ['POST', `${AUTH}/admin/generate_link`, () => ({ json: { action_link: `https://${REF}.supabase.co/auth/v1/verify?token=${RECOVERY_TOKEN}&type=recovery`, hashed_token: RECOVERY_TOKEN, verification_type: 'recovery', user: { id: 'usr_1', email: 'a@example.com' } } })],
    ]);
    const link = await cap().recoveryLink!(testCtx({ http }), 'a@example.com');
    expect(link).toMatchObject({ userId: 'usr_1' });
    expect(link!.token).toBeInstanceOf(Secret);
    expect(link!.token.name).toBe('SUPABASE_RECOVERY_TOKEN');
    expect(link!.token.reveal()).toBe(RECOVERY_TOKEN);
    expect(JSON.stringify(link)).not.toContain(RECOVERY_TOKEN);
    expect(calls[0]!.url).toBe(`${AUTH}/admin/generate_link`);
    expect(calls[0]!.body).toEqual({ type: 'recovery', email: 'a@example.com' });
    expect(calls[0]!.headers.apikey).toBe(SECRET_KEY);
    expect(calls[0]!.headers.authorization).toBe(`Bearer ${SECRET_KEY}`);
  });

  it('falls back to the token inside action_link when the answer carries no hashed_token', async () => {
    const link = `${AUTH}/verify?token=token-from-action-link&type=recovery&redirect_to=https%3A%2F%2Fapp.example.com%2Freset`;
    const { http } = mockHttp([['POST', `${AUTH}/admin/generate_link`, () => ({ json: { action_link: link, user: { id: 'usr_1' } } })]]);
    expect((await cap().recoveryLink!(testCtx({ http }), 'a@example.com'))!.token.reveal()).toBe('token-from-action-link');
  });

  it('returns null when the provider has no account for the address, and refuses an unusable answer', async () => {
    const missing = mockHttp([['POST', `${AUTH}/admin/generate_link`, () => ({ status: 404, json: { error_code: 'user_not_found', msg: 'User not found' } })]]);
    expect(await cap().recoveryLink!(testCtx({ http: missing.http }), 'nobody@example.com')).toBeNull();

    const unusable = mockHttp([['POST', `${AUTH}/admin/generate_link`, () => ({ json: { user: { id: 'usr_1' } } })]]);
    const e = await cap().recoveryLink!(testCtx({ http: unusable.http }), 'a@example.com').catch((x: unknown) => x as Error);
    expect(e).toBeInstanceOf(SupabaseError);
    expect((e as Error).message).toMatch(/without a user id or a token/);
    expectNoSecret((e as Error).message);
  });

  it('exchanges a recovery token for a session, and reports a used or expired one as a refusal', async () => {
    const { http, calls } = mockHttp([
      ['POST', `${AUTH}/verify`, () => ({ json: { access_token: 'recovery-session-value', user: { id: 'usr_1', email: 'a@example.com', email_confirmed_at: '2026-09-24T00:00:00Z' } } })],
    ]);
    const out = await cap().recoverySession(testCtx({ http }), recoveryToken());
    expect(out.status).toBe(200);
    expect(out.session).toMatchObject({ userId: 'usr_1', emailConfirmed: true });
    expect(out.session!.accessToken).toBeInstanceOf(Secret);
    expect(JSON.stringify(out)).not.toContain('recovery-session-value');
    expect(JSON.stringify(out)).not.toContain(RECOVERY_TOKEN);
    expect(calls[0]!.url).toBe(`${AUTH}/verify`);
    expect(calls[0]!.body).toEqual({ type: 'recovery', token_hash: RECOVERY_TOKEN });
    expect(calls[0]!.headers.authorization).toBe(`Bearer ${PUB_KEY}`);

    // What a spent or expired token looks like: a refusal the check reads, never an exception.
    const spent = mockHttp([['POST', `${AUTH}/verify`, () => ({ status: 403, json: { code: 403, error_code: 'otp_expired', msg: 'Token has expired or is invalid' } })]]);
    const refused = await cap().recoverySession(testCtx({ http: spent.http }), recoveryToken());
    expect(refused).toMatchObject({ status: 403, rateLimited: false });
    expect(refused.session).toBeUndefined();
    expect(refused.code).toContain('otp_expired');
    expect(JSON.stringify(refused)).not.toContain(RECOVERY_TOKEN);
  });

  it('sets the signed-in user\'s own password with PUT /user, and never echoes it in an error', async () => {
    const { http, calls } = mockHttp([['PUT', `${AUTH}/user`, () => ({ json: { id: 'usr_1' } })]]);
    await cap().updateOwnPassword(testCtx({ http }), sessionToken(), secret());
    expect(calls[0]!.url).toBe(`${AUTH}/user`);
    expect(calls[0]!.body).toEqual({ password: PASSWORD });
    // The session token, not the key, authenticates this write.
    expect(calls[0]!.headers.apikey).toBe(PUB_KEY);
    expect(calls[0]!.headers.authorization).toBe(`Bearer ${sessionToken().reveal()}`);

    const bad = mockHttp([['PUT', `${AUTH}/user`, () => ({ status: 500, text: `boom ${PASSWORD}`, json: { msg: `failed for ${PASSWORD}` } })]]);
    const e = await cap().updateOwnPassword(testCtx({ http: bad.http }), sessionToken(), secret()).catch((x: unknown) => x as Error);
    expect(e).toBeInstanceOf(SupabaseError);
    expect((e as Error).message).toMatch(/HTTP 500/);
    expectNoSecret((e as Error).message);
  });
});

// ── the Authorization scheme, pinned over all three token-bearing paths ──────────────────────────

/**
 * The fakes never validate the scheme themselves (they read the value golive hands them), so this
 * asserts the exact header of every path at once: the publishable/anon key, a session token and the
 * admin secret key. A bare value is what the live project answered with 401 `no_authorization`.
 */
describe('Authorization headers', () => {
  it('sends `Bearer <value>` on the publishable-key, session-token and admin-secret paths', async () => {
    const token = new Secret('SUPABASE_AUTH_TOKEN', 'session-token-value-1234');
    const { http, calls } = mockHttp([
      ['POST', `${AUTH}/signup`, () => ({ json: { id: 'usr_1', identities: [{}] } })],
      ['GET', `${AUTH}/user`, () => ({ json: { id: 'usr_1', email_confirmed_at: '2026-09-23T00:00:00Z' } })],
      ['GET', `${AUTH}/admin/users/usr_1`, () => ({ json: { id: 'usr_1' } })],
      ['PUT', `${AUTH}/admin/users/usr_1`, () => ({ json: { id: 'usr_1' } })],
    ]);
    const api = cap();
    const ctx = testCtx({ http });
    await api.signup(ctx, 'a@example.com', secret());
    await api.user(ctx, token);
    await api.adminUser(ctx, 'usr_1');
    await api.setPassword(ctx, 'usr_1', secret());
    await api.confirmEmail!(ctx, 'usr_1');

    expect(calls.map((c) => c.headers.authorization)).toEqual([
      `Bearer ${PUB_KEY}`,
      `Bearer ${token.reveal()}`,
      `Bearer ${SECRET_KEY}`,
      `Bearer ${SECRET_KEY}`,
      `Bearer ${SECRET_KEY}`,
    ]);
    // A session replaces the key on Authorization only; the key itself still rides on apikey.
    expect(calls.map((c) => c.headers.apikey)).toEqual([PUB_KEY, PUB_KEY, SECRET_KEY, SECRET_KEY, SECRET_KEY]);
    expect(calls.map((c) => c.headers.authorization)).not.toContain(token.reveal());
  });

  it('sends `Bearer <value>` on every recovery path too: request, mint, verify and the user write', async () => {
    const token = recoveryToken();
    const session = sessionToken();
    const { http, calls } = mockHttp([
      ['POST', `${AUTH}/recover`, gotrueAuthed({})],
      ['POST', `${AUTH}/admin/generate_link`, gotrueAuthed({ hashed_token: RECOVERY_TOKEN, user: { id: 'usr_1' } })],
      ['POST', `${AUTH}/verify`, gotrueAuthed({ access_token: 'recovery-session-value', user: { id: 'usr_1' } })],
      ['PUT', `${AUTH}/user`, gotrueAuthed({ id: 'usr_1' })],
    ]);
    const api = cap();
    const ctx = testCtx({ http });
    const asked = await api.requestRecovery(ctx, 'a@example.com');
    const link = (await api.recoveryLink!(ctx, 'a@example.com'))!;
    const verified = await api.recoverySession(ctx, token);
    await api.updateOwnPassword(ctx, session, secret());

    // Every route above answers 401 `no_authorization` for a scheme-less header, so a regression to
    // the bare value shows up as a refused recovery request or session, not only in these lines.
    expect(asked.accepted).toBe(true);
    expect(link.userId).toBe('usr_1');
    expect(verified.session).toBeDefined();
    expect(calls.map((c) => c.headers.authorization)).toEqual([`Bearer ${PUB_KEY}`, `Bearer ${SECRET_KEY}`, `Bearer ${PUB_KEY}`, `Bearer ${session.reveal()}`]);
    expect(calls.map((c) => c.headers.apikey)).toEqual([PUB_KEY, SECRET_KEY, PUB_KEY, PUB_KEY]);
    expect(calls.map((c) => c.headers.authorization)).not.toContain(session.reveal());
    expect(calls.map((c) => c.headers.authorization)).not.toContain(token.reveal());
  });
});

// ── prerequisites and identity ───────────────────────────────────────────────────────────────────

describe('prerequisites', () => {
  it('throws a prerequisite error (not a provider failure) when no project is selected', async () => {
    const { http, calls } = mockHttp([]);
    const e = await cap({ ref: async () => null }).signup(testCtx({ http }), 'a@example.com', secret()).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(SupabaseAuthPrereqError);
    expect((e as Error).message).toMatch(/No Supabase project is selected/);
    expect(calls).toHaveLength(0);
  });

  it('turns an unusable credential or a missing key into a prerequisite error', async () => {
    const { http, calls } = mockHttp([]);
    const noCredential = await cap({ keys: async () => { throw new SupabaseError('Reading Supabase API keys needs a reusable Supabase login.'); } }).signup(testCtx({ http }), 'a@example.com', secret()).catch((x: unknown) => x);
    expect(noCredential).toBeInstanceOf(SupabaseAuthPrereqError);
    expect((noCredential as Error).message).toMatch(/needs a reusable Supabase login/);

    const noKey = await cap({ keys: async () => ({ publishable: undefined, secret: new Secret('SUPABASE_SECRET_KEY', SECRET_KEY) }) }).signup(testCtx({ http }), 'a@example.com', secret()).catch((x: unknown) => x);
    expect(noKey).toBeInstanceOf(SupabaseAuthPrereqError);
    expect((noKey as Error).message).toMatch(/publishable/);

    const noSecret = await cap({ keys: async () => ({ publishable: PUB_KEY }) }).setPassword(testCtx({ http }), 'usr_1', secret()).catch((x: unknown) => x);
    expect(noSecret).toBeInstanceOf(SupabaseAuthPrereqError);
    expect((noSecret as Error).message).toMatch(/secret key/);
    expect(calls).toHaveLength(0);
  });

  it('reads the project keys once per run, not once per operation', async () => {
    let reads = 0;
    const { http } = mockHttp([
      ['POST', `${AUTH}/signup`, () => ({ json: { id: 'usr_1', identities: [{}] } })],
      ['POST', `${AUTH}/token`, () => ({ json: { access_token: 'tok', user: { id: 'usr_1' } } })],
      ['GET', `${AUTH}/admin/users/usr_1`, () => ({ json: { id: 'usr_1' } })],
    ]);
    const keys = async () => {
      reads++;
      return { publishable: PUB_KEY, secret: new Secret('SUPABASE_SECRET_KEY', SECRET_KEY) };
    };
    const ctx = testCtx({ http });
    const api = cap({ keys });
    await api.signup(ctx, 'a@example.com', secret());
    await api.login(ctx, 'a@example.com', secret());
    await api.adminUser(ctx, 'usr_1');
    expect(reads).toBe(1);
  });

  it('escapes a user id so it cannot change the admin path', async () => {
    const { http, calls } = mockHttp([['GET', /\/auth\/v1\/admin\/users\//, () => ({ status: 404 })]]);
    expect(await cap().adminUser(testCtx({ http }), 'usr_1/../../projects')).toBeNull();
    expect(calls[0]!.url).toBe(`${AUTH}/admin/users/usr_1%2F..%2F..%2Fprojects`);
  });
});

describe('destination', () => {
  it('reports the project ref and URL without needing a credential, and null when unlinked', async () => {
    const { http, calls } = mockHttp([]);
    expect(await cap().destination(testCtx({ http }))).toEqual({ ref: REF, url: `https://${REF}.supabase.co` });
    expect(await cap({ ref: async () => null }).destination(testCtx({ http }))).toBeNull();
    expect(await cap({ ref: async () => { throw new SupabaseError('token rejected'); } }).destination(testCtx({ http }))).toBeNull();
    expect(calls).toHaveLength(0);
  });
});

describe('testPassword', () => {
  it('generates a long Secret over every character class GoTrue may require', () => {
    const a = testPassword();
    const b = testPassword();
    expect(a).toBeInstanceOf(Secret);
    expect(a.name).toBe('GOLIVE_TEST_PASSWORD');
    expect(a.reveal()).toHaveLength(32);
    expect(a.reveal()).not.toBe(b.reveal());
    expect(a.reveal()).toMatch(/[a-z]/);
    expect(a.reveal()).toMatch(/[A-Z]/);
    expect(a.reveal()).toMatch(/[0-9]/);
    expect(String(a)).not.toContain(a.reveal());
  });
});
