/**
 * The repository identity behind a default provider project name. The working folder is a scratch
 * accident in a git worktree (`setup-deploy-b59cf2`) or a monorepo checkout, and a project named
 * after it is orphaned as soon as the repo is checked out somewhere else — so the repository's
 * `origin` remote wins when golive can read one, and the folder stays the fallback (issue #64).
 *
 * Read-only and never fatal: no `.git`, no git binary, no remote or a non-zero answer all mean the
 * folder case, exactly the behaviour golive had before.
 */
import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { Ctx } from './types.js';

export interface RepoName {
  /** The name a provider project would take (lowercase, dashes, at most 63 characters). */
  name: string;
  /** `git-remote` when it came from the repository's `origin` remote, else the working folder. */
  from: 'git-remote' | 'folder';
  /** The working folder's own name, as it is on disk (previews name what was not used). */
  folder: string;
}

/** Keyed by the exec function: a StepContext is a spread of the Ctx, so it shares exec but not identity. */
const identities = new WeakMap<object, Promise<RepoName>>();

/** The repository (or folder) identity, read once per run. Never throws. */
export function repoIdentity(ctx: Ctx): Promise<RepoName> {
  let p = identities.get(ctx.exec);
  if (!p) {
    p = resolve(ctx);
    identities.set(ctx.exec, p);
  }
  return p;
}

async function resolve(ctx: Ctx): Promise<RepoName> {
  const folder = basename(ctx.cwd);
  const remote = await readOriginRemote(ctx);
  const fromRemote = remote ? repoFromRemote(remote) : '';
  return fromRemote
    ? { name: fromRemote, from: 'git-remote', folder }
    : { name: slug(folder) || 'app', from: 'folder', folder };
}

async function readOriginRemote(ctx: Ctx): Promise<string | null> {
  // A worktree's `.git` is a file pointing at the main checkout, which shares the remote config.
  if (!existsSync(join(ctx.cwd, '.git'))) return null;
  try {
    const r = await ctx.exec('git', ['config', '--get', 'remote.origin.url'], { cwd: ctx.cwd, timeoutMs: 5_000 });
    return r.code === 0 ? (r.stdout.trim().split('\n')[0] ?? '').trim() || null : null;
  } catch {
    return null;
  }
}

/** `https://host/org/repo.git`, `ssh://git@host:22/org/repo` and `git@host:org/repo.git` → `repo`. */
function repoFromRemote(url: string): string {
  const parts = url.trim().replace(/\.git$/i, '').split(/[\\/:]+/).filter(Boolean);
  return slug(parts.at(-1) ?? '');
}

/** Provider project names: lowercase letters, digits, dashes, at most 63 characters. */
function slug(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63);
}
