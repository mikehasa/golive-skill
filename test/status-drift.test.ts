/**
 * Drift (`golive status`): recorded baselines vs reads taken now. Offline: fake adapters plus mocked
 * DoH. No provider account, no network, and `status` never writes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectDrift, type DriftReport } from '../src/core/drift.js';
import { dnsBaselineKey, readDnsBaselines, type DnsBaseline } from '../src/core/dns-baseline.js';
import { buildInventory } from '../src/core/inventory.js';
import { buildTeardownPlan } from '../src/core/teardown.js';
import { buildPlan } from '../src/core/plan.js';
import { applyPlan } from '../src/core/runner.js';
import { emptyState } from '../src/core/state.js';
import { _resetSecretRegistry } from '../src/core/secret.js';
import { ALL_LINKS } from '../src/links/all.js';
import type { Adapter, Ctx, DnsRecord, Plan, ReleaseIdentity, ShipConfig, ShipState, Step, StepContext, StepRecord } from '../src/core/types.js';
import { TEST_RELEASE, mockHttp, testCtx } from './helpers.js';
import { dohRoute } from './check-fakes.js';
import { fakeWorld, type FakeWorld } from './fakes.js';

// The `status` command builds its Ctx from the registry's adapter list; the harness below swaps in the
// fakes so the command itself (not just detectDrift) is exercised offline.
const mocks = vi.hoisted(() => ({ adapters: [] as Adapter[] }));
vi.mock('../src/registry.js', async (original) => ({ ...await original<typeof import('../src/registry.js')>(), ADAPTERS: mocks.adapters }));

beforeEach(() => _resetSecretRegistry());
afterEach(() => vi.restoreAllMocks());

const DAY = 24 * 60 * 60 * 1000;
const now = (): string => new Date().toISOString();
const ago = (ms: number): string => new Date(Date.now() - ms).toISOString();

function baseline(over: Partial<DnsBaseline> = {}): DnsBaseline {
  return { provider: 'fakedns', zone: 'example.com', type: 'CNAME', name: 'app.example.com', content: 'cname.fakehost.app', at: now(), ...over };
}

const dnsState = (...records: DnsBaseline[]): Record<string, string> =>
  Object.fromEntries(records.map((b) => [dnsBaselineKey(b.zone, b), JSON.stringify(b)]));

const stateWith = (resources: Record<string, string>, over: Partial<ShipState> = {}): ShipState => ({ ...emptyState(), resources, ...over });

const done = (at = now()) => ({ status: 'done' as const, at, planId: 'plan_1' });

/** A second release identity: a version and bundle golive did not record the failed step under. */
const OLDER_RELEASE: ReleaseIdentity = { ...TEST_RELEASE, version: '0.1.0-alpha.9', bundleDigest: 'b'.repeat(64) };

/** State holding one failed `auth:test-user` record, from this release unless a test says otherwise. */
const failedStep = (over: Partial<StepRecord> = {}): ShipState =>
  stateWith({}, { steps: { 'auth:test-user': { status: 'failed', at: ago(DAY), planId: 'plan_1', release: TEST_RELEASE, error: 'verification failed: auth-session', ...over } } });

/** A plan step as far as drift reads it: what the step declares about its own write. */
const stepStub = (id: string, risk: Step['risk']): Step =>
  ({ id, title: id, kind: 'provision', risk, dependsOn: [], preview: [], verifyWith: [], run: async () => ({ changes: [] }) });

const planWith = (...steps: Step[]): Plan => ({ id: 'plan_1', release: TEST_RELEASE, steps, handoffs: [], unmappedEnv: [], warnings: [] });

function setup(over: { config?: Partial<ShipConfig>; state?: ShipState; arrange?: (w: FakeWorld) => void; noDoH?: boolean } = {}) {
  const w = fakeWorld();
  over.arrange?.(w);
  const http = over.noDoH ? mockHttp([]).http : mockHttp([]).http;
  const ctx: Ctx = testCtx({
    cwd: '/work/app',
    adapters: w.adapters,
    config: { stack: {}, ...over.config },
    state: over.state ?? emptyState(),
    http,
  });
  return { w, ctx };
}

const withDoH = (ctx: Ctx, records: Record<string, string[]>): Ctx => ({ ...ctx, http: mockHttp([dohRoute(records)]).http });

const item = (r: DriftReport, id: string) => r.items.find((i) => i.id === id);
const ids = (r: DriftReport) => r.items.map((i) => i.id);

// ── DNS records ─────────────────────────────────────────────────────────────────────────────────

