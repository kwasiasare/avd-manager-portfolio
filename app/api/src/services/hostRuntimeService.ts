import { DefaultAzureCredential } from '@azure/identity';
import { LogsQueryClient, LogsQueryResultStatus } from '@azure/monitor-query-logs';
import type { LogsQueryResult, LogsTable } from '@azure/monitor-query-logs';
import type { HostRuntimeSummary } from '@avdmgr/shared';
import { getConfig } from '../lib/config';

/*
 * SDK choice: @azure/monitor-query-logs (LogsQueryClient) over the older
 * @azure/monitor-query.
 *
 * The AM-25 story named @azure/monitor-query, but `npm install` surfaced an
 * explicit deprecation notice on it: "Deprecated: use
 * @azure/monitor-query-logs, @azure/monitor-query-metrics and
 * @azure/arm-monitor." @azure/monitor-query-logs is npm 1.0.0, not
 * deprecated, and documented on Microsoft Learn as the current logs-query
 * client — same queryWorkspace(workspaceId, kql, timespan) shape the story
 * expected, just under the split package. Switched to it here.
 *
 * RBAC: needs Log Analytics Reader (Microsoft.OperationalInsights/workspaces/
 * query/*\/read data-plane actions) on LAW-CONTOSO-PROD — this is ALREADY
 * granted at RG-AVD-Monitoring scope by infra/main.bicep's rbacMonitoring
 * module (logAnalyticsReaderRoleDefinitionId), added back in M1 specifically
 * "so a future Monitoring page does not need a follow-up RBAC change" (see
 * infra/modules/rbac.bicep's comment) — this service is that future
 * consumer. No new RBAC grant needed for this file.
 *
 * DATA SOURCE LIMITATION — verified against
 * The monitoring runbook and
 * The captured estate inventory installed
 * extensions for avd-con-0 (AADLoginForWindows, GuestAttestation,
 * Microsoft.PowerShell.DSC only — no AzureMonitorWindowsAgent/Microsoft
 * Monitoring Agent extension). This estate has NO Azure Monitor Agent (or
 * legacy Log Analytics Agent) installed on any session host, so the
 * Heartbeat table the AM-25 story asked for first is NOT populated for
 * these VMs and cannot be used — verify this directly against a live
 * workspace (`Heartbeat | where Computer == "avd-con-0" | count`) before
 * assuming otherwise on an estate that has since deployed AMA.
 *
 * What IS populated: WVDAgentHealthStatus. The host pool's diagnostic
 * setting (DIAG-HP-CONTOSO-PROD) has the AgentHealthStatus category enabled
 * (the monitoring runbook §2.1) and routes to LAW-CONTOSO-PROD — the
 * AVD agent posts a row to this table periodically WHILE the host is
 * running and registered. This service uses "at least one
 * WVDAgentHealthStatus row in a given clock hour" as a coarse presence
 * signal, bucketed over the trailing 7 days (168 one-hour buckets). This is
 * NOT a true power-state history:
 *   - it reports "agent-reporting hours", not minute-precise power-on time
 *     — a host running for 5 minutes of an hour still counts that whole
 *     hour as "running";
 *   - it cannot distinguish a briefly-unhealthy agent from a fully healthy
 *     one — ANY status row counts as presence;
 *   - a gap could mean the host was genuinely deallocated, OR that
 *     LAW-CONTOSO-PROD's 1 GB/day ingestion cap (RespectQuota — see
 *     The monitoring runbook §1) silently dropped the data for
 *     that hour. A query-level failure (the whole request errors, e.g. the
 *     workspace is unreachable) is reported as dataSource: 'none' /
 *     unknownHours for every host — NOT as "0 running hours" — but a
 *     partial ingestion gap within an otherwise-successful query is
 *     indistinguishable from real deallocated time and IS counted as
 *     deallocated. Treat low running-hours numbers with this caveat in
 *     mind, especially if the daily cap has been hit recently (gap
 *     register item 7);
 *   - AutoscaleEvaluationPooled (the scaling-decision event category) is
 *     disabled on this host pool's diagnostic setting (gap register item
 *     15), so there is no scale-action event log to cross-check against
 *     either.
 * If/when AMA is deployed to session hosts, Heartbeat is the better signal
 * and this service should be revisited to prefer it.
 *
 * PEER REVIEW FIXES (AM-25 round 2):
 *   - the KQL is now scoped to the caller's host list (SessionHostName
 *     in~ (...)) instead of scanning the whole workspace — this estate
 *     only has one host pool today, so it was harmless in practice, but an
 *     unscoped query would silently mix in another host pool's hosts (or
 *     same-named hosts from a decommissioned pool) once this estate grows;
 *   - summarizeHostRuntime now clamps windowHours to a host's own
 *     first-seen hour when that's later than the nominal 7-day window
 *     start, so a host added partway through the lookback isn't shown as
 *     "deallocated" for hours before it existed;
 *   - deriveRunningSinceApprox's "is this host currently in a run" check
 *     now tolerates up to a 2-hour gap (was 1), since WVDAgentHealthStatus
 *     ingestion lag can exceed one bucket.
 */

