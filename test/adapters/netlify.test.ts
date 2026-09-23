import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Secret, _resetSecretRegistry } from '../../src/core/secret.js';
import { ExecError } from '../../src/core/exec.js';
import { emptyState } from '../../src/core/state.js';
import { netlifyAdapter } from '../../src/adapters/netlify.js';
import { NETLIFY_API, netlifyRead } from '../../src/adapters/netlify-api.js';
import { publicOrigin } from '../../src/adapters/netlify-project.js';
import { netlifyConfigPath, readNetlifyCliToken } from '../../src/adapters/netlify-credentials.js';
import { mockExec, mockHttp, testCtx, type ExecCall } from '../helpers.js';
import { RAW } from '../fakes.js';

vi.mock('../../src/adapters/netlify-credentials.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../src/adapters/netlify-credentials.js')>(),
  readNetlifyCliToken: vi.fn(),
}));

const SITE = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const TOKEN = 'test-netlify-token-value-1234567890';
const SITE_RAW = { id: SITE, name: 'sample-app', account_id: 'account_1', account_slug: 'example-team', ssl_url: 'https://sample-app.netlify.app', published_deploy: { id: 'deploy_1' }, password: RAW.supabaseSecret, default_hooks_data: { access_token: TOKEN } };
const ACCOUNT = { id: 'account_1', name: 'Example team', slug: 'example-team', type_name: 'Free', capabilities: { sites: { included: 500, used: 2 } }, billing_details: RAW.dbUrl };
const DEPLOY = { id: 'deploy_1', site_id: SITE, state: 'ready', context: 'production', draft: false, deploy_ssl_url: 'https://deploy-1--sample-app.netlify.app', skew_protection_token: TOKEN };
const fullScopes = ['builds', 'functions', 'runtime', 'post_processing'];
const project = netlifyAdapter.capabilities.project!;
const env = netlifyAdapter.capabilities.env!;
const deploy = netlifyAdapter.capabilities.deploy!;
const url = netlifyAdapter.capabilities.url!;
const tempDirs: string[] = [];
const tokens = { NETLIFY_AUTH_TOKEN: TOKEN };

function linkedState() {
  const state = emptyState();
  state.resources = { 'netlify.siteId': SITE, 'netlify.siteName': 'sample-app', 'netlify.accountId': 'account_1', 'netlify.accountSlug': 'example-team' };
  return state;
}
type CliRoute = unknown | ((c: ExecCall) => { code?: number; stdout?: string; stderr?: string });
function cli(over: Record<string, CliRoute> = {}) {
  const routes: Record<string, CliRoute> = { getCurrentUser: { id: 'user_1' }, getAccount: ACCOUNT, listAccountsForUser: [ACCOUNT], getSite: SITE_RAW, listSites: [SITE_RAW], listSitesForAccount: [], getEnvVars: [], getSiteDeploy: DEPLOY, ...over };
  return mockExec([
    [/^netlify api /, call => {
      const value = routes[call.args[1]!];
      return typeof value === 'function' ? value(call) : value !== undefined ? { stdout: JSON.stringify(value) } : { code: 1, stderr: `do not print ${RAW.dbUrl}` };
    }],
    [/^netlify deploy /, { stdout: JSON.stringify({ site_id: SITE, deploy_id: 'deploy_1', url: 'https://untrusted.invalid' }) }],
  ]);
}
function http(extra: Parameters<typeof mockHttp>[0] = []) {
  return mockHttp([['GET', `${NETLIFY_API}/user`, () => ({ json: { id: 'user_1' } })], ...extra]);
}
beforeEach(() => { _resetSecretRegistry(); vi.mocked(readNetlifyCliToken).mockReset(); });
afterEach(() => { for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true }); });