describe('drift: DNS records golive wrote', () => {
  const HOST_CONFIG: Partial<ShipConfig> = { stack: { hosting: 'fakehost', dns: 'fakedns' }, domain: 'example.com' };

  it('reports a recorded record the zone no longer has as high, and never re-baselines it', async () => {
    const written = baseline({ at: ago(5 * DAY) });
    const state = stateWith(dnsState(written));
    const { w, ctx } = setup({ config: HOST_CONFIG, state, arrange: (x) => void (x.dns.records = []) });
    expect(w.dns.records).toEqual([]);

    const report = await detectDrift(ctx);
    const it_ = item(report, 'dns:example.com:CNAME:app.example.com:missing')!;
    expect(it_).toMatchObject({ class: 'dns-record', severity: 'high', action: 'reconcile', checkId: 'domain-live' });
    expect(it_.expected).toMatch(/recorded by golive/);
    expect(it_.observed).toMatch(/read now/);
    expect(it_.observed).toContain('reports no CNAME record at app.example.com');
    expect(report.summary.actionable).toBe(1);
    // The baseline is untouched: only an approved write moves it.
    expect(readDnsBaselines(ctx.state.get())).toEqual([written]);
  });

  it('reports a changed record as medium and says the change may be deliberate', async () => {
    const written = baseline({ at: ago(3 * DAY) });
    const changed: DnsRecord = { type: 'CNAME', name: 'app.example.com', content: 'someone-elses-host.app' };
    const { ctx } = setup({ config: HOST_CONFIG, state: stateWith(dnsState(written)), arrange: (w) => void (w.dns.records = [changed]) });

    const report = await detectDrift(ctx);
    const it_ = item(report, 'dns:example.com:CNAME:app.example.com:changed')!;
    expect(it_).toMatchObject({ severity: 'medium', action: 'verify' });
    expect(it_.observed).toContain('someone-elses-host.app');
    expect(it_.suggestedAction).toMatch(/may be intentional/);
  });

  it('only compares public DNS when the zone still matches the baseline', async () => {
    const written = baseline();
    const state = stateWith(dnsState(written));
    // The zone serves something else: public DNS must not even be asked (a cached public answer would
    // add noise about a record golive already knows is gone).
    const { ctx, w } = setup({ config: HOST_CONFIG, state, arrange: (x) => void (x.dns.records = [{ type: 'CNAME', name: 'app.example.com', content: 'other.app' }]) });
    expect(w.dns.records.length).toBe(1);
    const report = await detectDrift(ctx);
    expect(ids(report)).not.toContain('dns:example.com:CNAME:app.example.com:public');
  });

  it('treats a fresh public mismatch as still propagating, outside the window as a finding', async () => {
    const fresh = baseline({ at: ago(60_000) }); // written a minute ago
    const old = baseline({ at: ago(3 * DAY) });
    for (const [b, wanted] of [[fresh, { severity: 'info', action: 'none' }], [old, { severity: 'medium', action: 'verify' }]] as const) {
      const zone: DnsRecord = { type: 'CNAME', name: 'app.example.com', content: b.content };
      const { ctx } = setup({ config: HOST_CONFIG, state: stateWith(dnsState(b)), arrange: (w) => void (w.dns.records = [zone]) });
      const report = await detectDrift(withDoH(ctx, { 'CNAME app.example.com': ['wildcard.fakehost.app'] }));
      expect(item(report, 'dns:example.com:CNAME:app.example.com:public')).toMatchObject({ class: 'dns-public', ...wanted });
    }
  });

  it('counts a public answer that satisfies the baseline as verified', async () => {
    const written = baseline({ at: ago(DAY) });
    const { ctx } = setup({ config: HOST_CONFIG, state: stateWith(dnsState(written)), arrange: (w) => void (w.dns.records = [{ type: 'CNAME', name: 'app.example.com', content: 'cname.fakehost.app' }]) });
    const report = await detectDrift(withDoH(ctx, { 'CNAME app.example.com': ['cname.fakehost.app'] }));
    expect(item(report, 'dns:example.com:CNAME:app.example.com:public')).toBeUndefined();
    expect(report.verified.join('\n')).toContain('app.example.com is served by public DNS as golive recorded it');
    expect(report.summary.actionable).toBe(0);
  });

  it('reports delegation moved when public name servers changed, and stays quiet when they did not', async () => {
    const written = baseline({ at: ago(DAY) });
    const zone: DnsRecord = { type: 'CNAME', name: 'app.example.com', content: written.content };

    const moved = setup({ config: HOST_CONFIG, state: stateWith(dnsState(written)), arrange: (w) => void (w.dns.records = [zone]) });
    const movedReport = await detectDrift(withDoH(moved.ctx, { 'NS example.com': ['ns1.otherhost.net'], 'CNAME app.example.com': [written.content] }));
    const it_ = item(movedReport, 'dns:example.com:delegation')!;
    expect(it_).toMatchObject({ class: 'dns-delegation', severity: 'medium', action: 'verify' });
    expect(it_.expected).toContain('fakedns serves the example.com zone');
    expect(it_.observed).toContain('ns1.otherhost.net');

    const stayed = setup({ config: HOST_CONFIG, state: stateWith(dnsState(written)), arrange: (w) => void (w.dns.records = [zone]) });
    const stayedReport = await detectDrift(withDoH(stayed.ctx, { 'NS example.com': ['ns1.fakedns.com'], 'CNAME app.example.com': [written.content] }));
    expect(item(stayedReport, 'dns:example.com:delegation')).toBeUndefined();
    expect(stayedReport.verified.join('\n')).toContain('is still served by the name servers golive recorded');
  });

  it('reports a host that now asks for a different target than golive wrote', async () => {
    const written = baseline({ zone: 'example.com', type: 'A', name: 'example.com', content: '76.76.21.21', at: ago(2 * DAY) });
    const state = stateWith(dnsState(written), { steps: { 'domain:attach': done(ago(2 * DAY)) } });
    const { ctx } = setup({
      config: HOST_CONFIG,
      state,
      arrange: (w) => {
        w.dns.records = [{ type: 'A', name: 'example.com', content: '76.76.21.21' }];
        w.host.records = [{ type: 'A', name: 'example.com', content: '76.76.21.99' }];
      },
    });
    const report = await detectDrift(ctx);
    const it_ = item(report, 'dns:example.com:required:A:example.com')!;
    expect(it_).toMatchObject({ class: 'dns-record', severity: 'medium', action: 'reconcile' });
    expect(it_.observed).toContain('76.76.21.99');
    expect(it_.suggestedAction).toContain('--confirm-dns');
  });

  it('reads each zone once per invocation, however many records it holds', async () => {
    const records = [baseline({ type: 'A', name: 'example.com', content: '76.76.21.21' }), baseline({ type: 'CNAME', name: 'www.example.com', content: 'cname.fakehost.app' })];
    let lists = 0;
    const { ctx } = setup({
      config: HOST_CONFIG,
      state: stateWith(dnsState(...records)),
      arrange: (w) => {
        const zone = w.adapters.find((a) => a.id === 'fakedns')!.capabilities.dns!;
        const list = zone.list.bind(zone);
        zone.list = async (c, d) => {
          lists++;
          return list(c, d);
        };
      },
    });
    await detectDrift(withDoH(ctx, {}));
    expect(lists).toBe(1);
  });

  it('says so when there is no recorded DNS baseline instead of implying a clean zone', async () => {
    const { ctx } = setup({ config: { stack: { hosting: 'fakehost', dns: 'fakedns' }, domain: 'example.com' } });
    const report = await detectDrift(ctx);
    expect(report.items).toEqual([]);
    expect(report.notChecked.map((n) => n.subject).join(' ')).toContain('DNS records');
  });

  it('marks a signed-out DNS provider as unverifiable, and a failed public lookup as not checked', async () => {
    const written = baseline({ at: ago(DAY) });
    const off = setup({ config: HOST_CONFIG, state: stateWith(dnsState(written)), arrange: (w) => void (w.dns.authed = false) });
    const offReport = await detectDrift(off.ctx);
    expect(item(offReport, 'dns:example.com:provider')).toMatchObject({ unverifiable: true, action: 'none' });
    expect(offReport.verified).toEqual([]);
    expect(offReport.summary.actionable).toBe(0);

    // The zone still matches, but public resolution cannot be reached: no item, and explicitly not checked.
    const noDoH = setup({ config: HOST_CONFIG, state: stateWith(dnsState(written)), arrange: (w) => void (w.dns.records = [{ type: 'CNAME', name: 'app.example.com', content: written.content }]) });
    const noDoHReport = await detectDrift(noDoH.ctx); // mockHttp([]) throws for the DoH route
    expect(ids(noDoHReport).filter((id) => id.endsWith(':public'))).toEqual([]);
    expect(noDoHReport.notChecked.map((n) => n.reason).join(' ')).toContain('public DNS lookup failed');
  });
});

