import type { Disk, Snapshot } from '@azure/arm-compute';
import type { ImageSnapshot, SnapshotReportResponse } from '@avdmgr/shared';
import { getConfig } from '../lib/config';
import { getComputeClient } from '../lib/computeClient';
import { daysBetween } from '../lib/dateMath';

/**
 * Approximate Azure Standard HDD managed-disk snapshot storage rate, USD per
 * GiB-month. Standard HDD snapshots (both full and incremental) are billed
 * at the same $0.05/GiB-month for LRS and ZRS alike — confirmed against
 * Azure's public Managed Disks pricing page
 * (https://azure.microsoft.com/pricing/details/managed-disks/) at the time
 * this story was written.
 *
 * THIS IS A FIXED APPROXIMATION, NOT A LIVE PRICE. Deliberately NOT sourced
 * from the Azure Retail Prices API — out of scope for this read-only slice,
 * and would need this app's managed identity to carry additional
 * billing-data access it does not have. It will drift as Azure's published
 * prices change over time, and does not account for:
 *   - a snapshot moving to Premium/Standard SSD storage (a materially
 *     higher rate than Standard HDD);
 *   - regional price variation (Azure's published rate is the same across
 *     regions for this SKU today, but that is not guaranteed to stay true).
 *
 * AM-26 peer review MAJOR 1 (cost-basis correction): the rate itself
 * (dollars per GiB) is fine — what was WRONG in the original version of
 * this file was the assumption that multiplying it by the snapshot's
 * PROVISIONED size (diskSizeGB) approximates the actual bill. It does not.
 * Azure bills BOTH full and incremental managed-disk snapshots by USED
 * (allocated) bytes, not provisioned size — confirmed against Azure's
 * public documentation and pricing guidance (see
 * estimateMonthlyCostUsd's doc comment below for the full correction). A
 * disk provisioned at 127 GiB but only 40 GiB actually written is billed
 * on ~40 GiB, not 127 — the earlier version of this comment (and the
 * mapSnapshot doc comment below it) incorrectly claimed this estate's
 * snapshots being FULL (not incremental) made diskSizeGB "a reasonable
 * proxy for their billed size"; being full vs. incremental affects
 * whether SUBSEQUENT snapshots re-bill unchanged blocks, not whether ANY
 * individual snapshot is billed on provisioned vs. used size — that
 * distinction does not exist in Azure's actual billing model. This app has
 * no cheap way to read a snapshot's true used-byte count (it would require
 * additional Compute Disk data-plane access this app's managed identity
 * does not have), so estimateMonthlyCostUsd below is now explicitly
 * documented, and surfaced in the UI, as an UPPER BOUND — never presented
 * as the actual bill.
 */
const APPROX_SNAPSHOT_GIB_MONTHLY_RATE_USD = 0.05;

/**
 * UPPER-BOUND monthly cost estimate: sizeGib (the snapshot's PROVISIONED
 * size) × the fixed approximate rate above. See
 * APPROX_SNAPSHOT_GIB_MONTHLY_RATE_USD's doc comment (AM-26 peer review
 * MAJOR 1) for why this is an upper bound, not the actual bill — Azure
 * meters snapshot storage by USED bytes, which this app cannot cheaply
 * read. Rounds to the nearest cent — an estimate this rough (and this
 * biased toward overstating cost) has no business reporting more
 * precision than that.
 */
export function estimateMonthlyCostUsd(sizeGib: number | undefined): number | undefined {
  if (sizeGib === undefined) return undefined;
  return Math.round(sizeGib * APPROX_SNAPSHOT_GIB_MONTHLY_RATE_USD * 100) / 100;
}

/** Minimal shape classifyOrphan needs from a snapshot — kept narrow so it's trivial to build fixtures for (see snapshotsService.test.ts). */
export interface OrphanClassificationInput {
  /** The snapshot's own ARM resource id. */
  id: string;
  /** The snapshot's creationData.sourceResourceId (the disk it was created FROM), if ARM recorded one. */
  sourceResourceId?: string;
}