describe('Netlify credentials and safe transports', () => {
  it('reuses one CLI login in-process, without a second PAT or secret arguments', async () => {
    vi.mocked(readNetlifyCliToken).mockReturnValue(new Secret('netlify-cli-oauth', TOKEN));
    const ex = cli(); const h = http(); const ctx = testCtx({ exec: ex.run, http: h.http });
    expect((await netlifyAdapter.auth(ctx)).ok).toBe(true);
    expect(readNetlifyCliToken).toHaveBeenCalledWith('user_1');
    expect(h.calls[0]!.headers?.authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.stringify(ex.calls)).not.toContain(TOKEN);
    expect(ex.calls[0]!.opts?.env).toMatchObject({ NETLIFY_AUTH_TOKEN: '', NETLIFY_API_URL: '', CI: '1' });
  });

  it('uses an explicit golive credential without reading the CLI credential file', async () => {
    const ctx = testCtx({ exec: cli().run, http: http().http, tokens });
    expect((await netlifyAdapter.auth(ctx)).ok).toBe(true);
    expect(readNetlifyCliToken).not.toHaveBeenCalled();
  });

  it('does not reuse an identity cache across contexts sharing an executor', async () => {
    const ex = cli();
    const first = testCtx({ exec: ex.run, http: http().http, tokens });
    expect((await netlifyAdapter.auth(first)).ok).toBe(true);
    const changed = mockHttp([['GET', `${NETLIFY_API}/user`, () => ({ json: { id: 'different_user' } })]]);
    expect((await netlifyAdapter.auth(testCtx({ exec: ex.run, http: changed.http, tokens }))).ok).toBe(false);
    expect(changed.calls).toHaveLength(1);
  });

  it('rejects different CLI and explicit-token principals before any write', async () => {
    const h = mockHttp([['GET', `${NETLIFY_API}/user`, () => ({ json: { id: 'user_wrong' } })]]);
    const ctx = testCtx({ exec: cli().run, http: h.http, tokens });
    expect(await netlifyAdapter.auth(ctx)).toMatchObject({ ok: false, howToFix: expect.stringContaining('identities differ') });
    expect(h.calls.every(c => c.method === 'GET')).toBe(true);
  });

  it('asks for login if the CLI is absent or logged out; never echoes CLI secrets', async () => {
    const ex = cli({ getCurrentUser: () => ({ code: 1, stderr: RAW.dbUrl }) });
    const answer = await netlifyAdapter.auth(testCtx({ exec: ex.run }));
    expect(answer).toMatchObject({ ok: false, howToFix: expect.stringContaining('separate terminal window') });
    expect(JSON.stringify(answer)).not.toContain(RAW.dbUrl);
  });

  it('retries one thrown account read before inspecting the verified user credential', async () => {
    let reads = 0;
    vi.mocked(readNetlifyCliToken).mockReturnValue(new Secret('netlify-cli-oauth', TOKEN));
    const ex = cli({ getCurrentUser: () => {
      reads++;
      expect(readNetlifyCliToken).not.toHaveBeenCalled();
      if (reads === 1) throw new ExecError('netlify timed out after 30000ms');
      return { stdout: JSON.stringify({ id: 'user_1' }) };
    } });
    const h = http();
    expect((await netlifyAdapter.auth(testCtx({ exec: ex.run, http: h.http }))).ok).toBe(true);
    expect(reads).toBe(2); expect(readNetlifyCliToken).toHaveBeenCalledWith('user_1');
    expect(h.calls.map(c => [c.method, c.url])).toEqual([['GET', `${NETLIFY_API}/user`]]);
  });

  it.each([
    [new ExecError('netlify timed out after 30000ms'), 'timed out'],
    [new Error(RAW.dbUrl), 'could not complete'],
  ])('reports repeated process failures as unknown login state, without reading credentials', async (error, phrase) => {
    const ex = cli({ getCurrentUser: () => { throw error; } }); const h = http();
    const ctx = testCtx({ exec: ex.run, http: h.http });
    const answer = await netlifyAdapter.auth(ctx);
    expect(answer.ok).toBe(false); expect(answer.howToFix).toContain(phrase); expect(answer.howToFix).toContain('Login state is unknown');
    expect(answer.howToFix).not.toContain('netlify login'); expect(JSON.stringify(answer)).not.toContain(RAW.dbUrl);
    expect(ex.calls).toHaveLength(2); expect(readNetlifyCliToken).not.toHaveBeenCalled(); expect(h.calls).toHaveLength(0);
    await expect(deploy.deploy(ctx, 'production')).rejects.toThrow('Login state is unknown');
    expect(ex.calls).toHaveLength(2); expect(h.calls).toHaveLength(0);
  });

  it('recognizes only the exact typed missing-CLI error and does not retry it', async () => {
    const ex = cli({ getCurrentUser: () => { throw new ExecError('netlify: command not found'); } });
    const answer = await netlifyAdapter.auth(testCtx({ exec: ex.run }));
    expect(answer.howToFix).toContain('not installed or is not on PATH'); expect(answer.howToFix).not.toContain('netlify login');
    expect(ex.calls).toHaveLength(1); expect(readNetlifyCliToken).not.toHaveBeenCalled();
  });

  it.each([
    { code: 1, stdout: '', stderr: RAW.dbUrl },
    { code: 0, stdout: RAW.dbUrl },
    { code: 0, stdout: '{"id":null}' },
  ])('does not retry rejected or malformed account responses or read credentials', async response => {
    const ex = cli({ getCurrentUser: () => response }); const h = http();
    const answer = await netlifyAdapter.auth(testCtx({ exec: ex.run, http: h.http }));
    expect(answer.ok).toBe(false); expect(JSON.stringify(answer)).not.toContain(RAW.dbUrl);
    expect(ex.calls).toHaveLength(1); expect(readNetlifyCliToken).not.toHaveBeenCalled(); expect(h.calls).toHaveLength(0);
  });

  it('offers a safe fallback when the CLI store cannot be reused', async () => {
    vi.mocked(readNetlifyCliToken).mockImplementation(() => { throw new Error(RAW.supabaseSecret); });
    const answer = await netlifyAdapter.auth(testCtx({ exec: cli().run }));
    expect(answer.ok).toBe(false);
    expect(answer.howToFix).toContain('credential fallback');
    expect(JSON.stringify(answer)).not.toContain(RAW.supabaseSecret);
  });

  it('does not echo raw HTTP errors, response objects or credentials', async () => {
    const h = mockHttp([['GET', `${NETLIFY_API}/user`, () => ({ status: 403, json: { message: TOKEN, secret: RAW.supabaseSecret } })]]);
    const answer = await netlifyAdapter.auth(testCtx({ exec: cli().run, http: h.http, tokens }));
    expect(answer.ok).toBe(false); expect(answer.howToFix).toContain('HTTP 403');
    expect(JSON.stringify(answer)).not.toContain(TOKEN); expect(JSON.stringify(answer)).not.toContain(RAW.supabaseSecret);
  });

  it('recovers a thrown CLI read through the same verified OAuth identity and exact HTTPS GET', async () => {
    vi.mocked(readNetlifyCliToken).mockReturnValue(new Secret('netlify-cli-oauth', TOKEN));
    const ex = cli({ getSite: () => { throw new Error(`timeout ${RAW.dbUrl}`); } });
    const h = http([['GET', `${NETLIFY_API}/sites/${SITE}`, () => ({ json: SITE_RAW })]]);
    const ctx = testCtx({ exec: ex.run, http: h.http });
    expect(await netlifyRead(ctx, 'getSite', `/sites/${SITE}`, { site_id: SITE })).toMatchObject({ id: SITE });
    expect(readNetlifyCliToken).toHaveBeenCalledWith('user_1');
    expect(h.calls.map(c => [c.method, c.url])).toEqual([['GET', `${NETLIFY_API}/user`], ['GET', `${NETLIFY_API}/sites/${SITE}`]]);
    expect(ex.calls.map(c => c.args[1])).toEqual(['getCurrentUser', 'getSite']);
    expect(ctx.logs).toHaveLength(1); expect(ctx.logs[0]).toContain('matches the CLI account');
    expect(JSON.stringify([ctx.logs, ctx.state.get(), ex.calls])).not.toContain(TOKEN);
    expect(JSON.stringify([ctx.logs, ctx.state.get(), ex.calls])).not.toContain(RAW.dbUrl);
  });

  it('refuses a fallback identity mismatch before the target read', async () => {
    vi.mocked(readNetlifyCliToken).mockReturnValue(new Secret('netlify-cli-oauth', TOKEN));
    const ex = cli({ getSite: () => { throw new Error('timeout'); } });
    const h = mockHttp([['GET', `${NETLIFY_API}/user`, () => ({ json: { id: 'different_user' } })]]);
    await expect(netlifyRead(testCtx({ exec: ex.run, http: h.http }), 'getSite', `/sites/${SITE}`, { site_id: SITE })).rejects.toThrow('identities differ');
    expect(h.calls.map(c => c.url)).toEqual([`${NETLIFY_API}/user`]);
  });

  it.each([
    { code: 1, stdout: '', stderr: `Unauthorized ${RAW.dbUrl}` },
    { code: 0, stdout: RAW.dbUrl, stderr: '' },
  ])('does not use HTTPS to bypass a CLI exit error or malformed JSON', async response => {
    const ex = cli({ getSite: () => response }); const h = http();
    const ctx = testCtx({ exec: ex.run, http: h.http, tokens });
    const failure = await netlifyRead(ctx, 'getSite', `/sites/${SITE}`, { site_id: SITE }).catch((e: Error) => e);
    expect(failure).toBeInstanceOf(Error); expect(String(failure)).not.toContain(RAW.dbUrl);
    expect(h.calls).toHaveLength(0); expect(readNetlifyCliToken).not.toHaveBeenCalled(); expect(ctx.logs).toHaveLength(0);
  });

  it('keeps fallback HTTP failures safe and never repeats a write or the CLI operation', async () => {
    const ex = cli({ getSite: () => { throw new Error(RAW.supabaseSecret); } });
    const h = http([['GET', `${NETLIFY_API}/sites/${SITE}`, () => ({ status: 403, json: { message: RAW.dbUrl, token: TOKEN } })]]);
    const ctx = testCtx({ exec: ex.run, http: h.http, tokens });
    const failure = await netlifyRead(ctx, 'getSite', `/sites/${SITE}`, { site_id: SITE }).catch((e: Error) => e);
    expect(String(failure)).toContain('HTTP 403'); expect(String(failure)).not.toContain(RAW.dbUrl); expect(String(failure)).not.toContain(TOKEN);
    expect(h.calls.every(c => c.method === 'GET')).toBe(true); expect(h.calls).toHaveLength(2);
    expect(ex.calls.filter(c => c.args[1] === 'getSite')).toHaveLength(1); expect(JSON.stringify(ctx.logs)).not.toContain(RAW.supabaseSecret);
  });

  it('supports documented platform config paths without looking at real credential files', () => {
    expect(netlifyConfigPath({ platform: 'darwin', home: '/fake' })).toBe('/fake/Library/Preferences/netlify/config.json');
    expect(netlifyConfigPath({ platform: 'linux', home: '/fake', xdgConfigHome: '/config' })).toBe('/config/netlify/config.json');
    expect(netlifyConfigPath({ platform: 'win32', home: '/fake', appData: '/roaming' })).toBe('/roaming/netlify/Config/config.json');
  });

  it('reads only a synthetic private current-user entry and returns a Secret', async () => {
    const actual = await vi.importActual<typeof import('../../src/adapters/netlify-credentials.js')>('../../src/adapters/netlify-credentials.js');
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'netlify-credential-test-'))); tempDirs.push(dir);
    const path = join(dir, 'config.json');
    writeFileSync(path, JSON.stringify({ userId: 'user_1', users: { user_1: { auth: { token: TOKEN } } } }), { mode: 0o600 });
    const secret = actual.readNetlifyCliToken('user_1', path);
    expect(secret).toBeInstanceOf(Secret); expect(secret?.reveal()).toBe(TOKEN);
    expect(JSON.stringify(secret)).not.toContain(TOKEN);
    expect(() => actual.readNetlifyCliToken('different-user', path)).toThrow('could not be safely reused');
    chmodSync(path, 0o644);
    if (process.platform !== 'win32') expect(() => actual.readNetlifyCliToken('user_1', path)).toThrow('could not be safely reused');
  });

  it('rejects synthetic symlinks and malformed stores without echoing bytes', async () => {
    const actual = await vi.importActual<typeof import('../../src/adapters/netlify-credentials.js')>('../../src/adapters/netlify-credentials.js');
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'netlify-credential-test-'))); tempDirs.push(dir);
    const path = join(dir, 'config.json'); const link = join(dir, 'link.json');
    writeFileSync(path, TOKEN, { mode: 0o600 }); symlinkSync(path, link);
    for (const file of [path, link]) {
      const error = (() => { try { actual.readNetlifyCliToken('user_1', file); } catch (e) { return e as Error; } })();
      expect(error?.message).not.toContain(TOKEN); expect(error).toBeInstanceOf(Error);
    }
  });
});

