import { randomUUID } from 'node:crypto';
import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import type { ApiError, SnoozeAlertRequest } from '@avdmgr/shared';
import { requireMinimumRole } from '../lib/auth';
import { isAuditRequiredButMissing, writeAuditEntry, type AuditLogger } from '../lib/auditLog';
import { badRequest, MAX_REASON_LENGTH } from '../lib/validation';
import { buildAlertResourceId, isValidAlertGuid, resolveSnoozeUntil, snoozeAlert, unsnoozeAlert } from '../lib/alertState';
import { getConfig } from '../lib/config';

const SNOOZE_AUDIT_ACTION = 'alert.snooze';
const UNSNOOZE_AUDIT_ACTION = 'alert.unsnooze';

/**
 * POST /v1/alerts/{alertGuid}/snooze { untilIso | hours, reason? } —
 * operator+ (app-state mutation, audited — mirrors
 * app/api/src/functions/sessionHostPower.ts's structure; see alertAck.ts for
 * the matching ack endpoint, its doc comment for the bare-GUID route shape
 * rationale (peer review MAJOR 1), and app/api/src/lib/alertState.ts for
 * the shared validation/entity logic). Returns 204 No Content on success
 * (peer review item 10 — see alertAck.ts's doc comment for the full
 * reasoning).
 */
export async function alertSnooze(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
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

  let body: SnoozeAlertRequest;
  try {
    body = ((await request.json()) ?? {}) as SnoozeAlertRequest;
  } catch {
    return badRequest('invalid_body', 'Request body must be valid JSON.');
  }

  // Peer review item 7: this validation was previously MISSING here (it
  // exists on alertAck.ts, but snooze's reason went straight to
  // snoozeAlert unchecked) — an oversized reason risked breaking the 32K
  // Table string-property invariant the whole audit design depends on
  // (auditLog.ts's writeAuditEntry, and snoozeAlert's own AlertState row).
  if (body.reason !== undefined) {
    if (typeof body.reason !== 'string') {
      return badRequest('invalid_reason', 'reason, if provided, must be a string.');
    }
    if (body.reason.length > MAX_REASON_LENGTH) {
      return badRequest('reason_too_long', `reason must be ${MAX_REASON_LENGTH} characters or fewer.`);
    }
  }

  const snoozeResult = resolveSnoozeUntil(body);
  if (!snoozeResult.ok) {
    return { status: snoozeResult.error.status, jsonBody: snoozeResult.error };
  }

  // Fail-closed: see sessionHostDrain.ts/sessionHostPower.ts's identical
  // check for the full rationale. Checked after input validation, before
  // any state mutation.
  if (isAuditRequiredButMissing()) {
    context.error(`AUDIT_MISCONFIGURED | correlationId=${correlationId} action=${SNOOZE_AUDIT_ACTION} — AUDIT_STORAGE_ACCOUNT_NAME is unset in a deployed environment; refusing to mutate.`);
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
  const parameters: Record<string, unknown> = { untilIso: snoozeResult.untilIso };

  try {
    await snoozeAlert(alertGuid, actor, snoozeResult.untilIso, body.reason);

    try {
      await writeAuditEntry({ actor, actorId, action: SNOOZE_AUDIT_ACTION, target, parameters, reason: body.reason, outcome: 'success', correlationId }, logger);
    } catch (auditError) {
      context.warn(`audit write threw unexpectedly (ignored — the snooze already succeeded) | correlationId=${correlationId} target=${target} error=${String(auditError)}`);
    }

    return { status: 204 };
  } catch (error) {
    context.error(`alert snooze failed | alertGuid=${alertGuid} correlationId=${correlationId}`, error);

    try {
      await writeAuditEntry(
        { actor, actorId, action: SNOOZE_AUDIT_ACTION, target, parameters, reason: body.reason, outcome: 'failure', detail: error instanceof Error ? error.message : String(error), correlationId },
        logger,
      );
    } catch (auditError) {
      context.warn(`audit write threw unexpectedly (ignored — a failure response is returned regardless) | correlationId=${correlationId} target=${target} error=${String(auditError)}`);
    }

    const apiError: ApiError = {
      status: 502,
      code: 'alert_snooze_failed',
      message: `Failed to snooze alert. Reference: ${correlationId}`,
      details: { correlationId },
    };
    return { status: 502, jsonBody: apiError };
  }
}

/**
 * DELETE /v1/alerts/{alertGuid}/snooze — operator+ (app-state mutation,
 * audited). Peer review item 5: snoozing was previously permanent-until-
 * expiry with no way back (a disabled-forever "Snooze" button once
 * snoozedUntil was active) — this clears the snooze immediately while
 * preserving any current ack (see
 * app/api/src/lib/alertState.ts#unsnoozeAlert). Idempotent: 204 whether or
 * not the alert was snoozed to begin with.
 */
export async function alertUnsnooze(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
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
    context.error(`AUDIT_MISCONFIGURED | correlationId=${correlationId} action=${UNSNOOZE_AUDIT_ACTION} — AUDIT_STORAGE_ACCOUNT_NAME is unset in a deployed environment; refusing to mutate.`);
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
    await unsnoozeAlert(alertGuid);

    try {
      await writeAuditEntry({ actor, actorId, action: UNSNOOZE_AUDIT_ACTION, target, parameters: {}, outcome: 'success', correlationId }, logger);
    } catch (auditError) {
      context.warn(`audit write threw unexpectedly (ignored — the unsnooze already succeeded) | correlationId=${correlationId} target=${target} error=${String(auditError)}`);
    }

    return { status: 204 };
  } catch (error) {
    context.error(`alert unsnooze failed | alertGuid=${alertGuid} correlationId=${correlationId}`, error);

    try {
      await writeAuditEntry(
        { actor, actorId, action: UNSNOOZE_AUDIT_ACTION, target, parameters: {}, outcome: 'failure', detail: error instanceof Error ? error.message : String(error), correlationId },
        logger,
      );
    } catch (auditError) {
      context.warn(`audit write threw unexpectedly (ignored — a failure response is returned regardless) | correlationId=${correlationId} target=${target} error=${String(auditError)}`);
    }

    const apiError: ApiError = {
      status: 502,
      code: 'alert_unsnooze_failed',
      message: `Failed to un-snooze alert. Reference: ${correlationId}`,
      details: { correlationId },
    };
    return { status: 502, jsonBody: apiError };
  }
}

/**
 * Single app.http registration for both POST and DELETE on
 * v1/alerts/{alertGuid}/snooze — same dispatcher pattern (and same
 * underlying Node v4 same-route-registration reason) as alertAck.ts's
 * alertAckDispatch / hostPoolRegistrationToken.ts's
 * hostPoolRegistrationTokenDispatch.
 */
async function alertSnoozeDispatch(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  switch (request.method) {
    case 'POST':
      return alertSnooze(request, context);
    case 'DELETE':
      return alertUnsnooze(request, context);
    default: {
      const apiError: ApiError = { status: 405, code: 'method_not_allowed', message: `Method ${request.method} is not allowed on this route.` };
      return { status: 405, jsonBody: apiError };
    }
  }
}

app.http('alertSnooze', {
  methods: ['POST', 'DELETE'],
  authLevel: 'anonymous',
  route: 'v1/alerts/{alertGuid}/snooze',
  handler: alertSnoozeDispatch,
});
