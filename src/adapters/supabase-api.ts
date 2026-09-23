/**
 * Supabase transport: Management API over HTTPS (explicit token or reused CLI login) with the
 * logged-in `supabase` CLI as a fallback for the operations it covers. Errors never echo response
 * bodies or CLI stdout (both can carry keys); only status codes and redacted short messages.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Ctx, HttpRequest } from '../core/types.js';
import { Secret, redact } from '../core/secret.js';
import { tokenHowTo } from '../core/credentials.js';
export { supabaseCredential as token } from './supabase-credentials.js';

export const API = 'https://api.supabase.com/v1';
export const TOKEN_ENV = 'SUPABASE_ACCESS_TOKEN';
export const STATE_REF = 'supabase.ref';
export const REF_RE = /^[a-z]{20}$/;

/** Current golive CLI fallback coverage, not a limit of the provider's own CLI. */
export const CLI_COVERS = 'listing and selecting projects, reading API keys and the RLS check';
export const TOKEN_ONLY = 'auth redirect settings, creating a project, the pooled DATABASE_URL and security advisors';

/**
 * How to get SUPABASE_ACCESS_TOKEN to golive: where to create it, then the standard safe instruction
 * (credentials file, never chat). A function because the credentials path is read at call time.
 */
export function tokenHelp(): string {
  return `At https://supabase.com/dashboard/account/tokens, create a token scoped to the existing project and the operations needed (API Keys and API Key Secrets Read to reveal keys; Auth Config Read to inspect auth, plus Auth Config and Project Settings Read-write to update it). Creating projects also needs organization/account management access to the intended organization; project-scoped Full access is not enough. In the current Dashboard rollout, that option may be under experimental API tokens; check the token's access scope, not just the Full access label. Use a short expiry. ${tokenHowTo(TOKEN_ENV)}`;
}
export const LOGIN_HELP = "run `supabase login` in a separate terminal window (the Terminal app or your IDE's terminal; Claude Code's `!` prefix has no interactive terminal, so logins fail there)";

export class SupabaseError extends Error {
  /** HTTP status when the error came from a Management API response. */
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    if (status !== undefined) this.status = status;
  }
}

export function needToken(what: string): SupabaseError {
  return new SupabaseError(`${what} needs a reusable Supabase login. ${LOGIN_HELP}; golive reuses its production-profile credential for the Management API on supported stores. Alternatively, ${tokenHelp()} Then re-run.`);
}

export function assertRef(ref: unknown): string {
  if (typeof ref !== 'string' || !REF_RE.test(ref)) throw new SupabaseError(`not a Supabase project ref: ${JSON.stringify(ref)} (expected 20 lowercase letters)`);
  return ref;
}

/** The ref `supabase link` wrote into the repo (supabase/.temp/project-ref), if any. */
export function linkedRef(cwd: string): string | undefined {
  const p = join(cwd, 'supabase', '.temp', 'project-ref');
  if (!existsSync(p)) return undefined;
  const ref = readFileSync(p, 'utf8').trim();
  return REF_RE.test(ref) ? ref : undefined;
}

function messageOf(json: unknown): string {
  if (!json || typeof json !== 'object') return '';
  const o = json as Record<string, unknown>;
  const m = [o.message, o.msg, o.error].find((x) => typeof x === 'string') as string | undefined;
  return m ? redact(m).slice(0, 300) : '';
}

