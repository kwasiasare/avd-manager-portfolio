import { randomUUID } from 'node:crypto';
import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import type { ApiError, AuditEntryDto, AuditRecentResponse } from '@avdmgr/shared';
import { requireMinimumRole } from '../lib/auth';
import { parseHoursParam } from '../lib/logsGuard';
import { isAuditRequiredButMissing, queryAuditEntries, sanitizeForLog, type AuditEntity, type AuditLogger } from '../lib/auditLog';

const DEFAULT_TOP = 25;
const MIN_TOP = 1;
const MAX_TOP = 100;

const DEFAULT_SINCE_HOURS = 24;
const MIN_SINCE_HOURS = 1;
/** 30 days — comfortably beyond queryAuditEntries' own 31-partition day-walk safety cap (see that function's doc comment). */
const MAX_SINCE_HOURS = 720;

/** Same defensive string-length bounds this app applies to every free-text query input (see validation.ts's MAX_REASON_LENGTH) — an oversized actor/actionPrefix is a clean 400, not an oddly-shaped OData filter sent to Table Storage. */
const MAX_ACTOR_LENGTH = 320;
const MAX_ACTION_PREFIX_LENGTH = 200;

function badRequest(code: string, message: string): HttpResponseInit {
  const apiError: ApiError = { status: 400, code, message };
  return { status: 400, jsonBody: apiError };
}

type IntParamResult = { ok: true; value: number } | { ok: false; response: HttpResponseInit };

/**
 * `top`'s own bounds ([1,100], default 25) don't match parseHoursParam's
 * ([1,168]/[1,720]-shaped, "hours"-worded) error messages, so this is a
 * small dedicated parser rather than a forced reuse — same integer-string
 * validation shape as parseHoursParam (app/api/src/lib/logsGuard.ts), just
 * with this endpoint's own field name/bounds baked into the error text.
 */
function parseTopParam(raw: string | null | undefined): IntParamResult {
  if (raw === null || raw === undefined || raw === '') {
    return { ok: true, value: DEFAULT_TOP };
  }
  if (!/^\d+$/.test(raw)) {
    return { ok: false, response: badRequest('invalid_top', `top must be an integer between ${MIN_TOP} and ${MAX_TOP}.`) };
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    return { ok: false, response: badRequest('invalid_top', `top must be an integer between ${MIN_TOP} and ${MAX_TOP}.`) };
  }
  if (parsed < MIN_TOP || parsed > MAX_TOP) {
    return { ok: false, response: badRequest('top_out_of_range', `top must be between ${MIN_TOP} and ${MAX_TOP}.`) };
  }
  return { ok: true, value: parsed };
}

type StringParamResult = { ok: true; value: string | undefined } | { ok: false; response: HttpResponseInit };

/** A blank (empty/whitespace-only) query value is treated as "not supplied", same as every optional field elsewhere in this app (see validation.ts's validateOptionalReason). */
function parseOptionalStringParam(raw: string | null | undefined, fieldName: string, maxLength: number): StringParamResult {
  if (raw === null || raw === undefined) {
    return { ok: true, value: undefined };
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { ok: true, value: undefined };
  }
  if (trimmed.length > maxLength) {
    return { ok: false, response: badRequest(`${fieldName}_too_long`, `${fieldName} must be ${maxLength} characters or fewer.`) };
  }
  return { ok: true, value: trimmed };
}

/**
 * Deliberately omits AuditEntity's `parametersJson` and `detail` — see
 * AuditEntryDto's doc comment (@avdmgr/shared) for why. `hasParameters` is
 * derived from whether `parametersJson` was set at write time (see
 * buildAuditEntity in auditLog.ts), not from parsing/re-serializing it.
 * `id` is `{partitionKey}/{rowKey}` — the Table's own composite primary
 * key, NOT `correlationId` (AM-32 peer review MAJOR 1: correlationId is
 * only unique per REQUEST, not per audit ROW — see AuditEntryDto's doc
 * comment in @avdmgr/shared for the rolloutPlanTimer.ts collision case that
 * made this a real bug, not a theoretical one).
 */
function mapEntry(entity: AuditEntity): AuditEntryDto {
  return {
    id: `${entity.partitionKey}/${entity.rowKey}`,
    occurredAt: entity.occurredAt,
    actor: entity.actor,
    action: entity.action,
    target: entity.target,
    reason: entity.reason,
    outcome: entity.outcome,
    correlationId: entity.correlationId,
    hasParameters: entity.parametersJson !== undefined,
  };
}

