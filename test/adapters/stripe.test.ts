import { beforeEach, describe, expect, it } from 'vitest';
import { stripeAccountStatus, stripeAdapter, stripeKeyFor, MAX_ENDPOINTS_PER_MODE } from '../../src/adapters/stripe.js';
import { StripeApiError, appKeyHowToFix, keyHowToFix, lookupAppKey, stripeError } from '../../src/adapters/stripe-api.js';
import { credentialsPath } from '../../src/core/credentials.js';
import { Secret, _resetSecretRegistry } from '../../src/core/secret.js';
import type { Ctx, Http, HttpRequest } from '../../src/core/types.js';
import { mockExec, mockHttp, testCtx } from '../helpers.js';

const TEST_KEY = 'sk_' + 'test_51FAKEtestKEY000000000000abcd';
const LIVE_KEY = 'sk_' + 'live_51FAKEliveKEY000000000000wxyz';
const RK_TEST = 'rk_' + 'test_51FAKErestrictedKEY0000000efgh';
const RK_LIVE = 'rk_' + 'live_51FAKErestrictedKEY0000000ijkl';
const APP_LIVE = 'sk_' + 'live_51FAKEappLIVEkey000000000mnop';
const APP_TEST = 'sk_' + 'test_51FAKEappTESTkey000000000qrst';
const WHSEC = 'whsec' + '_FAKEsigningSECRET1234567890abcdef';
const API = 'https://api.stripe.com';
const EP = `${API}/v1/webhook_endpoints`;

const wh = stripeAdapter.capabilities.webhooks!;
const out = stripeAdapter.capabilities.outputs!;

/** Capture log messages BEFORE redaction, so leak assertions aren't masked by the logger. */
function rawLogs(ctx: Ctx): string[] {
  const lines: string[] = [];
  const orig = ctx.log;
  ctx.log = { info: (m) => (lines.push(m), orig.info(m)), warn: (m) => (lines.push(m), orig.warn(m)) };
  return lines;
}

function endpoint(over: Record<string, unknown> = {}) {
  return { id: 'we_1', object: 'webhook_endpoint', url: 'https://app.example.com/api/stripe/webhook', enabled_events: ['checkout.session.completed'], status: 'enabled', metadata: {}, ...over };
}

type Route = Parameters<typeof mockHttp>[0][number];
const listRoute = (data: unknown[], hasMore = false): Route => ['GET', EP, () => ({ json: { object: 'list', data, has_more: hasMore } })];

beforeEach(() => _resetSecretRegistry());

describe('key selection', () => {
  it('uses per-mode vars first and STRIPE_SECRET_KEY only when its prefix matches', () => {
    const a = testCtx({ tokens: { STRIPE_LIVE_SECRET_KEY: LIVE_KEY, STRIPE_SECRET_KEY: TEST_KEY } });
    expect(stripeKeyFor(a, 'live')?.reveal()).toBe(LIVE_KEY);
    expect(stripeKeyFor(a, 'test')?.reveal()).toBe(TEST_KEY);

    const b = testCtx({ tokens: { STRIPE_SECRET_KEY: LIVE_KEY } });
    expect(stripeKeyFor(b, 'live')?.reveal()).toBe(LIVE_KEY);
    expect(stripeKeyFor(b, 'test')).toBeUndefined();

    const c = testCtx({ tokens: { STRIPE_SECRET_KEY: RK_TEST, STRIPE_TEST_SECRET_KEY: TEST_KEY } });
    expect(stripeKeyFor(c, 'test')?.reveal()).toBe(TEST_KEY);
  });

  it('rejects a per-mode var holding the wrong mode', () => {
    const ctx = testCtx({ tokens: { STRIPE_LIVE_SECRET_KEY: TEST_KEY, STRIPE_SECRET_KEY: LIVE_KEY } });
    expect(stripeKeyFor(ctx, 'live')).toBeUndefined();
  });
});

