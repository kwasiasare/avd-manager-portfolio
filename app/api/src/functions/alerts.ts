import { randomUUID } from 'node:crypto';
import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import type { ApiError } from '@avdmgr/shared';
import { requireMinimumRole } from '../lib/auth';
import { applyAlertState, extractAlertGuid, isSnoozeActive, listAlertStates, type AlertStateEntity } from '../lib/alertState';
import { listRecentAlerts } from '../services/alertsService';

/** How many candidates to fetch before filtering out actively-snoozed ones and slicing to TICKER_LIMIT — headroom so a snooze doesn't just shrink the ticker below 3 entries. */
const CANDIDATE_LIMIT = 15;
const TICKER_LIMIT = 3;

/**
 * GET /v1/alerts/recent — the Dashboard's "last 3 fired alerts" ticker.
 * Viewer+. Peer review item 5: this now merges the same app-level
 * ack/snooze overlay as the full feed (app/api/src/functions/alertsList.ts)
 * and — unlike the full feed, where an operator needs to be able to SEE a
 * snoozed alert to un-snooze it — actively-snoozed alerts are filtered out
 * of the ticker entirely. The ticker has room for exactly 3 entries; a
 * snoozed alert is one an operator already told the app to stop drawing
 * attention to, so it shouldn't occupy that scarce space.
 *
 * Unlike alertsList.ts, this endpoint does NOT expose a `degraded` flag on
 * a Table Storage failure — it keeps its existing bare-array
 * AlertSummary[] response shape (the Dashboard ticker has no UI for a
 * degraded notice) and simply falls back to unmerged/unfiltered results,
 * same fail-open-on-overlay posture as alertsList.ts, just without
 * surfacing that fact over the wire for this smaller, lower-stakes widget.
 */
export async function alertsRecent(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const authResult = requireMinimumRole(request, 'viewer', context);
  if (!authResult.ok) {
    return authResult.response;
  }

  try {
    const candidates = await listRecentAlerts(CANDIDATE_LIMIT);

    let states: Map<string, AlertStateEntity>;
    try {
      states = await listAlertStates();
    } catch (stateError) {
      context.warn(`alert state lookup failed, returning ticker without ack/snooze overlay | error=${String(stateError)}`);
      states = new Map();
    }

    const now = new Date();
    const merged = candidates
      .map((alert) => {
        const guid = extractAlertGuid(alert.id);
        if (!guid) {
          context.warn(`alert id did not match the expected ARM resource id shape, skipping ack/snooze lookup | alertId=${alert.id}`);
          return alert;
        }
        return applyAlertState(alert, states.get(guid), now);
      })
      .filter((alert) => !isSnoozeActive(alert.snoozedUntil, now))
      .slice(0, TICKER_LIMIT);

    return { status: 200, jsonBody: merged };
  } catch (error) {
    const correlationId = randomUUID();
    context.error(`recent alerts lookup failed | correlationId=${correlationId}`, error);
    const apiError: ApiError = {
      status: 502,
      code: 'alerts_lookup_failed',
      message: `Failed to retrieve recent alerts from Azure. Reference: ${correlationId}`,
      details: { correlationId },
    };
    return { status: 502, jsonBody: apiError };
  }
}

app.http('alertsRecent', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'v1/alerts/recent',
  handler: alertsRecent,
});
