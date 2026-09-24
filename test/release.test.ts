import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertReleaseSchemas, canonicalReleaseJson, isReleaseVersion, loadRuntimeRelease, parseReleaseManifest, PRODUCT_VERSION, releaseDigest, releaseIdentity, verifyReleaseBundle } from '../src/core/release.js';
import { applyPlan, stepHash } from '../src/core/runner.js';
import { buildPlan, planId, planView } from '../src/core/plan.js';
import { emptyState, fileStateStore, memoryStateStore } from '../src/core/state.js';
import type { ReleaseIdentity, ReleaseManifest, ShipState, Step } from '../src/core/types.js';
import { TEST_RELEASE, testCtx } from './helpers.js';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'golive-release-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); vi.restoreAllMocks(); });
function put(path: string, content: string) { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), content); }
function manifestFixture(): ReleaseManifest {
  const files = { 'SKILL.md': 'instructions', 'references/provider.md': 'provider guide', 'scripts/golive.mjs': 'runtime', 'scripts/installer.mjs': 'installer', LICENSE: 'MIT', 'THIRD_PARTY_NOTICES.md': 'YAML notice' };
  for (const [path, content] of Object.entries(files)) put(path, content);
  const value = { ...structuredClone(TEST_RELEASE), version: PRODUCT_VERSION, files: Object.fromEntries(Object.entries(files).map(([path, content]) => [path, createHash('sha256').update(content).digest('hex')])) };
  value.bundleDigest = releaseDigest(value);
  writeFileSync(join(root, 'release.json'), JSON.stringify(value));
  return value;
}
function rewriteManifest(mutate: (m: ReleaseManifest) => void): ReleaseManifest {
  const m = JSON.parse(readFileSync(join(root, 'release.json'), 'utf8')) as ReleaseManifest;
  mutate(m);
  m.bundleDigest = releaseDigest(m);
  writeFileSync(join(root, 'release.json'), JSON.stringify(m));
  return m;
}

