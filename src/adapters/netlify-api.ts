/** Netlify CLI reads reuse its login; process failures can fall back to same-identity HTTPS GETs. */
import { tokenHowTo } from '../core/credentials.js';
import { ExecError } from '../core/exec.js';
import { Secret, isRegisteredSecret, redact } from '../core/secret.js';
import type { Ctx, HttpRequest } from '../core/types.js';
import { readNetlifyCliToken } from './netlify-credentials.js';

export const NETLIFY_API = 'https://api.netlify.com/api/v1';
export const NETLIFY_TOKEN = 'NETLIFY_AUTH_TOKEN';
export const CLI_ENV = { CI: '1', NO_COLOR: '1', NETLIFY_AUTH_TOKEN: '', NETLIFY_API_URL: '' };
export const LOGIN_HELP = 'Install the official Netlify CLI if needed, then run `netlify login` in a separate terminal window. golive reuses only its current-user OAuth entry in-process for HTTPS requests; it never prints or modifies the credential file.';
export function tokenHelp(): string {
  return `First run netlify login in a separate terminal window. If its OAuth store cannot be reused, a short-lived personal access token at https://app.netlify.com/user/applications is an optional fallback. ${tokenHowTo(NETLIFY_TOKEN)}`;
}
export class NetlifyError extends Error {
  constructor(message: string, readonly status?: number) { super(redact(message)); this.name = 'NetlifyError'; }
}
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new NetlifyError('Netlify returned an unexpected response shape.');
  return value as Record<string, unknown>;
}
export function identifier(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value) || isRegisteredSecret(value)) throw new NetlifyError('Netlify returned an invalid resource identity.');
  return value;
}
export function label(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 160 || /[\r\n\x00-\x1f]/.test(value) || isRegisteredSecret(value)) throw new NetlifyError('Netlify returned an invalid resource label.');
  return redact(value);
}
export function parseJson(text: string): unknown {
  try { return JSON.parse(text); } catch { throw new NetlifyError('Netlify CLI did not return valid JSON; update the official CLI and retry.'); }
}

type Session = { ok: true; userId: string } | { ok: false; howToFix: string };
const sessions = new WeakMap<object, Promise<Session>>();
export function cliSession(ctx: Ctx): Promise<Session> {
  let result = sessions.get(ctx);
  if (!result) {
    result = (async (): Promise<Session> => {
      for (let attempt = 0; attempt < 2; attempt++) {
        let r;
        try {
          r = await ctx.exec('netlify', ['api', 'getCurrentUser'], { cwd: ctx.cwd, env: CLI_ENV, timeoutMs: 30_000 });
        } catch (e) {
          if (e instanceof ExecError && e.message === 'netlify: command not found') return { ok: false, howToFix: 'Netlify CLI is not installed or is not on PATH. Install the official CLI, then retry doctor or plan; existing login state was not checked.' };
          if (attempt === 0) continue; // A bounded retry of this read only; no token is read yet.
          const timeout = e instanceof ExecError && /^netlify timed out after \d+ms$/.test(e.message);
          return { ok: false, howToFix: `Netlify CLI account verification ${timeout ? 'timed out' : 'could not complete'} after two read-only attempts. Login state is unknown; check the CLI/network and retry doctor or plan. No CLI output was logged.` };
        }
        if (r.code !== 0) return { ok: false, howToFix: `Netlify CLI account verification failed (exit ${r.code}). Check the CLI/network and login status privately, then retry doctor or plan. If the CLI reports a missing login, run netlify login in a separate terminal window. No CLI output was logged.` };
        try { return { ok: true, userId: identifier(object(parseJson(r.stdout)).id) }; }
        catch { return { ok: false, howToFix: 'Netlify CLI account verification returned an unexpected response. Check or update the official CLI, then retry doctor or plan; login state is unknown. No CLI output was logged.' }; }
      }
      return { ok: false, howToFix: 'Netlify CLI account verification could not complete; login state is unknown. Retry doctor or plan.' };
    })();
    sessions.set(ctx, result);
  }
  return result;
}

const credentials = new WeakMap<object, Promise<Secret>>();
export function netlifyCredential(ctx: Ctx): Promise<Secret> {
  let promise = credentials.get(ctx);
  if (!promise) {
    promise = (async () => {
      const session = await cliSession(ctx);
      let token = ctx.envToken(NETLIFY_TOKEN);
      if (!token && session.ok) {
        try { token = readNetlifyCliToken(session.userId); }
        catch { if (!ctx.envToken(NETLIFY_TOKEN)) throw new NetlifyError('The private Netlify CLI OAuth store could not be reused safely. Re-run netlify login in your own terminal or use the optional golive credential fallback. No credential content was logged.'); }
      }
      if (!token) throw new NetlifyError(tokenHelp());
      const who = object(await httpWithToken(ctx, token, 'GET', '/user'));
      if (session.ok && who.id !== session.userId) throw new NetlifyError('Netlify CLI and HTTPS credential identities differ. Re-login to the intended account before any write.');
      identifier(who.id);
      return token;
    })();
    credentials.set(ctx, promise);
  }
  return promise;
}

/** Never includes raw response/error bodies: site/deploy/env responses can contain credentials. */
async function httpWithToken(ctx: Ctx, token: Secret, method: NonNullable<HttpRequest['method']>, path: string, body?: unknown): Promise<unknown> {
  let response;
  try {
    response = await ctx.http({ method, url: NETLIFY_API + path,
      headers: { authorization: new Secret(NETLIFY_TOKEN, `Bearer ${token.reveal()}`) }, body,
      timeoutMs: 60_000,
    });
  } catch { throw new NetlifyError('Netlify HTTPS request failed; no provider response body was logged.'); }
  if (response.status < 200 || response.status >= 300) {
    throw new NetlifyError(`Netlify API request failed (HTTP ${response.status}); check access to the exact team/project and retry. No response body was logged.`, response.status);
  }
  return response.json;
}

export async function netlifyHttp(ctx: Ctx, method: NonNullable<HttpRequest['method']>, path: string, body?: unknown): Promise<unknown> {
  return httpWithToken(ctx, await netlifyCredential(ctx), method, path, body);
}

/** CLI arguments contain resource identities and read filters only; no environment values. */
export async function netlifyRead(ctx: Ctx, operation: string, path: string, params?: Record<string, unknown>): Promise<unknown> {
  if ((await cliSession(ctx)).ok) {
    const args = ['api', operation];
    if (params) args.push('--data', JSON.stringify(params));
    let result;
    try {
      result = await ctx.exec('netlify', args, { cwd: ctx.cwd, env: CLI_ENV, timeoutMs: 60_000 });
    } catch {
      // Only a process failure permits this read-only retry. netlifyCredential verifies the
      // HTTPS principal against the successful CLI session before the target GET is issued.
      ctx.log.warn('Netlify CLI read did not complete; trying HTTPS for this read after checking it matches the CLI account. No CLI output was logged.');
      return netlifyHttp(ctx, 'GET', path);
    }
    if (result.code !== 0) throw new NetlifyError(`Netlify CLI ${operation} failed (exit ${result.code}); check access to the selected team/project. No CLI output was logged.`);
    return parseJson(result.stdout);
  }
  return netlifyHttp(ctx, 'GET', path);
}