let cachedClient: LogsQueryClient | undefined;

function getClient(): LogsQueryClient {
  if (!cachedClient) {
    const credential = new DefaultAzureCredential();
    cachedClient = new LogsQueryClient(credential);
  }
  return cachedClient;
}

const WINDOW_DAYS = 7;
const WINDOW_HOURS = WINDOW_DAYS * 24;
const HOUR_MS = 60 * 60 * 1000;
/** How many hour-buckets back deriveRunningSinceApprox will look before giving up on "is this host currently in a run" — see that function's doc comment. */
const RUNNING_SINCE_LOOKBACK_BUCKETS = 2;

/**
 * Strips a domain/FQDN suffix and lower-cases, so "avd-con-0" and
 * "avd-con-0.contoso.local" (or differing case) are treated as the same
 * host. Exported: idleHostsService.ts/savingsService.ts reuse this to look
 * up HostHourlyPresence.seenHoursByHost entries by the same key this
 * module builds them with.
 */
export function normalizeHostName(name: string): string {
  return name.split('.')[0].toLowerCase();
}

function findColumnIndex(table: LogsTable, columnName: string): number {
  return table.columnDescriptors.findIndex((column) => column.name === columnName);
}

/**
 * Extracts the result table, tolerating a partial failure (some data, some
 * error) by using whatever rows came back and letting the caller log the
 * partial error — a partial result is still more useful than none. Note:
 * LogsQueryClient.queryWorkspace's return type only has Success/
 * PartialFailure variants — a genuine query failure instead rejects the
 * promise (handled by the try/catch in fetchHostHourlyPresence below), so
 * there is no third "Failure" status to branch on here.
 */
function extractTable(result: LogsQueryResult, warn: (message: string) => void): LogsTable | undefined {
  if (result.status === LogsQueryResultStatus.PartialFailure) {
    warn(`WVDAgentHealthStatus query partially failed: ${result.partialError.message}`);
    return result.partialTables[0];
  }
  return result.tables[0];
}

/**
 * KQL double-quoted string literal, escaping backslashes and double quotes
 * (KQL supports C-style escaping inside double-quoted strings). Azure VM
 * names are already constrained to alphanumerics/hyphens by ARM, so this
 * is defense-in-depth rather than a realistic injection vector — but the
 * host names here ultimately come from ARM data this service doesn't
 * control the format of, so escape properly rather than trusting that.
 */
