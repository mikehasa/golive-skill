import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CredentialPromptResult } from '../src/core/credential-prompt.js';

const mocks = vi.hoisted(() => ({
  promptCredential: vi.fn(),
  detect: vi.fn(),
  loadConfig: vi.fn(),
  createCtx: vi.fn(),
  setupCredentials: vi.fn(),
  credentialsStatus: vi.fn(),
  readCredential: vi.fn(),
  exec: vi.fn(),
  createHttp: vi.fn(),
}));
vi.mock('../src/core/credential-prompt.js', () => ({ promptCredential: mocks.promptCredential }));
vi.mock('../src/detect/index.js', () => ({ detect: mocks.detect }));
vi.mock('../src/core/config.js', async (original) => ({ ...await original<typeof import('../src/core/config.js')>(), loadConfig: mocks.loadConfig }));
vi.mock('../src/core/context.js', async (original) => ({ ...await original<typeof import('../src/core/context.js')>(), createCtx: mocks.createCtx }));
vi.mock('../src/core/credentials.js', async (original) => ({
  ...await original<typeof import('../src/core/credentials.js')>(),
  setupCredentials: mocks.setupCredentials,
  credentialsStatus: mocks.credentialsStatus,
  readCredential: mocks.readCredential,
}));
vi.mock('../src/core/exec.js', () => ({ exec: mocks.exec }));
vi.mock('../src/core/http.js', async (original) => ({ ...await original<typeof import('../src/core/http.js')>(), createHttp: mocks.createHttp }));
// Bundle integrity has its own tests. This CLI boundary must not read an installed bundle,
// credentials file or project, and the prompt itself must never open real native UI here.
vi.mock('../src/core/release.js', async (original) => ({
  ...await original<typeof import('../src/core/release.js')>(),
  loadRuntimeRelease: () => ({ schema: 1, name: 'golive', version: '0.1.0-alpha.1', source: { repository: 'https://github.com/mikehasa/golive-skill', ref: null }, node: '>=20', schemas: { config: 1, state: 1, approval: 1 }, bundleDigest: 'a'.repeat(64) }),
}));

const oldArgv = process.argv;
const guards = Object.entries(mocks).filter(([name]) => name !== 'promptCredential').map(([, guard]) => guard);
const variable = 'FIXTURE_API_TOKEN';
const credentialPath = '/fixture/private/credentials';
const fakeValue = 'dummy-secret-value-do-not-echo-019283';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.promptCredential.mockReset();
  for (const guard of guards) guard.mockImplementation(() => { throw new Error('credential prompt must not inspect projects or dispatch provider work'); });
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('credential prompt CLI test must not use the network'); }));
});
afterEach(() => {
  for (const guard of guards) expect(guard).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
  process.argv = oldArgv;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function run(args: string[]) {
  vi.resetModules();
  process.argv = ['node', 'golive', 'credentials', ...args, '--json', '--cwd', '/fixture/not-a-project'];
  const chunks: string[] = [];
  const errors: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { chunks.push(String(chunk)); return true; });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => { errors.push(String(chunk)); return true; });
  const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
  await import('../src/cli.js');
  await vi.waitFor(() => expect(exit).toHaveBeenCalled());
  const raw = chunks.join('');
  return { output: JSON.parse(raw), raw, stderr: errors.join(''), code: exit.mock.calls.at(-1)?.[0] };
}

describe('native credential prompt CLI boundary', () => {
  it.each([
    { args: ['--prompt', variable], replace: false, language: 'en', envOverride: false },
    { args: ['--prompt', variable, '--lang', 'en'], replace: false, language: 'en', envOverride: true },
    { args: [`--prompt=${variable}`, '--replace', '--lang', 'zh'], replace: true, language: 'zh', envOverride: false },
  ])('passes the variable name and explicit options to the private prompt: $args', async ({ args, replace, language, envOverride }) => {
    const metadata: CredentialPromptResult = { status: 'saved', name: variable, path: credentialPath, replaced: replace, private: true, envOverride };
    mocks.promptCredential.mockResolvedValue(metadata);
    const result = await run(args);
    expect(mocks.promptCredential).toHaveBeenCalledExactlyOnceWith(variable, { replace, language });
    expect(result.code).toBe(0);
    expect(result.output).toEqual({ ok: true, ...metadata });
    expect(result.stderr).toBe('');
    expect(result.raw).not.toContain(fakeValue);
    expect(result.output).not.toHaveProperty('value');
  });

  it.each([
    { status: 'cancelled' as const },
    { status: 'unavailable' as const, reason: 'unsupported-platform' as const },
  ])('returns action-needed for $status without entering the deployment flow', async (status) => {
    const metadata: CredentialPromptResult = { ...status, name: variable, path: credentialPath, envOverride: false };
    mocks.promptCredential.mockResolvedValue(metadata);
    const result = await run(['--prompt', variable]);
    expect(result.code).toBe(2);
    expect(result.output).toEqual({ ok: false, ...metadata });
    expect(mocks.promptCredential).toHaveBeenCalledExactlyOnceWith(variable, { replace: false, language: 'en' });
    expect(result.stderr).toBe('');
  });

  it('reports a committed save with cleanup attention without asking for the credential again', async () => {
    const metadata: CredentialPromptResult = { status: 'saved', name: variable, path: credentialPath, replaced: false, private: true, envOverride: false, cleanupRequired: true };
    mocks.promptCredential.mockResolvedValue(metadata);
    const result = await run(['--prompt', variable]);
    expect(result.code).toBe(2);
    expect(result.output).toEqual({ ok: true, ...metadata });
    expect(mocks.promptCredential).toHaveBeenCalledTimes(1);
    expect(result.raw + result.stderr).not.toContain(fakeValue);
  });

  it.each([
    { label: 'setup combined with prompt', args: ['--setup', '--prompt', variable] },
    { label: 'invalid language', args: ['--prompt', variable, '--lang', fakeValue] },
    { label: 'unknown secret-value option', args: ['--prompt', variable, '--value', fakeValue] },
    { label: 'unknown option with equals', args: ['--prompt', variable, `--secret=${fakeValue}`] },
    { label: 'extra positional secret', args: ['--prompt', variable, fakeValue] },
    { label: 'replacement flag with a value', args: ['--prompt', variable, '--replace', fakeValue] },
    { label: 'missing variable name', args: ['--prompt'] },
  ])('rejects $label without opening the prompt or echoing an argument value', async ({ args }) => {
    const result = await run(args);
    expect(result.code).toBe(1);
    expect(result.output).toMatchObject({ ok: false, error: { code: 'usage' } });
    expect(result.output.error.message).toMatch(/never|secret values/);
    expect(mocks.promptCredential).not.toHaveBeenCalled();
    expect(result.raw + result.stderr).not.toContain(fakeValue);
  });
});
