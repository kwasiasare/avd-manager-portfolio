import { randomUUID } from 'node:crypto';
import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import type { ApiError, SendSessionMessageRequest, SendSessionMessageResponse } from '@avdmgr/shared';
import { requireMinimumRole } from '../lib/auth';
import { isAuditRequiredButMissing, writeAuditEntry, type AuditLogger } from '../lib/auditLog';
import { getConfig } from '../lib/config';
import { validateManagedHostPool } from '../lib/hostPoolScope';
import { badRequest, SESSION_HOST_NAME_PATTERN, SESSION_ID_PATTERN, validateMandatoryMessageBody, validateOptionalTitle } from '../lib/validation';
import { isNotFoundError, sendSessionMessage as sendSessionMessageArm } from '../services/avdService';

/** Audit action id for this route — see app/api/src/lib/auditLog.ts. */
const AUDIT_ACTION = 'session.sendMessage';

/**
 * Length of the message body preview stored in the audit row's parameters
 * (see the `parameters` construction below). DECISION (AM-20 scope item 2):
 * the audit row stores `bodyLength` plus a TRUNCATED preview, not the full
 * message body — the audit log's job is to prove *that* an operator sent a
 * message and roughly *what* it said (for accountability/troubleshooting),
 * not to be a durable copy of every message's full text. A long preview
 * would also work against auditLog.ts's Table-row-size reasoning (see
 * sessionHostDrain.ts's MAX_REASON_LENGTH comment) if bodies ever approach
 * the 1000-char server-side cap.
 */
const AUDIT_BODY_PREVIEW_LENGTH = 100;

/**
 * M2-S3 (AM-20): sends a message to a single user session. Structurally
 * mirrors sessionHostDrain.ts (AM-18/M2-S1) — same correlationId threading,
 * requireMinimumRole('operator') gate, isAuditRequiredButMissing fail-closed
 * check BEFORE the ARM call, and an audit row written on BOTH the success
 * and failure path. `body` is mandatory; `title` is optional (mirrors ARM's
 * own SendMessage shape — see avdService.ts#sendSessionMessage). Both are
 * validated+TRIMMED via lib/validation.ts before use — the trimmed value is
 * what's sent to ARM and what's audited, never the raw input.
 */
export async function sessionSendMessage(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
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
  const sessionHostName = request.params.sessionHostName;
  if (!sessionHostName) {
    return badRequest('missing_session_host_name', 'sessionHostName route parameter is required.');
  }
  if (!SESSION_HOST_NAME_PATTERN.test(sessionHostName)) {
    return badRequest(
      'invalid_session_host_name',
      'sessionHostName must be 1-260 characters, starting with a letter or digit, using only letters, digits, dots, hyphens, or underscores.',
    );
  }
  const sessionId = request.params.sessionId;
  if (!sessionId) {
    return badRequest('missing_session_id', 'sessionId route parameter is required.');
  }
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    return badRequest(
      'invalid_session_id',
      'sessionId must be 1-100 characters, starting with a letter or digit, using only letters, digits, dots, hyphens, or underscores.',
    );
  }

  const scopeError = validateManagedHostPool(hostPoolName, getConfig().hostPoolName);
  if (scopeError) {
    return scopeError;
  }

  let requestBody: SendSessionMessageRequest;
  try {
    requestBody = ((await request.json()) ?? {}) as SendSessionMessageRequest;
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
  // rationale. Checked after input validation but BEFORE the ARM call.
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

  const target = `${hostPoolName}/${sessionHostName}/${sessionId}`;
  const actor = principal.userDetails;
  const actorId = principal.userId;
  const parameters: Record<string, unknown> = {
    sessionId,
    title,
    bodyLength: body.length,
    bodyPreview: body.length > AUDIT_BODY_PREVIEW_LENGTH ? `${body.slice(0, AUDIT_BODY_PREVIEW_LENGTH)}…` : body,
  };

  try {
    await sendSessionMessageArm(hostPoolName, sessionHostName, sessionId, title, body);

    try {
      await writeAuditEntry({ actor, actorId, action: AUDIT_ACTION, target, parameters, outcome: 'success', correlationId }, logger);
    } catch (auditError) {
      context.warn(`audit write threw unexpectedly (ignored — mutation already succeeded) | correlationId=${correlationId} target=${target} error=${String(auditError)}`);
    }

    const responseBody: SendSessionMessageResponse = { sessionId };
    return { status: 200, jsonBody: responseBody };
  } catch (error) {
    // Log only the message, never the raw error object — see
    // sessionForceLogoff.ts's identical comment (CWE-532).
    const errorMessage = error instanceof Error ? error.message : String(error);
    context.error(`session send message failed | target=${target} correlationId=${correlationId} error=${errorMessage}`);

    await writeAuditEntry(
      {
        actor,
        actorId,
        action: AUDIT_ACTION,
        target,
        parameters,
        outcome: 'failure',
        detail: errorMessage,
        correlationId,
      },
      logger,
    );

    if (isNotFoundError(error)) {
      const apiError: ApiError = {
        status: 404,
        code: 'session_not_found',
        message: `Session "${sessionId}" was not found on session host "${sessionHostName}". Reference: ${correlationId}`,
        details: { correlationId },
      };
      return { status: 404, jsonBody: apiError };
    }

    const apiError: ApiError = {
      status: 502,
      code: 'session_send_message_failed',
      message: `Failed to send the message in Azure. Reference: ${correlationId}`,
      details: { correlationId },
    };
    return { status: 502, jsonBody: apiError };
  }
}

app.http('sessionSendMessage', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'v1/hostpools/{hostPoolName}/sessionhosts/{sessionHostName}/sessions/{sessionId}/message',
  handler: sessionSendMessage,
});
