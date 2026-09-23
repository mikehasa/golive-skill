import type { Check, Ctx } from '../core/types.js';
import { lookup, type RRType } from '../core/doh.js';
import { allowHost } from '../core/http.js';
import { cap, errMsg, hostVariants, pass, prereq, probe, result } from './util.js';

/** How long after golive changed DNS a non-resolving domain counts as "still propagating". */
export const PROPAGATION_MS = 48 * 60 * 60 * 1000;

/** The only step that writes the records domain-live looks for (A/AAAA/CNAME at the custom domain). */
export const HOSTING_DNS_STEP = 'domain:dns';

/**
 * Did golive publish the hosting records recently (per state)? Email DNS steps and domain:attach never
 * touch the domain's A/AAAA/CNAME, so they must not turn a broken domain into "still propagating".
 */
function recentlyChanged(ctx: Ctx): boolean {
  const rec = ctx.state.get().steps[HOSTING_DNS_STEP];
  return Boolean(rec && rec.status === 'done' && Date.now() - Date.parse(rec.at) < PROPAGATION_MS);
}

/**
 * The custom domain resolves publicly, the host reports it configured (when the host can say so), and
 * it serves the site over valid HTTPS. For a host without a domain capability (guided) this is DNS +
 * HTTPS only and says so in its evidence.
 */
export const domainLiveCheck: Check = {
  id: 'domain-live',
  title: 'Custom domain resolves and serves HTTPS',
  severity: 'high',
  applies: (ctx) => Boolean(ctx.config.domain),
  async run(ctx) {
    const d = ctx.config.domain!;
    const evidence: string[] = [];

    const found: string[] = [];
    const errors: string[] = [];
    for (const type of ['A', 'AAAA', 'CNAME'] as RRType[]) {
      try {
        const vals = await lookup(ctx, d, type);
        if (vals.length) found.push(`${type} ${vals.slice(0, 3).join(', ')}`);
      } catch (e) {
        errors.push(`${type}: ${errMsg(e)}`);
      }
    }
    if (!found.length) {
      const ev = [`${d} has no A/AAAA/CNAME records in public DNS`, ...errors];
      if (recentlyChanged(ctx)) return result('warn', 'medium', [...ev, 'DNS was changed recently: not propagated yet'], 'Wait for DNS to propagate (usually minutes, up to 48h), then re-run verify.');
      return result('fail', 'high', ev, `Point ${d} at your host: run \`golive plan\` (automated DNS) or add the records your host lists for ${d} at your DNS provider.`);
    }
    evidence.push(`DNS: ${found.join('; ')}`);

    // Only the host can say the domain is attached to THIS project: a domain that resolves and answers
    // HTTPS may still be the user's old site or a parking page. So when the host has a domain
    // capability, pass requires its 'ok'; an unknown status skips (never passes) and 'pending' warns.
    const attach = cap(ctx, 'hosting', 'domain');
    if (attach) {
      const pre = await prereq(ctx, 'hosting');
      if (pre) return pre;
      let st;
      try {
        st = await attach.status(ctx, d);
      } catch (e) {
        return result('skip', 'info', [`cannot confirm ${d} is attached to your ${ctx.config.stack.hosting ?? 'hosting'} project: the host domain status is unavailable (${errMsg(e)})`, ...evidence]);
      }
      evidence.push(`host reports domain ${st}`);
      if (st === 'misconfigured') return result('fail', 'high', evidence, `${d} is not attached to your hosting project or its DNS does not point at the host. Run \`golive plan\` (it attaches the domain and shows the records the host requires) and fix them at your DNS provider.`);
      if (st === 'pending') {
        return result('warn', 'medium', evidence, `The host has not confirmed ${d} yet: DNS may still be propagating, or domain ownership is not verified (e.g. a TXT challenge because the domain was used by another account). Add any records \`golive plan\` lists, apply, then re-run verify.`);
      }
    } else {
      evidence.push(
        ctx.config.stack.hosting
          ? `host attachment not confirmed: ${ctx.config.stack.hosting} can't report domain status (guided), so this checks DNS + HTTPS only`
          : 'host attachment not confirmed: no hosting provider chosen, so this checks DNS + HTTPS only',
      );
    }

    // Read-only GET of the configured domain itself (this check's subject; no other probe targets it unconfirmed).
    const url = `https://${d}/`;
    for (const h of hostVariants(d)) allowHost(h);
    let res;
    try {
      res = await probe(ctx, url);
    } catch (e) {
      return result('fail', 'high', [...evidence, `GET ${url} failed (TLS or connection error): ${errMsg(e)}`], 'The certificate may still be issuing (a few minutes after DNS resolves); if it persists, check the domain status in your host dashboard.');
    }
    evidence.push(`GET ${url} → HTTP ${res.status}${res.headers.location ? ` (→ ${res.headers.location})` : ''}`);
    if (res.status >= 200 && res.status < 400) return pass(evidence);
    return result('fail', 'high', evidence, `${d} resolves and serves TLS but returns HTTP ${res.status}. Check that the domain is attached to the right project and the production deployment is healthy.`);
  },
};
