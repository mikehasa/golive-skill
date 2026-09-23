/**
 * Small fixture repos for detect tests, materialised into a temp dir by the test (so fixture source is
 * never type-checked or linted as project code). Real-looking secret values are generated at runtime
 * so no credential-shaped literal is committed.
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export type FixtureFiles = Record<string, string>;

const rnd = (n: number): string => randomBytes(n).toString('base64url').replace(/[-_]/g, 'x');

/** Values that look like real credentials; detect must never read or return any of them. */
export function fakeSecrets() {
  return {
    stripeLive: ['sk', 'live', `51${rnd(40)}`].join('_'),
    whsec: ['whsec', rnd(32)].join('_'),
    sbSecret: ['sb', 'secret', rnd(32)].join('_'),
    resend: ['re', rnd(24)].join('_'),
    dbPassword: `pw${rnd(18)}`,
    publishable: ['sb', 'publishable', rnd(24)].join('_'),
  };
}
export type FakeSecrets = ReturnType<typeof fakeSecrets>;

export function materialize(files: FixtureFiles, mtimes: Record<string, number> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'golive-detect-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  for (const [rel, secs] of Object.entries(mtimes)) utimesSync(join(root, rel), secs, secs);
  return root;
}

const json = (v: unknown): string => JSON.stringify(v, null, 2);

// ── 1. Next.js + Supabase + Stripe + Resend (+ Sentry), linked to Vercel ─────────────────────────

export function nextSupabaseStripe(s: FakeSecrets): FixtureFiles {
  return {
    'package.json': json({
      name: 'saas',
      scripts: { build: 'next build' },
      dependencies: { next: '16.3.6', react: '19.2.0', '@supabase/ssr': '0.12.7', '@supabase/supabase-js': '2.117.0', stripe: '22.6.2', '@stripe/stripe-js': '9.17.0', resend: '6.28.1', '@sentry/nextjs': '10.75.2' },
    }),
    'pnpm-lock.yaml': "lockfileVersion: '9.0'\n",
    'next.config.ts': "import { withSentryConfig } from '@sentry/nextjs';\nexport default withSentryConfig({ reactStrictMode: true });\n",
    '.vercel/project.json': json({ projectId: 'prj_fixture123', orgId: 'team_fixture123' }),
    'supabase/config.toml': 'project_id = "abcdefghijklmnopqrst"\n\n[auth]\nsite_url = "http://localhost:3000"\n',
    'supabase/migrations/0001_init.sql': 'create table profiles (id uuid primary key);\n',
    'app/(marketing)/page.tsx': "export default function Page() { return <main>{process.env.NEXT_PUBLIC_SITE_URL}</main>; }\n",
    'app/layout.tsx': "export const metadata = { title: 'SaaS' };\nexport default function L({ children }) { return children; }\n",
    'app/api/webhooks/stripe/route.ts': `import Stripe from 'stripe';
import { headers } from 'next/headers';
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
export async function POST(req: Request) {
  const body = await req.text();
  const sig = (await headers()).get('stripe-signature')!;
  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(body, sig, process.env.STRIPE_WEBHOOK_SECRET!);
  } catch {
    return new Response('bad signature', { status: 400 });
  }
  if (event.type === 'checkout.session.completed') { /* fulfil */ }
  return Response.json({ received: true });
}
`,
    'app/api/_lib/route.ts': "// private folder: not routable\nexport const x = process.env['PRIVATE_HELPER_FLAG'];\n",
    'lib/supabase/server.ts': `import { createServerClient } from '@supabase/ssr';
export async function getUser() {
  const supabase = createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, { cookies: {} as never });
  return supabase.auth.getUser();
}
export const admin = () => process.env["SUPABASE_SECRET_KEY"];
`,
    'lib/email.ts': "import { Resend } from 'resend';\nconst { RESEND_API_KEY, EMAIL_FROM: from } = process.env;\nexport const resend = new Resend(RESEND_API_KEY);\nexport const sender = from;\n",
    'lib/flags.ts': 'export const get = (name: string) => process.env[name];\n',
    '.env.example': `# Supabase
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=
SUPABASE_SECRET_KEY=
STRIPE_SECRET_KEY=sk_test_xxx
STRIPE_WEBHOOK_SECRET=whsec_xxx
export RESEND_API_KEY=re_xxx
`,
    // Real env file: must never be opened. Includes a name no code references.
    '.env.local': `STRIPE_SECRET_KEY=${s.stripeLive}
STRIPE_WEBHOOK_SECRET=${s.whsec}
SUPABASE_SECRET_KEY=${s.sbSecret}
RESEND_API_KEY=${s.resend}
LOCAL_ONLY_SETTING=${s.dbPassword}
`,
    '.env.production': `DATABASE_URL=postgresql://postgres:${s.dbPassword}@db.abcdefghijklmnopqrst.supabase.co:5432/postgres\n`,
    // Skipped directories.
    'node_modules/some-lib/index.js': 'module.exports = process.env.FROM_NODE_MODULES;\n',
    '.next/server/app.js': 'process.env.FROM_BUILD_OUTPUT;\n',
  };
}

