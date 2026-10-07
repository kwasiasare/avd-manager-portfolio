import { randomUUID } from 'node:crypto';
import type { GraphDegradationReason, IntunePolicyHealthEvidence, IntunePolicyHealthHost, IntunePolicyHealthResponse, IntunePolicyHealthStatus } from '@avdmgr/shared';
import { graphListAll, isGraphForbidden } from '../lib/graphRest';

/*
 * AM-52 — per-host Intune policy-health panel (65000/missing-ADMX
 * detection). See @avdmgr/shared's IntunePolicyHealthResponse header comment
 * for the motivating incident and the signature this exists to catch.
 *
 * TWO SEPARATE GRAPH CALLS, TWO SEPARATE PERMISSIONS, TWO SEPARATE PHASES —
 * each phase's failure mode is handled differently on purpose:
 *
 *   PHASE 1 — resolveManagedDevices(): resolves every host name to its
 *   Intune managedDevice(s) via GET /deviceManagement/managedDevices?
 *   $filter=deviceName eq '<host>' (chunked — see DEVICE_RESOLUTION_CHUNK_SIZE
 *   — to keep each $filter URL a reasonable length rather than one clause
 *   per host). VERIFIED on Microsoft Learn ("List managedDevices",
 *   https://learn.microsoft.com/graph/api/intune-devices-manageddevice-list?view=graph-rest-1.0):
 *   v1.0, application permission DeviceManagementManagedDevices.Read.All
 *   (app role id 2f51be20-0bb4-4fed-bf7b-db946066c75e — Microsoft Learn's
 *   permissions reference), supports $filter/$select. A 403 or a network
 *   error HERE is treated as a single, TENANT-WIDE condition — not a
 *   per-host one: this is one shared call (or a small handful of chunked
 *   calls covering every host at once), so if it fails, NOTHING about ANY
 *   host's device can be resolved. The whole response degrades
 *   ('graph-permission-not-granted' / 'graph-error'), every host reports
 *   'unknown' — never a fabricated per-host verdict on data that was never
 *   fetched.
 *
 *   PHASE 2 — classifyHosts(): for each host that resolved to a device, GETs
 *   that device's per-profile, per-setting state — GET
 *   /deviceManagement/managedDevices/{id}/deviceConfigurationStates.
 *   VERIFIED on Microsoft Learn: v1.0 (the v1.0 Microsoft.Graph.DeviceManagement
 *   PowerShell module's Get-MgDeviceManagementManagedDeviceConfigurationState
 *   maps 1:1 to this REST path; Get-MgBetaDeviceManagementManagedDeviceConfigurationState
 *   is a SEPARATE beta cmdlet, confirming the v1.0/beta split is real, not
 *   v1.0-absent), application permission DeviceManagementConfiguration.Read.All
 *   (app role id dc377aa6-52d8-4e23-b271-2a7ae04cedf3). Each profile's
 *   `settingStates` (deviceConfigurationSettingState — confirmed v1.0
 *   resource, https://learn.microsoft.com/graph/api/resources/intune-deviceconfig-deviceconfigurationsettingstate?view=graph-rest-1.0)
 *   carries a per-setting `setting` identifier (the OMA-URI/definition
 *   string an ADMX-backed Settings Catalog setting is reported under — this
 *   is where `FSLogixv1~Policy~...` appears) and `errorCode` (Int64 — this
 *   is where 65000 appears). THIS IS ADEQUATE FOR THE FULL SIGNATURE AT
 *   v1.0 — the design's own decision rule reserved a beta fallback only if
 *   v1.0 couldn't give per-setting URIs cleanly; it can, so no beta endpoint
 *   is used anywhere in this file.
 *
 *   THIS PHASE runs with PER-HOST ISOLATION (a small worker pool, mirroring
 *   accessService.ts#resolveAllPrincipals's shape): a 403 here means the
 *   SECOND permission is missing tenant-wide, so the first 403 observed
 *   stops assigning new work and every host from that point on (plus any
 *   still in flight) reports 'unknown' with the SAME
 *   'graph-permission-not-granted' degradation phase 1 uses. Any OTHER
 *   per-host error (a single device's call erroring — network blip,
 *   unexpected shape) degrades ONLY that host to 'unknown' (with a
 *   server-side-logged correlationId), WITHOUT setting the envelope-level
 *   `degradation` at all — every other host's real classification still
 *   reaches the caller. This is the literal implementation of "never let
 *   one host's Graph failure poison the batch."
 *
 * CACHING: mirrors governanceService.ts's full/degraded TTL split + in-flight
 * dedupe (see that file's header comment for the full rationale) — this
 * feature fans out 1 (chunked) + up to N Graph calls per computation, so a
 * ~10min cache is what keeps "load the Hosts page" from meaning "re-run a
 * Graph call per host on every page view." A response with ANY degradation
 * (envelope-level OR any individual host still 'unknown') gets the shorter
 * DEGRADED_CACHE_TTL_MS, same "recheck sooner, an operator may be actively
 * fixing this" posture as governanceService.ts's own degraded-TTL rule.
 * Cache is keyed by the (sorted, lower-cased) host-name set, not a single
 * global slot — a session-host add/remove between polls must not serve a
 * stale set of hosts.
 */

