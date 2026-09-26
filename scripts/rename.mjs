#!/usr/bin/env node
// One-time source preparation, not an updater or a migration of installed apps.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstatSync, readFileSync, writeFileSync, mkdirSync, chmodSync, unlinkSync, rmdirSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const execFileAsync = promisify(execFile);
const USAGE = 'Usage: scripts/rename.sh <new-name> <old-name> [--apply]\nPreview is the default. Names must be lowercase letters/digits, starting with a letter (max 64).';
const ROOT_FILES = new Set(['README.md', 'AGENTS.md', 'LICENSE', 'package.json', 'pnpm-lock.yaml', 'build.mjs', 'tsconfig.json', 'vitest.config.ts', '.gitignore', '.npmignore', 'plugin.json']);
// Translated READMEs sit at the root too, and they name the product; a rename must not leave the old
// name in them.
const TRANSLATED_README = /^README\.[A-Za-z-]+\.md$/;
const SOURCE_DIRS = new Set(['src', 'test', 'skills', 'docs', 'scripts', 'bin', '.github', '.claude-plugin', '.codex-plugin']);
// These describe the transition or record real historical names. Do not rewrite history or
// mutate this helper's regression fixtures when renaming the product.
const PRESERVE = new Set(['scripts/rename.sh', 'scripts/rename.mjs', 'test/rename.test.ts', 'docs/HANDOFF.md', 'docs/LIVE-TEST-LOG.md', 'docs/RENAME.md', 'docs/DISTRIBUTION.md']);

function parseArgs(argv) {
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) return null;
  const positional = argv.filter((arg) => arg !== '--apply');
  // Both names are explicit: this source is already renamed, so there is no default old name.
  if (positional.length !== 2 || argv.filter((arg) => arg === '--apply').length > 1) throw new Error(USAGE);
  const [newName, oldName] = positional;
  for (const name of [newName, oldName]) {
    // The name also appears inside JS identifiers, so hyphens are intentionally unsupported.
    if (!/^[a-z][a-z0-9]*$/.test(name) || name.length > 64) throw new Error(`Invalid name. ${USAGE}`);
  }
  if (newName === oldName) throw new Error('Old and new names must be different.');
  return { newName, oldName, apply: argv.includes('--apply') };
}

function replacement(oldName, newName) {
  const title = (name) => name[0].toUpperCase() + name.slice(1);
  const variants = new Map([[oldName, newName], [oldName.toUpperCase(), newName.toUpperCase()], [title(oldName), title(newName)]]);
  const pattern = new RegExp([...variants.keys()].sort((a, b) => b.length - a.length).join('|'), 'g');
  return (text) => text.replace(pattern, (match) => variants.get(match));
}

function included(file, oldName, newName) {
  const parts = file.split('/');
  if (isAbsolute(file) || parts.some((part) => !part || part === '.' || part === '..')) throw new Error('Invalid path in Git inventory.');
  if (PRESERVE.has(file)) return false;
  if (parts.some((part) => ['.git', 'node_modules', 'dist', '.fixtures-local', `.${oldName}`, `.${newName}`].includes(part))) return false;
  if (parts.some((part) => /^\.env(?:\.|$)/i.test(part) || /^(?:\.?credentials)(?:\.json)?$/i.test(part) || /\.(?:pem|key|p12|pfx)$/i.test(part))) return false;
  return ROOT_FILES.has(file) || TRANSLATED_README.test(file) || (parts.length > 1 && SOURCE_DIRS.has(parts[0]));
}

function statOrNull(path) {
  try { return lstatSync(path); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error(`Cannot inspect path ${JSON.stringify(path)}.`);
  }
}

// Check each component, not just the leaf: a normal-looking source path can sit below a symlink.
function sourceStat(root, file) {
  let path = root;
  const parts = file.split('/');
  for (let i = 0; i < parts.length; i++) {
    path = join(path, parts[i]);
    const stat = statOrNull(path);
    if (!stat || stat.isSymbolicLink()) return null;
    if (i < parts.length - 1 && !stat.isDirectory()) return null;
    if (i === parts.length - 1) return stat.isFile() ? stat : null;
  }
  return null;
}

function checkDestination(root, file) {
  let path = root;
  const parts = file.split('/');
  for (let i = 0; i < parts.length; i++) {
    path = join(path, parts[i]);
    const stat = statOrNull(path);
    if (!stat) continue;
    if (stat.isSymbolicLink() || i === parts.length - 1 || !stat.isDirectory()) {
      throw new Error(`Destination collision or unsafe path: ${JSON.stringify(file)}. No files changed.`);
    }
  }
}

