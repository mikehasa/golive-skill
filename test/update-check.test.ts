import { mkdtempSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkForUpdate, compareVersions, UPDATE_METADATA_URL } from '../src/core/update-check.js';
import { releaseDigest, releaseIdentity, PUBLIC_REPOSITORY } from '../src/core/release.js';
import type { ReleaseManifest } from '../src/core/types.js';

function manifest(version = '0.1.0-alpha.10'): ReleaseManifest {
  const m: ReleaseManifest = { schema: 1, name: 'golive', version, source: { repository: PUBLIC_REPOSITORY, ref: `v${version}` }, node: '>=20', schemas: { config: 1, state: 1, approval: 1 }, files: Object.fromEntries(['SKILL.md','LICENSE','THIRD_PARTY_NOTICES.md','references/a.md','scripts/golive.mjs'].map(p=>[p,'a'.repeat(64)])), bundleDigest: '' };
  m.bundleDigest = releaseDigest(m); return m;
}
const current = () => releaseIdentity(manifest('0.1.0-alpha.9'));
const respond = (value: unknown, calls: unknown[] = []) => (async (url, options) => { calls.push({url,options}); return new Response(JSON.stringify(value)); }) as typeof fetch;

describe('public update checks', () => {
  it('uses only fixed public URL, no auth/cookies/redirects, and compares alpha numbers', async () => {
    const calls: any[]=[]; const r=await checkForUpdate(current(),{fetcher:respond(manifest(),calls),cachePath:false});
    expect(r.status).toBe('available'); expect(r.automaticInstall).toBe(false);
    expect(calls[0].url).toBe(UPDATE_METADATA_URL); expect(calls[0].options.headers).toEqual({Accept:'application/json'});
    expect(calls[0].options.credentials).toBe('omit'); expect(calls[0].options.redirect).toBe('error');
  });
  it('caches valid metadata for 24 hours, then refreshes', async () => {
    const cachePath=join(realpathSync(mkdtempSync(join(tmpdir(),'golive-update-'))),'cache.json'); const calls: unknown[]=[];
    const opts={cachePath,fetcher:respond(manifest(),calls),now:100000000};
    expect((await checkForUpdate(current(),opts)).cached).toBe(false);
    expect((await checkForUpdate(current(),{...opts,now:100000001})).cached).toBe(true); expect(calls).toHaveLength(1);
    await checkForUpdate(current(),{...opts,now:200000000}); expect(calls).toHaveLength(2);
  });
  it('is optional offline and bounds a stalled fetch', async () => {
    expect((await checkForUpdate(current(),{cachePath:false,fetcher:(async()=>{throw Error('private raw error');}) as typeof fetch})).note).not.toContain('private raw');
    const r=await checkForUpdate(current(),{cachePath:false,fetcher:(()=>new Promise(()=>{})) as typeof fetch,timeoutMs:5}); expect(r.status).toBe('unavailable');
  });
  it('disabled checks do not fetch and pinned copies only report', async () => {
    const calls:unknown[]=[]; expect((await checkForUpdate(current(),{disabled:true,fetcher:respond(manifest(),calls)})).status).toBe('disabled'); expect(calls).toHaveLength(0);
    const r=await checkForUpdate(current(),{cachePath:false,fetcher:respond(manifest()),ownership:{manager:'owned',pin:'v0.1.0-alpha.9',autoUpdate:true}});
    expect(r.status).toBe('pinned'); expect(r.automaticInstall).toBe(false);
  });
  it.each(['bad-digest','wrong-source','unpublished'])('rejects invalid release %s',async which=>{
    const m=manifest(); if(which==='bad-digest')m.files['SKILL.md']='b'.repeat(64);
    if(which==='wrong-source') {m.source.repository='https://attacker.invalid';m.bundleDigest=releaseDigest(m);}
    if(which==='unpublished'){m.source.ref=null;m.bundleDigest=releaseDigest(m);}
    expect((await checkForUpdate(current(),{cachePath:false,fetcher:respond(m)})).status).toBe('unavailable');
  });
  it('does not follow or overwrite a cache symlink', async()=>{
    const root=realpathSync(mkdtempSync(join(tmpdir(),'golive-update-'))); const victim=join(root,'private');writeFileSync(victim,'unchanged'); const cache=join(root,'cache');symlinkSync(victim,cache);
    expect((await checkForUpdate(current(),{cachePath:cache,fetcher:respond(manifest())})).status).toBe('available'); expect(readFileSync(victim,'utf8')).toBe('unchanged');
  });
  it('does not follow symlinked cache parents', async()=>{
    const root=realpathSync(mkdtempSync(join(tmpdir(),'golive-update-')));mkdirSync(join(root,'target'));symlinkSync(join(root,'target'),join(root,'link'));
    expect((await checkForUpdate(current(),{cachePath:join(root,'link','cache'),fetcher:respond(manifest())})).status).toBe('available');
  });
  it('never suggests mutating a plugin via the own updater',async()=>{
    const r=await checkForUpdate(current(),{cachePath:false,fetcher:respond(manifest()),ownership:{manager:'external',updateCommand:'Use the plugin manager.'}});expect(r.updateCommand).toBe('Use the plugin manager.');expect(r.automaticInstall).toBe(false);
  });
  it('rejects oversized metadata',async()=>{const r=await checkForUpdate(current(),{cachePath:false,fetcher:respond('x'.repeat(600000))});expect(r.status).toBe('unavailable');});
  it.each([['1.0.0','1.0.0-alpha.1',1],['1.0.0-alpha.10','1.0.0-alpha.9',1],['1.0.0-alpha','1.0.0-alpha.1',-1],['1.1.0','1.0.99',1],['1.0.0','1.0.0',0]] as const)('semver %s vs %s', (a,b,n)=>expect(compareVersions(a,b)).toBe(n));
  it.each(['1.0.0-alpha.01','01.0.0','1.0.0-a..b','1.0.0-'])('rejects noncanonical semver %s',v=>expect(()=>compareVersions(v,'1.0.0')).toThrow());
});
