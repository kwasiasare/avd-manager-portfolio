import { describe, expect, it } from 'vitest';
import { isAffectedHost, selectAffectedHosts, selectSessionsOnHosts } from './incidentView';
import type { SessionHostViewModel } from './sessionHostViewModel';
import type { UserSession } from '@avdmgr/shared';

type HostFixture = Pick<SessionHostViewModel, 'tone' | 'allowNewSession' | 'healthCheckSummary'>;

function host(overrides: Partial<HostFixture> = {}): HostFixture {
  return { tone: 'ok', allowNewSession: true, healthCheckSummary: undefined, ...overrides };
}

describe('isAffectedHost', () => {
  it('flags tone warning', () => {
    expect(isAffectedHost(host({ tone: 'warning' }))).toBe(true);
  });

  it('flags tone error', () => {
    expect(isAffectedHost(host({ tone: 'error' }))).toBe(true);
  });

  it('flags a draining host even when tone is ok', () => {
    expect(isAffectedHost(host({ tone: 'ok', allowNewSession: false }))).toBe(true);
  });

  it('does not flag a healthy, non-draining, ok host', () => {
    expect(isAffectedHost(host({ tone: 'ok', allowNewSession: true }))).toBe(false);
  });

  it('does not flag a plain pending (Shutdown) host with no other issue', () => {
    expect(isAffectedHost(host({ tone: 'pending', allowNewSession: true, healthCheckSummary: undefined }))).toBe(false);
  });

  it('does not flag a pending host with a fully-passing health check summary', () => {
    expect(isAffectedHost(host({ tone: 'pending', healthCheckSummary: { passed: 3, total: 3 } }))).toBe(false);
  });

  it('flags a pending host that also has a failing/warning health check ("pending-with-issues")', () => {
    expect(isAffectedHost(host({ tone: 'pending', healthCheckSummary: { passed: 2, total: 3 } }))).toBe(true);
  });

  it('flags info tone treated as not-ok? (info is not warning/error) — stays unaffected unless draining/pending-with-issues', () => {
    // 'info' never actually appears as a SessionHostViewModel tone in practice
    // (see sessionHostStatusTone's own doc comment), but the helper's logic
    // only special-cases 'warning'/'error'/'pending' — anything else (an
    // undocumented future tone) falls through to "not affected" unless
    // draining, same as 'ok'.
    expect(isAffectedHost(host({ tone: 'info' as SessionHostViewModel['tone'] }))).toBe(false);
  });
});

describe('selectAffectedHosts', () => {
  it('returns only the affected hosts, allHealthy false, when at least one is affected', () => {
    const healthy = host({ tone: 'ok' });
    const sick = host({ tone: 'error' });
    const result = selectAffectedHosts([healthy, sick]);
    expect(result.allHealthy).toBe(false);
    expect(result.hosts).toEqual([sick]);
  });

  it('returns the full list with allHealthy true when every host is healthy', () => {
    const a = host({ tone: 'ok' });
    const b = host({ tone: 'ok' });
    const result = selectAffectedHosts([a, b]);
    expect(result.allHealthy).toBe(true);
    expect(result.hosts).toEqual([a, b]);
  });

  it('returns the full (empty) list with allHealthy true when there are no hosts at all', () => {
    const result = selectAffectedHosts([]);
    expect(result.allHealthy).toBe(true);
    expect(result.hosts).toEqual([]);
  });

  it('a draining-but-otherwise-ok host is included among the affected set', () => {
    const draining = host({ tone: 'ok', allowNewSession: false });
    const healthy = host({ tone: 'ok', allowNewSession: true });
    const result = selectAffectedHosts([draining, healthy]);
    expect(result.allHealthy).toBe(false);
    expect(result.hosts).toEqual([draining]);
  });
});

describe('selectSessionsOnHosts', () => {
  function session(overrides: Partial<UserSession> = {}): UserSession {
    return {
      id: 'id-1',
      sessionId: '1',
      userPrincipalName: 'user@example.com',
      sessionHostName: 'host-a',
      hostPoolName: 'HP-CONTOSO-PROD',
      sessionState: 'Active',
      createTime: new Date().toISOString(),
      ...overrides,
    };
  }

  it('returns an empty array when hostNames is empty', () => {
    expect(selectSessionsOnHosts([session()], [])).toEqual([]);
  });

  it('filters to only sessions on the named hosts', () => {
    const onA = session({ id: 'a1', sessionHostName: 'host-a' });
    const onB = session({ id: 'b1', sessionHostName: 'host-b' });
    const onC = session({ id: 'c1', sessionHostName: 'host-c' });
    expect(selectSessionsOnHosts([onA, onB, onC], ['host-a', 'host-c'])).toEqual([onA, onC]);
  });

  it('returns an empty array when no session matches any named host', () => {
    const onA = session({ sessionHostName: 'host-a' });
    expect(selectSessionsOnHosts([onA], ['host-z'])).toEqual([]);
  });
});
