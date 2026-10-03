import { describe, it, expect, beforeEach } from 'vitest';
import {
  sentryAdapter,
  monitoringOf,
  SentryTeamChoiceError,
  PROJECT_ID_KEY,
  PROJECT_SLUG_KEY,
  PROJECT_NAME_KEY,
  ORGANIZATION_SLUG_KEY,
  CREATED_PROJECT_KEY,
  type MonitoringProvider,
} from '../../src/adapters/sentry.js';
import { parseDsn } from '../../src/adapters/sentry-api.js';
import { _resetSecretRegistry, Secret } from '../../src/core/secret.js';
import { tokenHowTo } from '../../src/core/credentials.js';
import { mockHttp, testCtx, type HttpCall } from '../helpers.js';
import type { Ctx, ShipConfig } from '../../src/core/types.js';

beforeEach(() => _resetSecretRegistry());

// Scanner-shaped literals are split into fragments, like the other fakes: the concatenated value is
// what the tests exercise, and no contiguous token shape sits in the tree.
const TOKEN = 'sntrys' + '_FAKEsentryAUTHtoken0123456789abcdef';
const PUBKEY = 'FAKEsentrypublicKEY0123456789abcd';
const PUBKEY2 = 'FAKEsentrypublicKEYROTATED98765432';
const DSN = `https://${PUBKEY}@o4505.ingest.us.sentry.io/4505123456`;
const US = 'https://us.sentry.io';
const EU = 'https://de.sentry.io';
const ORG = 'acme';
const ORG_ID = '4505';

const monitoring = monitoringOf(sentryAdapter)! as MonitoringProvider;
const linker = sentryAdapter.capabilities.project!;

const orgs = () => ({ json: [{ id: ORG_ID, slug: ORG, name: 'Acme' }] });
const teams = (...list: Array<{ id: string; slug: string; name: string }>) => ({ json: list });
const projectRow = (over: Record<string, unknown> = {}) => ({ id: 4505123456, slug: 'shop', name: 'shop', status: 'active', team: { id: '1', slug: 'platform', name: 'Platform' }, ...over });
const keyRow = (over: Record<string, unknown> = {}) => ({ id: 'key-1', isActive: true, dsn: { public: DSN, secret: `https://${PUBKEY}:secret@o4505.ingest.us.sentry.io/4505123456` }, ...over });

function ctx(config: Partial<ShipConfig> = {}, tokens: Record<string, string> = { SENTRY_AUTH_TOKEN: TOKEN }, h = mockHttp([])): Ctx & { logs: string[] } {
  return testCtx({ config, tokens, http: h.http });
}

function paths(calls: HttpCall[]): string[] {
  return calls.map((c) => `${c.method} ${c.url.replace(US, '').replace(EU, '')}`);
}

const state = (resources: Record<string, string>) => ({ version: 1 as const, resources, secrets: {}, steps: {} });

