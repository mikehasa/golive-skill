/**
 * Journey-level regressions for the auth settings half of authentication: from `auth` in golive.yaml
 * through the plan step, the write, the re-read that decides whether the step is done, and the check
 * evidence. The seeded-test-user end-to-end journey (a real signup and email) is a later PR. Offline
 * only: fake providers, no network, no real account.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { buildPlan, planView } from '../src/core/plan.js';
import { applyPlan } from '../src/core/runner.js';
import { Secret, _resetSecretRegistry } from '../src/core/secret.js';
import { authPolicyCheck } from '../src/checks/auth.js';
import { ALL_LINKS } from '../src/links/all.js';
import type { Check, Ctx, Plan, ShipConfig, Step } from '../src/core/types.js';
import { testCtx } from './helpers.js';
import { ALL_RAW_SECRETS, fakeWorld, type FakeWorld } from './fakes.js';

beforeEach(() => _resetSecretRegistry());

const AUTH_POLICY = { signup: false, requireEmailConfirm: true, passwordMinLength: 12 };
const CONFIG: Partial<ShipConfig> = { stack: { hosting: 'fakehost', db: 'fakedb', auth: 'fakedb' }, auth: AUTH_POLICY };

function setup(config: Partial<ShipConfig> = CONFIG, arrange?: (w: FakeWorld) => void) {
  const w = fakeWorld();
  arrange?.(w);
  const ctx = testCtx({ cwd: '/work/shop', adapters: w.adapters, config, detect: { envRefs: [] } });
  return { w, ctx };
}

const build = (ctx: Ctx) => buildPlan(ctx, ALL_LINKS, { unmappedEnv: [], warnings: [] });
const apply = (ctx: Ctx, plan: Plan, checks: Map<string, Check> = new Map()) => applyPlan(ctx, plan, checks, { approvedPlanId: plan.id, yes: true, confirmLive: true, confirmDns: true });
const stepOf = (p: Plan, id: string): Step => {
  const s = p.steps.find((x) => x.id === id);
  if (!s) throw new Error(`no step ${id} in ${p.steps.map((x) => x.id).join(', ')}`);
  return s;
};
const outcomeOf = (out: Awaited<ReturnType<typeof apply>>, id: string) => out.find((o) => o.id === id)!;
const authChecks = new Map<string, Check>([['auth-policy', authPolicyCheck]]);

describe('auth settings journey: golive.yaml policy → step → re-read → check', () => {
  it('plans the policy step only for what differs, writes it and re-reads before recording done', async () => {
    const { w, ctx } = setup({ ...CONFIG, domain: 'example.com' });
    const plan = await build(ctx);
    const s = stepOf(plan, 'auth:settings');
    // The fake reports confirmation as already required, so only the two real differences are planned.
    expect(s.preview).toEqual(['signup: on → off', 'password minimum length: 6 → 12']);
    expect(s.risk).toEqual({ writes: true });
    expect(s.verifyWith).toEqual(['auth-policy']);
    // The URL half stays its own step: same provider, no shared preview and no shared intent.
    expect(stepOf(plan, 'auth:redirects').preview.join('\n')).toMatch(/site URL/);
    expect(stepOf(plan, 'auth:redirects').intent).not.toBe(s.intent);

    const out = await apply(ctx, plan, authChecks);
    const o = outcomeOf(out, 'auth:settings');
    expect(o.status).toBe('done');
    expect(o.changes).toEqual(['signup: on → off', 'password minimum length: 6 → 12']);
    expect(w.db.auth).toMatchObject({ signupEnabled: false, minPasswordLength: 12 });
    // The step's own observation of what it wrote, and the policy check that reads the same settings.
    expect(o.checks.find((c) => c.id === 'auth:settings:applied')).toMatchObject({ status: 'pass', evidence: ['signup: off', 'password minimum length: 12'] });
    expect(o.checks.find((c) => c.id === 'auth-policy')!.evidence.join('\n')).toMatch(/password minimum length: 12/);
  });

  it('plans no step when nothing is configured or the provider already matches', async () => {
    const bare = setup({ stack: { hosting: 'fakehost', db: 'fakedb', auth: 'fakedb' } });
    expect((await build(bare.ctx)).steps.map((s) => s.id)).not.toContain('auth:settings');

    const { ctx } = setup();
    await apply(ctx, await build(ctx), authChecks);
    expect((await build(ctx)).steps.map((s) => s.id)).not.toContain('auth:settings');
  });

  it('re-runs the step when the policy in golive.yaml changes', async () => {
    const { w, ctx } = setup();
    const first = await build(ctx);
    await apply(ctx, first, authChecks);
    const before = stepOf(first, 'auth:settings').intent;

    ctx.config.auth = { ...AUTH_POLICY, signup: true }; // the human changes their mind
    const second = await build(ctx);
    expect(stepOf(second, 'auth:settings').preview).toEqual(['signup: off → on']);
    expect(stepOf(second, 'auth:settings').intent).not.toBe(before);

    const out = await apply(ctx, second, authChecks);
    expect(outcomeOf(out, 'auth:settings').status).toBe('done'); // ran again instead of "already done"
    expect(w.db.auth.signupEnabled).toBe(true);
  });

  it('re-runs the step when someone changes the value back in the provider dashboard', async () => {
    const { w, ctx } = setup({ stack: { hosting: 'fakehost', db: 'fakedb', auth: 'fakedb' }, auth: { signup: false } });
    const first = await build(ctx);
    expect(w.db.auth.signupEnabled).toBe(true);
    await apply(ctx, first, authChecks);
    const recorded = ctx.state.get().steps['auth:settings']!;

    w.db.auth.signupEnabled = true; // drift outside golive: golive.yaml is unchanged
    const second = await build(ctx);
    expect(stepOf(second, 'auth:settings').preview).toEqual(stepOf(first, 'auth:settings').preview);
    const out = await apply(ctx, second, authChecks);
    expect(outcomeOf(out, 'auth:settings').status).toBe('done'); // not "already done": the settings had drifted
    expect(ctx.state.get().steps['auth:settings']!.hash).not.toBe(recorded.hash);
    expect(w.db.auth.signupEnabled).toBe(false);
  });

  it('names a setting the provider does not report back as unconfirmed, without failing the step', async () => {
    const { w, ctx } = setup(CONFIG, (x) => (x.db.authIgnores = ['minPasswordLength']));
    const out = await apply(ctx, await build(ctx), authChecks);
    const o = outcomeOf(out, 'auth:settings');
    expect(o.status).toBe('done');
    expect(o.changes.join('\n')).toMatch(/password minimum length: 6 → \(not reported\)/);
    expect(o.changes.join('\n')).toMatch(/not confirmed: minPasswordLength \(the provider does not report this setting back\)/);
    const inline = o.checks.find((c) => c.id === 'auth:settings:applied')!;
    expect(inline.status).toBe('pass');
    expect(inline.evidence.join('\n')).toMatch(/password minimum length: FakeDB does not report it back/);
    expect(w.db.auth.signupEnabled).toBe(false);
  });

  it('fails the step when the provider rejects the write, and records the failure', async () => {
    const { ctx } = setup(CONFIG, (x) => {
      x.adapters.find((a) => a.id === 'fakedb')!.capabilities.authConfig!.set = async () => {
        throw new Error('404 not found: check the project ref');
      };
    });
    const out = await apply(ctx, await build(ctx), authChecks);
    const o = outcomeOf(out, 'auth:settings');
    expect(o.status).toBe('failed');
    expect(o.error).toMatch(/404 not found/);
    expect(ctx.state.get().steps['auth:settings']!.status).toBe('failed');
  });

  it('fails the step when the provider keeps reporting the old value instead of reporting success', async () => {
    const { w, ctx } = setup(CONFIG, (x) => {
      // Accepted, never applied: the write returns 2xx and the settings stay as they were.
      x.adapters.find((a) => a.id === 'fakedb')!.capabilities.authConfig!.set = async () => ({ after: structuredClone(x.db.auth), applied: [], skipped: [] });
    });
    const out = await apply(ctx, await build(ctx), authChecks);
    const o = outcomeOf(out, 'auth:settings');
    expect(o.status).toBe('failed');
    const inline = o.checks.find((c) => c.id === 'auth:settings:applied')!;
    expect(inline.status).toBe('fail');
    expect(inline.evidence.join('\n')).toMatch(/signup is on after the write, not off/);
    expect(w.db.auth.signupEnabled).toBe(true);
  });

  it('keeps credentials out of the policy step, the plan, state and changes', async () => {
    const { w, ctx } = setup(
      { ...CONFIG, email: { from: 'Shop <hello@example.com>' } },
      (x) => void x.adapters.forEach(() => undefined),
    );
    ctx.detect.envRefs.push({ name: 'DATABASE_URL', files: ['src/db.ts'], clientExposed: false });
    const plan = await build(ctx);
    const out = await apply(ctx, plan, authChecks);

    // The policy step sends booleans and numbers only; no credential is involved in this half.
    const setCall = w.calls.find((c) => c.method === 'authConfig.set')!;
    expect(setCall.args.some((a) => a instanceof Secret)).toBe(false);
    expect(JSON.stringify(setCall.args)).not.toMatch(/smtp/i);
    const auth = outcomeOf(out, 'auth:settings');
    expect(JSON.stringify([planView(plan), auth, ctx.state.get(), ctx.logs, w.calls.slice(0, 3)])).not.toMatch(/smtpPassword/);
    const blob = JSON.stringify([planView(plan), out, ctx.state.get(), ctx.logs]);
    for (const raw of ALL_RAW_SECRETS()) expect(blob).not.toContain(raw);
  });
});
