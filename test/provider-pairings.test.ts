/** Actual adapter capabilities composed through the shared links; HTTP/CLI are entirely mocked. */
import { beforeEach, describe, expect, it } from 'vitest';
import { ADAPTERS, GUIDED } from '../src/adapters/index.js';
import { buildPlan, planView } from '../src/core/plan.js';
import { applyPlan } from '../src/core/runner.js';
import { Secret, _resetSecretRegistry } from '../src/core/secret.js';
import { accountsLink } from '../src/links/accounts.js';
import { projectsLink } from '../src/links/projects.js';
import { envLink } from '../src/links/env.js';
import { envParityCheck } from '../src/checks/env-parity.js';
import { mockExec, mockHttp, testCtx } from './helpers.js';
import type { HttpRequest } from '../src/core/types.js';

const SITE = '11111111-2222-3333-4444-555555555555';
const NETLIFY = 'https://api.netlify.com/api/v1';
const NEON = 'https://console.neon.tech/api/v2';
const SUPA = 'https://api.supabase.com/v1';
const REF = 'abcdefghijklmnopqrst';
const HOST = 'ep-pairing.us-east-2.aws.neon.tech';
const PASSWORD = 'synthetic-pairing-password';
const DIRECT = `postgresql://app_owner:${PASSWORD}@${HOST}/app?sslmode=require`;
const POOL = DIRECT.replace(HOST, HOST.replace('.', '-pooler.'));
const SERVICE = 'sb_secret_mock-pairing-service-value';
const token = 'synthetic-provider-token';
const site = { id: SITE, name: 'pairing', account_id: 'netlify-free', account_slug: 'free-team', ssl_url: null };
const account = { id: 'netlify-free', name: 'Free Team', slug: 'free-team', type_name: 'Free', capabilities: { sites: { included: 500, used: 1 } } };
type EnvRow = { key: string; scopes: string[]; is_secret: boolean; values: { context: string; value: string }[] };
type VercelRow = { id: string; key: string; target: string[]; type: string; value: string };

