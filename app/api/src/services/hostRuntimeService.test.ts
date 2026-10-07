import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LogsQueryResult, LogsTable } from '@azure/monitor-query-logs';
import type { HostHourlyPresence } from './hostRuntimeService';

const queryWorkspaceMock = vi.fn();

vi.mock('@azure/identity', () => ({
  DefaultAzureCredential: vi.fn().mockImplementation(function DefaultAzureCredential() {
    return {};
  }),
}));

vi.mock('@azure/monitor-query-logs', async () => {
  const actual = await vi.importActual<typeof import('@azure/monitor-query-logs')>('@azure/monitor-query-logs');
  return {
    ...actual,
    LogsQueryClient: vi.fn().mockImplementation(function LogsQueryClient() {
      return { queryWorkspace: queryWorkspaceMock };
    }),
  };
});

const ORIGINAL_ENV = { ...process.env };

/** customerId: null (not undefined — a default parameter wouldn't trigger on an explicit `undefined` argument) explicitly unsets LAW_WORKSPACE_GUID. */
function setBaseEnv(customerId: string | null = '22222222-2222-2222-2222-222222222222') {
  process.env = { ...ORIGINAL_ENV };
  process.env.SUBSCRIPTION_ID = '11111111-1111-1111-1111-111111111111';
  process.env.HOSTPOOL_NAME = 'HP-CONTOSO-PROD';
  process.env.RG_HOSTPOOLS = 'RG-AVD-HostPools';
  if (customerId !== null) {
    process.env.LAW_WORKSPACE_GUID = customerId;
  } else {
    delete process.env.LAW_WORKSPACE_GUID;
  }
}

function fakeTable(rows: LogsTable['rows']): LogsTable {
  return {
    name: 'PrimaryResult',
    columnDescriptors: [
      { name: 'SessionHostName', type: 'string' },
      { name: 'HourBucket', type: 'datetime' },
    ],
    rows,
  };
}

function successResult(rows: LogsTable['rows']): LogsQueryResult {
  return { status: 'Success', tables: [fakeTable(rows)] } as unknown as LogsQueryResult;
}

