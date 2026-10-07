import type { GalleryImageVersion } from '@azure/arm-compute';
import type { ImageVersionCurrent, ImageVersionsResponse, ImageVersionTimelineEntry, SessionHostImageCorrelation } from '@avdmgr/shared';
import { getConfig } from '../lib/config';
import { getComputeClient } from '../lib/computeClient';
import { daysBetween } from '../lib/dateMath';
import { mapWithConcurrency } from '../lib/concurrency';
import { getVmImageReference, parseVmResourceId, type VmImageReferenceInfo } from './computeService';
import { listSessionHostVmRefs } from './avdService';

function mapImageVersion(armVersion: GalleryImageVersion, imageDefinitionName: string): Omit<ImageVersionCurrent, 'ageDays' | 'eolDate' | 'daysUntilEol'> {
  return {
    id: armVersion.id ?? '',
    name: armVersion.name ?? '',
    imageDefinitionName,
    publishedDate: armVersion.publishingProfile?.publishedDate?.toISOString(),
    excludeFromLatest: armVersion.publishingProfile?.excludeFromLatest ?? false,
    replicaCount: armVersion.publishingProfile?.replicaCount,
    targetRegions: armVersion.publishingProfile?.targetRegions?.map((region) => region.name).filter((name): name is string => !!name),
    provisioningState: armVersion.provisioningState,
  };
}

/**
 * "Latest" mirrors the AVD/SIG platform's own definition of latest: the
 * most recently published version that is NOT excludeFromLatest=true (a
 * version can be published but intentionally hidden from "latest" while
 * it's still being validated). Ties (identical publishedDate, shouldn't
 * normally happen) fall back to a string compare of the version name.
 *
 * FALLBACK EDGE CASE (AM-26 peer review item 8): if EVERY version is
 * excludeFromLatest:true (a fully-excluded definition — shouldn't normally
 * happen, but is not impossible), `eligible` is empty and this falls back
 * to picking from ALL versions instead of returning nothing — a "current"
 * version is still surfaced (better than the Dashboard/Images page showing
 * no current version at all), but the result is, strictly, a version the
 * AVD/SIG platform itself would NOT consider "latest" for provisioning
 * purposes. Callers must not present this case identically to a normal
 * pick — see buildVersionTimeline's isCurrent doc comment and the Images
 * page's "Current" badge, which annotates this fallback explicitly (a
 * version with isCurrent && excludeFromLatest can only arise via this
 * branch).
 */
function pickLatest(versions: GalleryImageVersion[]): GalleryImageVersion | undefined {
  const eligible = versions.filter((v) => v.publishingProfile?.excludeFromLatest !== true);
  const pool = eligible.length > 0 ? eligible : versions;

  return pool.reduce<GalleryImageVersion | undefined>((latest, candidate) => {
    if (!latest) return candidate;
    const latestDate = latest.publishingProfile?.publishedDate?.getTime() ?? 0;
    const candidateDate = candidate.publishingProfile?.publishedDate?.getTime() ?? 0;
    if (candidateDate !== latestDate) {
      return candidateDate > latestDate ? candidate : latest;
    }
    return (candidate.name ?? '') > (latest.name ?? '') ? candidate : latest;
  }, undefined);
}

/**
 * Resolves the latest published version of the configured gallery image
 * definition, plus derived age/EOL fields for the Dashboard's image version
 * badge. Returns null if the definition has no versions at all (e.g. a
 * newly-created, unpublished definition).
 */
