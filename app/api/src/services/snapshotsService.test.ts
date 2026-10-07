import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Disk, Snapshot } from '@azure/arm-compute';

const snapshotsListByResourceGroup = vi.fn();
const disksListByResourceGroup = vi.fn();

vi.mock('@azure/identity', () => ({
  DefaultAzureCredential: vi.fn().mockImplementation(function DefaultAzureCredential() {
    return {};
  }),
}));

vi.mock('@azure/arm-compute', () => ({
  ComputeManagementClient: vi.fn().mockImplementation(function ComputeManagementClient() {
    return {
      snapshots: { listByResourceGroup: (...args: unknown[]) => snapshotsListByResourceGroup(...args) },
      disks: { listByResourceGroup: (...args: unknown[]) => disksListByResourceGroup(...args) },
    };
  }),
}));

const { classifyOrphan, estimateMonthlyCostUsd, getSnapshotReport, _resetSnapshotReportCacheForTests } = await import('./snapshotsService');
const { _resetComputeClientForTests } = await import('../lib/computeClient');

const ORIGINAL_ENV = { ...process.env };
const RESOURCE_GROUPS_SCANNED = ['RG-AVD-Images', 'RG-AVD-HostPools'];

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  process.env.SUBSCRIPTION_ID = '00000000-0000-4000-8000-000000000001';
  process.env.RG_HOSTPOOLS = 'RG-AVD-HostPools';
  process.env.RG_IMAGES = 'RG-AVD-Images';
  process.env.HOSTPOOL_NAME = 'HP-CONTOSO-PROD';
  snapshotsListByResourceGroup.mockReset();
  disksListByResourceGroup.mockReset();
  _resetSnapshotReportCacheForTests();
  _resetComputeClientForTests();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

// Real fixture data from the captured estate inventory — the
// two known genuinely-orphaned snapshots this story's brief calls out by
// name, both created as intermediate artifacts during the golden image
// build (pre-sysprep), both with a source disk that no longer exists.
const SNAP_1_ID = '/subscriptions/00000000-0000-4000-8000-000000000001/resourceGroups/RG-AVD-Images/providers/Microsoft.Compute/snapshots/SNAP-WIN11-PRE-SYSPREP-1.0.0';
const SNAP_1_SOURCE_DISK_ID =
  '/subscriptions/00000000-0000-4000-8000-000000000001/resourceGroups/RG-AVD-Images/providers/Microsoft.Compute/disks/VM-IMG-WIN11-001_OsDisk_1_35d12340d95a4e56a63d8ae1d05a3bab';
const SNAP_2_ID = '/subscriptions/00000000-0000-4000-8000-000000000001/resourceGroups/RG-AVD-Images/providers/Microsoft.Compute/snapshots/SNAP-WIN11-PRE-SYSPREP-2.0.0';
const SNAP_2_SOURCE_DISK_ID = '/subscriptions/00000000-0000-4000-8000-000000000001/resourceGroups/RG-AVD-Images/providers/Microsoft.Compute/disks/VM-IMG-WIN11-001-OsDisk-v2';

// AM-26 peer review MAJOR 3: the REAL avd-con-0 OS disk, from
// The captured estate inventory — a live disk that DOES exist
// in RG-AVD-HostPools (it was created from the gallery image, not from
// either SNAP-WIN11-PRE-SYSPREP snapshot, so it doesn't change either
// snapshot's orphan classification, but its mere presence proves the
// disk-listing-for-RG-AVD-HostPools-returned-zero-results "wrong world"
// the original fixture (an unconditionally empty disk list) implied).
const AVD_VEST_0_OS_DISK_ID = '/subscriptions/00000000-0000-4000-8000-000000000001/resourceGroups/RG-AVD-HostPools/providers/Microsoft.Compute/disks/avd-con-0_OsDisk_1_40af1e55d96d4edb8187200954a5817d';

