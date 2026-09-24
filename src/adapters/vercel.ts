/**
 * Vercel hosting adapter. Transport: the user's logged-in `vercel` CLI (`vercel api`, body on stdin),
 * falling back to VERCEL_TOKEN (agent env or the golive credentials file). See docs/PROVIDERS.md.
 */
import { credentialsPath, tokenHowTo } from '../core/credentials.js';
import { Secret } from '../core/secret.js';
import type { Adapter, AuthStatus, Ctx, Deployer, PublicUrl } from '../core/types.js';
import { API_BASE, INSTALL_CLI, TOKEN_WHERE, VercelError, howToLogin, orgId, parseJson, readLinkFile, session } from './vercel-api.js';
import { getProjectDomain, vercelDomain } from './vercel-domain.js';
import { vercelEnv } from './vercel-env.js';
import { projectInfo, requireProjectId, scopeSlug, vercelProject } from './vercel-project.js';

const DEPLOY_TIMEOUT = 15 * 60_000;

async function auth(ctx: Ctx): Promise<AuthStatus> {
  try {
    const s = await session(ctx);
    if (s.kind === 'cli') {
      const selected = orgId(ctx);
      const team = selected ? `, target scope ${selected}` : s.user.team ? `, team ${s.user.team.slug}` : '';
      return { ok: true, via: `vercel CLI (logged in as ${s.user.username}${team})` };
    }
    if (s.kind === 'token') {
      const res = await ctx.http<{ user?: { username?: string } }>({ url: `${API_BASE}/v2/user`, headers: { authorization: new Secret('VERCEL_TOKEN', `Bearer ${s.token.reveal()}`) } });
      const via = `VERCEL_TOKEN${res.status === 200 && res.json?.user?.username ? ` (user ${res.json.user.username})` : ''}`;
      if (res.status === 200 && !s.cliInstalled) {
        // The token covers API calls, but every deploy runs `vercel deploy`: say so now, not mid-apply.
        return { ok: false, via, howToFix: `VERCEL_TOKEN works for Vercel API calls, but deploys need the Vercel CLI, which is not installed: ${INSTALL_CLI}. golive then passes the token to it; no \`vercel login\` needed.` };
      }
      if (res.status === 200) return { ok: true, via };
      return {
        ok: false,
        via: 'VERCEL_TOKEN',
        howToFix:
          `VERCEL_TOKEN is set but Vercel rejected it (HTTP ${res.status}). Preferred: remove that VERCEL_TOKEN (from ${credentialsPath()} or the agent's environment) ` +
          `and run \`vercel login\` in a separate terminal window (Claude Code's \`!\` prefix has no interactive terminal). Or replace it with a new token: ${TOKEN_WHERE} ${tokenHowTo('VERCEL_TOKEN')}`,
      };
    }
    if (!s.cliInstalled) return { ok: false, howToFix: `The Vercel CLI is not installed (golive deploys through it): ${INSTALL_CLI}. Then ${howToLogin()}` };
    return { ok: false, howToFix: `Not logged in to Vercel: ${howToLogin()}` };
  } catch (e) {
    return { ok: false, howToFix: `Could not check Vercel login (${(e as Error).message}). ${howToLogin()}` };
  }
}

// ── PublicUrl ────────────────────────────────────────────────────────────────────────────────

const vercelUrl: PublicUrl = {
  async get(ctx, target) {
    if (target !== 'production') return null; // preview URLs are per deployment
    const p = await projectInfo(ctx, await requireProjectId(ctx));
    const domain = ctx.config.domain;
    if (domain) {
      const pd = await getProjectDomain(ctx, p.id, domain);
      if (pd?.verified) return `https://${domain}`;
    }
    const host = pickProductionAlias(p.name, p.productionAliases);
    return host ? `https://${host}` : null;
  },

  async previewPatterns(ctx) {
    const p = await vercelProject.current(ctx);
    if (!p) return [];
    const slug = await scopeSlug(ctx);
    if (!slug) return [];
    return [`https://${p.name}-*-${slug}.vercel.app/**`, `https://${p.name}-git-*-${slug}.vercel.app/**`];
  },
};

/**
 * The public production host among the aliases Vercel actually assigned, or null when production was
 * never (successfully) deployed. Never builds `<name>.vercel.app` by hand: `*.vercel.app` names are
 * global, so that name may belong to another account (Vercel then assigns a suffixed alias).
 * Order: the exact `<name>.vercel.app` if it is ours; then a custom domain; then the shortest
 * `*.vercel.app` alias that is not a branch (`-git-`) alias, which Standard Protection covers.
 */
export function pickProductionAlias(name: string, aliases: string[]): string | null {
  const hosts = [...new Set(aliases.map((a) => a.trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '').toLowerCase()).filter(Boolean))];
  if (!hosts.length) return null;
  const exact = `${name.toLowerCase()}.vercel.app`;
  if (hosts.includes(exact)) return exact;
  const shortest = (xs: string[]) => [...xs].sort((a, b) => a.length - b.length || a.localeCompare(b))[0];
  return shortest(hosts.filter((h) => !h.endsWith('.vercel.app'))) ?? shortest(hosts.filter((h) => !h.includes('-git-'))) ?? shortest(hosts)!;
}

/** Canonical production URL (custom domain when verified, else an assigned production alias, else null). For checks. */
export function vercelProductionUrl(ctx: Ctx): Promise<string | null> {
  return vercelUrl.get(ctx, 'production');
}

