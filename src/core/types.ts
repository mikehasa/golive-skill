/**
 * The contract every part of golive is written against.
 *
 * Mental model:
 *   - An ADAPTER speaks to one provider and exposes CAPABILITIES (EnvStore, WebhookRegistry, …).
 *   - A LINK is cross-provider glue written ONCE against capabilities (e.g. "payments webhook → host
 *     env + host URL"), so adding a provider never means writing N pairwise recipes.
 *   - The PLAN is a list of STEPS (pure data + a run function). Nothing writes until the human has
 *     approved the plan (by id) and passed the risk flags the steps require.
 *   - CHECKS prove that what a step claims actually holds, against live systems.
 */
import type { Secret } from './secret.js';

// ── Basics ──────────────────────────────────────────────────────────────────────────────────────

export type Axis = 'hosting' | 'db' | 'auth' | 'payments' | 'email' | 'dns' | 'monitoring';
export const AXES: readonly Axis[] = ['hosting', 'db', 'auth', 'payments', 'email', 'dns', 'monitoring'];

/** Deployment environments, named like Vercel's targets (the most common vocabulary). */
export type EnvTarget = 'development' | 'preview' | 'production';

/** Stripe-style mode for providers that separate test and live data. */
export type Mode = 'test' | 'live';

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';

/** A value that is safe to print (URLs, public keys, IDs) or a Secret that is not. */
export type Value = string | Secret;

export interface DnsRecord {
  type: 'A' | 'AAAA' | 'CNAME' | 'TXT' | 'MX' | 'CAA';
  /** Fully qualified name, no trailing dot (e.g. "send.example.com", "example.com"). */
  name: string;
  content: string;
  ttl?: number;
  priority?: number;
  /** Cloudflare-style proxying. Records pointing at another host or used for mail must be false. */
  proxied?: boolean;
}

// ── Runtime context ─────────────────────────────────────────────────────────────────────────────

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}
export interface ExecOptions {
  cwd?: string;
  /** Written to the child's stdin, then closed. The ONLY way secrets reach a child process. */
  stdin?: string | Secret;
  env?: Record<string, string>;
  timeoutMs?: number;
}
export type Exec = (cmd: string, args: string[], opts?: ExecOptions) => Promise<ExecResult>;

export interface HttpRequest {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  url: string;
  headers?: Record<string, string | Secret>;
  /** JSON-serialised if an object; Secrets inside are revealed only at send time. */
  body?: unknown;
  /** application/x-www-form-urlencoded body (Stripe). Values may be Secrets. */
  form?: Record<string, string | number | boolean | Secret | undefined>;
  timeoutMs?: number;
  /**
   * Safe to re-send after a 5xx/timeout (the server may already have acted). GET/HEAD/PUT/DELETE are
   * idempotent by default; POST/PATCH are re-sent only with this flag or an Idempotency-Key header.
   */
  idempotent?: boolean;
}
export interface HttpResponse<T = unknown> {
  status: number;
  headers: Record<string, string>;
  json: T;
  text: string;
}
export type Http = <T = unknown>(req: HttpRequest) => Promise<HttpResponse<T>>;

export interface Logger {
  /** Progress lines for humans (stderr). Always redacted. */
  info(msg: string): void;
  warn(msg: string): void;
}

export interface Ctx {
  cwd: string;
  /** Verified instructions + runtime identity. Tests inject an explicit fixture identity. */
  release: ReleaseIdentity;
  exec: Exec;
  http: Http;
  log: Logger;
  config: ShipConfig;
  state: StateStore;
  detect: DetectResult;
  /** Reads a token from the environment (never from disk). */
  envToken(name: string): Secret | undefined;
  /** Registered adapters (injected so tests can substitute fakes). */
  adapters: Adapter[];
  /** Non-secret environment config (e.g. VERCEL_ORG_ID, CLOUDFLARE_ACCOUNT_ID). */
  env(name: string): string | undefined;
  /** Per-run memo shared by a Ctx and every StepContext derived from it. */
  cache: Map<string, unknown>;
}

// ── Adapter + capabilities ──────────────────────────────────────────────────────────────────────

export interface AuthStatus {
  ok: boolean;
  /** e.g. "vercel CLI (logged in as alice, team acme)" or "VERCEL_TOKEN env". Never the token. */
  via?: string;
  /** What the human must do if !ok, e.g. "run `vercel login` in your terminal". */
  howToFix?: string;
}

