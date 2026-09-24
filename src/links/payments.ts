import type { Link } from '../core/plan.js';
import { modeFor } from '../core/config.js';
import { tokenHowTo } from '../core/credentials.js';
import { Secret, fingerprint } from '../core/secret.js';
import type { Adapter, Ctx, EnvStore, EnvTarget, HandoffItem, Mode, OutputKey, OutputsProvider, PaymentAccount, PaymentAccountIdentity, Step, Value, WebhookRegistry } from '../core/types.js';
import { availableKeys, axisStatus, intentOf, projectIntent, decideEnv, deps, envPreview, envSourceKey, errMsg, isManaged, joinUrl, lastDeployAt, memo, namesFor, observeNames, productionUrl, ready, secretBlocked, step, track, verifyEnvWritten, writeEnv, writesProduction } from './util.js';

type Target = Exclude<EnvTarget, 'development'>;
interface Host {
  adapter: Adapter;
  env: EnvStore;
}

function accountCapability(adapter: Adapter): PaymentAccount {
  const account = adapter.capabilities.paymentAccount;
  if (!account) throw new Error(`${adapter.title} cannot establish an exact payment account for approval; automatic payment writes are unavailable.`);
  return account;
}
const accountIntent = (account: PaymentAccountIdentity): string => `${account.mode}|${account.accountId}|${account.operatorFingerprint}`;
const accountPreview = (adapter: Adapter, account: PaymentAccountIdentity): string => `${adapter.title} ${account.mode} account: ${account.accountId} (operator fingerprint ${account.operatorFingerprint.slice(0, 12)})`;

/**
 * Payments provider (Stripe or anything with outputs + webhooks) → host env + host URL:
 * API keys per target, the production webhook endpoint + its signing secret, and live-mode gating.
 */
export const paymentsLink: Link = {
  id: 'payments',
  async plan(ctx) {
    const pay = await axisStatus(ctx, 'payments');
    if (pay.kind !== 'ready' && pay.kind !== 'unauthed') return null;
    const adapter = pay.adapter;
    const { outputs, webhooks } = adapter.capabilities;
    if (!outputs && !webhooks) return null;

    const steps: Step[] = [];
    const handoffs: HandoffItem[] = [];
    const warnings: string[] = [];
    const prod = ctx.config.targets.includes('production');
    if (prod && modeFor(ctx.config, 'production') === 'live') {
      handoffs.push({
        id: `${adapter.id}:activate`,
        why: `${adapter.title} only accepts live payments once the account is activated.`,
        action: `Activate your ${adapter.title} account (business details + identity verification) in its dashboard to accept live payments.`,
        blocking: true,
        verifiedBy: `${adapter.id}-live-ready`,
      });
    }
    if (prod && modeFor(ctx.config, 'production') === 'test') warnings.push(`production uses ${adapter.title} test mode (payments.modes.production: test): no real charges will happen`);
    if (pay.kind === 'unauthed') return { steps, handoffs, warnings };

    const hosting = await axisStatus(ctx, 'hosting');
    if (hosting.kind === 'guided') {
      // golive can't write the host's env, so it must not create an endpoint whose signing secret it
      // could only lose (revealed once, never passed through chat): the human registers it instead.
      // The keys per target (and their mode) are in the env:<target> handoffs.
      if (prod && ctx.config.payments?.webhook) handoffs.push(await guidedWebhookHandoff(ctx, adapter, hosting.title));
      return { steps, handoffs, warnings };
    }
    const h = await ready(ctx, 'hosting', 'env');
    if (!h) return { steps, handoffs, warnings };
    const host: Host = { adapter: h.adapter, env: h.cap };

    if (outputs) {
      for (const target of ctx.config.targets) {
        const r = await keysStep(ctx, adapter, outputs, host, target);
        if (r.step) steps.push(r.step);
        for (const ho of r.handoffs) if (!handoffs.some((x) => x.id === ho.id)) handoffs.push(ho);
      }
    }
    if (webhooks && prod) {
      const r = await webhookStep(ctx, adapter, webhooks, host);
      if (r.step) steps.push(r.step);
      handoffs.push(...r.handoffs);
      warnings.push(...r.warnings);
    }
    return { steps: track(ctx, steps, { needsRedeploy: writesProduction }), handoffs, warnings };
  },
};

