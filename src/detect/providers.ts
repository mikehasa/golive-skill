import type { Axis } from '../core/types.js';
import type { PackageJson } from './framework.js';
import type { Repo } from './fs.js';

/** Provider ids are ADAPTER ids. Within an axis, rule order is the output order (deterministic). */
interface Rule {
  axis: Exclude<Axis, 'dns'>;
  id: string;
  deps?: Array<string | RegExp>;
  files?: string[];
  /** Matched against source text; only counts when `sourceNeedsDep` (if set) is also a dependency. */
  source?: RegExp;
  sourceNeedsDep?: Array<string | RegExp>;
}

const RULES: Rule[] = [
  // db
  { axis: 'db', id: 'supabase', deps: ['@supabase/supabase-js', '@supabase/ssr', '@supabase/server', /^@supabase\/auth-helpers-/], files: ['supabase/config.toml'] },
  { axis: 'db', id: 'neon', deps: ['@neondatabase/serverless', '@neondatabase/neon-js', '@vercel/postgres'] },
  { axis: 'db', id: 'planetscale', deps: ['@planetscale/database'] },
  { axis: 'db', id: 'turso', deps: ['@libsql/client', '@tursodatabase/serverless', '@tursodatabase/database'] },
  { axis: 'db', id: 'convex', deps: ['convex'], files: ['convex.json'] },
  { axis: 'db', id: 'firebase', deps: ['firebase', 'firebase-admin'], files: ['firestore.rules', 'database.rules.json'] },
  { axis: 'db', id: 'mongodb', deps: ['mongodb', 'mongoose'] },
  { axis: 'db', id: 'prisma-postgres', deps: ['@prisma/ppg'] },
  // auth
  {
    axis: 'auth',
    id: 'supabase',
    deps: ['@supabase/ssr', /^@supabase\/auth-helpers-/, /^@supabase\/auth-ui-/],
    source: /\bsupabase\.auth\.|\.auth\.(?:getUser|getSession|getClaims|signInWith\w+|signUp|signOut|onAuthStateChange|exchangeCodeForSession)\s*\(/,
    sourceNeedsDep: [/^@supabase\//],
  },
  { axis: 'auth', id: 'clerk', deps: [/^@clerk\//] },
  { axis: 'auth', id: 'better-auth', deps: ['better-auth'] },
  { axis: 'auth', id: 'authjs', deps: ['next-auth', /^@auth\//] },
  { axis: 'auth', id: 'workos', deps: [/^@workos-inc\//] },
  { axis: 'auth', id: 'auth0', deps: [/^@auth0\//] },
  { axis: 'auth', id: 'firebase', source: /['"]firebase(?:-admin)?\/auth['"]/, sourceNeedsDep: ['firebase', 'firebase-admin'] },
  // payments
  { axis: 'payments', id: 'stripe', deps: ['stripe', '@stripe/stripe-js', '@stripe/react-stripe-js'] },
  { axis: 'payments', id: 'polar', deps: [/^@polar-sh\//] },
  { axis: 'payments', id: 'paddle', deps: [/^@paddle\//] },
  { axis: 'payments', id: 'lemonsqueezy', deps: [/^@lemonsqueezy\//] },
  // email
  { axis: 'email', id: 'resend', deps: ['resend'] },
  { axis: 'email', id: 'postmark', deps: ['postmark'] },
  { axis: 'email', id: 'sendgrid', deps: ['@sendgrid/mail'] },
  { axis: 'email', id: 'ses', deps: ['@aws-sdk/client-ses', '@aws-sdk/client-sesv2'] },
  { axis: 'email', id: 'smtp', deps: ['nodemailer'] },
  // monitoring
  { axis: 'monitoring', id: 'sentry', deps: [/^@sentry\//], files: ['.sentryclirc', 'sentry.server.config.ts', 'sentry.client.config.ts'] },
  { axis: 'monitoring', id: 'posthog', deps: ['posthog-js', 'posthog-node', /^@posthog\//] },
  // hosting: config files first; framework adapters are an equally strong signal
  { axis: 'hosting', id: 'vercel', files: ['vercel.json', '.vercel/project.json'], deps: ['@sveltejs/adapter-vercel', '@astrojs/vercel', '@vercel/remix', '@vercel/react-router'] },
  { axis: 'hosting', id: 'netlify', files: ['netlify.toml'], deps: ['@sveltejs/adapter-netlify', '@astrojs/netlify', '@netlify/plugin-nextjs', '@netlify/remix-adapter'] },
  {
    axis: 'hosting',
    id: 'cloudflare',
    files: ['wrangler.toml', 'wrangler.jsonc', 'wrangler.json'],
    deps: ['@sveltejs/adapter-cloudflare', '@astrojs/cloudflare', '@opennextjs/cloudflare', '@cloudflare/next-on-pages', '@react-router/cloudflare', '@remix-run/cloudflare'],
  },
  { axis: 'hosting', id: 'fly', files: ['fly.toml'] },
  { axis: 'hosting', id: 'render', files: ['render.yaml'] },
  { axis: 'hosting', id: 'railway', files: ['railway.json', 'railway.toml'] },
];

const matches = (deps: Set<string>, pats: Array<string | RegExp> | undefined): boolean =>
  (pats ?? []).some((p) => (typeof p === 'string' ? deps.has(p) : [...deps].some((d) => p.test(d))));

export async function detectProviders(
  repo: Repo,
  deps: Set<string>,
  sources: Map<string, string>,
  dbHints: Set<string>,
): Promise<Partial<Record<Axis, string[]>>> {
  const out: Partial<Record<Axis, string[]>> = {};
  const add = (axis: Axis, id: string): void => {
    const list = (out[axis] ??= []);
    if (!list.includes(id)) list.push(id);
  };
  for (const r of RULES) {
    if (await ruleMatches(repo, r, deps, sources)) add(r.axis, r.id);
  }
  // Placeholder hosts in .env.example (e.g. *.neon.tech) name the database provider behind an ORM.
  for (const id of dbHints) add('db', id);
  return out;
}

async function ruleMatches(repo: Repo, r: Rule, deps: Set<string>, sources: Map<string, string>): Promise<boolean> {
  if (matches(deps, r.deps)) return true;
  for (const f of r.files ?? []) if (await repo.exists(f)) return true;
  if (r.source && (!r.sourceNeedsDep || matches(deps, r.sourceNeedsDep))) {
    for (const text of sources.values()) if (r.source.test(text)) return true;
  }
  return false;
}

/**
 * Packages imported by URL in Deno code (Supabase Edge Functions): `npm:stripe@14`, `https://esm.sh/resend`,
 * `jsr:@supabase/functions-js`. These have no package.json, so they count as dependencies here.
 */
export async function urlImportedPackages(repo: Repo, sources: Map<string, string>): Promise<Set<string>> {
  const out = new Set<string>();
  const re = /(?:npm:|jsr:|https:\/\/esm\.sh\/|https:\/\/cdn\.skypack\.dev\/)(@[a-z0-9][\w.-]*\/[a-z0-9][\w.-]*|[a-z0-9][\w.-]*)/gi;
  const scan = (text: string): void => {
    for (const m of text.matchAll(re)) out.add(m[1]!.toLowerCase());
  };
  for (const [file, text] of sources) if (file.startsWith('supabase/functions/') || /from\s+['"](?:npm:|jsr:|https:)/.test(text)) scan(text);
  for (const fn of await repo.dirs('supabase/functions')) {
    for (const f of ['deno.json', 'deno.jsonc', 'import_map.json']) {
      const t = await repo.read(`supabase/functions/${fn}/${f}`);
      if (t) scan(t);
    }
  }
  return out;
}

// ── Provider config files ───────────────────────────────────────────────────────────────────────

/** Presence only: contents are never copied (some of these can hold tokens, e.g. .sentryclirc). */
const CONFIGS: Array<[string, string]> = [
  ['.vercel/project.json', 'linked Vercel project'],
  ['vercel.json', 'Vercel project config'],
  ['netlify.toml', 'Netlify config'],
  ['wrangler.toml', 'Cloudflare Workers/Pages config'],
  ['wrangler.jsonc', 'Cloudflare Workers/Pages config'],
  ['wrangler.json', 'Cloudflare Workers/Pages config'],
  ['fly.toml', 'Fly.io app config'],
  ['render.yaml', 'Render blueprint'],
  ['railway.json', 'Railway config'],
  ['railway.toml', 'Railway config'],
  ['supabase/config.toml', 'Supabase CLI project config'],
  ['supabase/migrations', 'Supabase SQL migrations'],
  ['supabase/functions', 'Supabase Edge Functions'],
  ['convex.json', 'Convex project config'],
  ['convex', 'Convex functions directory'],
  ['firebase.json', 'Firebase project config'],
  ['.firebaserc', 'Firebase project aliases'],
  ['firestore.rules', 'Firestore security rules'],
  ['schema.prisma', 'Prisma schema'],
  ['prisma/schema.prisma', 'Prisma schema'],
  ['prisma/schema', 'Prisma multi-file schema directory'],
  ['prisma.config.ts', 'Prisma config'],
  ['drizzle.config.ts', 'Drizzle config'],
  ['drizzle.config.js', 'Drizzle config'],
  ['sentry.server.config.ts', 'Sentry server config'],
  ['sentry.client.config.ts', 'Sentry client config'],
  ['sentry.edge.config.ts', 'Sentry edge config'],
  ['.sentryclirc', 'Sentry CLI config'],
  ['instrumentation-client.ts', 'Next.js client instrumentation (Sentry/PostHog init)'],
  ['.bolt/config.json', 'Bolt project config'],
  ['.replit', 'Replit workspace config'],
  ['base44/.app.jsonc', 'Base44 app link'],
];

export async function detectConfigs(repo: Repo, pkg: PackageJson | null = null): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [path, desc] of CONFIGS) if (await repo.exists(path)) out[path] = desc;
  const custom = prismaSchemaPath(pkg);
  if (custom && !(custom in out) && (await repo.exists(custom))) out[custom] = 'Prisma schema (package.json prisma.schema)';
  return out;
}

/** package.json `prisma.schema`, when it is a plain repo-relative path (file or multi-file directory). */
function prismaSchemaPath(pkg: PackageJson | null): string | null {
  const raw = pkg?.prisma?.schema;
  if (typeof raw !== 'string') return null;
  const p = raw.trim().replace(/\\/g, '/').replace(/^(?:\.\/)+/, '').replace(/\/+$/, '');
  if (!p || p.startsWith('/') || /^[A-Za-z]:/.test(p) || p.split('/').some((seg) => seg === '..' || seg === '' || seg === '.')) return null;
  return p;
}

/** Note text marking a Prisma app (a dependency on `@prisma/client` or `prisma`). Adapters match it exactly. */
export const PRISMA_NOTE = 'Prisma detected';

export function prismaNotes(deps: Set<string>): string[] {
  return deps.has('@prisma/client') || deps.has('prisma') ? [PRISMA_NOTE] : [];
}
