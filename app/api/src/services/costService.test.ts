import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QueryDefinition, QueryResult } from '@azure/arm-costmanagement';

const usageMock = vi.fn();

vi.mock('@azure/identity', () => ({
  DefaultAzureCredential: vi.fn().mockImplementation(function DefaultAzureCredential() {
    return {};
  }),
}));

vi.mock('@azure/arm-costmanagement', () => ({
  CostManagementClient: vi.fn().mockImplementation(function CostManagementClient() {
    return { query: { usage: usageMock } };
  }),
}));

const ORIGINAL_ENV = { ...process.env };

function setBaseEnv() {
  process.env = { ...ORIGINAL_ENV };
  process.env.SUBSCRIPTION_ID = '11111111-1111-1111-1111-111111111111';
  process.env.HOSTPOOL_NAME = 'HP-CONTOSO-PROD';
  process.env.RG_HOSTPOOLS = 'RG-A';
  process.env.RG_IMAGES = 'RG-B';
  process.env.RG_MONITORING = 'RG-C';
  process.env.RG_MANAGEMENT = 'RG-D';
  process.env.RG_NETWORK = 'RG-E';
  process.env.RG_STORAGE = 'RG-F';
}

/** Builds a fake @azure/arm-costmanagement QueryResult with the PreTaxCost/UsageDate/Currency columns costService looks up by name. */
function fakeQueryResult(rows: Array<[cost: number, usageDate: number, currency: string]>, costColumnName: 'PreTaxCost' | 'Cost' = 'PreTaxCost'): QueryResult {
  return {
    columns: [{ name: costColumnName, type: 'Number' }, { name: 'UsageDate', type: 'Number' }, { name: 'Currency', type: 'String' }],
    rows,
  } as QueryResult;
}

function scopeEndsWithRg(scope: string, rg: string): boolean {
  return scope.endsWith(`/resourceGroups/${rg}`);
}

