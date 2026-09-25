/**
 * `golive credentials --remove NAME --yes` — the human's way back out of a stored token — and the
 * final redaction pass over the published report. Both are this workstream's `src/cli.ts` surface,
 * so both are driven from one process-level fixture.
 *
 * Removal runs against a real temporary credentials file and the real `node:fs` (one case mocks that
 * module deliberately, to land a concurrent writer between the read and the rename). Nothing here
 * opens a provider account, a dialog or the network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  realpathSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Check, CheckResult } from '../src/core/types.js';
import { _resetCredentialsCache, credentialsPath, isCredentialName, parseCredentials, readCredential, removeCredential } from '../src/core/credentials.js';
import { _resetSecretRegistry } from '../src/core/secret.js';
import { detectFixture } from './helpers.js';

const mocks = vi.hoisted(() => ({ checks: [] as Check[], detect: vi.fn(), plan: vi.fn(), exec: vi.fn() }));
vi.mock('../src/core/exec.js', () => ({ exec: mocks.exec }));
vi.mock('../src/detect/index.js', () => ({ detect: mocks.detect }));
vi.mock('../src/core/plan.js', async (original) => ({ ...await original<typeof import('../src/core/plan.js')>(), buildPlan: mocks.plan }));
vi.mock('../src/registry.js', async (original) => ({
  ...await original<typeof import('../src/registry.js')>(),
  ADAPTERS: [], CHECKS: mocks.checks, adapterFor: () => undefined, linkList: () => [],
  checkMap: () => new Map(mocks.checks.map((check) => [check.id, check])),
}));
// Bundle integrity has its own tests; every CLI run here is about the command surface.
vi.mock('../src/core/release.js', async (original) => ({
  ...await original<typeof import('../src/core/release.js')>(),
  loadRuntimeRelease: () => ({ schema: 1, name: 'golive', version: '0.1.0-alpha.1', source: { repository: 'https://github.com/mikehasa/golive-skill', ref: null }, node: '>=20', schemas: { config: 1, state: 1, approval: 1 }, bundleDigest: 'a'.repeat(64) }),
}));

let root: string;
let path: string;
const NAME = 'GOLIVE_REMOVE_TEST_TOKEN';
const VALUE = 'synthetic-provider-token-to-remove';
const KEEP = 'GOLIVE_KEEP_TEST_TOKEN';
const KEEP_VALUE = 'synthetic-provider-token-to-keep';
const oldArgv = process.argv;

beforeEach(() => {
  vi.clearAllMocks();
  _resetCredentialsCache();
  _resetSecretRegistry();
  // macOS /tmp and /var are symlinks; the module intentionally rejects symlink ancestors.
  root = mkdtempSync(join(realpathSync(tmpdir()), 'golive-credential-remove-'));
  chmodSync(root, 0o700);
  path = join(root, 'config', 'golive', 'credentials');
  vi.stubEnv('GOLIVE_CREDENTIALS', path);
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('credential removal must not use the network'); }));
  mocks.detect.mockResolvedValue(detectFixture());
  mocks.plan.mockResolvedValue({ handoffs: [], steps: [] });
  mocks.exec.mockImplementation(() => { throw new Error('credential removal must not run provider CLIs'); });
  mocks.checks.splice(0);
});

afterEach(() => {
  process.argv = oldArgv;
  rmSync(root, { recursive: true, force: true });
  vi.doUnmock('node:fs');
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  _resetCredentialsCache();
  _resetSecretRegistry();
});

/** The private file a human already has, exactly as this module creates it. */
function stored(text: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, text, { mode: 0o600 });
}

/** A removal may never leave a staging file — or anything else — beside the credentials file. */
function noLeftovers(): void {
  expect(readdirSync(dirname(path))).toEqual(['credentials']);
}

async function runCli(args: string[]): Promise<{ output: Record<string, unknown>; raw: string; code: string | number | null | undefined }> {
  vi.resetModules();
  process.argv = ['node', 'golive', ...args, '--json', '--cwd', root];
  const chunks: string[] = [];
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { chunks.push(String(chunk)); return true; });
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
  await import('../src/cli.js');
  await vi.waitFor(() => expect(exit).toHaveBeenCalled());
  const raw = chunks.join('');
  const result = { output: JSON.parse(raw) as Record<string, unknown>, raw, code: exit.mock.calls.at(-1)?.[0] };
  stdout.mockRestore(); stderr.mockRestore(); exit.mockRestore();
  return result;
}

