import { describe, expect, it } from 'vitest';
import { godaddyAdapter, godaddyDns } from '../../src/adapters/godaddy.js';
import { Secret, fingerprint } from '../../src/core/secret.js';
import type { DnsRecord, HttpRequest } from '../../src/core/types.js';
import { mockExec, mockHttp, testCtx } from '../helpers.js';

const API = 'https://api.godaddy.com/v3/domains';
const TOKEN = 'gd_' + 'pat_mock_only_not_a_real_token';
type Record = { recordId: string; name: string; type: string; data: string; ttl: number; priority?: number; flag?: number; tag?: string };
const cname: DnsRecord = { type: 'CNAME', name: 'app.example.com', content: 'cname.vercel-dns.com' };
function fake(opts: {
  zone?: string; records?: Record[]; nameservers?: string[]; delegations?: { [domain: string]: string[] };
  authStatus?: number; readStatus?: number; dnsStatus?: number; badPage?: unknown; createStatus?: number; lostCreate?: boolean;
  deleteStatus?: number;
  onRead?: (records: Record[], count: number) => void;
} = {}) {
  const zone = opts.zone ?? 'example.com';
  const data = (opts.records ?? []).map((r) => ({ ...r }));
  let reads = 0;
  let seq = 0;
  const requests: HttpRequest[] = [];
  const http = mockHttp([
    ['GET', /^https:\/\/(cloudflare-dns\.com\/dns-query|dns\.google\/resolve)/, (call) => {
      const owner = new URL(call.url).searchParams.get('name')!;
      const ns = opts.delegations?.[owner] ?? (owner === zone ? opts.nameservers ?? ['ns01.domaincontrol.com', 'ns02.domaincontrol.com'] : []);
      return { json: { Status: opts.dnsStatus ?? 0, Answer: ns.map((n) => ({ name: `${owner}.`, type: 2, data: `${n}.`, TTL: 600 })) } };
    }],
    ['GET', `${API}/domain-names`, () => ({ status: opts.authStatus ?? 200, json: { items: [], links: [], message: TOKEN } })],
    ['GET', `${API}/zones/${zone}/dns-records`, (call) => {
      opts.onRead?.(data, ++reads);
      if (opts.readStatus) return { status: opts.readStatus, json: { message: TOKEN, details: [{ value: TOKEN }] } };
      if (opts.badPage !== undefined) return { json: opts.badPage };
      const page = Number(new URL(call.url).searchParams.get('page'));
      const more = data.length > page * 100;
      return { json: { items: data.slice((page - 1) * 100, page * 100), links: more ? [
        { rel: 'next', href: `${API}/zones/${zone}/dns-records?page=${page + 1}&pageSize=100` },
      ] : [] } };
    }],
    ['POST', `${API}/zones/${zone}/dns-records`, (call) => {
      if (opts.createStatus && !opts.lostCreate) return { status: opts.createStatus, json: { message: TOKEN } };
      const made = { ...(call.body as Omit<Record, 'recordId'>), recordId: `r${++seq}` };
      data.push(made);
      if (opts.lostCreate) return { status: 503, json: { message: TOKEN } };
      return { status: 201, json: made };
    }],
    ['PUT', new RegExp(`^${API}/zones/${zone}/dns-records/`), (call) => {
      const id = decodeURIComponent(new URL(call.url).pathname.split('/').at(-1)!);
      const index = data.findIndex((r) => r.recordId === id);
      if (index < 0) return { status: 404 };
      const changed = { ...(call.body as Omit<Record, 'recordId'>), recordId: id };
      data[index] = changed;
      return { json: changed };
    }],
    ['DELETE', new RegExp(`^${API}/zones/${zone}/dns-records/`), (call) => {
      if (opts.deleteStatus) return { status: opts.deleteStatus, json: { message: TOKEN } };
      const id = decodeURIComponent(new URL(call.url).pathname.split('/').at(-1)!);
      const index = data.findIndex((r) => r.recordId === id);
      if (index < 0) return { status: 404, json: { message: TOKEN } };
      data.splice(index, 1);
      return { status: 204 };
    }],
  ]);
  const ctx = testCtx({ tokens: { GODADDY_API_TOKEN: TOKEN }, http: async (req) => { requests.push(req); return http.http(req); } });
  return { ctx, data, calls: http.calls, requests, writes: () => http.calls.filter((c) => c.method !== 'GET') };
}
const rec = (over: Partial<Record> = {}): Record => ({ recordId: 'existing', type: 'TXT', name: '@', data: 'owner-verification', ttl: 600, ...over });

