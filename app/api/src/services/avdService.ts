import { DefaultAzureCredential } from '@azure/identity';
import { DesktopVirtualizationAPIClient } from '@azure/arm-desktopvirtualization';
import type {
  HostPool as ArmHostPool,
  SessionHost as ArmSessionHost,
  UserSession as ArmUserSession,
  ScalingPlan as ArmScalingPlan,
  ScalingSchedule as ArmScalingSchedule,
  ScalingHostPoolReference as ArmScalingHostPoolReference,
  ScalingPlanPooledSchedule as ArmScalingPlanPooledSchedule,
  ScalingPlanPooledSchedulePatch as ArmScalingPlanPooledSchedulePatch,
} from '@azure/arm-desktopvirtualization';
import {
  KNOWN_USER_SESSION_STATES,
  type GenerateRegistrationTokenResponse,
  type HealthCheck,
  type HostPool,
  type PowerState,
  type RegistrationTokenStatus,
  type ScalingPlanDetail,
  type ScalingScheduleCreateRequest,
  type ScalingScheduleDetail,
  type ScalingSchedulePatchRequest,
  type ScalingSchedulePeriod,
  type SessionHost,
  type SessionHostStatus,
  type UserSession,
  type UserSessionState,
  type VmTemplateInfo,
} from '@avdmgr/shared';
import { getConfig } from '../lib/config';
import { getVmPowerState, parseVmResourceId } from './computeService';

let cachedClient: DesktopVirtualizationAPIClient | undefined;

/**
 * Lazily constructs (and caches) the DesktopVirtualizationAPIClient.
 *
 * Uses DefaultAzureCredential so the same code path works both locally
 * (via `az login` / VS Code / env vars) and once deployed, where the
 * Function App's system-assigned managed identity is used automatically.
 */
function getClient(): DesktopVirtualizationAPIClient {
  if (!cachedClient) {
    const { subscriptionId } = getConfig();
    const credential = new DefaultAzureCredential();
    cachedClient = new DesktopVirtualizationAPIClient(credential, subscriptionId);
  }
  return cachedClient;
}

const HOST_POOL_TYPES: readonly HostPool['hostPoolType'][] = ['Pooled', 'Personal'];

/**
 * ARM's HostPoolType is an extensible string enum. Validate against the
 * values this app models rather than blindly casting the SDK's raw string,
 * falling back to 'Pooled' (the more common/conservative default) for any
 * value we don't yet recognize.
 */
function normalizeHostPoolType(value: string | undefined): HostPool['hostPoolType'] {
  return (HOST_POOL_TYPES as readonly string[]).includes(value ?? '') ? (value as HostPool['hostPoolType']) : 'Pooled';
}

function mapHostPool(armHostPool: ArmHostPool, resourceGroup: string): HostPool {
  return {
    id: armHostPool.id ?? '',
    name: armHostPool.name ?? '',
    friendlyName: armHostPool.friendlyName,
    resourceGroup,
    hostPoolType: normalizeHostPoolType(armHostPool.hostPoolType),
    loadBalancerType: armHostPool.loadBalancerType,
    preferredAppGroupType: armHostPool.preferredAppGroupType,
    maxSessionLimit: armHostPool.maxSessionLimit,
    validationEnvironment: armHostPool.validationEnvironment,
    // AM-38 fix: startVMOnConnect/ring/customRdpProperty are plain fields on
    // the ARM HostPool object already returned by listByResourceGroup — no
    // extra ARM call needed (unlike sessionHostCount below), so there is no
    // reason to omit them from the list mapping. Omitting them here (as this
    // function previously did) meant GET /v1/hostpools — the endpoint the
    // Host Pool page's Properties card actually calls — always produced
    // startVMOnConnect: undefined, which the page's `? 'On' : 'Off'` render
    // then displayed as a hardcoded "Off" regardless of the live ARM value.
    startVMOnConnect: armHostPool.startVMOnConnect,
    ring: armHostPool.ring,
    customRdpProperty: armHostPool.customRdpProperty,
    // sessionHostCount is intentionally omitted here — see the HostPool DTO
    // comment in @avdmgr/shared. Populating it would require one extra ARM
    // call (sessionHosts.list) per host pool in this list response (N+1);
    // it belongs on the host pool detail/drill-in endpoint instead.
  };
}

/**
 * Lists AVD host pools in the configured host pools resource group, mapped
 * to the shared HostPool DTO. This proves the ARM SDK wiring compiles
 * end-to-end; it only returns real data once deployed with a managed
 * identity (or run locally after `az login`) that has Reader access on the
 * host pools resource group.
 */
export async function listHostPools(): Promise<HostPool[]> {
  const client = getClient();
  const { resourceGroups } = getConfig();
  const results: HostPool[] = [];

  for await (const armHostPool of client.hostPools.listByResourceGroup(resourceGroups.hostPools)) {
    results.push(mapHostPool(armHostPool, resourceGroups.hostPools));
  }

  return results;
}

/** Fetches a single host pool's full detail (used by the HostPool page and by health/summary for maxSessionLimit). Returns null on a 404 rather than throwing. */
export async function getHostPool(hostPoolName: string): Promise<HostPool | null> {
  const client = getClient();
  const { resourceGroups } = getConfig();

  try {
    const armHostPool = await client.hostPools.get(resourceGroups.hostPools, hostPoolName);
    // AM-38: startVMOnConnect/ring/customRdpProperty now come from
    // mapHostPool itself (see its comment) — no need to re-spread them here.
    return mapHostPool(armHostPool, resourceGroups.hostPools);
  } catch (error) {
    if (isNotFoundError(error)) {
      return null;
    }
    throw error;
  }
}

function hasStatusCode(error: unknown, statusCode: number): boolean {
  return typeof error === 'object' && error !== null && 'statusCode' in error && (error as { statusCode?: number }).statusCode === statusCode;
}

/** Exported so callers outside this module (e.g. app/api/src/functions/sessionHostDrain.ts) can map an ARM 404 to their own 404 response instead of a generic 5xx. */
export function isNotFoundError(error: unknown): boolean {
  return hasStatusCode(error, 404);
}

/**
 * AM-19 (M2-S2) peer review item 2: distinguishes an ARM 403 (authorization
 * denied — e.g. the Function App's managed identity's role assignment
 * hasn't propagated yet, or was never granted) so
 * sessionHostPower.ts's submit-phase error mapping can give the operator a
 * specific, actionable message instead of a generic 502.
 */
export function isForbiddenError(error: unknown): boolean {
  return hasStatusCode(error, 403);
}

/**
 * AM-19 (M2-S2) peer review item 2: distinguishes an ARM 409 (conflicting
 * operation — e.g. another power operation already in flight against the
 * same VM, or the VM is in a transitional state that rejects this one) so
 * sessionHostPower.ts's submit-phase error mapping can surface it as its
 * own 409 rather than a generic 502.
 */
export function isConflictError(error: unknown): boolean {
  return hasStatusCode(error, 409);
}