const errorMessage = (result: { output: Record<string, unknown> }): string =>
  String((result.output as { error?: { message?: string } }).error?.message ?? '');

describe('credentials removal', () => {
  it('drops only the named assignments, keeps every other byte, and reports metadata only', () => {
    stored(`# golive tokens\r\nexport ${KEEP}=${KEEP_VALUE}\r\nexport ${NAME} = "old-one"\r\n# between\r\n${NAME}=old-two\r\n# trailing comment without newline`);
    expect(readCredential(NAME)).toBe('old-two');

    const result = removeCredential(NAME);
    expect(result).toEqual({ name: NAME, path, removed: true });
    expect(Object.keys(result).sort()).toEqual(['name', 'path', 'removed']);
    expect(JSON.stringify(result)).not.toContain(VALUE);

    // Byte-exact: comments, CRLF endings, quoting, spacing and the other entry all survive.
    expect(readFileSync(path, 'utf8')).toBe(`# golive tokens\r\nexport ${KEEP}=${KEEP_VALUE}\r\n# between\r\n# trailing comment without newline`);
    const parsed = parseCredentials(readFileSync(path, 'utf8'));
    expect(parsed.has(NAME)).toBe(false);
    expect(parsed.get(KEEP)).toBe(KEEP_VALUE);
    expect(lstatSync(path).mode & 0o777).toBe(0o600);
    expect(readCredential(NAME)).toBeUndefined(); // a reader in this process must not serve the removed value
    expect(readCredential(KEEP)).toBe(KEEP_VALUE);
    noLeftovers();
  });

  it('removes an empty assignment but never a commented-out mention of the same name', () => {
    stored(`# ${NAME} is not a definition\n${KEEP}=${KEEP_VALUE}\n${NAME}=\n`);
    chmodSync(path, 0o644); // a loose file removal rewrites comes back 0600, as setup would leave it
    expect(removeCredential(NAME).removed).toBe(true);
    expect(readFileSync(path, 'utf8')).toBe(`# ${NAME} is not a definition\n${KEEP}=${KEEP_VALUE}\n`);
    expect(lstatSync(path).mode & 0o777).toBe(0o600);
    noLeftovers();
  });

  it('reports removed:false and leaves the file byte-for-byte when the name is not stored', () => {
    const before = `# only other entries\n${KEEP}=${KEEP_VALUE}\n`;
    stored(before);
    expect(removeCredential(NAME)).toEqual({ name: NAME, path, removed: false });
    expect(removeCredential(NAME.toLowerCase()).removed).toBe(false); // names stay case-sensitive, like the parser
    expect(readFileSync(path, 'utf8')).toBe(before);
    noLeftovers();
  });

  it('reports removed:false without creating the file, its directory or anything else', () => {
    expect(removeCredential(NAME)).toEqual({ name: NAME, path, removed: false });
    expect(existsSync(path)).toBe(false);
    expect(existsSync(dirname(path))).toBe(false);
    expect(readdirSync(root)).toEqual([]);
    expect(credentialsPath()).toBe(path);
  });

  it.each(['symlink', 'symlink-parent', 'hardlink', 'directory'] as const)('refuses an unsafe target (%s) and touches nothing', (kind) => {
    const before = `${NAME}=${VALUE}\n`;
    if (kind === 'symlink') {
      const outside = join(root, 'outside');
      writeFileSync(outside, before, { mode: 0o600 });
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      symlinkSync(outside, path);
      expect(() => removeCredential(NAME)).toThrow(/refuses/);
      expect(readFileSync(outside, 'utf8')).toBe(before);
      return;
    }
    if (kind === 'symlink-parent') {
      const outsideDir = join(root, 'outside-dir');
      mkdirSync(outsideDir, { mode: 0o700 });
      writeFileSync(join(outsideDir, 'credentials'), before, { mode: 0o600 });
      mkdirSync(join(root, 'config'), { recursive: true, mode: 0o700 });
      symlinkSync(outsideDir, join(root, 'config', 'golive'));
      expect(() => removeCredential(NAME)).toThrow(/refuses|symlink/);
      expect(readFileSync(join(outsideDir, 'credentials'), 'utf8')).toBe(before);
      return;
    }
    stored(before);
    if (kind === 'hardlink') linkSync(path, join(root, 'linked'));
    else { rmSync(path); mkdirSync(path, { mode: 0o700 }); }
    expect(() => removeCredential(NAME)).toThrow(/refuses/);
    if (kind === 'hardlink') expect(readFileSync(path, 'utf8')).toBe(before);
    else expect(lstatSync(path).isDirectory()).toBe(true);
  });

  it('leaves the stored bytes intact when the replacement cannot be staged', () => {
    const before = `${NAME}=${VALUE}\n${KEEP}=${KEEP_VALUE}\n`;
    stored(before);
    chmodSync(dirname(path), 0o500); // read + traverse only: no staging file can be created
    let caught: unknown;
    try { removeCredential(NAME); } catch (error) { caught = error; }
    finally { chmodSync(dirname(path), 0o700); }
    expect(caught).toBeInstanceOf(Error);
    expect(String(caught)).not.toContain(VALUE);
    expect(readFileSync(path, 'utf8')).toBe(before);
    expect(readCredential(NAME)).toBe(VALUE);
    noLeftovers();
  });

  it('refuses a concurrent replacement instead of overwriting it, and cleans up its staging file', async () => {
    stored(`${NAME}=${VALUE}\n${KEEP}=original\n`);
    vi.doMock('node:fs', async (original) => {
      const fs = await original<typeof import('node:fs')>();
      return {
        ...fs,
        writeFileSync: (...args: Parameters<typeof fs.writeFileSync>) => {
          if (typeof args[0] === 'number') {
            // An editor (or a second golive writer) lands between our read and our rename.
            const concurrent = `${path}.concurrent`;
            fs.writeFileSync(concurrent, `${KEEP}=concurrent-writer\n`, { mode: 0o600 });
            fs.renameSync(concurrent, path);
          }
          return fs.writeFileSync(...args);
        },
      };
    });
    vi.resetModules();
    const { removeCredential: remove } = await import('../src/core/credentials.js');
    expect(() => remove(NAME)).toThrow(/changed during removal/);
    expect(readFileSync(path, 'utf8')).toBe(`${KEEP}=concurrent-writer\n`);
    noLeftovers();
  });

  it('accepts a variable name only, never a value or anything that is not a name', () => {
    for (const name of ['VERCEL_TOKEN', 'GOLIVE_remove_test_2']) expect(isCredentialName(name)).toBe(true);
    for (const name of ['synthetic-secret-value-9f3h2k', 'NAME=value', 'bad name', 'a'.repeat(129)]) {
      expect(isCredentialName(name)).toBe(false);
      let caught: unknown;
      try { removeCredential(name); } catch (error) { caught = error; }
      expect(caught).toBeInstanceOf(Error);
      expect(String(caught)).not.toContain(name);
    }
  });
});

