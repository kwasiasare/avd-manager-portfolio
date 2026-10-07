/**
 * @avdmgr/shared
 *
 * Shared DTO / domain types used by both app/frontend and app/api so that the
 * two workspaces stay in sync on wire-format shapes. Keep these types
 * transport-agnostic (no Azure SDK types leaking in here) — mapping from
 * Azure SDK responses into these DTOs happens in app/api/src/services.
 */

import type { ScalingPhase } from './scalingPhase';

/** RBAC roles recognised by the app. Sourced from SWA clientPrincipal.userRoles. */
export type Role = 'viewer' | 'operator' | 'admin';

/** A single AVD host pool summary as surfaced to the UI. */
export interface HostPool {
  id: string;
  name: string;
  friendlyName?: string;
  resourceGroup: string;
  hostPoolType: 'Pooled' | 'Personal';
  loadBalancerType?: string;
  preferredAppGroupType?: string;
  maxSessionLimit?: number;
  validationEnvironment?: boolean;
  /** Whether a stopped/deallocated session host is started automatically on the first connection attempt. */
  startVMOnConnect?: boolean;
  /** The host pool's update ring number (validation/production rollout wave), if configured. */
  ring?: number;
  /**
   * Raw semicolon-delimited RDP property string as stored on the host pool
   * (e.g. `drivestoredirect:s:;redirectclipboard:i:1;...`). Left as the raw
   * string rather than parsed — the HostPool page's properties table
   * summarizes it (count of properties + first N) rather than fully
   * modeling every possible RDP property key.
   */
  customRdpProperty?: string;
  /**
   * Not populated by GET /api/v1/hostpools (list) to avoid an ARM N+1 call
   * per host pool. Populated by the drill-in endpoint (host pool detail),
   * once that exists.
   */
  sessionHostCount?: number;
}

/** Health check result reported by a session host. */
export interface HealthCheck {
  name: string;
  healthCheckResult: string;
  additionalFailureDetails?: string;
}

/**
 * Session host health/connection status. Mirrors @azure/arm-desktopvirtualization's
 * `Status` (an extensible string enum — the service may return values not yet
 * listed here). 'Unknown' is this app's own fallback bucket for any such value;
 * mapping code (app/api/src/services) must validate-or-fallback to it rather
 * than blindly casting the SDK's raw string.
 */
export type SessionHostStatus =
  | 'Available'
  | 'Unavailable'
  | 'Shutdown'
  | 'Disconnected'
  | 'Upgrading'
  | 'UpgradeFailed'
  | 'NoHeartbeat'
  | 'NotJoinedToDomain'
  | 'DomainTrustRelationshipLost'
  | 'SxSStackListenerNotReady'
  | 'FSLogixNotHealthy'
  | 'NeedsAssistance'
  | 'Unknown';

/**
 * VM power state, condensed from @azure/arm-compute's InstanceView status
 * codes (`PowerState/*`) down to the small set this app renders. 'unknown'
 * is the fallback bucket when the VM's instanceView couldn't be resolved
 * (e.g. transient ARM error, or the session host's resourceId didn't
 * resolve to a VM at all).
 */
export type PowerState = 'running' | 'starting' | 'stopping' | 'stopped' | 'deallocating' | 'deallocated' | 'unknown';

/** A single session host within a host pool. */
export interface SessionHost {
  id: string;
  name: string;
  hostPoolName: string;
  status: SessionHostStatus;
  /**
   * Whether the host is accepting new sessions. Drain mode (an admin-facing
   * concept) is derived in the UI as `!allowNewSession`, rather than stored
   * as a separate field that could disagree with allowNewSession.
   */
  allowNewSession: boolean;
  /**
   * ARM's raw `sessions` count on the SessionHost resource — despite the
   * field name, this is the TOTAL session count (Active + Disconnected +
   * Pending + ...), NOT active-only. AM-25 peer review caught real callers
   * conflating the two (a host with only disconnected sessions reads as
   * "busy" here even though zero users are actively connected) — do not use
   * this field to decide whether a host is "in use" for idle-detection
   * purposes; use per-session sessionState from listUserSessions instead
   * (see app/api/src/services/idleHostsService.ts's session-counting
   * helper). Kept under this name for wire-compatibility with existing
   * consumers (Dashboard/HostPool session-count displays, where "how many
   * sessions does this host have" is the intended, correct reading).
   */
  activeSessions: number;
  agentVersion?: string;
  osVersion?: string;
  lastHeartBeat?: string;
  healthChecks?: HealthCheck[];
  /**
   * Resolved from the underlying VM's instanceView (see
   * app/api/src/services/computeService.ts). Undefined if the VM's power
   * state couldn't be resolved rather than actually unknown to Azure — in
   * that case the UI should render a "power state unavailable" state, not
   * silently treat the host as running.
   */
  powerState?: PowerState;
}

/**
 * Request body for PATCH /v1/hostpools/{hostPoolName}/sessionhosts/{sessionHostName}/drain
 * (AM-18/M2-S1 — see app/api/src/functions/sessionHostDrain.ts). Requires at
 * least the 'operator' role.
 */
export interface DrainSessionHostRequest {
  /** false = start draining (stop accepting new sessions); true = resume accepting new sessions. */
  allowNewSession: boolean;
  /** Optional operator-supplied justification. Passed through to the audit log (app/api/src/lib/auditLog.ts) as-is; not otherwise validated or stored. */
  reason?: string;
}

/** Response body for the drain toggle endpoint — the session host as ARM reports it immediately after the update. */
export interface DrainSessionHostResponse {
  sessionHost: SessionHost;
}

/**
 * Request body for POST /v1/hostpools/{hostPoolName}/registration-token
 * (AM-22/M2-S5 — see app/api/src/functions/hostPoolRegistrationToken.ts).
 * Requires the 'admin' role: the resulting token is a standing bearer
 * credential that lets its holder register a new session host into the pool
 * for as long as it stays valid — a materially bigger blast radius than the
 * drain toggle's operator floor (AM-18), so this app reserves it for admins.
 */
export interface GenerateRegistrationTokenRequest {
  /**
   * How long the newly generated token should remain valid, in hours.
   * Server-enforced bounds: 1-648 (27 days) — Azure Virtual Desktop's own
   * documented hard maximum for a registration token (confirmed on
   * Microsoft Learn; see the handler's doc comment), not a wider "30 days"
   * (720h) figure a first pass at this feature might otherwise assume.
   */
  hoursValid: number;
}

/**
 * Response body for the registration-token generate endpoint. `token` is
 * the live, base64-encoded registration token value — returned to the
 * caller exactly once (same "shown once" UX as the AVD Portal's own
 * Registration key blade), never persisted by this app, and NEVER written
 * to the audit log (see the handler's doc comment for why — only
 * { hoursValid, expirationTime } are audited, never the token itself).
 */
export interface GenerateRegistrationTokenResponse {
  token: string;
  /** ISO timestamp the token stops being valid. */
  expirationTime: string;
}

/**
 * Response body for GET /v1/hostpools/{hostPoolName}/registration-token —
 * status only, NEVER the token value (see
 * app/api/src/services/avdService.ts#getRegistrationTokenStatus's doc
 * comment for the ARM-level reasoning, and the handler's doc comment for the
 * RBAC decision). `exists: false` covers both "no token was ever generated"
 * and "the last generated token has already expired" — both mean the same
 * thing to a caller deciding whether to generate a fresh one, so this DTO
 * deliberately does not distinguish them.
 */
export interface RegistrationTokenStatus {
  exists: boolean;
  /** ISO timestamp the (still-valid) token expires. Undefined when exists is false. */
  expirationTime?: string;
}

/**
 * Best-effort parse of the host pool's `vmTemplate` property, surfaced by
 * GET /v1/hostpools/{hostPoolName}/vm-template (AM-22/M2-S5 — see
 * app/api/src/functions/hostPoolVmTemplate.ts) for the Add session host
 * panel's "prefilled parameters" display.
 *
 * IMPORTANT: ARM documents vmTemplate only as an opaque JSON string with NO
 * published sub-schema (confirmed against Microsoft Learn's
 * Microsoft.DesktopVirtualization/hostPools template reference, which types
 * the property as plain `string` and nothing more) — the field names below
 * are inferred from what the AVD portal itself writes into that blob in
 * practice, NOT a Microsoft Learn-verified contract. Every field is
 * therefore optional, and `raw` preserves the full parsed object so the UI
 * never silently loses data to a wrong field-name guess.
 */
export interface VmTemplateInfo {
  /** False if vmTemplate was missing/empty or failed to parse as JSON — every other field is then undefined and `raw` is omitted. */
  parsed: boolean;
  imageType?: string;
  galleryImagePublisher?: string;
  galleryImageOffer?: string;
  galleryImageSKU?: string;
  galleryImageVersion?: string;
  customImageId?: string;
  /** e.g. "Standard_D4ads_v7" — see the session-host runbook §1. */
  vmSizeId?: string;
  osDiskType?: string;
  namePrefix?: string;
  /** AD domain to join, if the pool is domain-joined. Empty/absent for an Entra-ID-only pool (e.g. HP-CONTOSO-PROD — see the session-host runbook §2). */
  domain?: string;
  ouPath?: string;
  hibernate?: boolean;
  /**
   * The full parsed vmTemplate object, for any field not explicitly
   * modeled above. Omitted when parsed is false.
   *
   * SECURITY NOTE: exposed to every operator+ caller as-is (see
   * app/api/src/services/avdService.ts#parseVmTemplate's doc comment,
   * where this field is populated) — the current prod vmTemplate blob was
   * manually reviewed and contains no secrets, but any NEWLY-appearing
   * field in a future vmTemplate must be re-reviewed (or this switched to
   * an explicit allow-list) before being trusted to not carry one.
   */
  raw?: Record<string, unknown>;
}

/**
 * VM power actions the operator/admin can trigger against a session host's
 * underlying VM (AM-19/M2-S2 — see
 * app/api/src/functions/sessionHostPower.ts). Deliberately excludes
 * 'stop'/'powerOff' (billed but not accepting sessions — not a state this
 * app's power menu offers) and anything destructive (delete, reimage).
 */
export type SessionHostPowerAction = 'start' | 'restart' | 'deallocate';

/**
 * Request body for POST /v1/hostpools/{hostPoolName}/sessionhosts/{sessionHostName}/power
 * (AM-19/M2-S2). Requires at least the 'operator' role.
 */
export interface SessionHostPowerRequest {
  action: SessionHostPowerAction;
  /** Optional operator-supplied justification. Passed through to the audit log as-is. */
  reason?: string;
  /**
   * The session host's activeSessions count, as last observed by the caller
   * (SessionHost.activeSessions) — NOT re-read server-side before acting,
   * and NOT trusted as the audit-of-record count either: the server
   * independently re-reads the authoritative count from ARM while resolving
   * the VM (see app/api/src/services/avdService.ts#resolveSessionHostVm) and
   * records THAT under the audit row's `activeSessions` key, recording this
   * client value separately under `clientReportedActiveSessions` (AM-19 peer
   * review item 1 — a stale/incorrect client value must never be
   * indistinguishable from a genuinely idle host in the log). Purely
   * informational here: the frontend's drain-first prompt (shown when this
   * is > 0 for a restart/deallocate) is a UI nudge, not a server-enforced
   * block — an operator can proceed anyway, which is why this is passed
   * through at all, so the audit trail records what the operator SAW, not
   * whether draining happened first. Undefined when the caller didn't have
   * (or didn't send) a session count.
   */
  activeSessions?: number;
}

/**
 * Response body for the power-action endpoint. Always 'accepted': the
 * handler awaits only the ARM long-running operation's INITIAL submission
 * (poller.submitted()), not its completion (poller.pollUntilDone()) — see
 * app/api/src/services/computeService.ts#beginVmPowerAction for why. The
 * caller should treat this as "Azure accepted the request and is working on
 * it", not "the VM has finished starting/restarting/deallocating" —
 * re-poll GET .../sessionhosts to observe the actual power state.
 */
export interface SessionHostPowerResponse {
  status: 'accepted';
  action: SessionHostPowerAction;
  sessionHostName: string;
  /** Same correlationId the server logged/audited for this request — surfaced so a support ticket can reference it directly from the accepted response, not just from an error response (AM-19 peer review item 6). */
  correlationId: string;
}

/**
 * User session state. Mirrors @azure/arm-desktopvirtualization's `SessionState`
 * (also an extensible string enum); 'Unknown' is the fallback bucket.
 */
export type UserSessionState = 'Active' | 'Disconnected' | 'Pending' | 'LogOff' | 'UserProfileDiskMounted' | 'Unknown';

/**
 * The known/valid UserSessionState values ARM can actually report —
 * deliberately excludes 'Unknown', which is this app's own fallback bucket
 * for any value not in this list (not something ARM itself sends). Single
 * source of truth for both app/api/src/services/avdService.ts's
 * normalizeSessionState (validate-or-fallback-to-Unknown) and the
 * frontend's Sessions page state filter (which adds 'Unknown' back in
 * itself, since a real session's normalized state can land there). A
 * plain string-literal array, so this doesn't give app/shared any new
 * dependency — same rule computeScalingPhase below already follows.
 */
export const KNOWN_USER_SESSION_STATES: readonly UserSessionState[] = ['Active', 'Disconnected', 'Pending', 'LogOff', 'UserProfileDiskMounted'];

/** An active/disconnected user session on a session host. */
export interface UserSession {
  id: string;
  /**
   * The short userSessionId ARM assigns this session (the final segment of
   * `id`, e.g. "2") — distinct from `id` (the full ARM resource path). This
   * is the value the M2-S3 session-operation routes
   * (app/api/src/functions/sessionForceLogoff.ts,
   * sessionSendMessage.ts) take as their `{sessionId}` route segment.
   */
  sessionId: string;
  userPrincipalName: string;
  sessionHostName: string;
  hostPoolName: string;
  sessionState: UserSessionState;
  createTime: string;
  applicationType?: string;
}

