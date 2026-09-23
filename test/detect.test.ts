import { describe, it, expect, afterAll } from 'vitest';
import { rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { detect, detectRepo, isRealEnvFile } from '../src/detect/index.js';
import { Repo } from '../src/detect/fs.js';
import { configExposure, nuxtConfigNames, objectEntries, parseDotenv, scanSource } from '../src/detect/env.js';
import { mapEnv } from '../src/core/envmap.js';
import { flatRoutePath, nextAppPath, reactRouterConfigRoutes, stripeEventTypes, stripeVerification, verifyJwtDisabled } from '../src/detect/webhooks.js';
import type { DetectResult } from '../src/core/types.js';
import {
  bareStatic,
  fakeSecrets,
  materialize,
  nextConfigEnvLeak,
  nextSupabaseStripe,
  nuxt,
  reactRouterReplit,
  sveltekit,
  viteDefineAllEnv,
  viteSupabaseLovable,
  type FakeSecrets,
} from './fixtures/detect/repos.js';

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

async function run(files: Record<string, string>, mtimes?: Record<string, number>): Promise<{ d: DetectResult; reads: string[]; root: string }> {
  const root = materialize(files, mtimes);
  roots.push(root);
  const reads: string[] = [];
  const d = await detectRepo(root, { onRead: (rel) => reads.push(rel) });
  return { d, reads, root };
}

const names = (d: DetectResult): string[] => d.envRefs.map((r) => r.name);
const ref = (d: DetectResult, name: string) => d.envRefs.find((r) => r.name === name);

function expectNoSecretValues(d: DetectResult, reads: string[], s: FakeSecrets): void {
  const out = JSON.stringify(d);
  for (const v of Object.values(s)) expect(out).not.toContain(v);
  for (const r of reads) expect(isRealEnvFile(r), `opened real env file ${r}`).toBe(false);
}

describe('detect: Next.js + Supabase + Stripe + Resend', () => {
  const s = fakeSecrets();
  const pending = run(nextSupabaseStripe(s));

  it('detects package manager, framework and providers per axis', async () => {
    const { d } = await pending;
    expect(d.packageManager).toBe('pnpm');
    expect(d.framework).toBe('next');
    expect(d.providers).toEqual({
      db: ['supabase'],
      auth: ['supabase'],
      payments: ['stripe'],
      email: ['resend'],
      monitoring: ['sentry'],
      hosting: ['vercel'],
    });
    expect(d.providers.dns).toBeUndefined();
    expect(d.origin).toBeUndefined();
  });

  it('collects env names from every syntax, with client exposure', async () => {
    const { d } = await pending;
    expect(names(d)).toEqual(
      expect.arrayContaining(['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', 'SUPABASE_SECRET_KEY', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'RESEND_API_KEY', 'EMAIL_FROM', 'NEXT_PUBLIC_SITE_URL', 'PRIVATE_HELPER_FLAG']),
    );
    expect(ref(d, 'NEXT_PUBLIC_SUPABASE_URL')).toEqual({ name: 'NEXT_PUBLIC_SUPABASE_URL', files: ['.env.example', 'lib/supabase/server.ts'], clientExposed: true });
    expect(ref(d, 'SUPABASE_SECRET_KEY')?.clientExposed).toBe(false);
    expect(ref(d, 'RESEND_API_KEY')?.files).toEqual(['.env.example', 'lib/email.ts']);
    // sorted, deterministic
    expect(names(d)).toEqual([...names(d)].sort());
  });

  it('skips node_modules and build output', async () => {
    const { d, reads } = await pending;
    expect(names(d)).not.toContain('FROM_NODE_MODULES');
    expect(names(d)).not.toContain('FROM_BUILD_OUTPUT');
    expect(reads.some((r) => r.startsWith('node_modules/') || r.startsWith('.next/'))).toBe(false);
  });

  it('never opens .env.local / .env.production and never returns their names or values', async () => {
    const { d, reads } = await pending;
    expect(reads).not.toContain('.env.local');
    expect(reads).not.toContain('.env.production');
    expect(reads).toContain('.env.example');
    expect(names(d)).not.toContain('LOCAL_ONLY_SETTING');
    expect(names(d)).not.toContain('DATABASE_URL');
    expectNoSecretValues(d, reads, s);
  });

  it('finds the App Router Stripe webhook and skips private folders', async () => {
    const { d } = await pending;
    expect(d.webhooks).toEqual([{ provider: 'stripe', path: '/api/webhooks/stripe', file: 'app/api/webhooks/stripe/route.ts', verifiesSignature: true, events: ['checkout.session.completed'] }]);
  });

  it('reports configs by path only and notes dynamic env access', async () => {
    const { d } = await pending;
    expect(d.configs).toMatchObject({ '.vercel/project.json': 'linked Vercel project', 'supabase/config.toml': expect.any(String), 'supabase/migrations': expect.any(String) });
    expect(JSON.stringify(d.configs)).not.toContain('prj_fixture123');
    expect(d.notes.join('\n')).toMatch(/Dynamic env access .*lib\/flags\.ts/);
    expect(d.notes.join('\n')).toMatch(/missing from \.env\.example: .*EMAIL_FROM/);
  });
});

describe('detect: Vite SPA + Supabase (Lovable export)', () => {
  const s = fakeSecrets();
  // package-lock.json is newer than bun.lockb, so npm wins and a note is emitted.
  const pending = run(viteSupabaseLovable(s), { 'bun.lockb': 1_700_000_000, 'package-lock.json': 1_750_000_000 });

  it('detects framework, origin, and providers including Deno URL imports', async () => {
    const { d } = await pending;
    expect(d.framework).toBe('vite');
    expect(d.packageManager).toBe('npm');
    expect(d.origin).toBe('lovable');
    expect(d.providers).toEqual({ db: ['supabase'], auth: ['supabase'], payments: ['stripe'], email: ['resend'], hosting: ['netlify'] });
    expect(d.notes.join('\n')).toMatch(/Multiple lockfiles .*using npm/);
  });

  it('collects import.meta.env and Deno.env names, skipping built-ins and injected SUPABASE_*', async () => {
    const { d } = await pending;
    expect(ref(d, 'VITE_SUPABASE_URL')).toEqual({ name: 'VITE_SUPABASE_URL', files: ['src/integrations/supabase/client.ts'], clientExposed: true });
    expect(ref(d, 'STRIPE_WEBHOOK_SIGNING_SECRET')).toEqual({ name: 'STRIPE_WEBHOOK_SIGNING_SECRET', files: ['supabase/functions/stripe-webhook/index.ts'], clientExposed: false });
    expect(names(d)).not.toContain('MODE');
    expect(names(d)).not.toContain('DEV');
    expect(names(d)).not.toContain('SUPABASE_URL');
    expect(d.notes.join('\n')).toMatch(/Supabase Edge Functions read RESEND_API_KEY, STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SIGNING_SECRET/);
  });

  it('maps the Supabase Edge Function webhook and flags verify_jwt', async () => {
    const { d } = await pending;
    expect(d.webhooks).toEqual([{ provider: 'stripe', path: '/functions/v1/stripe-webhook', file: 'supabase/functions/stripe-webhook/index.ts', verifiesSignature: true, events: [] }]);
    expect(d.notes.some((n) => n.startsWith('Supabase Edge Function stripe-webhook needs verify_jwt=false'))).toBe(true);
    expect(d.notes.some((n) => n.includes('send-email needs verify_jwt'))).toBe(false);
  });

  it('never opens the committed .env or supabase/functions/.env', async () => {
    const { d, reads } = await pending;
    expect(reads).not.toContain('.env');
    expect(reads).not.toContain('supabase/functions/.env');
    expect(names(d)).not.toContain('VITE_LEAKED_ONLY_IN_ENV');
    expectNoSecretValues(d, reads, s);
  });
});

describe('detect: SvelteKit', () => {
  const pending = run(sveltekit());

  it('detects framework, providers and hosting from the adapter', async () => {
    const { d } = await pending;
    expect(d.framework).toBe('sveltekit');
    expect(d.packageManager).toBe('yarn');
    expect(d.providers).toEqual({ db: ['neon'], payments: ['stripe'], monitoring: ['sentry', 'posthog'], hosting: ['vercel'] });
  });

  it('reads $env/static and $env/dynamic names with aliases', async () => {
    const { d } = await pending;
    expect(ref(d, 'STRIPE_WEBHOOK_SECRET')?.clientExposed).toBe(false);
    expect(ref(d, 'PUBLIC_POSTHOG_KEY')).toEqual({ name: 'PUBLIC_POSTHOG_KEY', files: ['src/routes/(app)/+page.svelte'], clientExposed: true });
    expect(ref(d, 'DATABASE_URL')?.files).toEqual(['src/lib/server/db.ts']);
  });

  it('finds verified and unverified +server.ts webhooks, dropping route groups', async () => {
    const { d } = await pending;
    expect(d.webhooks).toEqual([
      { provider: 'stripe', path: '/api/stripe/webhook', file: 'src/routes/api/stripe/webhook/+server.ts', verifiesSignature: true, events: [] },
      { provider: 'stripe', path: '/api/unsafe-stripe', file: 'src/routes/(legacy)/api/unsafe-stripe/+server.ts', verifiesSignature: false, events: ['checkout.session.completed'] },
    ]);
    expect(d.notes.join('\n')).toMatch(/\/api\/unsafe-stripe .* does not verify the Stripe signature/);
  });
});

describe('detect: bare static site', () => {
  it('reports static with nothing else', async () => {
    const { d } = await run(bareStatic());
    expect(d).toMatchObject({ packageManager: null, framework: 'static', providers: {}, envRefs: [], configs: {}, webhooks: [] });
    expect(d.origin).toBeUndefined();
  });

  it('works through the public detect(cwd) entry point', async () => {
    const root = materialize(bareStatic());
    roots.push(root);
    const d = await detect(root);
    expect(d.root).toBe(root);
    expect(d.framework).toBe('static');
  });
});

describe('detect: React Router + Express (Replit export)', () => {
  const pending = run(reactRouterReplit());

  it('detects framework, origin, providers and the DB host hint from .env.example', async () => {
    const { d } = await pending;
    expect(d.framework).toBe('react-router');
    expect(d.origin).toBe('replit');
    expect(d.providers).toEqual({ db: ['neon'], auth: ['clerk'], payments: ['stripe'], email: ['smtp'], hosting: ['fly'] });
    expect(d.notes.join('\n')).toMatch(/Replit-only env \(REPL_ID\)/);
  });

  it('maps config routes (with prefix) and Express routes, flagging a re-serialized body', async () => {
    const { d } = await pending;
    expect(d.webhooks).toEqual([
      { provider: 'stripe', path: '/api/billing/webhook', file: 'app/routes/stripe-webhook.ts', verifiesSignature: true, events: [] },
      { provider: 'stripe', path: '/hooks/stripe', file: 'server/index.ts', verifiesSignature: false, events: [] },
    ]);
    expect(d.notes.join('\n')).toMatch(/\/hooks\/stripe .*re-serialized/);
  });
});

describe('detect: Nuxt', () => {
  const pending = run(nuxt());

  it('maps runtimeConfig and useRuntimeConfig to NUXT_* names', async () => {
    const { d } = await pending;
    expect(d.framework).toBe('nuxt');
    expect(names(d)).toEqual(expect.arrayContaining(['NUXT_STRIPE_SECRET_KEY', 'NUXT_WEBHOOK_SECRET', 'NUXT_PUBLIC_API_BASE', 'NUXT_PUBLIC_POSTHOG_HOST']));
    expect(ref(d, 'NUXT_PUBLIC_API_BASE')).toEqual({ name: 'NUXT_PUBLIC_API_BASE', files: ['app/pages/index.vue', 'nuxt.config.ts'], clientExposed: true });
    expect(ref(d, 'NUXT_STRIPE_SECRET_KEY')?.clientExposed).toBe(false);
  });

  it('finds server/api webhooks with method suffix, providers and monorepo note', async () => {
    const { d } = await pending;
    expect(d.webhooks).toEqual([{ provider: 'stripe', path: '/api/stripe/webhook', file: 'server/api/stripe/webhook.post.ts', verifiesSignature: true, events: [] }]);
    expect(d.providers).toEqual({ payments: ['stripe', 'polar'], hosting: ['cloudflare'] });
    expect(d.notes.join('\n')).toMatch(/Monorepo \(pnpm-workspace\.yaml\).*apps\/docs/);
  });
});

describe('detect: helpers', () => {
  it('isRealEnvFile refuses real env files and allows templates', () => {
    for (const f of ['.env', '.env.local', '.env.production', '.env.development.local', 'supabase/functions/.env', '.dev.vars', 'prod.env', '.envrc']) expect(isRealEnvFile(f), f).toBe(true);
    for (const f of ['.env.example', '.env.sample', '.env.template', 'example.env', 'src/env.ts', 'env.mjs']) expect(isRealEnvFile(f), f).toBe(false);
  });

  it('Repo.read throws (without any value) if asked for a real env file', async () => {
    const root = materialize({ '.env.local': 'X=supersecretvalue123' });
    roots.push(root);
    await expect(new Repo(root).read('.env.local')).rejects.toThrow(/refused to open \.env\.local/);
    await expect(new Repo(root).read('.env.local')).rejects.not.toThrow(/supersecretvalue123/);
  });

  it('caps oversized files', async () => {
    const root = materialize({ 'package.json': '{}' });
    roots.push(root);
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src/huge.ts'), `process.env.HUGE_FILE_VAR;\n${'x'.repeat(1_100_000)}`);
    writeFileSync(join(root, 'src/ok.ts'), 'process.env.OK_VAR;');
    const d = await detect(root);
    expect(d.envRefs.map((r) => r.name)).toEqual(['OK_VAR']);
  });

  it('skips tests and fixtures (their env names and fake routes are not shipped)', async () => {
    const { d } = await run({
      'package.json': JSON.stringify({ dependencies: { next: '16.3.6' } }),
      'src/app/page.tsx': 'process.env.REAL_VAR;',
      'src/app/page.test.tsx': 'process.env.TEST_FILE_VAR;',
      'test/fixtures/app/api/stripe/route.ts': "stripe.webhooks.constructEvent(await req.text(), s, process.env.FIXTURE_VAR)",
      'e2e/checkout.ts': 'process.env.E2E_VAR;',
    });
    expect(names(d)).toEqual(['REAL_VAR']);
    expect(d.webhooks).toEqual([]);
  });

  it('does not detect the installed golive bundle as application env or provider code', async () => {
    const installed = '.agents/skills/golive/scripts/golive.mjs';
    const { d, reads } = await run({
      'package.json': '{}',
      'src/app.ts': 'process.env.DATABASE_URL;',
      [installed]: `import Stripe from 'npm:stripe';
process.env.APPDATA; process.env.LOG_STREAM; process.env.LOG_TOKENS;
process.env.VITE_X; process.env.XDG_CONFIG_HOME; process.env.GOLIVE_CREDENTIALS;
process.env[credentialName];`,
    });
    expect(names(d)).toEqual(['DATABASE_URL']);
    expect(d.providers.payments).toBeUndefined();
    expect(d.notes.join('\n')).not.toMatch(/dynamic|credentialName/i);
    expect(reads).not.toContain(installed);
  });

  it.each(['.agents', '.claude', '.codex', '.cursor', '.github', '.opencode', '.gemini', '.windsurf', '.roo', '.continue', '.factory'])(
    'excludes only the skills subtree in %s, including nested app installs', async (agentDir) => {
      const install = `apps/shop/${agentDir}/skills/tool/scripts/check.ts`;
      const adjacent = `apps/shop/${agentDir}/app.ts`;
      const { d, reads } = await run({
        'package.json': '{}',
        [install]: 'process.env.SKILL_ONLY;',
        [adjacent]: 'process.env.ADJACENT_APP_VAR;',
      });
      expect(names(d)).toEqual(['ADJACENT_APP_VAR']);
      expect(reads).not.toContain(install);
      expect(reads).toContain(adjacent);
    },
  );

  it('keeps ordinary hidden app directories, .well-known and application skills directories', async () => {
    const appFiles = {
      '.well-known/handler.ts': 'process.env.WELL_KNOWN_VAR;',
      '.well-known/skills/route.ts': 'process.env.WELL_KNOWN_SKILLS_VAR;',
      '.app/skills/source.ts': 'process.env.HIDDEN_APP_VAR;',
      'src/skills/service.ts': 'process.env.APP_SKILLS_VAR;',
      '.agents/skills-tools/helper.ts': 'process.env.SIBLING_VAR;',
    };
    const { d, reads } = await run({ 'package.json': '{}', ...appFiles });
    expect(names(d)).toEqual(['APP_SKILLS_VAR', 'HIDDEN_APP_VAR', 'SIBLING_VAR', 'WELL_KNOWN_SKILLS_VAR', 'WELL_KNOWN_VAR']);
    expect(reads).toEqual(expect.arrayContaining(Object.keys(appFiles)));
  });

  it('scanSource handles optional chaining, brackets, Bun, astro:env and dynamic access', () => {
    const r = scanSource('x.ts', `process.env?.A_B; process.env['C']; Bun.env.D; import { E, getSecret } from 'astro:env/server'; import { PUBLIC_F } from 'astro:env/client'; getSecret('G'); process.env[k]; import.meta.env['VITE_H']`);
    expect(r.occ.map((o) => o.name).sort()).toEqual(['A_B', 'C', 'D', 'E', 'G', 'PUBLIC_F', 'VITE_H']);
    expect(r.occ.find((o) => o.name === 'PUBLIC_F')?.exposed).toBe(true);
    expect(r.dynamic).toBe(true);
  });

  it('parseDotenv reads names, export prefix, comments and multi-line quoted values', () => {
    const parsed = parseDotenv('# c\nexport A=1\nB="line1\nline2\nline3"\nC=3\n  D = x\n');
    expect(parsed.map((p) => p.name)).toEqual(['A', 'B', 'C', 'D']);
  });

  it('nuxtConfigNames ignores comments with quotes inside the block', () => {
    const n = nuxtConfigNames(`runtimeConfig: {\n  // don't: here\n  apiKey: '', /* it's */\n  public: { siteUrl: '' },\n}`);
    expect(n).toEqual([
      { name: 'NUXT_API_KEY', exposed: false },
      { name: 'NUXT_PUBLIC_SITE_URL', exposed: true },
    ]);
  });

  it('path mappers follow framework conventions', () => {
    expect(nextAppPath('(shop)/api/@modal/(.)webhooks/stripe')).toBe('/api/webhooks/stripe');
    expect(nextAppPath('api/_private/stripe')).toBeNull();
    expect(flatRoutePath('api.webhooks.stripe')).toBe('/api/webhooks/stripe');
    expect(flatRoutePath('_auth.users.$id_.edit')).toBe('/users/:id/edit');
    expect(flatRoutePath('sitemap[.]xml')).toBe('/sitemap.xml');
    const rr = reactRouterConfigRoutes(`prefix("v1", [ route("hooks", "./routes/parent.tsx", [ route("stripe", "routes/s.ts") ]) ])`);
    expect(rr.get('app/routes/s.ts')).toBe('/v1/hooks/stripe');
    expect(rr.get('app/routes/parent.tsx')).toBe('/v1/hooks');
  });

  it('stripeVerification catches common mistakes', () => {
    const ok = 'stripe.webhooks.constructEvent(await req.text(), sig, secret)';
    expect(stripeVerification('app/api/x/route.ts', ok).ok).toBe(true);
    expect(stripeVerification('pages/api/stripe.ts', ok).ok).toBe(false);
    expect(stripeVerification('pages/api/stripe.ts', `${ok}; export const config = { api: { bodyParser: false } }`).ok).toBe(true);
    expect(stripeVerification('supabase/functions/x/index.ts', ok).reason).toMatch(/constructEventAsync/);
    expect(stripeVerification('a.ts', 'stripe.webhooks.constructEventWithoutVerification(await req.text())').ok).toBe(false);
  });

  it('verifyJwtDisabled parses quoted and bare function sections', () => {
    const s = verifyJwtDisabled('[functions.a]\nverify_jwt = false\n[functions."b-c"]\nverify_jwt = false # ok\n[functions.d]\nverify_jwt = true\n[auth]\nverify_jwt = false\n');
    expect([...s].sort()).toEqual(['a', 'b-c']);
  });
});

// ── Finding #0: framework config that inlines env into the browser ──────────────────────────────

const pkgWith = (deps: Record<string, string>): string => JSON.stringify({ dependencies: deps });
const configFiles = (files: Record<string, string>): Map<string, string> => new Map(Object.entries(files));

describe('detect: framework config inlines env into the browser (finding #0)', () => {
  it('regression: next.config env: {} keys are clientExposed, so mapEnv refuses to fill the secrets', async () => {
    const s = fakeSecrets();
    const { d, reads } = await run(nextConfigEnvLeak(s));
    expect(ref(d, 'STRIPE_SECRET_KEY')).toEqual({ name: 'STRIPE_SECRET_KEY', files: ['app/page.tsx', 'next.config.js'], clientExposed: true });
    expect(ref(d, 'SUPABASE_SERVICE_ROLE_KEY')?.clientExposed).toBe(true);
    expect(ref(d, 'FEATURE_LABEL')?.clientExposed).toBe(true);
    expect(ref(d, 'RESEND_API_KEY')?.clientExposed).toBe(false);
    expect(names(d)).not.toContain('COMMENTED_OUT');
    expect(d.notes).toContain('next.config.js inlines FEATURE_LABEL, STRIPE_SECRET_KEY, SUPABASE_SERVICE_ROLE_KEY into the browser bundle: treat them as public.');

    const env = mapEnv(d.envRefs);
    expect(env.mapped.map((m) => m.key)).not.toContain('stripe.secretKey');
    expect(env.mapped.map((m) => m.key)).not.toContain('supabase.secretKey');
    expect(env.mapped.find((m) => m.name === 'RESEND_API_KEY')?.key).toBe('resend.apiKey');
    expect(env.findings.filter((f) => f.id === 'secret-in-client-env').map((f) => f.title)).toEqual([
      'STRIPE_SECRET_KEY puts a server secret into the browser bundle',
      'SUPABASE_SERVICE_ROLE_KEY puts a server secret into the browser bundle',
    ]);
    expect(d.findings).toEqual([]); // named inlines are reported by mapEnv, not as a whole-env finding
    expect(reads).not.toContain('.env.local');
    expectNoSecretValues(d, reads, s);
  });

  it('regression: Vite define of the whole process.env (loadEnv with prefix \'\') is a critical finding and exposes every web name', async () => {
    const s = fakeSecrets();
    const { d, reads } = await run(viteDefineAllEnv(s));
    expect(d.findings).toHaveLength(1);
    expect(d.findings[0]).toMatchObject({ id: 'config-inlines-all-env', severity: 'critical', title: 'Framework config inlines every env var into the browser' });
    expect(d.findings[0]!.evidence).toEqual([
      "vite.config.ts: define process.env: inlines the whole env object",
      'server secrets that would ship in the JavaScript bundle: STRIPE_SECRET_KEY',
    ]);
    expect(ref(d, 'STRIPE_SECRET_KEY')?.clientExposed).toBe(true);
    expect(ref(d, 'VITE_SUPABASE_URL')?.clientExposed).toBe(true);
    // Edge Function secrets are not part of the web build.
    expect(ref(d, 'EDGE_ONLY_SECRET')?.clientExposed).toBe(false);
    const env = mapEnv(d.envRefs);
    expect(env.mapped.map((m) => m.key)).not.toContain('stripe.secretKey');
    expect(env.findings.map((f) => f.id)).toContain('secret-in-client-env');
    expect(reads).not.toContain('.env');
    expectNoSecretValues(d, reads, s);
  });

  it('flags every whole-env inline form', () => {
    const cases: Record<string, string> = {
      'vite.config.ts': "export default { define: { 'process.env': process.env } }",
      'vite.config.js': "export default { define: { __ENV__: JSON.stringify(process.env) } }",
      'astro.config.mjs': "export default defineConfig({ vite: { define: { 'import.meta.env': JSON.stringify(import.meta.env) } } })",
      'vite.config.mts': "export default { define: { ...Object.fromEntries(Object.entries(env).map(([k, v]) => [`process.env.${k}`, JSON.stringify(v)])) } }",
      'vite.config.cjs': "module.exports = { define: { ...Object.fromEntries(Object.keys(e).map((k) => ['process.env.' + k, JSON.stringify(e[k])])) } }",
      'next.config.mjs': 'export default { env: { ...process.env } }',
      'next.config.ts': "export default { webpack(config, { webpack }) { config.plugins.push(new webpack.DefinePlugin({ 'process.env': JSON.stringify(process.env) })); return config; } }",
      'svelte.config.js': "export default { kit: { env: { publicPrefix: '' } } }",
    };
    for (const [file, text] of Object.entries(cases)) {
      const x = configExposure(configFiles({ [file]: text }));
      expect(x.all.length, file).toBe(1);
      expect(x.all[0]!.file).toBe(file);
    }
  });

  it('does not flag a process.env shim or unrelated config', () => {
    for (const text of [
      "export default { define: { 'process.env': {} } }",
      "export default { define: { 'process.env': '{}' } }",
      "export default { define: { 'process.env': JSON.stringify({}) } }",
      "export default { define: { __APP_VERSION__: JSON.stringify(pkg.version), 'process.env.NODE_ENV': JSON.stringify(mode) } }",
      // loadEnv with the default (VITE_) prefix only holds public names.
      "const env = loadEnv(mode, process.cwd());\nexport default { define: { __ENV__: JSON.stringify(env) } }",
      // vitest's test.env is not part of the browser build.
      "export default { test: { env: { STRIPE_SECRET_KEY: 'sk_test_x' } } }",
    ]) {
      const x = configExposure(configFiles({ 'vite.config.ts': text }));
      expect(x.all, text).toEqual([]);
      expect(x.names.filter((n) => n.name !== 'NODE_ENV'), text).toEqual([]);
    }
  });

  it('collects individually inlined names from define keys, define values and process.env objects', () => {
    const x = configExposure(
      configFiles({
        'vite.config.ts': `const env = loadEnv(mode, process.cwd(), '');
export default {
  define: {
    'import.meta.env.STRIPE_SECRET_KEY': JSON.stringify(env.STRIPE_SECRET_KEY),
    "process.env.SUPABASE_SERVICE_ROLE_KEY": JSON.stringify(process.env.SUPABASE_SERVICE_ROLE_KEY),
    __RESEND__: JSON.stringify(process.env['RESEND_API_KEY']),
    'process.env': { DATABASE_URL: JSON.stringify(env.DB_CONN) },
  },
}`,
      }),
    );
    expect(x.all).toEqual([]);
    expect([...new Set(x.names.map((n) => n.name))].sort()).toEqual(['DATABASE_URL', 'DB_CONN', 'RESEND_API_KEY', 'STRIPE_SECRET_KEY', 'SUPABASE_SERVICE_ROLE_KEY']);
  });

  it('notes a process.env define it cannot resolve instead of guessing', () => {
    const x = configExposure(configFiles({ 'vite.config.ts': "export default { define: { 'process.env': buildEnv() } }" }));
    expect(x.all).toEqual([]);
    expect(x.unresolved).toEqual(["vite.config.ts define sets 'process.env' from an expression golive cannot read; make sure it holds no server secrets"]);
  });

  it('regression (round 2 #9): a define/env/DefinePlugin value that is not an object literal is resolved or fails closed', () => {
    const viteHead = "import { defineConfig, loadEnv } from 'vite';\nexport default defineConfig(({ mode }) => {\n  const env = loadEnv(mode, process.cwd(), '');\n";
    const all: Record<string, [string, string]> = {
      // (a) identifier bound to an object literal that inlines the whole loadEnv('') object
      a: ['vite.config.ts', `${viteHead}  const defs = { 'process.env': env };\n  return { define: defs };\n});`],
      // (b) a call that maps every env var to process.env.* keys
      b: ['vite.config.ts', `${viteHead}  return {\n    define: Object.fromEntries(Object.entries(env).map(([k, v]) => ['process.env.' + k, JSON.stringify(v)])),\n  };\n});`],
      // (c) the widely copied "process is not defined" fix
      c: [
        'vite.config.ts',
        `${viteHead}  const processEnvValues = {\n    'process.env': Object.entries(env).reduce((prev, [key, val]) => ({ ...prev, [key]: val }), {}),\n  };\n  return { plugins: [react()], define: processEnvValues };\n});`,
      ],
      // identifier bound to a call, no semicolons
      d: ['vite.config.ts', `${viteHead}  const defs = Object.fromEntries(\n    Object.entries(env).map(([k, v]) => [\`process.env.\${k}\`, JSON.stringify(v)])\n  )\n  return { define: defs }\n})`],
      // shorthand property
      e: ['vite.config.ts', `${viteHead}  const define = { 'process.env': env };\n  return { define };\n});`],
      // ejected-CRA webpack: DefinePlugin(envKeys)
      f: [
        'webpack.config.js',
        "const env = require('dotenv').config().parsed;\nconst envKeys = Object.keys(env).reduce((prev, next) => {\n  prev[`process.env.${next}`] = JSON.stringify(env[next]);\n  return prev;\n}, {});\nmodule.exports = { plugins: [new webpack.DefinePlugin(envKeys)] };",
      ],
      // next.config env from a whole-env identifier
      g: ['next.config.js', 'const publicEnv = { ...process.env };\nmodule.exports = { env: publicEnv };'],
      // mutated after declaration
      h: ['vite.config.ts', `${viteHead}  const defs = {};\n  defs['process.env'] = env;\n  return { define: defs };\n});`],
      // spread of an identifier
      i: ['vite.config.ts', `${viteHead}  const extra = { 'process.env': env };\n  return { define: { __V__: '1', ...extra } };\n});`],
    };
    for (const [id, [file, text]] of Object.entries(all)) {
      const x = configExposure(configFiles({ [file]: text }));
      expect(x.all.length, id).toBe(1);
      expect(x.all[0]!.file, id).toBe(file);
    }
    expect(configExposure(configFiles({ 'vite.config.ts': all.a![1] })).all[0]!.via).toBe('define (defs) process.env: inlines the whole env object');
  });

  it('regression (round 2 #9): a resolvable non-literal define inlines only its names; an unreadable one gets a note', () => {
    const safe = configExposure(
      configFiles({
        'vite.config.ts': "const env = loadEnv(mode, process.cwd(), '');\nconst defs: Record<string, string> = {\n  __APP_VERSION__: JSON.stringify(pkg.version),\n  'import.meta.env.STRIPE_SECRET_KEY': JSON.stringify(env.STRIPE_SECRET_KEY),\n};\nexport default { define: defs };",
      }),
    );
    expect(safe.all).toEqual([]);
    expect(safe.unresolved).toEqual([]);
    expect([...new Set(safe.names.map((n) => n.name))]).toEqual(['STRIPE_SECRET_KEY']);

    // loadEnv with the default VITE_ prefix: public names only, nothing to report.
    const vite = configExposure(configFiles({ 'vite.config.ts': 'const env = loadEnv(mode, process.cwd());\nexport default { define: env };' }));
    expect(vite).toEqual({ names: [], prefixes: [], all: [], unresolved: [] });

    const opaque = configExposure(configFiles({ 'vite.config.ts': "import { buildDefines } from './defines';\nexport default { define: buildDefines(process.env.FEATURE_FLAG) };" }));
    expect(opaque.all).toEqual([]);
    expect(opaque.names.map((n) => n.name)).toEqual(['FEATURE_FLAG']);
    expect(opaque.unresolved).toEqual(['vite.config.ts define is set from an expression golive cannot read; make sure it holds no server secrets']);

    const param = configExposure(configFiles({ 'webpack.config.js': 'module.exports = (defs) => ({ plugins: [new webpack.DefinePlugin(defs)] });' }));
    expect(param.unresolved).toEqual(['webpack.config.js DefinePlugin is set from an expression golive cannot read; make sure it holds no server secrets']);

    // Literal values and the literal-object form are not re-reported.
    const literal = configExposure(configFiles({ 'vite.config.ts': "export default { define: { 'process.env.NODE_ENV': '\"production\"' }, build: { define: false } }" }));
    expect(literal.unresolved).toEqual([]);
    expect(literal.all).toEqual([]);
  });

  it('regression (round 2 #9): a vite.config define: defs of the whole env blocks secret writes end to end', async () => {
    const { d } = await run({
      'package.json': pkgWith({ vite: '7.1.0', '@supabase/supabase-js': '2.0.0' }),
      'vite.config.ts': "import { defineConfig, loadEnv } from 'vite';\nexport default defineConfig(({ mode }) => {\n  const env = loadEnv(mode, process.cwd(), '');\n  const defs = { 'process.env': env };\n  return { define: defs };\n});",
      'src/main.ts': 'console.log(process.env.NODE_ENV, import.meta.env.VITE_SUPABASE_URL);',
      'api/pay.ts': 'const k = process.env.STRIPE_SECRET_KEY;',
    });
    expect(d.findings.map((f) => [f.id, f.severity])).toEqual([['config-inlines-all-env', 'critical']]);
    expect(d.findings[0]!.evidence[0]).toBe('vite.config.ts: define (defs) process.env: inlines the whole env object');
    expect(ref(d, 'STRIPE_SECRET_KEY')?.clientExposed).toBe(true);
  });

  it('Vite envPrefix and SvelteKit publicPrefix widen what counts as public', async () => {
    const { d } = await run({
      'package.json': pkgWith({ vite: '7.1.0' }),
      'vite.config.ts': "export default { envPrefix: ['VITE_', 'STRIPE_'] }",
      'src/main.ts': 'console.log(import.meta.env.STRIPE_SECRET_KEY, import.meta.env.VITE_X, import.meta.env.RESEND_API_KEY);',
      'supabase/functions/f/index.ts': "Deno.env.get('STRIPE_WEBHOOK_SECRET');",
    });
    expect(ref(d, 'STRIPE_SECRET_KEY')?.clientExposed).toBe(true);
    expect(ref(d, 'RESEND_API_KEY')?.clientExposed).toBe(false);
    expect(ref(d, 'STRIPE_WEBHOOK_SECRET')?.clientExposed).toBe(false);
    expect(d.notes).toContain('vite.config.ts envPrefix makes every name starting with STRIPE_ public.');
    expect(mapEnv(d.envRefs).findings.map((f) => f.title)).toEqual(['STRIPE_SECRET_KEY puts a server secret into the browser bundle']);

    const sk = await run({
      'package.json': pkgWith({ '@sveltejs/kit': '2.0.0' }),
      'svelte.config.js': "export default { kit: { adapter: adapter(), env: { publicPrefix: 'APP_' } } }",
      'src/lib/server/db.ts': "import { APP_DATABASE_URL, STRIPE_SECRET_KEY } from '$env/static/private';",
    });
    expect(ref(sk.d, 'APP_DATABASE_URL')?.clientExposed).toBe(true);
    expect(ref(sk.d, 'STRIPE_SECRET_KEY')?.clientExposed).toBe(false);
    expect(sk.d.findings).toEqual([]);
  });

  it('is deterministic across runs', async () => {
    const s = fakeSecrets();
    const a = await run(viteDefineAllEnv(s));
    const b = await run(viteDefineAllEnv(s));
    const strip = (d: DetectResult) => ({ ...d, root: '' });
    expect(strip(a.d)).toEqual(strip(b.d));
  });

  it('objectEntries handles shorthand, spreads, strings with escapes, comments and methods', () => {
    const src = "{ a: 1, 'b\\'c': { x: 1 }, d, ...rest, /* e: 2 */ f() { return 1 }, \"g\": `h,}` }";
    const e = objectEntries(src, 0);
    expect(e.map((x) => [x.key, x.spread, x.value])).toEqual([
      ['a', false, '1'],
      ["b\\'c", false, '{ x: 1 }'],
      ['d', false, 'd'],
      [null, true, 'rest'],
      ['g', false, '`h,}`'],
    ]);
    expect(e[1]!.objectAt).toBe(src.indexOf('{ x'));
  });
});

// ── Finding #30: Stripe event types handled by the webhook ─────────────────────────────────────

describe('detect: Stripe webhook event types (finding #30)', () => {
  it('regression: a subscription handler reports every event type it switches on', async () => {
    const { d } = await run({
      'package.json': pkgWith({ next: '16.3.6', stripe: '22.6.2' }),
      'app/api/stripe/webhook/route.ts': `import Stripe from 'stripe';
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
export async function POST(req: Request) {
  const event = stripe.webhooks.constructEvent(await req.text(), req.headers.get('stripe-signature')!, process.env.STRIPE_WEBHOOK_SECRET!);
  switch (event.type) {
    case 'checkout.session.completed':
    case "customer.subscription.updated":
    case \`customer.subscription.deleted\`:
      break;
    // case 'charge.refunded':
    /* case 'payout.paid': */
  }
  if ('invoice.paid' === event.type || event.type === 'invoice.payment_failed') {}
  const price = await stripe.prices.retrieve('price_123', { expand: ['product.metadata'] });
  const fields = ['customer.email', 'price.unit_amount'];
  return Response.json({ ok: true, docs: 'https://stripe.com/docs/api/events/types' });
}
`,
    });
    expect(d.webhooks).toEqual([
      {
        provider: 'stripe',
        path: '/api/stripe/webhook',
        file: 'app/api/stripe/webhook/route.ts',
        verifiesSignature: true,
        events: ['checkout.session.completed', 'customer.subscription.deleted', 'customer.subscription.updated', 'invoice.paid', 'invoice.payment_failed'],
      },
    ]);
    expect(d.notes.join('\n')).not.toMatch(/handles no event type/);
  });

  it('stripeEventTypes reads arrays and handler maps, ignoring field paths and comments', () => {
    expect(stripeEventTypes("const relevant = new Set(['payment_intent.succeeded', 'payment_intent.payment_failed', 'customer.email']);")).toEqual(['payment_intent.payment_failed', 'payment_intent.succeeded']);
    expect(stripeEventTypes("const handlers = { 'customer.subscription.trial_will_end': onTrial, 'invoice.upcoming': onUpcoming };")).toEqual(['customer.subscription.trial_will_end', 'invoice.upcoming']);
    expect(stripeEventTypes("if (event.type === 'product.metadata_changed') {}\n// 'refund.created'")).toEqual(['product.metadata_changed']);
    expect(stripeEventTypes("select('price.unit_amount'); get('checkout.session')")).toEqual([]);
  });

  it('notes a handler whose event types cannot be found statically', async () => {
    const { d } = await run({
      'package.json': pkgWith({ next: '16.3.6', stripe: '22.6.2' }),
      'app/api/stripe/route.ts': "import Stripe from 'stripe';\nexport async function POST(req) { const e = stripe.webhooks.constructEvent(await req.text(), s, k); return handlers[e.type](e); }",
    });
    expect(d.webhooks[0]!.events).toEqual([]);
    expect(d.notes.join('\n')).toMatch(/Stripe webhook \/api\/stripe .* handles no event type .*--events/);
  });
});


// ── Round 2 #11: Prisma signals for the Supabase pooler URL ─────────────────────────────────────

describe('detect: Prisma signals (round 2 #11)', () => {
  const prismaPkg = (extra: Record<string, unknown> = {}): string =>
    JSON.stringify({ dependencies: { next: '15.0.0', '@prisma/client': '6.0.0', '@supabase/supabase-js': '2.0.0' }, devDependencies: { prisma: '6.0.0' }, ...extra });
  const schema = 'datasource db {\n  provider = "postgresql"\n  url = env("DATABASE_URL")\n}\n';

  it('regression: the prisma/schema/ multi-file folder is a config and the Prisma dependency adds a note', async () => {
    const { d } = await run({ 'package.json': prismaPkg(), 'prisma/schema/schema.prisma': schema, 'prisma/schema/user.prisma': 'model User { id Int @id }\n', 'app/page.tsx': 'export default function P() { return null }' });
    expect(d.configs).toEqual({ 'prisma/schema': 'Prisma multi-file schema directory' });
    expect(d.notes).toContain('Prisma detected');
  });

  it('regression: a root schema.prisma is a config', async () => {
    const { d } = await run({ 'package.json': prismaPkg(), 'schema.prisma': schema });
    expect(d.configs).toEqual({ 'schema.prisma': 'Prisma schema' });
    expect(d.notes).toContain('Prisma detected');
  });

  it('records prisma/schema.prisma and prisma.config.ts, and a package.json prisma.schema custom path', async () => {
    const std = await run({ 'package.json': prismaPkg(), 'prisma/schema.prisma': schema, 'prisma.config.ts': "export default { schema: 'prisma/schema.prisma' }" });
    expect(std.d.configs).toEqual({ 'prisma/schema.prisma': 'Prisma schema', 'prisma.config.ts': 'Prisma config' });

    const custom = await run({ 'package.json': prismaPkg({ prisma: { schema: './db/schema.prisma' } }), 'db/schema.prisma': schema });
    expect(custom.d.configs).toEqual({ 'db/schema.prisma': 'Prisma schema (package.json prisma.schema)' });

    // A path outside the repo is ignored, not probed.
    const outside = await run({ 'package.json': prismaPkg({ prisma: { schema: '../other/schema.prisma' } }) });
    expect(outside.d.configs).toEqual({});
  });

  it('only the dependency adds the note: a schema alone or an unrelated app has none', async () => {
    const dev = await run({ 'package.json': JSON.stringify({ devDependencies: { prisma: '6.0.0' } }) });
    expect(dev.d.notes).toContain('Prisma detected');
    const none = await run({ 'package.json': pkgWith({ next: '15.0.0' }), 'schema.prisma': schema });
    expect(none.d.notes).not.toContain('Prisma detected');
    expect(none.d.configs).toEqual({ 'schema.prisma': 'Prisma schema' });
  });
});
