import { describe, expect, it } from 'vitest';
import { cloudflareAdapter, cloudflareDns } from '../../src/adapters/cloudflare.js';
import { countSpfLookups, mergeSpf } from '../../src/adapters/cloudflare-spf.js';
import { mockHttp, testCtx, type HttpCall } from '../helpers.js';
import type { DnsRecord, Http, HttpRequest } from '../../src/core/types.js';
import { credentialsPath, tokenHowTo } from '../../src/core/credentials.js';

const TOKEN = 'cfut_TESTtoken0123456789abcdefSECRET';
const API = 'https://api.cloudflare.com/client/v4';
const ZONE = { id: 'zone123', name: 'example.com', status: 'active' };

interface Rec {
  id: string;
  type: string;
  name: string;
  content: string;
  ttl?: number;
  priority?: number;
  proxied?: boolean;
  comment?: string | null;
}

/** A stateful fake of the Cloudflare zone + dns_records API. */
function fakeCloudflare(opts: { zones?: Record<string, typeof ZONE>; records?: Rec[]; failWith?: { status: number; errors: Array<{ code: number; message: string }> } } = {}) {
  const zones = opts.zones ?? { 'example.com': ZONE };
  const records: Rec[] = structuredClone(opts.records ?? []);
  let nextId = 1;
  const fail = () => (opts.failWith ? { status: opts.failWith.status, json: { success: false, errors: opts.failWith.errors, result: null } } : null);
  const m = mockHttp([
    ['GET', `${API}/user/tokens/verify`, () => fail() ?? { json: { success: true, result: { id: 't1', status: 'active' } } }],
    [
      'GET',
      new RegExp(`^${API}/zones\\?`),
      (c) => {
        const name = new URL(c.url).searchParams.get('name') ?? '';
        const z = zones[name];
        return fail() ?? { json: { success: true, result: z ? [z] : [], result_info: { page: 1, total_pages: 1 } } };
      },
    ],
    [
      'GET',
      /\/zones\/zone123\/dns_records\?/,
      (c) => {
        const exact = new URL(c.url).searchParams.get('name.exact');
        const result = exact ? records.filter((r) => r.name === exact) : records;
        return fail() ?? { json: { success: true, result, result_info: { page: 1, total_pages: 1 } } };
      },
    ],
    [
      'POST',
      /\/zones\/zone123\/dns_records$/,
      (c) => {
        const b = c.body as Rec;
        if (records.some((r) => r.type === b.type && r.name === b.name && r.content === b.content)) {
          return { status: 400, json: { success: false, errors: [{ code: 81058, message: 'An identical record already exists.' }] } };
        }
        const rec = { ...b, id: `rec${nextId++}` };
        records.push(rec);
        return { json: { success: true, result: rec } };
      },
    ],
    [
      'PATCH',
      /\/zones\/zone123\/dns_records\/[^/?]+$/,
      (c) => {
        const id = c.url.split('/').pop()!;
        const rec = records.find((r) => r.id === id)!;
        Object.assign(rec, c.body);
        return { json: { success: true, result: rec } };
      },
    ],
  ]);
  return { ...m, records, writes: () => m.calls.filter((c) => c.method !== 'GET') };
}

function ctxWith(fake: { http: ReturnType<typeof mockHttp>['http'] }, tokens: Record<string, string> = { CLOUDFLARE_API_TOKEN: TOKEN }) {
  return testCtx({ http: fake.http, tokens });
}

/** The token must only ever travel in the Authorization header. */
function assertTokenContained(calls: HttpCall[], logs: string[], extra: unknown[] = []) {
  for (const c of calls) {
    expect(c.url).not.toContain(TOKEN);
    expect(JSON.stringify(c.body ?? null)).not.toContain(TOKEN);
    expect(c.headers.authorization).toBe(`Bearer ${TOKEN}`);
  }
  expect(logs.join('\n')).not.toContain(TOKEN);
  for (const x of extra) expect(JSON.stringify(x) ?? String(x)).not.toContain(TOKEN);
}

async function errorOf(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (e) {
    return e as Error;
  }
  throw new Error('expected rejection');
}

describe('cloudflare adapter: shape', () => {
  it('declares dns capability on the dns axis', () => {
    expect(cloudflareAdapter.id).toBe('cloudflare');
    expect(cloudflareAdapter.axes).toEqual(['dns']);
    expect(cloudflareAdapter.automated).toBe(true);
    expect(cloudflareAdapter.capabilities.dns).toBe(cloudflareDns);
  });
});

