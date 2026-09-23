import type { Check } from '../core/types.js';
import { baseUrl, blocked, cap, errMsg, globMatch, isLocalhost, pass, prereq, result, skip, trimSlash } from './util.js';

/** Concrete URL to test a configured redirect path (which may itself contain globs) against. */
function concrete(base: string, path: string): string {
  return base + (path.startsWith('/') ? path : `/${path}`).replace(/\*\*/g, 'golive/probe').replace(/\*/g, 'golive');
}

/** Auth site URL is the production URL and the redirect allowlist covers it; no localhost. */
export const authRedirectsCheck: Check = {
  id: 'auth-redirects',
  title: 'Auth redirects point at production',
  severity: 'high',
  applies: (ctx) => Boolean(ctx.config.stack.auth),
  async run(ctx) {
    const auth = cap(ctx, 'auth', 'authConfig');
    if (!auth) return skip(`auth provider ${ctx.config.stack.auth} has no auth-config capability (guided)`);
    const pre = await prereq(ctx, 'auth');
    if (pre) return pre;
    const prod = await baseUrl(ctx);
    if (!prod) return blocked('deploy:production', 'no production URL yet');

    let cfg;
    try {
      cfg = await auth.get(ctx);
    } catch (e) {
      return result('fail', 'high', [`could not read auth settings: ${errMsg(e)}`], 'Re-run verify; if it persists, check the auth provider with `golive doctor`.');
    }

    const problems: string[] = [];
    const evidence: string[] = [`production URL: ${prod}`, `site URL: ${cfg.siteUrl ?? '(unset)'}`];
    if (!cfg.siteUrl) problems.push('site URL is not set');
    else if (isLocalhost(cfg.siteUrl)) problems.push(`site URL is localhost (${cfg.siteUrl}): emails and OAuth will send production users to localhost`);
    else if (trimSlash(cfg.siteUrl) !== prod) problems.push(`site URL ${cfg.siteUrl} is not the production URL`);

    const paths = ctx.config.auth?.redirectPaths;
    if (paths?.length) {
      const uncovered = paths.filter((p) => !cfg.redirectUrls.some((pat) => globMatch(pat, concrete(prod, p))));
      if (uncovered.length) problems.push(`redirect allowlist does not cover ${uncovered.map((p) => prod + p).join(', ')}`);
      else evidence.push(`redirect allowlist covers ${paths.map((p) => prod + p).join(', ')}`);
    } else {
      // No paths configured: any allowlist entry on the production origin counts.
      const onProd = cfg.redirectUrls.filter((pat) => globMatch(pat, prod) || globMatch(pat, concrete(prod, '/**')) || trimSlash(pat).toLowerCase().startsWith(`${prod.toLowerCase()}/`));
      if (!onProd.length) problems.push(`redirect allowlist has no entry for ${prod}`);
      else evidence.push(`redirect allowlist covers ${prod} (${onProd.slice(0, 3).join(', ')})`);
    }

    const local = cfg.redirectUrls.filter(isLocalhost);
    if (problems.length) {
      return result('fail', 'high', [...problems, ...evidence], `Run \`golive plan\` and apply the auth-redirects step (sets site URL to ${prod} and adds ${prod}/** to the allowlist).`);
    }
    if (local.length) {
      return result('warn', 'low', [`allowlist still includes localhost: ${local.join(', ')}`, ...evidence], 'Fine for a shared dev project; for a production-only project remove localhost entries.');
    }
    return pass(evidence);
  },
};
