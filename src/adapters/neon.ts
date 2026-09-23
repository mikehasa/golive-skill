import { basename } from 'node:path';
/** Scoped Free-plan Neon Postgres provisioning and server-only connection outputs. */
import type { Adapter, Ctx, OutputKey, Outputs, ProjectCreateTarget, ProjectRef } from '../core/types.js';
import { Secret } from '../core/secret.js';
import { allowHost } from '../core/http.js';
import { neonApi, NeonError, neonHelp } from './neon-api.js';
export { NeonError } from './neon-api.js';

export const neonTiming = { pollMs: 2_000, timeoutMs: 5 * 60_000 };
const ID = /^[a-z0-9][a-z0-9-]{0,59}$/;
const STATE_PROJECT = 'neon.projectId';
const OUTPUTS: OutputKey[] = ['db.url', 'db.directUrl'];
type Obj = Record<string, unknown>;
function obj(v: unknown): Obj { if (!v || typeof v !== 'object' || Array.isArray(v)) throw new NeonError('Neon returned an unexpected object; nothing was inferred.'); return v as Obj; }
function str(v: unknown): string { if (typeof v !== 'string' || !v) throw new NeonError('Neon returned a missing identifier or name.'); return v; }
function id(v: unknown): string { const s = str(v); if (!ID.test(s)) throw new NeonError('Invalid Neon resource identifier.'); return s; }
function list(v: unknown, key: string): Obj[] { const a = obj(v)[key]; if (!Array.isArray(a)) throw new NeonError(`Neon returned an unexpected ${key} list.`); return a.map(obj); }
function cfg(ctx: Ctx) { return ctx.config.neon ?? {}; }
function orgOverride(ctx: Ctx): string | undefined { const v = cfg(ctx).organizationId ?? ctx.env('NEON_ORG_ID'); return v === undefined ? undefined : id(v); }
const enc = encodeURIComponent;
function ref(p: Obj): ProjectRef {
  const org = id(p.org_id ?? p.owner_id);
  if (p.org_id !== undefined && p.owner_id !== undefined && p.org_id !== p.owner_id) throw new NeonError('Neon project ownership fields disagree; re-plan after checking the account.');
  return { id: id(p.id), name: str(p.name), scope: { kind: 'organization', id: org } };
}
async function organization(ctx: Ctx, orgId: string): Promise<Obj> {
  const o = obj(await neonApi(ctx, `/organizations/${id(orgId)}`));
  if (o.id !== orgId || typeof o.plan !== 'string') throw new NeonError('Could not verify Neon organization identity and billing plan.');
  return o;
}
async function freeOrg(ctx: Ctx): Promise<Obj> {
  const explicit = orgOverride(ctx);
  if (explicit) {
    const o = await organization(ctx, explicit);
    if (o.plan !== 'free') throw new NeonError('Neon project creation requires a verified Free organization; paid or unknown plans are not automated.');
    return o;
  }
  const all = list(await neonApi(ctx, '/users/me/organizations'), 'organizations');
  const free = all.filter((o) => o.plan === 'free');
  if (free.length !== 1) throw new NeonError('Select exactly one Free Neon organization using neon.organizationId (or NEON_ORG_ID), then re-plan. No organization was guessed.');
  // Re-read the exact organization rather than trusting an older discovery response.
  const o = await organization(ctx, id(free[0]!.id));
  if (o.plan !== 'free') throw new NeonError('The Neon organization is no longer Free; nothing was created.');
  return o;
}
async function projects(ctx: Ctx, orgId: string): Promise<ProjectRef[]> {
  const found: ProjectRef[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < 100; page++) {
    const query = new URLSearchParams({ org_id: orgId, limit: '400', ...(cursor ? { cursor } : {}) });
    const data = obj(await neonApi(ctx, `/projects?${query}`));
    if (data.unavailable_project_ids !== undefined && (!Array.isArray(data.unavailable_project_ids) || data.unavailable_project_ids.length > 0)) throw new NeonError('Neon project inventory is incomplete; refusing creation or adoption.');
    const batch = list(data, 'projects').map(ref);
    if (batch.some((p) => p.scope!.id !== orgId)) throw new NeonError('Neon project list included a different organization.');
    for (const p of batch) { if (found.some((a) => a.id === p.id)) throw new NeonError('Neon project inventory repeated an ID.'); found.push(p); }
    if (data.pagination === undefined) return found;
    cursor = str(obj(data.pagination).cursor);
    if (!batch.length) return found; // API may echo its last cursor on an exhausted page.
    if (seen.has(cursor)) throw new NeonError('Neon project pagination did not advance.');
    seen.add(cursor);
  }
  throw new NeonError('Neon project inventory exceeded the pagination safety limit.');
}
async function exact(ctx: Ctx, projectId: string): Promise<Obj> {
  const p = obj(obj(await neonApi(ctx, `/projects/${id(projectId)}`)).project);
  const pRef = ref(p);
  if (pRef.id !== projectId || (orgOverride(ctx) && pRef.scope!.id !== orgOverride(ctx))) throw new NeonError('Neon returned a project outside the selected project/organization.');
  return p;
}
async function resolve(ctx: Ctx, selected: string): Promise<ProjectRef> {
  // IDs and names share Neon's grammar: prefer an exact ID from a scoped inventory when available.
  const explicitOrg = orgOverride(ctx);
  if (!explicitOrg) return ref(await exact(ctx, selected));
  const all = await projects(ctx, explicitOrg);
  const byId = all.filter((p) => p.id === selected);
  const matches = byId.length ? byId : all.filter((p) => p.name === selected);
  if (matches.length !== 1) throw new NeonError('Select one exact accessible Neon project ID; this selection is missing or ambiguous.');
  return ref(await exact(ctx, matches[0]!.id));
}
async function current(ctx: Ctx): Promise<ProjectRef | null> {
  const chosen = ctx.config.projects?.db ?? ctx.state.resource(STATE_PROJECT);
  return chosen ? resolve(ctx, chosen) : null;
}
async function candidates(ctx: Ctx): Promise<ProjectRef[]> {
  const o = await freeOrg(ctx);
  const all = await projects(ctx, id(o.id));
  const name = basename(ctx.cwd).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63) || 'app';
  const matches = all.filter((p) => p.name.toLowerCase() === name);
  if (matches.length) {
    if (matches.length !== 1 || !cfg(ctx).branchId || !cfg(ctx).database || !cfg(ctx).role) throw new NeonError('A same-named Neon project already exists. Select its exact projects.db ID and set neon.branchId, neon.database and neon.role before re-planning. No defaults were assumed.');
    ctx.cache.set('neon.plannedCandidateId', matches[0]!.id);
  }
  return all;
}
function remember(ctx: Ctx, p: ProjectRef): void { ctx.state.save((s) => { s.resources[STATE_PROJECT] = p.id; s.resources['neon.organizationId'] = p.scope!.id; }); }
async function creationTarget(ctx: Ctx): Promise<ProjectCreateTarget> {
  if (cfg(ctx).branchId || cfg(ctx).database || cfg(ctx).role) throw new NeonError('Creating a Neon project uses fixed main/neondb/neondb_owner defaults. Remove branch/database/role selectors or select an existing project.');
  const o = await freeOrg(ctx);
  const region = cfg(ctx).region ?? 'aws-us-east-2';
  if (!/^(?:aws|azure)-[a-z0-9-]+$/.test(region)) throw new NeonError('Invalid Neon region; use an official region ID.');
  return { scope: { kind: 'organization', id: id(o.id), name: str(o.name) }, region };
}
function targetSame(a: ProjectCreateTarget, b: ProjectCreateTarget): boolean { return a.scope.kind === b.scope.kind && a.scope.id === b.scope.id && a.region === b.region; }
async function waitOperations(ctx: Ctx, projectId: string, operationIds: string[]): Promise<void> {
  const deadline = Date.now() + neonTiming.timeoutMs;
  for (const operationId of operationIds) {
    for (;;) {
      const op = obj(obj(await neonApi(ctx, `/projects/${projectId}/operations/${enc(operationId)}`)).operation);
      if (op.id !== operationId || op.project_id !== projectId) throw new NeonError('Neon operation identity mismatch.');
      if (op.status === 'finished') break;
      if (!['scheduling', 'running', 'cancelling'].includes(String(op.status))) throw new NeonError('Neon provisioning operation failed or returned an unknown state; inspect this project before resuming.');
      if (Date.now() >= deadline) throw new NeonError('Neon provisioning is still pending. Project identity is saved; resume later without creating another project.');
      await new Promise((r) => setTimeout(r, neonTiming.pollMs));
    }
  }
}
async function create(ctx: Ctx, name: string, approved?: ProjectCreateTarget): Promise<ProjectRef> {
  if (!approved) throw new NeonError('Neon creation requires an approved organization and region.');
  const now = await creationTarget(ctx);
  if (!targetSame(now, approved)) throw new NeonError('Neon creation destination changed after approval; re-plan.');
  if (!name || name.length > 256) throw new NeonError('Invalid Neon project name.');
  const prior = ctx.state.resource('neon.createdProjectId');
  if (prior && ctx.state.resource('neon.createdProjectName') === name) {
    const p = await exact(ctx, prior);
    const r = ref(p);
    if (r.scope!.id !== approved.scope.id || p.region_id !== approved.region) throw new NeonError('Saved Neon creation destination differs from approval.');
    await waitOperations(ctx, r.id, JSON.parse(ctx.state.resource('neon.operationIds') ?? '[]') as string[]);
    return r;
  }
  if ((await projects(ctx, approved.scope.id)).some((p) => p.name.toLowerCase() === name.toLowerCase())) throw new NeonError('A Neon project with this name already exists. Re-plan and explicitly approve adoption; no duplicate was created.');
  const database = 'neondb';
  const role = 'neondb_owner';
  // POST is deliberately not retried after an ambiguous failure. No billing, upgrade, branch copy,
  // extra compute, reset-password, schema or Auth operations exist in this adapter.
  const data = obj(await neonApi(ctx, '/projects', 'POST', { project: { name, org_id: approved.scope.id, region_id: approved.region, branch: { name: 'main', database_name: database, role_name: role }, default_endpoint_settings: { autoscaling_limit_min_cu: 0.25, autoscaling_limit_max_cu: 0.25 }, store_passwords: true } }));
  const created = ref(obj(data.project));
  const confirmed = await exact(ctx, created.id);
  if (created.scope!.id !== approved.scope.id || ref(confirmed).scope!.id !== approved.scope.id || confirmed.region_id !== approved.region || confirmed.name !== name) throw new NeonError('Neon created-project destination could not be confirmed. Inspect the organization and re-plan; nothing was linked.');
  const branch = obj(data.branch);
  if (branch.project_id !== created.id) throw new NeonError('Neon creation response did not identify the new project branch.');
  const branchId = id(branch.id);
  const ops = list(data, 'operations');
  if (ops.some((o) => o.project_id !== created.id || typeof o.id !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(o.id))) throw new NeonError('Neon creation response included an invalid operation. Inspect the new project before retrying.');
  ctx.state.save((s) => {
    Object.assign(s.resources, { [STATE_PROJECT]: created.id, 'neon.organizationId': approved.scope.id, 'neon.createdProjectId': created.id, 'neon.createdProjectName': name, 'neon.branchId': branchId, 'neon.database': database, 'neon.role': role, 'neon.operationIds': JSON.stringify(ops.map((o) => o.id)) });
  });
  await waitOperations(ctx, created.id, ops.map((o) => String(o.id)));
  return ref(confirmed);
}

