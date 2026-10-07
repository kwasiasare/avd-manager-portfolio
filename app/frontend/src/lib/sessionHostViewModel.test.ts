import { describe, expect, it } from 'vitest';
import type { SessionHost } from '@avdmgr/shared';
import { healthCheckSeverity, toSessionHostViewModel } from './sessionHostViewModel';

const NOW = new Date('2026-08-16T12:00:00.000Z');

function makeHost(overrides: Partial<SessionHost> = {}): SessionHost {
  return {
    id: 'host-1',
    name: 'avd-con-0',
    hostPoolName: 'HP-CONTOSO-PROD',
    status: 'Available',
    allowNewSession: true,
    activeSessions: 2,
    ...overrides,
  } as SessionHost;
}

describe('toSessionHostViewModel', () => {
  it('derives tone from sessionHostStatusTone', () => {
    expect(toSessionHostViewModel(makeHost({ status: 'Available' })).tone).toBe('ok');
    expect(toSessionHostViewModel(makeHost({ status: 'Unavailable' })).tone).toBe('error');
    expect(toSessionHostViewModel(makeHost({ status: 'Shutdown' })).tone).toBe('pending');
  });

  it('marks heartbeatStale only for a running host with no heartbeat in over 30 minutes', () => {
    const stale = toSessionHostViewModel(makeHost({ powerState: 'running', lastHeartBeat: '2026-08-16T11:00:00.000Z' }), { now: NOW });
    expect(stale.heartbeatStale).toBe(true);

    const fresh = toSessionHostViewModel(makeHost({ powerState: 'running', lastHeartBeat: '2026-08-16T11:55:00.000Z' }), { now: NOW });
    expect(fresh.heartbeatStale).toBe(false);

    // Not running — staleness doesn't apply even with an old heartbeat.
    const deallocated = toSessionHostViewModel(makeHost({ powerState: 'deallocated', lastHeartBeat: '2026-08-16T09:00:00.000Z' }), { now: NOW });
    expect(deallocated.heartbeatStale).toBe(false);
  });

  it('computes a healthCheckSummary only when at least one check was reported', () => {
    const withChecks = toSessionHostViewModel(
      makeHost({
        healthChecks: [
          { name: 'A', healthCheckResult: 'HealthCheckSucceeded' },
          { name: 'B', healthCheckResult: 'HealthCheckFailed' },
        ],
      }),
    );
    expect(withChecks.healthCheckSummary).toEqual({ passed: 1, total: 2 });

    const noChecks = toSessionHostViewModel(makeHost({ healthChecks: [] }));
    expect(noChecks.healthCheckSummary).toBeUndefined();

    const undefinedChecks = toSessionHostViewModel(makeHost({ healthChecks: undefined }));
    expect(undefinedChecks.healthCheckSummary).toBeUndefined();
  });

  it('passes maxSessions through undefined when not supplied', () => {
    expect(toSessionHostViewModel(makeHost()).maxSessions).toBeUndefined();
    expect(toSessionHostViewModel(makeHost(), { maxSessions: 12 }).maxSessions).toBe(12);
  });
});

describe('healthCheckSeverity', () => {
  it('treats TURN relay failures as a warning, not a failure', () => {
    expect(healthCheckSeverity({ name: 'TURNRelayAccessHealthCheck', healthCheckResult: 'HealthCheckFailed' })).toBe('warn');
  });

  it('treats other failed checks as a failure', () => {
    expect(healthCheckSeverity({ name: 'DomainReachable', healthCheckResult: 'HealthCheckFailed' })).toBe('fail');
  });

  it('treats a succeeded check as ok', () => {
    expect(healthCheckSeverity({ name: 'DomainReachable', healthCheckResult: 'HealthCheckSucceeded' })).toBe('ok');
  });
});
