import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockHttp, testCtx } from './helpers.js';
import { dohRoute, fakeAdapter, fakeFetch, jwt } from './check-fakes.js';
import { createHttp } from '../src/core/http.js';
import { _resetSecretRegistry, fingerprint, Secret } from '../src/core/secret.js';
import type { Adapter, AuthSettings, Check, Ctx, DnsRecord, TableInfo } from '../src/core/types.js';
import { ALL_CHECKS } from '../src/checks/all.js';
import { accountsCheck } from '../src/checks/accounts.js';
import { envParityCheck } from '../src/checks/env-parity.js';
import { bundleSecretsCheck } from '../src/checks/bundle-secrets.js';
import { scanSecrets, scriptUrls, findPublicSupabaseKeys, fetchBundle, MAX_BYTES, MAX_CHUNKS } from '../src/checks/bundle.js';
import { rlsCheck, MAX_TABLES } from '../src/checks/rls.js';
import { webhookRegisteredCheck, webhookUnsignedCheck } from '../src/checks/webhook.js';
import { stripeLiveReadyCheck } from '../src/checks/stripe-live.js';
import { authRedirectsCheck } from '../src/checks/auth-redirects.js';
import { authPolicyCheck } from '../src/checks/auth.js';
import { authSignupCheck } from '../src/checks/auth-signup.js';
import { emailDnsCheck, emailVerifiedCheck } from '../src/checks/email.js';
import { domainLiveCheck } from '../src/checks/domain.js';
import { addressDomain, confirmedProductionUrl, globMatch, hostVariants } from '../src/checks/util.js';
import { restProbe, accountStatus } from '../src/checks/providers.js';

vi.mock('../src/checks/providers.js', () => ({ restProbe: vi.fn(), accountStatus: vi.fn(), authedRestProbe: vi.fn() }));
const probeMock = vi.mocked(restProbe);
const accountMock = vi.mocked(accountStatus);

beforeEach(() => {
  _resetSecretRegistry();
  probeMock.mockReset();
  accountMock.mockReset();
});

const PROD = 'https://app.example.com';
const hosting = (over: Partial<Adapter['capabilities']> = {}, url: string | null = PROD) =>
  fakeAdapter({ id: 'vercel', axes: ['hosting'], capabilities: { url: { get: async () => url }, ...over } });

async function run(check: Check, ctx: Ctx) {
  expect(check.applies(ctx)).toBe(true);
  return check.run(ctx);
}

/** Everything a human or agent would read from a check result, as one string. */
const printable = (r: { evidence: string[]; fix?: string }) => JSON.stringify(r);

describe('ALL_CHECKS', () => {
  it('exports every check id exactly once', () => {
    const ids = ALL_CHECKS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.sort()).toEqual(
      ['accounts', 'auth-policy', 'auth-recovery', 'auth-redirects', 'auth-session', 'auth-signup', 'bundle-secrets', 'db-connection', 'domain-live', 'email-dns', 'email-verified', 'env-parity', 'netlify-public-access', 'rls-probe', 'stripe-live-ready', 'webhook-registered', 'webhook-unsigned'].sort(),
    );
  });
});

describe('util', () => {
  it('globMatch follows Supabase redirect glob semantics', () => {
    expect(globMatch('https://app.example.com/**', 'https://app.example.com/auth/callback')).toBe(true);
    expect(globMatch('https://*.example.com/**', 'https://app.example.com/x')).toBe(true);
    expect(globMatch('https://*.example.com', 'https://a.b.example.com')).toBe(false);
    expect(globMatch('https://app.example.com/auth/callback/', 'https://app.example.com/auth/callback')).toBe(true);
    expect(globMatch('https://evil.com/**', 'https://app.example.com/x')).toBe(false);
  });
  it('addressDomain parses bare and named addresses', () => {
    expect(addressDomain('hello@Example.com')).toBe('example.com');
    expect(addressDomain('App <noreply@mail.example.com>')).toBe('mail.example.com');
    expect(addressDomain(undefined)).toBeUndefined();
  });
});

// ── accounts ────────────────────────────────────────────────────────────────────────────────────

describe('accounts', () => {
  it('passes when every automated adapter is authenticated (once per adapter)', async () => {
    const auth = vi.fn(async () => ({ ok: true, via: 'supabase CLI' }));
    const supa = fakeAdapter({ id: 'supabase', axes: ['db', 'auth'], auth });
    const ctx = testCtx({ config: { stack: { hosting: 'vercel', db: 'supabase', auth: 'supabase', monitoring: 'sentry' } }, adapters: [hosting(), supa] });
    const r = await run(accountsCheck, ctx);
    expect(r.status).toBe('pass');
    expect(auth).toHaveBeenCalledTimes(1);
    expect(r.evidence.join('\n')).toMatch(/supabase \(db, auth\): ok via supabase CLI/);
    expect(r.evidence.join('\n')).toMatch(/sentry.*guided/);
  });

  it('fails listing howToFix for a provider that is not logged in', async () => {
    const stripe = fakeAdapter({ id: 'stripe', axes: ['payments'], auth: { ok: false, howToFix: 'run `stripe login` in your terminal' } });
    const ctx = testCtx({ config: { stack: { hosting: 'vercel', payments: 'stripe' } }, adapters: [hosting(), stripe] });
    const r = await run(accountsCheck, ctx);
    expect(r.status).toBe('fail');
    expect(r.severity).toBe('high');
    expect(r.fix).toContain('run `stripe login` in your terminal');
    expect(r.fix).toMatch(/never paste tokens/);
  });

  it('treats a throwing auth() as not connected, with a secret-free message', async () => {
    const TOKEN = 'sbp_' + 'a'.repeat(40);
    const bad = fakeAdapter({ id: 'supabase', axes: ['db'], auth: async () => { throw new Error(`boom ${TOKEN}`); } });
    const ctx = testCtx({ config: { stack: { db: 'supabase' } }, adapters: [bad] });
    const r = await run(accountsCheck, ctx);
    expect(r.status).toBe('fail');
    expect(printable(r)).not.toContain(TOKEN);
  });

  it('does not apply to an empty stack', () => {
    expect(accountsCheck.applies(testCtx())).toBe(false);
  });
});

// ── env-parity ──────────────────────────────────────────────────────────────────────────────────

describe('env-parity', () => {
  const refs = [
    { name: 'DATABASE_URL', files: ['lib/db.ts'], clientExposed: false },
    { name: 'NEXT_PUBLIC_SUPABASE_URL', files: ['lib/supa.ts'], clientExposed: true },
    { name: 'OPENAI_API_KEY', files: ['app/api/chat.ts'], clientExposed: false },
    { name: 'NODE_ENV', files: ['x.ts'], clientExposed: false },
    { name: 'EDGE_ONLY', files: ['supabase/functions/hook/index.ts'], clientExposed: false },
  ];
  const envCtx = (names: Record<string, string[]>) =>
    testCtx({
      config: { stack: { hosting: 'vercel' } },
      detect: { envRefs: refs },
      adapters: [hosting({ env: { listNames: async (_c, t) => names[t] ?? [], set: async () => {} } })],
    });

  it('passes when every referenced name exists for each target', async () => {
    const all = ['DATABASE_URL', 'NEXT_PUBLIC_SUPABASE_URL', 'OPENAI_API_KEY'];
    const r = await run(envParityCheck, envCtx({ preview: all, production: all }));
    expect(r.status).toBe('pass');
  });

  it('fails (high) when a mapped name is missing', async () => {
    const r = await run(envParityCheck, envCtx({ preview: ['DATABASE_URL', 'NEXT_PUBLIC_SUPABASE_URL', 'OPENAI_API_KEY'], production: ['OPENAI_API_KEY', 'NEXT_PUBLIC_SUPABASE_URL'] }));
    expect(r.status).toBe('fail');
    expect(r.severity).toBe('high');
    expect(r.evidence.join('\n')).toContain('production: missing DATABASE_URL');
    expect(r.evidence.join('\n')).not.toContain('EDGE_ONLY'); // edge function secrets live in Supabase
  });

  it('warns when only unmapped names are missing', async () => {
    const mapped = ['DATABASE_URL', 'NEXT_PUBLIC_SUPABASE_URL'];
    const r = await run(envParityCheck, envCtx({ preview: mapped, production: mapped }));
    expect(r.status).toBe('warn');
    expect(r.evidence.join('\n')).toContain('OPENAI_API_KEY');
  });

  it('skips when hosting has no env capability', async () => {
    const ctx = testCtx({ config: { stack: { hosting: 'netlify' } }, detect: { envRefs: refs } });
    expect((await run(envParityCheck, ctx)).status).toBe('skip');
  });
});

// ── bundle-secrets ──────────────────────────────────────────────────────────────────────────────

