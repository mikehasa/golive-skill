/**
 * Account isolation: the `auth.isolation` opt-in, the `auth:isolation` step that seeds the SECOND
 * test account through the provider's own signup and confirms it through its admin API, and the
 * `auth-isolation` check that signs in as BOTH accounts and asks the app's own declared routes
 * whether one can read the other's identity or rows. The app is scripted HTTP (offline); the fake
 * provider's `authUsers` stands in for GoTrue. No network, no real account, no inbox.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPlan, planView } from '../src/core/plan.js';
import { applyPlan, runCheck } from '../src/core/runner.js';
import { emptyState } from '../src/core/state.js';
import { Secret, _resetSecretRegistry, vaultGet, vaultPut } from '../src/core/secret.js';
import { authIsolationCheck } from '../src/checks/auth-isolation.js';
import { authedRestProbe, restProbe } from '../src/checks/providers.js';
import { ALL_LINKS } from '../src/links/all.js';
import { TEST_USER_EMAIL, TEST_USER_ID, testUserPassKey } from '../src/links/auth-e2e.js';
import { ISOLATION_USER_EMAIL, ISOLATION_USER_ID, secondAddress } from '../src/links/auth-isolation.js';
import type { Adapter, Check, Ctx, Http, Plan, ShipConfig, ShipState, Step } from '../src/core/types.js';
import { ALL_RAW_SECRETS, RAW, fakeWorld, type FakeWorld } from './fakes.js';
import { mockHttp, testCtx, type HttpCall } from './helpers.js';

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
const SECOND = 'owner+gl-isolation@example.com';
const PROD = 'https://shop.fakehost.app';
const IDENTITY = '/api/me';
const ROWS = '/api/rows';
const AUTH: Partial<ShipConfig>['auth'] = { e2e: true, testEmail: EMAIL, protectedPath: '/dashboard', isolation: true, identityPath: IDENTITY, isolationPath: ROWS };
const ISOLATION_CONFIG: Partial<ShipConfig> = { stack: { hosting: 'fakehost', db: 'fakedb', auth: 'fakedb' }, auth: AUTH };
/** The check the isolation step verifies itself with. */
const CHECKS = new Map<string, Check>([['auth-isolation', authIsolationCheck]]);

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
const providerUser = (w: FakeWorld, email: string) => w.db.authUsers.byEmail(email);
const vaultPass = (id: string) => vaultGet(testUserPassKey(id))!.reveal();

/**
 * The app the two declared routes belong to. Its default behaviour is correct: both routes refuse an
 * anonymous request, the identity route answers the caller's own id, and the rows route reads back
 * only what that caller's own POST stored. Each option breaks exactly one of those.
 */
interface AppOptions {
  /** What the anonymous requests get (default 401: refused). */
  anon?: number;
  /** A declared route the app does not implement. */
  missing?: 'identity' | 'rows';
  /** The identity route answers with the other account's id. */
  crossedIdentity?: boolean;
  /** The rows route answers with every account's rows. */
  leakRows?: boolean;
  /** The rows route does not accept a POST. */
  readOnly?: boolean;
  /** The rows route never answers with the caller's own marker. */
  dropOwnRow?: boolean;
}

function appHttp(w: FakeWorld, opts: AppOptions = {}) {
  const rows = new Map<string, string[]>();
  const users = () => w.db.authUsers.users;
  const caller = (headers: Record<string, string>): string | undefined => {
    const m = /^Bearer (.+)$/.exec(headers.authorization ?? '');
    return m ? w.db.authUsers.sessions.get(m[1]!) : undefined;
  };
  const other = (id: string): string | undefined => users().find((u) => u.id !== id)?.id;
  const listFor = (id: string): string[] => (opts.leakRows ? users().flatMap((u) => rows.get(u.id) ?? []) : opts.dropOwnRow ? [] : (rows.get(id) ?? []));
  const json = (v: unknown): { status: number; text: string } => ({ status: 200, text: JSON.stringify(v) });
  return mockHttp([
    ['GET', `${PROD}${IDENTITY}`, (c) => {
      if (opts.missing === 'identity') return { status: 404 };
      const id = caller(c.headers);
      if (!id) return { status: opts.anon ?? 401 };
      return json({ id: opts.crossedIdentity ? other(id) : id, email: users().find((u) => u.id === id)?.email });
    }],
    ['GET', `${PROD}${ROWS}`, (c) => {
      if (opts.missing === 'rows') return { status: 404 };
      const id = caller(c.headers);
      if (!id) return { status: opts.anon ?? 401 };
      return json(listFor(id).map((marker) => ({ marker })));
    }],
    ['POST', `${PROD}${ROWS}`, (c) => {
      if (opts.missing === 'rows') return { status: 404 };
      const id = caller(c.headers);
      if (!id) return { status: 401 };
      if (opts.readOnly) return { status: 405 };
      const marker = (c.body as { marker?: string } | undefined)?.marker;
      if (marker) rows.set(id, [...(rows.get(id) ?? []), marker]);
      return { status: 201 };
    }],
  ]);
}