// ── Teardown keeps ignoring the new keys ────────────────────────────────────────────────────────

describe('drift: DNS baselines are not resources', () => {
  it('keeps the teardown inventory blind to baseline keys, and teardown still plans only owned records', async () => {
    const written = baseline({ at: ago(DAY) });
    const owned: DnsRecord = { type: 'TXT', name: 'example.com', content: 'golive-owned-proof' };
    const state = stateWith(dnsState(written));
    const { w, ctx } = setup({ config: { stack: { hosting: 'fakehost', dns: 'fakedns' }, domain: 'example.com' }, state, arrange: (x) => void (x.dns.owned = []) });

    expect(readDnsBaselines(ctx.state.get())).toHaveLength(1);
    expect(await buildInventory(ctx)).toMatchObject({ dnsRecords: [] });
    const empty = await buildTeardownPlan(ctx);
    expect(empty.steps.filter((s) => s.id.startsWith('teardown:dns'))).toEqual([]);

    // With a provider-reported owned record, only that one is planned: a baseline is never mistaken for it.
    w.dns.owned = [owned];
    const plan = await buildTeardownPlan(ctx);
    expect(plan.steps.filter((s) => s.id.startsWith('teardown:dns')).map((s) => s.id)).toEqual(['teardown:dns:fakedns:TXT:example.com']);
    expect((await buildInventory(ctx)).dnsRecords.map((r) => r.record)).toEqual([owned]);
  });
});

// ── Recording the baselines ─────────────────────────────────────────────────────────────────────

describe('drift: the DNS steps record what they wrote', () => {
  const config: Partial<ShipConfig> = { stack: { hosting: 'fakehost', dns: 'fakedns' }, domain: 'example.com', targets: ['production'] };

  it('records one baseline per record the domain:dns step upserts', async () => {
    const w = fakeWorld();
    const ctx = testCtx({ cwd: '/work/app', adapters: w.adapters, config, detect: { envRefs: [] } });
    const plan = await buildPlan(ctx, ALL_LINKS, { unmappedEnv: [], warnings: [] });
    await applyPlan(ctx, plan, new Map(), { approvedPlanId: plan.id, yes: true, confirmDns: true, confirmLive: true });

    expect(readDnsBaselines(ctx.state.get())).toEqual([
      { provider: 'fakedns', zone: 'example.com', type: 'A', name: 'example.com', content: '76.76.21.21', at: expect.any(String) },
    ]);
    expect(ctx.state.resource(dnsBaselineKey('example.com', { type: 'A', name: 'example.com' }))).toContain('"provider":"fakedns"');
  });

  it('records the email sending records the email:dns step upserts', async () => {
    const w = fakeWorld();
    const ctx = testCtx({ cwd: '/work/app', adapters: w.adapters, config: { stack: { email: 'fakemail', dns: 'fakedns' }, email: { from: 'hello@example.com' }, targets: ['production'] }, detect: { envRefs: [] } });
    const plan = await buildPlan(ctx, ALL_LINKS, { unmappedEnv: [], warnings: [] });
    await applyPlan(ctx, plan, new Map(), { approvedPlanId: plan.id, yes: true, confirmDns: true, confirmLive: true });

    const recorded = readDnsBaselines(ctx.state.get());
    expect(recorded.map((b) => `${b.type} ${b.name}`).sort()).toEqual(['MX send.example.com', 'TXT fm._domainkey.example.com', 'TXT send.example.com']);
    expect(recorded.every((b) => b.provider === 'fakedns' && b.zone === 'example.com')).toBe(true);
  });

  it('a re-run that finds the record unchanged keeps the time of the write that landed', async () => {
    const w = fakeWorld();
    const config: Partial<ShipConfig> = { stack: { hosting: 'fakehost', dns: 'fakedns' }, domain: 'example.com', targets: ['production'] };
    const ctx = testCtx({ cwd: '/work/app', adapters: w.adapters, config, detect: { envRefs: [] } });
    const step = (await buildPlan(ctx, ALL_LINKS, { unmappedEnv: [], warnings: [] })).steps.find((s) => s.id === 'domain:dns')!;
    const sctx: StepContext = {
      ...ctx,
      remember: (k, v) => ctx.state.save((s) => void (s.resources[k] = v)),
      rememberSecret: () => {},
      rememberValue: () => {},
    };

    await step.run(sctx);
    const first = readDnsBaselines(ctx.state.get())[0]!;
    await step.run(sctx);
    const second = readDnsBaselines(ctx.state.get())[0]!;
    expect(second.at).toBe(first.at); // 'unchanged' must not restart the propagation window
  });
});

