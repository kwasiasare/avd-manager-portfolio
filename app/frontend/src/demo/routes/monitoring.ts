import {
  computeScalingPhase,
  type AckAlertRequest,
  type AlertsFeedResponse,
  type AlertSummary,
  type AuditRecentResponse,
  type EstateSummaryResponse,
  type HealthSummary,
  type SettingsResponse,
  type SnoozeAlertRequest,
} from '@avdmgr/shared';
import { buildSettings, HOST_POOL_NAME } from '../fixtures/estate';
import { HOUR } from '../fixtures/time';
import { demoUserDetails, getDemoRole } from '../identity';
import { badRequest, notFound, read, simulate } from '../router';
import { recordAudit, type DemoState } from '../state';
import { computeHealthSummary } from './hostPools';

function findAlert(state: DemoState, guid: string): AlertSummary {
  const alert = state.alerts.find((candidate) => candidate.id.endsWith(`/${guid}`));
  if (!alert) throw notFound('That alert no longer exists.');
  return alert;
}

function openAlertCount(state: DemoState): number {
  return state.alerts.filter((alert) => alert.status !== 'Acknowledged' && alert.status !== 'Closed').length;
}

function clampInt(raw: string | null, fallback: number, min: number, max: number): number {
  const parsed = raw === null ? Number.NaN : Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

export function registerMonitoringRoutes(): void {
  read<EstateSummaryResponse>('/v1/estate/summary', ({ state }) => {
    const health = computeHealthSummary(state);
    return {
      generatedAt: new Date().toISOString(),
      hostPoolName: HOST_POOL_NAME,
      hosts: { available: health.available, total: health.total },
      sessions: { used: health.sessionsUsed, capacity: health.sessionsMax },
      scalingPhase: computeScalingPhase(state.scalingPlan),
      openAlertCount: openAlertCount(state),
      overrideActive: Boolean(state.override && state.override.expiresAt > Date.now()),
    } satisfies EstateSummaryResponse;
  });

  read<HealthSummary>('/v1/health/summary', ({ state }) => computeHealthSummary(state));

  read<SettingsResponse>('/v1/settings', ({ state }) => buildSettings(state.now));

  // --- alerts ---
  read<AlertSummary[]>('/v1/alerts/recent', ({ state }) => state.alerts.filter((alert) => alert.status !== 'Closed' && Date.parse(alert.firedAt) > Date.now() - 24 * HOUR).sort((a, b) => b.firedAt.localeCompare(a.firedAt)));

  read<AlertsFeedResponse>('/v1/alerts', ({ query, state }) => {
    const hours = clampInt(query.get('hours'), 24, 1, 720);
    const alerts = state.alerts.filter((alert) => Date.parse(alert.firedAt) > Date.now() - hours * HOUR).sort((a, b) => b.firedAt.localeCompare(a.firedAt));
    return { alerts, degraded: false };
  });

  simulate<undefined, AckAlertRequest | undefined>('POST', '/v1/alerts/:alertGuid/ack', ({ params, body, state }) => {
    const alert = findAlert(state, params.alertGuid);
    alert.status = 'Acknowledged';
    alert.ackedBy = demoUserDetails(getDemoRole());
    alert.ackedAt = new Date().toISOString();
    alert.ackedReason = body?.reason;
    recordAudit(state, { action: 'alert.ack', target: alert.name, reason: body?.reason });
    return undefined;
  });

  simulate<undefined>('DELETE', '/v1/alerts/:alertGuid/ack', ({ params, state }) => {
    const alert = findAlert(state, params.alertGuid);
    alert.status = 'New';
    delete alert.ackedBy;
    delete alert.ackedAt;
    delete alert.ackedReason;
    recordAudit(state, { action: 'alert.unack', target: alert.name });
    return undefined;
  });

  simulate<undefined, SnoozeAlertRequest | undefined>('POST', '/v1/alerts/:alertGuid/snooze', ({ params, body, state }) => {
    const alert = findAlert(state, params.alertGuid);
    const until = body?.untilIso ? Date.parse(body.untilIso) : Date.now() + (body?.hours ?? 4) * HOUR;
    if (!Number.isFinite(until) || until <= Date.now()) throw badRequest('Snooze must end in the future.');
    alert.snoozedUntil = new Date(until).toISOString();
    alert.snoozedBy = demoUserDetails(getDemoRole());
    alert.snoozeReason = body?.reason;
    recordAudit(state, { action: 'alert.snooze', target: alert.name, reason: body?.reason, hasParameters: true });
    return undefined;
  });

  simulate<undefined>('DELETE', '/v1/alerts/:alertGuid/snooze', ({ params, state }) => {
    const alert = findAlert(state, params.alertGuid);
    delete alert.snoozedUntil;
    delete alert.snoozedBy;
    delete alert.snoozeReason;
    recordAudit(state, { action: 'alert.unsnooze', target: alert.name });
    return undefined;
  });

  // --- audit ---
  read<AuditRecentResponse>('/v1/audit/recent', ({ query, state }) => {
    const top = clampInt(query.get('top'), 25, 1, 100);
    const sinceHours = clampInt(query.get('sinceHours'), 24, 1, 720);
    const actor = query.get('actor');
    const prefix = query.get('actionPrefix');
    const cutoff = Date.now() - sinceHours * HOUR;
    const matches = state.audit.filter((entry) => Date.parse(entry.occurredAt) >= cutoff && (!actor || entry.actor === actor) && (!prefix || entry.action.startsWith(prefix)));
    return { entries: matches.slice(0, top), truncated: matches.length > top, partial: false, sinceHours };
  });
}
