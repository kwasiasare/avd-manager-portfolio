import { randomUUID } from 'node:crypto';
import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import type { ApiError, ScalingScheduleCreateRequest, ScalingScheduleCreateResponse } from '@avdmgr/shared';
import { requireMinimumRole } from '../lib/auth';
import { isAuditRequiredButMissing, writeAuditEntry, type AuditLogger } from '../lib/auditLog';
import {
  computeUncoveredDays,
  uncoveredDaysError,
  validateDaysOfWeek,
  validateOptionalBoolean,
  validateOptionalCapacityThresholdPct,
  validateOptionalHostsPct,
  validateOptionalLoadBalancingAlgorithm,
  validateOptionalNotificationMessage,
  validateOptionalReason,
  validateOptionalStopHostsWhen,
  validateOptionalWaitTimeMinutes,
  validatePhaseOrdering,
  validateRequiredPeriod,
  validateScheduleName,
} from '../lib/scalingValidation';
import { badRequest } from '../lib/validation';
import {
  createScalingSchedule,
  getScalingSchedule,
  isBadRequestError,
  isConflictError,
  isForbiddenError,
  isNotFoundError,
  listScalingSchedules,
  resolveCurrentScalingPlanRef,
} from '../services/avdService';

const AUDIT_ACTION = 'scalingplan.schedule.create';

/**
 * POST /v1/scalingplans/current/schedules — AM-23 (M3-S1). Creates a NEW
 * named schedule via ARM's scalingPlanPooledSchedules.create — the
 * mechanism this app uses for per-day-of-week overrides: shrink an existing
 * schedule's daysOfWeek (PATCH .../schedules/{name}) and create one or more
 * additional schedules covering the split-off days (this endpoint). See
 * avdService.createScalingSchedule's doc comment and
 * ScalingScheduleCreateRequest's doc comment in @avdmgr/shared.
 *
 * requireMinimumRole('operator'). Unlike PATCH, every phase's start time and
 * daysOfWeek are mandatory here — ARM's create call expects a complete
 * schedule.
 *
 * SAFETY: ARM's scalingPlanPooledSchedules.create is documented as
 * "Create or update" — i.e. it is a PUT that would silently OVERWRITE an
 * existing schedule of the same name rather than erroring. This handler
 * checks for an existing schedule with the requested name FIRST and returns
 * 409 if one exists, so accidental overwrites can only happen through the
 * PATCH endpoint (which is explicit about editing, not creating).
 */