function fixture(hosting: 'vercel' | 'netlify', db: 'neon' | 'supabase') {
  const rows: EnvRow[] = [];
  const vrows: VercelRow[] = [];
  let refuseProduction = false;
  const ex = mockExec([
    ['vercel whoami', { code: 1 }],
    ['netlify api', (c) => {
      const operation = c.args[1];
      const value = operation === 'getCurrentUser' ? { id: 'netlify-user' }
        : operation === 'getSite' ? site : operation === 'getAccount' ? account
        : operation === 'getEnvVars' ? rows : undefined;
      if (value === undefined) throw new Error(`Unexpected mocked operation ${operation}`);
      return { stdout: JSON.stringify(value) };
    }],
  ]);
  const h = mockHttp([
    ['GET', `${NETLIFY}/user`, () => ({ json: { id: 'netlify-user' } })],
    ['POST', `${NETLIFY}/accounts/netlify-free/env`, c => {
      const values = c.body as EnvRow[];
      if (refuseProduction && values.some(v => v.values.some(x => x.context === 'production'))) return { status: 403, json: { error: PASSWORD } };
      rows.push(...values.map(v => ({ ...v, scopes: v.scopes ?? ['builds', 'functions', 'runtime', 'post_processing'] }))); return { status: 201, json: values };
    }],
    ['PATCH', new RegExp(`${NETLIFY}/accounts/netlify-free/env/`), c => {
      const value = c.body as { context: string; value: string };
      if (refuseProduction && value.context === 'production') return { status: 403, json: { error: PASSWORD } };
      const key = new URL(c.url).pathname.split('/').at(-1)!;
      const row = rows.find(r => r.key === key)!;
      row.values = [...row.values.filter(v => v.context !== value.context), value];
      return { json: row };
    }],
    ['GET', 'https://api.vercel.com/v2/user', () => ({ json: { user: { id: 'vercel-user', username: 'mock-user' } } })],
    ['GET', 'https://api.vercel.com/v9/projects/prj_pairing', () => ({ json: { id: 'prj_pairing', name: 'pairing', accountId: 'team_pairing' } })],
    ['GET', 'https://api.vercel.com/v10/projects/prj_pairing/env', () => ({ json: { envs: vrows } })],
    ['POST', 'https://api.vercel.com/v10/projects/prj_pairing/env', c => {
      vrows.push({ id: `env-${vrows.length}`, ...c.body as Omit<VercelRow, 'id'> }); return { json: {} };
    }],
    ['GET', `${NEON}/auth`, () => ({ json: { account_id: 'org-pairing', auth_method: 'api_key_org' } })],
    ['GET', `${NEON}/projects/quiet-pairing-123`, () => ({ json: { project: { id: 'quiet-pairing-123', name: 'pairing', org_id: 'org-pairing' } } })],
    ['GET', `${NEON}/projects/quiet-pairing-123/branches/br-pairing`, () => ({ json: { branch: { id: 'br-pairing', project_id: 'quiet-pairing-123', current_state: 'ready' } } })],
    ['GET', `${NEON}/projects/quiet-pairing-123/branches/br-pairing/databases`, () => ({ json: { databases: [{ branch_id: 'br-pairing', name: 'app' }] } })],
    ['GET', `${NEON}/projects/quiet-pairing-123/branches/br-pairing/roles`, () => ({ json: { roles: [{ branch_id: 'br-pairing', name: 'app_owner', authentication_method: 'password' }] } })],
    ['GET', `${NEON}/projects/quiet-pairing-123/endpoints`, () => ({ json: { endpoints: [{ id: 'ep-pairing', project_id: 'quiet-pairing-123', branch_id: 'br-pairing', host: HOST, type: 'read_write', disabled: false }] } })],
    ['GET', `${NEON}/projects/quiet-pairing-123/connection_uri`, c => ({ json: { uri: new URL(c.url).searchParams.get('pooled') === 'true' ? POOL : DIRECT } })],
    ['GET', `${SUPA}/profile`, () => ({ json: { username: 'mock-user' } })],
    ['GET', `${SUPA}/projects`, () => ({ json: [{ id: REF, name: 'pairing', organization_slug: 'supa-free', status: 'ACTIVE_HEALTHY' }] })],
    ['GET', `${SUPA}/projects/${REF}`, () => ({ json: { id: REF, name: 'pairing', status: 'ACTIVE_HEALTHY' } })],
    ['GET', `${SUPA}/projects/${REF}/api-keys`, () => ({ json: [{ name: 'default', type: 'publishable', api_key: 'sb_publishable_mock-value' }, { name: 'default', type: 'secret', api_key: SERVICE }] })],
  ]);
  const raw: HttpRequest[] = [];
  const names = db === 'neon' ? ['DATABASE_URL', 'DIRECT_URL'] : ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY'];
  const ctx = testCtx({
    cwd: '/mock/pairing', adapters: ADAPTERS, exec: ex.run,
    http: r => { raw.push(r); return h.http(r); },
    tokens: { NETLIFY_AUTH_TOKEN: token, VERCEL_TOKEN: token, NEON_API_KEY: token, SUPABASE_ACCESS_TOKEN: token },
    config: { stack: { hosting, db }, projects: { hosting: hosting === 'netlify' ? SITE : 'prj_pairing', db: db === 'neon' ? 'quiet-pairing-123' : REF }, ...(db === 'neon' ? { neon: { branchId: 'br-pairing', database: 'app', role: 'app_owner' } } : {}) },
    detect: { envRefs: names.map(name => ({ name, files: ['src/db.ts'], clientExposed: name.startsWith('NEXT_PUBLIC_') })) },
  });
  return { ctx, ex, h, rows, vrows, raw, names, refuseProduction: (v: boolean) => { refuseProduction = v; } };
}
const plan = (ctx: Parameters<typeof buildPlan>[0]) => buildPlan(ctx, [accountsLink, projectsLink, envLink], { unmappedEnv: [], warnings: [] });
const options = (id: string) => ({ approvedPlanId: id, yes: true, confirmLive: false, confirmDns: false });
beforeEach(() => _resetSecretRegistry());