/**
 * AM-23 peer review (item 5): distinguishes an ARM 400 (Bad Request) so the
 * scaling-schedule handlers can surface it to the caller as a 400 (a
 * caller-fixable rejection), instead of falling through to a generic 502 —
 * this app's own client-side validation (lib/scalingValidation.ts) catches
 * most invalid input before ever reaching ARM, but ARM's schema/
 * business-rule validation is the final authority (e.g. a constraint this
 * app doesn't independently model).
 *
 * AM-15 (M7) sweep correction: the 400 response body does NOT include ARM's
 * own validation message text (an earlier version of this comment described
 * that as the intent) — a RestError's message can embed the full outbound
 * request, including its body, which must never round-trip into a response
 * the browser renders (CWE-532, same reasoning as sessionBatch.ts's
 * SessionBatchFailure.message doc comment). The raw error is still logged
 * server-side (context.error, joinable by correlationId) at every call site
 * that checks this.
 */
export function isBadRequestError(error: unknown): boolean {
  return hasStatusCode(error, 400);
}

const SESSION_HOST_STATUSES: readonly SessionHostStatus[] = [
  'Available',
  'Unavailable',
  'Shutdown',
  'Disconnected',
  'Upgrading',
  'UpgradeFailed',
  'NoHeartbeat',
  'NotJoinedToDomain',
  'DomainTrustRelationshipLost',
  'SxSStackListenerNotReady',
  'FSLogixNotHealthy',
  'NeedsAssistance',
];

function normalizeSessionHostStatus(value: string | undefined): SessionHostStatus {
  return (SESSION_HOST_STATUSES as readonly string[]).includes(value ?? '') ? (value as SessionHostStatus) : 'Unknown';
}

/**
 * ARM's sessionHosts.list `.name` is the child-resource-qualified
 * "{hostPoolName}/{sessionHostName}" form (confirmed against
 * The captured estate inventory). Strips the
 * host pool prefix so the DTO's `name` is just the host name, which is what
 * the UI and the per-host detail routes want.
 */
function shortSessionHostName(qualifiedName: string | undefined): string {
  if (!qualifiedName) return '';
  const slashIndex = qualifiedName.indexOf('/');
  return slashIndex === -1 ? qualifiedName : qualifiedName.slice(slashIndex + 1);
}

function mapHealthCheck(check: NonNullable<ArmSessionHost['sessionHostHealthCheckResults']>[number]): HealthCheck {
  return {
    name: check.healthCheckName ?? 'Unknown',
    healthCheckResult: check.healthCheckResult ?? 'Unknown',
    additionalFailureDetails: check.additionalFailureDetails?.message || undefined,
  };
}

/**
 * Maps one ARM SessionHost to the shared DTO, WITHOUT resolving VM power
 * state (that's a separate async ARM call per host — see
 * resolvePowerState below — kept out of this pure mapper so it stays
 * synchronous and unit-testable).
 */
function mapSessionHost(armHost: ArmSessionHost, hostPoolName: string): SessionHost {
  return {
    id: armHost.id ?? '',
    name: shortSessionHostName(armHost.name),
    hostPoolName,
    status: normalizeSessionHostStatus(armHost.status),
    allowNewSession: armHost.allowNewSession ?? false,
    activeSessions: armHost.sessions ?? 0,
    agentVersion: armHost.agentVersion,
    osVersion: armHost.osVersion,
    lastHeartBeat: armHost.lastHeartBeat?.toISOString(),
    healthChecks: armHost.sessionHostHealthCheckResults?.map(mapHealthCheck),
  };
}

/**
 * Resolves a single mapped session host's VM power state via
 * computeService, using the ARM host's `resourceId` (not exposed on the
 * shared DTO — captured here from the original ARM object). Never throws:
 * a per-host power-state lookup failure degrades that host to
 * powerState: 'unknown' rather than failing the whole sessionhosts list.
 */
async function resolvePowerState(armHost: ArmSessionHost, context: { warn: (message: string) => void }): Promise<PowerState> {
  const parsed = parseVmResourceId(armHost.resourceId);
  if (!parsed) {
    return 'unknown';
  }
  try {
    return await getVmPowerState(parsed.resourceGroup, parsed.vmName);
  } catch (error) {
    context.warn(`Failed to resolve VM power state for ${armHost.resourceId}: ${error instanceof Error ? error.message : String(error)}`);
    return 'unknown';
  }
}

export interface ListSessionHostsOptions {
  warn?: (message: string) => void;
  /**
   * Set false to skip the VM power-state ARM call entirely (one extra
   * @azure/arm-compute call per host — see resolvePowerState above).
   * Results will report powerState: 'unknown' for every host. Defaults to
   * true. GET /api/v1/health/summary sets this false: it only needs
   * status/allowNewSession/activeSessions to compute the health ring, so
   * there is no reason to pay for N VM instanceView calls on every 60s
   * dashboard poll.
   */
  resolvePowerState?: boolean;
}

/**
 * Lists session hosts in the given host pool, including health checks,
 * agent version, allowNewSession, lastHeartBeat, session counts, and
 * (unless options.resolvePowerState is false) VM power state — resolved via
 * one extra ARM call per host against @azure/arm-compute, see
 * computeService.getVmPowerState. Power-state lookups run in parallel; a
 * single host's lookup failing degrades only that host's powerState to
 * 'unknown', it does not fail the whole list.
 */
export async function listSessionHosts(hostPoolName: string, options: ListSessionHostsOptions = {}): Promise<SessionHost[]> {
  const { warn = () => {}, resolvePowerState: shouldResolvePowerState = true } = options;
  const client = getClient();
  const { resourceGroups } = getConfig();

  const armHosts: ArmSessionHost[] = [];
  for await (const armHost of client.sessionHosts.list(resourceGroups.hostPools, hostPoolName)) {
    armHosts.push(armHost);
  }

  return Promise.all(
    armHosts.map(async (armHost) => ({
      ...mapSessionHost(armHost, hostPoolName),
      powerState: shouldResolvePowerState ? await resolvePowerState(armHost, { warn }) : ('unknown' as const),
    })),
  );
}

/** One session host's identity plus its underlying VM's ARM resourceId, for image-version correlation (AM-26 — see imagesService.ts#correlateHostsToVersions). */
export interface SessionHostVmRef {
  sessionHostName: string;
  /** ARM resourceId of the host's underlying VM (ArmSessionHost.resourceId), or undefined if ARM didn't report one (e.g. host not yet fully registered). Not exposed on the shared SessionHost DTO — see mapSessionHost's doc comment for why that mapper omits it. */
  resourceId?: string;
}

/**
 * Lists session hosts in the given host pool with JUST their name + VM
 * resourceId — a separate, lighter-weight ARM listing pass from
 * listSessionHosts above (which additionally resolves health/power state
 * per host). Used solely by GET /v1/images/versions
 * (app/api/src/functions/imagesVersions.ts) to correlate each host to the
 * gallery image version its VM was created from; kept as its own function
 * rather than widening SessionHost/listSessionHosts so the image-version
 * feature's data needs stay decoupled from the Sessions/HostPool pages'
 * existing shape and ARM call volume.
 */
export async function listSessionHostVmRefs(hostPoolName: string): Promise<SessionHostVmRef[]> {
  const client = getClient();
  const { resourceGroups } = getConfig();

  const refs: SessionHostVmRef[] = [];
  for await (const armHost of client.sessionHosts.list(resourceGroups.hostPools, hostPoolName)) {
    refs.push({ sessionHostName: shortSessionHostName(armHost.name), resourceId: armHost.resourceId });
  }
  return refs;
}

