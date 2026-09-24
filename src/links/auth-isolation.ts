import type { Link } from '../core/plan.js';
import type { HandoffItem, Step, StepResult } from '../core/types.js';
import { vaultPut } from '../core/secret.js';
import { testPassword } from '../adapters/supabase-auth.js';
import { TEST_USER_EMAIL, TEST_USER_ID, testUserPassKey } from './auth-e2e.js';
import { axisStatus, deps, errMsg, intentOf, memo, projectAxisFor, projectIntent, step, track } from './util.js';

/**
 * State keys for the SECOND test account: the one account-isolation runs need beside the account
 * `auth:test-user` seeds. Same discipline as its sibling — the address is the human's own (plus-tagged)
 * and the password is generated per run into `testUserPassKey`, which is keyed by user id, so one key
 * function covers both accounts and no parallel password mechanism exists. Only ids and addresses are
 * ever recorded.
 */
export const ISOLATION_USER_ID = 'supabase.isolationUserId';
export const ISOLATION_USER_EMAIL = 'supabase.isolationUserEmail';

/**
 * The second account's address, derived from `auth.testEmail` so a later run finds the SAME account
 * again: `you+gl-isolation@example.com` — the same inbox, a distinct account golive owns. null when
 * the configured address has no shape to plus-tag.
 */
export function secondAddress(email: string): string | null {
  const m = /^([^@+]+)(?:\+[^@]*)?@([^@\s]+)$/.exec(email);
  return m ? `${m[1]}+gl-isolation@${m[2]}` : null;
}

/**
 * The second half of the authentication journey: with TWO real accounts, the `auth-isolation` check
 * can ask whether one signed-in account can read the other's data through the app — the one thing a
 * single account can never show. The step seeds (or rotates) that second account through the provider's
 * own signup, then confirms it through the provider's admin API and reads it back: a second inbox click
 * would spend the throttled mail budget on a journey whose subject is the app's data, not delivery.
 *
 * Opt-in (`auth.isolation: true`) and only ever about accounts golive created and recorded: the first
 * account is the one `auth:test-user` seeds, the second is this step's own, and nothing else is touched.
 * `live: true` because both are real accounts in a production project; `replayable` because the step
 * re-reads its recorded account and the provider's state before acting and its only writes are a
 * password rotation, an idempotent email confirmation and a signup the provider de-duplicates by
 * address, so a failed attempt from an older release may run.
 */
