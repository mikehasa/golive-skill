import type { Link } from '../core/plan.js';
import { accountsLink } from './accounts.js';
import { exposureLink } from './exposure.js';
import { projectsLink } from './projects.js';
import { envLink } from './env.js';
import { domainLink } from './domain.js';
import { paymentsLink } from './payments.js';
import { authRedirectsLink } from './auth.js';
import { authSettingsLink } from './auth-settings.js';
import { authE2eLink } from './auth-e2e.js';
import { emailDomainLink, emailKeysLink } from './email.js';
import { deployLink } from './deploy.js';
import { netlifyVisibilityLink } from './netlify-visibility.js';

/**
 * Every link, in plan order. Order matters beyond display: accounts resets the per-plan memo and
 * must be first; links only depend on steps planned before them (domain before payments/auth, all
 * env-writing links before deploy — the deploy link also makes domain:attach wait for a first
 * production deploy), which orderSteps() then sorts topologically.
 */
export const ALL_LINKS: Link[] = [accountsLink, exposureLink, projectsLink, envLink, domainLink, paymentsLink, authRedirectsLink, authSettingsLink, authE2eLink, emailDomainLink, emailKeysLink, deployLink, netlifyVisibilityLink];
