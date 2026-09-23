import { describe, it, expect, beforeEach } from 'vitest';
import { inspect } from 'node:util';
import { Secret, redact, fingerprint, _resetSecretRegistry } from '../src/core/secret.js';
import { exec, ExecError } from '../src/core/exec.js';
import { createHttp, allowHost, HttpError } from '../src/core/http.js';
import { parseConfig, ConfigError, modeFor } from '../src/core/config.js';
import { mapEnv } from '../src/core/envmap.js';
import { orderSteps, planId, buildPlan } from '../src/core/plan.js';
import { applyPlan, PlanMismatchError } from '../src/core/runner.js';
import { memoryStateStore } from '../src/core/state.js';
import { createCtx } from '../src/core/context.js';
import { silentLogger } from '../src/core/output.js';
import type { Check, Ctx, DetectResult, Step } from '../src/core/types.js';
import { TEST_RELEASE } from './helpers.js';

beforeEach(() => _resetSecretRegistry());

const SK = 'sk_' + 'live_51ABCDEFGHIJKLMNOPQRSTUVWXyz0123456789';

describe('Secret', () => {
  it('never stringifies its value', () => {
    const s = new Secret('STRIPE_SECRET_KEY', SK);
    for (const out of [String(s), `${s}`, JSON.stringify({ s }), inspect(s), inspect({ nested: { s } })]) {
      expect(out).not.toContain(SK);
      expect(out).toContain('STRIPE_SECRET_KEY');
    }
    expect(s.reveal()).toBe(SK);
    expect(s.fingerprint).toBe(fingerprint(SK));
    expect(s.fingerprint).toHaveLength(8);
  });

  it('redact() scrubs registered values and known credential shapes', () => {
    new Secret('X', 'my-registered-secret-value');
    const text = `a my-registered-secret-value b ${SK} c ${'whsec' + '_abcdefghijklmnop1234'} d postgres://postgres:hunter2pass@db.x.supabase.co:5432/postgres`;
    const out = redact(text);
    expect(out).not.toContain('my-registered-secret-value');
    expect(out).not.toContain(SK);
    expect(out).not.toContain('whsec' + '_abcdefghijklmnop1234');
    expect(out).not.toContain('hunter2pass');
    expect(out).toContain('postgres://postgres:[redacted]@');
  });

  it('redacts service-role style JWTs', () => {
    // Construct an invalid unsigned JWT locally; this is not an account credential.
    const jwt = [
      Buffer.from(JSON.stringify({ alg: 'HS256' })).toString('base64url'),
      Buffer.from(JSON.stringify({ role: 'service_role' })).toString('base64url'),
      Buffer.from('synthetic-signature').toString('base64url'),
    ].join('.');
    expect(redact(`key=${jwt}`)).not.toContain(jwt);
  });
});

describe('exec', () => {
  it('delivers secrets via stdin, never argv', async () => {
    const s = new Secret('T', 'stdin-only-secret-123');
    const r = await exec('node', ['-e', 'process.stdin.on("data",d=>process.stdout.write(String(d).length+""))'], { stdin: s });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(String('stdin-only-secret-123'.length));
  });

  it('refuses a secret in argv', async () => {
    new Secret('T', 'argv-secret-should-fail');
    await expect(exec('echo', ['argv-secret-should-fail'])).rejects.toBeInstanceOf(ExecError);
  });

  it('reports missing commands clearly', async () => {
    await expect(exec('definitely-not-a-command-xyz', [])).rejects.toThrow(/command not found/);
  });
});

