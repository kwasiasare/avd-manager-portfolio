import { randomUUID } from 'node:crypto';
import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import type { ApiError, AlertsFeedResponse } from '@avdmgr/shared';
import { requireMinimumRole } from '../lib/auth';
import { MAX_ALERT_HOURS, MIN_ALERT_HOURS, parseHoursParam } from '../lib/logsGuard';
import { applyAlertState, extractAlertGuid, listAlertStates, type AlertStateEntity } from '../lib/alertState';
import { listAlerts } from '../services/alertsService';

const DEFAULT_ALERT_HOURS = 24;

/**
 * GET /v1/alerts?hours=24 — the AM-24 alert feed. Viewer+ (read-only).
 * `hours` defaults to 24, bounded to [1, 168] (see logsGuard.ts).
 * Each alert carries app-level ack/snooze state merged in from the
 * AlertState table — see app/api/src/lib/alertState.ts#applyAlertState.
 *
 * Response is wrapped (AlertsFeedResponse: { alerts, degraded }), not a bare
 * array — peer review item 12: when the AlertState Table lookup fails, the
 * alerts are still returned (never fail the whole feed over the overlay —
 * see the inner try/catch below) but `degraded: true` tells the UI to show
 * a "ack/snooze state unavailable" notice instead of silently rendering
 * every alert as if nobody had acted on it.
 */
export async function alertsList(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const authResult = requireMinimumRole(request, 'viewer', context);
  if (!authResult.ok) {
    return authResult.response;
  }

  const hoursResult = parseHoursParam(request.query.get('hours'), DEFAULT_ALERT_HOURS, MIN_ALERT_HOURS, MAX_ALERT_HOURS);
  if (!hoursResult.ok) {
    return { status: hoursResult.error.status, jsonBody: hoursResult.error };
  }

  try {
    const alerts = await listAlerts(hoursResult.value);

    // Ack/snooze state is an overlay, not the primary data this endpoint
    // exists for — a Table Storage hiccup (or ALERT_STATE_TABLE_NAME's
    // storage account simply not being configured yet in an environment
    // mid-rollout) should degrade to "alerts without ack/snooze badges",
    // not fail the whole feed. `degraded` tells the caller this happened.
    let states: Map<string, AlertStateEntity>;
    let degraded = false;
    try {
      states = await listAlertStates();
    } catch (stateError) {
      context.warn(`alert state lookup failed, returning alerts without ack/snooze overlay | error=${String(stateError)}`);
      states = new Map();
      degraded = true;
    }

    const now = new Date();
    const merged = alerts.map((alert) => {
      const guid = extractAlertGuid(alert.id);
      if (!guid) {
        // Azure handed back an alert id that doesn't match the expected
        // Microsoft.AlertsManagement/alerts/{guid} ARM shape — this alert
        // simply can't carry app-level ack/snooze state (no key to look it
        // up under), which is a fact worth a warning, not a silent no-op.
        context.warn(`alert id did not match the expected ARM resource id shape, skipping ack/snooze lookup | alertId=${alert.id}`);
        return alert;
      }
      return applyAlertState(alert, states.get(guid), now);
    });

    const responseBody: AlertsFeedResponse = { alerts: merged, degraded };
    return { status: 200, jsonBody: responseBody };
  } catch (error) {
    const correlationId = randomUUID();
    context.error(`alerts list failed | hours=${hoursResult.value} correlationId=${correlationId}`, error);
    const apiError: ApiError = {
      status: 502,
      code: 'alerts_list_failed',
      message: `Failed to retrieve alerts from Azure. Reference: ${correlationId}`,
      details: { correlationId },
    };
    return { status: 502, jsonBody: apiError };
  }
}

app.http('alertsList', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'v1/alerts',
  handler: alertsList,
});
