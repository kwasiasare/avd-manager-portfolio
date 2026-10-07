import { randomUUID } from 'node:crypto';
import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import type { ApiError, EmergencyOverrideRequest, EmergencyOverrideStatus } from '@avdmgr/shared';
import { requireMinimumRole, requireRole } from '../lib/auth';
import { isAuditRequiredButMissing, writeAuditEntry, type AuditLogger } from '../lib/auditLog';
import { validateOverrideMinutes } from '../lib/scalingValidation';
import { badRequest, validateMandatoryReason } from '../lib/validation';
import { resolveCurrentScalingPlanRef, setScalingPlanHostPoolEnabled } from '../services/avdService';
import {
  computeOverrideStatus,
  createScalingOverride,
  getScalingOverride,
  isOverrideStoreRequiredButMissing,
  isPreconditionFailedError,
  isConflictError as isOverrideRowConflictError,
  replaceScalingOverride,
  type ScalingOverrideEntity,
  type ScalingOverrideRecord,
} from '../services/scalingOverrideService';

const ACTIVATE_AUDIT_ACTION = 'scalingplan.emergency_override.activate';
const EXTEND_AUDIT_ACTION = 'scalingplan.emergency_override.extend';
const CANCEL_AUDIT_ACTION = 'scalingplan.emergency_override.cancel';

/** Bounds the read-decide-write retry loop for a concurrently-contended activation (peer review — AM-23 MAJOR 2). 4 attempts is generous for the realistic contention this app sees (at most a handful of operators, one Table partition) without risking an unbounded retry storm. */
const MAX_ACTIVATION_ATTEMPTS = 4;
/** Bounds the cancel handler's own retry loop — contention here is lower (only a raced timer tick or a second concurrent cancel), so fewer attempts are needed. */
const MAX_CANCEL_ATTEMPTS = 3;

function makeLogger(context: InvocationContext): AuditLogger {
  return { warn: (m) => context.warn(m), error: (m) => context.error(m), log: (m) => context.log(m) };
}

function scalingPlanNotFound(correlationId: string): HttpResponseInit {
  const apiError: ApiError = { status: 404, code: 'scaling_plan_not_found', message: `No scaling plan is associated with the configured host pool. Reference: ${correlationId}`, details: { correlationId } };
  return { status: 404, jsonBody: apiError };
}

/**
 * GET /v1/scalingplans/current/emergency-override — status only. Any
 * authenticated role (viewer included) can see whether the override is
 * active, so the frontend's banner (RoleGate-free — everyone should see an
 * active override) can render for every signed-in user.
 */
export async function scalingEmergencyOverrideStatus(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const authResult = requireRole(request, ['viewer', 'operator', 'admin'], context);
  if (!authResult.ok) return authResult.response;

  try {
    const entity = await getScalingOverride();
    const responseBody: EmergencyOverrideStatus = computeOverrideStatus(entity);
    return { status: 200, jsonBody: responseBody };
  } catch (error) {
    const correlationId = randomUUID();
    context.error(`emergency override status lookup failed | correlationId=${correlationId}`, error);
    const apiError: ApiError = { status: 502, code: 'emergency_override_status_failed', message: `Failed to read emergency override status. Reference: ${correlationId}`, details: { correlationId } };
    return { status: 502, jsonBody: apiError };
  }
}

type PersistOutcome = 'persisted' | 'already_active';

/**
 * Read-decide-write retry loop for persisting an ACTIVE override row via
 * ETag optimistic concurrency (peer review — AM-23 MAJOR 2). `initialCurrent`
 * is the row already read once by the caller (avoids a redundant read on
 * the very first attempt); every RETRY re-reads fresh via getScalingOverride.
 *
 * Returns 'already_active' (WITHOUT writing anything) if, on any read
 * (initial or a retry), the row is active and `extend` is false — this is
 * the "someone else's activation just won" case: by the time this function
 * is called the caller has typically already disabled the plan in ARM,
 * which is a safe no-op regardless of who "wins" the row (the plan SHOULD
 * be disabled either way), so returning this outcome rather than looping
 * forever or throwing is correct — the caller maps it to a 409.
 *
 * Throws (propagates) on the FIRST non-conflict error, or once
 * MAX_ACTIVATION_ATTEMPTS conflicting writes have been exhausted — the
 * caller (scalingEmergencyOverrideActivate) is responsible for deciding
 * whether/how to roll back ARM in either case.
 */
