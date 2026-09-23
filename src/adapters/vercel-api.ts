/**
 * Vercel transport: one `vercelApi()` that prefers the user's logged-in CLI (`vercel api`, body on
 * stdin) and falls back to a VERCEL_TOKEN from the environment (fetch with a Bearer header).
 * Responses may carry secrets (env values, protection-bypass keys), so callers extract only the
 * fields they need and nothing here ever logs or echoes a response body.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tokenHowTo } from '../core/credentials.js';
import { Secret, redact, secretJson } from '../core/secret.js';
import type { Ctx } from '../core/types.js';

export const API_BASE = 'https://api.vercel.com';
const CLI_TIMEOUT = 120_000;

/** Where to create a Vercel token (prefix for tokenHowTo). */
export const TOKEN_WHERE = 'Create a team-scoped token with an expiry at https://vercel.com/account/tokens.';

/**
 * How a human gets golive authenticated. The CLI login is preferred: the vendor CLI stores it, so the
 * agent's shell sees it with no copy-paste. The token route goes through the credentials file,
 * because a token `export`ed in the human's own terminal never reaches the agent's shell.
 */
export function howToLogin(): string {
  return (
    "run `vercel login` in a separate terminal window (the Terminal app or your IDE's terminal; Claude Code's `!` prefix has no interactive terminal, so logins fail there); install/update the CLI first with `npm i -g vercel@latest` if needed. " +
    `Alternatively, instead of logging in (the Vercel CLI must still be installed: golive deploys through it): ${TOKEN_WHERE} ${tokenHowTo('VERCEL_TOKEN')}`
  );
}

/** The one fix for a missing Vercel CLI (deploys always run through it, even with VERCEL_TOKEN). */
export const INSTALL_CLI = 'install it: npm i -g vercel (in your own terminal; in Claude Code: `! npm i -g vercel`)';

export interface WhoAmI {
  username: string;
  email?: string;
  team: { id: string; slug: string; name?: string } | null;
}

export type Session =
  | { kind: 'cli'; user: WhoAmI }
  /** `cliInstalled`: API calls work over HTTP, but `vercel deploy` still needs the binary. */
  | { kind: 'token'; token: Secret; cliInstalled: boolean }
  | { kind: 'none'; cliInstalled: boolean };

export class VercelError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly code?: string,
    /** The API's own error message (redacted), without golive's framing — for matching specific errors. */
    readonly detail?: string,
  ) {
    super(redact(message));
    this.name = 'VercelError';
    if (detail !== undefined) this.detail = redact(detail);
  }
}

// Keyed by the exec function: a StepContext is a spread of the Ctx, so it shares exec but not identity.
const sessions = new WeakMap<object, Promise<Session>>();

/** Logged-in CLI first (no copy-paste), then VERCEL_TOKEN. Cached per ctx. Never throws. */
export function session(ctx: Ctx): Promise<Session> {
  let s = sessions.get(ctx.exec);
  if (!s) {
    s = resolveSession(ctx);
    sessions.set(ctx.exec, s);
  }
  return s;
}

async function resolveSession(ctx: Ctx): Promise<Session> {
  let cliInstalled = false;
  try {
    const r = await ctx.exec('vercel', ['whoami', '--format', 'json', '--non-interactive'], { cwd: ctx.cwd, env: { NO_COLOR: '1' }, timeoutMs: 30_000 });
    cliInstalled = true;
    if (r.code === 0) {
      const j = parseJson<Partial<WhoAmI>>(r.stdout);
      if (j?.username) return { kind: 'cli', user: { username: j.username, email: j.email, team: j.team ?? null } };
    }
  } catch {
    /* CLI missing or broken: fall through to the token */
  }
  const token = ctx.envToken('VERCEL_TOKEN');
  if (token) return { kind: 'token', token, cliInstalled };
  return { kind: 'none', cliInstalled };
}

// ── Scope (team) ──────────────────────────────────────────────────────────────────────────────

export interface LinkFile {
  projectId?: string;
  orgId?: string;
  projectName?: string;
}

/** `.vercel/project.json` written by `vercel link` (read-only; golive never writes it). */
export function readLinkFile(ctx: Ctx): LinkFile | null {
  const candidates: string[] = [];
  try {
    candidates.push(readFileSync(join(ctx.cwd, '.vercel', 'project.json'), 'utf8'));
  } catch {
    /* not linked locally */
  }
  const fromDetect = ctx.detect.configs['.vercel/project.json'];
  if (fromDetect) candidates.push(fromDetect);
  for (const text of candidates) {
    const j = parseJson<LinkFile>(text);
    if (j && (j.projectId || j.orgId)) return { projectId: j.projectId, orgId: j.orgId, projectName: j.projectName };
  }
  return null;
}

/** The team/user id owning the project: golive state, then the local link file, then VERCEL_ORG_ID. */
export function orgId(ctx: Ctx): string | undefined {
  return ctx.state.resource('vercel.orgId') ?? readLinkFile(ctx)?.orgId ?? (ctx.env('VERCEL_ORG_ID'));
}

function cliScope(ctx: Ctx, user: WhoAmI): string | undefined {
  const org = orgId(ctx);
  if (org?.startsWith('team_')) return org;
  // Personal project while the CLI's current scope is a team: switch back to the personal account.
  if (org && user.team) return user.username;
  return undefined;
}

// ── Requests ──────────────────────────────────────────────────────────────────────────────────

export type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

