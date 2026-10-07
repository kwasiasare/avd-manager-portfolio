import type { GovernanceCheckResult, SessionHost } from '@avdmgr/shared';
import { getConfig } from '../../lib/config';
import { listSessionHosts } from '../avdService';
import { buildResult } from './support';

/*
 * Check 8a (gap register item 13): surfaces the
 * "healthCheckResult: Succeeded but additionalFailureDetails is non-null"
 * pattern already captured for avd-con-0's TURNRelayAccessHealthCheck —
 * reuses avdService.listSessionHosts (the SAME data
 * app/api/src/functions/sessionhosts.ts already fetches for the Host Pool
 * page — see mapHealthCheck in avdService.ts, which already surfaces
 * additionalFailureDetails on the shared HealthCheck DTO) rather than a new
 * ARM call: no new RBAC needed, this check is purely a different
 * PRESENTATION of data this app already reads.
 *
 * resolvePowerState: false (same choice healthSummary.ts makes) — this
 * check only needs status/healthChecks, not VM instanceView, so there is no
 * reason to pay for the extra per-host @azure/arm-compute call.
 */

export function evaluateTurnHealthAdvisory(hosts: SessionHost[]): GovernanceCheckResult {
  const base = { id: 'turn-health-advisory', title: 'Session host health-check advisories', category: 'Monitoring' };

  if (hosts.length === 0) {
    return buildResult({ ...base, status: 'unknown', summary: 'No session hosts found — cannot evaluate health-check advisories.', evidence: {} });
  }

  const advisories = hosts.flatMap((host) =>
    (host.healthChecks ?? [])
      .filter((check) => check.healthCheckResult === 'HealthCheckSucceeded' && Boolean(check.additionalFailureDetails))
      .map((check) => ({ sessionHostName: host.name, checkName: check.name, additionalFailureDetails: check.additionalFailureDetails })),
  );

  const evidence = { hostsChecked: hosts.length, advisories };

  if (advisories.length === 0) {
    return buildResult({ ...base, status: 'pass', summary: `No health checks reporting a hidden advisory across ${hosts.length} session host(s).`, evidence });
  }
  return buildResult({
    ...base,
    status: 'warn',
    summary: `${advisories.length} health check(s) report "Succeeded" but carry embedded failure details — treat as necessary-but-not-sufficient (see gap register item 13).`,
    evidence,
  });
}

export async function fetchTurnHealthAdvisory(): Promise<GovernanceCheckResult> {
  const { hostPoolName } = getConfig();
  const hosts = await listSessionHosts(hostPoolName, { resolvePowerState: false });
  return evaluateTurnHealthAdvisory(hosts);
}
