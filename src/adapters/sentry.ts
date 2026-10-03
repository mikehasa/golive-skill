/**
 * Sentry (monitoring): the error-tracking project golive wires the app to, the project's PUBLIC DSN,
 * and the read-back that proves an event actually arrived.
 *
 * Three things are deliberately separate:
 *   - the auth token (`SENTRY_AUTH_TOKEN`) is golive's own credential: a Secret, header only;
 *   - the DSN (`https://<public key>@o<org>.ingest.<region>.sentry.io/<project id>`) is public by
 *     design — it ships in the browser bundle — so it is read from the API as a plain value, written
 *     to the host as a non-sensitive variable and never treated as a server secret (`SECRET_KEYS` and
 *     `bundle-secrets` treat it the way the Supabase anon key is treated);
 *   - a 2xx from the Store endpoint means ACCEPTED, never ingested. Only Sentry's own event read
 *     says an event arrived, so the `sentry-ingest` check polls that read by event id.
 *
 * The organization is the single one the token can see: a token that can see several is refused
 * rather than guessed (mirroring PostHog). Creation needs a team: the organization's only team is
 * used, else `sentry.team` from golive.yaml names one, else nothing is created and the plan carries a
 * handoff with the teams and the fix. The project is a resource golive may create, so it carries a
 * creation marker (`sentry.createdProjectId`) that teardown reads before deleting anything; the
 * delete needs the `project:admin` scope, and Sentry deletes asynchronously, which is why the
 * confirmation read (`projectState`) has three states instead of a boolean.
 */
import type { Adapter, Ctx, ProjectCreateTarget, ProjectLinker, ProjectRef } from '../core/types.js';
import { isRegisteredSecret, redact } from '../core/secret.js';
import {
  SENTRY_TOKEN,
  SentryApiError,
  parseDsn,
  regionOf,
  sentryCall,
  sentryEventJson,
  sentryHelp,
  sentryStore,
  type SentryRegion,
} from './sentry-api.js';

export { SENTRY_TOKEN, SentryApiError, sentryApiHost, regionOf } from './sentry-api.js';

const errMsg = (e: unknown): string => redact(e instanceof Error ? e.message : String(e));

export const PROJECT_ID_KEY = 'sentry.projectId';
export const PROJECT_SLUG_KEY = 'sentry.projectSlug';
export const PROJECT_NAME_KEY = 'sentry.projectName';
export const ORGANIZATION_ID_KEY = 'sentry.organizationId';
export const ORGANIZATION_SLUG_KEY = 'sentry.organizationSlug';
/** The creation marker (`<provider>.createdProjectId`): only a project this names is golive's to delete. */
export const CREATED_PROJECT_KEY = 'sentry.createdProjectId';

/**
 * The `sentry-ingest` read-back window. Error ingest and issue indexing can lag, so the check polls
 * Sentry's own event read: a short interval and a bounded window.
 */
export const sentryTiming = { pollMs: 10_000, windowMs: 180_000 };

/** A selection, validation or destination problem. Provider refusals are SentryApiError instead. */
export class SentryError extends Error {}

/** A team as a handoff can name it: the provider's slug plus its display name when it reported one. */
export interface TeamChoice {
  slug: string;
  name?: string;
}

/**
 * Creation needs a team and the choice is ambiguous: several teams exist and golive.yaml names none
 * (or names one that is gone). The link turns this into a handoff naming the teams, never a guess.
 */
export class SentryTeamChoiceError extends SentryError {
  constructor(
    message: string,
    readonly teams: TeamChoice[],
  ) {
    super(message);
  }
}

const enc = encodeURIComponent;

interface Organization {
  id: string;
  slug: string;
  name?: string;
}
interface Team {
  id?: string;
  slug: string;
  name?: string;
}
interface Project {
  id: string;
  slug: string;
  name: string;
  status: string;
  team?: Team;
}

