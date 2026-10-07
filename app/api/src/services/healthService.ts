import type { HealthSummary, SessionHost } from '@avdmgr/shared';

/**
 * Categorises a session host into exactly one bucket for the dashboard's
 * health ring:
 *   - draining: allowNewSession is false. Takes priority over status —
 *     an operator who has drained a host wants that reflected even if the
 *     underlying agent still reports status 'Available'.
 *   - available: allowNewSession is true AND status is 'Available'.
 *   - unavailable: everything else (NoHeartbeat, Upgrading, Shutdown, etc).
 */
export type HealthBucket = 'available' | 'unavailable' | 'draining';

export function categorizeSessionHost(host: Pick<SessionHost, 'status' | 'allowNewSession'>): HealthBucket {
  if (!host.allowNewSession) {
    return 'draining';
  }
  return host.status === 'Available' ? 'available' : 'unavailable';
}

/**
 * Aggregates a host pool's session hosts into the GET /api/v1/health/summary
 * shape. `sessionsMax` is `sessionHosts.length * maxSessionLimit` when
 * maxSessionLimit is known, otherwise omitted (0) — the caller (the
 * health-summary function) is expected to pass the host pool's
 * maxSessionLimit through.
 */
export function computeHealthSummary(hostPoolName: string, sessionHosts: SessionHost[], maxSessionLimitPerHost: number | undefined): HealthSummary {
  const counts = { available: 0, unavailable: 0, draining: 0 };
  let sessionsUsed = 0;

  for (const host of sessionHosts) {
    counts[categorizeSessionHost(host)] += 1;
    sessionsUsed += host.activeSessions;
  }

  return {
    hostPoolName,
    total: sessionHosts.length,
    available: counts.available,
    unavailable: counts.unavailable,
    draining: counts.draining,
    sessionsUsed,
    sessionsMax: maxSessionLimitPerHost ? maxSessionLimitPerHost * sessionHosts.length : 0,
  };
}
