import { domainToASCII } from 'node:url';
import type { Adapter, AuthStatus, Ctx, DnsRecord, DnsZone, HttpResponse } from '../core/types.js';
import { Secret, fingerprint, redact } from '../core/secret.js';
import { normalizeTxt } from '../core/doh.js';
import { tokenHowTo } from '../core/credentials.js';
import { isSpf, mergeSpf } from './cloudflare-spf.js';

/**
 * Cloudflare DNS over the REST API with a scoped API token (CLOUDFLARE_API_TOKEN). `wrangler login`
 * can't be used: its OAuth client has no dns_records scope, so every write would 403.
 */

const API = 'https://api.cloudflare.com/client/v4';
/** Ownership marker. `comment` works on every plan; `tags` are Pro+ only. */
const COMMENT = 'golive: managed';
const OWNED_PREFIX = 'golive:';
const TYPES = new Set<string>(['A', 'AAAA', 'CNAME', 'TXT', 'MX', 'CAA']);
const ADDRESS = new Set<string>(['A', 'AAAA', 'CNAME']);
const IDENTICAL_EXISTS = 81058;

/** Cloudflare has no usable CLI login for DNS (`wrangler login` lacks the dns_records scope), so it is token-only. */
function tokenHelp(): string {
  return (
    'Create a token in the Cloudflare dashboard (My Profile -> API Tokens -> Create Token): start from the "Edit zone DNS" template ' +
    "(Zone:DNS:Edit), add Zone:Zone:Read, and limit Zone Resources to your domain's zone. " +
    `${tokenHowTo('CLOUDFLARE_API_TOKEN')} Then re-run golive. Note: \`wrangler login\` cannot write DNS records.`
  );
}

// ── Transport ───────────────────────────────────────────────────────────────────────────────────

interface Envelope<T> {
  success?: boolean;
  errors?: Array<{ code: number; message: string }>;
  result?: T;
  result_info?: { page?: number; total_pages?: number };
}

export class CloudflareError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly codes: number[],
  ) {
    super(message);
  }
}

function token(ctx: Ctx): Secret | undefined {
  return ctx.envToken('CLOUDFLARE_API_TOKEN') ?? ctx.envToken('CF_API_TOKEN');
}

function requireToken(ctx: Ctx): Secret {
  const t = token(ctx);
  if (!t) throw new Error(`Cloudflare DNS: no CLOUDFLARE_API_TOKEN is available to golive. ${tokenHelp()}`);
  return t;
}

/**
 * `idempotent`: safe to re-send after a 5xx/timeout. PATCHes here set fixed field values, so they are;
 * creates (POST) are not.
 */
async function api<T>(ctx: Ctx, method: 'GET' | 'POST' | 'PATCH', path: string, what: string, body?: unknown, idempotent = false): Promise<Envelope<T>> {
  const t = requireToken(ctx);
  const res = await ctx.http<Envelope<T>>({
    method,
    url: API + path,
    headers: { authorization: new Secret(t.name, `Bearer ${t.reveal()}`) },
    ...(body === undefined ? {} : { body }),
    ...(idempotent ? { idempotent: true } : {}),
  });
  if (res.status >= 200 && res.status < 300 && res.json?.success !== false) return res.json ?? {};
  throw apiError(what, res);
}

function apiError(what: string, res: HttpResponse<Envelope<unknown>>): CloudflareError {
  const errs = res.json?.errors ?? [];
  const codes = errs.map((e) => e.code);
  const detail = errs.length ? errs.map((e) => `[${e.code}] ${e.message}`).join('; ') : res.text.slice(0, 200);
  let hint = '';
  if (res.status === 429) {
    hint = ` Cloudflare rate limit reached; wait ${res.headers['retry-after'] ?? 'a few'} seconds (up to 5 minutes) and re-run.`;
  } else if (res.status === 401 || codes.some((c) => [1000, 6003, 6111, 9106, 9107].includes(c))) {
    hint = ` The API token is missing, malformed, expired or revoked. ${tokenHelp()}`;
  } else if (res.status === 403 || codes.some((c) => [9109, 10000].includes(c))) {
    hint =
      ' The token lacks permission for this zone: it needs Zone:DNS:Edit (plus Zone:Zone:Read to look the zone up) ' +
      'with this zone included in its Zone Resources. Edit the token under My Profile -> API Tokens.';
  }
  return new CloudflareError(redact(`Cloudflare ${what} failed: HTTP ${res.status} ${detail}.${hint}`), res.status, codes);
}

