import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mockExec } from './helpers.js';

// Keep this test and the rename helper outside the rename inventory: the old-name fixtures are
// intentional. All files and Git output below are disposable; no real credentials or Git writes.
const scriptUrl = pathToFileURL(resolve('scripts/rename.mjs')).href;
let root: string;
let inventory: string[];

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'rename-skill-')));
  inventory = [];
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function put(path: string, contents: string | Buffer, listed = true) {
  const absolute = join(root, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, contents);
  if (listed) inventory.push(path);
  return absolute;
}

function checkout(oldName = 'xship') {
  put('package.json', JSON.stringify({ name: oldName, private: true }));
  put(`skills/${oldName}/SKILL.md`, `---\nname: ${oldName}\ndescription: Deploy with ${oldName}\n---\nRun scripts/${oldName}.mjs\n`);
  put('build.mjs', `export default { outfile: 'skills/${oldName}/scripts/${oldName}.mjs' };\n`);
}

function tree(path = root): unknown {
  return readdirSync(path).sort().map((name) => {
    const absolute = join(path, name);
    const info = lstatSync(absolute);
    return [name, info.mode & 0o777, info.isSymbolicLink() ? ['link', readlinkSync(absolute)]
      : info.isDirectory() ? tree(absolute) : readFileSync(absolute).toString('base64')];
  });
}

async function rename(args: string[] = ['golive']) {
  const exec = mockExec([
    [/^git rev-parse --show-toplevel$/, { stdout: `${root}\n` }],
    [/^git ls-files -co --exclude-standard -z$/, () => ({ stdout: `${inventory.join('\0')}\0` })],
  ]);
  const output: string[] = [];
  // A variable file URL avoids requiring a declaration for this development-only .mjs helper.
  const { main } = await import(scriptUrl);
  const result = await main(args, { cwd: root, exec: exec.run, write: (text: string) => output.push(text) });
  return { result, output: output.join('\n'), calls: exec.calls };
}

