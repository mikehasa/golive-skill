/**
 * Drift: does the world still match what golive recorded?
 *
 * A check proves that something holds NOW; drift asks a different question — has anything changed
 * behind golive's back since golive recorded what it did. That needs the recorded baseline, which is
 * why this is its own read-only command (`golive status`) and not a check: a check's report is release
 * evidence and a plan is an intent, and neither may be gated by a comparison that needs an unapproved
 * decision. Nothing here writes to a provider or a file, reads a billing endpoint, or re-baselines
 * silently: only a new approved write moves a baseline.
 *
 * Every item pairs a recorded baseline with a fresh read and labels both:
 *   expected — recorded by golive <time> (<ref>)   vs   observed — read now <time>
 * `baseline.source` says where the recorded side came from:
 *   - `state`: a fact golive wrote about what it did (a DNS record baseline, an env name, a project id,
 *     recorded connection selectors, the pending-redeploy marker);
 *   - `provider-marker`: an id a provider assigned to a resource golive created (a webhook endpoint,
 *     a sending domain, the host project's recorded creation marker);
 *   - `step-evidence`: a step record golive wrote (a DNS step with no per-record baseline, a failed
 *     step, a production env write no deploy has picked up).
 *
 * A read that could not happen is `unverifiable: true` with `action: 'none'` — never drift, and never
 * "clean": the report names what was compared (`verified`) and what was not (`notChecked`). One read
 * per subject per invocation, through the per-run cache.
 */
import type { Ctx, DnsRecord, EnvTarget, Mode, Plan, ProjectRef, ReleaseIdentity, ShipState, Step, StepRecord } from './types.js';
import { modeFor } from './config.js';
import { adapterFor } from './caps.js';
import { dnsHost, lookup as dohLookup, type RRType } from './doh.js';
import { dnsBaselineKey, readDnsBaselines, type DnsBaseline } from './dns-baseline.js';
import { createdProjectKey, projectStateKeys } from './inventory.js';
import { sameRelease } from './release.js';
import { readOnlyStateStore } from './state.js';
import { PROPAGATION_MS } from '../checks/domain.js';
import { accountStatus } from '../checks/providers.js';
import { satisfies } from '../links/domain.js';
import { emailDomain, formatRecord } from '../links/email.js';
import { axisStatus, errMsg, envSourceKey, joinUrl, pendingRedeploy, productionUrl, type AxisStatus } from '../links/util.js';

/** What kind of recorded fact an item compares: one class per read that already exists. */
export type DriftClass =
  | 'dns-record'
  | 'dns-delegation'
  | 'dns-public'
  | 'env-name'
  | 'webhook-endpoint'
  | 'domain-attach'
  | 'db-selectors'
  | 'email-domain'
  | 'sending-key'
  | 'payment-account'
  | 'host-project'
  | 'release-state';

/** high = the app is broken · medium = hygiene/teardown safety or a change that may be deliberate · info = nothing to do. */
export type DriftSeverity = 'high' | 'medium' | 'info';
export type DriftAction = 'none' | 'verify' | 'reconcile' | 'human';

/** Where the recorded side of an item comes from (see the module header). */
export interface DriftBaseline {
  source: 'state' | 'provider-marker' | 'step-evidence';
  /** When golive recorded it (ISO), when state holds a time. */
  at?: string;
  /** What to read to find it: a state key, a step id, a marker key. */
  ref?: string;
}

export interface DriftItem {
  id: string;
  class: DriftClass;
  subject: string;
  expected: string;
  observed: string;
  baseline: DriftBaseline;
  severity: DriftSeverity;
  action: DriftAction;
  evidence: string[];
  suggestedAction?: string;
  /** An existing check that re-verifies this subject. */
  checkId?: string;
  /** golive could not perform the read: not drift, and not evidence that nothing changed. */
  unverifiable?: boolean;
}

export interface DriftReport {
  version: 1;
  generatedAt: string;
  release: { name: string; version: string; bundleDigest: string; ref: string | null };
  app: { root: string; framework: string; domain?: string };
  items: DriftItem[];
  /** Subjects golive read this run and found unchanged: everything a "clean" statement may cover. */
  verified: string[];
  /** Subjects golive could not compare, with the reason. Never reported as clean. */
  notChecked: Array<{ subject: string; reason: string }>;
  /** Standing limits of this comparison, independent of the provider reads. */
  limits: string[];
  summary: { items: number; actionable: number; unverifiable: number; high: number; medium: number; info: number };
}

interface Collected {
  items: DriftItem[];
  verified: string[];
  notChecked: Array<{ subject: string; reason: string }>;
  limits: string[];
}

/**
 * Read every recorded subject once and compare it with the world. Read-only: nothing is written.
 * `plan` is the plan this release would run now, observed by the caller (never applied): a failed
 * step's drift item needs it to say whether `apply` could replay that step at all. `null` means the
 * caller could not observe one.
 */