/**
 * Request body for POST /v1/hostpools/{hostPoolName}/sessionhosts/{sessionHostName}/sessions/{sessionId}/logoff
 * (AM-20/M2-S3 — see app/api/src/functions/sessionForceLogoff.ts). Requires
 * at least the 'operator' role. Unlike DrainSessionHostRequest's reason,
 * `reason` here is MANDATORY — forcing a user off is more disruptive than a
 * drain toggle and must always be justified.
 */
export interface ForceLogoffSessionRequest {
  reason: string;
  /**
   * Optional, caller-supplied (from the session row the operator clicked
   * "Force logoff" on) — purely for a friendlier audit trail entry. Not
   * validated against the actual session's UPN server-side; the server
   * looks up nothing extra to avoid an additional ARM call on the hot path.
   */
  userPrincipalName?: string;
}

/** Response body for the force-logoff endpoint. */
export interface ForceLogoffSessionResponse {
  sessionId: string;
}

/**
 * Request body for POST /v1/hostpools/{hostPoolName}/sessionhosts/{sessionHostName}/sessions/{sessionId}/message
 * (AM-20/M2-S3 — see app/api/src/functions/sessionSendMessage.ts). Requires
 * at least the 'operator' role. `body` is mandatory; `title` is optional
 * (mirrors ARM's own SendMessage.messageTitle/messageBody shape).
 */
export interface SendSessionMessageRequest {
  title?: string;
  body: string;
}

/** Response body for the send-message endpoint. */
export interface SendSessionMessageResponse {
  sessionId: string;
}

/**
 * Request body for POST /v1/hostpools/{hostPoolName}/sessions/logoff-disconnected
 * (AM-20/M2-S3 — see app/api/src/functions/sessionsLogoffDisconnected.ts).
 * Requires at least the 'operator' role. `reason` is MANDATORY, same
 * rationale as ForceLogoffSessionRequest.
 */
export interface LogoffAllDisconnectedRequest {
  reason: string;
}

/**
 * Request body for POST /v1/hostpools/{hostPoolName}/sessions/broadcast
 * (AM-20/M2-S3 — see app/api/src/functions/sessionsBroadcast.ts). Requires
 * at least the 'operator' role. `body` is mandatory; `title` is optional.
 */
export interface BroadcastSessionMessageRequest {
  title?: string;
  body: string;
}

/**
 * One session's failure within a batch session operation (logoff-all-
 * disconnected or broadcast) — a single session failing must not fail the
 * whole batch (see app/api/src/lib/sessionBatch.ts's runSessionBatch).
 * `message` is a SHORT, SANITIZED classification (e.g. "Azure request
 * failed (HTTP 429)"), not the raw ARM/REST error text — a RestError's
 * message can embed the full outbound request (including its body), which
 * must never round-trip into a response body the UI renders (CWE-532). The
 * raw error is still available server-side via the Function App's logs,
 * joinable by the batch's correlationId.
 */
export interface SessionBatchFailure {
  sessionId: string;
  sessionHostName: string;
  userPrincipalName: string;
  message: string;
}

/**
 * Aggregate outcome of a batch session operation across every targeted
 * session. `skipped` counts sessions where the per-session action hit a 404
 * (the session had already vanished between enumeration and the action —
 * the COMMON case for a disconnected session the user closes client-side)
 * — these are NOT counted in `failed` and do not flip the batch's audit
 * outcome to 'failure', since a session disappearing on its own is exactly
 * what "log off disconnected sessions" would have achieved anyway.
 */
export interface SessionBatchResult {
  attempted: number;
  succeeded: number;
  skipped: number;
  failed: SessionBatchFailure[];
}

/** Response body for the logoff-all-disconnected endpoint. */
export interface LogoffAllDisconnectedResponse {
  result: SessionBatchResult;
  correlationId: string;
}

/** Response body for the broadcast endpoint. */
export interface BroadcastSessionMessageResponse {
  result: SessionBatchResult;
  correlationId: string;
}

/** A golden image definition in the Azure Compute Gallery. */
export interface ImageDefinition {
  id: string;
  name: string;
  galleryName: string;
  resourceGroup: string;
  osType: 'Windows' | 'Linux';
  publisher?: string;
  offer?: string;
  sku?: string;
  latestVersion?: string;
}

/** A specific version of an image definition. */
export interface ImageVersion {
  id: string;
  name: string;
  imageDefinitionName: string;
  publishedDate?: string;
  excludeFromLatest: boolean;
  replicaCount?: number;
  targetRegions?: string[];
  provisioningState?: string;
}

/**
 * Latest published version of the configured image definition, as surfaced
 * on the Dashboard's image version badge. Extends ImageVersion with fields
 * derived server-side (age / EOL countdown) so the frontend doesn't need to
 * duplicate date math or know the EOL date source (IMAGE_EOL_DATE config —
 * Azure has no API for "OS support end date", so this is operator-supplied).
 */
export interface ImageVersionCurrent extends ImageVersion {
  /** Whole days since publishedDate, or undefined if publishedDate is unknown. */
  ageDays?: number;
  /** ISO date (YYYY-MM-DD) the image's underlying OS falls out of support. Undefined if not configured. */
  eolDate?: string;
  /** Whole days until eolDate (negative if already past). Undefined if eolDate is unknown. */
  daysUntilEol?: number;
}

/**
 * AM-26 (M4-S1): one entry in the full version history timeline for the
 * configured image definition (GET /v1/images/versions), newest-first by
 * publishedDate. Extends ImageVersion with the same derived age/EOL fields
 * ImageVersionCurrent carries for the latest version alone — see
 * app/api/src/services/imagesService.ts#buildVersionTimeline for exactly
 * how each is derived for a non-latest (historical) version, which differs
 * in one respect: eolDate falls back to config's IMAGE_EOL_DATE only for
 * the current/isCurrent entry — that fallback describes the CURRENT golden
 * image's underlying OS, not any older version's, so it is never applied
 * to a version this app can't otherwise attribute an EOL date to.
 */
export interface ImageVersionTimelineEntry extends ImageVersion {
  ageDays?: number;
  eolDate?: string;
  daysUntilEol?: number;
  /**
   * Aggregated regional replication state as ARM reports it on the
   * version's own replicationStatus.aggregatedState (e.g. "Completed",
   * "InProgress", "Failed", "Unknown") — verified against this repo's
   * installed @azure/arm-compute@25. Distinct from provisioningState (the
   * ARM control-plane resource state, already on ImageVersion) — a version
   * can be provisioningState: "Succeeded" while still replicationState:
   * "InProgress" to some target region.
   */
  replicationState?: string;
  /**
   * OS disk size in GiB, read directly off the version's own
   * storageProfile.osDiskImage.sizeInGB — no extra ARM call, it's already
   * present on the same listByGalleryImage response used to build this
   * whole timeline (verified against the installed SDK's GalleryDiskImage
   * model). Undefined if ARM didn't report it.
   */
  sizeGib?: number;
  /**
   * True for exactly the one version buildVersionTimeline (imagesService.ts)
   * resolves as "current" — the same version GET /v1/images/current
   * returns (same excludeFromLatest-aware "latest" definition — see
   * pickLatest's doc comment). At most one entry has this true; none do if
   * the definition has zero eligible versions.
   */
  isCurrent: boolean;
  /**
   * Count of session hosts (in the configured host pool) whose VM was
   * created from exactly this version, per correlateHostsToVersions. A
   * real 0 is a valid, meaningful count — see ImageVersionsResponse.
   * hostCorrelations for the hosts that could NOT be attributed to any
   * version at all (a different case than "attributed, count 0").
   */
  hostCount: number;
}

/**
 * AM-26: one session host's attempted correlation to a gallery image
 * version, via its underlying VM's storageProfile.imageReference.id
 * (verified against this repo's installed @azure/arm-compute@25 — see
 * app/api/src/services/imagesService.ts#correlateHostsToVersions's doc
 * comment for the exact field path and the id shapes it recognizes).
 */
export interface SessionHostImageCorrelation {
  sessionHostName: string;
  /** The matched version's `name` (e.g. "2.0.0"), or undefined if unresolved — see unknownReason. */
  imageVersionName?: string;
  /** Populated only when imageVersionName is undefined — states specifically why (see correlateHostsToVersions), never a generic "unknown" with no explanation. */
  unknownReason?: string;
}

/** Response body for GET /v1/images/versions (AM-26). */
export interface ImageVersionsResponse {
  imageDefinitionName: string;
  /** Newest-first by publishedDate — see buildVersionTimeline. */
  versions: ImageVersionTimelineEntry[];
  hostCorrelations: SessionHostImageCorrelation[];
}

/**
 * AM-26: one managed-disk snapshot in the image resource group(s) (GET
 * /v1/images/snapshots) — see app/api/src/services/snapshotsService.ts for
 * the orphan heuristic and cost-estimate rate this is built from.
 */
export interface ImageSnapshot {
  id: string;
  name: string;
  resourceGroup: string;
  /** ISO timestamp — ARM's own readonly timeCreated. Undefined only if ARM omitted it. */
  createdDate?: string;
  ageDays?: number;
  /** The snapshot's PROVISIONED size (ARM's diskSizeGB, falling back to diskSizeBytes) — see estMonthlyCostUsd's doc comment for why this is an upper bound on the true billed size, not the billed size itself. */
  sizeGib?: number;
  /**
   * UPPER-BOUND monthly storage cost estimate in USD: sizeGib (the
   * snapshot's PROVISIONED size) × a fixed approximate $/GiB-month rate
   * constant (NOT a live Azure Retail Prices API lookup — see
   * snapshotsService.ts's APPROX_SNAPSHOT_GIB_MONTHLY_RATE_USD doc comment
   * for the rate's source). AM-26 peer review MAJOR 1: Azure actually
   * meters BOTH full and incremental managed-disk snapshots by USED
   * (allocated) bytes, not provisioned size — this app has no cheap way to
   * read a snapshot's used-byte count (it would need additional Compute
   * Disk data-plane access this app's managed identity does not have), so
   * this figure is deliberately the provisioned-size upper bound, never
   * presented as the actual bill. The UI must carry this caveat visibly
   * (see Images.tsx), not just in this comment. Undefined when sizeGib is
   * unavailable.
   */
  estMonthlyCostUsd?: number;
  provisioningState?: string;
  /** e.g. "Standard_LRS", "Standard_ZRS" — the snapshot's own storage SKU. */
  sku?: string;
  /**
   * Whether classifyOrphan (snapshotsService.ts) could confidently
   * determine this snapshot is not currently in use. PRIMARY gate: no disk
   * currently existing in the scanned resource group(s) was created FROM
   * this snapshot (creationData.sourceResourceId pointing at it) — i.e.
   * "not attached as a source of anything current". The snapshot's OWN
   * source disk (what it was itself created FROM) existing or not is
   * SECONDARY, supporting context folded into orphanReason's text, not a
   * second gate — see classifyOrphan's doc comment for why.
   *
   * AM-26 peer review MAJOR 3: `undefined` (NOT `false`) when the disk
   * listing needed to run this classification was itself incomplete for
   * at least one scanned resource group (a listing failed, or came back
   * anomalously empty) — see SnapshotReportResponse.scanIncomplete. This
   * app refuses to assert either `true` or `false` in that case rather
   * than silently defaulting to the alarming "orphaned" answer (or the
   * falsely-reassuring "not orphaned" one) on data it could not verify.
   */
  orphaned?: boolean;
  /** States what was actually observed for THIS snapshot — never generic boilerplate (mirrors idleHostDetector.ts's buildReason convention). Always populated, including when `orphaned` is undefined (explains WHY the scan was incomplete for this snapshot). */
  orphanReason: string;
}

/** Response body for GET /v1/images/snapshots (AM-26). */
export interface SnapshotReportResponse {
  resourceGroupsScanned: string[];
  snapshots: ImageSnapshot[];
  /**
   * True when the disk listing needed to classify orphan status could not
   * be fully trusted for at least one of resourceGroupsScanned — a
   * per-resource-group disk (or snapshot) listing failed, or a listing
   * that should never realistically be empty (RG-AVD-HostPools, which
   * holds every session host's OS disk) came back with zero results
   * anyway. When true, every snapshot's `orphaned` is undefined, not
   * defaulted — see ImageSnapshot.orphaned's doc comment. AM-26 peer
   * review MAJOR 3.
   */
  scanIncomplete: boolean;
}

/** A time-of-day, hour/minute, in the scaling plan's own timeZone (no UTC conversion applied). */
export interface ScalingSchedulePeriod {
  hour: number;
  minute: number;
}

/**
 * AVD autoscale's session-host load-balancing algorithm, per phase. Verified
 * against @azure/arm-desktopvirtualization's KnownSessionHostLoadBalancingAlgorithm
 * (the SDK types the wire value as an extensible `string`, but these are the
 * only two values the service documents/accepts).
 */
export type LoadBalancingAlgorithm = 'BreadthFirst' | 'DepthFirst';

/**
 * Ramp-down host-shutdown condition. Verified against
 * @azure/arm-desktopvirtualization's KnownStopHostsWhen.
 */
export type StopHostsWhen = 'ZeroSessions' | 'ZeroActiveSessions';

/**
 * One named schedule within a scaling plan (AM-23/M3-S1: one per
 * daysOfWeek grouping — SCALE-CONTOSO-PROD currently has a single "AllDays"
 * schedule covering every day, but the schedule-editor API supports
 * splitting into several named schedules with disjoint daysOfWeek, each
 * independently editable — see POST/PATCH/DELETE
 * /v1/scalingplans/current/schedules and /v1/scalingplans/current/schedules/{name}).
 *
 * Mirrors @azure/arm-desktopvirtualization's ScalingSchedule /
 * ScalingPlanPooledSchedule shape (the two SDK types are structurally
 * identical; ScalingPlanPooledSchedule is the child-resource form returned
 * by the scalingPlanPooledSchedules operation group this app's edit/create/
 * delete endpoints use — see app/api/src/services/avdService.ts). Every
 * field beyond the four start times is optional here because ARM itself
 * treats them as optional/nullable on read — a schedule missing e.g.
 * rampUpCapacityThresholdPct is a real, valid state, not a mapping bug.
 */
