import { describe, expect, it, vi } from 'vitest';
import type { HostRuntimeSummary, IdleHostFinding, ScalingPlanDetail, SessionHost } from '@avdmgr/shared';
import { deriveSavingsOpportunities } from './savingsService';

function idleFinding(overrides: Partial<IdleHostFinding> = {}): IdleHostFinding {
  return {
    sessionHostName: 'avd-con-0',
    hostPoolName: 'HP-CONTOSO-PROD',
    powerState: 'running',
    phase: 'OffPeak',
    activeSessions: 0,
    disconnectedSessions: 1,
    reason: 'test reason',
    ...overrides,
  };
}

function runtimeSummary(overrides: Partial<HostRuntimeSummary> = {}): HostRuntimeSummary {
  return {
    sessionHostName: 'avd-con-0',
    hostPoolName: 'HP-CONTOSO-PROD',
    runningHours: 20,
    deallocatedHours: 148,
    unknownHours: 0,
    windowHours: 168,
    dataSource: 'WVDAgentHealthStatus',
    ...overrides,
  };
}

describe('deriveSavingsOpportunities', () => {
  it('returns an empty array when there is nothing to flag', () => {
    expect(deriveSavingsOpportunities({ idleHostFindings: [], startVMOnConnect: true, hostRuntimeSummaries: [runtimeSummary({ runningHours: 10 })] })).toEqual([]);
  });

  it('flags StartVMOnConnect: false as critical', () => {
    const opportunities = deriveSavingsOpportunities({ idleHostFindings: [], startVMOnConnect: false, hostRuntimeSummaries: [] });
    expect(opportunities).toHaveLength(1);
    expect(opportunities[0].severity).toBe('critical');
    expect(opportunities[0].title).toContain('Start VM on Connect');
  });

  it('does NOT flag StartVMOnConnect when it is true or unknown', () => {
    expect(deriveSavingsOpportunities({ idleHostFindings: [], startVMOnConnect: true, hostRuntimeSummaries: [] })).toEqual([]);
    expect(deriveSavingsOpportunities({ idleHostFindings: [], startVMOnConnect: undefined, hostRuntimeSummaries: [] })).toEqual([]);
  });

  it('flags idle-host findings as a warning, naming the affected hosts', () => {
    const opportunities = deriveSavingsOpportunities({
      idleHostFindings: [idleFinding({ sessionHostName: 'avd-con-0' }), idleFinding({ sessionHostName: 'avd-con-1' })],
      startVMOnConnect: true,
      hostRuntimeSummaries: [],
    });
    expect(opportunities).toHaveLength(1);
    expect(opportunities[0].severity).toBe('warning');
    expect(opportunities[0].title).toContain('2 hosts');
    expect(opportunities[0].detail).toContain('avd-con-0');
    expect(opportunities[0].detail).toContain('avd-con-1');
  });

  it('uses singular "host" for exactly one idle-host finding', () => {
    const opportunities = deriveSavingsOpportunities({ idleHostFindings: [idleFinding()], startVMOnConnect: true, hostRuntimeSummaries: [] });
    expect(opportunities[0].title).toContain('1 host ');
  });

  it('flags a host running >= 60% of the 7-day window as an info-level running-hours outlier', () => {
    const opportunities = deriveSavingsOpportunities({
      idleHostFindings: [],
      startVMOnConnect: true,
      hostRuntimeSummaries: [runtimeSummary({ runningHours: 101, deallocatedHours: 67 })], // 101/168 ≈ 60.1%
    });
    expect(opportunities).toHaveLength(1);
    expect(opportunities[0].severity).toBe('info');
    expect(opportunities[0].title).toContain('avd-con-0');
  });

  it('does NOT flag a host running below the outlier threshold', () => {
    expect(
      deriveSavingsOpportunities({
        idleHostFindings: [],
        startVMOnConnect: true,
        hostRuntimeSummaries: [runtimeSummary({ runningHours: 50, deallocatedHours: 118 })],
      }),
    ).toEqual([]);
  });

  it('does NOT flag a running-hours outlier when dataSource is "none" (unknown, not confirmed high usage)', () => {
    expect(
      deriveSavingsOpportunities({
        idleHostFindings: [],
        startVMOnConnect: true,
        hostRuntimeSummaries: [runtimeSummary({ runningHours: 168, deallocatedHours: 0, unknownHours: 168, dataSource: 'none' })],
      }),
    ).toEqual([]);
  });

  it('caps the result at 3 opportunities, prioritizing critical over warning over info', () => {
    const opportunities = deriveSavingsOpportunities({
      idleHostFindings: [idleFinding()],
      startVMOnConnect: false,
      hostRuntimeSummaries: [
        runtimeSummary({ sessionHostName: 'avd-con-1', runningHours: 150 }),
        runtimeSummary({ sessionHostName: 'avd-con-2', runningHours: 150 }),
      ],
    });
    expect(opportunities).toHaveLength(3);
    expect(opportunities[0].severity).toBe('critical');
    expect(opportunities[1].severity).toBe('warning');
    expect(opportunities[2].severity).toBe('info');
  });
});

