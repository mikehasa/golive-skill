import { execFile, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  closeSync, constants, fchmodSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync,
  openSync, readSync, renameSync, unlinkSync, writeFileSync, type Stats,
} from 'node:fs';
import { platform } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { _resetCredentialsCache, credentialsPath, parseCredentials } from './credentials.js';
import { Secret } from './secret.js';

type UnavailableReason = 'already-exists' | 'unsupported-platform' | 'unsafe-path' | 'concurrent-change'
  | 'invalid-value' | 'dialog-unavailable' | 'timeout' | 'write-failed';

/** No secret, fingerprint, last characters, child output or error object may appear here. */
export interface CredentialPromptResult {
  status: 'saved' | 'cancelled' | 'unavailable';
  name: string;
  path: string;
  envOverride: boolean;
  replaced?: boolean;
  private?: true;
  cleanupRequired?: true;
  reason?: UnavailableReason;
}

const MAX_VALUE_BYTES = 16 * 1024;
const MAX_FILE_BYTES = 1024 * 1024;
const DIALOG_SECONDS = 180;

class SafeFailure extends Error {
  constructor(readonly reason: UnavailableReason, readonly cleanupRequired = false) { super('The credential could not be saved safely.'); }
}

interface Snapshot {
  directories: Map<string, Stats>;
  file?: Stats;
  content: Secret | null;
}

/**
 * macOS hidden native input. All child output stays inside this process. Saving a credential does
 * not authenticate it with its provider; a later doctor check must establish that separately.
 */
export async function promptCredential(
  name: string,
  options: { replace?: boolean; language?: 'en' | 'zh' } = {},
): Promise<CredentialPromptResult> {
  if (!/^[A-Z_][A-Z0-9_]{0,127}$/.test(name)) throw new Error('Use a credential variable name containing uppercase letters, digits and underscores.');
  if (options.language !== undefined && options.language !== 'en' && options.language !== 'zh') throw new Error('Credential prompt language must be en or zh.');
  if (options.replace !== undefined && typeof options.replace !== 'boolean') throw new Error('Credential replacement must be explicitly enabled.');
  const path = resolve(credentialsPath());
  const base = { name, path, envOverride: Boolean(process.env[name]) };
  const unavailable = (reason: UnavailableReason): CredentialPromptResult => ({ ...base, status: 'unavailable', reason });
  if (platform() !== 'darwin') return unavailable('unsupported-platform');

  let before: Snapshot;
  try { before = snapshot(path); }
  catch (error) { return unavailable(error instanceof SafeFailure ? error.reason : 'unsafe-path'); }
  const replaced = hasAssignment(before.content, name);
  if (replaced && options.replace !== true) return unavailable('already-exists');

  const answer = await nativeAnswer(name, path, options.language ?? 'en');
  if (answer.status === 'cancelled') return { ...base, status: 'cancelled' };
  if (answer.status === 'unavailable') return unavailable(answer.reason);
  const value = answer.value;
  if (!validValue(name, value)) return unavailable('invalid-value');

  try {
    const cleanupRequired = saveAtomically(path, before, name, value);
    _resetCredentialsCache();
    return { ...base, status: 'saved', replaced, private: true, ...(cleanupRequired ? { cleanupRequired: true as const } : {}) };
  } catch (error) {
    // Filesystem and child errors can carry arbitrary bytes. Never return their text or cause.
    return {
      ...unavailable(error instanceof SafeFailure ? error.reason : 'write-failed'),
      ...(error instanceof SafeFailure && error.cleanupRequired ? { cleanupRequired: true as const } : {}),
    };
  }
}

type Answer = { status: 'saved'; value: Secret } | { status: 'cancelled' }
  | { status: 'unavailable'; reason: 'dialog-unavailable' | 'timeout' | 'invalid-value' };

function appleString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r/g, '\\r').replace(/\n/g, '\\n')}"`;
}

