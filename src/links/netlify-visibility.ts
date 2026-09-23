import type { Link } from '../core/plan.js';
import { inspectNetlifyPublicAccess, NETLIFY_PUBLIC_ACCESS_CHECK, netlifyPublicAccessApplies, netlifyVisibilityAction } from '../checks/netlify-public-access.js';

/** Visibility has no supported API mutation: the user reviews one exact project's UI setting. */
export const netlifyVisibilityLink: Link = {
  id: 'netlify-visibility',
  async plan(ctx) {
    if (!netlifyPublicAccessApplies(ctx)) return null;
    const observed = await inspectNetlifyPublicAccess(ctx);
    if (!observed.blockedProject) return null;
    const project = observed.blockedProject;
    return {
      steps: [],
      handoffs: [{
        // Handoff IDs are included in the approved plan hash: bind this request to the exact site.
        id: `netlify:public-access:${project.id}`,
        why: 'The published Netlify production homepage blocks anonymous access. Deployment succeeded; public access is still unverified.',
        action: netlifyVisibilityAction(project),
        url: project.settingsUrl,
        blocking: true,
        verifiedBy: NETLIFY_PUBLIC_ACCESS_CHECK,
      }],
    };
  },
};