// ── Env names ───────────────────────────────────────────────────────────────────────────────────

describe('drift: env names golive delivered', () => {
  const HOST_CONFIG: Partial<ShipConfig> = { stack: { hosting: 'fakehost' }, targets: ['production'] };
  const envState = (name: string, target = 'production') => stateWith(
    { [`env:${name}@${target}`]: 'supabase.secretKey|fakedb|ref_1' },
    { secrets: { [`${name}@${target}`]: { fp: 'ab12', at: ago(2 * DAY) } } },
  );

  it('reports a golive-managed name the host no longer has as high drift', async () => {
    const { w, ctx } = setup({ config: HOST_CONFIG, state: envState('FAKE_SECRET_KEY') });
    w.host.env.production.set('OTHER_KEY', 'x');
    const report = await detectDrift(ctx);
    expect(item(report, 'env:production:FAKE_SECRET_KEY')).toMatchObject({ class: 'env-name', severity: 'high', action: 'reconcile', checkId: 'env-parity' });
    expect(report.summary.actionable).toBe(1);
  });

  it('reports nothing actionable while the name is there, and still names the value limit', async () => {
    const { w, ctx } = setup({ config: HOST_CONFIG, state: envState('FAKE_SECRET_KEY') });
    w.host.env.production.set('FAKE_SECRET_KEY', 'x');
    const report = await detectDrift(ctx);
    expect(ids(report)).toEqual(['env:values']);
    expect(item(report, 'env:values')).toMatchObject({ severity: 'info', action: 'none', unverifiable: true });
    expect(report.summary.actionable).toBe(0);
    expect(report.limits.join('\n')).toContain('env values are not compared');
    expect(report.verified.join('\n')).toContain('all 1 name(s) golive delivered are still present');
  });

  it('marks unreadable host env as unverifiable, never as clean', async () => {
    const { w, ctx } = setup({ config: HOST_CONFIG, state: envState('FAKE_SECRET_KEY'), arrange: (x) => void (x.host.authed = false) });
    expect(w.host.authed).toBe(false);
    const report = await detectDrift(ctx);
    expect(item(report, 'env:names')).toMatchObject({ unverifiable: true, action: 'none' });
    expect(report.verified.join(' ')).not.toContain('name(s) golive delivered');
    expect(report.notChecked.length).toBeGreaterThan(0);
    expect(report.summary.actionable).toBe(0);
  });
});

// ── Webhook endpoint ────────────────────────────────────────────────────────────────────────────

describe('drift: the webhook endpoint golive registered', () => {
  const PAY_CONFIG: Partial<ShipConfig> = { stack: { hosting: 'fakehost', payments: 'fakepay' }, domain: 'example.com', targets: ['production'], payments: { webhook: { path: '/api/hooks', events: ['checkout.session.completed'] } } };
  const payState = (registeredAt = ago(2 * DAY)) => stateWith({ 'fakepay.live.webhookEndpointId': 'we_9' }, { steps: { 'payments:webhook:production': done(registeredAt) } });

  it('reports a recorded endpoint that is gone as high drift', async () => {
    const { ctx } = setup({ config: PAY_CONFIG, state: payState() });
    const report = await detectDrift(ctx);
    const it_ = item(report, 'webhook:live:gone')!;
    expect(it_).toMatchObject({ class: 'webhook-endpoint', severity: 'high', action: 'reconcile', checkId: 'webhook-registered' });
    expect(it_.suggestedAction).toContain('https://example.com/api/hooks');
  });

  it('reports a replacement at the same URL as a change to verify, naming the signing secret', async () => {
    const { ctx } = setup({
      config: PAY_CONFIG,
      state: payState(),
      arrange: (w) => void (w.pay.endpoints = [{ id: 'we_5', url: 'https://example.com/api/hooks', events: ['checkout.session.completed'], enabled: true, mode: 'live' }]),
    });
    const report = await detectDrift(ctx);
    const it_ = item(report, 'webhook:live:replaced')!;
    expect(it_).toMatchObject({ severity: 'medium', action: 'verify' });
    expect(it_.evidence.join(' ')).toContain('signing secret');
    expect(it_.suggestedAction).toMatch(/may be intentional/);
  });

  it('reports a disabled endpoint and a missing event as medium', async () => {
    const disabled = setup({ config: PAY_CONFIG, state: payState(), arrange: (w) => void (w.pay.endpoints = [{ id: 'we_9', url: 'https://example.com/api/hooks', events: ['checkout.session.completed'], enabled: false, mode: 'live' }]) });
    expect(item(await detectDrift(disabled.ctx), 'webhook:live:disabled')).toMatchObject({ severity: 'medium', action: 'reconcile' });

    const noEvents = setup({ config: PAY_CONFIG, state: payState(), arrange: (w) => void (w.pay.endpoints = [{ id: 'we_9', url: 'https://example.com/api/hooks', events: [], enabled: true, mode: 'live' }]) });
    const it_ = item(await detectDrift(noEvents.ctx), 'webhook:live:events')!;
    expect(it_.observed).toContain('no events');
  });

  it('counts a live, enabled endpoint with the right events as verified', async () => {
    const { ctx } = setup({ config: PAY_CONFIG, state: payState(), arrange: (w) => void (w.pay.endpoints = [{ id: 'we_9', url: 'https://example.com/api/hooks', events: ['checkout.session.completed'], enabled: true, mode: 'live' }]) });
    const report = await detectDrift(ctx);
    expect(ids(report)).not.toContain('webhook:live:gone');
    expect(report.verified.join('\n')).toContain('exists, is enabled and covers 1 configured event(s)');
    expect(report.summary.actionable).toBe(0);
  });

  it('marks a signed-out payments provider as unverifiable', async () => {
    const { ctx } = setup({ config: PAY_CONFIG, state: payState(), arrange: (w) => void (w.pay.authed = false) });
    const report = await detectDrift(ctx);
    expect(item(report, 'webhook:live')).toMatchObject({ unverifiable: true, action: 'none' });
    expect(report.summary.actionable).toBe(0);
  });
});

