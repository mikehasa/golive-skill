import { describe, it, expect, beforeEach } from 'vitest';
import { posthogAdapter, analyticsOf, posthogTiming, PosthogError, PROJECT_ID_KEY, ORGANIZATION_ID_KEY, CREATED_PROJECT_KEY } from '../../src/adapters/posthog.js';
import { _resetSecretRegistry, Secret } from '../../src/core/secret.js';
import { tokenHowTo } from '../../src/core/credentials.js';
import { mockHttp, testCtx, type HttpCall } from '../helpers.js';
import type { Ctx, HttpRequest, ShipConfig } from '../../src/core/types.js';

beforeEach(() => _resetSecretRegistry());

// Scanner-shaped literals are split into fragments, like the other fakes: the concatenated value is
// what the tests exercise, and no contiguous token shape sits in the tree.
const KEY = 'phx' + '_FAKEpersonalKEYvalue0123456789';
const TOKEN = 'phc' + '_FAKEposthogPUBLICtoken0123456789';
const TOKEN2 = 'phc' + '_FAKEposthogPUBLICtokenSECOND987654';
const US = 'https://us.posthog.com';
const EU = 'https://eu.posthog.com';
const US_INGEST = 'https://us.i.posthog.com';
const EU_INGEST = 'https://eu.i.posthog.com';
const ORG = 'org-1';

const project = analyticsOf(posthogAdapter)!;
const linker = posthogAdapter.capabilities.project!;

const orgs = () => ({ json: { results: [{ id: ORG, name: 'Acme' }] } });
const projectRow = (over: Record<string, unknown> = {}) => ({ id: 42, name: 'shop', organization: ORG, api_token: TOKEN, ...over });

function ctx(config: Partial<ShipConfig> = {}, tokens: Record<string, string> = { POSTHOG_API_KEY: KEY }, h = mockHttp([])): Ctx & { logs: string[] } {
  return testCtx({ config, tokens, http: h.http });
}

function paths(calls: HttpCall[]): string[] {
  return calls.map((c) => `${c.method} ${c.url.replace(`${US}`, '').replace(`${EU}`, '')}`);
}

describe('posthog adapter: auth', () => {
  it('proves the key with GET /api/organizations/ and names the region and organization', async () => {
    const h = mockHttp([['GET', `${US}/api/organizations/`, orgs]]);
    const a = await posthogAdapter.auth(ctx({}, { POSTHOG_API_KEY: KEY }, h));
    expect(a).toEqual({ ok: true, via: `POSTHOG_API_KEY env (us, Acme)` });
    expect(h.calls[0]!.headers.authorization).toBe(`Bearer ${KEY}`);
  });

  it('without a credential: instructions via the credential helper, never the value', async () => {
    const a = await posthogAdapter.auth(ctx({}, {}));
    expect(a.ok).toBe(false);
    expect(a.howToFix).toContain(tokenHowTo('POSTHOG_API_KEY'));
    expect(a.howToFix).toContain('us.posthog.com/settings/user-api-keys');
    expect(a.howToFix).toMatch(/organization:read/);
    expect(a.howToFix).not.toMatch(/export POSTHOG_API_KEY=|in your shell/);
  });

  it('maps a rejected key (401) to an actionable message that never echoes it', async () => {
    const h = mockHttp([['GET', `${US}/api/organizations/`, () => ({ status: 401, json: { type: 'authentication_error', code: 'invalid_token', detail: 'Personal API key invalid' } })]]);
    const a = await posthogAdapter.auth(ctx({}, { POSTHOG_API_KEY: KEY }, h));
    expect(a.ok).toBe(false);
    expect(a.howToFix).toMatch(/rejected/);
    expect(a.howToFix).toContain(tokenHowTo('POSTHOG_API_KEY'));
    expect(a.howToFix).not.toContain(KEY);
  });

  it('refuses a key that can see no organization, and one that sees several', async () => {
    const none = mockHttp([['GET', `${US}/api/organizations/`, () => ({ json: { results: [] } })]]);
    const a = await posthogAdapter.auth(ctx({}, { POSTHOG_API_KEY: KEY }, none));
    expect(a.ok).toBe(false);
    expect(a.howToFix).toMatch(/can see no PostHog organization/);

    const many = mockHttp([['GET', `${US}/api/organizations/`, () => ({ json: { results: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }] } })]]);
    const b = await posthogAdapter.auth(ctx({}, { POSTHOG_API_KEY: KEY }, many));
    expect(b.ok).toBe(false);
    expect(b.howToFix).toMatch(/exactly one PostHog organization/);
    expect(b.howToFix).toContain('Scope the personal API key');
  });
  it('detects the SDK in a repo', () => {
    expect(posthogAdapter.detect!({ providers: { monitoring: ['posthog'] } } as never)).toBe(true);
    expect(posthogAdapter.detect!({ providers: { monitoring: ['sentry'] } } as never)).toBe(false);
  });
});

