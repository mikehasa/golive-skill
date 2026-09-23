import { closeSync, constants, existsSync, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

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

/**
 * Standard, safe instructions for getting a token to golive. Adapters append provider-specific
 * "where to create it / which scopes" text in front of this.
 */
export function tokenHowTo(name: string): string {
  const p = credentialsPath();
  return `On macOS, have the agent run \`credentials --prompt ${name} --json\`: enter the API key/provider token in the native hidden-input dialog, never your Mac login password. The local process saves it to ${p}; the value is not returned to agent chat or command output. Existing entries require an intentional --replace; cancelling preserves them. If the dialog is unavailable or on another platform, have the agent run \`credentials --setup --json\` to prepare the private directory/file, then open ${p} in your own editor and add \`${name}=<value>\`. In nano: Ctrl+O, then Enter to confirm the filename, then Ctrl+X. Never paste the value into this chat or put it in the repo. (Alternative: export ${name} in the shell you launch your coding agent from, then restart the agent.)`;
}

export function _resetCredentialsCache(): void {
  cache = undefined;
}
