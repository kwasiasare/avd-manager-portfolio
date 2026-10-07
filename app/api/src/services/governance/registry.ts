import type { GovernanceCheckResult } from '@avdmgr/shared';
import { fetchBudgetCheck } from './budgetCheck';
import { fetchConditionalAccessBreakGlass } from './conditionalAccessBreakGlass';
import { fetchDeleteLocks } from './deleteLocks';
import { fetchDiagnosticSettingsCoverage } from './diagnosticSettingsCoverage';
import { fetchFslogixPublicNetworkAccess } from './fslogixPublicNetworkAccess';
import { fetchKeyVaultPurgeProtection } from './keyVaultPurgeProtection';
import { fetchLawIngestionCap } from './lawIngestionCap';
import { fetchOrphanedResources } from './orphanedResources';
import { fetchPrivateEndpoints } from './privateEndpoints';
import { fetchStorageDeleteLocks } from './storageDeleteLocks';
import { fetchStoragePrivilegedAccess } from './storagePrivilegedAccess';
import { runCheckSafely, type GovernanceLogger } from './support';
import { fetchTurnHealthAdvisory } from './turnHealthAdvisory';

/**
 * AM-16 (M3b) — the Governance page's check registry. Adding a new check is
 * meant to be a pure ADDITION here (plus its own services/governance/*.ts
 * file) — governanceService.ts, the HTTP function, and the frontend page
 * all iterate this list generically and never need to change for a new
 * entry, per the story's "future checks are additions, not rewrites"
 * requirement.
 */
export interface GovernanceCheckDefinition {
  id: string;
  title: string;
  category: string;
  fetch: () => Promise<GovernanceCheckResult>;
}

export const GOVERNANCE_CHECKS: readonly GovernanceCheckDefinition[] = [
  { id: 'kv-purge-protection', title: 'Key Vault purge protection', category: 'Security', fetch: fetchKeyVaultPurgeProtection },
  { id: 'fslogix-public-network-access', title: 'FSLogix storage account public network access', category: 'Security', fetch: fetchFslogixPublicNetworkAccess },
  { id: 'private-endpoints-health', title: 'Private endpoint approval & health', category: 'Networking', fetch: fetchPrivateEndpoints },
  { id: 'diagnostic-settings-coverage', title: 'Diagnostic settings coverage', category: 'Monitoring', fetch: fetchDiagnosticSettingsCoverage },
  { id: 'budget-sanity', title: 'Budget existence & sanity', category: 'Cost', fetch: fetchBudgetCheck },
  { id: 'delete-locks', title: 'Resource delete locks', category: 'Security', fetch: fetchDeleteLocks },
  { id: 'orphaned-resources', title: 'Orphaned & untagged resource scan', category: 'Hygiene', fetch: fetchOrphanedResources },
  { id: 'turn-health-advisory', title: 'Session host health-check advisories', category: 'Monitoring', fetch: fetchTurnHealthAdvisory },
  { id: 'law-ingestion-cap', title: 'Log Analytics daily ingestion cap', category: 'Monitoring', fetch: fetchLawIngestionCap },
  { id: 'ca-policy-breakglass', title: 'Conditional Access break-glass exclusions', category: 'Identity', fetch: fetchConditionalAccessBreakGlass },
  // AM-56 — privileged storage-grant watchdog + storage delete-lock hygiene (motivated by the 2026-08-22 temp-grant/lock-lift incident — see each check's own header comment).
  { id: 'storage-privileged-access', title: 'Privileged storage-account data-plane grants', category: 'Security', fetch: fetchStoragePrivilegedAccess },
  { id: 'storage-delete-locks', title: 'FSLogix storage account delete locks', category: 'Security', fetch: fetchStorageDeleteLocks },
];

/**
 * Peer review item 8 ("overall deadline consideration on runAllChecks"):
 * this registry's actual worst-case wall time is a PRODUCT of two bounded
 * quantities, not an unbounded wait — support.ts's runCheckSafely already
 * bounds every SINGLE check to CHECK_TIMEOUT_MS (25s, including retries),
 * and CONCURRENCY below bounds how many "waves" GOVERNANCE_CHECKS.length
 * checks take to drain. At CONCURRENCY=5 and 12 registered checks (AM-56
 * added two), that's at most 3 waves × 25s = ~75s worst case — the
 * deliberate, documented ceiling this registry bounds itself to. A hard,
 * mid-flight cancellation of a still-running check was considered and
 * rejected: no AbortController
 * is threaded across a check's (possibly several, parallel) underlying ARM/
 * Graph calls today, so "abandoning" a check at the registry level would
 * stop this function from waiting on it without actually cancelling the
 * outbound HTTP request(s) — a fake win that leaves the real call running
 * in the background regardless. Raising CONCURRENCY (fewer waves) is the
 * lower-risk lever if this ceiling ever needs to come down further.
 */
const CONCURRENCY = 5;

const NOOP_LOGGER: GovernanceLogger = { log: () => {}, warn: () => {}, error: () => {} };

/** Runs every registered check with bounded concurrency, each wrapped in runCheckSafely so one check's failure (or timeout) never fails the whole batch. */
export async function runAllChecks(logger: GovernanceLogger = NOOP_LOGGER): Promise<GovernanceCheckResult[]> {
  const results = new Array<GovernanceCheckResult>(GOVERNANCE_CHECKS.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= GOVERNANCE_CHECKS.length) return;
      const check = GOVERNANCE_CHECKS[index];
      results[index] = await runCheckSafely(check.id, check.title, check.category, check.fetch, logger);
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, GOVERNANCE_CHECKS.length) }, () => worker()));
  return results;
}
