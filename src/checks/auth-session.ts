import type { Check, Ctx, TableInfo, Value } from '../core/types.js';
import type { Secret } from '../core/secret.js';
import { vaultGet } from '../core/secret.js';
import { SupabaseAuthPrereqError } from '../adapters/supabase-auth.js';
import { TEST_USER_EMAIL, TEST_USER_ID, testUserPassKey } from '../links/auth-e2e.js';
import { authedRestProbe } from './providers.js';
import { INTERNAL_SCHEMAS } from './rls.js';
import { adapterFor, blocked, cap, confirmedProductionUrl, errMsg, prereq, probe, result, skip, trimSlash, type CheckOutcome } from './util.js';

/** How many exposed tables the signed-in probe reads: enough to notice a table-wide denial. */
const MAX_TABLES = 10;
/** How many table names the evidence prints per verdict before it says how many more there were. */
const MAX_NAMED = 4;

/** What one table probe showed: the summary counts these, the evidence names them. */
type Verdict = 'reachable' | 'denied' | 'undecided';

interface Issue {
  severity: CheckOutcome['severity'];
  line: string;
  fix?: string;
}

/**
 * The session half of the authentication journey: the seeded account signs in with its password, the
 * session token is accepted by `GET /auth/v1/user` for the SAME user, the same endpoint refuses an
 * anonymous request, and — when `auth.protectedPath` names an app route — that route is not publicly
 * readable, corroborated against the public root so an edge wall cannot pass for the app's refusal.
 * The protected-path leg is an active probe of the host-confirmed production URL only, reading at
 * most two URLs: the declared path, and the root that must stay public.
 *
 * The table probe uses the signed-in token, not anonymity (`rls-probe` owns that): it notices an
 * `authenticated` role that cannot reach any exposed table, which is a missing GRANT, not a leak.
 * Opt-in only (`auth.e2e: true`); the password exists only in the run that seeded or rotated it.
 */
