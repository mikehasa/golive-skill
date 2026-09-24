import type { Link } from '../core/plan.js';
import type { AuthConfig, AuthSettings, AuthWrite, CheckResult, Ctx, Step } from '../core/types.js';
import { axisStatus, deps, errMsg, intentOf, projectAxisFor, projectIntent, step, track } from './util.js';

/** The policy golive.yaml can ask for: the settings field, the label used in previews and changes. */
const POLICY = [
  { field: 'signupEnabled', label: 'signup' },
  { field: 'emailConfirmRequired', label: 'email confirmation required' },
  { field: 'minPasswordLength', label: 'password minimum length' },
] as const;
type PolicyField = (typeof POLICY)[number]['field'];
type PolicyValue = boolean | number;

interface PolicyChange {
  field: PolicyField;
  label: string;
  /** Undefined = the provider did not report the current value. */
  from: PolicyValue | undefined;
  to: PolicyValue;
}

/** What golive.yaml asks the auth project to be. Only configured keys are ever written. */
function targetOf(ctx: Ctx): AuthWrite {
  const c = ctx.config.auth;
  const target: AuthWrite = {};
  if (typeof c?.signup === 'boolean') target.signupEnabled = c.signup;
  if (typeof c?.requireEmailConfirm === 'boolean') target.emailConfirmRequired = c.requireEmailConfirm;
  if (typeof c?.passwordMinLength === 'number') target.minPasswordLength = c.passwordMinLength;
  return target;
}

/** Only the fields that actually change are written, so a no-op config plans no step at all. */
function changesOf(before: AuthSettings, target: AuthWrite): PolicyChange[] {
  const out: PolicyChange[] = [];
  for (const p of POLICY) {
    const to = target[p.field];
    if (to === undefined) continue;
    const from = before[p.field];
    if (from === to) continue;
    out.push({ field: p.field, label: p.label, from, to });
  }
  return out;
}

const show = (v: PolicyValue | undefined): string => (v === undefined ? '(not reported)' : typeof v === 'boolean' ? (v ? 'on' : 'off') : String(v));

/**
 * golive.yaml `auth` policy → the auth project: open or close signup, require email confirmation, set
 * a minimum password length. Reads the current settings, writes only what differs and re-reads them
 * before the step is reported as done. The values it writes are part of the step's intent, so a policy
 * change in golive.yaml — or a value changed back in the provider dashboard — re-runs the step.
 * Deliberately separate from `auth:redirects` (the URL work), so one never re-runs the other.
 */
export const authSettingsLink: Link = {
  id: 'auth-settings',
  async plan(ctx) {
    const target = targetOf(ctx);
    if (!Object.keys(target).length) return null;
    const au = await axisStatus(ctx, 'auth');
    // Guided or unauthenticated: the auth-redirects handoff and the accounts check cover that state.
    if (au.kind !== 'ready') return null;
    const authConfig = au.adapter.capabilities.authConfig;
    if (!authConfig) return null;

    let before: AuthSettings;
    try {
      before = await authConfig.get(ctx);
    } catch (e) {
      return { steps: [], handoffs: [], warnings: [`reading ${au.adapter.title} auth settings failed (${errMsg(e)}); the auth policy settings are left out of this plan`] };
    }
    const changes = changesOf(before, target);
    if (!changes.length) return null;

    const axis = projectAxisFor(ctx, au.adapter);
    const s = step({
      id: 'auth:settings',
      title: `Set ${au.adapter.title} auth policy`,
      kind: 'wire',
      risk: { writes: true },
      dependsOn: deps(ctx, axis ? [`project:${axis}`] : []),
      preview: changes.map((c) => `${c.label}: ${show(c.from)} → ${show(c.to)}`),
      // The auth project, the values this run writes, and the previous run's time (the repo's idiom
      // for a step whose remote state can move outside golive): a policy change in golive.yaml, or a
      // value someone changed back in the dashboard, is a new intent and runs the step again.
      intent: intentOf({
        project: await projectIntent(ctx, au.adapter),
        write: changes.map((c) => `${c.field}=${String(c.to)}`),
        previous: ctx.state.get().steps['auth:settings']?.at,
      }),
      verifyWith: ['auth-policy'],
      async run(sctx) {
        const outcome = await authConfig.set(sctx, target);
        const lines = changes.map((c) => `${c.label}: ${show(c.from)} → ${show(outcome.after?.[c.field])}`);
        for (const skip of outcome.skipped) lines.push(`not confirmed: ${skip}`);
        return { changes: lines };
      },
      verifyInline: (vctx) => verifySettings(vctx, au.adapter.title, authConfig, changes),
    });
    return { steps: track(ctx, [s] as Step[]), handoffs: [], warnings: [] };
  },
};

/**
 * Step-scoped verification: re-read the policy this step wrote. A reported value that still differs
 * fails the step; a field the provider never reports back is named as unconfirmed instead (the step's
 * changes already say so, and a provider that does not echo a setting is not a write failure).
 */
async function verifySettings(ctx: Ctx, title: string, authConfig: AuthConfig, changes: PolicyChange[]): Promise<CheckResult[]> {
  const id = 'auth:settings:applied';
  const checkTitle = `${title} auth policy holds after the write`;
  let after: AuthSettings;
  try {
    after = await authConfig.get(ctx);
  } catch (e) {
    return [{ id, title: checkTitle, status: 'fail', severity: 'high', evidence: [`could not re-read ${title} auth settings: ${errMsg(e)}`], fix: 'Check the auth provider login, then re-run apply.' }];
  }
  const confirmed: string[] = [];
  const unconfirmed: string[] = [];
  const wrong: Array<{ label: string; line: string }> = [];
  for (const c of changes) {
    const got = after[c.field];
    if (got === undefined) unconfirmed.push(`${c.label}: ${title} does not report it back`);
    else if (got === c.to) confirmed.push(`${c.label}: ${show(got)}`);
    else wrong.push({ label: c.label, line: `${c.label} is ${show(got)} after the write, not ${show(c.to)}` });
  }
  if (wrong.length) {
    return [
      {
        id,
        title: checkTitle,
        status: 'fail',
        severity: 'high',
        evidence: [...wrong.map((w) => w.line), ...confirmed, ...unconfirmed],
        fix: `Change ${wrong.map((w) => w.label).join(', ')} in the ${title} dashboard, or check that this credential may update auth settings, then re-run apply.`,
      },
    ];
  }
  return [{ id, title: checkTitle, status: 'pass', severity: 'info', evidence: [...confirmed, ...unconfirmed] }];
}
