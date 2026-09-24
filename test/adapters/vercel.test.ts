import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Secret, _resetSecretRegistry } from '../../src/core/secret.js';
import { emptyState } from '../../src/core/state.js';
import type { Http, HttpRequest, ShipState } from '../../src/core/types.js';
import { mockExec, mockHttp, testCtx, detectFixture, type ExecCall } from '../helpers.js';
import { vercelAdapter, vercelProductionUrl, VercelError, pickProductionAlias } from '../../src/adapters/vercel.js';
import { credentialsPath } from '../../src/core/credentials.js';

/** No token instruction may tell the human to export in their own terminal (it never reaches the agent). */
function expectSafeTokenHowTo(text: string | undefined): void {
  expect(text).toContain('vercel login');
  expect(text).toContain('separate terminal window');
  expect(text).toContain(credentialsPath());
  expect(text).toContain('VERCEL_TOKEN=<value>');
  expect(text).toMatch(/never paste/i);
  expect(text).not.toMatch(/export VERCEL_TOKEN=/);
  expect(text).not.toMatch(/export[^.]*in (your|the) (own )?(terminal|shell that runs golive)/i);
  expect(text).not.toMatch(/read -s/);
}

const caps = vercelAdapter.capabilities;
const project = caps.project!;
const env = caps.env!;
const url = caps.url!;
const deployer = caps.deploy!;
const domain = caps.domain!;

const BYPASS = 'bypassKeyAbCdEfGh0123456789zyxwvu';
const SECRET_VAL = 'sk_' + 'live_51SECRETVALUEabcdefghijklmnopqrstu';
const TOKEN = 'vcp_tokenABCDEFGHIJKLMNOP1234567890';
const API = 'https://api.vercel.com';

const WHOAMI_OK: [string, { stdout: string }] = ['vercel whoami', { stdout: JSON.stringify({ username: 'alice', email: 'a@x.dev', team: { id: 'team_1', slug: 'acme', name: 'Acme' } }) }];
const WHOAMI_OUT: [string, { code: number; stdout: string }] = ['vercel whoami', { code: 1, stdout: '{"loggedIn":false}' }];

function linkedState(over: Partial<ShipState['resources']> = {}): ShipState {
  const s = emptyState();
  s.resources = { 'vercel.projectId': 'prj_1', 'vercel.projectName': 'my-app', 'vercel.orgId': 'team_1', ...over };
  return s;
}

const RAW_PROJECT = {
  id: 'prj_1',
  name: 'my-app',
  accountId: 'team_1',
  framework: 'nextjs',
  targets: { production: { alias: ['my-app.vercel.app', 'my-app-acme.vercel.app'] } },
  protectionBypass: { [BYPASS]: { createdAt: 1, createdBy: 'u', scope: 'automation-bypass' } },
  ssoProtection: { deploymentType: 'prod_deployment_urls_and_all_previews' },
};

type CliRoute = (c: ExecCall) => { code?: number; stdout?: string; stderr?: string };
/** Routes `vercel api <path> -X <METHOD>` calls by "METHOD path" (path without query). */
function cliApi(routes: Record<string, unknown | CliRoute>): [RegExp, (c: ExecCall) => { code?: number; stdout?: string; stderr?: string }] {
  return [
    /^vercel api /,
    (c) => {
      const key = `${c.args[3]} ${c.args[1]!.split('?')[0]}`;
      const r = routes[key];
      if (r === undefined) return { code: 1, stderr: `Error: Not Found (404) for ${key}` };
      return typeof r === 'function' ? (r as CliRoute)(c) : { stdout: JSON.stringify(r) };
    },
  ];
}

/** Wraps a mock Http to capture the raw requests (incl. the `idempotent` flag the helper drops). */
function spyHttp(inner: Http): { http: Http; reqs: HttpRequest[] } {
  const reqs: HttpRequest[] = [];
  const http = (<T>(req: HttpRequest) => {
    reqs.push(req);
    return inner<T>(req);
  }) as Http;
  return { http, reqs };
}

function allArgs(calls: ExecCall[]): string {
  return calls.map((c) => [c.cmd, ...c.args].join(' ')).join('\n');
}

beforeEach(() => {
  _resetSecretRegistry();
  delete process.env.VERCEL_ORG_ID;
});

// ── auth ──────────────────────────────────────────────────────────────────────────────────────