async function persistActivationEntity(
  entity: Omit<ScalingOverrideEntity, 'partitionKey' | 'rowKey'>,
  initialCurrent: ScalingOverrideRecord | null,
  extend: boolean,
): Promise<PersistOutcome> {
  let current = initialCurrent;
  for (let attempt = 0; attempt < MAX_ACTIVATION_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      current = await getScalingOverride();
    }
    if (current?.active && !extend) {
      return 'already_active';
    }
    try {
      if (!current) {
        await createScalingOverride(entity);
      } else {
        await replaceScalingOverride(entity, current.etag);
      }
      return 'persisted';
    } catch (error) {
      if (isOverrideRowConflictError(error) || isPreconditionFailedError(error)) {
        continue; // someone else created/modified the row since we read it — re-read and re-evaluate.
      }
      throw error;
    }
  }
  throw new Error(`Gave up after ${MAX_ACTIVATION_ATTEMPTS} conflicting writes to the emergency override row.`);
}

/**
 * POST /v1/scalingplans/current/emergency-override — AM-23 (M3-S1).
 * Activates the "keep all hosts up" override: disables autoscale for the
 * configured host pool via ARM's scalingPlans.update
 * hostPoolReferences[].scalingPlanEnabled=false (see
 * avdService.setScalingPlanHostPoolEnabled's doc comment for the Microsoft
 * Learn source), then persists an expiry row (ScalingOverride table — see
 * scalingOverrideService.ts) so the timer-triggered
 * scalingOverrideReEnable function knows when to re-enable it.
 * requireMinimumRole('operator'). `reason` is MANDATORY (unlike routine
 * schedule edits) — see EmergencyOverrideRequest's doc comment.
 *
 * ALREADY-ACTIVE / EXTEND (peer review — AM-23 MAJOR 2): activating while an
 * override is already active is rejected (409 emergency_override_already_active)
 * UNLESS the request body sets `extend: true`, in which case ARM's disable
 * call is skipped (the plan is already disabled) and only the row's
 * expiresAt/minutes/reason are updated — audited as
 * 'scalingplan.emergency_override.extend', a distinct action from a fresh
 * activation. `activatedAt`/`activatedBy` on an extension reflect the
 * ORIGINAL episode's start time but the CURRENT caller (who most recently
 * touched it).
 *
 * CONCURRENCY: the actual read-decide-write is delegated to
 * persistActivationEntity above (ETag optimistic concurrency, retried on
 * conflict) so two racing activations can't silently lose one's expiry or
 * resurrect an already-cancelled override.
 *
 * ROLLBACK ON PARTIAL FAILURE: if ARM successfully disables the plan but
 * persisting the expiry row then fails for a reason OTHER than a retryable
 * conflict, this app has no durable record of when to re-enable it —
 * leaving the plan disabled forever would be a silent, unbounded cost
 * regression. This handler attempts a compensating re-enable in that
 * specific case; if the ROLLBACK ITSELF also fails, it returns a DISTINCT
 * error (emergency_override_stranded) stating plainly that autoscale is
 * currently disabled in Azure and was NOT restored — see the
 * SCALING_OVERRIDE_STRANDED log marker this emits, which a Log Analytics
 * alert rule should target (see infra/modules/functionapp.bicep's alerting
 * comment).
 */
