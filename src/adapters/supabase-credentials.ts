/** Read-only reuse of the official Supabase CLI v2 credential layout. No token export or writes. */
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import type { Ctx, ExecResult } from '../core/types.js';
import { Secret } from '../core/secret.js';

const TOKEN_PATTERN = /^sbp_(oauth_|v0_)?[a-f0-9]{40}$/;
const STORE_HELP = 'Run `supabase login --profile supabase` in your own terminal, then re-run golive. For CI or unsupported credential stores, use SUPABASE_ACCESS_TOKEN in your private golive credentials file. Never paste or print the credential.';
/** A keychain refusal is answered at the dialog or fixed in Keychain Access, not by logging in again. */
const KEYCHAIN_HELP = 'golive only reads that item; it never changes the Keychain. Where no dialog can be answered (CI, no desktop session), use SUPABASE_ACCESS_TOKEN in your private golive credentials file instead. Never paste or print the credential.';
const KEYCHAIN_REFUSED = `Supabase CLI Keychain access was denied or unavailable; no fallback account was tried. Answer the dialog macOS raises ("Allow"; "Always Allow" records it permanently for this item), or unlock the login Keychain first. ${KEYCHAIN_HELP}`;
const KEYCHAIN_UNANSWERED = `The macOS Keychain dialog for the Supabase CLI login went unanswered: macOS asks before this read because golive's read-only helper is not on the item's allow list, and nobody answered in time. Re-run and answer the dialog it raises again — "Allow" lets that run continue, and "Always Allow" records the permission permanently for this item, so it stops asking. ${KEYCHAIN_HELP}`;
/**
 * macOS raises a SecurityAgent dialog when the reading binary is not on the item's ACL (the CLI itself
 * is, which is why its own reads never ask). The first read stays short so an unattended run does not
 * stall on a dialog nobody will answer; a timeout means the OS IS asking, so one longer attended
 * attempt follows — bounded, and only in the case that would otherwise fail the whole run.
 */
const KEYCHAIN_TIMEOUT_MS = 15_000;
const KEYCHAIN_ATTENDED_TIMEOUT_MS = 120_000;
const FALLBACK_WARNED = 'supabase.cliFallbackWarned';

export class SupabaseCredentialError extends Error {}
/**
 * The reusable credential store could not be read on this machine: the macOS Keychain read went
 * unanswered (the OS was asking a human) or was refused. The version, profile and storage guards are
 * never this — they stay fatal — and an operation only the Management API can perform still fails
 * closed on any of them; this class only lets the reads the CLI answers itself keep working.
 */
export class SupabaseCredentialUnreadable extends SupabaseCredentialError {}

const failure = (reason: string): SupabaseCredentialError => new SupabaseCredentialError(`${reason} ${STORE_HELP}`);
const unreadable = (reason: string): SupabaseCredentialUnreadable => new SupabaseCredentialUnreadable(reason);

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
      let answer = await keychainRead(ctx, account, KEYCHAIN_TIMEOUT_MS);
      if (answer.kind === 'timeout') {
        ctx.log.warn(`macOS is asking whether golive may read the Supabase CLI Keychain item (read-only; golive never changes the Keychain). Click "Allow" in that dialog, or "Always Allow" to record the permission permanently for this item. Waiting ${KEYCHAIN_ATTENDED_TIMEOUT_MS / 1000}s for the answer.`);
        answer = await keychainRead(ctx, account, KEYCHAIN_ATTENDED_TIMEOUT_MS);
      }
      if (answer.kind === 'timeout') throw unreadable(KEYCHAIN_UNANSWERED);
      if (answer.kind === 'refused') throw unreadable(KEYCHAIN_REFUSED);
      if (answer.kind === 'item') return credential(answer.result.stdout, true);
    }
  }
  const file = storedFile(join(root, 'access-token'), true);
  return file === undefined ? undefined : credential(file);
}

type KeychainAnswer = { kind: 'item'; result: ExecResult } | { kind: 'absent' } | { kind: 'timeout' } | { kind: 'refused' };

/**
 * One read-only `security` call. A timeout is the OS waiting for a human click — never a refusal —
 * so the two are told apart here and nowhere else.
 */
async function keychainRead(ctx: Ctx, account: string, timeoutMs: number): Promise<KeychainAnswer> {
  let result: ExecResult;
  try {
    result = await ctx.exec('/usr/bin/security', ['find-generic-password', '-s', 'Supabase CLI', '-a', account, '-w'], { timeoutMs });
  } catch (e) {
    return e instanceof Error && /timed out after \d+ms/.test(e.message) ? { kind: 'timeout' } : { kind: 'refused' };
  }
  if (result.code === 0) return { kind: 'item', result };
  // errSecItemNotFound (-25300) is exit status 44. Denied/locked reads are not an absent item.
  return result.code === 44 ? { kind: 'absent' } : { kind: 'refused' };
}

/** Explicit credentials always win, including a rejected one; resolve/memoize the CLI store once. */
export async function supabaseCredential(ctx: Ctx): Promise<Secret | undefined> {
  const explicit = ctx.envToken('SUPABASE_ACCESS_TOKEN');
  if (explicit) return explicit;
  const key = 'supabase.cliCredential';
  if (!ctx.cache.has(key)) ctx.cache.set(key, readSupabaseCliCredential(ctx));
  return ctx.cache.get(key) as Promise<Secret | undefined>;
}

/**
 * The reusable credential for the reads the supabase CLI answers itself (project listing, API keys,
 * the RLS table query): `undefined` when this machine's store could not be read, so those reads run
 * through the CLI — which reads its own store without a prompt and never exposes the value. Only the
 * OS-store failure degrades; the version, profile and storage guards still throw, and an operation
 * that needs the Management API calls `supabaseCredential` and fails closed on the same guidance.
 * The failure is logged once: those CLI reads would otherwise succeed and the run would never say why
 * the complete flow is unavailable.
 */
export async function supabaseCredentialOrUndefined(ctx: Ctx): Promise<Secret | undefined> {
  try {
    return await supabaseCredential(ctx);
  } catch (e) {
    if (!(e instanceof SupabaseCredentialUnreadable)) throw e;
    if (!ctx.cache.has(FALLBACK_WARNED)) {
      ctx.cache.set(FALLBACK_WARNED, true);
      ctx.log.warn(`${e.message} The operations the supabase CLI performs itself keep working; anything that needs the Management API fails closed with this same guidance.`);
    }
    return undefined;
  }
}

export const credentialVia = (ctx: Ctx): string => ctx.envToken('SUPABASE_ACCESS_TOKEN') ? 'SUPABASE_ACCESS_TOKEN' : 'supabase CLI browser login (production profile; Management API)';
