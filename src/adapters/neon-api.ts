/** Neon control-plane transport. Provider stdout and errors never escape this module. */
import type { Ctx } from '../core/types.js';
import { Secret, secretJson } from '../core/secret.js';
import { tokenHowTo } from '../core/credentials.js';

export const NEON_API = 'https://console.neon.tech/api/v2';
export class NeonError extends Error {}
export const neonHelp = (): string => `Install the current Neon CLI with npm install -g neon, then run neon auth in a SEPARATE terminal window. Alternatively, ${tokenHowTo('NEON_API_KEY') + ' Create it at https://console.neon.tech/app/settings/api-keys.'}`;

/** Classify captured stderr without ever copying provider text (which may contain credentials). */
function cliFailure(stderr: string): string {
  const status = /\b(?:HTTP\s+|status(?:\s+code)?\s*[:=]?\s*)([45]\d{2})\b/i.exec(stderr)?.[1];
  if (/\bUnknown (?:command|arguments?)\b/i.test(stderr)) return 'category: cli-arguments. Check the golive command syntax against the installed Neon CLI; the request may have been rejected before reaching the API.';
  if (status === '401' || /Cannot run interactive auth in CI|\bnot authenticated\b|\bsign in again\b/i.test(stderr)) return `category: authentication. ${neonHelp()}`;
  if (status === '403' || /\bforbidden\b|\bpermission denied\b|\binsufficient permissions\b/i.test(stderr)) return 'category: permissions. Verify this CLI identity can perform this operation in the approved organization; do not switch accounts or broaden access automatically.';
  if (status === '429' || /\bquota\b|\brate limit\b|\b(?:project|resource) limit\b|\blimit.{0,30}(?:reached|exceeded)\b/i.test(stderr)) return 'category: limits. Check the approved Free organization limits; do not upgrade, pay, or try another organization.';
  if (/\b(?:request )?timed out\b|\btimeout\b/i.test(stderr)) return 'category: timeout. Check connectivity and Neon service status.';
  if (/Could not reach the Neon API|\bfetch failed\b|\bnetwork error\b/i.test(stderr)) return 'category: network. Check connectivity and Neon service status.';
  if (status?.startsWith('5')) return 'category: service. Check Neon service status.';
  if ((status && ['400', '404', '409', '422'].includes(status)) || /\binvalid (?:request|argument|field|parameter|region|project)\b|\bvalidation (?:error|failed)\b/i.test(stderr)) return 'category: request. Check the approved project settings against the current Neon API contract.';
  return 'category: unknown. Authentication may still be valid; check the approved organization permissions, Free-plan limits and service status. The CLI did not provide a recognized safe diagnostic.';
}

const uncertainCreate = (method: 'GET' | 'POST'): string => method === 'POST' ? ' Creation may have succeeded; inspect the exact approved organization and re-plan before any retry. Do not repeat the create blindly.' : '';

/** Creation can also return role passwords/URIs. Wrap before passing a response to adapter code. */
function protect(value: unknown, key = ''): unknown {
  if (typeof value === 'string' && /^(?:password|uri|connection_uri|connection_string|api_key|auth_data)$/i.test(key)) return value ? new Secret(`neon.${key}`, value) : undefined;
  if (Array.isArray(value)) return value.map((v) => protect(v));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, protect(v, k)]));
  return value;
}

export async function neonApi(ctx: Ctx, path: string, method: 'GET' | 'POST' = 'GET', body?: unknown): Promise<unknown> {
  // All paths are assembled by this adapter, never accepted as a URL from configuration.
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('://')) throw new NeonError('Invalid Neon API path.');
  const token = ctx.envToken('NEON_API_KEY');
  if (token) {
    let r;
    try {
      r = await ctx.http({ url: `${NEON_API}${path}`, method, headers: { Authorization: new Secret('neon.authorization', `Bearer ${token.reveal()}`) }, ...(body === undefined ? {} : { body }), timeoutMs: method === 'POST' ? 90_000 : 30_000, ...(method === 'POST' ? { idempotent: false } : {}) });
    } catch { throw new NeonError(`Neon ${method} request did not complete. ${method === 'POST' ? 'It may have succeeded; inspect the exact organization and re-plan before retrying.' : 'Check connectivity and retry.'}`); }
    if (r.status < 200 || r.status >= 300) throw new NeonError(`Neon ${method} request failed (HTTP ${r.status}); check permissions, Free-plan limits and service status. Provider response omitted.`);
    return protect(r.json);
  }
  // CI prevents the CLI from launching a browser or replacing a missing/expired login. Fixed hosts
  // override ambient NEON_API_HOST/NEON_OAUTH_HOST. CLI owns reading/refreshing its stored login.
  const args = ['api', path, '--method', method, '--output', 'json', '--api-host', NEON_API, '--oauth-host', 'https://oauth2.neon.tech'];
  // yargs strictCommands treats a standalone '-' as an unknown command. Keep stdin's marker
  // attached to its option; the body itself still travels only through Secret stdin.
  if (body !== undefined) args.push('--data=-');
  let result;
  try {
    result = await ctx.exec('neon', args, { cwd: ctx.cwd, env: { CI: '1' }, timeoutMs: method === 'POST' ? 90_000 : 30_000, ...(body === undefined ? {} : { stdin: secretJson('neon.body', body) }) });
  } catch { throw new NeonError(`Neon CLI ${method} request did not complete. Check that the CLI is installed, connectivity and service status. Provider output omitted.${uncertainCreate(method)}`); }
  if (result.code !== 0) throw new NeonError(`Neon CLI ${method} request failed (exit ${result.code}); ${cliFailure(result.stderr)} Provider output omitted.${uncertainCreate(method)}`);
  try { return protect(JSON.parse(result.stdout)); }
  catch { throw new NeonError(`Neon CLI returned an unexpected response; output omitted. Check the official Neon CLI version.${uncertainCreate(method)}`); }
}