export interface Adapter {
  id: string; // 'vercel' | 'supabase' | …
  title: string;
  axes: Axis[];
  /** true if golive can wire it automatically; false = guided (instructions + observation). */
  automated: boolean;
  /** Is this provider already in use in the repo? Cheap, offline. */
  detect?(d: DetectResult): boolean;
  auth(ctx: Ctx): Promise<AuthStatus>;
  capabilities: Partial<Capabilities>;
}

export interface Capabilities {
  project: ProjectLinker;
  env: EnvStore;
  url: PublicUrl;
  deploy: Deployer;
  domain: DomainAttach;
  dns: DnsZone;
  outputs: OutputsProvider;
  dbAdmin: DbAdmin;
  dbConnection: DbConnection;
  authConfig: AuthConfig;
  webhooks: WebhookRegistry;
  paymentAccount: PaymentAccount;
  sendingDomain: SendingDomain;
  testSend: TestSend;
  keys: KeyIssuer;
  authUsers?: AuthUsers;
}

/** Secret-free payment destination and operator credential identity, bound into approvals. */
export interface PaymentAccountIdentity {
  accountId: string;
  mode: Mode;
  operatorFingerprint: string;
}

export interface PaymentAccount {
  identify(ctx: Ctx, mode: Mode): Promise<PaymentAccountIdentity>;
  /** Re-read the exact account, reject drift, then pin credentials for this step's requests. */
  bind<T extends Ctx>(ctx: T, approved: PaymentAccountIdentity, options?: { appKey?: boolean }): Promise<T>;
}

/**
 * Which project/resource at the provider this app uses (a Vercel project, a Supabase project, …).
 * Adopting an existing one is preferred over creating; the choice is part of the approved plan.
 */
export interface ProjectRef {
  id: string;
  name: string;
  /** The provider account/team/organization that owns this project. Never credentials. */
  scope?: ProjectScope;
}
export interface ProjectScope {
  kind: 'account' | 'team' | 'organization';
  id: string;
  name?: string;
}
export interface ProjectCreateTarget {
  scope: ProjectScope;
  /** Provider region selection, when creating a resource requires one. */
  region?: string;
}
export interface ProjectDestination {
  axis: Axis;
  provider: string;
  providerTitle: string;
  action: 'pin' | 'select' | 'create';
  project: { id?: string; name: string };
  scope?: ProjectScope;
  region?: string;
  /** Auth mechanism/identity description, not the resource's destination scope. */
  access?: string;
}
export interface ProjectLinker {
  /** The project this repo is already linked to (local link files, golive state, or config). */
  current(ctx: Ctx): Promise<ProjectRef | null>;
  /** Existing projects the human could adopt (for the plan / handoff to present). */
  candidates(ctx: Ctx): Promise<ProjectRef[]>;
  /** Read-only resolution of an exact existing project and its owning scope. */
  resolve?(ctx: Ctx, idOrName: string): Promise<ProjectRef>;
  /**
   * Read-only: is this exact project still at the provider? Used to confirm a deletion golive
   * performed. `false` only when the provider itself answers "not found"; a read that cannot be
   * answered (auth, network, rate limit) throws, so a failed read never counts as a project gone.
   */
  exists?(ctx: Ctx, id: string): Promise<boolean>;
  /** Resolve the exact free destination before asking the human to approve creation. */
  creationTarget?(ctx: Ctx): Promise<ProjectCreateTarget>;
  /** Adopt an existing project by id or name (writes local link/state only). */
  select(ctx: Ctx, idOrName: string): Promise<ProjectRef>;
  /**
   * Create a new project. Omit if creation can cost money or needs choices only a human can make;
   * the link then emits a handoff instead.
   */
  create?(ctx: Ctx, name: string, approvedTarget?: ProjectCreateTarget): Promise<ProjectRef>;
  /**
   * Delete the currently linked project — ONLY one golive itself created (a creation marker in
   * state must match the current project). Adopted/selected projects return removed:false with a
   * reason. Only teardown steps call this.
   */
  remove?(ctx: Ctx): Promise<{ removed: boolean; reason?: string }>;
}

export interface EnvStore {
  /** Names only (never values) per target. */
  listNames(ctx: Ctx, target: EnvTarget): Promise<string[]>;
  /**
   * Create-or-update `name` for the given targets. Secret values must be delivered via request body
   * or child stdin, never argv. Idempotent.
   */
  set(ctx: Ctx, name: string, value: Value, targets: EnvTarget[], opts?: { sensitive?: boolean }): Promise<void>;
  /**
   * Preflight: why a set() of `name` for `targets` would fail (e.g. integration-owned, hidden from this
   * token, overlapping targets), or null if it should succeed. Lets links refuse BEFORE creating
   * something whose secret can only be captured once (a webhook endpoint).
   */
  canSet?(ctx: Ctx, name: string, targets: EnvTarget[]): Promise<string | null>;
}

