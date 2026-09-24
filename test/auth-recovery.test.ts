/**
 * Password recovery: the `auth.recovery` opt-in, the `auth:recovery` step that rotates the recorded
 * test account's password through the provider's own recovery calls (request → mint → verify → set
 * the new password), and the `auth-recovery` check that turns the outcome into evidence. The fake
 * provider's `authUsers` capability stands in for Supabase's GoTrue API; the one production probe
 * (a declared protected path, run by `auth-session`) is scripted HTTP. Offline only: no account, no
 * network, no inbox.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPlan, planView } from '../src/core/plan.js';
import { applyPlan, runCheck } from '../src/core/runner.js';
import { emptyState } from '../src/core/state.js';
import { Secret, _resetSecretRegistry, vaultGet, vaultPut } from '../src/core/secret.js';
import { authRecoveryCheck } from '../src/checks/auth-recovery.js';
import { authSessionCheck } from '../src/checks/auth-session.js';
import { authSignupCheck } from '../src/checks/auth-signup.js';
import { authedRestProbe, restProbe } from '../src/checks/providers.js';
import { ALL_LINKS } from '../src/links/all.js';
import { TEST_USER_EMAIL, TEST_USER_ID, testUserPassKey } from '../src/links/auth-e2e.js';
import { recoveryOldPassKey, recoveryTokenKey } from '../src/links/auth-recovery.js';
import type { Adapter, Check, Ctx, Http, Plan, ShipConfig, ShipState, Step } from '../src/core/types.js';
import { mockHttp, testCtx } from './helpers.js';
import { ALL_RAW_SECRETS, fakeWorld, type FakeWorld } from './fakes.js';

vi.mock('../src/checks/providers.js', () => ({ restProbe: vi.fn(), accountStatus: vi.fn(), authedRestProbe: vi.fn() }));
const authedProbe = vi.mocked(authedRestProbe);
const anonProbe = vi.mocked(restProbe);

// The `golive handoff` test at the end drives the real CLI; the harness swaps in the fakes so the
// command (not just the check) is exercised offline.
const mocks = vi.hoisted(() => ({ adapters: [] as Adapter[] }));
vi.mock('../src/registry.js', async (original) => ({ ...await original<typeof import('../src/registry.js')>(), ADAPTERS: mocks.adapters }));

beforeEach(() => {
  _resetSecretRegistry();
  authedProbe.mockReset();
  anonProbe.mockReset();
});

const EMAIL = 'owner+go-live@example.com';
const PROD = 'https://shop.fakehost.app';
const RECOVERY_CONFIG: Partial<ShipConfig> = {
  stack: { hosting: 'fakehost', db: 'fakedb', auth: 'fakedb' },
  auth: { e2e: true, testEmail: EMAIL, protectedPath: '/dashboard', recovery: true },
};
/** The checks the journey's steps are verified with. */
const CHECKS = new Map<string, Check>([
  ['auth-signup', authSignupCheck],
  ['auth-session', authSessionCheck],
  ['auth-recovery', authRecoveryCheck],
]);

const defaultHttp = () => mockHttp([['GET', `${PROD}/dashboard`, () => ({ status: 302, headers: { location: '/login' } })]]).http;
const build = (ctx: Ctx) => buildPlan(ctx, ALL_LINKS, { unmappedEnv: [], warnings: [] });
const apply = (ctx: Ctx, plan: Plan, opts: { confirmLive?: boolean; only?: string[]; force?: boolean } = {}) =>
  applyPlan(ctx, plan, CHECKS, { approvedPlanId: plan.id, yes: true, confirmLive: opts.confirmLive ?? true, confirmDns: true, only: opts.only, force: opts.force });
const ids = (p: Plan) => p.steps.map((s) => s.id);
const stepOf = (p: Plan, id: string): Step => {
  const s = p.steps.find((x) => x.id === id);
  if (!s) throw new Error(`no step ${id} in ${ids(p).join(', ')}`);
  return s;
};
const outcomeOf = (out: Awaited<ReturnType<typeof apply>>, id: string) => out.find((o) => o.id === id)!;
const resultOf = (out: Awaited<ReturnType<typeof apply>>, step: string, check: string) => outcomeOf(out, step).checks.find((c) => c.id === check)!;
const run = (check: Check, ctx: Ctx) => runCheck(ctx, check);
const providerPass = (w: FakeWorld): string => w.db.authUsers.byEmail(EMAIL)!.pass;
const vaultPass = (id: string, key: (id: string) => string): string => vaultGet(key(id))!.reveal();

