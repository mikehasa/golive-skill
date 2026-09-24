import { randomBytes } from 'node:crypto';
import type { Check, Ctx } from '../core/types.js';
import { vaultGet } from '../core/secret.js';
import { SupabaseAuthPrereqError, testPassword } from '../adapters/supabase-auth.js';
import { TEST_USER_EMAIL, TEST_USER_ID, testUserPassKey } from '../links/auth-e2e.js';
import { adapterFor, blocked, cap, errMsg, pass, prereq, result, skip } from './util.js';

/** `you+gl-ab12cd@example.com`: still the human's own inbox, a fresh account on every run. */
function probeAddress(email: string): string {
  const m = /^([^@+]+)(?:\+[^@]*)?@([^@\s]+)$/.exec(email);
  return m ? `${m[1]}+gl-${randomBytes(3).toString('hex')}@${m[2]}` : email;
}

/**
 * The signup half of the authentication journey, in the four steps that make it evidence:
 * a fresh probe address is signed up and gets a confirmation email; the SAME address is refused a
 * password login until it is confirmed (that refusal is what proves confirmation is enforced, not
 * just configured); the seeded test account reads back as `email_confirmed_at` after the human
 * clicked; and that confirmed account can finally sign in.
 *
 * Opt-in only (`auth.e2e: true`), because the signup probe creates a real account. golive cannot
 * read an inbox, so delivery and the click always stay human-confirmed.
 */