interface Selection { project: ProjectRef; branchId: string; database: string; role: string; endpointId: string; host: string }
async function selection(ctx: Ctx): Promise<Selection> {
  const project = await current(ctx);
  if (!project) throw new NeonError('Select or create a Neon project first.');
  const owned = ctx.state.resource('neon.createdProjectId') === project.id;
  const branchId = cfg(ctx).branchId ?? (owned ? ctx.state.resource('neon.branchId') : undefined);
  const database = cfg(ctx).database ?? (owned ? ctx.state.resource('neon.database') : undefined);
  const role = cfg(ctx).role ?? (owned ? ctx.state.resource('neon.role') : undefined);
  if (!branchId || !database || !role) throw new NeonError('For an existing Neon project set neon.branchId, neon.database and neon.role explicitly; golive never guesses the default or production branch.');
  const branch = obj(obj(await neonApi(ctx, `/projects/${project.id}/branches/${id(branchId)}`)).branch);
  if (branch.project_id !== project.id || branch.id !== branchId || branch.current_state !== 'ready') throw new NeonError('The selected Neon branch is not ready or belongs to a different project.');
  const databases = list(await neonApi(ctx, `/projects/${project.id}/branches/${branchId}/databases`), 'databases');
  const roles = list(await neonApi(ctx, `/projects/${project.id}/branches/${branchId}/roles`), 'roles');
  if (!databases.some((d) => d.branch_id === branchId && d.name === database) || !roles.some((r) => r.branch_id === branchId && r.name === role && r.authentication_method !== 'no_login' && r.authentication_method !== 'oauth')) throw new NeonError('The selected Neon database or password-authenticated role is not present on this branch.');
  const endpoints = list(await neonApi(ctx, `/projects/${project.id}/endpoints`), 'endpoints');
  const matches = endpoints.filter((e) => e.project_id === project.id && e.branch_id === branchId && e.type === 'read_write' && e.disabled === false);
  if (matches.length !== 1) throw new NeonError('Could not confirm one enabled read-write Neon compute for the selected branch. No compute was created.');
  const endpoint = matches[0]!;
  const host = str(endpoint.host);
  if (!/^ep-[a-z0-9-]+\.[a-z0-9.-]+\.neon\.tech$/.test(host)) throw new NeonError('Neon returned an unexpected compute hostname.');
  return { project, branchId, database, role, endpointId: id(endpoint.id), host };
}
async function connection(ctx: Ctx, s: Selection, pooled: boolean): Promise<Secret> {
  const query = new URLSearchParams({ branch_id: s.branchId, endpoint_id: s.endpointId, database_name: s.database, role_name: s.role, pooled: String(pooled) });
  const value = obj(await neonApi(ctx, `/projects/${s.project.id}/connection_uri?${query}`)).uri;
  if (!(value instanceof Secret)) throw new NeonError('Neon did not return a usable connection URI. Passwords may not be stored; golive will not reset them.');
  let uri: URL;
  try { uri = new URL(value.reveal()); } catch { throw new NeonError('Neon returned an invalid connection URI; value omitted.'); }
  // libpq accepts connection identity overrides in query parameters. Only TLS options produced
  // by Neon's API are accepted; a matching authority alone is insufficient.
  const allowed = new Set(['sslmode', 'channel_binding']);
  const seen = new Set<string>();
  for (const [key, v] of uri.searchParams) {
    if (!allowed.has(key) || seen.has(key) || (key === 'channel_binding' && !['require', 'prefer'].includes(v))) throw new NeonError('Neon connection URI contains unsupported query parameters; value omitted.');
    seen.add(key);
  }
  if (uri.hash) throw new NeonError('Neon connection URI contains an unexpected fragment; value omitted.');
  const expectedHost = pooled ? s.host.replace('.', '-pooler.') : s.host;
  let identityMatches = false;
  try { identityMatches = decodeURIComponent(uri.username) === s.role && decodeURIComponent(uri.pathname.slice(1)) === s.database; } catch { /* invalid percent-encoding */ }
  if (!['postgres:', 'postgresql:'].includes(uri.protocol) || uri.hostname !== expectedHost || (uri.port && uri.port !== '5432') || !uri.password || !identityMatches || !['require', 'verify-full'].includes(uri.searchParams.get('sslmode') ?? '')) throw new NeonError('Neon connection URI did not match the approved branch, database, role or TLS requirement; value omitted.');
  return value;
}
async function outputs(ctx: Ctx, _target: string, requested?: readonly OutputKey[]): Promise<Outputs> {
  const wanted = OUTPUTS.filter((k) => !requested || requested.includes(k));
  if (!wanted.length) return {};
  const s = await selection(ctx);
  const out: Outputs = {};
  for (const key of wanted) out[key] = await connection(ctx, s, key === 'db.url');
  return out;
}

