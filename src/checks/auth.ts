import type { Check, Ctx, Severity } from '../core/types.js';
import { cap, errMsg, isFailing, pass, prereq, result, skip, worst } from './util.js';

/** The minimum password length golive is comfortable with (provider defaults start at 6). */
const MIN_PASSWORD = 12;

interface Issue {
  severity: Severity;
  line: string;
  /** What the human can do about exactly this issue. */
  fix: string;
}

/** Does the app's code use the chosen auth provider (a sign-up/login path golive must not break)? */
function appUsesAuth(ctx: Ctx, provider: string): boolean {
  return Boolean(ctx.detect.providers.auth?.includes(provider));
}

/**
 * Auth policy of the chosen provider: signup, email confirmation, minimum password length and the
 * mailer that sends auth emails. Read-only. Nothing here proves the app's sign-up flow works end to
 * end; that needs a real account (a later journey).
 */
export const authPolicyCheck: Check = {
  id: 'auth-policy',
  title: 'Auth policy matches the app and the configured baseline',
  severity: 'high',
  applies: (ctx) => Boolean(ctx.config.stack.auth),
  async run(ctx) {
    const provider = ctx.config.stack.auth!;
    const auth = cap(ctx, 'auth', 'authConfig');
    if (!auth) return skip(`auth provider ${provider} has no auth-config capability (guided)`);
    const pre = await prereq(ctx, 'auth');
    if (pre) return pre;

    let cfg;
    try {
      cfg = await auth.get(ctx);
    } catch (e) {
      return result('fail', 'high', [`could not read ${provider} auth settings: ${errMsg(e)}`], 'Re-run verify; if it persists, check the auth provider with `golive doctor`.');
    }

    const issues: Issue[] = [];
    const evidence: string[] = [];
    const missing: string[] = [];

    // Signup: golive.yaml states the intent; the app's code only hints at it, so never over-claim.
    const wantSignup = ctx.config.auth?.signup;
    if (cfg.signupEnabled === undefined) missing.push('signup');
    else {
      evidence.push(`signup: ${cfg.signupEnabled ? 'open' : 'closed'}`);
      if (!cfg.signupEnabled && wantSignup === true) {
        issues.push({
          severity: 'high',
          line: 'signup is closed although golive.yaml asks for `auth.signup: true`: new users cannot register',
          fix: 'Re-run `plan` + `apply` (the `auth:settings` step writes it), or set `auth.signup: false` if this app really takes no new users.',
        });
      } else if (!cfg.signupEnabled && wantSignup === undefined && appUsesAuth(ctx, provider)) {
        issues.push({
          severity: 'medium',
          line: `signup is closed while this app's code uses ${provider} auth and golive.yaml does not say whether it takes new users: any sign-up path in the app would fail`,
          fix: `Say what this app needs in golive.yaml: \`auth.signup: true\` to take new users (then \`plan\` + \`apply\`), or \`auth.signup: false\` to confirm that closing signup is intended.`,
        });
      } else if (!cfg.signupEnabled && wantSignup === false) {
        evidence.push('signup is closed as configured (auth.signup: false)');
      } else if (cfg.signupEnabled && wantSignup === false) {
        issues.push({
          severity: 'medium',
          line: 'signup is open although golive.yaml says `auth.signup: false`: the setting is not in effect, so the provider still takes new users',
          fix: 'Re-run `plan` + `apply` (the `auth:settings` step writes it), or set `auth.signup: true` if this app does take new users.',
        });
      }
    }

    // Email confirmation: required when golive.yaml says so; off in production is a risk either way.
    const requireEmailConfirm = ctx.config.auth?.requireEmailConfirm;
    if (cfg.emailConfirmRequired === undefined) missing.push('email confirmation');
    else {
      evidence.push(`email confirmation: ${cfg.emailConfirmRequired ? 'required' : 'off'}`);
      if (!cfg.emailConfirmRequired && requireEmailConfirm === true) {
        issues.push({
          severity: 'high',
          line: 'email confirmation is off although golive.yaml asks for `auth.requireEmailConfirm: true`: signups are not proven to belong to a real inbox',
          fix: `Re-run \`plan\` + \`apply\` (the \`auth:settings\` step writes it), or remove \`auth.requireEmailConfirm\` if confirmation is not wanted.`,
        });
      } else if (!cfg.emailConfirmRequired && ctx.config.targets.includes('production')) {
        issues.push({
          severity: 'medium',
          line: 'email confirmation is off in production: signups are not proven to belong to a real inbox',
          fix: `Require confirmation with \`auth.requireEmailConfirm: true\` in golive.yaml, then \`plan\` + \`apply\`; set it to \`false\` explicitly to accept the risk.`,
        });
      }
    }

    // Password length: below the configured floor fails; the provider's weak default only warns.
    const floor = ctx.config.auth?.passwordMinLength;
    if (cfg.minPasswordLength === undefined) missing.push('password minimum length');
    else {
      evidence.push(`password minimum length: ${cfg.minPasswordLength}`);
      if (typeof floor === 'number' && cfg.minPasswordLength < floor) {
        issues.push({
          severity: 'high',
          line: `password minimum length is ${cfg.minPasswordLength}, below the floor golive.yaml asks for (auth.passwordMinLength: ${floor})`,
          fix: `Re-run \`plan\` + \`apply\` (the \`auth:settings\` step sets it), or lower \`auth.passwordMinLength\` to what the provider allows.`,
        });
      } else if (cfg.minPasswordLength < MIN_PASSWORD) {
        issues.push({
          severity: 'medium',
          line: `password minimum length is ${cfg.minPasswordLength}; ${MIN_PASSWORD} or more is the safe baseline`,
          fix: `Set \`auth.passwordMinLength: ${MIN_PASSWORD}\` (or higher) in golive.yaml, then \`plan\` + \`apply\`, or set it in the ${provider} dashboard.`,
        });
      }
    }

    // Mailer: the provider's built-in mailer is rate-limited and meant for testing.
    if (!cfg.smtp) missing.push('auth email (SMTP)');
    else {
      evidence.push(cfg.smtp.configured ? `auth email: custom SMTP${cfg.smtp.host ? ` (${cfg.smtp.host})` : ''}` : 'auth email: provider built-in mailer');
      if (!cfg.smtp.configured && ctx.config.auth?.smtp !== 'provider') {
        issues.push({
          severity: 'medium',
          line: `auth emails go through ${provider}'s built-in mailer, which is rate-limited and meant for testing`,
          fix: `Configure custom SMTP in the ${provider} dashboard, or accept the built-in mailer with \`auth.smtp: provider\` in golive.yaml.`,
        });
      }
    }

    if (cfg.emailRateLimitPerHour === undefined) missing.push('rate limit');
    else evidence.push(`rate limit: ${cfg.emailRateLimitPerHour} auth emails/hour`);

    if (!evidence.length) return skip(`${provider} does not report auth policy settings through its API (only the site URL and redirects are readable)`);
    if (missing.length) evidence.push(`not reported by ${provider}: ${missing.join(', ')}`);

    const sev = worst(issues.map((i) => i.severity));
    const lines = [...issues.map((i) => i.line), ...evidence];
    if (isFailing(sev)) return result('fail', sev, lines, issues.filter((i) => isFailing(i.severity)).map((i) => i.fix).join(' '));
    if (issues.length) return result('warn', sev, lines, issues.map((i) => i.fix).join(' '));
    return pass(lines);
  },
};