describe('auth', () => {
  it('ok when every mode in use has a key and /v1/account answers 200', async () => {
    const { http, calls } = mockHttp([['GET', `${API}/v1/account`, () => ({ json: { id: 'acct_123', settings: { dashboard: { display_name: 'Acme' } } } })]]);
    const ctx = testCtx({ http, tokens: { STRIPE_TEST_SECRET_KEY: TEST_KEY, STRIPE_LIVE_SECRET_KEY: LIVE_KEY } });
    const s = await stripeAdapter.auth(ctx);
    expect(s.ok).toBe(true);
    expect(s.via).toContain('STRIPE_TEST_SECRET_KEY');
    expect(s.via).toContain('acct_123');
    expect(calls.map((c) => c.headers.authorization)).toEqual([`Bearer ${TEST_KEY}`, `Bearer ${LIVE_KEY}`]);
    expect(JSON.stringify(s)).not.toContain(TEST_KEY);
    expect(JSON.stringify(s)).not.toContain(LIVE_KEY);
  });

  it('only needs the modes the config uses', async () => {
    const { http } = mockHttp([['GET', `${API}/v1/account`, () => ({ json: { id: 'acct_1' } })]]);
    const ctx = testCtx({ http, config: { targets: ['preview'] }, tokens: { STRIPE_TEST_SECRET_KEY: TEST_KEY } });
    expect((await stripeAdapter.auth(ctx)).ok).toBe(true);
  });

  it('not logged in: points the human at the credentials file (never chat, never "export in your terminal")', async () => {
    const { run, calls } = mockExec([['stripe whoami', { stdout: JSON.stringify({ authenticated: true, account_id: 'acct_9', display_name: 'Acme' }) }]]);
    const ctx = testCtx({ exec: run, tokens: { STRIPE_TEST_SECRET_KEY: TEST_KEY } });
    const s = await stripeAdapter.auth(ctx);
    expect(s.ok).toBe(false);
    expect(s.howToFix).toContain('STRIPE_LIVE_SECRET_KEY');
    expect(s.howToFix).toContain('API keys page');
    expect(s.howToFix).toMatch(/Never paste the value into this chat/);
    expect(s.howToFix).toContain(credentialsPath());
    expect(s.howToFix).toContain('STRIPE_LIVE_SECRET_KEY=<value>');
    expect(s.howToFix).not.toMatch(/read -s|in YOUR OWN terminal|export \S+ in your terminal/);
    expect(s.howToFix).toContain('Webhook Endpoints: Write');
    expect(s.howToFix).toMatch(/never copied into the app/);
    expect(s.howToFix).toContain('acct_9');
    expect(s.howToFix).not.toContain(TEST_KEY);
    expect(calls.every((c) => !c.args.join(' ').includes(TEST_KEY))).toBe(true);
  });

  it('does not throw when the stripe CLI is absent', async () => {
    const ctx = testCtx({ exec: mockExec([]).run });
    const s = await stripeAdapter.auth(ctx);
    expect(s.ok).toBe(false);
    expect(s.howToFix).toContain('STRIPE_TEST_SECRET_KEY');
  });

  it('maps 401 and a standard-key 403 to actionable fixes via the credentials file', async () => {
    const r401 = mockHttp([['GET', `${API}/v1/account`, () => ({ status: 401, json: { error: { type: 'invalid_request_error', message: 'Invalid API Key provided: sk_test_****abcd' } } })]]);
    const a = await stripeAdapter.auth(testCtx({ http: r401.http, config: { targets: ['preview'] }, tokens: { STRIPE_TEST_SECRET_KEY: TEST_KEY } }));
    expect(a).toMatchObject({ ok: false });
    expect(a.howToFix).toMatch(/rejected the test-mode key in STRIPE_TEST_SECRET_KEY/);
    expect(a.howToFix).toContain(credentialsPath());

    const r403 = mockHttp([['GET', `${API}/v1/account`, () => ({ status: 403, json: {} })]]);
    const b = await stripeAdapter.auth(testCtx({ http: r403.http, config: { targets: ['preview'] }, tokens: { STRIPE_TEST_SECRET_KEY: TEST_KEY } }));
    expect(b.ok).toBe(false);
    expect(b.howToFix).toMatch(/HTTP 403/);
    expect(b.howToFix).toContain(credentialsPath());
    expect(b.howToFix).not.toMatch(/read -s|export it again in your own terminal/);
    expect(r403.calls).toHaveLength(1); // no webhook probe for a standard key
  });

  it('restricted key without account read fails closed even with webhook access', async () => {
    const { http, calls } = mockHttp([
      ['GET', `${API}/v1/account`, () => ({ status: 403, json: { error: { type: 'invalid_request_error', message: 'does not have the required permissions' } } })],
      listRoute([]),
    ]);
    const ctx = testCtx({ http, config: { targets: ['preview'] }, tokens: { STRIPE_TEST_SECRET_KEY: RK_TEST } });
    const logs = rawLogs(ctx);
    const s = await stripeAdapter.auth(ctx);
    expect(s.ok).toBe(false);
    expect(s.howToFix).toContain('Account: Read is required');
    expect(s.howToFix).toContain('webhook access alone is insufficient');
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([`GET ${API}/v1/account`]);
    expect(JSON.stringify(s) + logs.join('\n')).not.toContain(RK_TEST);
  });

  it.each([{}, { id: '' }, { id: 'not-an-account' }])('rejects an account response without a valid identity: %j', async (json) => {
    const { http } = mockHttp([['GET', `${API}/v1/account`, () => ({ json })]]);
    const status = await stripeAdapter.auth(testCtx({ http, config: { targets: ['preview'] }, tokens: { STRIPE_TEST_SECRET_KEY: TEST_KEY } }));
    expect(status.ok).toBe(false);
    expect(status.howToFix).toContain('no valid test-mode account ID');
  });

  it('restricted key that can read neither the account nor webhooks: not ok, says which permissions', async () => {
    const r403 = mockHttp([['GET', `${API}/v1/account`, () => ({ status: 403, json: {} })], ['GET', EP, () => ({ status: 403, json: {} })]]);
    const b = await stripeAdapter.auth(testCtx({ http: r403.http, config: { targets: ['preview'] }, tokens: { STRIPE_TEST_SECRET_KEY: RK_TEST } }));
    expect(b.ok).toBe(false);
    expect(b.howToFix).toContain('Account: Read');
    expect(b.howToFix).toContain('Webhook Endpoints: Write');
    expect(b.howToFix).toContain(credentialsPath());
    expect(b.howToFix).not.toContain(RK_TEST);
  });

  it('via names a separate app key when one is set', async () => {
    const { http } = mockHttp([['GET', `${API}/v1/account`, () => ({ json: { id: 'acct_1' } })]]);
    const ctx = testCtx({ http, config: { targets: ['production'] }, tokens: { STRIPE_LIVE_SECRET_KEY: RK_LIVE, STRIPE_APP_LIVE_SECRET_KEY: APP_LIVE } });
    const s = await stripeAdapter.auth(ctx);
    expect(s.ok).toBe(true);
    expect(s.via).toContain('restricted key; app key from STRIPE_APP_LIVE_SECRET_KEY');
    expect(s.via).not.toContain(APP_LIVE);
  });
});

