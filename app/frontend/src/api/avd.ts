/**
 * Typed wrappers around apiClient for every AVD Manager v1 endpoint the M1
 * (read-only) UI consumes. Keeping these in one place means each page just
 * imports a named function instead of re-typing the path/response type.
 *
 * Every wrapper takes an optional AbortSignal, forwarded straight to
 * apiClient (see src/api/client.ts's ApiFetchOptions) — usePolling
 * (src/hooks/usePolling.ts) creates one AbortController per poll/refresh
 * cycle and aborts it on cleanup, so an in-flight request from a poll that
 * is no longer current (component unmounted, or a newer poll superseded it)
 * gets cancelled instead of racing a stale response into state.
 */
import type {
  AckAlertRequest,
  AccessSearchResponse,
  AlertsFeedResponse,
  AlertSummary,
  AssignmentsListResponse,
  AuditRecentResponse,
  BroadcastSessionMessageRequest,
  BroadcastSessionMessageResponse,
  CostSummary,
  CreateAssignmentRequest,
  CreateAssignmentResponse,
  DrainSessionHostRequest,
  DrainSessionHostResponse,
  EmergencyOverrideRequest,
  EmergencyOverrideStatus,
  EstateSummaryResponse,
  ForceLogoffSessionRequest,
  ForceLogoffSessionResponse,
  FslogixShareUsage,
  GenerateRegistrationTokenRequest,
  GenerateRegistrationTokenResponse,
  GovernanceSummary,
  HealthSummary,
  HostPool,
  HostRuntimeSummary,
  AdvanceImageBuildResponse,
  CancelImageBuildResponse,
  DeleteImageBuildSnapshotRequest,
  DeleteImageBuildSnapshotResponse,
  ImageBuildDetail,
  ImageBuildListResponse,
  StartImageBuildRequest,
  StartImageBuildResponse,
  UpdateImageBuildChecklistRequest,
  UpdateImageBuildChecklistResponse,
  IdleHostsResult,
  IntunePolicyHealthResponse,
  ImageVersionCurrent,
  ImageVersionsResponse,
  LogoffAllDisconnectedRequest,
  LogoffAllDisconnectedResponse,
  DeleteRetiredProfileRequest,
  DeleteRetiredProfileResponse,
  DuplicateContainerResolveRequest,
  DuplicateContainerResolveResponse,
  LogsQueryResponse,
  LogsViewSummary,
  ProfileResetRequest,
  ProfileResetResponse,
  ProfileRestoreRequest,
  ProfileRestoreResponse,
  ProfilesListResponse,
  RawKqlRequest,
  RegistrationTokenStatus,
  SavingsOpportunity,
  ScalingHistoryResponse,
  ScalingPlanDetail,
  ScalingScheduleCreateRequest,
  ScalingScheduleCreateResponse,
  ScalingScheduleDeleteResponse,
  ScalingSchedulePatchRequest,
  ScalingSchedulePatchResponse,
  SendSessionMessageRequest,
  SendSessionMessageResponse,
  SessionHost,
  SessionHostPowerRequest,
  SessionHostPowerResponse,
  SettingsResponse,
  SnapshotReportResponse,
  SnoozeAlertRequest,
  UpdateWorkspaceFriendlyNameRequest,
  UserSession,
  VmTemplateInfo,
  WorkspaceFriendlyNameResponse,
} from '@avdmgr/shared';
import { apiClient } from './client';

/**
 * Client-side timeout for the two batch session endpoints
 * (logoffAllDisconnectedSessions / broadcastSessionMessage), well above
 * apiClient's default 30s (see api/client.ts's DEFAULT_TIMEOUT_MS) — the
 * server bounds each batch to at most MAX_BATCH_TARGETS (100) sessions run
 * with concurrency 8 (see app/api/src/lib/sessionBatch.ts), which can take
 * meaningfully longer than 30s for a large, fully-populated batch. Callers
 * (Sessions.tsx) must still treat an abort/timeout on these two calls as
 * "still running in Azure, not necessarily failed" — see
 * isTimeoutOrAbortError there — since raising this timeout doesn't
 * guarantee the server-side batch finishes within it either.
 */
const BATCH_TIMEOUT_MS = 120_000;

export const getHostPools = (signal?: AbortSignal) => apiClient.get<HostPool[]>('/v1/hostpools', { signal });