describe('source rename preview and apply', () => {
  it('previews by default without changing files, modes, paths, or the generated bundle', async () => {
    checkout();
    put('src/xship.ts', 'export const name = "xship";\n');
    put('skills/xship/scripts/xship.mjs', 'generated xship fixture\n');
    const before = tree();
    const { result, output, calls } = await rename();
    expect(result).toMatchObject({ applied: false });
    expect(result.changed).toBeGreaterThan(0);
    expect(tree()).toEqual(before);
    expect(output).toContain('golive');
    expect(calls.map(({ cmd, args }) => [cmd, ...args].join(' '))).toEqual([
      'git rev-parse --show-toplevel', 'git ls-files -co --exclude-standard -z',
    ]);
  });

  it('renames lowercase, uppercase and title case in supported source contents and paths', async () => {
    checkout();
    put('src/xship-runtime.ts', 'xship XSHIP Xship\nXSHIP_CREDENTIALS XSHIP_REPORT.md\nsupabase.createdByXship isXship __xshipCreateRequire\nxship.yaml .xship/state.json ~/.config/xship/credentials\n');
    put('docs/XSHIP-GUIDE.md', 'Xship guide: XSHIP and xship\n');
    put('test/xship-example.test.ts', 'xship XSHIP Xship\n');
    const { result } = await rename(['golive', '--apply']);
    expect(result).toMatchObject({ applied: true, removedBundles: 0 });
    expect(readFileSync(join(root, 'src/golive-runtime.ts'), 'utf8')).toBe('golive GOLIVE Golive\nGOLIVE_CREDENTIALS GOLIVE_REPORT.md\nsupabase.createdByGolive isGolive __goliveCreateRequire\ngolive.yaml .golive/state.json ~/.config/golive/credentials\n');
    expect(readFileSync(join(root, 'docs/GOLIVE-GUIDE.md'), 'utf8')).toBe('Golive guide: GOLIVE and golive\n');
    expect(readFileSync(join(root, 'test/golive-example.test.ts'), 'utf8')).toBe('golive GOLIVE Golive\n');
    expect(readFileSync(join(root, 'skills/golive/SKILL.md'), 'utf8')).toContain('name: golive');
    expect(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).name).toBe('golive');
    expect(readFileSync(join(root, 'build.mjs'), 'utf8')).toContain('skills/golive/scripts/golive.mjs');
    expect(existsSync(join(root, 'src/xship-runtime.ts'))).toBe(false);
  });

  it('removes the old generated bundle so the renamed source must be rebuilt', async () => {
    checkout();
    put('skills/xship/scripts/xship.mjs', 'generated xship XSHIP fixture that must never be text-edited\n');
    const { result, calls } = await rename(['golive', '--apply']);
    expect(result).toMatchObject({ applied: true, removedBundles: 1 });
    expect(existsSync(join(root, 'skills/xship/scripts/xship.mjs'))).toBe(false);
    expect(existsSync(join(root, 'skills/golive/scripts/golive.mjs'))).toBe(false);
    expect(calls.every(({ cmd }) => cmd === 'git')).toBe(true);
  });

  it('renames the npm installer and package entrypoint together, preserving its executable mode', async () => {
    checkout();
    put('package.json', JSON.stringify({ name: 'xship', bin: { xship: 'bin/xship.mjs' } }));
    const installer = put('bin/xship.mjs', '#!/usr/bin/env node\nconst skill = "skills/xship"; const command = "xship";\n');
    chmodSync(installer, 0o755);
    await rename(['golive', '--apply']);
    expect(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).bin).toEqual({ golive: 'bin/golive.mjs' });
    expect(readFileSync(join(root, 'bin/golive.mjs'), 'utf8')).toContain('"skills/golive"');
    expect(statSync(join(root, 'bin/golive.mjs')).mode & 0o777).toBe(0o755);
    expect(existsSync(join(root, 'bin/xship.mjs'))).toBe(false);
  });

  it('previews generated manifest removal without changing its bytes', async () => {
    checkout();
    const manifest = put('skills/xship/release.json', JSON.stringify({ files: { 'scripts/xship.mjs': 'old-bundle-hash' } }));
    const before = tree();
    const { result, output } = await rename();
    expect(result).toMatchObject({ applied: false, removedBundles: 0, removedManifests: 1 });
    expect(output).toContain('remove generated "skills/xship/release.json"');
    expect(tree()).toEqual(before);
    expect(readFileSync(manifest, 'utf8')).toContain('old-bundle-hash');
  });

  it('removes the generated manifest without copying stale hashes or touching historical evidence', async () => {
    checkout();
    put('skills/xship/scripts/xship.mjs', 'generated xship runtime');
    put('skills/xship/release.json', JSON.stringify({ files: { 'scripts/xship.mjs': 'old-bundle-hash' } }));
    put('docs/LIVE-TEST-LOG.md', 'xship release manifest hash: historical-proof\n');
    const { result } = await rename(['golive', '--apply']);
    expect(result).toMatchObject({ removedBundles: 1, removedManifests: 1 });
    expect(existsSync(join(root, 'skills/xship/release.json'))).toBe(false);
    expect(existsSync(join(root, 'skills/golive/release.json'))).toBe(false);
    expect(readFileSync(join(root, 'docs/LIVE-TEST-LOG.md'), 'utf8')).toBe('xship release manifest hash: historical-proof\n');
  });

  it('preserves executable modes and moves binary assets without replacing their bytes', async () => {
    checkout();
    const command = put('skills/xship/scripts/helper.sh', '#!/bin/sh\nprintf xship\n');
    chmodSync(command, 0o755);
    const binary = Buffer.concat([Buffer.from([0, 255, 1, 2]), Buffer.from('xship XSHIP Xship')]);
    put('skills/xship/references/xship-logo.bin', binary);
    await rename(['golive', '--apply']);
    expect(statSync(join(root, 'skills/golive/scripts/helper.sh')).mode & 0o777).toBe(0o755);
    expect(readFileSync(join(root, 'skills/golive/scripts/helper.sh'), 'utf8')).toContain('golive');
    expect(readFileSync(join(root, 'skills/golive/references/golive-logo.bin'))).toEqual(binary);
  });

  it('uses the NUL inventory correctly for spaces and newlines in filenames', async () => {
    checkout();
    put('docs/xship guide.md', 'xship guide\n');
    put('src/xship\nmodule.ts', 'export const name = "XSHIP";\n');
    await rename(['golive', '--apply']);
    expect(readFileSync(join(root, 'docs/golive guide.md'), 'utf8')).toBe('golive guide\n');
    expect(readFileSync(join(root, 'src/golive\nmodule.ts'), 'utf8')).toContain('GOLIVE');
  });

  it('supports an explicit old name using the same case mappings', async () => {
    checkout('launchpad');
    put('src/launchpad.ts', 'launchpad LAUNCHPAD Launchpad\n');
    await rename(['golive', 'launchpad', '--apply']);
    expect(readFileSync(join(root, 'src/golive.ts'), 'utf8')).toBe('golive GOLIVE Golive\n');
    expect(readFileSync(join(root, 'skills/golive/SKILL.md'), 'utf8')).toContain('name: golive');
  });
});

