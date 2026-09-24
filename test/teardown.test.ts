/**
 * Teardown plan: the deterministic inverse of what golive created, and the gates that stand between
 * an approved plan and a real deletion. All providers are fakes; no network, no account.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { _resetSecretRegistry, Secret } from '../src/core/secret.js';
import { buildPlan } from '../src/core/plan.js';
import { applyPlan } from '../src/core/runner.js';
import { approvedPlan, buildTeardownPlan } from '../src/core/teardown.js';
import { emptyState } from '../src/core/state.js';
import { ALL_LINKS } from '../src/links/all.js';
import type { Adapter, Ctx, DnsRecord, Plan, ShipConfig, ShipState, Step } from '../src/core/types.js';
import { TEST_RELEASE, testCtx } from './helpers.js';
import { RAW, fakeWorld, type FakeWorld } from './fakes.js';

beforeEach(() => _resetSecretRegistry());

const CONFIG: Partial<ShipConfig> = {
  stack: { hosting: 'fakehost', db: 'fakedb', auth: 'fakedb', payments: 'fakepay', email: 'fakemail', dns: 'fakedns' },
  domain: 'example.com',
  email: { from: 'Shop <hello@example.com>', domain: 'send.example.com' },
};

const A_RECORD: DnsRecord = { type: 'A', name: 'example.com', content: '76.76.21.21' };
const OWNED: DnsRecord[] = [
  { type: 'TXT', name: '_vercel.example.com', content: 'vc-domain-verify=shop,abc123' },
  { type: 'CNAME', name: 'www.example.com', content: 'shop.fakehost.app' },
  A_RECORD,
];

/** A project golive created: the creation marker matches the linked project id. */
const CREATED_PROJECT = { 'fakehost.projectId': 'prj_1', 'fakehost.projectName': 'shop', 'fakehost.createdProjectId': 'prj_1' };

function setup(opts: { config?: Partial<ShipConfig>; state?: ShipState; arrange?: (w: FakeWorld) => void } = {}) {
  const w = fakeWorld();
  opts.arrange?.(w);
  const ctx = testCtx({
    cwd: '/work/shop',
    adapters: w.adapters,
    config: { ...CONFIG, ...opts.config },
    state: opts.state,
  });
  return { w, ctx, build: () => buildTeardownPlan(ctx) };
}

const stateWith = (resources: Record<string, string>): ShipState => ({ ...emptyState(), resources });
const ADMIN = { yes: true, confirmLive: true, confirmDns: true, confirmDestroy: true };
const apply = (ctx: Parameters<typeof applyPlan>[0], plan: Plan, opts: Partial<Parameters<typeof applyPlan>[3]> = {}) =>
  applyPlan(ctx, plan, new Map(), { ...ADMIN, approvedPlanId: plan.id, ...opts });
const ids = (p: Plan) => p.steps.map((s) => s.id);
const byId = (p: Plan, id: string): Step => {
  const s = p.steps.find((x) => x.id === id);
  if (!s) throw new Error(`no step ${id} in ${ids(p).join(', ')}`);
  return s;
};
const calls = (w: FakeWorld, method: string) => w.calls.filter((c) => c.method === method);

// ── DNS records ─────────────────────────────────────────────────────────────────────────────────

