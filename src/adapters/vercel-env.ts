/**
 * Vercel env vars. List/create responses carry values (plaintext for `plain`, echoed on create), so
 * rows are reduced to metadata the moment they arrive and responses are never logged or returned.
 */
import { Secret } from '../core/secret.js';
import type { Ctx, EnvStore, EnvTarget, Value } from '../core/types.js';
import { VercelError, vercelApi } from './vercel-api.js';
import { requireProjectId, vercelProject } from './vercel-project.js';

export interface EnvRow {
  id: string;
  key: string;
  target: string[];
  type: string;
  gitBranch?: string;
  /** Non-null = owned by a Marketplace integration (e.g. Supabase); golive must not overwrite it. */
  configurationId?: string | null;
  customEnvironmentIds?: string[];
}

type EnvType = 'sensitive' | 'encrypted';

export interface EnvListing {
  rows: EnvRow[];
  /** Production vars the caller's role cannot see (Vercel omits them from `envs`). */
  hiddenProduction: number;
}

export async function listEnv(ctx: Ctx, projectId: string): Promise<EnvListing> {
  const res = await vercelApi<{ envs?: Array<Record<string, unknown>>; hiddenProductionEnvCount?: unknown }>(ctx, 'GET', `/v10/projects/${encodeURIComponent(projectId)}/env`);
  const rows = (res.envs ?? []).map((e) => ({
    id: String(e.id ?? ''),
    key: String(e.key ?? ''),
    target: Array.isArray(e.target) ? (e.target as string[]) : typeof e.target === 'string' ? [e.target] : [],
    type: String(e.type ?? ''),
    gitBranch: typeof e.gitBranch === 'string' && e.gitBranch ? e.gitBranch : undefined,
    configurationId: typeof e.configurationId === 'string' ? e.configurationId : null,
    customEnvironmentIds: Array.isArray(e.customEnvironmentIds) ? (e.customEnvironmentIds as string[]) : [],
  }));
  const hidden = Number(res.hiddenProductionEnvCount ?? 0);
  return { rows, hiddenProduction: Number.isFinite(hidden) && hidden > 0 ? Math.floor(hidden) : 0 };
}

export async function listEnvRows(ctx: Ctx, projectId: string): Promise<EnvRow[]> {
  return (await listEnv(ctx, projectId)).rows;
}

/**
 * Thrown when some production vars are hidden from this login's role: names can't be verified, so
 * golive must report "cannot verify" (never "missing") and must not write blind.
 */
function hiddenProductionError(n: number, doing: string): VercelError {
  return new VercelError(
    `cannot verify production env: ${n} production env var${n === 1 ? ' is' : 's are'} hidden from this Vercel login's role, so golive cannot ${doing}. ` +
      'Ask a team Owner to run golive, or to give this account a role that can read production environment variables, then retry.',
    403,
    'hidden_env',
  );
}

/** A row that applies to the whole target (not branch- or custom-environment-scoped). */
function isTargetWide(r: EnvRow): boolean {
  return !r.gitBranch && !r.customEnvironmentIds?.length;
}

function desiredType(value: Value, sensitive: boolean | undefined, target: EnvTarget): EnvType {
  return (value instanceof Secret || sensitive) && target !== 'development' ? 'sensitive' : 'encrypted';
}

const VALID_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Why writing `name` to `wanted` would fail, given one env listing, or null. The single source of
 * truth for both set() (which throws it) and canSet() (which returns it), so the preflight can never
 * pass a write that set() would then refuse.
 */
function writeBlocker(listing: EnvListing, name: string, wanted: EnvTarget[]): VercelError | null {
  if (wanted.includes('production') && listing.hiddenProduction > 0) {
    return hiddenProductionError(listing.hiddenProduction, `tell whether ${name} already exists in production (it would be overwritten)`);
  }
  const rows = listing.rows.filter((r) => r.key === name && isTargetWide(r));
  for (const t of wanted) {
    const row = rows.find((r) => r.target.includes(t));
    if (!row) continue;
    if (row.configurationId) {
      return new VercelError(
        `${name} on ${t} is managed by a Vercel Marketplace integration; golive will not overwrite it. Change the app to use the integration's variable, or disconnect the integration's variable in the Vercel dashboard.`,
        undefined,
        'integration_owned',
      );
    }
    const extra = row.target.filter((x) => !wanted.includes(x as EnvTarget));
    if (extra.length) {
      return new VercelError(
        `${name} already exists as one variable shared by ${row.target.join(' + ')}, but golive was asked to set only ${wanted.join(' + ')}. Updating it would also change ${extra.join(' + ')}. Split the variable per environment in the Vercel dashboard (or include those targets), then retry.`,
        undefined,
        'shared_targets',
      );
    }
  }
  return null;
}

