import type { DnsRecord } from '../core/types.js';
import { normalizeTxt } from '../core/doh.js';

/** One entry of Resend's `records[]` (GET /domains/{id}). Unknown fields are ignored. */
export interface ResendRecord {
  record?: string; // "SPF" | "DKIM" | "Tracking" | …
  name?: string;
  type?: string;
  value?: string;
  ttl?: string | number;
  priority?: number | string;
  status?: string;
}

const TYPES = new Set<DnsRecord['type']>(['A', 'AAAA', 'CNAME', 'TXT', 'MX', 'CAA']);

const clean = (s: string): string => s.trim().replace(/\.$/, '').toLowerCase();

/**
 * Resend record names are relative (`send`, `resend._domainkey`) for SPF/DKIM but FQDN for Tracking.
 * For a subdomain sending domain (`updates.example.com`) they may also be relative to the APEX zone
 * (`send.updates`). Without a public-suffix list the apex is not guessed: every split of the domain
 * into `<sub>.<parent>` (longest sub first, parent at least two labels) is tried, and a name ending in
 * `<sub>` is completed with that parent. So `send.notify.app` for `notify.app.hey.io` becomes
 * `send.notify.app.hey.io`, and `send.mail` for `mail.example.co.uk` becomes `send.mail.example.co.uk`.
 */
export function fqdnFor(name: string | undefined, domain: string): string {
  const d = clean(domain);
  const n = clean(name ?? '');
  if (!n || n === '@') return d;
  if (n === d || n.endsWith(`.${d}`)) return n;
  const labels = d.split('.');
  // Already an FQDN elsewhere under the registrable part (e.g. Tracking `links.example.com` for `updates.example.com`).
  if (labels.length > 2 && n.endsWith(`.${labels.slice(-2).join('.')}`)) return n;
  for (let k = 2; k < labels.length; k++) {
    const sub = labels.slice(0, -k).join('.');
    const parent = labels.slice(-k).join('.');
    if (n === sub || n.endsWith(`.${sub}`)) return `${n}.${parent}`;
  }
  return `${n}.${d}`;
}

/**
 * Normalise Resend's records into DnsRecords the DNS adapter can upsert as-is. Handles MX+TXT SPF on
 * `send`, CNAME-style SPF (post-Aug-2026), TXT DKIM and 3× CNAME DKIM. Mail records are never proxied.
 */
export function normalizeRecords(domain: string, records: ResendRecord[] | undefined, warn?: (msg: string) => void): DnsRecord[] {
  const out: DnsRecord[] = [];
  const seen = new Set<string>();
  for (const r of records ?? []) {
    const type = String(r.type ?? '').toUpperCase() as DnsRecord['type'];
    if (!TYPES.has(type) || !r.value) {
      warn?.(`skipping Resend ${r.record ?? 'DNS'} record with unsupported type "${r.type ?? '?'}" at ${r.name ?? '?'}`);
      continue;
    }
    const rec: DnsRecord = { type, name: fqdnFor(r.name, domain), content: contentFor(type, r.value), proxied: false };
    if (type === 'MX') rec.priority = toInt(r.priority) ?? 10;
    const ttl = toInt(r.ttl);
    if (ttl !== undefined) rec.ttl = ttl;
    const k = `${rec.type}|${rec.name}|${rec.content}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(rec);
  }
  return out;
}

function contentFor(type: DnsRecord['type'], value: string): string {
  if (type === 'TXT') return normalizeTxt(value.trim());
  if (type === 'CNAME' || type === 'MX') return clean(value);
  return value.trim();
}

function toInt(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
}