describe('Netlify project scope and cost gates', () => {
  it('selects an exact site and persists only safe identities', async () => {
    const ctx = testCtx({ exec: cli().run });
    expect(await project.select(ctx, SITE)).toMatchObject({ id: SITE, scope: { id: 'account_1', kind: 'team' } });
    expect(ctx.state.resource('netlify.siteId')).toBe(SITE);
    expect(JSON.stringify(ctx.state.get())).not.toContain(TOKEN); expect(JSON.stringify(ctx.state.get())).not.toContain(RAW.supabaseSecret);
  });

  it('refuses an owner mismatch for the configured team or remembered site', async () => {
    const ctx = testCtx({ exec: cli().run, env: { NETLIFY_ACCOUNT_ID: 'wrong' } });
    await expect(project.select(ctx, SITE)).rejects.toThrow('owner differs');
    const ex = cli({ getSite: { ...SITE_RAW, account_id: 'moved' } });
    await expect(env.listNames(testCtx({ exec: ex.run, state: linkedState() }), 'production')).rejects.toThrow('owner differs');
  });

  it('refuses ambiguous names rather than guessing an account', async () => {
    const ctx = testCtx({ exec: cli({ listSites: [SITE_RAW, { ...SITE_RAW, id: OTHER, account_id: 'other' }] }).run });
    await expect(project.resolve!(ctx, 'sample-app')).rejects.toThrow('ambiguous');
  });

  it('resolves the unique Free destination with documented quota headroom', async () => {
    expect(await project.creationTarget!(testCtx({ exec: cli().run }))).toEqual({ scope: { kind: 'team', id: 'account_1', name: 'Example team' } });
  });

  it.each(['Pro', 'Starter', '', 'Enterprise'])('blocks creation for paid, legacy or unknown plan %s', async plan => {
    const ctx = testCtx({ exec: cli({ getAccount: { ...ACCOUNT, type_name: plan } }).run, env: { NETLIFY_ACCOUNT_ID: 'account_1' } });
    await expect(project.creationTarget!(ctx)).rejects.toThrow('not verified');
  });

  it.each([undefined, { sites: { included: 1, used: 1 } }, { sites: { included: 500 } }])('blocks missing or exhausted quota metadata', async capabilities => {
    const ctx = testCtx({ exec: cli({ getAccount: { ...ACCOUNT, capabilities } }).run, env: { NETLIFY_ACCOUNT_ID: 'account_1' } });
    await expect(project.creationTarget!(ctx)).rejects.toThrow('quota');
  });

  it('requires an exact approved creation destination and refuses drift', async () => {
    const ctx = testCtx({ exec: cli().run });
    await expect(project.create!(ctx, 'new-app')).rejects.toThrow('approved');
    await expect(project.create!(ctx, 'new-app', { scope: { kind: 'team', id: 'wrong' } })).rejects.toThrow('changed');
  });

  it('creates only inside the approved free team with DNS disabled and safe body transport', async () => {
    const h = http([['POST', `${NETLIFY_API}/example-team/sites`, () => ({ json: { ...SITE_RAW, name: 'new-app' } })]]);
    const ex = cli(); const ctx = testCtx({ exec: ex.run, http: h.http, tokens });
    expect(await project.create!(ctx, 'new-app', { scope: { kind: 'team', id: 'account_1' } })).toMatchObject({ id: SITE });
    const post = h.calls.find(c => c.method === 'POST')!;
    expect(post.url).toContain('configure_dns=false'); expect(post.body).toEqual({ name: 'new-app' });
    expect(JSON.stringify(ex.calls)).not.toContain(TOKEN);
  });

  it('never silently adopts a colliding site or accepts a wrong create response', async () => {
    const ctx = testCtx({ exec: cli({ listSitesForAccount: [SITE_RAW] }).run });
    await expect(project.create!(ctx, 'sample-app', { scope: { kind: 'team', id: 'account_1' } })).rejects.toThrow('not adopted');
    const h = http([['POST', `${NETLIFY_API}/example-team/sites`, () => ({ json: { ...SITE_RAW, name: 'new-app', account_id: 'wrong' } })]]);
    const second = testCtx({ exec: cli().run, http: h.http, tokens });
    await expect(project.create!(second, 'new-app', { scope: { kind: 'team', id: 'account_1' } })).rejects.toThrow('unexpected destination');
    expect(second.state.resource('netlify.siteId')).toBeUndefined();
  });
});

