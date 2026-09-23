// Generate a complete release manifest; never infer a revision from private Git history.
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}

export function buildRelease(root = process.cwd()) {
  const product = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const version = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(product.version);
  if (!version || (version[4] && version[4].split('.').some((part) => /^\d+$/.test(part) && part.length > 1 && part.startsWith('0')))) throw new Error('Release version must be strict SemVer without build metadata.');
  const name = 'golive';
  const skill = join(root, 'skills', name);
  const files = {};
  function read(relative) {
    const stat = lstatSync(join(skill, relative));
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('Release build requires regular independent bundle files.');
    files[relative] = createHash('sha256').update(readFileSync(join(skill, relative))).digest('hex');
  }
  function walk(relative) {
    const stat = lstatSync(join(skill, relative));
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Release build refuses symlink directories.');
    for (const entry of readdirSync(join(skill, relative)).sort()) {
      const file = `${relative}/${entry}`;
      const stat = lstatSync(join(skill, file));
      if (stat.isDirectory() && !stat.isSymbolicLink()) walk(file);
      else read(file);
    }
  }
  for (const file of ['SKILL.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md']) read(file);
  walk('references');
  walk('scripts');
  const sourceRef = process.env.GOLIVE_RELEASE_REF || null;
  if (sourceRef !== null && sourceRef !== `v${product.version}`) throw new Error('GOLIVE_RELEASE_REF must be the public version tag or omitted for an unreleased build; private Git revisions are never embedded.');
  const metadata = { schema: 1, name, version: product.version, source: { repository: 'https://github.com/mikehasa/golive-skill', ref: sourceRef }, node: '>=20', schemas: { config: 1, state: 1, approval: 1 }, files };
  const bundleDigest = createHash('sha256').update(JSON.stringify(canonical(metadata))).digest('hex');
  const manifest = { ...metadata, bundleDigest };
  writeFileSync(join(skill, 'release.json'), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}
