import { beforeEach, describe, expect, it } from 'vitest';
import { mockExec, mockHttp, testCtx } from '../helpers.js';
import { Secret, _resetSecretRegistry } from '../../src/core/secret.js';
import { neonAdapter, neonTiming, verifyNeonConnection } from '../../src/adapters/neon.js';
import { NEON_API, neonApi } from '../../src/adapters/neon-api.js';
import type { Ctx, HttpRequest, ProjectCreateTarget } from '../../src/core/types.js';

const caps = neonAdapter.capabilities;
const project = caps.project!;
const output = caps.outputs!;
const ORG = 'org-test-free';
const PID = 'small-star-123456';
const BRANCH = 'br-test-123456';
const HOST = 'ep-test-123456.us-east-2.aws.neon.tech';
const TOKEN = 'neon' + '-mock-api-token-not-real';
const PASS = 'mock' + '-database-password-not-real';
const URI = `postgresql://neondb_owner:${PASS}@${HOST}/neondb?sslmode=require`;
const POOL = URI.replace(HOST, HOST.replace('.', '-pooler.'));
const record = { id: PID, name: 'demo', org_id: ORG, owner_id: ORG, region_id: 'aws-us-east-2' };
const org = { id: ORG, name: 'Test organization', plan: 'free' };
const branch = { id: BRANCH, project_id: PID, name: 'main', current_state: 'ready' };
const endpoint = { id: 'ep-test-123456', host: HOST, project_id: PID, branch_id: BRANCH, type: 'read_write', disabled: false };
const selected = { stack: { db: 'neon' }, projects: { db: PID }, neon: { branchId: BRANCH, database: 'neondb', role: 'neondb_owner' } };
const approved: ProjectCreateTarget = { scope: { kind: 'organization', id: ORG, name: org.name }, region: 'aws-us-east-2' };
type Routes = Parameters<typeof mockHttp>[0];
function baseRoutes(over: Partial<{ project: unknown; branch: unknown; databases: unknown; roles: unknown; endpoints: unknown; uri: string; pooled: string; plan: string }> = {}): Routes {
  return [
    ['GET', `${NEON_API}/projects/${PID}`, () => ({ json: { project: over.project ?? record } })],
    ['GET', `${NEON_API}/organizations/${ORG}`, () => ({ json: { ...org, plan: over.plan ?? 'free' } })],
    ['GET', `${NEON_API}/projects/${PID}/branches/${BRANCH}`, () => ({ json: { branch: over.branch ?? branch } })],
    ['GET', `${NEON_API}/projects/${PID}/branches/${BRANCH}/databases`, () => ({ json: { databases: over.databases ?? [{ name: 'neondb', branch_id: BRANCH }] } })],
    ['GET', `${NEON_API}/projects/${PID}/branches/${BRANCH}/roles`, () => ({ json: { roles: over.roles ?? [{ name: 'neondb_owner', branch_id: BRANCH, authentication_method: 'password' }] } })],
    ['GET', `${NEON_API}/projects/${PID}/endpoints`, () => ({ json: { endpoints: over.endpoints ?? [endpoint] } })],
    ['GET', `${NEON_API}/projects/${PID}/connection_uri`, (c) => ({ json: { uri: new URL(c.url).searchParams.get('pooled') === 'true' ? over.pooled ?? POOL : over.uri ?? URI } })],
  ];
}
function creationRoutes(over: Partial<{ plan: string; response: unknown; readback: unknown; existing: unknown[]; operation: unknown }> = {}): Routes {
  return [
    ['GET', `${NEON_API}/users/me/organizations`, () => ({ json: { organizations: [org] } })],
    ['GET', `${NEON_API}/organizations/${ORG}`, () => ({ json: { ...org, plan: over.plan ?? 'free' } })],
    ['GET', `${NEON_API}/projects`, () => ({ json: { projects: over.existing ?? [] } })],
    ['POST', `${NEON_API}/projects`, () => ({ status: 201, json: over.response ?? { project: record, branch, operations: [{ id: 'op-test', project_id: PID }], roles: [{ password: PASS }], connection_uris: [{ connection_uri: URI }] } })],
    ['GET', `${NEON_API}/projects/${PID}`, () => ({ json: { project: over.readback ?? record } })],
    ['GET', `${NEON_API}/projects/${PID}/operations/op-test`, () => ({ json: { operation: over.operation ?? { id: 'op-test', project_id: PID, status: 'finished' } } })],
  ];
}
function tokenCtx(routes: Routes, config: NonNullable<Parameters<typeof testCtx>[0]>['config'] = selected) {
  const mocked = mockHttp(routes);
  return { ...mocked, ctx: testCtx({ config, http: mocked.http, tokens: { NEON_API_KEY: TOKEN } }) };
}
function noSecrets(ctx: Ctx, values: unknown[] = []) { const all = JSON.stringify([ctx.state.get(), ...values]); expect(all).not.toContain(PASS); expect(all).not.toContain(TOKEN); expect(all).not.toContain(URI); }
beforeEach(() => { _resetSecretRegistry(); neonTiming.pollMs = 0; neonTiming.timeoutMs = 1000; });

