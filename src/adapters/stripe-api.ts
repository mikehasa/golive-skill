/**
 * Stripe REST plumbing shared by the stripe adapter: per-mode key lookup, the authenticated request
 * helper, and mapping Stripe's error JSON to actionable, secret-free messages.
 *
 * Stripe has NO API that creates or reveals account API keys, so keys must come from the human, once:
 * via ctx.envToken (process env or the human-edited credentials file). We never read the Stripe CLI's
 * keychain entries.
 *
 * Two roles:
 *   - the OPERATOR key (STRIPE_<MODE>_SECRET_KEY / STRIPE_SECRET_KEY) is what golive itself calls Stripe
 *     with. It may be a restricted rk_ key holding only the permissions golive needs.
 *   - the APP key (`stripe.secretKey` output → the app's STRIPE_SECRET_KEY on the host). It must be a
 *     standard sk_ key: STRIPE_APP_<MODE>_SECRET_KEY if set, else the operator key ONLY if that is a
 *     standard key. A restricted operator key is never handed to the app (it lacks the app's
 *     permissions, e.g. Checkout Sessions), so the app's key then stays a human handoff.
 */
import { tokenHowTo } from '../core/credentials.js';
import { HttpError } from '../core/http.js';
import { Secret, redact } from '../core/secret.js';
import type { Ctx, HttpRequest, HttpResponse, Mode } from '../core/types.js';

export const STRIPE_API = 'https://api.stripe.com';
export const MODE_KEY_ENV: Record<Mode, string> = { live: 'STRIPE_LIVE_SECRET_KEY', test: 'STRIPE_TEST_SECRET_KEY' };
export const SHARED_KEY_ENV = 'STRIPE_SECRET_KEY';
/** Optional standard keys for the APP (never used for golive's own calls). */
export const APP_KEY_ENV: Record<Mode, string> = { live: 'STRIPE_APP_LIVE_SECRET_KEY', test: 'STRIPE_APP_TEST_SECRET_KEY' };

export interface KeyLookup {
  key?: Secret;
  /** Env var name the key came from (safe to print). */
  source?: string;
  /** Set when an env var is present but holds the wrong kind of key. */
  problem?: string;
}

function keyMode(s: Secret): Mode | null {
  const m = /^(?:sk|rk)_(live|test)_/.exec(s.reveal());
  return m ? (m[1] as Mode) : null;
}

export function isRestrictedKey(s: Secret): boolean {
  return s.reveal().startsWith('rk_');
}

/** STRIPE_<MODE>_SECRET_KEY wins; STRIPE_SECRET_KEY is used only when its prefix matches the mode. */
export function lookupKey(ctx: Ctx, mode: Mode): KeyLookup {
  const name = MODE_KEY_ENV[mode];
  const specific = ctx.envToken(name);
  if (specific) {
    const m = keyMode(specific);
    if (m === mode) return { key: specific, source: name };
    return { problem: m ? `${name} holds a ${m}-mode key, not a ${mode}-mode one` : `${name} is not a Stripe secret key (expected sk_${mode}_… or rk_${mode}_…)` };
  }
  const shared = ctx.envToken(SHARED_KEY_ENV);
  if (shared && keyMode(shared) === mode) return { key: shared, source: SHARED_KEY_ENV };
  return {};
}

/**
 * The key the APP gets as `stripe.secretKey` for `mode`: STRIPE_APP_<MODE>_SECRET_KEY (must be a
 * standard sk_<mode>_ key), else the operator key if — and only if — it is a standard sk_ key.
 * `restrictedOperator` = the only key available is golive's restricted operator key (not handed out).
 */
export function lookupAppKey(ctx: Ctx, mode: Mode): KeyLookup & { restrictedOperator?: boolean } {
  const name = APP_KEY_ENV[mode];
  const app = ctx.envToken(name);
  if (app) {
    const m = keyMode(app);
    if (m === mode && !isRestrictedKey(app)) return { key: app, source: name };
    if (m === mode) return { problem: `${name} is a restricted key (rk_${mode}_…); the app key must be a standard secret key (sk_${mode}_…)` };
    return { problem: m ? `${name} holds a ${m}-mode key, not a ${mode}-mode one` : `${name} is not a Stripe secret key (expected sk_${mode}_…)` };
  }
  const op = lookupKey(ctx, mode);
  if (op.key && isRestrictedKey(op.key)) {
    return { restrictedOperator: true, problem: `${op.source} is a restricted key that golive uses for its own calls; it is never copied into the app (set ${name} to a standard sk_${mode}_… key, or add the app's key to the host yourself)` };
  }
  return op;
}

/** Where to get the app's own (standard) key to golive, for a handoff. Never asks for it in chat. */
export function appKeyHowToFix(mode: Mode): string {
  const name = APP_KEY_ENV[mode];
  return `Copy the ${mode}-mode standard secret key (sk_${mode}_…) from Stripe Dashboard → Developers → API keys. ${tokenHowTo(name)} golive then puts it into the app's STRIPE_SECRET_KEY for you; or add the app's key to the host yourself straight from the Stripe dashboard.`;
}

/** The OPERATOR secret key for `mode`, or undefined if the human hasn't provided one. */
export function stripeKeyFor(ctx: Ctx, mode: Mode): Secret | undefined {
  return lookupKey(ctx, mode).key;
}