function kqlStringLiteral(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export interface HostHourlyPresence {
  /** Set of hour-bucket epoch-ms values (each the start of a clock hour) seen for each host, keyed by normalizeHostName. */
  seenHoursByHost: Map<string, Set<number>>;
  /** False when the query itself couldn't run at all (missing config, LAW error) — every host should be treated as dataSource: 'none' in that case, not "0 running hours". */
  available: boolean;
}

const EMPTY_PRESENCE: HostHourlyPresence = { seenHoursByHost: new Map(), available: false };

/**
 * Runs the single WVDAgentHealthStatus presence query this module is built
 * around, shared by both getHostRuntimeSummaries (the /v1/cost/host-runtime
 * endpoint) and deriveRunningSinceApprox's caller (the /v1/cost/idle-hosts
 * and /v1/cost/savings endpoints' enrichment steps) so a single request
 * only issues this LAW query once, not once per consumer.
 *
 * `sessionHostNames` scopes the KQL `where` clause — pass every host name
 * the caller cares about; an empty array intentionally returns empty
 * presence data without querying at all (nothing to look up).
 */
export async function fetchHostHourlyPresence(
  sessionHostNames: string[],
  warn: (message: string) => void = () => {},
  log: (message: string) => void = () => {},
): Promise<HostHourlyPresence> {
  if (sessionHostNames.length === 0) {
    return { seenHoursByHost: new Map(), available: true };
  }

  const { logAnalyticsWorkspaceGuid } = getConfig();
  if (!logAnalyticsWorkspaceGuid) {
    warn('LAW_WORKSPACE_GUID is not configured — host runtime hours unavailable.');
    return EMPTY_PRESENCE;
  }

  const hostNameList = sessionHostNames.map(kqlStringLiteral).join(', ');
  const query = `
WVDAgentHealthStatus
| where TimeGenerated > ago(${WINDOW_DAYS}d)
| where SessionHostName in~ (${hostNameList})
| summarize by SessionHostName, HourBucket = bin(TimeGenerated, 1h)
`;

  const startedAt = Date.now();
  let result: LogsQueryResult;
  try {
    const client = getClient();
    result = await client.queryWorkspace(logAnalyticsWorkspaceGuid, query, { duration: `P${WINDOW_DAYS}D` });
  } catch (error) {
    warn(`WVDAgentHealthStatus query threw after ${Date.now() - startedAt}ms: ${error instanceof Error ? error.message : String(error)}`);
    return EMPTY_PRESENCE;
  }
  log(`WVDAgentHealthStatus query completed in ${Date.now() - startedAt}ms for ${sessionHostNames.length} host(s)`);

  const table = extractTable(result, warn);
  if (!table) {
    return EMPTY_PRESENCE;
  }

  const hostIndex = findColumnIndex(table, 'SessionHostName');
  const hourIndex = findColumnIndex(table, 'HourBucket');
  if (hostIndex === -1 || hourIndex === -1) {
    warn('WVDAgentHealthStatus query result is missing expected columns (SessionHostName/HourBucket).');
    return EMPTY_PRESENCE;
  }

  const seenHoursByHost = new Map<string, Set<number>>();
  for (const row of table.rows) {
    const rawName = row[hostIndex];
    const hourValue = row[hourIndex];
    if (typeof rawName !== 'string') continue;
    const hourMs = hourValue instanceof Date ? hourValue.getTime() : new Date(String(hourValue)).getTime();
    if (Number.isNaN(hourMs)) continue;

    const key = normalizeHostName(rawName);
    const hours = seenHoursByHost.get(key) ?? new Set<number>();
    hours.add(hourMs);
    seenHoursByHost.set(key, hours);
  }

  return { seenHoursByHost, available: true };
}

/**
 * Pure: turns one host's seen-hours set into a HostRuntimeSummary. Exported
 * for unit testing without a mocked LogsQueryClient.
 *
 * windowHours is clamped to the host's own first-seen hour when that's
 * later than the nominal 7-day window start (now - WINDOW_HOURS) — a host
 * added to the pool partway through the lookback period has no "before it
 * existed" hours to legitimately count as deallocated. A host with ZERO
 * seen hours keeps the FULL nominal window as deallocated: there is no
 * evidence either way of when (or whether) it started reporting, so this
 * stays the conservative default rather than guessing a later start.
 */
export function summarizeHostRuntime(sessionHostName: string, hostPoolName: string, presence: HostHourlyPresence, now: Date = new Date()): HostRuntimeSummary {
  if (!presence.available) {
    return { sessionHostName, hostPoolName, runningHours: 0, deallocatedHours: 0, unknownHours: WINDOW_HOURS, windowHours: WINDOW_HOURS, dataSource: 'none' };
  }

  const seenHours = presence.seenHoursByHost.get(normalizeHostName(sessionHostName));
  const runningHours = Math.min(seenHours?.size ?? 0, WINDOW_HOURS);

  let windowHours = WINDOW_HOURS;
  if (seenHours && seenHours.size > 0) {
    const nominalWindowStart = now.getTime() - WINDOW_HOURS * HOUR_MS;
    const firstSeenMs = Math.min(...seenHours);
    if (firstSeenMs > nominalWindowStart) {
      windowHours = Math.max(runningHours, Math.round((now.getTime() - firstSeenMs) / HOUR_MS));
    }
  }

  return {
    sessionHostName,
    hostPoolName,
    runningHours,
    deallocatedHours: windowHours - runningHours,
    unknownHours: 0,
    windowHours,
    dataSource: 'WVDAgentHealthStatus',
  };
}

/**
 * Returns running-vs-deallocated hours over the trailing 7 days for each
 * name in `sessionHostNames`, scoped to `hostPoolName`. Never throws — a
 * query failure degrades every host to dataSource: 'none' rather than
 * failing the whole request, matching this app's per-source-degrades-
 * independently convention (see
 * app/api/src/services/avdService.ts#resolvePowerState for the same
 * pattern at the single-host level).
 */
export async function getHostRuntimeSummaries(
  hostPoolName: string,
  sessionHostNames: string[],
  warn: (message: string) => void = () => {},
  log: (message: string) => void = () => {},
): Promise<HostRuntimeSummary[]> {
  const presence = await fetchHostHourlyPresence(sessionHostNames, warn, log);
  return sessionHostNames.map((name) => summarizeHostRuntime(name, hostPoolName, presence));
}

/**
 * Best-effort "running since" timestamp for a host that currently looks
 * like it's mid-run: the earliest hour bucket in an unbroken run of "seen"
 * hours counting back from `now`. Pure — takes the already-fetched
 * per-host seen-hours set, not a host name, so it composes with
 * fetchHostHourlyPresence's single shared query.
 *
 * Returns undefined ("not derivable") when: there's no presence data for
 * the host, OR none of the current hour bucket or the
 * RUNNING_SINCE_LOOKBACK_BUCKETS buckets before it have data (the host
 * doesn't look like it's in an active run right now — could be a stale
 * query result, ingestion lag, or a genuinely-just-started host with no
 * data yet; this function does not guess in either case).
 */
export function deriveRunningSinceApprox(seenHours: Set<number> | undefined, now: Date = new Date()): string | undefined {
  if (!seenHours || seenHours.size === 0) {
    return undefined;
  }

  const currentHourStart = Math.floor(now.getTime() / HOUR_MS) * HOUR_MS;

  let cursor: number | undefined;
  for (let hoursBack = 0; hoursBack <= RUNNING_SINCE_LOOKBACK_BUCKETS; hoursBack += 1) {
    const candidate = currentHourStart - hoursBack * HOUR_MS;
    if (seenHours.has(candidate)) {
      cursor = candidate;
      break;
    }
  }
  if (cursor === undefined) {
    return undefined;
  }

  while (seenHours.has(cursor - HOUR_MS)) {
    cursor -= HOUR_MS;
  }

  return new Date(cursor).toISOString();
}
