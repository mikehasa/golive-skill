import { beforeEach, describe, expect, it } from 'vitest';
import { stripeAdapter } from '../src/adapters/stripe.js';
import { buildPlan, planView } from '../src/core/plan.js';
import { applyPlan } from '../src/core/runner.js';
import { Secret, _resetSecretRegistry } from '../src/core/secret.js';
import type { Adapter, Plan, Value } from '../src/core/types.js';
import { accountsLink } from '../src/links/accounts.js';
import { paymentsLink } from '../src/links/payments.js';
import { mockHttp, testCtx } from './helpers.js';

const OP_A = 'rk_' + 'test' + '_FAKEoperatorA';
const OP_B = 'rk_' + 'test' + '_FAKEoperatorB';
const OP_A2 = 'rk_' + 'test' + '_FAKEoperatorArotated';
const APP_A = 'sk_' + 'test' + '_FAKEappA';
const APP_A2 = 'sk_' + 'test' + '_FAKEappArotated';
const APP_B = 'sk_' + 'test' + '_FAKEappB';
const SIGNING = 'whsec' + '_FAKEapprovalFixture';
const API = 'https://api.stripe.com/v1';
const endpoint = { id: 'we_fixture', url: 'https://app.example.com/webhook', enabled_events: ['checkout.session.completed'], status: 'enabled', metadata: { managed_by: 'golive' } };

function fixture(options: { keys?: boolean; app?: string; operator?: string; failEnv?: boolean } = {}) {
  const tokens: Record<string, string> = { STRIPE_TEST_SECRET_KEY: options.operator ?? OP_A };
  if (options.app) tokens.STRIPE_APP_TEST_SECRET_KEY = options.app;
  const accounts: Record<string, string> = { [OP_A]: 'acct_A', [OP_A2]: 'acct_A', [OP_B]: 'acct_B', [APP_A]: 'acct_A', [APP_A2]: 'acct_A', [APP_B]: 'acct_B' };
  const remote = { accountStatus: 200, malformed: false, afterAccount: undefined as (() => void) | undefined, afterList: undefined as (() => void) | undefined, created: false };
  const { http, calls } = mockHttp([
    ['GET', `${API}/account`, (c) => {
      const id = accounts[c.headers.authorization!.slice('Bearer '.length)];
      remote.afterAccount?.();
      return { status: remote.accountStatus, json: remote.malformed ? {} : { id } };
    }],
    ['GET', `${API}/webhook_endpoints`, () => {
      remote.afterList?.();
      return { json: { data: remote.created ? [endpoint] : [] } };
    }],
    ['POST', `${API}/webhook_endpoints`, () => {
      remote.created = true;
      return { json: { ...endpoint, secret: SIGNING } };
    }],
    ['GET', `${API}/webhook_endpoints/we_fixture`, () => ({ json: endpoint })],
    ['DELETE', `${API}/webhook_endpoints/we_fixture`, () => ({ json: { id: endpoint.id, deleted: true } })],
  ]);
  const env = new Map<string, Value>();
  const envWrites: string[] = [];
  const host: Adapter = {
    id: 'vercel', title: 'Fixture host', axes: ['hosting'], automated: true, auth: async () => ({ ok: true }),
    capabilities: {
      env: {
        listNames: async () => [...env.keys()],
        set: async (_ctx, name, value) => {
          envWrites.push(name);
          if (options.failEnv) throw new Error('fixture env failure');
          env.set(name, value);
        },
      },
      url: { get: async () => 'https://app.example.com' },
    },
  };
  const ctx = testCtx({
    http, tokens, adapters: [host, stripeAdapter],
    config: { stack: { hosting: 'vercel', payments: 'stripe' }, targets: ['production'], domain: 'app.example.com', payments: { modes: { production: 'test' }, ...(options.keys ? {} : { webhook: { path: '/webhook', events: ['checkout.session.completed'] } }) } },
    detect: { envRefs: options.keys ? [{ name: 'STRIPE_SECRET_KEY', files: ['app.ts'], clientExposed: false }] : [] },
  });
  const build = () => buildPlan(ctx, [accountsLink, paymentsLink], { unmappedEnv: [], warnings: [] });
  const apply = (plan: Plan, approvedPlanId = plan.id) => applyPlan(ctx, plan, new Map(), { approvedPlanId, yes: true, confirmLive: false, confirmDns: false });
  const writes = () => calls.filter((c) => c.method !== 'GET');
  const visible = (plan: Plan, result: unknown = '') => JSON.stringify({ plan: planView(plan), state: ctx.state.get(), logs: ctx.logs, result });
  return { ctx, tokens, accounts, remote, calls, env, envWrites, build, apply, writes, visible };
}

beforeEach(() => _resetSecretRegistry());

