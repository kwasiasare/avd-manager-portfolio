import type { UserSession } from '@avdmgr/shared';

/** Active vs. disconnected session counts for one session host. */
export interface SessionCounts {
  active: number;
  disconnected: number;
}

/**
 * Groups a host pool's user sessions (from avdService.ts#listUserSessions —
 * the ARM userSessions.listByHostPool response, which carries real
 * per-session sessionState) by session host name, counting Active vs.
 * Disconnected separately.
 *
 * Extracted as its own pure module (AM-25 peer review) specifically so
 * idleHostsService.ts and savingsService.ts can both derive the SAME
 * active/disconnected counts from a SINGLE listUserSessions call, rather
 * than each re-deriving it (or, worse, falling back to
 * SessionHost.activeSessions — ARM's undifferentiated total — which cannot
 * tell "genuinely busy" apart from "only has a stale disconnected
 * session," the exact case the idle-host detector exists to catch).
 * `sessionHostName` on UserSession is already the short host name (parsed
 * server-side from the ARM session id — see
 * avdService.ts#sessionHostNameFromUserSessionId), so no FQDN/case
 * normalization is needed here, unlike hostRuntimeService.ts's LAW-sourced
 * host names.
 */
export function computeSessionCountsByHost(sessions: UserSession[]): Map<string, SessionCounts> {
  const counts = new Map<string, SessionCounts>();

  for (const session of sessions) {
    const entry = counts.get(session.sessionHostName) ?? { active: 0, disconnected: 0 };
    if (session.sessionState === 'Active') {
      entry.active += 1;
    } else if (session.sessionState === 'Disconnected') {
      entry.disconnected += 1;
    }
    counts.set(session.sessionHostName, entry);
  }

  return counts;
}

/** Convenience accessor — returns {active: 0, disconnected: 0} for a host with no sessions at all, rather than undefined. */
export function sessionCountsFor(counts: Map<string, SessionCounts>, sessionHostName: string): SessionCounts {
  return counts.get(sessionHostName) ?? { active: 0, disconnected: 0 };
}
