import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GovernanceCheckResult } from '@avdmgr/shared';

const runAllChecksMock = vi.fn();

vi.mock('./governance/registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./governance/registry')>();
  return { ...actual, runAllChecks: runAllChecksMock };
});

function fakeCheck(status: GovernanceCheckResult['status']): GovernanceCheckResult {
  return { id: 'x', title: 'X', category: 'Test', status, summary: 's', evidence: {}, checkedAt: new Date().toISOString() };
}

beforeEach(async () => {
  runAllChecksMock.mockReset();
  const { _resetGovernanceSummaryCacheForTests } = await import('./governanceService');
  _resetGovernanceSummaryCacheForTests();
});

describe('getGovernanceSummary', () => {
  it('computes counts from the check results', async () => {
    runAllChecksMock.mockResolvedValue([fakeCheck('pass'), fakeCheck('pass'), fakeCheck('warn'), fakeCheck('fail'), fakeCheck('unknown')]);
    const { getGovernanceSummary } = await import('./governanceService');

    const summary = await getGovernanceSummary();
    expect(summary.counts).toEqual({ pass: 2, warn: 1, fail: 1, unknown: 1 });
    expect(summary.cached).toBe(false);
  });

  it('serves a cached result (cached: true) within the TTL without re-running checks', async () => {
    runAllChecksMock.mockResolvedValue([fakeCheck('pass')]);
    const { getGovernanceSummary } = await import('./governanceService');

    await getGovernanceSummary();
    const second = await getGovernanceSummary();

    expect(runAllChecksMock).toHaveBeenCalledTimes(1);
    expect(second.cached).toBe(true);
  });

  it('bypasses the cache when forceRefresh is true', async () => {
    runAllChecksMock.mockResolvedValue([fakeCheck('pass')]);
    const { getGovernanceSummary } = await import('./governanceService');

    await getGovernanceSummary();
    await getGovernanceSummary({ forceRefresh: true });

    expect(runAllChecksMock).toHaveBeenCalledTimes(2);
  });

  it('dedupes concurrent callers into a single in-flight run', async () => {
    let resolveChecks!: (value: GovernanceCheckResult[]) => void;
    runAllChecksMock.mockReturnValue(new Promise<GovernanceCheckResult[]>((resolve) => (resolveChecks = resolve)));
    const { getGovernanceSummary } = await import('./governanceService');

    const first = getGovernanceSummary();
    const second = getGovernanceSummary();
    resolveChecks([fakeCheck('pass')]);
    await Promise.all([first, second]);

    expect(runAllChecksMock).toHaveBeenCalledTimes(1);
  });

  describe('degraded-cache TTL (peer review item 13)', () => {
    it('caches for the short (60s) TTL, not the full 10min, when the summary has any unknown check', async () => {
      vi.useFakeTimers();
      try {
        runAllChecksMock.mockResolvedValue([fakeCheck('pass'), fakeCheck('unknown')]);
        const { getGovernanceSummary } = await import('./governanceService');

        await getGovernanceSummary();
        await vi.advanceTimersByTimeAsync(61_000);
        await getGovernanceSummary();

        expect(runAllChecksMock).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it('still caches for the full 10min when nothing is unknown', async () => {
      vi.useFakeTimers();
      try {
        runAllChecksMock.mockResolvedValue([fakeCheck('pass'), fakeCheck('warn')]);
        const { getGovernanceSummary } = await import('./governanceService');

        await getGovernanceSummary();
        await vi.advanceTimersByTimeAsync(61_000);
        const second = await getGovernanceSummary();

        expect(runAllChecksMock).toHaveBeenCalledTimes(1);
        expect(second.cached).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('minimum re-run interval for forceRefresh (peer review item 10)', () => {
    it('serves cache instead of re-running when a second forceRefresh arrives within 60s of the first', async () => {
      vi.useFakeTimers();
      try {
        runAllChecksMock.mockResolvedValue([fakeCheck('pass')]);
        const { getGovernanceSummary } = await import('./governanceService');

        await getGovernanceSummary({ forceRefresh: true });
        const second = await getGovernanceSummary({ forceRefresh: true });

        expect(runAllChecksMock).toHaveBeenCalledTimes(1);
        expect(second.cached).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it('allows a forceRefresh once the 60s floor has elapsed', async () => {
      vi.useFakeTimers();
      try {
        runAllChecksMock.mockResolvedValue([fakeCheck('pass')]);
        const { getGovernanceSummary } = await import('./governanceService');

        await getGovernanceSummary({ forceRefresh: true });
        await vi.advanceTimersByTimeAsync(61_000);
        await getGovernanceSummary({ forceRefresh: true });

        expect(runAllChecksMock).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
