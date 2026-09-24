/**
 * The authentication journey: the `auth.e2e` opt-in, the `auth:test-user` step that seeds ONE account
 * through the provider's own signup, the human's click in the inbox, and the two checks that turn the
 * whole thing into evidence. The fake provider's `authUsers` capability stands in for Supabase's
 * GoTrue API; the one production probe (a declared protected path) is scripted HTTP. Offline only.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildPlan, planView } from '../src/core/plan.js';
import { applyPlan, runCheck } from '../src/core/runner.js';
import { emptyState } from '../src/core/state.js';
import { Secret, _resetSecretRegistry, vaultGet, vaultPut } from '../src/core/secret.js';
import { authSignupCheck } from '../src/checks/auth-signup.js';
import { authSessionCheck } from '../src/checks/auth-session.js';
import { authedRestProbe, restProbe } from '../src/checks/providers.js';
import { ALL_LINKS } from '../src/links/all.js';
import { TEST_USER_EMAIL, TEST_USER_ID, testUserPassKey } from '../src/links/auth-e2e.js';
import type { Check, Ctx, Http, Plan, ShipConfig, ShipState, Step } from '../src/core/types.js';
import { mockHttp, testCtx } from './helpers.js';
import { ALL_RAW_SECRETS, RAW, fakeWorld, type FakeWorld } from './fakes.js';

vi.mock('../src/checks/providers.js', () => ({ restProbe: vi.fn(), accountStatus: vi.fn(), authedRestProbe: vi.fn() }));
const authedProbe = vi.mocked(authedRestProbe);
const anonProbe = vi.mocked(restProbe);

beforeEach(() => {
  _resetSecretRegistry();
  authedProbe.mockReset();
  anonProbe.mockReset();
});

const EMAIL = 'owner+go-live@example.com';
const PROD = 'https://shop.fakehost.app';
const E2E_CONFIG: Partial<ShipConfig> = {
  stack: { hosting: 'fakehost', db: 'fakedb', auth: 'fakedb' },
  auth: { e2e: true, testEmail: EMAIL, protectedPath: '/dashboard' },
};
/** The two checks the step is verified with. */
const CHECKS = new Map<string, Check>([
  ['auth-signup', authSignupCheck],
  ['auth-session', authSessionCheck],
]);

const build = (ctx: Ctx) => buildPlan(ctx, ALL_LINKS, { unmappedEnv: [], warnings: [] });
const apply = (ctx: Ctx, plan: Plan, opts: { confirmLive?: boolean } = {}) =>
  applyPlan(ctx, plan, CHECKS, { approvedPlanId: plan.id, yes: true, confirmLive: opts.confirmLive ?? true, confirmDns: true });
const ids = (p: Plan) => p.steps.map((s) => s.id);
const stepOf = (p: Plan, id: string): Step => {
  const s = p.steps.find((x) => x.id === id);
  if (!s) throw new Error(`no step ${id} in ${ids(p).join(', ')}`);
  return s;
};
const outcomeOf = (out: Awaited<ReturnType<typeof apply>>, id: string) => out.find((o) => o.id === id)!;
const resultOf = (out: Awaited<ReturnType<typeof apply>>, step: string, check: string) => outcomeOf(out, step).checks.find((c) => c.id === check)!;
const table = (name: string) => ({ schema: 'public', name, rls: true, policies: [] });

/**
 * The state and run vault a completed `auth:test-user` step leaves behind: one account in the fake
 * provider and its generated password in this process's vault (never in state).
 */
function seed(w: FakeWorld, opts: { confirmed?: boolean } = {}): { id: string; password: Secret; state: ShipState } {
  const password = new Secret('GOLIVE_TEST_PASSWORD', 'generated-test-password-01');
  const id = `usr_${w.db.authUsers.users.length + 1}`;
  w.db.authUsers.users.push({ id, email: EMAIL, confirmed: opts.confirmed ?? true, pass: password.reveal() });
  vaultPut(testUserPassKey(id), password);
  const state: ShipState = { ...emptyState(), resources: { [TEST_USER_ID]: id, [TEST_USER_EMAIL]: EMAIL }, secrets: {}, steps: {} };
  return { id, password, state };
}

