import { beforeEach, describe, expect, it } from 'vitest';
import { netlifyAdapter } from '../src/adapters/netlify.js';
import { NETLIFY_API } from '../src/adapters/netlify-api.js';
import { netlifyPublicAccessCheck } from '../src/checks/netlify-public-access.js';
import { netlifyVisibilityLink } from '../src/links/netlify-visibility.js';
import { deployLink } from '../src/links/deploy.js';
import { ALL_CHECKS } from '../src/checks/all.js';
import { ALL_LINKS } from '../src/links/all.js';
import { buildPlan } from '../src/core/plan.js';
import { runCheck } from '../src/core/runner.js';
import { emptyState } from '../src/core/state.js';
import { _resetSecretRegistry } from '../src/core/secret.js';
import type { Http, HttpRequest } from '../src/core/types.js';
import { mockExec, mockHttp, testCtx } from './helpers.js';

const SITE = '11111111-1111-4111-8111-111111111111';
const ORIGIN = 'https://example-app.netlify.app';
const BODY_SECRET = 'unregistered-response-credential-do-not-echo';
const LOCATION_SECRET = 'unregistered-redirect-credential-do-not-echo';
const TOKEN = 'fake-netlify-token-only-for-mocks';

function setup(over: { status?: number; location?: string; site?: Record<string, unknown>; deploy?: Record<string, unknown>; loggedIn?: boolean; production?: boolean; hosting?: string; fetchThrows?: boolean; deployed?: boolean } = {}) {
  const rawSite = { id: SITE, name: 'example-app', account_id: 'account1', account_slug: 'example-team', ssl_url: ORIGIN, published_deploy: { id: 'deploy1' }, ...over.site };
  const rawDeploy = { id: 'deploy1', site_id: SITE, state: 'ready', context: 'production', draft: false, deploy_ssl_url: 'https://deploy1--example-app.netlify.app', ...over.deploy };
  const ex = mockExec([
    ['netlify api getCurrentUser', { code: over.loggedIn === false ? 1 : 0, stdout: JSON.stringify({ id: 'user1' }) }],
    ['netlify api getSiteDeploy', { stdout: JSON.stringify(rawDeploy) }],
    ['netlify api getSite', { stdout: JSON.stringify(rawSite) }],
  ]);
  let status = over.status ?? 200;
  const h = mockHttp([
    ['GET', `${NETLIFY_API}/user`, () => ({ json: { id: 'user1' } })],
    ['GET', ORIGIN, () => {
      if (over.fetchThrows) throw new Error(BODY_SECRET);
      return { status, text: BODY_SECRET };
    }],
  ]);
  const http: Http = async <T>(req: HttpRequest) => {
    const response = await h.http<T>(req);
    return req.url === ORIGIN ? { ...response, headers: { ...(over.location ? { location: over.location } : {}), 'set-cookie': BODY_SECRET } } : response;
  };
  const state = emptyState();
  state.resources = { 'netlify.siteId': SITE, 'netlify.accountId': 'account1' };
  if (over.deployed) state.resources['deployed:production'] = '2026-09-23T00:00:00.000Z';
  const ctx = testCtx({
    exec: ex.run, http, state, adapters: [netlifyAdapter], tokens: { NETLIFY_AUTH_TOKEN: TOKEN },
    config: { stack: { hosting: over.hosting ?? 'netlify' }, projects: { hosting: SITE }, targets: over.production === false ? ['preview'] : ['production'], domain: 'not-confirmed.invalid' },
  });
  return { ctx, ex, h, setStatus: (next: number) => { status = next; } };
}
function siteCalls(h: ReturnType<typeof mockHttp>) { return h.calls.filter(call => call.url === ORIGIN); }

beforeEach(() => { _resetSecretRegistry(); });