export async function scalingScheduleCreate(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const correlationId = randomUUID();
  const logger: AuditLogger = { warn: (m) => context.warn(m), error: (m) => context.error(m), log: (m) => context.log(m) };

  const authResult = requireMinimumRole(request, 'operator', context);
  if (!authResult.ok) return authResult.response;
  const { principal } = authResult;

  let body: ScalingScheduleCreateRequest;
  try {
    body = ((await request.json()) ?? {}) as ScalingScheduleCreateRequest;
  } catch {
    return badRequest('invalid_request_body', 'Request body must be valid JSON.');
  }

  const name = validateScheduleName(body.name);
  if (!name.ok) return name.response;
  const daysOfWeek = validateDaysOfWeek(body.daysOfWeek, true);
  if (!daysOfWeek.ok) return daysOfWeek.response;
  const rampUpStartTime = validateRequiredPeriod(body.rampUpStartTime, 'rampUpStartTime');
  if (!rampUpStartTime.ok) return rampUpStartTime.response;
  const rampUpLba = validateOptionalLoadBalancingAlgorithm(body.rampUpLoadBalancingAlgorithm, 'rampUpLoadBalancingAlgorithm');
  if (!rampUpLba.ok) return rampUpLba.response;
  const rampUpMinPct = validateOptionalHostsPct(body.rampUpMinimumHostsPct, 'rampUpMinimumHostsPct');
  if (!rampUpMinPct.ok) return rampUpMinPct.response;
  const rampUpThreshold = validateOptionalCapacityThresholdPct(body.rampUpCapacityThresholdPct, 'rampUpCapacityThresholdPct');
  if (!rampUpThreshold.ok) return rampUpThreshold.response;
  const peakStartTime = validateRequiredPeriod(body.peakStartTime, 'peakStartTime');
  if (!peakStartTime.ok) return peakStartTime.response;
  const peakLba = validateOptionalLoadBalancingAlgorithm(body.peakLoadBalancingAlgorithm, 'peakLoadBalancingAlgorithm');
  if (!peakLba.ok) return peakLba.response;
  const rampDownStartTime = validateRequiredPeriod(body.rampDownStartTime, 'rampDownStartTime');
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
  const offPeakStartTime = validateRequiredPeriod(body.offPeakStartTime, 'offPeakStartTime');
  if (!offPeakStartTime.ok) return offPeakStartTime.response;
  const offPeakLba = validateOptionalLoadBalancingAlgorithm(body.offPeakLoadBalancingAlgorithm, 'offPeakLoadBalancingAlgorithm');
  if (!offPeakLba.ok) return offPeakLba.response;
  const reason = validateOptionalReason(body.reason);
  if (!reason.ok) return reason.response;

  // Peer review (AM-23 MAJOR 5): CREATE always supplies all four times, so
  // phase ordering is checked directly against the validated values —
  // rampUp < peak < rampDown < offPeak — before anything else.
  const orderingError = validatePhaseOrdering({
    rampUpStartTime: rampUpStartTime.value,
    peakStartTime: peakStartTime.value,
    rampDownStartTime: rampDownStartTime.value,
    offPeakStartTime: offPeakStartTime.value,
  });
  if (orderingError) return orderingError;

  const schedule: ScalingScheduleCreateRequest = {
    name: name.value,
    daysOfWeek: daysOfWeek.value!,
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

  if (isAuditRequiredButMissing()) {
    context.error(`AUDIT_MISCONFIGURED | correlationId=${correlationId} action=${AUDIT_ACTION} — AUDIT_STORAGE_ACCOUNT_NAME is unset in a deployed environment; refusing to mutate.`);
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
    const apiError: ApiError = { status: 404, code: 'scaling_plan_not_found', message: `No scaling plan is associated with the configured host pool. Reference: ${correlationId}`, details: { correlationId } };
    return { status: 404, jsonBody: apiError };
  }

  const target = `${planRef.scalingPlanName}/${schedule.name}`;
  const actor = principal.userDetails;
  const actorId = principal.userId;

  // SAFETY check — see this handler's doc comment: ARM's create is really a
  // PUT and would silently overwrite an existing schedule of this name.
  const existing = await getScalingSchedule(planRef.resourceGroup, planRef.scalingPlanName, schedule.name).catch((error) => {
    if (isNotFoundError(error)) return null;
    throw error;
  });
  if (existing) {
    const apiError: ApiError = {
      status: 409,
      code: 'scaling_schedule_already_exists',
      message: `A schedule named "${schedule.name}" already exists — use PATCH to edit it instead. Reference: ${correlationId}`,
      details: { correlationId },
    };
    return { status: 409, jsonBody: apiError };
  }

  // Day-coverage guard (peer review — AM-23 MAJOR 1): a create only ever
  // ADDS coverage, so this only fires if the plan's OTHER schedules already
  // left a day uncovered before this request (e.g. an out-of-band change) —
  // still worth catching rather than letting a create silently coexist with
  // a pre-existing gap.
  let existingSchedules;
  try {
    existingSchedules = await listScalingSchedules(planRef.resourceGroup, planRef.scalingPlanName);
  } catch (error) {
    context.error(`scaling schedule create — could not list schedules for the day-coverage guard | target=${target} correlationId=${correlationId}`, error);
    const apiError: ApiError = { status: 502, code: 'scaling_schedule_list_failed', message: `Failed to list schedules from Azure. Reference: ${correlationId}`, details: { correlationId } };
    return { status: 502, jsonBody: apiError };
  }
  const uncoveredDays = computeUncoveredDays([...existingSchedules, { daysOfWeek: schedule.daysOfWeek }]);
  if (uncoveredDays.length > 0) {
    return uncoveredDaysError(uncoveredDays);
  }

  try {
    const created = await createScalingSchedule(planRef.resourceGroup, planRef.scalingPlanName, schedule.name, schedule);

    try {
      await writeAuditEntry(
        { actor, actorId, action: AUDIT_ACTION, target, parameters: { created: { name: created.name, daysOfWeek: created.daysOfWeek } }, reason: reason.value, outcome: 'success', correlationId },
        logger,
      );
    } catch (auditError) {
      context.warn(`audit write threw unexpectedly (ignored — mutation already succeeded) | correlationId=${correlationId} target=${target} error=${String(auditError)}`);
    }

    const responseBody: ScalingScheduleCreateResponse = { schedule: created };
    return { status: 201, jsonBody: responseBody };
  } catch (error) {
    context.error(`scaling schedule create failed | target=${target} correlationId=${correlationId}`, error);
    await writeAuditEntry({ actor, actorId, action: AUDIT_ACTION, target, parameters: { attempted: { name: schedule.name, daysOfWeek: schedule.daysOfWeek } }, reason: reason.value, outcome: 'failure', detail: error instanceof Error ? error.message : String(error), correlationId }, logger);

    if (isForbiddenError(error)) {
      const apiError: ApiError = { status: 403, code: 'scaling_schedule_create_forbidden', message: `Azure denied creating the schedule. Reference: ${correlationId}`, details: { correlationId } };
      return { status: 403, jsonBody: apiError };
    }
    if (isConflictError(error)) {
      const apiError: ApiError = { status: 409, code: 'scaling_schedule_create_conflict', message: `Could not create the schedule due to a conflict — refresh and retry. Reference: ${correlationId}`, details: { correlationId } };
      return { status: 409, jsonBody: apiError };
    }
    if (isBadRequestError(error)) {
      // AM-15 (M7) sweep: no longer echoes error.message (a RestError's
      // message can embed the full outbound request, including its body —
      // see isBadRequestError's doc comment in avdService.ts) — the raw
      // error is already logged server-side above (context.error), joinable
      // by correlationId.
      const apiError: ApiError = {
        status: 400,
        code: 'scaling_schedule_create_rejected',
        message: `Azure rejected the schedule create as invalid — check the schedule's field values (times, day coverage, percentages) and try again. Reference: ${correlationId}`,
        details: { correlationId },
      };
      return { status: 400, jsonBody: apiError };
    }
    const apiError: ApiError = { status: 502, code: 'scaling_schedule_create_failed', message: `Failed to create schedule "${schedule.name}" in Azure. Reference: ${correlationId}`, details: { correlationId } };
    return { status: 502, jsonBody: apiError };
  }
}

app.http('scalingScheduleCreate', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'v1/scalingplans/current/schedules',
  handler: scalingScheduleCreate,
});
