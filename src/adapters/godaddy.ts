import { domainToASCII } from 'node:url';
import { isIP } from 'node:net';
import type { Adapter, AuthStatus, Ctx, DnsRecord, DnsZone, HttpResponse } from '../core/types.js';
import { Secret, fingerprint } from '../core/secret.js';
import { resolve, normalizeTxt } from '../core/doh.js';
import { tokenHowTo } from '../core/credentials.js';
import { isSpf, mergeSpf } from './cloudflare-spf.js';
import { cliLoginHelp, cliRequest, godaddyCli } from './godaddy-cli.js';

const API = 'https://api.godaddy.com/v3/domains';
const TOKEN = 'GODADDY_API_TOKEN';
const TYPES = new Set(['A', 'AAAA', 'CNAME', 'TXT', 'MX', 'CAA']);
const ADDRESS = new Set(['A', 'AAAA', 'CNAME']);
interface GdRecord {
  recordId: string;
  name: string;
  type: string;
  data: string;
  ttl: number;
  priority?: number;
  flag?: number;
  tag?: string;
}

function tokenHelp(): string {
  return 'Create a GoDaddy Personal Access Token in developer.godaddy.com with domains.domain:read and domains.dns:update only. ' +
    'Do not grant purchase or nameserver permissions. ' + tokenHowTo(TOKEN);
}

class GoDaddyError extends Error {
  constructor(message: string, readonly status = 0) { super(message); }
}

function responseError(status: number): GoDaddyError {
  const hint = status === 401 ? 'The PAT is missing, expired or revoked.' :
    status === 403 ? 'Check PAT scopes and account eligibility (at least one domain or a plan granting management access).' :
    status === 404 ? 'The zone or record is not accessible to this account.' :
    status === 429 ? 'Rate limited; wait before running golive again.' :
    status === 409 ? 'The record conflicts with the current zone state.' : 'Inspect the zone in the GoDaddy dashboard, then re-run.';
  // The general guide and v3 OpenAPI describe different error bodies. Neither is safe to echo.
  return new GoDaddyError(`GoDaddy DNS request failed: HTTP ${status}. ${hint}`, status);
}

/** What the human can do when neither the CLI session nor a PAT is available. */
function accessHelp(): string {
  return `Sign in once with the official GoDaddy CLI (${cliLoginHelp()}), or use a Personal Access Token. ${tokenHelp()}`;
}

async function api(ctx: Ctx, method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown): Promise<unknown> {
  const cli = await godaddyCli(ctx);
  if (cli) {
    // Same endpoints, methods and bodies as the REST path; gddy supplies its own cached session.
    const result = await cliRequest(ctx, cli, method, path, body);
    if (result.status === 0) throw new GoDaddyError('GoDaddy CLI request did not complete. Re-read the zone before retrying a write.');
    if (result.status < 200 || result.status >= 300) throw responseError(result.status);
    return result.json;
  }
  const token = ctx.envToken(TOKEN);
  if (!token) throw new GoDaddyError(`No GoDaddy access is available to golive. ${accessHelp()}`);
  let res: HttpResponse;
  try {
    res = await ctx.http({ method, url: API + path,
      headers: { authorization: new Secret(TOKEN, `Bearer ${token.reveal()}`) },
      ...(body === undefined ? {} : { body }),
      // A PUT may overwrite a concurrent edit if blindly replayed after an ambiguous response.
      ...(method === 'PUT' ? { idempotent: false } : {}),
    });
  } catch {
    throw new GoDaddyError('GoDaddy DNS request did not complete. Re-read the zone before retrying a write.');
  }
  if (res.status < 200 || res.status >= 300) throw responseError(res.status);
  return res.json;
}