// ── Names / zones ───────────────────────────────────────────────────────────────────────────────

function normName(n: string): string {
  const s = n.trim().replace(/\.$/, '').toLowerCase();
  return domainToASCII(s) || s;
}

/** "a.b.example.com" -> ["a.b.example.com", "b.example.com", "example.com"]. */
function zoneCandidates(domain: string): string[] {
  const labels = normName(domain).split('.');
  const out: string[] = [];
  for (let i = 0; i <= labels.length - 2; i++) out.push(labels.slice(i).join('.'));
  return out;
}

const inZone = (name: string, zone: string): boolean => name === zone || name.endsWith(`.${zone}`);
const zoneKey = (apex: string): string => `cloudflare.zoneId:${apex}`;

interface Zone {
  id: string;
  name: string;
}

async function findZone(ctx: Ctx, domain: string, ignoreCache = false): Promise<{ zone: Zone; cached: boolean } | null> {
  const names = zoneCandidates(domain);
  if (!ignoreCache) {
    for (const n of names) {
      const id = ctx.state.resource(zoneKey(n));
      if (id) return { zone: { id, name: n }, cached: true };
    }
  }
  for (const n of names) {
    const env = await api<Array<{ id: string; name: string; status?: string }>>(ctx, 'GET', `/zones?name=${encodeURIComponent(n)}&status=active&per_page=5`, `zone lookup for ${n}`);
    const z = (env.result ?? []).find((x) => normName(x.name) === n && (x.status ?? 'active') === 'active');
    if (z) {
      ctx.state.save((s) => void (s.resources[zoneKey(n)] = z.id));
      return { zone: { id: z.id, name: n }, cached: false };
    }
  }
  return null;
}

async function requireZone(ctx: Ctx, domain: string): Promise<{ zone: Zone; cached: boolean }> {
  const found = await findZone(ctx, domain);
  if (found) return found;
  throw new Error(
    `No active Cloudflare zone for ${normName(domain)} is visible to this API token (tried ${zoneCandidates(domain).join(', ')}). ` +
      'Either the domain is not in this Cloudflare account, its nameservers are not yet delegated to Cloudflare (zone status "pending": ' +
      'set the nameservers Cloudflare shows at your registrar), or the token is scoped to other zones (add this zone to its Zone Resources).',
  );
}

/**
 * Run a zone-scoped operation, re-resolving once when a zone id cached in state went stale (the zone
 * was deleted/recreated, or the token re-scoped). A 404/403 against a cached id means nothing was
 * written there, so one re-resolution + retry is safe; a fresh lookup's failure is not retried.
 */
async function withZone<T>(ctx: Ctx, domain: string, run: (zone: Zone) => Promise<T>): Promise<T> {
  const { zone, cached } = await requireZone(ctx, domain);
  try {
    return await run(zone);
  } catch (e) {
    if (!cached || !(e instanceof CloudflareError) || (e.status !== 404 && e.status !== 403)) throw e;
    ctx.state.save((s) => {
      delete s.resources[zoneKey(zone.name)];
    });
    const fresh = await findZone(ctx, domain, true);
    if (!fresh) throw e;
    return run(fresh.zone);
  }
}

// ── Records ─────────────────────────────────────────────────────────────────────────────────────

interface CfRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  ttl?: number;
  priority?: number;
  proxied?: boolean;
  comment?: string | null;
}

