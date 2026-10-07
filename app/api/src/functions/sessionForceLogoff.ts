import { randomUUID } from 'node:crypto';
import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import type { ApiError, ForceLogoffSessionRequest, ForceLogoffSessionResponse } from '@avdmgr/shared';
import { requireMinimumRole } from '../lib/auth';
import { isAuditRequiredButMissing, writeAuditEntry, type AuditLogger } from '../lib/auditLog';
import { getConfig } from '../lib/config';
import { validateManagedHostPool } from '../lib/hostPoolScope';
import { badRequest, SESSION_HOST_NAME_PATTERN, SESSION_ID_PATTERN, validateMandatoryReason } from '../lib/validation';
import { forceLogoffSession as forceLogoffSessionArm, isNotFoundError } from '../services/avdService';

/** Audit action id for this route — see app/api/src/lib/auditLog.ts. */
const AUDIT_ACTION = 'session.forceLogoff';

/**
 * M2-S3 (AM-20): forces a single user session to log off. Structurally
 * mirrors sessionHostDrain.ts (AM-18/M2-S1) — same correlationId threading,
 * requireMinimumRole('operator') gate, isAuditRequiredButMissing fail-closed
 * check BEFORE the ARM call, and an audit row written on BOTH the success
 * and failure path — with one deliberate difference: `reason` is MANDATORY
 * here (validateMandatoryReason), not optional, because forcing a user off
 * is more disruptive than a drain toggle and must always be justified.
 */
export async function sessionForceLogoff(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
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

  let body: ForceLogoffSessionRequest;
  try {
    body = ((await request.json()) ?? {}) as ForceLogoffSessionRequest;
  } catch {
    return badRequest('invalid_request_body', 'Request body must be valid JSON.');
  }

  const reasonResult = validateMandatoryReason(body.reason);
  if (!reasonResult.ok) {
    return reasonResult.response;
  }
  const reason = reasonResult.value;

  if (body.userPrincipalName !== undefined && typeof body.userPrincipalName !== 'string') {
    return badRequest('invalid_user_principal_name', 'userPrincipalName, if provided, must be a string.');
  }
  const userPrincipalName = body.userPrincipalName?.trim() || undefined;

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
  const parameters: Record<string, unknown> = { sessionId };
  if (userPrincipalName) {
    parameters.userPrincipalName = userPrincipalName;
  }

  try {
    await forceLogoffSessionArm(hostPoolName, sessionHostName, sessionId);

    try {
      await writeAuditEntry({ actor, actorId, action: AUDIT_ACTION, target, parameters, reason, outcome: 'success', correlationId }, logger);
    } catch (auditError) {
      context.warn(`audit write threw unexpectedly (ignored — mutation already succeeded) | correlationId=${correlationId} target=${target} error=${String(auditError)}`);
    }

    const responseBody: ForceLogoffSessionResponse = { sessionId };
    return { status: 200, jsonBody: responseBody };
  } catch (error) {
    // Log only the message, never the raw error object — a RestError's
    // properties can include the full outbound request (method/URL/body),
    // which must not land in Application Insights verbatim (CWE-532).
    const errorMessage = error instanceof Error ? error.message : String(error);
    context.error(`session force logoff failed | target=${target} correlationId=${correlationId} error=${errorMessage}`);

    await writeAuditEntry(
      {
        actor,
        actorId,
        action: AUDIT_ACTION,
        target,
        parameters,
        reason,
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
      code: 'session_force_logoff_failed',
      message: `Failed to force the session to log off in Azure. Reference: ${correlationId}`,
      details: { correlationId },
    };
    return { status: 502, jsonBody: apiError };
  }
}

app.http('sessionForceLogoff', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'v1/hostpools/{hostPoolName}/sessionhosts/{sessionHostName}/sessions/{sessionId}/logoff',
  handler: sessionForceLogoff,
});
