import { describe, expect, it } from 'vitest';
import { buildPlan, planId, planView } from '../src/core/plan.js';
import { applyPlan, stepHash } from '../src/core/runner.js';
import type { Adapter, ProjectCreateTarget, ProjectRef, Step } from '../src/core/types.js';
import { projectsLink } from '../src/links/projects.js';
import { resetMemo } from '../src/links/util.js';
import { vercelAdapter } from '../src/adapters/vercel.js';
import { supabaseAdapter } from '../src/adapters/supabase.js';
import { mockExec, mockHttp, testCtx } from './helpers.js';

const approve = (id: string) => ({ approvedPlanId: id, yes: true, confirmLive: false, confirmDns: false });
const build = (ctx: ReturnType<typeof testCtx>) => { resetMemo(ctx); return buildPlan(ctx, [projectsLink], { unmappedEnv: [], warnings: [] }); };

function fakeDestination() {
  let target: ProjectCreateTarget = { scope: { kind: 'team', id: 'team_a', name: 'Team A' } };
  let current: ProjectRef | null = null;
  let creates = 0;
  let selects = 0;
  const adapter: Adapter = {
    id: 'fake', title: 'Fake', axes: ['hosting'], automated: true, auth: async () => ({ ok: true, via: 'same user' }),
    capabilities: { project: {
      current: async () => current,
      candidates: async () => [],
      resolve: async (ctx, id) => ({ id, name: 'demo', scope: target.scope }),
      creationTarget: async () => target,
      select: async (ctx, id) => { selects++; return { id, name: 'demo', scope: target.scope }; },
      create: async (ctx, name, approved) => { creates++; return { id: 'new', name, scope: approved?.scope }; },
    } },
  };
  const ctx = testCtx({ adapters: [adapter], config: { stack: { hosting: 'fake' } }, cwd: '/work/demo' });
  return { ctx, setTarget: (value: ProjectCreateTarget) => { target = value; }, setCurrent: (value: ProjectRef) => { current = value; }, writes: () => ({ creates, selects }) };
}

describe('structured project approval destinations', () => {
  it('shows creation owner/project/action separately from authentication', async () => {
    const f = fakeDestination();
    const p = await build(f.ctx);
    expect(planView(p).targets).toEqual([{
      stepId: 'project:hosting', axis: 'hosting', provider: 'fake', providerTitle: 'Fake', action: 'create',
      project: { name: 'demo' }, scope: { kind: 'team', id: 'team_a', name: 'Team A' }, access: 'Fake access: same user',
    }]);
    const out = await applyPlan(f.ctx, p, new Map(), approve(p.id));
    expect(out[0]?.status).toBe('done');
    expect(f.writes()).toEqual({ creates: 1, selects: 0 });
  });

  it('hashes destination changes even when all visible step text stays the same', async () => {
    const f = fakeDestination();
    const p = await build(f.ctx);
    const before = p.steps[0]!;
    const after = { ...before, destination: { ...before.destination!, scope: { kind: 'team' as const, id: 'team_b' } } };
    expect(planId([before], [], p.release)).not.toBe(planId([after], [], p.release));
    expect(stepHash(before)).not.toBe(stepHash(after));
  });

  it('rejects the old approval when the same account resolves a different create scope', async () => {
    const f = fakeDestination();
    const before = await build(f.ctx);
    f.setTarget({ scope: { kind: 'team', id: 'team_b', name: 'Team B' } });
    const after = await build(f.ctx);
    expect(after.id).not.toBe(before.id);
    await expect(applyPlan(f.ctx, after, new Map(), approve(before.id))).rejects.toThrow(/changed since approval/);
    expect(f.writes().creates).toBe(0);
  });

  it('refuses create if the destination changes after plan construction', async () => {
    const f = fakeDestination();
    const plan = await build(f.ctx);
    f.setTarget({ scope: { kind: 'team', id: 'team_b' } });
    const result = await applyPlan(f.ctx, plan, new Map(), approve(plan.id));
    expect(result[0]?.status).toBe('failed');
    expect(result[0]?.error).toMatch(/destination.*changed/);
    expect(f.writes().creates).toBe(0);
  });

  it('rechecks the owner of a pinned existing project before linking or writing', async () => {
    const f = fakeDestination();
    f.setCurrent({ id: 'existing', name: 'demo' });
    const p = await build(f.ctx);
    expect(planView(p).targets[0]).toMatchObject({ action: 'pin', project: { id: 'existing' }, scope: { id: 'team_a' } });
    f.setTarget({ scope: { kind: 'team', id: 'team_b' } });
    const out = await applyPlan(f.ctx, p, new Map(), approve(p.id));
    expect(out[0]?.status).toBe('failed');
    expect(f.writes()).toEqual({ creates: 0, selects: 0 });
  });

  it.each([false, true])('rechecks completed project guards before resumed dependent writes (--only=%s)', async (only) => {
    const f = fakeDestination();
    f.setCurrent({ id: 'existing', name: 'demo' });
    const p = await build(f.ctx);
    let writes = 0;
    const write: Step = { id: 'env:production', title: 'Write env', kind: 'wire', risk: { writes: true }, preview: ['write env'], dependsOn: ['project:hosting'], verifyWith: [], run: async () => { writes++; return { changes: [] }; } };
    p.steps.push(write);
    p.id = planId(p.steps, p.handoffs, p.release);
    await applyPlan(f.ctx, p, new Map(), { ...approve(p.id), only: ['project:hosting'] });
    f.setTarget({ scope: { kind: 'team', id: 'team_b' } });
    const result = await applyPlan(f.ctx, p, new Map(), { ...approve(p.id), ...(only ? { only: ['env:production'] } : {}) });
    expect(result[0]).toMatchObject({ id: 'project:hosting', status: 'failed' });
    expect(writes).toBe(0);
  });
});

