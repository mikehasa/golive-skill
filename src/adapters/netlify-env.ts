import { Secret } from '../core/secret.js';
import type { Ctx, EnvStore, EnvTarget } from '../core/types.js';
import { label, netlifyCredential, netlifyHttp, netlifyRead, NetlifyError, object } from './netlify-api.js';
import { requireFreeAccount, requireSite, type NetlifySite } from './netlify-project.js';

const CONTEXT: Record<EnvTarget, string> = { preview: 'deploy-preview', production: 'production', development: 'dev' };
const BASE_SCOPES = ['builds', 'functions', 'runtime'];
interface EnvInfo { key: string; scopes: string[]; contexts: string[]; secret: boolean; }
function envKey(name: unknown): string {
  if (typeof name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new NetlifyError('Netlify environment variable name is invalid.');
  return name;
}
function targetsValid(targets: EnvTarget[]): void {
  if (!targets.length || targets.some(t => !Object.hasOwn(CONTEXT, t))) throw new NetlifyError('Netlify environment targets must be preview, production or development.');
}
async function list(ctx: Ctx, site: NetlifySite): Promise<EnvInfo[]> {
  const params = { account_id: site.accountId, site_id: site.id };
  const raw = await netlifyRead(ctx, 'getEnvVars', `/accounts/${encodeURIComponent(site.accountId)}/env?site_id=${encodeURIComponent(site.id)}`, params);
  if (!Array.isArray(raw)) throw new NetlifyError('Netlify returned an invalid environment inventory.');
  const seen = new Set<string>();
  return raw.map(value => {
    const r = object(value);
    const key = envKey(r.key);
    if (seen.has(key) || !Array.isArray(r.scopes) || !Array.isArray(r.values)) throw new NetlifyError('Netlify environment metadata is ambiguous; inspect it before changing values.');
    seen.add(key);
    // Never retain returned values, masked or readable. Only per-context PATCH is used for updates.
    return { key, scopes: r.scopes.map(s => label(s).replace('post-processing', 'post_processing')),
      contexts: r.values.map(v => label(object(v).context)), secret: r.is_secret === true };
  });
}
async function preflight(ctx: Ctx, name: string, targets: EnvTarget[]) {
  envKey(name); targetsValid(targets);
  await netlifyCredential(ctx);
  const site = await requireSite(ctx);
  await requireFreeAccount(ctx, site.accountId);
  const existing = (await list(ctx, site)).find(v => v.key === name);
  if (existing && BASE_SCOPES.some(s => !existing.scopes.includes(s))) throw new NetlifyError('The existing Netlify environment key has narrower scopes. Review it in Netlify before golive changes values; scopes were not widened.');
  return { site, existing };
}

export const netlifyEnv: EnvStore = {
  async listNames(ctx, target) {
    targetsValid([target]);
    return (await list(ctx, await requireSite(ctx)))
      .filter(v => v.contexts.some(c => c === 'all' || c === CONTEXT[target]) && BASE_SCOPES.every(s => v.scopes.includes(s)))
      .map(v => v.key).sort();
  },
  async canSet(ctx, name, targets) {
    try { await preflight(ctx, name, targets); return null; }
    catch (e) { return e instanceof NetlifyError ? e.message : 'Netlify environment preflight could not complete; no values were changed.'; }
  },
  async set(ctx, name, value, targets, opts) {
    const { site, existing } = await preflight(ctx, name, targets);
    const sensitive = opts?.sensitive ?? value instanceof Secret;
    if (sensitive && targets.includes('development')) throw new NetlifyError('Netlify development-context values are readable even for secret keys. golive will not put a secret into that context.');
    if (existing && existing.secret !== sensitive) throw new NetlifyError('The existing Netlify key has a different secret policy. Review it explicitly in Netlify; golive does not downgrade secrets or replace other contexts.');
    const values = [...new Set(targets)].map(target => ({ context: CONTEXT[target], value }));
    const path = `/accounts/${encodeURIComponent(site.accountId)}/env`;
    const query = `?site_id=${encodeURIComponent(site.id)}`;
    if (!existing) {
      // Free accepts default all-scopes by omission; secret keys require these three scopes.
      // The official Netlify Terraform provider documents this Free-plan exception.
      await netlifyHttp(ctx, 'POST', path + query, [{ key: name, is_secret: sensitive,
        ...(sensitive ? { scopes: BASE_SCOPES } : {}), values }]);
    } else {
      for (const entry of values) await netlifyHttp(ctx, 'PATCH', `${path}/${encodeURIComponent(name)}${query}`, entry);
    }
  },
};