export interface OrphanClassificationContext {
  /** ARM resource ids (lowercased) of every disk currently existing in the scanned resource group(s). */
  currentDiskIds: ReadonlySet<string>;
  /** creationData.sourceResourceId values (lowercased) of every disk currently existing in the scanned resource group(s) — i.e. "what every live disk was created FROM". */
  diskSourceIds: ReadonlySet<string>;
}

/**
 * Orphan heuristic (AM-26): a snapshot is orphaned when it is NOT ATTACHED
 * AS THE SOURCE OF ANYTHING CURRENT — i.e. no disk existing today in the
 * scanned resource group(s) was created FROM this snapshot. This is the
 * PRIMARY, gating check (matches the story's own wording), computed from
 * `diskSourceIds` (every live disk's own creationData.sourceResourceId).
 *
 * The snapshot's OWN source disk existing/not-existing is reported as
 * SUPPORTING context in the reason text, not as a second gate — see
 * The estate inventory's "Snapshots" section, which
 * documents this exact secondary fact ("Source disk still exists: false")
 * for both SNAP-WIN11-PRE-SYSPREP-1.0.0 and -2.0.0. A snapshot's build-time
 * source disk being cleaned up afterward is normal, expected lifecycle on
 * its own (that's what "snapshot then delete the working disk" looks
 * like) — it is not, by itself, evidence of being orphaned; what makes a
 * snapshot a genuine cleanup candidate is nothing depending on it TODAY.
 *
 * AM-26 peer review MAJOR 3a: `resourceGroupsScanned` is threaded through
 * purely to SCOPE the reason text to what was actually scanned (e.g. "no
 * disk in RG-AVD-Images or RG-AVD-HostPools was created from this
 * snapshot") rather than an unqualified, easy-to-over-read "no disk was
 * created from this snapshot" — this function has no visibility into any
 * resource group it wasn't given disk data for, and the wording must not
 * imply otherwise.
 *
 * Pure and synchronous — no ARM calls — so it's directly unit-testable
 * against fixtures built from the real SNAP-WIN11-PRE-SYSPREP-1.0.0/-2.0.0
 * inventory data (see snapshotsService.test.ts). Callers are responsible
 * for NOT calling this at all when the scan is incomplete (see
 * getSnapshotReport) — this function always returns a definite true/false,
 * it does not itself model the indeterminate case.
 */
export function classifyOrphan(snapshot: OrphanClassificationInput, context: OrphanClassificationContext, resourceGroupsScanned: readonly string[]): { orphaned: boolean; orphanReason: string } {
  const scannedList = resourceGroupsScanned.join(' or ');
  const normalizedId = snapshot.id.toLowerCase();
  const isSourceOfCurrentDisk = normalizedId !== '' && context.diskSourceIds.has(normalizedId);

  if (isSourceOfCurrentDisk) {
    return { orphaned: false, orphanReason: `At least one disk currently existing in ${scannedList} was created from this snapshot — still in active use.` };
  }

  const sourceStillExists = snapshot.sourceResourceId ? context.currentDiskIds.has(snapshot.sourceResourceId.toLowerCase()) : undefined;
  const sourceClause =
    snapshot.sourceResourceId === undefined ? 'no source disk is recorded on the snapshot' : sourceStillExists ? 'its own source disk still exists' : 'its own source disk no longer exists either';

  return {
    orphaned: true,
    orphanReason: `No disk in ${scannedList} was created from this snapshot (${sourceClause}) — nothing depends on it today, based on what was scanned.`,
  };
}

