import type { EnvRef, Finding, OutputKey } from './types.js';

/**
 * Maps the env var NAMES an app's code actually references to the semantic provider outputs that
 * should fill them. We fill what the code asks for (no invented names), so the app works as written.
 */

/** Framework conventions for variables inlined into the browser bundle. */
export const CLIENT_PREFIXES = ['NEXT_PUBLIC_', 'VITE_', 'PUBLIC_', 'EXPO_PUBLIC_', 'REACT_APP_', 'NUXT_PUBLIC_', 'GATSBY_'] as const;

export function clientPrefix(name: string): string | null {
  return CLIENT_PREFIXES.find((p) => name.startsWith(p)) ?? null;
}
export function stripClientPrefix(name: string): string {
  const p = clientPrefix(name);
  return p ? name.slice(p.length) : name;
}

interface Rule {
  key: OutputKey;
  /** Matched against the name with any client prefix stripped. */
  re: RegExp;
  /** Must never be exposed to the browser. */
  secret: boolean;
}

// Order matters: first match wins.
const RULES: Rule[] = [
  { key: 'supabase.url', re: /^SUPABASE_URL$/, secret: false },
  { key: 'supabase.publishableKey', re: /^SUPABASE_(ANON|PUBLISHABLE)(_DEFAULT)?_KEY$/, secret: false },
  { key: 'supabase.secretKey', re: /^SUPABASE_(SERVICE_ROLE|SERVICE|SECRET)(_KEY)?$/, secret: true },
  { key: 'db.directUrl', re: /^(DIRECT_URL|DATABASE_URL_UNPOOLED|POSTGRES_URL_NON_POOLING|DIRECT_DATABASE_URL)$/, secret: true },
  { key: 'db.url', re: /^(DATABASE_URL|POSTGRES_URL|POSTGRES_PRISMA_URL|SUPABASE_DB_URL|DB_URL)$/, secret: true },
  { key: 'stripe.publishableKey', re: /^STRIPE_(PUBLISHABLE|PUBLIC)_KEY$/, secret: false },
  { key: 'stripe.webhookSecret', re: /^STRIPE_(WEBHOOK_SECRET|WEBHOOK_SIGNING_SECRET|SIGNING_SECRET|ENDPOINT_SECRET)$/, secret: true },
  { key: 'stripe.secretKey', re: /^STRIPE_(SECRET_KEY|SECRET|API_KEY|KEY)$/, secret: true },
  { key: 'resend.apiKey', re: /^RESEND_(API_)?KEY$/, secret: true },
  // PostHog's project token ships in the browser bundle by design (like Supabase's anon key), so the
  // rule is not a server secret: the bundle scan and the exposure guard must not flag it. The bare
  // POSTHOG_API_KEY is deliberately NOT matched: that is PostHog's name for a PERSONAL API key
  // (golive's own operator credential, POSTHOG_API_KEY), and filling a server-side personal-key name
  // with the public project token would be exactly the mixup this comment exists to prevent.
  { key: 'posthog.key', re: /^POSTHOG_(PROJECT_(API_)?)?(KEY|TOKEN)$/, secret: false },
  { key: 'posthog.host', re: /^POSTHOG_(API_)?HOST$/, secret: false },
  // Sentry's DSN ships in the browser bundle by design (it is what the SDK reports events with), so
  // the rule is not a server secret. SENTRY_AUTH_TOKEN is deliberately NOT matched: that is golive's
  // own operator credential, and filling an app-side name with a browser-visible DSN would be exactly
  // the mixup this comment exists to prevent.
  { key: 'sentry.dsn', re: /^SENTRY_DSN$/, secret: false },
  { key: 'app.url', re: /^(SITE_URL|APP_URL|BASE_URL|PUBLIC_URL|URL|NEXTAUTH_URL|BETTER_AUTH_URL|AUTH_URL)$/, secret: false },
];

export interface EnvMapping {
  name: string;
  key: OutputKey;
  clientExposed: boolean;
}

export interface EnvMapResult {
  mapped: EnvMapping[];
  unmapped: string[];
  findings: Finding[];
}

/** Names that are set by the platform or are obviously not ours to fill. */
const IGNORE = /^(NODE_ENV|VERCEL(_.*)?|CI|PORT|HOST|TZ|npm_.*|NEXT_RUNTIME|NEXT_PHASE|MODE|DEV|PROD|SSR|BASE_URL_PATH|CF_PAGES.*)$/;

export function mapEnv(refs: EnvRef[]): EnvMapResult {
  const mapped: EnvMapping[] = [];
  const unmapped: string[] = [];
  const findings: Finding[] = [];
  for (const ref of refs) {
    const bare = stripClientPrefix(ref.name);
    if (IGNORE.test(ref.name) || IGNORE.test(bare)) continue;
    const rule = RULES.find((r) => r.re.test(bare));
    if (!rule) {
      unmapped.push(ref.name);
      continue;
    }
    const clientExposed = ref.clientExposed || clientPrefix(ref.name) !== null;
    if (rule.secret && clientExposed) {
      findings.push({
        id: 'secret-in-client-env',
        severity: 'critical',
        title: `${ref.name} puts a server secret into the browser bundle`,
        evidence: [`${ref.name} (${rule.key}) is referenced in: ${ref.files.slice(0, 5).join(', ')}`],
        fix: clientPrefix(ref.name)
          ? `Rename it to ${bare} and only read it in server code (API routes, server actions, edge functions). Anyone can read client-prefixed variables from your site's JavaScript.`
          : `${ref.name} is inlined into the browser bundle by the framework config (next.config \`env\`, a Vite/Astro \`define\`, or a custom public prefix). Remove it from that config and only read it in server code.`,
      });
      continue; // never fill it
    }
    mapped.push({ name: ref.name, key: rule.key, clientExposed });
  }
  return { mapped, unmapped, findings };
}