function obj(v: unknown, what: string): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new SentryError(`Sentry returned an unexpected ${what}; nothing was inferred.`);
  return v as Record<string, unknown>;
}
function text(v: unknown, what: string): string {
  if (typeof v !== 'string' || !v || v.length > 200 || /[\r\n\x00-\x1f]/.test(v) || isRegisteredSecret(v)) throw new SentryError(`Sentry returned an invalid ${what}.`);
  return v;
}
/** Sentry resource ids are integers; the API path takes the number, state may hold either form. */
function numericId(v: unknown, what: string): string {
  const s = typeof v === 'number' ? String(v) : v;
  if (typeof s !== 'string' || !/^[0-9]{1,20}$/.test(s)) throw new SentryError(`Sentry returned an invalid ${what} id.`);
  return s;
}
/** Sentry slugs (organizations, teams, projects): letters, digits, dashes and underscores. */
function slug(v: unknown, what: string): string {
  if (typeof v !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(v)) throw new SentryError(`Sentry returned an invalid ${what} slug.`);
  return v;
}
/** Sentry list endpoints answer a bare array. */
function rows(v: unknown, what: string): Record<string, unknown>[] {
  if (!Array.isArray(v)) throw new SentryError(`Sentry returned an unexpected ${what} list; nothing was inferred.`);
  return v.map((x) => obj(x, what));
}
function organizationOf(v: unknown): Organization {
  const o = obj(v, 'organization');
  return {
    id: numericId(o.id, 'organization'),
    slug: slug(o.slug, 'organization'),
    ...(typeof o.name === 'string' && o.name ? { name: text(o.name, 'organization name') } : {}),
  };
}
function teamOf(v: unknown): Team {
  const t = obj(v, 'team');
  return { slug: slug(t.slug, 'team'), ...(t.id !== undefined ? { id: numericId(t.id, 'team') } : {}), ...(typeof t.name === 'string' && t.name ? { name: text(t.name, 'team name') } : {}) };
}
function projectOf(v: unknown): Project {
  const p = obj(v, 'project');
  return {
    id: numericId(p.id, 'project'),
    slug: slug(p.slug, 'project'),
    name: text(p.name, 'project name'),
    status: typeof p.status === 'string' ? p.status : '',
    ...(p.team !== undefined && p.team !== null ? { team: teamOf(p.team) } : {}),
  };
}
function refOf(p: Project, org: Organization): ProjectRef {
  return { id: p.id, name: p.name, scope: { kind: 'organization', id: org.id, ...(org.name ? { name: org.name } : {}) } };
}
const sameTarget = (a: ProjectCreateTarget, b: ProjectCreateTarget): boolean => a.scope.kind === b.scope.kind && a.scope.id === b.scope.id && a.region === b.region && a.team === b.team;
/** A project Sentry itself reports as scheduled for deletion is not something golive adopts. */
const scheduledForDeletion = (status: string): boolean => status === 'pending_deletion' || status === 'deletion_in_progress';

// ── Reads ────────────────────────────────────────────────────────────────────────────────────────

async function organizations(ctx: Ctx, region: SentryRegion): Promise<Organization[]> {
  return rows(await sentryCall(ctx, region, { path: '/api/0/organizations/', what: 'list organizations' }), 'organization').map(organizationOf);
}

/**
 * The one organization this token works in: what state recorded, else the only organization the token
 * can see. A token that sees several is refused — picking one would wire the app's error reporting
 * into an account nobody approved.
 */
async function organizationFor(ctx: Ctx, region: SentryRegion): Promise<Organization> {
  const recorded = ctx.state.resource(ORGANIZATION_SLUG_KEY);
  const all = await organizations(ctx, region);
  if (recorded) {
    const known = all.find((o) => o.slug === recorded);
    if (known) return known;
    throw new SentryError(`The recorded Sentry organization ${recorded} is no longer visible to the ${SENTRY_TOKEN} token; re-plan after checking the token's organization scope.`);
  }
  if (all.length === 1) return all[0]!;
  if (!all.length) throw new SentryError(`The ${SENTRY_TOKEN} token can see no Sentry organization. ${sentryHelp(region)}`);
  throw new SentryError(
    `The ${SENTRY_TOKEN} token can see ${all.length} Sentry organizations (${all.map((o) => o.name ?? o.slug).join(', ')}). golive needs a token scoped to exactly one organization: create an auth token (or internal integration) for the organization that owns this app, then re-run.`,
  );
}

