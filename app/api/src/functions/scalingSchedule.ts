import { randomUUID } from 'node:crypto';
import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import type { ApiError, ScalingScheduleDeleteResponse, ScalingSchedulePatchRequest, ScalingSchedulePatchResponse, ScalingScheduleDetail } from '@avdmgr/shared';
import { requireMinimumRole } from '../lib/auth';
import { isAuditRequiredButMissing, writeAuditEntry, type AuditLogger } from '../lib/auditLog';
import {
  computeUncoveredDays,
  SCHEDULE_NAME_PATTERN,
  uncoveredDaysError,
  validateDaysOfWeek,
  validateOptionalBoolean,
  validateOptionalCapacityThresholdPct,
  validateOptionalHostsPct,
  validateOptionalLoadBalancingAlgorithm,
  validateOptionalNotificationMessage,
  validateOptionalPeriod,
  validateOptionalReason,
  validateOptionalStopHostsWhen,
  validateOptionalWaitTimeMinutes,
  validatePhaseOrdering,
} from '../lib/scalingValidation';
import { badRequest } from '../lib/validation';
import {
  deleteScalingSchedule,
  getScalingSchedule,
  isBadRequestError,
  isConflictError,
  isForbiddenError,
  isNotFoundError,
  listScalingSchedules,
  resolveCurrentScalingPlanRef,
  updateScalingSchedule,
} from '../services/avdService';

/** Audit action ids — the "scalingplan." prefix is what scalingHistory.ts filters on (see app/api/src/lib/auditLog.ts#queryRecentAuditEntries). */
const UPDATE_AUDIT_ACTION = 'scalingplan.schedule.update';
const DELETE_AUDIT_ACTION = 'scalingplan.schedule.delete';

/** Fields a PATCH body may set — used both to build the ARM patch and to compute a bounded before/after diff for the audit row. */
const PATCHABLE_FIELDS = [
  'daysOfWeek',
  'rampUpStartTime',
  'rampUpLoadBalancingAlgorithm',
  'rampUpMinimumHostsPct',
  'rampUpCapacityThresholdPct',
  'peakStartTime',
  'peakLoadBalancingAlgorithm',
  'rampDownStartTime',
  'rampDownLoadBalancingAlgorithm',
  'rampDownMinimumHostsPct',
  'rampDownCapacityThresholdPct',
  'rampDownForceLogoffUsers',
  'rampDownStopHostsWhen',
  'rampDownWaitTimeMinutes',
  'rampDownNotificationMessage',
  'offPeakStartTime',
  'offPeakLoadBalancingAlgorithm',
] as const;

function makeLogger(context: InvocationContext): AuditLogger {
  return { warn: (m) => context.warn(m), error: (m) => context.error(m), log: (m) => context.log(m) };
}

function scheduleNotFound(scheduleName: string, correlationId: string): HttpResponseInit {
  const apiError: ApiError = {
    status: 404,
    code: 'scaling_schedule_not_found',
    message: `Schedule "${scheduleName}" was not found on the current scaling plan. Reference: ${correlationId}`,
    details: { correlationId },
  };
  return { status: 404, jsonBody: apiError };
}

function scalingPlanNotFound(correlationId: string): HttpResponseInit {
  const apiError: ApiError = {
    status: 404,
    code: 'scaling_plan_not_found',
    message: `No scaling plan is associated with the configured host pool. Reference: ${correlationId}`,
    details: { correlationId },
  };
  return { status: 404, jsonBody: apiError };
}

/**
 * Peer review (AM-23 item 12): the {scheduleName} route parameter is only
 * guaranteed by Azure Functions' own routing to be a non-empty URL segment
 * — it has never itself been checked against the same pattern ARM (and this
 * app's own schedule CREATE) actually requires a schedule name to satisfy.
 * Re-validated here so PATCH/DELETE reject an obviously-invalid name (e.g.
 * one containing a URL-encoded slash) with a clean 400 rather than letting
 * it round-trip to ARM to find out.
 */
function validateScheduleNameParam(scheduleName: string): HttpResponseInit | null {
  return SCHEDULE_NAME_PATTERN.test(scheduleName) ? null : badRequest('invalid_schedule_name', 'scheduleName must be 1-64 characters, using only letters, digits, spaces, and the characters @ . - _');
}

