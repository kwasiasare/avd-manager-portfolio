import type { GovernanceCheckResult } from '@avdmgr/shared';
import { armGet } from '../../lib/armRest';
import { getConfig } from '../../lib/config';
import { runLogsQuery } from '../logsService';
import { buildResult } from './support';

/*
 * Check 8b (gap register item 7): proactive daily-cap watch for
 * LAW-CONTOSO-PROD's 1 GB/day RespectQuota ingestion cap — the SAME cap the
 * register calls out as able to "silently stop both log ingestion and
 * alerting until daily reset." This turns the manual watch procedure
 * (06-monitoring-response.md §3) into a standing check.
 *
 * TWO reads combined:
 *   1. The workspace's OWN configured cap (workspaceCapping.dailyQuotaGb) —
 *      ARM GET, api-version 2023-09-01 (verified against Microsoft Learn's
 *      OperationalInsights ARM template reference). RBAC: plain Reader on
 *      RG-AVD-Monitoring, already granted (infra/main.bicep's
 *      rbacMonitoring module) — this is a control-plane field on the
 *      workspace's own GET response, no LAW data-plane query needed for
 *      this half.
 *   2. Recent daily ingestion volume — reuses services/logsService.ts's
 *      runLogsQuery (the SAME LogsQueryClient every curated view already
 *      goes through), querying the `Usage` table's billable GB per day over
 *      the last 7 days. RBAC: the workspace-scoped Log Analytics Reader
 *      grant logsService.ts already documents
 *      (infra/modules/logAnalyticsWorkspaceRbac.bicep) — no new grant.
 *      `Usage` is a standard Azure Monitor table (not AVD-specific) so no
 *      new schema verification was needed beyond what logsService.ts
 *      already established for querying this workspace.
 *
 * WARN_FRACTION below (80% of the cap) mirrors the "raise the cap with
 * margin" proactive posture the register's own remediation column
 * recommends, rather than only alerting once the cap is already hit.
 *
 * PEER REVIEW FIX (item 18): armGet returns `undefined` on BOTH a genuine
 * 404 (the workspace itself doesn't exist / was renamed) AND is
 * structurally identical to a successfully-fetched workspace whose
 * `workspaceCapping` object is simply absent (no cap configured — a
 * perfectly normal, valid state) once you only look at
 * `dailyQuotaGb`. Those are very different findings — "workspace not
 * found" is 'unknown' (this check could not run), "workspace exists, no
 * cap" is 'pass' (nothing to watch) — so evaluateLawIngestionCap now takes
 * `workspaceFound` as its own explicit boolean rather than inferring it
 * from whether `dailyQuotaGb` happens to be undefined.
 */

const WORKSPACE_API_VERSION = '2023-09-01';
const WARN_FRACTION = 0.8;
const LOOKBACK_DAYS = 7;

const USAGE_QUERY = `Usage
| where IsBillable == true
| summarize BillableGb = sum(Quantity) / 1000 by bin(TimeGenerated, 1d)
| order by TimeGenerated desc
| take ${LOOKBACK_DAYS}`;

interface ArmWorkspace {
  properties?: { workspaceCapping?: { dailyQuotaGb?: number } };
}

export interface DailyIngestionRow {
  date: string;
  billableGb: number;
}

const BASE = { id: 'law-ingestion-cap', title: 'Log Analytics daily ingestion cap', category: 'Monitoring' } as const;

