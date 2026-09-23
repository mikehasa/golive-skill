import type { Adapter, Axis, Check } from '../core/types.js';
import { errMsg, pass, result } from './util.js';

/** Every automated provider the human chose is authenticated (CLI login or env token). */
export const accountsCheck: Check = {
  id: 'accounts',
  title: 'Provider accounts are connected',
  severity: 'high',
  applies: (ctx) => Object.values(ctx.config.stack).some(Boolean),
  async run(ctx) {
    // One adapter can serve several axes (e.g. supabase for db + auth); authenticate it once.
    const chosen = new Map<string, { adapter?: Adapter; axes: Axis[] }>();
    for (const [axis, id] of Object.entries(ctx.config.stack) as Array<[Axis, string | undefined]>) {
      if (!id) continue;
      const entry = chosen.get(id) ?? { adapter: ctx.adapters.find((a) => a.id === id), axes: [] };
      entry.axes.push(axis);
      chosen.set(id, entry);
    }

    const evidence: string[] = [];
    const fixes: string[] = [];
    for (const [id, { adapter, axes }] of chosen) {
      const label = `${id} (${axes.join(', ')})`;
      if (!adapter || !adapter.automated) {
        evidence.push(`${label}: guided provider, no login needed by golive`);
        continue;
      }
      try {
        const st = await adapter.auth(ctx);
        if (st.ok) evidence.push(`${label}: ok${st.via ? ` via ${st.via}` : ''}`);
        else {
          evidence.push(`${label}: not connected`);
          fixes.push(`${adapter.title}: ${st.howToFix ?? `log in with the ${adapter.title} CLI in a separate terminal window (Claude Code's \`!\` prefix has no interactive terminal)`}`);
        }
      } catch (e) {
        evidence.push(`${label}: auth check errored: ${errMsg(e)}`);
        fixes.push(`${adapter.title}: check that its CLI is installed and logged in, then re-run`);
      }
    }
    if (!fixes.length) return pass(evidence);
    return result('fail', 'high', evidence, `The human does this (never paste tokens into chat; other checks stay skipped until it's done): ${fixes.join('; ')}`);
  },
};
