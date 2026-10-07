import { computeScalingPhase } from '@avdmgr/shared';
import type { IdleHostsResult } from '@avdmgr/shared';
import { getConfig } from '../lib/config';
import { getCurrentScalingPlan, listSessionHosts, listUserSessions } from './avdService';
import { detectIdleHosts } from './idleHostDetector';
import { deriveRunningSinceApprox, fetchHostHourlyPresence, normalizeHostName } from './hostRuntimeService';
import { computeSessionCountsByHost, sessionCountsFor } from './sessionCounts';

/**
 * Orchestrates the idle-host detector (pure, see idleHostDetector.ts)
 * against live data: the configured host pool's session hosts (with power
 * state resolved), per-session sessionState (to derive real active vs.
 * disconnected counts — NOT SessionHost.activeSessions, see that field's
 * doc comment in @avdmgr/shared for why), and its current scaling plan's
 * phase.
 *
 * PEER REVIEW FIX (item 12): returns `{ evaluated, findings }` rather than
 * a bare array — `evaluated: false` (no scaling plan associated with the
 * host pool) and a genuine all-clear (evaluated: true, findings: []) both
 * produce an empty findings array, but they mean very different things to
 * an operator ("detection couldn't run" vs. "detection ran, found
 * nothing") and the API must not conflate them.
 */
export async function getIdleHostFindings(warn: (message: string) => void = () => {}, log: (message: string) => void = () => {}): Promise<IdleHostsResult> {
  const { hostPoolName } = getConfig();

  const [plan, hosts, sessions] = await Promise.all([
    getCurrentScalingPlan(),
    listSessionHosts(hostPoolName, { warn }),
    listUserSessions(hostPoolName),
  ]);

  if (!plan) {
    return { evaluated: false, findings: [] };
  }

  const phase = computeScalingPhase(plan);
  const sessionCounts = computeSessionCountsByHost(sessions);

  const findings = detectIdleHosts(
    hosts.map((host) => {
      const counts = sessionCountsFor(sessionCounts, host.name);
      return { hostPoolName, host, phase, activeSessions: counts.active, disconnectedSessions: counts.disconnected };
    }),
  );

  if (findings.length === 0) {
    return { evaluated: true, findings };
  }

  const presence = await fetchHostHourlyPresence(
    findings.map((f) => f.sessionHostName),
    warn,
    log,
  );
  if (!presence.available) {
    return { evaluated: true, findings };
  }

  return {
    evaluated: true,
    findings: findings.map((finding) => {
      const runningSinceApprox = deriveRunningSinceApprox(presence.seenHoursByHost.get(normalizeHostName(finding.sessionHostName)));
      return runningSinceApprox ? { ...finding, runningSinceApprox } : finding;
    }),
  };
}
