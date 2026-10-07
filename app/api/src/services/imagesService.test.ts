import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GalleryImageVersion } from '@azure/arm-compute';
import type { HostImageCorrelationInput } from './imagesService';

const listByGalleryImage = vi.fn();
const virtualMachinesGet = vi.fn();
const listSessionHostVmRefs = vi.fn();

vi.mock('@azure/identity', () => ({
  DefaultAzureCredential: vi.fn().mockImplementation(function DefaultAzureCredential() {
    return {};
  }),
}));

vi.mock('@azure/arm-compute', () => ({
  ComputeManagementClient: vi.fn().mockImplementation(function ComputeManagementClient() {
    return {
      galleryImageVersions: { listByGalleryImage: (...args: unknown[]) => listByGalleryImage(...args) },
      virtualMachines: { get: (...args: unknown[]) => virtualMachinesGet(...args) },
    };
  }),
}));

// avdService is mocked wholesale — imagesService.ts only calls
// listSessionHostVmRefs from it, and avdService's own getClient() would
// otherwise need a DesktopVirtualizationAPIClient mock this file has no
// other use for (same "only stub what's exercised" convention as
// avdService.test.ts's own @azure/arm-desktopvirtualization mock).
vi.mock('./avdService', () => ({
  listSessionHostVmRefs: (...args: unknown[]) => listSessionHostVmRefs(...args),
}));

const { buildVersionTimeline, correlateHostsToVersions, attachHostCounts, getImageVersionsReport, _resetImageVersionsReportCacheForTests } = await import('./imagesService');
const { _resetComputeClientForTests } = await import('../lib/computeClient');

const ORIGINAL_ENV = { ...process.env };
const GALLERY_NAME = 'ACG_AVD_CONTOSO';
const IMAGE_DEFINITION_NAME = 'WIN11-ENT-MS-M365';

function versionResourceId(version: string, gallery = GALLERY_NAME, definition = IMAGE_DEFINITION_NAME): string {
  return `/subscriptions/00000000-0000-4000-8000-000000000001/resourceGroups/RG-AVD-Images/providers/Microsoft.Compute/galleries/${gallery}/images/${definition}/versions/${version}`;
}

function definitionResourceId(gallery = GALLERY_NAME, definition = IMAGE_DEFINITION_NAME): string {
  return `/subscriptions/00000000-0000-4000-8000-000000000001/resourceGroups/RG-AVD-Images/providers/Microsoft.Compute/galleries/${gallery}/images/${definition}`;
}

