import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mockExec } from './helpers.js';
const entrypoint = pathToFileURL(resolve('bin/golive.mjs')).href;
const library = pathToFileURL(resolve('scripts/install-lib.mjs')).href;
let root: string, project: string, home: string, packageRoot: string;
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
function put(path: string, value: string | Buffer) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, value); }
async function bundle(version = '0.1.0-alpha.1', ref: string | null = null) {
  const source = join(packageRoot, 'skills/golive');
  put(join(source, 'SKILL.md'), '---\nname: golive\n---\nRun scripts/golive.mjs\n');
  put(join(source, 'scripts/golive.mjs'), '#!/usr/bin/env node\n// fixture ' + version);
  put(join(source, 'LICENSE'), 'MIT'); put(join(source, 'THIRD_PARTY_NOTICES.md'), 'Notices');
  put(join(source, 'references/providers.md'), 'fixture reference\n');
  const lib = await import(library);
  const files = Object.fromEntries(['SKILL.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'scripts/golive.mjs', 'references/providers.md'].map((path) => [path, sha(readFileSync(join(source, path)))]));
  const metadata = { schema: 1, name: 'golive', version, source: { repository: lib.REPOSITORY, ref }, node: '>=20', schemas: { config: 1, state: 1, approval: 1 }, files };
  put(join(source, 'release.json'), JSON.stringify({ ...metadata, bundleDigest: sha(lib.canonical(metadata)) }));
  return source;
}
beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'golive-npm-'))); project = join(root, 'project with spaces'); home = join(root, 'home'); packageRoot = join(root, 'package');
  mkdirSync(project); mkdirSync(home); put(join(packageRoot, 'package.json'), JSON.stringify({ name: 'golive', version: '0.1.0-alpha.1' })); await bundle();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
