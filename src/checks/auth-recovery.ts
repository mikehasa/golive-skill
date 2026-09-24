import { randomBytes } from 'node:crypto';
import type { Check } from '../core/types.js';
import { vaultGet } from '../core/secret.js';
import { SupabaseAuthPrereqError } from '../adapters/supabase-auth.js';
import { TEST_USER_EMAIL, TEST_USER_ID, testUserPassKey } from '../links/auth-e2e.js';
import { recoveryOldPassKey, recoveryTokenKey } from '../links/auth-recovery.js';
import { adapterFor, blocked, cap, errMsg, pass, prereq, result, skip } from './util.js';

/** `you+gl-recovery-ab12cd@example.com`: structurally valid, in the human's own domain, no account. */
function unknownAddress(email: string): string | null {
  const m = /^([^@+]+)(?:\+[^@]*)?@([^@\s]+)$/.exec(email);
  return m ? `${m[1]}+gl-recovery-${randomBytes(3).toString('hex')}@${m[2]}` : null;
}
/**
 * The password-recovery journey, in the four things that make it evidence: the provider takes the
 * request and sends the mail; an address it has no account for gets the SAME answer (a different one
 * would let anyone ask "does this address have an account here?"); the recovery token this run used is
 * refused when it is presented again; and the password it set signs in while the one it replaced does
 * not. The first two are provider reads; the last two need what the `auth:recovery` step kept in this
 * run's memory (never in state), so a `verify` outside that run skips instead of passing on less.
 *
 * Opt-in only (`auth.recovery: true`), and only ever about the ONE account golive seeded: it sends real
 * recovery emails and spends the provider's mail throttle, which is why a 429 warns and never fails.
 */