export async function getCurrentImageVersion(): Promise<ImageVersionCurrent | null> {
  const client = getComputeClient();
  const { resourceGroups, galleryName, imageDefinitionName, imageEolDate } = getConfig();

  const versions: GalleryImageVersion[] = [];
  for await (const version of client.galleryImageVersions.listByGalleryImage(resourceGroups.images, galleryName, imageDefinitionName)) {
    versions.push(version);
  }

  const latest = pickLatest(versions);
  if (!latest) {
    return null;
  }

  const mapped = mapImageVersion(latest, imageDefinitionName);
  const now = new Date();
  const publishedDate = latest.publishingProfile?.publishedDate;
  const ageDays = publishedDate ? daysBetween(publishedDate, now) : undefined;

  // Prefer the SDK/ARM's own endOfLifeDate on the version's publishingProfile
  // (a real field the platform tracks for decommissioning purposes) over the
  // IMAGE_EOL_DATE config fallback — the estate's current version
  // (ACG_AVD_CONTOSO/WIN11-ENT-MS-M365/2.0.0) has this field populated
  // (2028-02-13, matching IMAGE_EOL_DATE's current fallback value), so the
  // fallback should rarely if ever actually be used in practice; it exists
  // for a version where the field was never set.
  const eolDateSource = latest.publishingProfile?.endOfLifeDate;
  const eolDate = eolDateSource ? eolDateSource.toISOString().slice(0, 10) : imageEolDate;
  const daysUntilEol = eolDate ? daysBetween(now, new Date(`${eolDate}T00:00:00Z`)) : undefined;

  return {
    ...mapped,
    ageDays,
    eolDate,
    daysUntilEol,
  };
}

// ---------------------------------------------------------------------------
// AM-26 (M4-S1): full version timeline + snapshot-adjacent host correlation.
// ---------------------------------------------------------------------------

/**
 * Builds the full, newest-first version timeline for GET /v1/images/versions
 * — every version of the configured image definition, not just "latest"
 * (see getCurrentImageVersion above for that single-version read). Kept
 * separate from hostCount (see attachHostCounts) so this stays a pure,
 * synchronous function testable without any ARM/host data — hostCount
 * depends on an async host listing + VM read per host, which the caller
 * (getImageVersionsReport) layers on afterward.
 *
 * "Newest-first": sorted by publishedDate descending; a version with no
 * publishedDate (shouldn't normally happen — ARM populates it once a
 * version finishes provisioning) sorts to the end rather than the start,
 * so an in-progress/unpublished version doesn't masquerade as "newest".
 * Ties (identical publishedDate, or both missing) fall back to a
 * descending string compare of the version name — same tie-break
 * pickLatest below uses for consistency.
 *
 * isCurrent mirrors pickLatest's "latest" definition exactly (same
 * excludeFromLatest-aware rule GET /v1/images/current uses) — computed via
 * the same pickLatest helper so the two endpoints can never disagree about
 * which version is "current". See pickLatest's doc comment for the
 * fallback edge case where isCurrent can end up true on a version that is
 * ALSO excludeFromLatest:true (all versions excluded) — the frontend
 * checks for exactly that combination to annotate its "Current" badge
 * rather than needing a separate field here.
 *
 * eolDate's IMAGE_EOL_DATE config fallback is applied ONLY to the isCurrent
 * entry — see this function's exported type's doc comment in
 * @avdmgr/shared for why: that config value describes the CURRENT golden
 * image's underlying OS, not any older version's, so applying it to a
 * historical version whose own endOfLifeDate is unset would fabricate a
 * date this app has no actual basis for.
 */
export function buildVersionTimeline(
  versions: GalleryImageVersion[],
  imageDefinitionName: string,
  imageEolDate: string | undefined,
  now: Date = new Date(),
): Array<Omit<ImageVersionTimelineEntry, 'hostCount'>> {
  const latest = pickLatest(versions);

  const entries = versions.map((armVersion) => {
    const mapped = mapImageVersion(armVersion, imageDefinitionName);
    const isCurrent = latest !== undefined && armVersion === latest;

    const publishedDate = armVersion.publishingProfile?.publishedDate;
    const ageDays = publishedDate ? daysBetween(publishedDate, now) : undefined;

    const eolDateSource = armVersion.publishingProfile?.endOfLifeDate;
    const eolDate = eolDateSource ? eolDateSource.toISOString().slice(0, 10) : isCurrent ? imageEolDate : undefined;
    const daysUntilEol = eolDate ? daysBetween(now, new Date(`${eolDate}T00:00:00Z`)) : undefined;

    return {
      ...mapped,
      ageDays,
      eolDate,
      daysUntilEol,
      replicationState: armVersion.replicationStatus?.aggregatedState,
      sizeGib: armVersion.storageProfile?.osDiskImage?.sizeInGB,
      isCurrent,
    };
  });

  return entries.sort((a, b) => {
    const aTime = a.publishedDate ? new Date(a.publishedDate).getTime() : -Infinity;
    const bTime = b.publishedDate ? new Date(b.publishedDate).getTime() : -Infinity;
    if (aTime !== bTime) return bTime - aTime;
    return b.name.localeCompare(a.name);
  });
}

