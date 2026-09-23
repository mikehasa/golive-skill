/**
 * Attaching a custom domain to the Vercel project and computing the DNS records it needs. Targets
 * are per project now (anycast A pool, `*.vercel-dns-0xx.com` CNAMEs), so they are always read from
 * `GET /v6/domains/{d}/config`, with the generic values only as a fallback.
 */
import { lookup } from '../core/doh.js';
import type { Ctx, DnsRecord, DomainAttach } from '../core/types.js';
import { VercelError, isNotFound, vercelApi } from './vercel-api.js';
import { requireProjectId } from './vercel-project.js';

const FALLBACK_A = '76.76.21.21';
const FALLBACK_CNAME = 'cname.vercel-dns-0.com';

export interface ProjectDomain {
  name: string;
  apexName?: string;
  verified: boolean;
  verification: Array<{ type: string; domain: string; value: string }>;
}

interface DomainConfig {
  misconfigured?: boolean;
  recommendedIPv4?: Array<{ rank?: number; value?: string[] }>;
  recommendedCNAME?: Array<{ rank?: number; value?: string }>;
}

function toProjectDomain(raw: Partial<ProjectDomain> | undefined, fallbackName: string): ProjectDomain {
  return {
    name: raw?.name ?? fallbackName,
    apexName: raw?.apexName,
    verified: raw?.verified !== false,
    verification: (raw?.verification ?? []).filter((v) => v && typeof v.domain === 'string' && typeof v.value === 'string'),
  };
}

/** The project's record for `domain`, or null when it isn't attached. */
export async function getProjectDomain(ctx: Ctx, projectId: string, domain: string): Promise<ProjectDomain | null> {
  try {
    const raw = await vercelApi<Partial<ProjectDomain>>(ctx, 'GET', `/v9/projects/${encodeURIComponent(projectId)}/domains/${encodeURIComponent(domain)}`);
    return toProjectDomain(raw, domain);
  } catch (e) {
    if (isNotFound(e)) return null;
    throw e;
  }
}

async function domainConfig(ctx: Ctx, projectId: string, domain: string): Promise<DomainConfig> {
  return vercelApi<DomainConfig>(ctx, 'GET', `/v6/domains/${encodeURIComponent(domain)}/config?projectIdOrName=${encodeURIComponent(projectId)}`);
}

function rank1<T extends { rank?: number }>(list: T[] | undefined): T | undefined {
  return [...(list ?? [])].sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99))[0];
}

function isApex(domain: string, pd: ProjectDomain | null): boolean {
  return pd?.apexName ? pd.apexName.toLowerCase() === domain.toLowerCase() : domain.split('.').length === 2;
}

const strip = (s: string) => s.replace(/\.$/, '').toLowerCase();

/** The A/CNAME record Vercel recommends for `domain`. */
function routingRecord(domain: string, pd: ProjectDomain | null, cfg: DomainConfig): DnsRecord {
  if (isApex(domain, pd)) {
    const ip = rank1(cfg.recommendedIPv4)?.value?.[0] ?? FALLBACK_A;
    return { type: 'A', name: domain, content: ip, proxied: false };
  }
  const target = rank1(cfg.recommendedCNAME)?.value ?? FALLBACK_CNAME;
  return { type: 'CNAME', name: domain, content: strip(target), proxied: false };
}

