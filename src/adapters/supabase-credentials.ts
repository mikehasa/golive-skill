/** Read-only reuse of the official Supabase CLI v2 credential layout. No token export or writes. */
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import type { Ctx } from '../core/types.js';
import { Secret } from '../core/secret.js';

const TOKEN_PATTERN = /^sbp_(oauth_|v0_)?[a-f0-9]{40}$/;
const STORE_HELP = 'Run `supabase login --profile supabase` in your own terminal, then re-run golive. For CI or unsupported credential stores, use SUPABASE_ACCESS_TOKEN in your private golive credentials file. Never paste or print the credential.';

export class SupabaseCredentialError extends Error {}
const failure = (reason: string): SupabaseCredentialError => new SupabaseCredentialError(`${reason} ${STORE_HELP}`);

/** Read only owner-controlled ordinary files; errors deliberately omit content and OS messages. */
function storedFile(path: string, secret: boolean): string | undefined {
  let fd: number | undefined;
  try {
    let parent = dirname(path);
    while (parent !== dirname(parent)) {
      const stat = lstatSync(parent);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw failure('Supabase CLI storage contains an unsafe path.');
      // O_NOFOLLOW protects only the final component. Do not resolve credentials through an
      // ancestor another user could replace. Root-owned sticky temp roots preserve child ownership.
      const owned = stat.uid === 0 || !process.getuid || stat.uid === process.getuid();
      const protectedTemp = stat.uid === 0 && (stat.mode & 0o1000) !== 0;
      if (!owned || (stat.mode & 0o022) !== 0 && !protectedTemp) throw failure('Supabase CLI storage has an unsafe writable or untrusted parent directory.');
      parent = dirname(parent);
    }
    const before = lstatSync(path);
    const valid = (s: typeof before): boolean => s.isFile() && s.nlink === 1 && s.size <= 4096 &&
      (!process.getuid || s.uid === process.getuid()) && (s.mode & (secret ? 0o077 : 0o022)) === 0;
    if (before.isSymbolicLink() || !valid(before)) throw failure('Supabase CLI storage is not an owner-private regular file.');
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const current = fstatSync(fd);
    if (!valid(current) || current.ino !== before.ino || current.dev !== before.dev) throw failure('Supabase CLI storage changed while being read.');
    return readFileSync(fd, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return undefined;
    if (e instanceof SupabaseCredentialError) throw e;
    throw failure('Supabase CLI storage could not be safely read.');
  } finally { if (fd !== undefined) closeSync(fd); }
}

function credential(value: string, keychain = false): Secret {
  // Register the captured representation before decoding; neither form can appear in errors/logs.
  const captured = new Secret('supabase-cli-stored', value || '(empty)');
  let raw = captured.reveal().trim();
  if (keychain && raw.startsWith('go-keyring-base64:')) {
    const encoded = raw.slice('go-keyring-base64:'.length);
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) throw failure('Supabase CLI stored credential is malformed.');
    raw = Buffer.from(encoded, 'base64').toString('utf8');
  }
  const token = new Secret('supabase-cli-login', raw || '(empty)');
  if (!TOKEN_PATTERN.test(token.reveal())) throw failure('Supabase CLI stored credential is malformed.');
  return token;
}

/**
 * Supports the production `supabase` profile only, whose API identity is fixed by the vendor.
 * Custom/staging/Snap profiles must never send their credentials to api.supabase.com.
 * macOS uses the native read-only security command. Linux/headless use the CLI's private file
 * only when keyring is explicitly disabled (or WSL). Other keyrings fail closed, never guess.
 */
export async function readSupabaseCliCredential(
  ctx: Ctx,
  options: { platform?: string; home?: string; wsl?: boolean } = {},
): Promise<Secret | undefined> {
  let version;
  try { version = await ctx.exec('supabase', ['--version'], { cwd: ctx.cwd, timeoutMs: 15_000 }); }
  catch { return undefined; } // no CLI: the pre-existing limited CLI fallback reports install/login help
  if (version.code !== 0) return undefined;
  // Major/schema changes require a source review before reading their credential store.
  if (!/^2\.(?:11[7-9]|1[2-9]\d|[2-9]\d{2,})\.\d+(?:-[\w.-]+)?\s*$/.test(version.stdout.trim())) {
    throw failure('Supabase CLI credential reuse requires a supported v2 CLI (2.117.0 or later); this version was not recognized.');
  }
  const platform = options.platform ?? process.platform;
  if (platform === 'win32') throw failure('Windows Credential Manager reuse is not implemented by golive.');
  const root = ctx.env('SUPABASE_HOME')?.trim() || join(options.home ?? homedir(), '.supabase');
  if (!isAbsolute(root)) throw failure('SUPABASE_HOME must be an absolute path for safe credential reuse.');
  const profile = ctx.env('SUPABASE_PROFILE') || storedFile(join(root, 'profile'), false)?.trim() || 'supabase';
  if (profile.toLowerCase() !== 'supabase') throw failure('The selected Supabase CLI profile is not the supported production supabase profile; golive will not use another profile or API.');

  const noKeyring = ctx.env('SUPABASE_NO_KEYRING') === '1';
  const wsl = options.wsl ?? (platform === 'linux' && (() => {
    try { return /WSL|Microsoft/.test(readFileSync('/proc/sys/kernel/osrelease', 'utf8')); } catch { return false; }
  })());
  if (!noKeyring && !wsl) {
    if (platform !== 'darwin') throw failure('This OS keyring cannot be safely reused by golive. On Linux, run `SUPABASE_NO_KEYRING=1 supabase login --profile supabase` and run golive with SUPABASE_NO_KEYRING=1 to use the CLI private file.');
    for (const account of ['supabase', 'access-token']) {
      let result;
      try {
        result = await ctx.exec('/usr/bin/security', ['find-generic-password', '-s', 'Supabase CLI', '-a', account, '-w'], { timeoutMs: 15_000 });
      } catch { throw failure('Supabase CLI Keychain access failed or timed out. Unlock the keychain and allow the read when macOS asks.'); }
      if (result.code === 0) return credential(result.stdout, true);
      // errSecItemNotFound (-25300) is exit status 44. Denied/locked reads are not an absent item.
      if (result.code !== 44) throw failure('Supabase CLI Keychain access was denied or unavailable; no fallback account was tried. Unlock the keychain and allow the read when macOS asks.');
    }
  }
  const file = storedFile(join(root, 'access-token'), true);
  return file === undefined ? undefined : credential(file);
}

/** Explicit credentials always win, including a rejected one; resolve/memoize the CLI store once. */
export async function supabaseCredential(ctx: Ctx): Promise<Secret | undefined> {
  const explicit = ctx.envToken('SUPABASE_ACCESS_TOKEN');
  if (explicit) return explicit;
  const key = 'supabase.cliCredential';
  if (!ctx.cache.has(key)) ctx.cache.set(key, readSupabaseCliCredential(ctx));
  return ctx.cache.get(key) as Promise<Secret | undefined>;
}

export const credentialVia = (ctx: Ctx): string => ctx.envToken('SUPABASE_ACCESS_TOKEN') ? 'SUPABASE_ACCESS_TOKEN' : 'supabase CLI browser login (production profile; Management API)';