describe('Neon authentication and transport', () => {
  it('uses token only in a Secret header and does not expose auth_data', async () => {
    const { ctx, calls } = tokenCtx([['GET', `${NEON_API}/auth`, () => ({ json: { account_id: ORG, auth_method: 'api_key_org', auth_data: PASS } })]]);
    const status = await neonAdapter.auth(ctx);
    expect(status.ok).toBe(true); expect(calls[0]!.headers.authorization).toBe(`Bearer ${TOKEN}`); noSecrets(ctx, [status, ctx.logs]);
  });
  it('does not fall back to CLI after an explicit token is rejected or leak raw errors', async () => {
    const ex = mockExec([]);
    const { http } = mockHttp([['GET', `${NEON_API}/auth`, () => ({ status: 401, json: { message: PASS, uri: URI } })]]);
    const ctx = testCtx({ http, exec: ex.run, tokens: { NEON_API_KEY: TOKEN } });
    const status = await neonAdapter.auth(ctx); expect(status.ok).toBe(false); expect(ex.calls).toHaveLength(0); noSecrets(ctx, [status]);
  });
  it('reuses the CLI with fixed hosts and CI mode, without auth/cache/key commands', async () => {
    const ex = mockExec([['neon api /auth', { stdout: JSON.stringify({ account_id: ORG, auth_method: 'oauth' }) }]]);
    const ctx = testCtx({ exec: ex.run });
    expect((await neonAdapter.auth(ctx)).ok).toBe(true);
    expect(ex.calls[0]!.args).toContain(NEON_API); expect(ex.calls[0]!.opts!.env).toEqual({ CI: '1' }); expect(ex.calls[0]!.args).not.toContain('--api-key');
  });
  it('reports missing/expired CLI login with safe separate-terminal and editor help', async () => {
    const ex = mockExec([['neon api', { code: 1, stdout: URI, stderr: PASS }]]);
    const ctx = testCtx({ exec: ex.run }); const status = await neonAdapter.auth(ctx);
    expect(status.ok).toBe(false); expect(status.howToFix).toContain('SEPARATE terminal'); expect(status.howToFix).toContain('credentials --setup'); noSecrets(ctx, [status]);
  });
  it.each([
    ['ERROR: Unknown arguments: data', 'cli-arguments'],
    ['ERROR: Cannot run interactive auth in CI', 'authentication'],
    ['ERROR: Permission denied', 'permissions'],
    ['DEBUG: status: 403 Forbidden | path: /api/v2/projects', 'permissions'],
    ['ERROR: organization project limit exceeded', 'limits'],
    ['ERROR: Request timed out', 'timeout'],
    ['ERROR: Could not reach the Neon API. Please check your internet connection.', 'network'],
    ['DEBUG: status: 503 Service Unavailable | path: /api/v2/projects', 'service'],
    ['ERROR: Invalid project parameter', 'request'],
  ])('classifies CLI failures without revealing provider text: %s', async (diagnostic, category) => {
    const ex = mockExec([['neon api', { code: 1, stdout: URI, stderr: `${diagnostic}\n${PASS}\n${URI}` }]]);
    const ctx = testCtx({ exec: ex.run });
    const failure = await neonApi(ctx, '/projects', 'POST', { project: { name: 'demo' } }).catch((e: Error) => e);
    expect(failure).toBeInstanceOf(Error); expect(String(failure)).toContain(`category: ${category}`);
    expect(String(failure)).toContain('re-plan before any retry'); expect(ex.calls).toHaveLength(1);
    expect(String(failure)).not.toContain(PASS); expect(String(failure)).not.toContain(URI); expect(ctx.state.get().resources).toEqual({});
    if (category !== 'authentication') expect(String(failure)).not.toContain('run neon auth');
  });
  it('does not diagnose an unknown operation failure as a lost login', async () => {
    const ex = mockExec([['neon api', { code: 1, stdout: URI, stderr: PASS }]]);
    const ctx = testCtx({ exec: ex.run });
    const failure = await neonApi(ctx, '/projects', 'POST', { project: { name: 'demo' } }).catch((e: Error) => e);
    expect(String(failure)).toContain('category: unknown'); expect(String(failure)).toContain('Authentication may still be valid');
    expect(String(failure)).not.toContain('run neon auth'); expect(String(failure)).not.toContain(PASS); expect(String(failure)).not.toContain(URI); expect(ex.calls).toHaveLength(1);
  });
  it('treats lost or malformed create responses as ambiguous, without retrying or exposing output', async () => {
    for (const run of [mockExec([['neon api', { stdout: URI }]]).run, async () => { throw new Error(PASS); }]) {
      let calls = 0;
      const ctx = testCtx({ exec: async (...args) => { calls++; return run(...args); } });
      const failure = await neonApi(ctx, '/projects', 'POST', { project: { name: 'demo' } }).catch((e: Error) => e);
      expect(String(failure)).toContain('Creation may have succeeded'); expect(String(failure)).toContain('re-plan before any retry');
      expect(String(failure)).not.toContain('run neon auth'); expect(String(failure)).not.toContain(PASS); expect(String(failure)).not.toContain(URI); expect(calls).toBe(1);
    }
  });
});