export const getSessionHosts = (hostPoolName: string, signal?: AbortSignal) =>
  apiClient.get<SessionHost[]>(`/v1/hostpools/${encodeURIComponent(hostPoolName)}/sessionhosts`, { signal });

/**
 * AM-52 — explicit timeout above apiClient's default 30s (same "known-slow
 * Graph-backed batch endpoint gets its own longer budget" precedent as
 * GOVERNANCE_TIMEOUT_MS below): the server resolves every host's Intune
 * managed device (chunked Graph calls) then reads one device-configuration-
 * states call per resolved device, bounded concurrency — see
 * intunePolicyHealthService.ts.
 */
const POLICY_HEALTH_TIMEOUT_MS = 45_000;

/** GET /v1/hostpools/{hostPoolName}/policy-health (AM-52, viewer+) — see HostPool.tsx for how this is polled alongside (never blocking) the session-host list. */
export const getHostPoolPolicyHealth = (hostPoolName: string, signal?: AbortSignal) =>
  apiClient.get<IntunePolicyHealthResponse>(`/v1/hostpools/${encodeURIComponent(hostPoolName)}/policy-health`, { signal, timeoutMs: POLICY_HEALTH_TIMEOUT_MS });

/**
 * Toggles a session host's drain mode (allowNewSession). Requires at least
 * the operator role server-side (app/api/src/functions/sessionHostDrain.ts)
 * — the HostPool page's RoleGate hides the control from viewers, but the API
 * independently re-checks, per app/README.md's Roles section.
 */
export const setSessionHostDrain = (hostPoolName: string, sessionHostName: string, body: DrainSessionHostRequest) =>
  apiClient.patch<DrainSessionHostResponse>(
    `/v1/hostpools/${encodeURIComponent(hostPoolName)}/sessionhosts/${encodeURIComponent(sessionHostName)}/drain`,
    body,
  );

/**
 * Generates/rotates the host pool's registration token. Admin-only
 * server-side (app/api/src/functions/hostPoolRegistrationToken.ts) — the
 * HostPool page's RoleGate hides the generate control from non-admins, the
 * API independently re-checks. The response's `token` is shown to the
 * caller exactly once; this wrapper does not cache or persist it.
 */
export const generateRegistrationToken = (hostPoolName: string, body: GenerateRegistrationTokenRequest) =>
  apiClient.post<GenerateRegistrationTokenResponse>(`/v1/hostpools/${encodeURIComponent(hostPoolName)}/registration-token`, body);

/**
 * Reads the host pool's current registration-token status (exists +
 * expirationTime only — never the token value). Operator+ server-side.
 */
export const getRegistrationTokenStatus = (hostPoolName: string, signal?: AbortSignal) =>
  apiClient.get<RegistrationTokenStatus>(`/v1/hostpools/${encodeURIComponent(hostPoolName)}/registration-token`, { signal });

/**
 * Reads the host pool's parsed vmTemplate (image, VM size, name prefix,
 * domain/OU — best-effort, see the VmTemplateInfo DTO comment). Operator+
 * server-side, powering the Add session host panel's prefilled parameters.
 */
export const getVmTemplate = (hostPoolName: string, signal?: AbortSignal) =>
  apiClient.get<VmTemplateInfo>(`/v1/hostpools/${encodeURIComponent(hostPoolName)}/vm-template`, { signal });

/**
 * Starts, restarts, or deallocates a session host's underlying VM (AM-19/
 * M2-S2). Requires at least the operator role server-side (see
 * app/api/src/functions/sessionHostPower.ts) — same UI-convenience-only
 * RoleGate/canMutate pattern as setSessionHostDrain above. Resolves with a
 * 202-shaped "accepted" body, NOT confirmation the VM reached the target
 * power state — see SessionHostPowerResponse's doc comment. Callers should
 * refresh the session-host list afterwards to observe power state as it
 * changes, the same way HostPool.tsx already does after a drain toggle.
 */
export const setSessionHostPower = (hostPoolName: string, sessionHostName: string, body: SessionHostPowerRequest) =>
  apiClient.post<SessionHostPowerResponse>(
    `/v1/hostpools/${encodeURIComponent(hostPoolName)}/sessionhosts/${encodeURIComponent(sessionHostName)}/power`,
    body,
  );

export const getSessions = (hostPoolName: string, signal?: AbortSignal) =>
  apiClient.get<UserSession[]>(`/v1/hostpools/${encodeURIComponent(hostPoolName)}/sessions`, { signal });

