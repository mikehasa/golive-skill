import { randomUUID } from 'node:crypto';
import { domainToASCII } from 'node:url';
import type { Adapter, AuthStatus, Ctx, DnsRecord, DnsZone } from '../core/types.js';
import { Secret, redact } from '../core/secret.js';
import { lookup, normalizeTxt, resolve } from '../core/doh.js';
import { tokenHowTo } from '../core/credentials.js';
import { HttpError } from '../core/http.js';
import { isSpf, mergeSpf } from './cloudflare-spf.js';

const API = 'https://api.porkbun.com/api/json/v3';
const TYPES = new Set<string>(['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'CAA']);
const ADDRESS = new Set(['A', 'AAAA', 'CNAME']);
const OWNED = 'golive:';

interface Envelope {
  status?: string;
  code?: string;
  warnings?: unknown;
  [key: string]: unknown;
}

export class PorkbunError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) { super(message); }
}

function help(): string {
  return 'Create an API key pair at https://porkbun.com/account/api, restrict it to the intended domain, and enable API Access for that domain in Domain Management. ' +
    `${tokenHowTo('PORKBUN_API_KEY')} ${tokenHowTo('PORKBUN_SECRET_API_KEY')}`;
}

function keys(ctx: Ctx): { publicKey: Secret; secretKey: Secret } {
  const publicKey = ctx.envToken('PORKBUN_API_KEY');
  const secretKey = ctx.envToken('PORKBUN_SECRET_API_KEY');
  if (!publicKey || !secretKey) throw new Error(`Porkbun needs both PORKBUN_API_KEY and PORKBUN_SECRET_API_KEY. ${help()}`);
  return { publicKey, secretKey };
}

async function api(ctx: Ctx, method: 'GET' | 'POST', path: string, body?: Record<string, unknown>): Promise<Envelope> {
  const { publicKey, secretKey } = keys(ctx);
  const response = await ctx.http<Envelope>({
    method, url: API + path,
    headers: {
      'X-API-Key': publicKey, 'X-Secret-API-Key': secretKey,
      ...(method === 'POST' ? { 'Idempotency-Key': randomUUID() } : {}),
    },
    ...(body ? { body } : {}),
  });
  const env = response.json;
  if (response.status < 200 || response.status >= 300 || env?.status !== 'SUCCESS') {
    const code = typeof env?.code === 'string' && /^[A-Z0-9_]+$/.test(env.code) ? env.code : undefined;
    const hint = code === 'DOMAIN_NOT_ALLOWED' || code === 'IP_NOT_ALLOWED' || response.status === 403
      ? ' Check the key domain/IP restrictions and this domain\'s API Access setting.'
      : response.status === 429 ? ' Rate limited; wait and retry.'
        : code?.startsWith('INVALID_API_KEYS') || code === 'API_KEY_REQUIRED' ? ` ${help()}` : '';
    // Provider error bodies may echo credentials or record values. Only vetted codes are printable.
    throw new PorkbunError(`Porkbun request failed: HTTP ${response.status}${code ? ` (${code})` : ' (unexpected or unsuccessful response)'}.${hint}`, response.status, code);
  }
  if (env.sandbox === true) throw new Error('Porkbun returned a sandbox response; simulated DNS cannot verify a live domain. Use a domain-scoped real key for this DNS adapter.');
  if (Array.isArray(env.warnings) && env.warnings.length) {
    // A successful write can target a non-authoritative Porkbun zone. Never report that as verified.
    throw new Error('Porkbun returned a DNS warning: the stored zone may not be authoritative. Re-check the domain nameservers and plan again; a write may already have been saved.');
  }
  return env;
}

function name(value: string, record = false): string {
  const result = domainToASCII(value.trim().replace(/\.$/, '').toLowerCase());
  const labels = result.split('.');
  if (!result || result.length > 253 || labels.length < 2 || labels.some((part, index) =>
    !part || part.length > 63 || !(record && index === 0 && part === '*') &&
    !(record ? /^[a-z0-9_](?:[a-z0-9_-]*[a-z0-9_])?$/ : /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/).test(part))) {
    throw new Error('Porkbun DNS requires a valid domain or fully-qualified record name.');
  }
  return result;
}

const inside = (record: string, zone: string): boolean => record === zone || record.endsWith(`.${zone}`);
const porkbunNs = (ns: string): boolean => ns.endsWith('.ns.porkbun.com');
const nsSet = (values: string[]): string[] => [...new Set(values.map((n) => name(n)))].sort();