describe('posthog adapter: projects', () => {
  it('resolves the recorded project by id, with its organization scope', async () => {
    const h = mockHttp([['GET', `${US}/api/organizations/`, orgs], ['GET', `${US}/api/organizations/${ORG}/projects/`, () => ({ json: { results: [projectRow()] } })], ['GET', `${US}/api/organizations/${ORG}/projects/42/`, () => ({ json: projectRow() })]]);
    const c = ctx({ projects: { monitoring: '42' } }, { POSTHOG_API_KEY: KEY }, h);
    expect(await linker.current(c)).toEqual({ id: '42', name: 'shop', scope: { kind: 'organization', id: ORG, name: 'Acme' } });
    expect(paths(h.calls)).toEqual(['GET /api/organizations/', `GET /api/organizations/${ORG}/projects/`, `GET /api/organizations/${ORG}/projects/42/`]);
  });

  it('resolves by name and refuses an ambiguous or missing selection instead of guessing', async () => {
    const two = mockHttp([['GET', `${US}/api/organizations/`, orgs], ['GET', `${US}/api/organizations/${ORG}/projects/`, () => ({ json: { results: [projectRow(), projectRow({ id: 43 })] } })]]);
    await expect(linker.resolve!(ctx({}, { POSTHOG_API_KEY: KEY }, two), 'shop')).rejects.toThrow(/2 projects matching "shop"/);

    const none = mockHttp([['GET', `${US}/api/organizations/`, orgs], ['GET', `${US}/api/organizations/${ORG}/projects/`, () => ({ json: { results: [] } })]]);
    await expect(linker.resolve!(ctx({}, { POSTHOG_API_KEY: KEY }, none), 'shop')).rejects.toThrow(/no project matching "shop"/);
  });

  it('leaves a project pending deletion out of the candidates golive could adopt', async () => {
    const h = mockHttp([
      ['GET', `${US}/api/organizations/`, orgs],
      ['GET', `${US}/api/organizations/${ORG}/projects/`, () => ({ json: { results: [projectRow(), projectRow({ id: 43, name: 'old', is_pending_deletion: true })] } })],
    ]);
    const c = ctx({}, { POSTHOG_API_KEY: KEY }, h);
    expect((await linker.candidates(c)).map((p) => p.id)).toEqual(['42']);
    expect(c.logs.join('\n')).toMatch(/pending deletion; leaving it out/);
  });

  it('selecting a project records it without a creation marker, and clears a stale one', async () => {
    const h = mockHttp([
      ['GET', `${US}/api/organizations/`, orgs],
      ['GET', `${US}/api/organizations/${ORG}/projects/`, () => ({ json: { results: [projectRow()] } })],
      ['GET', `${US}/api/organizations/${ORG}/projects/42/`, () => ({ json: projectRow() })],
    ]);
    const c = testCtx({ config: { projects: { monitoring: 'shop' } }, tokens: { POSTHOG_API_KEY: KEY }, http: h.http, state: { ...{ version: 1, resources: { [CREATED_PROJECT_KEY]: '41' }, secrets: {}, steps: {} } } });
    await linker.current(c);
    const p = await linker.select(c, 'shop');
    expect(p.id).toBe('42');
    expect(c.state.resource(PROJECT_ID_KEY)).toBe('42');
    expect(c.state.resource(ORGANIZATION_ID_KEY)).toBe(ORG);
    // A marker naming another project must not survive: teardown deletes only what it names.
    expect(c.state.resource(CREATED_PROJECT_KEY)).toBeUndefined();
  });

  it('creates a project named after the repo, records the creation marker and re-reads it', async () => {
    const h = mockHttp([
      ['GET', `${US}/api/organizations/`, orgs],
      ['GET', `${US}/api/organizations/${ORG}/projects/`, () => ({ json: { results: [] } })],
      ['POST', `${US}/api/organizations/${ORG}/projects/`, () => ({ status: 201, json: { id: 43, name: 'shop', organization: ORG, api_token: TOKEN2 } })],
      ['GET', `${US}/api/organizations/${ORG}/projects/43/`, () => ({ json: { id: 43, name: 'shop', organization: ORG, api_token: TOKEN2 } })],
    ]);
    const c = ctx({}, { POSTHOG_API_KEY: KEY }, h);
    const target = await linker.creationTarget!(c);
    expect(target).toEqual({ scope: { kind: 'organization', id: ORG, name: 'Acme' } });
    const p = await linker.create!(c, 'shop', target);
    expect(p).toEqual({ id: '43', name: 'shop', scope: { kind: 'organization', id: ORG, name: 'Acme' } });
    expect(h.calls.find((x) => x.method === 'POST')!.body).toEqual({ name: 'shop' });
    expect(c.state.resource(PROJECT_ID_KEY)).toBe('43');
    expect(c.state.resource(CREATED_PROJECT_KEY)).toBe('43');
    expect(c.state.resource('posthog.projectName')).toBe('shop');
  });

  it('never creates a duplicate: an existing same-named project needs explicit adoption', async () => {
    const h = mockHttp([
      ['GET', `${US}/api/organizations/`, orgs],
      ['GET', `${US}/api/organizations/${ORG}/projects/`, () => ({ json: { results: [projectRow({ name: 'shop' })] } })],
    ]);
    const c = ctx({}, { POSTHOG_API_KEY: KEY }, h);
    await expect(linker.create!(c, 'shop', await linker.creationTarget!(c))).rejects.toThrow(/already exists in this organization/);
    expect(h.calls.some((x) => x.method === 'POST')).toBe(false);
  });

  it('refuses to create into a destination that changed after approval', async () => {
    const h = mockHttp([['GET', `${US}/api/organizations/`, orgs]]);
    const c = ctx({}, { POSTHOG_API_KEY: KEY }, h);
    await expect(linker.create!(c, 'shop', { scope: { kind: 'organization', id: 'other' } })).rejects.toThrow(/destination changed after approval/);
    expect(h.calls.some((x) => x.method === 'POST')).toBe(false);
  });

  it('deletes only a project golive created, then confirms it through the provider read', async () => {
    const h = mockHttp([
      ['GET', `${US}/api/organizations/`, orgs],
      ['GET', `${US}/api/organizations/${ORG}/projects/43/`, () => ({ json: { id: 43, name: 'shop', organization: ORG, is_pending_deletion: true } })],
      ['DELETE', `${US}/api/organizations/${ORG}/projects/43/`, () => ({ status: 204, text: '' })],
    ]);
    const state = { version: 1 as const, resources: { [PROJECT_ID_KEY]: '43', 'posthog.projectName': 'shop', [CREATED_PROJECT_KEY]: '43' }, secrets: {}, steps: {} };
    const c = testCtx({ tokens: { POSTHOG_API_KEY: KEY }, http: h.http, state });
    expect(await linker.remove!(c)).toEqual({ removed: true });
    expect(paths(h.calls)).toEqual(['GET /api/organizations/', `DELETE /api/organizations/${ORG}/projects/43/`, `GET /api/organizations/${ORG}/projects/43/`]);
    expect(c.state.resource(PROJECT_ID_KEY)).toBeUndefined();
    expect(c.state.resource(CREATED_PROJECT_KEY)).toBeUndefined();
  });

  it('leaves an adopted project alone and reports a provider that kept it', async () => {
    const adopted = mockHttp([]);
    const c = testCtx({ tokens: { POSTHOG_API_KEY: KEY }, http: adopted.http, state: { version: 1, resources: { [PROJECT_ID_KEY]: '43' }, secrets: {}, steps: {} } });
    expect(await linker.remove!(c)).toMatchObject({ removed: false, reason: expect.stringContaining('not created by golive') });
    expect(adopted.calls).toEqual([]);

    const kept = mockHttp([
      ['GET', `${US}/api/organizations/`, orgs],
      ['DELETE', `${US}/api/organizations/${ORG}/projects/43/`, () => ({ status: 204, text: '' })],
      ['GET', `${US}/api/organizations/${ORG}/projects/43/`, () => ({ json: { id: 43, name: 'shop', organization: ORG } })],
    ]);
    const c2 = testCtx({ tokens: { POSTHOG_API_KEY: KEY }, http: kept.http, state: { version: 1, resources: { [PROJECT_ID_KEY]: '43', [CREATED_PROJECT_KEY]: '43' }, secrets: {}, steps: {} } });
    expect(await linker.remove!(c2)).toMatchObject({ removed: false, reason: expect.stringContaining('still reports the project as live') });
    expect(c2.state.resource(PROJECT_ID_KEY)).toBe('43');
  });

  it('answers a three-state project read for a teardown confirmation', async () => {
    const h = mockHttp([
      ['GET', `${US}/api/organizations/`, orgs],
      ['GET', `${US}/api/organizations/${ORG}/projects/42/`, () => ({ json: projectRow({ is_pending_deletion: true }) })],
    ]);
    const c = ctx({}, { POSTHOG_API_KEY: KEY }, h);
    expect(await project.projectState!(c, '42')).toBe('pending');
  });
});