async function teamsOf(ctx: Ctx, region: SentryRegion, org: Organization): Promise<Team[]> {
  const list = rows(await sentryCall(ctx, region, { path: `/api/0/organizations/${enc(org.slug)}/teams/`, what: `list the teams of organization ${org.name ?? org.slug}` }), 'team').map(teamOf);
  return list.sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
}

/**
 * The team creation would use. Exactly one team → it; several → `sentry.team` from golive.yaml must
 * name one; anything else throws SentryTeamChoiceError, which the link turns into a handoff naming
 * the teams. Never guesses.
 */
async function teamFor(ctx: Ctx, region: SentryRegion, org: Organization): Promise<Team> {
  const teams = await teamsOf(ctx, region, org);
  const configured = (ctx.config.sentry as { team?: string } | undefined)?.team;
  const listed = teams.map((t) => t.slug);
  if (configured) {
    const match = teams.find((t) => t.slug.toLowerCase() === configured.toLowerCase() || (t.name ?? '').toLowerCase() === configured.toLowerCase());
    if (!match) {
      throw new SentryTeamChoiceError(
        `golive.yaml sentry.team is "${configured}", but organization ${org.name ?? org.slug} has ${listed.length ? `no such team (it has ${listed.join(', ')})` : 'no teams'}.`,
        teams,
      );
    }
    return match;
  }
  if (teams.length === 1) return teams[0]!;
  if (!teams.length) {
    throw new SentryTeamChoiceError(`Sentry organization ${org.name ?? org.slug} has no team to create the project in.`, teams);
  }
  throw new SentryTeamChoiceError(`Sentry organization ${org.name ?? org.slug} has ${teams.length} teams (${listed.join(', ')}), so golive will not guess which one the project belongs to.`, teams);
}

async function allProjects(ctx: Ctx, region: SentryRegion, org: Organization): Promise<Project[]> {
  const list = rows(await sentryCall(ctx, region, { path: `/api/0/organizations/${enc(org.slug)}/projects/`, what: 'list projects' }), 'project').map(projectOf);
  return list.filter((p) => {
    if (!scheduledForDeletion(p.status)) return true;
    ctx.log.info(`sentry: project ${p.name} (${p.slug}) is ${p.status}; leaving it out`);
    return false;
  });
}

/** One exact project by id or slug; null when the provider itself answers "not found". */
async function projectById(ctx: Ctx, region: SentryRegion, org: Organization, idOrSlug: string): Promise<Project | null> {
  try {
    return projectOf(await sentryCall(ctx, region, { path: `/api/0/projects/${enc(org.slug)}/${enc(idOrSlug)}/`, what: `read project ${idOrSlug}` }));
  } catch (e) {
    if (e instanceof SentryApiError && e.status === 404) return null;
    throw e;
  }
}

async function exact(ctx: Ctx, region: SentryRegion, org: Organization, idOrSlug: string): Promise<Project> {
  const p = await projectById(ctx, region, org, idOrSlug);
  if (!p) throw new SentryError(`Sentry no longer has project ${idOrSlug} in organization ${org.name ?? org.slug}; re-plan.`);
  return p;
}

/**
 * The provider's own state of one project, for a caller confirming a deletion: `gone` when the read
 * answers "not found", `pending` while the provider reports the asynchronous deletion it accepted,
 * and `present` otherwise. Never invented from an absent answer — a read that cannot be answered
 * throws.
 */
export async function sentryProjectState(ctx: Ctx, idOrSlug: string): Promise<'present' | 'gone' | 'pending'> {
  const region = regionOf(ctx);
  return stateOf(ctx, region, await organizationFor(ctx, region), idOrSlug);
}

async function stateOf(ctx: Ctx, region: SentryRegion, org: Organization, idOrSlug: string): Promise<'present' | 'gone' | 'pending'> {
  const p = await projectById(ctx, region, org, idOrSlug);
  if (!p) return 'gone';
  return scheduledForDeletion(p.status) ? 'pending' : 'present';
}

