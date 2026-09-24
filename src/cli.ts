/**
 * golive CLI — called by the agent (per SKILL.md), no terminal prompts. Explicit credential entry
 * can open a native hidden-input dialog whose value never reaches CLI output.
 * Every command prints ONE JSON document to stdout with --json (the agent parses it) and never prints
 * a secret value. Exit code 0 = ok, 1 = error, 2 = done-but-action-needed (failed checks / blocked).
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRuntimeRelease, PRODUCT_VERSION } from './core/release.js';
import { checkForUpdate } from './core/update-check.js';
import { statusForBundle } from '../scripts/install-lib.mjs';
import { exec } from './core/exec.js';
import { createHttp, allowHost } from './core/http.js';
import { emit, logger } from './core/output.js';
import { loadConfig, saveConfig, defaultConfig, ConfigError, isDomain } from './core/config.js';
import { fileStateStore, readOnlyStateStore } from './core/state.js';
import { createCtx } from './core/context.js';
import { mapEnv } from './core/envmap.js';
import { buildPlan, planView } from './core/plan.js';
import { approvedPlan, buildTeardownPlan } from './core/teardown.js';
import { detectDrift } from './core/drift.js';
import { applyPlan, runCheck, PlanMismatchError } from './core/runner.js';
import { credentialsStatus, setupCredentials } from './core/credentials.js';
import { promptCredential } from './core/credential-prompt.js';
import { AXES, type Axis, type Check, type CheckResult, type Ctx, type HandoffItem, type Report, type ShipConfig } from './core/types.js';
import { ADAPTERS, CHECKS, adapterById, adapterFor, checkMap, linkList } from './registry.js';
import { GUIDED } from './adapters/index.js';
import { detect } from './detect/index.js';
import { renderReport } from './report/render.js';
import { buildHandover } from './handover/build.js';
import { assertOverwritable, handoverJson, handoverPaths, renderHandover } from './report/handover.js';

const VERSION = PRODUCT_VERSION;

interface Args {
  cmd: string;
  flags: Record<string, string | true>;
}

export function parseArgs(argv: string[]): Args {
  const [cmd = 'help', ...rest] = argv;
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (!a.startsWith('--')) throw new UsageError(cmd === 'credentials' ? 'credentials never accepts secret values in arguments; use the native prompt or your own editor.' : `unexpected argument: ${a}`);
    const eq = a.indexOf('=');
    if (eq > 0) flags[a.slice(2, eq)] = a.slice(eq + 1);
    else if (rest[i + 1] !== undefined && !rest[i + 1]!.startsWith('--')) flags[a.slice(2)] = rest[++i]!;
    else flags[a.slice(2)] = true;
  }
  return { cmd, flags };
}

class UsageError extends Error {}

const HELP = `golive ${VERSION} — take an app from repo to live production on your own accounts.

Commands (add --json for machine output; --cwd <dir> to target another repo):
  version                    Show the verified release identity.
  update-check [--offline]   Check public release metadata; never replaces files or reads secrets.
  credentials --setup       Prepare a private empty credentials file; preserve any existing contents.
  credentials --prompt NAME [--replace] [--lang en|zh]
                            macOS hidden input; store locally and return metadata only. Never pass a value.
  detect                     Scan the repo: framework, providers in use, env var names referenced.
  menu                       Provider options for each axis (neutral order; automated vs guided).
  init --stack k=v,...       Write golive.yaml, e.g. --stack hosting=vercel,db=supabase,payments=stripe
       [--domain d] [--webhook-path /api/webhooks/stripe] [--events a,b] [--email-from x@d]
       [--project hosting=<id|name>,db=<id|name>]   (adopt existing projects)
       [--stripe-publishable test=pk_test_…,live=pk_live_…]   (public keys only)
  doctor                     Is each chosen provider reachable/logged in? What must the human do?
  plan                       Show the steps golive would take (read-only). Prints a planId.
  teardown                   Inverse plan: only resources golive created, for removal. Prints a planId.
  apply --plan <id> --yes    Execute the approved plan. Risky steps also need --confirm-live /
        [--confirm-live] [--confirm-dns] [--confirm-destroy] [--only id,id] [--force]
  verify [--only id,id]      Run live checks; writes .golive/report.json and GOLIVE_REPORT.md.
  status                     Has anything changed behind golive's back? Recorded baselines vs reads
                             taken now (read-only, writes no file). Exit 2 = something to act on.
  handoff                    What only the human can do (logins, KYC, payments), and whether it's done.
       [--write] [--force]   --write also writes .golive/handover.json and GOLIVE_HANDOVER.md (the
                             ownership/renewal document); --force replaces files golive did not write.
`;

async function main(argv: string[]): Promise<number> {
  const { cmd, flags } = parseArgs(argv);
  const json = flags.json === true;
  const cwd = resolve(typeof flags.cwd === 'string' ? flags.cwd : process.cwd());
  // Validate instructions and runtime as a unit before any project/provider/credential access.
  const release = loadRuntimeRelease(import.meta.url);

  if (cmd === 'help' || flags.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (cmd === 'version') {
    emit({ version: VERSION, release }, { json });
    return 0;
  }
  if (cmd === 'update-check') {
    const modulePath = fileURLToPath(import.meta.url);
    const bundleRoot = basename(modulePath) === 'cli.ts' ? resolve(dirname(modulePath), '../skills/golive') : resolve(dirname(modulePath), '..');
    const ownership = statusForBundle(bundleRoot);
    emit(await checkForUpdate(release, { ownership, disabled: flags.offline === true || process.env.GOLIVE_UPDATE_CHECK === '0', ...(flags['no-cache'] === true ? { cachePath: false as const } : {}) }), { json });
    return 0;
  }
  if (cmd === 'credentials') {
    if (Object.keys(flags).some((key) => !['json', 'cwd', 'setup', 'prompt', 'replace', 'lang'].includes(key))) {
      throw new UsageError('credentials accepts only --setup or --prompt NAME [--replace] [--lang en|zh]; never put a secret value in arguments.');
    }
    if (flags.setup === true && flags.prompt === undefined && flags.replace === undefined && flags.lang === undefined) {
      emit({ ok: true, ...setupCredentials() }, { json });
      return 0;
    }
    if (flags.setup !== undefined || typeof flags.prompt !== 'string' ||
        (flags.replace !== undefined && flags.replace !== true) ||
        (flags.lang !== undefined && flags.lang !== 'en' && flags.lang !== 'zh')) {
      throw new UsageError('credentials needs --setup or --prompt NAME [--replace] [--lang en|zh]; supply the variable name only, never its value.');
    }
    const result = await promptCredential(flags.prompt, { replace: flags.replace === true, language: flags.lang === 'zh' ? 'zh' : 'en' });
    emit({ ok: result.status === 'saved', ...result }, { json });
    return result.status === 'saved' && !result.cleanupRequired ? 0 : 2;
  }

  const d = await detect(cwd);
  const env = mapEnv(d.envRefs);

  const findings = [...d.findings, ...env.findings];
  if (cmd === 'detect') {
    emit({ ok: true, detect: d, env: { mapped: env.mapped, unmapped: env.unmapped }, findings, suggestedStack: suggestStack(d) }, { json });
    return findings.some((f) => f.severity === 'critical') ? 2 : 0;
  }

  if (cmd === 'menu') {
    emit({ ok: true, menu: menu(d) }, { json });
    return 0;
  }

  if (cmd === 'init') {
    const cfg = initConfig(loadConfig(cwd) ?? defaultConfig(), flags, d);
    saveConfig(cwd, cfg);
    emit({ ok: true, wrote: 'golive.yaml', config: cfg }, { json });
    return 0;
  }

  const config = loadConfig(cwd);
  if (!config) throw new UsageError('no golive.yaml yet — run `detect`, pick providers with the human, then `init --stack ...`');
  const ctx = createCtx({ cwd, exec, http: createHttp(), log: logger, config, state: fileStateStore(cwd), detect: d, adapters: ADAPTERS, release });
  if (config.domain) allowHost(config.domain), allowHost(`www.${config.domain}`);

  switch (cmd) {
    case 'doctor': {
      const rows = [];
      for (const axis of AXES) {
        const id = config.stack[axis];
        if (!id) continue;
        const a = adapterById(id);
        if (!a) {
          rows.push({ axis, provider: id, automated: false, ok: false, howToFix: `unknown provider "${id}" — best-effort guidance via official CLI/MCP/API or dashboard; approve external writes first. This doctor cannot verify its login; check coverage varies and skipped checks remain unverified.` });
          continue;
        }
        const s = await a.auth(ctx).catch((e: Error) => ({ ok: false, howToFix: e.message }));
        rows.push({ axis, provider: id, automated: a.automated, ...s });
      }
      const credentials = credentialsStatus();
      const ok = rows.every((r) => r.ok) && credentials.private !== false;
      emit({ ok, providers: rows, credentials }, { json });
      return ok ? 0 : 2;
    }
    case 'plan': {
      const plan = await buildPlan(ctx, linkList(), { unmappedEnv: env.unmapped, warnings: findings.map((f) => `[${f.severity}] ${f.title}`) });
      emit({ ok: true, ...planView(plan), findings }, { json });
      return 0;
    }
    case 'teardown': {
      const plan = await buildTeardownPlan(ctx);
      const note = plan.steps.length || plan.handoffs.length ? undefined : 'nothing golive created was found to remove';
      emit({ ok: true, ...planView(plan), ...(note ? { note } : {}) }, { json });
      return 0;
    }
    case 'apply': {
      if (typeof flags.plan !== 'string') throw new UsageError('apply needs --plan <planId> (from `plan` or `teardown`, approved by the human)');
      const plan = await approvedPlan(ctx, flags.plan, () => buildPlan(ctx, linkList(), { unmappedEnv: env.unmapped, warnings: [] }));
      const only = typeof flags.only === 'string' ? flags.only.split(',').map((s) => s.trim()).filter(Boolean) : undefined;
      const unknown = (only ?? []).filter((id) => !plan.steps.some((s) => s.id === id));
      if (unknown.length) throw new UsageError(`unknown step id(s): ${unknown.join(', ')}. Steps in this plan: ${plan.steps.map((s) => s.id).join(', ') || '(none)'}`);
      const outcomes = await applyPlan(ctx, plan, checkMap(), {
        approvedPlanId: flags.plan,
        yes: flags.yes === true,
        confirmLive: flags['confirm-live'] === true,
        confirmDns: flags['confirm-dns'] === true,
        confirmDestroy: flags['confirm-destroy'] === true,
        only,
        force: flags.force === true,
      });
      const hs = await handoffStatus(ctx, plan.handoffs);
      const openBlocking = hs.filter((h) => h.blocking && h.done === false);
      const allDone = outcomes.every((o) => o.status === 'done' || o.status === 'skipped');
      // Nothing ran because humans still have to act → not "ok", even though nothing failed.
      const ok = allDone && !(outcomes.length === 0 && openBlocking.length > 0);
      emit({ ok, planId: plan.id, outcomes, openHandoffs: openBlocking, ...(outcomes.length === 0 ? { note: 'no steps ran' } : {}) }, { json });
      return ok ? 0 : 2;
    }
    case 'verify': {
      const only = typeof flags.only === 'string' ? new Set(flags.only.split(',').map((s) => s.trim()).filter(Boolean)) : null;
      if (only) {
        const unknown = [...only].filter((id) => !CHECKS.some((c) => c.id === id));
        if (unknown.length) throw new UsageError(`unknown check id(s): ${unknown.join(', ')}. Valid: ${CHECKS.map((c) => c.id).join(', ')}`);
      }
      const fresh: CheckResult[] = [];
      for (const c of CHECKS) if (!only || only.has(c.id)) fresh.push(await runCheck(ctx, c));
      // A report contains this invocation's evidence only. Prior checks can describe another
      // release, config, project or deployment and must never be relabelled as fresh results.
      const results = fresh;
      const omittedCheckIds = CHECKS.filter((c) => only && !only.has(c.id)).map((c) => c.id);
      const verification: NonNullable<Report['verification']> = {
        scope: omittedCheckIds.length > 0 ? 'partial' : 'full',
        requestedCheckIds: CHECKS.filter((c) => !only || only.has(c.id)).map((c) => c.id),
        omittedCheckIds,
      };
      const plan = await buildPlan(ctx, linkList(), { unmappedEnv: env.unmapped, warnings: [] }).catch(() => null);
      const report = await makeReport(ctx, results, await handoffStatus(ctx, plan?.handoffs ?? [], results, false), verification);
      const reportPaths = { json: join(cwd, '.golive/report.json'), markdown: join(cwd, 'GOLIVE_REPORT.md') };
      mkdirSync(join(cwd, '.golive'), { recursive: true });
      writeFileSync(reportPaths.json, JSON.stringify(report, null, 2) + '\n');
      writeFileSync(reportPaths.markdown, renderReport(report));
      emit({ ok: report.summary.fail === 0, report, reportPaths }, { json });
      return report.summary.fail === 0 ? 0 : 2;
    }
    case 'status': {
      // Read-only: no report or state file, no provider write. Drift is never a gate on plan/apply.
      // A failed step is compared against the plan this release would run now — observed, never
      // applied, and through a state view that drops the caches adapters write — because whether
      // `apply` could replay it depends on what the step declares (see drift.ts).
      const failed = Object.values(ctx.state.get().steps).some((r) => r.status === 'failed');
      const plan = failed
        ? await buildPlan({ ...ctx, state: readOnlyStateStore(ctx.state) }, linkList(), { unmappedEnv: env.unmapped, warnings: [] }).catch(() => null)
        : null;
      const drift = await detectDrift(ctx, plan);
      const actionable = drift.items.filter((i) => i.action !== 'none');
      const note = drift.notChecked.length
        ? `${drift.notChecked.length} subject(s) could not be compared this run (see notChecked): golive did not read them, so this is not a clean bill of health`
        : undefined;
      emit({ ok: actionable.length === 0, ...drift, ...(note ? { note } : {}) }, { json });
      return actionable.length ? 2 : 0;
    }
    case 'handoff': {
      const plan = await buildPlan(ctx, linkList(), { unmappedEnv: env.unmapped, warnings: [] });
      const items = await handoffStatus(ctx, plan.handoffs);
      const unverified = items.filter((i) => i.done === null);
      const note = unverified.length ? 'items with done:null cannot be verified by golive — confirm them with the human and name them as unverified in your summary' : undefined;
      if (flags.write !== true) {
        emit({ ok: items.every((i) => i.done !== false || !i.blocking), handoffs: items, unverified: unverified.map((i) => i.id), note }, { json });
        return 0;
      }
      // The ownership document: written only on request, and never over a file golive did not write.
      const doc = await buildHandover(ctx, { handoffs: items, checks: CHECKS.map((c) => ({ id: c.id, applies: checkRuns(c, ctx) })) });
      const paths = handoverPaths(cwd);
      assertOverwritable(paths.json, flags.force === true);
      assertOverwritable(paths.markdown, flags.force === true);
      mkdirSync(join(cwd, '.golive'), { recursive: true });
      writeFileSync(paths.json, handoverJson(doc));
      writeFileSync(paths.markdown, renderHandover(doc));
      emit({
        ok: items.every((i) => i.done !== false || !i.blocking),
        handoffs: items,
        unverified: unverified.map((i) => i.id),
        note,
        handoverPaths: paths,
        handover: { generatedAt: doc.generatedAt, resources: doc.resources.length, manual: doc.manual.length, retirement: doc.retirement.length },
      }, { json });
      return 0;
    }
    default:
      throw new UsageError(`unknown command "${cmd}". Run \`help\`.`);
  }
}

/**
 * Whether a registered check runs on this stack: the check's own predicate decides, so the handover
 * runbook never hands a provider another provider's check. A predicate that throws keeps the check
 * nameable — the runbook advises what to run, and a check golive cannot classify is not a reason to
 * drop it from the advice.
 */
