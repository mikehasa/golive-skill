import type { Link } from '../core/plan.js';
import { AXES, type Axis, type HandoffItem } from '../core/types.js';
import { adapterFor, authOf, resetMemo } from './util.js';

/**
 * Access first: every automated provider must be reachable before its steps can run. A provider
 * whose access cannot be verified becomes a blocking handoff and its steps are left out (other
 * links see that through `ready()`/`axisStatus()`, which share the cached auth result).
 */
export const accountsLink: Link = {
  id: 'accounts',
  async plan(ctx) {
    resetMemo(ctx); // first link of every plan: start from fresh observations
    const handoffs: HandoffItem[] = [];
    const warnings: string[] = [];
    const byProvider = new Map<string, Axis[]>();
    for (const axis of AXES) {
      const id = ctx.config.stack[axis];
      if (id) byProvider.set(id, [...(byProvider.get(id) ?? []), axis]);
    }
    if (byProvider.size === 0) return null;

    for (const [id, axes] of byProvider) {
      const adapter = adapterFor(ctx, axes[0]!);
      if (!adapter || !adapter.automated) {
        for (const axis of axes) {
          handoffs.push({
            id: `guided:${axis}`,
            why: `${adapter?.title ?? id} (${axis}) isn't automated by golive yet, so its setup is guided.`,
            action: `Follow references/guided.md for the ${axis} axis with ${adapter?.title ?? id}: use best-effort guidance from official CLI/MCP/API documentation, falling back to dashboard steps. Get explicit approval before external writes. Run available checks and record their scope; skipped or unavailable checks remain unverified, and golive does not verify this provider's login.`,
            blocking: false,
          });
        }
        continue;
      }
      const unsupported = axes.filter((a) => !adapter.axes.includes(a));
      if (unsupported.length) warnings.push(`${adapter.title} doesn't cover ${unsupported.join(', ')}; pick another provider for that axis`);
      const status = await authOf(ctx, adapter);
      if (status.ok) continue;
      handoffs.push({
        id: `login:${adapter.id}`,
        why: `golive needs access to your ${adapter.title} account to wire ${axes.join(', ')}.`,
        action: status.howToFix ?? `Log in to ${adapter.title} with its CLI's browser login, run in a separate terminal window (Claude Code's \`!\` prefix has no interactive terminal), then run \`plan\` again.`,
        blocking: true,
        verifiedBy: 'accounts',
      });
      warnings.push(`${adapter.title} access could not be verified: its steps are left out of this plan. Follow the account handoff, then run \`plan\` again.`);
    }
    return { steps: [], handoffs, warnings };
  },
};
