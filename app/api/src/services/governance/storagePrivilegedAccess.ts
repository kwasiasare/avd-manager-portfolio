import type { GovernanceCheckResult } from '@avdmgr/shared';
import { armListAtScope } from '../../lib/armRest';
import { getConfig } from '../../lib/config';
import { boundList, buildResult } from './support';

/*
 * Check 11 (AM-56) — watchdog for privileged DATA-PLANE grants on the
 * FSLogix storage account (stcontoso001). Motivating incident (2026-08-22):
 * a temporary "Storage File Data Privileged Contributor" grant was made for
 * an admin file-surgery task (see the FSLogix storage runbook's
 * REST-path note on that role — required for admin actions outside a
 * mounted SMB session) and nothing was watching to flag it if it were ever
 * left behind. This check closes that gap.
 *
 * ROLE: "Storage File Data Privileged Contributor",
 * 69566ab7-960f-475b-8e7c-b3118f30c6bd — the SAME built-in role
 * infra/modules/fslogixDataPlaneRole.bicep grants this app's OWN Function
 * App managed identity (see that module's header comment for why THIS role
 * specifically: it is the one Azure Files data-plane role that bypasses
 * per-file/directory NTFS ACLs via the `x-ms-file-request-intent: backup`
 * header, which is exactly the capability an admin file-surgery task also
 * needs and exactly why an unaccounted-for grant of it is worth flagging).
 *
 * SCOPE: role assignments AT THE STORAGE ACCOUNT'S OWN SCOPE
 * (`armListAtScope` + `$filter=atScope()` — the same precedent
 * accessService.ts#listDesktopAssignments already established for reading
 * role assignments without a dedicated @azure/arm-authorization SDK
 * dependency). `atScope()` also surfaces an INHERITED grant (made at
 * RG-AVD-Storage or subscription scope) — this check does not attempt to
 * distinguish direct-on-resource from inherited (unlike accessService.ts's
 * describeScope, which exists specifically so an operator knows what THIS
 * APP can safely remove); an inherited grant is exactly as much of a
 * privileged-access fact as a direct one for this check's purpose.
 *
 * BASELINE: `governance.privilegedStorageBaselinePrincipalIds` — Entra
 * object ids of every principal EXPECTED to hold this role (today: this
 * app's prod + dev Function App identities — see that config field's own
 * doc comment). UNDEFINED (not an empty array) when unset: this check
 * NEVER guesses a baseline — it degrades to 'unknown' with configure-
 * guidance, the same "not configured" degradation
 * governance/conditionalAccessBreakGlass.ts already established for
 * BREAK_GLASS_GROUP_ID.
 *
 * STATUS RATIONALE (unlike the hygiene-only `storage-delete-locks` check
 * below, which only ever warns): a privileged data-plane grant nobody
 * accounted for on the estate's FSLogix profile share IS a security
 * finding — 'fail', not 'warn' — because it represents ACTUAL standing
 * access to bypass every user's NTFS permissions on that share, not merely
 * a missing operational safeguard.
 */

const PRIVILEGED_CONTRIBUTOR_ROLE_ID = '69566ab7-960f-475b-8e7c-b3118f30c6bd';
const ROLE_ASSIGNMENTS_API_VERSION = '2022-04-01';

/** Bounds the evidence list — same "cap + report the true count" pattern as every other governance check's bounded evidence (see support.ts#boundList). A handful of principals is the realistic ceiling for one storage account; this is a defensive cap, not an expected truncation. */
const EVIDENCE_LIMIT = 25;

export interface ArmRoleAssignment {
  name?: string;
  properties?: { principalId?: string; roleDefinitionId?: string; scope?: string };
}

function isPrivilegedContributorAssignment(item: ArmRoleAssignment): boolean {
  const roleDefinitionId = item.properties?.roleDefinitionId;
  return typeof roleDefinitionId === 'string' && roleDefinitionId.toLowerCase().endsWith(`/roledefinitions/${PRIVILEGED_CONTRIBUTOR_ROLE_ID.toLowerCase()}`);
}

export interface PrivilegedPrincipalEvidence {
  principalId: string;
  /** True when this principal is one of the configured baseline ids (case-insensitive compare). */
  baseline: boolean;
}

/**
 * Pure evaluation: given the configured baseline (undefined = not
 * configured) and the raw role-assignment list already fetched from ARM,
 * decides pass/fail/unknown. Case-insensitive principal-id comparison
 * throughout — Entra object ids are GUIDs, and this app should never treat
 * `AAAA...` and `aaaa...` as different principals due to a casing quirk in
 * either the baseline config or ARM's own response.
 */
