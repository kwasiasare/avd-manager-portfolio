import type { RolloutPlanDetail } from '@avdmgr/shared';
import { DAY, HOUR, MINUTE, ago, fakeGuid } from './time';
import { HOST_POOL_NAME, RG, upn } from './estate';

/** One completed rollout (1.2.0 -> 1.3.0, history) and one draft ("planned") rollout for the next wave. Rollout actions are disabled in the demo, so these are read-only. */
export function buildRolloutPlans(now: number): RolloutPlanDetail[] {
  const completed: RolloutPlanDetail = {
    id: fakeGuid(401),
    hostPoolName: HOST_POOL_NAME,
    targetImageVersion: '1.3.0',
    state: 'done',
    oldHosts: [
      { sessionHostName: 'avd-con-old-0', status: 'removed', lastObservedSessions: 0, drainedAt: ago(now, 12 * DAY - 2 * HOUR), resourceGroup: RG.hostPools, vmName: 'avd-con-old-0', deregisteredAt: ago(now, 11 * DAY), removedAt: ago(now, 11 * DAY - 10 * MINUTE) },
      { sessionHostName: 'avd-con-old-1', status: 'removed', lastObservedSessions: 0, drainedAt: ago(now, 12 * DAY - 2 * HOUR), resourceGroup: RG.hostPools, vmName: 'avd-con-old-1', deregisteredAt: ago(now, 11 * DAY), removedAt: ago(now, 11 * DAY - 12 * MINUTE) },
    ],
    newHosts: [
      { sessionHostName: 'avd-con-0', status: 'validated', lastObservedStatus: 'Available', powerState: 'running', healthy: true, imageVerified: true, configCheck: { status: 'passed', submittedAt: ago(now, 11 * DAY + 3 * HOUR), completedAt: ago(now, 11 * DAY + 2 * HOUR) }, registeredAt: ago(now, 11 * DAY + 5 * HOUR) },
      { sessionHostName: 'avd-con-1', status: 'validated', lastObservedStatus: 'Available', powerState: 'running', healthy: true, imageVerified: true, configCheck: { status: 'passed', submittedAt: ago(now, 11 * DAY + 3 * HOUR), completedAt: ago(now, 11 * DAY + 2 * HOUR) }, registeredAt: ago(now, 11 * DAY + 5 * HOUR) },
    ],
    createdBy: upn('priya.nair'),
    createdAt: ago(now, 12 * DAY - HOUR),
    updatedAt: ago(now, 11 * DAY - 10 * MINUTE),
    reason: 'Roll image 1.3.0 (July cumulative update) onto the first two hosts.',
    cutoverAt: ago(now, 11 * DAY + HOUR),
    cutoverBy: upn('priya.nair'),
    completedAt: ago(now, 11 * DAY - 10 * MINUTE),
  };
  const draft: RolloutPlanDetail = {
    id: fakeGuid(402),
    hostPoolName: HOST_POOL_NAME,
    targetImageVersion: '1.3.0',
    state: 'planned',
    oldHosts: [
      { sessionHostName: 'avd-con-2', status: 'pending' },
      { sessionHostName: 'avd-con-3', status: 'pending' },
    ],
    newHosts: [
      { sessionHostName: 'avd-con-6', status: 'awaiting_registration' },
      { sessionHostName: 'avd-con-7', status: 'awaiting_registration' },
    ],
    createdBy: upn('sam.okafor'),
    createdAt: ago(now, 2 * DAY),
    updatedAt: ago(now, 2 * DAY),
    reason: 'Second wave: move the remaining 1.2.0 hosts to 1.3.0.',
  };
  return [draft, completed] satisfies RolloutPlanDetail[];
}
