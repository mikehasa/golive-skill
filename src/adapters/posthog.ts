/**
 * PostHog (monitoring): the analytics project golive wires the app to, the project's PUBLIC ingestion
 * token, and the read-back that proves an event actually arrived.
 *
 * Three things are deliberately separate:
 *   - the personal API key (`phx_…`, POSTHOG_API_KEY) is golive's own credential: a Secret, header only;
 *   - the project token (`phc_…`) is public by design — it ships in the browser bundle — so it is read
 *     from the API as a plain value, written to the host as a non-sensitive variable and never treated
 *     as a server secret (`SECRET_KEYS`/`bundle-secrets` treat it the way the Supabase anon key is
 *     treated);
 *   - a 2xx from the capture endpoint means ACCEPTED, never ingested. Only the HogQL count read-back
 *     (which can lag minutes) says an event arrived, so the `posthog-ingest` check polls it.
 *
 * The project is a resource golive may create, so it carries a creation marker
 * (`posthog.createdProjectId`) that teardown reads before deleting anything. Project deletion at
 * PostHog is scheduled: the provider keeps the row visible with `is_pending_deletion`, which is why
 * the confirmation read (`projectState`) has three states instead of a boolean.
 */
import type { Adapter, Ctx, ProjectCreateTarget, ProjectLinker, ProjectRef } from '../core/types.js';
import { isRegisteredSecret, redact } from '../core/secret.js';
import {
  POSTHOG_TOKEN,
  PosthogApiError,
  posthogCall,
  posthogCapture,
  posthogCount,
  posthogHelp,
  regionOf,
  type PosthogEventFilter,
  type PosthogRegion,
} from './posthog-api.js';

export { POSTHOG_TOKEN, PosthogApiError, posthogIngestHost, regionOf } from './posthog-api.js';

const errMsg = (e: unknown): string => redact(e instanceof Error ? e.message : String(e));

export const PROJECT_ID_KEY = 'posthog.projectId';
export const PROJECT_NAME_KEY = 'posthog.projectName';
export const ORGANIZATION_ID_KEY = 'posthog.organizationId';
/** The creation marker (`<provider>.createdProjectId`): only a project this names is golive's to delete. */
export const CREATED_PROJECT_KEY = 'posthog.createdProjectId';

/**
 * The `posthog-ingest` read-back window. Ingestion is asynchronous and can lag minutes, so the check
 * polls the provider's own HogQL count: a short interval, a bounded window, and events counted over a
 * quarter of an hour (a clock-skew margin wider than the window itself).
 */
export const posthogTiming = { pollMs: 10_000, windowMs: 180_000, queryMinutes: 15 };

/** A selection, validation or destination problem. Provider refusals are PosthogApiError instead. */
export class PosthogError extends Error {}

const enc = encodeURIComponent;

interface Organization {
  id: string;
  name?: string;
}
interface Project {
  id: string;
  name: string;
  apiToken?: string;
  pendingDeletion: boolean;
}

