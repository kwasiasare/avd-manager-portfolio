import { randomUUID } from 'node:crypto';
import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import type { ApiError, LogoffAllDisconnectedRequest, LogoffAllDisconnectedResponse } from '@avdmgr/shared';
import { requireMinimumRole } from '../lib/auth';
import { isAuditRequiredButMissing, writeAuditEntry, type AuditLogger } from '../lib/auditLog';
import { getConfig } from '../lib/config';
import { validateManagedHostPool } from '../lib/hostPoolScope';
import { badRequest, validateMandatoryReason } from '../lib/validation';
import { MAX_BATCH_TARGETS, runSessionBatch } from '../lib/sessionBatch';
import { forceLogoffSession, isNotFoundError, listUserSessions } from '../services/avdService';

/** Audit action id for this route — see app/api/src/lib/auditLog.ts. */
const AUDIT_ACTION = 'sessions.logoffAllDisconnected';

/** How many host-qualified session ids the batch audit row's `parameters.sessionIds` carries at most — see the `parameters` construction below for why this is capped rather than unbounded. */
const AUDIT_SESSION_ID_LIST_CAP = 50;

/**
 * M2-S3 (AM-20): logs off every DISCONNECTED session in the configured host
 * pool. This is a batch/composite endpoint (there is no single ARM
 * operation for it) — the server enumerates every user session via
 * avdService.listUserSessions and filters to sessionState === 'Disconnected'
 * BEFORE attempting anything. That filter is the acceptance-criterion
 * invariant this route exists to enforce (an AM-10 requirement) — it must
 * never touch an Active/Pending/LogOff/UserProfileDiskMounted session, no
 * matter what the caller's `reason` says. See sessionsLogoffDisconnected.test.ts
 * for the hard unit-test coverage of this invariant.
 *
 * SCOPE CAP: if the filtered target count exceeds MAX_BATCH_TARGETS (see
 * lib/sessionBatch.ts), this returns 400 rather than attempting the batch —
 * see the check below. This synchronous request/response design (act, then
 * respond with the full result) is only defensible up to a bounded target
 * count; beyond that, an async-job design (enqueue + poll/webhook) is the
 * right architecture (deferred — not implemented here).
 *
 * Per-session failures are aggregated (via lib/sessionBatch.ts's
 * runSessionBatch, which also bounds concurrency to avoid hammering ARM)
 * rather than aborting the whole batch — one stuck session must not block
 * logging off the rest. A session that's already gone by the time its
 * per-session action runs (ARM 404 — the COMMON case for a disconnected
 * session the user closes client-side) is classified as SKIPPED, not
 * failed — see runSessionBatch's classifyError. Exactly ONE audit row is
 * written for the whole batch, with `parameters` carrying the counts and a
 * capped, HOST-QUALIFIED list of targeted session ids (qualified because
 * ARM's own userSessionId is only unique WITHIN a session host, e.g. "1" on
 * two different hosts are different sessions).
 */
