import type { GovernanceCheckResult } from '@avdmgr/shared';
import { armList } from '../../lib/armRest';
import { getConfig } from '../../lib/config';
import { boundList, buildResult } from './support';

/*
 * Check 7: orphaned/hygiene resource scanner — untagged resources, orphaned
 * snapshots, unused private DNS zones, empty subnets, unattached disks/
 * NICs/public IPs, across the six tracked resource groups. Every
 * sub-finding here traces to a SPECIFIC the gap register
 * row (cited per sub-scan below) — this check exists to keep those findings
 * LIVE rather than re-verifying them by hand against a point-in-time
 * inventory capture.
 *
 * Deliberately Low-severity-only (pass/warn, NEVER fail): every one of these
 * is a hygiene/cost finding in the gap register (items 1, 9, 14 are all
 * rated Low), not a security control whose absence should read as severe as
 * check 1/2's fail-capable findings.
 *
 * Opus peer review corrections (all Microsoft Learn-verified — see each
 * sub-scan's own comment below for the specific field/citation):
 *   - snapshot orphan detection no longer keys off diskState — Unattached
 *     is a snapshot's NORMAL state (a snapshot is never "attached" to
 *     anything the way a disk is), so the original heuristic flagged EVERY
 *     snapshot on every run. Gated on creationData.sourceResourceId
 *     instead, cross-referenced against the disks this scan already fetches
 *     — exactly how gap register item 1 was actually derived.
 *   - NIC/subnet/PIP "unattached"/"empty" heuristics excluded the estate's
 *     own live-in-use resources (the 5 private-endpoint NICs, SNET-
 *     MANAGEMENT, the PE subnet) as false positives on every run — fixed
 *     per-field below.
 *   - the VNet name is now config-driven (governance.vnetName), not
 *     hard-coded — a renamed VNet must 404 loudly (armList's default
 *     throw-on-404), not silently read as "no empty subnets found."
 *   - the untagged-resource sub-scan is now driven by an OPERATOR-configured
 *     required-tag set (governance.requiredTags) — with none configured, it
 *     reports that fact as informational evidence, not manufactured
 *     findings this app has no policy basis to make.
 *
 * API versions — verified against Microsoft Learn's ARM template reference
 * for each resource type: Microsoft.Resources (generic resource LIST)
 * 2021-04-01; Microsoft.Compute/snapshots + disks 2023-04-02;
 * Microsoft.Network/privateDnsZones 2020-06-01 (this resource type's own,
 * older, still-current namespace — distinct from the 2023-09-01 this file
 * uses for privateEndpoints/networkInterfaces/publicIPAddresses/subnets,
 * which are a different Microsoft.Network sub-API generation); RBAC: plain
 * Reader everywhere — no new grant beyond what checks 1/3/6 already add
 * (RG-AVD-Security is NOT scanned here — nothing orphan-scan-worthy is
 * expected there and scanning it would need yet another RBAC grant this app
 * doesn't otherwise need).
 */

const RESOURCES_API_VERSION = '2021-04-01';
const COMPUTE_API_VERSION = '2023-04-02';
const PRIVATE_DNS_API_VERSION = '2020-06-01';
const NETWORK_API_VERSION = '2023-09-01';

/** Bound on how many example names are surfaced per sub-finding — real counts are always reported alongside (see support.ts#boundList). */
const EVIDENCE_LIMIT = 15;

interface ArmGenericResource {
  id?: string;
  name?: string;
  type?: string;
  tags?: Record<string, string>;
}
interface ArmSnapshot {
  name?: string;
  properties?: { diskState?: string; creationData?: { sourceResourceId?: string } };
}
interface ArmDisk {
  name?: string;
  managedBy?: string;
  properties?: { diskState?: string };
}
interface ArmPrivateDnsZone {
  name?: string;
  properties?: { numberOfRecordSets?: number };
}
interface ArmSubnet {
  name?: string;
  properties?: {
    ipConfigurations?: unknown[];
    privateEndpoints?: unknown[];
    ipConfigurationProfiles?: unknown[];
    serviceAssociationLinks?: unknown[];
    delegations?: unknown[];
  };
}
interface ArmNetworkInterface {
  name?: string;
  properties?: {
    virtualMachine?: { id?: string };
    privateEndpoint?: { id?: string };
    privateLinkService?: { id?: string };
    ipConfigurations?: Array<{ properties?: { loadBalancerBackendAddressPools?: unknown[] } }>;
  };
}
interface ArmPublicIp {
  name?: string;
  properties?: {
    ipConfiguration?: { id?: string };
    natGateway?: { id?: string };
    loadBalancerFrontendIpConfiguration?: { id?: string };
    linkedPublicIPAddress?: { id?: string };
  };
}