describe('cloudflare auth', () => {
  it('verifies the token and reports ok without leaking it', async () => {
    const fake = fakeCloudflare();
    const ctx = ctxWith(fake);
    const st = await cloudflareAdapter.auth(ctx);
    expect(st.ok).toBe(true);
    expect(st.via).toContain('CLOUDFLARE_API_TOKEN');
    assertTokenContained(fake.calls, ctx.logs, [st]);
  });

  it('not logged in: points the human at the credentials file (never "export in your terminal")', async () => {
    const fake = fakeCloudflare();
    const st = await cloudflareAdapter.auth(ctxWith(fake, {}));
    expect(st.ok).toBe(false);
    expect(st.howToFix).toContain('Edit zone DNS');
    expect(st.howToFix).toContain('Zone:Zone:Read');
    expect(st.howToFix).toContain(tokenHowTo('CLOUDFLARE_API_TOKEN'));
    expect(st.howToFix).toContain(credentialsPath());
    expect(st.howToFix).toMatch(/Never paste the value into this chat/);
    expect(st.howToFix).not.toMatch(/read -r?s/);
    expect(st.howToFix).not.toMatch(/export CLOUDFLARE_API_TOKEN in your (own )?terminal|&& export/);
    expect(st.howToFix).not.toMatch(/in this shell|your own terminal/i);
    expect(st.howToFix).not.toMatch(/run `wrangler login`/);
    expect(fake.calls).toHaveLength(0);
  });

  it('account-owned tokens verify under CLOUDFLARE_ACCOUNT_ID read as non-secret env', async () => {
    const { http, calls } = mockHttp([
      ['GET', `${API}/user/tokens/verify`, () => ({ status: 401, json: { success: false, errors: [{ code: 1000, message: 'Invalid API Token' }] } })],
      ['GET', `${API}/accounts/acc123/tokens/verify`, () => ({ json: { success: true, result: { status: 'active' } } })],
    ]);
    const st = await cloudflareAdapter.auth(testCtx({ http, tokens: { CLOUDFLARE_API_TOKEN: TOKEN }, env: { CLOUDFLARE_ACCOUNT_ID: 'acc123' } }));
    expect(st.ok).toBe(true);
    expect(calls.map((c) => c.url)).toEqual([`${API}/user/tokens/verify`, `${API}/accounts/acc123/tokens/verify`]);
  });

  it('refuses the Global API Key', async () => {
    // Synthetic rejected input: never obtained from an account or sent to a provider.
    const forbiddenGlobalKey = ['synthetic', 'global', 'key', 'fixture'].join('-');
    const st = await cloudflareAdapter.auth(ctxWith(fakeCloudflare(), { CLOUDFLARE_API_KEY: forbiddenGlobalKey }));
    expect(st.ok).toBe(false);
    expect(st.howToFix).toContain('Global API Key');
    expect(st.howToFix).not.toContain(forbiddenGlobalKey);
  });

  it('invalid token: ok:false (never throws), secret-free howToFix', async () => {
    const fake = fakeCloudflare({ failWith: { status: 401, errors: [{ code: 1000, message: 'Invalid API Token' }] } });
    const ctx = ctxWith(fake);
    const st = await cloudflareAdapter.auth(ctx);
    expect(st.ok).toBe(false);
    expect(st.howToFix).toContain('expired or revoked');
    expect(st.howToFix).toContain('Edit zone DNS');
    assertTokenContained(fake.calls, ctx.logs, [st]);
  });

  it('accepts the CF_API_TOKEN alias', async () => {
    const fake = fakeCloudflare();
    const st = await cloudflareAdapter.auth(testCtx({ http: fake.http, tokens: { CF_API_TOKEN: TOKEN } }));
    expect(st.ok).toBe(true);
  });
});

