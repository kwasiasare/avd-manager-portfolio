import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AlertSummary } from '@avdmgr/shared';

const getHostPool = vi.fn();
const listSessionHosts = vi.fn();
const getCurrentScalingPlan = vi.fn();
vi.mock('./avdService', () => ({
  getHostPool: (...args: unknown[]) => getHostPool(...args),
  listSessionHosts: (...args: unknown[]) => listSessionHosts(...args),
  getCurrentScalingPlan: (...args: unknown[]) => getCurrentScalingPlan(...args),
}));

const listAlerts = vi.fn();
vi.mock('./alertsService', () => ({
  listAlerts: (...args: unknown[]) => listAlerts(...args),
}));

const listAlertStates = vi.fn();
const extractAlertGuid = vi.fn((id: string) => id.split('/').pop());
vi.mock('../lib/alertState', () => ({
  listAlertStates: (...args: unknown[]) => listAlertStates(...args),
  extractAlertGuid: (id: string) => extractAlertGuid(id),
}));

const getScalingOverride = vi.fn();
const computeOverrideStatus = vi.fn();
vi.mock('./scalingOverrideService', () => ({
  getScalingOverride: (...args: unknown[]) => getScalingOverride(...args),
  computeOverrideStatus: (...args: unknown[]) => computeOverrideStatus(...args),
}));

vi.mock('../lib/config', () => ({ getConfig: () => ({ hostPoolName: 'HP-CONTOSO-PROD' }) }));