/**
 * GET /v1/audit/recent — AM-32 (M8-W3). The general "did someone already do
 * X" read this app's UI never had before this endpoint: every prior audit
 * read (queryRecentAuditEntries, GET /v1/scalingplans/current/history) is
 * scoped to one action family. operator+ ONLY (unlike that viewer+ endpoint)
 * — this can return rows for ANY action across the whole app, including
 * actor identities a viewer has no operational need to see (see auth.ts's
 * requireMinimumRole).
 *
 * Query params:
 *  - top: max rows, newest first. Default 25, bounded [1,100].
 *  - actor: exact match on AuditEntity.actor. Omitted = every actor.
 *  - actionPrefix: "starts with" match on AuditEntity.action (e.g.
 *    "sessionhost."). Omitted = every action.
 *  - sinceHours: how far back to look. Default 24, bounded [1,720] (30 days).
 *
 * See queryAuditEntries (auditLog.ts) for the RowKey-scheme query mechanics
 * and `truncated`/`partial`'s exact semantics — echoed here via
 * AuditRecentResponse.
 *
 * AM-32 peer review MAJOR 2 — an UNCONFIGURED audit store 503s here
 * (`audit_not_configured`) rather than 200ing an empty `entries: []`: this
 * endpoint exists specifically so an operator can trust "no entries" to
 * mean "nothing happened", not "we couldn't check". Mirrors the WRITE
 * path's own fail-closed posture (isAuditRequiredButMissing, checked by
 * every mutating handler before touching Azure) rather than
 * queryAuditEntries's read-side "skip silently" default, which exists for
 * callers (queryRecentAuditEntries's callers) that degrade a whole PAGE
 * rather than being the audit feed itself. Only fires when this Function
 * App is actually DEPLOYED (WEBSITE_SITE_NAME set) but misconfigured — see
 * isAuditRequiredButMissing's own doc comment; local dev with no storage
 * account configured is unaffected (Table simply isn't there yet, which is
 * a normal local-dev state, not an error).
 */
export async function auditRecent(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const authResult = requireMinimumRole(request, 'operator', context);
  if (!authResult.ok) return authResult.response;
  const { principal } = authResult;

  const topResult = parseTopParam(request.query.get('top'));
  if (!topResult.ok) return topResult.response;

  const sinceHoursResult = parseHoursParam(request.query.get('sinceHours'), DEFAULT_SINCE_HOURS, MIN_SINCE_HOURS, MAX_SINCE_HOURS, 'sinceHours');
  if (!sinceHoursResult.ok) return { status: sinceHoursResult.error.status, jsonBody: sinceHoursResult.error };

  const actorResult = parseOptionalStringParam(request.query.get('actor'), 'actor', MAX_ACTOR_LENGTH);
  if (!actorResult.ok) return actorResult.response;

  const actionPrefixResult = parseOptionalStringParam(request.query.get('actionPrefix'), 'actionPrefix', MAX_ACTION_PREFIX_LENGTH);
  if (!actionPrefixResult.ok) return actionPrefixResult.response;

  if (isAuditRequiredButMissing()) {
    context.error('audit recent lookup refused | AUDIT_STORAGE_ACCOUNT_NAME is not configured on a deployed instance');
    const apiError: ApiError = {
      status: 503,
      code: 'audit_not_configured',
      message: 'The audit read model is not configured in this environment. Recent actions cannot be shown.',
    };
    return { status: 503, jsonBody: apiError };
  }

  const logger: AuditLogger = { warn: (m) => context.warn(m), error: (m) => context.error(m), log: (m) => context.log(m) };

  // AM-32 peer review MINOR 18 — every read of the audit log is itself
  // worth an audit-adjacent trail: who looked, and with what filters. This
  // is a plain structured log line (Application Insights / Log Analytics),
  // not a second AuditLog Table row — reads aren't mutations, so they don't
  // go through writeAuditEntry. Peer review MINOR 19: actor/actionPrefix
  // are caller-supplied query-string values — sanitizeForLog strips CR/LF
  // so a crafted value can't forge additional-looking log lines.
  context.log(
    `AUDIT_READ | requestedBy=${principal.userDetails} top=${topResult.value} sinceHours=${sinceHoursResult.value} actor=${sanitizeForLog(actorResult.value)} actionPrefix=${sanitizeForLog(actionPrefixResult.value)}`,
  );

  try {
    const { entities, truncated, partial } = await queryAuditEntries(
      { top: topResult.value, sinceHours: sinceHoursResult.value, actor: actorResult.value, actionPrefix: actionPrefixResult.value },
      logger,
    );
    const responseBody: AuditRecentResponse = { entries: entities.map(mapEntry), truncated, partial, sinceHours: sinceHoursResult.value };
    return { status: 200, jsonBody: responseBody };
  } catch (error) {
    const correlationId = randomUUID();
    context.error(`audit recent lookup failed | correlationId=${correlationId}`, error);
    const apiError: ApiError = { status: 502, code: 'audit_recent_failed', message: `Failed to retrieve recent audit entries. Reference: ${correlationId}`, details: { correlationId } };
    return { status: 502, jsonBody: apiError };
  }
}

app.http('auditRecent', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'v1/audit/recent',
  handler: auditRecent,
});
