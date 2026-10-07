import { randomUUID } from 'node:crypto';
import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import type { ApiError, AckAlertRequest } from '@avdmgr/shared';
import { requireMinimumRole } from '../lib/auth';
import { isAuditRequiredButMissing, writeAuditEntry, type AuditLogger } from '../lib/auditLog';
import { badRequest, MAX_REASON_LENGTH } from '../lib/validation';
import { ackAlert, buildAlertResourceId, isValidAlertGuid, unackAlert } from '../lib/alertState';
import { getConfig } from '../lib/config';

const ACK_AUDIT_ACTION = 'alert.ack';
const UNACK_AUDIT_ACTION = 'alert.unack';

/**
 * POST /v1/alerts/{alertGuid}/ack — operator+ (app-state mutation, audited —
 * mirrors app/api/src/functions/sessionHostPower.ts's structure:
 * correlationId up front, requireMinimumRole, fail-closed audit-availability
 * check before mutating, writeAuditEntry on both the success and failure
 * path).
 *
 * ROUTE SHAPE (peer review MAJOR 1): `alertGuid` is the BARE trailing GUID
 * of the Azure Monitor alert resource id, not the full ARM id
 * (`/subscriptions/.../providers/Microsoft.AlertsManagement/alerts/{guid}`).
 * An earlier version of this route carried the full, percent-encoded ARM id
 * as the path segment — Azure App Service/IIS normalizes and REJECTS
 * encoded slashes (%2F) in path segments before a request reaches the
 * Function App (documented platform behavior, verified against Microsoft
 * Q&A / IIS requestFiltering references — not something App Service lets
 * you opt out of), so that route would 404 in a real deployment despite
 * working against the local Functions host. The full ARM id is
 * reconstructed server-side from SUBSCRIPTION_ID + the bare GUID (see
 * buildAlertResourceId) for the audit `target` field, where a
 * fully-qualified id is worth the extra characters.
 *
 * Returns 204 No Content on success (peer review item 10) — not the raw
 * AlertStateEntity (an internal Table row shape, complete with
 * partitionKey/rowKey, that was never meant to be a wire DTO) and not a
 * reconstructed AlertSummary either (that would need a second ARM call to
 * re-fetch the alert this handler never needed to read in the first place,
 * just to hand back data the caller already has from its last GET
 * /v1/alerts). The frontend re-fetches the feed after a successful ack.
 */