/**
 * Sets a session host's allowNewSession flag ("drain mode" — see the
 * SessionHost DTO comment in @avdmgr/shared) via ARM's sessionHosts.update.
 * Used by PATCH /v1/hostpools/{hostPoolName}/sessionhosts/{sessionHostName}/drain
 * (app/api/src/functions/sessionHostDrain.ts), which requires the caller to
 * hold at least the 'operator' role (see requireMinimumRole).
 *
 * sessionHostName is the SHORT name (not the "{hostPoolName}/{name}"
 * qualified form listSessionHosts returns on `.name` after
 * shortSessionHostName strips it) — ARM's update operation takes it as its
 * own URL segment, same as sessionHosts.get/delete.
 *
 * Returns the updated host mapped to the shared DTO. powerState is not
 * resolved here (an extra ARM call the caller doesn't need — it only wants
 * confirmation that allowNewSession took effect), so it is always
 * 'unknown' on this return value; refetch the list if the UI needs it.
 *
 * CONCURRENCY (deliberately deferred — see AM-18 peer review): this call
 * carries no ETag/If-Match and performs no read-before-write, so two
 * concurrent callers racing to set allowNewSession is last-writer-wins.
 * Accepted for now because this is an absolute boolean set (idempotent —
 * setting it to the same value twice has no different effect than once),
 * not a relative/incremental operation, so "last write wins" converges to
 * one of the two intended states rather than a corrupted one. A future
 * non-idempotent mutation (e.g. anything that increments, appends, or is
 * otherwise order-sensitive) MUST revisit this and add an idempotency-key
 * and/or ETag concurrency story — do not copy this pattern blindly.
 */
export async function setSessionHostDrain(hostPoolName: string, sessionHostName: string, allowNewSession: boolean): Promise<SessionHost> {
  const client = getClient();
  const { resourceGroups } = getConfig();

  const armHost = await client.sessionHosts.update(resourceGroups.hostPools, hostPoolName, sessionHostName, {
    sessionHost: { allowNewSession },
  });

  return { ...mapSessionHost(armHost, hostPoolName), powerState: 'unknown' };
}

/**
 * AM-28 (M4-S3): deregisters a session host from the host pool via ARM's
 * sessionHosts.delete — used ONLY by the staged rollout's host-removal step
 * (app/api/src/functions/rolloutPlans.ts's remove-hosts handler), never by
 * any M2 route (see infra/modules/sessionHostWriterRole.bicep's header
 * comment for why sessionhosts/delete was deliberately excluded from that
 * role, and infra/modules/rolloutOperatorRole.bicep for the separate,
 * narrower role this call requires).
 *
 * `force` is confirmed on Microsoft Learn
 * (https://learn.microsoft.com/javascript/api/@azure/arm-desktopvirtualization/sessionhostsdeleteoptionalparams —
 * "Force flag to force sessionHost deletion even when userSession exists")
 * to be the ONLY optional parameter this operation takes. The caller
 * (rolloutPlans.ts) always passes force: false — this app's own hard
 * zero-sessions gate (see rolloutPlanService.ts#canRemoveHost) is checked
 * via a fresh ARM read immediately before this call, so a genuine race
 * (a session lands in the gap between that check and this delete) should
 * FAIL this call rather than be silently forced through; force: true would
 * defeat the hard gate's own purpose.
 *
 * This function deletes ONLY the host-pool REGISTRATION, not the underlying
 * VM — see computeService.ts#beginVmDelete for that separate step, and
 * The session-host lifecycle runbook §5 ("Remove a host") for
 * the full four-deletion picture (registration, VM, NIC, disk — the latter
 * two are explicitly OUT OF SCOPE for this automated flow; see
 * rolloutPlans.ts's remove-hosts doc comment for that boundary).
 */
export async function removeSessionHost(hostPoolName: string, sessionHostName: string, force = false): Promise<void> {
  const client = getClient();
  const { resourceGroups } = getConfig();

  await client.sessionHosts.delete(resourceGroups.hostPools, hostPoolName, sessionHostName, { force });
}

/**
 * Generates (or rotates) the host pool's session-host registration token via
 * ARM's hostPools.update with registrationInfo.registrationTokenOperation:
 * 'Update' — the SAME mechanism `az desktopvirtualization hostpool update
 * --registration-info ... registration-token-operation=Update` uses (see
 * The session-host runbook §3). Confirmed on Microsoft Learn
 * ("Host Pools - Update", api-version 2024-04-03) that this PATCH's 200
 * response echoes the newly generated token directly back in
 * properties.registrationInfo.token/expirationTime — there is no need for a
 * separate retrieveRegistrationToken call right after generating one.
 *
 * expirationTime is computed here (now + hoursValid) rather than trusting a
 * raw timestamp from the caller — the handler
 * (app/api/src/functions/hostPoolRegistrationToken.ts) validates hoursValid
 * is an integer within Azure's own 1-648-hour (27-day) bound before this is
 * called.
 *
 * SECURITY: the returned token is a bearer credential — anyone holding it
 * can register a new session host into this pool until it expires (see
 * The session-host runbook §3 step 4's warning). Callers MUST
 * NOT log or persist the token value — see the handler's audit call, which
 * only ever records { hoursValid, expirationTime }.
 */
export async function generateRegistrationToken(hostPoolName: string, hoursValid: number): Promise<GenerateRegistrationTokenResponse> {
  const client = getClient();
  const { resourceGroups } = getConfig();
  const expirationTime = new Date(Date.now() + hoursValid * 60 * 60 * 1000);

  const armHostPool = await client.hostPools.update(resourceGroups.hostPools, hostPoolName, {
    hostPool: {
      registrationInfo: {
        expirationTime,
        registrationTokenOperation: 'Update',
      },
    },
  });

  const token = armHostPool.registrationInfo?.token;
  const returnedExpiration = armHostPool.registrationInfo?.expirationTime;
  if (!token || !returnedExpiration) {
    // Defensive only — ARM's documented 200 response always echoes both
    // fields back (see this function's doc comment). Never trust an SDK
    // response shape blindly: surface this the same way any other ARM
    // failure is surfaced (the handler's catch-all 502), rather than
    // returning a silently-partial "success".
    throw new Error('hostPools.update did not return a registration token in its response.');
  }

  return { token, expirationTime: returnedExpiration.toISOString() };
}

/**
 * Reads the host pool's CURRENT registration-token status via ARM's
 * dedicated retrieveRegistrationToken action — NOT hostPools.get (plain
 * GET), whose registrationInfo reads back null even while a token is
 * actively valid (confirmed against this estate's own capture —
 * The session-host runbook §3 step 2's warning, backed by
 * raw/hostpool-detail-HP-CONTOSO-PROD.json). retrieveRegistrationToken's REST
 * response DOES include the live token value (confirmed on Microsoft Learn,
 * "Host Pools - Retrieve Registration Token", api-version 2024-04-03) — this
 * function deliberately discards it, returning only exists/expirationTime,
 * so the token value never crosses this app's response boundary for a
 * status check (see the handler's doc comment for the RBAC reasoning).
 *
 * exists is computed as "a token is present AND its expirationTime is still
 * in the future" — an already-expired token is reported the same as no
 * token, since both mean the same thing to a caller deciding whether to
 * generate a fresh one.
 *
 * OPERATIONAL NOTE: every call to this function writes a
 * `retrieveRegistrationToken` entry to the host pool's Azure Activity Log,
 * because that's the underlying ARM action being called — this is true even
 * though this function itself never mutates anything or rotates the token.
 * The Add session host panel calls this on every open (see
 * AddSessionHostPanel.tsx), so expect one Activity Log entry per panel open,
 * not per token generated. This is read-only log noise from ARM's own
 * action-based Activity Log model, not evidence of a rotation — do not
 * alert on this action id alone when reviewing the Activity Log for actual
 * token rotations (those are `Microsoft.DesktopVirtualization/hostpools/write`
 * calls with a registrationTokenOperation:'Update' body, which this app's
 * OWN AuditLog table already records distinctly — see writeAuditEntry's
 * 'hostpool.registrationtoken.generate' action in hostPoolRegistrationToken.ts).
 */
