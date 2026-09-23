import type { Link } from '../core/plan.js';
import type { AuthSettings, Axis, Ctx, HandoffItem, Step } from '../core/types.js';
import { adapterFor, axisStatus, deps, errMsg, intentOf, joinUrl, memo, productionUrl, projectIntent, ready, step, track, uniq } from './util.js';

const isLocalhost = (u: string | null): boolean => Boolean(u && /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:|\/|$)/i.test(u));

/**
 * Auth provider ← production URL: site URL + redirect allowlist (production, the app's callback
 * paths, and preview-deployment patterns only when `auth.previewRedirects: true`). Only adds redirect
 * URLs; never removes ones already there.
 */
export const authRedirectsLink: Link = {
  id: 'auth-redirects',
  async plan(ctx) {
    const au = await axisStatus(ctx, 'auth');
    if (au.kind === 'none' || au.kind === 'unauthed') return null;
    const prod = await productionUrl(ctx);
    if (au.kind === 'guided') return guided(au.title, prod);
    const authConfig = au.adapter.capabilities.authConfig;
    if (!authConfig) return null;
    if (!prod) return { steps: [], handoffs: [], warnings: [`${au.adapter.title} redirects: the production URL isn't known yet; apply this plan, then run \`plan\` again`] };

    const warnings: string[] = [];
    const projectAxis = projectAxisOf(ctx, au.adapter.id);
    const pending = projectAxis !== undefined && memo(ctx).pendingProjects.has(projectAxis);
    let before: AuthSettings = { siteUrl: null, redirectUrls: [] };
    if (!pending) {
      try {
        before = await authConfig.get(ctx);
      } catch (e) {
        return { steps: [], handoffs: [], warnings: [`reading ${au.adapter.title} auth settings failed (${errMsg(e)}); auth redirects left out of this plan`] };
      }
    }
    if (isLocalhost(before.siteUrl)) warnings.push(`${au.adapter.title} site URL is ${before.siteUrl} (localhost): production sign-in emails and redirects would point at a developer machine`);

    const { urls: wanted, preview: previewUrls } = await desiredRedirects(ctx, prod);
    if (ctx.config.targets.includes('preview') && !ctx.config.auth?.previewRedirects) {
      warnings.push(
        `${au.adapter.title} auth: preview deployments are not added to the redirect allowlist. It is the production auth config, and a preview wildcard there would let any matching host receive sign-in redirects. Sign-in on preview URLs fails unless you use a separate preview auth project, or set auth.previewRedirects: true in golive.yaml to accept that risk.`,
      );
    }
    const additions = wanted.filter((u) => !before.redirectUrls.includes(u));
    const siteChanges = before.siteUrl !== prod;
    if (!siteChanges && additions.length === 0) return { steps: [], handoffs: [], warnings };

    const preview = [
      ...(siteChanges ? [`site URL: ${before.siteUrl ?? '(unset)'} → ${prod}`] : []),
      ...additions.map((u) => (previewUrls.has(u) ? `add redirect URL ${u} (preview deployments, auth.previewRedirects: true — widens the PRODUCTION allowlist to every host matching this pattern)` : `add redirect URL ${u}`)),
      ...(pending ? [`(project not linked yet: existing redirect URLs found at apply time are kept)`] : []),
    ];
    const s = step({
      id: 'auth:redirects',
      title: `Point ${au.adapter.title} auth at ${prod}`,
      kind: 'wire',
      risk: { writes: true },
      dependsOn: deps(ctx, projectAxis ? [`project:${projectAxis}`] : []),
      preview,
      // Which auth project gets these settings: after a project switch the preview can read the same.
      intent: intentOf({ project: await projectIntent(ctx, au.adapter), site: prod, add: wanted }),
      verifyWith: ['auth-redirects'],
      async run(sctx) {
        const cur = await authConfig.get(sctx);
        const redirectUrls = uniq([...cur.redirectUrls, ...wanted]);
        const added = redirectUrls.filter((u) => !cur.redirectUrls.includes(u));
        await authConfig.set(sctx, { siteUrl: prod, redirectUrls });
        return { changes: [...(cur.siteUrl !== prod ? [`site URL ${cur.siteUrl ?? '(unset)'} → ${prod}`] : []), ...added.map((u) => `added redirect URL ${u}`)] };
      },
    });
    return { steps: track(ctx, [s] as Step[]), handoffs: [], warnings };
  },
};

/** Preview patterns only on explicit opt-in: this is the production auth project. */
async function desiredRedirects(ctx: Ctx, prod: string): Promise<{ urls: string[]; preview: Set<string> }> {
  const own = [`${prod}/**`, ...(ctx.config.auth?.redirectPaths ?? []).map((p) => joinUrl(prod, p))];
  let patterns: string[] = [];
  if (ctx.config.targets.includes('preview') && ctx.config.auth?.previewRedirects === true) {
    const h = await ready(ctx, 'hosting', 'url');
    patterns = h?.cap.previewPatterns ? await h.cap.previewPatterns(ctx).catch(() => [] as string[]) : [];
  }
  return { urls: uniq([own[0]!, ...patterns, ...own.slice(1)]), preview: new Set(patterns.filter((p) => !own.includes(p))) };
}

/** The project axis (hosting/db) served by the same provider, if its project is managed by a step. */
function projectAxisOf(ctx: Ctx, adapterId: string): Axis | undefined {
  return (['db', 'hosting'] as Axis[]).find((a) => adapterFor(ctx, a)?.id === adapterId);
}

/** Guided provider: golive can't read its dashboard settings, so this is a manual, non-blocking item. */
function guided(title: string, prod: string | null) {
  const where = prod ?? 'your production URL';
  const handoffs: HandoffItem[] = [
    {
      id: 'auth:redirects',
      why: `${title} isn't automated by golive, so its allowed origins and redirect URLs must be set in its dashboard (golive can't check them from outside).`,
      action: `In ${title}, add ${where} to the allowed origins / redirect URLs (and set it as the site/home URL). Remove any localhost entries from the production configuration. Confirm with the human that it's done, and name it as not verified by golive in your summary.`,
      blocking: false,
      manual: true,
    },
  ];
  return { steps: [], handoffs };
}
