/**
 * Journey-level regressions for the custom-SMTP half of authentication: `auth.smtp: resend` in
 * golive.yaml through the plan step, the sending key the SMTP password comes from (the run vault, or
 * one this step issues), the write-only field the provider never returns, and the mailer the
 * `auth-policy` check reports. Offline only: fake providers, no network, no real account.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { buildPlan, planView } from '../src/core/plan.js';
import { applyPlan } from '../src/core/runner.js';
import { Secret, _resetSecretRegistry, vaultGet } from '../src/core/secret.js';
import { KEY_VAULT } from '../src/adapters/resend.js';
import { senderOf } from '../src/links/auth-smtp.js';
import { authPolicyCheck } from '../src/checks/auth.js';
import { ALL_LINKS } from '../src/links/all.js';
import type { AuthSettings, Check, Ctx, Plan, ShipConfig, Step } from '../src/core/types.js';
import { testCtx } from './helpers.js';
import { ALL_RAW_SECRETS, RAW, fakeWorld, type FakeWorld } from './fakes.js';

beforeEach(() => _resetSecretRegistry());

/** The opt-in, a Resend email axis, and the sender address the app already sends as. */
const CONFIG: Partial<ShipConfig> = {
  stack: { hosting: 'fakehost', db: 'fakedb', auth: 'fakedb', email: 'resend' },
  email: { from: 'Shop <hello@example.com>' },
  auth: { smtp: 'resend', passwordMinLength: 12 },
};

/** A project whose policy already matches, so `auth-policy` reports the mailer and nothing else. */
const SETTLED: AuthSettings = {
  siteUrl: 'https://shop.fakehost.app',
  redirectUrls: ['https://shop.fakehost.app/**'],
  signupEnabled: true,
  emailConfirmRequired: true,
  minPasswordLength: 12,
  smtp: { configured: false },
  emailRateLimitPerHour: 30,
};

