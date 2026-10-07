import { randomUUID } from 'node:crypto';
import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import type { ApiError, ScalingHistoryEntry, ScalingHistoryResponse } from '@avdmgr/shared';
import { requireRole } from '../lib/auth';
import { queryRecentAuditEntries, type AuditEntity, type AuditLogger } from '../lib/auditLog';

/**
 * Every audit action id this app writes for a scaling-plan mutation shares
 * this prefix (see scalingSchedule.ts, scalingScheduleCreate.ts,
 * scalingEmergencyOverride.ts, scalingOverrideReEnable.ts) — the filter
 * queryRecentAuditEntries uses to select only scaling-related rows out of
 * the shared AuditLog table (which also carries session-host/session
 * mutation rows under their own unrelated prefixes).
 */
const ACTION_PREFIX = 'scalingplan.';
const HISTORY_LIMIT = 10;

/**
 * Auto-re-enable FAILURE rows (scalingOverrideReEnable.ts's timer) are
 * deduplicated at write time (at most one per stuck-override episode — see
 * ScalingOverrideEntity.reEnableFailureAudited's doc comment), but peer
 * review (AM-23 MINOR 6/7) additionally excludes them from this
 * user-facing change-history feed entirely: a failed auto-re-enable is
 * operational noise best surfaced via the SCALING_OVERRIDE_STRANDED /
 * repeated-failure log markers (see infra/modules/functionapp.bicep's
 * alerting comment) an operator monitors directly, not a "what changed"
 * feed every signed-in role reads. A successful auto-re-enable (outcome
 * 'success') IS still shown — that's a real state change worth recording.
 * This is a POST-query filter, so a history page that happens to include
 * excluded rows among its `HISTORY_LIMIT` candidates can come back with
 * fewer than `HISTORY_LIMIT` entries — accepted rather than re-querying to
 * backfill (history pagination is deferred; see this endpoint's own
 * still-modest data volume).
 */
const AUTO_REENABLE_ACTION = 'scalingplan.emergency_override.auto_reenable';

function isExcludedFromHistory(entity: AuditEntity): boolean {
  return entity.action === AUTO_REENABLE_ACTION && entity.outcome === 'failure';
}

/** Best-effort parse of the stored parametersJson — a malformed/oversized value degrades to `undefined` rather than failing the whole history read. */
function parseParameters(parametersJson: string | undefined): Record<string, unknown> | undefined {
  if (!parametersJson) return undefined;
  try {
    const parsed: unknown = JSON.parse(parametersJson);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** Deliberately omits AuditEntity's `detail` (raw ARM/internal error text) — see ScalingHistoryEntry's doc comment in @avdmgr/shared (peer review — AM-23 MINOR 11). */
function mapEntry(entity: AuditEntity): ScalingHistoryEntry {
  return {
    id: entity.correlationId,
    occurredAt: entity.occurredAt,
    actor: entity.actor,
    action: entity.action,
    target: entity.target,
    outcome: entity.outcome,
    reason: entity.reason,
    parameters: parseParameters(entity.parametersJson),
  };
}

/**
 * GET /v1/scalingplans/current/history — AM-23 (M3-S1). Returns the last 10
 * scaling-plan-related audit rows (schedule edits/creates/deletes, emergency
 * override activate/cancel/auto-re-enable), newest first — see
 * auditLog.ts#queryRecentAuditEntries for the query/ordering mechanics.
 * viewer+ (read-only, same floor as GET .../current itself).
 */
export async function scalingHistory(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const authResult = requireRole(request, ['viewer', 'operator', 'admin'], context);
  if (!authResult.ok) return authResult.response;

  const logger: AuditLogger = { warn: (m) => context.warn(m), error: (m) => context.error(m), log: (m) => context.log(m) };

  try {
    const entities = await queryRecentAuditEntries(ACTION_PREFIX, HISTORY_LIMIT, logger);
    const responseBody: ScalingHistoryResponse = { entries: entities.filter((entity) => !isExcludedFromHistory(entity)).map(mapEntry) };
    return { status: 200, jsonBody: responseBody };
  } catch (error) {
    const correlationId = randomUUID();
    context.error(`scaling history lookup failed | correlationId=${correlationId}`, error);
    const apiError: ApiError = { status: 502, code: 'scaling_history_failed', message: `Failed to retrieve scaling plan history. Reference: ${correlationId}`, details: { correlationId } };
    return { status: 502, jsonBody: apiError };
  }
}

app.http('scalingHistory', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'v1/scalingplans/current/history',
  handler: scalingHistory,
});