describe('howToFix texts', () => {
  it('use the credentials-file instructions for every token name', () => {
    const k = keyHowToFix(['test', 'live']);
    expect(k).toContain('STRIPE_TEST_SECRET_KEY=<value>');
    expect(k).toContain('Add STRIPE_LIVE_SECRET_KEY the same way');
    expect(k).toContain('STRIPE_APP_TEST_SECRET_KEY / STRIPE_APP_LIVE_SECRET_KEY');
    expect(k).not.toMatch(/read -s|YOUR OWN terminal|Re-run golive from that same shell/);

    const a = appKeyHowToFix('live');
    expect(a).toContain('STRIPE_APP_LIVE_SECRET_KEY=<value>');
    expect(a).toContain('sk_live_');

    const e = stripeError({ status: 401, headers: {}, json: {}, text: '' }, 'list endpoints', 'test', 'STRIPE_SECRET_KEY');
    expect(e.message).toContain('STRIPE_SECRET_KEY=<value>');
    expect(e.message).not.toMatch(/export it again in your own terminal/);
  });
});

describe('outputs', () => {
  it('returns a standard mode key as a Secret plus the public publishable key', async () => {
    const ctx = testCtx({ tokens: { STRIPE_LIVE_SECRET_KEY: LIVE_KEY, STRIPE_TEST_SECRET_KEY: TEST_KEY }, config: { payments: { publishableKeys: { live: 'pk_live_abc', test: 'pk_test_abc' } } } });
    const prod = await out.outputs(ctx, 'production');
    expect(prod['stripe.secretKey']).toBeInstanceOf(Secret);
    expect((prod['stripe.secretKey'] as Secret).reveal()).toBe(LIVE_KEY);
    expect(prod['stripe.publishableKey']).toBe('pk_live_abc');
    expect(JSON.stringify(prod)).not.toContain(LIVE_KEY);
    expect(((await out.outputs(ctx, 'preview'))['stripe.secretKey'] as Secret).reveal()).toBe(TEST_KEY);
  });

  it('never hands the restricted operator key to the app (regression #7)', async () => {
    // The human followed the restricted-key advice: rk_ keys with only webhook/event/account perms.
    const ctx = testCtx({ tokens: { STRIPE_LIVE_SECRET_KEY: RK_LIVE, STRIPE_TEST_SECRET_KEY: RK_TEST }, config: { payments: { publishableKeys: { live: 'pk_live_abc' } } } });
    const logs = rawLogs(ctx);
    const prod = await out.outputs(ctx, 'production');
    expect(prod).toEqual({ 'stripe.publishableKey': 'pk_live_abc' });
    expect(await out.outputs(ctx, 'preview')).toEqual({});
    // plan() sees the key as unavailable, so the payments link emits the missing-key handoff instead of a write.
    expect(await out.provides!(ctx, 'production')).toEqual(['stripe.publishableKey']);
    expect(await out.provides!(ctx, 'preview')).toEqual([]);
    expect(logs.join('\n')).toMatch(/restricted key that golive uses for its own calls; it is never copied into the app \(set STRIPE_APP_LIVE_SECRET_KEY/);
    expect(logs.join('\n')).not.toContain(RK_LIVE);
  });

  it('prefers STRIPE_APP_<MODE>_SECRET_KEY for the app over the operator key', async () => {
    const ctx = testCtx({ tokens: { STRIPE_LIVE_SECRET_KEY: RK_LIVE, STRIPE_APP_LIVE_SECRET_KEY: APP_LIVE, STRIPE_TEST_SECRET_KEY: TEST_KEY, STRIPE_APP_TEST_SECRET_KEY: APP_TEST } });
    expect(((await out.outputs(ctx, 'production'))['stripe.secretKey'] as Secret).reveal()).toBe(APP_LIVE);
    expect(((await out.outputs(ctx, 'preview'))['stripe.secretKey'] as Secret).reveal()).toBe(APP_TEST);
    expect(await out.provides!(ctx, 'production')).toEqual(['stripe.secretKey']);
    // golive's own calls keep using the operator key.
    expect(stripeKeyFor(ctx, 'live')?.reveal()).toBe(RK_LIVE);
  });

  it('rejects an app key that is restricted or for the wrong mode, without falling back to the operator key', () => {
    const rk = testCtx({ tokens: { STRIPE_LIVE_SECRET_KEY: LIVE_KEY, STRIPE_APP_LIVE_SECRET_KEY: RK_LIVE } });
    expect(lookupAppKey(rk, 'live')).toEqual({ problem: expect.stringMatching(/STRIPE_APP_LIVE_SECRET_KEY is a restricted key/) });
    const wrong = testCtx({ tokens: { STRIPE_TEST_SECRET_KEY: TEST_KEY, STRIPE_APP_TEST_SECRET_KEY: APP_LIVE } });
    expect(lookupAppKey(wrong, 'test')).toEqual({ problem: 'STRIPE_APP_TEST_SECRET_KEY holds a live-mode key, not a test-mode one' });
    const junk = testCtx({ tokens: { STRIPE_APP_TEST_SECRET_KEY: 'nope' } });
    expect(lookupAppKey(junk, 'test').problem).toMatch(/not a Stripe secret key/);
  });

  it('omits what is missing', async () => {
    const ctx = testCtx({});
    expect(await out.outputs(ctx, 'production')).toEqual({});
    expect(await out.provides!(ctx, 'production')).toEqual([]);
  });
});

describe('webhooks.ensure', () => {
  const spec = { url: 'https://app.example.com/api/stripe/webhook', events: ['checkout.session.completed', 'customer.subscription.updated'], mode: 'test' as const };

  it('creates with indexed events + golive metadata and returns the secret as a Secret only', async () => {
    const { http, calls } = mockHttp([listRoute([]), ['POST', EP, () => ({ json: { ...endpoint({ id: 'we_new', enabled_events: spec.events }), secret: WHSEC } })]]);
    const ctx = testCtx({ http, cwd: '/work/my-app', tokens: { STRIPE_TEST_SECRET_KEY: TEST_KEY } });
    const logs = rawLogs(ctx);
    const r = await wh.ensure(ctx, spec);
    expect(r.id).toBe('we_new');
    expect(r.created).toBe(true);
    expect(r.secret).toBeInstanceOf(Secret);
    expect(r.secret!.name).toBe('STRIPE_WEBHOOK_SECRET');
    expect(r.secret!.reveal()).toBe(WHSEC);

    const post = calls.find((c) => c.method === 'POST')!;
    expect(post.body).toMatchObject({
      url: spec.url,
      'enabled_events[0]': 'checkout.session.completed',
      'enabled_events[1]': 'customer.subscription.updated',
      'metadata[managed_by]': 'golive',
      'metadata[golive_app]': 'my-app',
    });
    expect(post.headers['idempotency-key']).toMatch(/^golive-test-/);
    expect(post.headers.authorization).toBe(`Bearer ${TEST_KEY}`);

    expect(JSON.stringify(r)).not.toContain(WHSEC);
    expect(logs.join('\n')).not.toContain(WHSEC);
    expect(logs.join('\n')).not.toContain(TEST_KEY);
    // The signing secret is never sent anywhere by the adapter.
    expect(JSON.stringify(calls)).not.toContain(WHSEC);
  });

  it('follows pagination when listing', async () => {
    const many = Array.from({ length: 100 }, (_, i) => endpoint({ id: `we_p${i}`, url: `https://other${i}.example.com/hook` }));
    const { http, calls } = mockHttp([
      ['GET', /starting_after=we_p99/, () => ({ json: { data: [endpoint({ id: 'we_last', metadata: { managed_by: 'golive' } })], has_more: false } })],
      listRoute(many, true),
    ]);
    const ctx = testCtx({ http, tokens: { STRIPE_TEST_SECRET_KEY: TEST_KEY } });
    const listed = await wh.list(ctx, 'test');
    expect(listed.map((e) => e.id)).toEqual(['we_last']);
    expect(calls).toHaveLength(2);
  });

  it('adopts an existing golive endpoint with matching events: no update, no secret', async () => {
    const existing = endpoint({ id: 'we_old', enabled_events: [...spec.events].reverse(), metadata: { managed_by: 'golive', golive_app: 'repo' } });
    const { http, calls } = mockHttp([listRoute([existing])]);
    const ctx = testCtx({ http, tokens: { STRIPE_TEST_SECRET_KEY: TEST_KEY } });
    const r = await wh.ensure(ctx, spec);
    expect(r).toEqual({ id: 'we_old', created: false });
    expect(calls.filter((c) => c.method !== 'GET')).toHaveLength(0);
  });

  it('updates drifted events and re-enables a disabled golive endpoint (the update is marked re-sendable)', async () => {
    const existing = endpoint({ id: 'we_old', status: 'disabled', enabled_events: ['invoice.paid'], metadata: { managed_by: 'golive' } });
    const base = mockHttp([listRoute([existing]), ['POST', `${EP}/we_old`, () => ({ json: endpoint({ id: 'we_old' }) })]]);
    const calls = base.calls;
    const flags: Array<boolean | undefined> = [];
    const http: Http = async <T,>(req: HttpRequest) => (req.method === 'POST' && flags.push(req.idempotent), base.http<T>(req));
    const ctx = testCtx({ http, tokens: { STRIPE_TEST_SECRET_KEY: TEST_KEY } });
    const r = await wh.ensure(ctx, spec);
    expect(r).toEqual({ id: 'we_old', created: false });
    const upd = calls.find((c) => c.method === 'POST')!;
    expect(upd.body).toEqual({ 'enabled_events[0]': spec.events[0], 'enabled_events[1]': spec.events[1], disabled: 'false' });
    expect(flags).toEqual([true]);
  });

  it('never marks the create POST idempotent (it relies on the Idempotency-Key header instead)', async () => {
    const base = mockHttp([listRoute([]), ['POST', EP, () => ({ json: { ...endpoint({ id: 'we_new' }), secret: WHSEC } })]]);
    const flags: Array<boolean | undefined> = [];
    const http: Http = async <T,>(req: HttpRequest) => (req.method === 'POST' && flags.push(req.idempotent), base.http<T>(req));
    await wh.ensure(testCtx({ http, tokens: { STRIPE_TEST_SECRET_KEY: TEST_KEY } }), spec);
    expect(flags).toEqual([undefined]);
  });

  it('adopting a non-golive endpoint only adds events, never removes them', async () => {
    const existing = endpoint({ id: 'we_human', enabled_events: ['invoice.paid', 'checkout.session.completed'] });
    const { http, calls } = mockHttp([listRoute([existing]), ['POST', `${EP}/we_human`, () => ({ json: endpoint({ id: 'we_human' }) })]]);
    const ctx = testCtx({ http, tokens: { STRIPE_TEST_SECRET_KEY: TEST_KEY } });
    const logs = rawLogs(ctx);
    const r = await wh.ensure(ctx, spec);
    expect(r).toEqual({ id: 'we_human', created: false });
    expect(Object.values(calls.find((c) => c.method === 'POST')!.body as object)).toEqual(['invoice.paid', 'checkout.session.completed', 'customer.subscription.updated']);
    expect(logs.join('\n')).toMatch(/never delete/);
  });

  it('refuses to create past the 16-endpoint limit with a clear error', async () => {
    const full = Array.from({ length: MAX_ENDPOINTS_PER_MODE }, (_, i) => endpoint({ id: `we_${i}`, url: `https://x${i}.example.com/h`, metadata: i < 3 ? { managed_by: 'golive' } : {} }));
    const { http, calls } = mockHttp([listRoute(full)]);
    const ctx = testCtx({ http, tokens: { STRIPE_TEST_SECRET_KEY: TEST_KEY } });
    await expect(wh.ensure(ctx, spec)).rejects.toThrow(/at most 16 webhook endpoints.*already has 16 \(3 created by golive\)/);
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });

  it('retries once with a fresh idempotency key if Stripe replays a deleted endpoint', async () => {
    const base = mockHttp([
      listRoute([]),
      ['POST', EP, () => ({ json: { ...endpoint({ id: 'we_x' }), secret: WHSEC } })],
      ['GET', `${EP}/we_x`, () => ({ status: 404, json: { error: { type: 'invalid_request_error', code: 'resource_missing', message: 'No such webhook endpoint' } } })],
    ]);
    let posts = 0;
    const http: Http = async <T,>(req: HttpRequest) => {
      const res = await base.http<T>(req);
      if (req.method === 'POST' && posts++ === 0) return { ...res, headers: { 'idempotent-replayed': 'true' } };
      return res;
    };
    const ctx = testCtx({ http, tokens: { STRIPE_TEST_SECRET_KEY: TEST_KEY } });
    const r = await wh.ensure(ctx, spec);
    expect(r.created).toBe(true);
    const keys = base.calls.filter((c) => c.method === 'POST').map((c) => c.headers['idempotency-key']);
    expect(keys).toHaveLength(2);
    expect(keys[0]).not.toBe(keys[1]);
  });

  it('maps Stripe error JSON to actionable, secret-free errors', async () => {
    const { http } = mockHttp([
      listRoute([]),
      ['POST', EP, () => ({ status: 403, json: { error: { type: 'invalid_request_error', message: `The provided key '${RK_TEST}' does not have the required permissions for this endpoint.` } } })],
    ]);
    const ctx = testCtx({ http, tokens: { STRIPE_SECRET_KEY: RK_TEST } });
    const err = await wh.ensure(ctx, spec).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StripeApiError);
    const msg = (err as Error).message;
    expect(msg).toMatch(/create Stripe test-mode webhook endpoint/);
    expect(msg).toMatch(/lacks permission/);
    expect(msg).toContain('Webhook Endpoints: Write');
    expect(msg).toContain('STRIPE_SECRET_KEY');
    expect(msg).not.toContain(RK_TEST);
    expect((err as StripeApiError).body).not.toContain(RK_TEST);
  });

  it('maps a 400 with param to a message naming the field', async () => {
    const { http } = mockHttp([listRoute([]), ['POST', EP, () => ({ status: 400, json: { error: { type: 'invalid_request_error', param: 'enabled_events[1]', message: 'Invalid event: nope' } } })]]);
    const ctx = testCtx({ http, tokens: { STRIPE_TEST_SECRET_KEY: TEST_KEY } });
    await expect(wh.ensure(ctx, { ...spec, events: ['a', 'nope'] })).rejects.toThrow(/rejected "enabled_events\[1\]": Invalid event: nope/);
  });

  it('throws an actionable error (no HTTP) when the key is missing', async () => {
    const { http, calls } = mockHttp([]);
    const ctx = testCtx({ http });
    await expect(wh.ensure(ctx, { ...spec, mode: 'live' })).rejects.toThrow(/STRIPE_LIVE_SECRET_KEY/);
    expect(calls).toHaveLength(0);
  });

  it('rejects non-https URLs and empty events before calling Stripe', async () => {
    const ctx = testCtx({ tokens: { STRIPE_TEST_SECRET_KEY: TEST_KEY } });
    await expect(wh.ensure(ctx, { ...spec, url: 'http://app.example.com/h' })).rejects.toThrow(/https/);
    await expect(wh.ensure(ctx, { ...spec, events: [] })).rejects.toThrow(/at least one event/);
  });
});