/**
 * The state and run vault two completed seeding steps leave behind: each account in the fake provider
 * with its password in this process's vault (never in state).
 */
function seed(w: FakeWorld, opts: { first?: boolean; second?: boolean; firstConfirmed?: boolean; secondConfirmed?: boolean } = {}) {
  const passA = new Secret('GOLIVE_TEST_PASSWORD', 'generated-test-password-01');
  const passB = new Secret('GOLIVE_TEST_PASSWORD', 'generated-test-password-02');
  const resources: Record<string, string> = {};
  if (opts.first !== false) {
    w.db.authUsers.users.push({ id: 'usr_1', email: EMAIL, confirmed: opts.firstConfirmed ?? true, pass: passA.reveal() });
    vaultPut(testUserPassKey('usr_1'), passA);
    resources[TEST_USER_ID] = 'usr_1';
    resources[TEST_USER_EMAIL] = EMAIL;
  }
  if (opts.second !== false) {
    w.db.authUsers.users.push({ id: 'usr_2', email: SECOND, confirmed: opts.secondConfirmed ?? true, pass: passB.reveal() });
    vaultPut(testUserPassKey('usr_2'), passB);
    resources[ISOLATION_USER_ID] = 'usr_2';
    resources[ISOLATION_USER_EMAIL] = SECOND;
  }
  const state: ShipState = { ...emptyState(), resources, secrets: {}, steps: {} };
  return { state, passA, passB };
}

/** The fake stack with `auth.isolation` opted in and both recorded accounts, unless a test says otherwise. */
function setup(over: { config?: Partial<ShipConfig>; app?: AppOptions; http?: Http; seed?: false | { first?: boolean; second?: boolean; firstConfirmed?: boolean; secondConfirmed?: boolean }; arrange?: (w: FakeWorld) => void } = {}) {
  const w = fakeWorld();
  const seeded = over.seed === false ? undefined : seed(w, over.seed ?? {});
  over.arrange?.(w);
  const app = over.http ? undefined : appHttp(w, over.app ?? {});
  const ctx = testCtx({
    cwd: '/work/shop',
    adapters: w.adapters,
    config: { ...ISOLATION_CONFIG, ...over.config },
    state: seeded?.state,
    detect: { envRefs: [] },
    http: app ? app.http : over.http,
  });
  return { w, ctx, app, seeded };
}

type Setup = Parameters<typeof setup>[0];

/** A full approved apply: the first account is seeded/rotated, then the isolation step follows it. */
async function applied(over: Setup = {}) {
  const { w, ctx, app } = setup(over);
  const plan = await build(ctx);
  const out = await apply(ctx, plan);
  return { w, ctx, app, plan, out };
}

// ── the step ─────────────────────────────────────────────────────────────────────────────────────

