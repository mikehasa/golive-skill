/**
 * The Supabase Auth (GoTrue) adapter: request shapes, both API-key shapes, response parsing and the
 * refusals the checks read. Offline only: scripted HTTP, no project, no account.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mockHttp, testCtx } from '../helpers.js';
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

describe('user', () => {
  it('without a token asks as an anonymous client and reports the refusal', async () => {
    const { http, calls } = mockHttp([['GET', `${AUTH}/user`, () => ({ status: 401, json: { msg: 'invalid claim: missing sub claim' } })]]);
    expect(await cap().user(testCtx({ http }))).toEqual({ status: 401 });
    expect(calls[0]!.headers.apikey).toBe(PUB_KEY);
    expect(calls[0]!.headers.authorization).toBe(`Bearer ${PUB_KEY}`);
  });

  it('with a session token sends it as the bearer and returns the same user', async () => {
    const token = new Secret('SUPABASE_AUTH_TOKEN', 'session-token-value-1234');
    const { http, calls } = mockHttp([['GET', `${AUTH}/user`, () => ({ json: { id: 'usr_1', email: 'a@example.com', confirmed_at: '2026-09-23T00:00:00Z' } })]]);
    expect(await cap().user(testCtx({ http }), token)).toEqual({ status: 200, id: 'usr_1', email: 'a@example.com', emailConfirmed: true });
    expect(calls[0]!.headers.authorization).toBe(token.reveal());
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

  it('a rejected admin read names the key problem and stays secret-free', async () => {
    const { http } = mockHttp([['GET', `${AUTH}/admin/users/usr_1`, () => ({ status: 403, json: { msg: `forbidden for ${SECRET_KEY}` } })]]);
    const e = await cap().adminUser(testCtx({ http }), 'usr_1').catch((x: unknown) => x as Error);
    expect((e as Error).message).toMatch(/the project key was not allowed to do this \(403\)/);
    expect((e as Error).message).toMatch(/golive doctor/);
    expectNoSecret((e as Error).message);
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
