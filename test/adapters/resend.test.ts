import { describe, it, expect, beforeEach } from 'vitest';
import { resendAdapter, mapDomainStatus, keyName } from '../../src/adapters/resend.js';
import { normalizeRecords, fqdnFor } from '../../src/adapters/resend-records.js';
import { _resetSecretRegistry, Secret, vaultGet } from '../../src/core/secret.js';
import { mockExec, mockHttp, testCtx, type HttpCall } from '../helpers.js';
import { credentialsPath, tokenHowTo } from '../../src/core/credentials.js';
import type { Http, HttpRequest } from '../../src/core/types.js';

beforeEach(() => _resetSecretRegistry());

const ADMIN = 're' + '_ADMINkey1_fullAccessSecretValue99';
const MINTED = 're' + '_MINTEDkey_sendingOnlyTokenValue42';
const API = 'https://api.resend.com';

const sd = resendAdapter.capabilities.sendingDomain!;
const keys = resendAdapter.capabilities.keys!;
const ts = resendAdapter.capabilities.testSend!;

// CLI not installed → REST path.
const noCli = () => mockExec([[/^resend /, () => { throw new Error('resend: command not found'); }]]);

const LEGACY_RECORDS = [
  { record: 'SPF', name: 'send', type: 'MX', ttl: 'Auto', status: 'not_started', value: 'feedback-smtp.us-east-1.amazonses.com', priority: 10 },
  { record: 'SPF', name: 'send', value: '"v=spf1 include:amazonses.com ~all"', type: 'TXT', ttl: 'Auto', status: 'not_started' },
  { record: 'DKIM', name: 'resend._domainkey', value: 'p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDsc4Lh8xilsngyKEgN2S84+21gn+x6SEXtjWvPiAAmnmggr5FWG42WnqczpzQ/mNblqHz4CDwUum6LtY6SdoOlDmrhvp5khA3cd661W9FlK3yp7+jVACQElS7d9O6jv8VsBbVg4COess3gyLE5RyxqF1vYsrEXqyM8TBz1n5AGkQIDAQAB', type: 'TXT', status: 'not_started', ttl: 'Auto' },
];
const MODERN_RECORDS = [
  { record: 'SPF', name: 'send', type: 'CNAME', value: 'send.spf.resend-dns.com.', ttl: 'Auto', status: 'not_started' },
  { record: 'SPF', name: 'rsend', type: 'CNAME', value: 'rsend.spf.resend-dns.com.', ttl: 'Auto', status: 'not_started' },
  { record: 'DKIM', name: 'abc123._domainkey', type: 'CNAME', value: 'abc123.dkim.amazonses.com.', ttl: 'Auto', status: 'not_started' },
  { record: 'DKIM', name: 'def456._domainkey', type: 'CNAME', value: 'def456.dkim.amazonses.com.', ttl: 'Auto' },
  { record: 'DKIM', name: 'ghi789._domainkey.example.com', type: 'CNAME', value: 'GHI789.dkim.amazonses.com.', ttl: 'Auto' },
  { record: 'Tracking', name: 'links.example.com', type: 'CNAME', value: 'links1.resend-dns.com', ttl: 300 },
];