export interface OrphanScanRawData {
  taggableResources: ArmGenericResource[];
  taggableResourcesTruncated: boolean;
  snapshots: ArmSnapshot[];
  snapshotsTruncated: boolean;
  /** Also the cross-reference set for snapshot orphan detection (peer review item 1) — every disk this scan fetches across RG-AVD-HostPools/Images. */
  disks: ArmDisk[];
  disksTruncated: boolean;
  privateDnsZones: ArmPrivateDnsZone[];
  privateDnsZonesTruncated: boolean;
  subnets: ArmSubnet[];
  subnetsTruncated: boolean;
  networkInterfaces: ArmNetworkInterface[];
  networkInterfacesTruncated: boolean;
  publicIps: ArmPublicIp[];
  publicIpsTruncated: boolean;
}

/** Resource types this scan does not consider "taggable" for the untagged-resource sub-finding — child/extension resource types Azure itself never lets you tag independently of their parent. */
const UNTAGGABLE_TYPE_SUFFIXES = ['/extensions', '/virtualNetworkLinks', '/subnets'];

function isTaggable(resource: ArmGenericResource): boolean {
  const type = resource.type ?? '';
  return !UNTAGGABLE_TYPE_SUFFIXES.some((suffix) => type.endsWith(suffix));
}

/**
 * Extracts the disk NAME (not full resource id) from a
 * `.../providers/Microsoft.Compute/disks/{name}` resource id — used to
 * cross-reference a snapshot's creationData.sourceResourceId against the
 * disks this scan already fetched (peer review item 1). Returns undefined
 * for anything that doesn't match that exact shape (including a
 * sourceResourceId pointing at something OTHER than a managed disk, e.g. a
 * storage blob URI for an unmanaged-disk snapshot — genuinely not
 * resolvable against this app's disk list, treated the same as "no known
 * source disk" by isSnapshotOrphaned below).
 */
function diskNameFromResourceId(resourceId: string | undefined): string | undefined {
  if (!resourceId) return undefined;
  const match = /\/providers\/Microsoft\.Compute\/disks\/([^/]+)$/i.exec(resourceId);
  return match ? match[1] : undefined;
}

/**
 * A snapshot is orphaned when its creationData.sourceResourceId either
 * isn't present/resolvable at all, or names a disk that is NOT among the
 * disks this scan fetched (peer review item 1 — this is exactly how gap
 * register item 1's two SNAP-WIN11-PRE-SYSPREP snapshots were identified:
 * "source disk no longer exists"). Deliberately NOT keyed off
 * `properties.diskState` — Unattached is a snapshot's normal, permanent
 * state (a snapshot is a point-in-time copy, never "attached" the way a
 * disk can be to a VM), so that field carries no orphan signal for this
 * resource type at all.
 */
function isSnapshotOrphaned(snapshot: ArmSnapshot, knownDiskNamesLower: Set<string>): boolean {
  const sourceDiskName = diskNameFromResourceId(snapshot.properties?.creationData?.sourceResourceId);
  if (!sourceDiskName) return true;
  return !knownDiskNamesLower.has(sourceDiskName.toLowerCase());
}

/**
 * A subnet is occupied — NOT empty — if ANY of these five properties is
 * non-empty (peer review item 3, all five verified against Microsoft
 * Learn's virtualNetworks/subnets ARM template reference): ipConfigurations
 * (a NIC's IP config directly in the subnet), privateEndpoints (a Private
 * Endpoint's NIC, which is otherwise invisible via ipConfigurations),
 * ipConfigurationProfiles (used by delegated-service resources like
 * Container Apps environments), serviceAssociationLinks (a delegated
 * service's own reservation of the subnet), delegations (the subnet's
 * `Microsoft.App/environments` delegation itself — SNET-MANAGEMENT's own
 * case, this app's Function App). The original diskState-style
 * ipConfigurations-only check read SNET-MANAGEMENT (delegated, no NIC of
 * its own) and the private-endpoint subnet (occupied via
 * privateEndpoints, not ipConfigurations) as empty on every run.
 */