describe('bundle-secrets', () => {
  const html = (scripts: string[]) =>
    `<!doctype html><html><head>${scripts.map((s) => `<script src="${s}" defer></script>`).join('')}<link rel="modulepreload" href="/assets/pre.js"><script src="https://cdn.other.com/x.js"></script></head></html>`;

  it('extracts same-origin scripts and modulepreload links only', () => {
    const urls = scriptUrls(html(['/_next/a.js', 'b.js?v=1&amp;x=2']), `${PROD}/`);
    expect(urls).toEqual([`${PROD}/_next/a.js`, `${PROD}/b.js?v=1&x=2`, `${PROD}/assets/pre.js`]);
  });

  it('passes on a clean bundle; anon JWTs and publishable keys are fine', async () => {
    const anon = jwt({ role: 'anon', ref: 'abcd' });
    const { http, calls } = mockHttp([
      ['GET', `${PROD}/`, () => ({ text: html(['/a.js']) })],
      ['GET', `${PROD}/a.js`, () => ({ text: `const k="${anon}";const p="sb_publishable_abcdefghijklmnop";const pk="pk_live_123"` })],
      ['GET', `${PROD}/assets/pre.js`, () => ({ text: 'x' })],
    ]);
    const r = await run(bundleSecretsCheck, testCtx({ http, config: { stack: { hosting: 'vercel' } }, adapters: [hosting()] }));
    expect(r.status).toBe('pass');
    expect(calls.every((c) => c.method === 'GET')).toBe(true);
    expect(calls.some((c) => c.url.includes('cdn.other.com'))).toBe(false);
  });

  it('fails critical on leaked keys and never puts the value in evidence', async () => {
    const SK = 'sk_live_' + 'Z9'.repeat(12);
    const SERVICE = jwt({ role: 'service_role', ref: 'abcd', iss: 'supabase' });
    // Header marker only: no private-key bytes exist in this fixture.
    const PEM = '-'.repeat(5) + ['BEGIN', 'PRIVATE', 'KEY'].join(' ') + '-'.repeat(5);
    const { http } = mockHttp([
      ['GET', `${PROD}/`, () => ({ text: html(['/a.js']) })],
      ['GET', `${PROD}/a.js`, () => ({ text: `fetch(x,{headers:{a:"${SK}"}});const s="${SERVICE}";` })],
      ['GET', `${PROD}/assets/pre.js`, () => ({ text: `const k=\`${PEM}\nMIIE\`` })],
    ]);
    const ctx = testCtx({ http, config: { stack: { hosting: 'vercel' } }, adapters: [hosting()] });
    const r = await run(bundleSecretsCheck, ctx);
    expect(r.status).toBe('fail');
    expect(r.severity).toBe('critical');
    const out = printable(r);
    expect(out).toContain(`Stripe secret key (live) in /a.js (fp:${fingerprint(SK)})`);
    expect(out).toContain(`Supabase service_role JWT in /a.js (fp:${fingerprint(SERVICE)})`);
    expect(out).toContain('private key (PEM) in /assets/pre.js');
    expect(out).not.toContain(SK);
    expect(out).not.toContain(SERVICE);
    expect(out).not.toContain(SERVICE.split('.')[1]!);
    expect(ctx.logs.join('\n')).not.toContain(SK);
  });

  it('detects every credential family', () => {
    const text = [
      'rk_test_' + 'a'.repeat(20),
      'whsec_' + 'b'.repeat(24),
      'sb_secret_' + 'c'.repeat(20),
      'sbp_' + 'd'.repeat(40),
      're' + '_abcdefgh_ijklmnopqrst',
      'AK' + 'IAABCDEFGHIJKLMNOP',
      '-----BEGIN RSA PRIVATE KEY-----',
    ].join(' ');
    const kinds = scanSecrets({ path: '/x.js', text }).map((h) => h.kind);
    expect(kinds).toEqual(['Stripe restricted key (test)', 'Stripe webhook signing secret', 'Supabase secret key', 'Supabase personal access token', 'Resend API key', 'AWS access key id', 'private key (PEM)']);
  });

  it('warns when the crawl reaches MAX_CHUNKS scripts', async () => {
    const many = Array.from({ length: MAX_CHUNKS + 5 }, (_, i) => `/c${i}.js`);
    const { http, calls } = mockHttp([
      ['GET', `${PROD}/`, () => ({ text: html(many) })],
      ['GET', /^https:\/\/app\.example\.com\/(c\d+|assets\/pre)\.js$/, () => ({ text: 'ok' })],
    ]);
    const r = await run(bundleSecretsCheck, testCtx({ http, config: { stack: { hosting: 'vercel' } }, adapters: [hosting()] }));
    expect(r.status).toBe('warn');
    expect(r.evidence.join('\n')).toContain('scan incomplete');
    expect(calls.length).toBe(1 + MAX_CHUNKS);
    expect(r.evidence.join('\n')).toContain(`scanned the first ${MAX_CHUNKS}`);
  });

  it.each(['http', 'throw'])('warns when a public script is unavailable via %s', async (failure) => {
    const { http } = mockHttp([
      ['GET', `${PROD}/`, () => ({ text: '<script src="/main.js"></script>' })],
      ['GET', `${PROD}/main.js`, () => {
        if (failure === 'throw') throw new Error('untrusted transport detail must not be echoed');
        return { status: 503, text: 'unavailable' };
      }],
    ]);
    const r = await run(bundleSecretsCheck, testCtx({ http, config: { stack: { hosting: 'vercel' } }, adapters: [hosting()] }));
    expect(r.status).toBe('warn');
    expect(r.evidence.join('\n')).toContain('scan incomplete');
    expect(r.evidence.join('\n')).toContain(failure === 'http' ? '/main.js: HTTP 503' : '/main.js: fetch failed');
    expect(printable(r)).not.toContain('untrusted transport detail');
  });

  it('still fails critical when another asset exposes a secret during an incomplete scan', async () => {
    const syntheticKey = 'sk_test_' + 'fixture'.repeat(4);
    const { http } = mockHttp([
      ['GET', `${PROD}/`, () => ({ text: '<script src="/failed.js"></script><script src="/leak.js"></script>' })],
      ['GET', `${PROD}/failed.js`, () => ({ status: 503 })],
      ['GET', `${PROD}/leak.js`, () => ({ text: `const synthetic = "${syntheticKey}"` })],
    ]);
    const r = await run(bundleSecretsCheck, testCtx({ http, config: { stack: { hosting: 'vercel' } }, adapters: [hosting()] }));
    expect(r.status).toBe('fail');
    expect(r.severity).toBe('critical');
    expect(r.evidence.join('\n')).toContain('/failed.js: HTTP 503');
    expect(printable(r)).not.toContain(syntheticKey);
  });

  it('warns when a script exceeds the UTF-8 byte budget and does not fetch later scripts', async () => {
    const { http, calls } = mockHttp([
      ['GET', `${PROD}/`, () => ({ text: '<script src="/large.js"></script><script src="/later.js"></script>' })],
      ['GET', `${PROD}/large.js`, () => ({ text: '界'.repeat(Math.floor(MAX_BYTES / 3) + 1) })],
    ]);
    const r = await run(bundleSecretsCheck, testCtx({ http, config: { stack: { hosting: 'vercel' } }, adapters: [hosting()] }));
    expect(r.status).toBe('warn');
    expect(r.evidence.join('\n')).toContain('scan incomplete');
    expect(r.evidence.join('\n')).toContain('/large.js: truncated');
    expect(calls).toHaveLength(2);
  });

  it('bounds oversized HTML itself and marks the scan incomplete without fetching scripts', async () => {
    const { http, calls } = mockHttp([
      ['GET', `${PROD}/`, () => ({ text: '<script src="/main.js"></script>' + ' '.repeat(MAX_BYTES) })],
    ]);
    const ctx = testCtx({ http, config: { stack: { hosting: 'vercel' } }, adapters: [hosting()] });
    const bundle = await fetchBundle(ctx, PROD);
    expect(bundle.complete).toBe(false);
    expect(bundle.files.reduce((total, file) => total + Buffer.byteLength(file.text), 0)).toBeLessThanOrEqual(MAX_BYTES);
    expect(bundle.notes.join('\n')).toContain('HTML truncated');
    expect(calls).toHaveLength(1);
    const r = await run(bundleSecretsCheck, ctx);
    expect(r.status).toBe('warn');
  });

  it('keeps detected-secret failure when the secret appears before byte truncation', async () => {
    const syntheticKey = 'sk_test_' + 'fixture'.repeat(4);
    const { http } = mockHttp([
      ['GET', `${PROD}/`, () => ({ text: '<script src="/large.js"></script>' })],
      ['GET', `${PROD}/large.js`, () => ({ text: `${syntheticKey};` + ' '.repeat(MAX_BYTES) })],
    ]);
    const r = await run(bundleSecretsCheck, testCtx({ http, config: { stack: { hosting: 'vercel' } }, adapters: [hosting()] }));
    expect(r.status).toBe('fail');
    expect(r.severity).toBe('critical');
    expect(r.evidence.join('\n')).toContain('truncated');
    expect(printable(r)).not.toContain(syntheticKey);
  });

  it('passes a complete static HTML page with no script assets', async () => {
    const { http, calls } = mockHttp([['GET', `${PROD}/`, () => ({ text: '<h1>Static page</h1>' })]]);
    const r = await run(bundleSecretsCheck, testCtx({ http, config: { stack: { hosting: 'vercel' } }, adapters: [hosting()] }));
    expect(r.status).toBe('pass');
    expect(calls).toHaveLength(1);
  });

  it('skips without a production URL and warns when the page is down', async () => {
    expect((await run(bundleSecretsCheck, testCtx({ config: { stack: { hosting: 'vercel' } }, adapters: [hosting({}, null)] }))).status).toBe('skip');
    const { http } = mockHttp([['GET', `${PROD}/`, () => ({ status: 500, text: 'err' })]]);
    const r = await run(bundleSecretsCheck, testCtx({ http, config: { stack: { hosting: 'vercel' } }, adapters: [hosting()] }));
    expect(r.status).toBe('warn');
  });

  it('finds public Supabase keys for the RLS probe, filtered by project ref', () => {
    const mine = jwt({ role: 'anon', ref: 'abcd' });
    const other = jwt({ role: 'anon', ref: 'zzzz' });
    expect(findPublicSupabaseKeys([{ path: '/', text: `${other} ${mine}` }], 'abcd')).toEqual([mine]);
  });
});

// ── rls-probe ───────────────────────────────────────────────────────────────────────────────────