async function run(argv: string[], code = 0) {
  const exec = mockExec([[process.execPath, { code }]]); const lines: string[] = []; const { main } = await import(entrypoint);
  const result = await main(argv, { cwd: project, home, packageRoot, exec: exec.run, smoke: async () => {}, write: (text: string) => lines.push(text) });
  return { result, calls: exec.calls, output: lines.join('\n') };
}
describe('owned npm install', () => {
  it('reports an external bundle manager instead of guessing an installation target', async () => { const { output } = await run(['install-status', '--json']); expect(JSON.parse(output)).toMatchObject({ manager: 'external', location: join(packageRoot, 'skills/golive') }); await expect(run(['update', '--from', join(packageRoot, 'skills/golive')])).rejects.toThrow(/externally managed/); expect(readdirSync(project)).toEqual([]); });

  it('keeps the installed manager self-contained after the source package is removed', async () => {
    const lib = await import(library); const source = join(packageRoot, 'skills/golive'); const manifest = JSON.parse(readFileSync(join(source, 'release.json'), 'utf8'));
    for (const name of ['install-cli.mjs', 'install-lib.mjs']) { const bytes = readFileSync(resolve('scripts', name)); put(join(source, 'scripts', name), bytes); manifest.files[`scripts/${name}`] = sha(bytes); }
    delete manifest.bundleDigest; manifest.bundleDigest = sha(lib.canonical(manifest)); put(join(source, 'release.json'), JSON.stringify(manifest));
    await run(['install', '--agent', 'codex']); const destination = join(project, '.agents/skills/golive'); rmSync(packageRoot, { recursive: true });
    const output = execFileSync(process.execPath, [join(destination, 'scripts/install-cli.mjs'), 'install-status', '--json'], { cwd: project, env: { HOME: home }, encoding: 'utf8', timeout: 10000 });
    expect(JSON.parse(output)).toMatchObject({ manager: 'owned', location: destination, version: '0.1.0-alpha.1' });
    const policy = execFileSync(process.execPath, [join(destination, 'scripts/install-cli.mjs'), 'update-policy', '--auto', 'on', '--json'], { cwd: project, env: { HOME: home }, encoding: 'utf8', timeout: 10000 });
    expect(JSON.parse(policy).autoUpdate).toBe(true);
  });

  it.each(['codex', 'claude'])('installs a verified complete immutable bundle for %s offline', async (agent) => {
    const { result, calls } = await run(['install', '--agent', agent]);
    const destination = join(project, agent === 'codex' ? '.agents' : '.claude', 'skills/golive'); const lib = await import(library);
    expect(result).toBe(0); expect(calls).toEqual([]); expect(lstatSync(destination).isSymbolicLink()).toBe(true);
    expect(lib.verifyBundle(realpathSync(destination)).version).toBe('0.1.0-alpha.1'); expect(lib.installationStatus(destination)).toMatchObject({ manager: 'owned', autoUpdate: false, pin: null });
    expect(readdirSync(home)).toEqual([]);
  });
  it.each(['codex', 'claude'])('uses explicit home only for global %s', async (agent) => {
    await run(['install', '--agent', agent, '--global']); expect(existsSync(join(home, agent === 'codex' ? '.agents' : '.claude', 'skills/golive/SKILL.md'))).toBe(true); expect(readdirSync(project)).toEqual([]);
  });
  it('accepts the claude-code spelling the Skills CLI channel uses, for the same destination', async () => {
    const lib = await import(library);
    expect(lib.installLocation({ cwd: project, home, agent: 'claude-code' })).toBe(lib.installLocation({ cwd: project, home, agent: 'claude' }));
    const { result } = await run(['install', '--agent', 'claude-code']);
    const destination = join(project, '.claude/skills/golive');
    expect(result).toBe(0); expect(lstatSync(destination).isSymbolicLink()).toBe(true);
    expect(lib.installationStatus(destination)).toMatchObject({ manager: 'owned', version: '0.1.0-alpha.1' });
  });
  it('refuses existing copy without modifying it', async () => {
    const path = join(project, '.agents/skills/golive'); put(join(path, 'owner.md'), 'unchanged'); await expect(run(['install', '--agent', 'codex'])).rejects.toThrow(/already exists/); expect(readFileSync(join(path, 'owner.md'), 'utf8')).toBe('unchanged');
  });
  it.each(['parent', 'destination', 'dangling'])('refuses unowned %s symlink', async (kind) => {
    const outside = join(root, 'outside'); mkdirSync(outside); put(join(outside, 'sentinel'), 'keep');
    if (kind === 'parent') symlinkSync(outside, join(project, '.agents'));
    else { mkdirSync(join(project, '.agents/skills'), { recursive: true }); symlinkSync(kind === 'dangling' ? join(root, 'missing') : outside, join(project, '.agents/skills/golive')); }
    await expect(run(['install', '--agent', 'codex'])).rejects.toThrow(/symlink|already exists/); expect(readdirSync(outside)).toEqual(['sentinel']);
  });
  it.each([[], ['--global'], ['--agent'], ['--agent', 'cursor'], ['--agent=codex'], ['--agent', 'codex', '--force'], ['--agent', 'codex', '--agent', 'claude'], ['--agent', 'codex', '--global', '--global']].map((args) => ({ args })))('rejects invalid args $args', async ({ args }) => {
    await expect(run(['install', ...args])).rejects.toThrow(); expect(readdirSync(project)).toEqual([]); expect(readdirSync(home)).toEqual([]);
  });
  it('rejects corrupt source without installing', async () => {
    put(join(packageRoot, 'skills/golive/SKILL.md'), 'tampered'); await expect(run(['install', '--agent', 'codex'])).rejects.toThrow(/integrity/); expect(existsSync(join(project, '.agents/skills/golive'))).toBe(false);
  });
  it('rejects source symlinks', async () => {
    symlinkSync(join(root, 'never-read'), join(packageRoot, 'skills/golive/references/external')); await expect(run(['install', '--agent', 'codex'])).rejects.toThrow(/symlink/);
  });
});
describe('npm CLI forwarding', () => {
  it('forwards argv literally and preserves exit code', async () => {
    const args = ['detect', '--cwd', 'space $(not-code)', '--json']; const { result, calls } = await run(args, 2); expect(result).toBe(2); expect(calls).toHaveLength(1); expect(calls[0]?.args).toEqual([join(packageRoot, 'skills/golive/scripts/golive.mjs'), ...args]);
  });
  it.each(['--help', '-h', 'help'])('normalizes %s', async (arg) => { const { calls, output } = await run([arg]); expect(output).toContain('install --agent codex|claude'); expect(calls[0]?.args.at(-1)).toBe('help'); });
  it('does not scan projects with no command', async () => { const { calls } = await run([]); expect(calls[0]?.args.at(-1)).toBe('help'); });
  it('reads package version', async () => { const { calls, output } = await run(['--version']); expect(output).toBe('0.1.0-alpha.1'); expect(calls).toEqual([]); });
  it('offers installer help without writes', async () => { const { calls, output } = await run(['install', '--help']); expect(output).toContain('rollback'); expect(calls).toEqual([]); expect(readdirSync(project)).toEqual([]); });
});
