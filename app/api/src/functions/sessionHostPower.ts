import { randomUUID } from 'node:crypto';
import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import type { ApiError, SessionHostPowerAction, SessionHostPowerRequest, SessionHostPowerResponse } from '@avdmgr/shared';
import { requireMinimumRole } from '../lib/auth';
import { isAuditRequiredButMissing, writeAuditEntry, type AuditLogger } from '../lib/auditLog';
import { getConfig } from '../lib/config';
import { validateManagedHostPool } from '../lib/hostPoolScope';
import { isConflictError, isForbiddenError, isNotFoundError, resolveSessionHostVm, VmResourceUnresolvableError } from '../services/avdService';
import { beginVmPowerAction } from '../services/computeService';

/** Audit action id for this route — see app/api/src/lib/auditLog.ts. One action id for all three power actions (start/restart/deallocate); parameters.action distinguishes them in the log, same pattern sessionHostDrain.ts uses for drain vs resume via parameters.allowNewSession. */
const AUDIT_ACTION = 'sessionhost.power';

/** Server-side bound on `reason` — same rationale/value as sessionHostDrain.ts's MAX_REASON_LENGTH. */
const MAX_REASON_LENGTH = 1000;

/**
 * ARM session host names — same pattern as sessionHostDrain.ts (duplicated
 * rather than imported, so this file's validation stays self-contained and
 * that already-tested reference file is left untouched). AM-19 peer review:
 * extracting this (and the small badRequest/name-validation block) into a
 * shared `lib/sessionHostValidation.ts` was considered and DEFERRED — two
 * call sites isn't yet enough duplication to justify the extra indirection;
 * revisit if a third mutating session-host route needs the same pattern.
 */
const SESSION_HOST_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,259}$/;

const POWER_ACTIONS: readonly SessionHostPowerAction[] = ['start', 'restart', 'deallocate'];

function isSessionHostPowerAction(value: unknown): value is SessionHostPowerAction {
  return typeof value === 'string' && (POWER_ACTIONS as readonly string[]).includes(value);
}

function badRequest(code: string, message: string): HttpResponseInit {
  const apiError: ApiError = { status: 400, code, message };
  return { status: 400, jsonBody: apiError };
}

/**
 * AM-19 (M2-S2): the second mutating endpoint, alongside sessionHostDrain.ts
 * (M2-S1) — this file mirrors that one's structure deliberately (same
 * correlationId/audit/fail-closed/404-mapping shape) so the two mutating
 * handlers stay easy to compare side by side.
 *
 * Starts, restarts, or deallocates a session host's underlying VM via
 * @azure/arm-compute (see services/computeService.ts#beginVmPowerAction).
 * Guarded by requireMinimumRole('operator') — same as drain. Unlike drain,
 * this endpoint does NOT block on active session count: draining first is
 * recommended (the frontend shows a warning + requires "proceed anyway" when
 * activeSessions > 0 for a restart/deallocate — see HostPool.tsx), but
 * whether to heed that is left to operator judgment, matching real AVD
 * operations (an admin restarting an unresponsive host with stuck sessions
 * is a legitimate, common case).
 *
 * AUDIT INTEGRITY (AM-19 peer review item 1): the request body MAY carry a
 * client-observed `activeSessions` (whatever the browser's session-host list
 * showed at click time), but that value is recorded under the explicitly
 * named `clientReportedActiveSessions` audit key — NOT under `activeSessions`
 * — because it is untrusted and can be stale or wrong (an operator could POST
 * activeSessions: 0 while deallocating a busy host). The audit row's
 * `activeSessions` key instead holds the SERVER-OBSERVED count, read fresh
 * from ARM by resolveSessionHostVm in the same request (avdService.ts) —
 * that is the value a reviewer auditing this row later should trust.
 *
 * TWO-PHASE ERROR MAPPING (AM-19 peer review item 2): resolving the session
 * host's VM (resolveSessionHostVm) and submitting the power action
 * (beginVmPowerAction) are two separate ARM calls, tracked in two separate
 * try/catch blocks below rather than one shared one — a 404 from EACH phase
 * means something different (resolve-phase 404 = the DesktopVirtualization
 * session host resource doesn't exist; submit-phase 404 = the Compute VM
 * resource doesn't exist, e.g. deleted out-of-band after resolving), and
 * conflating them into one "session host not found" message would be
 * factually wrong for the second case.
 *
 * Returns 202 Accepted, not 200: the ARM long-running operation is only
 * SUBMITTED here (poller.submitted()), never awaited to completion — see
 * computeService.beginVmPowerAction's doc comment for the full reasoning
 * (Flex Consumption timeout safety) and @avdmgr/shared's
 * SessionHostPowerResponse for the response contract this implies. The
 * audit row's outcome is 'accepted' (not 'success') for the same reason —
 * see auditLog.ts's AuditOutcome doc comment.
 */