/**
 * The state and run vault a completed `auth:test-user` step leaves behind: one confirmed account in
 * the fake provider and its generated password in this process's vault (never in state).
 */
function seed(w: FakeWorld, opts: { confirmed?: boolean } = {}): { id: string; password: Secret; state: ShipState } {
  const password = new Secret('GOLIVE_TEST_PASSWORD', 'generated-test-password-01');
  const id = `usr_${w.db.authUsers.users.length + 1}`;
  w.db.authUsers.users.push({ id, email: EMAIL, confirmed: opts.confirmed ?? true, pass: password.reveal() });
  vaultPut(testUserPassKey(id), password);
  const state: ShipState = { ...emptyState(), resources: { [TEST_USER_ID]: id, [TEST_USER_EMAIL]: EMAIL }, secrets: {}, steps: {} };
  return { id, password, state };
}

/**
 * The fake stack with `auth.recovery` opted in and one confirmed test account recorded. `seed: false`
 * leaves the world without that account: the shape a `verify` before the first apply sees.
 */
function setup(over: { config?: Partial<ShipConfig>; http?: Http; seed?: false | { confirmed?: boolean }; arrange?: (w: FakeWorld) => void } = {}) {
  const w = fakeWorld();
  const state = over.seed === false ? undefined : seed(w, over.seed ?? {}).state;
  over.arrange?.(w);
  const ctx = testCtx({ cwd: '/work/shop', adapters: w.adapters, config: { ...RECOVERY_CONFIG, ...over.config }, state, detect: { envRefs: [] }, http: over.http ?? defaultHttp() });
  return { w, ctx };
}

/** A full approved apply: the e2e step seeds/rotates, then the recovery step rotates again. */
async function applied(over: { config?: Partial<ShipConfig>; arrange?: (w: FakeWorld) => void } = {}) {
  const { w, ctx } = setup(over);
  const plan = await build(ctx);
  const out = await apply(ctx, plan);
  return { w, ctx, plan, out };
}

// ── the step ─────────────────────────────────────────────────────────────────────────────────────