type Fp = Partial<Record<OutputKey, string>>;

/**
 * Fingerprints of the values the provider would hand out now (in-process; values are dropped at
 * once). They identify the account/key behind a managed name, so logging into another account or
 * rotating a key rewrites it. null = can't read them now (then state is trusted as is).
 */
async function valueFingerprints(ctx: Ctx, outputs: OutputsProvider, target: Target): Promise<Fp | null> {
  try {
    const out = await outputs.outputs(ctx, target);
    const fp: Fp = {};
    for (const [k, v] of Object.entries(out) as Array<[OutputKey, Value | undefined]>) if (v) fp[k] = v instanceof Secret ? v.fingerprint : fingerprint(v);
    return fp;
  } catch {
    return null;
  }
}

// ── API keys ──────────────────────────────────────────────────────────────────────────────────────

async function keysStep(ctx: Ctx, adapter: Adapter, outputs: OutputsProvider, host: Host, target: Target): Promise<{ step?: Step; handoffs: HandoffItem[] }> {
  const handoffs: HandoffItem[] = [];
  const mode = modeFor(ctx.config, target);
  const wantKeys: OutputKey[] = ['stripe.secretKey', 'stripe.publishableKey'];
  const byKey = new Map(wantKeys.map((k) => [k, namesFor(ctx, k)] as const));
  if (wantKeys.every((k) => byKey.get(k)!.length === 0)) return { handoffs };

  const accountCap = accountCapability(adapter);
  const account = await accountCap.identify(ctx, mode);

  const available = await availableKeys(ctx, outputs, target);
  const present = await observeNames(ctx, host.env, target, memo(ctx).pendingProjects.has('hosting'));
  const keyOf = new Map<string, OutputKey>();
  for (const [key, names] of byKey) {
    if (!names.length) continue;
    if (available && !available.has(key)) {
      const unset = names.filter((n) => !present?.has(n));
      if (unset.length) handoffs.push(missingKeyHandoff(adapter, host, key, mode, unset));
      continue;
    }
    for (const n of names) if (!secretBlocked(ctx, n, key)) keyOf.set(n, key); // blocked: see the secrets:exposed handoff
  }
  // Only managed names can need an identity comparison; don't read keys when nothing is managed.
  const needFp = [...keyOf.keys()].some((n) => present?.has(n) && isManaged(ctx, n, target));
  const planFp = needFp ? await valueFingerprints(ctx, outputs, target) : {};
  const sourceAt = (name: string, fp: Fp | null): string => {
    const key = keyOf.get(name)!;
    if (fp === null) return ctx.state.resource(envSourceKey(name, target)) ?? `${key}|${adapter.id}|${mode}|?|${account.accountId}`;
    return `${key}|${adapter.id}|${mode}|${fp[key] ?? ''}|${account.accountId}`;
  };
  const decision = decideEnv(ctx, target, [...keyOf.keys()], present, (n) => sourceAt(n, planFp));
  if (!decision.write.length) return { handoffs };
  // Which key (fingerprint, mode, account) each write takes, and which host project it goes to: a
  // second rotation has the same preview text but must still run (see Step.intent).
  const writesAppKey = decision.write.some((w) => keyOf.get(w.name) === 'stripe.secretKey');
  const boundPlan = await accountCap.bind(ctx, account, { appKey: writesAppKey });
  const intentFp = await valueFingerprints(boundPlan, outputs, target);
  if (intentFp === null || decision.write.some((w) => !intentFp[keyOf.get(w.name)!])) throw new Error(`Cannot establish the exact ${adapter.title} ${mode} keys for approval. Resolve the key access problem and run plan again.`);
  const intent = intentOf({ host: await projectIntent(ctx, host.adapter), account: accountIntent(account), write: decision.write.map((w) => `${w.name}=${sourceAt(w.name, intentFp)}`) });

  let written: string[] = [];
  return {
    handoffs,
    step: step({
      id: `payments:keys:${target}`,
      title: `Set ${adapter.title} ${mode} keys for ${target} on ${host.adapter.title}`,
      kind: 'wire',
      risk: { writes: true, ...(mode === 'live' ? { live: true } : {}) },
      dependsOn: deps(ctx, ['project:hosting']),
      preview: [accountPreview(adapter, account), ...envPreview(decision, (n) => `${keyOf.get(n)} (${mode} mode)${keyOf.get(n) === 'stripe.secretKey' ? ' (sensitive)' : ''}`)],
      intent,
      async run(runCtx) {
        const sctx = await accountCap.bind(runCtx, account, { appKey: writesAppKey });
        let outs;
        try {
          outs = await outputs.outputs(sctx, target);
        } catch (e) {
          throw new Error(`reading ${adapter.title} ${mode} keys failed: ${errMsg(e)}`);
        }
        const runFp: Fp = {};
        for (const [k, v] of Object.entries(outs) as Array<[OutputKey, Value | undefined]>) if (v) runFp[k] = v instanceof Secret ? v.fingerprint : fingerprint(v);
        const entries: Array<{ name: string; key: OutputKey; value: Value; source: string }> = [];
        for (const w of decision.write) {
          const key = keyOf.get(w.name)!;
          const value = outs[key];
          if (!value) throw new Error(`${adapter.title} returned no ${key} for ${mode} mode, needed for ${w.name} (${target}). ${keyFix(adapter, key, mode)}`);
          if (runFp[key] !== intentFp[key]) throw new Error(`${adapter.title} ${mode} key material changed since approval; no env write was performed. Run plan again and approve the new keys.`);
          entries.push({ name: w.name, key, value, source: sourceAt(w.name, runFp) });
        }
        const r = await writeEnv(sctx, host.env, target, entries, decision.recheck);
        written = r.written;
        return { changes: r.changes };
      },
      verifyInline: (vctx) => verifyEnvWritten(vctx, host.env, target, written, `payments:keys:${target}`, host.adapter.title),
    }),
  };
}