/** No values are fetched: selectors are part of the plan even before creation. */
async function connectionIdentity(ctx: Ctx): Promise<string> {
  const selected = ctx.config.projects?.db ?? ctx.state.resource(STATE_PROJECT) ?? ctx.cache.get('neon.plannedCandidateId');
  const owned = selected && selected === ctx.state.resource('neon.createdProjectId');
  if (!selected) {
    if (cfg(ctx).branchId || cfg(ctx).database || cfg(ctx).role) throw new NeonError('For a new Neon project remove branch/database/role overrides; creation uses fixed main/neondb/neondb_owner defaults.');
    return JSON.stringify({ branch: 'new main', database: 'neondb', role: 'neondb_owner' });
  }
  const branch = cfg(ctx).branchId ?? (owned ? ctx.state.resource('neon.branchId') : undefined);
  const database = cfg(ctx).database ?? (owned ? ctx.state.resource('neon.database') : undefined);
  const role = cfg(ctx).role ?? (owned ? ctx.state.resource('neon.role') : undefined);
  if (!branch || !database || !role) throw new NeonError('Select neon.branchId, neon.database and neon.role explicitly for this existing Neon project.');
  id(branch);
  return JSON.stringify({ branch, database, role });
}

/** Read-only connectivity, not a schema/RLS/app-isolation claim. SQL is fixed, never caller input. */
export async function verifyNeonConnection(ctx: Ctx): Promise<{ projectId: string; branchId: string; database: string; role: string }> {
  const s = await selection(ctx);
  if ((await organization(ctx, s.project.scope!.id)).plan !== 'free') throw new NeonError('SQL connectivity probe requires a verified Free Neon organization; waking paid compute is not automated.');
  const uri = await connection(ctx, s, false);
  allowHost(s.host); // exact API-verified compute host only, not a global *.neon.tech permission.
  let result;
  try {
    result = await ctx.http({ method: 'POST', url: `https://${s.host}/sql`, headers: { 'Neon-Connection-String': uri, 'Neon-Raw-Text-Output': 'true', 'Neon-Array-Mode': 'true', 'Neon-Batch-Read-Only': 'true' }, body: { queries: [{ query: 'SELECT current_database(), current_user, 1', params: [] }] }, idempotent: true });
  } catch { throw new NeonError('Neon SQL connectivity request failed; provider details omitted.'); }
  if (result.status !== 200) throw new NeonError(`Neon SQL connectivity failed (HTTP ${result.status}); provider details omitted.`);
  const results = list(result.json, 'results');
  const rows = results[0]?.rows;
  if (results.length !== 1 || results[0]?.command !== 'SELECT' || results[0]?.rowCount !== 1 || !Array.isArray(rows) || rows.length !== 1 || !Array.isArray(rows[0]) || rows[0].length !== 3 || rows[0][0] !== s.database || rows[0][1] !== s.role || rows[0][2] !== '1') throw new NeonError('Neon SQL response did not prove the selected database and role.');
  return { projectId: s.project.id, branchId: s.branchId, database: s.database, role: s.role };
}

export const neonAdapter: Adapter = {
  id: 'neon', title: 'Neon', axes: ['db'], automated: true,
  detect: (d) => d.providers.db?.includes('neon') ?? false,
  auth: async (ctx) => {
    try {
      const a = obj(await neonApi(ctx, '/auth'));
      const account = id(a.account_id);
      if (!['keycloak', 'session_cookie', 'api_key_user', 'api_key_org', 'oauth'].includes(String(a.auth_method))) throw new NeonError('Unknown Neon authentication method.');
      return { ok: true, via: `${ctx.envToken('NEON_API_KEY') ? 'NEON_API_KEY' : 'Neon CLI login'} (account ${account}; destination is approved separately)` };
    } catch { return { ok: false, howToFix: `Could not verify Neon authentication. ${neonHelp()}` }; }
  },
  capabilities: {
    project: { current, candidates, resolve, creationTarget, select: async (ctx, chosen) => { const p = await resolve(ctx, chosen); remember(ctx, p); return p; }, create },
    outputs: { outputs, provides: async (_ctx, _target, keys) => OUTPUTS.filter((k) => !keys || keys.includes(k)), identity: connectionIdentity },
    dbConnection: { probe: verifyNeonConnection },
  },
};