describe('release manifest integrity', () => {
  it.each(['01.0.0', '1.02.0', '1.0.03', '1.0.0-alpha.01', '1.0.0-alpha..1', '1.0.0-.alpha', '1.0.0-alpha.', '1.0.0+', '1.0.0+build'])('rejects invalid or ambiguous release version %s', (version) => {
    expect(isReleaseVersion(version)).toBe(false);
    manifestFixture();
    const m = rewriteManifest((m) => { m.version = version; });
    expect(() => parseReleaseManifest(m)).toThrow(/complete skill/);
  });
  it.each(['0.0.0', '1.0.0', '0.1.0-alpha.1', '1.2.3-0', '1.2.3-alpha-test.123'])('accepts strict release version %s', (version) => {
    expect(isReleaseVersion(version)).toBe(true);
  });
  it('canonicalizes object keys recursively and preserves array order', () => {
    expect(canonicalReleaseJson({ z: [{ b: 1, a: 2 }, 3], a: true })).toBe('{"a":true,"z":[{"a":2,"b":1},3]}');
  });
  it('loads one complete installed identity without source dependencies', () => {
    const manifest = manifestFixture();
    expect(verifyReleaseBundle(root)).toEqual(manifest);
    expect(loadRuntimeRelease(pathToFileURL(join(root, 'scripts/golive.mjs')).href, join(root, 'scripts/golive.mjs'))).toEqual(releaseIdentity(manifest));
  });
  it.each(['SKILL.md', 'references/provider.md', 'scripts/golive.mjs', 'scripts/installer.mjs', 'LICENSE', 'THIRD_PARTY_NOTICES.md'])('rejects changed %s', (path) => {
    manifestFixture(); put(path, 'different release');
    expect(() => verifyReleaseBundle(root)).toThrow(/complete skill/);
  });
  it.each(['SKILL.md', 'references/provider.md', 'scripts/golive.mjs', 'LICENSE', 'release.json'])('rejects missing %s', (path) => {
    manifestFixture(); rmSync(join(root, path));
    expect(() => verifyReleaseBundle(root)).toThrow(/complete skill/);
  });
  it.each(['scripts/untracked.mjs', 'references/untracked.md', 'unexpected.txt'])('rejects extra %s', (path) => {
    manifestFixture(); put(path, 'untracked');
    expect(() => verifyReleaseBundle(root)).toThrow(/complete skill/);
  });
  it('rejects symlink and hardlink files even when their bytes match', () => {
    manifestFixture();
    const path = join(root, 'SKILL.md');
    rmSync(path); symlinkSync(join(root, 'LICENSE'), path);
    expect(() => verifyReleaseBundle(root)).toThrow(/complete skill/);
    rmSync(path); linkSync(join(root, 'LICENSE'), path);
    expect(() => verifyReleaseBundle(root)).toThrow(/complete skill/);
  });
  it('rejects nested symlink directories and root symlinks', () => {
    manifestFixture();
    symlinkSync(join(root, 'references'), join(root, 'scripts/nested'));
    expect(() => verifyReleaseBundle(root)).toThrow(/complete skill/);
    rmSync(join(root, 'scripts/nested'));
    const link = `${root}-link`;
    try { symlinkSync(root, link); expect(() => verifyReleaseBundle(link)).toThrow(/complete skill/); }
    finally { rmSync(link); }
  });
  it.each(['../escape', '/absolute', 'scripts/../../escape', 'scripts/./x', 'scripts//x', 'scripts\\x', 'release.json'])('rejects unsafe/self-hashed file path %s', (path) => {
    manifestFixture();
    const m = rewriteManifest((v) => { v.files[path] = 'a'.repeat(64); });
    expect(() => parseReleaseManifest(m)).toThrow(/complete skill/);
  });
  it('rejects unsupported metadata, private revisions and changed digest', () => {
    const m = manifestFixture();
    expect(() => parseReleaseManifest({ ...m, schema: 2 })).toThrow();
    expect(() => parseReleaseManifest({ ...m, unrecognized: true })).toThrow();
    expect(() => parseReleaseManifest({ ...m, source: { ...m.source, ref: 'private-commit-sha' } })).toThrow();
    expect(() => parseReleaseManifest({ ...m, version: '0.9.0' })).toThrow();
    expect(() => parseReleaseManifest({ ...m, bundleDigest: 'a'.repeat(64) })).toThrow();
  });
  it('permits the corresponding public version tag but never infers a revision', () => {
    manifestFixture();
    const tagged = rewriteManifest((m) => { m.source.ref = `v${m.version}`; });
    expect(verifyReleaseBundle(root)).toEqual(tagged);
    expect(() => parseReleaseManifest({ ...tagged, source: { ...tagged.source, repository: 'https://github.com/mikehasa/private' } })).toThrow();
  });
  it('rejects a self-consistent different product/version or unsupported schema at runtime', () => {
    manifestFixture(); rewriteManifest((m) => { m.version = '0.9.0'; });
    expect(() => loadRuntimeRelease(pathToFileURL(join(root, 'scripts/golive.mjs')).href, join(root, 'scripts/golive.mjs'))).toThrow(/complete skill/);
    manifestFixture(); rewriteManifest((m) => { m.schemas.approval = 2; });
    expect(() => loadRuntimeRelease(pathToFileURL(join(root, 'scripts/golive.mjs')).href, join(root, 'scripts/golive.mjs'))).toThrow(/Unsupported release schemas/);
  });
  it('builds the same schema, hashes all helpers, and never embeds a private Git SHA', async () => {
    const bundle = manifestFixture();
    const checkout = join(root, 'checkout');
    mkdirSync(join(checkout, 'skills/golive'), { recursive: true });
    for (const file of Object.keys(bundle.files)) {
      const target = join(checkout, 'skills/golive', file);
      mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, readFileSync(join(root, file)));
    }
    writeFileSync(join(checkout, 'package.json'), JSON.stringify({ name: 'golive', version: PRODUCT_VERSION }));
    const helper = pathToFileURL(resolve('scripts/build-release.mjs')).href;
    const { buildRelease } = await import(helper);
    vi.stubEnv('GOLIVE_RELEASE_REF', '');
    try {
      const m = buildRelease(checkout) as ReleaseManifest;
      expect(m.source.ref).toBeNull();
      expect(m.files['scripts/installer.mjs']).toBe(bundle.files['scripts/installer.mjs']);
      expect(verifyReleaseBundle(join(checkout, 'skills/golive'))).toEqual(m);
      vi.stubEnv('GOLIVE_RELEASE_REF', 'private-git-sha');
      expect(() => buildRelease(checkout)).toThrow(/private Git revisions/);
    } finally { vi.unstubAllEnvs(); }
  });
  it('keeps error messages fixed instead of echoing corrupt manifest contents', () => {
    put('release.json', '{"secret":"do-not-print-this"');
    expect(() => verifyReleaseBundle(root)).toThrow(/complete skill/);
    try { verifyReleaseBundle(root); } catch (e) { expect(String(e)).not.toContain('do-not-print-this'); }
  });
  it('actual Node execution rejects script-only and scripts-directory symlinks but permits complete bundle pointers', async () => {
    const m = manifestFixture();
    const healthy = join(root, 'healthy');
    for (const file of Object.keys(m.files)) {
      const target = join(healthy, file); mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, readFileSync(join(root, file)));
    }
    const { build } = await import('esbuild');
    const runtime = join(healthy, 'scripts/golive.mjs');
    await build({ stdin: { contents: `import { loadRuntimeRelease } from ${JSON.stringify(resolve('src/core/release.ts'))}; loadRuntimeRelease(import.meta.url); process.stdout.write('verified\\n');`, resolveDir: process.cwd(), loader: 'ts' }, outfile: runtime, bundle: true, format: 'esm', platform: 'node', target: 'node20', logLevel: 'silent' });
    m.files['scripts/golive.mjs'] = createHash('sha256').update(readFileSync(runtime)).digest('hex');
    m.bundleDigest = releaseDigest(m); writeFileSync(join(healthy, 'release.json'), JSON.stringify(m));
    const run = (entry: string, extra: string[] = []) => spawnSync(process.execPath, [...extra, entry], { cwd: root, env: { HOME: root, USERPROFILE: root }, encoding: 'utf8', timeout: 10000 });
    expect(run(runtime).status).toBe(0);
    const mixed = join(root, 'mixed'); mkdirSync(join(mixed, 'scripts'), { recursive: true }); writeFileSync(join(mixed, 'SKILL.md'), 'different instructions');
    symlinkSync(runtime, join(mixed, 'scripts/golive.mjs'));
    const partial = run(join(mixed, 'scripts/golive.mjs'));
    expect(partial.status).not.toBe(0); expect(partial.stderr).toContain('complete skill'); expect(partial.stdout).toBe('');
    rmSync(join(mixed, 'scripts'), { recursive: true }); symlinkSync(join(healthy, 'scripts'), join(mixed, 'scripts'));
    expect(run(join(mixed, 'scripts/golive.mjs')).status).not.toBe(0);
    const owned = join(root, 'owned-pointer'); symlinkSync(healthy, owned);
    expect(run(join(owned, 'scripts/golive.mjs')).status).toBe(0);
    expect(run(join(owned, 'scripts/golive.mjs'), ['--preserve-symlinks-main']).status).toBe(0);
  });
});