export async function getRegistrationTokenStatus(hostPoolName: string): Promise<RegistrationTokenStatus> {
  const client = getClient();
  const { resourceGroups } = getConfig();

  let info;
  try {
    info = await client.hostPools.retrieveRegistrationToken(resourceGroups.hostPools, hostPoolName);
  } catch (error) {
    // No active token is a normal, expected state (never generated, or
    // explicitly deleted — see the session-host runbook §3 step
    // 4) — Microsoft Learn's retrieveRegistrationToken reference does not
    // document that specific response shape, only the "token exists" 200
    // case, so a 404 here is handled defensively as "no token" rather than
    // propagated as a generic failure. Any OTHER error (403, 500, network)
    // still propagates to the handler's catch-all 502.
    if (isNotFoundError(error)) {
      return { exists: false };
    }
    throw error;
  }

  if (!info.token || !info.expirationTime || info.expirationTime.getTime() <= Date.now()) {
    return { exists: false };
  }
  return { exists: true, expirationTime: info.expirationTime.toISOString() };
}

/**
 * Pure parse of a host pool's raw vmTemplate string into the VmTemplateInfo
 * DTO — split out from getVmTemplateInfo below so this logic is
 * unit-testable without a real/mocked ARM client (same "pure logic in its
 * own function" pattern as healthService.ts's categorizeSessionHost). See
 * the VmTemplateInfo DTO comment in @avdmgr/shared for why the extracted
 * field names are best-effort (ARM documents vmTemplate only as an opaque
 * string), not a Microsoft Learn-verified schema.
 *
 * Returns { parsed: false } — never throws — for a missing/empty string, a
 * string that isn't valid JSON, or JSON that isn't a plain object (e.g. an
 * array or a bare primitive): a malformed vmTemplate is this app surfacing
 * a pre-existing data problem on the host pool, not something this
 * read-only endpoint should error out on.
 */
export function parseVmTemplate(raw: string | undefined): VmTemplateInfo {
  if (!raw) {
    return { parsed: false };
  }

  let parsedRaw: unknown;
  try {
    parsedRaw = JSON.parse(raw);
  } catch {
    return { parsed: false };
  }

  if (!parsedRaw || typeof parsedRaw !== 'object' || Array.isArray(parsedRaw)) {
    return { parsed: false };
  }

  const template = parsedRaw as Record<string, unknown>;
  const str = (key: string): string | undefined => (typeof template[key] === 'string' ? (template[key] as string) : undefined);
  const bool = (key: string): boolean | undefined => (typeof template[key] === 'boolean' ? (template[key] as boolean) : undefined);
  const vmSize = template.vmSize;
  const vmSizeId =
    vmSize && typeof vmSize === 'object' && typeof (vmSize as Record<string, unknown>).id === 'string'
      ? ((vmSize as Record<string, unknown>).id as string)
      : undefined;

  return {
    parsed: true,
    imageType: str('imageType'),
    galleryImagePublisher: str('galleryImagePublisher'),
    galleryImageOffer: str('galleryImageOffer'),
    galleryImageSKU: str('galleryImageSKU'),
    galleryImageVersion: str('galleryImageVersion'),
    customImageId: str('customImageId'),
    vmSizeId,
    osDiskType: str('osDiskType'),
    namePrefix: str('namePrefix'),
    domain: str('domain'),
    ouPath: str('ouPath') ?? str('OUPath') ?? str('hostpoolOUPath'),
    hibernate: bool('hibernate'),
    // SECURITY NOTE (raw passthrough): this echoes the ENTIRE parsed
    // vmTemplate object back through the API to every operator+ caller,
    // not just the fields explicitly modeled above — see the `raw`
    // property's own doc comment on VmTemplateInfo in @avdmgr/shared for
    // why (ARM publishes no schema for this string, so a hand-picked
    // subset alone could silently omit something the UI needs). The
    // current prod vmTemplate blob (HP-CONTOSO-PROD, captured in
    // The host-pool runbook §3) was manually reviewed
    // at AM-22 implementation time and contains no secrets — no
    // domain-join credentials, no SSO/ADFS material (those live on
    // separate HostPoolPatch properties — ssoClientSecretKeyVaultPath etc.
    // — not inside vmTemplate at all). If Azure ever adds a new field to
    // vmTemplate that carries a credential, this passthrough would expose
    // it to every operator with no code change on this app's part —
    // RE-REVIEW this decision (or replace `raw: template` with an explicit
    // allow-list copy) before trusting any newly-appeared field blindly.
    raw: template,
  };
}

/**
 * Fetches the host pool's vmTemplate property and parses it via
 * parseVmTemplate above (AM-22/M2-S5), for the Add session host panel's
 * "prefilled parameters" display.
 *
 * Returns null if the host pool itself isn't found (mirrors getHostPool's
 * 404 handling) — a genuinely different case from parseVmTemplate's
 * { parsed: false }, which means "the host pool exists but its vmTemplate
 * is missing/malformed".
 */
export async function getVmTemplateInfo(hostPoolName: string): Promise<VmTemplateInfo | null> {
  const client = getClient();
  const { resourceGroups } = getConfig();

  let armHostPool: ArmHostPool;
  try {
    armHostPool = await client.hostPools.get(resourceGroups.hostPools, hostPoolName);
  } catch (error) {
    if (isNotFoundError(error)) {
      return null;
    }
    throw error;
  }

  return parseVmTemplate(armHostPool.vmTemplate);
}

/**
 * Thrown by resolveSessionHostVm when the session host exists (ARM's
 * sessionHosts.get succeeded) but there's no VM this app can safely act on
 * — either its `resourceId` isn't a well-formed
 * `Microsoft.Compute/virtualMachines/{name}` id at all (see
 * computeService.parseVmResourceId; e.g. a host that hasn't finished
 * registering yet), OR (AM-19 peer review item 4) it parses fine but names a
 * VM in a DIFFERENT subscription than this deployment is configured for
 * (getConfig().subscriptionId) — a mismatch that must fail loudly rather
 * than silently targeting a same-named VM in the wrong subscription. Both
 * cases share one error type/handler mapping since both mean "found, but
 * there is no VM this app can safely act on" — the power-action handler
 * (app/api/src/functions/sessionHostPower.ts) maps this to its own error
 * code rather than either a 404 or a generic 502. `reason`, if provided,
 * distinguishes the two cases in logs/detail without needing a second error
 * class.
 */
export class VmResourceUnresolvableError extends Error {
  constructor(sessionHostName: string, reason?: string) {
    super(reason ?? `Session host "${sessionHostName}" has no resolvable VM resource id.`);
    this.name = 'VmResourceUnresolvableError';
  }
}