const VERCEL = 'https://api.vercel.com';
function vercelCli() {
  return mockExec([
    ['vercel whoami', { stdout: JSON.stringify({ username: 'alice', team: { id: 'team_a', name: 'Team A', slug: 'a' } }) }],
    [/^vercel api /, (call) => {
      const path = call.args[1]!;
      if (path.startsWith('/v2/teams/')) { const id = path.split('/').at(-1)!; return { stdout: JSON.stringify({ id, name: id, slug: id }) }; }
      if (path.startsWith('/v10/projects')) return { stdout: '{"projects":[]}' };
      if (path === '/v11/projects' && call.args[3] === 'POST') {
        const scope = call.args[call.args.indexOf('--scope') + 1];
        return { stdout: JSON.stringify({ id: 'prj_new', name: 'demo', accountId: scope }) };
      }
      return { code: 1, stderr: 'Error: Not Found (404)' };
    }],
  ]);
}

describe('Vercel approved project scope', () => {
  it('binds an explicit scope override even though CLI whoami default stays unchanged', async () => {
    const ex = vercelCli();
    const env = { VERCEL_ORG_ID: 'team_a' };
    const ctx = testCtx({ exec: ex.run, env, adapters: [vercelAdapter], config: { stack: { hosting: 'vercel' } }, cwd: '/work/demo' });
    const a = await build(ctx);
    env.VERCEL_ORG_ID = 'team_b';
    const b = await build(ctx);
    expect(planView(a).targets[0]?.scope?.id).toBe('team_a');
    expect(planView(b).targets[0]?.scope?.id).toBe('team_b');
    expect(b.id).not.toBe(a.id);
    await expect(applyPlan(ctx, b, new Map(), approve(a.id))).rejects.toThrow(/changed since approval/);
    expect(ex.calls.some((c) => c.args[3] === 'POST')).toBe(false);
  });

  it('sends the approved scope explicitly when creating through the CLI', async () => {
    const ex = vercelCli();
    const ctx = testCtx({ exec: ex.run });
    const linker = vercelAdapter.capabilities.project!;
    const target = await linker.creationTarget!(ctx);
    const p = await linker.create!(ctx, 'demo', target);
    expect(p.scope?.id).toBe('team_a');
    expect(ex.calls.find((c) => c.args[3] === 'POST')?.args).toEqual(expect.arrayContaining(['--scope', 'team_a']));
  });

  it('rejects direct creation after the selected scope drifts without sending a POST', async () => {
    const ex = vercelCli();
    const env = { VERCEL_ORG_ID: 'team_a' };
    const ctx = testCtx({ exec: ex.run, env });
    const linker = vercelAdapter.capabilities.project!;
    const target = await linker.creationTarget!(ctx);
    env.VERCEL_ORG_ID = 'team_b';
    await expect(linker.create!(ctx, 'demo', target)).rejects.toThrow(/scope changed/);
    expect(ex.calls.some((c) => c.args[3] === 'POST')).toBe(false);
  });

  it('uses the approved token team in the HTTP query and strips raw project secrets', async () => {
    const h = mockHttp([
      ['GET', `${VERCEL}/v2/teams/team_b`, () => ({ json: { id: 'team_b', name: 'Team B' } })],
      ['GET', `${VERCEL}/v9/projects/demo`, () => ({ status: 404, json: { error: { code: 'not_found' } } })],
      ['POST', `${VERCEL}/v11/projects`, () => ({ json: { id: 'new', name: 'demo', accountId: 'team_b', protectionBypass: { private_value: {} } } })],
    ]);
    const ctx = testCtx({ exec: mockExec([['vercel whoami', { code: 1 }]]).run, http: h.http, tokens: { VERCEL_TOKEN: 'mock-token' }, env: { VERCEL_ORG_ID: 'team_b' } });
    const linker = vercelAdapter.capabilities.project!;
    const target = await linker.creationTarget!(ctx);
    const p = await linker.create!(ctx, 'demo', target);
    expect(h.calls.find((c) => c.method === 'POST')?.url).toBe(`${VERCEL}/v11/projects?teamId=team_b`);
    expect(JSON.stringify(p)).not.toContain('private_value');
  });

  it('refuses same-name adoption after an approved create without a POST', async () => {
    const h = mockHttp([
      ['GET', `${VERCEL}/v2/teams/team_b`, () => ({ json: { id: 'team_b', name: 'Team B' } })],
      ['GET', `${VERCEL}/v9/projects/demo`, () => ({ json: { id: 'existing', name: 'demo', accountId: 'team_b' } })],
    ]);
    const ctx = testCtx({ exec: mockExec([['vercel whoami', { code: 1 }]]).run, http: h.http, tokens: { VERCEL_TOKEN: 'mock-token' }, env: { VERCEL_ORG_ID: 'team_b' } });
    const linker = vercelAdapter.capabilities.project!;
    const target = await linker.creationTarget!(ctx);
    await expect(linker.create!(ctx, 'demo', target)).rejects.toThrow(/appeared after approval/);
    expect(h.calls.some((c) => c.method === 'POST')).toBe(false);
    expect(ctx.state.resource('vercel.projectId')).toBeUndefined();
  });
});