export async function alertAck(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
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

  const alertGuid = request.params.alertGuid ?? '';
  if (!isValidAlertGuid(alertGuid)) {
    return badRequest('invalid_alert_id', 'alertGuid is not a recognized Azure Monitor alert GUID.');
  }
  const target = buildAlertResourceId(getConfig().subscriptionId, alertGuid);

  let body: AckAlertRequest = {};
  try {
    body = ((await request.json()) ?? {}) as AckAlertRequest;
  } catch {
    // Empty/no body is fine — ack takes no required fields.
  }
  if (body.reason !== undefined) {
    if (typeof body.reason !== 'string') {
      return badRequest('invalid_reason', 'reason, if provided, must be a string.');
    }
    if (body.reason.length > MAX_REASON_LENGTH) {
      return badRequest('reason_too_long', `reason must be ${MAX_REASON_LENGTH} characters or fewer.`);
    }
  }

  // Fail-closed: see sessionHostDrain.ts/sessionHostPower.ts's identical
  // check for the full rationale. Checked after input validation, before
  // any state mutation.
  if (isAuditRequiredButMissing()) {
    context.error(`AUDIT_MISCONFIGURED | correlationId=${correlationId} action=${ACK_AUDIT_ACTION} — AUDIT_STORAGE_ACCOUNT_NAME is unset in a deployed environment; refusing to mutate.`);
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
  const parameters: Record<string, unknown> = {};

  try {
    await ackAlert(alertGuid, actor, body.reason);

    try {
      await writeAuditEntry({ actor, actorId, action: ACK_AUDIT_ACTION, target, parameters, reason: body.reason, outcome: 'success', correlationId }, logger);
    } catch (auditError) {
      context.warn(`audit write threw unexpectedly (ignored — the ack already succeeded) | correlationId=${correlationId} target=${target} error=${String(auditError)}`);
    }

    return { status: 204 };
  } catch (error) {
    context.error(`alert ack failed | alertGuid=${alertGuid} correlationId=${correlationId}`, error);

    try {
      await writeAuditEntry(
        { actor, actorId, action: ACK_AUDIT_ACTION, target, parameters, reason: body.reason, outcome: 'failure', detail: error instanceof Error ? error.message : String(error), correlationId },
        logger,
      );
    } catch (auditError) {
      context.warn(`audit write threw unexpectedly (ignored — a failure response is returned regardless) | correlationId=${correlationId} target=${target} error=${String(auditError)}`);
    }

    const apiError: ApiError = {
      status: 502,
      code: 'alert_ack_failed',
      message: `Failed to acknowledge alert. Reference: ${correlationId}`,
      details: { correlationId },
    };
    return { status: 502, jsonBody: apiError };
  }
}

/**
 * DELETE /v1/alerts/{alertGuid}/ack — operator+ (app-state mutation,
 * audited). Peer review item 5: acking was previously permanent in the UI
 * (a disabled-forever "Ack" button once ackedBy was set, with no way back)
 * — this clears the ack while preserving any current snooze (see
 * app/api/src/lib/alertState.ts#unackAlert for why a Table Replace, not
 * Merge, is required to actually remove a property). Idempotent: 204
 * whether or not the alert was acked to begin with.
 */
export async function alertUnack(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
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

  const alertGuid = request.params.alertGuid ?? '';
  if (!isValidAlertGuid(alertGuid)) {
    return badRequest('invalid_alert_id', 'alertGuid is not a recognized Azure Monitor alert GUID.');
  }
  const target = buildAlertResourceId(getConfig().subscriptionId, alertGuid);

  if (isAuditRequiredButMissing()) {
    context.error(`AUDIT_MISCONFIGURED | correlationId=${correlationId} action=${UNACK_AUDIT_ACTION} — AUDIT_STORAGE_ACCOUNT_NAME is unset in a deployed environment; refusing to mutate.`);
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
    await unackAlert(alertGuid);

    try {
      await writeAuditEntry({ actor, actorId, action: UNACK_AUDIT_ACTION, target, parameters: {}, outcome: 'success', correlationId }, logger);
    } catch (auditError) {
      context.warn(`audit write threw unexpectedly (ignored — the unack already succeeded) | correlationId=${correlationId} target=${target} error=${String(auditError)}`);
    }

    return { status: 204 };
  } catch (error) {
    context.error(`alert unack failed | alertGuid=${alertGuid} correlationId=${correlationId}`, error);

    try {
      await writeAuditEntry(
        { actor, actorId, action: UNACK_AUDIT_ACTION, target, parameters: {}, outcome: 'failure', detail: error instanceof Error ? error.message : String(error), correlationId },
        logger,
      );
    } catch (auditError) {
      context.warn(`audit write threw unexpectedly (ignored — a failure response is returned regardless) | correlationId=${correlationId} target=${target} error=${String(auditError)}`);
    }

    const apiError: ApiError = {
      status: 502,
      code: 'alert_unack_failed',
      message: `Failed to un-acknowledge alert. Reference: ${correlationId}`,
      details: { correlationId },
    };
    return { status: 502, jsonBody: apiError };
  }
}

/**
 * Single app.http registration for both POST and DELETE on
 * v1/alerts/{alertGuid}/ack, dispatching on request.method — same pattern
 * (and same underlying reason) as
 * app/api/src/functions/hostPoolRegistrationToken.ts's
 * hostPoolRegistrationTokenDispatch: two separate `app.http(...)` calls on
 * an identical route can silently override one another in the Node v4
 * programming model (Azure/azure-functions-nodejs-library#98), so ack/unack
 * share one registration with an internal dispatcher instead.
 */
async function alertAckDispatch(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  switch (request.method) {
    case 'POST':
      return alertAck(request, context);
    case 'DELETE':
      return alertUnack(request, context);
    default: {
      const apiError: ApiError = { status: 405, code: 'method_not_allowed', message: `Method ${request.method} is not allowed on this route.` };
      return { status: 405, jsonBody: apiError };
    }
  }
}

app.http('alertAck', {
  methods: ['POST', 'DELETE'],
  authLevel: 'anonymous',
  route: 'v1/alerts/{alertGuid}/ack',
  handler: alertAckDispatch,
});
