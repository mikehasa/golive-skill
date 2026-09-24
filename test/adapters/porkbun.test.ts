import { beforeEach, describe, expect, it } from 'vitest';
import { porkbunAdapter, porkbunDns } from '../../src/adapters/porkbun.js';
import { Secret, _resetSecretRegistry } from '../../src/core/secret.js';
import { HttpError } from '../../src/core/http.js';
import type { DnsRecord, Http, HttpRequest } from '../../src/core/types.js';
import { mockHttp, testCtx } from '../helpers.js';

const API = 'https://api.porkbun.com/api/json/v3';
const API_KEY = 'pk1_' + 'FAKEporkbunPublicKey0123456789';
const SECRET_KEY = 'sk1_' + 'FAKEporkbunSecretKey0123456789';
const TOKENS = { PORKBUN_API_KEY: API_KEY, PORKBUN_SECRET_API_KEY: SECRET_KEY };
const NS = ['maceio.ns.porkbun.com', 'curitiba.ns.porkbun.com'];
interface Row { id: string; name: string; type: string; content: string; ttl?: string; prio?: string | null; notes?: string | null }
const a = (over: Partial<Row> = {}): Row => ({ id: '1', name: 'www.example.com', type: 'A', content: '192.0.2.1', ttl: '600', prio: null, ...over });
const want = (over: Partial<DnsRecord> = {}): DnsRecord => ({ type: 'A', name: 'www.example.com', content: '192.0.2.2', ...over });

function fake(opts: {
  zone?: string; rows?: Row[]; present?: boolean; apiAccess?: number; notLocal?: number;
  ns?: string[]; publicNs?: string[]; childNs?: Record<string, string[]>; dnsStatus?: Record<string, number>;
  credentialsValid?: boolean; failure?: { status: number; json: unknown }; warnings?: string[];
  recordResponse?: unknown; createResponse?: unknown; duplicate?: boolean; sandbox?: boolean;
  writeError?: 'timeout' | 'server'; saveBeforeError?: boolean;
} = {}) {
  const zone = opts.zone ?? 'example.com';
  const rows = structuredClone(opts.rows ?? []);
  let nextId = 100;
  const requestObjects: HttpRequest[] = [];
  const m = mockHttp([
    ['GET', `${API}/ping`, () => opts.failure ?? { json: { status: 'SUCCESS', credentialsValid: opts.credentialsValid ?? true, sandbox: opts.sandbox ?? false } }],
    ['GET', `${API}/domain/listAll`, (c) => opts.failure ?? { json: { status: 'SUCCESS', domains: new URL(c.url).searchParams.get('domain') === zone && opts.present !== false ? [{ domain: zone, apiAccess: opts.apiAccess ?? 1, notLocal: opts.notLocal ?? 0 }] : [] } }],
    ['GET', `${API}/domain/getNs/${zone}`, () => ({ json: { status: 'SUCCESS', ns: opts.ns ?? NS } })],
    ['GET', /^https:\/\/cloudflare-dns\.com\/dns-query\?/, (c) => {
      const q = new URL(c.url).searchParams;
      const n = q.get('name')!;
      const list = n === zone ? opts.publicNs ?? opts.ns ?? NS : opts.childNs?.[n] ?? [];
      return { json: { Status: opts.dnsStatus?.[n] ?? (list.length ? 0 : 3), Answer: list.map((v) => ({ name: `${n}.`, type: 2, data: `${v}.`, TTL: 600 })) } };
    }],
    ['GET', `${API}/dns/retrieve/${zone}`, () => ({ json: opts.recordResponse ?? { status: 'SUCCESS', records: rows } })],
    ['POST', `${API}/dns/create/${zone}`, (c) => {
      const b = c.body as { name: string; type: string; content: string; ttl?: number; prio?: number; notes?: string };
      if (opts.saveBeforeError !== false) rows.push({ id: String(nextId++), name: b.name ? `${b.name}.${zone}` : zone, type: b.type, content: b.content, ttl: String(b.ttl || 600), prio: b.prio === undefined ? null : String(b.prio), notes: b.notes });
      if (opts.writeError === 'timeout') throw new HttpError('request timed out', 0, '');
      if (opts.writeError === 'server') return { status: 503, json: { status: 'ERROR' } };
      if (opts.duplicate) return { status: 400, json: { status: 'ERROR', code: 'DUPLICATE_RECORD', existingId: rows.at(-1)!.id } };
      return { json: opts.createResponse ?? { status: 'SUCCESS', id: rows.at(-1)!.id, ...(opts.warnings ? { warnings: opts.warnings } : {}) } };
    }],
    ['POST', new RegExp(`${API}/dns/edit/[^/]+/\\d+$`), (c) => {
      const row = rows.find((r) => r.id === c.url.split('/').at(-1))!;
      const b = c.body as { name: string; type: string; content: string; ttl?: number; prio?: number; notes?: string };
      row.name = b.name ? `${b.name}.${zone}` : zone;
      row.type = b.type; row.content = b.content;
      if (b.ttl !== undefined) row.ttl = String(b.ttl || 600);
      if (b.prio !== undefined) row.prio = String(b.prio);
      if (b.notes !== undefined) row.notes = b.notes;
      if (opts.writeError === 'timeout') throw new HttpError('request timed out', 0, '');
      if (opts.writeError === 'server') return { status: 503, json: { status: 'ERROR' } };
      return { json: { status: 'SUCCESS' } };
    }],
  ]);
  const http: Http = async (request) => { requestObjects.push(request); return m.http(request); };
  const ctx = testCtx({ http, tokens: TOKENS });
  return { ...m, ctx, rows, requestObjects, writes: () => m.calls.filter((c) => c.method === 'POST') };
}

