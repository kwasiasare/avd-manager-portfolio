import type { GovernanceCheckResult, GovernanceLink } from '@avdmgr/shared';
import { getConfig } from '../../lib/config';
import { graphListAll, isGraphForbidden } from '../../lib/graphRest';
import { buildResult } from './support';

/*
 * Check 9: which Conditional Access policies EXCLUDE the estate's
 * break-glass (emergency-access) group — verified as
 * conditions.users.excludeGroups containing that group's object id
 * (conditionalAccessUsers resource type, confirmed against Microsoft
 * Learn: "excludeGroups: Group IDs excluded from scope of policy").
 * Microsoft's own guidance (Global Secure Access "Apply Conditional Access
 * policies" doc, "Use access reviews to manage users excluded from
 * Conditional Access policies") is explicit that break-glass accounts
 * SHOULD be excluded from enforcement policies so an admin is never locked
 * out mid-incident — this check verifies that is actually true for every
 * genuinely ENFORCED policy, not merely assumed.
 *
 * ENFORCED vs REPORT-ONLY (peer review item 15): only `state: 'enabled'`
 * policies are ACTUALLY enforced and gate this check's pass/warn/fail.
 * `state: 'enabledForReportingButNotEnforced'` policies are evaluated
 * against the same break-glass-exclusion rule and listed in evidence
 * separately (`reportOnlyPolicies`), but a report-only gap does NOT count
 * toward the warn list — a policy that isn't enforced yet can't actually
 * lock anyone out. Zero ENFORCED policies is itself a WARN, not a pass
 * (peer review item 15): "nothing enforced" means this check has nothing
 * meaningful to verify break-glass exclusion against, which is worth
 * surfacing distinctly from "verified and clean."
 *
 * TWO INDEPENDENT, DISTINCT DEGRADED STATES (both 'unknown', both with
 * different remediation — never conflated into one generic "can't check"
 * message):
 *
 *   1. NOT CONFIGURED — BREAK_GLASS_GROUP_ID is unset. No break-glass
 *      group/account is captured anywhere in the runbooks or
 *      the runbooks today (confirmed by search — this story adds
 *      the config knob, not the group itself). An operator must identify
 *      The estate's actual break-glass principal and set this app setting
 *      before this check can mean anything.
 *
 *   2. GRAPH PERMISSION NOT GRANTED — the Function App's managed identity
 *      needs the Microsoft Graph APPLICATION permission Policy.Read.All
 *      (id 246dd0d5-5bd0-4def-940b-0421030a5b68 — verified against
 *      Microsoft Learn's Graph permissions reference) to call
 *      GET /identity/conditionalAccess/policies (verified against
 *      Microsoft Learn's "List policies" API reference: Policy.Read.All is
 *      the least-privileged application permission for this endpoint).
 *      THIS CANNOT BE GRANTED FROM BICEP/ARM: an app role assignment on a
 *      Microsoft first-party service principal (Microsoft Graph) requires
 *      Privileged Role Administrator/Cloud Application Administrator in
 *      Entra — an Entra-side mutation with no ARM resource type, entirely
 *      outside what infra/main.bicep's RBAC modules (Azure RBAC role
 *      ASSIGNMENTS) can express. See docs/app-registration.md section 9
 *      for the exact one-time az CLI grant an operator with that Entra role
 *      must run. A 403 from Graph here (code Authorization_RequestDenied)
 *      is the expected, common state until that manual step happens — NOT
 *      a bug.
 *
 * Neither degraded state is 'fail': the check genuinely could not run, so
 * calling it a security failure would be a false positive.
 *
 * DISPLAY-NAME REDACTION (peer review item 15): a Conditional Access
 * policy's displayName can itself be sensitive (naming internal groups,
 * roles, or security posture details) — this check's OWN evidence always
 * includes it (evaluation happens once, cached, shared across every
 * viewer+ caller), but app/api/src/functions/governance.ts redacts
 * displayName down to a stable per-policy label for viewer-role callers
 * specifically, before the cached summary is returned over the wire — see
 * that file's redactConditionalAccessEvidenceForViewers. The check's own
 * pass/warn/fail STATUS is never redacted, only the policy names in
 * evidence.
 */

const ENTRA_CA_POLICIES_URL = 'https://entra.microsoft.com/#view/Microsoft_AAD_ConditionalAccess/ConditionalAccessBlade/~/Policies';
const ENTRA_ENTERPRISE_APPS_URL = 'https://entra.microsoft.com/#view/Microsoft_AAD_IAM/StartboardApplicationsMenuBlade/~/AppAppsPreview';

interface GraphConditionalAccessPolicy {
  id?: string;
  displayName?: string;
  state?: string; // 'enabled' | 'disabled' | 'enabledForReportingButNotEnforced'
  conditions?: { users?: { excludeGroups?: string[] } };
}

export interface PolicyEvidence {
  id: string;
  displayName: string;
  state: string;
  excludesBreakGlass: boolean;
}

