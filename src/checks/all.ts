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
import { emailDnsCheck, emailVerifiedCheck } from './email.js';
import { domainLiveCheck } from './domain.js';
import { netlifyPublicAccessCheck } from './netlify-public-access.js';

/** Every verification check, in report order. Wire into checks/index.ts as CHECKS. */
export const ALL_CHECKS: Check[] = [
  accountsCheck,
  envParityCheck,
  domainLiveCheck,
  netlifyPublicAccessCheck,
  bundleSecretsCheck,
  rlsCheck,
  dbConnectionCheck,
  authRedirectsCheck,
  authPolicyCheck,
  authSignupCheck,
  authSessionCheck,
  webhookUnsignedCheck,
  webhookRegisteredCheck,
  stripeLiveReadyCheck,
  emailDnsCheck,
  emailVerifiedCheck,
];