beforeEach(() => _resetSecretRegistry());

describe('Porkbun authentication and transport', () => {
  it('declares only the automated DNS capability', () => {
    expect(porkbunAdapter).toMatchObject({ id: 'porkbun', axes: ['dns'], automated: true });
    expect(porkbunAdapter.capabilities.dns).toBe(porkbunDns);
  });
  it('checks both keys via GET headers, never values in output, URL, body, state or logs', async () => {
    const f = fake();
    const result = await porkbunAdapter.auth(f.ctx);
    expect(result.ok).toBe(true);
    expect(f.calls[0]).toMatchObject({ method: 'GET', headers: { 'x-api-key': API_KEY, 'x-secret-api-key': SECRET_KEY } });
    expect(f.requestObjects[0]!.headers!['X-API-Key']).toBeInstanceOf(Secret);
    expect(f.requestObjects[0]!.headers!['X-Secret-API-Key']).toBeInstanceOf(Secret);
    for (const key of [API_KEY, SECRET_KEY]) expect(JSON.stringify([result, f.calls.map((c) => ({ url: c.url, body: c.body })), f.ctx.logs, f.ctx.state.get()])).not.toContain(key);
  });
  it('accepts a SUCCESS ping without credentialsValid (the getting-started guide shape)', async () => {
    const f = fake({ failure: { status: 200, json: { status: 'SUCCESS' } } });
    expect((await porkbunAdapter.auth(f.ctx)).ok).toBe(true);
  });
  it('requires the human-edited key pair without making a request', async () => {
    const ctx = testCtx({ tokens: { PORKBUN_API_KEY: API_KEY } });
    expect(await porkbunAdapter.auth(ctx)).toMatchObject({ ok: false, howToFix: expect.stringContaining('PORKBUN_SECRET_API_KEY') });
    expect((await porkbunAdapter.auth(ctx)).howToFix).toContain('Never paste');
  });
  it('does not treat an IP-only ping or a simulated sandbox as an authenticated live account', async () => {
    expect((await porkbunAdapter.auth(fake({ credentialsValid: false }).ctx)).ok).toBe(false);
    expect((await porkbunAdapter.auth(fake({ sandbox: true }).ctx)).howToFix).toContain('sandbox');
  });
  it('reports only status/code when provider errors echo credentials or arbitrary body data', async () => {
    const f = fake({ failure: { status: 403, json: { status: 'ERROR', code: 'IP_NOT_ALLOWED', message: `${API_KEY} ${SECRET_KEY} private account data` } } });
    const result = await porkbunAdapter.auth(f.ctx);
    expect(result.howToFix).toContain('IP_NOT_ALLOWED');
    expect(result.howToFix).not.toMatch(/private account data|FAKEporkbun/);
  });
  it('rejects HTTP 200 error envelopes and malformed successful responses', async () => {
    expect((await porkbunAdapter.auth(fake({ failure: { status: 200, json: { status: 'ERROR', code: 'API_KEY_REQUIRED' } } }).ctx)).ok).toBe(false);
    expect((await porkbunAdapter.auth(fake({ failure: { status: 200, json: {} } }).ctx)).ok).toBe(false);
  });
});

