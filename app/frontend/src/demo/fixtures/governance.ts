import type { GovernanceCheckResult, GovernanceSummary } from '@avdmgr/shared';
import { MINUTE, ago } from './time';

const list = <T,>(items: T[]) => ({ items, totalCount: items.length, truncated: false });

/** 12 checks mirroring the real registry (ids/titles/categories), with a mixed pass/warn/fail/unknown spread. */
export function buildGovernance(now: number): GovernanceSummary {
  const at = ago(now, 4 * MINUTE);
  const checks: GovernanceCheckResult[] = [
    { id: 'kv-purge-protection', title: 'Key Vault purge protection', category: 'Security', status: 'pass', summary: 'Purge protection is enabled on "KV-AVD-CONTOSO".', evidence: { vaultName: 'KV-AVD-CONTOSO', enablePurgeProtection: true, softDeleteRetentionDays: 90 }, checkedAt: at },
    { id: 'fslogix-public-network-access', title: 'FSLogix storage account public network access', category: 'Security', status: 'pass', summary: 'Public network access is disabled on "stcontosoprofiles".', evidence: { storageAccount: 'stcontosoprofiles', publicNetworkAccess: 'Disabled' }, checkedAt: at },
    { id: 'private-endpoints-health', title: 'Private endpoint approval & health', category: 'Networking', status: 'pass', summary: 'All 2 expected private endpoints are Approved and Succeeded.', evidence: { privateEndpoints: list([{ name: 'PE-STCONTOSO-FILE', status: 'Approved', provisioningState: 'Succeeded' }, { name: 'PE-KV-AVD-CONTOSO', status: 'Approved', provisioningState: 'Succeeded' }]) }, checkedAt: at },
    { id: 'diagnostic-settings-coverage', title: 'Diagnostic settings coverage', category: 'Monitoring', status: 'warn', summary: '1 of 4 expected resources has no diagnostic setting sending logs to LAW-CONTOSO-PROD.', evidence: { missingDiagnostics: list([{ resource: 'SCALE-CONTOSO-PROD', type: 'Microsoft.DesktopVirtualization/scalingPlans' }]) }, links: [{ label: 'Diagnostic settings (Azure Monitor docs)', url: 'https://learn.microsoft.com/azure/azure-monitor/essentials/diagnostic-settings' }], checkedAt: at },
    { id: 'budget-sanity', title: 'Budget existence & sanity', category: 'Cost', status: 'pass', summary: 'Budget "BUD-AVD-CONTOSO" exists with alert thresholds at 50/80/100%.', evidence: { budgetName: 'BUD-AVD-CONTOSO', amount: 9000, thresholds: [50, 80, 100] }, checkedAt: at },
    { id: 'delete-locks', title: 'Resource delete locks', category: 'Security', status: 'pass', summary: 'CanNotDelete locks are present on all 3 protected scopes.', evidence: { locks: list([{ name: 'LOCK-RG-AVD-Storage', level: 'CanNotDelete' }, { name: 'LOCK-stcontosoprofiles', level: 'CanNotDelete' }, { name: 'LOCK-KV-AVD-CONTOSO', level: 'CanNotDelete' }]) }, checkedAt: at },
    { id: 'orphaned-resources', title: 'Orphaned & untagged resource scan', category: 'Hygiene', status: 'warn', summary: '1 orphaned snapshot and 2 untagged resources found.', evidence: { orphanedSnapshots: list([{ name: 'SNAP-TEST-DISK-OLD', resourceGroup: 'RG-AVD-HostPools', ageDays: 203 }]), untaggedResources: list([{ name: 'avd-con-5/GuestAttestation', type: 'Microsoft.Compute/virtualMachines/extensions' }, { name: 'avd-con-5/AADLoginForWindows', type: 'Microsoft.Compute/virtualMachines/extensions' }]) }, checkedAt: at },
    { id: 'turn-health-advisory', title: 'Session host health-check advisories', category: 'Monitoring', status: 'fail', summary: 'avd-con-5 is failing 2 agent health checks (FSLogixHealthCheck, SxSStackListenerCheck).', evidence: { failingHosts: list([{ host: 'avd-con-5', failingChecks: ['FSLogixHealthCheck', 'SxSStackListenerCheck'] }]) }, checkedAt: at },
    { id: 'law-ingestion-cap', title: 'Log Analytics daily ingestion cap', category: 'Monitoring', status: 'pass', summary: 'Daily cap of 5 GB is configured on LAW-CONTOSO-PROD.', evidence: { workspace: 'LAW-CONTOSO-PROD', dailyQuotaGb: 5 }, checkedAt: at },
    { id: 'ca-policy-breakglass', title: 'Conditional Access break-glass exclusions', category: 'Identity', status: 'unknown', summary: 'Could not evaluate: the Microsoft Graph Policy.Read.All permission is not granted in this demo.', evidence: { reason: 'graph-permission-not-granted' }, checkedAt: at },
    { id: 'storage-privileged-access', title: 'Privileged storage-account data-plane grants', category: 'Security', status: 'warn', summary: '1 principal holds "Storage File Data Privileged Contributor" on the profile share.', evidence: { grants: list([{ principal: 'SG-AVD-Storage-Admins', role: 'Storage File Data Privileged Contributor' }]) }, checkedAt: at },
    { id: 'storage-delete-locks', title: 'FSLogix storage account delete locks', category: 'Security', status: 'pass', summary: 'All 3 expected delete locks are in place.', evidence: { expected: 3, found: 3 }, checkedAt: at },
  ] satisfies GovernanceCheckResult[];
  return summarize(checks, now, false);
}

export function summarize(checks: GovernanceCheckResult[], now: number, cached: boolean): GovernanceSummary {
  const counts = { pass: 0, warn: 0, fail: 0, unknown: 0 };
  for (const check of checks) counts[check.status] += 1;
  return { checks, counts, generatedAt: ago(now, 0), cached } satisfies GovernanceSummary;
}