/**
 * Forces one user session to log off (AM-20/M2-S3). `reason` is MANDATORY
 * server-side (app/api/src/functions/sessionForceLogoff.ts) — unlike
 * setSessionHostDrain's reason, an empty one is rejected with a 400.
 */
export const forceLogoffSession = (hostPoolName: string, sessionHostName: string, sessionId: string, body: ForceLogoffSessionRequest) =>
  apiClient.post<ForceLogoffSessionResponse>(
    `/v1/hostpools/${encodeURIComponent(hostPoolName)}/sessionhosts/${encodeURIComponent(sessionHostName)}/sessions/${encodeURIComponent(sessionId)}/logoff`,
    body,
  );

/** Sends a message to one user session (AM-20/M2-S3). `body.title` is optional; `body.body` is mandatory. */
export const sendSessionMessage = (hostPoolName: string, sessionHostName: string, sessionId: string, body: SendSessionMessageRequest) =>
  apiClient.post<SendSessionMessageResponse>(
    `/v1/hostpools/${encodeURIComponent(hostPoolName)}/sessionhosts/${encodeURIComponent(sessionHostName)}/sessions/${encodeURIComponent(sessionId)}/message`,
    body,
  );

/**
 * Logs off every Disconnected session in the host pool (AM-20/M2-S3). The
 * server enforces the Disconnected-only filter — this is a batch operation,
 * not a per-session one, so a partial failure is reported in the response
 * body (`result.failed`) rather than as an HTTP error.
 */
export const logoffAllDisconnectedSessions = (hostPoolName: string, body: LogoffAllDisconnectedRequest) =>
  apiClient.post<LogoffAllDisconnectedResponse>(`/v1/hostpools/${encodeURIComponent(hostPoolName)}/sessions/logoff-disconnected`, body, {
    timeoutMs: BATCH_TIMEOUT_MS,
  });

/** Broadcasts a message to every Active session in the host pool (AM-20/M2-S3). Same partial-failure reporting shape as logoffAllDisconnectedSessions. */
export const broadcastSessionMessage = (hostPoolName: string, body: BroadcastSessionMessageRequest) =>
  apiClient.post<BroadcastSessionMessageResponse>(`/v1/hostpools/${encodeURIComponent(hostPoolName)}/sessions/broadcast`, body, {
    timeoutMs: BATCH_TIMEOUT_MS,
  });

export const getCurrentScalingPlan = (signal?: AbortSignal) => apiClient.get<ScalingPlanDetail>('/v1/scalingplans/current', { signal });

/**
 * AM-23 (M3-S1) scaling-plan schedule editor. Updates an EXISTING named
 * schedule (partial patch — only fields present in `body` are changed).
 * Operator+ server-side (app/api/src/functions/scalingSchedule.ts).
 */
export const updateScalingSchedule = (scheduleName: string, body: ScalingSchedulePatchRequest) =>
  apiClient.patch<ScalingSchedulePatchResponse>(`/v1/scalingplans/current/schedules/${encodeURIComponent(scheduleName)}`, body);

/**
 * Creates a NEW named schedule — the mechanism behind per-day-of-week
 * overrides (shrink an existing schedule's daysOfWeek via
 * updateScalingSchedule, then create one or more schedules for the
 * split-off days). Operator+ server-side.
 */
export const createScalingSchedule = (body: ScalingScheduleCreateRequest) => apiClient.post<ScalingScheduleCreateResponse>('/v1/scalingplans/current/schedules', body);

/** Removes a named schedule (undoes a day-of-week split, or removes one no longer wanted). Operator+ server-side. */
export const deleteScalingSchedule = (scheduleName: string, reason?: string) =>
  apiClient.delete<ScalingScheduleDeleteResponse>(`/v1/scalingplans/current/schedules/${encodeURIComponent(scheduleName)}`, { body: reason ? { reason } : undefined });

/** Reads the emergency "keep all hosts up" override's current status. Any signed-in role (viewer included) can read this. */
export const getEmergencyOverrideStatus = (signal?: AbortSignal) => apiClient.get<EmergencyOverrideStatus>('/v1/scalingplans/current/emergency-override', { signal });

/** Activates the emergency override — disables autoscale for the configured host pool for `minutes` (15-480), with a MANDATORY reason. Operator+ server-side. */
export const activateEmergencyOverride = (body: EmergencyOverrideRequest) => apiClient.post<EmergencyOverrideStatus>('/v1/scalingplans/current/emergency-override', body);