describe('GoDaddy DNS authentication', () => {
  it('explains both the gddy login and the scoped PAT when no access is configured', async () => {
    const ctx = testCtx();
    const result = await godaddyAdapter.auth(ctx);
    expect(result.ok).toBe(false);
    expect(result.howToFix).toContain('gddy auth login');
    expect(result.howToFix).toContain('GODADDY_API_TOKEN');
    expect(result.howToFix).toContain('domains.dns:update');
    expect(result.howToFix).toContain('own editor');
  });
  it('uses a read-only API call with a Secret bearer header', async () => {
    const f = fake();
    expect(await godaddyAdapter.auth(f.ctx)).toMatchObject({ ok: true });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]).toMatchObject({ method: 'GET', url: `${API}/domain-names?pageSize=1`, headers: { authorization: `Bearer ${TOKEN}` } });
    expect(f.requests[0]!.headers!.authorization).toBeInstanceOf(Secret);
    expect(f.writes()).toEqual([]);
  });
  it.each([401, 403, 429, 503])('returns safe guidance for HTTP %s without echoing provider bodies', async (authStatus) => {
    const f = fake({ authStatus });
    const result = await godaddyAdapter.auth(f.ctx);
    expect(result.ok).toBe(false);
    expect(result.howToFix).toContain(String(authStatus));
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(f.writes()).toEqual([]);
  });
});

describe('GoDaddy authoritative zone discovery', () => {
  it('finds the nearest publicly delegated parent for a subdomain, independent of registrar listing', async () => {
    const f = fake();
    expect(await godaddyDns.hosts(f.ctx, 'App.Example.Com.')).toBe(true);
    expect(f.calls.some((c) => c.url.includes('/domain-names'))).toBe(false);
    expect(f.calls.some((c) => c.url.includes('/zones/example.com/'))).toBe(true);
  });
  it('refuses GoDaddy registration when authoritative DNS is elsewhere', async () => {
    const f = fake({ nameservers: ['mike.ns.cloudflare.com', 'lara.ns.cloudflare.com'] });
    expect(await godaddyDns.hosts(f.ctx, 'example.com')).toBe(false);
    await expect(godaddyDns.upsert(f.ctx, 'example.com', cname)).rejects.toThrow(/current DNS provider/);
    expect(f.calls.some((c) => c.url.startsWith(API))).toBe(false);
    expect(f.writes()).toEqual([]);
  });
  it('refuses mixed delegation and domaincontrol lookalikes', async () => {
    for (const nameservers of [[], ['ns1.domaincontrol.com', 'ns2.other.test'], ['ns1.domaincontrol.com.evil.test', 'ns2.domaincontrol.com.evil.test']]) {
      const f = fake({ nameservers });
      expect(await godaddyDns.hosts(f.ctx, 'example.com')).toBe(false);
    }
  });
  it('does not fall back through a child delegation hosted elsewhere', async () => {
    const f = fake({ delegations: { 'sub.example.com': ['ns1.other.test', 'ns2.other.test'] } });
    expect(await godaddyDns.hosts(f.ctx, 'app.sub.example.com')).toBe(false);
    await expect(godaddyDns.upsert(f.ctx, 'example.com', { ...cname, name: 'app.sub.example.com' })).rejects.toThrow(/separately delegated/);
    expect(f.writes()).toEqual([]);
  });
  it.each(['sub.example.com', 'app.sub.example.com'])('refuses a parent-zone NS cut covering %s despite stale recursive DNS', async (target) => {
    const f = fake({ records: [rec({ name: 'sub', type: 'NS', data: 'ns.other.test' })] });
    // Public mocks have no NS answer below example.com, as during delegation propagation.
    await expect(godaddyDns.upsert(f.ctx, 'example.com', { type: 'TXT', name: target, content: 'verification' })).rejects.toThrow(/delegated/);
    expect(f.writes()).toEqual([]);
  });
  it('requires account access to the publicly delegated zone', async () => {
    const f = fake({ readStatus: 404 });
    expect(await godaddyDns.hosts(f.ctx, 'example.com')).toBe(false);
    expect(f.writes()).toEqual([]);
  });
  it.each([2, 5])('fails closed on DNS status %s even if nameservers were returned', async (dnsStatus) => {
    const f = fake({ dnsStatus });
    await expect(godaddyDns.upsert(f.ctx, 'example.com', cname)).rejects.toThrow(/inconclusive/);
    expect(f.writes()).toEqual([]);
  });
  it.each([401, 403])('fails closed on HTTP %s without response echoes', async (readStatus) => {
    const f = fake({ readStatus });
    await expect(godaddyDns.upsert(f.ctx, 'example.com', cname)).rejects.toThrow(new RegExp(`HTTP ${readStatus}`));
    try { await godaddyDns.list(f.ctx, 'example.com'); } catch (e) { expect(String(e)).not.toContain(TOKEN); }
    expect(f.writes()).toEqual([]);
  });
  it('normalizes IDN names and apex names', async () => {
    const f = fake({ zone: 'xn--bcher-kva.de' });
    expect(await godaddyDns.upsert(f.ctx, 'Bücher.DE.', { type: 'TXT', name: '@', content: 'verify' })).toBe('created');
    expect(f.data[0]).toMatchObject({ name: '@', type: 'TXT' });
    expect(await godaddyDns.list(f.ctx, 'bücher.de')).toMatchObject([{ name: 'xn--bcher-kva.de' }]);
  });
});