export async function detectDrift(ctx: Ctx, plan?: Plan | null): Promise<DriftReport> {
  const at = new Date().toISOString();
  const read = readOnlyContext(ctx);
  const c: Collected = { items: [], verified: [], notChecked: [], limits: [STANDING_LIMIT] };
  await dnsItems(read, at, c);
  await envItems(read, at, c);
  await webhookItems(read, at, c);
  await domainItems(read, at, c);
  await dbItems(read, at, c);
  await emailItems(read, at, c);
  keyItems(read, c);
  await paymentItems(read, at, c);
  await hostItems(read, at, c);
  releaseItems(read, at, c, plan);
  const items = c.items.sort((a, b) => RANK[a.severity] - RANK[b.severity] || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const count = (s: DriftSeverity): number => items.filter((i) => i.severity === s).length;
  return {
    version: 1,
    generatedAt: at,
    release: { name: ctx.release.name, version: ctx.release.version, bundleDigest: ctx.release.bundleDigest, ref: ctx.release.source.ref },
    app: { root: ctx.cwd, framework: ctx.detect.framework, ...(ctx.config.domain ? { domain: ctx.config.domain } : {}) },
    items,
    verified: [...new Set(c.verified)].sort(),
    notChecked: c.notChecked,
    limits: [...new Set(c.limits)],
    summary: {
      items: items.length,
      actionable: items.filter((i) => i.action !== 'none').length,
      unverifiable: items.filter((i) => i.unverifiable === true).length,
      high: count('high'),
      medium: count('medium'),
      info: count('info'),
    },
  };
}

const RANK: Record<DriftSeverity, number> = { high: 0, medium: 1, info: 2 };

/**
 * What a clean statement cannot cover: every item compares recorded facts, so a resource nobody
 * recorded, and a fact no provider read exposes, are outside this by construction.
 */
const STANDING_LIMIT =
  'status compares only what golive recorded (state, provider markers, its own step evidence) with a read taken now; resources created outside golive, and facts no provider read exposes, are outside it.';

/** Hosting providers hide sensitive env values, and golive stores a fingerprint, never the value. */
const ENV_VALUE_LIMIT =
  'env values are not compared: golive stores a fingerprint, and a host that hides sensitive values answers a read with the name alone. A value rotated or replaced outside golive is invisible here.';

/** No provider read exposes whether an issued sending key still exists. */
const KEY_READ_LIMIT =
  'no read exposes whether a sending key golive issued was revoked outside golive: issuing and revoking are the only capabilities a provider gives golive (see `golive teardown`).';

// ── Reading and labelling ───────────────────────────────────────────────────────────────────────

/**
 * `golive status` must not write: every read below drops state saves, and the caller observes the
 * current plan through the same view, so a status run leaves `.golive/state.json` exactly as it was.
 */
function readOnlyContext(ctx: Ctx): Ctx {
  return { ...ctx, state: readOnlyStateStore(ctx.state) };
}

/** One read per subject per invocation, shared through the per-run cache. */
function once<T>(ctx: Ctx, key: string, read: () => Promise<T>): Promise<T> {
  const k = `drift:${key}`;
  const hit = ctx.cache.get(k) as Promise<T> | undefined;
  if (hit) return hit;
  const p = read();
  ctx.cache.set(k, p);
  return p;
}

const label = (value: string, b: DriftBaseline): string => `${value} — recorded by golive ${b.at ?? 'at an unknown time'}${b.ref ? ` (${b.ref})` : ''}`;
const seen = (value: string, at: string): string => `${value} — read now ${at}`;
const normName = (n: string): string => n.trim().replace(/\.$/, '').toLowerCase();
const asRecord = (b: DnsBaseline): DnsRecord => ({ type: b.type, name: b.name, content: b.content, ...(b.priority !== undefined ? { priority: b.priority } : {}) });

/** A public DoH answer as a comparable record (an MX answer carries its priority first). */
const publicRecord = (type: DnsRecord['type'], name: string, value: string): DnsRecord =>
  ({ type, name, content: type === 'MX' ? value.replace(/^\d+\s+/, '') : value });

/** Was this written recently enough that public DNS may legitimately still differ? */
const withinPropagation = (at: string | undefined): boolean => Boolean(at && Date.now() - Date.parse(at) < PROPAGATION_MS);

/** A read that failed for permission/transport reasons means "could not read", not "changed". */
function isUnreadable(e: unknown): boolean {
  const status = (e as { status?: number } | null)?.status;
  if (status === 403 || status === 429 || (typeof status === 'number' && status >= 500)) return true;
  return /\b(network|timeout|timed out|aborted|fetch failed|ENOTFOUND|ETIMEDOUT|ECONNRESET|ECONNREFUSED|socket hang up|rate limit|rate-limit)\b/i.test(errMsg(e));
}

/** Why the provider on this axis could not be read, in one phrase (`capability` names the missing read). */
function unreadable(s: AxisStatus, capability: string): string {
  if (s.kind === 'unauthed') return `the provider is not logged in (${s.status.howToFix ?? s.adapter.title})`;
  if (s.kind === 'guided') return `the provider (${s.title}) is guided, so golive has no ${capability}`;
  return 'the provider is not configured';
}

/** When state recorded a step: its own time, or the newest recorded step when it ran under another id. */
function stepAt(ctx: Ctx, ...ids: string[]): string | undefined {
  const steps = ctx.state.get().steps;
  for (const id of ids) if (steps[id]?.at) return steps[id]!.at;
  return Object.values(steps).map((r) => r.at).sort().at(-1);
}

/** A recorded subject golive could not read now. Never drift; never counted as clean either. */
function unread(c: Collected, o: { id: string; class: DriftClass; subject: string; expected: string; baseline: DriftBaseline; reason: unknown; checkId?: string }): void {
  const reason = errMsg(o.reason);
  c.items.push({
    id: o.id,
    class: o.class,
    subject: o.subject,
    expected: label(o.expected, o.baseline),
    observed: `not read now: ${reason}`,
    baseline: o.baseline,
    severity: 'info',
    action: 'none',
    unverifiable: true,
    evidence: [reason, 'this is not a finding, and not proof that nothing changed: golive could not read this subject'],
    ...(o.checkId ? { checkId: o.checkId, suggestedAction: `Restore access to the provider, then re-check with \`golive verify --only ${o.checkId}\`.` } : {}),
  });
  c.notChecked.push({ subject: o.subject, reason });
}

/** Wording for a change that looks like a human decision rather than a break. */
const perhapsDeliberate = (what: string): string => `${what} — this may be intentional; if you changed it, confirm with \`golive verify\`.`;

// ── DNS records: the baselines golive wrote, the zone serving them, and public DNS ───────────────

/**
 * Per recorded record, cheapest first: is it still in the zone with the same content, does the zone
 * still agree with the provider recorded as serving it, and — only when the zone's own answer matches
 * the baseline — does public resolution see it? The whole zone is listed (not just the provider's
 * golive-owned records): a record that changed was replaced, so only the full listing can show it.
 * A record written minutes ago may legitimately differ publicly (TTLs, a wildcard answering first),
 * so the recorded write time decides whether a public difference is "still propagating" (info) or a
 * finding (medium).
 */
async function dnsItems(ctx: Ctx, at: string, c: Collected): Promise<void> {
  const baselines = readDnsBaselines(ctx.state.get());
  const byZone = new Map<string, DnsBaseline[]>();
  for (const b of baselines) byZone.set(b.zone, [...(byZone.get(b.zone) ?? []), b]);
  const email = emailDomain(ctx);

  if (!baselines.length) {
    const zones = [...new Set([ctx.config.domain, email].filter((z): z is string => Boolean(z)).map(normName))];
    if (zones.length) c.notChecked.push({ subject: `${zones.join(', ')} DNS records`, reason: 'golive recorded no per-record DNS baseline for this app (no DNS step ran here, or state predates the baselines), so there is nothing to compare record by record' });
  }

  if (byZone.size) {
    const dns = await once(ctx, 'axis:dns', () => axisStatus(ctx, 'dns'));
    const zone = dns.kind === 'ready' ? dns.adapter.capabilities.dns : undefined;
    const zoneTitle = dns.kind === 'ready' ? dns.adapter.title : (ctx.config.stack.dns ?? 'the DNS provider');
    for (const [name, list] of byZone) {
      const subject = `${name} zone: ${list.length} record(s) golive wrote`;
      const baseline: DriftBaseline = { source: 'state', at: list.map((b) => b.at).sort().at(-1), ref: dnsBaselineKey(name, list[0]!) };
      const checkId = ctx.config.domain && normName(ctx.config.domain) === name ? 'domain-live' : email && normName(email) === name ? 'email-dns' : undefined;
      if (!zone) {
        unread(c, {
          id: `dns:${name}:provider`,
          class: 'dns-record',
          subject,
          expected: list.map(formatRecord).join('; '),
          baseline,
          reason: unreadable(dns, 'DNS zone read'),
          checkId,
        });
        continue;
      }
      let have: DnsRecord[];
      try {
        have = await once(ctx, `dns:list:${name}`, () => zone.list(ctx, name));
      } catch (e) {
        unread(c, { id: `dns:${name}:zone`, class: 'dns-record', subject, expected: list.map(formatRecord).join('; '), baseline, reason: `listing the ${name} zone failed: ${errMsg(e)}`, checkId });
        continue;
      }
      for (const b of list) await compareRecord(ctx, at, c, name, b, have, zoneTitle, checkId);
    }
  }

  await delegationItems(ctx, at, c, byZone);
}

async function compareRecord(ctx: Ctx, at: string, c: Collected, zone: string, b: DnsBaseline, have: DnsRecord[], zoneTitle: string, checkId: string | undefined): Promise<void> {
  const baseline: DriftBaseline = { source: 'state', at: b.at, ref: dnsBaselineKey(zone, b) };
  const subject = `${zone}: ${b.type} ${b.name}`;
  const want = asRecord(b);
  const match = have.filter((h) => h.type === b.type && normName(h.name) === b.name);

  if (!match.length) {
    c.items.push({
      id: `dns:${zone}:${b.type}:${b.name}:missing`,
      class: 'dns-record',
      subject,
      expected: label(formatRecord(want), baseline),
      observed: seen(`${zoneTitle} reports no ${b.type} record at ${b.name}`, at),
      baseline,
      severity: 'high',
      action: 'reconcile',
      evidence: [`${zoneTitle} no longer lists the ${b.type} record golive wrote at ${b.name}`, `the zone holds ${have.length} record(s), none at that type and name`],
      suggestedAction: `Re-apply the DNS step (\`golive plan\`, then \`apply\` with --confirm-dns) to restore it; if removing it was deliberate, remove the app's ${zone} domain instead.`,
      checkId,
    });
    return;
  }
  if (!match.some((h) => satisfies(h, want))) {
    c.items.push({
      id: `dns:${zone}:${b.type}:${b.name}:changed`,
      class: 'dns-record',
      subject,
      expected: label(formatRecord(want), baseline),
      observed: seen(match.map(formatRecord).join('; '), at),
      baseline,
      severity: 'medium',
      action: 'verify',
      evidence: [`${b.name} exists at ${zoneTitle} but no longer matches what golive wrote`],
      suggestedAction: perhapsDeliberate(`the ${b.type} record at ${b.name} was changed after golive wrote it`),
      checkId,
    });
    return;
  }

  let published: string[];
  try {
    published = await once(ctx, `doh:${b.type}:${b.name}`, () => dohLookup(ctx, b.name, b.type as RRType));
  } catch (e) {
    c.notChecked.push({ subject, reason: `public DNS lookup failed: ${errMsg(e)}` });
    return;
  }
  if (published.some((v) => satisfies(publicRecord(b.type, b.name, v), want))) {
    c.verified.push(`${subject} is served by public DNS as golive recorded it`);
    return;
  }
  const fresh = withinPropagation(b.at);
  const hours = Math.round(PROPAGATION_MS / 3_600_000);
  c.items.push({
    id: `dns:${zone}:${b.type}:${b.name}:public`,
    class: 'dns-public',
    subject,
    expected: label(formatRecord(want), baseline),
    observed: seen(published.length ? `public DNS answers ${published.slice(0, 3).join(', ')}` : 'public DNS answers nothing', at),
    baseline,
    severity: fresh ? 'info' : 'medium',
    action: fresh ? 'none' : 'verify',
    evidence: [
      `${zoneTitle} serves ${formatRecord(want)}, public DNS ${published.length ? `answers ${published.slice(0, 3).join(', ')}` : 'answers nothing'}`,
      fresh
        ? `that write was ${b.at} (${hours}h propagation window): a cached answer or a zone wildcard can answer first, so this is not a change yet`
        : `that write was ${b.at}, outside the ${hours}h window golive's checks allow for propagation`,
      'golive never re-baselines on its own: the recorded value stays until an approved write replaces it',
    ],
    suggestedAction: fresh
      ? 'Nothing to do yet: re-run `golive status` once the record TTL has passed, and `golive verify` for the end-to-end answer.'
      : `${perhapsDeliberate(`public DNS does not resolve the ${b.type} record golive wrote at ${b.name}`)} Re-run \`golive plan\`/\`apply --confirm-dns\` if the zone should serve it.`,
    checkId,
  });
}

/** Maps a public name server to the provider id golive records it as. */
const NS_PROVIDER: Record<string, string> = {
  cloudflare: 'cloudflare',
  'cloudflare.com': 'cloudflare',
  vercel: 'vercel',
  'vercel-dns.com': 'vercel',
  'porkbun.com': 'porkbun',
  'domaincontrol.com': 'godaddy',
  'godaddy.com': 'godaddy',
};

const servedBy = (nameservers: string[], provider: string): boolean =>
  nameservers.some((ns) => {
    const h = ns.toLowerCase().replace(/\.$/, '');
    const known = NS_PROVIDER[h] ?? Object.keys(NS_PROVIDER).find((s) => h.endsWith(`.${s}`));
    return known ? NS_PROVIDER[known] === provider : h.includes(provider);
  });

/**
 * Delegation: the zone golive wrote into must still be the zone public DNS serves. A moved zone (or a
 * delegated subdomain) makes every record above invisible without changing the provider's own answer,
 * so this compares the recorded provider with the public name servers over DoH.
 */
async function delegationItems(ctx: Ctx, at: string, c: Collected, byZone: Map<string, DnsBaseline[]>): Promise<void> {
  const zones = new Map<string, { provider: string; at?: string; ref?: string; source: DriftBaseline['source'] }>();
  for (const [zone, list] of byZone) {
    const newest = [...list].sort((x, y) => (x.at < y.at ? -1 : 1)).at(-1)!;
    zones.set(zone, { provider: newest.provider, at: newest.at, ref: dnsBaselineKey(zone, newest), source: 'state' });
  }
  // A DNS step with no per-record baseline (state written before baselines existed): the zone it wrote.
  for (const [stepId, domain] of [['domain:dns', ctx.config.domain], ['email:dns', emailDomain(ctx)]] as const) {
    const step = ctx.state.get().steps[stepId];
    if (!domain || step?.status !== 'done' || !ctx.config.stack.dns) continue;
    const zone = normName(domain);
    if (zones.has(zone)) continue;
    zones.set(zone, { provider: ctx.config.stack.dns, at: step.at, ref: stepId, source: 'step-evidence' });
  }

  for (const [zone, rec] of zones) {
    const subject = `${zone} name servers`;
    const baseline: DriftBaseline = { source: rec.source, ...(rec.at ? { at: rec.at } : {}), ...(rec.ref ? { ref: rec.ref } : {}) };
    let host: Awaited<ReturnType<typeof dnsHost>>;
    try {
      host = await once(ctx, `ns:${zone}`, () => dnsHost(ctx, zone));
    } catch (e) {
      c.notChecked.push({ subject, reason: `public name-server lookup failed: ${errMsg(e)}` });
      continue;
    }
    if (!host.nameservers.length) {
      c.notChecked.push({ subject, reason: 'public DNS answered no NS records for this zone' });
      continue;
    }
    if (servedBy(host.nameservers, rec.provider)) {
      c.verified.push(`${zone} is still served by the name servers golive recorded for ${rec.provider} (${host.nameservers.join(', ')})`);
      continue;
    }
    c.items.push({
      id: `dns:${zone}:delegation`,
      class: 'dns-delegation',
      subject,
      expected: label(`${rec.provider} serves the ${zone} zone`, baseline),
      observed: seen(`public name servers are ${host.nameservers.join(', ')}${host.provider ? ` (${host.provider})` : ''}`, at),
      baseline,
      severity: 'medium',
      action: 'verify',
      evidence: [
        `the records golive wrote for ${zone} live in ${rec.provider}; public DNS now answers different name servers`,
        'a moved zone and a delegated subdomain look the same from outside, and every record above becomes invisible either way',
      ],
      suggestedAction: perhapsDeliberate(`${zone} is no longer served by the name servers golive recorded`) + ' If the DNS host really moved, re-run `golive plan` so golive writes records where the zone lives.',
      checkId: 'domain-live',
    });
  }
}

// ── Env names on the host ────────────────────────────────────────────────────────────────────────

/** Names golive delivered to the host, from the secret fingerprints and the env source records. */
function recordedEnvNames(state: ShipState): Array<{ name: string; target: EnvTarget; at?: string }> {
  const byKey = new Map<string, { name: string; target: EnvTarget; at?: string }>();
  const add = (name: string, target: string, at?: string): void => {
    if (target !== 'development' && target !== 'preview' && target !== 'production') return;
    byKey.set(`${name}@${target}`, { name, target, ...(at ? { at } : {}) });
  };
  for (const [key, rec] of Object.entries(state.secrets)) {
    const m = /^(.*)@([a-z-]+)$/.exec(key);
    if (m) add(m[1]!, m[2]!, rec.at);
  }
  for (const key of Object.keys(state.resources)) {
    const m = /^env:(.*)@([a-z-]+)$/.exec(key);
    if (m && !byKey.has(`${m[1]}@${m[2]}`)) add(m[1]!, m[2]!);
  }
  return [...byKey.values()].sort((a, b) => (a.target === b.target ? (a.name < b.name ? -1 : 1) : a.target < b.target ? -1 : 1));
}

/** Every env NAME golive delivered still exists on the host. Names only: see ENV_VALUE_LIMIT. */
async function envItems(ctx: Ctx, at: string, c: Collected): Promise<void> {
  const recorded = recordedEnvNames(ctx.state.get());
  if (!recorded.length) return;
  c.limits.push(ENV_VALUE_LIMIT);
  const host = await once(ctx, 'axis:hosting', () => axisStatus(ctx, 'hosting'));
  const env = host.kind === 'ready' ? host.adapter.capabilities.env : undefined;
  const hostTitle = host.kind === 'ready' ? host.adapter.title : (ctx.config.stack.hosting ?? 'the hosting provider');
  if (!env) {
    unread(c, {
      id: 'env:names',
      class: 'env-name',
      subject: `host env names (${recorded.length} recorded)`,
      expected: recorded.map((r) => `${r.name}@${r.target}`).join(', '),
      baseline: { source: 'state', at: recorded.map((r) => r.at).filter(Boolean).sort().at(-1) },
      reason: unreadable(host, 'host env read'),
      checkId: 'env-parity',
    });
  } else {
    for (const target of [...new Set(recorded.map((r) => r.target))]) {
      const names = recorded.filter((r) => r.target === target);
      const subject = `${target} env names at ${hostTitle}`;
      let present: Set<string>;
      try {
        present = new Set(await once(ctx, `env:names:${target}`, () => env.listNames(ctx, target)));
      } catch (e) {
        unread(c, { id: `env:${target}`, class: 'env-name', subject, expected: names.map((n) => n.name).join(', '), baseline: { source: 'state' }, reason: `listing ${target} env names failed: ${errMsg(e)}`, checkId: 'env-parity' });
        continue;
      }
      const missing = names.filter((n) => !present.has(n.name));
      if (!missing.length) {
        c.verified.push(`${subject}: all ${names.length} name(s) golive delivered are still present`);
        continue;
      }
      for (const m of missing) {
        c.items.push({
          id: `env:${target}:${m.name}`,
          class: 'env-name',
          subject: `${m.name} (${target})`,
          expected: label(`${m.name} exists in ${target}`, { source: 'state', ...(m.at ? { at: m.at } : {}), ref: envSourceKey(m.name, target) }),
          observed: seen(`${hostTitle} reports no ${m.name} in ${target}`, at),
          baseline: { source: 'state', ...(m.at ? { at: m.at } : {}), ref: envSourceKey(m.name, target) },
          severity: 'high',
          action: 'reconcile',
          evidence: [
            `golive delivered ${m.name} to ${target}${m.at ? ` at ${m.at}` : ''} and the host no longer lists it`,
            `the app reads ${m.name} at runtime: without it the deployment fails or falls back to a default`,
          ],
          suggestedAction: `Re-apply the env step (\`golive plan\`, then \`apply\`) or set ${m.name} in the ${hostTitle} dashboard yourself — never paste the value into chat. Then redeploy.`,
          checkId: 'env-parity',
        });
      }
    }
  }
  c.items.push({
    id: 'env:values',
    class: 'env-name',
    subject: 'env values',
    expected: 'the values golive delivered (fingerprints in state, never the values)',
    observed: 'not readable, now or later',
    baseline: { source: 'state' },
    severity: 'info',
    action: 'none',
    unverifiable: true,
    evidence: [ENV_VALUE_LIMIT, 'treat every env value as unverified by this comparison; rotate one deliberately and golive will re-write it on the next approved apply'],
    checkId: 'env-parity',
  });
}

// ── Webhook endpoint ─────────────────────────────────────────────────────────────────────────────

const WEBHOOK_KEY = /^([a-z0-9-]+)\.(test|live)\.webhookEndpointId$/;

/** The endpoint golive registered still exists, is enabled and still covers the configured events. */
async function webhookItems(ctx: Ctx, at: string, c: Collected): Promise<void> {
  const recorded = Object.entries(ctx.state.get().resources)
    .filter(([k]) => WEBHOOK_KEY.test(k))
    .map(([key, id]) => ({ key, id, provider: WEBHOOK_KEY.exec(key)![1]!, mode: WEBHOOK_KEY.exec(key)![2] as Mode }))
    .sort((a, b) => (a.key < b.key ? -1 : 1));
  if (!recorded.length) return;

  const registeredAt = stepAt(ctx, 'payments:webhook:production');
  const pay = await once(ctx, 'axis:payments', () => axisStatus(ctx, 'payments'));
  const registry = pay.kind === 'ready' ? pay.adapter.capabilities.webhooks : undefined;
  for (const r of recorded) {
    const subject = `${r.provider} ${r.mode}-mode webhook endpoint ${r.id}`;
    const baseline: DriftBaseline = { source: 'provider-marker', ...(registeredAt ? { at: registeredAt } : {}), ref: r.key };
    if (!registry) {
      unread(c, {
        id: `webhook:${r.mode}`,
        class: 'webhook-endpoint',
        subject,
        expected: `the ${r.mode}-mode endpoint ${r.id} still exists`,
        baseline,
        reason: unreadable(pay, 'endpoint list'),
        checkId: 'webhook-registered',
      });
      continue;
    }
    let endpoints: Array<{ id: string; url: string; events: string[]; enabled: boolean }>;
    try {
      endpoints = await once(ctx, `webhooks:list:${r.mode}`, () => registry.list(ctx, r.mode));
    } catch (e) {
      unread(c, { id: `webhook:${r.mode}`, class: 'webhook-endpoint', subject, expected: `the ${r.mode}-mode endpoint ${r.id} still exists`, baseline, reason: `listing ${r.mode}-mode endpoints failed: ${errMsg(e)}`, checkId: 'webhook-registered' });
      continue;
    }
    const want = ctx.config.payments?.webhook?.events ?? [];
    const found = endpoints.find((e) => e.id === r.id);
    if (found) {
      if (!found.enabled) {
        c.items.push({
          id: `webhook:${r.mode}:disabled`, class: 'webhook-endpoint', subject,
          expected: label(`the ${r.mode}-mode endpoint ${r.id} is enabled`, baseline),
          observed: seen(`endpoint ${r.id} is disabled`, at),
          baseline, severity: 'medium', action: 'reconcile',
          evidence: [`a disabled endpoint receives nothing: ${want.join(', ') || 'every configured event'} is not delivered`],
          suggestedAction: `Re-apply the webhook step (\`golive plan\`, then \`apply\`) or re-enable ${r.id} in the ${r.provider} dashboard; events that arrived while it was disabled are lost.`,
          checkId: 'webhook-registered',
        });
        continue;
      }
      const missing = found.events.includes('*') ? [] : want.filter((ev) => !found.events.includes(ev));
      if (missing.length) {
        c.items.push({
          id: `webhook:${r.mode}:events`, class: 'webhook-endpoint', subject,
          expected: label(`endpoint ${r.id} covers ${want.join(', ')}`, baseline),
          observed: seen(`endpoint ${r.id} covers ${found.events.join(', ') || 'no events'}`, at),
          baseline, severity: 'medium', action: 'reconcile',
          evidence: [`the app's handler expects ${missing.join(', ')}; the endpoint no longer subscribes to them`],
          suggestedAction: 'Re-apply the webhook step (`golive plan`, then `apply`) to restore the event list.',
          checkId: 'webhook-registered',
        });
        continue;
      }
      c.verified.push(`${subject} exists, is enabled and covers ${want.length} configured event(s)`);
      continue;
    }

    const url = await once(ctx, 'webhook:url', () => webhookUrl(ctx));
    const replacement = registry.find && url ? await once(ctx, `webhooks:find:${r.mode}:${url}`, () => registry.find!(ctx, url!, r.mode).catch(() => null)) : null;
    if (replacement) {
      c.items.push({
        id: `webhook:${r.mode}:replaced`, class: 'webhook-endpoint', subject,
        expected: label(`the ${r.mode}-mode endpoint golive registered (${r.id})`, baseline),
        observed: seen(`endpoint ${replacement.id} now serves ${replacement.url}`, at),
        baseline, severity: 'medium', action: 'verify',
        evidence: [
          `the recorded endpoint is gone; ${replacement.id} answers for the same URL${replacement.owned ? '' : ' but was not created by golive'}`,
          'the signing secret in the app belongs to the recorded endpoint, so signature verification fails until it matches again',
        ],
        suggestedAction: `${perhapsDeliberate(`the ${r.mode}-mode webhook endpoint was replaced`)} If ${replacement.id} should receive the events, re-apply the webhook step so the app gets its signing secret.`,
        checkId: 'webhook-registered',
      });
      continue;
    }
    c.items.push({
      id: `webhook:${r.mode}:gone`, class: 'webhook-endpoint', subject,
      expected: label(`the ${r.mode}-mode endpoint golive registered (${r.id}) exists`, baseline),
      observed: seen(`no ${r.mode}-mode endpoint with that id (${endpoints.length} endpoint(s) listed)`, at),
      baseline, severity: 'high', action: 'reconcile',
      evidence: [`the endpoint golive registered is gone: ${want.join(', ') || 'the configured events'} is not delivered`, 'payments keep being taken while the app never hears about them'],
      suggestedAction: url
        ? `Re-apply the webhook step (\`golive plan\`, then \`apply\`): it registers an endpoint for ${url} and stores the new signing secret.`
        : 'Set the app domain or deploy production, then re-apply the webhook step so golive knows which URL to register.',
      checkId: 'webhook-registered',
    });
  }
}

/** The URL the webhook link registers (config domain first, else the host's production URL). */
async function webhookUrl(ctx: Ctx): Promise<string | null> {
  const path = ctx.config.payments?.webhook?.path;
  if (!path) return null;
  const base = await once(ctx, 'production:url', () => productionUrl(ctx));
  return base ? joinUrl(base, path) : null;
}

// ── Domain attachment ────────────────────────────────────────────────────────────────────────────

/** The domain golive attached is still attached to this project, and needs the records it needed. */
async function domainItems(ctx: Ctx, at: string, c: Collected): Promise<void> {
  const domain = ctx.config.domain;
  if (!domain) return;
  const step = ctx.state.get().steps['domain:attach'];
  if (step?.status !== 'done') {
    if (ctx.config.stack.hosting) c.notChecked.push({ subject: `${domain} host attachment`, reason: 'golive has no completed domain:attach step for this app, so it recorded no attachment to compare' });
    return;
  }
  const baseline: DriftBaseline = { source: 'step-evidence', at: step.at, ref: 'domain:attach' };
  const subject = `${domain} attachment at ${ctx.config.stack.hosting}`;
  const host = await once(ctx, 'axis:hosting', () => axisStatus(ctx, 'hosting'));
  const attach = host.kind === 'ready' ? host.adapter.capabilities.domain : undefined;
  const hostTitle = host.kind === 'ready' ? host.adapter.title : (ctx.config.stack.hosting ?? 'the hosting provider');
  if (!attach) {
    unread(c, {
      id: 'domain:attach',
      class: 'domain-attach',
      subject,
      expected: `${domain} is attached`,
      baseline,
      reason: unreadable(host, 'domain read'),
      checkId: 'domain-live',
    });
    return;
  }

  let status: 'ok' | 'pending' | 'misconfigured';
  try {
    status = await once(ctx, `domain:status:${domain}`, () => attach.status(ctx, domain));
  } catch (e) {
    unread(c, { id: 'domain:attach', class: 'domain-attach', subject, expected: `${domain} is attached`, baseline, reason: `reading the host's domain status failed: ${errMsg(e)}`, checkId: 'domain-live' });
    return;
  }
  if (status === 'misconfigured') {
    c.items.push({
      id: 'domain:attach',
      class: 'domain-attach',
      subject,
      expected: label(`${domain} is attached and pointing at this project`, baseline),
      observed: seen(`${hostTitle} reports the domain misconfigured`, at),
      baseline,
      severity: 'high',
      action: 'reconcile',
      evidence: ['the host no longer serves this domain for the project: it was detached, or its DNS stopped pointing at the host'],
      suggestedAction: 'Run `golive plan` and apply the domain:attach / domain:dns steps again (with --confirm-dns); if the domain should move, detach it in the host dashboard instead.',
      checkId: 'domain-live',
    });
  } else if (status === 'pending') {
    const fresh = withinPropagation(step.at);
    c.items.push({
      id: 'domain:attach',
      class: 'domain-attach',
      subject,
      expected: label(`${domain} is attached and verified`, baseline),
      observed: seen(`${hostTitle} reports the domain pending`, at),
      baseline,
      severity: fresh ? 'info' : 'medium',
      action: fresh ? 'none' : 'verify',
      evidence: [fresh ? `golive asked the host to attach it at ${step.at} (inside the propagation window)` : `golive attached it at ${step.at} and the host has still not confirmed it`],
      suggestedAction: fresh
        ? 'Nothing to do yet: DNS and the host\'s ownership check take minutes.'
        : `${perhapsDeliberate(`${domain} is still pending at ${hostTitle}`)} Re-run \`golive plan\` so the attach/verify steps are asked again, and \`golive verify --only domain-live\`.`,
      checkId: 'domain-live',
    });
  } else {
    c.verified.push(`${subject}: the host reports the domain ok`);
  }

  await requiredRecordItems(ctx, at, c, domain, attach);
}

/** The host must still want the records golive wrote: a moved target is a re-plan, not a silent gap. */
async function requiredRecordItems(ctx: Ctx, at: string, c: Collected, domain: string, attach: NonNullable<Ctx['adapters'][number]['capabilities']['domain']>): Promise<void> {
  if (!attach.requiredRecords) return;
  const zone = normName(domain);
  const baselines = readDnsBaselines(ctx.state.get()).filter((b) => b.zone === zone || b.name === zone || b.name.endsWith(`.${zone}`));
  if (!baselines.length) return;
  let required: DnsRecord[];
  try {
    required = await once(ctx, `domain:required:${domain}`, () => attach.requiredRecords!(ctx, domain));
  } catch (e) {
    c.notChecked.push({ subject: `${domain} records the host requires`, reason: `reading the host's required records failed: ${errMsg(e)}` });
    return;
  }
  for (const rec of required) {
    const b = baselines.find((x) => x.type === rec.type && x.name === normName(rec.name));
    if (!b) {
      c.items.push({
        id: `dns:${zone}:required:${rec.type}:${normName(rec.name)}`,
        class: 'dns-record',
        subject: `${zone}: ${rec.type} ${normName(rec.name)} (host requirement)`,
        expected: 'no such record was recorded when golive wrote the DNS',
        observed: seen(`the host now requires ${formatRecord(rec)}`, at),
        baseline: { source: 'provider-marker', ref: 'domain:attach' },
        severity: 'info',
        action: 'none',
        evidence: ['the host asks for a record golive never wrote (a new ownership challenge or a per-project target)'],
        suggestedAction: 'Nothing to fix here on its own: run `golive plan` and apply the domain:dns step if the domain should publish it.',
        checkId: 'domain-live',
      });
      continue;
    }
    if (satisfies(asRecord(b), rec)) continue;
    c.items.push({
      id: `dns:${zone}:required:${rec.type}:${normName(rec.name)}`,
      class: 'dns-record',
      subject: `${zone}: ${rec.type} ${normName(rec.name)} (host requirement)`,
      expected: label(formatRecord(rec), { source: 'state', at: b.at, ref: dnsBaselineKey(zone, b) }),
      observed: seen(`the host now requires ${formatRecord(rec)}`, at),
      baseline: { source: 'state', at: b.at, ref: dnsBaselineKey(zone, b) },
      severity: 'medium',
      action: 'reconcile',
      evidence: [`the host changed the ${rec.type} record it wants at ${normName(rec.name)}: it asked for ${b.content} when golive wrote it`],
      suggestedAction: `Run \`golive plan\` and re-approve with --confirm-dns: golive refuses to write records that changed since approval, and the domain stays unverified until they match.`,
      checkId: 'domain-live',
    });
  }
}

// ── Database project and its connection selectors ────────────────────────────────────────────────

/** Where each db provider records the project it selected (see the RECORDED list in inventory.ts). */
const DB_PROJECT_KEYS: Record<string, string> = { supabase: 'supabase.ref', neon: 'neon.projectId' };
/** Recorded selector state key -> the field the provider's connection identity reports. */
const DB_SELECTOR_FIELDS: Record<string, string> = { branchId: 'branch', branch: 'branch', database: 'database', role: 'role' };

/** The recorded db project still exists, is still the one this repo links, and keeps its selectors. */
async function dbItems(ctx: Ctx, at: string, c: Collected): Promise<void> {
  const provider = ctx.config.stack.db;
  if (!provider) return;
  const projectKey = DB_PROJECT_KEYS[provider] ?? projectStateKeys(provider).id;
  const recordedId = ctx.state.resource(projectKey);
  if (!recordedId) {
    c.notChecked.push({ subject: 'database project', reason: `state records no ${provider} project to compare (${projectKey})` });
    return;
  }
  const baseline: DriftBaseline = { source: 'state', at: stepAt(ctx, 'project:db'), ref: projectKey };
  const selectors = Object.entries(DB_SELECTOR_FIELDS)
    .map(([suffix, field]) => ({ field, value: ctx.state.resource(`${provider}.${suffix}`), key: `${provider}.${suffix}` }))
    .filter((s): s is { field: string; value: string; key: string } => Boolean(s.value));
  const subject = `${provider} project ${recordedId}`;

  const s = await once(ctx, 'axis:db', () => axisStatus(ctx, 'db'));
  if (s.kind !== 'ready') {
    unread(c, {
      id: 'db:project', class: 'db-selectors', subject, expected: `project ${recordedId} is readable`,
      baseline,
      reason: unreadable(s, 'project read'),
      checkId: dbCheckId(adapterFor(ctx, 'db')),
    });
    return;
  }
  const linker = s.adapter.capabilities.project;
  if (!linker) {
    unread(c, { id: 'db:project', class: 'db-selectors', subject, expected: `project ${recordedId} is readable`, baseline, reason: `${s.adapter.title} exposes no project read`, checkId: dbCheckId(s.adapter) });
    return;
  }

  // The exact recorded project: resolve() reads it from the provider, current() says what the repo links.
  const found = linker.resolve
    ? await once(ctx, `db:resolve:${provider}`, async (): Promise<{ ok: true; ref: ProjectRef } | { ok: false; error: unknown }> => {
        try {
          return { ok: true, ref: await linker.resolve!(ctx, recordedId) };
        } catch (e) {
          return { ok: false, error: e };
        }
      })
    : null;
  if (found && !found.ok) {
    if (isUnreadable(found.error)) {
      unread(c, { id: 'db:project', class: 'db-selectors', subject, expected: `project ${recordedId} is readable`, baseline, reason: `reading the recorded project failed: ${errMsg(found.error)}`, checkId: dbCheckId(s.adapter) });
    } else {
      c.items.push({
        id: 'db:project', class: 'db-selectors', subject,
        expected: label(`the ${provider} project ${recordedId} exists and is visible to this account`, baseline),
        observed: seen(`golive could not read it: ${errMsg(found.error)}`, at),
        baseline, severity: 'high', action: 'human',
        evidence: [
          `every env value golive delivered for the database was taken from ${recordedId}`,
          'a deleted project, a renamed one and a credential that lost access all answer this way: golive cannot tell them apart',
        ],
        suggestedAction: `Confirm ${recordedId} in the ${s.adapter.title} dashboard. If it is gone, restore it or create a replacement, then re-run \`golive plan\`; nothing is touched until you approve a new plan.`,
        checkId: dbCheckId(s.adapter),
      });
    }
    return;
  }
  if (found?.ok && found.ref.id !== recordedId) {
    c.items.push({
      id: 'db:project', class: 'db-selectors', subject,
      expected: label(`the ${provider} project ${recordedId}`, baseline),
      observed: seen(`resolving it returns ${found.ref.name ?? found.ref.id} (${found.ref.id})`, at),
      baseline, severity: 'medium', action: 'verify',
      evidence: ['the provider resolves the recorded id to a different project now'],
      suggestedAction: `${perhapsDeliberate('the recorded database project now resolves to another one')} Re-run \`golive plan\` before any env write.`,
      checkId: dbCheckId(s.adapter),
    });
    return;
  }
  if (found?.ok) c.verified.push(`${subject} is still readable (${found.ref.name ?? found.ref.id})`);
  else {
    // No exact read of the recorded project exists: only the linked project can be compared.
    unread(c, {
      id: 'db:project', class: 'db-selectors', subject, expected: `the ${provider} project ${recordedId} exists`,
      baseline, reason: `${s.adapter.title} exposes no exact project read, so golive could not confirm ${recordedId} still exists (the project this repo links was compared instead)`,
      checkId: dbCheckId(s.adapter),
    });
  }

  const current = await once(ctx, `db:current:${provider}`, async (): Promise<{ ok: true; ref: ProjectRef | null } | { ok: false; error: unknown }> => {
    try {
      return { ok: true, ref: await linker.current(ctx) };
    } catch (e) {
      return { ok: false, error: e };
    }
  });
  if (current.ok && current.ref && current.ref.id !== recordedId) {
    c.items.push({
      id: 'db:current', class: 'db-selectors', subject,
      expected: label(`this repo uses ${recordedId}`, baseline),
      observed: seen(`the repo now resolves to ${current.ref.name ?? current.ref.id} (${current.ref.id})`, at),
      baseline, severity: 'medium', action: 'verify',
      evidence: [
        'the database the repo points at changed since golive recorded it',
        'env values golive manages are only re-written from the project recorded here, so the app may still hold the old connection string',
      ],
      suggestedAction: `${perhapsDeliberate(`the ${provider} project this app uses changed`)} Re-run \`golive plan\` so env writes, the plan and state agree on one project.`,
      checkId: dbCheckId(s.adapter),
    });
  }

  const identity = s.adapter.capabilities.outputs?.identity;
  if (!selectors.length) return;
  if (!identity) {
    unread(c, { id: 'db:selectors', class: 'db-selectors', subject: `${subject} connection selectors`, expected: selectors.map((x) => `${x.field}=${x.value}`).join(', '), baseline: { ...baseline, ref: selectors[0]!.key }, reason: `${s.adapter.title} reports no connection selectors, so the recorded branch/database/role cannot be compared`, checkId: dbCheckId(s.adapter) });
    return;
  }
  const now = await once(ctx, `db:identity:${provider}`, async (): Promise<{ ok: true; fields: Record<string, string> } | { ok: false; error: unknown }> => {
    try {
      const raw = await identity(ctx);
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') throw new Error(`the reported identity is not a mapping: ${raw}`);
      const fields: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) if (typeof v === 'string') fields[k] = v;
      return { ok: true, fields };
    } catch (e) {
      return { ok: false, error: e };
    }
  });
  if (!now.ok) {
    unread(c, { id: 'db:selectors', class: 'db-selectors', subject: `${subject} connection selectors`, expected: selectors.map((x) => `${x.field}=${x.value}`).join(', '), baseline: { ...baseline, ref: selectors[0]!.key }, reason: `reading the connection selectors failed: ${errMsg(now.error)}`, checkId: dbCheckId(s.adapter) });
    return;
  }
  const changed = selectors.filter((x) => now.fields[x.field] !== undefined && now.fields[x.field] !== x.value);
  const unknown = selectors.filter((x) => now.fields[x.field] === undefined);
  if (!changed.length) {
    c.verified.push(`${subject} connection selectors unchanged (${selectors.map((x) => `${x.field}=${x.value}`).join(', ')})`);
    if (unknown.length) c.notChecked.push({ subject: `${subject} connection selectors`, reason: `the provider did not report ${unknown.map((x) => x.field).join(', ')}` });
    return;
  }
  c.items.push({
    id: 'db:selectors', class: 'db-selectors', subject: `${subject} connection selectors`,
    expected: label(changed.map((x) => `${x.field}=${x.value}`).join(', '), { ...baseline, ref: changed[0]!.key }),
    observed: seen(changed.map((x) => `${x.field}=${now.fields[x.field]}`).join(', '), at),
    baseline: { ...baseline, ref: changed[0]!.key },
    severity: 'medium', action: 'verify',
    evidence: [
      'the branch/database/role golive wrote the app\'s connection values from is no longer what the provider resolves',
      'a different branch or database can mean different data, and golive will not rewrite managed env names until a new plan is approved',
    ],
    suggestedAction: `${perhapsDeliberate('the database connection selectors changed')} If the app should use the new selectors, re-run \`golive plan\` and apply the env step.`,
    checkId: dbCheckId(s.adapter),
  });
}

