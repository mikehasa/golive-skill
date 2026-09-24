/**
 * Release checks for an opted-in preview deployment (`release.preview: true` in golive.yaml).
 *
 * The preview deploy records the provider's own identity for the deployment it made
 * (`deployed:preview:id`). These checks re-read that record against the world:
 *   - `preview-deploy`: the hosting provider's own read confirms a ready deployment that belongs to
 *     the project golive links and that it is NOT the production deployment.
 *   - `preview-bundle`: the HTML/JS served by the provider-confirmed preview URL carries no known
 *     credential patterns. Previews are private by default, so a 401/403 wall skips with the reason.
 *
 * `release:check` (src/links/release.ts) runs both as its inline verification, so a failure here fails
 * that step and stops the plan: that is the gate. Promoting a checked preview to production is a later
 * slice — a promotion step would depend on `release:check`.
 */
import type { Check, Ctx } from '../core/types.js';
import { deployedIdKey, readRecordedDeploy, type RecordedDeploy } from '../links/util.js';
import { scanBundleAt } from './bundle.js';
import { cap, errMsg, pass, prereq, result, skip, type CheckOutcome } from './util.js';

const TARGET = 'preview';
const trimSlash = (url: string): string => url.replace(/\/+$/, '');

interface PreviewRead {
  /** The deployment golive recorded for the preview target (`deployed:preview:id`). */
  recorded: RecordedDeploy;
  /** What the hosting adapter reports for the preview target, or null when it reports none. */
  url: string | null;
  /** The project the hosting adapter is linked to now, when it can name one. Evidence only. */
  project?: string;
}

/**
 * The recorded preview deployment plus the preview URL the hosting provider reports for it. Anything
 * that makes that read impossible is a skip, never a pass: another provider's recording, a guided or
 * logged-out host, or a host that does not report a preview URL at all.
 */
async function readPreview(ctx: Ctx): Promise<{ ok: true; read: PreviewRead } | { ok: false; outcome: CheckOutcome }> {
  const recorded = readRecordedDeploy(ctx, TARGET);
  if (!recorded) return { ok: false, outcome: skip(`golive recorded no preview deployment (no ${deployedIdKey(TARGET)} in .golive/state.json), so there is nothing to confirm`) };
  const provider = ctx.config.stack.hosting;
  if (!provider) return { ok: false, outcome: skip('no hosting provider is chosen') };
  if (recorded.provider !== provider) return { ok: false, outcome: skip(`the recorded preview deployment belongs to ${recorded.provider}, not to the chosen hosting provider (${provider})`) };
  const url = cap(ctx, 'hosting', 'url');
  if (!url) return { ok: false, outcome: skip(`hosting provider ${provider} is guided and cannot report its URLs, so the recorded preview deployment cannot be read`) };
  const pre = await prereq(ctx, 'hosting');
  if (pre) return { ok: false, outcome: pre };

  const linker = cap(ctx, 'hosting', 'project');
  const current = linker ? await linker.current(ctx).catch(() => null) : null;
  let got: string | null;
  try {
    got = await url.get(ctx, TARGET);
  } catch (e) {
    return { ok: false, outcome: result('warn', 'medium', [`could not read the ${provider} preview deployment: ${errMsg(e)}`], 'Check the hosting login with `golive doctor`, then re-run verify.') };
  }
  return { ok: true, read: { recorded, url: got ? trimSlash(got) : null, ...(current ? { project: `${current.name} (${current.id})` } : {}) } };
}

/** The URL golive recorded for the deployment it made for production, if any. */
function recordedProductionUrl(ctx: Ctx): string | null {
  const prod = readRecordedDeploy(ctx, 'production');
  return prod ? trimSlash(prod.url) : null;
}

/**
 * The provider's own read of the preview deployment golive recorded: it exists, it is ready, it belongs
 * to the project this repo links, and it is not the project's production deployment. A "preview" that
 * is the production deployment fails: a promotion or a bundle scan of it would not cover a preview.
 * Nothing here claims the preview is publicly reachable.
 */
