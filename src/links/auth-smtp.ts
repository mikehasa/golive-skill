import type { Link } from '../core/plan.js';
import type { AuthConfig, AuthSettings, AuthSmtp, CheckResult, Ctx, Step } from '../core/types.js';
import { type Secret, vaultGet } from '../core/secret.js';
import { KEY_VAULT } from '../adapters/resend.js';
import { emailDomain } from './email.js';
import { type AxisStatus, axisStatus, deps, errMsg, intentOf, memo, projectAxisFor, projectIntent, step, track } from './util.js';

/** Resend's documented SMTP endpoint: the host, its SSL port and the username its API keys send as. */
const SMTP_HOST = 'smtp.resend.com';
const SMTP_PORT = 465;
const SMTP_USER = 'resend';

/** The state slot recording the sending key golive issued as the auth project's SMTP password. */
export const smtpKeySlot = (provider: string): string => `${provider}.keyId@smtp`;

/** The SMTP fields golive writes and can read back, in the order a human reads them. */
const FIELDS = [
  { field: 'host', label: 'SMTP host' },
  { field: 'port', label: 'SMTP port' },
  { field: 'user', label: 'SMTP user' },
  { field: 'senderEmail', label: 'sender address' },
  { field: 'senderName', label: 'sender name' },
] as const;
type SmtpField = (typeof FIELDS)[number]['field'];
type SmtpValue = string | number;
/** Only fields golive has a value for are written: a sender with no display name has no senderName. */
type Want = Partial<Pick<AuthSmtp, SmtpField>>;

const show = (v: SmtpValue | undefined): string => (v === undefined || v === '' ? '(not set)' : String(v));

/** `Shop <hello@example.com>` (or a bare address) → the address and display name the SMTP fields want. */
export function senderOf(from: string | undefined): { email?: string; name?: string } {
  const raw = from?.trim();
  if (!raw) return {};
  const m = /^(.*?)\s*<\s*([^>]+)\s*>\s*$/.exec(raw);
  if (!m) return { email: raw };
  const name = m[1]!.replace(/^"|"$/g, '').trim();
  return { email: m[2]!.trim(), ...(name ? { name } : {}) };
}

/** Why the email axis cannot hand this step a sending key, in one phrase. */
function whyEmail(status: AxisStatus): string {
  if (status.kind === 'none') return 'no email provider is chosen in golive.yaml';
  if (status.kind === 'guided') return `${status.title} is guided`;
  if (status.kind === 'unauthed') return `${status.adapter.title} is not connected yet`;
  return `${status.adapter.title} is not Resend`;
}

/**
 * `auth.smtp: resend` → the auth project's custom SMTP: Resend's documented host/port/user, the sender
 * address the app already sends as, and the one write-only secret — an SMTP password that is a sending
 * key. The key is the one the email journey issued in this run when there is one (the run vault, handed
 * over by the `email:key:<target>` steps this step waits for), otherwise one golive issues for SMTP
 * alone under `golive-<app>-smtp` and records in state like every other key. Never a paste, and never
 * a new manual step.
 *
 * The provider answers the password field with a hash and never the value, so the step confirms what it
 * can read back (host, port, user, sender) and that the write was accepted. A real auth email arriving
 * is the only full proof, and the auth journeys golive runs after this step are what produce one.
 *
 * Separate from `auth:settings` (the policy fields) so a policy change never rewrites the mailer, and
 * it only ever plans for the one opt-in that asks for the app's own email provider.
 */