describe('webhooks.list', () => {
  it('returns only golive endpoints for this app, the remembered id, and configured-path URLs on our domain', async () => {
    const data = [
      endpoint({ id: 'we_ours', metadata: { managed_by: 'golive', golive_app: 'repo' } }),
      endpoint({ id: 'we_other_app', url: 'https://other.dev/api/stripe/webhook', metadata: { managed_by: 'golive', golive_app: 'someone-else' } }),
      endpoint({ id: 'we_path', url: 'https://www.example.com/api/stripe/webhook', status: 'disabled' }),
      endpoint({ id: 'we_foreign', url: 'https://unrelated.dev/api/stripe/webhook' }),
      endpoint({ id: 'we_state', url: 'https://legacy.dev/hook' }),
    ];
    const { http } = mockHttp([listRoute(data)]);
    const ctx = testCtx({
      http,
      tokens: { STRIPE_TEST_SECRET_KEY: TEST_KEY },
      config: { domain: 'example.com', payments: { webhook: { path: '/api/stripe/webhook', events: ['x'] } } },
      state: { version: 1, resources: { 'stripe.test.webhookEndpointId': 'we_state' }, secrets: {}, steps: {} },
    });
    const r = await wh.list(ctx, 'test');
    expect(r.map((e) => e.id)).toEqual(['we_ours', 'we_path', 'we_state']);
    expect(r[1]).toEqual({ id: 'we_path', url: 'https://www.example.com/api/stripe/webhook', events: ['checkout.session.completed'], enabled: false, owned: false });
    expect(r.map((e) => e.owned)).toEqual([true, false, false]);
  });
});