describe('Stripe approval binds the payment account and operator', () => {
  it.each([OP_B, OP_A2])('webhook-only approval changes for a different account or operator key (%s)', async (next) => {
    const f = fixture();
    const before = await f.build();
    expect(before.steps).toHaveLength(1);
    expect(before.steps[0]!.preview.join('\n')).toContain('Stripe test account: acct_A');
    f.tokens.STRIPE_TEST_SECRET_KEY = next;
    const after = await f.build();
    expect(after.id).not.toBe(before.id);
    await expect(f.apply(after, before.id)).rejects.toThrow('plan changed since approval');
    expect(f.writes()).toEqual([]);
    expect(f.envWrites).toEqual([]);
    for (const secret of [OP_A, next]) expect(f.visible(after)).not.toContain(secret);
    // Rotating credentials remains supported once the human approves the freshly observed identity.
    expect((await f.apply(after))[0]!.status).toBe('done');
    expect(f.writes()[0]!.headers.authorization).toBe(`Bearer ${next}`);
  });

  it.each([OP_B, OP_A2])('rechecks before webhook writes even when the old plan object is reused (%s)', async (next) => {
    const f = fixture();
    const plan = await f.build();
    f.tokens.STRIPE_TEST_SECRET_KEY = next;
    const outcome = await f.apply(plan);
    expect(outcome).toEqual([expect.objectContaining({ status: 'failed', error: expect.stringContaining('changed since approval') })]);
    expect(f.writes()).toEqual([]);
    expect(f.envWrites).toEqual([]);
  });

  it('rejects changed account response for the same operator credential', async () => {
    const f = fixture();
    const plan = await f.build();
    f.accounts[OP_A] = 'acct_B';
    expect((await f.apply(plan))[0]!.status).toBe('failed');
    expect(f.writes()).toEqual([]);
    expect(f.envWrites).toEqual([]);
  });

  it.each(['forbidden', 'malformed'] as const)('cannot plan automatic writes without account identity: %s', async (kind) => {
    const f = fixture();
    if (kind === 'forbidden') f.remote.accountStatus = 403;
    else f.remote.malformed = true;
    const plan = await f.build();
    expect(plan.steps).toEqual([]);
    expect(plan.handoffs).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'login:stripe', blocking: true })]));
    expect(f.calls.every((c) => c.url === `${API}/account`)).toBe(true);
    expect(f.writes()).toEqual([]);
  });

  it.each(['forbidden', 'malformed'] as const)('losing account read after planning blocks webhook writes: %s', async (kind) => {
    const f = fixture();
    const plan = await f.build();
    if (kind === 'forbidden') f.remote.accountStatus = 403;
    else f.remote.malformed = true;
    expect((await f.apply(plan))[0]!.status).toBe('failed');
    expect(f.writes()).toEqual([]);
    expect(f.envWrites).toEqual([]);
  });

  it('pins the verified operator through async reads and webhook creation', async () => {
    const f = fixture();
    const plan = await f.build();
    f.remote.afterAccount = () => { f.tokens.STRIPE_TEST_SECRET_KEY = OP_B; };
    f.remote.afterList = () => { f.tokens.STRIPE_TEST_SECRET_KEY = OP_A2; };
    const result = await f.apply(plan);
    expect(result[0]!.status).toBe('done');
    expect(f.writes()).toHaveLength(1);
    expect(f.writes()[0]!.headers.authorization).toBe(`Bearer ${OP_A}`);
    expect(f.envWrites).toEqual(['STRIPE_WEBHOOK_SECRET']);
    expect((f.env.get('STRIPE_WEBHOOK_SECRET') as Secret).reveal()).toBe(SIGNING);
    for (const secret of [OP_A, OP_B, OP_A2, SIGNING]) expect(f.visible(plan, result)).not.toContain(secret);
  });

  it('keeps cleanup deletion on the approved account if env storage fails after credentials rotate', async () => {
    const f = fixture({ failEnv: true });
    const plan = await f.build();
    f.remote.afterAccount = () => { f.tokens.STRIPE_TEST_SECRET_KEY = OP_B; };
    const result = await f.apply(plan);
    expect(result[0]!.status).toBe('failed');
    expect(f.writes().map((c) => c.method)).toEqual(['POST', 'DELETE']);
    expect(f.writes().every((c) => c.headers.authorization === `Bearer ${OP_A}`)).toBe(true);
  });
});

describe('Stripe app key writes use the approved payment account', () => {
  it('rejects a separate app key from another account while planning', async () => {
    const f = fixture({ keys: true, app: APP_B });
    await expect(f.build()).rejects.toThrow('app key belongs to another account');
    expect(f.writes()).toEqual([]);
    expect(f.envWrites).toEqual([]);
  });

  it('binds key-only plan identity and refuses an operator switch before env writes', async () => {
    const f = fixture({ keys: true, app: APP_A });
    const before = await f.build();
    f.tokens.STRIPE_TEST_SECRET_KEY = OP_B;
    f.tokens.STRIPE_APP_TEST_SECRET_KEY = APP_B;
    const after = await f.build();
    expect(before.id).not.toBe(after.id);
    expect((await f.apply(before))[0]!.status).toBe('failed');
    expect(f.envWrites).toEqual([]);
  });

  it('refuses changed app key material after approval even within the same account', async () => {
    const f = fixture({ keys: true, app: APP_A });
    const before = await f.build();
    f.tokens.STRIPE_APP_TEST_SECRET_KEY = APP_A2;
    const after = await f.build();
    expect(before.id).not.toBe(after.id);
    expect((await f.apply(before))[0]).toMatchObject({ status: 'failed', error: expect.stringContaining('key material changed since approval') });
    expect(f.envWrites).toEqual([]);
  });

  it('writes a verified app key and persists account-bound source evidence without credentials', async () => {
    const f = fixture({ keys: true, app: APP_A });
    const plan = await f.build();
    const result = await f.apply(plan);
    expect(result[0]!.status).toBe('done');
    expect(f.envWrites).toEqual(['STRIPE_SECRET_KEY']);
    expect((f.env.get('STRIPE_SECRET_KEY') as Secret).reveal()).toBe(APP_A);
    expect(JSON.stringify(f.ctx.state.get().resources)).toContain('acct_A');
    expect(f.writes()).toEqual([]);
    for (const secret of [OP_A, APP_A]) expect(f.visible(plan, result)).not.toContain(secret);
  });
});