describe('rename scope and output privacy', () => {
  it('preserves history, its own implementation and test, and out-of-scope files even when Git lists them', async () => {
    checkout();
    const protectedPaths = [
      'scripts/rename.sh', 'scripts/rename.mjs', 'test/rename.test.ts',
      'docs/HANDOFF.md', 'docs/LIVE-TEST-LOG.md', 'docs/RENAME.md', 'docs/DISTRIBUTION.md',
      'outside/xship-notes.md',
    ];
    for (const path of protectedPaths) put(path, `xship XSHIP Xship historical-${path}\n`);
    await rename(['golive', '--apply']);
    for (const path of protectedPaths) expect(readFileSync(join(root, path), 'utf8')).toBe(`xship XSHIP Xship historical-${path}\n`);
    expect(existsSync(join(root, 'outside/golive-notes.md'))).toBe(false);
  });

  it('never changes or prints sensitive files even if they appear in the Git inventory', async () => {
    checkout();
    const sensitivePaths = [
      '.env', '.env.local', 'src/.env.test', 'src/credentials', 'src/account.key', 'docs/private.pem',
      'node_modules/xship/index.js', '.fixtures-local/xship/data.txt', '.xship/state.json',
    ];
    const sentinel = 'xship PRIVATE_FIXTURE_VALUE_DO_NOT_PRINT';
    for (const path of sensitivePaths) put(path, sentinel);
    // A normal source edit must not turn the summary into a content diff either.
    put('src/name.ts', 'xship PUBLIC_SOURCE_CONTENT_NOT_A_FILENAME');
    const { output } = await rename(['golive', '--apply']);
    for (const path of sensitivePaths) expect(readFileSync(join(root, path), 'utf8')).toBe(sentinel);
    expect(output).not.toContain('PRIVATE_FIXTURE_VALUE_DO_NOT_PRINT');
    expect(output).not.toContain('PUBLIC_SOURCE_CONTENT_NOT_A_FILENAME');
    expect(existsSync(join(root, '.golive'))).toBe(false);
    expect(existsSync(join(root, 'node_modules/golive'))).toBe(false);
    expect(existsSync(join(root, '.fixtures-local/golive'))).toBe(false);
  });

  it('moves only inventoried files, leaving ignored residents in their original directories', async () => {
    checkout();
    const ignored = 'skills/xship/references/xship-private.txt';
    put(ignored, 'xship ignored resident', false);
    put('skills/xship/references/xship-public.md', 'xship public reference');
    const { output } = await rename(['golive', '--apply']);
    expect(readFileSync(join(root, ignored), 'utf8')).toBe('xship ignored resident');
    expect(readFileSync(join(root, 'skills/golive/references/golive-public.md'), 'utf8')).toBe('golive public reference');
    expect(existsSync(join(root, 'skills/golive/references/golive-private.txt'))).toBe(false);
    expect(output).not.toContain('ignored resident');
  });

  it('skips symlink files and descendants without modifying their targets', async () => {
    checkout();
    const fileTarget = put('outside/target.ts', 'xship PRIVATE_LINK_TARGET', false);
    const nestedTarget = put('outside/directory/child.ts', 'xship PRIVATE_DIRECTORY_TARGET', false);
    mkdirSync(join(root, 'src'), { recursive: true });
    symlinkSync(fileTarget, join(root, 'src/xship-link.ts'));
    symlinkSync(dirname(nestedTarget), join(root, 'src/xship-directory'));
    inventory.push('src/xship-link.ts', 'src/xship-directory/child.ts');
    const { output } = await rename(['golive', '--apply']);
    expect(lstatSync(join(root, 'src/xship-link.ts')).isSymbolicLink()).toBe(true);
    expect(lstatSync(join(root, 'src/xship-directory')).isSymbolicLink()).toBe(true);
    expect(readFileSync(fileTarget, 'utf8')).toBe('xship PRIVATE_LINK_TARGET');
    expect(readFileSync(nestedTarget, 'utf8')).toBe('xship PRIVATE_DIRECTORY_TARGET');
    expect(existsSync(join(root, 'src/golive-link.ts'))).toBe(false);
    expect(existsSync(join(root, 'src/golive-directory'))).toBe(false);
    expect(output).not.toMatch(/PRIVATE_LINK_TARGET|PRIVATE_DIRECTORY_TARGET/);
  });
});

