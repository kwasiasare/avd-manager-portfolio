import { randomUUID } from 'node:crypto';
import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import type { ApiError, AssignmentsListResponse, CreateAssignmentRequest, CreateAssignmentResponse } from '@avdmgr/shared';
import { requireMinimumRole } from '../lib/auth';
import { isAuditRequiredButMissing, writeAuditEntry, type AuditLogger } from '../lib/auditLog';
import { isArmConflict, isArmForbidden } from '../lib/armRest';
import { badRequest, validateMandatoryReason, validatePrincipalId, validatePrincipalType } from '../lib/validation';
import { createDesktopAssignment, listDesktopAssignments } from '../services/accessService';
import { getConfig } from '../lib/config';

const AUDIT_ACTION = 'access.assignment.create';

/**
 * GET /v1/access/assignments (AM-14, viewer+): lists every "Desktop
 * Virtualization User" role assignment on the DAG, with best-effort Graph
 * name resolution — see accessService.ts#listDesktopAssignments. Never
 * audited (a read, same posture as accessSearch.ts).
 */
async function handleList(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const authResult = requireMinimumRole(request, 'viewer', context);
  if (!authResult.ok) {
    return authResult.response;
  }

  const correlationId = randomUUID();
  try {
    const responseBody: AssignmentsListResponse = await listDesktopAssignments();
    return { status: 200, jsonBody: responseBody };
  } catch (error) {
    context.error(`access assignments list failed | correlationId=${correlationId}`, error);
    const apiError: ApiError = {
      status: 502,
      code: 'access_assignments_list_failed',
      message: `Failed to list role assignments from Azure. Reference: ${correlationId}`,
      details: { correlationId },
    };
    return { status: 502, jsonBody: apiError };
  }
}

/**
 * POST /v1/access/assignments (AM-14, ADMIN-only, audited): grants
 * "Desktop Virtualization User" on the DAG to `principalId`. `reason` is
 * MANDATORY — granting desktop access is a meaningful privilege change,
 * same posture as ForceLogoffSessionRequest.reason. Mirrors
 * sessionHostDrain.ts's single-mutation shape: correlationId generated up
 * front, fail-closed audit check before any ARM call, one audit row on
 * either outcome.
 */
async function handleCreate(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
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

  let body: CreateAssignmentRequest;
  try {
    body = ((await request.json()) ?? {}) as CreateAssignmentRequest;
  } catch {
    return badRequest('invalid_request_body', 'Request body must be valid JSON.');
  }

  const principalIdResult = validatePrincipalId(body.principalId);
  if (!principalIdResult.ok) {
    return principalIdResult.response;
  }
  const principalTypeResult = validatePrincipalType(body.principalType);
  if (!principalTypeResult.ok) {
    return principalTypeResult.response;
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
  const target = `${dagName}/${principalIdResult.value}`;
  const actor = principal.userDetails;
  const actorId = principal.userId;
  const parameters = { principalId: principalIdResult.value, principalType: principalTypeResult.value };

  try {
    const assignment = await createDesktopAssignment(principalIdResult.value, principalTypeResult.value);

    try {
      await writeAuditEntry({ actor, actorId, action: AUDIT_ACTION, target, parameters, reason: reasonResult.value, outcome: 'success', correlationId }, logger);
    } catch (auditError) {
      context.warn(`audit write threw unexpectedly (ignored — mutation already succeeded) | correlationId=${correlationId} target=${target} error=${String(auditError)}`);
    }

    context.log(`access assignment created | target=${target} roleAssignmentId=${assignment.roleAssignmentId} correlationId=${correlationId}`);

    const responseBody: CreateAssignmentResponse = { assignment };
    return { status: 201, jsonBody: responseBody };
  } catch (error) {
    context.error(`access assignment create failed | target=${target} correlationId=${correlationId}`, error);

    await writeAuditEntry(
      {
        actor,
        actorId,
        action: AUDIT_ACTION,
        target,
        parameters,
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
        code: 'assignment_create_forbidden',
        message: `Azure denied this role assignment. The managed identity's User Access Administrator grant on the DAG (see infra/modules/dagUserAccessAdministratorRole.bicep) may not have propagated yet, or may be missing. Reference: ${correlationId}`,
        details: { correlationId },
      };
      return { status: 403, jsonBody: apiError };
    }

    // AM-14 peer review (fix 8): ARM's RoleAssignmentExists 409 — this
    // principal already holds this exact role at this exact scope. A clear,
    // actionable message rather than a generic 502.
    if (isArmConflict(error)) {
      const apiError: ApiError = {
        status: 409,
        code: 'assignment_already_exists',
        message: `This principal already has desktop access. Reference: ${correlationId}`,
        details: { correlationId },
      };
      return { status: 409, jsonBody: apiError };
    }

    const apiError: ApiError = {
      status: 502,
      code: 'access_assignment_create_failed',
      message: `Failed to create the role assignment in Azure. Reference: ${correlationId}`,
      details: { correlationId },
    };
    return { status: 502, jsonBody: apiError };
  }
}

/**
 * Single app.http registration for both GET and POST on v1/access/assignments,
 * dispatching on request.method — see hostPoolRegistrationToken.ts's doc
 * comment for why one registration (not two) is required (Azure/azure-
 * functions-nodejs-library#98).
 */
export async function accessAssignmentsDispatch(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  switch (request.method) {
    case 'GET':
      return handleList(request, context);
    case 'POST':
      return handleCreate(request, context);
    default: {
      const apiError: ApiError = {
        status: 405,
        code: 'method_not_allowed',
        message: `Method ${request.method} is not allowed on this route.`,
      };
      return { status: 405, jsonBody: apiError };
    }
  }
}

app.http('accessAssignments', {
  methods: ['GET', 'POST'],
  authLevel: 'anonymous',
  route: 'v1/access/assignments',
  handler: accessAssignmentsDispatch,
});