/** Cancels an active emergency override early, re-enabling autoscale immediately. Operator+ server-side. */
export const cancelEmergencyOverride = (reason?: string) => apiClient.delete<EmergencyOverrideStatus>('/v1/scalingplans/current/emergency-override', { body: reason ? { reason } : undefined });

/** Last 10 scaling-plan-related audit rows (schedule edits/creates/deletes, emergency override activate/cancel/auto-re-enable), newest first. viewer+ server-side. */
export const getScalingHistory = (signal?: AbortSignal) => apiClient.get<ScalingHistoryResponse>('/v1/scalingplans/current/history', { signal });

export const getCurrentImageVersion = (signal?: AbortSignal) => apiClient.get<ImageVersionCurrent>('/v1/images/current', { signal });

/**
 * AM-26 (M4-S1): full version timeline (every version, newest-first) plus
 * per-host image-version correlation — see ImageVersionsResponse's doc
 * comment in @avdmgr/shared. viewer+ server-side, same floor as
 * getCurrentImageVersion.
 */
export const getImageVersions = (signal?: AbortSignal) => apiClient.get<ImageVersionsResponse>('/v1/images/versions', { signal });

/** AM-26: orphaned-snapshot report for RG-AVD-Images/RG-AVD-HostPools — see SnapshotReportResponse's doc comment in @avdmgr/shared. viewer+ server-side. Independent fetch from getImageVersions — the Images page's two sections load/fail separately. */
export const getImageSnapshots = (signal?: AbortSignal) => apiClient.get<SnapshotReportResponse>('/v1/images/snapshots', { signal });

// --- AM-27 (M4-S2): golden image build orchestration — admin-only server-side. ---

/** Starts a build, or (dryRun) previews its plan with zero mutations. */
export const startImageBuild = (body: StartImageBuildRequest, dryRun: boolean) =>
  apiClient.post<StartImageBuildResponse>(`/v1/images/builds${dryRun ? '?dryRun=true' : ''}`, body);

export const listImageBuilds = (signal?: AbortSignal) => apiClient.get<ImageBuildListResponse>('/v1/images/builds', { signal });

export const getImageBuild = (buildId: string, signal?: AbortSignal) => apiClient.get<ImageBuildDetail>(`/v1/images/builds/${encodeURIComponent(buildId)}`, { signal });

export const updateImageBuildChecklist = (buildId: string, body: UpdateImageBuildChecklistRequest) =>
  apiClient.patch<UpdateImageBuildChecklistResponse>(`/v1/images/builds/${encodeURIComponent(buildId)}/checklist`, body);

/** The OPERATOR-gate advance action — valid only at checklist_gate (every item ticked) or test_host_step. */
export const advanceImageBuild = (buildId: string, reason?: string) =>
  apiClient.post<AdvanceImageBuildResponse>(`/v1/images/builds/${encodeURIComponent(buildId)}/advance`, reason ? { reason } : undefined);

export const cancelImageBuild = (buildId: string, reason?: string) =>
  apiClient.post<CancelImageBuildResponse>(`/v1/images/builds/${encodeURIComponent(buildId)}/cancel`, reason ? { reason } : undefined);

/** AM-53 — operator-confirmed pre-Sysprep snapshot deletion, gated server-side on the build being done and its version having completed a rollout (see @avdmgr/shared's ImageBuildDetail.snapshotDeletable doc comment). Mandatory reason. */
export const deleteImageBuildSnapshot = (buildId: string, body: DeleteImageBuildSnapshotRequest) =>
  apiClient.delete<DeleteImageBuildSnapshotResponse>(`/v1/images/builds/${encodeURIComponent(buildId)}/snapshot`, { body });

export const getRecentAlerts = (signal?: AbortSignal) => apiClient.get<AlertSummary[]>('/v1/alerts/recent', { signal });

export const getHealthSummary = (signal?: AbortSignal) => apiClient.get<HealthSummary>('/v1/health/summary', { signal });

/** AM-29 item 26 — backs the EstateStrip shown on every page (see components/EstateStrip.tsx). */
export const getEstateSummary = (signal?: AbortSignal) => apiClient.get<EstateSummaryResponse>('/v1/estate/summary', { signal });