function name(value: string): string {
  const ascii = domainToASCII(value.trim().replace(/\.$/, '').toLowerCase());
  if (!ascii || ascii.length > 253 || ascii.split('.').some((x, i) =>
    x.length > 63 || !(i === 0 && x === '*') && !/^[a-z0-9_](?:[a-z0-9_-]*[a-z0-9_])?$/.test(x))) {
    throw new GoDaddyError('GoDaddy DNS: invalid DNS name; nothing was changed.');
  }
  return ascii;
}
const inZone = (host: string, zone: string): boolean => host === zone || host.endsWith(`.${zone}`);
const pathFor = (zone: string): string => `/zones/${encodeURIComponent(zone)}/dns-records`;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const malformed = (): GoDaddyError => new GoDaddyError('GoDaddy DNS returned an unexpected response shape; no further writes were attempted.');

/** Exact-owner NS queries avoid following a CNAME into the target provider's zone. */
async function delegatedZone(ctx: Ctx, host: string): Promise<string | null> {
  const labels = name(host).split('.');
  for (let i = 0; i < labels.length - 1; i++) {
    const candidate = labels.slice(i).join('.');
    let result;
    try { result = await resolve(ctx, candidate, 'NS'); }
    catch { throw new GoDaddyError('GoDaddy DNS: public nameserver lookup failed; no writes were attempted.'); }
    if (![0, 3].includes(result.status)) throw new GoDaddyError('GoDaddy DNS: public nameserver lookup was inconclusive; no writes were attempted.');
    const ns = result.answers.filter((r) => r.type === 'NS' && r.name === candidate).map((r) => r.data);
    if (!ns.length) continue;
    // The first delegation wins: never fall back past a child hosted by another provider.
    return ns.length >= 2 && ns.every((n) => n.endsWith('.domaincontrol.com')) ? candidate : null;
  }
  return null;
}

function parseRecord(raw: unknown): GdRecord {
  if (!object(raw) || typeof raw.recordId !== 'string' || !raw.recordId || typeof raw.name !== 'string' ||
    typeof raw.type !== 'string' || typeof raw.data !== 'string' || !Number.isInteger(raw.ttl) ||
    (raw.ttl as number) < 600 || (raw.ttl as number) > 86400) throw malformed();
  for (const k of ['priority', 'flag']) if (raw[k] !== undefined && !Number.isInteger(raw[k])) throw malformed();
  if (raw.tag !== undefined && typeof raw.tag !== 'string') throw malformed();
  if (raw.type === 'MX' && raw.priority === undefined || raw.type === 'CAA' && (raw.flag === undefined || raw.tag === undefined)) throw malformed();
  return { recordId: raw.recordId, name: raw.name === '@' ? '@' : name(raw.name), type: raw.type, data: raw.data, ttl: raw.ttl as number,
    ...(raw.priority === undefined ? {} : { priority: raw.priority as number }),
    ...(raw.flag === undefined ? {} : { flag: raw.flag as number }),
    ...(raw.tag === undefined ? {} : { tag: raw.tag as string }) };
}

async function records(ctx: Ctx, zone: string): Promise<GdRecord[]> {
  const out: GdRecord[] = [];
  const ids = new Set<string>();
  for (let page = 1; page <= 1000; page++) {
    const raw = await api(ctx, 'GET', `${pathFor(zone)}?page=${page}&pageSize=100`);
    if (!object(raw) || !Array.isArray(raw.items) || !Array.isArray(raw.links) || raw.items.length > 100) throw malformed();
    for (const item of raw.items) {
      const r = parseRecord(item);
      if (ids.has(r.recordId)) throw malformed(); // Repeated/drifting pages must not hide a conflict.
      ids.add(r.recordId);
      fullName(r, zone);
      out.push(r);
    }
    if (raw.links.some((l) => !object(l) || typeof l.rel !== 'string' || typeof l.href !== 'string')) throw malformed();
    const next = raw.links.filter((l) => object(l) && l.rel === 'next');
    if (!next.length) return out;
    if (next.length !== 1 || !raw.items.length) throw malformed();
    // Never follow a provider-supplied URL with credentials; construct the next page ourselves.
    let url: URL;
    try { url = new URL((next[0] as { href: string }).href, API); } catch { throw malformed(); }
    if (url.origin !== 'https://api.godaddy.com' || url.pathname !== `/v3/domains${pathFor(zone)}` ||
      url.searchParams.get('page') !== String(page + 1) || url.searchParams.get('pageSize') !== '100') throw malformed();
  }
  throw new GoDaddyError('GoDaddy DNS pagination exceeded its safe bound; no writes were attempted.');
}

