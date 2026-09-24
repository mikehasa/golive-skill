import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectFixture, mockExec, mockHttp, testCtx } from '../helpers.js';
import { createHttp } from '../../src/core/http.js';
import { credentialsPath } from '../../src/core/credentials.js';
import { Secret, _resetSecretRegistry, vaultGet, vaultPut } from '../../src/core/secret.js';
import { emptyState } from '../../src/core/state.js';
import { pooledUrl, sessionUrl, supabaseAdapter, supabaseAuthedProbe, supabaseRestProbe, supabaseTiming, SupabaseError, usesPrisma } from '../../src/adapters/supabase.js';
import type { Capabilities, Ctx, Http, HttpRequest, ShipState, StepContext } from '../../src/core/types.js';

const API = 'https://api.supabase.com/v1';
const REF = 'abcdefghijklmnopqrst';
const REF2 = 'zyxwvutsrqponmlkjihg';
const TOKEN = 'sbp' + '_0123456789abcdef0123456789abcdef01234567';
const SECRET_KEY = 'sb_secret_SUPERSECRETvalue1234567890';
const PUB_KEY = 'sb_publishable_PUBLICvalue1234567890';
// Unsigned, deliberately invalid JWT fixtures; no provider account or signing key is involved.
const unsignedFixtureJwt = (role: string) => [
  Buffer.from(JSON.stringify({ alg: 'HS256' })).toString('base64url'),
  Buffer.from(JSON.stringify({ role })).toString('base64url'),
  Buffer.from('synthetic-signature').toString('base64url'),
].join('.');
const SERVICE_ROLE = unsignedFixtureJwt('service_role');
const ANON = unsignedFixtureJwt('anon');
const JWT_SECRET = 'jwt-secret-should-never-leak-1234567890';
const GOOGLE_SECRET = 'google-oauth-secret-never-leak-123456';

const caps = supabaseAdapter.capabilities as Capabilities;
const withRef = (ref = REF): ShipState => ({ ...emptyState(), resources: { 'supabase.ref': ref } });

beforeEach(() => {
  _resetSecretRegistry();
  supabaseTiming.pollMs = 0;
  supabaseTiming.timeoutMs = 5 * 60_000;
  supabaseTiming.createTimeoutMs = 15 * 60_000;
});