function obj(v: unknown, what: string): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new PosthogError(`PostHog returned an unexpected ${what}; nothing was inferred.`);
  return v as Record<string, unknown>;
}
function text(v: unknown, what: string): string {
  if (typeof v !== 'string' || !v || v.length > 200 || /[\r\n\x00-\x1f]/.test(v) || isRegisteredSecret(v)) throw new PosthogError(`PostHog returned an invalid ${what}.`);
  return v;
}
/** PostHog project ids are integers; the API path takes the number, state may hold either form. */
function projectId(v: unknown): string {
  const s = typeof v === 'number' ? String(v) : v;
  if (typeof s !== 'string' || !/^[0-9]{1,18}$/.test(s)) throw new PosthogError('PostHog returned an invalid project id.');
  return s;
}
function organizationId(v: unknown): string {
  if (typeof v !== 'string' || !/^[A-Za-z0-9-]{1,64}$/.test(v)) throw new PosthogError('PostHog returned an invalid organization id.');
  return v;
}
/** DRF may answer a bare list or a `{ results: [...] }` page; both shapes carry the same objects. */
function rows(v: unknown, what: string): Record<string, unknown>[] {
  if (Array.isArray(v)) return v.map((x) => obj(x, what));
  const r = obj(v, what).results;
  if (r === undefined) return [];
  if (!Array.isArray(r)) throw new PosthogError(`PostHog returned an unexpected ${what} list.`);
  return r.map((x) => obj(x, what));
}
function organizationOf(v: unknown): Organization {
  const o = obj(v, 'organization');
  return { id: organizationId(o.id), ...(typeof o.name === 'string' && o.name ? { name: text(o.name, 'organization name') } : {}) };
}
function projectOf(v: unknown, orgId: string): Project {
  const p = obj(v, 'project');
  const id = projectId(p.id);
  const name = text(p.name, 'project name');
  if (p.organization !== undefined && p.organization !== null && p.organization !== orgId) {
    throw new PosthogError('A PostHog project outside the selected organization was returned; refusing to use it.');
  }
  const maybeToken = p.api_token;
  const apiToken = typeof maybeToken === 'string' && maybeToken ? text(maybeToken, 'project token') : undefined;
  return { id, name, ...(apiToken ? { apiToken } : {}), pendingDeletion: p.is_pending_deletion === true };
}
function refOf(p: Project, org: Organization): ProjectRef {
  return { id: p.id, name: p.name, scope: { kind: 'organization', id: org.id, ...(org.name ? { name: org.name } : {}) } };
}
const sameTarget = (a: ProjectCreateTarget, b: ProjectCreateTarget): boolean => a.scope.kind === b.scope.kind && a.scope.id === b.scope.id && a.region === b.region;

// ── Reads ────────────────────────────────────────────────────────────────────────────────────────

async function organizations(ctx: Ctx, region: PosthogRegion): Promise<Organization[]> {
  return rows(await posthogCall(ctx, region, { path: '/api/organizations/', what: 'list organizations' }), 'organization').map(organizationOf);
}

/**
 * The one organization this key works in: what state recorded, else the only organization the key can
 * see. A key that sees several is refused — picking one would wire the app's analytics into an account
 * nobody approved.
 */
async function organizationFor(ctx: Ctx, region: PosthogRegion): Promise<Organization> {
  const recorded = ctx.state.resource(ORGANIZATION_ID_KEY);
  const all = await organizations(ctx, region);
  if (recorded) {
    const known = all.find((o) => o.id === recorded);
    if (known) return known;
    throw new PosthogError(`The recorded PostHog organization ${recorded} is no longer visible to the ${POSTHOG_TOKEN} key; re-plan after checking the key's organization scope.`);
  }
  if (all.length === 1) return all[0]!;
  if (!all.length) throw new PosthogError(`The ${POSTHOG_TOKEN} key can see no PostHog organization. ${posthogHelp(region)}`);
  throw new PosthogError(
    `The ${POSTHOG_TOKEN} key can see ${all.length} PostHog organizations (${all.map((o) => o.name ?? o.id).join(', ')}). Scope the key to one organization (Personal API keys → scope: organization) so golive can name the account it wires, then re-run.`,
  );
}

async function allProjects(ctx: Ctx, region: PosthogRegion, orgId: string): Promise<Project[]> {
  const list = rows(await posthogCall(ctx, region, { path: `/api/organizations/${enc(orgId)}/projects/`, what: 'list projects' }), 'project').map((p) => projectOf(p, orgId));
  return list.filter((p) => {
    if (!p.pendingDeletion) return true;
    ctx.log.info(`posthog: project ${p.name} (${p.id}) is pending deletion; leaving it out`);
    return false;
  });
}

/** One exact project by id; null when the provider itself answers "not found". */
async function projectById(ctx: Ctx, region: PosthogRegion, orgId: string, id: string): Promise<Project | null> {
  try {
    return projectOf(await posthogCall(ctx, region, { path: `/api/organizations/${enc(orgId)}/projects/${enc(id)}/`, what: `read project ${id}` }), orgId);
  } catch (e) {
    if (e instanceof PosthogApiError && e.status === 404) return null;
    throw e;
  }
}

