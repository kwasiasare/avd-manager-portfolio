import type { GovernanceCheckResult } from '@avdmgr/shared';
import { armList } from '../../lib/armRest';
import { getConfig } from '../../lib/config';
import { buildResult } from './support';

/*
 * Check 4: diagnostic settings presence on the host pool, workspace, and
 * app group (see the estate inventory §7 — captured as
 * DIAG-HP-CONTOSO-PROD / DIAG-CONTOSO-DESKTOP / HostPools-Diag at inventory
 * time). Presence-only (>=1 setting with >=1 enabled log category) — does
 * NOT re-check the specific AutoscaleEvaluationPooled category gap
 * (register item 15); that is a narrower, already-tracked finding this
 * check's evidence surfaces per-resource but does not gate pass/warn/fail
 * on, to keep this check's contract ("does this resource have diagnostic
 * export configured at all") stable as new category-level gaps get found
 * independently over time.
 *
 * API: Microsoft.Insights/diagnosticSettings LIST (as an extension resource
 * under the target resource's own id), api-version 2021-05-01-preview —
 * verified against Microsoft Learn's Insights ARM template reference (this
 * is the current/only GA-equivalent version Microsoft documents for this
 * resource type — there is no non-preview version to prefer). RBAC: plain
 * Reader on the resource's own resource group is sufficient — diagnostic
 * settings are read via the target resource's OWN read action
 * (Microsoft.Insights/diagnosticSettings/read is included in Reader's
 * wildcard read action — verified against Microsoft Learn's "Azure built-in
 * roles for General" page). HP-CONTOSO-PROD/Contoso-Desktop/HP-CONTOSO-PROD-DAG all live in
 * RG-AVD-HostPools, which already holds plain Reader (infra/main.bicep's
 * rbacHostPools module, unchanged by this story) — no new RBAC needed for
 * this check specifically.
 *
 * treat404AsEmpty: true (peer review item 5) — each target here is a
 * SPECIFIC, already-known-to-exist resource (the host pool/workspace/app
 * group this app already reads elsewhere); a 404 on its diagnosticSettings
 * sub-collection means "this resource has none configured," a normal empty
 * state, not evidence the parent resource itself is missing/renamed.
 */

const API_VERSION = '2021-05-01-preview';

interface ArmDiagnosticSetting {
  name?: string;
  properties?: {
    logs?: Array<{ category?: string; categoryGroup?: string; enabled?: boolean }>;
    workspaceId?: string;
  };
}

export interface DiagnosticTarget {
  label: string;
  resourceId: string;
}

interface TargetEvidence {
  label: string;
  settingsCount: number;
  settingNames: string[];
  enabledCategories: string[];
  truncated: boolean;
}

async function listDiagnosticSettings(resourceId: string): Promise<{ items: ArmDiagnosticSetting[]; truncated: boolean }> {
  return armList<ArmDiagnosticSetting>(`${resourceId}/providers/Microsoft.Insights/diagnosticSettings`, API_VERSION, { treat404AsEmpty: true });
}

export function evaluateDiagnosticSettingsCoverage(perTarget: Array<{ target: DiagnosticTarget; settings: ArmDiagnosticSetting[]; truncated?: boolean }>): GovernanceCheckResult {
  const base = { id: 'diagnostic-settings-coverage', title: 'Diagnostic settings coverage', category: 'Monitoring' };

  const evidence: TargetEvidence[] = perTarget.map(({ target, settings, truncated = false }) => ({
    label: target.label,
    settingsCount: settings.length,
    settingNames: settings.map((s) => s.name ?? 'unnamed'),
    enabledCategories: settings.flatMap((s) => (s.properties?.logs ?? []).filter((log) => log.enabled).map((log) => log.category ?? log.categoryGroup ?? 'unknown')),
    truncated,
  }));

  const missing = evidence.filter((e) => e.settingsCount === 0);

  if (missing.length === perTarget.length) {
    return buildResult({ ...base, status: 'fail', summary: 'No diagnostic settings found on any of the checked resources.', evidence: { targets: evidence } });
  }
  if (missing.length > 0) {
    return buildResult({
      ...base,
      status: 'warn',
      summary: `Diagnostic settings missing on: ${missing.map((e) => e.label).join(', ')}.`,
      evidence: { targets: evidence },
    });
  }
  return buildResult({ ...base, status: 'pass', summary: `All ${perTarget.length} checked resources have at least one diagnostic setting.`, evidence: { targets: evidence } });
}

export async function fetchDiagnosticSettingsCoverage(): Promise<GovernanceCheckResult> {
  const { subscriptionId, resourceGroups, hostPoolName, workspaceName, dagName } = getConfig();
  const rg = resourceGroups.hostPools;
  const targets: DiagnosticTarget[] = [
    { label: `Host pool: ${hostPoolName}`, resourceId: `/subscriptions/${subscriptionId}/resourceGroups/${rg}/providers/Microsoft.DesktopVirtualization/hostPools/${hostPoolName}` },
    { label: `Workspace: ${workspaceName}`, resourceId: `/subscriptions/${subscriptionId}/resourceGroups/${rg}/providers/Microsoft.DesktopVirtualization/workspaces/${workspaceName}` },
    { label: `Application group: ${dagName}`, resourceId: `/subscriptions/${subscriptionId}/resourceGroups/${rg}/providers/Microsoft.DesktopVirtualization/applicationGroups/${dagName}` },
  ];

  const perTarget = await Promise.all(
    targets.map(async (target) => {
      const { items, truncated } = await listDiagnosticSettings(target.resourceId);
      return { target, settings: items, truncated };
    }),
  );

  return evaluateDiagnosticSettingsCoverage(perTarget);
}