export function apiFailure(status: number, json: unknown, what: string, path = ''): SupabaseError {
  const detail = messageOf(json);
  const tail = detail ? ` (${detail})` : '';
  switch (status) {
    case 401:
      return new SupabaseError(`${what} failed: Supabase rejected the selected credential (401, invalid or expired)${tail}. Refresh the CLI browser login if using it, or replace the explicit SUPABASE_ACCESS_TOKEN. ${tokenHelp()}`, status);
    case 403:
      return new SupabaseError(`${what} failed: the token is not allowed to do this (403)${tail}. ${path.includes('/api-keys') ? 'Check API Keys Read and API Key Secrets Read for this project; Full access on a different project does not apply.' : path.startsWith('/organizations') || path === '/projects' ? 'Check organization/account management access to the intended organization; listing a project does not grant organization or project-creation access.' : 'Check the token\'s selected project and the permission required for this operation.'} ${tokenHelp()}`, status);
    case 404:
      return new SupabaseError(`${what} failed: not found (404)${tail}. Check the project ref and that this Supabase account can access it.`, status);
    case 429:
      return new SupabaseError(`${what} failed: Supabase rate limit hit (429). Wait a minute and re-run.`, status);
    default:
      return new SupabaseError(`${what} failed: HTTP ${status}${tail}.`, status);
  }
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Management API request; throws an actionable, secret-free error unless 2xx. `opts.idempotent`
 * marks a read-only POST as safe to re-send; never set it on a create.
 */
export async function api<T>(
  ctx: Ctx,
  tok: Secret,
  method: NonNullable<HttpRequest['method']>,
  path: string,
  what: string,
  body?: unknown,
  opts: { idempotent?: boolean; timeoutMs?: number } = {},
): Promise<T> {
  const res = await ctx.http<T>({
    method,
    url: API + path,
    headers: { Authorization: new Secret(TOKEN_ENV, `Bearer ${tok.reveal()}`), Accept: 'application/json' },
    body,
    ...(opts.idempotent !== undefined ? { idempotent: opts.idempotent } : {}),
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
  });
  if (res.status < 200 || res.status >= 300) throw apiFailure(res.status, res.json, what, path);
  return res.json;
}

/** Same as `api` but returns the status instead of throwing (for probes like auth()). */
export async function apiStatus(ctx: Ctx, tok: Secret, path: string): Promise<{ status: number; json: unknown }> {
  const res = await ctx.http({ url: API + path, headers: { Authorization: new Secret(TOKEN_ENV, `Bearer ${tok.reveal()}`), Accept: 'application/json' } });
  return { status: res.status, json: res.json };
}

/**
 * Run the supabase CLI and parse JSON stdout. stdout is never included in errors (it may hold
 * revealed keys); stderr is redacted and truncated. `stdin` carries SQL, never argv.
 */
export async function cli<T>(ctx: Ctx, args: string[], what: string, stdin?: string): Promise<T> {
  let r;
  try {
    r = await ctx.exec('supabase', args, { cwd: ctx.cwd, timeoutMs: 120_000, ...(stdin !== undefined ? { stdin } : {}) });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/command not found|ENOENT/.test(msg)) {
      throw new SupabaseError(`${what}: the supabase CLI is not installed and SUPABASE_ACCESS_TOKEN is not set. Either install the CLI (https://supabase.com/docs/guides/cli) and ${LOGIN_HELP} (preferred), or set the token: ${tokenHelp()}`);
    }
    throw new SupabaseError(`${what}: ${redact(msg).slice(0, 300)}`);
  }
  if (r.code !== 0) {
    const err = redact(r.stderr.trim()).slice(0, 300);
    if (/access token|not logged in|supabase login/i.test(err)) {
      throw new SupabaseError(`${what}: the supabase CLI is not logged in. ${cap(LOGIN_HELP)} (preferred), or set the token: ${tokenHelp()}`);
    }
    throw new SupabaseError(`${what} failed (supabase CLI exit ${r.code})${err ? `: ${err}` : ''}.`);
  }
  return parseCliJson<T>(r.stdout, what);
}

function parseCliJson<T>(stdout: string, what: string): T {
  const t = stdout.trim();
  try {
    return JSON.parse(t) as T;
  } catch {
    const i = t.search(/[[{]/);
    if (i >= 0) {
      try {
        return JSON.parse(t.slice(i)) as T;
      } catch {
        /* fall through */
      }
    }
  }
  throw new SupabaseError(`${what}: the supabase CLI did not return JSON; upgrade it (\`npm i -g supabase@latest\` or your package manager) and retry.`);
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
