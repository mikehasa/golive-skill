import type { Check } from '../core/types.js';
import { confirmedProductionUrl, errMsg, pass, probe, result, skip, trimSlash } from './util.js';

/** The headers a pass requires: transport security and MIME sniffing (clickjacking is checked below). */
const CORE = ['strict-transport-security', 'x-content-type-options'];
/** Also reported, never required: an app without a CSP or a referrer policy is common and legitimate. */
const OPTIONAL = ['content-security-policy', 'referrer-policy', 'permissions-policy'];
/** Stack banners: named when the host exposes them, never a finding on their own. */
const BANNERS = ['server', 'x-powered-by'];
const FRAME_ANCESTORS = /frame-ancestors/i;

/** Header values are evidence, not a payload: keep report lines bounded. */
const clip = (v: string): string => (v.length > 200 ? `${v.slice(0, 200)}…` : v);

/** Where an app's own response headers are set on the two supported hosts. golive never sets them. */
const howToFix = (headers: string[]): string =>
  `Set ${headers.join(', ')} on the app's responses: on Vercel in the \`headers\` block of vercel.json (or the framework's next.config headers()), on Netlify in netlify.toml \`[[headers]]\` or a _headers file. golive deploys the app but does not set its response headers, so this is a change in your repo — then redeploy and re-run verify.`;

/**
 * One read-only GET of the host-confirmed production URL (never config.domain) for the response
 * headers the app itself sets. The core set decides pass; everything else warns and nothing fails,
 * because an app without a CSP or a referrer policy is a normal, deliberate choice. A response that
 * cannot be read — 401/403 (a private deployment), a redirect, or a request that never completes —
 * is not evidence about headers, so it never fails the run.
 */
export const siteHeadersCheck: Check = {
  id: 'site-headers',
  title: 'Production responses carry the core security headers',
  severity: 'medium',
  applies: () => true,
  async run(ctx) {
    const confirmed = await confirmedProductionUrl(ctx);
    if (!confirmed.ok) return confirmed.outcome;
    // confirmedProductionUrl reports https origins only, so HSTS always applies to what is probed.
    const url = `${trimSlash(confirmed.url)}/`;

    let res;
    try {
      res = await probe(ctx, url, { headers: { 'user-agent': 'golive-verify' }, timeoutMs: 15_000 });
    } catch (e) {
      return result('warn', 'medium', [`could not fetch ${url}: ${errMsg(e)}`], 'Make sure the production deployment is reachable, then re-run verify.');
    }

    const got = `GET ${url} → HTTP ${res.status}`;
    if (res.status === 401 || res.status === 403) {
      return skip(`${got}: the deployment may be private (visitor access, SSO or an auth wall answering anonymous requests), so its headers are unverified; make production publicly reachable, then re-run verify`);
    }
    if (res.status >= 300 && res.status < 400) {
      return skip(`${got}: a redirect is not followed, so the headers of the app itself are unverified; point the production URL at the deployed app (or set the host's redirect), then re-run verify`);
    }
    if (res.status < 200 || res.status >= 300) {
      return result('warn', 'medium', [`${got}: the production page did not load, so its headers are unverified`], 'Fix the deployment, then re-run verify.');
    }

    const h = res.headers;
    const header = (name: string): string => `${name}: ${h[name] ? clip(h[name]!) : 'absent'}`;
    const frameOptions = h['x-frame-options'];
    const frameAncestors = FRAME_ANCESTORS.test(h['content-security-policy'] ?? '');
    const clickjacking = Boolean(frameOptions) || frameAncestors;
    const evidence = [
      got,
      ...[...CORE, ...OPTIONAL].map(header),
      `clickjacking protection: ${frameOptions ? header('x-frame-options') : frameAncestors ? 'content-security-policy frame-ancestors' : 'absent'}`,
    ];
    for (const name of BANNERS) {
      const v = h[name];
      if (v) evidence.push(`${name}: ${clip(v)} (names the stack; not a finding)`);
    }

    const missing: string[] = [];
    if (!h['strict-transport-security']) missing.push('strict-transport-security');
    if (!h['x-content-type-options']) missing.push('x-content-type-options');
    if (!clickjacking) missing.push('clickjacking protection (x-frame-options or a CSP frame-ancestors)');
    if (missing.length) return result('warn', 'medium', [...evidence, `missing: ${missing.join(', ')}`], howToFix(missing));
    const optional = OPTIONAL.filter((name) => !h[name]);
    if (optional.length) return result('warn', 'low', [...evidence, `missing (optional, not a failure): ${optional.join(', ')}`], howToFix(optional));
    return pass(evidence);
  },
};
