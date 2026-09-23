import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import type { Adapter, AuthStatus, Ctx, EnvTarget, KeyIssuer, SendingDomain, TestSend } from '../core/types.js';
import { Secret, redact, vaultGet, vaultPut } from '../core/secret.js';
import { HttpError } from '../core/http.js';
import { tokenHowTo } from '../core/credentials.js';
import { normalizeRecords, type ResendRecord } from './resend-records.js';

/**
 * Resend (email). Two transports, picked per run:
 *   - the official `resend` CLI when the human is logged in (`resend login`, browser OAuth; nothing pasted)
 *   - REST with a full-access RESEND_API_KEY (environment or the golive credentials file)
 * Every REST call sends a User-Agent (Resend answers 403/1010 without one).
 */

const API = 'https://api.resend.com';
const UA = 'golive/0';
const TOKEN = 'RESEND_API_KEY';
/** Vault key for the most recently issued app sending key (used to prove it with a test send). */
const VAULT_KEY = 'resend.apiKey';
const REGIONS = new Set(['us-east-1', 'eu-west-1', 'sa-east-1', 'ap-northeast-1']);
/** The CLI prefers RESEND_API_KEY over the logged-in profile; blank it so the profile is used. */
const CLI_ENV = { RESEND_API_KEY: '' };

/** Preferred: the CLI's browser login (stored by the resend CLI, visible to the agent's shell). */
const CLI_LOGIN =
  "Preferred: run `resend login` (browser login; install with `npm i -g resend-cli`) in a separate terminal window (the Terminal app or your IDE's terminal; Claude Code's `!` prefix has no interactive terminal, so logins fail there).";

function loginHelp(): string {
  return `${CLI_LOGIN} Or create a Full access API key at https://resend.com/api-keys: ${tokenHowTo(TOKEN)} Then re-run golive.`;
}
function sendingOnlyHelp(): string {
  return (
    'RESEND_API_KEY is a sending-only key; golive needs a Full access key to create domains and keys. ' +
    `${CLI_LOGIN} Or create a Full access key at https://resend.com/api-keys and replace the sending-only one: ${tokenHowTo(TOKEN)}`
  );
}

// ── Resend shapes (only the fields we read) ─────────────────────────────────────────────────────

interface DomainSummary {
  id: string;
  name: string;
  status?: string;
  region?: string;
}
interface DomainFull extends DomainSummary {
  records?: ResendRecord[];
}
interface EmailMsg {
  from: string;
  to: string;
  subject: string;
  text: string;
}

interface Transport {
  via: string;
  listDomains(): Promise<DomainSummary[]>;
  createDomain(name: string, region: string): Promise<DomainSummary>;
  getDomain(id: string): Promise<DomainFull>;
  verifyDomain(id: string): Promise<void>;
  listKeys(): Promise<Array<{ id: string; name: string }>>;
  createKey(name: string, domainId: string): Promise<{ id: string; token: Secret }>;
  deleteKey(id: string): Promise<void>;
  sendEmail(msg: EmailMsg, idempotencyKey: string): Promise<{ id: string }>;
  getEmail(id: string): Promise<{ last_event?: string }>;
}

// ── REST transport ──────────────────────────────────────────────────────────────────────────────

interface ResendErrorBody {
  name?: string;
  message?: string;
  statusCode?: number;
}

function restError(what: string, status: number, body: unknown, text: string): HttpError {
  const b = (body && typeof body === 'object' ? body : {}) as ResendErrorBody;
  const code = b.name ?? '';
  const detail = b.message ?? text.slice(0, 300);
  return new HttpError(redact(`Resend ${what} failed (HTTP ${status}${code ? ` ${code}` : ''}): ${detail}${hintFor(code, status, detail)}`), status, redact(text));
}

