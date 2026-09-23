import { createHash } from 'node:crypto';
import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import product from '../../package.json';
import type { ReleaseIdentity, ReleaseManifest } from './types.js';

export const PRODUCT_NAME = 'golive';
export const PRODUCT_VERSION = product.version;
export const PUBLIC_REPOSITORY = 'https://github.com/mikehasa/golive-skill';
export const RELEASE_SCHEMAS = { config: 1, state: 1, approval: 1 } as const;
const HASH = /^[a-f0-9]{64}$/;
const BUNDLE_ERROR = 'Release bundle is incomplete, mixed or damaged. Reinstall the complete skill from its installation manager; do not replace individual files.';

export class ReleaseIntegrityError extends Error {}

/** Release tags use strict SemVer precedence without build metadata. */
export function isReleaseVersion(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(value);
  return !!match && (!match[4] || match[4].split('.').every((part) => !/^\d+$/.test(part) || part === '0' || !part.startsWith('0')));
}

/** Shared manifest wire format: recursive lexical keys, array order preserved. */
export function canonicalReleaseJson(value: unknown): string {
  function sort(v: unknown): unknown {
    if (Array.isArray(v)) return v.map(sort);
    if (v !== null && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort((v as Record<string, unknown>)[k])]));
    return v;
  }
  return JSON.stringify(sort(value));
}

export function releaseDigest(manifest: Omit<ReleaseManifest, 'bundleDigest'> | ReleaseManifest): string {
  const { bundleDigest: _ignored, ...body } = manifest as ReleaseManifest;
  return createHash('sha256').update(canonicalReleaseJson(body)).digest('hex');
}

function object(v: unknown): v is Record<string, unknown> { return v !== null && typeof v === 'object' && !Array.isArray(v); }
function exactKeys(v: Record<string, unknown>, keys: string[]): boolean { return Object.keys(v).sort().join(',') === keys.sort().join(','); }

export function validReleasePath(path: string): boolean {
  if (!/^[A-Za-z0-9._/-]+$/.test(path) || path.split('/').some((p) => !p || p === '.' || p === '..')) return false;
  return ['SKILL.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md'].includes(path) || /^(?:references|scripts)\/.+/.test(path);
}

export function validateReleaseIdentity(value: unknown): asserts value is ReleaseIdentity {
  if (!object(value) || !exactKeys(value, ['schema', 'name', 'version', 'source', 'node', 'schemas', 'bundleDigest'])
    || value.schema !== 1 || typeof value.name !== 'string' || !/^[a-z][a-z0-9]{0,63}$/.test(value.name)
    || !isReleaseVersion(value.version) || value.node !== '>=20'
    || !object(value.source) || !exactKeys(value.source, ['repository', 'ref']) || value.source.repository !== PUBLIC_REPOSITORY
    || (value.source.ref !== null && value.source.ref !== `v${value.version}`)
    || !object(value.schemas) || !exactKeys(value.schemas, ['config', 'state', 'approval'])
    || !Object.values(value.schemas).every((n) => Number.isSafeInteger(n) && (n as number) > 0)
    || typeof value.bundleDigest !== 'string' || !HASH.test(value.bundleDigest)) throw new ReleaseIntegrityError(BUNDLE_ERROR);
}

export function releaseIdentity(manifest: ReleaseManifest): ReleaseIdentity {
  const { files: _files, ...identity } = manifest;
  return structuredClone(identity);
}

export function validateReleaseManifest(value: unknown): asserts value is ReleaseManifest {
  if (!object(value) || !exactKeys(value, ['schema', 'name', 'version', 'source', 'node', 'schemas', 'bundleDigest', 'files'])) throw new ReleaseIntegrityError(BUNDLE_ERROR);
  const { files, ...identity } = value;
  validateReleaseIdentity(identity);
  if (!object(files) || Object.keys(files).length < 5 || Object.keys(files).length > 2000
    || !Object.entries(files).every(([path, hash]) => validReleasePath(path) && typeof hash === 'string' && HASH.test(hash))
    || !['SKILL.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md', `scripts/${identity.name}.mjs`].every((p) => p in files)
    || !Object.keys(files).some((p) => p.startsWith('references/'))
    || releaseDigest(value as unknown as ReleaseManifest) !== identity.bundleDigest) throw new ReleaseIntegrityError(BUNDLE_ERROR);
}

export function parseReleaseManifest(value: unknown): ReleaseManifest {
  validateReleaseManifest(value);
  return structuredClone(value);
}

function readRegular(path: string): Buffer {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 50 * 1024 * 1024) throw new ReleaseIntegrityError(BUNDLE_ERROR);
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== stat.dev || opened.ino !== stat.ino) throw new ReleaseIntegrityError(BUNDLE_ERROR);
    return readFileSync(fd);
  } finally { closeSync(fd); }
}