export const authRecoveryCheck: Check = {
  id: 'auth-recovery',
  title: 'Password recovery answers an unknown address the same way, spends its token once and replaces the old password',
  severity: 'high',
  applies: (ctx) => Boolean(ctx.config.stack.auth),
  async run(ctx) {
    if (ctx.config.auth?.recovery !== true) {
      return skip('auth.recovery is not enabled in golive.yaml: this check asks the provider to send recovery emails and replays a recovery token, so it only runs on explicit opt-in');
    }
    const provider = ctx.config.stack.auth!;
    const title = adapterFor(ctx, 'auth')?.title ?? provider;
    const auth = cap(ctx, 'auth', 'authUsers');
    if (!auth) return skip(`auth provider ${provider} has no auth-users surface (guided): the password-recovery journey stays a manual dashboard task`);
    const pre = await prereq(ctx, 'auth');
    if (pre) return pre;
    const seeded = ctx.state.resource(TEST_USER_ID);
    if (!seeded) return blocked('auth:test-user', 'no test account has been seeded yet');
    const address = ctx.state.resource(TEST_USER_EMAIL) ?? ctx.config.auth?.testEmail;
    if (!address) return skip('the address of the recorded test account is not known, so golive has nothing to ask the provider for a recovery link');

    // What the auth:recovery step left in this run's memory: the token it spent and the two passwords
    // it rotated between. Without them the last two legs cannot be proven, and sending the recovery
    // emails anyway would spend the provider's throttled mail budget on a run that skips regardless.
    const token = vaultGet(recoveryTokenKey(seeded));
    const newPass = vaultGet(testUserPassKey(seeded));
    const oldPass = vaultGet(recoveryOldPassKey(seeded));
    if (!token || !newPass || !oldPass) {
      const missing = [token ? '' : 'the recovery token it used', newPass ? '' : 'the password it set through recovery', oldPass ? '' : 'the password that password replaced'].filter(Boolean);
      return skip(
        `this run holds none of what the recovery check needs for the test account ${address}: ${missing.join('; ')}. Only the run that carries the auth:recovery step keeps them, in memory, and that step waits for a confirmed account: run \`plan\` + \`apply\` with auth.recovery: true, then re-run verify`,
      );
    }

    const evidence: string[] = [];

    // 1. The request the human's own "forgot password" click makes, for the recorded account.
    let asked;
    try {
      asked = await auth.requestRecovery(ctx, address);
    } catch (e) {
      if (e instanceof SupabaseAuthPrereqError) return skip(errMsg(e));
      return result('fail', 'high', [`the recovery request for ${address} failed: ${errMsg(e)}`, ...evidence], `Check that ${provider} auth is reachable, then re-run verify.`);
    }
    if (asked.captchaRequired) {
      return skip(`${title} requires a captcha for password recovery, so a scripted request cannot run (golive will not claim a pass it cannot evidence)`);
    }
    if (asked.rateLimited) {
      return result('warn', 'medium', [`the recovery request for ${address} was rate-limited (HTTP 429)`, ...evidence], `Wait for ${title}'s auth email limit to reset (or configure custom SMTP and raise the auth rate limit), then re-run verify. The provider's mail throttle decides what a run can prove.`);
    }
    if (!asked.accepted) {
      return result(
        'fail',
        'high',
        [`the recovery request for ${address} was refused (HTTP ${asked.status}${asked.code ? ` ${asked.code}` : ''})`, ...evidence],
        `Make sure the project allows recovery (\`auth.signup: true\`, \`plan\` + \`apply\` for the auth:settings step) and re-run verify.`,
      );
    }
    evidence.push(`the recovery request for ${address} was accepted for sending (HTTP ${asked.status})`);

    // 2. The same request for an address with no account must be answered the same way.
    const unknownAddr = unknownAddress(address);
    let unknown = null;
    if (!unknownAddr) {
      evidence.push(`the test address ${address} is not a plus-addressable one, so golive could not form an address with no account to compare the answer against`);
    } else {
      try {
        unknown = await auth.requestRecovery(ctx, unknownAddr);
      } catch (e) {
        if (e instanceof SupabaseAuthPrereqError) return skip(errMsg(e));
        return result('fail', 'high', [`the recovery request for an address with no account failed: ${errMsg(e)}`, ...evidence], `Check that ${provider} auth is reachable, then re-run verify.`);
      }
      if (unknown.rateLimited) {
        return result(
          'warn',
          'medium',
          [
            `the recovery request for an address with no account was rate-limited (HTTP 429), so whether it is answered like a known one is not established in this run`,
            ...evidence,
          ],
          `Wait for ${title}'s auth email limit to reset, then re-run verify: the comparison needs one accepted request per address.`,
        );
      }
      if (unknown.status !== asked.status || unknown.accepted !== asked.accepted) {
        return result(
          'fail',
          'high',
          [
            `an address with no account got HTTP ${unknown.status} (accepted: ${unknown.accepted}) where the recorded account ${address} got HTTP ${asked.status} (accepted: ${asked.accepted}): the endpoint tells the difference`,
            'that answers "does this address have an account here?" for anyone who asks: account enumeration',
            ...evidence,
          ],
          'Answer an unknown address exactly like a known one. A proxy, WAF, edge function or cached response in front of the recovery endpoint is the usual cause; the provider itself does not distinguish.',
        );
      }
      evidence.push(`an address with no account (${unknownAddr}) got the same answer (HTTP ${unknown.status}): no account enumeration`);
    }

    // 3. The token this run spent must not resolve a second time.
    let replay;
    try {
      replay = await auth.recoverySession(ctx, token);
    } catch (e) {
      if (e instanceof SupabaseAuthPrereqError) return skip(errMsg(e));
      return result('fail', 'high', [`replaying the recovery token failed: ${errMsg(e)}`, ...evidence], `Check that ${provider} auth is reachable, then re-run verify.`);
    }
    if (replay.session) {
      return result(
        'fail',
        'high',
        [`the recovery token that already set a password was accepted again (a session for user ${replay.session.userId})`, ...evidence],
        'A recovery token must resolve once: a replayed or leaked link would otherwise take the account over. Check what answers the verification endpoint (a proxy, cache or custom function is the usual cause), then re-run verify.',
      );
    }
    evidence.push(`the recovery token this run used is refused on replay (HTTP ${replay.status}${replay.code ? ` ${replay.code}` : ''})`);

    // 4. The new password works and the one it replaced does not.
    let fresh;
    try {
      fresh = await auth.login(ctx, address, newPass);
    } catch (e) {
      if (e instanceof SupabaseAuthPrereqError) return skip(errMsg(e));
      return result('fail', 'high', [`signing in with the password set through recovery failed: ${errMsg(e)}`, ...evidence], `Check that ${provider} auth is reachable, then re-run verify.`);
    }
    if (fresh.rateLimited) return result('warn', 'medium', [`the password login for ${address} was rate-limited (HTTP 429)`, ...evidence], 'Wait for the rate limit to reset, then re-run verify.');
    if (!fresh.session) {
      return result(
        'fail',
        'high',
        [`the password the recovery path set cannot sign in (${fresh.code})`, ...evidence],
        `Check the account in the ${title} dashboard and the project's password policy, then run \`plan\` + \`apply\` again (a fresh rotation) and re-run verify.`,
      );
    }
    evidence.push(`the password set through the recovery path signs in (user ${fresh.session.userId})`);

    let stale;
    try {
      stale = await auth.login(ctx, address, oldPass);
    } catch (e) {
      if (e instanceof SupabaseAuthPrereqError) return skip(errMsg(e));
      return result('fail', 'high', [`signing in with the replaced password failed: ${errMsg(e)}`, ...evidence], `Check that ${provider} auth is reachable, then re-run verify.`);
    }
    if (stale.rateLimited) return result('warn', 'medium', [`the login with the replaced password was rate-limited (HTTP 429)`, ...evidence], 'Wait for the rate limit to reset, then re-run verify.');
    if (stale.session) {
      return result(
        'fail',
        'high',
        [`the password the recovery rotation replaced still signs in`, ...evidence],
        'The rotation did not take effect for the old password. Change the account\'s password in the provider dashboard, then run `plan` + `apply` again (a fresh rotation) and re-run verify.',
      );
    }
    evidence.push(`the password the rotation replaced is refused (${stale.code})`);

    // 5. Name how long such a token stays usable, when the provider reports it. Never an assertion:
    //    a provider that does not report the window is not a failure.
    const settings = cap(ctx, 'auth', 'authConfig');
    if (!settings) {
      evidence.push(`auth provider ${provider} reports no auth settings, so the recovery token's expiry window is not named`);
    } else {
      try {
        const conf = await settings.get(ctx);
        evidence.push(
          conf.otpExpirySeconds === undefined
            ? "the provider does not report the recovery link/code window, so golive names no lifetime for it"
            : `the provider's one-time link/code window is ${conf.otpExpirySeconds}s (otpExpirySeconds), which bounds how long a recovery link stays usable`,
        );
      } catch (e) {
        evidence.push(`could not read the provider's auth settings, so the recovery token's expiry window is not named: ${errMsg(e)}`);
      }
    }

    evidence.push('the click in the inbox itself stays human-confirmed: golive never sees the inbox, only the provider\'s own token and password state');
    return pass(evidence);
  },
};
