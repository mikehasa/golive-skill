import type { Check, Ctx } from '../core/types.js';
import { modeFor } from '../core/config.js';
import { stripeCall } from '../adapters/stripe-api.js';
import { errMsg, pass, prereq, result, type CheckOutcome } from './util.js';

/** The event a live endpoint must subscribe to for a live payment to reach the app. */
const PAYMENT_EVENT = 'payment_intent.succeeded';

interface RawPaymentIntent {
  id?: string;
  livemode?: boolean;
  status?: string;
  amount_received?: number;
  currency?: string;
  created?: number;
}

interface RawEndpoint {
  id?: string;
  url?: string;
  livemode?: boolean;
  status?: string;
  enabled_events?: string[];
}

interface RawEvent {
  id?: string;
  pending_webhooks?: number;
  /** data.object is the PaymentIntent itself; a `payment_intent` reference covers a referencing shape. */
  data?: { object?: { id?: unknown; payment_intent?: unknown } };
}

interface RawRefund {
  id?: string;
  amount?: number;
  currency?: string;
  status?: string;
}

/** Bound every value that reaches evidence. */
const clip = (v: string, max = 200): string => (v.length > max ? `${v.slice(0, max)}…` : v);
const short = (v: string): string => clip(v, 32);
const num = (v: unknown): string => (typeof v === 'number' && Number.isFinite(v) ? String(v) : 'unknown');
const date = (v: unknown): string | null => (typeof v === 'number' && v > 0 && v < 4_000_000_000 ? new Date(v * 1000).toISOString().slice(0, 10) : null);

type Read<T> = { ok: true; data: T[] } | { ok: false; error: unknown };

/** One authenticated GET against the live account; the caller decides what a failure means. */
async function readList<T>(ctx: Ctx, path: string, what: string): Promise<Read<T>> {
  try {
    const res = await stripeCall<{ data?: T[] }>(ctx, 'live', { path, what });
    const data = res.json?.data;
    return { ok: true, data: Array.isArray(data) ? data : [] };
  } catch (error) {
    return { ok: false, error };
  }
}

const READ_PERMS_FIX =
  'On the Stripe Dashboard’s API keys page, grant the live operator key read access to PaymentIntents, Events, Webhook Endpoints and Refunds (a restricted key needs those Reads), or use the standard secret key; then re-run `verify`.';

/** 403 = the live key cannot read this (a restricted key without the Read permission): unknown, not failed. */
function readFailure(error: unknown, what: string): CheckOutcome {
  if ((error as { status?: number } | null)?.status === 403) {
    return result('warn', 'medium', [errMsg(error), `${what} is unknown, not failed: the live key lacks the read permission (HTTP 403)`], READ_PERMS_FIX);
  }
  return result('fail', 'high', [`could not read ${what}: ${errMsg(error)}`], 'Re-run verify; if it persists, check the Stripe login with `golive doctor`.');
}

/**
 * Read-only evidence that a real live payment was received AND reached the app: the most recent
 * succeeded live PaymentIntent, a live enabled endpoint subscribed to `payment_intent.succeeded`,
 * that event's delivery state, and any refund for the payment (reported, never required).
 *
 * Every call is a GET with the live OPERATOR key; this never makes a payment and never writes.
 */
