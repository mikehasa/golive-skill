/** Public release metadata only. Never create a provider context or read project credentials. */
import { constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { releaseIdentity, validateReleaseManifest, PUBLIC_REPOSITORY, isReleaseVersion } from './release.js';
import type { ReleaseIdentity } from './types.js';

export const UPDATE_METADATA_URL = 'https://raw.githubusercontent.com/mikehasa/golive-skill/main/skills/golive/release.json';
const TTL = 24 * 60 * 60 * 1000;
const LIMIT = 512 * 1024;
export interface UpdateOwnership {
  manager: string | null;
  pin?: string | null;
  autoUpdate?: boolean;
  location?: string;
  updateCommand?: string;
}
export interface UpdateResult {
  ok: true;
  status: 'current' | 'available' | 'unavailable' | 'disabled' | 'pinned';
  current: ReleaseIdentity;
  latest?: ReleaseIdentity;
  checkedAt?: string;
  cached: boolean;
  automaticCheck: boolean;
  automaticInstall: boolean;
  manager: string;
  updateCommand: string;
  note?: string;
}

/** Semver precedence including alpha.9 < alpha.10; build metadata is not a release identity. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    if (!isReleaseVersion(v)) throw new Error('Invalid release version.');
    const m = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?$/.exec(v);
    if (!m) throw new Error('Invalid release version.');
    return { core: m.slice(1, 4).map(BigInt), pre: m[4]?.split('.') };
  };
  const x = parse(a), y = parse(b);
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i]! > y.core[i]! ? 1 : -1;
  if (!x.pre || !y.pre) return x.pre === y.pre ? 0 : !x.pre ? 1 : -1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i], q = y.pre[i];
    if (p === q) continue;
    if (p === undefined || q === undefined) return p === undefined ? -1 : 1;
    const pn = /^\d+$/.test(p), qn = /^\d+$/.test(q);
    if (pn && qn) return BigInt(p) > BigInt(q) ? 1 : -1;
    if (pn !== qn) return pn ? -1 : 1;
    return p > q ? 1 : -1;
  }
  return 0;
}

// Cache safety failures disable caching, never turn an offline metadata check into a fatal error.
function safeParents(path: string, create = false): void {
  if (!isAbsolute(path)) throw new Error('Cache path must be absolute.');
  const parent = dirname(path);
  if (parent === path) return;
  safeParents(parent, create);
  let s;
  try { s = lstatSync(path); } catch (e) {
    if (!create || (e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    mkdirSync(path, { mode: 0o700 }); s = lstatSync(path);
  }
  const safeStickyRoot = s.uid === 0 && (s.mode & 0o1000) !== 0;
  if (!s.isDirectory() || s.isSymbolicLink() || (s.uid !== 0 && process.getuid && s.uid !== process.getuid()) || ((s.mode & 0o022) !== 0 && !safeStickyRoot)) throw new Error('Unsafe cache parent.');
}

function readCache(path: string, now: number): { checkedAt: string; manifest: unknown } | undefined {
  let fd: number | undefined;
  try {
    safeParents(dirname(path));
    const s = lstatSync(path);
    if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1 || s.size > LIMIT || (s.mode & 0o022) || (process.getuid && s.uid !== process.getuid())) return;
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const f = fstatSync(fd);
    if (f.ino !== s.ino || f.dev !== s.dev) return;
    const value = JSON.parse(readFileSync(fd, 'utf8'));
    const checked = Date.parse(value.checkedAt);
    if (value.url !== UPDATE_METADATA_URL || !Number.isFinite(checked) || checked > now || now - checked > TTL) return;
    validateReleaseManifest(value.manifest);
    return value;
  } catch { return; } finally { if (fd !== undefined) closeSync(fd); }
}

function writeCache(path: string, value: unknown): void {
  try {
    safeParents(dirname(path), true);
    try { if (lstatSync(path).isSymbolicLink()) return; } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') return; }
    const tmp = `${path}.${randomUUID()}.tmp`;
    writeFileSync(tmp, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
    renameSync(tmp, path);
  } catch { /* Cache is optional. No raw OS errors or response bodies are emitted. */ }
}

async function download(fetcher: typeof fetch, timeoutMs: number): Promise<unknown> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('Update check unavailable.')); }, timeoutMs); });
  const request = async () => {
    const response = await fetcher(UPDATE_METADATA_URL, { redirect: 'error', credentials: 'omit', signal: controller.signal, headers: { Accept: 'application/json' } });
    if (response.status !== 200 || !response.body) throw new Error('Update check unavailable.');
    const reader = response.body.getReader(); const parts: Uint8Array[] = []; let size = 0;
    try {
      while (true) {
        const item = await reader.read(); if (item.done) break;
        size += item.value.byteLength;
        if (size > LIMIT) { await reader.cancel(); throw new Error('Update check unavailable.'); }
        parts.push(item.value);
      }
    } finally { reader.releaseLock(); }
    return JSON.parse(Buffer.concat(parts).toString('utf8'));
  };
  try { return await Promise.race([request(), deadline]); } finally { clearTimeout(timer!); controller.abort(); }
}

export async function checkForUpdate(current: ReleaseIdentity, options: {
  fetcher?: typeof fetch; cachePath?: string | false; now?: number; timeoutMs?: number;
  disabled?: boolean; ownership?: UpdateOwnership;
} = {}): Promise<UpdateResult> {
  const owner = options.ownership;
  const base: UpdateResult = {
    ok: true, status: 'unavailable', current, cached: false, automaticCheck: !options.disabled,
    automaticInstall: owner?.manager === 'owned' && owner.autoUpdate === true && !owner.pin,
    manager: owner?.manager ?? 'external',
    updateCommand: owner?.manager === 'owned'
      ? 'At the start of a new run: node <installed-skill>/scripts/install-cli.mjs update --between-runs --ref <release-tag>'
      : owner?.updateCommand ?? 'Use your installation manager: Skills CLI: npx skills update golive -p (project) or -g (global); plugins: their manager; manual copies: replace the complete bundle.',
  };
  if (options.disabled) return { ...base, status: 'disabled', note: 'Update checking is disabled; no network request was made.' };
  const now = options.now ?? Date.now();
  const cachePath = options.cachePath === undefined ? join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'golive', 'update-check.json') : options.cachePath;
  try {
    const cached = cachePath ? readCache(cachePath, now) : undefined;
    const manifest = cached?.manifest ?? await download(options.fetcher ?? fetch, options.timeoutMs ?? 3000);
    validateReleaseManifest(manifest);
    // Only an immutable public release is actionable, never an unpublished development snapshot.
    if (manifest.name !== 'golive' || manifest.source.repository !== PUBLIC_REPOSITORY || !manifest.source.ref) throw new Error('Unpublished metadata.');
    const latest = releaseIdentity(manifest);
    const checkedAt = cached?.checkedAt ?? new Date(now).toISOString();
    if (!cached && cachePath) writeCache(cachePath, { url: UPDATE_METADATA_URL, checkedAt, manifest });
    return { ...base, status: owner?.pin ? 'pinned' : compareVersions(latest.version, current.version) > 0 ? 'available' : 'current', latest, checkedAt, cached: !!cached,
      ...(owner?.pin ? { note: 'Pinned installation was not changed. Select a different release explicitly to upgrade.' } : {}) };
  } catch {
    return { ...base, note: 'Public update metadata is unavailable or invalid. Existing offline commands remain usable; no installation was changed.' };
  }
}