/**
 * Matches a full gallery IMAGE VERSION resource id — a VM whose
 * imageReference.id was pinned to a SPECIFIC version at deploy time (the
 * common case for this estate — see the session-host runbook's
 * vmTemplate galleryImageVersion field). Verified against this repo's
 * installed @azure/arm-compute@25's ImageReference/SubResource shape — see
 * computeService.ts#getVmImageReference's doc comment.
 */
const GALLERY_IMAGE_VERSION_ID_PATTERN =
  /^\/subscriptions\/[^/]+\/resourceGroups\/[^/]+\/providers\/Microsoft\.Compute\/galleries\/([^/]+)\/images\/([^/]+)\/versions\/([^/]+)$/i;

/**
 * Matches a gallery IMAGE DEFINITION resource id with no /versions/ segment
 * — Azure's documented shorthand for "use whatever is 'latest' at deploy
 * time" (see ImageReference's SDK doc comment: "to use 'latest' version of
 * gallery image, just set '.../images/{imageName}' in the 'id' field
 * without version input"). AM-26 peer review MAJOR 2: an earlier version of
 * this comment claimed "Azure does not retain which concrete version was
 * actually deployed" for this case — that is NOT always true. ARM's
 * ImageReference also exposes a separate, readonly `exactVersion` field
 * ("the actual version in use") specifically for this scenario — see
 * VmImageReferenceInfo's doc comment in computeService.ts. When present,
 * correlateHostsToVersions below resolves against `exactVersion` BEFORE
 * falling back to "cannot be attributed to a specific version"; the
 * fallback reason only fires when ARM genuinely didn't report one.
 */
const GALLERY_IMAGE_DEFINITION_ID_PATTERN = /^\/subscriptions\/[^/]+\/resourceGroups\/[^/]+\/providers\/Microsoft\.Compute\/galleries\/([^/]+)\/images\/([^/]+)$/i;

/** One host's raw input to correlateHostsToVersions — the outcome of attempting to resolve its VM's imageReference, kept distinct from a successfully-resolved-but-unmatched reference so the reported reason states what ACTUALLY happened for this host (mirrors idleHostDetector.ts's buildReason convention). */
export interface HostImageCorrelationInput {
  sessionHostName: string;
  /** Set when the VM read succeeded — even if the VM turned up no imageReference at all (see correlateHostsToVersions), which is represented as `imageReference: undefined` here too (there is no ARM-level distinction between "VM read succeeded, no imageReference" and this field being absent — resolutionFailure is what distinguishes an actual read failure). */
  imageReference?: VmImageReferenceInfo;
  /** Set instead of imageReference when the VM itself couldn't be read/resolved at all (bad/missing resourceId, or a transient ARM failure) — becomes the correlation's unknownReason verbatim. */
  resolutionFailure?: string;
}