beforeEach(async () => {
  setBaseEnv();
  usageMock.mockReset();
  const { _resetCostSummaryCacheForTests } = await import('./costService');
  _resetCostSummaryCacheForTests();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('fetchResourceGroupCostRows (mocked CostManagementClient)', () => {
  it('maps SDK QueryResult rows to DailyCostRow per resource group, and degrades a failed prior-month query to undefined without failing the whole call', async () => {
    usageMock.mockImplementation(async (scope: string, definition: QueryDefinition) => {
      if (scopeEndsWithRg(scope, 'RG-A')) {
        if (definition.timeframe === 'MonthToDate') {
          return fakeQueryResult([
            [10.5, 20260801, 'USD'],
            [12.25, 20260802, 'USD'],
          ]);
        }
        if (definition.timeframe === 'TheLastMonth') {
          throw new Error('Cost Management transient failure');
        }
      }
      if (scopeEndsWithRg(scope, 'RG-B')) {
        if (definition.timeframe === 'MonthToDate') {
          return fakeQueryResult([[1, 20260801, 'USD']]);
        }
        if (definition.timeframe === 'TheLastMonth') {
          return fakeQueryResult([
            [2, 20260701, 'USD'],
            [3, 20260702, 'USD'],
          ]);
        }
      }
      return fakeQueryResult([]);
    });

    const { fetchResourceGroupCostRows } = await import('./costService');
    const warnings: string[] = [];
    const rows = await fetchResourceGroupCostRows((message) => warnings.push(message));

    const rgA = rows.find((r) => r.resourceGroup === 'RG-A');
    expect(rgA?.monthToDateRows).toEqual([
      { cost: 10.5, dayOfMonth: 1 },
      { cost: 12.25, dayOfMonth: 2 },
    ]);
    expect(rgA?.lastMonthRows).toBeUndefined();
    expect(rgA?.currency).toBe('USD');
    expect(warnings.some((w) => w.includes('RG-A'))).toBe(true);

    const rgB = rows.find((r) => r.resourceGroup === 'RG-B');
    expect(rgB?.monthToDateRows).toEqual([{ cost: 1, dayOfMonth: 1 }]);
    expect(rgB?.lastMonthRows).toEqual([
      { cost: 2, dayOfMonth: 1 },
      { cost: 3, dayOfMonth: 2 },
    ]);

    const rgC = rows.find((r) => r.resourceGroup === 'RG-C');
    expect(rgC?.monthToDateRows).toEqual([]);
    expect(rgC?.lastMonthRows).toEqual([]);

    // 6 tracked RGs, one call each for MonthToDate + TheLastMonth.
    expect(usageMock).toHaveBeenCalledTimes(12);
  });

  it('propagates a month-to-date query failure (load-bearing — the whole summary should fail closed, not report a fabricated $0)', async () => {
    usageMock.mockImplementation(async (_scope: string, definition: QueryDefinition) => {
      if (definition.timeframe === 'MonthToDate') {
        throw new Error('Cost Management unavailable');
      }
      return fakeQueryResult([]);
    });

    const { fetchResourceGroupCostRows } = await import('./costService');
    await expect(fetchResourceGroupCostRows()).rejects.toThrow(/Cost Management unavailable/);
  });

  it('PEER REVIEW ITEM 9: throws (fails closed) rather than coercing to 0 when UsageDate is not a finite number', async () => {
    usageMock.mockImplementation(async (_scope: string, definition: QueryDefinition) => {
      if (definition.timeframe === 'MonthToDate') {
        return {
          columns: [{ name: 'PreTaxCost', type: 'Number' }, { name: 'UsageDate', type: 'Number' }, { name: 'Currency', type: 'String' }],
          rows: [[5, 'not-a-date', 'USD']],
        } as unknown as QueryResult;
      }
      return fakeQueryResult([]);
    });

    const { fetchResourceGroupCostRows } = await import('./costService');
    await expect(fetchResourceGroupCostRows()).rejects.toThrow(/non-numeric UsageDate/);
  });

  it('PEER REVIEW ITEM 1: throws (fails closed) rather than silently returning [] when the month-to-date response is missing the expected columns', async () => {
    usageMock.mockImplementation(async (_scope: string, definition: QueryDefinition) => {
      if (definition.timeframe === 'MonthToDate') {
        // A response with NEITHER PreTaxCost/Cost NOR UsageDate columns —
        // simulates a schema change / degraded auth response, not a
        // legitimate zero-activity month (which would still have the
        // columns, just an empty `rows` array).
        return { columns: [{ name: 'SomethingElse', type: 'String' }], rows: [] } as unknown as QueryResult;
      }
      return fakeQueryResult([]);
    });

    const { fetchResourceGroupCostRows } = await import('./costService');
    await expect(fetchResourceGroupCostRows()).rejects.toThrow(/missing expected columns/);
  });

  it('accepts "Cost" as an alias for "PreTaxCost" in the response columns', async () => {
    usageMock.mockImplementation(async (scope: string, definition: QueryDefinition) => {
      if (scopeEndsWithRg(scope, 'RG-A') && definition.timeframe === 'MonthToDate') {
        return fakeQueryResult([[7.5, 20260801, 'USD']], 'Cost');
      }
      return fakeQueryResult([]);
    });

    const { fetchResourceGroupCostRows } = await import('./costService');
    const rows = await fetchResourceGroupCostRows();
    expect(rows.find((r) => r.resourceGroup === 'RG-A')?.monthToDateRows).toEqual([{ cost: 7.5, dayOfMonth: 1 }]);
  });

  it('does NOT throw for a legitimate zero-activity month (valid columns, empty rows)', async () => {
    usageMock.mockResolvedValue(fakeQueryResult([]));
    const { fetchResourceGroupCostRows } = await import('./costService');
    const rows = await fetchResourceGroupCostRows();
    expect(rows.every((r) => r.monthToDateRows.length === 0)).toBe(true);
  });

  it('respects bounded concurrency (peer review item 8) — no more than 4 in-flight query.usage calls at once', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    usageMock.mockImplementation(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return fakeQueryResult([]);
    });

    const { fetchResourceGroupCostRows } = await import('./costService');
    await fetchResourceGroupCostRows();
    expect(maxInFlight).toBeLessThanOrEqual(4);
  });

  it('AM-39: bounds every query.usage call with an abortSignal, so a hung/repeatedly-throttled Cost Management call cannot block this indefinitely', async () => {
    usageMock.mockResolvedValue(fakeQueryResult([]));

    const { fetchResourceGroupCostRows } = await import('./costService');
    await fetchResourceGroupCostRows();

    expect(usageMock.mock.calls.length).toBeGreaterThan(0);
    for (const call of usageMock.mock.calls) {
      const [, , options] = call as [string, QueryDefinition, { abortSignal?: AbortSignal }];
      expect(options?.abortSignal).toBeInstanceOf(AbortSignal);
      expect(options?.abortSignal?.aborted).toBe(false);
    }
  });
});

