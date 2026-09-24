import { describe, expect, it } from 'vitest';
import { ADAPTERS, GUIDED } from '../src/adapters/index.js';
import { createHttp } from '../src/core/http.js';
import { buildPlan, planView } from '../src/core/plan.js';
import { applyPlan } from '../src/core/runner.js';
import { accountsLink } from '../src/links/accounts.js';
import { domainLink } from '../src/links/domain.js';
import { emailDomainLink } from '../src/links/email.js';
import { fakeWorld } from './fakes.js';
import { mockHttp, testCtx } from './helpers.js';

describe.each(['cloudflare', 'godaddy', 'porkbun'])('%s DNS integration', (id) => {
  it('is a registered automated DNS provider with no duplicate guided option', () => {
    const providers = ADAPTERS.filter((a) => a.id === id);
    expect(providers).toHaveLength(1);
    expect(providers[0]).toMatchObject({ automated: true, axes: ['dns'] });
    expect(providers[0]!.capabilities.dns).toBeDefined();
    expect(GUIDED.some((a) => a.id === id)).toBe(false);
  });

  it('hands off missing credentials instead of planning DNS writes', async () => {
    const w = fakeWorld();
    const provider = ADAPTERS.find((a) => a.id === id)!;
    const ctx = testCtx({
      adapters: [...w.adapters, provider],
      config: { stack: { hosting: 'fakehost', dns: id }, domain: 'example.com' },
    });
    const plan = await buildPlan(ctx, [accountsLink, domainLink], { unmappedEnv: [], warnings: [] });
    expect(plan.handoffs.some((h) => h.id === `login:${id}`)).toBe(true);
    expect(plan.steps.some((s) => s.id === 'domain:dns')).toBe(false);
    expect(w.dns.records).toEqual([]);
  });

  it('routes DNS through the selected capability only after explicit DNS approval', async () => {
    const w = fakeWorld();
    const real = ADAPTERS.find((a) => a.id === id)!;
    const fake = w.adapters.find((a) => a.id === 'fakedns')!;
    const provider = { ...real, auth: fake.auth, capabilities: fake.capabilities };
    const ctx = testCtx({
      adapters: [...w.adapters, provider],
      config: { stack: { hosting: 'fakehost', dns: id }, domain: 'example.com' },
    });
    const plan = await buildPlan(ctx, [accountsLink, domainLink], { unmappedEnv: [], warnings: [] });
    const dns = planView(plan).steps.find((s) => s.id === 'domain:dns')!;
    expect(dns.title).toContain(real.title);
    expect(dns.needs).toContain('--confirm-dns');
    expect(dns.preview.join('\n')).toContain(real.title);

    const opts = { approvedPlanId: plan.id, yes: true, confirmLive: false, confirmDns: false };
    const blocked = await applyPlan(ctx, plan, new Map(), opts);
    expect(blocked.find((s) => s.id === 'domain:dns')?.status).toBe('blocked');
    expect(w.dns.records).toEqual([]);

    const applied = await applyPlan(ctx, plan, new Map(), { ...opts, confirmDns: true });
    const outcome = applied.find((s) => s.id === 'domain:dns');
    expect(outcome?.status).toBe('done');
    expect(outcome?.checks).toContainEqual(expect.objectContaining({ id: 'domain:dns:records', status: 'pass' }));
    expect(w.dns.records).toEqual(w.host.records.map((r) => ({ ...r, proxied: false })));
    expect(w.calls.filter((c) => c.method === 'dns.upsert')).toHaveLength(1);
  });

  it('allows only the exact official API host through the HTTP transport', async () => {
    const calls: string[] = [];
    const http = createHttp((async (input: Parameters<typeof fetch>[0]) => {
      calls.push(String(input));
      return new Response('{}', { status: 200 });
    }) as typeof fetch);
    await expect(http({ url: `https://api.${id}.com/` })).resolves.toMatchObject({ status: 200 });
    await expect(http({ url: `https://api.${id}.com.attacker.example/` })).rejects.toThrow('host not allowed');
    await expect(http({ url: `http://api.${id}.com/` })).rejects.toThrow('non-https');
    expect(calls).toEqual([`https://api.${id}.com/`]);
  });

  it('uses the selected DNS provider for email records while preserving existing mail records', async () => {
    const w = fakeWorld();
    const real = ADAPTERS.find((a) => a.id === id)!;
    const fake = w.adapters.find((a) => a.id === 'fakedns')!;
    const provider = { ...real, auth: fake.auth, capabilities: fake.capabilities };
    const existing = { type: 'MX' as const, name: 'example.com', content: 'mail.example.com', priority: 10 };
    w.dns.records.push(existing);
    const ctx = testCtx({
      adapters: [...w.adapters, provider],
      config: { stack: { email: 'fakemail', dns: id }, email: { from: 'hello@example.com' } },
    });
    const plan = await buildPlan(ctx, [accountsLink, emailDomainLink], { unmappedEnv: [], warnings: [] });
    const dns = planView(plan).steps.find((s) => s.id === 'email:dns')!;
    expect(dns.title).toContain(real.title);
    expect(dns.needs).toContain('--confirm-dns');
    const opts = { approvedPlanId: plan.id, yes: true, confirmLive: false, confirmDns: false };
    const blocked = await applyPlan(ctx, plan, new Map(), opts);
    expect(blocked.find((s) => s.id === 'email:dns')?.status).toBe('blocked');
    expect(w.dns.records).toEqual([existing]);

    // This test covers dispatch and approval; provider-specific tests cover transport and conflicts.
    await applyPlan(ctx, plan, new Map(), { ...opts, confirmDns: true });
    expect(w.dns.records).toContainEqual(existing);
    expect(w.calls.filter((c) => c.method === 'dns.upsert')).toHaveLength(3);
    expect(w.dns.records.map((r) => r.name)).toEqual(expect.arrayContaining(['send.example.com', 'fm._domainkey.example.com']));
  });
});

