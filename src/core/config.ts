import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import { AXES, type Axis, type ShipConfig } from './types.js';

export const CONFIG_FILE = 'golive.yaml';

export class ConfigError extends Error {}

/**
 * The non-secret `auth` settings and how each may look. Every entry returns why the value is wrong,
 * or null. Credentials never belong here: `auth.smtp` only picks a mailer.
 */
const AUTH_SETTINGS: Record<string, (v: unknown) => string | null> = {
  redirectPaths: (v) => (Array.isArray(v) && v.every((p) => typeof p === 'string' && p.startsWith('/')) ? null : 'must be a list of paths starting with "/"'),
  previewRedirects: (v) => (typeof v === 'boolean' ? null : 'must be true or false'),
  signup: (v) => (typeof v === 'boolean' ? null : 'must be true or false'),
  requireEmailConfirm: (v) => (typeof v === 'boolean' ? null : 'must be true or false'),
  passwordMinLength: (v) => (typeof v === 'number' && Number.isInteger(v) && v > 0 ? null : 'must be a positive whole number (e.g. 12), never a password'),
  smtp: (v) => (v === 'provider' || v === 'resend' ? null : 'must be "provider" (the auth provider\'s own mailer) or "resend" (the app\'s email provider)'),
  e2e: (v) => (typeof v === 'boolean' ? null : 'must be true or false'),
  testEmail: (v) => (typeof v === 'string' && /^[^@\s+]+(\+[^@\s]+)?@[^@\s]+\.[^@\s]+$/.test(v) ? null : 'must be the address the test account uses, like "you+go-live@example.com" (plus-addressing allowed; never a password)'),
  protectedPath: (v) => (typeof v === 'string' && v.startsWith('/') ? null : 'must be an app route starting with "/", e.g. "/dashboard" (the page that must require a session)'),
  recovery: (v) => (typeof v === 'boolean' ? null : 'must be true or false'),
  isolation: (v) => (typeof v === 'boolean' ? null : 'must be true or false'),
  identityPath: (v) => (typeof v === 'string' && v.startsWith('/') ? null : 'must be an app route starting with "/", e.g. "/api/me" (that route answers with the signed-in caller\'s OWN identity as JSON, and refuses without a session)'),
  isolationPath: (v) => (typeof v === 'string' && v.startsWith('/') ? null : 'must be an app route starting with "/", e.g. "/api/notes" (that route returns the signed-in caller\'s OWN rows, and refuses without a session)'),
};

/** The opt-in `release` settings and how each may look. Each one is off unless set to true. */
const RELEASE_SETTINGS: Record<string, (v: unknown) => string | null> = {
  preview: (v) => (typeof v === 'boolean' ? null : 'must be true or false'),
};

export function defaultConfig(): ShipConfig {
  return { version: 1, stack: {}, targets: ['preview', 'production'] };
}

export function loadConfig(cwd: string): ShipConfig | null {
  const p = join(cwd, CONFIG_FILE);
  if (!existsSync(p)) return null;
  return parseConfig(readFileSync(p, 'utf8'));
}