// ── Domain attachment ───────────────────────────────────────────────────────────────────────────

describe('drift: the domain golive attached', () => {
  const DOMAIN_CONFIG: Partial<ShipConfig> = { stack: { hosting: 'fakehost' }, domain: 'example.com', targets: ['production'] };
  const attached = (at = ago(3 * DAY)) => stateWith({}, { steps: { 'domain:attach': done(at), 'domain:dns': done(at) } });

  it('reports a detached/misconfigured domain as high drift', async () => {
    const { ctx } = setup({ config: DOMAIN_CONFIG, state: attached(), arrange: (w) => void (w.host.domainStatus = 'misconfigured') });
    const report = await detectDrift(ctx);
    expect(item(report, 'domain:attach')).toMatchObject({ class: 'domain-attach', severity: 'high', action: 'reconcile', checkId: 'domain-live' });
  });

  it('treats pending as propagating inside the window, and as a finding outside it', async () => {
    const fresh = setup({ config: DOMAIN_CONFIG, state: attached(ago(1 * 60 * 1000)) });
    expect(item(await detectDrift(fresh.ctx), 'domain:attach')).toMatchObject({ severity: 'info', action: 'none' });

    const old = setup({ config: DOMAIN_CONFIG, state: attached(ago(4 * DAY)) });
    const it_ = item(await detectDrift(old.ctx), 'domain:attach')!;
    expect(it_).toMatchObject({ severity: 'medium', action: 'verify' });
    expect(it_.suggestedAction).toMatch(/may be intentional/);
  });

  it('counts an ok attachment as verified, and a signed-out host as unverifiable', async () => {
    const ok = setup({ config: DOMAIN_CONFIG, state: attached(), arrange: (w) => void (w.host.domainStatus = 'ok') });
    const okReport = await detectDrift(ok.ctx);
    expect(ids(okReport)).not.toContain('domain:attach');
    expect(okReport.verified.join('\n')).toContain('the host reports the domain ok');

    const off = setup({ config: DOMAIN_CONFIG, state: attached(), arrange: (w) => void (w.host.authed = false) });
    const offReport = await detectDrift(off.ctx);
    expect(item(offReport, 'domain:attach')).toMatchObject({ unverifiable: true, action: 'none' });
  });

  it('says so when golive never recorded an attachment to compare', async () => {
    const { ctx } = setup({ config: DOMAIN_CONFIG });
    const report = await detectDrift(ctx);
    expect(report.items).toEqual([]);
    expect(report.notChecked.map((n) => n.subject).join(' ')).toContain('host attachment');
  });
});

// ── Database project and selectors ──────────────────────────────────────────────────────────────

describe('drift: the database project and its selectors', () => {
  const DB_CONFIG: Partial<ShipConfig> = { stack: { db: 'fakedb' }, targets: ['production'] };
  const dbState = (resources: Record<string, string>) => stateWith(resources, { steps: { 'project:db': done(ago(3 * DAY)) } });

  it('reports a recorded project golive can no longer read as high, without claiming it is gone', async () => {
    const { ctx } = setup({
      config: DB_CONFIG,
      state: dbState({ 'fakedb.projectId': 'db_old' }),
      arrange: (w) => {
        w.adapters.find((a) => a.id === 'fakedb')!.capabilities.project!.resolve = async () => {
          throw new Error('FakeDB project not found');
        };
      },
    });
    const report = await detectDrift(ctx);
    const it_ = item(report, 'db:project')!;
    expect(it_).toMatchObject({ class: 'db-selectors', severity: 'high', action: 'human' });
    expect(it_.evidence.join(' ')).toContain('cannot tell them apart');
  });

  it('reports a switched project as a change to verify', async () => {
    const { ctx } = setup({ config: DB_CONFIG, state: dbState({ 'fakedb.projectId': 'db_old' }) });
    const report = await detectDrift(ctx);
    const it_ = item(report, 'db:current')!;
    expect(it_).toMatchObject({ severity: 'medium', action: 'verify' });
    expect(it_.suggestedAction).toMatch(/may be intentional/);
  });

  it('reports changed connection selectors and counts unchanged ones as verified', async () => {
    const withIdentity = (identity: Record<string, string>) => (w: FakeWorld) => {
      const adapter = w.adapters.find((a) => a.id === 'fakedb') as Adapter;
      adapter.capabilities = {
        ...adapter.capabilities,
        outputs: { outputs: async () => ({}), provides: async () => [], identity: async () => JSON.stringify(identity) },
        dbConnection: { probe: async () => ({ database: 'neondb', role: 'neondb_owner' }) },
      };
    };
    const changed = setup({ config: DB_CONFIG, state: dbState({ 'fakedb.projectId': 'db_1', 'fakedb.branchId': 'preview', 'fakedb.database': 'neondb' }), arrange: withIdentity({ branch: 'main', database: 'neondb', role: 'neondb_owner' }) });
    const it_ = item(await detectDrift(changed.ctx), 'db:selectors')!;
    expect(it_).toMatchObject({ severity: 'medium', action: 'verify', checkId: 'db-connection' });
    expect(it_.expected).toContain('branch=preview');
    expect(it_.observed).toContain('branch=main');

    const same = setup({ config: DB_CONFIG, state: dbState({ 'fakedb.projectId': 'db_1', 'fakedb.branchId': 'main' }), arrange: withIdentity({ branch: 'main', database: 'neondb', role: 'neondb_owner' }) });
    const sameReport = await detectDrift(same.ctx);
    expect(sameReport.verified.join('\n')).toContain('connection selectors unchanged');
  });

  it('marks an unreachable database provider as unverifiable, never as clean', async () => {
    const { ctx } = setup({ config: DB_CONFIG, state: dbState({ 'fakedb.projectId': 'db_1' }), arrange: (w) => void (w.db.authed = false) });
    const report = await detectDrift(ctx);
    expect(item(report, 'db:project')).toMatchObject({ unverifiable: true, action: 'none' });
    expect(report.verified.join(' ')).not.toContain('db_1');
    expect(report.summary.actionable).toBe(0);
  });
});

