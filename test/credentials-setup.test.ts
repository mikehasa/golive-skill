import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setupCredentials, tokenHowTo } from '../src/core/credentials.js';

// Real filesystem fixtures remain inside a fresh temp tree; no credentials or provider calls.
vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>();
  return { ...fs, readFileSync: vi.fn(fs.readFileSync) };
});
const guards = vi.hoisted(() => ({ detect: vi.fn(), loadConfig: vi.fn(), createCtx: vi.fn() }));
vi.mock('../src/detect/index.js', () => ({ detect: guards.detect }));
vi.mock('../src/core/config.js', async (original) => ({ ...await original<typeof import('../src/core/config.js')>(), loadConfig: guards.loadConfig }));
vi.mock('../src/core/context.js', async (original) => ({ ...await original<typeof import('../src/core/context.js')>(), createCtx: guards.createCtx }));
// Bundle integrity has separate temp-file coverage; isolate this credential-I/O test from
// source-development hashing so its no-secret-reads assertion remains exact.
vi.mock('../src/core/release.js', async (original) => ({
  ...await original<typeof import('../src/core/release.js')>(),
  loadRuntimeRelease: () => ({ schema: 1, name: 'golive', version: '0.1.0-alpha.1', source: { repository: 'https://github.com/mikehasa/golive-skill', ref: null }, node: '>=20', schemas: { config: 1, state: 1, approval: 1 }, bundleDigest: 'a'.repeat(64) }),
}));

let root: string;
const oldArgv = process.argv;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'golive-setup-')));
  vi.clearAllMocks();
  for (const guard of Object.values(guards)) guard.mockImplementation(() => { throw new Error('setup must not inspect the project or accounts'); });
});
afterEach(() => {
  process.argv = oldArgv;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});
const mode = (path: string) => statSync(path).mode & 0o777;

describe('private credentials setup', () => {
  it('creates missing parents and an empty private file without reading contents', () => {
    const path = join(root, '.config', 'golive', 'credentials');
    expect(setupCredentials(path)).toEqual({ path, exists: true, created: true, private: true });
    expect(readFileSync).not.toHaveBeenCalled();
    expect(statSync(path).size).toBe(0);
    expect(mode(join(root, '.config'))).toBe(0o700);
    expect(mode(join(root, '.config', 'golive'))).toBe(0o700);
    expect(mode(path)).toBe(0o600);
  });

  it('is idempotent, preserving the existing inode and bytes while tightening permissions', () => {
    const path = join(root, 'credentials');
    const contents = Buffer.from('# owner notes\r\nFAKE_TOKEN=fixture-value\r\ninvalid but preserved\0', 'utf8');
    writeFileSync(path, contents, { mode: 0o644 });
    const before = statSync(path);
    const result = setupCredentials(path);
    expect(result).toEqual({ path, exists: true, created: false, private: true });
    expect(readFileSync).not.toHaveBeenCalled();
    expect(readFileSync(path)).toEqual(contents);
    expect(statSync(path).ino).toBe(before.ino);
    expect(statSync(path).mtimeMs).toBe(before.mtimeMs);
    expect(mode(path)).toBe(0o600);
    expect(setupCredentials(path).created).toBe(false);
  });

  it('does not chmod existing parent directories', () => {
    const parent = join(root, 'config');
    mkdirSync(parent, { mode: 0o755 });
    chmodSync(parent, 0o755);
    setupCredentials(join(parent, 'golive', 'credentials'));
    expect(mode(parent)).toBe(0o755);
    expect(mode(join(parent, 'golive'))).toBe(0o700);
  });

  it('can make an owner-read-only credentials file editable without reading or truncating it', () => {
    const path = join(root, 'credentials');
    writeFileSync(path, 'FAKE_KEY=untouched', { mode: 0o400 });
    expect(setupCredentials(path).private).toBe(true);
    expect(readFileSync).not.toHaveBeenCalled();
    expect(mode(path)).toBe(0o600);
    expect(readFileSync(path, 'utf8')).toBe('FAKE_KEY=untouched');
  });

  it('refuses a directory in place of the file', () => {
    const path = join(root, 'credentials');
    mkdirSync(path);
    expect(() => setupCredentials(path)).toThrow(/non-regular file/);
    expect(lstatSync(path).isDirectory()).toBe(true);
  });

  it.each([false, true])('refuses a symlinked file (dangling: %s)', (dangling) => {
    const target = join(root, 'target');
    if (!dangling) { writeFileSync(target, 'untouched'); chmodSync(target, 0o644); }
    const path = join(root, 'credentials');
    symlinkSync(target, path);
    expect(() => setupCredentials(path)).toThrow(/symlink/);
    expect(lstatSync(path).isSymbolicLink()).toBe(true);
    expect(existsSync(target)).toBe(!dangling);
    if (!dangling) { expect(mode(target)).toBe(0o644); expect(readFileSync(target, 'utf8')).toBe('untouched'); }
  });

  it('refuses symlinks at any existing parent before creating children', () => {
    const real = join(root, 'real');
    mkdirSync(real);
    mkdirSync(join(real, 'nested'));
    const alias = join(root, 'alias');
    symlinkSync(real, alias);
    expect(() => setupCredentials(join(alias, 'golive', 'credentials'))).toThrow(/symlink/);
    expect(() => setupCredentials(join(alias, 'nested', 'credentials'))).toThrow(/symlink/);
    expect(existsSync(join(real, 'golive'))).toBe(false);
    expect(existsSync(join(real, 'nested', 'credentials'))).toBe(false);
  });

  it('refuses a non-directory parent without altering it', () => {
    const parent = join(root, 'config');
    writeFileSync(parent, 'keep');
    expect(() => setupCredentials(join(parent, 'credentials'))).toThrow(/non-directory/);
    expect(readFileSync(parent, 'utf8')).toBe('keep');
  });

  it('refuses hard links before changing file permissions', () => {
    const target = join(root, 'other');
    writeFileSync(target, 'keep');
    chmodSync(target, 0o644);
    const path = join(root, 'credentials');
    linkSync(target, path);
    expect(() => setupCredentials(path)).toThrow(/hard links/);
    expect(mode(target)).toBe(0o644);
    expect(readFileSync(target, 'utf8')).toBe('keep');
  });

  it('honors the existing XDG and explicit-file overrides, never using the real user file', () => {
    vi.stubEnv('XDG_CONFIG_HOME', join(root, 'xdg'));
    vi.stubEnv('GOLIVE_CREDENTIALS', '');
    expect(setupCredentials().path).toBe(join(root, 'xdg', 'golive', 'credentials'));
    vi.stubEnv('GOLIVE_CREDENTIALS', join(root, 'override', 'tokens'));
    expect(setupCredentials().path).toBe(join(root, 'override', 'tokens'));
  });

  it('explains setup plus the full nano save sequence, without asking for a chat paste', () => {
    vi.stubEnv('GOLIVE_CREDENTIALS', join(root, 'credentials'));
    const text = tokenHowTo('TEST_OPERATOR_KEY');
    expect(text).toContain('credentials --setup --json');
    expect(text).toContain('own editor');
    expect(text).toMatch(/Ctrl\+O, then Enter.*Ctrl\+X/);
    expect(text).toContain('Never paste');
    expect(existsSync(join(root, 'credentials'))).toBe(false);
  });
});

