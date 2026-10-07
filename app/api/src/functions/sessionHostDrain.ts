import { randomUUID } from 'node:crypto';
import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import type { ApiError, DrainSessionHostRequest, DrainSessionHostResponse } from '@avdmgr/shared';
import { requireMinimumRole } from '../lib/auth';
import { isAuditRequiredButMissing, writeAuditEntry, type AuditLogger } from '../lib/auditLog';
import { getConfig } from '../lib/config';
import { validateManagedHostPool } from '../lib/hostPoolScope';
// MAX_REASON_LENGTH/SESSION_HOST_NAME_PATTERN/badRequest moved to
// lib/validation.ts (AM-20 peer review — these were duplicated verbatim
// into validation.ts when M2-S3 was added; collapsed into one shared
// module rather than letting the two mutation "generations" drift). Values
// and behavior are unchanged — see validation.ts's doc comment.
import { badRequest, MAX_REASON_LENGTH, SESSION_HOST_NAME_PATTERN } from '../lib/validation';
import { isNotFoundError, setSessionHostDrain } from '../services/avdService';

/** Audit action id for this route — see app/api/src/lib/auditLog.ts. */
const AUDIT_ACTION = 'sessionhost.drain';

/**
 * M2-S1 (AM-18): the first mutating endpoint in the app. Toggles a session
 * host's allowNewSession flag ("drain mode" — see the SessionHost DTO
 * comment in @avdmgr/shared) via avdService.setSessionHostDrain.
 *
 * Guarded by requireMinimumRole('operator') — a viewer (or unauthenticated
 * caller) gets 403/401 before any ARM call is made. A correlationId is
 * generated once, up front, and threaded through the error response (on
 * failure), every context.log/error line, and both audit rows (success AND
 * failure) — so a support ticket referencing the correlationId can be
 * joined straight back to the audit record. Every attempt, whether it
 * succeeds or fails, writes one audit row (see app/api/src/lib/auditLog.ts)
 * capturing who did it (actor UPN + stable actorId), what host, what
 * changed (parameters), and the outcome — an audit write failure is logged
 * but never turns a successful drain toggle into an error response (see
 * writeAuditEntry's doc comment).
 */
export async function sessionHostDrain(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
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

  const scopeError = validateManagedHostPool(hostPoolName, getConfig().hostPoolName);
  if (scopeError) {
    return scopeError;
  }

  let body: DrainSessionHostRequest;
  try {
    body = ((await request.json()) ?? {}) as DrainSessionHostRequest;
  } catch {
    return badRequest('invalid_request_body', 'Request body must be valid JSON.');
  }

  if (typeof body.allowNewSession !== 'boolean') {
    return badRequest('invalid_allow_new_session', 'allowNewSession (boolean) is required in the request body.');
  }
  if (body.reason !== undefined) {
    if (typeof body.reason !== 'string') {
      return badRequest('invalid_reason', 'reason, if provided, must be a string.');
    }
    if (body.reason.length > MAX_REASON_LENGTH) {
      return badRequest('reason_too_long', `reason must be ${MAX_REASON_LENGTH} characters or fewer.`);
    }
  }

  // Fail-closed: a deployed environment (WEBSITE_SITE_NAME present) that
  // isn't even able to WRITE an audit row must not run mutations at all —
  // see auditLog.ts#isAuditRequiredButMissing's doc comment. Checked after
  // input validation (so a malformed request still gets its own specific
  // 400, not a misleading 500) but BEFORE the ARM call — nothing has
  // mutated yet at this point.
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

  const target = `${hostPoolName}/${sessionHostName}`;
  const actor = principal.userDetails;
  const actorId = principal.userId;
  const parameters = { allowNewSession: body.allowNewSession };

  try {
    const sessionHost = await setSessionHostDrain(hostPoolName, sessionHostName, body.allowNewSession);

    // Awaited (not fire-and-forget) so the audit row is written before this
    // handler returns. writeAuditEntry is documented to never throw (it
    // catches internally), but the success response is already guaranteed
    // here too — wrapped in its OWN try/catch so a hypothetical bug in
    // writeAuditEntry can never turn an already-successful mutation into an
    // error response for the caller. This is belt-and-braces on top of
    // writeAuditEntry's own contract, not a substitute for it.
    try {
      await writeAuditEntry({ actor, actorId, action: AUDIT_ACTION, target, parameters, reason: body.reason, outcome: 'success', correlationId }, logger);
    } catch (auditError) {
      context.warn(`audit write threw unexpectedly (ignored — mutation already succeeded) | correlationId=${correlationId} target=${target} error=${String(auditError)}`);
    }

    const responseBody: DrainSessionHostResponse = { sessionHost };
    return { status: 200, jsonBody: responseBody };
  } catch (error) {
    context.error(`sessionhost drain failed | target=${target} correlationId=${correlationId}`, error);

    await writeAuditEntry(
      {
        actor,
        actorId,
        action: AUDIT_ACTION,
        target,
        parameters,
        reason: body.reason,
        outcome: 'failure',
        detail: error instanceof Error ? error.message : String(error),
        correlationId,
      },
      logger,
    );

    if (isNotFoundError(error)) {
      const apiError: ApiError = {
        status: 404,
        code: 'session_host_not_found',
        message: `Session host "${sessionHostName}" was not found in host pool "${hostPoolName}". Reference: ${correlationId}`,
        details: { correlationId },
      };
      return { status: 404, jsonBody: apiError };
    }

    const apiError: ApiError = {
      status: 502,
      code: 'sessionhost_drain_failed',
      message: `Failed to update the session host in Azure. Reference: ${correlationId}`,
      details: { correlationId },
    };
    return { status: 502, jsonBody: apiError };
  }
}

app.http('sessionHostDrain', {
  methods: ['PATCH'],
  authLevel: 'anonymous',
  route: 'v1/hostpools/{hostPoolName}/sessionhosts/{sessionHostName}/drain',
  handler: sessionHostDrain,
});
