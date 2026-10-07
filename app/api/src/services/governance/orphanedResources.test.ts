import { describe, expect, it } from 'vitest';
import { evaluateOrphanedResources, type OrphanScanRawData } from './orphanedResources';

/**
 * Fixtures grounded in the estate's own live captures (see gap register
 * items 1, 2, 9, 14) rather than invented data — this check's whole purpose
 * is to keep those specific findings live, so the tests should fail loudly
 * if the evaluation logic ever stops surfacing them.
 *
 * Note: gap item 5 (the idle-host leak — a disconnected session preventing
 * ramp-down deallocation) is a BEHAVIORAL/runtime finding already covered
 * by the separate idle-host detector (app/api/src/services/
 * idleHostDetector.ts, AM-25's Cost & Scaling page) — this orphan/hygiene
 * scanner deliberately does not duplicate it; it is out of scope for a
 * point-in-time resource inventory scan.
 */
function emptyScan(): OrphanScanRawData {
  return {
    taggableResources: [],
    taggableResourcesTruncated: false,
    snapshots: [],
    snapshotsTruncated: false,
    disks: [],
    disksTruncated: false,
    privateDnsZones: [],
    privateDnsZonesTruncated: false,
    subnets: [],
    subnetsTruncated: false,
    networkInterfaces: [],
    networkInterfacesTruncated: false,
    publicIps: [],
    publicIpsTruncated: false,
  };
}

