import type { IntunePolicyHealthHost, IntunePolicyHealthStatus } from '@avdmgr/shared';
import type { StatusTone } from '../components/StatusBadge';

/**
 * AM-52 — per-host Intune policy-health chip/badge, shown alongside the
 * existing health-checks chip on SessionHostCard/the Session hosts DataTable
 * and expanded in HealthChecksDrawer's Intune section. Intune policy health
 * arrives from a SEPARATE endpoint (GET .../policy-health) than the
 * SessionHost list itself — see HostPool.tsx — so it is always passed as a
 * SIBLING prop, never folded into SessionHostViewModel/toSessionHostViewModel.
 */
export const POLICY_HEALTH_STATUS_LABEL: Record<IntunePolicyHealthStatus, string> = {
  ok: 'Intune: OK',
  'policy-errors': 'Policy errors',
  'missing-admx': 'ADMX missing',
  'not-enrolled': 'Not enrolled',
  unknown: 'Unknown',
};

/**
 * 'missing-admx' is the one status severe enough for 'error' — it is the
 * live-verified, specifically-actionable signature this feature exists to
 * catch (the FSLogix storage runbook §5.1), with a known fix.
 * 'policy-errors'/'not-enrolled' are 'warning' — worth a look, but not
 * necessarily THIS app's documented failure mode. 'unknown' never
 * masquerades as any of the above (a missing Graph grant or a transient
 * per-host failure is not evidence of either a healthy or an unhealthy
 * device).
 */
export const POLICY_HEALTH_STATUS_TONE: Record<IntunePolicyHealthStatus, StatusTone> = {
  ok: 'ok',
  'policy-errors': 'warning',
  'missing-admx': 'error',
  'not-enrolled': 'warning',
  unknown: 'unknown',
};

/** Synthetic 'unknown' result for a host the Intune policy-health poll hasn't reported on (still loading, or the poll itself failed) — deliberately distinct from a REAL 'unknown' the API returned (e.g. Graph permission not granted), but rendered identically: this app has no basis to claim otherwise in either case. Never blocks rendering the host list, which comes from a separate poll — see HostPool.tsx. */
export function unknownPolicyHealth(hostName: string): IntunePolicyHealthHost {
  return { hostName, status: 'unknown', evidence: { admxSignatureDetectable: false } };
}

/** Builds a hostName -> result lookup from GET .../policy-health's flat array, keyed case-insensitively (matches this app's session-host naming convention elsewhere). */
export function toPolicyHealthByHost(hosts: IntunePolicyHealthHost[] | undefined): Map<string, IntunePolicyHealthHost> {
  const map = new Map<string, IntunePolicyHealthHost>();
  for (const host of hosts ?? []) {
    map.set(host.hostName.toLowerCase(), host);
  }
  return map;
}

/** Looks up one host's result, falling back to unknownPolicyHealth when the poll hasn't reported on this host name at all. */
export function lookupPolicyHealth(byHost: Map<string, IntunePolicyHealthHost>, hostName: string): IntunePolicyHealthHost {
  return byHost.get(hostName.toLowerCase()) ?? unknownPolicyHealth(hostName);
}