export interface ScalingScheduleDetail {
  /** Schedule (ARM child-resource) name, e.g. "AllDays". Required in the read shape — every schedule ARM returns has one — even though a brand-new schedule is create()'d by passing its name as a route/path segment, not a body field (see ScalingScheduleCreateRequest). */
  name: string;
  daysOfWeek: string[];
  rampUpStartTime: ScalingSchedulePeriod;
  rampUpLoadBalancingAlgorithm?: LoadBalancingAlgorithm;
  /** Minimum percentage (0-100) of the pool's session hosts kept running through ramp-up. */
  rampUpMinimumHostsPct?: number;
  /** Percentage (1-100) of used host-pool capacity that triggers ramp-up scale-out. */
  rampUpCapacityThresholdPct?: number;
  peakStartTime: ScalingSchedulePeriod;
  peakLoadBalancingAlgorithm?: LoadBalancingAlgorithm;
  rampDownStartTime: ScalingSchedulePeriod;
  rampDownLoadBalancingAlgorithm?: LoadBalancingAlgorithm;
  /** Minimum percentage (0-100) of the pool's session hosts kept running through ramp-down/off-peak. */
  rampDownMinimumHostsPct?: number;
  /** Percentage (1-100) of used host-pool capacity that triggers ramp-down scale-in. */
  rampDownCapacityThresholdPct?: number;
  rampDownForceLogoffUsers?: boolean;
  rampDownStopHostsWhen?: StopHostsWhen;
  rampDownWaitTimeMinutes?: number;
  rampDownNotificationMessage?: string;
  offPeakStartTime: ScalingSchedulePeriod;
  offPeakLoadBalancingAlgorithm?: LoadBalancingAlgorithm;
}

/**
 * PATCH /v1/scalingplans/current/schedules/{scheduleName} request body — every
 * field optional (a partial update of an EXISTING named schedule via ARM's
 * scalingPlanPooledSchedules.update; only fields present here are sent to
 * ARM). `reason` is an optional operator justification recorded on the audit
 * row, same convention as DrainSessionHostRequest.
 */
export interface ScalingSchedulePatchRequest {
  daysOfWeek?: string[];
  rampUpStartTime?: ScalingSchedulePeriod;
  rampUpLoadBalancingAlgorithm?: LoadBalancingAlgorithm;
  rampUpMinimumHostsPct?: number;
  rampUpCapacityThresholdPct?: number;
  peakStartTime?: ScalingSchedulePeriod;
  peakLoadBalancingAlgorithm?: LoadBalancingAlgorithm;
  rampDownStartTime?: ScalingSchedulePeriod;
  rampDownLoadBalancingAlgorithm?: LoadBalancingAlgorithm;
  rampDownMinimumHostsPct?: number;
  rampDownCapacityThresholdPct?: number;
  rampDownForceLogoffUsers?: boolean;
  rampDownStopHostsWhen?: StopHostsWhen;
  rampDownWaitTimeMinutes?: number;
  rampDownNotificationMessage?: string;
  offPeakStartTime?: ScalingSchedulePeriod;
  offPeakLoadBalancingAlgorithm?: LoadBalancingAlgorithm;
  reason?: string;
}

export interface ScalingSchedulePatchResponse {
  schedule: ScalingScheduleDetail;
}

/**
 * POST /v1/scalingplans/current/schedules request body — creates a NEW named
 * schedule via ARM's scalingPlanPooledSchedules.create (the mechanism this
 * app uses to support per-day-of-week overrides: split the existing
 * "AllDays" schedule's daysOfWeek down via a PATCH, then create one or more
 * additional schedules — each with its own disjoint daysOfWeek — for the
 * split-off days). Unlike the patch body, the four start times and
 * daysOfWeek are mandatory: ARM's create call expects a complete schedule,
 * not a partial one.
 */
export interface ScalingScheduleCreateRequest {
  /** New schedule (ARM child-resource) name — 1-64 chars, `^[A-Za-z0-9@.\-_ ]*$` (ARM-documented pattern for Microsoft.DesktopVirtualization/scalingPlans/pooledSchedules). */
  name: string;
  daysOfWeek: string[];
  rampUpStartTime: ScalingSchedulePeriod;
  rampUpLoadBalancingAlgorithm?: LoadBalancingAlgorithm;
  rampUpMinimumHostsPct?: number;
  rampUpCapacityThresholdPct?: number;
  peakStartTime: ScalingSchedulePeriod;
  peakLoadBalancingAlgorithm?: LoadBalancingAlgorithm;
  rampDownStartTime: ScalingSchedulePeriod;
  rampDownLoadBalancingAlgorithm?: LoadBalancingAlgorithm;
  rampDownMinimumHostsPct?: number;
  rampDownCapacityThresholdPct?: number;
  rampDownForceLogoffUsers?: boolean;
  rampDownStopHostsWhen?: StopHostsWhen;
  rampDownWaitTimeMinutes?: number;
  rampDownNotificationMessage?: string;
  offPeakStartTime: ScalingSchedulePeriod;
  offPeakLoadBalancingAlgorithm?: LoadBalancingAlgorithm;
  reason?: string;
}

export interface ScalingScheduleCreateResponse {
  schedule: ScalingScheduleDetail;
}

/** DELETE /v1/scalingplans/current/schedules/{scheduleName} response — echoes the deleted name for the caller's own confirmation UI. */
export interface ScalingScheduleDeleteResponse {
  deletedScheduleName: string;
}

/**
 * POST /v1/scalingplans/current/emergency-override request body — "keep all
 * hosts up" override. `minutes` bounds this app enforces itself (15-480,
 * i.e. 15 minutes to 8 hours) — not an ARM-documented limit, a deliberately
 * bounded operational safety valve so an override can't be silently
 * forgotten forever. `reason` is MANDATORY (unlike the optional reason on
 * routine schedule edits) — this action pauses cost-saving autoscale
 * entirely, so it must always be justified.
 */
export interface EmergencyOverrideRequest {
  minutes: number;
  reason: string;
  /**
   * When an override is ALREADY active, POSTing without extend:true is
   * rejected (409) rather than silently resetting an in-progress override —
   * set true to explicitly extend/replace the active override's duration
   * (audited as a distinct 'scalingplan.emergency_override.extend' action,
   * not a fresh 'activate'). Ignored (has no effect, but is not an error)
   * when no override is currently active.
   */
  extend?: boolean;
}

/**
 * Current emergency-override state, returned by both the POST/DELETE
 * mutation endpoints and the standalone GET status endpoint — one shape so
 * the frontend's banner can consume any of the three responses identically.
 */
export interface EmergencyOverrideStatus {
  active: boolean;
  activatedBy?: string;
  activatedAt?: string;
  expiresAt?: string;
  /** Whole minutes remaining until expiresAt, floored at 0 — never negative, even if the auto-re-enable timer hasn't run yet. */
  minutesRemaining?: number;
  minutes?: number;
  reason?: string;
}

/**
 * Full detail for the scaling plan currently applied to the configured host
 * pool (GET /api/v1/scalingplans/current). `timeZone` is an IANA-style or
 * Windows timezone id as stored by AVD (e.g. "Eastern Standard Time") — the
 * frontend's phase computation (app/frontend/src/lib/scalingPhase.ts) maps
 * known AVD timezone ids to an IANA zone for `Intl` purposes.
 */
export interface ScalingPlanDetail {
  id: string;
  name: string;
  hostPoolName: string;
  timeZone: string;
  enabled: boolean;
  schedules: ScalingScheduleDetail[];
}

/** Summary of an autoscale scaling plan and its current schedule state. */
export interface ScalingPlanSummary {
  id: string;
  name: string;
  hostPoolName: string;
  timeZone?: string;
  enabled: boolean;
  currentSchedule?: string;
  hostPoolsCount?: number;
}

/**
 * Aggregate session-host health counts for a host pool, derived server-side
 * from GET /api/v1/hostpools/{name}/sessionhosts (see
 * app/api/src/services/healthService.ts for the categorisation rules).
 * Powers the Dashboard's health ring. `total` always equals
 * `available + unavailable + draining`.
 */
export interface HealthSummary {
  hostPoolName: string;
  total: number;
  available: number;
  unavailable: number;
  draining: number;
  sessionsUsed: number;
  sessionsMax: number;
}

/**
 * Spend attributed to one resource group within the cost dashboard's tracked
 * set (see app/api/src/lib/config.ts's resourceGroups — the RG-AVD-* groups
 * this app's managed identity has Cost Management Reader on).
 */
export interface CostByResourceGroup {
  resourceGroup: string;
  cost: number;
}

/**
 * Month-to-date cost summary for the AVD environment
 * (GET /api/v1/cost/summary), aggregated across the tracked resource groups.
 * `priorMonthSamePeriodCost` and `projectedMonthEndCost` are undefined when
 * they can't be computed (e.g. a Cost Management query failed, or today is
 * the 1st of the month so there's no elapsed-day rate to project from) —
 * the frontend should render "unavailable" rather than a fabricated 0.
 */
export interface CostSummary {
  currency: string;
  /**
   * ISO date (YYYY-MM-DD) of the most recent COMPLETE day actually returned
   * by Cost Management — NOT today's date. Cost Management's data for the
   * current in-progress day is frequently partial/not-yet-ingested; when
   * the latest day returned equals today, that day is dropped from
   * monthToDateCost (and from the day-count used for
   * priorMonthSamePeriodCost/projectedMonthEndCost below) and asOfDate
   * reflects the day before instead — see
   * app/api/src/services/costService.ts#computeCostSummary's doc comment
   * for the exact rule (including the day-1-of-month exception).
   */
  asOfDate: string;
  monthToDateCost: number;
  /**
   * Cost for the same number of COMPLETE elapsed calendar days in the prior
   * month (e.g. if asOfDate is the 15th, this is the prior month's 1st-15th
   * total) — a like-for-like comparison rather than the prior month's full
   * total. Undefined unless EVERY tracked resource group's prior-month
   * query succeeded — a partial sum (some resource groups silently missing)
   * would understate the comparison and mislead the delta badge, so this is
   * all-or-nothing rather than a best-effort partial total.
   */
  priorMonthSamePeriodCost?: number;
  /**
   * Simple linear projection: (monthToDateCost / completeDaysElapsed) *
   * daysInThisMonth, where completeDaysElapsed excludes any dropped
   * trailing partial day (see asOfDate above). Undefined when fewer than 2
   * complete days of data are available — a 1-day (or 0-day) sample is too
   * noisy to extrapolate a whole month from. Does not account for known
   * future ramp changes, weekday/weekend usage patterns, or partial-day
   * billing — it's a rough "if the rest of the month looks like the days so
   * far" estimate, not a forecast from Azure's own Forecast API.
   */
  projectedMonthEndCost?: number;
  byResourceGroup: CostByResourceGroup[];
  /**
   * AM-39 — true when a fresh Cost Management fetch failed (timed out,
   * throttled, or errored) and this response is the last-known-good value
   * served from costService.ts's TTL cache instead of a 5xx. `asOfDate`
   * above still reflects the underlying DATA's freshness (the last complete
   * day Cost Management actually returned as of when this was computed);
   * when `stale` is true, treat that date as potentially older than usual —
   * the summary hasn't been re-verified against Cost Management since. Omit
   * entirely (not `false`) on a normal fresh response.
   */
  stale?: boolean;
  /**
   * AM-40 peer review MAJOR 3 — ISO timestamp of the instant this
   * CostSummary was actually computed (cache-write time in
   * costService.ts#getCostSummary), independent of `asOfDate`'s
   * day-granularity DATA freshness. Always present, on both fresh and
   * stale responses. A stale-served 200 is a SUCCESSFUL fetch as far as
   * the frontend's usePolling is concerned (see `stale`'s own doc comment
   * above), so PageHeader's own "as of HH:MM" — driven by usePolling's
   * lastUpdated, i.e. when the HTTP response arrived, not when the
   * underlying summary was computed — would otherwise read as fresh even
   * when serving a cached value from minutes ago. `computedAt` is the one
   * field that tells the truth about how old the CACHED VALUE ITSELF is;
   * the Cost page's stale caveat renders it explicitly for exactly this
   * reason.
   */
  computedAt: string;
}

/**
 * Running vs. deallocated hours for one session host over a lookback window
 * (GET /api/v1/cost/host-runtime, 7 days). See
 * app/api/src/services/hostRuntimeService.ts for the data-source limitation
 * this is derived under (no Heartbeat/AMA on this estate's session hosts —
 * WVDAgentHealthStatus presence-per-hour is used as a coarser proxy).
 * `runningHours + deallocatedHours + unknownHours` always equals
 * `windowHours`. `windowHours` is NOT always the nominal 7×24=168: when a
 * host's earliest telemetry is later than the nominal window start (e.g.
 * the host was added to the pool partway through the lookback period),
 * `windowHours` is clamped to the host's own first-seen hour so it isn't
 * shown as "deallocated" for hours before it existed — see
 * app/api/src/services/hostRuntimeService.ts#summarizeHostRuntime.
 */
export interface HostRuntimeSummary {
  sessionHostName: string;
  hostPoolName: string;
  runningHours: number;
  deallocatedHours: number;
  /** Hours where the signal itself was unavailable (e.g. a data-source query failure) — not attributed to either bucket. */
  unknownHours: number;
  windowHours: number;
  dataSource: 'WVDAgentHealthStatus' | 'none';
}

/** Provisioned-vs-used snapshot for the FSLogix profile share (GET /api/v1/cost/fslogix-usage). */
export interface FslogixShareUsage {
  storageAccountName: string;
  shareName: string;
  provisionedGib: number;
  usedBytes: number;
  usedGib: number;
  /** 0-100, clamped. 0 when provisionedGib is 0 (avoids a divide-by-zero NaN reaching the UI). */
  percentUsed: number;
}

/**
 * A session host detected running when it shouldn't be (candidate for
 * scale-in / cost savings) — GET /api/v1/cost/idle-hosts. See
 * app/api/src/services/idleHostDetector.ts for the pure detection rule this
 * is produced by (unit tested against fixture schedules).
 *
 * `activeSessions`/`disconnectedSessions` here are derived from per-session
 * sessionState (listUserSessions), NOT from SessionHost.activeSessions —
 * see that field's doc comment for why: SessionHost.activeSessions is
 * ARM's raw total session count and cannot distinguish "genuinely busy"
 * from "only has a stale disconnected session," which is exactly the
 * known idle-host leak this detector exists to catch (see
 * The scaling-plan runbook §6) — a detector keyed off the raw
 * total would NEVER flag that case, silently contradicting its own
 * evidence text.
 */
