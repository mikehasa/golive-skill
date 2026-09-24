import { describe, it, expect, beforeEach } from 'vitest';
import { Secret, _resetSecretRegistry } from '../src/core/secret.js';
import { buildPlan, planId, planView } from '../src/core/plan.js';
import { applyPlan } from '../src/core/runner.js';
import { emptyState } from '../src/core/state.js';
import type { Check, Ctx, DeploymentInfo, Finding, Http, Plan, ReleaseIdentity, ShipConfig, ShipState, Step, StepRecord } from '../src/core/types.js';
import { envParityCheck } from '../src/checks/env-parity.js';
import { previewBundleCheck, previewDeployCheck, productionReleaseCheck } from '../src/checks/release.js';
import { ALL_LINKS } from '../src/links/all.js';
import { availableKeys, forgetDeployFacts, previousProductionDeploy, readDeployHistory, readRelease, recordDeploy, step } from '../src/links/util.js';
import { emailDomain } from '../src/links/email.js';
import { TEST_RELEASE, mockExec, mockHttp, testCtx } from './helpers.js';
import { ALL_RAW_SECRETS, FAKE_STACK, PUBLIC, RAW, fakeWorld, type FakeWorld } from './fakes.js';

beforeEach(() => _resetSecretRegistry());

const ENV = [
  'NEXT_PUBLIC_SUPABASE_URL',
  'NEXT_PUBLIC_SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'DATABASE_URL',
  'STRIPE_SECRET_KEY',
  'NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'RESEND_API_KEY',
  'NEXT_PUBLIC_SITE_URL',
];

const BASE_CONFIG: Partial<ShipConfig> = {
  stack: { ...FAKE_STACK },
  domain: 'example.com',
  payments: { webhook: { path: '/api/webhooks/stripe', events: ['checkout.session.completed'] } },
  email: { from: 'Shop <hello@example.com>' },
};

function setup(opts: { config?: Partial<ShipConfig>; env?: string[]; state?: ShipState; findings?: Finding[]; arrange?: (w: FakeWorld) => void; exec?: Parameters<typeof mockExec>[0]; http?: Http; release?: ReleaseIdentity } = {}) {
  const w = fakeWorld();
  opts.arrange?.(w);
  const exec = mockExec(opts.exec ?? []);
  const ctx = testCtx({
    cwd: '/work/shop',
    exec: exec.run,
    http: opts.http,
    adapters: w.adapters,
    config: { ...BASE_CONFIG, ...opts.config },
    state: opts.state,
    ...(opts.release ? { release: opts.release } : {}),
    detect: { envRefs: (opts.env ?? ENV).map((name) => ({ name, files: ['src/lib.ts'], clientExposed: false })), findings: opts.findings ?? [] },
  });
  return { w, ctx, exec };
}

const build = (ctx: Parameters<typeof buildPlan>[0]) => buildPlan(ctx, ALL_LINKS, { unmappedEnv: [], warnings: [] });
const apply = (ctx: Parameters<typeof buildPlan>[0], plan: Plan, checks: Map<string, Check> = new Map()) => applyPlan(ctx, plan, checks, { approvedPlanId: plan.id, yes: true, confirmLive: true, confirmDns: true });
const ids = (p: Plan) => p.steps.map((s) => s.id);
const byId = (p: Plan, id: string): Step => {
  const s = p.steps.find((x) => x.id === id);
  if (!s) throw new Error(`no step ${id} in ${ids(p).join(', ')}`);
  return s;
};
const hIds = (p: Plan) => p.handoffs.map((h) => h.id);

function expectNoRawSecrets(texts: string[]): void {
  const blob = texts.join('\n');
  for (const raw of ALL_RAW_SECRETS()) expect(blob).not.toContain(raw);
}

const stateWith = (secrets: string[], resources: Record<string, string> = {}): ShipState => ({
  ...emptyState(),
  resources,
  secrets: Object.fromEntries(secrets.map((k) => [k, { fp: 'abcd1234', at: '2026-01-01T00:00:00Z' }])),
});

describe('golden path', () => {
  it('plans every link with deterministic ids, previews and risk flags', async () => {
    const { ctx } = setup();
    const plan = await build(ctx);
    expect(new Set(ids(plan))).toEqual(
      new Set([
        'project:hosting',
        'project:db',
        'env:preview',
        'env:production',
        'domain:attach',
        'domain:dns',
        'domain:verify',
        'payments:keys:preview',
        'payments:keys:production',
        'payments:webhook:production',
        'auth:redirects',
        'email:domain',
        'email:dns',
        'email:verify',
        'email:key:preview',
        'email:key:production',
        'deploy:production',
        'deploy:production:final',
      ]),
    );
    // Never deployed: the first production deploy (after the production env writers that don't need
    // the domain) comes BEFORE domain:attach; the webhook secret, which needs the domain, gets a final
    // redeploy. Preview env writes never force a production deploy.
    const first = byId(plan, 'deploy:production');
    expect(first.dependsOn).toEqual(expect.arrayContaining(['project:hosting', 'env:production', 'payments:keys:production', 'email:key:production']));
    expect(first.dependsOn).not.toContain('domain:attach');
    expect(first.dependsOn).not.toContain('env:preview');
    expect(first.preview.join('\n')).toMatch(/golive has not deployed production yet; the domain is attached after this deploy/);
    expect(first.verifyWith).toEqual(['bundle-secrets']);
    expect(byId(plan, 'domain:attach').dependsOn).toContain('deploy:production');
    expect(ids(plan).indexOf('deploy:production')).toBeLessThan(ids(plan).indexOf('domain:attach'));
    expect(ids(plan).at(-1)).toBe('deploy:production:final');
    expect(byId(plan, 'deploy:production:final').dependsOn).toEqual(['deploy:production', 'payments:webhook:production']);
    expect(byId(plan, 'deploy:production:final').verifyWith).toEqual(['bundle-secrets', 'webhook-unsigned']);
    expect(byId(plan, 'payments:webhook:production').dependsOn).toContain('domain:dns');
    expect(byId(plan, 'domain:verify').dependsOn).toEqual(['domain:attach', 'domain:dns']);
    // No env-writing step uses the global env-parity check (it needs names later steps write).
    for (const st of plan.steps) expect(st.verifyWith, st.id).not.toContain('env-parity');
    // The destination is named (and pinned) even though the project is already linked.
    expect(byId(plan, 'project:hosting').preview[0]).toBe('hosting: FakeHost project shop (prj_1), from the project already linked to this repo (golive state or FakeHost\'s local link file); every FakeHost write in this plan goes there');
    expect(byId(plan, 'project:hosting').preview).toContain('FakeHost access: fakehost CLI');
    expect(byId(plan, 'project:hosting').risk.writes).toBe(false);
    expect(byId(plan, 'env:production').dependsOn).toContain('project:hosting');
    expect(byId(plan, 'email:verify').dependsOn).toEqual(['email:domain', 'email:dns']);

    // Live / DNS gating.
    expect(byId(plan, 'payments:keys:production').risk.live).toBe(true);
    expect(byId(plan, 'payments:keys:preview').risk.live).toBeUndefined();
    expect(byId(plan, 'payments:webhook:production').risk.live).toBe(true);
    expect(byId(plan, 'domain:dns').risk.dns).toBe(true);
    expect(byId(plan, 'email:dns').risk.dns).toBe(true);
    expect(hIds(plan)).toEqual(['fakepay:activate']);
    expect(plan.handoffs[0]!.verifiedBy).toBe('fakepay-live-ready');
    expect(plan.warnings.join('\n')).toMatch(/preview URLs change/);
    expect(plan.warnings.join('\n')).toMatch(/localhost/);

    // Public values may appear in previews; secret ones never do.
    const view = JSON.stringify(planView(plan));
    expect(view).toContain('https://example.com/api/webhooks/stripe');
    expect(byId(plan, 'env:production').preview).toContain('add NEXT_PUBLIC_SITE_URL ← https://example.com (public)');
    expect(byId(plan, 'env:production').preview).toContain('add SUPABASE_SERVICE_ROLE_KEY ← supabase.secretKey from FakeDB (sensitive)');
    // No preview wildcard on the production auth project unless auth.previewRedirects is set.
    expect(byId(plan, 'auth:redirects').preview).toEqual(['site URL: http://localhost:3000 → https://example.com', 'add redirect URL https://example.com/**']);
    expect(plan.warnings.join('\n')).toMatch(/preview deployments are not added to the redirect allowlist/);
    expectNoRawSecrets([view, ...ctx.logs]);
  });

  it('produces the same plan id across builds (same ctx and a fresh one)', async () => {
    const a = setup();
    const p1 = await build(a.ctx);
    const p2 = await build(a.ctx);
    const p3 = await build(setup().ctx);
    expect(p2.id).toBe(p1.id);
    expect(p3.id).toBe(p1.id);
    expect(p1.steps.map((s) => s.preview)).toEqual(p3.steps.map((s) => s.preview));
  });

  it('applies: secrets reach the host only as Secret values via env.set, and nothing printable leaks', async () => {
    const { w, ctx, exec } = setup();
    const plan = await build(ctx);
    const outcomes = await apply(ctx, plan);
    expect(outcomes.map((o) => [o.id, o.status, o.error])).toEqual(plan.steps.map((s) => [s.id, 'done', undefined]));

    const prod = w.host.env.production;
    const secretNames = ['SUPABASE_SERVICE_ROLE_KEY', 'DATABASE_URL', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'RESEND_API_KEY'];
    for (const n of secretNames) expect(prod.get(n), n).toBeInstanceOf(Secret);
    expect((prod.get('STRIPE_SECRET_KEY') as Secret).reveal()).toBe(RAW.stripeLive);
    expect((w.host.env.preview.get('STRIPE_SECRET_KEY') as Secret).reveal()).toBe(RAW.stripeTest);
    expect((prod.get('DATABASE_URL') as Secret).reveal()).toBe(RAW.dbUrl);
    expect((prod.get('STRIPE_WEBHOOK_SECRET') as Secret).reveal()).toMatch(/^whsec_FAKE/);
    expect(prod.get('NEXT_PUBLIC_SUPABASE_URL')).toBe(PUBLIC.supabaseUrl);
    expect(prod.get('NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY')).toBe(PUBLIC.pkLive);
    expect(prod.get('NEXT_PUBLIC_SITE_URL')).toBe('https://example.com');
    expect(w.host.env.preview.get('NEXT_PUBLIC_SITE_URL')).toBe('https://shop-git-main.fakehost.app');

    // Every env.set with a secret value marked it sensitive.
    for (const c of w.calls.filter((c) => c.method === 'env.set')) {
      const [name, value, , opts] = c.args as [string, unknown, unknown, { sensitive?: boolean }];
      expect(opts?.sensitive, name).toBe(value instanceof Secret);
    }
    // Fingerprints (not values) recorded for every name written, per target.
    const st = ctx.state.get();
    expect(st.secrets['STRIPE_SECRET_KEY@production']?.fp).toBe((prod.get('STRIPE_SECRET_KEY') as Secret).fingerprint);
    expect(st.secrets['NEXT_PUBLIC_SITE_URL@production']).toBeDefined();
    expect(st.resources['fakepay.live.webhookEndpointId']).toBe('we_1');
    expect(st.resources['fakemail.domainId']).toBe('dom_example.com');
    expect(st.resources['fakemail.keyId@production']).toMatch(/^key_/);

    // Side effects on the other providers.
    expect(w.host.attached).toEqual(['example.com']);
    expect(w.host.deploys).toBe(2); // first deploy, then the final one after the webhook secret
    const order = w.calls.map((c) => c.method);
    expect(order.indexOf('deploy')).toBeLessThan(order.indexOf('domain.add'));
    expect(order.lastIndexOf('deploy')).toBeGreaterThan(order.indexOf('webhooks.ensure'));
    expect(st.resources['redeploy:production']).toBeUndefined();
    expect(st.resources['deployed:production']).toBeDefined();
    // The deployment the provider reported, with its own id: <provider>|<id>|<url>|<time>.
    expect(st.resources['deployed:production:id']).toMatch(/^fakehost\|dpl_fake1\|https:\/\/shop-abc123\.fakehost\.app\|\d{4}-\d\d-\d\dT/);
    // Every env-writing step verified exactly the names it wrote.
    const inline = outcomes.flatMap((o) => o.checks).filter((c) => c.id.endsWith(':env-written'));
    expect(inline.map((c) => c.id).sort()).toEqual(
      ['email:key:preview', 'email:key:production', 'env:preview', 'env:production', 'payments:keys:preview', 'payments:keys:production', 'payments:webhook:production'].map((i) => `${i}:env-written`).sort(),
    );
    expect(inline.every((c) => c.status === 'pass')).toBe(true);
    expect(w.dns.records.map((r) => `${r.type} ${r.name}`)).toEqual(['A example.com', 'MX send.example.com', 'TXT send.example.com', 'TXT fm._domainkey.example.com']);
    expect(w.dns.records.every((r) => r.proxied === false)).toBe(true);
    expect(w.db.auth.siteUrl).toBe('https://example.com');
    expect(w.db.auth.redirectUrls).toEqual(['http://localhost:3000/**', 'https://example.com/**']);

    // No child processes, and no raw secret in outcomes, logs, state or plan view.
    expect(exec.calls).toEqual([]);
    expectNoRawSecrets([JSON.stringify(outcomes), JSON.stringify(planView(plan)), ...ctx.logs, JSON.stringify(ctx.state.get())]);
  });

  it('is idempotent: after apply, the next plan has nothing left to do', async () => {
    const { w, ctx } = setup();
    await apply(ctx, await build(ctx));
    w.host.domainStatus = 'ok';
    w.mail.domains.get('example.com')!.status = 'verified';
    const again = await build(ctx);
    // Only local project pins remain. Recheck ownership on every apply without repeating remote writes.
    expect(ids(again)).toEqual(['project:hosting', 'project:db']);
    expect(again.steps.every((st) => !st.risk.writes)).toBe(true);
    expect(hIds(again)).toEqual(['fakepay:activate']);
    const writesBefore = w.calls.length;
    expect((await apply(ctx, again)).map((o) => o.status)).toEqual(['done', 'done']);
    expect(w.calls.slice(writesBefore).map((c) => c.method)).toEqual(['project.select', 'project.select']);
  });
});

describe('accounts', () => {
  it('turns a logged-out provider into a blocking handoff and leaves its steps out', async () => {
    const { ctx } = setup({ arrange: (w) => (w.pay.authed = false) });
    const plan = await build(ctx);
    const login = plan.handoffs.find((h) => h.id === 'login:fakepay');
    expect(login).toMatchObject({ blocking: true, verifiedBy: 'accounts', action: 'run `fakepay login` in your terminal' });
    expect(ids(plan).filter((i) => i.startsWith('payments:'))).toEqual([]);
    expect(ids(plan)).toContain('env:production');
    expect(plan.warnings.join('\n')).toMatch(/FakePay access could not be verified/);
  });

  it('checks auth once per provider even when it serves several axes', async () => {
    let n = 0;
    const { ctx } = setup({
      arrange: (w) => {
        const db = w.adapters.find((a) => a.id === 'fakedb')!;
        const orig = db.auth;
        db.auth = async (c) => (n++, orig(c));
      },
    });
    await build(ctx);
    expect(n).toBe(1);
  });

  it('never lets a throwing auth() break planning', async () => {
    const { ctx } = setup({
      arrange: (w) => {
        w.adapters.find((a) => a.id === 'fakemail')!.auth = async () => {
          throw new Error('network down');
        };
      },
    });
    const plan = await build(ctx);
    expect(plan.handoffs.find((h) => h.id === 'login:fakemail')?.action).toMatch(/network down/);
    expect(plan.warnings.join('\n')).toContain('access could not be verified');
    expect(plan.warnings.join('\n')).not.toContain('is not logged in');
    expect(ids(plan).some((i) => i.startsWith('email:'))).toBe(false);
  });

  it('points guided providers at references/guided.md (non-blocking)', async () => {
    const { ctx } = setup({ config: { stack: { ...FAKE_STACK, dns: 'porkbun' } } });
    const plan = await build(ctx);
    const g = plan.handoffs.find((h) => h.id === 'guided:dns');
    expect(g?.blocking).toBe(false);
    expect(g?.action).toMatch(/references\/guided\.md/);
  });
});

