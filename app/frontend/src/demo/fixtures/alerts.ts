import type { AlertSummary } from '@avdmgr/shared';
import { DAY, HOUR, MINUTE, ago, ahead, fakeGuid } from './time';
import { HOST_POOL_ARM_ID, SUBSCRIPTION_ID, armId, RG, upn } from './estate';

const alertId = (n: number) => `/subscriptions/${SUBSCRIPTION_ID}/providers/Microsoft.AlertsManagement/alerts/${fakeGuid(100 + n)}`;
const hostArm = (host: string) => `${HOST_POOL_ARM_ID}/sessionHosts/${host}`;

/** 12 alerts across severities: 2 acknowledged, 1 snoozed, the rest new. */
export function buildAlerts(now: number): AlertSummary[] {
  return [
    { id: alertId(1), name: 'Session host unhealthy', severity: 'Sev1', status: 'New', firedAt: ago(now, 14 * MINUTE), description: 'avd-con-5 reports FSLogixHealthCheck and SxSStackListenerCheck failures and is Unavailable.', targetResource: hostArm('avd-con-5') },
    { id: alertId(2), name: 'FSLogix share above 80% capacity', severity: 'Sev2', status: 'New', firedAt: ago(now, 55 * MINUTE), description: 'File share fslogix-profiles is 82% full (840 of 1024 GiB).', targetResource: armId(RG.storage, 'Microsoft.Storage/storageAccounts/stcontosoprofiles') },
    { id: alertId(3), name: 'High CPU on session host', severity: 'Sev2', status: 'New', firedAt: ago(now, 2 * HOUR), description: 'avd-con-3 average CPU above 90% for 15 minutes.', targetResource: hostArm('avd-con-3') },
    { id: alertId(4), name: 'Failed connection spike', severity: 'Sev2', status: 'New', firedAt: ago(now, 3 * HOUR), description: '6 failed connection attempts in 10 minutes for HP-CONTOSO-PROD.', targetResource: HOST_POOL_ARM_ID },
    { id: alertId(5), name: 'Session host heartbeat missing', severity: 'Sev1', status: 'Acknowledged', firedAt: ago(now, 5 * HOUR), description: 'avd-con-4 stopped reporting a heartbeat (expected: it was deallocated by the scaling plan).', targetResource: hostArm('avd-con-4'), ackedBy: upn('priya.nair'), ackedAt: ago(now, 4 * HOUR), ackedReason: 'Expected - host deallocated by autoscale.' },
    { id: alertId(6), name: 'Monthly budget at 80%', severity: 'Sev3', status: 'New', firedAt: ago(now, 9 * HOUR), description: 'Month-to-date spend reached 80% of the Contoso AVD budget.', targetResource: armId(RG.management, 'Microsoft.Consumption/budgets/BUD-AVD-CONTOSO') },
    { id: alertId(7), name: 'Disk space low', severity: 'Sev3', status: 'New', firedAt: ago(now, 11 * HOUR), description: 'avd-con-1 C: drive has less than 10% free space.', targetResource: hostArm('avd-con-1') },
    { id: alertId(8), name: 'Image version approaching end of life', severity: 'Sev4', status: 'Acknowledged', firedAt: ago(now, 20 * HOUR), description: 'Gallery image version 1.0.0 passes its end-of-life date in 30 days.', targetResource: armId(RG.images, 'Microsoft.Compute/galleries/ACG_AVD_CONTOSO/images/WIN11-ENT-M365/versions/1.0.0'), ackedBy: upn('li.wei'), ackedAt: ago(now, 18 * HOUR) },
    { id: alertId(9), name: 'Outdated AVD agent', severity: 'Sev4', status: 'New', firedAt: ago(now, 21 * HOUR), description: 'avd-con-5 runs agent 1.0.10602.1500; 1.0.10863.2100 is current.', targetResource: hostArm('avd-con-5') },
    { id: alertId(10), name: 'Autoscale evaluation warning', severity: 'Sev3', status: 'New', firedAt: ago(now, 22 * HOUR), description: 'Scaling plan SCALE-CONTOSO-PROD could not start avd-con-4 on the first attempt (retried successfully).', targetResource: armId(RG.hostPools, 'Microsoft.DesktopVirtualization/scalingPlans/SCALE-CONTOSO-PROD') },
    { id: alertId(11), name: 'Log Analytics ingestion near daily cap', severity: 'Sev3', status: 'New', firedAt: ago(now, 6 * HOUR), description: 'LAW-CONTOSO-PROD ingested 88% of its daily cap.', targetResource: armId(RG.management, 'Microsoft.OperationalInsights/workspaces/LAW-CONTOSO-PROD'), snoozedUntil: ahead(now, 6 * HOUR), snoozedBy: upn('sam.okafor'), snoozeReason: 'Known - month-end import running.' },
    { id: alertId(12), name: 'Conditional Access policy changed', severity: 'Sev4', status: 'New', firedAt: ago(now, DAY - 10 * MINUTE), description: 'A Conditional Access policy that targets Azure Virtual Desktop was modified.', targetResource: 'Microsoft Entra ID' },
  ] satisfies AlertSummary[];
}
