/**
 * Sentry control-plane and event-ingest transport.
 *
 * One credential: a Sentry auth token in SENTRY_AUTH_TOKEN (process environment or golive's
 * credentials file), sent as `Authorization: Bearer …`. Its scopes decide what works: `org:read` for
 * GET /api/0/organizations/, `team:read` for the organization's teams, `project:read` and
 * `project:write` for the project list/read/create and the client keys, `project:admin` for the
 * delete teardown performs, and `event:read` for the event read-back the `sentry-ingest` check polls.
 *
 * Hosts follow `sentry.region` in golive.yaml (default us): the control plane is us.sentry.io or
 * de.sentry.io, Sentry's documented region domains (docs.sentry.io/organization/data-storage-location).
 * Ingest is different: a project's DSN carries the host and the PUBLIC key, so the DSN read from the
 * API — never a constructed host — is what the Store endpoint and the read-back use. The Store
 * request carries no auth token, exactly like an app's SDK: the public key in the payload is the
 * credential, and a 2xx means accepted, never ingested.
 *
 * Errors carry a status, the provider's own detail when it reported one, and a redacted, actionable
 * message: a missing scope names the scopes, a 404 says to re-plan, and a redirect names the region
 * setting (Sentry answers a request on the wrong region host with a redirect).
 */
import { tokenHowTo } from '../core/credentials.js';
import { HttpError } from '../core/http.js';
import { Secret, redact } from '../core/secret.js';
import type { Ctx, HttpRequest } from '../core/types.js';

export const SENTRY_TOKEN = 'SENTRY_AUTH_TOKEN';
export type SentryRegion = 'us' | 'eu';

const API_HOSTS: Record<SentryRegion, string> = { us: 'https://us.sentry.io', eu: 'https://de.sentry.io' };

export const sentryApiHost = (region: SentryRegion): string => API_HOSTS[region];

/** The region `golive.yaml` selects (default us); the config parser rejects anything else. */
export function regionOf(ctx: Ctx): SentryRegion {
  return (ctx.config.sentry as { region?: unknown } | undefined)?.region === 'eu' ? 'eu' : 'us';
}

const scopesHelp = (region: SentryRegion): string =>
  `In Sentry (${sentryApiHost(region)} → Settings → Account → API → Auth Tokens, or an internal integration), check the token's scopes: org:read (list organizations), team:read (list the organization's teams), project:read and project:write (list, read and create projects, and read their DSN/client keys), event:read (read an event back) and — for teardown's delete of a project golive created — project:admin.`;

export function sentryHelp(region: SentryRegion): string {
  return `Create an auth token at ${sentryApiHost(region)}/settings/account/api/auth-tokens/ (an internal integration's token works too) with the scopes golive uses: org:read, team:read, project:read, project:write, event:read, and project:admin when golive should be able to delete a project it created. ${tokenHowTo(SENTRY_TOKEN)}`;
}

/** A Sentry refusal, carrying the provider's own code when it reported one. */
export class SentryApiError extends HttpError {
  constructor(
    message: string,
    status: number,
    body: string,
    readonly code?: string,
  ) {
    super(message, status, body);
  }
}

interface SentryErrorBody {
  detail?: unknown;
  error?: string;
  message?: string;
  code?: string;
}

function detailOf(b: SentryErrorBody): string {
  if (typeof b.detail === 'string') return b.detail;
  if (typeof b.error === 'string') return b.error;
  if (typeof b.message === 'string') return b.message;
  return '';
}

/**
 * Map one refused response to an actionable, redacted message. Never echoes request bodies (the
 * Store body carries the PUBLIC DSN key; the control-plane bodies carry resource names only).
 */
export function sentryError(res: { status: number; json?: unknown; text: string; headers?: Record<string, string> }, what: string, region: SentryRegion): SentryApiError {
  const b = (res.json && typeof res.json === 'object' && !Array.isArray(res.json) ? res.json : {}) as SentryErrorBody;
  const code = typeof b.code === 'string' ? b.code : '';
  const detail = detailOf(b) || res.text.slice(0, 300);
  const kind = code ? ` (${code})` : '';
  const redirect = res.status === 301 || res.status === 302 || res.status === 303 || res.status === 307 || res.status === 308;
  const location = res.headers?.location;
  let hint: string;
  if (res.status === 401) {
    hint = ` The Sentry credential in ${SENTRY_TOKEN} was rejected (invalid, expired or revoked). ${sentryHelp(region)}`;
  } else if (res.status === 403) {
    hint = ` The credential lacks a scope this operation needs. ${scopesHelp(region)}`;
  } else if (res.status === 404) {
    hint = ' Sentry answered "not found" for this path: the organization, project or key scope may have changed since the plan was approved. Re-run `golive plan` and re-approve.';
  } else if (res.status === 429) {
    hint = ' Sentry is rate-limiting requests; wait a moment and re-run.';
  } else if (redirect) {
    hint = ` The API host redirected this request${location ? ` (${location})` : ''}, which usually means the organization lives in the other Sentry region: set \`sentry.region\` in golive.yaml to "eu" (or "us") and re-run.`;
  } else if (res.status === 0) {
    hint = ` Could not reach ${sentryApiHost(region)}; check your network and re-run.`;
  } else {
    hint = '';
  }
  return new SentryApiError(redact(`Sentry ${what} failed (HTTP ${res.status}${kind}): ${detail}${hint}`), res.status, redact(res.text.slice(0, 1000)), code || undefined);
}