function setup(config: Partial<ShipConfig> = CONFIG, arrange?: (w: FakeWorld) => void) {
  const w = fakeWorld();
  w.mail.providerId = 'resend'; // the stack's email provider is Resend
  w.db.auth = structuredClone(SETTLED);
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
const smtpPatch = (w: FakeWorld) => w.calls.find((c) => c.method === 'authConfig.set')?.args[0] as ({ smtp?: unknown; smtpPassword?: Secret; emailRateLimitPerHour?: number } | undefined);

describe('auth SMTP journey: auth.smtp: resend → the custom-SMTP write → the mailer the check reports', () => {
  it('plans the step only with the opt-in, a Resend email axis and a sending key in reach', async () => {
    const off = setup({ ...CONFIG, auth: {} });
    expect((await build(off.ctx)).steps.map((s) => s.id)).not.toContain('auth:smtp');

    const other = setup({ ...CONFIG, stack: { ...CONFIG.stack, email: 'fakemail' } }, (w) => void (w.mail.providerId = 'fakemail'));
    const wrongProvider = await build(other.ctx);
    expect(wrongProvider.steps.map((s) => s.id)).not.toContain('auth:smtp');
    expect(wrongProvider.warnings.join('\n')).toMatch(/FakeMail is not Resend/);

    const noKeys = setup(CONFIG, (w) => void delete (w.adapters.find((a) => a.id === 'resend')!.capabilities as { keys?: unknown }).keys);
    const withoutIssuer = await build(noKeys.ctx);
    expect(withoutIssuer.steps.map((s) => s.id)).not.toContain('auth:smtp');
    expect(withoutIssuer.warnings.join('\n')).toMatch(/exposes no key issuance/);

    const noFrom = setup({ ...CONFIG, email: undefined });
    const withoutSender = await build(noFrom.ctx);
    expect(withoutSender.steps.map((s) => s.id)).not.toContain('auth:smtp');
    expect(withoutSender.warnings.join('\n')).toMatch(/sets no email\.from/);

    const guided = setup({ ...CONFIG, stack: { ...CONFIG.stack, auth: 'fakeguided' } });
    expect((await build(guided.ctx)).steps.map((s) => s.id)).not.toContain('auth:smtp');

    const { ctx } = setup();
    expect((await build(ctx)).steps.map((s) => s.id)).toContain('auth:smtp');
  });

  it('writes exactly the SMTP fields and the auth email rate limit, and keeps the password out of state, evidence, plan view and logs', async () => {
    // The project the live run found: custom SMTP half done, and the provider's own limit at 2.
    const { w, ctx } = setup(undefined, (x) => void (x.db.auth.emailRateLimitPerHour = 2));
    const plan = await build(ctx);
    const s = stepOf(plan, 'auth:smtp');
    expect(s.risk).toEqual({ writes: true });
    expect(s.verifyWith).toEqual(['auth-policy']);
    expect(s.preview[0]).toBe("set the FakeDB project's custom SMTP to Resend (smtp.resend.com:465, user resend) as hello@example.com (Shop)");
    expect(s.preview.join('\n')).toMatch(/SMTP host: \(not set\) → smtp\.resend\.com/);
    expect(s.preview.join('\n')).toMatch(/sender address: \(not set\) → hello@example\.com/);
    expect(s.preview.join('\n')).toMatch(/auth email rate limit: 2 → 30 per hour/);

    const out = await apply(ctx, plan, authChecks);
    const o = outcomeOf(out, 'auth:smtp');
    expect(o.status).toBe('done');
    expect(w.db.auth.smtp).toEqual({ configured: true, host: 'smtp.resend.com', port: 465, user: 'resend', senderEmail: 'hello@example.com', senderName: 'Shop' });
    expect(w.db.auth.emailRateLimitPerHour).toBe(30);
    expect(smtpPatch(w)!.smtpPassword).toBeInstanceOf(Secret);
    // Nothing but the SMTP group, the rate limit and its one secret is written: the policy fields stay `auth:settings`.
    expect(w.calls.filter((c) => c.method === 'authConfig.set').length).toBe(1);
    expect(Object.keys(smtpPatch(w)!).sort()).toEqual(['emailRateLimitPerHour', 'smtp', 'smtpPassword']);
    expect(smtpPatch(w)!.emailRateLimitPerHour).toBe(30);
    expect(o.changes.join('\n')).toMatch(/auth email rate limit: 2 → 30 per hour/);
    expect(o.changes.join('\n')).toMatch(/not confirmed: smtpPassword \(write-only/);
    expect(o.changes.join('\n')).toMatch(/the password itself is only ever accepted, never confirmed: FakeDB answers it with a hash/);
    const inline = o.checks.find((c) => c.id === 'auth:smtp:applied')!;
    expect(inline).toMatchObject({ status: 'pass' });
    expect(inline.evidence.join('\n')).toMatch(/SMTP host: smtp\.resend\.com/);
    expect(inline.evidence.join('\n')).toMatch(/auth email rate limit: 30 per hour/);
    expect(inline.evidence.join('\n')).toMatch(/the SMTP password is write-only/);
    // The raise holds: a later plan has nothing to write again.
    expect((await build(ctx)).steps.map((x) => x.id)).not.toContain('auth:smtp');

    // The raw value registered for that Secret is nowhere: not in the plan view, the outcome, state,
    // the log or the recorded call arguments (a Secret serialises to its label and fingerprint).
    const blob = JSON.stringify([planView(plan), out, ctx.state.get(), ctx.logs, w.calls]);
    for (const raw of ALL_RAW_SECRETS()) expect(blob).not.toContain(raw);
    expect(blob).not.toMatch(/smtpPassword":"re_/);
  });

  it('takes the auth email rate limit from auth.emailRateLimitPerHour when golive.yaml sets it', async () => {
    const { w, ctx } = setup({ ...CONFIG, auth: { ...CONFIG.auth, emailRateLimitPerHour: 60 } }, (x) => void (x.db.auth.emailRateLimitPerHour = 2));
    const plan = await build(ctx);
    const s = stepOf(plan, 'auth:smtp');
    expect(s.preview.join('\n')).toMatch(/auth email rate limit: 2 → 60 per hour/);
    expect(s.intent).toMatch(/emailRateLimitPerHour=60/);

    const out = await apply(ctx, plan, authChecks);
    expect(outcomeOf(out, 'auth:smtp').changes.join('\n')).toMatch(/auth email rate limit: 2 → 60 per hour/);
    expect(smtpPatch(w)!.emailRateLimitPerHour).toBe(60);
    expect(w.db.auth.emailRateLimitPerHour).toBe(60);
    const inline = outcomeOf(out, 'auth:smtp').checks.find((c) => c.id === 'auth:smtp:applied')!;
    expect(inline.evidence.join('\n')).toMatch(/auth email rate limit: 60 per hour/);
  });

  it('names the rate limit in the plan even when it already holds, without listing it as a change', async () => {
    const { ctx } = setup(); // the provider already reports the 30 the step writes
    const s = stepOf(await build(ctx), 'auth:smtp');
    expect(s.preview.join('\n')).toMatch(/auth email rate limit: 30 per hour \(the provider's own limit, which custom SMTP does not remove/);
    expect(s.preview.join('\n')).not.toMatch(/auth email rate limit: .*→/);
  });

  it('names a rate limit the provider never reports back as unconfirmed, without failing the step', async () => {
    const { ctx } = setup(undefined, (w) => void (w.db.authIgnores = ['emailRateLimitPerHour']));
    const out = await apply(ctx, await build(ctx), authChecks);
    const o = outcomeOf(out, 'auth:smtp');
    expect(o.status).toBe('done');
    expect(o.changes.join('\n')).toMatch(/not confirmed: emailRateLimitPerHour \(the provider does not report this setting back\)/);
    const inline = o.checks.find((c) => c.id === 'auth:smtp:applied')!;
    expect(inline.status).toBe('pass');
    expect(inline.evidence.join('\n')).toMatch(/auth email rate limit: FakeDB does not report it back/);
  });

  it('keeps the step done, with a warning naming what holds, when the provider ignores the rate limit', async () => {
    const { w, ctx } = setup(undefined, (x) => {
      // The project's own limit, as the live run found it.
      x.db.auth.emailRateLimitPerHour = 2;
      const caps = x.adapters.find((a) => a.id === 'fakedb')!.capabilities.authConfig!;
      const apply = caps.set;
      // Accepted, never applied: the write returns 2xx and the SMTP group lands, but the project keeps
      // reporting its own rate limit — the provider's own accounting of what it kept.
      caps.set = async (c, patch) => {
        const outcome = await apply(c, patch);
        x.db.auth.emailRateLimitPerHour = 2;
        return {
          ...outcome,
          applied: outcome.applied.filter((f) => f !== 'emailRateLimitPerHour'),
          skipped: [...outcome.skipped, 'emailRateLimitPerHour (the provider reports 2 instead of 30)'],
        };
      };
    });
    const out = await apply(ctx, await build(ctx), authChecks);
    const o = outcomeOf(out, 'auth:smtp');
    expect(o.status).toBe('done');
    expect(o.changes.join('\n')).toMatch(/not confirmed: emailRateLimitPerHour \(the provider reports 2 instead of 30\)/);
    expect(w.db.auth.emailRateLimitPerHour).toBe(2);
    const inline = o.checks.find((c) => c.id === 'auth:smtp:applied')!;
    expect(inline.status).toBe('pass');
    expect(inline.evidence.join('\n')).toMatch(/SMTP host: smtp\.resend\.com/);
    const warn = o.checks.find((c) => c.id === 'auth:smtp:applied:rate-limit')!;
    expect(warn).toMatchObject({ status: 'warn', severity: 'medium' });
    expect(warn.evidence.join('\n')).toMatch(/auth email rate limit is 2 per hour after the write, not 30 per hour/);
    expect(warn.evidence.join('\n')).toMatch(/one run of the auth journeys needs four accepted sends/);
    expect(warn.fix).toMatch(/Raise the auth email rate limit in the FakeDB dashboard/);
  });

  it('takes the password from the sending key the email journey issues in this run', async () => {
    const { w, ctx } = setup(
      { ...CONFIG, auth: { smtp: 'resend', passwordMinLength: 12, e2e: true, testEmail: 'you+go-live@example.com' } },
      undefined,
    );
    ctx.detect.envRefs.push({ name: 'RESEND_API_KEY', files: ['src/mail.ts'], clientExposed: false });
    const plan = await build(ctx);
    const s = stepOf(plan, 'auth:smtp');
    // The email journey's keys are planned first, and this step waits for them: that is the handoff.
    expect(s.dependsOn).toContain('email:key:production');
    expect(s.preview.join('\n')).toMatch(/the sending key the email journey issues in this run/);

    const out = await apply(ctx, plan, authChecks);
    expect(outcomeOf(out, 'auth:smtp').status).toBe('done');
    const issued = w.calls.filter((c) => c.method === 'keys.issue');
    expect(issued.length).toBe(2); // the app's own preview + production keys, no third key for SMTP
    expect(smtpPatch(w)!.smtpPassword!.fingerprint).toBe(vaultGet(KEY_VAULT)!.fingerprint);
    expect(ctx.state.get().resources['resend.keyId@smtp']).toBeUndefined();
  });

  it('issues its own SMTP-only sending key, and records it, when the email journey issues none', async () => {
    const { w, ctx } = setup();
    const plan = await build(ctx);
    expect(stepOf(plan, 'auth:smtp').preview.join('\n')).toMatch(/a sending key golive issues for SMTP alone/);

    const out = await apply(ctx, plan, authChecks);
    const o = outcomeOf(out, 'auth:smtp');
    expect(o.status).toBe('done');
    const issue = w.calls.find((c) => c.method === 'keys.issue')!;
    expect(issue.args[0]).toBe('production');
    expect(issue.args[1]).toEqual({ domain: 'example.com', purpose: 'smtp' });
    expect(ctx.state.get().resources['resend.keyId@smtp']).toBe('key_1');
    expect(o.changes.join('\n')).toMatch(/recorded in state as resend\.keyId@smtp, so teardown can revoke it/);
    expect(smtpPatch(w)!.smtpPassword!.fingerprint).toBe(new Secret('RESEND_API_KEY', `${RAW.resendKey}1`).fingerprint);

    // A later run that has to write again (its own process, so an empty vault) mints a new key and
    // names the one it replaced, the way the app's own key step does.
    _resetSecretRegistry();
    w.db.auth.smtp = { configured: false };
    const again = await apply(ctx, await build(ctx), authChecks);
    expect(ctx.state.get().resources['resend.keyId@smtp']).toBe('key_2');
    expect(outcomeOf(again, 'auth:smtp').changes.join('\n')).toMatch(/the SMTP key golive issued earlier \(key_1\) is left active; revoke it in FakeMail once nothing uses it/);
  });

  it('plans nothing again once the settings hold and golive already wrote them', async () => {
    const { w, ctx } = setup();
    const out = await apply(ctx, await build(ctx), authChecks);
    expect(outcomeOf(out, 'auth:smtp').status).toBe('done');
    expect((await build(ctx)).steps.map((s) => s.id)).not.toContain('auth:smtp');

    // Drift outside golive (someone repoints the SMTP host in the dashboard) is a new intent again.
    w.db.auth.smtp = { configured: true, host: 'smtp.other.example' };
    const drifted = await build(ctx);
    expect(drifted.steps.map((s) => s.id)).toContain('auth:smtp');
    expect(stepOf(drifted, 'auth:smtp').preview.join('\n')).toMatch(/SMTP host: smtp\.other\.example → smtp\.resend\.com/);
  });

  it('names a field the provider never reports back as unconfirmed, without failing the step', async () => {
    const { ctx } = setup(undefined, (w) => void (w.db.authIgnores = ['smtp']));
    const out = await apply(ctx, await build(ctx), authChecks);
    const o = outcomeOf(out, 'auth:smtp');
    expect(o.status).toBe('done');
    expect(o.changes.join('\n')).toMatch(/not confirmed: smtp \(the provider does not report this setting back\)/);
    const inline = o.checks.find((c) => c.id === 'auth:smtp:applied')!;
    expect(inline.status).toBe('pass');
    expect(inline.evidence.join('\n')).toMatch(/SMTP host: FakeDB does not report it back/);
    expect(inline.evidence.join('\n')).toMatch(/SMTP port: FakeDB does not report it back/);
  });

  it('fails the step when the provider keeps reporting another value', async () => {
    const { w, ctx } = setup(undefined, (x) => {
      // Accepted, never applied: the write returns 2xx and the project keeps reporting another host.
      x.adapters.find((a) => a.id === 'fakedb')!.capabilities.authConfig!.set = async () => {
        x.db.auth.smtp = { configured: true, host: 'smtp.other.example' };
        return { after: structuredClone(x.db.auth), applied: [], skipped: [] };
      };
    });
    const out = await apply(ctx, await build(ctx), authChecks);
    const o = outcomeOf(out, 'auth:smtp');
    expect(o.status).toBe('failed');
    const inline = o.checks.find((c) => c.id === 'auth:smtp:applied')!;
    expect(inline.status).toBe('fail');
    expect(inline.evidence.join('\n')).toMatch(/SMTP host is smtp\.other\.example after the write, not smtp\.resend\.com/);
  });

  it('reads the sender address and display name out of the address the app sends as', () => {
    expect(senderOf('Shop <hello@example.com>')).toEqual({ email: 'hello@example.com', name: 'Shop' });
    expect(senderOf('hello@example.com')).toEqual({ email: 'hello@example.com' });
    expect(senderOf(undefined)).toEqual({});
  });
});

describe('auth-policy: the mailer branches', () => {
  it('reports a custom SMTP via Resend and stops warning about the built-in mailer', async () => {
    const { ctx } = setup(CONFIG, (w) => void (w.db.auth.smtp = { configured: true, host: 'smtp.resend.com', port: 465, user: 'resend', senderEmail: 'hello@example.com' }));
    const r = await authPolicyCheck.run(ctx);
    expect(r.status).toBe('pass');
    const text = r.evidence.join('\n');
    expect(text).toMatch(/auth email: custom SMTP via Resend \(smtp\.resend\.com\)/);
    expect(text).toMatch(/auth email sender: hello@example\.com/);
    expect(text).toMatch(/never returns the SMTP password, so this reads the settings back, not a delivery/);
    expect(text).not.toMatch(/built-in mailer/);
  });

  it('keeps the built-in-mailer warning, with the throttle implication, when nothing asks for Resend', async () => {
    const { ctx } = setup({ ...CONFIG, auth: { passwordMinLength: 12 } });
    const r = await authPolicyCheck.run(ctx);
    expect(r.status).toBe('warn');
    expect(r.severity).toBe('medium');
    const text = r.evidence.join('\n');
    expect(text).toMatch(/auth email: provider built-in mailer/);
    expect(text).toMatch(/its limit can refuse the sends an auth journey needs \(HTTP 429, roughly one accepted send per window\)/);
    expect(r.fix).toMatch(/Set `auth\.smtp: resend` in golive\.yaml/);
    expect(r.fix).toMatch(/auth\.smtp: provider/);
  });

  it('accepts the built-in mailer when golive.yaml asks for it', async () => {
    const { ctx } = setup({ ...CONFIG, auth: { smtp: 'provider', passwordMinLength: 12 } });
    const r = await authPolicyCheck.run(ctx);
    expect(r.status).toBe('pass');
    expect(r.evidence.join('\n')).toMatch(/provider built-in mailer/);
  });

  it('names the auth:smtp step when golive.yaml asks for Resend and the project has not applied it', async () => {
    const { ctx } = setup();
    const r = await authPolicyCheck.run(ctx);
    expect(r.status).toBe('warn');
    expect(r.severity).toBe('medium');
    expect(r.evidence.join('\n')).toMatch(/asks for the app's email provider \(`auth\.smtp: resend`\) but auth emails still go through/);
    expect(r.evidence.join('\n')).toMatch(/the recovery journey alone needs four/);
    expect(r.fix).toMatch(/the `auth:smtp` step/);
  });
});