describe('rls-probe', () => {
  const table = (name: string, rls: boolean, policies: TableInfo['policies'] = []): TableInfo => ({ schema: 'public', name, rls, policies });
  const PK = 'sb_publishable_' + 'k'.repeat(20);
  const supa = (tables: TableInfo[], extra: Partial<Adapter['capabilities']> = {}) =>
    fakeAdapter({
      id: 'supabase',
      axes: ['db', 'auth'],
      capabilities: {
        dbAdmin: { tables: async () => tables, advisors: async () => [] },
        outputs: { outputs: async () => ({ 'supabase.publishableKey': PK }) },
        ...extra,
      },
    });
  const rlsCtx = (a: Adapter, http = mockHttp([]).http) =>
    testCtx({ http, config: { stack: { hosting: 'vercel', db: 'supabase' } }, state: { version: 1, resources: { 'supabase.ref': 'abcd' }, secrets: {}, steps: {} }, adapters: [hosting(), a] });

  it('passes when every exposed table denies anonymous reads', async () => {
    probeMock.mockResolvedValue({ status: 401, rows: 0 });
    const r = await run(rlsCheck, rlsCtx(supa([table('todos', true), table('profiles', true), { schema: 'auth', name: 'users', rls: true, policies: [] }])));
    expect(r.status).toBe('pass');
    expect(probeMock).toHaveBeenCalledTimes(2); // internal schemas are not probed
    expect(probeMock).toHaveBeenCalledWith(expect.anything(), 'abcd', 'todos', 'public', PK);
  });

  it('fails critical when anyone can read rows', async () => {
    probeMock.mockImplementation(async (_c, _r, t) => (t === 'orders' ? { status: 200, rows: 1 } : { status: 200, rows: 0 }));
    const r = await run(rlsCheck, rlsCtx(supa([table('orders', true), table('todos', true)])));
    expect(r.status).toBe('fail');
    expect(r.severity).toBe('critical');
    expect(r.evidence[0]).toBe('anyone can read public.orders (anonymous GET returned rows)');
  });

  it('fails high when an exposed table has RLS off, even if empty', async () => {
    probeMock.mockResolvedValue({ status: 200, rows: 0 });
    const r = await run(rlsCheck, rlsCtx(supa([table('empty', false)])));
    expect(r.status).toBe('fail');
    expect(r.severity).toBe('high');
    expect(r.evidence[0]).toContain('public.empty is exposed with RLS disabled');
  });

  it('treats 403/404 as not readable even with RLS off (not exposed)', async () => {
    probeMock.mockResolvedValue({ status: 404, rows: 0 });
    expect((await run(rlsCheck, rlsCtx(supa([table('hidden', false)])))).status).toBe('pass');
  });

  it('warns on an open `using (true)` read policy and folds in advisors', async () => {
    probeMock.mockResolvedValue({ status: 200, rows: 0 });
    const t = table('posts', true, [{ name: 'public read', command: 'SELECT', permissive: true, roles: ['anon'], using: 'true' }]);
    const r = await run(rlsCheck, rlsCtx(supa([t])));
    expect(r.status).toBe('warn');
    expect(r.evidence.join('\n')).toContain('policy "public read"');

    const withAdvisor = supa([t], {
      dbAdmin: { tables: async () => [t], advisors: async () => [{ id: 'rls_disabled_in_public', severity: 'high', title: 'RLS disabled in public', evidence: ['public.x'] }] },
    });
    const r2 = await run(rlsCheck, rlsCtx(withAdvisor));
    expect(r2.status).toBe('fail');
    expect(r2.evidence.join('\n')).toContain('advisor: RLS disabled in public (public.x)');
  });

  it('probes at most MAX_TABLES tables', async () => {
    probeMock.mockResolvedValue({ status: 403, rows: 0 });
    const many = Array.from({ length: MAX_TABLES + 3 }, (_, i) => table(`t${i}`, true));
    const r = await run(rlsCheck, rlsCtx(supa(many)));
    expect(probeMock).toHaveBeenCalledTimes(MAX_TABLES);
    expect(r.status).toBe('pass');
    expect(r.evidence.join('\n')).toContain('3 table(s) beyond');
  });

  it('preserves Auth advisor remediation without suggesting RLS changes for denied reads', async () => {
    probeMock.mockResolvedValue({ status: 401, rows: 0 });
    const t = table('wins', true);
    const a = supa([t], {
      dbAdmin: { tables: async () => [t], advisors: async () => [{
        id: 'supabase.advisor.auth_leaked_password_protection', severity: 'medium',
        title: 'Leaked Password Protection Disabled', evidence: ['Auth password protection is disabled'],
        fix: 'See https://supabase.com/docs/guides/auth/password-security',
      }] },
    });
    const r = await run(rlsCheck, rlsCtx(a));
    expect(r.status).toBe('warn');
    expect(r.evidence.join('\n')).toContain('probed 1/1 table(s)');
    expect(r.fix).toContain('Leaked Password Protection Disabled: See https://supabase.com/docs/guides/auth/password-security');
    expect(r.fix).not.toContain('Enable RLS');
  });

  it('keeps table remediation alongside advisors, with a fallback for missing provider guidance', async () => {
    probeMock.mockResolvedValue({ status: 200, rows: 1 });
    const t = table('wins', true);
    const a = supa([t], {
      dbAdmin: { tables: async () => [t], advisors: async () => [{
        id: 'other-advisor', severity: 'medium', title: 'Other project warning', evidence: [],
      }] },
    });
    const r = await run(rlsCheck, rlsCtx(a));
    expect(r.status).toBe('fail');
    expect(r.severity).toBe('critical');
    expect(r.fix).toContain('Enable RLS');
    expect(r.fix).toContain('Other project warning: Review this finding in the Supabase Security Advisor');
  });

  it('falls back to the publishable key in the public bundle', async () => {
    probeMock.mockResolvedValue({ status: 401, rows: 0 });
    const anon = jwt({ role: 'anon', ref: 'abcd' });
    const { http } = mockHttp([['GET', `${PROD}/`, () => ({ text: `<script>window.k="${anon}"</script>` })]]);
    const a = fakeAdapter({ id: 'supabase', axes: ['db'], capabilities: { dbAdmin: { tables: async () => [table('todos', true)] } } });
    const r = await run(rlsCheck, rlsCtx(a, http));
    expect(r.status).toBe('pass');
    expect(probeMock).toHaveBeenCalledWith(expect.anything(), 'abcd', 'todos', 'public', anon);
    expect(r.evidence.join('\n')).toContain('from the public bundle');
  });

  it('skips (blocked by project:db) when no project is linked; does not apply to other databases', async () => {
    const ctx = testCtx({ config: { stack: { db: 'supabase' } }, adapters: [supa([])] });
    const r = await run(rlsCheck, ctx);
    expect(r.status).toBe('skip');
    expect(r.evidence[0]).toMatch(/^blocked by: project:db/);
    expect(rlsCheck.applies(testCtx({ config: { stack: { db: 'neon' } } }))).toBe(false);
  });
});

// ── webhooks ────────────────────────────────────────────────────────────────────────────────────

describe('webhook-unsigned', () => {
  const HOOK = `${PROD}/api/webhooks/stripe`;
  const cfg = { stack: { hosting: 'vercel', payments: 'stripe' }, payments: { webhook: { path: '/api/webhooks/stripe', events: ['checkout.session.completed'] } } };
  const withStatus = async (status: number, text = '') => {
    const { http, calls } = mockHttp([['POST', HOOK, () => ({ status, text })]]);
    const r = await run(webhookUnsignedCheck, testCtx({ http, config: cfg, adapters: [hosting()] }));
    return { r, calls };
  };

  it('passes on a non-HTML 400 and sends only {} with no signature', async () => {
    const { r, calls } = await withStatus(400, '{"error":"bad sig"}');
    expect(r.status).toBe('pass');
    expect(calls[0]!.body).toEqual({});
    expect(calls[0]!.headers['stripe-signature']).toBeUndefined();
  });

  it('warns (high) on a JSON 401/403: an auth wall and a signature rejection are indistinguishable', async () => {
    for (const s of [401, 403]) {
      const { r } = await withStatus(s, '{"error":"unauthorized"}');
      expect(r.status).toBe('warn');
      expect(r.severity).toBe('high');
      const ev = r.evidence.join('\n');
      expect(ev).toMatch(/may be your handler/);
      expect(ev).toMatch(/auth wall/);
      // (a) prove Stripe can reach the route and the handler answers 400 — Stripe counts 401/403 as
      // failed deliveries, which is why this can't pass; (b) the warning is benign if 403 is deliberate.
      expect(r.fix).toMatch(/verify_jwt = false/);
      expect(r.fix).toMatch(/returns 400/);
      expect(r.fix).toMatch(/failed deliveries/);
      expect(r.fix).toMatch(/intentionally returns 403.*expected/);
    }
  });

  it('warns (medium) when the probe is rate-limited', async () => {
    const { r } = await withStatus(429);
    expect(r.status).toBe('warn');
    expect(r.severity).toBe('medium');
  });

  it.each([
    [200, 'fail', 'critical'],
    [204, 'fail', 'critical'],
    [301, 'fail', 'high'],
    [308, 'fail', 'high'],
    [404, 'fail', 'high'],
    [500, 'fail', 'high'],
  ])('HTTP %i → %s (%s)', async (status, want, sev) => {
    const { r } = await withStatus(status);
    expect(r.status).toBe(want);
    expect(r.severity).toBe(sev);
  });

  it('redirect and 5xx fixes explain why', async () => {
    expect((await withStatus(307)).r.fix).toMatch(/does not follow redirects/);
    expect((await withStatus(502)).r.fix).toMatch(/Verify the Stripe signature first/);
  });

  it('warns (medium) when a 401/403 is an HTML auth wall, not the handler', async () => {
    for (const s of [401, 403]) {
      const { r } = await withStatus(s, '<!doctype html><html>Authentication Required</html>');
      expect(r.status).toBe('warn');
      expect(r.severity).toBe('medium');
      expect(r.evidence.join('\n')).toMatch(/HTML page/);
    }
  });

  it('POSTs to the host-confirmed custom domain, and skips without a URL', async () => {
    const { http, calls } = mockHttp([['POST', 'https://shop.example.com/api/webhooks/stripe', () => ({ status: 400 })]]);
    const r = await run(webhookUnsignedCheck, testCtx({ http, config: { ...cfg, domain: 'shop.example.com' }, adapters: [hosting({}, 'https://shop.example.com')] }));
    expect(r.status).toBe('pass');
    expect(calls).toHaveLength(1);
    expect((await run(webhookUnsignedCheck, testCtx({ config: cfg }))).status).toBe('skip');
    expect(webhookUnsignedCheck.applies(testCtx({ config: { stack: { payments: 'stripe' } } }))).toBe(false);
  });
});

describe('webhook-registered', () => {
  const cfg = { stack: { hosting: 'vercel', payments: 'stripe' }, payments: { webhook: { path: '/api/stripe', events: ['checkout.session.completed', 'invoice.paid'] } } };
  const stripeWith = (eps: Array<{ id: string; url: string; events: string[]; enabled: boolean }>, seen: string[] = []) =>
    fakeAdapter({
      id: 'stripe',
      axes: ['payments'],
      capabilities: {
        webhooks: {
          ensure: async () => { throw new Error('must not write'); },
          list: async (_c, mode) => { seen.push(mode); return eps; },
        },
      },
    });

  it('passes with an enabled endpoint covering all events (live mode for production)', async () => {
    const seen: string[] = [];
    const a = stripeWith([{ id: 'we_1', url: `${PROD}/api/stripe`, events: ['checkout.session.completed', 'invoice.paid', 'x'], enabled: true }], seen);
    const r = await run(webhookRegisteredCheck, testCtx({ config: cfg, adapters: [hosting(), a] }));
    expect(r.status).toBe('pass');
    expect(seen).toEqual(['live']);
  });

  it('accepts the * wildcard and honours payments.modes', async () => {
    const seen: string[] = [];
    const a = stripeWith([{ id: 'we_1', url: `${PROD}/api/stripe`, events: ['*'], enabled: true }], seen);
    const r = await run(webhookRegisteredCheck, testCtx({ config: { ...cfg, payments: { ...cfg.payments, modes: { production: 'test' } } }, adapters: [hosting(), a] }));
    expect(r.status).toBe('pass');
    expect(seen).toEqual(['test']);
  });

  it('fails when missing, disabled, on another URL, or short of events', async () => {
    type Ep = { id: string; url: string; events: string[]; enabled: boolean };
    const cases: Array<[Ep[], RegExp]> = [
      [[], /no live-mode endpoint/],
      [[{ id: 'we_1', url: `${PROD}/api/stripe/`, events: ['*'], enabled: true }], /no live-mode endpoint/],
      [[{ id: 'we_1', url: `${PROD}/api/stripe`, events: ['*'], enabled: false }], /disabled/],
      [[{ id: 'we_1', url: `${PROD}/api/stripe`, events: ['invoice.paid'], enabled: true }], /missing events: checkout\.session\.completed/],
    ];
    for (const [eps, re] of cases) {
      const r = await run(webhookRegisteredCheck, testCtx({ config: cfg, adapters: [hosting(), stripeWith(eps)] }));
      expect(r.status).toBe('fail');
      expect(r.evidence.join('\n')).toMatch(re);
    }
  });
});