export interface ApiOpts {
  /** Exact approved account/team; avoids following a mutable CLI default during project creation. */
  scopeId?: string;
  /**
   * The call is safe to re-send after a 5xx/timeout (e.g. a verification POST). Never set it for a
   * create: the first attempt may have succeeded.
   */
  idempotent?: boolean;
}

/**
 * Call the Vercel REST API. `path` starts with "/v…" and may carry a query string. The body may
 * contain Secrets; it reaches the CLI on stdin or fetch in the JSON body, nowhere else.
 */
export async function vercelApi<T = unknown>(ctx: Ctx, method: Method, path: string, body?: unknown, opts?: ApiOpts): Promise<T> {
  const s = await session(ctx);
  if (s.kind === 'cli') return viaCli<T>(ctx, s.user, method, path, body, opts);
  if (s.kind === 'token') return viaToken<T>(ctx, s.token, method, path, body, opts);
  throw new VercelError(`Not authenticated with Vercel: ${howToLogin()}`, 401, 'not_authenticated');
}

async function viaCli<T>(ctx: Ctx, user: WhoAmI, method: Method, path: string, body: unknown, opts?: ApiOpts): Promise<T> {
  const args = ['api', path, '-X', method, '--raw', '--non-interactive'];
  if (body !== undefined) args.push('--input', '-');
  const scope = opts?.scopeId ? (opts.scopeId.startsWith('team_') ? opts.scopeId : user.username) : cliScope(ctx, user);
  if (scope) args.push('--scope', scope);
  const r = await ctx.exec('vercel', args, { cwd: ctx.cwd, stdin: body === undefined ? undefined : serialise(body), env: { NO_COLOR: '1' }, timeoutMs: CLI_TIMEOUT });
  if (r.code !== 0) {
    if (/unknown command|not a valid command|command not found/i.test(r.stderr)) {
      const token = ctx.envToken('VERCEL_TOKEN');
      if (token) return viaToken<T>(ctx, token, method, path, body, opts);
      throw new VercelError('Your Vercel CLI has no `vercel api` command. Run `npm i -g vercel@latest` in your terminal, then retry.', undefined, 'cli_outdated');
    }
    const { status, code, message } = parseCliError(r.stderr || r.stdout);
    throw apiError(method, path, status, code, message);
  }
  return (parseJson<T>(r.stdout) ?? ({} as T)) as T;
}

async function viaToken<T>(ctx: Ctx, token: Secret, method: Method, path: string, body: unknown, opts?: ApiOpts): Promise<T> {
  const org = opts?.scopeId ?? orgId(ctx);
  const url = API_BASE + path + (org?.startsWith('team_') ? `${path.includes('?') ? '&' : '?'}teamId=${encodeURIComponent(org)}` : '');
  const res = await ctx.http<unknown>({
    method,
    url,
    headers: { authorization: new Secret('VERCEL_TOKEN', `Bearer ${token.reveal()}`) },
    body,
    timeoutMs: 60_000,
    ...(opts?.idempotent ? { idempotent: true } : {}),
  });
  if (res.status < 200 || res.status >= 300) {
    const err = (res.json as { error?: { code?: string; message?: string } } | undefined)?.error;
    throw apiError(method, path, res.status, err?.code, err?.message ?? (res.json === undefined ? res.text.slice(0, 200) : ''));
  }
  return (res.json ?? {}) as T;
}

/** JSON for the child's stdin; a Secret when it carries one (see core secretJson). */
function serialise(body: unknown): string | Secret {
  return secretJson('vercel-api-body', body);
}

function parseCliError(text: string): { status?: number; code?: string; message: string } {
  const json = text.match(/\{[\s\S]*\}/);
  const j = json ? parseJson<{ error?: { code?: string; message?: string }; code?: string; message?: string; status?: number }>(json[0]) : null;
  const status = j?.status ?? Number(text.match(/\b([45]\d\d)\b/)?.[1] ?? NaN);
  const code = j?.error?.code ?? j?.code ?? (/not[_ ]found/i.test(text) ? 'not_found' : undefined);
  const message = j?.error?.message ?? j?.message ?? text.trim().split('\n').slice(-3).join(' ').slice(0, 300);
  return { status: Number.isFinite(status) ? status : code === 'not_found' ? 404 : undefined, code, message };
}

function apiError(method: string, path: string, status: number | undefined, code: string | undefined, message: string): VercelError {
  const where = `Vercel API ${method} ${path.split('?')[0]}`;
  const what = `${where} failed${status ? ` (HTTP ${status}${code ? `, ${code}` : ''})` : code ? ` (${code})` : ''}: ${message || 'no error message'}`;
  return new VercelError(`${what}. ${hintFor(status)}`.trim(), status, code, message);
}

function hintFor(status: number | undefined): string {
  if (status === 401) return `Your Vercel session is invalid or expired: ${howToLogin()}`;
  if (status === 403) return 'The account lacks access to this team/project: check the team scope (vercel.orgId in .golive/state.json or .vercel/project.json) or run `vercel switch` in your terminal.';
  if (status === 404) return 'Not found: check the project id/name and team scope.';
  if (status === 429) return 'Rate limited by Vercel: wait a minute and retry.';
  if (status && status >= 500) return 'Vercel had a server error: retry shortly (see https://www.vercel-status.com).';
  return '';
}

export function isNotFound(e: unknown): boolean {
  return e instanceof VercelError && (e.status === 404 || e.code === 'not_found');
}

export function parseJson<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}