function hintFor(code: string, status: number, detail: string): string {
  if (code === 'restricted_api_key') return ` — ${sendingOnlyHelp()}`;
  if (code === 'missing_api_key' || code === 'invalid_api_key' || status === 401) return ` — the Resend credential was rejected (revoked?). ${loginHelp()}`;
  if (/registered already/i.test(detail)) {
    return ' — another Resend team owns this domain. Claiming it needs a human-confirmed TXT record (https://resend.com/docs/knowledge-base/domain-already-registered); ask the human before proceeding.';
  }
  if (code === 'daily_quota_exceeded' || code === 'monthly_quota_exceeded') return ' — the Resend plan quota is used up; wait for the reset or upgrade the plan.';
  if (code === 'rate_limit_exceeded' || status === 429) return ' — Resend rate limit (10 req/s per team); retry in a few seconds.';
  if (code === 'invalid_permission' || code === 'insufficient_permissions') return ` — the credential lacks full access. ${sendingOnlyHelp()}`;
  return '';
}

function bearer(key: Secret): Secret {
  return new Secret(key.name, `Bearer ${key.reveal()}`);
}

async function call<T>(
  ctx: Ctx,
  key: Secret,
  what: string,
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  body?: unknown,
  extra: Record<string, string> = {},
  idempotent = false,
): Promise<T> {
  const res = await ctx.http<T>({
    method,
    url: `${API}${path}`,
    headers: { Authorization: bearer(key), 'User-Agent': UA, ...extra },
    body,
    ...(idempotent ? { idempotent: true } : {}),
  });
  if (res.status < 200 || res.status >= 300) throw restError(what, res.status, res.json, res.text);
  return res.json;
}

function restTransport(ctx: Ctx, key: Secret): Transport {
  return {
    via: `${TOKEN} env (full access)`,
    listDomains: async () => listOf<DomainSummary>(await call(ctx, key, 'list domains', 'GET', '/domains')),
    createDomain: async (name, region) =>
      call<DomainSummary>(ctx, key, `create domain ${name}`, 'POST', '/domains', { name, region, open_tracking: false, click_tracking: false }),
    getDomain: async (id) => call<DomainFull>(ctx, key, `get domain ${id}`, 'GET', `/domains/${encodeURIComponent(id)}`),
    verifyDomain: async (id) => {
      // Re-triggering the async DNS check is harmless, so this POST may be retried after a 5xx/timeout.
      await call(ctx, key, `verify domain ${id}`, 'POST', `/domains/${encodeURIComponent(id)}/verify`, undefined, {}, true);
    },
    listKeys: async () => listOf<{ id: string; name: string }>(await call(ctx, key, 'list API keys', 'GET', '/api-keys')),
    createKey: async (name, domainId) => {
      const r = await call<{ id?: string; token?: string }>(ctx, key, `create API key ${name}`, 'POST', '/api-keys', { name, permission: 'sending_access', domain_id: domainId });
      return keyFrom(r, name);
    },
    deleteKey: async (id) => {
      await call(ctx, key, `delete API key ${id}`, 'DELETE', `/api-keys/${encodeURIComponent(id)}`);
    },
    sendEmail: async (msg, idem) => sendRest(ctx, key, msg, idem),
    getEmail: async (id) => call<{ last_event?: string }>(ctx, key, `get email ${id}`, 'GET', `/emails/${encodeURIComponent(id)}`),
  };
}

async function sendRest(ctx: Ctx, key: Secret, msg: EmailMsg, idem: string): Promise<{ id: string }> {
  const r = await call<{ id?: string }>(ctx, key, 'send test email', 'POST', '/emails', { from: msg.from, to: [msg.to], subject: msg.subject, text: msg.text }, { 'Idempotency-Key': idem });
  if (!r?.id) throw new Error('Resend send test email: response had no email id');
  return { id: r.id };
}

// ── CLI transport ───────────────────────────────────────────────────────────────────────────────

interface CliError {
  error?: { message?: string; code?: string };
}