export interface PublicUrl {
  /**
   * Canonical public base URL for the target (production domain or project URL). No trailing slash.
   * For `preview` the contract is narrower: the URL of the preview deployment the provider itself
   * confirms for the LINKED project — ready, belonging to that project, and not its published
   * production deployment — or null when the provider reports no such deployment (a per-deployment URL
   * it does not re-read, a protected preview, or none). The `preview-deploy` check reads it as exactly
   * that confirmation, so a provider that cannot report one must answer null rather than a guess.
   */
  get(ctx: Ctx, target: EnvTarget): Promise<string | null>;
  /** Glob-style patterns preview deployments are served from (for auth redirect allowlists). */
  previewPatterns?(ctx: Ctx): Promise<string[]>;
}

export interface Deployer {
  /**
   * Deploy `target` and report the deployment the provider actually made: its public `url` plus,
   * when the provider reports one, its OWN deployment identity (`id`) — the name a promotion or
   * rollback of exactly this deployment would use. It comes from the provider (its deploy output or
   * the API), never derived from the URL; a provider that cannot report one leaves it unset rather
   * than inventing one.
   */
  deploy(ctx: Ctx, target: Exclude<EnvTarget, 'development'>): Promise<{ url: string; id?: string }>;
}

export interface DomainAttach {
  /** Attach `domain` to the project (idempotent). */
  add(ctx: Ctx, domain: string): Promise<void>;
  /** Records the DNS provider must serve for the domain to work. */
  requiredRecords(ctx: Ctx, domain: string): Promise<DnsRecord[]>;
  status(ctx: Ctx, domain: string): Promise<'ok' | 'pending' | 'misconfigured'>;
  /** Ask the provider to (re)check ownership, e.g. after TXT records were added. Never re-verifies a verified domain. */
  verify?(ctx: Ctx, domain: string): Promise<'verified' | 'pending'>;
}

export interface DnsZone {
  /** Does this provider host DNS for `domain`? (e.g. zone exists in the account) */
  hosts(ctx: Ctx, domain: string): Promise<boolean>;
  list(ctx: Ctx, domain: string): Promise<DnsRecord[]>;
  /** Create or update to match `record`. Must never silently delete an unrelated record. */
  upsert(ctx: Ctx, domain: string, record: DnsRecord): Promise<'created' | 'updated' | 'unchanged'>;
  /** Records golive provably owns (provider-side marker or tracked fingerprint) — teardown candidates. */
  listOwned?(ctx: Ctx, domain: string): Promise<DnsRecord[]>;
  /**
   * Delete the owned record matching `record` exactly (type/name/content). Refuses an unowned or
   * ambiguous match; 'unchanged' when it is already gone. Only teardown steps call this.
   */
  remove?(ctx: Ctx, domain: string, record: DnsRecord): Promise<'removed' | 'unchanged'>;
}

/**
 * Semantic outputs a provider produces for the app (connection URLs, keys). Keys are semantic
 * (`supabase.url`, `stripe.secretKey`), mapped to the app's actual env var names by envmap.ts.
 */
export type Outputs = Partial<Record<OutputKey, Value>>;
export type OutputKey =
  | 'supabase.url'
  | 'supabase.publishableKey'
  | 'supabase.secretKey'
  | 'db.url'
  | 'db.directUrl'
  | 'stripe.secretKey'
  | 'stripe.publishableKey'
  | 'stripe.webhookSecret'
  | 'resend.apiKey'
  | 'app.url';

export interface OutputsProvider {
  /** Restrict work to requested keys when supplied; unrelated outputs must not cause writes. */
  outputs(ctx: Ctx, target: EnvTarget, requestedKeys?: readonly OutputKey[]): Promise<Outputs>;
  /** Which keys outputs() can supply, WITHOUT fetching values (lets plan() stay secret-free). */
  provides?(ctx: Ctx, target: EnvTarget, requestedKeys?: readonly OutputKey[]): Promise<OutputKey[]>;
  /** Non-secret source selectors (branch/database/role), visible in approvals and env identity. No value fetching. */
  identity?(ctx: Ctx): Promise<string>;
}

/** A fixed, read-only connectivity probe; never migrations, arbitrary SQL, or app authorization proof. */
export interface DbConnection {
  probe(ctx: Ctx): Promise<{ database: string; role: string }>;
}

export interface TableInfo {
  schema: string;
  name: string;
  rls: boolean;
  policies: Array<{ name: string; command: string; permissive: boolean; roles: string[]; using?: string; check?: string }>;
}