function mapSnapshot(armSnapshot: Snapshot, resourceGroup: string, now: Date, orphanResult: { orphaned: boolean | undefined; orphanReason: string }): ImageSnapshot {
  const createdDate = armSnapshot.timeCreated?.toISOString();
  const ageDays = armSnapshot.timeCreated ? daysBetween(armSnapshot.timeCreated, now) : undefined;
  // diskSizeGB (falling back to diskSizeBytes) is the snapshot's
  // PROVISIONED size, as reported by ARM — NOT its billed size. See
  // estimateMonthlyCostUsd's doc comment (AM-26 peer review MAJOR 1) for
  // why estMonthlyCostUsd derived from this is an upper bound, not the
  // actual bill.
  const sizeGib = armSnapshot.diskSizeGB ?? (armSnapshot.diskSizeBytes !== undefined ? armSnapshot.diskSizeBytes / 1024 ** 3 : undefined);

  return {
    id: armSnapshot.id ?? '',
    name: armSnapshot.name ?? '',
    resourceGroup,
    createdDate,
    ageDays,
    sizeGib,
    estMonthlyCostUsd: estimateMonthlyCostUsd(sizeGib),
    provisioningState: armSnapshot.provisioningState,
    sku: armSnapshot.sku?.name,
    orphaned: orphanResult.orphaned,
    orphanReason: orphanResult.orphanReason,
  };
}

const SCAN_INCOMPLETE_REASON = 'Orphan status could not be determined — the disk scan needed to classify it was incomplete (see the snapshot report\'s scan warnings).';

/**
 * Lists snapshots (or disks) in ONE resource group, catching and reporting
 * any per-RG failure instead of letting it abort the whole multi-RG scan
 * (AM-26 peer review MAJOR 3b) — a transient ARM error against, say,
 * RG-AVD-HostPools must not also lose RG-AVD-Images' otherwise-healthy
 * results. Failures are pushed onto `failures` (surfaced to the caller as
 * a scan-incomplete signal) and warned via `warn`.
 */
async function listPerResourceGroup<T>(
  resourceGroups: readonly string[],
  kind: 'snapshots' | 'disks',
  list: (resourceGroup: string) => AsyncIterable<T>,
  warn: (message: string) => void,
  failures: string[],
): Promise<Map<string, T[]>> {
  const byResourceGroup = new Map<string, T[]>();
  for (const resourceGroup of resourceGroups) {
    try {
      const items: T[] = [];
      for await (const item of list(resourceGroup)) {
        items.push(item);
      }
      byResourceGroup.set(resourceGroup, items);
    } catch (error) {
      const message = `Failed to list ${kind} in ${resourceGroup}: ${error instanceof Error ? error.message : String(error)}`;
      failures.push(message);
      warn(message);
    }
  }
  return byResourceGroup;
}

/**
 * Full orchestration for GET /v1/images/snapshots: lists snapshots AND
 * disks in RG-AVD-Images and RG-AVD-HostPools (Reader is already granted on
 * both — see infra/main.bicep's rbacImages/rbacHostPools modules, both
 * plain "Reader" at resource-group scope, which covers
 * Microsoft.Compute/snapshots/read and Microsoft.Compute/disks/read; no
 * infra change needed for this story), then classifies each snapshot via
 * classifyOrphan. Disks are read from BOTH scanned resource groups (not
 * just the snapshot's own RG) so a disk in one RG created from a snapshot
 * in the other is still correctly recognized as "not orphaned".
 *
 * AM-26 peer review MAJOR 3 — scan-incomplete handling: this refuses to
 * assert ANY snapshot's orphaned status (leaving `orphaned: undefined` on
 * every one, see ImageSnapshot's doc comment) when:
 *   (a) any per-resource-group snapshots OR disks listing failed
 *       (listPerResourceGroup above catches and reports these individually
 *       rather than one failure aborting the whole scan); or
 *   (b) the RG-AVD-HostPools disk listing SUCCEEDED but came back with
 *       ZERO disks — anomalous for a resource group that (per this
 *       estate's own inventory — the captured estate inventory
 *       shows avd-con-0's OS disk there) holds every session host's OS
 *       disk; a genuinely-empty result here is far more likely to mean
 *       "something is silently wrong with this read" than "this host pool
 *       has zero session hosts", so this app does not trust it enough to
 *       assert an orphaned:true/false answer on that basis.
 * Both cases are reported via `scanIncomplete: true` plus a warn() call
 * describing the specific anomaly, rather than silently defaulting to
 * orphaned:true (the alarming answer) on data that was never actually
 * confirmed complete.
 */