/** Run `resend … --json` with stdout captured in-process. Error messages never echo stdout. */
async function cli<T>(ctx: Ctx, args: string[]): Promise<T> {
  const what = `resend ${args.slice(0, 2).join(' ')}`;
  let r;
  try {
    r = await ctx.exec('resend', [...args, '--json'], { env: CLI_ENV, timeoutMs: 60_000 });
  } catch (e) {
    throw new Error(redact(`${what} could not run: ${e instanceof Error ? e.message : String(e)}`));
  }
  let parsed: unknown;
  try {
    parsed = r.stdout.trim() ? JSON.parse(r.stdout) : undefined;
  } catch {
    parsed = undefined;
  }
  if (r.code !== 0) {
    const err = (parsed as CliError | undefined)?.error;
    const code = err?.code ?? '';
    const detail = err?.message ?? (r.stderr.trim().slice(0, 300) || 'no error output');
    const hint = code === 'not_authenticated' ? ` — ${loginHelp()}` : hintFor(code, 0, detail);
    throw new Error(redact(`${what} failed (exit ${r.code}${code ? `, ${code}` : ''}): ${detail}${hint}`));
  }
  if (parsed === undefined) throw new Error(`${what}: expected JSON output (is resend-cli >= 2.21 installed?)`);
  return unwrap(parsed) as T;
}

function cliTransport(ctx: Ctx, profile: string | undefined): Transport {
  return {
    via: `resend CLI (logged in${profile ? `, profile ${profile}` : ''})`,
    listDomains: async () => listOf<DomainSummary>(await cli(ctx, ['domains', 'list'])),
    createDomain: async (name, region) => cli<DomainSummary>(ctx, ['domains', 'create', '--name', name, '--region', region]),
    getDomain: async (id) => cli<DomainFull>(ctx, ['domains', 'get', id]),
    verifyDomain: async (id) => {
      await cli(ctx, ['domains', 'verify', id]);
    },
    listKeys: async () => listOf<{ id: string; name: string }>(await cli(ctx, ['api-keys', 'list'])),
    createKey: async (name, domainId) =>
      keyFrom(await cli<{ id?: string; token?: string }>(ctx, ['api-keys', 'create', '--name', name, '--permission', 'sending_access', '--domain-id', domainId]), name),
    deleteKey: async (id) => {
      await cli(ctx, ['api-keys', 'delete', id, '--yes']);
    },
    sendEmail: async (msg, idem) => {
      const r = await cli<{ id?: string }>(ctx, ['emails', 'send', '--from', msg.from, '--to', msg.to, '--subject', msg.subject, '--text', msg.text, '--idempotency-key', idem]);
      if (!r?.id) throw new Error('resend emails send: output had no email id');
      return { id: r.id };
    },
    getEmail: async (id) => cli<{ last_event?: string }>(ctx, ['emails', 'get', id]),
  };
}

// ── shared helpers ──────────────────────────────────────────────────────────────────────────────

/** CLI output may be the SDK's `data` payload or wrap it; accept both. */
function unwrap(v: unknown): unknown {
  if (v && typeof v === 'object' && !Array.isArray(v) && !('id' in v) && 'data' in v && !('object' in v && (v as { object?: string }).object === 'list')) {
    return (v as { data: unknown }).data;
  }
  return v;
}

function listOf<T>(v: unknown): T[] {
  if (Array.isArray(v)) return v as T[];
  const d = (v as { data?: unknown } | undefined)?.data;
  if (Array.isArray(d)) return d as T[];
  const dd = (d as { data?: unknown } | undefined)?.data;
  return Array.isArray(dd) ? (dd as T[]) : [];
}

/** Wrap the one-time token the instant we see it; never let the raw response escape. */
function keyFrom(r: { id?: string; token?: string } | undefined, name: string): { id: string; token: Secret } {
  const token = r?.token;
  const id = r?.id;
  if (!token || !id) throw new Error(`Resend create API key ${name}: response had no id/token (nothing was printed); check https://resend.com/api-keys and delete any half-created key named ${name}`);
  return { id, token: new Secret(TOKEN, token) };
}

const sameName = (a: string, b: string): boolean => a.trim().replace(/\.$/, '').toLowerCase() === b.trim().replace(/\.$/, '').toLowerCase();

// ── transport selection + auth ──────────────────────────────────────────────────────────────────

type Pick = { ok: true; t: Transport } | { ok: false; howToFix: string };

async function cliLogin(ctx: Ctx): Promise<{ ok: boolean; profile?: string; sendingOnly?: boolean }> {
  try {
    const r = await ctx.exec('resend', ['whoami', '--json'], { env: CLI_ENV, timeoutMs: 15_000 });
    if (r.code !== 0) return { ok: false };
    const w = JSON.parse(r.stdout) as { authenticated?: boolean; profile?: string; permission?: string };
    if (w.authenticated !== true) return { ok: false };
    if (w.permission === 'sending_access') return { ok: false, sendingOnly: true };
    return { ok: true, profile: typeof w.profile === 'string' ? w.profile : undefined };
  } catch {
    return { ok: false }; // not installed, or unparseable output
  }
}

