import type { Check } from '../core/types.js';
import { accountsCheck } from './accounts.js';
import { envParityCheck } from './env-parity.js';
import { bundleSecretsCheck } from './bundle-secrets.js';
import { rlsCheck } from './rls.js';
import { dbConnectionCheck } from './db-connection.js';
import { webhookRegisteredCheck, webhookUnsignedCheck } from './webhook.js';
import { stripeLiveReadyCheck } from './stripe-live.js';
import { authRedirectsCheck } from './auth-redirects.js';
import { authPolicyCheck } from './auth.js';
import { authSignupCheck } from './auth-signup.js';
import { authSessionCheck } from './auth-session.js';
import { authRecoveryCheck } from './auth-recovery.js';
import { authIsolationCheck } from './auth-isolation.js';
import { emailDnsCheck, emailVerifiedCheck } from './email.js';
import { domainLiveCheck } from './domain.js';
import { netlifyPublicAccessCheck } from './netlify-public-access.js';
import { siteHeadersCheck } from './site-headers.js';
import { previewBundleCheck, previewDeployCheck, productionReleaseCheck } from './release.js';

/** Every verification check, in report order. Wire into checks/index.ts as CHECKS. */
export const ALL_CHECKS: Check[] = [
  accountsCheck,
  envParityCheck,
  domainLiveCheck,
  netlifyPublicAccessCheck,
  siteHeadersCheck,
  bundleSecretsCheck,
  rlsCheck,
  dbConnectionCheck,
  authRedirectsCheck,
  authPolicyCheck,
  authSignupCheck,
  authSessionCheck,
  authRecoveryCheck,
  authIsolationCheck,
  webhookUnsignedCheck,
  webhookRegisteredCheck,
  stripeLiveReadyCheck,
  emailDnsCheck,
  emailVerifiedCheck,
  previewDeployCheck,
  previewBundleCheck,
  productionReleaseCheck,
];