async function authoritative(ctx: Ctx, zone: string): Promise<boolean> {
  const response = await api(ctx, 'GET', `/domain/getNs/${encodeURIComponent(zone)}`);
  if (!Array.isArray(response.ns) || !response.ns.length || response.ns.some((x) => typeof x !== 'string')) throw new Error('Porkbun returned an unexpected nameserver response.');
  const registryNs = nsSet(response.ns as string[]);
  const publicNs = nsSet(await lookup(ctx, zone, 'NS'));
  return registryNs.every(porkbunNs) && publicNs.length > 0 && publicNs.every(porkbunNs) && registryNs.join(',') === publicNs.join(',');
}

/** Registered ownership is insufficient: Porkbun accepts writes even after delegation moves away. */
async function findZone(ctx: Ctx, domain: string): Promise<string | null> {
  const labels = name(domain).split('.');
  for (let i = 0; i < labels.length - 1; i++) {
    const zone = labels.slice(i).join('.');
    let env: Envelope;
    try { env = await api(ctx, 'GET', `/domain/listAll?domain=${encodeURIComponent(zone)}`); }
    catch (e) {
      // Exact suffix probing may leave a domain-scoped key's scope before reaching its registered apex.
      if (e instanceof PorkbunError && e.code === 'DOMAIN_NOT_ALLOWED') continue;
      throw e;
    }
    if (!Array.isArray(env.domains)) throw new Error('Porkbun returned an unexpected domain list.');
    const found = env.domains.find((d: unknown) => {
      const row = d as { domain?: unknown } | null;
      return typeof row?.domain === 'string' && name(row.domain) === zone;
    }) as { apiAccess?: number | string; notLocal?: number | string } | undefined;
    if (!found) continue;
    if (Number(found.apiAccess) !== 1) throw new Error(`Enable API Access for ${zone} in Porkbun Domain Management, then re-run.`);
    if (Number(found.notLocal) === 1 || !(await authoritative(ctx, zone))) return null;
    if (!(await withinAuthority(ctx, name(domain), zone))) return null;
    return zone;
  }
  return null;
}

/** A delegated child belongs to its own zone, even when its parent is hosted at Porkbun. */
async function withinAuthority(ctx: Ctx, target: string, zone: string): Promise<boolean> {
  let current = target.replace(/^\*\./, '');
  while (current !== zone) {
    const answer = await resolve(ctx, current, 'NS');
    if (answer.status !== 0 && answer.status !== 3) throw new Error(`Cannot confirm DNS delegation for ${current}; retry before changing records.`);
    if (answer.answers.some((r) => r.type === 'NS' && r.name === current)) return false;
    current = current.split('.').slice(1).join('.');
  }
  return true;
}

async function requireZone(ctx: Ctx, domain: string): Promise<string> {
  const zone = await findZone(ctx, domain);
  if (!zone) throw new Error(`Porkbun is not confirmed as the authoritative DNS provider for ${name(domain)} in this account. Use the provider serving the domain's nameservers; golive never changes nameservers.`);
  return zone;
}

interface RecordRow {
  id: string; name: string; type: string; content: string; ttl?: number; priority?: number; notes?: string;
}

function content(type: string, value: string): string {
  if (type === 'TXT') return normalizeTxt(value);
  if (type === 'CNAME' || type === 'MX' || type === 'NS' || type === 'ALIAS') return name(value);
  return type === 'AAAA' ? value.trim().toLowerCase() : value.trim().replace(/\s+/g, ' ');
}

function number(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new Error('Porkbun returned an invalid DNS TTL or priority.');
  return n;
}

async function records(ctx: Ctx, zone: string): Promise<RecordRow[]> {
  const env = await api(ctx, 'GET', `/dns/retrieve/${encodeURIComponent(zone)}`);
  if (!Array.isArray(env.records)) throw new Error('Porkbun returned an unexpected DNS record list.');
  return env.records.map((value: unknown): RecordRow => {
    const r = value as Record<string, unknown> | null;
    if (!r || typeof r.id !== 'string' || !/^\d+$/.test(r.id) || typeof r.name !== 'string' || typeof r.type !== 'string' || typeof r.content !== 'string') {
      throw new Error('Porkbun returned an unexpected DNS record shape.');
    }
    const normalized = name(r.name, true);
    if (!inside(normalized, zone)) throw new Error('Porkbun returned a DNS record outside the selected zone.');
    return { id: r.id, name: normalized, type: r.type.toUpperCase(), content: content(r.type.toUpperCase(), r.content), ttl: number(r.ttl), priority: number(r.prio), notes: typeof r.notes === 'string' ? r.notes : undefined };
  });
}