const approve = (id: string, force = false) => ({ approvedPlanId: id, yes: true, confirmLive: false, confirmDns: false, force });
const nextRelease = (): ReleaseIdentity => ({ ...structuredClone(TEST_RELEASE), version: '0.1.0-alpha.2', bundleDigest: 'b'.repeat(64) });
function action(run = vi.fn(async () => ({ changes: ['wrote'] })), extra: Partial<Step> = {}): Step {
  return { id: 'env:production', title: 'set env', kind: 'wire', risk: { writes: true }, dependsOn: [], preview: ['set named env'], verifyWith: [], run, ...extra };
}
async function makePlan(ctx: ReturnType<typeof testCtx>, steps: Step[]) {
  return buildPlan(ctx, [{ id: 'mock', plan: async () => ({ steps, handoffs: [] }) }], { unmappedEnv: [], warnings: [] });
}

describe('release-bound approvals and state', () => {
  it('displays complete release identity and hashes it into approval', async () => {
    const a = testCtx(); const b = testCtx({ release: nextRelease() }); const s = action();
    const pa = await makePlan(a, [s]); const pb = await makePlan(b, [s]);
    expect(pa.id).not.toBe(pb.id);
    expect(planView(pa).release).toEqual(TEST_RELEASE);
    expect(planId([s], [], { ...TEST_RELEASE, bundleDigest: 'c'.repeat(64) })).not.toBe(pa.id);
    expect(planId([s], [], { ...TEST_RELEASE, schemas: { ...TEST_RELEASE.schemas, approval: 2 } })).not.toBe(pa.id);
  });
  it('rejects an old approval before any new runtime step or provider access', async () => {
    const run = vi.fn(async () => ({ changes: [] })); const s = action(run);
    const oldCtx = testCtx(); const oldPlan = await makePlan(oldCtx, [s]);
    const ctx = testCtx({ release: nextRelease() }); const current = await makePlan(ctx, [s]);
    await expect(applyPlan(ctx, oldPlan, new Map(), approve(oldPlan.id))).rejects.toThrow(/release changed/);
    await expect(applyPlan(ctx, current, new Map(), approve(oldPlan.id))).rejects.toThrow(/changed since approval/);
    expect(run).not.toHaveBeenCalled(); expect(ctx.state.get()).toEqual(emptyState());
  });
  it('detects a mutated plan even if the passed id was preserved', async () => {
    const ctx = testCtx(); const run = vi.fn(async () => ({ changes: [] })); const p = await makePlan(ctx, [action(run)]);
    p.steps[0]!.preview = ['different write'];
    await expect(applyPlan(ctx, p, new Map(), approve(p.id))).rejects.toThrow(/plan changed/);
    expect(run).not.toHaveBeenCalled();
  });
  it('same release runs once and resumes without replaying done steps', async () => {
    const ctx = testCtx(); const run = vi.fn(async () => ({ changes: ['created synthetic project'] })); const p = await makePlan(ctx, [action(run)]);
    await applyPlan(ctx, p, new Map(), approve(p.id));
    expect(ctx.state.get().release).toEqual(TEST_RELEASE);
    expect(ctx.state.get().steps['env:production']?.release).toEqual(TEST_RELEASE);
    expect((await applyPlan(ctx, p, new Map(), approve(p.id)))[0]?.status).toBe('skipped');
    expect(run).toHaveBeenCalledTimes(1);
  });
  it('fresh cross-version approval preserves completed identical writes and all evidence', async () => {
    const ctx = testCtx(); const run = vi.fn(async () => ({ changes: ['created synthetic project'] })); const s = action(run); const p = await makePlan(ctx, [s]);
    await applyPlan(ctx, p, new Map(), approve(p.id));
    ctx.state.save((v) => { v.resources.projectId = 'test_project'; v.secrets['URL@production'] = { fp: 'abcdef12', at: 'fixture' }; });
    const before = structuredClone(ctx.state.get());
    const updated = testCtx({ state: before, release: nextRelease() });
    const newPlan = await makePlan(updated, [s]);
    expect((await applyPlan(updated, newPlan, new Map(), approve(newPlan.id)))[0]?.status).toBe('skipped');
    expect(updated.state.get()).toEqual(before); expect(run).toHaveBeenCalledTimes(1);
  });
  it.each(['changed', 'failed', 'force', 'legacy'])('blocks %s historical replay before all writes and keeps state', async (mode) => {
    const oldCtx = testCtx(); const run = vi.fn(async () => ({ changes: [] })); const s = action(run); const oldPlan = await makePlan(oldCtx, [s]);
    await applyPlan(oldCtx, oldPlan, new Map(), approve(oldPlan.id)); run.mockClear();
    const historical = structuredClone(oldCtx.state.get());
    if (mode === 'failed') historical.steps[s.id]!.status = 'failed';
    if (mode === 'legacy') { delete historical.release; delete historical.steps[s.id]!.release; delete historical.steps[s.id]!.hash; }
    const ctx = testCtx({ state: historical, release: nextRelease() });
    const newStep = mode === 'changed' ? { ...s, intent: 'new implementation intent' } : s;
    const other = action(run, { id: 'other:new-write' });
    const p = await makePlan(ctx, [other, newStep]);
    await expect(applyPlan(ctx, p, new Map(), approve(p.id, mode === 'force'))).rejects.toThrow(/historical step.*reconcile/);
    expect(run).not.toHaveBeenCalled(); expect(ctx.state.get()).toEqual(historical);
  });
  it('permits an identical legacy done step to stay done without certifying it as current evidence', async () => {
    const run = vi.fn(async () => ({ changes: [] })); const s = action(run); const old = emptyState();
    old.steps[s.id] = { status: 'done', hash: stepHash(s), at: 'fixture', planId: 'legacy-plan', changes: ['legacy evidence'] };
    const ctx = testCtx({ state: old }); const p = await makePlan(ctx, [s]);
    expect((await applyPlan(ctx, p, new Map(), approve(p.id)))[0]?.status).toBe('skipped');
    expect(ctx.state.get()).toEqual(old); expect(run).not.toHaveBeenCalled();
  });
  it('re-runs a failed destroy step from another release: deletion is idempotent and re-observed', async () => {
    const oldCtx = testCtx();
    const run = vi.fn(async () => ({ changes: ['deleted the synthetic record'] }));
    const s = action(run, { id: 'teardown:test:record', kind: 'destroy', risk: { writes: true, destroy: true }, preview: ['delete the synthetic record'] });
    const oldPlan = await makePlan(oldCtx, [s]);
    await applyPlan(oldCtx, oldPlan, new Map(), { ...approve(oldPlan.id), confirmDestroy: true });
    run.mockClear();
    const historical = structuredClone(oldCtx.state.get());
    historical.steps[s.id]!.status = 'failed';
    const ctx = testCtx({ state: historical, release: nextRelease() });
    const p = await makePlan(ctx, [s]);
    const out = await applyPlan(ctx, p, new Map(), { ...approve(p.id), confirmDestroy: true });
    expect(out[0]?.status).toBe('done');
    expect(run).toHaveBeenCalledTimes(1);
    expect(ctx.state.get().steps[s.id]?.status).toBe('done');
  });
  it('rejects incompatible historical schemas before plan observation and preserves evidence', async () => {
    const state = emptyState(); state.release = { ...structuredClone(TEST_RELEASE), schemas: { config: 1, state: 2, approval: 1 } };
    const ctx = testCtx({ state }); const observe = vi.fn(async () => ({ steps: [], handoffs: [] }));
    await expect(buildPlan(ctx, [{ id: 'observe', plan: observe }], { unmappedEnv: [], warnings: [] })).rejects.toThrow(/incompatible release identity or schemas/);
    expect(observe).not.toHaveBeenCalled(); expect(ctx.state.get()).toEqual(state);
  });
  it('rejects incompatible state encountered after approval before any step', async () => {
    const ctx = testCtx(); const run = vi.fn(async () => ({ changes: [] })); const p = await makePlan(ctx, [action(run)]);
    ctx.state.save((state) => { state.release = { ...structuredClone(TEST_RELEASE), schemas: { config: 2, state: 1, approval: 1 } }; });
    const before = structuredClone(ctx.state.get());
    await expect(applyPlan(ctx, p, new Map(), approve(p.id))).rejects.toThrow(/incompatible/);
    expect(run).not.toHaveBeenCalled(); expect(ctx.state.get()).toEqual(before);
  });
  it('rejects an unsupported current schema rather than guessing a migration', () => {
    expect(() => assertReleaseSchemas({ ...TEST_RELEASE, schemas: { config: 1, state: 1, approval: 2 } })).toThrow(/Unsupported release schemas/);
  });
  it('reads legacy state without rewriting it and leaves unsupported state byte-for-byte intact', () => {
    const legacy = { ...emptyState(), resources: { projectId: 'kept' }, secrets: { DATABASE_URL: { fp: 'abcdef12', at: 'fixture' } } };
    put('.golive/state.json', JSON.stringify(legacy));
    const bytes = readFileSync(join(root, '.golive/state.json'));
    expect(fileStateStore(root).get()).toEqual(legacy);
    expect(readFileSync(join(root, '.golive/state.json'))).toEqual(bytes);
    put('.golive/state.json', JSON.stringify({ ...legacy, version: 2 }));
    const unsupported = readFileSync(join(root, '.golive/state.json'));
    expect(() => fileStateStore(root)).toThrow(/unsupported version/);
    expect(readFileSync(join(root, '.golive/state.json'))).toEqual(unsupported);
  });
  it.each([false, true])('--only cannot bypass a changed historical prerequisite (transitive=%s)', async (transitive) => {
    const oldCtx = testCtx(); const run = vi.fn(async () => ({ changes: [] }));
    const env = action(run, { intent: 'old env source' }); const oldPlan = await makePlan(oldCtx, [env]);
    await applyPlan(oldCtx, oldPlan, new Map(), approve(oldPlan.id)); run.mockClear();
    const ctx = testCtx({ release: nextRelease(), state: oldCtx.state.get() });
    const changed = { ...env, intent: 'changed env source' };
    const middle = action(run, { id: 'middle', dependsOn: [env.id], risk: { writes: false } });
    if (transitive) ctx.state.save((s) => { s.steps.middle = { status: 'done', hash: stepHash(middle), at: 'fixture', planId: 'previous', release: TEST_RELEASE }; });
    const deploy = action(run, { id: 'deploy:production', dependsOn: [transitive ? middle.id : env.id] });
    const p = await makePlan(ctx, transitive ? [changed, middle, deploy] : [changed, deploy]); const before = structuredClone(ctx.state.get());
    await expect(applyPlan(ctx, p, new Map(), { ...approve(p.id), only: [deploy.id] })).rejects.toThrow(/historical step.*reconcile/);
    expect(run).not.toHaveBeenCalled(); expect(ctx.state.get()).toEqual(before);
  });
  it('--only checks prerequisite hash even when release identity did not change', async () => {
    const ctx = testCtx(); const run = vi.fn(async () => ({ changes: [] })); const env = action(run);
    const prior = await makePlan(ctx, [env]); await applyPlan(ctx, prior, new Map(), approve(prior.id)); run.mockClear();
    const changed = { ...env, intent: 'changed approved env' }; const deploy = action(run, { id: 'deploy:production', dependsOn: [env.id] });
    const p = await makePlan(ctx, [changed, deploy]);
    await expect(applyPlan(ctx, p, new Map(), { ...approve(p.id), only: [deploy.id] })).rejects.toThrow(/prerequisite.*matching completed evidence/);
    expect(run).not.toHaveBeenCalled();
  });
  it('--only permits a new dependent write when compatible old prerequisites have identical completed evidence', async () => {
    const old = testCtx(); const run = vi.fn(async () => ({ changes: [] })); const env = action(run);
    const prior = await makePlan(old, [env]); await applyPlan(old, prior, new Map(), approve(prior.id)); run.mockClear();
    const ctx = testCtx({ release: nextRelease(), state: old.state.get() }); const deploy = action(run, { id: 'deploy:production', dependsOn: [env.id] });
    const p = await makePlan(ctx, [env, deploy]);
    const out = await applyPlan(ctx, p, new Map(), { ...approve(p.id, true), only: [deploy.id] });
    expect(out).toMatchObject([{ id: deploy.id, status: 'done' }]); expect(run).toHaveBeenCalledTimes(1);
    expect(ctx.state.get().steps[env.id]).toEqual(old.state.get().steps[env.id]);
  });
});