const SUPABASE = 'https://api.supabase.com/v1';
const REF = 'abcdefghijklmnopqrst';
function supabaseOrg(opts: { missingCreateOrg?: boolean; missingReadbackOrg?: boolean; wrongCreateOrg?: boolean } = {}) {
  let free = 'org_a';
  let existing = false;
  let created = false;
  const h = mockHttp([
    ['GET', `${SUPABASE}/profile`, () => ({ json: { username: 'same-user' } })],
    ['GET', `${SUPABASE}/projects`, () => ({ json: existing || created ? [{ ref: REF, name: 'demo', ...(!opts.missingReadbackOrg ? { organization_slug: free } : {}), status: 'ACTIVE_HEALTHY' }] : [] })],
    ['GET', `${SUPABASE}/organizations`, () => ({ json: [{ slug: 'org_a', name: 'Org A' }, { slug: 'org_b', name: 'Org B' }] })],
    ['GET', new RegExp(`${SUPABASE}/organizations/org_[ab]$`), (call) => ({ json: { plan: call.url.endsWith(free) ? 'free' : 'pro' } })],
    ['POST', `${SUPABASE}/projects`, () => { created = true; return { json: { ref: REF, name: 'demo', ...(!opts.missingCreateOrg ? { organization_slug: opts.wrongCreateOrg ? 'org_unapproved' : free } : {}), status: 'ACTIVE_HEALTHY' } }; }],
    ['GET', `${SUPABASE}/projects/${REF}`, () => ({ json: { ref: REF, name: 'demo', organization_slug: free, status: 'ACTIVE_HEALTHY' } })],
  ]);
  const ctx = testCtx({ http: h.http, tokens: { SUPABASE_ACCESS_TOKEN: 'mock-pat' }, adapters: [supabaseAdapter], config: { stack: { db: 'supabase' } }, cwd: '/work/demo' });
  return { ctx, calls: h.calls, setFree: (id: string) => { free = id; }, setExisting: () => { existing = true; } };
}

