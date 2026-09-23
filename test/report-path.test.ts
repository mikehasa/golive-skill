import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Check, CheckResult, Report } from '../src/core/types.js';
import { detectFixture, mockExec, mockHttp, testCtx } from './helpers.js';
import { fakeWorld } from './fakes.js';
import { ALL_LINKS } from '../src/links/all.js';
import { applyPlan } from '../src/core/runner.js';

const mocks = vi.hoisted(() => ({ checks: [] as Check[], detect: vi.fn(), plan: vi.fn(), exec: vi.fn() }));
vi.mock('../src/core/exec.js', () => ({ exec: mocks.exec }));
vi.mock('../src/core/credentials.js', async (original) => ({
  ...await original<typeof import('../src/core/credentials.js')>(),
  credentialsStatus: () => ({ exists: false, private: null }),
}));
vi.mock('../src/detect/index.js', () => ({ detect: mocks.detect }));
vi.mock('../src/core/plan.js', async (original) => ({ ...await original<typeof import('../src/core/plan.js')>(), buildPlan: mocks.plan }));
vi.mock('../src/registry.js', async (original) => ({
  ...await original<typeof import('../src/registry.js')>(),
  ADAPTERS: [], CHECKS: mocks.checks, adapterFor: () => undefined, linkList: () => [],
  checkMap: () => new Map(mocks.checks.map((check) => [check.id, check])),
}));

let root: string;
const oldArgv = process.argv;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'golive-report-'));
  writeFileSync(join(root, 'golive.yaml'), JSON.stringify({ version: 1, stack: {}, targets: ['production'] }));
  vi.clearAllMocks();
  mocks.detect.mockResolvedValue(detectFixture());
  mocks.plan.mockResolvedValue({ handoffs: [] });
  mocks.exec.mockImplementation(() => { throw new Error('report tests must not run provider CLIs'); });
  mocks.checks.splice(0);
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('report tests must not use the network'); }));
});
afterEach(() => {
  process.argv = oldArgv;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  rmSync(root, { recursive: true, force: true });
});

function addCheck(id: string, status: CheckResult['status'], evidence: string) {
  const run = vi.fn(async (): Promise<CheckResult> => ({ id, title: `${id} check`, status, severity: 'high', evidence: [evidence] }));
  mocks.checks.push({ id, title: `${id} check`, severity: 'high', applies: () => true, run });
  return run;
}

async function runCli(args: string[]) {
  vi.resetModules();
  process.argv = ['node', 'golive', ...args, '--cwd', root, '--json'];
  const chunks: string[] = [];
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { chunks.push(String(chunk)); return true; });
  const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
  await import('../src/cli.js');
  await vi.waitFor(() => expect(exit).toHaveBeenCalled());
  const result = { output: chunks.join(''), code: exit.mock.calls.at(-1)?.[0] };
  stdout.mockRestore(); exit.mockRestore();
  return result;
}

