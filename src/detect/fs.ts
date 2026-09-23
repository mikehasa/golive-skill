import { lstat, readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

/** Source files we scan for env references and webhook routes. */
const SOURCE_RE = /\.(?:[cm]?[jt]sx?|vue|svelte|astro)$/;
const SKIP_FILE_RE = /\.d\.[cm]?ts$|\.min\.js$|\.(?:test|spec)\.[cm]?[jt]sx?$/;

export const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', '.nuxt', '.svelte-kit', '.vercel', '.output', 'coverage', 'vendor',
  '.netlify', '.turbo', '.cache', '.wrangler', '.astro', '.expo',
  // Tests and fixtures are not shipped: their env names and fake webhook routes would only add noise.
  'test', 'tests', '__tests__', '__mocks__', 'fixtures', 'e2e', 'cypress', 'playwright',
]);
/** Standard project skill installs (including older agent-specific locations). Skip only their
 * skills subtree: ordinary dot-directories, .well-known, and app folders named skills still count.
 * .agents/skills is the shared install location used by the skills installer. */
const AGENT_SKILL_PARENTS = new Set([
  '.agents', '.claude', '.codex', '.cursor', '.github', '.opencode', '.gemini',
  '.windsurf', '.roo', '.continue', '.factory',
]);
export const MAX_FILES = 5000;
export const MAX_FILE_BYTES = 1_000_000;
/** Total bytes of source we hold in memory at once. */
export const MAX_TOTAL_BYTES = 64_000_000;

/** Committed env templates: placeholders only, so reading them is safe. */
export const EXAMPLE_ENV_FILES = ['.env.example', '.env.sample', '.env.template', '.env.local.example', '.env.dist', '.env-example', 'example.env'];

/**
 * Real env files hold secret values; detection must never open them. Everything that looks like one
 * and is not an explicit template is refused.
 */
export function isRealEnvFile(path: string): boolean {
  const b = basename(path);
  if (EXAMPLE_ENV_FILES.includes(b)) return false;
  return /^\.env/.test(b) || /\.env$/.test(b) || b === '.dev.vars' || b.startsWith('.dev.vars.');
}

export function isSourceFile(name: string): boolean {
  return SOURCE_RE.test(name) && !SKIP_FILE_RE.test(name);
}

export interface RepoOptions {
  /** Called with the repo-relative path of every file actually opened (tests assert on it). */
  onRead?: (rel: string) => void;
}

/** Read-only view of a repo. Every file read goes through `read`, which enforces the env-file guard. */
export class Repo {
  private readonly cache = new Map<string, string | null>();

  constructor(
    readonly root: string,
    private readonly opts: RepoOptions = {},
  ) {}

  async exists(rel: string): Promise<boolean> {
    try {
      await lstat(join(this.root, rel));
      return true;
    } catch {
      return false;
    }
  }

  async mtime(rel: string): Promise<number> {
    try {
      return (await lstat(join(this.root, rel))).mtimeMs;
    } catch {
      return 0;
    }
  }

  async read(rel: string): Promise<string | null> {
    if (isRealEnvFile(rel)) throw new Error(`detect refused to open ${rel}: real env files hold secret values`);
    const hit = this.cache.get(rel);
    if (hit !== undefined) return hit;
    let text: string | null = null;
    try {
      const abs = join(this.root, rel);
      const st = await lstat(abs);
      if (st.isFile() && st.size <= MAX_FILE_BYTES) {
        this.opts.onRead?.(rel);
        text = await readFile(abs, 'utf8');
      }
    } catch {
      text = null;
    }
    this.cache.set(rel, text);
    return text;
  }

  async json<T>(rel: string): Promise<T | null> {
    const text = await this.read(rel);
    if (text === null) return null;
    try {
      return JSON.parse(text) as T;
    } catch {
      return null;
    }
  }

  /** Sorted names of the subdirectories of `rel` (no symlinks). */
  async dirs(rel: string): Promise<string[]> {
    try {
      const entries = await readdir(join(this.root, rel), { withFileTypes: true });
      return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
    } catch {
      return [];
    }
  }

  /** Source files (repo-relative, `/`-separated), deterministic order, capped at MAX_FILES. */
  async walk(): Promise<{ files: string[]; truncated: boolean }> {
    const files: string[] = [];
    let truncated = false;
    const visit = async (dir: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(dir ? join(this.root, dir) : this.root, { withFileTypes: true });
      } catch {
        return;
      }
      entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      for (const e of entries) {
        if (truncated) return;
        const rel = dir ? `${dir}/${e.name}` : e.name;
        // Dirents use lstat semantics, so symlinks are neither files nor dirs here and get skipped.
        if (e.isDirectory()) {
          const installedSkills = e.name === 'skills' && AGENT_SKILL_PARENTS.has(basename(dir));
          if (!SKIP_DIRS.has(e.name) && !installedSkills) await visit(rel);
        } else if (e.isFile() && isSourceFile(e.name)) {
          if (files.length >= MAX_FILES) truncated = true;
          else files.push(rel);
        }
      }
    };
    await visit('');
    return { files, truncated };
  }

  /** Reads the given source files within the size budgets. */
  async loadSources(files: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    let total = 0;
    const BATCH = 32;
    for (let i = 0; i < files.length && total < MAX_TOTAL_BYTES; i += BATCH) {
      const batch = files.slice(i, i + BATCH);
      const texts = await Promise.all(batch.map((f) => this.read(f)));
      batch.forEach((f, j) => {
        const t = texts[j];
        if (t == null || total >= MAX_TOTAL_BYTES) return;
        total += t.length;
        out.set(f, t);
      });
    }
    return out;
  }
}