async function pick(ctx: Ctx): Promise<Pick> {
  const c = await cliLogin(ctx);
  if (c.ok) return { ok: true, t: cliTransport(ctx, c.profile) };
  const key = ctx.envToken(TOKEN);
  if (key) return { ok: true, t: restTransport(ctx, key) };
  const extra = c.sendingOnly ? 'Your `resend` CLI profile uses a sending-only key. ' : '';
  return { ok: false, howToFix: extra + loginHelp() };
}

async function transport(ctx: Ctx): Promise<Transport> {
  const p = await pick(ctx);
  if (!p.ok) throw new Error(`Resend is not authenticated. ${p.howToFix}`);
  return p.t;
}

async function auth(ctx: Ctx): Promise<AuthStatus> {
  const p = await pick(ctx);
  if (!p.ok) return { ok: false, howToFix: p.howToFix };
  if (p.t.via.startsWith('resend CLI')) return { ok: true, via: p.t.via };
  // Token path: GET /domains proves the key is valid AND full access.
  try {
    await p.t.listDomains();
    return { ok: true, via: p.t.via };
  } catch (e) {
    if (e instanceof HttpError && e.status === 0) return { ok: false, howToFix: `Could not reach api.resend.com (${e.message}); check your network and re-run.` };
    if (e instanceof HttpError && /restricted_api_key/.test(e.message)) return { ok: false, howToFix: sendingOnlyHelp() };
    if (e instanceof HttpError && (e.status === 401 || e.status === 403)) {
      return { ok: false, howToFix: `RESEND_API_KEY was rejected by Resend (HTTP ${e.status}); it may be revoked or mistyped. ${loginHelp()}` };
    }
    return { ok: false, howToFix: redact(e instanceof Error ? e.message : String(e)) };
  }
}

// ── capabilities ────────────────────────────────────────────────────────────────────────────────

function regionFor(ctx: Ctx): string {
  const r = (ctx.config.email as { region?: unknown } | undefined)?.region;
  return typeof r === 'string' && REGIONS.has(r) ? r : 'us-east-1';
}

export function mapDomainStatus(status: string | undefined, warn?: (m: string) => void): 'verified' | 'pending' | 'failed' | 'not_started' {
  switch (status) {
    case 'verified':
      return 'verified';
    case 'partially_verified':
      warn?.('Resend domain is partially verified: it can send, but one SPF record is not resolving yet (no fallback server).');
      return 'verified';
    case 'not_started':
      return 'not_started';
    case 'failed':
    case 'temporary_failure':
    case 'partially_failed':
      return 'failed';
    default:
      return 'pending';
  }
}

const sendingDomain: SendingDomain = {
  async ensure(ctx, domain) {
    const t = await transport(ctx);
    const existing = (await t.listDomains()).find((d) => sameName(d.name, domain));
    let id: string;
    if (existing) {
      id = existing.id;
      ctx.log.info(`adopting existing Resend domain ${existing.name} (${id}, ${existing.status ?? 'unknown status'})`);
    } else {
      const region = regionFor(ctx);
      const created = await t.createDomain(domain, region);
      if (!created?.id) throw new Error(`Resend create domain ${domain}: response had no domain id`);
      id = created.id;
      ctx.log.info(`created Resend domain ${domain} (${id}, region ${region})`);
    }
    // The list endpoint omits records; always re-read the full domain.
    const full = await t.getDomain(id);
    const records = normalizeRecords(full.name ?? domain, full.records, (m) => ctx.log.warn(m));
    if (records.length === 0) ctx.log.warn(`Resend returned no DNS records for ${domain}; check https://resend.com/domains`);
    return { id, records };
  },

  async status(ctx, id) {
    const t = await transport(ctx);
    const d = await t.getDomain(id);
    return mapDomainStatus(d.status, (m) => ctx.log.warn(m));
  },

  /** Read-only (GET /domains/{id}): the records the domain needs, normalised like ensure() returns them. */
  async records(ctx, id) {
    const t = await transport(ctx);
    const d = await t.getDomain(id);
    if (!d?.name) throw new Error(`Resend get domain ${id}: response had no domain name; check https://resend.com/domains`);
    return normalizeRecords(d.name, d.records, (m) => ctx.log.warn(m));
  },

  async verify(ctx, id) {
    const t = await transport(ctx);
    const d = await t.getDomain(id);
    // POST /verify resets even a verified domain to pending, so only call it when needed.
    if (mapDomainStatus(d.status) === 'verified') {
      ctx.log.info(`Resend domain ${d.name ?? id} is already ${d.status}; not re-verifying`);
      return;
    }
    await t.verifyDomain(id);
    ctx.log.info(`asked Resend to verify ${d.name ?? id} (DNS checks run asynchronously; may take minutes)`);
  },
};

