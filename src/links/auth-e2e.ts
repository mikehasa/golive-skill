import type { Link } from '../core/plan.js';
import type { HandoffItem, Step } from '../core/types.js';
import { vaultPut } from '../core/secret.js';
import { testPassword } from '../adapters/supabase-auth.js';
import { axisStatus, deps, intentOf, projectAxisFor, projectIntent, step, track } from './util.js';

/**
 * State keys for the one test account golive seeds. The address is the human's own (plus-addressing
 * allowed), so the confirmation email lands in an inbox they control; the password is generated per
 * run and lives only in the run vault, never in state, a report or evidence.
 */
export const TEST_USER_ID = 'supabase.testUserId';
export const TEST_USER_EMAIL = 'supabase.testUserEmail';
export const testUserPassKey = (id: string): string => `supabase.authTestPass:${id}`;

/**
 * The signup journey the human opted into with `auth.e2e: true`: ONE test account, seeded through the
 * provider's own signup, so the confirmation email goes to a real inbox. The click in that inbox is
 * the only leg golive cannot perform; `auth:confirm-email` hands it over, and the `auth-signup` /
 * `auth-session` checks prove the rest. The step carries `live: true` because it writes a real user
 * into a production project.
 *
 * Its intent carries the previous attempt time, so a fresh plan re-runs the step: that is how a later
 * run gets a known password again (a rotation on the account golive seeded) and can prove login after
 * the human confirmed the address. `replayable` declares that write safe to resume under a newer
 * release: it re-reads the account state records before touching it, and its only other write is a
 * signup the provider de-duplicates by address, so a failed attempt from an older release may run.
 */
