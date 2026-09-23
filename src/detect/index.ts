import { resolve } from 'node:path';
import type { DetectResult, Finding } from '../core/types.js';
import { collectEnvRefs, readEnvExamples } from './env.js';
import { depNames, detectFramework, detectPackageManager, type PackageJson } from './framework.js';
import { MAX_FILES, Repo, type RepoOptions } from './fs.js';
import { detectOrigin, originNotes } from './origin.js';
import { detectConfigs, detectProviders, prismaNotes, urlImportedPackages } from './providers.js';
import { findWebhooks } from './webhooks.js';

export { isRealEnvFile } from './fs.js';

/**
 * Offline, read-only scan of a repo: framework, providers in use (as adapter ids), env var NAMES the code
 * references (and which of them the framework config inlines into the browser), provider config files,
 * Stripe webhook routes with the event types they handle, and builder origin. Never opens real env files
 * and never returns a value from any file.
 */
export async function detect(cwd: string): Promise<DetectResult> {
  return detectRepo(cwd);
}

export type DetectOptions = RepoOptions;

export async function detectRepo(cwd: string, opts: DetectOptions = {}): Promise<DetectResult> {
  const root = resolve(cwd);
  const repo = new Repo(root, opts);
  const notes: string[] = [];
  const findings: Finding[] = [];

  const pkg = await repo.json<PackageJson>('package.json');
  const { files, truncated } = await repo.walk();
  if (truncated) notes.push(`Scanned the first ${MAX_FILES} source files only; env names in the rest were not seen.`);
  const sources = await repo.loadSources(files);

  const packageManager = await detectPackageManager(repo, pkg, notes);
  const fw = await detectFramework(repo, pkg, notes);
  const deps = new Set([...depNames(pkg), ...(await urlImportedPackages(repo, sources))]);
  const examples = await readEnvExamples(repo);
  const envRefs = collectEnvRefs(sources, examples, notes, findings);
  const providers = await detectProviders(repo, deps, sources, examples.dbHints);
  const configs = await detectConfigs(repo, pkg);
  const webhooks = await findWebhooks(repo, sources, fw, notes);
  const origin = await detectOrigin(repo, pkg, deps, sources);

  notes.push(...originNotes(origin, envRefs, pkg), ...prismaNotes(deps), ...deprecationNotes(deps), ...(await monorepoNotes(repo, pkg)));

  return {
    findings,
    root,
    packageManager,
    framework: fw.framework,
    providers,
    envRefs,
    configs,
    webhooks,
    ...(origin ? { origin } : {}),
    notes,
  };
}

const DEPRECATED: Array<[string, string]> = [
  ['@supabase/auth-helpers-nextjs', '@supabase/ssr'],
  ['@supabase/auth-helpers-react', '@supabase/ssr'],
  ['@clerk/clerk-react', '@clerk/react'],
  ['@vercel/postgres', '@neondatabase/serverless'],
  ['@vercel/kv', '@upstash/redis'],
  ['@react-email/components', 'react-email'],
  ['@better-auth/cli', 'auth (npx auth@latest)'],
];

function deprecationNotes(deps: Set<string>): string[] {
  return DEPRECATED.filter(([d]) => deps.has(d)).map(([d, next]) => `${d} is deprecated; its successor is ${next}.`);
}

async function monorepoNotes(repo: Repo, pkg: PackageJson | null): Promise<string[]> {
  const markers = ['pnpm-workspace.yaml', 'turbo.json', 'nx.json'];
  const found: string[] = [];
  for (const m of markers) if (await repo.exists(m)) found.push(m);
  if (pkg?.workspaces) found.push('package.json workspaces');
  if (!found.length) return [];
  const apps: string[] = [];
  for (const parent of ['apps', 'packages']) {
    for (const d of await repo.dirs(parent)) if (await repo.exists(`${parent}/${d}/package.json`)) apps.push(`${parent}/${d}`);
  }
  const where = apps.length ? ` Candidate packages: ${apps.slice(0, 10).join(', ')}.` : '';
  return [`Monorepo (${found.join(', ')}): results cover the whole repo; run detect inside the app package that ships for precise results.${where}`];
}
