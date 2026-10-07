/**
 * AM-28 (M4-S3) staged rollout wizard — typed wrappers around apiClient for
 * the /v1/hostpools/{hostPoolName}/rollout-plans routes (see
 * app/api/src/functions/rolloutPlans.ts). Every route is admin-only
 * server-side (see that file's doc comment) — RolloutWizard.tsx gates the
 * whole wizard behind RoleGate(['admin']), same UI-convenience-only
 * posture as every other mutating surface in this app.
 */
import type {
  CreateRolloutPlanRequest,
  RemoveRolloutHostsRequest,
  RemoveRolloutHostsResponse,
  RolloutActionRequest,
  RolloutPlanListResponse,
  RolloutPlanResponse,
} from '@avdmgr/shared';
import { apiClient } from './client';

const base = (hostPoolName: string) => `/v1/hostpools/${encodeURIComponent(hostPoolName)}/rollout-plans`;

export const listRolloutPlans = (hostPoolName: string, signal?: AbortSignal) => apiClient.get<RolloutPlanListResponse>(base(hostPoolName), { signal });

export const getRolloutPlan = (hostPoolName: string, planId: string, signal?: AbortSignal) =>
  apiClient.get<RolloutPlanResponse>(`${base(hostPoolName)}/${encodeURIComponent(planId)}`, { signal });

export const createRolloutPlan = (hostPoolName: string, body: CreateRolloutPlanRequest) => apiClient.post<RolloutPlanResponse>(base(hostPoolName), body);

function action(hostPoolName: string, planId: string, action: string, body: RolloutActionRequest = {}) {
  return apiClient.post<RolloutPlanResponse>(`${base(hostPoolName)}/${encodeURIComponent(planId)}/${action}`, body);
}

/** planned -> draining_old: drains every old host declared on the plan. */
export const startRollout = (hostPoolName: string, planId: string, body: RolloutActionRequest = {}) => action(hostPoolName, planId, 'start', body);

/** draining_old -> awaiting_new_hosts, bypassing the zero-sessions wait. `reason` is MANDATORY server-side. */
export const forceProceedRollout = (hostPoolName: string, planId: string, body: RolloutActionRequest) => action(hostPoolName, planId, 'force-proceed', body);

/** AM-47: kicks off (or re-kicks off) the FSLogix config-convergence check for every new host on the plan — legal only in validating_new, no state transition. Results land asynchronously via the timer's poll; call refresh() after this resolves and again on subsequent polls to see 'passed'/'failed'/'error' land. */
export const verifyRolloutConfig = (hostPoolName: string, planId: string, body: RolloutActionRequest = {}) => action(hostPoolName, planId, 'verify-config', body);

/** validating_new -> cutover. Gated on every new host being Available+healthy, image-verified, AND config-verified (AM-47) unless body.force is true (with a mandatory reason). */
export const confirmCutover = (hostPoolName: string, planId: string, body: RolloutActionRequest = {}) => action(hostPoolName, planId, 'confirm-cutover', body);

/** cutover -> removing_old. No host mutation — removal itself happens via removeRolloutHosts. */
export const startRemoval = (hostPoolName: string, planId: string, body: RolloutActionRequest = {}) => action(hostPoolName, planId, 'start-removal', body);

/** Batch removal within removing_old. Server re-verifies zero sessions per host immediately before acting — no client-side bypass exists for that gate. `reason` is MANDATORY. */
export const removeRolloutHosts = (hostPoolName: string, planId: string, body: RemoveRolloutHostsRequest) =>
  apiClient.post<RemoveRolloutHostsResponse>(`${base(hostPoolName)}/${encodeURIComponent(planId)}/remove-hosts`, body);

/** Any non-terminal state -> rolled_back. `reason` is MANDATORY. Un-drains old hosts still present; hosts already removed are surfaced in the response's plan.rollbackNeedsReadd for guided re-add instead (see rolloutPlans.ts's handleRollback doc comment). */
export const rollbackRollout = (hostPoolName: string, planId: string, body: RolloutActionRequest) => action(hostPoolName, planId, 'rollback', body);

/** planned -> cancelled only. */
export const cancelRollout = (hostPoolName: string, planId: string, body: RolloutActionRequest = {}) => action(hostPoolName, planId, 'cancel', body);
