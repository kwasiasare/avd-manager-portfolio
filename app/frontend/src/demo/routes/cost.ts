import type { CostSummary, FslogixShareUsage, HostRuntimeSummary, IdleHostsResult, SavingsOpportunity } from '@avdmgr/shared';
import { buildCostSummary, buildFslogixUsage, buildHostRuntime, buildIdleHosts, buildSavings } from '../fixtures/cost';
import { read } from '../router';

export function registerCostRoutes(): void {
  read<CostSummary>('/v1/cost/summary', ({ state }) => buildCostSummary(state.now));
  read<HostRuntimeSummary[]>('/v1/cost/host-runtime', () => buildHostRuntime());
  read<FslogixShareUsage>('/v1/cost/fslogix-usage', () => buildFslogixUsage());
  read<IdleHostsResult>('/v1/cost/idle-hosts', ({ state }) => buildIdleHosts(state.now));
  read<SavingsOpportunity[]>('/v1/cost/savings', () => buildSavings());
}