async function fetchRecords(ctx: Ctx, zone: Zone, query = ''): Promise<CfRecord[]> {
  const out: CfRecord[] = [];
  for (let page = 1; ; page++) {
    const env = await api<CfRecord[]>(ctx, 'GET', `/zones/${zone.id}/dns_records?per_page=5000&page=${page}${query ? `&${query}` : ''}`, `list DNS records in ${zone.name}`);
    for (const r of env.result ?? []) {
      out.push({ id: r.id, type: r.type, name: r.name, content: r.content, ttl: r.ttl, priority: r.priority, proxied: r.proxied, comment: r.comment });
    }
    if (page >= (env.result_info?.total_pages ?? 1)) return out;
  }
}

function normContent(type: string, content: string): string {
  if (type === 'TXT') return normalizeTxt(content);
  if (type === 'CNAME' || type === 'MX') return content.trim().replace(/\.$/, '').toLowerCase();
  if (type === 'AAAA') return content.trim().toLowerCase();
  return content.trim().replace(/\s+/g, ' ');
}

function toDnsRecord(r: CfRecord): DnsRecord {
  const rec: DnsRecord = { type: r.type as DnsRecord['type'], name: normName(r.name), content: normContent(r.type, r.content) };
  if (r.ttl !== undefined) rec.ttl = r.ttl;
  if (r.priority !== undefined) rec.priority = r.priority;
  if (r.proxied !== undefined) rec.proxied = r.proxied;
  return rec;
}

const isOwned = (r: CfRecord): boolean => (r.comment ?? '').startsWith(OWNED_PREFIX);
const describe = (r: { type: string; content: string; proxied?: boolean }): string => `${r.type} ${short(r.content)}${r.proxied ? ' (proxied)' : ''}`;
const short = (s: string): string => (s.length > 80 ? `${s.slice(0, 77)}...` : s);

/** State key for a record golive created or adopted, so later runs can find it by id. */
function recordKey(want: DnsRecord): string {
  if (ADDRESS.has(want.type)) return `cloudflare.recordId:${want.type}:${want.name}`;
  if (want.type === 'TXT' && isSpf(want.content)) return `cloudflare.recordId:TXT:${want.name}:spf`;
  return `cloudflare.recordId:${want.type}:${want.name}:${fingerprint(want.content)}`;
}

function remember(ctx: Ctx, want: DnsRecord, id: string): void {
  if (ctx.state.resource(recordKey(want)) !== id) ctx.state.save((s) => void (s.resources[recordKey(want)] = id));
}

/** A record whose content was replaced in place: drop state keys that fingerprinted its old content. */
function forgetStale(ctx: Ctx, want: DnsRecord, id: string): void {
  const prefix = `cloudflare.recordId:${want.type}:${want.name}:`;
  const keep = recordKey(want);
  ctx.state.save((s) => {
    for (const [k, v] of Object.entries(s.resources)) if (k.startsWith(prefix) && k !== keep && v === id) delete s.resources[k];
  });
}

/**
 * Records that exist once per name even though TXT/MX normally live alongside other values:
 *   - a DKIM public key at `<selector>._domainkey.<domain>` (two keys at one selector = DKIM fails intermittently)
 *   - an SES/Resend return-path MX (`feedback-smtp.<region>.amazonses.com`; two regions = Resend rejects it)
 * Returns the kind, so existing records of the same kind at the name can be replaced instead of added to.
 */
type SingleKind = 'dkim' | 'return-path';
const RETURN_PATH_MX = /^feedback-smtp(\.[a-z0-9-]+)?\.amazonses\.com$/;
function singleKind(type: string, name: string, content: string): SingleKind | null {
  if (type === 'TXT' && /(^|\.)_domainkey\./.test(name) && (/(^|;)\s*p=/i.test(content) || /^v=DKIM1(;|\s|$)/i.test(content))) return 'dkim';
  if (type === 'MX' && RETURN_PATH_MX.test(content)) return 'return-path';
  return null;
}