function assertUA(calls: HttpCall[]) {
  expect(calls.length).toBeGreaterThan(0);
  for (const c of calls) {
    expect(c.url.startsWith(API)).toBe(true);
    expect(c.headers['user-agent']).toMatch(/^golive\//);
    expect(c.headers['authorization']).toMatch(/^Bearer re_/);
  }
}

describe('resend records', () => {
  it('normalises legacy MX+TXT SPF and TXT DKIM', () => {
    const out = normalizeRecords('example.com', LEGACY_RECORDS);
    expect(out).toEqual([
      { type: 'MX', name: 'send.example.com', content: 'feedback-smtp.us-east-1.amazonses.com', priority: 10, proxied: false },
      { type: 'TXT', name: 'send.example.com', content: 'v=spf1 include:amazonses.com ~all', proxied: false },
      { type: 'TXT', name: 'resend._domainkey.example.com', content: LEGACY_RECORDS[2]!.value, proxied: false },
    ]);
  });

  it('normalises CNAME-style SPF (post-Aug-2026), CNAME DKIM and FQDN tracking names', () => {
    const out = normalizeRecords('example.com', MODERN_RECORDS);
    expect(out.map((r) => [r.type, r.name, r.content])).toEqual([
      ['CNAME', 'send.example.com', 'send.spf.resend-dns.com'],
      ['CNAME', 'rsend.example.com', 'rsend.spf.resend-dns.com'],
      ['CNAME', 'abc123._domainkey.example.com', 'abc123.dkim.amazonses.com'],
      ['CNAME', 'def456._domainkey.example.com', 'def456.dkim.amazonses.com'],
      ['CNAME', 'ghi789._domainkey.example.com', 'ghi789.dkim.amazonses.com'],
      ['CNAME', 'links.example.com', 'links1.resend-dns.com'],
    ]);
    expect(out.every((r) => r.proxied === false)).toBe(true);
    expect(out[5]!.ttl).toBe(300);
    expect(out[0]!.ttl).toBeUndefined();
  });

  it('defaults MX priority, skips unknown types, handles subdomain sending domains', () => {
    const warns: string[] = [];
    const out = normalizeRecords('updates.example.com', [
      { name: 'send.updates', type: 'MX', value: 'feedback-smtp.eu-west-1.amazonses.com.' },
      { name: 'send', type: 'TXT', value: 'v=spf1 include:amazonses.com ~all' },
      { name: 'x', type: 'SRV', value: '1 1 1 x' },
    ], (m) => warns.push(m));
    expect(out[0]).toMatchObject({ type: 'MX', name: 'send.updates.example.com', priority: 10 });
    expect(out[1]).toMatchObject({ type: 'TXT', name: 'send.updates.example.com' });
    expect(out).toHaveLength(2);
    expect(warns[0]).toMatch(/SRV/);
    expect(fqdnFor('@', 'example.com')).toBe('example.com');
    expect(fqdnFor('mail.example.co.uk', 'mail.example.co.uk')).toBe('mail.example.co.uk');
    expect(fqdnFor('send.mail', 'mail.example.co.uk')).toBe('send.mail.example.co.uk');
    expect(fqdnFor('links.example.co.uk', 'mail.example.co.uk')).toBe('links.example.co.uk');
    expect(fqdnFor('links.example.com', 'updates.example.com')).toBe('links.example.com');
    expect(fqdnFor('send', 'updates.example.com')).toBe('send.updates.example.com');
    expect(fqdnFor('send', 'example.com')).toBe('send.example.com');
  });

  it('regression: apex-relative names for subdomains under short-SLD ccTLDs are not doubled', () => {
    expect(fqdnFor('send.notify.app', 'notify.app.hey.io')).toBe('send.notify.app.hey.io');
    expect(fqdnFor('resend._domainkey.notify.app', 'notify.app.hey.io')).toBe('resend._domainkey.notify.app.hey.io');
    expect(fqdnFor('send.news.mail', 'news.mail.fb.me')).toBe('send.news.mail.fb.me');
    // domain-relative names still resolve under the sending domain
    expect(fqdnFor('send', 'notify.app.hey.io')).toBe('send.notify.app.hey.io');
    expect(fqdnFor('resend._domainkey', 'notify.app.hey.io')).toBe('resend._domainkey.notify.app.hey.io');
  });
});

describe('resend auth', () => {
  it('prefers a logged-in CLI and blanks RESEND_API_KEY for the child', async () => {
    const ex = mockExec([['resend whoami --json', { stdout: JSON.stringify({ authenticated: true, profile: 'default', api_key: 'eyJ...masked', source: 'secure_storage' }) }]]);
    const ctx = testCtx({ exec: ex.run, tokens: { RESEND_API_KEY: ADMIN } });
    const a = await resendAdapter.auth(ctx);
    expect(a).toEqual({ ok: true, via: 'resend CLI (logged in, profile default)' });
    expect(ex.calls[0]!.opts?.env).toEqual({ RESEND_API_KEY: '' });
  });

  it('falls back to a full-access RESEND_API_KEY validated with GET /domains', async () => {
    const h = mockHttp([['GET', `${API}/domains`, () => ({ json: { object: 'list', has_more: false, data: [] } })]]);
    const ctx = testCtx({ exec: noCli().run, http: h.http, tokens: { RESEND_API_KEY: ADMIN } });
    expect(await resendAdapter.auth(ctx)).toEqual({ ok: true, via: 'RESEND_API_KEY env (full access)' });
    assertUA(h.calls);
    expect(h.calls[0]!.headers.authorization).toBe(`Bearer ${ADMIN}`);
  });

  it('not logged in → ok:false with terminal instructions, never throws', async () => {
    const ex = mockExec([['resend whoami', { code: 1, stdout: JSON.stringify({ error: { code: 'not_authenticated' } }) }]]);
    const a = await resendAdapter.auth(testCtx({ exec: ex.run }));
    expect(a.ok).toBe(false);
    // `resend login` stays the preferred path, and it is offered first
    expect(a.howToFix).toMatch(/^Preferred: run `resend login`/);
    expect(a.howToFix).toContain('separate terminal window');
    expect(a.howToFix).toContain(tokenHowTo('RESEND_API_KEY'));
    expect(a.howToFix).toContain(credentialsPath());
    expect(a.howToFix).toMatch(/Never paste the value into this chat/);
    expect(a.howToFix).not.toMatch(/export RESEND_API_KEY=|in your shell|read -r?s|&& export/);
  });

  it('explains a sending-only key (401 restricted_api_key)', async () => {
    const h = mockHttp([['GET', `${API}/domains`, () => ({ status: 401, json: { statusCode: 401, name: 'restricted_api_key', message: 'This API key is restricted to only send emails' } })]]);
    const ctx = testCtx({ exec: noCli().run, http: h.http, tokens: { RESEND_API_KEY: ADMIN } });
    const a = await resendAdapter.auth(ctx);
    expect(a.ok).toBe(false);
    expect(a.howToFix).toMatch(/sending-only/);
    expect(a.howToFix).toContain(tokenHowTo('RESEND_API_KEY'));
    expect(a.howToFix).not.toMatch(/export it as RESEND_API_KEY|in your shell/);
    expect(a.howToFix).not.toContain(ADMIN);
  });

  it('treats a sending-only CLI profile as unusable', async () => {
    const ex = mockExec([['resend whoami', { stdout: JSON.stringify({ authenticated: true, permission: 'sending_access', source: 'config' }) }]]);
    const a = await resendAdapter.auth(testCtx({ exec: ex.run }));
    expect(a.ok).toBe(false);
    expect(a.howToFix).toMatch(/sending-only/);
  });
});

describe('resend sendingDomain (REST)', () => {
  it('creates a missing domain, re-reads it, and returns FQDN records', async () => {
    const h = mockHttp([
      ['GET', `${API}/domains`, () => ({ json: { object: 'list', data: [{ id: 'd_other', name: 'other.com', status: 'verified' }] } })],
      ['POST', `${API}/domains`, () => ({ json: { id: 'd_new', name: 'example.com', status: 'not_started', records: [] } })],
      ['GET', `${API}/domains/d_new`, () => ({ json: { id: 'd_new', name: 'example.com', status: 'not_started', records: LEGACY_RECORDS } })],
    ]);
    const ctx = testCtx({ exec: noCli().run, http: h.http, tokens: { RESEND_API_KEY: ADMIN }, config: { email: { region: 'eu-west-1' } as never } });
    const r = await sd.ensure(ctx, 'example.com');
    expect(r.id).toBe('d_new');
    expect(r.records.map((x) => x.name)).toEqual(['send.example.com', 'send.example.com', 'resend._domainkey.example.com']);
    expect(h.calls[1]!.body).toEqual({ name: 'example.com', region: 'eu-west-1', open_tracking: false, click_tracking: false });
    assertUA(h.calls);
  });

  it('adopts an existing domain by name (case-insensitive) without creating', async () => {
    const h = mockHttp([
      ['GET', `${API}/domains`, () => ({ json: { data: [{ id: 'd_1', name: 'Example.com', status: 'pending' }] } })],
      ['GET', `${API}/domains/d_1`, () => ({ json: { id: 'd_1', name: 'example.com', status: 'pending', records: MODERN_RECORDS } })],
    ]);
    const ctx = testCtx({ exec: noCli().run, http: h.http, tokens: { RESEND_API_KEY: ADMIN } });
    const r = await sd.ensure(ctx, 'example.com');
    expect(r.id).toBe('d_1');
    expect(r.records).toHaveLength(6);
    expect(h.calls.some((c) => c.method === 'POST')).toBe(false);
    expect(ctx.logs.join('\n')).toMatch(/adopting existing Resend domain/);
  });

  it('maps "registered already" to an actionable, secret-free error', async () => {
    const h = mockHttp([
      ['GET', `${API}/domains`, () => ({ json: { data: [] } })],
      ['POST', `${API}/domains`, () => ({ status: 403, json: { statusCode: 403, name: 'validation_error', message: 'The domain example.com has been registered already.' } })],
    ]);
    const ctx = testCtx({ exec: noCli().run, http: h.http, tokens: { RESEND_API_KEY: ADMIN } });
    const err = await sd.ensure(ctx, 'example.com').catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/another Resend team owns this domain/);
    expect((err as Error).message).not.toContain(ADMIN);
  });

  it('maps statuses and skips verify on an already-verified domain', async () => {
    expect(mapDomainStatus('verified')).toBe('verified');
    const warns: string[] = [];
    expect(mapDomainStatus('partially_verified', (m) => warns.push(m))).toBe('verified');
    expect(warns).toHaveLength(1);
    expect(mapDomainStatus('pending')).toBe('pending');
    expect(mapDomainStatus('failed')).toBe('failed');
    expect(mapDomainStatus('temporary_failure')).toBe('failed');
    expect(mapDomainStatus('not_started')).toBe('not_started');

    let status = 'verified';
    const h = mockHttp([
      ['GET', `${API}/domains/d_1`, () => ({ json: { id: 'd_1', name: 'example.com', status } })],
      ['POST', `${API}/domains/d_1/verify`, () => ({ json: { object: 'domain', id: 'd_1' } })],
    ]);
    const ctx = testCtx({ exec: noCli().run, http: h.http, tokens: { RESEND_API_KEY: ADMIN } });
    await sd.verify(ctx, 'd_1');
    expect(h.calls.filter((c) => c.method === 'POST')).toHaveLength(0);
    status = 'not_started';
    await sd.verify(ctx, 'd_1');
    expect(h.calls.filter((c) => c.method === 'POST')).toHaveLength(1);
    expect(await sd.status(ctx, 'd_1')).toBe('not_started');
    assertUA(h.calls);
  });

  it('records(): read-only GET /domains/{id} → the same normalised records ensure() returns', async () => {
    const h = mockHttp([['GET', `${API}/domains/d_1`, () => ({ json: { id: 'd_1', name: 'notify.app.hey.io', status: 'pending', records: [
      { record: 'SPF', name: 'send.notify.app', type: 'MX', value: 'feedback-smtp.us-east-1.amazonses.com', priority: 10 },
      { record: 'DKIM', name: 'resend._domainkey.notify.app', type: 'TXT', value: '"p=MIGf"' },
    ] } })]]);
    const ctx = testCtx({ exec: noCli().run, http: h.http, tokens: { RESEND_API_KEY: ADMIN } });
    const recs = await sd.records!(ctx, 'd_1');
    expect(recs).toEqual([
      { type: 'MX', name: 'send.notify.app.hey.io', content: 'feedback-smtp.us-east-1.amazonses.com', priority: 10, proxied: false },
      { type: 'TXT', name: 'resend._domainkey.notify.app.hey.io', content: 'p=MIGf', proxied: false },
    ]);
    expect(h.calls.every((c) => c.method === 'GET')).toBe(true);
    expect(h.calls).toHaveLength(1);
    assertUA(h.calls);
  });

  it('records() via the CLI uses `domains get` only', async () => {
    const ex = mockExec([
      ['resend whoami --json', { stdout: JSON.stringify({ authenticated: true, profile: 'default' }) }],
      ['resend domains get d_c --json', { stdout: JSON.stringify({ object: 'domain', id: 'd_c', name: 'example.com', records: LEGACY_RECORDS }) }],
    ]);
    const recs = await sd.records!(testCtx({ exec: ex.run }), 'd_c');
    expect(recs.map((r) => r.name)).toEqual(['send.example.com', 'send.example.com', 'resend._domainkey.example.com']);
    expect(ex.calls.map((c) => c.args.slice(0, 2).join(' '))).toEqual(['whoami --json', 'domains get']);
  });

  it('POST /verify is retry-safe (idempotent); POST /domains (create) is not', async () => {
    const seen: HttpRequest[] = [];
    const h = mockHttp([
      ['GET', `${API}/domains`, () => ({ json: { data: [] } })],
      ['POST', `${API}/domains`, () => ({ json: { id: 'd_n', name: 'example.com' } })],
      ['GET', `${API}/domains/d_n`, () => ({ json: { id: 'd_n', name: 'example.com', status: 'not_started', records: LEGACY_RECORDS } })],
      ['POST', `${API}/domains/d_n/verify`, () => ({ json: { object: 'domain', id: 'd_n' } })],
    ]);
    const http: Http = (req) => {
      seen.push(req);
      return h.http(req);
    };
    const ctx = testCtx({ exec: noCli().run, http, tokens: { RESEND_API_KEY: ADMIN } });
    await sd.ensure(ctx, 'example.com');
    await sd.verify(ctx, 'd_n');
    expect(seen.find((r) => r.method === 'POST' && r.url === `${API}/domains`)!.idempotent).toBeUndefined();
    expect(seen.find((r) => r.url.endsWith('/verify'))!.idempotent).toBe(true);
  });

  it('throws an actionable error for operations when nothing is authenticated', async () => {
    const ctx = testCtx({ exec: noCli().run });
    await expect(sd.ensure(ctx, 'example.com')).rejects.toThrow(/resend login/);
  });
});