export const vercelEnv: EnvStore = {
  async listNames(ctx, target) {
    const { rows, hiddenProduction } = await listEnv(ctx, await requireProjectId(ctx));
    if (target === 'production' && hiddenProduction > 0) throw hiddenProductionError(hiddenProduction, 'tell which production variables exist');
    const names = rows.filter((r) => r.target.includes(target) && (target !== 'preview' || !r.gitBranch)).map((r) => r.key);
    return [...new Set(names)].sort();
  },

  async set(ctx, name, value, targets, opts) {
    if (!VALID_NAME.test(name)) throw new VercelError(`"${name}" is not a valid environment variable name.`);
    if ((typeof value === 'string' ? value : value.reveal()) === '') throw new VercelError(`Refusing to set ${name} to an empty value.`);
    // A plain string marked sensitive is still a secret: register it so any accidental echo is scrubbed.
    const v: Value = typeof value === 'string' && opts?.sensitive ? new Secret(name, value) : value;
    const projectId = await requireProjectId(ctx);
    const listing = await listEnv(ctx, projectId);
    const wanted = [...new Set(targets)];
    // Checked for every target before the first write, so a refusal never leaves a half-written var.
    const blocked = writeBlocker(listing, name, wanted);
    if (blocked) throw blocked;
    const rows = listing.rows.filter((r) => r.key === name && isTargetWide(r));
    const done = new Set<string>();

    for (const t of wanted) {
      if (done.has(t)) continue;
      const row = rows.find((r) => r.target.includes(t));
      if (!row) {
        await createRow(ctx, projectId, name, v, t, desiredType(v, opts?.sensitive, t));
        ctx.log.info(`vercel env: created ${name} for ${t}`);
        done.add(t);
        continue;
      }
      await updateRow(ctx, projectId, row, name, v, desiredType(v, opts?.sensitive, t));
      ctx.log.info(`vercel env: updated ${name} for ${row.target.join(' + ')}`);
      for (const x of row.target) done.add(x);
    }
  },

  async canSet(ctx, name, targets) {
    if (!VALID_NAME.test(name)) return `"${name}" is not a valid environment variable name.`;
    const wanted = [...new Set(targets)];
    if (!wanted.length) return null;
    // No project linked yet (it is selected/created by an earlier step of this apply): nothing to
    // collide with now; callers re-check at run time, once the project exists.
    const p = await vercelProject.current(ctx);
    if (!p) return null;
    // Same listing + rules as set(); API/auth failures propagate as errors (they are not a "no").
    const listing = await listEnv(ctx, p.id);
    return writeBlocker(listing, name, wanted)?.message ?? null;
  },
};

async function createRow(ctx: Ctx, projectId: string, key: string, value: Value, target: EnvTarget, type: EnvType): Promise<void> {
  // One target per call: the "Separate Production Secret Values" team policy rejects mixed targets.
  const res = await vercelApi<{ failed?: Array<{ error?: { code?: string; message?: string } }> }>(
    ctx,
    'POST',
    `/v10/projects/${encodeURIComponent(projectId)}/env?upsert=true`,
    { key, value, type, target: [target] },
  );
  const f = res.failed?.[0]?.error;
  if (f) throw new VercelError(`Vercel refused to set ${key} for ${target}${f.code ? ` (${f.code})` : ''}: ${f.message ?? 'no message'}`, undefined, f.code);
}

async function updateRow(ctx: Ctx, projectId: string, row: EnvRow, key: string, value: Value, type: EnvType): Promise<void> {
  const path = `/v9/projects/${encodeURIComponent(projectId)}/env/${encodeURIComponent(row.id)}`;
  const upgrade = type === 'sensitive' && row.type !== 'sensitive';
  if (!upgrade) {
    await vercelApi(ctx, 'PATCH', path, { value });
    return;
  }
  try {
    await vercelApi(ctx, 'PATCH', path, { value, type });
  } catch (e) {
    if (!(e instanceof VercelError) || !e.status || e.status >= 500) throw e;
    // Vercel may refuse to convert a readable var into a Secret in place; keep the value current anyway.
    await vercelApi(ctx, 'PATCH', path, { value });
    ctx.log.warn(
      `vercel env: ${key} (${row.target.join(' + ')}) is type "${row.type}", readable by project members. Recreate it as a Secret (sensitive) in the Vercel dashboard to make it write-only.`,
    );
  }
}
