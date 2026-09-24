/**
 * GoDaddy CLI (`gddy`) transport.
 *
 * gddy is GoDaddy's official CLI; `gddy api call` performs an authenticated request against any
 * documented endpoint using the user's own OAuth session (`gddy auth login`) or its configured
 * `GDDY_PAT`. golive never handles that credential — it only executes commands. The transport
 * mirrors the REST path exactly (literal v3 path, arbitrary method, JSON body), so every ownership
 * and safety rule above it stays identical whichever transport serves a request.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Ctx } from '../core/types.js';

/** Pinned minimum: the catalog of this version carries the DNS record operations golive uses. */
export const MIN_VERSION: readonly [number, number, number] = [0, 2, 20];
/** A cached session this close to expiry without refresh is treated as unusable. */
const EXPIRY_MARGIN_MS = 5 * 60 * 1000;
const CACHE_KEY = 'godaddy.cli';
const VERSION_TIMEOUT_MS = 15_000;
const CALL_TIMEOUT_MS = 60_000;

export interface GoDaddyCli {
  bin: string;
  version: string;
  /** Non-secret session identity from `gddy auth status` (e.g. "customer:<uuid>"). */
  identity: string;
}

export function cliLoginHelp(): string {
  return 'install and sign in once with the official GoDaddy CLI (`curl -fsSL https://github.com/godaddy/cli/releases/latest/download/install.sh | bash`, then `gddy auth login` in your terminal — the browser session is cached locally)';
}

/** Detect an installed, recent-enough gddy with a usable cached session. Memoized per run. */
export async function godaddyCli(ctx: Ctx): Promise<GoDaddyCli | null> {
  const cached = ctx.cache.get(CACHE_KEY);
  if (cached !== undefined) return cached as GoDaddyCli | null;
  const found = await detect(ctx);
  ctx.cache.set(CACHE_KEY, found);
  return found;
}

async function detect(ctx: Ctx): Promise<GoDaddyCli | null> {
  // PATH first so a user-managed install wins; then the official installer's default location.
  for (const bin of ['gddy', join(homedir(), '.local', 'bin', 'gddy')]) {
    try {
      const version = await ctx.exec(bin, ['--version'], { timeoutMs: VERSION_TIMEOUT_MS });
      if (version.code !== 0) continue;
      const parsed = parseVersion(version.stdout);
      if (!parsed) continue;
      const status = await ctx.exec(bin, ['auth', 'status', '-o', 'json'], { timeoutMs: VERSION_TIMEOUT_MS });
      if (status.code !== 0) continue;
      const identity = usableSession(status.stdout);
      if (!identity) continue;
      return { bin, version: parsed, identity };
    } catch {
      // Not installed at this candidate, or it could not run: try the next one.
    }
  }
  return null;
}

function parseVersion(out: string): string | null {
  const m = /gddy version (\d+)\.(\d+)\.(\d+)/.exec(out);
  if (!m) return null;
  const v = [Number(m[1]), Number(m[2]), Number(m[3])];
  for (let i = 0; i < 3; i++) {
    if (v[i]! > MIN_VERSION[i]!) return `${v[0]}.${v[1]}.${v[2]}`;
    if (v[i]! < MIN_VERSION[i]!) return null;
  }
  return `${v[0]}.${v[1]}.${v[2]}`;
}

/** The production-environment session, when it is unexpired (or refreshable) — else null. */
function usableSession(out: string): string | null {
  const parsed = safeJson(out);
  const rows = parsed && typeof parsed === 'object' && Array.isArray((parsed as { data?: unknown }).data)
    ? ((parsed as { data: unknown[] }).data)
    : null;
  if (!rows) return null;
  const prod = rows.find((r) => r && typeof r === 'object' && (r as Record<string, unknown>).env === 'prod') as Record<string, unknown> | undefined;
  if (!prod || prod.expired !== false) return null;
  const expires = typeof prod.expires_at === 'string' ? Date.parse(prod.expires_at) : NaN;
  if (Number.isFinite(expires) && expires - Date.now() < EXPIRY_MARGIN_MS && prod.refreshable !== true) return null;
  return typeof prod.identity === 'string' && prod.identity ? prod.identity : 'signed in';
}

export interface CliResult {
  /** HTTP status the CLI reported, or 0 when the CLI itself could not complete the request. */
  status: number;
  /** The v3 response body (present only for 2xx results). */
  json?: unknown;
}

/**
 * One authenticated request through `gddy api call`. Never throws for HTTP statuses — the caller
 * maps them exactly like the REST path. Record values travel in argv, which is fine: DNS record
 * content is public by design, and no credential is ever passed (gddy reads its own store).
 */
export async function cliRequest(ctx: Ctx, cli: GoDaddyCli, method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<CliResult> {
  const args = ['api', 'call', `/v3/domains${path}`, '-X', method, '-o', 'json'];
  if (body !== undefined) args.push('-d', JSON.stringify(body));
  let res;
  try {
    res = await ctx.exec(cli.bin, args, { timeoutMs: CALL_TIMEOUT_MS });
  } catch {
    return { status: 0 };
  }
  if (res.code === 0) {
    const outer = safeJson(res.stdout);
    const inner = outer && typeof outer === 'object' ? (outer as { data?: unknown }).data : null;
    const record = inner && typeof inner === 'object' && !Array.isArray(inner) ? (inner as Record<string, unknown>) : null;
    if (!record || !Number.isInteger(record.status)) return { status: 0 };
    return { status: record.status as number, json: record.data };
  }
  // Error envelope: {error:{code,message,system}, fix}. The message embeds the HTTP status and the
  // provider body; only the status is extracted — provider text is never echoed.
  const failed = safeJson(res.stdout) ?? safeJson(res.stderr);
  const error = failed && typeof failed === 'object' ? (failed as { error?: unknown }).error : null;
  const message = error && typeof error === 'object' ? (error as { message?: unknown }).message : null;
  const match = typeof message === 'string' ? /HTTP error (\d{3})/.exec(message) : null;
  return { status: match ? Number(match[1]) : 0 };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