export const RESTRICTED_KEY_PERMS = 'Webhook Endpoints: Write, Events: Read and Account: Read';

/** Instructions for getting golive its operator key(s). Never asks for them in chat or on argv. */
export function keyHowToFix(modes: Mode[]): string {
  const vars = modes.map((m) => MODE_KEY_ENV[m]);
  const first = vars[0] ?? MODE_KEY_ENV.test;
  const appVars = modes.map((m) => APP_KEY_ENV[m]).join(' / ');
  return [
    `Stripe needs a secret key for ${modes.join(' and ')} mode (Stripe has no API that can hand golive a key).`,
    `In the Stripe Dashboard → Developers → API keys, copy the ${modes.join('/')} standard secret key (sk_…), or create a restricted key (rk_…) with ${RESTRICTED_KEY_PERMS}.`,
    `A standard key is also what golive puts into your app's STRIPE_SECRET_KEY; a restricted key is used only by golive itself and is never copied into the app (then also add a standard key as ${appVars}, or set the app's key on the host yourself).`,
    tokenHowTo(first) + (vars.length > 1 ? ` Add ${vars.slice(1).join(', ')} the same way.` : ''),
  ].join(' ');
}

export function requireKey(ctx: Ctx, mode: Mode): { key: Secret; source: string } {
  const k = lookupKey(ctx, mode);
  if (k.key && k.source) return { key: k.key, source: k.source };
  throw new Error(`No Stripe ${mode}-mode secret key available${k.problem ? ` (${k.problem})` : ''}. ${keyHowToFix([mode])}`);
}

// ── Requests ────────────────────────────────────────────────────────────────────────────────────

export class StripeApiError extends HttpError {
  constructor(
    message: string,
    status: number,
    body: string,
    readonly code?: string,
    readonly type?: string,
  ) {
    super(message, status, body);
  }
}

export interface StripeCall {
  method?: HttpRequest['method'];
  /** Path + optional query, e.g. "/v1/webhook_endpoints?limit=100". */
  path: string;
  form?: HttpRequest['form'];
  idempotencyKey?: string;
  /** Safe to re-send after a 5xx/timeout (e.g. an update that sets fixed values). Never for creates. */
  idempotent?: boolean;
  /** Human description for errors, e.g. "list Stripe test webhook endpoints". */
  what: string;
}

/** Authenticated request; returns the raw response whatever the status. */
export async function stripeRaw<T>(ctx: Ctx, mode: Mode, call: StripeCall): Promise<HttpResponse<T> & { keySource: string }> {
  const { key, source } = requireKey(ctx, mode);
  const headers: Record<string, string | Secret> = { Authorization: new Secret('STRIPE_AUTH_HEADER', `Bearer ${key.reveal()}`) };
  if (call.idempotencyKey) headers['Idempotency-Key'] = call.idempotencyKey;
  const req: HttpRequest = { method: call.method ?? 'GET', url: STRIPE_API + call.path, headers };
  if (call.form) req.form = call.form;
  if (call.idempotent) req.idempotent = true;
  const res = await ctx.http<T>(req);
  return Object.assign(res, { keySource: source });
}

/** Authenticated request that throws a mapped StripeApiError unless 2xx. */
export async function stripeCall<T>(ctx: Ctx, mode: Mode, call: StripeCall): Promise<HttpResponse<T>> {
  const res = await stripeRaw<T>(ctx, mode, call);
  if (res.status < 200 || res.status >= 300) throw stripeError(res, call.what, mode, res.keySource);
  return res;
}

interface StripeErrorBody {
  error?: { type?: string; code?: string; message?: string; param?: string };
}

/** Map Stripe's error JSON to a message telling the human/agent what to do next. Always redacted. */
export function stripeError(res: HttpResponse<unknown>, what: string, mode: Mode, keySource: string): StripeApiError {
  const e = (res.json as StripeErrorBody | undefined)?.error ?? {};
  const detail = e.message ? `: ${e.message}` : '';
  let msg: string;
  if (res.status === 401) {
    msg = `${what} failed: Stripe rejected the ${mode}-mode key in ${keySource} (invalid, expired or revoked). Copy a current key from Dashboard → Developers → API keys. ${tokenHowTo(keySource)}`;
  } else if (res.status === 403) {
    msg = `${what} failed: the ${mode}-mode key in ${keySource} lacks permission${detail}. If it is a restricted key, grant it ${RESTRICTED_KEY_PERMS} in Dashboard → Developers → API keys (or use the standard secret key).`;
  } else if (res.status === 404) {
    msg = `${what} failed: not found in ${mode} mode${detail}.`;
  } else if (res.status === 429) {
    msg = `${what} failed: Stripe is rate-limiting requests. Wait a minute and re-run.`;
  } else if (res.status === 400 && e.param) {
    msg = `${what} failed: Stripe rejected "${e.param}"${detail}. Fix that value and re-run.`;
  } else {
    const kind = [e.type, e.code].filter(Boolean).join('/');
    msg = `${what} failed: HTTP ${res.status}${kind ? ` (${kind})` : ''}${detail}.`;
  }
  return new StripeApiError(redact(msg), res.status, redact(res.text.slice(0, 1000)), e.code, e.type);
}