describe('Neon project approval and creation', () => {
  it('does not infer a project from account login or a .neon file', async () => { expect(await project.current(testCtx())).toBeNull(); });
  it('resolves exact project scope without writing local state', async () => {
    const { ctx } = tokenCtx(baseRoutes()); expect(await project.current(ctx)).toEqual({ id: PID, name: 'demo', scope: { kind: 'organization', id: ORG } }); expect(ctx.state.get().resources).toEqual({});
  });
  it('rejects missing or contradictory owner identity', async () => {
    for (const p of [{ ...record, owner_id: 'org-other' }, { id: PID, name: 'demo' }]) {
      const { ctx } = tokenCtx(baseRoutes({ project: p })); await expect(project.current(ctx)).rejects.toThrow(); expect(ctx.state.get().resources).toEqual({});
    }
  });
  it('uses explicitly selected organization and refuses paid or unknown plans', async () => {
    for (const plan of ['launch', 'scale', 'unknown', 'Free']) {
      const { ctx, calls } = tokenCtx(creationRoutes({ plan }), { neon: { organizationId: ORG } });
      await expect(project.creationTarget!(ctx)).rejects.toThrow(/Free/); expect(calls.every((c) => c.method === 'GET')).toBe(true);
    }
  });
  it('fails closed on ambiguous Free organizations', async () => {
    const { ctx } = tokenCtx([['GET', `${NEON_API}/users/me/organizations`, () => ({ json: { organizations: [org, { ...org, id: 'org-second' }] } })]], {});
    await expect(project.creationTarget!(ctx)).rejects.toThrow(/exactly one/);
  });
  it('makes destination region and organization visible before approval', async () => {
    const { ctx, calls } = tokenCtx(creationRoutes(), {}); expect(await project.creationTarget!(ctx)).toEqual(approved); expect(calls.every((c) => c.method === 'GET')).toBe(true);
  });
  it('rejects stale destination before sending a create request', async () => {
    const { ctx, calls } = tokenCtx(creationRoutes(), {});
    await expect(project.create!(ctx, 'demo', { ...approved, region: 'aws-eu-central-1' })).rejects.toThrow(/changed/); expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });
  it('rejects unapproved create and custom initial branch/database/role', async () => {
    const { ctx } = tokenCtx([], {}); await expect(project.create!(ctx, 'demo')).rejects.toThrow(/approved/);
    for (const neon of [{ branchId: BRANCH }, { database: 'custom' }, { role: 'custom' }]) await expect(project.creationTarget!(testCtx({ config: { neon } }))).rejects.toThrow(/fixed/);
  });
  it('refuses same-name adoption after create approval', async () => {
    const { ctx, calls } = tokenCtx(creationRoutes({ existing: [{ ...record, name: 'DEMO' }] }), {});
    await expect(project.create!(ctx, 'demo', approved)).rejects.toThrow(/already exists/); expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });
  it('paginates scoped inventories and rejects incomplete inventory', async () => {
    const { ctx, calls } = tokenCtx([
      ['GET', `${NEON_API}/organizations/${ORG}`, () => ({ json: org })],
      ['GET', `${NEON_API}/projects`, (c) => ({ json: new URL(c.url).searchParams.has('cursor') ? { projects: [] } : { projects: [record], pagination: { cursor: 'page2' } } })],
    ], { neon: { organizationId: ORG } });
    expect(await project.candidates(ctx)).toHaveLength(1); expect(calls.filter((c) => c.url.includes('/projects?'))).toHaveLength(2);
    const bad = tokenCtx([['GET', `${NEON_API}/organizations/${ORG}`, () => ({ json: org })], ['GET', `${NEON_API}/projects`, () => ({ json: { projects: [], unavailable_project_ids: ['missing'] } })]], { neon: { organizationId: ORG } });
    await expect(project.candidates(bad.ctx)).rejects.toThrow(/incomplete/);
  });
  it('refuses same-name candidates without explicit existing connection selectors', async () => {
    const { ctx } = tokenCtx(creationRoutes({ existing: [record] }), {}); ctx.cwd = '/apps/demo';
    await expect(project.candidates(ctx)).rejects.toThrow(/same-named/);
    ctx.config.neon = selected.neon;
    expect(await project.candidates(ctx)).toHaveLength(1);
    expect(await output.identity!(ctx)).toBe(JSON.stringify({ branch: BRANCH, database: 'neondb', role: 'neondb_owner' }));
  });
  it('refuses skipped, failed and unknown provisioning operations', async () => {
    for (const status of ['skipped', 'failed', 'error', 'unexpected']) {
      const { ctx } = tokenCtx(creationRoutes({ operation: { id: 'op-test', project_id: PID, status } }), {});
      await expect(project.create!(ctx, 'demo', approved)).rejects.toThrow(/operation failed/);
    }
  });
  it('creates with fixed Free compute settings and persists IDs only after owner readback', async () => {
    const { ctx, calls, http } = tokenCtx(creationRoutes(), {}); const raw: HttpRequest[] = []; ctx.http = (r) => { raw.push(r); return http(r); };
    expect(await project.create!(ctx, 'demo', approved)).toEqual({ id: PID, name: 'demo', scope: { kind: 'organization', id: ORG } });
    const write = calls.find((c) => c.method === 'POST')!; expect(write.body).toEqual({ project: { name: 'demo', org_id: ORG, region_id: approved.region, branch: { name: 'main', database_name: 'neondb', role_name: 'neondb_owner' }, default_endpoint_settings: { autoscaling_limit_min_cu: 0.25, autoscaling_limit_max_cu: 0.25 }, store_passwords: true } });
    expect(raw.find((r) => r.method === 'POST')!.idempotent).toBe(false); expect(ctx.state.resource('neon.branchId')).toBe(BRANCH); noSecrets(ctx, [ctx.logs]);
  });
  it('does not save state when exact readback has the wrong organization/region/name', async () => {
    for (const p of [{ ...record, org_id: 'org-other', owner_id: 'org-other' }, { ...record, region_id: 'aws-eu-west-1' }, { ...record, name: 'other' }]) {
      const { ctx } = tokenCtx(creationRoutes({ readback: p }), {}); await expect(project.create!(ctx, 'demo', approved)).rejects.toThrow(/destination/); expect(ctx.state.get().resources).toEqual({});
    }
  });
  it('records a pending creation and resumes without a duplicate POST', async () => {
    neonTiming.timeoutMs = 0;
    const { ctx, calls } = tokenCtx(creationRoutes({ operation: { id: 'op-test', project_id: PID, status: 'running' } }), {});
    await expect(project.create!(ctx, 'demo', approved)).rejects.toThrow(/pending/); expect(ctx.state.resource('neon.createdProjectId')).toBe(PID);
    await expect(project.create!(ctx, 'demo', approved)).rejects.toThrow(/pending/); expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);
  });
  it('does not retry an ambiguous POST or expose provider error text', async () => {
    const routes = creationRoutes().filter(([m]) => m !== 'POST'); routes.push(['POST', `${NEON_API}/projects`, () => { throw new Error(URI); }]);
    const { ctx, calls } = tokenCtx(routes, {}); await expect(project.create!(ctx, 'demo', approved)).rejects.toThrow(/may have succeeded/); expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1); noSecrets(ctx);
  });
  it('uses equals-form stdin data accepted by the installed strict CLI parser and hides returned credentials', async () => {
    const ex = mockExec([['neon api', (c) => {
      // Neon 5.0.1/yargs strictCommands treats a separate '-' as an unknown command.
      if (c.args.includes('-')) return { code: 1, stderr: 'ERROR: Unknown command: -' };
      const path = c.args[1]!;
      const data = path === '/users/me/organizations' ? { organizations: [org] } : path.startsWith('/organizations/') ? org : path.includes('/operations/') ? { operation: { id: 'op-test', project_id: PID, status: 'finished' } } : path.startsWith('/projects?') ? { projects: [] } : path === '/projects' ? { project: record, branch, operations: [], roles: [{ password: PASS }], connection_uris: [{ connection_uri: URI }] } : { project: record };
      return { stdout: JSON.stringify(data) };
    }]]);
    const ctx = testCtx({ exec: ex.run }); await project.create!(ctx, 'demo', approved);
    const write = ex.calls.find((c) => c.args.includes('POST'))!; expect(write.args).toContain('--data=-'); expect(write.args).not.toContain('-'); expect(JSON.parse(write.stdin!).project.org_id).toBe(ORG); noSecrets(ctx, [ctx.logs, ex.calls.map((c) => c.args)]);
  });
});