function checkRuns(check: Check, ctx: Ctx): boolean {
  try {
    return check.applies(ctx);
  } catch {
    return true;
  }
}

/**
 * Whether each handoff is closed. Only a passing check closes one; `manual` items (or ones whose
 * check can't run for this stack) are `done: null` = cannot be verified by golive.
 */
async function handoffStatus(ctx: Ctx, handoffs: HandoffItem[], ran: CheckResult[] = [], runAdditionalChecks = true): Promise<Array<HandoffItem & { done: boolean | null; evidence: string[] }>> {
  const checks = checkMap();
  const out = [];
  for (const h of handoffs) {
    if (h.manual) {
      out.push({ ...h, done: null, evidence: [] });
      continue;
    }
    // Not manual and no check: it's in the plan only because its condition still holds → open.
    if (!h.verifiedBy || !checks.has(h.verifiedBy)) {
      out.push({ ...h, done: false, evidence: [] });
      continue;
    }
    const existing = ran.find((x) => x.id === h.verifiedBy);
    if (!existing && !runAdditionalChecks) {
      out.push({ ...h, done: null, evidence: ['not run in this verification invocation'] });
      continue;
    }
    const r = existing ?? (await runCheck(ctx, checks.get(h.verifiedBy)!));
    out.push({ ...h, done: r.status === 'pass' ? true : r.status === 'skip' ? null : false, evidence: r.evidence });
  }
  return out;
}