export const stripeLivePaymentCheck: Check = {
  id: 'stripe-live-payment',
  title: 'A live payment was received and its webhook delivered',
  severity: 'medium',
  applies: (ctx) => ctx.config.stack.payments === 'stripe' && modeFor(ctx.config, 'production') === 'live',
  async run(ctx) {
    const pre = await prereq(ctx, 'payments', { project: false });
    if (pre) return pre;

    // Stripe lists newest first (created desc), so the first match is the most recent live payment.
    const intents = await readList<RawPaymentIntent>(ctx, '/v1/payment_intents?limit=100', 'list live-mode PaymentIntents');
    if (!intents.ok) return readFailure(intents.error, 'whether this account has a succeeded live payment');
    const pi = intents.data.find((p) => p.livemode === true && p.status === 'succeeded');
    if (!pi?.id) {
      return result(
        'warn',
        'medium',
        ['no succeeded live PaymentIntent found in this account'],
        'Complete one real live payment in the app — the smallest amount it can take; test-mode payments do not count, and golive never makes payments — then re-run `verify`.',
      );
    }
    const piId = pi.id;
    const when = date(pi.created);
    const evidence = [`most recent succeeded live PaymentIntent ${short(piId)}: amount_received ${num(pi.amount_received)} ${typeof pi.currency === 'string' ? pi.currency : 'unknown currency'}${when ? ` (created ${when})` : ''}`];

    const endpoints = await readList<RawEndpoint>(ctx, '/v1/webhook_endpoints?limit=100', 'list live-mode webhook endpoints');
    if (!endpoints.ok) return readFailure(endpoints.error, 'which live webhook endpoints exist');
    const endpoint = endpoints.data.find((e) => e.livemode === true && e.status === 'enabled' && ((e.enabled_events ?? []).includes('*') || (e.enabled_events ?? []).includes(PAYMENT_EVENT)));
    if (!endpoint) {
      return result(
        'warn',
        'medium',
        [...evidence, `no live-mode enabled webhook endpoint subscribes to ${PAYMENT_EVENT}`],
        'Register the live webhook endpoint (`golive plan` + apply the payments webhook link for production), then re-run `verify`.',
      );
    }
    evidence.push(`live webhook endpoint ${short(endpoint.id ?? 'unknown')} → ${clip(endpoint.url ?? 'no url')}`);

    const events = await readList<RawEvent>(ctx, `/v1/events?type=${PAYMENT_EVENT}&limit=100`, `list live-mode ${PAYMENT_EVENT} events`);
    if (!events.ok) return readFailure(events.error, `whether a ${PAYMENT_EVENT} event exists for this payment`);
    const event = events.data.find((e) => e.data?.object?.id === piId || e.data?.object?.payment_intent === piId);
    if (!event) {
      return result(
        'warn',
        'medium',
        [...evidence, `no ${PAYMENT_EVENT} event found for this payment`, 'Stripe retains events for about 30 days, so a payment older than that may no longer have one'],
        'If this payment is older than the retention window, complete a new live payment and re-run `verify`; otherwise confirm the live endpoint was subscribed when the payment happened.',
      );
    }
    // Stripe's Events object: `pending_webhooks` is the number of webhooks that "have yet to be
    // successfully delivered (i.e., to return a 20x response)" to the configured URLs — pending
    // retries and failed deliveries both count, so > 0 means the app has not acknowledged it.
    // A missing or nonsensical field is unknown, never 0: only a reported 0 may pass.
    const pending = event.pending_webhooks;
    if (typeof pending !== 'number' || !Number.isInteger(pending) || pending < 0) {
      return result(
        'warn',
        'medium',
        [...evidence, `${PAYMENT_EVENT} event ${short(event.id ?? 'unknown')} (pending_webhooks: not reported)`, 'the event exists, but its delivery state is unknown: an absent field is not evidence of a successful delivery'],
        'Re-run `verify`; if the field stays absent, confirm the live operator key has Events: Read (a restricted key can answer without it) and check the endpoint’s delivery attempts in the Dashboard.',
      );
    }
    evidence.push(`${PAYMENT_EVENT} event ${short(event.id ?? 'unknown')} (pending_webhooks: ${pending})`);
    if (pending > 0) {
      return result(
        'warn',
        'medium',
        [...evidence, `${pending} webhook deliver${pending === 1 ? 'y' : 'ies'} for this event ${pending === 1 ? 'is' : 'are'} pending or failed`],
        'Check the route that verifies the Stripe signature (it must read the raw body and return 2xx quickly; see the Stripe webhook notes) and the delivery attempts for the endpoint in the Dashboard, then re-run `verify`.',
      );
    }

    // Reported, never required: a failed refunds read degrades this line and the verdict, but the
    // payment and delivery evidence above stands.
    const refunds = await readList<RawRefund>(ctx, `/v1/refunds?payment_intent=${encodeURIComponent(piId)}&limit=1`, 'list live-mode refunds for this payment');
    if (!refunds.ok) {
      const denied = (refunds.error as { status?: number } | null)?.status === 403;
      return result(
        'warn',
        'medium',
        [...evidence, `could not read refunds for this payment (${denied ? 'the live key lacks Refunds: Read (HTTP 403)' : clip(errMsg(refunds.error))}); the payment and delivery evidence above is unaffected`],
        denied
          ? 'Grant the live operator key Refunds: Read (or use the standard secret key) to report refunds too, then re-run `verify`.'
          : 'Re-run verify; if the refunds read keeps failing, check the Stripe login with `golive doctor`. The payment evidence above stands.',
      );
    }
    const refund = refunds.data[0];
    evidence.push(
      refund
        ? `refund ${short(refund.id ?? 'unknown')}: ${num(refund.amount)} ${typeof refund.currency === 'string' ? refund.currency : 'unknown currency'} (${typeof refund.status === 'string' ? refund.status : 'unknown status'})`
        : 'no refund recorded for this payment (not required)',
    );
    return pass(evidence);
  },
};