export function evaluateStoragePrivilegedAccess(baselinePrincipalIds: string[] | undefined, assignments: readonly ArmRoleAssignment[]): GovernanceCheckResult {
  const base = { id: 'storage-privileged-access', title: 'Privileged storage-account data-plane grants', category: 'Security' };

  if (baselinePrincipalIds === undefined) {
    return buildResult({
      ...base,
      status: 'unknown',
      summary:
        'No baseline principal ids are configured — set the PRIVILEGED_STORAGE_BASELINE_PRINCIPAL_IDS app setting (or infra/main.bicep\'s privilegedStorageBaselinePrincipalId / privilegedStorageBaselineExtraPrincipalIds params) to this estate\'s expected Storage File Data Privileged Contributor holders before this check can distinguish an accounted-for grant from an unaccounted-for one.',
      evidence: { degradation: 'not-configured' },
    });
  }

  const baselineLower = new Set(baselinePrincipalIds.map((id) => id.toLowerCase()));
  const privilegedAssignments = assignments.filter(isPrivilegedContributorAssignment);
  // De-duplicate by principal id — the SAME principal could hold this role
  // via more than one assignment (e.g. one direct, one inherited); this
  // check reports "who has it," not "how many assignment objects grant it."
  const principalIds = [...new Set(privilegedAssignments.map((a) => a.properties?.principalId).filter((id): id is string => Boolean(id)))];

  const evidenceItems: PrivilegedPrincipalEvidence[] = principalIds.map((principalId) => ({ principalId, baseline: baselineLower.has(principalId.toLowerCase()) }));
  const bounded = boundList(evidenceItems, EVIDENCE_LIMIT);
  const extra = evidenceItems.filter((item) => !item.baseline);
  const evidence = { assignments: bounded.items, totalCount: bounded.totalCount, truncated: bounded.truncated, baselinePrincipalIds };

  if (extra.length > 0) {
    return buildResult({
      ...base,
      status: 'fail',
      summary: `${extra.length} principal(s) hold Storage File Data Privileged Contributor on the FSLogix storage account beyond the configured baseline: ${extra.map((item) => item.principalId).join(', ')}.`,
      evidence,
    });
  }

  // Fable review fix — the OTHER drift direction: a configured baseline
  // principal that no longer holds the grant. The motivating incident's
  // cleanup removed temporary grants; over-removing would strand this app's
  // own profile-surgery capability (Reset/duplicate-resolve would start
  // failing), so surface it as 'warn' rather than a silent pass. Extras
  // (above) still take precedence as 'fail' — an unaccounted-for privileged
  // principal outranks a missing expected one.
  const heldLower = new Set(principalIds.map((id) => id.toLowerCase()));
  const missingBaseline = baselinePrincipalIds.filter((id) => !heldLower.has(id.toLowerCase()));
  if (missingBaseline.length > 0) {
    return buildResult({
      ...base,
      status: 'warn',
      summary: `${missingBaseline.length} configured baseline principal(s) no longer hold Storage File Data Privileged Contributor on the FSLogix storage account: ${missingBaseline.join(', ')} — the app's own profile mutations may be failing. Re-grant per infra/modules/fslogixDataPlaneRole.bicep, or remove stale ids from the baseline setting.`,
      evidence: { ...evidence, missingBaselinePrincipalIds: missingBaseline },
    });
  }

  return buildResult({
    ...base,
    status: 'pass',
    summary:
      evidenceItems.length === 0
        ? 'No principal holds Storage File Data Privileged Contributor on the FSLogix storage account, and the configured baseline expects none.'
        : `Only the configured baseline principal(s) (${evidenceItems.length}) hold Storage File Data Privileged Contributor on the FSLogix storage account.`,
    evidence,
  });
}

export async function fetchStoragePrivilegedAccess(): Promise<GovernanceCheckResult> {
  const { subscriptionId, resourceGroups, storage, governance } = getConfig();
  const storageAccountScope = `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroups.storage}/providers/Microsoft.Storage/storageAccounts/${storage.accountName}`;
  const { items } = await armListAtScope<ArmRoleAssignment>(`${storageAccountScope}/providers/Microsoft.Authorization/roleAssignments`, ROLE_ASSIGNMENTS_API_VERSION, 'atScope()');
  return evaluateStoragePrivilegedAccess(governance.privilegedStorageBaselinePrincipalIds, items);
}