export async function sessionsLogoffDisconnected(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
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

  const hostPoolName = request.params.hostPoolName;
  if (!hostPoolName) {
    return badRequest('missing_host_pool_name', 'hostPoolName route parameter is required.');
  }

  const scopeError = validateManagedHostPool(hostPoolName, getConfig().hostPoolName);
  if (scopeError) {
    return scopeError;
  }

  let requestBody: LogoffAllDisconnectedRequest;
  try {
    requestBody = ((await request.json()) ?? {}) as LogoffAllDisconnectedRequest;
  } catch {
    return badRequest('invalid_request_body', 'Request body must be valid JSON.');
  }

  const reasonResult = validateMandatoryReason(requestBody.reason);
  if (!reasonResult.ok) {
    return reasonResult.response;
  }
  const reason = reasonResult.value;

  // Fail-closed: see sessionHostDrain.ts's identical check for the full
  // rationale. Checked after input validation but BEFORE any ARM call.
  if (isAuditRequiredButMissing()) {
    context.error(`AUDIT_MISCONFIGURED | correlationId=${correlationId} action=${AUDIT_ACTION} — AUDIT_STORAGE_ACCOUNT_NAME is unset in a deployed environment; refusing to mutate.`);
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

  try {
    const sessions = await listUserSessions(hostPoolName);
    // THE INVARIANT: only Disconnected sessions are ever targeted. Do not
    // loosen this without updating sessionsLogoffDisconnected.test.ts's
    // "filter invariant" coverage.
    const targets = sessions.filter((session) => session.sessionState === 'Disconnected');

    if (targets.length > MAX_BATCH_TARGETS) {
      const apiError: ApiError = {
        status: 400,
        code: 'too_many_sessions',
        message: `This host pool currently has ${targets.length} disconnected sessions, which exceeds the ${MAX_BATCH_TARGETS}-session limit for a single batch operation. Narrow the scope (e.g. log off specific sessions individually) and try again.`,
        details: { correlationId, count: targets.length, max: MAX_BATCH_TARGETS },
      };
      return { status: 400, jsonBody: apiError };
    }

    const result = await runSessionBatch(targets, (target) => forceLogoffSession(hostPoolName, target.sessionHostName, target.sessionId), {
      // A session that already vanished (404) between enumeration and this
      // call is the COMMON case for a disconnected session — the user may
      // have simply closed their client. Treat it as skipped/succeeded-in-
      // spirit, not a failure to scare the operator with.
      classifyError: (error) => (isNotFoundError(error) ? 'skip' : 'fail'),
      onFailure: (target, error) => {
        // Log only the message, never the raw error object (CWE-532) — see
        // sessionForceLogoff.ts's identical rationale.
        const message = error instanceof Error ? error.message : String(error);
        context.error(`session in batch failed | target=${hostPoolName}/${target.sessionHostName}/${target.sessionId} correlationId=${correlationId} action=${AUDIT_ACTION} error=${message}`);
      },
    });

    if (result.failed.length > 0) {
      context.warn(`SESSION_BATCH_PARTIAL_FAILURE | correlationId=${correlationId} action=${AUDIT_ACTION} attempted=${result.attempted} failed=${result.failed.length}`);
    }

    const qualifiedSessionIds = targets.map((target) => `${target.sessionHostName}/${target.sessionId}`);
    const parameters = {
      attempted: result.attempted,
      succeeded: result.succeeded,
      skipped: result.skipped,
      failedCount: result.failed.length,
      // Capped so a very large batch can't produce an oversized
      // parametersJson that silently fails the audit Table insert (Table's
      // 32K string-property cap — see auditLog.ts) — the total is still
      // recorded via sessionIdsTotal even when the list itself is truncated.
      sessionIds: qualifiedSessionIds.slice(0, AUDIT_SESSION_ID_LIST_CAP),
      sessionIdsTotal: qualifiedSessionIds.length,
      sessionIdsTruncated: qualifiedSessionIds.length > AUDIT_SESSION_ID_LIST_CAP,
    };
    // A batch with any per-session HARD failure is recorded as outcome
    // 'failure' even when some sessions succeeded — an operator scanning
    // the audit log for clean runs should see partial failures flagged, not
    // buried inside `parameters`. Skipped (404/already-gone) sessions do
    // NOT count toward this. The response body
    // (LogoffAllDisconnectedResponse) still returns 200 with the full
    // per-session breakdown either way — see the return below.
    const outcome = result.failed.length === 0 ? 'success' : 'failure';
    const detail = result.failed.length > 0 ? `${result.failed.length}/${result.attempted} session(s) failed to log off` : undefined;

    try {
      await writeAuditEntry({ actor, actorId, action: AUDIT_ACTION, target: hostPoolName, parameters, reason, outcome, detail, correlationId }, logger);
    } catch (auditError) {
      context.warn(`audit write threw unexpectedly (ignored — batch already completed) | correlationId=${correlationId} target=${hostPoolName} error=${String(auditError)}`);
    }

    const responseBody: LogoffAllDisconnectedResponse = { result, correlationId };
    return { status: 200, jsonBody: responseBody };
  } catch (error) {
    // Only reachable if listUserSessions itself throws (the batch never got
    // to enumerate sessions at all) — per-session ARM failures are caught
    // inside runSessionBatch and surfaced in result.failed instead.
    const errorMessage = error instanceof Error ? error.message : String(error);
    context.error(`sessions logoff-disconnected failed | hostPoolName=${hostPoolName} correlationId=${correlationId} error=${errorMessage}`);

    await writeAuditEntry(
      {
        actor,
        actorId,
        action: AUDIT_ACTION,
        target: hostPoolName,
        reason,
        outcome: 'failure',
        detail: errorMessage,
        correlationId,
      },
      logger,
    );

    const apiError: ApiError = {
      status: 502,
      code: 'sessions_logoff_disconnected_failed',
      message: `Failed to enumerate or log off disconnected sessions in Azure. Reference: ${correlationId}`,
      details: { correlationId },
    };
    return { status: 502, jsonBody: apiError };
  }
}

app.http('sessionsLogoffDisconnected', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'v1/hostpools/{hostPoolName}/sessions/logoff-disconnected',
  handler: sessionsLogoffDisconnected,
});