// ── Email sending domain and keys ───────────────────────────────────────────────────────────────

describe('drift: the email sending domain and its keys', () => {
  const MAIL_CONFIG: Partial<ShipConfig> = { stack: { email: 'fakemail' }, email: { from: 'hello@example.com' }, targets: ['production'] };
  const mailState = (resources: Record<string, string>) => stateWith(resources, { steps: { 'email:domain': done(ago(5 * DAY)), 'email:dns': done(ago(5 * DAY)) } });

  it('reports a domain the provider failed as high, a still-pending one as medium, and verified as clean', async () => {
    for (const [status, wanted] of [['failed', { severity: 'high', action: 'reconcile' }], ['pending', { severity: 'medium', action: 'verify' }], ['verified', null]] as const) {
      const stateless = status === 'verified' ? mailState({ 'fakemail.domainId': 'dom_example.com' }) : mailState({ 'fakemail.domainId': 'dom_example.com' });
      const { ctx } = setup({ config: MAIL_CONFIG, state: stateless, arrange: (w) => void w.mail.domains.set('example.com', { id: 'dom_example.com', status }) });
      const report = await detectDrift(ctx);
      if (wanted) {
        expect(item(report, 'email:domain')).toMatchObject({ class: 'email-domain', ...wanted, checkId: 'email-verified' });
      } else {
        expect(item(report, 'email:domain')).toBeUndefined();
        expect(report.verified.join('\n')).toContain('still reports it verified');
      }
    }
  });

  it('marks an unreachable email provider as unverifiable', async () => {
    const { ctx } = setup({ config: MAIL_CONFIG, state: mailState({ 'fakemail.domainId': 'dom_example.com' }), arrange: (w) => void (w.mail.authed = false) });
    const report = await detectDrift(ctx);
    expect(item(report, 'email:domain')).toMatchObject({ unverifiable: true, action: 'none' });
    expect(report.summary.actionable).toBe(0);
  });

  it('skips a recorded sending key with an honest reason instead of inventing a read', async () => {
    const { ctx } = setup({ config: MAIL_CONFIG, state: mailState({ 'fakemail.domainId': 'dom_example.com', 'fakemail.keyId@production': 'key_1' }), arrange: (w) => void w.mail.domains.set('example.com', { id: 'dom_example.com', status: 'verified' }) });
    const report = await detectDrift(ctx);
    const it_ = item(report, 'key:fakemail:production')!;
    expect(it_).toMatchObject({ class: 'sending-key', action: 'none', unverifiable: true });
    expect(it_.observed).toContain('no key read');
    expect(report.limits.join('\n')).toContain('revoked outside golive');
    expect(report.summary.actionable).toBe(0);
  });
});

// ── Payments account ────────────────────────────────────────────────────────────────────────────

describe('drift: the payments account behind the app keys', () => {
  const PAY_CONFIG: Partial<ShipConfig> = { stack: { payments: 'fakepay' }, targets: ['production'] };
  const payState = (source: string) => stateWith({ 'env:STRIPE_SECRET_KEY@production': source }, { secrets: { 'STRIPE_SECRET_KEY@production': { fp: 'cd34', at: ago(2 * DAY) } } });

  it('reports a credential that now reads another account as high, for a human to confirm', async () => {
    const { ctx } = setup({ config: PAY_CONFIG, state: payState('stripe.secretKey|fakepay|live|fp1|acct_SOMEONE_ELSE') });
    const report = await detectDrift(ctx);
    const it_ = item(report, 'payments:live:account')!;
    expect(it_).toMatchObject({ class: 'payment-account', severity: 'high', action: 'human' });
    expect(it_.expected).toContain('acct_SOMEONE_ELSE');
    expect(it_.observed).toContain('acct_FakePay');
  });

  it('counts the same account as verified and never claims a 403 is drift', async () => {
    const same = setup({ config: PAY_CONFIG, state: payState('stripe.secretKey|fakepay|live|fp1|acct_FakePay') });
    const sameReport = await detectDrift(same.ctx);
    expect(item(sameReport, 'payments:live:account')).toBeUndefined();
    expect(sameReport.verified.join('\n')).toContain('the live-mode credential still reads acct_FakePay');

    const denied = setup({
      config: PAY_CONFIG,
      state: payState('stripe.secretKey|fakepay|live|fp1|acct_FakePay'),
      arrange: (w) => {
        const cap = w.adapters.find((a) => a.id === 'fakepay')!.capabilities.paymentAccount!;
        cap.identify = async () => {
          throw Object.assign(new Error('restricted key without Account: Read'), { status: 403 });
        };
      },
    });
    const deniedReport = await detectDrift(denied.ctx);
    expect(item(deniedReport, 'payments:live')).toMatchObject({ unverifiable: true, action: 'none' });
    expect(deniedReport.summary.actionable).toBe(0);
  });

  it('reports a mode the app no longer uses in golive.yaml as medium', async () => {
    const { ctx } = setup({ config: PAY_CONFIG, state: payState('stripe.secretKey|fakepay|test|fp1|acct_FakePay') });
    const report = await detectDrift(ctx);
    const it_ = item(report, 'payments:production:mode')!;
    expect(it_).toMatchObject({ severity: 'medium', action: 'reconcile' });
    expect(it_.observed).toContain('live mode');
  });
});

// ── Host project ────────────────────────────────────────────────────────────────────────────────

