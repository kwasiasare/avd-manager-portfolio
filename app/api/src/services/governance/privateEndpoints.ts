import type { GovernanceCheckResult } from '@avdmgr/shared';
import { armList } from '../../lib/armRest';
import { getConfig } from '../../lib/config';
import { buildResult } from './support';

/*
 * Check 3: every private endpoint in RG-AVD-Network is Approved + Succeeded.
 * The estate inventory §3 captured exactly 5:
 * PE-HP-CONTOSO-PROD, PE-KV-AVD-PROD, PE-RSV-AVD-PROD, PE-stcontoso001,
 * PE-CONTOSO-DESKTOP — governance.expectedPrivateEndpointCount (peer
 * review item 16 — config-driven, default 5) matches that capture, so this
 * check can flag "fewer than expected" as a warn signal distinct from "some
 * are unhealthy" (a fail signal) even if the estate doesn't drift, while
 * letting a deliberate estate change (a 6th PE added, one retired) be
 * reflected without a code change.
 *
 * API: Microsoft.Network/privateEndpoints LIST, api-version 2023-09-01 —
 * verified against Microsoft Learn's Network ARM template reference
 * (privateLinkServiceConnections[].privateLinkServiceConnectionState.status
 * is documented as Approved/Rejected/Removed — see this file's
 * evaluatePrivateEndpoints doc comment for how 'Removed'/'Pending' are
 * treated). RBAC: plain Reader on RG-AVD-Network — a NEW grant this story
 * adds (that RG previously held Cost Management Reader ONLY, per
 * infra/main.bicep's rbacNetwork module — see this story's Bicep changes).
 *
 * armList's default 404 policy (throw, not treat-as-empty — peer review
 * item 5) applies here unmodified: RG-AVD-Network not existing/renamed must
 * surface as a real 'unknown' result (see support.ts's error redaction),
 * not a silent "0 private endpoints found."
 */

const API_VERSION = '2023-09-01';

interface ArmPrivateEndpoint {
  name?: string;
  properties?: {
    provisioningState?: string;
    privateLinkServiceConnections?: Array<{
      privateLinkServiceConnectionState?: { status?: string; actionsRequired?: string };
    }>;
    manualPrivateLinkServiceConnections?: Array<{
      privateLinkServiceConnectionState?: { status?: string; actionsRequired?: string };
    }>;
  };
}

interface PrivateEndpointEvidence {
  name: string;
  provisioningState: string;
  connectionStatus: string;
}

function connectionStatus(pe: ArmPrivateEndpoint): string {
  const connections = [...(pe.properties?.privateLinkServiceConnections ?? []), ...(pe.properties?.manualPrivateLinkServiceConnections ?? [])];
  return connections[0]?.privateLinkServiceConnectionState?.status ?? 'Unknown';
}

export function evaluatePrivateEndpoints(endpoints: ArmPrivateEndpoint[], expectedCount: number, truncated = false): GovernanceCheckResult {
  const base = { id: 'private-endpoints-health', title: 'Private endpoint approval & health', category: 'Networking' };

  const items: PrivateEndpointEvidence[] = endpoints.map((pe) => ({
    name: pe.name ?? 'unknown',
    provisioningState: pe.properties?.provisioningState ?? 'Unknown',
    connectionStatus: connectionStatus(pe),
  }));

  const unhealthy = items.filter((pe) => pe.connectionStatus === 'Rejected' || pe.connectionStatus === 'Removed' || pe.provisioningState === 'Failed');
  const pending = items.filter((pe) => pe.connectionStatus === 'Pending' || pe.provisioningState === 'Updating');
  const evidence = { count: items.length, expectedCount, endpoints: items, truncated };

  if (unhealthy.length > 0) {
    return buildResult({
      ...base,
      status: 'fail',
      summary: `${unhealthy.length} of ${items.length} private endpoint(s) are rejected/removed/failed: ${unhealthy.map((pe) => pe.name).join(', ')}.`,
      evidence,
    });
  }
  if (pending.length > 0 || items.length !== expectedCount) {
    return buildResult({
      ...base,
      status: 'warn',
      summary:
        pending.length > 0
          ? `${pending.length} private endpoint(s) are still Pending/Updating: ${pending.map((pe) => pe.name).join(', ')}.`
          : `Found ${items.length} private endpoint(s) in RG-AVD-Network, expected ${expectedCount}.`,
      evidence,
    });
  }
  return buildResult({ ...base, status: 'pass', summary: `All ${items.length} private endpoints are Approved and healthy.`, evidence });
}

export async function fetchPrivateEndpoints(): Promise<GovernanceCheckResult> {
  const { subscriptionId, resourceGroups, governance } = getConfig();
  const { items: endpoints, truncated } = await armList<ArmPrivateEndpoint>(
    `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroups.network}/providers/Microsoft.Network/privateEndpoints`,
    API_VERSION,
  );
  return evaluatePrivateEndpoints(endpoints, governance.expectedPrivateEndpointCount, truncated);
}
