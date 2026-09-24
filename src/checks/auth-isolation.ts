import { randomBytes } from 'node:crypto';
import type { Check, Ctx, Severity } from '../core/types.js';
import { Secret, vaultGet } from '../core/secret.js';
import { SupabaseAuthPrereqError } from '../adapters/supabase-auth.js';
import { TEST_USER_EMAIL, TEST_USER_ID, testUserPassKey } from '../links/auth-e2e.js';
import { ISOLATION_USER_EMAIL, ISOLATION_USER_ID } from '../links/auth-isolation.js';
import { adapterFor, blocked, cap, confirmedProductionUrl, errMsg, prereq, probe, result, skip, trimSlash, type CheckOutcome } from './util.js';

/** One signed-in test account: what the identity and rows legs of the check carry around. */
interface Account {
  /** How the account is named in evidence ("the test account" / "the second test account"). */
  who: string;
  email: string;
  /** The provider's own id for it, from recorded state; the session is checked against it. */
  id: string;
  token: Secret;
}

interface Issue {
  severity: Severity;
  line: string;
  fix?: string;
}

/**
 * The value golive writes into one row THROUGH the app and then looks for in the other account's
 * answer. Unique per run and per account, so finding it anywhere but that account's own rows is a
 * leak rather than a coincidence. It is not a credential: it is one small row in the human's project.
 */
function marker(role: string): string {
  return `gl-iso-${role}-${randomBytes(6).toString('hex')}`;
}

const routeTask = (path: string): string =>
  `app-code task: deploy a route at ${path} that answers the signed-in caller the way auth.identityPath / auth.isolationPath in golive.yaml declares, then re-run verify`;

const sessionTask = (path: string): string =>
  `app-code task: read the caller's session from the \`Authorization: Bearer <token>\` header on ${path} (the token is one the auth provider just issued for that account), then re-run verify`;

/**
 * A declared route that cannot answer the check right now — the app does not implement it, refuses the
 * session golive holds, or rate-limits the request. Each of those is a skip that names the app-code
 * task: never a pass, and never a leak, because golive claims only what it actually read.
 */
function notAnswered(line: string, status: number, path: string): CheckOutcome | null {
  if (status === 404) return result('skip', 'info', [`${line}: the app does not implement the declared route (${path})`, routeTask(path)]);
  if (status === 401 || status === 403) return result('skip', 'info', [`${line}: the route refused the session token golive holds for the account it asks as`, sessionTask(path)]);
  if (status >= 300 && status < 400) return result('skip', 'info', [`${line}: the route redirected a request that carried a session, so it never answered as the caller`, sessionTask(path)]);
  if (status === 429) return result('skip', 'info', [`${line}: the app rate-limited the request, so isolation was not exercised`]);
  return null;
}

const withEvidence = (outcome: CheckOutcome, evidence: string[]): CheckOutcome => ({ ...outcome, evidence: [...outcome.evidence, ...evidence] });

const statusLine = (r: { status: number; location?: string }): string => `HTTP ${r.status}${r.status >= 300 && r.status < 400 ? ` (→ ${r.location ?? 'no location'})` : ''}`;

/** How an anonymous answer reads when it is not the route itself: the refusal golive looks for. */
const anonWord = (status: number): string =>
  status === 401 || status === 403 ? 'refused without a session' : status >= 300 && status < 400 ? 'redirected out of the route without a session' : 'answered neither as the route nor as a refusal';

/**
 * One request, carrying a session token as a Secret header: the token never reaches a URL, a body,
 * evidence or a log. Without an account it is the anonymous request the app must refuse.
 */
async function send(ctx: Ctx, url: string, opts: { account?: Account; method?: 'GET' | 'POST'; body?: unknown } = {}): Promise<{ status: number; text: string; location?: string }> {
  const headers: Record<string, string | Secret> = { 'user-agent': 'golive-verify' };
  if (opts.account) headers.authorization = new Secret(opts.account.token.name, `Bearer ${opts.account.token.reveal()}`);
  const r = await probe(ctx, url, { method: opts.method ?? 'GET', body: opts.body, headers });
  return { status: r.status, text: r.text ?? '', ...(r.headers.location ? { location: r.headers.location } : {}) };
}