async function zoneAndRecords(ctx: Ctx, domain: string): Promise<{ zone: string; records: GdRecord[] } | null> {
  const zone = await delegatedZone(ctx, domain);
  if (!zone) return null;
  try { return { zone, records: await records(ctx, zone) }; }
  catch (e) { if (e instanceof GoDaddyError && e.status === 404) return null; throw e; }
}

function fullName(r: GdRecord, zone: string): string {
  // GoDaddy names are relative, including multi-label names such as selector._domainkey.
  return r.name === '@' ? zone : name(`${r.name}.${zone}`);
}
function content(type: string, data: string): string {
  if (type === 'TXT') return normalizeTxt(data);
  if (type === 'CNAME' || type === 'MX') return name(data);
  return type === 'AAAA' ? data.trim().toLowerCase() : data.trim();
}
function publicRecord(r: GdRecord, zone: string): DnsRecord {
  const value = r.type === 'CAA' ? `${r.flag} ${r.tag} "${r.data}"` : content(r.type, r.data);
  return { type: r.type as DnsRecord['type'], name: fullName(r, zone), content: value, ttl: r.ttl,
    ...(r.priority === undefined ? {} : { priority: r.priority }), proxied: false };
}

function desired(record: DnsRecord, zone: string): Omit<GdRecord, 'recordId'> {
  if (!TYPES.has(record.type)) throw new GoDaddyError('GoDaddy DNS: unsupported record type.');
  const fqdn = record.name === '@' ? zone : name(record.name);
  if (!inZone(fqdn, zone)) throw new GoDaddyError('GoDaddy DNS: record is outside the selected zone; nothing was changed.');
  if (record.proxied) throw new GoDaddyError('GoDaddy DNS does not support proxying.');
  // Provider-neutral TTL=1 means automatic at Cloudflare; GoDaddy requires at least 600 seconds.
  const ttl = record.ttl === undefined || record.ttl === 1 ? 600 : record.ttl;
  if (!Number.isInteger(ttl) || ttl < 600 || ttl > 86400) throw new GoDaddyError('GoDaddy DNS TTL must be 600–86400 seconds.');
  const result: Omit<GdRecord, 'recordId'> = { name: fqdn === zone ? '@' : fqdn.slice(0, -(zone.length + 1)), type: record.type,
    data: content(record.type, record.content), ttl };
  if (!result.data || (record.type === 'A' && isIP(result.data) !== 4) || (record.type === 'AAAA' && isIP(result.data) !== 6)) {
    throw new GoDaddyError('GoDaddy DNS: invalid record value; nothing was changed.');
  }
  if (record.type === 'CNAME' && result.name === '@') throw new GoDaddyError('GoDaddy DNS does not support an apex CNAME; use the hosting provider\'s apex A/AAAA instructions.');
  if (record.type === 'MX') {
    result.priority = record.priority ?? 10;
    if (!Number.isInteger(result.priority) || result.priority < 0 || result.priority > 65535) throw new GoDaddyError('GoDaddy DNS: invalid MX priority.');
  }
  if (record.type === 'CAA') {
    const match = /^(\d+)\s+(issue|issuewild|iodef)\s+"?([^"\n]*)"?$/.exec(record.content.trim());
    if (!match || Number(match[1]) > 255) throw new GoDaddyError('GoDaddy DNS: invalid CAA content.');
    result.flag = Number(match[1]); result.tag = match[2]!; result.data = match[3]!;
  }
  return result;
}