async function buildSnapshotReport(warn: (message: string) => void): Promise<SnapshotReportResponse> {
  const client = getComputeClient();
  const { resourceGroups } = getConfig();
  const resourceGroupsScanned = [resourceGroups.images, resourceGroups.hostPools];
  const now = new Date();

  const failures: string[] = [];
  const snapshotsByRg = await listPerResourceGroup(resourceGroupsScanned, 'snapshots', (rg) => client.snapshots.listByResourceGroup(rg), warn, failures);
  const disksByRg = await listPerResourceGroup(resourceGroupsScanned, 'disks', (rg) => client.disks.listByResourceGroup(rg), warn, failures);

  const hostPoolsDisks = disksByRg.get(resourceGroups.hostPools);
  if (hostPoolsDisks !== undefined && hostPoolsDisks.length === 0) {
    const message = `Disk listing for ${resourceGroups.hostPools} returned zero disks — anomalous for an active host pool resource group (every session host's OS disk should live there); not trusting it for orphan classification.`;
    failures.push(message);
    warn(message);
  }

  const scanIncomplete = failures.length > 0;

  const allDisks: Disk[] = [...disksByRg.values()].flat();
  const currentDiskIds = new Set(allDisks.map((disk) => disk.id?.toLowerCase()).filter((id): id is string => !!id));
  const diskSourceIds = new Set(allDisks.map((disk) => disk.creationData?.sourceResourceId?.toLowerCase()).filter((id): id is string => !!id));

  const snapshots = [...snapshotsByRg.entries()].flatMap(([resourceGroup, armSnapshots]) =>
    armSnapshots.map((armSnapshot) => {
      const orphanResult = scanIncomplete
        ? { orphaned: undefined, orphanReason: SCAN_INCOMPLETE_REASON }
        : classifyOrphan({ id: armSnapshot.id ?? '', sourceResourceId: armSnapshot.creationData?.sourceResourceId }, { currentDiskIds, diskSourceIds }, resourceGroupsScanned);
      return mapSnapshot(armSnapshot, resourceGroup, now, orphanResult);
    }),
  );

  return { resourceGroupsScanned, snapshots, scanIncomplete };
}

/**
 * Short-lived in-memory cache (AM-26 peer review item 11) — same shape/TTL
 * as imagesService.ts's getImageVersionsReport cache (see that constant's
 * doc comment for the full rationale, including the viewer-amplification
 * concern): this scan is read-only, viewer-facing, changes rarely, and
 * every signed-in viewer can trigger it on the Images page's 5-minute poll,
 * so an uncached version would let N concurrent viewers each independently
 * re-run the full snapshot+disk scan across both resource groups.
 */
const REPORT_CACHE_TTL_MS = 60_000;

let cachedSnapshotReport: { value: SnapshotReportResponse; expiresAt: number } | undefined;
let inFlightSnapshotReport: Promise<SnapshotReportResponse> | undefined;

export async function getSnapshotReport(options: { warn?: (message: string) => void } = {}): Promise<SnapshotReportResponse> {
  const { warn = () => {} } = options;

  if (cachedSnapshotReport && cachedSnapshotReport.expiresAt > Date.now()) {
    return cachedSnapshotReport.value;
  }
  if (inFlightSnapshotReport) {
    return inFlightSnapshotReport;
  }

  inFlightSnapshotReport = (async () => {
    try {
      const report = await buildSnapshotReport(warn);
      cachedSnapshotReport = { value: report, expiresAt: Date.now() + REPORT_CACHE_TTL_MS };
      return report;
    } finally {
      inFlightSnapshotReport = undefined;
    }
  })();

  return inFlightSnapshotReport;
}

/** Test-only: clears the module-level cache (and any in-flight promise reference) so tests don't leak state across cases. */
export function _resetSnapshotReportCacheForTests(): void {
  cachedSnapshotReport = undefined;
  inFlightSnapshotReport = undefined;
}