describe('Netlify environment writes', () => {
  it('lists matching context names only and never returns values', async () => {
    const ex = cli({ getEnvVars: [
      { key: 'PUBLIC', scopes: fullScopes, values: [{ context: 'all', value: TOKEN }] },
      { key: 'SECRET', scopes: fullScopes, values: [{ context: 'production', value: RAW.dbUrl }], is_secret: true },
      { key: 'BRANCH_ONLY', scopes: fullScopes, values: [{ context: 'branch', value: TOKEN }] },
    ] });
    const ctx = testCtx({ exec: ex.run, state: linkedState() });
    expect(await env.listNames(ctx, 'production')).toEqual(['PUBLIC', 'SECRET']);
    expect(await env.listNames(ctx, 'preview')).toEqual(['PUBLIC']);
  });

  it('creates secret values via HTTP with separate preview and production contexts', async () => {
    const h = http([['POST', `${NETLIFY_API}/accounts/account_1/env`, () => ({ json: [] })]]);
    const ex = cli(); const ctx = testCtx({ exec: ex.run, http: h.http, tokens, state: linkedState() });
    await env.set(ctx, 'DATABASE_URL', new Secret('database', RAW.dbUrl), ['preview', 'production'], { sensitive: true });
    expect(h.calls.find(c => c.method === 'POST')!.body).toEqual([{ key: 'DATABASE_URL', is_secret: true, scopes: ['builds', 'functions', 'runtime'], values: [{ context: 'deploy-preview', value: RAW.dbUrl }, { context: 'production', value: RAW.dbUrl }] }]);
    expect(JSON.stringify(ex.calls)).not.toContain(RAW.dbUrl); expect(JSON.stringify(ctx.state.get())).not.toContain(RAW.dbUrl);
  });

  it('omits ordinary-value scopes to use Free-plan defaults', async () => {
    const h = http([['POST', `${NETLIFY_API}/accounts/account_1/env`, () => ({ json: [] })]]);
    const ctx = testCtx({ exec: cli().run, http: h.http, tokens, state: linkedState() });
    await env.set(ctx, 'NEXT_PUBLIC_API_URL', 'https://example.test', ['preview', 'production'], { sensitive: false });
    expect(h.calls.find(c => c.method === 'POST')!.body).toEqual([{ key: 'NEXT_PUBLIC_API_URL', is_secret: false,
      values: [{ context: 'deploy-preview', value: 'https://example.test' }, { context: 'production', value: 'https://example.test' }] }]);
  });

  it('PATCHes only requested existing values without replacing unrelated contexts or scopes', async () => {
    const h = http([['PATCH', `${NETLIFY_API}/accounts/account_1/env/DATABASE_URL`, () => ({ json: {} })]]);
    const ex = cli({ getEnvVars: [{ key: 'DATABASE_URL', is_secret: true, scopes: ['builds', 'functions', 'runtime'], values: [{ context: 'production' }, { context: 'branch', context_parameter: 'special', value: TOKEN }] }] });
    const ctx = testCtx({ exec: ex.run, http: h.http, tokens, state: linkedState() });
    await env.set(ctx, 'DATABASE_URL', new Secret('db', RAW.dbUrl), ['production'], { sensitive: true });
    const writes = h.calls.filter(c => c.method !== 'GET'); expect(writes).toHaveLength(1);
    expect(writes[0]!.method).toBe('PATCH'); expect(writes[0]!.body).toEqual({ context: 'production', value: RAW.dbUrl });
  });

  it('refuses secret-policy changes and readable development context before writing', async () => {
    const h = http(); const ex = cli({ getEnvVars: [{ key: 'DATABASE_URL', scopes: fullScopes, values: [{ context: 'all' }], is_secret: false }] });
    const ctx = testCtx({ exec: ex.run, http: h.http, tokens, state: linkedState() });
    await expect(env.set(ctx, 'DATABASE_URL', new Secret('db', RAW.dbUrl), ['production'], { sensitive: true })).rejects.toThrow('different secret policy');
    await expect(env.set(ctx, 'OTHER', new Secret('db', RAW.dbUrl), ['development'], { sensitive: true })).rejects.toThrow('readable');
    expect(h.calls.every(c => c.method === 'GET')).toBe(true);
  });

  it('does not widen restricted existing scopes', async () => {
    const ex = cli({ getEnvVars: [{ key: 'DATABASE_URL', scopes: ['functions'], values: [{ context: 'production' }], is_secret: true }] });
    expect(await env.canSet!(testCtx({ exec: ex.run, http: http().http, tokens, state: linkedState() }), 'DATABASE_URL', ['production'])).toContain('narrower scopes');
  });
});