describe('Supabase approved project organization', () => {
  it('changes the plan ID when the same user has a different sole free organization', async () => {
    const f = supabaseOrg();
    const a = await build(f.ctx);
    f.setFree('org_b');
    const b = await build(f.ctx);
    expect(planView(a).targets[0]?.scope).toEqual({ kind: 'organization', id: 'org_a', name: 'Org A' });
    expect(planView(b).targets[0]?.scope?.id).toBe('org_b');
    expect(a.id).not.toBe(b.id);
    await expect(applyPlan(f.ctx, b, new Map(), approve(a.id))).rejects.toThrow(/changed since approval/);
    expect(f.calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('revalidates organization at create and refuses stale approval before writing', async () => {
    const f = supabaseOrg();
    const linker = supabaseAdapter.capabilities.project!;
    const target = await linker.creationTarget!(f.ctx);
    f.setFree('org_b');
    await expect(linker.create!(f.ctx, 'demo', target)).rejects.toThrow(/organization or region changed/);
    expect(f.calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('creates in exactly the approved organization and region', async () => {
    const f = supabaseOrg();
    const linker = supabaseAdapter.capabilities.project!;
    const target = await linker.creationTarget!(f.ctx);
    const project = await linker.create!(f.ctx, 'demo', target);
    expect(project.scope).toEqual(target.scope);
    expect(f.calls.find((c) => c.method === 'POST')?.body).toMatchObject({ organization_slug: 'org_a', region_selection: { type: 'smartGroup', code: 'americas' } });
  });

  it('refuses to adopt a project that appears after an approved create', async () => {
    const f = supabaseOrg();
    const linker = supabaseAdapter.capabilities.project!;
    const target = await linker.creationTarget!(f.ctx);
    f.setExisting();
    await expect(linker.create!(f.ctx, 'demo', target)).rejects.toThrow(/appeared after approval/);
    expect(f.calls.some((c) => c.method === 'POST')).toBe(false);
    expect(f.ctx.state.resource('supabase.ref')).toBeUndefined();
  });

  it('confirms ownership through a readback when the creation response omits it', async () => {
    const f = supabaseOrg({ missingCreateOrg: true });
    const linker = supabaseAdapter.capabilities.project!;
    const target = await linker.creationTarget!(f.ctx);
    expect((await linker.create!(f.ctx, 'demo', target)).scope).toEqual(target.scope);
    const postAt = f.calls.findIndex((c) => c.method === 'POST');
    expect(f.calls.slice(postAt + 1).some((c) => c.method === 'GET' && c.url === `${SUPABASE}/projects`)).toBe(true);
  });

  it.each([{ missingCreateOrg: true, missingReadbackOrg: true }, { wrongCreateOrg: true }])('refuses success/state when the new owner cannot be confirmed: %j', async (opts) => {
    const f = supabaseOrg(opts);
    const linker = supabaseAdapter.capabilities.project!;
    const target = await linker.creationTarget!(f.ctx);
    await expect(linker.create!(f.ctx, 'demo', target)).rejects.toThrow(/organization/);
    expect(f.ctx.state.resource('supabase.ref')).toBeUndefined();
    expect(f.calls.filter((c) => c.method === 'POST')).toHaveLength(1);
  });
});