/** Merges patch onto `before` for the fields that matter to the day-coverage and phase-ordering guards — a lightweight "what would this schedule look like after the PATCH" projection, not a full apply. */
function resolvePatchedTimes(before: ScalingScheduleDetail, patch: ScalingSchedulePatchRequest) {
  return {
    rampUpStartTime: patch.rampUpStartTime ?? before.rampUpStartTime,
    peakStartTime: patch.peakStartTime ?? before.peakStartTime,
    rampDownStartTime: patch.rampDownStartTime ?? before.rampDownStartTime,
    offPeakStartTime: patch.offPeakStartTime ?? before.offPeakStartTime,
  };
}

/**
 * PATCH /v1/scalingplans/current/schedules/{scheduleName} — AM-23 (M3-S1).
 * Updates an EXISTING named schedule's phase times, load-balancing
 * algorithms, capacity thresholds, and min-hosts floors via ARM's
 * scalingPlanPooledSchedules.update (see avdService.updateScalingSchedule's
 * doc comment for why the child-resource API, not scalingPlans.update with
 * an inline schedules[] array). requireMinimumRole('operator') — same floor
 * as the other M2 mutating endpoints.
 *
 * GUARDS (peer review — AM-23 MAJORs 1 and 5), both checked AFTER reading
 * the current state but BEFORE any ARM write:
 * - Day coverage: simulates the plan's full schedule set with THIS
 *   schedule's daysOfWeek replaced by the patched value (if provided) and
 *   rejects (400 schedule_days_uncovered) if any of the 7 days would then
 *   be covered by zero schedules.
 * - Phase ordering: merges any patched start times onto the UNCHANGED ones
 *   and rejects (400 invalid_phase_order) unless rampUp < peak < rampDown <
 *   offPeak still holds — a PATCH touching only one time field could still
 *   put the schedule out of order relative to its other, untouched times.
 *
 * AUDIT: records a bounded before/after diff — only the fields the PATCH
 * body actually touched (see PATCHABLE_FIELDS), read from a getScalingSchedule
 * call BEFORE the update and the update's own response AFTER — not the full
 * schedule object, which keeps the audit row's parametersJson small
 * regardless of how many fields a schedule has.
 */