/** Env var golive reads the provider's secret key from, e.g. STRIPE_LIVE_SECRET_KEY. */
const secretKeyEnv = (adapter: Adapter, mode: Mode): string => `${adapter.id.toUpperCase().replace(/-/g, '_')}_${mode.toUpperCase()}_SECRET_KEY`;

function keyFix(adapter: Adapter, key: OutputKey, mode: Mode): string {
  if (key === 'stripe.publishableKey') {
    return (
      `Ask the human for the ${mode}-mode publishable key (pk_${mode}_…, from the ${adapter.title} dashboard's API keys page). ` +
      `It is public (it ships in the browser bundle), so the human may paste it in chat — but never a secret key (sk_…, rk_…, whsec_…). ` +
      `Then run \`init --stripe-publishable ${mode}=pk_${mode}_…\` and \`plan\` again.`
    );
  }
  return `Copy the ${mode}-mode STANDARD secret key (sk_…) from the ${adapter.title} dashboard's API keys page. ${tokenHowTo(secretKeyEnv(adapter, mode))} If ${secretKeyEnv(adapter, mode)} already holds a restricted key (rk_…) for golive itself, put the app's standard key in ${secretKeyEnv(adapter, mode).replace(/_(TEST|LIVE)_/, '_APP_$1_')} instead — a restricted operator key is never copied into your app. Then run \`plan\` again.`;
}

function missingKeyHandoff(adapter: Adapter, host: Host, key: OutputKey, mode: Mode, names: string[]): HandoffItem {
  const pk = key === 'stripe.publishableKey';
  return {
    id: `${adapter.id}:${pk ? 'publishable' : 'secret'}-key:${mode}`,
    why: `golive has no ${adapter.title} ${mode} ${pk ? 'publishable' : 'secret'} key to put into ${names.join(', ')}.`,
    action: `${keyFix(adapter, key, mode)} Or the human adds ${names.join(', ')} to ${host.adapter.title} themselves, straight from the ${adapter.title} dashboard.`,
    blocking: true,
    verifiedBy: 'env-parity',
  };
}

// ── Production webhook ────────────────────────────────────────────────────────────────────────────

type Endpoint = { id: string; url: string; events: string[]; enabled: boolean; owned?: boolean };

