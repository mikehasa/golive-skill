import type { Link } from '../core/plan.js';
import type { Adapter, Ctx, DnsRecord, DnsZone, EnvStore, EnvTarget, HandoffItem, KeyIssuer, SendingDomain, Step } from '../core/types.js';
import { axisStatus, decideEnv, deps, envPreview, errMsg, intentOf, memo, namesFor, observeNames, projectIntent, ready, secretBlocked, step, track, verifyEnvWritten, writeEnv, writesProduction } from './util.js';

type Target = Exclude<EnvTarget, 'development'>;

/** Sending domain: email.domain, else the domain of email.from, else the app's domain. */
export function emailDomain(ctx: Ctx): string | null {
  const c = ctx.config.email;
  if (c?.domain) return c.domain.toLowerCase();
  const addr = c?.from?.replace(/^.*<|>$/g, '').trim();
  const d = addr?.split('@')[1];
  if (d) return d.toLowerCase();
  return ctx.config.domain?.toLowerCase() ?? null;
}

export function formatRecord(r: DnsRecord): string {
  return `${r.type} ${r.name}${r.priority !== undefined ? ` (priority ${r.priority})` : ''} = ${r.content}`;
}

/**
 * Email provider → DNS: ensure the sending domain, publish its records at the DNS provider, then ask
 * the provider to verify. Records are only known after `ensure`, so they are listed in that step's
 * changes (and re-read by the DNS step, since ensure is idempotent).
 */
export const emailDomainLink: Link = {
  id: 'email-domain',
  async plan(ctx) {
    const r = await ready(ctx, 'email', 'sendingDomain');
    if (!r) return null;
    const domain = emailDomain(ctx);
    if (!domain) return { steps: [], handoffs: [], warnings: [`${r.adapter.title}: no sending domain (set email.from, email.domain or domain in golive.yaml); email setup left out of this plan`] };

    const sd = r.cap;
    const idKey = `${r.adapter.id}.domainId`;
    const known = ctx.state.resource(idKey);
    if (known && (await sd.status(ctx, known).catch(() => null)) === 'verified') return null;

    // The provider's domain id (and, below, its records and the previous verify request) identify
    // each run, so a re-created domain or a still-pending verification runs again instead of being
    // skipped as "already done" (constant previews).
    const idIntent = `${r.adapter.id}:${known ?? 'new'}`;
    const steps: Step[] = [domainStep(r.adapter, sd, domain, idKey, idIntent)];
    const handoffs: HandoffItem[] = [];
    const warnings: string[] = [];
    track(ctx, steps);
    const dns = await dnsFor(ctx, domain);
    if (dns.kind === 'ready') {
      const records = known && sd.records ? await sd.records(ctx, known).catch(() => null) : null;
      steps.push(...track(ctx, [dnsStep(ctx, r.adapter, sd, domain, dns.adapter, dns.zone, intentOf({ id: idIntent, zone: `${dns.adapter.id}:${domain}`, records: records ? records.map(formatRecord) : ['(from ensure)'] }))]));
    }
    else if (dns.kind === 'handoff') handoffs.push(dnsHandoff(r.adapter, domain, dns.where));
    else if (dns.kind === 'error') warnings.push(`${r.adapter.title} sending records for ${domain}: ${dns.message}`);
    steps.push(...track(ctx, [verifyStep(ctx, r.adapter, sd, domain, idKey, idIntent)]));
    return { steps, handoffs, warnings };
  },
};

function domainStep(adapter: Adapter, sd: SendingDomain, domain: string, idKey: string, idIntent: string): Step {
  return step({
    id: 'email:domain',
    title: `Set up sending domain ${domain} at ${adapter.title}`,
    kind: 'provision',
    risk: { writes: true },
    preview: [`ensure sending domain ${domain} at ${adapter.title} (adopted if it already exists); the DNS records it needs are listed in this step's changes`],
    intent: intentOf({ id: idIntent, domain }),
    async run(sctx) {
      const d = await sd.ensure(sctx, domain);
      sctx.remember(idKey, d.id);
      return { changes: [`sending domain ${domain} (${d.id}) needs these DNS records:`, ...d.records.map(formatRecord)] };
    },
  });
}