describe('auth:isolation step', () => {
  it('plans the second-account step and the routes handoff only under auth.isolation', async () => {
    const off = await build(setup({ seed: false, config: { auth: { e2e: true, testEmail: EMAIL, protectedPath: '/dashboard' } } }).ctx);
    expect(ids(off)).not.toContain('auth:isolation');
    expect(off.handoffs.map((h) => h.id)).not.toContain('auth:isolation-routes');

    const on = await build(setup({ seed: false }).ctx);
    const s = stepOf(on, 'auth:isolation');
    expect(s.risk).toEqual({ writes: true, live: true, replayable: true });
    expect(s.verifyWith).toEqual(['auth-isolation']);
    expect(s.dependsOn).toEqual(expect.arrayContaining(['project:db', 'auth:test-user']));
    expect(s.preview.join('\n')).toMatch(/create a second test account owner\+gl-isolation@example\.com/);
    expect(s.preview.join('\n')).toMatch(/state records the user id and the address, never a secret/);
    expect(s.preview.join('\n')).toMatch(/confirm that account through FakeDB's admin API and read it back/);
    expect(s.preview.join('\n')).toMatch(/reads \/api\/me and \/api\/rows with each account's session/);
    // Both routes declared: there is no app-code task left for the human.
    expect(on.handoffs.map((h) => h.id)).not.toContain('auth:isolation-routes');
  });

  it('derives the second address from auth.testEmail so a later run finds the same account', () => {
    expect(secondAddress('you@example.com')).toBe('you+gl-isolation@example.com');
    expect(secondAddress('you+go-live@example.com')).toBe('you+gl-isolation@example.com');
    expect(secondAddress('not-an-address')).toBeNull();
    // Never the first account's own address: the journey needs two distinct accounts.
    expect(secondAddress(EMAIL)).toBe(SECOND);
  });

  it('warns instead of planning when the journey cannot be carried', async () => {
    const guided = setup({ seed: false, config: { stack: { hosting: 'fakehost', auth: 'fakeguided' } } });
    expect((await build(guided.ctx)).warnings.join('\n')).toMatch(/FakeGuided is not automated by golive/);

    const none = setup({ seed: false, config: { auth: { testEmail: EMAIL, isolation: true, identityPath: IDENTITY, isolationPath: ROWS } } });
    const nonePlan = await build(none.ctx);
    expect(ids(nonePlan)).not.toContain('auth:isolation');
    expect(nonePlan.warnings.join('\n')).toMatch(/the FIRST account comes from `auth\.e2e: true` with `auth\.testEmail`/);

    const gone = setup({ arrange: (w) => w.db.authUsers.missing.add('usr_1') });
    expect((await build(gone.ctx)).warnings.join('\n')).toMatch(/test account usr_1 recorded in \.golive\/state\.json is gone from FakeDB/);

    const pending = setup({ seed: { firstConfirmed: false } });
    expect((await build(pending.ctx)).warnings.join('\n')).toMatch(/is not confirmed yet: the isolation check signs in as both accounts/);

    const noConfirm = setup({
      arrange: (w) => {
        delete (w.adapters.find((a) => a.id === 'fakedb')!.capabilities.authUsers as { confirmEmail?: unknown }).confirmEmail;
      },
    });
    const noConfirmPlan = await build(noConfirm.ctx);
    expect(ids(noConfirmPlan)).not.toContain('auth:isolation');
    expect(noConfirmPlan.warnings.join('\n')).toMatch(/cannot confirm an account through its API/);
  });

  it('hands the app-code task over when no route is declared, and drops it when both are', async () => {
    const noRoutes = setup({ config: { auth: { ...AUTH, identityPath: undefined, isolationPath: undefined } } });
    const plan = await build(noRoutes.ctx);
    expect(ids(plan)).toContain('auth:isolation');
    expect(stepOf(plan, 'auth:isolation').preview.join('\n')).toMatch(/no app route is declared yet/);
    const handoff = plan.handoffs.find((h) => h.id === 'auth:isolation-routes')!;
    expect(handoff).toMatchObject({ blocking: false, verifiedBy: 'auth-isolation' });
    expect(handoff.action).toMatch(/auth\.identityPath/);
    expect(handoff.action).toMatch(/auth\.isolationPath/);
  });

  it('seeds the second account, confirms it through the provider and records ids only', async () => {
    const { w, ctx, plan, out } = await applied({ seed: false });
    const o = outcomeOf(out, 'auth:isolation');
    expect(o.status).toBe('done');
    const changes = o.changes.join('\n');
    expect(changes).toMatch(/created the second test account owner\+gl-isolation@example\.com \(usr_2\)/);
    expect(changes).toMatch(/a confirmation email for owner\+gl-isolation@example\.com was sent to the same inbox/);
    expect(changes).toMatch(/confirmed owner\+gl-isolation@example\.com through FakeDB's admin API and read it back/);

    // The provider holds the second account, confirmed, with the password this run keeps in memory;
    // the first account is a different one with a different password.
    const account = providerUser(w, SECOND)!;
    expect(account.id).toBe('usr_2');
    expect(account.confirmed).toBe(true);
    expect(account.pass).toBe(vaultPass('usr_2'));
    expect(providerUser(w, EMAIL)!.pass).not.toBe(vaultPass('usr_2'));

    const state = ctx.state.get();
    expect(state.resources[ISOLATION_USER_ID]).toBe('usr_2');
    expect(state.resources[ISOLATION_USER_EMAIL]).toBe(SECOND);
    expect(state.resources[TEST_USER_ID]).toBe('usr_1');
    expect(state.secrets).toEqual({});
    const blob = JSON.stringify([planView(plan), out, state, ctx.logs]);
    expect(blob).not.toContain(vaultPass('usr_2'));
    expect(blob).not.toMatch(/GOLIVE_TEST_PASSWORD/);
    for (const raw of ALL_RAW_SECRETS()) expect(blob).not.toContain(raw);
  });

  it('passes auth-isolation in the same apply, with both passwords in this run only', async () => {
    const { ctx, out } = await applied();
    const verified = resultOf(out, 'auth:isolation', 'auth-isolation');
    expect(verified.status).toBe('pass');
    const text = verified.evidence.join('\n');
    expect(text).toMatch(/signed in as owner\+go-live@example\.com \(usr_1\) and owner\+gl-isolation@example\.com \(usr_2\)/);
    expect(text).toMatch(/as usr_1 returned its own id and not usr_2/);
    expect(text).toMatch(/as usr_2 returned its own id and not usr_1/);
    expect(text).toMatch(/as usr_1 returned its own marker \(gl-iso-a-[0-9a-f]{12}\) and none of the other account's/);
    expect(text).toMatch(/as usr_2 returned its own marker \(gl-iso-b-[0-9a-f]{12}\) and none of the other account's/);
    // Neither account's password, nor a session token, reaches the report, the state or the log.
    const blob = JSON.stringify([verified, ctx.state.get(), ctx.logs]);
    expect(blob).not.toContain(vaultPass('usr_1'));
    expect(blob).not.toContain(vaultPass('usr_2'));
    expect(blob).not.toContain(RAW.authSession);
  });

  it('needs --confirm-live and rotates nothing without it', async () => {
    const { w, ctx, plan, out } = await applied({ seed: false });
    // The plan tells the human the gate before anything runs...
    expect(planView(plan).steps.find((s) => s.id === 'auth:isolation')).toMatchObject({ writes: true, needs: ['--confirm-live'] });
    // ...and without the flag the step is blocked, not run: no rotation, nothing recorded.
    const before = providerUser(w, SECOND)!.pass;
    const steps = JSON.stringify(ctx.state.get().steps['auth:isolation']);
    const o = outcomeOf(await apply(ctx, plan, { only: ['auth:isolation'], force: true, confirmLive: false }), 'auth:isolation');
    expect(o.status).toBe('blocked');
    expect(o.next).toMatch(/--confirm-live/);
    expect(providerUser(w, SECOND)!.pass).toBe(before);
    expect(JSON.stringify(ctx.state.get().steps['auth:isolation'])).toBe(steps);
    expect(outcomeOf(out, 'auth:isolation').status).toBe('done');
  });

  it('fails with the reason when the provider refuses the signup, wants a captcha or throttles its mail', async () => {
    const captcha = await applied({ seed: { second: false }, arrange: (w) => (w.db.authUsers.signup = { status: 400, captchaRequired: true, code: 'captcha_failed' }) });
    const c = outcomeOf(captcha.out, 'auth:isolation');
    expect(c.status).toBe('failed');
    expect(c.error).toMatch(/wants a captcha for signup/);

    const limited = await applied({ seed: { second: false }, arrange: (w) => (w.db.authUsers.signup = { status: 429, rateLimited: true }) });
    const l = outcomeOf(limited.out, 'auth:isolation');
    expect(l.status).toBe('failed');
    expect(l.error).toMatch(/refused to send more auth emails \(HTTP 429\) while signing up owner\+gl-isolation@example\.com/);
    expect(l.error).toMatch(/user list/);

    // A provider that fails mid-step (rather than refusing): the step reports its own message.
    const broken = await applied({ seed: false });
    broken.w.db.authUsers.error = 'GoTrue is down';
    const b = outcomeOf(await apply(broken.ctx, broken.plan, { only: ['auth:isolation'], force: true }), 'auth:isolation');
    expect(b.status).toBe('failed');
    expect(b.error).toMatch(/GoTrue is down/);
  });

  it('adopts the accounts it seeded earlier and rotates their passwords on a later run', async () => {
    const { w, ctx, out } = await applied({ seed: false });
    expect(outcomeOf(out, 'auth:isolation').status).toBe('done');
    const before = vaultPass('usr_2');
    expect(w.calls.filter((c) => c.method === 'authUsers.confirmEmail')).toHaveLength(1);

    w.db.authUsers.confirm(EMAIL); // the human clicked the FIRST account's confirmation link
    const next = await apply(ctx, await build(ctx));
    const o = outcomeOf(next, 'auth:isolation');
    expect(o.status).toBe('done');
    expect(o.changes.join('\n')).toMatch(/set a new password on the existing second test account owner\+gl-isolation@example\.com \(usr_2\)/);
    expect(o.changes.join('\n')).toMatch(/owner\+gl-isolation@example\.com is confirmed \(email_confirmed_at set\)/);
    expect(w.db.authUsers.users.filter((u) => u.email === SECOND)).toHaveLength(1);
    const after = vaultPass('usr_2');
    expect(after).not.toBe(before);
    expect(providerUser(w, SECOND)!.pass).toBe(after);
    // The confirmation already holds, so it is re-read rather than re-applied.
    expect(w.calls.filter((c) => c.method === 'authUsers.confirmEmail')).toHaveLength(1);
    // With both accounts confirmed, the same run's verification now passes the whole journey.
    expect(resultOf(next, 'auth:isolation', 'auth-isolation').status).toBe('pass');
  });

  it("adopts an address that already has an account and sets this run's password on it", async () => {
    const { w, ctx, out } = await applied({
      seed: { second: false },
      arrange: (x) => x.db.authUsers.users.push({ id: 'usr_9', email: SECOND, confirmed: false, pass: 'a password from an earlier run' }),
    });
    const o = outcomeOf(out, 'auth:isolation');
    expect(o.status).toBe('done');
    expect(o.changes.join('\n')).toMatch(/owner\+gl-isolation@example\.com already had an account, so no new confirmation email was sent: golive adopted it as the second test account/);
    expect(o.changes.join('\n')).toMatch(/set the generated password on it/);
    expect(ctx.state.get().resources[ISOLATION_USER_ID]).toBe('usr_9');
    expect(providerUser(w, SECOND)!.pass).toBe(vaultPass('usr_9'));
    expect(providerUser(w, SECOND)!.confirmed).toBe(true);
  });

  it('fails when the recorded second account is gone, or the confirmation does not take', async () => {
    const gone = await applied({ seed: false });
    gone.w.db.authUsers.missing.add('usr_2');
    const g = outcomeOf(await apply(gone.ctx, gone.plan, { only: ['auth:isolation'], force: true }), 'auth:isolation');
    expect(g.status).toBe('failed');
    expect(g.error).toMatch(/is gone from FakeDB/);
    expect(g.error).toMatch(/\.golive\/state\.json/);

    const accepted = await applied({ seed: false });
    accepted.w.db.authUsers.byEmail(SECOND)!.confirmed = false;
    accepted.w.db.authUsers.confirmNoop = true; // accepted, never applied: a 2xx the provider does not turn into a confirmation
    const a = outcomeOf(await apply(accepted.ctx, accepted.plan, { only: ['auth:isolation'], force: true }), 'auth:isolation');
    expect(a.status).toBe('failed');
    expect(a.error).toMatch(/accepted the confirmation of owner\+gl-isolation@example\.com \(usr_2\) but still reports that account unconfirmed/);
  });
});

// ── auth-isolation ───────────────────────────────────────────────────────────────────────────────

describe('auth-isolation check', () => {
  it('skips without the opt-in, without declared routes, without a capability or without a login', async () => {
    expect((await run(authIsolationCheck, setup({ config: { auth: { e2e: true, testEmail: EMAIL } } }).ctx)).evidence[0]).toMatch(/auth\.isolation is not enabled/);

    const noRoutes = setup({ config: { auth: { ...AUTH, identityPath: undefined } } });
    const r = await run(authIsolationCheck, noRoutes.ctx);
    expect(r.status).toBe('skip');
    expect(r.evidence[0]).toMatch(/no app route is declared \(auth\.identityPath\)/);
    expect(r.evidence[0]).toMatch(/auth:isolation-routes handoff/);

    expect((await run(authIsolationCheck, setup({ config: { stack: { hosting: 'fakehost', auth: 'fakeguided' } } }).ctx)).evidence[0]).toMatch(/no auth-users surface/);
    expect(await run(authIsolationCheck, setup({ arrange: (w) => (w.db.authed = false) }).ctx)).toMatchObject({ status: 'skip', evidence: ['blocked by: login:fakedb'] });
  });

  it("skips until both accounts are recorded, and without this run's passwords", async () => {
    expect(await run(authIsolationCheck, setup({ seed: { second: false } }).ctx)).toMatchObject({ status: 'skip', evidence: ['blocked by: auth:isolation (no second test account has been seeded yet)'] });
    expect(await run(authIsolationCheck, setup({ seed: { first: false } }).ctx)).toMatchObject({ status: 'skip', evidence: ['blocked by: auth:test-user (no test account has been seeded yet)'] });

    // A `verify` outside the apply that rotated the passwords: both accounts are recorded, but this
    // process holds neither password, so no session can be established at all.
    const stale = setup();
    _resetSecretRegistry();
    const r = await run(authIsolationCheck, stale.ctx);
    expect(r.status).toBe('skip');
    expect(r.evidence[0]).toMatch(/blocked by: no password for the test account and the second test account in this run/);
    expect(r.evidence[0]).toMatch(/re-run `plan` \+ `apply` so both passwords are rotated/);
  });

  it('skips when the provider rate-limits a login, and warns while an account is unconfirmed', async () => {
    const limited = setup({ arrange: (w) => w.db.authUsers.logins.push({ status: 429, rateLimited: true }) });
    const l = await run(authIsolationCheck, limited.ctx);
    expect(l.status).toBe('skip');
    expect(l.evidence[0]).toMatch(/rate-limited the password login for the test account \(HTTP 429\)/);
    expect(l.evidence[1]).toMatch(/needs a session for BOTH accounts in the same run/);

    const firstPending = await run(authIsolationCheck, setup({ seed: { firstConfirmed: false } }).ctx);
    expect(firstPending.status).toBe('warn');
    expect(firstPending.severity).toBe('medium');
    expect(firstPending.evidence[0]).toMatch(/the test account owner\+go-live@example\.com is not confirmed yet/);
    expect(firstPending.evidence[0]).toMatch(/auth:confirm-email handoff covers the click/);

    const secondPending = await run(authIsolationCheck, setup({ seed: { secondConfirmed: false } }).ctx);
    expect(secondPending.status).toBe('warn');
    expect(secondPending.evidence[0]).toMatch(/the second test account owner\+gl-isolation@example\.com is not confirmed yet/);
    expect(secondPending.evidence[0]).toMatch(/auth:isolation step confirms this account through the provider/);
  });

  it('fails when an account cannot sign in, or signs in as another user', async () => {
    const broken = setup();
    broken.w.db.authUsers.byEmail(SECOND)!.pass = 'rotated somewhere else';
    const b = await run(authIsolationCheck, broken.ctx);
    expect(b.status).toBe('fail');
    expect(b.severity).toBe('high');
    expect(b.evidence[0]).toMatch(/the second test account owner\+gl-isolation@example\.com cannot sign in \(invalid_credentials\)/);

    const crossed = setup({ arrange: (w) => w.db.authUsers.logins.push({ session: { accessToken: new Secret('SUPABASE_AUTH_TOKEN', 'issued-for-someone-else'), userId: 'usr_someone_else', emailConfirmed: true } }) });
    const c = await run(authIsolationCheck, crossed.ctx);
    expect(c.status).toBe('fail');
    expect(c.severity).toBe('high');
    expect(c.evidence[0]).toMatch(/the login for owner\+go-live@example\.com returned user usr_someone_else, not the recorded account usr_1/);
  });

  it('skips when the production URL cannot be confirmed, and names the app-code task when a route answers 404', async () => {
    const unconfirmed = setup({ arrange: (w) => (w.host.urls.production = null) });
    const r0 = await run(authIsolationCheck, unconfirmed.ctx);
    expect(r0.status).toBe('skip');
    expect(r0.evidence[0]).toBe('blocked by: deploy:production (no production deployment yet)');
    // The sessions it did establish are named, so the skip says what it got to.
    expect(r0.evidence.join('\n')).toMatch(/signed in as owner\+go-live@example\.com \(usr_1\) and owner\+gl-isolation@example\.com \(usr_2\)/);

    const missing = setup({ app: { missing: 'identity' } });
    const r = await run(authIsolationCheck, missing.ctx);
    expect(r.status).toBe('skip');
    expect(r.evidence[0]).toMatch(/anonymous GET https:\/\/shop\.fakehost\.app\/api\/me → HTTP 404: the app does not implement the declared identity route/);
    expect(r.evidence[1]).toMatch(/app-code task: deploy a route at \/api\/me/);
    // What it could read is kept: a skip carries the evidence it did establish, not an empty claim.
    expect(r.evidence.join('\n')).toMatch(/anonymous GET https:\/\/shop\.fakehost\.app\/api\/rows → HTTP 401: refused without a session/);

    const rowsMissing = setup({ app: { missing: 'rows' } });
    const r2 = await run(authIsolationCheck, rowsMissing.ctx);
    expect(r2.status).toBe('skip');
    expect(r2.evidence[0]).toMatch(/HTTP 404: the app does not implement the declared rows route/);
  });

  it('skips when the app refuses the session golive holds or does not accept a marker write', async () => {
    const refused = setup({ app: { anon: 401 } });
    refused.ctx.http = mockHttp([
      ['GET', `${PROD}${IDENTITY}`, () => ({ status: 401 })],
      ['GET', `${PROD}${ROWS}`, () => ({ status: 401 })],
    ]).http;
    const r = await run(authIsolationCheck, refused.ctx);
    expect(r.status).toBe('skip');
    expect(r.evidence[0]).toMatch(/GET https:\/\/shop\.fakehost\.app\/api\/me as owner\+go-live@example\.com \(usr_1\) → HTTP 401: the route refused the session token golive holds/);
    expect(r.evidence[1]).toMatch(/app-code task: read the caller's session from the `Authorization: Bearer <token>` header on \/api\/me/);

    const readOnly = setup({ app: { readOnly: true } });
    const r2 = await run(authIsolationCheck, readOnly.ctx);
    expect(r2.status).toBe('skip');
    expect(r2.evidence[0]).toMatch(/POST https:\/\/shop\.fakehost\.app\/api\/rows as owner\+go-live@example\.com \(usr_1\) → HTTP 405: the declared route does not accept a write/);
  });

  it('fails critically when a declared route answers an anonymous caller', async () => {
    const r = await run(authIsolationCheck, setup({ app: { anon: 200 } }).ctx);
    expect(r.status).toBe('fail');
    expect(r.severity).toBe('critical');
    expect(r.evidence[0]).toMatch(/anonymous GET https:\/\/shop\.fakehost\.app\/api\/me → HTTP 200: the declared identity route is served without a session/);
    expect(r.fix).toMatch(/require a session/);
  });

  it("fails critically when the identity route answers with the other account's id", async () => {
    const r = await run(authIsolationCheck, setup({ app: { crossedIdentity: true } }).ctx);
    expect(r.status).toBe('fail');
    expect(r.severity).toBe('critical');
    expect(r.evidence[0]).toMatch(/GET https:\/\/shop\.fakehost\.app\/api\/me as owner\+go-live@example\.com \(usr_1\) → HTTP 200: the response carried the OTHER account's id \(usr_2\)/);
    expect(r.fix).toMatch(/answer with the signed-in caller's own identity only/);
  });

  it("fails critically when the rows route returns another account's row", async () => {
    const leak = setup({ app: { leakRows: true } });
    const r = await run(authIsolationCheck, leak.ctx);
    expect(r.status).toBe('fail');
    expect(r.severity).toBe('critical');
    const text = r.evidence.join('\n');
    expect(text).toMatch(/the response carried owner\+gl-isolation@example\.com's row \(marker gl-iso-b-[0-9a-f]{12}\), which only usr_2 wrote through the app/);
    expect(text).toMatch(/one signed-in account reading another account's data through the app/);
    expect(r.fix).toMatch(/Scope \/api\/rows to the signed-in caller/);
    // The refusals it did read stay in the evidence, so the finding is not the whole claim.
    expect(text).toMatch(/anonymous GET https:\/\/shop\.fakehost\.app\/api\/me → HTTP 401: refused without a session/);
  });

  it('warns when nothing in the answer is attributable to the account that asked', async () => {
    const dropped = setup({ app: { dropOwnRow: true } });
    const r = await run(authIsolationCheck, dropped.ctx);
    expect(r.status).toBe('warn');
    expect(r.severity).toBe('medium');
    expect(r.evidence.join('\n')).toMatch(/the marker golive just wrote for that account was not in its own rows, so the absence of the other account's row is not attributable/);
    expect(r.fix).toMatch(/Make the declared routes answer the isolation journey/);

    const odd = setup({ app: { anon: 500 } });
    const r2 = await run(authIsolationCheck, odd.ctx);
    expect(r2.status).toBe('warn');
    expect(r2.evidence[0]).toMatch(/that answer is neither the route nor a refusal, so golive cannot call \/api\/me protected/);
  });

  it('passes with both sessions, two refused anonymous reads and two separated marker rows', async () => {
    const { ctx, app } = setup();
    const r = await run(authIsolationCheck, ctx);
    expect(r.status).toBe('pass');
    expect(r.severity).toBe('info');
    const text = r.evidence.join('\n');
    expect(text).toMatch(/anonymous GET https:\/\/shop\.fakehost\.app\/api\/me → HTTP 401: refused without a session/);
    expect(text).toMatch(/anonymous GET https:\/\/shop\.fakehost\.app\/api\/rows → HTTP 401: refused without a session/);
    expect(text).toMatch(/POST https:\/\/shop\.fakehost\.app\/api\/rows as usr_1 stored one marker row for that account \(HTTP 201\)/);
    expect(text).toMatch(/POST https:\/\/shop\.fakehost\.app\/api\/rows as usr_2 stored one marker row for that account \(HTTP 201\)/);

    // Every read and write went to the app's own routes; only the two baseline reads carried no session.
    const calls = app!.calls as HttpCall[];
    expect(calls.filter((c) => `${c.method} ${c.url}` === `POST ${PROD}${ROWS}`)).toHaveLength(2);
    const anonymous = calls.filter((c) => !c.headers.authorization).map((c) => `${c.method} ${c.url}`);
    expect(anonymous).toEqual([`GET ${PROD}${IDENTITY}`, `GET ${PROD}${ROWS}`]);
    // Anonymity stays rls-probe's job: this check never probes a table, as anyone or with a session.
    expect(anonProbe).not.toHaveBeenCalled();
    expect(authedProbe).not.toHaveBeenCalled();
    // A session token, or either account's password, never reaches the report, the state or the log.
    const blob = JSON.stringify([r, ctx.state.get(), ctx.logs]);
    expect(blob).not.toContain(RAW.authSession);
    expect(blob).not.toContain(vaultPass('usr_1'));
    expect(blob).not.toContain(vaultPass('usr_2'));
    for (const raw of ALL_RAW_SECRETS()) expect(blob).not.toContain(raw);
  });
});

// ── the handoff, through the command ─────────────────────────────────────────────────────────────

describe('golive handoff and the isolation routes', () => {
  let root: string;
  const oldArgv = process.argv;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'golive-isolation-handoff-'));
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

  /** A repo whose state records both seeded accounts, but holds no password: a `handoff` after apply. */
  function writeRepo(w: FakeWorld, auth: Record<string, unknown>): void {
    w.db.authUsers.users.push({ id: 'usr_1', email: EMAIL, confirmed: true, pass: 'never-in-this-process' });
    w.db.authUsers.users.push({ id: 'usr_2', email: SECOND, confirmed: true, pass: 'never-in-this-process' });
    mocks.adapters.push(...w.adapters);
    writeFileSync(join(root, 'golive.yaml'), JSON.stringify({ version: 1, stack: { hosting: 'fakehost', db: 'fakedb', auth: 'fakedb' }, targets: ['production'], auth: { e2e: true, testEmail: EMAIL, ...auth } }));
    mkdirSync(join(root, '.golive'), { recursive: true });
    const state: ShipState = {
      ...emptyState(),
      resources: { [TEST_USER_ID]: 'usr_1', [TEST_USER_EMAIL]: EMAIL, [ISOLATION_USER_ID]: 'usr_2', [ISOLATION_USER_EMAIL]: SECOND },
      secrets: {},
      steps: {},
    };
    writeFileSync(join(root, '.golive/state.json'), JSON.stringify(state));
  }

  const handoffItem = (output: string) =>
    (JSON.parse(output) as { handoffs: Array<{ id: string; done: boolean | null; evidence: string[] }> }).handoffs.find((h) => h.id === 'auth:isolation-routes');

  it('keeps the routes handoff open and unverifiable while the app-code task is outstanding', async () => {
    writeRepo(fakeWorld(), { isolation: true });
    const { output, code } = await runCli();
    const item = handoffItem(output)!;
    // `done: null`: the check cannot exercise the routes from a handoff process — here because
    // golive.yaml declares none — so the item stays unproven: never a pass, and never a claim that
    // the human did anything.
    expect(item.done).toBeNull();
    expect(item.evidence.join('\n')).toMatch(/no app route is declared \(auth\.identityPath and auth\.isolationPath\)/);
    expect(item.evidence.join('\n')).toMatch(/the auth:isolation-routes handoff names what the app must expose/);
    expect(code).toBe(0);
    expect(output).not.toMatch(/GOLIVE_TEST_PASSWORD/);
    expect(output).not.toContain('never-in-this-process');
    for (const raw of ALL_RAW_SECRETS()) expect(output).not.toContain(raw);
  });

  it("drops the handoff once both routes are declared: the app-code task is the config's own", async () => {
    writeRepo(fakeWorld(), { isolation: true, identityPath: IDENTITY, isolationPath: ROWS });
    const { output, code } = await runCli();
    expect(handoffItem(output)).toBeUndefined();
    expect(code).toBe(0);
  });
});