async function exact(ctx: Ctx, region: PosthogRegion, org: Organization, id: string): Promise<Project> {
  const p = await projectById(ctx, region, org.id, id);
  if (!p) throw new PosthogError(`PostHog no longer has project ${id} in organization ${org.name ?? org.id}; re-plan.`);
  return p;
}

/**
 * The provider's own state of one project, for a caller confirming a deletion: `gone` when the read
 * answers "not found", `pending` while the provider reports the scheduled deletion it accepted, and
 * `present` otherwise. Never invented from an absent answer — a read that cannot be answered throws.
 */
export async function posthogProjectState(ctx: Ctx, id: string): Promise<'present' | 'gone' | 'pending'> {
  const region = regionOf(ctx);
  return stateOf(ctx, region, await organizationFor(ctx, region), id);
}

async function stateOf(ctx: Ctx, region: PosthogRegion, org: Organization, id: string): Promise<'present' | 'gone' | 'pending'> {
  const p = await projectById(ctx, region, org.id, id);
  if (!p) return 'gone';
  return p.pendingDeletion ? 'pending' : 'present';
}

async function resolve(ctx: Ctx, selected: string): Promise<ProjectRef> {
  const region = regionOf(ctx);
  const org = await organizationFor(ctx, region);
  const list = await allProjects(ctx, region, org.id);
  const byId = list.filter((p) => p.id === selected);
  const matches = byId.length ? byId : list.filter((p) => p.name === selected);
  if (matches.length !== 1) {
    const found = matches.length ? `${matches.length} project${matches.length === 1 ? '' : 's'}` : 'no project';
    throw new PosthogError(
      `PostHog has ${found} matching "${selected}" in organization ${org.name ?? org.id}; set projects.monitoring to one exact project id or name (an ambiguous or missing selection is never guessed).`,
    );
  }
  return refOf(await exact(ctx, region, org, matches[0]!.id), org);
}

async function current(ctx: Ctx): Promise<ProjectRef | null> {
  const chosen = ctx.config.projects?.monitoring ?? ctx.state.resource(PROJECT_ID_KEY);
  return chosen ? resolve(ctx, chosen) : null;
}

async function candidates(ctx: Ctx): Promise<ProjectRef[]> {
  const region = regionOf(ctx);
  const org = await organizationFor(ctx, region);
  return (await allProjects(ctx, region, org.id)).map((p) => refOf(p, org));
}

async function creationTarget(ctx: Ctx): Promise<ProjectCreateTarget> {
  const org = await organizationFor(ctx, regionOf(ctx));
  return { scope: { kind: 'organization', id: org.id, ...(org.name ? { name: org.name } : {}) } };
}

// ── Writes (only ever called from an approved step) ──────────────────────────────────────────────

function remember(ctx: Ctx, p: ProjectRef, opts: { created?: boolean } = {}): void {
  ctx.state.save((s) => {
    s.resources[PROJECT_ID_KEY] = p.id;
    s.resources[PROJECT_NAME_KEY] = p.name;
    s.resources[ORGANIZATION_ID_KEY] = p.scope!.id;
    // The creation marker never survives a switch to another project: teardown reads it as proof that
    // THIS id is golive's to delete.
    if (opts.created) s.resources[CREATED_PROJECT_KEY] = p.id;
    else if (s.resources[CREATED_PROJECT_KEY] !== p.id) delete s.resources[CREATED_PROJECT_KEY];
  });
}