export const authIsolationLink: Link = {
  id: 'auth-isolation',
  async plan(ctx) {
    if (ctx.config.auth?.isolation !== true) return null;
    const au = await axisStatus(ctx, 'auth');
    if (au.kind === 'none') return null;
    const title = au.kind === 'guided' ? au.title : au.adapter.title;
    if (au.kind !== 'ready') {
      const why = au.kind === 'guided' ? 'is not automated by golive' : 'is not connected yet';
      return { steps: [], handoffs: [], warnings: [`auth.isolation is on in golive.yaml, but ${title} ${why}: two signed-in accounts cannot be proven apart, so account isolation stays a manual app test`] };
    }
    const authUsers = au.adapter.capabilities.authUsers;
    if (!authUsers) {
      return { steps: [], handoffs: [], warnings: [`auth.isolation is on in golive.yaml, but ${au.adapter.title} exposes no auth-users surface: account isolation stays a manual app test`] };
    }
    const confirmEmail = authUsers.confirmEmail;
    if (!confirmEmail) {
      return { steps: [], handoffs: [], warnings: [`auth.isolation is on in golive.yaml, but ${au.adapter.title} cannot confirm an account through its API, so the second test account would never sign in: account isolation stays a manual app test`] };
    }

    const email = ctx.config.auth.testEmail;
    if (ctx.config.auth.e2e !== true || !email) {
      return { steps: [], handoffs: [], warnings: [`auth.isolation is on in golive.yaml, but the FIRST account comes from \`auth.e2e: true\` with \`auth.testEmail\`, and the isolation check signs in as both accounts: turn that opt-in on (or back on), then run \`plan\` again`] };
    }
    const address = secondAddress(email);
    if (!address) {
      return { steps: [], handoffs: [], warnings: [`auth.isolation is on in golive.yaml, but auth.testEmail (${email}) is not an address golive can plus-tag for the second account: set an address like "you@example.com" or "you+go-live@example.com"`] };
    }
    const first = ctx.state.resource(TEST_USER_ID);
    if (!first && !memo(ctx).planned.has('auth:test-user')) {
      return { steps: [], handoffs: [], warnings: [`auth.isolation is on in golive.yaml, but no first test account is recorded yet and this plan does not seed one: the isolation check signs in as two accounts, so apply the plan that seeds the first one (\`auth.e2e: true\`, \`auth.testEmail\`), then run \`plan\` again`] };
    }
    if (first) {
      // Recorded already: the plan only has something to do if that account still holds up. A plan
      // that seeds it in this run is checked by its own seeds instead.
      let firstUser;
      try {
        firstUser = await authUsers.adminUser(ctx, first);
      } catch (e) {
        return { steps: [], handoffs: [], warnings: [`auth.isolation is on in golive.yaml, but reading the test account ${first} failed (${errMsg(e)}): account isolation is left out of this plan`] };
      }
      if (!firstUser) {
        return { steps: [], handoffs: [], warnings: [`auth.isolation is on in golive.yaml, but the test account ${first} recorded in .golive/state.json is gone from ${title}: restore the user in the provider dashboard, or remove that key from .golive/state.json to seed a new account`] };
      }
      if (!firstUser.emailConfirmed) {
        return { steps: [], handoffs: [], warnings: [`auth.isolation is on in golive.yaml, but ${ctx.state.resource(TEST_USER_EMAIL) ?? email} is not confirmed yet: the isolation check signs in as both accounts, so click the confirmation link in that inbox (\`auth:confirm-email\`), then run \`plan\` again`] };
      }
    }

    const axis = projectAxisFor(ctx, au.adapter);
    const dest = await authUsers.destination(ctx).catch(() => null);
    const where = dest ? `${au.adapter.title} project ${dest.ref}` : `the ${au.adapter.title} project`;
    const seeded = ctx.state.resource(ISOLATION_USER_ID);
    const identityPath = ctx.config.auth.identityPath;
    const isolationPath = ctx.config.auth.isolationPath;

    const s = step({
      id: 'auth:isolation',
      title: `Seed a second ${au.adapter.title} test account for the account-isolation check`,
      kind: 'provision',
      risk: { writes: true, live: true, replayable: true },
      dependsOn: deps(ctx, [...(axis ? [`project:${axis}`] : []), 'auth:settings', 'auth:test-user']),
      preview: [
        seeded
          ? `set a new password on the second test account ${address} golive seeded earlier (${seeded}) in ${where}`
          : `create a second test account ${address} in ${where}`,
        `confirm that account through ${au.adapter.title}'s admin API and read it back: the isolation check needs two signed-in accounts, and a click in the inbox is not one of its legs (the confirmation email it also receives is a side effect)`,
        'the generated password stays in this run\'s memory only; state records the user id and the address, never a secret',
        identityPath && isolationPath
          ? `the auth-isolation check then reads ${identityPath} and ${isolationPath} with each account's session on the deployed app`
          : `no app route is declared yet (auth.identityPath / auth.isolationPath), so the isolation check has nothing to read: see the auth:isolation-routes handoff`,
      ],
      intent: intentOf({ project: await projectIntent(ctx, au.adapter), user: seeded ?? 'new', email: address, previous: ctx.state.get().steps['auth:isolation']?.at }),
      verifyWith: ['auth-isolation'],
      async run(sctx): Promise<StepResult> {
        const pass = testPassword();
        const target = sctx.state.resource(ISOLATION_USER_EMAIL) ?? address;
        const recorded = sctx.state.resource(ISOLATION_USER_ID);

        /** Confirm the account through the provider's admin API and read the result back. */
        const confirmAndRead = async (id: string): Promise<string[]> => {
          const before = await authUsers.adminUser(sctx, id);
          if (before?.emailConfirmed) return [`${target} is confirmed (email_confirmed_at set)`];
          await confirmEmail(sctx, id);
          const after = await authUsers.adminUser(sctx, id);
          if (!after?.emailConfirmed) {
            throw new Error(`${au.adapter.title} accepted the confirmation of ${target} (${id}) but still reports that account unconfirmed. Confirm the user in the provider dashboard, then re-run \`apply\`.`);
          }
          return [`confirmed ${target} through ${au.adapter.title}'s admin API and read it back (email_confirmed_at set): the isolation check has a second signed-in account without an inbox click`];
        };

        if (recorded) {
          const known = await authUsers.adminUser(sctx, recorded);
          if (!known) {
            throw new Error(
              `The second test account ${recorded} recorded in .golive/state.json is gone from ${au.adapter.title}. Remove "${ISOLATION_USER_ID}" from .golive/state.json to seed a new account, or restore the user in the provider dashboard.`,
            );
          }
          await authUsers.setPassword(sctx, recorded, pass);
          vaultPut(testUserPassKey(recorded), pass);
          const lines = [
            `set a new password on the existing second test account ${target} (${recorded}); fp:${pass.fingerprint}, kept in this run's memory only`,
            ...(await confirmAndRead(recorded)),
          ];
          return { changes: lines };
        }

        const res = await authUsers.signup(sctx, target, pass);
        if (res.captchaRequired) {
          throw new Error(
            `${au.adapter.title} wants a captcha for signup, so golive cannot create the second test account. Turn the auth captcha off for this project (provider dashboard, Authentication settings), or accept that account isolation stays manual.`,
          );
        }
        if (res.rateLimited) {
          throw new Error(
            `${au.adapter.title} refused to send more auth emails (HTTP 429) while signing up ${target}, so the second test account was not seeded. Wait for the limit to reset (or configure custom SMTP and raise the auth rate limit), then re-run \`apply\`; check the provider's user list for ${target} if you are unsure whether the account was created.`,
          );
        }
        if (!res.userId) {
          throw new Error(`Signing up ${target} returned no user id (HTTP ${res.status}). Check the provider's user list before re-running; golive keeps no account it cannot name.`);
        }
        sctx.remember(ISOLATION_USER_ID, res.userId);
        sctx.remember(ISOLATION_USER_EMAIL, target);
        vaultPut(testUserPassKey(res.userId), pass);
        const lines = [`created the second test account ${target} (${res.userId})`, `password fp:${pass.fingerprint} (this run's memory only, never written anywhere)`];
        if (res.existing) {
          // The address already had an account (an earlier run's, or one the human made), so the
          // provider sent nothing and did not set this run's password: golive adopts that account and
          // puts the password it holds on it, or the check could not sign in as it.
          await authUsers.setPassword(sctx, res.userId, pass);
          lines.push(`${target} already had an account, so no new confirmation email was sent: golive adopted it as the second test account and set the generated password on it`);
        } else if (!res.confirmationSent) {
          lines.push(`${au.adapter.title} confirmed the account without sending anything: email confirmation is not required by this project (see the auth-policy check)`);
        } else {
          lines.push(`a confirmation email for ${target} was sent to the same inbox as the first account; golive confirms this account through the admin API too, so no click is needed for it`);
        }
        lines.push(...(await confirmAndRead(res.userId)));
        return { changes: lines };
      },
    });

    const handoff: HandoffItem = {
      id: 'auth:isolation-routes',
      why: `${title} only holds the accounts; whether one of them can read the other's data is a question about YOUR app, and only your coding agent (or you) can add or change its routes.`,
      action: `Expose two routes on the deployed app and name them in golive.yaml. \`auth.identityPath\` (e.g. "/api/me"): a GET from a signed-in caller answers with that caller's OWN user id as JSON, and without a session it answers 401/403 or redirects. \`auth.isolationPath\` (e.g. "/api/notes"): a GET returns ONLY rows belonging to the signed-in caller, a POST with body {"marker": "…"} stores one row for that caller, and both answer 401/403 or a redirect without a session. Then run \`plan\` + \`apply\` (the auth:isolation step) and \`verify\`.`,
      blocking: false,
      verifiedBy: 'auth-isolation',
    };
    const needsRoutes = !identityPath || !isolationPath;
    return { steps: track(ctx, [s] as Step[]), handoffs: needsRoutes ? [handoff] : [], warnings: [] };
  },
};