describe('vercel auth', () => {
  it('uses the logged-in CLI', async () => {
    const ex = mockExec([WHOAMI_OK]);
    const ctx = testCtx({ exec: ex.run });
    const a = await vercelAdapter.auth(ctx);
    expect(a).toEqual({ ok: true, via: 'vercel CLI (logged in as alice, team acme)' });
    expect(ex.calls[0]!.args).toEqual(['whoami', '--format', 'json', '--non-interactive']);
  });

  it('not logged in and no token: ok:false with a human-terminal fix, never throws', async () => {
    const ctx = testCtx({ exec: mockExec([WHOAMI_OUT]).run });
    const a = await vercelAdapter.auth(ctx);
    expect(a.ok).toBe(false);
    expectSafeTokenHowTo(a.howToFix);
    expect(a.howToFix).toContain('https://vercel.com/account/tokens');
  });

  it('CLI missing: says so', async () => {
    const ctx = testCtx({ exec: mockExec([]).run });
    const a = await vercelAdapter.auth(ctx);
    expect(a.ok).toBe(false);
    expect(a.howToFix).toContain('not installed');
    expectSafeTokenHowTo(a.howToFix);
  });

  it('falls back to VERCEL_TOKEN and checks it against /v2/user', async () => {
    const h = mockHttp([['GET', `${API}/v2/user`, () => ({ json: { user: { username: 'alice' } } })]]);
    const ctx = testCtx({ exec: mockExec([WHOAMI_OUT]).run, http: h.http, tokens: { VERCEL_TOKEN: TOKEN } });
    const a = await vercelAdapter.auth(ctx);
    expect(a).toEqual({ ok: true, via: 'VERCEL_TOKEN (user alice)' });
    expect(h.calls[0]!.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.stringify(a)).not.toContain(TOKEN);
  });

  it('regression (round 2 #2): token set but the CLI is missing → not ready (deploys need the CLI), install hint, token never echoed', async () => {
    const h = mockHttp([['GET', `${API}/v2/user`, () => ({ json: { user: { username: 'alice' } } })]]);
    const ctx = testCtx({ exec: mockExec([]).run, http: h.http, tokens: { VERCEL_TOKEN: TOKEN } });
    const a = await vercelAdapter.auth(ctx);
    expect(a.ok).toBe(false);
    expect(a.via).toBe('VERCEL_TOKEN (user alice)');
    expect(a.howToFix).toContain('install it: npm i -g vercel');
    expect(a.howToFix).toMatch(/deploys need the Vercel CLI/);
    expect(JSON.stringify(a)).not.toContain(TOKEN);
  });

  it('CLI missing and no token: install first, and the token route is not offered as a no-CLI alternative', async () => {
    const a = await vercelAdapter.auth(testCtx({ exec: mockExec([]).run }));
    expect(a.howToFix).toContain('install it: npm i -g vercel');
    expect(a.howToFix).toMatch(/the Vercel CLI must still be installed/);
  });

  it('rejected token: ok:false, token never echoed', async () => {
    const h = mockHttp([['GET', `${API}/v2/user`, () => ({ status: 403, json: { error: { code: 'forbidden', message: `bad token ${TOKEN}` } } })]]);
    const ctx = testCtx({ exec: mockExec([WHOAMI_OUT]).run, http: h.http, tokens: { VERCEL_TOKEN: TOKEN } });
    const a = await vercelAdapter.auth(ctx);
    expect(a.ok).toBe(false);
    expect(a.howToFix).toContain('HTTP 403');
    expectSafeTokenHowTo(a.howToFix);
    expect(JSON.stringify(a)).not.toContain(TOKEN);
  });

  it('api calls without any auth throw an actionable, safe error', async () => {
    const ctx = testCtx({ exec: mockExec([WHOAMI_OUT]).run, state: linkedState() });
    const err = (await env.listNames(ctx, 'production').catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(VercelError);
    expectSafeTokenHowTo(err.message);
  });

  it('a 401 from the API points at the safe login/token paths', async () => {
    const h = mockHttp([['GET', `${API}/v10/projects/prj_1/env`, () => ({ status: 401, json: { error: { code: 'unauthorized', message: 'expired' } } })]]);
    const ctx = testCtx({ exec: mockExec([WHOAMI_OUT]).run, http: h.http, tokens: { VERCEL_TOKEN: TOKEN }, state: linkedState() });
    const err = (await env.listNames(ctx, 'production').catch((e: unknown) => e)) as Error;
    expect(err.message).toContain('HTTP 401');
    expectSafeTokenHowTo(err.message);
    expect(err.message).not.toContain(TOKEN);
  });
});

// ── project ───────────────────────────────────────────────────────────────────────────────────

describe('vercel project', () => {
  it('select() via CLI remembers ids and never leaks protectionBypass keys', async () => {
    const ex = mockExec([WHOAMI_OK, cliApi({ 'GET /v9/projects/my-app': RAW_PROJECT })]);
    const ctx = testCtx({ exec: ex.run });
    const ref = await project.select(ctx, 'my-app');
    expect(ref).toEqual({ id: 'prj_1', name: 'my-app', scope: { kind: 'team', id: 'team_1' } });
    expect(ctx.state.get().resources).toMatchObject({ 'vercel.projectId': 'prj_1', 'vercel.orgId': 'team_1', 'vercel.projectName': 'my-app' });
    for (const out of [JSON.stringify(ref), JSON.stringify(ctx.state.get()), ctx.logs.join('\n')]) expect(out).not.toContain(BYPASS);
    const api = ex.calls.find((c) => c.args[0] === 'api')!;
    expect(api.args).toEqual(['api', '/v9/projects/my-app', '-X', 'GET', '--raw', '--non-interactive']);
  });

  it('select() of an unknown project gives an actionable not-found error', async () => {
    const ctx = testCtx({ exec: mockExec([WHOAMI_OK, cliApi({})]).run });
    await expect(project.select(ctx, 'nope')).rejects.toThrow(/not found in the current team scope/);
  });

  it('current(): state first, then .vercel/project.json', async () => {
    expect(await project.current(testCtx({ state: linkedState() }))).toEqual({ id: 'prj_1', name: 'my-app' });

    const dir = mkdtempSync(join(tmpdir(), 'golive-vercel-'));
    try {
      mkdirSync(join(dir, '.vercel'));
      writeFileSync(join(dir, '.vercel', 'project.json'), JSON.stringify({ projectId: 'prj_9', orgId: 'team_9', projectName: 'linked' }));
      expect(await project.current(testCtx({ cwd: dir }))).toEqual({ id: 'prj_9', name: 'linked' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }

    expect(await project.current(testCtx())).toBeNull();
  });

  it('current() from config.projects.hosting resolves the name without leaking the project JSON', async () => {
    const ex = mockExec([WHOAMI_OK, cliApi({ 'GET /v9/projects/my-app': RAW_PROJECT })]);
    const ctx = testCtx({ exec: ex.run, config: { projects: { hosting: 'my-app' } } });
    const ref = await project.current(ctx);
    expect(ref).toEqual({ id: 'prj_1', name: 'my-app' });
    expect(JSON.stringify(ref)).not.toContain(BYPASS);
  });

  it('candidates() via token searches by repo dir name and returns id/name only', async () => {
    const h = mockHttp([
      ['GET', `${API}/v10/projects`, () => ({ json: { projects: [RAW_PROJECT, { id: 'prj_2', name: 'repo-2', protectionBypass: { [BYPASS]: {} } }] } })],
    ]);
    const ctx = testCtx({ exec: mockExec([WHOAMI_OUT]).run, http: h.http, tokens: { VERCEL_TOKEN: TOKEN }, cwd: '/work/repo' });
    const list = await project.candidates(ctx);
    expect(list).toEqual([
      { id: 'prj_1', name: 'my-app' },
      { id: 'prj_2', name: 'repo-2' },
    ]);
    expect(h.calls[0]!.url).toBe(`${API}/v10/projects?search=repo&limit=20`);
    expect(JSON.stringify(list)).not.toContain(BYPASS);
  });

  it('create() adopts an existing project with the same name', async () => {
    const ex = mockExec([WHOAMI_OK, cliApi({ 'GET /v9/projects/my-app': RAW_PROJECT })]);
    const ctx = testCtx({ exec: ex.run });
    expect(await project.create!(ctx, 'my-app')).toEqual({ id: 'prj_1', name: 'my-app' });
    expect(ex.calls.some((c) => c.args[3] === 'POST')).toBe(false);
  });

  it('create() posts name + framework on stdin when nothing exists', async () => {
    const ex = mockExec([WHOAMI_OK, cliApi({ 'POST /v11/projects': { ...RAW_PROJECT, id: 'prj_new', name: 'fresh' } })]);
    const ctx = testCtx({ exec: ex.run, detect: { framework: 'next' } });
    expect(await project.create!(ctx, 'fresh')).toEqual({ id: 'prj_new', name: 'fresh' });
    const post = ex.calls.find((c) => c.args[3] === 'POST')!;
    expect(post.args).toContain('--input');
    expect(JSON.parse(post.stdin!)).toEqual({ name: 'fresh', framework: 'nextjs' });
    expect(ctx.state.resource('vercel.projectId')).toBe('prj_new');
  });

  it('create() rejects invalid names before calling the API', async () => {
    const ex = mockExec([WHOAMI_OK]);
    await expect(project.create!(testCtx({ exec: ex.run }), 'My App')).rejects.toThrow(/not a valid Vercel project name/);
  });

  it('marks only a project golive created; adopting an existing one leaves no marker', async () => {
    const created = mockExec([WHOAMI_OK, cliApi({ 'POST /v11/projects': { ...RAW_PROJECT, id: 'prj_new', name: 'fresh' } })]);
    const madeCtx = testCtx({ exec: created.run, detect: { framework: 'next' } });
    await project.create!(madeCtx, 'fresh');
    expect(madeCtx.state.resource('vercel.createdProjectId')).toBe('prj_new');

    const adopted = mockExec([WHOAMI_OK, cliApi({ 'GET /v9/projects/my-app': RAW_PROJECT })]);
    const adoptedCtx = testCtx({ exec: adopted.run });
    expect(await project.create!(adoptedCtx, 'my-app')).toEqual({ id: 'prj_1', name: 'my-app' });
    expect(adoptedCtx.state.resource('vercel.createdProjectId')).toBeUndefined();
    expect(await project.remove!(adoptedCtx)).toEqual({ removed: false, reason: 'the project was adopted or selected, not created by golive' });
  });

  it('remove() deletes a golive-created project and clears its state', async () => {
    const ex = mockExec([WHOAMI_OK, cliApi({ 'DELETE /v9/projects/prj_1': {} })]);
    const ctx = testCtx({ exec: ex.run, state: linkedState({ 'vercel.createdProjectId': 'prj_1' }) });
    expect(await project.remove!(ctx)).toEqual({ removed: true });
    const call = ex.calls.find((c) => c.args[0] === 'api')!;
    expect(call.args).toEqual(['api', '/v9/projects/prj_1', '-X', 'DELETE', '--raw', '--non-interactive', '--dangerously-skip-permissions', '--scope', 'team_1']);
    expect(ctx.state.resource('vercel.projectId')).toBeUndefined();
    expect(ctx.state.resource('vercel.projectName')).toBeUndefined();
    expect(ctx.state.resource('vercel.createdProjectId')).toBeUndefined();
  });

  it('remove() deletes over the token transport with the exact URL', async () => {
    const h = mockHttp([
      ['GET', `${API}/v2/user`, () => ({ json: { user: { username: 'alice' } } })],
      ['DELETE', `${API}/v9/projects/prj_1`, () => ({ status: 204 })],
    ]);
    const ctx = testCtx({ exec: mockExec([WHOAMI_OUT]).run, http: h.http, tokens: { VERCEL_TOKEN: TOKEN }, state: linkedState({ 'vercel.createdProjectId': 'prj_1' }) });
    expect(await project.remove!(ctx)).toEqual({ removed: true });
    const call = h.calls.find((c) => c.method === 'DELETE')!;
    expect(call.url).toBe(`${API}/v9/projects/prj_1?teamId=team_1`);
    expect(call.headers.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('remove() refuses to delete without a project or a matching marker', async () => {
    const empty = testCtx({ exec: mockExec([WHOAMI_OK]).run });
    expect(await project.remove!(empty)).toEqual({ removed: false, reason: 'no Vercel project is linked in state' });

    const adopted = testCtx({ exec: mockExec([WHOAMI_OK]).run, state: linkedState() });
    expect(await project.remove!(adopted)).toEqual({ removed: false, reason: 'the project was adopted or selected, not created by golive' });

    const mismatched = testCtx({ exec: mockExec([WHOAMI_OK]).run, state: linkedState({ 'vercel.createdProjectId': 'prj_other' }) });
    expect(await project.remove!(mismatched)).toEqual({ removed: false, reason: 'the project was adopted or selected, not created by golive' });
    expect(mismatched.state.resource('vercel.projectId')).toBe('prj_1');
  });

  it('remove() treats a project that is already gone as removed', async () => {
    const ctx = testCtx({ exec: mockExec([WHOAMI_OK, cliApi({})]).run, state: linkedState({ 'vercel.createdProjectId': 'prj_1' }) });
    expect(await project.remove!(ctx)).toEqual({ removed: true });
    expect(ctx.state.resource('vercel.projectId')).toBeUndefined();
  });

  it('exists() reads the project and reports only the provider not-found as gone', async () => {
    const live = mockExec([WHOAMI_OK, cliApi({ 'GET /v9/projects/prj_1': RAW_PROJECT })]);
    expect(await project.exists!(testCtx({ exec: live.run }), 'prj_1')).toBe(true);

    const gone = mockExec([WHOAMI_OK, cliApi({})]);
    const goneCtx = testCtx({ exec: gone.run });
    expect(await project.exists!(goneCtx, 'prj_1')).toBe(false);
    expect(JSON.stringify(goneCtx.logs)).not.toContain(BYPASS);
  });

  it('exists() throws when the project read fails for any other reason', async () => {
    const limited = mockExec([WHOAMI_OK, cliApi({ 'GET /v9/projects/prj_1': () => ({ code: 1, stderr: 'Error: Rate limited (429)' }) })]);
    await expect(project.exists!(testCtx({ exec: limited.run }), 'prj_1')).rejects.toThrow(/HTTP 429/);
  });
});

// ── env ───────────────────────────────────────────────────────────────────────────────────────

const ENV_ROWS = {
  envs: [
    { id: 'env_a', key: 'DATABASE_URL', value: 'enc:zzz', type: 'sensitive', target: ['production'], configurationId: null },
    { id: 'env_b', key: 'PUBLIC_THING', value: 'plain-visible-value', type: 'plain', target: ['production', 'preview', 'development'], configurationId: null },
    { id: 'env_c', key: 'BRANCH_ONLY', value: 'x', type: 'encrypted', target: ['preview'], gitBranch: 'feature', configurationId: null },
    { id: 'env_d', key: 'POSTGRES_URL', value: 'x', type: 'encrypted', target: ['production', 'preview'], configurationId: 'icfg_1' },
  ],
};

describe('vercel env', () => {
  it('listNames() returns names only; branch-scoped rows do not count for preview', async () => {
    const h = mockHttp([['GET', `${API}/v10/projects/prj_1/env`, () => ({ json: ENV_ROWS })]]);
    const ctx = testCtx({ exec: mockExec([WHOAMI_OUT]).run, http: h.http, tokens: { VERCEL_TOKEN: TOKEN }, state: linkedState() });
    expect(await env.listNames(ctx, 'preview')).toEqual(['POSTGRES_URL', 'PUBLIC_THING']);
    expect(await env.listNames(ctx, 'production')).toEqual(['DATABASE_URL', 'POSTGRES_URL', 'PUBLIC_THING']);
    expect(h.calls[0]!.url).toBe(`${API}/v10/projects/prj_1/env?teamId=team_1`);
    expect(h.calls[0]!.url).not.toContain('decrypt');
  });

  it('set() via CLI: value travels on stdin only, one POST per target, type sensitive', async () => {
    const ex = mockExec([
      WHOAMI_OK,
      cliApi({
        'GET /v10/projects/prj_1/env': { envs: [] },
        // The create response echoes the value; it must never surface.
        'POST /v10/projects/prj_1/env': (c: ExecCall) => ({ stdout: JSON.stringify({ created: JSON.parse(c.stdin!), failed: [] }) }),
      }),
    ]);
    const ctx = testCtx({ exec: ex.run, state: linkedState() });
    const out = await env.set(ctx, 'STRIPE_SECRET_KEY', new Secret('STRIPE_SECRET_KEY', SECRET_VAL), ['production', 'preview']);
    expect(out).toBeUndefined();

    const posts = ex.calls.filter((c) => c.args[3] === 'POST');
    expect(posts).toHaveLength(2);
    expect(posts.map((p) => JSON.parse(p.stdin!))).toEqual([
      { key: 'STRIPE_SECRET_KEY', value: SECRET_VAL, type: 'sensitive', target: ['production'] },
      { key: 'STRIPE_SECRET_KEY', value: SECRET_VAL, type: 'sensitive', target: ['preview'] },
    ]);
    expect(posts[0]!.args).toEqual(['api', '/v10/projects/prj_1/env?upsert=true', '-X', 'POST', '--raw', '--non-interactive', '--input', '-', '--scope', 'team_1']);
    expect(allArgs(ex.calls)).not.toContain(SECRET_VAL);
    expect(ctx.logs.join('\n')).not.toContain(SECRET_VAL);
    expect(ctx.logs.join('\n')).toContain('created STRIPE_SECRET_KEY for production');
  });

  it('set() via token: PATCHes the exact existing row and POSTs the missing target, value in body only', async () => {
    const h = mockHttp([
      ['GET', `${API}/v10/projects/prj_1/env`, () => ({ json: ENV_ROWS })],
      ['PATCH', `${API}/v9/projects/prj_1/env/env_a`, (c) => ({ json: { id: 'env_a', ...(c.body as object) } })],
      ['POST', `${API}/v10/projects/prj_1/env`, (c) => ({ json: { created: c.body, failed: [] } })],
    ]);
    const ctx = testCtx({ exec: mockExec([WHOAMI_OUT]).run, http: h.http, tokens: { VERCEL_TOKEN: TOKEN }, state: linkedState() });
    await env.set(ctx, 'DATABASE_URL', new Secret('DATABASE_URL', SECRET_VAL), ['production', 'preview']);

    const patch = h.calls.find((c) => c.method === 'PATCH')!;
    expect(patch.body).toEqual({ value: SECRET_VAL });
    expect(patch.url).toBe(`${API}/v9/projects/prj_1/env/env_a?teamId=team_1`);
    const post = h.calls.find((c) => c.method === 'POST')!;
    expect(post.body).toEqual({ key: 'DATABASE_URL', value: SECRET_VAL, type: 'sensitive', target: ['preview'] });
    expect(post.url).toBe(`${API}/v10/projects/prj_1/env?upsert=true&teamId=team_1`);
    expect(post.headers.authorization).toBe(`Bearer ${TOKEN}`);
    for (const c of h.calls) expect(c.url).not.toContain(SECRET_VAL);
    expect(ctx.logs.join('\n')).not.toContain(SECRET_VAL);
  });

  it('set(): non-secret string → encrypted; development never sensitive', async () => {
    const ex = mockExec([WHOAMI_OK, cliApi({ 'GET /v10/projects/prj_1/env': { envs: [] }, 'POST /v10/projects/prj_1/env': { created: {}, failed: [] } })]);
    const ctx = testCtx({ exec: ex.run, state: linkedState() });
    await env.set(ctx, 'APP_URL', 'https://example.com', ['production']);
    await env.set(ctx, 'API_KEY', new Secret('API_KEY', SECRET_VAL), ['development']);
    const bodies = ex.calls.filter((c) => c.args[3] === 'POST').map((c) => JSON.parse(c.stdin!) as { type: string });
    expect(bodies.map((b) => b.type)).toEqual(['encrypted', 'encrypted']);
  });

  it('set(): opts.sensitive registers a plain string as a secret', async () => {
    const plain = 'plain-but-sensitive-value-123456';
    const ex = mockExec([WHOAMI_OK, cliApi({ 'GET /v10/projects/prj_1/env': { envs: [] }, 'POST /v10/projects/prj_1/env': { created: {}, failed: [] } })]);
    const ctx = testCtx({ exec: ex.run, state: linkedState() });
    await env.set(ctx, 'X_KEY', plain, ['production'], { sensitive: true });
    const post = ex.calls.find((c) => c.args[3] === 'POST')!;
    expect(JSON.parse(post.stdin!)).toMatchObject({ value: plain, type: 'sensitive' });
    expect(post.opts?.stdin).toBeInstanceOf(Secret);
  });

  it('set(): refuses to overwrite integration-owned vars or rows shared with other targets', async () => {
    const ex = mockExec([WHOAMI_OK, cliApi({ 'GET /v10/projects/prj_1/env': ENV_ROWS })]);
    const ctx = testCtx({ exec: ex.run, state: linkedState() });
    await expect(env.set(ctx, 'POSTGRES_URL', new Secret('POSTGRES_URL', SECRET_VAL), ['production', 'preview'])).rejects.toThrow(/Marketplace integration/);
    await expect(env.set(ctx, 'PUBLIC_THING', 'v', ['production'])).rejects.toThrow(/shared by production \+ preview \+ development/);
    expect(ex.calls.some((c) => c.args[3] === 'POST' || c.args[3] === 'PATCH')).toBe(false);
  });

  it('set(): API errors are mapped, actionable and secret-free even if Vercel echoes the value', async () => {
    const h = mockHttp([
      ['GET', `${API}/v10/projects/prj_1/env`, () => ({ json: { envs: [] } })],
      ['POST', `${API}/v10/projects/prj_1/env`, () => ({ status: 403, json: { error: { code: 'forbidden', message: `cannot store ${SECRET_VAL}` } } })],
    ]);
    const ctx = testCtx({ exec: mockExec([WHOAMI_OUT]).run, http: h.http, tokens: { VERCEL_TOKEN: TOKEN }, state: linkedState() });
    const err = await env.set(ctx, 'K', new Secret('K', SECRET_VAL), ['production']).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VercelError);
    const msg = (err as Error).message;
    expect(msg).toContain('HTTP 403');
    expect(msg).toContain('team scope');
    expect(msg).not.toContain(SECRET_VAL);
    expect(msg).not.toContain(TOKEN);
  });

  it('set(): CLI failure (exit 1) is mapped with status from stderr', async () => {
    const ex = mockExec([
      WHOAMI_OK,
      cliApi({
        'GET /v10/projects/prj_1/env': { envs: [] },
        'POST /v10/projects/prj_1/env': () => ({ code: 1, stderr: `Error: Request failed (401): {"error":{"code":"unauthorized","message":"token expired"}}` }),
      }),
    ]);
    const ctx = testCtx({ exec: ex.run, state: linkedState() });
    await expect(env.set(ctx, 'K', new Secret('K', SECRET_VAL), ['production'])).rejects.toThrow(/HTTP 401, unauthorized.*vercel login/);
  });

  it('set(): keeps what a CLI failure may echo to one short, redacted line', async () => {
    const value = 'vcp_providerEchoedTokenValue0123456789';
    new Secret('VERCEL_TOKEN', value);
    const stderr = `Error: (500) ${JSON.stringify({ error: { code: 'internal', message: `broke on ${value}\n${'x'.repeat(400)}` } })}`;
    const ex = mockExec([
      WHOAMI_OK,
      cliApi({
        'GET /v10/projects/prj_1/env': { envs: [] },
        'POST /v10/projects/prj_1/env': () => ({ code: 1, stderr }),
      }),
    ]);
    const err = (await env.set(testCtx({ exec: ex.run, state: linkedState() }), 'K', new Secret('K', SECRET_VAL), ['production']).catch((e: unknown) => e)) as VercelError;
    expect(err).toBeInstanceOf(VercelError);
    expect(err.detail).not.toContain(value);
    expect(err.detail).not.toContain('\n');
    expect(err.detail!.length).toBeLessThanOrEqual(300);
    expect(err.message).not.toContain(value);
  });

  it('regression: hiddenProductionEnvCount → listNames(production) throws "cannot verify", never reports names as missing', async () => {
    const hidden = { envs: ENV_ROWS.envs, hiddenProductionEnvCount: 2 };
    const ex = mockExec([WHOAMI_OK, cliApi({ 'GET /v10/projects/prj_1/env': hidden })]);
    const ctx = testCtx({ exec: ex.run, state: linkedState() });
    const err = (await env.listNames(ctx, 'production').catch((e: unknown) => e)) as VercelError;
    expect(err).toBeInstanceOf(VercelError);
    expect(err.code).toBe('hidden_env');
    expect(err.message).toMatch(/cannot verify production env: 2 production env vars are hidden/);
    expect(err.message).not.toMatch(/missing/);
    // Other targets are unaffected.
    expect(await env.listNames(ctx, 'preview')).toEqual(['POSTGRES_URL', 'PUBLIC_THING']);
    // Zero hidden behaves as before.
    const ex0 = mockExec([WHOAMI_OK, cliApi({ 'GET /v10/projects/prj_1/env': { ...ENV_ROWS, hiddenProductionEnvCount: 0 } })]);
    expect(await env.listNames(testCtx({ exec: ex0.run, state: linkedState() }), 'production')).toEqual(['DATABASE_URL', 'POSTGRES_URL', 'PUBLIC_THING']);
  });

  it('regression: set() for production refuses to write blind when production vars are hidden', async () => {
    const ex = mockExec([
      WHOAMI_OK,
      cliApi({ 'GET /v10/projects/prj_1/env': { envs: [], hiddenProductionEnvCount: 1 }, 'POST /v10/projects/prj_1/env': { created: {}, failed: [] } }),
    ]);
    const ctx = testCtx({ exec: ex.run, state: linkedState() });
    await expect(env.set(ctx, 'STRIPE_SECRET_KEY', new Secret('STRIPE_SECRET_KEY', SECRET_VAL), ['production', 'preview'])).rejects.toThrow(/cannot verify production env: 1 production env var is hidden/);
    expect(ex.calls.some((c) => c.args[3] === 'POST' || c.args[3] === 'PATCH')).toBe(false);
    // A preview-only write is still fine.
    await env.set(ctx, 'STRIPE_SECRET_KEY', new Secret('STRIPE_SECRET_KEY', SECRET_VAL), ['preview']);
    expect(ex.calls.filter((c) => c.args[3] === 'POST')).toHaveLength(1);
  });

  it('regression (round 2 #7): canSet() reports hidden production, integration-owned and shared-target rows; set() agrees', async () => {
    const ex = mockExec([WHOAMI_OK, cliApi({ 'GET /v10/projects/prj_1/env': ENV_ROWS })]);
    const ctx = testCtx({ exec: ex.run, state: linkedState() });
    // "All environments" row: a production-only write would also change preview + development.
    expect(await env.canSet!(ctx, 'PUBLIC_THING', ['production'])).toMatch(/shared by production \+ preview \+ development/);
    expect(await env.canSet!(ctx, 'PUBLIC_THING', ['production', 'preview', 'development'])).toBeNull();
    expect(await env.canSet!(ctx, 'POSTGRES_URL', ['production'])).toMatch(/Marketplace integration/);
    expect(await env.canSet!(ctx, 'DATABASE_URL', ['production'])).toBeNull();
    expect(await env.canSet!(ctx, 'NEW_VAR', ['production', 'preview'])).toBeNull();
    // Branch-scoped rows never block a target-wide write.
    expect(await env.canSet!(ctx, 'BRANCH_ONLY', ['preview'])).toBeNull();
    expect(await env.canSet!(ctx, 'bad-name', ['production'])).toMatch(/not a valid environment variable name/);
    // Whatever canSet refuses, set() refuses the same way (one rule set), without writing.
    for (const [name, targets] of [['PUBLIC_THING', ['production']], ['POSTGRES_URL', ['production']]] as const) {
      const why = await env.canSet!(ctx, name, [...targets]);
      await expect(env.set(ctx, name, new Secret(name, SECRET_VAL), [...targets])).rejects.toThrow(why!);
    }
    expect(ex.calls.some((c) => c.args[3] === 'POST' || c.args[3] === 'PATCH')).toBe(false);

    const hidden = mockExec([WHOAMI_OK, cliApi({ 'GET /v10/projects/prj_1/env': { envs: [], hiddenProductionEnvCount: 3 } })]);
    const hctx = testCtx({ exec: hidden.run, state: linkedState() });
    expect(await env.canSet!(hctx, 'STRIPE_WEBHOOK_SECRET', ['production'])).toMatch(/cannot verify production env: 3 production env vars are hidden/);
    expect(await env.canSet!(hctx, 'STRIPE_WEBHOOK_SECRET', ['preview'])).toBeNull();
  });

  it('canSet(): no project linked yet → null (re-checked at run time); never writes', async () => {
    const ex = mockExec([WHOAMI_OK]);
    expect(await env.canSet!(testCtx({ exec: ex.run }), 'K', ['production'])).toBeNull();
    expect(ex.calls.some((c) => c.args[0] === 'api')).toBe(false);
  });

  it('set(): a refusal on a later target is caught before the first write (no half-written var)', async () => {
    // MIXED is free on production but integration-owned on preview: production must not be created first.
    const rows = { envs: [...ENV_ROWS.envs, { id: 'env_e', key: 'MIXED', value: 'x', type: 'encrypted', target: ['preview'], configurationId: 'icfg_2' }] };
    const ex = mockExec([WHOAMI_OK, cliApi({ 'GET /v10/projects/prj_1/env': rows, 'POST /v10/projects/prj_1/env': { created: {}, failed: [] } })]);
    await expect(env.set(testCtx({ exec: ex.run, state: linkedState() }), 'MIXED', new Secret('MIXED', SECRET_VAL), ['production', 'preview'])).rejects.toThrow(/Marketplace integration/);
    expect(ex.calls.some((c) => c.args[3] === 'POST' || c.args[3] === 'PATCH')).toBe(false);
  });

  it('set() without a linked project says what to do', async () => {
    const ctx = testCtx({ exec: mockExec([WHOAMI_OK]).run });
    await expect(env.set(ctx, 'K', 'v', ['production'])).rejects.toThrow(/No Vercel project is linked/);
  });
});

// ── url ───────────────────────────────────────────────────────────────────────────────────────

describe('vercel url', () => {
  it('production = verified custom domain', async () => {
    const ex = mockExec([WHOAMI_OK, cliApi({ 'GET /v9/projects/prj_1': RAW_PROJECT, 'GET /v9/projects/prj_1/domains/example.com': { name: 'example.com', apexName: 'example.com', verified: true } })]);
    const ctx = testCtx({ exec: ex.run, state: linkedState(), config: { domain: 'example.com' } });
    expect(await vercelProductionUrl(ctx)).toBe('https://example.com');
  });

  it('production falls back to an assigned production alias; preview is null', async () => {
    const ex = mockExec([WHOAMI_OK, cliApi({ 'GET /v9/projects/prj_1': RAW_PROJECT })]);
    const ctx = testCtx({ exec: ex.run, state: linkedState(), config: { domain: 'example.com' } }); // domain not attached → 404
    const u = await url.get(ctx, 'production');
    expect(u).toBe('https://my-app.vercel.app');
    expect(u).not.toContain(BYPASS);
    expect(await url.get(ctx, 'preview')).toBeNull();
  });

  it('regression: a never-deployed project has NO production URL (never a made-up <name>.vercel.app)', async () => {
    // First deploy failed: the project exists but Vercel assigned no production alias. Returning a
    // guessed URL made the deploy link think production was live (no redeploy) and could point auth
    // redirects at someone else's <name>.vercel.app.
    for (const targets of [{}, { production: null }, { production: { alias: [] } }]) {
      const ex = mockExec([WHOAMI_OK, cliApi({ 'GET /v9/projects/prj_1': { ...RAW_PROJECT, targets } })]);
      expect(await url.get(testCtx({ exec: ex.run, state: linkedState() }), 'production')).toBeNull();
      expect(await vercelProductionUrl(testCtx({ exec: ex.run, state: linkedState() }))).toBeNull();
    }
  });

  it('regression: <name>.vercel.app owned by another account → the suffixed alias Vercel assigned, not the guess', async () => {
    const aliases = ['my-app-git-main-acme.vercel.app', 'my-app-acme.vercel.app', 'my-app-alice-acme.vercel.app'];
    const ex = mockExec([WHOAMI_OK, cliApi({ 'GET /v9/projects/prj_1': { ...RAW_PROJECT, targets: { production: { alias: aliases } } } })]);
    expect(await url.get(testCtx({ exec: ex.run, state: linkedState() }), 'production')).toBe('https://my-app-acme.vercel.app');
  });

  it('pickProductionAlias: exact <name>.vercel.app, then custom domain, then shortest non-branch alias', () => {
    expect(pickProductionAlias('my-app', [])).toBeNull();
    expect(pickProductionAlias('my-app', ['shop.example.com', 'my-app-acme.vercel.app', 'my-app.vercel.app'])).toBe('my-app.vercel.app');
    expect(pickProductionAlias('my-app', ['my-app-acme.vercel.app', 'https://shop.example.com/'])).toBe('shop.example.com');
    expect(pickProductionAlias('my-app', ['my-app-git-main-acme.vercel.app', 'my-app-xyz123-acme.vercel.app'])).toBe('my-app-xyz123-acme.vercel.app');
    expect(pickProductionAlias('my-app', ['my-app-git-main-acme.vercel.app'])).toBe('my-app-git-main-acme.vercel.app');
    expect(pickProductionAlias('My-App', ['HTTPS://MY-APP.VERCEL.APP'])).toBe('my-app.vercel.app');
  });

  it('previewPatterns use the team slug (or the username for personal accounts)', async () => {
    const ex = mockExec([WHOAMI_OK, cliApi({ 'GET /v2/teams/team_1': { id: 'team_1', slug: 'acme' } })]);
    expect(await url.previewPatterns!(testCtx({ exec: ex.run, state: linkedState() }))).toEqual([
      'https://my-app-*-acme.vercel.app/**',
      'https://my-app-git-*-acme.vercel.app/**',
    ]);
    const ex2 = mockExec([WHOAMI_OK]);
    const personal = testCtx({ exec: ex2.run, state: linkedState({ 'vercel.orgId': 'user_abc' }) });
    expect(await url.previewPatterns!(personal)).toEqual(['https://my-app-*-alice.vercel.app/**', 'https://my-app-git-*-alice.vercel.app/**']);
  });
});

// ── deploy ────────────────────────────────────────────────────────────────────────────────────

describe('vercel deploy', () => {
  it('parses the non-interactive envelope and pins the selected project via env', async () => {
    const envelope = { status: 'ok', deployment: { id: 'dpl_1', url: 'https://my-app-abc123-acme.vercel.app', readyState: 'READY' }, message: 'ok' };
    const ex = mockExec([WHOAMI_OK, ['vercel deploy', { stdout: JSON.stringify(envelope) }]]);
    const ctx = testCtx({ exec: ex.run, state: linkedState() });
    expect(await deployer.deploy(ctx, 'production')).toEqual({ url: 'https://my-app-abc123-acme.vercel.app', id: 'dpl_1' });
    const call = ex.calls.find((c) => c.args[0] === 'deploy')!;
    expect(call.args).toEqual(['deploy', '--prod', '--yes', '--non-interactive', '--format', 'json', '--scope', 'team_1']);
    expect(call.args.join(' ')).not.toMatch(/--env|--build-env|--token/);
    expect(call.opts?.env).toMatchObject({ VERCEL_PROJECT_ID: 'prj_1', VERCEL_ORG_ID: 'team_1' });
    expect(call.opts?.timeoutMs).toBe(15 * 60_000);
    expect(call.opts?.cwd).toBe('/repo');
  });

  it('accepts the plain deployment object and falls back to the last *.vercel.app line', async () => {
    const ex = mockExec([WHOAMI_OK, ['vercel deploy', { stdout: JSON.stringify({ id: 'dpl_2', url: 'my-app-x-acme.vercel.app' }) }]]);
    expect(await deployer.deploy(testCtx({ exec: ex.run, state: linkedState() }), 'preview')).toEqual({ url: 'https://my-app-x-acme.vercel.app', id: 'dpl_2' });
    // A CLI that printed only the URL reports no identity: golive records none rather than making one up.
    const ex2 = mockExec([WHOAMI_OK, ['vercel deploy', { stdout: 'Uploading…\nhttps://my-app-y-acme.vercel.app\n' }]]);
    expect(await deployer.deploy(testCtx({ exec: ex2.run, state: linkedState() }), 'preview')).toEqual({ url: 'https://my-app-y-acme.vercel.app' });
    expect(ex2.calls.find((c) => c.args[0] === 'deploy')!.args).not.toContain('--prod');
  });

  it('regression (round 2 #2): token session gives `vercel deploy` the token via the child env, never argv', async () => {
    const envelope = { status: 'ok', deployment: { url: 'https://my-app-t0k-acme.vercel.app' } };
    // CLI installed but not logged in; the token came from the credentials file (not process.env).
    const ex = mockExec([WHOAMI_OUT, ['vercel deploy', { stdout: JSON.stringify(envelope) }]]);
    const ctx = testCtx({ exec: ex.run, tokens: { VERCEL_TOKEN: TOKEN }, state: linkedState() });
    expect(await deployer.deploy(ctx, 'production')).toEqual({ url: 'https://my-app-t0k-acme.vercel.app' });
    const call = ex.calls.find((c) => c.args[0] === 'deploy')!;
    expect(call.opts?.env).toMatchObject({ VERCEL_TOKEN: TOKEN, VERCEL_PROJECT_ID: 'prj_1', VERCEL_ORG_ID: 'team_1', NO_COLOR: '1' });
    expect(allArgs(ex.calls)).not.toContain(TOKEN);
    expect(call.args).not.toContain('--token');
    expect(ctx.logs.join('\n')).not.toContain(TOKEN);
  });

  it('the CLI session never injects VERCEL_TOKEN (the CLI uses its own login)', async () => {
    const ex = mockExec([WHOAMI_OK, ['vercel deploy', { stdout: JSON.stringify({ url: 'my-app-z-acme.vercel.app' }) }]]);
    await deployer.deploy(testCtx({ exec: ex.run, tokens: { VERCEL_TOKEN: TOKEN }, state: linkedState() }), 'preview');
    expect(ex.calls.find((c) => c.args[0] === 'deploy')!.opts?.env).not.toHaveProperty('VERCEL_TOKEN');
  });

  it('regression (round 2 #2): token session without the CLI binary → clear install error before running anything', async () => {
    const ex = mockExec([]);
    const ctx = testCtx({ exec: ex.run, tokens: { VERCEL_TOKEN: TOKEN }, state: linkedState() });
    const err = (await deployer.deploy(ctx, 'production').catch((e: unknown) => e)) as VercelError;
    expect(err).toBeInstanceOf(VercelError);
    expect(err.code).toBe('cli_missing');
    expect(err.message).toContain('install it: npm i -g vercel');
    expect(err.message).not.toContain(TOKEN);
    expect(ex.calls.some((c) => c.args[0] === 'deploy')).toBe(false);
  });

  it('the binary vanishing between whoami and deploy (command not found) maps to the same install error', async () => {
    const ex = mockExec([
      WHOAMI_OUT,
      [
        'vercel deploy',
        () => {
          throw new Error('vercel: command not found');
        },
      ],
    ]);
    const err = (await deployer.deploy(testCtx({ exec: ex.run, tokens: { VERCEL_TOKEN: TOKEN }, state: linkedState() }), 'production').catch((e: unknown) => e)) as VercelError;
    expect(err.code).toBe('cli_missing');
    expect(err.message).toContain('install it: npm i -g vercel');
  });

  it('a non-build deploy failure does not blame the build', async () => {
    const ex = mockExec([WHOAMI_OK, ['vercel deploy', { code: 1, stdout: JSON.stringify({ status: 'error', reason: 'missing_scope', message: 'You do not have access to team_1' }) }]]);
    const err = (await deployer.deploy(testCtx({ exec: ex.run, state: linkedState() }), 'production').catch((e: unknown) => e)) as Error;
    expect(err.message).toMatch(/\(missing_scope\).*access to team_1/);
    expect(err.message).not.toMatch(/Fix the build error/);
    expect(err.message).toContain('deploy again');
  });

  it('maps a failed deploy to an actionable error', async () => {
    const ex = mockExec([WHOAMI_OK, ['vercel deploy', { code: 1, stdout: JSON.stringify({ status: 'error', reason: 'build_failed', message: 'Command "next build" exited with 1' }) }]]);
    await expect(deployer.deploy(testCtx({ exec: ex.run, state: linkedState() }), 'production')).rejects.toThrow(/\(build_failed\).*next build.*deploy again/);
  });
});

// ── domain ────────────────────────────────────────────────────────────────────────────────────

const CONFIG_OK = { configuredBy: 'A', misconfigured: false, recommendedIPv4: [{ rank: 2, value: ['76.76.21.21'] }, { rank: 1, value: ['216.198.79.1'] }], recommendedCNAME: [{ rank: 1, value: 'd1d4fc829fe7bc7c.vercel-dns-017.com.' }] };

describe('vercel domain', () => {
  it('add() adopts a domain already on the project', async () => {
    const ex = mockExec([WHOAMI_OK, cliApi({ 'GET /v9/projects/prj_1/domains/example.com': { name: 'example.com', verified: true } })]);
    await domain.add(testCtx({ exec: ex.run, state: linkedState() }), 'example.com');
    expect(ex.calls.some((c) => c.args[3] === 'POST')).toBe(false);
  });

  it('add() posts {name} when missing and maps 409 to an actionable error', async () => {
    const ex = mockExec([WHOAMI_OK, cliApi({ 'POST /v10/projects/prj_1/domains': { name: 'example.com', verified: true } })]);
    await domain.add(testCtx({ exec: ex.run, state: linkedState() }), 'example.com');
    expect(JSON.parse(ex.calls.find((c) => c.args[3] === 'POST')!.stdin!)).toEqual({ name: 'example.com' });

    const h = mockHttp([
      ['GET', `${API}/v9/projects/prj_1/domains/taken.com`, () => ({ status: 404, json: { error: { code: 'not_found', message: 'nope' } } })],
      ['POST', `${API}/v10/projects/prj_1/domains`, () => ({ status: 409, json: { error: { code: 'domain_already_in_use', message: 'in use' } } })],
    ]);
    const ctx = testCtx({ exec: mockExec([WHOAMI_OUT]).run, http: h.http, tokens: { VERCEL_TOKEN: TOKEN }, state: linkedState() });
    await expect(domain.add(ctx, 'taken.com')).rejects.toThrow(/another Vercel project or owned by another account/);
  });

  it('requiredRecords(): rank-1 A for apex, CNAME for subdomain, TXT when unverified; never proxied', async () => {
    const ex = mockExec([
      WHOAMI_OK,
      cliApi({
        'GET /v9/projects/prj_1/domains/example.com': { name: 'example.com', apexName: 'example.com', verified: false, verification: [{ type: 'TXT', domain: '_vercel.example.com', value: 'vc-domain-verify=example.com,abc', reason: 'pending_domain_verification' }] },
        'GET /v6/domains/example.com/config': CONFIG_OK,
        'GET /v9/projects/prj_1/domains/app.example.co.uk': { name: 'app.example.co.uk', apexName: 'example.co.uk', verified: true },
        'GET /v6/domains/app.example.co.uk/config': CONFIG_OK,
      }),
    ]);
    const ctx = testCtx({ exec: ex.run, state: linkedState() });
    expect(await domain.requiredRecords(ctx, 'example.com')).toEqual([
      { type: 'A', name: 'example.com', content: '216.198.79.1', proxied: false },
      { type: 'TXT', name: '_vercel.example.com', content: 'vc-domain-verify=example.com,abc', proxied: false },
    ]);
    expect(await domain.requiredRecords(ctx, 'app.example.co.uk')).toEqual([{ type: 'CNAME', name: 'app.example.co.uk', content: 'd1d4fc829fe7bc7c.vercel-dns-017.com', proxied: false }]);
    expect(ex.calls.find((c) => c.args[1]!.startsWith('/v6/'))!.args[1]).toBe('/v6/domains/example.com/config?projectIdOrName=prj_1');
  });

  it('status(): ok / pending / misconfigured', async () => {
    const doh = (answers: Array<{ name: string; type: number; TTL: number; data: string }>) =>
      mockHttp([['GET', /^https:\/\/cloudflare-dns\.com\/dns-query/, () => ({ json: { Status: 0, Answer: answers } })]]).http;
    const mk = (verified: boolean, misconfigured: boolean) =>
      mockExec([WHOAMI_OK, cliApi({ 'GET /v9/projects/prj_1/domains/example.com': { name: 'example.com', apexName: 'example.com', verified }, 'GET /v6/domains/example.com/config': { ...CONFIG_OK, misconfigured } })]).run;

    expect(await domain.status(testCtx({ exec: mk(true, false), state: linkedState() }), 'example.com')).toBe('ok');
    expect(await domain.status(testCtx({ exec: mk(false, true), state: linkedState() }), 'example.com')).toBe('pending');
    expect(await domain.status(testCtx({ exec: mk(true, true), http: doh([]), state: linkedState() }), 'example.com')).toBe('pending');
    expect(await domain.status(testCtx({ exec: mk(true, true), http: doh([{ name: 'example.com.', type: 1, TTL: 60, data: '1.2.3.4' }]), state: linkedState() }), 'example.com')).toBe('misconfigured');
    const notAttached = mockExec([WHOAMI_OK, cliApi({})]).run;
    expect(await domain.status(testCtx({ exec: notAttached, state: linkedState() }), 'example.com')).toBe('misconfigured');
  });
});

describe('vercel domain verify', () => {
  const UNVERIFIED = { name: 'example.com', apexName: 'example.com', verified: false, verification: [{ type: 'TXT', domain: '_vercel.example.com', value: 'vc-domain-verify=example.com,abc' }] };

  it('never re-verifies a verified domain', async () => {
    const ex = mockExec([WHOAMI_OK, cliApi({ 'GET /v9/projects/prj_1/domains/example.com': { name: 'example.com', verified: true } })]);
    expect(await domain.verify!(testCtx({ exec: ex.run, state: linkedState() }), 'example.com')).toBe('verified');
    expect(ex.calls.some((c) => c.args[3] === 'POST')).toBe(false);
  });

  it('regression: unverified domain (held by another account) → POSTs /verify and returns verified', async () => {
    const ex = mockExec([
      WHOAMI_OK,
      cliApi({
        'GET /v9/projects/prj_1/domains/example.com': UNVERIFIED,
        'POST /v9/projects/prj_1/domains/example.com/verify': { ...UNVERIFIED, verified: true },
      }),
    ]);
    const ctx = testCtx({ exec: ex.run, state: linkedState() });
    expect(await domain.verify!(ctx, 'example.com')).toBe('verified');
    const post = ex.calls.find((c) => c.args[3] === 'POST')!;
    expect(post.args).toEqual(['api', '/v9/projects/prj_1/domains/example.com/verify', '-X', 'POST', '--raw', '--non-interactive', '--scope', 'team_1']);
    expect(post.stdin).toBeUndefined();
  });

  it('verify response with verified:false → pending', async () => {
    const ex = mockExec([WHOAMI_OK, cliApi({ 'GET /v9/projects/prj_1/domains/example.com': UNVERIFIED, 'POST /v9/projects/prj_1/domains/example.com/verify': UNVERIFIED })]);
    expect(await domain.verify!(testCtx({ exec: ex.run, state: linkedState() }), 'example.com')).toBe('pending');
  });

  it('400 TXT not found / does not match → pending (DNS still propagating); via token, marked idempotent', async () => {
    for (const message of ['Domain verification failed: TXT record not found for _vercel.example.com', 'The TXT record does not match the expected value']) {
      const h = mockHttp([
        ['GET', `${API}/v9/projects/prj_1/domains/example.com`, () => ({ json: UNVERIFIED })],
        ['POST', `${API}/v9/projects/prj_1/domains/example.com/verify`, () => ({ status: 400, json: { error: { code: 'bad_request', message } } })],
      ]);
      const spy = spyHttp(h.http);
      const ctx = testCtx({ exec: mockExec([WHOAMI_OUT]).run, http: spy.http, tokens: { VERCEL_TOKEN: TOKEN }, state: linkedState() });
      expect(await domain.verify!(ctx, 'example.com')).toBe('pending');
      const post = spy.reqs.find((r) => r.method === 'POST')!;
      expect(post.url).toBe(`${API}/v9/projects/prj_1/domains/example.com/verify?teamId=team_1`);
      expect(post.idempotent).toBe(true);
    }
  });

  it('a domain whose name contains "txt" does not make every 400 look like a TXT miss', async () => {
    const ex = mockExec([
      WHOAMI_OK,
      cliApi({
        'GET /v9/projects/prj_1/domains/mytxt.com': { ...UNVERIFIED, name: 'mytxt.com' },
        'POST /v9/projects/prj_1/domains/mytxt.com/verify': () => ({ code: 1, stderr: 'Error: (400) {"error":{"code":"bad_request","message":"Invalid domain name"}}' }),
      }),
    ]);
    await expect(domain.verify!(testCtx({ exec: ex.run, state: linkedState() }), 'mytxt.com')).rejects.toThrow(/HTTP 400.*Invalid domain name/);
  });

  it('TXT already verifying for another project → actionable error, not pending', async () => {
    const ex = mockExec([
      WHOAMI_OK,
      cliApi({
        'GET /v9/projects/prj_1/domains/example.com': UNVERIFIED,
        'POST /v9/projects/prj_1/domains/example.com/verify': () => ({ code: 1, stderr: 'Error: (400) {"error":{"code":"bad_request","message":"There is an existing TXT record on the domain verifying it for another project"}}' }),
      }),
    ]);
    await expect(domain.verify!(testCtx({ exec: ex.run, state: linkedState() }), 'example.com')).rejects.toThrow(/already verifying example.com for another project/);
  });

  it('a lost response to a successful verify: re-reads and reports verified', async () => {
    let gets = 0;
    const ex = mockExec([
      WHOAMI_OK,
      cliApi({
        'GET /v9/projects/prj_1/domains/example.com': () => ({ stdout: JSON.stringify(gets++ === 0 ? UNVERIFIED : { ...UNVERIFIED, verified: true }) }),
        'POST /v9/projects/prj_1/domains/example.com/verify': () => ({ code: 1, stderr: 'Error: (500) {"error":{"code":"internal","message":"timeout"}}' }),
      }),
    ]);
    expect(await domain.verify!(testCtx({ exec: ex.run, state: linkedState() }), 'example.com')).toBe('verified');
  });

  it('not attached → actionable error', async () => {
    const ex = mockExec([WHOAMI_OK, cliApi({})]);
    await expect(domain.verify!(testCtx({ exec: ex.run, state: linkedState() }), 'example.com')).rejects.toThrow(/not attached/);
  });
});

describe('vercel creates are never marked idempotent', () => {
  it('env create / domain attach / project create POSTs carry no idempotent flag', async () => {
    const h = mockHttp([
      ['GET', `${API}/v10/projects/prj_1/env`, () => ({ json: { envs: [] } })],
      ['POST', `${API}/v10/projects/prj_1/env`, () => ({ json: { created: {}, failed: [] } })],
      ['GET', `${API}/v9/projects/prj_1/domains/example.com`, () => ({ status: 404, json: { error: { code: 'not_found', message: 'nope' } } })],
      ['POST', `${API}/v10/projects/prj_1/domains`, () => ({ json: { name: 'example.com', verified: true } })],
    ]);
    const spy = spyHttp(h.http);
    const ctx = testCtx({ exec: mockExec([WHOAMI_OUT]).run, http: spy.http, tokens: { VERCEL_TOKEN: TOKEN }, state: linkedState() });
    await env.set(ctx, 'K', 'v', ['production']);
    await domain.add(ctx, 'example.com');
    const posts = spy.reqs.filter((r) => r.method === 'POST');
    expect(posts).toHaveLength(2);
    for (const p of posts) expect(p.idempotent).toBeUndefined();
  });
});

describe('vercel detect', () => {
  it('detects vercel config or declared provider', () => {
    expect(vercelAdapter.detect!(detectFixture({ configs: { '.vercel/project.json': '{}' } }))).toBe(true);
    expect(vercelAdapter.detect!(detectFixture({ configs: { 'vercel.json': '{}' } }))).toBe(true);
    expect(vercelAdapter.detect!(detectFixture({ providers: { hosting: ['vercel'] } }))).toBe(true);
    expect(vercelAdapter.detect!(detectFixture())).toBe(false);
    expect(vercelAdapter).toMatchObject({ id: 'vercel', axes: ['hosting'], automated: true });
  });
});
