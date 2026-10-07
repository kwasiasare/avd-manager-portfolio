import { randomUUID } from 'node:crypto';
import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import type { ApiError, UpdateWorkspaceFriendlyNameRequest, WorkspaceFriendlyNameResponse } from '@avdmgr/shared';
import { requireMinimumRole } from '../lib/auth';
import { isAuditRequiredButMissing, writeAuditEntry, type AuditLogger } from '../lib/auditLog';
import { badRequest, validateFriendlyName, validateOptionalReason } from '../lib/validation';
import { getConfig } from '../lib/config';
import { getWorkspaceFriendlyName, updateWorkspaceFriendlyName } from '../services/avdService';

const AUDIT_ACTION = 'workspace.friendlyname.update';

/** GET /v1/workspace/friendly-name (AM-14, viewer+): reads the configured workspace's current friendly name. Never audited (a read). */
async function handleGet(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const authResult = requireMinimumRole(request, 'viewer', context);
  if (!authResult.ok) {
    return authResult.response;
  }

  const correlationId = randomUUID();
  try {
    const friendlyName = await getWorkspaceFriendlyName();
    const responseBody: WorkspaceFriendlyNameResponse = { friendlyName };
    return { status: 200, jsonBody: responseBody };
  } catch (error) {
    context.error(`workspace friendly name lookup failed | correlationId=${correlationId}`, error);
    const apiError: ApiError = {
      status: 502,
      code: 'workspace_friendly_name_lookup_failed',
      message: `Failed to read the workspace friendly name from Azure. Reference: ${correlationId}`,
      details: { correlationId },
    };
    return { status: 502, jsonBody: apiError };
  }
}

/**
 * PATCH /v1/workspace/friendly-name (AM-14, operator+, audited): updates
 * ONLY the workspace's friendlyName via ARM merge-patch (see
 * avdService.ts#updateWorkspaceFriendlyName). `reason` is OPTIONAL — a
 * cosmetic edit, lower blast radius than the assignment endpoints' mandatory
 * reason (same posture as DrainSessionHostRequest.reason).
 */
async function handlePatch(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
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

  let body: UpdateWorkspaceFriendlyNameRequest;
  try {
    body = ((await request.json()) ?? {}) as UpdateWorkspaceFriendlyNameRequest;
  } catch {
    return badRequest('invalid_request_body', 'Request body must be valid JSON.');
  }

  const friendlyNameResult = validateFriendlyName(body.friendlyName);
  if (!friendlyNameResult.ok) {
    return friendlyNameResult.response;
  }
  const reasonResult = validateOptionalReason(body.reason);
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

  const { workspaceName } = getConfig();
  const actor = principal.userDetails;
  const actorId = principal.userId;
  const parameters = { friendlyName: friendlyNameResult.value };

  try {
    const friendlyName = await updateWorkspaceFriendlyName(friendlyNameResult.value);

    try {
      await writeAuditEntry({ actor, actorId, action: AUDIT_ACTION, target: workspaceName, parameters, reason: reasonResult.value, outcome: 'success', correlationId }, logger);
    } catch (auditError) {
      context.warn(`audit write threw unexpectedly (ignored — mutation already succeeded) | correlationId=${correlationId} target=${workspaceName} error=${String(auditError)}`);
    }

    const responseBody: WorkspaceFriendlyNameResponse = { friendlyName };
    return { status: 200, jsonBody: responseBody };
  } catch (error) {
    context.error(`workspace friendly name update failed | target=${workspaceName} correlationId=${correlationId}`, error);

    await writeAuditEntry(
      {
        actor,
        actorId,
        action: AUDIT_ACTION,
        target: workspaceName,
        parameters,
        reason: reasonResult.value,
        outcome: 'failure',
        detail: error instanceof Error ? error.message : String(error),
        correlationId,
      },
      logger,
    );

    const apiError: ApiError = {
      status: 502,
      code: 'workspace_friendly_name_update_failed',
      message: `Failed to update the workspace friendly name in Azure. Reference: ${correlationId}`,
      details: { correlationId },
    };
    return { status: 502, jsonBody: apiError };
  }
}

/**
 * Single app.http registration for both GET and PATCH on
 * v1/workspace/friendly-name, dispatching on request.method — see
 * hostPoolRegistrationToken.ts's doc comment for why one registration (not
 * two) is required.
 */
export async function workspaceFriendlyNameDispatch(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  switch (request.method) {
    case 'GET':
      return handleGet(request, context);
    case 'PATCH':
      return handlePatch(request, context);
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

app.http('workspaceFriendlyName', {
  methods: ['GET', 'PATCH'],
  authLevel: 'anonymous',
  route: 'v1/workspace/friendly-name',
  handler: workspaceFriendlyNameDispatch,
});