describe('webhooks.find', () => {
  const url = 'https://app.vercel.app/api/stripe/webhook';

  it('finds the untagged Dashboard endpoint ensure() would adopt, with no domain configured (regression #17)', async () => {
    const human = endpoint({ id: 'we_human', url, status: 'disabled', enabled_events: ['invoice.paid'] });
    const { http, calls } = mockHttp([listRoute([endpoint({ id: 'we_elsewhere', url: 'https://other.dev/hook' }), human])]);
    const ctx = testCtx({ http, tokens: { STRIPE_LIVE_SECRET_KEY: LIVE_KEY }, config: { domain: undefined, payments: { webhook: { path: '/api/stripe/webhook', events: ['checkout.session.completed'] } } } });
    // list() does not know this endpoint (no tag, no state, no domain) …
    expect(await wh.list(ctx, 'live')).toEqual([]);
    // … but find() returns exactly what ensure() would pick, so the plan can preview the adoption.
    expect(await wh.find!(ctx, url, 'live')).toEqual({ id: 'we_human', url, events: ['invoice.paid'], enabled: false, owned: false });
    expect(calls.every((c) => c.method === 'GET')).toBe(true);
  });

  it('uses the same selection order as ensure(): owned → golive-tagged → any, with URL normalisation', async () => {
    const data = [
      endpoint({ id: 'we_plain', url }),
      endpoint({ id: 'we_other_app', url, metadata: { managed_by: 'golive', golive_app: 'someone-else' } }),
      endpoint({ id: 'we_ours', url: 'https://APP.vercel.app/api/stripe/webhook', metadata: { managed_by: 'golive', golive_app: 'repo' } }),
    ];
    const ctx = testCtx({ http: mockHttp([listRoute(data)]).http, tokens: { STRIPE_TEST_SECRET_KEY: TEST_KEY } });
    expect((await wh.find!(ctx, url, 'test'))).toMatchObject({ id: 'we_ours', owned: true });

    const ctx2 = testCtx({ http: mockHttp([listRoute(data.slice(0, 2))]).http, tokens: { STRIPE_TEST_SECRET_KEY: TEST_KEY } });
    expect(await wh.find!(ctx2, url, 'test')).toMatchObject({ id: 'we_other_app', owned: false });

    // ensure() picks the same endpoint for the same data.
    const ens = mockHttp([listRoute(data.slice(0, 2)), ['POST', `${EP}/we_other_app`, () => ({ json: endpoint({ id: 'we_other_app' }) })]]);
    const r = await wh.ensure(testCtx({ http: ens.http, tokens: { STRIPE_TEST_SECRET_KEY: TEST_KEY } }), { url, events: ['x.y'], mode: 'test' });
    expect(r.id).toBe('we_other_app');
  });

  it('returns null when nothing matches', async () => {
    const ctx = testCtx({ http: mockHttp([listRoute([endpoint({ id: 'we_a', url: 'https://other.dev/hook' })])]).http, tokens: { STRIPE_TEST_SECRET_KEY: TEST_KEY } });
    expect(await wh.find!(ctx, url, 'test')).toBeNull();
  });
});