/** Return shape of resolveSessionHostVm — the VM location plus the server-observed session count (see that function's doc comment for why the latter matters). */
export interface SessionHostVmTarget {
  resourceGroup: string;
  vmName: string;
  /**
   * ARM's OWN session count for this host at resolve time (armHost.sessions
   * ?? 0 — same field setSessionHostDrain's mapSessionHost reads for the
   * SessionHost DTO's activeSessions). AM-19 peer review item 1: this is
   * the value the power-action handler records in the audit row's
   * `activeSessions` field — the AUTHORITATIVE, server-observed count — as
   * opposed to whatever the request body claimed (recorded separately under
   * `clientReportedActiveSessions`). Without this distinction, an operator
   * could POST activeSessions: 0 while deallocating a busy host and the
   * audit row would be indistinguishable from a genuinely idle deallocation.
   */
  activeSessions: number;
}

/**
 * Resolves the resource group + VM name (+ server-observed session count —
 * see SessionHostVmTarget) of a session host's underlying VM, via ARM's
 * sessionHosts.get (a single-host fetch — not sessionHosts.list, which
 * would page the whole pool just to read one resourceId/sessions pair).
 * Used by POST /v1/hostpools/{hostPoolName}/sessionhosts/{sessionHostName}/power
 * (AM-19/M2-S2) to find what to hand to computeService.beginVmPowerAction,
 * and to get the authoritative session count for that endpoint's audit row.
 *
 * sessionHostName is the SHORT name, same convention as setSessionHostDrain.
 *
 * Propagates the raw ARM error on a 404 (caller maps it via isNotFoundError,
 * same pattern as setSessionHostDrain) rather than catching it here — this
 * function's contract is "resolve or throw", not "resolve or return null",
 * so callers get one consistent throw-based error path for "host not found"
 * (ARM 404), "host found but unresolvable", and "host found but its VM is
 * in the wrong subscription" (both VmResourceUnresolvableError).
 */
export async function resolveSessionHostVm(hostPoolName: string, sessionHostName: string): Promise<SessionHostVmTarget> {
  const client = getClient();
  const { resourceGroups, subscriptionId } = getConfig();

  const armHost = await client.sessionHosts.get(resourceGroups.hostPools, hostPoolName, sessionHostName);
  const parsed = parseVmResourceId(armHost.resourceId);
  if (!parsed) {
    throw new VmResourceUnresolvableError(sessionHostName);
  }
  if (parsed.subscriptionId.toLowerCase() !== subscriptionId.toLowerCase()) {
    throw new VmResourceUnresolvableError(
      sessionHostName,
      `Session host "${sessionHostName}"'s VM resourceId is in subscription "${parsed.subscriptionId}", not this deployment's configured subscription "${subscriptionId}" — refusing to act on a VM outside the configured subscription.`,
    );
  }
  // AM-28 peer review item 13 — same "refuse to act on a VM outside the
  // configured scope" posture as the subscription check above, extended to
  // resource group: every session host's VM lives in
  // getConfig().resourceGroups.hostPools in practice (confirmed against
  // The session-host runbook §1), so a resourceId naming a
  // DIFFERENT resource group is exactly as suspicious as a different
  // subscription — most plausibly a spoofed/corrupted resourceId — and must
  // fail loudly rather than silently letting a power/delete action reach an
  // unexpected resource group. Checked here (not just at rollout-removal's
  // call site) so EVERY caller of this function — including the M2
  // power-action route (sessionHostPower.ts) — gets the same protection.
  if (parsed.resourceGroup.toLowerCase() !== resourceGroups.hostPools.toLowerCase()) {
    throw new VmResourceUnresolvableError(
      sessionHostName,
      `Session host "${sessionHostName}"'s VM resourceId is in resource group "${parsed.resourceGroup}", not this deployment's configured host-pools resource group "${resourceGroups.hostPools}" — refusing to act on a VM outside the configured resource group.`,
    );
  }
  return { resourceGroup: parsed.resourceGroup, vmName: parsed.vmName, activeSessions: armHost.sessions ?? 0 };
}

function normalizeSessionState(value: string | undefined): UserSessionState {
  return (KNOWN_USER_SESSION_STATES as readonly string[]).includes(value ?? '') ? (value as UserSessionState) : 'Unknown';
}

/**
 * ARM's userSessions `.id` path is
 * `.../hostPools/{hp}/sessionHosts/{sh}/userSessions/{id}` — sessionHostName
 * isn't a direct field on UserSession, so it's parsed out of the id here.
 */
function sessionHostNameFromUserSessionId(id: string | undefined): string {
  const match = id ? /\/sessionHosts\/([^/]+)\/userSessions\//i.exec(id) : null;
  return match ? match[1] : '';
}

/**
 * Extracts the short userSessionId (the final path segment, e.g. "2") from
 * the ARM resource id — this is the value ARM's userSessions.delete /
 * .sendMessage take as their own `userSessionId` parameter (see
 * forceLogoffSession/sendSessionMessage below), NOT the full `id`.
 */
function shortUserSessionId(id: string | undefined): string {
  if (!id) return '';
  const slashIndex = id.lastIndexOf('/');
  return slashIndex === -1 ? id : id.slice(slashIndex + 1);
}

function mapUserSession(armSession: ArmUserSession, hostPoolName: string): UserSession {
  return {
    id: armSession.id ?? '',
    sessionId: shortUserSessionId(armSession.id),
    userPrincipalName: armSession.userPrincipalName ?? armSession.activeDirectoryUserName ?? 'Unknown',
    sessionHostName: sessionHostNameFromUserSessionId(armSession.id),
    hostPoolName,
    sessionState: normalizeSessionState(armSession.sessionState),
    createTime: armSession.createTime?.toISOString() ?? new Date(0).toISOString(),
    applicationType: armSession.applicationType,
  };
}

/** Lists all user sessions across every session host in the given host pool. */
export async function listUserSessions(hostPoolName: string): Promise<UserSession[]> {
  const client = getClient();
  const { resourceGroups } = getConfig();
  const results: UserSession[] = [];

  for await (const armSession of client.userSessions.listByHostPool(resourceGroups.hostPools, hostPoolName)) {
    results.push(mapUserSession(armSession, hostPoolName));
  }

  return results;
}

/**
 * Forces a single user session to log off (AM-20/M2-S3) via ARM's
 * userSessions.delete with `force: true` — confirmed against Microsoft
 * Learn's UserSessionsDeleteOptionalParams reference
 * (https://learn.microsoft.com/javascript/api/@azure/arm-desktopvirtualization/usersessionsdeleteoptionalparams),
 * whose `force` property is documented as "Force flag to login off
 * userSession." Without `force`, ARM's delete only succeeds for a session
 * that is already logging off; `force: true` is what makes this an
 * operator-initiated forced logoff rather than a no-op against an active
 * session. Used by POST /v1/hostpools/{hp}/sessionhosts/{sh}/sessions/{id}/logoff
 * (app/api/src/functions/sessionForceLogoff.ts) and by the logoff-all-
 * disconnected batch endpoint (app/api/src/functions/sessionsLogoffDisconnected.ts),
 * both of which require at least the 'operator' role.
 */