/**
 * Correlates each session host to the gallery image version its VM was
 * created from, purely from each host's (already-resolved) VM
 * imageReference — no ARM calls here, so this stays synchronous and unit
 * testable. See getImageVersionsReport below for the async VM-read step
 * that produces this function's input.
 *
 * Every branch that can't resolve to a specific, KNOWN version degrades to
 * 'unknown source' (imageVersionName left undefined) with a SPECIFIC
 * unknownReason — never a generic "unknown":
 *   - the VM itself couldn't be read/resolved (resolutionFailure passed
 *     through);
 *   - the VM has no imageReference.id at all — split into two sub-cases
 *     (AM-26 peer review MINOR 6): a SHARED or COMMUNITY gallery image
 *     reference (sharedGalleryImageId/communityGalleryImageId set) gets
 *     its own distinct reason, since that VM genuinely IS gallery-sourced,
 *     just not via this app's private gallery `id`; anything else (no
 *     imageReference at all, or one with none of id/
 *     sharedGalleryImageId/communityGalleryImageId set) is reported as
 *     "not created from a gallery image" (custom/marketplace image,
 *     unmanaged disk, or another mechanism);
 *   - the imageReference.id points at a DIFFERENT gallery/definition than
 *     the one configured for this app;
 *   - the imageReference.id is pinned to a specific version name that is
 *     not in `knownVersionNames` (deleted since the VM was created);
 *   - the imageReference.id has no /versions/ segment (pinned to the
 *     definition's "latest" marker) — resolved via `exactVersion` when
 *     ARM reported one (see GALLERY_IMAGE_DEFINITION_ID_PATTERN's doc
 *     comment); only degrades to unknown when exactVersion is ALSO absent,
 *     or names a version not in `knownVersionNames`.
 */
export function correlateHostsToVersions(
  hosts: HostImageCorrelationInput[],
  knownVersionNames: readonly string[],
  galleryName: string,
  imageDefinitionName: string,
): SessionHostImageCorrelation[] {
  return hosts.map((host): SessionHostImageCorrelation => {
    if (host.resolutionFailure) {
      return { sessionHostName: host.sessionHostName, unknownReason: host.resolutionFailure };
    }

    const ref = host.imageReference;
    if (!ref?.id) {
      if (ref?.sharedGalleryImageId || ref?.communityGalleryImageId) {
        const kind = ref.sharedGalleryImageId ? 'a SHARED' : 'a COMMUNITY';
        return {
          sessionHostName: host.sessionHostName,
          unknownReason: `VM's imageReference uses ${kind} gallery image (not this app's private gallery "${galleryName}") — cannot be correlated to a version of ${galleryName}/${imageDefinitionName}.`,
        };
      }
      return {
        sessionHostName: host.sessionHostName,
        unknownReason: 'VM has no storageProfile.imageReference.id — not created from a gallery image (custom/marketplace image, unmanaged disk, or another mechanism).',
      };
    }

    const versionMatch = GALLERY_IMAGE_VERSION_ID_PATTERN.exec(ref.id);
    if (versionMatch) {
      const [, gallery, definition, version] = versionMatch;
      if (gallery.toLowerCase() !== galleryName.toLowerCase() || definition.toLowerCase() !== imageDefinitionName.toLowerCase()) {
        return {
          sessionHostName: host.sessionHostName,
          unknownReason: `VM's gallery image is "${gallery}/${definition}", not the configured "${galleryName}/${imageDefinitionName}".`,
        };
      }
      const matchedName = knownVersionNames.find((name) => name.toLowerCase() === version.toLowerCase());
      if (!matchedName) {
        return {
          sessionHostName: host.sessionHostName,
          unknownReason: `VM's image version "${version}" is not in the definition's current version list (it may have been deleted since this VM was created).`,
        };
      }
      return { sessionHostName: host.sessionHostName, imageVersionName: matchedName };
    }

    const definitionMatch = GALLERY_IMAGE_DEFINITION_ID_PATTERN.exec(ref.id);
    if (definitionMatch) {
      const [, gallery, definition] = definitionMatch;
      if (gallery.toLowerCase() !== galleryName.toLowerCase() || definition.toLowerCase() !== imageDefinitionName.toLowerCase()) {
        return {
          sessionHostName: host.sessionHostName,
          unknownReason: `VM's gallery image is "${gallery}/${definition}", not the configured "${galleryName}/${imageDefinitionName}".`,
        };
      }

      // AM-26 peer review MAJOR 2: resolve via exactVersion BEFORE
      // degrading — see GALLERY_IMAGE_DEFINITION_ID_PATTERN's doc comment.
      if (ref.exactVersion) {
        const matchedName = knownVersionNames.find((name) => name.toLowerCase() === ref.exactVersion!.toLowerCase());
        if (matchedName) {
          return { sessionHostName: host.sessionHostName, imageVersionName: matchedName };
        }
        return {
          sessionHostName: host.sessionHostName,
          unknownReason: `VM's imageReference is pinned to "latest", which ARM resolved to version "${ref.exactVersion}" (via exactVersion) — but that version is not in the definition's current version list (it may have been deleted since this VM was created).`,
        };
      }

      return {
        sessionHostName: host.sessionHostName,
        unknownReason:
          'VM\'s imageReference is pinned to the gallery image definition\'s "latest" marker (no /versions/ segment), and ARM did not report an exactVersion for it — the concrete version actually deployed could not be determined.',
      };
    }

    return {
      sessionHostName: host.sessionHostName,
      unknownReason: 'VM was not created from this gallery/definition (custom image, marketplace image, or another mechanism).',
    };
  });
}