export async function sessionHostPower(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
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

  let body: SessionHostPowerRequest;
  try {
    body = ((await request.json()) ?? {}) as SessionHostPowerRequest;
  } catch {
    return badRequest('invalid_request_body', 'Request body must be valid JSON.');
  }

  if (!isSessionHostPowerAction(body.action)) {
    return badRequest('invalid_action', `action is required and must be one of: ${POWER_ACTIONS.join(', ')}.`);
  }
  if (body.reason !== undefined) {
    if (typeof body.reason !== 'string') {
      return badRequest('invalid_reason', 'reason, if provided, must be a string.');
    }
    if (body.reason.length > MAX_REASON_LENGTH) {
      return badRequest('reason_too_long', `reason must be ${MAX_REASON_LENGTH} characters or fewer.`);
    }
  }
  if (body.activeSessions !== undefined) {
    if (typeof body.activeSessions !== 'number' || !Number.isInteger(body.activeSessions) || body.activeSessions < 0) {
      return badRequest('invalid_active_sessions', 'activeSessions, if provided, must be a non-negative integer.');
    }
  }

  // Fail-closed: see sessionHostDrain.ts's identical check for the full
  // rationale. Checked after input validation, before any ARM call.
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

  /**
   * Base parameters known before any ARM call — `action` always, plus the
   * client-supplied session count under its explicitly-untrusted key (item
   * 1 — see this function's doc comment). Resolve-phase failure audit rows
   * use exactly this; a successful resolve extends it with the
   * server-observed `activeSessions` and the resolved `resourceGroup`/
   * `vmName` (item 5) before either the submit-phase failure or the success
   * audit row is written.
   */
  const baseParameters: Record<string, unknown> = { action: body.action };
  if (body.activeSessions !== undefined) {
    baseParameters.clientReportedActiveSessions = body.activeSessions;
  }

  /**
   * Writes a failure audit row and never throws out of this handler even if
   * writeAuditEntry somehow does (it's documented not to — see
   * auditLog.ts — this is belt-and-braces on top of that contract, same
   * rationale as the success-path try/catch below; AM-19 peer review item
   * 11 asked for the two paths to be consistently wrapped).
   */
  async function auditFailure(parameters: Record<string, unknown>, error: unknown): Promise<void> {
    try {
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
    } catch (auditError) {
      context.warn(`audit write threw unexpectedly (ignored — a failure response is returned regardless) | correlationId=${correlationId} target=${target} error=${String(auditError)}`);
    }
  }

  // --- Phase 1: resolve the session host's underlying VM (+ its
  // server-observed session count) via avdService.resolveSessionHostVm. ---
  let vmTarget: Awaited<ReturnType<typeof resolveSessionHostVm>>;
  try {
    vmTarget = await resolveSessionHostVm(hostPoolName, sessionHostName);
  } catch (error) {
    context.error(`sessionhost power resolve failed | target=${target} action=${body.action} correlationId=${correlationId}`, error);
    await auditFailure(baseParameters, error);

    if (isNotFoundError(error)) {
      const apiError: ApiError = {
        status: 404,
        code: 'session_host_not_found',
        message: `Session host "${sessionHostName}" was not found in host pool "${hostPoolName}". Reference: ${correlationId}`,
        details: { correlationId },
      };
      return { status: 404, jsonBody: apiError };
    }

    if (error instanceof VmResourceUnresolvableError) {
      const apiError: ApiError = {
        status: 502,
        code: 'session_host_vm_unresolvable',
        message: `Session host "${sessionHostName}" has no resolvable VM resource to act on. Reference: ${correlationId}`,
        details: { correlationId },
      };
      return { status: 502, jsonBody: apiError };
    }

    const apiError: ApiError = {
      status: 502,
      code: 'session_host_resolve_failed',
      message: `Failed to resolve the underlying VM for session host "${sessionHostName}". Reference: ${correlationId}`,
      details: { correlationId },
    };
    return { status: 502, jsonBody: apiError };
  }

  // Now that resolution succeeded, extend the audit parameters with the
  // server-observed session count and the resolved VM location (items 1
  // and 5) — used by both the submit-phase failure row and the success row.
  const parameters: Record<string, unknown> = {
    ...baseParameters,
    activeSessions: vmTarget.activeSessions,
    resourceGroup: vmTarget.resourceGroup,
    vmName: vmTarget.vmName,
  };

  // --- Phase 2: submit the power action. A failure HERE means something
  // different from a Phase 1 failure — see this function's doc comment. ---
  try {
    await beginVmPowerAction(vmTarget.resourceGroup, vmTarget.vmName, body.action);
  } catch (error) {
    context.error(`sessionhost power submit failed | target=${target} action=${body.action} resourceGroup=${vmTarget.resourceGroup} vmName=${vmTarget.vmName} correlationId=${correlationId}`, error);
    await auditFailure(parameters, error);

    if (isNotFoundError(error)) {
      const apiError: ApiError = {
        status: 404,
        code: 'session_host_vm_not_found',
        message: `The underlying VM for session host "${sessionHostName}" was not found in Azure — it may have been deleted outside AVD Manager. Reference: ${correlationId}`,
        details: { correlationId },
      };
      return { status: 404, jsonBody: apiError };
    }

    if (isForbiddenError(error)) {
      const apiError: ApiError = {
        status: 403,
        code: 'vm_power_action_forbidden',
        message: `Azure denied the ${body.action} request for session host "${sessionHostName}"'s VM. The managed identity's role assignment (AVD Manager VM Power Operator) may not have propagated yet, or may be missing. Reference: ${correlationId}`,
        details: { correlationId },
      };
      return { status: 403, jsonBody: apiError };
    }

    if (isConflictError(error)) {
      const apiError: ApiError = {
        status: 409,
        code: 'vm_power_action_conflict',
        message: `VM is in a conflicting state — check its power state and retry. Reference: ${correlationId}`,
        details: { correlationId },
      };
      return { status: 409, jsonBody: apiError };
    }

    const apiError: ApiError = {
      status: 502,
      code: 'sessionhost_power_failed',
      message: `Failed to submit the ${body.action} request to Azure. Reference: ${correlationId}`,
      details: { correlationId },
    };
    return { status: 502, jsonBody: apiError };
  }

  // Awaited (not fire-and-forget) so the audit row is written before this
  // handler returns — same belt-and-braces reasoning as sessionHostDrain.ts.
  try {
    await writeAuditEntry({ actor, actorId, action: AUDIT_ACTION, target, parameters, reason: body.reason, outcome: 'accepted', correlationId }, logger);
  } catch (auditError) {
    context.warn(`audit write threw unexpectedly (ignored — ARM already accepted the request) | correlationId=${correlationId} target=${target} error=${String(auditError)}`);
  }

  context.log(
    `sessionhost power action accepted | target=${target} action=${body.action} resourceGroup=${vmTarget.resourceGroup} vmName=${vmTarget.vmName} correlationId=${correlationId}`,
  );

  const responseBody: SessionHostPowerResponse = { status: 'accepted', action: body.action, sessionHostName, correlationId };
  return { status: 202, jsonBody: responseBody };
}

app.http('sessionHostPower', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'v1/hostpools/{hostPoolName}/sessionhosts/{sessionHostName}/power',
  handler: sessionHostPower,
});