function sameValue(a: GdRecord, b: Omit<GdRecord, 'recordId'>): boolean {
  return a.name === b.name && a.type === b.type && content(a.type, a.data) === content(b.type, b.data) &&
    (a.type !== 'CAA' || a.flag === b.flag && a.tag === b.tag);
}
const same = (a: GdRecord, b: Omit<GdRecord, 'recordId'>): boolean => sameValue(a, b) && (a.type !== 'MX' || a.priority === b.priority);
const ownedKey = (zone: string, id: string): string => `godaddy.recordFingerprint:${zone}:${id}`;
const snapshot = (r: GdRecord): string => fingerprint(JSON.stringify(r));
const owned = (ctx: Ctx, zone: string, r: GdRecord): boolean => ctx.state.resource(ownedKey(zone, r.recordId)) === snapshot(r);
function remember(ctx: Ctx, zone: string, r: GdRecord): void {
  ctx.state.save((s) => { s.resources[ownedKey(zone, r.recordId)] = snapshot(r); });
}
function conflict(): never {
  throw new GoDaddyError('GoDaddy DNS conflict: golive cannot safely replace the existing record. Review it in the GoDaddy DNS dashboard, or use a fresh subdomain; nothing was changed.');
}
function rejectDelegatedRecords(zone: string, records: GdRecord[], fqdn: string): void {
  if (records.some((r) => r.type === 'NS' && fullName(r, zone) !== zone && inZone(fqdn, fullName(r, zone)))) {
    throw new GoDaddyError('GoDaddy DNS conflict: the parent zone contains a separately delegated child covering this record; nothing was changed.');
  }
}

async function create(ctx: Ctx, zone: string, want: Omit<GdRecord, 'recordId'>): Promise<'created' | 'unchanged'> {
  try {
    const made = parseRecord(await api(ctx, 'POST', pathFor(zone), want));
    if (!same(made, want)) throw malformed();
    remember(ctx, zone, made);
    return 'created';
  } catch (e) {
    if (e instanceof GoDaddyError && e.status > 0 && e.status < 500 && e.status !== 409) throw e;
    // POST is never retried. A timeout may mean the record was created; observe and adopt only.
    const found = (await records(ctx, zone)).filter((r) => same(r, want));
    if (found.length === 1) return 'unchanged';
    throw e;
  }
}

async function update(ctx: Ctx, zone: string, before: GdRecord, want: Omit<GdRecord, 'recordId'>): Promise<'updated'> {
  if (!owned(ctx, zone, before)) conflict();
  const current = await records(ctx, zone);
  rejectDelegatedRecords(zone, current, fullName(before, zone));
  const fresh = current.find((r) => r.recordId === before.recordId);
  if (!fresh || snapshot(fresh) !== snapshot(before) ||
    current.some((r) => r.recordId !== before.recordId && r.name === before.name &&
      (r.type === 'CNAME' || want.type === 'CNAME' || r.type === want.type && ADDRESS.has(want.type)))) conflict();
  const replaced = parseRecord(await api(ctx, 'PUT', `${pathFor(zone)}/${encodeURIComponent(before.recordId)}`, want));
  if (replaced.recordId !== before.recordId || !same(replaced, want)) throw malformed();
  remember(ctx, zone, replaced);
  return 'updated';
}