describe('getCostSummary caching', () => {
  it('caches the computed summary — a second call within the TTL makes no further SDK calls', async () => {
    usageMock.mockResolvedValue(fakeQueryResult([]));

    const { getCostSummary } = await import('./costService');
    await getCostSummary();
    const callsAfterFirst = usageMock.mock.calls.length;
    expect(callsAfterFirst).toBeGreaterThan(0);

    await getCostSummary();
    expect(usageMock.mock.calls.length).toBe(callsAfterFirst);
  });

  it('refetches after _resetCostSummaryCacheForTests clears the cache', async () => {
    usageMock.mockResolvedValue(fakeQueryResult([]));

    const { getCostSummary, _resetCostSummaryCacheForTests } = await import('./costService');
    await getCostSummary();
    const callsAfterFirst = usageMock.mock.calls.length;

    _resetCostSummaryCacheForTests();
    await getCostSummary();
    expect(usageMock.mock.calls.length).toBe(callsAfterFirst * 2);
  });

  it('PEER REVIEW ITEM 7: dedupes concurrent cold-start callers onto a single in-flight fetch', async () => {
    let callCount = 0;
    usageMock.mockImplementation(async () => {
      callCount += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return fakeQueryResult([]);
    });

    const { getCostSummary } = await import('./costService');
    const [a, b, c] = await Promise.all([getCostSummary(), getCostSummary(), getCostSummary()]);
    expect(a).toBe(b);
    expect(b).toBe(c);
    // Exactly one fan-out (6 RGs x 2 queries), not three.
    expect(callCount).toBe(12);
  });

  it('PEER REVIEW ITEM 7: uses a shorter TTL when the result is degraded (a resource group failed its prior-month query)', async () => {
    usageMock.mockImplementation(async (scope: string, definition: QueryDefinition) => {
      if (scopeEndsWithRg(scope, 'RG-A') && definition.timeframe === 'TheLastMonth') {
        throw new Error('boom');
      }
      return fakeQueryResult([]);
    });

    const nowSpy = vi.spyOn(Date, 'now');
    const { getCostSummary } = await import('./costService');

    nowSpy.mockReturnValue(1_000_000);
    await getCostSummary();
    const callsAfterFirst = usageMock.mock.calls.length;

    // 15 minutes later: past the 5-minute degraded TTL (peer review MAJOR 1
    // raised this from an original 2min/10min-era value — see
    // DEGRADED_CACHE_TTL_MS's own doc comment), so this should refetch.
    nowSpy.mockReturnValue(1_000_000 + 15 * 60 * 1000);
    await getCostSummary();
    expect(usageMock.mock.calls.length).toBeGreaterThan(callsAfterFirst);

    nowSpy.mockRestore();
  });

  describe('AM-39 — stale-serve on upstream failure (Cost page timeout/recovery bug)', () => {
    it('serves the last successful summary with stale:true (not a 5xx) when a subsequent refetch fails, and warns rather than throwing', async () => {
      usageMock.mockResolvedValue(fakeQueryResult([[10, 20260801, 'USD']]));
      const nowSpy = vi.spyOn(Date, 'now');
      const { getCostSummary } = await import('./costService');

      nowSpy.mockReturnValue(1_000_000);
      const firstSummary = await getCostSummary();
      expect(firstSummary.stale).toBeUndefined();

      // Past the (15-minute) full TTL, so the next call attempts a real refetch.
      nowSpy.mockReturnValue(1_000_000 + 16 * 60 * 1000);
      usageMock.mockRejectedValue(Object.assign(new Error('Cost Management unavailable'), { statusCode: 503 }));

      const warnings: string[] = [];
      const secondSummary = await getCostSummary((message) => warnings.push(message));

      expect(secondSummary).toEqual({ ...firstSummary, stale: true });
      expect(warnings.some((w) => w.includes('Cost Management unavailable'))).toBe(true);

      nowSpy.mockRestore();
    });

    it('propagates the error when there is no cached value yet — the very first call must not fabricate a stale response', async () => {
      usageMock.mockRejectedValue(new Error('Cost Management unavailable'));
      const { getCostSummary } = await import('./costService');

      await expect(getCostSummary()).rejects.toThrow(/Cost Management unavailable/);
    });

    it('a failed refetch never overwrites the cache — the NEXT successful call returns fresh (non-stale) data, not the old cached copy', async () => {
      usageMock.mockResolvedValue(fakeQueryResult([[10, 20260801, 'USD']]));
      const nowSpy = vi.spyOn(Date, 'now');
      const { getCostSummary } = await import('./costService');

      nowSpy.mockReturnValue(1_000_000);
      await getCostSummary();

      // Past the full TTL — attempts (and fails) a real refetch.
      nowSpy.mockReturnValue(1_000_000 + 16 * 60 * 1000);
      usageMock.mockRejectedValue(new Error('boom'));
      const staleResult = await getCostSummary();
      expect(staleResult.stale).toBe(true);

      // Cost Management recovers; well past both the TTL and the 45s
      // failure-backoff cooldown (peer review MAJOR 2), so this is a real refetch.
      usageMock.mockResolvedValue(fakeQueryResult([[20, 20260801, 'USD']]));
      nowSpy.mockReturnValue(1_000_000 + 32 * 60 * 1000);
      const recoveredResult = await getCostSummary();
      expect(recoveredResult.stale).toBeUndefined();
      expect(recoveredResult.monthToDateCost).not.toBe(staleResult.monthToDateCost);

      nowSpy.mockRestore();
    });

    it('AM-40 peer review MAJOR 2: within the 45s backoff cooldown after a failure, a request serves stale WITHOUT attempting a new fetch', async () => {
      usageMock.mockResolvedValue(fakeQueryResult([[10, 20260801, 'USD']]));
      const nowSpy = vi.spyOn(Date, 'now');
      const { getCostSummary } = await import('./costService');

      nowSpy.mockReturnValue(1_000_000);
      await getCostSummary();

      // Past the full TTL — attempts (and fails) a real refetch, starting the backoff cooldown.
      nowSpy.mockReturnValue(1_000_000 + 16 * 60 * 1000);
      usageMock.mockRejectedValue(new Error('boom'));
      await getCostSummary();
      const callsAfterFailure = usageMock.mock.calls.length;

      // 30s later — still inside the 45s cooldown. Even though the cache is
      // still expired, this must NOT call query.usage again.
      nowSpy.mockReturnValue(1_000_000 + 16 * 60 * 1000 + 30_000);
      const result = await getCostSummary();

      expect(result.stale).toBe(true);
      expect(usageMock.mock.calls.length).toBe(callsAfterFailure);

      nowSpy.mockRestore();
    });

    it('AM-40 peer review MAJOR 2: once the 45s backoff cooldown elapses, the next request attempts a real refetch again', async () => {
      usageMock.mockResolvedValue(fakeQueryResult([[10, 20260801, 'USD']]));
      const nowSpy = vi.spyOn(Date, 'now');
      const { getCostSummary } = await import('./costService');

      nowSpy.mockReturnValue(1_000_000);
      await getCostSummary();

      nowSpy.mockReturnValue(1_000_000 + 16 * 60 * 1000);
      usageMock.mockRejectedValue(new Error('boom'));
      await getCostSummary();
      const callsAfterFailure = usageMock.mock.calls.length;

      // 46s later — just past the 45s cooldown.
      usageMock.mockResolvedValue(fakeQueryResult([[20, 20260801, 'USD']]));
      nowSpy.mockReturnValue(1_000_000 + 16 * 60 * 1000 + 46_000);
      const result = await getCostSummary();

      expect(usageMock.mock.calls.length).toBeGreaterThan(callsAfterFailure);
      expect(result.stale).toBeUndefined();

      nowSpy.mockRestore();
    });

    it('bounds the whole fetch to a total budget even if every individual query.usage call hangs forever — this is the fix for "times out and does not recover on refresh": inFlightRequest must always settle', async () => {
      vi.useFakeTimers();
      usageMock.mockImplementation(() => new Promise(() => {})); // never resolves/rejects — simulates a wedged Cost Management call
      const { getCostSummary } = await import('./costService');

      const pending = expect(getCostSummary()).rejects.toThrow(/total budget/);
      await vi.advanceTimersByTimeAsync(25_000);
      await pending;

      vi.useRealTimers();
    });

    it('AM-40 peer review MINOR 1: aborts every in-flight query.usage call\'s signal when the total budget elapses, instead of abandoning them to run in the background', async () => {
      vi.useFakeTimers();
      const capturedSignals: (AbortSignal | undefined)[] = [];
      usageMock.mockImplementation((_scope: string, _definition: QueryDefinition, options?: { abortSignal?: AbortSignal }) => {
        capturedSignals.push(options?.abortSignal);
        return new Promise(() => {}); // never resolves — simulates a wedged Cost Management call
      });
      const { getCostSummary } = await import('./costService');

      const pending = expect(getCostSummary()).rejects.toThrow(/total budget/);
      await vi.advanceTimersByTimeAsync(25_000);
      await pending;

      expect(capturedSignals.length).toBeGreaterThan(0);
      // Every call's combined signal (controller + per-call AbortSignal.timeout) is aborted — not just abandoned.
      for (const signal of capturedSignals) {
        expect(signal?.aborted).toBe(true);
      }

      vi.useRealTimers();
    });

    it('after a total-budget timeout with no cache, a LATER call (e.g. a manual Refresh) gets a brand-new attempt rather than re-awaiting a wedged promise', async () => {
      vi.useFakeTimers();
      usageMock.mockImplementation(() => new Promise(() => {}));
      const { getCostSummary } = await import('./costService');

      const firstAttempt = expect(getCostSummary()).rejects.toThrow(/total budget/);
      await vi.advanceTimersByTimeAsync(25_000);
      await firstAttempt;

      // Cost Management recovers before the next attempt (e.g. a manual Refresh).
      usageMock.mockResolvedValue(fakeQueryResult([]));
      const secondAttempt = getCostSummary();
      await vi.runOnlyPendingTimersAsync();
      await expect(secondAttempt).resolves.toBeDefined();

      vi.useRealTimers();
    });
  });
});