export const authSignupCheck: Check = {
  id: 'auth-signup',
  title: 'Signup sends a confirmation email and an unconfirmed account cannot sign in',
  severity: 'high',
  applies: (ctx) => Boolean(ctx.config.stack.auth),
  async run(ctx) {
    if (ctx.config.auth?.e2e !== true) {
      return skip('auth.e2e is not enabled in golive.yaml: this check signs up a probe account in the real project, so it only runs on explicit opt-in');
    }
    const provider = ctx.config.stack.auth!;
    const title = adapterFor(ctx, 'auth')?.title ?? provider;
    const email = ctx.config.auth.testEmail;
    if (!email) return skip('auth.testEmail is not set in golive.yaml, so golive has no inbox address for the test account');
    const auth = cap(ctx, 'auth', 'authUsers');
    if (!auth) return skip(`auth provider ${provider} has no auth-users surface (guided): the signup journey stays a manual dashboard task`);
    const pre = await prereq(ctx, 'auth');
    if (pre) return pre;
    const seeded = ctx.state.resource(TEST_USER_ID);
    if (!seeded) return blocked('auth:test-user', 'no test account has been seeded yet');

    const evidence: string[] = [];
    // 1. A fresh address: the signup must ask for a confirmation, and must not hand out a session.
    const probe = probeAddress(email);
    const probePass = testPassword();
    let signup;
    try {
      signup = await auth.signup(ctx, probe, probePass);
    } catch (e) {
      if (e instanceof SupabaseAuthPrereqError) return skip(errMsg(e));
      return result('fail', 'high', [`signing up a probe account failed: ${errMsg(e)}`], `Check that ${provider} auth is reachable and that the project accepts new users (\`auth.signup: true\`), then re-run verify.`);
    }
    if (signup.captchaRequired) {
      return skip(`${title} requires a captcha for signup, so a scripted signup cannot run (golive will not claim a pass it cannot evidence)`);
    }
    if (signup.rateLimited) {
      return result('warn', 'medium', [`signup for the probe address ${probe} was rate-limited (HTTP 429)`, ...evidence], `Wait for ${title}'s auth email limit to reset (or configure custom SMTP and raise the auth rate limit), then re-run verify.`);
    }
    if (!signup.confirmationSent) {
      return result(
        'fail',
        'high',
        [
          `the signup for ${probe} was accepted without sending a confirmation email (HTTP ${signup.status}${signup.existing ? ', the address already has an account' : ''})`,
          ...evidence,
        ],
        `Require email confirmation: \`auth.requireEmailConfirm: true\` in golive.yaml, then \`plan\` + \`apply\` (the auth:settings step) and \`verify --only auth-policy,auth-signup\`.`,
      );
    }
    evidence.push(`signed up probe account ${probe}: confirmation email sent (HTTP ${signup.status})`);

    let refused;
    try {
      refused = await auth.login(ctx, probe, probePass);
    } catch (e) {
      if (e instanceof SupabaseAuthPrereqError) return skip(errMsg(e));
      return result('fail', 'high', [`the password login for the probe account failed: ${errMsg(e)}`, ...evidence], `Check that ${provider} auth is reachable and re-run verify.`);
    }
    if (refused.session) {
      return result(
        'fail',
        'critical',
        [`the unconfirmed probe account ${probe} signed in and got a session: email confirmation is not enforced`, ...evidence],
        `Require email confirmation (\`auth.requireEmailConfirm: true\`, then \`plan\` + \`apply\` for the auth:settings step). An account that can sign in before its address is confirmed is not proven to belong to a real inbox.`,
      );
    }
    if (refused.rateLimited) {
      return result('warn', 'medium', [`the immediate login for the probe account was rate-limited (HTTP 429), so confirmation enforcement is not proven`, ...evidence], 'Wait for the rate limit to reset, then re-run verify.');
    }
    if (!(refused.code ?? '').includes('email_not_confirmed')) {
      return result(
        'warn',
        'medium',
        [`the unconfirmed probe account was refused sign-in with "${refused.code}" instead of \`email_not_confirmed\`, so confirmation enforcement is not proven`, ...evidence],
        'Re-run verify; if it persists, check the project\'s confirmation settings and the signup flow in the app.',
      );
    }
    evidence.push(`the same address cannot sign in before confirming (${refused.code})`);

    // 2. The seeded account: the human's click is visible as `email_confirmed_at`, and login works.
    const seededEmail = ctx.state.resource(TEST_USER_EMAIL) ?? email;
    let view;
    try {
      view = await auth.adminUser(ctx, seeded);
    } catch (e) {
      if (e instanceof SupabaseAuthPrereqError) return skip(errMsg(e));
      return result('fail', 'high', [`could not read the test account ${seeded}: ${errMsg(e)}`, ...evidence], 'Re-run verify; if it persists, check the provider login and read the user in its dashboard.');
    }
    if (!view) {
      return result('fail', 'high', [`the test account ${seeded} recorded in .golive/state.json is gone from ${title}`, ...evidence], 'Delete the recorded test account from the provider dashboard, or remove it from .golive/state.json, then re-run `plan` + `apply` to seed a new one.');
    }
    if (!view.emailConfirmed) {
      return result(
        'warn',
        'medium',
        [
          `the test account ${seededEmail} is not confirmed yet (\`email_confirmed_at\` is not set): the auth:confirm-email handoff covers the click in the inbox`,
          'golive cannot read an inbox, so delivery and the click stay human-confirmed',
          ...evidence,
        ],
        'Click the confirmation link in that inbox, then run `plan` + `apply` again (the auth:test-user step re-runs with a fresh password) and re-run verify.',
      );
    }
    evidence.push(`the test account ${seededEmail} is confirmed (email_confirmed_at set)`);

    const seededPass = vaultGet(testUserPassKey(seeded));
    if (!seededPass) {
      return result('skip', 'info', [
        'blocked by: no password for the test account in this run (only the run that seeds or rotates it keeps one, in memory)',
        ...evidence,
      ]);
    }
    let login;
    try {
      login = await auth.login(ctx, seededEmail, seededPass);
    } catch (e) {
      if (e instanceof SupabaseAuthPrereqError) return skip(errMsg(e));
      return result('fail', 'high', [`the password login for the confirmed test account failed: ${errMsg(e)}`, ...evidence], `Check that ${provider} auth is reachable, then re-run verify.`);
    }
    if (!login.session) {
      return result(
        'fail',
        'high',
        [`the confirmed test account ${seededEmail} cannot sign in (${login.code})`, ...evidence],
        'Check the account in the provider dashboard (banned, deleted, password just changed) and that the project\'s password policy accepts the generated password, then re-run `plan` + `apply` and verify.',
      );
    }
    evidence.push(`the confirmed test account signed in (user ${login.session.userId})`);
    evidence.push(`delivery itself stays human-confirmed: golive never sees the inbox, only the provider's own confirmation state`);
    return pass(evidence);
  },
};