describe('Netlify anonymous production access', () => {
  it('registers independent verification and planning without adding a deployment verifier', async () => {
    expect(ALL_CHECKS).toContain(netlifyPublicAccessCheck);
    expect(ALL_LINKS).toContain(netlifyVisibilityLink);
    const { ctx } = setup();
    const deployment = await deployLink.plan(ctx);
    expect(deployment!.steps[0]!.verifyWith).not.toContain('netlify-public-access');
  });

  it('probes only the provider-confirmed published homepage without credentials or cookies', async () => {
    const { ctx, h, ex } = setup();
    const outcome = await runCheck(ctx, netlifyPublicAccessCheck);
    expect(outcome.status).toBe('pass');
    expect(outcome.evidence.join(' ')).toContain('homepage access only');
    expect(siteCalls(h)).toEqual([{ method: 'GET', url: ORIGIN, headers: {}, body: undefined }]);
    expect(h.calls.some(call => call.url.includes('not-confirmed.invalid'))).toBe(false);
    expect(ex.calls.every(call => call.args[0] === 'api')).toBe(true);
    expect(JSON.stringify(outcome)).not.toContain(BODY_SECRET);
    expect(JSON.stringify(outcome)).not.toContain(TOKEN);
  });

  it.each([401, 403])('fails HTTP %i with an exact-site handoff preserving private previews', async status => {
    const { ctx, h } = setup({ status });
    const outcome = await runCheck(ctx, netlifyPublicAccessCheck);
    const plan = await buildPlan(ctx, [netlifyVisibilityLink], { warnings: [], unmappedEnv: [] });
    expect(outcome.status).toBe('fail');
    expect(outcome.fix).toContain('Private and choose Applies to: Previews only');
    expect(plan.steps).toEqual([]);
    expect(plan.handoffs).toEqual([expect.objectContaining({
      id: `netlify:public-access:${SITE}`, blocking: true, verifiedBy: 'netlify-public-access',
      url: 'https://app.netlify.com/projects/example-app/configuration/general/#project-visibility',
    })]);
    expect(plan.handoffs[0]!.action).toContain(SITE);
    expect(plan.handoffs[0]!.action).toContain('Do not select a setting that exposes previews or change team defaults');
    expect(h.calls.every(call => call.method === 'GET')).toBe(true);
    expect(JSON.stringify({ outcome, plan })).not.toContain(BODY_SECRET);
  });

  it('recognizes the Netlify edge-access redirect without following or exposing it', async () => {
    const { ctx, h } = setup({ status: 302, location: `https://app.netlify.com/edge-access?token=${LOCATION_SECRET}` });
    const result = await runCheck(ctx, netlifyPublicAccessCheck);
    expect(result.status).toBe('fail');
    expect(result.evidence.join(' ')).toContain('Netlify access control');
    expect(siteCalls(h)).toHaveLength(1);
    expect(h.calls.some(call => call.url.startsWith('https://app.netlify.com'))).toBe(false);
    expect(JSON.stringify(result)).not.toContain(LOCATION_SECRET);
    expect(JSON.stringify(result)).not.toContain(BODY_SECRET);
  });

  it.each([
    `https://foreign.invalid/?token=${LOCATION_SECRET}`,
    `https://app.netlify.com.evil.invalid/edge-access?token=${LOCATION_SECRET}`,
    `https://app.netlify.com/other?token=${LOCATION_SECRET}`,
    `/dashboard?token=${LOCATION_SECRET}`,
    'http://[invalid',
    undefined,
  ])('keeps an ordinary, foreign or malformed redirect unverified without UI mutations', async location => {
    const { ctx, h } = setup({ status: 302, location });
    const result = await runCheck(ctx, netlifyPublicAccessCheck);
    expect(result.status).toBe('warn');
    expect(result.evidence.join(' ')).toContain('No redirect was followed');
    expect(await netlifyVisibilityLink.plan(ctx)).toBeNull();
    expect(siteCalls(h)).toHaveLength(2);
    expect(h.calls.every(call => call.url === ORIGIN || call.url === `${NETLIFY_API}/user`)).toBe(true);
    expect(JSON.stringify(result)).not.toContain(LOCATION_SECRET);
  });

  it.each([
    { site: { published_deploy: null } },
    { deploy: { state: 'building' } },
    { deploy: { site_id: 'different-site' } },
    { deploy: { context: 'deploy-preview', draft: true } },
    { site: { account_id: 'different-owner' } },
    { loggedIn: false },
  ])('does not probe an unpublished, unowned or unconfirmed production URL: %j', async over => {
    const { ctx, h } = setup(over);
    expect((await runCheck(ctx, netlifyPublicAccessCheck)).status).toBe('skip');
    expect(await netlifyVisibilityLink.plan(ctx)).toBeNull();
    expect(siteCalls(h)).toHaveLength(0);
  });

  it.each([{ production: false }, { hosting: 'vercel' }, { hosting: 'guided-host' }])('leaves other providers and preview-only targets unchanged: %j', async over => {
    const { ctx, h, ex } = setup(over);
    expect(netlifyPublicAccessCheck.applies(ctx)).toBe(false);
    expect((await netlifyPublicAccessCheck.run(ctx)).status).toBe('skip');
    expect(await netlifyVisibilityLink.plan(ctx)).toBeNull();
    expect(h.calls).toHaveLength(0);
    expect(ex.calls).toHaveLength(0);
  });

  it('reports network failure without echoing errors or claiming visibility is the cause', async () => {
    const { ctx } = setup({ fetchThrows: true });
    const result = await runCheck(ctx, netlifyPublicAccessCheck);
    expect(result.status).toBe('warn');
    expect(JSON.stringify(result)).not.toContain(BODY_SECRET);
    expect(await netlifyVisibilityLink.plan(ctx)).toBeNull();
  });

  it('fails an unavailable app without recommending a visibility change', async () => {
    const { ctx } = setup({ status: 500 });
    const result = await runCheck(ctx, netlifyPublicAccessCheck);
    expect(result.status).toBe('fail');
    expect(result.fix).toContain('does not identify a visibility setting problem');
    expect(await netlifyVisibilityLink.plan(ctx)).toBeNull();
  });

  it('keeps an existing successful deployment and verifies recovery without redeployment', async () => {
    const { ctx, setStatus, ex } = setup({ status: 401, deployed: true });
    const before = ctx.state.get();
    const plan = await buildPlan(ctx, [deployLink, netlifyVisibilityLink], { warnings: [], unmappedEnv: [] });
    expect(plan.steps).toEqual([]);
    expect(plan.handoffs[0]!.verifiedBy).toBe(netlifyPublicAccessCheck.id);
    expect((await runCheck(ctx, netlifyPublicAccessCheck)).status).toBe('fail');
    setStatus(200);
    expect((await runCheck(ctx, netlifyPublicAccessCheck)).status).toBe('pass');
    expect(await netlifyVisibilityLink.plan(ctx)).toBeNull();
    expect(await deployLink.plan(ctx)).toBeNull();
    expect(ctx.state.get()).toEqual(before);
    expect(ex.calls.every(call => call.args[0] === 'api')).toBe(true);
  });
});