function avdVest0OsDisk(): Disk {
  return {
    id: AVD_VEST_0_OS_DISK_ID,
    name: 'avd-con-0_OsDisk_1_40af1e55d96d4edb8187200954a5817d',
    resourceGroup: 'RG-AVD-HostPools',
    provisioningState: 'Succeeded',
    sku: { name: 'Premium_LRS', tier: 'Premium' },
    // Created FROM the gallery image directly (FromImage), not from a
    // snapshot — creationData.sourceResourceId is absent, matching how a
    // session host's OS disk is actually provisioned by AVD (see
    // The session-host runbook).
    creationData: { createOption: 'FromImage' },
  } as unknown as Disk;
}

function snap1(): Snapshot {
  return {
    id: SNAP_1_ID,
    name: 'SNAP-WIN11-PRE-SYSPREP-1.0.0',
    creationData: { createOption: 'Copy', sourceResourceId: SNAP_1_SOURCE_DISK_ID },
    diskSizeGB: 127,
    diskSizeBytes: 136367308800,
    diskState: 'Unattached',
    provisioningState: 'Succeeded',
    sku: { name: 'Standard_ZRS', tier: 'Standard' },
    timeCreated: new Date('2026-08-13T13:53:15.238Z'),
  } as unknown as Snapshot;
}

function snap2(): Snapshot {
  return {
    id: SNAP_2_ID,
    name: 'SNAP-WIN11-PRE-SYSPREP-2.0.0',
    creationData: { createOption: 'Copy', sourceResourceId: SNAP_2_SOURCE_DISK_ID },
    diskSizeGB: 127,
    diskSizeBytes: 136367308800,
    diskState: 'Unattached',
    provisioningState: 'Succeeded',
    sku: { name: 'Standard_LRS', tier: 'Standard' },
    timeCreated: new Date('2026-08-13T15:06:29.462Z'),
  } as unknown as Snapshot;
}

/** Default happy-path mock wiring: snapshots only in RG-AVD-Images, the real avd-con-0 OS disk in RG-AVD-HostPools, nothing in RG-AVD-Images' own disk listing. */
function wireHappyPath(snapshots: Snapshot[] = [snap1(), snap2()]) {
  snapshotsListByResourceGroup.mockImplementation((rg: string) => {
    if (rg === 'RG-AVD-Images') {
      return (async function* () {
        for (const s of snapshots) yield s;
      })();
    }
    return (async function* () {})();
  });
  disksListByResourceGroup.mockImplementation((rg: string) => {
    if (rg === 'RG-AVD-HostPools') {
      return (async function* () {
        yield avdVest0OsDisk();
      })();
    }
    return (async function* () {})();
  });
}