/** A/AAAA/CNAME exclusivity: a CNAME conflicts with any address record; A/AAAA with a CNAME or a differing A/AAAA. */
function conflictsWith(want: string, have: string): boolean {
  return want === 'CNAME' ? ADDRESS.has(have) : have === 'CNAME' || have === want;
}

/**
 * A CNAME cannot share a name with any other record (RFC 1034). Address records are handled by
 * replaceOwned; anything else (TXT/MX/CAA/NS/…) is never converted or deleted, so fail clearly before
 * writing instead of letting Cloudflare answer with an opaque 400. The zone apex is exempt: Cloudflare
 * flattens an apex CNAME, so it may sit next to MX/TXT there.
 */
function cnameExclusivity(zone: Zone, here: CfRecord[], want: DnsRecord): void {
  if (want.name === zone.name) return;
  const blocking = want.type === 'CNAME' ? here.filter((r) => !ADDRESS.has(r.type)) : here.filter((r) => r.type === 'CNAME');
  if (!blocking.length) return;
  const mail = [want.content, ...blocking.map((r) => r.content)].some((c) => /amazonses|resend/i.test(c)) || want.name.startsWith('send.');
  throw new Error(
    `Cloudflare DNS conflict at ${want.name}: golive needs ${describe(want)}, but the zone already has ${blocking.map(describe).join(', ')}; ` +
      'a CNAME cannot share a name with other records, so nothing was changed. Delete the conflicting record(s) in the Cloudflare dashboard (DNS -> Records) if they are no longer used, then re-run.' +
      (mail
        ? ' If they belong to another mail setup you still need, instead recreate the Resend domain with a different custom return path (e.g. `bounce`) so its records use another name.'
        : ''),
  );
}

function caaData(content: string): { flags: number; tag: string; value: string } {
  const m = /^(\d+)\s+(\S+)\s+"?(.*?)"?$/.exec(content.trim());
  if (!m) throw new Error(`CAA content must look like '0 issue "letsencrypt.org"', got '${content}'`);
  return { flags: Number(m[1]), tag: m[2]!, value: m[3]! };
}

async function patch(ctx: Ctx, zone: Zone, id: string, body: Record<string, unknown>, what: string): Promise<void> {
  // PATCH, never PUT: PUT resets every field we don't send (comment, settings).
  await api(ctx, 'PATCH', `/zones/${zone.id}/dns_records/${id}`, what, { ...body, proxied: false }, true);
}

async function create(ctx: Ctx, zone: Zone, want: DnsRecord): Promise<'created' | 'unchanged'> {
  const body: Record<string, unknown> = { type: want.type, name: want.name, ttl: want.ttl ?? 1, proxied: false, comment: COMMENT };
  if (want.type === 'CAA') body.data = caaData(want.content);
  else body.content = want.content;
  if (want.type === 'MX') body.priority = want.priority ?? 10;
  try {
    const env = await api<{ id: string }>(ctx, 'POST', `/zones/${zone.id}/dns_records`, `create ${want.type} ${want.name}`, body);
    if (env.result?.id) remember(ctx, want, env.result.id);
  } catch (e) {
    if (e instanceof CloudflareError && e.codes.includes(IDENTICAL_EXISTS)) return 'unchanged';
    throw e;
  }
  ctx.log.info(`cloudflare: created ${want.type} ${want.name} -> ${short(want.content)}`);
  return 'created';
}