function isSubnetOccupied(subnet: ArmSubnet): boolean {
  const p = subnet.properties;
  return (
    (p?.ipConfigurations?.length ?? 0) > 0 ||
    (p?.privateEndpoints?.length ?? 0) > 0 ||
    (p?.ipConfigurationProfiles?.length ?? 0) > 0 ||
    (p?.serviceAssociationLinks?.length ?? 0) > 0 ||
    (p?.delegations?.length ?? 0) > 0
  );
}

/**
 * A NIC is excluded from the "unattached" sub-scan (peer review item 2) if
 * it belongs to a Private Endpoint (`properties.privateEndpoint`) or a
 * Private Link Service (`properties.privateLinkService`) — both are
 * legitimate, permanently-VM-less NIC uses documented on Microsoft Learn's
 * networkInterfaces ARM template reference — or if any of its
 * ipConfigurations is a load-balancer backend-pool member
 * (`loadBalancerBackendAddressPools`), another legitimate non-VM NIC
 * attachment. Without this, this estate's 5 private-endpoint NICs (see
 * The estate inventory §3) read as findings on every run.
 */
function isNicExcludedFromUnattachedScan(nic: ArmNetworkInterface): boolean {
  if (nic.properties?.privateEndpoint?.id) return true;
  if (nic.properties?.privateLinkService?.id) return true;
  return (nic.properties?.ipConfigurations ?? []).some((ipc) => (ipc.properties?.loadBalancerBackendAddressPools?.length ?? 0) > 0);
}

/**
 * A public IP is considered attached (peer review item 4) if it's bound to
 * a NIC/LB-frontend ipConfiguration (`ipConfiguration`), a NAT gateway
 * (`natGateway`), a load balancer frontend specifically
 * (`loadBalancerFrontendIpConfiguration`), or is the linked address of a
 * cross-region load balancer setup (`linkedPublicIPAddress`) — all
 * documented properties on Microsoft Learn's publicIPAddress reference.
 */
function isPipAttached(pip: ArmPublicIp): boolean {
  const p = pip.properties;
  return Boolean(p?.ipConfiguration?.id || p?.natGateway?.id || p?.loadBalancerFrontendIpConfiguration?.id || p?.linkedPublicIPAddress?.id);
}

interface UntaggedFinding {
  name: string;
  missingTags: string[];
}

/**
 * Peer review item 7: driven by an OPERATOR-configured required-tag set
 * (governance.requiredTags, REQUIRED_TAGS app setting). With no policy
 * configured (the default), this returns `policyConfigured: false` and an
 * empty findings list — informational, not a manufactured finding — since
 * this app has no basis to call any resource's tags "wrong" without an
 * operator having stated what's required. Once configured, a resource
 * missing ANY listed key is reported, naming which key(s) are missing.
 */
function evaluateUntaggedResources(resources: ArmGenericResource[], requiredTags: string[]): { policyConfigured: boolean; findings: UntaggedFinding[] } {
  if (requiredTags.length === 0) {
    return { policyConfigured: false, findings: [] };
  }
  const findings: UntaggedFinding[] = [];
  for (const resource of resources) {
    if (!isTaggable(resource)) continue;
    const tags = resource.tags ?? {};
    const missingTags = requiredTags.filter((tag) => !(tag in tags));
    if (missingTags.length > 0) {
      findings.push({ name: resource.name ?? 'unknown', missingTags });
    }
  }
  return { policyConfigured: true, findings };
}

