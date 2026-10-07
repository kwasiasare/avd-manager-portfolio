import { describe, expect, it } from 'vitest';
import type { UserSession } from '@avdmgr/shared';
import { computeSessionCountsByHost, sessionCountsFor } from './sessionCounts';

function session(overrides: Partial<UserSession> = {}): UserSession {
  return {
    id: 'id',
    userPrincipalName: 'user@example.com',
    sessionHostName: 'avd-con-0',
    hostPoolName: 'HP-CONTOSO-PROD',
    sessionState: 'Active',
    createTime: new Date(0).toISOString(),
    ...overrides,
  };
}

describe('computeSessionCountsByHost', () => {
  it('counts Active and Disconnected sessions separately, per host', () => {
    const counts = computeSessionCountsByHost([
      session({ sessionHostName: 'avd-con-0', sessionState: 'Active' }),
      session({ sessionHostName: 'avd-con-0', sessionState: 'Disconnected' }),
      session({ sessionHostName: 'avd-con-0', sessionState: 'Disconnected' }),
      session({ sessionHostName: 'avd-con-1', sessionState: 'Active' }),
    ]);

    expect(counts.get('avd-con-0')).toEqual({ active: 1, disconnected: 2 });
    expect(counts.get('avd-con-1')).toEqual({ active: 1, disconnected: 0 });
  });

  it('does not count Pending/LogOff/UserProfileDiskMounted/Unknown as active or disconnected', () => {
    const counts = computeSessionCountsByHost([
      session({ sessionState: 'Pending' }),
      session({ sessionState: 'LogOff' }),
      session({ sessionState: 'UserProfileDiskMounted' }),
      session({ sessionState: 'Unknown' }),
    ]);
    expect(counts.get('avd-con-0')).toEqual({ active: 0, disconnected: 0 });
  });

  it('returns an empty map for no sessions', () => {
    expect(computeSessionCountsByHost([]).size).toBe(0);
  });
});

describe('sessionCountsFor', () => {
  it('returns zero counts for a host with no entry in the map', () => {
    expect(sessionCountsFor(new Map(), 'avd-con-9')).toEqual({ active: 0, disconnected: 0 });
  });

  it('returns the mapped counts for a host with an entry', () => {
    const counts = new Map([['avd-con-0', { active: 2, disconnected: 1 }]]);
    expect(sessionCountsFor(counts, 'avd-con-0')).toEqual({ active: 2, disconnected: 1 });
  });
});