export interface IdleHostFinding {
  sessionHostName: string;
  hostPoolName: string;
  powerState: PowerState;
  phase: ScalingPhase;
  /** Count of sessions with sessionState === 'Active' on this host, right now. */
  activeSessions: number;
  /** Count of sessions with sessionState === 'Disconnected' on this host, right now — the evidence for the documented idle-host leak when > 0. */
  disconnectedSessions: number;
  /**
   * Best-effort ISO timestamp of when the host most likely started its
   * current running stretch, derived from HostRuntimeSummary's hourly
   * presence data (the earliest hour in an unbroken run of "seen" hours
   * ending now, tolerating up to a 2-hour gap for query/ingestion lag) —
   * undefined when that data isn't available/derivable.
   */
  runningSinceApprox?: string;
  /** States only what was actually observed for THIS host (zero sessions of any kind, vs. N disconnected-only sessions) — never a boilerplate paragraph, see idleHostDetector.ts. */
  reason: string;
}

/**
 * Response shape for GET /api/v1/cost/idle-hosts. `evaluated: false` means
 * no scaling plan is associated with the host pool, so idle-host detection
 * genuinely could not run — `findings` is always `[]` in that case too, but
 * for a DIFFERENT reason than a real all-clear (evaluated: true, findings:
 * []), and the UI must say so distinctly rather than reporting "no idle
 * hosts" when detection never actually happened.
 */
export interface IdleHostsResult {
  evaluated: boolean;
  findings: IdleHostFinding[];
}

/**
 * A server-derived, structured cost/scaling observation (GET
 * /api/v1/cost/savings) — deliberately NOT free prose generated in the
 * frontend; the API computes 1-3 of these from the same data sources as the
 * other /v1/cost/* endpoints (idle-host findings, StartVMOnConnect state,
 * running-hours outliers).
 */
export interface SavingsOpportunity {
  severity: 'info' | 'warning' | 'critical';
  title: string;
  detail: string;
}

/**
 * AM-13 (M5) — FSLogix profile management.
 *
 * How a profile folder name (e.g. "S-1-5-21-...-1113_jdoe") was parsed into
 * its SID/username parts — see app/api/src/lib/fslogixProfileName.ts's
 * header comment for why BOTH orders are tried rather than one assumed:
 * this estate's own diagnostic capture and its operations runbook disagree
 * on which segment comes first, and neither is confirmed against the live
 * Intune FSLogix configuration profile. 'unrecognized' means neither end
 * segment parsed as a SID — the row is still shown (folderName is always
 * present), just without a derived sid/userPrincipalName.
 */
export type ProfileNameParseQuality = 'sid_username' | 'username_sid' | 'unrecognized';

/** Orphan-detection verdict for one profile — see app/api/src/services/fslogixProfilesService.ts#matchOrphans. 'unknown' covers "this row's name didn't parse", "orphan detection couldn't run at all this call", AND "the membership snapshot itself was truncated and this row didn't match anything in the partial data we did get" (see ProfilesListResponse.orphanDetection for the page-level reason, and orphanEvidence for the row-level one) — orphanEvidence always states the specific reason for this row. */
export type ProfileOrphanStatus = 'orphan' | 'not-orphan' | 'unknown';

/**
 * AM-13 peer review fix (item 4): whether a profile's identity comes from a
 * genuine share-root DIRECTORY (the normal, expected shape) or a loose VHD
 * FILE sitting directly at the share root with no wrapping folder
 * (the FSLogix operations runbook §3's documented fallback
 * shape). This matters because a root-file profile's `folderName` is
 * DERIVED from its own filename (see
 * app/api/src/services/fslogixProfilesService.ts#deriveLooseFileContainerName)
 * and can COLLIDE with a genuine directory of the same derived name — reset/
 * restore/delete only ever address a profile by folderName, so a caller
 * MUST know which kind a row is before treating that name as an
 * unambiguous target. See ProfileVhd.kind's own doc comment for how the API
 * enforces this at mutation time.
 */
export type ProfileContainerKind = 'directory' | 'root-file';

/** One active FSLogix profile VHD(X) on the profile storage account (GET /api/v1/profiles). */
export interface ProfileVhd {
  /** Stable per-row id: `${folderName}::${fileName}` — safe as a React key. The API's reset endpoint addresses a profile by folderName alone (see ProfileResetRequest's doc comment for why) — EXCEPT when kind is 'root-file', where the server refuses reset/restore/delete outright (see fslogixProfilesService.ts's RootFileMutationUnsupportedError) because a derived folderName is not a safe mutation target (peer review item 4: it can collide with a genuine directory of the same name). */
  id: string;
  /** The directory FSLogix created directly under the share root — this is this app's stable identity for "a profile," since a folder maps 1:1 to a user's profile container regardless of which VHD file(s) live inside it. When kind is 'root-file', this is DERIVED from the loose file's own name, not read from an actual directory — see ProfileContainerKind's doc comment. */
  folderName: string;
  /** The active VHD(X) file's name within folderName. */
  fileName: string;
  /** See ProfileContainerKind — 'root-file' rows cannot be reset/restored/deleted (the UI disables those actions and explains why). */
  kind: ProfileContainerKind;
  sid: string | undefined;
  userPrincipalName: string | undefined;
  nameParseQuality: ProfileNameParseQuality;
  sizeBytes: number;
  sizeGb: number;
  /** ISO timestamp of the file's last write (SMB last-write time); undefined when the FileREST listing returned no timestamps — the UI renders "Unknown", never a fabricated epoch. */
  lastModified: string | undefined;
  /** True when sizeGb exceeds the configured FSLOGIX_OVERSIZED_GB threshold (see ProfilesListResponse.oversizedThresholdGb). */
  oversized: boolean;
  orphanStatus: ProfileOrphanStatus;
  /** Human-readable basis for orphanStatus — always populated, including for 'unknown' (states WHY it's unknown, e.g. "Graph permission not granted" or "folder name did not parse"), never a bare enum value with no explanation. */
  orphanEvidence: string;
  /** True when at least one open SMB handle was observed on this file via FileREST List Handles at listing time — a snapshot, not a live guarantee (a session could open/close a handle moments later). */
  locked: boolean;
  /** Best-effort holder identity (a handle's clientName, falling back to clientIp) when locked is true and at least one handle exposed an identifiable client. Undefined when locked is false, or when locked is true but no handle exposed one. */
  lockedBy: string | undefined;
  /**
   * AM-51 — count of active (non-retired) VHD(X) files in this row's own
   * folder, INCLUDING this row itself (so a folder with exactly one active
   * file reports 1, not 0). Always 1 for a `kind: 'root-file'` row (a loose
   * file has no wrapping folder to share with siblings). Derived from the
   * same snapshot every other field on this row comes from — no extra ARM/
   * FileREST call.
   *
   * Motivating incident (2026-08-22): a missing FSLogix VolumeType setting
   * forked `Profile_dsmith.vhd` alongside `Profile_dsmith.VHDX` in the same
   * folder — FSLogix's own behavior when it can't tell which container to
   * mount is undefined/unpredictable, and Reset already refuses outright
   * for this shape (see fslogixProfilesService.ts's resetProfile ->
   * ProfileAmbiguousError). This field lets the UI surface the condition
   * proactively instead of an operator only discovering it via a failed
   * Reset attempt.
   */
  activeSiblingCount: number;
  /** True when activeSiblingCount > 1 — this folder holds more than one active VHD(X) container. See the Profiles page's "Duplicate container" badge and POST /v1/profiles/{profileFolderName}/duplicates/resolve (the guided retire/delete flow) for how this is surfaced and resolved. Advisory only — the resolve endpoint re-verifies the live folder state at mutation time rather than trusting this listing-time flag (see resolveDuplicateContainer's own doc comment). */
  duplicateContainer: boolean;
}

/** A retired (reset-by-rename) FSLogix profile VHD(X) — shown in a separate list from active profiles (GET /api/v1/profiles). */
export interface RetiredProfileVhd {
  id: string;
  folderName: string;
  /** See ProfileVhd.kind's doc comment — 'root-file' retired rows cannot be restored or deleted through this app either. */
  kind: ProfileContainerKind;
  sid: string | undefined;
  userPrincipalName: string | undefined;
  nameParseQuality: ProfileNameParseQuality;
  /** The file's current name, e.g. "Profile_jdoe.vhdx.retired-20260816-140233". */
  retiredFileName: string;
  /** The name a restore would rename it back to, e.g. "Profile_jdoe.vhdx". */
  originalFileName: string;
  sizeBytes: number;
  sizeGb: number;
  lastModified: string | undefined;
  /** Best-effort ISO timestamp parsed from the retired-<suffix> marker — undefined when the suffix doesn't match a recognized shape (see app/api/src/lib/fslogixProfileName.ts#parseRetiredFileName); the row is still shown regardless. */
  retiredAt: string | undefined;
}

/**
 * Whether GET /api/v1/profiles could cross-check each profile against the
 * AVD users group (Microsoft Graph GroupMember.Read.All, application
 * permission — same "cannot be granted from Bicep" posture as
 * services/governance/conditionalAccessBreakGlass.ts's Policy.Read.All
 * check; see docs/app-registration.md). FOUR distinct states (peer review
 * item 1 added 'unavailable'; a pre-existing bug let any non-403 Graph
 * error — a 500, a timeout, a mistyped AVD_USERS_GROUP_ID producing a
 * Graph 404 — escape uncaught and 502 the WHOLE Profiles page, bypassing
 * every other degradation this endpoint was built to have):
 *   - not-configured: AVD_USERS_GROUP_ID app setting is unset.
 *   - graph-permission-not-granted: the setting IS set, but the managed
 *     identity doesn't yet hold the Graph app role — a 403 from Graph.
 *   - unavailable: Graph was called but failed for some OTHER reason (a
 *     transient 5xx/timeout, or — peer review item 1's specific example —
 *     a mistyped group id producing a 404). Distinct from
 *     graph-permission-not-granted because the remediation is different
 *     (retry / fix the group id, not run an Entra grant).
 *   - not-evaluated: peer review item 11 — this call never got far enough
 *     to even ATTEMPT the Graph check, because the FileREST listing itself
 *     failed first (see ProfilesListResponse.fileRest). Distinct from
 *     not-configured, which would incorrectly claim "no group id is set"
 *     even when one is.
 */
export type ProfileOrphanDetectionState =
  | { status: 'available' }
  | { status: 'not-configured' }
  | { status: 'graph-permission-not-granted'; grantInstructions: readonly string[] }
  | { status: 'unavailable'; reason: string }
  | { status: 'not-evaluated' };

/**
 * AM-13 peer review item 17: GET /api/v1/profiles never returns the raw
 * FileREST SDK error text in `fileRest.reason` (that could leak internal
 * detail — resource paths, service error messages — to every viewer+
 * caller); the server logs the raw message itself (context.error) and the
 * wire response gets only this coarse classification. 'forbidden' (a 403)
 * usually means the Storage File Data Privileged Contributor role
 * assignment hasn't propagated yet or is missing; 'network' usually means
 * the private-endpoint path is unreachable (VNet integration, DNS, NSG);
 * 'other' covers everything else (a transient fault, a malformed response,
 * etc.).
 */
export type FileRestUnavailableReason = 'network' | 'forbidden' | 'other';

/** Response for GET /api/v1/profiles. */
export interface ProfilesListResponse {
  storageAccountName: string;
  shareName: string;
  /** The FSLOGIX_OVERSIZED_GB app setting value (default 5) used to compute every row's `oversized` flag. */
  oversizedThresholdGb: number;
  generatedAt: string;
  /**
   * 'unavailable' means the OAuth FileREST listing call itself failed
   * (private-endpoint reachability, a transient Azure Files fault, an RBAC
   * grant not yet propagated, etc.) — `profiles`/`retired` are then both
   * `[]` and `fallbackShareUsage` (the same management-plane
   * provisioned-vs-used snapshot GET /v1/cost/fslogix-usage already
   * returns) is populated instead, so the page degrades to a share-level
   * capacity view rather than going blank.
   */
  fileRest: { status: 'available' } | { status: 'unavailable'; reason: FileRestUnavailableReason };
  /**
   * AM-13 peer review item 10: true when at least one profile DIRECTORY
   * failed to list (a per-directory FileREST error this app recovered
   * from, rather than letting one bad directory blank the entire page) —
   * `profiles`/`retired` still reflect every directory that DID list
   * successfully, but the response is a PARTIAL inventory, not a complete
   * one, when this is true.
   */
  partial: boolean;
  profiles: ProfileVhd[];
  retired: RetiredProfileVhd[];
  orphanDetection: ProfileOrphanDetectionState;
  fallbackShareUsage: FslogixShareUsage | undefined;
}

/**
 * POST /api/v1/profiles/{profileFolderName}/reset body. `reason` is
 * MANDATORY (validateMandatoryReason, same as ForceLogoffSessionRequest) —
 * resetting a user's profile is disruptive (their next sign-in starts from
 * a blank container) and must always be justified, admin-only, and
 * audited. The route addresses the profile by its FOLDER name, not a VHD
 * filename — see ProfileVhd.folderName's doc comment for why the folder is
 * this app's stable profile identity; the server resolves the single
 * active (non-retired) VHD file within that folder itself, returning 404
 * if none exists or 409 if more than one does (an unsupported multi-VHD
 * folder shape this app declines to guess at).
 */
export interface ProfileResetRequest {
  reason: string;
}

export interface ProfileResetResponse {
  status: 'retired';
  folderName: string;
  originalFileName: string;
  retiredFileName: string;
  correlationId: string;
}

