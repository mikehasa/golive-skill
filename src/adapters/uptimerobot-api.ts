/**
 * UptimeRobot v2 transport.
 *
 * One credential: the account's API key in UPTIMEROBOT_API_KEY (process environment or golive's
 * credentials file). The v2 API is a form-encoded POST to `https://api.uptimerobot.com/v2/<method>`
 * with `api_key` and `format=json` in the body — never in a URL, a header, an error or state. The
 * docs (uptimerobot.com/api/legacy, checked 2026-10-03) name three key types, and golive words them
 * as the least privilege each operation needs: a **read-only** key can call every `get*` method
 * (enough to read the monitor `uptime-monitor` checks), a **monitor-specific** key can call only
 * `getMonitors` for its one monitor, and the account's **main** (account-specific) key is what
 * `newMonitor` and `deleteMonitor` require.
 *
 * The response envelope is `{ stat: "ok" }` or `{ stat: "fail", error: { type, parameter_name,
 * passed_value, message } }`; an API-level failure comes with HTTP 200, so `stat` — not the status
 * code — is the verdict, and every non-2xx is mapped to an actionable, redacted message. The docs
 * publish rate limits (FREE 10 req/min; Pro monitor limit × 2, capped at 5000) enforced with 429 and
 * X-RateLimit-* / Retry-After headers.
 */
import { tokenHowTo } from '../core/credentials.js';
import { HttpError } from '../core/http.js';
import { Secret, redact } from '../core/secret.js';
import type { Ctx } from '../core/types.js';

export const UPTIMEROBOT_TOKEN = 'UPTIMEROBOT_API_KEY';
export const UPTIMEROBOT_API_HOST = 'https://api.uptimerobot.com';

/** The v2 methods golive calls. A fixed list, so no caller input can build a path. */
export const UPTIMEROBOT_METHODS = ['getAccountDetails', 'getMonitors', 'newMonitor', 'deleteMonitor'] as const;
export type UptimerobotMethod = (typeof UPTIMEROBOT_METHODS)[number];

/**
 * UptimeRobot key types, as the docs describe them (uptimerobot.com/api/legacy): the least privilege
 * each golive operation needs. Worded here once so doctor, help and errors stay consistent.
 */
export const UPTIMEROBOT_KEY_TYPES =
  'UptimeRobot key types (uptimerobot.com/api/legacy): a read-only key can call every get* method — enough to read the monitor golive checks; a monitor-specific key can call only getMonitors for its one monitor; creating and deleting the monitor golive manages needs the account\'s main (account-specific) key. golive never needs a key wider than that.';

export function uptimerobotHelp(): string {
  return `Create an API key in UptimeRobot under Integrations & API → API (older dashboards: My Settings → API). Use a read-only key for monitoring alone, or the account's main key when golive should create and delete the monitor it manages. ${UPTIMEROBOT_KEY_TYPES} ${tokenHowTo(UPTIMEROBOT_TOKEN)}`;
}

/** A UptimeRobot refusal, carrying the provider's own error type when it reported one. */
export class UptimerobotApiError extends HttpError {
  constructor(
    message: string,
    status: number,
    body: string,
    readonly code?: string,
  ) {
    super(message, status, body);
  }
}

interface UptimerobotEnvelope {
  stat?: unknown;
  error?: unknown;
}

/** The `error` object's fields as the docs describe them (`type`, `message`, `parameter_name`, `passed_value`). */
function errorOf(res: { json?: unknown; text: string }): { code: string; detail: string; parameter: string } {
  const body = res.json && typeof res.json === 'object' && !Array.isArray(res.json) ? (res.json as UptimerobotEnvelope) : {};
  const err = body.error && typeof body.error === 'object' && !Array.isArray(body.error) ? (body.error as Record<string, unknown>) : {};
  const code = typeof err.type === 'string' ? err.type : '';
  const detail = typeof err.message === 'string' ? err.message : typeof err.detail === 'string' ? err.detail : '';
  const parameter = typeof err.parameter_name === 'string' ? err.parameter_name : '';
  return { code, detail: detail || res.text.slice(0, 300), parameter };
}

/**
 * Map one refused answer to an actionable, redacted message. Never echoes the request body: it
 * carries the API key in `api_key` (and, for the monitor methods, only names, ids and URLs).
 */