export async function forceLogoffSession(hostPoolName: string, sessionHostName: string, sessionId: string): Promise<void> {
  const client = getClient();
  const { resourceGroups } = getConfig();

  await client.userSessions.delete(resourceGroups.hostPools, hostPoolName, sessionHostName, sessionId, { force: true });
}

/**
 * Sends a message to a single user session via ARM's userSessions.sendMessage.
 * The message payload is nested under `options.sendMessage` per the SDK's
 * UserSessionsSendMessageOptionalParams shape (confirmed against
 * https://learn.microsoft.com/javascript/api/@azure/arm-desktopvirtualization/usersessionssendmessageoptionalparams) —
 * NOT a positional body argument. Used by
 * POST /v1/hostpools/{hp}/sessionhosts/{sh}/sessions/{id}/message
 * (app/api/src/functions/sessionSendMessage.ts) and by the broadcast batch
 * endpoint (app/api/src/functions/sessionsBroadcast.ts), both of which
 * require at least the 'operator' role.
 */
export async function sendSessionMessage(hostPoolName: string, sessionHostName: string, sessionId: string, title: string | undefined, body: string): Promise<void> {
  const client = getClient();
  const { resourceGroups } = getConfig();

  await client.userSessions.sendMessage(resourceGroups.hostPools, hostPoolName, sessionHostName, sessionId, {
    sendMessage: { messageTitle: title, messageBody: body },
  });
}

function mapSchedulePeriod(time: ArmScalingSchedule['rampUpStartTime']): ScalingSchedulePeriod {
  return { hour: time?.hour ?? 0, minute: time?.minute ?? 0 };
}

/**
 * Maps an ARM schedule (either the parent scalingPlans resource's inline
 * `schedules[]` shape — ArmScalingSchedule — or the
 * scalingPlanPooledSchedules child-resource's ArmScalingPlanPooledSchedule,
 * both structurally identical on these fields) to the shared DTO.
 *
 * THROWS (peer review — AM-23) if ARM returns a schedule with no name: every
 * real schedule has one, and this app's day-coverage guard
 * (lib/scalingValidation.ts#computeUncoveredDays) and schedule-targeted
 * mutations (PATCH/DELETE .../schedules/{name}) both key off `name` being a
 * real, non-empty value — silently defaulting to '' here would let a
 * malformed/unexpected ARM response masquerade as a legitimately-nameless
 * schedule instead of surfacing as the 502 this really is.
 */
function mapSchedule(schedule: ArmScalingSchedule | ArmScalingPlanPooledSchedule): ScalingScheduleDetail {
  if (!schedule.name) {
    throw new Error('ARM returned a scaling plan schedule with no name.');
  }
  return {
    name: schedule.name,
    daysOfWeek: schedule.daysOfWeek ?? [],
    rampUpStartTime: mapSchedulePeriod(schedule.rampUpStartTime),
    rampUpLoadBalancingAlgorithm: schedule.rampUpLoadBalancingAlgorithm as ScalingScheduleDetail['rampUpLoadBalancingAlgorithm'],
    rampUpMinimumHostsPct: schedule.rampUpMinimumHostsPct,
    rampUpCapacityThresholdPct: schedule.rampUpCapacityThresholdPct,
    peakStartTime: mapSchedulePeriod(schedule.peakStartTime),
    peakLoadBalancingAlgorithm: schedule.peakLoadBalancingAlgorithm as ScalingScheduleDetail['peakLoadBalancingAlgorithm'],
    rampDownStartTime: mapSchedulePeriod(schedule.rampDownStartTime),
    rampDownLoadBalancingAlgorithm: schedule.rampDownLoadBalancingAlgorithm as ScalingScheduleDetail['rampDownLoadBalancingAlgorithm'],
    rampDownMinimumHostsPct: schedule.rampDownMinimumHostsPct,
    rampDownCapacityThresholdPct: schedule.rampDownCapacityThresholdPct,
    rampDownForceLogoffUsers: schedule.rampDownForceLogoffUsers,
    rampDownStopHostsWhen: schedule.rampDownStopHostsWhen as ScalingScheduleDetail['rampDownStopHostsWhen'],
    rampDownWaitTimeMinutes: schedule.rampDownWaitTimeMinutes,
    rampDownNotificationMessage: schedule.rampDownNotificationMessage,
    offPeakStartTime: mapSchedulePeriod(schedule.offPeakStartTime),
    offPeakLoadBalancingAlgorithm: schedule.offPeakLoadBalancingAlgorithm as ScalingScheduleDetail['offPeakLoadBalancingAlgorithm'],
  };
}

/**
 * Resolves whether a scaling plan is enabled for a specific host pool via
 * its hostPoolReferences (matched by ARM path, case-insensitively — ARM
 * resource IDs are case-insensitive for the resource group segment).
 * Defaults to true when hostPoolReferences isn't populated on the response
 * (listByHostPool by definition only returns plans associated with this
 * host pool, so association implies "applies here" even if the enabled
 * flag itself isn't echoed back).
 */
function isEnabledForHostPool(plan: ArmScalingPlan, hostPoolId: string): boolean {
  if (!plan.hostPoolReferences || plan.hostPoolReferences.length === 0) {
    return true;
  }
  const match = plan.hostPoolReferences.find((ref) => ref.hostPoolArmPath?.toLowerCase() === hostPoolId.toLowerCase());
  return match?.scalingPlanEnabled ?? true;
}

/**
 * Returns the scaling plan currently applied to the configured host pool
 * (HOSTPOOL_NAME), or null if none is associated. A host pool can only have
 * one scaling plan attached in the pooled-hostpool model this app targets,
 * so the first result from listByHostPool is authoritative.
 */
export async function getCurrentScalingPlan(): Promise<ScalingPlanDetail | null> {
  const client = getClient();
  const { resourceGroups, hostPoolName } = getConfig();

  const hostPool = await client.hostPools.get(resourceGroups.hostPools, hostPoolName);
  const hostPoolId = hostPool.id ?? '';

  for await (const armPlan of client.scalingPlans.listByHostPool(resourceGroups.hostPools, hostPoolName)) {
    return {
      id: armPlan.id ?? '',
      name: armPlan.name ?? '',
      hostPoolName,
      timeZone: armPlan.timeZone,
      enabled: isEnabledForHostPool(armPlan, hostPoolId),
      schedules: (armPlan.schedules ?? []).map(mapSchedule),
    };
  }

  return null;
}

/**
 * AM-23 (M3-S1): identifies the scaling plan currently associated with the
 * configured host pool (HOSTPOOL_NAME) — the scalingPlanName + resource
 * group the schedule-editor and emergency-override endpoints need to target
 * ARM's scalingPlans / scalingPlanPooledSchedules operation groups, plus the
 * host pool's own ARM resource id (hostPoolId) for matching against
 * hostPoolReferences[].hostPoolArmPath (see setScalingPlanHostPoolEnabled).
 * Mirrors getCurrentScalingPlan's own "first result from listByHostPool is
 * authoritative" reasoning — see that function's doc comment — but skips
 * mapping the full schedule list, since callers of this function only need
 * the plan's identity. Returns null if no scaling plan is associated (same
 * as getCurrentScalingPlan).
 */