export const godaddyDns: DnsZone = {
  async hosts(ctx, domain) { return (await zoneAndRecords(ctx, domain)) !== null; },
  async list(ctx, domain) {
    const found = await zoneAndRecords(ctx, domain);
    if (!found) throw new GoDaddyError('GoDaddy does not serve accessible authoritative DNS for this domain. Use its current DNS provider.');
    return found.records.filter((r) => TYPES.has(r.type)).map((r) => publicRecord(r, found.zone));
  },
  async upsert(ctx, domain, record) {
    const found = await zoneAndRecords(ctx, domain);
    if (!found) throw new GoDaddyError('GoDaddy does not serve accessible authoritative DNS for this domain. Use its current DNS provider.');
    const { zone } = found;
    const want = desired(record, zone);
    const fqdn = want.name === '@' ? zone : `${want.name}.${zone}`;
    // Recursive NS answers may still be cached while a new child delegation is propagating.
    rejectDelegatedRecords(zone, found.records, fqdn);
    if (await delegatedZone(ctx, fqdn) !== zone) throw new GoDaddyError('GoDaddy DNS: this record belongs to a separately delegated zone; nothing was changed.');
    const here = found.records.filter((r) => fullName(r, zone) === fqdn);
    if (want.type === 'CNAME' ? here.some((r) => r.type !== 'CNAME') : here.some((r) => r.type === 'CNAME')) conflict();
    const singleton = ADDRESS.has(want.type) || want.type === 'TXT' && /(^|\.)_domainkey\./.test(fqdn) ||
      want.type === 'MX' && /^feedback-smtp(?:\.[a-z0-9-]+)?\.amazonses\.com$/.test(want.data);
    if (singleton && here.filter((r) => r.type === want.type).length > 1) conflict();
    const spfs = want.type === 'TXT' && isSpf(want.data) ? here.filter((r) => r.type === 'TXT' && isSpf(normalizeTxt(r.data))) : [];
    if (spfs.length > 1) conflict();
    const matching = here.filter((r) => sameValue(r, want));
    if (matching.length > 1) conflict();
    if (matching.length === 1) {
      const have = matching[0]!;
      const ttlChanged = record.ttl !== undefined && record.ttl !== 1 && have.ttl !== want.ttl;
      if (!same(have, want) || ttlChanged) return update(ctx, zone, have, { ...want, ttl: ttlChanged ? want.ttl : have.ttl });
      return 'unchanged';
    }
    if (want.type === 'TXT' && isSpf(want.data)) {
      if (spfs.length) {
        let merged;
        try { merged = mergeSpf(normalizeTxt(spfs[0]!.data), want.data, fqdn); }
        catch { throw new GoDaddyError('GoDaddy DNS: existing SPF cannot be merged safely. Review its policy in the DNS dashboard.'); }
        if (!merged.added.length) return 'unchanged';
        return update(ctx, zone, spfs[0]!, { ...want, data: merged.content, ttl: spfs[0]!.ttl });
      }
    }
    if (singleton) {
      const others = here.filter((r) => r.type === want.type);
      if (others.length > 1) conflict();
      if (others.length === 1) return update(ctx, zone, others[0]!, want);
    }
    return create(ctx, zone, want);
  },
};

async function auth(ctx: Ctx): Promise<AuthStatus> {
  const cli = await godaddyCli(ctx);
  if (!cli && !ctx.envToken(TOKEN)) return { ok: false, howToFix: `No GoDaddy access is configured. ${accessHelp()}` };
  try {
    const data = await api(ctx, 'GET', '/domain-names?pageSize=1');
    if (!object(data) || !Array.isArray(data.items) || !Array.isArray(data.links)) throw malformed();
    return { ok: true, via: cli ? `GoDaddy CLI (gddy ${cli.version}, ${cli.identity})` : `${TOKEN} (scoped Personal Access Token)` };
  } catch (e) {
    return { ok: false, howToFix: `${e instanceof GoDaddyError ? e.message : 'GoDaddy authentication could not be verified.'} ${accessHelp()}` };
  }
}

export const godaddyAdapter: Adapter = {
  id: 'godaddy', title: 'GoDaddy', axes: ['dns'], automated: true,
  detect: (d) => (d.providers.dns ?? []).includes('godaddy'), auth, capabilities: { dns: godaddyDns },
};