describe('teardown: DNS records', () => {
  it('plans one destroy step per golive-owned record, sorted by type/name/content', async () => {
    const { w, build } = setup({ arrange: (w) => void (w.dns.owned = [...OWNED]) });
    const plan = await build();

    expect(ids(plan)).toEqual(['teardown:dns:fakedns:A:example.com', 'teardown:dns:fakedns:CNAME:www.example.com', 'teardown:dns:fakedns:TXT:_vercel.example.com']);
    const step = byId(plan, 'teardown:dns:fakedns:CNAME:www.example.com');
    expect(step.kind).toBe('destroy');
    expect(step.risk).toEqual({ writes: true, destroy: true, dns: true });
    expect(step.preview).toEqual(['delete the FakeDNS record golive created: CNAME www.example.com = shop.fakehost.app']);
    expect(step.dependsOn).toEqual([]);
    expect(step.verifyWith).toEqual([]);
    // both configured domains are read (the email domain is a subdomain, not a repeat of the app domain)
    expect(calls(w, 'dns.listOwned').map((c) => c.args[0])).toEqual(['example.com', 'send.example.com']);
    expect(plan.handoffs).toEqual([]);
  });

  it('never enumerates records golive does not own', async () => {
    const { build } = setup({
      arrange: (w) => {
        w.dns.owned = [A_RECORD];
        // In the zone, but not reported as golive-owned: the human's records must stay out of the plan.
        w.dns.records = [A_RECORD, { type: 'CNAME', name: 'www.example.com', content: 'someone-elses-host.app' }, { type: 'MX', name: 'example.com', content: 'mail.other.com', priority: 10 }];
      },
    });
    expect(ids(await build())).toEqual(['teardown:dns:fakedns:A:example.com']);
  });

  it('skips a DNS provider that cannot enumerate golive-owned records, with no handoff', async () => {
    const { build } = setup({ arrange: (w) => { w.dns.withOwned = false; w.dns.owned = [...OWNED]; } });
    const plan = await build();
    expect(plan.steps).toEqual([]);
    expect(plan.handoffs).toEqual([]);
  });

  it('refuses an ambiguous pair of records instead of guessing which one to delete', async () => {
    const { build } = setup({
      arrange: (w) => void (w.dns.owned = [
        { type: 'TXT', name: 'example.com', content: 'v=spf1 include:a.example.com ~all' },
        { type: 'TXT', name: 'example.com', content: 'google-site-verification=abc' },
      ]),
    });
    await expect(build()).rejects.toThrow(/teardown:dns:fakedns:TXT:example.com/);
  });

  it('deletes the record and proves it is gone from the provider-owned list', async () => {
    const { w, ctx, build } = setup({ arrange: (w) => void (w.dns.owned = [A_RECORD]) });
    const plan = await build();
    const out = await apply(ctx, plan);

    expect(out.map((o) => [o.id, o.status])).toEqual([['teardown:dns:fakedns:A:example.com', 'done']]);
    expect(out[0]!.changes).toEqual(['deleted: A example.com = 76.76.21.21']);
    expect(calls(w, 'dns.remove').map((c) => [c.args[0], c.args[1]])).toEqual([['example.com', A_RECORD]]);
    expect(w.dns.owned).toEqual([]);
    expect(out[0]!.checks.map((c) => [c.id, c.status, c.severity])).toEqual([['teardown:dns:fakedns:A:example.com:removed', 'pass', 'info']]);
  });

  it('reports a record that is already gone as done', async () => {
    const { w, ctx, build } = setup({ arrange: (w) => void (w.dns.owned = [A_RECORD]) });
    const plan = await build();
    w.dns.owned = []; // deleted in the provider dashboard between planning and apply

    const out = await apply(ctx, plan);
    expect(out.map((o) => [o.id, o.status])).toEqual([['teardown:dns:fakedns:A:example.com', 'done']]);
    expect(out[0]!.changes).toEqual(['already gone: A example.com = 76.76.21.21']);
    expect(out[0]!.checks[0]).toMatchObject({ status: 'pass', severity: 'info' });
  });

  it('fails the step and stops the run when the provider refuses the delete', async () => {
    const { w, ctx, build } = setup({
      arrange: (w) => {
        w.dns.owned = [A_RECORD];
        w.dns.removeError = 'refusing to delete a record golive does not own';
      },
      state: stateWith(CREATED_PROJECT),
    });
    const plan = await build();
    expect(ids(plan)).toEqual(['teardown:dns:fakedns:A:example.com', 'teardown:project:hosting']);

    const out = await apply(ctx, plan);
    expect(out.map((o) => [o.id, o.status])).toEqual([['teardown:dns:fakedns:A:example.com', 'failed']]);
    expect(out[0]!.error).toMatch(/does not own/);
    expect(calls(w, 'project.remove')).toEqual([]); // the run stopped; the project step never ran
    expect(ctx.state.get().steps['teardown:project:hosting']).toBeUndefined();
  });

  it('fails when the provider still lists the record after reporting the delete', async () => {
    const { ctx, build } = setup({ config: { stack: { dns: 'stubborn' }, email: undefined }, arrange: (w) => void (w.adapters = [...w.adapters, stubbornDns([A_RECORD])]) });
    const plan = await build();
    const out = await apply(ctx, plan);

    expect(out.map((o) => [o.id, o.status])).toEqual([['teardown:dns:stubborn:A:example.com', 'failed']]);
    expect(out[0]!.checks[0]).toMatchObject({ status: 'fail', severity: 'high' });
    expect(out[0]!.next).toMatch(/dashboard/);
    const record = ctx.state.get().steps['teardown:dns:stubborn:A:example.com'];
    expect(record?.status).toBe('failed');
    expect(record?.error).toMatch(/verification failed/);
  });

  it('warns instead of failing when the provider cannot be re-read after the delete', async () => {
    const { ctx, build } = setup({
      config: { stack: { dns: 'stubborn' }, email: undefined },
      arrange: (w) => void (w.adapters = [...w.adapters, stubbornDns([A_RECORD], { listError: 'rate limited' })]),
    });
    const plan = await build();
    const out = await apply(ctx, plan);

    expect(out.map((o) => [o.id, o.status])).toEqual([['teardown:dns:stubborn:A:example.com', 'done']]);
    expect(out[0]!.checks[0]).toMatchObject({ status: 'warn', severity: 'medium' });
  });
});

/** A zone whose owned-record list never loses a record: the delete claims success but nothing changes. */
function stubbornDns(records: DnsRecord[], opts: { listError?: string } = {}): Adapter {
  let reads = 0;
  return {
    id: 'stubborn',
    title: 'StubbornDNS',
    axes: ['dns'],
    automated: true,
    auth: async () => ({ ok: true }),
    capabilities: {
      dns: {
        hosts: async () => true,
        list: async () => records,
        upsert: async () => 'created',
        listOwned: async () => {
          if (++reads > 1 && opts.listError) throw new Error(opts.listError);
          return records;
        },
        remove: async () => 'removed',
      },
    },
  };
}