const FULL_CACHE_TTL_MS = 10 * 60 * 1000;
const DEGRADED_CACHE_TTL_MS = 60 * 1000;

/** Keeps each chunked $filter=deviceName eq '...' or ... URL a reasonable length rather than one clause per host in a single request. */
const DEVICE_RESOLUTION_CHUNK_SIZE = 15;
/** Bounds how many chunked device-resolution calls run in flight at once — same fan-out-bounding rationale as accessService.ts#RESOLVE_CONCURRENCY_LIMIT. */
const DEVICE_RESOLUTION_CONCURRENCY = 3;
/** Bounds how many per-device deviceConfigurationStates calls run in flight at once. */
const CONFIG_STATE_CONCURRENCY = 5;
/** Caps the fsLogixErrorSettings evidence list — an operator needs to see there's a problem and roughly which settings, not an exhaustive dump. */
const MAX_FSLOGIX_ERROR_SETTINGS = 10;

/** errorCode 65000 on a FSLogixv1~Policy~ setting — the exact, live-verified signature from the FSLogix storage runbook §5.1. */
const FSLOGIX_ADMX_ERROR_CODE = 65000;
/** Case-insensitive substring match against a setting's identifier — Windows MDM diagnostic logs render the vendor-supplied ADMX namespace as `FSLogixv1~Policy~...`; Graph's own `setting`/`instanceDisplayName` values are matched case-insensitively here since this app has not observed whether Graph normalizes the case Intune's ADMX ingestion assigned it. */
const FSLOGIX_SETTING_SIGNATURE = 'fslogixv1~policy~';

/**
 * Grant instructions shared verbatim(-ish) with docs/app-registration.md
 * §9's new Intune permission rows — same "one source of truth" convention as
 * governance/conditionalAccessBreakGlass.ts's GRAPH_GRANT_INSTRUCTIONS.
 * Covers BOTH permissions this feature needs in one script, since an
 * operator granting one for this feature needs the other too.
 */
export const INTUNE_GRAPH_GRANT_INSTRUCTIONS = [
  '# Requires an Entra role with app-role-assignment rights (Privileged Role Administrator / Cloud Application Administrator), run once per environment:',
  'FUNC_MI_OBJECT_ID=$(az functionapp identity show --name <functionAppName> --resource-group RG-AVD-Management --query principalId -o tsv)',
  'GRAPH_SP_OBJECT_ID=$(az ad sp show --id 00000003-0000-0000-c000-000000000000 --query id -o tsv)',
  '',
  "# DeviceManagementManagedDevices.Read.All — resolves each session host to its Intune managed device.",
  'az rest --method POST \\',
  '  --url "https://graph.microsoft.com/v1.0/servicePrincipals/$GRAPH_SP_OBJECT_ID/appRoleAssignedTo" \\',
  '  --headers "Content-Type=application/json" \\',
  '  --body "{\\"principalId\\": \\"$FUNC_MI_OBJECT_ID\\", \\"resourceId\\": \\"$GRAPH_SP_OBJECT_ID\\", \\"appRoleId\\": \\"2f51be20-0bb4-4fed-bf7b-db946066c75e\\"}"',
  '',
  "# DeviceManagementConfiguration.Read.All — reads each device's per-setting configuration-profile state (the 65000/FSLogixv1~ signature).",
  'az rest --method POST \\',
  '  --url "https://graph.microsoft.com/v1.0/servicePrincipals/$GRAPH_SP_OBJECT_ID/appRoleAssignedTo" \\',
  '  --headers "Content-Type=application/json" \\',
  '  --body "{\\"principalId\\": \\"$FUNC_MI_OBJECT_ID\\", \\"resourceId\\": \\"$GRAPH_SP_OBJECT_ID\\", \\"appRoleId\\": \\"dc377aa6-52d8-4e23-b271-2a7ae04cedf3\\"}"',
] as const;