describe('rename preflight refusal', () => {
  it.each([
    [], ['--apply'], ['golive', '--unknown'], ['golive', 'xship', 'extra'],
    ['go-live'], ['Golive'], ['1golive'], ['go_live'], ['g'.repeat(65)],
    ['xship'], ['golive', 'golive'], ['golive', 'bad-old'], ['golive', '../xship'],
  ].map((args) => ({ args })))('rejects malformed or unsafe arguments before modifying files: $args', async ({ args }) => {
    checkout();
    const before = tree();
    await expect(rename(args)).rejects.toThrow();
    expect(tree()).toEqual(before);
  });

  it.each(['file', 'directory', 'symlink'])('refuses an existing destination %s before any edits or bundle removal', async (kind) => {
    checkout();
    put('skills/xship/scripts/xship.mjs', 'generated xship');
    put('src/xship.ts', 'xship original source');
    const destination = join(root, 'src/golive.ts');
    if (kind === 'file') put('src/golive.ts', 'existing destination');
    if (kind === 'directory') mkdirSync(destination);
    if (kind === 'symlink') symlinkSync(put('outside/existing.ts', 'existing link target', false), destination);
    const before = tree();
    await expect(rename(['golive', '--apply'])).rejects.toThrow(/exist|collision|conflict/i);
    expect(tree()).toEqual(before);
  });

  it('refuses a symlinked destination parent before writing through it', async () => {
    checkout();
    mkdirSync(join(root, 'outside/destination'), { recursive: true });
    symlinkSync(join(root, 'outside/destination'), join(root, 'skills/golive'));
    const before = tree();
    await expect(rename(['golive', '--apply'])).rejects.toThrow(/symlink|exist|collision|conflict/i);
    expect(tree()).toEqual(before);
  });

  it('refuses a repeated default rename as already renamed without changing the renamed checkout', async () => {
    checkout();
    put('src/xship.ts', 'xship XSHIP Xship');
    await rename(['golive', '--apply']);
    inventory = inventory.map((path) => path.replaceAll('xship', 'golive'));
    const before = tree();
    await expect(rename(['golive', '--apply'])).rejects.toThrow(/already/i);
    expect(tree()).toEqual(before);
  });
});