// ── Deletion gates ──────────────────────────────────────────────────────────────────────────────

describe('teardown: gates', () => {
  it('blocks deletions without --confirm-destroy, and DNS records also without --confirm-dns', async () => {
    const { w, ctx, build } = setup({ arrange: (w) => void (w.dns.owned = [A_RECORD]), state: stateWith(CREATED_PROJECT) });
    const plan = await build();
    expect(ids(plan)).toEqual(['teardown:dns:fakedns:A:example.com', 'teardown:project:hosting']);

    const noFlags = await apply(ctx, plan, { confirmDns: false, confirmDestroy: false });
    expect(noFlags.map((o) => [o.id, o.status])).toEqual([['teardown:dns:fakedns:A:example.com', 'blocked']]);
    expect(noFlags[0]!.next).toMatch(/--confirm-dns/);
    expect(noFlags[0]!.next).toMatch(/--confirm-destroy/);
    expect(calls(w, 'dns.remove')).toEqual([]);
    expect(calls(w, 'project.remove')).toEqual([]);

    const destroyOnly = await apply(ctx, plan, { confirmDns: false, confirmDestroy: true });
    expect(destroyOnly.map((o) => [o.id, o.status])).toEqual([['teardown:dns:fakedns:A:example.com', 'blocked']]);
    expect(destroyOnly[0]!.next).toMatch(/--confirm-dns/);
    expect(calls(w, 'dns.remove')).toEqual([]);

    const confirmed = await apply(ctx, plan);
    expect(confirmed.map((o) => [o.id, o.status])).toEqual([['teardown:dns:fakedns:A:example.com', 'done'], ['teardown:project:hosting', 'done']]);
    expect(calls(w, 'dns.remove')).toHaveLength(1);
    expect(w.dns.owned).toEqual([]);
    expect(confirmed[0]!.checks).toHaveLength(1);
    expect(confirmed[0]!.checks[0]!.status).toBe('pass');
    expect(confirmed[1]!.changes).toEqual(['deleted project prj_1']);
  });
});

// ── Webhooks, keys, project ─────────────────────────────────────────────────────────────────────