function armVersion(name: string, overrides: Partial<GalleryImageVersion> = {}): GalleryImageVersion {
  return {
    id: versionResourceId(name),
    name,
    publishingProfile: {
      publishedDate: new Date('2026-01-01T00:00:00Z'),
      excludeFromLatest: false,
      replicaCount: 1,
      targetRegions: [{ name: 'East US' }],
      ...overrides.publishingProfile,
    },
    provisioningState: 'Succeeded',
    ...overrides,
  } as GalleryImageVersion;
}

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  process.env.SUBSCRIPTION_ID = '00000000-0000-4000-8000-000000000001';
  process.env.RG_HOSTPOOLS = 'RG-AVD-HostPools';
  process.env.RG_IMAGES = 'RG-AVD-Images';
  process.env.HOSTPOOL_NAME = 'HP-CONTOSO-PROD';
  process.env.GALLERY_NAME = GALLERY_NAME;
  process.env.IMAGE_DEFINITION_NAME = IMAGE_DEFINITION_NAME;
  listByGalleryImage.mockReset();
  virtualMachinesGet.mockReset();
  listSessionHostVmRefs.mockReset();
  _resetImageVersionsReportCacheForTests();
  _resetComputeClientForTests();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('buildVersionTimeline', () => {
  const NOW = new Date('2026-08-15T00:00:00Z');

  it('sorts newest-first by publishedDate', () => {
    const older = armVersion('1.0.0', { publishingProfile: { publishedDate: new Date('2026-01-01T00:00:00Z') } });
    const newer = armVersion('2.0.0', { publishingProfile: { publishedDate: new Date('2026-06-01T00:00:00Z') } });

    const entries = buildVersionTimeline([older, newer], IMAGE_DEFINITION_NAME, undefined, NOW);

    expect(entries.map((e) => e.name)).toEqual(['2.0.0', '1.0.0']);
  });

  it('sorts a version with no publishedDate to the end, not the start', () => {
    const noDate = armVersion('0.9.0', { publishingProfile: { publishedDate: undefined } });
    const dated = armVersion('1.0.0', { publishingProfile: { publishedDate: new Date('2026-01-01T00:00:00Z') } });

    const entries = buildVersionTimeline([noDate, dated], IMAGE_DEFINITION_NAME, undefined, NOW);

    expect(entries.map((e) => e.name)).toEqual(['1.0.0', '0.9.0']);
  });

  it('marks exactly the pickLatest-selected version isCurrent, respecting excludeFromLatest', () => {
    const excluded = armVersion('3.0.0', { publishingProfile: { publishedDate: new Date('2026-07-01T00:00:00Z'), excludeFromLatest: true } });
    const eligible = armVersion('2.0.0', { publishingProfile: { publishedDate: new Date('2026-06-01T00:00:00Z'), excludeFromLatest: false } });

    const entries = buildVersionTimeline([excluded, eligible], IMAGE_DEFINITION_NAME, undefined, NOW);

    expect(entries.find((e) => e.name === '2.0.0')?.isCurrent).toBe(true);
    expect(entries.find((e) => e.name === '3.0.0')?.isCurrent).toBe(false);
  });

  it('marks a version isCurrent AND excludeFromLatest when EVERY version is excludeFromLatest (pickLatest fallback edge case)', () => {
    const onlyExcluded = armVersion('1.0.0', { publishingProfile: { publishedDate: new Date('2026-01-01T00:00:00Z'), excludeFromLatest: true } });

    const entries = buildVersionTimeline([onlyExcluded], IMAGE_DEFINITION_NAME, undefined, NOW);

    expect(entries[0].isCurrent).toBe(true);
    expect(entries[0].excludeFromLatest).toBe(true);
  });

  it("applies the IMAGE_EOL_DATE config fallback ONLY to the current version, not to a historical version with no endOfLifeDate of its own", () => {
    const current = armVersion('2.0.0', { publishingProfile: { publishedDate: new Date('2026-06-01T00:00:00Z'), endOfLifeDate: undefined } });
    const historical = armVersion('1.0.0', { publishingProfile: { publishedDate: new Date('2026-01-01T00:00:00Z'), endOfLifeDate: undefined } });

    const entries = buildVersionTimeline([current, historical], IMAGE_DEFINITION_NAME, '2028-02-13', NOW);

    expect(entries.find((e) => e.name === '2.0.0')?.eolDate).toBe('2028-02-13');
    expect(entries.find((e) => e.name === '1.0.0')?.eolDate).toBeUndefined();
  });

  it("prefers a version's own endOfLifeDate over the config fallback, even for the current version", () => {
    const current = armVersion('2.0.0', { publishingProfile: { publishedDate: new Date('2026-06-01T00:00:00Z'), endOfLifeDate: new Date('2027-01-01T00:00:00Z') } });

    const entries = buildVersionTimeline([current], IMAGE_DEFINITION_NAME, '2028-02-13', NOW);

    expect(entries[0].eolDate).toBe('2027-01-01');
  });

  it('maps replicationState and sizeGib off the version storageProfile/replicationStatus', () => {
    const version = armVersion('2.0.0', {
      replicationStatus: { aggregatedState: 'Completed' },
      storageProfile: { osDiskImage: { sizeInGB: 127 } },
    } as Partial<GalleryImageVersion>);

    const entries = buildVersionTimeline([version], IMAGE_DEFINITION_NAME, undefined, NOW);

    expect(entries[0].replicationState).toBe('Completed');
    expect(entries[0].sizeGib).toBe(127);
  });
});

