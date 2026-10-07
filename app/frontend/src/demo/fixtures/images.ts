import type { ImageSnapshot, ImageVersionCurrent, ImageVersionTimelineEntry } from '@avdmgr/shared';
import { DAY, dateAgo, ago } from './time';
import { GALLERY_NAME, IMAGE_DEFINITION, RG, armId } from './estate';

const versionId = (name: string) => armId(RG.images, `Microsoft.Compute/galleries/${GALLERY_NAME}/images/${IMAGE_DEFINITION}/versions/${name}`);

interface VersionSeed {
  name: string;
  ageDays: number;
  isCurrent: boolean;
  excludeFromLatest: boolean;
  hostCount: number;
  sizeGib: number;
}

const SEEDS: VersionSeed[] = [
  { name: '1.3.0', ageDays: 12, isCurrent: true, excludeFromLatest: false, hostCount: 2, sizeGib: 127 },
  { name: '1.2.0', ageDays: 54, isCurrent: false, excludeFromLatest: false, hostCount: 3, sizeGib: 126 },
  { name: '1.1.0', ageDays: 118, isCurrent: false, excludeFromLatest: true, hostCount: 0, sizeGib: 124 },
  { name: '1.0.0', ageDays: 171, isCurrent: false, excludeFromLatest: true, hostCount: 0, sizeGib: 122 },
];

/** Each version's EOL is its publish date + 18 months (≈548 days), matching how the real API stamps it. */
function toTimelineEntry(now: number, seed: VersionSeed): ImageVersionTimelineEntry {
  const eolDays = 548 - seed.ageDays;
  return {
    id: versionId(seed.name),
    name: seed.name,
    imageDefinitionName: IMAGE_DEFINITION,
    publishedDate: ago(now, seed.ageDays * DAY),
    excludeFromLatest: seed.excludeFromLatest,
    replicaCount: 1,
    targetRegions: ['eastus'],
    provisioningState: 'Succeeded',
    ageDays: seed.ageDays,
    eolDate: dateAgo(now, -eolDays),
    daysUntilEol: eolDays,
    replicationState: 'Completed',
    sizeGib: seed.sizeGib,
    isCurrent: seed.isCurrent,
    hostCount: seed.hostCount,
  };
}

export function buildImageVersions(now: number): ImageVersionTimelineEntry[] {
  return SEEDS.map((seed) => toTimelineEntry(now, seed)) satisfies ImageVersionTimelineEntry[];
}

export function buildCurrentImage(now: number): ImageVersionCurrent {
  const entry = toTimelineEntry(now, SEEDS[0]);
  return {
    id: entry.id,
    name: entry.name,
    imageDefinitionName: entry.imageDefinitionName,
    publishedDate: entry.publishedDate,
    excludeFromLatest: entry.excludeFromLatest,
    replicaCount: entry.replicaCount,
    targetRegions: entry.targetRegions,
    provisioningState: entry.provisioningState,
    ageDays: entry.ageDays,
    eolDate: entry.eolDate,
    daysUntilEol: entry.daysUntilEol,
  } satisfies ImageVersionCurrent;
}

export function buildSnapshots(now: number): ImageSnapshot[] {
  const snap = (name: string, rg: string) => armId(rg, `Microsoft.Compute/snapshots/${name}`);
  return [
    { id: snap('SNAP-WIN11-PRE-SYSPREP-1.3.0', RG.images), name: 'SNAP-WIN11-PRE-SYSPREP-1.3.0', resourceGroup: RG.images, createdDate: ago(now, 13 * DAY), ageDays: 13, sizeGib: 127, estMonthlyCostUsd: 6.1, provisioningState: 'Succeeded', sku: 'Standard_LRS', orphaned: false, orphanReason: 'Recorded as the pre-Sysprep snapshot of a completed image build whose version is still current.' },
    { id: snap('SNAP-WIN11-PRE-SYSPREP-1.2.0', RG.images), name: 'SNAP-WIN11-PRE-SYSPREP-1.2.0', resourceGroup: RG.images, createdDate: ago(now, 55 * DAY), ageDays: 55, sizeGib: 127, estMonthlyCostUsd: 6.1, provisioningState: 'Succeeded', sku: 'Standard_LRS', orphaned: false, orphanReason: 'Recorded as the pre-Sysprep snapshot of image build 1.2.0 (still in use by 3 hosts).' },
    { id: snap('SNAP-TEST-DISK-OLD', RG.hostPools), name: 'SNAP-TEST-DISK-OLD', resourceGroup: RG.hostPools, createdDate: ago(now, 203 * DAY), ageDays: 203, sizeGib: 128, estMonthlyCostUsd: 6.14, provisioningState: 'Succeeded', sku: 'Standard_LRS', orphaned: true, orphanReason: 'Older than 90 days and not referenced by any image build record or gallery version.' },
  ] satisfies ImageSnapshot[];
}
