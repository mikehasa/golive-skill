import { describe, expect, it } from 'vitest';
import { ADAPTERS, GUIDED } from '../src/adapters/index.js';
import { createHttp } from '../src/core/http.js';
import { buildPlan, planView } from '../src/core/plan.js';
import { applyPlan } from '../src/core/runner.js';
import { accountsLink } from '../src/links/accounts.js';
import { domainLink } from '../src/links/domain.js';
import { emailDomainLink } from '../src/links/email.js';
import { fakeWorld } from './fakes.js';
import { testCtx } from './helpers.js';

describe.each(['godaddy', 'porkbun'])('%s DNS integration', (id) => {
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