describe('correlateHostsToVersions', () => {
  const KNOWN_VERSIONS = ['2.0.0', '1.0.0'];

  function input(overrides: Partial<HostImageCorrelationInput> = {}): HostImageCorrelationInput {
    return { sessionHostName: 'avd-con-0', ...overrides };
  }

  it('resolves a host pinned to a known version of the configured definition', () => {
    const [result] = correlateHostsToVersions([input({ imageReference: { id: versionResourceId('2.0.0') } })], KNOWN_VERSIONS, GALLERY_NAME, IMAGE_DEFINITION_NAME);

    expect(result).toEqual({ sessionHostName: 'avd-con-0', imageVersionName: '2.0.0' });
  });

  it('is case-insensitive when matching the resolved version name against knownVersionNames', () => {
    const [result] = correlateHostsToVersions([input({ imageReference: { id: versionResourceId('2.0.0').toUpperCase() } })], KNOWN_VERSIONS, GALLERY_NAME, IMAGE_DEFINITION_NAME);

    expect(result.imageVersionName).toBe('2.0.0');
  });

  it("degrades to unknown when the VM's imageReference points at a DIFFERENT gallery/definition", () => {
    const [result] = correlateHostsToVersions([input({ imageReference: { id: versionResourceId('2.0.0', 'SOME-OTHER-GALLERY') } })], KNOWN_VERSIONS, GALLERY_NAME, IMAGE_DEFINITION_NAME);

    expect(result.imageVersionName).toBeUndefined();
    expect(result.unknownReason).toContain('not the configured');
  });

  it('degrades to unknown when the version name is not in the current version list (deleted since)', () => {
    const [result] = correlateHostsToVersions([input({ imageReference: { id: versionResourceId('9.9.9') } })], KNOWN_VERSIONS, GALLERY_NAME, IMAGE_DEFINITION_NAME);

    expect(result.imageVersionName).toBeUndefined();
    expect(result.unknownReason).toContain("not in the definition's current version list");
  });

  describe('"latest" definition-id branch (no /versions/ segment) — exactVersion resolution (AM-26 peer review MAJOR 2)', () => {
    it('resolves via exactVersion when ARM reported one and it matches a known version', () => {
      const [result] = correlateHostsToVersions([input({ imageReference: { id: definitionResourceId(), exactVersion: '2.0.0' } })], KNOWN_VERSIONS, GALLERY_NAME, IMAGE_DEFINITION_NAME);

      expect(result).toEqual({ sessionHostName: 'avd-con-0', imageVersionName: '2.0.0' });
    });

    it('is case-insensitive when matching exactVersion against knownVersionNames', () => {
      const [result] = correlateHostsToVersions([input({ imageReference: { id: definitionResourceId(), exactVersion: '2.0.0'.toUpperCase() } })], KNOWN_VERSIONS, GALLERY_NAME, IMAGE_DEFINITION_NAME);

      expect(result.imageVersionName).toBe('2.0.0');
    });

    it('degrades to unknown, citing the resolved exactVersion, when exactVersion names a version not in knownVersionNames', () => {
      const [result] = correlateHostsToVersions([input({ imageReference: { id: definitionResourceId(), exactVersion: '9.9.9' } })], KNOWN_VERSIONS, GALLERY_NAME, IMAGE_DEFINITION_NAME);

      expect(result.imageVersionName).toBeUndefined();
      expect(result.unknownReason).toContain('"9.9.9"');
      expect(result.unknownReason).toContain('exactVersion');
    });

    it('falls back to the "concrete version could not be determined" reason ONLY when exactVersion is absent — and this reason no longer claims Azure never retains it', () => {
      const [result] = correlateHostsToVersions([input({ imageReference: { id: definitionResourceId() } })], KNOWN_VERSIONS, GALLERY_NAME, IMAGE_DEFINITION_NAME);

      expect(result.imageVersionName).toBeUndefined();
      expect(result.unknownReason).toContain('did not report an exactVersion');
      expect(result.unknownReason).not.toContain('does not retain');
    });

    it('still checks gallery/definition match before consulting exactVersion', () => {
      const [result] = correlateHostsToVersions(
        [input({ imageReference: { id: definitionResourceId('SOME-OTHER-GALLERY'), exactVersion: '2.0.0' } })],
        KNOWN_VERSIONS,
        GALLERY_NAME,
        IMAGE_DEFINITION_NAME,
      );

      expect(result.imageVersionName).toBeUndefined();
      expect(result.unknownReason).toContain('not the configured');
    });
  });

  it('degrades to unknown source when the VM has no imageReference at all (custom/marketplace image or unmanaged disk)', () => {
    const [result] = correlateHostsToVersions([input({ imageReference: undefined })], KNOWN_VERSIONS, GALLERY_NAME, IMAGE_DEFINITION_NAME);

    expect(result.imageVersionName).toBeUndefined();
    expect(result.unknownReason).toContain('no storageProfile.imageReference.id');
  });

  it('gives a DISTINCT reason for a SHARED gallery image reference (AM-26 peer review MINOR 6) rather than the generic "no imageReference" text', () => {
    const [result] = correlateHostsToVersions([input({ imageReference: { sharedGalleryImageId: '/sharedGalleries/foo/images/bar' } })], KNOWN_VERSIONS, GALLERY_NAME, IMAGE_DEFINITION_NAME);

    expect(result.imageVersionName).toBeUndefined();
    expect(result.unknownReason).toContain('SHARED');
    expect(result.unknownReason).not.toContain('no storageProfile.imageReference.id');
  });

  it('gives a DISTINCT reason for a COMMUNITY gallery image reference', () => {
    const [result] = correlateHostsToVersions([input({ imageReference: { communityGalleryImageId: '/communityGalleries/foo/images/bar' } })], KNOWN_VERSIONS, GALLERY_NAME, IMAGE_DEFINITION_NAME);

    expect(result.imageVersionName).toBeUndefined();
    expect(result.unknownReason).toContain('COMMUNITY');
  });

  it('degrades to unknown for a resourceId that matches neither gallery-image pattern at all', () => {
    const [result] = correlateHostsToVersions(
      [input({ imageReference: { id: '/subscriptions/x/resourceGroups/y/providers/Microsoft.Compute/images/some-custom-image' } })],
      KNOWN_VERSIONS,
      GALLERY_NAME,
      IMAGE_DEFINITION_NAME,
    );

    expect(result.imageVersionName).toBeUndefined();
    expect(result.unknownReason).toContain('not created from this gallery/definition');
  });

  it('passes a resolutionFailure straight through as the unknownReason, taking priority over imageReference', () => {
    const [result] = correlateHostsToVersions(
      [input({ resolutionFailure: 'Failed to read the VM from Azure.', imageReference: { id: versionResourceId('2.0.0') } })],
      KNOWN_VERSIONS,
      GALLERY_NAME,
      IMAGE_DEFINITION_NAME,
    );

    expect(result.imageVersionName).toBeUndefined();
    expect(result.unknownReason).toBe('Failed to read the VM from Azure.');
  });
});