async function create(ctx: Ctx, name: string, approved?: ProjectCreateTarget): Promise<ProjectRef> {
  const region = regionOf(ctx);
  const target = await creationTarget(ctx);
  if (!approved || !sameTarget(target, approved)) throw new PosthogError('PostHog project creation destination changed after approval; re-plan. Nothing was created.');
  if (!name || name.length > 200 || /[\r\n\x00-\x1f]/.test(name)) throw new PosthogError('Invalid PostHog project name.');
  const org = await organizationFor(ctx, region);
  // A previous attempt's project (recorded as golive's own, under this name) is re-read and reused
  // rather than created twice: the API is deliberately not retried after an ambiguous failure.
  const prior = ctx.state.resource(CREATED_PROJECT_KEY);
  if (prior && ctx.state.resource(PROJECT_NAME_KEY) === name) {
    const p = await projectById(ctx, region, org.id, prior);
    if (p && !p.pendingDeletion) {
      if (p.name !== name) throw new PosthogError('The recorded PostHog project no longer carries this name; inspect it before re-planning.');
      return refOf(p, org);
    }
  }
  if ((await allProjects(ctx, region, org.id)).some((p) => p.name.toLowerCase() === name.toLowerCase())) {
    throw new PosthogError(`A PostHog project named ${name} already exists in this organization. Re-plan and approve adopting it; no duplicate was created.`);
  }
  const made = projectOf(await posthogCall(ctx, region, { method: 'POST', path: `/api/organizations/${enc(org.id)}/projects/`, body: { name }, what: `create project ${name}` }), org.id);
  const confirmed = await exact(ctx, region, org, made.id);
  if (confirmed.name !== name) {
    throw new PosthogError('PostHog created-project destination could not be confirmed. Inspect the organization and re-plan; nothing was linked.');
  }
  const ref = refOf(confirmed, org);
  remember(ctx, ref, { created: true });
  ctx.log.info(`created PostHog project ${confirmed.name} (${confirmed.id}) in organization ${org.name ?? org.id}`);
  return ref;
}

async function remove(ctx: Ctx): Promise<{ removed: boolean; reason?: string }> {
  const region = regionOf(ctx);
  const id = ctx.state.resource(PROJECT_ID_KEY);
  if (!id) return { removed: false, reason: 'no PostHog project is linked in state' };
  if (ctx.state.resource(CREATED_PROJECT_KEY) !== id) return { removed: false, reason: 'the PostHog project was adopted or selected, not created by golive' };
  const org = await organizationFor(ctx, region);
  try {
    await posthogCall(ctx, region, { method: 'DELETE', path: `/api/organizations/${enc(org.id)}/projects/${enc(id)}/`, what: `delete project ${id}` });
  } catch (e) {
    if (!(e instanceof PosthogApiError) || e.status !== 404) throw e; // already gone: the outcome teardown asked for
  }
  // PostHog schedules a deletion instead of applying it at once: the provider's own read decides.
  const state = await stateOf(ctx, region, org, id);
  if (state === 'present') return { removed: false, reason: 'PostHog still reports the project as live' };
  ctx.state.save((s) => {
    delete s.resources[PROJECT_ID_KEY];
    delete s.resources[PROJECT_NAME_KEY];
    delete s.resources[CREATED_PROJECT_KEY];
  });
  ctx.log.info(`posthog: deleted project ${id}${state === 'pending' ? ' (the provider scheduled the deletion)' : ''}`);
  return { removed: true };
}

// ── The app-facing surface (non-contract extension) ──────────────────────────────────────────────
//
// Beyond the shared contracts, the analytics link and the `posthog-ingest` check need exactly this:
// the project's public token, one synthetic capture, the read-back count, and the state a teardown
// confirmation reads. It is an optional member on the adapter's capabilities object (like
// `OutputsProvider.provides`), not a new global capability: only a capture-and-read-back provider has
// anything to implement here.