export const vercelDomain: DomainAttach = {
  async add(ctx, domain) {
    const projectId = await requireProjectId(ctx);
    if (await getProjectDomain(ctx, projectId, domain)) {
      ctx.log.info(`vercel: ${domain} is already attached to the project`);
      return;
    }
    try {
      await vercelApi(ctx, 'POST', `/v10/projects/${encodeURIComponent(projectId)}/domains`, { name: domain });
      ctx.log.info(`vercel: attached ${domain} to the project`);
    } catch (e) {
      if (!(e instanceof VercelError)) throw e;
      // Raced with another attach: adopt if it is on this project now.
      if (e.status === 400 && (await getProjectDomain(ctx, projectId, domain))) return;
      if (e.status === 409) {
        throw new VercelError(
          `${domain} is already assigned to another Vercel project or owned by another account. Remove it there (Vercel dashboard → Domains), or verify ownership, then retry.`,
          409,
          e.code,
        );
      }
      if (e.status === 400 && /deployment/i.test(e.message)) {
        throw new VercelError(`Vercel only attaches domains after a successful production deployment. Deploy to production first, then retry.`, 400, e.code);
      }
      throw e;
    }
  },

  async requiredRecords(ctx, domain) {
    const projectId = await requireProjectId(ctx);
    const pd = await getProjectDomain(ctx, projectId, domain);
    const cfg = await domainConfig(ctx, projectId, domain);
    const records: DnsRecord[] = [routingRecord(domain, pd, cfg)];
    if (pd && !pd.verified) {
      for (const v of pd.verification) {
        if (v.type === 'TXT') records.push({ type: 'TXT', name: strip(v.domain), content: v.value, proxied: false });
      }
    }
    return records;
  },

  async status(ctx, domain) {
    const projectId = await requireProjectId(ctx);
    const pd = await getProjectDomain(ctx, projectId, domain);
    if (!pd) return 'misconfigured';
    const cfg = await domainConfig(ctx, projectId, domain);
    if (pd.verified && cfg.misconfigured === false) return 'ok';
    if (!pd.verified) return 'pending';
    return (await publicDnsPointsElsewhere(ctx, domain, routingRecord(domain, pd, cfg))) ? 'misconfigured' : 'pending';
  },

  /**
   * Ask Vercel to check the `_vercel` TXT ownership challenge (a domain previously used by another
   * Vercel account/team). A write: success moves the domain to this project, so callers run it from
   * an approved step, never from plan/verify. Never re-verifies a verified domain.
   */
  async verify(ctx, domain) {
    const projectId = await requireProjectId(ctx);
    const pd = await getProjectDomain(ctx, projectId, domain);
    if (!pd) throw new VercelError(`${domain} is not attached to the Vercel project yet; attach it first, then verify.`, 404, 'not_found');
    if (pd.verified) return 'verified';
    const path = `/v9/projects/${encodeURIComponent(projectId)}/domains/${encodeURIComponent(domain)}/verify`;
    try {
      // Re-sending is safe: a repeat either verifies or reports the same state.
      const res = await vercelApi<{ verified?: boolean }>(ctx, 'POST', path, undefined, { idempotent: true });
      if (res.verified === false) return 'pending';
      ctx.log.info(`vercel: verified ownership of ${domain}`);
      return 'verified';
    } catch (e) {
      if (!(e instanceof VercelError)) throw e;
      // A lost response to an earlier successful attempt: the domain is verified now.
      if ((await getProjectDomain(ctx, projectId, domain).catch(() => null))?.verified) return 'verified';
      if (e.status === 400 && isTxtNotReady(e)) {
        ctx.log.info(`vercel: ${domain} ownership TXT record not visible to Vercel yet (DNS may still be propagating); retry later`);
        return 'pending';
      }
      if (e.status === 400 && /another project/i.test(e.detail ?? '')) {
        throw new VercelError(
          `Vercel is already verifying ${domain} for another project (only one TXT verification can run at a time). Remove the domain from that project in the Vercel dashboard, then retry.`,
          400,
          e.code,
          e.detail,
        );
      }
      throw e;
    }
  },
};

/** The verify call failed only because the TXT challenge isn't served (yet) or doesn't match. */
function isTxtNotReady(e: VercelError): boolean {
  const detail = e.detail ?? '';
  if (/another project/i.test(detail)) return false;
  if (e.code && /txt|verification_failed|not_verified/i.test(e.code)) return true;
  return /txt/i.test(detail) && /not found|no .*record|missing|does ?n[o']t match|mismatch|could not|unable/i.test(detail);
}

/** True when public DNS has an A/CNAME for `domain` that is not Vercel's (wrong record, not just slow). */
async function publicDnsPointsElsewhere(ctx: Ctx, domain: string, want: DnsRecord): Promise<boolean> {
  try {
    const seen = (await lookup(ctx, domain, want.type === 'A' ? 'A' : 'CNAME')).map(strip);
    if (seen.length === 0) return false;
    const vercelish = (v: string) => v === strip(want.content) || v.endsWith('.vercel-dns.com') || /\.vercel-dns-\d+\.com$/.test(v) || v === FALLBACK_A;
    return !seen.some(vercelish);
  } catch {
    return false;
  }
}
