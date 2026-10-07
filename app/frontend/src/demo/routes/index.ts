import { registerHostPoolRoutes } from './hostPools';
import { registerMonitoringRoutes } from './monitoring';

let registered = false;

/** Registers every demo route exactly once (idempotent). */
export function registerAllRoutes(): void {
  if (registered) return;
  registered = true;
  registerHostPoolRoutes();
  registerMonitoringRoutes();
}