/**
 * Account isolation: can one signed-in account read another account's data through the app? That is
 * the half of authentication a single account can never show. Golive seeds and records both accounts
 * (the `auth:test-user` step and the `auth:isolation` step), signs in as both, and then asks the app's
 * OWN declared routes: the identity route must answer each caller with its own id, and the rows route
 * must return only rows that belong to the caller — checked with a marker row golive writes for each
 * account through that same route, so the read-back is attributable to exactly one account.
 *
 * Both routes are read anonymously first: a 200 there is a critical finding, whoever the caller is.
 * This check writes nothing to the provider, but it does sign in as two real accounts and stores two
 * small rows in the human's own project through the app, which is why it only runs under the explicit
 * `auth.isolation: true` opt-in. It never probes a table anonymously (that is `rls-probe`'s job) and
 * never reads a row golive did not ask the app to write.
 */
export const authIsolationCheck: Check = {
  id: 'auth-isolation',
  title: 'A signed-in account cannot read another account\'s data through the app',
  severity: 'critical',
  applies: (ctx) => Boolean(ctx.config.stack.auth),
  async run(ctx) {
    if (ctx.config.auth?.isolation !== true) {
      return skip('auth.isolation is not enabled in golive.yaml: this check signs in as two real accounts and writes one marker row per account through the app, so it only runs on explicit opt-in');
    }
    const provider = ctx.config.stack.auth!;
    const title = adapterFor(ctx, 'auth')?.title ?? provider;
    const identityPath = ctx.config.auth.identityPath;
    const isolationPath = ctx.config.auth.isolationPath;
    if (!identityPath || !isolationPath) {
      const missing = [!identityPath ? 'auth.identityPath' : '', !isolationPath ? 'auth.isolationPath' : ''].filter(Boolean).join(' and ');
      return skip(`auth.isolation is on in golive.yaml but no app route is declared (${missing}): golive has nothing to read through, so isolation is not exercised (the auth:isolation-routes handoff names what the app must expose)`);
    }
    const auth = cap(ctx, 'auth', 'authUsers');
    if (!auth) return skip(`auth provider ${provider} has no auth-users surface (guided): account isolation stays a manual app test`);
    const pre = await prereq(ctx, 'auth');
    if (pre) return pre;
    const first = ctx.state.resource(TEST_USER_ID);
    if (!first) return blocked('auth:test-user', 'no test account has been seeded yet');
    const second = ctx.state.resource(ISOLATION_USER_ID);
    if (!second) return blocked('auth:isolation', 'no second test account has been seeded yet');
    const firstPass = vaultGet(testUserPassKey(first));
    const secondPass = vaultGet(testUserPassKey(second));
    if (!firstPass || !secondPass) {
      const missing = [!firstPass ? 'the test account' : '', !secondPass ? 'the second test account' : ''].filter(Boolean).join(' and ');
      return skip(`blocked by: no password for ${missing} in this run (only the run that seeds or rotates an account keeps one, in memory): re-run \`plan\` + \`apply\` so both passwords are rotated, then run verify`);
    }
    const firstEmail = ctx.state.resource(TEST_USER_EMAIL) ?? ctx.config.auth.testEmail;
    const secondEmail = ctx.state.resource(ISOLATION_USER_EMAIL);
    if (!firstEmail || !secondEmail) return skip('the addresses of the recorded test accounts are not known, so golive cannot sign in as both');

    const issues: Issue[] = [];
    /** A medium finding: a leg the app answered in a way that leaves this part unproven. */
    const soft = (line: string, why: string): void => {
      issues.push({
        severity: 'medium',
        line: `${line}: ${why}`,
        fix: `Make the declared routes answer the isolation journey as golive.yaml describes (auth.identityPath / auth.isolationPath, and the auth:isolation-routes handoff), then re-run verify.`,
      });
    };

    const wanted: Array<[string, string, Secret, string]> = [
      ['the test account', firstEmail, firstPass, first],
      ['the second test account', secondEmail, secondPass, second],
    ];
    const accounts: Account[] = [];
    for (const [who, email, password, recorded] of wanted) {
      let outcome;
      try {
        outcome = await auth.login(ctx, email, password);
      } catch (e) {
        if (e instanceof SupabaseAuthPrereqError) return skip(errMsg(e));
        return result('fail', 'high', [`signing in as ${who} ${email} failed: ${errMsg(e)}`], `Check that ${provider} auth is reachable, then re-run verify.`);
      }
      if (outcome.rateLimited) {
        return result('skip', 'info', [`the provider rate-limited the password login for ${who} (HTTP 429), so the two sessions were not established at once`, 'wait for the limit to reset, then re-run verify: isolation needs a session for BOTH accounts in the same run']);
      }
      if (!outcome.session) {
        if ((outcome.code ?? '').includes('email_not_confirmed')) {
          return result(
            'warn',
            'medium',
            [
              `${who} ${email} is not confirmed yet, so it has no session: ${who === 'the test account' ? 'the auth:confirm-email handoff covers the click in that inbox' : 'the auth:isolation step confirms this account through the provider and reads it back'}`,
              'without both sessions nothing about isolation can be read, and this check claims nothing from one account alone',
            ],
            'Run `plan` + `apply` again (each step rotates its own account\'s password), then re-run verify.',
          );
        }
        return result('fail', 'high', [`${who} ${email} cannot sign in (${outcome.code})`], `Check that account in the ${title} dashboard (confirmed, not banned, password policy), then re-run \`plan\` + \`apply\` and verify.`);
      }
      if (outcome.session.userId !== recorded) {
        return result(
          'fail',
          'high',
          [`the login for ${email} returned user ${outcome.session.userId}, not the recorded account ${recorded}`],
          'The account that signed in is not the recorded test account: stop and inspect the provider user list and the state keys before reading anything as it.',
        );
      }
      accounts.push({ who, email, id: outcome.session.userId, token: outcome.session.accessToken });
    }
    const [a, b] = accounts as [Account, Account];
    const evidence: string[] = [`signed in as ${a.email} (${a.id}) and ${b.email} (${b.id})`];

    const confirmed = await confirmedProductionUrl(ctx);
    if (!confirmed.ok) return withEvidence(confirmed.outcome, evidence);
    const base = trimSlash(confirmed.url);

    // 1. Neither declared route may answer an anonymous caller: that refusal is the baseline. Both are
    //    read before anything is decided, so a route the app did not implement cannot hide the other
    //    route answering 200 to the world.
    const anon: Array<{ label: string; path: string; r: { status: number; location?: string } }> = [];
    for (const [label, path] of [['identity', identityPath], ['rows', isolationPath]] as const) {
      const url = `${base}${path}`;
      let r;
      try {
        r = await send(ctx, url);
      } catch (e) {
        return result('fail', 'high', [`anonymous GET ${url} failed: ${errMsg(e)}`, ...evidence], 'Make sure the production deployment is reachable, then re-run verify.');
      }
      anon.push({ label, path, r });
    }
    const open = anon.filter((x) => x.r.status === 200);
    if (open.length) {
      return result(
        'fail',
        'critical',
        [
          ...open.map((x) => `anonymous GET ${base}${x.path} → ${statusLine(x.r)}: the declared ${x.label} route is served without a session`),
          ...evidence,
        ],
        `Make ${open.map((x) => x.path).join(' and ')} require a session: answer 401/403, or redirect to sign-in, when the request carries none. A page that renders a sign-in form with 200 does not count — golive cannot tell it from a public page.`,
      );
    }
    const missing = anon.filter((x) => x.r.status === 404);
    if (missing.length) {
      return withEvidence(
        result('skip', 'info', [
          ...missing.map((x) => `anonymous GET ${base}${x.path} → HTTP 404: the app does not implement the declared ${x.label} route (${x.path})`),
          routeTask(missing[0]!.path),
          ...anon.filter((x) => x.r.status !== 404).map((x) => `anonymous GET ${base}${x.path} → ${statusLine(x.r)}: ${anonWord(x.r.status)}`),
        ]),
        evidence,
      );
    }
    const limited = anon.find((x) => x.r.status === 429);
    if (limited) {
      return withEvidence(result('skip', 'info', [`anonymous GET ${base}${limited.path} → ${statusLine(limited.r)}: the app rate-limited the request, so nothing about isolation was exercised`]), evidence);
    }
    for (const x of anon) {
      const line = `anonymous GET ${base}${x.path} → ${statusLine(x.r)}`;
      if (x.r.status === 401 || x.r.status === 403 || (x.r.status >= 300 && x.r.status < 400)) evidence.push(`${line}: ${anonWord(x.r.status)}`);
      else soft(line, `that answer is neither the route nor a refusal, so golive cannot call ${x.path} protected`);
    }

    // 2. The identity route must answer each caller with its OWN id, never the other account's.
    const identityUrl = `${base}${identityPath}`;
    for (const [me, them] of [[a, b], [b, a]] as const) {
      let r;
      try {
        r = await send(ctx, identityUrl, { account: me });
      } catch (e) {
        return result('fail', 'high', [`GET ${identityUrl} as ${me.email} failed: ${errMsg(e)}`, ...evidence], 'Make sure the production deployment is reachable, then re-run verify.');
      }
      const line = `GET ${identityUrl} as ${me.email} (${me.id}) → ${statusLine(r)}`;
      const stop = notAnswered(line, r.status, identityPath);
      if (stop) return withEvidence(stop, evidence);
      if (r.status !== 200) {
        soft(line, 'the identity answer could not be read');
        continue;
      }
      if (r.text.includes(them.id)) {
        return result(
          'fail',
          'critical',
          [`${line}: the response carried the OTHER account's id (${them.id})`, ...evidence],
          `Make ${identityPath} answer with the signed-in caller's own identity only: a response naming another account is a cross-account read, whoever reads it.`,
        );
      }
      if (r.text.includes(me.id)) evidence.push(`GET ${identityUrl} as ${me.id} returned its own id and not ${them.id}`);
      else soft(line, `the response did not carry that account's own id (${me.id}), so golive cannot attribute the answer to a session`);
    }

    // 3. The rows route: one marker row per account, written through the app, then read back as each.
    const rowsUrl = `${base}${isolationPath}`;
    const marks: Array<{ account: Account; marker: string }> = [];
    for (const [i, role] of [a, b].entries()) {
      const value = marker(i === 0 ? 'a' : 'b');
      let w;
      try {
        w = await send(ctx, rowsUrl, { account: role, method: 'POST', body: { marker: value } });
      } catch (e) {
        return result('fail', 'high', [`POST ${rowsUrl} as ${role.email} failed: ${errMsg(e)}`, ...evidence], 'Make sure the production deployment is reachable, then re-run verify.');
      }
      const line = `POST ${rowsUrl} as ${role.email} (${role.id}) → ${statusLine(w)}`;
      if (w.status === 405 || w.status === 501) {
        return withEvidence(
          result('skip', 'info', [`${line}: the declared route does not accept a write, so golive cannot put a row of its own into either account's data`, `${routeTask(isolationPath)} — a POST that stores one row for the caller`]),
          evidence,
        );
      }
      const stop = notAnswered(line, w.status, isolationPath);
      if (stop) return withEvidence(stop, evidence);
      if (w.status < 200 || w.status >= 300) {
        soft(line, 'the marker row was not stored, so what the read-back shows is not attributable to an account');
        continue;
      }
      marks.push({ account: role, marker: value });
      evidence.push(`POST ${rowsUrl} as ${role.id} stored one marker row for that account (${statusLine(w)})`);
    }
    for (const [me, them] of [[a, b], [b, a]] as const) {
      const mine = marks.find((m) => m.account === me);
      const theirs = marks.find((m) => m.account === them);
      let r;
      try {
        r = await send(ctx, rowsUrl, { account: me });
      } catch (e) {
        return result('fail', 'high', [`GET ${rowsUrl} as ${me.email} failed: ${errMsg(e)}`, ...evidence], 'Make sure the production deployment is reachable, then re-run verify.');
      }
      const line = `GET ${rowsUrl} as ${me.email} (${me.id}) → ${statusLine(r)}`;
      const stop = notAnswered(line, r.status, isolationPath);
      if (stop) return withEvidence(stop, evidence);
      if (r.status !== 200) {
        soft(line, 'the rows answer could not be read');
        continue;
      }
      if (theirs && r.text.includes(theirs.marker)) {
        return result(
          'fail',
          'critical',
          [
            `${line}: the response carried ${them.email}'s row (marker ${theirs.marker}), which only ${them.id} wrote through the app`,
            'that is one signed-in account reading another account\'s data through the app: the declared route returned rows that do not belong to the caller',
            ...evidence,
          ],
          `Scope ${isolationPath} to the signed-in caller (an \`auth.uid()\` row policy, or the same filter in the route) and check anything that could widen it — a shared cache, a service-role client, a join. Then re-run verify.`,
        );
      }
      if (mine && r.text.includes(mine.marker)) evidence.push(`GET ${rowsUrl} as ${me.id} returned its own marker (${mine.marker}) and none of the other account's`);
      else soft(line, `the marker golive just wrote for that account was not in its own rows, so the absence of the other account's row is not attributable`);
    }

    const lines = [...issues.map((i) => i.line), ...evidence];
    const failing = issues.filter((i) => i.severity === 'high' || i.severity === 'critical');
    if (failing.length) return result('fail', failing[0]!.severity, lines, failing.map((i) => i.fix).filter(Boolean).join(' '));
    if (issues.length) return result('warn', issues[0]!.severity, lines, issues.map((i) => i.fix).filter(Boolean).join(' '));
    return result('pass', 'info', lines);
  },
};
