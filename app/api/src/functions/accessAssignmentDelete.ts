import { randomUUID } from 'node:crypto';
import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import type { ApiError, RemoveAssignmentRequest } from '@avdmgr/shared';
import { requireMinimumRole } from '../lib/auth';
import { isAuditRequiredButMissing, writeAuditEntry, type AuditLogger } from '../lib/auditLog';
import { isArmForbidden } from '../lib/armRest';
import { badRequest, GUID_PATTERN, validateMandatoryReason } from '../lib/validation';
import { removeDesktopAssignment } from '../services/accessService';
import { getConfig } from '../lib/config';

const AUDIT_ACTION = 'access.assignment.remove';

/**
 * DELETE /v1/access/assignments/{roleAssignmentId} (AM-14, ADMIN-only,
 * audited): revokes a "Desktop Virtualization User" grant on the DAG.
 * `reason` is MANDATORY (request body — DELETE with a body mirrors this
 * app's existing convention for scaling-schedule delete/emergency-override
 * cancel, see api/avd.ts's deleteScalingSchedule/cancelEmergencyOverride).
 * The frontend requires a typed-name confirm before calling this (see
 * ConfirmModal usage in UsersAccess.tsx).
 *
 * AM-14 peer review (BLOCKER fix 1): accessService.ts#removeDesktopAssignment
 * does a pre-delete GET at the DAG's OWN scope before calling armDelete —
 * see that function's doc comment for the full reasoning. This means a
 * roleAssignmentId that doesn't exist, or that exists but is an INHERITED
 * assignment from a parent resource group/subscription scope (which
 * ARM's atScope() list filter surfaces — see accessService.ts's header
 * comment — but which this DAG-scoped GET cannot resolve), or that names
 * some OTHER role assigned directly on the DAG, is reported as
 * `{ outcome: 'not_found' }` and mapped to a 404 here — NEVER a false 204
 * success with a 'success'-outcome audit row for something this app never
 * actually removed (the bug this fix exists to close: armDelete/restDelete's
 * generic 404-as-success idempotency, correct for a caller that already
 * knows its target should exist at the scope it's deleting from, is WRONG
 * for this call site, which cannot assume that).
 */
export async function accessAssignmentDelete(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const correlationId = randomUUID();
  const logger: AuditLogger = {
    warn: (message) => context.warn(message),
    error: (message) => context.error(message),
    log: (message) => context.log(message),
  };

  const authResult = requireMinimumRole(request, 'admin', context);
  if (!authResult.ok) {
    return authResult.response;
  }
  const { principal } = authResult;

  const roleAssignmentId = request.params.roleAssignmentId;
  if (!roleAssignmentId || !GUID_PATTERN.test(roleAssignmentId)) {
    return badRequest('invalid_role_assignment_id', 'roleAssignmentId route parameter is required and must be a valid GUID.');
  }

  let body: RemoveAssignmentRequest;
  try {
    body = ((await request.json()) ?? {}) as RemoveAssignmentRequest;
  } catch {
    return badRequest('invalid_request_body', 'Request body must be valid JSON.');
  }

  const reasonResult = validateMandatoryReason(body.reason);
  if (!reasonResult.ok) {
    return reasonResult.response;
  }

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

  const { dagName } = getConfig();
  const target = `${dagName}/${roleAssignmentId}`;
  const actor = principal.userDetails;
  const actorId = principal.userId;

  try {
    const result = await removeDesktopAssignment(roleAssignmentId);

    if (result.outcome === 'not_found') {
      await writeAuditEntry(
        {
          actor,
          actorId,
          action: AUDIT_ACTION,
          target,
          parameters: { roleAssignmentId },
          reason: reasonResult.value,
          outcome: 'failure',
          detail:
            'No removable "Desktop Virtualization User" assignment was found directly on the DAG for this roleAssignmentId — already removed, an inherited grant from a parent scope, or a different role assigned directly on the DAG.',
          correlationId,
        },
        logger,
      );

      const apiError: ApiError = {
        status: 404,
        code: 'assignment_not_found',
        message: `No removable "Desktop Virtualization User" assignment "${roleAssignmentId}" was found directly on the DAG. It may already be removed, or it may be an INHERITED grant from a parent resource group/subscription scope, which must be removed at that scope instead. Reference: ${correlationId}`,
        details: { correlationId },
      };
      return { status: 404, jsonBody: apiError };
    }

    // AM-14 peer review (fix 5): the audit row records WHO lost access
    // (principalId always, displayName when Graph could resolve it), not
    // just the soon-meaningless roleAssignmentId — supplied by the
    // pre-delete GET inside removeDesktopAssignment.
    const parameters: Record<string, unknown> = { roleAssignmentId, principalId: result.principalId, principalType: result.principalType };
    if (result.displayName) {
      parameters.displayName = result.displayName;
    }

    try {
      await writeAuditEntry({ actor, actorId, action: AUDIT_ACTION, target, parameters, reason: reasonResult.value, outcome: 'success', correlationId }, logger);
    } catch (auditError) {
      context.warn(`audit write threw unexpectedly (ignored — mutation already succeeded) | correlationId=${correlationId} target=${target} error=${String(auditError)}`);
    }

    return { status: 204 };
  } catch (error) {
    context.error(`access assignment remove failed | target=${target} correlationId=${correlationId}`, error);

    await writeAuditEntry(
      {
        actor,
        actorId,
        action: AUDIT_ACTION,
        target,
        parameters: { roleAssignmentId },
        reason: reasonResult.value,
        outcome: 'failure',
        detail: error instanceof Error ? error.message : String(error),
        correlationId,
      },
      logger,
    );

    if (isArmForbidden(error)) {
      const apiError: ApiError = {
        status: 403,
        code: 'assignment_remove_forbidden',
        message: `Azure denied removing this role assignment. The managed identity's User Access Administrator grant on the DAG (see infra/modules/dagUserAccessAdministratorRole.bicep) may not have propagated yet, or may be missing. Reference: ${correlationId}`,
        details: { correlationId },
      };
      return { status: 403, jsonBody: apiError };
    }

    const apiError: ApiError = {
      status: 502,
      code: 'access_assignment_remove_failed',
      message: `Failed to remove the role assignment in Azure. Reference: ${correlationId}`,
      details: { correlationId },
    };
    return { status: 502, jsonBody: apiError };
  }
}

app.http('accessAssignmentDelete', {
  methods: ['DELETE'],
  authLevel: 'anonymous',
  route: 'v1/access/assignments/{roleAssignmentId}',
  handler: accessAssignmentDelete,
});