describe('projects', () => {
  const noProject = (w: FakeWorld) => (w.host.current = null);

  it('selects a candidate named like the repo dir', async () => {
    const { w, ctx } = setup({
      arrange: (x) => {
        noProject(x);
        x.host.candidates = [
          { id: 'prj_9', name: 'Shop' },
          { id: 'prj_8', name: 'other' },
        ];
      },
    });
    const plan = await build(ctx);
    const s = byId(plan, 'project:hosting');
    expect(s.title).toBe('Use existing FakeHost project Shop');
    expect(byId(plan, 'env:production').dependsOn).toContain('project:hosting');
    expect(byId(plan, 'env:production').preview.at(-1)).toMatch(/not observable yet/);
    await apply(ctx, plan);
    expect(w.calls.find((c) => c.method === 'project.select')?.args).toEqual(['prj_9']);
  });

  it('prefers config.projects over name matching', async () => {
    const { ctx } = setup({ config: { projects: { hosting: 'legacy-shop' } }, arrange: noProject });
    expect(byId(await build(ctx), 'project:hosting').preview[0]).toMatch(/Use existing FakeHost project legacy-shop/);
  });

  it('creates when nothing matches, and surfaces a cost error at run time', async () => {
    const { ctx } = setup({
      arrange: (x) => {
        noProject(x);
        x.host.createError = 'project limit reached on the free plan; upgrade or delete a project';
      },
    });
    const plan = await build(ctx);
    expect(byId(plan, 'project:hosting').title).toBe('Create FakeHost project shop');
    const out = await apply(ctx, plan);
    expect(out[0]).toMatchObject({ id: 'project:hosting', status: 'failed' });
    expect(out[0]!.error).toMatch(/creating FakeHost project shop failed: project limit reached/);
  });

  it('hands off with candidate names when it cannot create', async () => {
    const { ctx } = setup({
      arrange: (x) => {
        noProject(x);
        x.host.canCreate = false;
        x.host.candidates = [
          { id: 'b', name: 'beta' },
          { id: 'a', name: 'alpha' },
        ];
      },
    });
    const plan = await build(ctx);
    const h = plan.handoffs.find((x) => x.id === 'project:hosting');
    expect(h?.blocking).toBe(true);
    expect(h?.action).toMatch(/alpha, beta/);
    expect(h?.action).toMatch(/init --project hosting=<name>/);
  });
});

describe('env', () => {
  it('keeps unmanaged names, updates managed ones', async () => {
    const { w, ctx } = setup({
      state: stateWith(['SUPABASE_SERVICE_ROLE_KEY@production']),
      arrange: (x) => {
        x.host.env.production.set('NEXT_PUBLIC_SUPABASE_URL', 'https://set-by-hand.example');
        x.host.env.production.set('SUPABASE_SERVICE_ROLE_KEY', new Secret('OLD', 'old-managed-secret-value'));
      },
    });
    const plan = await build(ctx);
    const pv = byId(plan, 'env:production').preview;
    expect(pv).toContain('keep NEXT_PUBLIC_SUPABASE_URL (already set, not managed by golive)');
    expect(pv).toContain('update (managed by golive) SUPABASE_SERVICE_ROLE_KEY ← supabase.secretKey from FakeDB (sensitive)');
    await apply(ctx, plan);
    expect(w.host.env.production.get('NEXT_PUBLIC_SUPABASE_URL')).toBe('https://set-by-hand.example');
    expect((w.host.env.production.get('SUPABASE_SERVICE_ROLE_KEY') as Secret).reveal()).toBe(RAW.supabaseSecret);
  });

  it('hands off DATABASE_URL when the db provider cannot reveal the connection string', async () => {
    const { ctx } = setup({ arrange: (w) => (w.db.provides = ['supabase.url', 'supabase.publishableKey', 'supabase.secretKey']) });
    const plan = await build(ctx);
    const h = plan.handoffs.find((x) => x.id === 'db:password');
    expect(h).toMatchObject({ blocking: true, verifiedBy: 'env-parity' });
    expect(h?.action).toMatch(/reset/);
    expect(byId(plan, 'env:production').preview.join('\n')).not.toContain('DATABASE_URL');
  });

  it('does not hand off DATABASE_URL someone already set', async () => {
    const { ctx } = setup({
      arrange: (w) => {
        w.db.provides = ['supabase.url', 'supabase.publishableKey', 'supabase.secretKey'];
        for (const t of ['preview', 'production'] as const) w.host.env[t].set('DATABASE_URL', 'x');
      },
    });
    expect(hIds(await build(ctx))).not.toContain('db:password');
  });

  it('falls back to outputs() key names when the provider declares nothing, without leaking values', async () => {
    const { w, ctx } = setup({ arrange: (x) => (x.db.declaresProvides = false) });
    const outputs = w.adapters.find((a) => a.id === 'fakedb')!.capabilities.outputs!;
    expect(await availableKeys(ctx, outputs, 'production')).toEqual(new Set(['supabase.url', 'supabase.publishableKey', 'supabase.secretKey', 'db.url']));
    const plan = await build(ctx);
    expect(ids(plan)).toContain('env:production');
    expectNoRawSecrets([JSON.stringify(planView(plan)), ...ctx.logs]);
  });

  it('fails run() with a secret-free, actionable error when a planned output disappears', async () => {
    const { w, ctx } = setup({ config: { stack: { hosting: 'fakehost', db: 'fakedb' } } });
    const plan = await build(ctx);
    w.db.provides = ['supabase.url'];
    const out = await apply(ctx, plan);
    const failed = out.find((o) => o.status === 'failed');
    expect(failed?.id).toBe('env:preview');
    expect(failed?.error).toMatch(/FakeDB returned no value for .*DATABASE_URL \(db\.url\)/);
    expect(failed?.error).toMatch(/database password/);
    expect(w.host.env.preview.size).toBe(0); // validated before writing anything
  });

  it('lists names for a guided host as a handoff (values go dashboard to dashboard)', async () => {
    const { ctx } = setup({ config: { stack: { hosting: 'fakeguided', db: 'fakedb' } } });
    const plan = await build(ctx);
    const h = plan.handoffs.find((x) => x.id === 'env:production');
    expect(h?.action).toMatch(/NEXT_PUBLIC_SUPABASE_URL/);
    expect(h?.action).toMatch(/never through this chat/);
    expect(ids(plan).filter((i) => i.startsWith('env:'))).toEqual([]);
  });

});

