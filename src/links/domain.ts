import type { Link } from '../core/plan.js';
import type { Adapter, CheckResult, Ctx, DnsRecord, DnsZone, DomainAttach, HandoffItem, Step } from '../core/types.js';
import { normalizeTxt } from '../core/doh.js';
import { axisStatus, deps, errMsg, intentOf, projectIntent, step, track } from './util.js';
import { dnsFor, formatRecord } from './email.js';

/**
 * Host domain → DNS zone: attach the domain to the host project, publish the records it needs, then
 * ask the host to verify ownership. Attaching needs no redeploy (hosts serve a newly attached domain
 * from the current production deployment), but some hosts only attach after a successful production
 * deploy — so when production was never deployed, the deploy link makes domain:attach wait for it.
 */
export const domainLink: Link = {
  id: 'domain',
  async plan(ctx) {
    const domain = ctx.config.domain;
    if (!domain) return null;
    const host = await axisStatus(ctx, 'hosting');
    if (host.kind === 'none' || host.kind === 'unauthed') return null;
    if (host.kind === 'guided' || !host.adapter.capabilities.domain) {
      const title = host.kind === 'guided' ? host.title : host.adapter.title;
      return { steps: [], handoffs: [manualAttach(title, domain)] };
    }
    const attach = host.adapter.capabilities.domain;
    const status = await attach.status(ctx, domain).catch(() => 'pending' as const);
    if (status === 'ok') return null;

    const records = await attach.requiredRecords(ctx, domain).catch(() => null);
    // The host project the domain goes to: a project switch keeps the same preview text but must attach again.
    const project = await projectIntent(ctx, host.adapter);
    const steps: Step[] = track(ctx, [attachStep(ctx, host.adapter, attach, domain, project)]);
    const handoffs: HandoffItem[] = [];
    const warnings: string[] = [];
    const dns = await dnsFor(ctx, domain);
    if (dns.kind === 'ready') steps.push(...track(ctx, [dnsStep(ctx, host.adapter, attach, domain, dns.adapter, dns.zone, records, project)]));
    else if (dns.kind === 'handoff') handoffs.push(dnsHandoff(host.adapter, domain, dns.where, records));
    else if (dns.kind === 'error') warnings.push(`${domain}: ${dns.message}`);
    if (attach.verify) steps.push(...track(ctx, [verifyStep(ctx, host.adapter, attach.verify.bind(attach), attach, domain, project)]));
    return { steps, handoffs, warnings };
  },
};

/**
 * Intent = the host project + the previous attempt: while the domain isn't live the attach is asked
 * again on each plan (it is idempotent), so a domain removed in the host's dashboard, or a switch to
 * another host project, is re-attached instead of being skipped as "already done".
 */
function attachStep(ctx: Ctx, adapter: Adapter, attach: DomainAttach, domain: string, project: string): Step {
  const prev = ctx.state.get().steps['domain:attach'];
  return step({
    id: 'domain:attach',
    title: `Attach ${domain} to ${adapter.title}`,
    kind: 'wire',
    risk: { writes: true },
    dependsOn: deps(ctx, ['project:hosting']),
    preview: [`attach ${domain} to the ${adapter.title} project (no-op if already attached)`],
    intent: intentOf({ project, domain, previous: prev?.at }),
    async run(sctx) {
      await attach.add(sctx, domain);
      return { changes: [`attached ${domain} to ${adapter.title}`] };
    },
  });
}

const normName = (n: string): string => n.trim().replace(/\.$/, '').toLowerCase();
function normContent(r: DnsRecord): string {
  if (r.type === 'TXT') return normalizeTxt(r.content).trim();
  if (r.type === 'CNAME' || r.type === 'MX') return r.content.trim().replace(/\.$/, '').toLowerCase();
  return r.content.trim().replace(/\s+/g, ' ').toLowerCase();
}
const recordKey = (r: DnsRecord): string => `${r.type} ${normName(r.name)} ${normContent(r)}${r.priority !== undefined ? ` ${r.priority}` : ''}`;
const sameRecords = (a: DnsRecord[], b: DnsRecord[]): boolean => {
  const ka = [...new Set(a.map(recordKey))].sort();
  const kb = [...new Set(b.map(recordKey))].sort();
  return ka.length === kb.length && ka.every((k, i) => k === kb[i]);
};
const spfTerms = (c: string): string[] => c.split(/\s+/).filter((t) => t && t !== 'v=spf1' && !/^[-~?+]?all$/.test(t));

/** Does the zone record `have` satisfy `want`? (DNS providers quote TXT, add dots, merge SPF.) */
function satisfies(have: DnsRecord, want: DnsRecord): boolean {
  if (have.type !== want.type || normName(have.name) !== normName(want.name)) return false;
  const h = normContent(have);
  const w = normContent(want);
  if (h === w) return true;
  // An SPF record may have been merged into the one already there: it must include our terms.
  return want.type === 'TXT' && w.startsWith('v=spf1') && h.startsWith('v=spf1') && spfTerms(w).every((t) => spfTerms(h).includes(t));
}

/**
 * Publish the records the host requires. When the plan listed them, apply-time records must be the
 * same set (the human approved exactly those with --confirm-dns): the host can answer differently
 * after attaching (e.g. an ownership TXT challenge, or a per-project target), and then nothing is
 * written and the agent re-plans. When they weren't known at plan time, the preview says so.
 */
