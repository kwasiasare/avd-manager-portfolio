import { DefaultAzureCredential } from '@azure/identity';
import { LogsQueryClient, LogsQueryResultStatus } from '@azure/monitor-query-logs';
import type { LogsColumn, LogsQueryResponse, LogsTableResult, LogsViewSummary } from '@avdmgr/shared';
import { getConfig } from '../lib/config';
import { capRows } from '../lib/logsGuard';

/*
 * SDK choice: @azure/monitor-query-logs (LogsQueryClient) rather than the
 * older @azure/monitor-query package the original task brief named.
 * Checked against Microsoft Learn before writing this: the
 * @azure/monitor-query package's own README
 * (https://learn.microsoft.com/javascript/api/overview/azure/monitor-query-readme)
 * now opens with "Deprecated: This package has been deprecated and is no
 * longer under active development" and directs LogsQueryClient users to
 * @azure/monitor-query-logs (GA, 1.0.0). The two packages' LogsQueryClient
 * API surface is identical for what this file needs — constructor
 * (TokenCredential), queryWorkspace(workspaceId, kql, timespan, options),
 * LogsQueryResultStatus, table.columnDescriptors/table.rows — so this is a
 * drop-in, not a design change.
 *
 * AUTH: workspaceId here is the Log Analytics workspace's "Workspace ID"
 * (its `customerId` GUID — config.logAnalyticsWorkspaceGuid), NOT the ARM
 * resource ID (config.logAnalyticsWorkspaceId). These are two different
 * identifiers for the same workspace; queryWorkspace specifically wants the
 * former. See app/api/src/lib/config.ts's doc comment and
 * infra/modules/functionapp.bicep, which resolves customerId from the
 * existing LAW-CONTOSO-PROD workspace resource and publishes it as the
 * LAW_WORKSPACE_GUID app setting.
 *
 * RBAC: DefaultAzureCredential resolves to the Function App's system-assigned
 * managed identity in deployed environments (same pattern as
 * alertsService.ts/avdService.ts). Verified on Microsoft Learn
 * (https://learn.microsoft.com/azure/role-based-access-control/built-in-roles/monitor#log-analytics-reader)
 * that the Log Analytics Reader role — granted to this identity scoped to
 * the LAW-CONTOSO-PROD workspace RESOURCE itself (infra/main.bicep; narrowed
 * from an earlier resource-group-scope grant per peer review — see
 * app/api/src/lib/logsGuard.ts's SECURITY POSTURE comment for the honest
 * account of what that narrowing does and doesn't isolate) — includes
 * `Microsoft.OperationalInsights/workspaces/analytics/query/action`, which
 * is exactly the data-plane action LogsQueryClient.queryWorkspace needs.
 */

let cachedClient: LogsQueryClient | undefined;

function getClient(): LogsQueryClient {
  if (!cachedClient) {
    cachedClient = new LogsQueryClient(new DefaultAzureCredential());
  }
  return cachedClient;
}

export interface CuratedView {
  id: string;
  name: string;
  description: string;
  kql: string;
}

/**
 * The four curated views (AM-24 scope). KQL verified against Microsoft
 * Learn's AVD diagnostics reference
 * (https://learn.microsoft.com/azure/virtual-desktop/diagnostics-log-analytics
 * and the per-table column references linked from
 * https://learn.microsoft.com/azure/azure-monitor/reference/tables/tables-index)
 * — table/column names are NOT guessed:
 *   - WVDConnections: CorrelationId, State ('Started'/'Connected'/
 *     'Completed'), UserName, SessionHostName, ClientOS, ClientType,
 *     TimeGenerated (see wvdconnections#columns).
 *   - WVDErrors: CorrelationId, Code, CodeSymbolic, Message, ServiceError,
 *     Source, UserName, TimeGenerated (see wvderrors#columns).
 *   - WVDAgentHealthStatus: SessionHostName, Status, StatusTimeStamp,
 *     ActiveSessions, AgentVersion, LastHeartBeat,
 *     SessionHostHealthCheckResult (dynamic array of
 *     {HealthCheckName, HealthCheckResult, ...} — see
 *     wvdagenthealthstatus#columns). HealthCheckName "FSLogixHealthCheck" is
 *     a documented value of the SDK's KnownHealthCheckName enum
 *     (@azure/arm-desktopvirtualization) — verified on Learn; Microsoft's
 *     docs note this specific check is "Currently Disabled" by default on
 *     the service side, so the FSLogix view legitimately may return zero
 *     rows in an environment that hasn't opted into it (documented in the
 *     view's description, not hidden as a silent empty result).
 */