describe('posthog adapter: capture and read-back', () => {
  it('reads the PUBLIC project token (never a Secret) from the project object', async () => {
    const h = mockHttp([
      ['GET', `${US}/api/organizations/`, orgs],
      ['GET', `${US}/api/organizations/${ORG}/projects/42/`, () => ({ json: projectRow() })],
    ]);
    const c = ctx({}, { POSTHOG_API_KEY: KEY }, h);
    const token = await project.token(c, '42');
    expect(token).toBe(TOKEN);
    expect(token).not.toBeInstanceOf(Secret);
  });

  it('explains a project whose token the API does not return', async () => {
    const h = mockHttp([
      ['GET', `${US}/api/organizations/`, orgs],
      ['GET', `${US}/api/organizations/${ORG}/projects/42/`, () => ({ json: projectRow({ api_token: undefined }) })],
    ]);
    const c = ctx({}, { POSTHOG_API_KEY: KEY }, h);
    await expect(project.token(c, '42')).rejects.toThrow(/no ingestion token for project 42/);
  });

  it('sends one synthetic event to the ingestion host with no authorization header', async () => {
    const h = mockHttp([
      ['GET', `${US}/api/organizations/`, orgs],
      ['GET', `${US}/api/organizations/${ORG}/projects/42/`, () => ({ json: projectRow() })],
      ['POST', `${US_INGEST}/i/v0/e/`, () => ({ json: { status: 'Ok' } })],
    ]);
    const c = ctx({}, { POSTHOG_API_KEY: KEY }, h);
    const r = await project.capture(c, '42', { event: 'golive_ingest_check', distinctId: 'golive-verify', properties: { golive_marker: 'ab12cd34' } });
    expect(r).toEqual({ status: 200 });
    const call = h.calls.at(-1)!;
    expect(call.url).toBe(`${US_INGEST}/i/v0/e/`);
    expect(call.headers.authorization).toBeUndefined();
    expect(call.body).toEqual({ api_key: TOKEN, event: 'golive_ingest_check', distinct_id: 'golive-verify', properties: { golive_marker: 'ab12cd34' } });
  });

  it('reads the count back through HogQL, with the marker in a fixed-template query', async () => {
    const h = mockHttp([['POST', `${US}/api/projects/42/query/`, () => ({ json: { results: [[3]], columns: ['count()'] } })]]);
    const c = ctx({}, { POSTHOG_API_KEY: KEY }, h);
    const n = await project.count(c, '42', { event: 'golive_ingest_check', property: { key: 'golive_marker', value: 'ab12cd34' }, minutes: posthogTiming.queryMinutes });
    expect(n).toBe(3);
    const call = h.calls[0]!;
    expect(call.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(call.body).toEqual({
      query: { kind: 'HogQLQuery', query: "select count() from events where event = 'golive_ingest_check' and timestamp > now() - interval 15 minute and properties.golive_marker = 'ab12cd34'" },
      refresh: 'force_blocking',
    });
  });

  it('returns 0 for a not-yet-visible event, and refuses a malformed answer', async () => {
    const none = mockHttp([['POST', `${US}/api/projects/42/query/`, () => ({ json: { results: [[0]] } })]]);
    expect(await project.count(ctx({}, { POSTHOG_API_KEY: KEY }, none), '42', { event: 'e', minutes: 15 })).toBe(0);

    const odd = mockHttp([['POST', `${US}/api/projects/42/query/`, () => ({ json: { results: [] } })]]);
    await expect(project.count(ctx({}, { POSTHOG_API_KEY: KEY }, odd), '42', { event: 'e', minutes: 15 })).rejects.toThrow(/unexpected event count/);
  });

  it('refuses a property name that could not be a HogQL identifier', async () => {
    await expect(project.count(ctx(), '42', { event: 'e', property: { key: 'a; drop table', value: 'x' }, minutes: 15 })).rejects.toThrow(/invalid property name/);
  });
});

describe('posthog adapter: region and error mapping', () => {
  const euConfig: Partial<ShipConfig> = { posthog: { region: 'eu' } };

  it('follows posthog.region for the control plane and the ingestion host', async () => {
    const h = mockHttp([['GET', `${EU}/api/organizations/`, orgs]]);
    const a = await posthogAdapter.auth(ctx(euConfig, { POSTHOG_API_KEY: KEY }, h));
    expect(a.via).toContain('(eu, Acme)');

    const captureHttp = mockHttp([
      ['GET', `${EU}/api/organizations/`, orgs],
      ['GET', `${EU}/api/organizations/${ORG}/projects/42/`, () => ({ json: projectRow() })],
      ['POST', `${EU_INGEST}/i/v0/e/`, () => ({ json: { status: 'Ok' } })],
    ]);
    await project.capture(ctx(euConfig, { POSTHOG_API_KEY: KEY }, captureHttp), '42', { event: 'e', distinctId: 'd' });
    expect(captureHttp.calls.at(-1)!.url).toBe(`${EU_INGEST}/i/v0/e/`);
  });

  it('maps a plan limit on creating a project to what the human can do about it', async () => {
    const h = mockHttp([
      ['GET', `${US}/api/organizations/`, orgs],
      ['GET', `${US}/api/organizations/${ORG}/projects/`, () => ({ json: { results: [] } })],
      ['POST', `${US}/api/organizations/${ORG}/projects/`, () => ({ status: 403, json: { type: 'validation_error', code: 'project_limit', detail: 'Project limit reached for the organization' } })],
    ]);
    const c = ctx({}, { POSTHOG_API_KEY: KEY }, h);
    const err = (await linker.create!(c, 'shop', await linker.creationTarget!(c)).catch((e: Error) => e)) as Error;
    expect(err.message).toMatch(/free plans allow one/);
    expect(err.message).toMatch(/projects\.monitoring/);
    expect(err.message).toMatch(/upgrade the plan yourself/);
    expect(err.message).not.toContain(KEY);
  });

  it('maps a missing scope (403) to the scopes the key needs', async () => {
    const h = mockHttp([['GET', `${US}/api/organizations/`, () => ({ status: 403, json: { code: 'permission_denied', detail: 'You do not have permission to perform this action.' } })]]);
    const a = await posthogAdapter.auth(ctx({}, { POSTHOG_API_KEY: KEY }, h));
    expect(a.ok).toBe(false);
    expect(a.howToFix).toMatch(/organization:read/);
    expect(a.howToFix).not.toContain(KEY);
  });

  it('maps 404, 429 and an unreachable host without echoing the credential', async () => {
    // A count read against a project that is gone answers 404: the mapped message names "not found".
    const gone = mockHttp([['POST', `${US}/api/projects/42/query/`, () => ({ status: 404, json: { detail: 'Project not found.' } })]]);
    await expect(project.count(ctx({}, { POSTHOG_API_KEY: KEY }, gone), '42', { event: 'e', minutes: 15 })).rejects.toThrow(/not found/);

    const limited = mockHttp([['GET', `${US}/api/organizations/`, () => ({ status: 429, json: { detail: 'throttled' } })]]);
    const a = await posthogAdapter.auth(ctx({}, { POSTHOG_API_KEY: KEY }, limited));
    expect(a.ok).toBe(false);
    expect(a.howToFix).toMatch(/rate-limiting/);
    expect(a.howToFix).not.toContain(KEY);

    // A transport failure is reported with the error's own message (redacted), never with the key.
    const dead = mockHttp([['GET', `${US}/api/organizations/`, () => { throw new Error(`connect ECONNREFUSED (${KEY})`); }]]);
    const err = await posthogAdapter.auth(ctx({}, { POSTHOG_API_KEY: KEY }, dead));
    expect(err.ok).toBe(false);
    expect(err.howToFix ?? '').not.toContain(KEY);
  });

  it('exposes its refusals as HttpError subclasses with a status', async () => {
    const h = mockHttp([['GET', `${US}/api/organizations/`, () => ({ status: 401, json: { code: 'invalid_token', detail: 'nope' } })]]);
    const c = ctx({}, { POSTHOG_API_KEY: KEY }, h);
    const err = (await linker.candidates(c).catch((e: Error) => e)) as PosthogError & { status?: number };
    expect(err).toBeInstanceOf(Error);
    expect((err as { status?: number }).status).toBe(401);
  });

  it('keeps the credential inside the Authorization header only, never in a URL, body or result', async () => {
    const h = mockHttp([
      ['GET', `${US}/api/organizations/`, orgs],
      ['GET', `${US}/api/organizations/${ORG}/projects/`, () => ({ json: { results: [projectRow()] } })],
      ['GET', `${US}/api/organizations/${ORG}/projects/42/`, () => ({ json: projectRow() })],
    ]);
    const c = ctx({}, { POSTHOG_API_KEY: KEY }, h);
    const p = await linker.resolve!(c, '42');
    expect(JSON.stringify(p) + c.logs.join('\n')).not.toContain(KEY);
    for (const call of h.calls) {
      // The transport boundary is the only place a credential may appear.
      expect(call.url).not.toContain(KEY);
      expect(JSON.stringify(call.body ?? null)).not.toContain(KEY);
      if (call.headers.authorization !== undefined) expect(call.headers.authorization).toBe(`Bearer ${KEY}`);
    }
  });
});
