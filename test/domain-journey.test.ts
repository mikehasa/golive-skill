/**
 * Journey-level regressions for the custom-domain flow (the Cloudflare-first graduation): the full
 * plan → apply → verify chain, the guided-DNS handoff loop the human closes, and interruption/resume
 * of a half-written DNS step. Offline only: fake providers plus mocked DoH/HTTPS.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { buildPlan } from '../src/core/plan.js';
import { applyPlan } from '../src/core/runner.js';
import { _resetSecretRegistry } from '../src/core/secret.js';
import { domainLiveCheck } from '../src/checks/domain.js';
import { ALL_LINKS } from '../src/links/all.js';
import type { Ctx, Plan, ShipConfig } from '../src/core/types.js';
import { mockHttp, testCtx } from './helpers.js';
import { dohRoute } from './check-fakes.js';
import { fakeWorld, type FakeWorld } from './fakes.js';

beforeEach(() => _resetSecretRegistry());

const DOMAIN_CONFIG: Partial<ShipConfig> = { stack: { hosting: 'fakehost', dns: 'fakedns' }, domain: 'example.com' };

function setup(config: Partial<ShipConfig> = DOMAIN_CONFIG, arrange?: (w: FakeWorld) => void) {
  const w = fakeWorld();
  arrange?.(w);
  const ctx = testCtx({ cwd: '/work/app', adapters: w.adapters, config, detect: { envRefs: [] } });
  return { w, ctx };
}

const build = (ctx: Ctx) => buildPlan(ctx, ALL_LINKS, { unmappedEnv: [], warnings: [] });
const apply = (ctx: Ctx, plan: Plan) => applyPlan(ctx, plan, new Map(), { approvedPlanId: plan.id, yes: true, confirmLive: true, confirmDns: true });
const statusOf = (out: Awaited<ReturnType<typeof apply>>, id: string) => out.find((o) => o.id === id)?.status;

describe('custom-domain journey: plan → apply → verify', () => {
  it('applies deploy → attach → dns → verify, and domain-live passes once DNS/TLS/the host agree', async () => {
    const { w, ctx } = setup();
    const plan = await build(ctx);
    const ids = plan.steps.map((s) => s.id);
    expect(ids.indexOf('deploy:production')).toBeLessThan(ids.indexOf('domain:attach')); // attach waits for the first deploy
    expect(ids.indexOf('domain:attach')).toBeLessThan(ids.indexOf('domain:dns'));
    expect(ids.indexOf('domain:dns')).toBeLessThan(ids.indexOf('domain:verify'));

    const out = await apply(ctx, plan);
    expect(out.map((o) => [o.id, o.status])).toEqual(plan.steps.map((s) => [s.id, 'done']));
    expect(w.host.deploys).toBe(1);
    expect(w.host.attached).toEqual(['example.com']);
    expect(w.dns.records).toEqual([{ type: 'A', name: 'example.com', content: '76.76.21.21', proxied: false }]);
    // The DNS step verified its own writes against the zone (public probing stays with `verify`).
    expect(out.find((o) => o.id === 'domain:dns')!.checks).toEqual([expect.objectContaining({ id: 'domain:dns:records', status: 'pass' })]);

    // DNS propagates, TLS issues and the host confirms ownership: the same world now passes domain-live.
    w.host.domainStatus = 'ok';
    const { http } = mockHttp([
      dohRoute({ 'A example.com': ['76.76.21.21'] }),
      ['GET', 'https://example.com/', () => ({ status: 200, text: '<html>live</html>' })],
    ]);
    const r = await domainLiveCheck.run(testCtx({ http, adapters: w.adapters, config: ctx.config }));
    expect(r.status).toBe('pass');
    const evidence = r.evidence.join('\n');
    expect(evidence).toContain('A 76.76.21.21');
    expect(evidence).toContain('host reports domain ok');
    expect(evidence).toContain('GET https://example.com/ → HTTP 200');
  });

  it('guided DNS: a blocking handoff whose domain-live check passes once the human publishes the records', async () => {
    const { w, ctx } = setup({ stack: { hosting: 'fakehost', dns: 'fakeguided' }, domain: 'example.com' });
    const plan = await build(ctx);
    expect(plan.steps.map((s) => s.id)).not.toContain('domain:dns');
    const handoff = plan.handoffs.find((h) => h.id === 'domain:dns')!;
    expect(handoff).toMatchObject({ blocking: true, verifiedBy: 'domain-live' });
    expect(handoff.manual).toBeUndefined(); // not manual: a passing check is what closes it
    expect(handoff.action).toContain('A example.com = 76.76.21.21');

    // The human adds the records at their DNS host; propagation finishes and the host confirms.
    w.host.domainStatus = 'ok';
    const { http } = mockHttp([
      dohRoute({ 'A example.com': ['76.76.21.21'] }),
      ['GET', 'https://example.com/', () => ({ status: 301, text: '' })],
    ]);
    const r = await domainLiveCheck.run(testCtx({ http, adapters: w.adapters, config: ctx.config }));
    expect(r.status).toBe('pass'); // pass → done in the handoff status, so the handoff closes
  });

  it('resumes a failed DNS step without duplicating the record it already wrote', async () => {
    const { w, ctx } = setup(undefined, (x) => {
      x.host.records = [
        { type: 'A', name: 'example.com', content: '76.76.21.21' },
        { type: 'TXT', name: '_fakehost.example.com', content: 'fh-verify=zzz' },
      ];
    });
    const dnsCap = w.adapters.find((a) => a.id === 'fakedns')!.capabilities.dns!;
    const realUpsert = dnsCap.upsert.bind(dnsCap);
    const attempts: string[] = [];
    let failTxt = true;
    dnsCap.upsert = async (c, d, r) => {
      attempts.push(r.type);
      if (r.type === 'TXT' && failTxt) {
        failTxt = false;
        throw new Error('flake: 503 while writing the TXT record');
      }
      return realUpsert(c, d, r);
    };

    const plan = await build(ctx);
    const first = await apply(ctx, plan);
    expect(first.find((o) => o.id === 'domain:dns')).toMatchObject({ status: 'failed' });
    expect(first.find((o) => o.id === 'domain:dns')!.error).toMatch(/flake: 503/);
    expect(ctx.state.get().steps['domain:dns']!.status).toBe('failed');
    expect(w.dns.records).toEqual([{ type: 'A', name: 'example.com', content: '76.76.21.21', proxied: false }]);

    // The next invocation resumes at the failed step; the written record is re-checked, not duplicated.
    const again = await apply(ctx, await build(ctx));
    expect(statusOf(again, 'domain:dns')).toBe('done');
    expect(w.host.deploys).toBe(1); // the done deploy step was skipped, not repeated
    expect(w.dns.records).toEqual([
      { type: 'A', name: 'example.com', content: '76.76.21.21', proxied: false },
      { type: 'TXT', name: '_fakehost.example.com', content: 'fh-verify=zzz', proxied: false },
    ]);
    expect(attempts).toEqual(['A', 'TXT', 'A', 'TXT']); // the written A is re-checked (unchanged), the TXT is written once
  });

  it('an automated host without a domain capability hands off attachment instead of emitting domain steps', async () => {
    const { w, ctx } = setup(undefined, (x) => {
      delete x.adapters.find((a) => a.id === 'fakehost')!.capabilities.domain;
    });
    const plan = await build(ctx);
    expect(plan.steps.map((s) => s.id).filter((i) => i.startsWith('domain:'))).toEqual([]);
    const handoff = plan.handoffs.find((h) => h.id === 'domain:attach')!;
    expect(handoff).toMatchObject({ blocking: true, manual: true });
    expect(handoff.action).toContain('FakeHost');
    expect(handoff.action).toContain('example.com');
    expect(w.host.attached).toEqual([]);
  });
});
