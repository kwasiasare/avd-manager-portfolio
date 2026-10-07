import { computeScalingPhase } from '@avdmgr/shared';
import type { HostRuntimeSummary, IdleHostFinding, SavingsOpportunity } from '@avdmgr/shared';
import { getConfig } from '../lib/config';
import { getCurrentScalingPlan, getHostPool, listSessionHosts, listUserSessions } from './avdService';
import { detectIdleHosts } from './idleHostDetector';
import { deriveRunningSinceApprox, fetchHostHourlyPresence, normalizeHostName, summarizeHostRuntime } from './hostRuntimeService';
import { computeSessionCountsByHost, sessionCountsFor } from './sessionCounts';

/** A host running >= this fraction of the 7-day lookback window is called out as a running-hours outlier worth reviewing against the schedule. */
const RUNNING_HOURS_OUTLIER_RATIO = 0.6;
/** Server-derived savings callouts are capped at 3, per the AM-25 story ("derive 1-3 opportunity strings"). */
const MAX_OPPORTUNITIES = 3;

export interface SavingsInputs {
  idleHostFindings: IdleHostFinding[];
  /** undefined when the host pool detail lookup itself failed — treated as "unknown", not flagged either way. */
  startVMOnConnect: boolean | undefined;
  hostRuntimeSummaries: HostRuntimeSummary[];
}

function pluralHosts(count: number): string {
  return count === 1 ? 'host' : 'hosts';
}

/**
 * Pure derivation of 1-3 SavingsOpportunity items from data this app
 * already computes elsewhere (idle-host findings, the host pool's
 * StartVMOnConnect setting, and running-vs-deallocated hours per host) —
 * kept typed and structured (see @avdmgr/shared's SavingsOpportunity) so
 * the frontend renders these as data, not by parsing free-form prose.
 * Ordered by severity (critical, then warning, then info) before capping
 * at MAX_OPPORTUNITIES, so a genuine misconfiguration is never pushed out
 * by a lower-priority observation.
 */
export function deriveSavingsOpportunities(input: SavingsInputs): SavingsOpportunity[] {
  const opportunities: SavingsOpportunity[] = [];

  if (input.startVMOnConnect === false) {
    opportunities.push({
      severity: 'critical',
      title: 'Start VM on Connect is disabled',
      detail:
        "SCALE-CONTOSO-PROD scales to 0 minimum hosts at every phase (ramp-up, peak, ramp-down, off-peak). Without Start VM on Connect, users have no way to reach a desktop once every host has deallocated — see the scaling-and-cost runbook §2.",
    });
  }

  if (input.idleHostFindings.length > 0) {
    const names = input.idleHostFindings.map((finding) => finding.sessionHostName).join(', ');
    opportunities.push({
      severity: 'warning',
      title: `${input.idleHostFindings.length} ${pluralHosts(input.idleHostFindings.length)} running off-schedule`,
      detail: `${names} — running with zero active sessions during a phase the schedule expects hosts to be scaling in. See each host's own evidence on the idle-host list for whether this is the documented disconnected-session leak or something else.`,
    });
  }

  for (const summary of input.hostRuntimeSummaries) {
    if (summary.dataSource !== 'WVDAgentHealthStatus' || summary.windowHours === 0) {
      continue;
    }
    const runningRatio = summary.runningHours / summary.windowHours;
    if (runningRatio >= RUNNING_HOURS_OUTLIER_RATIO) {
      opportunities.push({
        severity: 'info',
        title: `${summary.sessionHostName} ran ${Math.round(runningRatio * 100)}% of the last ${summary.windowHours}h observed`,
        detail: `${summary.runningHours} of ${summary.windowHours} hours with agent activity (a coarse presence signal, not exact power-on time — see the Cost & Scaling page's data-source note). Worth checking against the SCALE-CONTOSO-PROD schedule if this is unexpected.`,
      });
    }
  }

  return opportunities.slice(0, MAX_OPPORTUNITIES);
}

/**
 * Fetches the data 1-3 SavingsOpportunity items are derived from — exactly
 * ONE round of each underlying call, then composes idle-host detection and
 * host-runtime summaries from that single fetch, rather than delegating to
 * idleHostsService.getIdleHostFindings / hostRuntimeService.
 * getHostRuntimeSummaries (which would each independently re-fetch the
 * session-host list and the WVDAgentHealthStatus presence data).
 *
 * PEER REVIEW FIX (item 5): the original version called those two
 * convenience wrappers directly, which meant a single /v1/cost/savings
 * request issued listSessionHosts (with N+1 power-state resolution) TWICE
 * and the WVDAgentHealthStatus LAW query TWICE within the same request.
 * This version fetches the scaling plan, session hosts, user sessions, and
 * host pool detail exactly once each (in parallel), derives idle-host
 * findings and host-runtime summaries directly from that shared data using
 * the same pure/composable pieces those wrappers use internally
 * (detectIdleHosts, summarizeHostRuntime, deriveRunningSinceApprox), and
 * issues the LAW presence query exactly once.
 *
 * Each source still degrades independently on failure (matching this
 * app's per-source-degrades convention — see
 * app/api/src/services/avdService.ts's resolvePowerState doc comment for
 * the same pattern at a smaller scale): a failure in one does not block
 * deriving opportunities from the others.
 */
export async function getSavingsOpportunities(warn: (message: string) => void = () => {}, log: (message: string) => void = () => {}): Promise<SavingsOpportunity[]> {
  const { hostPoolName } = getConfig();
  const startedAt = Date.now();

  const [plan, hosts, sessions, hostPool] = await Promise.all([
    getCurrentScalingPlan().catch((error: unknown) => {
      warn(`Scaling plan lookup failed while deriving savings opportunities: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }),
    listSessionHosts(hostPoolName, { warn }).catch((error: unknown) => {
      warn(`Session host list failed while deriving savings opportunities: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }),
    listUserSessions(hostPoolName).catch((error: unknown) => {
      warn(`User session list failed while deriving savings opportunities: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }),
    getHostPool(hostPoolName).catch((error: unknown) => {
      warn(`Host pool lookup failed while deriving savings opportunities: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }),
  ]);

  let idleHostFindings: IdleHostFinding[] = [];
  if (plan) {
    const phase = computeScalingPhase(plan);
    const sessionCounts = computeSessionCountsByHost(sessions);
    idleHostFindings = detectIdleHosts(
      hosts.map((host) => {
        const counts = sessionCountsFor(sessionCounts, host.name);
        return { hostPoolName, host, phase, activeSessions: counts.active, disconnectedSessions: counts.disconnected };
      }),
    );
  }

  const presence =
    hosts.length > 0
      ? await fetchHostHourlyPresence(
          hosts.map((host) => host.name),
          warn,
          log,
        )
      : { seenHoursByHost: new Map<string, Set<number>>(), available: true };

  if (idleHostFindings.length > 0 && presence.available) {
    idleHostFindings = idleHostFindings.map((finding) => {
      const runningSinceApprox = deriveRunningSinceApprox(presence.seenHoursByHost.get(normalizeHostName(finding.sessionHostName)));
      return runningSinceApprox ? { ...finding, runningSinceApprox } : finding;
    });
  }

  const hostRuntimeSummaries = hosts.map((host) => summarizeHostRuntime(host.name, hostPoolName, presence));

  log(`Savings opportunities derived in ${Date.now() - startedAt}ms from ${hosts.length} host(s), ${idleHostFindings.length} idle finding(s)`);

  return deriveSavingsOpportunities({
    idleHostFindings,
    startVMOnConnect: hostPool?.startVMOnConnect,
    hostRuntimeSummaries,
  });
}
