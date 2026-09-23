import type { DetectResult } from '../core/types.js';
import type { Repo } from './fs.js';

export type Framework = DetectResult['framework'];
export type PackageManager = DetectResult['packageManager'];

export interface PackageJson {
  name?: string;
  packageManager?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  workspaces?: unknown;
  /** Prisma 5/6 settings (`schema`: custom schema file or directory path). */
  prisma?: { schema?: unknown };
}

export interface FrameworkInfo {
  framework: Framework;
  /** SSR framework configured for a static/SPA build: it cannot serve webhook routes at runtime. */
  staticOutput: boolean;
  /** Next.js `basePath`, prefixed to every route. */
  basePath: string;
}

export function depNames(pkg: PackageJson | null): Set<string> {
  return new Set([...Object.keys(pkg?.dependencies ?? {}), ...Object.keys(pkg?.devDependencies ?? {})]);
}

const LOCKFILES: Array<[string, NonNullable<PackageManager>]> = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['bun.lock', 'bun'],
  ['bun.lockb', 'bun'],
  ['yarn.lock', 'yarn'],
  ['package-lock.json', 'npm'],
];

export async function detectPackageManager(repo: Repo, pkg: PackageJson | null, notes: string[]): Promise<PackageManager> {
  const found: Array<{ file: string; pm: NonNullable<PackageManager>; mtime: number }> = [];
  for (const [file, pm] of LOCKFILES) {
    if (await repo.exists(file)) found.push({ file, pm, mtime: await repo.mtime(file) });
  }
  const pms = new Set(found.map((f) => f.pm));
  if (pms.size > 1) {
    // Builder exports often ship two lockfiles; the most recently touched one is the live one.
    const newest = [...found].sort((a, b) => b.mtime - a.mtime)[0]!;
    notes.push(`Multiple lockfiles (${found.map((f) => f.file).join(', ')}); using ${newest.pm} (newest: ${newest.file}). Delete the stale one so the host resolves the same versions.`);
    return newest.pm;
  }
  if (found[0]) return found[0].pm;
  const declared = /^(pnpm|npm|yarn|bun)@/.exec(pkg?.packageManager ?? '');
  return declared ? (declared[1] as NonNullable<PackageManager>) : null;
}

type Rule = [Exclude<Framework, 'static' | 'unknown'>, Array<string>, string[]];

// Order matters: Remix, React Router, Astro and SvelteKit all ship a Vite config, so Vite is last.
const RULES: Rule[] = [
  ['next', ['next'], ['next.config.js', 'next.config.mjs', 'next.config.ts', 'next.config.cjs']],
  ['nuxt', ['nuxt'], ['nuxt.config.ts', 'nuxt.config.js', 'nuxt.config.mjs']],
  ['sveltekit', ['@sveltejs/kit'], []],
  ['astro', ['astro'], ['astro.config.mjs', 'astro.config.ts', 'astro.config.mts', 'astro.config.js']],
  ['react-router', ['@react-router/dev'], ['react-router.config.ts', 'react-router.config.js']],
  ['remix', ['@remix-run/dev', '@remix-run/node', '@remix-run/cloudflare', '@remix-run/deno', '@remix-run/react'], ['remix.config.js', 'remix.config.mjs']],
  ['vite', ['vite'], ['vite.config.ts', 'vite.config.js', 'vite.config.mjs', 'vite.config.mts']],
];

/** Frameworks we recognise but that have no enum value (yet): report as unknown with a note. */
const OTHER: Array<[string, string]> = [
  ['@tanstack/react-start', 'TanStack Start'],
  ['@tanstack/start', 'TanStack Start'],
  ['@solidjs/start', 'SolidStart'],
  ['expo', 'Expo (mobile)'],
  ['react-scripts', 'Create React App (deprecated)'],
];

export async function detectFramework(repo: Repo, pkg: PackageJson | null, notes: string[]): Promise<FrameworkInfo> {
  const framework = await pickFramework(repo, pkg, notes);
  return { framework, ...(await renderInfo(repo, framework, depNames(pkg))) };
}

async function pickFramework(repo: Repo, pkg: PackageJson | null, notes: string[]): Promise<Framework> {
  const deps = depNames(pkg);
  const other = OTHER.find(([d]) => deps.has(d));
  for (const [fw, fwDeps] of RULES) {
    if (fw === 'vite' && other) break;
    if (fwDeps.some((d) => deps.has(d))) return fw;
  }
  if (other) {
    notes.push(`${other[1]} detected; golive has no framework profile for it yet, so framework is "unknown".`);
    return 'unknown';
  }
  for (const [fw, , files] of RULES) {
    for (const f of files) if (await repo.exists(f)) return fw;
  }
  const hasIndex = (await repo.exists('index.html')) || (await repo.exists('public/index.html'));
  if (hasIndex && !pkg?.scripts?.build) return 'static';
  return 'unknown';
}

async function renderInfo(repo: Repo, framework: Framework, deps: Set<string>): Promise<Omit<FrameworkInfo, 'framework'>> {
  if (framework === 'next') {
    const cfg = await firstText(repo, ['next.config.ts', 'next.config.mjs', 'next.config.js', 'next.config.cjs']);
    const basePath = /basePath\s*:\s*['"`](\/[^'"`]*)['"`]/.exec(cfg)?.[1] ?? '';
    return { staticOutput: /output\s*:\s*['"`]export['"`]/.test(cfg), basePath: basePath.replace(/\/$/, '') };
  }
  if (framework === 'sveltekit') return { staticOutput: deps.has('@sveltejs/adapter-static'), basePath: '' };
  if (framework === 'react-router') {
    const cfg = await firstText(repo, ['react-router.config.ts', 'react-router.config.js']);
    return { staticOutput: /\bssr\s*:\s*false\b/.test(cfg), basePath: '' };
  }
  return { staticOutput: false, basePath: '' };
}

export async function firstText(repo: Repo, files: string[]): Promise<string> {
  for (const f of files) {
    const t = await repo.read(f);
    if (t !== null) return t;
  }
  return '';
}
