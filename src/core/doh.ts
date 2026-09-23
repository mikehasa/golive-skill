import type { Ctx } from './types.js';

/**
 * Public DNS lookups over HTTPS (Cloudflare, falling back to Google). Used by checks (and guided
 * providers) to observe what the world sees, independent of any provider API.
 */
export type RRType = 'A' | 'AAAA' | 'CNAME' | 'TXT' | 'MX' | 'NS' | 'SOA' | 'CAA';
const TYPE_NUM: Record<number, RRType> = { 1: 'A', 28: 'AAAA', 5: 'CNAME', 16: 'TXT', 15: 'MX', 2: 'NS', 6: 'SOA', 257: 'CAA' };

export interface DohAnswer {
  name: string;
  type: RRType;
  /** Normalised: TXT unquoted + joined, trailing dots removed, lowercase for names. */
  data: string;
  ttl: number;
}

interface DohJson {
  Status: number;
  Answer?: Array<{ name: string; type: number; TTL: number; data: string }>;
  Authority?: Array<{ name: string; type: number; TTL: number; data: string }>;
}

export function normalizeTxt(data: string): string {
  // Cloudflare returns quoted, possibly split strings: "v=spf1 " "include:x ~all" ; Google returns joined.
  const parts = data.match(/"((?:[^"\\]|\\.)*)"/g);
  return parts ? parts.map((p) => p.slice(1, -1).replace(/\\"/g, '"')).join('') : data;
}

function norm(type: RRType, data: string): string {
  if (type === 'TXT') return normalizeTxt(data);
  if (type === 'CNAME' || type === 'NS') return data.replace(/\.$/, '').toLowerCase();
  if (type === 'MX') return data.replace(/\.$/, '').toLowerCase();
  return data;
}

export async function resolve(ctx: Ctx, name: string, type: RRType): Promise<{ status: number; answers: DohAnswer[]; authority: DohAnswer[] }> {
  const q = `name=${encodeURIComponent(name)}&type=${type}`;
  const endpoints = [`https://cloudflare-dns.com/dns-query?${q}`, `https://dns.google/resolve?${q}`];
  let lastErr: unknown;
  for (const url of endpoints) {
    try {
      const res = await ctx.http<DohJson>({ url, headers: { accept: 'application/dns-json' }, timeoutMs: 10_000 });
      if (res.status !== 200 || !res.json) throw new Error(`DoH ${res.status}`);
      const map = (rrs: DohJson['Answer'] = []) =>
        rrs.filter((a) => TYPE_NUM[a.type]).map((a) => ({ name: a.name.replace(/\.$/, '').toLowerCase(), type: TYPE_NUM[a.type]!, data: norm(TYPE_NUM[a.type]!, a.data), ttl: a.TTL }));
      return { status: res.json.Status, answers: map(res.json.Answer), authority: map(res.json.Authority) };
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(`DNS lookup failed for ${name} ${type}: ${String(lastErr)}`);
}

/** Values of `type` at exactly `name` (CNAME chains excluded unless type is CNAME). */
export async function lookup(ctx: Ctx, name: string, type: RRType): Promise<string[]> {
  const r = await resolve(ctx, name, type);
  return r.answers.filter((a) => a.type === type && a.name === name.toLowerCase()).map((a) => a.data);
}

/** The zone apex for a hostname (via SOA), e.g. "app.example.co.uk" -> "example.co.uk". */
export async function zoneApex(ctx: Ctx, host: string): Promise<string | null> {
  const r = await resolve(ctx, host, 'SOA');
  const soa = [...r.answers, ...r.authority].find((a) => a.type === 'SOA');
  return soa ? soa.name : null;
}

/** Who serves DNS for a domain: 'cloudflare' | 'vercel' | other NS host | null. */
export async function dnsHost(ctx: Ctx, domain: string): Promise<{ provider: string | null; nameservers: string[] }> {
  const apex = (await zoneApex(ctx, domain)) ?? domain;
  const ns = await lookup(ctx, apex, 'NS');
  const provider = ns.some((n) => n.endsWith('.ns.cloudflare.com')) ? 'cloudflare' : ns.some((n) => n.endsWith('vercel-dns.com')) ? 'vercel' : ns[0] ? ns[0].split('.').slice(-2).join('.') : null;
  return { provider, nameservers: ns };
}