describe('evaluateOrphanedResources', () => {
  it('passes when nothing is found', () => {
    const result = evaluateOrphanedResources(emptyScan());
    expect(result.status).toBe('pass');
  });

  describe('snapshot orphan detection (peer review item 1)', () => {
    it('does NOT flag a snapshot whose source disk still exists — diskState: Unattached alone is not a signal', () => {
      const scan: OrphanScanRawData = {
        ...emptyScan(),
        disks: [{ name: 'VM-IMG-WIN11-002_OsDisk', properties: { diskState: 'Attached' }, managedBy: '/vm/1' }],
        snapshots: [
          {
            name: 'SNAP-WIN11-CURRENT',
            properties: { diskState: 'Unattached', creationData: { sourceResourceId: '/subscriptions/sub/resourceGroups/RG-AVD-Images/providers/Microsoft.Compute/disks/VM-IMG-WIN11-002_OsDisk' } },
          },
        ],
      };
      const result = evaluateOrphanedResources(scan);
      expect(result.status).toBe('pass');
    });

    it('surfaces the 2 known orphaned pre-Sysprep snapshots (gap register item 1) — sourceResourceId names a disk NOT in the fetched disk lists', () => {
      const scan: OrphanScanRawData = {
        ...emptyScan(),
        disks: [{ name: 'some-other-disk', properties: { diskState: 'Attached' }, managedBy: '/vm/1' }],
        snapshots: [
          {
            name: 'SNAP-WIN11-PRE-SYSPREP-1.0.0',
            properties: {
              diskState: 'Unattached',
              creationData: { sourceResourceId: '/subscriptions/sub/resourceGroups/RG-AVD-Images/providers/Microsoft.Compute/disks/VM-IMG-WIN11-001_OsDisk_1_35d12340d95a4e56a63d8ae1d05a3bab' },
            },
          },
          {
            name: 'SNAP-WIN11-PRE-SYSPREP-2.0.0',
            properties: {
              diskState: 'Unattached',
              creationData: { sourceResourceId: '/subscriptions/sub/resourceGroups/RG-AVD-Images/providers/Microsoft.Compute/disks/VM-IMG-WIN11-001-OsDisk-v2' },
            },
          },
        ],
      };
      const result = evaluateOrphanedResources(scan);
      expect(result.status).toBe('warn');
      expect(result.summary).toContain('2 orphaned snapshot(s)');
      expect(result.evidence.orphanedSnapshots).toMatchObject({
        totalCount: 2,
        items: ['SNAP-WIN11-PRE-SYSPREP-1.0.0', 'SNAP-WIN11-PRE-SYSPREP-2.0.0'],
      });
    });

    it('flags a snapshot with no resolvable sourceResourceId at all', () => {
      const scan: OrphanScanRawData = { ...emptyScan(), snapshots: [{ name: 'SNAP-NO-SOURCE', properties: {} }] };
      const result = evaluateOrphanedResources(scan);
      expect(result.status).toBe('warn');
      expect(result.evidence.orphanedSnapshots).toMatchObject({ totalCount: 1 });
    });
  });

  describe('NIC exclusions (peer review item 2)', () => {
    it('does NOT flag a private-endpoint NIC as unattached', () => {
      const scan: OrphanScanRawData = { ...emptyScan(), networkInterfaces: [{ name: 'PE-KV-AVD-PROD-nic', properties: { privateEndpoint: { id: '/pe/1' } } }] };
      expect(evaluateOrphanedResources(scan).status).toBe('pass');
    });

    it('does NOT flag a private-link-service NIC as unattached', () => {
      const scan: OrphanScanRawData = { ...emptyScan(), networkInterfaces: [{ name: 'pls-nic', properties: { privateLinkService: { id: '/pls/1' } } }] };
      expect(evaluateOrphanedResources(scan).status).toBe('pass');
    });

    it('does NOT flag a load-balancer-backend NIC as unattached', () => {
      const scan: OrphanScanRawData = {
        ...emptyScan(),
        networkInterfaces: [{ name: 'lb-nic', properties: { ipConfigurations: [{ properties: { loadBalancerBackendAddressPools: [{ id: '/lb/1' }] } }] } }],
      };
      expect(evaluateOrphanedResources(scan).status).toBe('pass');
    });

    it('DOES flag a genuinely unattached NIC', () => {
      const scan: OrphanScanRawData = { ...emptyScan(), networkInterfaces: [{ name: 'orphan-nic', properties: {} }] };
      const result = evaluateOrphanedResources(scan);
      expect(result.status).toBe('warn');
      expect(result.evidence.unattachedNetworkInterfaces).toMatchObject({ totalCount: 1, items: ['orphan-nic'] });
    });
  });

  describe('subnet occupancy (peer review item 3)', () => {
    it('does NOT flag SNET-MANAGEMENT as empty when it carries a delegation', () => {
      const scan: OrphanScanRawData = { ...emptyScan(), subnets: [{ name: 'SNET-MANAGEMENT', properties: { delegations: [{ id: '/deleg/1' }] } }] };
      expect(evaluateOrphanedResources(scan).status).toBe('pass');
    });

    it('does NOT flag the private-endpoint subnet as empty when it carries privateEndpoints but no ipConfigurations', () => {
      const scan: OrphanScanRawData = { ...emptyScan(), subnets: [{ name: 'SNET-PRIVATEENDPOINTS', properties: { ipConfigurations: [], privateEndpoints: [{ id: '/pe/1' }] } }] };
      expect(evaluateOrphanedResources(scan).status).toBe('pass');
    });

    it('does NOT flag a subnet occupied only via serviceAssociationLinks or ipConfigurationProfiles', () => {
      const scan: OrphanScanRawData = { ...emptyScan(), subnets: [{ name: 'SNET-SVC', properties: { serviceAssociationLinks: [{ id: '/sal/1' }] } }] };
      expect(evaluateOrphanedResources(scan).status).toBe('pass');
    });

    it('DOES flag a genuinely empty subnet (all five occupancy signals absent)', () => {
      const scan: OrphanScanRawData = { ...emptyScan(), subnets: [{ name: 'SNET-TRULY-EMPTY', properties: {} }] };
      const result = evaluateOrphanedResources(scan);
      expect(result.status).toBe('warn');
      expect(result.evidence.emptySubnets).toMatchObject({ totalCount: 1, items: ['SNET-TRULY-EMPTY'] });
    });
  });

  describe('public IP attachment (peer review item 4)', () => {
    it('does NOT flag a NAT-gateway-attached PIP', () => {
      const scan: OrphanScanRawData = { ...emptyScan(), publicIps: [{ name: 'pip-natgw', properties: { natGateway: { id: '/natgw/1' } } }] };
      expect(evaluateOrphanedResources(scan).status).toBe('pass');
    });

    it('does NOT flag a load-balancer-frontend PIP', () => {
      const scan: OrphanScanRawData = { ...emptyScan(), publicIps: [{ name: 'pip-lb', properties: { loadBalancerFrontendIpConfiguration: { id: '/lb/1' } } }] };
      expect(evaluateOrphanedResources(scan).status).toBe('pass');
    });

    it('does NOT flag a cross-region-linked PIP', () => {
      const scan: OrphanScanRawData = { ...emptyScan(), publicIps: [{ name: 'pip-linked', properties: { linkedPublicIPAddress: { id: '/pip/2' } } }] };
      expect(evaluateOrphanedResources(scan).status).toBe('pass');
    });

    it('DOES flag a genuinely unattached PIP', () => {
      const scan: OrphanScanRawData = { ...emptyScan(), publicIps: [{ name: 'orphan-pip', properties: {} }] };
      const result = evaluateOrphanedResources(scan);
      expect(result.status).toBe('warn');
      expect(result.evidence.unattachedPublicIps).toMatchObject({ totalCount: 1 });
    });
  });

  describe('untagged-resource sub-scan (peer review item 7)', () => {
    it('reports "no tag policy configured" as informational, NOT findings, when requiredTags is empty', () => {
      const scan: OrphanScanRawData = { ...emptyScan(), taggableResources: [{ id: '1', name: 'res-1', type: 'Microsoft.Compute/disks', tags: undefined }] };
      const result = evaluateOrphanedResources(scan, []);
      expect(result.status).toBe('pass');
      expect(result.evidence.untaggedResources).toMatchObject({ policyConfigured: false });
    });

    it('flags a resource missing a configured required tag, naming which tag is missing', () => {
      const scan: OrphanScanRawData = { ...emptyScan(), taggableResources: [{ id: '1', name: 'res-1', type: 'Microsoft.Compute/disks', tags: { owner: 'it' } }] };
      const result = evaluateOrphanedResources(scan, ['owner', 'environment']);
      expect(result.status).toBe('warn');
      expect(result.evidence.untaggedResources).toMatchObject({ totalCount: 1, items: [{ name: 'res-1', missingTags: ['environment'] }] });
    });

    it('does not flag a resource that carries every required tag', () => {
      const scan: OrphanScanRawData = { ...emptyScan(), taggableResources: [{ id: '1', name: 'res-1', type: 'Microsoft.Compute/disks', tags: { owner: 'it', environment: 'prod' } }] };
      expect(evaluateOrphanedResources(scan, ['owner', 'environment']).status).toBe('pass');
    });

    it('excludes non-taggable child/extension resource types from the required-tag scan', () => {
      const scan: OrphanScanRawData = {
        ...emptyScan(),
        taggableResources: [{ id: '1', name: 'avd-con-0/AADLoginForWindows', type: 'Microsoft.Compute/virtualMachines/extensions', tags: undefined }],
      };
      expect(evaluateOrphanedResources(scan, ['owner']).status).toBe('pass');
    });
  });

  it('flags an unused private DNS zone (gap register item 9: numberOfRecordSets <= 1)', () => {
    const scan: OrphanScanRawData = { ...emptyScan(), privateDnsZones: [{ name: 'privatelink.blob.core.windows.net', properties: { numberOfRecordSets: 1 } }] };
    const result = evaluateOrphanedResources(scan);
    expect(result.status).toBe('warn');
    expect(result.summary).toContain('unused private DNS zone(s)');
  });

  describe('truncation surfacing (peer review item 6)', () => {
    it('bounds the evidence list and reports truncated:true when a sub-finding exceeds the display limit', () => {
      const manyUntagged = Array.from({ length: 20 }, (_, i) => ({ id: `id-${i}`, name: `res-${i}`, type: 'Microsoft.Compute/disks', tags: {} }));
      const scan: OrphanScanRawData = { ...emptyScan(), taggableResources: manyUntagged };
      const result = evaluateOrphanedResources(scan, ['owner']);
      const evidence = result.evidence.untaggedResources as { totalCount: number; truncated: boolean; items: unknown[] };
      expect(evidence.totalCount).toBe(20);
      expect(evidence.truncated).toBe(true);
      expect(evidence.items.length).toBeLessThan(20);
    });

    it('surfaces truncated:true from an underlying ARM list page-ceiling, not just the display-limit bound', () => {
      const scan: OrphanScanRawData = { ...emptyScan(), subnets: [{ name: 'SNET-A', properties: {} }], subnetsTruncated: true };
      const result = evaluateOrphanedResources(scan);
      const evidence = result.evidence.emptySubnets as { truncated: boolean };
      expect(evidence.truncated).toBe(true);
      expect(result.evidence.anyListTruncated).toBe(true);
      expect(result.summary).toContain('partial scan');
    });
  });
});