export const authSessionCheck: Check = {
  id: 'auth-session',
  title: 'A confirmed test account signs in and its session is accepted',
  severity: 'high',
  applies: (ctx) => Boolean(ctx.config.stack.auth),
  async run(ctx) {
    if (ctx.config.auth?.e2e !== true) {
      return skip('auth.e2e is not enabled in golive.yaml: this check signs in as a real account, so it only runs on explicit opt-in');
    }
    const provider = ctx.config.stack.auth!;
    const title = adapterFor(ctx, 'auth')?.title ?? provider;
    const auth = cap(ctx, 'auth', 'authUsers');
    if (!auth) return skip(`auth provider ${provider} has no auth-users surface (guided): the signup journey stays a manual dashboard task`);
    const pre = await prereq(ctx, 'auth');
    if (pre) return pre;
    const seeded = ctx.state.resource(TEST_USER_ID);
    if (!seeded) return blocked('auth:test-user', 'no test account has been seeded yet');
    const password = vaultGet(testUserPassKey(seeded));
    if (!password) {
      return skip('blocked by: no password for the test account in this run (only the run that seeds or rotates it keeps one, in memory); re-run `plan` + `apply` to rotate it and prove login');
    }
    const dest = await auth.destination(ctx);
    if (!dest) return blocked('project:db', 'no Supabase project is selected for this app');
    const address = ctx.state.resource(TEST_USER_EMAIL) ?? ctx.config.auth?.testEmail;
    if (!address) return skip('the test account\'s address is not recorded, so golive cannot sign in as it');

    let outcome;
    try {
      outcome = await auth.login(ctx, address, password);
    } catch (e) {
      if (e instanceof SupabaseAuthPrereqError) return skip(errMsg(e));
      return result('fail', 'high', [`signing in as the test account ${address} failed: ${errMsg(e)}`], `Check that ${provider} auth is reachable, then re-run verify.`);
    }
    if (!outcome.session) {
      if (outcome.rateLimited) return result('warn', 'medium', [`the password login for ${address} was rate-limited (HTTP 429)`], 'Wait for the rate limit to reset, then re-run verify.');
      if ((outcome.code ?? '').includes('email_not_confirmed')) {
        return result(
          'warn',
          'medium',
          [`the test account ${address} is not confirmed yet, so there is no session to check: the auth:confirm-email handoff covers the click in the inbox`],
          'Click the confirmation link in that inbox, then run `plan` + `apply` again (the auth:test-user step rotates the password in that run) and re-run verify.',
        );
      }
      return result('fail', 'high', [`the test account ${address} cannot sign in (${outcome.code})`], `Check the account in the ${title} dashboard (confirmed, not banned, password policy) and that auth.testEmail is still that address, then re-run \`plan\` + \`apply\`.`);
    }
    const session = outcome.session;
    const evidence = [`signed in as ${address} (user ${session.userId}, email_confirmed_at set)`];
    const issues: Issue[] = [];

    // The token must be accepted, for this exact user.
    let view;
    try {
      view = await auth.user(ctx, session.accessToken);
    } catch (e) {
      if (e instanceof SupabaseAuthPrereqError) return skip(errMsg(e));
      return result('fail', 'high', [`could not read the signed-in user: ${errMsg(e)}`, ...evidence], `Check that ${provider} auth is reachable, then re-run verify.`);
    }
    if (view.status === 401 || view.status === 403) {
      return result('fail', 'high', [`the session token was rejected (GET /auth/v1/user → HTTP ${view.status})`, ...evidence], 'The project rejected a token it just issued: check the project\'s JWT settings and auth logs, then re-run verify.');
    }
    if (view.status !== 200 || !view.id) {
      return result('fail', 'high', [`GET /auth/v1/user answered HTTP ${view.status} without a user, so the session is not usable`, ...evidence], 'Re-run verify; if it persists, check the auth service status for this project.');
    }
    if (view.id !== session.userId) {
      return result('fail', 'high', [`GET /auth/v1/user returned user ${view.id}, not the signed-in user ${session.userId}`, ...evidence], 'The token resolves to another account: stop and inspect the project before using this session.');
    }
    evidence.push(`GET /auth/v1/user with that token returned the same user (${view.id})`);

    // Without the token the same endpoint must refuse: that is the baseline the app relies on.
    let anon;
    try {
      anon = await auth.user(ctx);
    } catch (e) {
      if (e instanceof SupabaseAuthPrereqError) return skip(errMsg(e));
      return result('fail', 'high', [`could not read the anonymous answer from the auth API: ${errMsg(e)}`, ...evidence], `Check that ${provider} auth is reachable, then re-run verify.`);
    }
    if (anon.status === 200) {
      return result('fail', 'critical', [`an anonymous GET /auth/v1/user returned a user (${anon.id ?? 'no id'})`, ...evidence], 'The auth API must answer 401 without a token: check for a proxy, middleware or key that turns anonymous requests into signed-in ones.');
    }
    if (anon.status === 401) evidence.push('an anonymous GET /auth/v1/user is refused (401)');
    else issues.push({ severity: 'medium', line: `an anonymous GET /auth/v1/user answered HTTP ${anon.status} instead of 401, so the unauthenticated baseline is not established` });

    // The app's own protected route, anonymously. Only the host-confirmed production URL is probed.
    const path = ctx.config.auth?.protectedPath;
    let blockedLeg: CheckOutcome | null = null;
    if (!path) {
      evidence.push('no auth.protectedPath configured: the app\'s own route protection was not checked');
    } else {
      const confirmed = await confirmedProductionUrl(ctx);
      if (!confirmed.ok) blockedLeg = confirmed.outcome;
      else {
        const base = trimSlash(confirmed.url);
        const url = `${base}${path}`;
        let r;
        try {
          r = await probe(ctx, url, { headers: { 'user-agent': 'golive-verify' } });
        } catch (e) {
          issues.push({ severity: 'medium', line: `GET ${url} without a session failed: ${errMsg(e)}` });
          r = null;
        }
        if (r) {
          const line = `anonymous GET ${url} → HTTP ${r.status}${r.status >= 300 && r.status < 400 ? ` (→ ${r.headers.location ?? 'no location'})` : ''}`;
          if (r.status === 200) {
            return result(
              'fail',
              'critical',
              [`${line}: the declared protected path is served without a session`, ...evidence],
              `Make ${path} require a session (redirect to sign-in, or answer 401/403 when there is no session). If the route renders a sign-in page with 200 instead, pick a path that redirects in \`auth.protectedPath\` — golive cannot tell a rendered sign-in page from a public page.`,
            );
          }
          if (r.status === 401 || r.status === 403) {
            const leg = await publicRouteRead(ctx, base, url, line, r.status);
            if (leg.evidence) evidence.push(leg.evidence);
            if (leg.issue) issues.push(leg.issue);
          } else if (r.status >= 300 && r.status < 400) evidence.push(`${line}: redirected out of the route without a session`);
          else issues.push({ severity: 'medium', line: `${line}: golive could not establish protection (a 404 usually means the path in auth.protectedPath is wrong or not deployed)` });
        }
      }
    }

    const table = await signedInTables(ctx, dest.ref, session.accessToken);
    evidence.push(...table.lines);
    if (table.issue) issues.push(table.issue);

    const lines = [...issues.map((i) => i.line), ...evidence];
    const failing = issues.filter((i) => i.severity === 'high' || i.severity === 'critical');
    if (failing.length) return result('fail', failing[0]!.severity, lines, failing.map((i) => i.fix).filter(Boolean).join(' '));
    // A declared protected path golive could not probe leaves the check unable to claim a pass.
    if (blockedLeg) return { ...blockedLeg, evidence: [...blockedLeg.evidence, ...lines] };
    if (issues.length) return result('warn', issues[0]!.severity, lines, issues.map((i) => i.fix).filter(Boolean).join(' '));
    return result('pass', 'info', lines);
  },
};

