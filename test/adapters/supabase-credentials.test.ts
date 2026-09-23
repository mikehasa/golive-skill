import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { chmodSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mockExec, mockHttp, testCtx } from '../helpers.js';
import { readSupabaseCliCredential, supabaseCredential } from '../../src/adapters/supabase-credentials.js';
import { _resetSecretRegistry, Secret, vaultGet } from '../../src/core/secret.js';
import { supabaseAdapter, supabaseTiming } from '../../src/adapters/supabase.js';
import type { Capabilities } from '../../src/core/types.js';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, lstatSync: vi.fn(actual.lstatSync), fstatSync: vi.fn(actual.fstatSync) };
});

const TOKEN = 'sbp' + '_0123456789abcdef0123456789abcdef01234567';
const OTHER = 'sbp' + '_abcdef0123456789abcdef0123456789abcdef01';
const API = 'https://api.supabase.com/v1';
const REF = 'abcdefghijklmnopqrst';
const caps = supabaseAdapter.capabilities as Capabilities;
const dirs: string[] = [];
const home = (): string => { const p = mkdtempSync(join(realpathSync(tmpdir()), 'golive-sb-login-')); dirs.push(p); return p; };
const version = ['supabase --version', { stdout: '2.117.0\n' }] as const;

beforeEach(async () => {
  _resetSecretRegistry(); supabaseTiming.pollMs = 0;
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  vi.mocked(fs.lstatSync).mockImplementation(actual.lstatSync);
  vi.mocked(fs.fstatSync).mockImplementation(actual.fstatSync);
});
afterEach(() => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function store(content = TOKEN) {
  const root = home();
  writeFileSync(join(root, 'access-token'), content, { mode: 0o600 });
  return { root, env: { SUPABASE_HOME: root, SUPABASE_NO_KEYRING: '1' } };
}

describe('Supabase CLI credential storage', () => {
  it.each([TOKEN, `go-keyring-base64:${Buffer.from(TOKEN).toString('base64')}`])('captures native or Go-encoded macOS keychain output into Secret', async (value) => {
    const root = home();
    const ex = mockExec([[...version], ['/usr/bin/security find-generic-password -s Supabase CLI -a supabase -w', { stdout: `${value}\n` }]]);
    const ctx = testCtx({ exec: ex.run, env: { SUPABASE_HOME: root } });
    const got = await readSupabaseCliCredential(ctx, { platform: 'darwin' });
    expect(got).toBeInstanceOf(Secret);
    expect(got?.reveal()).toBe(TOKEN);
    expect(JSON.stringify([got, ex.calls, ctx.logs])).not.toContain(TOKEN);
    expect(JSON.stringify([got, ex.calls, ctx.logs])).not.toContain(Buffer.from(TOKEN).toString('base64'));
  });

  it('uses the official legacy account only when the profile keychain item is absent', async () => {
    const ex = mockExec([[...version],
      ['/usr/bin/security find-generic-password -s Supabase CLI -a supabase -w', { code: 44 }],
      ['/usr/bin/security find-generic-password -s Supabase CLI -a access-token -w', { stdout: TOKEN }],
    ]);
    expect((await readSupabaseCliCredential(testCtx({ exec: ex.run, env: { SUPABASE_HOME: home() } }), { platform: 'darwin' }))?.reveal()).toBe(TOKEN);
    expect(ex.calls).toHaveLength(3);
  });

  it.each([1, 36, 128])('does not switch accounts/files after Keychain denial, lock or cancellation (%s)', async (code) => {
    const { root } = store(OTHER);
    const ex = mockExec([[...version], ['/usr/bin/security', { code, stdout: TOKEN, stderr: TOKEN }]]);
    await expect(readSupabaseCliCredential(testCtx({ exec: ex.run, env: { SUPABASE_HOME: root } }), { platform: 'darwin' })).rejects.toThrow(/denied or unavailable/);
    expect(ex.calls).toHaveLength(2);
  });

  it.each(['not-a-token', '', 'go-keyring-base64:%%%'])('rejects malformed Keychain output without returning it or trying another account', async (raw) => {
    const { root } = store(OTHER);
    const ex = mockExec([[...version], ['/usr/bin/security', { stdout: raw }]]);
    await expect(readSupabaseCliCredential(testCtx({ exec: ex.run, env: { SUPABASE_HOME: root } }), { platform: 'darwin' })).rejects.toThrow(/malformed/);
    expect(ex.calls).toHaveLength(2);
  });

  it.each(['darwin', 'linux'])('reuses the private fallback file with keyring disabled on %s without changing it', async (platform) => {
    const { root, env } = store(`${TOKEN}\n`);
    const ex = mockExec([[...version]]);
    const got = await readSupabaseCliCredential(testCtx({ exec: ex.run, env }), { platform, wsl: false });
    expect(got?.reveal()).toBe(TOKEN);
    expect(readFileSync(join(root, 'access-token'), 'utf8')).toBe(`${TOKEN}\n`);
    expect(ex.calls).toHaveLength(1);
  });

  it('uses the documented file fallback on WSL without invoking an OS keyring', async () => {
    const { root } = store();
    const ex = mockExec([[...version]]);
    expect((await readSupabaseCliCredential(testCtx({ exec: ex.run, env: { SUPABASE_HOME: root } }), { platform: 'linux', wsl: true }))?.reveal()).toBe(TOKEN);
    expect(ex.calls).toHaveLength(1);
  });

  it('falls back to a private file only after both macOS keychain items are absent', async () => {
    const { root } = store();
    const ex = mockExec([[...version], ['/usr/bin/security', { code: 44 }]]);
    expect((await readSupabaseCliCredential(testCtx({ exec: ex.run, env: { SUPABASE_HOME: root } }), { platform: 'darwin' }))?.reveal()).toBe(TOKEN);
    expect(ex.calls).toHaveLength(3);
  });

  it.each(['supabase-staging', 'snap', '/profiles/custom.yaml'])('rejects non-production profile %s before any credential read', async (profile) => {
    const { root, env } = store();
    for (const fromEnv of [false, true]) {
      writeFileSync(join(root, 'profile'), profile);
      const ex = mockExec([[...version]]);
      await expect(readSupabaseCliCredential(testCtx({ exec: ex.run, env: { ...env, ...(fromEnv ? { SUPABASE_PROFILE: profile } : {}) } }), { platform: 'darwin' })).rejects.toThrow(/not the supported production/);
      expect(ex.calls).toHaveLength(1);
    }
  });

  it('honors an explicit production profile before a persisted profile and canonicalizes its case', async () => {
    const { root, env } = store();
    writeFileSync(join(root, 'profile'), 'snap');
    const ex = mockExec([[...version]]);
    expect((await readSupabaseCliCredential(testCtx({ exec: ex.run, env: { ...env, SUPABASE_PROFILE: 'SUPABASE' } }), { platform: 'darwin' }))?.reveal()).toBe(TOKEN);
  });

  it.each(['world-readable', 'symlink', 'hardlink', 'large', 'directory', 'malformed'])('rejects unsafe fallback credential file: %s', async (kind) => {
    const { root, env } = store();
    const path = join(root, 'access-token');
    if (kind === 'world-readable') chmodSync(path, 0o644);
    if (kind === 'hardlink') linkSync(path, join(root, 'alias'));
    if (kind === 'large') writeFileSync(path, 'a'.repeat(4097));
    if (kind === 'malformed') writeFileSync(path, 'broken-credential');
    if (kind === 'symlink' || kind === 'directory') {
      rmSync(path);
      if (kind === 'directory') mkdirSync(path);
      else { writeFileSync(join(root, 'other'), TOKEN, { mode: 0o600 }); symlinkSync(join(root, 'other'), path); }
    }
    const ex = mockExec([[...version]]);
    await expect(readSupabaseCliCredential(testCtx({ exec: ex.run, env }), { platform: 'darwin' })).rejects.toThrow(/Supabase CLI/);
    expect(ex.calls).toHaveLength(1);
  });

  it.each([0o777, 0o775, 0o1777])('rejects a private token below a writable user-owned directory (%s)', async (mode) => {
    const { root, env } = store();
    chmodSync(root, mode);
    const ex = mockExec([[...version]]);
    await expect(readSupabaseCliCredential(testCtx({ exec: ex.run, env }), { platform: 'darwin' })).rejects.toThrow(/unsafe writable or untrusted parent/);
    expect(ex.calls).toHaveLength(1);
  });

  it('rejects symlinked ancestors instead of relying only on O_NOFOLLOW for the final file', async () => {
    const { root } = store();
    const other = home();
    symlinkSync(root, join(other, 'alias'));
    const ex = mockExec([[...version]]);
    await expect(readSupabaseCliCredential(testCtx({ exec: ex.run, env: { SUPABASE_HOME: join(other, 'alias'), SUPABASE_NO_KEYRING: '1' } }), { platform: 'darwin' })).rejects.toThrow(/unsafe path/);
    expect(ex.calls).toHaveLength(1);
  });

  it('rejects a foreign-owned directory even when its mode and token file appear private', async () => {
    const { root, env } = store();
    const original = (await vi.importActual<typeof import('node:fs')>('node:fs')).lstatSync;
    vi.spyOn(fs, 'lstatSync').mockImplementation(((path: fs.PathLike, ...args: unknown[]) => {
      const stat = Reflect.apply(original, fs, [path, ...args]);
      return path === root ? Object.assign(Object.create(stat), { uid: (process.getuid?.() ?? 0) + 1000 }) : stat;
    }) as typeof fs.lstatSync);
    await expect(readSupabaseCliCredential(testCtx({ exec: mockExec([[...version]]).run, env }), { platform: 'darwin' })).rejects.toThrow(/untrusted parent/);
  });

  it('refuses a credential file replaced between lstat and open', async () => {
    const { env } = store();
    const original = (await vi.importActual<typeof import('node:fs')>('node:fs')).fstatSync;
    vi.spyOn(fs, 'fstatSync').mockImplementation(((fd: number, ...args: unknown[]) => {
      const stat = Reflect.apply(original, fs, [fd, ...args]);
      return Object.assign(Object.create(stat), { ino: Number(stat.ino) + 1 });
    }) as typeof fs.fstatSync);
    await expect(readSupabaseCliCredential(testCtx({ exec: mockExec([[...version]]).run, env }), { platform: 'darwin' })).rejects.toThrow(/changed while being read/);
  });

  it.each(['win32', 'linux'])('fails safely for unsupported OS keyring %s without falling through to an unrelated file', async (platform) => {
    const { root } = store(OTHER);
    const ex = mockExec([[...version]]);
    await expect(readSupabaseCliCredential(testCtx({ exec: ex.run, env: { SUPABASE_HOME: root } }), { platform, wsl: false })).rejects.toThrow(/not implemented|cannot be safely reused/);
    expect(ex.calls).toHaveLength(1);
  });

  it.each(['3.0.0', '2.116.0', 'nonsense'])('refuses unknown CLI storage versions (%s)', async (versionText) => {
    const ex = mockExec([['supabase --version', { stdout: versionText }]]);
    await expect(readSupabaseCliCredential(testCtx({ exec: ex.run, env: { SUPABASE_HOME: home() } }), { platform: 'darwin' })).rejects.toThrow(/version was not recognized/);
  });

  it('explicit credentials take precedence over profiles and stores even when invalid', async () => {
    const ex = mockExec([]);
    const ctx = testCtx({ exec: ex.run, tokens: { SUPABASE_ACCESS_TOKEN: 'invalid-explicit-token' }, env: { SUPABASE_PROFILE: 'snap' } });
    expect((await supabaseCredential(ctx))?.reveal()).toBe('invalid-explicit-token');
    expect(ex.calls).toHaveLength(0);
  });

  it('memoizes stored resolution within the same run without serializing its value', async () => {
    const { env } = store();
    const ex = mockExec([[...version]]);
    const ctx = testCtx({ exec: ex.run, env });
    const tokens = await Promise.all([supabaseCredential(ctx), supabaseCredential(ctx)]);
    expect(tokens[0]).toBe(tokens[1]);
    expect(ex.calls).toHaveLength(1);
    expect(JSON.stringify([...ctx.cache])).not.toContain(TOKEN);
  });
});

describe('complete Supabase flow from the CLI browser-login store', () => {
  it('uses the same credential for identity, creation, keys, pooler URLs, Auth and read-only checks', async () => {
    const { root, env } = store();
    const ex = mockExec([[...version]]);
    let created = false;
    let siteUrl = 'http://localhost:3000';
    let redirects = '';
    const pub = 'sb_publishable_' + 'publicvalue';
    const secret = 'sb_secret_' + 'servervalue';
    const { http, calls } = mockHttp([
      ['GET', `${API}/profile`, () => ({ json: { username: 'alice' } })],
      ['GET', `${API}/organizations`, () => ({ json: [{ slug: 'acme', name: 'Acme' }] })],
      ['GET', `${API}/organizations/acme`, () => ({ json: { plan: 'free' } })],
      ['GET', `${API}/projects`, () => ({ json: created ? [{ ref: REF, name: 'demo', organization_slug: 'acme', status: 'ACTIVE_HEALTHY' }] : [] })],
      ['POST', `${API}/projects`, () => { created = true; return { status: 201, json: { ref: REF, name: 'demo', organization_slug: 'acme' } }; }],
      ['GET', `${API}/projects/${REF}`, () => ({ json: { ref: REF, name: 'demo', status: 'ACTIVE_HEALTHY' } })],
      ['GET', `${API}/projects/${REF}/api-keys`, () => ({ json: [{ name: 'default', type: 'publishable', api_key: pub }, { name: 'default', type: 'secret', api_key: secret }] })],
      ['GET', `${API}/projects/${REF}/config/database/pooler`, () => ({ json: [{ database_type: 'PRIMARY', db_user: `postgres.${REF}`, db_host: 'aws-0-us-east-1.pooler.supabase.com', db_name: 'postgres' }] })],
      ['GET', `${API}/projects/${REF}/config/auth`, () => ({ json: { site_url: siteUrl, uri_allow_list: redirects, external_google_secret: secret } })],
      ['PATCH', `${API}/projects/${REF}/config/auth`, (c) => { const b = c.body as { site_url: string; uri_allow_list: string }; siteUrl = b.site_url; redirects = b.uri_allow_list; return { json: {} }; }],
      ['GET', `${API}/projects/${REF}/postgrest`, () => ({ json: { db_schema: 'public' } })],
      ['POST', `${API}/projects/${REF}/database/query/read-only`, () => ({ json: [{ schema: 'public', name: 'notes', rls: true, policies: [] }] })],
      ['GET', `${API}/projects/${REF}/advisors/security`, () => ({ json: { lints: [] } })],
    ]);
    const ctx = testCtx({ exec: ex.run, http, env, config: { stack: { db: 'supabase', auth: 'supabase' } } });
    const auth = await supabaseAdapter.auth(ctx);
    expect(auth).toEqual({ ok: true, via: 'supabase CLI browser login (production profile; Management API) (alice)' });
    const target = await caps.project.creationTarget!(ctx);
    expect(calls.every((c) => c.method === 'GET')).toBe(true);
    expect(await caps.project.create!(ctx, 'demo', target)).toMatchObject({ id: REF, scope: { id: 'acme' } });
    const out = await caps.outputs.outputs(ctx, 'production');
    expect(out['supabase.publishableKey']).toBe(pub);
    expect(out['supabase.secretKey']).toBeInstanceOf(Secret);
    expect((out['db.url'] as Secret).reveal()).toContain(':6543/postgres');
    expect((out['db.directUrl'] as Secret).reveal()).toContain(':5432/postgres');
    expect(await caps.authConfig.get(ctx)).toMatchObject({ siteUrl: 'http://localhost:3000' });
    await caps.authConfig.set(ctx, { siteUrl: 'https://demo.example', redirectUrls: ['https://demo.example/**'] });
    expect(await caps.authConfig.get(ctx)).toEqual({ siteUrl: 'https://demo.example', redirectUrls: ['https://demo.example/**'] });
    expect(await caps.dbAdmin.tables(ctx)).toMatchObject([{ name: 'notes', rls: true }]);
    expect(await caps.dbAdmin.advisors!(ctx)).toEqual([]);
    expect(calls.every((c) => c.headers.authorization === `Bearer ${TOKEN}`)).toBe(true);
    expect(ex.calls).toHaveLength(1); // only --version; no credential-bearing CLI operation
    expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ site_url: 'https://demo.example', uri_allow_list: 'https://demo.example/**' });
    const serialized = JSON.stringify([auth, target, out, ctx.state.get(), ctx.logs, ex.calls]);
    for (const value of [TOKEN, secret, vaultGet(`supabase.dbPass:${REF}`)!.reveal()]) expect(serialized).not.toContain(value);
    expect(readFileSync(join(root, 'access-token'), 'utf8')).toBe(TOKEN);
  });

  it('rejects an expired stored credential without using another store/account or requesting a new PAT', async () => {
    const { env } = store();
    const ex = mockExec([[...version]]);
    const { http, calls } = mockHttp([['GET', `${API}/profile`, () => ({ status: 401, json: { message: TOKEN } })]]);
    const result = await supabaseAdapter.auth(testCtx({ exec: ex.run, http, env }));
    expect(result.ok).toBe(false);
    expect(result.howToFix).toMatch(/Refresh the browser login/);
    expect(result.howToFix).not.toContain('account/tokens');
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(calls).toHaveLength(1);
    expect(ex.calls).toHaveLength(1);
  });

  it('keeps an explicit rejected token authoritative despite a valid stored browser login', async () => {
    const { env } = store();
    const ex = mockExec([]);
    const { http, calls } = mockHttp([['GET', `${API}/profile`, () => ({ status: 401 })]]);
    const result = await supabaseAdapter.auth(testCtx({ exec: ex.run, http, env, tokens: { SUPABASE_ACCESS_TOKEN: OTHER } }));
    expect(result.ok).toBe(false);
    expect(calls[0]!.headers.authorization).toBe(`Bearer ${OTHER}`);
    expect(result.howToFix).toContain('never falls back after a rejected explicit token');
    expect(ex.calls).toHaveLength(0);
  });

  it('retains scoped-project verification with a reused browser credential when /profile is forbidden', async () => {
    const { env } = store();
    const ex = mockExec([[...version]]);
    const { http, calls } = mockHttp([
      ['GET', `${API}/profile`, () => ({ status: 403 })],
      ['GET', `${API}/projects`, () => ({ json: [{ ref: REF, name: 'existing', organization_slug: 'acme' }] })],
    ]);
    const ctx = testCtx({ exec: ex.run, http, env, config: { stack: { db: 'supabase', auth: 'supabase' }, projects: { db: REF } } });
    const result = await supabaseAdapter.auth(ctx);
    expect(result.ok).toBe(true);
    expect(result.via).toContain('supabase CLI browser login');
    expect(result.via).toContain(`project-scoped access verified for ${REF}`);
    expect(result.via).toContain('organization/creation access not verified');
    expect(calls.every((c) => c.method === 'GET')).toBe(true);
  });

  it('surfaces unsafe storage as a blocking auth result without trying API or legacy CLI calls', async () => {
    const { root, env } = store();
    chmodSync(join(root, 'access-token'), 0o644);
    const ex = mockExec([[...version]]);
    const { http, calls } = mockHttp([]);
    const result = await supabaseAdapter.auth(testCtx({ exec: ex.run, http, env }));
    expect(result.ok).toBe(false);
    expect(result.howToFix).toContain('owner-private regular file');
    expect(calls).toHaveLength(0);
    expect(ex.calls).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });
});
