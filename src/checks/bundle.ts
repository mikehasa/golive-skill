import type { Ctx } from '../core/types.js';
import { Secret } from '../core/secret.js';
import { allowHost } from '../core/http.js';
import { hostVariants, probe } from './util.js';

/** Crawl limits: enough for real apps, bounded so a huge site can't stall verify. */
export const MAX_CHUNKS = 40;
export const MAX_BYTES = 8 * 1024 * 1024;

export interface BundleFile {
  /** Path on the app's origin (no query string), safe to print. */
  path: string;
  text: string;
}
export interface Bundle {
  files: BundleFile[];
  notes: string[];
  htmlStatus: number;
  /** Every discovered same-origin script was fetched and scanned within the crawl limits. */
  complete: boolean;
  /** The page redirected off the app's origin (auth wall, protection, foreign site): nothing scanned. */
  offsite?: boolean;
}

const attr = (tag: string, name: string): string | undefined => new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, 'i').exec(tag)?.[1];

/** Same-origin <script src> and modulepreload / preload-as-script links, in document order. */
export function scriptUrls(html: string, pageUrl: string): string[] {
  const origin = new URL(pageUrl).origin;
  const out: string[] = [];
  const add = (raw: string | undefined) => {
    if (!raw) return;
    try {
      const u = new URL(raw.replace(/&amp;/g, '&'), pageUrl);
      if (u.origin === origin && !out.includes(u.href)) out.push(u.href);
    } catch {
      /* not a URL */
    }
  };
  for (const tag of html.match(/<(script|link)\b[^>]*>/gi) ?? []) {
    if (/^<script/i.test(tag)) add(attr(tag, 'src'));
    else {
      const rel = (attr(tag, 'rel') ?? '').toLowerCase();
      if (rel.split(/\s+/).includes('modulepreload') || (rel === 'preload' && (attr(tag, 'as') ?? '').toLowerCase() === 'script')) add(attr(tag, 'href'));
    }
  }
  return out;
}

/**
 * Fetch the production HTML and its same-origin JS chunks (read-only GETs, bounded). `base` must be a
 * host-confirmed URL (confirmedProductionUrl). Redirects are followed only within base's origin and its
 * www/apex counterpart over https: an auth wall, deployment protection or a foreign site is reported,
 * never crawled, and hosts from Location headers never reach the HTTP allowlist.
 */
export async function fetchBundle(ctx: Ctx, base: string): Promise<Bundle> {
  const allowed = new Set(hostVariants(new URL(base).host));
  for (const h of allowed) allowHost(h);
  let page = `${base}/`;
  let res = await probe(ctx, page);
  for (let hop = 0; hop < 3 && res.status >= 300 && res.status < 400 && res.headers.location; hop++) {
    let next: URL;
    try {
      next = new URL(res.headers.location, page);
    } catch {
      return { files: [], notes: [`GET ${page} redirected to an invalid location; not followed`], htmlStatus: res.status, complete: false, offsite: true };
    }
    if (next.protocol !== 'https:' || !allowed.has(next.host.toLowerCase())) {
      // origin + path only: redirect query strings can carry nonces/tokens.
      const where = `${next.protocol}//${next.host}${next.pathname}`;
      const vercelWall = next.host.toLowerCase() === 'vercel.com' && /^\/(sso-api|login)\b/.test(next.pathname);
      const why = vercelWall ? 'Vercel deployment protection is on for the production URL' : 'auth wall / deployment protection / another site?';
      return { files: [], notes: [`GET ${page} redirected to ${where} (${why}); not followed, nothing scanned`], htmlStatus: res.status, complete: false, offsite: true };
    }
    page = next.href;
    res = await probe(ctx, page);
  }
  const pagePart = boundedText(res.text, MAX_BYTES);
  const files: BundleFile[] = [{ path: new URL(page).pathname, text: pagePart.text }];
  const notes: string[] = [];
  if (res.status < 200 || res.status >= 300) return { files, notes: [`GET ${page} returned HTTP ${res.status}`], htmlStatus: res.status, complete: false };
  if (pagePart.truncated) return { files, notes: [`HTML truncated at the ${MAX_BYTES / 1024 / 1024} MiB scan limit; scripts were not fetched`], htmlStatus: res.status, complete: false };

  const urls = scriptUrls(pagePart.text, page);
  let complete = true;
  if (urls.length > MAX_CHUNKS) {
    notes.push(`${urls.length} scripts found; scanned the first ${MAX_CHUNKS}`);
    complete = false;
  }
  let total = pagePart.bytes;
  for (const url of urls.slice(0, MAX_CHUNKS)) {
    const path = new URL(url).pathname;
    if (total >= MAX_BYTES) {
      notes.push(`stopped at the ${MAX_BYTES / 1024 / 1024} MiB scan limit; remaining scripts were not fetched`);
      complete = false;
      break;
    }
    try {
      const r = await probe(ctx, url);
      if (r.status < 200 || r.status >= 300) {
        notes.push(`${path}: HTTP ${r.status}`);
        complete = false;
        continue;
      }
      const part = boundedText(r.text, MAX_BYTES - total);
      total += part.bytes;
      files.push({ path, text: part.text });
      if (part.truncated) {
        notes.push(`${path}: truncated at the ${MAX_BYTES / 1024 / 1024} MiB scan limit; remaining content was not scanned`);
        complete = false;
        break;
      }
    } catch {
      notes.push(`${path}: fetch failed`);
      complete = false;
    }
  }
  return { files, notes, htmlStatus: res.status, complete };
}