describe('cloudflare dns.hosts', () => {
  it('finds the zone through parent labels and caches its id', async () => {
    const fake = fakeCloudflare();
    const ctx = ctxWith(fake);
    expect(await cloudflareDns.hosts(ctx, 'App.Staging.Example.com.')).toBe(true);
    const names = fake.calls.map((c) => new URL(c.url).searchParams.get('name'));
    expect(names).toEqual(['app.staging.example.com', 'staging.example.com', 'example.com']);
    expect(fake.calls.every((c) => new URL(c.url).searchParams.get('status') === 'active')).toBe(true);
    expect(ctx.state.resource('cloudflare.zoneId:example.com')).toBe('zone123');

    const before = fake.calls.length;
    expect(await cloudflareDns.hosts(ctx, 'www.example.com')).toBe(true);
    expect(fake.calls.length).toBe(before); // served from state
  });

  it('returns false when no zone is visible', async () => {
    const fake = fakeCloudflare({ zones: {} });
    expect(await cloudflareDns.hosts(ctxWith(fake), 'other.org')).toBe(false);
  });

  it('maps a permission error to an actionable, token-free message', async () => {
    const fake = fakeCloudflare({ failWith: { status: 403, errors: [{ code: 9109, message: 'Unauthorized to access requested resource' }] } });
    const ctx = ctxWith(fake);
    const err = await errorOf(cloudflareDns.hosts(ctx, 'example.com'));
    expect(err.message).toContain('Zone:DNS:Edit');
    expect(err.message).toContain('9109');
    expect(err.message).not.toContain(TOKEN);
    assertTokenContained(fake.calls, ctx.logs);
  });

  it('without a token, throws with the token how-to (no requests made)', async () => {
    const fake = fakeCloudflare();
    const err = await errorOf(cloudflareDns.hosts(ctxWith(fake, {}), 'example.com'));
    expect(err.message).toContain('CLOUDFLARE_API_TOKEN');
    expect(fake.calls).toHaveLength(0);
  });

  it('reports rate limiting clearly', async () => {
    const fake = fakeCloudflare({ failWith: { status: 429, errors: [{ code: 971, message: 'Please wait and consider throttling your request speed' }] } });
    const err = await errorOf(cloudflareDns.hosts(ctxWith(fake), 'example.com'));
    expect(err.message).toMatch(/rate limit/i);
  });
});

describe('cloudflare dns.list', () => {
  it('returns normalised records of supported types', async () => {
    const fake = fakeCloudflare({
      records: [
        { id: 'r1', type: 'TXT', name: 'example.com', content: '"v=DKIM1; k=rsa; p=AAA" "BBB"', ttl: 1, proxied: false },
        { id: 'r2', type: 'CNAME', name: 'www.example.com', content: 'CNAME.Vercel-DNS.com.', ttl: 1, proxied: true },
        { id: 'r3', type: 'NS', name: 'sub.example.com', content: 'ns1.other.net' },
        { id: 'r4', type: 'MX', name: 'send.example.com', content: 'feedback-smtp.us-east-1.amazonses.com', priority: 10 },
      ],
    });
    const list = await cloudflareDns.list(ctxWith(fake), 'example.com');
    expect(list).toEqual([
      { type: 'TXT', name: 'example.com', content: 'v=DKIM1; k=rsa; p=AAABBB', ttl: 1, proxied: false },
      { type: 'CNAME', name: 'www.example.com', content: 'cname.vercel-dns.com', ttl: 1, proxied: true },
      { type: 'MX', name: 'send.example.com', content: 'feedback-smtp.us-east-1.amazonses.com', priority: 10 },
    ]);
    const listCall = fake.calls.find((c) => c.url.includes('/dns_records'))!;
    expect(new URL(listCall.url).searchParams.get('per_page')).toBe('5000');
  });

  it('throws an actionable error when the zone is not in the account', async () => {
    const err = await errorOf(cloudflareDns.list(ctxWith(fakeCloudflare({ zones: {} })), 'nothere.dev'));
    expect(err.message).toMatch(/No active Cloudflare zone for nothere\.dev/);
    expect(err.message).toMatch(/nameservers/);
  });
});

