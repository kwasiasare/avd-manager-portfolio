import type { ScalingPlanDetail, ScalingScheduleDetail } from '@avdmgr/shared';
import { armId, HOST_POOL_NAME, RG } from './estate';

const p = (hour: number, minute = 0) => ({ hour, minute });

const common = {
  rampUpLoadBalancingAlgorithm: 'BreadthFirst',
  rampUpCapacityThresholdPct: 60,
  peakLoadBalancingAlgorithm: 'DepthFirst',
  rampDownLoadBalancingAlgorithm: 'DepthFirst',
  rampDownCapacityThresholdPct: 90,
  rampDownForceLogoffUsers: false,
  rampDownStopHostsWhen: 'ZeroSessions',
  rampDownWaitTimeMinutes: 30,
  rampDownNotificationMessage: 'This desktop will shut down soon. Please save your work and sign out.',
  offPeakLoadBalancingAlgorithm: 'DepthFirst',
} as const satisfies Partial<ScalingScheduleDetail>;

/** Eastern-time plan with 4 schedules covering every day exactly once. */
export function buildScalingPlan(): ScalingPlanDetail {
  return {
    id: armId(RG.hostPools, 'Microsoft.DesktopVirtualization/scalingPlans/SCALE-CONTOSO-PROD'),
    name: 'SCALE-CONTOSO-PROD',
    hostPoolName: HOST_POOL_NAME,
    timeZone: 'Eastern Standard Time',
    enabled: true,
    schedules: [
      { ...common, name: 'Weekdays', daysOfWeek: ['Monday', 'Tuesday', 'Wednesday', 'Thursday'], rampUpStartTime: p(6, 30), rampUpMinimumHostsPct: 40, peakStartTime: p(8, 30), rampDownStartTime: p(17, 30), rampDownMinimumHostsPct: 20, offPeakStartTime: p(20) },
      { ...common, name: 'Friday-early-close', daysOfWeek: ['Friday'], rampUpStartTime: p(6, 30), rampUpMinimumHostsPct: 40, peakStartTime: p(8, 30), rampDownStartTime: p(15, 30), rampDownMinimumHostsPct: 10, offPeakStartTime: p(18) },
      { ...common, name: 'Saturday', daysOfWeek: ['Saturday'], rampUpStartTime: p(8), rampUpMinimumHostsPct: 20, peakStartTime: p(10), rampDownStartTime: p(14), rampDownMinimumHostsPct: 10, offPeakStartTime: p(16) },
      { ...common, name: 'Sunday', daysOfWeek: ['Sunday'], rampUpStartTime: p(12), rampUpMinimumHostsPct: 10, peakStartTime: p(13), rampDownStartTime: p(15), rampDownMinimumHostsPct: 0, offPeakStartTime: p(16) },
    ] satisfies ScalingScheduleDetail[],
  } satisfies ScalingPlanDetail;
}
