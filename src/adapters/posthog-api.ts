/**
 * PostHog control-plane and capture transport.
 *
 * One credential: a personal API key (`phx_…`) in POSTHOG_API_KEY (process environment or golive's
 * credentials file), sent as `Authorization: Bearer phx_…`. Its scopes decide what works:
 * `organization:read` for GET /api/organizations/, `project:read` + `project:write` for the project
 * list/create/read/delete, `query:read` for the HogQL read-back. The APP-facing token is a different
 * thing: the project's public ingestion token (`phc_…`), which PostHog is designed to have embedded
 * in a browser bundle, read from the project object's `api_token` — public by design, never a Secret.
 *
 * Hosts follow `posthog.region` in golive.yaml (default us): the control plane is us.posthog.com or
 * eu.posthog.com, capture goes to that region's ingestion host (us.i.posthog.com / eu.i.posthog.com)
 * and carries NO authorization header — the public token in the body is the whole credential.
 *
 * Errors carry a status, a provider code and an actionable, redacted message: plan limits on a free
 * account (one project) are mapped to what the human can do about it, and scopes to which scope the
 * key needs. A 200 from the capture endpoint means accepted, NOT ingested; only the read-back says
 * whether an event arrived.
 */
import { tokenHowTo } from '../core/credentials.js';
import { HttpError } from '../core/http.js';
import { Secret, redact } from '../core/secret.js';
import type { Ctx, HttpRequest } from '../core/types.js';

export const POSTHOG_TOKEN = 'POSTHOG_API_KEY';
export type PosthogRegion = 'us' | 'eu';

const API_HOSTS: Record<PosthogRegion, string> = { us: 'https://us.posthog.com', eu: 'https://eu.posthog.com' };
const INGEST_HOSTS: Record<PosthogRegion, string> = { us: 'https://us.i.posthog.com', eu: 'https://eu.i.posthog.com' };

export const posthogApiHost = (region: PosthogRegion): string => API_HOSTS[region];
export const posthogIngestHost = (region: PosthogRegion): string => INGEST_HOSTS[region];

/** The region `golive.yaml` selects (default us); the config parser rejects anything else. */
export function regionOf(ctx: Ctx): PosthogRegion {
  return (ctx.config.posthog as { region?: unknown } | undefined)?.region === 'eu' ? 'eu' : 'us';
}

const scopesHelp = (region: PosthogRegion): string =>
  `In PostHog (${posthogApiHost(region)} → Settings → Personal API keys), check that the key has the scopes golive uses: organization:read (list organizations), project:read and project:write (list, read, create and delete projects) and query:read (read an event count back).`;

export function posthogHelp(region: PosthogRegion): string {
  return `Create a personal API key at ${posthogApiHost(region)}/settings/user-api-keys with scopes organization:read, project:read, project:write and query:read. ${tokenHowTo(POSTHOG_TOKEN)}`;
}

/** A PostHog refusal, carrying the provider's own code when it reported one. */
export class PosthogApiError extends HttpError {
  constructor(
    message: string,
    status: number,
    body: string,
    readonly code?: string,
  ) {
    super(message, status, body);
  }
}

interface PosthogErrorBody {
  type?: string;
  code?: string;
  detail?: string;
  message?: string;
  error?: string;
  attr?: string | null;
}

const detailOf = (b: PosthogErrorBody): string => b.detail ?? b.message ?? b.error ?? '';

/** PostHog's plan-limit refusals come back as 400/402/403 wording rather than a status of its own. */
const PLAN_LIMIT = /project limit|plan limit|limit.{0,20}(?:reached|exceeded|allowed)|maximum.{0,20}projects|upgrade|payment required|quota|billing/i;

/**
 * Map one refused response to an actionable, redacted message. Never echoes request bodies (the
 * capture body carries the public token; the control plane bodies carry resource names only).
 */
export function posthogError(res: { status: number; json?: unknown; text: string }, what: string, region: PosthogRegion): PosthogApiError {
  const b = (res.json && typeof res.json === 'object' ? res.json : {}) as PosthogErrorBody;
  const code = b.code ?? '';
  const detail = detailOf(b) || res.text.slice(0, 300);
  const kind = code ? ` (${code})` : b.type ? ` (${b.type})` : '';
  // A plan refusal is checked before the generic 403: PostHog answers a free account's second project
  // with a 403 whose wording (a project limit) is what tells it apart from a missing scope.
  const planLimited = PLAN_LIMIT.test(`${code} ${detail}`) && res.status !== 401;
  let hint: string;
  if (res.status === 401) {
    hint = ` The PostHog credential in ${POSTHOG_TOKEN} was rejected (invalid, expired or revoked). ${posthogHelp(region)}`;
  } else if (planLimited) {
    hint = ` PostHog's plan refused it (free plans allow one project, and plans are priced per event). Reuse the project the organization already has (set projects.monitoring to it in golive.yaml and re-run \`golive plan\`), delete one you no longer need (when golive created it, \`golive teardown\` removes it), or upgrade the plan yourself — golive never upgrades a plan or spends money.`;
  } else if (res.status === 403) {
    hint = ` The credential lacks a scope this operation needs. ${scopesHelp(region)}`;
  } else if (res.status === 404) {
    hint = ' PostHog answered "not found" for this path: the organization, project or key scope may have changed since the plan was approved. Re-run `golive plan` and re-approve.';
  } else if (res.status === 429) {
    hint = ' PostHog is rate-limiting requests; wait a moment and re-run.';
  } else if (res.status === 0) {
    hint = ` Could not reach ${posthogApiHost(region)}; check your network and re-run.`;
  } else {
    hint = '';
  }
  return new PosthogApiError(redact(`PostHog ${what} failed (HTTP ${res.status}${kind}): ${detail}${hint}`), res.status, redact(res.text.slice(0, 1000)), code);
}

