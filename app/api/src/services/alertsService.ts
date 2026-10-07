import { DefaultAzureCredential } from '@azure/identity';
import { AlertsManagementClient } from '@azure/arm-alertsmanagement';
import type { Alert, Severity, AlertState } from '@azure/arm-alertsmanagement';
import type { AlertSummary } from '@avdmgr/shared';
import { getConfig } from '../lib/config';

/*
 * SDK choice: @azure/arm-alertsmanagement (AlertsManagementClient) over a
 * @azure/monitor-query KQL query against the Log Analytics workspace.
 *
 * Reasoning: "fired alerts" (severity/state/target resource/firedAt) is
 * exactly the resource AlertsManagementClient.alerts.getAll models — it's
 * the same API the Azure Portal's Alerts blade uses, and it queries the
 * Alerts service directly rather than depending on scheduled query rules'
 * output also being routed into LAW via diagnostic settings (which
 * app/api/src/lib/config.ts's alert rules aren't guaranteed to do, and
 * LAW-CONTOSO-PROD has a 1 GB/day ingestion cap — see the runbooks
 * anomalies — that could silently drop the very rows a KQL query would
 * depend on). The npm package version is tagged 1.0.0-beta.1, but it is
 * actively published (verified: last modified within the last few months)
 * — the API itself has been stable for years; Azure has just never cut a
 * GA release under this package name.
 */

let cachedClient: AlertsManagementClient | undefined;

function getClient(): AlertsManagementClient {
  if (!cachedClient) {
    const credential = new DefaultAzureCredential();
    cachedClient = new AlertsManagementClient(credential);
  }
  return cachedClient;
}

const KNOWN_SEVERITIES: readonly AlertSummary['severity'][] = ['Sev0', 'Sev1', 'Sev2', 'Sev3', 'Sev4'];
const KNOWN_STATUSES: readonly AlertSummary['status'][] = ['New', 'Acknowledged', 'Closed'];

function normalizeSeverity(value: Severity | undefined): AlertSummary['severity'] {
  return (KNOWN_SEVERITIES as readonly string[]).includes(value ?? '') ? (value as AlertSummary['severity']) : 'Sev4';
}

function normalizeStatus(value: AlertState | undefined): AlertSummary['status'] {
  return (KNOWN_STATUSES as readonly string[]).includes(value ?? '') ? (value as AlertSummary['status']) : 'New';
}

function mapAlert(armAlert: Alert): AlertSummary {
  const essentials = armAlert.properties?.essentials;
  return {
    id: armAlert.id ?? '',
    name: essentials?.alertRule ?? armAlert.name ?? 'Unknown alert',
    severity: normalizeSeverity(essentials?.severity),
    status: normalizeStatus(essentials?.alertState),
    firedAt: essentials?.startDateTime?.toISOString() ?? new Date(0).toISOString(),
    description: essentials?.description,
    // targetResourceName (friendly name) preferred over the full ARM
    // resource ID (targetResource) for display — falls back to the ARM ID
    // only when the friendly name is unavailable.
    targetResource: essentials?.targetResourceName ?? essentials?.targetResource,
  };
}

/**
 * Returns the most recently fired alerts (default: last 3) targeting
 * RG-AVD-Monitoring, newest first. `monitorCondition: 'Fired'` excludes
 * alerts that have already auto-resolved, so the ticker only shows alerts
 * that are (or were, within the lookback window) actively firing.
 */
export async function listRecentAlerts(limit = 3): Promise<AlertSummary[]> {
  const client = getClient();
  const { subscriptionId, resourceGroups } = getConfig();

  const results: AlertSummary[] = [];
  const pages = client.alerts.getAll(`subscriptions/${subscriptionId}`, {
    targetResourceGroup: resourceGroups.monitoring,
    monitorCondition: 'Fired',
    sortBy: 'startDateTime',
    sortOrder: 'desc',
    pageCount: limit,
    timeRange: '30d',
  });

  for await (const armAlert of pages) {
    results.push(mapAlert(armAlert));
    if (results.length >= limit) {
      break;
    }
  }

  return results;
}

/**
 * Returns AVD-estate alerts (RG-AVD-Monitoring) fired within the last
 * `hours`, newest first — the AM-24 alert feed (GET /v1/alerts?hours=).
 * App-level ack/snooze state is NOT merged in here (that's a separate
 * concern — see app/api/src/lib/alertState.ts#applyAlertState, applied by
 * the caller in app/api/src/functions/alertsList.ts) so this function stays
 * a thin, testable-by-inspection wrapper over the Alerts Management SDK.
 *
 * Uses `customTimeRange` (format `<start>/<end>`, ISO-8601, both endpoints
 * required) rather than the SDK's preset `timeRange` enum ('1h'/'1d'/'7d'/
 * '30d'/'3d') because the caller-supplied `hours` (1..168, see
 * app/api/src/lib/logsGuard.ts MIN_ALERT_HOURS/MAX_ALERT_HOURS) doesn't map
 * onto that fixed preset list. Per AlertsGetAllOptionalParams.customTimeRange
 * (https://learn.microsoft.com/javascript/api/@azure/arm-alertsmanagement/alertsgetalloptionalparams),
 * "Either timeRange or customTimeRange could be used but not both" and the
 * permissible window is within 30 days from query time — 168h (7d) is well
 * inside that ceiling.
 *
 * No `limit` cap here (unlike listRecentAlerts) — pageCount bounds how many
 * results are returned per SDK page, not how many pages are iterated, and
 * the realistic alert volume for one AVD estate over a 7-day window is
 * small; the frontend renders the full list.
 */
export async function listAlerts(hours: number): Promise<AlertSummary[]> {
  const client = getClient();
  const { subscriptionId, resourceGroups } = getConfig();

  const end = new Date();
  const start = new Date(end.getTime() - hours * 60 * 60 * 1000);
  const customTimeRange = `${start.toISOString()}/${end.toISOString()}`;

  const results: AlertSummary[] = [];
  const pages = client.alerts.getAll(`subscriptions/${subscriptionId}`, {
    targetResourceGroup: resourceGroups.monitoring,
    customTimeRange,
    sortBy: 'startDateTime',
    sortOrder: 'desc',
  });

  for await (const armAlert of pages) {
    results.push(mapAlert(armAlert));
  }

  return results;
}
