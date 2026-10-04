import { describe, it, expect, beforeEach } from 'vitest';
import {
  uptimerobotAdapter,
  uptimeOf,
  UptimerobotError,
  sameWatchedUrl,
  monitorStatusText,
  MONITOR_ID_KEY,
  MONITOR_NAME_KEY,
  CREATED_MONITOR_KEY,
  type UptimeProvider,
} from '../../src/adapters/uptimerobot.js';
import { UPTIMEROBOT_KEY_TYPES, uptimerobotCall } from '../../src/adapters/uptimerobot-api.js';
import { _resetSecretRegistry, Secret } from '../../src/core/secret.js';
import { tokenHowTo } from '../../src/core/credentials.js';
import { mockHttp, testCtx, type HttpCall } from '../helpers.js';
import type { Ctx, HttpRequest, ShipConfig } from '../../src/core/types.js';

beforeEach(() => _resetSecretRegistry());

// Scanner-shaped literals are split into fragments, like the other fakes: the concatenated value is
// what the tests exercise, and no contiguous token shape sits in the tree.
const KEY = 'ur' + '_FAKEuptimerobotAPIkey0123456789abcdef';
const HOST = 'https://api.uptimerobot.com';

const uptime = uptimeOf(uptimerobotAdapter)! as UptimeProvider;
const linker = uptimerobotAdapter.capabilities.project!;

const account = (over: Record<string, unknown> = {}) => ({
  json: { stat: 'ok', account: { email: 'owner@example.com', monitor_limit: 50, monitor_interval: 5, up_monitors: 1, down_monitors: 0, paused_monitors: 0, ...over } },
});
const monitorRow = (over: Record<string, unknown> = {}) => ({ id: 777712827, friendly_name: 'shop', url: 'https://example.com', type: 1, status: 2, interval: 300, ...over });
const monitors = (...rows: Array<Record<string, unknown>>) => ({ json: { stat: 'ok', pagination: { offset: 0, limit: 50, total: rows.length }, monitors: rows } });
const statFail = (type: string, message: string) => ({ json: { stat: 'fail', error: { type, message } } });

function ctx(config: Partial<ShipConfig> = {}, tokens: Record<string, string> = { UPTIMEROBOT_API_KEY: KEY }, h = mockHttp([])): Ctx & { logs: string[] } {
  return testCtx({ config, tokens, http: h.http });
}

function paths(calls: HttpCall[]): string[] {
  return calls.map((c) => `${c.method} ${c.url.replace(HOST, '')}`);
}

const state = (resources: Record<string, string>) => ({ version: 1 as const, resources, secrets: {}, steps: {} });

