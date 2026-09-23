import type { EnvRef } from '../core/types.js';
import type { PackageJson } from './framework.js';
import type { Repo } from './fs.js';

/**
 * AI app-builder export markers. Only STRONG markers count (shadcn, port 8080 and the like are far too
 * common outside builders to mean anything).
 */
export async function detectOrigin(repo: Repo, pkg: PackageJson | null, deps: Set<string>, sources: Map<string, string>): Promise<string | undefined> {
  const viteCfg = ['vite.config.ts', 'vite.config.js', 'vite.config.mjs', 'vite.config.mts'].map((f) => sources.get(f) ?? '').join('\n');
  if (deps.has('lovable-tagger') || /from\s+['"]lovable-tagger['"]/.test(viteCfg)) return 'lovable';
  if ((await repo.exists('.bolt/config.json')) || (await repo.exists('.bolt/prompt'))) return 'bolt';
  const layout = sources.get('app/layout.tsx') ?? sources.get('src/app/layout.tsx') ?? '';
  if (pkg?.name === 'my-v0-project' || /generator\s*:\s*['"]v0\.(?:app|dev)['"]/.test(layout)) return 'v0';
  if ((await repo.exists('.replit')) || (await repo.exists('replit.nix')) || [...deps].some((d) => d.startsWith('@replit/'))) return 'replit';
  if (deps.has('@base44/sdk') || deps.has('@base44/vite-plugin') || (await repo.exists('base44/.app.jsonc'))) return 'base44';
  return undefined;
}

/** What the builder origin means for shipping to the user's own accounts. */
export function originNotes(origin: string | undefined, envRefs: EnvRef[], pkg: PackageJson | null): string[] {
  const names = new Set(envRefs.map((r) => r.name));
  const notes: string[] = [];
  if (origin) notes.push(`Exported from ${origin}.`);
  if (origin === 'replit') {
    const platformOnly = ['REPL_ID', 'REPLIT_DOMAINS', 'ISSUER_URL', 'REPLIT_DB_URL'].filter((n) => names.has(n));
    if (platformOnly.length) notes.push(`Replit-only env (${platformOnly.join(', ')}) does not exist off Replit; Replit Auth must be replaced before shipping elsewhere.`);
  }
  if (origin === 'base44') notes.push('Base44 exports keep data, auth and functions on Base44 servers; golive can host the frontend, but the db/auth axes stay on Base44 unless migrated.');
  const pinnedLatest = Object.entries({ ...pkg?.dependencies, ...pkg?.devDependencies }).filter(([, v]) => v === 'latest').length;
  if (pinnedLatest) notes.push(`${pinnedLatest} dependencies are pinned to "latest"; host builds may resolve different versions than the builder did.`);
  return notes;
}