function suggestStack(d: Awaited<ReturnType<typeof detect>>): Partial<Record<Axis, string>> {
  const out: Partial<Record<Axis, string>> = {};
  for (const axis of AXES) {
    const found = d.providers[axis];
    if (found && found.length === 1) out[axis] = found[0];
  }
  return out;
}

/** Neutral provider menu: detected-in-repo first, then automated adapters, then guided ones, each alphabetical. */
function menu(d: Awaited<ReturnType<typeof detect>>) {
  return AXES.map((axis) => {
    const inRepo = new Set(d.providers[axis] ?? []);
    const automated = ADAPTERS.filter((a) => a.axes.includes(axis)).map((a) => ({ id: a.id, title: a.title, automated: a.automated, alreadyInRepo: inRepo.has(a.id) }));
    const guided = GUIDED.filter((g) => g.axes.includes(axis) && !automated.some((a) => a.id === g.id)).map((g) => ({ id: g.id, title: g.title, automated: false, alreadyInRepo: inRepo.has(g.id) }));
    const options = [...automated, ...guided]
      .sort((x, y) => Number(y.alreadyInRepo) - Number(x.alreadyInRepo) || Number(y.automated) - Number(x.automated) || x.id.localeCompare(y.id));
    return { axis, alreadyInRepo: [...inRepo], options, note: 'Other provider? Say its name for best-effort guidance via official CLI/MCP/API or dashboard. Support and verification coverage vary; success is not guaranteed.' };
  });
}