describe('cross-provider env wiring with actual adapters', () => {
  it.each([['netlify', 'neon'], ['vercel', 'neon'], ['netlify', 'supabase']] as const)('%s + %s plans without writes, applies with explicit targets and converges', async (hosting, db) => {
    const f = fixture(hosting, db);
    const p = await plan(f.ctx);
    expect(p.handoffs).toEqual([]);
    expect(p.steps.filter(s => s.risk.writes).map(s => s.id)).toEqual(['env:preview', 'env:production']);
    expect(f.raw.every(r => !r.method || r.method === 'GET')).toBe(true);
    if (db === 'neon') expect(f.h.calls.some(c => c.url.includes('connection_uri'))).toBe(false);
    const result = await applyPlan(f.ctx, p, new Map(), options(p.id));
    expect(result.map(r => [r.id, r.status])).toEqual(p.steps.map(s => [s.id, 'done']));
    expect((await envParityCheck.run(f.ctx)).status).toBe('pass');
    expect((await plan(f.ctx)).steps.filter(s => s.risk.writes)).toEqual([]);
    const printable = JSON.stringify([planView(p), result, f.ctx.logs, f.ctx.state.get(), f.ex.calls.map(c => [c.args, c.opts?.env])]);
    for (const secret of [PASSWORD, token, SERVICE]) expect(printable).not.toContain(secret);
    if (hosting === 'netlify') {
      for (const row of f.rows) expect(row.values.map(v => v.context).sort()).toEqual(['deploy-preview', 'production']);
      expect(f.ex.calls.every(c => !['set', 'import'].some(a => c.args.includes(a)))).toBe(true);
      const bodies = f.raw.filter(r => r.method === 'POST').map(r => r.body as { key: string; values: { value: unknown }[] }[]).flat();
      expect(bodies.find(r => r.key === (db === 'neon' ? 'DATABASE_URL' : 'SUPABASE_SERVICE_ROLE_KEY'))!.values[0]!.value).toBeInstanceOf(Secret);
    } else {
      expect(f.vrows).toHaveLength(4);
      for (const row of f.vrows) expect(row.type).toBe('sensitive');
      expect(f.vrows.find(r => r.key === 'DATABASE_URL')!.value).toBe(POOL);
      expect(f.vrows.find(r => r.key === 'DIRECT_URL')!.value).toBe(DIRECT);
    }
  });

  it('resumes a rejected production write without repeating completed preview writes', async () => {
    const f = fixture('netlify', 'neon');
    f.refuseProduction(true);
    const p = await plan(f.ctx);
    const failed = await applyPlan(f.ctx, p, new Map(), options(p.id));
    expect(failed.at(-1)).toMatchObject({ id: 'env:production', status: 'failed' });
    expect(f.rows.every(r => r.values.every(v => v.context === 'deploy-preview'))).toBe(true);
    f.refuseProduction(false);
    const count = f.h.calls.filter(c => c.method === 'POST').length;
    const fresh = await plan(f.ctx);
    expect(fresh.steps.some(s => s.id === 'env:preview')).toBe(false);
    const done = await applyPlan(f.ctx, fresh, new Map(), options(fresh.id));
    expect(done.at(-1)).toMatchObject({ id: 'env:production', status: 'done' });
    expect(f.h.calls.filter(c => c.method === 'POST')).toHaveLength(count);
    expect(JSON.stringify([failed, done, f.ctx.state.get()])).not.toContain(PASSWORD);
  });

  it('promotes providers without duplicate guided entries or claiming Neon Auth', () => {
    for (const id of ['neon', 'netlify']) {
      expect(ADAPTERS.filter(a => a.id === id && a.automated)).toHaveLength(1);
      expect(GUIDED.some(a => a.id === id)).toBe(false);
    }
    expect(ADAPTERS.find(a => a.id === 'neon')!.axes).toEqual(['db']);
  });
});