function nativeAnswer(name: string, path: string, language: 'en' | 'zh'): Promise<Answer> {
  const zh = language === 'zh';
  const message = zh
    ? `请输入 ${name} 对应的服务商 API key / access token。\n不是 Mac 登录密码，请不要输入电脑密码。\n\n将以明文保存到本机私有文件（权限 0600）：\n${path}\n\n输入值不会返回给 agent 聊天或命令输出。保存后仍需验证服务商权限。`
    : `Enter the provider API key / access token for ${name}.\nThis is NOT your Mac login password. Do not enter your computer password.\n\nSaved as plaintext in this local private file (mode 0600):\n${path}\n\nThe value is not returned to agent chat or command output. Provider access still needs verification after saving.`;
  const title = zh ? 'GoLive — 服务商 API key / token' : 'GoLive — provider API key / token';
  const buttons = zh ? ['取消', '保存'] : ['Cancel', 'Save'];
  const script = `set answer to display dialog ${appleString(message)} default answer "" with hidden answer buttons {${buttons.map(appleString).join(', ')}} default button 2 cancel button 1 with title ${appleString(title)} giving up after ${DIALOG_SECONDS}\nif gave up of answer then error number -1712\nreturn text returned of answer\n`;

  return new Promise((done) => {
    try {
      // Do not use the general command runner: osascript returns the secret on stdout. This
      // dedicated pipe captures it privately, with no inherited stdout/stderr and no secret argv.
      const child = execFile('/usr/bin/osascript', [], {
        encoding: 'utf8', timeout: (DIALOG_SECONDS + 5) * 1000, killSignal: 'SIGKILL',
        maxBuffer: MAX_VALUE_BYTES + 1024, windowsHide: true,
      }, (error, stdout, stderr) => {
        const captured = stdout ? new Secret(name, stdout) : null;
        if (error) {
          if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return done({ status: 'unavailable', reason: 'invalid-value' });
          if (error.killed || /\(-1712\)/.test(stderr)) return done({ status: 'unavailable', reason: 'timeout' });
          if (/\(-128\)/.test(stderr)) return done({ status: 'cancelled' });
          return done({ status: 'unavailable', reason: 'dialog-unavailable' });
        }
        // Remove only osascript's one transport newline; never silently trim the user's token.
        const raw = captured?.reveal().replace(/\n$/, '') ?? '';
        if (!raw.trim()) return done({ status: 'cancelled' });
        done({ status: 'saved', value: new Secret(name, raw) });
      });
      child.stdin?.on('error', () => { /* EPIPE is handled by the child callback; never print it. */ });
      if (!child.stdin) {
        child.kill('SIGKILL');
        done({ status: 'unavailable', reason: 'dialog-unavailable' });
      } else child.stdin.end(script);
    } catch {
      done({ status: 'unavailable', reason: 'dialog-unavailable' });
    }
  });
}

function validValue(name: string, value: Secret): boolean {
  const raw = value.reveal();
  if (Buffer.byteLength(raw, 'utf8') > MAX_VALUE_BYTES || /[\u0000-\u001f\u007f\u2028\u2029]/.test(raw)) return false;
  // The credentials parser strips only enclosing quotes; it does not interpret shell escapes.
  // Always quote the value so literal quotes, backslashes, '#', '=', and surrounding spaces survive.
  return parseCredentials(`${name}="${raw}"`).get(name) === raw;
}

function uid(): number {
  const value = process.geteuid?.();
  if (value === undefined) throw new SafeFailure('unsafe-path');
  return value;
}