describe('GoDaddy DNS records', () => {
  it('lists every page and translates relative names, TXT, MX and CAA', async () => {
    const f = fake({ records: [
      ...Array.from({ length: 100 }, (_, i) => rec({ recordId: `a${i}`, name: `item${i}` })),
      rec({ recordId: 'txt', name: '_key', data: '"abc" "def"' }),
      rec({ recordId: 'mx', name: 'send', type: 'MX', data: 'MAIL.EXAMPLE.NET.', priority: 10 }),
      rec({ recordId: 'caa', name: '@', type: 'CAA', data: 'letsencrypt.org', flag: 0, tag: 'issue' }),
      rec({ recordId: 'soa', type: 'SOA', data: 'ns01.domaincontrol.com' }),
    ] });
    const listed = await godaddyDns.list(f.ctx, 'example.com');
    expect(listed).toHaveLength(103);
    expect(listed.slice(-3)).toMatchObject([
      { name: '_key.example.com', content: 'abcdef' },
      { name: 'send.example.com', content: 'mail.example.net', priority: 10 },
      { name: 'example.com', content: '0 issue "letsencrypt.org"' },
    ]);
    expect(f.calls.some((c) => c.url.endsWith('page=2&pageSize=100'))).toBe(true);
  });
  it.each([{}, { items: [], links: null }, { items: [{ name: 'missing fields' }], links: [] },
    { items: [rec()], links: [{ rel: 'next', href: 'https://evil.test/?page=2&pageSize=100' }] },
    { items: [rec()], links: [{ rel: 'next', href: `${API}/zones/example.com/dns-records?page=1&pageSize=100` }] },
  ])('refuses malformed or unsafe pagination with zero writes', async (badPage) => {
    const f = fake({ badPage });
    await expect(godaddyDns.upsert(f.ctx, 'example.com', cname)).rejects.toThrow(/response shape/);
    expect(f.writes()).toEqual([]);
    expect(f.calls.every((c) => !c.url.startsWith('https://evil.test'))).toBe(true);
  });
  it('creates one record without replacing the zone, re-running adopts it without writes', async () => {
    const original = [rec(), rec({ recordId: 'mx', type: 'MX', data: 'mail.example.net', priority: 10 })];
    const f = fake({ records: original });
    expect(await godaddyDns.upsert(f.ctx, 'example.com', cname)).toBe('created');
    expect(f.writes()).toHaveLength(1);
    expect(f.writes()[0]!.body).toEqual({ name: 'app', type: 'CNAME', data: 'cname.vercel-dns.com', ttl: 600 });
    expect(f.data.slice(0, 2)).toEqual(original);
    expect(await godaddyDns.upsert(f.ctx, 'example.com', cname)).toBe('unchanged');
    expect(f.writes()).toHaveLength(1);
    expect(JSON.stringify(f.ctx.state.get())).not.toContain('cname.vercel-dns.com');
    expect(JSON.stringify(f.ctx.state.get())).not.toContain(TOKEN);
    expect(f.ctx.logs.join('')).not.toContain(TOKEN);
    expect(f.calls.filter((c) => !c.url.startsWith(API)).every((c) => !c.headers.authorization)).toBe(true);
  });
  it('updates only a record golive created with an unchanged stored fingerprint', async () => {
    const f = fake();
    await godaddyDns.upsert(f.ctx, 'example.com', cname);
    expect(await godaddyDns.upsert(f.ctx, 'example.com', { ...cname, content: 'new.vercel-dns.com', ttl: 900 })).toBe('updated');
    expect(f.writes().map((c) => c.method)).toEqual(['POST', 'PUT']);
    expect(f.writes()[1]!.url.endsWith('/dns-records/r1')).toBe(true);
    expect(f.requests.filter((r) => r.method === 'PUT')[0]!.idempotent).toBe(false);
  });
  it('does not claim ownership of an identical pre-existing record', async () => {
    const f = fake({ records: [rec({ type: 'CNAME', name: 'app', data: cname.content })] });
    expect(await godaddyDns.upsert(f.ctx, 'example.com', cname)).toBe('unchanged');
    expect(f.ctx.state.get().resources).toEqual({});
    await expect(godaddyDns.upsert(f.ctx, 'example.com', { ...cname, content: 'other.example.net' })).rejects.toThrow(/conflict/);
    expect(f.writes()).toEqual([]);
  });
  it('refuses drift on an golive-created record', async () => {
    const f = fake();
    await godaddyDns.upsert(f.ctx, 'example.com', cname);
    f.data[0]!.data = 'human-edited.example.net';
    await expect(godaddyDns.upsert(f.ctx, 'example.com', { ...cname, content: 'new.example.net' })).rejects.toThrow(/conflict/);
    expect(f.writes()).toHaveLength(1);
  });
  it('refuses changes between the update observation and its final read', async () => {
    let intervene = false;
    let count = 0;
    const f = fake({ onRead: (records) => { if (intervene && ++count === 2) records[0]!.data = 'concurrent.example.net'; } });
    await godaddyDns.upsert(f.ctx, 'example.com', cname);
    intervene = true;
    await expect(godaddyDns.upsert(f.ctx, 'example.com', { ...cname, content: 'new.example.net' })).rejects.toThrow(/conflict/);
    expect(f.writes()).toHaveLength(1);
  });
  it('refuses an ancestor NS cut added immediately before updating an owned record', async () => {
    let intervene = false;
    let count = 0;
    const f = fake({ onRead: (records) => {
      if (intervene && ++count === 2) records.push(rec({ recordId: 'delegation', name: 'sub', type: 'NS', data: 'ns.other.test' }));
    } });
    const want = { ...cname, name: 'app.sub.example.com' };
    await godaddyDns.upsert(f.ctx, 'example.com', want);
    intervene = true;
    await expect(godaddyDns.upsert(f.ctx, 'example.com', { ...want, content: 'new.example.net' })).rejects.toThrow(/delegated/);
    expect(f.writes().map((c) => c.method)).toEqual(['POST']);
  });
  it.each(['A', 'AAAA', 'MX', 'TXT', 'NS', 'SRV', 'CAA'])('refuses CNAME next to existing %s including types outside DnsRecord', async (type) => {
    const f = fake({ records: [rec({ name: 'app', type, ...(type === 'MX' ? { priority: 10 } : {}), ...(type === 'CAA' ? { flag: 0, tag: 'issue' } : {}) })] });
    await expect(godaddyDns.upsert(f.ctx, 'example.com', cname)).rejects.toThrow(/conflict/);
    expect(f.writes()).toEqual([]);
  });
  it('refuses TXT next to a CNAME', async () => {
    const f = fake({ records: [rec({ name: 'send', type: 'CNAME', data: 'some.example.net' })] });
    await expect(godaddyDns.upsert(f.ctx, 'example.com', { type: 'TXT', name: 'send.example.com', content: 'verify' })).rejects.toThrow(/conflict/);
    expect(f.writes()).toEqual([]);
  });
  it('preserves unrelated TXT and MX values at the same name', async () => {
    const old = [rec(), rec({ recordId: 'mx', type: 'MX', data: 'old.example.net', priority: 20 })];
    const f = fake({ records: old });
    await godaddyDns.upsert(f.ctx, 'example.com', { type: 'TXT', name: 'example.com', content: 'another-verification' });
    await godaddyDns.upsert(f.ctx, 'example.com', { type: 'MX', name: 'example.com', content: 'new.example.net', priority: 10 });
    expect(f.data.slice(0, 2)).toEqual(old);
    expect(f.data).toHaveLength(4);
  });
  it('does not duplicate an existing SPF sender or overwrite an unrelated SPF policy', async () => {
    const f = fake({ records: [rec({ data: 'v=spf1 include:other.test include:amazonses.com -all' })] });
    const want: DnsRecord = { type: 'TXT', name: 'example.com', content: 'v=spf1 include:amazonses.com ~all' };
    expect(await godaddyDns.upsert(f.ctx, 'example.com', want)).toBe('unchanged');
    await expect(godaddyDns.upsert(f.ctx, 'example.com', { ...want, content: 'v=spf1 include:new.test ~all' })).rejects.toThrow(/conflict/);
    expect(f.writes()).toEqual([]);
  });
  it('rejects duplicate SPF or address records even when one exactly matches', async () => {
    const cases: [Record[], DnsRecord][] = [
      [[rec({ type: 'A', name: 'app', data: '192.0.2.1' }), rec({ recordId: 'other', type: 'A', name: 'app', data: '192.0.2.2' })],
        { type: 'A', name: 'app.example.com', content: '192.0.2.1' }],
      [[rec({ data: 'v=spf1 include:amazonses.com ~all' }), rec({ recordId: 'other', data: 'v=spf1 include:other.test -all' })],
        { type: 'TXT', name: 'example.com', content: 'v=spf1 include:amazonses.com ~all' }],
    ];
    for (const [records, want] of cases) {
      const f = fake({ records });
      await expect(godaddyDns.upsert(f.ctx, 'example.com', want)).rejects.toThrow(/conflict/);
      expect(f.writes()).toEqual([]);
    }
  });
  it('merges an golive-created SPF policy without dropping its existing sender', async () => {
    const f = fake();
    const want: DnsRecord = { type: 'TXT', name: 'send.example.com', content: 'v=spf1 include:amazonses.com ~all' };
    await godaddyDns.upsert(f.ctx, 'example.com', want);
    expect(await godaddyDns.upsert(f.ctx, 'example.com', { ...want, content: 'v=spf1 include:another.test ~all' })).toBe('updated');
    expect(f.data[0]!.data).toBe('v=spf1 include:amazonses.com include:another.test ~all');
  });
  it('rejects unmanaged DKIM or return-path replacements rather than creating conflicting duplicates', async () => {
    const cases: [Record, DnsRecord][] = [
      [rec({ name: 'resend._domainkey', data: 'p=old' }), { type: 'TXT', name: 'resend._domainkey.example.com', content: 'p=new' }],
      [rec({ name: 'send', type: 'MX', data: 'feedback-smtp.us-east-1.amazonses.com', priority: 10 }),
        { type: 'MX', name: 'send.example.com', content: 'feedback-smtp.eu-west-1.amazonses.com', priority: 10 }],
    ];
    for (const [existing, want] of cases) {
      const f = fake({ records: [existing] });
      await expect(godaddyDns.upsert(f.ctx, 'example.com', want)).rejects.toThrow(/conflict/);
      expect(f.writes()).toEqual([]);
    }
  });
  it('recovers a lost POST response by reading once, never creating a duplicate or claiming ownership', async () => {
    const f = fake({ lostCreate: true });
    expect(await godaddyDns.upsert(f.ctx, 'example.com', cname)).toBe('unchanged');
    expect(f.writes()).toHaveLength(1);
    expect(f.data).toHaveLength(1);
    expect(f.ctx.state.get().resources).toEqual({});
  });
  it.each([401, 403])('does not retry or hide a refused POST (HTTP %s)', async (createStatus) => {
    const f = fake({ createStatus });
    await expect(godaddyDns.upsert(f.ctx, 'example.com', cname)).rejects.toThrow(new RegExp(`HTTP ${createStatus}`));
    expect(f.writes()).toHaveLength(1);
    expect(f.data).toEqual([]);
  });
  it.each([
    { ...cname, name: 'other.test' }, { ...cname, name: 'example.com' }, { ...cname, proxied: true },
    { ...cname, ttl: 300 }, { ...cname, name: 'http://example.com/path' },
    { type: 'A', name: 'example.com', content: 'not-an-ip' },
  ] as DnsRecord[])('rejects an invalid record before any write', async (want) => {
    const f = fake();
    await expect(godaddyDns.upsert(f.ctx, 'example.com', want)).rejects.toThrow();
    expect(f.writes()).toEqual([]);
  });
  it('uses the documented CAA shape and MX defaults', async () => {
    const f = fake();
    await godaddyDns.upsert(f.ctx, 'example.com', { type: 'CAA', name: 'example.com', content: '0 issue "letsencrypt.org"' });
    await godaddyDns.upsert(f.ctx, 'example.com', { type: 'MX', name: 'send.example.com', content: 'MAIL.EXAMPLE.NET.', ttl: 1 });
    expect(f.data).toMatchObject([
      { type: 'CAA', data: 'letsencrypt.org', flag: 0, tag: 'issue' },
      { type: 'MX', name: 'send', data: 'mail.example.net', ttl: 600, priority: 10 },
    ]);
  });
  it('preserves case-sensitive CAA URI values instead of treating them as equal', async () => {
    const f = fake({ records: [rec({ type: 'CAA', data: 'https://example.net/Report', flag: 0, tag: 'iodef' })] });
    expect(await godaddyDns.upsert(f.ctx, 'example.com', { type: 'CAA', name: 'example.com', content: '0 iodef "https://example.net/report"' })).toBe('created');
    expect(f.data.map((r) => r.data)).toEqual(['https://example.net/Report', 'https://example.net/report']);
  });
});

