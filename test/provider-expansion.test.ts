import { describe, expect, it } from 'vitest';
import { parseConfig } from '../src/core/config.js';
import { createHttp } from '../src/core/http.js';
import { buildPlan, planView } from '../src/core/plan.js';
import { applyPlan, runCheck } from '../src/core/runner.js';
import { Secret } from '../src/core/secret.js';
import { dbConnectionCheck } from '../src/checks/db-connection.js';
import { ALL_LINKS } from '../src/links/all.js';
import { testCtx } from './helpers.js';
import { fakeWorld, FAKE_STACK, RAW } from './fakes.js';
import type { Adapter } from '../src/core/types.js';

const build = (ctx: Parameters<typeof buildPlan>[0]) => buildPlan(ctx, ALL_LINKS, { unmappedEnv: [], warnings: [] });
const approval = (id: string) => ({ approvedPlanId: id, yes: true, confirmLive: false, confirmDns: false });

describe('Neon non-secret configuration', () => {
  it('preserves explicit connection selectors', () => {
    const cfg = parseConfig('version: 1\nneon:\n  organizationId: org-test\n  region: aws-us-east-1\n  branchId: br-demo\n  database: neondb\n  role: app_owner');
    expect(cfg.neon).toEqual({ organizationId: 'org-test', region: 'aws-us-east-1', branchId: 'br-demo', database: 'neondb', role: 'app_owner' });
  });
  it.each(['null', '[]', 'foo', '{branchId: ""}', '{role: 42}', '{region: https://other.example}', '{database: "a/b"}', '{token: do-not-print-this}', '{apiKey: do-not-print-this}'])('rejects malformed selectors and credentials (%s)', (input) => {
    expect(() => parseConfig(`version: 1\nneon: ${input}`)).toThrow();
    try { parseConfig(`version: 1\nneon: ${input}`); } catch (e) {
      expect(String(e)).not.toContain('do-not-print-this');
    }
  });
});

describe('second-provider transport boundaries', () => {
  it('allows management APIs but does not broadly allow Neon compute hosts', async () => {
    const http = createHttp((async () => new Response('{}')) as typeof fetch);
    for (const url of ['https://api.netlify.com/api/v1/accounts', 'https://console.neon.tech/api/v2/projects']) {
      expect((await http({ url })).status).toBe(200);
    }
    await expect(http({ url: 'https://unconfirmed.neon.tech/sql' })).rejects.toThrow(/not allowed/);
    await expect(http({ url: 'https://console.neon.tech.evil.example/api/v2/projects' })).rejects.toThrow(/not allowed/);
  });
});

