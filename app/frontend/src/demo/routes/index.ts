import { registerAccessRoutes } from './access';
import { registerCostRoutes } from './cost';
import { registerHostPoolRoutes } from './hostPools';
import { registerImageRoutes } from './images';
import { registerLogsGovernanceRoutes } from './logsGovernance';
import { registerMonitoringRoutes } from './monitoring';
import { registerProfileRoutes } from './profiles';
import { registerRolloutRoutes } from './rollout';
import { registerScalingRoutes } from './scaling';

let registered = false;

/** Registers every demo route exactly once (idempotent). */
export function registerAllRoutes(): void {
  if (registered) return;
  registered = true;
  registerHostPoolRoutes();
  registerScalingRoutes();
  registerImageRoutes();
  registerMonitoringRoutes();
  registerLogsGovernanceRoutes();
  registerCostRoutes();
  registerProfileRoutes();
  registerAccessRoutes();
  registerRolloutRoutes();
}
