import type { Http, HttpRequest, HttpResponse } from './types.js';
import { Secret, redact, revealDeep } from './secret.js';

/**
 * Hosts golive may talk to. Everything else is refused, so a bug (or a prompt-injected config) can't
 * exfiltrate a secret to an arbitrary server. The app's own public URLs are added at runtime (for
 * read-only probes) via `allowHost`.
 */
const ALLOWED = new Set([
  'api.vercel.com',
  'api.supabase.com',
  'api.netlify.com',
  'console.neon.tech',
  'api.stripe.com',
  'api.resend.com',
  'api.cloudflare.com',
  'api.godaddy.com',
  'api.porkbun.com',
  'cloudflare-dns.com',
  'dns.google',
]);
const ALLOWED_SUFFIXES = ['.supabase.co'];
const dynamicHosts = new Set<string>();

export function allowHost(urlOrHost: string): void {
  const host = urlOrHost.includes('://') ? new URL(urlOrHost).host : urlOrHost;
  dynamicHosts.add(host.toLowerCase());
}

function isAllowed(host: string): boolean {
  const h = host.toLowerCase();
  return ALLOWED.has(h) || dynamicHosts.has(h) || ALLOWED_SUFFIXES.some((s) => h.endsWith(s));
}

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
  }
}

export function createHttp(fetchImpl: typeof fetch = fetch): Http {
  return async function http<T>(req: HttpRequest): Promise<HttpResponse<T>> {
    const url = new URL(req.url);
    if (url.protocol !== 'https:') throw new HttpError(`refusing non-https request to ${url.host}`, 0, '');
    if (!isAllowed(url.host)) throw new HttpError(`host not allowed: ${url.host}`, 0, '');

    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers ?? {})) headers[k] = v instanceof Secret ? v.reveal() : v;

    let body: string | undefined;
    if (req.form) {
      const p = new URLSearchParams();
      for (const [k, v] of Object.entries(req.form)) if (v !== undefined) p.append(k, v instanceof Secret ? v.reveal() : String(v));
      body = p.toString();
      headers['content-type'] ??= 'application/x-www-form-urlencoded';
    } else if (req.body !== undefined) {
      body = JSON.stringify(revealDeep(req.body));
      headers['content-type'] ??= 'application/json';
    }

    const method = req.method ?? 'GET';
    // Re-sending a non-idempotent write after a 5xx/timeout can duplicate it (e.g. two Supabase
    // projects, two live API keys). Only 429 (not processed) is always safe to retry.
    const idempotent = req.idempotent ?? (method === 'GET' || method === 'PUT' || method === 'DELETE' || Object.keys(headers).some((k) => k.toLowerCase() === 'idempotency-key'));
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), req.timeoutMs ?? 30_000);
      try {
        const res = await fetchImpl(url, { method, headers, body, signal: ctrl.signal, redirect: 'manual' });
        const text = await res.text();
        if ((res.status === 429 || (res.status >= 500 && idempotent)) && attempt < 2) {
          await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
          continue;
        }
        let json: unknown = undefined;
        try {
          json = text ? JSON.parse(text) : undefined;
        } catch {
          /* not JSON */
        }
        const outHeaders: Record<string, string> = {};
        res.headers.forEach((v, k) => (outHeaders[k] = v));
        return { status: res.status, headers: outHeaders, json: json as T, text };
      } catch (e) {
        lastErr = e;
        if (!idempotent) break; // the request may have reached the server; don't risk a duplicate write
        if (attempt < 2) await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
      } finally {
        clearTimeout(timer);
      }
    }
    throw new HttpError(redact(`request to ${url.host} failed: ${String(lastErr)}`), 0, '');
  };
}

/** Throw a redacted HttpError unless 2xx. */
export function expectOk<T>(res: HttpResponse<T>, what: string): HttpResponse<T> {
  if (res.status < 200 || res.status >= 300) {
    throw new HttpError(redact(`${what} failed: HTTP ${res.status} ${res.text.slice(0, 500)}`), res.status, redact(res.text));
  }
  return res;
}
