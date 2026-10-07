import type { GovernanceCheckResult } from '@avdmgr/shared';
import { armList } from '../../lib/armRest';
import { getConfig } from '../../lib/config';
import { isResourceGroupScopedLock, type ArmLock } from './deleteLocks';
import { buildResult } from './support';

/*
 * Check 12 (AM-56) — hygiene watchdog for the three documented
 * `CanNotDelete` locks protecting the FSLogix storage account
 * (stcontoso001 / RG-AVD-Storage): `LOCK-RG-AVD-Storage` (resource-group
 * scoped), `Lock-stcontoso001` (resource-scoped on the storage account
 * itself), and the auto-created `AzureBackupProtectionLock` (also
 * resource-scoped — see the FSLogix storage runbook lines
 * 344-345). Motivating incident (2026-08-22): these three locks were
 * deliberately LIFTED and RESTORED around an admin cleanup task that needed
 * to remove a role assignment on the account (locks block
 * `Microsoft.Authorization/roleAssignments` deletion too — same doc
 * reference) — nothing was watching to notice if the restore step were
 * ever skipped or only partially done.
 *
 * ONE `armList` call at the RG-AVD-Storage locks collection — per
 * deleteLocks.ts's own header comment, ARM's "list locks in a resource
 * group" LIST returns EVERY lock WITHIN that resource group, including
 * ones scoped to individual resources nested inside it (here: the storage
 * account) — so a single fetch covers both the RG-scoped lock and the two
 * resource-scoped ones, reusing deleteLocks.ts's exported
 * `isResourceGroupScopedLock` to tell them apart (see that function's doc
 * comment for the false-positive it exists to rule out) rather than
 * re-deriving the same classification here.
 *
 * EXPECTED SCOPE PER NAME: `governance.expectedStorageLockNames` is a flat,
 * operator-configurable list of NAMES (no separate scope field, per this
 * story's own config shape) — this check derives each name's expected
 * scope with a simple, self-documenting naming-convention heuristic: a
 * name literally prefixed `LOCK-RG-` (as `LOCK-RG-AVD-Storage` is) is
 * expected resource-GROUP-scoped; every other configured name (as both
 * `Lock-stcontoso001` and `AzureBackupProtectionLock` are) is expected
 * scoped to the storage account resource itself. This correctly classifies
 * the three documented defaults without requiring a richer (name, scope)
 * config shape, and extends the same way for any future estate lock
 * following the same `LOCK-RG-*` naming convention this estate already
 * uses elsewhere (see deleteLocks.ts's own `LOCK-HP-CONTOSO-PROD-DAG` etc.).
 *
 * CASE-INSENSITIVE matching throughout (documented casing variance across
 * the three real names above — `LOCK-` vs `Lock-`).
 *
 * STATUS: missing or mis-scoped is a 'warn', never a 'fail' — same
 * "operational hardening, not a security control" posture deleteLocks.ts's
 * own header comment already establishes for the analogous host-pool-side
 * check.
 */

const LOCKS_API_VERSION = '2020-05-01';

type LockScope = 'resourceGroup' | 'resource';

function expectedScopeForName(name: string): LockScope {
  return /^LOCK-RG-/i.test(name) ? 'resourceGroup' : 'resource';
}

export interface StorageLockEvidence {
  name: string;
  expectedScope: LockScope;
  found: boolean;
  actualScope?: LockScope;
  /** True when the lock exists but at a DIFFERENT scope than expected (e.g. the RG-scope lock was recreated as a resource-scoped one, or vice versa). */
  misscoped: boolean;
}

/**
 * Pure evaluation: `locks` is every lock ARM returned for the RG-AVD-Storage
 * scope (RG-scoped and resource-scoped alike — see this file's header
 * comment); `storageAccountResourceId` is that account's own ARM resource
 * id, used to recognize a lock scoped to it specifically (as opposed to
 * some OTHER resource that happens to also live in RG-AVD-Storage).
 */
export function evaluateStorageDeleteLocks(expectedNames: readonly string[], locks: readonly ArmLock[], storageAccountResourceId: string): GovernanceCheckResult {
  const base = { id: 'storage-delete-locks', title: 'FSLogix storage account delete locks', category: 'Security' };

  const rgScopedLocks = locks.filter(isResourceGroupScopedLock);
  const resourceScopedPrefix = `${storageAccountResourceId}/providers/microsoft.authorization/locks/`.toLowerCase();
  const storageResourceScopedLocks = locks.filter((lock) => typeof lock.id === 'string' && lock.id.toLowerCase().startsWith(resourceScopedPrefix));

  const evidence: StorageLockEvidence[] = expectedNames.map((name) => {
    const nameLower = name.toLowerCase();
    const foundInRg = rgScopedLocks.some((lock) => (lock.name ?? '').toLowerCase() === nameLower);
    const foundOnResource = storageResourceScopedLocks.some((lock) => (lock.name ?? '').toLowerCase() === nameLower);
    const expectedScope = expectedScopeForName(name);
    // A lock could, in principle, satisfy BOTH (unlikely, but not
    // impossible — e.g. a name collision) — RG scope wins the "actual
    // scope" label since it's the broader, more consequential one.
    const actualScope: LockScope | undefined = foundInRg ? 'resourceGroup' : foundOnResource ? 'resource' : undefined;
    return {
      name,
      expectedScope,
      found: actualScope !== undefined,
      actualScope,
      misscoped: actualScope !== undefined && actualScope !== expectedScope,
    };
  });

  const missing = evidence.filter((item) => !item.found);
  const misscoped = evidence.filter((item) => item.found && item.misscoped);

  if (missing.length === 0 && misscoped.length === 0) {
    return buildResult({ ...base, status: 'pass', summary: `All ${evidence.length} expected delete lock(s) on the FSLogix storage account are present and correctly scoped.`, evidence: { locks: evidence } });
  }

  const parts: string[] = [];
  if (missing.length > 0) {
    parts.push(`missing entirely: ${missing.map((item) => item.name).join(', ')}`);
  }
  if (misscoped.length > 0) {
    parts.push(`present but at the wrong scope: ${misscoped.map((item) => `${item.name} (expected ${item.expectedScope}, found ${item.actualScope})`).join(', ')}`);
  }
  return buildResult({
    ...base,
    status: 'warn',
    summary: `Storage delete-lock hygiene gap — ${parts.join('; ')}. Operational hardening, not a security control.`,
    evidence: { locks: evidence },
  });
}

export async function fetchStorageDeleteLocks(): Promise<GovernanceCheckResult> {
  const { subscriptionId, resourceGroups, storage, governance } = getConfig();
  const rg = resourceGroups.storage;
  const storageAccountResourceId = `/subscriptions/${subscriptionId}/resourceGroups/${rg}/providers/Microsoft.Storage/storageAccounts/${storage.accountName}`;
  const { items } = await armList<ArmLock>(`/subscriptions/${subscriptionId}/resourceGroups/${rg}/providers/Microsoft.Authorization/locks`, LOCKS_API_VERSION, { treat404AsEmpty: true });
  return evaluateStorageDeleteLocks(governance.expectedStorageLockNames, items, storageAccountResourceId);
}