export function evaluateOrphanedResources(data: OrphanScanRawData, requiredTags: string[] = []): GovernanceCheckResult {
  const base = { id: 'orphaned-resources', title: 'Orphaned & untagged resource scan', category: 'Hygiene' };

  const untaggedResult = evaluateUntaggedResources(data.taggableResources, requiredTags);
  const untagged = boundList(untaggedResult.findings, EVIDENCE_LIMIT);

  const knownDiskNamesLower = new Set(data.disks.map((d) => (d.name ?? '').toLowerCase()).filter(Boolean));
  const orphanedSnapshots = boundList(
    data.snapshots.filter((s) => isSnapshotOrphaned(s, knownDiskNamesLower)).map((s) => s.name ?? 'unknown'),
    EVIDENCE_LIMIT,
  );
  // Register item 9: a private DNS zone with <=1 record set has, at most,
  // its auto-created SOA record — no A/CNAME records were ever added, i.e.
  // nothing actually resolves through it.
  const unusedDnsZones = boundList(
    data.privateDnsZones.filter((z) => (z.properties?.numberOfRecordSets ?? 0) <= 1).map((z) => z.name ?? 'unknown'),
    EVIDENCE_LIMIT,
  );
  const emptySubnets = boundList(
    data.subnets.filter((s) => !isSubnetOccupied(s)).map((s) => s.name ?? 'unknown'),
    EVIDENCE_LIMIT,
  );
  const unattachedDisks = boundList(
    data.disks.filter((d) => d.properties?.diskState === 'Unattached' && !d.managedBy).map((d) => d.name ?? 'unknown'),
    EVIDENCE_LIMIT,
  );
  const unattachedNics = boundList(
    data.networkInterfaces.filter((n) => !n.properties?.virtualMachine?.id && !isNicExcludedFromUnattachedScan(n)).map((n) => n.name ?? 'unknown'),
    EVIDENCE_LIMIT,
  );
  const unattachedPips = boundList(
    data.publicIps.filter((p) => !isPipAttached(p)).map((p) => p.name ?? 'unknown'),
    EVIDENCE_LIMIT,
  );

  const anyTruncated =
    data.taggableResourcesTruncated ||
    data.snapshotsTruncated ||
    data.disksTruncated ||
    data.privateDnsZonesTruncated ||
    data.subnetsTruncated ||
    data.networkInterfacesTruncated ||
    data.publicIpsTruncated;

  const evidence = {
    untaggedResources: untaggedResult.policyConfigured
      ? untagged
      : { policyConfigured: false, note: 'No required-tag policy configured (REQUIRED_TAGS app setting) — this sub-scan is informational only, not a finding.' },
    orphanedSnapshots: { ...orphanedSnapshots, truncated: orphanedSnapshots.truncated || data.snapshotsTruncated || data.disksTruncated },
    unusedPrivateDnsZones: { ...unusedDnsZones, truncated: unusedDnsZones.truncated || data.privateDnsZonesTruncated },
    emptySubnets: { ...emptySubnets, truncated: emptySubnets.truncated || data.subnetsTruncated },
    unattachedDisks: { ...unattachedDisks, truncated: unattachedDisks.truncated || data.disksTruncated },
    unattachedNetworkInterfaces: { ...unattachedNics, truncated: unattachedNics.truncated || data.networkInterfacesTruncated },
    unattachedPublicIps: { ...unattachedPips, truncated: unattachedPips.truncated || data.publicIpsTruncated },
    /** True if ANY underlying ARM list hit its page ceiling — every sub-finding's own counts may then be a partial view, not just the ones flagged truncated individually above (peer review item 6). */
    anyListTruncated: anyTruncated,
  };

  const totalFindings =
    untaggedResult.findings.length +
    orphanedSnapshots.totalCount +
    unusedDnsZones.totalCount +
    emptySubnets.totalCount +
    unattachedDisks.totalCount +
    unattachedNics.totalCount +
    unattachedPips.totalCount;

  if (totalFindings === 0) {
    return buildResult({
      ...base,
      status: 'pass',
      summary: anyTruncated
        ? 'No orphaned, untagged, or unattached resources found in the results retrieved so far — one or more lists hit the page ceiling, so this is a partial scan (see evidence.anyListTruncated).'
        : 'No orphaned, untagged, or unattached resources found.',
      evidence,
    });
  }

  const parts: string[] = [];
  if (untaggedResult.findings.length) parts.push(`${untaggedResult.findings.length} resource(s) missing required tag(s)`);
  if (orphanedSnapshots.totalCount) parts.push(`${orphanedSnapshots.totalCount} orphaned snapshot(s)`);
  if (unusedDnsZones.totalCount) parts.push(`${unusedDnsZones.totalCount} unused private DNS zone(s)`);
  if (emptySubnets.totalCount) parts.push(`${emptySubnets.totalCount} empty subnet(s)`);
  if (unattachedDisks.totalCount) parts.push(`${unattachedDisks.totalCount} unattached disk(s)`);
  if (unattachedNics.totalCount) parts.push(`${unattachedNics.totalCount} unattached NIC(s)`);
  if (unattachedPips.totalCount) parts.push(`${unattachedPips.totalCount} unattached public IP(s)`);

  return buildResult({
    ...base,
    status: 'warn',
    summary: `Found: ${parts.join(', ')}.${anyTruncated ? ' One or more result lists hit the page ceiling — this is a partial scan.' : ''}`,
    evidence,
  });
}