describe('Neon outputs and source selectors', () => {
  it('provides keys without fetching credentials and publishes stable visible selectors', async () => {
    const ctx = testCtx({ config: selected }); expect(await output.provides!(ctx, 'production')).toEqual(['db.url', 'db.directUrl']); expect(await output.identity!(ctx)).toBe(JSON.stringify({ branch: BRANCH, database: 'neondb', role: 'neondb_owner' }));
    expect(await output.identity!(testCtx())).toContain('"branch":"new main"');
  });
  it('uses unambiguous source identity for unusual database and role names', async () => {
    const a = testCtx({ config: { ...selected, neon: { ...selected.neon, database: 'app;role=alice', role: 'bob' } } });
    const b = testCtx({ config: { ...selected, neon: { ...selected.neon, database: 'app', role: 'alice;role=bob' } } });
    expect(await output.identity!(a)).not.toBe(await output.identity!(b));
  });
  it('requires explicit selectors for an existing project, with no default-branch inference', async () => {
    const { ctx, calls } = tokenCtx(baseRoutes(), { projects: { db: PID } }); await expect(output.outputs(ctx, 'production')).rejects.toThrow(/explicitly/); expect(calls.some((c) => c.url.includes('connection_uri'))).toBe(false);
  });
  it('uses pinned branch defaults for golive-created projects', async () => {
    const { ctx } = tokenCtx(baseRoutes(), {}); ctx.state.save((s) => Object.assign(s.resources, { 'neon.projectId': PID, 'neon.createdProjectId': PID, 'neon.branchId': BRANCH, 'neon.database': 'neondb', 'neon.role': 'neondb_owner' }));
    expect((await output.outputs(ctx, 'production', ['db.url']))['db.url']).toBeInstanceOf(Secret);
  });
  it('passes exact selectors, returns pooled/direct Secrets, and never writes', async () => {
    const { ctx, calls } = tokenCtx(baseRoutes()); const out = await output.outputs(ctx, 'production');
    expect((out['db.url'] as Secret).reveal()).toBe(POOL); expect((out['db.directUrl'] as Secret).reveal()).toBe(URI); noSecrets(ctx, [out]);
    const q = new URL(calls.find((c) => c.url.includes('connection_uri'))!.url).searchParams; expect(q.get('branch_id')).toBe(BRANCH); expect(q.get('endpoint_id')).toBe(endpoint.id); expect(q.get('role_name')).toBe('neondb_owner'); expect(calls.every((c) => c.method === 'GET')).toBe(true);
  });
  it('fetches only requested connection values, unrelated requests do nothing', async () => {
    const { ctx, calls } = tokenCtx(baseRoutes()); expect(await output.outputs(ctx, 'production', ['app.url'])).toEqual({}); expect(calls).toHaveLength(0);
    expect(Object.keys(await output.outputs(ctx, 'production', ['db.directUrl']))).toEqual(['db.directUrl']); expect(calls.filter((c) => c.url.includes('connection_uri'))).toHaveLength(1);
  });
  it('refuses wrong project/branch endpoint, disabled compute, or foreign endpoint host', async () => {
    for (const endpoints of [[{ ...endpoint, branch_id: 'br-other' }], [{ ...endpoint, disabled: true }], [{ ...endpoint, host: 'attacker.example.com' }], [endpoint, { ...endpoint, id: 'ep-second' }]]) {
      const { ctx, calls } = tokenCtx(baseRoutes({ endpoints })); await expect(output.outputs(ctx, 'production')).rejects.toThrow(); expect(calls.some((c) => c.url.includes('connection_uri'))).toBe(false);
    }
  });
  it('refuses missing database/role and archived or wrong-project branches', async () => {
    for (const over of [{ databases: [] }, { roles: [] }, { branch: { ...branch, current_state: 'archived' } }, { branch: { ...branch, project_id: 'other' } }]) {
      const { ctx } = tokenCtx(baseRoutes(over)); await expect(output.outputs(ctx, 'production')).rejects.toThrow();
    }
  });
  it('rejects libpq identity overrides, arbitrary options, duplicate TLS parameters and fragments', async () => {
    for (const suffix of ['&host=attacker.example.com', '&hostaddr=127.0.0.1', '&user=other', '&password=other', '&dbname=other', '&options=-crole=other', '&service=other', '&sslmode=disable', '#fragment']) {
      const { ctx } = tokenCtx(baseRoutes({ uri: URI + suffix }));
      await expect(output.outputs(ctx, 'production', ['db.directUrl'])).rejects.toThrow(/query parameters|fragment/);
    }
  });
  it('validates URI host, role, database, protocol and TLS without exposing the URI', async () => {
    for (const uri of [URI.replace(HOST, 'attacker.example.com'), URI.replace('neondb_owner:', 'other:'), URI.replace('/neondb?', '/other?'), URI.replace('postgresql:', 'https:'), URI.replace('sslmode=require', 'sslmode=disable')]) {
      const { ctx } = tokenCtx(baseRoutes({ uri })); await expect(output.outputs(ctx, 'production', ['db.directUrl'])).rejects.toThrow(/did not match/); noSecrets(ctx);
    }
  });
});

