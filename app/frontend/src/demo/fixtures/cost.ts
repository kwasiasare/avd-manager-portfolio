import type { CostSummary, FslogixShareUsage, HostRuntimeSummary, IdleHostsResult, SavingsOpportunity } from '@avdmgr/shared';
import { ago, DAY, HOUR } from './time';
import { FSLOGIX_SHARE, HOST_POOL_NAME, RG, STORAGE_ACCOUNT } from './estate';

export function buildCostSummary(now: number): CostSummary {
  return {
    currency: 'USD',
    asOfDate: ago(now, DAY).slice(0, 10),
    monthToDateCost: 4812.37,
    priorMonthSamePeriodCost: 4390.12,
    projectedMonthEndCost: 7240.5,
    byResourceGroup: [
      { resourceGroup: RG.hostPools, cost: 2874.9 },
      { resourceGroup: RG.storage, cost: 812.44 },
      { resourceGroup: RG.network, cost: 421.18 },
      { resourceGroup: RG.management, cost: 388.05 },
      { resourceGroup: RG.images, cost: 246.7 },
      { resourceGroup: RG.security, cost: 69.1 },
    ],
    stale: false,
    computedAt: ago(now, 20 * 60_000),
  } satisfies CostSummary;
}

export function buildHostRuntime(): HostRuntimeSummary[] {
  const row = (name: string, running: number, deallocated: number, unknown = 0): HostRuntimeSummary => ({
    sessionHostName: name,
    hostPoolName: HOST_POOL_NAME,
    runningHours: running,
    deallocatedHours: deallocated,
    unknownHours: unknown,
    windowHours: 168,
    dataSource: 'WVDAgentHealthStatus',
  });
  return [row('avd-con-0', 98, 70), row('avd-con-1', 96, 72), row('avd-con-2', 150, 18), row('avd-con-3', 124, 44), row('avd-con-4', 31, 137), row('avd-con-5', 168, 0)] satisfies HostRuntimeSummary[];
}

export function buildFslogixUsage(): FslogixShareUsage {
  return {
    storageAccountName: STORAGE_ACCOUNT,
    shareName: FSLOGIX_SHARE,
    provisionedGib: 1024,
    usedBytes: 902_020_464_640,
    usedGib: 840.1,
    percentUsed: 82,
  } satisfies FslogixShareUsage;
}

export function buildIdleHosts(now: number): IdleHostsResult {
  return {
    evaluated: true,
    findings: [
      { sessionHostName: 'avd-con-2', hostPoolName: HOST_POOL_NAME, powerState: 'running', phase: 'OffPeak', activeSessions: 0, disconnectedSessions: 1, runningSinceApprox: ago(now, 15 * HOUR), reason: 'Running in the OffPeak phase with only a disconnected session; it is drained, so autoscale will not stop it until the session ends.' },
      { sessionHostName: 'avd-con-5', hostPoolName: HOST_POOL_NAME, powerState: 'running', phase: 'OffPeak', activeSessions: 0, disconnectedSessions: 0, runningSinceApprox: ago(now, 7 * DAY), reason: 'Running continuously for 7 days with no sessions; the host is Unavailable, so autoscale cannot manage it.' },
    ],
  } satisfies IdleHostsResult;
}

export function buildSavings(): SavingsOpportunity[] {
  return [
    { severity: 'warning', title: 'Idle session host avd-con-5', detail: 'Running for 7 days with no sessions and failing health checks. Fixing or deallocating it would save roughly $190/month.' },
    { severity: 'info', title: 'Orphaned snapshot SNAP-TEST-DISK-OLD', detail: 'A 128 GiB snapshot older than 200 days that no image build references. Deleting it saves about $6/month.' },
    { severity: 'info', title: 'Oversized FSLogix profiles', detail: '3 profiles exceed the 20 GB threshold and account for 14% of the share. Compacting or resetting them could defer a share-size increase.' },
  ] satisfies SavingsOpportunity[];
}