const owned = (r: RecordRow): boolean => r.notes?.startsWith(OWNED) ?? false;
const returnPath = (value: string): boolean => /^feedback-smtp(\.[a-z0-9-]+)?\.amazonses\.com$/.test(value);

function body(zone: string, want: DnsRecord, notes?: string): Record<string, unknown> {
  return {
    name: want.name === zone ? '' : want.name.slice(0, -(zone.length + 1)),
    type: want.type, content: want.content,
    ...(want.ttl === undefined ? {} : { ttl: want.ttl }),
    ...(want.type === 'MX' ? { prio: want.priority ?? 10 } : {}),
    ...(notes === undefined ? {} : { notes }),
  };
}

async function edit(ctx: Ctx, zone: string, have: RecordRow, want: DnsRecord): Promise<'updated'> {
  const desired = { ...want, ttl: want.ttl ?? have.ttl };
  try {
    await api(ctx, 'POST', `/dns/edit/${encodeURIComponent(zone)}/${encodeURIComponent(have.id)}`, body(zone, desired, have.notes));
  } catch (e) {
    if (!ambiguous(e)) throw e;
    const saved = (await records(ctx, zone)).find((r) => r.id === have.id);
    if (!saved || !matches(saved, desired) || saved.notes !== have.notes) throw e;
  }
  ctx.log.info(`porkbun: updated ${want.type} ${want.name}`);
  return 'updated';
}

const ambiguous = (e: unknown): boolean => (e instanceof HttpError || e instanceof PorkbunError) && (e.status === 0 || e.status >= 500);
const matches = (r: RecordRow, want: DnsRecord): boolean =>
  r.name === want.name && r.type === want.type && r.content === want.content &&
  (want.type !== 'MX' || r.priority === want.priority) &&
  (want.ttl === undefined || want.ttl === 0 || r.ttl === want.ttl);

function conflict(want: DnsRecord): never {
  throw new Error(`Porkbun DNS conflict at ${want.name}: existing records cannot safely become the required ${want.type}. Review them in Porkbun; golive only replaces a single record marked with notes starting "golive:" and never deletes unrelated records.`);
}

