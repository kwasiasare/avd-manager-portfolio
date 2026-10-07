import type { GovernanceCheckResult } from '@avdmgr/shared';
import { armList } from '../../lib/armRest';
import { getConfig } from '../../lib/config';
import { buildResult } from './support';

/*
 * Check 6: resource delete locks on the AVD workspace and desktop app
 * group — with a DELIBERATE exception for the host pool itself.
 *
 * LIVE SCOPE CORRECTION (2026-08-16, mid-implementation): the host-pool
 * CanNotDelete lock (LOCK-HP-CONTOSO-PROD) was DELIBERATELY REMOVED — a
 * CanNotDelete lock on a parent resource also blocks delete on its
 * children per ARM's documented lock-inheritance model ("When you apply a
 * lock at a parent scope, all resources within that scope inherit the same
 * lock" — verified against Microsoft Learn's "Lock your Azure resources to
 * protect your infrastructure" page), which blocked AVD session-host/
 * user-session child-deletes under the host pool. This is now recorded as
 * the gap register item 20 (added alongside this
 * check, once the live fact was confirmed — NOT item 14, which is the
 * unrelated SNET-MANAGEMENT finding; an earlier draft of this file
 * mis-cited item 14 for this fact before the register itself had a row for
 * it).
 *
 * Expected posture this check verifies:
 *   - Contoso-Desktop (workspace) SHOULD carry a CanNotDelete lock
 *     (LOCK-CONTOSO-DESKTOP), directly OR inherited from an RG-scope lock.
 *   - HP-CONTOSO-PROD-DAG (desktop app group) SHOULD carry a CanNotDelete lock
 *     (LOCK-HP-CONTOSO-PROD-DAG), directly OR inherited.
 *   - HP-CONTOSO-PROD (host pool) should NOT carry a lock, directly OR
 *     inherited from an RG-AVD-HostPools-scope lock (peer review item 17 —
 *     an RG-scope lock cascades to the host pool exactly the same way a
 *     resource-scope lock would, per the same inheritance rule cited
 *     above, so it must count for this WARN case too) — if one is found
 *     (either form), that is WARNED on (not failed: a re-applied lock is
 *     an operational footgun re-introducing the same child-delete-blocking
 *     problem, not by itself a security failure), citing this history so
 *     whoever re-added it (or is investigating why session/host deletes
 *     are failing) has the context immediately instead of having to
 *     rediscover it.
 * Any of the three missing/unexpected states above is a 'warn', never a
 * 'fail' — delete locks are an operational hardening measure, not a
 * security control whose absence should read as severe as e.g. check 1/2's
 * findings.
 *
 * API: Microsoft.Authorization/locks LIST, api-version 2020-05-01 —
 * verified against Microsoft Learn's Authorization ARM template reference.
 * Two kinds of LIST here: one per-resource (workspace/DAG/host pool own
 * id), one RG-scope (RG-AVD-HostPools itself, for the inheritance check
 * above) — RBAC: plain Reader on RG-AVD-HostPools covers both
 * (Microsoft.Authorization/locks/read is covered by Reader's wildcard read
 * action at whatever scope Reader is granted — verified against Microsoft
 * Learn's "Azure built-in roles for General" page); all three target
 * resources plus the RG itself are within/is RG-AVD-HostPools, which
 * already holds Reader (infra/main.bicep's rbacHostPools module, unchanged
 * by this story).
 */

const API_VERSION = '2020-05-01';

/** Exported (AM-56) — services/governance/storageDeleteLocks.ts reuses this exact shape rather than redefining it, since both checks read the SAME `Microsoft.Authorization/locks` LIST response. */
export interface ArmLock {
  id?: string;
  name?: string;
  properties?: { level?: string; notes?: string };
}

/**
 * ARM's "list locks in this resource group" LIST (the same one `az lock
 * list --resource-group X` and the SDK's listAtResourceGroupLevel call)
 * returns EVERY lock WITHIN the resource group — including ones scoped to
 * individual resources nested inside it (confirmed against Microsoft
 * Learn's ManagementLocks.listAtResourceGroupLevel reference: "Gets all
 * the management locks for a resource group," the same broad semantic
 * `az lock list -g` documents) — NOT only locks scoped exactly to the
 * resource group itself. Naively treating "this list is non-empty" as
 * "the RG itself is locked" would ALWAYS be true once the workspace/DAG
 * have their own EXPECTED locks (see fetchDeleteLocks below), which is
 * exactly the false positive this pattern exists to rule out: only a lock
 * whose OWN resource id sits directly under the RG's own
 * `/providers/Microsoft.Authorization/locks/{name}` path (no resource
 * type/name segment in between) is a genuine RG-scope lock.
 */
const RESOURCE_GROUP_SCOPE_LOCK_ID_PATTERN = /^\/subscriptions\/[^/]+\/resourceGroups\/[^/]+\/providers\/Microsoft\.Authorization\/locks\/[^/]+$/i;