describe('resend keys (REST)', () => {
  function keyRoutes() {
    return mockHttp([
      ['GET', `${API}/domains`, () => ({ json: { data: [{ id: 'd_1', name: 'example.com', status: 'verified' }] } })],
      ['GET', `${API}/api-keys`, () => ({ json: { data: [{ id: 'k_old', name: 'golive-my-app-production', created_at: '2026-01-01' }] } })],
      ['POST', `${API}/api-keys`, () => ({ json: { object: 'api_key', id: 'k_new', token: MINTED } })],
      ['DELETE', `${API}/api-keys/k_old`, () => ({ json: {} })],
    ]);
  }

  it('mints a domain-scoped sending key, token only inside a Secret', async () => {
    const h = keyRoutes();
    const ctx = testCtx({ exec: noCli().run, http: h.http, tokens: { RESEND_API_KEY: ADMIN }, detect: { root: '/work/My App' } });
    const r = await keys.issue(ctx, 'production', { domain: 'example.com' });
    expect(r.key).toBe('resend.apiKey');
    expect(r.id).toBe('k_new');
    expect(r.secret).toBeInstanceOf(Secret);
    expect(r.secret.reveal()).toBe(MINTED);
    expect(r.secret.name).toBe('RESEND_API_KEY');
    expect(vaultGet('resend.apiKey')?.reveal()).toBe(MINTED);
    const post = h.calls.find((c) => c.method === 'POST')!;
    expect(post.body).toEqual({ name: 'golive-my-app-production', permission: 'sending_access', domain_id: 'd_1' });
    // printable surfaces never carry the token or the admin key
    const printable = JSON.stringify(r) + ctx.logs.join('\n');
    expect(printable).not.toContain(MINTED);
    expect(printable).not.toContain(ADMIN);
    expect(ctx.logs.join('\n')).toMatch(/k_old/);
    assertUA(h.calls);

    await keys.revoke!(ctx, 'k_old');
    expect(h.calls.at(-1)).toMatchObject({ method: 'DELETE', url: `${API}/api-keys/k_old` });
  });

  it('keeps key names ≤ 50 chars and errors clearly when the domain is missing', async () => {
    const ctx = testCtx({ detect: { root: '/x/' + 'a-very-long-application-name-that-goes-on-and-on-forever' } });
    const n = keyName(ctx, 'production');
    expect(n.length).toBeLessThanOrEqual(50);
    expect(n).toMatch(/^golive-a-very-long.*-production$/);

    const h = mockHttp([['GET', `${API}/domains`, () => ({ json: { data: [] } })]]);
    const ctx2 = testCtx({ exec: noCli().run, http: h.http, tokens: { RESEND_API_KEY: ADMIN } });
    await expect(keys.issue(ctx2, 'preview', { domain: 'example.com' })).rejects.toThrow(/no domain example.com yet/);
  });

  it('refuses to fabricate a key when the response has no token', async () => {
    const h = mockHttp([
      ['GET', `${API}/domains`, () => ({ json: { data: [{ id: 'd_1', name: 'example.com' }] } })],
      ['GET', `${API}/api-keys`, () => ({ json: { data: [] } })],
      ['POST', `${API}/api-keys`, () => ({ json: { id: 'k_x' } })],
    ]);
    const ctx = testCtx({ exec: noCli().run, http: h.http, tokens: { RESEND_API_KEY: ADMIN } });
    await expect(keys.issue(ctx, 'preview', { domain: 'example.com' })).rejects.toThrow(/no id\/token/);
  });
});