describe('cloudflare dns.upsert', () => {
  const cname: DnsRecord = { type: 'CNAME', name: 'www.example.com', content: 'cname.vercel-dns.com' };

  it('creates a missing record with proxied:false and the golive comment', async () => {
    const fake = fakeCloudflare();
    const ctx = ctxWith(fake);
    expect(await cloudflareDns.upsert(ctx, 'example.com', { ...cname, proxied: true })).toBe('created');
    const [post] = fake.writes();
    expect(post!.method).toBe('POST');
    expect(post!.body).toEqual({ type: 'CNAME', name: 'www.example.com', content: 'cname.vercel-dns.com', ttl: 1, proxied: false, comment: 'golive: managed' });
    expect(ctx.state.resource('cloudflare.recordId:CNAME:www.example.com')).toBe('rec1');
    assertTokenContained(fake.calls, ctx.logs);
  });

  it('every create body carries proxied:false (TXT, MX, A, CAA)', async () => {
    const fake = fakeCloudflare();
    const ctx = ctxWith(fake);
    await cloudflareDns.upsert(ctx, 'example.com', { type: 'TXT', name: 'resend._domainkey.example.com', content: 'p=MIGf' });
    await cloudflareDns.upsert(ctx, 'example.com', { type: 'MX', name: 'send.example.com', content: 'feedback-smtp.amazonses.com', priority: 10 });
    await cloudflareDns.upsert(ctx, 'example.com', { type: 'A', name: 'example.com', content: '76.76.21.21' });
    await cloudflareDns.upsert(ctx, 'example.com', { type: 'CAA', name: 'example.com', content: '0 issue "letsencrypt.org"' });
    const posts = fake.writes();
    expect(posts).toHaveLength(4);
    for (const p of posts) {
      expect(p.method).toBe('POST');
      expect((p.body as Record<string, unknown>).proxied).toBe(false);
      expect((p.body as Record<string, unknown>).comment).toBe('golive: managed');
    }
    expect((posts[1]!.body as Record<string, unknown>).priority).toBe(10);
    expect((posts[3]!.body as Record<string, unknown>).data).toEqual({ flags: 0, tag: 'issue', value: 'letsencrypt.org' });
  });

  it('identical record: unchanged, adopted, no writes', async () => {
    const fake = fakeCloudflare({ records: [{ id: 'mine', type: 'CNAME', name: 'www.example.com', content: 'cname.vercel-dns.com.', proxied: false, comment: null }] });
    const ctx = ctxWith(fake);
    expect(await cloudflareDns.upsert(ctx, 'example.com', cname)).toBe('unchanged');
    expect(fake.writes()).toHaveLength(0);
    expect(ctx.state.resource('cloudflare.recordId:CNAME:www.example.com')).toBe('mine');
  });

  it('identical TXT despite quoting/splitting: unchanged', async () => {
    const fake = fakeCloudflare({ records: [{ id: 't1', type: 'TXT', name: 'resend._domainkey.example.com', content: '"p=MIGf" "MA0G"' }] });
    expect(await cloudflareDns.upsert(ctxWith(fake), 'example.com', { type: 'TXT', name: 'resend._domainkey.example.com', content: 'p=MIGfMA0G' })).toBe('unchanged');
    expect(fake.writes()).toHaveLength(0);
  });

  it('identical but proxied: patches proxied:false only when golive owns it', async () => {
    const owned = fakeCloudflare({ records: [{ id: 'o1', type: 'CNAME', name: 'www.example.com', content: 'cname.vercel-dns.com', proxied: true, comment: 'golive: managed' }] });
    expect(await cloudflareDns.upsert(ctxWith(owned), 'example.com', cname)).toBe('updated');
    expect(owned.writes()[0]!.method).toBe('PATCH');
    expect(owned.writes()[0]!.body).toEqual({ proxied: false });

    const foreign = fakeCloudflare({ records: [{ id: 'f1', type: 'CNAME', name: 'www.example.com', content: 'cname.vercel-dns.com', proxied: true, comment: 'set up by bob' }] });
    const ctx = ctxWith(foreign);
    expect(await cloudflareDns.upsert(ctx, 'example.com', cname)).toBe('unchanged');
    expect(foreign.writes()).toHaveLength(0);
    expect(ctx.logs.join('\n')).toMatch(/proxied/);
  });

  it('foreign conflicting CNAME: clear error naming the existing record, nothing written', async () => {
    const fake = fakeCloudflare({ records: [{ id: 'f1', type: 'CNAME', name: 'www.example.com', content: 'old-host.netlify.app', proxied: false, comment: null }] });
    const ctx = ctxWith(fake);
    const err = await errorOf(cloudflareDns.upsert(ctx, 'example.com', cname));
    expect(err.message).toContain('conflict at www.example.com');
    expect(err.message).toContain('CNAME old-host.netlify.app');
    expect(err.message).toContain('cname.vercel-dns.com');
    expect(err.message).toMatch(/dashboard/);
    expect(err.message).not.toContain(TOKEN);
    expect(fake.writes()).toHaveLength(0);
  });

  it('foreign A record blocks a CNAME at the same name', async () => {
    const fake = fakeCloudflare({ records: [{ id: 'a1', type: 'A', name: 'www.example.com', content: '1.2.3.4' }] });
    const err = await errorOf(cloudflareDns.upsert(ctxWith(fake), 'example.com', cname));
    expect(err.message).toContain('A 1.2.3.4');
    expect(fake.writes()).toHaveLength(0);
  });

  it('golive-owned conflicting record: PATCHed in place (never PUT, never delete)', async () => {
    const fake = fakeCloudflare({ records: [{ id: 'o1', type: 'CNAME', name: 'www.example.com', content: 'old.vercel-dns.com', proxied: false, comment: 'golive: managed' }] });
    const ctx = ctxWith(fake);
    expect(await cloudflareDns.upsert(ctx, 'example.com', cname)).toBe('updated');
    const w = fake.writes();
    expect(w).toHaveLength(1);
    expect(w[0]!.method).toBe('PATCH');
    expect(w[0]!.url).toBe(`${API}/zones/zone123/dns_records/o1`);
    expect(w[0]!.body).toEqual({ type: 'CNAME', content: 'cname.vercel-dns.com', ttl: 1, comment: 'golive: managed', proxied: false });
    expect(fake.records[0]!.content).toBe('cname.vercel-dns.com');
    // re-run is a no-op
    expect(await cloudflareDns.upsert(ctx, 'example.com', cname)).toBe('unchanged');
    expect(fake.writes()).toHaveLength(1);
  });

  it('TXT/MX are created alongside existing different values', async () => {
    const fake = fakeCloudflare({ records: [{ id: 't1', type: 'TXT', name: 'example.com', content: '"google-site-verification=abc"' }] });
    expect(await cloudflareDns.upsert(ctxWith(fake), 'example.com', { type: 'TXT', name: 'example.com', content: 'vercel-verify=xyz' })).toBe('created');
    expect(fake.records).toHaveLength(2);
  });

  it('81058 identical-exists on create is treated as unchanged', async () => {
    // The listing misses it (e.g. a race with another writer) but the create collides.
    const rec: DnsRecord = { type: 'TXT', name: 'hidden.example.com', content: 'v=verify' };
    const { http, calls } = mockHttp([
      ['GET', new RegExp(`^${API}/zones\\?`), () => ({ json: { success: true, result: [ZONE] } })],
      ['GET', /dns_records\?/, () => ({ json: { success: true, result: [], result_info: { total_pages: 1 } } })],
      ['POST', /dns_records$/, () => ({ status: 400, json: { success: false, errors: [{ code: 81058, message: 'An identical record already exists.' }] } })],
    ]);
    expect(await cloudflareDns.upsert(testCtx({ http, tokens: { CLOUDFLARE_API_TOKEN: TOKEN } }), 'example.com', rec)).toBe('unchanged');
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);
  });

  it('refuses names outside the zone', async () => {
    const err = await errorOf(cloudflareDns.upsert(ctxWith(fakeCloudflare()), 'example.com', { type: 'A', name: 'evil.org', content: '1.1.1.1' }));
    expect(err.message).toMatch(/not inside the zone example\.com/);
  });

  it('PATCHes are marked idempotent (safe to retry); creates are not', async () => {
    const fake = fakeCloudflare({ records: [{ id: 'o1', type: 'CNAME', name: 'www.example.com', content: 'old.vercel-dns.com', comment: 'golive: managed' }] });
    const seen: HttpRequest[] = [];
    const http: Http = (req) => {
      seen.push(req);
      return fake.http(req);
    };
    const ctx = testCtx({ http, tokens: { CLOUDFLARE_API_TOKEN: TOKEN } });
    await cloudflareDns.upsert(ctx, 'example.com', cname);
    await cloudflareDns.upsert(ctx, 'example.com', { type: 'TXT', name: 'example.com', content: 'vercel-verify=xyz' });
    const patchReq = seen.find((r) => r.method === 'PATCH')!;
    const postReq = seen.find((r) => r.method === 'POST')!;
    expect(patchReq.idempotent).toBe(true);
    expect(postReq.idempotent).toBeUndefined();
  });

  describe('one-per-name mail records (DKIM key, return-path MX)', () => {
    const dkim = (p: string): DnsRecord => ({ type: 'TXT', name: 'resend._domainkey.example.com', content: `p=${p}` });
    const rp = (region: string): DnsRecord => ({ type: 'MX', name: 'send.example.com', content: `feedback-smtp.${region}.amazonses.com`, priority: 10 });

    it('regression: a stale golive-owned DKIM TXT is PATCHed to the new key, not duplicated', async () => {
      const fake = fakeCloudflare({ records: [{ id: 'k1', type: 'TXT', name: 'resend._domainkey.example.com', content: '"p=OLDKEY"', comment: 'golive: managed' }] });
      const ctx = ctxWith(fake);
      ctx.state.save((s) => void (s.resources['cloudflare.recordId:TXT:resend._domainkey.example.com:stalefp'] = 'k1'));
      expect(await cloudflareDns.upsert(ctx, 'example.com', dkim('NEWKEY'))).toBe('updated');
      const w = fake.writes();
      expect(w).toHaveLength(1);
      expect(w[0]!.method).toBe('PATCH');
      expect(w[0]!.url).toBe(`${API}/zones/zone123/dns_records/k1`);
      expect(w[0]!.body).toEqual({ type: 'TXT', content: 'p=NEWKEY', ttl: 1, comment: 'golive: managed', proxied: false });
      expect(fake.records).toHaveLength(1);
      // state no longer carries the old fingerprint key for that record
      expect(ctx.state.resource('cloudflare.recordId:TXT:resend._domainkey.example.com:stalefp')).toBeUndefined();
      expect(await cloudflareDns.upsert(ctx, 'example.com', dkim('NEWKEY'))).toBe('unchanged');
      expect(fake.writes()).toHaveLength(1);
    });

    it('a foreign stale DKIM key at the selector: clear conflict, nothing written', async () => {
      const fake = fakeCloudflare({ records: [{ id: 'k1', type: 'TXT', name: 'resend._domainkey.example.com', content: 'v=DKIM1; k=rsa; p=OLDKEY', comment: null }] });
      const err = await errorOf(cloudflareDns.upsert(ctxWith(fake), 'example.com', dkim('NEWKEY')));
      expect(err.message).toContain('conflict at resend._domainkey.example.com');
      expect(err.message).toContain('p=OLDKEY');
      expect(fake.writes()).toHaveLength(0);
    });

    it('regression: an owned other-region return-path MX is PATCHed (with priority), not added beside', async () => {
      const fake = fakeCloudflare({ records: [{ id: 'm1', type: 'MX', name: 'send.example.com', content: 'feedback-smtp.us-east-1.amazonses.com', priority: 20, comment: 'golive: managed' }] });
      expect(await cloudflareDns.upsert(ctxWith(fake), 'example.com', rp('eu-west-1'))).toBe('updated');
      const w = fake.writes();
      expect(w).toHaveLength(1);
      expect(w[0]!.method).toBe('PATCH');
      expect(w[0]!.body).toEqual({ type: 'MX', content: 'feedback-smtp.eu-west-1.amazonses.com', ttl: 1, comment: 'golive: managed', priority: 10, proxied: false });
      expect(fake.records).toHaveLength(1);
    });

    it('a foreign other-region return-path MX: clear conflict, nothing written', async () => {
      const fake = fakeCloudflare({ records: [{ id: 'm1', type: 'MX', name: 'send.example.com', content: 'feedback-smtp.us-east-1.amazonses.com', priority: 10 }] });
      const err = await errorOf(cloudflareDns.upsert(ctxWith(fake), 'example.com', rp('eu-west-1')));
      expect(err.message).toContain('MX feedback-smtp.us-east-1.amazonses.com');
      expect(fake.writes()).toHaveLength(0);
    });

    it('receiving MX and other DKIM selectors still live alongside', async () => {
      const fake = fakeCloudflare({
        records: [
          { id: 'mx', type: 'MX', name: 'example.com', content: 'aspmx.l.google.com', priority: 1 },
          { id: 'g', type: 'TXT', name: 'google._domainkey.example.com', content: 'v=DKIM1; k=rsa; p=GOOGLE' },
        ],
      });
      const ctx = ctxWith(fake);
      expect(await cloudflareDns.upsert(ctx, 'example.com', { type: 'MX', name: 'example.com', content: 'mx2.example.net', priority: 5 })).toBe('created');
      expect(await cloudflareDns.upsert(ctx, 'example.com', dkim('NEWKEY'))).toBe('created');
      expect(fake.writes().every((w) => w.method === 'POST')).toBe(true);
      expect(fake.records).toHaveLength(4);
    });
  });

  describe('CNAME exclusivity with non-address records', () => {
    it('regression: CNAME wanted where MX+TXT exist: clear error naming them + return-path hint, zero writes', async () => {
      const fake = fakeCloudflare({
        records: [
          { id: 'm', type: 'MX', name: 'send.example.com', content: 'feedback-smtp.us-east-1.amazonses.com', priority: 10 },
          { id: 't', type: 'TXT', name: 'send.example.com', content: 'v=spf1 include:amazonses.com ~all' },
        ],
      });
      const err = await errorOf(cloudflareDns.upsert(ctxWith(fake), 'example.com', { type: 'CNAME', name: 'send.example.com', content: 'send.spf.resend-dns.com' }));
      expect(err.message).toContain('conflict at send.example.com');
      expect(err.message).toContain('CNAME send.spf.resend-dns.com');
      expect(err.message).toContain('MX feedback-smtp.us-east-1.amazonses.com');
      expect(err.message).toContain('TXT v=spf1 include:amazonses.com ~all');
      expect(err.message).toMatch(/cannot share a name/);
      expect(err.message).toMatch(/custom return path/);
      expect(err.message).not.toContain(TOKEN);
      expect(fake.writes()).toHaveLength(0);
    });

    it('TXT / MX / SPF wanted where a CNAME exists: clear error, zero writes (never converted)', async () => {
      const recs: Rec[] = [{ id: 'c', type: 'CNAME', name: 'send.example.com', content: 'send.spf.resend-dns.com', comment: 'golive: managed' }];
      for (const want of [
        { type: 'TXT', name: 'send.example.com', content: 'v=spf1 include:amazonses.com ~all' },
        { type: 'MX', name: 'send.example.com', content: 'feedback-smtp.us-east-1.amazonses.com', priority: 10 },
        { type: 'TXT', name: 'send.example.com', content: 'some-verification=1' },
      ] as DnsRecord[]) {
        const fake = fakeCloudflare({ records: recs });
        const err = await errorOf(cloudflareDns.upsert(ctxWith(fake), 'example.com', want));
        expect(err.message).toContain('CNAME send.spf.resend-dns.com');
        expect(err.message).toMatch(/cannot share a name/);
        expect(fake.writes()).toHaveLength(0);
      }
    });

    it('the zone apex is exempt (Cloudflare flattens an apex CNAME)', async () => {
      const fake = fakeCloudflare({ records: [{ id: 'c', type: 'CNAME', name: 'example.com', content: 'cname.vercel-dns.com' }] });
      expect(await cloudflareDns.upsert(ctxWith(fake), 'example.com', { type: 'TXT', name: 'example.com', content: 'vercel-verify=xyz' })).toBe('created');
    });

    it('an address conflict for a CNAME still goes through the owned/foreign rule', async () => {
      const fake = fakeCloudflare({ records: [{ id: 'a1', type: 'A', name: 'www.example.com', content: '1.2.3.4', comment: 'golive: managed' }] });
      expect(await cloudflareDns.upsert(ctxWith(fake), 'example.com', cname)).toBe('updated');
    });
  });

  describe('SPF', () => {
    const resendSpf: DnsRecord = { type: 'TXT', name: 'example.com', content: 'v=spf1 include:amazonses.com ~all' };

    it('merges the include into the one existing SPF record, keeping ~all, idempotently', async () => {
      const fake = fakeCloudflare({ records: [{ id: 'spf', type: 'TXT', name: 'example.com', content: '"v=spf1 include:_spf.google.com ~all"', comment: 'owner note' }] });
      const ctx = ctxWith(fake);
      expect(await cloudflareDns.upsert(ctx, 'example.com', resendSpf)).toBe('updated');
      const w = fake.writes();
      expect(w).toHaveLength(1);
      expect(w[0]!.method).toBe('PATCH');
      expect(w[0]!.body).toEqual({ content: 'v=spf1 include:_spf.google.com include:amazonses.com ~all', proxied: false });
      expect(fake.records).toHaveLength(1);
      expect(fake.records[0]!.comment).toBe('owner note');

      expect(await cloudflareDns.upsert(ctx, 'example.com', resendSpf)).toBe('unchanged');
      expect(fake.writes()).toHaveLength(1);
      expect(fake.records[0]!.content.match(/amazonses/g)).toHaveLength(1);
      assertTokenContained(fake.calls, ctx.logs);
    });

    it('creates SPF when none exists at that name', async () => {
      const fake = fakeCloudflare({ records: [{ id: 'o', type: 'TXT', name: 'example.com', content: 'something-else' }] });
      expect(await cloudflareDns.upsert(ctxWith(fake), 'example.com', resendSpf)).toBe('created');
    });

    it('refuses when two SPF records already exist', async () => {
      const fake = fakeCloudflare({
        records: [
          { id: 's1', type: 'TXT', name: 'example.com', content: 'v=spf1 include:a.com ~all' },
          { id: 's2', type: 'TXT', name: 'example.com', content: 'v=spf1 include:b.com -all' },
        ],
      });
      const err = await errorOf(cloudflareDns.upsert(ctxWith(fake), 'example.com', resendSpf));
      expect(err.message).toMatch(/2 SPF/);
      expect(fake.writes()).toHaveLength(0);
    });

    it('refuses when the merge would exceed 10 DNS lookups', async () => {
      const incl = Array.from({ length: 10 }, (_, i) => `include:s${i}.com`).join(' ');
      const fake = fakeCloudflare({ records: [{ id: 's1', type: 'TXT', name: 'example.com', content: `v=spf1 ${incl} -all` }] });
      const err = await errorOf(cloudflareDns.upsert(ctxWith(fake), 'example.com', resendSpf));
      expect(err.message).toMatch(/11 DNS lookups/);
      expect(fake.writes()).toHaveLength(0);
    });

    it('regression: an existing ?include for the same sender is not duplicated; it fails clearly, zero writes', async () => {
      const fake = fakeCloudflare({ records: [{ id: 's1', type: 'TXT', name: 'send.example.com', content: 'v=spf1 ?include:amazonses.com -all' }] });
      const err = await errorOf(cloudflareDns.upsert(ctxWith(fake), 'example.com', { type: 'TXT', name: 'send.example.com', content: 'v=spf1 include:amazonses.com ~all' }));
      expect(err.message).toContain('"?include:amazonses.com"');
      expect(err.message).toMatch(/can never pass/);
      expect(fake.writes()).toHaveLength(0);
    });
  });
});