describe('drift: the host project this repo links', () => {
  const HOST_CONFIG: Partial<ShipConfig> = { stack: { hosting: 'fakehost' }, targets: ['production'] };
  const hostState = (resources: Record<string, string>) => stateWith(resources, { steps: { 'project:hosting': done(ago(2 * DAY)) } });

  it('counts the recorded project as verified, and reports a different or missing link', async () => {
    const same = setup({ config: HOST_CONFIG, state: hostState({ 'fakehost.projectId': 'prj_1', 'fakehost.projectName': 'shop' }) });
    const sameReport = await detectDrift(same.ctx);
    expect(sameReport.verified.join('\n')).toContain('still the project this repo links (prj_1)');

    const other = setup({ config: HOST_CONFIG, state: hostState({ 'fakehost.projectId': 'prj_1', 'fakehost.projectName': 'shop' }), arrange: (w) => void (w.host.current = { id: 'prj_2', name: 'other' }) });
    expect(item(await detectDrift(other.ctx), 'project:hosting')).toMatchObject({ severity: 'medium', action: 'verify' });

    const none = setup({ config: HOST_CONFIG, state: hostState({ 'fakehost.projectId': 'prj_1' }), arrange: (w) => void (w.host.current = null) });
    const noneItem = item(await detectDrift(none.ctx), 'project:hosting')!;
    expect(noneItem.observed).toContain('resolves this repo to nothing');
    expect(noneItem.suggestedAction).toMatch(/may be intentional/);
  });

  it('flags a creation marker that no longer names the linked project (teardown safety)', async () => {
    const { ctx } = setup({ config: HOST_CONFIG, state: hostState({ 'fakehost.projectId': 'prj_1', 'fakehost.createdProjectId': 'prj_other' }) });
    const it_ = item(await detectDrift(ctx), 'project:hosting:marker')!;
    expect(it_).toMatchObject({ severity: 'medium', action: 'verify' });
    expect(it_.evidence.join(' ')).toContain('treats the project as adopted');
  });

  it('marks a signed-out host as unverifiable', async () => {
    const { ctx } = setup({ config: HOST_CONFIG, state: hostState({ 'fakehost.projectId': 'prj_1' }), arrange: (w) => void (w.host.authed = false) });
    const report = await detectDrift(ctx);
    expect(item(report, 'project:hosting')).toMatchObject({ unverifiable: true, action: 'none' });
    expect(report.summary.actionable).toBe(0);
  });
});

// ── Pending / stale release state ───────────────────────────────────────────────────────────────

describe('drift: release state golive never finished', () => {
  it('reports a production env write no deploy picked up', async () => {
    const { ctx } = setup({ state: stateWith({ 'redeploy:production': ago(6 * 60 * 60 * 1000) }) });
    const it_ = item(await detectDrift(ctx), 'release:redeploy')!;
    expect(it_).toMatchObject({ class: 'release-state', severity: 'medium', action: 'reconcile' });
    expect(it_.evidence.join(' ')).toContain('keeps serving the values from before that write');
  });

  it('reports a failed step that was never resumed', async () => {
    const state = stateWith({}, { steps: { 'deploy:production': { status: 'failed', at: ago(DAY), planId: 'plan_1', release: TEST_RELEASE, error: 'build failed' } } });
    const { ctx } = setup({ state });
    const it_ = item(await detectDrift(ctx), 'release:step:deploy:production')!;
    expect(it_).toMatchObject({ severity: 'medium', action: 'verify' });
    expect(it_.observed).toContain('build failed');
    expect(it_.suggestedAction).toContain('golive apply --plan <planId>');
  });

  it('keeps the re-run advice for a historical step that declares its write replayable', async () => {
    const { ctx } = setup({ state: failedStep({ release: OLDER_RELEASE }) });
    const it_ = item(await detectDrift(ctx, planWith(stepStub('auth:test-user', { writes: true, live: true, replayable: true }))), 'release:step:auth:test-user')!;
    expect(it_).toMatchObject({ severity: 'medium', action: 'verify' });
    expect(it_.suggestedAction).toContain('golive apply --plan <planId>');
    expect(it_.evidence.join(' ')).toContain('`risk.replayable`');
  });

  it('keeps the re-run advice for a historical destruction step (a deletion re-checks ownership)', async () => {
    const { ctx } = setup({ state: failedStep({ release: OLDER_RELEASE }) });
    const it_ = item(await detectDrift(ctx, planWith(stepStub('auth:test-user', { writes: true, destroy: true }))), 'release:step:auth:test-user')!;
    expect(it_).toMatchObject({ severity: 'medium', action: 'verify' });
    expect(it_.evidence.join(' ')).toContain('a deletion re-checks ownership and is idempotent');
  });

  it('sends a historical write the guard refuses to the reviewed reconciliation path instead of an impossible apply', async () => {
    const { ctx } = setup({ state: failedStep({ release: OLDER_RELEASE }) });
    const it_ = item(await detectDrift(ctx, planWith(stepStub('auth:test-user', { writes: true, live: true }))), 'release:step:auth:test-user')!;
    expect(it_).toMatchObject({ severity: 'medium', action: 'human' });
    // The record and the runtime are both named, and nothing suggests the command that would refuse.
    expect(it_.evidence.join(' ')).toContain(`written by release 0.1.0-alpha.9 (bundle ${'b'.repeat(8)}), while this runtime is release ${TEST_RELEASE.version} (bundle ${'a'.repeat(8)})`);
    expect(it_.evidence.join(' ')).toContain('declares neither `risk.replayable` nor `destroy`');
    expect(it_.suggestedAction).toContain('cannot replay this step automatically');
    expect(it_.suggestedAction).toContain('references/updates.md');
    expect(it_.suggestedAction).not.toContain('golive apply --plan');
  });

  it('blocks a historical step the current plan no longer carries, and one whose plan could not be read', async () => {
    const { ctx } = setup({ state: failedStep({ release: OLDER_RELEASE }) });
    const dropped = item(await detectDrift(ctx, planWith(stepStub('deploy:production', { writes: true }))), 'release:step:auth:test-user')!;
    expect(dropped).toMatchObject({ action: 'human' });
    expect(dropped.evidence.join(' ')).toContain('the current plan does not carry auth:test-user');

    const unobserved = item(await detectDrift(ctx, null), 'release:step:auth:test-user')!;
    expect(unobserved).toMatchObject({ action: 'human' });
    expect(unobserved.evidence.join(' ')).toContain('could not observe the current plan');
  });
});

// ── The command ─────────────────────────────────────────────────────────────────────────────────