function initConfig(base: ShipConfig, flags: Record<string, string | true>, d: Awaited<ReturnType<typeof detect>>): ShipConfig {
  const cfg: ShipConfig = structuredClone(base);
  if (typeof flags.stack === 'string') {
    for (const pair of flags.stack.split(',')) {
      const [k, v] = pair.split('=').map((s) => s.trim());
      if (!k || !v || !AXES.includes(k as Axis)) throw new UsageError(`bad --stack entry "${pair}" (axes: ${AXES.join(', ')})`);
      if (v === 'none') {
        delete cfg.stack[k as Axis];
        continue;
      }
      const known = adapterById(v);
      if (known && !known.axes.includes(k as Axis)) {
        const guided = GUIDED.filter((g) => g.axes.includes(k as Axis) && g.id.startsWith(v)).map((g) => g.id);
        throw new UsageError(`${known.title} is not a ${k} provider in golive (it covers: ${known.axes.join(', ')}).${guided.length ? ` For guided ${k} use: ${guided.join(', ')}.` : ''}`);
      }
      cfg.stack[k as Axis] = v;
    }
  }
  if (typeof flags.domain === 'string') {
    if (!isDomain(flags.domain)) throw new UsageError(`--domain must be a bare domain like example.com`);
    cfg.domain = flags.domain;
  }
  const detectedHook = d.webhooks.find((w) => w.provider === 'stripe');
  const path = typeof flags['webhook-path'] === 'string' ? flags['webhook-path'] : cfg.payments?.webhook?.path ?? detectedHook?.path;
  if (cfg.stack.payments === 'stripe' && path) {
    // Default to the event types the webhook code actually handles, so none are silently missed.
    const events = typeof flags.events === 'string' ? flags.events.split(',').map((e) => e.trim()).filter(Boolean) : cfg.payments?.webhook?.events ?? (detectedHook?.events?.length ? detectedHook.events : ['checkout.session.completed']);
    cfg.payments = { ...cfg.payments, webhook: { path, events } };
  }
  if (typeof flags['stripe-publishable'] === 'string') {
    // Publishable keys are public (they ship in the browser bundle), so passing them on argv is fine.
    const keys: Partial<Record<'test' | 'live', string>> = { ...cfg.payments?.publishableKeys };
    for (const pair of flags['stripe-publishable'].split(',')) {
      const [m, k] = pair.split('=').map((x) => x.trim());
      if ((m !== 'test' && m !== 'live') || !k || !k.startsWith(`pk_${m}_`)) throw new UsageError(`--stripe-publishable expects test=pk_test_…,live=pk_live_… (publishable keys only — never a secret key)`);
      keys[m] = k;
    }
    cfg.payments = { ...cfg.payments, publishableKeys: keys };
  }
  if (typeof flags['email-from'] === 'string') cfg.email = { ...cfg.email, from: flags['email-from'] };
  if (typeof flags.project === 'string') {
    cfg.projects = { ...cfg.projects };
    for (const pair of flags.project.split(',')) {
      const [k, v] = pair.split('=').map((x) => x.trim());
      if (!k || !v || !AXES.includes(k as Axis)) throw new UsageError(`bad --project entry "${pair}" (e.g. --project hosting=my-app,db=abcd1234)`);
      cfg.projects[k as Axis] = v;
    }
  }
  return cfg;
}