/**
 * The declared protected path answered 401/403 — which is also what a WAF, edge rule, visitor access
 * or a maintenance page answers. One more request to the route that must stay public (the production
 * root, never a second guess at the app's routing) separates the two: a root that answers normally
 * scopes the refusal to this path, a walled root means golive cannot attribute it to the app, and
 * anything else is reported as what it was. Never more than these two URLs are read.
 */
async function publicRouteRead(ctx: Ctx, base: string, url: string, line: string, status: number): Promise<{ evidence?: string; issue?: Issue }> {
  const root = `${base}/`;
  let rootStatus: number;
  try {
    // A declared path that IS the root needs no second request: the same read already answered.
    rootStatus = root === url ? status : (await probe(ctx, root, { headers: { 'user-agent': 'golive-verify' } })).status;
  } catch (e) {
    return {
      issue: {
        severity: 'medium',
        line: `${line}: golive could not attribute the refusal to the app, because the public root ${root} could not be read (${errMsg(e)})`,
        fix: `Re-run verify: the protected-path leg stays unconfirmed until ${root}, the route that must stay public, can be read anonymously.`,
      },
    };
  }
  if (rootStatus >= 200 && rootStatus < 300) {
    return { evidence: `${line}: protected without a session, and the public root ${root} answered HTTP ${rootStatus} to the same anonymous request, so the refusal is scoped to this path rather than a wall over the whole origin` };
  }
  if (rootStatus === 401 || rootStatus === 403) {
    return {
      issue: {
        severity: 'medium',
        line: `${line}: inconclusive, because the public root ${root} also answered HTTP ${rootStatus} — a WAF, edge rule, visitor access or a maintenance page refuses the whole origin the same way, so golive cannot tell its refusal from the app's`,
        fix: `Make ${root} answer as the public page it must be (turn off the protection wall, visitor access or the maintenance page for production), then re-run verify: while the whole origin is walled, golive cannot confirm that ${url} is protected by your app.`,
      },
    };
  }
  return {
    issue: {
      severity: 'medium',
      line: `${line}: golive could not attribute the refusal to the app, because the public root ${root} answered HTTP ${rootStatus} rather than a normal page`,
      fix: `Make ${root} answer normally to an anonymous request, then re-run verify: only a readable public route shows that ${url} is refused by the app rather than by something in front of it.`,
    },
  };
}