/**
 * Layers hostCount onto buildVersionTimeline's pure output, from an
 * already-computed correlation list — kept as its own tiny pure function
 * (rather than inlined into getImageVersionsReport) so it's independently
 * testable: a real 0 count for a version nobody currently runs is a
 * meaningful, correct result, not a mapping bug.
 */
export function attachHostCounts(
  entries: Array<Omit<ImageVersionTimelineEntry, 'hostCount'>>,
  hostCorrelations: SessionHostImageCorrelation[],
): ImageVersionTimelineEntry[] {
  const counts = new Map<string, number>();
  for (const correlation of hostCorrelations) {
    if (!correlation.imageVersionName) continue;
    counts.set(correlation.imageVersionName, (counts.get(correlation.imageVersionName) ?? 0) + 1);
  }
  return entries.map((entry) => ({ ...entry, hostCount: counts.get(entry.name) ?? 0 }));
}

/** Max concurrent per-host VM reads (AM-26 peer review item 11) — same DEFAULT_CONCURRENCY=8 rationale as sessionBatch.ts: an unbounded fan-out over every session host risks 429 throttling/SNAT exhaustion for a busy host pool. */
const VM_LOOKUP_CONCURRENCY = 8;

async function resolveHostCorrelationInputs(hostPoolName: string, warn: (message: string) => void): Promise<HostImageCorrelationInput[]> {
  const hostRefs = await listSessionHostVmRefs(hostPoolName);

  return mapWithConcurrency(hostRefs, VM_LOOKUP_CONCURRENCY, async (host): Promise<HostImageCorrelationInput> => {
    const parsed = parseVmResourceId(host.resourceId);
    if (!parsed) {
      return {
        sessionHostName: host.sessionHostName,
        resolutionFailure: "Session host's VM resourceId is missing or not a well-formed Microsoft.Compute/virtualMachines id (host may not be fully registered).",
      };
    }
    try {
      const imageReference = await getVmImageReference(parsed.resourceGroup, parsed.vmName);
      return { sessionHostName: host.sessionHostName, imageReference };
    } catch (error) {
      warn(`Failed to resolve VM image reference for session host "${host.sessionHostName}" (${host.resourceId}): ${error instanceof Error ? error.message : String(error)}`);
      return { sessionHostName: host.sessionHostName, resolutionFailure: 'Failed to read the VM from Azure (transient ARM error) — could not determine its image source.' };
    }
  });
}