/** The check that re-reads a db subject: the connectivity probe when there is one, else the RLS probe. */
function dbCheckId(adapter: { capabilities: { dbConnection?: unknown } } | undefined): string {
  return adapter?.capabilities.dbConnection ? 'db-connection' : 'rls-probe';
}

// ── Email sending domain ─────────────────────────────────────────────────────────────────────────

/** The sending domain golive verified is still verified at the provider. */
async function emailItems(ctx: Ctx, at: string, c: Collected): Promise<void> {
  const provider = ctx.config.stack.email;
  if (!provider) return;
  const id = ctx.state.resource(`${provider}.domainId`);
  if (!id) return;
  const subject = `${provider} sending domain ${emailDomain(ctx) ?? id}`;
  const baseline: DriftBaseline = { source: 'provider-marker', at: stepAt(ctx, 'email:domain'), ref: `${provider}.domainId` };
  const s = await once(ctx, 'axis:email', () => axisStatus(ctx, 'email'));
  const sd = s.kind === 'ready' ? s.adapter.capabilities.sendingDomain : undefined;
  if (!sd) {
    unread(c, {
      id: 'email:domain', class: 'email-domain', subject, expected: `sending domain ${id} is verified`, baseline,
      reason: unreadable(s, 'sending-domain read'),
      checkId: 'email-verified',
    });
    return;
  }
  let status: 'verified' | 'pending' | 'failed' | 'not_started';
  try {
    status = await once(ctx, `email:status:${provider}`, () => sd.status(ctx, id));
  } catch (e) {
    unread(c, { id: 'email:domain', class: 'email-domain', subject, expected: `sending domain ${id} is verified`, baseline, reason: `reading the sending domain failed: ${errMsg(e)}`, checkId: 'email-verified' });
    return;
  }
  if (status === 'verified') {
    c.verified.push(`${subject}: the provider still reports it verified`);
    return;
  }
  const fresh = withinPropagation(stepAt(ctx, 'email:verify', 'email:dns'));
  if (status === 'failed') {
    c.items.push({
      id: 'email:domain', class: 'email-domain', subject,
      expected: label(`sending domain ${id} is verified`, baseline),
      observed: seen('the provider reports it failed to verify', at),
      baseline, severity: 'high', action: 'reconcile',
      evidence: ['the provider cannot find the DNS records it needs: mail sent through the app\'s key will be rejected or land in spam'],
      suggestedAction: 'Re-apply the email steps (`golive plan`, then `apply` with --confirm-dns), or fix the records shown in the provider dashboard if they were changed there.',
      checkId: 'email-verified',
    });
    return;
  }
  c.items.push({
    id: 'email:domain', class: 'email-domain', subject,
    expected: label(`sending domain ${id} is verified`, baseline),
    observed: seen(`the provider reports it ${status}`, at),
    baseline, severity: fresh ? 'info' : 'medium', action: fresh ? 'none' : 'verify',
    evidence: [fresh ? 'golive asked for verification inside the propagation window: providers re-check DNS on their own schedule' : 'the provider has not confirmed the domain in that time, and it was verified before golive recorded it'],
    suggestedAction: fresh ? 'Nothing to do yet: re-run `golive verify --only email-verified` later.' : 'Re-apply the email step to re-request verification, and `golive verify --only email-dns` to see which record is missing.',
    checkId: 'email-verified',
  });
}

