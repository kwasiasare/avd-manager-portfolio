import { describe, expect, it } from 'vitest';
import type { IdleHostDetectorInput } from './idleHostDetector';
import { detectIdleHost, detectIdleHosts } from './idleHostDetector';

function input(
  overrides: Partial<IdleHostDetectorInput['host']> & {
    phase?: IdleHostDetectorInput['phase'];
    hostPoolName?: string;
    activeSessions?: number;
    disconnectedSessions?: number;
  } = {},
): IdleHostDetectorInput {
  const { phase = 'OffPeak', hostPoolName = 'HP-CONTOSO-PROD', activeSessions = 0, disconnectedSessions = 0, ...hostOverrides } = overrides;
  return {
    hostPoolName,
    phase,
    activeSessions,
    disconnectedSessions,
    host: {
      name: 'avd-con-0',
      powerState: 'running',
      ...hostOverrides,
    },
  };
}

describe('detectIdleHost', () => {
  it('flags a host running in off-peak with zero active sessions and zero disconnected sessions', () => {
    const finding = detectIdleHost(input({ phase: 'OffPeak', activeSessions: 0, disconnectedSessions: 0 }));
    expect(finding).not.toBeNull();
    expect(finding).toMatchObject({
      sessionHostName: 'avd-con-0',
      hostPoolName: 'HP-CONTOSO-PROD',
      powerState: 'running',
      phase: 'OffPeak',
      activeSessions: 0,
      disconnectedSessions: 0,
    });
    expect(finding?.reason).toContain('zero sessions of any kind');
    expect(finding?.reason).not.toContain('matches the documented idle-host leak');
  });

  it('MOTIVATING CASE (avd-con-0): flags a host running off-schedule with zero ACTIVE sessions but one or more DISCONNECTED sessions — the documented idle-host leak', () => {
    const finding = detectIdleHost(input({ phase: 'OffPeak', activeSessions: 0, disconnectedSessions: 1 }));
    expect(finding).not.toBeNull();
    expect(finding?.disconnectedSessions).toBe(1);
    expect(finding?.reason).toContain('idle-host leak');
    expect(finding?.reason).toContain('1 disconnected session');
  });

  it('states the plural correctly for multiple disconnected sessions', () => {
    const finding = detectIdleHost(input({ phase: 'OffPeak', activeSessions: 0, disconnectedSessions: 3 }));
    expect(finding?.reason).toContain('3 disconnected sessions');
  });

  it('flags a host running in ramp-down with zero active sessions', () => {
    const finding = detectIdleHost(input({ phase: 'RampDown', activeSessions: 0 }));
    expect(finding).not.toBeNull();
    expect(finding?.phase).toBe('RampDown');
  });

  it('flags a starting (mid-boot) host the same as running', () => {
    const finding = detectIdleHost(input({ phase: 'OffPeak', powerState: 'starting', activeSessions: 0 }));
    expect(finding).not.toBeNull();
  });

  it('does NOT flag a host running during peak, even with zero sessions', () => {
    expect(detectIdleHost(input({ phase: 'Peak', activeSessions: 0 }))).toBeNull();
  });

  it('does NOT flag a host running during ramp-up, even with zero sessions', () => {
    expect(detectIdleHost(input({ phase: 'RampUp', activeSessions: 0 }))).toBeNull();
  });

  it('does NOT flag a host that is Unscheduled', () => {
    expect(detectIdleHost(input({ phase: 'Unscheduled', activeSessions: 0 }))).toBeNull();
  });

  it('does NOT flag a deallocated host in off-peak (this is the expected/desired state)', () => {
    expect(detectIdleHost(input({ phase: 'OffPeak', powerState: 'deallocated', activeSessions: 0 }))).toBeNull();
  });

  it('does NOT flag a stopping/deallocating host in off-peak (already scaling in)', () => {
    expect(detectIdleHost(input({ phase: 'OffPeak', powerState: 'deallocating', activeSessions: 0 }))).toBeNull();
    expect(detectIdleHost(input({ phase: 'OffPeak', powerState: 'stopping', activeSessions: 0 }))).toBeNull();
  });

  it('does NOT flag a host with unknown power state (cannot confirm it is actually running)', () => {
    expect(detectIdleHost(input({ phase: 'OffPeak', powerState: 'unknown', activeSessions: 0 }))).toBeNull();
  });

  it('does NOT flag a host with unresolved power state (undefined)', () => {
    expect(detectIdleHost(input({ phase: 'OffPeak', powerState: undefined, activeSessions: 0 }))).toBeNull();
  });

  it('does NOT flag a host running off-peak with an active session — zero ACTIVE sessions is required, regardless of disconnected count', () => {
    expect(detectIdleHost(input({ phase: 'OffPeak', activeSessions: 1, disconnectedSessions: 0 }))).toBeNull();
    expect(detectIdleHost(input({ phase: 'RampDown', activeSessions: 2, disconnectedSessions: 5 }))).toBeNull();
  });
});

describe('detectIdleHosts (batch)', () => {
  it('returns only the flagged hosts, preserving order, dropping nulls', () => {
    const findings = detectIdleHosts([
      input({ phase: 'OffPeak', powerState: 'running', activeSessions: 0, disconnectedSessions: 1 }), // flagged
      input({ phase: 'OffPeak', powerState: 'deallocated', activeSessions: 0 }), // not flagged
      input({ phase: 'Peak', powerState: 'running', activeSessions: 0 }), // not flagged
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0].sessionHostName).toBe('avd-con-0');
  });

  it('returns an empty array for an empty input', () => {
    expect(detectIdleHosts([])).toEqual([]);
  });
});