/** The fake stack with the e2e keys; `seed` decides whether a test account already exists. */
function setup(over: { config?: Partial<ShipConfig>; http?: Http; seed?: { confirmed?: boolean } | false; arrange?: (w: FakeWorld) => void } = {}) {
  const w = fakeWorld();
  over.arrange?.(w);
  const state = over.seed === false || (over.seed === undefined && !over.arrange) ? undefined : seed(w, over.seed ?? { confirmed: true }).state;
  const ctx = testCtx({ cwd: '/work/shop', adapters: w.adapters, config: { ...E2E_CONFIG, ...over.config }, state, detect: { envRefs: [] }, http: over.http });
  return { w, ctx };
}

const run = (check: Check, ctx: Ctx) => runCheck(ctx, check);
const seededCtx = (over: { config?: Partial<ShipConfig>; http?: Http; confirmed?: boolean; arrange?: (w: FakeWorld) => void } = {}) =>
  setup({ ...over, seed: { confirmed: over.confirmed ?? true } });

// ── the step ─────────────────────────────────────────────────────────────────────────────────────

describe('auth:test-user step', () => {
  it('plans the seed step and the confirmation handoff only under auth.e2e', async () => {
    const { ctx } = setup({ seed: false });
    const plan = await build(ctx);
    const s = stepOf(plan, 'auth:test-user');
    expect(s.risk).toEqual({ writes: true, live: true });
    expect(s.verifyWith).toEqual(['auth-signup', 'auth-session']);
    expect(s.dependsOn).toEqual(expect.arrayContaining(['project:db']));
    expect(s.preview.join('\n')).toMatch(/create one test account owner\+go-live@example\.com/);
    expect(s.preview.join('\n')).toMatch(/golive cannot read an inbox/);
    const handoff = plan.handoffs.find((h) => h.id === 'auth:confirm-email')!;
    expect(handoff).toMatchObject({ blocking: false, verifiedBy: 'auth-signup' });
    expect(handoff.action).toMatch(/click the link/);

    const noE2e = await build(setup({ seed: false, config: { auth: { testEmail: EMAIL, protectedPath: '/dashboard' } } }).ctx);
    expect(ids(noE2e)).not.toContain('auth:test-user');
    expect(noE2e.handoffs.map((h) => h.id)).not.toContain('auth:confirm-email');
  });

  it('warns instead of planning when the provider or the address cannot carry the journey', async () => {
    const guided = setup({ seed: false, config: { stack: { hosting: 'fakehost', auth: 'fakeguided' } } });
    expect((await build(guided.ctx)).warnings.join('\n')).toMatch(/FakeGuided is not automated by golive/);

    const noAddress = setup({ seed: false, config: { auth: { e2e: true } } });
    const plan = await build(noAddress.ctx);
    expect(ids(plan)).not.toContain('auth:test-user');
    expect(plan.warnings.join('\n')).toMatch(/auth\.testEmail is not set/);
  });

  it('seeds one account and records only the user id and the address', async () => {
    const { w, ctx } = setup({ seed: false });
    const plan = await build(ctx);
    const out = await apply(ctx, plan);
    const o = outcomeOf(out, 'auth:test-user');
    expect(o.status).toBe('done');
    expect(o.changes.join('\n')).toMatch(/created the test account owner\+go-live@example\.com \(usr_1\)/);
    expect(o.changes.join('\n')).toMatch(/confirmation email sent to owner\+go-live@example\.com/);

    const state = ctx.state.get();
    expect(state.resources[TEST_USER_ID]).toBe('usr_1');
    expect(state.resources[TEST_USER_EMAIL]).toBe(EMAIL);
    const generated = vaultGet(testUserPassKey('usr_1'));
    expect(generated).toBeDefined();
    expect(w.db.authUsers.byEmail(EMAIL)!.pass).toBe(generated!.reveal());
    // The generated password goes to the provider as a Secret and appears nowhere printable.
    expect(w.calls.find((c) => c.method === 'authUsers.signup')!.args[1]).toBeInstanceOf(Secret);
    const blob = JSON.stringify([planView(plan), out, state, ctx.logs]);
    expect(blob).not.toContain(generated!.reveal());
    expect(blob).not.toMatch(/GOLIVE_TEST_PASSWORD/);
    for (const raw of ALL_RAW_SECRETS()) expect(blob).not.toContain(raw);
  });

  it('needs --confirm-live and creates nothing without it', async () => {
    const { w, ctx } = setup({ seed: false });
    const plan = await build(ctx);
    const o = outcomeOf(await apply(ctx, plan, { confirmLive: false }), 'auth:test-user');
    expect(o.status).toBe('blocked');
    expect(o.next).toMatch(/--confirm-live/);
    expect(w.db.authUsers.users).toHaveLength(0);
    expect(ctx.state.get().steps['auth:test-user']).toBeUndefined();
  });

  it('fails when the provider refuses the signup', async () => {
    const { w, ctx } = setup({ seed: false, arrange: (x) => (x.db.authUsers.error = 'GoTrue is down') });
    const o = outcomeOf(await apply(ctx, await build(ctx)), 'auth:test-user');
    expect(o.status).toBe('failed');
    expect(o.error).toMatch(/GoTrue is down/);
    expect(ctx.state.get().steps['auth:test-user']!.status).toBe('failed');
    expect(w.db.authUsers.users).toHaveLength(0);
  });

  it('fails with a clear instruction when a captcha blocks a scripted signup', async () => {
    const { ctx } = setup({ seed: false, arrange: (x) => (x.db.authUsers.signup = { status: 400, captchaRequired: true, code: 'captcha_failed' }) });
    const o = outcomeOf(await apply(ctx, await build(ctx)), 'auth:test-user');
    expect(o.status).toBe('failed');
    expect(o.error).toMatch(/captcha/);
  });

  it('fails when the provider rate-limits its auth emails, and says what to check', async () => {
    const { ctx } = setup({ seed: false, arrange: (x) => (x.db.authUsers.signup = { status: 429, rateLimited: true }) });
    const o = outcomeOf(await apply(ctx, await build(ctx)), 'auth:test-user');
    expect(o.status).toBe('failed');
    expect(o.error).toMatch(/429 rate limit/);
    expect(o.error).toMatch(/user list/);
  });

  it('adopts the account it seeded earlier and rotates its password on a later run', async () => {
    const { w, ctx } = setup({ seed: false });
    const first = await build(ctx);
    await apply(ctx, first);
    const before = vaultGet(testUserPassKey('usr_1'))!.reveal();

    const second = await build(ctx); // the intent carries the previous attempt, so the step runs again
    expect(stepOf(second, 'auth:test-user').intent).not.toBe(stepOf(first, 'auth:test-user').intent);
    const o = outcomeOf(await apply(ctx, second), 'auth:test-user');
    expect(o.status).toBe('done');
    expect(o.changes.join('\n')).toMatch(/set a new password on the existing test account/);
    expect(w.db.authUsers.users.filter((u) => u.email === EMAIL)).toHaveLength(1);
    const after = vaultGet(testUserPassKey('usr_1'))!.reveal();
    expect(after).not.toBe(before);
    expect(w.db.authUsers.byEmail(EMAIL)!.pass).toBe(after);
  });

  it('fails when the recorded test account is gone from the provider', async () => {
    const { w, ctx } = setup({ seed: false });
    await apply(ctx, await build(ctx));
    w.db.authUsers.missing.add('usr_1');
    const o = outcomeOf(await apply(ctx, await build(ctx)), 'auth:test-user');
    expect(o.status).toBe('failed');
    expect(o.error).toMatch(/is gone from FakeDB/);
    expect(o.error).toMatch(/\.golive\/state\.json/);
  });
});