/**
 * POST /api/v1/profiles/{profileFolderName}/restore body. `retiredFileName`
 * is required (not inferred) because a folder can carry more than one
 * `.retired-*` file if reset was run more than once without an intervening
 * restore — the caller must say exactly which one. `reason` is optional
 * (restoring is corrective, not independently disruptive the way a reset
 * is) but still admin-only and audited.
 */
export interface ProfileRestoreRequest {
  retiredFileName: string;
  reason?: string;
}

export interface ProfileRestoreResponse {
  status: 'restored';
  folderName: string;
  retiredFileName: string;
  restoredFileName: string;
  correlationId: string;
}

/**
 * DELETE /api/v1/profiles/{profileFolderName}/retired/{retiredFileName}
 * body — AM-13 peer review item 7.
 *
 * ⚠ IRREVERSIBLE: this PERMANENTLY deletes a retired profile VHD(X) — there
 * is no further "un-delete" the way restore undoes a reset. Admin-only,
 * mandatory reason, audited BEFORE the mutation is attempted (not just
 * after — see app/api/src/functions/profileDeleteRetired.ts's doc comment)
 * so a destructive action always leaves a trail even if the process fails
 * immediately after the delete completes. Refuses (409) if the retired
 * file has any open handle. FLAGGED FOR PRODUCT SIGN-OFF: this endpoint is
 * implemented per the peer review's explicit request ("build it, he gates
 * it") but has NOT been exercised against the live estate — see this
 * story's final report for the explicit call-out.
 */
export interface DeleteRetiredProfileRequest {
  reason: string;
}

export interface DeleteRetiredProfileResponse {
  status: 'deleted';
  folderName: string;
  retiredFileName: string;
  correlationId: string;
}

/** Which of a duplicate-container folder's active files the operator picked, and whether to retire (rename — reversible via the existing Restore flow) or permanently delete it. See DuplicateContainerResolveRequest. */
export type DuplicateContainerResolveMode = 'retire' | 'delete';

/**
 * POST /api/v1/profiles/{profileFolderName}/duplicates/resolve body —
 * AM-51's guided fix for the duplicate-container incident class (see
 * ProfileVhd.duplicateContainer's doc comment). `fileName` names exactly ONE
 * of the folder's currently active VHD(X) files (an operator-visible choice
 * — the dialog lists every sibling); the server re-verifies at mutation time
 * that the folder still has more than one active file AND that `fileName` is
 * one of them, refusing (409 profile_not_duplicate) otherwise — resolving
 * the LAST/ONLY active file in a folder is Reset's job, never this flow's.
 * `reason` is MANDATORY regardless of mode (same posture as
 * ProfileResetRequest/DeleteRetiredProfileRequest) — both retiring and
 * deleting one of two containers is a consequential, hard-to-fully-undo-if-
 * wrong operator judgment call.
 */
export interface DuplicateContainerResolveRequest {
  fileName: string;
  mode: DuplicateContainerResolveMode;
  reason: string;
}

export interface DuplicateContainerResolveResponse {
  status: 'retired' | 'deleted';
  folderName: string;
  fileName: string;
  /** Present only when status is 'retired' — the name the file was renamed to (appears in the Retired profiles table, restorable via the existing restore flow). */
  retiredFileName: string | undefined;
  correlationId: string;
}

/** Summary of an active alert/monitoring signal. */
export interface AlertSummary {
  id: string;
  name: string;
  severity: 'Sev0' | 'Sev1' | 'Sev2' | 'Sev3' | 'Sev4';
  status: 'New' | 'Acknowledged' | 'Closed';
  firedAt: string;
  description?: string;
  /**
   * The AVD resource (host pool, session host, workspace, etc.) the alert
   * fired against, if the underlying Azure Monitor alert has a resolvable
   * target — e.g. essentials.targetResource from the Alerts Management API.
   */
  targetResource?: string;
  /**
   * App-level acknowledgement/snooze state (AM-24), merged in at read time
   * from the AlertState Azure Table — see app/api/src/lib/alertState.ts.
   * Distinct from `status` (the alert's own Azure Monitor state): an alert
   * can be `status: 'New'` in Azure Monitor while this app's operators have
   * separately acked or snoozed it here.
   */
  ackedBy?: string;
  ackedAt?: string;
  /** Operator-supplied justification for the ack, if one was given (see AckAlertRequest.reason). Persisted and surfaced (not dropped) — shown in the Monitoring page's ack tooltip alongside ackedBy/ackedAt. */
  ackedReason?: string;
  /** Set only while an active (not yet expired) snooze applies — see app/api/src/lib/alertState.ts#isSnoozeActive. Expiry is evaluated at read time; a past snoozedUntil is treated as "not snoozed" and this field is omitted. */
  snoozedUntil?: string;
  snoozedBy?: string;
  snoozeReason?: string;
}

/**
 * Response shape for GET /v1/alerts (the alert feed). Wrapped (not a bare
 * array) so the API can signal `degraded: true` when the AlertState Table
 * lookup failed and the returned alerts therefore carry NO ack/snooze
 * overlay — the UI shows a subtle "state unavailable" notice instead of
 * silently rendering alerts that only LOOK unacked/unsnoozed.
 */
export interface AlertsFeedResponse {
  alerts: AlertSummary[];
  degraded: boolean;
}

/** Body for POST /v1/alerts/{alertGuid}/ack. */
export interface AckAlertRequest {
  reason?: string;
}

/** Body for POST /v1/alerts/{alertGuid}/snooze. Exactly one of untilIso/hours must be supplied by the caller (validated server-side — see app/api/src/lib/alertState.ts). */
export interface SnoozeAlertRequest {
  /** Absolute ISO-8601 timestamp to snooze until. */
  untilIso?: string;
  /** Relative snooze duration in whole hours from now (1..168). Ignored if untilIso is also supplied. */
  hours?: number;
  reason?: string;
}

/** One of the curated Log Analytics views surfaced on GET /v1/logs/views. */
export interface LogsViewSummary {
  id: string;
  name: string;
  description: string;
}

/** A single Kusto-typed column in a LogsTableResult. */
export interface LogsColumn {
  name: string;
  /** Kusto column type as reported by the query engine, e.g. "string", "datetime", "long", "bool", "dynamic". */
  type: string;
}

/** One result table from a Log Analytics query, in wire-friendly (columns + row arrays) form rather than the SDK's richer row objects. */
export interface LogsTableResult {
  name?: string;
  columns: LogsColumn[];
  rows: unknown[][];
  /** True when the server-side row cap (see app/api/src/lib/logsGuard.ts) truncated the result. */
  truncated: boolean;
}

/** Response shape for both POST /v1/logs/views/{viewId}/run and POST /v1/logs/query. */
export interface LogsQueryResponse {
  tables: LogsTableResult[];
}

/** Body for POST /v1/logs/query (the raw KQL escape hatch — operator+ only, see app/api/src/functions/logs.ts). */
export interface RawKqlRequest {
  kql: string;
  /** 1..168 (see app/api/src/lib/logsGuard.ts MAX_TIMESPAN_HOURS). */
  timespanHours: number;
}

/**
 * One row of the general "what happened recently" audit feed — AM-32
 * (M8-W3), GET /v1/audit/recent (app/api/src/functions/auditRecent.ts).
 * Unlike ScalingHistoryEntry below (one action family, viewer+), this
 * endpoint is operator+ ONLY (see that handler's doc comment) because it can
 * return rows for ANY action across the whole app, including actor
 * identities a viewer has no operational need to see.
 *
 * Deliberately omits AuditEntity's `parametersJson` (app/api/src/lib/
 * auditLog.ts) — a mutation's parameters can carry payload detail (e.g. a
 * message body preview, GB thresholds) that isn't this feed's business to
 * expose wholesale to every operator+ user regardless of which page/action
 * it came from; `hasParameters` says whether there WAS a parameters payload,
 * without shipping its contents. Also omits `detail` (raw ARM/internal error
 * text) — same operator-only-if-you-drill-in rationale ScalingHistoryEntry's
 * doc comment gives, even though this endpoint's floor is already
 * operator+; the detail text can still be more than an audit READ surface
 * ought to hand back by default.
 */
export interface AuditEntryDto {
  /**
   * Opaque row identity — `{partitionKey}/{rowKey}` of the underlying
   * AuditEntity (app/api/src/lib/auditLog.ts), NOT `correlationId`. AM-32
   * peer review MAJOR 1: `correlationId` is only unique per REQUEST, not
   * per audit ROW — a timer-driven mutation that writes several audit rows
   * from a single invocation (e.g. rolloutPlanTimer.ts generating one
   * correlationId per tick, then one audit row per plan it advances that
   * tick) reuses the SAME correlationId across multiple distinct rows, so
   * keying a React list on it collides. `partitionKey/rowKey` is the
   * Table's own composite primary key — guaranteed unique by construction.
   */
  id: string;
  occurredAt: string;
  /** UPN (or 'unknown'/'system:...') of the actor — see AuditEvent.actor's doc comment in auditLog.ts. */
  actor: string;
  action: string;
  target: string;
  reason?: string;
  outcome: 'success' | 'failure' | 'accepted';
  correlationId: string;
  /** True when the underlying AuditEntity had a parametersJson payload — see this interface's own doc comment for why the payload itself isn't included. */
  hasParameters: boolean;
}

/** Response for GET /v1/audit/recent. */
export interface AuditRecentResponse {
  entries: AuditEntryDto[];
  /**
   * True when `entries` was cut off at the request's `top` cap before the
   * full `sinceHours` window was covered — i.e. there may be additional
   * matching rows within the window that aren't included here. AM-32 peer
   * review MINOR 20: the server actually fetches one row beyond `top`
   * (queryAuditEntries's `walkTarget`, app/api/src/lib/auditLog.ts) to make
   * this an EXACT signal rather than the "happened to end exactly at `top`"
   * heuristic RolloutPlanListResponse / LogsTableResult's own `truncated`
   * fields accept — so `truncated` here specifically means "there IS at
   * least one more matching row in the window", not "maybe".
   *
   * Also true, unconditionally, whenever `partial` is true (see below) — a
   * read that didn't finish can never positively confirm completeness.
   */
  truncated: boolean;
  /**
   * True when the underlying query FAILED partway through its day-by-day
   * walk (AM-32 peer review MAJOR 3) — distinct from `truncated` alone,
   * which can be true on a fully successful read simply because there was
   * more data than `top` allows. `entries` still holds whatever was
   * collected before the failure; both UI surfaces
   * (RecentActionsDrawer.tsx, Audit.tsx) render an explicit "results may be
   * incomplete" caveat when this is set, distinct from the plain
   * truncated-by-`top` caveat.
   */
  partial: boolean;
  /** Echoes the effective sinceHours window this response was computed over (the request's own value, or the endpoint's default when omitted) — lets the UI caption "showing last Nh" without duplicating the default value. */
  sinceHours: number;
}

/**
 * One row of scaling-plan change history, as surfaced by
 * GET /v1/scalingplans/current/history (AM-23/M3-S1) — a thin projection of
 * the AuditLog table's AuditEntity (app/api/src/lib/auditLog.ts) filtered to
 * `action` values with the "scalingplan." prefix. Distinct from
 * AuditEntryDto above (the general Audit page's shape, AM-32) so this
 * endpoint's response isn't coupled to that page's own field choices.
 *
 * Deliberately omits AuditEntity's `detail` (raw ARM/internal error text) —
 * viewer+ is this endpoint's floor, and a raw error string can leak
 * implementation detail an operator-only surface would be the right place
 * for, not a change-history feed every signed-in role can read. `reason`
 * (the operator's own justification) is kept.
 */
export interface ScalingHistoryEntry {
  /** The audit row's correlationId — doubles as a stable per-row id since AuditEntity has no separate id field. */
  id: string;
  occurredAt: string;
  /** UPN of the actor, or 'system:auto-reenable' for the timer-triggered emergency-override expiry (see the timer function's doc comment). */
  actor: string;
  action: string;
  target: string;
  outcome: 'success' | 'failure' | 'accepted';
  reason?: string;
  /** Parsed parametersJson (before/after values, minutes, etc.) — undefined if the row had none or it failed to parse. */
  parameters?: Record<string, unknown>;
}

export interface ScalingHistoryResponse {
  entries: ScalingHistoryEntry[];
}

/** Standard error shape returned by the API on non-2xx responses. */
export interface ApiError {
  status: number;
  code: string;
  message: string;
  details?: unknown;
}

// ---------------------------------------------------------------------------
// AM-28 (M4-S3): staged image-version rollout + rollback.
//
// A RolloutPlan drives a STAGED, OPERATOR-GATED replacement of the session
// hosts running an old gallery image version with hosts on a new
// (`targetImageVersion`) one — automating the manual procedure documented in
// The image-update runbook §3 ("Staged rollout to
// HP-CONTOSO-PROD") and the session-host lifecycle runbook §5
// ("Remove a host"). See app/api/src/services/rolloutPlanService.ts for the
// durable Table-backed state machine this DTO set mirrors, and
// app/api/src/functions/rolloutPlans.ts for the HTTP surface.
// ---------------------------------------------------------------------------

/**
 * The plan's lifecycle state. Legal transitions (enforced server-side by
 * rolloutPlanService.ts#canTransition — this type only lists the possible
 * values, not which moves between them are legal):
 *
 *   planned -> draining_old -> awaiting_new_hosts -> validating_new -> cutover -> removing_old -> done
 *   planned -> cancelled
 *   {draining_old, awaiting_new_hosts, validating_new, cutover, removing_old} -> rolled_back
 *
 * Rollback is available from every state up to and including removing_old
 * (see rolloutPlanService.ts's rollback doc comment for the pre- vs.
 * post-removal distinction — same endpoint, different per-host effect).
 * `done`, `rolled_back`, and `cancelled` are terminal — no further
 * transitions are legal once a plan reaches one of them.
 */
export type RolloutState = 'planned' | 'draining_old' | 'awaiting_new_hosts' | 'validating_new' | 'cutover' | 'removing_old' | 'done' | 'rolled_back' | 'cancelled';

/**
 * `done`/`rolled_back`/`cancelled` — no further transitions are legal from
 * any of these (see rolloutPlanService.ts#isTerminalState, the API-side
 * consumer of this same array — single source of truth so the frontend's
 * "is this plan still active" check can never drift from the server's).
 */
