import { beforeEach, describe, expect, it } from 'vitest';
import { supabaseAdapter, STATE_CREATED } from '../src/adapters/supabase.js';
import { _resetSecretRegistry, Secret } from '../src/core/secret.js';
import { emptyState } from '../src/core/state.js';
import { buildPlan } from '../src/core/plan.js';
import { applyPlan } from '../src/core/runner.js';
import { envLink } from '../src/links/env.js';
import type { Ctx, OutputKey, StepContext } from '../src/core/types.js';
import { fakeWorld } from './fakes.js';
import { mockHttp, testCtx } from './helpers.js';

const REF = 'abcdefghijklmnopqrst';
const API = `https://api.supabase.com/v1/projects/${REF}`;
const provider = supabaseAdapter.capabilities.outputs!;
const publicKeys: OutputKey[] = ['supabase.url', 'supabase.publishableKey'];
const stepCtx = (ctx: Ctx): StepContext => Object.assign(ctx, {
  remember: () => undefined, rememberValue: () => undefined, rememberSecret: () => undefined,
});

function fixture() {
  const { http, calls } = mockHttp([
    ['GET', `${API}/api-keys`, () => ({ json: [{ name: 'anon', api_key: 'public-test-key' }] })],
    ['PATCH', `${API}/database/password`, () => ({ json: {} })],
    ['GET', `${API}/config/database/pooler`, () => ({ json: [{ database_type: 'PRIMARY', db_user: `postgres.${REF}`, db_host: 'aws-1-us-east-2.pooler.supabase.com', db_name: 'postgres' }] })],
  ]);
  const ctx = testCtx({
    http, tokens: { SUPABASE_ACCESS_TOKEN: 'test-management-token' },
    state: { ...emptyState(), resources: { 'supabase.ref': REF, [STATE_CREATED]: REF } },
  });
  return { ctx, calls };
}

beforeEach(() => _resetSecretRegistry());

describe('Supabase outputs respect the approved env writes', () => {
  it('public URL/key planning and writes never reset a lost DB password or fetch pooler settings', async () => {
    const { ctx, calls } = fixture();
    expect(await provider.provides!(ctx, 'production', publicKeys)).toEqual(publicKeys);
    expect(await provider.outputs(stepCtx(ctx), 'production', publicKeys)).toEqual({
      'supabase.url': `https://${REF}.supabase.co`, 'supabase.publishableKey': 'public-test-key',
    });
    expect(calls.every((c) => c.method === 'GET' && c.url.includes('/api-keys'))).toBe(true);
    expect(ctx.logs).toEqual([]);
  });

  it('a URL-only request does not reveal keys or access password/pooler endpoints', async () => {
    const { ctx, calls } = fixture();
    expect(await provider.outputs(stepCtx(ctx), 'production', ['supabase.url'])).toEqual({ 'supabase.url': `https://${REF}.supabase.co` });
    expect(calls).toEqual([]);
  });

  it('explicit DB URL requests still recover a password only during an env write', async () => {
    const { ctx, calls } = fixture();
    expect(await provider.provides!(ctx, 'production', ['db.url'])).toEqual(['db.url']);
    expect(calls).toEqual([]);
    const out = await provider.outputs(stepCtx(ctx), 'production', ['db.url']);
    expect(Object.keys(out)).toEqual(['db.url']);
    expect(out['db.url']).toBeInstanceOf(Secret);
    expect(calls.filter((c) => c.method === 'PATCH')).toHaveLength(1);
    expect(calls.some((c) => c.url.includes('/api-keys'))).toBe(false);
  });

  it('checks requesting a DB URL remain read-only', async () => {
    const { ctx, calls } = fixture();
    expect(await provider.outputs(ctx, 'production', ['db.url'])).toEqual({});
    expect(calls).toEqual([]);
  });

  it.each([false, true])('the env link keeps a human-owned DB URL before fetching outputs (plan lookup failed: %s)', async (planLookupFails) => {
    const world = fakeWorld();
    const db = world.adapters.find((a) => a.axes.includes('db'))!;
    const seen: OutputKey[][] = [];
    db.capabilities = { ...db.capabilities, outputs: {
      provides: async (_ctx, _target, keys) => { expect(keys).toContain('db.url'); return ['db.url', ...publicKeys]; },
      outputs: async (_ctx, _target, keys) => {
        expect(keys).toEqual(['supabase.publishableKey']);
        seen.push([...keys!]);
        return { 'supabase.publishableKey': 'public-test-key' };
      },
    } };
    // Existing DATABASE_URL belongs to the human; golive must not reset its source password.
    world.host.env.production.set('DATABASE_URL', new Secret('DATABASE_URL', 'user-owned-test-url'));
    const host = world.adapters.find((a) => a.axes.includes('hosting'))!;
    const listNames = host.capabilities.env!.listNames;
    let reads = 0;
    host.capabilities.env!.listNames = async (ctx, target) => {
      if (planLookupFails && reads++ === 0) throw new Error('temporary provider listing failure');
      return listNames(ctx, target);
    };
    const ctx = testCtx({
      adapters: world.adapters,
      config: { stack: { hosting: 'fakehost', db: db.id }, targets: ['production'] },
      detect: { envRefs: ['DATABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY'].map((name) => ({ name, files: ['app.ts'], clientExposed: name.startsWith('NEXT_PUBLIC_') })) },
    });
    const plan = await buildPlan(ctx, [envLink], { warnings: [], unmappedEnv: [] });
    const results = await applyPlan(ctx, plan, new Map(), { approvedPlanId: plan.id, yes: true, confirmLive: false, confirmDns: false });
    expect(results.every((r) => r.status === 'done')).toBe(true);
    expect(seen).toEqual([['supabase.publishableKey']]);
    expect(world.host.env.production.get('NEXT_PUBLIC_SUPABASE_ANON_KEY')).toBe('public-test-key');
  });
});
