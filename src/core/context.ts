import type { Adapter, Ctx, DetectResult, Exec, Http, Logger, ReleaseIdentity, ShipConfig, StateStore } from './types.js';
import { Secret } from './secret.js';
import { readCredential } from './credentials.js';
import { assertReleaseSchemas } from './release.js';

/**
 * Tokens come from the process environment or golive's own credentials file (see credentials.ts),
 * which the human edits themselves. golive never writes a token to disk. Adapters normally reuse a
 * vendor login through its CLI. Netlify and Supabase additionally reuse supported vendor credential
 * stores in-process for secret-safe HTTPS operations; credential values never enter CLI argv.
 */
export function envToken(name: string): Secret | undefined {
  const v = process.env[name] || readCredential(name);
  return v ? new Secret(name, v) : undefined;
}

export function createCtx(parts: { cwd: string; release: ReleaseIdentity; exec: Exec; http: Http; log: Logger; config: ShipConfig; state: StateStore; detect: DetectResult; adapters: Adapter[]; envToken?: (n: string) => Secret | undefined; env?: (n: string) => string | undefined }): Ctx {
  assertReleaseSchemas(parts.release);
  return { ...parts, release: structuredClone(parts.release), envToken: parts.envToken ?? envToken, env: parts.env ?? ((n) => process.env[n] || undefined), cache: new Map() };
}