export interface SentryCall {
  method?: HttpRequest['method'];
  /** Path + optional query, e.g. "/api/0/organizations/". Built by this adapter, never from config. */
  path: string;
  body?: unknown;
  /** Human description for errors, e.g. "list projects". */
  what: string;
  /** Safe to re-send (a read, or a write whose effect does not change on repeat). Never a create. */
  idempotent?: boolean;
}

/**
 * Authenticated control-plane request. Refuses a token that is not there at all (an unusable
 * prerequisite is something callers skip on, so it throws) and maps every non-2xx through
 * sentryError, which never echoes the request body or the credential.
 */
export async function sentryCall<T>(ctx: Ctx, region: SentryRegion, call: SentryCall): Promise<T> {
  const token = ctx.envToken(SENTRY_TOKEN);
  if (!token) throw new SentryApiError(`No Sentry credential is available. ${sentryHelp(region)}`, 0, '');
  if (!call.path.startsWith('/') || call.path.startsWith('//') || call.path.includes('://')) {
    throw new SentryApiError('Invalid Sentry API path.', 0, '');
  }
  const res = await ctx.http<T>({
    method: call.method ?? 'GET',
    url: `${sentryApiHost(region)}${call.path}`,
    headers: { Authorization: bearer(token) },
    ...(call.body === undefined ? {} : { body: call.body }),
    ...(call.idempotent ? { idempotent: true } : {}),
  });
  if (res.status < 200 || res.status >= 300) throw sentryError(res, call.what, region);
  return res.json;
}

/** `Bearer <token>` stays a Secret: the header is revealed only at the transport boundary. */
function bearer(key: Secret): Secret {
  return new Secret(SENTRY_TOKEN, `Bearer ${key.reveal()}`);
}

/** The parts of a DSN golive uses: the PUBLIC key, the ingest host, and the project id. */
export interface SentryDsn {
  publicKey: string;
  host: string;
  projectId: string;
}

/** Sentry SaaS ingest hosts: legacy `o<org>.ingest.sentry.io`, and the region-suffixed us/de forms. */
const DSN_HOST = /^o[0-9]{1,20}\.ingest\.(us\.|de\.)?sentry\.io$/;

/**
 * Parse a DSN the API returned (`https://<public key>@o<org>.ingest.<region>.sentry.io/<project id>`).
 * Refuses anything that is not that exact shape — a DSN golive cannot place at a Sentry ingest host
 * is never sent to.
 */
export function parseDsn(dsn: string): SentryDsn {
  if (dsn.length > 500) throw new SentryApiError('Sentry returned an invalid DSN; nothing was inferred.', 0, '');
  let u: URL;
  try {
    u = new URL(dsn);
  } catch {
    throw new SentryApiError('Sentry returned an invalid DSN; nothing was inferred.', 0, '');
  }
  const publicKey = u.username;
  const projectId = u.pathname.replace(/^\/+/, '').replace(/\/+$/, '');
  if (u.protocol !== 'https:' || u.password || !/^[A-Za-z0-9]{16,64}$/.test(publicKey) || !/^[0-9]{1,20}$/.test(projectId) || u.search || u.hash || !DSN_HOST.test(u.hostname)) {
    throw new SentryApiError('Sentry returned a DSN outside its documented ingest hosts; nothing was sent to it.', 0, '');
  }
  return { publicKey, host: u.hostname, projectId };
}

/**
 * Send one synthetic event to the project's Store endpoint
 * (`https://<dsn host>/api/<project id>/store/`, docs.sentry.dev/sdk/store). No auth token and no
 * Secret: the DSN's public key in the `X-Sentry-Auth` header and payload is the whole credential,
 * exactly as an app's SDK sends it. A 2xx only means ACCEPTED — Sentry queues events, so the caller
 * reads the event back to prove ingest.
 */
export async function sentryStore(
  ctx: Ctx,
  region: SentryRegion,
  dsn: SentryDsn,
  spec: { eventId: string; message: string; tags?: Record<string, string> },
): Promise<{ status: number; eventId?: string }> {
  const res = await ctx.http<{ id?: unknown }>({
    method: 'POST',
    url: `https://${dsn.host}/api/${encodeURIComponent(dsn.projectId)}/store/`,
    headers: {
      'X-Sentry-Auth': `Sentry sentry_version=7, sentry_client=golive/${ctx.release.version}, sentry_key=${dsn.publicKey}`,
    },
    body: {
      event_id: spec.eventId,
      message: spec.message,
      level: 'error',
      platform: 'javascript',
      tags: spec.tags ?? {},
    },
    timeoutMs: 30_000,
  });
  if (res.status < 200 || res.status >= 300) throw sentryError(res, 'send a test event', region);
  // The store endpoint answers `{ "id": "<event id>" }`; a response without one leaves the caller to
  // read back the id it sent.
  const id = res.json && typeof res.json.id === 'string' && /^[0-9a-f]{32}$/.test(res.json.id) ? res.json.id : undefined;
  return { status: res.status, ...(id ? { eventId: id } : {}) };
}

/**
 * One event by id as Sentry returns it, or null when Sentry answers "not found" — which for a
 * just-sent event means "not visible yet", never a failure by itself. Every other refusal throws.
 */
export async function sentryEventJson(ctx: Ctx, region: SentryRegion, orgSlug: string, projectId: string, eventId: string): Promise<unknown | null> {
  try {
    return await sentryCall(ctx, region, {
      path: `/api/0/projects/${encodeURIComponent(orgSlug)}/${encodeURIComponent(projectId)}/events/${encodeURIComponent(eventId)}/`,
      what: `read event ${eventId}`,
      idempotent: true,
    });
  } catch (e) {
    if (e instanceof SentryApiError && e.status === 404) return null;
    throw e;
  }
}