/** Limit scanned UTF-8 bytes, including HTML; never claim a truncated response was fully scanned. */
function boundedText(text: string, maximum: number): { text: string; bytes: number; truncated: boolean } {
  const encoded = Buffer.from(text, 'utf8');
  if (encoded.length <= maximum) return { text, bytes: encoded.length, truncated: false };
  let prefix = encoded.subarray(0, maximum).toString('utf8');
  // A byte cut through a multibyte character may create a larger replacement character.
  while (Buffer.byteLength(prefix, 'utf8') > maximum) prefix = prefix.slice(0, -1);
  return { text: prefix, bytes: maximum, truncated: true };
}

// ── Credential patterns ─────────────────────────────────────────────────────────────────────────

export interface SecretHit {
  kind: string;
  path: string;
  /** The match, wrapped immediately so it can't be printed (and is registered for redaction). */
  secret: Secret;
}

const SIMPLE: Array<[RegExp, (m: RegExpExecArray) => string]> = [
  [/\b(sk|rk)_(live|test)_[A-Za-z0-9]{10,}/g, (m) => `Stripe ${m[1] === 'sk' ? 'secret' : 'restricted'} key (${m[2]})`],
  [/\bwhsec_[A-Za-z0-9+/=]{16,}/g, () => 'Stripe webhook signing secret'],
  [/\bsb_secret_[A-Za-z0-9_-]{10,}/g, () => 'Supabase secret key'],
  [/\bsbp_[A-Za-z0-9_]{20,}/g, () => 'Supabase personal access token'],
  [/\bre_[A-Za-z0-9]{8,}_[A-Za-z0-9]{8,}/g, () => 'Resend API key'],
  [/\bAKIA[0-9A-Z]{16}\b/g, () => 'AWS access key id'],
  [/-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/g, () => 'private key (PEM)'],
];
const JWT = /\beyJ[A-Za-z0-9_-]{5,}\.eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{10,}/g;

export function jwtPayload(token: string): Record<string, unknown> | null {
  try {
    const json = Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8');
    const v = JSON.parse(json) as unknown;
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Server credentials in public text. The anon/publishable role is expected in bundles and ignored. */
export function scanSecrets(file: BundleFile): SecretHit[] {
  const hits: SecretHit[] = [];
  const push = (kind: string, match: string) => {
    if (match.length < 8) return;
    hits.push({ kind, path: file.path, secret: new Secret(`bundle:${kind}`, match) });
  };
  for (const [re, kind] of SIMPLE) for (const m of file.text.matchAll(re)) push(kind(m as RegExpExecArray), m[0]);
  for (const m of file.text.matchAll(JWT)) {
    if (jwtPayload(m[0])?.role === 'service_role') push('Supabase service_role JWT', m[0]);
  }
  return hits;
}

/** Public Supabase keys the app ships (publishable or legacy anon JWT), for the RLS probe. */
export function findPublicSupabaseKeys(files: BundleFile[], ref?: string): string[] {
  const keys: string[] = [];
  for (const f of files) {
    for (const m of f.text.matchAll(/\bsb_publishable_[A-Za-z0-9_-]{10,}/g)) if (!keys.includes(m[0])) keys.push(m[0]);
    for (const m of f.text.matchAll(JWT)) {
      const p = jwtPayload(m[0]);
      if (p?.role === 'anon' && (!ref || p.ref === undefined || p.ref === ref) && !keys.includes(m[0])) keys.push(m[0]);
    }
  }
  return keys;
}
