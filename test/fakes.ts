/**
 * In-memory FAKE adapters implementing every capability, for testing links (cross-provider glue)
 * without any provider, network or CLI. Each fake exposes its mutable state so tests can arrange
 * "what already exists" and inspect "what was written".
 */
import { Secret } from '../src/core/secret.js';
import { modeFor } from '../src/core/config.js';
import type { Adapter, AuthLoginOutcome, AuthRecoveryOutcome, AuthSettings, AuthSignupOutcome, AuthUserView, Ctx, DnsRecord, EnvTarget, Mode, OutputKey, Outputs, ProjectRef, Value } from '../src/core/types.js';

export interface Call {
  adapter: string;
  method: string;
  args: unknown[];
}

// Raw values the fakes hand out. Tests assert these never show up anywhere printable.
export const RAW = {
  supabaseSecret: 'sb_secret_FAKEsupabaseSECRETvalue0123456789',
  dbUrl: 'postgres://postgres:FAKEdbPASSWORD9876@db.fake.local:5432/postgres',
  stripeLive: 'sk_' + 'live_FAKEliveSECRETkey0123456789abcdef',
  stripeTest: 'sk_' + 'test_FAKEtestSECRETkey0123456789abcdef',
  resendKey: 're' + '_FAKEresend_KEYvalue0123456789',
  whsecPrefix: 'whsec' + '_FAKEwebhookSIGNINGsecret',
  authSession: 'fake-auth-session-TOKEN-0123456789abcdef',
} as const;

export const PUBLIC = {
  supabaseUrl: 'https://abcd.fakedb.co',
  supabasePublishable: 'sb_publishable_FAKEpublic123',
  pkLive: 'pk_live_FAKEpublishable123',
  pkTest: 'pk_test_FAKEpublishable123',
} as const;

export const ALL_RAW_SECRETS = (): string[] => [RAW.supabaseSecret, RAW.dbUrl, 'FAKEdbPASSWORD9876', RAW.stripeLive, RAW.stripeTest, RAW.resendKey, RAW.whsecPrefix, RAW.authSession];

type EnvMap = Record<EnvTarget, Map<string, Value>>;