export const authE2eLink: Link = {
  id: 'auth-e2e',
  async plan(ctx) {
    if (ctx.config.auth?.e2e !== true) return null;
    const email = ctx.config.auth.testEmail;
    const au = await axisStatus(ctx, 'auth');
    if (au.kind === 'none') return null;
    const title = au.kind === 'guided' ? au.title : au.adapter.title;
    if (au.kind !== 'ready') {
      const why = au.kind === 'guided' ? 'is not automated by golive' : 'is not connected yet';
      return { steps: [], handoffs: [], warnings: [`auth.e2e is on in golive.yaml, but ${title} ${why}: the signup journey stays a manual dashboard task`] };
    }
    const authUsers = au.adapter.capabilities.authUsers;
    if (!authUsers) {
      return { steps: [], handoffs: [], warnings: [`auth.e2e is on in golive.yaml, but ${au.adapter.title} exposes no auth-users surface: the signup journey stays a manual dashboard task`] };
    }
    if (!email) {
      return { steps: [], handoffs: [], warnings: ['auth.e2e is on in golive.yaml but auth.testEmail is not set: golive has no inbox to send the test account\'s confirmation to, so no test account is seeded'] };
    }

    const axis = projectAxisFor(ctx, au.adapter);
    const dest = await authUsers.destination(ctx).catch(() => null);
    const seeded = ctx.state.resource(TEST_USER_ID);
    const where = dest ? `${au.adapter.title} project ${dest.ref}` : `the ${au.adapter.title} project`;

    const s = step({
      id: 'auth:test-user',
      title: `Seed one ${au.adapter.title} test account for the signup journey`,
      kind: 'provision',
      risk: { writes: true, live: true, replayable: true },
      dependsOn: deps(ctx, [...(axis ? [`project:${axis}`] : []), 'auth:smtp', 'auth:settings']),
      preview: [
        seeded
          ? `set a new password on the test account ${email} golive seeded earlier (${seeded}) in ${where}`
          : `create one test account ${email} in ${where}`,
        'the generated password stays in this run\'s memory only; state records the user id and the address, never a secret',
        'the account is real and lives in the project until you delete it (the provider dashboard lists it)',
        `a confirmation email goes to ${email}; golive cannot read an inbox, so clicking that link is yours`,
      ],
      intent: intentOf({ project: await projectIntent(ctx, au.adapter), user: seeded ?? 'new', email, previous: ctx.state.get().steps['auth:test-user']?.at }),
      verifyWith: ['auth-signup', 'auth-session'],
      async run(sctx) {
        const pass = testPassword();
        const address = sctx.state.resource(TEST_USER_EMAIL) ?? email;
        const recorded = sctx.state.resource(TEST_USER_ID);
        if (recorded) {
          const known = await authUsers.adminUser(sctx, recorded);
          if (!known) {
            throw new Error(
              `The test account ${recorded} recorded in .golive/state.json is gone from ${au.adapter.title}. Remove "${TEST_USER_ID}" from .golive/state.json to seed a new account, or restore the user in the provider dashboard.`,
            );
          }
          await authUsers.setPassword(sctx, recorded, pass);
          vaultPut(testUserPassKey(recorded), pass);
          const after = await authUsers.adminUser(sctx, recorded);
          return {
            changes: [
              `set a new password on the existing test account ${address} (${recorded}); fp:${pass.fingerprint}, kept in this run's memory only`,
              after?.emailConfirmed
                ? `${address} is confirmed (email_confirmed_at set)`
                : `${address} is not confirmed yet: click the link in the inbox, then run \`plan\` + \`apply\` again`,
            ],
          };
        }

        const res = await authUsers.signup(sctx, address, pass);
        if (res.captchaRequired) {
          throw new Error(
            `${au.adapter.title} wants a captcha for signup, so golive cannot create the test account programmatically. Turn the auth captcha off for this project (provider dashboard, Authentication settings), or accept that this journey stays manual.`,
          );
        }
        if (res.rateLimited) {
          throw new Error(
            `${au.adapter.title} refused to send more auth emails (HTTP 429 rate limit) while signing up ${address}, so the test account was not seeded. Wait for the limit to reset (or configure custom SMTP and raise the auth rate limit), then re-run \`apply\`; check the provider's user list for ${address} if you are unsure whether the account was created.`,
          );
        }
        if (!res.userId) {
          throw new Error(`Signing up ${address} returned no user id (HTTP ${res.status}). Check the provider's user list before re-running; golive keeps no account it cannot name.`);
        }
        sctx.remember(TEST_USER_ID, res.userId);
        sctx.remember(TEST_USER_EMAIL, address);
        vaultPut(testUserPassKey(res.userId), pass);
        const after = await authUsers.adminUser(sctx, res.userId);
        const lines = [`created the test account ${address} (${res.userId})`, `password fp:${pass.fingerprint} (this run's memory only, never written anywhere)`];
        if (!res.confirmationSent) {
          // The account exists, but this project did not ask for a confirmation email (or an account
          // for this address already existed). Both are findings for the checks, not step failures.
          lines.push(
            res.existing
              ? `${address} already had an account, so no new confirmation email was sent: golive adopted it as the test account`
              : `${au.adapter.title} confirmed the account without sending anything: email confirmation is not required by this project (see the auth-policy check)`,
          );
        } else {
          lines.push(`confirmation email sent to ${address}; click the link, then run \`plan\` + \`apply\` again to prove the confirmed account can sign in`);
        }
        if (after?.emailConfirmed) lines.push(`${address} is already confirmed (email_confirmed_at set)`);
        return { changes: lines };
      },
    });

    const handoff: HandoffItem = {
      id: 'auth:confirm-email',
      why: `${au.adapter.title} sends the confirmation link for ${email} to that inbox, and golive cannot read an inbox: only the account owner can confirm the address.`,
      action: `Open the confirmation email for ${email} (check the spam folder; the built-in mailer is rate-limited) and click the link. Then run \`plan\` + \`apply\` again: the auth:test-user step re-runs with a fresh password for the same account, and the auth-signup/auth-session checks prove the confirmed account can sign in.`,
      blocking: false,
      verifiedBy: 'auth-signup',
    };
    return { steps: track(ctx, [s] as Step[]), handoffs: [handoff], warnings: [] };
  },
};