describe('GoDaddy DNS ownership (listOwned / remove)', () => {
  const fingerprintKey = (id: string) => `godaddy.recordFingerprint:example.com:${id}`;
  /** The value the adapter stores for a record it wrote (see remember()). */
  const snapshotOf = (r: unknown) => fingerprint(JSON.stringify(r));

  it('listOwned returns only fingerprint-owned records of supported types', async () => {
    // Shaped and ordered like the records the adapter parses, so the fingerprints below are the real ones.
    const nsRow = { recordId: 'ns1', name: 'sub', type: 'NS', data: 'ns.other.test', ttl: 600 };
    const txtRow = { recordId: 't1', name: '@', type: 'TXT', data: 'owned-verification', ttl: 600 };
    const f = fake({ records: [nsRow, txtRow, rec({ recordId: 'foreign', data: 'human-edited' })] });
    f.ctx.state.save((s) => {
      s.resources[fingerprintKey('ns1')] = snapshotOf(f.data[0]!);
      s.resources[fingerprintKey('t1')] = snapshotOf(f.data[1]!);
    });
    expect(await godaddyDns.listOwned!(f.ctx, 'example.com')).toEqual([
      { type: 'TXT', name: 'example.com', content: 'owned-verification', ttl: 600, proxied: false },
    ]);
    expect(f.writes()).toEqual([]);
  });

  it('remove deletes the owned record by ID over REST and forgets its fingerprint', async () => {
    const f = fake();
    expect(await godaddyDns.upsert(f.ctx, 'example.com', cname)).toBe('created');
    expect(f.ctx.state.resource(fingerprintKey('r1'))).toBeDefined();
    expect(await godaddyDns.remove!(f.ctx, 'example.com', cname)).toBe('removed');
    const deletes = f.calls.filter((c) => c.method === 'DELETE');
    expect(deletes).toHaveLength(1);
    expect(deletes[0]!.url).toBe(`${API}/zones/example.com/dns-records/r1`);
    expect(f.data).toEqual([]);
    expect(f.ctx.state.resource(fingerprintKey('r1'))).toBeUndefined();
    expect(await godaddyDns.remove!(f.ctx, 'example.com', cname)).toBe('unchanged');
    expect(f.calls.filter((c) => c.method === 'DELETE')).toHaveLength(1);
  });

  it('remove refuses an identical record golive did not create', async () => {
    const f = fake({ records: [rec({ recordId: 'foreign', type: 'CNAME', name: 'app', data: 'cname.vercel-dns.com' })] });
    await expect(godaddyDns.remove!(f.ctx, 'example.com', cname)).rejects.toThrow(/golive did not create it/);
    await expect(godaddyDns.remove!(f.ctx, 'example.com', cname)).rejects.toThrow(/app\.example\.com/);
    expect(f.writes()).toEqual([]);
    expect(f.data).toHaveLength(1);
  });

  it('remove is unchanged when nothing matches, and treats a 404 as already gone', async () => {
    const empty = fake();
    expect(await godaddyDns.remove!(empty.ctx, 'example.com', cname)).toBe('unchanged');
    expect(empty.writes()).toEqual([]);

    const gone = fake({ deleteStatus: 404 });
    await godaddyDns.upsert(gone.ctx, 'example.com', cname);
    expect(await godaddyDns.remove!(gone.ctx, 'example.com', cname)).toBe('unchanged');
    expect(gone.calls.filter((c) => c.method === 'DELETE')).toHaveLength(1);
    expect(gone.data).toHaveLength(1);
  });

  it('remove refuses an ambiguous match instead of guessing which duplicate to delete', async () => {
    const f = fake();
    await godaddyDns.upsert(f.ctx, 'example.com', cname);
    f.data.push({ recordId: 'dup', type: 'CNAME', name: 'app', data: 'cname.vercel-dns.com', ttl: 600 });
    await expect(godaddyDns.remove!(f.ctx, 'example.com', cname)).rejects.toThrow(/2 identical CNAME records/);
    expect(f.calls.filter((c) => c.method === 'DELETE')).toEqual([]);
    expect(f.data).toHaveLength(2);
  });

  it('matches an MX only when the priority is equal too', async () => {
    const f = fake();
    const mx: DnsRecord = { type: 'MX', name: 'send.example.com', content: 'feedback-smtp.us-east-1.amazonses.com', priority: 10 };
    expect(await godaddyDns.upsert(f.ctx, 'example.com', mx)).toBe('created');
    expect(await godaddyDns.remove!(f.ctx, 'example.com', { ...mx, priority: 20 })).toBe('unchanged');
    expect(f.calls.filter((c) => c.method === 'DELETE')).toEqual([]);
    expect(await godaddyDns.remove!(f.ctx, 'example.com', mx)).toBe('removed');
    expect(f.data).toEqual([]);
  });
});