describe('Porkbun DNS ownership and authority', () => {
  it('finds the registered apex for a subdomain and compares NS sets independent of order', async () => {
    const f = fake({ publicNs: [...NS].reverse() });
    expect(await porkbunDns.hosts(f.ctx, 'App.Example.COM.')).toBe(true);
    expect(f.calls.some((c) => c.url.endsWith('/domain/listAll?domain=example.com'))).toBe(true);
    expect(f.writes()).toEqual([]);
  });
  it('returns false for domains not in the account', async () => {
    const f = fake({ present: false });
    expect(await porkbunDns.hosts(f.ctx, 'example.com')).toBe(false);
  });
  it('requires per-domain API access', async () => {
    await expect(porkbunDns.hosts(fake({ apiAccess: 0 }).ctx, 'example.com')).rejects.toThrow(/Enable API Access/);
  });
  it.each([
    { notLocal: 1 }, { ns: ['ns1.other.example'] }, { publicNs: ['ns1.other.example'] }, { publicNs: [] },
  ])('refuses a registrar-owned zone that is not confirmed authoritative: %j', async (options) => {
    const f = fake(options);
    expect(await porkbunDns.hosts(f.ctx, 'example.com')).toBe(false);
    await expect(porkbunDns.upsert(f.ctx, 'example.com', want())).rejects.toThrow(/authoritative/);
    expect(f.writes()).toEqual([]);
  });
  it('refuses public child-zone delegation for both hosts and record writes', async () => {
    const f = fake({ childNs: { 'mail.example.com': ['ns.other.example'] } });
    expect(await porkbunDns.hosts(f.ctx, 'mail.example.com')).toBe(false);
    await expect(porkbunDns.upsert(f.ctx, 'example.com', want({ name: 'x.mail.example.com' }))).rejects.toThrow(/delegated child/);
    expect(f.writes()).toEqual([]);
  });
  it('does not interpret SERVFAIL on a child delegation lookup as no delegation', async () => {
    const f = fake({ dnsStatus: { 'www.example.com': 2 } });
    await expect(porkbunDns.upsert(f.ctx, 'example.com', want())).rejects.toThrow(/Cannot confirm DNS delegation/);
    expect(f.writes()).toEqual([]);
  });
  it('refuses parent-zone delegation records even while public NS caches still return empty', async () => {
    const f = fake({ rows: [a({ name: 'mail.example.com', type: 'NS', content: 'ns.other.example' })] });
    await expect(porkbunDns.upsert(f.ctx, 'example.com', want({ name: 'x.mail.example.com' }))).rejects.toThrow(/delegated child zone in the parent records/);
    expect(f.writes()).toEqual([]);
  });
  it('rejects a record outside the selected zone and invalid names without writing', async () => {
    const f = fake();
    await expect(porkbunDns.upsert(f.ctx, 'example.com', want({ name: 'example.com.other.net' }))).rejects.toThrow(/outside/);
    await expect(porkbunDns.hosts(f.ctx, 'https://example.com/path')).rejects.toThrow(/valid domain/);
    expect(f.writes()).toEqual([]);
  });
  it('rechecks authority on each upsert rather than trusting stored state', async () => {
    const options = { publicNs: [...NS] };
    const f = fake(options);
    await porkbunDns.upsert(f.ctx, 'example.com', want());
    options.publicNs = ['ns.other.example'];
    await expect(porkbunDns.upsert(f.ctx, 'example.com', want({ content: '192.0.2.3' }))).rejects.toThrow(/authoritative/);
    expect(f.writes()).toHaveLength(1);
  });
});