describe('http', () => {
  const okFetch = (async () => new Response('{"ok":true}', { status: 200 })) as unknown as typeof fetch;

  it('refuses hosts outside the allowlist and non-https', async () => {
    const http = createHttp(okFetch);
    await expect(http({ url: 'https://evil.example.net/x' })).rejects.toBeInstanceOf(HttpError);
    await expect(http({ url: 'http://api.stripe.com/v1/x' })).rejects.toBeInstanceOf(HttpError);
    await expect(http({ url: 'https://api.stripe.com/v1/account' })).resolves.toMatchObject({ status: 200, json: { ok: true } });
    await expect(http({ url: 'https://abcd.supabase.co/rest/v1/' })).resolves.toMatchObject({ status: 200 });
  });

  it('allows the app host once registered', async () => {
    const http = createHttp(okFetch);
    await expect(http({ url: 'https://myapp.example.org/' })).rejects.toBeInstanceOf(HttpError);
    allowHost('https://myapp.example.org');
    await expect(http({ url: 'https://myapp.example.org/' })).resolves.toMatchObject({ status: 200 });
  });

  it('reveals secrets only inside the request (form + headers + json body)', async () => {
    let seen: { headers: Headers; body: string } | undefined;
    const spy = (async (_u: URL, init: RequestInit) => {
      seen = { headers: new Headers(init.headers), body: String(init.body) };
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    const http = createHttp(spy);
    const key = new Secret('K', 'sk_test_' + 'x'.repeat(24));
    await http({ method: 'POST', url: 'https://api.stripe.com/v1/webhook_endpoints', headers: { authorization: key }, form: { url: 'https://a.b/c', secret: key } });
    expect(seen?.headers.get('authorization')).toBe(key.reveal());
    expect(seen?.body).toContain(encodeURIComponent(key.reveal()));
  });
});

describe('config', () => {
  it('parses a full config and defaults targets', () => {
    const c = parseConfig(`version: 1
stack: { hosting: vercel, db: supabase, payments: stripe, email: resend, dns: cloudflare, monitoring: none }
domain: example.com
payments: { webhook: { path: /api/webhooks/stripe, events: [checkout.session.completed] } }
email: { from: "Acme <hello@example.com>" }
`);
    expect(c.stack).toEqual({ hosting: 'vercel', db: 'supabase', payments: 'stripe', email: 'resend', dns: 'cloudflare' });
    expect(c.targets).toEqual(['preview', 'production']);
    expect(modeFor(c, 'production')).toBe('live');
    expect(modeFor(c, 'preview')).toBe('test');
  });

  it.each([
    ['version: 2\n', /version/],
    ['version: 1\nstack: { hostng: vercel }\n', /unknown axis/],
    ['version: 1\ndomain: https://example.com\n', /bare domain/],
    ['version: 1\npayments: { webhook: { path: api/x, events: [a] } }\n', /start with/],
    ['version: 1\nstack: { hosting: "Vercel Inc" }\n', /provider id/],
  ])('rejects bad config %#', (text, re) => {
    expect(() => parseConfig(text)).toThrow(ConfigError);
    expect(() => parseConfig(text)).toThrow(re);
  });
});

describe('envmap', () => {
  const ref = (name: string, clientExposed = false) => ({ name, files: ['src/x.ts'], clientExposed });

  it('maps framework-prefixed names to semantic keys', () => {
    const r = mapEnv([ref('NEXT_PUBLIC_SUPABASE_URL', true), ref('VITE_SUPABASE_ANON_KEY', true), ref('SUPABASE_SERVICE_ROLE_KEY'), ref('STRIPE_SECRET_KEY'), ref('STRIPE_WEBHOOK_SECRET'), ref('NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY', true), ref('RESEND_API_KEY'), ref('DATABASE_URL'), ref('NODE_ENV'), ref('OPENAI_API_KEY')]);
    const byName = Object.fromEntries(r.mapped.map((m) => [m.name, m.key]));
    expect(byName).toMatchObject({
      NEXT_PUBLIC_SUPABASE_URL: 'supabase.url',
      VITE_SUPABASE_ANON_KEY: 'supabase.publishableKey',
      SUPABASE_SERVICE_ROLE_KEY: 'supabase.secretKey',
      STRIPE_SECRET_KEY: 'stripe.secretKey',
      STRIPE_WEBHOOK_SECRET: 'stripe.webhookSecret',
      NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: 'stripe.publishableKey',
      RESEND_API_KEY: 'resend.apiKey',
      DATABASE_URL: 'db.url',
    });
    expect(r.unmapped).toEqual(['OPENAI_API_KEY']);
    expect(r.findings).toEqual([]);
  });

  it('flags (and refuses to fill) a server secret behind a client prefix', () => {
    const r = mapEnv([ref('NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY', true), ref('VITE_STRIPE_SECRET_KEY', true)]);
    expect(r.mapped).toEqual([]);
    expect(r.findings.map((f) => f.severity)).toEqual(['critical', 'critical']);
  });
});

// ── plan + runner ───────────────────────────────────────────────────────────────────────────────

const detectStub: DetectResult = { root: '/x', packageManager: 'pnpm', framework: 'next', providers: {}, envRefs: [], configs: {}, webhooks: [], findings: [], notes: [] };

function mkCtx(): Ctx {
  return createCtx({
    cwd: '/x',
    release: TEST_RELEASE,
    exec,
    http: createHttp((async () => new Response('{}')) as unknown as typeof fetch),
    log: silentLogger(),
    config: { version: 1, stack: {}, targets: ['preview', 'production'] },
    state: memoryStateStore(),
    detect: detectStub,
    adapters: [],
    envToken: () => undefined,
  });
}

function step(id: string, deps: string[] = [], extra: Partial<Step> = {}, calls: string[] = []): Step {
  return { id, title: id, kind: 'wire', risk: { writes: true }, dependsOn: deps, preview: [`do ${id}`], verifyWith: [], run: async () => (calls.push(id), { changes: [`did ${id}`] }), ...extra };
}

describe('plan', () => {
  it('orders by dependencies and detects cycles', () => {
    expect(orderSteps([step('c', ['b']), step('a'), step('b', ['a'])]).map((s) => s.id)).toEqual(['a', 'b', 'c']);
    expect(() => orderSteps([step('a', ['b']), step('b', ['a'])])).toThrow(/cycle/);
    expect(() => orderSteps([step('a', ['zzz'])])).toThrow(/unknown step/);
  });

  it('plan id changes when anything the human approves changes', () => {
    const a = planId([step('a')], [], TEST_RELEASE);
    expect(planId([step('a')], [], TEST_RELEASE)).toBe(a);
    expect(planId([step('a', [], { preview: ['something else'] })], [], TEST_RELEASE)).not.toBe(a);
    expect(planId([step('a', [], { risk: { writes: true, live: true } })], [], TEST_RELEASE)).not.toBe(a);
  });
});

describe('runner', () => {
  async function planOf(ctx: Ctx, steps: Step[]) {
    return buildPlan(ctx, [{ id: 't', plan: async () => ({ steps, handoffs: [] }) }], { unmappedEnv: [], warnings: [] });
  }
  const base = { yes: true, confirmLive: false, confirmDns: false };

  it('refuses a plan that differs from the approved one, or without --yes', async () => {
    const ctx = mkCtx();
    const plan = await planOf(ctx, [step('a')]);
    await expect(applyPlan(ctx, plan, new Map(), { ...base, approvedPlanId: 'nope' })).rejects.toBeInstanceOf(PlanMismatchError);
    await expect(applyPlan(ctx, plan, new Map(), { ...base, yes: false, approvedPlanId: plan.id })).rejects.toBeInstanceOf(PlanMismatchError);
  });

  it('blocks live/dns steps without explicit flags and does not run them', async () => {
    const ctx = mkCtx();
    const calls: string[] = [];
    const plan = await planOf(ctx, [step('a', [], {}, calls), step('live', ['a'], { risk: { writes: true, live: true } }, calls)]);
    const out = await applyPlan(ctx, plan, new Map(), { ...base, approvedPlanId: plan.id });
    expect(out.map((o) => [o.id, o.status])).toEqual([['a', 'done'], ['live', 'blocked']]);
    expect(out[1]!.next).toMatch(/--confirm-live/);
    expect(calls).toEqual(['a']);
  });

  it('stops at the first failure and resumes from there', async () => {
    const ctx = mkCtx();
    const calls: string[] = [];
    let fail = true;
    const flaky = step('b', ['a'], { run: async () => { calls.push('b'); if (fail) throw new Error('boom'); return { changes: ['ok'] }; } });
    const plan = await planOf(ctx, [step('a', [], {}, calls), flaky, step('c', ['b'], {}, calls)]);
    const first = await applyPlan(ctx, plan, new Map(), { ...base, approvedPlanId: plan.id });
    expect(first.map((o) => o.status)).toEqual(['done', 'failed']);
    fail = false;
    const second = await applyPlan(ctx, plan, new Map(), { ...base, approvedPlanId: plan.id });
    expect(second.map((o) => [o.id, o.status])).toEqual([['a', 'skipped'], ['b', 'done'], ['c', 'done']]);
    expect(calls).toEqual(['a', 'b', 'b', 'c']);
  });

  it('marks a step failed when its verification check fails', async () => {
    const ctx = mkCtx();
    const check: Check = { id: 'chk', title: 'chk', severity: 'high', applies: () => true, run: async () => ({ status: 'fail', severity: 'high', evidence: ['nope'], fix: 'do the thing' }) };
    const plan = await planOf(ctx, [step('a', [], { verifyWith: ['chk'] })]);
    const out = await applyPlan(ctx, plan, new Map([['chk', check]]), { ...base, approvedPlanId: plan.id });
    expect(out[0]).toMatchObject({ status: 'failed', next: 'do the thing' });
    expect(ctx.state.get().steps.a?.status).toBe('failed');
  });

  it('closes handoffs only when their check passes', async () => {
    const ctx = mkCtx();
    let done = false;
    const check: Check = { id: 'kyc', title: 'kyc', severity: 'high', applies: () => true, run: async () => ({ status: done ? 'pass' : 'fail', severity: 'high', evidence: [] }) };
    const plan = await planOf(ctx, [step('h', [], { kind: 'handoff', risk: { writes: false }, verifyWith: ['kyc'], preview: ['Finish Stripe verification'] })]);
    expect((await applyPlan(ctx, plan, new Map([['kyc', check]]), { ...base, approvedPlanId: plan.id }))[0]!.status).toBe('blocked');
    done = true;
    expect((await applyPlan(ctx, plan, new Map([['kyc', check]]), { ...base, approvedPlanId: plan.id }))[0]!.status).toBe('done');
  });

  it('fingerprints public values without adding them to the redactor', async () => {
    const ctx = mkCtx();
    const plan = await planOf(ctx, [step('p', [], { run: async (sc) => { sc.rememberValue('NEXT_PUBLIC_SITE_URL', 'production', 'https://example.com'); return { changes: [] }; } })]);
    await applyPlan(ctx, plan, new Map(), { ...base, approvedPlanId: plan.id });
    expect(ctx.state.get().secrets['NEXT_PUBLIC_SITE_URL@production']?.fp).toHaveLength(8);
    expect(redact('see https://example.com')).toBe('see https://example.com');
  });

  it('re-runs a done step when its approved content changed (e.g. test → live)', async () => {
    const ctx = mkCtx();
    const calls: string[] = [];
    const v1 = await planOf(ctx, [step('k', [], { preview: ['keys: test'] }, calls)]);
    await applyPlan(ctx, v1, new Map(), { ...base, approvedPlanId: v1.id });
    const same = await applyPlan(ctx, v1, new Map(), { ...base, approvedPlanId: v1.id });
    expect(same[0]!.status).toBe('skipped');
    const v2 = await planOf(ctx, [step('k', [], { preview: ['keys: live'] }, calls)]);
    const again = await applyPlan(ctx, v2, new Map(), { ...base, approvedPlanId: v2.id });
    expect(again[0]!.status).toBe('done');
    expect(calls).toEqual(['k', 'k']);
  });

  it('re-runs a done step whose preview is unchanged but whose intent changed (e.g. db project switch)', async () => {
    const ctx = mkCtx();
    const calls: string[] = [];
    const mk = (intent: string) => planOf(ctx, [step('env', [], { preview: ['update SUPABASE_URL (managed)'], intent }, calls)]);
    const p1 = await mk('supabase.url|supabase|db_2');
    await applyPlan(ctx, p1, new Map(), { ...base, approvedPlanId: p1.id });
    const p2 = await mk('supabase.url|supabase|db_3');
    expect(p2.id).not.toBe(p1.id);
    const out = await applyPlan(ctx, p2, new Map(), { ...base, approvedPlanId: p2.id });
    expect(out[0]!.status).toBe('done');
    expect(calls).toEqual(['env', 'env']);
  });

  it('records secret fingerprints, never values', async () => {
    const ctx = mkCtx();
    const plan = await planOf(ctx, [step('s', [], { run: async (sc) => { sc.rememberSecret('STRIPE_WEBHOOK_SECRET', 'production', new Secret('w', 'whsec_' + 'z'.repeat(30))); return { changes: [] }; } })]);
    await applyPlan(ctx, plan, new Map(), { ...base, approvedPlanId: plan.id });
    const dump = JSON.stringify(ctx.state.get());
    expect(dump).not.toContain('whsec_');
    expect(ctx.state.get().secrets['STRIPE_WEBHOOK_SECRET@production']?.fp).toHaveLength(8);
  });
});

// ── credentials file + retry policy ─────────────────────────────────────────────────────────────
import { mkdtempSync, writeFileSync as wf, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as pjoin } from 'node:path';
import { parseCredentials, credentialsStatus, tokenHowTo, _resetCredentialsCache } from '../src/core/credentials.js';
import { envToken } from '../src/core/context.js';

describe('credentials file', () => {
  it('parses dotenv-style lines, quotes, comments and export prefixes', () => {
    const m = parseCredentials(`# tokens\nVERCEL_TOKEN=abc123\nexport RESEND_API_KEY="re_x_y"\nCLOUDFLARE_API_TOKEN='cf tok'\nEMPTY=\nnot a line\n`);
    expect(Object.fromEntries(m)).toEqual({ VERCEL_TOKEN: 'abc123', RESEND_API_KEY: 're_x_y', CLOUDFLARE_API_TOKEN: 'cf tok' });
  });

  it('envToken falls back to the credentials file and wraps the value as a Secret', () => {
    const dir = mkdtempSync(pjoin(tmpdir(), 'golive-cred-'));
    const file = pjoin(dir, 'credentials');
    wf(file, 'GOLIVE_TEST_TOKEN=file-token-value-123456\n');
    chmodSync(file, 0o600);
    const prev = process.env.GOLIVE_CREDENTIALS;
    process.env.GOLIVE_CREDENTIALS = file;
    _resetCredentialsCache();
    try {
      const t = envToken('GOLIVE_TEST_TOKEN');
      expect(t).toBeInstanceOf(Secret);
      expect(t?.reveal()).toBe('file-token-value-123456');
      expect(String(t)).not.toContain('file-token-value');
      const st = credentialsStatus();
      expect(st).toMatchObject({ path: file, exists: true, private: true, names: ['GOLIVE_TEST_TOKEN'] });
      expect(JSON.stringify(st)).not.toContain('file-token-value');
      chmodSync(file, 0o644);
      expect(credentialsStatus().private).toBe(false);
      expect(credentialsStatus().fix).toMatch(/chmod 600/);
    } finally {
      if (prev === undefined) delete process.env.GOLIVE_CREDENTIALS;
      else process.env.GOLIVE_CREDENTIALS = prev;
      _resetCredentialsCache();
    }
  });

  it('tokenHowTo never suggests exporting in the human terminal or pasting in chat', () => {
    const t = tokenHowTo('VERCEL_TOKEN');
    expect(t).toMatch(/credentials/);
    expect(t).toMatch(/Never paste/);
    expect(t).not.toMatch(/read -s/);
  });
});

describe('http retry policy', () => {
  function counting(statuses: number[]) {
    let i = 0;
    const calls: string[] = [];
    const f = (async (_u: URL, init: RequestInit) => {
      calls.push(String(init.method));
      const s = statuses[Math.min(i++, statuses.length - 1)]!;
      return new Response('{}', { status: s });
    }) as unknown as typeof fetch;
    return { f, calls };
  }

  it('does not re-send a POST after a 5xx (could duplicate a create)', async () => {
    const { f, calls } = counting([500, 200]);
    const r = await createHttp(f)({ method: 'POST', url: 'https://api.supabase.com/v1/projects', body: {} });
    expect(r.status).toBe(500);
    expect(calls).toHaveLength(1);
  });

  it('re-sends a POST with an Idempotency-Key, a flagged idempotent POST, and any 429', async () => {
    const a = counting([502, 200]);
    expect((await createHttp(a.f)({ method: 'POST', url: 'https://api.stripe.com/v1/webhook_endpoints', headers: { 'Idempotency-Key': 'k1' }, form: {} })).status).toBe(200);
    expect(a.calls).toHaveLength(2);
    const b = counting([503, 200]);
    expect((await createHttp(b.f)({ method: 'POST', url: 'https://api.supabase.com/v1/projects/x/database/query/read-only', body: {}, idempotent: true })).status).toBe(200);
    const c = counting([429, 200]);
    expect((await createHttp(c.f)({ method: 'POST', url: 'https://api.resend.com/api-keys', body: {} })).status).toBe(200);
    expect(c.calls).toHaveLength(2);
  });

  it('retries GETs on 5xx', async () => {
    const { f, calls } = counting([500, 500, 200]);
    expect((await createHttp(f)({ url: 'https://api.vercel.com/v2/user' })).status).toBe(200);
    expect(calls).toHaveLength(3);
  });
});
