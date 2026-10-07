import { randomUUID } from 'node:crypto';
import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import type { ApiError, BroadcastSessionMessageRequest, BroadcastSessionMessageResponse } from '@avdmgr/shared';
import { requireMinimumRole } from '../lib/auth';
import { isAuditRequiredButMissing, writeAuditEntry, type AuditLogger } from '../lib/auditLog';
import { getConfig } from '../lib/config';
import { validateManagedHostPool } from '../lib/hostPoolScope';
import { badRequest, validateMandatoryMessageBody, validateOptionalTitle } from '../lib/validation';
import { MAX_BATCH_TARGETS, runSessionBatch } from '../lib/sessionBatch';
import { isNotFoundError, listUserSessions, sendSessionMessage } from '../services/avdService';

/** Audit action id for this route — see app/api/src/lib/auditLog.ts. */
const AUDIT_ACTION = 'sessions.broadcast';

/** Same rationale as sessionSendMessage.ts's AUDIT_BODY_PREVIEW_LENGTH — the audit row stores a truncated preview + length, not the full body. */
const AUDIT_BODY_PREVIEW_LENGTH = 100;

/** Same rationale as sessionsLogoffDisconnected.ts's identical constant — caps the audit row's `parameters.sessionIds` list so it can't produce an oversized parametersJson. */
const AUDIT_SESSION_ID_LIST_CAP = 50;

/**
 * M2-S3 (AM-20): broadcasts a message to every ACTIVE session in the
 * configured host pool. Like sessionsLogoffDisconnected.ts, this is a
 * batch/composite endpoint with no single ARM operation — the server
 * enumerates every user session via avdService.listUserSessions and filters
 * to sessionState === 'Active' BEFORE sending anything. That filter is the
 * invariant this route exists to enforce: broadcasting must never message a
 * Disconnected/Pending/LogOff session (no one is at the keyboard to see
 * it) — see sessionsBroadcast.test.ts for the hard unit-test coverage.
 *
 * SCOPE CAP: same MAX_BATCH_TARGETS check and rationale as
 * sessionsLogoffDisconnected.ts — see that file's doc comment.
 *
 * Per-session failures are aggregated (via lib/sessionBatch.ts's
 * runSessionBatch, bounded-concurrency) rather than aborting the whole
 * broadcast. A session that's already gone (ARM 404) by the time its
 * per-session send runs is classified as SKIPPED, not failed. Exactly ONE
 * audit row is written for the whole batch.
 */
export async function sessionsBroadcast(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
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

  let requestBody: BroadcastSessionMessageRequest;
  try {
    requestBody = ((await request.json()) ?? {}) as BroadcastSessionMessageRequest;
  } catch {
    return badRequest('invalid_request_body', 'Request body must be valid JSON.');
  }

  const titleResult = validateOptionalTitle(requestBody.title);
  if (!titleResult.ok) {
    return titleResult.response;
  }
  const bodyResult = validateMandatoryMessageBody(requestBody.body);
  if (!bodyResult.ok) {
    return bodyResult.response;
  }
  const title = titleResult.value;
  const body = bodyResult.value;

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
  const bodyPreview = body.length > AUDIT_BODY_PREVIEW_LENGTH ? `${body.slice(0, AUDIT_BODY_PREVIEW_LENGTH)}…` : body;

  try {
    const sessions = await listUserSessions(hostPoolName);
    // THE INVARIANT: only Active sessions are ever messaged. Do not loosen
    // this without updating sessionsBroadcast.test.ts's "filter invariant"
    // coverage.
    const targets = sessions.filter((session) => session.sessionState === 'Active');

    if (targets.length > MAX_BATCH_TARGETS) {
      const apiError: ApiError = {
        status: 400,
        code: 'too_many_sessions',
        message: `This host pool currently has ${targets.length} active sessions, which exceeds the ${MAX_BATCH_TARGETS}-session limit for a single batch operation. Narrow the scope and try again.`,
        details: { correlationId, count: targets.length, max: MAX_BATCH_TARGETS },
      };
      return { status: 400, jsonBody: apiError };
    }

    const result = await runSessionBatch(targets, (target) => sendSessionMessage(hostPoolName, target.sessionHostName, target.sessionId, title, body), {
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
      sessionIds: qualifiedSessionIds.slice(0, AUDIT_SESSION_ID_LIST_CAP),
      sessionIdsTotal: qualifiedSessionIds.length,
      sessionIdsTruncated: qualifiedSessionIds.length > AUDIT_SESSION_ID_LIST_CAP,
      title,
      bodyLength: body.length,
      bodyPreview,
    };
    const outcome = result.failed.length === 0 ? 'success' : 'failure';
    const detail = result.failed.length > 0 ? `${result.failed.length}/${result.attempted} session(s) failed to receive the message` : undefined;

    try {
      await writeAuditEntry({ actor, actorId, action: AUDIT_ACTION, target: hostPoolName, parameters, outcome, detail, correlationId }, logger);
    } catch (auditError) {
      context.warn(`audit write threw unexpectedly (ignored — batch already completed) | correlationId=${correlationId} target=${hostPoolName} error=${String(auditError)}`);
    }

    const responseBody: BroadcastSessionMessageResponse = { result, correlationId };
    return { status: 200, jsonBody: responseBody };
  } catch (error) {
    // Only reachable if listUserSessions itself throws — per-session ARM
    // failures are caught inside runSessionBatch and surfaced in
    // result.failed instead.
    const errorMessage = error instanceof Error ? error.message : String(error);
    context.error(`sessions broadcast failed | hostPoolName=${hostPoolName} correlationId=${correlationId} error=${errorMessage}`);

    await writeAuditEntry(
      {
        actor,
        actorId,
        action: AUDIT_ACTION,
        target: hostPoolName,
        // Same message metadata as the success path (AM-20 peer review) —
        // an enumeration failure still means an operator ATTEMPTED to
        // broadcast this specific message; the audit trail should say what
        // it was, not just that something failed.
        parameters: { title, bodyLength: body.length, bodyPreview },
        outcome: 'failure',
        detail: errorMessage,
        correlationId,
      },
      logger,
    );

    const apiError: ApiError = {
      status: 502,
      code: 'sessions_broadcast_failed',
      message: `Failed to enumerate or message active sessions in Azure. Reference: ${correlationId}`,
      details: { correlationId },
    };
    return { status: 502, jsonBody: apiError };
  }
}

app.http('sessionsBroadcast', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'v1/hostpools/{hostPoolName}/sessions/broadcast',
  handler: sessionsBroadcast,
});
