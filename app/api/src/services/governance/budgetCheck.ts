import type { GovernanceCheckResult } from '@avdmgr/shared';
import { armList } from '../../lib/armRest';
import { getConfig } from '../../lib/config';
import { buildResult } from './support';

/*
 * Check 5 (gap register item 11 — "No budget configured on sub-travel-avd").
 *
 * SCOPE LIMITATION (read before changing this check): Microsoft.Consumption
 * budgets are conventionally created at SUBSCRIPTION scope (per the gap
 * register's own wording), and Cost Management's "Understand and work with
 * scopes" page documents budgets as also creatable at resource-group scope
 * — but this app's managed identity holds Cost Management Reader ONLY at
 * six RG-AVD-* resource groups (infra/main.bicep), never at subscription
 * scope, by deliberate, explicitly-documented architecture
 * (infra/modules/rbac.bicep: "no role in this file is ever granted at
 * subscription scope"). AM-16 does NOT widen that — a subscription-scope
 * grant is a materially bigger blast-radius change than this story's other
 * additions (all RG- or resource-scoped) and deserves its own explicit
 * sign-off, not a drive-by addition buried in a governance-panel story. See
 * this app's top-level report for AM-16 for this deviation.
 *
 * So this check queries budgets at the six RG scopes it CAN read (the same
 * RGs costService.ts already tracks) and is explicit, in both the summary
 * and evidence, that it cannot see a subscription-scope budget — a 'warn'
 * (not 'fail': the check genuinely cannot rule out that the estate is fine)
 * when it finds none at RG scope, citing this limitation plus the known gap
 * register entry, rather than a false-confidence 'pass' OR an
 * indistinguishable-from-a-real-problem 'fail'.
 *
 * When budgets ARE found at RG scope, "unrealistically low threshold" is
 * flagged via LOW_AMOUNT_THRESHOLD_USD below — a budget with `amount` under
 * that (in whatever currency Cost Management reports; this app does not
 * convert) is treated as a likely misconfiguration (e.g. a placeholder
 * value never updated) rather than a deliberately tiny budget.
 *
 * API: Microsoft.Consumption/budgets LIST, api-version 2024-08-01 (current
 * GA version — verified against Microsoft Learn's Consumption ARM template
 * reference: amount/category/notifications/timeGrain/timePeriod).
 */

const API_VERSION = '2024-08-01';
const LOW_AMOUNT_THRESHOLD_USD = 10;

interface ArmBudget {
  name?: string;
  properties?: {
    amount?: number;
    category?: string;
    timeGrain?: string;
    notifications?: Record<string, { enabled?: boolean; threshold?: number; contactEmails?: string[] }>;
  };
}

interface BudgetEvidence {
  resourceGroup: string;
  name: string;
  amount: number | undefined;
  timeGrain: string | undefined;
  notificationCount: number;
}

export function evaluateBudgetCheck(perRg: Array<{ resourceGroup: string; budgets: ArmBudget[]; truncated?: boolean }>): GovernanceCheckResult {
  const base = { id: 'budget-sanity', title: 'Budget existence & sanity', category: 'Cost' };

  const found: BudgetEvidence[] = perRg.flatMap(({ resourceGroup, budgets }) =>
    budgets.map((b) => ({
      resourceGroup,
      name: b.name ?? 'unnamed',
      amount: b.properties?.amount,
      timeGrain: b.properties?.timeGrain,
      notificationCount: Object.keys(b.properties?.notifications ?? {}).length,
    })),
  );

  const evidence = {
    checkedResourceGroups: perRg.map((r) => r.resourceGroup),
    budgets: found,
    truncated: perRg.some((r) => r.truncated),
    scopeLimitation: 'Subscription-scope budgets are not visible to this check — this app deliberately holds no subscription-scope RBAC grant. See gap register item 11.',
  };

  if (found.length === 0) {
    return buildResult({
      ...base,
      status: 'warn',
      summary: 'No resource-group-scoped budgets found in any tracked RG. This check cannot see subscription-scope budgets — matches gap register item 11 ("No budget configured on sub-travel-avd") as of this estate\'s last inventory capture.',
      evidence,
    });
  }

  const low = found.filter((b) => typeof b.amount === 'number' && b.amount < LOW_AMOUNT_THRESHOLD_USD);
  const noNotifications = found.filter((b) => b.notificationCount === 0);

  if (low.length > 0) {
    return buildResult({
      ...base,
      status: 'warn',
      summary: `${low.length} budget(s) have an unrealistically low amount (< ${LOW_AMOUNT_THRESHOLD_USD}): ${low.map((b) => `${b.name} (${b.amount})`).join(', ')}.`,
      evidence,
    });
  }
  if (noNotifications.length > 0) {
    return buildResult({
      ...base,
      status: 'warn',
      summary: `${noNotifications.length} budget(s) have no notifications configured: ${noNotifications.map((b) => b.name).join(', ')}.`,
      evidence,
    });
  }
  return buildResult({ ...base, status: 'pass', summary: `Found ${found.length} resource-group-scoped budget(s) with sane amounts and notifications configured.`, evidence });
}

export async function fetchBudgetCheck(): Promise<GovernanceCheckResult> {
  const { subscriptionId, resourceGroups } = getConfig();
  const trackedRgs = [resourceGroups.hostPools, resourceGroups.images, resourceGroups.monitoring, resourceGroups.management, resourceGroups.network, resourceGroups.storage];

  const perRg = await Promise.all(
    trackedRgs.map(async (resourceGroup) => {
      const { items, truncated } = await armList<ArmBudget>(`/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.Consumption/budgets`, API_VERSION);
      return { resourceGroup, budgets: items, truncated };
    }),
  );

  return evaluateBudgetCheck(perRg);
}
