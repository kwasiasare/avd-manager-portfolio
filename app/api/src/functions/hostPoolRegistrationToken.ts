import { randomUUID } from 'node:crypto';
import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import type { ApiError, GenerateRegistrationTokenRequest, GenerateRegistrationTokenResponse, RegistrationTokenStatus } from '@avdmgr/shared';
import { requireMinimumRole, requireRole } from '../lib/auth';
import { isAuditRequiredButMissing, writeAuditEntry, type AuditLogger } from '../lib/auditLog';
import { getConfig } from '../lib/config';
import { badRequest } from '../lib/httpErrors';
import { validateManagedHostPool } from '../lib/hostPoolScope';
import { generateRegistrationToken, getRegistrationTokenStatus, isNotFoundError } from '../services/avdService';

/** Audit action id for the generate route — see app/api/src/lib/auditLog.ts. */
const AUDIT_ACTION = 'hostpool.registrationtoken.generate';

/**
 * Azure Virtual Desktop's own hard maximum for a registration token's
 * validity window is 27 days (648 hours) — confirmed on Microsoft Learn
 * ("Add session hosts to a host pool" / Generate a registration key: "up to
 * the maximum of 27 days"; the agent-troubleshooting doc's portal-generated
 * key note: "no less than an hour and no longer than 27 days from its
 * generation time"). This is narrower than a naive "30 days" (720h)
 * assumption — Azure itself rejects a longer request — so this app enforces
 * the REAL bound up front rather than letting a bad request round-trip to
 * ARM to find out.
 */
const MIN_REGISTRATION_HOURS = 1;
const MAX_REGISTRATION_HOURS = 648;

/** Never let a browser/proxy cache a response that may carry a live token value — applied to the generate route's 200. */
const NO_STORE_HEADERS = { 'Cache-Control': 'no-store', Pragma: 'no-cache' };

/**
 * POST /api/v1/hostpools/{hostPoolName}/registration-token — AM-22 (M2-S5).
 * Generates/rotates the host pool's session-host registration token via
 * avdService.generateRegistrationToken (ARM's hostPools.update with
 * registrationInfo.registrationTokenOperation: 'Update' — see that
 * function's doc comment for the Microsoft Learn sources).
 *
 * ADMIN-ONLY (requireMinimumRole('admin')), stricter than the drain
 * toggle's operator floor (AM-18): the returned token is a standing bearer
 * credential that lets its holder register an arbitrary new session host
 * into the pool until it expires (see
 * The session-host runbook §3's warning) — a materially bigger
 * blast radius than toggling one existing host's drain flag, so this app
 * reserves it for admins.
 *
 * AUDIT: the generation IS recorded (parameters: { hoursValid,
 * expirationTime } — see AuditEvent in app/api/src/lib/auditLog.ts), but
 * the TOKEN VALUE ITSELF IS NEVER PASSED TO writeAuditEntry, NEVER LOGGED,
 * and NEVER PERSISTED anywhere by this app (see the `parameters` object
 * built below, and generateRegistrationToken's own doc comment for the same
 * rule on the ARM-call side). The response body is the only place the
 * token value ever appears; from there it is the calling admin's own
 * clipboard/browser session, the same "shown once" contract as the AVD
 * Portal's own Registration key blade (the session-host runbook
 * §3's Portal path).
 */
export async function hostPoolRegistrationTokenGenerate(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
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

  const hostPoolName = request.params.hostPoolName;
  if (!hostPoolName) {
    return badRequest('missing_host_pool_name', 'hostPoolName route parameter is required.');
  }

  const scopeError = validateManagedHostPool(hostPoolName, getConfig().hostPoolName);
  if (scopeError) {
    return scopeError;
  }

  let body: GenerateRegistrationTokenRequest;
  try {
    body = ((await request.json()) ?? {}) as GenerateRegistrationTokenRequest;
  } catch {
    return badRequest('invalid_request_body', 'Request body must be valid JSON.');
  }

  if (
    typeof body.hoursValid !== 'number' ||
    !Number.isInteger(body.hoursValid) ||
    body.hoursValid < MIN_REGISTRATION_HOURS ||
    body.hoursValid > MAX_REGISTRATION_HOURS
  ) {
    return badRequest(
      'invalid_hours_valid',
      `hoursValid (integer) is required and must be between ${MIN_REGISTRATION_HOURS} and ${MAX_REGISTRATION_HOURS} (Azure Virtual Desktop's own 27-day maximum for a registration token).`,
    );
  }

  // Fail-closed: same posture/ordering as sessionHostDrain.ts — checked
  // after input validation (so a malformed request still gets its own
  // specific 400) but BEFORE the ARM call (nothing has mutated yet here).
  if (isAuditRequiredButMissing()) {
    context.error(
      `AUDIT_MISCONFIGURED | correlationId=${correlationId} action=${AUDIT_ACTION} — AUDIT_STORAGE_ACCOUNT_NAME is unset in a deployed environment; refusing to mutate.`,
    );
    const apiError: ApiError = {
      status: 500,
      code: 'audit_not_configured',
      message: `This environment cannot record an audit trail for this action, so it was not performed. Reference: ${correlationId}`,
      details: { correlationId },
    };
    return { status: 500, jsonBody: apiError };
  }

  const target = hostPoolName;
  const actor = principal.userDetails;
  const actorId = principal.userId;
  // NEVER include the token value here — see this handler's doc comment.
  const parameters: Record<string, unknown> = { hoursValid: body.hoursValid };

  try {
    const result = await generateRegistrationToken(hostPoolName, body.hoursValid);

    // Awaited (not fire-and-forget), wrapped in its own try/catch — same
    // belt-and-braces pattern as sessionHostDrain.ts's happy path.
    try {
      await writeAuditEntry(
        {
          actor,
          actorId,
          action: AUDIT_ACTION,
          target,
          parameters: { ...parameters, expirationTime: result.expirationTime },
          outcome: 'success',
          correlationId,
        },
        logger,
      );
    } catch (auditError) {
      context.warn(
        `audit write threw unexpectedly (ignored — mutation already succeeded) | correlationId=${correlationId} target=${target} error=${String(auditError)}`,
      );
    }

    const responseBody: GenerateRegistrationTokenResponse = result;
    // NO_STORE_HEADERS: this response body carries a live bearer token —
    // never let it sit in a browser back-forward cache, a shared/corporate
    // proxy, or any other intermediary cache (Opus review item 8).
    return { status: 200, jsonBody: responseBody, headers: NO_STORE_HEADERS };
  } catch (error) {
    context.error(`registration token generation failed | target=${target} correlationId=${correlationId}`, error);

    await writeAuditEntry(
      {
        actor,
        actorId,
        action: AUDIT_ACTION,
        target,
        parameters,
        outcome: 'failure',
        detail: error instanceof Error ? error.message : String(error),
        correlationId,
      },
      logger,
    );

    if (isNotFoundError(error)) {
      const apiError: ApiError = {
        status: 404,
        code: 'host_pool_not_found',
        message: `Host pool "${hostPoolName}" was not found. Reference: ${correlationId}`,
        details: { correlationId },
      };
      return { status: 404, jsonBody: apiError };
    }

    const apiError: ApiError = {
      status: 502,
      code: 'registration_token_generate_failed',
      message: `Failed to generate a registration token in Azure. Reference: ${correlationId}`,
      details: { correlationId },
    };
    return { status: 502, jsonBody: apiError };
  }
}