describe('classifyOrphan', () => {
  it('flags the real SNAP-WIN11-PRE-SYSPREP-1.0.0 as orphaned when no current disk was created from it (matches the estate inventory)', () => {
    const result = classifyOrphan({ id: SNAP_1_ID, sourceResourceId: SNAP_1_SOURCE_DISK_ID }, { currentDiskIds: new Set([AVD_VEST_0_OS_DISK_ID.toLowerCase()]), diskSourceIds: new Set() }, RESOURCE_GROUPS_SCANNED);

    expect(result.orphaned).toBe(true);
    expect(result.orphanReason).toContain('No disk in RG-AVD-Images or RG-AVD-HostPools was created from this snapshot');
    expect(result.orphanReason).toContain('its own source disk no longer exists either');
  });

  it('flags the real SNAP-WIN11-PRE-SYSPREP-2.0.0 as orphaned the same way', () => {
    const result = classifyOrphan({ id: SNAP_2_ID, sourceResourceId: SNAP_2_SOURCE_DISK_ID }, { currentDiskIds: new Set(), diskSourceIds: new Set() }, RESOURCE_GROUPS_SCANNED);

    expect(result.orphaned).toBe(true);
  });

  it('is NOT orphaned when a currently-existing disk was created FROM this snapshot (primary gate)', () => {
    const result = classifyOrphan({ id: SNAP_1_ID, sourceResourceId: SNAP_1_SOURCE_DISK_ID }, { currentDiskIds: new Set(), diskSourceIds: new Set([SNAP_1_ID.toLowerCase()]) }, RESOURCE_GROUPS_SCANNED);

    expect(result.orphaned).toBe(false);
    expect(result.orphanReason).toContain('was created from this snapshot');
  });

  it('is case-insensitive when matching the snapshot id against diskSourceIds', () => {
    const result = classifyOrphan({ id: SNAP_1_ID, sourceResourceId: SNAP_1_SOURCE_DISK_ID }, { currentDiskIds: new Set(), diskSourceIds: new Set([SNAP_1_ID.toUpperCase().toLowerCase()]) }, RESOURCE_GROUPS_SCANNED);

    expect(result.orphaned).toBe(false);
  });

  it('is still orphaned (not the gate) even when its OWN source disk still exists, as long as nothing was created FROM the snapshot itself', () => {
    const result = classifyOrphan(
      { id: SNAP_1_ID, sourceResourceId: SNAP_1_SOURCE_DISK_ID },
      { currentDiskIds: new Set([SNAP_1_SOURCE_DISK_ID.toLowerCase()]), diskSourceIds: new Set() },
      RESOURCE_GROUPS_SCANNED,
    );

    expect(result.orphaned).toBe(true);
    expect(result.orphanReason).toContain('its own source disk still exists');
  });

  it('reports "no source disk is recorded" when the snapshot has no creationData.sourceResourceId at all', () => {
    const result = classifyOrphan({ id: SNAP_1_ID, sourceResourceId: undefined }, { currentDiskIds: new Set(), diskSourceIds: new Set() }, RESOURCE_GROUPS_SCANNED);

    expect(result.orphaned).toBe(true);
    expect(result.orphanReason).toContain('no source disk is recorded');
  });

  it('scopes the reason text to the resource groups actually scanned (AM-26 peer review MAJOR 3a)', () => {
    const result = classifyOrphan({ id: SNAP_1_ID, sourceResourceId: undefined }, { currentDiskIds: new Set(), diskSourceIds: new Set() }, ['RG-ONLY-ONE']);

    expect(result.orphanReason).toContain('No disk in RG-ONLY-ONE was created from this snapshot');
  });
});

describe('estimateMonthlyCostUsd', () => {
  it('returns undefined when sizeGib is undefined', () => {
    expect(estimateMonthlyCostUsd(undefined)).toBeUndefined();
  });

  it('estimates using the fixed $0.05/GiB-month approximate rate against PROVISIONED size, rounded to the nearest cent', () => {
    expect(estimateMonthlyCostUsd(127)).toBe(6.35);
  });

  it('handles a zero size without dividing by zero or erroring', () => {
    expect(estimateMonthlyCostUsd(0)).toBe(0);
  });
});