describe('computeCostSummary (pure)', () => {
  it('sums month-to-date cost across resource groups and derives a linear month-end projection from complete days', async () => {
    const { computeCostSummary } = await import('./costService');
    const now = new Date(Date.UTC(2026, 7, 10)); // Aug 10, 2026 (UTC) — 10 days elapsed, 31 days in August

    const summary = computeCostSummary(
      [
        {
          resourceGroup: 'RG-A',
          monthToDateRows: [
            { dayOfMonth: 1, cost: 10 },
            { dayOfMonth: 2, cost: 10 },
          ],
          lastMonthRows: undefined,
          currency: 'USD',
        },
        {
          resourceGroup: 'RG-B',
          monthToDateRows: [{ dayOfMonth: 1, cost: 5 }],
          lastMonthRows: undefined,
          currency: 'USD',
        },
      ],
      now,
    );

    expect(summary.currency).toBe('USD');
    // Latest reported day (2) is not "today" (10), so nothing is dropped — asOfDate reflects the latest reported day.
    expect(summary.asOfDate).toBe('2026-08-02');
    expect(summary.byResourceGroup).toEqual([
      { resourceGroup: 'RG-A', cost: 20 },
      { resourceGroup: 'RG-B', cost: 5 },
    ]);
    expect(summary.monthToDateCost).toBe(25);
    // completeDaysElapsed = 2 (latest reported day); dailyRate = 25/2 = 12.5; projected = 12.5 * 31 = 387.5
    expect(summary.projectedMonthEndCost).toBe(387.5);
  });

  it("PEER REVIEW ITEM 9: drops today's row as a potentially incomplete day, adjusting asOfDate and the projection day-count", async () => {
    const { computeCostSummary } = await import('./costService');
    const now = new Date(Date.UTC(2026, 7, 10)); // Aug 10 — the latest reported day below equals "today"

    const summary = computeCostSummary(
      [
        {
          resourceGroup: 'RG-A',
          monthToDateRows: [
            { dayOfMonth: 8, cost: 10 },
            { dayOfMonth: 9, cost: 10 },
            { dayOfMonth: 10, cost: 1 }, // today — partial, should be dropped
          ],
          lastMonthRows: undefined,
          currency: 'USD',
        },
      ],
      now,
    );

    expect(summary.asOfDate).toBe('2026-08-09');
    expect(summary.monthToDateCost).toBe(20); // excludes day 10's $1
    // completeDaysElapsed = 9; dailyRate = 20/9; projected = (20/9)*31 ≈ 68.89
    expect(summary.projectedMonthEndCost).toBeCloseTo((20 / 9) * 31, 2);
  });

  it("keeps today's row when it is the ONLY day of data (day 1 of the month) rather than dropping to zero days", async () => {
    const { computeCostSummary } = await import('./costService');
    const now = new Date(Date.UTC(2026, 7, 1)); // Aug 1 — only day 1 has data, and day 1 IS today

    const summary = computeCostSummary(
      [{ resourceGroup: 'RG-A', monthToDateRows: [{ dayOfMonth: 1, cost: 5 }], lastMonthRows: undefined, currency: 'USD' }],
      now,
    );

    expect(summary.asOfDate).toBe('2026-08-01');
    expect(summary.monthToDateCost).toBe(5);
    // Only 1 complete day — below MIN_DAYS_FOR_PROJECTION (2), so undefined.
    expect(summary.projectedMonthEndCost).toBeUndefined();
  });

  it('PEER REVIEW ITEM 9: returns undefined for the projection when fewer than 2 complete days are available', async () => {
    const { computeCostSummary } = await import('./costService');
    const now = new Date(Date.UTC(2026, 7, 2));
    const summary = computeCostSummary(
      [{ resourceGroup: 'RG-A', monthToDateRows: [{ dayOfMonth: 2, cost: 5 }], lastMonthRows: undefined, currency: 'USD' }],
      now,
    ); // day 2 == today, dropped (day 2 > 1, so the drop rule applies) -> completeDaysElapsed = 1, below MIN_DAYS_FOR_PROJECTION (2)
    expect(summary.monthToDateCost).toBe(0);
    expect(summary.projectedMonthEndCost).toBeUndefined();
  });

  it('derives priorMonthSamePeriodCost from only the same elapsed complete-day-count in the prior month', async () => {
    const { computeCostSummary } = await import('./costService');
    const now = new Date(Date.UTC(2026, 7, 4)); // Aug 4 — latest reported day below is 3 (not today), so 3 complete days

    const summary = computeCostSummary(
      [
        {
          resourceGroup: 'RG-A',
          monthToDateRows: [{ dayOfMonth: 3, cost: 1 }],
          lastMonthRows: [
            { dayOfMonth: 1, cost: 100 },
            { dayOfMonth: 2, cost: 100 },
            { dayOfMonth: 3, cost: 100 },
            { dayOfMonth: 4, cost: 100 }, // beyond the 3-day comparison window — must be excluded
            { dayOfMonth: 31, cost: 100 }, // full prior-month total would include this; same-period must not
          ],
          currency: 'USD',
        },
      ],
      now,
    );

    expect(summary.priorMonthSamePeriodCost).toBe(300);
  });

  it('PEER REVIEW ITEM 2: leaves priorMonthSamePeriodCost undefined when even ONE tracked resource group is missing prior-month data (not just when ALL are)', async () => {
    const { computeCostSummary } = await import('./costService');
    const now = new Date(Date.UTC(2026, 7, 4));
    const summary = computeCostSummary(
      [
        { resourceGroup: 'RG-A', monthToDateRows: [{ dayOfMonth: 3, cost: 1 }], lastMonthRows: [{ dayOfMonth: 1, cost: 50 }], currency: 'USD' },
        { resourceGroup: 'RG-B', monthToDateRows: [{ dayOfMonth: 3, cost: 1 }], lastMonthRows: undefined, currency: 'USD' }, // this one failed
      ],
      now,
    );
    expect(summary.priorMonthSamePeriodCost).toBeUndefined();
  });

  it('leaves priorMonthSamePeriodCost undefined when no resource group returned prior-month data at all', async () => {
    const { computeCostSummary } = await import('./costService');
    const summary = computeCostSummary([
      { resourceGroup: 'RG-A', monthToDateRows: [], lastMonthRows: undefined, currency: 'USD' },
      { resourceGroup: 'RG-B', monthToDateRows: [], lastMonthRows: [], currency: 'USD' },
    ]);
    expect(summary.priorMonthSamePeriodCost).toBeUndefined();
  });

  it('PEER REVIEW ITEM 9: clamps the prior-month comparison window to the number of days in the prior month', async () => {
    const { computeCostSummary } = await import('./costService');
    // March 31 (UTC) has 31 elapsed days; February (the prior month, non-leap 2027) has only 28.
    const now = new Date(Date.UTC(2027, 2, 31));
    const monthToDateRows = Array.from({ length: 31 }, (_, i) => ({ dayOfMonth: i + 1, cost: 1 }));
    const lastMonthRows = Array.from({ length: 28 }, (_, i) => ({ dayOfMonth: i + 1, cost: 10 }));

    const summary = computeCostSummary([{ resourceGroup: 'RG-A', monthToDateRows, lastMonthRows, currency: 'USD' }], now);
    // Window clamps to 28 days (all of February), not 31 — sums all 28 rows = 280, not undefined/short of data.
    expect(summary.priorMonthSamePeriodCost).toBe(280);
  });

  it('falls back to USD when no resource group reported a currency', async () => {
    const { computeCostSummary } = await import('./costService');
    const summary = computeCostSummary([{ resourceGroup: 'RG-A', monthToDateRows: [], lastMonthRows: undefined, currency: undefined }]);
    expect(summary.currency).toBe('USD');
  });

  it('reports asOfDate as today with $0 when there is no month-to-date data at all (rather than throwing or fabricating an earlier date)', async () => {
    const { computeCostSummary } = await import('./costService');
    const now = new Date(Date.UTC(2026, 7, 15));
    const summary = computeCostSummary([{ resourceGroup: 'RG-A', monthToDateRows: [], lastMonthRows: undefined, currency: 'USD' }], now);
    expect(summary.asOfDate).toBe('2026-08-15');
    expect(summary.monthToDateCost).toBe(0);
    expect(summary.projectedMonthEndCost).toBeUndefined();
  });
});
