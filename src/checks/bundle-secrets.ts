import type { Check } from '../core/types.js';
import { scanBundleAt } from './bundle.js';
import { confirmedProductionUrl } from './util.js';

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
    return scanBundleAt(ctx, confirmed.url);
  },
};