describe('uptimerobot adapter: auth', () => {
  it('proves the key with a form-encoded POST to /v2/getAccountDetails and names the account', async () => {
    const h = mockHttp([['POST', `${HOST}/v2/getAccountDetails`, () => account()]]);
    const a = await uptimerobotAdapter.auth(ctx({}, { UPTIMEROBOT_API_KEY: KEY }, h));
    expect(a).toEqual({ ok: true, via: `UPTIMEROBOT_API_KEY env (owner@example.com, 1/50 monitors)` });
    // The docs put the key in the request BODY: it must never appear in the URL.
    expect(h.calls[0]!.url).not.toContain(KEY);
    expect(h.calls[0]!.body).toMatchObject({ api_key: KEY, format: 'json' });
  });

  it('passes the credential as a Secret on the request it builds', async () => {
    const seen: HttpRequest[] = [];
    const h = mockHttp([['POST', `${HOST}/v2/getAccountDetails`, () => account()]]);
    const c = testCtx({ tokens: { UPTIMEROBOT_API_KEY: KEY }, http: (req) => { seen.push(req); return h.http(req); } });
    await uptimerobotAdapter.auth(c);
    expect(seen[0]!.form!.api_key).toBeInstanceOf(Secret);
  });

  it('without a credential: instructions via the credential helper, never the value', async () => {
    const a = await uptimerobotAdapter.auth(ctx({}, {}));
    expect(a.ok).toBe(false);
    expect(a.howToFix).toContain(tokenHowTo('UPTIMEROBOT_API_KEY'));
    expect(a.howToFix).toMatch(/Integrations & API/);
    // Least privilege is stated as the docs describe it: read-only reads, main key for create/delete.
    expect(a.howToFix).toMatch(/read-only key/);
    expect(a.howToFix).toMatch(/main \(account-specific\) key/);
    expect(a.howToFix).not.toMatch(/export UPTIMEROBOT_API_KEY=|in your shell/);
  });

  it('maps a rejected key (401) to an actionable message that never echoes it', async () => {
    const h = mockHttp([['POST', `${HOST}/v2/getAccountDetails`, () => ({ status: 401, text: 'Unauthorized' })]]);
    const a = await uptimerobotAdapter.auth(ctx({}, { UPTIMEROBOT_API_KEY: KEY }, h));
    expect(a.ok).toBe(false);
    expect(a.howToFix).toMatch(/rejected/);
    expect(a.howToFix).toContain(UPTIMEROBOT_KEY_TYPES);
    expect(a.howToFix).not.toContain(KEY);
  });

  it('maps the stat-fail envelope the API answers with HTTP 200', async () => {
    const h = mockHttp([['POST', `${HOST}/v2/getAccountDetails`, () => statFail('invalid_parameter', 'api_key not found.')]]);
    const a = await uptimerobotAdapter.auth(ctx({}, { UPTIMEROBOT_API_KEY: KEY }, h));
    expect(a.ok).toBe(false);
    expect(a.howToFix).toMatch(/api_key not found/);
    expect(a.howToFix).toMatch(/monitor-specific key/);
    expect(a.howToFix).not.toContain(KEY);
  });

  it('maps a rate limit (429) naming the documented limits and the retry hint', async () => {
    const h = mockHttp([['POST', `${HOST}/v2/getAccountDetails`, () => ({ status: 429, headers: { 'retry-after': '30' }, text: 'too many requests' })]]);
    const a = await uptimerobotAdapter.auth(ctx({}, { UPTIMEROBOT_API_KEY: KEY }, h));
    expect(a.ok).toBe(false);
    expect(a.howToFix).toMatch(/rate-limiting/);
    expect(a.howToFix).toMatch(/10 req\/min/);
    expect(a.howToFix).toMatch(/retry after 30 s/);
    expect(a.howToFix).not.toContain(KEY);
  });

  it('reads either spelling of the paused-monitor count (the docs\' field table and examples disagree)', async () => {
    const h = mockHttp([['POST', `${HOST}/v2/getAccountDetails`, () => ({ json: { stat: 'ok', account: { email: 'o@e.com', monitor_limit: 50, monitor_interval: 5, up_monitors: 1, down_monitors: 0, pause_monitors: 2 } } })]]);
    const a = await uptimerobotAdapter.auth(ctx({}, { UPTIMEROBOT_API_KEY: KEY }, h));
    expect(a.via).toContain('3/50 monitors');

    const h2 = mockHttp([['POST', `${HOST}/v2/getAccountDetails`, () => ({ json: { stat: 'ok', account: { email: 'o@e.com', monitor_limit: 50, monitor_interval: 5, up_monitors: 1, down_monitors: 0, paused_monitors: 2 } } })]]);
    const b = await uptimerobotAdapter.auth(ctx({}, { UPTIMEROBOT_API_KEY: KEY }, h2));
    expect(b.via).toContain('3/50 monitors');
  });

  it('keeps the credential in the form body only, never in a URL, result or log', async () => {
    const h = mockHttp([['POST', `${HOST}/v2/getMonitors`, () => monitors(monitorRow())]]);
    const c = ctx({ projects: { monitoring: '777712827' } }, { UPTIMEROBOT_API_KEY: KEY }, h);
    const p = await linker.resolve!(c, '777712827');
    expect(JSON.stringify(p) + c.logs.join('\n')).not.toContain(KEY);
    for (const call of h.calls) {
      expect(call.url).not.toContain(KEY);
      expect(call.headers.authorization).toBeUndefined();
      expect((call.body as Record<string, unknown>).api_key).toBe(KEY);
    }
  });

  it('does not claim UptimeRobot is already in a repo: it exposes no detector', () => {
    // There is no local SDK or config file to find — the provider is chosen in the menu.
    expect(uptimerobotAdapter.detect).toBeUndefined();
    expect(uptimerobotAdapter.axes).toEqual(['monitoring']);
    expect(uptimerobotAdapter.automated).toBe(true);
  });
});