/** Grant instructions surfaced verbatim in the degraded evidence — kept as one source of truth shared with docs/app-registration.md section 9 (copy that file's exact commands if this ever changes). */
export const GRAPH_GRANT_INSTRUCTIONS = [
  '# Requires an Entra role with app-role-assignment rights (Privileged Role Administrator / Cloud Application Administrator), run once per environment:',
  'FUNC_MI_OBJECT_ID=$(az functionapp identity show --name <functionAppName> --resource-group RG-AVD-Management --query principalId -o tsv)',
  'GRAPH_SP_OBJECT_ID=$(az ad sp show --id 00000003-0000-0000-c000-000000000000 --query id -o tsv)',
  'az rest --method POST \\',
  '  --url "https://graph.microsoft.com/v1.0/servicePrincipals/$GRAPH_SP_OBJECT_ID/appRoleAssignedTo" \\',
  '  --headers "Content-Type=application/json" \\',
  '  --body "{\\"principalId\\": \\"$FUNC_MI_OBJECT_ID\\", \\"resourceId\\": \\"$GRAPH_SP_OBJECT_ID\\", \\"appRoleId\\": \\"246dd0d5-5bd0-4def-940b-0421030a5b68\\"}"',
] as const;

function toPolicyEvidence(p: GraphConditionalAccessPolicy, breakGlassGroupId: string): PolicyEvidence {
  return {
    id: p.id ?? 'unknown',
    displayName: p.displayName ?? 'unnamed policy',
    state: p.state ?? 'unknown',
    excludesBreakGlass: (p.conditions?.users?.excludeGroups ?? []).includes(breakGlassGroupId),
  };
}

export function evaluateConditionalAccessBreakGlass(
  breakGlassGroupId: string | undefined,
  policies: GraphConditionalAccessPolicy[] | 'graph-not-granted',
  truncated = false,
): GovernanceCheckResult {
  const base = { id: 'ca-policy-breakglass', title: 'Conditional Access break-glass exclusions', category: 'Identity' };

  if (!breakGlassGroupId) {
    return buildResult({
      ...base,
      status: 'unknown',
      summary: 'Break-glass group is not configured — set the BREAK_GLASS_GROUP_ID app setting to this estate\'s emergency-access group/account object ID.',
      evidence: { degradation: 'not-configured' },
    });
  }

  if (policies === 'graph-not-granted') {
    return buildResult({
      ...base,
      status: 'unknown',
      summary: 'Microsoft Graph Policy.Read.All has not been granted to this app\'s managed identity — this is an Entra-side grant that cannot be applied from Bicep. See docs/app-registration.md section 9.',
      evidence: { degradation: 'graph-permission-not-granted', grantInstructions: GRAPH_GRANT_INSTRUCTIONS },
      links: [{ label: 'Grant in Entra admin center (Enterprise applications)', url: ENTRA_ENTERPRISE_APPS_URL }],
    });
  }

  const enforcedPolicies = policies.filter((p) => p.state === 'enabled').map((p) => toPolicyEvidence(p, breakGlassGroupId));
  const reportOnlyPolicies = policies.filter((p) => p.state === 'enabledForReportingButNotEnforced').map((p) => toPolicyEvidence(p, breakGlassGroupId));

  const gaps = enforcedPolicies.filter((p) => !p.excludesBreakGlass);
  const links: GovernanceLink[] = gaps.map((p) => ({ label: `Review "${p.displayName}" in Entra`, url: `${ENTRA_CA_POLICIES_URL}/${p.id}` }));
  const evidence = { policies: enforcedPolicies, reportOnlyPolicies, truncated };

  if (enforcedPolicies.length === 0) {
    return buildResult({
      ...base,
      status: 'warn',
      summary:
        reportOnlyPolicies.length > 0
          ? `No enforced Conditional Access policies exist — ${reportOnlyPolicies.length} polic${reportOnlyPolicies.length === 1 ? 'y is' : 'ies are'} in report-only mode, not yet actively enforced, so break-glass exclusion cannot be meaningfully verified until at least one policy is enforced.`
          : 'No Conditional Access policies exist (enforced or otherwise) — break-glass exclusion cannot be verified because nothing is currently enforced.',
      evidence,
    });
  }
  if (gaps.length === 0) {
    return buildResult({ ...base, status: 'pass', summary: `All ${enforcedPolicies.length} enforced Conditional Access policies exclude the break-glass group.`, evidence });
  }
  return buildResult({
    ...base,
    status: 'warn',
    summary: `${gaps.length} of ${enforcedPolicies.length} enforced Conditional Access policies do NOT exclude the break-glass group: ${gaps.map((p) => p.displayName).join(', ')}.`,
    evidence,
    links,
  });
}

export async function fetchConditionalAccessBreakGlass(): Promise<GovernanceCheckResult> {
  const { governance } = getConfig();
  const breakGlassGroupId = governance.breakGlassGroupId;

  if (!breakGlassGroupId) {
    return evaluateConditionalAccessBreakGlass(undefined, []);
  }

  try {
    const { items: policies, truncated } = await graphListAll<GraphConditionalAccessPolicy>('/identity/conditionalAccess/policies');
    return evaluateConditionalAccessBreakGlass(breakGlassGroupId, policies, truncated);
  } catch (error) {
    if (isGraphForbidden(error)) {
      return evaluateConditionalAccessBreakGlass(breakGlassGroupId, 'graph-not-granted');
    }
    throw error;
  }
}