export const ROLLOUT_TERMINAL_STATES: readonly RolloutState[] = ['done', 'rolled_back', 'cancelled'];

/**
 * Status of one OLD (being-retired) session host within the plan.
 * 'pending' -> 'draining' -> 'drained' -> 'removed' is the happy path;
 * 'undrained_rollback' is set instead of progressing further when a
 * pre-removal rollback re-enables allowNewSession on this host.
 *
 * 'drained' is set by the timer (rolloutPlanTimer.ts#refreshOldHosts) only
 * once BOTH the host's server-observed session count is 0 AND its
 * allowNewSession flag is false — a host an operator re-enabled via the
 * HostPool page's drain toggle (allowNewSession: true) must never read as
 * "drained" even at zero sessions, since it would immediately start
 * accepting new ones again.
 */
export type RolloutOldHostStatus = 'pending' | 'draining' | 'drained' | 'removed' | 'undrained_rollback';

/** Status of one NEW (vNext) session host the plan is waiting on, per the guided AM-22 token/vmTemplate + manual-provisioning flow (see the session-host runbook). */
export type RolloutNewHostStatus = 'awaiting_registration' | 'registered' | 'available' | 'validated';

/**
 * One old host being retired by the plan. `resourceGroup`/`vmName` (the
 * host's underlying VM, resolved via avdService.ts#resolveSessionHostVm)
 * and `deregisteredAt` are RESUMABLE-REMOVAL checkpoints, persisted BEFORE
 * the corresponding ARM mutation runs — see
 * app/api/src/functions/rolloutPlans.ts's handleRemoveHosts doc comment. A
 * retry that finds `deregisteredAt` already set skips straight to VM
 * deletion using the recorded `resourceGroup`/`vmName`, rather than calling
 * resolveSessionHostVm again (which would 404 once the AVD registration is
 * already gone).
 */
export interface RolloutOldHost {
  sessionHostName: string;
  status: RolloutOldHostStatus;
  /** ARM-reported session count as of the last timer tick or hard-gate check — display only, never itself the authority a mutation trusts (see RemoveRolloutHostsResult). */
  lastObservedSessions?: number;
  drainedAt?: string;
  /** The underlying VM's resource group, cached once resolved — see this interface's doc comment. */
  resourceGroup?: string;
  /** The underlying VM's name, cached once resolved — see this interface's doc comment. */
  vmName?: string;
  /** Set once the AVD session-host REGISTRATION has been deregistered (sessionHosts.delete succeeded), before the underlying VM is deleted — the resumable-removal checkpoint. */
  deregisteredAt?: string;
  removedAt?: string;
}

/**
 * AM-47 — status of one new host's FSLogix config-convergence check
 * (RolloutNewHost.configCheck). Tri-state at the host level (undefined
 * `configCheck` means "never run"), same convention as `imageVerified`
 * above; ONCE run, its own `status` further distinguishes "still running"
 * from the three possible outcomes:
 *   - 'in_progress': the Run Command v2 child resource
 *     (`avdmgr-fslogix-check` — see fslogixConfigCheck.ts) has been
 *     submitted and the timer is waiting on its instanceView.
 *   - 'passed': the script ran, its output parsed, and every baseline key
 *     matched the delivered registry value.
 *   - 'failed': the script ran and parsed, but at least one key diverged —
 *     see `diffs`.
 *   - 'error': the script could not be run/read/parsed at all (bad output,
 *     nonzero exit code, ARM failure, or a submit/poll timeout) — see
 *     `error` for a short, sanitized classification (never raw ARM text —
 *     same CWE-532 posture as RemoveRolloutHostFailure.message).
 */
export type RolloutConfigCheckStatus = 'in_progress' | 'passed' | 'failed' | 'error';

/**
 * AM-47 — one baseline-vs-delivered mismatch for a single FSLogix registry
 * value (see fslogixConfigCheck.ts#computeConfigDiffs). `actual: null`
 * means the key was entirely ABSENT from the host's
 * `HKLM\SOFTWARE\FSLogix\Profiles` (e.g. the Settings Catalog profile never
 * delivered it, or Intune's ADMX ingestion failed — see
 * The FSLogix storage runbook §5.1's ADMX 0x86000009 gotcha) —
 * distinct from a genuine (but wrong) delivered value, which the UI should
 * render differently ("missing" vs. an actual mismatched string).
 */
export interface RolloutConfigDiff {
  key: string;
  expected: string;
  actual: string | null;
}

/** One new (vNext) host the plan expects to be provisioned and registered, by name, before it declares. Provisioning itself happens OUTSIDE this app (see AddSessionHostPanel/AM-22) — the plan only tracks what it observes in AVD for these names. */
export interface RolloutNewHost {
  sessionHostName: string;
  status: RolloutNewHostStatus;
  /** Raw AVD status (see SessionHostStatus) as of the last timer tick, once registered — undefined until the host first appears in sessionHosts.list. */
  lastObservedStatus?: SessionHostStatus;
  /**
   * AM-49 — this host's underlying VM power state, refreshed by
   * rolloutPlanTimer.ts's refreshNewHosts on EVERY tick while the plan is in
   * `awaiting_new_hosts` or `validating_new` (the two states the keep-alive
   * pass below applies to) — undefined until the host has been observed at
   * least once. 'unknown' means the timer could not resolve a power state
   * this tick (e.g. a transient ARM error, or the host's resourceId didn't
   * resolve to a VM) — it must never be treated as either "running" or
   * "deallocated/stopped" by keep-alive logic or by the UI.
   */
  powerState?: PowerState;
  /**
   * AM-49 — motivating incident: autoscale (SCALE-CONTOSO-PROD, 0% minimum host
   * count at every phase) deallocated brand-new rollout hosts minutes after
   * provisioning, before Intune policy convergence, because nobody has
   * connected to a not-yet-cut-over host yet for `startVMOnConnect` to ever
   * fire. Rather than mutate the shared scaling plan's exclusionTag (a
   * bigger blast radius, a new VM-tag-write RBAC grant, and terminal-state
   * reconciliation this story deliberately avoids — see
   * rolloutPlanTimer.ts's header comment), the timer itself restarts a
   * declared new host whenever it observes `powerState` 'deallocated' or
   * 'stopped' while the plan is in `awaiting_new_hosts`/`validating_new`.
   * This field counts how many such restarts have been submitted for this
   * host across the plan's lifetime — capped at KEEP_ALIVE_MAX_RESTARTS
   * (20), after which `keepAliveError` explains why the timer stopped
   * trying rather than restarting forever against a misconfigured scaling
   * plan.
   */
  keepAliveRestartCount?: number;
  /** AM-49 — ISO timestamp of the last keep-alive `start` this timer submitted for this host. Undefined if none has ever been needed. */
  lastKeepAliveAt?: string;
  /**
   * AM-49 — set once the keep-alive restart limit is reached (see
   * keepAliveRestartCount), or after a submit/resolve failure (a short,
   * sanitized classification — never raw ARM text, same CWE-532 posture as
   * RolloutConfigCheckStatus's `error`). Cleared on the next SUCCESSFUL
   * keep-alive start for this host.
   */
  keepAliveError?: string;
  /** True once every health check on this host reported HealthCheckSucceeded, as of the last timer tick. */
  healthy?: boolean;
  /**
   * True once the timer has confirmed this host's underlying VM
   * (storageProfile.imageReference, read via
   * computeService.ts#getVmImageReference) matches the plan's
   * `targetImageVersion` — the confirm-cutover gate requires this (or an
   * explicit operator override — see RolloutActionRequest.force) on every
   * new host, not just Available+healthy, so an operator can't accidentally
   * cut over to hosts that silently didn't get built from the intended
   * image version. Undefined until the VM has been read at least once;
   * false if read but the version did not match.
   */
  imageVerified?: boolean;
  /**
   * AM-47 — this host's FSLogix config-convergence check, THE THIRD
   * confirm-cutover gate (alongside availability/health and
   * imageVerified). Undefined = never run (the operator has not yet
   * triggered the `verify-config` action for this host, or this plan
   * predates AM-47). Populated by rolloutPlans.ts's verify-config action
   * (submit -> 'in_progress') and rolloutPlanTimer.ts's validating_new poll
   * (Run Command v2 GET -> 'passed'/'failed'/'error' — see
   * app/api/src/lib/fslogixConfigCheck.ts and rolloutPlanTimer.ts's header
   * comment for why this poll is still read-only ARM despite the mutating
   * submit living in rolloutPlans.ts).
   */
  configCheck?: {
    status: RolloutConfigCheckStatus;
    /** Set when the verify-config action submitted the Run Command v2 child resource for this host. */
    submittedAt?: string;
    /** Set once the timer observes a terminal executionState (Succeeded/Failed) for this host's run command. */
    completedAt?: string;
    /** Present only when status is 'passed' (empty array) or 'failed' (one entry per diverged key) — absent for 'in_progress'/'error'. */
    diffs?: RolloutConfigDiff[];
    /** Present only when status is 'error' — a short, sanitized classification (see RolloutConfigCheckStatus's doc comment). */
    error?: string;
  };
  registeredAt?: string;
}

/**
 * Full detail for one rollout plan, as surfaced by
 * GET /v1/hostpools/{hostPoolName}/rollout-plans and .../{planId}. Does NOT
 * carry the Table row's ETag (an API-internal concurrency concern — see
 * rolloutPlanService.ts's RolloutPlanRecord).
 */