export interface CurrentScalingPlanRef {
  scalingPlanName: string;
  /** Resource group the scaling plan ITSELF lives in — parsed from the plan's own ARM resource id, NOT assumed to equal the configured host-pools resource group (peer review — AM-23: a scaling plan can legitimately live in a different RG than the host pools it's assigned to). Every subsequent scalingPlanPooledSchedules/scalingPlans ARM call in this app uses THIS value, not getConfig().resourceGroups.hostPools. */
  resourceGroup: string;
  hostPoolId: string;
}

/**
 * Matches a `/subscriptions/{sub}/resourceGroups/{rg}/providers/...` ARM
 * resource id, case-insensitively, capturing the resource-group segment —
 * used to derive a resource's OWN resource group from its `id` rather than
 * assuming it matches some other, unrelated resource's configured RG. Same
 * "derive from the id, don't assume" posture as
 * computeService.ts#parseVmResourceId's subscriptionId capture.
 */
const RESOURCE_GROUP_FROM_ID_PATTERN = /\/resourceGroups\/([^/]+)\//i;

function parseResourceGroupFromId(resourceId: string | undefined): string | null {
  const match = resourceId ? RESOURCE_GROUP_FROM_ID_PATTERN.exec(resourceId) : null;
  return match ? match[1] : null;
}

/**
 * AM-23 (M3-S1): identifies the scaling plan currently associated with the
 * configured host pool (HOSTPOOL_NAME) — the scalingPlanName + the PLAN'S
 * OWN resource group (see CurrentScalingPlanRef's doc comment) the
 * schedule-editor and emergency-override endpoints need to target ARM's
 * scalingPlans / scalingPlanPooledSchedules operation groups, plus the host
 * pool's own ARM resource id (hostPoolId) for matching against
 * hostPoolReferences[].hostPoolArmPath (see setScalingPlanHostPoolEnabled).
 * Mirrors getCurrentScalingPlan's own "first result from listByHostPool is
 * authoritative" reasoning — see that function's doc comment — but skips
 * mapping the full schedule list, since callers of this function only need
 * the plan's identity. Returns null if no scaling plan is associated (same
 * as getCurrentScalingPlan).
 *
 * THROWS if ARM returns a plan with no name, or a resource id this app
 * cannot parse a resource group out of — both indicate a malformed/
 * unexpected ARM response this app cannot safely act on (see mapSchedule's
 * doc comment for the same "throw, don't silently default" reasoning).
 */
export async function resolveCurrentScalingPlanRef(): Promise<CurrentScalingPlanRef | null> {
  const client = getClient();
  const { resourceGroups, hostPoolName } = getConfig();

  const hostPool = await client.hostPools.get(resourceGroups.hostPools, hostPoolName);
  const hostPoolId = hostPool.id ?? '';

  for await (const armPlan of client.scalingPlans.listByHostPool(resourceGroups.hostPools, hostPoolName)) {
    if (!armPlan.name) {
      throw new Error('ARM returned a scaling plan with no name.');
    }
    const resourceGroup = parseResourceGroupFromId(armPlan.id);
    if (!resourceGroup) {
      throw new Error(`Could not parse a resource group from the scaling plan's own resource id ("${armPlan.id ?? 'undefined'}").`);
    }
    return { scalingPlanName: armPlan.name, resourceGroup, hostPoolId };
  }

  return null;
}

/**
 * Maps this app's ScalingSchedulePatchRequest/ScalingScheduleCreateRequest
 * (shared DTO, optional fields) onto the ARM SDK's
 * ScalingPlanPooledSchedulePatch shape, which is field-for-field identical —
 * a straight passthrough, not a semantic transform. Split out as its own
 * function purely so updateScalingSchedule/createScalingSchedule below don't
 * each repeat the same 15-field object literal.
 */
function toArmSchedulePatch(patch: ScalingSchedulePatchRequest | ScalingScheduleCreateRequest): ArmScalingPlanPooledSchedulePatch {
  return {
    // Cast: the SDK types daysOfWeek as the strict 7-value DayOfWeek union,
    // not the extensible `string[]` this app's own DTO uses — safe here
    // because validateDaysOfWeek (lib/scalingValidation.ts) has already
    // restricted every entry to that exact canonical set before this is
    // called.
    daysOfWeek: patch.daysOfWeek as ArmScalingPlanPooledSchedulePatch['daysOfWeek'],
    rampUpStartTime: patch.rampUpStartTime,
    rampUpLoadBalancingAlgorithm: patch.rampUpLoadBalancingAlgorithm,
    rampUpMinimumHostsPct: patch.rampUpMinimumHostsPct,
    rampUpCapacityThresholdPct: patch.rampUpCapacityThresholdPct,
    peakStartTime: patch.peakStartTime,
    peakLoadBalancingAlgorithm: patch.peakLoadBalancingAlgorithm,
    rampDownStartTime: patch.rampDownStartTime,
    rampDownLoadBalancingAlgorithm: patch.rampDownLoadBalancingAlgorithm,
    rampDownMinimumHostsPct: patch.rampDownMinimumHostsPct,
    rampDownCapacityThresholdPct: patch.rampDownCapacityThresholdPct,
    rampDownForceLogoffUsers: patch.rampDownForceLogoffUsers,
    rampDownStopHostsWhen: patch.rampDownStopHostsWhen,
    rampDownWaitTimeMinutes: patch.rampDownWaitTimeMinutes,
    rampDownNotificationMessage: patch.rampDownNotificationMessage,
    offPeakStartTime: patch.offPeakStartTime,
    offPeakLoadBalancingAlgorithm: patch.offPeakLoadBalancingAlgorithm,
  };
}

/**
 * Reads a single named schedule via ARM's scalingPlanPooledSchedules.get —
 * used by updateScalingSchedule/deleteScalingSchedule's callers to confirm
 * the schedule exists before/independent of a write (this function itself
 * is also used directly by a future read-detail need; today its only
 * caller is the PATCH handler's "does this schedule exist" 404 check —
 * see app/api/src/functions/scalingSchedule.ts).
 *
 * `resourceGroup` is the SCALING PLAN's own resource group (see
 * CurrentScalingPlanRef — resolveCurrentScalingPlanRef), not assumed to be
 * getConfig().resourceGroups.hostPools.
 */
export async function getScalingSchedule(resourceGroup: string, scalingPlanName: string, scheduleName: string): Promise<ScalingScheduleDetail> {
  const client = getClient();
  const armSchedule = await client.scalingPlanPooledSchedules.get(resourceGroup, scalingPlanName, scheduleName);
  return mapSchedule(armSchedule);
}

/**
 * Lists every schedule currently on the scaling plan — used by the
 * day-coverage guard (lib/scalingValidation.ts#computeUncoveredDays), which
 * must see ALL schedules, not just the one being edited/created/deleted, to
 * know whether a mutation would leave any day of the week with zero
 * coverage.
 */
export async function listScalingSchedules(resourceGroup: string, scalingPlanName: string): Promise<ScalingScheduleDetail[]> {
  const client = getClient();
  const results: ScalingScheduleDetail[] = [];
  for await (const armSchedule of client.scalingPlanPooledSchedules.list(resourceGroup, scalingPlanName)) {
    results.push(mapSchedule(armSchedule));
  }
  return results;
}