export function appSlug(ctx: Ctx): string {
  const raw = basename(ctx.detect.root || ctx.cwd) || 'app';
  return raw.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'app';
}

export function keyName(ctx: Ctx, target: EnvTarget): string {
  const suffix = `-${target}`;
  const room = 50 - 'golive-'.length - suffix.length;
  const app = appSlug(ctx).slice(0, room).replace(/-$/, '') || 'app';
  return `golive-${app}${suffix}`;
}

const keys: KeyIssuer = {
  async issue(ctx, target, scope) {
    const domain = scope.domain ?? ctx.config.email?.domain ?? ctx.config.domain;
    if (!domain) throw new Error('Resend key issue: no sending domain given; set email.domain (or domain) in golive.yaml');
    const t = await transport(ctx);
    const d = (await t.listDomains()).find((x) => sameName(x.name, domain));
    if (!d) throw new Error(`Resend has no domain ${domain} yet; run the sending-domain step first, then issue the key`);
    const name = keyName(ctx, target);
    // Tokens can't be re-read, so "adopt" means rotate: mint a new key, leave old ones for an explicit revoke.
    const older = await t.listKeys().catch(() => []);
    const same = older.filter((k) => k.name === name).map((k) => k.id);
    const k = await t.createKey(name, d.id);
    vaultPut(VAULT_KEY, k.token);
    ctx.log.info(`issued Resend sending key ${name} (${k.id}, domain ${d.name}, fp:${k.token.fingerprint})`);
    if (same.length) ctx.log.info(`older Resend keys named ${name} still exist (${same.join(', ')}); revoke them once the new key is live`);
    return { key: 'resend.apiKey', id: k.id, secret: k.token };
  },
  async revoke(ctx, id) {
    const t = await transport(ctx);
    await t.deleteKey(id);
    ctx.log.info(`revoked Resend API key ${id}`);
  },
};

function idempotencyKey(msg: EmailMsg, keyFp: string): string {
  const h = createHash('sha256').update(JSON.stringify([msg.from, msg.to, msg.subject, msg.text, keyFp])).digest('hex').slice(0, 24);
  return `golive-smoke-${h}`;
}

const testSend: TestSend = {
  async send(ctx, msg) {
    // An explicit credential (e.g. the app's key read back for this check) wins; then the key issued
    // this run. A successful send with it proves key + domain scope together.
    const appKey = msg.key ?? vaultGet(VAULT_KEY);
    if (appKey) return sendRest(ctx, appKey, msg, idempotencyKey(msg, appKey.fingerprint));
    const t = await transport(ctx);
    return t.sendEmail(msg, idempotencyKey(msg, t.via));
  },
  async status(ctx, id) {
    // GET /emails/{id} needs full access; a sending key gets 401 restricted_api_key.
    const t = await transport(ctx);
    const e = await t.getEmail(id);
    return e?.last_event ?? 'unknown';
  },
};

export const resendAdapter: Adapter = {
  id: 'resend',
  title: 'Resend',
  axes: ['email'],
  automated: true,
  detect: (d) => (d.providers.email ?? []).includes('resend') || d.envRefs.some((r) => r.name === TOKEN),
  auth,
  capabilities: { sendingDomain, keys, testSend },
};
