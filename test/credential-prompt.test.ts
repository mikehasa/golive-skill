import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  realpathSync, renameSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { promptCredential } from '../src/core/credential-prompt.js';
import { _resetCredentialsCache, parseCredentials, readCredential } from '../src/core/credentials.js';
import { _resetSecretRegistry } from '../src/core/secret.js';

const mocked = vi.hoisted(() => ({
  platform: 'darwin', stdout: '', stderr: '', error: null as (Error & { code?: string | number; killed?: boolean }) | null,
  duringDialog: undefined as (() => void) | undefined, script: '', args: [] as string[], executable: '',
  options: {} as Record<string, unknown>, failWrite: false, failRename: false, failCleanup: false, foreignFile: '',
  lateCreate: false,
  acl: undefined as ((path: string) => string) | undefined,
}));

vi.mock('node:os', async (original) => ({ ...await original<typeof import('node:os')>(), platform: () => mocked.platform }));
vi.mock('node:child_process', () => ({
  execFileSync: vi.fn((_file: string, args: string[]) => mocked.acl?.(args[1]!) ?? 'drwx------  1 fixture fixture 0 Jan 1 00:00 fixture\n'),
  execFile: vi.fn((file: string, args: string[], options: Record<string, unknown>, callback: (error: unknown, stdout: string, stderr: string) => void) => {
    mocked.executable = file; mocked.args = args; mocked.options = options;
    return {
      stdin: {
        on: vi.fn(),
        end: (script: string) => {
          mocked.script = script;
          queueMicrotask(() => {
            mocked.duringDialog?.();
            callback(mocked.error, mocked.stdout, mocked.stderr);
          });
        },
      },
      kill: vi.fn(),
    };
  }),
}));
vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>();
  return {
    ...fs,
    writeFileSync: (...args: Parameters<typeof fs.writeFileSync>) => {
      if (mocked.failWrite && typeof args[0] === 'number') throw new Error(`Synthetic filesystem failure ${mocked.stdout}`);
      return fs.writeFileSync(...args);
    },
    renameSync: (...args: Parameters<typeof fs.renameSync>) => {
      if (mocked.failRename) throw new Error(`Synthetic rename failure ${mocked.stdout}`);
      return fs.renameSync(...args);
    },
    linkSync: (...args: Parameters<typeof fs.linkSync>) => {
      if (mocked.lateCreate) fs.writeFileSync(args[1], 'KEEP=created-at-commit\n', { mode: 0o600 });
      return fs.linkSync(...args);
    },
    unlinkSync: (...args: Parameters<typeof fs.unlinkSync>) => {
      if (mocked.failCleanup) throw new Error(`Synthetic cleanup failure ${mocked.stdout}`);
      return fs.unlinkSync(...args);
    },
    lstatSync: (...args: Parameters<typeof fs.lstatSync>) => {
      const info = fs.lstatSync(...args);
      if (info && String(args[0]) === mocked.foreignFile) Object.defineProperty(info, 'uid', { value: Number(info.uid) + 10000 });
      return info;
    },
  };
});

let root: string;
let path: string;
const NAME = 'GOLIVE_PROMPT_TEST_TOKEN';
const VALUE = 'synthetic-private-provider-token';

beforeEach(() => {
  vi.clearAllMocks();
  _resetCredentialsCache(); _resetSecretRegistry();
  Object.assign(mocked, {
    platform: 'darwin', stdout: `${VALUE}\n`, stderr: '', error: null, duringDialog: undefined,
    script: '', args: [], executable: '', options: {}, failWrite: false, failRename: false, failCleanup: false,
    foreignFile: '', lateCreate: false, acl: undefined,
  });
  // macOS /tmp and /var are symlinks; the implementation intentionally rejects symlink ancestors.
  root = mkdtempSync(join(realpathSync(tmpdir()), 'golive-credential-prompt-'));
  chmodSync(root, 0o700);
  path = join(root, 'config', 'golive', 'credentials');
  vi.stubEnv('GOLIVE_CREDENTIALS', path);
  vi.stubEnv(NAME, undefined);
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Native credential tests must not use the network.'); }));
});

afterEach(() => {
  mocked.failWrite = false; mocked.failRename = false; mocked.failCleanup = false; mocked.foreignFile = '';
  rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs(); vi.unstubAllGlobals();
  _resetCredentialsCache(); _resetSecretRegistry();
});

function existing(text: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, text, { mode: 0o600 });
}

