import type { Check } from '../core/types.js';
import { fetchBundle, scanSecrets, type SecretHit } from './bundle.js';
import { confirmedProductionUrl, errMsg, pass, result } from './util.js';

/** Scan fetched public HTML/JS for known credential patterns; evidence never includes values. */
export const bundleSecretsCheck: Check = {
  id: 'bundle-secrets',
  title: 'Known credential patterns in public HTML/JavaScript',
  severity: 'critical',
  applies: () => true,
  async run(ctx) {
    // Only crawl what the host confirms is this project's production URL (never config.domain blindly).
    const confirmed = await confirmedProductionUrl(ctx);
    if (!confirmed.ok) return confirmed.outcome;
    const base = confirmed.url;

    let bundle;
    try {
      bundle = await fetchBundle(ctx, base);
    } catch (e) {
      return result('warn', 'medium', [`could not fetch ${base}/: ${errMsg(e)}`], 'Make sure the production deployment is reachable, then re-run verify.');
    }

    const seen = new Set<string>();
    const hits: SecretHit[] = [];
    for (const f of bundle.files) {
      for (const h of scanSecrets(f)) {
        const key = `${h.secret.fingerprint}@${h.path}`;
        if (!seen.has(key)) {
          seen.add(key);
          hits.push(h);
        }
      }
    }
    const scanned = `scanned ${bundle.files.length} file(s) from ${base}`;
    if (hits.length) {
      const evidence = hits.map((h) => `${h.kind} in ${h.path} (fp:${h.secret.fingerprint})`);
      return result(
        'fail',
        'critical',
        [...evidence, scanned, ...bundle.notes],
        'Treat these keys as leaked: rotate each one at its provider now, keep the replacement in a server-only env var (no NEXT_PUBLIC_/VITE_/PUBLIC_ prefix, never imported by client code), then redeploy.',
      );
    }
    if (bundle.offsite) {
      return result(
        'warn',
        'medium',
        [scanned, ...bundle.notes],
        'The production URL redirects away from your app (deployment protection, an auth wall or another site), so its scripts were not scanned. Make the production URL publicly reachable (e.g. turn off deployment protection for production), then re-run verify.',
      );
    }
    if (bundle.htmlStatus < 200 || bundle.htmlStatus >= 300) {
      return result('warn', 'medium', [scanned, ...bundle.notes], 'The production page did not load, so its scripts were not scanned. Fix the deployment, then re-run verify.');
    }
    if (!bundle.complete) {
      return result(
        'warn',
        'medium',
        [scanned, 'scan incomplete: no credential patterns found in the scanned portion', ...bundle.notes],
        'Some public JavaScript could not be scanned because an asset failed to load or the bounded scan limit was reached. Fix failed asset requests and re-run verify; review any content beyond the scan limit separately. This result does not establish that the complete bundle is free of credentials.',
      );
    }
    return pass([scanned, 'no credential patterns found', ...bundle.notes]);
  },
};