/**
 * Read the app's exposed tables AS the signed-in user, and name them. Every table refusing the
 * `authenticated` role is the signature of a missing GRANT (new projects no longer grant new tables
 * automatically); a reachable table is evidence, not a leak finding — anonymity is `rls-probe`'s job.
 * The count line stays, and each verdict names up to MAX_NAMED of its tables so it can be audited.
 */
async function signedInTables(ctx: Ctx, ref: string, token: Secret): Promise<{ lines: string[]; issue?: Issue }> {
  const admin = cap(ctx, 'db', 'dbAdmin');
  const outputs = cap(ctx, 'db', 'outputs');
  if (!admin || !outputs) return { lines: ['the signed-in table probe needs the database admin and outputs capabilities, so no table was probed'] };
  let key: Value | undefined;
  try {
    key = (await outputs.outputs(ctx, 'production', ['supabase.publishableKey']))['supabase.publishableKey'];
  } catch {
    key = undefined;
  }
  if (!key) return { lines: ['no publishable/anon key is available, so no table was probed as the signed-in user'] };
  let tables: TableInfo[];
  try {
    tables = (await admin.tables(ctx)).filter((t) => !INTERNAL_SCHEMAS.test(t.schema));
  } catch (e) {
    return { lines: [`could not list tables: ${errMsg(e)}`] };
  }
  if (!tables.length) return { lines: ['no tables in exposed schemas'] };
  const batch = tables.slice(0, MAX_TABLES);
  const read: Array<{ fq: string; verdict: Verdict }> = [];
  for (const t of batch) {
    let verdict: Verdict;
    try {
      const r = await authedRestProbe(ctx, ref, t.name, t.schema, key, token);
      verdict = r.status === 200 ? 'reachable' : [401, 403, 404, 406].includes(r.status) || r.code === '42501' ? 'denied' : 'undecided';
    } catch {
      verdict = 'undecided';
    }
    read.push({ fq: `${t.schema}.${t.name}`, verdict });
  }
  const count = (v: Verdict) => read.filter((t) => t.verdict === v).length;
  const denied = count('denied');
  const lines = [
    `probed ${batch.length} exposed table(s) as the signed-in user: ${count('reachable')} reachable, ${denied} denied, ${count('undecided')} undecided`,
    ...(['reachable', 'denied', 'undecided'] as const).flatMap((v) => {
      const names = read.filter((t) => t.verdict === v).map((t) => t.fq);
      if (!names.length) return [];
      const beyond = names.length - MAX_NAMED;
      return [`${v}: ${names.slice(0, MAX_NAMED).join(', ')}${beyond > 0 ? ` (+${beyond} more)` : ''}`];
    }),
  ];
  if (tables.length > batch.length) lines.push(`${tables.length - batch.length} further table(s) were not probed`);
  if (denied === batch.length) {
    return {
      lines,
      issue: {
        severity: 'medium',
        line: `the signed-in user is denied by every exposed table golive probed (${denied}): the app may be missing the GRANT for the authenticated role`,
        fix: 'If the app queries these tables as the signed-in user, add the GRANT plus RLS policies in a migration (`grant select on <table> to authenticated;` with policies scoped to `auth.uid()`), then re-run verify.',
      },
    };
  }
  return { lines };
}