describe('mergeSpf', () => {
  it('inserts before the all-term, dedupes, keeps the existing qualifier', () => {
    expect(mergeSpf('v=spf1 include:a.com -all', 'v=spf1 include:b.com include:a.com ~all', 'x').content).toBe('v=spf1 include:a.com include:b.com -all');
    expect(mergeSpf('v=spf1 +include:a.com -all', 'v=spf1 include:a.com ~all', 'x').added).toEqual([]);
  });
  it('inserts before modifiers when there is no all-term', () => {
    expect(mergeSpf('v=spf1 ip4:1.2.3.4 redirect=_spf.a.com', 'v=spf1 include:b.com ~all', 'x').content).toBe('v=spf1 ip4:1.2.3.4 include:b.com redirect=_spf.a.com');
  });
  it('compares mechanisms without qualifiers: no duplicate include, non-pass existing term throws', () => {
    expect(() => mergeSpf('v=spf1 ?include:x.com -all', 'v=spf1 include:x.com ~all', 'send.example.com')).toThrow(/"\?include:x\.com".*can never pass/);
    expect(() => mergeSpf('v=spf1 -include:x.com ~all', 'v=spf1 include:x.com ~all', 'n')).toThrow(/can never pass/);
    expect(() => mergeSpf('v=spf1 ~include:x.com ~all', 'v=spf1 include:x.com ~all', 'n')).toThrow(/can never pass/);
    expect(mergeSpf('v=spf1 INCLUDE:X.com -all', 'v=spf1 +include:x.com ~all', 'n')).toEqual({ content: 'v=spf1 INCLUDE:X.com -all', added: [] });
    // wanted terms are deduped among themselves too
    expect(mergeSpf('v=spf1 -all', 'v=spf1 include:x.com +include:x.com ~all', 'n')).toEqual({ content: 'v=spf1 include:x.com -all', added: ['include:x.com'] });
  });
  it('counts lookup terms only', () => {
    expect(countSpfLookups('v=spf1 include:a a mx:b ip4:1.2.3.4 ptr exists:x redirect=y ~all')).toBe(6);
  });
});
