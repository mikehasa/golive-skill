import type { Axis, Check, Ctx, EnvRef, EnvTarget, OutputKey } from '../core/types.js';
import { mapEnv } from '../core/envmap.js';
import { authBlock, cap, errMsg, pass, prereq, result, skip, trimSlash } from './util.js';

/** Supabase Edge Functions read their own secrets store, not the web host's env. */
function hostRefs(refs: EnvRef[]): EnvRef[] {
  return refs.filter((r) => r.files.length === 0 || r.files.some((f) => !/(^|\/)supabase\/functions\//.test(f)));
}

/** The chosen axis whose provider fills a semantic key (null = not a provider output, e.g. app.url). */
function sourceAxis(ctx: Ctx, key: OutputKey): Axis | null {
  if (key.startsWith('supabase.')) return ctx.config.stack.db ? 'db' : ctx.config.stack.auth ? 'auth' : null;
  if (key.startsWith('db.')) return 'db';
  if (key.startsWith('stripe.')) return 'payments';
  if (key.startsWith('resend.')) return 'email';
  return null;
}

/** Vercel-style "the token's role can't see some production vars": cannot verify, not missing. */
function isHiddenEnv(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code;
  return code === 'hidden_env' || /\bhidden\b/i.test(e instanceof Error ? e.message : String(e));
}

/**
 * Names golive intentionally does NOT fill for a target, so their absence there is not a failure.
 * Mirrors what the links write (links/payments.ts, links/env.ts): keep the two in sync.
 *  - stripe.webhookSecret: the webhook is registered for PRODUCTION only (preview URLs change per deployment).
 *  - app.url: only filled where the target has a stable URL (production: config.domain or the host's
 *    production URL; preview: whatever the host reports, usually none).
 */
async function notFilledReason(ctx: Ctx, target: EnvTarget, key: OutputKey, appUrl: (t: EnvTarget) => Promise<string | null>): Promise<string | null> {
  if (key === 'stripe.webhookSecret' && target !== 'production') return 'golive registers the webhook and writes its signing secret for production only';
  if (key === 'app.url' && !(await appUrl(target))) {
    return target === 'production'
      ? 'the production URL is not known until the first deploy; run `golive plan` again after it'
      : `${target} has no stable URL, so golive doesn't set it; set it yourself in the host's ${target} env if the code needs it there`;
  }
  return null;
}

/** Every env var NAME the code references exists in the host for each target. Names only. */
export const envParityCheck: Check = {
  id: 'env-parity',
  title: 'Host env has every variable the code references',
  severity: 'high',
  applies: (ctx) => Boolean(ctx.config.stack.hosting),
  async run(ctx) {
    const env = cap(ctx, 'hosting', 'env');
    if (!env) return skip(`hosting provider ${ctx.config.stack.hosting} has no env capability (guided)`);
    const pre = await prereq(ctx, 'hosting');
    if (pre) return pre;

    const { mapped, unmapped } = mapEnv(hostRefs(ctx.detect.envRefs));
    if (!mapped.length && !unmapped.length) return pass(['the code references no env vars golive needs to fill']);

    const urls = new Map<EnvTarget, Promise<string | null>>();
    const appUrl = (t: EnvTarget): Promise<string | null> => {
      if (!urls.has(t)) {
        const urlCap = cap(ctx, 'hosting', 'url');
        const fromHost = urlCap ? urlCap.get(ctx, t).then((u) => (u ? trimSlash(u) : null), () => null) : Promise.resolve(null);
        urls.set(t, t === 'production' && ctx.config.domain ? Promise.resolve(`https://${ctx.config.domain}`) : fromHost);
      }
      return urls.get(t)!;
    };
    const axisBlocks = new Map<Axis, Promise<string | null>>();
    const blockOf = (axis: Axis | null): Promise<string | null> => {
      if (!axis || !ctx.config.stack[axis]) return Promise.resolve(null);
      if (!axisBlocks.has(axis)) axisBlocks.set(axis, authBlock(ctx, axis));
      return axisBlocks.get(axis)!;
    };

    const evidence: string[] = [];
    const notes: string[] = [];
    const missingMapped: string[] = [];
    const missingUnmapped: string[] = [];
    const blockedBy = new Map<string, string[]>(); // reason -> name@target
    const block = (by: string, what: string) => blockedBy.set(by, [...(blockedBy.get(by) ?? []), what]);

    for (const target of ctx.config.targets) {
      let names: Set<string>;
      try {
        names = new Set(await env.listNames(ctx, target));
      } catch (e) {
        if (isHiddenEnv(e)) {
          block(`the hosting token's role cannot read ${target} env vars`, `${target}: ${errMsg(e)}`);
          continue;
        }
        return result('fail', 'high', [`could not list ${target} env names: ${errMsg(e)}`], 'Re-run verify; if it persists, check the hosting login with `golive doctor`.');
      }
      const mm: string[] = [];
      for (const m of mapped) {
        if (names.has(m.name)) continue;
        const why = await notFilledReason(ctx, target, m.key, appUrl);
        if (why) {
          notes.push(`${target}: ${m.name} not required (${why})`);
          continue;
        }
        const by = await blockOf(sourceAxis(ctx, m.key));
        if (by) block(by, `${m.name}@${target}`);
        else mm.push(m.name);
      }
      const mu = unmapped.filter((n) => !names.has(n));
      if (mm.length) {
        evidence.push(`${target}: missing ${mm.join(', ')}`);
        missingMapped.push(...mm.map((n) => `${n}@${target}`));
      }
      if (mu.length) {
        evidence.push(`${target}: missing (no provider output maps to these) ${mu.join(', ')}`);
        missingUnmapped.push(...mu.map((n) => `${n}@${target}`));
      }
      if (!mm.length && !mu.length) evidence.push(`${target}: every required referenced name present`);
    }

    const blockedLines = [...blockedBy].map(([by, what]) => `blocked by: ${by} (${what.join(', ')})`);
    if (missingMapped.length) {
      return result(
        'fail',
        'high',
        [...evidence, ...blockedLines, ...notes],
        `Run \`golive plan\`: it fills ${missingMapped.join(', ')} from the providers (or lists a handoff for any it can't). Apply it, then redeploy (build-time vars need a rebuild).`,
      );
    }
    // A missing prerequisite (provider not logged in, role can't read env) is not a finding: skip.
    if (blockedLines.length) return result('skip', 'info', [...blockedLines, ...evidence, ...notes]);
    if (missingUnmapped.length) {
      return result('warn', 'medium', [...evidence, ...notes], `golive cannot know what fills ${missingUnmapped.join(', ')}; set them in the host's env yourself (or remove the references), then redeploy.`);
    }
    return pass([...evidence, ...notes]);
  },
};