/** The endpoint ensure() would adopt for `url`: the registry's own read-only matcher when it has one. */
async function findEndpoint(ctx: Ctx, wh: WebhookRegistry, url: string, mode: Mode): Promise<Endpoint | null> {
  if (wh.find) return wh.find(ctx, url, mode);
  return (await wh.list(ctx, mode)).find((e) => e.url === url) ?? null;
}

/** State key remembering the endpoint whose signing secret golive last stored. */
const endpointKey = (adapter: Adapter, mode: Mode): string => `${adapter.id}.${mode}.webhookEndpointId`;

/** Env source recorded with the signing secret: which endpoint (and mode) it belongs to. Never the value. */
export const webhookSource = (adapter: Adapter, mode: Mode, endpointId: string): string => `stripe.webhookSecret|${adapter.id}|${mode}|${endpointId}`;

const normUrl = (u: string): string => u.trim().replace(/\/+$/, '').toLowerCase();

/**
 * Is the managed secret behind every name provably the signing secret of endpoint `id` in `mode`?
 * Name present + golive-managed is not enough: after a mode or URL round trip the name holds the OTHER
 * endpoint's secret. State from before endpoint ids were recorded counts only when the remembered
 * endpoint is this one and the recorded mode matches.
 */
function secretIsFor(ctx: Ctx, adapter: Adapter, mode: Mode, names: string[], present: Set<string> | null, id: string): boolean {
  if (!present) return false;
  const want = webhookSource(adapter, mode, id);
  const legacy = `stripe.webhookSecret|${adapter.id}|${mode}`;
  return names.every((n) => {
    if (!present.has(n) || !isManaged(ctx, n, 'production')) return false;
    const src = ctx.state.resource(envSourceKey(n, 'production'));
    return src === want || (src === legacy && ctx.state.resource(endpointKey(adapter, mode)) === id);
  });
}

/** Reasons (per name) the host would refuse to store the signing secret, via EnvStore.canSet. */
async function envRefusals(ctx: Ctx, env: EnvStore, names: string[], strict: boolean): Promise<string[]> {
  if (!env.canSet) return [];
  const out: string[] = [];
  for (const n of names) {
    try {
      const why = await env.canSet(ctx, n, ['production']);
      if (why) out.push(`${n}: ${why}`);
    } catch (e) {
      // Planning: can't tell, so run() asks again. Applying: refuse rather than risk losing the secret.
      if (strict) out.push(`${n}: could not confirm it can be written (${errMsg(e)})`);
    }
  }
  return out;
}

function webhookNames(ctx: Ctx): { names: string[]; defaulted: boolean } {
  const names = namesFor(ctx, 'stripe.webhookSecret');
  return names.length ? { names, defaulted: false } : { names: ['STRIPE_WEBHOOK_SECRET'], defaulted: true };
}

/** Guided host: the human registers the endpoint and carries its secret dashboard to dashboard. */
async function guidedWebhookHandoff(ctx: Ctx, adapter: Adapter, hostTitle: string): Promise<HandoffItem> {
  const cfg = ctx.config.payments!.webhook!;
  const mode = modeFor(ctx.config, 'production');
  const base = await productionUrl(ctx);
  const url = base ? joinUrl(base, cfg.path) : `<your production URL>${cfg.path.startsWith('/') ? '' : '/'}${cfg.path}`;
  const { names } = webhookNames(ctx);
  return {
    id: `${adapter.id}:webhook-guided`,
    why: `${hostTitle} isn't automated by golive, so golive can't store a webhook signing secret there, and ${adapter.title} reveals it only once, when the endpoint is created.`,
    action:
      `In ${adapter.title}'s dashboard (the Webhooks tab in Workbench, ${mode} mode), the human adds an endpoint at ${url} for these events: ${cfg.events.join(', ')}. ` +
      `They copy its signing secret (whsec_…) straight into ${hostTitle}'s Production env as ${names.join(', ')}, never through this chat (it is production-only: not in preview). ` +
      `Make sure nothing blocks POSTs to ${cfg.path} (password protection, auth middleware, bot challenges), then redeploy production in ${hostTitle} and run \`verify\`.`,
    blocking: true,
    verifiedBy: 'webhook-registered',
  };
}