function dnsStep(ctx: Ctx, adapter: Adapter, sd: SendingDomain, domain: string, dnsAdapter: Adapter, zone: DnsZone, intent: string): Step {
  return step({
    id: 'email:dns',
    title: `Publish ${adapter.title} DNS records for ${domain} at ${dnsAdapter.title}`,
    kind: 'wire',
    risk: { writes: true, dns: true },
    dependsOn: deps(ctx, ['email:domain']),
    preview: [`create/update the ${adapter.title} sending records for ${domain} (SPF, DKIM, MX — whatever ${adapter.title} returns; DMARC is left to you) at ${dnsAdapter.title}; unrelated records are never deleted`],
    intent,
    verifyWith: ['email-dns'],
    async run(sctx) {
      const { records } = await sd.ensure(sctx, domain);
      const changes: string[] = [];
      for (const rec of records) changes.push(`${await zone.upsert(sctx, domain, { ...rec, proxied: false })}: ${formatRecord(rec)}`);
      return { changes };
    },
  });
}

/** Intent carries the previous request's time: each re-plan while still pending asks again. */
function verifyStep(ctx: Ctx, adapter: Adapter, sd: SendingDomain, domain: string, idKey: string, idIntent: string): Step {
  const prev = ctx.state.get().steps['email:verify'];
  return step({
    id: 'email:verify',
    title: `Ask ${adapter.title} to verify ${domain}`,
    kind: 'wire',
    risk: { writes: true },
    dependsOn: deps(ctx, ['email:domain', 'email:dns']),
    preview: [`ask ${adapter.title} to verify ${domain} (DNS can take a while to propagate; a pending result is not a failure)`, ...(prev ? [`previous request: ${prev.at}`] : [])],
    intent: intentOf({ id: idIntent, previous: prev?.at }),
    verifyWith: ['email-verified'],
    async run(sctx) {
      const id = sctx.state.resource(idKey) ?? (await sd.ensure(sctx, domain)).id;
      const changes: string[] = [];
      try {
        await sd.verify(sctx, id);
      } catch (e) {
        changes.push(`verification request not accepted yet: ${errMsg(e)}`);
      }
      const status = await sd.status(sctx, id).catch(() => 'pending' as const);
      changes.push(`${domain}: ${status}${status === 'verified' ? '' : ' (DNS may still be propagating; run `verify --only email-verified` later)'}`);
      return { changes };
    },
  });
}

type DnsTarget =
  | { kind: 'ready'; adapter: Adapter; zone: DnsZone }
  | { kind: 'handoff'; where: string }
  | { kind: 'skip' }
  /** The zone lookup itself failed (token permissions, rate limit, network): not the human's DNS job. */
  | { kind: 'error'; message: string };

/**
 * Where DNS records for `domain` go: an automated zone, a human (guided/unknown/zone not in this
 * account), nowhere yet (not logged in), or unknown because the lookup failed.
 */
export async function dnsFor(ctx: Ctx, domain: string): Promise<DnsTarget> {
  const s = await axisStatus(ctx, 'dns');
  if (s.kind === 'unauthed') return { kind: 'skip' };
  if (s.kind === 'none') return { kind: 'handoff', where: `the DNS host for ${domain}` };
  if (s.kind === 'guided') return { kind: 'handoff', where: s.title };
  const zone = s.adapter.capabilities.dns;
  if (!zone) return { kind: 'handoff', where: `the DNS host for ${domain}` };
  let hosts: boolean;
  try {
    hosts = await zone.hosts(ctx, domain);
  } catch (e) {
    return {
      kind: 'error',
      message: `checking whether ${s.adapter.title} hosts ${domain} failed (${errMsg(e)}), so the DNS records are left out of this plan. Fix the ${s.adapter.title} access (token permissions, rate limit or network) and run \`plan\` again.`,
    };
  }
  return hosts ? { kind: 'ready', adapter: s.adapter, zone } : { kind: 'handoff', where: `the DNS host for ${domain} (${s.adapter.title} doesn't host this zone in this account)` };
}