describe('connection selectors bind approval and managed env', () => {
  it('refuses selector drift during an approved run before reading or writing credentials', async () => {
    const w = fakeWorld();
    const db = w.adapters.find((a) => a.id === FAKE_STACK.db)!;
    db.capabilities = { ...db.capabilities, outputs: { ...db.capabilities.outputs!, identity: async (ctx) => JSON.stringify(ctx.config.neon) } };
    const ctx = testCtx({ adapters: w.adapters,
      config: { stack: { hosting: FAKE_STACK.hosting, db: FAKE_STACK.db }, targets: ['production'], neon: { branchId: 'br-approved', database: 'app', role: 'owner' } },
      detect: { envRefs: [{ name: 'DATABASE_URL', files: ['src/db.ts'], clientExposed: false }] },
    });
    const p = await build(ctx);
    ctx.config.neon!.branchId = 'br-unapproved';
    const results = await applyPlan(ctx, p, new Map(), approval(p.id));
    expect(results.at(-1)).toMatchObject({ id: 'env:production', status: 'failed', error: expect.stringContaining('selectors changed') });
    expect(w.db.outputsCalls).toBe(0);
    expect(w.host.env.production.size).toBe(0);
  });
  it('does not treat failed project discovery as approval to create', async () => {
    const w = fakeWorld();
    w.host.current = null;
    const host = w.adapters.find(a => a.id === FAKE_STACK.hosting)!;
    host.capabilities.project!.candidates = async () => { throw new Error('Select an explicit project and branch first'); };
    const ctx = testCtx({ adapters: w.adapters, config: { stack: { hosting: FAKE_STACK.hosting } } });
    await expect(build(ctx)).rejects.toThrow(/listing FakeHost project candidates failed.*explicit project/);
    expect(w.host.current).toBeNull();
  });
  it.each(['branchId', 'database', 'role'] as const)('changing %s on the same project needs a new approval and rewrites managed env', async (field) => {
    const w = fakeWorld();
    const db = w.adapters.find((a) => a.id === FAKE_STACK.db)!;
    db.capabilities = { ...db.capabilities, outputs: { ...db.capabilities.outputs!, identity: async (ctx) => JSON.stringify(ctx.config.neon) } };
    const ctx = testCtx({
      adapters: w.adapters,
      config: { stack: { hosting: FAKE_STACK.hosting, db: FAKE_STACK.db }, targets: ['production'], neon: { branchId: 'br-first', database: 'app', role: 'owner' } },
      detect: { envRefs: [{ name: 'DATABASE_URL', files: ['src/db.ts'], clientExposed: false }] },
    });
    const first = await build(ctx);
    expect(JSON.stringify(planView(first))).toContain('br-first');
    expect(JSON.stringify(planView(first))).not.toContain(RAW.dbUrl);
    const results = await applyPlan(ctx, first, new Map(), approval(first.id));
    expect(results.every((r) => r.status === 'done' || r.status === 'skipped')).toBe(true);
    expect((await build(ctx)).steps.some((s) => s.id === 'env:production')).toBe(false);
    ctx.config.neon![field] = 'changed';
    const changed = await build(ctx);
    expect(changed.id).not.toBe(first.id);
    const env = changed.steps.find((s) => s.id === 'env:production')!;
    expect(env.preview.join('\n')).toContain('update (managed by golive) DATABASE_URL');
    expect(env.preview.join('\n')).toContain('changed');
    await expect(applyPlan(ctx, changed, new Map(), approval(first.id))).rejects.toThrow(/plan changed/);
    const state = JSON.stringify(ctx.state.get());
    expect(state).toContain('br-first');
    expect(state).not.toContain(RAW.dbUrl);
  });
});

describe('database connection evidence', () => {
  function setup(opts: { authed?: boolean; linked?: boolean; probe?: () => Promise<{ database: string; role: string }> } = {}) {
    let probes = 0;
    const adapter: Adapter = {
      id: 'testdb', title: 'Test DB', axes: ['db'], automated: true,
      auth: async () => ({ ok: opts.authed !== false }),
      capabilities: {
        project: {
          current: async () => opts.linked === false ? null : { id: 'db-1', name: 'app' },
          candidates: async () => [], select: async () => ({ id: 'db-1', name: 'app' }),
        },
        dbConnection: { probe: async () => { probes++; return opts.probe ? opts.probe() : { database: 'app', role: 'app_owner' }; } },
      },
    };
    return { ctx: testCtx({ adapters: [adapter], config: { stack: { db: 'testdb' } } }), probes: () => probes };
  }
  it('records connectivity with an explicit limit on its evidence', async () => {
    const { ctx, probes } = setup();
    const check = await runCheck(ctx, dbConnectionCheck);
    expect(check.status).toBe('pass');
    expect(probes()).toBe(1);
    expect(check.evidence.join(' ')).toMatch(/database app, role app_owner/);
    expect(check.evidence.join(' ')).toMatch(/Auth and user-data isolation need separate/);
  });
  it.each([{ authed: false }, { linked: false }])('skips missing prerequisites without a database probe (%j)', async (opts) => {
    const { ctx, probes } = setup(opts);
    expect((await runCheck(ctx, dbConnectionCheck)).status).toBe('skip');
    expect(probes()).toBe(0);
  });
  it('fails a rejected connection without leaking credentials', async () => {
    const secret = new Secret('DATABASE_URL', 'postgresql://role:private-test-value@ep-demo.neon.tech/app');
    const { ctx } = setup({ probe: async () => { throw new Error(`rejected ${secret.reveal()}`); } });
    const check = await runCheck(ctx, dbConnectionCheck);
    expect(check.status).toBe('fail');
    expect(JSON.stringify(check)).not.toContain('private-test-value');
  });
  it('does not imply connectivity for an unsupported DB capability', async () => {
    expect((await runCheck(testCtx({ config: { stack: { db: 'supabase' } } }), dbConnectionCheck)).status).toBe('skip');
  });
});
