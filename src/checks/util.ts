import type { Axis, CheckResult, CheckStatus, Ctx, EnvTarget, Severity } from '../core/types.js';
import { allowHost } from '../core/http.js';
import { redact } from '../core/secret.js';

/** What Check.run returns. */
export type CheckOutcome = Omit<CheckResult, 'id' | 'title' | 'durationMs'>;

export { adapterFor, cap } from '../core/caps.js';
import { adapterFor, cap } from '../core/caps.js';

export function result(status: CheckStatus, severity: Severity, evidence: string[], fix?: string): CheckOutcome {
  const out: CheckOutcome = { status, severity, evidence: evidence.map(redact) };
  if (fix) out.fix = redact(fix);
  return out;
}
export const pass = (evidence: string[]): CheckOutcome => result('pass', 'info', evidence);
export const skip = (why: string): CheckOutcome => result('skip', 'info', [why]);

const RANK: Record<Severity, number> = { critical: 4, high: 3, medium: 2, low: 1, info: 0 };
export function worst(sevs: Severity[]): Severity {
  return sevs.reduce<Severity>((a, b) => (RANK[b] > RANK[a] ? b : a), 'info');
}
/** Severities high+ fail a check; medium/low only warn. */
export function isFailing(s: Severity): boolean {
  return RANK[s] >= RANK.high;
}

/** Secret-free message of an unknown error. */
export function errMsg(e: unknown): string {
  return redact(e instanceof Error ? e.message : String(e));
}

export function trimSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

/**
 * Production base URL as the LINKS register it (webhook URL, auth site URL): https://<config.domain>
 * first, then the host's URL. For comparing against provider settings ONLY. Never send requests to
 * it: config.domain is just a string in golive.yaml and may not belong to this project (use
 * confirmedProductionUrl for anything that touches the network).
 */
export async function baseUrl(ctx: Ctx, opts: { target?: EnvTarget } = {}): Promise<string | null> {
  const target = opts.target ?? 'production';
  if (target === 'production' && ctx.config.domain) return `https://${ctx.config.domain}`;
  const url = cap(ctx, 'hosting', 'url');
  const got = url ? await url.get(ctx, target).catch(() => null) : null;
  return got ? trimSlash(got) : null;
}

// ── Prerequisites / skip semantics ──────────────────────────────────────────────────────────────

/** A check whose prerequisite is missing is skipped, naming what blocks it (a handoff/step id or reason). */
export const blocked = (by: string, detail?: string): CheckOutcome => skip(`blocked by: ${by}${detail ? ` (${detail})` : ''}`);

const AUTH_OK = 'checks:auth-ok:';

/**
 * `login:<adapter>` if the automated provider chosen for `axis` is not authenticated, else null.
 * Only the `accounts` check FAILS for auth problems; every other check skips with this reason. Only
 * successes are memoised (per run), so a login that happens mid-run is noticed.
 */
export async function authBlock(ctx: Ctx, axis: Axis): Promise<string | null> {
  const a = adapterFor(ctx, axis);
  if (!a || !a.automated) return null;
  if (ctx.cache.get(AUTH_OK + a.id) === true) return null;
  try {
    if ((await a.auth(ctx)).ok) {
      ctx.cache.set(AUTH_OK + a.id, true);
      return null;
    }
  } catch {
    /* treated as not logged in; the accounts check reports the details */
  }
  return `login:${a.id}`;
}

/** Axes whose project is linked by the projects link (step/handoff id `project:<axis>`). */
function projectAxis(ctx: Ctx, axis: Axis): 'hosting' | 'db' | null {
  if (axis === 'hosting' || axis === 'db') return axis;
  if (axis === 'auth' && ctx.config.stack.auth && ctx.config.stack.auth === ctx.config.stack.db) return 'db';
  return null;
}

/** `project:<axis>` if the provider can tell which project this repo uses and none is linked yet. */
export async function projectBlock(ctx: Ctx, axis: Axis): Promise<string | null> {
  const pa = projectAxis(ctx, axis);
  if (!pa) return null;
  const linker = cap(ctx, pa, 'project');
  if (!linker) return null;
  const cur = await linker.current(ctx).catch(() => null);
  return cur ? null : `project:${pa}`;
}