export const authSmtpLink: Link = {
  id: 'auth-smtp',
  async plan(ctx) {
    if (ctx.config.auth?.smtp !== 'resend') return null;
    const au = await axisStatus(ctx, 'auth');
    // Guided or unauthenticated: the auth-redirects handoff and the accounts check cover that state.
    if (au.kind !== 'ready') return null;
    const authConfig = au.adapter.capabilities.authConfig;
    if (!authConfig) return null;

    const em = await axisStatus(ctx, 'email');
    if (em.kind !== 'ready' || em.adapter.id !== 'resend') {
      return { steps: [], handoffs: [], warnings: [`auth.smtp is "resend" in golive.yaml, but ${whyEmail(em)}: golive knows only Resend's SMTP endpoint and needs its API to obtain a sending key, so the custom-SMTP write stays a manual dashboard step`] };
    }
    const keys = em.adapter.capabilities.keys;
    if (!keys) {
      return { steps: [], handoffs: [], warnings: [`auth.smtp is "resend" in golive.yaml, but ${em.adapter.title} exposes no key issuance: golive cannot obtain the sending key the SMTP password has to be, so the custom-SMTP write is left out of this plan`] };
    }
    const sender = senderOf(ctx.config.email?.from);
    if (!sender.email) {
      return { steps: [], handoffs: [], warnings: ['auth.smtp is "resend" in golive.yaml but golive.yaml sets no email.from: the SMTP sender is an address on the sending domain (the one the app sends as), so the custom-SMTP write is left out of this plan'] };
    }
    const domain = emailDomain(ctx);

    let before: AuthSettings;
    try {
      before = await authConfig.get(ctx);
    } catch (e) {
      return { steps: [], handoffs: [], warnings: [`reading ${au.adapter.title} auth settings failed (${errMsg(e)}); the custom-SMTP write is left out of this plan`] };
    }

    const want: Want = { host: SMTP_HOST, port: SMTP_PORT, user: SMTP_USER, senderEmail: sender.email, ...(sender.name ? { senderName: sender.name } : {}) };
    const changes = FIELDS.filter((f) => want[f.field] !== undefined && before.smtp?.[f.field] !== want[f.field]).map((f) => ({ label: f.label, from: before.smtp?.[f.field] as SmtpValue | undefined, to: want[f.field]! }));

    const slot = smtpKeySlot(em.adapter.id);
    const recorded = ctx.state.resource(slot);
    const fromJourney = deps(ctx, [...memo(ctx).planned].filter((id) => id.startsWith('email:key:')));
    // Nothing differs, golive already wrote this config, and no fresh key arrives: planning again would
    // rewrite the same settings with a key the provider will not let golive re-read, so a re-plan would
    // mint one sending key per run for no change.
    if (!changes.length && ctx.state.get().steps['auth:smtp']?.status === 'done' && !fromJourney.length) return null;

    const axis = projectAxisFor(ctx, au.adapter);
    const s = step({
      id: 'auth:smtp',
      title: `Send ${au.adapter.title} auth emails through Resend's SMTP`,
      kind: 'wire',
      risk: { writes: true },
      dependsOn: deps(ctx, [...(axis ? [`project:${axis}`] : []), ...(fromJourney.length ? fromJourney : ['email:domain'])]),
      preview: [
        `set the ${au.adapter.title} project's custom SMTP to Resend (${SMTP_HOST}:${SMTP_PORT}, user ${SMTP_USER}) as ${sender.email}${sender.name ? ` (${sender.name})` : ''}`,
        ...changes.map((c) => `${c.label}: ${show(c.from)} → ${show(c.to)}`),
        fromJourney.length
          ? 'the SMTP password is the sending key the email journey issues in this run'
          : `the SMTP password is a sending key golive issues for SMTP alone (golive-…-smtp), recorded in state as ${slot} like every other key${recorded ? ` (it issued ${recorded} before)` : ''}`,
        'the password is never printed, stored or reported; the provider answers that field with a hash, so what the write can show is the accepted request plus the host/port/user/sender it reports back, and a real auth email arriving is the only full proof it can send',
      ],
      intent: intentOf({
        project: await projectIntent(ctx, au.adapter),
        sender: sender.email,
        key: fromJourney.length ? `journey:${fromJourney.join(',')}` : `smtp:${recorded ?? 'new'}`,
        write: Object.entries(want).map(([k, v]) => `${k}=${String(v)}`),
      }),
      verifyWith: ['auth-policy'],
      async run(sctx) {
        const lines = changes.map((c) => `${c.label}: ${show(c.from)} → ${show(c.to)}`);
        const held = vaultGet(KEY_VAULT);
        let password: Secret;
        if (held) {
          password = held;
          lines.push(`SMTP password: the sending key this run issued earlier (fp:${password.fingerprint})`);
        } else {
          const issued = await keys.issue(sctx, 'production', { ...(domain ? { domain } : {}), purpose: 'smtp' });
          sctx.remember(slot, issued.id);
          password = issued.secret;
          lines.push(`issued the ${em.adapter.title} sending key ${issued.id} as the SMTP password (fp:${password.fingerprint}); recorded in state as ${slot}, so teardown can revoke it`);
          if (recorded && recorded !== issued.id) lines.push(`the SMTP key golive issued earlier (${recorded}) is left active; revoke it in ${em.adapter.title} once nothing uses it`);
        }
        const outcome = await authConfig.set(sctx, { smtp: want, smtpPassword: password });
        for (const skip of outcome.skipped) lines.push(`not confirmed: ${skip}`);
        lines.push(`the password itself is only ever accepted, never confirmed: ${au.adapter.title} answers it with a hash, and a real auth email arriving is the only full proof it can send`);
        return { changes: lines };
      },
      verifyInline: (vctx) => verifySmtp(vctx, au.adapter.title, authConfig, want),
    });
    return { steps: track(ctx, [s] as Step[]), handoffs: [], warnings: [] };
  },
};

/**
 * Step-scoped verification: re-read the SMTP fields this step wrote. The password is not part of it —
 * the provider never returns the value — so a field the provider reports differently fails the step,
 * and one it does not report back is named as unconfirmed instead (the step's changes already say the
 * password cannot be confirmed this way).
 */
async function verifySmtp(ctx: Ctx, title: string, authConfig: AuthConfig, want: Want): Promise<CheckResult[]> {
  const id = 'auth:smtp:applied';
  const checkTitle = `${title} custom SMTP holds after the write`;
  let after: AuthSettings;
  try {
    after = await authConfig.get(ctx);
  } catch (e) {
    return [{ id, title: checkTitle, status: 'fail', severity: 'high', evidence: [`could not re-read ${title} auth settings: ${errMsg(e)}`], fix: 'Check the auth provider login, then re-run apply.' }];
  }
  const confirmed: string[] = [];
  const unconfirmed: string[] = [];
  const wrong: string[] = [];
  for (const f of FIELDS) {
    const to = want[f.field];
    if (to === undefined) continue;
    const got = after.smtp?.[f.field];
    if (got === undefined) unconfirmed.push(`${f.label}: ${title} does not report it back`);
    else if (got === to) confirmed.push(`${f.label}: ${show(got)}`);
    else wrong.push(`${f.label} is ${show(got)} after the write, not ${show(to)}`);
  }
  const limit = 'the SMTP password is write-only (the provider answers a hash), so this proves the settings, not a delivery';
  if (wrong.length) {
    return [
      {
        id,
        title: checkTitle,
        status: 'fail',
        severity: 'high',
        evidence: [...wrong, ...confirmed, ...unconfirmed, limit],
        fix: `Set the custom SMTP in the ${title} dashboard, or check that this credential may update auth settings, then re-run apply.`,
      },
    ];
  }
  return [{ id, title: checkTitle, status: 'pass', severity: 'info', evidence: [...confirmed, ...unconfirmed, limit] }];
}