describe('golive status', () => {
  let root: string;
  const oldArgv = process.argv;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'golive-status-'));
    writeFileSync(join(root, 'golive.yaml'), JSON.stringify({ version: 1, stack: { hosting: 'fakehost' }, domain: 'example.com', targets: ['production'] }));
    mocks.adapters.splice(0);
    vi.stubGlobal('fetch', vi.fn(() => { throw new Error('status must not use the network in tests'); }));
  });
  afterEach(() => {
    process.argv = oldArgv;
    vi.unstubAllGlobals();
    rmSync(root, { recursive: true, force: true });
  });

  async function runCli(args: string[]) {
    vi.resetModules();
    process.argv = ['node', 'golive', ...args, '--cwd', root, '--json'];
    const chunks: string[] = [];
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { chunks.push(String(chunk)); return true; });
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    await import('../src/cli.js');
    await vi.waitFor(() => expect(exit).toHaveBeenCalled());
    const result = { output: chunks.join(''), code: exit.mock.calls.at(-1)?.[0] as number };
    stdout.mockRestore(); exit.mockRestore();
    return result;
  }

  function writeState(w: FakeWorld, resources: Record<string, string>, secrets: ShipState['secrets'] = {}, over: Partial<ShipState> = {}): void {
    mocks.adapters.push(...w.adapters);
    mkdirSync(join(root, '.golive'), { recursive: true });
    writeFileSync(join(root, '.golive/state.json'), JSON.stringify(stateWith(resources, { secrets, ...over })));
  }

  it('reports a historical write as human work, leaves state alone and names the reconciliation path', async () => {
    const w = fakeWorld();
    const steps = { 'deploy:production': { status: 'failed' as const, at: ago(DAY), planId: 'plan_1', release: OLDER_RELEASE, error: 'build failed' } };
    writeState(w, {}, {}, { steps });
    const before = readFileSync(join(root, '.golive/state.json'), 'utf8');

    const { output, code } = await runCli(['status']);
    const json = JSON.parse(output) as { items: Array<{ id: string; action: string; evidence: string[]; suggestedAction?: string }> };
    const it_ = json.items.find((i) => i.id === 'release:step:deploy:production')!;
    expect(code).toBe(2);
    expect(it_.action).toBe('human');
    expect(it_.evidence.join(' ')).toContain('not replayed automatically');
    expect(it_.evidence.join(' ')).toContain('deploy:production is a write that declares neither `risk.replayable` nor `destroy`');
    expect(it_.suggestedAction).toContain('cannot replay this step automatically');
    expect(it_.suggestedAction).toContain('references/updates.md');
    expect(it_.suggestedAction).not.toContain('golive apply --plan');
    expect(readFileSync(join(root, '.golive/state.json'), 'utf8')).toBe(before);
  });

  it('prints the report and exits 2 when something needs acting on', async () => {
    const w = fakeWorld();
    writeState(w, { 'env:FAKE_SECRET_KEY@production': 'supabase.secretKey|fakedb|ref_1' }, { 'FAKE_SECRET_KEY@production': { fp: 'ab12', at: ago(DAY) } });
    const before = readFileSync(join(root, '.golive/state.json'), 'utf8');

    const { output, code } = await runCli(['status']);
    const json = JSON.parse(output) as { ok: boolean; items: Array<{ id: string; action: string }>; summary: { actionable: number }; notChecked: unknown[]; note?: string };
    expect(code).toBe(2);
    expect(json.ok).toBe(false);
    expect(json.items.filter((i) => i.action !== 'none').map((i) => i.id)).toEqual(['env:production:FAKE_SECRET_KEY']);
    expect(json.summary.actionable).toBe(1);
    expect(json.note).toMatch(/not a clean bill of health/);
    // Read-only: no state rewrite, no report written.
    expect(readFileSync(join(root, '.golive/state.json'), 'utf8')).toBe(before);
    expect(existsSync(join(root, '.golive/report.json'))).toBe(false);
    expect(existsSync(join(root, 'GOLIVE_REPORT.md'))).toBe(false);
  });

  it('exits 0 when nothing is actionable, and says what it could not compare', async () => {
    const w = fakeWorld();
    w.host.env.production.set('FAKE_SECRET_KEY', 'x');
    writeState(w, { 'env:FAKE_SECRET_KEY@production': 'supabase.secretKey|fakedb|ref_1' }, { 'FAKE_SECRET_KEY@production': { fp: 'ab12', at: ago(DAY) } });

    const { output, code } = await runCli(['status']);
    const json = JSON.parse(output) as { ok: boolean; verified: string[]; notChecked: unknown[]; note?: string };
    expect(code).toBe(0);
    expect(json.ok).toBe(true);
    expect(json.verified.join('\n')).toContain('all 1 name(s) golive delivered are still present');
    expect(json.notChecked.length).toBeGreaterThan(0);
    expect(json.note).toMatch(/not a clean bill of health/);
  });

  it('exits 0 with every provider unreachable, and never calls that clean', async () => {
    const w = fakeWorld();
    w.host.authed = false;
    writeState(w, { 'env:FAKE_SECRET_KEY@production': 'supabase.secretKey|fakedb|ref_1' }, { 'FAKE_SECRET_KEY@production': { fp: 'ab12', at: ago(DAY) } });

    const { output, code } = await runCli(['status']);
    const json = JSON.parse(output) as { ok: boolean; items: Array<{ unverifiable?: boolean; action: string }>; verified: string[]; summary: { items: number; unverifiable: number } };
    expect(code).toBe(0);
    expect(json.items.length).toBeGreaterThan(0);
    expect(json.items.every((i) => i.unverifiable === true && i.action === 'none')).toBe(true);
    expect(json.summary.unverifiable).toBe(json.summary.items);
    expect(json.verified).toEqual([]);
  });

  it('is listed in help', async () => {
    const { output, code } = await runCli(['help']);
    expect(code).toBe(0);
    expect(output).toContain('status');
    expect(output).toContain("changed behind golive's back");
  });
});