export interface DbAdmin {
  tables(ctx: Ctx): Promise<TableInfo[]>;
  advisors?(ctx: Ctx): Promise<Finding[]>;
}

/**
 * Non-secret auth settings and policy as the provider reports them. Everything except the two URL
 * fields is optional: providers report different subsets, and a field the provider does not report
 * must never be assumed. NO SECRET may appear here — an SMTP password is readable only by the
 * provider (Supabase answers `smtp_pass` with a hash, never the value), so it stays a write-only part
 * of AuthWrite. A provider reports some fields in the negative (`disable_signup`,
 * `mailer_autoconfirm`); the adapter flips them to the positive wording used here.
 */
export interface AuthSettings {
  siteUrl: string | null;
  redirectUrls: string[];
  /** New users may sign up. */
  signupEnabled?: boolean;
  /** A new account must confirm its email before it can sign in. */
  emailConfirmRequired?: boolean;
  minPasswordLength?: number;
  /** The provider's own SMTP mailer for auth emails; `configured: false` = its built-in mailer. */
  smtp?: AuthSmtp;
  /** Access-token lifetime in seconds. */
  jwtExpirySeconds?: number;
  /** Lifetime of an emailed one-time code or link (signup, magic link, recovery), in seconds. */
  otpExpirySeconds?: number;
  otpLength?: number;
  /** Auth emails the provider itself will send per hour (its built-in mailer rate limit). */
  emailRateLimitPerHour?: number;
}

/** Custom SMTP as the provider reports it. Never the password: the provider does not return it. */
export interface AuthSmtp {
  configured: boolean;
  host?: string;
  senderEmail?: string;
  senderName?: string;
}

/**
 * What `set` may write: the policy fields above plus the one write-only secret. `smtpPassword` goes
 * into the request body and is never read back, so an SMTP write is confirmed through its non-secret
 * companions (host, sender) — never by comparing the password. It must never reach state, reports,
 * previews or errors, the same as every other credential.
 */
export type AuthWrite = Partial<AuthSettings> & { smtpPassword?: Secret };

/**
 * What a `set` achieved, from re-reading the provider's own settings afterwards. Entries are golive's
 * field names and reasons, never values: a setting the provider does not report back shows up in
 * `skipped` instead of being reported as applied.
 */
export interface AuthWriteOutcome {
  /** The provider's settings, re-read after the write. Absent when nothing was requested. */
  after?: AuthSettings;
  /** Requested fields the provider reported back with the requested value. */
  applied: string[];
  /** Requested fields golive could not confirm, each with the reason. */
  skipped: string[];
}

export interface AuthConfig {
  get(ctx: Ctx): Promise<AuthSettings>;
  /** Write the patch, then re-read the provider's settings before reporting what applied. */
  set(ctx: Ctx, patch: AuthWrite): Promise<AuthWriteOutcome>;
}

// ── Auth users (the signup → confirmation → login journey) ──────────────────────────────────────

/**
 * What one signup did, as the provider answers it. `confirmationSent` is the claim the `auth-signup`
 * check turns into evidence: a project with confirmation off answers with a session instead, and an
 * address that already has an account answers 2xx without sending anything.
 */
export interface AuthSignupOutcome {
  status: number;
  /** The new user's id, when the provider returns one (it returns a session instead when no confirmation is needed). */
  userId?: string;
  /** An email for a NEW account was sent (or queued by the provider). */
  confirmationSent: boolean;
  /** The address already had an account, so nothing was sent. */
  existing: boolean;
  /** The provider's mailer or request limit refused this request (HTTP 429). */
  rateLimited: boolean;
  /** The project wants a human challenge (captcha) that a scripted signup cannot pass. */
  captchaRequired: boolean;
  /** Secret-free provider error code on a refusal (e.g. `signup_disabled`). */
  code?: string;
}

/**
 * What one recovery request did, as the provider answers it. GoTrue answers a request for an address
 * it has no account for exactly like one it has (that is how it refuses to enumerate accounts), so
 * `accepted` and `emailSent` carry the same 2xx answer for both; the `auth-recovery` check compares
 * the two answers instead of trusting a flag to reveal the difference.
 */
export interface AuthRecoveryOutcome {
  status: number;
  /** The provider took the request (2xx) instead of refusing it. */
  accepted: boolean;
  /** The provider queued a recovery email. False when it answered 2xx without sending anything. */
  emailSent: boolean;
  /** The provider's mailer or request limit refused this request (HTTP 429). */
  rateLimited: boolean;
  /** The project wants a human challenge (captcha) that a scripted request cannot pass. */
  captchaRequired: boolean;
  /** Secret-free provider error code on a refusal (e.g. `email_address_invalid`). */
  code?: string;
}