describe('Porkbun record normalization and writes', () => {
  it('normalizes FQDN, IDN, TXT chunks and string TTL/priority while preserving unknown record types', async () => {
    const f = fake({ zone: 'xn--bcher-kva.de', rows: [
      a({ name: 'BÜCHER.de.', type: 'MX', content: 'MAIL.example.net.', prio: '10' }),
      a({ id: '2', name: 'x.xn--bcher-kva.de', type: 'TXT', content: '"first " "second"' }),
      a({ id: '3', name: '_srv.xn--bcher-kva.de', type: 'SRV', content: '10 443 example.net' }),
    ] });
    expect(await porkbunDns.list(f.ctx, 'BÜCHER.de.')).toEqual([
      { type: 'MX', name: 'xn--bcher-kva.de', content: 'mail.example.net', ttl: 600, priority: 10, proxied: false },
      { type: 'TXT', name: 'x.xn--bcher-kva.de', content: 'first second', ttl: 600, priority: undefined, proxied: false },
    ]);
    expect(f.rows).toHaveLength(3);
  });
  it('creates with relative name/blank apex, owner notes, headers and an idempotency key; rerun makes no duplicate', async () => {
    const f = fake();
    expect(await porkbunDns.upsert(f.ctx, 'example.com', want())).toBe('created');
    expect(f.writes()[0]!.body).toEqual({ name: 'www', type: 'A', content: '192.0.2.2', notes: 'golive: managed' });
    expect(f.writes()[0]!.headers['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/);
    expect(await porkbunDns.upsert(f.ctx, 'example.com', want())).toBe('unchanged');
    expect(await porkbunDns.upsert(f.ctx, 'example.com', want({ name: 'example.com' }))).toBe('created');
    expect((f.writes()[1]!.body as { name: string }).name).toBe('');
    expect(f.writes()).toHaveLength(2);
    expect(f.ctx.logs.join(' ')).not.toContain('FAKEporkbun');
  });
  it('uses relative wildcard and IDN names', async () => {
    const f = fake({ zone: 'xn--bcher-kva.de' });
    await porkbunDns.upsert(f.ctx, 'bücher.de', want({ name: '*.BÜCHER.de.' }));
    expect((f.writes()[0]!.body as { name: string }).name).toBe('*');
  });
  it('uses a fresh idempotency key when the same record must be recreated after deletion', async () => {
    const f = fake();
    await porkbunDns.upsert(f.ctx, 'example.com', want());
    f.rows.splice(0);
    await porkbunDns.upsert(f.ctx, 'example.com', want());
    expect(f.writes()).toHaveLength(2);
    expect(f.writes()[1]!.headers['idempotency-key']).not.toBe(f.writes()[0]!.headers['idempotency-key']);
    expect(f.rows).toHaveLength(1);
  });
  it('edits one owned address record by ID and preserves notes and unrelated rows', async () => {
    const f = fake({ rows: [a({ notes: 'golive: managed owner detail' }), a({ id: '2', type: 'TXT', content: 'keep-this' })] });
    expect(await porkbunDns.upsert(f.ctx, 'example.com', want())).toBe('updated');
    expect(f.writes()[0]!.url).toBe(`${API}/dns/edit/example.com/1`);
    expect(f.writes()[0]!.body).toHaveProperty('notes', 'golive: managed owner detail');
    expect(f.rows[0]!.notes).toBe('golive: managed owner detail');
    expect(f.rows[1]!.content).toBe('keep-this');
  });
  it.each([
    [a()],
    [a({ notes: 'golive:' }), a({ id: '2', content: '192.0.2.9', notes: 'golive:' })],
  ])('refuses foreign or ambiguous address conflicts', async (...rows) => {
    const f = fake({ rows });
    await expect(porkbunDns.upsert(f.ctx, 'example.com', want())).rejects.toThrow(/conflict/);
    expect(f.writes()).toEqual([]);
  });
  it.each([
    { row: a({ type: 'TXT', content: 'keep' }), wanted: want({ type: 'CNAME', content: 'host.example.net' }) },
    { row: a({ type: 'CNAME', content: 'old.example.net', notes: 'golive:' }), wanted: want({ type: 'TXT', content: 'verification' }) },
    { row: a({ type: 'ALIAS', content: 'old.example.net', notes: 'golive:' }), wanted: want() },
  ])('refuses CNAME/ALIAS clashes without deleting records', async ({ row, wanted }) => {
    const f = fake({ rows: [row] });
    await expect(porkbunDns.upsert(f.ctx, 'example.com', wanted)).rejects.toThrow(/conflict/);
    expect(f.writes()).toEqual([]);
  });
  it('refuses apex CNAME and proxy enablement', async () => {
    const f = fake();
    await expect(porkbunDns.upsert(f.ctx, 'example.com', want({ type: 'CNAME', name: 'example.com', content: 'host.example.net' }))).rejects.toThrow(/apex CNAME/);
    await expect(porkbunDns.upsert(f.ctx, 'example.com', want({ proxied: true }))).rejects.toThrow(/proxy/);
    expect(f.writes()).toEqual([]);
  });
  it('adds unrelated TXT/MX/CAA values without replacing existing ones', async () => {
    const f = fake({ rows: [a({ type: 'TXT', content: 'existing' }), a({ id: '2', type: 'MX', content: 'old.mail.net', prio: '5' }), a({ id: '3', type: 'CAA', content: '0 issue "old.example"' })] });
    for (const record of [want({ type: 'TXT', content: 'new-verification' }), want({ type: 'MX', content: 'new.mail.net', priority: 20 }), want({ type: 'CAA', content: '0 issue "new.example"' })]) {
      expect(await porkbunDns.upsert(f.ctx, 'example.com', record)).toBe('created');
    }
    expect(f.rows).toHaveLength(6);
    expect(f.rows.slice(0, 3).map((r) => r.content)).toEqual(['existing', 'old.mail.net', '0 issue "old.example"']);
  });
  it('merges SPF into one record while retaining the owner policy and notes', async () => {
    const f = fake({ rows: [a({ type: 'TXT', content: '"v=spf1 include:old.example -all"', notes: 'owner mail policy' })] });
    const record = want({ type: 'TXT', content: 'v=spf1 include:new.example ~all' });
    expect(await porkbunDns.upsert(f.ctx, 'example.com', record)).toBe('updated');
    expect(f.rows[0]!.content).toBe('v=spf1 include:old.example include:new.example -all');
    expect(f.rows[0]!.notes).toBe('owner mail policy');
    expect(await porkbunDns.upsert(f.ctx, 'example.com', record)).toBe('unchanged');
    expect(f.writes()).toHaveLength(1);
  });
  it('refuses multiple SPF records and non-pass qualifiers', async () => {
    const f = fake({ rows: [a({ type: 'TXT', content: 'v=spf1 include:old.example -all' }), a({ id: '2', type: 'TXT', content: 'v=spf1 -all' })] });
    await expect(porkbunDns.upsert(f.ctx, 'example.com', want({ type: 'TXT', content: 'v=spf1 include:new.example ~all' }))).rejects.toThrow(/multiple SPF/);
    const g = fake({ rows: [a({ type: 'TXT', content: 'v=spf1 -include:new.example -all' })] });
    await expect(porkbunDns.upsert(g.ctx, 'example.com', want({ type: 'TXT', content: 'v=spf1 include:new.example ~all' }))).rejects.toThrow(/non-pass/);
    expect([...f.writes(), ...g.writes()]).toEqual([]);
  });
  it('updates an owned DKIM selector but refuses a foreign one', async () => {
    const record = want({ type: 'TXT', name: 'resend._domainkey.example.com', content: 'p=newPublicKey' });
    const f = fake({ rows: [a({ type: 'TXT', name: record.name, content: 'p=oldPublicKey', notes: 'golive: managed' })] });
    expect(await porkbunDns.upsert(f.ctx, 'example.com', record)).toBe('updated');
    const g = fake({ rows: [a({ type: 'TXT', name: record.name, content: 'p=oldPublicKey' })] });
    await expect(porkbunDns.upsert(g.ctx, 'example.com', record)).rejects.toThrow(/conflict/);
    expect(g.writes()).toEqual([]);
  });
  it('updates an owned return-path MX but never overwrites an unrelated mail exchanger', async () => {
    const record = want({ type: 'MX', name: 'send.example.com', content: 'feedback-smtp.us-east-1.amazonses.com', priority: 10 });
    const f = fake({ rows: [a({ type: 'MX', name: record.name, content: 'feedback-smtp.eu-west-1.amazonses.com', prio: '10', notes: 'golive:' })] });
    expect(await porkbunDns.upsert(f.ctx, 'example.com', record)).toBe('updated');
    const g = fake({ rows: [a({ type: 'MX', name: record.name, content: 'mail.other.net', notes: 'golive:' })] });
    await expect(porkbunDns.upsert(g.ctx, 'example.com', record)).rejects.toThrow(/conflict/);
    expect(g.writes()).toEqual([]);
  });
  it('repairs priority drift only on an owned matching MX', async () => {
    const record = want({ type: 'MX', content: 'mail.example.net', priority: 10 });
    const f = fake({ rows: [a({ type: 'MX', content: record.content, prio: '5', notes: 'golive:' })] });
    expect(await porkbunDns.upsert(f.ctx, 'example.com', record)).toBe('updated');
    const g = fake({ rows: [a({ type: 'MX', content: record.content, prio: '5' })] });
    await expect(porkbunDns.upsert(g.ctx, 'example.com', record)).rejects.toThrow(/conflict/);
    expect(g.writes()).toEqual([]);
  });
  it('uses priority10 when a requested MX omits priority, for matching and creation', async () => {
    const record = want({ type: 'MX', content: 'mail.example.net' });
    const f = fake({ rows: [a({ type: 'MX', content: record.content, prio: '5' })] });
    await expect(porkbunDns.upsert(f.ctx, 'example.com', record)).rejects.toThrow(/conflict/);
    expect(f.writes()).toEqual([]);
    const g = fake();
    expect(await porkbunDns.upsert(g.ctx, 'example.com', record)).toBe('created');
    expect(g.writes()[0]!.body).toHaveProperty('prio', 10);
    expect(await porkbunDns.upsert(g.ctx, 'example.com', record)).toBe('unchanged');
  });
  it('maps automatic TTL1 to Porkbun default0 and does not continually rewrite it', async () => {
    const f = fake();
    expect(await porkbunDns.upsert(f.ctx, 'example.com', want({ ttl: 1 }))).toBe('created');
    expect(f.writes()[0]!.body).toHaveProperty('ttl', 0);
    expect(await porkbunDns.upsert(f.ctx, 'example.com', want({ ttl: 1 }))).toBe('unchanged');
    expect(f.writes()).toHaveLength(1);
  });
  it('adopts a duplicate response only after re-reading the actual matching record', async () => {
    const f = fake({ duplicate: true });
    expect(await porkbunDns.upsert(f.ctx, 'example.com', want())).toBe('unchanged');
    expect(f.calls.filter((c) => c.url === `${API}/dns/retrieve/example.com`)).toHaveLength(2);
  });
  it.each(['timeout', 'server'] as const)('reconciles an ambiguous %s create with a fresh read, without another write', async (writeError) => {
    const f = fake({ writeError });
    expect(await porkbunDns.upsert(f.ctx, 'example.com', want())).toBe('unchanged');
    expect(f.calls.filter((c) => c.url === `${API}/dns/retrieve/example.com`)).toHaveLength(2);
    expect(f.writes()).toHaveLength(1);
  });
  it('does not claim an ambiguous unsaved create succeeded', async () => {
    const f = fake({ writeError: 'timeout', saveBeforeError: false });
    await expect(porkbunDns.upsert(f.ctx, 'example.com', want())).rejects.toThrow(/timed out/);
    expect(f.writes()).toHaveLength(1);
    expect(f.ctx.logs).toEqual([]);
  });
  it('reconciles an ambiguous edit by record ID, value, TTL and preserved notes', async () => {
    const f = fake({ rows: [a({ notes: 'golive: managed' })], writeError: 'timeout' });
    expect(await porkbunDns.upsert(f.ctx, 'example.com', want())).toBe('updated');
    expect(f.calls.filter((c) => c.url === `${API}/dns/retrieve/example.com`)).toHaveLength(2);
    expect(f.writes()).toHaveLength(1);
  });
  it('refuses a success-with-warning rather than claim live DNS changed', async () => {
    const f = fake({ warnings: ['saved in a non-authoritative zone'] });
    await expect(porkbunDns.upsert(f.ctx, 'example.com', want())).rejects.toThrow(/write may already have been saved/);
    expect(f.ctx.logs).toEqual([]);
  });
  it('refuses malformed record responses, and confirms or refuses a create whose response carries no id', async () => {
    await expect(porkbunDns.list(fake({ recordResponse: { status: 'SUCCESS', records: [{}] } }).ctx, 'example.com')).rejects.toThrow(/record shape/);
    await expect(porkbunDns.list(fake({ recordResponse: { status: 'SUCCESS' } }).ctx, 'example.com')).rejects.toThrow(/record list/);
    // Never blind-retry the POST: an unparsed id is settled by re-reading the zone.
    const confirmed = fake({ createResponse: { status: 'SUCCESS' } }); // the fake stored the row the POST carried
    expect(await porkbunDns.upsert(confirmed.ctx, 'example.com', want())).toBe('created');
    expect(confirmed.writes()).toHaveLength(1);
    expect(confirmed.calls.filter((c) => c.url === `${API}/dns/retrieve/example.com`)).toHaveLength(2); // the confirmation read
    const unconfirmed = fake({ createResponse: { status: 'SUCCESS' }, saveBeforeError: false });
    await expect(porkbunDns.upsert(unconfirmed.ctx, 'example.com', want())).rejects.toThrow(/could not be confirmed/);
    expect(unconfirmed.writes()).toHaveLength(1);
  });

  it('accepts a numeric id, which the live API returned where the documented mock shows a digit string', async () => {
    const f = fake({ createResponse: { status: 'SUCCESS', id: 253333167 } });
    expect(await porkbunDns.upsert(f.ctx, 'example.com', want())).toBe('created');
    expect(f.calls.filter((c) => c.url === `${API}/dns/retrieve/example.com`)).toHaveLength(1); // no extra read needed
  });
});