// ── stripe-live-ready ───────────────────────────────────────────────────────────────────────────

describe('stripe-live-ready', () => {
  const cfg = { stack: { payments: 'stripe' } };
  it('passes when charges are enabled', async () => {
    accountMock.mockResolvedValue({ chargesEnabled: true, detailsSubmitted: true });
    expect((await run(stripeLiveReadyCheck, testCtx({ config: cfg }))).status).toBe('pass');
    expect(accountMock).toHaveBeenCalledWith(expect.anything(), 'live');
  });
  it('fails with activation instructions otherwise', async () => {
    accountMock.mockResolvedValue({ chargesEnabled: false, detailsSubmitted: false });
    const r = await run(stripeLiveReadyCheck, testCtx({ config: cfg }));
    expect(r.status).toBe('fail');
    expect(r.fix).toMatch(/Finish Stripe account activation/);
  });
  it('maps helper errors without leaking secrets', async () => {
    const KEY = 'sk_live_' + 'q'.repeat(24);
    accountMock.mockRejectedValue(new Error(`401 invalid key ${KEY}`));
    const r = await run(stripeLiveReadyCheck, testCtx({ config: cfg }));
    expect(r.status).toBe('fail');
    expect(printable(r)).not.toContain(KEY);
  });
  it('only applies to stripe in live mode', () => {
    expect(stripeLiveReadyCheck.applies(testCtx({ config: { ...cfg, payments: { modes: { production: 'test' } } } }))).toBe(false);
    expect(stripeLiveReadyCheck.applies(testCtx({ config: { stack: { payments: 'polar' } } }))).toBe(false);
  });
});

// ── auth-redirects ──────────────────────────────────────────────────────────────────────────────

describe('auth-redirects', () => {
  const authCtx = (siteUrl: string | null, redirectUrls: string[], over: { redirectPaths?: string[] } = {}) =>
    testCtx({
      config: { stack: { hosting: 'vercel', auth: 'supabase' }, ...(over.redirectPaths ? { auth: { redirectPaths: over.redirectPaths } } : {}) },
      adapters: [hosting(), fakeAdapter({ id: 'supabase', axes: ['auth'], capabilities: { authConfig: { get: async () => ({ siteUrl, redirectUrls }), set: async () => { throw new Error('must not write'); } } } })],
    });

  it('passes when site URL is production and /** is allowlisted', async () => {
    expect((await run(authRedirectsCheck, authCtx(`${PROD}/`, [`${PROD}/**`]))).status).toBe('pass');
  });
  it('fails on a localhost site URL', async () => {
    const r = await run(authRedirectsCheck, authCtx('http://localhost:3000', [`${PROD}/**`]));
    expect(r.status).toBe('fail');
    expect(r.evidence[0]).toMatch(/localhost/);
  });
  it('fails when the site URL is another origin or the allowlist misses production', async () => {
    expect((await run(authRedirectsCheck, authCtx('https://old.example.com', [`${PROD}/**`]))).status).toBe('fail');
    expect((await run(authRedirectsCheck, authCtx(PROD, ['https://old.example.com/**']))).status).toBe('fail');
  });
  it('checks configured redirect paths against globs', async () => {
    expect((await run(authRedirectsCheck, authCtx(PROD, [`${PROD}/auth/*`], { redirectPaths: ['/auth/callback'] }))).status).toBe('pass');
    const r = await run(authRedirectsCheck, authCtx(PROD, [`${PROD}/auth/callback`], { redirectPaths: ['/auth/callback', '/reset/**'] }));
    expect(r.status).toBe('fail');
    expect(r.evidence[0]).toContain(`${PROD}/reset/**`);
  });
  it('warns (not fails) on localhost entries left in the allowlist', async () => {
    expect((await run(authRedirectsCheck, authCtx(PROD, [`${PROD}/**`, 'http://localhost:3000/**']))).status).toBe('warn');
  });
});

// ── auth-policy ─────────────────────────────────────────────────────────────────────────────────