/** Cites the FSLogix storage runbook §5.1's live-verified fix, verbatim-ish. */
const ADMX_REMEDIATION =
  "Intune's one-shot third-party ADMX ingestion batch failed at enrollment (event 0x86000009) and Intune never retried it. Fix: make a trivial edit to this device's Settings Catalog FSLogix profile and Save — this re-versions the policy and forces Intune to re-send the full ADMX batch on the device's next sync (see the FSLogix storage runbook §5.1). Then trigger (or wait for) a device sync; the very first sync after the edit has healed every host observed so far.";

interface GraphManagedDevice {
  id?: string;
  deviceName?: string;
  lastSyncDateTime?: string;
}

interface GraphDeviceConfigurationSettingState {
  setting?: string;
  settingName?: string;
  instanceDisplayName?: string;
  /** complianceStatus: 'unknown'|'notApplicable'|'compliant'|'remediated'|'nonCompliant'|'error'|'conflict'|'notAssigned'. */
  state?: string;
  errorCode?: number;
}

interface GraphDeviceConfigurationState {
  displayName?: string;
  state?: string;
  settingStates?: GraphDeviceConfigurationSettingState[];
}

/** OData `$filter` string-literal escape (the doubled-single-quote OData itself defines) — same purpose as accessService.ts's own escapeODataLiteral, duplicated here rather than shared since it's a two-line pure function and this file otherwise has no dependency on accessService.ts. */
function escapeODataLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

type Phase1Outcome =
  | { kind: 'ok'; devicesByHost: Map<string, GraphManagedDevice[]>; truncated: boolean }
  | { kind: 'forbidden' }
  | { kind: 'error'; correlationId: string };

/**
 * Phase 1 — see this file's header comment. Chunks hostNames into
 * DEVICE_RESOLUTION_CHUNK_SIZE-sized `$filter` groups, running
 * DEVICE_RESOLUTION_CONCURRENCY of them at once. The FIRST 403 observed
 * stops assigning new chunk work (mirrors accessService.ts#resolveAllPrincipals's
 * `forbidden` short-circuit); the first non-403 error does the same for
 * `firstError` — either way this is a single tenant-wide outcome, not
 * per-host (see header comment for why).
 */
async function resolveManagedDevices(hostNames: string[], logger: { error: (message: string, error?: unknown) => void }): Promise<Phase1Outcome> {
  const chunks = chunk(hostNames, DEVICE_RESOLUTION_CHUNK_SIZE);
  const devicesByHost = new Map<string, GraphManagedDevice[]>();
  let truncated = false;
  let forbidden = false;
  let firstError: unknown;
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < chunks.length) {
      if (forbidden || firstError !== undefined) return;
      const group = chunks[nextIndex++];
      const filter = group.map((name) => `deviceName eq '${escapeODataLiteral(name)}'`).join(' or ');
      try {
        const { items, truncated: chunkTruncated } = await graphListAll<GraphManagedDevice>(
          `/deviceManagement/managedDevices?$filter=${encodeURIComponent(filter)}&$select=id,deviceName,lastSyncDateTime`,
        );
        if (chunkTruncated) truncated = true;
        for (const device of items) {
          if (!device.deviceName) continue;
          const key = device.deviceName.toLowerCase();
          const existing = devicesByHost.get(key);
          if (existing) {
            existing.push(device);
          } else {
            devicesByHost.set(key, [device]);
          }
        }
      } catch (error) {
        if (isGraphForbidden(error)) {
          forbidden = true;
        } else if (firstError === undefined) {
          firstError = error;
        }
      }
    }
  }

  const workerCount = Math.min(DEVICE_RESOLUTION_CONCURRENCY, chunks.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  if (forbidden) {
    return { kind: 'forbidden' };
  }
  if (firstError !== undefined) {
    const correlationId = randomUUID();
    logger.error(`intune policy health: device resolution failed | correlationId=${correlationId}`, firstError);
    return { kind: 'error', correlationId };
  }
  return { kind: 'ok', devicesByHost, truncated };
}