describe('resend testSend (REST)', () => {
  it('sends with the freshly issued app key + Idempotency-Key, polls status with the admin key', async () => {
    new Secret('RESEND_API_KEY', ADMIN);
    const h = mockHttp([
      ['GET', `${API}/domains`, () => ({ json: { data: [{ id: 'd_1', name: 'example.com' }] } })],
      ['GET', `${API}/api-keys`, () => ({ json: { data: [] } })],
      ['POST', `${API}/api-keys`, () => ({ json: { id: 'k_new', token: MINTED } })],
      ['POST', `${API}/emails`, () => ({ json: { id: 'em_1' } })],
      ['GET', `${API}/emails/em_1`, () => ({ json: { id: 'em_1', last_event: 'delivered' } })],
    ]);
    const ctx = testCtx({ exec: noCli().run, http: h.http, tokens: { RESEND_API_KEY: ADMIN } });
    await keys.issue(ctx, 'production', { domain: 'example.com' });
    const msg = { from: 'App <noreply@example.com>', to: 'delivered@resend.dev', subject: 'golive smoke', text: 'hi' };
    const { id } = await ts.send(ctx, msg);
    expect(id).toBe('em_1');
    const send = h.calls.find((c) => c.url === `${API}/emails`)!;
    expect(send.headers.authorization).toBe(`Bearer ${MINTED}`);
    expect(send.headers['idempotency-key']).toMatch(/^golive-smoke-[0-9a-f]{24}$/);
    expect(send.body).toEqual({ from: msg.from, to: [msg.to], subject: msg.subject, text: 'hi' });
    expect(await ts.status(ctx, 'em_1')).toBe('delivered');
    expect(h.calls.at(-1)!.headers.authorization).toBe(`Bearer ${ADMIN}`);
    assertUA(h.calls);
  });

  it('sends with an explicitly passed key (msg.key) without putting it in the body', async () => {
    const h = mockHttp([['POST', `${API}/emails`, () => ({ json: { id: 'em_k' } })]]);
    const ctx = testCtx({ exec: noCli().run, http: h.http, tokens: { RESEND_API_KEY: ADMIN } });
    const key = new Secret('RESEND_API_KEY', MINTED);
    expect(await ts.send(ctx, { from: 'a@example.com', to: 'delivered@resend.dev', subject: 's', text: 't', key })).toEqual({ id: 'em_k' });
    expect(h.calls[0]!.headers.authorization).toBe(`Bearer ${MINTED}`);
    expect(JSON.stringify(h.calls[0]!.body)).not.toContain(MINTED);
    expect(h.calls[0]!.headers['idempotency-key']).toMatch(/^golive-smoke-/);
  });

  it('falls back to the admin credential when no app key was issued this run', async () => {
    const h = mockHttp([['POST', `${API}/emails`, () => ({ json: { id: 'em_2' } })]]);
    const ctx = testCtx({ exec: noCli().run, http: h.http, tokens: { RESEND_API_KEY: ADMIN } });
    expect(await ts.send(ctx, { from: 'a@example.com', to: 'delivered@resend.dev', subject: 's', text: 't' })).toEqual({ id: 'em_2' });
    expect(h.calls[0]!.headers.authorization).toBe(`Bearer ${ADMIN}`);
  });
});