function alert(overrides: Partial<AlertSummary> = {}): AlertSummary {
  return {
    id: '/subscriptions/sub/providers/Microsoft.AlertsManagement/alerts/aaaaaaaa-0000-0000-0000-000000000001',
    name: 'Alert',
    severity: 'Sev2',
    status: 'New',
    firedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('getEstateSummary', () => {
  beforeEach(() => {
    getHostPool.mockReset().mockResolvedValue({ maxSessionLimit: 8 });
    listSessionHosts.mockReset().mockResolvedValue([
      { id: '1', name: 'h1', hostPoolName: 'HP-CONTOSO-PROD', status: 'Available', allowNewSession: true, activeSessions: 2 },
      { id: '2', name: 'h2', hostPoolName: 'HP-CONTOSO-PROD', status: 'NoHeartbeat', allowNewSession: true, activeSessions: 0 },
    ]);
    getCurrentScalingPlan.mockReset().mockResolvedValue({ enabled: true, timeZone: 'Eastern Standard Time', schedules: [] });
    listAlerts.mockReset().mockResolvedValue([alert()]);
    listAlertStates.mockReset().mockResolvedValue(new Map());
    getScalingOverride.mockReset().mockResolvedValue(null);
    computeOverrideStatus.mockReset().mockReturnValue({ active: false });
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('returns every segment populated when every sub-source succeeds', async () => {
    const { getEstateSummary } = await import('./estateSummaryService');
    const summary = await getEstateSummary();

    expect(summary.hostPoolName).toBe('HP-CONTOSO-PROD');
    expect(summary.hosts).toEqual({ available: 1, total: 2 });
    expect(summary.sessions).toEqual({ used: 2, capacity: 16 });
    // No configured schedule for today -> Unscheduled, still a defined phase (not a failure).
    expect(summary.scalingPhase).toBeDefined();
    expect(summary.openAlertCount).toBe(1);
    expect(summary.overrideActive).toBe(false);
    expect(typeof summary.generatedAt).toBe('string');
  });

  it('counts an acked alert as not open', async () => {
    listAlertStates.mockResolvedValue(new Map([['aaaaaaaa-0000-0000-0000-000000000001', { ackedBy: 'admin@example.com', ackedAt: new Date().toISOString() }]]));
    const { getEstateSummary } = await import('./estateSummaryService');
    const summary = await getEstateSummary();
    expect(summary.openAlertCount).toBe(0);
  });

  it('omits the hosts/sessions segment (never a fabricated zero) when the host/session lookup fails', async () => {
    listSessionHosts.mockRejectedValue(new Error('ARM unreachable'));
    const warnings: string[] = [];
    const { getEstateSummary } = await import('./estateSummaryService');
    const summary = await getEstateSummary((message) => warnings.push(message));

    expect(summary.hosts).toBeUndefined();
    expect(summary.sessions).toBeUndefined();
    // Every other segment still resolves independently.
    expect(summary.openAlertCount).toBe(1);
    expect(summary.overrideActive).toBe(false);
    expect(warnings.some((message) => message.includes('host/session'))).toBe(true);
  });

  it('omits the alert count segment when the alert lookup fails, without affecting other segments', async () => {
    listAlerts.mockRejectedValue(new Error('Alerts Management unavailable'));
    const { getEstateSummary } = await import('./estateSummaryService');
    const summary = await getEstateSummary();

    expect(summary.openAlertCount).toBeUndefined();
    expect(summary.hosts).toEqual({ available: 1, total: 2 });
  });

  it('omits the scaling phase segment when no scaling plan is resolved', async () => {
    getCurrentScalingPlan.mockResolvedValue(null);
    const { getEstateSummary } = await import('./estateSummaryService');
    const summary = await getEstateSummary();
    expect(summary.scalingPhase).toBeUndefined();
  });

  it('omits the override segment when the override lookup fails', async () => {
    getScalingOverride.mockRejectedValue(new Error('Table Storage unreachable'));
    const { getEstateSummary } = await import('./estateSummaryService');
    const summary = await getEstateSummary();
    expect(summary.overrideActive).toBeUndefined();
  });

  it('never throws even when every sub-source fails', async () => {
    listSessionHosts.mockRejectedValue(new Error('a'));
    listAlerts.mockRejectedValue(new Error('b'));
    getCurrentScalingPlan.mockRejectedValue(new Error('c'));
    getScalingOverride.mockRejectedValue(new Error('d'));
    const { getEstateSummary } = await import('./estateSummaryService');
    const summary = await getEstateSummary();

    expect(summary.hostPoolName).toBe('HP-CONTOSO-PROD');
    expect(summary.hosts).toBeUndefined();
    expect(summary.sessions).toBeUndefined();
    expect(summary.openAlertCount).toBeUndefined();
    expect(summary.scalingPhase).toBeUndefined();
    expect(summary.overrideActive).toBeUndefined();
  });
});

/** Peer review (Opus, MAJOR item 5 / MINOR item 15) — the ~45s single-key cache, in-flight dedup, and per-segment rate-limited warn logging. */
describe('getEstateSummary — caching, dedup, and rate-limited warnings', () => {
  beforeEach(() => {
    getHostPool.mockReset().mockResolvedValue({ maxSessionLimit: 8 });
    listSessionHosts.mockReset().mockResolvedValue([{ id: '1', name: 'h1', hostPoolName: 'HP-CONTOSO-PROD', status: 'Available', allowNewSession: true, activeSessions: 2 }]);
    getCurrentScalingPlan.mockReset().mockResolvedValue({ enabled: true, timeZone: 'Eastern Standard Time', schedules: [] });
    listAlerts.mockReset().mockResolvedValue([]);
    listAlertStates.mockReset().mockResolvedValue(new Map());
    getScalingOverride.mockReset().mockResolvedValue(null);
    computeOverrideStatus.mockReset().mockReturnValue({ active: false });
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.resetModules();
  });

  it('serves a second call within the TTL from cache — the underlying fan-out only runs once', async () => {
    const { getEstateSummary } = await import('./estateSummaryService');
    await getEstateSummary();
    await getEstateSummary();

    expect(listSessionHosts).toHaveBeenCalledTimes(1);
    expect(listAlerts).toHaveBeenCalledTimes(1);
  });

  it('re-fetches once the TTL has elapsed', async () => {
    const { getEstateSummary } = await import('./estateSummaryService');
    await getEstateSummary();

    vi.advanceTimersByTime(46_000);
    await getEstateSummary();

    expect(listSessionHosts).toHaveBeenCalledTimes(2);
  });

  it('dedupes concurrent callers onto the SAME in-flight fetch', async () => {
    const { getEstateSummary } = await import('./estateSummaryService');
    const [first, second] = await Promise.all([getEstateSummary(), getEstateSummary()]);

    expect(listSessionHosts).toHaveBeenCalledTimes(1);
    expect(first).toEqual(second);
  });

  it('never caches a fully-failed result — the very next call retries immediately', async () => {
    listSessionHosts.mockRejectedValue(new Error('a'));
    listAlerts.mockRejectedValue(new Error('b'));
    getCurrentScalingPlan.mockRejectedValue(new Error('c'));
    getScalingOverride.mockRejectedValue(new Error('d'));

    const { getEstateSummary } = await import('./estateSummaryService');
    await getEstateSummary();
    await getEstateSummary();

    expect(listSessionHosts).toHaveBeenCalledTimes(2);
  });

  it('rate-limits repeated warnings for the SAME failing segment within the window, but still warns about a DIFFERENT segment', async () => {
    listSessionHosts.mockRejectedValue(new Error('ARM unreachable'));
    const warnings: string[] = [];
    const { getEstateSummary } = await import('./estateSummaryService');

    await getEstateSummary((message) => warnings.push(message));
    vi.advanceTimersByTime(46_000); // past the cache TTL, well under the 5min warn rate-limit window
    await getEstateSummary((message) => warnings.push(message));

    expect(warnings.filter((message) => message.includes('host/session'))).toHaveLength(1);

    listAlerts.mockRejectedValue(new Error('Alerts Management unavailable'));
    vi.advanceTimersByTime(46_000);
    await getEstateSummary((message) => warnings.push(message));

    expect(warnings.some((message) => message.includes('open alert count'))).toBe(true);
  });

  it('warns again for the same segment once the 5-minute rate-limit window has elapsed', async () => {
    listSessionHosts.mockRejectedValue(new Error('ARM unreachable'));
    const warnings: string[] = [];
    const { getEstateSummary } = await import('./estateSummaryService');

    await getEstateSummary((message) => warnings.push(message));
    vi.advanceTimersByTime(5 * 60_000 + 1_000);
    await getEstateSummary((message) => warnings.push(message));

    expect(warnings.filter((message) => message.includes('host/session'))).toHaveLength(2);
  });
});