/** Picks the device with the newest lastSyncDateTime when more than one Intune managed device matches a host name (see this file's header comment on stale duplicate device records) — a device with no lastSyncDateTime at all sorts last. */
function pickNewestDevice(devices: GraphManagedDevice[]): { device: GraphManagedDevice; duplicateDeviceRecords: boolean } {
  if (devices.length === 1) {
    return { device: devices[0], duplicateDeviceRecords: false };
  }
  const sorted = [...devices].sort((a, b) => {
    const aTime = a.lastSyncDateTime ? Date.parse(a.lastSyncDateTime) : -Infinity;
    const bTime = b.lastSyncDateTime ? Date.parse(b.lastSyncDateTime) : -Infinity;
    return bTime - aTime;
  });
  return { device: sorted[0], duplicateDeviceRecords: true };
}

function settingIdentifier(setting: GraphDeviceConfigurationSettingState): string {
  return setting.setting ?? setting.instanceDisplayName ?? setting.settingName ?? 'Unknown setting';
}

function isFsLogixAdmxSetting(setting: GraphDeviceConfigurationSettingState): boolean {
  return settingIdentifier(setting).toLowerCase().includes(FSLOGIX_SETTING_SIGNATURE);
}

function isSettingInError(setting: GraphDeviceConfigurationSettingState): boolean {
  return (setting.errorCode !== undefined && setting.errorCode !== 0) || setting.state === 'error' || setting.state === 'conflict';
}

interface ClassificationResult {
  status: Extract<IntunePolicyHealthStatus, 'ok' | 'policy-errors' | 'missing-admx'>;
  errorSettingCount: number;
  fsLogixErrorSettings: string[];
  admxSignatureDetectable: boolean;
}

/**
 * Pure classification from an already-fetched deviceConfigurationStates
 * response — the fixture-driven unit-test surface for this feature (see
 * intunePolicyHealthService.test.ts). Exported for that purpose only, same
 * "pure evaluate function, unit-tested against fixtures" convention as every
 * governance/*.ts check's evaluateXxx.
 *
 * `admxSignatureDetectable` is true the moment ANY profile in the response
 * carries a `settingStates` array (even an empty one) — that is the
 * structural signal that this device's response has per-setting
 * granularity to search. A device with ZERO reported profiles is trivially
 * `admxSignatureDetectable: true` too (there is nothing to have missed).
 * Only a device whose EVERY profile lacks `settingStates` entirely (a
 * shape this endpoint's documented contract doesn't predict, but this app
 * refuses to assume away) falls back to the coarser profile-level `state`
 * check and reports `admxSignatureDetectable: false` — see this function's
 * own DECISION RULE in @avdmgr/shared's IntunePolicyHealthEvidence doc
 * comment.
 */
export function classifyConfigurationStates(profiles: GraphDeviceConfigurationState[]): ClassificationResult {
  let admxSignatureDetectable = profiles.length === 0;
  let errorSettingCount = 0;
  let hasError = false;
  const fsLogixErrorSettings: string[] = [];

  for (const profile of profiles) {
    if (Array.isArray(profile.settingStates)) {
      admxSignatureDetectable = true;
      for (const setting of profile.settingStates) {
        if (!isSettingInError(setting)) continue;
        hasError = true;
        errorSettingCount += 1;
        if (setting.errorCode === FSLOGIX_ADMX_ERROR_CODE && isFsLogixAdmxSetting(setting)) {
          fsLogixErrorSettings.push(settingIdentifier(setting));
        }
      }
    } else if (profile.state === 'error' || profile.state === 'conflict') {
      hasError = true;
      errorSettingCount += 1;
    }
  }

  if (fsLogixErrorSettings.length > 0) {
    return { status: 'missing-admx', errorSettingCount, fsLogixErrorSettings: fsLogixErrorSettings.slice(0, MAX_FSLOGIX_ERROR_SETTINGS), admxSignatureDetectable };
  }
  if (hasError) {
    return { status: 'policy-errors', errorSettingCount, fsLogixErrorSettings: [], admxSignatureDetectable };
  }
  return { status: 'ok', errorSettingCount: 0, fsLogixErrorSettings: [], admxSignatureDetectable };
}

interface HostResolution {
  hostName: string;
  deviceId?: string;
  lastSyncDateTime?: string;
  duplicateDeviceRecords: boolean;
}

interface ClassifyHostsResult {
  hosts: IntunePolicyHealthHost[];
  degradation?: GraphDegradationReason;
  truncated: boolean;
}