describe('resend CLI transport', () => {
  const whoami: [string, { stdout: string }] = ['resend whoami --json', { stdout: JSON.stringify({ authenticated: true, profile: 'work', source: 'secure_storage' }) }];

  it('ensure + verify + key issue via CLI, parsing JSON without leaking the minted token', async () => {
    const ex = mockExec([
      whoami,
      ['resend domains list --json', { stdout: JSON.stringify({ object: 'list', has_more: false, data: [] }) }],
      ['resend domains create --name example.com --region us-east-1 --json', { stdout: JSON.stringify({ id: 'd_c', name: 'example.com', status: 'not_started' }) }],
      ['resend domains get d_c --json', { stdout: JSON.stringify({ object: 'domain', id: 'd_c', name: 'example.com', status: 'not_started', records: MODERN_RECORDS }) }],
      ['resend domains verify d_c --json', { stdout: JSON.stringify({ object: 'domain', id: 'd_c' }) }],
    ]);
    const ctx = testCtx({ exec: ex.run });
    const r = await sd.ensure(ctx, 'example.com');
    expect(r).toMatchObject({ id: 'd_c' });
    expect(r.records.map((x) => x.name)).toContain('rsend.example.com');
    await sd.verify(ctx, 'd_c');
    expect(ex.calls.some((c) => c.args.join(' ') === 'domains verify d_c --json')).toBe(true);
    for (const c of ex.calls) expect(c.opts?.env).toEqual({ RESEND_API_KEY: '' });

    const ex2 = mockExec([
      whoami,
      ['resend domains list --json', { stdout: JSON.stringify({ data: [{ id: 'd_c', name: 'example.com', status: 'verified' }] }) }],
      ['resend api-keys list --json', { stdout: JSON.stringify({ data: [] }) }],
      ['resend api-keys create', { stdout: JSON.stringify({ id: 'k_cli', token: MINTED }) }],
      ['resend emails get em_9 --json', { stdout: JSON.stringify({ id: 'em_9', last_event: 'sent' }) }],
    ]);
    const ctx2 = testCtx({ exec: ex2.run, detect: { root: '/repo/shop' } });
    const k = await keys.issue(ctx2, 'preview', { domain: 'example.com' });
    expect(k.id).toBe('k_cli');
    expect(k.secret.reveal()).toBe(MINTED);
    const create = ex2.calls.find((c) => c.args[1] === 'create')!;
    expect(create.args).toEqual(['api-keys', 'create', '--name', 'golive-shop-preview', '--permission', 'sending_access', '--domain-id', 'd_c', '--json']);
    for (const c of ex2.calls) {
      expect(c.args.join(' ')).not.toContain(MINTED);
      expect(c.stdin).toBeUndefined();
    }
    expect(JSON.stringify(k) + ctx2.logs.join('\n')).not.toContain(MINTED);
    expect(await ts.status(ctx2, 'em_9')).toBe('sent');
  });

  it('CLI errors are actionable and never echo stdout secrets', async () => {
    const ex = mockExec([
      whoami,
      ['resend domains list --json', { stdout: JSON.stringify({ data: [{ id: 'd_c', name: 'example.com' }] }) }],
      ['resend api-keys list --json', { stdout: JSON.stringify({ data: [] }) }],
      ['resend api-keys create', { code: 1, stdout: JSON.stringify({ error: { code: 'insufficient_permissions', message: 'API key lacks permission' } }) }],
    ]);
    const ctx = testCtx({ exec: ex.run });
    const err = (await keys.issue(ctx, 'preview', { domain: 'example.com' }).catch((e: Error) => e)) as Error;
    expect(err.message).toMatch(/insufficient_permissions/);
    expect(err.message).toMatch(/full access/);

    const ex2 = mockExec([
      whoami,
      ['resend domains list --json', { stdout: JSON.stringify({ data: [{ id: 'd_c', name: 'example.com' }] }) }],
      ['resend api-keys list --json', { stdout: '[]' }],
      ['resend api-keys create', { stdout: `not json but has ${MINTED}` }],
    ]);
    const err2 = (await keys.issue(testCtx({ exec: ex2.run }), 'preview', { domain: 'example.com' }).catch((e: Error) => e)) as Error;
    expect(err2.message).toMatch(/expected JSON/);
    expect(err2.message).not.toContain(MINTED);
  });

  it('sends the CLI test email with an idempotency key when no app key is in the vault', async () => {
    const ex = mockExec([whoami, ['resend emails send', { stdout: JSON.stringify({ id: 'em_c' }) }]]);
    const ctx = testCtx({ exec: ex.run });
    expect(await ts.send(ctx, { from: 'a@example.com', to: 'delivered@resend.dev', subject: 's', text: 't' })).toEqual({ id: 'em_c' });
    const args = ex.calls[1]!.args;
    expect(args.slice(0, 2)).toEqual(['emails', 'send']);
    expect(args[args.indexOf('--idempotency-key') + 1]).toMatch(/^golive-smoke-/);
  });
});
