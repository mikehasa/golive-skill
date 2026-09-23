import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mockExec } from './helpers.js';
const library = pathToFileURL(resolve('scripts/install-lib.mjs')).href;
let root: string, destination: string, first: string, second: string;
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
function put(path: string, value: string | Buffer) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, value); }
async function makeBundle(version: string, ref: string | null = null) {
  const path = join(root, version); const lib = await import(library);
  const content = { LICENSE: 'MIT', 'THIRD_PARTY_NOTICES.md': 'Notices', 'SKILL.md': '---\nname: golive\n---\nVersion ' + version, 'references/example.md': 'Complete reference ' + version, 'scripts/golive.mjs': '// offline test runtime ' + version };
  for (const [file, bytes] of Object.entries(content)) put(join(path, file), bytes);
  const body = { schema: 1, name: 'golive', version, source: { repository: lib.REPOSITORY, ref }, node: '>=20', schemas: { config: 1, state: 1, approval: 1 }, files: Object.fromEntries(Object.entries(content).map(([file, bytes]) => [file, sha(bytes)])) };
  put(join(path, 'release.json'), JSON.stringify({ ...body, bundleDigest: sha(lib.canonical(body)) })); return path;
}
async function rehash(path: string) {
  const lib = await import(library); const manifest = JSON.parse(readFileSync(join(path, 'release.json'), 'utf8')); delete manifest.bundleDigest;
  for (const file of Object.keys(manifest.files)) manifest.files[file] = sha(readFileSync(join(path, file)));
  put(join(path, 'release.json'), JSON.stringify({ ...manifest, bundleDigest: sha(lib.canonical(manifest)) }));
}
const noSmoke = async () => {};
function deferred() { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; }
async function install(source = first, extra = {}) { const lib = await import(library); return lib.changeInstallation({ destination, source, install: true, smoke: noSmoke, ...extra }); }
async function update(extra = {}) { const lib = await import(library); return lib.changeInstallation({ destination, source: second, smoke: noSmoke, ...extra }); }
async function status() { return (await import(library)).installationStatus(destination); }
beforeEach(async () => { root = realpathSync(mkdtempSync(join(tmpdir(), 'golive-update-'))); destination = join(root, 'project/.agents/skills/golive'); first = await makeBundle('0.1.0-alpha.1', 'v0.1.0-alpha.1'); second = await makeBundle('0.1.0-alpha.2', 'v0.1.0-alpha.2'); });
afterEach(() => { vi.useRealTimers(); rmSync(root, { recursive: true, force: true }); });
describe('whole owned release lifecycle', () => {
  it('ignores a process interrupted before publishing its complete lock', async () => { await install(); put(join(dirname(destination), '.golive-owned/.lock-candidate-interrupted/partial'), 'not an active lock'); await update(); expect((await status()).version).toBe('0.1.0-alpha.2'); });
  it('rollback preserves current opt-out and pinned status rather than historical policy', async () => { const lib = await import(library); await install(first, { pin: true }); await lib.setUpdatePolicy(destination, true); await update({ ref: 'v0.1.0-alpha.2' }); await lib.setUpdatePolicy(destination, false); await lib.rollbackInstallation(destination, { smoke: noSmoke }); expect(await status()).toMatchObject({ version: '0.1.0-alpha.1', autoUpdate: false, pin: 'v0.1.0-alpha.1' }); });
  it('stages and smoke-checks a complete new release before switching, retains old release and rolls back', async () => {
    const lib = await import(library); await install(); const old = realpathSync(destination); const stages: string[] = [];
    await update({ smoke: async (bundle: string) => { expect(realpathSync(destination)).toBe(old); expect(lib.verifyBundle(bundle).version).toBe('0.1.0-alpha.2'); }, hook: (stage: string) => stages.push(stage) });
    expect(stages).toEqual(['staged', 'smoked', 'before-switch']); expect(realpathSync(destination)).not.toBe(old); expect(lib.verifyBundle(old).version).toBe('0.1.0-alpha.1');
    await lib.rollbackInstallation(destination, { smoke: noSmoke }); expect(lib.verifyBundle(realpathSync(destination)).bundleDigest).toBe(lib.verifyBundle(old).bundleDigest); expect((await status()).version).toBe('0.1.0-alpha.1');
  });
  it.each(['staged', 'smoked', 'before-switch'])('keeps old copy intact after interruption at %s and allows retry', async (point) => {
    await install(); const old = realpathSync(destination);
    await expect(update({ hook: (stage: string) => { if (stage === point) throw new Error('simulated interruption'); } })).rejects.toThrow(/interruption/);
    expect(realpathSync(destination)).toBe(old); expect((await status()).version).toBe('0.1.0-alpha.1'); await update(); expect((await status()).version).toBe('0.1.0-alpha.2');
  });
  it('refuses concurrent updates while staging', async () => {
    await install(); let ready!: () => void, finish!: () => void; const started = new Promise<void>((r) => { ready = r; }); const barrier = new Promise<void>((r) => { finish = r; });
    const pending = update({ smoke: async () => { ready(); await barrier; } }); await started; await expect(update()).rejects.toThrow(/locked/); finish(); await pending;
  });
  it('preserves a replacement live lock when stale recovery resumes, including update opt-out', async () => {
    const lib = await import(library); await install(); await lib.setUpdatePolicy(destination, true);
    const stoppedReady = deferred(), stop = deferred(), replacementReady = deferred(), finish = deferred();
    // Keep a real lock to model a stopped owner; the injected PID check controls the interleaving.
    const stopped = update({ smoke: async () => { stoppedReady.resolve(); await stop.promise; throw new Error('simulated stopped owner'); } });
    const stoppedResult = expect(stopped).rejects.toThrow(/stopped owner/); await stoppedReady.promise;
    let replacement: ReturnType<typeof update> | undefined;
    try {
      expect(() => lib.recoverLock(destination, { isRunning: () => {
        lib.recoverLock(destination, { isRunning: () => false });
        replacement = lib.changeInstallation({ destination, source: second, smoke: async () => { replacementReady.resolve(); await finish.promise; } });
        return false;
      } })).toThrow(/changed/);
      await replacementReady.promise;
      await expect(lib.setUpdatePolicy(destination, false)).rejects.toThrow(/locked/);
    } finally {
      stop.resolve(); await stoppedResult; finish.resolve(); if (replacement) await replacement;
    }
    await lib.setUpdatePolicy(destination, false);
    expect(await status()).toMatchObject({ version: '0.1.0-alpha.2', autoUpdate: false });
  });
  it('does not let an older operation clean up a later operation\'s lock', async () => {
    const lib = await import(library); await install(); const stoppedReady = deferred(), stop = deferred(), replacementReady = deferred(), finish = deferred();
    const stopped = update({ smoke: async () => { stoppedReady.resolve(); await stop.promise; throw new Error('simulated stopped owner'); } });
    const stoppedResult = expect(stopped).rejects.toThrow(/stopped owner/); await stoppedReady.promise;
    lib.recoverLock(destination, { isRunning: () => false });
    const replacement = update({ smoke: async () => { replacementReady.resolve(); await finish.promise; } });
    try {
      await replacementReady.promise; stop.resolve(); await stoppedResult;
      await expect(lib.setUpdatePolicy(destination, false)).rejects.toThrow(/locked/);
      expect(() => lib.recoverLock(destination, { isRunning: () => true })).toThrow(/alive/);
    } finally { stop.resolve(); finish.resolve(); await replacement; }
    expect((await status()).version).toBe('0.1.0-alpha.2');
  });
  it('can acquire an empty lock left by a crash during cleanup', async () => {
    await install(); mkdirSync(join(dirname(destination), '.golive-owned/.lock')); await update();
    expect((await status()).version).toBe('0.1.0-alpha.2');
  });
  it('recovers an explicitly requested dead-owner lock and ignores incomplete staged bytes', async () => {
    await install(); const lib = await import(library); const store = join(dirname(destination), '.golive-owned'); put(join(store, `.lock/owner-${randomUUID()}.json`), JSON.stringify({ pid: 12345 })); put(join(store, 'versions/incomplete/bundle/SKILL.md'), 'partial');
    await expect(update()).rejects.toThrow(/locked/); expect(() => lib.recoverLock(destination, { isRunning: () => true })).toThrow(/alive/);
    expect(lib.recoverLock(destination, { isRunning: () => false }).recovered).toBe(true); expect((await status()).version).toBe('0.1.0-alpha.1'); await update();
  });
  it('can explicitly recover an empty lock left during cleanup', async () => {
    await install(); const lib = await import(library); const lock = join(dirname(destination), '.golive-owned/.lock'); mkdirSync(lock);
    expect(lib.recoverLock(destination).recovered).toBe(true); expect(existsSync(lock)).toBe(false); await update();
  });
  it('leaves legacy fixed-name locks untouched because their identity cannot be recovered safely', async () => {
    await install(); const lib = await import(library); const path = join(dirname(destination), '.golive-owned/.lock/owner.json'); const owner = JSON.stringify({ pid: 12345 }); put(path, owner);
    expect(() => lib.recoverLock(destination, { isRunning: () => false })).toThrow(/incompatible/);
    expect(readFileSync(path, 'utf8')).toBe(owner); await expect(update()).rejects.toThrow(/locked/);
  });
  it('does not overwrite a destination changed outside the manager during staging', async () => {
    await install(); const outside = join(root, 'manual'); mkdirSync(outside); put(join(outside, 'keep'), 'owner');
    await expect(update({ hook: (stage: string) => { if (stage === 'before-switch') { rmSync(destination); symlinkSync(outside, destination); } } })).rejects.toThrow(/changed/);
    expect(realpathSync(destination)).toBe(outside); expect(readFileSync(join(outside, 'keep'), 'utf8')).toBe('owner');
  });
  it('keeps a pinned copy until an explicit ref change and never auto-updates it', async () => {
    const lib = await import(library); await install(first, { pin: true }); await lib.setUpdatePolicy(destination, true);
    expect((await update()).changed).toBe(false); expect((await update({ auto: true, betweenRuns: true, ref: 'v0.1.0-alpha.2' })).changed).toBe(false);
    await update({ ref: 'v0.1.0-alpha.2' }); expect(await status()).toMatchObject({ version: '0.1.0-alpha.2', pin: 'v0.1.0-alpha.2' });
  });
  it('requires both auto opt-in and an explicit run boundary', async () => {
    const lib = await import(library); await install(); expect((await update({ auto: true, betweenRuns: true })).changed).toBe(false);
    await lib.setUpdatePolicy(destination, true); expect((await update({ auto: true })).changed).toBe(false); await update({ auto: true, betweenRuns: true }); expect((await status()).version).toBe('0.1.0-alpha.2');
    await lib.setUpdatePolicy(destination, false); expect((await status()).autoUpdate).toBe(false);
  });
  it('leaves app config, state and credentials byte-identical across update and rollback', async () => {
    const lib = await import(library); const paths = ['project/golive.yaml', 'project/.golive/state.json', 'config/golive/credentials']; for (const path of paths) put(join(root, path), 'private test sentinel\n');
    await install(); await update(); await lib.rollbackInstallation(destination, { smoke: noSmoke }); for (const path of paths) expect(readFileSync(join(root, path), 'utf8')).toBe('private test sentinel\n');
  });
  it('recognizes installed bundle ownership, reports duplicates without deleting them', async () => {
    const lib = await import(library); await install(); const other = join(root, 'home/.claude/skills/golive'); put(join(other, 'SKILL.md'), 'different');
    expect(lib.statusForBundle(destination)).toMatchObject({ manager: 'owned', location: destination }); expect(lib.installationStatus(destination, { candidates: [other] }).duplicates).toEqual([{ location: other, action: 'left unchanged' }]); expect(existsSync(other)).toBe(true);
  });
  it('rejects a stale immutable version as an updater entrypoint after an upgrade', async () => {
    const lib = await import(library); await install(); const old = realpathSync(destination); await update(); expect(() => lib.ownedLocationForBundle(old)).toThrow(/not the active/);
  });
  it('does not smoke or switch when the selected version is already installed', async () => { await install(); const smoke = vi.fn(); expect((await update({ source: first, smoke })).changed).toBe(false); expect(smoke).not.toHaveBeenCalled(); });
});
describe('source and ownership boundaries', () => {
  it('requires exact manifest fields, notices and at least one reference', async () => { const lib = await import(library); const manifest = JSON.parse(readFileSync(join(first, 'release.json'), 'utf8')); const extra = { ...manifest, unexpected: true }; delete extra.bundleDigest; extra.bundleDigest = sha(lib.canonical(extra)); expect(() => lib.validateManifest(extra)).toThrow(/fields/); for (const path of ['LICENSE', 'THIRD_PARTY_NOTICES.md', 'references/example.md']) { const bad = structuredClone(manifest); delete bad.files[path]; delete bad.bundleDigest; bad.bundleDigest = sha(lib.canonical(bad)); expect(() => lib.validateManifest(bad)).toThrow(/incomplete/); } });
  it('rejects unrecognized empty root directories', async () => { await install(); mkdirSync(join(second, 'unexpected')); await expect(update()).rejects.toThrow(/unsupported directory/); });
  it.each(['01.0.0', '0.01.0', '0.0.01', '1.0.0-alpha.01', '1.0.0-alpha..1', '1.0.0-', '1.0.0+build'])('rejects malformed release version %s', async (version) => {
    const lib = await import(library); expect(lib.isReleaseVersion(version)).toBe(false); const invalid = await makeBundle(version); await expect(install(invalid)).rejects.toThrow(/incompatible/);
  });
  it('accepts zero prerelease identifiers and hyphenated identifiers', async () => { const lib = await import(library); for (const version of ['0.0.0', '1.0.0-alpha.0', '1.0.0-alpha-name.1']) expect(lib.isReleaseVersion(version)).toBe(true); });
  it('refuses bytes changed under the same immutable version', async () => { await install(); put(join(first, 'SKILL.md'), 'changed'); await rehash(first); await expect(update({ source: first })).rejects.toThrow(/immutable release version/); });
  it('does not downgrade automatically even after opt-in', async () => { const lib = await import(library); await install(second); await lib.setUpdatePolicy(destination, true); expect((await update({ source: first, auto: true, betweenRuns: true })).changed).toBe(false); expect((await status()).version).toBe('0.1.0-alpha.2'); });
  it.each(['SKILL.md', 'scripts/golive.mjs', 'references/example.md'])('rejects corrupt %s without replacing the active bundle', async (file) => {
    await install(); put(join(second, file), 'tampered'); await expect(update()).rejects.toThrow(/integrity/); expect((await status()).version).toBe('0.1.0-alpha.1');
  });
  it('refuses unknown files, missing files and symlinks', async () => {
    await install(); put(join(second, 'unknown.js'), 'extra'); await expect(update()).rejects.toThrow(/integrity/); rmSync(join(second, 'unknown.js'));
    rmSync(join(second, 'references/example.md')); await expect(update()).rejects.toThrow(/incomplete/); symlinkSync(join(first, 'references/example.md'), join(second, 'references/example.md')); await expect(update()).rejects.toThrow(/symlink/);
  });
  it('rejects hardlinked payloads', async () => { await install(); rmSync(join(second, 'SKILL.md')); linkSync(join(first, 'SKILL.md'), join(second, 'SKILL.md')); await expect(update()).rejects.toThrow(/unsafe/); });
  it('refuses a symlinked version store and its external target remains unchanged', async () => {
    mkdirSync(dirname(destination), { recursive: true }); const external = join(root, 'external'); mkdirSync(external); symlinkSync(external, join(dirname(destination), '.golive-owned')); await expect(install()).rejects.toThrow(/symlink/); expect(readdirSync(external)).toEqual([]);
  });
  it('leaves Skills CLI/manual installs untouched and reports the manager command', async () => {
    put(join(destination, 'SKILL.md'), 'managed elsewhere'); await expect(update()).rejects.toThrow(/Skills CLI/); expect((await status()).manager).toBe('external'); expect((await status()).updateCommand).toContain('npx skills update golive -p'); expect(readFileSync(join(destination, 'SKILL.md'), 'utf8')).toBe('managed elsewhere');
  });
  it('points plugin copies to their manager', async () => { const lib = await import(library); const plugin = join(root, '.codex/plugins/cache/vendor/skill'); mkdirSync(plugin, { recursive: true }); expect(lib.statusForBundle(plugin).updateCommand).toContain('plugin manager'); });
  it('refuses corrupted rollback metadata before changing the current pointer', async () => {
    const lib = await import(library); await install(); const prior = realpathSync(destination); await update(); const current = realpathSync(destination); const file = join(dirname(prior), 'receipt.json'); const receipt = JSON.parse(readFileSync(file, 'utf8')); put(file, JSON.stringify({ ...receipt, location: '/not-this-install' }));
    await expect(lib.rollbackInstallation(destination, { smoke: noSmoke })).rejects.toThrow(/ownership/); expect(realpathSync(destination)).toBe(current);
  });
  it('uses a real offline smoke with no provider commands and rejects subprocess/network attempts', async () => {
    const lib = await import(library); const fake = mockExec([]); await install(first, { smoke: lib.defaultSmoke }); expect(fake.calls).toEqual([]);
    put(join(second, 'scripts/golive.mjs'), "await fetch('https://should-never-be-called.invalid');"); await rehash(second); await expect(update({ smoke: lib.defaultSmoke })).rejects.toThrow(/offline smoke/); expect((await status()).version).toBe('0.1.0-alpha.1');
  });
});
describe('public download', () => {
  it('requests only allowlisted immutable public paths without tokens and verifies every file', async () => {
    await install(); const calls: Array<{ url: string; options: RequestInit }> = []; const lib = await import(library);
    const fetcher = async (url: string, options: RequestInit) => { calls.push({ url, options }); const path = url.split('/skills/golive/')[1]!; return new Response(readFileSync(join(second, path))); };
    await lib.changeInstallation({ destination, ref: 'v0.1.0-alpha.2', fetcher, smoke: noSmoke }); expect(calls).toHaveLength(6);
    for (const call of calls) { expect(call.url).toMatch(/^https:\/\/raw.githubusercontent.com\/mikehasa\/golive-skill\/v0.1.0-alpha.2\/skills\/golive\//); expect(call.options.redirect).toBe('error'); expect(call.options.headers).toEqual({ accept: 'application/octet-stream' }); }
  });
  it.each(['main', '../other', 'https://evil.test', 'tag?token=secret'])('rejects untrusted ref %s before fetching', async (ref) => { await install(); const fetcher = vi.fn(); await expect(update({ source: undefined, ref, fetcher })).rejects.toThrow(/immutable/); expect(fetcher).not.toHaveBeenCalled(); });
  it('fails closed on redirect/error and keeps previous installation usable', async () => { await install(); await expect(update({ source: undefined, ref: 'v0.1.0-alpha.2', fetcher: async () => new Response('', { status: 302 }) })).rejects.toThrow(/download failed/); expect((await status()).version).toBe('0.1.0-alpha.1'); });
  it('rejects a manifest from a different public source', async () => {
    await install(); const lib = await import(library); const manifest = JSON.parse(readFileSync(join(second, 'release.json'), 'utf8')); delete manifest.bundleDigest; manifest.source.repository = 'https://github.com/attacker/clone'; manifest.bundleDigest = sha(lib.canonical(manifest));
    await expect(update({ source: undefined, ref: 'v0.1.0-alpha.2', fetcher: async () => new Response(JSON.stringify(manifest)) })).rejects.toThrow(/metadata/);
  });
  it('bounds oversized release metadata without switching', async () => { await install(); await expect(update({ source: undefined, ref: 'v0.1.0-alpha.2', fetcher: async () => new Response('x'.repeat(262145)) })).rejects.toThrow(/size limit/); expect((await status()).version).toBe('0.1.0-alpha.1'); });
  it('times out a hung public read and preserves the old release', async () => {
    await install(); vi.useFakeTimers(); let ready!: () => void; const started = new Promise<void>((r) => { ready = r; }); const pending = update({ source: undefined, ref: 'v0.1.0-alpha.2', fetcher: (_url: string, options: RequestInit) => { ready(); return new Promise((_resolve, reject) => options.signal?.addEventListener('abort', () => reject(new Error('offline')))); } });
    const assertion = expect(pending).rejects.toThrow(/timed out/); await started; await vi.advanceTimersByTimeAsync(8001); await assertion; expect((await status()).version).toBe('0.1.0-alpha.1');
  });
});