function noLeftovers(): void {
  expect(readdirSync(dirname(path)).sort()).toEqual(['credentials']);
}

describe('native credential entry', () => {
  it('privately captures hidden native input, saves 0600, and returns metadata only', async () => {
    const result = await promptCredential(NAME);
    expect(result).toEqual({ status: 'saved', name: NAME, path, envOverride: false, replaced: false, private: true });
    expect(parseCredentials(readFileSync(path, 'utf8')).get(NAME)).toBe(VALUE);
    expect(lstatSync(path).mode & 0o777).toBe(0o600);
    expect(lstatSync(path).nlink).toBe(1);
    expect(lstatSync(dirname(path)).mode & 0o777).toBe(0o700);
    expect(lstatSync(dirname(dirname(path))).mode & 0o777).toBe(0o700);
    expect(JSON.stringify(result)).not.toContain(VALUE);
    expect(result).not.toHaveProperty('fingerprint'); expect(result).not.toHaveProperty('last4');
    expect(mocked.executable).toBe('/usr/bin/osascript'); expect(mocked.args).toEqual([]);
    expect(mocked.script).toContain('with hidden answer');
    expect(mocked.script).toContain('default button 2 cancel button 1');
    expect(mocked.script).toContain('giving up after 180');
    expect(mocked.script).toContain('if gave up of answer then error number -1712');
    expect(mocked.script).toContain('API key / access token');
    expect(mocked.script).toContain('NOT your Mac login password');
    expect(mocked.script).toContain('Saved as plaintext');
    expect(mocked.script).toContain(path); expect(mocked.script).not.toContain(VALUE);
    expect(mocked.options).toMatchObject({ timeout: 185000, killSignal: 'SIGKILL', maxBuffer: 17408 });
    expect(fetch).not.toHaveBeenCalled(); noLeftovers();
  });

  it('offers a localized Chinese prompt with the same secret and storage boundaries', async () => {
    expect((await promptCredential(NAME, { language: 'zh' })).status).toBe('saved');
    expect(mocked.script).toContain('不是 Mac 登录密码');
    expect(mocked.script).toContain('明文');
    expect(mocked.script).toContain('不会返回给 agent');
    expect(mocked.script).toContain('buttons {"取消", "保存"}');
  });

  it.each([
    'literal"double\'single\\backslash#hash=equals', '  keep surrounding spaces  ',
    '中文 Unicode 🔑', '"already-quoted"', "'already-single-quoted'", '#starts-with-hash', 'a=b=c',
  ])('preserves exact single-line value through the actual parser: %j', async (value) => {
    mocked.stdout = value + '\n';
    const result = await promptCredential(NAME);
    expect(result.status).toBe('saved');
    expect(parseCredentials(readFileSync(path, 'utf8')).get(NAME)).toBe(value);
    expect(JSON.stringify(result)).not.toContain(value);
  });

  it('preserves unrelated bytes and CRLF while replacing every duplicate target definition', async () => {
    const before = `# preserve comment\r\nKEEP='keep \\ # = value'\r\nexport ${NAME} = old-one\r\n# between\r\n${NAME}=old-two\r\nOTHER = "other"`;
    existing(before);
    expect((await promptCredential(NAME, { replace: true })).replaced).toBe(true);
    const after = readFileSync(path, 'utf8');
    expect(after).toBe(`# preserve comment\r\nKEEP='keep \\ # = value'\r\n${NAME}="${VALUE}"\r\n# between\r\nOTHER = "other"`);
    const parsed = parseCredentials(after);
    expect(parsed.get('KEEP')).toBe('keep \\ # = value'); expect(parsed.get('OTHER')).toBe('other');
    expect(parsed.get(NAME)).toBe(VALUE); noLeftovers();
  });

  it('appends without losing a final unterminated comment and permits owned 0755 parent directories', async () => {
    existing('# existing comment without newline');
    chmodSync(dirname(path), 0o755); chmodSync(dirname(dirname(path)), 0o755);
    expect((await promptCredential(NAME)).status).toBe('saved');
    expect(readFileSync(path, 'utf8')).toBe(`# existing comment without newline\n${NAME}="${VALUE}"\n`);
    expect(lstatSync(dirname(path)).mode & 0o777).toBe(0o755); noLeftovers();
  });

  it.each([`${NAME}=existing\n`, `# comment\nexport ${NAME}=\n`])('requires explicit replacement even for an empty assignment', async (before) => {
    existing(before);
    expect(await promptCredential(NAME)).toMatchObject({ status: 'unavailable', reason: 'already-exists' });
    expect(execFile).not.toHaveBeenCalled(); expect(readFileSync(path, 'utf8')).toBe(before);
  });

  it('invalidates the readCredential cache and reports an explicit environment override without exposing it', async () => {
    existing(`${NAME}=old-token\n`);
    expect(readCredential(NAME)).toBe('old-token');
    vi.stubEnv(NAME, 'synthetic-environment-override-secret');
    const result = await promptCredential(NAME, { replace: true });
    expect(result).toMatchObject({ status: 'saved', envOverride: true });
    expect(readCredential(NAME)).toBe(VALUE);
    expect(process.env[NAME]).toBe('synthetic-environment-override-secret');
    expect(JSON.stringify(result)).not.toContain('synthetic-environment-override-secret');
  });

  it('does not report an empty environment variable as overriding the saved credential', async () => {
    vi.stubEnv(NAME, '');
    expect(await promptCredential(NAME)).toMatchObject({ status: 'saved', envOverride: false });
  });

  it.each(['', '\n', '   \n'])('empty/cancelled input never creates a credential file', async (output) => {
    mocked.stdout = output;
    expect((await promptCredential(NAME)).status).toBe('cancelled');
    expect(existsSync(path)).toBe(false); expect(existsSync(dirname(path))).toBe(false);
  });

  it.each([
    [{ code: 1 }, 'User canceled. (-128)', 'cancelled', undefined],
    [{ code: 1 }, 'Apple event timed out. (-1712)', 'unavailable', 'timeout'],
    [{ code: 'ETIMEDOUT', killed: true }, 'synthetic stderr', 'unavailable', 'timeout'],
    [{ code: 'ENOENT' }, 'synthetic stderr', 'unavailable', 'dialog-unavailable'],
    [{ code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', killed: true }, '', 'unavailable', 'invalid-value'],
  ] as const)('handles cancellation/timeout/unavailability without secret output or changed bytes', async (error, stderr, status, reason) => {
    const before = `OTHER=untouched\n${NAME}=old-token\n`; existing(before);
    mocked.error = Object.assign(new Error(`Never expose ${VALUE}`), error);
    mocked.stderr = stderr + VALUE;
    const result = await promptCredential(NAME, { replace: true });
    expect(result.status).toBe(status); expect(result.reason).toBe(reason);
    expect(JSON.stringify(result)).not.toContain(VALUE);
    expect(readFileSync(path, 'utf8')).toBe(before); noLeftovers();
  });

  it.each(['embedded\nNEW_KEY=injection', 'embedded\rcarriage', 'trailing-carriage\r', 'nul\0value', 'line\u2028separator', 'x'.repeat(16385)])('rejects invalid/oversized input without reflecting it or writing', async (value) => {
    const before = '# untouched\nOTHER=keep\n'; existing(before);
    mocked.stdout = value + '\n';
    const result = await promptCredential(NAME);
    expect(result).toMatchObject({ status: 'unavailable', reason: 'invalid-value' });
    expect(JSON.stringify(result)).not.toContain(value);
    expect(readFileSync(path, 'utf8')).toBe(before); noLeftovers();
  });

  it('returns unsupported-platform without launching a process', async () => {
    mocked.platform = 'linux';
    expect(await promptCredential(NAME)).toMatchObject({ status: 'unavailable', reason: 'unsupported-platform' });
    expect(execFile).not.toHaveBeenCalled(); expect(existsSync(path)).toBe(false);
  });

  it.each(['NAME=value', 'bad-name', 'name\nINJECT', '"secret"', 'a'.repeat(129)])('rejects unsafe names generically before interpolation: %j', async (name) => {
    let caught: unknown;
    try { await promptCredential(name); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(Error); expect(String(caught)).not.toContain(name);
    expect(execFile).not.toHaveBeenCalled(); expect(existsSync(path)).toBe(false);
  });
});

describe('credential file protections', () => {
  it('rejects granting ACLs on a parent even when its mode is 0755', async () => {
    existing('KEEP=unchanged\n'); chmodSync(dirname(path), 0o755);
    mocked.acl = (selected) => selected === dirname(path)
      ? 'drwxr-xr-x+ 1 fixture fixture 0 Jan 1 00:00 fixture\n 0: group:everyone allow read,search,file_inherit,directory_inherit\n'
      : 'drwxr-xr-x 1 fixture fixture 0 Jan 1 00:00 fixture\n';
    expect(await promptCredential(NAME)).toMatchObject({ status: 'unavailable', reason: 'unsafe-path' });
    expect(execFile).not.toHaveBeenCalled(); expect(readFileSync(path, 'utf8')).toBe('KEEP=unchanged\n');
  });

  it('rejects a granting file ACL even when the file mode is 0600', async () => {
    existing('KEEP=unchanged\n');
    mocked.acl = (selected) => selected === path
      ? '-rw-------+ 1 fixture fixture 0 Jan 1 00:00 fixture\n 0: group:everyone inherited allow read\n'
      : 'drwxr-xr-x 1 fixture fixture 0 Jan 1 00:00 fixture\n';
    expect(await promptCredential(NAME)).toMatchObject({ status: 'unavailable', reason: 'unsafe-path' });
    expect(execFile).not.toHaveBeenCalled(); expect(readFileSync(path, 'utf8')).toBe('KEEP=unchanged\n');
  });

  it('permits understood deny-only default macOS ACLs without changing them', async () => {
    mocked.acl = () => 'drwx------+ 1 fixture fixture 0 Jan 1 00:00 fixture\n 0: group:everyone deny delete\n';
    expect((await promptCredential(NAME)).status).toBe('saved');
    expect(execFileSync).toHaveBeenCalledWith('/bin/ls', expect.any(Array), expect.objectContaining({ stdio: ['ignore', 'pipe', 'pipe'] }));
    expect(vi.mocked(execFileSync).mock.calls.every(([command]) => command === '/bin/ls')).toBe(true);
  });

  it('checks inherited staging ACLs before writing any credential bytes', async () => {
    existing('KEEP=unchanged\n');
    mocked.acl = (selected) => selected.endsWith('.tmp')
      ? '-rw-------+ 1 fixture fixture 0 Jan 1 00:00 fixture\n 0: group:everyone inherited allow read\n'
      : 'drwxr-xr-x 1 fixture fixture 0 Jan 1 00:00 fixture\n';
    expect(await promptCredential(NAME)).toMatchObject({ status: 'unavailable', reason: 'unsafe-path' });
    expect(readFileSync(path, 'utf8')).toBe('KEEP=unchanged\n'); noLeftovers();
  });

  it.each(['', 'unexpected metadata', 'drwx------+ fixture\n', 'drwx------+ fixture\n 0: unrecognized acl\n'])('fails closed on unknown ACL metadata %j', async (metadata) => {
    mocked.acl = () => metadata;
    expect(await promptCredential(NAME)).toMatchObject({ status: 'unavailable', reason: 'unsafe-path' });
    expect(execFile).not.toHaveBeenCalled(); expect(existsSync(path)).toBe(false);
  });

  it('does not expose ACL subprocess errors', async () => {
    mocked.acl = () => { throw new Error(`Never surface ${VALUE}`); };
    const result = await promptCredential(NAME);
    expect(result).toMatchObject({ status: 'unavailable', reason: 'unsafe-path' });
    expect(JSON.stringify(result)).not.toContain(VALUE); expect(execFile).not.toHaveBeenCalled();
  });

  it('refuses a symlink credential file without touching its target', async () => {
    const outside = join(root, 'outside'); writeFileSync(outside, 'KEEP=unchanged', { mode: 0o600 });
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); symlinkSync(outside, path);
    expect(await promptCredential(NAME)).toMatchObject({ status: 'unavailable', reason: 'unsafe-path' });
    expect(readFileSync(outside, 'utf8')).toBe('KEEP=unchanged'); expect(execFile).not.toHaveBeenCalled();
  });

  it('refuses a symlink parent before launching the dialog', async () => {
    const outside = join(root, 'outside'); mkdirSync(outside, { mode: 0o700 });
    symlinkSync(outside, join(root, 'config'));
    expect(await promptCredential(NAME)).toMatchObject({ status: 'unavailable', reason: 'unsafe-path' });
    expect(readdirSync(outside)).toEqual([]); expect(execFile).not.toHaveBeenCalled();
  });

  it.each(['directory', 'hardlink', 'public-mode', 'not-owner'] as const)('refuses an unsafe credential target: %s', async (kind) => {
    existing('KEEP=unchanged\n');
    if (kind === 'directory') { rmSync(path); mkdirSync(path, { mode: 0o700 }); }
    if (kind === 'hardlink') linkSync(path, join(root, 'linked'));
    if (kind === 'public-mode') chmodSync(path, 0o644);
    if (kind === 'not-owner') mocked.foreignFile = path;
    expect(await promptCredential(NAME)).toMatchObject({ status: 'unavailable', reason: 'unsafe-path' });
    expect(execFile).not.toHaveBeenCalled();
    if (kind !== 'directory') expect(readFileSync(path, 'utf8')).toBe('KEEP=unchanged\n');
  });

  it('does not lose a concurrent editor change while the popup was open', async () => {
    existing('KEEP=old\n');
    mocked.duringDialog = () => writeFileSync(path, 'KEEP=concurrent-edit\n', { mode: 0o600 });
    expect(await promptCredential(NAME)).toMatchObject({ status: 'unavailable', reason: 'concurrent-change' });
    expect(readFileSync(path, 'utf8')).toBe('KEEP=concurrent-edit\n'); noLeftovers();
  });

  it('does not overwrite a file created during the popup', async () => {
    mocked.duringDialog = () => existing('KEEP=concurrent-create\n');
    expect(await promptCredential(NAME)).toMatchObject({ status: 'unavailable', reason: 'concurrent-change' });
    expect(readFileSync(path, 'utf8')).toBe('KEEP=concurrent-create\n'); noLeftovers();
  });

  it('atomically refuses a new-file collision even after the last snapshot check', async () => {
    mocked.lateCreate = true;
    expect(await promptCredential(NAME)).toMatchObject({ status: 'unavailable', reason: 'concurrent-change' });
    expect(readFileSync(path, 'utf8')).toBe('KEEP=created-at-commit\n'); noLeftovers();
  });

  it('refuses a parent swap during the popup', async () => {
    existing('KEEP=original\n');
    mocked.duringDialog = () => {
      renameSync(dirname(path), join(root, 'original-dir'));
      mkdirSync(dirname(path), { mode: 0o700 });
      writeFileSync(path, 'KEEP=replacement\n', { mode: 0o600 });
    };
    expect(await promptCredential(NAME)).toMatchObject({ status: 'unavailable', reason: 'concurrent-change' });
    expect(readFileSync(path, 'utf8')).toBe('KEEP=replacement\n');
    expect(readFileSync(join(root, 'original-dir', 'credentials'), 'utf8')).toBe('KEEP=original\n');
  });

  it('respects an existing writer lock and leaves it untouched', async () => {
    existing('KEEP=unchanged\n'); writeFileSync(`${path}.prompt.lock`, 'existing lock', { mode: 0o600 });
    expect(await promptCredential(NAME)).toMatchObject({ status: 'unavailable', reason: 'concurrent-change' });
    expect(readFileSync(path, 'utf8')).toBe('KEEP=unchanged\n');
    expect(readFileSync(`${path}.prompt.lock`, 'utf8')).toBe('existing lock');
  });

  it.each(['failWrite', 'failRename'] as const)('a failed atomic save preserves existing bytes and cleans temporary files: %s', async (failure) => {
    const before = '# intact\nKEEP=existing\n'; existing(before); mocked[failure] = true;
    const result = await promptCredential(NAME);
    expect(result).toMatchObject({ status: 'unavailable', reason: 'write-failed' });
    expect(JSON.stringify(result)).not.toContain(VALUE);
    expect(readFileSync(path, 'utf8')).toBe(before); noLeftovers();
  });

  it.each([false, true])('reports committed credentials as saved when local cleanup fails, existing=%s', async (existed) => {
    if (existed) existing('KEEP=untouched\n');
    mocked.failCleanup = true;
    const result = await promptCredential(NAME);
    expect(result).toMatchObject({ status: 'saved', cleanupRequired: true, private: true });
    expect(result).not.toHaveProperty('reason');
    expect(parseCredentials(readFileSync(path, 'utf8')).get(NAME)).toBe(VALUE);
    expect(JSON.stringify(result)).not.toContain(VALUE);
    expect(existsSync(`${path}.prompt.lock`)).toBe(true);
    if (!existed) expect(lstatSync(path).nlink).toBe(2);
  });

  it('reports cleanup attention on a failed pre-commit write without modifying credentials', async () => {
    existing('KEEP=untouched\n'); mocked.failWrite = true; mocked.failCleanup = true;
    expect(await promptCredential(NAME)).toMatchObject({ status: 'unavailable', reason: 'write-failed', cleanupRequired: true });
    expect(readFileSync(path, 'utf8')).toBe('KEEP=untouched\n');
  });
});