describe('credentials --remove at the CLI boundary', () => {
  it('deletes exactly that entry and prints metadata only', async () => {
    stored(`${NAME}=${VALUE}\n${KEEP}=${KEEP_VALUE}\n`);
    const result = await runCli(['credentials', '--remove', NAME, '--yes']);
    expect(result.code).toBe(0);
    expect(result.output).toEqual({ ok: true, name: NAME, path, removed: true });
    expect(result.raw).not.toContain(VALUE);
    expect(readFileSync(path, 'utf8')).toBe(`${KEEP}=${KEEP_VALUE}\n`);
    expect(mocks.detect).not.toHaveBeenCalled();
    expect(mocks.plan).not.toHaveBeenCalled();
    expect(mocks.exec).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('refuses --remove without --yes and changes nothing', async () => {
    stored(`${NAME}=${VALUE}\n`);
    const result = await runCli(['credentials', '--remove', NAME]);
    expect(result.code).toBe(1);
    expect(result.output).toMatchObject({ ok: false, error: { code: 'usage' } });
    expect(errorMessage(result)).toMatch(/--yes|irreversible/);
    expect(result.raw).not.toContain(VALUE);
    expect(readFileSync(path, 'utf8')).toBe(`${NAME}=${VALUE}\n`);
  });

  it('reports removed:false with exit 0 when nothing is stored under that name', async () => {
    stored(`${KEEP}=${KEEP_VALUE}\n`);
    const result = await runCli(['credentials', '--remove', NAME, '--yes']);
    expect(result.code).toBe(0);
    expect(result.output).toEqual({ ok: true, name: NAME, path, removed: false });
    expect(readFileSync(path, 'utf8')).toBe(`${KEEP}=${KEEP_VALUE}\n`);
  });

  it.each([
    { label: 'a secret value in the name position', args: ['--remove', 'synthetic-secret-value-9f3h2k', '--yes'] },
    { label: 'a missing name', args: ['--remove'] },
    { label: 'a value after the flags', args: ['--remove', NAME, '--yes', 'synthetic-secret-value-9f3h2k'] },
    { label: 'removal combined with setup', args: ['--setup', '--remove', NAME, '--yes'] },
    { label: 'removal combined with the prompt', args: ['--remove', NAME, '--yes', '--prompt', 'OTHER_TOKEN'] },
    { label: '--yes without --remove', args: ['--setup', '--yes'] },
    { label: 'an unknown secret-value option', args: ['--remove', NAME, '--yes', '--secret=synthetic-secret-value-9f3h2k'] },
  ])('rejects $label without touching the file or echoing an argument value', async ({ args }) => {
    stored(`${NAME}=${VALUE}\n`);
    const result = await runCli(['credentials', ...args]);
    expect(result.code).toBe(1);
    expect(result.output).toMatchObject({ ok: false, error: { code: 'usage' } });
    expect(errorMessage(result)).toMatch(/never|--yes|irreversible/);
    expect(result.raw).not.toContain(VALUE);
    expect(result.raw).not.toContain('synthetic-secret-value-9f3h2k');
    expect(readFileSync(path, 'utf8')).toBe(`${NAME}=${VALUE}\n`);
  });
});

describe('published report redaction', () => {
  const SECRET = 'sk_live_51H8xQZ3fakefakefake'; // pattern-shaped fixture, never a real key

  function addCheck(id: string, evidence: string): void {
    mocks.checks.push({
      id, title: `${id} check`, severity: 'high', applies: () => true,
      run: async (): Promise<CheckResult> => ({ id, title: `${id} check`, status: 'pass', severity: 'high', evidence: [evidence] }),
    });
  }

  it('writes both report artifacts through the same final redaction pass as the handover', async () => {
    writeFileSync(join(root, 'golive.yaml'), JSON.stringify({ version: 1, stack: {}, targets: ['production'] }));
    addCheck('accounts', `the provider response echoed a key: ${SECRET}`);
    const result = await runCli(['verify']);
    expect(result.code).toBe(0);

    const json = readFileSync(join(root, '.golive/report.json'), 'utf8');
    const markdown = readFileSync(join(root, 'GOLIVE_REPORT.md'), 'utf8');
    expect(json).not.toContain(SECRET);
    expect(markdown).not.toContain(SECRET);
    expect(result.raw).not.toContain(SECRET);
    expect(json).toContain('[redacted stripe-key]');
    expect(markdown).toContain('[redacted stripe-key]');

    // Redaction is the only change: the file is still the report the CLI reported, same shape.
    const report = JSON.parse(json) as Record<string, unknown>;
    expect(report).toMatchObject({ version: 1, verification: { scope: 'full' }, summary: { pass: 1, fail: 0, warn: 0, skip: 0 } });
    expect(report).toEqual((result.output as { report: unknown }).report);
  });

  it('leaves a report with nothing to redact as it is', async () => {
    writeFileSync(join(root, 'golive.yaml'), JSON.stringify({ version: 1, stack: {}, targets: ['production'] }));
    addCheck('accounts', 'account verified without secrets');
    const result = await runCli(['verify']);
    const json = readFileSync(join(root, '.golive/report.json'), 'utf8');
    expect(json).toContain('account verified without secrets');
    expect(json).not.toMatch(/redacted/);
    expect(JSON.parse(json)).toEqual((result.output as { report: unknown }).report);
  });
});