describe('uptimerobot adapter: monitors', () => {
  it('lists every monitor, paginated by the documented offset/limit/total', async () => {
    const page1 = Array.from({ length: 50 }, (_, i) => monitorRow({ id: 1000 + i, friendly_name: `m${i}` }));
    let call = 0;
    const h = mockHttp([
      ['POST', `${HOST}/v2/getMonitors`, () => (++call === 1 ? { json: { stat: 'ok', pagination: { offset: 0, limit: 50, total: 52 }, monitors: page1 } } : { json: { stat: 'ok', pagination: { offset: 50, limit: 50, total: 52 }, monitors: [monitorRow({ id: 2000 }), monitorRow({ id: 2001 })] } })],
    ]);
    const list = await uptime.list(ctx({}, { UPTIMEROBOT_API_KEY: KEY }, h));
    expect(list).toHaveLength(52);
    expect(list.at(-1)!.id).toBe('2001');
    expect(h.calls.map((c) => (c.body as Record<string, unknown>).offset)).toEqual([0, 50]);
  });

  it('resolves the recorded monitor by id and by friendly name, and refuses an ambiguous or missing one', async () => {
    const byId = mockHttp([['POST', `${HOST}/v2/getMonitors`, () => monitors(monitorRow())]]);
    expect(await linker.resolve!(ctx({}, { UPTIMEROBOT_API_KEY: KEY }, byId), '777712827')).toEqual({ id: '777712827', name: 'shop' });
    // A numeric selection is read through the documented monitors filter, not the whole account.
    expect((byId.calls[0]!.body as Record<string, unknown>).monitors).toBe('777712827');

    const byName = mockHttp([['POST', `${HOST}/v2/getMonitors`, () => monitors(monitorRow())]]);
    expect(await linker.resolve!(ctx({}, { UPTIMEROBOT_API_KEY: KEY }, byName), 'shop')).toEqual({ id: '777712827', name: 'shop' });

    const two = mockHttp([['POST', `${HOST}/v2/getMonitors`, () => monitors(monitorRow(), monitorRow({ id: 888 }))]]);
    await expect(linker.resolve!(ctx({}, { UPTIMEROBOT_API_KEY: KEY }, two), 'shop')).rejects.toThrow(/2 monitors matching "shop"/);

    const none = mockHttp([['POST', `${HOST}/v2/getMonitors`, () => monitors()]]);
    await expect(linker.resolve!(ctx({}, { UPTIMEROBOT_API_KEY: KEY }, none), 'shop')).rejects.toThrow(/no monitor matching "shop"/);
    await expect(linker.resolve!(ctx({}, { UPTIMEROBOT_API_KEY: KEY }, none), '999')).rejects.toThrow(/no monitor matching "999"/);
  });

  it('follows projects.monitoring first, then the monitor state recorded', async () => {
    const h = mockHttp([['POST', `${HOST}/v2/getMonitors`, () => monitors(monitorRow())]]);
    const c = ctx({ projects: { monitoring: 'shop' } }, { UPTIMEROBOT_API_KEY: KEY }, h);
    expect((await linker.current(c))!.id).toBe('777712827');

    const h2 = mockHttp([['POST', `${HOST}/v2/getMonitors`, () => monitors(monitorRow())]]);
    const c2 = testCtx({ tokens: { UPTIMEROBOT_API_KEY: KEY }, http: h2.http, state: state({ [MONITOR_ID_KEY]: '777712827' }) });
    expect((await linker.current(c2))!.name).toBe('shop');

    expect(await linker.current(ctx({}, { UPTIMEROBOT_API_KEY: KEY }, mockHttp([])))).toBeNull();
  });

  it('selecting a monitor records it without a creation marker, and clears a stale one', async () => {
    const h = mockHttp([['POST', `${HOST}/v2/getMonitors`, () => monitors(monitorRow())]]);
    const c = testCtx({ config: { projects: { monitoring: 'shop' } }, tokens: { UPTIMEROBOT_API_KEY: KEY }, http: h.http, state: state({ [CREATED_MONITOR_KEY]: '999' }) });
    const m = await linker.select(c, 'shop');
    expect(m).toEqual({ id: '777712827', name: 'shop' });
    expect(c.state.resource(MONITOR_ID_KEY)).toBe('777712827');
    expect(c.state.resource(MONITOR_NAME_KEY)).toBe('shop');
    expect(c.state.resource(CREATED_MONITOR_KEY)).toBeUndefined();
  });

  it('reads one monitor with its latest log line, and answers null when the provider no longer has it', async () => {
    const log = { type: 1, datetime: 1_782_000_000, duration: 3600, reason: 'HTTP 503 – Service Unavailable' };
    const h = mockHttp([['POST', `${HOST}/v2/getMonitors`, () => monitors(monitorRow({ status: 9, logs: [log] }))]]);
    const m = await uptime.monitor(ctx({}, { UPTIMEROBOT_API_KEY: KEY }, h), '777712827');
    expect(m).toMatchObject({ id: '777712827', name: 'shop', url: 'https://example.com', type: 1, status: 9, interval: 300, lastLog: { type: 1, datetime: 1_782_000_000, duration: 3600, reason: 'HTTP 503 – Service Unavailable' } });
    expect(h.calls[0]!.body).toMatchObject({ monitors: '777712827', logs: 1, logs_limit: 1 });

    const gone = mockHttp([['POST', `${HOST}/v2/getMonitors`, () => monitors()]]);
    expect(await uptime.monitor(ctx({}, { UPTIMEROBOT_API_KEY: KEY }, gone), '777712827')).toBeNull();
    expect(await uptime.monitorState(ctx({}, { UPTIMEROBOT_API_KEY: KEY }, mockHttp([['POST', `${HOST}/v2/getMonitors`, () => monitors(monitorRow())]])), '777712827')).toBe('present');
  });

  it('refuses an answer that names a different monitor for a monitor-specific read', async () => {
    const h = mockHttp([['POST', `${HOST}/v2/getMonitors`, () => monitors(monitorRow({ id: 999 }))]]);
    await expect(uptime.monitor(ctx({}, { UPTIMEROBOT_API_KEY: KEY }, h), '777712827')).rejects.toThrow(/a different monitor/);
  });

  it('names the documented status codes and compares watched URLs canonically', () => {
    expect(monitorStatusText(0)).toBe('paused');
    expect(monitorStatusText(1)).toBe('not checked yet');
    expect(monitorStatusText(2)).toBe('up');
    expect(monitorStatusText(8)).toBe('seems down');
    expect(monitorStatusText(9)).toBe('down');
    expect(monitorStatusText(42)).toBe('unknown status 42');

    expect(sameWatchedUrl('https://example.com/', 'https://example.com')).toBe(true);
    expect(sameWatchedUrl('https://Example.com/shop/', 'https://example.com/shop')).toBe(true);
    expect(sameWatchedUrl('https://example.com/x?y=1', 'https://example.com/x?y=1')).toBe(true);
    expect(sameWatchedUrl('http://example.com', 'https://example.com')).toBe(false);
    expect(sameWatchedUrl('https://example.com/shop', 'https://example.com')).toBe(false);
  });

  it('refuses an invalid monitor shape instead of inferring one', async () => {
    const h = mockHttp([['POST', `${HOST}/v2/getMonitors`, () => ({ json: { stat: 'ok', monitors: [{ id: 1, friendly_name: 'x' }] } })]]);
    await expect(uptime.list(ctx({}, { UPTIMEROBOT_API_KEY: KEY }, h))).rejects.toThrow(UptimerobotError);
  });
});