// ── 2. Vite SPA + Supabase (Lovable export) with Edge Functions ──────────────────────────────────

export function viteSupabaseLovable(s: FakeSecrets): FixtureFiles {
  return {
    'package.json': json({
      name: 'vite_react_shadcn_ts',
      scripts: { dev: 'vite', build: 'vite build' },
      dependencies: { react: '19.2.0', 'react-router-dom': '7.9.0', '@supabase/supabase-js': '2.117.0' },
      devDependencies: { vite: '8.3.0', '@vitejs/plugin-react-swc': '4.0.0', 'lovable-tagger': '1.1.9' },
    }),
    'bun.lockb': 'binary',
    'package-lock.json': '{}',
    'index.html': '<div id="root"></div><script type="module" src="/src/main.tsx"></script>\n',
    'vite.config.ts': `import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import { componentTagger } from "lovable-tagger";
export default defineConfig(({ mode }) => ({ server: { host: "::", port: 8080 }, plugins: [react(), mode === "development" && componentTagger()].filter(Boolean) }));
`,
    'netlify.toml': '[build]\n  publish = "dist"\n',
    'src/integrations/supabase/client.ts': `// This file is automatically generated. Do not edit it directly.
import { createClient } from '@supabase/supabase-js';
export const supabase = createClient(import.meta.env.VITE_SUPABASE_URL, import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY);
export const isDev = import.meta.env.DEV && import.meta.env.MODE === 'development';
`,
    'src/pages/Login.tsx': "import { supabase } from '@/integrations/supabase/client';\nexport const login = (email: string, password: string) => supabase.auth.signInWithPassword({ email, password });\n",
    'supabase/config.toml': 'project_id = "lovableprojref0000000"\n\n[functions.send-email]\nverify_jwt = false\n',
    'supabase/functions/stripe-webhook/index.ts': `import Stripe from "npm:stripe@22";
const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, { httpClient: Stripe.createFetchHttpClient() });
const cryptoProvider = Stripe.createSubtleCryptoProvider();
Deno.serve(async (req) => {
  const signature = req.headers.get("Stripe-Signature")!;
  const body = await req.text();
  try {
    const event = await stripe.webhooks.constructEventAsync(body, signature, Deno.env.get("STRIPE_WEBHOOK_SIGNING_SECRET")!, undefined, cryptoProvider);
    const url = Deno.env.get("SUPABASE_URL");
    return new Response(JSON.stringify({ ok: true, type: event.type, url }), { status: 200 });
  } catch (err) {
    return new Response((err as Error).message, { status: 400 });
  }
});
`,
    'supabase/functions/send-email/index.ts': `import { Resend } from "https://esm.sh/resend@6.1.0";
const resend = new Resend(Deno.env.get("RESEND_API_KEY"));
Deno.serve(async () => new Response(JSON.stringify(await resend.emails.send({ from: "a@b.c", to: "d@e.f", subject: "hi", text: "hi" }))));
`,
    // Lovable commits .env with (publishable) values — still a real env file: never opened.
    '.env': `VITE_SUPABASE_URL="https://lovableprojref0000000.supabase.co"
VITE_SUPABASE_PUBLISHABLE_KEY="${s.publishable}"
VITE_LEAKED_ONLY_IN_ENV="${s.sbSecret}"
`,
    'supabase/functions/.env': `STRIPE_SECRET_KEY=${s.stripeLive}\n`,
  };
}

