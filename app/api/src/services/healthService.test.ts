import { describe, expect, it } from 'vitest';
import type { SessionHost } from '@avdmgr/shared';
import { categorizeSessionHost, computeHealthSummary } from './healthService';

function host(overrides: Partial<SessionHost> = {}): SessionHost {
  return {
    id: 'id',
    name: 'HP-CONTOSO-PROD/avd-con-0',
    hostPoolName: 'HP-CONTOSO-PROD',
    status: 'Available',
    allowNewSession: true,
    activeSessions: 0,
    ...overrides,
  };
}

describe('categorizeSessionHost', () => {
  it('categorizes an available, non-draining host as available', () => {
    expect(categorizeSessionHost(host())).toBe('available');
  });

  it('categorizes a host with allowNewSession=false as draining, regardless of status', () => {
    expect(categorizeSessionHost(host({ allowNewSession: false, status: 'Available' }))).toBe('draining');
  });

  it('categorizes a non-Available, non-draining host as unavailable', () => {
    expect(categorizeSessionHost(host({ status: 'NoHeartbeat' }))).toBe('unavailable');
  });
});

describe('computeHealthSummary', () => {
  it('aggregates counts and session totals across hosts', () => {
    const hosts = [
      host({ status: 'Available', allowNewSession: true, activeSessions: 3 }),
      host({ status: 'NoHeartbeat', allowNewSession: true, activeSessions: 0 }),
      host({ status: 'Available', allowNewSession: false, activeSessions: 1 }),
    ];

    expect(computeHealthSummary('HP-CONTOSO-PROD', hosts, 8)).toEqual({
      hostPoolName: 'HP-CONTOSO-PROD',
      total: 3,
      available: 1,
      unavailable: 1,
      draining: 1,
      sessionsUsed: 4,
      sessionsMax: 24,
    });
  });

  it('handles an empty host pool', () => {
    expect(computeHealthSummary('HP-CONTOSO-PROD', [], 8)).toEqual({
      hostPoolName: 'HP-CONTOSO-PROD',
      total: 0,
      available: 0,
      unavailable: 0,
      draining: 0,
      sessionsUsed: 0,
      sessionsMax: 0,
    });
  });

  it('reports sessionsMax as 0 when maxSessionLimit is unknown', () => {
    expect(computeHealthSummary('HP-CONTOSO-PROD', [host()], undefined).sessionsMax).toBe(0);
  });
});