describe('sentry adapter: auth', () => {
  it('proves the token with GET /api/0/organizations/ and names the region and organization', async () => {
    const h = mockHttp([['GET', `${US}/api/0/organizations/`, orgs]]);
    const a = await sentryAdapter.auth(ctx({}, { SENTRY_AUTH_TOKEN: TOKEN }, h));
    expect(a).toEqual({ ok: true, via: `SENTRY_AUTH_TOKEN env (us, Acme)` });
    expect(h.calls[0]!.headers.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('without a credential: instructions via the credential helper, never the value', async () => {
    const a = await sentryAdapter.auth(ctx({}, {}));
    expect(a.ok).toBe(false);
    expect(a.howToFix).toContain(tokenHowTo('SENTRY_AUTH_TOKEN'));
    expect(a.howToFix).toContain('us.sentry.io/settings/account/api/auth-tokens');
    expect(a.howToFix).toMatch(/org:read/);
    expect(a.howToFix).not.toMatch(/export SENTRY_AUTH_TOKEN=|in your shell/);
  });

  it('maps a rejected token (401) to an actionable message that never echoes it', async () => {
    const h = mockHttp([['GET', `${US}/api/0/organizations/`, () => ({ status: 401, json: { detail: 'Invalid token' } })]]);
    const a = await sentryAdapter.auth(ctx({}, { SENTRY_AUTH_TOKEN: TOKEN }, h));
    expect(a.ok).toBe(false);
    expect(a.howToFix).toMatch(/rejected/);
    expect(a.howToFix).toContain(tokenHowTo('SENTRY_AUTH_TOKEN'));
    expect(a.howToFix).not.toContain(TOKEN);
  });

  it('refuses a token that can see no organization, and one that sees several', async () => {
    const none = mockHttp([['GET', `${US}/api/0/organizations/`, () => ({ json: [] })]]);
    const a = await sentryAdapter.auth(ctx({}, { SENTRY_AUTH_TOKEN: TOKEN }, none));
    expect(a.ok).toBe(false);
    expect(a.howToFix).toMatch(/can see no Sentry organization/);

    const many = mockHttp([['GET', `${US}/api/0/organizations/`, () => ({ json: [{ id: '1', slug: 'a', name: 'A' }, { id: '2', slug: 'b', name: 'B' }] })]]);
    const b = await sentryAdapter.auth(ctx({}, { SENTRY_AUTH_TOKEN: TOKEN }, many));
    expect(b.ok).toBe(false);
    expect(b.howToFix).toMatch(/exactly one Sentry organization/);
    expect(b.howToFix).toContain('Create an auth token');
  });

  it('names the other region when the host redirects', async () => {
    const h = mockHttp([['GET', `${US}/api/0/organizations/`, () => ({ status: 302, headers: { location: `${EU}/api/0/organizations/` }, text: '' })]]);
    const a = await sentryAdapter.auth(ctx({}, { SENTRY_AUTH_TOKEN: TOKEN }, h));
    expect(a.ok).toBe(false);
    expect(a.howToFix).toMatch(/redirected/);
    expect(a.howToFix).toMatch(/sentry\.region/);
  });

  it('detects the SDK in a repo', () => {
    expect(sentryAdapter.detect!({ providers: { monitoring: ['sentry'] } } as never)).toBe(true);
    expect(sentryAdapter.detect!({ providers: { monitoring: ['posthog'] } } as never)).toBe(false);
  });
});

describe('sentry adapter: projects', () => {
  it('resolves the recorded project by id, with its organization scope', async () => {
    const h = mockHttp([
      ['GET', `${US}/api/0/organizations/`, orgs],
      ['GET', `${US}/api/0/organizations/${ORG}/projects/`, () => ({ json: [projectRow()] })],
      ['GET', `${US}/api/0/projects/${ORG}/4505123456/`, () => ({ json: projectRow() })],
    ]);
    const c = ctx({ projects: { monitoring: '4505123456' } }, { SENTRY_AUTH_TOKEN: TOKEN }, h);
    expect(await linker.current(c)).toEqual({ id: '4505123456', name: 'shop', scope: { kind: 'organization', id: ORG_ID, name: 'Acme' } });
    expect(paths(h.calls)).toEqual(['GET /api/0/organizations/', `GET /api/0/organizations/${ORG}/projects/`, `GET /api/0/projects/${ORG}/4505123456/`]);
  });

  it('resolves by slug or name and refuses an ambiguous or missing selection instead of guessing', async () => {
    const bySlug = mockHttp([
      ['GET', `${US}/api/0/organizations/`, orgs],
      ['GET', `${US}/api/0/organizations/${ORG}/projects/`, () => ({ json: [projectRow({ slug: 'the-shop' })] })],
      ['GET', `${US}/api/0/projects/${ORG}/4505123456/`, () => ({ json: projectRow({ slug: 'the-shop' }) })],
    ]);
    expect((await linker.resolve!(ctx({}, { SENTRY_AUTH_TOKEN: TOKEN }, bySlug), 'the-shop')).id).toBe('4505123456');

    const two = mockHttp([
      ['GET', `${US}/api/0/organizations/`, orgs],
      ['GET', `${US}/api/0/organizations/${ORG}/projects/`, () => ({ json: [projectRow(), projectRow({ id: 4505999, slug: 'shop-2' })] })],
    ]);
    await expect(linker.resolve!(ctx({}, { SENTRY_AUTH_TOKEN: TOKEN }, two), 'shop')).rejects.toThrow(/2 projects matching "shop"/);

    const none = mockHttp([
      ['GET', `${US}/api/0/organizations/`, orgs],
      ['GET', `${US}/api/0/organizations/${ORG}/projects/`, () => ({ json: [] })],
    ]);
    await expect(linker.resolve!(ctx({}, { SENTRY_AUTH_TOKEN: TOKEN }, none), 'shop')).rejects.toThrow(/no project matching "shop"/);
  });

  it('leaves a project Sentry reports as scheduled for deletion out of the candidates golive could adopt', async () => {
    const h = mockHttp([
      ['GET', `${US}/api/0/organizations/`, orgs],
      ['GET', `${US}/api/0/organizations/${ORG}/projects/`, () => ({ json: [projectRow(), projectRow({ id: 4505999, slug: 'old', name: 'old', status: 'pending_deletion' })] })],
    ]);
    const c = ctx({}, { SENTRY_AUTH_TOKEN: TOKEN }, h);
    expect((await linker.candidates(c)).map((p) => p.id)).toEqual(['4505123456']);
    expect(c.logs.join('\n')).toMatch(/pending_deletion; leaving it out/);
  });

  it('selecting a project records it without a creation marker, and clears a stale one', async () => {
    const h = mockHttp([
      ['GET', `${US}/api/0/organizations/`, orgs],
      ['GET', `${US}/api/0/organizations/${ORG}/projects/`, () => ({ json: [projectRow()] })],
      ['GET', `${US}/api/0/projects/${ORG}/4505123456/`, () => ({ json: projectRow() })],
    ]);
    const c = testCtx({ config: { projects: { monitoring: 'shop' } }, tokens: { SENTRY_AUTH_TOKEN: TOKEN }, http: h.http, state: state({ [CREATED_PROJECT_KEY]: '4505000' }) });
    await linker.current(c);
    const p = await linker.select(c, 'shop');
    expect(p.id).toBe('4505123456');
    expect(c.state.resource(PROJECT_ID_KEY)).toBe('4505123456');
    expect(c.state.resource(PROJECT_SLUG_KEY)).toBe('shop');
    expect(c.state.resource(ORGANIZATION_SLUG_KEY)).toBe(ORG);
    // A marker naming another project must not survive: teardown deletes only what it names.
    expect(c.state.resource(CREATED_PROJECT_KEY)).toBeUndefined();
  });

  it('creates a project named after the repo in the approved team, records the creation marker and re-reads it', async () => {
    const h = mockHttp([
      ['GET', `${US}/api/0/organizations/`, orgs],
      ['GET', `${US}/api/0/organizations/${ORG}/teams/`, () => teams({ id: '1', slug: 'platform', name: 'Platform' })],
      ['GET', `${US}/api/0/organizations/${ORG}/projects/`, () => ({ json: [] })],
      ['POST', `${US}/api/0/teams/${ORG}/platform/projects/`, () => ({ status: 201, json: projectRow({ id: 4505777, slug: 'shop', name: 'shop' }) })],
      ['GET', `${US}/api/0/projects/${ORG}/4505777/`, () => ({ json: projectRow({ id: 4505777, slug: 'shop', name: 'shop' }) })],
    ]);
    const c = ctx({}, { SENTRY_AUTH_TOKEN: TOKEN }, h);
    const target = await linker.creationTarget!(c);
    expect(target).toEqual({ scope: { kind: 'organization', id: ORG_ID, name: 'Acme' }, region: 'us', team: 'platform' });
    const p = await linker.create!(c, 'shop', target);
    expect(p).toEqual({ id: '4505777', name: 'shop', scope: { kind: 'organization', id: ORG_ID, name: 'Acme' } });
    expect(h.calls.find((x) => x.method === 'POST')!.body).toEqual({ name: 'shop' });
    expect(c.state.resource(PROJECT_ID_KEY)).toBe('4505777');
    expect(c.state.resource(CREATED_PROJECT_KEY)).toBe('4505777');
    expect(c.state.resource(PROJECT_NAME_KEY)).toBe('shop');
  });

  it('refuses to create when the organization has several teams and golive.yaml names none', async () => {
    const h = mockHttp([
      ['GET', `${US}/api/0/organizations/`, orgs],
      ['GET', `${US}/api/0/organizations/${ORG}/teams/`, () => teams({ id: '1', slug: 'platform', name: 'Platform' }, { id: '2', slug: 'growth', name: 'Growth' })],
    ]);
    const c = ctx({}, { SENTRY_AUTH_TOKEN: TOKEN }, h);
    const err = (await linker.creationTarget!(c).catch((e: Error) => e)) as SentryTeamChoiceError;
    expect(err).toBeInstanceOf(SentryTeamChoiceError);
    expect(err.message).toMatch(/2 teams \(growth, platform\)/);
    expect(err.teams.map((t) => t.slug)).toEqual(['growth', 'platform']);
    expect(h.calls.some((x) => x.method === 'POST')).toBe(false);
  });

  it('uses sentry.team among several teams, and names the choices when it is wrong', async () => {
    const h = mockHttp([
      ['GET', `${US}/api/0/organizations/`, orgs],
      ['GET', `${US}/api/0/organizations/${ORG}/teams/`, () => teams({ id: '1', slug: 'platform', name: 'Platform' }, { id: '2', slug: 'growth', name: 'Growth' })],
    ]);
    const c = ctx({ sentry: { team: 'Growth' } }, { SENTRY_AUTH_TOKEN: TOKEN }, h);
    expect((await linker.creationTarget!(c)).team).toBe('growth');

    const bad = ctx({ sentry: { team: 'nope' } }, { SENTRY_AUTH_TOKEN: TOKEN }, h);
    const err = (await linker.creationTarget!(bad).catch((e: Error) => e)) as SentryTeamChoiceError;
    expect(err.message).toMatch(/no such team \(it has growth, platform\)/);
  });

  it('never creates a duplicate: an existing same-named project needs explicit adoption', async () => {
    const h = mockHttp([
      ['GET', `${US}/api/0/organizations/`, orgs],
      ['GET', `${US}/api/0/organizations/${ORG}/teams/`, () => teams({ id: '1', slug: 'platform', name: 'Platform' })],
      ['GET', `${US}/api/0/organizations/${ORG}/projects/`, () => ({ json: [projectRow()] })],
    ]);
    const c = ctx({}, { SENTRY_AUTH_TOKEN: TOKEN }, h);
    await expect(linker.create!(c, 'shop', await linker.creationTarget!(c))).rejects.toThrow(/already exists in this organization/);
    expect(h.calls.some((x) => x.method === 'POST')).toBe(false);
  });

  it('refuses to create into a destination that changed after approval', async () => {
    const h = mockHttp([
      ['GET', `${US}/api/0/organizations/`, orgs],
      ['GET', `${US}/api/0/organizations/${ORG}/teams/`, () => teams({ id: '1', slug: 'platform', name: 'Platform' })],
    ]);
    const c = ctx({}, { SENTRY_AUTH_TOKEN: TOKEN }, h);
    await expect(linker.create!(c, 'shop', { scope: { kind: 'organization', id: ORG_ID, name: 'Acme' }, region: 'us', team: 'growth' })).rejects.toThrow(/destination changed after approval/);
    expect(h.calls.some((x) => x.method === 'POST')).toBe(false);
  });

  it('deletes only a project golive created, then confirms it through the provider read', async () => {
    const h = mockHttp([
      ['GET', `${US}/api/0/organizations/`, orgs],
      ['DELETE', `${US}/api/0/projects/${ORG}/4505777/`, () => ({ status: 204, text: '' })],
      ['GET', `${US}/api/0/projects/${ORG}/4505777/`, () => ({ status: 404, json: { detail: 'not found' } })],
    ]);
    const c = testCtx({ tokens: { SENTRY_AUTH_TOKEN: TOKEN }, http: h.http, state: state({ [PROJECT_ID_KEY]: '4505777', [PROJECT_NAME_KEY]: 'shop', [CREATED_PROJECT_KEY]: '4505777' }) });
    expect(await linker.remove!(c)).toEqual({ removed: true });
    expect(paths(h.calls)).toEqual(['GET /api/0/organizations/', `DELETE /api/0/projects/${ORG}/4505777/`, `GET /api/0/projects/${ORG}/4505777/`]);
    expect(c.state.resource(PROJECT_ID_KEY)).toBeUndefined();
    expect(c.state.resource(CREATED_PROJECT_KEY)).toBeUndefined();
  });

  it('treats a provider-scheduled deletion as confirmation, and leaves an adopted project alone', async () => {
    const h = mockHttp([
      ['GET', `${US}/api/0/organizations/`, orgs],
      ['DELETE', `${US}/api/0/projects/${ORG}/4505777/`, () => ({ status: 204, text: '' })],
      ['GET', `${US}/api/0/projects/${ORG}/4505777/`, () => ({ json: projectRow({ id: 4505777, status: 'pending_deletion' }) })],
    ]);
    const c = testCtx({ tokens: { SENTRY_AUTH_TOKEN: TOKEN }, http: h.http, state: state({ [PROJECT_ID_KEY]: '4505777', [CREATED_PROJECT_KEY]: '4505777' }) });
    expect(await linker.remove!(c)).toEqual({ removed: true });

    const adopted = mockHttp([]);
    const c2 = testCtx({ tokens: { SENTRY_AUTH_TOKEN: TOKEN }, http: adopted.http, state: state({ [PROJECT_ID_KEY]: '4505777' }) });
    expect(await linker.remove!(c2)).toMatchObject({ removed: false, reason: expect.stringContaining('not created by golive') });
    expect(adopted.calls).toEqual([]);
  });

  it('reports a provider that kept the project as live', async () => {
    const h = mockHttp([
      ['GET', `${US}/api/0/organizations/`, orgs],
      ['DELETE', `${US}/api/0/projects/${ORG}/4505777/`, () => ({ status: 204, text: '' })],
      ['GET', `${US}/api/0/projects/${ORG}/4505777/`, () => ({ json: projectRow({ id: 4505777 }) })],
    ]);
    const c = testCtx({ tokens: { SENTRY_AUTH_TOKEN: TOKEN }, http: h.http, state: state({ [PROJECT_ID_KEY]: '4505777', [CREATED_PROJECT_KEY]: '4505777' }) });
    expect(await linker.remove!(c)).toMatchObject({ removed: false, reason: expect.stringContaining('still reports the project as live') });
    expect(c.state.resource(PROJECT_ID_KEY)).toBe('4505777');
  });

  it('answers a three-state project read for a teardown confirmation', async () => {
    const pending = mockHttp([
      ['GET', `${US}/api/0/organizations/`, orgs],
      ['GET', `${US}/api/0/projects/${ORG}/4505777/`, () => ({ json: projectRow({ id: 4505777, status: 'pending_deletion' }) })],
    ]);
    expect(await monitoring.projectState!(ctx({}, { SENTRY_AUTH_TOKEN: TOKEN }, pending), '4505777')).toBe('pending');

    const gone = mockHttp([
      ['GET', `${US}/api/0/organizations/`, orgs],
      ['GET', `${US}/api/0/projects/${ORG}/4505777/`, () => ({ status: 404, json: { detail: 'not found' } })],
    ]);
    expect(await monitoring.projectState!(ctx({}, { SENTRY_AUTH_TOKEN: TOKEN }, gone), '4505777')).toBe('gone');

    const present = mockHttp([
      ['GET', `${US}/api/0/organizations/`, orgs],
      ['GET', `${US}/api/0/projects/${ORG}/4505777/`, () => ({ json: projectRow({ id: 4505777 }) })],
    ]);
    expect(await monitoring.projectState!(ctx({}, { SENTRY_AUTH_TOKEN: TOKEN }, present), '4505777')).toBe('present');
  });

  it('follows sentry.region for the control plane', async () => {
    const h = mockHttp([['GET', `${EU}/api/0/organizations/`, orgs]]);
    const a = await sentryAdapter.auth(ctx({ sentry: { region: 'eu' } }, { SENTRY_AUTH_TOKEN: TOKEN }, h));
    expect(a.via).toContain('(eu, Acme)');
  });
});

describe('sentry adapter: DSN, store and read-back', () => {
  const dsnHttp = () =>
    mockHttp([
      ['GET', `${US}/api/0/organizations/`, orgs],
      ['GET', `${US}/api/0/projects/${ORG}/4505123456/`, () => ({ json: projectRow() })],
      ['GET', `${US}/api/0/projects/${ORG}/4505123456/keys/`, () => ({ json: [keyRow()] })],
    ]);

  it('reads the PUBLIC DSN (never a Secret) from the project client keys', async () => {
    const c = ctx({}, { SENTRY_AUTH_TOKEN: TOKEN }, dsnHttp());
    const dsn = await monitoring.dsn(c, '4505123456');
    expect(dsn).toBe(DSN);
    expect(dsn).not.toBeInstanceOf(Secret);
  });

  it('explains a project with no active client key, and refuses a DSN for another project', async () => {
    const none = mockHttp([
      ['GET', `${US}/api/0/organizations/`, orgs],
      ['GET', `${US}/api/0/projects/${ORG}/4505123456/`, () => ({ json: projectRow() })],
      ['GET', `${US}/api/0/projects/${ORG}/4505123456/keys/`, () => ({ json: [keyRow({ isActive: false })] })],
    ]);
    await expect(monitoring.dsn(ctx({}, { SENTRY_AUTH_TOKEN: TOKEN }, none), '4505123456')).rejects.toThrow(/no active client key\/DSN/);

    const other = mockHttp([
      ['GET', `${US}/api/0/organizations/`, orgs],
      ['GET', `${US}/api/0/projects/${ORG}/4505123456/`, () => ({ json: projectRow() })],
      ['GET', `${US}/api/0/projects/${ORG}/4505123456/keys/`, () => ({ json: [keyRow({ dsn: { public: `https://${PUBKEY2}@o4505.ingest.us.sentry.io/4505999` } })] })],
    ]);
    await expect(monitoring.dsn(ctx({}, { SENTRY_AUTH_TOKEN: TOKEN }, other), '4505123456')).rejects.toThrow(/DSN for a different project/);
  });

  it('refuses a DSN outside Sentry\'s documented ingest hosts', () => {
    expect(() => parseDsn('https://key0123456789abcdef@evil.example/42')).toThrow(/documented ingest hosts/);
    expect(() => parseDsn(`http://${PUBKEY}@o4505.ingest.us.sentry.io/4505123456`)).toThrow(/documented ingest hosts/);
    expect(parseDsn(DSN)).toEqual({ publicKey: PUBKEY, host: 'o4505.ingest.us.sentry.io', projectId: '4505123456' });
  });

  it('sends one synthetic event to the DSN host with X-Sentry-Auth, no Authorization header', async () => {
    const h = mockHttp([
      ['GET', `${US}/api/0/organizations/`, orgs],
      ['GET', `${US}/api/0/projects/${ORG}/4505123456/`, () => ({ json: projectRow() })],
      ['GET', `${US}/api/0/projects/${ORG}/4505123456/keys/`, () => ({ json: [keyRow()] })],
      ['POST', 'https://o4505.ingest.us.sentry.io/api/4505123456/store/', () => ({ json: { id: 'fc6d8c0c43fc4630ad850ee518f1b9d0' } })],
    ]);
    const c = ctx({}, { SENTRY_AUTH_TOKEN: TOKEN }, h);
    const eventId = 'abcdefabcdefabcdefabcdefabcdefab';
    const r = await monitoring.capture(c, '4505123456', { eventId, message: 'golive_ingest_check ab12cd34', tags: { golive_marker: 'ab12cd34' } });
    expect(r).toEqual({ status: 200, eventId: 'fc6d8c0c43fc4630ad850ee518f1b9d0' });
    const call = h.calls.at(-1)!;
    expect(call.url).toBe('https://o4505.ingest.us.sentry.io/api/4505123456/store/');
    expect(call.headers.authorization).toBeUndefined();
    expect(call.headers['x-sentry-auth']).toContain(`sentry_key=${PUBKEY}`);
    expect(call.headers['x-sentry-auth']).toMatch(/sentry_version=7/);
    expect(call.body).toMatchObject({ event_id: eventId, message: 'golive_ingest_check ab12cd34', tags: { golive_marker: 'ab12cd34' } });
  });

  it('reads the exact event back: pending on 404, seen with the marker, seen without it', async () => {
    const event = (over: Record<string, unknown> = {}) => ({ json: { eventID: 'abc', id: 'abc', message: 'golive_ingest_check ab12cd34', tags: [{ key: 'golive_marker', value: 'ab12cd34' }], ...over } });

    const pending = mockHttp([['GET', `${US}/api/0/organizations/`, orgs], ['GET', `${US}/api/0/projects/${ORG}/4505123456/events/abc/`, () => ({ status: 404, json: { detail: 'not found' } })]]);
    expect(await monitoring.readEvent(ctx({}, { SENTRY_AUTH_TOKEN: TOKEN }, pending), '4505123456', 'abc', 'ab12cd34')).toBe('pending');

    const seen = mockHttp([['GET', `${US}/api/0/organizations/`, orgs], ['GET', `${US}/api/0/projects/${ORG}/4505123456/events/abc/`, () => event()]]);
    expect(await monitoring.readEvent(ctx({}, { SENTRY_AUTH_TOKEN: TOKEN }, seen), '4505123456', 'abc', 'ab12cd34')).toBe('seen');

    const odd = mockHttp([['GET', `${US}/api/0/organizations/`, orgs], ['GET', `${US}/api/0/projects/${ORG}/4505123456/events/abc/`, () => event({ message: 'something else', tags: [] })]]);
    expect(await monitoring.readEvent(ctx({}, { SENTRY_AUTH_TOKEN: TOKEN }, odd), '4505123456', 'abc', 'ab12cd34')).toBe('seen-without-marker');
  });

  it('maps 404, 429 and an unreachable host without echoing the credential', async () => {
    const gone = mockHttp([['GET', `${US}/api/0/organizations/`, () => ({ status: 404, json: { detail: 'not found' } })]]);
    await expect(linker.candidates(ctx({}, { SENTRY_AUTH_TOKEN: TOKEN }, gone))).rejects.toThrow(/not found/);

    const limited = mockHttp([['GET', `${US}/api/0/organizations/`, () => ({ status: 429, json: { detail: 'throttled' } })]]);
    const a = await sentryAdapter.auth(ctx({}, { SENTRY_AUTH_TOKEN: TOKEN }, limited));
    expect(a.ok).toBe(false);
    expect(a.howToFix).toMatch(/rate-limiting/);
    expect(a.howToFix).not.toContain(TOKEN);

    const dead = mockHttp([['GET', `${US}/api/0/organizations/`, () => { throw new Error(`connect ECONNREFUSED (${TOKEN})`); }]]);
    const err = await sentryAdapter.auth(ctx({}, { SENTRY_AUTH_TOKEN: TOKEN }, dead));
    expect(err.ok).toBe(false);
    expect(err.howToFix ?? '').not.toContain(TOKEN);
  });

  it('maps a missing scope (403) to the scopes the token needs', async () => {
    const h = mockHttp([['GET', `${US}/api/0/organizations/`, () => ({ status: 403, json: { detail: 'You do not have permission to perform this action.' } })]]);
    const a = await sentryAdapter.auth(ctx({}, { SENTRY_AUTH_TOKEN: TOKEN }, h));
    expect(a.ok).toBe(false);
    expect(a.howToFix).toMatch(/project:admin/);
    expect(a.howToFix).not.toContain(TOKEN);
  });

  it('keeps the credential inside the Authorization header only, never in a URL, body or result', async () => {
    const h = mockHttp([
      ['GET', `${US}/api/0/organizations/`, orgs],
      ['GET', `${US}/api/0/organizations/${ORG}/projects/`, () => ({ json: [projectRow()] })],
      ['GET', `${US}/api/0/projects/${ORG}/4505123456/`, () => ({ json: projectRow() })],
    ]);
    const c = ctx({}, { SENTRY_AUTH_TOKEN: TOKEN }, h);
    const p = await linker.resolve!(c, '4505123456');
    expect(JSON.stringify(p) + c.logs.join('\n')).not.toContain(TOKEN);
    for (const call of h.calls) {
      expect(call.url).not.toContain(TOKEN);
      expect(JSON.stringify(call.body ?? null)).not.toContain(TOKEN);
      if (call.headers.authorization !== undefined) expect(call.headers.authorization).toBe(`Bearer ${TOKEN}`);
    }
  });

  it('exposes its refusals as HttpError subclasses with a status', async () => {
    const h = mockHttp([['GET', `${US}/api/0/organizations/`, () => ({ status: 401, json: { detail: 'nope' } })]]);
    const c = ctx({}, { SENTRY_AUTH_TOKEN: TOKEN }, h);
    const err = (await linker.candidates(c).catch((e: Error) => e)) as Error & { status?: number };
    expect(err).toBeInstanceOf(Error);
    expect(err.status).toBe(401);
  });
});