describe('attachHostCounts', () => {
  it('counts hosts per matched version and reports a real 0 for a version nobody runs', () => {
    const entries = [
      { name: '2.0.0', id: 'v2', imageDefinitionName: IMAGE_DEFINITION_NAME, excludeFromLatest: false, isCurrent: true },
      { name: '1.0.0', id: 'v1', imageDefinitionName: IMAGE_DEFINITION_NAME, excludeFromLatest: false, isCurrent: false },
    ];
    const correlations = [
      { sessionHostName: 'host-0', imageVersionName: '2.0.0' },
      { sessionHostName: 'host-1', imageVersionName: '2.0.0' },
      { sessionHostName: 'host-2', unknownReason: 'nope' },
    ];

    const result = attachHostCounts(entries, correlations);

    expect(result.find((e) => e.name === '2.0.0')?.hostCount).toBe(2);
    expect(result.find((e) => e.name === '1.0.0')?.hostCount).toBe(0);
  });
});

describe('getImageVersionsReport (mocked ComputeManagementClient + avdService)', () => {
  it('lists versions, correlates hosts, and computes per-version hostCount end-to-end', async () => {
    const current = armVersion('2.0.0', { publishingProfile: { publishedDate: new Date('2026-06-01T00:00:00Z') } });
    const historical = armVersion('1.0.0', { publishingProfile: { publishedDate: new Date('2026-01-01T00:00:00Z') } });
    listByGalleryImage.mockReturnValue(
      (async function* () {
        yield current;
        yield historical;
      })(),
    );

    listSessionHostVmRefs.mockResolvedValue([
      { sessionHostName: 'avd-con-0', resourceId: '/subscriptions/00000000-0000-4000-8000-000000000001/resourceGroups/RG-AVD-HostPools/providers/Microsoft.Compute/virtualMachines/avd-con-0' },
      { sessionHostName: 'avd-con-1', resourceId: undefined },
    ]);

    virtualMachinesGet.mockImplementation(async (rg: string, name: string) => {
      if (rg === 'RG-AVD-HostPools' && name === 'avd-con-0') {
        return { storageProfile: { imageReference: { id: versionResourceId('2.0.0') } } };
      }
      throw new Error(`unexpected VM lookup ${rg}/${name}`);
    });

    const report = await getImageVersionsReport();

    expect(report.imageDefinitionName).toBe(IMAGE_DEFINITION_NAME);
    expect(report.versions.map((v) => v.name)).toEqual(['2.0.0', '1.0.0']);
    expect(report.versions.find((v) => v.name === '2.0.0')?.hostCount).toBe(1);
    expect(report.versions.find((v) => v.name === '1.0.0')?.hostCount).toBe(0);

    const resolved = report.hostCorrelations.find((c) => c.sessionHostName === 'avd-con-0');
    expect(resolved?.imageVersionName).toBe('2.0.0');

    const unresolved = report.hostCorrelations.find((c) => c.sessionHostName === 'avd-con-1');
    expect(unresolved?.imageVersionName).toBeUndefined();
    expect(unresolved?.unknownReason).toContain('resourceId is missing');
  });

  it("degrades ONLY the affected host to 'unknown source' when its VM read fails, without failing the whole report", async () => {
    const current = armVersion('2.0.0');
    listByGalleryImage.mockReturnValue(
      (async function* () {
        yield current;
      })(),
    );
    listSessionHostVmRefs.mockResolvedValue([
      { sessionHostName: 'avd-con-0', resourceId: '/subscriptions/00000000-0000-4000-8000-000000000001/resourceGroups/RG-AVD-HostPools/providers/Microsoft.Compute/virtualMachines/avd-con-0' },
    ]);
    virtualMachinesGet.mockRejectedValue(new Error('transient ARM error'));

    const warnings: string[] = [];
    const report = await getImageVersionsReport({ warn: (message) => warnings.push(message) });

    expect(report.versions[0].hostCount).toBe(0);
    expect(report.hostCorrelations[0].unknownReason).toContain('Failed to read the VM from Azure');
    expect(warnings.some((w) => w.includes('avd-con-0'))).toBe(true);
  });

  it('AM-26 peer review item 11: caches the report for repeated calls within the TTL, hitting listByGalleryImage only once', async () => {
    listByGalleryImage.mockReturnValue(
      (async function* () {
        yield armVersion('2.0.0');
      })(),
    );
    listSessionHostVmRefs.mockResolvedValue([]);

    await getImageVersionsReport();
    await getImageVersionsReport();

    expect(listByGalleryImage).toHaveBeenCalledTimes(1);
  });

  it('bounds per-host VM lookups to VM_LOOKUP_CONCURRENCY (8) in-flight at once, not one unbounded fan-out', async () => {
    listByGalleryImage.mockReturnValue(
      (async function* () {
        yield armVersion('2.0.0');
      })(),
    );
    const hostCount = 20;
    listSessionHostVmRefs.mockResolvedValue(
      Array.from({ length: hostCount }, (_, i) => ({
        sessionHostName: `avd-con-${i}`,
        resourceId: `/subscriptions/00000000-0000-4000-8000-000000000001/resourceGroups/RG-AVD-HostPools/providers/Microsoft.Compute/virtualMachines/avd-con-${i}`,
      })),
    );

    let inFlight = 0;
    let maxInFlight = 0;
    virtualMachinesGet.mockImplementation(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return { storageProfile: { imageReference: { id: versionResourceId('2.0.0') } } };
    });

    const report = await getImageVersionsReport();

    expect(maxInFlight).toBeLessThanOrEqual(8);
    expect(report.versions[0].hostCount).toBe(hostCount);
  });
});