export const porkbunDns: DnsZone = {
  async hosts(ctx, domain) { return (await findZone(ctx, domain)) !== null; },
  async list(ctx, domain) {
    const zone = await requireZone(ctx, domain);
    return (await records(ctx, zone)).filter((r) => TYPES.has(r.type)).map((r): DnsRecord => ({ type: r.type as DnsRecord['type'], name: r.name, content: r.content, ttl: r.ttl, priority: r.priority, proxied: false }));
  },
  async upsert(ctx, domain, record) {
    if (!TYPES.has(record.type)) throw new Error(`Porkbun DNS does not support ${String(record.type)} in golive.`);
    if (record.proxied) throw new Error('Porkbun DNS adapter cannot enable a proxy. Set proxied=false.');
    const want: DnsRecord = {
      ...record, name: name(record.name, true), content: content(record.type, record.content),
      // Neutral DNS records may use Cloudflare's automatic TTL sentinel. Porkbun uses zero.
      ttl: record.ttl === 1 ? 0 : record.ttl,
      ...(record.type === 'MX' ? { priority: record.priority ?? 10 } : {}),
    };
    if (want.ttl !== undefined && (!Number.isInteger(want.ttl) || want.ttl < 0)) throw new Error('Porkbun DNS TTL must be a non-negative integer.');
    if (want.priority !== undefined && (!Number.isInteger(want.priority) || want.priority < 0 || want.priority > 65535)) throw new Error('Porkbun DNS priority must be an integer from 0 to 65535.');
    const zone = await requireZone(ctx, domain);
    if (!inside(want.name, zone)) throw new Error(`Porkbun DNS record ${want.name} is outside ${zone}; nothing was changed.`);
    if (!(await withinAuthority(ctx, want.name, zone))) throw new Error(`Porkbun DNS record ${want.name} is beneath a delegated child zone; nothing was changed.`);
    if (want.type === 'CNAME' && want.name === zone) throw new Error('Porkbun apex CNAME is unsafe; use the host-provided A/AAAA record. golive does not substitute ALIAS automatically.');
    const all = await records(ctx, zone);
    if (all.some((r) => r.type === 'NS' && r.name !== zone && inside(want.name, r.name))) {
      throw new Error(`Porkbun DNS record ${want.name} is beneath a delegated child zone in the parent records; nothing was changed.`);
    }
    const here = all.filter((r) => r.name === want.name);
    const equal = here.filter((r) => r.type === want.type && r.content === want.content);
    // A CNAME is exclusive of every other type; never convert it or an ALIAS in place.
    if (here.some((r) => r.type === 'ALIAS' || (r.type === 'CNAME' || want.type === 'CNAME') && r.type !== want.type)) conflict(want);
    if (want.type === 'TXT' && isSpf(want.content)) {
      const spfs = here.filter((r) => r.type === 'TXT' && isSpf(r.content));
      if (spfs.length > 1) throw new Error(`Porkbun DNS: ${want.name} has multiple SPF records; merge them into one in the dashboard before retrying.`);
      const have = spfs[0];
      if (have) {
        const merged = mergeSpf(have.content, want.content, want.name);
        if (!merged.added.length) return 'unchanged';
        // Keep the owner's notes and mail policy; only add the newly approved sender mechanisms.
        return edit(ctx, zone, have, { ...want, content: merged.content, ttl: have.ttl });
      }
    }
    const singleton = ADDRESS.has(want.type) || want.type === 'TXT' && /(^|\.)_domainkey\./.test(want.name) || want.type === 'MX' && returnPath(want.content);
    const peers = singleton ? here.filter((r) => r.type === want.type) : [];
    if (want.type === 'MX' && returnPath(want.content) && peers.some((r) => !returnPath(r.content))) conflict(want);
    if (peers.length > 1) conflict(want);
    if (equal.length) {
      const same = equal[0]!;
      const priorityDrift = want.type === 'MX' && want.priority !== undefined && same.priority !== want.priority;
      const ttlDrift = want.ttl !== undefined && want.ttl !== 0 && same.ttl !== want.ttl;
      if (!priorityDrift && !ttlDrift) return 'unchanged';
      if (!owned(same)) conflict(want);
      return edit(ctx, zone, same, want);
    }
    if (peers.length) {
      if (!owned(peers[0]!)) conflict(want);
      return edit(ctx, zone, peers[0]!, want);
    }
    try {
      const result = await api(ctx, 'POST', `/dns/create/${encodeURIComponent(zone)}`, body(zone, want, 'golive: managed'));
      if (typeof result.id !== 'string' || !/^\d+$/.test(result.id)) throw new Error('Porkbun created a record but returned no valid record ID; re-plan before retrying.');
    } catch (e) {
      const duplicate = e instanceof PorkbunError && e.code === 'DUPLICATE_RECORD';
      if (!duplicate && !ambiguous(e)) throw e;
      const saved = (await records(ctx, zone)).filter((r) => matches(r, want));
      if (saved.length !== 1) {
        if (!duplicate) throw e;
        throw new Error('Porkbun reported a duplicate but the required record cannot be confirmed; re-plan.');
      }
      return 'unchanged';
    }
    ctx.log.info(`porkbun: created ${want.type} ${want.name}`);
    return 'created';
  },
};

async function auth(ctx: Ctx): Promise<AuthStatus> {
  try {
    const response = await api(ctx, 'GET', '/ping');
    // The API reference documents `credentialsValid: true`, but the getting-started guide's own
    // example omits it. A SUCCESS envelope already means the keys were read and accepted, so only an
    // explicit `false` refuses — a missing field must not fail the very first live call.
    if (response.credentialsValid === false) return { ok: false, howToFix: `Porkbun did not confirm this key pair. ${help()}` };
    return { ok: true, via: 'PORKBUN_API_KEY + PORKBUN_SECRET_API_KEY (API headers)' };
  } catch (e) { return { ok: false, howToFix: redact(e instanceof Error ? e.message : String(e)) }; }
}

export const porkbunAdapter: Adapter = {
  id: 'porkbun', title: 'Porkbun', axes: ['dns'], automated: true,
  detect: (d) => (d.providers.dns ?? []).includes('porkbun'),
  auth, capabilities: { dns: porkbunDns },
};
