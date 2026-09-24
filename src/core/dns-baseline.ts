/**
 * Machine-readable baselines for the DNS records golive writes.
 *
 * A step's `changes` lines are prose for humans; drift needs the facts. Every DNS upsert golive
 * performs records what it wrote under one documented resource-key namespace in
 * `.golive/state.json` (`resources` is open-ended, so the state schema stays version 1):
 *
 *   dns:<zone>|<TYPE>|<name>   ->   {"provider","zone","type","name","content","priority?","at"}
 *
 * Readers of other namespaces ignore these keys by construction — `teardown` and `inventory` only
 * match their own key shapes, and no key here can be mistaken for a resource id, an endpoint id or a
 * creation marker. Record values are public DNS data (a record's content is what every resolver
 * sees); no credential, secret value or secret fingerprint is stored here.
 */
import type { DnsRecord, ShipState, StepContext } from './types.js';

export const DNS_BASELINE_PREFIX = 'dns:';

/** What golive recorded about one DNS record it wrote, refreshed by each later write of it. */
export interface DnsBaseline {
  /** Adapter id that performed the write (e.g. 'porkbun'). */
  provider: string;
  /** The zone the record lives in (lowercase, no trailing dot). */
  zone: string;
  type: DnsRecord['type'];
  name: string;
  content: string;
  priority?: number;
  /** When the write that produced this content landed. */
  at: string;
}

const BASELINE_TYPES: ReadonlySet<string> = new Set(['A', 'AAAA', 'CNAME', 'TXT', 'MX', 'CAA']);

const normName = (n: string): string => n.trim().replace(/\.$/, '').toLowerCase();

/** The state key a written record is recorded under. */
export function dnsBaselineKey(zone: string, record: Pick<DnsRecord, 'type' | 'name'>): string {
  return `${DNS_BASELINE_PREFIX}${normName(zone)}|${record.type}|${normName(record.name)}`;
}

/**
 * Record what an upsert left in the zone. `unchanged` keeps the time of the write that actually
 * landed: the propagation window belongs to that write, not to a later re-confirmation.
 */
export function rememberDnsWrite(sctx: StepContext, zone: string, provider: string, record: DnsRecord, outcome: 'created' | 'updated' | 'unchanged'): void {
  const key = dnsBaselineKey(zone, record);
  const at = outcome === 'unchanged' ? (parseBaseline(sctx.state.resource(key))?.at ?? new Date().toISOString()) : new Date().toISOString();
  const baseline: DnsBaseline = {
    provider,
    zone: normName(zone),
    type: record.type,
    name: normName(record.name),
    content: record.content,
    ...(record.priority !== undefined ? { priority: record.priority } : {}),
    at,
  };
  sctx.remember(key, JSON.stringify(baseline));
}

/** Every DNS baseline recorded in state, in state-key order. Foreign or unreadable values are skipped. */
export function readDnsBaselines(state: ShipState): DnsBaseline[] {
  const out: DnsBaseline[] = [];
  for (const [key, value] of Object.entries(state.resources).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (!key.startsWith(DNS_BASELINE_PREFIX)) continue;
    const b = parseBaseline(value);
    if (b) out.push(b);
  }
  return out;
}

/** Does this state key hold a golive DNS baseline? (key shape only, no parsing) */
export function isDnsBaselineKey(key: string): boolean {
  return key.startsWith(DNS_BASELINE_PREFIX);
}

function parseBaseline(value: string | undefined): DnsBaseline | null {
  if (!value) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(value);
  } catch {
    return null;
  }
  const b = raw as Partial<DnsBaseline>;
  if (typeof b !== 'object' || b === null) return null;
  if (typeof b.provider !== 'string' || typeof b.zone !== 'string' || typeof b.type !== 'string' || !BASELINE_TYPES.has(b.type)) return null;
  if (typeof b.name !== 'string' || typeof b.content !== 'string' || typeof b.at !== 'string') return null;
  return {
    provider: b.provider,
    zone: normName(b.zone),
    type: b.type as DnsRecord['type'],
    name: normName(b.name),
    content: b.content,
    ...(typeof b.priority === 'number' ? { priority: b.priority } : {}),
    at: b.at,
  };
}