/** Same name+type+content already exists: adopt it; fix proxy/priority/TTL drift only on records we own. */
async function adopt(ctx: Ctx, zone: Zone, have: CfRecord, want: DnsRecord): Promise<'updated' | 'unchanged'> {
  remember(ctx, want, have.id);
  const fix: Record<string, unknown> = {};
  if (have.proxied && ADDRESS.has(have.type)) fix.proxied = false;
  if (want.ttl !== undefined && have.ttl !== want.ttl) fix.ttl = want.ttl;
  if (want.type === 'MX' && want.priority !== undefined && have.priority !== want.priority) fix.priority = want.priority;
  if (!Object.keys(fix).length) return 'unchanged';
  if (!isOwned(have)) {
    const drift = [
      fix.proxied === false ? 'is proxied (orange cloud)' : null,
      fix.priority !== undefined ? `has priority ${have.priority}` : null,
      fix.ttl !== undefined ? `has TTL ${have.ttl}` : null,
    ]
      .filter(Boolean)
      .join(' and ');
    ctx.log.warn(
      `cloudflare: ${want.type} ${want.name} already has the right value but ${drift}; ` +
        'golive did not create it, so it is left as is. Switch it to "DNS only" / the expected priority or TTL in the Cloudflare dashboard if the provider cannot verify it.',
    );
    return 'unchanged';
  }
  await patch(ctx, zone, have.id, fix, `update ${want.type} ${want.name}`);
  ctx.log.info(`cloudflare: updated ${want.type} ${want.name} (${Object.keys(fix).join(', ')})`);
  return 'updated';
}

async function mergeSpfAt(ctx: Ctx, zone: Zone, here: CfRecord[], want: DnsRecord): Promise<'created' | 'updated' | 'unchanged'> {
  const spfs = here.filter((r) => r.type === 'TXT' && isSpf(normalizeTxt(r.content)));
  if (!spfs.length) return create(ctx, zone, want);
  if (spfs.length > 1) {
    throw new Error(
      `${want.name} already has ${spfs.length} SPF (v=spf1) TXT records, which makes SPF fail for every message (RFC 7208 permerror). ` +
        'Merge them into a single v=spf1 record in the Cloudflare dashboard, then re-run.',
    );
  }
  const cur = spfs[0]!;
  const merged = mergeSpf(normalizeTxt(cur.content), want.content, want.name);
  remember(ctx, want, cur.id);
  if (!merged.added.length) return 'unchanged';
  // Only the content changes; the record's existing comment (possibly the owner's) is kept.
  await patch(ctx, zone, cur.id, { content: merged.content }, `update SPF at ${want.name}`);
  ctx.log.info(`cloudflare: added ${merged.added.join(' ')} to SPF at ${want.name}`);
  return 'updated';
}

async function replaceOwned(ctx: Ctx, zone: Zone, conflicts: CfRecord[], want: DnsRecord): Promise<'updated'> {
  const foreign = conflicts.filter((r) => !isOwned(r));
  if (foreign.length) {
    throw new Error(
      `Cloudflare DNS conflict at ${want.name}: golive needs ${describe(want)}, but the zone already has ${foreign.map(describe).join(', ')}, ` +
        'which golive did not create, so it will not overwrite it. Either delete or edit that record in the Cloudflare dashboard (DNS -> Records), ' +
        `or set its comment to start with "${OWNED_PREFIX}" to let golive manage it, then re-run.`,
    );
  }
  if (conflicts.length > 1) {
    throw new Error(
      `Cloudflare DNS: ${want.name} has ${conflicts.length} golive-managed records (${conflicts.map(describe).join(', ')}) where one ${want.type} is expected. ` +
        'Delete the extra ones in the Cloudflare dashboard, then re-run.',
    );
  }
  const have = conflicts[0]!;
  const body: Record<string, unknown> = { type: want.type, content: want.content, ttl: want.ttl ?? 1, comment: COMMENT };
  if (want.type === 'MX') body.priority = want.priority ?? 10;
  await patch(ctx, zone, have.id, body, `update ${want.type} ${want.name}`);
  forgetStale(ctx, want, have.id);
  remember(ctx, want, have.id);
  ctx.log.info(`cloudflare: updated ${want.name}: ${describe(have)} -> ${describe(want)}`);
  return 'updated';
}

function normalizeWanted(record: DnsRecord): DnsRecord {
  const w: DnsRecord = { ...record, name: normName(record.name), content: normContent(record.type, record.content) };
  if (!TYPES.has(w.type)) throw new Error(`Cloudflare DNS: unsupported record type ${String(w.type)}`);
  return w;
}