// ── 3. SvelteKit + Neon + Stripe (one verified, one unverified handler) ──────────────────────────

export function sveltekit(): FixtureFiles {
  return {
    'package.json': json({
      name: 'kit-app',
      scripts: { build: 'vite build' },
      dependencies: { stripe: '22.6.2', '@neondatabase/serverless': '1.1.0', 'posthog-js': '1.434.9' },
      devDependencies: { '@sveltejs/kit': '2.70.3', '@sveltejs/adapter-vercel': '6.0.0', svelte: '5.40.0', vite: '8.3.0', '@sentry/sveltekit': '10.75.2' },
    }),
    'yarn.lock': '# yarn lockfile v1\n',
    'svelte.config.js': "import adapter from '@sveltejs/adapter-vercel';\nexport default { kit: { adapter: adapter() } };\n",
    'src/routes/api/stripe/webhook/+server.ts': `import Stripe from 'stripe';
import { STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET as whsec } from '$env/static/private';
const stripe = new Stripe(STRIPE_SECRET_KEY);
export async function POST({ request }) {
  const event = stripe.webhooks.constructEvent(await request.text(), request.headers.get('stripe-signature'), whsec);
  return new Response(event.id);
}
`,
    'src/routes/(legacy)/api/unsafe-stripe/+server.ts': `export async function POST({ request }) {
  const event = await request.json(); // stripe event, trusted blindly
  if (event.type === 'checkout.session.completed') { /* grant access */ }
  return new Response('ok');
}
`,
    'src/routes/(app)/+page.svelte': "<script>\n  import { PUBLIC_POSTHOG_KEY } from '$env/static/public';\n</script>\n<p>{PUBLIC_POSTHOG_KEY}</p>\n",
    'src/lib/server/db.ts': "import { neon } from '@neondatabase/serverless';\nimport { env as privateEnv } from '$env/dynamic/private';\nexport const sql = neon(privateEnv.DATABASE_URL);\n",
  };
}

// ── 4. Bare static site ──────────────────────────────────────────────────────────────────────────

export function bareStatic(): FixtureFiles {
  return {
    'index.html': '<!doctype html><title>Hi</title><script src="script.js"></script>\n',
    'style.css': 'body { margin: 0 }\n',
    'script.js': "document.title = 'hello';\n",
  };
}

// ── 5. React Router v8 (config routes) + Express server, exported from Replit ────────────────────

export function reactRouterReplit(): FixtureFiles {
  return {
    'package.json': json({
      name: 'rest-express',
      scripts: { build: 'react-router build' },
      dependencies: { 'react-router': '8.4.0', '@react-router/node': '8.4.0', express: '5.1.0', stripe: '22.6.2', 'drizzle-orm': '0.45.3', nodemailer: '10.0.10', '@clerk/react-router': '3.0.0' },
      devDependencies: { '@react-router/dev': '8.4.0', vite: '8.3.0', '@replit/vite-plugin-cartographer': '0.3.0' },
    }),
    'package-lock.json': '{}',
    '.replit': 'modules = ["nodejs-24", "web", "postgresql-16"]\n',
    'fly.toml': 'app = "rr-app"\n',
    'app/routes.ts': `import { type RouteConfig, index, route, prefix } from "@react-router/dev/routes";
export default [
  index("routes/home.tsx"),
  ...prefix("api", [
    route("billing/webhook", "routes/stripe-webhook.ts"),
  ]),
] satisfies RouteConfig;
`,
    'app/routes/stripe-webhook.ts': `import Stripe from "stripe";
const stripe = new Stripe(process.env.STRIPE_API_KEY!);
export async function action({ request }: { request: Request }) {
  const payload = await request.text();
  const event = stripe.webhooks.constructEvent(payload, request.headers.get("stripe-signature")!, process.env.STRIPE_WEBHOOK_SIGNING_SECRET!);
  return Response.json({ id: event.id });
}
`,
    'app/routes/home.tsx': 'export default function Home() { return null; }\n',
    'server/index.ts': `import express from "express";
import Stripe from "stripe";
const app = express();
const stripe = new Stripe(process.env.STRIPE_API_KEY!);
app.post("/hooks/stripe", express.raw({ type: "application/json" }), (req, res) => {
  const event = stripe.webhooks.constructEvent(JSON.stringify(req.body), req.headers["stripe-signature"] as string, process.env.STRIPE_WEBHOOK_SIGNING_SECRET!);
  res.json({ id: event.id, repl: process.env.REPL_ID });
});
app.use(express.json());
`,
    'server/mail.ts': "import nodemailer from 'nodemailer';\nexport const t = nodemailer.createTransport({ host: process.env.SMTP_HOST, auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } });\n",
    '.env.example': 'DATABASE_URL=postgresql://user:password@ep-cool-name-123456.us-east-2.aws.neon.tech/neondb\n',
  };
}