// ── the journey, through the checks ──────────────────────────────────────────────────────────────

describe('the whole journey', () => {
  it('proves signup, enforced confirmation, the click, login and a protected route', async () => {
    const { http, calls } = mockHttp([['GET', `${PROD}/dashboard`, () => ({ status: 302, headers: { location: '/login' } })]]);
    const { w, ctx } = setup({
      seed: false,
      http,
      arrange: (x) => {
        x.adapters.find((a) => a.id === 'fakedb')!.capabilities.dbAdmin!.tables = async () => [table('orders')];
      },
    });
    authedProbe.mockResolvedValue({ status: 200, rows: 0 });

    // Before the human clicks: the account exists, so the checks warn about the pending confirmation.
    const first = await apply(ctx, await build(ctx));
    expect(outcomeOf(first, 'auth:test-user').status).toBe('done');
    const pending = resultOf(first, 'auth:test-user', 'auth-signup');
    expect(pending.status).toBe('warn');
    expect(pending.evidence.join('\n')).toMatch(/is not confirmed yet/);
    expect(resultOf(first, 'auth:test-user', 'auth-session').status).toBe('warn');

    // The human clicks the link in their inbox; a fresh plan + apply rotates the password.
    w.db.authUsers.confirm(EMAIL);
    const second = await apply(ctx, await build(ctx));
    expect(outcomeOf(second, 'auth:test-user').status).toBe('done');

    const signup = resultOf(second, 'auth:test-user', 'auth-signup');
    expect(signup.status).toBe('pass');
    const signupText = signup.evidence.join('\n');
    expect(signupText).toMatch(/confirmation email sent/);
    expect(signupText).toMatch(/cannot sign in before confirming \(email_not_confirmed\)/);
    expect(signupText).toMatch(/is confirmed \(email_confirmed_at set\)/);
    expect(signupText).toMatch(/the confirmed test account signed in \(user usr_1\)/);
    expect(signupText).toMatch(/delivery itself stays human-confirmed/);

    const session = resultOf(second, 'auth:test-user', 'auth-session');
    expect(session.status).toBe('pass');
    const sessionText = session.evidence.join('\n');
    expect(sessionText).toMatch(/signed in as owner\+go-live@example\.com/);
    expect(sessionText).toMatch(/GET \/auth\/v1\/user with that token returned the same user \(usr_1\)/);
    expect(sessionText).toMatch(/an anonymous GET \/auth\/v1\/user is refused \(401\)/);
    expect(sessionText).toMatch(/anonymous GET https:\/\/shop\.fakehost\.app\/dashboard → HTTP 302 \(→ \/login\)/);
    expect(sessionText).toMatch(/probed 1 exposed table\(s\) as the signed-in user: 1 reachable/);

    // The only production request is the anonymous GET of the declared path.
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([`GET ${PROD}/dashboard`]);
    expect(JSON.stringify([ctx.state.get(), ctx.logs, sessionText, signupText])).not.toContain(RAW.authSession);
  });
});