export const previewDeployCheck: Check = {
  id: 'preview-deploy',
  title: 'The recorded preview deployment is provider-confirmed and is not production',
  severity: 'high',
  applies: (ctx) => Boolean(ctx.config.stack.hosting),
  async run(ctx) {
    const r = await readPreview(ctx);
    if (!r.ok) return r.outcome;
    const { recorded, url, project } = r.read;
    const where = `${recorded.provider} deployment ${recorded.id}`;
    const recordedAt = `recorded by golive ${recorded.at} (${deployedIdKey(TARGET)})`;
    const prod = recordedProductionUrl(ctx);

    if (prod && recorded.url === prod) {
      return result(
        'fail',
        'high',
        [`golive recorded ${recorded.url} as both the preview deployment (${where}) and the production deployment it made`, recordedAt],
        'Deploy a preview that is not the production deployment: run `golive plan` and apply the preview:deploy step, then re-run this check. A gate over the production deployment would not cover a preview.',
      );
    }
    if (!url) {
      return skip(
        `no ${recorded.provider} read confirms ${where} (${recorded.url}): this adapter reports no preview URL for the project (it exposes no per-deployment preview read, or the recorded deployment is no longer a preview), and golive does not probe or guess one — previews are protected by default. Confirm it in ${recorded.provider}'s own dashboard or CLI; golive leaves it unverified`,
      );
    }
    if (prod && url === prod) {
      return result(
        'fail',
        'high',
        [`${recorded.provider} reports ${url} for the preview target, which is the URL golive recorded for the production deployment`, recordedAt],
        'Deploy a preview that is not the production deployment: run `golive plan` and apply the preview:deploy step, then re-run this check.',
      );
    }
    if (url === recorded.url) {
      return pass([
        `${where} is what ${recorded.provider} reports for the preview target${project ? ` of the project this repo links (${project})` : ''}`,
        `that read confirms the deployment exists, is ready and belongs to this project, and that it is not the project's production deployment`,
        recordedAt,
        'whether anyone else can reach the preview is not read here: a private preview is normal, and the production deployment is unchanged',
      ]);
    }
    return result(
      'warn',
      'medium',
      [
        `${recorded.provider} reports ${url} for the preview target, while golive recorded ${recorded.url} (${where})`,
        'a newer preview deployment exists: only the provider\'s latest preview is readable this way, so the recorded deployment was not re-read',
        recordedAt,
      ],
      'Run `golive plan` and apply the preview steps so the recorded deployment and the release check cover the same preview.',
    );
  },
};

/**
 * Scan the HTML/JavaScript the provider-confirmed preview URL serves for known credential patterns.
 * The preview URL has to come from the provider's own read of the linked project — golive never scans
 * a URL it cannot attribute to this project — and a protected preview (401/403) skips with the reason
 * instead of passing or failing the app.
 */
export const previewBundleCheck: Check = {
  id: 'preview-bundle',
  title: 'Known credential patterns in the preview deployment HTML/JavaScript',
  severity: 'critical',
  applies: (ctx) => Boolean(ctx.config.stack.hosting),
  async run(ctx) {
    const r = await readPreview(ctx);
    if (!r.ok) return r.outcome;
    const { recorded, url } = r.read;
    if (!url) {
      return skip(
        `no ${recorded.provider} read confirms a preview URL to scan (the recorded ${recorded.provider} deployment ${recorded.id}, ${recorded.url}, is unverified by golive); golive never scans a URL it cannot attribute to this project`,
      );
    }
    const outcome = await scanBundleAt(ctx, url, { what: 'preview', protected: true });
    return {
      ...outcome,
      evidence: [...outcome.evidence, `${recorded.provider} reports ${url} for the preview deployment golive recorded (${recorded.id}); a preview that is protected or unreachable is never treated as clean`],
    };
  },
};