// ── 6. Nuxt (runtimeConfig) + Stripe via server/api ──────────────────────────────────────────────

export function nuxt(): FixtureFiles {
  return {
    'package.json': json({ name: 'nuxt-app', scripts: { build: 'nuxt build' }, dependencies: { nuxt: '4.5.2', stripe: '22.6.2', '@polar-sh/sdk': '0.49.0' } }),
    'pnpm-lock.yaml': "lockfileVersion: '9.0'\n",
    'pnpm-workspace.yaml': "packages:\n  - 'apps/*'\n",
    'apps/docs/package.json': '{}',
    'wrangler.jsonc': '{ "name": "nuxt-app" }\n',
    'nuxt.config.ts': `export default defineNuxtConfig({
  // don't put secrets here
  runtimeConfig: {
    stripeSecretKey: '',
    'webhookSecret': '',
    public: { apiBase: '/api', posthogHost: '' },
  },
});
`,
    'server/api/stripe/webhook.post.ts': `import Stripe from 'stripe';
export default defineEventHandler(async (event) => {
  const stripe = new Stripe(useRuntimeConfig().stripeSecretKey);
  const body = await readRawBody(event);
  const sig = getHeader(event, 'stripe-signature');
  return stripe.webhooks.constructEvent(body!, sig!, useRuntimeConfig().webhookSecret);
});
`,
    'app/pages/index.vue': '<script setup lang="ts">\nconst base = useRuntimeConfig().public.apiBase;\n</script>\n<template><p>{{ base }}</p></template>\n',
  };
}

// ── 7. Next.js whose next.config `env: {}` inlines server secrets (review finding #0) ───────────

export function nextConfigEnvLeak(s: FakeSecrets): FixtureFiles {
  return {
    'package.json': json({ dependencies: { next: '16.3.6', react: '19.2.0', stripe: '22.6.2', '@supabase/supabase-js': '2.117.0' } }),
    'next.config.js': `/** @type {import('next').NextConfig} */
module.exports = {
  reactStrictMode: true,
  env: {
    STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
    // 'COMMENTED_OUT': process.env.NOPE,
    FEATURE_LABEL: 'beta',
  },
};
`,
    'app/page.tsx': `'use client';
export default function Page() { return <pre>{process.env.STRIPE_SECRET_KEY}</pre>; }
`,
    'app/api/admin/route.ts': 'export const GET = () => Response.json({ ok: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY && process.env.RESEND_API_KEY) });\n',
    '.env.local': `STRIPE_SECRET_KEY=${s.stripeLive}\nSUPABASE_SERVICE_ROLE_KEY=${s.sbSecret}\n`,
  };
}

// ── 8. Vite SPA whose `define` inlines the whole process.env (review finding #0) ────────────────

export function viteDefineAllEnv(s: FakeSecrets): FixtureFiles {
  return {
    'package.json': json({ dependencies: { vite: '7.1.0', react: '19.2.0', '@supabase/supabase-js': '2.117.0', stripe: '22.6.2' } }),
    'vite.config.ts': `import { defineConfig, loadEnv } from 'vite';
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  return {
    define: {
      'process.env': env,
    },
  };
});
`,
    'src/main.tsx': 'const url = import.meta.env.VITE_SUPABASE_URL;\nconst key = process.env.STRIPE_SECRET_KEY;\nconsole.log(url, key);\n',
    'supabase/functions/hook/index.ts': "Deno.serve(() => new Response(Deno.env.get('EDGE_ONLY_SECRET')));\n",
    '.env': `STRIPE_SECRET_KEY=${s.stripeLive}\n`,
  };
}
