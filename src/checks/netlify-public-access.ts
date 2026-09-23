import type { Check, Ctx } from '../core/types.js';
import { requireSite } from '../adapters/netlify-project.js';
import { confirmedProductionUrl, pass, probe, result, skip, type CheckOutcome } from './util.js';

export const NETLIFY_PUBLIC_ACCESS_CHECK = 'netlify-public-access';
interface BlockedProject { id: string; settingsUrl: string; }
interface AccessObservation { outcome: CheckOutcome; blockedProject?: BlockedProject; }

export function netlifyPublicAccessApplies(ctx: Ctx): boolean {
  return ctx.config.stack.hosting === 'netlify' && ctx.config.targets.includes('production');
}

export function netlifyVisibilityAction(project: BlockedProject): string {
  return `Open ${project.settingsUrl} and confirm project ID ${project.id}. In Project configuration > General > Visitor access > Project visibility, inspect only this project's setting. If Netlify visitor protection is blocking the intended public homepage, keep Private and choose Applies to: Previews only (or use Make public when it explicitly preserves private previews). Save only after approving this exact visibility change. Do not select a setting that exposes previews or change team defaults. If the team enforces private access, stop for the owner; do not weaken application authentication. Then run golive verify again; no redeploy is needed. This check verifies anonymous homepage access, not backend or application behavior.`;
}

/** Read-only production probe; response bodies, cookies and redirect URLs never enter evidence. */
export async function inspectNetlifyPublicAccess(ctx: Ctx): Promise<AccessObservation> {
  if (!netlifyPublicAccessApplies(ctx)) return { outcome: skip('only applies to Netlify production') };
  // The adapter requires an exact, ready, published production deployment before reporting a URL.
  // No config.domain or guessed site-name fallback is allowed here.
  const confirmed = await confirmedProductionUrl(ctx);
  if (!confirmed.ok) return { outcome: confirmed.outcome };
  let project: BlockedProject;
  try {
    const site = await requireSite(ctx);
    project = { id: site.id, settingsUrl: `https://app.netlify.com/projects/${encodeURIComponent(site.name)}/configuration/general/#project-visibility` };
  } catch {
    return { outcome: skip('cannot confirm the exact Netlify project for the production access check') };
  }
  let response;
  try {
    // Node HTTP has no cookie jar, receives no auth headers, and uses redirect: manual.
    response = await probe(ctx, confirmed.url);
  } catch {
    return { outcome: result('warn', 'medium', ['Anonymous production request could not complete; public access is unverified.'], 'Retry golive verify after checking network and site availability. No deployment or visibility setting was changed.') };
  }
  if (response.status >= 200 && response.status < 300) {
    return { outcome: pass([`Provider-confirmed production homepage returned HTTP ${response.status} without authentication or cookies.`, 'This proves anonymous homepage access only; backend and application behavior need separate checks.']) };
  }
  let netlifyGate = false;
  let sameOrigin = false;
  if (response.status >= 300 && response.status < 400 && response.headers.location) {
    try {
      const location = new URL(response.headers.location, confirmed.url);
      netlifyGate = location.origin === 'https://app.netlify.com' && location.pathname.replace(/\/+$/, '') === '/edge-access';
      sameOrigin = location.origin === new URL(confirmed.url).origin;
    } catch { /* Malformed redirects remain unverified; never echo the supplied Location. */ }
  }
  if (response.status === 401 || response.status === 403 || netlifyGate) {
    return {
      blockedProject: project,
      outcome: result('fail', 'high', [netlifyGate
        ? 'Production redirects anonymous visitors to Netlify access control; the redirect was not followed.'
        : `Production returned HTTP ${response.status} to an anonymous request; inspect project visibility and application authentication.`], netlifyVisibilityAction(project)),
    };
  }
  if (response.status >= 300 && response.status < 400) {
    return { outcome: result('warn', 'medium', [`Production returned HTTP ${response.status}; ${sameOrigin ? 'same-origin routing' : 'redirect destination'} requires a separate check. No redirect was followed; public access is unverified.`], 'Inspect the application route, then run golive verify again. Do not change visibility based only on this redirect.') };
  }
  return { outcome: result('fail', 'high', [`Anonymous production homepage returned HTTP ${response.status}; public access is not verified.`], 'Inspect the application response and Netlify deployment, then run golive verify again. This result alone does not identify a visibility setting problem.') };
}

export const netlifyPublicAccessCheck: Check = {
  id: NETLIFY_PUBLIC_ACCESS_CHECK,
  title: 'Netlify production is publicly accessible',
  severity: 'high',
  applies: netlifyPublicAccessApplies,
  async run(ctx) { return (await inspectNetlifyPublicAccess(ctx)).outcome; },
};