// ── Cloudflare with its REAL adapter against a mocked api.cloudflare.com ─────────────────────────
// The shared cases above swap in the fake DnsZone; these run the actual Cloudflare capability so the
// plan/apply flow exercises the REST envelope (zones-by-name lookup, dns_records list/create).

const CF_TOKEN = 'cfut_TESTplanLevelToken0123456789abcdef';
const CF_API = 'https://api.cloudflare.com/client/v4';
const CF_ZONE = { id: 'zone123', name: 'example.com', status: 'active' };

interface CfZone {
  id: string;
  name: string;
  status: string;
}
interface CfRec {
  id: string;
  type: string;
  name: string;
  content: string;
  [k: string]: unknown;
}

/** A stateful fake of the Cloudflare v4 API: token verify, zones-by-name lookup, dns_records list/create. */
function fakeCloudflareApi(opts: { zones?: Record<string, CfZone>; zoneError?: { status: number; errors: Array<{ code: number; message: string }> } } = {}) {
  const zones = opts.zones ?? { 'example.com': CF_ZONE };
  const records: CfRec[] = [];
  let nextId = 1;
  const m = mockHttp([
    ['GET', `${CF_API}/user/tokens/verify`, () => ({ json: { success: true, result: { id: 't1', status: 'active' } } })],
    [
      'GET',
      new RegExp(`^${CF_API}/zones\\?`),
      (c) => {
        if (opts.zoneError) return { status: opts.zoneError.status, json: { success: false, errors: opts.zoneError.errors, result: null } };
        const name = new URL(c.url).searchParams.get('name') ?? '';
        const z = zones[name];
        return { json: { success: true, result: z ? [z] : [], result_info: { page: 1, total_pages: 1 } } };
      },
    ],
    [
      'GET',
      /\/zones\/zone123\/dns_records\?/,
      (c) => {
        const exact = new URL(c.url).searchParams.get('name.exact');
        return { json: { success: true, result: exact ? records.filter((r) => r.name === exact) : records, result_info: { page: 1, total_pages: 1 } } };
      },
    ],
    [
      'POST',
      /\/zones\/zone123\/dns_records$/,
      (c) => {
        const rec = { ...(c.body as Record<string, unknown>), id: `rec${nextId++}` } as CfRec;
        records.push(rec);
        return { json: { success: true, result: rec } };
      },
    ],
  ]);
  return { ...m, records };
}

function cfPlanCtx(api: ReturnType<typeof fakeCloudflareApi>, w: ReturnType<typeof fakeWorld>) {
  return testCtx({
    adapters: [...w.adapters, ADAPTERS.find((a) => a.id === 'cloudflare')!],
    http: api.http,
    tokens: { CLOUDFLARE_API_TOKEN: CF_TOKEN },
    config: { stack: { hosting: 'fakehost', dns: 'cloudflare' }, domain: 'example.com' },
  });
}

