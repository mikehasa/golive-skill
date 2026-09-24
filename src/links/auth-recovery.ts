import type { Link } from '../core/plan.js';
import type { HandoffItem, Step } from '../core/types.js';
import { vaultGet, vaultPut } from '../core/secret.js';
import { testPassword } from '../adapters/supabase-auth.js';
import { TEST_USER_EMAIL, TEST_USER_ID, testUserPassKey } from './auth-e2e.js';
import { axisStatus, deps, errMsg, intentOf, projectAxisFor, projectIntent, step, track } from './util.js';

/**
 * Vault keys for what one recovery rotation leaves in this run's memory only: the token that was used
 * (the check's replay leg) and the password it replaced (the old-password leg). Namespaced like
 * `auth-e2e`'s password key. Nothing here is ever recorded, reported or logged.
 */
export const recoveryTokenKey = (id: string): string => `supabase.authRecoveryToken:${id}`;
export const recoveryOldPassKey = (id: string): string => `supabase.authRecoveryOldPass:${id}`;

/**
 * Password recovery, the journey after signup: the human asks for a new password, the provider emails
 * a link, and the link lets them set one. golive cannot read an inbox, so the step mints its own link
 * through the provider's admin API and walks the same calls the app's recovery page makes — request,
 * verify (token → session), set the new password with that session. The `auth-recovery` check then
 * proves the outcome from the provider: the request was accepted, an unknown address got the same
 * answer, the token is refused on replay, the new password signs in and the old one does not.
 *
 * Opt-in (`auth.recovery: true`) and only on the ONE account golive seeded (`auth:test-user`): a real
 * user's account is never touched. It waits for that account to read back confirmed — a provider sends
 * a confirmation, not a recovery link, to an unconfirmed address — and skips cleanly when nothing is
 * recorded. `live: true` because the account is real; `replayable` because the step re-reads the
 * recorded account and its provider state before acting and its write is a password rotation on that
 * one account.
 */
