import type { Check, Ctx, DnsRecord, Severity } from '../core/types.js';
import { lookup, type RRType } from '../core/doh.js';
import { authBlock, blocked, cap, errMsg, isFailing, pass, prereq, result, sendingDomainOf, skip, worst } from './util.js';

/** Selectors tried for DKIM, provider-specific first. Newer Resend domains use per-domain tokens. */
const DKIM_SELECTORS: Record<string, string[]> = {
  resend: ['resend'],
  postmark: ['pm'],
  sendgrid: ['s1', 's2'],
  ses: [],
};
const GENERIC_SELECTORS = ['default', 'google', 'selector1', 'selector2', 'k1', 's1', 'mail', 'dkim'];

interface Issue {
  severity: Severity;
  line: string;
}

/** DoH lookup that reports failures instead of throwing, so one bad lookup doesn't sink the check. */
async function q(ctx: Ctx, name: string, type: RRType, errors: string[]): Promise<string[]> {
  try {
    return await lookup(ctx, name, type);
  } catch (e) {
    errors.push(`${type} ${name}: ${errMsg(e)}`);
    return [];
  }
}

async function findDkim(ctx: Ctx, d: string, provider: string, errors: string[]): Promise<string | null> {
  const selectors = [...new Set([...(DKIM_SELECTORS[provider] ?? []), ...GENERIC_SELECTORS])];
  for (const sel of selectors) {
    const name = `${sel}._domainkey.${d}`;
    if ((await q(ctx, name, 'TXT', errors)).some((t) => /(^|;)\s*(v=DKIM1|p=)/i.test(t))) return `TXT ${name}`;
    if ((await q(ctx, name, 'CNAME', errors)).length) return `CNAME ${name}`;
  }
  return null;
}

const short = (v: string) => (v.length > 48 ? `${v.slice(0, 45)}…` : v);
const bareHost = (v: string) => v.trim().replace(/\.$/, '').toLowerCase();

/** Does the published record set at rec.name satisfy the record the provider asked for? */
function satisfies(rec: DnsRecord, published: string[]): boolean {
  if (rec.type === 'TXT') {
    const want = rec.content.trim();
    if (/^v=spf1\b/i.test(want)) {
      // A merged SPF record is fine as long as it keeps every include:/a/mx mechanism the provider needs.
      const mech = want.split(/\s+/).filter((t) => /^(include:|a\b|mx\b|ip4:|ip6:)/i.test(t)).map((t) => t.toLowerCase());
      return published.some((p) => /^v=spf1\b/i.test(p) && mech.every((m) => p.toLowerCase().split(/\s+/).includes(m)));
    }
    return published.some((p) => p.trim() === want);
  }
  if (rec.type === 'MX') return published.some((p) => bareHost(p.replace(/^\d+\s+/, '')) === bareHost(rec.content));
  if (rec.type === 'CNAME') return published.some((p) => bareHost(p) === bareHost(rec.content));
  return published.some((p) => p.trim() === rec.content.trim());
}

/** Check exactly the records the provider says the domain needs (incl. per-domain DKIM token names). */
async function checkProviderRecords(ctx: Ctx, records: DnsRecord[], issues: Issue[], ok: string[], errors: string[]): Promise<void> {
  for (const rec of records) {
    const published = await q(ctx, rec.name, rec.type as RRType, errors);
    const label = `${rec.type} ${rec.name}`;
    if (satisfies(rec, published)) ok.push(`${label}: matches ${short(rec.content)}`);
    else if (published.length) issues.push({ severity: 'high', line: `${label} is ${short(published[0]!)} but the provider expects ${short(rec.content)}` });
    else issues.push({ severity: 'high', line: `${label} is missing (the provider expects ${short(rec.content)})` });
  }
}

const isSpf = (t: string) => /^v=spf1\b/i.test(t);

/**
 * Providers whose DKIM selector is per-domain and can't be discovered over DNS (Postmark:
 * `<timestamp>pm._domainkey`; SES Easy DKIM: three `<token>._domainkey` CNAMEs). Not finding one is
 * only a low-severity note, since a correctly set-up domain looks the same from outside.
 */
const DKIM_UNDISCOVERABLE: Record<string, string> = {
  postmark: `Postmark's DKIM selector is per-domain (<timestamp>pm._domainkey.{d}) and can't be discovered over DNS; confirm DKIM shows verified in Postmark`,
  ses: `SES Easy DKIM uses three <token>._domainkey.{d} CNAMEs that can't be discovered over DNS; confirm DKIM shows verified in the SES console`,
};

/**
 * Heuristic when the provider's record list isn't available: the SPF / return-path / DKIM locations
 * each provider documents. Only Resend's send.<d> layout makes a missing SPF a failure; for the
 * others SPF is either not needed (Postmark's and SES's default return paths pass SPF) or lives at a
 * name golive can't discover (SendGrid's em####.<d>), so a missing one is at most a note.
 */