describe('webhooks.replace', () => {
  it('creates a new endpoint with the same url/events and deletes the old one only if golive owns it', async () => {
    const old = endpoint({ id: 'we_old', enabled_events: ['a.b', 'c.d'], metadata: { managed_by: 'golive' } });
    const { http, calls } = mockHttp([
      ['GET', `${EP}/we_old`, () => ({ json: old })],
      listRoute([old]),
      ['POST', EP, () => ({ json: { ...endpoint({ id: 'we_new' }), secret: WHSEC } })],
      ['DELETE', `${EP}/we_old`, () => ({ json: { id: 'we_old', deleted: true } })],
    ]);
    const ctx = testCtx({ http, tokens: { STRIPE_TEST_SECRET_KEY: TEST_KEY } });
    const logs = rawLogs(ctx);
    const r = await wh.replace!(ctx, 'we_old', 'test');
    expect(r.id).toBe('we_new');
    expect(r.created).toBe(true);
    expect(r.secret!.reveal()).toBe(WHSEC);
    expect(calls.find((c) => c.method === 'POST')!.body).toMatchObject({ url: old.url, 'enabled_events[0]': 'a.b', 'enabled_events[1]': 'c.d' });
    expect(calls.filter((c) => c.method === 'DELETE').map((c) => c.url)).toEqual([`${EP}/we_old`]);
    expect(r.oldDeleted).toBe(true);
    expect(r.oldLeft).toBeUndefined();
    expect(logs.join('\n')).not.toContain(WHSEC);
  });

  it('leaves a non-golive endpoint in place and warns', async () => {
    const old = endpoint({ id: 'we_human' });
    const { http, calls } = mockHttp([['GET', `${EP}/we_human`, () => ({ json: old })], listRoute([old]), ['POST', EP, () => ({ json: { ...endpoint({ id: 'we_new' }), secret: WHSEC } })]]);
    const ctx = testCtx({ http, tokens: { STRIPE_TEST_SECRET_KEY: TEST_KEY } });
    const logs = rawLogs(ctx);
    const r = await wh.replace!(ctx, 'we_human', 'test');
    expect(r.id).toBe('we_new');
    expect(r).toMatchObject({ oldDeleted: false, oldLeft: 'not created by golive' });
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
    expect(logs.join('\n')).toMatch(/left Stripe test-mode webhook endpoint we_human in place/);
  });

  it('still returns the new secret if deleting the old endpoint fails', async () => {
    const old = endpoint({ id: 'we_old', metadata: { managed_by: 'golive' } });
    const { http } = mockHttp([
      ['GET', `${EP}/we_old`, () => ({ json: old })],
      listRoute([old]),
      ['POST', EP, () => ({ json: { ...endpoint({ id: 'we_new' }), secret: WHSEC } })],
      ['DELETE', `${EP}/we_old`, () => ({ status: 500, json: { error: { type: 'api_error', message: 'boom' } } })],
    ]);
    const ctx = testCtx({ http, tokens: { STRIPE_TEST_SECRET_KEY: TEST_KEY } });
    const logs = rawLogs(ctx);
    const r = await wh.replace!(ctx, 'we_old', 'test');
    expect(r.secret!.reveal()).toBe(WHSEC);
    expect(r.oldDeleted).toBe(false);
    expect(r.oldLeft).toMatch(/^delete failed: delete Stripe test-mode webhook endpoint we_old failed/);
    expect(r.oldLeft).not.toContain(TEST_KEY);
    expect(logs.join('\n')).toMatch(/could not delete old Stripe webhook endpoint we_old/);
  });

  it('maps a missing endpoint to a not-found error', async () => {
    const { http } = mockHttp([['GET', `${EP}/we_gone`, () => ({ status: 404, json: { error: { type: 'invalid_request_error', code: 'resource_missing', message: "No such webhook endpoint: 'we_gone'" } } })]]);
    const ctx = testCtx({ http, tokens: { STRIPE_TEST_SECRET_KEY: TEST_KEY } });
    await expect(wh.replace!(ctx, 'we_gone', 'test')).rejects.toThrow(/not found in test mode/);
  });
});

