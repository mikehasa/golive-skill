import { describe, it, expect, beforeEach } from 'vitest';
import { Secret, _resetSecretRegistry } from '../src/core/secret.js';
import { buildPlan, planView } from '../src/core/plan.js';
import { applyPlan } from '../src/core/runner.js';
import { emptyState } from '../src/core/state.js';
import type { Check, Finding, Plan, ShipConfig, ShipState, Step } from '../src/core/types.js';
import { envParityCheck } from '../src/checks/env-parity.js';
import { ALL_LINKS } from '../src/links/all.js';
import { availableKeys, recordDeploy } from '../src/links/util.js';
import { emailDomain } from '../src/links/email.js';
import { mockExec, testCtx } from './helpers.js';
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

function setup(opts: { config?: Partial<ShipConfig>; env?: string[]; state?: ShipState; findings?: Finding[]; arrange?: (w: FakeWorld) => void } = {}) {
  const w = fakeWorld();
  opts.arrange?.(w);
  const exec = mockExec([]);
  const ctx = testCtx({
    cwd: '/work/shop',
    exec: exec.run,
    adapters: w.adapters,
    config: { ...BASE_CONFIG, ...opts.config },
    state: opts.state,
    detect: { envRefs: (opts.env ?? ENV).map((name) => ({ name, files: ['src/lib.ts'], clientExposed: false })), findings: opts.findings ?? [] },
  });
  return { w, ctx, exec };
}

const build = (ctx: Parameters<typeof buildPlan>[0]) => buildPlan(ctx, ALL_LINKS, { unmappedEnv: [], warnings: [] });
const apply = (ctx: Parameters<typeof buildPlan>[0], plan: Plan) => applyPlan(ctx, plan, new Map(), { approvedPlanId: plan.id, yes: true, confirmLive: true, confirmDns: true });
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

  it('the release.preview opt-in plans nothing yet and leaves the plan id unchanged', async () => {
    const plain = await build(setup().ctx);
    const optedIn = await build(setup({ config: { release: { preview: true } } }).ctx);
    expect(ids(optedIn)).toEqual(ids(plain));
    expect(optedIn.id).toBe(plain.id);
    expect(optedIn.steps.map((s) => s.preview)).toEqual(plain.steps.map((s) => s.preview));
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