export const authRecoveryLink: Link = {
  id: 'auth-recovery',
  async plan(ctx) {
    if (ctx.config.auth?.recovery !== true) return null;
    const au = await axisStatus(ctx, 'auth');
    if (au.kind === 'none') return null;
    const title = au.kind === 'guided' ? au.title : au.adapter.title;
    if (au.kind !== 'ready') {
      const why = au.kind === 'guided' ? 'is not automated by golive' : 'is not connected yet';
      return { steps: [], handoffs: [], warnings: [`auth.recovery is on in golive.yaml, but ${title} ${why}: the password-recovery journey stays a manual dashboard task`] };
    }
    const authUsers = au.adapter.capabilities.authUsers;
    if (!authUsers) {
      return { steps: [], handoffs: [], warnings: [`auth.recovery is on in golive.yaml, but ${au.adapter.title} exposes no auth-users surface: the password-recovery journey stays a manual dashboard task`] };
    }
    const mintLink = authUsers.recoveryLink;
    if (!mintLink) {
      return { steps: [], handoffs: [], warnings: [`auth.recovery is on in golive.yaml, but ${au.adapter.title} cannot mint a recovery link through its API: rotating a password would mean reading the inbox, so the password-recovery journey stays a manual dashboard task`] };
    }

    const seeded = ctx.state.resource(TEST_USER_ID);
    if (!seeded) {
      return { steps: [], handoffs: [], warnings: [`auth.recovery is on in golive.yaml, but no test account is recorded yet: the recovery rotation runs on the account \`auth:test-user\` seeds, so apply the plan that seeds it (\`auth.e2e: true\`, \`auth.testEmail\`), then run \`plan\` again`] };
    }
    const address = ctx.state.resource(TEST_USER_EMAIL) ?? ctx.config.auth?.testEmail;
    if (!address) {
      return { steps: [], handoffs: [], warnings: [`auth.recovery is on in golive.yaml, but the address of the test account ${seeded} is not recorded and auth.testEmail is not set: golive has no address to ask for a recovery link`] };
    }
    let known;
    try {
      known = await authUsers.adminUser(ctx, seeded);
    } catch (e) {
      return { steps: [], handoffs: [], warnings: [`auth.recovery is on in golive.yaml, but reading the test account ${seeded} failed (${errMsg(e)}): the password-recovery journey is left out of this plan`] };
    }
    if (!known) {
      return { steps: [], handoffs: [], warnings: [`auth.recovery is on in golive.yaml, but the test account ${seeded} recorded in .golive/state.json is gone from ${au.adapter.title}: restore the user in the provider dashboard, or remove that key from .golive/state.json to seed a new account`] };
    }
    if (!known.emailConfirmed) {
      return { steps: [], handoffs: [], warnings: [`auth.recovery is on in golive.yaml, but ${address} is not confirmed yet: a recovery of an unconfirmed address sends a confirmation, not a recovery link, so the rotation waits. Click the link in that inbox (\`auth:confirm-email\`), then run \`plan\` again`] };
    }

    const axis = projectAxisFor(ctx, au.adapter);
    const dest = await authUsers.destination(ctx).catch(() => null);
    const where = dest ? `${au.adapter.title} project ${dest.ref}` : `the ${au.adapter.title} project`;

    const s = step({
      id: 'auth:recovery',
      title: `Rotate the ${au.adapter.title} test account's password through password recovery`,
      kind: 'provision',
      risk: { writes: true, live: true, replayable: true },
      dependsOn: deps(ctx, [...(axis ? [`project:${axis}`] : []), 'auth:smtp', 'auth:settings', 'auth:test-user']),
      preview: [
        `ask ${au.adapter.title} to send a real password-recovery email for ${address} in ${where}`,
        `mint the recovery link through the admin API and set a new password on ${address} (${seeded}) with it — the same calls the app's own recovery page makes`,
        'the previous and the new password stay in this run\'s memory only; state records the user id and the address, never a secret',
        'the click in that inbox is yours (golive cannot read one), and a captcha on the project would block a scripted request',
      ],
      intent: intentOf({ project: await projectIntent(ctx, au.adapter), user: seeded, email: address, previous: ctx.state.get().steps['auth:recovery']?.at }),
      verifyWith: ['auth-recovery'],
      async run(sctx) {
        const current = sctx.state.resource(TEST_USER_ID);
        const email = sctx.state.resource(TEST_USER_EMAIL) ?? address;
        if (!current) {
          throw new Error('No test account is recorded in .golive/state.json, so there is nothing for the recovery rotation to set a password on. Run `plan` + `apply` with auth.e2e: true first.');
        }
        // Re-read the recorded account and its provider state before touching anything: state can name
        // an account the provider no longer has, and an unconfirmed address gets a confirmation email,
        // not a recovery link.
        const before = await authUsers.adminUser(sctx, current);
        if (!before) {
          throw new Error(`The test account ${current} recorded in .golive/state.json is gone from ${au.adapter.title}. Remove "${TEST_USER_ID}" from .golive/state.json to seed a new account, or restore the user in the provider dashboard.`);
        }
        if (!before.emailConfirmed) {
          throw new Error(`${email} is not confirmed yet, so a recovery link cannot set its password. Click the confirmation link in that inbox (the auth:confirm-email handoff), then re-run \`apply\`.`);
        }

        const asked = await authUsers.requestRecovery(sctx, email);
        if (asked.captchaRequired) {
          throw new Error(
            `${au.adapter.title} wants a captcha for password recovery, so golive cannot request one programmatically. Turn the auth captcha off for this project (provider dashboard, Authentication settings), or accept that this journey stays manual.`,
          );
        }
        if (asked.rateLimited) {
          throw new Error(
            `${au.adapter.title} refused to send more auth emails (HTTP 429 rate limit) for the recovery request of ${email}, so nothing was rotated. Wait for the limit to reset (or configure custom SMTP and raise the auth rate limit), then re-run \`apply\`.`,
          );
        }
        if (!asked.accepted) {
          throw new Error(`The recovery request for ${email} was refused (HTTP ${asked.status}${asked.code ? ` ${asked.code}` : ''}). Check the project's auth settings (\`auth.signup\` and the recovery template) and re-run \`apply\`.`);
        }

        const minted = await mintLink(sctx, email);
        if (!minted) {
          throw new Error(`${au.adapter.title} has no account for ${email}, so no recovery link could be minted for the recorded test account ${current}. Check the address in .golive/state.json and the provider's user list.`);
        }
        if (minted.userId !== current) {
          throw new Error(`The recovery link ${au.adapter.title} minted for ${email} belongs to user ${minted.userId}, not the recorded test account ${current}: stop and inspect the project before rotating anything.`);
        }
        const pass = testPassword();
        const verified = await authUsers.recoverySession(sctx, minted.token);
        if (!verified.session) {
          throw new Error(`The recovery link for ${email} was refused (${verified.code}), so the password was not rotated. Check that the project allows recovery (\`auth.signup: true\`) and re-run \`apply\`.`);
        }
        if (verified.session.userId !== current) {
          throw new Error(`The recovery session belongs to user ${verified.session.userId}, not the recorded test account ${current}: stop and inspect the project before rotating anything.`);
        }
        await authUsers.updateOwnPassword(sctx, verified.session.accessToken, pass);

        // This run's memory only, in the order that matters: what the check needs for its old-password
        // leg, then the new password under the SAME key auth.e2e uses, so auth-signup/auth-session keep
        // working on the account in this run.
        const replaced = vaultGet(testUserPassKey(current));
        if (replaced) vaultPut(recoveryOldPassKey(current), replaced);
        vaultPut(testUserPassKey(current), pass);
        vaultPut(recoveryTokenKey(current), minted.token);

        const changes = [
          `asked ${au.adapter.title} to send a recovery email for ${email} (HTTP ${asked.status})`,
          `set a new password on the same account through the recovery link (user ${minted.userId}); fp:${pass.fingerprint}, kept in this run's memory only`,
        ];
        changes.push(
          replaced
            ? `the replaced password is refused from now on (fp:${replaced.fingerprint}); the auth-recovery check re-proves that against the provider`
            : 'this run held no previous password for the account (auth:test-user did not run in it), so the replaced password is not in this run\'s memory',
        );
        const after = await authUsers.adminUser(sctx, current);
        if (after) changes.push(`${email} still reads back confirmed (email_confirmed_at set)`);
        return { changes };
      },
    });

    // The text is built here, when the plan is: it is read after a run that rotated the password AND
    // after one whose auth:recovery step failed or never ran, so it may claim neither outcome.
    const handoff: HandoffItem = {
      id: 'auth:recovery-email',
      why: `${au.adapter.title} sends the recovery link for ${address} to that inbox, and golive cannot read an inbox: only the account owner can click it. A captcha on the project blocks a scripted request before a link even exists.`,
      action: `Open the recovery email for ${address} (check the spam folder; the built-in mailer is rate-limited) and click the link, then set a password on the page it opens: that click is the one leg golive cannot make for you, and it is how you confirm the same link works for a human. Whether that account's password has been rotated through the recovery path yet depends on the run — if the \`auth:recovery\` step is recorded as done, it has been, and the \`auth-recovery\` check proves it; if that step failed or never ran, nothing was rotated, so fix the error that run reported and re-run \`plan\` + \`apply\`.`,
      blocking: false,
      verifiedBy: 'auth-recovery',
    };
    return { steps: track(ctx, [s] as Step[]), handoffs: [handoff], warnings: [] };
  },
};