// ── Issued sending keys ──────────────────────────────────────────────────────────────────────────

/**
 * Sending keys golive issued, which it can only revoke — never read. There is no capability that says
 * whether a key still exists (a skip, not an invented read), so a recorded key is reported as
 * unverifiable rather than checked off.
 */
function keyItems(ctx: Ctx, c: Collected): void {
  const keys = Object.entries(ctx.state.get().resources)
    .filter(([k]) => /^[a-z0-9-]+\.keyId@[a-z-]+$/.test(k))
    .sort(([a], [b]) => (a < b ? -1 : 1));
  if (!keys.length) return;
  c.limits.push(KEY_READ_LIMIT);
  for (const [key, id] of keys) {
    const [head, target] = key.split('@') as [string, string];
    const provider = head.replace(/\.keyId$/, '');
    c.items.push({
      id: `key:${provider}:${target}`,
      class: 'sending-key',
      subject: `${provider} sending key for ${target} (${id})`,
      expected: `the key golive issued (${id}) is still the one the app uses`,
      observed: 'not readable: the provider exposes no key read',
      baseline: { source: 'state', at: stepAt(ctx, `email:key:${target}`), ref: key },
      severity: 'info',
      action: 'none',
      unverifiable: true,
      evidence: [KEY_READ_LIMIT, 'a key revoked in the provider dashboard keeps failing until the app is given a new one; `golive teardown` can revoke it on request, but nothing can confirm it still works'],
    });
    c.notChecked.push({ subject: `${provider} sending key ${id}`, reason: 'the provider exposes no read for an issued key (issue and revoke only)' });
  }
}