/** Exported (AM-56) — services/governance/storageDeleteLocks.ts reuses this exact RG-vs-resource-scope classification rather than re-deriving it (see this file's header comment above for the false-positive it exists to rule out). */
export function isResourceGroupScopedLock(lock: ArmLock): boolean {
  return typeof lock.id === 'string' && RESOURCE_GROUP_SCOPE_LOCK_ID_PATTERN.test(lock.id);
}

export interface LockCheckTarget {
  label: string;
  resourceId: string;
  /** True if this resource is EXPECTED to carry a delete lock; false for the host pool (see this file's header comment). */
  expectLock: boolean;
}

interface TargetEvidence {
  label: string;
  expectLock: boolean;
  locked: boolean;
  lockNames: string[];
  /** True when `locked` is true ONLY because of an RG-AVD-HostPools-scope lock (peer review item 17), not a lock on the resource itself. */
  lockedViaResourceGroupInheritance: boolean;
}

export function evaluateDeleteLocks(perTarget: Array<{ target: LockCheckTarget; locks: ArmLock[] }>, resourceGroupLocks: ArmLock[] = []): GovernanceCheckResult {
  const base = { id: 'delete-locks', title: 'Resource delete locks', category: 'Security' };

  const rgLocked = resourceGroupLocks.length > 0;

  const evidence: TargetEvidence[] = perTarget.map(({ target, locks }) => ({
    label: target.label,
    expectLock: target.expectLock,
    locked: locks.length > 0 || rgLocked,
    lockNames: locks.length > 0 ? locks.map((l) => l.name ?? 'unnamed') : rgLocked ? resourceGroupLocks.map((l) => l.name ?? 'unnamed') : [],
    lockedViaResourceGroupInheritance: locks.length === 0 && rgLocked,
  }));

  const issues: string[] = [];
  for (const item of evidence) {
    if (item.expectLock && !item.locked) {
      issues.push(`${item.label} is missing its expected delete lock.`);
    } else if (!item.expectLock && item.locked) {
      const via = item.lockedViaResourceGroupInheritance ? ' (inherited from an RG-AVD-HostPools-scope lock)' : '';
      issues.push(
        `${item.label} has a delete lock present${via} (${item.lockNames.join(', ')}) — this lock was deliberately removed 2026-08-16 because a lock on the host pool (directly or via the resource group) also blocks AVD session/host child-deletes; see the gap register item 20.`,
      );
    }
  }

  if (issues.length === 0) {
    return buildResult({
      ...base,
      status: 'pass',
      summary: 'Delete locks match the expected posture: workspace and app group locked, host pool intentionally unlocked.',
      evidence: { targets: evidence, resourceGroupLockNames: resourceGroupLocks.map((l) => l.name ?? 'unnamed') },
    });
  }
  return buildResult({ ...base, status: 'warn', summary: issues.join(' '), evidence: { targets: evidence, resourceGroupLockNames: resourceGroupLocks.map((l) => l.name ?? 'unnamed') } });
}

async function listLocks(resourceId: string): Promise<ArmLock[]> {
  const { items } = await armList<ArmLock>(`${resourceId}/providers/Microsoft.Authorization/locks`, API_VERSION, { treat404AsEmpty: true });
  return items;
}

export async function fetchDeleteLocks(): Promise<GovernanceCheckResult> {
  const { subscriptionId, resourceGroups, hostPoolName, workspaceName, dagName } = getConfig();
  const rg = resourceGroups.hostPools;
  const targets: LockCheckTarget[] = [
    { label: `Workspace: ${workspaceName}`, resourceId: `/subscriptions/${subscriptionId}/resourceGroups/${rg}/providers/Microsoft.DesktopVirtualization/workspaces/${workspaceName}`, expectLock: true },
    { label: `Application group: ${dagName}`, resourceId: `/subscriptions/${subscriptionId}/resourceGroups/${rg}/providers/Microsoft.DesktopVirtualization/applicationGroups/${dagName}`, expectLock: true },
    { label: `Host pool: ${hostPoolName}`, resourceId: `/subscriptions/${subscriptionId}/resourceGroups/${rg}/providers/Microsoft.DesktopVirtualization/hostPools/${hostPoolName}`, expectLock: false },
  ];

  const [perTarget, allLocksInResourceGroup] = await Promise.all([
    Promise.all(targets.map(async (target) => ({ target, locks: await listLocks(target.resourceId) }))),
    listLocks(`/subscriptions/${subscriptionId}/resourceGroups/${rg}`),
  ]);

  // Narrow "every lock ARM reports within RG-AVD-HostPools" down to
  // genuinely RG-scope-exact locks — see isResourceGroupScopedLock's doc
  // comment for why the raw list must NOT be used directly here.
  const resourceGroupScopedLocks = allLocksInResourceGroup.filter(isResourceGroupScopedLock);

  return evaluateDeleteLocks(perTarget, resourceGroupScopedLocks);
}