describe('uptimerobot adapter: create and delete', () => {
  it('creates an HTTP monitor for the approved URL, re-reads it, and records the creation marker', async () => {
    let list = 0;
    const h = mockHttp([
      ['POST', `${HOST}/v2/getAccountDetails`, () => account()],
      ['POST', `${HOST}/v2/getMonitors`, () => (++list === 1 ? monitors() : monitors(monitorRow({ status: 1 })))],
      ['POST', `${HOST}/v2/newMonitor`, () => ({ json: { stat: 'ok', monitor: { id: 777712827, status: 1 } } })],
    ]);
    const c = ctx({}, { UPTIMEROBOT_API_KEY: KEY }, h);
    const m = await uptime.createMonitor!(c, { name: 'shop', url: 'https://example.com' });
    expect(m).toMatchObject({ id: '777712827', name: 'shop', url: 'https://example.com', type: 1, status: 1 });
    const made = h.calls.find((x) => x.url.endsWith('/newMonitor'))!;
    // The docs' required fields only: no guessed interval, and NO alert_contacts (golive never
    // touches who gets alerted).
    expect(made.body).toEqual({ api_key: KEY, format: 'json', friendly_name: 'shop', url: 'https://example.com', type: 1 });
    expect(c.state.resource(MONITOR_ID_KEY)).toBe('777712827');
    expect(c.state.resource(MONITOR_NAME_KEY)).toBe('shop');
    expect(c.state.resource(CREATED_MONITOR_KEY)).toBe('777712827');
    expect(c.logs.join('\n')).toMatch(/created UptimeRobot monitor shop \(777712827\)/);
  });

  it('refuses to create when the account is at its monitor limit, before any write', async () => {
    const h = mockHttp([['POST', `${HOST}/v2/getAccountDetails`, () => account({ monitor_limit: 2, up_monitors: 2, down_monitors: 0, paused_monitors: 0 })]]);
    const c = ctx({}, { UPTIMEROBOT_API_KEY: KEY }, h);
    await expect(uptime.createMonitor!(c, { name: 'shop', url: 'https://example.com' })).rejects.toThrow(/2 of its 2 monitors/);
    expect(h.calls.some((x) => x.url.endsWith('/newMonitor'))).toBe(false);
    expect(c.state.resource(CREATED_MONITOR_KEY)).toBeUndefined();
  });

  it('never duplicates a monitor that already watches the URL', async () => {
    const h = mockHttp([
      ['POST', `${HOST}/v2/getAccountDetails`, () => account()],
      ['POST', `${HOST}/v2/getMonitors`, () => monitors(monitorRow({ url: 'https://example.com/', friendly_name: 'someone-elses-name' }))],
    ]);
    const c = ctx({}, { UPTIMEROBOT_API_KEY: KEY }, h);
    await expect(uptime.createMonitor!(c, { name: 'shop', url: 'https://example.com' })).rejects.toThrow(/already watches https:\/\/example.com: someone-elses-name \(777712827\)/);
    expect(h.calls.some((x) => x.url.endsWith('/newMonitor'))).toBe(false);
  });

  it('maps a plan refusal (access_denied) to reuse/adopt/upgrade, never a retry', async () => {
    let list = 0;
    const h = mockHttp([
      ['POST', `${HOST}/v2/getAccountDetails`, () => account()],
      ['POST', `${HOST}/v2/getMonitors`, () => (++list === 1 ? monitors() : monitors())],
      ['POST', `${HOST}/v2/newMonitor`, () => statFail('access_denied', 'You are not allowed to use some settings with your current plan.')],
    ]);
    const c = ctx({}, { UPTIMEROBOT_API_KEY: KEY }, h);
    const err = (await uptime.createMonitor!(c, { name: 'shop', url: 'https://example.com' }).catch((e: Error) => e)) as Error;
    expect(err.message).toMatch(/plan refused this call/);
    expect(err.message).toMatch(/Create the monitor in the UptimeRobot dashboard/);
    expect(err.message).toMatch(/never changes a plan or spends money/);
    expect(err.message).not.toContain(KEY);
  });

  it('records nothing when the created monitor does not match what was approved', async () => {
    let list = 0;
    const h = mockHttp([
      ['POST', `${HOST}/v2/getAccountDetails`, () => account()],
      ['POST', `${HOST}/v2/getMonitors`, () => (++list === 1 ? monitors() : monitors(monitorRow({ url: 'https://other.example' })))],
      ['POST', `${HOST}/v2/newMonitor`, () => ({ json: { stat: 'ok', monitor: { id: 777712827, status: 1 } } })],
    ]);
    const c = ctx({}, { UPTIMEROBOT_API_KEY: KEY }, h);
    await expect(uptime.createMonitor!(c, { name: 'shop', url: 'https://example.com' })).rejects.toThrow(/does not match what was approved/);
    expect(c.state.resource(CREATED_MONITOR_KEY)).toBeUndefined();
  });

  it('deletes only a monitor golive created, then confirms it through the provider read', async () => {
    const h = mockHttp([
      ['POST', `${HOST}/v2/deleteMonitor`, () => ({ json: { stat: 'ok', monitor: { id: 777712827 } } })],
      ['POST', `${HOST}/v2/getMonitors`, () => monitors()],
    ]);
    const c = testCtx({ tokens: { UPTIMEROBOT_API_KEY: KEY }, http: h.http, state: state({ [MONITOR_ID_KEY]: '777712827', [MONITOR_NAME_KEY]: 'shop', [CREATED_MONITOR_KEY]: '777712827' }) });
    expect(await linker.remove!(c)).toEqual({ removed: true });
    expect(paths(h.calls)).toEqual(['POST /v2/deleteMonitor', 'POST /v2/getMonitors']);
    expect((h.calls[0]!.body as Record<string, unknown>).id).toBe('777712827');
    expect(c.state.resource(MONITOR_ID_KEY)).toBeUndefined();
    expect(c.state.resource(CREATED_MONITOR_KEY)).toBeUndefined();
  });

  it('leaves an adopted monitor alone, and reports one the provider kept', async () => {
    const adopted = mockHttp([]);
    const c = testCtx({ tokens: { UPTIMEROBOT_API_KEY: KEY }, http: adopted.http, state: state({ [MONITOR_ID_KEY]: '777712827' }) });
    expect(await linker.remove!(c)).toMatchObject({ removed: false, reason: expect.stringContaining('not created by golive') });
    expect(adopted.calls).toEqual([]);

    let list = 0;
    const kept = mockHttp([
      ['POST', `${HOST}/v2/deleteMonitor`, () => ({ json: { stat: 'ok', monitor: { id: 777712827 } } })],
      ['POST', `${HOST}/v2/getMonitors`, () => (++list === 1 ? monitors(monitorRow()) : monitors(monitorRow()))],
    ]);
    const c2 = testCtx({ tokens: { UPTIMEROBOT_API_KEY: KEY }, http: kept.http, state: state({ [MONITOR_ID_KEY]: '777712827', [CREATED_MONITOR_KEY]: '777712827' }) });
    expect(await linker.remove!(c2)).toMatchObject({ removed: false, reason: expect.stringContaining('still reports the monitor') });
    expect(c2.state.resource(MONITOR_ID_KEY)).toBe('777712827');
  });

  it('treats a not-found delete as already gone, confirmed by the read', async () => {
    const h = mockHttp([
      ['POST', `${HOST}/v2/deleteMonitor`, () => statFail('invalid_parameter', 'monitor not found')],
      ['POST', `${HOST}/v2/getMonitors`, () => monitors()],
    ]);
    const c = testCtx({ tokens: { UPTIMEROBOT_API_KEY: KEY }, http: h.http, state: state({ [MONITOR_ID_KEY]: '777712827', [CREATED_MONITOR_KEY]: '777712827' }) });
    expect(await linker.remove!(c)).toEqual({ removed: true });
  });

  it('refuses an unknown API method instead of building a path', async () => {
    const h = mockHttp([]);
    const c = testCtx({ tokens: { UPTIMEROBOT_API_KEY: KEY }, http: h.http });
    await expect(uptimerobotCall(c, { method: 'getPSPs' as never, what: 'read status pages' })).rejects.toThrow(/Invalid UptimeRobot API method/);
    expect(h.calls).toEqual([]);
  });
});
