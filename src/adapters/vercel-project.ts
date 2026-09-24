/**
 * Vercel project linking. `GET /v9/projects/{id}` returns automation-bypass SECRETS as object keys
 * of `protectionBypass`, so every project response is reduced to `ProjectInfo` immediately and the
 * raw object is never returned, logged or stored.
 */
import { basename } from 'node:path';
import type { Ctx, DetectResult, ProjectCreateTarget, ProjectLinker, ProjectRef, ProjectScope } from '../core/types.js';
import { VercelError, isNotFound, orgId, readLinkFile, session, vercelApi } from './vercel-api.js';

export interface ProjectInfo {
  id: string;
  name: string;
  accountId?: string;
  productionAliases: string[];
}

interface RawProject {
  id?: string;
  name?: string;
  accountId?: string;
  targets?: { production?: { alias?: string[] } | null };
}

function toInfo(raw: RawProject | undefined): ProjectInfo | null {
  if (!raw?.id || !raw.name) return null;
  const alias = raw.targets?.production?.alias;
  return { id: raw.id, name: raw.name, accountId: raw.accountId, productionAliases: Array.isArray(alias) ? alias.filter((a) => typeof a === 'string') : [] };
}

export async function projectInfo(ctx: Ctx, idOrName: string, scopeId?: string): Promise<ProjectInfo> {
  const raw = await vercelApi<RawProject>(ctx, 'GET', `/v9/projects/${encodeURIComponent(idOrName)}`, undefined, { scopeId });
  const info = toInfo(raw);
  if (!info) throw new VercelError(`Vercel returned an unexpected project shape for "${idOrName}".`);
  return info;
}

function remember(ctx: Ctx, p: ProjectInfo): void {
  ctx.state.save((s) => {
    s.resources['vercel.projectId'] = p.id;
    s.resources['vercel.projectName'] = p.name;
    if (p.accountId) s.resources['vercel.orgId'] = p.accountId;
  });
}

/** Marks a project golive itself created; teardown deletes only a project carrying this marker. */
function rememberCreated(ctx: Ctx, id: string): void {
  ctx.state.save((s) => void (s.resources['vercel.createdProjectId'] = id));
}

/** The project id to operate on, or an actionable error when none is linked yet. */
export async function requireProjectId(ctx: Ctx): Promise<string> {
  const p = await vercelProject.current(ctx);
  if (!p) {
    throw new VercelError(
      'No Vercel project is linked to this repo yet. Approve the plan step that selects or creates the Vercel project (or run `vercel link` in your terminal), then retry.',
    );
  }
  return p.id;
}

const FRAMEWORKS: Partial<Record<DetectResult['framework'], string>> = {
  next: 'nextjs',
  vite: 'vite',
  remix: 'remix',
  'react-router': 'react-router',
  astro: 'astro',
  sveltekit: 'sveltekit-1',
  nuxt: 'nuxtjs',
};

export function validProjectName(name: string): boolean {
  return /^[a-z0-9]([a-z0-9._-]{0,98}[a-z0-9])?$/.test(name) && !name.includes('---');
}

const scopeRef = (id: string, name?: string): ProjectScope => ({ kind: id.startsWith('team_') ? 'team' : 'account', id, ...(name ? { name } : {}) });

async function creationTarget(ctx: Ctx): Promise<ProjectCreateTarget> {
  const s = await session(ctx);
  const configured = orgId(ctx);
  if (configured?.startsWith('team_')) {
    if (s.kind === 'cli' && s.user.team?.id === configured) return { scope: scopeRef(configured, s.user.team.name ?? s.user.team.slug) };
    const team = await vercelApi<{ id?: string; name?: string; slug?: string }>(ctx, 'GET', `/v2/teams/${encodeURIComponent(configured)}`, undefined, { scopeId: configured });
    if (team.id !== configured) throw new VercelError('Vercel could not confirm the selected team. Check VERCEL_ORG_ID and re-plan.');
    return { scope: scopeRef(configured, team.name ?? team.slug) };
  }
  if (!configured && s.kind === 'cli' && s.user.team?.id) return { scope: scopeRef(s.user.team.id, s.user.team.name ?? s.user.team.slug) };
  const result = await vercelApi<{ user?: { id?: string; username?: string } }>(ctx, 'GET', '/v2/user');
  if (!result.user?.id || configured && result.user.id !== configured) throw new VercelError('Vercel could not confirm the selected personal account. Check the account scope and re-plan.');
  return { scope: scopeRef(result.user.id, result.user.username) };
}

async function resolveProject(ctx: Ctx, idOrName: string): Promise<ProjectRef> {
  const p = await projectInfo(ctx, idOrName);
  if (!p.accountId) throw new VercelError('Vercel did not identify the project owner; re-plan after its team/account can be confirmed.');
  const s = await session(ctx);
  const label = s.kind === 'cli' && s.user.team?.id === p.accountId ? s.user.team.name ?? s.user.team.slug : undefined;
  return { id: p.id, name: p.name, scope: scopeRef(p.accountId, label) };
}