/** An admin-minted recovery token for one account. The token is a Secret: it is a credential. */
export interface AuthRecoveryLink {
  userId: string;
  /** The one-time token the verify endpoint exchanges for a session. */
  token: Secret;
}

/** A signed-in session. The token is a Secret: it is only ever sent as a header, never printed. */
export interface AuthSession {
  accessToken: Secret;
  userId: string;
  /** The provider has `email_confirmed_at` for this user. */
  emailConfirmed: boolean;
}

export interface AuthLoginOutcome {
  status: number;
  /** Present when the password grant succeeded. */
  session?: AuthSession;
  /** The provider refused: its error code (`email_not_confirmed`, `invalid_credentials`, …). */
  code?: string;
  /** The provider rate-limited the request (HTTP 429). */
  rateLimited: boolean;
}

/** One user as the provider's own API reports it. Never a token, never a password. */
export interface AuthUserView {
  status: number;
  id?: string;
  email?: string;
  /** `email_confirmed_at` (or `confirmed_at`) is set. */
  emailConfirmed?: boolean;
}

/**
 * The user surface of the chosen auth provider, used to prove a real signup → confirmation email →
 * login journey and the password recovery that follows it. `signup`, `setPassword`, `requestRecovery`,
 * `recoverySession` and `updateOwnPassword` are WRITES, so only an approved step calls them; the
 * read-only calls back `auth-signup`, `auth-session` and `auth-recovery`. Refusals come back as
 * outcomes (`status`, `code`) so a check can tell "the provider said no" from a broken transport; a
 * missing credential or unlinked project throws, because an unusable prerequisite is something a
 * caller skips on.
 */
export interface AuthUsers {
  /** Create one user through the provider's signup endpoint (a WRITE). */
  signup(ctx: Ctx, email: string, password: Secret): Promise<AuthSignupOutcome>;
  /** Password grant (`POST /auth/v1/token?grant_type=password`). */
  login(ctx: Ctx, email: string, password: Secret): Promise<AuthLoginOutcome>;
  /** The user behind a session token; without one, the anonymous answer (401) the app would get. */
  user(ctx: Ctx, token?: Secret): Promise<AuthUserView>;
  /** Admin read of one user by id. null = the provider no longer has it. */
  adminUser(ctx: Ctx, id: string): Promise<AuthUserView | null>;
  /** Replace a seeded user's password (admin API; a WRITE, used to re-prove login in a later run). */
  setPassword(ctx: Ctx, id: string, password: Secret): Promise<void>;
  /**
   * Ask the provider to send a recovery link or code to `email` (a WRITE). Idempotent in effect — it
   * mails a link and changes nothing a later request cannot re-derive — and the `auth:recovery` step
   * re-reads the recorded account before calling it, so a failed attempt from an older release may
   * run again.
   */
  requestRecovery(ctx: Ctx, email: string): Promise<AuthRecoveryOutcome>;
  /**
   * An admin-minted recovery token for `email`, for providers that can mint one; null = no account for
   * that address. This is what lets a run prove the recovery flow without reading an inbox, and only
   * an approved step or an opted-in check may ask for it: the token is a credential.
   */
  recoveryLink?(ctx: Ctx, email: string): Promise<AuthRecoveryLink | null>;
  /** Exchange a recovery token for a session (`type=recovery`); a token already used is refused. */
  recoverySession(ctx: Ctx, token: Secret): Promise<AuthLoginOutcome>;
  /** Set the signed-in user's OWN password: `PUT /auth/v1/user` carrying that session token (a WRITE). */
  updateOwnPassword(ctx: Ctx, session: Secret, password: Secret): Promise<void>;
  /** Non-secret destination of the auth project, or null when none is selected. */
  destination(ctx: Ctx): Promise<{ ref: string; url: string } | null>;
}