async function checkCommonRecords(ctx: Ctx, d: string, provider: string, issues: Issue[], ok: string[], notes: string[], errors: string[]): Promise<void> {
  const spfApex = (await q(ctx, d, 'TXT', errors)).find(isSpf);

  if (provider === 'resend') {
    // Resend puts SPF and the bounce MX (or the newer CNAME form) on the send.<d> return-path subdomain.
    const spfSend = (await q(ctx, `send.${d}`, 'TXT', errors)).find(isSpf);
    const sendCname = await q(ctx, `send.${d}`, 'CNAME', errors);
    if (spfSend || spfApex) {
      ok.push(`SPF at ${spfSend ? `send.${d}` : d}: ${spfSend ?? spfApex}`);
      if (spfSend && !/include:amazonses\.com/i.test(spfSend)) {
        issues.push({ severity: 'medium', line: `SPF at send.${d} does not include amazonses.com (Resend sends through SES)` });
      }
    } else if (sendCname.length) {
      ok.push(`SPF via CNAME send.${d} → ${sendCname[0]}`);
    } else {
      issues.push({ severity: 'high', line: `no SPF record at send.${d} or ${d}` });
    }
    const mx = await q(ctx, `send.${d}`, 'MX', errors);
    if (mx.length) ok.push(`MX at send.${d}: ${mx[0]}`);
    else if (sendCname.length) ok.push(`return path via CNAME send.${d}`);
    else issues.push({ severity: 'high', line: `no MX or CNAME at send.${d} (bounce handling / return path)` });
  } else if (provider === 'postmark') {
    if (spfApex) ok.push(`SPF at ${d}: ${spfApex}`);
    const rp = await q(ctx, `pm-bounces.${d}`, 'CNAME', errors);
    if (rp.length) ok.push(`return path via CNAME pm-bounces.${d} → ${rp[0]}`);
    else notes.push(`no custom return path (CNAME pm-bounces.${d} → pm.mtasv.net): optional, Postmark's default return path already passes SPF; a custom one adds SPF alignment for DMARC`);
  } else if (provider === 'ses') {
    if (spfApex) ok.push(`SPF at ${d}: ${spfApex}`);
    else notes.push(`SPF not required: SES's default MAIL FROM (amazonses.com) passes SPF; a custom MAIL FROM subdomain can't be discovered over DNS, so it isn't checked`);
  } else if (provider === 'sendgrid') {
    // Automated security: s1/s2._domainkey and em####.<d> are CNAMEs into sendgrid.net; em#### is
    // what SPF checks, and its number can't be discovered, so the DKIM CNAME stands in as evidence.
    const auto = (await q(ctx, `s1._domainkey.${d}`, 'CNAME', errors)).find((v) => /(^|\.)sendgrid\.net\.?$/i.test(v.trim()));
    if (spfApex) ok.push(`SPF at ${d}: ${spfApex}`);
    else if (auto) ok.push(`SPF via SendGrid automated security (s1._domainkey.${d} → ${auto}); its em####.${d} return-path CNAME can't be discovered over DNS`);
    else issues.push({ severity: 'low', line: `no SPF record at ${d} and no SendGrid automated-security CNAMEs found; fine if the em####.${d} return-path CNAME exists (it can't be discovered over DNS), otherwise add include:sendgrid.net to the SPF record` });
  } else {
    // A provider golive has no layout for: the apex is the usual place; send.<d> is common too.
    const spfSend = (await q(ctx, `send.${d}`, 'TXT', errors)).find(isSpf);
    if (spfSend || spfApex) ok.push(`SPF at ${spfSend ? `send.${d}` : d}: ${spfSend ?? spfApex}`);
    else issues.push({ severity: 'medium', line: `no SPF record found at ${d} or send.${d}; ${provider} may use a return-path subdomain golive can't discover, so compare with the records ${provider} lists` });
  }

  // DKIM: selector names aren't discoverable over DNS, so this is a heuristic (warn, not fail).
  const dkim = await findDkim(ctx, d, provider, errors);
  if (dkim) ok.push(`DKIM at ${dkim}`);
  else if (DKIM_UNDISCOVERABLE[provider]) issues.push({ severity: 'low', line: `DKIM not confirmed: ${DKIM_UNDISCOVERABLE[provider]!.replace('{d}', d)}` });
  else if (provider === 'resend') issues.push({ severity: 'medium', line: `no DKIM record found at common selectors (resend._domainkey.${d}, …); newer domains use provider-specific token names, see the \`email-verified\` check` });
  else issues.push({ severity: 'medium', line: `no DKIM record found at common selectors (${(DKIM_SELECTORS[provider] ?? GENERIC_SELECTORS).slice(0, 2).map((s) => `${s}._domainkey.${d}`).join(', ')}, …); the selector is provider-specific, so confirm DKIM in the ${provider} dashboard` });
}