async function resolve(ctx: Ctx, selected: string): Promise<ProjectRef> {
  const region = regionOf(ctx);
  const org = await organizationFor(ctx, region);
  const list = await allProjects(ctx, region, org);
  const byId = list.filter((p) => p.id === selected);
  const needle = selected.toLowerCase();
  const matches = byId.length ? byId : list.filter((p) => p.slug.toLowerCase() === needle || p.name.toLowerCase() === needle);
  if (matches.length !== 1) {
    const found = matches.length ? `${matches.length} project${matches.length === 1 ? '' : 's'}` : 'no project';
    throw new SentryError(
      `Sentry has ${found} matching "${selected}" in organization ${org.name ?? org.slug}; set projects.monitoring to one exact project id, slug or name (an ambiguous or missing selection is never guessed).`,
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
  return (await allProjects(ctx, region, org)).map((p) => refOf(p, org));
}

async function creationTarget(ctx: Ctx): Promise<ProjectCreateTarget> {
  const region = regionOf(ctx);
  const org = await organizationFor(ctx, region);
  const team = await teamFor(ctx, region, org);
  return { scope: { kind: 'organization', id: org.id, ...(org.name ? { name: org.name } : {}) }, region, team: team.slug };
}

// ── Writes (only ever called from an approved step) ──────────────────────────────────────────────

function remember(ctx: Ctx, p: Project, org: Organization, opts: { created?: boolean } = {}): void {
  ctx.state.save((s) => {
    s.resources[PROJECT_ID_KEY] = p.id;
    s.resources[PROJECT_SLUG_KEY] = p.slug;
    s.resources[PROJECT_NAME_KEY] = p.name;
    s.resources[ORGANIZATION_ID_KEY] = org.id;
    s.resources[ORGANIZATION_SLUG_KEY] = org.slug;
    // The creation marker never survives a switch to another project: teardown reads it as proof that
    // THIS id is golive's to delete.
    if (opts.created) s.resources[CREATED_PROJECT_KEY] = p.id;
    else if (s.resources[CREATED_PROJECT_KEY] !== p.id) delete s.resources[CREATED_PROJECT_KEY];
  });
}

async function create(ctx: Ctx, name: string, approved?: ProjectCreateTarget): Promise<ProjectRef> {
  const region = regionOf(ctx);
  const target = await creationTarget(ctx);
  if (!approved || !sameTarget(target, approved)) throw new SentryError('Sentry project creation destination changed after approval; re-plan. Nothing was created.');
  if (!name || name.length > 200 || /[\r\n\x00-\x1f]/.test(name)) throw new SentryError('Invalid Sentry project name.');
  const org = await organizationFor(ctx, region);
  // A previous attempt's project (recorded as golive's own, under this name) is re-read and reused
  // rather than created twice: the API is deliberately not retried after an ambiguous failure.
  const prior = ctx.state.resource(CREATED_PROJECT_KEY);
  if (prior && ctx.state.resource(PROJECT_NAME_KEY) === name) {
    const p = await projectById(ctx, region, org, prior);
    if (p && !scheduledForDeletion(p.status)) {
      if (p.name !== name) throw new SentryError('The recorded Sentry project no longer carries this name; inspect it before re-planning.');
      return refOf(p, org);
    }
  }
  if ((await allProjects(ctx, region, org)).some((p) => p.name.toLowerCase() === name.toLowerCase())) {
    throw new SentryError(`A Sentry project named ${name} already exists in this organization. Re-plan and approve adopting it; no duplicate was created.`);
  }
  const made = projectOf(
    await sentryCall(ctx, region, {
      method: 'POST',
      path: `/api/0/teams/${enc(org.slug)}/${enc(target.team!)}/projects/`,
      body: { name },
      what: `create project ${name}`,
    }),
  );
  const confirmed = await exact(ctx, region, org, made.id);
  if (confirmed.name !== name) {
    throw new SentryError('Sentry created-project destination could not be confirmed. Inspect the organization and re-plan; nothing was linked.');
  }
  if (target.team && confirmed.team && confirmed.team.slug !== target.team) {
    throw new SentryError(`Sentry created the project in team ${confirmed.team.slug}, not the approved ${target.team}; inspect it and re-plan before linking anything.`);
  }
  const ref = refOf(confirmed, org);
  remember(ctx, confirmed, org, { created: true });
  ctx.log.info(`created Sentry project ${confirmed.name} (${confirmed.slug}) in organization ${org.name ?? org.slug}`);
  return ref;
}

async function remove(ctx: Ctx): Promise<{ removed: boolean; reason?: string }> {
  const region = regionOf(ctx);
  const id = ctx.state.resource(PROJECT_ID_KEY);
  if (!id) return { removed: false, reason: 'no Sentry project is linked in state' };
  if (ctx.state.resource(CREATED_PROJECT_KEY) !== id) return { removed: false, reason: 'the Sentry project was adopted or selected, not created by golive' };
  const org = await organizationFor(ctx, region);
  try {
    await sentryCall(ctx, region, { method: 'DELETE', path: `/api/0/projects/${enc(org.slug)}/${enc(id)}/`, what: `delete project ${id}` });
  } catch (e) {
    if (!(e instanceof SentryApiError) || e.status !== 404) throw e; // already gone: the outcome teardown asked for
  }
  // Sentry schedules the deletion instead of applying it at once: the provider's own read decides.
  const state = await stateOf(ctx, region, org, id);
  if (state === 'present') return { removed: false, reason: 'Sentry still reports the project as live' };
  ctx.state.save((s) => {
    delete s.resources[PROJECT_ID_KEY];
    delete s.resources[PROJECT_SLUG_KEY];
    delete s.resources[PROJECT_NAME_KEY];
    delete s.resources[CREATED_PROJECT_KEY];
  });
  ctx.log.info(`sentry: deleted project ${id}${state === 'pending' ? ' (the provider scheduled the deletion)' : ''}`);
  return { removed: true };
}

// ── The app-facing surface (non-contract extension) ──────────────────────────────────────────────
//
// Beyond the shared contracts, the sentry link and the `sentry-ingest` check need exactly this: the
// project's public DSN, one synthetic store call, the event read that proves it arrived, and the
// state a teardown confirmation reads. It is an optional member on the adapter's capabilities object
// (like `OutputsProvider.provides`), not a new global capability: only a store-and-read-back provider
// has anything to implement here.

export interface MonitoringProvider {
  /** The project's PUBLIC DSN the app initializes its SDK with: read, never a Secret. */
  dsn(ctx: Ctx, projectId: string): Promise<string>;
  /** Send one synthetic event through the DSN's Store endpoint (no auth token, like an app's SDK). */
  capture(ctx: Ctx, projectId: string, spec: { eventId: string; message: string; tags?: Record<string, string> }): Promise<{ status: number; eventId?: string }>;
  /**
   * Whether Sentry can already return this exact event: `seen` only when the event carries `marker`,
   * `seen-without-marker` when the id reads back but the marker is not in it, `pending` while the
   * provider answers "not found" (not visible yet, never a failure by itself).
   */
  readEvent(ctx: Ctx, projectId: string, eventId: string, marker: string): Promise<'pending' | 'seen' | 'seen-without-marker'>;
  /** `present` | `gone` | `pending` (a deletion the provider scheduled) for a teardown confirmation. */
  projectState?(ctx: Ctx, projectId: string): Promise<'present' | 'gone' | 'pending'>;
}

/** The store/read-back surface of `adapter`, when it exposes one. */
export function monitoringOf(adapter: Adapter): MonitoringProvider | undefined {
  return (adapter.capabilities as { monitoring?: MonitoringProvider }).monitoring;
}

async function readDsn(ctx: Ctx, projectIdValue: string): Promise<string> {
  const region = regionOf(ctx);
  const org = await organizationFor(ctx, region);
  const id = numericId(projectIdValue, 'project');
  const p = await exact(ctx, region, org, id);
  const keys = rows(await sentryCall(ctx, region, { path: `/api/0/projects/${enc(org.slug)}/${enc(p.id)}/keys/`, what: `read the client keys of project ${p.name}` }), 'client key');
  const usable = keys
    .map((k) => {
      const dsn = k.dsn && typeof k.dsn === 'object' && !Array.isArray(k.dsn) ? (k.dsn as Record<string, unknown>).public : undefined;
      return { active: k.isActive !== false, dsn: typeof dsn === 'string' ? dsn : '' };
    })
    .filter((k) => k.active && k.dsn);
  const raw = usable.length ? usable[0]!.dsn : '';
  if (!raw) {
    throw new SentryError(`Sentry returned no active client key/DSN for project ${id}. Read the project's DSN in Sentry (Project Settings → Client Keys (DSN)) before wiring the app.`);
  }
  const parsed = parseDsn(raw);
  if (parsed.projectId !== p.id) throw new SentryError('Sentry returned a DSN for a different project; nothing was wired.');
  return raw;
}

const monitoring: MonitoringProvider = {
  dsn: readDsn,
  // The Store request carries the PUBLIC DSN key in its payload, exactly as the app's SDK sends it,
  // so the caller names the project and the adapter reads the DSN it stands for.
  capture: async (ctx, projectIdValue, spec) => sentryStore(ctx, regionOf(ctx), parseDsn(await readDsn(ctx, projectIdValue)), spec),
  readEvent: async (ctx, projectIdValue, eventId, marker) => {
    const region = regionOf(ctx);
    const org = await organizationFor(ctx, region);
    const json = await sentryEventJson(ctx, region, org.slug, numericId(projectIdValue, 'project'), eventId);
    if (json === null) return 'pending';
    return JSON.stringify(json).includes(marker) ? 'seen' : 'seen-without-marker';
  },
  projectState: (ctx, projectIdValue) => sentryProjectState(ctx, projectIdValue),
};

/** The ProjectLinker surface, plus the monitoring extension in one object literal. */
const project: ProjectLinker = {
  current,
  candidates,
  resolve,
  creationTarget,
  select: async (ctx, idOrName) => {
    const p = await resolve(ctx, idOrName);
    const region = regionOf(ctx);
    const org = await organizationFor(ctx, region);
    remember(ctx, await exact(ctx, region, org, p.id), org);
    return p;
  },
  create,
  remove,
};

async function auth(ctx: Ctx): Promise<{ ok: boolean; via?: string; howToFix?: string }> {
  const region = regionOf(ctx);
  if (!ctx.envToken(SENTRY_TOKEN)) return { ok: false, howToFix: sentryHelp(region) };
  try {
    const orgs = await organizations(ctx, region);
    if (!orgs.length) {
      return { ok: false, howToFix: `The ${SENTRY_TOKEN} token is valid but can see no Sentry organization: its scopes may exclude everything this account has. ${sentryHelp(region)}` };
    }
    if (orgs.length > 1) {
      return {
        ok: false,
        howToFix: `${SENTRY_TOKEN} is valid, but golive needs a token scoped to exactly one Sentry organization (it can see ${orgs.length}: ${orgs.map((o) => o.name ?? o.slug).join(', ')}). Create an auth token (or internal integration) for one organization, then re-run plan. ${sentryHelp(region)}`,
      };
    }
    return { ok: true, via: `${SENTRY_TOKEN} env (${region}, ${orgs[0]!.name ?? orgs[0]!.slug})` };
  } catch (e) {
    const msg = errMsg(e);
    return { ok: false, howToFix: /scope|permission|org:read/i.test(msg) ? `${msg} Check the token's scopes: org:read, team:read, project:read, project:write and event:read.` : msg };
  }
}

export const sentryAdapter: Adapter = {
  id: 'sentry',
  title: 'Sentry',
  axes: ['monitoring'],
  automated: true,
  detect: (d) => (d.providers.monitoring ?? []).includes('sentry'),
  auth,
  capabilities: { project, monitoring } as Adapter['capabilities'],
};
