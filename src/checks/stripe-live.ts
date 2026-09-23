import type { Check } from '../core/types.js';
import { modeFor } from '../core/config.js';
import { accountStatus } from './providers.js';
import { errMsg, pass, prereq, result } from './util.js';

/** Live payments only work once the Stripe account is activated (KYC done, charges enabled). */
export const stripeLiveReadyCheck: Check = {
  id: 'stripe-live-ready',
  title: 'Stripe account can take live payments',
  severity: 'high',
  applies: (ctx) => ctx.config.stack.payments === 'stripe' && modeFor(ctx.config, 'production') === 'live',
  async run(ctx) {
    const pre = await prereq(ctx, 'payments', { project: false });
    if (pre) return pre;
    let st;
    try {
      st = await accountStatus(ctx, 'live');
    } catch (e) {
      // A restricted key without Account read gets 403: readiness is unknown, not failed.
      if ((e as { status?: number }).status === 403) {
        return result('warn', 'medium', ['live readiness unknown: this key cannot read the Stripe account (restricted key without Account: Read)'], 'Check Settings → Account in the Stripe Dashboard, or give the key Account: Read, then re-run verify.');
      }
      return result('fail', 'high', [`could not read the live Stripe account: ${errMsg(e)}`], 'Re-run verify; if it persists, check the Stripe login with `golive doctor`.');
    }
    const ev = [`charges_enabled: ${st.chargesEnabled}`, `details_submitted: ${st.detailsSubmitted}`];
    if (st.chargesEnabled) return pass(ev);
    return result(
      'fail',
      'high',
      ev,
      'Finish Stripe account activation yourself (business details, identity verification, bank account) at https://dashboard.stripe.com/account/onboarding, then re-run verify.',
    );
  },
};