export interface WebhookEnsureResult {
  id: string;
  created: boolean;
  /** Only present when the endpoint was just created (Stripe reveals the signing secret once). */
  secret?: Secret;
}
export interface WebhookRegistry {
  ensure(ctx: Ctx, spec: { url: string; events: string[]; mode: Mode; apiVersion?: string }): Promise<WebhookEnsureResult>;
  /** Existing endpoints for this app (matched by tag/url). `owned` = created/tagged by golive. */
  list(ctx: Ctx, mode: Mode): Promise<Array<{ id: string; url: string; events: string[]; enabled: boolean; owned?: boolean }>>;
  /**
   * Replace an endpoint whose signing secret we no longer have (Stripe reveals it only on create):
   * create a new one with the same url/events, return its secret, then delete the old one.
   */
  replace?(ctx: Ctx, id: string, mode: Mode, opts?: { deleteOld?: boolean }): Promise<WebhookEnsureResult & { oldDeleted: boolean; oldLeft?: string }>;
  /**
   * Delete an endpoint, but only one golive created/owns. Links call this AFTER the replacement's secret
   * is safely stored on the host, so a failed env write never leaves the app without a working webhook.
   */
  remove?(ctx: Ctx, id: string, mode: Mode): Promise<{ deleted: boolean; reason?: string }>;
  /** Read-only: the endpoint ensure() WOULD adopt for this url (same matching rule), or null. */
  find?(ctx: Ctx, url: string, mode: Mode): Promise<{ id: string; url: string; events: string[]; enabled: boolean; owned: boolean } | null>;
}

export interface SendingDomain {
  ensure(ctx: Ctx, domain: string): Promise<{ id: string; records: DnsRecord[] }>;
  status(ctx: Ctx, id: string): Promise<'verified' | 'pending' | 'failed' | 'not_started'>;
  verify(ctx: Ctx, id: string): Promise<void>;
  /** Read-only: the records the domain needs (ensure() is a write). */
  records?(ctx: Ctx, id: string): Promise<DnsRecord[]>;
}

/**
 * Mints a least-privilege key for the app to use at runtime (e.g. Resend sending_access scoped to one
 * domain). This is a WRITE (it creates a credential), so it is its own capability and is only called
 * from a plan step, never while planning. Providers whose keys can only be read (Supabase, Stripe) use
 * `outputs` instead.
 */
export interface KeyIssuer {
  issue(ctx: Ctx, target: EnvTarget, scope: { domain?: string }): Promise<{ key: OutputKey; id: string; secret: Secret }>;
  /**
   * Revoke a key previously issued (by id), e.g. when rotating or tearing down. A key the provider no
   * longer has is NOT an error: report `revoked: false` with the reason (`'key not found'` for a key
   * that is already gone), the way the webhook/DNS removals report an already-gone resource. Anything
   * the provider cannot undo, and every real failure (auth, network, 5xx), throws. Only teardown steps
   * call this.
   */
  revoke?(ctx: Ctx, id: string): Promise<{ revoked: boolean; reason?: string }>;
}

export interface TestSend {
  /** `key` = send with this credential (e.g. the app's freshly minted key, to prove it works). */
  send(ctx: Ctx, msg: { from: string; to: string; subject: string; text: string; key?: Secret }): Promise<{ id: string }>;
  status(ctx: Ctx, id: string): Promise<string>; // provider's last event, e.g. "delivered"
}

// ── Detection ───────────────────────────────────────────────────────────────────────────────────

export interface EnvRef {
  name: string;
  /** Files (repo-relative) where the name is referenced. */
  files: string[];
  /** true if exposed to the browser by framework convention (NEXT_PUBLIC_, VITE_, …). */
  clientExposed: boolean;
}

export interface DetectResult {
  root: string;
  packageManager: 'pnpm' | 'npm' | 'yarn' | 'bun' | null;
  framework: 'next' | 'vite' | 'remix' | 'react-router' | 'astro' | 'sveltekit' | 'nuxt' | 'static' | 'unknown';
  /** Provider ids per axis found in the repo (package deps, config files). */
  providers: Partial<Record<Axis, string[]>>;
  envRefs: EnvRef[];
  /**
   * Provider config files found: repo-relative path -> short human description (NOT file contents;
   * adapters read the files they need themselves), e.g. { ".vercel/project.json": "linked Vercel project" }.
   */
  configs: Record<string, string>;
  /** Candidate webhook routes, e.g. { provider: 'stripe', path: '/api/webhooks/stripe', file, verifiesSignature, events }. */
  webhooks: Array<{ provider: string; path: string; file: string; verifiesSignature: boolean; events?: string[] }>;
  /** Problems found offline (e.g. a framework config that inlines server secrets into the browser). */
  findings: Finding[];
  /** Builder export markers (lovable, bolt, v0, replit, base44) if any. */
  origin?: string;
  notes: string[];
}

// ── Plan / steps ────────────────────────────────────────────────────────────────────────────────