function statOrMissing(path: string): Stats | undefined {
  try { return lstatSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/** macOS ACL grants can override mode 0600. Permit understood deny-only ACLs, never grants. */
function checkAcl(path: string): void {
  let output: string;
  try {
    // Metadata only; -b escapes embedded filename controls. Never inherit or surface child output
    // or exceptions, and never modify ACLs on the user's existing directories or files.
    output = execFileSync('/bin/ls', ['-blde', path], {
      encoding: 'utf8', timeout: 2500, maxBuffer: 64 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch { throw new SafeFailure('unsafe-path'); }
  const lines = output.trimEnd().split('\n');
  if (!/^[bcdlps-][rwxStTs-]{9}[@+ ]/.test(lines[0] ?? '')) throw new SafeFailure('unsafe-path');
  const acl = lines.slice(1).filter((line) => line.trim());
  if (lines[0]?.[10] === '+' && acl.length === 0) throw new SafeFailure('unsafe-path');
  for (const entry of acl) {
    const parsed = entry.match(/^\s*\d+:\s+.+\s+(allow|deny)\s+\S.*$/);
    if (!parsed || parsed[1] !== 'deny') throw new SafeFailure('unsafe-path');
  }
}

/** Root-owned ancestors are normal; the credential directory and file must belong to this user. */
function directories(path: string, create: boolean): Map<string, Stats> {
  const owner = uid();
  const paths: string[] = [];
  for (let current = dirname(path); ; current = dirname(current)) {
    paths.unshift(current);
    if (dirname(current) === current) break;
  }
  const out = new Map<string, Stats>();
  for (const current of paths) {
    let info = statOrMissing(current);
    if (!info && create) {
      try { mkdirSync(current, { mode: 0o700 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      info = lstatSync(current);
    }
    if (!info) break;
    if (info.isSymbolicLink() || !info.isDirectory() || (info.uid !== owner && info.uid !== 0)) throw new SafeFailure('unsafe-path');
    // A root-owned sticky temp ancestor is safe when the eventual credential directory is owned
    // by this user. Do not chmod shared ancestors or reject normal 0755 ~/.config directories.
    const sharedSticky = info.uid === 0 && (info.mode & 0o1000) !== 0;
    if ((info.mode & 0o022) !== 0 && !sharedSticky) throw new SafeFailure('unsafe-path');
    if (current === dirname(path) && info.uid !== owner) throw new SafeFailure('unsafe-path');
    checkAcl(current);
    out.set(current, info);
  }
  return out;
}

function sameFile(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.uid === b.uid && a.nlink === b.nlink
    && a.mode === b.mode && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}

function safeFile(info: Stats): void {
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.uid !== uid()
    || (info.mode & 0o077) !== 0 || info.size > MAX_FILE_BYTES) throw new SafeFailure('unsafe-path');
}

function snapshot(path: string): Snapshot {
  const parents = directories(path, false);
  const before = statOrMissing(path);
  if (!before) return { directories: parents, content: null };
  safeFile(before);
  checkAcl(path);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = fstatSync(fd);
    safeFile(opened);
    if (!sameFile(before, opened)) throw new SafeFailure('concurrent-change');
    const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
    let size = 0;
    for (;;) {
      const got = readSync(fd, buffer, size, buffer.length - size, null);
      size += got;
      if (size > MAX_FILE_BYTES) throw new SafeFailure('unsafe-path');
      if (!got) break;
    }
    const bytes = buffer.subarray(0, size);
    const text = bytes.toString('utf8');
    const content = text ? new Secret('credential-file', text) : null;
    if (!Buffer.from(text, 'utf8').equals(bytes)) throw new SafeFailure('unsafe-path');
    const after = fstatSync(fd);
    const current = lstatSync(path);
    if (!sameFile(opened, after) || !sameFile(after, current)) throw new SafeFailure('concurrent-change');
    return { directories: parents, file: after, content };
  } finally { closeSync(fd); }
}

function raw(snapshot: Snapshot): string { return snapshot.content?.reveal() ?? ''; }

function assignment(line: string): string | undefined {
  return line.trim().match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/)?.[1];
}

function hasAssignment(content: Secret | null, name: string): boolean {
  return (content?.reveal() ?? '').split(/\r?\n/).some((line) => assignment(line) === name);
}

function changed(before: Snapshot, now: Snapshot): boolean {
  for (const [path, old] of before.directories) {
    const current = now.directories.get(path);
    if (!current || current.dev !== old.dev || current.ino !== old.ino || current.uid !== old.uid || current.mode !== old.mode) return true;
  }
  return Boolean(before.file) !== Boolean(now.file)
    || Boolean(before.file && now.file && !sameFile(before.file, now.file)) || raw(before) !== raw(now);
}

function updated(before: Snapshot, name: string, value: Secret): Secret {
  const source = raw(before);
  const eol = source.match(/\r\n|\n/)?.[0] ?? '\n';
  const replacement = `${name}="${value.reveal()}"`;
  let found = false;
  const lines = source.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  let content = lines.map((line) => {
    if (assignment(line) !== name) return line;
    if (found) return ''; // Replace all duplicate target definitions with one unambiguous value.
    found = true;
    return replacement + (line.endsWith('\r\n') ? '\r\n' : line.endsWith('\n') ? '\n' : '');
  }).join('');
  if (!found) content += (content && !content.endsWith('\n') ? eol : '') + replacement + eol;
  if (Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) throw new SafeFailure('write-failed');
  return new Secret('credential-file', content);
}

function removeOwned(path: string, info: Stats | undefined): boolean {
  try {
    const current = statOrMissing(path);
    if (!current) return true;
    if (!info || !current.isFile() || current.dev !== info.dev || current.ino !== info.ino) return false;
    unlinkSync(path);
    return true;
  } catch { return false; /* Never expose cleanup details or remove an unrelated file. */ }
}

/** Returns whether an owned staging/lock file or descriptor still needs local cleanup. */
function saveAtomically(path: string, before: Snapshot, name: string, value: Secret): boolean {
  directories(path, true);
  const lockPath = `${path}.prompt.lock`;
  let lock: number;
  try { lock = openSync(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new SafeFailure('concurrent-change');
    throw error;
  }
  let lockInfo: Stats | undefined;
  let temp: { path: string; fd: number; info?: Stats } | undefined;
  let committed = false;
  let cleanupRequired = false;
  let failure: unknown;
  try {
    lockInfo = fstatSync(lock);
    const current = snapshot(path);
    if (changed(before, current)) throw new SafeFailure('concurrent-change');
    const content = updated(before, name, value);
    const tempPath = join(dirname(path), `.${basename(path)}-${randomBytes(12).toString('hex')}.tmp`);
    const fd = openSync(tempPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    temp = { path: tempPath, fd };
    temp.info = fstatSync(fd);
    fchmodSync(fd, 0o600);
    safeFile(fstatSync(fd));
    checkAcl(tempPath); // An inherited ACL must be safe before any credential bytes are written.
    writeFileSync(fd, content.reveal(), { encoding: 'utf8' });
    fsyncSync(fd);
    if (changed(before, snapshot(path))) throw new SafeFailure('concurrent-change');
    const staged = lstatSync(tempPath);
    if (staged.isSymbolicLink() || staged.dev !== temp.info.dev || staged.ino !== temp.info.ino) throw new SafeFailure('concurrent-change');
    safeFile(staged);
    checkAcl(tempPath);
    if (before.file) {
      renameSync(tempPath, path);
      committed = true;
    }
    else {
      // An absent destination must remain absent: link creates it atomically without replacing a
      // file an external editor might have created after our last snapshot.
      try { linkSync(tempPath, path); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new SafeFailure('concurrent-change');
        throw error;
      }
      committed = true;
    }
  } catch (error) {
    failure = error;
  } finally {
    if (temp) {
      try { closeSync(temp.fd); } catch { cleanupRequired = true; }
      if (!removeOwned(temp.path, temp.info)) cleanupRequired = true;
    }
    try { closeSync(lock); } catch { cleanupRequired = true; }
    if (!removeOwned(lockPath, lockInfo)) cleanupRequired = true;
  }
  // A committed value stays saved even if closing a descriptor or removing our staging link/lock
  // fails. Never imply it was not written, solicit another entry, or roll back a saved credential.
  if (committed) return cleanupRequired;
  throw new SafeFailure(failure instanceof SafeFailure ? failure.reason : 'write-failed', cleanupRequired);
}
