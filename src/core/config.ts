import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import { AXES, type Axis, type ShipConfig } from './types.js';

export const CONFIG_FILE = 'golive.yaml';

export class ConfigError extends Error {}

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
  const auth = raw.auth as ShipConfig['auth'] | undefined;
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
  if (auth) cfg.auth = auth;
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