describe('GoDaddy CLI (gddy) transport', () => {
  const version = (v: string) => ({ stdout: `gddy version ${v} (commit test, built 2026-09-18)\n` });
  const session = (over: { [key: string]: unknown } = {}) => ({
    stdout: JSON.stringify({
      data: [
        { env: 'ote', expired: true, expires_at: '', identity: '', refreshable: false, scopes: [] },
        { env: 'prod', expired: false, expires_at: new Date(Date.now() + 3_600_000).toISOString(), identity: 'customer:test-id', refreshable: true, scopes: ['domains.domain:read'], ...over },
      ],
    }),
  });
  const envelope = (data: unknown, status = 200) => ({ stdout: JSON.stringify({ data: { data, endpoint: '/x', method: 'GET', status, status_text: status === 200 ? 'OK' : 'ERR' } }) });
  const doh = () => mockHttp([
    ['GET', /dns-query/, (call) => {
      const owner = new URL(call.url).searchParams.get('name')!;
      const ns = owner === 'example.com' ? ['ns01.domaincontrol.com', 'ns02.domaincontrol.com'] : [];
      return { json: { Status: ns.length ? 0 : 3, Answer: ns.map((n) => ({ name: `${owner}.`, type: 2, data: `${n}.`, TTL: 600 })) } };
    }],
  ]);

  it('prefers an authenticated gddy session over the PAT and never sends the token through the CLI', async () => {
    const exec = mockExec([
      ['gddy --version', () => version('0.2.20')],
      ['gddy auth status', () => session()],
      [new RegExp('^gddy api call '), () => envelope({ items: [], links: [] })],
    ]);
    const ctx = testCtx({ tokens: { GODADDY_API_TOKEN: TOKEN }, exec: exec.run });
    const status = await godaddyAdapter.auth(ctx);
    expect(status).toMatchObject({ ok: true });
    expect(status.via).toContain('gddy 0.2.20');
    expect(status.via).toContain('customer:test-id');
    const calls = exec.calls.filter((c) => c.args[0] === 'api');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ cmd: 'gddy' });
    expect(calls[0]!.args).toEqual(['api', 'call', '/v3/domains/domain-names?pageSize=1', '-X', 'GET', '-o', 'json']);
    expect(JSON.stringify(exec.calls)).not.toContain(TOKEN);
  });

  it('lists and creates records through gddy api call with the same bodies as the REST path', async () => {
    const made = { name: 'app', type: 'CNAME', data: 'cname.vercel-dns.com', ttl: 600, recordId: 'r-cli-1' };
    const exec = mockExec([
      ['gddy --version', () => version('0.2.21')],
      ['gddy auth status', () => session()],
      [new RegExp('^gddy api call '), (c) => (c.args.includes('POST') ? envelope(made, 201) : envelope({ items: [], links: [] }))],
    ]);
    const ctx = testCtx({ tokens: { GODADDY_API_TOKEN: TOKEN }, exec: exec.run, http: doh().http });
    expect(await godaddyDns.upsert(ctx, 'example.com', cname)).toBe('created');
    const apiCalls = exec.calls.filter((c) => c.args[0] === 'api');
    expect(apiCalls.map((c) => c.args[2])).toEqual([
      '/v3/domains/zones/example.com/dns-records?page=1&pageSize=100',
      '/v3/domains/zones/example.com/dns-records',
    ]);
    expect(apiCalls[1]!.args).toEqual([
      'api', 'call', '/v3/domains/zones/example.com/dns-records', '-X', 'POST', '-o', 'json', '-d',
      JSON.stringify({ name: 'app', type: 'CNAME', data: 'cname.vercel-dns.com', ttl: 600 }),
    ]);
  });

  it('removes an owned record through gddy api call with -X DELETE', async () => {
    const made = { name: 'app', type: 'CNAME', data: 'cname.vercel-dns.com', ttl: 600, recordId: 'r-cli-1' };
    let lists = 0;
    const exec = mockExec([
      ['gddy --version', () => version('0.2.21')],
      ['gddy auth status', () => session()],
      [new RegExp('^gddy api call '), (c) => (c.args.includes('POST') ? envelope(made, 201) : c.args.includes('DELETE') ? envelope(null, 204) : envelope(++lists === 1 ? { items: [], links: [] } : { items: [made], links: [] }))],
    ]);
    const ctx = testCtx({ tokens: { GODADDY_API_TOKEN: TOKEN }, exec: exec.run, http: doh().http });
    expect(await godaddyDns.upsert(ctx, 'example.com', cname)).toBe('created');
    expect(await godaddyDns.remove!(ctx, 'example.com', cname)).toBe('removed');
    const deletion = exec.calls.filter((c) => c.args[0] === 'api').at(-1)!;
    expect(deletion.args).toEqual(['api', 'call', '/v3/domains/zones/example.com/dns-records/r-cli-1', '-X', 'DELETE', '-o', 'json']);
    expect(JSON.stringify(exec.calls)).not.toContain(TOKEN);
  });

  it('falls back to the PAT when the cached CLI session is expired', async () => {
    const exec = mockExec([
      ['gddy --version', () => version('0.2.20')],
      ['gddy auth status', () => session({ expired: true })],
    ]);
    const http = mockHttp([['GET', `${API}/domain-names`, () => ({ json: { items: [], links: [] } })]]);
    const status = await godaddyAdapter.auth(testCtx({ tokens: { GODADDY_API_TOKEN: TOKEN }, exec: exec.run, http: http.http }));
    expect(status).toMatchObject({ ok: true });
    expect(status.via).toContain('Personal Access Token');
    expect(exec.calls.filter((c) => c.args[0] === 'api')).toHaveLength(0);
    expect(http.calls).toHaveLength(1); // the REST probe ran instead
  });

  it('ignores an outdated gddy and uses the PAT', async () => {
    const exec = mockExec([['gddy --version', () => version('0.2.19')]]);
    const http = mockHttp([['GET', `${API}/domain-names`, () => ({ json: { items: [], links: [] } })]]);
    const status = await godaddyAdapter.auth(testCtx({ tokens: { GODADDY_API_TOKEN: TOKEN }, exec: exec.run, http: http.http }));
    expect(status.via).toContain('Personal Access Token');
    expect(exec.calls.some((c) => c.args[0] === 'auth')).toBe(false); // never probed an unsupported version's session
  });

  it('maps CLI-reported HTTP errors to the same guidance without echoing provider bodies', async () => {
    const exec = mockExec([
      ['gddy --version', () => version('0.2.20')],
      ['gddy auth status', () => session()],
      [new RegExp('^gddy api call '), () => ({
        code: 4,
        stdout: JSON.stringify({
          error: { code: 'NOT_FOUND', message: 'HTTP error 404: Not Found\n{"correlationId":"x","message":"zone not found","name":"ZONE_NOT_FOUND"}', system: 'api' },
          fix: 'inspect the path',
        }),
      })],
    ]);
    const result = await godaddyAdapter.auth(testCtx({ exec: exec.run }));
    expect(result.ok).toBe(false);
    expect(result.howToFix).toContain('HTTP 404');
    expect(result.howToFix).not.toContain('zone not found');
    expect(result.howToFix).not.toContain('correlationId');
  });

  it('treats an unparseable CLI failure as ambiguous and does not retry it', async () => {
    const exec = mockExec([
      ['gddy --version', () => version('0.2.20')],
      ['gddy auth status', () => session()],
      [new RegExp('^gddy api call '), () => ({ code: 1, stdout: 'not json', stderr: 'boom' })],
    ]);
    const result = await godaddyAdapter.auth(testCtx({ exec: exec.run }));
    expect(result.ok).toBe(false);
    expect(result.howToFix).toContain('did not complete');
    expect(exec.calls.filter((c) => c.args[0] === 'api')).toHaveLength(1);
  });

  it('points a CLI 403 at the scope step-up instead of the PAT wording', async () => {
    const exec = mockExec([
      ['gddy --version', () => version('0.2.20')],
      ['gddy auth status', () => session()],
      [new RegExp('^gddy api call '), () => ({ code: 4, stdout: JSON.stringify({ error: { code: 'FORBIDDEN', message: 'HTTP error 403: Forbidden' }, fix: 'x' }) })],
    ]);
    const result = await godaddyAdapter.auth(testCtx({ exec: exec.run }));
    expect(result.ok).toBe(false);
    expect(result.howToFix).toContain('HTTP 403');
    expect(result.howToFix).toContain('gddy auth login -s domains.dns:update');
  });
});
