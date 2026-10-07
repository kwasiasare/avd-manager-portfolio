/**
 * AM-50 — guided session-host provisioning: typed wrappers around
 * apiClient for the /v1/hostpools/{hostPoolName}/sessionhosts/provisions
 * routes (see app/api/src/functions/sessionHostProvisions.ts). Every route
 * is admin-only server-side — the "Provision from this app" section on
 * AddSessionHostPanel.tsx gates itself the same way, same UI-convenience-
 * only posture as every other mutating surface in this app (see
 * app/frontend/src/api/rollout.ts's own doc comment for the identical
 * convention this file mirrors).
 */
import type { CancelSessionHostProvisionRequest, CancelSessionHostProvisionResponse, SessionHostProvisionDetail, SessionHostProvisionListResponse, StartSessionHostProvisionRequest, StartSessionHostProvisionResponse } from '@avdmgr/shared';
import { apiClient } from './client';

const base = (hostPoolName: string) => `/v1/hostpools/${encodeURIComponent(hostPoolName)}/sessionhosts/provisions`;

export const listSessionHostProvisions = (hostPoolName: string, signal?: AbortSignal) => apiClient.get<SessionHostProvisionListResponse>(base(hostPoolName), { signal });

export const getSessionHostProvision = (hostPoolName: string, provisionId: string, signal?: AbortSignal) =>
  apiClient.get<SessionHostProvisionDetail>(`${base(hostPoolName)}/${encodeURIComponent(provisionId)}`, { signal });

/** `dryRun` returns the plan preview with ZERO mutations — see the API handler's own doc comment. */
export const startSessionHostProvision = (hostPoolName: string, body: StartSessionHostProvisionRequest, dryRun: boolean) =>
  apiClient.post<StartSessionHostProvisionResponse>(`${base(hostPoolName)}${dryRun ? '?dryRun=true' : ''}`, body);

export const cancelSessionHostProvision = (hostPoolName: string, provisionId: string, body: CancelSessionHostProvisionRequest = {}) =>
  apiClient.post<CancelSessionHostProvisionResponse>(`${base(hostPoolName)}/${encodeURIComponent(provisionId)}/cancel`, body);