// --- AM-25: Cost & Scaling page — each fetch is independent so one failing
// data source (e.g. Cost Management being slow, LAW having no data) doesn't
// blank the rest of the page; see CostScaling.tsx's per-card AsyncState use.
export const getCostSummary = (signal?: AbortSignal) => apiClient.get<CostSummary>('/v1/cost/summary', { signal });

export const getCostHostRuntime = (signal?: AbortSignal) => apiClient.get<HostRuntimeSummary[]>('/v1/cost/host-runtime', { signal });

export const getFslogixUsage = (signal?: AbortSignal) => apiClient.get<FslogixShareUsage>('/v1/cost/fslogix-usage', { signal });

export const getIdleHosts = (signal?: AbortSignal) => apiClient.get<IdleHostsResult>('/v1/cost/idle-hosts', { signal });

export const getSavingsOpportunities = (signal?: AbortSignal) => apiClient.get<SavingsOpportunity[]>('/v1/cost/savings', { signal });

// --- AM-24: alert feed + ack/snooze ---

/**
 * Extracts the trailing GUID from a full Azure Monitor alert ARM resource id
 * (AlertSummary.id, e.g.
 * "/subscriptions/{sub}/providers/Microsoft.AlertsManagement/alerts/{guid}").
 * The ack/snooze/unack/unsnooze routes take ONLY this bare GUID as their
 * path segment (peer review MAJOR 1) — an earlier version of this file
 * route-encoded the FULL id (which contains '/') and passed it as one path
 * segment; Azure App Service/IIS normalizes and rejects encoded slashes
 * (%2F) in path segments before a request reaches the Function App, so that
 * route would have 404'd against a real deployment despite working locally.
 * Just taking the last '/'-delimited segment is sufficient here (rather
 * than re-validating the full shape client-side) because the API
 * independently re-validates alertGuid on every route — see
 * app/api/src/lib/alertState.ts#isValidAlertGuid.
 */
function alertGuidFromId(alertId: string): string {
  return alertId.split('/').pop() ?? alertId;
}

/** GET /v1/alerts?hours= — the 24h (default) alert feed, ack/snooze state merged in server-side. Wrapped in `{ alerts, degraded }`, not a bare array — see AlertsFeedResponse's doc comment. */
export const getAlerts = (hours: number, signal?: AbortSignal) => apiClient.get<AlertsFeedResponse>(`/v1/alerts?hours=${encodeURIComponent(hours)}`, { signal });

/** 204 No Content on success (see app/api/src/functions/alertAck.ts) — callers re-fetch the feed afterward rather than trusting a returned entity. */
export const ackAlert = (alertId: string, body: AckAlertRequest = {}) => apiClient.post<void>(`/v1/alerts/${alertGuidFromId(alertId)}/ack`, body);

/** DELETE /v1/alerts/{alertGuid}/ack — clears an ack (peer review item 5: acking is no longer permanent). 204 on success, idempotent. */
export const unackAlert = (alertId: string) => apiClient.delete<void>(`/v1/alerts/${alertGuidFromId(alertId)}/ack`);

export const snoozeAlert = (alertId: string, body: SnoozeAlertRequest) => apiClient.post<void>(`/v1/alerts/${alertGuidFromId(alertId)}/snooze`, body);

/** DELETE /v1/alerts/{alertGuid}/snooze — clears a snooze immediately (peer review item 5: snoozing is no longer permanent-until-expiry). 204 on success, idempotent. */
export const unsnoozeAlert = (alertId: string) => apiClient.delete<void>(`/v1/alerts/${alertGuidFromId(alertId)}/snooze`);

// --- AM-24: log analytics (curated views + raw KQL) ---

export const getLogsViews = (signal?: AbortSignal) => apiClient.get<LogsViewSummary[]>('/v1/logs/views', { signal });

export const runLogsView = (viewId: string, timespanHours: number) =>
  apiClient.post<LogsQueryResponse>(`/v1/logs/views/${encodeURIComponent(viewId)}/run`, { timespanHours });

/** operator+ only — the API independently enforces this; the frontend just hides the control (see RoleGate in Monitoring.tsx). */
export const runRawKql = (body: RawKqlRequest) => apiClient.post<LogsQueryResponse>('/v1/logs/query', body);

// --- AM-16 (M3b): Governance & security posture panel ---

