// Zero-dependency, whole-bundle installer. Only this installer's owned copies are mutable.
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';

export const PRODUCT = 'golive';
export const REPOSITORY = 'https://github.com/mikehasa/golive-skill';
const MAX_FILE = 16 * 1024 * 1024;
const MAX_TOTAL = 32 * 1024 * 1024;
const MANIFEST_LIMIT = 256 * 1024;
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const canonical = (value) => JSON.stringify(sort(value));
function sort(value) { return Array.isArray(value) ? value.map(sort) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map((k) => [k, sort(value[k])])) : value; }
function fail(message) { throw new Error(message); }
function stat(path) { try { return lstatSync(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } }
function safePath(path, allowMissing = false) {
  const absolute = resolve(path); let current = parse(absolute).root;
  for (const part of relative(current, absolute).split(sep).filter(Boolean)) {
    current = join(current, part); const info = stat(current);
    if (!info) { if (allowMissing) continue; fail('Installation path is missing.'); }
    if (info.isSymbolicLink()) fail('Refusing a symlink in an installation or source path.');
    if (current !== absolute && !info.isDirectory()) fail('Installation parent is not a directory.');
  }
}
function mkdirSafe(path) { safePath(path, true); mkdirSync(path, { recursive: true, mode: 0o700 }); safePath(path); }
function readSafe(path, maximum = MAX_FILE) {
  safePath(path); const before = stat(path);
  if (!before?.isFile() || before.nlink !== 1 || before.size > maximum) fail('Bundle file is unsafe or exceeds its size limit.');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { const opened = fstatSync(fd); if (!opened.isFile() || opened.nlink !== 1 || opened.ino !== before.ino || opened.dev !== before.dev || opened.size > maximum) fail('Bundle file changed while opening.'); const bytes = readFileSync(fd); if (bytes.length > maximum) fail('Bundle file exceeds its size limit.'); return bytes; } finally { closeSync(fd); }
}
function json(path, maximum = MANIFEST_LIMIT) { try { return JSON.parse(readSafe(path, maximum).toString('utf8')); } catch { fail('Installation metadata is unreadable or invalid.'); } }
export function isReleaseVersion(value) {
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(value)) return false;
  const pre = value.split('-').slice(1).join('-');
  return !pre || pre.split('.').every((part) => !/^[0-9]+$/.test(part) || part === '0' || !part.startsWith('0'));
}
function isRef(ref) { return typeof ref === 'string' && ref.startsWith('v') && isReleaseVersion(ref.slice(1)); }
function newer(candidate, current) {
  const parseVersion = (value) => { const [core, ...pre] = value.split('-'); return { core: core.split('.').map(BigInt), pre: pre.join('-').split('.').filter(Boolean) }; };
  const a = parseVersion(candidate), b = parseVersion(current);
  for (let i = 0; i < 3; i++) if (a.core[i] !== b.core[i]) return a.core[i] > b.core[i];
  if (!a.pre.length || !b.pre.length) return !a.pre.length && Boolean(b.pre.length);
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) { if (a.pre[i] === undefined) return false; if (b.pre[i] === undefined) return true; if (a.pre[i] === b.pre[i]) continue; const an = /^[0-9]+$/.test(a.pre[i]), bn = /^[0-9]+$/.test(b.pre[i]); return an && bn ? BigInt(a.pre[i]) > BigInt(b.pre[i]) : an !== bn ? !an : a.pre[i] > b.pre[i]; }
  return false;
}
function filePath(path) { return typeof path === 'string' && !path.includes('\\') && !path.includes('%') && !path.split('/').some((p) => !p || p === '.' || p === '..') && /^(?:SKILL\.md|LICENSE|THIRD_PARTY_NOTICES\.md|(?:references|scripts)\/[A-Za-z0-9._/-]+)$/.test(path); }
function exactKeys(value, expected) { return value && typeof value === 'object' && !Array.isArray(value) && canonical(Object.keys(value).sort()) === canonical(expected.slice().sort()); }
export function validateManifest(manifest) {
  if (!exactKeys(manifest, ['schema', 'name', 'version', 'source', 'node', 'schemas', 'files', 'bundleDigest']) || !exactKeys(manifest.source, ['repository', 'ref']) || !exactKeys(manifest.schemas, ['config', 'state', 'approval'])) fail('Release metadata fields are incompatible.');
  if (!manifest || manifest.schema !== 1 || manifest.name !== PRODUCT || !isReleaseVersion(manifest.version) || manifest.source?.repository !== REPOSITORY || !(manifest.source.ref === null || manifest.source.ref === `v${manifest.version}`) || manifest.node !== '>=20' || canonical(manifest.schemas) !== canonical({ config: 1, state: 1, approval: 1 }) || !manifest.files || Array.isArray(manifest.files) || typeof manifest.files !== 'object') fail('Release metadata is incompatible or its public source is not trusted.');
  const paths = Object.keys(manifest.files);
  if (paths.length < 5 || paths.length > 256 || !['SKILL.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md', `scripts/${PRODUCT}.mjs`].every((path) => paths.includes(path)) || !paths.some((path) => path.startsWith('references/')) || paths.some((p) => !filePath(p) || !/^[a-f0-9]{64}$/.test(manifest.files[p]))) fail('Release file list is incomplete or unsafe.');
  const { bundleDigest, ...body } = manifest;
  if (!/^[a-f0-9]{64}$/.test(bundleDigest) || sha(canonical(body)) !== bundleDigest) fail('Release metadata integrity failed.');
  return manifest;
}
export function verifyBundle(source) {
  safePath(source); const manifest = validateManifest(json(join(source, 'release.json'))); const found = []; let total = 0;
  function walk(path, prefix = '') {
    for (const name of readdirSync(path).sort()) {
      const rel = prefix ? `${prefix}/${name}` : name; const full = join(path, name); const info = stat(full);
      if (info?.isSymbolicLink()) fail('Bundle contains a symlink.');
      if (info?.isDirectory()) { if (!['references', 'scripts'].includes(rel) && !rel.startsWith('references/') && !rel.startsWith('scripts/')) fail('Bundle contains an unsupported directory.'); walk(full, rel); }
      else if (info?.isFile()) { found.push(rel); const bytes = readSafe(full); total += bytes.length; if (total > MAX_TOTAL) fail('Bundle exceeds its total size limit.'); if (rel !== 'release.json' && sha(bytes) !== manifest.files[rel]) fail('Bundle integrity failed; reinstall the complete skill.'); }
      else fail('Bundle contains an unsupported file.');
    }
  }
  walk(source);
  if (canonical(found.sort()) !== canonical([...Object.keys(manifest.files), 'release.json'].sort())) fail('Bundle file set is incomplete or mixed.');
  return manifest;
}
// `claude-code` is the spelling the Skills CLI channel uses; it names the same Claude Code destination.
const AGENT_DIRS = new Map([['codex', '.agents'], ['claude', '.claude'], ['claude-code', '.claude']]);
export function installLocation({ cwd, home, agent, global = false }) {
  const dir = AGENT_DIRS.get(agent);
  if (!dir) fail('Choose --agent codex or --agent claude (--agent claude-code is accepted too).');
  return join(resolve(global ? home : cwd), dir, 'skills', PRODUCT);
}
function layout(destination) { return { store: join(dirname(destination), `.${PRODUCT}-owned`), destination: resolve(destination) }; }
function active(destination) {
  const { store } = layout(destination); safePath(dirname(destination), true); safePath(store, true);
  const info = stat(destination);
  if (!info) return null;
  if (!info.isSymbolicLink()) return { manager: 'external' };
  const link = readlinkSync(destination); const target = resolve(dirname(destination), link); const rel = relative(store, target).split(sep).join('/');
  if (!/^versions\/[a-f0-9-]{36}\/bundle$/.test(rel)) return { manager: 'external' };
  safePath(target); const container = dirname(target); const receipt = json(join(container, 'receipt.json'));
  if (receipt.schema !== 1 || receipt.manager !== 'owned' || receipt.channel !== 'own-installer' || receipt.location !== resolve(destination) || receipt.source !== REPOSITORY || typeof receipt.autoUpdate !== 'boolean' || !(receipt.pin === null || isRef(receipt.pin)) || !(receipt.previous === null || /^[a-f0-9-]{36}$/.test(receipt.previous))) fail('Owned installation metadata is inconsistent.');
  const manifest = verifyBundle(target);
  if (receipt.version !== manifest.version || receipt.digest !== manifest.bundleDigest || receipt.ref !== manifest.source.ref) fail('Installed release and ownership metadata disagree.');
  return { manager: 'owned', target, container, id: rel.split('/')[1], receipt, manifest };
}
export function ownedLocationForBundle(bundle) {
  bundle = realpathSync(bundle);
  const path = join(dirname(resolve(bundle)), 'receipt.json');
  if (!stat(path)) return null;
  const receipt = json(path);
  if (typeof receipt.location !== 'string' || !isAbsolute(receipt.location)) fail('Invalid owned installation location.');
  const current = active(receipt.location);
  if (current?.manager !== 'owned' || current.target !== resolve(bundle)) fail('This is not the active owned release; use its current skill path.');
  return receipt.location;
}
export function statusForBundle(bundleRoot) {
  const location = ownedLocationForBundle(bundleRoot);
  return location ? installationStatus(location) : { manager: 'external', location: resolve(bundleRoot), updateCommand: managerAdvice(bundleRoot), autoUpdate: false, pin: null };
}
export function managerAdvice(destination, global = false) {
  const normalized = destination.split(sep).join('/');
  if (/\/(?:plugins|\.codex\/plugins)\//.test(normalized)) return 'Use the plugin manager to update this installation.';
  return `This copy is externally managed. For Skills CLI use: npx skills update ${PRODUCT} ${global ? '-g' : '-p'}. For a plugin use its manager; for a manual copy replace the complete verified bundle yourself.`;
}
export function installationStatus(destination, { global = false, candidates = [] } = {}) {
  const value = active(destination);
  return { installed: Boolean(value), manager: value?.manager ?? null, location: resolve(destination), ...(value?.manager === 'owned' ? { version: value.manifest.version, ref: value.receipt.ref, pin: value.receipt.pin, source: value.receipt.source, autoUpdate: value.receipt.autoUpdate, previous: value.receipt.previous !== null } : { updateCommand: managerAdvice(destination, global) }), duplicates: [...new Set(candidates.map((path) => resolve(path)))].filter((path) => path !== resolve(destination) && stat(path)).map((location) => ({ location, action: 'left unchanged' })) };
}
function removeEmptyLock(lock) {
  try { rmdirSync(lock); return true; } catch (error) {
    // A later owner may have replaced the empty directory with its complete lock.
    if (['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) return false;
    throw error;
  }
}
function releaseLock(lock, ownerFile) {
  // The unique filename is the generation identity. Never delete a pathname's new owner.
  try { unlinkSync(join(lock, ownerFile)); } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  removeEmptyLock(lock); return true;
}
function locked(destination, action) {
  const { store } = layout(destination); mkdirSafe(store); const lock = join(store, '.lock');
  const ownerFile = `owner-${randomUUID()}.json`;
  // Publish a complete owner record atomically. A crash before rename only leaves an ignored candidate.
  const candidate = join(store, `.lock-candidate-${randomUUID()}`); mkdirSync(candidate, { mode: 0o700 });
  try {
    writeFileSync(join(candidate, ownerFile), JSON.stringify({ pid: process.pid }), { flag: 'wx', mode: 0o600 });
    // POSIX rename cannot replace a nonempty live lock, but can replace an empty cleanup remainder.
    try { renameSync(candidate, lock); } catch { fail('Installation is locked. Another update may be running; use recover-lock only after it has stopped.'); }
  } finally { if (stat(candidate)) rmSync(candidate, { recursive: true, force: true }); }
  return Promise.resolve().then(action).finally(() => releaseLock(lock, ownerFile));
}
export function recoverLock(destination, { isRunning = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; } } } = {}) {
  const { store } = layout(destination); safePath(store); const lock = join(store, '.lock'); safePath(lock);
  const entries = readdirSync(lock);
  if (entries.length === 0) {
    if (!removeEmptyLock(lock)) fail('Lock changed during recovery; retry after the current owner has stopped.');
    return { recovered: true, installation: installationStatus(destination) };
  }
  // Fixed-name/unknown records cannot be deleted safely after another recovery replaces the lock.
  if (entries.length !== 1 || !/^owner-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.json$/.test(entries[0])) fail('Lock metadata is incompatible; nothing changed.');
  const ownerFile = entries[0]; const owner = json(join(lock, ownerFile));
  if (!Number.isSafeInteger(owner.pid) || owner.pid < 1 || isRunning(owner.pid)) fail('Lock owner is alive or cannot be verified; nothing changed.');
  if (!releaseLock(lock, ownerFile)) fail('Lock changed during recovery; retry after the current owner has stopped.');
  return { recovered: true, installation: installationStatus(destination) };
}
export async function defaultSmoke(bundle, manifest) {
  const scratch = join(dirname(bundle), 'smoke'); mkdirSafe(scratch);
  const guard = join(scratch, 'offline.cjs');
  writeFileSync(guard, `const deny=()=>{throw new Error('Offline smoke forbids network and subprocesses')};for(const [m,names]of [['node:http',['request','get']],['node:https',['request','get']],['node:net',['connect','createConnection']],['node:tls',['connect']],['node:child_process',['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork']]])for(const n of names)require(m)[n]=deny;globalThis.fetch=deny;require('node:module').syncBuiltinESMExports();`);
  try {
    for (const args of [['help'], ['menu', '--json']]) {
      const result = spawnSync(process.execPath, ['--require', guard, join(bundle, 'scripts', `${PRODUCT}.mjs`), ...args], { cwd: scratch, env: { HOME: scratch, USERPROFILE: scratch, XDG_CONFIG_HOME: scratch, NO_COLOR: '1' }, encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024, windowsHide: true });
      if (result.status !== 0 || result.error) fail('The new release failed its offline smoke check; the active installation was not changed.');
    }
  } finally { rmSync(scratch, { recursive: true, force: true }); }
  return manifest;
}
async function fetchBytes(url, maximum, fetcher) {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetcher(url, { method: 'GET', redirect: 'error', signal: controller.signal, headers: { accept: 'application/octet-stream' } });
    if (response.status !== 200 || !response.body) fail('Public release download failed.');
    const chunks = []; let size = 0;
    for await (const chunk of response.body) { size += chunk.length; if (size > maximum) { controller.abort(); fail('Public release exceeds its size limit.'); } chunks.push(Buffer.from(chunk)); }
    return Buffer.concat(chunks);
  } catch { fail('Public release download failed, timed out, or exceeded its size limit.'); } finally { clearTimeout(timer); }
}
async function materialize(bundle, { source, ref, fetcher }) {
  let manifest;
  if (source) {
    manifest = verifyBundle(resolve(source));
    if (ref !== undefined && manifest.source.ref !== ref) fail('The selected bundle does not match the requested ref.');
    mkdirSafe(bundle);
    for (const path of [...Object.keys(manifest.files), 'release.json']) { const to = join(bundle, path); mkdirSafe(dirname(to)); writeFileSync(to, readSafe(join(resolve(source), path)), { flag: 'wx', mode: 0o600 }); }
  } else {
    if (!isRef(ref)) fail('Select an immutable v-prefixed public version tag with --ref.');
    const base = `https://raw.githubusercontent.com/mikehasa/golive-skill/${encodeURIComponent(ref)}/skills/${PRODUCT}/`;
    const bytes = await fetchBytes(base + 'release.json', MANIFEST_LIMIT, fetcher);
    try { manifest = validateManifest(JSON.parse(bytes.toString('utf8'))); } catch { fail('Downloaded release metadata is invalid.'); }
    if (manifest.source.ref !== ref) fail('Downloaded release does not match the selected public ref.');
    mkdirSafe(bundle); writeFileSync(join(bundle, 'release.json'), bytes, { flag: 'wx', mode: 0o600 }); let total = bytes.length;
    for (const path of Object.keys(manifest.files)) { const data = await fetchBytes(base + path, MAX_FILE, fetcher); total += data.length; if (total > MAX_TOTAL) fail('Release exceeds its total size limit.'); const to = join(bundle, path); mkdirSafe(dirname(to)); writeFileSync(to, data, { flag: 'wx', mode: 0o600 }); }
  }
  return verifyBundle(bundle);
}
function switchTo(destination, id, hook, expectedId = null) {
  const { store } = layout(destination); const temporary = join(dirname(destination), `.${PRODUCT}-pointer-${randomUUID()}`);
  const target = join(store, 'versions', id, 'bundle'); safePath(target);
  symlinkSync(relative(dirname(destination), target), temporary, 'dir');
  try {
    hook?.('before-switch');
    const observed = active(destination);
    if (expectedId ? observed?.manager !== 'owned' || observed.id !== expectedId : observed !== null) fail('Installation changed while the update was staging; nothing was replaced.');
    renameSync(temporary, destination);
  } finally { if (stat(temporary)) rmSync(temporary); }
}
export async function changeInstallation({ destination, source, ref, install = false, pin = false, auto = false, betweenRuns = false, fetcher = globalThis.fetch, smoke = defaultSmoke, hook }) {
  safePath(dirname(destination), true);
  if (install && stat(destination)) fail('Skill destination already exists; no files changed.');
  if (!install) { const current = active(destination); if (current?.manager !== 'owned') fail(managerAdvice(destination)); }
  return locked(destination, async () => {
    const current = active(destination);
    if (install && current) fail('Skill destination already exists; no files changed.');
    if (!install && current?.manager !== 'owned') fail(managerAdvice(destination));
    if (auto && (!betweenRuns || !current?.receipt.autoUpdate)) return { changed: false, reason: 'Automatic replacement is disabled or this is not a run boundary.' };
    if (current?.receipt.pin && (auto || ref === undefined)) return { changed: false, reason: 'Pinned installation; select --ref explicitly to change it.' };
    const { store } = layout(destination); const id = randomUUID(); const container = join(store, 'versions', id); const bundle = join(container, 'bundle');
    let switched = false;
    try {
      const manifest = await materialize(bundle, { source, ref, fetcher }); hook?.('staged');
      if (current && manifest.bundleDigest === current.manifest.bundleDigest) return { changed: false, reason: 'Already at the selected release.' };
      if (current && manifest.version === current.manifest.version) fail('The same immutable release version has different bytes; choose a new release version.');
      if (auto && !newer(manifest.version, current.manifest.version)) return { changed: false, reason: 'Automatic updates never downgrade the installed release.' };
      await smoke(bundle, manifest); verifyBundle(bundle); hook?.('smoked');
      if (pin && !manifest.source.ref) fail('A pinned installation requires a published ref.');
      const receipt = { schema: 1, manager: 'owned', channel: 'own-installer', source: REPOSITORY, version: manifest.version, ref: manifest.source.ref, digest: manifest.bundleDigest, location: resolve(destination), pin: pin || current?.receipt.pin ? manifest.source.ref : null, autoUpdate: current?.receipt.autoUpdate ?? false, previous: current?.id ?? null };
      writeFileSync(join(container, 'receipt.json'), JSON.stringify(receipt) + '\n', { flag: 'wx', mode: 0o600 });
      switchTo(destination, id, hook, current?.id ?? null); switched = true;
      return { changed: true, ...installationStatus(destination) };
    } finally { if (!switched && stat(container)) rmSync(container, { recursive: true, force: true }); }
  });
}
export async function rollbackInstallation(destination, { smoke = defaultSmoke, hook } = {}) {
  if (active(destination)?.manager !== 'owned') fail(managerAdvice(destination));
  return locked(destination, async () => {
    const current = active(destination); if (current?.manager !== 'owned' || !current.receipt.previous) fail('No verified previous owned version is available.');
    const { store } = layout(destination); const previous = join(store, 'versions', current.receipt.previous, 'bundle'); const manifest = verifyBundle(previous); const receipt = json(join(dirname(previous), 'receipt.json'));
    if (receipt.schema !== 1 || receipt.manager !== 'owned' || receipt.channel !== 'own-installer' || receipt.location !== resolve(destination) || receipt.source !== REPOSITORY || receipt.version !== manifest.version || receipt.digest !== manifest.bundleDigest || receipt.ref !== manifest.source.ref || typeof receipt.autoUpdate !== 'boolean' || !(receipt.pin === null || isRef(receipt.pin)) || !(receipt.previous === null || /^[a-f0-9-]{36}$/.test(receipt.previous))) fail('Previous release ownership is inconsistent.');
    const id = randomUUID(); const container = join(store, 'versions', id); const bundle = join(container, 'bundle'); let switched = false;
    try {
      await materialize(bundle, { source: previous }); await smoke(bundle, manifest); verifyBundle(bundle);
      // Keep today's update opt-in and pinned status; old release receipts cannot re-enable updates.
      const next = { ...receipt, autoUpdate: current.receipt.autoUpdate, pin: current.receipt.pin ? manifest.source.ref : null, previous: current.id };
      if (current.receipt.pin && !next.pin) fail('The previous release lacks the public ref required by this pinned installation.');
      writeFileSync(join(container, 'receipt.json'), JSON.stringify(next) + '\n', { flag: 'wx', mode: 0o600 });
      switchTo(destination, id, hook, current.id); switched = true; return { changed: true, ...installationStatus(destination) };
    } finally { if (!switched && stat(container)) rmSync(container, { recursive: true, force: true }); }
  });
}
export async function setUpdatePolicy(destination, enabled) {
  if (active(destination)?.manager !== 'owned') fail(managerAdvice(destination));
  return locked(destination, async () => {
    const current = active(destination); const path = join(current.container, 'receipt.json'); const tmp = join(current.container, `receipt-${randomUUID()}.tmp`);
    writeFileSync(tmp, JSON.stringify({ ...current.receipt, autoUpdate: enabled }) + '\n', { flag: 'wx', mode: 0o600 }); renameSync(tmp, path); return installationStatus(destination);
  });
}