// ── Payments account and mode ────────────────────────────────────────────────────────────────────

interface RecordedPayment {
  name: string;
  /** preview and production only: modeFor() has no mode for development. */
  target: Exclude<EnvTarget, 'development'>;
  key: string;
  mode: Mode;
  accountId: string;
  at?: string;
}

/** The payment account each recorded env value came from (the env source line records it). */
function recordedPayments(state: ShipState, provider: string): RecordedPayment[] {
  const out: RecordedPayment[] = [];
  for (const [key, value] of Object.entries(state.resources).sort(([a], [b]) => (a < b ? -1 : 1))) {
    const m = /^env:(.+)@(preview|production)$/.exec(key);
    if (!m) continue;
    const parts = value.split('|');
    if (parts.length !== 5) continue;
    const [outputKey, source, mode, , accountId] = parts as [string, string, string, string, string];
    if (!/^stripe\.(secretKey|publishableKey)$/.test(outputKey) || source !== provider) continue;
    if (mode !== 'test' && mode !== 'live') continue;
    if (!/^[A-Za-z0-9_]{4,64}$/.test(accountId)) continue;
    const at = state.secrets[`${m[1]}@${m[2]}`]?.at;
    out.push({ name: m[1]!, target: m[2] as Exclude<EnvTarget, 'development'>, key, mode, accountId, ...(at ? { at } : {}) });
  }
  return out;
}