const tempDirs: string[] = [];
const tempDir = (): string => { const d = mkdtempSync(join(tmpdir(), 'golive-sb-')); tempDirs.push(d); return d; };
afterEach(() => { for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** What the runner hands a step's run(): a Ctx plus the remember* writers. */
function asStep<C extends Ctx>(ctx: C): C & StepContext {
  return Object.assign(ctx, {
    remember: (k: string, v: string) => ctx.state.save((s) => void (s.resources[k] = v)),
    rememberSecret: () => undefined,
    rememberValue: () => undefined,
  });
}

function expectNoLeak(values: string[], haystacks: unknown[]): void {
  for (const h of haystacks) {
    const s = typeof h === 'string' ? h : JSON.stringify(h);
    for (const v of values) expect(s).not.toContain(v);
  }
}

/** Token instructions point at the credentials file and never at an `export` in the human's terminal. */
function expectSafeTokenHelp(text: string): void {
  expect(text).toContain(credentialsPath());
  expect(text).toContain('SUPABASE_ACCESS_TOKEN=<value>');
  expect(text).toMatch(/Never paste the value into this chat/);
  expect(text).toMatch(/dashboard\/account\/tokens/);
  expect(text).not.toMatch(/export SUPABASE_ACCESS_TOKEN=/);
  expect(text).not.toMatch(/in your own terminal \(never paste/);
  expect(text).not.toMatch(/read -s/);
}

/** Wrap an Http to record the raw requests (idempotent / timeoutMs aren't in HttpCall). */
function recordRaw(http: Http): { http: Http; raw: HttpRequest[] } {
  const raw: HttpRequest[] = [];
  return { raw, http: (req) => (raw.push(req), http(req)) };
}

async function errorOf(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (e) {
    return e as Error;
  }
  throw new Error('expected rejection');
}

// ── auth ────────────────────────────────────────────────────────────────────────────────────────

describe('supabase auth', () => {
  it('accepts a valid SUPABASE_ACCESS_TOKEN via GET /v1/profile (token only in the header)', async () => {
    const { http, calls } = mockHttp([['GET', `${API}/profile`, () => ({ json: { username: 'alice', gotrue_id: 'x' } })]]);
    const ex = mockExec([]);
    const ctx = testCtx({ http, exec: ex.run, tokens: { SUPABASE_ACCESS_TOKEN: TOKEN } });
    const st = await supabaseAdapter.auth(ctx);
    expect(st).toEqual({ ok: true, via: 'SUPABASE_ACCESS_TOKEN (alice)' });
    expect(calls[0]!.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(ex.calls).toHaveLength(0);
    expectNoLeak([TOKEN], [st, ctx.logs]);
  });

  it('reports a rejected token with a fix, without the token', async () => {
    const { http } = mockHttp([['GET', `${API}/profile`, () => ({ status: 401, json: { message: 'Unauthorized' } })]]);
    const ctx = testCtx({ http, tokens: { SUPABASE_ACCESS_TOKEN: TOKEN } });
    const st = await supabaseAdapter.auth(ctx);
    expect(st.ok).toBe(false);
    expect(st.howToFix).toMatch(/invalid or expired/);
    expectSafeTokenHelp(st.howToFix!);
    expect(st.howToFix).toMatch(/remove the SUPABASE_ACCESS_TOKEN line/);
    expectNoLeak([TOKEN], [st]);
  });

  it('accepts project-scoped access despite /profile403 only for an explicitly selected visible project', async () => {
    const { http, calls } = mockHttp([
      ['GET', `${API}/profile`, () => ({ status: 403, json: { message: 'This endpoint requires a user-scoped token', token: TOKEN } })],
      ['GET', `${API}/projects`, () => ({ json: [{ id: REF, name: 'repo', status: 'ACTIVE_HEALTHY' }] })],
    ]);
    const ex = mockExec([]);
    for (const selection of [{ state: withRef() }, { config: { stack: { db: 'supabase', auth: 'supabase' }, projects: { db: REF } } }]) {
      const ctx = testCtx({ http, exec: ex.run, tokens: { SUPABASE_ACCESS_TOKEN: TOKEN }, ...selection });
      const st = await supabaseAdapter.auth(ctx);
      expect(st.ok).toBe(true);
      expect(st.via).toMatch(/project-scoped access verified/);
      expect(st.via).toMatch(/each operation checks its own permissions; organization\/creation access not verified/);
      expectNoLeak([TOKEN], [st, ctx.logs]);
    }
    expect(calls.every((c) => c.method === 'GET')).toBe(true);
    expect(ex.calls).toHaveLength(0);
  });

  it('project-list success cannot authorize creation or silently adopt a same-named project', async () => {
    const { http, calls } = mockHttp([
      ['GET', `${API}/profile`, () => ({ status: 403 })],
      ['GET', `${API}/projects`, () => ({ json: [{ id: REF, name: 'repo' }] })],
      ['GET', `${API}/organizations`, () => ({ json: [] })],
    ]);
    const st = await supabaseAdapter.auth(testCtx({ http, tokens: { SUPABASE_ACCESS_TOKEN: TOKEN }, config: { stack: { db: 'supabase' } } }));
    expect(st.ok).toBe(false);
    expect(st.howToFix).toMatch(/no existing project is explicitly selected/);
    expect(st.howToFix).toMatch(/organization\/account management/);
    expect(st.howToFix).toMatch(/project-scoped Full access does not grant that/);
    expect(st.howToFix).not.toMatch(/invalid|classic/);
    expectSafeTokenHelp(st.howToFix!);
    expect(calls.map((c) => c.method)).toEqual(['GET', 'GET', 'GET']);
  });

  it('accepts organization-scoped read access for a new app only after verifying the sole Free destination', async () => {
    const { http, calls } = mockHttp([
      ['GET', `${API}/profile`, () => ({ status: 403 })],
      ['GET', `${API}/projects`, () => ({ json: [] })],
      ['GET', `${API}/organizations`, () => ({ json: [{ slug: 'acme', name: 'Acme' }] })],
      ['GET', `${API}/organizations/acme`, () => ({ json: { plan: 'free' } })],
    ]);
    const ctx = testCtx({ http, tokens: { SUPABASE_ACCESS_TOKEN: TOKEN }, config: { stack: { db: 'supabase', auth: 'supabase' } } });
    const st = await supabaseAdapter.auth(ctx);
    expect(st.ok).toBe(true);
    expect(st.via).toMatch(/organization-scoped read access verified for Free organization acme/);
    expect(st.via).toMatch(/creation write permission unverified/);
    expect(calls).toHaveLength(4);
    expect(calls.every((c) => c.method === 'GET')).toBe(true);
    expect(ctx.state.resource('supabase.ref')).toBeUndefined();
    expectNoLeak([TOKEN], [st, ctx.logs]);
  });

  it.each([
    { listStatus: 403, detailStatus: 200, detail: { plan: 'free' } },
    { listStatus: 200, detailStatus: 403, detail: { message: TOKEN } },
    { listStatus: 200, detailStatus: 200, detail: { plan: 'pro' } },
    { listStatus: 200, detailStatus: 200, detail: {} },
  ])('does not approve an unverified Free organization for a scoped token', async ({ listStatus, detailStatus, detail }) => {
    const { http, calls } = mockHttp([
      ['GET', `${API}/profile`, () => ({ status: 403 })],
      ['GET', `${API}/projects`, () => ({ json: [] })],
      ['GET', `${API}/organizations`, () => ({ status: listStatus, json: [{ slug: 'acme' }] })],
      ['GET', `${API}/organizations/acme`, () => ({ status: detailStatus, json: detail })],
    ]);
    const st = await supabaseAdapter.auth(testCtx({ http, tokens: { SUPABASE_ACCESS_TOKEN: TOKEN }, config: { stack: { db: 'supabase' } } }));
    expect(st.ok).toBe(false);
    expect(st.howToFix).toMatch(/could not verify one eligible Free organization/);
    expect(st.howToFix).toMatch(/Organizations Read and Organization Settings Read/);
    expect(calls.every((c) => c.method === 'GET')).toBe(true);
    expectNoLeak([TOKEN], [st]);
  });

  it.each([{}, [{ slug: 'acme' }, { slug: 'other' }]])('blocks malformed or ambiguous organization discovery', async (organizations) => {
    const { http, calls } = mockHttp([
      ['GET', `${API}/profile`, () => ({ status: 403 })],
      ['GET', `${API}/projects`, () => ({ json: [] })],
      ['GET', `${API}/organizations`, () => ({ json: organizations })],
      ['GET', `${API}/organizations/acme`, () => ({ json: { plan: 'free' } })],
      ['GET', `${API}/organizations/other`, () => ({ json: { plan: 'free' } })],
    ]);
    const st = await supabaseAdapter.auth(testCtx({ http, tokens: { SUPABASE_ACCESS_TOKEN: TOKEN }, config: { stack: { db: 'supabase' } } }));
    expect(st.ok).toBe(false);
    expect(st.howToFix).toMatch(/could not verify one eligible Free organization/);
    expect(calls.every((c) => c.method === 'GET')).toBe(true);
  });

  it('rejects a selected project outside the token scope without using another visible project', async () => {
    const { http } = mockHttp([
      ['GET', `${API}/profile`, () => ({ status: 403 })],
      ['GET', `${API}/projects`, () => ({ json: [{ id: REF2, name: 'other' }] })],
    ]);
    const st = await supabaseAdapter.auth(testCtx({ http, tokens: { SUPABASE_ACCESS_TOKEN: TOKEN }, state: withRef() }));
    expect(st.ok).toBe(false);
    expect(st.howToFix).toContain(`project ${REF} is not visible`);
  });

  it('resolves an explicit project name but rejects missing or ambiguous names with scoped tokens', async () => {
    for (const projects of [[{ id: REF, name: 'chosen' }], [], [{ id: REF, name: 'chosen' }, { id: REF2, name: 'chosen' }]]) {
      const { http } = mockHttp([
        ['GET', `${API}/profile`, () => ({ status: 403 })],
        ['GET', `${API}/projects`, () => ({ json: projects })],
      ]);
      const st = await supabaseAdapter.auth(testCtx({ http, tokens: { SUPABASE_ACCESS_TOKEN: TOKEN }, config: { projects: { db: 'chosen' } } }));
      expect(st.ok).toBe(projects.length === 1);
      if (!st.ok) expect(st.howToFix).toMatch(/missing or ambiguous/);
    }
  });

  it.each([401, 403, 500])('rejects /projects HTTP%s after /profile403 without exposing the response', async (status) => {
    const { http, calls } = mockHttp([
      ['GET', `${API}/profile`, () => ({ status: 403 })],
      ['GET', `${API}/projects`, () => ({ status, json: { message: TOKEN } })],
    ]);
    const st = await supabaseAdapter.auth(testCtx({ http, tokens: { SUPABASE_ACCESS_TOKEN: TOKEN }, state: withRef() }));
    expect(st.ok).toBe(false);
    expect(st.howToFix).toContain(`HTTP ${status}`);
    if (status === 401) expect(st.howToFix).toMatch(/invalid or expired/);
    else expect(st.howToFix).toMatch(/does not mean the token is invalid/);
    expectNoLeak([TOKEN], [st]);
    expect(calls.every((c) => c.method === 'GET')).toBe(true);
  });

  it.each([{}, [null], [{ id: 'bad-ref' }]])('rejects malformed project-list shape after /profile403', async (json) => {
    const { http } = mockHttp([
      ['GET', `${API}/profile`, () => ({ status: 403 })],
      ['GET', `${API}/projects`, () => ({ json })],
    ]);
    const st = await supabaseAdapter.auth(testCtx({ http, tokens: { SUPABASE_ACCESS_TOKEN: TOKEN }, state: withRef() }));
    expect(st.ok).toBe(false);
    expect(st.howToFix).toMatch(/unexpected project-list response/);
  });

  it('falls back to a logged-in supabase CLI', async () => {
    const ex = mockExec([['supabase orgs list -o json', { stdout: '[{"id":"o","name":"Acme"}]' }]]);
    const st = await supabaseAdapter.auth(testCtx({ exec: ex.run }));
    expect(st.ok).toBe(true);
    expect(st.via).toMatch(/supabase CLI/);
    expect(st.via).toMatch(/auth redirect settings, creating a project, the pooled DATABASE_URL and security advisors need a reusable CLI credential or SUPABASE_ACCESS_TOKEN/i);
  });

  // Regression (finding 31): a CLI-only login used to pass doctor even though auth redirects and
  // project creation then failed or were silently dropped from the plan.
  it('CLI login only + auth=supabase: not connected, asks for the token (safely) and says why', async () => {
    const ex = mockExec([['supabase orgs list -o json', { stdout: '[{"id":"acme","name":"Acme"}]' }]]);
    const st = await supabaseAdapter.auth(testCtx({ exec: ex.run, state: withRef(), config: { stack: { db: 'supabase', auth: 'supabase' } } }));
    expect(st.ok).toBe(false);
    expect(st.howToFix).toMatch(/stored credential could not be reused on this installation/);
    expect(st.howToFix).toMatch(/auth redirect settings/);
    expect(st.howToFix).not.toMatch(/creating the Supabase project/); // a project is linked
    expectSafeTokenHelp(st.howToFix!);
  });

  it('CLI login only + db=supabase with nothing linked or adoptable: not connected (creation needs the token)', async () => {
    const ex = mockExec([
      ['supabase orgs list -o json', { stdout: '[{"id":"acme","name":"Acme"}]' }],
      ['supabase projects list -o json', { stdout: JSON.stringify([{ id: REF, name: 'repo', organization_id: 'acme', status: 'INACTIVE' }]) }],
    ]);
    const st = await supabaseAdapter.auth(testCtx({ exec: ex.run, config: { stack: { db: 'supabase' } } }));
    expect(st.ok).toBe(false);
    expect(st.howToFix).toMatch(/creating the Supabase project \(none is linked and no project named "repo" can be adopted\)/);
    expectSafeTokenHelp(st.howToFix!);
  });

  it('CLI login only + db=supabase: ok when a project is linked or a same-named one can be adopted', async () => {
    const linked = mockExec([['supabase orgs list -o json', { stdout: '[{"id":"acme"}]' }]]);
    expect((await supabaseAdapter.auth(testCtx({ exec: linked.run, state: withRef(), config: { stack: { db: 'supabase' } } }))).ok).toBe(true);
    const sameName = mockExec([
      ['supabase orgs list -o json', { stdout: '[{"id":"acme"}]' }],
      ['supabase projects list -o json', { stdout: JSON.stringify([{ id: REF, name: 'repo', organization_id: 'acme', status: 'ACTIVE_HEALTHY' }]) }],
    ]);
    expect((await supabaseAdapter.auth(testCtx({ exec: sameName.run, config: { stack: { db: 'supabase' } } }))).ok).toBe(true);
    expect(sameName.calls.filter((c) => c.args.join(' ') === 'orgs list -o json')).toHaveLength(1); // memoized per run
  });

  it('never throws when not logged in; tells the human what to run', async () => {
    const notLogged = mockExec([['supabase orgs list', { code: 1, stderr: 'Access token not provided. Supply an access token by running supabase login' }]]);
    const st = await supabaseAdapter.auth(testCtx({ exec: notLogged.run }));
    expect(st.ok).toBe(false);
    expect(st.howToFix).toMatch(/supabase login/);
    expect(st.howToFix).toMatch(/dashboard\/account\/tokens/);
    expect(st.howToFix).not.toMatch(/--token/);
    expectSafeTokenHelp(st.howToFix!);

    const missing = await supabaseAdapter.auth(testCtx({ exec: mockExec([]).run })); // CLI not installed: exec throws
    expect(missing.ok).toBe(false);
  });
});

// ── project ─────────────────────────────────────────────────────────────────────────────────────

const PROJECTS = [
  { id: REF, ref: REF, name: 'my-app', organization_slug: 'acme', status: 'ACTIVE_HEALTHY' },
  { id: REF2, ref: REF2, name: 'other', organization_slug: 'acme', status: 'INACTIVE' },
  { id: 'qqqqqqqqqqqqqqqqqqqq', name: 'gone', status: 'REMOVED' },
];

describe('supabase project', () => {
  it('current(): state, then config ref, then supabase/.temp/project-ref, else null', async () => {
    expect(await caps.project.current(testCtx({ state: withRef() }))).toEqual({ id: REF, name: REF });
    expect(await caps.project.current(testCtx({ config: { projects: { db: REF2 } } }))).toEqual({ id: REF2, name: REF2 });

    const dir = tempDir();
    mkdirSync(join(dir, 'supabase', '.temp'), { recursive: true });
    writeFileSync(join(dir, 'supabase', '.temp', 'project-ref'), `${REF}\n`);
    expect(await caps.project.current(testCtx({ cwd: dir }))).toEqual({ id: REF, name: REF });
    expect(await caps.project.current(testCtx({ cwd: tempDir() }))).toBeNull();
  });

  it('current(): enriches the name with a token and resolves a config name', async () => {
    const { http } = mockHttp([
      ['GET', `${API}/projects/${REF}`, () => ({ json: { ref: REF, name: 'my-app' } })],
      ['GET', `${API}/projects`, () => ({ json: PROJECTS })],
    ]);
    const tokens = { SUPABASE_ACCESS_TOKEN: TOKEN };
    expect(await caps.project.current(testCtx({ http, tokens, state: withRef() }))).toEqual({ id: REF, name: 'my-app' });
    expect(await caps.project.current(testCtx({ http, tokens, config: { projects: { db: 'my-app' } } }))).toEqual({ id: REF, name: 'my-app' });
  });

  it('candidates(): REST lists adoptable projects: skips removed and paused ones', async () => {
    const { http } = mockHttp([
      ['GET', `${API}/projects`, () => ({ json: PROJECTS })],
      ['GET', `${API}/organizations`, () => ({ json: [{ slug: 'acme' }] })],
    ]);
    const c = await caps.project.candidates(testCtx({ http, tokens: { SUPABASE_ACCESS_TOKEN: TOKEN } }));
    expect(c).toEqual([{ id: REF, name: 'my-app' }]);
  });

  // Regression (finding 13): a same-named project in a team org (or a paused one) used to be a
  // candidate, so the plan adopted it by name and wired the app to someone else's database.
  it('candidates(): only projects in the org this app belongs to (the only org, else the single free org)', async () => {
    const projects = [
      { ref: REF, name: 'repo', organization_slug: 'team', status: 'ACTIVE_HEALTHY' },
      { ref: REF2, name: 'mine', organization_slug: 'me', status: 'COMING_UP' },
    ];
    const { http } = mockHttp([
      ['GET', `${API}/projects`, () => ({ json: projects })],
      ['GET', `${API}/organizations`, () => ({ json: [{ slug: 'team' }, { slug: 'me' }] })],
      ['GET', `${API}/organizations/team`, () => ({ json: { plan: 'pro' } })],
      ['GET', `${API}/organizations/me`, () => ({ json: { plan: 'free' } })],
    ]);
    expect(await caps.project.candidates(testCtx({ http, tokens: { SUPABASE_ACCESS_TOKEN: TOKEN } }))).toEqual([{ id: REF2, name: 'mine' }]);

    // Several free orgs: golive can't tell which is this app's, so nothing is adoptable by name.
    const two = mockHttp([
      ['GET', `${API}/projects`, () => ({ json: projects })],
      ['GET', `${API}/organizations`, () => ({ json: [{ slug: 'team' }, { slug: 'me' }] })],
      ['GET', /\/organizations\/(team|me)$/, () => ({ json: { plan: 'free' } })],
    ]);
    expect(await caps.project.candidates(testCtx({ http: two.http, tokens: { SUPABASE_ACCESS_TOKEN: TOKEN } }))).toEqual([]);
  });

  it('candidates(): falls back to `supabase projects list -o json` without a token', async () => {
    const ex = mockExec([
      ['supabase projects list -o json', { stdout: JSON.stringify([{ id: REF, name: 'my-app', organization_id: 'acme', status: 'ACTIVE_HEALTHY' }]) }],
      ['supabase orgs list -o json', { stdout: '[{"id":"acme","name":"Acme"}]' }],
    ]);
    expect(await caps.project.candidates(testCtx({ exec: ex.run }))).toEqual([{ id: REF, name: 'my-app' }]);
  });

  it('candidates(): without a token and with several CLI orgs, a project in another org is not adoptable', async () => {
    const ex = mockExec([
      ['supabase projects list -o json', { stdout: JSON.stringify([{ id: REF, name: 'my-app', organization_id: 'team', status: 'ACTIVE_HEALTHY' }]) }],
      ['supabase orgs list -o json', { stdout: '[{"id":"team"},{"id":"me"}]' }],
    ]);
    expect(await caps.project.candidates(testCtx({ exec: ex.run }))).toEqual([]);
  });

  it('candidates(): maps a not-logged-in CLI to an actionable error', async () => {
    const ex = mockExec([['supabase projects list', { code: 1, stderr: 'Access token not provided.' }]]);
    const e = await errorOf(caps.project.candidates(testCtx({ exec: ex.run })));
    expect(e).toBeInstanceOf(SupabaseError);
    expect(e.message).toMatch(/supabase login/);
  });

  it('select(): adopts by name or ref and records it in state', async () => {
    const { http } = mockHttp([['GET', `${API}/projects`, () => ({ json: PROJECTS })]]);
    const ctx = testCtx({ http, tokens: { SUPABASE_ACCESS_TOKEN: TOKEN } });
    expect(await caps.project.select(ctx, 'my-app')).toEqual({ id: REF, name: 'my-app', scope: { kind: 'organization', id: 'acme' } });
    expect(ctx.state.resource('supabase.ref')).toBe(REF);
    await expect(caps.project.select(ctx, 'nope')).rejects.toThrow(/No Supabase project "nope".*my-app/);
  });

  it('select(): refuses a paused project with restore instructions; state is unchanged', async () => {
    const { http } = mockHttp([['GET', `${API}/projects`, () => ({ json: PROJECTS })]]);
    const ctx = testCtx({ http, tokens: { SUPABASE_ACCESS_TOKEN: TOKEN } });
    await expect(caps.project.select(ctx, REF2)).rejects.toThrow(/paused \(status INACTIVE\).*Restore it at https:\/\/supabase.com\/dashboard\/project\/zyxwvutsrqponmlkjihg/);
    expect(ctx.state.resource('supabase.ref')).toBeUndefined();
  });

  it('select(): waits for a COMING_UP project to become healthy before adopting it', async () => {
    let polls = 0;
    const { http } = mockHttp([
      ['GET', `${API}/projects`, () => ({ json: [{ ref: REF, name: 'my-app', organization_slug: 'acme', status: 'COMING_UP' }] })],
      ['GET', `${API}/projects/${REF}`, () => ({ json: { ref: REF, status: ++polls < 3 ? 'COMING_UP' : 'ACTIVE_HEALTHY' } })],
    ]);
    const ctx = testCtx({ http, tokens: { SUPABASE_ACCESS_TOKEN: TOKEN } });
    expect(await caps.project.select(ctx, 'my-app')).toEqual({ id: REF, name: 'my-app', scope: { kind: 'organization', id: 'acme' } });
    expect(polls).toBe(3);
    expect(ctx.state.resource('supabase.ref')).toBe(REF);
  });

  it('select(): refuses an ambiguous name', async () => {
    const dup = [...PROJECTS, { id: 'mmmmmmmmmmmmmmmmmmmm', name: 'my-app', status: 'ACTIVE_HEALTHY' }];
    const { http } = mockHttp([['GET', `${API}/projects`, () => ({ json: dup })]]);
    await expect(caps.project.select(testCtx({ http, tokens: { SUPABASE_ACCESS_TOKEN: TOKEN } }), 'my-app')).rejects.toThrow(/select one by its ref/);
  });
});

describe('supabase project.create', () => {
  const tokens = { SUPABASE_ACCESS_TOKEN: TOKEN };

  it('adopts an existing project with the same name instead of creating', async () => {
    const { http, calls } = mockHttp([
      ['GET', `${API}/projects`, () => ({ json: PROJECTS })],
      ['GET', `${API}/organizations`, () => ({ json: [{ slug: 'acme' }] })],
    ]);
    const ctx = testCtx({ http, tokens });
    expect(await caps.project.create!(ctx, 'my-app')).toEqual({ id: REF, name: 'my-app' });
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
    expect(ctx.state.resource('supabase.ref')).toBe(REF);
  });

  it('creates in the free org with a generated password in the body only, polls until healthy, then yields DB URLs', async () => {
    let polls = 0;
    const { http, calls } = mockHttp([
      ['GET', `${API}/projects`, () => ({ json: [] })],
      ['GET', `${API}/organizations`, () => ({ json: [{ slug: 'acme', name: 'Acme' }] })],
      ['GET', `${API}/organizations/acme`, () => ({ json: { plan: 'free' } })],
      ['POST', `${API}/projects`, (c) => ({ status: 201, json: { ref: REF, id: REF, name: (c.body as { name: string }).name, status: 'COMING_UP' } })],
      ['GET', `${API}/projects/${REF}`, () => ({ json: { ref: REF, status: ++polls < 2 ? 'COMING_UP' : 'ACTIVE_HEALTHY' } })],
      ['GET', `${API}/projects/${REF}/api-keys`, () => ({ json: [{ name: 'default', type: 'publishable', api_key: PUB_KEY }, { name: 'default', type: 'secret', api_key: SECRET_KEY }] })],
      [
        'GET',
        `${API}/projects/${REF}/config/database/pooler`,
        () => ({
          json: [
            { database_type: 'PRIMARY', db_host: `db.${REF}.supabase.co`, connection_string: `postgresql://postgres:[YOUR-PASSWORD]@db.${REF}.supabase.co:6543/postgres` },
            { database_type: 'PRIMARY', db_user: `postgres.${REF}`, db_host: 'aws-0-us-east-1.pooler.supabase.com', db_name: 'postgres', connection_string: `postgresql://postgres.${REF}:[YOUR-PASSWORD]@aws-0-us-east-1.pooler.supabase.com:6543/postgres` },
          ],
        }),
      ],
    ]);
    const ctx = testCtx({ http, tokens });
    const ref = await caps.project.create!(ctx, 'new-app');
    expect(ref).toEqual({ id: REF, name: 'new-app' });
    expect(ctx.state.resource('supabase.ref')).toBe(REF);

    const post = calls.find((c) => c.method === 'POST')!;
    const body = post.body as { name: string; organization_slug: string; db_pass: string; region_selection: unknown };
    expect(body.organization_slug).toBe('acme');
    expect(body.region_selection).toEqual({ type: 'smartGroup', code: 'americas' });
    expect(body.db_pass.length).toBeGreaterThanOrEqual(24);
    const pass = vaultGet(`supabase.dbPass:${REF}`)!;
    expect(pass.reveal()).toBe(body.db_pass);
    expectNoLeak([body.db_pass, TOKEN], [ref, ctx.logs, ctx.state.get()]);

    const out = await caps.outputs.outputs(ctx, 'production');
    expect(out['supabase.url']).toBe(`https://${REF}.supabase.co`);
    expect(out['supabase.publishableKey']).toBe(PUB_KEY);
    const dbUrl = out['db.url'] as Secret;
    expect(dbUrl).toBeInstanceOf(Secret);
    // Transaction mode (6543) for the serverless host; no Prisma in this repo, so no pgbouncer param.
    expect(dbUrl.reveal()).toBe(`postgresql://postgres.${REF}:${body.db_pass}@aws-0-us-east-1.pooler.supabase.com:6543/postgres`);
    expect(ctx.logs.join('\n')).toMatch(/prepare: false/);
    // DIRECT_URL: shared pooler in session mode (IPv4 on every plan), not the IPv6-only db.<ref> host.
    expect((out['db.directUrl'] as Secret).reveal()).toBe(`postgresql://postgres.${REF}:${body.db_pass}@aws-0-us-east-1.pooler.supabase.com:5432/postgres`);
    expect(ctx.logs.join('\n')).not.toMatch(/IPv6/);
    expect(ctx.state.resource('supabase.createdByGolive')).toBe(REF);
    expectNoLeak([body.db_pass, SECRET_KEY], [out, ctx.logs]);
  });

  it('refuses paid orgs (may cost money) without POSTing', async () => {
    const { http, calls } = mockHttp([
      ['GET', `${API}/projects`, () => ({ json: [] })],
      ['GET', `${API}/organizations`, () => ({ json: [{ slug: 'acme' }] })],
      ['GET', `${API}/organizations/acme`, () => ({ json: { plan: 'pro' } })],
    ]);
    await expect(caps.project.create!(testCtx({ http, tokens }), 'new-app')).rejects.toThrow(/cost money/);
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('fails clearly when the project never becomes healthy', async () => {
    supabaseTiming.createTimeoutMs = 0;
    const { http } = mockHttp([
      ['GET', `${API}/projects`, () => ({ json: [] })],
      ['GET', `${API}/organizations`, () => ({ json: [{ slug: 'acme' }] })],
      ['GET', `${API}/organizations/acme`, () => ({ json: { plan: 'free' } })],
      ['POST', `${API}/projects`, () => ({ status: 201, json: { ref: REF, name: 'x' } })],
      ['GET', `${API}/projects/${REF}`, () => ({ json: { status: 'COMING_UP' } })],
    ]);
    const ctx = testCtx({ http, tokens });
    await expect(caps.project.create!(ctx, 'x')).rejects.toThrow(/still starting.*recorded in golive state.*sets a new one/);
    expect(ctx.state.resource('supabase.ref')).toBe(REF);
    expect(ctx.state.resource('supabase.createdByGolive')).toBe(REF);
  });

  // Regression (round 2, finding 10): a just-created project gets a longer wait than an adopted one.
  it('waits longer for a project it just created than supabaseTiming.timeoutMs', async () => {
    supabaseTiming.timeoutMs = 0;
    supabaseTiming.createTimeoutMs = 60_000;
    let polls = 0;
    const { http } = mockHttp([
      ['GET', `${API}/projects`, () => ({ json: [] })],
      ['GET', `${API}/organizations`, () => ({ json: [{ slug: 'acme' }] })],
      ['GET', `${API}/organizations/acme`, () => ({ json: { plan: 'free' } })],
      ['POST', `${API}/projects`, () => ({ status: 201, json: { ref: REF, name: 'x' } })],
      ['GET', `${API}/projects/${REF}`, () => ({ json: { status: ++polls < 4 ? 'COMING_UP' : 'ACTIVE_HEALTHY' } })],
    ]);
    expect(await caps.project.create!(testCtx({ http, tokens }), 'x')).toEqual({ id: REF, name: 'x' });
    expect(polls).toBe(4);
  });

  // Regression (round 2, finding 16): the duplicate guard compared names case-sensitively.
  it('treats a paused or other-org "Demo-App" as the same name as demo-app: refuses, no POST', async () => {
    for (const p of [
      { ref: REF, name: 'Demo-App', organization_slug: 'acme', status: 'INACTIVE' },
      { ref: REF, name: 'Demo-App', organization_slug: 'team', status: 'ACTIVE_HEALTHY' },
    ]) {
      const { http, calls } = mockHttp([
        ['GET', `${API}/projects`, () => ({ json: [p] })],
        ['GET', `${API}/organizations`, () => ({ json: p.organization_slug === 'team' ? [{ slug: 'team' }, { slug: 'acme' }] : [{ slug: 'acme' }] })],
        ['GET', `${API}/organizations/team`, () => ({ json: { plan: 'pro' } })],
        ['GET', `${API}/organizations/acme`, () => ({ json: { plan: 'free' } })],
      ]);
      const ctx = testCtx({ http, tokens });
      const e = await errorOf(caps.project.create!(ctx, 'demo-app'));
      expect(e.message).toMatch(/already exists but golive won't adopt it automatically/);
      expect(calls.some((c) => c.method === 'POST')).toBe(false);
      expect(ctx.state.resource('supabase.ref')).toBeUndefined();
    }
  });

  it('adopts a healthy home-org "Demo-App" for demo-app instead of creating a duplicate', async () => {
    const { http, calls } = mockHttp([
      ['GET', `${API}/projects`, () => ({ json: [{ ref: REF, name: 'Demo-App', organization_slug: 'acme', status: 'ACTIVE_HEALTHY' }] })],
      ['GET', `${API}/organizations`, () => ({ json: [{ slug: 'acme' }] })],
    ]);
    const ctx = testCtx({ http, tokens });
    expect(await caps.project.create!(ctx, 'demo-app')).toEqual({ id: REF, name: 'Demo-App' });
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
    expect(ctx.state.resource('supabase.createdByGolive')).toBeUndefined(); // adopted, not created
  });

  const freeAcme: Parameters<typeof mockHttp>[0] = [
    ['GET', `${API}/organizations`, () => ({ json: [{ slug: 'acme', name: 'Acme' }] })],
    ['GET', `${API}/organizations/acme`, () => ({ json: { plan: 'free' } })],
  ];

  // Regression (finding 13): create() adopted any same-named project in any org and any status.
  it('does not adopt a same-named project in another org, and does not create a duplicate', async () => {
    const { http, calls } = mockHttp([
      ['GET', `${API}/projects`, () => ({ json: [{ ref: REF, name: 'demo-app', organization_slug: 'team', status: 'ACTIVE_HEALTHY' }] })],
      ['GET', `${API}/organizations`, () => ({ json: [{ slug: 'team' }, { slug: 'me' }] })],
      ['GET', `${API}/organizations/team`, () => ({ json: { plan: 'pro' } })],
      ['GET', `${API}/organizations/me`, () => ({ json: { plan: 'free' } })],
    ]);
    const ctx = testCtx({ http, tokens });
    const e = await errorOf(caps.project.create!(ctx, 'demo-app'));
    expect(e.message).toMatch(/already exists but golive won't adopt it automatically/);
    expect(e.message).toMatch(/in organization team, not me/);
    expect(e.message).toMatch(/init --project db=<ref>/);
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
    expect(ctx.state.resource('supabase.ref')).toBeUndefined();
  });

  it('does not adopt a paused same-named project; says to restore it', async () => {
    const { http, calls } = mockHttp([['GET', `${API}/projects`, () => ({ json: [{ ref: REF, name: 'demo-app', organization_slug: 'acme', status: 'INACTIVE' }] })], ...freeAcme]);
    const ctx = testCtx({ http, tokens });
    await expect(caps.project.create!(ctx, 'demo-app')).rejects.toThrow(/paused \(status INACTIVE\); restore it at https:\/\/supabase.com\/dashboard\/project\/abcdefghijklmnopqrst/);
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
    expect(ctx.state.resource('supabase.ref')).toBeUndefined();
  });

  it('adopts a same-named COMING_UP project in the home org only after it is healthy', async () => {
    let polls = 0;
    const { http, calls } = mockHttp([
      ['GET', `${API}/projects`, () => ({ json: [{ ref: REF, name: 'demo-app', organization_slug: 'acme', status: 'COMING_UP' }] })],
      ...freeAcme,
      ['GET', `${API}/projects/${REF}`, () => ({ json: { status: ++polls < 2 ? 'COMING_UP' : 'ACTIVE_HEALTHY' } })],
    ]);
    const ctx = testCtx({ http, tokens });
    expect(await caps.project.create!(ctx, 'demo-app')).toEqual({ id: REF, name: 'demo-app' });
    expect(polls).toBe(2);
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('sends POST /v1/projects as non-idempotent with a longer timeout; the read-only SQL POST is idempotent', async () => {
    const { http: base } = mockHttp([
      ['GET', `${API}/projects`, () => ({ json: [] })],
      ...freeAcme,
      ['POST', `${API}/projects`, () => ({ status: 201, json: { ref: REF, name: 'new-app' } })],
      ['GET', `${API}/projects/${REF}`, () => ({ json: { status: 'ACTIVE_HEALTHY' } })],
      ['GET', `${API}/projects/${REF}/postgrest`, () => ({ json: { db_schema: 'public' } })],
      ['POST', `${API}/projects/${REF}/database/query/read-only`, () => ({ status: 201, json: [] })],
    ]);
    const { http, raw } = recordRaw(base);
    const ctx = testCtx({ http, tokens });
    await caps.project.create!(ctx, 'new-app');
    const create = raw.find((r) => r.method === 'POST' && r.url === `${API}/projects`)!;
    expect(create.idempotent).toBe(false);
    expect(create.timeoutMs).toBeGreaterThanOrEqual(60_000);
    await caps.dbAdmin.tables(ctx);
    expect(raw.find((r) => r.url.endsWith('/database/query/read-only'))!.idempotent).toBe(true);
  });

  // Regression (finding 14): the create POST was re-sent after a 5xx/timeout, making a second project.
  it('POST 502 (but Supabase created it): sends exactly one POST, then adopts the new project with the sent password', async () => {
    let listed: unknown[] = [];
    let posts = 0;
    let sentPass = '';
    const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
      if (method === 'POST' && url === `${API}/projects`) {
        posts++;
        sentPass = (JSON.parse(String(init!.body)) as { db_pass: string }).db_pass;
        listed = [{ ref: REF, name: 'new-app', organization_slug: 'acme', status: 'COMING_UP' }]; // committed server-side
        return json(502, { message: 'Bad Gateway' });
      }
      if (url === `${API}/projects`) return json(200, listed);
      if (url === `${API}/organizations`) return json(200, [{ slug: 'acme' }]);
      if (url === `${API}/organizations/acme`) return json(200, { plan: 'free' });
      if (url === `${API}/projects/${REF}`) return json(200, { ref: REF, status: 'ACTIVE_HEALTHY' });
      return json(404, {});
    }) as typeof fetch;
    const ctx = testCtx({ http: createHttp(fakeFetch), tokens });
    expect(await caps.project.create!(ctx, 'new-app')).toEqual({ id: REF, name: 'new-app' });
    expect(posts).toBe(1);
    expect(ctx.state.resource('supabase.ref')).toBe(REF);
    expect(vaultGet(`supabase.dbPass:${REF}`)!.reveal()).toBe(sentPass);
    expectNoLeak([sentPass, TOKEN], [ctx.logs, ctx.state.get()]);
  });

  it('POST times out and nothing new is listed: fails without retrying, pointing at the dashboard', async () => {
    let posts = 0;
    const { http, calls } = mockHttp([
      ['GET', `${API}/projects`, () => ({ json: [{ ref: REF2, name: 'new-app-old', organization_slug: 'acme', status: 'ACTIVE_HEALTHY' }] })],
      ...freeAcme,
    ]);
    const timeoutHttp: Http = async (req) => {
      if (req.method === 'POST') {
        posts++;
        throw new Error('request to api.supabase.com failed: AbortError: This operation was aborted');
      }
      return http(req);
    };
    const ctx = testCtx({ http: timeoutHttp, tokens });
    const e = await errorOf(caps.project.create!(ctx, 'new-app'));
    expect(e.message).toMatch(/did not complete.*AbortError.*no new project "new-app" is listed in acme.*dashboard\/org\/acme/);
    expect(posts).toBe(1);
    expect(calls.filter((c) => c.url === `${API}/projects`)).toHaveLength(2); // before + after
    expect(ctx.state.resource('supabase.ref')).toBeUndefined();
  });

  it('POST refused with a 4xx: rethrows at once (nothing was created), no re-listing', async () => {
    const { http, calls } = mockHttp([
      ['GET', `${API}/projects`, () => ({ json: [] })],
      ...freeAcme,
      ['POST', `${API}/projects`, () => ({ status: 400, json: { message: 'region not available' } })],
    ]);
    await expect(caps.project.create!(testCtx({ http, tokens }), 'new-app')).rejects.toThrow(/HTTP 400 \(region not available\)/);
    expect(calls.filter((c) => c.url === `${API}/projects` && c.method === 'GET')).toHaveLength(1);
  });

  it('needs a reusable credential (CLI create would put the password on argv)', async () => {
    const ex = mockExec([]);
    await expect(caps.project.create!(testCtx({ exec: ex.run }), 'x')).rejects.toThrow(/reusable Supabase login/);
    expect(ex.calls.map((c) => c.args)).toEqual([['--version']]);
  });
});

// ── outputs ─────────────────────────────────────────────────────────────────────────────────────

describe('supabase outputs', () => {
  const tokens = { SUPABASE_ACCESS_TOKEN: TOKEN };

  it('prefers new sb_ keys, wraps the secret key, omits DB URLs when the password is unknown', async () => {
    const { http, calls } = mockHttp([
      [
        'GET',
        `${API}/projects/${REF}/api-keys`,
        () => ({
          json: [
            { name: 'anon', type: 'legacy', api_key: ANON },
            { name: 'service_role', type: 'legacy', api_key: SERVICE_ROLE },
            { name: 'default', type: 'publishable', api_key: PUB_KEY },
            { name: 'default', type: 'secret', api_key: SECRET_KEY },
          ],
        }),
      ],
    ]);
    const ctx = testCtx({ http, tokens, state: withRef() });
    const out = await caps.outputs.outputs(ctx, 'preview');
    expect(calls[0]!.url).toBe(`${API}/projects/${REF}/api-keys?reveal=true`);
    expect(out['supabase.publishableKey']).toBe(PUB_KEY);
    const sk = out['supabase.secretKey'] as Secret;
    expect(sk).toBeInstanceOf(Secret);
    expect(sk.reveal()).toBe(SECRET_KEY);
    expect(out['db.url']).toBeUndefined();
    expect(out['db.directUrl']).toBeUndefined();
    expectNoLeak([SECRET_KEY, SERVICE_ROLE, TOKEN], [out, ctx.logs]);
  });

  it('falls back to legacy anon/service_role and ignores masked values', async () => {
    const { http } = mockHttp([
      [
        'GET',
        `${API}/projects/${REF}/api-keys`,
        () => ({ json: [{ name: 'default', type: 'secret', api_key: 'sb_secret_abc••••••' }, { name: 'anon', api_key: ANON }, { name: 'service_role', api_key: SERVICE_ROLE }].map((k) => ({ ...k, api_key: k.api_key.replace(/•/g, '*') })) }),
      ],
    ]);
    const out = await caps.outputs.outputs(testCtx({ http, tokens, state: withRef() }), 'production');
    expect(out['supabase.publishableKey']).toBe(ANON);
    expect((out['supabase.secretKey'] as Secret).reveal()).toBe(SERVICE_ROLE);
    expectNoLeak([SERVICE_ROLE], [out]);
  });

  it('URL-encodes a known password into the pooled transaction-mode URL', async () => {
    vaultPut(`supabase.dbPass:${REF}`, new Secret('SUPABASE_DB_PASSWORD', 'p@ss/w:rd#12345'));
    const { http } = mockHttp([
      ['GET', `${API}/projects/${REF}/api-keys`, () => ({ json: [] })],
      ['GET', `${API}/projects/${REF}/config/database/pooler`, () => ({ json: [{ database_type: 'PRIMARY', db_host: 'aws-1-eu-west-1.pooler.supabase.com', connection_string: `postgresql://postgres.${REF}:[YOUR-PASSWORD]@aws-1-eu-west-1.pooler.supabase.com:6543/postgres` }] })],
    ]);
    const ctx = testCtx({ http, tokens, state: withRef() });
    const out = await caps.outputs.outputs(ctx, 'production');
    expect((out['db.url'] as Secret).reveal()).toBe(`postgresql://postgres.${REF}:p%40ss%2Fw%3Ard%2312345@aws-1-eu-west-1.pooler.supabase.com:6543/postgres`);
    expectNoLeak(['p@ss/w:rd#12345', 'p%40ss%2Fw%3Ard%2312345'], [out, ctx.logs]);
  });

  // Regression (finding 12): DATABASE_URL was rewritten to session mode (5432), which exhausts the
  // shared pooler's client limit under serverless concurrency.
  it('pooledUrl(): keeps/forces transaction mode (6543) on the shared pooler; Prisma gets ?pgbouncer=true', () => {
    const shared = { database_type: 'PRIMARY', db_user: `postgres.${REF}`, db_host: 'aws-0-us-east-1.pooler.supabase.com', db_name: 'postgres' };
    const cs = (port: number): string => `postgresql://postgres.${REF}:[YOUR-PASSWORD]@aws-0-us-east-1.pooler.supabase.com:${port}/postgres`;
    expect(pooledUrl([{ ...shared, connection_string: cs(6543) }], 'pw')).toBe(`postgresql://postgres.${REF}:pw@aws-0-us-east-1.pooler.supabase.com:6543/postgres`);
    expect(pooledUrl([{ ...shared, connection_string: cs(5432) }], 'pw')).toBe(`postgresql://postgres.${REF}:pw@aws-0-us-east-1.pooler.supabase.com:6543/postgres`);
    expect(pooledUrl([shared], 'pw')).toBe(`postgresql://postgres.${REF}:pw@aws-0-us-east-1.pooler.supabase.com:6543/postgres`);
    expect(pooledUrl([{ ...shared, connection_string: cs(6543) }], 'pw', { prisma: true })).toBe(`postgresql://postgres.${REF}:pw@aws-0-us-east-1.pooler.supabase.com:6543/postgres?pgbouncer=true`);
    expect(pooledUrl([{ ...shared, connection_string: `${cs(6543)}?sslmode=require` }], 'pw', { prisma: true })).toMatch(/\?sslmode=require&pgbouncer=true$/);
    expect(pooledUrl([{ ...shared, database_type: 'READ_REPLICA' }], 'pw')).toBeUndefined();
  });

  it('outputs(): Prisma repo gets ?pgbouncer=true on DATABASE_URL and no prepare:false warning', async () => {
    vaultPut(`supabase.dbPass:${REF}`, new Secret('SUPABASE_DB_PASSWORD', 'pw12345678'));
    const { http } = mockHttp([
      ['GET', `${API}/projects/${REF}/api-keys`, () => ({ json: [] })],
      ['GET', `${API}/projects/${REF}/config/database/pooler`, () => ({ json: [{ database_type: 'PRIMARY', db_host: 'aws-1-eu-west-1.pooler.supabase.com', connection_string: `postgresql://postgres.${REF}:[YOUR-PASSWORD]@aws-1-eu-west-1.pooler.supabase.com:6543/postgres` }] })],
    ]);
    const ctx = testCtx({ http, tokens, state: withRef(), detect: { configs: { 'prisma/schema.prisma': 'Prisma schema' } } });
    const out = await caps.outputs.outputs(ctx, 'production');
    expect((out['db.url'] as Secret).reveal()).toBe(`postgresql://postgres.${REF}:pw12345678@aws-1-eu-west-1.pooler.supabase.com:6543/postgres?pgbouncer=true`);
    expect(ctx.logs.join('\n')).not.toMatch(/prepare: false/);
    expectNoLeak(['pw12345678'], [ctx.logs]);
  });

  const SHARED_POOLER = `postgresql://postgres.${REF}:[YOUR-PASSWORD]@aws-1-eu-west-1.pooler.supabase.com:6543/postgres`;
  const poolerRoute = (entries: unknown[]): Parameters<typeof mockHttp>[0][number] => ['GET', `${API}/projects/${REF}/config/database/pooler`, () => ({ json: entries })];

  // Regression (round 2, finding 1): DIRECT_URL was always the IPv6-only db.<ref> host.
  it('sessionUrl(): shared pooler in session mode (5432), no pgbouncer param; undefined without a shared-pooler entry', () => {
    const shared = { database_type: 'PRIMARY', db_user: `postgres.${REF}`, db_host: 'aws-0-us-east-1.pooler.supabase.com', db_name: 'postgres' };
    const cs = (port: number, q = ''): string => `postgresql://postgres.${REF}:[YOUR-PASSWORD]@aws-0-us-east-1.pooler.supabase.com:${port}/postgres${q}`;
    const want = `postgresql://postgres.${REF}:p%40w@aws-0-us-east-1.pooler.supabase.com:5432/postgres`;
    expect(sessionUrl([{ ...shared, connection_string: cs(6543) }], 'p@w')).toBe(want);
    expect(sessionUrl([{ ...shared, connection_string: cs(5432) }], 'p@w')).toBe(want);
    expect(sessionUrl([shared], 'p@w')).toBe(want);
    expect(sessionUrl([{ ...shared, connection_string: cs(6543, '?pgbouncer=true') }], 'p@w')).toBe(want);
    expect(sessionUrl([{ ...shared, connection_string: cs(6543, '?pgbouncer=true&sslmode=require') }], 'p@w')).toBe(`${want}?sslmode=require`);
    expect(sessionUrl([{ ...shared, connection_string: cs(6543, '?sslmode=require&pgbouncer=true') }], 'p@w')).toBe(`${want}?sslmode=require`);
    expect(sessionUrl([{ database_type: 'PRIMARY', db_host: `db.${REF}.supabase.co`, connection_string: `postgresql://postgres:[YOUR-PASSWORD]@db.${REF}.supabase.co:6543/postgres` }], 'pw')).toBeUndefined();
    expect(sessionUrl([{ ...shared, database_type: 'READ_REPLICA' }], 'pw')).toBeUndefined();
  });

  it('outputs(): DIRECT_URL falls back to db.<ref> only without a shared-pooler entry, and warns it is IPv6-only', async () => {
    vaultPut(`supabase.dbPass:${REF}`, new Secret('SUPABASE_DB_PASSWORD', 'pw12345678'));
    const { http } = mockHttp([
      ['GET', `${API}/projects/${REF}/api-keys`, () => ({ json: [] })],
      poolerRoute([{ database_type: 'PRIMARY', db_host: `db.${REF}.supabase.co`, connection_string: `postgresql://postgres:[YOUR-PASSWORD]@db.${REF}.supabase.co:6543/postgres` }]),
    ]);
    const ctx = testCtx({ http, tokens, state: withRef() });
    const out = await caps.outputs.outputs(ctx, 'production');
    expect((out['db.directUrl'] as Secret).reveal()).toBe(`postgresql://postgres:pw12345678@db.${REF}.supabase.co:5432/postgres`);
    expect(ctx.logs.join('\n')).toMatch(/IPv6-only.*Vercel builds and functions.*can't reach it.*no shared-pooler entry/);
    expectNoLeak(['pw12345678'], [ctx.logs]);
  });

  it('outputs(): without a token DIRECT_URL is the direct host with an IPv6 warning naming the token', async () => {
    vaultPut(`supabase.dbPass:${REF}`, new Secret('SUPABASE_DB_PASSWORD', 'pw12345678'));
    const ex = mockExec([[`supabase projects api-keys --project-ref ${REF} --reveal -o json`, { stdout: '[]' }]]);
    const ctx = testCtx({ exec: ex.run, state: withRef() });
    const out = await caps.outputs.outputs(ctx, 'production');
    expect((out['db.directUrl'] as Secret).reveal()).toContain(`@db.${REF}.supabase.co:5432/`);
    expect(out['db.url']).toBeUndefined();
    expect(ctx.logs.join('\n')).toMatch(/IPv6-only.*session-pooler URL needs a reusable CLI credential or SUPABASE_ACCESS_TOKEN/);
  });

  // Regression (round 2, finding 11): prisma/schema/ folder layout and root schema.prisma were missed.
  it('usesPrisma(): schema folder, root schema, custom *.prisma path, prisma.config, notes, POSTGRES_PRISMA_URL', () => {
    const d = (over: Parameters<typeof detectFixture>[0]): boolean => usesPrisma(detectFixture(over));
    expect(d({ configs: { 'prisma/schema': 'Prisma schema folder' } })).toBe(true);
    expect(d({ configs: { 'prisma/schema.prisma': 'Prisma schema' } })).toBe(true);
    expect(d({ configs: { 'schema.prisma': 'Prisma schema' } })).toBe(true);
    expect(d({ configs: { 'db/schema.prisma': 'Prisma schema' } })).toBe(true);
    expect(d({ configs: { 'prisma.config.ts': 'Prisma config' } })).toBe(true);
    expect(d({ notes: ['orm: Prisma (@prisma/client)'] })).toBe(true);
    expect(d({ envRefs: [{ name: 'POSTGRES_PRISMA_URL', files: ['a.ts'], clientExposed: false }] })).toBe(true);
    expect(d({ configs: { 'drizzle.config.ts': 'Drizzle config' }, notes: ['uses drizzle'] })).toBe(false);
  });

  it('outputs(): a prisma/schema/ folder repo gets ?pgbouncer=true and no prepare:false warning', async () => {
    vaultPut(`supabase.dbPass:${REF}`, new Secret('SUPABASE_DB_PASSWORD', 'pw12345678'));
    const layouts: Array<Record<string, string>> = [{ 'prisma/schema': 'Prisma schema folder' }, { 'schema.prisma': 'Prisma schema' }];
    for (const configs of layouts) {
      const { http } = mockHttp([['GET', `${API}/projects/${REF}/api-keys`, () => ({ json: [] })], poolerRoute([{ database_type: 'PRIMARY', db_host: 'aws-1-eu-west-1.pooler.supabase.com', connection_string: SHARED_POOLER }])]);
      const ctx = testCtx({ http, tokens, state: withRef(), detect: { configs } });
      const out = await caps.outputs.outputs(ctx, 'production');
      expect((out['db.url'] as Secret).reveal()).toMatch(/:6543\/postgres\?pgbouncer=true$/);
      expect(ctx.logs.join('\n')).not.toMatch(/prepare: false/);
    }
  });

  // Regression (round 2, finding 10): the generated password lived only in the run vault, so a run
  // that stopped after create lost it and the human had to reset the password of a brand-new project.
  describe('lost password of a project golive created', () => {
    const created = (extra: Record<string, string> = {}): ShipState => ({ ...emptyState(), resources: { 'supabase.ref': REF, 'supabase.createdByGolive': REF, ...extra } });
    const routes = (patches: string[]): Parameters<typeof mockHttp>[0] => [
      ['GET', `${API}/projects/${REF}/api-keys`, () => ({ json: [{ name: 'default', type: 'publishable', api_key: PUB_KEY }] })],
      poolerRoute([{ database_type: 'PRIMARY', db_user: `postgres.${REF}`, db_host: 'aws-1-eu-west-1.pooler.supabase.com', db_name: 'postgres', connection_string: SHARED_POOLER }]),
      ['PATCH', `${API}/projects/${REF}/database/password`, (c) => (patches.push((c.body as { password: string }).password), { json: { message: 'ok' } })],
    ];

    it('plan: provides() offers the DB URLs and warns, without writing; apply: resets once, builds URLs from the new password', async () => {
      const patches: string[] = [];
      const { http, calls } = mockHttp(routes(patches));
      const ctx = testCtx({ http, tokens, state: created() });
      const keys = await caps.outputs.provides!(ctx, 'production');
      expect(keys).toEqual(expect.arrayContaining(['supabase.url', 'supabase.publishableKey', 'db.url', 'db.directUrl']));
      expect(ctx.logs.join('\n')).toMatch(/created by golive.*password.*is gone.*apply will set a new generated password/);
      expect(calls.some((c) => c.method === 'PATCH')).toBe(false);

      const sctx = asStep(ctx);
      const out = await caps.outputs.outputs(sctx, 'preview');
      expect(patches).toHaveLength(1);
      const pw = patches[0]!;
      expect(pw.length).toBeGreaterThanOrEqual(24);
      expect(vaultGet(`supabase.dbPass:${REF}`)!.reveal()).toBe(pw);
      expect((out['db.url'] as Secret).reveal()).toBe(`postgresql://postgres.${REF}:${pw}@aws-1-eu-west-1.pooler.supabase.com:6543/postgres`);
      expect((out['db.directUrl'] as Secret).reveal()).toBe(`postgresql://postgres.${REF}:${pw}@aws-1-eu-west-1.pooler.supabase.com:5432/postgres`);
      // The next target in the same apply reuses it: no second reset.
      await caps.outputs.outputs(sctx, 'production');
      expect(patches).toHaveLength(1);
      expectNoLeak([pw, TOKEN], [ctx.logs, ctx.state.get(), keys]);
    });

    it('never resets outside a step run (e.g. the rls check reading outputs)', async () => {
      const patches: string[] = [];
      const { http } = mockHttp(routes(patches));
      const out = await caps.outputs.outputs(testCtx({ http, tokens, state: created() }), 'production');
      expect(patches).toHaveLength(0);
      expect(out['db.url']).toBeUndefined();
    });

    it('never resets an adopted project (no created-by-golive marker): the DB URLs stay a handoff', async () => {
      const patches: string[] = [];
      const { http } = mockHttp(routes(patches));
      const ctx = testCtx({ http, tokens, state: withRef() });
      expect(await caps.outputs.provides!(ctx, 'production')).not.toContain('db.url');
      const out = await caps.outputs.outputs(asStep(ctx), 'production');
      expect(patches).toHaveLength(0);
      expect(out['db.url']).toBeUndefined();
    });

    it('never resets once a DB URL from this project was written (or its source is unreadable)', async () => {
      for (const src of [`db.url|supabase|${REF}`, `db.directUrl|supabase|${REF}+clerk_1`, 'db.url|supabase|?']) {
        const patches: string[] = [];
        const { http } = mockHttp(routes(patches));
        const ctx = testCtx({ http, tokens, state: created({ 'env:DATABASE_URL@production': src }) });
        expect(await caps.outputs.provides!(ctx, 'preview')).not.toContain('db.url');
        await caps.outputs.outputs(asStep(ctx), 'preview');
        expect(patches).toHaveLength(0);
      }
    });

    it('a DB URL written from ANOTHER project does not block the reset', async () => {
      const patches: string[] = [];
      const { http } = mockHttp(routes(patches));
      const ctx = testCtx({ http, tokens, state: created({ 'env:DATABASE_URL@production': `db.url|supabase|${REF2}` }) });
      await caps.outputs.outputs(asStep(ctx), 'production');
      expect(patches).toHaveLength(1);
    });

    it('never resets without the token (the reset is API-only)', async () => {
      const ex = mockExec([[`supabase projects api-keys --project-ref ${REF} --reveal -o json`, { stdout: '[]' }]]);
      const ctx = testCtx({ exec: ex.run, state: created() });
      expect(await caps.outputs.provides!(ctx, 'production')).not.toContain('db.url');
    });
  });

  it('maps an API-key 403 to the required project permissions without demanding broader access', async () => {
    const { http } = mockHttp([['GET', `${API}/projects/${REF}/api-keys`, () => ({ status: 403, json: { message: 'Forbidden resource' } })]]);
    const e = await errorOf(caps.outputs.outputs(testCtx({ http, tokens, state: withRef() }), 'production'));
    expect(e.message).toMatch(/403/);
    expect(e.message).toMatch(/API Keys Read and API Key Secrets Read/);
    expect(e.message).not.toMatch(/classic/);
    expectNoLeak([TOKEN], [e.message]);
  });

  it('uses `supabase projects api-keys --reveal` without a token; keys stay out of argv', async () => {
    const ex = mockExec([
      [`supabase projects api-keys --project-ref ${REF} --reveal -o json`, { stdout: JSON.stringify([{ name: 'default', type: 'publishable', api_key: PUB_KEY }, { name: 'default', type: 'secret', api_key: SECRET_KEY }]) }],
    ]);
    const ctx = testCtx({ exec: ex.run, state: withRef() });
    const out = await caps.outputs.outputs(ctx, 'production');
    expect((out['supabase.secretKey'] as Secret).reveal()).toBe(SECRET_KEY);
    expectNoLeak([SECRET_KEY], [ex.calls.map((c) => c.args), out, ctx.logs]);
  });

  it('does not echo CLI stdout in errors', async () => {
    const ex = mockExec([['supabase projects api-keys', { code: 2, stdout: SECRET_KEY, stderr: 'boom' }]]);
    const e = await errorOf(caps.outputs.outputs(testCtx({ exec: ex.run, state: withRef() }), 'production'));
    expect(e.message).toMatch(/exit 2.*boom/);
    expectNoLeak([SECRET_KEY], [e.message]);
  });

  it('errors actionably when no project is selected', async () => {
    const ctx = testCtx({ cwd: tempDir() });
    await expect(caps.outputs.outputs(ctx, 'production')).rejects.toThrow(/No Supabase project is selected/);
  });
});

// ── dbAdmin ─────────────────────────────────────────────────────────────────────────────────────

describe('supabase dbAdmin', () => {
  const tokens = { SUPABASE_ACCESS_TOKEN: TOKEN };
  const rows = [
    { schema: 'public', name: 'profiles', rls: true, policies: [{ name: 'own rows', cmd: 'SELECT', permissive: 'PERMISSIVE', roles: ['authenticated'], qual: '(auth.uid() = id)', with_check: null }] },
    { schema: 'public', name: 'todos', rls: false, policies: '[]' },
  ];

  it('tables(): reads exposed schemas (discarding jwt_secret) and maps RLS + policies', async () => {
    const { http, calls } = mockHttp([
      ['GET', `${API}/projects/${REF}/postgrest`, () => ({ json: { db_schema: 'public, graphql_public, bad;drop', max_rows: 1000, jwt_secret: JWT_SECRET } })],
      ['POST', `${API}/projects/${REF}/database/query/read-only`, () => ({ status: 201, json: rows })],
    ]);
    const ctx = testCtx({ http, tokens, state: withRef() });
    const t = await caps.dbAdmin.tables(ctx);
    const query = (calls[1]!.body as { query: string }).query;
    expect(query).toContain("array['public', 'graphql_public']::text[]");
    expect(query).not.toContain('bad;drop');
    expect(query).toContain('pg_policies');
    expect(t).toEqual([
      { schema: 'public', name: 'profiles', rls: true, policies: [{ name: 'own rows', command: 'SELECT', permissive: true, roles: ['authenticated'], using: '(auth.uid() = id)' }] },
      { schema: 'public', name: 'todos', rls: false, policies: [] },
    ]);
    expectNoLeak([JWT_SECRET], [t, ctx.logs, calls[1]!.body]);
  });

  it('tables(): query errors carry no response secrets', async () => {
    const { http } = mockHttp([
      ['GET', `${API}/projects/${REF}/postgrest`, () => ({ json: { db_schema: 'public', jwt_secret: JWT_SECRET } })],
      ['POST', `${API}/projects/${REF}/database/query/read-only`, () => ({ status: 400, json: { message: 'syntax error' } })],
    ]);
    const e = await errorOf(caps.dbAdmin.tables(testCtx({ http, tokens, state: withRef() })));
    expect(e.message).toMatch(/HTTP 400.*syntax error/);
    expectNoLeak([JWT_SECRET, TOKEN], [e.message]);
  });

  it('tables(): falls back to `supabase db query` with SQL on stdin', async () => {
    const ex = mockExec([[`supabase db query --linked --project-ref ${REF} -o json`, { stdout: JSON.stringify(rows) }]]);
    const t = await caps.dbAdmin.tables(testCtx({ exec: ex.run, state: withRef() }));
    expect(t.map((x) => x.name)).toEqual(['profiles', 'todos']);
    const query = ex.calls.find((c) => c.args[0] === 'db')!;
    expect(query.stdin).toContain("array['public']::text[]");
    expect(query.args.join(' ')).not.toContain('select');
  });

  it('advisors(): maps lint levels to severities', async () => {
    const { http } = mockHttp([
      [
        'GET',
        `${API}/projects/${REF}/advisors/security`,
        () => ({
          json: {
            lints: [
              { name: 'rls_disabled_in_public', title: 'RLS Disabled in Public', level: 'ERROR', detail: 'Table public.todos is public, but RLS is disabled', remediation: 'https://supabase.com/docs/guides/database/database-linter?lint=0013', cache_key: 'rls_disabled_in_public_public_todos' },
              { name: 'function_search_path_mutable', title: 'Function Search Path Mutable', level: 'WARN', detail: 'f' },
              { name: 'x', level: 'INFO' },
            ],
          },
        }),
      ],
    ]);
    const f = await caps.dbAdmin.advisors!(testCtx({ http, tokens, state: withRef() }));
    expect(f.map((x) => x.severity)).toEqual(['high', 'medium', 'info']);
    expect(f[0]).toMatchObject({ id: 'supabase.advisor.rls_disabled_in_public:rls_disabled_in_public_public_todos', title: 'RLS Disabled in Public', evidence: ['Table public.todos is public, but RLS is disabled'] });
    expect(f[0]!.fix).toContain('database-linter');
  });

  it('advisors(): needs a token', async () => {
    await expect(caps.dbAdmin.advisors!(testCtx({ state: withRef() }))).rejects.toThrow(/SUPABASE_ACCESS_TOKEN/);
  });
});

// ── authConfig ──────────────────────────────────────────────────────────────────────────────────

describe('supabase authConfig', () => {
  const tokens = { SUPABASE_ACCESS_TOKEN: TOKEN };
  const SMTP_HASH = 'smtp-pass-hash-never-leak-0123456789';
  /** A full auth-config response: the whitelisted fields plus the ones golive must never touch. */
  const FULL_AUTH_CONFIG = {
    site_url: 'https://app.example.com',
    uri_allow_list: 'https://app.example.com/**',
    disable_signup: false,
    mailer_autoconfirm: false,
    password_min_length: 8,
    smtp_host: 'smtp.resend.com',
    smtp_admin_email: 'noreply@example.com',
    smtp_sender_name: 'Shop',
    jwt_exp: 3600,
    mailer_otp_exp: 86400,
    mailer_otp_length: 6,
    rate_limit_email_sent: 30,
    smtp_pass: SMTP_HASH,
    external_google_secret: GOOGLE_SECRET,
  };
  const patches = (calls: Array<{ method: string; body: unknown }>): unknown[] => calls.filter((c) => c.method === 'PATCH').map((c) => c.body);

  it('get(): extracts only site_url and the split allow list', async () => {
    const { http } = mockHttp([
      ['GET', `${API}/projects/${REF}/config/auth`, () => ({ json: { site_url: 'https://app.example.com', uri_allow_list: 'https://app.example.com/**, ,http://localhost:3000', external_google_secret: GOOGLE_SECRET, smtp_pass: 'hash' } })],
    ]);
    const ctx = testCtx({ http, tokens, state: withRef() });
    const a = await caps.authConfig.get(ctx);
    expect(a).toEqual({ siteUrl: 'https://app.example.com', redirectUrls: ['https://app.example.com/**', 'http://localhost:3000'] });
    expectNoLeak([GOOGLE_SECRET], [a, ctx.logs]);
  });

  it('get(): empty settings', async () => {
    const { http } = mockHttp([['GET', `${API}/projects/${REF}/config/auth`, () => ({ json: { site_url: '', uri_allow_list: '' } })]]);
    expect(await caps.authConfig.get(testCtx({ http, tokens, state: withRef() }))).toEqual({ siteUrl: null, redirectUrls: [] });
  });

  it('set(): PATCHes only the requested whitelisted keys, then re-reads them', async () => {
    let live: Record<string, unknown> = { site_url: 'http://localhost:3000', uri_allow_list: 'http://localhost:3000/**', external_google_secret: GOOGLE_SECRET };
    const { http, calls } = mockHttp([
      ['GET', `${API}/projects/${REF}/config/auth`, () => ({ json: live })],
      ['PATCH', `${API}/projects/${REF}/config/auth`, (c) => ((live = { ...live, ...(c.body as Record<string, unknown>) }), { json: {} })],
    ]);
    const ctx = testCtx({ http, tokens, state: withRef() });
    const first = await caps.authConfig.set(ctx, { siteUrl: 'https://app.example.com', redirectUrls: ['https://app.example.com/**', 'https://app.example.com/**', 'https://*-acme.vercel.app/**'] });
    expect(patches(calls)[0]).toEqual({ site_url: 'https://app.example.com', uri_allow_list: 'https://app.example.com/**,https://*-acme.vercel.app/**' });
    expect([first.applied, first.skipped]).toEqual([['siteUrl', 'redirectUrls'], []]);
    await caps.authConfig.set(ctx, { redirectUrls: ['https://a.example.com'] });
    expect(patches(calls)[1]).toEqual({ uri_allow_list: 'https://a.example.com' });
    await caps.authConfig.set(ctx, {});
    expect(patches(calls)).toHaveLength(2); // an empty patch sends nothing, not even a read
    expect(calls.filter((c) => c.method === 'GET')).toHaveLength(2);
  });

  it('set(): rejects commas and requires a token', async () => {
    const ctx = testCtx({ state: withRef() });
    await expect(caps.authConfig.set(ctx, { siteUrl: 'https://a.com,https://b.com' })).rejects.toThrow(/commas/);
    const e = await errorOf(caps.authConfig.set(ctx, { siteUrl: 'https://a.com' }));
    expect(e.message).toMatch(/Changing Supabase auth settings needs a reusable Supabase login/);
    expectSafeTokenHelp(e.message);
    await expect(caps.authConfig.get(ctx)).rejects.toThrow(/SUPABASE_ACCESS_TOKEN/);
  });

  it('get(): reads the whitelisted policy fields, flipping the provider\'s negative wording', async () => {
    const { http } = mockHttp([['GET', `${API}/projects/${REF}/config/auth`, () => ({ json: FULL_AUTH_CONFIG })]]);
    const ctx = testCtx({ http, tokens, state: withRef() });
    const a = await caps.authConfig.get(ctx);
    expect(a).toEqual({
      siteUrl: 'https://app.example.com',
      redirectUrls: ['https://app.example.com/**'],
      signupEnabled: true,
      emailConfirmRequired: true,
      minPasswordLength: 8,
      smtp: { configured: true, host: 'smtp.resend.com', senderEmail: 'noreply@example.com', senderName: 'Shop' },
      jwtExpirySeconds: 3600,
      otpExpirySeconds: 86400,
      otpLength: 6,
      emailRateLimitPerHour: 30,
    });
    expectNoLeak([GOOGLE_SECRET, SMTP_HASH], [a, ctx.logs]);
  });

  it('get(): reports the built-in mailer when the provider answers its SMTP fields empty', async () => {
    const { http } = mockHttp([['GET', `${API}/projects/${REF}/config/auth`, () => ({ json: { site_url: 'https://app.example.com', smtp_host: null, smtp_admin_email: '' } })]]);
    const a = await caps.authConfig.get(testCtx({ http, tokens, state: withRef() }));
    expect(a.smtp).toEqual({ configured: false });
  });

  it('set(): writes policy fields and confirms them from the provider\'s own settings', async () => {
    let live: Record<string, unknown> = { site_url: 'https://app.example.com', uri_allow_list: 'https://app.example.com/**', disable_signup: false, mailer_autoconfirm: false, password_min_length: 6, smtp_host: '' };
    const { http, calls } = mockHttp([
      ['GET', `${API}/projects/${REF}/config/auth`, () => ({ json: live })],
      ['PATCH', `${API}/projects/${REF}/config/auth`, (c) => ((live = { ...live, ...(c.body as Record<string, unknown>) }), { json: {} })],
    ]);
    const out = await caps.authConfig.set(testCtx({ http, tokens, state: withRef() }), { signupEnabled: false, emailConfirmRequired: true, minPasswordLength: 12, smtp: { configured: true, host: 'smtp.resend.com' } });
    expect(patches(calls)[0]).toEqual({ disable_signup: true, mailer_autoconfirm: false, password_min_length: 12, smtp_host: 'smtp.resend.com' });
    expect(out.applied).toEqual(['signupEnabled', 'emailConfirmRequired', 'minPasswordLength', 'smtp.host']);
    expect(out.skipped).toEqual([]);
    expect(calls.map((c) => c.method)).toEqual(['PATCH', 'GET']); // the write is followed by the provider's own settings
    expect(out.after).toMatchObject({ signupEnabled: false, emailConfirmRequired: true, minPasswordLength: 12, smtp: { configured: true, host: 'smtp.resend.com' } });
  });

  it('set(): names a setting the provider does not report back instead of calling it applied', async () => {
    const { http } = mockHttp([
      ['GET', `${API}/projects/${REF}/config/auth`, () => ({ json: { site_url: 'https://app.example.com', uri_allow_list: 'https://app.example.com/**' } })],
      ['PATCH', `${API}/projects/${REF}/config/auth`, () => ({ json: {} })],
    ]);
    const out = await caps.authConfig.set(testCtx({ http, tokens, state: withRef() }), { signupEnabled: false, minPasswordLength: 12 });
    expect(out.applied).toEqual([]);
    expect(out.skipped).toEqual(['signupEnabled (the provider does not report this setting back)', 'minPasswordLength (the provider does not report this setting back)']);
  });

  it('set(): reports a value the provider keeps answering instead of claiming success', async () => {
    const { http } = mockHttp([
      ['GET', `${API}/projects/${REF}/config/auth`, () => ({ json: { site_url: '', uri_allow_list: '', disable_signup: false } })],
      ['PATCH', `${API}/projects/${REF}/config/auth`, () => ({ json: {} })],
    ]);
    const out = await caps.authConfig.set(testCtx({ http, tokens, state: withRef() }), { signupEnabled: false });
    expect(out.applied).toEqual([]);
    expect(out.skipped).toEqual(['signupEnabled (the provider reports true instead of false)']);
  });

  it('set(): sends the SMTP password in the body, never reads it back and never echoes it', async () => {
    const smtpPass = new Secret('RESEND_SMTP_PASSWORD', 'smtp-password-never-echoed-1234');
    const { http, calls } = mockHttp([
      ['GET', `${API}/projects/${REF}/config/auth`, () => ({ json: { site_url: '', uri_allow_list: '', smtp_host: 'smtp.resend.com', smtp_admin_email: 'noreply@example.com', smtp_pass: SMTP_HASH } })],
      ['PATCH', `${API}/projects/${REF}/config/auth`, () => ({ json: {} })],
    ]);
    const ctx = testCtx({ http, tokens, state: withRef() });
    const out = await caps.authConfig.set(ctx, { smtp: { configured: true, host: 'smtp.resend.com', senderEmail: 'noreply@example.com' }, smtpPassword: smtpPass });
    expect(patches(calls)[0]).toEqual({ smtp_host: 'smtp.resend.com', smtp_admin_email: 'noreply@example.com', smtp_pass: smtpPass.reveal() });
    expect(out.applied).toEqual(['smtp.host', 'smtp.senderEmail']);
    expect(out.skipped).toEqual(['smtpPassword (write-only: the provider never returns the value, so golive cannot confirm it)']);
    expectNoLeak([smtpPass.reveal()], [out, ctx.state.get(), ctx.logs]);
  });

  it('set(): a rejected write echoes neither the request body nor the SMTP password', async () => {
    const smtpPass = new Secret('RESEND_SMTP_PASSWORD', 'smtp-password-never-echoed-5678');
    const { http } = mockHttp([['PATCH', `${API}/projects/${REF}/config/auth`, () => ({ status: 400, json: { message: `smtp_pass ${smtpPass.reveal()} is not accepted` } })]]);
    const e = await errorOf(caps.authConfig.set(testCtx({ http, tokens, state: withRef() }), { smtpPassword: smtpPass }));
    expect(e.message).toMatch(/HTTP 400/);
    expect(e.message).not.toContain(smtpPass.reveal());
  });

  it('set(): refuses a policy value the API would reject, before any request', async () => {
    const { http, calls } = mockHttp([]);
    await expect(caps.authConfig.set(testCtx({ http, tokens, state: withRef() }), { minPasswordLength: 0 })).rejects.toThrow(/positive whole number/);
    expect(calls).toHaveLength(0);
  });
});

// ── REST probe ──────────────────────────────────────────────────────────────────────────────────

describe('supabaseRestProbe', () => {
  it('sends a publishable key on apikey only, with Accept-Profile for non-public schemas', async () => {
    const { http, calls } = mockHttp([['GET', `https://${REF}.supabase.co/rest/v1/todos`, () => ({ json: [{ id: 1 }] })]]);
    const r = await supabaseRestProbe(testCtx({ http }), REF, 'todos', 'api', PUB_KEY);
    expect(r).toEqual({ status: 200, rows: 1 });
    expect(calls[0]!.url).toBe(`https://${REF}.supabase.co/rest/v1/todos?select=*&limit=1`);
    expect(calls[0]!.headers.apikey).toBe(PUB_KEY);
    expect(calls[0]!.headers.authorization).toBeUndefined();
    expect(calls[0]!.headers['accept-profile']).toBe('api');
  });

  it('adds Authorization for legacy JWT keys and reports PostgREST codes', async () => {
    const { http, calls } = mockHttp([['GET', `https://${REF}.supabase.co/rest/v1/secrets`, () => ({ status: 401, json: { code: '42501', message: 'permission denied' } })]]);
    const r = await supabaseRestProbe(testCtx({ http }), REF, 'secrets', 'public', ANON);
    expect(r).toEqual({ status: 401, rows: 0, code: '42501' });
    expect(calls[0]!.headers.authorization).toBe(`Bearer ${ANON}`);
    expect(calls[0]!.headers['accept-profile']).toBeUndefined();
  });

  it('rejects a malformed ref before any request', async () => {
    const { http, calls } = mockHttp([]);
    await expect(supabaseRestProbe(testCtx({ http }), 'evil.com/x', 't', 'public', PUB_KEY)).rejects.toThrow(/project ref/);
    expect(calls).toHaveLength(0);
  });
});

describe('supabaseAuthedProbe (the app\'s own session, not anonymity)', () => {
  it('puts the session token on Authorization and the publishable key on apikey', async () => {
    const token = new Secret('SUPABASE_AUTH_TOKEN', 'session-token-for-tests-1234');
    const { http, calls } = mockHttp([['GET', `https://${REF}.supabase.co/rest/v1/todos`, () => ({ json: [] })]]);
    const r = await supabaseAuthedProbe(testCtx({ http }), REF, 'todos', 'api', PUB_KEY, token);
    expect(r).toEqual({ status: 200, rows: 0 });
    expect(calls[0]!.url).toBe(`https://${REF}.supabase.co/rest/v1/todos?select=*&limit=1`);
    expect(calls[0]!.headers.apikey).toBe(PUB_KEY);
    // The session token carries the `Bearer` scheme: PostgREST reads the value after it, and a bare
    // JWT resolves to the anonymous role, so the probe would measure the wrong role silently.
    expect(calls[0]!.headers.authorization).toBe(`Bearer ${token.reveal()}`);
    expect(calls[0]!.headers['accept-profile']).toBe('api');
  });

  it('reports a denied table the way PostgREST answers it, and rejects a malformed ref', async () => {
    const token = new Secret('SUPABASE_AUTH_TOKEN', 'session-token-for-tests-5678');
    const { http } = mockHttp([['GET', `https://${REF}.supabase.co/rest/v1/orders`, () => ({ status: 403, json: { code: '42501', message: 'permission denied for table orders' } })]]);
    expect(await supabaseAuthedProbe(testCtx({ http }), REF, 'orders', 'public', PUB_KEY, token)).toEqual({ status: 403, rows: 0, code: '42501' });

    const none = mockHttp([]);
    await expect(supabaseAuthedProbe(testCtx({ http: none.http }), 'evil.com/x', 't', 'public', PUB_KEY, token)).rejects.toThrow(/project ref/);
    expect(none.calls).toHaveLength(0);
  });
});

describe('supabase adapter shape', () => {
  it('declares id, axes and capabilities; detects supabase usage', () => {
    expect(supabaseAdapter).toMatchObject({ id: 'supabase', axes: ['db', 'auth'], automated: true });
    expect(Object.keys(supabaseAdapter.capabilities).sort()).toEqual(['authConfig', 'authUsers', 'dbAdmin', 'outputs', 'project']);
    const base = { root: '/r', packageManager: null, framework: 'next' as const, providers: {}, envRefs: [], configs: {}, webhooks: [], findings: [], notes: [] };
    expect(supabaseAdapter.detect!(base)).toBe(false);
    expect(supabaseAdapter.detect!({ ...base, providers: { db: ['supabase'] } })).toBe(true);
    expect(supabaseAdapter.detect!({ ...base, envRefs: [{ name: 'NEXT_PUBLIC_SUPABASE_URL', files: [], clientExposed: true }] })).toBe(true);
  });
});
