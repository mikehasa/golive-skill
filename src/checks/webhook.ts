import type { Check, Ctx } from '../core/types.js';
import { modeFor } from '../core/config.js';
import { baseUrl, blocked, cap, confirmedProductionUrl, errMsg, pass, prereq, probe, result, skip, type CheckOutcome } from './util.js';

function join(base: string, path: string): string {
  return /^https?:\/\//.test(path) ? path : `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

/** The URL the webhook link registers at the provider (config.domain first). For comparison only. */
async function registeredUrl(ctx: Ctx): Promise<string | null> {
  const path = ctx.config.payments?.webhook?.path;
  const base = await baseUrl(ctx);
  return path && base ? join(base, path) : null;
}

const looksLikeHtml = (text: string) => /^\s*(<!doctype html|<html)/i.test(text);

/**
 * An unsigned POST to the production webhook route must be rejected (4xx). Sends `{}` only.
 * A non-HTML 401/403 only warns: an auth wall in front of the route answers just like a handler
 * rejecting the signature, so neither can be proven from outside (Stripe counts 401/403 as failures).
 */
export const webhookUnsignedCheck: Check = {
  id: 'webhook-unsigned',
  title: 'Webhook rejects unsigned requests',
  severity: 'critical',
  applies: (ctx) => Boolean(ctx.config.payments?.webhook),
  async run(ctx) {
    // Active probe: only POST to the URL the host confirms is this project's, never config.domain blindly.
    const confirmed = await confirmedProductionUrl(ctx);
    if (!confirmed.ok) return confirmed.outcome;
    const url = join(confirmed.url, ctx.config.payments!.webhook!.path);
    const notes: string[] = [];
    const registered = await registeredUrl(ctx);
    if (registered && new URL(registered).origin !== new URL(url).origin) {
      notes.push(`the host does not report ${new URL(registered).origin} for this project yet, so the probe went to ${new URL(url).origin} (same deployment)`);
    }
    const r = await runUnsigned(ctx, url);
    return notes.length ? { ...r, evidence: [...r.evidence, ...notes] } : r;
  },
};

async function runUnsigned(ctx: Ctx, url: string): Promise<CheckOutcome> {
  let r;
  try {
    r = await probe(ctx, url, { method: 'POST', body: {}, headers: { 'user-agent': 'golive-verify' } });
  } catch (e) {
    return result('fail', 'high', [`POST ${url} failed: ${errMsg(e)}`], 'Make sure the production deployment is reachable, then re-run verify.');
  }
  const ev = `POST ${url} without Stripe-Signature → HTTP ${r.status}`;
  const s = r.status;
  if (s >= 200 && s < 300) {
    return result('fail', 'critical', [ev, 'the route accepted an unsigned event'], 'Verify the signature before doing anything: `stripe.webhooks.constructEvent(rawBody, req.headers["stripe-signature"], STRIPE_WEBHOOK_SECRET)` on the RAW body; return 400 when it throws. Anyone can currently forge payment events.');
  }
  if (s >= 300 && s < 400) {
    return result('fail', 'high', [ev, `redirects to ${r.headers.location ?? '(no location)'}`], 'Stripe does not follow redirects. Register the final URL (check trailing slash, www vs apex, http→https) or exclude the webhook path from redirects/middleware.');
  }
  if (s === 404) return result('fail', 'high', [ev], 'The webhook route is missing in production. Check the path in golive.yaml matches the route file and that the latest deploy includes it.');
  if (s === 405) return result('fail', 'high', [ev], 'The route exists but does not accept POST. Export a POST handler for the webhook path.');
  if (s === 429) return result('warn', 'medium', [ev, 'rate-limited; could not judge the handler'], 'Re-run verify in a minute.');
  if (s >= 500) {
    return result('fail', 'high', [ev], 'The handler crashes on unsigned input. Verify the Stripe signature first and return 400 on failure, before parsing or touching the database; check that STRIPE_WEBHOOK_SECRET is set in production.');
  }
  // 4xx: rejected. 401/403 alone proves nothing: an auth wall in front of the route (or a gateway)
  // answers the same way as a handler rejecting the missing signature, and Stripe counts both as
  // failed deliveries (docs.stripe.com/webhooks — 401/403 under "access restrictions").
  if (s === 401 || s === 403) {
    if (looksLikeHtml(r.text)) {
      return result('warn', 'medium', [ev, 'the response is an HTML page (deployment protection/WAF?), not your handler'], 'Exclude the webhook path from deployment protection / bot challenges, or Stripe deliveries will be blocked too.');
    }
    return result(
      'warn',
      'high',
      [ev, 'the body is not HTML, so this may be your handler rejecting the unsigned event — or an auth wall (login/auth middleware, deployment protection, Supabase verify_jwt) rejecting every real delivery too'],
      'Confirm Stripe can reach the route: no login/auth middleware and no deployment protection on it (Supabase Edge Functions: set `verify_jwt = false` in supabase/config.toml) and the handler itself returns 400 when signature verification fails (Stripe counts 401/403 as failed deliveries). If the handler intentionally returns 403 for invalid signatures, this warning is expected.',
    );
  }
  return pass([ev]);
}

/** The payments provider has an enabled endpoint for the production URL with every configured event. */
export const webhookRegisteredCheck: Check = {
  id: 'webhook-registered',
  title: 'Webhook endpoint is registered for production',
  severity: 'high',
  applies: (ctx) => Boolean(ctx.config.payments?.webhook && ctx.config.stack.payments),
  async run(ctx) {
    const registry = cap(ctx, 'payments', 'webhooks');
    if (!registry) return skip(`payments provider ${ctx.config.stack.payments} has no webhook capability (guided)`);
    const pre = await prereq(ctx, 'payments');
    if (pre) return pre;
    const expected = await registeredUrl(ctx);
    if (!expected) return blocked('deploy:production', 'no production URL yet');
    const mode = modeFor(ctx.config, 'production');
    const want = ctx.config.payments?.webhook?.events ?? [];

    let endpoints: Array<{ id: string; url: string; events: string[]; enabled: boolean }>;
    let match: typeof endpoints;
    try {
      if (registry.find) {
        // Same matching rule the webhook link uses when it adopts an endpoint.
        const found = await registry.find(ctx, expected, mode);
        // A trailing-slash difference is a redirect, and Stripe does not follow redirects.
        match = found && found.url.endsWith('/') === expected.endsWith('/') ? [found] : [];
        endpoints = found ? [found] : await registry.list(ctx, mode);
      } else {
        endpoints = await registry.list(ctx, mode);
        // Exact match: a trailing-slash or host mismatch means a redirect, and Stripe does not follow redirects.
        match = endpoints.filter((e) => e.url === expected);
      }
    } catch (e) {
      return result('fail', 'high', [`could not list ${mode}-mode webhook endpoints: ${errMsg(e)}`], 'Re-run verify; if it persists, check the Stripe login with `golive doctor`.');
    }
    if (!match.length) {
      const others = endpoints.map((e) => e.url).slice(0, 5);
      return result('fail', 'high', [`no ${mode}-mode endpoint for ${expected}`, ...(others.length ? [`existing endpoints: ${others.join(', ')}`] : [])], ctx.config.stack.hosting && !ctx.adapters.some((a) => a.id === ctx.config.stack.hosting) ? `Your host is guided, so the endpoint is created by hand: follow the \`${ctx.config.stack.payments}:webhook-guided\` item in \`handoff --json\`.` : 'Run `golive plan` and apply the payments-webhook step for production.');
    }
    const enabled = match.find((e) => e.enabled);
    if (!enabled) return result('fail', 'high', [`${mode}-mode endpoint ${match[0]!.id} for ${expected} is disabled`], 'Enable the endpoint in the Webhooks tab in Workbench, then re-run verify.');
    const missing = enabled.events.includes('*') ? [] : want.filter((ev) => !enabled.events.includes(ev));
    if (missing.length) {
      return result('fail', 'high', [`${mode}-mode endpoint ${enabled.id} is missing events: ${missing.join(', ')}`], 'Re-run `golive plan` / apply to update the endpoint\'s events.');
    }
    return pass([`${mode}-mode endpoint ${enabled.id} → ${expected} (enabled, ${want.length} event(s) covered)`]);
  },
};
