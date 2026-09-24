import { basename, join } from 'node:path';
import { readFileSync } from 'node:fs';
import type { Ctx, ProjectCreateTarget, ProjectLinker, ProjectRef } from '../core/types.js';
import { identifier, label, netlifyHttp, netlifyRead, NetlifyError, object } from './netlify-api.js';

export interface NetlifySite { id: string; name: string; accountId: string; accountSlug: string; sslUrl: string | null; publishedId: string | null; }
interface Account { id: string; name: string; slug: string; free: boolean; included: number | null; used: number | null; }
const num = (v: unknown): number | null => typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null;
export function publicOrigin(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const u = new URL(value);
    if (u.protocol !== 'https:' || u.username || u.password || u.port || u.search || u.hash || (u.pathname !== '' && u.pathname !== '/')) return null;
    if (!u.hostname.endsWith('.netlify.app') || !/^[a-z0-9-]+\.netlify\.app$/i.test(u.hostname)) return null;
    return u.origin;
  } catch { return null; }
}
function account(raw: unknown): Account {
  const p = object(raw);
  const capacity = p.capabilities && typeof p.capabilities === 'object' ? (p.capabilities as { sites?: { included?: unknown; used?: unknown } }).sites : undefined;
  // Legacy Starter and unknown plans may permit paid usage; accept only an explicit Free plan.
  const plan = typeof p.type_name === 'string' ? p.type_name : p.type;
  return { id: identifier(p.id), name: label(p.name), slug: identifier(p.slug), free: typeof plan === 'string' && plan.trim().toLowerCase() === 'free', included: num(capacity?.included), used: num(capacity?.used) };
}
export async function accountInfo(ctx: Ctx, id: string): Promise<Account> {
  const a = account(await netlifyRead(ctx, 'getAccount', `/accounts/${encodeURIComponent(identifier(id))}`, { account_id: id }));
  if (a.id !== id) throw new NetlifyError('Netlify returned a different team; re-plan before any write.');
  return a;
}
export async function requireFreeAccount(ctx: Ctx, id: string, creating = false): Promise<Account> {
  const a = await accountInfo(ctx, id);
  if (!a.free) throw new NetlifyError('Netlify team is not verified as the current Free plan. Paid, legacy Starter and unknown plans require a human-managed flow; golive will not automate potentially billable operations.');
  if (creating && (a.included === null || a.used === null || a.used >= a.included)) throw new NetlifyError('Netlify free site quota is unavailable or exhausted. Check the team in Netlify; golive will not create a site or buy capacity.');
  return a;
}
export function siteInfo(raw: unknown): NetlifySite {
  const p = object(raw);
  const published = p.published_deploy && typeof p.published_deploy === 'object' ? p.published_deploy as Record<string, unknown> : undefined;
  return { id: identifier(p.id), name: label(p.name), accountId: identifier(p.account_id), accountSlug: identifier(p.account_slug), sslUrl: publicOrigin(p.ssl_url), publishedId: published?.id ? identifier(published.id) : null };
}
function ref(p: NetlifySite): ProjectRef { return { id: p.id, name: p.name, scope: { kind: 'team', id: p.accountId, name: p.accountSlug } }; }
function configuredAccount(ctx: Ctx): string | undefined { const id = ctx.env('NETLIFY_ACCOUNT_ID'); return id ? identifier(id) : undefined; }
function guardAccount(ctx: Ctx, p: NetlifySite): void {
  const wanted = configuredAccount(ctx);
  const saved = ctx.state.resource('netlify.siteId') === p.id ? ctx.state.resource('netlify.accountId') : undefined;
  if (wanted && wanted !== p.accountId || saved && saved !== p.accountId) throw new NetlifyError('Netlify project owner differs from the selected or previously approved team; re-plan before any write.');
}
async function getSite(ctx: Ctx, id: string, transport: 'cli' | 'https' = 'cli'): Promise<NetlifySite> {
  const path = `/sites/${encodeURIComponent(identifier(id))}`;
  const raw = transport === 'https' ? await netlifyHttp(ctx, 'GET', path) : await netlifyRead(ctx, 'getSite', path, { site_id: id });
  const p = siteInfo(raw);
  if (p.id !== id) throw new NetlifyError('Netlify returned a different site identity; re-plan.');
  guardAccount(ctx, p);
  return p;
}
async function listSites(ctx: Ctx, name?: string, selectedAccount?: Account): Promise<NetlifySite[]> {
  const result: NetlifySite[] = [];
  for (let page = 1; page <= 100; page++) {
    const params = { page, per_page: 100, ...(name ? { name } : {}), ...(selectedAccount ? { account_slug: selectedAccount.slug } : {}) };
    const query = new URLSearchParams({ page: String(page), per_page: '100', ...(name ? { name } : {}) });
    const raw = await netlifyRead(ctx, selectedAccount ? 'listSitesForAccount' : 'listSites', `${selectedAccount ? '/' + encodeURIComponent(selectedAccount.slug) : ''}/sites?${query}`, params);
    if (!Array.isArray(raw)) throw new NetlifyError('Netlify returned an invalid site list.');
    const rows = raw.map(siteInfo);
    if (selectedAccount && rows.some(p => p.accountId !== selectedAccount.id)) throw new NetlifyError('Netlify site list contained a different team; re-plan.');
    result.push(...rows);
    if (raw.length < 100) return result;
  }
  throw new NetlifyError('Netlify site listing exceeded its bounded pagination limit; select an exact site ID.');
}
async function resolveSite(ctx: Ctx, idOrName: string): Promise<NetlifySite> {
  identifier(idOrName);
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(idOrName)) return getSite(ctx, idOrName);
  const owner = configuredAccount(ctx);
  const rows = (await listSites(ctx, idOrName, owner ? await accountInfo(ctx, owner) : undefined)).filter(p => p.name === idOrName);
  if (rows.length !== 1) throw new NetlifyError('Netlify project name is missing or ambiguous across teams. Select the exact site ID and re-plan.');
  return getSite(ctx, rows[0]!.id);
}
function localSite(ctx: Ctx): string | undefined {
  try {
    const raw = JSON.parse(readFileSync(join(ctx.cwd, '.netlify', 'state.json'), 'utf8')) as { siteId?: unknown };
    return raw.siteId ? identifier(raw.siteId) : undefined;
  } catch { return undefined; }
}
export async function requireSite(ctx: Ctx): Promise<NetlifySite> {
  const selected = ctx.config.projects?.hosting ?? ctx.state.resource('netlify.siteId') ?? localSite(ctx);
  if (!selected) throw new NetlifyError('No Netlify project is selected. Approve the exact project plan before wiring or deploying.');
  return resolveSite(ctx, selected);
}
function remember(ctx: Ctx, p: NetlifySite): ProjectRef {
  ctx.state.save(s => {
    s.resources['netlify.siteId'] = p.id; s.resources['netlify.siteName'] = p.name;
    s.resources['netlify.accountId'] = p.accountId; s.resources['netlify.accountSlug'] = p.accountSlug;
  });
  return ref(p);
}
/** Marks a site golive itself created; teardown deletes only a site carrying this marker. */
function rememberCreated(ctx: Ctx, id: string): void {
  ctx.state.save(s => void (s.resources['netlify.createdProjectId'] = id));
}