export interface PosthogCall {
  method?: HttpRequest['method'];
  /** Path + optional query, e.g. "/api/organizations/". Built by this adapter, never from config. */
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
 * posthogError, which never echoes the request body or the credential. Callers read only the fields
 * they need out of the parsed answer.
 */
export async function posthogCall<T>(ctx: Ctx, region: PosthogRegion, call: PosthogCall): Promise<T> {
  const token = ctx.envToken(POSTHOG_TOKEN);
  if (!token) throw new PosthogApiError(`No PostHog credential is available. ${posthogHelp(region)}`, 0, '');
  if (!call.path.startsWith('/') || call.path.startsWith('//') || call.path.includes('://')) {
    throw new PosthogApiError('Invalid PostHog API path.', 0, '');
  }
  const res = await ctx.http<T>({
    method: call.method ?? 'GET',
    url: `${posthogApiHost(region)}${call.path}`,
    headers: { Authorization: bearer(token) },
    ...(call.body === undefined ? {} : { body: call.body }),
    ...(call.idempotent ? { idempotent: true } : {}),
  });
  if (res.status < 200 || res.status >= 300) throw posthogError(res, call.what, region);
  return res.json;
}

/** `Bearer <key>` stays a Secret: the header is revealed only at the transport boundary. */
function bearer(key: Secret): Secret {
  return new Secret(POSTHOG_TOKEN, `Bearer ${key.reveal()}`);
}

/**
 * Send one synthetic event to the project's ingestion endpoint (no authorization header — the public
 * project token in the body is the credential, exactly as an app's SDK sends it). A 2xx means the
 * endpoint ACCEPTED the event; it is not proof of ingestion, which only the read-back can show.
 */
export async function posthogCapture(
  ctx: Ctx,
  region: PosthogRegion,
  token: string,
  spec: { event: string; distinctId: string; properties?: Record<string, string> },
): Promise<{ status: number }> {
  const res = await ctx.http({
    method: 'POST',
    url: `${posthogIngestHost(region)}/i/v0/e/`,
    body: { api_key: token, event: spec.event, distinct_id: spec.distinctId, ...(spec.properties ? { properties: spec.properties } : {}) },
    timeoutMs: 30_000,
  });
  if (res.status < 200 || res.status >= 300) throw posthogError(res, 'send a test event', region);
  return { status: res.status };
}

/** A HogQL filter this adapter can build safely: fixed template, validated names, an integer window. */
export interface PosthogEventFilter {
  event: string;
  /** Only events carrying this property value (a per-run marker, so an older run's event never counts). */
  property?: { key: string; value: string };
  minutes: number;
}

const SQL_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

/**
 * How many matching events the project has recorded in the last `minutes`, read through HogQL
 * (`POST /api/projects/:id/query/`, scope query:read). 0 means "not visible yet": ingestion can lag
 * minutes, so a caller polls this and never reads 0 as a failure. Every part of the query is built
 * here from the fixed template below; the filter's names must match SQL_NAME and its values are
 * quoted with '' escaping, so no caller input reaches the query as SQL.
 */
export async function posthogCount(ctx: Ctx, region: PosthogRegion, projectId: string, filter: PosthogEventFilter): Promise<number> {
  if (!Number.isInteger(filter.minutes) || filter.minutes <= 0 || filter.minutes > 1440) throw new PosthogApiError('PostHog event count needs a window of 1–1440 minutes.', 0, '');
  const quote = (v: string): string => `'${v.replace(/'/g, "''")}'`;
  const conditions = [`event = ${quote(filter.event)}`, `timestamp > now() - interval ${filter.minutes} minute`];
  if (filter.property) {
    if (!SQL_NAME.test(filter.property.key)) throw new PosthogApiError('PostHog event count: invalid property name.', 0, '');
    conditions.push(`properties.${filter.property.key} = ${quote(filter.property.value)}`);
  }
  const query = `select count() from events where ${conditions.join(' and ')}`;
  const json = await posthogCall<{ results?: unknown }>(ctx, region, {
    method: 'POST',
    path: `/api/projects/${encodeURIComponent(projectId)}/query/`,
    body: { query: { kind: 'HogQLQuery', query }, refresh: 'force_blocking' },
    what: `read the event count for project ${projectId}`,
    idempotent: true,
  });
  const rows = json?.results;
  const count = Array.isArray(rows) && Array.isArray(rows[0]) ? Number(rows[0][0]) : NaN;
  if (!Number.isFinite(count) || count < 0) throw new PosthogApiError('PostHog returned an unexpected event count; nothing was inferred.', 0, '');
  return count;
}