export function fakeWorld() {
  const calls: Call[] = [];
  const rec = (adapter: string, method: string, ...args: unknown[]) => calls.push({ adapter, method, args });

  // ── Host ────────────────────────────────────────────────────────────────────────────────────────
  const host = {
    authed: true,
    current: { id: 'prj_1', name: 'shop' } as ProjectRef | null,
    candidates: [] as ProjectRef[],
    canCreate: true,
    createError: null as string | null,
    /** When false, the fake project linker has no remove() (a provider golive cannot delete from). */
    canRemoveProject: true,
    /** When false, the fake project linker has no exists() (a host whose deletion cannot be re-read). */
    withExists: true,
    /** When set, project.exists() throws this (a read the provider cannot answer). */
    existsError: null as string | null,
    /** When true, the delete reports success but leaves the project resolvable (a provider that did not delete it). */
    removeKeepsProject: false,
    /** What project.remove() answers. */
    removeResult: { removed: true } as { removed: boolean; reason?: string },
    /** When set, project.remove() throws this (a provider-side error, unlike a refusal). */
    removeError: null as string | null,
    /** Ids project.remove() was called for (the current project, or '?' when none was linked). */
    removed: [] as string[],
    env: { development: new Map(), preview: new Map(), production: new Map() } as EnvMap,
    urls: { development: null, preview: 'https://shop-git-main.fakehost.app', production: 'https://shop.fakehost.app' } as Record<EnvTarget, string | null>,
    previewPatterns: ['https://shop-*.fakehost.app/**'],
    domainStatus: 'pending' as 'ok' | 'pending' | 'misconfigured',
    attached: [] as string[],
    records: [{ type: 'A', name: 'example.com', content: '76.76.21.21' }] as DnsRecord[],
    deploys: 0,
    /** When set, the next deploy throws this (then clears it), like a failing build. */
    deployError: null as string | null,
    /** The deployment identity the fake host reports; null = a provider that reports none. */
    deployId: 'dpl_fake1' as string | null,
    /** Whether the fake host exposes DomainAttach.verify, and what it returns. */
    withDomainVerify: true,
    verifyResult: 'pending' as 'verified' | 'pending',
    /** name -> why the host refuses to write it (like a Vercel var shared by several targets); canSet reports it, set throws it. */
    envRefuse: {} as Record<string, string>,
    /** When false, the fake EnvStore has no canSet() preflight. */
    withCanSet: true,
  };
  const hostAdapter: Adapter = {
    id: 'fakehost',
    title: 'FakeHost',
    axes: ['hosting'],
    automated: true,
    auth: async () => (host.authed ? { ok: true, via: 'fakehost CLI' } : { ok: false, howToFix: 'run `fakehost login` in your terminal' }),
    capabilities: {
      project: {
        current: async () => host.current,
        candidates: async () => host.candidates,
        select: async (_c, idOrName) => {
          rec('fakehost', 'project.select', idOrName);
          const known = [...(host.current ? [host.current] : []), ...host.candidates];
          const p = known.find((x) => x.id === idOrName || x.name === idOrName) ?? { id: `prj_${idOrName}`, name: idOrName };
          host.current = p;
          return p;
        },
        get create() {
          return host.canCreate
            ? async (_c: unknown, name: string) => {
                rec('fakehost', 'project.create', name);
                if (host.createError) throw new Error(host.createError);
                host.current = { id: `prj_new_${name}`, name };
                return host.current;
              }
            : undefined;
        },
        get remove() {
          return host.canRemoveProject
            ? async (c: Ctx): Promise<{ removed: boolean; reason?: string }> => {
                rec('fakehost', 'project.remove');
                if (host.removeError) throw new Error(host.removeError);
                host.removed.push(host.current?.id ?? '?');
                if (host.removeResult.removed) {
                  // Like the real host adapters, a reported deletion clears this host's own state keys.
                  c.state.save((s) => {
                    delete s.resources['fakehost.projectId']; delete s.resources['fakehost.projectName'];
                    delete s.resources['fakehost.createdProjectId'];
                  });
                  if (!host.removeKeepsProject) host.current = null;
                }
                return host.removeResult;
              }
            : undefined;
        },
        get exists() {
          return host.withExists
            ? async (_c: unknown, id: string): Promise<boolean> => {
                rec('fakehost', 'project.exists', id);
                if (host.existsError) throw new Error(host.existsError);
                return host.current?.id === id;
              }
            : undefined;
        },
      },
      env: {
        listNames: async (_c, t) => [...host.env[t].keys()].sort(),
        set: async (_c, name, value, targets, opts) => {
          rec('fakehost', 'env.set', name, value, targets, opts);
          if (host.envRefuse[name]) throw new Error(`${name} ${host.envRefuse[name]}`);
          for (const t of targets) host.env[t].set(name, value);
        },
        get canSet() {
          return host.withCanSet ? async (_c: unknown, name: string) => host.envRefuse[name] ?? null : undefined;
        },
      },
      url: {
        get: async (_c, t) => host.urls[t],
        previewPatterns: async () => host.previewPatterns,
      },
      deploy: {
        deploy: async (_c, t) => {
          rec('fakehost', 'deploy', t);
          if (host.deployError) {
            const msg = host.deployError;
            host.deployError = null;
            throw new Error(msg);
          }
          host.deploys++;
          host.urls[t] ??= 'https://shop.fakehost.app';
          const url = 'https://shop-abc123.fakehost.app';
          return host.deployId ? { url, id: host.deployId } : { url };
        },
      },
      domain: {
        add: async (_c, d) => {
          rec('fakehost', 'domain.add', d);
          if (!host.attached.includes(d)) host.attached.push(d);
        },
        requiredRecords: async () => host.records,
        status: async () => host.domainStatus,
        get verify() {
          return host.withDomainVerify
            ? async (_c: unknown, d: string) => {
                rec('fakehost', 'domain.verify', d);
                return host.verifyResult;
              }
            : undefined;
        },
      },
    },
  };

  // ── Database + auth (one provider, two axes, like Supabase) ─────────────────────────────────────
  const db = {
    authed: true,
    current: { id: 'db_1', name: 'shop' } as ProjectRef | null,
    candidates: [] as ProjectRef[],
    /** Which outputs the provider can supply (db.url only when the password is known). */
    provides: ['supabase.url', 'supabase.publishableKey', 'supabase.secretKey', 'db.url'] as OutputKey[],
    /** When false, the fake has no provides() and links fall back to outputs() keys. */
    declaresProvides: true,
    auth: {
      siteUrl: 'http://localhost:3000',
      redirectUrls: ['http://localhost:3000/**'],
      signupEnabled: true,
      emailConfirmRequired: true,
      minPasswordLength: 6,
      smtp: { configured: false },
      emailRateLimitPerHour: 30,
    } as AuthSettings,
    /** Policy fields the fake provider accepts but never reports back (its API does not echo them). */
    authIgnores: [] as string[],
    outputsCalls: 0,
    /**
     * The provider's own user surface (Supabase GoTrue). `users` holds the seeded accounts with the
     * passwords the fake was given, so a test can confirm one (the human's click) and watch what the
     * step and checks do; `sessions` maps a handed-out session token to its user id.
     */
    authUsers: {
      users: [] as Array<{ id: string; email: string; confirmed: boolean; pass: string }>,
      sessions: new Map<string, string>(),
      destination: { ref: 'abcdefghijklmnopqrst', url: 'https://abcdefghijklmnopqrst.supabase.co' } as { ref: string; url: string } | null,
      /** Overrides the next signup answer (captcha, rate limit, no confirmation sent). */
      signup: null as Partial<AuthSignupOutcome> | null,
      /** Queued password-grant answers (email_not_confirmed, a session, 429), one per login call. */
      logins: [] as Array<Partial<AuthLoginOutcome>>,
      /** Overrides the anonymous `GET /user` answer (for a provider that answers 200). */
      anonUser: null as AuthUserView | null,
      /** Throws on the next auth-users call: a provider-side failure, unlike a refusal. */
      error: null as string | null,
      /** Throws on the next password grant only (a transport failure mid-check). */
      loginError: null as string | null,
      /** Ids the provider no longer knows (a user deleted in the dashboard). */
      missing: new Set<string>(),
      /** Addresses the fake was asked to send a recovery email to, in order. */
      recoveryRequests: [] as string[],
      /** Overrides the next recovery request for an address WITH an account (captcha, 429, a refusal). */
      recovery: null as Partial<AuthRecoveryOutcome> | null,
      /** Overrides the next recovery request for an address with NO account (a provider that enumerates). */
      recoveryUnknown: null as Partial<AuthRecoveryOutcome> | null,
      /** Minted recovery tokens, single-use like the real ones. */
      recoveryTokens: new Map<string, { userId: string; used: boolean }>(),
      /** The provider has no account for the address a recovery link was asked for (returns null). */
      linkMissing: false,
      /** The user id a minted recovery link claims; null = the account it was asked about. */
      linkUserId: null as string | null,
      /** A provider that keeps a spent token usable: the replay leg must catch it. */
      recoveryReuse: false,
      /** Throws on the next recovery-session call only (a transport failure mid-check). */
      recoveryError: null as string | null,
      /** The human clicked the confirmation link in their inbox. */
      confirm(email: string): void {
        for (const u of db.authUsers.users) if (u.email === email) u.confirmed = true;
      },
      byEmail(email: string) {
        return db.authUsers.users.find((u) => u.email === email);
      },
    },
  };
  const dbOutputs = (): Outputs => {
    const all: Outputs = {
      'supabase.url': PUBLIC.supabaseUrl,
      'supabase.publishableKey': PUBLIC.supabasePublishable,
      'supabase.secretKey': new Secret('SUPABASE_SECRET_KEY', RAW.supabaseSecret),
      'db.url': new Secret('DATABASE_URL', RAW.dbUrl),
    };
    return Object.fromEntries(Object.entries(all).filter(([k]) => db.provides.includes(k as OutputKey)));
  };
  const outputsCap = {
    outputs: async () => {
      db.outputsCalls++;
      return dbOutputs();
    },
  };
  const dbAdapter: Adapter = {
    id: 'fakedb',
    title: 'FakeDB',
    axes: ['db', 'auth'],
    automated: true,
    auth: async () => (db.authed ? { ok: true } : { ok: false, howToFix: 'export FAKEDB_ACCESS_TOKEN in your shell' }),
    capabilities: {
      project: {
        current: async () => db.current,
        candidates: async () => db.candidates,
        select: async (_c, idOrName) => {
          rec('fakedb', 'project.select', idOrName);
          const known = [...(db.current ? [db.current] : []), ...db.candidates];
          db.current = known.find((x) => x.id === idOrName || x.name === idOrName) ?? { id: idOrName, name: idOrName };
          return db.current;
        },
      },
      // provides() is an optional extension the links understand; exposed via a getter so tests can toggle it.
      get outputs() {
        return db.declaresProvides ? { ...outputsCap, provides: async () => db.provides } : outputsCap;
      },
      authConfig: {
        get: async () => structuredClone(db.auth),
        set: async (_c, patch) => {
          rec('fakedb', 'authConfig.set', patch);
          const { smtpPassword, ...settings } = patch;
          const after = structuredClone(db.auth) as unknown as Record<string, unknown>;
          const applied: string[] = [];
          const skipped: string[] = [];
          if (smtpPassword) skipped.push('smtpPassword (write-only: the provider never returns the value, so golive cannot confirm it)');
          for (const [key, value] of Object.entries(settings)) {
            if (db.authIgnores.includes(key)) {
              skipped.push(`${key} (the provider does not report this setting back)`);
              delete after[key];
              continue;
            }
            after[key] = value;
            applied.push(key);
          }
          db.auth = after as unknown as AuthSettings;
          return { after: structuredClone(db.auth), applied, skipped };
        },
      },
      dbAdmin: { tables: async () => [] },
      authUsers: {
        destination: async () => db.authUsers.destination,
        signup: async (_c, email, password) => {
          const users = db.authUsers;
          rec('fakedb', 'authUsers.signup', email, password);
          if (users.error) throw new Error(users.error);
          const override = users.signup;
          users.signup = null;
          if (override) {
            if (override.userId) users.users.push({ id: override.userId, email, confirmed: false, pass: password.reveal() });
            return { status: 200, confirmationSent: false, existing: false, rateLimited: false, captchaRequired: false, ...override };
          }
          const seen = users.byEmail(email);
          if (seen) return { status: 200, userId: seen.id, confirmationSent: false, existing: true, rateLimited: false, captchaRequired: false };
          const id = `usr_${users.users.length + 1}`;
          users.users.push({ id, email, confirmed: false, pass: password.reveal() });
          return { status: 200, userId: id, confirmationSent: true, existing: false, rateLimited: false, captchaRequired: false };
        },
        login: async (_c, email, password) => {
          const users = db.authUsers;
          rec('fakedb', 'authUsers.login', email, password);
          if (users.error) throw new Error(users.error);
          const failure = users.loginError;
          users.loginError = null;
          if (failure) throw new Error(failure);
          const override = users.logins.shift();
          if (override) return { status: 200, rateLimited: false, ...override };
          const u = users.byEmail(email);
          if (!u || u.pass !== password.reveal()) return { status: 400, code: 'invalid_credentials', rateLimited: false };
          if (!u.confirmed) return { status: 400, code: 'email_not_confirmed', rateLimited: false };
          const token = `${RAW.authSession}:${u.id}`;
          users.sessions.set(token, u.id);
          return { status: 200, rateLimited: false, session: { accessToken: new Secret('SUPABASE_AUTH_TOKEN', token), userId: u.id, emailConfirmed: true } };
        },
        user: async (_c, token) => {
          const users = db.authUsers;
          if (users.error) throw new Error(users.error);
          if (!token) return users.anonUser ?? { status: 401 };
          const id = users.sessions.get(token.reveal());
          const u = users.users.find((x) => x.id === id);
          if (!u || users.missing.has(u.id)) return { status: 401 };
          return { status: 200, id: u.id, email: u.email, emailConfirmed: u.confirmed };
        },
        adminUser: async (_c, id) => {
          const users = db.authUsers;
          if (users.error) throw new Error(users.error);
          if (users.missing.has(id)) return null;
          const u = users.users.find((x) => x.id === id);
          return u ? { status: 200, id: u.id, email: u.email, emailConfirmed: u.confirmed } : null;
        },
        setPassword: async (_c, id, password) => {
          const users = db.authUsers;
          rec('fakedb', 'authUsers.setPassword', id, password);
          if (users.error) throw new Error(users.error);
          const u = users.missing.has(id) ? undefined : users.users.find((x) => x.id === id);
          if (!u) throw new Error(`no such user ${id}`);
          u.pass = password.reveal();
        },
        requestRecovery: async (_c, email) => {
          const users = db.authUsers;
          rec('fakedb', 'authUsers.requestRecovery', email);
          if (users.error) throw new Error(users.error);
          const known = Boolean(users.byEmail(email));
          const override = known ? users.recovery : users.recoveryUnknown;
          if (known) users.recovery = null;
          else users.recoveryUnknown = null;
          users.recoveryRequests.push(email);
          // Like GoTrue: an address with no account is answered exactly like one that has an account.
          return { status: 200, accepted: true, emailSent: true, rateLimited: false, captchaRequired: false, ...override };
        },
        recoveryLink: async (_c, email) => {
          const users = db.authUsers;
          rec('fakedb', 'authUsers.recoveryLink', email);
          if (users.error) throw new Error(users.error);
          const u = users.linkMissing ? undefined : users.byEmail(email);
          if (!u) return null;
          const token = `recovery-token-${users.recoveryTokens.size + 1}-FAKErecoveryTOKENvalue`;
          const userId = users.linkUserId ?? u.id;
          users.recoveryTokens.set(token, { userId, used: false });
          return { userId, token: new Secret('SUPABASE_RECOVERY_TOKEN', token) };
        },
        recoverySession: async (_c, token) => {
          const users = db.authUsers;
          rec('fakedb', 'authUsers.recoverySession', token);
          if (users.error) throw new Error(users.error);
          const failure = users.recoveryError;
          users.recoveryError = null;
          if (failure) throw new Error(failure);
          const entry = users.recoveryTokens.get(token.reveal());
          if (!entry || (entry.used && !users.recoveryReuse)) return { status: 403, code: 'otp_expired', rateLimited: false };
          entry.used = true;
          const u = users.users.find((x) => x.id === entry.userId);
          if (!u) return { status: 403, code: 'otp_expired', rateLimited: false };
          const session = `${RAW.authSession}:recovery:${u.id}`;
          users.sessions.set(session, u.id);
          return { status: 200, rateLimited: false, session: { accessToken: new Secret('SUPABASE_AUTH_TOKEN', session), userId: u.id, emailConfirmed: true } };
        },
        updateOwnPassword: async (_c, session, password) => {
          const users = db.authUsers;
          rec('fakedb', 'authUsers.updateOwnPassword', session, password);
          if (users.error) throw new Error(users.error);
          const id = users.sessions.get(session.reveal());
          const u = id ? users.users.find((x) => x.id === id) : undefined;
          if (!u) throw new Error('the session token was rejected');
          u.pass = password.reveal();
        },
      },
    },
  };

  // ── Payments ────────────────────────────────────────────────────────────────────────────────────
  const pay = {
    authed: true,
    secretKeys: { live: RAW.stripeLive, test: RAW.stripeTest } as Partial<Record<Mode, string>>,
    publishableKeys: { live: PUBLIC.pkLive, test: PUBLIC.pkTest } as Partial<Record<Mode, string>>,
    /** owned: false = created by the human, not golive (default: owned). */
    endpoints: [] as Array<{ id: string; url: string; events: string[]; enabled: boolean; mode: Mode; owned?: boolean }>,
    deleted: [] as string[],
    n: 0,
    withReplace: true,
    /** When false, the fake has no find() (links fall back to list()). */
    withFind: true,
    /** When set, webhooks.remove() throws this (a provider-side error, unlike a refusal). */
    removeError: null as string | null,
    /** What webhooks.remove() answers instead of deleting, e.g. a caught provider error. */
    removeResult: null as { deleted: boolean; reason?: string } | null,
  };
  // Same rule as the stripe adapter: owned by golive first, else any endpoint at that URL.
  const matchEndpoint = (url: string, mode: Mode) => {
    const same = pay.endpoints.filter((x) => x.url === url && x.mode === mode);
    return same.find((x) => x.owned !== false) ?? same[0];
  };
  const newEndpoint = (url: string, events: string[], mode: Mode) => {
    const id = `we_${++pay.n}`;
    pay.endpoints.push({ id, url, events, enabled: true, mode });
    return { id, created: true, secret: new Secret('STRIPE_WEBHOOK_SECRET', `${RAW.whsecPrefix}${pay.n}xyz`) };
  };
  const payAdapter: Adapter = {
    id: 'fakepay',
    title: 'FakePay',
    axes: ['payments'],
    automated: true,
    auth: async () => (pay.authed ? { ok: true } : { ok: false, howToFix: 'run `fakepay login` in your terminal' }),
    capabilities: {
      paymentAccount: {
        identify: async (_ctx, mode) => ({ mode, accountId: 'acct_FakePay', operatorFingerprint: `fake-operator-${mode}` }),
        bind: async (ctx) => ctx,
      },
      outputs: {
        outputs: async (c, t) => {
          const mode = modeFor(c.config, t === 'development' ? 'preview' : t);
          const out: Outputs = {};
          const sk = pay.secretKeys[mode];
          if (sk) out['stripe.secretKey'] = new Secret('STRIPE_SECRET_KEY', sk);
          const pk = pay.publishableKeys[mode];
          if (pk) out['stripe.publishableKey'] = pk;
          return out;
        },
      },
      webhooks: {
        // Like Stripe's list(): only endpoints golive owns (a human's endpoint is invisible here).
        list: async (_c, mode) => pay.endpoints.filter((e) => e.mode === mode && e.owned !== false).map(({ mode: _m, owned, ...e }) => ({ ...e, owned: owned !== false })),
        get find() {
          return pay.withFind
            ? async (_c: unknown, url: string, mode: Mode) => {
                const e = matchEndpoint(url, mode);
                return e ? { id: e.id, url: e.url, events: e.events, enabled: e.enabled, owned: e.owned !== false } : null;
              }
            : undefined;
        },
        ensure: async (_c, spec) => {
          rec('fakepay', 'webhooks.ensure', spec);
          const e = matchEndpoint(spec.url, spec.mode);
          if (e) {
            e.events = e.owned === false ? [...new Set([...e.events, ...spec.events])] : spec.events;
            e.enabled = true;
            return { id: e.id, created: false };
          }
          return newEndpoint(spec.url, spec.events, spec.mode);
        },
        get replace() {
          return pay.withReplace
            ? async (_c: unknown, id: string, mode: Mode, opts: { deleteOld?: boolean } = {}) => {
                rec('fakepay', 'webhooks.replace', id, mode);
                const old = pay.endpoints.find((x) => x.id === id)!;
                const created = newEndpoint(old.url, old.events, mode);
                if (opts.deleteOld === false) return { ...created, oldDeleted: false, oldLeft: 'kept until the new signing secret is stored' };
                if (old.owned === false) return { ...created, oldDeleted: false, oldLeft: 'not created by golive' };
                pay.endpoints = pay.endpoints.filter((x) => x.id !== id);
                pay.deleted.push(id);
                return { ...created, oldDeleted: true };
              }
            : undefined;
        },
        get remove() {
          return pay.withReplace
            ? async (_c: unknown, id: string) => {
                rec('fakepay', 'webhooks.remove', id);
                if (pay.removeError) throw new Error(pay.removeError);
                if (pay.removeResult) return pay.removeResult;
                const old = pay.endpoints.find((x) => x.id === id);
                if (!old) return { deleted: false, reason: 'endpoint not found' };
                if (old.owned === false) return { deleted: false, reason: 'not created by golive' };
                pay.endpoints = pay.endpoints.filter((x) => x.id !== id);
                pay.deleted.push(id);
                return { deleted: true };
              }
            : undefined;
        },
      },
    },
  };

  // ── Email ───────────────────────────────────────────────────────────────────────────────────────
  const mail = {
    authed: true,
    domains: new Map<string, { id: string; status: 'verified' | 'pending' | 'failed' | 'not_started' }>(),
    verifyError: null as string | null,
    keys: 0,
    /** When false, the fake key issuer has no revoke() (a provider golive can't revoke at). */
    withRevoke: true,
    /** When set, keys.revoke() throws this (a provider-side error, unlike an already-revoked key). */
    revokeError: null as string | null,
    /** What keys.revoke() answers instead of revoking, e.g. a key that is already gone. */
    revokeResult: null as { revoked: boolean; reason?: string } | null,
    /** Ids keys.revoke() was called for. */
    revoked: [] as string[],
  };
  const mailRecords = (d: string): DnsRecord[] => [
    { type: 'MX', name: `send.${d}`, content: 'feedback-smtp.fakemail.com', priority: 10 },
    { type: 'TXT', name: `send.${d}`, content: 'v=spf1 include:fakemail.com ~all' },
    { type: 'TXT', name: `fm._domainkey.${d}`, content: 'p=MIGfMA0GFAKEdkim' },
  ];
  const mailAdapter: Adapter = {
    id: 'fakemail',
    title: 'FakeMail',
    axes: ['email'],
    automated: true,
    auth: async () => (mail.authed ? { ok: true } : { ok: false, howToFix: 'export FAKEMAIL_API_KEY in your shell' }),
    capabilities: {
      sendingDomain: {
        ensure: async (_c, d) => {
          rec('fakemail', 'sendingDomain.ensure', d);
          let e = mail.domains.get(d);
          if (!e) mail.domains.set(d, (e = { id: `dom_${d}`, status: 'not_started' }));
          return { id: e.id, records: mailRecords(d) };
        },
        status: async (_c, id) => [...mail.domains.values()].find((x) => x.id === id)?.status ?? 'not_started',
        verify: async (_c, id) => {
          rec('fakemail', 'sendingDomain.verify', id);
          if (mail.verifyError) throw new Error(mail.verifyError);
          const e = [...mail.domains.values()].find((x) => x.id === id);
          if (e) e.status = 'pending';
        },
      },
      keys: {
        issue: async (_c, target, scope) => {
          rec('fakemail', 'keys.issue', target, scope);
          return { key: 'resend.apiKey', id: `key_${++mail.keys}`, secret: new Secret('RESEND_API_KEY', `${RAW.resendKey}${mail.keys}`) };
        },
        get revoke() {
          return mail.withRevoke
            ? async (_c: unknown, id: string): Promise<{ revoked: boolean; reason?: string }> => {
                rec('fakemail', 'keys.revoke', id);
                if (mail.revokeError) throw new Error(mail.revokeError);
                if (mail.revokeResult) return mail.revokeResult;
                mail.revoked.push(id);
                return { revoked: true };
              }
            : undefined;
        },
      },
      testSend: { send: async () => ({ id: 'msg_1' }), status: async () => 'delivered' },
    },
  };

  // ── DNS ─────────────────────────────────────────────────────────────────────────────────────────
  const dns = {
    authed: true,
    zones: new Set<string>(['example.com']),
    records: [] as DnsRecord[],
    /** When set, hosts() throws this (e.g. a token without Zone:Read, or a rate limit). */
    lookupError: null as string | null,
    /** When true, list() returns nothing (simulates a write that didn't stick). */
    hideRecords: false,
    /** The records the fake provider reports as golive-owned (listOwned) — teardown candidates. */
    owned: [] as DnsRecord[],
    /** When false, the fake zone has no listOwned/remove: a provider that can't tell owned records apart. */
    withOwned: true,
    /** When set, remove() throws this (like a provider refusing an unowned or ambiguous match). */
    removeError: null as string | null,
  };
  const dnsAdapter: Adapter = {
    id: 'fakedns',
    title: 'FakeDNS',
    axes: ['dns'],
    automated: true,
    auth: async () => (dns.authed ? { ok: true } : { ok: false, howToFix: 'export FAKEDNS_TOKEN in your shell' }),
    capabilities: {
      dns: {
        hosts: async (_c, d) => {
          if (dns.lookupError) throw new Error(dns.lookupError);
          return [...dns.zones].some((z) => d === z || d.endsWith(`.${z}`));
        },
        list: async () => (dns.hideRecords ? [] : dns.records),
        upsert: async (_c, _d, r) => {
          rec('fakedns', 'dns.upsert', r);
          const i = dns.records.findIndex((x) => x.type === r.type && x.name === r.name && (r.type !== 'TXT' || x.content === r.content));
          if (i < 0) {
            dns.records.push(r);
            return 'created';
          }
          if (dns.records[i]!.content === r.content) return 'unchanged';
          dns.records[i] = r;
          return 'updated';
        },
        get listOwned() {
          return dns.withOwned
            ? async (_c: unknown, domain: string): Promise<DnsRecord[]> => {
                rec('fakedns', 'dns.listOwned', domain);
                // Like a real zone listing: only records inside the requested zone.
                return dns.owned.filter((r) => r.name === domain || r.name.endsWith(`.${domain}`));
              }
            : undefined;
        },
        get remove() {
          return dns.withOwned
            ? async (_c: unknown, domain: string, r: DnsRecord): Promise<'removed' | 'unchanged'> => {
                rec('fakedns', 'dns.remove', domain, r);
                if (dns.removeError) throw new Error(dns.removeError);
                const i = dns.owned.findIndex((x) => x.type === r.type && x.name === r.name && x.content === r.content);
                if (i < 0) return 'unchanged';
                dns.owned.splice(i, 1);
                return 'removed';
              }
            : undefined;
        },
      },
    },
  };

  const guidedAdapter: Adapter = { id: 'fakeguided', title: 'FakeGuided', axes: ['hosting', 'auth', 'dns'], automated: false, auth: async () => ({ ok: true }), capabilities: {} };

  return {
    calls,
    host,
    db,
    pay,
    mail,
    dns,
    adapters: [hostAdapter, dbAdapter, payAdapter, mailAdapter, dnsAdapter, guidedAdapter],
  };
}

export type FakeWorld = ReturnType<typeof fakeWorld>;

/** The full stack wired to the fakes. */
export const FAKE_STACK = { hosting: 'fakehost', db: 'fakedb', auth: 'fakedb', payments: 'fakepay', email: 'fakemail', dns: 'fakedns' } as const;