export async function scalingScheduleUpdate(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const correlationId = randomUUID();
  const logger = makeLogger(context);

  const authResult = requireMinimumRole(request, 'operator', context);
  if (!authResult.ok) return authResult.response;
  const { principal } = authResult;

  const scheduleName = request.params.scheduleName;
  if (!scheduleName) {
    return badRequest('missing_schedule_name', 'scheduleName route parameter is required.');
  }
  const nameError = validateScheduleNameParam(scheduleName);
  if (nameError) return nameError;

  let body: ScalingSchedulePatchRequest;
  try {
    body = ((await request.json()) ?? {}) as ScalingSchedulePatchRequest;
  } catch {
    return badRequest('invalid_request_body', 'Request body must be valid JSON.');
  }

  const daysOfWeek = validateDaysOfWeek(body.daysOfWeek, false);
  if (!daysOfWeek.ok) return daysOfWeek.response;
  const rampUpStartTime = validateOptionalPeriod(body.rampUpStartTime, 'rampUpStartTime');
  if (!rampUpStartTime.ok) return rampUpStartTime.response;
  const rampUpLba = validateOptionalLoadBalancingAlgorithm(body.rampUpLoadBalancingAlgorithm, 'rampUpLoadBalancingAlgorithm');
  if (!rampUpLba.ok) return rampUpLba.response;
  const rampUpMinPct = validateOptionalHostsPct(body.rampUpMinimumHostsPct, 'rampUpMinimumHostsPct');
  if (!rampUpMinPct.ok) return rampUpMinPct.response;
  const rampUpThreshold = validateOptionalCapacityThresholdPct(body.rampUpCapacityThresholdPct, 'rampUpCapacityThresholdPct');
  if (!rampUpThreshold.ok) return rampUpThreshold.response;
  const peakStartTime = validateOptionalPeriod(body.peakStartTime, 'peakStartTime');
  if (!peakStartTime.ok) return peakStartTime.response;
  const peakLba = validateOptionalLoadBalancingAlgorithm(body.peakLoadBalancingAlgorithm, 'peakLoadBalancingAlgorithm');
  if (!peakLba.ok) return peakLba.response;
  const rampDownStartTime = validateOptionalPeriod(body.rampDownStartTime, 'rampDownStartTime');
  if (!rampDownStartTime.ok) return rampDownStartTime.response;
  const rampDownLba = validateOptionalLoadBalancingAlgorithm(body.rampDownLoadBalancingAlgorithm, 'rampDownLoadBalancingAlgorithm');
  if (!rampDownLba.ok) return rampDownLba.response;
  const rampDownMinPct = validateOptionalHostsPct(body.rampDownMinimumHostsPct, 'rampDownMinimumHostsPct');
  if (!rampDownMinPct.ok) return rampDownMinPct.response;
  const rampDownThreshold = validateOptionalCapacityThresholdPct(body.rampDownCapacityThresholdPct, 'rampDownCapacityThresholdPct');
  if (!rampDownThreshold.ok) return rampDownThreshold.response;
  const rampDownForceLogoff = validateOptionalBoolean(body.rampDownForceLogoffUsers, 'rampDownForceLogoffUsers');
  if (!rampDownForceLogoff.ok) return rampDownForceLogoff.response;
  const rampDownStopWhen = validateOptionalStopHostsWhen(body.rampDownStopHostsWhen);
  if (!rampDownStopWhen.ok) return rampDownStopWhen.response;
  const rampDownWaitTime = validateOptionalWaitTimeMinutes(body.rampDownWaitTimeMinutes);
  if (!rampDownWaitTime.ok) return rampDownWaitTime.response;
  const rampDownMessage = validateOptionalNotificationMessage(body.rampDownNotificationMessage);
  if (!rampDownMessage.ok) return rampDownMessage.response;
  const offPeakStartTime = validateOptionalPeriod(body.offPeakStartTime, 'offPeakStartTime');
  if (!offPeakStartTime.ok) return offPeakStartTime.response;
  const offPeakLba = validateOptionalLoadBalancingAlgorithm(body.offPeakLoadBalancingAlgorithm, 'offPeakLoadBalancingAlgorithm');
  if (!offPeakLba.ok) return offPeakLba.response;
  const reason = validateOptionalReason(body.reason);
  if (!reason.ok) return reason.response;

  const patch: ScalingSchedulePatchRequest = {
    daysOfWeek: daysOfWeek.value,
    rampUpStartTime: rampUpStartTime.value,
    rampUpLoadBalancingAlgorithm: rampUpLba.value,
    rampUpMinimumHostsPct: rampUpMinPct.value,
    rampUpCapacityThresholdPct: rampUpThreshold.value,
    peakStartTime: peakStartTime.value,
    peakLoadBalancingAlgorithm: peakLba.value,
    rampDownStartTime: rampDownStartTime.value,
    rampDownLoadBalancingAlgorithm: rampDownLba.value,
    rampDownMinimumHostsPct: rampDownMinPct.value,
    rampDownCapacityThresholdPct: rampDownThreshold.value,
    rampDownForceLogoffUsers: rampDownForceLogoff.value,
    rampDownStopHostsWhen: rampDownStopWhen.value,
    rampDownWaitTimeMinutes: rampDownWaitTime.value,
    rampDownNotificationMessage: rampDownMessage.value,
    offPeakStartTime: offPeakStartTime.value,
    offPeakLoadBalancingAlgorithm: offPeakLba.value,
  };

  const touchedFields = PATCHABLE_FIELDS.filter((field) => patch[field] !== undefined);
  if (touchedFields.length === 0) {
    return badRequest('empty_patch', 'At least one field must be provided to update.');
  }

  if (isAuditRequiredButMissing()) {
    context.error(`AUDIT_MISCONFIGURED | correlationId=${correlationId} action=${UPDATE_AUDIT_ACTION} — AUDIT_STORAGE_ACCOUNT_NAME is unset in a deployed environment; refusing to mutate.`);
    const apiError: ApiError = { status: 500, code: 'audit_not_configured', message: `This environment cannot record an audit trail for this action, so it was not performed. Reference: ${correlationId}`, details: { correlationId } };
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

  const target = `${planRef.scalingPlanName}/${scheduleName}`;
  const actor = principal.userDetails;
  const actorId = principal.userId;

  let before: ScalingScheduleDetail;
  try {
    before = await getScalingSchedule(planRef.resourceGroup, planRef.scalingPlanName, scheduleName);
  } catch (error) {
    context.error(`scaling schedule PATCH — could not read before-state | target=${target} correlationId=${correlationId}`, error);
    await writeAuditEntry({ actor, actorId, action: UPDATE_AUDIT_ACTION, target, parameters: { attempted: touchedFields }, reason: reason.value, outcome: 'failure', detail: error instanceof Error ? error.message : String(error), correlationId }, logger);
    if (isNotFoundError(error)) return scheduleNotFound(scheduleName, correlationId);
    const apiError: ApiError = { status: 502, code: 'scaling_schedule_read_failed', message: `Failed to read schedule "${scheduleName}" from Azure. Reference: ${correlationId}`, details: { correlationId } };
    return { status: 502, jsonBody: apiError };
  }

  // --- Guards (peer review MAJORs 1 and 5) — checked AFTER the read, BEFORE any ARM write. ---
  const resolvedTimes = resolvePatchedTimes(before, patch);
  const orderingError = validatePhaseOrdering(resolvedTimes);
  if (orderingError) return orderingError;

  let allSchedules: ScalingScheduleDetail[];
  try {
    allSchedules = await listScalingSchedules(planRef.resourceGroup, planRef.scalingPlanName);
  } catch (error) {
    context.error(`scaling schedule PATCH — could not list schedules for the day-coverage guard | target=${target} correlationId=${correlationId}`, error);
    const apiError: ApiError = { status: 502, code: 'scaling_schedule_list_failed', message: `Failed to list schedules from Azure. Reference: ${correlationId}`, details: { correlationId } };
    return { status: 502, jsonBody: apiError };
  }
  const simulated = allSchedules.map((schedule) => (schedule.name === before.name ? { daysOfWeek: patch.daysOfWeek ?? before.daysOfWeek } : { daysOfWeek: schedule.daysOfWeek }));
  const uncoveredDays = computeUncoveredDays(simulated);
  if (uncoveredDays.length > 0) {
    return uncoveredDaysError(uncoveredDays);
  }

  const beforeSnapshot = Object.fromEntries(touchedFields.map((field) => [field, before[field]]));

  try {
    const updated = await updateScalingSchedule(planRef.resourceGroup, planRef.scalingPlanName, scheduleName, patch);
    const afterSnapshot = Object.fromEntries(touchedFields.map((field) => [field, updated[field]]));

    try {
      await writeAuditEntry({ actor, actorId, action: UPDATE_AUDIT_ACTION, target, parameters: { before: beforeSnapshot, after: afterSnapshot }, reason: reason.value, outcome: 'success', correlationId }, logger);
    } catch (auditError) {
      context.warn(`audit write threw unexpectedly (ignored — mutation already succeeded) | correlationId=${correlationId} target=${target} error=${String(auditError)}`);
    }

    const responseBody: ScalingSchedulePatchResponse = { schedule: updated };
    return { status: 200, jsonBody: responseBody };
  } catch (error) {
    context.error(`scaling schedule update failed | target=${target} correlationId=${correlationId}`, error);
    await writeAuditEntry({ actor, actorId, action: UPDATE_AUDIT_ACTION, target, parameters: { before: beforeSnapshot, attempted: touchedFields }, reason: reason.value, outcome: 'failure', detail: error instanceof Error ? error.message : String(error), correlationId }, logger);

    if (isNotFoundError(error)) return scheduleNotFound(scheduleName, correlationId);
    if (isForbiddenError(error)) {
      const apiError: ApiError = { status: 403, code: 'scaling_schedule_update_forbidden', message: `Azure denied the schedule update. Reference: ${correlationId}`, details: { correlationId } };
      return { status: 403, jsonBody: apiError };
    }
    if (isConflictError(error)) {
      const apiError: ApiError = { status: 409, code: 'scaling_schedule_update_conflict', message: `The schedule was modified concurrently — refresh and retry. Reference: ${correlationId}`, details: { correlationId } };
      return { status: 409, jsonBody: apiError };
    }
    if (isBadRequestError(error)) {
      // AM-15 (M7) sweep: no longer echoes error.message — see
      // isBadRequestError's doc comment in avdService.ts. Raw error already
      // logged server-side above, joinable by correlationId.
      const apiError: ApiError = {
        status: 400,
        code: 'scaling_schedule_update_rejected',
        message: `Azure rejected the schedule update as invalid — check the schedule's field values (times, day coverage, percentages) and try again. Reference: ${correlationId}`,
        details: { correlationId },
      };
      return { status: 400, jsonBody: apiError };
    }
    const apiError: ApiError = { status: 502, code: 'scaling_schedule_update_failed', message: `Failed to update schedule "${scheduleName}" in Azure. Reference: ${correlationId}`, details: { correlationId } };
    return { status: 502, jsonBody: apiError };
  }
}

/**
 * DELETE /v1/scalingplans/current/schedules/{scheduleName} — removes a
 * schedule via ARM's scalingPlanPooledSchedules.delete. Used to undo a
 * day-of-week split (see ScalingScheduleCreateRequest's doc comment) or
 * remove a schedule no longer wanted. requireMinimumRole('operator').
 *
 * Same day-coverage guard as PATCH (peer review — AM-23 MAJOR 1): rejects
 * (400 schedule_days_uncovered) if removing this schedule would leave any
 * of the 7 days covered by zero schedules, BEFORE calling ARM.
 */
export async function scalingScheduleDelete(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const correlationId = randomUUID();
  const logger = makeLogger(context);

  const authResult = requireMinimumRole(request, 'operator', context);
  if (!authResult.ok) return authResult.response;
  const { principal } = authResult;

  const scheduleName = request.params.scheduleName;
  if (!scheduleName) {
    return badRequest('missing_schedule_name', 'scheduleName route parameter is required.');
  }
  const nameError = validateScheduleNameParam(scheduleName);
  if (nameError) return nameError;

  let reason: string | undefined;
  try {
    const body = ((await request.json()) ?? {}) as { reason?: unknown };
    const reasonResult = validateOptionalReason(body.reason);
    if (!reasonResult.ok) return reasonResult.response;
    reason = reasonResult.value;
  } catch {
    // A DELETE with no/empty body is normal — only a malformed non-empty body should error, which request.json() already tolerates by returning null/undefined for an empty body per the Azure Functions runtime.
    reason = undefined;
  }

  if (isAuditRequiredButMissing()) {
    context.error(`AUDIT_MISCONFIGURED | correlationId=${correlationId} action=${DELETE_AUDIT_ACTION} — AUDIT_STORAGE_ACCOUNT_NAME is unset in a deployed environment; refusing to mutate.`);
    const apiError: ApiError = { status: 500, code: 'audit_not_configured', message: `This environment cannot record an audit trail for this action, so it was not performed. Reference: ${correlationId}`, details: { correlationId } };
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

  const target = `${planRef.scalingPlanName}/${scheduleName}`;
  const actor = principal.userDetails;
  const actorId = principal.userId;

  let before: ScalingScheduleDetail;
  try {
    before = await getScalingSchedule(planRef.resourceGroup, planRef.scalingPlanName, scheduleName);
  } catch (error) {
    if (isNotFoundError(error)) return scheduleNotFound(scheduleName, correlationId);
    context.error(`scaling schedule DELETE — could not read before-state | target=${target} correlationId=${correlationId}`, error);
    const apiError: ApiError = { status: 502, code: 'scaling_schedule_read_failed', message: `Failed to read schedule "${scheduleName}" from Azure. Reference: ${correlationId}`, details: { correlationId } };
    return { status: 502, jsonBody: apiError };
  }

  let allSchedules: ScalingScheduleDetail[];
  try {
    allSchedules = await listScalingSchedules(planRef.resourceGroup, planRef.scalingPlanName);
  } catch (error) {
    context.error(`scaling schedule DELETE — could not list schedules for the day-coverage guard | target=${target} correlationId=${correlationId}`, error);
    const apiError: ApiError = { status: 502, code: 'scaling_schedule_list_failed', message: `Failed to list schedules from Azure. Reference: ${correlationId}`, details: { correlationId } };
    return { status: 502, jsonBody: apiError };
  }
  const remaining = allSchedules.filter((schedule) => schedule.name !== scheduleName);
  const uncoveredDays = computeUncoveredDays(remaining);
  if (uncoveredDays.length > 0) {
    return uncoveredDaysError(uncoveredDays);
  }

  try {
    await deleteScalingSchedule(planRef.resourceGroup, planRef.scalingPlanName, scheduleName);

    try {
      await writeAuditEntry({ actor, actorId, action: DELETE_AUDIT_ACTION, target, parameters: { deletedSchedule: { name: before.name, daysOfWeek: before.daysOfWeek } }, reason, outcome: 'success', correlationId }, logger);
    } catch (auditError) {
      context.warn(`audit write threw unexpectedly (ignored — mutation already succeeded) | correlationId=${correlationId} target=${target} error=${String(auditError)}`);
    }

    const responseBody: ScalingScheduleDeleteResponse = { deletedScheduleName: scheduleName };
    return { status: 200, jsonBody: responseBody };
  } catch (error) {
    context.error(`scaling schedule delete failed | target=${target} correlationId=${correlationId}`, error);
    await writeAuditEntry({ actor, actorId, action: DELETE_AUDIT_ACTION, target, parameters: { attemptedDelete: scheduleName }, reason, outcome: 'failure', detail: error instanceof Error ? error.message : String(error), correlationId }, logger);

    if (isNotFoundError(error)) return scheduleNotFound(scheduleName, correlationId);
    if (isForbiddenError(error)) {
      const apiError: ApiError = { status: 403, code: 'scaling_schedule_delete_forbidden', message: `Azure denied the schedule delete. Reference: ${correlationId}`, details: { correlationId } };
      return { status: 403, jsonBody: apiError };
    }
    if (isConflictError(error)) {
      const apiError: ApiError = { status: 409, code: 'scaling_schedule_delete_conflict', message: `The schedule could not be deleted due to a conflict — refresh and retry. Reference: ${correlationId}`, details: { correlationId } };
      return { status: 409, jsonBody: apiError };
    }
    if (isBadRequestError(error)) {
      // AM-15 (M7) sweep: no longer echoes error.message — see
      // isBadRequestError's doc comment in avdService.ts. Raw error already
      // logged server-side above, joinable by correlationId.
      const apiError: ApiError = {
        status: 400,
        code: 'scaling_schedule_delete_rejected',
        message: `Azure rejected the schedule delete as invalid — this would likely leave a day uncovered, or the schedule name doesn't exist. Reference: ${correlationId}`,
        details: { correlationId },
      };
      return { status: 400, jsonBody: apiError };
    }
    const apiError: ApiError = { status: 502, code: 'scaling_schedule_delete_failed', message: `Failed to delete schedule "${scheduleName}" in Azure. Reference: ${correlationId}`, details: { correlationId } };
    return { status: 502, jsonBody: apiError };
  }
}

/**
 * Single app.http registration dispatching PATCH/DELETE — same
 * same-route-multi-method workaround as hostPoolRegistrationToken.ts (see
 * that file's dispatcher doc comment for the upstream issue reference).
 */
export async function scalingScheduleDispatch(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  switch (request.method) {
    case 'PATCH':
      return scalingScheduleUpdate(request, context);
    case 'DELETE':
      return scalingScheduleDelete(request, context);
    default: {
      const apiError: ApiError = { status: 405, code: 'method_not_allowed', message: `Method ${request.method} is not allowed on this route.` };
      return { status: 405, jsonBody: apiError };
    }
  }
}

app.http('scalingSchedule', {
  methods: ['PATCH', 'DELETE'],
  authLevel: 'anonymous',
  route: 'v1/scalingplans/current/schedules/{scheduleName}',
  handler: scalingScheduleDispatch,
});
