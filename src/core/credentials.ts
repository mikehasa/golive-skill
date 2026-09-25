import { randomBytes } from 'node:crypto';
import { closeSync, constants, existsSync, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, unlinkSync, writeFileSync, type Stats } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

/**
 * Where a human puts tokens for golive.
 *
 * golive runs inside the AGENT's shell, so a token the human `export`s in their own terminal never
 * reaches it. Instead the human enters a token in the native prompt or their own editor (never chat).
 * golive reads it in-process (values become Secrets immediately) and never prints it. It lives in the
 * user's home directory, outside any repo, so it can't be committed by accident.
 */
export function credentialsPath(): string {
  return process.env.GOLIVE_CREDENTIALS || join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'golive', 'credentials');
}

/** Prepare an empty private file without reading or writing any credential bytes. */
export function setupCredentials(path = credentialsPath()): { path: string; exists: true; created: boolean; private: boolean | null } {
  const target = resolve(path);
  ensureDirectory(dirname(target));
  let fd: number;
  let created = false;
  try {
    fd = openSync(target, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    created = true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    const before = lstatSync(target);
    if (!before.isFile() || before.isSymbolicLink()) throw new Error('Credentials setup refuses a symlink or non-regular file; choose a regular file in your own config directory.');
    // Read-only access permits metadata inspection of an owner-read-only file. Never read its bytes.
    fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const opened = fstatSync(fd);
    if (opened.dev !== before.dev || opened.ino !== before.ino) {
      closeSync(fd);
      throw new Error('The credentials file changed during setup; nothing was written. Try again.');
    }
  }
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1) throw new Error('Credentials setup requires a regular file with no hard links; nothing was written.');
    // On an existing file this changes metadata only: no truncation, parser, cache, or content I/O.
    if (process.platform !== 'win32') fchmodSync(fd, 0o600);
    const after = fstatSync(fd);
    const current = lstatSync(target);
    if (current.isSymbolicLink() || current.dev !== after.dev || current.ino !== after.ino) throw new Error('The credentials path changed during setup; retry after checking the path.');
    return { path: target, exists: true, created, private: process.platform === 'win32' ? null : (after.mode & 0o777) === 0o600 };
  } finally { closeSync(fd); }
}

/** Refuse symlinked parents as well as a symlinked file; do not chmod existing shared directories. */
function ensureDirectory(path: string): void {
  let info;
  try { info = lstatSync(path); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    ensureDirectory(dirname(path));
    try { mkdirSync(path, { mode: 0o700 }); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
    info = lstatSync(path);
  }
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('Credentials setup refuses a symlink or non-directory parent; choose a regular config directory.');
  const parent = dirname(path);
  if (parent !== path) ensureDirectory(parent);
}

let cache: { path: string; values: Map<string, string> } | undefined;

/** dotenv-style: NAME=value, optional quotes, # comments. Returns values keyed by name. */
export function parseCredentials(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2]!.trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (v) out.set(m[1]!, v);
  }
  return out;
}

export function readCredential(name: string): string | undefined {
  const path = credentialsPath();
  if (!cache || cache.path !== path) {
    cache = { path, values: existsSync(path) ? parseCredentials(readFileSync(path, 'utf8')) : new Map() };
  }
  return cache.values.get(name);
}

/** For doctor: where the file is, whether it's private, and which NAMES it defines (never values). */
export function credentialsStatus(): { path: string; exists: boolean; private: boolean | null; names: string[]; fix?: string } {
  const path = credentialsPath();
  if (!existsSync(path)) return { path, exists: false, private: null, names: [] };
  const mode = statSync(path).mode & 0o777;
  const priv = process.platform === 'win32' ? true : (mode & 0o077) === 0;
  const names = [...parseCredentials(readFileSync(path, 'utf8')).keys()].sort();
  return { path, exists: true, private: priv, names, ...(priv ? {} : { fix: `run \`chmod 600 ${path}\` in your terminal — the file is readable by other users` }) };
}

/** A credential name is a variable name: the only shape `parseCredentials` reads, and the only thing removal accepts. */
export function isCredentialName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name);
}

const MAX_CREDENTIAL_BYTES = 1024 * 1024;
const UNSAFE_TARGET = 'Credentials removal refuses a symlinked, non-regular or hard-linked file; nothing was removed. Edit the file in your own editor instead.';
const CHANGED_TARGET = 'The credentials file changed during removal; nothing was removed. Retry once the other writer has finished.';

/**
 * The human's way back out: delete one stored credential and leave every other entry alone.
 *
 * The CLI requires an explicit `--yes` first, because deleting a stored token is irreversible for a
 * human who no longer holds it anywhere else. This uses the same path resolution, symlink/hard-link
 * hardening and 0600 handling as the rest of the module, and replaces the file through a staging
 * file in the same directory: a failure at any point leaves the stored bytes intact. Only the
 * assignments naming this credential are dropped — comments, spacing, quoting, line endings and
 * every other entry survive. The file is read in-process to do that, and the value never reaches
 * the result, an error, a log or the caller.
 */