/** Skip outcome if `axis`'s provider is not logged in (or, with project, has no linked project). */
export async function prereq(ctx: Ctx, axis: Axis, opts: { project?: boolean } = {}): Promise<CheckOutcome | null> {
  const by = (await authBlock(ctx, axis)) ?? (opts.project === false ? null : await projectBlock(ctx, axis));
  return by ? blocked(by) : null;
}

// ── Probe ownership ─────────────────────────────────────────────────────────────────────────────

/** A host plus its www/apex counterpart (apex → www redirects are normal). */
export function hostVariants(host: string): string[] {
  const h = host.toLowerCase();
  return h.startsWith('www.') ? [h, h.slice(4)] : [h, `www.${h}`];
}

/**
 * The production URL the HOSTING ADAPTER reports for the linked project: the only origin active probes
 * (bundle crawl, webhook POST, RLS key from the bundle) may target. Never falls back to config.domain,
 * which could name someone else's site. On success its origin (+ www/apex counterpart) is allowlisted.
 */
export async function confirmedProductionUrl(ctx: Ctx): Promise<{ ok: true; url: string } | { ok: false; outcome: CheckOutcome }> {
  const claimed = ctx.config.domain ? `https://${ctx.config.domain}` : 'the production URL';
  const cannot = (why: string): { ok: false; outcome: CheckOutcome } => ({ ok: false, outcome: skip(`cannot confirm ${claimed} belongs to your project yet (${why})`) });
  const urlCap = cap(ctx, 'hosting', 'url');
  if (!urlCap) return cannot(ctx.config.stack.hosting ? `hosting provider ${ctx.config.stack.hosting} can't report its URL (guided)` : 'no hosting provider chosen');
  const pre = await prereq(ctx, 'hosting');
  if (pre) return { ok: false, outcome: pre };
  let got: string | null;
  try {
    got = await urlCap.get(ctx, 'production');
  } catch (e) {
    return cannot(`the host could not report it: ${errMsg(e)}`);
  }
  if (!got) return ctx.config.domain ? cannot('blocked by: deploy:production; the host reports no production URL') : { ok: false, outcome: blocked('deploy:production', 'no production deployment yet') };
  let u: URL;
  try {
    u = new URL(got);
  } catch {
    return cannot(`the host reported an invalid URL`);
  }
  if (u.protocol !== 'https:') return cannot(`the host reported a non-https URL ${u.origin}`);
  for (const h of hostVariants(u.host)) allowHost(h);
  return { ok: true, url: trimSlash(u.origin + u.pathname) };
}

/**
 * GET/POST one URL. Does NOT allowlist anything: callers allowlist the confirmed origin first
 * (confirmedProductionUrl), so hosts taken from redirects or HTML can never widen the allowlist.
 */
export async function probe(ctx: Ctx, url: string, opts: { method?: 'GET' | 'POST'; body?: unknown; headers?: Record<string, string>; timeoutMs?: number } = {}) {
  return ctx.http<unknown>({ url, method: opts.method ?? 'GET', body: opts.body, headers: opts.headers, timeoutMs: opts.timeoutMs ?? 20_000 });
}

/** Domain part of "Name <user@d.com>" or "user@d.com". */
export function addressDomain(from: string | undefined): string | undefined {
  if (!from) return undefined;
  const m = /@([^\s>@]+)>?\s*$/.exec(from.trim());
  return m?.[1]?.toLowerCase();
}

/** The sending domain, derived the same way as the email link. */
export function sendingDomainOf(ctx: Ctx): string | undefined {
  return ctx.config.email?.domain ?? addressDomain(ctx.config.email?.from) ?? ctx.config.domain;
}

/**
 * Supabase-style redirect glob: `**` matches anything, `*` matches within one host label / path
 * segment, `?` one char. Trailing slashes are ignored on both sides.
 */
export function globMatch(pattern: string, url: string): boolean {
  let re = '';
  const p = trimSlash(pattern);
  for (let i = 0; i < p.length; i++) {
    const c = p[i]!;
    if (c === '*' && p[i + 1] === '*') {
      re += '.*';
      i++;
    } else if (c === '*') re += '[^/.]*';
    else if (c === '?') re += '.';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, 'i').test(trimSlash(url));
}

export function isLocalhost(url: string): boolean {
  try {
    const h = new URL(url).hostname;
    return h === 'localhost' || h.endsWith('.localhost') || h === '127.0.0.1' || h === '0.0.0.0' || h === '[::1]';
  } catch {
    return /localhost|127\.0\.0\.1/.test(url);
  }
}