export interface RolloutPlanDetail {
  id: string;
  hostPoolName: string;
  targetImageVersion: string;
  state: RolloutState;
  oldHosts: RolloutOldHost[];
  newHosts: RolloutNewHost[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  /** Mandatory operator justification supplied at creation — a staged rollout is a big-blast-radius action, same "always justified" posture as EmergencyOverrideRequest.reason. */
  reason: string;
  forcedProceedAt?: string;
  forcedProceedBy?: string;
  forcedProceedReason?: string;
  cutoverAt?: string;
  cutoverBy?: string;
  rollbackAt?: string;
  rollbackBy?: string;
  rollbackReason?: string;
  /**
   * Old host names that were ALREADY removed (VM deleted + deregistered)
   * before a rollback was requested — surfaced distinctly from hosts that
   * were simply un-drained, so the UI can render the "these need a guided
   * re-add on the prior version, not an un-drain" post-removal-rollback
   * guidance for exactly this subset (see rolloutPlanService.ts's rollback
   * doc comment).
   */
  rollbackNeedsReadd?: string[];
  /**
   * New (vNext) host names rollback ALSO drained (allowNewSession: false)
   * — using the same existing drain primitive as the old-host toggle, no
   * new RBAC — so a rolled-back rollout doesn't leave freshly-added
   * vNext hosts silently still accepting sessions. Un-draining them again
   * (if desired) is a manual step via the HostPool page — see
   * rolloutPlans.ts's handleRollback doc comment and this action's
   * response-level remaining-manual-steps guidance.
   */
  rollbackDrainedNewHosts?: string[];
  /** Old host names whose automatic un-drain (allowNewSession: true) FAILED during rollback — surfaced so the operator sees exactly which hosts still need a manual drain-toggle fix via the HostPool page, rather than assuming rollback fully succeeded. */
  rollbackUndrainFailures?: string[];
  /** New host names whose automatic drain FAILED during rollback — same rationale as rollbackUndrainFailures, for the new-host side. */
  rollbackNewHostDrainFailures?: string[];
  cancelledAt?: string;
  cancelledBy?: string;
  completedAt?: string;
  /** Set by the timer function if its last tick hit an error polling ARM for this plan — surfaced so the UI can show "last automatic check failed" rather than silently going stale. Cleared on the next successful tick. */
  lastTimerError?: string;
  /**
   * AM-47 — the expected FSLogix registry values (see
   * app/api/src/lib/config.ts's `fslogixBaseline`) EVERY new host's
   * `verify-config` check is diffed against, FROZEN at plan creation time
   * (rolloutPlans.ts's create handler) — same "immutable once the plan
   * exists" rationale as `targetImageVersion` above, so a later change to
   * this environment's configured baseline can never retroactively change
   * what an in-flight plan is validated against. Undefined only for a
   * pre-AM-47 plan row that predates this field — the verify-config action
   * lazily backfills it from the CURRENT config the first time it's
   * invoked on such a row (see rolloutPlans.ts's handleVerifyConfig doc
   * comment).
   */
  configBaseline?: Record<string, string>;
}

/** Request body for POST /v1/hostpools/{hostPoolName}/rollout-plans — creates a new plan in state 'planned'. Rejected (409) if a non-terminal plan already exists for this host pool (see rolloutPlanService.ts — only one rollout may be in flight at a time). */
export interface CreateRolloutPlanRequest {
  targetImageVersion: string;
  /** Session host names (short form) to retire — 1-50 (see ROLLOUT_MAX_HOSTS in rolloutPlanService.ts). */
  oldHostNames: string[];
  /** Expected session host names of the vNext hosts the operator plans to provision — 1-50. These do not need to exist yet; the timer watches for their registration (see RolloutNewHost). */
  newHostNames: string[];
  reason: string;
}

export interface RolloutPlanResponse {
  plan: RolloutPlanDetail;
}

export interface RolloutPlanListResponse {
  plans: RolloutPlanDetail[];
  /** AM-15 (M7) sweep: true when the server's own ROLLOUT_LIST_LIMIT (25 most-recent plans, see rolloutPlanService.ts#listRolloutPlanEntitiesWithTruncation) cut off older plan history — `plans` is then not the complete history for this host pool. */
  truncated: boolean;
}

/**
 * Body shared by the simple state-transition actions (start, force-proceed,
 * confirm-cutover, start-removal, cancel, rollback) — see rolloutPlans.ts
 * for which require `reason`/support `force`. Also the body shape for
 * `verify-config` (AM-47 — no state transition; see rolloutPlans.ts's
 * handleVerifyConfig), which takes no fields of its own but reuses this
 * type for consistency with every other action route.
 */
export interface RolloutActionRequest {
  reason?: string;
  /**
   * Bypasses a SOFT gate — never the HARD zero-sessions gate on host
   * removal, which ignores this flag entirely (see
   * rolloutPlanService.ts#canRemoveHost). Currently meaningful on
   * confirm-cutover, where it bypasses ALL THREE readiness checks together:
   * every new host being Available+healthy, every new host's VM image
   * verified against targetImageVersion (see RolloutNewHost.imageVerified),
   * AND every new host's FSLogix config-convergence check having passed
   * (AM-47 — see RolloutNewHost.configCheck). A forced cutover requires a
   * reason server-side and is audited with `forced: true` either way.
   * Ignored (has no effect) on actions with no bypassable gate — including
   * `verify-config` itself, which has no gate to bypass.
   */
  force?: boolean;
}

/** Body for POST .../rollout-plans/{planId}/remove-hosts — batch removal within the removing_old state. `reason` is MANDATORY (destructive, irreversible per host). */
export interface RemoveRolloutHostsRequest {
  sessionHostNames: string[];
  reason: string;
}

/** One host's outcome within a remove-hosts batch. */
export interface RemoveRolloutHostFailure {
  sessionHostName: string;
  /** Short, sanitized classification (e.g. "host has 2 active session(s) — removal refused" or "Azure request failed"), never a raw ARM error string — same CWE-532 rationale as SessionBatchFailure.message. */
  message: string;
}

/** Aggregate outcome of a remove-hosts batch call — mirrors SessionBatchResult's partial-failure shape (one host's hard-gate refusal or ARM failure must not fail the whole batch). */
export interface RemoveRolloutHostsResult {
  attempted: number;
  succeeded: string[];
  failed: RemoveRolloutHostFailure[];
}

export interface RemoveRolloutHostsResponse {
  plan: RolloutPlanDetail;
  result: RemoveRolloutHostsResult;
}

/**
 * AM-16 (M3b) — Governance & security posture panel.
 *
 * A check's `status` is computed server-side by a PURE evaluation function
 * (app/api/src/services/governance/*.ts) fed live ARM/Graph data — the
 * frontend never re-derives pass/warn/fail itself, it only renders what the
 * API decided. 'unknown' is a DISTINCT status from 'fail': it means the
 * check could not run at all (missing RBAC/Graph grant, missing config —
 * e.g. the break-glass CA policy check before BREAK_GLASS_GROUP_ID is set,
 * or before Microsoft Graph Policy.Read.All has been manually granted — see
 * that check's own doc comment) — never a synonym for "failed", and the
 * summary tiles count it separately so an ungranted permission doesn't
 * masquerade as a real security failure.
 */
export type GovernanceCheckStatus = 'pass' | 'warn' | 'fail' | 'unknown';

/** A single deep link surfaced alongside a governance check's evidence (e.g. straight to the Entra admin center blade for a Conditional Access policy gap, or the Azure portal blade for a resource this check flagged). */
export interface GovernanceLink {
  label: string;
  url: string;
}

/**
 * One check's result within GET /v1/governance. `evidence` is a flat,
 * JSON-serializable bag of the ACTUAL observed values the status was
 * computed from (never free prose alone) — e.g. { enablePurgeProtection:
 * false, vaultName: 'KV-AVD-CONTOSO' } — so the UI's expandable evidence panel
 * always shows real data, not a restatement of `summary`.
 */
export interface GovernanceCheckResult {
  /** Stable id, e.g. 'kv-purge-protection' — keys the check in the registry (app/api/src/services/governance/registry.ts) and in the frontend's expand/collapse state. */
  id: string;
  title: string;
  category: string;
  status: GovernanceCheckStatus;
  /** One-line, human-readable verdict — the evidence bag has the detail. */
  summary: string;
  evidence: Record<string, unknown>;
  links?: GovernanceLink[];
  /** ISO timestamp this specific check last actually ran (may predate GovernanceSummary.generatedAt slightly under concurrent execution — see governanceService.ts). */
  checkedAt: string;
}

/** Response shape for GET /v1/governance. */
export interface GovernanceSummary {
  checks: GovernanceCheckResult[];
  counts: { pass: number; warn: number; fail: number; unknown: number };
  generatedAt: string;
  /** True when this response was served from the ~10min server-side cache (app/api/src/services/governanceService.ts) rather than a fresh Azure/Graph fetch — surfaced so the UI's refresh button can show "already fresh" vs "just re-checked". */
  cached: boolean;
}

/**
 * Client-side scaling-phase computation (RampUp/Peak/RampDown/OffPeak) from
 * a ScalingPlanDetail — lives in its own file (scalingPhase.ts) since it's
 * logic, not a DTO, but is re-exported from here so app/frontend keeps
 * importing everything from '@avdmgr/shared' in one place.
 *
 * (This is the first real, runtime — not type-only — value this package
 * re-exports. Getting app/frontend's `vite build` to see it required
 * `resolve.preserveSymlinks: true` in app/frontend/vite.config.ts — see
 * that file's comment for why an npm-workspaces symlinked CJS package
 * needs it, independent of how the export itself is written here.)
 */
export { computeScalingPhase, KNOWN_DAY_NAMES, type ScalingPhase } from './scalingPhase';

/**
 * AM-26: EOL-countdown warning-tier classification, shared by the
 * Dashboard's image-version badge and the Images page's version timeline —
 * see eolTier.ts's doc comment for why this lives here rather than in the
 * frontend (same "no test runner in app/frontend" reasoning as
 * computeScalingPhase above).
 */
export { eolTier, type EolTier } from './eolTier';

/**
 * AM-27 (M4-S2): golden image BUILD orchestration DTOs — state machine
 * states, the checklist-gate definition, the dry-run plan shape, and every
 * request/response for POST/GET /v1/images/builds* — re-exported from
 * imageBuild.ts (its own file since it's a large, self-contained set) so
 * app/frontend keeps importing everything from '@avdmgr/shared' in one
 * place, same convention as scalingPhase's re-export above.
 */
export * from './imageBuild';

/**
 * AM-50 — guided session-host provisioning DTOs, re-exported from
 * sessionHostProvision.ts (its own file, same "large self-contained set"
 * convention as imageBuild.ts's re-export above).
 */
export * from './sessionHostProvision';

// ---------------------------------------------------------------------------
// AM-14 (M6) — Users & access management.
//
// Two independent surfaces, both scoped to the configured desktop
// application group (config.dagName, "HP-CONTOSO-PROD-DAG"):
//   1. Search + assign/remove "Desktop Virtualization User" role assignments
//      on the DAG, via Microsoft Graph (search) + ARM (assignments) — see
//      app/api/src/services/accessService.ts.
//   2. The workspace's friendly name (config.workspaceName), a plain ARM
//      property edit via @azure/arm-desktopvirtualization — see
//      app/api/src/services/avdService.ts#getWorkspaceFriendlyName /
//      #updateWorkspaceFriendlyName.
// ---------------------------------------------------------------------------

/** A principal this app can grant desktop access to. Lowercase, matching the API's request/response shape — ARM's own PrincipalType ('User'/'Group', capitalized) is mapped to/from this at the accessService.ts boundary, never leaked into request bodies this app's own callers construct. */
export type PrincipalType = 'user' | 'group';

/**
 * One user or group result from GET /v1/access/search?q= (AM-14). Backed by
 * Microsoft Graph `/users` and `/groups`, matched by displayName/UPN prefix
 * — see accessService.ts#searchPrincipals. `id` is the Entra object ID
 * (GUID) — the same value POST /v1/access/assignments takes as
 * `principalId`.
 */
export interface AccessSearchResult {
  id: string;
  principalType: PrincipalType;
  displayName: string;
  /** Only ever populated for principalType 'user' — Graph groups have no UPN. */
  userPrincipalName?: string;
}

/**
 * Reason a Graph-backed feature could not run — shared by the search and
 * assignment-list responses below so the frontend renders one consistent
 * "Graph permission not granted" / "Graph error" state across both. See
 * docs/app-registration.md section 9 for the manual, Entra-side grant that
 * 'graph-permission-not-granted' means is still outstanding — this is an
 * EXPECTED, common state until that one-time step runs, not a bug.
 */
export type GraphDegradationReason = 'graph-permission-not-granted' | 'graph-error';

/**
 * Response body for GET /v1/access/search?q= (AM-14). Requires at least the
 * 'operator' role — see accessSearch.ts. `results` is always `[]` when
 * `graphAvailable` is false (there is nothing to degrade partially: the
 * search itself never ran). Combines up to a handful of user + group matches
 * — see accessService.ts's MAX_SEARCH_RESULTS_PER_TYPE.
 */
export interface AccessSearchResponse {
  results: AccessSearchResult[];
  graphAvailable: boolean;
  graphDegradationReason?: GraphDegradationReason;
  /**
   * AM-14 peer review (fix 4): true when Microsoft Graph reported more
   * matches than this app fetched — search is deliberately bounded to a
   * SINGLE page per type, capped at MAX_SEARCH_RESULTS_PER_TYPE (see
   * accessService.ts#searchPrincipals) rather than following pagination, so
   * `results` is never presented as the complete match set when this is
   * true. The UI should hint "narrow your search" rather than implying
   * nothing else matched. False when `graphAvailable` is false (nothing was
   * fetched at all in that case).
   */
  truncated: boolean;
}

/**
 * One "Desktop Virtualization User" ARM role assignment AT OR ABOVE the DAG
 * scope, as surfaced by GET /v1/access/assignments (AM-14, viewer+).
 * `roleAssignmentId` is the `Microsoft.Authorization/roleAssignments`
 * resource's own NAME (a GUID this app generates at assignment-creation
 * time — see accessService.ts#createDesktopAssignment) — NOT `principalId`.
 * It is the value DELETE /v1/access/assignments/{roleAssignmentId} takes as
 * its route segment — but see `assignedDirectlyOnDag` below: that DELETE
 * endpoint can only ever remove an assignment where this is true.
 *
 * AM-14 peer review (fix 1 — BLOCKER): ARM's `$filter=atScope()` (used by
 * accessService.ts#listDesktopAssignments) returns role assignments "at OR
 * ABOVE" the queried scope — verified on Microsoft Learn (the
 * @azure/arm-authorization SDK's own filter documentation: "Use
 * $filter=atScope() to return all role assignments at or above the
 * scope"). So this list can legitimately include a "Desktop Virtualization
 * User" grant made at a PARENT resource group or subscription scope that
 * happens to also apply to (be inherited by) this DAG — this app's own
 * POST/DELETE endpoints never create or remove one of THOSE, only
 * DAG-scoped ones, so every row here needs to say which kind it is.
 */
export interface DesktopAssignment {
  roleAssignmentId: string;
  principalId: string;
  /**
   * ARM's own principalType on the role assignment ('User' | 'Group' for
   * every assignment THIS app creates — see CreateAssignmentRequest — but
   * surfaced as-is, unrestricted, for an assignment that predates this
   * feature or was made directly in the Azure portal/CLI, e.g.
   * 'ServicePrincipal' or 'ForeignGroup').
   */
  principalType: string;
  /**
   * Resolved via Microsoft Graph (GET /users/{id} falling back to
   * GET /groups/{id}) — undefined when the OVERALL response's graphResolved
   * is false, or when Graph itself could not resolve this SPECIFIC id (e.g.
   * the principal was deleted from Entra after the assignment was made,
   * which Graph reports as its own 404 distinct from a permissions
   * failure — see accessService.ts's per-principal resolution).
   */
  displayName?: string;
  /** Only ever populated when principalType is 'User' (Graph groups have no UPN) — same convention as AccessSearchResult.userPrincipalName. */
  userPrincipalName?: string;
  /**
   * The ARM scope this SPECIFIC role assignment is made at — the full
   * resource id, e.g. the DAG itself for every assignment this app
   * creates, or an ancestor resource group/subscription for an INHERITED
   * assignment this list also surfaces (see this interface's own doc
   * comment). Exposed raw (not just the derived fields below) so the UI —
   * or a future consumer — is never blocked on this DTO's own
   * interpretation of the ARM resource id shape.
   */
  scope: string;
  /**
   * True when `scope` is exactly the DAG. Only assignments with this true
   * were created by, and can be removed by, this app's own POST/DELETE
   * /v1/access/assignments endpoints — DELETE against an inherited
   * (false) row's roleAssignmentId always 404s (see
   * accessAssignmentDelete.ts's doc comment), because there is no
   * DAG-scoped resource with that name to find.
   */
  assignedDirectlyOnDag: boolean;
  /**
   * Human-readable description of where this assignment is actually made —
   * "Direct on DAG" when assignedDirectlyOnDag is true, or "Inherited from
   * resource group {name}" / "Inherited from subscription" / a raw-scope
   * fallback otherwise — computed server-side
   * (accessService.ts#describeScope) so the frontend never needs to parse
   * ARM resource ids itself.
   */
  assignedVia: string;
}

/**
 * Response body for GET /v1/access/assignments (AM-14). viewer+.
 * `assignments` always lists bare `principalId`/`principalType` from ARM
 * even when `graphResolved` is false — only the display-name enrichment
 * degrades, never the assignment list itself (an ARM-only read, gated
 * independently of the Graph-backed search feature — see AM-14's Jira
 * description: "keep each check/feature degrading independently").
 */
export interface AssignmentsListResponse {
  assignments: DesktopAssignment[];
  graphResolved: boolean;
  graphDegradationReason?: GraphDegradationReason;
  /**
   * AM-14 peer review (fix 4): true when the underlying ARM role-assignment
   * list itself was truncated by this app's own page-count safety ceiling
   * (see restClient.ts's MAX_LIST_PAGES, surfaced through
   * armRest.ts#armListAtScope) — a genuinely very large number of role
   * assignments at or above the DAG scope. Independent of `graphResolved`/
   * `graphDegradationReason`, which describe the SEPARATE Graph
   * name-resolution half of this response.
   */
  truncated: boolean;
}

/**
 * Request body for POST /v1/access/assignments (AM-14). ADMIN-only,
 * audited — see accessAssignments.ts. `reason` is MANDATORY: granting
 * desktop access is a meaningful privilege change, same "always justified"
 * posture as ForceLogoffSessionRequest.reason. The server pins
 * roleDefinitionId to "Desktop Virtualization User" itself
 * (accessService.DESKTOP_VIRTUALIZATION_USER_ROLE_ID) — this request body
 * has NO roleDefinitionId field at all, so there is no way for a caller to
 * request any other role through this endpoint (see accessService.test.ts's
 * pinned-GUID assertion, and infra/modules/dagUserAccessAdministratorRole.bicep's
 * ABAC condition, which independently enforces the same constraint at the
 * ARM layer as defense-in-depth).
 */
export interface CreateAssignmentRequest {
  principalId: string;
  principalType: PrincipalType;
  reason: string;
}

export interface CreateAssignmentResponse {
  assignment: DesktopAssignment;
}

/** Body for DELETE /v1/access/assignments/{roleAssignmentId} (AM-14). ADMIN-only, audited. `reason` is MANDATORY, same rationale as CreateAssignmentRequest.reason. */
export interface RemoveAssignmentRequest {
  reason: string;
}

/** Response body for GET /v1/workspace/friendly-name (AM-14, viewer+) and PATCH .../friendly-name (operator+, see UpdateWorkspaceFriendlyNameRequest). `friendlyName` is undefined when the workspace has none set — ARM's own friendlyName property is optional. */
export interface WorkspaceFriendlyNameResponse {
  friendlyName?: string;
}

/**
 * Request body for PATCH /v1/workspace/friendly-name (AM-14). Operator+,
 * audited; `reason` is OPTIONAL (a friendly-name edit is a low-blast-radius
 * cosmetic change, unlike CreateAssignmentRequest/RemoveAssignmentRequest's
 * mandatory reasons) — same posture as DrainSessionHostRequest.reason.
 * Updates ONLY friendlyName via ARM's merge-patch workspaces.update — no
 * other workspace property is ever touched by this endpoint (verified
 * against the installed @azure/arm-desktopvirtualization SDK's
 * WorkspacePatch type — see avdService.ts#updateWorkspaceFriendlyName).
 */
export interface UpdateWorkspaceFriendlyNameRequest {
  friendlyName: string;
  reason?: string;
}

// ---------------------------------------------------------------------------
// AM-15 (M7): Settings page — the signed-in user's resolved access, plus a
// read-only, non-secret slice of the app's own configuration.
// ---------------------------------------------------------------------------

/**
 * Whether a config value that could disclose something sensitive (a group's
 * Entra object ID, a subscription/resource id) is set — WITHOUT echoing the
 * value itself. See SettingsResponse.groupIds — 'configured' still tells an
 * admin troubleshooting a missing role mapping (see
 * docs/app-registration.md section 1/4) which of the three group ids is the
 * gap, without this endpoint (viewer+) becoming a way to read out the actual
 * GUIDs.
 */
export type ConfiguredStatus = 'configured' | 'not-configured';

/**
 * Response body for GET /v1/settings (AM-15, viewer+). Deliberately narrow:
 * every field here is either already anonymous-readable elsewhere (apiVersion
 * — see GET /v1/health) or a resource NAME an operator already sees
 * throughout the rest of the app's UI (host pool page, profiles page, etc.) —
 * never a subscription id, resource group name, or the group object ids
 * themselves (see ConfiguredStatus). This is a read-only surface: there is no
 * corresponding PUT/PATCH — every one of these values is a Function App
 * setting, changed via infra/main.bicep + a deploy, not through this app.
 *
 * AM-54: `apiVersion` is now sourced from the CI-stamped build artifact when
 * one is present (falling back to the API_VERSION app setting otherwise —
 * see `app/api/src/lib/buildInfo.ts`), same as GET /v1/health.
 * `gitSha`/`builtAt` are populated alongside it only when the artifact
 * provided them; `versionSource` says which of the two sources this
 * response's `apiVersion` came from.
 */
export interface SettingsResponse {
  apiVersion: string;
  /** Short-form (full 40-char) commit SHA of the deployed build, when known — see this interface's AM-54 doc comment above. */
  gitSha?: string;
  /** ISO timestamp the deployed build was packaged, when known — see this interface's AM-54 doc comment above. */
  builtAt?: string;
  versionSource?: 'artifact' | 'app-setting';
  hostPoolName: string;
  workspaceName: string;
  dagName: string;
  storage: {
    accountName: string;
    fslogixShareName: string;
  };
  /** The FSLOGIX_OVERSIZED_GB app setting (see ProfilesListResponse.oversizedThresholdGb) — duplicated here so Settings can show it without a round trip through GET /v1/profiles, which also requires a live FileREST call. */
  profilesOversizedGb: number;
  groupIds: {
    viewer: ConfiguredStatus;
    operator: ConfiguredStatus;
    admin: ConfiguredStatus;
  };
}

/**
 * AM-29 item 26: response for GET /v1/estate/summary — the single aggregate
 * call behind the EstateStrip shown on every page (viewer+). A thin handler
 * composed entirely from data this app's OTHER endpoints already compute
 * (host/session health, current scaling phase, unacked alert count,
 * emergency-override state) — see
 * app/api/src/services/estateSummaryService.ts — issuing NO Azure calls
 * beyond what those existing services already make.
 *
 * Each segment is fetched independently (Promise.allSettled) and is
 * `undefined`, NOT a fabricated zero/false, when its own sub-source failed —
 * the strip renders "—" for that one segment rather than going blank or
 * lying about the estate's state. `generatedAt`/`hostPoolName` are always
 * present; every other field may be missing on a partial-failure response.
 */
export interface EstateSummaryResponse {
  generatedAt: string;
  hostPoolName: string;
  hosts?: { available: number; total: number };
  sessions?: { used: number; capacity: number };
  scalingPhase?: ScalingPhase;
  /** Count of alerts (last 24h) with no app-level ack recorded — see estateSummaryService.ts. Snoozed-but-unacked alerts still count as open (snooze only defers visual prominence elsewhere, it isn't an acknowledgement). */
  openAlertCount?: number;
  overrideActive?: boolean;
}

// ---------------------------------------------------------------------------
// AM-52 — per-host Intune policy-health panel (65000/missing-ADMX detection).
//
// Motivating incident (2026-08-22, the FSLogix storage runbook
// §5.1): diagnosing why FSLogix showed error 65000 on new hosts took five Run
// Command round-trips and manual event-log archaeology across three VMs. The
// signature is fully mechanical: Intune's one-shot third-party ADMX
// ingestion batch (FSLogix + Edge + Office + OneDrive + WSL together) can
// fail AT ENROLLMENT (observed live, error `0x86000009`, on both
// avd-con-1/avd-con-2) and Intune never retries it — every Settings
// Catalog setting backed by that ADMX then reports error 65000 indefinitely,
// with "file not found" against `FSLogixv1~Policy~...` URIs in the MDM
// diagnostic event log. (The benign `ADMXInstall/Receiver/Properties/Policy/
// FakePolicy` 404 in that same log is an unrelated version-probe artifact —
// this app's detection never treats it as part of the failure.) The fix
// itself (§5.1) is a trivial edit+save of the Settings Catalog profile,
// which re-versions it and forces Intune to re-send the ADMX batch on the
// device's next sync — this feature surfaces the SIGNATURE so an operator
// sees it on the Hosts page instead of rediscovering it host by host.
//
// GRAPH DESIGN (every endpoint verified against Microsoft Learn before
// coding — see intunePolicyHealthService.ts's header comment for the full
// citation trail):
//   1. Resolve each host's Intune managed device — GET
//      /deviceManagement/managedDevices?$filter=deviceName eq '<host>'
//      (v1.0), application permission DeviceManagementManagedDevices.Read.All
//      (app role id 2f51be20-0bb4-4fed-bf7b-db946066c75e). This app's session
//      hosts are pure Entra-joined, so deviceName == the session host's short
//      name == the Windows computer name == the AVD sessionHost name (see
//      The session-host lifecycle runbook). Stale duplicate
//      Intune device records are a KNOWN, undocumented-as-fixed estate
//      condition (that same doc flags device cleanup as not captured) — when
//      more than one managed device matches a host name, the one with the
//      newest lastSyncDateTime is used and `duplicateDeviceRecords: true` is
//      set.
//   2. Per-device policy state — GET /deviceManagement/managedDevices/{id}/
//      deviceConfigurationStates (v1.0), application permission
//      DeviceManagementConfiguration.Read.All (app role id
//      dc377aa6-52d8-4e23-b271-2a7ae04cedf3). Each returned profile's
//      `settingStates` (deviceConfigurationSettingState — a v1.0 resource)
//      carries a per-setting `setting` identifier (the OMA-URI/definition
//      string — this is where `FSLogixv1~Policy~...` appears) and `errorCode`
//      (this is where 65000 appears) — v1.0 is ADEQUATE for the full
//      signature; no beta endpoint was needed. `admxSignatureDetectable` on
//      each host's evidence is honest about whether ITS OWN response
//      actually carried that per-setting granularity — see
//      IntunePolicyHealthEvidence's own doc comment.
//
// DEGRADATION: a 403 on EITHER Graph call is a tenant-wide "this permission
// isn't granted" condition (never per-host — see
// IntunePolicyHealthResponse.degradation); a per-host Graph failure once
// permissions ARE granted (a single device's config-state call erroring)
// degrades ONLY that host to 'unknown', never the whole batch — see
// intunePolicyHealthService.ts's header comment for the phase-by-phase
// reasoning.
// ---------------------------------------------------------------------------

/**
 * 'ok': every configuration profile reported for the host's device is
 * error-free. 'policy-errors': at least one setting is in error/conflict,
 * but the FSLogixv1~/65000 signature specifically was not observed (a
 * DIFFERENT policy problem, or the signature exists at a granularity this
 * app couldn't inspect — see admxSignatureDetectable). 'missing-admx': the
 * exact signature (errorCode 65000 on a FSLogixv1~Policy~ setting) was
 * observed. 'not-enrolled': no Intune managed device matched this host's
 * name at all. 'unknown': Graph couldn't be queried for this host (missing
 * permission grant, or a per-host Graph error) — see
 * IntunePolicyHealthResponse.degradation to tell those two apart.
 */
export type IntunePolicyHealthStatus = 'ok' | 'policy-errors' | 'missing-admx' | 'not-enrolled' | 'unknown';

/**
 * The observed values one host's status was computed from — never free
 * prose alone, same "evidence is real data" convention as
 * GovernanceCheckResult.evidence.
 */
export interface IntunePolicyHealthEvidence {
  /** The Intune managed device's own id (the object this evidence describes) — undefined for 'not-enrolled' (no device matched) and for an 'unknown' host degraded before a device could be resolved. */
  deviceId?: string;
  lastSyncDateTime?: string;
  /** Count of settings reported in an error/conflict state across every configuration profile Graph returned for this device — 0 (not undefined) for a clean 'ok' host; undefined only when no config-state read was possible at all ('not-enrolled'/'unknown'). */
  errorSettingCount?: number;
  /** The specific setting identifier(s) matching the FSLogixv1~/65000 signature — bounded (see intunePolicyHealthService.ts's MAX_FSLOGIX_ERROR_SETTINGS), present only when status is 'missing-admx'. */
  fsLogixErrorSettings?: string[];
  /** True when more than one Intune managed device matched this host's name (see this section's header comment) — the newest by lastSyncDateTime was used; omitted (not false) when only one device matched. */
  duplicateDeviceRecords?: boolean;
  /**
   * Whether THIS host's own deviceConfigurationStates response actually
   * carried per-setting granularity (at least one profile with a
   * `settingStates` array) — i.e. whether this app could have detected the
   * FSLogixv1~/65000 signature even if it wasn't present. False means this
   * host's status is a COARSER classification than the signature this
   * feature was built to catch (e.g. 'policy-errors' rather than a
   * confident 'ok' or 'missing-admx') — this app never reports
   * 'missing-admx' unless the signature was actually observed, but it also
   * never silently claims a clean 'ok' verdict on granularity it never had.
   * True (trivially) for a device with zero reported configuration
   * profiles at all — there is nothing to have missed.
   */
  admxSignatureDetectable: boolean;
  /** Present only when a per-host Graph call failed with something other than a permission error (network/transient) — the raw error is logged server-side under this id, never returned verbatim (same CWE-532 posture as every other correlationId in this app). */
  correlationId?: string;
}

/** One host's Intune policy-health result, within GET /v1/hostpools/{hostPoolName}/policy-health (AM-52, viewer+). */
export interface IntunePolicyHealthHost {
  hostName: string;
  status: IntunePolicyHealthStatus;
  evidence: IntunePolicyHealthEvidence;
  /** Guided fix text, present only when status is 'missing-admx' — cites the FSLogix storage runbook §5.1's live-verified edit+save+sync remediation. */
  remediation?: string;
}

/**
 * Response body for GET /v1/hostpools/{hostPoolName}/policy-health (AM-52).
 * `degradation` mirrors AccessSearchResponse's GraphDegradationReason
 * convention: 'graph-permission-not-granted' means one of the two Graph
 * permissions above hasn't been granted yet (an EXPECTED, common state until
 * docs/app-registration.md §9's grant runs — every host's status is
 * 'unknown' in that case, never a fabricated 'ok'); 'graph-error' means the
 * device-resolution call itself failed for a non-permission reason
 * (network/transient — also every host 'unknown'). Neither is set at all
 * when Graph is reachable and granted, even if some INDIVIDUAL host still
 * shows 'unknown' (that host's own evidence.correlationId explains why — see
 * intunePolicyHealthService.ts's per-host isolation).
 */
export interface IntunePolicyHealthResponse {
  hosts: IntunePolicyHealthHost[];
  degradation?: GraphDegradationReason;
  /** Present only when degradation is 'graph-permission-not-granted' — the same az CLI grant commands documented in docs/app-registration.md §9's new Intune permission rows. */
  grantInstructions?: readonly string[];
  /** True when a Graph list call this response depended on hit its pagination ceiling (see lib/restClient.ts's MAX_LIST_PAGES) — the response is still usable, just not guaranteed complete. */
  truncated?: boolean;
  generatedAt: string;
  /** True when served from intunePolicyHealthService.ts's short server-side cache rather than a fresh Graph fetch — same convention as GovernanceSummary.cached. */
  cached: boolean;
}