export function removeCredential(name: string, path = credentialsPath()): { name: string; path: string; removed: boolean } {
  if (!isCredentialName(name)) throw new Error('A credential name uses letters, digits and underscores only; removal never accepts a value.');
  const target = resolve(path);
  let before: Stats;
  try { before = lstatSync(target); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    cache = undefined; // Nothing stored here: report that rather than creating a file or directory.
    return { name, path: target, removed: false };
  }
  if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1) throw new Error(UNSAFE_TARGET);
  ensureDirectory(dirname(target)); // Validates every ancestor; the file exists, so this creates nothing.

  const { stats, text } = readStored(target, before);
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const kept = lines.filter((line) => assignedName(line) !== name);
  if (kept.length === lines.length) {
    cache = undefined; // Not stored: the file is left byte-for-byte as it was, unchanged on disk.
    return { name, path: target, removed: false };
  }
  replaceAtomically(target, stats, kept.join(''));
  cache = undefined; // A reader in this process must not keep serving the removed value.
  return { name, path: target, removed: true };
}

/** Open the stored file the way this module always does, and read it without leaving the process. */
function readStored(target: string, before: Stats): { stats: Stats; text: string } {
  const fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== before.dev || opened.ino !== before.ino) throw new Error(UNSAFE_TARGET);
    return { stats: opened, text: readBounded(fd, opened.size) };
  } finally { closeSync(fd); }
}

/** Read at most MAX_CREDENTIAL_BYTES through an already-open descriptor. */
function readBounded(fd: number, size: number): string {
  if (size > MAX_CREDENTIAL_BYTES) throw new Error('The credentials file is larger than golive will rewrite; edit it in your own editor instead.');
  const chunks: Buffer[] = [];
  const buffer = Buffer.alloc(64 * 1024);
  let total = 0;
  for (;;) {
    const got = readSync(fd, buffer, 0, buffer.length, null);
    if (!got) return Buffer.concat(chunks).toString('utf8');
    total += got;
    if (total > MAX_CREDENTIAL_BYTES) throw new Error('The credentials file is larger than golive will rewrite; edit it in your own editor instead.');
    chunks.push(Buffer.from(buffer.subarray(0, got)));
  }
}

/** The variable a line assigns: the same shape `parseCredentials` reads, so comments stay comments. */
function assignedName(line: string): string | undefined {
  return line.trim().match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/)?.[1];
}

/** Same-directory 0600 staging file, then a rename: a half-written file would destroy other credentials. */
function replaceAtomically(target: string, opened: Stats, content: string): void {
  const tempPath = join(dirname(target), `.${basename(target)}-${randomBytes(12).toString('hex')}.tmp`);
  const temp = openSync(tempPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  let info: Stats | undefined;
  let committed = false;
  let failure: unknown;
  try {
    fchmodSync(temp, 0o600);
    info = fstatSync(temp);
    if (!info.isFile() || info.nlink !== 1) throw new Error(UNSAFE_TARGET);
    writeFileSync(temp, content, { encoding: 'utf8' });
    fsyncSync(temp);
    const current = lstatSync(target);
    // A concurrent editor — or a native prompt save — must not lose its bytes to this replacement.
    if (current.isSymbolicLink() || !current.isFile() || current.dev !== opened.dev || current.ino !== opened.ino
      || current.size !== opened.size || current.mtimeMs !== opened.mtimeMs) throw new Error(CHANGED_TARGET);
    renameSync(tempPath, target);
    committed = true;
  } catch (error) {
    failure = error;
  } finally {
    try { closeSync(temp); } catch { /* An unclosed descriptor is not a reason to report a failed removal. */ }
    if (!committed && info) removeStaged(tempPath, info);
  }
  if (failure) throw failure;
}

/** Never unlink a path that is no longer the staging file this call created; never report cleanup detail. */
function removeStaged(path: string, info: Stats): void {
  try {
    const current = lstatSync(path);
    if (!current.isFile() || current.dev !== info.dev || current.ino !== info.ino) return;
    unlinkSync(path);
  } catch { /* leave an already-removed or replaced path alone */ }
}

/**
 * Standard, safe instructions for getting a token to golive. Adapters append provider-specific
 * "where to create it / which scopes" text in front of this.
 */
export function tokenHowTo(name: string): string {
  const p = credentialsPath();
  return `On macOS, have the agent run \`credentials --prompt ${name} --json\`: enter the API key/provider token in the native hidden-input dialog, never your Mac login password. The local process saves it to ${p}; the value is not returned to agent chat or command output. Existing entries require an intentional --replace; cancelling preserves them. To take that value back later, run \`credentials --remove ${name} --yes\`: it deletes that one entry and reports metadata only. If the dialog is unavailable or on another platform, have the agent run \`credentials --setup --json\` to prepare the private directory/file, then open ${p} in your own editor and add \`${name}=<value>\`. In nano: Ctrl+O, then Enter to confirm the filename, then Ctrl+X. Never paste the value into this chat or put it in the repo. (Alternative: export ${name} in the shell you launch your coding agent from, then restart the agent.)`;
}

export function _resetCredentialsCache(): void {
  cache = undefined;
}