describe('Neon SQL connectivity proof', () => {
  const success = { results: [{ command: 'SELECT', rowCount: 1, rows: [['neondb', 'neondb_owner', '1']] }] };
  it('uses a fixed read-only SQL transaction on the exact endpoint and returns no credentials', async () => {
    const { ctx, calls, http } = tokenCtx([...baseRoutes(), ['POST', `https://${HOST}/sql`, () => ({ json: success })]]); const raw: HttpRequest[] = []; ctx.http = (r) => { raw.push(r); return http(r); };
    expect(await verifyNeonConnection(ctx)).toEqual({ projectId: PID, branchId: BRANCH, database: 'neondb', role: 'neondb_owner' });
    const query = calls.find((c) => c.method === 'POST')!; expect(query.headers['neon-connection-string']).toBe(URI); expect(query.headers['neon-batch-read-only']).toBe('true'); expect(query.body).toEqual({ queries: [{ query: 'SELECT current_database(), current_user, 1', params: [] }] }); expect(raw.at(-1)!.headers!['Neon-Connection-String']).toBeInstanceOf(Secret); noSecrets(ctx);
  });
  it('refuses a probe that could wake paid compute', async () => {
    const { ctx, calls } = tokenCtx(baseRoutes({ plan: 'launch' })); await expect(verifyNeonConnection(ctx)).rejects.toThrow(/Free/); expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });
  it('does not turn malformed success or wrong database identity into a pass', async () => {
    for (const json of [{}, { results: [] }, { results: [{ command: 'SELECT', rowCount: 1, rows: [['other', 'neondb_owner', '1']] }] }, { results: [{ command: 'SELECT', rowCount: 0, rows: [] }] }]) {
      const { ctx } = tokenCtx([...baseRoutes(), ['POST', `https://${HOST}/sql`, () => ({ json })]]); await expect(verifyNeonConnection(ctx)).rejects.toThrow();
    }
  });
  it('does not expose SQL provider errors including credentials', async () => {
    const { ctx } = tokenCtx([...baseRoutes(), ['POST', `https://${HOST}/sql`, () => ({ status: 403, json: { message: URI, detail: PASS } })]]);
    await expect(verifyNeonConnection(ctx)).rejects.toThrow('HTTP 403'); noSecrets(ctx, [ctx.logs]);
  });
});