/** The credential golive holds now still reads the account, and the mode is the one approved. */
async function paymentItems(ctx: Ctx, at: string, c: Collected): Promise<void> {
  const provider = ctx.config.stack.payments;
  if (!provider) return;
  const recorded = recordedPayments(ctx.state.get(), provider);
  if (!recorded.length) return;
  const pay = await once(ctx, 'axis:payments', () => axisStatus(ctx, 'payments'));
  const account = pay.kind === 'ready' ? pay.adapter.capabilities.paymentAccount : undefined;
  for (const r of recorded) {
    const subject = `${provider} ${r.mode}-mode account (${r.name}@${r.target})`;
    const baseline: DriftBaseline = { source: 'state', ...(r.at ? { at: r.at } : {}), ref: r.key };
    const wantMode = modeFor(ctx.config, r.target);
    if (wantMode !== r.mode) {
      c.items.push({
        id: `payments:${r.target}:mode`, class: 'payment-account', subject,
        expected: label(`${r.name} holds a ${r.mode}-mode value`, baseline),
        observed: seen(`golive.yaml now says ${r.target} uses ${wantMode} mode`, at),
        baseline, severity: 'medium', action: 'reconcile',
        evidence: [`the app's ${r.name} was delivered from ${provider} ${r.mode} mode; the configuration asks for ${wantMode} mode`],
        suggestedAction: 'Run `golive plan` and apply the payments/env step: golive re-writes managed names when the mode behind them changes.',
      });
    }
    if (!account) {
      unread(c, {
        id: `payments:${r.mode}`, class: 'payment-account', subject, expected: `the credential reads the ${r.mode}-mode account ${r.accountId}`, baseline,
        reason: unreadable(pay, 'account read'),
      });
      continue;
    }
    const identity = await once(ctx, `payments:identify:${r.mode}`, async (): Promise<{ ok: true; accountId: string } | { ok: false; error: unknown }> => {
      try {
        return { ok: true, accountId: (await account.identify(ctx, r.mode)).accountId };
      } catch (e) {
        return { ok: false, error: e };
      }
    });
    if (!identity.ok) {
      unread(c, { id: `payments:${r.mode}`, class: 'payment-account', subject, expected: `the credential reads the ${r.mode}-mode account ${r.accountId}`, baseline, reason: `reading the account failed: ${errMsg(identity.error)}` });
      continue;
    }
    if (identity.accountId === r.accountId) {
      c.verified.push(`${subject}: the ${r.mode}-mode credential still reads ${r.accountId}`);
      continue;
    }
    c.items.push({
      id: `payments:${r.mode}:account`, class: 'payment-account', subject,
      expected: label(`the credential belongs to ${r.accountId}`, baseline),
      observed: seen(`the credential now reads ${identity.accountId}`, at),
      baseline, severity: 'high', action: 'human',
      evidence: [
        `the app's ${r.name} was delivered from account ${r.accountId}; golive can only see account ${identity.accountId} now`,
        'payments, webhooks and keys read here belong to the other account: the app\'s configuration is not covered by this read',
      ],
      suggestedAction: `Sign in to ${r.accountId} again (or set the credential back), then re-run \`golive plan\`: approvals bind the account, so env writes are re-checked against it.`,
    });
  }

  // Live readiness is a read of the same account; a restricted key without Account: Read answers 403.
  if (provider === 'stripe' && recorded.some((r) => r.mode === 'live')) {
    const subject = 'stripe live account readiness';
    const baseline: DriftBaseline = { source: 'state', at: recorded.filter((r) => r.mode === 'live').map((r) => r.at).filter(Boolean).sort().at(-1), ref: recorded.find((r) => r.mode === 'live')!.key };
    try {
      const st = await once(ctx, 'payments:status:live', () => accountStatus(ctx, 'live'));
      if (st.chargesEnabled) c.verified.push(`${subject}: charges_enabled`);
      else {
        c.items.push({
          id: 'payments:live:readiness', class: 'payment-account', subject,
          expected: label('the live account can take payments (charges_enabled)', baseline),
          observed: seen(`charges_enabled: ${st.chargesEnabled}, details_submitted: ${st.detailsSubmitted}`, at),
          baseline, severity: 'high', action: 'human',
          evidence: ['the app was wired for live payments, and the account no longer reports charges_enabled'],
          suggestedAction: 'Finish Stripe account activation yourself (business details, identity verification, bank account) at https://dashboard.stripe.com/account/onboarding, then re-run `golive verify`.',
          checkId: 'stripe-live-ready',
        });
      }
    } catch (e) {
      const denied = (e as { status?: number } | null)?.status === 403;
      unread(c, {
        id: 'payments:live:readiness', class: 'payment-account', subject, expected: 'the live account can take payments (charges_enabled)', baseline,
        reason: denied ? 'this credential cannot read the account (restricted key without Account: Read): readiness is unknown, not drift' : `reading the account failed: ${errMsg(e)}`,
        checkId: 'stripe-live-ready',
      });
    }
  }
}