/** Parse + validate. Hand-rolled (no schema lib) to keep the bundle small and auditable. */
export function parseConfig(text: string): ShipConfig {
  const raw = YAML.parse(text) as Record<string, unknown> | null;
  if (!raw || typeof raw !== 'object') throw new ConfigError(`${CONFIG_FILE} is empty or not a mapping`);
  if (raw.version !== 1) throw new ConfigError(`${CONFIG_FILE}: version must be 1`);

  const stack: Partial<Record<Axis, string>> = {};
  const rawStack = (raw.stack ?? {}) as Record<string, unknown>;
  for (const [k, v] of Object.entries(rawStack)) {
    if (!AXES.includes(k as Axis)) throw new ConfigError(`${CONFIG_FILE}: unknown axis "${k}" (expected one of ${AXES.join(', ')})`);
    if (v === null || v === undefined || v === 'none') continue;
    if (typeof v !== 'string' || !/^[a-z0-9-]+$/.test(v)) throw new ConfigError(`${CONFIG_FILE}: stack.${k} must be a provider id like "vercel"`);
    stack[k as Axis] = v;
  }

  const targets = (raw.targets ?? ['preview', 'production']) as unknown[];
  if (!Array.isArray(targets) || targets.some((t) => t !== 'preview' && t !== 'production')) {
    throw new ConfigError(`${CONFIG_FILE}: targets must be a list of "preview" | "production"`);
  }

  const domain = raw.domain as unknown;
  if (domain !== undefined && (typeof domain !== 'string' || !isDomain(domain))) {
    throw new ConfigError(`${CONFIG_FILE}: domain must be a bare domain like "example.com" (no scheme, no path)`);
  }

  const cfg: ShipConfig = { version: 1, stack, targets: targets as ShipConfig['targets'] };
  if (domain) cfg.domain = domain;

  const payments = raw.payments as ShipConfig['payments'] | undefined;
  if (payments) {
    if (payments.webhook) {
      const { path, events } = payments.webhook;
      if (typeof path !== 'string' || !path.startsWith('/')) throw new ConfigError(`${CONFIG_FILE}: payments.webhook.path must start with "/"`);
      if (!Array.isArray(events) || events.length === 0 || events.some((e) => typeof e !== 'string')) {
        throw new ConfigError(`${CONFIG_FILE}: payments.webhook.events must be a non-empty list of event names`);
      }
    }
    for (const [m, k] of Object.entries(payments.publishableKeys ?? {})) {
      if ((m !== 'test' && m !== 'live') || typeof k !== 'string' || !k.startsWith(`pk_${m}_`)) {
        throw new ConfigError(`${CONFIG_FILE}: payments.publishableKeys.${m} must be a pk_${m}_… key (publishable keys only; never a secret key)`);
      }
    }
    for (const [t, m] of Object.entries(payments.modes ?? {})) {
      if ((t !== 'preview' && t !== 'production') || (m !== 'test' && m !== 'live')) {
        throw new ConfigError(`${CONFIG_FILE}: payments.modes must map preview/production to test/live`);
      }
    }
    cfg.payments = payments;
  }
  const email = raw.email as ShipConfig['email'] | undefined;
  if (email) {
    if (email.from !== undefined && (typeof email.from !== 'string' || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.from.replace(/^.*<|>$/g, '')))) {
      throw new ConfigError(`${CONFIG_FILE}: email.from must be an address like "hello@example.com"`);
    }
    cfg.email = email;
  }
  if (email?.region !== undefined && !['us-east-1', 'eu-west-1', 'sa-east-1', 'ap-northeast-1'].includes(email.region)) {
    throw new ConfigError(`${CONFIG_FILE}: email.region must be one of us-east-1, eu-west-1, sa-east-1, ap-northeast-1`);
  }
  const supabase = raw.supabase as ShipConfig['supabase'] | undefined;
  if (supabase) {
    if (supabase.region !== undefined && (typeof supabase.region !== 'string' || !/^[a-z0-9-]+$/.test(supabase.region))) {
      throw new ConfigError(`${CONFIG_FILE}: supabase.region must be a region code (e.g. us-east-1) or americas|emea|apac`);
    }
    cfg.supabase = supabase;
  }
  if (raw.neon !== undefined) {
    if (!raw.neon || typeof raw.neon !== 'object' || Array.isArray(raw.neon)) {
      throw new ConfigError(`${CONFIG_FILE}: neon must be a mapping of non-secret selectors`);
    }
    const allowed: Record<string, RegExp> = {
      organizationId: /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/,
      region: /^[a-z0-9][a-z0-9-]{0,62}$/,
      branchId: /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/,
      database: /^[a-zA-Z_][a-zA-Z0-9_-]{0,62}$/,
      role: /^[a-zA-Z_][a-zA-Z0-9_-]{0,62}$/,
    };
    for (const [key, value] of Object.entries(raw.neon)) {
      if (!Object.hasOwn(allowed, key)) throw new ConfigError(`${CONFIG_FILE}: unknown neon setting; expected organizationId, region, branchId, database, role (no credentials)`);
      if (typeof value !== 'string' || !allowed[key]!.test(value)) {
        throw new ConfigError(`${CONFIG_FILE}: neon.${key} must be a non-empty identifier, not a URL or credential`);
      }
    }
    cfg.neon = raw.neon as ShipConfig['neon'];
  }
  const auth = raw.auth as Record<string, unknown> | undefined;
  if (auth !== undefined) {
    if (!auth || typeof auth !== 'object' || Array.isArray(auth)) throw new ConfigError(`${CONFIG_FILE}: auth must be a mapping of non-secret settings`);
    for (const [key, value] of Object.entries(auth)) {
      if (!Object.hasOwn(AUTH_SETTINGS, key)) throw new ConfigError(`${CONFIG_FILE}: unknown auth setting; expected ${Object.keys(AUTH_SETTINGS).join(', ')} (no credentials)`);
      const problem = AUTH_SETTINGS[key]!(value);
      if (problem) throw new ConfigError(`${CONFIG_FILE}: auth.${key} ${problem}`);
    }
    cfg.auth = auth as ShipConfig['auth'];
  }
  const release = raw.release as Record<string, unknown> | undefined;
  if (release !== undefined) {
    if (!release || typeof release !== 'object' || Array.isArray(release)) throw new ConfigError(`${CONFIG_FILE}: release must be a mapping of opt-in release settings`);
    for (const [key, value] of Object.entries(release)) {
      if (!Object.hasOwn(RELEASE_SETTINGS, key)) throw new ConfigError(`${CONFIG_FILE}: unknown release setting; expected ${Object.keys(RELEASE_SETTINGS).join(', ')} (no credentials)`);
      const problem = RELEASE_SETTINGS[key]!(value);
      if (problem) throw new ConfigError(`${CONFIG_FILE}: release.${key} ${problem}`);
    }
    cfg.release = release as ShipConfig['release'];
  }
  const projects = raw.projects as Record<string, unknown> | undefined;
  if (projects) {
    for (const [k, v] of Object.entries(projects)) {
      if (!AXES.includes(k as Axis)) throw new ConfigError(`${CONFIG_FILE}: projects.${k} is not an axis`);
      if (typeof v !== 'string' || !v) throw new ConfigError(`${CONFIG_FILE}: projects.${k} must be a project id or name`);
    }
    cfg.projects = projects as ShipConfig['projects'];
  }
  return cfg;
}

export function saveConfig(cwd: string, cfg: ShipConfig): void {
  const header = '# golive config — providers you chose and how they connect. No secrets live here; safe to commit.\n';
  writeFileSync(join(cwd, CONFIG_FILE), header + YAML.stringify(cfg));
}

export function isDomain(s: string): boolean {
  return /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(s);
}

/** Stripe mode for a target: preview→test, production→live unless overridden. */
export function modeFor(cfg: ShipConfig, target: 'preview' | 'production'): 'test' | 'live' {
  return cfg.payments?.modes?.[target] ?? (target === 'production' ? 'live' : 'test');
}