async function webhookStep(ctx: Ctx, adapter: Adapter, wh: WebhookRegistry, host: Host): Promise<{ step?: Step; handoffs: HandoffItem[]; warnings: string[] }> {
  const warnings: string[] = [];
  const handoffs: HandoffItem[] = [];
  const cfg = ctx.config.payments?.webhook;
  if (!cfg) return { handoffs, warnings };
  if (ctx.config.targets.includes('preview')) warnings.push(`${adapter.title} webhooks are registered for production only: preview URLs change with every deployment`);

  const base = await productionUrl(ctx);
  if (!base) {
    warnings.push(
      `${adapter.title} webhook: the production URL isn't known yet (no domain, and ${lastDeployAt(ctx) ? 'the host reports no production URL' : "golive hasn't deployed production yet, so the host's URL isn't confirmed"}). Apply this plan, then run \`plan\` again to register the webhook.`,
    );
    return { handoffs, warnings };
  }
  const url = joinUrl(base, cfg.path);
  const mode = modeFor(ctx.config, 'production');
  const accountCap = accountCapability(adapter);
  const account = await accountCap.identify(ctx, mode);
  const { names, defaulted } = webhookNames(ctx);
  if (defaulted) warnings.push(`the code references no webhook signing secret env var; golive will write STRIPE_WEBHOOK_SECRET (production)`);
  const blocked = names.filter((n) => secretBlocked(ctx, n, 'stripe.webhookSecret'));
  if (blocked.length) {
    // Creating the endpoint without writing its secret would lose the secret (revealed only once).
    warnings.push(`${adapter.title} webhook left out of this plan: ${blocked.join(', ')} would be exposed in the browser bundle (see the secrets:exposed handoff)`);
    return { handoffs, warnings };
  }

  let existing: Endpoint | null;
  try {
    existing = await findEndpoint(ctx, wh, url, mode);
  } catch (e) {
    warnings.push(`reading ${adapter.title} ${mode} webhook endpoints failed (${errMsg(e)}); webhook left out of this plan`);
    return { handoffs, warnings };
  }
  const hostPending = memo(ctx).pendingProjects.has('hosting');
  const present = await observeNames(ctx, host.env, 'production', hostPending);
  const secretInPlace = existing !== null && secretIsFor(ctx, adapter, mode, names, present, existing.id);
  const sameEvents = existing && [...existing.events].sort().join(',') === [...cfg.events].sort().join(',');
  if (existing && existing.enabled && sameEvents && secretInPlace) return { handoffs, warnings };

  const replace = Boolean(existing && !secretInPlace);
  if (replace && !wh.replace) {
    handoffs.push({
      id: `${adapter.id}:webhook-secret`,
      why: `A ${adapter.title} webhook endpoint for ${url} exists, but its signing secret is only revealed at creation and golive doesn't have it.`,
      action: `The human copies the endpoint's signing secret from the ${adapter.title} dashboard straight into ${host.adapter.title} as ${names.join(', ')} (production), or deletes that endpoint so golive can create a fresh one; then run \`plan\` again.`,
      blocking: true,
      verifiedBy: 'webhook-registered',
    });
    return { handoffs, warnings };
  }
  /** This step creates an endpoint and must store its (once-revealed) signing secret. */
  const writes = !existing || replace;

  // Refuse BEFORE creating anything if the host would reject the secret (shared-target row,
  // integration-owned var, production vars hidden from this token): the secret would be lost and a
  // new orphan endpoint left behind on every re-run.
  if (writes && present !== null) {
    const refusals = await envRefusals(ctx, host.env, names, false);
    if (refusals.length) {
      handoffs.push({
        id: `${adapter.id}:webhook-env`,
        why: `${host.adapter.title} would refuse to store the webhook signing secret (${refusals.join('; ')}), and ${adapter.title} reveals it only once, so golive won't create the endpoint yet.`,
        action: `Fix the ${names.join(', ')} variable in ${host.adapter.title} so golive can write it for production only (e.g. split a variable shared by several environments into one per environment, or remove the integration-managed one), then run \`plan\` again.`,
        blocking: true,
      });
      return { handoffs, warnings };
    }
  }

  // The endpoint golive stored a secret for before, if it serves an OLD production URL (e.g. the host
  // URL before a custom domain was added): once the new secret is stored its deliveries can only fail
  // signature checks, so it is deleted (only if golive created it).
  let stale: Endpoint | null = null;
  const prevId = ctx.state.resource(endpointKey(adapter, mode));
  if (writes && prevId && prevId !== existing?.id) {
    try {
      const prev = (await wh.list(ctx, mode)).find((e) => e.id === prevId);
      if (prev && prev.owned !== false && normUrl(prev.url) !== normUrl(url)) stale = prev;
    } catch {
      // Can't read it now: leave it (the next plan looks again).
    }
  }

  const events = cfg.events.join(', ');
  const preview: string[] = [accountPreview(adapter, account)];
  if (existing) {
    preview.push(`ensure ${mode} webhook endpoint ${existing.id} → ${url} (events: ${events})`);
    if (existing.owned === false) preview.push(`endpoint ${existing.id} was not created by golive: its existing events are kept and missing ones added`);
    if (!existing.enabled) preview.push(`re-enable endpoint ${existing.id} (currently disabled)`);
  } else {
    preview.push(`create ${mode} webhook endpoint → ${url} (events: ${events})`);
  }
  if (existing && replace) {
    const old =
      existing.owned === true
        ? `then delete ${existing.id}`
        : existing.owned === false
          ? `then leave ${existing.id} in place for you to delete in the ${adapter.title} dashboard (golive didn't create it; until then ${adapter.title} delivers events to both)`
          : `then delete ${existing.id} if golive created it (otherwise it is left for you to delete)`;
    preview.push(
      `replace endpoint ${existing.id}${present === null ? ' if its signing secret is not already in ' + host.adapter.title : ''}: golive has no copy of its signing secret for this endpoint (it is only revealed at creation), so create a new endpoint with the same URL/events, write its secret, ${old}`,
    );
  }
  for (const n of writes ? names : []) {
    const unmanaged = present?.has(n) && !isManaged(ctx, n, 'production');
    preview.push(`${unmanaged ? 'overwrite (currently set, not by golive)' : 'set'} ${n} (production) ← signing secret of the new endpoint (sensitive)`);
  }
  if (stale) preview.push(`then delete old endpoint ${stale.id} (${stale.url}), which golive created for the previous production URL (its deliveries would fail signature checks once the new secret is stored)`);
  const intent = intentOf({ host: await projectIntent(ctx, host.adapter), account: accountIntent(account), mode, url, endpoint: existing?.id ?? 'new', replace: String(replace), stale: stale?.id, names });

  let written: string[] = [];
  const step_ = step({
    id: 'payments:webhook:production',
    title: `Register ${adapter.title} webhook for production`,
    kind: 'wire',
    risk: { writes: true, ...(mode === 'live' ? { live: true } : {}) },
    dependsOn: deps(ctx, ['project:hosting', ...(ctx.config.domain ? ['domain:dns'] : [])]),
    preview,
    intent,
    verifyWith: ['webhook-registered'],
    async run(runCtx) {
      const sctx = await accountCap.bind(runCtx, account);
      // Refuse (before writing anything) if ensure() would now adopt a different endpoint than the plan showed.
      if (wh.find) {
        const now = await wh.find(sctx, url, mode);
        if ((now?.id ?? null) !== (existing?.id ?? null)) {
          throw new Error(`the ${adapter.title} ${mode} webhook endpoints for ${url} changed since the plan was approved (planned: ${existing?.id ?? 'none'}, now: ${now?.id ?? 'none'}); nothing was changed. Run \`plan\` again and approve the new plan.`);
        }
      }
      if (writes) {
        const refusals = await envRefusals(sctx, host.env, names, true);
        if (refusals.length) {
          throw new Error(`${host.adapter.title} would refuse to store the webhook signing secret (${refusals.join('; ')}); no endpoint was created. Fix the variable in ${host.adapter.title}, then run \`plan\` again.`);
        }
      }
      const res = await wh.ensure(sctx, { url, events: cfg.events, mode });
      const changes = [`${res.created ? 'created' : 'adopted'} ${mode} webhook endpoint ${res.id} → ${url}`];
      let secret = res.secret;
      let endpointId = res.id;
      let oldToRemove: { oldId: string; newId: string } | undefined;
      if (!secret) {
        const now = new Set(await host.env.listNames(sctx, 'production'));
        if (secretIsFor(sctx, adapter, mode, names, now, res.id)) {
          sctx.remember(endpointKey(adapter, mode), res.id);
          return { changes: [...changes, `signing secret for ${res.id} already in ${host.adapter.title} (${names.join(', ')})`] };
        }
        if (!replace || !wh.replace) {
          throw new Error(`webhook endpoint ${res.id} exists but its signing secret isn't in ${host.adapter.title} (production), and this plan didn't include replacing it. Run \`plan\` again and approve the replacement.`);
        }
        // Create the replacement but keep the old endpoint until its secret is safely on the host:
        // if the env write fails, the app still has a working (old) webhook.
        const r = await wh.replace(sctx, res.id, mode, { deleteOld: false });
        if (!r.secret) throw new Error(`${adapter.title} replaced endpoint ${res.id} with ${r.id} but returned no signing secret; delete ${r.id} in the dashboard and re-run apply.`);
        secret = r.secret;
        endpointId = r.id;
        oldToRemove = { oldId: res.id, newId: r.id };
      }
      const s = secret;
      try {
        const w = await writeEnv(sctx, host.env, 'production', names.map((name) => ({ name, key: 'stripe.webhookSecret' as const, value: s, source: webhookSource(adapter, mode, endpointId) })), false);
        written = w.written;
        changes.push(...w.changes);
      } catch (e) {
        // The secret is lost with this failure, so the endpoint just created is useless: remove it
        // rather than leave an orphan that receives every event and fails every signature check.
        const rm = wh.remove ? await wh.remove(sctx, endpointId, mode).catch((x: unknown) => ({ deleted: false, reason: errMsg(x) })) : { deleted: false, reason: 'provider cannot delete endpoints' };
        const left = rm.deleted ? `it was deleted again, so nothing is left behind` : `it was left in place (${rm.reason ?? 'not deleted'}): delete ${endpointId} in the ${adapter.title} dashboard`;
        const kept = oldToRemove ? ` The previous endpoint ${oldToRemove.oldId} was kept.` : '';
        throw new Error(`created ${mode} webhook endpoint ${endpointId} but storing its signing secret in ${host.adapter.title} failed (${errMsg(e)}); ${left}.${kept} Fix the ${host.adapter.title} variable, then run \`plan\` again.`);
      }
      sctx.remember(endpointKey(adapter, mode), endpointId);
      if (oldToRemove) {
        const { oldId, newId } = oldToRemove;
        const rm = wh.remove ? await wh.remove(sctx, oldId, mode) : { deleted: false, reason: 'provider cannot delete endpoints' };
        changes.push(
          rm.deleted
            ? `replaced webhook endpoint ${oldId} with ${newId} (old endpoint deleted)`
            : `replaced webhook endpoint ${oldId} with ${newId}; the old endpoint ${oldId} was left in place (${rm.reason ?? 'not deleted'}): delete it in the ${adapter.title} dashboard — until then ${adapter.title} also delivers events to it, and those deliveries fail signature checks`,
        );
      }
      if (stale) {
        const rm = wh.remove ? await wh.remove(sctx, stale.id, mode).catch((x: unknown) => ({ deleted: false, reason: errMsg(x) })) : { deleted: false, reason: 'provider cannot delete endpoints' };
        changes.push(
          rm.deleted
            ? `deleted old endpoint ${stale.id} (${stale.url}) for the previous production URL`
            : `the old endpoint ${stale.id} (${stale.url}) was left in place (${rm.reason ?? 'not deleted'}): delete it in the ${adapter.title} dashboard — its deliveries fail signature checks now`,
        );
      }
      return { changes };
    },
    verifyInline: (vctx) => verifyEnvWritten(vctx, host.env, 'production', written, 'payments:webhook:production', host.adapter.title),
  });
  return { step: step_, handoffs, warnings };
}