async function defaultExec(cmd, args, opts) {
  try {
    const result = await execFileAsync(cmd, args, { cwd: opts.cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch {
    // Never echo captured output: repository contents are not diagnostics.
    return { code: 1, stdout: '', stderr: '' };
  }
}

export async function main(argv, { cwd = process.cwd(), exec = defaultExec, write = (line) => process.stdout.write(line + '\n') } = {}) {
  const options = parseArgs(argv);
  if (!options) { write(USAGE); return { applied: false, changed: 0, removedBundles: 0 }; }
  const { newName, oldName, apply } = options;
  const rootResult = await exec('git', ['rev-parse', '--show-toplevel'], { cwd });
  if (rootResult.code !== 0) throw new Error('Run the rename helper from the source Git checkout.');
  const root = realpathSync(rootResult.stdout.replace(/\r?\n$/, ''));
  const listing = await exec('git', ['ls-files', '-co', '--exclude-standard', '-z'], { cwd: root });
  if (listing.code !== 0) throw new Error('Cannot inventory source files with Git.');
  const sourceSkill = `skills/${oldName}/SKILL.md`;
  if (!sourceStat(root, sourceSkill)) {
    if (sourceStat(root, `skills/${newName}/SKILL.md`)) throw new Error(`Already renamed to ${newName}; no files changed.`);
    throw new Error(`Missing regular source skill ${JSON.stringify(sourceSkill)}; no files changed.`);
  }
  if (statOrNull(join(root, 'skills', newName))) throw new Error(`Destination collision: skills/${newName} already exists. No files changed.`);
  const transform = replacement(oldName, newName);
  const generatedBundle = `skills/${oldName}/scripts/${oldName}.mjs`;
  const generatedManifest = `skills/${oldName}/release.json`;
  const operations = [];
  const destinations = new Set();
  for (const file of [...new Set(listing.stdout.split('\0').filter(Boolean))].sort()) {
    if (!included(file, oldName, newName)) continue;
    const stat = sourceStat(root, file);
    if (!stat) continue;
    // A renamed manifest would still contain the old bundle hashes. Rebuild both generated
    // artifacts from the renamed source; never distribute a text-edited integrity manifest.
    if (file === generatedBundle || file === generatedManifest) {
      operations.push({ file, remove: true });
      continue;
    }
    const target = transform(file);
    const bytes = readFileSync(join(root, file));
    let content = bytes;
    // Binary assets still move with their skill; only valid UTF-8 text gets rewritten.
    if (!bytes.includes(0)) {
      try { content = Buffer.from(transform(new TextDecoder('utf-8', { fatal: true }).decode(bytes))); } catch { /* binary */ }
    }
    if (target === file && content.equals(bytes)) continue;
    if (destinations.has(target)) throw new Error(`Destination collision: ${JSON.stringify(target)}. No files changed.`);
    destinations.add(target);
    if (target !== file) checkDestination(root, target);
    operations.push({ file, target, content, mode: stat.mode & 0o777 });
  }
  if (!operations.some((op) => op.file === sourceSkill)) throw new Error('Source skill is not in the editable Git inventory; no files changed.');
  for (const op of operations) {
    write(op.remove ? `remove generated ${JSON.stringify(op.file)}` : op.file === op.target ? `rewrite ${JSON.stringify(op.file)}` : `move ${JSON.stringify(op.file)} -> ${JSON.stringify(op.target)}`);
  }
  if (apply) {
    // Only inventoried regular files move. Ignored residents and symlinks stay where they were.
    for (const op of operations.filter((op) => !op.remove)) {
      const target = join(root, op.target);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, op.content, { flag: op.target === op.file ? 'w' : 'wx', mode: op.mode });
      chmodSync(target, op.mode);
    }
    const parents = new Set();
    for (const op of operations.filter((op) => op.remove || op.target !== op.file)) {
      unlinkSync(join(root, op.file));
      let parent = dirname(join(root, op.file));
      while (parent !== root && !relative(root, parent).startsWith(`..${sep}`)) {
        parents.add(parent);
        parent = dirname(parent);
      }
    }
    for (const parent of [...parents].sort((a, b) => b.length - a.length)) {
      try { rmdirSync(parent); } catch (error) {
        if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw new Error('Could not remove an empty source directory; inspect the checkout before continuing.');
      }
    }
  }
  const removedBundles = operations.filter((op) => op.remove && op.file === generatedBundle).length;
  const removedManifests = operations.filter((op) => op.remove && op.file === generatedManifest).length;
  write(`${apply ? 'Applied' : 'Preview'} ${oldName} -> ${newName}: ${operations.length} file operations. No account or installed-app changes.`);
  write(apply ? 'Before using or installing: pnpm vitest run && pnpm tsc --noEmit && pnpm build. The generated bundle and release manifest must be rebuilt.' : 'To write these source changes, repeat with --apply. See docs/DISTRIBUTION.md.');
  return { applied: apply, changed: operations.length, removedBundles, removedManifests };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`Rename stopped: ${error.message}\n`);
    process.exitCode = 1;
  });
}