describe('getSnapshotReport (mocked ComputeManagementClient)', () => {
  it('scans RG-AVD-Images and RG-AVD-HostPools and surfaces both known SNAP-WIN11-PRE-SYSPREP snapshots as orphaned, with the real avd-con-0 OS disk present and not affecting the result', async () => {
    wireHappyPath();

    const report = await getSnapshotReport();

    expect(report.resourceGroupsScanned).toEqual(['RG-AVD-Images', 'RG-AVD-HostPools']);
    expect(report.scanIncomplete).toBe(false);
    expect(report.snapshots).toHaveLength(2);
    const names = report.snapshots.map((s) => s.name);
    expect(names).toContain('SNAP-WIN11-PRE-SYSPREP-1.0.0');
    expect(names).toContain('SNAP-WIN11-PRE-SYSPREP-2.0.0');
    expect(report.snapshots.every((s) => s.orphaned === true)).toBe(true);
    expect(report.snapshots.every((s) => s.sizeGib === 127)).toBe(true);
    expect(report.snapshots.every((s) => s.estMonthlyCostUsd === 6.35)).toBe(true);
    expect(report.snapshots.every((s) => s.resourceGroup === 'RG-AVD-Images')).toBe(true);
  });

  it('marks a snapshot NOT orphaned when a disk found in the scan was created from it', async () => {
    snapshotsListByResourceGroup.mockImplementation((rg: string) => {
      if (rg === 'RG-AVD-Images') {
        return (async function* () {
          yield snap1();
        })();
      }
      return (async function* () {})();
    });
    disksListByResourceGroup.mockImplementation((rg: string) => {
      if (rg === 'RG-AVD-HostPools') {
        return (async function* () {
          yield avdVest0OsDisk();
          yield { id: '/subscriptions/x/resourceGroups/RG-AVD-HostPools/providers/Microsoft.Compute/disks/some-restored-disk', creationData: { sourceResourceId: SNAP_1_ID } } as Disk;
        })();
      }
      return (async function* () {})();
    });

    const report = await getSnapshotReport();

    expect(report.snapshots[0].orphaned).toBe(false);
  });

  describe('scan-incomplete handling (AM-26 peer review MAJOR 3c)', () => {
    it('refuses to assert orphaned (leaves it undefined) when the RG-AVD-HostPools disk listing fails, and reports scanIncomplete: true', async () => {
      snapshotsListByResourceGroup.mockImplementation((rg: string) => {
        if (rg === 'RG-AVD-Images') {
          return (async function* () {
            yield snap1();
          })();
        }
        return (async function* () {})();
      });
      disksListByResourceGroup.mockImplementation((rg: string) => {
        if (rg === 'RG-AVD-HostPools') {
          throw new Error('transient ARM error');
        }
        return (async function* () {})();
      });

      const warnings: string[] = [];
      const report = await getSnapshotReport({ warn: (message) => warnings.push(message) });

      expect(report.scanIncomplete).toBe(true);
      expect(report.snapshots[0].orphaned).toBeUndefined();
      expect(report.snapshots[0].orphanReason).toContain('could not be determined');
      expect(warnings.some((w) => w.includes('RG-AVD-HostPools'))).toBe(true);
    });

    it('refuses to assert orphaned when the RG-AVD-HostPools disk listing succeeds but returns zero disks (anomalous — the old always-empty fixture proved the wrong world)', async () => {
      snapshotsListByResourceGroup.mockImplementation((rg: string) => {
        if (rg === 'RG-AVD-Images') {
          return (async function* () {
            yield snap1();
            yield snap2();
          })();
        }
        return (async function* () {})();
      });
      // Both resource groups return an empty (but successful) disk listing —
      // the RG-AVD-HostPools side of this is the anomaly this app must not
      // trust, per the real inventory (all-resources.json) showing that RG
      // always holds session host OS disks in this estate.
      disksListByResourceGroup.mockReturnValue((async function* () {})());

      const warnings: string[] = [];
      const report = await getSnapshotReport({ warn: (message) => warnings.push(message) });

      expect(report.scanIncomplete).toBe(true);
      expect(report.snapshots.every((s) => s.orphaned === undefined)).toBe(true);
      expect(warnings.some((w) => w.includes('zero disks'))).toBe(true);
    });

    it('does NOT flag scanIncomplete when RG-AVD-HostPools genuinely has disks (the happy path)', async () => {
      wireHappyPath();

      const report = await getSnapshotReport();

      expect(report.scanIncomplete).toBe(false);
    });

    it('flags scanIncomplete when the snapshots listing itself fails for a resource group', async () => {
      snapshotsListByResourceGroup.mockImplementation((rg: string) => {
        if (rg === 'RG-AVD-Images') {
          throw new Error('transient ARM error');
        }
        return (async function* () {})();
      });
      disksListByResourceGroup.mockImplementation((rg: string) => {
        if (rg === 'RG-AVD-HostPools') {
          return (async function* () {
            yield avdVest0OsDisk();
          })();
        }
        return (async function* () {})();
      });

      const report = await getSnapshotReport();

      expect(report.scanIncomplete).toBe(true);
      expect(report.snapshots).toHaveLength(0);
    });
  });

  it('AM-26 peer review item 11: caches the report for repeated calls within the TTL, hitting the SDK only once', async () => {
    wireHappyPath();

    await getSnapshotReport();
    await getSnapshotReport();

    expect(snapshotsListByResourceGroup).toHaveBeenCalledTimes(2); // once per resource group, for the FIRST call only
  });
});