export async function fetchOrphanedResources(): Promise<GovernanceCheckResult> {
  const { subscriptionId, resourceGroups, governance } = getConfig();
  const trackedRgs = [resourceGroups.hostPools, resourceGroups.images, resourceGroups.monitoring, resourceGroups.management, resourceGroups.network, resourceGroups.storage];

  const [
    taggableResourceLists,
    snapshotsResult,
    privateDnsZonesResult,
    subnetsResult,
    hostPoolDisksResult,
    imageDisksResult,
    hostPoolNicsResult,
    networkNicsResult,
    hostPoolPipsResult,
    networkPipsResult,
  ] = await Promise.all([
    Promise.all(trackedRgs.map((rg) => armList<ArmGenericResource>(`/subscriptions/${subscriptionId}/resourceGroups/${rg}/resources`, RESOURCES_API_VERSION))),
    armList<ArmSnapshot>(`/subscriptions/${subscriptionId}/resourceGroups/${resourceGroups.images}/providers/Microsoft.Compute/snapshots`, COMPUTE_API_VERSION),
    armList<ArmPrivateDnsZone>(`/subscriptions/${subscriptionId}/resourceGroups/${resourceGroups.network}/providers/Microsoft.Network/privateDnsZones`, PRIVATE_DNS_API_VERSION),
    armList<ArmSubnet>(`/subscriptions/${subscriptionId}/resourceGroups/${resourceGroups.network}/providers/Microsoft.Network/virtualNetworks/${governance.vnetName}/subnets`, NETWORK_API_VERSION),
    armList<ArmDisk>(`/subscriptions/${subscriptionId}/resourceGroups/${resourceGroups.hostPools}/providers/Microsoft.Compute/disks`, COMPUTE_API_VERSION),
    armList<ArmDisk>(`/subscriptions/${subscriptionId}/resourceGroups/${resourceGroups.images}/providers/Microsoft.Compute/disks`, COMPUTE_API_VERSION),
    armList<ArmNetworkInterface>(`/subscriptions/${subscriptionId}/resourceGroups/${resourceGroups.hostPools}/providers/Microsoft.Network/networkInterfaces`, NETWORK_API_VERSION),
    armList<ArmNetworkInterface>(`/subscriptions/${subscriptionId}/resourceGroups/${resourceGroups.network}/providers/Microsoft.Network/networkInterfaces`, NETWORK_API_VERSION),
    armList<ArmPublicIp>(`/subscriptions/${subscriptionId}/resourceGroups/${resourceGroups.hostPools}/providers/Microsoft.Network/publicIPAddresses`, NETWORK_API_VERSION),
    armList<ArmPublicIp>(`/subscriptions/${subscriptionId}/resourceGroups/${resourceGroups.network}/providers/Microsoft.Network/publicIPAddresses`, NETWORK_API_VERSION),
  ]);

  return evaluateOrphanedResources(
    {
      taggableResources: taggableResourceLists.flatMap((r) => r.items),
      taggableResourcesTruncated: taggableResourceLists.some((r) => r.truncated),
      snapshots: snapshotsResult.items,
      snapshotsTruncated: snapshotsResult.truncated,
      disks: [...hostPoolDisksResult.items, ...imageDisksResult.items],
      disksTruncated: hostPoolDisksResult.truncated || imageDisksResult.truncated,
      privateDnsZones: privateDnsZonesResult.items,
      privateDnsZonesTruncated: privateDnsZonesResult.truncated,
      subnets: subnetsResult.items,
      subnetsTruncated: subnetsResult.truncated,
      networkInterfaces: [...hostPoolNicsResult.items, ...networkNicsResult.items],
      networkInterfacesTruncated: hostPoolNicsResult.truncated || networkNicsResult.truncated,
      publicIps: [...hostPoolPipsResult.items, ...networkPipsResult.items],
      publicIpsTruncated: hostPoolPipsResult.truncated || networkPipsResult.truncated,
    },
    governance.requiredTags,
  );
}
