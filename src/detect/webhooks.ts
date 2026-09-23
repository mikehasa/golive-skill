import type { DetectResult } from '../core/types.js';
import type { FrameworkInfo } from './framework.js';
import type { Repo } from './fs.js';

export type Webhook = DetectResult['webhooks'][number];

const STRIPE_VERIFY = /\.(?:constructEvent|constructEventAsync|parseEventNotification|parseEventNotificationAsync)\s*\(/;
const STRIPE_EVENTS = /['"`](?:checkout\.session\.completed|customer\.subscription\.[a-z_.]+|invoice\.(?:paid|payment_succeeded|payment_failed))['"`]/;
const RAW_BODY =
  /\.(?:text|arrayBuffer)\s*\(\s*\)|\bbuffer\s*\(\s*req\b|readRawBody\s*\(|express\.raw\s*\(|bodyParser\.raw\s*\(|\brawBody\b|getRawBody|['"]raw-body['"]/;

/** Resource prefixes of Stripe event types (`<resource>.<...>.<action>`). */
const STRIPE_EVENT_RESOURCES = [
  'account', 'application', 'application_fee', 'balance', 'balance_settings', 'billing', 'billing_portal', 'capability', 'cash_balance', 'charge',
  'checkout', 'climate', 'coupon', 'credit_note', 'customer', 'customer_cash_balance_transaction', 'entitlements', 'file', 'financial_connections',
  'identity', 'invoice', 'invoice_payment', 'invoiceitem', 'issuing_authorization', 'issuing_card', 'issuing_cardholder', 'issuing_dispute',
  'issuing_personalization_design', 'issuing_token', 'issuing_transaction', 'mandate', 'order', 'payment_intent', 'payment_link', 'payment_method',
  'payout', 'person', 'plan', 'price', 'product', 'promotion_code', 'quote', 'radar', 'recipient', 'refund', 'reporting', 'review', 'setup_intent',
  'sigma', 'sku', 'source', 'subscription_schedule', 'tax', 'tax_rate', 'terminal', 'test_helpers', 'topup', 'transfer', 'treasury',
];
const STRIPE_EVENT_LITERAL = new RegExp(`(['"\`])((?:${STRIPE_EVENT_RESOURCES.join('|')})(?:\\.[a-z_]+){1,3})\\1`, 'g');
/** Last segment of an event type is an action/state; a field path ('price.unit_amount') is not. */
const STRIPE_EVENT_ACTION =
  /(?:^|_)(?:created|updated|deleted|completed|succeeded|failed|paid|canceled|cancelled|expired|expiring|finalized|voided|uncollectible|upcoming|sent|overdue|due|required|processing|requires_action|requires_input|captured|refunded|trial_will_end|paused|resumed|applied|attached|detached|reversed|available|released|closed|withdrawn|reinstated|opened|aborted|activated|deactivated|verified|redacted|funded|reported|ready|reached|rejected|approved|declined|submitted|won|lost|returned|posted|initiated|scheduled|disconnected|refreshed|reactivated|authorized|removed|added|changed|ended|renewed|signed|accepted|restored|disabled|enabled|triggered|resolved|reopened|pending|converted|succeeded|updated)$/;

/**
 * Stripe event types a webhook handler references as string literals (`event.type === '...'`,
 * `case '...':`, arrays of handled types), sorted and de-duplicated. Commented-out code is ignored.
 */
export function stripeEventTypes(text: string): string[] {
  const code = text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
  const out = new Set<string>();
  for (const m of code.matchAll(STRIPE_EVENT_LITERAL)) {
    const type = m[2]!;
    const before = code.slice(Math.max(0, m.index! - 12), m.index!);
    const after = code.slice(m.index! + m[0].length, m.index! + m[0].length + 6);
    const compared = /(?:\bcase|[=!]==?)\s*$/.test(before) || /^\s*[=!]==?/.test(after);
    if (compared || STRIPE_EVENT_ACTION.test(type.slice(type.lastIndexOf('.') + 1))) out.add(type);
  }
  return [...out].sort();
}

/** A file that handles Stripe webhook events (verified or not). */
export function isStripeWebhookFile(text: string): boolean {
  return /stripe/i.test(text) && (STRIPE_VERIFY.test(text) || /stripe-signature/i.test(text) || STRIPE_EVENTS.test(text));
}

/** Correct verification = a verify call on the raw (unparsed) body. Returns why not, if not. */
export function stripeVerification(file: string, text: string): { ok: boolean; reason?: string } {
  if (!STRIPE_VERIFY.test(text)) return { ok: false, reason: 'no stripe.webhooks.constructEvent call' };
  if (/constructEvent(?:Async)?\s*\(\s*JSON\.stringify/.test(text)) return { ok: false, reason: 're-serialized JSON body passed to constructEvent (signature can never match)' };
  if (!RAW_BODY.test(text)) return { ok: false, reason: 'raw request body not used (read it with request.text())' };
  if (/^(?:src\/)?pages\/api\//.test(file) && !/bodyParser\s*:\s*false/.test(text)) {
    return { ok: false, reason: 'Pages Router route without `export const config = { api: { bodyParser: false } }`' };
  }
  const edge = file.startsWith('supabase/functions/') || /\bDeno\./.test(text) || /runtime\s*=\s*['"]edge['"]/.test(text);
  if (edge && !/\.(?:constructEventAsync|parseEventNotificationAsync)\s*\(/.test(text)) {
    return { ok: false, reason: 'edge/Deno runtime needs constructEventAsync (the sync form throws there)' };
  }
  return { ok: true };
}

// ── File path → URL path ────────────────────────────────────────────────────────────────────────

const stripExt = (s: string): string => s.replace(/\.[cm]?[jt]sx?$/, '');
const join = (segs: string[]): string => '/' + segs.filter(Boolean).join('/');

/** Next.js App Router folder segments → URL, or null for private (`_folder`) routes. */
export function nextAppPath(dir: string): string | null {
  const out: string[] = [];
  for (const raw of dir.split('/').filter(Boolean)) {
    if (/^\(.*\)$/.test(raw) || raw.startsWith('@')) continue; // route group / parallel slot
    const seg = raw.replace(/^(?:\(\.{1,3}\))+/, ''); // intercepting-route prefixes
    if (seg.startsWith('_')) return null;
    out.push(seg.replace(/^%5F/i, '_'));
  }
  return join(out);
}

/** Remix v2 / React Router flat-route file name (without extension) → URL. */
export function flatRoutePath(name: string): string {
  const segs = name
    .replace(/\[\.\]/g, '\u0000')
    .split('.')
    .filter((s) => s !== '_index' && !s.startsWith('_'))
    .map((s) => s.replace(/_$/, '').replace(/^\((.*)\)$/, '$1').replace(/^\$$/, '*').replace(/^\$/, ':').replace(/\u0000/g, '.'));
  return join(segs);
}

/** React Router `app/routes.ts` config routes: file (repo-relative) → URL path, honouring prefix()/nesting. */
export function reactRouterConfigRoutes(text: string): Map<string, string> {
  const ranges: Array<{ start: number; end: number; path: string }> = [];
  const calls: Array<{ at: number; path: string; file: string }> = [];
  for (const m of text.matchAll(/\bprefix\(\s*(['"`])([^'"`]*)\1\s*,\s*\[/g)) {
    const open = m.index! + m[0].length - 1;
    ranges.push({ start: open, end: matchBracket(text, open), path: m[2]! });
  }
  for (const m of text.matchAll(/\broute\(\s*(['"`])([^'"`]*)\1\s*,\s*(['"`])([^'"`]+)\3/g)) {
    const after = m.index! + m[0].length;
    calls.push({ at: m.index!, path: m[2]!, file: m[4]! });
    const kids = /^\s*,\s*\[/.exec(text.slice(after));
    if (kids) {
      const open = after + kids[0].length - 1;
      ranges.push({ start: open, end: matchBracket(text, open), path: m[2]! });
    }
  }
  const out = new Map<string, string>();
  for (const c of calls) {
    const parents = ranges.filter((r) => r.start < c.at && c.at < r.end).sort((a, b) => a.start - b.start);
    const file = 'app/' + c.file.replace(/^\.\//, '');
    out.set(file, join([...parents.map((p) => p.path), c.path].flatMap((p) => p.split('/'))));
  }
  return out;
}

function matchBracket(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '[') depth++;
    else if (text[i] === ']' && --depth === 0) return i;
  }
  return text.length;
}

/** Literal path of an Express/Hono/Fastify POST route; prefers one that mentions webhook/stripe. */
export function serverRoutePath(text: string): string | null {
  const paths = [...text.matchAll(/\b(?:app|router|server|api|route[rs]?|r)\s*\.\s*post\s*\(\s*(['"`])(\/[^'"`]*)\1/g)].map((m) => m[2]!);
  return paths.find((p) => /webhook|stripe/i.test(p)) ?? paths[0] ?? null;
}

export function routePath(file: string, text: string, fw: FrameworkInfo, rrRoutes: Map<string, string>): string | null {
  const fn = /^supabase\/functions\/([^/]+)\/index\.[jt]sx?$/.exec(file);
  if (fn) return `/functions/v1/${fn[1]}`;
  const netlify = /^netlify\/functions\/([^/]+?)(?:\/index)?\.[cm]?[jt]s$/.exec(file);
  if (netlify) return `/.netlify/functions/${netlify[1]}`;
  const byFramework = frameworkRoutePath(file, text, fw, rrRoutes);
  if (byFramework) return byFramework;
  const api = /^api\/(.+)\.[cm]?[jt]s$/.exec(file);
  if (api && fw.framework !== 'next') return join(['api', ...api[1]!.split('/')]).replace(/\/index$/, '');
  return serverRoutePath(text);
}

function frameworkRoutePath(file: string, text: string, fw: FrameworkInfo, rrRoutes: Map<string, string>): string | null {
  switch (fw.framework) {
    case 'next': {
      const app = /^(?:src\/)?app\/(?:(.*)\/)?route\.[cm]?[jt]sx?$/.exec(file);
      if (app) {
        const p = nextAppPath(app[1] ?? '');
        return p === null ? null : fw.basePath + p;
      }
      const pages = /^(?:src\/)?pages\/(api\/.+)\.[jt]sx?$/.exec(file);
      return pages ? fw.basePath + join(pages[1]!.split('/')).replace(/\/index$/, '') : null;
    }
    case 'sveltekit': {
      const m = /^src\/routes\/(?:(.*)\/)?\+server\.[jt]s$/.exec(file);
      return m ? join((m[1] ?? '').split('/').filter((s) => !/^\(.*\)$/.test(s))) : null;
    }
    case 'remix':
    case 'react-router': {
      const configured = rrRoutes.get(file);
      if (configured) return configured;
      const m = /^app\/routes\/([^/]+?)(?:\/route)?\.[jt]sx?$/.exec(file);
      return m && /export\s+(?:async\s+)?(?:function|const)\s+action\b/.test(text) ? flatRoutePath(m[1]!) : null;
    }
    case 'astro': {
      const m = /^src\/pages\/(.+)\.[jt]s$/.exec(file);
      return m ? join(m[1]!.split('/')).replace(/\/index$/, '') || '/' : null;
    }
    case 'nuxt': {
      const m = /^(?:src\/)?server\/(api|routes)\/(.+)\.[jt]s$/.exec(file);
      if (!m) return null;
      const segs = stripExt(m[2]!).replace(/\.(?:get|post|put|patch|delete)$/, '').split('/');
      return join([m[1] === 'api' ? 'api' : '', ...segs]).replace(/\/index$/, '');
    }
    default:
      return null;
  }
}

// ── Supabase Edge Function JWT setting ──────────────────────────────────────────────────────────

/** Function names with `verify_jwt = false` in supabase/config.toml. */
export function verifyJwtDisabled(toml: string): Set<string> {
  const out = new Set<string>();
  let current: string | null = null;
  for (const line of toml.split(/\r?\n/)) {
    const section = /^\s*\[\s*([^\]]+?)\s*\]\s*(?:#.*)?$/.exec(line);
    if (section) {
      const fn = /^functions\.(?:"([^"]+)"|'([^']+)'|([\w-]+))$/.exec(section[1]!);
      current = fn ? (fn[1] ?? fn[2] ?? fn[3])! : null;
      continue;
    }
    if (current && /^\s*verify_jwt\s*=\s*false\b/.test(line)) out.add(current);
  }
  return out;
}

// ── Main ────────────────────────────────────────────────────────────────────────────────────────

export async function findWebhooks(repo: Repo, sources: Map<string, string>, fw: FrameworkInfo, notes: string[]): Promise<Webhook[]> {
  const routesTs = ['app/routes.ts', 'app/routes.js'].map((f) => sources.get(f)).find((t) => t !== undefined);
  const rrRoutes = routesTs && (fw.framework === 'react-router' || fw.framework === 'remix') ? reactRouterConfigRoutes(routesTs) : new Map<string, string>();
  const noJwt = verifyJwtDisabled((await repo.read('supabase/config.toml')) ?? '');

  const out: Webhook[] = [];
  for (const [file, text] of sources) {
    if (!isStripeWebhookFile(text)) continue;
    const path = routePath(file, text, fw, rrRoutes);
    if (!path) continue;
    const v = stripeVerification(file, text);
    out.push({ provider: 'stripe', path, file, verifiesSignature: v.ok, events: stripeEventTypes(text) });
    if (!out[out.length - 1]!.events!.length) {
      notes.push(`Stripe webhook ${path} (${file}) handles no event type golive could find as a string literal: pass --events a,b to init so the endpoint subscribes to what the handler needs.`);
    }
    if (!v.ok) notes.push(`Stripe webhook ${path} (${file}) does not verify the Stripe signature correctly: ${v.reason}.`);
    const fn = /^\/functions\/v1\/(.+)$/.exec(path)?.[1];
    if (fn && file.startsWith('supabase/functions/') && !noJwt.has(fn)) {
      notes.push(`Supabase Edge Function ${fn} needs verify_jwt=false: add \`[functions.${fn}]\` with \`verify_jwt = false\` to supabase/config.toml, otherwise Stripe's unauthenticated POST is rejected with 401 before the signature check runs.`);
    }
    if (!fn && fw.staticOutput) notes.push(`Stripe webhook ${path} (${file}) cannot run: the ${fw.framework} app is configured for a static build.`);
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.file < b.file ? -1 : 1));
}