function inventory(root: string, prefix = ''): string[] {
  const dir = join(root, prefix);
  const stat = lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new ReleaseIntegrityError(BUNDLE_ERROR);
  const files: string[] = [];
  for (const entry of readdirSync(dir).sort()) {
    const relative = prefix ? `${prefix}/${entry}` : entry;
    const next = lstatSync(join(root, relative));
    if (next.isSymbolicLink()) throw new ReleaseIntegrityError(BUNDLE_ERROR);
    if (next.isDirectory()) {
      if (!(relative === 'references' || relative === 'scripts' || relative.startsWith('references/') || relative.startsWith('scripts/'))) throw new ReleaseIntegrityError(BUNDLE_ERROR);
      files.push(...inventory(root, relative));
    } else if (next.isFile() && (relative === 'release.json' || validReleasePath(relative))) files.push(relative);
    else throw new ReleaseIntegrityError(BUNDLE_ERROR);
  }
  return files;
}

/** Verifies every distributed file, including instructions, before any account access. */
export function verifyReleaseBundle(root: string): ReleaseManifest {
  try {
    const value: unknown = JSON.parse(readRegular(join(root, 'release.json')).toString('utf8'));
    validateReleaseManifest(value);
    const actual = inventory(root).filter((p) => p !== 'release.json');
    if (actual.sort().join('\n') !== Object.keys(value.files).sort().join('\n')) throw new ReleaseIntegrityError(BUNDLE_ERROR);
    for (const path of actual) {
      if (createHash('sha256').update(readRegular(join(root, path))).digest('hex') !== value.files[path]) throw new ReleaseIntegrityError(BUNDLE_ERROR);
    }
    return value;
  } catch { throw new ReleaseIntegrityError(BUNDLE_ERROR); }
}

export function sameRelease(a: ReleaseIdentity | undefined, b: ReleaseIdentity): boolean {
  return !!a && canonicalReleaseJson(a) === canonicalReleaseJson(b);
}

export function assertReleaseSchemas(release: ReleaseIdentity): void {
  validateReleaseIdentity(release);
  if (canonicalReleaseJson(release.schemas) !== canonicalReleaseJson(RELEASE_SCHEMAS)) throw new ReleaseIntegrityError('Unsupported release schemas. Use a compatible complete release; preserve app state and re-observe before planning.');
}

/** The CLI passes its own import.meta.url, so cwd or project files cannot select its identity. */
export function loadRuntimeRelease(moduleUrl: string, invokedPath: string | undefined = process.argv[1]): ReleaseIdentity {
  const path = fileURLToPath(moduleUrl);
  // Source development is explicit; the shipped .mjs never takes this path. Identity includes
  // source files as well as skill instructions so editing code also invalidates approvals.
  if (basename(path) === 'cli.ts' && basename(dirname(path)) === 'src') {
    const root = resolve(dirname(path), '..');
    const hashes: Record<string, string> = {};
    const walk = (base: string, relative: string): void => {
      for (const name of readdirSync(join(base, relative)).sort()) {
        const file = `${relative}/${name}`;
        const stat = lstatSync(join(base, file));
        if (stat.isSymbolicLink()) throw new ReleaseIntegrityError(BUNDLE_ERROR);
        if (stat.isDirectory()) walk(base, file);
        else hashes[file] = createHash('sha256').update(readRegular(join(base, file))).digest('hex');
      }
    };
    walk(root, 'src');
    walk(root, `skills/${PRODUCT_NAME}/references`);
    for (const file of ['package.json', `skills/${PRODUCT_NAME}/SKILL.md`]) hashes[file] = createHash('sha256').update(readRegular(join(root, file))).digest('hex');
    return { schema: 1, name: PRODUCT_NAME, version: PRODUCT_VERSION, source: { repository: PUBLIC_REPOSITORY, ref: null }, node: '>=20', schemas: { ...RELEASE_SCHEMAS }, bundleDigest: createHash('sha256').update(canonicalReleaseJson(hashes)).digest('hex') };
  }
  // Node normally resolves a main-script symlink before setting import.meta.url. Check the
  // originally invoked surrounding skill too: a symlink to only the healthy runtime must not
  // authorize different/missing instructions beside the path the agent was told to execute.
  let bundleRoot: string;
  try {
    if (!invokedPath) throw new ReleaseIntegrityError(BUNDLE_ERROR);
    const invoked = resolve(invokedPath);
    const runtime = realpathSync(path);
    bundleRoot = resolve(dirname(runtime), '..');
    if (basename(runtime) !== `${PRODUCT_NAME}.mjs` || basename(dirname(runtime)) !== 'scripts'
      || basename(invoked) !== `${PRODUCT_NAME}.mjs` || basename(dirname(invoked)) !== 'scripts'
      || realpathSync(invoked) !== runtime || realpathSync(resolve(dirname(invoked), '..')) !== bundleRoot) throw new ReleaseIntegrityError(BUNDLE_ERROR);
  } catch { throw new ReleaseIntegrityError(BUNDLE_ERROR); }
  const manifest = verifyReleaseBundle(bundleRoot);
  if (manifest.name !== PRODUCT_NAME || manifest.version !== PRODUCT_VERSION) throw new ReleaseIntegrityError(BUNDLE_ERROR);
  const identity = releaseIdentity(manifest);
  assertReleaseSchemas(identity);
  return identity;
}