export interface Risk {
  writes: boolean;
  /** Touches live-mode payments or production data. Needs --confirm-live. */
  live?: boolean;
  /** Creates/changes DNS records. Needs --confirm-dns. */
  dns?: boolean;
  /** Deletes a resource golive previously created. Needs --confirm-destroy. */
  destroy?: boolean;
  /** May cost money. golive never does this itself; such steps are always handoffs. */
  spend?: boolean;
  /**
   * Declares this step's write safe to REPLAY under a later release, instead of stopping for
   * reconciliation the way every other historical write does. The author must be able to defend it:
   * the write is idempotent, re-observes the provider and golive's own recorded resource before
   * acting, and can name exactly what it touches. Never set it on a create whose result cannot be
   * re-derived, a purchase, or anything ambiguous.
   */
  replayable?: boolean;
}

export interface StepContext extends Ctx {
  /** Record a resource id in state (e.g. stripe.live.webhookEndpointId). */
  remember(key: string, value: string): void;
  /** Record that a secret with this fingerprint was delivered to name@target. */
  rememberSecret(name: string, target: EnvTarget, secret: Secret): void;
  /** Same for a PUBLIC value (URL, publishable key): fingerprinted but NOT added to the redactor. */
  rememberValue(name: string, target: EnvTarget, value: Value): void;
}

export interface StepResult {
  /** Human-readable, secret-free lines describing what changed. */
  changes: string[];
}

export interface Step {
  /** Stable across runs, e.g. "link:payments-webhook:production". */
  id: string;
  title: string;
  kind: 'provision' | 'wire' | 'deploy' | 'handoff' | 'destroy';
  risk: Risk;
  dependsOn: string[];
  /** What will happen, secret-free. Shown to the human for approval; part of the plan id. */
  preview: string[];
  /**
   * What makes this run of the step distinct beyond its preview text, e.g. the source identities an
   * env write takes values from ("supabase.secretKey|supabase|<ref>"), key fingerprints, the target
   * project id, or the previous attempt time for verify-type steps. Part of the step hash and the plan
   * id, so a re-planned step with the same preview but different intent runs again. Secret-free
   * (fingerprints only).
   */
  intent?: string;
  /** Structured approval destination. Its identity is included in plan and resume hashes. */
  destination?: ProjectDestination;
  /** Check ids that prove this step worked; run right after it. */
  verifyWith: string[];
  run(ctx: StepContext): Promise<StepResult>;
  /**
   * Step-scoped verification of exactly what this step wrote (e.g. "the 3 env names I set now exist
   * in production"). Runs after `run`, alongside `verifyWith`. Global checks stay for `verify`.
   */
  verifyInline?(ctx: Ctx): Promise<CheckResult[]>;
}

export interface HandoffItem {
  id: string;
  /** Why the human is needed (e.g. "Stripe requires identity verification for live payments"). */
  why: string;
  /** Exactly what to do. */
  action: string;
  url?: string;
  blocking: boolean;
  /** Check id that confirms it is done. Only a passing check closes a handoff. */
  verifiedBy?: string;
  /**
   * golive cannot observe this from outside (e.g. a guided provider's dashboard setting). The agent
   * confirms it with the human and names it as "not verified by golive" in the final summary.
   */
  manual?: boolean;
}

export interface Plan {
  id: string;
  release: ReleaseIdentity;
  steps: Step[];
  handoffs: HandoffItem[];
  /** Env var names the code references that no provider output maps to. */
  unmappedEnv: string[];
  warnings: string[];
}

// ── Checks / findings / report ──────────────────────────────────────────────────────────────────

export interface Finding {
  id: string;
  severity: Severity;
  title: string;
  /** Secret-free evidence (names, URLs, counts, status codes). */
  evidence: string[];
  fix?: string;
}

export type CheckStatus = 'pass' | 'fail' | 'warn' | 'skip';

export interface CheckResult {
  id: string;
  title: string;
  status: CheckStatus;
  severity: Severity;
  evidence: string[];
  fix?: string;
  durationMs?: number;
}

export interface Check {
  id: string;
  title: string;
  /** Default severity when it fails. */
  severity: Severity;
  applies(ctx: Ctx): boolean;
  run(ctx: Ctx): Promise<Omit<CheckResult, 'id' | 'title' | 'durationMs'>>;
}

export interface Report {
  version: 1;
  release?: ReleaseIdentity;
  generatedAt: string;
  app: { root: string; framework: string; domain?: string; urls: Partial<Record<EnvTarget, string>> };
  stack: Partial<Record<Axis, string>>;
  checks: CheckResult[];
  /** Current invocation only. A selected check never refreshes or carries forward old evidence. */
  verification?: { scope: 'full' | 'partial'; requestedCheckIds: string[]; omittedCheckIds: string[] };
  /** done: true = verified, false = open, null = cannot be verified by golive (manual). */
  handoffs: Array<HandoffItem & { done: boolean | null }>;
  /** blocking = open, verifiable, blocking handoffs; manual = blocking items golive can't verify. */
  summary: { pass: number; fail: number; warn: number; skip: number; blocking: number; manual: number };
}