/**
 * GET /api/v1/hostpools/{hostPoolName}/registration-token — status only
 * (exists/expirationTime), NEVER the token value (see
 * avdService.getRegistrationTokenStatus's doc comment for how that's
 * enforced at the ARM-call boundary).
 *
 * RBAC DECISION: operator-minimum, NOT viewer. A registration token's mere
 * EXISTENCE and expiry window is itself sensitive operational posture — it
 * tells an observer whether a live "add a host" window is currently open on
 * this pool, a signal a viewer isn't otherwise given about any in-flight
 * administrative action in this app. This keeps the read side no more open
 * than the vmTemplate view (app/api/src/functions/hostPoolVmTemplate.ts,
 * gated the same way for a related reason), while still stopping short of
 * the generate endpoint's admin-only floor since this route never exposes
 * the token value itself.
 */
export async function hostPoolRegistrationTokenStatus(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const authResult = requireRole(request, ['operator', 'admin'], context);
  if (!authResult.ok) {
    return authResult.response;
  }

  const hostPoolName = request.params.hostPoolName;
  if (!hostPoolName) {
    return badRequest('missing_host_pool_name', 'hostPoolName route parameter is required.');
  }

  const scopeError = validateManagedHostPool(hostPoolName, getConfig().hostPoolName);
  if (scopeError) {
    return scopeError;
  }

  try {
    const status = await getRegistrationTokenStatus(hostPoolName);
    const responseBody: RegistrationTokenStatus = status;
    return { status: 200, jsonBody: responseBody };
  } catch (error) {
    const correlationId = randomUUID();
    context.error(`registration token status lookup failed | hostPoolName=${hostPoolName} correlationId=${correlationId}`, error);
    const apiError: ApiError = {
      status: 502,
      code: 'registration_token_status_failed',
      message: `Failed to retrieve registration token status from Azure. Reference: ${correlationId}`,
      details: { correlationId },
    };
    return { status: 502, jsonBody: apiError };
  }
}

/**
 * Single app.http registration for both GET and POST on
 * v1/hostpools/{hostPoolName}/registration-token, dispatching on
 * request.method to the two handlers above.
 *
 * WHY one registration instead of two: this was originally two separate
 * `app.http(...)` calls sharing the same route with different methods — the
 * first same-route registration pair in this codebase. The Node v4
 * programming model's function-registration layer has an open upstream
 * issue where two registrations on an identical route can silently
 * override one another (Azure/azure-functions-nodejs-library#98) rather
 * than both being dispatched correctly by the host. Unit tests that call
 * `hostPoolRegistrationTokenGenerate`/`hostPoolRegistrationTokenStatus`
 * directly (see hostPoolRegistrationToken.test.ts) exercise the handlers
 * but say nothing about how the real Azure Functions host resolves routing
 * between them — so the safe structure is a single registration whose
 * handler dispatches internally, which is unambiguous by construction.
 * Both original handlers are kept as-is (and as-tested) below; only the
 * app.http wiring changed.
 */
export async function hostPoolRegistrationTokenDispatch(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  switch (request.method) {
    case 'GET':
      return hostPoolRegistrationTokenStatus(request, context);
    case 'POST':
      return hostPoolRegistrationTokenGenerate(request, context);
    default: {
      // Defensive only — the `methods` array below already restricts what
      // the Functions host will route here at all. Kept so the dispatcher
      // itself has a well-defined, tested behavior for any method rather
      // than an implicit fallthrough.
      const apiError: ApiError = {
        status: 405,
        code: 'method_not_allowed',
        message: `Method ${request.method} is not allowed on this route.`,
      };
      return { status: 405, jsonBody: apiError };
    }
  }
}

app.http('hostPoolRegistrationToken', {
  methods: ['GET', 'POST'],
  authLevel: 'anonymous',
  route: 'v1/hostpools/{hostPoolName}/registration-token',
  handler: hostPoolRegistrationTokenDispatch,
});