describe('Netlify deployment and owned URLs', () => {
  it.each(['production', 'preview'] as const)('runs an explicit %s CLI build/deploy and verifies API ownership', async target => {
    const ex = cli({ getSiteDeploy: target === 'production' ? DEPLOY : { ...DEPLOY, context: 'deploy-preview', draft: true } });
    const ctx = testCtx({ exec: ex.run, http: http().http, tokens, state: linkedState() });
    const result = await deploy.deploy(ctx, target);
    expect(result.url).toBe(target === 'production' ? SITE_RAW.ssl_url : DEPLOY.deploy_ssl_url);
    const call = ex.calls.find(c => c.args[0] === 'deploy')!;
    expect(call.args).toEqual(['deploy', '--site', SITE, '--context', target === 'production' ? 'production' : 'deploy-preview', '--json', ...(target === 'production' ? ['--prod'] : [])]);
    expect(JSON.stringify(call)).not.toContain(TOKEN); expect(call.args).not.toContain('--no-build');
    if (target === 'preview') expect(ctx.state.resource('netlify.previewDeployId')).toBe('deploy_1');
  });

  it('does not deploy on paid/unknown teams', async () => {
    const ex = cli({ getAccount: { ...ACCOUNT, type_name: 'Pro' } });
    const ctx = testCtx({ exec: ex.run, http: http().http, tokens, state: linkedState() });
    await expect(deploy.deploy(ctx, 'production')).rejects.toThrow('potentially billable');
    expect(ex.calls.some(c => c.args[0] === 'deploy')).toBe(false);
  });

  it('refuses a response for another site or an unready deployment', async () => {
    for (const row of [{ ...DEPLOY, site_id: OTHER }, { ...DEPLOY, state: 'building' }]) {
      const ctx = testCtx({ exec: cli({ getSiteDeploy: row }).run, state: linkedState() });
      await expect(url.get(ctx, 'production')).rejects.toThrow('ready deployment owned');
    }
  });

  it('does not return a production deployment as a preview', async () => {
    const state = linkedState(); state.resources['netlify.previewDeployId'] = 'deploy_1';
    expect(await url.get(testCtx({ exec: cli().run, state }), 'preview')).toBeNull();
  });

  it('does not probe config.domain, undeployed sites, malformed URL credentials or arbitrary hosts', async () => {
    const ctx = testCtx({ exec: cli().run, state: linkedState(), config: { domain: 'other.example.com' } });
    expect(await url.get(ctx, 'production')).toBe(SITE_RAW.ssl_url);
    expect(await url.get(testCtx({ exec: cli({ getSite: { ...SITE_RAW, published_deploy: null } }).run, state: linkedState() }), 'production')).toBeNull();
    for (const candidate of ['https://evil.example', 'http://sample.netlify.app', 'https://user:pass@sample.netlify.app', 'https://sample.netlify.app/?secret=1']) expect(publicOrigin(candidate)).toBeNull();
    expect(await url.previewPatterns!(ctx)).toEqual([]);
  });
});