// ── Capability ──────────────────────────────────────────────────────────────────────────────────

export const cloudflareDns: DnsZone = {
  async hosts(ctx, domain) {
    return (await findZone(ctx, domain)) !== null;
  },

  async list(ctx, domain) {
    return withZone(ctx, domain, async (zone) => (await fetchRecords(ctx, zone)).filter((r) => TYPES.has(r.type)).map(toDnsRecord));
  },

  async upsert(ctx, domain, record) {
    return withZone(ctx, domain, async (zone) => {
      const want = normalizeWanted(record);
      if (!inZone(want.name, zone.name)) throw new Error(`Cloudflare DNS: ${want.name} is not inside the zone ${zone.name}; nothing was changed.`);

      const here = (await fetchRecords(ctx, zone, `name.exact=${encodeURIComponent(want.name)}`)).filter((r) => normName(r.name) === want.name);
      const same = here.find((r) => r.type === want.type && normContent(r.type, r.content) === want.content);
      if (same) return adopt(ctx, zone, same, want);
      cnameExclusivity(zone, here, want);
      if (want.type === 'TXT' && isSpf(want.content)) return mergeSpfAt(ctx, zone, here, want);
      if (ADDRESS.has(want.type)) {
        const conflicts = here.filter((r) => conflictsWith(want.type, r.type));
        if (conflicts.length) return replaceOwned(ctx, zone, conflicts, want);
      }
      const kind = singleKind(want.type, want.name, want.content);
      if (kind) {
        // A stale DKIM key / other-region return path (e.g. the Resend domain was recreated) is replaced, not added to.
        const stale = here.filter((r) => r.type === want.type && singleKind(r.type, want.name, normContent(r.type, r.content)) === kind);
        if (stale.length) return replaceOwned(ctx, zone, stale, want);
      }
      return create(ctx, zone, want); // other TXT / MX / CAA live alongside existing values
    });
  },
};

// ── Auth ────────────────────────────────────────────────────────────────────────────────────────

async function verify(ctx: Ctx, path: string): Promise<string | undefined> {
  const env = await api<{ status?: string }>(ctx, 'GET', path, 'API token check');
  return env.result?.status;
}

async function auth(ctx: Ctx): Promise<AuthStatus> {
  const t = token(ctx);
  if (!t) {
    const legacy = ctx.envToken('CLOUDFLARE_API_KEY')
      ? 'CLOUDFLARE_API_KEY (the Global API Key) is set, but golive refuses it because it can change everything in your account. '
      : '';
    return { ok: false, howToFix: `${legacy}No CLOUDFLARE_API_TOKEN is available to golive. ${tokenHelp()}` };
  }
  const via = `${t.name} env (API token)`;
  try {
    let status: string | undefined;
    try {
      status = await verify(ctx, '/user/tokens/verify');
    } catch (e) {
      // Account-owned tokens only verify under their account.
      const account = ctx.env('CLOUDFLARE_ACCOUNT_ID') ?? ctx.envToken('CLOUDFLARE_ACCOUNT_ID')?.reveal();
      if (!account) throw e;
      status = await verify(ctx, `/accounts/${encodeURIComponent(account)}/tokens/verify`);
    }
    if (status === 'active') return { ok: true, via };
    return { ok: false, via, howToFix: `Your ${t.name} is ${status ?? 'not active'} (expired or disabled). ${tokenHelp()}` };
  } catch (e) {
    // apiError already carries the fix (new token / missing permission / rate limit).
    return { ok: false, via, howToFix: redact(e instanceof Error ? e.message : String(e)) };
  }
}

export const cloudflareAdapter: Adapter = {
  id: 'cloudflare',
  title: 'Cloudflare',
  axes: ['dns'],
  automated: true,
  detect: (d) => (d.providers.dns ?? []).includes('cloudflare'),
  auth,
  capabilities: { dns: cloudflareDns },
};