describe('verify report paths', () => {
  it('retains a truly unknown host as an open guided handoff without authenticating or dispatching host writes', async () => {
    const stack = { hosting: 'unlisted-host-fixture' };
    writeFileSync(join(root, 'golive.yaml'), JSON.stringify({ version: 1, stack, targets: ['production'] }));
    const doctor = await runCli(['doctor']);
    expect(doctor.code).toBe(2);
    expect(JSON.parse(doctor.output)).toMatchObject({
      ok: false,
      providers: [{ axis: 'hosting', provider: stack.hosting, automated: false, ok: false }],
    });
    expect(mocks.plan).not.toHaveBeenCalled();

    // Exercise the real planner and runner with registered but unselected fake adapters. An
    // unknown choice must not silently fall back to an automated host or authenticate one.
    const world = fakeWorld();
    const auth = world.adapters.map((adapter) => (adapter.auth = vi.fn(adapter.auth)));
    const exec = mockExec([]);
    const http = mockHttp([]);
    const ctx = testCtx({ cwd: root, config: { stack, targets: ['production'] }, adapters: world.adapters, exec: exec.run, http: http.http });
    const { buildPlan } = await vi.importActual<typeof import('../src/core/plan.js')>('../src/core/plan.js');
    const plan = await buildPlan(ctx, ALL_LINKS, { unmappedEnv: [], warnings: [] });
    expect(plan.steps).toEqual([]);
    expect(plan.handoffs).toEqual([expect.objectContaining({ id: 'guided:hosting', blocking: false })]);
    expect(plan.handoffs[0]?.verifiedBy).toBeUndefined();
    mocks.plan.mockResolvedValue(plan);
    const handoff = await runCli(['handoff']);
    expect(JSON.parse(handoff.output).handoffs).toEqual([
      expect.objectContaining({ id: 'guided:hosting', done: false, evidence: [] }),
    ]);
    expect(await applyPlan(ctx, plan, new Map(), { approvedPlanId: plan.id, yes: true, confirmLive: false, confirmDns: false })).toEqual([]);
    expect(ctx.config.stack).toEqual(stack);
    expect(ctx.state.get().steps).toEqual({});
    expect(world.calls).toEqual([]);
    for (const authenticate of auth) expect(authenticate).not.toHaveBeenCalled();
    expect(exec.calls).toEqual([]);
    expect(http.calls).toEqual([]);
    expect(mocks.exec).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('writes GOLIVE_REPORT.md and the JSON source while leaving an existing old-named artifact untouched', async () => {
    const check = addCheck('first', 'pass', 'mock-only evidence');
    writeFileSync(join(root, 'SHIP_REPORT.md'), 'Existing artifact; do not rename or overwrite.');
    const result = await runCli(['verify']);
    const output = JSON.parse(result.output);
    expect(result.code).toBe(0);
    expect(output.reportPaths).toEqual({ json: join(root, '.golive/report.json'), markdown: join(root, 'GOLIVE_REPORT.md') });
    expect(readFileSync(output.reportPaths.markdown, 'utf8')).toContain('mock-only evidence');
    expect(JSON.parse(readFileSync(output.reportPaths.json, 'utf8'))).toEqual(output.report);
    expect(readFileSync(join(root, 'SHIP_REPORT.md'), 'utf8')).toBe('Existing artifact; do not rename or overwrite.');
    expect(check).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('reports only fresh --only evidence and never carries prior results into the current report', async () => {
    const first = addCheck('first', 'fail', 'old first failure');
    const second = addCheck('second', 'pass', 'retained second evidence');
    expect((await runCli(['verify'])).code).toBe(2);
    // Neither the old JSON nor either Markdown artifact can certify current check results.
    writeFileSync(join(root, 'GOLIVE_REPORT.md'), 'not JSON, not prior check state');
    writeFileSync(join(root, 'SHIP_REPORT.md'), '{"checks":[]}');
    first.mockResolvedValue({ id: 'first', title: 'first check', status: 'pass', severity: 'high', evidence: ['fresh first evidence'] });
    const result = await runCli(['verify', '--only', 'first']);
    const output = JSON.parse(result.output) as { report: Report };
    expect(result.code).toBe(0);
    expect(output.report.checks.map((check) => [check.id, check.evidence])).toEqual([
      ['first', ['fresh first evidence']],
    ]);
    expect(output.report.summary).toMatchObject({ pass: 1, fail: 0 });
    expect(output.report.verification).toEqual({ scope: 'partial', requestedCheckIds: ['first'], omittedCheckIds: ['second'] });
    expect(first).toHaveBeenCalledTimes(2);
    expect(second).toHaveBeenCalledTimes(1);
    const markdown = readFileSync(join(root, 'GOLIVE_REPORT.md'), 'utf8');
    expect(markdown).not.toContain('retained second evidence');
    expect(markdown).toContain('selected checks only');
    expect(markdown).toContain('Not run in this invocation: `second`');
    expect(markdown).not.toContain('Ready:');
    expect(readFileSync(join(root, 'SHIP_REPORT.md'), 'utf8')).toBe('{"checks":[]}');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('does not relabel old release, project, deployment URL or timestamp evidence as current', async () => {
    const accounts = addCheck('accounts', 'pass', 'current account verified');
    const bundle = addCheck('bundle-secrets', 'pass', 'must not be run');
    mkdirSync(join(root, '.golive'));
    writeFileSync(join(root, '.golive/report.json'), JSON.stringify({
      version: 1, release: { name: 'golive', version: '0.0.1', bundleDigest: 'old-release' }, generatedAt: '2000-01-01T00:00:00Z',
      app: { root: '/old-project', framework: 'next', urls: { production: 'https://old-deployment.example.test' } },
      stack: { hosting: 'vercel' }, checks: [{ id: 'bundle-secrets', title: 'Old bundle', status: 'pass', severity: 'high', evidence: ['stale pass on old project'] }],
    }));
    writeFileSync(join(root, 'golive.yaml'), JSON.stringify({ version: 1, stack: { hosting: 'netlify' }, projects: { hosting: 'new-project' }, targets: ['production'] }));
    const result = await runCli(['verify', '--only', 'accounts']); const output = JSON.parse(result.output);
    expect(result.code).toBe(0); expect(output.report.checks.map((c: CheckResult) => c.id)).toEqual(['accounts']);
    expect(output.report.stack).toEqual({ hosting: 'netlify' }); expect(output.report.app.root).toBe(root);
    expect(output.report.release.version).not.toBe('0.0.1'); expect(output.report.generatedAt).not.toBe('2000-01-01T00:00:00Z');
    expect(result.output).not.toMatch(/stale pass|old-deployment|old-project|old-release/);
    expect(accounts).toHaveBeenCalledTimes(1); expect(bundle).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });

  it('records full scope when every registered check was requested without converting not-applicable skips to failures', async () => {
    addCheck('accounts', 'pass', 'current account verified'); addCheck('email', 'skip', 'not applicable to this stack');
    const result = await runCli(['verify', '--only', 'accounts,email']); const output = JSON.parse(result.output);
    expect(result.code).toBe(0); expect(output.report.summary).toMatchObject({ pass: 1, fail: 0, skip: 1 });
    expect(output.report.verification).toEqual({ scope: 'full', requestedCheckIds: ['accounts', 'email'], omittedCheckIds: [] });
    const markdown = readFileSync(join(root, 'GOLIVE_REPORT.md'), 'utf8');
    expect(markdown).toContain('skipped checks'); expect(markdown).not.toContain('all checks passed'); expect(markdown).not.toContain('Ready:');
  });

  it('leaves handoffs unverified when their check is outside --only instead of running hidden extra checks', async () => {
    addCheck('accounts', 'pass', 'current account verified'); const omitted = addCheck('domain-live', 'pass', 'would pass if requested');
    mocks.plan.mockResolvedValue({ handoffs: [{ id: 'dns', why: 'needs verification', action: 'Verify DNS', blocking: true, verifiedBy: 'domain-live' }], steps: [] });
    const result = await runCli(['verify', '--only', 'accounts']); const output = JSON.parse(result.output);
    expect(omitted).not.toHaveBeenCalled(); expect(output.report.checks.map((c: CheckResult) => c.id)).toEqual(['accounts']);
    expect(output.report.handoffs[0].done).toBeNull(); expect(output.report.summary.manual).toBe(1);
    expect(output.report.verification.omittedCheckIds).toEqual(['domain-live']);
  });

  it.each([false, true])('does not infer deployment readiness from passing checks when plan unavailable=%s', async (unavailable) => {
    addCheck('accounts', 'pass', 'current account verified');
    const deploy = vi.fn();
    if (unavailable) mocks.plan.mockRejectedValue(new Error('read-only observation unavailable'));
    else mocks.plan.mockResolvedValue({ handoffs: [], steps: [{ id: 'deploy:production', kind: 'deploy', risk: { writes: true }, run: deploy }] });
    const result = await runCli(['verify']);
    expect(result.code).toBe(0); expect(deploy).not.toHaveBeenCalled();
    const markdown = readFileSync(join(root, 'GOLIVE_REPORT.md'), 'utf8');
    expect(markdown).toContain('Checks passed in this invocation.');
    expect(markdown).toContain('Deployment readiness is not established by this report.');
    expect(markdown).not.toContain('Ready:'); expect(fetch).not.toHaveBeenCalled();
  });

  it('lists the new path in help and makes no report', async () => {
    const result = await runCli(['help']);
    expect(result.output).toContain('writes .golive/report.json and GOLIVE_REPORT.md');
    expect(existsSync(join(root, 'GOLIVE_REPORT.md'))).toBe(false);
    expect(mocks.detect).not.toHaveBeenCalled();
  });
});