// ── Host project identity ────────────────────────────────────────────────────────────────────────

/** The project this repo is linked to is still the one golive recorded, marker included. */
async function hostItems(ctx: Ctx, at: string, c: Collected): Promise<void> {
  const provider = ctx.config.stack.hosting;
  if (!provider) return;
  const keys = projectStateKeys(provider);
  const recordedId = ctx.state.resource(keys.id);
  if (!recordedId) return;
  const subject = `${provider} project ${ctx.state.resource(keys.name) ?? recordedId}`;
  const baseline: DriftBaseline = { source: 'state', at: stepAt(ctx, 'project:hosting'), ref: keys.id };
  const host = await once(ctx, 'axis:hosting', () => axisStatus(ctx, 'hosting'));
  const linker = host.kind === 'ready' ? host.adapter.capabilities.project : undefined;
  if (!linker) {
    unread(c, {
      id: 'project:hosting', class: 'host-project', subject, expected: `this repo is linked to ${recordedId}`, baseline,
      reason: unreadable(host, 'project read'),
    });
  } else {
    const current = await once(ctx, `project:current:${provider}`, async (): Promise<{ ok: true; ref: ProjectRef | null } | { ok: false; error: unknown }> => {
      try {
        return { ok: true, ref: await linker.current(ctx) };
      } catch (e) {
        return { ok: false, error: e };
      }
    });
    if (!current.ok && isUnreadable(current.error)) {
      unread(c, { id: 'project:hosting', class: 'host-project', subject, expected: `this repo is linked to ${recordedId}`, baseline, reason: `reading the linked project failed: ${errMsg(current.error)}` });
    } else if (current.ok && current.ref && current.ref.id === recordedId) {
      c.verified.push(`${subject}: still the project this repo links (${recordedId})`);
    } else {
      // No linked project, or a different one: say whether the recorded project still exists.
      let exists: boolean | null = null;
      if (linker.resolve) {
        const r = await once(ctx, `project:resolve:${provider}`, async (): Promise<{ ok: boolean }> => {
          try {
            await linker.resolve!(ctx, recordedId);
            return { ok: true };
          } catch {
            return { ok: false };
          }
        });
        exists = r.ok;
      }
      const linked = current.ok ? (current.ref ? `${current.ref.name ?? current.ref.id} (${current.ref.id})` : 'nothing') : errMsg(current.error);
      c.items.push({
        id: 'project:hosting', class: 'host-project', subject,
        expected: label(`this repo is linked to ${recordedId}`, baseline),
        observed: seen(`the provider resolves this repo to ${linked}`, at),
        baseline, severity: 'medium', action: 'verify',
        evidence: [
          `state records ${recordedId}${ctx.state.resource(createdProjectKey(provider)) === recordedId ? ', which golive created' : ', which golive adopted'}`,
          exists === null ? 'golive could not read the recorded project to say whether it still exists' : exists ? 'that project still exists at the provider' : 'that project is not readable at the provider now',
        ],
        suggestedAction: `${perhapsDeliberate('the hosting project this repo links to changed')} Re-run \`golive plan\` so deploys, env writes and state point at the same project.`,
      });
    }
  }

  // The creation marker is what lets an approved teardown delete the project golive made.
  const marker = ctx.state.resource(createdProjectKey(provider));
  if (marker && marker !== recordedId) {
    c.items.push({
      id: 'project:hosting:marker', class: 'host-project', subject: `${provider} project creation marker`,
      expected: label(`the creation marker names ${recordedId}`, { source: 'provider-marker', at: baseline.at, ref: createdProjectKey(provider) }),
      observed: seen(`it names ${marker}`, at),
      baseline: { source: 'provider-marker', ...(baseline.at ? { at: baseline.at } : {}), ref: createdProjectKey(provider) },
      severity: 'medium', action: 'verify',
      evidence: ['state\'s marker and the linked project disagree, so `golive teardown` treats the project as adopted and will not delete it'],
      suggestedAction: 'Confirm which project golive created. If it is the linked one, re-plan and apply the project step so the marker and the link agree again.',
    });
  }
}

