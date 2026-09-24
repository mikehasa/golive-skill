import type { Adapter, Ctx, Deployer, PublicUrl } from '../core/types.js';
import { CLI_ENV, cliSession, identifier, netlifyCredential, netlifyRead, NetlifyError, object, parseJson } from './netlify-api.js';
import { netlifyEnv } from './netlify-env.js';
import { netlifyProject, publicOrigin, requireFreeAccount, requireSite, type NetlifySite } from './netlify-project.js';

async function checkedDeploy(ctx: Ctx, site: NetlifySite, deployId: string) {
  const raw = object(await netlifyRead(ctx, 'getSiteDeploy', `/sites/${encodeURIComponent(site.id)}/deploys/${encodeURIComponent(identifier(deployId))}`, { site_id: site.id, deploy_id: deployId }));
  if (raw.id !== deployId || raw.site_id !== site.id || raw.state !== 'ready') throw new NetlifyError('Netlify did not confirm a ready deployment owned by the selected site.');
  return { id: deployId, url: publicOrigin(raw.deploy_ssl_url), production: raw.context === 'production' && raw.draft !== true };
}

export const netlifyUrl: PublicUrl = {
  async get(ctx, target) {
    if (target === 'development') return null;
    const site = await requireSite(ctx);
    if (target === 'preview') {
      const id = ctx.state.resource('netlify.previewDeployId');
      if (!id) return null;
      const deployment = await checkedDeploy(ctx, site, id);
      return deployment.production ? null : deployment.url;
    }
    if (!site.publishedId) return null;
    const deployment = await checkedDeploy(ctx, site, site.publishedId);
    if (!deployment.production) return null;
    // Never derive a hostname from the project name or trust config.domain as proof of ownership.
    return site.sslUrl ?? deployment.url;
  },
  async previewPatterns() {
    // Wildcards would include aliases/branches not separately observed; retain an exact allowlist.
    return [];
  },
};

const deploy: Deployer = {
  async deploy(ctx, target) {
    const session = await cliSession(ctx);
    if (!session.ok) throw new NetlifyError(session.howToFix);
    // Validate the same current-user OAuth/PAT principal used for HTTPS env writes.
    await netlifyCredential(ctx);
    const site = await requireSite(ctx);
    await requireFreeAccount(ctx, site.accountId);
    const args = ['deploy', '--site', site.id, '--context', target === 'production' ? 'production' : 'deploy-preview', '--json'];
    if (target === 'production') args.push('--prod');
    let r;
    try { r = await ctx.exec('netlify', args, { cwd: ctx.cwd, env: CLI_ENV, timeoutMs: 15 * 60_000 }); }
    catch { throw new NetlifyError('Netlify build/deploy could not complete. Inspect its local/provider logs privately; no CLI output was copied into the report.'); }
    if (r.code !== 0) throw new NetlifyError(`Netlify build/deploy failed (exit ${r.code}). Secret-marked non-dev values are masked during local builds; builds requiring raw secrets need a reviewed remote-build flow. No CLI output was logged.`);
    const raw = object(parseJson(r.stdout));
    if (raw.site_id !== site.id) throw new NetlifyError('Netlify deploy returned a different site ID; do not trust its URL.');
    const d = await checkedDeploy(ctx, site, identifier(raw.deploy_id));
    if (target === 'production') {
      const fresh = await requireSite(ctx);
      if (!d.production || fresh.publishedId !== d.id) throw new NetlifyError('Netlify has not confirmed this deployment as the selected site’s published production deployment.');
      const url = fresh.sslUrl ?? d.url;
      if (!url) throw new NetlifyError('Netlify returned no verified HTTPS deployment URL.');
      return { url, id: d.id };
    }
    if (d.production || !d.url) throw new NetlifyError('Netlify did not confirm a draft URL for this preview deployment.');
    ctx.state.save(s => { s.resources['netlify.previewDeployId'] = d.id; });
    return { url: d.url, id: d.id };
  },
};

export const netlifyAdapter: Adapter = {
  id: 'netlify', title: 'Netlify', axes: ['hosting'], automated: true,
  detect: d => Boolean(d.configs['netlify.toml'] || d.configs['.netlify/state.json'] || d.providers.hosting?.includes('netlify')),
  async auth(ctx) {
    try {
      const s = await cliSession(ctx);
      if (!s.ok) return { ok: false, howToFix: s.howToFix };
      await netlifyCredential(ctx);
      return { ok: true, via: `Netlify CLI login (user ${s.userId}); matching in-process HTTPS credential verified` };
    } catch (e) { return { ok: false, howToFix: e instanceof NetlifyError ? e.message : 'Netlify account access could not be verified safely. Check the CLI/network, then retry doctor or plan. No provider output was logged.' }; }
  },
  capabilities: { project: netlifyProject, env: netlifyEnv, url: netlifyUrl, deploy },
};