function dnsHandoff(adapter: Adapter, domain: string, where: string): HandoffItem {
  return {
    id: 'email:dns',
    why: `The ${adapter.title} sending records for ${domain} must be added at a DNS host golive can't write to.`,
    action: `After apply runs the email:domain step, add the DNS records listed in its changes (or run \`handoff\` / \`plan\` again to print them) at ${where}. Turn proxying off for these records and merge SPF into a single TXT record.`,
    blocking: true,
    verifiedBy: 'email-dns',
  };
}

// ── App sending key ───────────────────────────────────────────────────────────────────────────────

/** A least-privilege sending key per target, minted only when the code references one. */
export const emailKeysLink: Link = {
  id: 'email-keys',
  async plan(ctx) {
    const names = namesFor(ctx, 'resend.apiKey');
    if (!names.length) return null;
    const em = await ready(ctx, 'email', 'keys');
    const host = await ready(ctx, 'hosting', 'env');
    if (!em || !host) return null;
    const domain = emailDomain(ctx);
    if (!domain) return null; // emailDomainLink already warned
    const steps: Step[] = [];
    for (const target of ctx.config.targets) {
      const s = await keyStep(ctx, em.adapter, em.cap, host.adapter, host.cap, domain, target, names);
      if (s) steps.push(s);
    }
    return { steps: track(ctx, steps, { needsRedeploy: writesProduction }), handoffs: [] };
  },
};

async function keyStep(ctx: Ctx, adapter: Adapter, keys: KeyIssuer, hostAdapter: Adapter, env: EnvStore, domain: string, target: Target, names: string[]): Promise<Step | null> {
  if (names.some((n) => secretBlocked(ctx, n, 'resend.apiKey'))) return null; // see the secrets:exposed handoff
  const keyIdKey = `${adapter.id}.keyId@${target}`;
  const keyId = ctx.state.resource(keyIdKey);
  const present = await observeNames(ctx, env, target, memo(ctx).pendingProjects.has('hosting'));
  if (keyId && present && names.every((n) => present.has(n))) return null;
  const decision = decideEnv(ctx, target, names, present);
  if (!decision.write.length) return null;

  let written: string[] = [];
  const intent = intentOf({ host: await projectIntent(ctx, hostAdapter), domain, previousKey: keyId, write: decision.write.map((w) => w.name) });
  return step({
    id: `email:key:${target}`,
    title: `Issue a ${adapter.title} sending key for ${target}`,
    kind: 'wire',
    risk: { writes: true },
    dependsOn: deps(ctx, ['email:domain', 'project:hosting']),
    preview: [`issue a sending-only ${adapter.title} key scoped to ${domain} for ${target}`, ...envPreview(decision, () => `resend.apiKey (sensitive)`)],
    intent,
    async run(sctx) {
      const k = await keys.issue(sctx, target, { domain });
      sctx.remember(keyIdKey, k.id);
      const changes = [`issued ${adapter.title} key ${k.id} (${target}) fp:${k.secret.fingerprint}`];
      if (keyId && keyId !== k.id) changes.push(`previous golive key ${keyId} was left active; revoke it in ${adapter.title} once nothing uses it`);
      const w = await writeEnv(sctx, env, target, decision.write.map((x) => ({ name: x.name, key: k.key, value: k.secret, source: `${k.key}|${adapter.id}|${k.id}` })), decision.recheck);
      written = w.written;
      changes.push(...w.changes);
      return { changes: changes.length ? changes : [`nothing written to ${hostAdapter.title}`] };
    },
    verifyInline: (vctx) => verifyEnvWritten(vctx, env, target, written, `email:key:${target}`, hostAdapter.title),
  });
}