async function creationTarget(ctx: Ctx): Promise<ProjectCreateTarget> {
  const chosen = configuredAccount(ctx);
  let a: Account;
  if (chosen) a = await requireFreeAccount(ctx, chosen, true);
  else {
    const raw = await netlifyRead(ctx, 'listAccountsForUser', '/accounts');
    if (!Array.isArray(raw)) throw new NetlifyError('Netlify returned an invalid team list.');
    const free = raw.map(account).filter(x => x.free);
    if (free.length !== 1) throw new NetlifyError('Choose an exact current Free Netlify team using NETLIFY_ACCOUNT_ID, then re-plan; zero or multiple Free teams cannot be selected automatically.');
    a = await requireFreeAccount(ctx, free[0]!.id, true);
  }
  return { scope: { kind: 'team', id: a.id, name: a.name } };
}

export const netlifyProject: ProjectLinker = {
  creationTarget,
  async current(ctx) {
    const selected = ctx.config.projects?.hosting ?? ctx.state.resource('netlify.siteId') ?? localSite(ctx);
    return selected ? ref(await resolveSite(ctx, selected)) : null;
  },
  async candidates(ctx) {
    const owner = configuredAccount(ctx);
    return (await listSites(ctx, basename(ctx.cwd), owner ? await accountInfo(ctx, owner) : undefined)).map(ref);
  },
  async resolve(ctx, idOrName) { return ref(await resolveSite(ctx, idOrName)); },
  /**
   * Read-only existence probe for a deletion golive performed. Reads over HTTPS on purpose: the CLI
   * transport reports a missing site as a plain exit code, with no HTTP status to recognize, so only
   * an HTTPS 404 may count as removed.
   */
  async exists(ctx, id) {
    try {
      await getSite(ctx, id, 'https');
      return true;
    } catch (e) {
      if (e instanceof NetlifyError && e.status === 404) return false;
      throw e;
    }
  },
  async select(ctx, idOrName) { return remember(ctx, await resolveSite(ctx, idOrName)); },
  async create(ctx, name, approvedTarget) {
    if (!/^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$/.test(name)) throw new NetlifyError('Use a Netlify site name with 2–63 lowercase letters, digits and internal hyphens.');
    if (!approvedTarget || approvedTarget.scope.kind !== 'team') throw new NetlifyError('Netlify project creation needs the exact approved team destination; re-plan.');
    const fresh = await creationTarget(ctx);
    if (fresh.scope.id !== approvedTarget.scope.id) throw new NetlifyError('Netlify creation destination changed; re-plan before creating anything.');
    const a = await requireFreeAccount(ctx, fresh.scope.id, true);
    if ((await listSites(ctx, name, a)).some(p => p.name === name)) throw new NetlifyError('A Netlify site with this name already exists in the selected team. Re-plan to explicitly select it; it was not adopted or changed.');
    const p = siteInfo(await netlifyHttp(ctx, 'POST', `/${encodeURIComponent(a.slug)}/sites?configure_dns=false`, { name }));
    if (p.name !== name || p.accountId !== a.id || p.accountSlug !== a.slug) throw new NetlifyError('Netlify created a site with an unexpected destination. Stop and inspect that account; no environment variables or deployment were changed.');
    const created = remember(ctx, p);
    rememberCreated(ctx, p.id);
    return created;
  },
  async remove(ctx) {
    const id = ctx.state.resource('netlify.siteId');
    if (!id) return { removed: false, reason: 'no Netlify project is linked in state' };
    if (ctx.state.resource('netlify.createdProjectId') !== id) {
      return { removed: false, reason: 'the project was adopted or selected, not created by golive' };
    }
    try {
      await netlifyHttp(ctx, 'DELETE', `/sites/${encodeURIComponent(id)}`);
    } catch (e) {
      // Already gone: the outcome teardown asked for.
      if (!(e instanceof NetlifyError && e.status === 404)) throw e;
    }
    ctx.state.save(s => {
      delete s.resources['netlify.siteId']; delete s.resources['netlify.siteName'];
      delete s.resources['netlify.createdProjectId'];
    });
    return { removed: true };
  },
};