describe('credentials CLI early branch', () => {
  async function run(args: string[]) {
    vi.resetModules();
    process.argv = ['node', 'golive', ...args];
    const chunks: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { chunks.push(String(chunk)); return true; });
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    await import('../src/cli.js');
    await vi.waitFor(() => expect(exit).toHaveBeenCalled());
    return { output: JSON.parse(chunks.join('')), code: exit.mock.calls.at(-1)?.[0] };
  }

  it('works outside any project and reports metadata only without scanning or creating context', async () => {
    const path = join(root, 'private', 'credentials');
    mkdirSync(join(root, 'private'));
    writeFileSync(path, 'FAKE_OPERATOR_KEY=never-print-this-fixture\n');
    vi.stubEnv('GOLIVE_CREDENTIALS', path);
    const result = await run(['credentials', '--setup', '--json', '--cwd', join(root, 'does-not-exist')]);
    expect(result).toEqual({ code: 0, output: { ok: true, path, exists: true, created: false, private: true } });
    expect(readFileSync).not.toHaveBeenCalled();
    for (const guard of Object.values(guards)) expect(guard).not.toHaveBeenCalled();
    expect(JSON.stringify(result.output)).not.toMatch(/FAKE_OPERATOR_KEY|never-print|names/);
  });

  it.each([{ args: [] }, { args: ['--setup=false'] }])('requires explicit --setup and performs no filesystem work: %j', async ({ args }) => {
    const path = join(root, 'not-created', 'credentials');
    vi.stubEnv('GOLIVE_CREDENTIALS', path);
    const result = await run(['credentials', ...args, '--json']);
    expect(result).toMatchObject({ code: 1, output: { ok: false, error: { code: 'usage', message: expect.stringContaining('--setup') } } });
    expect(existsSync(join(root, 'not-created'))).toBe(false);
    for (const guard of Object.values(guards)) expect(guard).not.toHaveBeenCalled();
  });
});