export async function scalingEmergencyOverrideActivate(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const correlationId = randomUUID();
  const logger = makeLogger(context);

  const authResult = requireMinimumRole(request, 'operator', context);
  if (!authResult.ok) return authResult.response;
  const { principal } = authResult;

  let body: EmergencyOverrideRequest;
  try {
    body = ((await request.json()) ?? {}) as EmergencyOverrideRequest;
  } catch {
    return badRequest('invalid_request_body', 'Request body must be valid JSON.');
  }

  const minutes = validateOverrideMinutes(body.minutes);
  if (!minutes.ok) return minutes.response;
  const reason = validateMandatoryReason(body.reason);
  if (!reason.ok) return reason.response;
  const extend = body.extend === true;

  if (isAuditRequiredButMissing() || isOverrideStoreRequiredButMissing()) {
    context.error(`AUDIT_MISCONFIGURED | correlationId=${correlationId} action=${ACTIVATE_AUDIT_ACTION} — required storage is unset in a deployed environment; refusing to mutate.`);
    const apiError: ApiError = { status: 500, code: 'audit_not_configured', message: `This environment cannot record an audit trail / durable override state for this action, so it was not performed. Reference: ${correlationId}`, details: { correlationId } };
    return { status: 500, jsonBody: apiError };
  }

  const planRef = await resolveCurrentScalingPlanRef().catch((error) => {
    context.error(`resolveCurrentScalingPlanRef failed | correlationId=${correlationId}`, error);
    return undefined;
  });
  if (planRef === undefined) {
    const apiError: ApiError = { status: 502, code: 'scaling_plan_lookup_failed', message: `Failed to resolve the current scaling plan. Reference: ${correlationId}`, details: { correlationId } };
    return { status: 502, jsonBody: apiError };
  }
  if (planRef === null) {
    return scalingPlanNotFound(correlationId);
  }

  const target = planRef.scalingPlanName;
  const actor = principal.userDetails;
  const actorId = principal.userId;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + minutes.value * 60_000);

  let current: ScalingOverrideRecord | null;
  try {
    current = await getScalingOverride();
  } catch (error) {
    context.error(`emergency override activate — could not read current state | correlationId=${correlationId}`, error);
    const apiError: ApiError = { status: 502, code: 'emergency_override_status_failed', message: `Failed to read emergency override status. Reference: ${correlationId}`, details: { correlationId } };
    return { status: 502, jsonBody: apiError };
  }

  const alreadyActive = Boolean(current?.active);
  if (alreadyActive && !extend) {
    const apiError: ApiError = {
      status: 409,
      code: 'emergency_override_already_active',
      message: `An emergency override is already active (activated by ${current!.activatedBy}, expires ${current!.expiresAt}). POST with { extend: true } to extend it instead. Reference: ${correlationId}`,
      details: { correlationId },
    };
    return { status: 409, jsonBody: apiError };
  }
  const isExtend = alreadyActive && extend;
  const auditAction = isExtend ? EXTEND_AUDIT_ACTION : ACTIVATE_AUDIT_ACTION;

  // Skip the ARM call when extending — the plan is already disabled.
  if (!isExtend) {
    try {
      await setScalingPlanHostPoolEnabled(planRef.resourceGroup, planRef.scalingPlanName, planRef.hostPoolId, false);
    } catch (error) {
      context.error(`emergency override activate — ARM disable failed | target=${target} correlationId=${correlationId}`, error);
      await writeAuditEntry({ actor, actorId, action: auditAction, target, parameters: { minutes: minutes.value, extend: isExtend }, reason: reason.value, outcome: 'failure', detail: error instanceof Error ? error.message : String(error), correlationId }, logger);
      const apiError: ApiError = { status: 502, code: 'emergency_override_activate_failed', message: `Failed to disable autoscale in Azure. Reference: ${correlationId}`, details: { correlationId } };
      return { status: 502, jsonBody: apiError };
    }
  }

  const entity: Omit<ScalingOverrideEntity, 'partitionKey' | 'rowKey'> = {
    active: true,
    activatedBy: actor,
    activatedById: actorId,
    // Extension keeps the ORIGINAL episode's start time; a fresh/reactivated override starts a new one.
    activatedAt: isExtend && current ? current.activatedAt : now.toISOString(),
    expiresAt: expiresAt.toISOString(),
    minutes: minutes.value,
    reason: reason.value,
    scalingPlanName: planRef.scalingPlanName,
    resourceGroup: planRef.resourceGroup,
    hostPoolId: planRef.hostPoolId,
    correlationId,
    // A fresh activation/extension always clears any prior stuck-re-enable marker.
    reEnableFailureAudited: false,
  };

  let persistOutcome: PersistOutcome;
  try {
    persistOutcome = await persistActivationEntity(entity, current, extend);
  } catch (storeError) {
    // ARM already disabled the plan (unless this was an extend, which never
    // touched ARM) but we could not persist the row — see this function's
    // doc comment for the rollback/stranded-error reasoning.
    context.error(`emergency override activate — durable state write failed${isExtend ? '' : ' AFTER ARM disable'} | target=${target} correlationId=${correlationId}`, storeError);

    if (isExtend) {
      await writeAuditEntry({ actor, actorId, action: auditAction, target, parameters: { minutes: minutes.value, extend: true }, reason: reason.value, outcome: 'failure', detail: `durable state write failed: ${storeError instanceof Error ? storeError.message : String(storeError)}`, correlationId }, logger);
      const apiError: ApiError = { status: 502, code: 'emergency_override_state_write_failed', message: `Failed to persist the extended override's expiry. The override remains active with its PREVIOUS expiry. Reference: ${correlationId}`, details: { correlationId } };
      return { status: 502, jsonBody: apiError };
    }

    try {
      await setScalingPlanHostPoolEnabled(planRef.resourceGroup, planRef.scalingPlanName, planRef.hostPoolId, true);
      context.warn(`emergency override activate — rollback re-enable succeeded | target=${target} correlationId=${correlationId}`);
      await writeAuditEntry({ actor, actorId, action: auditAction, target, parameters: { minutes: minutes.value, extend: false }, reason: reason.value, outcome: 'failure', detail: `durable state write failed (rolled back): ${storeError instanceof Error ? storeError.message : String(storeError)}`, correlationId }, logger);
      const apiError: ApiError = { status: 502, code: 'emergency_override_state_write_failed', message: `Azure was updated but this app failed to persist the override's expiry — it has been rolled back where possible. Reference: ${correlationId}`, details: { correlationId } };
      return { status: 502, jsonBody: apiError };
    } catch (rollbackError) {
      // Peer review MAJOR 3: distinct, alertable marker + a response that
      // states PLAINLY that autoscale is disabled and was not restored —
      // never conflate this with the "rolled back successfully" 502 above.
      context.error(
        `SCALING_OVERRIDE_STRANDED | emergency override activate — ROLLBACK RE-ENABLE ALSO FAILED — autoscale is disabled in ARM with NO durable expiry record and was NOT restored. Manual intervention required (re-enable the scaling plan for this host pool). target=${target} correlationId=${correlationId}`,
        rollbackError,
      );
      await writeAuditEntry(
        {
          actor,
          actorId,
          action: auditAction,
          target,
          parameters: { minutes: minutes.value, extend: false },
          reason: reason.value,
          outcome: 'failure',
          detail: `STRANDED — durable state write failed AND rollback re-enable failed: ${storeError instanceof Error ? storeError.message : String(storeError)} | rollback error: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
          correlationId,
        },
        logger,
      );
      const apiError: ApiError = {
        status: 502,
        code: 'emergency_override_stranded',
        message: `Autoscale is now DISABLED in Azure for this host pool and could NOT be automatically restored. This app has no durable record of the override, so the auto-re-enable timer will not fix this either. Manually re-enable the scaling plan for this host pool in Azure. Reference: ${correlationId}`,
        details: { correlationId },
      };
      return { status: 502, jsonBody: apiError };
    }
  }

  if (persistOutcome === 'already_active') {
    // Lost a race to a concurrent activation. ARM is already disabled
    // (correct regardless of who "won"), so no rollback is needed — just
    // report the loss.
    const apiError: ApiError = {
      status: 409,
      code: 'emergency_override_already_active',
      message: `Another activation was submitted concurrently and took effect first. Refresh and use "extend" if you still need to change the duration/reason. Reference: ${correlationId}`,
      details: { correlationId },
    };
    return { status: 409, jsonBody: apiError };
  }

  try {
    await writeAuditEntry({ actor, actorId, action: auditAction, target, parameters: { minutes: minutes.value, expiresAt: expiresAt.toISOString(), extend: isExtend }, reason: reason.value, outcome: 'success', correlationId }, logger);
  } catch (auditError) {
    context.warn(`audit write threw unexpectedly (ignored — mutation already succeeded) | correlationId=${correlationId} target=${target} error=${String(auditError)}`);
  }

  const responseBody: EmergencyOverrideStatus = computeOverrideStatus(entity as ScalingOverrideEntity, now);
  return { status: 200, jsonBody: responseBody };
}

/**
 * DELETE /v1/scalingplans/current/emergency-override — cancels an active
 * override early: re-enables autoscale in ARM and marks the override row
 * inactive. requireMinimumRole('operator'). Returns 404 if no override is
 * currently active (nothing to cancel). `reason` is an OPTIONAL
 * justification (unlike activation's mandatory one — cancelling is the
 * "return to normal" direction, not a disruptive one).
 *
 * Uses the resourceGroup/scalingPlanName/hostPoolId STORED ON THE ROW at
 * activation time (not a fresh resolveCurrentScalingPlanRef call) — the
 * override being cancelled is, by definition, the one that row describes.
 */
export async function scalingEmergencyOverrideCancel(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const correlationId = randomUUID();
  const logger = makeLogger(context);

  const authResult = requireMinimumRole(request, 'operator', context);
  if (!authResult.ok) return authResult.response;
  const { principal } = authResult;

  let reason: string | undefined;
  try {
    const body = ((await request.json()) ?? {}) as { reason?: unknown };
    if (body.reason !== undefined) {
      if (typeof body.reason !== 'string') {
        return badRequest('invalid_reason', 'reason, if provided, must be a string.');
      }
      reason = body.reason;
    }
  } catch {
    reason = undefined;
  }

  if (isAuditRequiredButMissing() || isOverrideStoreRequiredButMissing()) {
    context.error(`AUDIT_MISCONFIGURED | correlationId=${correlationId} action=${CANCEL_AUDIT_ACTION} — required storage is unset in a deployed environment; refusing to mutate.`);
    const apiError: ApiError = { status: 500, code: 'audit_not_configured', message: `This environment cannot record an audit trail / durable override state for this action, so it was not performed. Reference: ${correlationId}`, details: { correlationId } };
    return { status: 500, jsonBody: apiError };
  }

  let current: ScalingOverrideRecord | null;
  try {
    current = await getScalingOverride();
  } catch (error) {
    context.error(`emergency override cancel — could not read current state | correlationId=${correlationId}`, error);
    const apiError: ApiError = { status: 502, code: 'emergency_override_status_failed', message: `Failed to read emergency override status. Reference: ${correlationId}`, details: { correlationId } };
    return { status: 502, jsonBody: apiError };
  }
  if (!current || !current.active) {
    const apiError: ApiError = { status: 404, code: 'emergency_override_not_active', message: `No emergency override is currently active. Reference: ${correlationId}`, details: { correlationId } };
    return { status: 404, jsonBody: apiError };
  }

  const target = current.scalingPlanName;
  const actor = principal.userDetails;
  const actorId = principal.userId;

  try {
    await setScalingPlanHostPoolEnabled(current.resourceGroup, current.scalingPlanName, current.hostPoolId, true);
  } catch (error) {
    context.error(`emergency override cancel — ARM re-enable failed | target=${target} correlationId=${correlationId}`, error);
    await writeAuditEntry({ actor, actorId, action: CANCEL_AUDIT_ACTION, target, parameters: { originalExpiresAt: current.expiresAt }, reason, outcome: 'failure', detail: error instanceof Error ? error.message : String(error), correlationId }, logger);
    const apiError: ApiError = { status: 502, code: 'emergency_override_cancel_failed', message: `Failed to re-enable autoscale in Azure. Reference: ${correlationId}`, details: { correlationId } };
    return { status: 502, jsonBody: apiError };
  }

  // Persist active:false with ETag concurrency, retrying on a raced
  // concurrent write (peer review — AM-23 MAJOR 2) — e.g. the auto-re-enable
  // timer firing at the same moment. If some OTHER writer already marked
  // the row inactive by the time we get to write, that satisfies our goal
  // too (nothing further to do). A genuine non-conflict write failure is
  // logged but NOT retried/rolled back — ARM is already correctly
  // re-enabled, which is the safe direction (see this function's doc
  // comment and scalingOverrideReEnable.ts's identical posture).
  let attemptCurrent: ScalingOverrideRecord | null = current;
  for (let attempt = 0; attempt < MAX_CANCEL_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      attemptCurrent = await getScalingOverride().catch(() => null);
    }
    if (!attemptCurrent || !attemptCurrent.active) {
      break; // already inactive — goal achieved by us or a concurrent writer.
    }
    try {
      await replaceScalingOverride({ ...attemptCurrent, active: false }, attemptCurrent.etag);
      break;
    } catch (storeError) {
      if (isPreconditionFailedError(storeError) && attempt < MAX_CANCEL_ATTEMPTS - 1) {
        continue;
      }
      context.error(`emergency override cancel — durable state write failed AFTER ARM re-enable (safe: timer will reconcile if still marked active) | target=${target} correlationId=${correlationId}`, storeError);
      break;
    }
  }

  try {
    await writeAuditEntry({ actor, actorId, action: CANCEL_AUDIT_ACTION, target, parameters: { originalExpiresAt: current.expiresAt, minutes: current.minutes }, reason, outcome: 'success', correlationId }, logger);
  } catch (auditError) {
    context.warn(`audit write threw unexpectedly (ignored — mutation already succeeded) | correlationId=${correlationId} target=${target} error=${String(auditError)}`);
  }

  const responseBody: EmergencyOverrideStatus = { active: false };
  return { status: 200, jsonBody: responseBody };
}

/** Single app.http registration dispatching GET/POST/DELETE — same same-route-multi-method workaround as hostPoolRegistrationToken.ts. */
export async function scalingEmergencyOverrideDispatch(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  switch (request.method) {
    case 'GET':
      return scalingEmergencyOverrideStatus(request, context);
    case 'POST':
      return scalingEmergencyOverrideActivate(request, context);
    case 'DELETE':
      return scalingEmergencyOverrideCancel(request, context);
    default: {
      const apiError: ApiError = { status: 405, code: 'method_not_allowed', message: `Method ${request.method} is not allowed on this route.` };
      return { status: 405, jsonBody: apiError };
    }
  }
}

app.http('scalingEmergencyOverride', {
  methods: ['GET', 'POST', 'DELETE'],
  authLevel: 'anonymous',
  route: 'v1/scalingplans/current/emergency-override',
  handler: scalingEmergencyOverrideDispatch,
});
