/** Fakes for check tests: capability-only adapters and a DoH responder. */
import type { Adapter, AuthStatus, Axis, Capabilities } from '../src/core/types.js';
import type { HttpCall } from './helpers.js';

export function fakeAdapter(a: { id: string; axes: Axis[]; automated?: boolean; auth?: AuthStatus | (() => Promise<AuthStatus>); capabilities?: Partial<Capabilities> }): Adapter {
  return {
    id: a.id,
    title: a.id[0]!.toUpperCase() + a.id.slice(1),
    axes: a.axes,
    automated: a.automated ?? true,
    auth: async () => (typeof a.auth === 'function' ? a.auth() : (a.auth ?? { ok: true, via: `${a.id} CLI` })),
    capabilities: a.capabilities ?? {},
  };
}

const TYPE_NUM: Record<string, number> = { A: 1, AAAA: 28, CNAME: 5, TXT: 16, MX: 15, NS: 2, SOA: 6 };

/**
 * DoH route for mockHttp: `records` maps "TYPE name" → values (TXT given unquoted).
 * Unknown names answer NXDOMAIN-style with no records.
 */
export function dohRoute(records: Record<string, string[]>): [string, RegExp, (c: HttpCall) => { status?: number; json?: unknown }] {
  return [
    'GET',
    /^https:\/\/cloudflare-dns\.com\/dns-query\?/,
    (c) => {
      const u = new URL(c.url);
      const name = u.searchParams.get('name')!;
      const type = u.searchParams.get('type')!;
      const vals = records[`${type} ${name}`] ?? [];
      return {
        json: {
          Status: vals.length ? 0 : 3,
          Answer: vals.map((v) => ({ name: `${name}.`, type: TYPE_NUM[type], TTL: 300, data: type === 'TXT' ? `"${v}"` : v })),
        },
      };
    },
  ];
}

/** A JWT with the given payload (unsigned signature segment; checks only decode the payload). */
export function jwt(payload: Record<string, unknown>): string {
  const b = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b({ alg: 'HS256', typ: 'JWT' })}.${b(payload)}.c2lnbmF0dXJlc2lnbmF0dXJlc2ln`;
}

export interface FetchRoute {
  status?: number;
  headers?: Record<string, string>;
  body?: string;
}

/**
 * A fetch() for the REAL createHttp (so the host allowlist and redirect: 'manual' are exercised):
 * routes map "METHOD url" → response. Unrouted requests answer 404 and are recorded like the rest.
 */
export function fakeFetch(routes: Record<string, FetchRoute>) {
  const requests: Array<{ method: string; url: string }> = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? 'GET';
    requests.push({ method, url });
    const r = routes[`${method} ${url}`];
    if (!r) return new Response('unrouted', { status: 404 });
    return new Response(r.body ?? '', { status: r.status ?? 200, headers: r.headers ?? {} });
  }) as typeof fetch;
  return { impl, requests };
}