// ── Pending and stale release state ──────────────────────────────────────────────────────────────

/** Work golive recorded but never finished: a production env write with no deploy, a failed step. */
function releaseItems(ctx: Ctx, at: string, c: Collected, plan?: Plan | null): void {
  const pending = pendingRedeploy(ctx);
  if (pending) {
    c.items.push({
      id: 'release:redeploy', class: 'release-state', subject: 'production deployment',
      expected: label('a deploy picked up the production env write', { source: 'step-evidence', at: pending, ref: 'redeploy:production' }),
      observed: seen('no production deploy has happened since', at),
      baseline: { source: 'step-evidence', at: pending, ref: 'redeploy:production' },
      severity: 'medium', action: 'reconcile',
      evidence: [`golive wrote production env at ${pending} and recorded that a deploy is still needed`, 'production keeps serving the values from before that write until it is deployed'],
      suggestedAction: 'Run `golive plan` and apply the `deploy:production` step (or deploy in the host dashboard) so production uses the env the plan approved.',
    });
  }
  for (const [id, rec] of Object.entries(ctx.state.get().steps).sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (rec.status !== 'failed') continue;
    c.items.push(failedStepItem(ctx, at, id, rec, plan));
  }
}

/** How a release identity is named in an evidence line: version, source ref, short bundle digest. */
const releaseName = (release?: ReleaseIdentity): string =>
  release
    ? `${release.version}${release.source.ref ? ` ${release.source.ref}` : ''} (bundle ${release.bundleDigest.slice(0, 8)})`
    : 'an unknown release (state written before golive recorded release identities)';

/** Why `apply` may resume this recorded failure: destruction is idempotent, `replayable` is declared. */
const resumableNote = (step: Step | undefined): string | null => {
  if (!step) return null;
  if (step.risk.destroy) return 'this is a destruction step: a deletion re-checks ownership and is idempotent, so a newer release resumes it';
  if (step.risk.replayable) return 'the step declares its write safe to replay under a newer release (`risk.replayable`)';
  if (!step.risk.writes) return 'the step writes nothing, so there is no historical write to replay';
  return null;
};

/**
 * A failed step golive recorded. `apply` skips completed steps, but refuses a WRITE recorded by
 * another (or an unknown) release unless the step itself declares the exemption — `destroy` or
 * `risk.replayable` (src/core/runner.ts). The current plan, when the caller could observe it, says
 * which of the two this is, so the advice is either the command that will run or the reviewed
 * reconciliation path that has to happen first.
 */
function failedStepItem(ctx: Ctx, at: string, id: string, rec: StepRecord, plan?: Plan | null): DriftItem {
  const item = {
    id: `release:step:${id}`, class: 'release-state' as const, subject: `step ${id}`,
    expected: label(`${id} completed`, { source: 'step-evidence' as const, at: rec.at, ref: id }),
    observed: seen(`the last run failed${rec.error ? `: ${rec.error}` : ''}`, at),
    baseline: { source: 'step-evidence' as const, at: rec.at, ref: id },
    severity: 'medium' as const,
  };
  const evidence = [
    `state records a failed ${id} from ${rec.at}${rec.planId ? ` (plan ${rec.planId})` : ''}`,
    'a failed step stops the run: everything after it never ran',
  ];
  const resumeAdvice = 'Fix the cause, then re-run `golive apply --plan <planId>` (completed steps are skipped) or `golive plan` if the intent changed.';
  if (sameRelease(rec.release, ctx.release)) return { ...item, action: 'verify', evidence, suggestedAction: resumeAdvice };

  const observed = plan !== undefined && plan !== null;
  const step = observed ? plan.steps.find((s) => s.id === id) : undefined;
  const resumable = resumableNote(step);
  if (resumable) return { ...item, action: 'verify', evidence: [...evidence, resumable], suggestedAction: resumeAdvice };

  evidence.push(`the failed record was written by release ${releaseName(rec.release)}, while this runtime is release ${releaseName(ctx.release)}: such a write is not replayed automatically`);
  if (!observed) evidence.push('golive could not observe the current plan in this run, so whether the step declares itself replayable is unknown');
  else if (step) evidence.push(`${id} is a write that declares neither \`risk.replayable\` nor \`destroy\`, so the cross-release guard refuses it`);
  else evidence.push(`the current plan does not carry ${id}, so there is nothing to re-run automatically`);
  evidence.push('a historical write needs the reviewed reconciliation path: inspect what it did at the provider, then prepare a recovery with the human');
  return {
    ...item, action: 'human', evidence,
    suggestedAction: 'Re-running `apply` cannot replay this step automatically. Inspect the provider for what it actually did, then prepare a separately reviewed recovery — the release and updates guidance (`references/updates.md`) describes that path; do not delete state or force a replay.',
  };
}