async function makeReport(ctx: Ctx, checks: Report['checks'], handoffs: Array<HandoffItem & { done: boolean | null; evidence?: string[] }>, verification: NonNullable<Report['verification']>): Promise<Report> {
  const urls: Report['app']['urls'] = {};
  const host = adapterFor(ctx, 'hosting')?.capabilities.url;
  for (const t of ctx.config.targets) {
    const u = await host?.get(ctx, t).catch(() => null);
    if (u) urls[t] = u;
  }
  const count = (s: string) => checks.filter((c) => c.status === s).length;
  return {
    version: 1,
    release: ctx.release,
    generatedAt: new Date().toISOString(),
    app: { root: ctx.cwd, framework: ctx.detect.framework, ...(ctx.config.domain ? { domain: ctx.config.domain } : {}), urls },
    stack: ctx.config.stack,
    verification,
    checks,
    handoffs: handoffs.map(({ evidence: _e, ...h }) => h),
    summary: {
      pass: count('pass'),
      fail: count('fail'),
      warn: count('warn'),
      skip: count('skip'),
      blocking: handoffs.filter((h) => h.blocking && h.done === false).length,
      manual: handoffs.filter((h) => h.blocking && h.done === null).length,
    },
  };
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e: Error) => {
    const code = e instanceof UsageError || e instanceof ConfigError || e instanceof PlanMismatchError ? 'usage' : 'error';
    emit({ ok: false, error: { code, message: e.message } }, { json: process.argv.includes('--json') });
    process.exit(1);
  },
);