/**
 * Explicit timeout well above apiClient's default 30s (see api/client.ts's
 * DEFAULT_TIMEOUT_MS), same "known-slow batch endpoint gets its own longer
 * budget" precedent as BATCH_TIMEOUT_MS above (though shorter than that
 * 120s, since this is a read, not a multi-target batch mutation): a cold
 * cache/cold Flex Consumption instance means GET /v1/governance can fan out
 * to 20+ ARM/Graph calls across the whole check registry (each individually
 * bounded — see app/api/src/lib/restClient.ts's 15s-per-request timeout and
 * app/api/src/services/governance/support.ts's 25s-per-check timeout — but
 * NOT their sum, since the registry runs checks with bounded concurrency,
 * not fully serially) before the first response.
 */
const GOVERNANCE_TIMEOUT_MS = 60_000;

/** `forceRefresh` bypasses the API's ~10min server-side cache (the Governance page's refresh button, gated to operator+ server-side) — see app/api/src/services/governanceService.ts's getGovernanceSummary doc comment. */
export const getGovernance = (options: { forceRefresh?: boolean; signal?: AbortSignal } = {}) =>
  apiClient.get<GovernanceSummary>(`/v1/governance${options.forceRefresh ? '?refresh=true' : ''}`, { signal: options.signal, timeoutMs: GOVERNANCE_TIMEOUT_MS });

// --- AM-13 (M5): FSLogix profile management ---

/** `forceRefresh` bypasses the API's short in-memory cache (peer review item 6 — see app/api/src/services/fslogixProfilesService.ts's listProfiles doc comment) — same `?refresh=true` convention as getGovernance above. Used after a reset/restore/delete mutation so the immediate post-mutation refresh doesn't serve stale cached data. */
export const getProfiles = (options: { forceRefresh?: boolean; signal?: AbortSignal } = {}) =>
  apiClient.get<ProfilesListResponse>(`/v1/profiles${options.forceRefresh ? '?refresh=true' : ''}`, { signal: options.signal });

/** Admin-only server-side (see app/api/src/functions/profileReset.ts) — reason is mandatory. profileFolderName is the profile's containing directory name (its stable identity — see @avdmgr/shared's ProfileVhd.folderName doc comment), not a VHD filename. Refused server-side (400/409) for a `kind: 'root-file'` profile — see ProfileVhd.kind's doc comment. */
export const resetProfile = (profileFolderName: string, body: ProfileResetRequest) =>
  apiClient.post<ProfileResetResponse>(`/v1/profiles/${encodeURIComponent(profileFolderName)}/reset`, body);

/** Admin-only server-side — reason is optional (but the endpoint still refuses with a 409 if the destination name already exists — see the Restore dialog's own copy in Profiles.tsx). retiredFileName in the body picks which `.retired-*` file to restore (a folder can carry more than one). */
export const restoreProfile = (profileFolderName: string, body: ProfileRestoreRequest) =>
  apiClient.post<ProfileRestoreResponse>(`/v1/profiles/${encodeURIComponent(profileFolderName)}/restore`, body);

/**
 * AM-13 peer review item 7 — admin-only, mandatory reason. ⚠ PERMANENTLY
 * deletes the retired VHD(X) — irreversible, unlike restore. FLAGGED FOR
 * PRODUCT SIGN-OFF, see this story's final report; not exercised against
 * the live estate.
 */
export const deleteRetiredProfile = (profileFolderName: string, retiredFileName: string, body: DeleteRetiredProfileRequest) =>
  apiClient.delete<DeleteRetiredProfileResponse>(`/v1/profiles/${encodeURIComponent(profileFolderName)}/retired/${encodeURIComponent(retiredFileName)}`, { body });

/**
 * AM-51 — admin-only server-side (see app/api/src/functions/profileDuplicateResolve.ts),
 * reason is mandatory regardless of mode. Guided fix for a folder flagged
 * `duplicateContainer: true` (more than one active VHD(X) file) — the
 * operator picks exactly one sibling file and either retires (reversible —
 * appears in the Retired profiles table) or permanently deletes it. The
 * server re-verifies at mutation time that the folder still has more than
 * one active file and refuses (409) otherwise — the listing-time flag is
 * advisory only.
 */
export const resolveDuplicateContainer = (profileFolderName: string, body: DuplicateContainerResolveRequest) =>
  apiClient.post<DuplicateContainerResolveResponse>(`/v1/profiles/${encodeURIComponent(profileFolderName)}/duplicates/resolve`, body);

// --- AM-14 (M6): Users & access management ---