export const vercelProject: ProjectLinker = {
  creationTarget,
  resolve: resolveProject,
  /** Read-only existence probe for a deletion golive performed (the provider's own not-found). */
  async exists(ctx, id) {
    try {
      await projectInfo(ctx, id);
      return true;
    } catch (e) {
      if (isNotFound(e)) return false;
      throw e;
    }
  },
  async current(ctx) {
    const stateId = ctx.state.resource('vercel.projectId');
    const stateName = ctx.state.resource('vercel.projectName');
    if (stateId && stateName) return { id: stateId, name: stateName };
    const link = readLinkFile(ctx);
    const ref = stateId ?? ctx.config.projects?.hosting ?? link?.projectId;
    if (!ref) return null;
    if (link?.projectId === ref && link.projectName) return { id: ref, name: link.projectName };
    try {
      const p = await projectInfo(ctx, ref);
      return { id: p.id, name: p.name };
    } catch (e) {
      if (!isNotFound(e)) throw e;
      ctx.log.warn(`Vercel project "${ref}" no longer exists or is in another team; pick or create one again.`);
      return null;
    }
  },

  async candidates(ctx) {
    const q = encodeURIComponent(basename(ctx.cwd));
    const res = await vercelApi<{ projects?: RawProject[] }>(ctx, 'GET', `/v10/projects?search=${q}&limit=20`);
    return (res.projects ?? []).map(toInfo).filter((p): p is ProjectInfo => p !== null).map(({ id, name }) => ({ id, name }));
  },

  async select(ctx, idOrName) {
    let p: ProjectInfo;
    try {
      p = await projectInfo(ctx, idOrName);
    } catch (e) {
      if (isNotFound(e)) throw new VercelError(`Vercel project "${idOrName}" was not found in the current team scope. List candidates with \`golive plan\` or create it.`, 404, 'not_found');
      throw e;
    }
    remember(ctx, p);
    ctx.log.info(`vercel: using project ${p.name} (${p.id})`);
    return { id: p.id, name: p.name, ...(p.accountId ? { scope: scopeRef(p.accountId) } : {}) };
  },

  async create(ctx, name, approvedTarget): Promise<ProjectRef> {
    if (!validProjectName(name)) {
      throw new VercelError(`"${name}" is not a valid Vercel project name: use lowercase letters, digits, ".", "_" or "-" (max 100 chars, no "---").`);
    }
    if (approvedTarget) {
      const now = await creationTarget(ctx);
      if (now.scope.id !== approvedTarget.scope.id || now.scope.kind !== approvedTarget.scope.kind) throw new VercelError('Vercel project creation scope changed since approval; run `plan` again and re-approve.');
    }
    const selectedScope = approvedTarget?.scope.id;
    // An approved create may not silently become adoption after another project appears.
    try {
      const existing = await projectInfo(ctx, name, selectedScope);
      if (approvedTarget) throw new VercelError('A Vercel project with this name appeared after approval. Run `plan` again and approve the exact existing project or choose another name.');
      remember(ctx, existing);
      ctx.log.info(`vercel: adopted existing project ${existing.name} (${existing.id})`);
      return { id: existing.id, name: existing.name };
    } catch (e) {
      if (!isNotFound(e)) throw e;
    }
    const framework = FRAMEWORKS[ctx.detect.framework];
    const raw = await vercelApi<RawProject>(ctx, 'POST', '/v11/projects', framework ? { name, framework } : { name }, { scopeId: selectedScope });
    const p = toInfo(raw);
    if (!p) throw new VercelError(`Vercel did not return the new project "${name}"; check the dashboard before retrying.`);
    if (approvedTarget && p.accountId !== approvedTarget.scope.id) throw new VercelError('Vercel returned an unexpected project owner; inspect the created resource before continuing.');
    remember(ctx, p);
    rememberCreated(ctx, p.id);
    ctx.log.info(`vercel: created project ${p.name} (${p.id})`);
    return { id: p.id, name: p.name, ...(approvedTarget ? { scope: approvedTarget.scope } : {}) };
  },

  async remove(ctx) {
    const id = ctx.state.resource('vercel.projectId');
    if (!id) return { removed: false, reason: 'no Vercel project is linked in state' };
    if (ctx.state.resource('vercel.createdProjectId') !== id) {
      return { removed: false, reason: 'the project was adopted or selected, not created by golive' };
    }
    try {
      await vercelApi(ctx, 'DELETE', `/v9/projects/${encodeURIComponent(id)}`);
    } catch (e) {
      // Already gone: the outcome teardown asked for.
      if (!isNotFound(e)) throw e;
    }
    ctx.state.save((s) => {
      delete s.resources['vercel.projectId'];
      delete s.resources['vercel.projectName'];
      delete s.resources['vercel.createdProjectId'];
    });
    ctx.log.info(`vercel: deleted project ${id}`);
    return { removed: true };
  },
};

/** The `<scope-slug>` used in generated preview URLs: team slug, else the account username. */
export async function scopeSlug(ctx: Ctx): Promise<string | null> {
  const org = orgId(ctx);
  if (org?.startsWith('team_')) {
    const t = await vercelApi<{ slug?: string }>(ctx, 'GET', `/v2/teams/${encodeURIComponent(org)}`);
    return t.slug ?? null;
  }
  const s = await session(ctx);
  if (s.kind === 'cli') return !org && s.user.team ? s.user.team.slug : s.user.username;
  const u = await vercelApi<{ user?: { username?: string } }>(ctx, 'GET', '/v2/user');
  return u.user?.username ?? null;
}
