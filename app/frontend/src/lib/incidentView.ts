import type { UserSession } from '@avdmgr/shared';
import type { SessionHostViewModel } from './sessionHostViewModel';

/**
 * AM-34 (M8-W5 — D6 "incident mode"): pure, React-free helpers behind the
 * Incident page's (pages/Incident.tsx) "Affected hosts" section. Mirrors
 * this app's existing lib/*.ts convention (sessionRows.ts, impactPreview.ts,
 * ...) of keeping table/list-shaping logic out of the component so it's
 * directly unit-testable (see incidentView.test.ts) without a DOM.
 *
 * A host counts as "affected" — worth an operator's attention mid-incident —
 * when ANY of these hold, each computed from the SAME SessionHostViewModel
 * (lib/sessionHostViewModel.ts) both Dashboard and HostPool already build
 * their SessionHostCard grids from (no new view model, no new read):
 *
 *   - tone is 'warning' or 'error' — sessionHostViewModel's own escalateTone
 *     already folds in unavailable/no-heartbeat ARM status, a stale
 *     heartbeat while running, and failing/warning health checks. Nothing
 *     to re-derive here.
 *   - !allowNewSession (draining) — escalateTone deliberately never looks at
 *     this field (it's an administrative state, not a health signal), but a
 *     draining host is exactly the kind of thing an incident operator needs
 *     in view, regardless of whether its ARM status itself still reads 'ok'.
 *   - tone is 'pending' (i.e. status 'Shutdown' — see sessionHostStatusTone's
 *     doc comment; the ONLY status that maps to 'pending') AND it has a
 *     reported health-check problem. A calmly, deliberately shut-off host
 *     with nothing else wrong is NOT an incident — that's just the host
 *     being off. But a shut-off host that's ALSO reporting failing/warning
 *     health checks (stale data from before it went down, most likely) is
 *     still worth surfacing rather than silently filtering out.
 */
export function isAffectedHost(host: Pick<SessionHostViewModel, 'tone' | 'allowNewSession' | 'healthCheckSummary'>): boolean {
  if (host.tone === 'warning' || host.tone === 'error') return true;
  if (!host.allowNewSession) return true;
  if (host.tone === 'pending') {
    const summary = host.healthCheckSummary;
    if (summary && summary.passed < summary.total) return true;
  }
  return false;
}

export interface AffectedHostsSelection<T> {
  hosts: T[];
  /**
   * True when every host is healthy — `hosts` above is then the FULL,
   * UNFILTERED list (not empty) so the page can render a calm "no affected
   * hosts — showing all" note alongside the complete host list, rather than
   * an empty-state message that would read as "no hosts exist at all".
   */
  allHealthy: boolean;
}

/**
 * Filters `hosts` down to the affected subset (see isAffectedHost). When
 * NONE are affected, returns the full, unfiltered list with `allHealthy:
 * true` instead of an empty array — see AffectedHostsSelection's own doc
 * comment for why. Generic over `T` (rather than hard-coding
 * SessionHostViewModel) purely so the pure-logic unit tests can exercise it
 * against minimal fixture shapes without constructing a full view model.
 */
export function selectAffectedHosts<T extends Pick<SessionHostViewModel, 'tone' | 'allowNewSession' | 'healthCheckSummary'>>(hosts: T[]): AffectedHostsSelection<T> {
  const affected = hosts.filter(isAffectedHost);
  if (affected.length === 0) {
    return { hosts, allHealthy: true };
  }
  return { hosts: affected, allHealthy: false };
}

/**
 * Sessions whose sessionHostName is one of `hostNames` — feeds the
 * "Sessions on affected hosts" list. Computed entirely from the Sessions
 * page's own already-fetched session shape (no new read) filtered against
 * whichever host names selectAffectedHosts above resolved for the current
 * render — including every host when `allHealthy` is true, matching that
 * section's own "showing all" fallback.
 */
export function selectSessionsOnHosts(sessions: readonly UserSession[], hostNames: readonly string[]): UserSession[] {
  if (hostNames.length === 0) return [];
  const nameSet = new Set(hostNames);
  return sessions.filter((session) => nameSet.has(session.sessionHostName));
}
