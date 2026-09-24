/**
 * The inventory: what golive can prove it created, and the proof behind each entry. Everything here
 * is a fake provider — no network, no account. The plan-id assertion is the guard that this
 * enumeration stayed byte-identical for teardown after it moved out of `teardown.ts`.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { _resetSecretRegistry } from '../src/core/secret.js';
import { buildInventory } from '../src/core/inventory.js';
import { buildTeardownPlan } from '../src/core/teardown.js';
import { emptyState } from '../src/core/state.js';
import type { DnsRecord, ShipConfig, ShipState } from '../src/core/types.js';
import { testCtx } from './helpers.js';
import { fakeWorld, type FakeWorld } from './fakes.js';

beforeEach(() => _resetSecretRegistry());

const CONFIG: Partial<ShipConfig> = {
  stack: { hosting: 'fakehost', db: 'fakedb', auth: 'fakedb', payments: 'fakepay', email: 'fakemail', dns: 'fakedns' },
  domain: 'example.com',
  email: { from: 'Shop <hello@example.com>', domain: 'send.example.com' },
};

const OWNED: DnsRecord[] = [
  { type: 'TXT', name: '_vercel.example.com', content: 'vc-domain-verify=shop,abc123' },
  { type: 'CNAME', name: 'www.example.com', content: 'shop.fakehost.app' },
  { type: 'A', name: 'example.com', content: '76.76.21.21' },
];

const STATE: ShipState = {
  ...emptyState(),
  resources: {
    'fakehost.projectId': 'prj_1',
    'fakehost.projectName': 'shop',
    'fakehost.createdProjectId': 'prj_1',
    'fakepay.test.webhookEndpointId': 'we_test',
    'fakemail.keyId@production': 'key_9',
    'supabase.ref': 'abcdefghijklmnop',
    'supabase.createdByGolive': 'abcdefghijklmnop',
    'resend.domainId': 'dom_42',
  },
};

function setup(state: ShipState = STATE, configure: (w: FakeWorld) => void = () => undefined) {
  const w = fakeWorld();
  w.dns.owned = [...OWNED];
  w.pay.endpoints = [{ id: 'we_test', url: 'https://example.com/api/webhooks/stripe', events: [], enabled: true, mode: 'test' }];
  configure(w);
  const ctx = testCtx({ cwd: '/work/shop', adapters: w.adapters, config: CONFIG, state });
  return { w, ctx, inventory: () => buildInventory(ctx) };
}

describe('inventory', () => {
  it('enumerates every resource golive created, in a fixed order, with its proof', async () => {
    const { w, inventory } = await setup();
    const inv = await inventory();
    expect(inv.dnsRecords.map((r) => [r.domain, r.record.type, r.record.name])).toEqual([
      ['example.com', 'A', 'example.com'],
      ['example.com', 'CNAME', 'www.example.com'],
      ['example.com', 'TXT', '_vercel.example.com'],
    ]);
    expect(w.calls.filter((c) => c.method === 'dns.listOwned').map((c) => c.args[0])).toEqual(['example.com', 'send.example.com']);
    expect(inv.webhooks).toEqual([expect.objectContaining({ provider: 'fakepay', mode: 'test', id: 'we_test', key: 'fakepay.test.webhookEndpointId' })]);
    expect(inv.webhooks[0]!.removal).toBeDefined();
    expect(inv.sendingKeys).toEqual([expect.objectContaining({ provider: 'fakemail', target: 'production', id: 'key_9' })]);
    expect(inv.project).toMatchObject({ provider: 'fakehost', id: 'prj_1', name: 'shop', created: true });
    expect(inv.recorded.map((r) => [r.provider, r.id, r.created])).toEqual([
      ['supabase', 'abcdefghijklmnop', true],
      ['resend', 'dom_42', true],
    ]);
  });

  it('proves ownership from the provider marker, state record or creation marker, never by assumption', async () => {
    const adopted = await setup({ ...STATE, resources: { ...STATE.resources, 'fakehost.createdProjectId': 'prj_other' } }).inventory();
    expect(adopted.project).toMatchObject({ created: false });
    const otherDb = await setup({ ...STATE, resources: { ...STATE.resources, 'supabase.createdByGolive': 'someone-else' } }).inventory();
    expect(otherDb.recorded.find((r) => r.provider === 'supabase')).toMatchObject({ created: false });
  });

  it('keeps a recorded resource golive cannot remove, without a removal handle', async () => {
    const { inventory } = await setup(undefined, (w) => { w.pay.authed = false; w.mail.authed = false; });
    const inv = await inventory();
    expect(inv.webhooks[0]).toMatchObject({ id: 'we_test' });
    expect(inv.webhooks[0]!.removal).toBeUndefined();
    expect(inv.sendingKeys[0]!.revocation).toBeUndefined();
  });

  it('inventories nothing for a DNS provider that cannot list golive-owned records', async () => {
    const { inventory } = await setup(undefined, (w) => { w.dns.withOwned = false; });
    expect((await inventory()).dnsRecords).toEqual([]);
  });

  it('drops a host that cannot delete projects, and a project that was never linked', async () => {
    expect((await setup(undefined, (w) => void (w.host.canRemoveProject = false)).inventory()).project).toBeNull();
    expect((await setup(emptyState()).inventory()).project).toBeNull();
  });

  it('keeps the teardown plan identity for this fixture: same id, steps and handoffs as before the extraction', async () => {
    // Frozen on purpose: a teardown plan id hashes step order, previews, intent and handoff ids, so
    // any change here is a change to an approval identity a human may already have given.
    const { ctx } = setup(undefined, (w) => void (w.pay.endpoints = [{ id: 'we_test', url: 'https://example.com/hook', events: [], enabled: true, mode: 'test' }]));
    const plan = await buildTeardownPlan(ctx);
    expect(plan.id).toBe('e90424ab310c');
    expect(plan.steps.map((s) => s.id)).toEqual([
      'teardown:webhook:fakepay:test',
      'teardown:dns:fakedns:A:example.com',
      'teardown:dns:fakedns:CNAME:www.example.com',
      'teardown:dns:fakedns:TXT:_vercel.example.com',
      'teardown:key:fakemail:production',
      'teardown:project:hosting',
    ]);
    expect(plan.handoffs.map((h) => h.id)).toEqual(['teardown:db:supabase', 'teardown:email:resend']);
  });
});
