import { describe, expect, it } from 'vitest';
import type { SessionHost } from '@avdmgr/shared';
import { evaluateTurnHealthAdvisory } from './turnHealthAdvisory';

function host(overrides: Partial<SessionHost> = {}): SessionHost {
  return { id: '/hp/avd-con-0', name: 'avd-con-0', hostPoolName: 'HP-CONTOSO-PROD', status: 'Available', allowNewSession: true, activeSessions: 0, ...overrides };
}

describe('evaluateTurnHealthAdvisory', () => {
  it('is unknown when there are no session hosts to evaluate', () => {
    const result = evaluateTurnHealthAdvisory([]);
    expect(result.status).toBe('unknown');
  });

  it('passes when every health check is clean', () => {
    const result = evaluateTurnHealthAdvisory([host({ healthChecks: [{ name: 'DomainJoinedCheck', healthCheckResult: 'HealthCheckSucceeded' }] })]);
    expect(result.status).toBe('pass');
  });

  it('warns on avd-con-0\'s captured TURNRelayAccessHealthCheck advisory (gap register item 13: Succeeded but with embedded additionalFailureDetails)', () => {
    const result = evaluateTurnHealthAdvisory([
      host({
        healthChecks: [
          {
            name: 'TURNRelayAccessHealthCheck',
            healthCheckResult: 'HealthCheckSucceeded',
            additionalFailureDetails: 'NAT shape is Undetermined when probing [turn:51.5.255.240:3478?Udp] ... Timed out waiting for Receive to complete',
          },
        ],
      }),
    ]);
    expect(result.status).toBe('warn');
    expect(result.summary).toContain('gap register item 13');
    expect(result.evidence.advisories).toEqual([{ sessionHostName: 'avd-con-0', checkName: 'TURNRelayAccessHealthCheck', additionalFailureDetails: expect.stringContaining('Timed out') }]);
  });

  it('does not flag a genuinely failed health check (no advisory to hide — that is a different, already-visible signal)', () => {
    const result = evaluateTurnHealthAdvisory([host({ healthChecks: [{ name: 'UrlsAccessibleCheck', healthCheckResult: 'HealthCheckFailed', additionalFailureDetails: 'DNS resolution failed' }] })]);
    expect(result.status).toBe('pass');
  });
});
