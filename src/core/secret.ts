import { createHash } from 'node:crypto';
import { inspect } from 'node:util';

/**
 * A secret value that cannot leak by accident.
 *
 * The agent reads everything we print, and agent transcripts are logged and sent to model providers,
 * so a secret must never reach stdout/stderr or argv. `Secret` keeps the value in a private field;
 * every stringification path (String(), template literals, JSON.stringify, util.inspect,
 * console.log) yields a label + short fingerprint instead. The only way to read the value is
 * `reveal()`, which is called at the last moment: for transport or an explicitly requested local
 * credential-file write from native input.
 */
export class Secret {
  readonly #value: string;
  readonly name: string;
  readonly fingerprint: string;

  constructor(name: string, value: string) {
    if (!value) throw new Error(`Secret ${name} is empty`);
    this.#value = value;
    this.name = name;
    this.fingerprint = fingerprint(value);
    registerSecretValue(value, name);
  }

  /** Read the raw value only at a transport/private credential-write boundary, never for output. */
  reveal(): string {
    return this.#value;
  }

  /** Last 4 chars, for humans comparing against a dashboard. Only for long values. */
  get last4(): string {
    return this.#value.length >= 16 ? this.#value.slice(-4) : '';
  }

  toString(): string {
    return `[secret ${this.name} fp:${this.fingerprint}]`;
  }
  toJSON(): { secret: string; fp: string } {
    return { secret: this.name, fp: this.fingerprint };
  }
  [inspect.custom](): string {
    return this.toString();
  }
}

/** Stable short fingerprint: first 8 hex chars of sha256. Safe to print and to store in state. */
export function fingerprint(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 8);
}

// ── Redaction registry ──────────────────────────────────────────────────────────────────────────
// Every Secret registers its value here so the output layer can scrub it even if some code path
// (e.g. an error message echoing a response body) accidentally includes it.

const registry = new Map<string, string>(); // value -> name

export function registerSecretValue(value: string, name: string): void {
  // Very short values would cause false-positive scrubbing of ordinary text; they are not credentials.
  if (value.length >= 8) registry.set(value, name);
}

export function isRegisteredSecret(value: string): boolean {
  for (const v of registry.keys()) if (value.includes(v)) return true;
  return false;
}

/** Known credential shapes, scrubbed even if never registered (defense in depth). */
const PATTERNS: Array<[RegExp, string]> = [
  [/\b(sk|rk)_(live|test)_[A-Za-z0-9]{10,}\b/g, 'stripe-key'],
  [/\bwhsec_[A-Za-z0-9+/=]{10,}\b/g, 'stripe-webhook-secret'],
  [/\bsb_secret_[A-Za-z0-9_-]{10,}\b/g, 'supabase-secret-key'],
  [/\bsbp_[A-Za-z0-9]{20,}\b/g, 'supabase-access-token'],
  [/\bre_[A-Za-z0-9]{8,}_[A-Za-z0-9]{8,}\b/g, 'resend-key'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, 'jwt'],
  [/\b(postgres(?:ql)?:\/\/[^:\s/]+:)[^@\s]+@/g, 'db-password'],
];

/** Replace every registered secret value and every known credential shape in `text`. */
export function redact(text: string): string {
  let out = text;
  // Longest first so a secret that contains another is scrubbed whole.
  const values = [...registry.keys()].sort((a, b) => b.length - a.length);
  for (const v of values) {
    if (out.includes(v)) out = out.split(v).join(`[redacted ${registry.get(v)} fp:${fingerprint(v)}]`);
  }
  for (const [re, label] of PATTERNS) {
    out = out.replace(re, (m, g1) => (label === 'db-password' && typeof g1 === 'string' ? `${g1}[redacted]@` : `[redacted ${label}]`));
  }
  return out;
}

// ── Serialising bodies that contain Secrets ─────────────────────────────────────────────────────
// JSON.stringify calls Secret.toJSON() BEFORE any replacer sees the value, so a naive stringify
// silently sends {secret, fp} instead of the value. Always go through these.

/** Deep copy with every Secret replaced by its raw value. Use only for request bodies / stdin. */
export function revealDeep(v: unknown): unknown {
  if (v instanceof Secret) return v.reveal();
  if (Array.isArray(v)) return v.map(revealDeep);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, revealDeep(x)]));
  return v;
}

function containsSecret(v: unknown): boolean {
  if (v instanceof Secret) return true;
  if (Array.isArray(v)) return v.some(containsSecret);
  if (v && typeof v === 'object') return Object.values(v).some(containsSecret);
  return false;
}

/** JSON for a child's stdin. Returned as a Secret when the body carries one, so it stays guarded. */
export function secretJson(name: string, body: unknown): string | Secret {
  const text = JSON.stringify(revealDeep(body));
  return containsSecret(body) ? new Secret(name, text) : text;
}

// ── Run vault ───────────────────────────────────────────────────────────────────────────────────
// In-memory only, for handing a secret from one step to a later step in the SAME process (e.g. the
// DB password generated when creating a project, needed later to assemble DATABASE_URL). Never
// persisted: if the run dies, the value is gone by design and the plan falls back to a safe path.

const vault = new Map<string, Secret>();
export function vaultPut(key: string, s: Secret): void {
  vault.set(key, s);
}
export function vaultGet(key: string): Secret | undefined {
  return vault.get(key);
}

/** Test helper: forget registered values between tests. */
export function _resetSecretRegistry(): void {
  registry.clear();
  vault.clear();
}