beforeEach(() => {
  setBaseEnv();
  queryWorkspaceMock.mockReset();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('fetchHostHourlyPresence (mocked LogsQueryClient)', () => {
  it('buckets rows into a per-host set of seen hours, normalizing FQDN/case differences', async () => {
    const h0 = new Date('2026-08-15T10:00:00Z');
    const h1 = new Date('2026-08-15T11:00:00Z');
    queryWorkspaceMock.mockResolvedValue(
      successResult([
        ['avd-con-0', h0],
        ['AVD-CON-0.contoso.local', h1], // same host, different case/FQDN — must merge with the row above
        ['avd-con-1', h0],
      ]),
    );

    const { fetchHostHourlyPresence } = await import('./hostRuntimeService');
    const presence = await fetchHostHourlyPresence(['avd-con-0', 'avd-con-1']);

    expect(presence.available).toBe(true);
    expect(presence.seenHoursByHost.get('avd-con-0')).toEqual(new Set([h0.getTime(), h1.getTime()]));
    expect(presence.seenHoursByHost.get('avd-con-1')).toEqual(new Set([h0.getTime()]));
  });

  it('scopes the KQL query to the given host names (peer review item 10)', async () => {
    queryWorkspaceMock.mockResolvedValue(successResult([]));
    const { fetchHostHourlyPresence } = await import('./hostRuntimeService');
    await fetchHostHourlyPresence(['avd-con-0', 'avd-con-1']);

    expect(queryWorkspaceMock).toHaveBeenCalledTimes(1);
    const [, kql] = queryWorkspaceMock.mock.calls[0];
    expect(kql).toContain('SessionHostName in~');
    expect(kql).toContain('"avd-con-0"');
    expect(kql).toContain('"avd-con-1"');
  });

  it('escapes double quotes in host names in the KQL filter', async () => {
    queryWorkspaceMock.mockResolvedValue(successResult([]));
    const { fetchHostHourlyPresence } = await import('./hostRuntimeService');
    await fetchHostHourlyPresence(['weird"host']);
    const [, kql] = queryWorkspaceMock.mock.calls[0];
    expect(kql).toContain('"weird\\"host"');
  });

  it('returns available: true with no query when the host list is empty', async () => {
    const { fetchHostHourlyPresence } = await import('./hostRuntimeService');
    const presence = await fetchHostHourlyPresence([]);
    expect(presence.available).toBe(true);
    expect(presence.seenHoursByHost.size).toBe(0);
    expect(queryWorkspaceMock).not.toHaveBeenCalled();
  });

  it('reports available: false without querying when LAW_WORKSPACE_GUID is unset', async () => {
    setBaseEnv(null);
    const { fetchHostHourlyPresence } = await import('./hostRuntimeService');
    const presence = await fetchHostHourlyPresence(['avd-con-0']);
    expect(presence.available).toBe(false);
    expect(queryWorkspaceMock).not.toHaveBeenCalled();
  });

  it('reports available: false (not a thrown error) when the query itself rejects', async () => {
    queryWorkspaceMock.mockRejectedValue(new Error('workspace unreachable'));
    const { fetchHostHourlyPresence } = await import('./hostRuntimeService');
    const warnings: string[] = [];
    const presence = await fetchHostHourlyPresence(['avd-con-0'], (m) => warnings.push(m));
    expect(presence.available).toBe(false);
    expect(warnings.some((w) => w.includes('workspace unreachable'))).toBe(true);
  });
});

describe('summarizeHostRuntime (pure)', () => {
  it('reports dataSource: none with all hours unknown when presence data is unavailable', async () => {
    const { summarizeHostRuntime } = await import('./hostRuntimeService');
    const presence: HostHourlyPresence = { seenHoursByHost: new Map(), available: false };
    const summary = summarizeHostRuntime('avd-con-0', 'HP-CONTOSO-PROD', presence);
    expect(summary).toEqual({
      sessionHostName: 'avd-con-0',
      hostPoolName: 'HP-CONTOSO-PROD',
      runningHours: 0,
      deallocatedHours: 0,
      unknownHours: 168,
      windowHours: 168,
      dataSource: 'none',
    });
  });

  it('computes runningHours from the number of distinct seen hours, capping the window to the host\'s first-seen hour when only recent data exists', async () => {
    const { summarizeHostRuntime } = await import('./hostRuntimeService');
    const now = new Date('2026-08-15T12:00:00Z');
    // Only 3 recent hours seen — no data further back, so windowHours clamps
    // to this host's own observed span (peer review item 10), not the full
    // nominal 168h. See the "does not clamp" test below for the
    // has-older-data case.
    const seen = new Set([now.getTime() - 3_600_000, now.getTime() - 2 * 3_600_000, now.getTime() - 3 * 3_600_000]);
    const presence: HostHourlyPresence = { available: true, seenHoursByHost: new Map([['avd-con-0', seen]]) };
    const summary = summarizeHostRuntime('avd-con-0', 'HP-CONTOSO-PROD', presence, now);
    expect(summary.runningHours).toBe(3);
    expect(summary.windowHours).toBe(3);
    expect(summary.deallocatedHours).toBe(0);
    expect(summary.unknownHours).toBe(0);
    expect(summary.dataSource).toBe('WVDAgentHealthStatus');
  });

  it('reports zero running hours (fully deallocated) for a host with no rows at all, when the query itself succeeded', async () => {
    const { summarizeHostRuntime } = await import('./hostRuntimeService');
    const presence: HostHourlyPresence = { available: true, seenHoursByHost: new Map() };
    const summary = summarizeHostRuntime('avd-con-0', 'HP-CONTOSO-PROD', presence);
    expect(summary.runningHours).toBe(0);
    expect(summary.deallocatedHours).toBe(168);
    expect(summary.windowHours).toBe(168);
  });

  it('clamps windowHours to the host\'s first-seen hour when it is younger than the nominal 7-day window (peer review item 10)', async () => {
    const { summarizeHostRuntime } = await import('./hostRuntimeService');
    const now = new Date('2026-08-15T12:00:00Z');
    // Host has been reporting continuously for the last 10 hours only —
    // added to the pool well within the 7-day window.
    const seen = new Set<number>();
    for (let hoursAgo = 0; hoursAgo < 10; hoursAgo += 1) {
      seen.add(now.getTime() - hoursAgo * 3_600_000);
    }
    const presence: HostHourlyPresence = { available: true, seenHoursByHost: new Map([['avd-con-new', seen]]) };
    const summary = summarizeHostRuntime('avd-con-new', 'HP-CONTOSO-PROD', presence, now);
    expect(summary.runningHours).toBe(10);
    // windowHours should be clamped to ~10 (host's own observed span), not the full 168.
    expect(summary.windowHours).toBe(10);
    expect(summary.deallocatedHours).toBe(0);
  });

  it('does not clamp windowHours when the host has data older than the nominal window start', async () => {
    const { summarizeHostRuntime } = await import('./hostRuntimeService');
    const now = new Date('2026-08-15T12:00:00Z');
    const eightDaysAgo = now.getTime() - 8 * 24 * 3_600_000; // older than the 7-day window
    const seen = new Set([eightDaysAgo, now.getTime() - 3_600_000]);
    const presence: HostHourlyPresence = { available: true, seenHoursByHost: new Map([['avd-con-0', seen]]) };
    const summary = summarizeHostRuntime('avd-con-0', 'HP-CONTOSO-PROD', presence, now);
    expect(summary.windowHours).toBe(168);
  });
});

describe('deriveRunningSinceApprox (pure)', () => {
  it('returns undefined when there is no presence data for the host', async () => {
    const { deriveRunningSinceApprox } = await import('./hostRuntimeService');
    expect(deriveRunningSinceApprox(undefined)).toBeUndefined();
    expect(deriveRunningSinceApprox(new Set())).toBeUndefined();
  });

  it('returns undefined when nothing within the lookback tolerance has data', async () => {
    const { deriveRunningSinceApprox } = await import('./hostRuntimeService');
    const now = new Date('2026-08-15T12:30:00Z');
    const staleHour = new Date('2026-08-15T09:00:00Z').getTime();
    expect(deriveRunningSinceApprox(new Set([staleHour]), now)).toBeUndefined();
  });

  it('walks back through an unbroken run of seen hours to find the approx start', async () => {
    const { deriveRunningSinceApprox } = await import('./hostRuntimeService');
    const now = new Date('2026-08-15T12:30:00Z');
    const hour = (h: number) => new Date(`2026-08-15T${String(h).padStart(2, '0')}:00:00Z`).getTime();
    // Seen 08:00-12:00 (current hour bucket), with a gap before 08:00.
    const seen = new Set([hour(8), hour(9), hour(10), hour(11), hour(12)]);
    expect(deriveRunningSinceApprox(seen, now)).toBe(new Date(hour(8)).toISOString());
  });

  it('accepts the previous hour bucket as "currently running" (1-bucket ingestion lag)', async () => {
    const { deriveRunningSinceApprox } = await import('./hostRuntimeService');
    const now = new Date('2026-08-15T12:05:00Z'); // 5 min into the 12:00 bucket, but only 11:00 has data yet
    const hour = (h: number) => new Date(`2026-08-15T${String(h).padStart(2, '0')}:00:00Z`).getTime();
    const seen = new Set([hour(10), hour(11)]);
    expect(deriveRunningSinceApprox(seen, now)).toBe(new Date(hour(10)).toISOString());
  });

  it('accepts a 2-bucket-old gap as "currently running" (peer review item 10 — widened tolerance)', async () => {
    const { deriveRunningSinceApprox } = await import('./hostRuntimeService');
    const now = new Date('2026-08-15T12:05:00Z'); // current bucket is 12:00; only 10:00 has data (2 buckets back)
    const hour = (h: number) => new Date(`2026-08-15T${String(h).padStart(2, '0')}:00:00Z`).getTime();
    const seen = new Set([hour(9), hour(10)]);
    expect(deriveRunningSinceApprox(seen, now)).toBe(new Date(hour(9)).toISOString());
  });

  it('does NOT accept a 3-bucket-old gap (beyond the widened tolerance)', async () => {
    const { deriveRunningSinceApprox } = await import('./hostRuntimeService');
    const now = new Date('2026-08-15T12:05:00Z');
    const hour = (h: number) => new Date(`2026-08-15T${String(h).padStart(2, '0')}:00:00Z`).getTime();
    const seen = new Set([hour(9)]); // 3 buckets back from the 12:00 current bucket
    expect(deriveRunningSinceApprox(seen, now)).toBeUndefined();
  });
});