// ── auth-signup ──────────────────────────────────────────────────────────────────────────────────

describe('auth-signup check', () => {
  it('skips without the opt-in, without an address, without the capability or without a login', async () => {
    expect((await run(authSignupCheck, setup({ config: { auth: { testEmail: EMAIL } } }).ctx)).evidence[0]).toMatch(/auth\.e2e is not enabled/);
    expect((await run(authSignupCheck, setup({ config: { auth: { e2e: true } } }).ctx)).evidence[0]).toMatch(/auth\.testEmail is not set/);
    expect((await run(authSignupCheck, setup({ config: { stack: { hosting: 'fakehost', auth: 'fakeguided' } } }).ctx)).evidence[0]).toMatch(/no auth-users surface/);
    const out = await run(authSignupCheck, setup({ arrange: (w) => (w.db.authed = false) }).ctx);
    expect(out).toMatchObject({ status: 'skip', evidence: ['blocked by: login:fakedb'] });
  });

  it('skips until a test account has been seeded, and when a captcha blocks the probe', async () => {
    expect(await run(authSignupCheck, setup({ seed: false }).ctx)).toMatchObject({ status: 'skip', evidence: ['blocked by: auth:test-user (no test account has been seeded yet)'] });

    const captcha = seededCtx({ arrange: (w) => (w.db.authUsers.signup = { status: 400, captchaRequired: true, code: 'captcha_failed' }) });
    const r = await run(authSignupCheck, captcha.ctx);
    expect(r.status).toBe('skip');
    expect(r.evidence[0]).toMatch(/requires a captcha for signup/);
  });

  it('warns when the mailer rate-limits the probe signup (429)', async () => {
    const { ctx } = seededCtx({ arrange: (w) => (w.db.authUsers.signup = { status: 429, rateLimited: true }) });
    const r = await run(authSignupCheck, ctx);
    expect(r.status).toBe('warn');
    expect(r.severity).toBe('medium');
    expect(r.evidence[0]).toMatch(/signup for the probe address .* was rate-limited \(HTTP 429\)/);
    expect(r.fix).toMatch(/Wait for FakeDB's auth email limit/);
  });

  it('fails when the signup was accepted without sending a confirmation email', async () => {
    const { ctx } = seededCtx({ arrange: (w) => (w.db.authUsers.signup = { status: 200, existing: true }) });
    const r = await run(authSignupCheck, ctx);
    expect(r.status).toBe('fail');
    expect(r.severity).toBe('high');
    expect(r.evidence[0]).toMatch(/accepted without sending a confirmation email/);
    expect(r.evidence[0]).toMatch(/the address already has an account/);
    expect(r.fix).toMatch(/auth\.requireEmailConfirm: true/);
  });

  it('fails critically when an unconfirmed address can sign in', async () => {
    const { ctx } = seededCtx({
      arrange: (w) => w.db.authUsers.logins.push({ session: { accessToken: new Secret('SUPABASE_AUTH_TOKEN', 'issued-early'), userId: 'usr_1', emailConfirmed: false } }),
    });
    const r = await run(authSignupCheck, ctx);
    expect(r.status).toBe('fail');
    expect(r.severity).toBe('critical');
    expect(r.evidence[0]).toMatch(/signed in and got a session: email confirmation is not enforced/);
    expect(r.fix).toMatch(/not proven to belong to a real inbox/);
  });

  it('warns when the refusal was not `email_not_confirmed`, so enforcement is not proven', async () => {
    const { ctx } = seededCtx({ arrange: (w) => w.db.authUsers.logins.push({ code: 'invalid_credentials' }) });
    const r = await run(authSignupCheck, ctx);
    expect(r.status).toBe('warn');
    expect(r.evidence[0]).toMatch(/instead of `email_not_confirmed`, so confirmation enforcement is not proven/);
  });

  it('fails with the reason when the provider errors mid-check instead of reporting a refusal', async () => {
    const broken = await run(authSignupCheck, seededCtx({ arrange: (w) => (w.db.authUsers.error = 'GoTrue is down') }).ctx);
    expect(broken.status).toBe('fail');
    expect(broken.evidence[0]).toMatch(/signing up a probe account failed: GoTrue is down/);

    const midLogin = await run(authSignupCheck, seededCtx({ arrange: (w) => (w.db.authUsers.loginError = 'connection reset') }).ctx);
    expect(midLogin.status).toBe('fail');
    expect(midLogin.evidence[0]).toMatch(/the password login for the probe account failed: connection reset/);
  });

  it('warns while the human has not clicked the confirmation link yet', async () => {
    const r = await run(authSignupCheck, seededCtx({ confirmed: false }).ctx);
    expect(r.status).toBe('warn');
    const text = r.evidence.join('\n');
    expect(text).toMatch(/the test account .* is not confirmed yet/);
    expect(text).toMatch(/golive cannot read an inbox, so delivery and the click stay human-confirmed/);
    expect(text).toMatch(/cannot sign in before confirming/);
  });

  it('skips the login leg it cannot evidence when this run holds no password', async () => {
    // A recorded account with no password in this process: exactly a `verify` run after an apply.
    const w = fakeWorld();
    w.db.authUsers.users.push({ id: 'usr_1', email: EMAIL, confirmed: true, pass: 'whatever' });
    const state: ShipState = { ...emptyState(), resources: { [TEST_USER_ID]: 'usr_1', [TEST_USER_EMAIL]: EMAIL }, secrets: {}, steps: {} };
    const ctx = testCtx({ cwd: '/work/shop', adapters: w.adapters, config: { ...E2E_CONFIG } as ShipConfig, state, detect: { envRefs: [] } });
    const r = await run(authSignupCheck, ctx);
    expect(r.status).toBe('skip');
    expect(r.evidence[0]).toMatch(/^blocked by: no password for the test account in this run/);
    // The probe evidence is still reported, so the skip does not hide a broken signup.
    expect(r.evidence.join('\n')).toMatch(/confirmation email sent/);
  });

  it('fails when the confirmed test account cannot sign in', async () => {
    const { w, ctx } = seededCtx();
    w.db.authUsers.byEmail(EMAIL)!.pass = 'a different password now';
    const r = await run(authSignupCheck, ctx);
    expect(r.status).toBe('fail');
    expect(r.evidence[0]).toMatch(/cannot sign in \(invalid_credentials\)/);
  });

  it('fails when the recorded test account is gone', async () => {
    const { w, ctx } = seededCtx();
    w.db.authUsers.missing.add('usr_1');
    const r = await run(authSignupCheck, ctx);
    expect(r.status).toBe('fail');
    expect(r.evidence[0]).toMatch(/recorded in \.golive\/state\.json is gone from FakeDB/);
  });

  it('passes when the signal is complete: probe refused, account confirmed, login works', async () => {
    const r = await run(authSignupCheck, seededCtx().ctx);
    expect(r.status).toBe('pass');
    expect(r.severity).toBe('info');
    expect(r.evidence.join('\n')).toMatch(/email_confirmed_at set/);
  });
});

// ── auth-session ─────────────────────────────────────────────────────────────────────────────────

describe('auth-session check', () => {
  it('skips without the opt-in, without a capability, without an account or without a password', async () => {
    expect((await run(authSessionCheck, setup({ config: { auth: { testEmail: EMAIL } } }).ctx)).evidence[0]).toMatch(/auth\.e2e is not enabled/);
    expect((await run(authSessionCheck, setup({ config: { stack: { hosting: 'fakehost', auth: 'fakeguided' } } }).ctx)).evidence[0]).toMatch(/no auth-users surface/);
    expect((await run(authSessionCheck, setup({ seed: false }).ctx)).evidence[0]).toMatch(/^blocked by: auth:test-user/);

    const w = fakeWorld();
    w.db.authUsers.users.push({ id: 'usr_1', email: EMAIL, confirmed: true, pass: 'x' });
    const state: ShipState = { ...emptyState(), resources: { [TEST_USER_ID]: 'usr_1' }, secrets: {}, steps: {} };
    const ctx = testCtx({ cwd: '/work/shop', adapters: w.adapters, config: { ...E2E_CONFIG } as ShipConfig, state, detect: { envRefs: [] } });
    expect((await run(authSessionCheck, ctx)).evidence[0]).toMatch(/^blocked by: no password for the test account/);
  });

  it('skips when the provider cannot report where the users live', async () => {
    const { ctx } = seededCtx({ arrange: (w) => (w.db.authUsers.destination = null) });
    expect(await run(authSessionCheck, ctx)).toMatchObject({ status: 'skip', evidence: ['blocked by: project:db (no Supabase project is selected for this app)'] });
  });

  it('warns while the account is unconfirmed and when login is rate-limited', async () => {
    const pending = await run(authSessionCheck, seededCtx({ confirmed: false }).ctx);
    expect(pending.status).toBe('warn');
    expect(pending.evidence[0]).toMatch(/is not confirmed yet, so there is no session to check/);

    const limited = await run(authSessionCheck, seededCtx({ arrange: (w) => w.db.authUsers.logins.push({ status: 429, rateLimited: true }) }).ctx);
    expect(limited.status).toBe('warn');
    expect(limited.evidence[0]).toMatch(/rate-limited \(HTTP 429\)/);
  });

  it('fails when the confirmed account cannot sign in', async () => {
    const { w, ctx } = seededCtx();
    w.db.authUsers.users[0]!.pass = 'rotated elsewhere';
    const r = await run(authSessionCheck, ctx);
    expect(r.status).toBe('fail');
    expect(r.evidence[0]).toMatch(/cannot sign in \(invalid_credentials\)/);
  });

  it('fails when the token it just issued is rejected', async () => {
    // The provider issues a session whose token it then refuses: exactly what an app would hit.
    const { http } = mockHttp([['GET', `${PROD}/dashboard`, () => ({ status: 401 })]]);
    const { ctx } = seededCtx({ http, arrange: (w) => w.db.authUsers.logins.push({ session: { accessToken: new Secret('SUPABASE_AUTH_TOKEN', 'rotated-elsewhere'), userId: 'usr_1', emailConfirmed: true } }) });
    const r = await run(authSessionCheck, ctx);
    expect(r.status).toBe('fail');
    expect(r.evidence[0]).toMatch(/the session token was rejected/);
    expect(r.fix).toMatch(/rejected a token it just issued/);
  });

  it('fails when the anonymous user endpoint answers with a user', async () => {
    const { ctx } = seededCtx({ arrange: (w) => (w.db.authUsers.anonUser = { status: 200, id: 'usr_1', email: EMAIL, emailConfirmed: true }) });
    const r = await run(authSessionCheck, ctx);
    expect(r.status).toBe('fail');
    expect(r.severity).toBe('critical');
    expect(r.evidence[0]).toMatch(/an anonymous GET \/auth\/v1\/user returned a user/);
  });

  it('fails when the declared protected path is served without a session', async () => {
    const { http } = mockHttp([['GET', `${PROD}/dashboard`, () => ({ status: 200, text: '<html>dashboard</html>' })]]);
    const r = await run(authSessionCheck, seededCtx({ http }).ctx);
    expect(r.status).toBe('fail');
    expect(r.severity).toBe('critical');
    expect(r.evidence[0]).toMatch(/the declared protected path is served without a session/);
    expect(r.fix).toMatch(/pick a path that redirects/);
  });

  it('warns when a 404 means the declared path is wrong, and skips when the URL cannot be confirmed', async () => {
    const { http } = mockHttp([['GET', `${PROD}/dashboard`, () => ({ status: 404 })]]);
    const r404 = await run(authSessionCheck, seededCtx({ http }).ctx);
    expect(r404.status).toBe('warn');
    expect(r404.evidence.join('\n')).toMatch(/could not establish protection/);

    const rSkip = await run(authSessionCheck, seededCtx({ arrange: (w) => (w.host.urls.production = null) }).ctx);
    expect(rSkip.status).toBe('skip');
    expect(rSkip.evidence[0]).toMatch(/^blocked by: deploy:production/);
  });

  it('warns when the signed-in user is denied by every exposed table', async () => {
    const { http } = mockHttp([['GET', `${PROD}/dashboard`, () => ({ status: 302 })]]);
    const { ctx } = seededCtx({
      http,
      arrange: (w) => {
        w.adapters.find((a) => a.id === 'fakedb')!.capabilities.dbAdmin!.tables = async () => [table('orders'), table('profiles')];
      },
    });
    authedProbe.mockResolvedValue({ status: 403, rows: 0, code: '42501' });
    const r = await run(authSessionCheck, ctx);
    expect(r.status).toBe('warn');
    const text = r.evidence.join('\n');
    expect(text).toMatch(/denied by every exposed table golive probed \(2\)/);
    expect(text).toMatch(/probed 2 exposed table\(s\) as the signed-in user: 0 reachable, 2 denied/);
    expect(r.fix).toMatch(/grant select on <table> to authenticated/);
  });

  it('passes with a session, an anonymous refusal and a protected route', async () => {
    const { http } = mockHttp([['GET', `${PROD}/dashboard`, () => ({ status: 307, headers: { location: '/login' } })]]);
    const r = await run(authSessionCheck, seededCtx({ http }).ctx);
    expect(r.status).toBe('pass');
    expect(r.evidence.join('\n')).toMatch(/anonymous GET https:\/\/shop\.fakehost\.app\/dashboard → HTTP 307 \(→ \/login\): redirected out of the route without a session/);
  });

  it("does not take over rls-probe's job: no anonymous table probe", async () => {
    const { http, calls } = mockHttp([['GET', `${PROD}/dashboard`, () => ({ status: 401 })]]);
    const { ctx } = seededCtx({
      http,
      arrange: (w) => {
        w.adapters.find((a) => a.id === 'fakedb')!.capabilities.dbAdmin!.tables = async () => [table('orders')];
      },
    });
    authedProbe.mockResolvedValue({ status: 200, rows: 0 });
    expect((await run(authSessionCheck, ctx)).status).toBe('pass');
    // Every table probe carried the session token, and nothing anonymous touched the Data API.
    expect(authedProbe).toHaveBeenCalledTimes(1);
    expect(authedProbe.mock.calls[0]![5]).toMatchObject({ name: 'SUPABASE_AUTH_TOKEN' });
    expect(anonProbe).not.toHaveBeenCalled();
    expect(calls.every((c) => !c.url.includes('/rest/v1/'))).toBe(true);
  });
});