async function buildImageVersionsReport(warn: (message: string) => void): Promise<ImageVersionsResponse> {
  const client = getComputeClient();
  const { resourceGroups, galleryName, imageDefinitionName, imageEolDate, hostPoolName } = getConfig();

  // SCOPE ASSUMPTION (deferred, not implemented here): this drains the
  // ENTIRE listByGalleryImage async-pageable result into memory, unbounded
  // — fine for this estate's real version count (a handful — see
  // The estate inventory's "Image definition" table,
  // currently just 2.0.0) and the SDK's PagedAsyncIterableIterator already
  // handles the underlying ARM continuation-token pagination transparently
  // either way. A definition with HUNDREDS of retained versions would need
  // this endpoint (and the Images page's timeline table) to paginate its
  // own RESPONSE — a distinct concern from ARM's wire-level paging, which
  // is already handled — rather than returning the full list in one
  // response body on every 5-minute poll. No such story exists yet.
  const armVersions: GalleryImageVersion[] = [];
  for await (const version of client.galleryImageVersions.listByGalleryImage(resourceGroups.images, galleryName, imageDefinitionName)) {
    armVersions.push(version);
  }
  const baseEntries = buildVersionTimeline(armVersions, imageDefinitionName, imageEolDate);
  const knownVersionNames = baseEntries.map((entry) => entry.name);

  const correlationInputs = await resolveHostCorrelationInputs(hostPoolName, warn);
  const hostCorrelations = correlateHostsToVersions(correlationInputs, knownVersionNames, galleryName, imageDefinitionName);
  const versions = attachHostCounts(baseEntries, hostCorrelations);

  return { imageDefinitionName, versions, hostCorrelations };
}

/**
 * Short-lived in-memory cache (AM-26 peer review item 11) — same TTL-cache
 * shape as costService.ts's getCostSummary (cache + in-flight-promise
 * dedupe so concurrent callers during a cold cache don't each independently
 * fan out to Azure), but with a much shorter TTL: this report is read-only,
 * viewer-facing data that changes rarely (new image versions are published
 * infrequently, session hosts don't change gallery source without a
 * rebuild), while ALSO being the kind of endpoint every signed-in viewer
 * can hit repeatedly — an uncached version would let N viewers each trigger
 * their own full version-list + per-host VM fan-out on every 5-minute page
 * poll (see Images.tsx), amplifying ARM call volume with the number of
 * concurrent viewers rather than the number of Function App instances. 60s
 * is short enough that a genuinely fresh version publish or host rebuild is
 * visible within a minute, while still collapsing that amplification for
 * any viewers polling within the same window. Same cold-start caveat as
 * costService.ts's cache: this is per-instance, not durable/cross-instance.
 */
const REPORT_CACHE_TTL_MS = 60_000;

let cachedVersionsReport: { value: ImageVersionsResponse; expiresAt: number } | undefined;
let inFlightVersionsReport: Promise<ImageVersionsResponse> | undefined;

/**
 * Full orchestration for GET /v1/images/versions: lists every version of
 * the configured image definition, lists the configured host pool's session
 * hosts, resolves each host's underlying VM's imageReference (bounded to
 * VM_LOOKUP_CONCURRENCY concurrent ARM calls — see
 * resolveHostCorrelationInputs), and correlates the two. A single host's
 * VM-read failure degrades ONLY that host to 'unknown source' (see
 * correlateHostsToVersions) — it never fails the whole request. Result is
 * cached for REPORT_CACHE_TTL_MS — see that constant's doc comment.
 */
export async function getImageVersionsReport(options: { warn?: (message: string) => void } = {}): Promise<ImageVersionsResponse> {
  const { warn = () => {} } = options;

  if (cachedVersionsReport && cachedVersionsReport.expiresAt > Date.now()) {
    return cachedVersionsReport.value;
  }
  if (inFlightVersionsReport) {
    return inFlightVersionsReport;
  }

  inFlightVersionsReport = (async () => {
    try {
      const report = await buildImageVersionsReport(warn);
      cachedVersionsReport = { value: report, expiresAt: Date.now() + REPORT_CACHE_TTL_MS };
      return report;
    } finally {
      inFlightVersionsReport = undefined;
    }
  })();

  return inFlightVersionsReport;
}

/** Test-only: clears the module-level cache (and any in-flight promise reference) so tests don't leak state across cases. */
export function _resetImageVersionsReportCacheForTests(): void {
  cachedVersionsReport = undefined;
  inFlightVersionsReport = undefined;
}