describe('payments', () => {
  it('does not gate test-mode production and warns about it', async () => {
    const { ctx } = setup({ config: { payments: { ...BASE_CONFIG.payments, modes: { production: 'test' } } } });
    const plan = await build(ctx);
    expect(byId(plan, 'payments:keys:production').risk.live).toBeUndefined();
    expect(byId(plan, 'payments:webhook:production').risk.live).toBeUndefined();
    expect(hIds(plan)).not.toContain('fakepay:activate');
    expect(plan.warnings.join('\n')).toMatch(/test mode/);
  });

  it('updates managed keys when the mode behind them changes, and only then', async () => {
    const { w, ctx } = setup({ config: { payments: { ...BASE_CONFIG.payments, modes: { production: 'test' } } } });
    await apply(ctx, await build(ctx));
    expect((w.host.env.production.get('STRIPE_SECRET_KEY') as Secret).reveal()).toBe(RAW.stripeTest);
    expect(ids(await build(ctx))).not.toContain('payments:keys:production');

    ctx.config.payments = { ...BASE_CONFIG.payments, modes: { production: 'live' } };
    const plan = await build(ctx);
    expect(byId(plan, 'payments:keys:production').preview).toContain('update (managed by golive) STRIPE_SECRET_KEY ← stripe.secretKey (live mode) (sensitive)');
    // force: the runner skips step ids already 'done' in state, even from an older plan.
    await applyPlan(ctx, plan, new Map(), { approvedPlanId: plan.id, yes: true, confirmLive: true, confirmDns: true, force: true, only: ['payments:keys:production'] });
    expect((w.host.env.production.get('STRIPE_SECRET_KEY') as Secret).reveal()).toBe(RAW.stripeLive);
  });

  it('adopted endpoint with outdated events: ensure only, no secret rewrite', async () => {
    const { w, ctx } = setup({
      state: stateWith(['STRIPE_WEBHOOK_SECRET@production'], { 'env:STRIPE_WEBHOOK_SECRET@production': 'stripe.webhookSecret|fakepay|live|we_old' }),
      arrange: (x) => {
        x.pay.endpoints.push({ id: 'we_old', url: 'https://example.com/api/webhooks/stripe', events: ['invoice.paid'], enabled: true, mode: 'live' });
        x.host.env.production.set('STRIPE_WEBHOOK_SECRET', 'set');
      },
    });
    const plan = await build(ctx);
    expect(byId(plan, 'payments:webhook:production').preview.slice(1)).toEqual(['ensure live webhook endpoint we_old → https://example.com/api/webhooks/stripe (events: checkout.session.completed)']);
    await apply(ctx, plan);
    expect(w.host.env.production.get('STRIPE_WEBHOOK_SECRET')).toBe('set');
    expect(w.pay.endpoints[0]!.events).toEqual(['checkout.session.completed']);
  });

  it('hands off a missing secret key (credentials file, not chat) and a missing publishable key (init flag)', async () => {
    const { ctx } = setup({
      arrange: (w) => {
        delete w.pay.secretKeys.live;
        delete w.pay.publishableKeys.live;
      },
    });
    const plan = await build(ctx);
    const sk = plan.handoffs.find((h) => h.id === 'fakepay:secret-key:live');
    expect(sk?.action).toContain('credentials --prompt FAKEPAY_LIVE_SECRET_KEY --json');
    expect(sk?.action).toContain('`FAKEPAY_LIVE_SECRET_KEY=<value>`'); // editor fallback uses the same mode-specific name
    expect(sk?.action).toMatch(/Never paste the value into this chat/);
    expect(sk?.action).not.toMatch(/export \S+ in (your|their) terminal|read -s/);
    expect(sk?.verifiedBy).toBe('env-parity');
    const pk = plan.handoffs.find((h) => h.id === 'fakepay:publishable-key:live')?.action;
    expect(pk).toMatch(/init --stripe-publishable live=pk_live_…/);
    expect(pk).toMatch(/public .* may paste it in chat — but never a secret key/);
    expect(pk).toMatch(/Or the human adds NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY to FakeHost themselves/);
    expect(pk).not.toMatch(/golive\.yaml/);
    expect(ids(plan)).not.toContain('payments:keys:production');
    expect(ids(plan)).toContain('payments:keys:preview');
  });

  it('replaces an adopted endpoint whose secret golive does not have', async () => {
    const { w, ctx } = setup({
      arrange: (x) => {
        x.pay.endpoints.push({ id: 'we_old', url: 'https://example.com/api/webhooks/stripe', events: ['checkout.session.completed'], enabled: true, mode: 'live' });
        x.pay.n = 1;
      },
    });
    const plan = await build(ctx);
    const s = byId(plan, 'payments:webhook:production');
    expect(s.preview.join('\n')).toMatch(/replace endpoint we_old/);
    await apply(ctx, plan);
    expect(w.pay.deleted).toEqual(['we_old']);
    expect(w.calls.filter((c) => c.method === 'webhooks.replace').map((c) => c.args[0])).toEqual(['we_old']);
    const secret = w.host.env.production.get('STRIPE_WEBHOOK_SECRET') as Secret;
    expect(secret.reveal()).toBe(`${RAW.whsecPrefix}2xyz`);
    expect(ctx.state.get().resources['fakepay.live.webhookEndpointId']).toBe('we_2');
    expect(ctx.state.get().secrets['STRIPE_WEBHOOK_SECRET@production']?.fp).toBe(secret.fingerprint);
  });

  it('keeps the old endpoint when storing the replacement secret fails (no broken webhook)', async () => {
    const { w, ctx } = setup({
      arrange: (x) => {
        x.pay.endpoints.push({ id: 'we_old', url: 'https://example.com/api/webhooks/stripe', events: ['checkout.session.completed'], enabled: true, mode: 'live' });
        x.pay.n = 1;
      },
    });
    const plan = await build(ctx);
    const hostAdapter = ctx.adapters.find((a) => a.id === ctx.config.stack.hosting)!;
    const env = hostAdapter.capabilities.env!;
    const realSet = env.set;
    env.set = async (c, name, ...rest) => {
      if (name === 'STRIPE_WEBHOOK_SECRET') throw new Error('host env write failed');
      return realSet(c, name, ...rest);
    };
    const out = await apply(ctx, plan);
    const o = out.find((x) => x.id === 'payments:webhook:production')!;
    expect(o.status).toBe('failed');
    // The old endpoint stays; the replacement whose secret was just lost is removed, not orphaned.
    expect(w.pay.endpoints.map((e) => e.id)).toEqual(['we_old']);
    expect(w.pay.deleted).toEqual(['we_2']);
    expect(o.error).toMatch(/created live webhook endpoint we_2 but storing its signing secret in FakeHost failed \(host env write failed\); it was deleted again/);
    expect(o.error).toMatch(/previous endpoint we_old was kept/);
    env.set = realSet;
  });

  it('leaves an adopted endpoint alone when its managed secret is on the host', async () => {
    const { ctx } = setup({
      state: stateWith(['STRIPE_WEBHOOK_SECRET@production'], { 'env:STRIPE_WEBHOOK_SECRET@production': 'stripe.webhookSecret|fakepay|live|we_old' }),
      arrange: (x) => {
        x.pay.endpoints.push({ id: 'we_old', url: 'https://example.com/api/webhooks/stripe', events: ['checkout.session.completed'], enabled: true, mode: 'live' });
        x.host.env.production.set('STRIPE_WEBHOOK_SECRET', 'set');
      },
    });
    expect(ids(await build(ctx))).not.toContain('payments:webhook:production');
  });

  it('hands off when the endpoint cannot be replaced', async () => {
    const { ctx } = setup({
      arrange: (x) => {
        x.pay.withReplace = false;
        x.pay.endpoints.push({ id: 'we_old', url: 'https://example.com/api/webhooks/stripe', events: ['checkout.session.completed'], enabled: true, mode: 'live' });
      },
    });
    const plan = await build(ctx);
    expect(ids(plan)).not.toContain('payments:webhook:production');
    expect(plan.handoffs.find((h) => h.id === 'fakepay:webhook-secret')?.blocking).toBe(true);
  });

  it('defaults the secret name and uses the host URL when there is no domain (once golive has deployed)', async () => {
    const { w, ctx } = setup({ config: { domain: undefined }, env: ['STRIPE_SECRET_KEY'], state: stateWith([], { 'deployed:production': '2026-01-01T00:00:00.000Z' }) });
    const plan = await build(ctx);
    expect(byId(plan, 'payments:webhook:production').preview[1]).toContain('https://shop.fakehost.app/api/webhooks/stripe');
    expect(byId(plan, 'payments:webhook:production').dependsOn).not.toContain('domain:dns');
    expect(plan.warnings.join('\n')).toMatch(/STRIPE_WEBHOOK_SECRET/);
    await apply(ctx, plan);
    expect(w.host.env.production.get('STRIPE_WEBHOOK_SECRET')).toBeInstanceOf(Secret);
  });

  it('skips the webhook (with a warning) until a production URL exists', async () => {
    const { ctx } = setup({ config: { domain: undefined }, arrange: (w) => (w.host.urls.production = null) });
    const plan = await build(ctx);
    expect(ids(plan)).not.toContain('payments:webhook:production');
    expect(ids(plan)).toContain('deploy:production');
    expect(plan.warnings.join('\n')).toMatch(/production URL isn't known yet/);
  });
});

describe('auth redirects', () => {
  it('emits nothing when already configured', async () => {
    const { ctx } = setup({
      arrange: (w) => (w.db.auth = { siteUrl: 'https://example.com', redirectUrls: ['https://example.com/**', 'https://shop-*.fakehost.app/**'] }),
    });
    expect(ids(await build(ctx))).not.toContain('auth:redirects');
  });

  it('adds configured callback paths and never drops existing entries', async () => {
    const { w, ctx } = setup({ config: { auth: { redirectPaths: ['/auth/callback'] } } });
    const plan = await build(ctx);
    expect(byId(plan, 'auth:redirects').preview).toContain('add redirect URL https://example.com/auth/callback');
    w.db.auth.redirectUrls.push('https://added-meanwhile.example/**');
    await apply(ctx, plan);
    expect(w.db.auth.redirectUrls).toContain('https://added-meanwhile.example/**');
    expect(w.db.auth.redirectUrls).toContain('http://localhost:3000/**');
  });

  it('hands off for a guided auth provider', async () => {
    const { ctx } = setup({ config: { stack: { ...FAKE_STACK, auth: 'fakeguided' } } });
    const h = (await build(ctx)).handoffs.find((x) => x.id === 'auth:redirects');
    expect(h?.action).toMatch(/add https:\/\/example\.com to the allowed origins/);
    // Nothing golive can observe closes it: manual, not an eternal open blocker.
    expect(h).toMatchObject({ blocking: false, manual: true });
    expect(h?.verifiedBy).toBeUndefined();
  });
});

describe('dns + email', () => {
  it('guided DNS: records become blocking handoffs, no DNS steps', async () => {
    const { ctx } = setup({ config: { stack: { ...FAKE_STACK, dns: 'porkbun' } } });
    const plan = await build(ctx);
    expect(ids(plan)).not.toContain('domain:dns');
    expect(ids(plan)).not.toContain('email:dns');
    const d = plan.handoffs.find((h) => h.id === 'domain:dns');
    expect(d).toMatchObject({ blocking: true, verifiedBy: 'domain-live' });
    expect(d?.action).toContain('A example.com = 76.76.21.21');
    expect(plan.handoffs.find((h) => h.id === 'email:dns')).toMatchObject({ blocking: true, verifiedBy: 'email-dns' });
    expect(byId(plan, 'email:verify').dependsOn).toEqual(['email:domain']);
    expect(byId(plan, 'payments:webhook:production').dependsOn).not.toContain('domain:dns');
  });

  it('hands off DNS when the DNS provider does not host the zone', async () => {
    const { ctx } = setup({ arrange: (w) => w.dns.zones.clear() });
    const plan = await build(ctx);
    expect(plan.handoffs.find((h) => h.id === 'domain:dns')?.action).toMatch(/FakeDNS doesn't host this zone in this account/);
  });

  it('lists the sending records in the email:domain changes and never fails verify on pending DNS', async () => {
    const { w, ctx } = setup({ config: { stack: { ...FAKE_STACK, dns: 'porkbun' } }, arrange: (x) => (x.mail.verifyError = 'records not found yet') });
    const out = await apply(ctx, await build(ctx));
    const dom = out.find((o) => o.id === 'email:domain')!;
    expect(dom.changes).toContain('TXT send.example.com = v=spf1 include:fakemail.com ~all');
    const v = out.find((o) => o.id === 'email:verify')!;
    expect(v.status).toBe('done');
    expect(v.changes.join('\n')).toMatch(/still be propagating/);
    expect(w.dns.records).toEqual([]);
  });

  it('skips the sending key when it is remembered and on the host', async () => {
    const { ctx } = setup({
      state: stateWith([], { 'fakemail.keyId@production': 'key_7' }),
      arrange: (w) => w.host.env.production.set('RESEND_API_KEY', 'x'),
    });
    const plan = await build(ctx);
    expect(ids(plan)).not.toContain('email:key:production');
    expect(ids(plan)).toContain('email:key:preview');
  });

  it('picks the sending domain from email.domain, then email.from, then domain', () => {
    const c = (config: Partial<ShipConfig>) => testCtx({ config });
    expect(emailDomain(c({ email: { domain: 'Mail.Example.com', from: 'a@b.com' } }))).toBe('mail.example.com');
    expect(emailDomain(c({ email: { from: 'Shop <hi@shop.io>' }, domain: 'x.com' }))).toBe('shop.io');
    expect(emailDomain(c({ domain: 'x.com' }))).toBe('x.com');
    expect(emailDomain(c({}))).toBeNull();
  });

  it('skips email with a warning when no domain can be derived', async () => {
    const { ctx } = setup({ config: { domain: undefined, email: undefined } });
    const plan = await build(ctx);
    expect(ids(plan).some((i) => i.startsWith('email:'))).toBe(false);
    expect(plan.warnings.join('\n')).toMatch(/no sending domain/);
  });
});

describe('deploy', () => {
  it('is omitted when nothing needs a new deployment', async () => {
    const { ctx } = setup({ config: { stack: { hosting: 'fakehost', db: 'fakedb', auth: 'fakedb' }, domain: undefined }, env: [], state: stateWith([], { 'deployed:production': '2026-01-01T00:00:00.000Z' }) });
    const plan = await build(ctx);
    expect(ids(plan)).toEqual(['project:hosting', 'project:db', 'auth:redirects']);
  });

  it('is planned when production was never deployed', async () => {
    const { ctx } = setup({ config: { stack: { hosting: 'fakehost' }, domain: undefined }, env: [], arrange: (w) => (w.host.urls.production = null) });
    const plan = await build(ctx);
    expect(ids(plan)).toEqual(['project:hosting', 'deploy:production']);
    // No webhook secret has been written yet, so the unsigned-webhook probe waits for `verify`.
    expect(byId(plan, 'deploy:production').verifyWith).toEqual(['bundle-secrets']);
  });

  it('records the provider’s own deployment id next to the deploy time marker', async () => {
    const { ctx } = setup({ config: { stack: { hosting: 'fakehost' }, domain: undefined }, env: [], arrange: (w) => (w.host.urls.production = null) });
    await apply(ctx, await build(ctx));
    const at = ctx.state.resource('deployed:production')!;
    expect(at).toMatch(/^\d{4}-/);
    // <provider>|<the deployment the provider reported>|<url>|<time>: the name a promotion or
    // rollback would use, not a value golive derived.
    expect(ctx.state.resource('deployed:production:id')).toBe(`fakehost|dpl_fake1|https://shop-abc123.fakehost.app|${at}`);
  });

  it('records the marker alone, inventing no id, for a provider that reports none', async () => {
    const { w, ctx } = setup({
      config: { stack: { hosting: 'fakehost' }, domain: undefined },
      env: [],
      arrange: (x) => {
        x.host.urls.production = null;
        x.host.deployId = null;
      },
    });
    await apply(ctx, await build(ctx));
    expect(w.host.deploys).toBe(1);
    expect(ctx.state.resource('deployed:production')).toMatch(/^\d{4}-/);
    expect(ctx.state.resource('deployed:production:id')).toBeUndefined();
  });

  it('does not leave an earlier deployment’s identity behind when the provider reports none', () => {
    const { ctx } = setup({ state: stateWith([], { 'deployed:production': '2026-01-01T00:00:00.000Z', 'deployed:production:id': 'fakehost|dpl_old|https://shop.fakehost.app|2026-01-01T00:00:00.000Z' }) });
    recordDeploy(ctx, 'fakehost', 'production', { url: 'https://shop.fakehost.app' });
    expect(ctx.state.resource('deployed:production:id')).toBeUndefined();
    expect(ctx.state.resource('deployed:production')).not.toBe('2026-01-01T00:00:00.000Z');
  });

  it('plans nothing extra without the release.preview opt-in: same plan id, same steps', async () => {
    const plain = await build(setup().ctx);
    for (const release of [undefined, {}, { preview: false }]) {
      const p = await build(setup({ config: { release } }).ctx);
      expect(ids(p), JSON.stringify(release)).toEqual(ids(plain));
      expect(p.id, JSON.stringify(release)).toBe(plain.id);
      expect(p.steps.map((s) => s.preview)).toEqual(plain.steps.map((s) => s.preview));
      expect(p.steps.map((s) => s.intent)).toEqual(plain.steps.map((s) => s.intent));
    }
    const optedIn = await build(setup({ config: { release: { preview: true } } }).ctx);
    expect(ids(optedIn)).toEqual([...ids(plain), 'preview:deploy', 'release:check']);
    expect(optedIn.id).not.toBe(plain.id);
  });
});

// ── Opt-in preview deploy + the release check that gates it ─────────────────────────────────────────

const PREVIEW_URL = 'https://shop-preview-abc123.fakehost.app';
const PREVIEW_ID = 'dpl_fake1_preview';
const PREVIEW_AT = '2026-01-01T00:00:00.000Z';
const recordedPreviewId = (provider = 'fakehost', id = 'dpl_prev', url = PREVIEW_URL): string => `${provider}|${id}|${url}|${PREVIEW_AT}`;

/**
 * The golden-path stack with `release.preview: true`, the branch readable, and the host reporting the
 * preview deployment a deploy would make (the fake host deploys to PREVIEW_URL).
 */
function previewSetup(opts: Parameters<typeof setup>[0] = {}) {
  return setup({
    ...opts,
    config: { release: { preview: true }, ...opts.config },
    exec: opts.exec ?? [['git rev-parse', { stdout: 'main\n' }]],
    arrange: (w) => {
      w.host.urls.preview = PREVIEW_URL;
      opts.arrange?.(w);
    },
  });
}
const withRecordedPreview = (extra: Record<string, string> = {}, provider = 'fakehost'): ShipState =>
  stateWith([], { 'deployed:preview': PREVIEW_AT, 'deployed:preview:id': recordedPreviewId(provider), ...extra });

/** The two release checks, as the runtime registers them (the deploy step's own verification runs them). */
const previewChecks = () =>
  new Map<string, Check>([
    ['preview-deploy', previewDeployCheck],
    ['preview-bundle', previewBundleCheck],
  ]);

describe('opt-in preview deploy', () => {
  it('plans preview:deploy last-named, with the risk and dependencies the approval needs', async () => {
    const { ctx } = previewSetup();
    const plan = await build(ctx);
    expect(ids(plan).slice(-2)).toEqual(['preview:deploy', 'release:check']);

    const deploy = byId(plan, 'preview:deploy');
    expect(deploy.kind).toBe('deploy');
    expect(deploy.risk).toEqual({ writes: true });
    expect(deploy.risk.replayable).toBeUndefined(); // a preview is a create, never a replay
    expect(deploy.dependsOn).toEqual(['project:hosting', 'env:preview']);
    expect(deploy.verifyWith).toEqual(['preview-deploy']);

    // What a human needs in order to approve: the provider and project, the env target, what tree it
    // deploys, the URL, whether the preview shares production's source project, and no promotion.
    const pv = deploy.preview.join('\n');
    expect(pv).toMatch(/deploy a preview on FakeHost: the preview env changes in this plan \(env:preview\) and only reaches a new deployment; golive has never deployed a preview for this app/);
    expect(pv).toContain('project: FakeHost project shop (prj_1)');
    expect(pv).toContain('source: the current working tree on disk, uncommitted changes included (golive deploys no commit), on branch main');
    expect(pv).toContain('env target: preview — the env:preview writes in this plan apply to the next preview deployment only, never to production');
    expect(pv).toContain('data: golive fills the preview env from the same FakeDB db_1 that production uses (golive has one project per axis for the whole app), so a preview reads and writes the same database and auth project as production');
    expect(pv).toMatch(/data: .*payments keys in preview come from FakePay test mode/);
    expect(pv).toContain("preview URL: FakeHost reports this deployment's own URL and id, which golive records under deployed:preview:id (golive has not deployed a preview yet)");
    expect(pv).toContain('nothing is promoted: this deploys a preview and checks it, and production is unchanged — golive never replays or replaces a preview');
    expect(pv).not.toMatch(/--confirm-live/); // no live-mode source behind a preview name yet
    expect(plan.warnings.join('\n')).not.toMatch(/release\.preview is set/);
    expectNoRawSecrets([JSON.stringify(planView(plan)), ...ctx.logs]);
  });

  it('records the provider’s own preview deployment id, like production', async () => {
    const { w, ctx } = previewSetup();
    const plan = await build(ctx);
    const out = await apply(ctx, plan, previewChecks());
    expect(out.map((o) => [o.id, o.status])).toEqual(plan.steps.map((s) => [s.id, 'done']));
    expect(w.host.deploys).toBe(3); // two production deploys (the first, then the final after the webhook secret), then the preview
    const at = ctx.state.resource('deployed:preview')!;
    expect(at).toMatch(/^\d{4}-/);
    expect(ctx.state.resource('deployed:preview:id')).toBe(`fakehost|${PREVIEW_ID}|${PREVIEW_URL}|${at}`);
    // The deploy step was verified by the provider's own read of the deployment it recorded.
    const deploy = out.find((o) => o.id === 'preview:deploy')!;
    expect(deploy.checks.map((c) => [c.id, c.status])).toEqual([['preview-deploy', 'pass']]);
    // The gate ran both release checks (the preview bundle could not be fetched by the bare mock: warn).
    const gate = out.find((o) => o.id === 'release:check')!;
    expect(gate.checks.map((c) => c.id)).toEqual(['preview-deploy', 'preview-bundle']);
    expect(gate.checks.every((c) => c.status !== 'fail')).toBe(true);
    expect(gate.changes.join(' ')).toMatch(/no writes/);
    expectNoRawSecrets([JSON.stringify(out), JSON.stringify(ctx.state.get()), ...ctx.logs]);
  });

  it('re-plans the preview with a live-mode source behind a preview name and needs --confirm-live', async () => {
    // (a) recorded: golive already filled a preview name from live-mode keys.
    const recorded = previewSetup({ state: withRecordedPreview({ 'env:STRIPE_SECRET_KEY@preview': 'stripe.secretKey|fakepay|live|fp123|acct_FakePay' }) });
    const a = byId(await build(recorded.ctx), 'preview:deploy');
    expect(a.risk).toEqual({ writes: true, live: true });
    expect(a.preview.join('\n')).toMatch(/live-mode values behind preview env names \(STRIPE_SECRET_KEY\): a preview built with them can reach live payments or live data, so approving this deploy needs --confirm-live/);
    expect(planView(await build(recorded.ctx)).steps.find((s) => s.id === 'preview:deploy')!.needs).toEqual(['--confirm-live']);

    // (b) planned: this plan is about to write live-mode keys into preview.
    const planned = previewSetup({ config: { payments: { ...BASE_CONFIG.payments, modes: { preview: 'live' } } } });
    const b = byId(await build(planned.ctx), 'preview:deploy');
    expect(b.risk).toEqual({ writes: true, live: true });
    expect(b.preview.join('\n')).toMatch(/live-mode values behind preview env names \(NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY, STRIPE_SECRET_KEY\)/);

    // A test-mode preview needs no live confirmation.
    expect(byId(await build(previewSetup().ctx), 'preview:deploy').risk).toEqual({ writes: true });
  });

  it('says so when the opt-in cannot be honoured instead of planning nothing silently', async () => {
    const noTarget = await build(setup({ config: { release: { preview: true }, targets: ['production'] } }).ctx);
    expect(ids(noTarget)).not.toContain('preview:deploy');
    expect(noTarget.warnings.join('\n')).toMatch(/release\.preview is set, but `targets` in golive\.yaml does not manage preview/);

    const loggedOut = await build(setup({ config: { release: { preview: true } }, arrange: (w) => (w.host.authed = false) }).ctx);
    expect(ids(loggedOut)).not.toContain('preview:deploy');
    expect(loggedOut.warnings.join('\n')).toMatch(/release\.preview is set, but golive cannot deploy a preview on fakehost/);
  });

  it('the preview steps are the only difference: everything else in the plan is untouched', async () => {
    const plain = await build(setup({ arrange: (w) => (w.host.urls.preview = PREVIEW_URL) }).ctx);
    const opted = await build(previewSetup().ctx);
    expect(ids(opted).slice(0, -2)).toEqual(ids(plain));
    expect(opted.steps.slice(0, -2).map((s) => s.preview)).toEqual(plain.steps.map((s) => s.preview));
  });

  it('names the working tree even when the local git cannot report a branch', async () => {
    const { ctx } = previewSetup({ exec: [] });
    expect(byId(await build(ctx), 'preview:deploy').preview.join('\n')).toContain(
      'source: the current working tree on disk, uncommitted changes included (golive deploys no commit); golive could not read the git branch',
    );
  });
});

describe('release:check is the gate', () => {
  const KEY = 'sk_' + 'live_' + 'Z9'.repeat(12);
  const previewHttp = (leak: () => boolean) =>
    mockHttp([
      ['GET', `${PREVIEW_URL}/`, () => ({ text: '<script src="/a.js"></script>' })],
      ['GET', `${PREVIEW_URL}/a.js`, () => ({ text: leak() ? `const k="${KEY}"` : 'const ok=1' })],
    ]).http;

  it('fails the step and stops the plan: a step that depends on the gate never runs', async () => {
    const { ctx } = previewSetup({ http: previewHttp(() => true) });
    const plan = await build(ctx);
    // A later slice's promotion step would depend on release:check exactly like this placeholder does.
    plan.steps.push(step({ id: 'promote:preview', title: 'Promote the checked preview', kind: 'wire', risk: { writes: true }, dependsOn: ['release:check'], preview: ['a later slice would promote a checked preview here'], run: async () => ({ changes: ['promoted'] }) }));
    plan.id = planId(plan.steps, plan.handoffs, ctx.release);

    const out = await applyPlan(ctx, plan, previewChecks(), { approvedPlanId: plan.id, yes: true, confirmLive: true, confirmDns: true });
    expect(out.map((o) => o.id)).not.toContain('promote:preview');
    const gate = out.find((o) => o.id === 'release:check')!;
    expect(gate.status).toBe('failed');
    expect(gate.checks.find((c) => c.id === 'preview-bundle')).toMatchObject({ status: 'fail', severity: 'critical' });
    expect(ctx.state.get().steps['release:check']?.status).toBe('failed');
    expectNoRawSecrets([JSON.stringify(out), JSON.stringify(ctx.state.get())]);
    expect(JSON.stringify(out)).not.toContain(KEY);
  });

  it('is re-planned after a failure and passed once the leak is gone', async () => {
    let leak = true;
    const { w, ctx } = previewSetup({ http: previewHttp(() => leak) });
    const p1 = await build(ctx);
    expect((await apply(ctx, p1)).find((o) => o.id === 'release:check')?.status).toBe('failed');

    // The failure is recorded, so a fresh plan asks for the gate again — and for a new deployment of
    // whatever fixed it (the recorded preview is the bundle that failed).
    const p2 = await build(ctx);
    expect(ids(p2)).toEqual(expect.arrayContaining(['preview:deploy', 'release:check']));
    expect(byId(p2, 'release:check').preview.join('\n')).toMatch(/previous release check: 20/);
    expect(byId(p2, 'release:check').intent).not.toBe(byId(p1, 'release:check').intent);
    const out2 = await apply(ctx, p2, previewChecks());
    expect(out2.find((o) => o.id === 'preview:deploy')?.status).toBe('done');
    expect(out2.find((o) => o.id === 'release:check')?.status).toBe('failed');

    // A retry builds a fresh preview of whatever was fixed (the gate checks the deployment golive made,
    // and a re-planned preview deploy is a new deployment): the step's identity carries the preview
    // before it, so it never resumes a bundle it did not replace.
    leak = false;
    const out3 = await apply(ctx, await build(ctx), previewChecks());
    expect(out3.find((o) => o.id === 'preview:deploy')?.status).toBe('done');
    expect(out3.find((o) => o.id === 'release:check')?.status).toBe('done');
    expect(w.host.deploys).toBe(5);
    // Nothing left to do: the preview is deployed and its gate passed (with the domain live, like the
    // golden-path idempotency test).
    w.host.domainStatus = 'ok';
    w.mail.domains.get('example.com')!.status = 'verified';
    expect(ids(await build(ctx))).toEqual(['project:hosting', 'project:db']);
  });
});

describe('preview-deploy / preview-bundle status matrix', () => {
  const runDeploy = (ctx: Parameters<typeof previewDeployCheck.run>[0]) => previewDeployCheck.run(ctx);
  const runBundle = (ctx: Parameters<typeof previewBundleCheck.run>[0]) => previewBundleCheck.run(ctx);

  it('passes when the provider confirms the recorded preview deployment', async () => {
    const r = await runDeploy(previewSetup({ state: withRecordedPreview() }).ctx);
    expect(r.status).toBe('pass');
    const ev = r.evidence.join('\n');
    expect(ev).toContain(`fakehost deployment dpl_prev is what fakehost reports for the preview target of the project this repo links (shop (prj_1))`);
    expect(ev).toMatch(/confirms the deployment exists, is ready and belongs to this project, and that it is not the project's production deployment/);
    expect(ev).toContain(`recorded by golive ${PREVIEW_AT} (deployed:preview:id)`);
    expect(ev).toMatch(/a private preview is normal/);
  });

  it('skips with the honest reason when no preview deployment is recorded', async () => {
    const r = await runDeploy(setup().ctx);
    expect(r).toEqual({ status: 'skip', severity: 'info', evidence: ['golive recorded no preview deployment (no deployed:preview:id in .golive/state.json), so there is nothing to confirm'] });
    expect((await runBundle(setup().ctx)).status).toBe('skip');
  });

  it('skips when the host reports no preview URL to confirm (a deployment URL is per deployment)', async () => {
    const { ctx } = previewSetup({ state: withRecordedPreview(), arrange: (w) => (w.host.urls.preview = null), exec: [] });
    const r = await runDeploy(ctx);
    expect(r.status).toBe('skip');
    expect(r.evidence[0]).toMatch(/no fakehost read confirms fakehost deployment dpl_prev/);
    expect(r.evidence[0]).toMatch(/does not probe or guess one — previews are protected by default/);
    expect((await runBundle(ctx)).evidence[0]).toMatch(/never scans a URL it cannot attribute to this project/);
  });

  it('skips a guided host and a logged-out host without failing them', async () => {
    const guided = await runDeploy(previewSetup({ state: withRecordedPreview({}, 'fakeguided'), config: { stack: { ...FAKE_STACK, hosting: 'fakeguided' } } }).ctx);
    expect(guided.status).toBe('skip');
    expect(guided.evidence[0]).toMatch(/guided and cannot report its URLs/);
    const out = await runDeploy(previewSetup({ state: withRecordedPreview(), arrange: (w) => (w.host.authed = false) }).ctx);
    expect(out).toEqual({ status: 'skip', severity: 'info', evidence: ['blocked by: login:fakehost'] });
  });

  it('skips a recording that belongs to another hosting provider', async () => {
    const r = await runDeploy(previewSetup({ state: withRecordedPreview(), config: { stack: { hosting: 'netlify', db: 'fakedb' } } }).ctx);
    expect(r.status).toBe('skip');
    expect(r.evidence[0]).toMatch(/belongs to fakehost, not to the chosen hosting provider \(netlify\)/);
  });

  it('warns when the provider reports a different preview deployment than the recorded one', async () => {
    const r = await runDeploy(previewSetup({ state: withRecordedPreview(), arrange: (w) => (w.host.urls.preview = 'https://shop-other.fakehost.app') }).ctx);
    expect(r.status).toBe('warn');
    expect(r.evidence.join('\n')).toMatch(/reports https:\/\/shop-other\.fakehost\.app for the preview target, while golive recorded/);
    expect(r.fix).toMatch(/Run `golive plan` and apply the preview steps/);
  });

  it('fails when the "preview" is the production deployment', async () => {
    const r = await runDeploy(previewSetup({ state: withRecordedPreview({ 'deployed:production': PREVIEW_AT, 'deployed:production:id': `fakehost|dpl_prod|${PREVIEW_URL}|${PREVIEW_AT}` }) }).ctx);
    expect(r).toEqual(expect.objectContaining({ status: 'fail', severity: 'high' }));
    expect(r.evidence.join('\n')).toContain(`golive recorded ${PREVIEW_URL} as both the preview deployment (fakehost deployment dpl_prev) and the production deployment it made`);
  });

  it('preview-bundle skips a protected preview (401) with the reason, never as a pass', async () => {
    const protectedPage = mockHttp([['GET', `${PREVIEW_URL}/`, () => ({ status: 401, text: '<html>protected</html>' })]]);
    const { ctx } = previewSetup({ state: withRecordedPreview(), http: protectedPage.http });
    const r = await runBundle(ctx);
    expect(r.status).toBe('skip');
    expect(r.evidence.join('\n')).toContain(`GET ${PREVIEW_URL}/ → HTTP 401: the preview deployment is behind a protection wall`);
    expect(r.evidence.join('\n')).toMatch(/a protected preview is not a finding, and this is not a pass/);
  });

  it('preview-bundle fails a leaked key in the preview bundle without printing it', async () => {
    const KEY = 'sk_' + 'live_' + 'Y7'.repeat(12);
    const leaky = mockHttp([
      ['GET', `${PREVIEW_URL}/`, () => ({ text: '<script src="/a.js"></script>' })],
      ['GET', `${PREVIEW_URL}/a.js`, () => ({ text: `const k="${KEY}"` })],
    ]);
    const { ctx } = previewSetup({ state: withRecordedPreview(), http: leaky.http });
    const r = await runBundle(ctx);
    expect(r.status).toBe('fail');
    expect(r.severity).toBe('critical');
    expect(r.evidence.join('\n')).toMatch(/Stripe secret key \(live\) in \/a\.js \(fp:/);
    expect(JSON.stringify(r)).not.toContain(KEY);
  });

  it('preview-bundle passes only a complete clean scan of the provider-confirmed preview', async () => {
    const clean = mockHttp([
      ['GET', `${PREVIEW_URL}/`, () => ({ text: '<script src="/a.js"></script>' })],
      ['GET', `${PREVIEW_URL}/a.js`, () => ({ text: 'const ok=1' })],
    ]);
    const { ctx } = previewSetup({ state: withRecordedPreview(), http: clean.http });
    const r = await runBundle(ctx);
    expect(r.status).toBe('pass');
    expect(r.evidence).toEqual([
      `scanned 2 file(s) from ${PREVIEW_URL}`,
      'no credential patterns found',
      `fakehost reports ${PREVIEW_URL} for the preview deployment golive recorded (dpl_prev); a preview that is protected or unreachable is never treated as clean`,
    ]);
  });
});

describe('preview state is teardown-safe', () => {
  it('uses the deployed:* family only, which teardown forgets with the removed project', async () => {
    const { ctx } = previewSetup();
    await apply(ctx, await build(ctx));
    expect(ctx.state.resource('deployed:preview:id')).toBeDefined();
    // One machine-readable key family: the preview deploy records nothing of its own shape (every other
    // preview-named key is an ordinary per-target env source).
    const keys = Object.keys(ctx.state.get().resources);
    expect(keys).toContain('deployed:preview');
    expect(keys).toContain('deployed:preview:id');
    expect(keys.filter((k) => k.includes('preview') && !k.endsWith('@preview') && !k.startsWith('deployed:preview'))).toEqual([]);
    expect(ctx.state.get().secrets['STRIPE_SECRET_KEY@preview']?.fp).toBeTruthy();

    forgetDeployFacts(ctx);
    for (const key of ['deployed:preview', 'deployed:preview:id', 'deployed:production', 'deployed:production:id']) expect(ctx.state.resource(key), key).toBeUndefined();
    expect(ctx.state.get().steps['preview:deploy']).toBeUndefined();
    expect(ctx.state.get().steps['release:check']?.status).toBe('done'); // other step evidence stays
    expect(ctx.state.get().secrets['STRIPE_SECRET_KEY@preview']?.fp).toBeTruthy();
  });
});

// ── Promotion and rollback: re-pointing production at a deployment golive recorded ────────────────

const PROD_AT = '2026-01-01T00:00:00.000Z';
const PROD_ID = 'dpl_fake1';
const PROD_URL = 'https://shop-abc123.fakehost.app';
const OLD_ID = 'dpl_older';
const OLD_URL = 'https://shop-older.fakehost.app';
const OLD_AT = '2025-12-01T00:00:00.000Z';
const OLDER_RELEASE: ReleaseIdentity = { ...TEST_RELEASE, version: '0.1.0-alpha.1-old', bundleDigest: 'c'.repeat(64) };

const deployInfo = (id: string, url: string): DeploymentInfo => ({ id, url, ready: true });
const record = (target: 'preview' | 'production', id: string, url: string, at: string, production = true) => ({ target, provider: 'fakehost', id, url, at, production });

/** A recorded production deployment, then a preview deployment golive made after it. */
function releaseState(): ShipState {
  return stateWith([], {
    'deployed:production': PROD_AT,
    'deployed:production:id': `fakehost|${PROD_ID}|${PROD_URL}|${PROD_AT}`,
    'deployed:preview': PREVIEW_AT,
    'deployed:preview:id': `fakehost|${PREVIEW_ID}|${PREVIEW_URL}|${PREVIEW_AT}`,
    'deployed:history': JSON.stringify([record('preview', PREVIEW_ID, PREVIEW_URL, PREVIEW_AT, false), record('production', PROD_ID, PROD_URL, PROD_AT)]),
  });
}

/** Two recorded production deployments: what a rollback goes back to, and what production serves now. */
function rollbackState(): ShipState {
  return stateWith([], {
    'deployed:production': PROD_AT,
    'deployed:production:id': `fakehost|${PROD_ID}|${PROD_URL}|${PROD_AT}`,
    'deployed:history': JSON.stringify([record('production', PROD_ID, PROD_URL, PROD_AT), record('production', OLD_ID, OLD_URL, OLD_AT)]),
  });
}

const withStepRecord = (state: ShipState, id: string, rec: StepRecord): ShipState => ({ ...state, steps: { ...state.steps, [id]: rec } });

/**
 * A hosting-only stack with the release opt-ins set and a host that reports what production serves,
 * can re-read its deployments and can re-point production at one.
 */
function releaseSetup(kind: 'promote' | 'rollback', opts: Parameters<typeof setup>[0] = {}) {
  const state = opts.state ?? (kind === 'promote' ? releaseState() : rollbackState());
  return setup({
    ...opts,
    env: opts.env ?? [],
    exec: opts.exec ?? [['git rev-parse', { stdout: 'main\n' }]],
    state,
    config: {
      stack: { hosting: 'fakehost' },
      domain: undefined,
      release: kind === 'promote' ? { preview: true, promote: true } : { rollback: true },
      ...opts.config,
    },
    arrange: (w) => {
      w.host.urls.preview = PREVIEW_URL;
      for (const [id, url] of [[PROD_ID, PROD_URL], [PREVIEW_ID, PREVIEW_URL], [OLD_ID, OLD_URL]] as const) w.host.release.deploys.set(id, deployInfo(id, url));
      w.host.release.production = deployInfo(PROD_ID, PROD_URL);
      opts.arrange?.(w);
    },
  });
}

/** The checks an apply of the release steps needs registered (the pre-points verify with this one). */
const releaseChecks = () => new Map<string, Check>([['production-release', productionReleaseCheck]]);

describe('release opt-ins', () => {
  it('plans no promotion and no rollback until its own opt-in is set', async () => {
    for (const release of [undefined, {}, { preview: false }, { preview: true }]) {
      const { ctx } = setup({ config: { stack: { hosting: 'fakehost' }, domain: undefined, release }, env: [], state: releaseState() });
      const plan = await build(ctx);
      expect(ids(plan), JSON.stringify(release)).not.toContain('promote:production');
      expect(ids(plan)).not.toContain('release:rollback');
    }
  });

  it('refuses a promotion without the preview opt-in, and a release together with a rollback', async () => {
    const noPreview = await build(setup({ config: { stack: { hosting: 'fakehost' }, domain: undefined, release: { promote: true } }, env: [], state: releaseState() }).ctx);
    expect(ids(noPreview)).not.toContain('promote:production');
    expect(noPreview.warnings.join('\n')).toMatch(/release\.promote is set, but release\.preview is not/);

    const both = await build(setup({ config: { stack: { hosting: 'fakehost' }, domain: undefined, release: { preview: true, promote: true, rollback: true } }, env: [], state: releaseState() }).ctx);
    expect(ids(both)).not.toContain('promote:production');
    expect(ids(both)).not.toContain('release:rollback');
    expect(both.warnings.join('\n')).toMatch(/will not plan a release and a rollback of the same app in one plan/);
  });

  it('says why no promotion is planned when the host exposes no release capability (Vercel’s case)', async () => {
    const { ctx } = releaseSetup('promote', { arrange: (w) => (w.host.release.available = false) });
    const plan = await build(ctx);
    // Nothing the release link can do is planned — but the warning says what is missing, not silence.
    expect(ids(plan)).toEqual(['project:hosting']);
    expect(plan.warnings.join('\n')).toMatch(/release\.promote is set, but golive cannot re-point production on fakehost.*no promotion is planned/);

    // The preview machinery still works on that host: a failed check cuts a fresh preview, and only
    // the promotion stays unplanned.
    const retryState = withStepRecord(releaseState(), 'release:check', { status: 'failed', at: PREVIEW_AT, planId: 'previous-plan' });
    const { ctx: retryCtx } = releaseSetup('promote', { state: retryState, arrange: (w) => (w.host.release.available = false) });
    const retry = await build(retryCtx);
    expect(ids(retry)).toEqual(['project:hosting', 'preview:deploy', 'release:check']);
    expect(retry.warnings.join('\n')).toMatch(/no promotion is planned/);
  });
});

describe('promote:production', () => {
  it('is planned after the gate, naming the exact deployment, env target and production it changes', async () => {
    const { ctx } = releaseSetup('promote');
    const plan = await build(ctx);
    expect(ids(plan)).toEqual(['project:hosting', 'release:check', 'promote:production']);

    const gate = byId(plan, 'release:check');
    expect(gate.risk).toEqual({ writes: false });
    expect(gate.dependsOn).toEqual(['project:hosting']);
    expect(gate.preview.join('\n')).toContain(`check the preview deployment golive recorded (fakehost ${PREVIEW_ID}, ${PREVIEW_URL}, recorded ${PREVIEW_AT}) on FakeHost`);
    expect(gate.preview.join('\n')).toMatch(/this check gates promote:production in this plan: it re-reads the exact deployment that step would make production/);

    const promote = byId(plan, 'promote:production');
    expect(promote.kind).toBe('deploy');
    // A production re-point: a write, and nothing else — no live/destroy/replayable category flag.
    expect(promote.risk).toEqual({ writes: true });
    expect(promote.dependsOn).toEqual(['release:check', 'project:hosting']);
    expect(promote.verifyWith).toEqual(['production-release']);
    const pv = promote.preview.join('\n');
    expect(pv).toContain(`promote fakehost deployment ${PREVIEW_ID} to production: ${PREVIEW_URL} (recorded by golive ${PREVIEW_AT}) becomes what FakeHost serves publicly`);
    expect(pv).toContain('project: FakeHost project shop (prj_1)');
    expect(pv).toContain('that deployment was built for the preview env target and keeps the env it was built with');
    expect(pv).toContain(`production before this promotion: fakehost deployment ${PROD_ID} (${PROD_URL}, recorded by golive ${PROD_AT})`);
    expect(pv).toMatch(/gated by release:check in this plan: the provider's own read of that exact deployment/);
    expect(pv).toMatch(/before writing, this step re-reads the deployment and what FakeHost serves as production; after writing it re-reads production and records what it serves now/);
    expect(pv).toMatch(/production will change: the app's production URL is served by that deployment/);
    expect(pv).toMatch(/golive promotes only a deployment it created and recorded/);
    // The approval is the plan id and the gate: no `--confirm-*` flag is added for a re-point.
    expect(planView(plan).steps.find((s) => s.id === 'promote:production')!.needs).toEqual([]);
    expect(plan.warnings).toEqual([]);
    expectNoRawSecrets([JSON.stringify(planView(plan)), ...ctx.logs]);
  });

  it('names the case where golive recorded no production deployment at all', async () => {
    const state = stateWith([], {
      'deployed:preview': PREVIEW_AT,
      'deployed:preview:id': `fakehost|${PREVIEW_ID}|${PREVIEW_URL}|${PREVIEW_AT}`,
      'deployed:history': JSON.stringify([record('preview', PREVIEW_ID, PREVIEW_URL, PREVIEW_AT, false)]),
    });
    const { ctx } = releaseSetup('promote', { state, arrange: (w) => (w.host.release.production = null) });
    const pv = byId(await build(ctx), 'promote:production').preview.join('\n');
    expect(pv).toContain('production before this promotion: golive recorded no production deployment; this step reads what the provider says it serves now');
  });

  it('re-points production, records the release and proves what production serves with the check', async () => {
    const { w, ctx } = releaseSetup('promote');
    const out = await apply(ctx, await build(ctx), releaseChecks());
    expect(out.map((o) => [o.id, o.status])).toEqual([['project:hosting', 'done'], ['release:check', 'done'], ['promote:production', 'done']]);
    expect(w.host.release.promoted).toEqual([PREVIEW_ID]);
    // The order is the proof: both sides are re-read before the write, and production afterwards.
    expect(w.calls.filter((c) => c.method.startsWith('release.')).map((c) => `${c.method}:${String(c.args[0] ?? '')}`)).toEqual([
      'release.read:dpl_fake1_preview',
      'release.production:',
      'release.promote:dpl_fake1_preview',
      'release.production:',
      // The recorded release is proved by the provider's own read again, in the check.
      'release.production:',
    ]);
    const step = out.find((o) => o.id === 'promote:production')!;
    expect(step.changes.join('\n')).toContain(`promoted fakehost ${PREVIEW_ID} as production: ${PREVIEW_URL}`);
    expect(step.changes.join('\n')).toContain(`FakeHost reported production serving ${PROD_ID} before the write and ${PREVIEW_ID} after it`);
    // The record: the release, the production pointer, and the deployment's own history entry.
    const released = readRelease(ctx)!;
    expect(released).toMatchObject({ kind: 'promote', provider: 'fakehost', id: PREVIEW_ID, url: PREVIEW_URL, displaced: PROD_ID });
    expect(ctx.state.resource('deployed:production:id')).toBe(`fakehost|${PREVIEW_ID}|${PREVIEW_URL}|${ctx.state.resource('deployed:production')}`);
    const history = readDeployHistory(ctx);
    expect(history[0]).toMatchObject({ id: PREVIEW_ID, target: 'preview', production: true });
    expect(history.map((e) => e.id)).toEqual([PREVIEW_ID, PROD_ID]);
    // The proof: the provider's own read, naming what production served before.
    expect(step.checks.map((c) => [c.id, c.status])).toEqual([['production-release', 'pass']]);
    expect(step.checks[0]!.evidence.join('\n')).toContain(`fakehost deployment ${PREVIEW_ID} (${PREVIEW_URL}) is what fakehost reports for production now`);
    expect(step.checks[0]!.evidence.join('\n')).toContain(`golive recorded ${PROD_ID} as what production served before it`);
    expectNoRawSecrets([JSON.stringify(out), JSON.stringify(ctx.state.get()), ...ctx.logs]);
  });

  it('writes nothing and records no release when production already serves the deployment', async () => {
    const { w, ctx } = releaseSetup('promote', { arrange: (w) => (w.host.release.production = deployInfo(PREVIEW_ID, PREVIEW_URL)) });
    const out = await apply(ctx, await build(ctx), releaseChecks());
    const step = out.find((o) => o.id === 'promote:production')!;
    expect(step.status).toBe('done');
    expect(step.changes.join(' ')).toMatch(/already serves deployment .* nothing was written/);
    expect(w.host.release.promoted).toEqual([]);
    expect(readRelease(ctx)).toBeNull();
    expect(ctx.state.resource('deployed:production:id')).toContain(PROD_ID);
  });

  it.each([
    ['the provider no longer has the deployment', (w: FakeWorld) => void w.host.release.deploys.delete(PREVIEW_ID), /no longer has deployment fakehost dpl_fake1_preview .*nothing was written/],
    ['the provider reports it as not ready', (w: FakeWorld) => void w.host.release.deploys.set(PREVIEW_ID, { id: PREVIEW_ID, url: PREVIEW_URL, ready: false }), /reports deployment dpl_fake1_preview as not ready/],
    ['the provider read fails', (w: FakeWorld) => void (w.host.release.readError = 'FakeHost read failed'), /FakeHost read failed/],
    ['the provider exposes no re-point call', (w: FakeWorld) => void (w.host.release.canPromote = false), /exposes no call to point production at one/],
    ['the provider reports no production deployment', (w: FakeWorld) => void (w.host.release.production = null), /reports no deployment for production, so golive cannot read what this promote would replace: nothing was written/],
  ])('refuses to act blind when %s', async (_what, arrange, error) => {
    const { w, ctx } = releaseSetup('promote', { arrange: arrange as (w: FakeWorld) => void });
    const out = await apply(ctx, await build(ctx), releaseChecks());
    const step = out.find((o) => o.id === 'promote:production')!;
    expect(step.status).toBe('failed');
    expect(step.error).toMatch(error as RegExp);
    expect(w.host.release.promoted).toEqual([]);
    expect(readRelease(ctx)).toBeNull();
    expect(ctx.state.resource('deployed:production:id')).toContain(PROD_ID);
  });

  it('fails with nothing recorded when the provider does not confirm the switch', async () => {
    const { w, ctx } = releaseSetup('promote', { arrange: (w) => (w.host.release.promoteHasNoEffect = true) });
    const out = await apply(ctx, await build(ctx), releaseChecks());
    const step = out.find((o) => o.id === 'promote:production')!;
    expect(step.status).toBe('failed');
    expect(step.error).toMatch(/did not report deployment dpl_fake1_preview as what production serves after the write/);
    expect(w.host.release.promoted).toEqual([PREVIEW_ID]); // attempted once, never repeated
    expect(readRelease(ctx)).toBeNull();
    expect(ctx.state.get().steps['promote:production']?.status).toBe('failed');
    expectNoRawSecrets([JSON.stringify(out), JSON.stringify(ctx.state.get())]);
  });

  it('a failing gate stops the plan before production changes', async () => {
    const KEY = 'sk_' + 'live_' + 'Q4'.repeat(12);
    const leaky = mockHttp([
      ['GET', `${PREVIEW_URL}/`, () => ({ text: '<script src="/a.js"></script>' })],
      ['GET', `${PREVIEW_URL}/a.js`, () => ({ text: `const k="${KEY}"` })],
    ]);
    const { w, ctx } = releaseSetup('promote', { http: leaky.http });
    const out = await apply(ctx, await build(ctx), previewChecks());
    expect(out.map((o) => o.id)).toEqual(['project:hosting', 'release:check']);
    expect(out.find((o) => o.id === 'release:check')!.status).toBe('failed');
    expect(w.host.release.promoted).toEqual([]);
    expect(ctx.state.get().steps['promote:production']).toBeUndefined();
    expect(JSON.stringify(out)).not.toContain(KEY);
  });
});

describe('release:rollback', () => {
  it('plans a rollback of the previous production deployment from golive’s own record', async () => {
    const { ctx } = releaseSetup('rollback');
    const plan = await build(ctx);
    expect(ids(plan)).toEqual(['project:hosting', 'release:rollback']);
    const step = byId(plan, 'release:rollback');
    expect(step.kind).toBe('deploy');
    // A production re-point keeps the reconciliation stop: never `destroy`, never `replayable`.
    expect(step.risk).toEqual({ writes: true });
    expect(step.risk.destroy).toBeUndefined();
    expect(step.risk.replayable).toBeUndefined();
    expect(step.dependsOn).toEqual(['project:hosting']);
    expect(step.verifyWith).toEqual(['production-release']);
    const pv = step.preview.join('\n');
    expect(pv).toContain(`roll production back to fakehost deployment ${OLD_ID}: ${OLD_URL} (built for the production env target, recorded by golive ${OLD_AT}) becomes what FakeHost serves again`);
    expect(pv).toContain('project: FakeHost project shop (prj_1)');
    expect(pv).toContain(`production now serves fakehost deployment ${PROD_ID} (${PROD_URL}, recorded by golive ${PROD_AT}) — this rollback replaces it`);
    expect(pv).toMatch(/golive rolls production back only to a deployment it created and recorded/);
    expect(pv).toMatch(/neither replayable nor a deletion/);
    expect(pv).toMatch(/never automatic/);
    expect(planView(plan).steps.find((s) => s.id === 'release:rollback')!.needs).toEqual([]);
    expectNoRawSecrets([JSON.stringify(planView(plan)), ...ctx.logs]);
  });

  it('re-points production, records the release and proves what production serves with the check', async () => {
    const { w, ctx } = releaseSetup('rollback');
    const out = await apply(ctx, await build(ctx), releaseChecks());
    expect(out.map((o) => [o.id, o.status])).toEqual([['project:hosting', 'done'], ['release:rollback', 'done']]);
    expect(w.host.release.promoted).toEqual([OLD_ID]);
    expect(w.calls.filter((c) => c.method.startsWith('release.')).map((c) => `${c.method}:${String(c.args[0] ?? '')}`)).toEqual([
      'release.read:dpl_older',
      'release.production:',
      'release.promote:dpl_older',
      'release.production:',
      // The recorded release is proved by the provider's own read again, in the check.
      'release.production:',
    ]);
    expect(readRelease(ctx)).toMatchObject({ kind: 'rollback', id: OLD_ID, url: OLD_URL, displaced: PROD_ID });
    expect(readDeployHistory(ctx).map((e) => e.id)).toEqual([OLD_ID, PROD_ID]);
    expect(ctx.state.get().steps['release:rollback']?.changes!.join(' ')).toMatch(/rolled production back to fakehost dpl_older/);
    const proof = out.find((o) => o.id === 'release:rollback')!.checks;
    expect(proof.map((c) => [c.id, c.status])).toEqual([['production-release', 'pass']]);
    expect(proof[0]!.evidence.join('\n')).toContain(`fakehost deployment ${OLD_ID} (${OLD_URL}) is what fakehost reports for production now`);
    expect(proof[0]!.evidence.join('\n')).toContain(`golive recorded ${PROD_ID} as what production served before it`);
    expectNoRawSecrets([JSON.stringify(out), JSON.stringify(ctx.state.get()), ...ctx.logs]);
  });

  it('does not offer the same rollback twice, and says what it already did', async () => {
    const { w, ctx } = releaseSetup('rollback');
    await apply(ctx, await build(ctx), releaseChecks());
    const reported = w.host.release.promoted.length;
    const plan = await build(ctx);
    expect(ids(plan)).toEqual(['project:hosting']);
    expect(plan.warnings.join('\n')).toMatch(/golive already rolled production back to dpl_older .*will not roll forward to dpl_fake1 on its own/);
    expect(w.host.release.promoted).toHaveLength(reported);
  });

  it('says so when there is nothing older to go back to', async () => {
    const state = stateWith([], {
      'deployed:production': PROD_AT,
      'deployed:production:id': `fakehost|${PROD_ID}|${PROD_URL}|${PROD_AT}`,
      'deployed:history': JSON.stringify([record('production', PROD_ID, PROD_URL, PROD_AT)]),
    });
    const { ctx } = releaseSetup('rollback', { state });
    const plan = await build(ctx);
    expect(ids(plan)).toEqual(['project:hosting']);
    expect(plan.warnings.join('\n')).toMatch(/holds no earlier production deployment to go back to/);
  });

  it('refuses without a recorded ability to re-point, and without a host release capability', async () => {
    const gone = releaseSetup('rollback', { arrange: (w) => w.host.release.deploys.delete(OLD_ID) });
    const out = await apply(gone.ctx, await build(gone.ctx), releaseChecks());
    expect(out.find((o) => o.id === 'release:rollback')).toMatchObject({ status: 'failed' });
    expect(out.find((o) => o.id === 'release:rollback')!.error).toMatch(/no longer has deployment fakehost dpl_older/);
    expect(gone.w.host.release.promoted).toEqual([]);

    const noCap = await build(releaseSetup('rollback', { arrange: (w) => (w.host.release.available = false) }).ctx);
    expect(ids(noCap)).toEqual(['project:hosting']);
    expect(noCap.warnings.join('\n')).toMatch(/release\.rollback is set, but golive cannot re-point production on fakehost/);

    // A repository that never had golive deploy production has nothing to roll back from.
    const never = await build(releaseSetup('rollback', { state: emptyState() }).ctx);
    expect(never.warnings.join('\n')).toMatch(/has no production deployment recorded on FakeHost/);
  });

  it.each(['promote', 'rollback'] as const)('a historical %s from an older release is refused, not re-pointed', async (kind) => {
    const stepId = kind === 'promote' ? 'promote:production' : 'release:rollback';
    const state = withStepRecord(kind === 'promote' ? releaseState() : rollbackState(), stepId, {
      status: 'failed',
      hash: 'older-approval',
      at: OLD_AT,
      planId: 'older-plan',
      release: OLDER_RELEASE,
    });
    const { w, ctx } = releaseSetup(kind, { state });
    const plan = await build(ctx);
    expect(ids(plan)).toContain(stepId);
    await expect(applyPlan(ctx, plan, new Map(), { approvedPlanId: plan.id, yes: true, confirmLive: true, confirmDns: true })).rejects.toThrow(
      /historical step .* belongs to another or unknown release.*automatic write replay is blocked/,
    );
    expect(w.host.release.promoted).toEqual([]);
    expect(readRelease(ctx)).toBeNull();
  });
});

describe('production-release check', () => {
  const run = (ctx: Ctx) => productionReleaseCheck.run(ctx);
  const withRelease = (kind: 'promote' | 'rollback', extra: Record<string, string> = {}): ShipState =>
    stateWith([], { ...releaseState().resources, 'deployed:release': [kind, 'fakehost', PREVIEW_ID, PREVIEW_URL, PROD_ID, PREVIEW_AT].join('|'), ...extra });

  it('passes when the provider reports the released deployment as what production serves', async () => {
    const { ctx } = releaseSetup('promote', { state: withRelease('promote'), arrange: (w) => (w.host.release.production = deployInfo(PREVIEW_ID, PREVIEW_URL)) });
    const r = await run(ctx);
    expect(r.status).toBe('pass');
    expect(r.evidence.join('\n')).toContain(`fakehost deployment ${PREVIEW_ID} (${PREVIEW_URL}) is what fakehost reports for production now`);
    expect(r.evidence.join('\n')).toContain('golive promoted to production it');
    expect(r.evidence.join('\n')).toContain(`golive recorded ${PROD_ID} as what production served before it`);
    expect(r.evidence.join('\n')).toContain(`recorded by golive ${PREVIEW_AT} (deployed:release)`);
  });

  it('names the rollback in the pass evidence too', async () => {
    const { ctx } = releaseSetup('rollback', { state: withRelease('rollback'), arrange: (w) => (w.host.release.production = deployInfo(PREVIEW_ID, PREVIEW_URL)) });
    expect((await run(ctx)).evidence.join('\n')).toContain('golive rolled production back to it');
  });

  it('skips without a recorded release, without the opt-in, without a provider read, and with no production deployment', async () => {
    // No `deployed:release`: nothing golive released.
    expect(await run(releaseSetup('promote').ctx)).toMatchObject({ status: 'skip' });
    expect((await run(releaseSetup('promote').ctx)).evidence[0]).toMatch(/has not promoted or rolled back a deployment/);
    // The opt-in gate at the check level: no release opt-in and no recorded release, no check.
    const plain = setup({ config: { stack: { hosting: 'fakehost' }, domain: undefined }, env: [], state: releaseState() }).ctx;
    expect(productionReleaseCheck.applies(plain)).toBe(false);
    // A recorded release keeps the check applicable after the flags are removed: the evidence is
    // re-read (read-only), so dropping the opt-in does not drop what already happened.
    const kept = setup({ config: { stack: { hosting: 'fakehost' }, domain: undefined }, env: [], state: withRelease('promote') }).ctx;
    expect(productionReleaseCheck.applies(kept)).toBe(true);
    // A host that cannot answer the read: skipped with the reason, never a pass.
    const noCap = await run(releaseSetup('promote', { state: withRelease('promote'), arrange: (w) => (w.host.release.available = false) }).ctx);
    expect(noCap.status).toBe('skip');
    expect(noCap.evidence[0]).toMatch(/exposes no read of what production serves, so the deployment golive promoted to production .*this is not a pass/);
    // A provider that reports no production deployment at all.
    const none = await run(releaseSetup('promote', { state: withRelease('promote'), arrange: (w) => (w.host.release.production = null) }).ctx);
    expect(none.status).toBe('skip');
    expect(none.evidence[0]).toMatch(/reports no production deployment, so the deployment golive promoted to production .* is unverified/);
    // A recording that belongs to another hosting provider.
    const other = await run(releaseSetup('promote', { state: withRelease('promote'), config: { stack: { hosting: 'netlify' }, domain: undefined } }).ctx);
    expect(other.evidence[0]).toMatch(/belongs to fakehost, not to the chosen hosting provider \(netlify\)/);
  });

  it('fails when production serves another deployment golive recorded', async () => {
    const { ctx } = releaseSetup('promote', { state: withRelease('promote'), arrange: (w) => (w.host.release.production = deployInfo(PROD_ID, PROD_URL)) });
    const r = await run(ctx);
    expect(r).toMatchObject({ status: 'fail', severity: 'high' });
    expect(r.evidence.join('\n')).toContain(`while golive promoted to production ${PREVIEW_ID} (fakehost deployment ${PREVIEW_ID})`);
    expect(r.evidence.join('\n')).toContain(`${PROD_ID} is in golive's own record too, so production moved after that release`);
    expect(r.fix).toMatch(/Run `golive plan` and apply the release step it shows/);
  });

  it('warns — and names the handoff — when production serves a deployment golive never recorded', async () => {
    const { ctx } = releaseSetup('promote', {
      state: withRelease('promote'),
      arrange: (w) => (w.host.release.production = deployInfo('dpl_elsewhere', 'https://shop-elsewhere.fakehost.app')),
    });
    const r = await run(ctx);
    expect(r).toMatchObject({ status: 'warn', severity: 'medium' });
    expect(r.evidence.join('\n')).toMatch(/never recorded that deployment: it was built by fakehost's dashboard, a Git push or a pull request/);
    expect(r.fix).toMatch(/golive promotes and rolls back only deployments it recorded and does not touch one it did not create/);
  });

  it('warns when the provider read fails, rather than claiming anything about production', async () => {
    const { ctx } = releaseSetup('promote', { state: withRelease('promote'), arrange: (w) => (w.host.release.readError = 'FakeHost read failed') });
    const r = await run(ctx);
    expect(r).toMatchObject({ status: 'warn', severity: 'medium' });
    expect(r.evidence.join('\n')).toMatch(/could not read what fakehost serves as production: FakeHost read failed/);
  });

  it('no longer fails the preview gate once golive itself promoted that deployment', async () => {
    // After a promotion the recorded preview deployment IS what production serves: the preview gate
    // says so instead of reading it as a mis-recorded preview.
    const { ctx } = releaseSetup('promote', { state: withRelease('promote'), arrange: (w) => (w.host.release.production = deployInfo(PREVIEW_ID, PREVIEW_URL)) });
    const r = await previewDeployCheck.run(ctx);
    expect(r.status).toBe('skip');
    expect(r.evidence[0]).toMatch(/golive promoted fakehost deployment dpl_fake1_preview .* there is no unreleased preview to gate/);
  });
});

describe('deployment history', () => {
  it('records every deployment, newest first, and stays bounded', () => {
    const { ctx } = setup();
    for (let i = 0; i < 12; i++) recordDeploy(ctx, 'fakehost', i % 3 === 0 ? 'production' : 'preview', { url: `https://shop-${i}.fakehost.app`, id: `dpl_${i}` });
    const history = readDeployHistory(ctx);
    expect(history).toHaveLength(8);
    expect(history.map((e) => e.id)).toEqual(['dpl_11', 'dpl_10', 'dpl_9', 'dpl_8', 'dpl_7', 'dpl_6', 'dpl_5', 'dpl_4']);
    expect(history[0]).toMatchObject({ provider: 'fakehost', target: 'preview', production: false });
    expect(history.find((e) => e.id === 'dpl_9')).toMatchObject({ target: 'production', production: true });
    // A provider that reports no id records no identity: nothing enters the history.
    recordDeploy(ctx, 'fakehost', 'preview', { url: 'https://shop-x.fakehost.app' });
    expect(readDeployHistory(ctx)[0]!.id).toBe('dpl_11');
  });

  it('replaces its own record of a deployment instead of duplicating it, keeping what it reached', () => {
    const { ctx } = setup({ state: releaseState() });
    // The same deployment recorded again (a promotion records the deployment the preview deploy made).
    recordDeploy(ctx, 'fakehost', 'preview', { url: PROD_URL, id: PROD_ID });
    const history = readDeployHistory(ctx);
    expect(history.filter((e) => e.id === PROD_ID)).toHaveLength(1);
    expect(history.find((e) => e.id === PROD_ID)).toMatchObject({ target: 'preview', production: true });
  });

  it('reads the deployment production served before the recorded one', () => {
    const history = readDeployHistory(releaseSetup('rollback').ctx);
    expect(previousProductionDeploy(history, { provider: 'fakehost', id: PROD_ID })).toMatchObject({ id: OLD_ID });
    // A pointer golive has no record of, and a history with nothing older, both yield no target.
    expect(previousProductionDeploy(history, { provider: 'fakehost', id: 'dpl_unknown' })).toMatchObject({ id: PROD_ID });
    expect(previousProductionDeploy([history[0]!], { provider: 'fakehost', id: PROD_ID })).toBeNull();
  });

  it('is unreadable history, not a crash: a value that does not parse is no history', () => {
    const { ctx } = setup({ state: stateWith([], { 'deployed:history': 'not json' }) });
    expect(readDeployHistory(ctx)).toEqual([]);
    const broken = setup({ state: stateWith([], { 'deployed:history': JSON.stringify([{ id: 'x' }, record('production', PROD_ID, PROD_URL, PROD_AT)]) }) }).ctx;
    expect(readDeployHistory(broken).map((e) => e.id)).toEqual([PROD_ID]);
  });

  it('teardown forgets the history and the release record with the project it belonged to', async () => {
    const { ctx } = releaseSetup('promote');
    await apply(ctx, await build(ctx), releaseChecks());
    expect(readRelease(ctx)).not.toBeNull();
    expect(readDeployHistory(ctx)).toHaveLength(2);
    forgetDeployFacts(ctx);
    expect(ctx.state.resource('deployed:history')).toBeUndefined();
    expect(ctx.state.resource('deployed:release')).toBeUndefined();
    expect(readRelease(ctx)).toBeNull();
    expect(readDeployHistory(ctx)).toEqual([]);
    // The recorded environment facts of the same project are untouched, like every other key.
    expect(ctx.state.get().steps['release:check']?.status).toBe('done');
  });
});

// ── Regression tests for review findings ────────────────────────────────────────────────────────────
const DEPLOYED = { 'deployed:production': '2026-01-01T00:00:00.000Z' };
const stub = (id: string, status: 'pass' | 'fail' = 'pass'): Check => ({ id, title: id, severity: 'high', applies: () => true, run: async () => ({ status, severity: 'info', evidence: [] }) });

describe('per-step verification (env-parity no longer deadlocks apply)', () => {
  it('golden path completes in ONE approved apply with the real env-parity check registered', async () => {
    const { ctx } = setup();
    const checks = new Map<string, Check>([
      ['env-parity', envParityCheck],
      ...['auth-redirects', 'webhook-registered', 'email-dns', 'email-verified', 'bundle-secrets', 'webhook-unsigned', 'domain-live'].map((id) => [id, stub(id)] as [string, Check]),
    ]);
    const plan = await build(ctx);
    const out = await applyPlan(ctx, plan, checks, { approvedPlanId: plan.id, yes: true, confirmLive: true, confirmDns: true });
    expect(out.map((o) => [o.id, o.status])).toEqual(plan.steps.map((st) => [st.id, 'done']));
    expect(out.flatMap((o) => o.checks).some((c) => c.id === 'env-parity')).toBe(false);
  });

  it('fails an env step only when a name IT wrote is missing afterwards', async () => {
    const { w, ctx } = setup({
      config: { stack: { hosting: 'fakehost', db: 'fakedb' } },
      arrange: (x) => {
        const env = x.adapters.find((a) => a.id === 'fakehost')!.capabilities.env!;
        const set = env.set;
        env.set = async (c, name, value, targets, o) => (name === 'DATABASE_URL' ? undefined : set(c, name, value, targets, o)); // host silently drops it
      },
    });
    const out = await apply(ctx, await build(ctx));
    const failed = out.find((o) => o.status === 'failed')!;
    expect(failed.id).toBe('env:preview');
    const c = failed.checks.find((x) => x.id === 'env:preview:env-written')!;
    expect(c.status).toBe('fail');
    expect(c.evidence.join(' ')).toMatch(/still missing after the write: DATABASE_URL/);
    expect(c.evidence.join(' ')).not.toMatch(/production/); // other targets are not this step's business
    expect(w.host.env.preview.has('NEXT_PUBLIC_SUPABASE_URL')).toBe(true);
  });
});

describe('redeploy bookkeeping (state, not the plan)', () => {
  const small = { stack: { hosting: 'fakehost', db: 'fakedb' }, domain: undefined } as Partial<ShipConfig>;

  it('redeploys after a later env change instead of skipping deploy:production as "already done"', async () => {
    const { w, ctx } = setup({ config: small, env: ['NEXT_PUBLIC_SUPABASE_URL'], state: stateWith([], DEPLOYED) });
    const p1 = await build(ctx);
    expect(ids(p1)).toContain('deploy:production');
    await apply(ctx, p1);
    expect(w.host.deploys).toBe(1);

    ctx.detect.envRefs.push({ name: 'SUPABASE_SERVICE_ROLE_KEY', files: ['src/lib.ts'], clientExposed: false });
    const p2 = await build(ctx);
    expect(ids(p2)).toEqual(['project:hosting', 'project:db', 'env:preview', 'env:production', 'deploy:production']);
    expect(byId(p2, 'deploy:production').preview.join('\n')).toMatch(/last successful golive deploy: 20/);
    const out = await apply(ctx, p2);
    expect(out.find((o) => o.id === 'deploy:production')?.status).toBe('done');
    expect(w.host.deploys).toBe(2);
  });

  it('keeps planning the deploy after it failed, and stops once it succeeds', async () => {
    const { w, ctx } = setup({ config: small, env: ['NEXT_PUBLIC_SUPABASE_URL'], state: stateWith([], DEPLOYED), arrange: (x) => (x.host.deployError = 'build failed: missing module') });
    const out1 = await apply(ctx, await build(ctx));
    expect(out1.find((o) => o.id === 'deploy:production')?.status).toBe('failed');
    expect(ctx.state.get().resources['redeploy:production']).toBeDefined(); // env written, not deployed

    const p2 = await build(ctx);
    expect(ids(p2)).toEqual(['project:hosting', 'project:db', 'deploy:production']); // env steps are done; the deploy is not
    const pv = byId(p2, 'deploy:production').preview.join('\n');
    expect(pv).toMatch(/production env changed at .* no deploy has picked it up yet/);
    expect(pv).toMatch(/the last production deploy failed/);
    expect((await apply(ctx, p2)).find((o) => o.id === 'deploy:production')?.status).toBe('done');
    expect(w.host.deploys).toBe(1);
    expect(ctx.state.get().resources['redeploy:production']).toBeUndefined();
    expect(ids(await build(ctx))).not.toContain('deploy:production');
  });

  it('does not treat a host URL as proof of a deployment, nor point webhooks at it before one', async () => {
    // FakeHost reports a production URL (like Vercel's <name>.vercel.app fallback), but golive never deployed.
    const { ctx } = setup({ config: { domain: undefined }, env: ['STRIPE_SECRET_KEY', 'NEXT_PUBLIC_SITE_URL'] });
    const plan = await build(ctx);
    expect(byId(plan, 'deploy:production').preview.join('\n')).toMatch(/golive has not deployed production yet/);
    expect(ids(plan)).not.toContain('payments:webhook:production');
    expect(ids(plan)).not.toContain('auth:redirects');
    expect(ids(plan)).not.toContain('env:production'); // NEXT_PUBLIC_SITE_URL waits for a real URL
    expect(plan.warnings.join('\n')).toMatch(/NEXT_PUBLIC_SITE_URL \(production\): the production URL isn't known until golive has deployed production once/);
    expect(plan.warnings.join('\n')).toMatch(/golive hasn't deployed production yet, so the host's URL isn't confirmed/);
  });

  it('once deployed, a domain attach neither waits for nor forces a deploy', async () => {
    const { ctx } = setup({ state: stateWith([], DEPLOYED) });
    const plan = await build(ctx);
    expect(byId(plan, 'domain:attach').dependsOn).not.toContain('deploy:production');
    expect(byId(plan, 'deploy:production').dependsOn).not.toContain('domain:attach');
    expect(byId(plan, 'deploy:production').dependsOn).toContain('payments:webhook:production');
    expect(byId(plan, 'deploy:production').verifyWith).toEqual(['bundle-secrets', 'webhook-unsigned']);
    expect(ids(plan)).not.toContain('deploy:production:final');
  });
});

describe('domain verification', () => {
  it('verifies the records domain:dns wrote from the zone, not by fetching the site over HTTPS', async () => {
    const { ctx } = setup({ state: stateWith([], DEPLOYED), arrange: (x) => (x.dns.hideRecords = true) });
    const plan = await build(ctx);
    expect(byId(plan, 'domain:dns').verifyWith).toEqual([]);
    const out = await apply(ctx, plan);
    const dns = out.find((o) => o.id === 'domain:dns')!;
    expect(dns.status).toBe('failed');
    expect(dns.checks[0]).toMatchObject({ id: 'domain:dns:records', status: 'fail' });
  });

  it('asks the host to verify ownership, and asks again on the next plan while still pending', async () => {
    const { w, ctx } = setup({ state: stateWith([], DEPLOYED) });
    const p1 = await build(ctx);
    expect(byId(p1, 'domain:verify').preview[0]).toMatch(/verify ownership of example\.com .* moves it to this project/);
    await apply(ctx, p1);
    expect(w.calls.filter((c) => c.method === 'domain.verify')).toHaveLength(1);
    const p2 = await build(ctx); // status still 'pending'
    expect(byId(p2, 'domain:verify').preview.join('\n')).toMatch(/previous request: 20/);
    await apply(ctx, p2);
    expect(w.calls.filter((c) => c.method === 'domain.verify')).toHaveLength(2);
  });

  it('accepts the zone serving a record in its own format (quoted TXT, trailing dots, merged SPF)', async () => {
    const { ctx } = setup({
      state: stateWith([], DEPLOYED),
      arrange: (x) => {
        x.host.records = [
          { type: 'CNAME', name: 'www.example.com', content: 'cname.fakehost-dns.com' },
          { type: 'TXT', name: '_fakehost.example.com', content: 'fh-verify=abc123' },
          { type: 'TXT', name: 'example.com', content: 'v=spf1 include:fakehost.com ~all' },
        ];
        const zone = x.adapters.find((a) => a.id === 'fakedns')!.capabilities.dns!;
        zone.list = async () => [
          { type: 'CNAME', name: 'WWW.example.com.', content: 'cname.fakehost-dns.com.' },
          { type: 'TXT', name: '_fakehost.example.com', content: '"fh-verify=" "abc123"' },
          { type: 'TXT', name: 'example.com', content: '"v=spf1 include:mail.example include:fakehost.com -all"' },
        ];
      },
    });
    const out = await apply(ctx, await build(ctx));
    expect(out.find((o) => o.id === 'domain:dns')).toMatchObject({ status: 'done' });
  });

  it('plans no verify step for hosts without DomainAttach.verify', async () => {
    const { ctx } = setup({ arrange: (x) => (x.host.withDomainVerify = false) });
    expect(ids(await build(ctx))).not.toContain('domain:verify');
  });
});

describe('project destination is part of the approved plan', () => {
  it('a different linked project changes the plan id', async () => {
    const a = await build(setup().ctx);
    const b = await build(setup({ arrange: (w) => (w.host.current = { id: 'prj_staging', name: 'shop-staging' }) }).ctx);
    expect(b.id).not.toBe(a.id);
    expect(byId(b, 'project:hosting').preview[0]).toMatch(/FakeHost project shop-staging \(prj_staging\)/);
  });

  it('refuses at apply time if the linked project changed after approval, before any write', async () => {
    const { w, ctx } = setup();
    const plan = await build(ctx);
    w.host.current = { id: 'prj_other', name: 'other' }; // e.g. the agent ran a link command meanwhile
    const out = await apply(ctx, plan);
    expect(out[0]).toMatchObject({ id: 'project:hosting', status: 'failed' });
    expect(out[0]!.error).toMatch(/changed since the plan was approved \(planned shop \(prj_1\), now other \(prj_other\)\)/);
    expect(w.host.env.preview.size + w.host.env.production.size).toBe(0);
  });

  it('pins the project in state and warns when golive.yaml names a different one', async () => {
    const { w, ctx } = setup({ config: { projects: { hosting: 'legacy' } } });
    const plan = await build(ctx);
    expect(plan.warnings.join('\n')).toMatch(/projects\.hosting is "legacy", but this repo is already linked to FakeHost project shop \(prj_1\)/);
    await apply(ctx, plan);
    expect(w.calls.find((c) => c.method === 'project.select')?.args).toEqual(['prj_1']);
  });

  it('lists existing projects in the create step', async () => {
    const { ctx } = setup({
      arrange: (x) => {
        x.host.current = null;
        x.host.candidates = [
          { id: 'b', name: 'acme-web' },
          { id: 'a', name: 'acme-admin' },
        ];
      },
    });
    const pv = byId(await build(ctx), 'project:hosting').preview.join('\n');
    expect(pv).toMatch(/Create FakeHost project shop/);
    expect(pv).toMatch(/could be used instead: acme-admin, acme-web .*init --project hosting=<name>/);
  });
});

describe('auth preview redirects are opt-in', () => {
  it('adds preview patterns only with auth.previewRedirects, flagged as a production-allowlist risk', async () => {
    const { w, ctx } = setup({ config: { auth: { previewRedirects: true } } });
    const plan = await build(ctx);
    expect(byId(plan, 'auth:redirects').preview).toContain('add redirect URL https://shop-*.fakehost.app/** (preview deployments, auth.previewRedirects: true — widens the PRODUCTION allowlist to every host matching this pattern)');
    expect(plan.warnings.join('\n')).not.toMatch(/preview deployments are not added/);
    await apply(ctx, plan);
    expect(w.db.auth.redirectUrls).toContain('https://shop-*.fakehost.app/**');
  });
});

describe('webhook plan matches what apply does', () => {
  const URL_ = 'https://example.com/api/webhooks/stripe';

  it("previews adopting (and re-enabling) a human's endpoint at the same URL, and never claims it deleted it", async () => {
    const { w, ctx } = setup({ arrange: (x) => x.pay.endpoints.push({ id: 'we_h', url: URL_, events: ['invoice.paid'], enabled: false, mode: 'live', owned: false }) });
    const plan = await build(ctx);
    const pv = byId(plan, 'payments:webhook:production').preview;
    expect(pv[1]).toBe(`ensure live webhook endpoint we_h → ${URL_} (events: checkout.session.completed)`);
    expect(pv).toContain('endpoint we_h was not created by golive: its existing events are kept and missing ones added');
    expect(pv).toContain('re-enable endpoint we_h (currently disabled)');
    expect(pv.join('\n')).toMatch(/then leave we_h in place for you to delete/);
    const out = await apply(ctx, plan);
    const o = out.find((x) => x.id === 'payments:webhook:production')!;
    expect(o.status).toBe('done');
    expect(o.changes.join('\n')).toMatch(/the old endpoint we_h was left in place \(not created by golive\)/);
    expect(o.changes.join('\n')).not.toMatch(/old endpoint deleted/);
    expect(w.pay.deleted).toEqual([]);
  });

  it('says "old endpoint deleted" only when replace() deleted it', async () => {
    const { ctx } = setup({ arrange: (x) => x.pay.endpoints.push({ id: 'we_old', url: URL_, events: ['checkout.session.completed'], enabled: true, mode: 'live' }) });
    const plan = await build(ctx);
    expect(byId(plan, 'payments:webhook:production').preview.join('\n')).toMatch(/write its secret, then delete we_old$/m);
    const o = (await apply(ctx, plan)).find((x) => x.id === 'payments:webhook:production')!;
    expect(o.changes).toContain('replaced webhook endpoint we_old with we_1 (old endpoint deleted)');
  });

  it('refuses without writing when the matching endpoint changed between plan and apply', async () => {
    const { w, ctx } = setup();
    const plan = await build(ctx);
    expect(byId(plan, 'payments:webhook:production').preview[1]).toMatch(/^create live webhook endpoint/);
    w.pay.endpoints.push({ id: 'we_new', url: URL_, events: [], enabled: true, mode: 'live', owned: false });
    const out = await apply(ctx, plan);
    const o = out.find((x) => x.id === 'payments:webhook:production')!;
    expect(o.status).toBe('failed');
    expect(o.error).toMatch(/changed since the plan was approved \(planned: none, now: we_new\); nothing was changed/);
    expect(w.calls.some((c) => c.method === 'webhooks.ensure')).toBe(false);
  });
});

describe('env source identity', () => {
  it('rewrites managed db/auth vars when the db project changes', async () => {
    const { w, ctx } = setup({ config: { stack: { hosting: 'fakehost', db: 'fakedb' }, domain: undefined }, env: ['NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'], state: stateWith([], DEPLOYED) });
    await apply(ctx, await build(ctx));
    expect(ids(await build(ctx))).toEqual(['project:hosting', 'project:db']);
    w.db.current = { id: 'db_2', name: 'shop-v2' };
    const plan = await build(ctx);
    expect(byId(plan, 'env:production').preview).toContain('update (managed by golive) SUPABASE_SERVICE_ROLE_KEY ← supabase.secretKey from FakeDB (sensitive)');
    expect(byId(plan, 'env:production').preview).toContain('update (managed by golive) NEXT_PUBLIC_SUPABASE_URL ← supabase.url from FakeDB');
  });

  it('rewrites managed payment keys when the account/key behind them changes', async () => {
    const { w, ctx } = setup({ env: ['STRIPE_SECRET_KEY'], config: { domain: undefined, payments: undefined } });
    await apply(ctx, await build(ctx));
    expect(ids(await build(ctx))).not.toContain('payments:keys:production');
    w.pay.secretKeys.live = 'sk_' + 'live_FAKEotherACCOUNTkey9876543210zyxw';
    const plan = await build(ctx);
    expect(byId(plan, 'payments:keys:production').preview.slice(1)).toEqual(['update (managed by golive) STRIPE_SECRET_KEY ← stripe.secretKey (live mode) (sensitive)']);
    expectNoRawSecrets([JSON.stringify(planView(plan)), JSON.stringify(ctx.state.get())]);
    expect(JSON.stringify(ctx.state.get())).not.toContain('FAKEotherACCOUNT');
  });
});

describe('critical exposure findings block secret writes', () => {
  const inlined: Finding = {
    id: 'next-config-env-inlines-secret',
    severity: 'critical',
    title: 'next.config.js env inlines STRIPE_SECRET_KEY into the browser bundle',
    evidence: ['next.config.js: env.STRIPE_SECRET_KEY'],
    fix: 'Remove STRIPE_SECRET_KEY from next.config.js env.',
  };

  it('holds back the named secret and hands off, but still writes the rest', async () => {
    const { ctx } = setup({ findings: [inlined] });
    const plan = await build(ctx);
    const h = plan.handoffs.find((x) => x.id === 'secrets:exposed')!;
    expect(h.blocking).toBe(true);
    expect(h.action).toMatch(/won't write STRIPE_SECRET_KEY/);
    expect(byId(plan, 'payments:keys:production').preview.join('\n')).not.toContain('STRIPE_SECRET_KEY');
    expect(byId(plan, 'payments:keys:production').preview.join('\n')).toContain('NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY');
    expect(byId(plan, 'env:production').preview.join('\n')).toContain('SUPABASE_SERVICE_ROLE_KEY');
  });

  it('a client-prefixed secret blocks the server name for the same key', async () => {
    const { ctx } = setup({ env: [...ENV, 'NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY'] });
    const plan = await build(ctx);
    expect(hIds(plan)).toContain('secrets:exposed');
    expect(byId(plan, 'env:production').preview.join('\n')).not.toContain('SUPABASE_SERVICE_ROLE_KEY');
    expect(byId(plan, 'env:production').preview.join('\n')).toContain('DATABASE_URL');
  });

  it('a finding that names no variable blocks every secret write (webhook included)', async () => {
    const { ctx } = setup({ findings: [{ id: 'vite-define-env', severity: 'critical', title: 'vite.config define inlines all of process.env', evidence: ['vite.config.ts: define'] }] });
    const plan = await build(ctx);
    expect(ids(plan)).not.toContain('payments:webhook:production');
    expect(ids(plan).filter((i) => i.startsWith('email:key:'))).toEqual([]);
    const envPv = byId(plan, 'env:production').preview.join('\n');
    for (const n of ['SUPABASE_SERVICE_ROLE_KEY', 'DATABASE_URL']) expect(envPv).not.toContain(n);
    expect(envPv).toContain('NEXT_PUBLIC_SUPABASE_URL');
    expect(plan.handoffs.find((x) => x.id === 'secrets:exposed')?.action).toMatch(/every server secret/);
  });

  it('non-critical findings block nothing', async () => {
    const { ctx } = setup({ findings: [{ ...inlined, severity: 'high' }] });
    const plan = await build(ctx);
    expect(hIds(plan)).not.toContain('secrets:exposed');
    expect(byId(plan, 'payments:keys:production').preview.join('\n')).toContain('STRIPE_SECRET_KEY');
  });
});

describe('dns lookup errors', () => {
  it('reports a failed zone lookup as an error, not as "zone not hosted"', async () => {
    const { ctx } = setup({ arrange: (w) => (w.dns.lookupError = 'Cloudflare API 403: needs Zone:Read') });
    const plan = await build(ctx);
    expect(ids(plan)).not.toContain('domain:dns');
    expect(ids(plan)).not.toContain('email:dns');
    expect(hIds(plan)).not.toContain('domain:dns');
    expect(hIds(plan)).not.toContain('email:dns');
    expect(plan.warnings.join('\n')).toMatch(/checking whether FakeDNS hosts example\.com failed \(Cloudflare API 403: needs Zone:Read\)/);
    expect(plan.warnings.join('\n')).not.toMatch(/doesn't host this zone/);
  });
});

// ── Round-2 review regressions ──────────────────────────────────────────────────────────────────────

const intents = (p: Plan) => p.steps.map((s) => s.intent ?? '');
const statusOf = (out: Awaited<ReturnType<typeof apply>>, id: string) => out.find((o) => o.id === id)?.status;

describe('a re-planned step with the same preview but a different intent runs again (#0)', () => {
  it('switching the db project twice rewrites production env both times', async () => {
    const { w, ctx } = setup({ config: { stack: { hosting: 'fakehost', db: 'fakedb' }, domain: undefined }, env: ['NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'], state: stateWith([], DEPLOYED) });
    await apply(ctx, await build(ctx));
    const src = () => ctx.state.get().resources['env:SUPABASE_SERVICE_ROLE_KEY@production'];
    expect(src()).toBe('supabase.secretKey|fakedb|db_1');

    w.db.current = { id: 'db_2', name: 'shop-v2' };
    const p2 = await build(ctx);
    expect(byId(p2, 'env:production').intent).toContain('supabase.secretKey|fakedb|db_2');
    expect(statusOf(await apply(ctx, p2), 'env:production')).toBe('done');
    expect(src()).toBe('supabase.secretKey|fakedb|db_2');

    w.db.current = { id: 'db_3', name: 'shop-v3' };
    const p3 = await build(ctx);
    // Same preview text as the db_2 update; only the intent tells them apart.
    expect(byId(p3, 'env:production').preview).toEqual(byId(p2, 'env:production').preview);
    expect(byId(p3, 'env:production').intent).not.toBe(byId(p2, 'env:production').intent);
    const out3 = await apply(ctx, p3);
    expect(statusOf(out3, 'env:production')).toBe('done');
    expect(statusOf(out3, 'env:preview')).toBe('done');
    expect(src()).toBe('supabase.secretKey|fakedb|db_3');
    // Nothing left to do afterwards (no endless env + redeploy loop).
    expect(ids(await build(ctx))).toEqual(['project:hosting', 'project:db']);
  });

  it('rotating the Stripe key twice rewrites the production key both times (intent = fingerprint, never the key)', async () => {
    const { w, ctx } = setup({ env: ['STRIPE_SECRET_KEY'], config: { domain: undefined, payments: undefined, stack: { hosting: 'fakehost', payments: 'fakepay' } }, state: stateWith([], DEPLOYED) });
    await apply(ctx, await build(ctx));
    const hostKey = () => (w.host.env.production.get('STRIPE_SECRET_KEY') as Secret).reveal();
    expect(hostKey()).toBe(RAW.stripeLive);

    const K2 = 'sk_' + 'live_FAKErotatedONCEkey0123456789abcdef';
    const K3 = 'sk_' + 'live_FAKErotatedTWICEkey0123456789abcde';
    w.pay.secretKeys.live = K2;
    const p2 = await build(ctx);
    expect(statusOf(await apply(ctx, p2), 'payments:keys:production')).toBe('done');
    expect(hostKey()).toBe(K2);

    w.pay.secretKeys.live = K3;
    const p3 = await build(ctx);
    expect(byId(p3, 'payments:keys:production').preview).toEqual(byId(p2, 'payments:keys:production').preview);
    expect(byId(p3, 'payments:keys:production').intent).not.toBe(byId(p2, 'payments:keys:production').intent);
    expect(statusOf(await apply(ctx, p3), 'payments:keys:production')).toBe('done');
    expect(hostKey()).toBe(K3);
    const printable = [JSON.stringify(planView(p2)), JSON.stringify(planView(p3)), ...intents(p2), ...intents(p3), JSON.stringify(ctx.state.get())].join('\n');
    for (const k of [K2, K3]) expect(printable).not.toContain(k);
  });

  it('re-attaches the domain after a hosting project switch', async () => {
    const { w, ctx } = setup({ config: { stack: { hosting: 'fakehost', dns: 'fakedns' } }, env: [], state: stateWith([], DEPLOYED) });
    await apply(ctx, await build(ctx));
    w.host.current = { id: 'prj_2', name: 'shop-2' };
    const out = await apply(ctx, await build(ctx));
    expect(statusOf(out, 'domain:attach')).toBe('done');
    expect(w.calls.filter((c) => c.method === 'domain.add')).toHaveLength(2);
  });

  it('asks the email provider to verify again on each plan while the domain is pending', async () => {
    const { w, ctx } = setup({ config: { stack: { hosting: 'fakehost', email: 'fakemail', dns: 'fakedns' } }, env: [], state: stateWith([], DEPLOYED) });
    await apply(ctx, await build(ctx));
    const p2 = await build(ctx);
    expect(byId(p2, 'email:verify').preview.join('\n')).toMatch(/previous request: 20/);
    expect(statusOf(await apply(ctx, p2), 'email:verify')).toBe('done');
    expect(w.calls.filter((c) => c.method === 'sendingDomain.verify')).toHaveLength(2);
  });

  it('keeps plan ids deterministic and intents secret-free', async () => {
    const a = await build(setup().ctx);
    const b = await build(setup().ctx);
    expect(intents(a)).toEqual(intents(b));
    expect(a.id).toBe(b.id);
    for (const id of ['env:production', 'payments:keys:production', 'payments:webhook:production', 'domain:attach', 'domain:dns', 'email:verify', 'project:db']) expect(byId(a, id).intent, id).toBeTruthy();
    expectNoRawSecrets(intents(a));
  });
});

describe('webhook signing secret belongs to the endpoint it was minted for (#3, #8)', () => {
  const URL_ = 'https://example.com/api/webhooks/stripe';
  const small = { stack: { hosting: 'fakehost', payments: 'fakepay' } } as Partial<ShipConfig>;
  const withMode = (m: 'test' | 'live') => ({ ...BASE_CONFIG.payments, modes: { production: m } });

  it('live → test → live replaces the live endpoint and stores ITS secret (not the test one)', async () => {
    const { w, ctx } = setup({ config: small, env: ['STRIPE_WEBHOOK_SECRET'], state: stateWith([], DEPLOYED) });
    await apply(ctx, await build(ctx)); // we_1 (live)
    ctx.config.payments = withMode('test');
    await apply(ctx, await build(ctx)); // we_2 (test)
    expect(ctx.state.get().resources['env:STRIPE_WEBHOOK_SECRET@production']).toBe('stripe.webhookSecret|fakepay|test|we_2');

    ctx.config.payments = withMode('live');
    const plan = await build(ctx);
    expect(byId(plan, 'payments:webhook:production').preview.join('\n')).toMatch(/replace endpoint we_1: .*then delete we_1/);
    const out = await apply(ctx, plan);
    expect(statusOf(out, 'payments:webhook:production')).toBe('done');
    const live = w.pay.endpoints.filter((e) => e.mode === 'live').map((e) => e.id);
    expect(live).toEqual(['we_3']);
    expect((w.host.env.production.get('STRIPE_WEBHOOK_SECRET') as Secret).reveal()).toBe(`${RAW.whsecPrefix}3xyz`);
    expect(ctx.state.get().resources['fakepay.live.webhookEndpointId']).toBe('we_3');
    expect(ctx.state.get().resources['env:STRIPE_WEBHOOK_SECRET@production']).toBe('stripe.webhookSecret|fakepay|live|we_3');
    expect(ids(await build(ctx))).not.toContain('payments:webhook:production');
  });

  it("test → live with a human's live endpoint at the URL: the test secret is not kept", async () => {
    const { w, ctx } = setup({ config: { ...small, payments: withMode('test') }, env: ['STRIPE_WEBHOOK_SECRET'], state: stateWith([], DEPLOYED) });
    await apply(ctx, await build(ctx)); // we_1 (test)
    w.pay.endpoints.push({ id: 'we_h', url: URL_, events: ['checkout.session.completed'], enabled: true, mode: 'live', owned: false });
    ctx.config.payments = withMode('live');
    const plan = await build(ctx);
    const pv = byId(plan, 'payments:webhook:production').preview.join('\n');
    expect(pv).toMatch(/replace endpoint we_h/);
    expect(pv).toMatch(/leave we_h in place/);
    await apply(ctx, plan);
    expect((w.host.env.production.get('STRIPE_WEBHOOK_SECRET') as Secret).reveal()).toBe(`${RAW.whsecPrefix}2xyz`);
    expect(ctx.state.get().resources['env:STRIPE_WEBHOOK_SECRET@production']).toBe('stripe.webhookSecret|fakepay|live|we_2');
  });

  it('accepts a legacy source (no endpoint id) only for the remembered endpoint in the same mode', async () => {
    const arrange = (x: FakeWorld) => {
      x.pay.endpoints.push({ id: 'we_old', url: URL_, events: ['checkout.session.completed'], enabled: true, mode: 'live' });
      x.host.env.production.set('STRIPE_WEBHOOK_SECRET', 'set');
    };
    const legacy = (mode: string, id: string) => stateWith(['STRIPE_WEBHOOK_SECRET@production'], { 'env:STRIPE_WEBHOOK_SECRET@production': `stripe.webhookSecret|fakepay|${mode}`, 'fakepay.live.webhookEndpointId': id });
    expect(ids(await build(setup({ arrange, state: legacy('live', 'we_old') }).ctx))).not.toContain('payments:webhook:production');
    expect(ids(await build(setup({ arrange, state: legacy('test', 'we_old') }).ctx))).toContain('payments:webhook:production');
    expect(ids(await build(setup({ arrange, state: legacy('live', 'we_other') }).ctx))).toContain('payments:webhook:production');
  });
});

describe('webhook: old production URL endpoint (#4)', () => {
  it('adding a custom domain later deletes the golive endpoint for the old host URL after the new secret is stored', async () => {
    const { w, ctx } = setup({ config: { stack: { hosting: 'fakehost', payments: 'fakepay' }, domain: undefined }, env: ['STRIPE_WEBHOOK_SECRET'], state: stateWith([], DEPLOYED) });
    await apply(ctx, await build(ctx));
    expect(w.pay.endpoints.map((e) => [e.id, e.url])).toEqual([['we_1', 'https://shop.fakehost.app/api/webhooks/stripe']]);

    ctx.config.domain = 'example.com';
    const plan = await build(ctx);
    const pv = byId(plan, 'payments:webhook:production').preview;
    expect(pv[1]).toBe('create live webhook endpoint → https://example.com/api/webhooks/stripe (events: checkout.session.completed)');
    expect(pv.at(-1)).toMatch(/^then delete old endpoint we_1 \(https:\/\/shop\.fakehost\.app\/api\/webhooks\/stripe\), which golive created for the previous production URL/);
    const out = await apply(ctx, plan);
    const o = out.find((x) => x.id === 'payments:webhook:production')!;
    expect(o.status).toBe('done');
    expect(o.changes).toContain('deleted old endpoint we_1 (https://shop.fakehost.app/api/webhooks/stripe) for the previous production URL');
    expect(w.pay.endpoints.map((e) => e.id)).toEqual(['we_2']);
    // Deleted only after the new secret was written.
    const order = w.calls.map((c) => `${c.method}:${String(c.args[0])}`);
    expect(order.indexOf('webhooks.remove:we_1')).toBeGreaterThan(order.indexOf('env.set:STRIPE_WEBHOOK_SECRET'));
    expect((w.host.env.production.get('STRIPE_WEBHOOK_SECRET') as Secret).reveal()).toBe(`${RAW.whsecPrefix}2xyz`);
  });
});

describe('webhook: host would refuse the signing secret (#7)', () => {
  const SHARED = 'already exists as one variable shared by production + preview + development';

  it('plans a blocking handoff instead of creating an endpoint whose secret would be lost', async () => {
    const { w, ctx } = setup({ arrange: (x) => (x.host.envRefuse.STRIPE_WEBHOOK_SECRET = SHARED) });
    const plan = await build(ctx);
    expect(ids(plan)).not.toContain('payments:webhook:production');
    const h = plan.handoffs.find((x) => x.id === 'fakepay:webhook-env')!;
    expect(h.blocking).toBe(true);
    expect(h.why).toContain(SHARED);
    await apply(ctx, plan);
    expect(w.calls.some((c) => c.method === 'webhooks.ensure')).toBe(false);
    expect(w.pay.endpoints).toEqual([]);
  });

  it('re-checks at apply time and refuses before creating anything', async () => {
    const { w, ctx } = setup({ state: stateWith([], DEPLOYED) });
    const plan = await build(ctx);
    w.host.envRefuse.STRIPE_WEBHOOK_SECRET = SHARED;
    const out = await apply(ctx, plan);
    const o = out.find((x) => x.id === 'payments:webhook:production')!;
    expect(o.status).toBe('failed');
    expect(o.error).toMatch(/would refuse to store the webhook signing secret .*no endpoint was created/);
    expect(w.calls.some((c) => c.method === 'webhooks.ensure')).toBe(false);
    expect(w.pay.endpoints).toEqual([]);
  });

  it('without a preflight, a failed write removes the endpoint it just created (no orphan per re-run)', async () => {
    const { w, ctx } = setup({ state: stateWith([], DEPLOYED), arrange: (x) => (x.host.withCanSet = false) });
    const plan = await build(ctx);
    w.host.envRefuse.STRIPE_WEBHOOK_SECRET = SHARED;
    const o = (await apply(ctx, plan)).find((x) => x.id === 'payments:webhook:production')!;
    expect(o.status).toBe('failed');
    expect(o.error).toMatch(/created live webhook endpoint we_1 but storing its signing secret in FakeHost failed .*it was deleted again/);
    expect(w.pay.endpoints).toEqual([]);
    expect(w.pay.deleted).toEqual(['we_1']);
    expect(ctx.state.get().resources['fakepay.live.webhookEndpointId']).toBeUndefined();
    expectNoRawSecrets([o.error ?? '']);
  });
});

describe('domain:dns writes only the records the human approved (#5)', () => {
  it('refuses, writing nothing, when the host requires different records after attaching', async () => {
    const { w, ctx } = setup({ state: stateWith([], DEPLOYED) });
    const plan = await build(ctx);
    expect(byId(plan, 'domain:dns').preview).toEqual(['upsert at FakeDNS: A example.com = 76.76.21.21 (not proxied)']);
    // After attach the host asks for an ownership TXT challenge too.
    const add = w.adapters.find((a) => a.id === 'fakehost')!.capabilities.domain!;
    const realAdd = add.add.bind(add);
    add.add = async (c, d) => {
      await realAdd(c, d);
      w.host.records = [...w.host.records, { type: 'TXT', name: '_fakehost.example.com', content: 'fh-verify=zzz' }];
    };
    const out = await apply(ctx, plan);
    const o = out.find((x) => x.id === 'domain:dns')!;
    expect(o.status).toBe('failed');
    expect(o.error).toMatch(/changed since the plan was approved \(planned: A example\.com = 76\.76\.21\.21; now: A example\.com = 76\.76\.21\.21; TXT _fakehost\.example\.com = fh-verify=zzz\); nothing was changed at FakeDNS\. Run `plan` again/);
    expect(w.dns.records).toEqual([]);
    expect(w.calls.some((c) => c.method === 'dns.upsert')).toBe(false);
    // The re-plan lists the new record and applies it.
    const p2 = await build(ctx);
    expect(byId(p2, 'domain:dns').preview).toContain('upsert at FakeDNS: TXT _fakehost.example.com = fh-verify=zzz (not proxied)');
    expect(statusOf(await apply(ctx, p2), 'domain:dns')).toBe('done');
  });

  it('applies when the records are the same (order and formatting aside)', async () => {
    const { w, ctx } = setup({
      state: stateWith([], DEPLOYED),
      arrange: (x) => (x.host.records = [{ type: 'A', name: 'example.com', content: '76.76.21.21' }, { type: 'CNAME', name: 'www.example.com', content: 'cname.fakehost-dns.com' }]),
    });
    const plan = await build(ctx);
    w.host.records = [{ type: 'CNAME', name: 'WWW.example.com.', content: 'cname.fakehost-dns.com.' }, { type: 'A', name: 'example.com', content: '76.76.21.21' }];
    expect(statusOf(await apply(ctx, plan), 'domain:dns')).toBe('done');
  });

  it('forces proxied:false even when the host lists a record as proxied', async () => {
    const { w, ctx } = setup({
      state: stateWith([], DEPLOYED),
      arrange: (x) => (x.host.records = [{ type: 'A', name: 'example.com', content: '76.76.21.21', proxied: true }]),
    });
    const plan = await build(ctx);
    expect(statusOf(await apply(ctx, plan), 'domain:dns')).toBe('done');
    expect(w.dns.records.filter((r) => r.type === 'A' && r.name === 'example.com')).toEqual([{ type: 'A', name: 'example.com', content: '76.76.21.21', proxied: false }]);
    expect(w.dns.records.every((r) => r.proxied === false)).toBe(true);
  });
});

describe('guided host + automated payments (#14)', () => {
  it('hands off the webhook registration and gives per-target, per-mode env guidance', async () => {
    const { ctx } = setup({ config: { stack: { hosting: 'fakeguided', payments: 'fakepay' } } });
    const plan = await build(ctx);
    const h = plan.handoffs.find((x) => x.id === 'fakepay:webhook-guided')!;
    expect(h).toMatchObject({ blocking: true, verifiedBy: 'webhook-registered' });
    expect(h.action).toMatch(/Webhooks tab in Workbench, live mode\), the human adds an endpoint at https:\/\/example\.com\/api\/webhooks\/stripe for these events: checkout\.session\.completed/);
    expect(h.action).toMatch(/into FakeGuided's Production env as STRIPE_WEBHOOK_SECRET, never through this chat/);
    expect(ids(plan).filter((i) => i.startsWith('payments:'))).toEqual([]);

    const pre = plan.handoffs.find((x) => x.id === 'env:preview')!.action;
    const prod = plan.handoffs.find((x) => x.id === 'env:production')!.action;
    expect(pre).not.toMatch(/STRIPE_WEBHOOK_SECRET \(/);
    expect(pre).toMatch(/signing secret is production-only/);
    expect(pre).toContain('STRIPE_SECRET_KEY (FakePay test-mode key: sk_test_…)');
    expect(prod).toContain('STRIPE_SECRET_KEY (FakePay live-mode key: sk_live_…)');
    expect(prod).toContain('NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY (FakePay live-mode key: pk_live_…)');
    expect(prod).toContain('STRIPE_WEBHOOK_SECRET (signing secret of the live-mode production webhook endpoint)');
  });

  it('uses a placeholder URL when the guided host has no known production URL', async () => {
    const { ctx } = setup({ config: { stack: { hosting: 'fakeguided', payments: 'fakepay' }, domain: undefined } });
    const h = (await build(ctx)).handoffs.find((x) => x.id === 'fakepay:webhook-guided')!;
    expect(h.action).toContain('<your production URL>/api/webhooks/stripe');
  });
});