describe('auth-policy', () => {
  const POLICY = {
    siteUrl: PROD,
    redirectUrls: [`${PROD}/**`],
    signupEnabled: true,
    emailConfirmRequired: true,
    minPasswordLength: 12,
    smtp: { configured: true, host: 'smtp.resend.com' },
    emailRateLimitPerHour: 30,
  };
  const policyCtx = (settings: Record<string, unknown>, over: Partial<Parameters<typeof testCtx>[0]> = {}) =>
    testCtx({
      config: { stack: { hosting: 'vercel', auth: 'supabase' } },
      adapters: [hosting(), fakeAdapter({ id: 'supabase', axes: ['auth'], capabilities: { authConfig: { get: async () => settings as unknown as AuthSettings, set: async () => ({ applied: [], skipped: [] }) } } })],
      ...over,
    });

  it('passes and lists the effective policy values', async () => {
    const r = await run(authPolicyCheck, policyCtx(POLICY));
    expect(r.status).toBe('pass');
    const text = r.evidence.join('\n');
    expect(text).toMatch(/signup: open/);
    expect(text).toMatch(/email confirmation: required/);
    expect(text).toMatch(/password minimum length: 12/);
    expect(text).toMatch(/auth email: custom SMTP \(smtp\.resend\.com\)/);
    expect(text).toMatch(/rate limit: 30 auth emails\/hour/);
  });

  it('fails when the settings cannot be read', async () => {
    const ctx = testCtx({
      config: { stack: { auth: 'supabase' } },
      adapters: [fakeAdapter({ id: 'supabase', axes: ['auth'], capabilities: { authConfig: { get: async () => { throw new Error('403 not allowed'); }, set: async () => ({ applied: [], skipped: [] }) } } })],
    });
    const r = await run(authPolicyCheck, ctx);
    expect(r.status).toBe('fail');
    expect(r.severity).toBe('high');
    expect(r.evidence[0]).toContain('403 not allowed');
  });

  it('fails when signup is closed although golive.yaml asks for it', async () => {
    const over = { config: { stack: { hosting: 'vercel', auth: 'supabase' }, auth: { signup: true } } } as const;
    const r = await run(authPolicyCheck, policyCtx({ ...POLICY, signupEnabled: false }, over));
    expect(r.status).toBe('fail');
    expect(r.severity).toBe('high');
    expect(r.evidence[0]).toMatch(/signup is closed although golive\.yaml asks for `auth\.signup: true`/);
    expect(r.evidence.join('\n')).toMatch(/signup: closed/);
    expect(r.fix).toMatch(/set `auth\.signup: false`/);
  });

  it('does not fail for closed signup when the app never signs users up', async () => {
    const r = await run(authPolicyCheck, policyCtx({ ...POLICY, signupEnabled: false }));
    expect(r.status).toBe('pass');
  });

  it('passes when signup is closed exactly as golive.yaml configures it', async () => {
    const over = { config: { stack: { hosting: 'vercel', auth: 'supabase' }, auth: { signup: false } } } as const;
    // The app's code uses this provider, which must not matter: the human asked for closed signup.
    const r = await run(authPolicyCheck, policyCtx({ ...POLICY, signupEnabled: false }, { ...over, detect: { providers: { auth: ['supabase'] } } }));
    expect(r.status).toBe('pass');
    expect(r.evidence.join('\n')).toMatch(/signup is closed as configured \(auth\.signup: false\)/);
  });

  it('warns (medium) when signup is closed, the app uses auth and golive.yaml does not say what it needs', async () => {
    const r = await run(authPolicyCheck, policyCtx({ ...POLICY, signupEnabled: false }, { detect: { providers: { auth: ['supabase'] } } }));
    expect(r.status).toBe('warn');
    expect(r.severity).toBe('medium');
    const text = r.evidence.join('\n');
    expect(text).toMatch(/signup is closed while this app's code uses supabase auth and golive\.yaml does not say whether it takes new users/);
    expect(text).not.toMatch(/the app's code signs users up/);
    expect(r.fix).toMatch(/`auth\.signup: true`/);
    expect(r.fix).toMatch(/`auth\.signup: false`/);
  });

  it('warns when signup is open although golive.yaml says `auth.signup: false`', async () => {
    const over = { config: { stack: { hosting: 'vercel', auth: 'supabase' }, auth: { signup: false } } } as const;
    const r = await run(authPolicyCheck, policyCtx(POLICY, over));
    expect(r.status).toBe('warn');
    expect(r.severity).toBe('medium');
    expect(r.evidence[0]).toMatch(/signup is open although golive\.yaml says `auth\.signup: false`/);
    expect(r.evidence.join('\n')).toMatch(/signup: open/);
    expect(r.fix).toMatch(/set `auth\.signup: true`/);
  });

  it('fails when email confirmation is off against auth.requireEmailConfirm', async () => {
    const over = { config: { stack: { hosting: 'vercel', auth: 'supabase' }, auth: { requireEmailConfirm: true } } } as const;
    const r = await run(authPolicyCheck, policyCtx({ ...POLICY, emailConfirmRequired: false }, over));
    expect(r.status).toBe('fail');
    expect(r.evidence[0]).toMatch(/auth.requireEmailConfirm: true/);
  });

  it('fails when the password minimum is below the configured floor', async () => {
    const over = { config: { stack: { hosting: 'vercel', auth: 'supabase' }, auth: { passwordMinLength: 10 } } } as const;
    const r = await run(authPolicyCheck, policyCtx({ ...POLICY, minPasswordLength: 8 }, over));
    expect(r.status).toBe('fail');
    expect(r.evidence[0]).toMatch(/below the floor golive.yaml asks for \(auth.passwordMinLength: 10\)/);
    expect(r.fix).toMatch(/lower `auth\.passwordMinLength`/);
  });

  it('warns on a short password minimum, a built-in mailer and confirmation off in production', async () => {
    const r = await run(authPolicyCheck, policyCtx({ ...POLICY, minPasswordLength: 6, emailConfirmRequired: false, smtp: { configured: false } }));
    expect(r.status).toBe('warn');
    expect(r.severity).toBe('medium');
    const text = r.evidence.join('\n');
    expect(text).toMatch(/password minimum length is 6; 12 or more is the safe baseline/);
    expect(text).toMatch(/built-in mailer/);
    expect(text).toMatch(/email confirmation is off in production/);
    expect(r.fix).toMatch(/auth\.smtp: provider/);
  });

  it('accepts the built-in mailer only when golive.yaml asks for it', async () => {
    const over = { config: { stack: { hosting: 'vercel', auth: 'supabase' }, auth: { smtp: 'provider' } } } as const;
    const r = await run(authPolicyCheck, policyCtx({ ...POLICY, smtp: { configured: false } }, over));
    expect(r.status).toBe('pass');
    expect(r.evidence.join('\n')).toMatch(/provider built-in mailer/);
  });

  it('names the settings the provider does not report, and skips when it reports none', async () => {
    const partial = await run(authPolicyCheck, policyCtx({ siteUrl: PROD, redirectUrls: [], signupEnabled: true }));
    expect(partial.status).toBe('pass');
    expect(partial.evidence.join('\n')).toMatch(/not reported by supabase: email confirmation, password minimum length, auth email \(SMTP\), rate limit/);
    expect((await run(authPolicyCheck, policyCtx({ siteUrl: PROD, redirectUrls: [] }))).status).toBe('skip');
  });

  it('skips for a guided provider and when the provider is logged out', async () => {
    const guided = testCtx({ config: { stack: { auth: 'fakeguided' } }, adapters: [fakeAdapter({ id: 'fakeguided', axes: ['auth'], automated: false })] });
    expect(await run(authPolicyCheck, guided)).toMatchObject({ status: 'skip', evidence: ['auth provider fakeguided has no auth-config capability (guided)'] });
    const loggedOut = testCtx({
      config: { stack: { auth: 'supabase' } },
      adapters: [fakeAdapter({ id: 'supabase', axes: ['auth'], auth: { ok: false }, capabilities: { authConfig: { get: async () => POLICY as unknown as AuthSettings, set: async () => ({ applied: [], skipped: [] }) } } })],
    });
    expect(await run(authPolicyCheck, loggedOut)).toMatchObject({ status: 'skip', evidence: ['blocked by: login:supabase'] });
  });

  it('does not apply without an auth provider', () => {
    expect(authPolicyCheck.applies(testCtx({ config: { stack: { hosting: 'vercel' } } }))).toBe(false);
  });
});

// ── auth-signup ─────────────────────────────────────────────────────────────────────────────────
// The pass rule is "the signup journey is proven by provider reads", not "this run holds the seeded
// password": a `verify` or `handoff` outside the seeding apply must be able to close the handoff.
// The full status matrix (captcha, 429, no confirmation sent, refused not by `email_not_confirmed`,
// provider errors, the confirmed login that does or does not work) lives in test/auth-e2e.test.ts.

describe('auth-signup', () => {
  const EMAIL = 'owner+go-live@example.com';
  const SEEDED = 'supabase.testUserId';

  /** The provider surface the check reads: a probe signup, its refusal, one seeded admin record. */
  function authCtx(over: { confirmed?: boolean; gone?: boolean } = {}): Ctx {
    const auth = fakeAdapter({
      id: 'supabase',
      axes: ['auth'],
      capabilities: {
        authUsers: {
          destination: async () => ({ ref: 'abcdefghijklmnopqrst', url: 'https://abcdefghijklmnopqrst.supabase.co' }),
          signup: async () => ({ status: 200, userId: 'usr_probe', confirmationSent: true, existing: false, rateLimited: false, captchaRequired: false }),
          // Anything but the seeded address is a probe with a fresh `+gl-…` tag: still unconfirmed.
          login: async (_c, email) => (email === EMAIL
            ? { status: 200, rateLimited: false, session: { accessToken: new Secret('SUPABASE_AUTH_TOKEN', 'issued'), userId: 'usr_1', emailConfirmed: true } }
            : { status: 400, code: 'email_not_confirmed', rateLimited: false }),
          user: async () => ({ status: 401 }),
          adminUser: async () => (over.gone === true ? null : { status: 200, id: 'usr_1', email: EMAIL, emailConfirmed: over.confirmed ?? true }),
          setPassword: async () => {},
          requestRecovery: async () => ({ status: 200, accepted: true, emailSent: true, rateLimited: false, captchaRequired: false }),
          recoverySession: async () => ({ status: 403, code: 'otp_expired', rateLimited: false }),
          updateOwnPassword: async () => {},
        },
      },
    });
    return testCtx({
      config: { stack: { auth: 'supabase' }, auth: { e2e: true, testEmail: EMAIL } },
      state: { version: 1, resources: { [SEEDED]: 'usr_1' }, secrets: {}, steps: {} },
      adapters: [auth],
    });
  }

  it('passes with no password in this run, and says where the confirmed login is exercised', async () => {
    const r = await run(authSignupCheck, authCtx());
    expect(r.status).toBe('pass');
    const text = r.evidence.join('\n');
    expect(text).toMatch(/confirmation email sent/);
    expect(text).toMatch(/cannot sign in before confirming \(email_not_confirmed\)/);
    expect(text).toMatch(/is confirmed \(email_confirmed_at set\)/);
    expect(text).toMatch(/this run holds no password for the test account: the confirmed login is exercised by the run that seeds or rotates it \(the auth:test-user step\), and `auth-session` proves the session on its own/);
  });

  it('warns, and keeps the handoff open, while the account is not confirmed', async () => {
    const r = await run(authSignupCheck, authCtx({ confirmed: false }));
    expect(r).toMatchObject({ status: 'warn', severity: 'medium' });
    expect(r.evidence.join('\n')).toMatch(/is not confirmed yet/);
  });

  it('still fails when the recorded test account is gone from the provider', async () => {
    const r = await run(authSignupCheck, authCtx({ gone: true }));
    expect(r).toMatchObject({ status: 'fail', severity: 'high' });
    expect(r.evidence[0]).toMatch(/is gone from Supabase/);
  });
});

// ── email ───────────────────────────────────────────────────────────────────────────────────────

describe('email-dns', () => {
  const D = 'example.com';
  const good = {
    [`TXT send.${D}`]: ['v=spf1 include:amazonses.com ~all'],
    [`MX send.${D}`]: ['10 feedback-smtp.us-east-1.amazonses.com.'],
    [`TXT resend._domainkey.${D}`]: ['p=MIGfMA0GCSqGSIb3DQEB'],
    [`TXT _dmarc.${D}`]: ['v=DMARC1; p=none;'],
  };
  const emailCtx = (records: Record<string, string[]>, email: { from?: string; domain?: string } = { from: `App <hello@${D}>` }) =>
    testCtx({ http: mockHttp([dohRoute(records)]).http, config: { stack: { email: 'resend' }, email } });

  it('passes with SPF, MX, DKIM and DMARC in place', async () => {
    const r = await run(emailDnsCheck, emailCtx(good));
    expect(r.status).toBe('pass');
    expect(r.evidence.join('\n')).toContain(`DKIM at TXT resend._domainkey.${D}`);
  });

  it('warns with a suggested DMARC record when DMARC is missing', async () => {
    const { [`TXT _dmarc.${D}`]: _omit, ...noDmarc } = good;
    const r = await run(emailDnsCheck, emailCtx(noDmarc));
    expect(r.status).toBe('warn');
    expect(r.evidence.join('\n')).toContain(`TXT _dmarc.${D} "v=DMARC1; p=none;"`);
  });

  it('skips (blocked by email:domain) for an automated provider before the sending domain exists', async () => {
    const adapter = { id: 'resend', title: 'Resend', axes: ['email'], automated: true, auth: async () => ({ ok: true }), capabilities: { sendingDomain: { ensure: async () => ({ id: 'd', records: [] }), status: async () => 'pending', verify: async () => undefined } } } as unknown as import('../src/core/types.js').Adapter;
    const ctx = testCtx({ http: mockHttp([dohRoute({})]).http, config: { stack: { email: 'resend' }, email: { from: `App <hello@${D}>` } }, adapters: [adapter] });
    const r = await run(emailDnsCheck, ctx);
    expect(r.status).toBe('skip');
    expect(r.evidence.join('\n')).toMatch(/blocked by: email:domain/);
  });

  it('fails when SPF or the return-path MX is missing', async () => {
    const { [`TXT send.${D}`]: _s, ...noSpf } = good;
    expect((await run(emailDnsCheck, emailCtx(noSpf))).status).toBe('fail');
    const { [`MX send.${D}`]: _m, ...noMx } = good;
    expect((await run(emailDnsCheck, emailCtx(noMx))).status).toBe('fail');
  });

  it('accepts CNAME-style DKIM and derives the domain from email.domain first', async () => {
    const sub = 'mail.example.com';
    const r = await run(
      emailDnsCheck,
      emailCtx(
        { [`TXT send.${sub}`]: ['v=spf1 include:amazonses.com ~all'], [`MX send.${sub}`]: ['10 x.amazonses.com.'], [`CNAME resend._domainkey.${sub}`]: ['abc.dkim.amazonses.com.'], [`TXT _dmarc.${sub}`]: ['v=DMARC1; p=reject'] },
        { domain: sub, from: 'a@other.com' },
      ),
    );
    expect(r.status).toBe('pass');
  });

  it('does not apply without a derivable domain', () => {
    expect(emailDnsCheck.applies(testCtx({ config: { stack: { email: 'resend' } } }))).toBe(false);
  });
});

describe('email-verified', () => {
  const verCtx = (status: 'verified' | 'pending' | 'failed' | 'not_started', withId = true) =>
    testCtx({
      config: { stack: { email: 'resend' }, email: { from: 'a@example.com' } },
      state: { version: 1, resources: withId ? { 'resend.domainId': 'dom_1' } : {}, secrets: {}, steps: {} },
      adapters: [
        fakeAdapter({
          id: 'resend',
          axes: ['email'],
          capabilities: { sendingDomain: { ensure: async () => { throw new Error('must not write'); }, verify: async () => { throw new Error('must not write'); }, status: async (_c, id) => (id === 'dom_1' ? status : 'failed') } },
        }),
      ],
    });
  it.each([
    ['verified', 'pass'],
    ['pending', 'warn'],
    ['not_started', 'warn'],
    ['failed', 'fail'],
  ] as const)('%s → %s', async (st, want) => {
    expect((await run(emailVerifiedCheck, verCtx(st))).status).toBe(want);
  });
  it('skips (blocked by email:domain) with a next step when no domain id is recorded', async () => {
    const r = await run(emailVerifiedCheck, verCtx('verified', false));
    expect(r.status).toBe('skip');
    expect(r.evidence[0]).toMatch(/^blocked by: email:domain .*golive plan/);
  });
});

// ── domain-live ─────────────────────────────────────────────────────────────────────────────────

describe('domain-live', () => {
  const D = 'shop.example.com';
  const domCtx = (records: Record<string, string[]>, site: { status?: number; throws?: boolean } = {}, steps: Record<string, { status: 'done'; at: string; planId: string }> = {}) => {
    const { http, calls } = mockHttp([
      dohRoute(records),
      ['GET', `https://${D}/`, () => {
        if (site.throws) throw new Error('request to shop.example.com failed: TypeError: fetch failed (CERT_HAS_EXPIRED)');
        return { status: site.status ?? 200, text: 'ok' };
      }],
    ]);
    return { ctx: testCtx({ http, config: { stack: {}, domain: D }, state: { version: 1, resources: {}, secrets: {}, steps } }), calls };
  };

  it('passes when DNS resolves and HTTPS returns 2xx/3xx', async () => {
    const { ctx } = domCtx({ [`A ${D}`]: ['76.76.21.21'] });
    const r = await run(domainLiveCheck, ctx);
    expect(r.status).toBe('pass');
    expect(r.evidence.join('\n')).toContain('A 76.76.21.21');
    expect((await run(domainLiveCheck, domCtx({ [`CNAME ${D}`]: ['cname.vercel-dns.com'] }, { status: 308 }).ctx)).status).toBe('pass');
  });

  it('fails on TLS/connection errors and on 5xx', async () => {
    const r = await run(domainLiveCheck, domCtx({ [`A ${D}`]: ['1.2.3.4'] }, { throws: true }).ctx);
    expect(r.status).toBe('fail');
    expect(r.evidence.join('\n')).toMatch(/TLS or connection error/);
    expect((await run(domainLiveCheck, domCtx({ [`A ${D}`]: ['1.2.3.4'] }, { status: 502 }).ctx)).status).toBe('fail');
  });

  it('warns "not propagated yet" right after golive changed DNS, fails otherwise', async () => {
    const recent = { 'domain:dns': { status: 'done' as const, at: new Date().toISOString(), planId: 'p' } };
    const r = await run(domainLiveCheck, domCtx({}, {}, recent).ctx);
    expect(r.status).toBe('warn');
    expect(r.evidence.join('\n')).toContain('not propagated yet');

    const { ctx, calls } = domCtx({});
    const r2 = await run(domainLiveCheck, ctx);
    expect(r2.status).toBe('fail');
    expect(calls.some((c) => c.url === `https://${D}/`)).toBe(false); // no HTTPS probe without DNS
  });

  it('fails when the host reports the domain misconfigured', async () => {
    const { http } = mockHttp([dohRoute({ [`A ${D}`]: ['1.2.3.4'] })]);
    const h = hosting({ domain: { add: async () => {}, requiredRecords: async () => [], status: async () => 'misconfigured' } });
    const r = await run(domainLiveCheck, testCtx({ http, config: { stack: { hosting: 'vercel' }, domain: D }, adapters: [h] }));
    expect(r.status).toBe('fail');
    expect(r.evidence.join('\n')).toContain('host reports domain misconfigured');
  });
});

// ── read-only guarantee ─────────────────────────────────────────────────────────────────────────

describe('read-only', () => {
  // The only writes a check makes are the probes a human opted into: the unsigned webhook POST, and
  // (with `auth.e2e: true`) the throwaway signup `auth-signup` performs.
  it('no check sends a write method except the unsigned webhook POST of {}', async () => {
    const { http, calls } = mockHttp([
      dohRoute({ 'A shop.example.com': ['1.2.3.4'] }),
      ['GET', /^https:\/\/shop\.example\.com\//, () => ({ text: '<html></html>' })],
      ['POST', 'https://shop.example.com/api/stripe', () => ({ status: 400 })],
    ]);
    probeMock.mockResolvedValue({ status: 401, rows: 0 });
    accountMock.mockResolvedValue({ chargesEnabled: true, detailsSubmitted: true });
    const ctx = testCtx({
      http,
      config: { stack: { hosting: 'vercel', payments: 'stripe' }, domain: 'shop.example.com', payments: { webhook: { path: '/api/stripe', events: ['a'] } } },
      adapters: [hosting({}, 'https://shop.example.com')],
    });
    for (const c of ALL_CHECKS) if (c.applies(ctx)) await c.run(ctx);
    const writes = calls.filter((c) => c.method !== 'GET');
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ method: 'POST', url: 'https://shop.example.com/api/stripe', body: {} });
  });

  it('the signup checks do nothing at all until auth.e2e opts in', async () => {
    const { http, calls } = mockHttp([]);
    const ctx = testCtx({ http, config: { stack: { hosting: 'vercel', db: 'supabase', auth: 'supabase' } }, adapters: [hosting()] });
    for (const id of ['auth-signup', 'auth-session']) {
      const c = ALL_CHECKS.find((x) => x.id === id)!;
      expect(c.applies(ctx)).toBe(true);
      const r = await c.run(ctx);
      expect(r.status).toBe('skip');
      expect(r.evidence[0]).toMatch(/auth\.e2e is not enabled/);
    }
    expect(calls).toHaveLength(0);
  });
});

// ── review fixes: probe ownership, skip semantics, regressions ──────────────────────────────────

describe('probe ownership (active probes only hit the host-confirmed URL)', () => {
  const EVIL = 'victim.example.org';

  it('hostVariants pairs apex and www', () => {
    expect(hostVariants('Example.com')).toEqual(['example.com', 'www.example.com']);
    expect(hostVariants('www.example.com')).toEqual(['www.example.com', 'example.com']);
  });

  it('bundle-secrets never crawls config.domain when the host reports no URL', async () => {
    const { http, calls } = mockHttp([]);
    const r = await run(bundleSecretsCheck, testCtx({ http, config: { stack: { hosting: 'vercel' }, domain: EVIL }, adapters: [hosting({}, null)] }));
    expect(r.status).toBe('skip');
    expect(r.evidence[0]).toContain(`cannot confirm https://${EVIL} belongs to your project yet`);
    expect(calls).toHaveLength(0);
  });

  it('bundle-secrets skips (cannot confirm) for a guided host without a URL capability', async () => {
    const { http, calls } = mockHttp([]);
    const r = await run(bundleSecretsCheck, testCtx({ http, config: { stack: { hosting: 'netlify' }, domain: EVIL } }));
    expect(r.status).toBe('skip');
    expect(r.evidence[0]).toContain(`cannot confirm https://${EVIL} belongs to your project yet`);
    expect(calls).toHaveLength(0);
  });

  it('webhook-unsigned never POSTs to config.domain the host has not confirmed', async () => {
    const cfg = { stack: { hosting: 'vercel', payments: 'stripe' }, domain: EVIL, payments: { webhook: { path: '/api/stripe', events: ['a'] } } };
    const none = mockHttp([]);
    const r = await run(webhookUnsignedCheck, testCtx({ http: none.http, config: cfg, adapters: [hosting({}, null)] }));
    expect(r.status).toBe('skip');
    expect(r.evidence[0]).toContain(`cannot confirm https://${EVIL} belongs to your project yet`);
    expect(none.calls).toHaveLength(0);

    // Host reports its own URL (domain not verified there yet): probe that, not the claimed domain.
    const { http, calls } = mockHttp([['POST', `${PROD}/api/stripe`, () => ({ status: 400 })]]);
    const r2 = await run(webhookUnsignedCheck, testCtx({ http, config: cfg, adapters: [hosting()] }));
    expect(r2.status).toBe('pass');
    expect(calls.map((c) => c.url)).toEqual([`${PROD}/api/stripe`]);
    expect(r2.evidence.join('\n')).toContain(`does not report https://${EVIL}`);
  });

  it('rls-probe does not take a key from an unconfirmed domain bundle', async () => {
    const { http, calls } = mockHttp([]);
    const a = fakeAdapter({ id: 'supabase', axes: ['db'], capabilities: { dbAdmin: { tables: async () => [{ schema: 'public', name: 't', rls: true, policies: [] }] } } });
    const ctx = testCtx({ http, config: { stack: { hosting: 'vercel', db: 'supabase' }, domain: EVIL }, state: { version: 1, resources: { 'supabase.ref': 'abcd' }, secrets: {}, steps: {} }, adapters: [hosting({}, null), a] });
    const r = await run(rlsCheck, ctx);
    expect(r.status).toBe('skip');
    expect(r.evidence[0]).toMatch(/^blocked by: no publishable\/anon key/);
    expect(calls).toHaveLength(0);
    expect(probeMock).not.toHaveBeenCalled();
  });

  it('skips with blocked-by reasons: not deployed, host not logged in, host project not linked', async () => {
    const noUrl = await run(bundleSecretsCheck, testCtx({ config: { stack: { hosting: 'vercel' } }, adapters: [hosting({}, null)] }));
    expect(noUrl.evidence[0]).toMatch(/^blocked by: deploy:production/);

    const loggedOut = fakeAdapter({ id: 'vercel', axes: ['hosting'], auth: { ok: false }, capabilities: { url: { get: async () => PROD } } });
    const r1 = await confirmedProductionUrl(testCtx({ config: { stack: { hosting: 'vercel' } }, adapters: [loggedOut] }));
    expect(r1.ok).toBe(false);
    expect(!r1.ok && r1.outcome).toMatchObject({ status: 'skip', evidence: ['blocked by: login:vercel'] });

    const project = { current: async () => null, candidates: async () => [], select: async () => ({ id: 'p', name: 'p' }) };
    const unlinked = fakeAdapter({ id: 'vercel', axes: ['hosting'], capabilities: { url: { get: async () => PROD }, project } });
    const r2 = await confirmedProductionUrl(testCtx({ config: { stack: { hosting: 'vercel' } }, adapters: [unlinked] }));
    expect(!r2.ok && r2.outcome.evidence).toEqual(['blocked by: project:hosting']);
  });
});

describe('bundle crawl redirects (finding 8)', () => {
  it('does not follow a redirect to vercel.com/sso-api: warns, scans nothing, never allowlists vercel.com', async () => {
    const APP = 'https://redir-app.example.net';
    const { impl, requests } = fakeFetch({
      [`GET ${APP}/`]: { status: 302, headers: { location: 'https://vercel.com/sso-api?url=x&nonce=SECRETNONCE123' } },
      'GET https://vercel.com/sso-api?url=x&nonce=SECRETNONCE123': { status: 302, headers: { location: 'https://internal.corp:8443/login' } },
      'GET https://internal.corp:8443/login': { body: '<script src="/login.js"></script>' },
    });
    const http = createHttp(impl);
    const r = await run(bundleSecretsCheck, testCtx({ http, config: { stack: { hosting: 'vercel' } }, adapters: [hosting({}, APP)] }));
    expect(r.status).toBe('warn');
    expect(r.evidence.join('\n')).toContain('Vercel deployment protection');
    expect(printable(r)).not.toContain('SECRETNONCE123');
    expect(requests.map((q) => q.url)).toEqual([`${APP}/`]);
    await expect(http({ url: 'https://vercel.com/anything', method: 'POST', body: {} })).rejects.toThrow(/host not allowed/);
    await expect(http({ url: 'https://internal.corp:8443/anything' })).rejects.toThrow(/host not allowed/);
  });

  it('still follows apex → www on the confirmed origin and scans it', async () => {
    const APEX = 'https://apex-app.example.net';
    const WWW = 'https://www.apex-app.example.net';
    const SK = 'sk_live_' + 'W8'.repeat(12);
    const { impl, requests } = fakeFetch({
      [`GET ${APEX}/`]: { status: 301, headers: { location: `${WWW}/` } },
      [`GET ${WWW}/`]: { body: '<script src="/a.js"></script>' },
      [`GET ${WWW}/a.js`]: { body: `const k="${SK}"` },
    });
    const r = await run(bundleSecretsCheck, testCtx({ http: createHttp(impl), config: { stack: { hosting: 'vercel' } }, adapters: [hosting({}, APEX)] }));
    expect(r.status).toBe('fail');
    expect(requests.map((q) => q.url)).toEqual([`${APEX}/`, `${WWW}/`, `${WWW}/a.js`]);
    expect(printable(r)).not.toContain(SK);
  });
});

describe('skip semantics: only accounts fails for auth problems', () => {
  it('accounts fails while payment checks skip with blocked by: login:stripe', async () => {
    const cfg = { stack: { hosting: 'vercel', payments: 'stripe' }, payments: { webhook: { path: '/api/stripe', events: ['a'] } } };
    const stripe = fakeAdapter({
      id: 'stripe',
      axes: ['payments'],
      auth: { ok: false, howToFix: 'run `stripe login`' },
      capabilities: { webhooks: { ensure: async () => { throw new Error('no'); }, list: async () => { throw new Error('401 not logged in'); } } },
    });
    const ctx = testCtx({ config: cfg, adapters: [hosting(), stripe] });
    expect((await run(accountsCheck, ctx)).status).toBe('fail');
    const reg = await run(webhookRegisteredCheck, ctx);
    expect(reg).toMatchObject({ status: 'skip', evidence: ['blocked by: login:stripe'] });
    const live = await run(stripeLiveReadyCheck, ctx);
    expect(live.status).toBe('skip');
    expect(accountMock).not.toHaveBeenCalled();
  });

  it('accounts fix never tells the human to export a token in their terminal', async () => {
    const ctx = testCtx({ config: { stack: { payments: 'stripe' } }, adapters: [fakeAdapter({ id: 'stripe', axes: ['payments'], auth: { ok: false } })] });
    const r = await run(accountsCheck, ctx);
    expect(r.fix).not.toMatch(/export /);
    expect(r.fix).toMatch(/never paste tokens/);
  });

  it('auth-redirects, rls-probe, email-verified skip when their provider is logged out', async () => {
    const supaOut = fakeAdapter({ id: 'supabase', axes: ['db', 'auth'], auth: { ok: false }, capabilities: { authConfig: { get: async () => { throw new Error('401'); }, set: async () => ({ applied: [], skipped: [] }) }, dbAdmin: { tables: async () => { throw new Error('401'); } } } });
    const ctx = testCtx({ config: { stack: { hosting: 'vercel', db: 'supabase', auth: 'supabase' } }, state: { version: 1, resources: { 'supabase.ref': 'abcd' }, secrets: {}, steps: {} }, adapters: [hosting(), supaOut] });
    expect(await run(authRedirectsCheck, ctx)).toMatchObject({ status: 'skip', evidence: ['blocked by: login:supabase'] });
    expect(await run(rlsCheck, ctx)).toMatchObject({ status: 'skip', evidence: ['blocked by: login:supabase'] });

    const resendOut = fakeAdapter({ id: 'resend', axes: ['email'], auth: { ok: false }, capabilities: { sendingDomain: { ensure: async () => ({ id: 'x', records: [] }), verify: async () => {}, status: async () => { throw new Error('401'); } } } });
    const ectx = testCtx({ config: { stack: { email: 'resend' }, email: { from: 'a@example.com' } }, state: { version: 1, resources: { 'resend.domainId': 'd' }, secrets: {}, steps: {} }, adapters: [resendOut] });
    expect(await run(emailVerifiedCheck, ectx)).toMatchObject({ status: 'skip', evidence: ['blocked by: login:resend'] });
  });

  it('auth-redirects skips as blocked by deploy:production without a production URL', async () => {
    const supa = fakeAdapter({ id: 'supabase', axes: ['auth'], capabilities: { authConfig: { get: async () => ({ siteUrl: null, redirectUrls: [] }), set: async () => ({ applied: [], skipped: [] }) } } });
    const r = await run(authRedirectsCheck, testCtx({ config: { stack: { hosting: 'vercel', auth: 'supabase' } }, adapters: [hosting({}, null), supa] }));
    expect(r.status).toBe('skip');
    expect(r.evidence[0]).toMatch(/^blocked by: deploy:production/);
  });
});

describe('env-parity production-only names (findings 6/2) and hidden env (34)', () => {
  const refs = [
    { name: 'NEXT_PUBLIC_SUPABASE_URL', files: ['lib/s.ts'], clientExposed: true },
    { name: 'STRIPE_SECRET_KEY', files: ['lib/pay.ts'], clientExposed: false },
    { name: 'STRIPE_WEBHOOK_SECRET', files: ['app/api/stripe/route.ts'], clientExposed: false },
    { name: 'NEXT_PUBLIC_SITE_URL', files: ['lib/url.ts'], clientExposed: true },
  ];
  const all = refs.map((r) => r.name);
  const noWebhookOrUrl = ['NEXT_PUBLIC_SUPABASE_URL', 'STRIPE_SECRET_KEY'];
  const ctxFor = (names: Record<string, string[] | Error>, o: { domain?: string; prodUrl?: string | null; stripe?: Adapter } = {}) =>
    testCtx({
      config: { stack: { hosting: 'vercel', db: 'supabase', payments: 'stripe' }, ...(o.domain ? { domain: o.domain } : {}), payments: { webhook: { path: '/api/stripe', events: ['a'] } } },
      detect: { envRefs: refs },
      adapters: [
        fakeAdapter({
          id: 'vercel',
          axes: ['hosting'],
          capabilities: {
            // Like the real Vercel adapter: preview has no stable URL.
            url: { get: async (_c, t) => (t === 'production' ? (o.prodUrl === undefined ? PROD : o.prodUrl) : null) },
            env: { listNames: async (_c, t) => { const v = names[t]; if (v instanceof Error) throw v; return v ?? []; }, set: async () => {} },
          },
        }),
        fakeAdapter({ id: 'supabase', axes: ['db'] }),
        o.stripe ?? fakeAdapter({ id: 'stripe', axes: ['payments'] }),
      ],
    });

  it('regression: preview without STRIPE_WEBHOOK_SECRET / site URL (null preview URL) is not a failure', async () => {
    const r = await run(envParityCheck, ctxFor({ preview: noWebhookOrUrl, production: all }));
    expect(r.status).toBe('pass');
    const ev = r.evidence.join('\n');
    expect(ev).toContain('preview: STRIPE_WEBHOOK_SECRET not required (golive registers the webhook and writes its signing secret for production only)');
    expect(ev).toMatch(/preview: NEXT_PUBLIC_SITE_URL not required \(preview has no stable URL/);
    expect(r.fix ?? '').not.toMatch(/golive plan/);
  });

  it('still fails when production lacks the webhook secret or a known site URL', async () => {
    const r = await run(envParityCheck, ctxFor({ preview: noWebhookOrUrl, production: noWebhookOrUrl }, { domain: 'shop.example.com' }));
    expect(r.status).toBe('fail');
    expect(r.evidence.join('\n')).toContain('production: missing STRIPE_WEBHOOK_SECRET, NEXT_PUBLIC_SITE_URL');
  });

  it('production site URL is not required before the first deploy (no domain, no host URL)', async () => {
    const prodNoUrl = ['NEXT_PUBLIC_SUPABASE_URL', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET'];
    const r = await run(envParityCheck, ctxFor({ preview: noWebhookOrUrl, production: prodNoUrl }, { prodUrl: null }));
    expect(r.status).toBe('pass');
    expect(r.evidence.join('\n')).toMatch(/production: NEXT_PUBLIC_SITE_URL not required \(the production URL is not known until the first deploy/);
  });

  it('names from a logged-out provider are blocked (skip), not failed', async () => {
    const stripeOut = fakeAdapter({ id: 'stripe', axes: ['payments'], auth: { ok: false } });
    const r = await run(envParityCheck, ctxFor({ preview: ['NEXT_PUBLIC_SUPABASE_URL'], production: ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SITE_URL'] }, { stripe: stripeOut }));
    expect(r.status).toBe('skip');
    expect(r.evidence[0]).toBe('blocked by: login:stripe (STRIPE_SECRET_KEY@preview, STRIPE_SECRET_KEY@production, STRIPE_WEBHOOK_SECRET@production)');
    // …but an unblocked missing name still fails.
    const r2 = await run(envParityCheck, ctxFor({ preview: [], production: ['NEXT_PUBLIC_SITE_URL'] }, { stripe: stripeOut }));
    expect(r2.status).toBe('fail');
    expect(r2.evidence.join('\n')).toContain('production: missing NEXT_PUBLIC_SUPABASE_URL');
  });

  it('hosting not logged in → skip blocked by login:vercel (no env listing)', async () => {
    const listNames = vi.fn(async () => []);
    const ctx = testCtx({ config: { stack: { hosting: 'vercel' } }, detect: { envRefs: refs }, adapters: [fakeAdapter({ id: 'vercel', axes: ['hosting'], auth: { ok: false }, capabilities: { env: { listNames, set: async () => {} } } })] });
    expect(await run(envParityCheck, ctx)).toMatchObject({ status: 'skip', evidence: ['blocked by: login:vercel'] });
    expect(listNames).not.toHaveBeenCalled();
  });

  it('production env hidden from the token role → cannot verify (skip), not "missing"', async () => {
    const hidden = Object.assign(new Error('cannot verify: 3 production env vars are hidden from this token\'s role'), { code: 'hidden_env' });
    const r = await run(envParityCheck, ctxFor({ preview: noWebhookOrUrl, production: hidden }));
    expect(r.status).toBe('skip');
    expect(r.evidence[0]).toMatch(/^blocked by: the hosting token's role cannot read production env vars/);
    expect(r.evidence.join('\n')).not.toContain('missing');
  });
});

describe('domain-live propagation window (finding 39)', () => {
  const D = 'shop.example.com';
  const ctxWith = (stepId: string) =>
    testCtx({ http: mockHttp([dohRoute({})]).http, config: { stack: {}, domain: D }, state: { version: 1, resources: {}, secrets: {}, steps: { [stepId]: { status: 'done', at: new Date().toISOString(), planId: 'p' } } } });

  it.each(['email:dns', 'email:domain', 'domain:attach'])('a recent %s step does not mask a domain with no records', async (id) => {
    const r = await run(domainLiveCheck, ctxWith(id));
    expect(r.status).toBe('fail');
  });
  it('a recent domain:dns step still means "propagating"', async () => {
    expect((await run(domainLiveCheck, ctxWith('domain:dns'))).status).toBe('warn');
  });
});

describe('email-dns with the provider record list', () => {
  const D = 'example.com';
  const records: DnsRecord[] = [
    { type: 'MX', name: `send.${D}`, content: 'feedback-smtp.us-east-1.amazonses.com', priority: 10 },
    { type: 'TXT', name: `send.${D}`, content: 'v=spf1 include:amazonses.com ~all' },
    { type: 'CNAME', name: `tok1._domainkey.${D}`, content: 'tok1.dkim.amazonses.com' },
  ];
  const ctxFor = (dns: Record<string, string[]>, recs = records) =>
    testCtx({
      http: mockHttp([dohRoute(dns)]).http,
      config: { stack: { email: 'resend' }, email: { from: `a@${D}` } },
      state: { version: 1, resources: { 'resend.domainId': 'dom_1' }, secrets: {}, steps: {} },
      adapters: [
        fakeAdapter({
          id: 'resend',
          axes: ['email'],
          capabilities: {
            sendingDomain: { ensure: async () => { throw new Error('must not write'); }, verify: async () => { throw new Error('must not write'); }, status: async () => 'verified', records: async (_c, id) => (id === 'dom_1' ? recs : []) },
          },
        }),
      ],
    });
  const good = {
    [`MX send.${D}`]: ['10 feedback-smtp.us-east-1.amazonses.com.'],
    [`TXT send.${D}`]: ['v=spf1 include:_spf.google.com include:amazonses.com ~all'], // merged SPF is fine
    [`CNAME tok1._domainkey.${D}`]: ['tok1.dkim.amazonses.com.'],
    [`TXT _dmarc.${D}`]: ['v=DMARC1; p=none;'],
  };

  it('passes when every provider-listed record is published (token-named DKIM included)', async () => {
    const r = await run(emailDnsCheck, ctxFor(good));
    expect(r.status).toBe('pass');
    expect(r.evidence.join('\n')).toContain(`CNAME tok1._domainkey.${D}: matches`);
  });

  it('fails (high) when a provider-listed DKIM record is missing, where the heuristic would only warn', async () => {
    const { [`CNAME tok1._domainkey.${D}`]: _d, ...noDkim } = good;
    const r = await run(emailDnsCheck, ctxFor(noDkim));
    expect(r.status).toBe('fail');
    expect(r.evidence[0]).toBe(`CNAME tok1._domainkey.${D} is missing (the provider expects tok1.dkim.amazonses.com)`);
  });

  it('fails when the SPF record drops the provider include', async () => {
    const r = await run(emailDnsCheck, ctxFor({ ...good, [`TXT send.${D}`]: ['v=spf1 include:_spf.google.com ~all'] }));
    expect(r.status).toBe('fail');
    expect(r.evidence.join('\n')).toContain(`TXT send.${D} is v=spf1 include:_spf.google.com ~all but the provider expects`);
  });
});

describe('webhook-registered uses the adapter find() matching rule', () => {
  const cfg = { stack: { hosting: 'vercel', payments: 'stripe' }, payments: { webhook: { path: '/api/stripe', events: ['a'] } } };
  const withFind = (found: { id: string; url: string; events: string[]; enabled: boolean; owned: boolean } | null) =>
    fakeAdapter({
      id: 'stripe',
      axes: ['payments'],
      capabilities: { webhooks: { ensure: async () => { throw new Error('must not write'); }, list: async () => [], find: async (_c, url) => (found && url === `${PROD}/api/stripe` ? found : null) } },
    });
  it('passes on a found endpoint, fails on a trailing-slash mismatch (redirect)', async () => {
    expect((await run(webhookRegisteredCheck, testCtx({ config: cfg, adapters: [hosting(), withFind({ id: 'we_1', url: `${PROD}/api/stripe`, events: ['a'], enabled: true, owned: true })] }))).status).toBe('pass');
    expect((await run(webhookRegisteredCheck, testCtx({ config: cfg, adapters: [hosting(), withFind({ id: 'we_1', url: `${PROD}/api/stripe/`, events: ['a'], enabled: true, owned: true })] }))).status).toBe('fail');
  });
});

describe('domain-live requires the host to confirm the domain (round-2 finding 12)', () => {
  const D = 'shop.example.com';
  const ctxFor = (status: () => Promise<'ok' | 'pending' | 'misconfigured'>, opts: { auth?: boolean; hostingId?: string; adapters?: Adapter[] } = {}) => {
    const { http, calls } = mockHttp([dohRoute({ [`A ${D}`]: ['1.2.3.4'] }), ['GET', `https://${D}/`, () => ({ status: 200, text: 'old site' })]]);
    const h = fakeAdapter({
      id: 'vercel',
      axes: ['hosting'],
      auth: { ok: opts.auth ?? true, via: 'vercel CLI' },
      capabilities: { url: { get: async () => PROD }, domain: { add: async () => { throw new Error('must not write'); }, requiredRecords: async () => [], status: async () => status() } },
    });
    return { ctx: testCtx({ http, config: { stack: { hosting: opts.hostingId ?? 'vercel' }, domain: D }, adapters: opts.adapters ?? [h] }), calls };
  };

  it('passes only when the host reports ok', async () => {
    const r = await run(domainLiveCheck, ctxFor(async () => 'ok').ctx);
    expect(r.status).toBe('pass');
    expect(r.evidence.join('\n')).toContain('host reports domain ok');
  });

  it("warns (not passes) on 'pending', even though the domain resolves and answers 200", async () => {
    const { ctx, calls } = ctxFor(async () => 'pending');
    const r = await run(domainLiveCheck, ctx);
    expect(r.status).toBe('warn');
    expect(r.evidence.join('\n')).toContain('host reports domain pending');
    expect(calls.some((c) => c.url === `https://${D}/`)).toBe(false);
  });

  it('skips (never passes) when the host status lookup throws', async () => {
    const r = await run(domainLiveCheck, ctxFor(async () => { throw new Error('No Vercel project is linked'); }).ctx);
    expect(r.status).toBe('skip');
    expect(r.evidence[0]).toMatch(/^cannot confirm shop\.example\.com is attached to your vercel project/);
  });

  it('skips with blocked by: login:<host> when the host is not logged in (status never asked)', async () => {
    let asked = false;
    const r = await run(domainLiveCheck, ctxFor(async () => { asked = true; return 'ok'; }, { auth: false }).ctx);
    expect(r.status).toBe('skip');
    expect(r.evidence[0]).toBe('blocked by: login:vercel');
    expect(asked).toBe(false);
  });

  it('skips with blocked by: project:hosting when no project is linked', async () => {
    const h = fakeAdapter({
      id: 'vercel',
      axes: ['hosting'],
      capabilities: {
        project: { current: async () => null, candidates: async () => [], select: async () => { throw new Error('must not write'); } },
        domain: { add: async () => { throw new Error('must not write'); }, requiredRecords: async () => [], status: async () => 'ok' },
      },
    });
    const r = await run(domainLiveCheck, ctxFor(async () => 'ok', { adapters: [h] }).ctx);
    expect(r.status).toBe('skip');
    expect(r.evidence[0]).toBe('blocked by: project:hosting');
  });

  it('a guided host (no domain capability) is DNS + HTTPS only and says the attachment is unconfirmed', async () => {
    const r = await run(domainLiveCheck, ctxFor(async () => 'ok', { hostingId: 'netlify', adapters: [fakeAdapter({ id: 'netlify', axes: ['hosting'], automated: false })] }).ctx);
    expect(r.status).toBe('pass');
    expect(r.evidence.join('\n')).toContain("host attachment not confirmed: netlify can't report domain status (guided)");
  });
});

describe('email-dns with guided providers (round-2 finding 15)', () => {
  const D = 'example.com';
  const ctxFor = (provider: string, records: Record<string, string[]>) =>
    testCtx({ http: mockHttp([dohRoute(records)]).http, config: { stack: { email: provider }, email: { from: `App <hello@${D}>` } }, adapters: [fakeAdapter({ id: provider, axes: ['email'], automated: false })] });
  const dmarc = { [`TXT _dmarc.${D}`]: ['v=DMARC1; p=none;'] };

  it('Postmark set up as Postmark instructs (DKIM at <timestamp>pm, pm-bounces CNAME, no SPF) does not fail', async () => {
    const r = await run(emailDnsCheck, ctxFor('postmark', { ...dmarc, [`TXT 20240101000000pm._domainkey.${D}`]: ['k=rsa; p=MIGf'], [`CNAME pm-bounces.${D}`]: ['pm.mtasv.net.'] }));
    expect(r.status).toBe('warn');
    expect(r.severity).toBe('low');
    const ev = r.evidence.join('\n');
    expect(ev).toContain(`return path via CNAME pm-bounces.${D}`);
    expect(ev).toContain('<timestamp>pm._domainkey.example.com');
    expect(ev).not.toMatch(/no SPF record/);
  });

  it('Postmark with a pm-selector DKIM passes, a missing custom return path is only a note', async () => {
    const r = await run(emailDnsCheck, ctxFor('postmark', { ...dmarc, [`TXT pm._domainkey.${D}`]: ['k=rsa; p=MIGf'] }));
    expect(r.status).toBe('pass');
    expect(r.evidence.join('\n')).toContain(`no custom return path (CNAME pm-bounces.${D}`);
  });

  it('SendGrid automated security (em####/s1/s2 CNAMEs, no SPF TXT) passes', async () => {
    const r = await run(
      emailDnsCheck,
      ctxFor('sendgrid', { ...dmarc, [`CNAME em1234.${D}`]: ['u123.wl.sendgrid.net.'], [`CNAME s1._domainkey.${D}`]: ['s1.domainkey.u123.wl.sendgrid.net.'], [`CNAME s2._domainkey.${D}`]: ['s2.domainkey.u123.wl.sendgrid.net.'] }),
    );
    expect(r.status).toBe('pass');
    expect(r.evidence.join('\n')).toContain('SPF via SendGrid automated security');
  });

  it('SendGrid without SPF or automated security only warns (low)', async () => {
    const r = await run(emailDnsCheck, ctxFor('sendgrid', { ...dmarc, [`TXT s1._domainkey.${D}`]: ['p=MIGf'] }));
    expect(r.status).toBe('warn');
    expect(r.severity).toBe('low');
  });

  it('SES with default MAIL FROM (no SPF) does not fail', async () => {
    const r = await run(emailDnsCheck, ctxFor('ses', { ...dmarc }));
    expect(r.status).toBe('warn');
    expect(r.severity).toBe('low');
    expect(r.evidence.join('\n')).toContain('SPF not required');
  });

  it('Resend (send.<d> layout) still fails without SPF', async () => {
    const r = await run(emailDnsCheck, ctxFor('resend', { ...dmarc, [`MX send.${D}`]: ['10 x.amazonses.com.'], [`TXT resend._domainkey.${D}`]: ['p=MIGf'] }));
    expect(r.status).toBe('fail');
    expect(r.evidence.join('\n')).toContain(`no SPF record at send.${D} or ${D}`);
  });
});