/**
 * SPF, DKIM and DMARC for the sending domain, observed over public DNS (DoH). Read-only. When the
 * provider can list the records it needs (SendingDomain.records) for the recorded domain, exactly
 * those are checked; otherwise the locations each provider documents are probed heuristically (see
 * checkCommonRecords: records a provider doesn't need, or keeps at undiscoverable names, never fail).
 */
export const emailDnsCheck: Check = {
  id: 'email-dns',
  title: 'Email sending domain has SPF, DKIM and DMARC',
  severity: 'high',
  applies: (ctx) => Boolean(ctx.config.stack.email && sendingDomainOf(ctx)),
  async run(ctx) {
    const d = sendingDomainOf(ctx)!;
    const provider = ctx.config.stack.email!;
    const issues: Issue[] = [];
    const ok: string[] = [];
    const errors: string[] = [];
    const notes: string[] = [];

    let records: DnsRecord[] | null = null;
    const sd = cap(ctx, 'email', 'sendingDomain');
    const id = ctx.state.resource(`${provider}.domainId`);
    // Automated provider but the sending domain doesn't exist yet: nothing to look for in DNS.
    // (Guided providers have no state, so they always get the passive public-DNS check.)
    if (sd && !id) return skip(`blocked by: email:domain (the ${provider} sending domain for ${d} hasn't been created yet)`);
    if (sd?.records && id) {
      const by = await authBlock(ctx, 'email');
      if (by) notes.push(`provider record list unavailable (blocked by: ${by}); checked common record locations instead`);
      else {
        try {
          const got = (await sd.records(ctx, id)).filter((r) => ['TXT', 'MX', 'CNAME'].includes(r.type));
          if (got.length) records = got;
          else notes.push(`${provider} listed no DNS records for ${d}; checked common record locations instead`);
        } catch (e) {
          notes.push(`could not read ${provider}'s record list (${errMsg(e)}); checked common record locations instead`);
        }
      }
    }

    if (records) await checkProviderRecords(ctx, records, issues, ok, errors);
    else await checkCommonRecords(ctx, d, provider, issues, ok, notes, errors);

    const dmarc = (await q(ctx, `_dmarc.${d}`, 'TXT', errors)).find((t) => /^v=DMARC1\b/i.test(t));
    if (dmarc) ok.push(`DMARC at _dmarc.${d}: ${dmarc}`);
    else issues.push({ severity: 'medium', line: `no DMARC record at _dmarc.${d}; suggested: TXT _dmarc.${d} "v=DMARC1; p=none;"` });

    if (errors.length) issues.push({ severity: 'low', line: `some DNS lookups failed: ${errors.slice(0, 3).join('; ')}` });

    const sev = worst(issues.map((i) => i.severity));
    const lines = [...issues.map((i) => i.line), ...ok, ...notes];
    const fix = `Add the DNS records your email provider lists for ${d} (run \`golive plan\` to upsert them when your DNS provider is automated); add DMARC as TXT _dmarc.${d} "v=DMARC1; p=none;" and tighten to p=quarantine once mail flows.`;
    if (isFailing(sev)) return result('fail', sev, lines, fix);
    if (issues.length) return result('warn', sev === 'info' ? 'low' : sev, lines, fix);
    return pass(lines);
  },
};

/** The email provider reports the sending domain as verified. */
export const emailVerifiedCheck: Check = {
  id: 'email-verified',
  title: 'Email sending domain is verified',
  severity: 'high',
  applies: (ctx) => Boolean(ctx.config.stack.email),
  async run(ctx) {
    const provider = ctx.config.stack.email!;
    const sd = cap(ctx, 'email', 'sendingDomain');
    if (!sd) return skip(`email provider ${provider} has no sending-domain capability (guided)`);
    const pre = await prereq(ctx, 'email', { project: false });
    if (pre) return pre;
    const id = ctx.state.resource(`${provider}.domainId`);
    const d = sendingDomainOf(ctx) ?? '(domain)';
    if (!id) return blocked('email:domain', `no ${provider} sending domain recorded for ${d} yet; run \`golive plan\` and apply it`);

    let st;
    try {
      st = await sd.status(ctx, id);
    } catch (e) {
      return result('fail', 'high', [`could not read ${provider} domain ${id}: ${errMsg(e)}`], 'Re-run verify; if it persists, check the email provider with `golive doctor`.');
    }
    const ev = [`${provider} domain ${d} (${id}): ${st}`];
    if (st === 'verified') return pass(ev);
    if (st === 'pending') return result('warn', 'medium', ev, 'DNS checks are still running at the provider (can take minutes to hours after records are added). Re-run verify later.');
    if (st === 'not_started') return result('warn', 'medium', ev, 'Verification has not been requested yet: re-run apply (the email-domain step triggers it) once the DNS records exist.');
    return result('fail', 'high', ev, `The provider could not find the DNS records. Compare the records for ${d} in the provider dashboard with your DNS (see the \`email-dns\` check), fix them, then re-run apply.`);
  },
};