export function uptimerobotError(res: { status: number; json?: unknown; text: string; headers?: Record<string, string> }, what: string): UptimerobotApiError {
  const { code, detail, parameter } = errorOf(res);
  const kind = code ? ` (${code})` : '';
  const at = parameter ? ` on ${parameter}` : '';
  let hint: string;
  if (res.status === 401 || res.status === 403) {
    hint = ` The UptimeRobot credential in ${UPTIMEROBOT_TOKEN} was rejected or lacks this permission. ${UPTIMEROBOT_KEY_TYPES}`;
  } else if (res.status === 404) {
    hint = ' UptimeRobot answered "not found" for this path: the API version or method may have changed since the plan was approved. Re-run `golive plan` and re-approve.';
  } else if (res.status === 429) {
    const retry = res.headers?.['retry-after'];
    hint = ` UptimeRobot is rate-limiting requests (the docs publish FREE 10 req/min up to 5000 for Pro).${retry ? ` It asked to retry after ${retry} s.` : ''} Wait a moment and re-run.`;
  } else if (res.status === 0) {
    hint = ` Could not reach ${UPTIMEROBOT_API_HOST}; check your network and re-run.`;
  } else {
    hint = '';
  }
  return new UptimerobotApiError(redact(`UptimeRobot ${what} failed (HTTP ${res.status}${kind}): ${detail}${at}${hint}`), res.status, redact(res.text.slice(0, 1000)), code || undefined);
}

/**
 * An API-level refusal: the answer was a 2xx but `stat` was not "ok" — exactly how the v2 API reports
 * a bad key, a missing parameter or a plan limit. Treated as a refusal, never inferred around.
 */
export function uptimerobotStatError(res: { status: number; json?: unknown; text: string }, what: string): UptimerobotApiError {
  const { code, detail, parameter } = errorOf(res);
  const kind = code ? ` (${code})` : '';
  const at = parameter ? ` on ${parameter}` : '';
  const keyHint = /api[_-]?key|invalid[_ ]?parameter|missing[_ ]?parameter/i.test(`${code} ${detail} ${parameter}`)
    ? ` Check that ${UPTIMEROBOT_TOKEN} holds an account key that may call ${what}. ${UPTIMEROBOT_KEY_TYPES}`
    : '';
  const planHint =
    code === 'access_denied'
      ? ' The account\'s plan refused this call: free plans have been observed refusing newMonitor with access_denied (the v2 docs publish no such limit). Create the monitor in the UptimeRobot dashboard and set projects.monitoring to its id or name (golive then adopts it), or change the plan yourself — golive never changes a plan or spends money.'
      : '';
  return new UptimerobotApiError(redact(`UptimeRobot ${what} failed${kind}: ${detail}${at}${keyHint}${planHint}`), res.status, redact(res.text.slice(0, 1000)), code || undefined);
}

export interface UptimerobotCall {
  method: UptimerobotMethod;
  /** Extra form fields (never the key: this transport adds it). Values may be Secrets. */
  form?: Record<string, string | number | boolean | Secret | undefined>;
  /** Human description for errors, e.g. "list monitors". */
  what: string;
  /** Safe to re-send (a read). Never a create. */
  idempotent?: boolean;
}

/**
 * One authenticated POST. Refuses a key that is not there at all (an unusable prerequisite is
 * something callers skip on, so it throws) and maps both a non-2xx status and a `stat: "fail"`
 * envelope through the error mappers, which never echo the credential.
 */
export async function uptimerobotCall<T>(ctx: Ctx, call: UptimerobotCall): Promise<T> {
  const key = ctx.envToken(UPTIMEROBOT_TOKEN);
  if (!key) throw new UptimerobotApiError(`No UptimeRobot credential is available. ${uptimerobotHelp()}`, 0, '');
  if (!(UPTIMEROBOT_METHODS as readonly string[]).includes(call.method)) throw new UptimerobotApiError('Invalid UptimeRobot API method.', 0, '');
  const res = await ctx.http<T & UptimerobotEnvelope>({
    method: 'POST',
    url: `${UPTIMEROBOT_API_HOST}/v2/${call.method}`,
    form: { api_key: key, format: 'json', ...(call.form ?? {}) },
    ...(call.idempotent ? { idempotent: true } : {}),
  });
  if (res.status < 200 || res.status >= 300) throw uptimerobotError(res, call.what);
  if (!res.json || typeof res.json !== 'object' || Array.isArray(res.json) || (res.json as UptimerobotEnvelope).stat !== 'ok') {
    throw uptimerobotStatError(res, call.what);
  }
  return res.json;
}

/** A `newMonitor`/`deleteMonitor` answer, whose `monitor` object carries the affected id. */
export function affectedMonitorId(json: unknown): string {
  const m = json && typeof json === 'object' && !Array.isArray(json) ? (json as { monitor?: unknown }).monitor : undefined;
  const id = m && typeof m === 'object' && !Array.isArray(m) ? (m as Record<string, unknown>).id : undefined;
  const s = typeof id === 'number' ? String(id) : typeof id === 'string' ? id : '';
  if (!/^[0-9]{1,20}$/.test(s)) throw new UptimerobotApiError('UptimeRobot returned no monitor id for the affected monitor; nothing was inferred.', 0, '');
  return s;
}
