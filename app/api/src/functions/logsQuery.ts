import { randomUUID, createHash } from 'node:crypto';
import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import type { ApiError, RawKqlRequest } from '@avdmgr/shared';
import { requireMinimumRole } from '../lib/auth';
import { isAuditRequiredButMissing, writeAuditEntry, type AuditLogger } from '../lib/auditLog';
import { MAX_REASON_LENGTH } from '../lib/validation';
import { validateKqlLength, validateTimespanHours } from '../lib/logsGuard';
import { runLogsQuery } from '../services/logsService';

/** Audit action id for this route — see app/api/src/lib/auditLog.ts. */
const AUDIT_ACTION = 'logs.query';

/** Truncates arbitrary text to MAX_REASON_LENGTH for an audit `detail` field, same "reason-like" bound sessionHostDrain.ts/sessionHostPower.ts apply to operator-supplied reasons — see this file's audit comment below for why the full KQL doesn't get an unbounded detail field even though Table's own string cap (32K) would technically allow it. */
function truncateForAudit(text: string): string {
  return text.length > MAX_REASON_LENGTH ? `${text.slice(0, MAX_REASON_LENGTH)}…(truncated)` : text;
}

/**
 * POST /v1/logs/query { kql, timespanHours } — the raw KQL escape hatch.
 * operator+ ONLY (not viewer) — see app/api/src/lib/logsGuard.ts's
 * top-of-file SECURITY POSTURE comment for the full reasoning: the
 * managed identity's Log Analytics access is read-only and scoped to the
 * LAW-CONTOSO-PROD workspace resource, but arbitrary KQL is still gated to a
 * trusted role, length/timespan-bounded, and server-side row-capped (see
 * logsService.ts#runLogsQuery -> logsGuard.ts#capRows). `kql` is passed to
 * LogsQueryClient as a distinct, structured argument — never
 * string-concatenated with the timespan or any other value this app
 * constructs.
 *
 * AUDIT (peer review MAJOR 2): every OTHER mutating/sensitive route in this
 * app writes an audit row (see app/api/src/lib/auditLog.ts) — raw KQL is
 * arguably the single most audit-worthy action available to an operator
 * here (arbitrary read access into LAW-CONTOSO-PROD, including tables/data
 * beyond the curated views — see logsGuard.ts's SECURITY POSTURE comment),
 * and it previously left NO record at all. This is a READ, not a mutation,
 * so it doesn't fit the "fail-closed before mutating" framing literally —
 * but the same posture applies: if this environment can't record who ran
 * what query, it shouldn't let an operator run one, so
 * isAuditRequiredButMissing() is checked before the query executes, not
 * just logged after the fact.
 *   - `target`: a SHA-256 hash PREFIX of the KQL text (not the KQL itself,
 *     and not a truncation of it — a hash so two different long queries
 *     that happen to share a truncated prefix don't collide in the audit
 *     row's target field, and so `target` stays a short, fixed-width,
 *     grep-friendly identifier rather than an unbounded one).
 *   - `parameters`: { timespanHours, kqlLength } — small structured facts
 *     about the query, not the query text itself.
 *   - `detail`: the FULL KQL text, truncated to MAX_REASON_LENGTH (the same
 *     "reason-like" bound every operator-supplied free-text field in this
 *     app is capped to) — this is where the actual query a reviewer would
 *     want to read lives.
 * RATE LIMITING: intentionally NOT implemented here. A Flex Consumption
 * Function App has no shared in-memory state across instances/cold starts,
 * so a "lightweight" limiter would need its own Table/queue round-trip on
 * every request — that's not lightweight, it's a second piece of
 * infrastructure to reason about (and get subtly wrong) for a control this
 * app doesn't strictly need: Azure Monitor's Log Analytics query API already
 * applies its own server-side throttling on excessive request rates (see
 * https://learn.microsoft.com/azure/azure-monitor/service-limits#la-query-api),
 * and this route is already gated to operator+ (a small, trusted
 * population), unlike a public/anonymous endpoint. Revisit if usage data
 * ever shows this route being hammered.
 */
export async function logsQuery(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const correlationId = randomUUID();
  const logger: AuditLogger = {
    warn: (message) => context.warn(message),
    error: (message) => context.error(message),
    log: (message) => context.log(message),
  };

  const authResult = requireMinimumRole(request, 'operator', context);
  if (!authResult.ok) {
    return authResult.response;
  }
  const { principal } = authResult;

  let body: Partial<RawKqlRequest>;
  try {
    body = ((await request.json()) ?? {}) as Partial<RawKqlRequest>;
  } catch {
    const apiError: ApiError = { status: 400, code: 'invalid_body', message: 'Request body must be valid JSON.' };
    return { status: 400, jsonBody: apiError };
  }

  const kqlResult = validateKqlLength(body.kql);
  if (!kqlResult.ok) {
    return { status: kqlResult.error.status, jsonBody: kqlResult.error };
  }

  const timespanResult = validateTimespanHours(body.timespanHours);
  if (!timespanResult.ok) {
    return { status: timespanResult.error.status, jsonBody: timespanResult.error };
  }

  const kql = body.kql as string;

  // Fail-closed: see sessionHostDrain.ts/sessionHostPower.ts's identical
  // check for the full rationale, applied here to a read (see this
  // handler's doc comment for why raw KQL still gets the same posture).
  if (isAuditRequiredButMissing()) {
    context.error(`AUDIT_MISCONFIGURED | correlationId=${correlationId} action=${AUDIT_ACTION} — AUDIT_STORAGE_ACCOUNT_NAME is unset in a deployed environment; refusing to query.`);
    const apiError: ApiError = {
      status: 500,
      code: 'audit_not_configured',
      message: `This environment cannot record an audit trail for this action, so it was not performed. Reference: ${correlationId}`,
      details: { correlationId },
    };
    return { status: 500, jsonBody: apiError };
  }

  const actor = principal.userDetails;
  const actorId = principal.userId;
  const kqlHash = createHash('sha256').update(kql).digest('hex').slice(0, 16);
  const target = `kql-sha256:${kqlHash}`;
  const parameters: Record<string, unknown> = { timespanHours: timespanResult.value, kqlLength: kql.length };

  try {
    const result = await runLogsQuery(kql, timespanResult.value);

    try {
      await writeAuditEntry({ actor, actorId, action: AUDIT_ACTION, target, parameters, outcome: 'success', detail: truncateForAudit(kql), correlationId }, logger);
    } catch (auditError) {
      context.warn(`audit write threw unexpectedly (ignored — the query already succeeded) | correlationId=${correlationId} target=${target} error=${String(auditError)}`);
    }

    return { status: 200, jsonBody: result };
  } catch (error) {
    context.error(`raw KQL query failed | principal=${actor} correlationId=${correlationId}`, error);

    try {
      await writeAuditEntry(
        {
          actor,
          actorId,
          action: AUDIT_ACTION,
          target,
          parameters,
          outcome: 'failure',
          detail: truncateForAudit(kql),
          correlationId,
        },
        logger,
      );
    } catch (auditError) {
      context.warn(`audit write threw unexpectedly (ignored — a failure response is returned regardless) | correlationId=${correlationId} target=${target} error=${String(auditError)}`);
    }

    const apiError: ApiError = {
      status: 502,
      code: 'logs_query_failed',
      message: `Failed to run the query against Log Analytics. Reference: ${correlationId}`,
      details: { correlationId },
    };
    return { status: 502, jsonBody: apiError };
  }
}

app.http('logsQuery', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'v1/logs/query',
  handler: logsQuery,
});
