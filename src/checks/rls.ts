import type { Check, Ctx, Severity, TableInfo, Value } from '../core/types.js';
import { fetchBundle, findPublicSupabaseKeys } from './bundle.js';
import { restProbe } from './providers.js';
import { blocked, cap, confirmedProductionUrl, errMsg, isFailing, pass, prereq, result, skip, worst } from './util.js';

export const MAX_TABLES = 60;

/** Schemas Supabase manages itself; never exposed through the app's REST API by default. */
export const INTERNAL_SCHEMAS = /^(auth|storage|extensions|realtime|vault|pgsodium|pgsodium_masks|graphql|graphql_public|net|cron|supabase_.*|pg_.*|information_schema|_realtime|_analytics)$/;

interface Issue {
  severity: Severity;
  line: string;
  fix?: string;
}

async function projectRef(ctx: Ctx): Promise<string | null> {
  const fromState = ctx.state.resource('supabase.ref');
  if (fromState) return fromState;
  const project = cap(ctx, 'db', 'project');
  const cur = project ? await project.current(ctx).catch(() => null) : null;
  return cur?.id ?? null;
}

/**
 * The PUBLIC key visitors already have: from provider outputs, else from the live bundle, but only
 * the bundle of the URL the host confirms is this project's (a key from someone else's page, or from
 * an auth wall we were redirected to, must never be used to probe anything).
 */
async function publishableKey(ctx: Ctx, ref: string): Promise<{ key: Value; from: string } | null> {
  const outputs = cap(ctx, 'db', 'outputs');
  if (outputs) {
    try {
      const v = (await outputs.outputs(ctx, 'production', ['supabase.publishableKey']))['supabase.publishableKey'];
      if (v) return { key: v, from: 'provider outputs' };
    } catch {
      /* fall through to the bundle */
    }
  }
  const confirmed = await confirmedProductionUrl(ctx);
  if (!confirmed.ok) return null;
  try {
    const bundle = await fetchBundle(ctx, confirmed.url);
    if (bundle.offsite || bundle.htmlStatus < 200 || bundle.htmlStatus >= 300) return null;
    const key = findPublicSupabaseKeys(bundle.files, ref)[0];
    return key ? { key, from: 'the public bundle' } : null;
  } catch {
    return null;
  }
}

/** A SELECT policy for anon/public whose USING clause is just `true`: everyone can read. */
function openReadPolicy(t: TableInfo): string | undefined {
  return t.policies.find(
    (p) => p.permissive && /^(select|all|\*)$/i.test(p.command) && p.roles.some((r) => r === 'anon' || r === 'public') && p.using?.trim().toLowerCase() === 'true',
  )?.name;
}

async function probeTable(ctx: Ctx, ref: string, key: Value, t: TableInfo): Promise<Issue | null> {
  const fq = `${t.schema}.${t.name}`;
  let r: { status: number; rows: number };
  try {
    r = await restProbe(ctx, ref, t.name, t.schema, key);
  } catch (e) {
    return { severity: 'medium', line: `${fq}: probe failed (${errMsg(e)})` };
  }
  if (r.status === 200 && r.rows > 0) return { severity: 'critical', line: `anyone can read ${fq} (anonymous GET returned rows)` };
  if (r.status === 200 && !t.rls) return { severity: 'high', line: `${fq} is exposed with RLS disabled (empty today; without RLS anyone with the public key can read and write it)` };
  if (r.status === 200) {
    const pol = openReadPolicy(t);
    return pol ? { severity: 'medium', line: `${fq}: policy "${pol}" lets anonymous visitors read every row` } : null;
  }
  if ([401, 403, 404, 406].includes(r.status)) return null; // not readable by anon: permission denied / not exposed
  return { severity: 'medium', line: `${fq}: unexpected HTTP ${r.status} from the read probe` };
}

/** Read-only probe of every exposed table with the public key, plus Supabase security advisors. */
export const rlsCheck: Check = {
  id: 'rls-probe',
  title: 'Database tables are not readable by anonymous visitors',
  severity: 'critical',
  applies: (ctx) => ctx.config.stack.db === 'supabase',
  async run(ctx) {
    const admin = cap(ctx, 'db', 'dbAdmin');
    if (!admin) return skip('database adapter has no admin capability');
    const pre = await prereq(ctx, 'db', { project: false });
    if (pre) return pre;
    const ref = await projectRef(ctx);
    if (!ref) return blocked('project:db', 'no Supabase project linked yet');

    const issues: Issue[] = [];
    const evidence: string[] = [];

    let tables: TableInfo[];
    try {
      tables = (await admin.tables(ctx)).filter((t) => !INTERNAL_SCHEMAS.test(t.schema));
    } catch (e) {
      return result('fail', 'high', [`could not list tables: ${errMsg(e)}`], 'Re-run verify; if it persists, check the Supabase login with `golive doctor`.');
    }

    let noKey = false;
    if (tables.length) {
      const pk = await publishableKey(ctx, ref);
      if (!pk) {
        noKey = true;
      } else {
        const batch = tables.slice(0, MAX_TABLES);
        evidence.push(`probed ${batch.length}/${tables.length} table(s) anonymously with the publishable key from ${pk.from}`);
        for (const t of batch) {
          const issue = await probeTable(ctx, ref, pk.key, t);
          if (issue) issues.push(issue);
        }
        if (tables.length > MAX_TABLES) issues.push({ severity: 'low', line: `${tables.length - MAX_TABLES} table(s) beyond the first ${MAX_TABLES} were not probed` });
      }
    } else evidence.push('no tables in exposed schemas');

    if (admin.advisors) {
      try {
        for (const f of await admin.advisors(ctx)) {
          if (f.severity === 'info') continue;
          issues.push({
            severity: f.severity,
            line: `advisor: ${f.title}${f.evidence[0] ? ` (${f.evidence[0]})` : ''}`,
            fix: `${f.title}: ${f.fix || 'Review this finding in the Supabase Security Advisor and follow its remediation.'}`,
          });
        }
      } catch (e) {
        evidence.push(`advisors unavailable: ${errMsg(e)}`);
      }
    }

    const sev = worst(issues.map((i) => i.severity));
    const lines = [...issues.map((i) => i.line), ...evidence];
    if (noKey && !issues.some((i) => i.severity !== 'low' && i.severity !== 'info')) {
      // Missing prerequisite, not a finding: nothing was probed.
      return result('skip', 'info', [`blocked by: no publishable/anon key (from ${cap(ctx, 'db', 'outputs') ? 'provider outputs or ' : ''}a host-confirmed production bundle); ${tables.length} table(s) not probed`, ...lines]);
    }
    if (noKey) lines.push(`no publishable/anon key found, so ${tables.length} table(s) were not probed`);
    const rlsFix =
      'Enable RLS on every table in exposed schemas (`alter table <t> enable row level security;`) and add policies that scope rows to `auth.uid()`; keep intentionally public tables read-only via an explicit SELECT policy. Re-run verify after migrating.';
    // Advisors also cover Auth and other project settings. Preserve their own remediation instead
    // of presenting every provider warning as a table-policy problem.
    const fix = [...new Set(issues.filter((i) => i.severity !== 'low' && i.severity !== 'info').map((i) => i.fix ?? rlsFix))].join(' ');
    if (isFailing(sev)) return result('fail', sev, lines, fix);
    if (issues.some((i) => i.severity === 'medium')) return result('warn', 'medium', lines, fix);
    return pass(lines);
  },
};