// ── Deployer ─────────────────────────────────────────────────────────────────────────────────

interface DeployJson {
  status?: string;
  reason?: string;
  message?: string;
  url?: string;
  /** The deployment's own id (`dpl_…`), on the shapes that print it next to the URL. */
  id?: string;
  deployment?: { id?: string; url?: string };
}

const vercelDeploy: Deployer = {
  async deploy(ctx, target) {
    const args = ['deploy', ...(target === 'production' ? ['--prod'] : []), '--yes', '--non-interactive', '--format', 'json'];
    const s = await session(ctx);
    const env = deployEnv(ctx);
    if (s.kind === 'cli') {
      const org = orgId(ctx);
      if (org?.startsWith('team_')) args.push('--scope', org);
    } else if (s.kind === 'token') {
      if (!s.cliInstalled) throw cliMissing();
      // The CLI reads VERCEL_TOKEN from its environment: never `--token` (argv is world-readable).
      // VERCEL_ORG_ID/VERCEL_PROJECT_ID in deployEnv pin the scope.
      env.VERCEL_TOKEN = s.token.reveal();
    }
    let r;
    try {
      r = await ctx.exec('vercel', args, { cwd: ctx.cwd, env, timeoutMs: DEPLOY_TIMEOUT });
    } catch (e) {
      if (/command not found|ENOENT/i.test((e as Error).message)) throw cliMissing();
      throw new VercelError(`Could not run \`vercel deploy\` (${(e as Error).message}). Update the CLI with \`npm i -g vercel@latest\` in your terminal and retry.`);
    }
    const j = parseJson<DeployJson>(r.stdout.trim());
    if (r.code !== 0 || j?.status === 'error') {
      const why = j?.message ?? (r.stderr.trim().split('\n').slice(-3).join(' ') || `exit ${r.code}`);
      const next = isBuildFailure(j?.reason)
        ? 'Fix the build error and deploy again; run `vercel inspect --logs <deployment-url>` in your terminal for full build logs.'
        : 'Fix the cause above and deploy again (if it was a build error, `vercel inspect --logs <deployment-url>` in your terminal shows the full logs).';
      throw new VercelError(`vercel deploy (${target}) failed${j?.reason ? ` (${j.reason})` : ''}: ${why.slice(0, 400)}. ${next}`, undefined, j?.reason);
    }
    const out = j?.deployment ?? j;
    const printed = normaliseUrl(out?.url);
    const url = printed ?? lastVercelUrl(r.stdout);
    if (!url) throw new VercelError('vercel deploy succeeded but printed no deployment URL; check `vercel ls` in your terminal.');
    ctx.log.info(`vercel: deployed ${target} → ${url} (this unique URL is protected by default; probe the production domain instead)`);
    // The provider's own identity for THIS deployment (`deployment.id` in the non-interactive
    // envelope, `id` on the older plain object). Output that carried only a URL carries no identity:
    // leave it unset rather than deriving one from the URL.
    const id = printed ? out?.id?.trim() : undefined;
    return id ? { url, id } : { url };
  },
};

function cliMissing(): VercelError {
  return new VercelError(`The Vercel CLI is not installed, and deploys run through it (VERCEL_TOKEN only covers API calls): ${INSTALL_CLI}, then retry.`, undefined, 'cli_missing');
}

function isBuildFailure(reason: string | undefined): boolean {
  return !!reason && /build/i.test(reason);
}

/** Pin the deploy to the project golive selected, so the CLI never auto-links/creates by dir name. */
function deployEnv(ctx: Ctx): Record<string, string> {
  const env: Record<string, string> = { NO_COLOR: '1' };
  const projectId = ctx.state.resource('vercel.projectId') ?? readLinkFile(ctx)?.projectId;
  const org = orgId(ctx);
  if (projectId && org) {
    env.VERCEL_PROJECT_ID = projectId;
    env.VERCEL_ORG_ID = org;
  }
  return env;
}

function normaliseUrl(u: string | undefined): string | null {
  if (!u) return null;
  return (/^https?:\/\//.test(u) ? u : `https://${u}`).replace(/\/+$/, '');
}

function lastVercelUrl(stdout: string): string | null {
  const lines = stdout.split('\n').map((l) => l.trim()).filter((l) => /^https:\/\/\S+\.vercel\.app\/?$/.test(l));
  return lines.length ? lines[lines.length - 1]!.replace(/\/+$/, '') : null;
}

// ── Adapter ──────────────────────────────────────────────────────────────────────────────────

export const vercelAdapter: Adapter = {
  id: 'vercel',
  title: 'Vercel',
  axes: ['hosting'],
  automated: true,
  detect(d) {
    if (d.providers.hosting?.includes('vercel')) return true;
    return Object.keys(d.configs).some((k) => k === 'vercel.json' || k.startsWith('.vercel/') || k === '.vercel');
  },
  auth,
  capabilities: {
    project: vercelProject,
    env: vercelEnv,
    url: vercelUrl,
    deploy: vercelDeploy,
    domain: vercelDomain,
    // No `release` capability: this adapter has no read of which deployment production currently
    // serves (only aliases, which a promotion cannot be proven against) and no promote/rollback call
    // golive has exercised, so promotion and rollback are refused/skipped with that reason rather than
    // acting blind — see docs/PROVIDERS.md.
  },
};

// Building blocks for links/checks that need them directly.
export { vercelApi, VercelError } from './vercel-api.js';
export { vercelProject, vercelEnv, vercelUrl, vercelDeploy, vercelDomain };