describe('auth:recovery step', () => {
  it('plans the rotation step and the recovery-email handoff only under auth.recovery', async () => {
    const { ctx } = setup();
    const plan = await build(ctx);
    const s = stepOf(plan, 'auth:recovery');
    expect(s.risk).toEqual({ writes: true, live: true, replayable: true });
    expect(s.verifyWith).toEqual(['auth-recovery']);
    expect(s.dependsOn).toEqual(expect.arrayContaining(['project:db', 'auth:test-user']));
    expect(s.preview.join('\n')).toMatch(/send a real password-recovery email for owner\+go-live@example\.com/);
    expect(s.preview.join('\n')).toMatch(/golive cannot read one/);
    const handoff = plan.handoffs.find((h) => h.id === 'auth:recovery-email')!;
    expect(handoff).toMatchObject({ blocking: false, verifiedBy: 'auth-recovery' });
    expect(handoff.action).toMatch(/click the link/);

    const off = setup({ config: { auth: { e2e: true, testEmail: EMAIL, protectedPath: '/dashboard' } } });
    const offPlan = await build(off.ctx);
    expect(ids(offPlan)).not.toContain('auth:recovery');
    expect(offPlan.handoffs.map((h) => h.id)).not.toContain('auth:recovery-email');
  });

  it('warns instead of planning when there is no account golive may touch', async () => {
    const none = setup({ seed: false });
    expect((await build(none.ctx)).warnings.join('\n')).toMatch(/no test account is recorded yet/);

    const gone = setup({ arrange: (w) => w.db.authUsers.missing.add('usr_1') });
    const gonePlan = await build(gone.ctx);
    expect(ids(gonePlan)).not.toContain('auth:recovery');
    expect(gonePlan.warnings.join('\n')).toMatch(/is gone from FakeDB/);

    const pending = setup({ seed: { confirmed: false } });
    const pendingPlan = await build(pending.ctx);
    expect(ids(pendingPlan)).not.toContain('auth:recovery');
    expect(pendingPlan.warnings.join('\n')).toMatch(/is not confirmed yet: a recovery of an unconfirmed address sends a confirmation/);

    const guided = setup({ config: { stack: { hosting: 'fakehost', auth: 'fakeguided' } } });
    expect((await build(guided.ctx)).warnings.join('\n')).toMatch(/FakeGuided is not automated by golive/);

    const noMint = setup({
      arrange: (w) => {
        delete (w.adapters.find((a) => a.id === 'fakedb')!.capabilities.authUsers as { recoveryLink?: unknown }).recoveryLink;
      },
    });
    const noMintPlan = await build(noMint.ctx);
    expect(ids(noMintPlan)).not.toContain('auth:recovery');
    expect(noMintPlan.warnings.join('\n')).toMatch(/cannot mint a recovery link/);
  });

  it('rotates the recorded account through the recovery path and records no secret', async () => {
    const { w, ctx, plan, out } = await applied();
    const o = outcomeOf(out, 'auth:recovery');
    expect(o.status).toBe('done');
    const changes = o.changes.join('\n');
    expect(changes).toMatch(/asked FakeDB to send a recovery email for owner\+go-live@example\.com \(HTTP 200\)/);
    expect(changes).toMatch(/set a new password on the same account through the recovery link \(user usr_1\)/);
    expect(changes).toMatch(/the replaced password is refused from now on/);
    expect(changes).toMatch(/still reads back confirmed/);

    // The recovery leg is the app's own shape: request, mint, verify, set the password with the
    // session — consecutive, and after the e2e step's admin rotation.
    const calls = w.calls.map((c) => c.method);
    const at = (m: string) => calls.indexOf(m);
    expect(calls.slice(at('authUsers.requestRecovery'), at('authUsers.updateOwnPassword') + 1)).toEqual([
      'authUsers.requestRecovery',
      'authUsers.recoveryLink',
      'authUsers.recoverySession',
      'authUsers.updateOwnPassword',
    ]);
    expect(at('authUsers.requestRecovery')).toBeGreaterThan(at('authUsers.setPassword'));
    expect(w.db.authUsers.recoveryRequests[0]).toBe(EMAIL);

    // The new password is in the provider and under the SAME vault key auth.e2e uses; the replaced one
    // is kept aside for the check's old-password leg, and the spent token for its replay leg.
    expect(providerPass(w)).toBe(vaultPass('usr_1', testUserPassKey));
    expect(vaultPass('usr_1', recoveryOldPassKey)).not.toBe(providerPass(w));
    expect(vaultGet(recoveryTokenKey('usr_1'))).toBeDefined();

    const state = ctx.state.get();
    expect(state.resources[TEST_USER_ID]).toBe('usr_1');
    expect(state.resources[TEST_USER_EMAIL]).toBe(EMAIL);
    expect(state.secrets).toEqual({});
    const blob = JSON.stringify([planView(plan), out, state, ctx.logs]);
    expect(blob).not.toContain(providerPass(w));
    expect(blob).not.toContain(vaultPass('usr_1', recoveryOldPassKey));
    expect(blob).not.toContain(vaultPass('usr_1', recoveryTokenKey));
    expect(blob).not.toMatch(/GOLIVE_TEST_PASSWORD/);
    for (const raw of ALL_RAW_SECRETS()) expect(blob).not.toContain(raw);
  });

  it("keeps the password under auth.e2e's vault key, so auth-session still passes in the same run", async () => {
    const { w, ctx, out } = await applied();
    expect(outcomeOf(out, 'auth:test-user').status).toBe('done');
    expect(outcomeOf(out, 'auth:recovery').status).toBe('done');
    const verified = resultOf(out, 'auth:recovery', 'auth-recovery');
    expect(verified.status).toBe('pass');
    expect(verified.evidence.join('\n')).toMatch(/the password set through the recovery path signs in \(user usr_1\)/);

    // The rotation replaced the password the e2e step had just set, and the rest of the journey runs
    // on the new one without a second seeding step.
    const again = await run(authSessionCheck, ctx);
    expect(again.status).toBe('pass');
    expect(again.evidence.join('\n')).toMatch(/signed in as owner\+go-live@example\.com/);
    expect(w.db.authUsers.users.filter((u) => u.email === EMAIL)).toHaveLength(1);
  });

  it('needs --confirm-live and rotates nothing without it', async () => {
    const { w, ctx, plan } = await applied();
    // The plan tells the human the gate before anything runs...
    expect(planView(plan).steps.find((s) => s.id === 'auth:recovery')).toMatchObject({ writes: true, needs: ['--confirm-live'] });
    // ...and without the flag the step is blocked, not run: no request, no rotation.
    const before = providerPass(w);
    const asked = w.db.authUsers.recoveryRequests.length;
    const o = outcomeOf(await apply(ctx, plan, { only: ['auth:recovery'], force: true, confirmLive: false }), 'auth:recovery');
    expect(o.status).toBe('blocked');
    expect(o.next).toMatch(/--confirm-live/);
    expect(providerPass(w)).toBe(before);
    expect(w.db.authUsers.recoveryRequests).toHaveLength(asked);
  });

  it('fails with the reason when the provider refuses the request, wants a captcha or throttles its mail', async () => {
    const refused = await applied({ arrange: (w) => (w.db.authUsers.recovery = { status: 422, accepted: false, emailSent: false, code: 'email_address_invalid' }) });
    const a = outcomeOf(refused.out, 'auth:recovery');
    expect(a.status).toBe('failed');
    expect(a.error).toMatch(/The recovery request for owner\+go-live@example\.com was refused \(HTTP 422 email_address_invalid\)/);

    const captcha = await applied({ arrange: (w) => (w.db.authUsers.recovery = { status: 400, accepted: false, captchaRequired: true, code: 'captcha_failed' }) });
    expect(outcomeOf(captcha.out, 'auth:recovery').error).toMatch(/wants a captcha for password recovery/);

    const limited = await applied({ arrange: (w) => (w.db.authUsers.recovery = { status: 429, accepted: false, rateLimited: true }) });
    const l = outcomeOf(limited.out, 'auth:recovery');
    expect(l.status).toBe('failed');
    expect(l.error).toMatch(/HTTP 429 rate limit/);
    expect(l.error).toMatch(/custom SMTP/);
    // Nothing was rotated: the account still has the password the e2e step set, and the vault agrees.
    expect(providerPass(limited.w)).toBe(vaultPass('usr_1', testUserPassKey));
  });

  it('fails when the provider has no account for the address or mints a link for another user', async () => {
    const gone = await applied({ arrange: (w) => (w.db.authUsers.linkMissing = true) });
    const g = outcomeOf(gone.out, 'auth:recovery');
    expect(g.status).toBe('failed');
    expect(g.error).toMatch(/has no account for owner\+go-live@example\.com, so no recovery link could be minted/);

    const stranger = await applied({ arrange: (w) => (w.db.authUsers.linkUserId = 'usr_someone_else') });
    const s = outcomeOf(stranger.out, 'auth:recovery');
    expect(s.status).toBe('failed');
    expect(s.error).toMatch(/belongs to user usr_someone_else, not the recorded test account usr_1/);
  });

  it("re-reads the recorded account before rotating and refuses on the provider's state", async () => {
    const gone = await applied();
    gone.w.db.authUsers.missing.add('usr_1');
    const g = outcomeOf(await apply(gone.ctx, gone.plan, { only: ['auth:recovery'], force: true }), 'auth:recovery');
    expect(g.status).toBe('failed');
    expect(g.error).toMatch(/is gone from FakeDB/);
    expect(g.error).toMatch(/\.golive\/state\.json/);

    const pending = await applied();
    pending.w.db.authUsers.users[0]!.confirmed = false;
    const p = outcomeOf(await apply(pending.ctx, pending.plan, { only: ['auth:recovery'], force: true }), 'auth:recovery');
    expect(p.status).toBe('failed');
    expect(p.error).toMatch(/is not confirmed yet, so a recovery link cannot set its password/);
  });
});