export interface AnalyticsProvider {
  /** The PUBLIC project token the app initializes its SDK with (`phc_…`): read, never a Secret. */
  token(ctx: Ctx, projectId: string): Promise<string>;
  /** Send one synthetic event (no authorization header, exactly like an app's SDK). 2xx = accepted. */
  capture(ctx: Ctx, projectId: string, spec: { event: string; distinctId: string; properties?: Record<string, string> }): Promise<{ status: number }>;
  /** How many matching events the provider has recorded; 0 = not visible yet, never a failure by itself. */
  count(ctx: Ctx, projectId: string, filter: PosthogEventFilter): Promise<number>;
  /** `present` | `gone` | `pending` (a deletion the provider scheduled) for a teardown confirmation. */
  projectState?(ctx: Ctx, projectId: string): Promise<'present' | 'gone' | 'pending'>;
}

/** The analytics surface of `adapter`, when it exposes one. */
export function analyticsOf(adapter: Adapter): AnalyticsProvider | undefined {
  return (adapter.capabilities as { analytics?: AnalyticsProvider }).analytics;
}

async function readToken(ctx: Ctx, projectIdValue: string): Promise<string> {
  const region = regionOf(ctx);
  const org = await organizationFor(ctx, region);
  const id = projectId(projectIdValue);
  const p = await exact(ctx, region, org, id);
  if (!p.apiToken) {
    throw new PosthogError(`PostHog returned no ingestion token for project ${id}. Read the project's token in the PostHog dashboard (Project settings → Project API key) before wiring the app.`);
  }
  return p.apiToken;
}

const analytics: AnalyticsProvider = {
  token: readToken,
  // The capture body carries the PUBLIC project token, exactly as the app's SDK sends it, so the
  // caller names the project and the adapter reads the token it stands for.
  capture: async (ctx, projectIdValue, spec) => posthogCapture(ctx, regionOf(ctx), await readToken(ctx, projectIdValue), spec),
  count: (ctx, projectIdValue, filter) => posthogCount(ctx, regionOf(ctx), projectIdValue, filter),
  projectState: (ctx, projectIdValue) => posthogProjectState(ctx, projectIdValue),
};

/** The ProjectLinker surface, plus the analytics extension in one object literal. */
const project: ProjectLinker = {
  current,
  candidates,
  resolve,
  creationTarget,
  select: async (ctx, idOrName) => {
    const p = await resolve(ctx, idOrName);
    remember(ctx, p);
    return p;
  },
  create,
  remove,
};

async function auth(ctx: Ctx): Promise<{ ok: boolean; via?: string; howToFix?: string }> {
  const region = regionOf(ctx);
  if (!ctx.envToken(POSTHOG_TOKEN)) return { ok: false, howToFix: posthogHelp(region) };
  try {
    const orgs = await organizations(ctx, region);
    if (!orgs.length) {
      return { ok: false, howToFix: `The ${POSTHOG_TOKEN} key is valid but can see no PostHog organization: its organization scope may exclude everything this account has. ${posthogHelp(region)}` };
    }
    if (orgs.length > 1) {
      return {
        ok: false,
        howToFix: `${POSTHOG_TOKEN} is valid, but golive needs a key scoped to exactly one PostHog organization (it can see ${orgs.length}: ${orgs.map((o) => o.name ?? o.id).join(', ')}). Scope the personal API key to one organization, then re-run plan. ${posthogHelp(region)}`,
      };
    }
    return { ok: true, via: `${POSTHOG_TOKEN} env (${region}, ${orgs[0]!.name ?? orgs[0]!.id})` };
  } catch (e) {
    const msg = errMsg(e);
    return { ok: false, howToFix: /scope|permission|organization:read/i.test(msg) ? `${msg} ${scopesHint(region)}` : msg };
  }
}

const scopesHint = (region: PosthogRegion): string =>
  `Check the key's scopes in PostHog (${region === 'eu' ? 'eu' : 'us'}.posthog.com → Settings → Personal API keys): organization:read, project:read, project:write, query:read.`;

export const posthogAdapter: Adapter = {
  id: 'posthog',
  title: 'PostHog',
  axes: ['monitoring'],
  automated: true,
  detect: (d) => (d.providers.monitoring ?? []).includes('posthog'),
  auth,
  capabilities: { project, analytics } as Adapter['capabilities'],
};