describe('stripeAccountStatus', () => {
  it('reads charges_enabled / details_submitted and outstanding requirements', async () => {
    const { http, calls } = mockHttp([
      ['GET', `${API}/v1/account`, () => ({ json: { id: 'acct_1', charges_enabled: false, details_submitted: true, requirements: { currently_due: ['external_account'], disabled_reason: 'requirements.past_due' } } })],
    ]);
    const ctx = testCtx({ http, tokens: { STRIPE_LIVE_SECRET_KEY: LIVE_KEY } });
    const s = await stripeAccountStatus(ctx, 'live');
    expect(s).toEqual({ accountId: 'acct_1', chargesEnabled: false, detailsSubmitted: true, currentlyDue: ['external_account'], disabledReason: 'requirements.past_due' });
    expect(calls[0]!.headers.authorization).toBe(`Bearer ${LIVE_KEY}`);
  });
});

describe('adapter shape', () => {
  it('declares id, axes and capabilities', () => {
    expect(stripeAdapter).toMatchObject({ id: 'stripe', axes: ['payments'], automated: true });
    expect(Object.keys(stripeAdapter.capabilities).sort()).toEqual(['outputs', 'paymentAccount', 'webhooks']);
    expect(stripeAdapter.detect!({ root: '/', packageManager: null, framework: 'next', providers: { payments: ['stripe'] }, envRefs: [], configs: {}, webhooks: [], findings: [], notes: [] })).toBe(true);
  });
});