// ── Config (golive.yaml) + state (.golive/state.json) ─────────────────────────────────────────────

export interface ShipConfig {
  version: 1;
  stack: Partial<Record<Axis, string>>;
  domain?: string;
  /** Deploy targets golive manages. Default ['preview', 'production']. */
  targets: Array<Exclude<EnvTarget, 'development'>>;
  payments?: {
    webhook?: { path: string; events: string[] };
    /** Which Stripe mode each target uses. Default { preview: 'test', production: 'live' }. */
    modes?: Partial<Record<Exclude<EnvTarget, 'development'>, Mode>>;
    /** Publishable keys are PUBLIC (they ship in the browser bundle), so they may live in config. */
    publishableKeys?: Partial<Record<Mode, string>>;
  };
  email?: { from?: string; domain?: string; region?: string };
  supabase?: { region?: string };
  neon?: { organizationId?: string; region?: string; branchId?: string; database?: string; role?: string };
  auth?: {
    redirectPaths?: string[];
    /** Also allow preview-deployment URL patterns on the (production) auth project. Default false. */
    previewRedirects?: boolean;
    /** Desired auth policy: the `auth:settings` link writes these, `auth-policy` verifies them. */
    signup?: boolean;
    requireEmailConfirm?: boolean;
    /** Minimum password length to require at the provider (the `auth-policy` check warns below 12). */
    passwordMinLength?: number;
    /** Which mailer auth emails should use: the auth provider's own, or the app's email provider. */
    smtp?: 'provider' | 'resend';
    /**
     * Opt in to the signup → confirmation → login journey: the `auth:test-user` step seeds a test
     * account and the `auth-signup`/`auth-session` checks prove it. Both write to the real project.
     */
    e2e?: boolean;
    /** The human's own address (plus-addressing allowed) that receives the test account's emails. */
    testEmail?: string;
    /** An app route that must require a session (a protected path); checked anonymously. */
    protectedPath?: string;
    /**
     * Opt in to the password-recovery journey: the `auth:recovery` step rotates the recorded test
     * account's password through the provider's own recovery path and the `auth-recovery` check
     * proves it (including that an unknown address gets the same answer). Needs a seeded, confirmed
     * test account (`auth.e2e: true`); the step writes to the real project and needs `--confirm-live`.
     */
    recovery?: boolean;
  };
  /** Project chosen per axis (id or name), e.g. { hosting: "my-app", db: "abcd1234efgh" }. */
  projects?: Partial<Record<Axis, string>>;
  /**
   * Opt-in release capabilities, none of which golive does by itself. `preview: true` asks for a
   * preview deployment of this repo alongside production: golive then plans `preview:deploy` (a
   * create, `--confirm-live` when a live-mode source fills a preview env name) plus `release:check`,
   * which re-reads the deployment the provider reports and scans the bundle it serves as the inline
   * gate. Nothing is promoted: promotion and rollback are later releases.
   */
  release?: { preview?: boolean };
}

export interface StepRecord {
  status: 'done' | 'failed';
  /** Hash of what was approved for this step (preview + risk + deps). A changed step re-runs. */
  hash?: string;
  at: string;
  planId: string;
  /** Runtime that recorded this evidence; absent only in legacy state. */
  release?: ReleaseIdentity;
  changes?: string[];
  error?: string;
}

export interface ShipState {
  version: 1;
  /** Last runtime that recorded progress. Historical step evidence keeps its own identity. */
  release?: ReleaseIdentity;
  /** Resource ids, e.g. { "vercel.projectId": "prj_…", "stripe.live.webhookEndpointId": "we_…" }. */
  resources: Record<string, string>;
  /** name@target -> fingerprint + time. Never values. */
  secrets: Record<string, { fp: string; at: string }>;
  steps: Record<string, StepRecord>;
}

export interface StateStore {
  get(): ShipState;
  resource(key: string): string | undefined;
  save(mutator: (s: ShipState) => void): void;
}

/** Identity shared by release metadata, approval, progress and reports. Never contains secrets. */
export interface ReleaseIdentity {
  schema: 1;
  name: string;
  version: string;
  source: { repository: string; ref: string | null };
  node: string;
  schemas: { config: number; state: number; approval: number };
  bundleDigest: string;
}

export interface ReleaseManifest extends ReleaseIdentity {
  /** Relative file paths -> SHA256. release.json is excluded to avoid a circular hash. */
  files: Record<string, string>;
}