describe('teardown: webhooks, keys and the host project', () => {
  it('assembles steps in teardown order: webhooks, DNS records, keys, host project', async () => {
    const { build } = setup({
      arrange: (w) => {
        w.dns.owned = [A_RECORD];
        w.pay.endpoints = [{ id: 'we_test', url: 'https://example.com/api/webhooks/stripe', events: [], enabled: true, mode: 'test' }];
      },
      state: stateWith({ ...CREATED_PROJECT, 'fakepay.test.webhookEndpointId': 'we_test', 'fakemail.keyId@preview': 'key_7' }),
    });
    const plan = await build();
    expect(ids(plan)).toEqual(['teardown:webhook:fakepay:test', 'teardown:dns:fakedns:A:example.com', 'teardown:key:fakemail:preview', 'teardown:project:hosting']);
    expect(plan.handoffs).toEqual([]);
  });

  it('deletes the webhook endpoints and revokes the sending keys golive recorded', async () => {
    const { w, ctx, build } = setup({
      arrange: (w) => {
        w.pay.endpoints = [
          { id: 'we_test', url: 'https://example.com/api/webhooks/stripe', events: [], enabled: true, mode: 'test' },
          { id: 'we_live', url: 'https://example.com/api/webhooks/stripe', events: [], enabled: true, mode: 'live' },
        ];
      },
      state: stateWith({ 'fakepay.test.webhookEndpointId': 'we_test', 'fakepay.live.webhookEndpointId': 'we_live', 'fakemail.keyId@preview': 'key_7', 'fakemail.keyId@production': 'key_9' }),
    });
    const plan = await build();
    expect(ids(plan)).toEqual(['teardown:webhook:fakepay:test', 'teardown:webhook:fakepay:live', 'teardown:key:fakemail:preview', 'teardown:key:fakemail:production']);
    expect(byId(plan, 'teardown:webhook:fakepay:test').risk).toEqual({ writes: true, destroy: true, live: false });
    expect(byId(plan, 'teardown:webhook:fakepay:live').risk).toEqual({ writes: true, destroy: true, live: true });
    expect(byId(plan, 'teardown:webhook:fakepay:live').preview).toEqual(['delete the FakePay live-mode webhook endpoint golive created (we_live)']);
    expect(byId(plan, 'teardown:key:fakemail:preview').preview).toEqual(['revoke the FakeMail sending key golive issued for preview (key_7)']);
    expect(byId(plan, 'teardown:key:fakemail:production').risk).toEqual({ writes: true, destroy: true });

    const out = await apply(ctx, plan);
    expect(out.map((o) => [o.id, o.status])).toEqual([
      ['teardown:webhook:fakepay:test', 'done'],
      ['teardown:webhook:fakepay:live', 'done'],
      ['teardown:key:fakemail:preview', 'done'],
      ['teardown:key:fakemail:production', 'done'],
    ]);
    expect(out.map((o) => o.changes[0])).toEqual(['deleted webhook we_test', 'deleted webhook we_live', 'revoked key_7', 'revoked key_9']);
    expect(w.pay.deleted).toEqual(['we_test', 'we_live']);
    expect(w.mail.revoked).toEqual(['key_7', 'key_9']);
  });

  it('reports an already-gone endpoint as done and leaves an endpoint golive did not create alone', async () => {
    const { w, ctx, build } = setup({
      arrange: (w) => void (w.pay.endpoints = [{ id: 'we_human', url: 'https://example.com/hook', events: [], enabled: true, mode: 'live', owned: false }]),
      state: stateWith({ 'fakepay.test.webhookEndpointId': 'we_missing', 'fakepay.live.webhookEndpointId': 'we_human' }),
    });
    const plan = await build();
    const out = await apply(ctx, plan);

    expect(out.map((o) => [o.id, o.status, o.changes[0]])).toEqual([
      ['teardown:webhook:fakepay:test', 'done', 'already gone: we_missing'],
      ['teardown:webhook:fakepay:live', 'done', 'left as is: not created by golive'],
    ]);
    expect(w.pay.endpoints.map((e) => e.id)).toEqual(['we_human']);
  });

  it('fails the webhook step when the provider throws', async () => {
    const { ctx, build } = setup({
      arrange: (w) => void (w.pay.removeError = 'Stripe refused to delete the endpoint'),
      state: stateWith({ 'fakepay.test.webhookEndpointId': 'we_test' }),
    });
    const plan = await build();
    const out = await apply(ctx, plan);
    expect(out.map((o) => [o.id, o.status])).toEqual([['teardown:webhook:fakepay:test', 'failed']]);
    expect(out[0]!.error).toMatch(/refused to delete the endpoint/);
  });

  it('fails the webhook step when the provider reports a failed delete without throwing', async () => {
    const { w, ctx, build } = setup({
      arrange: (w) => {
        w.pay.endpoints = [{ id: 'we_test', url: 'https://example.com/api/webhooks/stripe', events: [], enabled: true, mode: 'test' }];
        w.pay.removeResult = { deleted: false, reason: 'delete failed: Stripe rejected the test-mode key (HTTP 401, invalid_api_key)' };
      },
      state: stateWith({ 'fakepay.test.webhookEndpointId': 'we_test' }),
    });
    const plan = await build();
    const out = await apply(ctx, plan);

    expect(out.map((o) => [o.id, o.status])).toEqual([['teardown:webhook:fakepay:test', 'failed']]);
    expect(out[0]!.error).toBe('could not delete the FakePay test-mode webhook endpoint we_test: delete failed: Stripe rejected the test-mode key (HTTP 401, invalid_api_key)');
    expect(out[0]!.changes).toEqual([]);
    expect(ctx.state.get().steps['teardown:webhook:fakepay:test']?.status).toBe('failed');
    expect(w.pay.endpoints.map((e) => e.id)).toEqual(['we_test']); // still registered: nothing was deleted
    expect(w.pay.deleted).toEqual([]);
  });

  it('fails the key step when the provider cannot revoke the key', async () => {
    const { w, ctx, build } = setup({
      arrange: (w) => void (w.mail.revokeError = 'Resend delete API key key_7 failed (HTTP 500): internal error'),
      state: stateWith({ 'fakemail.keyId@preview': 'key_7' }),
    });
    const plan = await build();
    const out = await apply(ctx, plan);

    expect(out.map((o) => [o.id, o.status])).toEqual([['teardown:key:fakemail:preview', 'failed']]);
    expect(out[0]!.error).toBe('Resend delete API key key_7 failed (HTTP 500): internal error');
    expect(ctx.state.get().steps['teardown:key:fakemail:preview']?.status).toBe('failed');
    expect(w.mail.revoked).toEqual([]);
    expect(ctx.state.resource('fakemail.keyId@preview')).toBe('key_7'); // the key is still recorded
  });

  it('reports an already-revoked sending key as done, so a retry can finish', async () => {
    const { w, ctx, build } = setup({
      arrange: (w) => void (w.mail.revokeResult = { revoked: false, reason: 'key not found' }),
      state: stateWith({ 'fakemail.keyId@preview': 'key_7' }),
    });
    const plan = await build();
    const out = await apply(ctx, plan);

    expect(out.map((o) => [o.id, o.status, o.changes[0]])).toEqual([['teardown:key:fakemail:preview', 'done', 'already gone: key_7']]);
    expect(ctx.state.get().steps['teardown:key:fakemail:preview']?.status).toBe('done');
    expect(calls(w, 'keys.revoke')).toHaveLength(1);
    expect(w.mail.revoked).toEqual([]); // nothing to revoke: the provider did not have it
    expect(ctx.state.resource('fakemail.keyId@preview')).toBe('key_7');
  });

  it('fails the key step when the provider reports a refusal for any other reason', async () => {
    const cases: Array<[{ revoked: boolean; reason?: string }, string]> = [
      [{ revoked: false, reason: 'the key belongs to another Resend team' }, 'the key belongs to another Resend team'],
      [{ revoked: false }, 'the provider did not revoke it'],
    ];
    for (const [revokeResult, expected] of cases) {
      const { w, ctx, build } = setup({
        arrange: (w) => void (w.mail.revokeResult = revokeResult),
        state: stateWith({ 'fakemail.keyId@preview': 'key_7' }),
      });
      const out = await apply(ctx, await build());

      expect(out.map((o) => [o.id, o.status])).toEqual([['teardown:key:fakemail:preview', 'failed']]);
      expect(out[0]!.error).toBe(`could not revoke the FakeMail sending key key_7: ${expected}`);
      expect(ctx.state.get().steps['teardown:key:fakemail:preview']?.status).toBe('failed');
      expect(w.mail.revoked).toEqual([]);
      expect(ctx.state.resource('fakemail.keyId@preview')).toBe('key_7'); // the key is still recorded
    }
  });

  it('redacts the provider reason before it reaches the failed step', async () => {
    const secret = new Secret('RESEND_API_KEY', RAW.resendKey);
    const { ctx, build } = setup({
      arrange: (w) => void (w.mail.revokeResult = { revoked: false, reason: `Resend refused: the key ${secret.reveal()} is still in use` }),
      state: stateWith({ 'fakemail.keyId@preview': 'key_7' }),
    });
    const out = await apply(ctx, await build());

    expect(out[0]!.error).toMatch(/^could not revoke the FakeMail sending key key_7: Resend refused: the key \[redacted /);
    expect(out[0]!.error).not.toContain(RAW.resendKey);
  });

  it('deletes the host project golive created, and only with a matching creation marker', async () => {
    const { w, ctx, build } = setup({ state: stateWith(CREATED_PROJECT) });
    const plan = await build();

    expect(ids(plan)).toEqual(['teardown:project:hosting']);
    expect(plan.handoffs).toEqual([]);
    const step = byId(plan, 'teardown:project:hosting');
    expect(step.kind).toBe('destroy');
    expect(step.risk).toEqual({ writes: true, destroy: true });
    expect(step.preview).toEqual(['delete the FakeHost project shop (prj_1) — golive created it']);

    const out = await apply(ctx, plan);
    expect(out.map((o) => [o.id, o.status])).toEqual([['teardown:project:hosting', 'done']]);
    expect(out[0]!.changes).toEqual(['deleted project prj_1']);
    expect(w.host.removed).toEqual(['prj_1']);
    expect(w.host.current).toBeNull();
  });

  it('fails the host-project step when the provider reports it did not delete the project', async () => {
    const { w, ctx, build } = setup({
      arrange: (w) => void (w.host.removeResult = { removed: false, reason: 'the project still has deployments' }),
      state: stateWith(CREATED_PROJECT),
    });
    const plan = await build();
    const out = await apply(ctx, plan);

    expect(out.map((o) => [o.id, o.status])).toEqual([['teardown:project:hosting', 'failed']]);
    expect(out[0]!.error).toBe('could not delete the FakeHost project prj_1: the project still has deployments');
    expect(out[0]!.changes).toEqual([]);
    expect(ctx.state.get().steps['teardown:project:hosting']?.status).toBe('failed');
    expect(w.host.current).toEqual({ id: 'prj_1', name: 'shop' });
  });

  it('fails the host-project step when the provider errors', async () => {
    const { w, ctx, build } = setup({
      arrange: (w) => void (w.host.removeError = 'Vercel API DELETE /v9/projects/prj_1 failed (HTTP 500, internal_error)'),
      state: stateWith(CREATED_PROJECT),
    });
    const plan = await build();
    const out = await apply(ctx, plan);

    expect(out.map((o) => [o.id, o.status])).toEqual([['teardown:project:hosting', 'failed']]);
    expect(out[0]!.error).toBe('Vercel API DELETE /v9/projects/prj_1 failed (HTTP 500, internal_error)');
    expect(w.host.current).toEqual({ id: 'prj_1', name: 'shop' });
  });

  it('accepts a refusal once state no longer proves golive created the linked project', async () => {
    const { w, ctx, build } = setup({ state: stateWith(CREATED_PROJECT) });
    const plan = await build();
    w.host.removeResult = { removed: false, reason: 'the project was adopted or selected, not created by golive' };
    // The creation marker is gone: golive may no longer delete this project, so the refusal is the outcome.
    ctx.state.save((s) => {
      delete s.resources['fakehost.createdProjectId'];
    });

    const out = await apply(ctx, plan);
    expect(out.map((o) => [o.id, o.status])).toEqual([['teardown:project:hosting', 'done']]);
    expect(out[0]!.changes).toEqual(['left as is: the project was adopted or selected, not created by golive']);
    expect(w.host.current).toEqual({ id: 'prj_1', name: 'shop' });
  });

  it('hands an adopted project back instead of deleting it', async () => {
    for (const marker of [undefined, 'prj_golive_created_earlier']) {
      const { w, ctx, build } = setup({
        arrange: (w) => void (w.host.current = { id: 'prj_adopted', name: 'their-app' }),
        state: stateWith({ 'fakehost.projectId': 'prj_adopted', 'fakehost.projectName': 'their-app', ...(marker ? { 'fakehost.createdProjectId': marker } : {}) }),
      });
      const plan = await build();
      expect(plan.steps).toEqual([]);
      expect(plan.handoffs).toEqual([
        {
          id: 'teardown:project:hosting',
          why: 'the FakeHost project prj_adopted was adopted (not created by golive), so golive will not delete it',
          action: 'If the project should go away, delete it in the FakeHost dashboard; keep it if the app continues elsewhere.',
          blocking: false,
          manual: true,
        },
      ]);
      expect(await apply(ctx, plan)).toEqual([]);
      expect(calls(w, 'project.remove')).toEqual([]);
      expect(w.host.removed).toEqual([]);
      expect(w.host.current).toEqual({ id: 'prj_adopted', name: 'their-app' });
    }
  });

  it('skips a host that cannot delete projects, with no handoff', async () => {
    const { build } = setup({ arrange: (w) => void (w.host.canRemoveProject = false), state: stateWith(CREATED_PROJECT) });
    const plan = await build();
    expect(plan.steps).toEqual([]);
    expect(plan.handoffs).toEqual([]);
  });
});

// ── Deploy facts and the post-delete re-read ────────────────────────────────────────────────────

const DEPLOY_AT = '2026-09-24T04:46:23.199Z';
const DEPLOY_ID = `fakehost|dpl_1|https://shop.fakehost.app|${DEPLOY_AT}`;

/**
 * The created project plus the deploy facts a successful production deploy records in state, with a
 * recorded sending key, an unrelated step record and a secret fingerprint that must all survive.
 */
const OTHER_FACTS = {
  resources: { 'fakemail.keyId@preview': 'key_7' },
  steps: { 'env:production': { status: 'done' as const, hash: 'h3', at: DEPLOY_AT, planId: 'plan_1' } },
  secrets: { 'DATABASE_URL@production': { fp: 'abcd1234', at: DEPLOY_AT } },
};
const stateWithDeploys = (): ShipState => ({
  ...emptyState(),
  resources: { ...CREATED_PROJECT, 'deployed:production': DEPLOY_AT, 'deployed:production:id': DEPLOY_ID, ...OTHER_FACTS.resources },
  steps: {
    'deploy:production': { status: 'done', hash: 'h1', at: DEPLOY_AT, planId: 'plan_1' },
    'deploy:production:final': { status: 'done', hash: 'h2', at: DEPLOY_AT, planId: 'plan_1' },
    ...OTHER_FACTS.steps,
  },
  secrets: { ...OTHER_FACTS.secrets },
});

/** A stack whose only automation is the host, so the forward plan is the project step plus the deploy. */
const HOST_ONLY: Partial<ShipConfig> = { stack: { hosting: 'fakehost' }, domain: undefined };
const forward = (ctx: Ctx) => buildPlan(ctx, ALL_LINKS, { unmappedEnv: [], warnings: [] });

describe('teardown: deploy facts of a removed project', () => {
  it('forgets them, so a project created again in this repo is planned a deploy', async () => {
    const { ctx, build } = setup({ config: HOST_ONLY, state: stateWithDeploys() });
    // The removed project's facts still stand: golive plans no deploy at all (the observed live bug).
    expect(ids(await forward(ctx))).toEqual(['project:hosting']);

    const out = await apply(ctx, await build());
    expect(out.map((o) => [o.id, o.status])).toEqual([['teardown:project:hosting', 'done']]);
    expect(ctx.state.resource('deployed:production')).toBeUndefined();
    expect(ctx.state.resource('deployed:production:id')).toBeUndefined(); // the removed project's deployment identity goes with it
    expect(ctx.state.get().steps['deploy:production']).toBeUndefined();
    expect(ctx.state.get().steps['deploy:production:final']).toBeUndefined();
    expect(ctx.state.get().steps['teardown:project:hosting']?.status).toBe('done'); // the teardown evidence stays

    // Nothing else in state is touched: other resources, step evidence and fingerprints stay.
    expect(ctx.state.get().resources).toEqual(OTHER_FACTS.resources);
    expect(ctx.state.get().steps['env:production']).toEqual(OTHER_FACTS.steps['env:production']);
    expect(ctx.state.get().secrets).toEqual(OTHER_FACTS.secrets);

    expect(ids(await forward(ctx))).toEqual(['project:hosting', 'deploy:production']);
    expect(ids(await build())).toEqual([]); // nothing golive created is left: a second teardown is a no-op
  });

  it('leaves them alone when the project was not removed', async () => {
    const cases: Array<{ what: string; status: 'done' | 'failed'; before?: (w: FakeWorld) => void; after?: (w: FakeWorld, ctx: Ctx) => void }> = [
      { what: 'the delete failed', status: 'failed', before: (w) => void (w.host.removeError = 'the project still has deployments') },
      {
        what: 'golive may no longer delete it',
        status: 'done',
        after: (w, ctx) => {
          w.host.removeResult = { removed: false, reason: 'the project was adopted or selected, not created by golive' };
          ctx.state.save((s) => void delete s.resources['fakehost.createdProjectId']);
        },
      },
    ];
    for (const c of cases) {
      const { w, ctx, build } = setup({ config: HOST_ONLY, state: stateWithDeploys(), arrange: c.before });
      const plan = await build();
      c.after?.(w, ctx);

      const out = await apply(ctx, plan);
      expect(out.map((o) => [o.id, o.status]), c.what).toEqual([['teardown:project:hosting', c.status]]);
      expect(ctx.state.resource('deployed:production'), c.what).toBe(DEPLOY_AT);
      expect(ctx.state.resource('deployed:production:id'), c.what).toBe(DEPLOY_ID);
      expect(ctx.state.get().steps['deploy:production']?.status, c.what).toBe('done');
      expect(ctx.state.get().steps['deploy:production:final']?.status, c.what).toBe('done');
    }
  });
});

describe('teardown: confirming the host project is gone', () => {
  it('re-reads the project and reports the absence as evidence', async () => {
    const { w, ctx, build } = setup({ state: stateWith(CREATED_PROJECT) });
    const out = await apply(ctx, await build());

    expect(out.map((o) => [o.id, o.status])).toEqual([['teardown:project:hosting', 'done']]);
    expect(calls(w, 'project.exists').map((c) => c.args[0])).toEqual(['prj_1']);
    expect(out[0]!.checks.map((c) => [c.id, c.status, c.severity])).toEqual([['teardown:project:hosting:removed', 'pass', 'info']]);
    expect(out[0]!.checks[0]!.evidence).toEqual(['FakeHost no longer resolves the project shop (prj_1)']);
  });

  it('fails the step when the host still resolves the project after the delete', async () => {
    const { w, ctx, build } = setup({ arrange: (w) => void (w.host.removeKeepsProject = true), state: stateWith(CREATED_PROJECT) });
    const out = await apply(ctx, await build());

    expect(out.map((o) => [o.id, o.status])).toEqual([['teardown:project:hosting', 'failed']]);
    expect(out[0]!.checks[0]).toMatchObject({ id: 'teardown:project:hosting:removed', status: 'fail', severity: 'high' });
    expect(out[0]!.checks[0]!.evidence).toEqual(['FakeHost still resolves the project shop (prj_1) after the delete']);
    expect(out[0]!.next).toMatch(/dashboard/);
    expect(ctx.state.get().steps['teardown:project:hosting']?.status).toBe('failed');
    expect(w.host.removed).toEqual(['prj_1']); // the delete was attempted; it is the confirmation that failed
  });

  it('warns instead of failing when the host cannot re-read the project', async () => {
    const arrangements: Array<(w: FakeWorld) => void> = [
      (w) => void (w.host.withExists = false),
      (w) => void (w.host.existsError = 'Netlify HTTPS request failed; no provider response body was logged.'),
    ];
    for (const arrange of arrangements) {
      const { ctx, build } = setup({ arrange, state: stateWith(CREATED_PROJECT) });
      const out = await apply(ctx, await build());

      expect(out.map((o) => [o.id, o.status])).toEqual([['teardown:project:hosting', 'done']]);
      expect(out[0]!.checks[0]).toMatchObject({ id: 'teardown:project:hosting:removed', status: 'warn', severity: 'medium' });
      expect(ctx.state.get().steps['teardown:project:hosting']?.status).toBe('done');
    }
  });
});

// ── Handoffs for what golive created but cannot delete yet ──────────────────────────────────────

describe('teardown: handoffs', () => {
  it('hands back the Supabase, Neon and Resend resources golive created', async () => {
    const { build } = setup({
      state: stateWith({ 'supabase.ref': 'abcdefghijklmnop', 'supabase.createdByGolive': 'abcdefghijklmnop', 'neon.projectId': 'silent-brook-1234', 'neon.createdProjectId': 'silent-brook-1234', 'resend.domainId': 'dom_42' }),
    });
    const plan = await build();

    expect(plan.steps).toEqual([]);
    expect(plan.handoffs.map((h) => h.id)).toEqual(['teardown:db:supabase', 'teardown:db:neon', 'teardown:email:resend']);
    for (const h of plan.handoffs) expect(h).toMatchObject({ blocking: false, manual: true });
    expect(plan.handoffs[0]!.action).toContain('abcdefghijklmnop');
    expect(plan.handoffs[1]!.action).toContain('silent-brook-1234');
    expect(plan.handoffs[2]!.action).toContain('send.example.com'); // the configured sending domain, not the id
  });

  it('does not claim an adopted database or a sending domain golive did not create', async () => {
    const { build } = setup({
      state: stateWith({ 'supabase.ref': 'abcdefghijklmnop', 'supabase.createdByGolive': 'some-other-project', 'neon.projectId': 'silent-brook-1234' }),
    });
    const plan = await build();
    expect(plan.steps).toEqual([]);
    expect(plan.handoffs).toEqual([]);
  });
});

// ── Determinism ─────────────────────────────────────────────────────────────────────────────────

describe('teardown: determinism', () => {
  const fullWorld = (w: FakeWorld): void => {
    w.dns.owned = [...OWNED];
    w.pay.endpoints = [{ id: 'we_live', url: 'https://example.com/api/webhooks/stripe', events: [], enabled: true, mode: 'live' }];
  };
  const STATE = stateWith({
    ...CREATED_PROJECT,
    'fakepay.live.webhookEndpointId': 'we_live',
    'fakemail.keyId@production': 'key_9',
    'supabase.ref': 'abcdefghijklmnop',
    'supabase.createdByGolive': 'abcdefghijklmnop',
  });

  it('builds the same plan id, steps and handoffs twice', async () => {
    const first = await setup({ arrange: fullWorld, state: STATE }).build();
    const second = await setup({ arrange: fullWorld, state: STATE }).build();

    expect(first.id).toBe(second.id);
    expect(ids(first)).toEqual(ids(second));
    expect(first.handoffs).toEqual(second.handoffs);
    expect(first.steps.map((s) => s.preview)).toEqual(second.steps.map((s) => s.preview));
  });

  it('plans nothing, and no handoffs, when golive created nothing', async () => {
    const { ctx, build } = setup({ config: { stack: {}, domain: undefined, email: undefined } });
    const plan = await build();

    expect(plan.steps).toEqual([]);
    expect(plan.handoffs).toEqual([]);
    expect(plan.unmappedEnv).toEqual([]);
    expect(plan.warnings).toEqual([]);
    expect(plan.release).toEqual(TEST_RELEASE);
    expect(plan.release).not.toBe(ctx.release);
    expect(plan.id).toBe((await build()).id);
  });
});

describe('teardown: approvedPlan resolution for apply', () => {
  const forward = (plan: Plan) => () => Promise.resolve(plan);
  const forwardPlan = (ctx: Parameters<typeof buildTeardownPlan>[0]): Plan =>
    ({ id: 'forward-plan', release: structuredClone(ctx.release), steps: [], handoffs: [], unmappedEnv: [], warnings: [] });

  it('returns the forward plan when it still matches the approved id', async () => {
    const { ctx } = setup();
    const f = forwardPlan(ctx);
    expect(await approvedPlan(ctx, f.id, forward(f))).toBe(f);
  });

  it('falls back to the teardown plan when the forward plan rebuilt to a different id', async () => {
    const { ctx, build } = setup({ state: stateWith(CREATED_PROJECT) });
    const teardown = await build();
    const f = forwardPlan(ctx);
    expect((await approvedPlan(ctx, teardown.id, forward(f))).id).toBe(teardown.id);
  });

  it('a forward rebuild that throws does not block an approved teardown', async () => {
    const { ctx, build } = setup({ state: stateWith(CREATED_PROJECT) });
    const teardown = await build();
    const boom = new Error('Vercel API GET /v9/projects/prj_1 failed (HTTP 404, not_found)');
    expect((await approvedPlan(ctx, teardown.id, () => Promise.reject(boom))).id).toBe(teardown.id);
  });

  it('surfaces the original forward error when nothing matches', async () => {
    const { ctx } = setup();
    const boom = new Error('Vercel API GET /v9/projects/prj_1 failed (HTTP 404, not_found)');
    await expect(approvedPlan(ctx, 'some-old-id', () => Promise.reject(boom))).rejects.toThrow(/HTTP 404, not_found/);
    const f = forwardPlan(ctx);
    expect((await approvedPlan(ctx, 'some-old-id', forward(f))).id).toBe(f.id);
  });
});

describe('teardown: recorded resources the provider cannot remove right now', () => {
  it('hands a recorded webhook endpoint back when the payments provider is not usable', async () => {
    const { build } = setup({
      config: { stack: { hosting: 'fakehost', payments: 'fakeguided' } },
      state: stateWith({ 'fakepay.live.webhookEndpointId': 'we_live' }),
    });
    const plan = await build();
    expect(ids(plan)).not.toContain('teardown:webhook:fakepay:live');
    const h = plan.handoffs.find((x) => x.id === 'teardown:webhook:fakepay:live')!;
    expect(h).toMatchObject({ manual: true, blocking: false });
    expect(h.action).toContain('we_live');
    expect(plan.steps).toEqual([]);
  });

  it('hands a recorded sending key back when the email provider is not usable', async () => {
    const { build } = setup({
      config: { stack: { hosting: 'fakehost', email: 'fakeguided' } },
      state: stateWith({ 'fakemail.keyId@production': 'key_9' }),
    });
    const plan = await build();
    expect(ids(plan)).not.toContain('teardown:key:fakemail:production');
    const h = plan.handoffs.find((x) => x.id === 'teardown:key:fakemail:production')!;
    expect(h).toMatchObject({ manual: true, blocking: false });
    expect(h.action).toContain('key_9');
  });
});