/**
 * Updates an EXISTING named schedule via ARM's
 * scalingPlanPooledSchedules.update — the child-resource API (confirmed
 * against Microsoft Learn: Microsoft.DesktopVirtualization/scalingPlans/
 * pooledSchedules is a real, separate ARM resource type with its own
 * read/write/delete RBAC actions — see infra/modules/scalingPlanOperatorRole.bicep's
 * header comment), NOT scalingPlans.update with an inline schedules[] array.
 * The child API only requires this app to send the fields actually
 * changing (a true partial PATCH, verified via the SDK's
 * ScalingPlanPooledSchedulesUpdateOptionalParams.scalingPlanSchedule being
 * itself a *Patch type) — the alternative (scalingPlans.update with a full
 * schedules[] array) would require re-sending every OTHER schedule
 * unchanged on every edit to avoid silently deleting them, since ARM PATCH
 * semantics replace an array property wholesale rather than merging it
 * element-by-element. Using the child resource sidesteps that risk entirely.
 */
export async function updateScalingSchedule(resourceGroup: string, scalingPlanName: string, scheduleName: string, patch: ScalingSchedulePatchRequest): Promise<ScalingScheduleDetail> {
  const client = getClient();
  const armSchedule = await client.scalingPlanPooledSchedules.update(resourceGroup, scalingPlanName, scheduleName, {
    scalingPlanSchedule: toArmSchedulePatch(patch),
  });
  return mapSchedule(armSchedule);
}

/**
 * Creates a NEW named schedule via ARM's scalingPlanPooledSchedules.create —
 * the mechanism this app uses to support per-day-of-week overrides (split an
 * existing schedule's daysOfWeek via updateScalingSchedule, then create one
 * or more additional schedules for the split-off days — see
 * ScalingScheduleCreateRequest's doc comment in @avdmgr/shared). Unlike
 * update, ARM's create call takes the full schedule body positionally (not
 * nested under an optionalParams property) — see the SDK's
 * ScalingPlanPooledSchedules.create signature.
 */
export async function createScalingSchedule(resourceGroup: string, scalingPlanName: string, scheduleName: string, schedule: ScalingScheduleCreateRequest): Promise<ScalingScheduleDetail> {
  const client = getClient();
  const armSchedule = await client.scalingPlanPooledSchedules.create(resourceGroup, scalingPlanName, scheduleName, toArmSchedulePatch(schedule));
  return mapSchedule(armSchedule);
}

/**
 * Removes a named schedule via ARM's scalingPlanPooledSchedules.delete — used
 * to undo a day-of-week split (see createScalingSchedule's doc comment) or
 * to remove a schedule an operator no longer wants. ARM's delete returns no
 * body (void) on success.
 */
export async function deleteScalingSchedule(resourceGroup: string, scalingPlanName: string, scheduleName: string): Promise<void> {
  const client = getClient();
  await client.scalingPlanPooledSchedules.delete(resourceGroup, scalingPlanName, scheduleName);
}

/**
 * AM-23 emergency override mechanism: enables/disables the scaling plan for
 * ONE specific host pool via ARM's scalingPlans.update with
 * hostPoolReferences[].scalingPlanEnabled — confirmed against Microsoft
 * Learn (ScalingHostPoolReference.scalingPlanEnabled: "Is the scaling plan
 * enabled for this hostpool" — https://learn.microsoft.com/javascript/api/@azure/arm-desktopvirtualization/scalinghostpoolreference)
 * as the documented way to detach/disable autoscale for a pool without
 * deleting the plan or its schedules. Setting scalingPlanEnabled: false stops
 * autoscale from powering hosts down (or up) for that pool — i.e. "keep all
 * hosts up" — while leaving every schedule/threshold configured exactly as
 * it was, so re-enabling (scalingPlanEnabled: true) restores normal autoscale
 * with no further input needed.
 *
 * Reads the CURRENT hostPoolReferences first (a single-element array in this
 * app's single-host-pool deployment, per SCALE-CONTOSO-PROD's own capture — see
 * The captured estate inventory — but written generically in
 * case that ever changes) and only flips the matching entry's
 * scalingPlanEnabled, preserving every other entry untouched — same
 * "read the whole array before a PATCH that replaces it wholesale" caution
 * as updateScalingSchedule's doc comment explains for `schedules[]`.
 *
 * Returns the resulting hostPoolReferences array as ARM echoes it back.
 */
/**
 * AM-14 (M6): reads the configured workspace's (config.workspaceName)
 * friendlyName via ARM's plain workspaces.get — GET
 * /v1/workspace/friendly-name (viewer+, see workspaceFriendlyName.ts).
 * Undefined when ARM reports no friendlyName set (a valid, unconfigured
 * state — ARM's own property is optional), NOT when the workspace itself is
 * missing (that propagates as a real error — this app's own config always
 * names an existing workspace, so a 404 here would indicate a
 * misconfiguration worth surfacing loudly, not a normal "not set" case).
 */
export async function getWorkspaceFriendlyName(): Promise<string | undefined> {
  const client = getClient();
  const { resourceGroups, workspaceName } = getConfig();
  const workspace = await client.workspaces.get(resourceGroups.hostPools, workspaceName);
  return workspace.friendlyName;
}

/**
 * AM-14 (M6): updates ONLY the configured workspace's friendlyName via
 * ARM's workspaces.update — PATCH /v1/workspace/friendly-name (operator+,
 * see workspaceFriendlyName.ts). The SDK's WorkspacesUpdateOptionalParams
 * takes a `workspace: WorkspacePatch` whose OTHER fields (tags, description,
 * applicationGroupReferences, publicNetworkAccess) are all optional and
 * simply omitted here (verified against the installed
 * @azure/arm-desktopvirtualization SDK's WorkspacePatch type) — same
 * "send only the fields actually changing" merge-patch pattern
 * setSessionHostDrain above already relies on for sessionHosts.update, so
 * this call cannot accidentally clear applicationGroupReferences or any
 * other workspace property.
 */
export async function updateWorkspaceFriendlyName(friendlyName: string): Promise<string | undefined> {
  const client = getClient();
  const { resourceGroups, workspaceName } = getConfig();
  const workspace = await client.workspaces.update(resourceGroups.hostPools, workspaceName, { workspace: { friendlyName } });
  return workspace.friendlyName;
}

export async function setScalingPlanHostPoolEnabled(resourceGroup: string, scalingPlanName: string, hostPoolId: string, enabled: boolean): Promise<ArmScalingHostPoolReference[]> {
  const client = getClient();

  const armPlan = await client.scalingPlans.get(resourceGroup, scalingPlanName);
  const existingRefs = armPlan.hostPoolReferences ?? [];
  const isTarget = (ref: ArmScalingHostPoolReference) => ref.hostPoolArmPath?.toLowerCase() === hostPoolId.toLowerCase();

  const updatedRefs: ArmScalingHostPoolReference[] = existingRefs.map((ref) => (isTarget(ref) ? { ...ref, scalingPlanEnabled: enabled } : ref));
  if (!updatedRefs.some(isTarget)) {
    // Defensive only — resolveCurrentScalingPlanRef only returns a plan
    // already associated with this host pool (listByHostPool), so the
    // matching reference should always be present. If it somehow isn't,
    // add it explicitly rather than silently leaving the override a no-op.
    updatedRefs.push({ hostPoolArmPath: hostPoolId, scalingPlanEnabled: enabled });
  }

  const updated = await client.scalingPlans.update(resourceGroup, scalingPlanName, {
    scalingPlan: { hostPoolReferences: updatedRefs },
  });
  return updated.hostPoolReferences ?? updatedRefs;
}
