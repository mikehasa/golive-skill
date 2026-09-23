import { describe, expect, it } from 'vitest';
import { renderReport } from '../src/report/render.js';
import { testCtx } from './helpers.js';
import type { Report } from '../src/core/types.js';
function reportFixture(over: Partial<Report> = {}): Report {
  return { version: 1, release: testCtx().release, generatedAt: '2026-09-23T00:00:00Z', app: { root: '/app', framework: 'unknown', urls: {} }, stack: {}, checks: [], handoffs: [], summary: { pass: 0, fail: 0, warn: 0, skip: 0, blocking: 0, manual: 0 }, ...over };
}
it('retains the executing release identity in the human audit report', () => {
  const release=testCtx().release;
  const report:Report={version:1,release,generatedAt:'2026-09-23T00:00:00Z',app:{root:'/app',framework:'unknown',urls:{}},stack:{},checks:[],handoffs:[],summary:{pass:0,fail:0,warn:0,skip:0,blocking:0,manual:0}};
  const text=renderReport(report);expect(text).toContain(`${release.name}@${release.version}`);expect(text).toContain(release.bundleDigest);
});

describe('report verdict is limited to observed verification', () => {
  it.each([
    { status: 'pass' as const, expected: 'Checks passed in this invocation.' },
    { status: 'warn' as const, expected: 'Verification completed with warnings.' },
    { status: 'skip' as const, expected: 'Verification completed with skipped checks.' },
    { status: 'fail' as const, expected: '1 check(s) failing.' },
  ])('does not claim deployment ready for $status evidence', ({ status, expected }) => {
    const report = reportFixture({ checks: [{ id: 'fixture', title: 'Fixture check', status, severity: 'info', evidence: ['mock-only'] }] });
    report.summary[status] = 1;
    const text = renderReport(report);
    expect(text).toContain(expected); expect(text).toContain('Deployment readiness is not established'); expect(text).not.toContain('Ready:');
  });
  it('does not call an empty report ready or passed', () => {
    const text = renderReport(reportFixture()); expect(text).toContain('No checks ran.'); expect(text).not.toContain('all checks passed'); expect(text).not.toContain('Ready:');
  });
  it('marks successful selected checks as partial and names omitted checks', () => {
    const report = reportFixture({ checks: [{ id: 'accounts', title: 'Accounts', status: 'pass', severity: 'high', evidence: [] }], verification: { scope: 'partial', requestedCheckIds: ['accounts'], omittedCheckIds: ['bundle-secrets', 'env-parity'] } });
    report.summary.pass = 1; const text = renderReport(report);
    expect(text).toContain('Selected checks passed.'); expect(text).toContain('selected checks only'); expect(text).toContain('Not run in this invocation: `bundle-secrets`, `env-parity`');
  });
  it.each(['blocking', 'manual'] as const)('keeps %s human work visibly incomplete', (kind) => {
    const report = reportFixture(); report.summary[kind] = 1;
    const text = renderReport(report); expect(text).toContain('Verification incomplete:'); expect(text).not.toContain('Checks pass'); expect(text).not.toContain('Ready:');
  });
});