function dnsStep(ctx: Ctx, adapter: Adapter, attach: DomainAttach, domain: string, dnsAdapter: Adapter, zone: DnsZone, planned: DnsRecord[] | null, project: string): Step {
  let wrote: DnsRecord[] = [];
  return step({
    id: 'domain:dns',
    title: `Point ${domain} at ${adapter.title} via ${dnsAdapter.title}`,
    kind: 'wire',
    risk: { writes: true, dns: true },
    dependsOn: deps(ctx, ['domain:attach']),
    preview: planned?.length
      ? planned.map((r) => `upsert at ${dnsAdapter.title}: ${formatRecord(r)} (not proxied)`)
      : [`upsert at ${dnsAdapter.title} the records ${adapter.title} requires for ${domain} (known after attaching)`],
    intent: intentOf({ project, zone: `${dnsAdapter.id}:${domain}`, records: planned?.length ? planned.map(recordKey) : ['(after attach)'] }),
    async run(sctx) {
      const records = await attach.requiredRecords(sctx, domain);
      if (planned?.length && !sameRecords(planned, records)) {
        throw new Error(
          `the DNS records ${adapter.title} requires for ${domain} changed since the plan was approved (planned: ${planned.map(formatRecord).join('; ')}; now: ${records.map(formatRecord).join('; ') || 'none'}); nothing was changed at ${dnsAdapter.title}. Run \`plan\` again and re-approve with --confirm-dns.`,
        );
      }
      const changes: string[] = [];
      for (const rec of records) changes.push(`${await zone.upsert(sctx, domain, { proxied: false, ...rec })}: ${formatRecord(rec)}`);
      wrote = records;
      return { changes };
    },
    // Verify what this step wrote (the zone now serves these records). Public resolution, TLS and
    // HTTP take minutes to hours, so they are checked by `verify` (domain-live), not here.
    async verifyInline(vctx): Promise<CheckResult[]> {
      if (!wrote.length) return [];
      const id = 'domain:dns:records';
      const title = `${dnsAdapter.title} zone has the records for ${domain}`;
      let have: DnsRecord[];
      try {
        have = await zone.list(vctx, domain);
      } catch (e) {
        return [{ id, title, status: 'warn', severity: 'medium', evidence: [`could not list the ${domain} zone to confirm: ${errMsg(e)}`] }];
      }
      const missing = wrote.filter((r) => !have.some((h) => satisfies(h, r)));
      if (missing.length) {
        return [{ id, title, status: 'fail', severity: 'high', evidence: [`missing after upsert: ${missing.map(formatRecord).join('; ')}`], fix: `Check the ${domain} zone at ${dnsAdapter.title}, then re-run apply.` }];
      }
      return [{ id, title, status: 'pass', severity: 'info', evidence: wrote.map(formatRecord) }];
    },
  });
}

/**
 * Ask the host to (re)check ownership, e.g. after a TXT challenge was published. Pending is not a
 * failure (DNS propagates). The previous request's time is part of the preview, so each re-plan
 * while the domain is still pending asks again instead of being skipped as "already done".
 */
function verifyStep(ctx: Ctx, adapter: Adapter, verify: NonNullable<DomainAttach['verify']>, attach: DomainAttach, domain: string, project: string): Step {
  const prev = ctx.state.get().steps['domain:verify'];
  return step({
    id: 'domain:verify',
    title: `Ask ${adapter.title} to verify ${domain}`,
    kind: 'wire',
    risk: { writes: true },
    dependsOn: deps(ctx, ['domain:attach', 'domain:dns']),
    preview: [
      `ask ${adapter.title} to verify ownership of ${domain} (if another ${adapter.title} account used this domain, a passing check moves it to this project; DNS still propagating is not a failure)`,
      ...(prev ? [`previous request: ${prev.at}`] : []),
    ],
    intent: intentOf({ project, domain }),
    async run(sctx) {
      const changes: string[] = [];
      try {
        changes.push(`${domain}: ownership ${await verify(sctx, domain)}`);
      } catch (e) {
        changes.push(`verification request not accepted yet: ${errMsg(e)}`);
      }
      const status = await attach.status(sctx, domain).catch(() => 'pending' as const);
      changes.push(`${domain}: ${status}${status === 'ok' ? '' : ' (DNS/TLS may still be propagating; run `plan` again later, and `verify --only domain-live`)'}`);
      return { changes };
    },
  });
}

function dnsHandoff(adapter: Adapter, domain: string, where: string, records: DnsRecord[] | null): HandoffItem {
  const list = records?.length ? `: ${records.map(formatRecord).join('; ')}` : ` that ${adapter.title} lists for ${domain} after the domain:attach step (run \`plan\` again to print them)`;
  return {
    id: 'domain:dns',
    why: `${domain} must point at ${adapter.title}, and its DNS is at a host golive can't write to.`,
    action: `At ${where}, add the records${list}. Turn proxying off for them.`,
    blocking: true,
    verifiedBy: 'domain-live',
  };
}

function manualAttach(title: string, domain: string): HandoffItem {
  return {
    id: 'domain:attach',
    why: `golive can't attach domains in ${title}.`,
    action: `In ${title}, add ${domain} as a custom domain and create the DNS records it shows at your DNS host.`,
    blocking: true,
    // A guided host's dashboard setting can't be observed; DNS+HTTPS passing doesn't prove it's attached to YOUR project.
    manual: true,
    verifiedBy: 'domain-live',
  };
}