/**
 * User/group typeahead search (Graph-backed). Operator+ server-side (see
 * app/api/src/functions/accessSearch.ts) — the Users & Access page's search
 * box is itself gated behind a RoleGate matching that floor. Degrades to
 * `{ results: [], graphAvailable: false, graphDegradationReason }` rather
 * than throwing when the Graph application permissions haven't been
 * granted yet — see AccessSearchResponse's doc comment in @avdmgr/shared.
 */
export const searchAccess = (q: string, signal?: AbortSignal) => apiClient.get<AccessSearchResponse>(`/v1/access/search?q=${encodeURIComponent(q)}`, { signal });

/** Lists every "Desktop Virtualization User" role assignment on the DAG, with best-effort Graph name resolution. viewer+ server-side. */
export const getDesktopAssignments = (signal?: AbortSignal) => apiClient.get<AssignmentsListResponse>('/v1/access/assignments', { signal });

/** Grants "Desktop Virtualization User" on the DAG to a searched principal. ADMIN-only server-side, `reason` MANDATORY — see CreateAssignmentRequest's doc comment in @avdmgr/shared. */
export const createDesktopAssignment = (body: CreateAssignmentRequest) => apiClient.post<CreateAssignmentResponse>('/v1/access/assignments', body);

/** Revokes a "Desktop Virtualization User" grant by its roleAssignmentId (DesktopAssignment.roleAssignmentId — NOT principalId). ADMIN-only server-side, `reason` MANDATORY. 204 on success. */
export const removeDesktopAssignment = (roleAssignmentId: string, reason: string) => apiClient.delete<void>(`/v1/access/assignments/${encodeURIComponent(roleAssignmentId)}`, { body: { reason } });

/** Reads the configured workspace's current friendly name. viewer+ server-side. */
export const getWorkspaceFriendlyName = (signal?: AbortSignal) => apiClient.get<WorkspaceFriendlyNameResponse>('/v1/workspace/friendly-name', { signal });

/** Updates ONLY the workspace's friendly name (ARM merge-patch). Operator+ server-side, `reason` optional — see UpdateWorkspaceFriendlyNameRequest's doc comment in @avdmgr/shared. */
export const updateWorkspaceFriendlyName = (body: UpdateWorkspaceFriendlyNameRequest) => apiClient.patch<WorkspaceFriendlyNameResponse>('/v1/workspace/friendly-name', body);

// --- AM-15 (M7): Settings page ---

/** Reads the read-only, non-secret config surface backing the Settings page's "App configuration" card. viewer+ server-side — see app/api/src/functions/settings.ts. */
export const getSettings = (signal?: AbortSignal) => apiClient.get<SettingsResponse>('/v1/settings', { signal });

// --- AM-32 (M8-W3): audit read model — "Recent actions" drawer + Audit page ---

export interface RecentAuditParams {
  /** Max rows, newest first. Server default 25, bounded [1,100] — see app/api/src/functions/auditRecent.ts. */
  top?: number;
  /** Exact match on the actor field. Omitted = every actor. */
  actor?: string;
  /** "Starts with" match on the action field (e.g. "sessionhost."). Omitted = every action. */
  actionPrefix?: string;
  /** How far back to look, in hours. Server default 24, bounded [1,720]. */
  sinceHours?: number;
}

/**
 * GET /v1/audit/recent — operator+ (audit rows carry actor identities; see
 * that handler's doc comment). Backs both the EstateStrip "Recent actions"
 * drawer (RecentActionsDrawer.tsx, top=25/sinceHours=24, no filters) and the
 * Audit page (Audit.tsx, which exposes actor/actionPrefix/sinceHours as
 * filters). Query params are only appended when actually supplied — an
 * omitted param lets the server apply its own default/no-filter behavior,
 * rather than this wrapper re-encoding those defaults on the client side too.
 */
export const getRecentAuditEntries = (params: RecentAuditParams = {}, signal?: AbortSignal) => {
  const query = new URLSearchParams();
  if (params.top !== undefined) query.set('top', String(params.top));
  if (params.actor) query.set('actor', params.actor);
  if (params.actionPrefix) query.set('actionPrefix', params.actionPrefix);
  if (params.sinceHours !== undefined) query.set('sinceHours', String(params.sinceHours));
  const qs = query.toString();
  return apiClient.get<AuditRecentResponse>(`/v1/audit/recent${qs ? `?${qs}` : ''}`, { signal });
};