export function evaluateLawIngestionCap(workspaceFound: boolean, dailyQuotaGb: number | undefined, dailyRows: DailyIngestionRow[], resourceId?: string): GovernanceCheckResult {
  const evidence = { workspaceFound, dailyQuotaGb, recentDays: dailyRows, warnThresholdFraction: WARN_FRACTION };

  if (!workspaceFound) {
    return buildResult({
      ...BASE,
      status: 'unknown',
      summary: resourceId ? `The Log Analytics workspace was not found at "${resourceId}" — it may have been renamed or deleted.` : 'The Log Analytics workspace was not found — it may have been renamed or deleted.',
      evidence,
    });
  }

  if (dailyQuotaGb === undefined || dailyQuotaGb < 0) {
    return buildResult({ ...BASE, status: 'pass', summary: 'No daily ingestion cap is configured on LAW-CONTOSO-PROD (unlimited) — ingestion cannot be silently capped.', evidence });
  }

  if (dailyRows.length === 0) {
    return buildResult({ ...BASE, status: 'unknown', summary: `A ${dailyQuotaGb} GB/day cap is configured, but recent ingestion volume could not be determined.`, evidence });
  }

  const peak = dailyRows.reduce((max, row) => (row.billableGb > max.billableGb ? row : max), dailyRows[0]);
  const warnThreshold = dailyQuotaGb * WARN_FRACTION;

  if (peak.billableGb >= dailyQuotaGb) {
    return buildResult({
      ...BASE,
      status: 'fail',
      summary: `Ingestion on ${peak.date} (${peak.billableGb.toFixed(2)} GB) met or exceeded the ${dailyQuotaGb} GB/day cap — log ingestion and alerting may have silently stopped that day until reset. See gap register item 7.`,
      evidence,
    });
  }
  if (peak.billableGb >= warnThreshold) {
    return buildResult({
      ...BASE,
      status: 'warn',
      summary: `Peak daily ingestion over the last ${LOOKBACK_DAYS} days (${peak.date}: ${peak.billableGb.toFixed(2)} GB) is within ${Math.round((1 - WARN_FRACTION) * 100)}% of the ${dailyQuotaGb} GB/day cap.`,
      evidence,
    });
  }
  return buildResult({
    ...BASE,
    status: 'pass',
    summary: `Peak daily ingestion over the last ${LOOKBACK_DAYS} days (${peak.billableGb.toFixed(2)} GB) is comfortably under the ${dailyQuotaGb} GB/day cap.`,
    evidence,
  });
}

function parseUsageRows(tables: Array<{ columns: { name: string }[]; rows: unknown[][] }>): DailyIngestionRow[] {
  const table = tables[0];
  if (!table) return [];
  const dateIndex = table.columns.findIndex((c) => c.name === 'TimeGenerated');
  const gbIndex = table.columns.findIndex((c) => c.name === 'BillableGb');
  if (dateIndex === -1 || gbIndex === -1) return [];

  return table.rows.map((row) => ({
    date: String(row[dateIndex]).slice(0, 10),
    billableGb: Number(row[gbIndex]) || 0,
  }));
}

export async function fetchLawIngestionCap(): Promise<GovernanceCheckResult> {
  const { logAnalyticsWorkspaceId, logAnalyticsWorkspaceGuid } = getConfig();

  // logAnalyticsWorkspaceId (the ARM resource id, set by
  // infra/modules/functionapp.bicep's LAW_WORKSPACE_ID app setting) is used
  // directly here rather than reconstructing a path from a hardcoded
  // workspace name — config.ts has no separate "LAW workspace name" field
  // (its `workspaceName` is the AVD Workspace, Contoso-Desktop, a
  // different resource entirely — see that field's own doc comment), and
  // the resource id already fully identifies the workspace to armGet. This
  // id also names the subscription/RG queried (peer review item 18) — it's
  // surfaced verbatim in the not-found summary above.
  if (!logAnalyticsWorkspaceId) {
    return buildResult({ ...BASE, status: 'unknown', summary: 'LAW_WORKSPACE_ID is not configured — cannot look up the daily ingestion cap.', evidence: {} });
  }

  const workspace = await armGet<ArmWorkspace>(logAnalyticsWorkspaceId, WORKSPACE_API_VERSION);
  const workspaceFound = workspace !== undefined;
  const dailyQuotaGb = workspace?.properties?.workspaceCapping?.dailyQuotaGb;

  if (!workspaceFound) {
    return evaluateLawIngestionCap(false, undefined, [], logAnalyticsWorkspaceId);
  }

  if (!logAnalyticsWorkspaceGuid) {
    return buildResult({ ...BASE, status: 'unknown', summary: 'LAW_WORKSPACE_GUID is not configured — cannot query recent ingestion volume.', evidence: { workspaceFound, dailyQuotaGb } });
  }

  const result = await runLogsQuery(USAGE_QUERY, LOOKBACK_DAYS * 24);
  const dailyRows = parseUsageRows(result.tables);

  return evaluateLawIngestionCap(true, dailyQuotaGb, dailyRows, logAnalyticsWorkspaceId);
}