describe('cloudflare DNS integration (real adapter, mocked api.cloudflare.com)', () => {
  it('plans and applies domain:dns through the REST API only after --confirm-dns', async () => {
    const w = fakeWorld();
    const api = fakeCloudflareApi();
    const ctx = cfPlanCtx(api, w);
    const plan = await buildPlan(ctx, [accountsLink, domainLink], { unmappedEnv: [], warnings: [] });
    const dns = planView(plan).steps.find((s) => s.id === 'domain:dns')!;
    expect(dns.title).toBe('Point example.com at FakeHost via Cloudflare');
    expect(dns.needs).toEqual(['--confirm-dns']);
    expect(dns.preview.join('\n')).toContain('upsert at Cloudflare: A example.com = 76.76.21.21 (not proxied)');
    // Cloudflare finds the zone by API name lookup (the others use public DoH delegation).
    const lookup = api.calls.find((c) => c.url.startsWith(`${CF_API}/zones?`))!;
    expect(new URL(lookup.url).searchParams.get('name')).toBe('example.com');
    expect(new URL(lookup.url).searchParams.get('status')).toBe('active');

    const opts = { approvedPlanId: plan.id, yes: true, confirmLive: false, confirmDns: false };
    const blocked = await applyPlan(ctx, plan, new Map(), opts);
    const b = blocked.find((s) => s.id === 'domain:dns');
    expect(b?.status).toBe('blocked');
    expect(b?.next).toBe('needs explicit human confirmation: --confirm-dns');
    expect(api.calls.filter((c) => c.method === 'POST')).toHaveLength(0);

    const applied = await applyPlan(ctx, plan, new Map(), { ...opts, confirmDns: true });
    const outcome = applied.find((s) => s.id === 'domain:dns');
    expect(outcome?.status).toBe('done');
    expect(outcome?.checks).toContainEqual(expect.objectContaining({ id: 'domain:dns:records', status: 'pass' }));
    const posts = api.calls.filter((c) => c.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(posts[0]!.url).toBe(`${CF_API}/zones/zone123/dns_records`);
    expect(posts[0]!.body).toEqual({ type: 'A', name: 'example.com', content: '76.76.21.21', ttl: 1, proxied: false, comment: 'golive: managed' });
    // The token travels only in the Authorization header, never in URLs, bodies or logs.
    for (const c of api.calls) {
      expect(c.url).not.toContain(CF_TOKEN);
      expect(JSON.stringify(c.body ?? null)).not.toContain(CF_TOKEN);
      expect(c.headers.authorization).toBe(`Bearer ${CF_TOKEN}`);
    }
    expect(ctx.logs.join('\n')).not.toContain(CF_TOKEN);
  });

  it('plans a DNS handoff (not a step) when the account has no zone for the domain', async () => {
    const w = fakeWorld();
    const api = fakeCloudflareApi({ zones: {} });
    const ctx = cfPlanCtx(api, w);
    const plan = await buildPlan(ctx, [accountsLink, domainLink], { unmappedEnv: [], warnings: [] });
    expect(plan.steps.some((s) => s.id === 'domain:dns')).toBe(false);
    const handoff = plan.handoffs.find((h) => h.id === 'domain:dns');
    expect(handoff).toBeDefined();
    expect(handoff!.action).toContain("Cloudflare doesn't host this zone in this account");
    expect(handoff!.action).toContain('A example.com = 76.76.21.21'); // the host's required records are listed
    expect(handoff!.blocking).toBe(true);
    expect(handoff!.verifiedBy).toBe('domain-live');
    expect(plan.warnings).toEqual([]);
    // The zone was looked up by API name; nothing was written.
    expect(api.calls.some((c) => c.url.startsWith(`${CF_API}/zones?`))).toBe(true);
    expect(api.calls.every((c) => c.method === 'GET')).toBe(true);
  });

  it('turns a zone-lookup failure into a plan warning: no DNS step, no handoff', async () => {
    const w = fakeWorld();
    const api = fakeCloudflareApi({ zoneError: { status: 403, errors: [{ code: 9109, message: 'Unauthorized to access requested resource' }] } });
    const ctx = cfPlanCtx(api, w);
    const plan = await buildPlan(ctx, [accountsLink, domainLink], { unmappedEnv: [], warnings: [] });
    expect(plan.steps.some((s) => s.id === 'domain:dns')).toBe(false);
    expect(plan.handoffs.some((h) => h.id === 'domain:dns')).toBe(false);
    const warnings = plan.warnings.join('\n');
    expect(warnings).toContain('checking whether Cloudflare hosts example.com failed');
    expect(warnings).toContain('HTTP 403');
    expect(warnings).toContain('Zone:DNS:Edit'); // actionable fix, not just a status code
    expect(warnings).not.toContain("doesn't host this zone");
    expect(warnings).not.toContain(CF_TOKEN);
  });
});