/**
 * Phase 2 — see this file's header comment. Per-host isolation via a small
 * worker pool (mirrors accessService.ts#resolveAllPrincipals): the FIRST
 * 403 observed stops assigning new per-device work (every host from that
 * point on, including ones already claimed by another worker mid-flight,
 * reports 'unknown' with `graph-permission-not-granted`); any OTHER
 * per-host error degrades ONLY that host, with the raw error logged
 * server-side under a fresh correlationId and NO envelope-level
 * degradation set.
 */
async function classifyHosts(
  resolutions: HostResolution[],
  logger: { error: (message: string, error?: unknown) => void },
): Promise<ClassifyHostsResult> {
  const results: IntunePolicyHealthHost[] = new Array(resolutions.length);
  let forbidden = false;
  let truncated = false;
  let nextIndex = 0;

  function unresolvedEvidence(resolution: HostResolution, extra: Partial<IntunePolicyHealthEvidence> = {}): IntunePolicyHealthEvidence {
    return {
      deviceId: resolution.deviceId,
      lastSyncDateTime: resolution.lastSyncDateTime,
      duplicateDeviceRecords: resolution.duplicateDeviceRecords || undefined,
      admxSignatureDetectable: false,
      ...extra,
    };
  }

  async function worker(): Promise<void> {
    while (nextIndex < resolutions.length) {
      const i = nextIndex++;
      const resolution = resolutions[i];

      if (!resolution.deviceId) {
        results[i] = { hostName: resolution.hostName, status: 'not-enrolled', evidence: unresolvedEvidence(resolution) };
        continue;
      }

      if (forbidden) {
        results[i] = { hostName: resolution.hostName, status: 'unknown', evidence: unresolvedEvidence(resolution) };
        continue;
      }

      try {
        const { items: profiles, truncated: deviceTruncated } = await graphListAll<GraphDeviceConfigurationState>(
          `/deviceManagement/managedDevices/${encodeURIComponent(resolution.deviceId)}/deviceConfigurationStates`,
        );
        if (deviceTruncated) truncated = true;
        const classification = classifyConfigurationStates(profiles);
        results[i] = {
          hostName: resolution.hostName,
          status: classification.status,
          evidence: {
            deviceId: resolution.deviceId,
            lastSyncDateTime: resolution.lastSyncDateTime,
            errorSettingCount: classification.errorSettingCount,
            fsLogixErrorSettings: classification.fsLogixErrorSettings.length > 0 ? classification.fsLogixErrorSettings : undefined,
            duplicateDeviceRecords: resolution.duplicateDeviceRecords || undefined,
            admxSignatureDetectable: classification.admxSignatureDetectable,
          },
          remediation: classification.status === 'missing-admx' ? ADMX_REMEDIATION : undefined,
        };
      } catch (error) {
        if (isGraphForbidden(error)) {
          forbidden = true;
          results[i] = { hostName: resolution.hostName, status: 'unknown', evidence: unresolvedEvidence(resolution) };
        } else {
          const correlationId = randomUUID();
          logger.error(`intune policy health: config-state lookup failed for one host | hostName=${resolution.hostName} correlationId=${correlationId}`, error);
          results[i] = { hostName: resolution.hostName, status: 'unknown', evidence: unresolvedEvidence(resolution, { correlationId }) };
        }
      }
    }
  }

  const workerCount = Math.min(CONFIG_STATE_CONCURRENCY, resolutions.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  return { hosts: results, degradation: forbidden ? 'graph-permission-not-granted' : undefined, truncated };
}

export interface IntunePolicyHealthLogger {
  warn: (message: string) => void;
  log: (message: string) => void;
  error: (message: string, error?: unknown) => void;
}

/** Composes phase 1 + phase 2 into one response — the impure "fetch everything" half; getIntunePolicyHealth below adds caching on top. Exported for direct unit testing of the composition (mocking graphListAll) alongside classifyConfigurationStates's pure unit tests. */
export async function computeIntunePolicyHealth(hostNames: string[], logger: IntunePolicyHealthLogger): Promise<IntunePolicyHealthResponse> {
  const generatedAt = new Date().toISOString();
  const phase1 = await resolveManagedDevices(hostNames, logger);

  if (phase1.kind === 'forbidden') {
    return {
      hosts: hostNames.map((hostName) => ({ hostName, status: 'unknown', evidence: { admxSignatureDetectable: false } })),
      degradation: 'graph-permission-not-granted',
      grantInstructions: INTUNE_GRAPH_GRANT_INSTRUCTIONS,
      generatedAt,
      cached: false,
    };
  }
  if (phase1.kind === 'error') {
    return {
      hosts: hostNames.map((hostName) => ({ hostName, status: 'unknown', evidence: { admxSignatureDetectable: false, correlationId: phase1.correlationId } })),
      degradation: 'graph-error',
      generatedAt,
      cached: false,
    };
  }

  const resolutions: HostResolution[] = hostNames.map((hostName) => {
    const devices = phase1.devicesByHost.get(hostName.toLowerCase()) ?? [];
    if (devices.length === 0) {
      return { hostName, duplicateDeviceRecords: false };
    }
    const { device, duplicateDeviceRecords } = pickNewestDevice(devices);
    return { hostName, deviceId: device.id, lastSyncDateTime: device.lastSyncDateTime, duplicateDeviceRecords };
  });

  const { hosts, degradation, truncated: phase2Truncated } = await classifyHosts(resolutions, logger);

  return {
    hosts,
    degradation,
    grantInstructions: degradation === 'graph-permission-not-granted' ? INTUNE_GRAPH_GRANT_INSTRUCTIONS : undefined,
    truncated: phase1.truncated || phase2Truncated || undefined,
    generatedAt,
    cached: false,
  };
}

function isDegraded(response: IntunePolicyHealthResponse): boolean {
  return response.degradation !== undefined || response.hosts.some((host) => host.status === 'unknown');
}

interface CacheEntry {
  key: string;
  value: IntunePolicyHealthResponse;
  expiresAt: number;
}

let cachedEntry: CacheEntry | undefined;
let inFlightRequest: { key: string; promise: Promise<IntunePolicyHealthResponse> } | undefined;

/** Sorted, lower-cased host-name set — see this file's header comment on why the cache is keyed rather than a single global slot. */
function cacheKey(hostNames: string[]): string {
  return [...hostNames].map((name) => name.toLowerCase()).sort().join(',');
}

async function runAndCache(hostNames: string[], key: string, logger: IntunePolicyHealthLogger): Promise<IntunePolicyHealthResponse> {
  const startedAt = Date.now();
  const result = await computeIntunePolicyHealth(hostNames, logger);
  const degraded = isDegraded(result);
  logger.log(`Intune policy health computed in ${Date.now() - startedAt}ms across ${hostNames.length} host(s) (degraded=${degraded})`);
  cachedEntry = { key, value: result, expiresAt: Date.now() + (degraded ? DEGRADED_CACHE_TTL_MS : FULL_CACHE_TTL_MS) };
  return result;
}

export interface GetIntunePolicyHealthOptions {
  warn?: (message: string) => void;
  log?: (message: string) => void;
  error?: (message: string, error?: unknown) => void;
}

/**
 * GET /v1/hostpools/{hostPoolName}/policy-health's cache/orchestration
 * layer — mirrors governanceService.ts#getGovernanceSummary's full/degraded
 * TTL + in-flight-promise-dedupe shape (see this file's header comment).
 * `hostNames` should be the CURRENT session-host list's names — a changed
 * set (host added/removed) simply misses this cache (different key) rather
 * than serving stale data for the wrong host set.
 */
export async function getIntunePolicyHealth(hostNames: string[], options: GetIntunePolicyHealthOptions = {}): Promise<IntunePolicyHealthResponse> {
  const { warn = () => {}, log = () => {}, error = () => {} } = options;
  const key = cacheKey(hostNames);

  if (cachedEntry && cachedEntry.key === key && cachedEntry.expiresAt > Date.now()) {
    return { ...cachedEntry.value, cached: true };
  }
  if (inFlightRequest && inFlightRequest.key === key) {
    const result = await inFlightRequest.promise;
    return { ...result, cached: true };
  }

  const promise = (async () => {
    try {
      return await runAndCache(hostNames, key, { warn, log, error });
    } finally {
      if (inFlightRequest?.key === key) {
        inFlightRequest = undefined;
      }
    }
  })();

  inFlightRequest = { key, promise };
  return promise;
}

/** Test-only: clears the module-level cache/in-flight state so tests don't leak across cases — same convention as governanceService.ts's _resetGovernanceSummaryCacheForTests. */
export function _resetIntunePolicyHealthCacheForTests(): void {
  cachedEntry = undefined;
  inFlightRequest = undefined;
}