// ── auth-recovery ────────────────────────────────────────────────────────────────────────────────

describe('auth-recovery check', () => {
  it("skips without the opt-in, without a capability, without a login, without an account or without this run's token", async () => {
    expect((await run(authRecoveryCheck, setup({ config: { auth: { e2e: true, testEmail: EMAIL } } }).ctx)).evidence[0]).toMatch(/auth\.recovery is not enabled/);
    expect((await run(authRecoveryCheck, setup({ config: { stack: { hosting: 'fakehost', auth: 'fakeguided' } } }).ctx)).evidence[0]).toMatch(/no auth-users surface/);
    expect(await run(authRecoveryCheck, setup({ arrange: (w) => (w.db.authed = false) }).ctx)).toMatchObject({ status: 'skip', evidence: ['blocked by: login:fakedb'] });
    expect(await run(authRecoveryCheck, setup({ seed: false }).ctx)).toMatchObject({ status: 'skip', evidence: ['blocked by: auth:test-user (no test account has been seeded yet)'] });

    // A `verify` outside the apply that rotates: the account is recorded, but this run holds none of
    // what the last two legs need, and it must not spend the provider's mail budget to find that out.
    const stale = setup();
    _resetSecretRegistry(); // its own process: the run vault is empty, exactly as a `verify` sees it
    const r = await run(authRecoveryCheck, stale.ctx);
    expect(r.status).toBe('skip');
    expect(r.evidence[0]).toMatch(/this run holds none of what the recovery check needs for the test account owner\+go-live@example\.com/);
    expect(r.evidence[0]).toMatch(/the recovery token it used; the password it set through recovery; the password that password replaced/);
    expect(stale.w.db.authUsers.recoveryRequests).toEqual([]);
  });

  it('passes with the same answer for an unknown address, a refused replay and a replaced password', async () => {
    const { w, ctx, out } = await applied();
    // request (step) + the check's two: the recorded account, then the unknown one.
    expect(w.db.authUsers.recoveryRequests).toHaveLength(3);
    const r = await run(authRecoveryCheck, ctx);
    expect(r.status).toBe('pass');
    const text = r.evidence.join('\n');
    expect(text).toMatch(/the recovery request for owner\+go-live@example\.com was accepted for sending \(HTTP 200\)/);
    expect(text).toMatch(/an address with no account \(owner\+gl-recovery-[0-9a-f]{6}@example\.com\) got the same answer \(HTTP 200\): no account enumeration/);
    expect(text).toMatch(/the recovery token this run used is refused on replay \(HTTP 403 otp_expired\)/);
    expect(text).toMatch(/the password set through the recovery path signs in \(user usr_1\)/);
    expect(text).toMatch(/the password the rotation replaced is refused \(invalid_credentials\)/);
    expect(text).toMatch(/the provider does not report the recovery link\/code window/);
    expect(text).toMatch(/the click in the inbox itself stays human-confirmed/);
    // The check also ran inside the apply that carried the step, as the step's own verification.
    expect(resultOf(out, 'auth:recovery', 'auth-recovery').status).toBe('pass');
    const blob = JSON.stringify([r, ctx.state.get(), ctx.logs]);
    expect(blob).not.toContain(vaultPass('usr_1', testUserPassKey));
    expect(blob).not.toContain(vaultPass('usr_1', recoveryOldPassKey));
    expect(blob).not.toContain(vaultPass('usr_1', recoveryTokenKey));
    for (const raw of ALL_RAW_SECRETS()) expect(blob).not.toContain(raw);
    // Anonymity stays rls-probe's job, and this check never probes a table.
    expect(anonProbe).not.toHaveBeenCalled();
  });

  it('names the token window from otpExpirySeconds when the provider reports it', async () => {
    const { w, ctx } = await applied();
    w.db.auth.otpExpirySeconds = 3600;
    const r = await run(authRecoveryCheck, ctx);
    expect(r.status).toBe('pass');
    expect(r.evidence.join('\n')).toMatch(/the provider's one-time link\/code window is 3600s \(otpExpirySeconds\), which bounds how long a recovery link stays usable/);
  });

  it('warns, never fails, when the mail throttle answers either request (429)', async () => {
    const known = await applied();
    known.w.db.authUsers.recovery = { status: 429, accepted: false, emailSent: false, rateLimited: true };
    const r = await run(authRecoveryCheck, known.ctx);
    expect(r.status).toBe('warn');
    expect(r.severity).toBe('medium');
    expect(r.evidence[0]).toMatch(/the recovery request for owner\+go-live@example\.com was rate-limited \(HTTP 429\)/);
    expect(r.fix).toMatch(/mail throttle decides what a run can prove/);

    const probe = await applied();
    probe.w.db.authUsers.recoveryUnknown = { status: 429, accepted: false, emailSent: false, rateLimited: true };
    const r2 = await run(authRecoveryCheck, probe.ctx);
    expect(r2.status).toBe('warn');
    expect(r2.severity).toBe('medium');
    expect(r2.evidence[0]).toMatch(/an address with no account was rate-limited \(HTTP 429\), so whether it is answered like a known one is not established/);
  });

  it('skips when a captcha blocks a scripted request', async () => {
    const { w, ctx } = await applied();
    w.db.authUsers.recovery = { status: 400, accepted: false, captchaRequired: true, code: 'captcha_failed' };
    const r = await run(authRecoveryCheck, ctx);
    expect(r.status).toBe('skip');
    expect(r.evidence[0]).toMatch(/requires a captcha for password recovery/);
  });

  it('fails when the provider refuses the request for the recorded account', async () => {
    const { w, ctx } = await applied();
    w.db.authUsers.recovery = { status: 422, accepted: false, emailSent: false, code: 'email_address_invalid' };
    const r = await run(authRecoveryCheck, ctx);
    expect(r.status).toBe('fail');
    expect(r.severity).toBe('high');
    expect(r.evidence[0]).toMatch(/the recovery request for owner\+go-live@example\.com was refused \(HTTP 422 email_address_invalid\)/);
    expect(r.fix).toMatch(/auth\.signup: true/);
  });

  it('fails when an address with no account is answered differently: that is account enumeration', async () => {
    const { w, ctx } = await applied();
    w.db.authUsers.recoveryUnknown = { status: 404, accepted: false, emailSent: false };
    const r = await run(authRecoveryCheck, ctx);
    expect(r.status).toBe('fail');
    expect(r.severity).toBe('high');
    const text = r.evidence.join('\n');
    expect(text).toMatch(/an address with no account got HTTP 404 \(accepted: false\) where the recorded account owner\+go-live@example\.com got HTTP 200 \(accepted: true\): the endpoint tells the difference/);
    expect(text).toMatch(/account enumeration/);
    expect(r.fix).toMatch(/Answer an unknown address exactly like a known one/);
  });

  it('fails when the spent recovery token resolves again', async () => {
    const { w, ctx } = await applied();
    w.db.authUsers.recoveryReuse = true;
    const r = await run(authRecoveryCheck, ctx);
    expect(r.status).toBe('fail');
    expect(r.evidence[0]).toMatch(/the recovery token that already set a password was accepted again \(a session for user usr_1\)/);
    expect(r.fix).toMatch(/A recovery token must resolve once/);
  });

  it('fails when the password set through recovery cannot sign in', async () => {
    const { w, ctx } = await applied();
    w.db.authUsers.byEmail(EMAIL)!.pass = 'rotated somewhere else';
    const r = await run(authRecoveryCheck, ctx);
    expect(r.status).toBe('fail');
    expect(r.evidence[0]).toMatch(/the password the recovery path set cannot sign in \(invalid_credentials\)/);
  });

  it('fails when the password the rotation replaced still signs in', async () => {
    const { w, ctx } = await applied();
    const replaced = vaultGet(recoveryOldPassKey('usr_1'))!;
    // The rotation silently did not take effect: the provider still has the replaced password, while
    // this run believes the new one is in place.
    w.db.authUsers.byEmail(EMAIL)!.pass = replaced.reveal();
    vaultPut(testUserPassKey('usr_1'), replaced);
    const r = await run(authRecoveryCheck, ctx);
    expect(r.status).toBe('fail');
    expect(r.evidence[0]).toMatch(/the password the recovery rotation replaced still signs in/);
    expect(r.fix).toMatch(/Change the account's password in the provider dashboard/);
  });

  it('warns when a login leg is rate-limited, and fails when the provider errors mid-check', async () => {
    const limited = await applied();
    limited.w.db.authUsers.logins.push({ status: 429, rateLimited: true });
    const l = await run(authRecoveryCheck, limited.ctx);
    expect(l.status).toBe('warn');
    expect(l.evidence[0]).toMatch(/the password login for owner\+go-live@example\.com was rate-limited \(HTTP 429\)/);

    const broken = await applied();
    broken.w.db.authUsers.error = 'GoTrue is down';
    const b = await run(authRecoveryCheck, broken.ctx);
    expect(b.status).toBe('fail');
    expect(b.evidence[0]).toMatch(/the recovery request for owner\+go-live@example\.com failed: GoTrue is down/);

    const replay = await applied();
    replay.w.db.authUsers.recoveryError = 'connection reset';
    const r = await run(authRecoveryCheck, replay.ctx);
    expect(r.status).toBe('fail');
    expect(r.evidence[0]).toMatch(/replaying the recovery token failed: connection reset/);
  });
});

// ── the handoff, through the command ─────────────────────────────────────────────────────────────

describe('golive handoff and the recovery handoff', () => {
  let root: string;
  const oldArgv = process.argv;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'golive-recovery-handoff-'));
    mocks.adapters.splice(0);
    vi.stubGlobal('fetch', vi.fn(() => { throw new Error('handoff must not use the network in tests'); }));
  });
  afterEach(() => {
    process.argv = oldArgv;
    vi.unstubAllGlobals();
    rmSync(root, { recursive: true, force: true });
  });

  async function runCli(): Promise<{ output: string; code: number }> {
    vi.resetModules();
    process.argv = ['node', 'golive', 'handoff', '--cwd', root, '--json'];
    const chunks: string[] = [];
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { chunks.push(String(chunk)); return true; });
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    await import('../src/cli.js');
    await vi.waitFor(() => expect(exit).toHaveBeenCalled());
    const result = { output: chunks.join(''), code: exit.mock.calls.at(-1)?.[0] as number };
    stdout.mockRestore(); exit.mockRestore();
    return result;
  }

  /** A repo whose state records the seeded test account, but no password: a `handoff` after apply. */
  function writeRepo(w: FakeWorld): void {
    w.db.authUsers.users.push({ id: 'usr_1', email: EMAIL, confirmed: true, pass: 'never-in-this-process' });
    mocks.adapters.push(...w.adapters);
    writeFileSync(join(root, 'golive.yaml'), JSON.stringify({ version: 1, stack: { hosting: 'fakehost', db: 'fakedb', auth: 'fakedb' }, targets: ['production'], auth: { e2e: true, testEmail: EMAIL, protectedPath: '/dashboard', recovery: true } }));
    mkdirSync(join(root, '.golive'), { recursive: true });
    const state: ShipState = { ...emptyState(), resources: { [TEST_USER_ID]: 'usr_1', [TEST_USER_EMAIL]: EMAIL }, secrets: {}, steps: {} };
    writeFileSync(join(root, '.golive/state.json'), JSON.stringify(state));
  }

  const handoffItem = (output: string) =>
    (JSON.parse(output) as { handoffs: Array<{ id: string; done: boolean | null; evidence: string[] }> }).handoffs.find((h) => h.id === 'auth:recovery-email')!;

  it('keeps the recovery handoff open and unverifiable, and says what closes it', async () => {
    writeRepo(fakeWorld());
    const { output, code } = await runCli();
    const item = handoffItem(output);
    // `done: null`: the inbox click is golive's not-to-verify, and the check skips without the rotate
    // run's token. Nothing claims the click happened.
    expect(item.done).toBeNull();
    expect(item.evidence.join('\n')).toMatch(/this run holds none of what the recovery check needs/);
    expect(code).toBe(0);
  });
});
