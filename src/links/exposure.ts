import type { Link } from '../core/plan.js';
import { exposure, mappedEnv, SECRET_KEYS } from './util.js';

/**
 * Critical offline findings (e.g. a framework config that inlines a server secret into the browser
 * bundle) block the secret writes they affect: writing the secret would publish it with the next
 * deploy. The env/payments/email links leave those names out; this link tells the human why.
 * The item disappears from the next plan once detect no longer reports the problem.
 */
export const exposureLink: Link = {
  id: 'exposure',
  async plan(ctx) {
    const e = exposure(ctx);
    if (!e.findings.length) return null;
    const secretNames = [...new Set(mappedEnv(ctx).filter((m) => SECRET_KEYS.has(m.key)).map((m) => m.name))];
    const blocked = e.all ? secretNames : secretNames.filter((n) => e.names.has(n));
    const what = e.all ? 'every server secret (a finding does not name one variable)' : blocked.join(', ');
    return {
      steps: [],
      handoffs: [
        {
          id: 'secrets:exposed',
          why: `The code would publish server secrets in the browser bundle: ${e.findings.map((f) => f.title).join('; ')}.`,
          action: `Fix the code first (${e.findings.map((f) => f.fix ?? f.title).join(' ')}), then run \`plan\` again.${what ? ` Until detect stops reporting this, golive won't write ${what} to the host.` : ''}`,
          blocking: true,
        },
      ],
      warnings: blocked.length ? [`secret writes held back until the exposure is fixed: ${blocked.join(', ')}`] : [],
    };
  },
};