describe('getSavingsOpportunities — single-fetch composition (peer review item 5)', () => {
  it('calls listSessionHosts, listUserSessions, getCurrentScalingPlan, getHostPool, and the LAW presence query EXACTLY ONCE each per request', async () => {
    vi.resetModules();

    const host: SessionHost = {
      id: 'id',
      name: 'avd-con-0',
      hostPoolName: 'HP-CONTOSO-PROD',
      status: 'Available',
      allowNewSession: true,
      activeSessions: 1,
      powerState: 'running',
    };
    const plan: ScalingPlanDetail = {
      id: 'plan-id',
      name: 'SCALE-CONTOSO-PROD',
      hostPoolName: 'HP-CONTOSO-PROD',
      timeZone: 'Eastern Standard Time',
      enabled: true,
      schedules: [
        {
          name: 'AllDays',
          daysOfWeek: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'],
          rampUpStartTime: { hour: 0, minute: 0 },
          peakStartTime: { hour: 0, minute: 0 },
          rampDownStartTime: { hour: 0, minute: 0 },
          offPeakStartTime: { hour: 0, minute: 0 },
        },
      ],
    };

    const listSessionHostsMock = vi.fn().mockResolvedValue([host]);
    const listUserSessionsMock = vi.fn().mockResolvedValue([]);
    const getCurrentScalingPlanMock = vi.fn().mockResolvedValue(plan);
    const getHostPoolMock = vi.fn().mockResolvedValue({ startVMOnConnect: true });

    vi.doMock('./avdService', () => ({
      listSessionHosts: listSessionHostsMock,
      listUserSessions: listUserSessionsMock,
      getCurrentScalingPlan: getCurrentScalingPlanMock,
      getHostPool: getHostPoolMock,
    }));

    const fetchHostHourlyPresenceMock = vi.fn().mockResolvedValue({ seenHoursByHost: new Map(), available: true });
    vi.doMock('./hostRuntimeService', async () => {
      const actual = await vi.importActual<typeof import('./hostRuntimeService')>('./hostRuntimeService');
      return { ...actual, fetchHostHourlyPresence: fetchHostHourlyPresenceMock };
    });

    vi.doMock('../lib/config', () => ({ getConfig: () => ({ hostPoolName: 'HP-CONTOSO-PROD' }) }));

    const { getSavingsOpportunities } = await import('./savingsService');
    await getSavingsOpportunities();

    expect(listSessionHostsMock).toHaveBeenCalledTimes(1);
    expect(listUserSessionsMock).toHaveBeenCalledTimes(1);
    expect(getCurrentScalingPlanMock).toHaveBeenCalledTimes(1);
    expect(getHostPoolMock).toHaveBeenCalledTimes(1);
    expect(fetchHostHourlyPresenceMock).toHaveBeenCalledTimes(1);

    vi.doUnmock('./avdService');
    vi.doUnmock('./hostRuntimeService');
    vi.doUnmock('../lib/config');
    vi.resetModules();
  });
});