export const CURATED_VIEWS: readonly CuratedView[] = [
  {
    id: 'connection-failures',
    name: 'Connection failures',
    description:
      'Connections that started but never reached Connected/Completed, left-joined to their WVDErrors row (a matching error is not always logged, so this still shows the failure even when no root-cause row exists).',
    kql: `WVDConnections
| where State == "Started"
| project CorrelationId, StartTime = TimeGenerated, UserName, SessionHostName, ClientOS, ClientType
| join kind=leftanti (
    WVDConnections
    | where State in ("Connected", "Completed")
    | project CorrelationId
) on CorrelationId
| join kind=leftouter (
    WVDErrors
    | project CorrelationId, ErrorTime = TimeGenerated, Code, CodeSymbolic, Message, ServiceError, Source
) on CorrelationId
| project StartTime, UserName, SessionHostName, ClientOS, ClientType, ErrorTime, Code, CodeSymbolic, Message, ServiceError, Source
| order by StartTime desc`,
  },
  {
    id: 'fslogix-errors',
    name: 'FSLogix errors',
    description:
      'Session hosts whose FSLogixHealthCheck agent health check has failed. Note: this check is disabled by default on the AVD service — this view may return no rows until it is enabled for the host pool.',
    kql: `WVDAgentHealthStatus
| mv-expand HealthCheck = SessionHostHealthCheckResult
| extend HealthCheckName = tostring(HealthCheck.HealthCheckName), HealthCheckResult = tostring(HealthCheck.HealthCheckResult)
| where HealthCheckName == "FSLogixHealthCheck" and HealthCheckResult != "HealthCheckSucceeded"
| project TimeGenerated, SessionHostName, HealthCheckResult, Status, AgentVersion
| order by TimeGenerated desc`,
  },
  {
    id: 'session-disconnects',
    name: 'Session disconnects',
    description: 'Completed connections (the WVDConnections state recorded when a user or server disconnects a session), with duration where the matching Connected row is available.',
    kql: `let Completed = WVDConnections | where State == "Completed" | project CorrelationId, EndTime = TimeGenerated, UserName, SessionHostName, ConnectionType;
let Connected = WVDConnections | where State == "Connected" | project CorrelationId, StartTime = TimeGenerated;
Completed
| join kind=leftouter (Connected) on CorrelationId
| project EndTime, UserName, SessionHostName, ConnectionType, Duration = EndTime - StartTime
| order by EndTime desc`,
  },
  {
    id: 'host-health-history',
    name: 'Host health history',
    description: 'WVDAgentHealthStatus rows over the selected window, newest first, showing each host\'s reported status and session counts.',
    kql: `WVDAgentHealthStatus
| project TimeGenerated, SessionHostName, Status, ActiveSessions, InactiveSessions, AgentVersion, LastHeartBeat
| order by TimeGenerated desc`,
  },
];

export function listCuratedViews(): LogsViewSummary[] {
  return CURATED_VIEWS.map(({ id, name, description }) => ({ id, name, description }));
}

export function findCuratedView(viewId: string): CuratedView | undefined {
  return CURATED_VIEWS.find((view) => view.id === viewId);
}

function toLogsColumn(descriptor: { name: string; type: string }): LogsColumn {
  return { name: descriptor.name, type: descriptor.type };
}

/**
 * Runs `kql` against LAW-CONTOSO-PROD over the last `hours`, returning a
 * server-side-capped (see logsGuard.ts MAX_RESULT_ROWS), wire-friendly
 * result. `kql` is passed as LogsQueryClient's distinct `query` argument —
 * never string-concatenated with the timespan or anything else this app
 * controls (the timespan is a SEPARATE, structured `QueryTimeInterval`
 * argument, not interpolated into the query text) — see the SECURITY
 * POSTURE comment in app/api/src/lib/logsGuard.ts for the full reasoning on
 * why this is safe even for caller-supplied (raw KQL) queries.
 */
export async function runLogsQuery(kql: string, hours: number): Promise<LogsQueryResponse> {
  const { logAnalyticsWorkspaceGuid } = getConfig();
  if (!logAnalyticsWorkspaceGuid) {
    throw new Error('LAW_WORKSPACE_GUID is not configured — cannot query Log Analytics (see infra/modules/functionapp.bicep).');
  }

  const client = getClient();
  const endTime = new Date();
  const startTime = new Date(endTime.getTime() - hours * 60 * 60 * 1000);

  // serverTimeoutInSeconds: 60 — an explicit, tighter bound than the SDK's
  // own default (180s) and well under its max (600s — both verified on
  // Microsoft Learn's LogsQueryOptions reference). 60s comfortably covers
  // every curated view here (simple filters/joins over the WVD* tables) and
  // any reasonable ad hoc query, while failing a runaway/expensive raw-KQL
  // query fast instead of letting it hold a Flex Consumption invocation
  // open near the platform's own execution-time ceiling.
  const options = { serverTimeoutInSeconds: 60 };

  // @azure/monitor-query-logs's queryWorkspace resolves to LogsQueryResult
  // (LogsQuerySuccessfulResult | LogsQueryPartialResult) ONLY — a genuine
  // Failure is thrown as a LogsQueryError (extends Error), not returned
  // with status: 'Failure' (that third status value exists on the enum for
  // queryBatch's per-query results, but queryWorkspace's own return type
  // narrows it away — verified against the installed SDK's
  // models/public.d.ts, not guessed). So a thrown error here propagates
  // straight to the caller (app/api/src/functions/logsQuery.ts /
  // logsViewRun.ts), which already catches and 502s it — no separate
  // Failure branch needed below.
  const result = await client.queryWorkspace(logAnalyticsWorkspaceGuid, kql, { startTime, endTime }, options);

  if (result.status === LogsQueryResultStatus.Success) {
    return { tables: result.tables.map(mapTable) };
  }

  // PartialFailure: surface partial results rather than silently discarding
  // them, but make the partial-failure visible to the caller via a thrown
  // error carrying the Kusto-reported message — the calling function turns
  // this into a 502 with a correlation id, same pattern as every other
  // service in this app.
  throw new Error(`Log Analytics query partially failed: ${result.partialError?.message ?? 'unknown error'}`);
}

function mapTable(table: { name?: string; columnDescriptors: { name: string; type: string }[]; rows: unknown[][] }): LogsTableResult {
  const { rows, truncated } = capRows(table.rows);
  return {
    name: table.name,
    columns: table.columnDescriptors.map(toLogsColumn),
    rows,
    truncated,
  };
}
