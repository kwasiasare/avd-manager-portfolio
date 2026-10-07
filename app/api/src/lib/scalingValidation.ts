import type { HttpResponseInit } from '@azure/functions';
import type { ApiError, LoadBalancingAlgorithm, ScalingSchedulePeriod, StopHostsWhen } from '@avdmgr/shared';
import { KNOWN_DAY_NAMES } from '@avdmgr/shared';
import type { FieldValidation } from './validation';
import { badRequest, MAX_REASON_LENGTH } from './validation';

/**
 * Validation helpers for the AM-23 (M3-S1) scaling-schedule editor and
 * emergency-override endpoints (app/api/src/functions/scalingSchedule.ts,
 * scalingScheduleCreate.ts, scalingEmergencyOverride.ts). Bounds are
 * verified against Microsoft Learn's Microsoft.DesktopVirtualization
 * scalingPlans ARM template reference
 * (https://learn.microsoft.com/azure/templates/microsoft.desktopvirtualization/scalingplans#property-values,
 * 2025-03-01-preview through the current version, all identical on these
 * fields) except where noted as this app's OWN operational choice rather
 * than an ARM-documented limit.
 */

const LOAD_BALANCING_ALGORITHMS: readonly LoadBalancingAlgorithm[] = ['BreadthFirst', 'DepthFirst'];
const STOP_HOSTS_WHEN_VALUES: readonly StopHostsWhen[] = ['ZeroSessions', 'ZeroActiveSessions'];

/** ARM-documented: Time.hour is 0-23 (required int). */
const MIN_HOUR = 0;
const MAX_HOUR = 23;
/** ARM-documented: Time.minute is 0-59 (required int). */
const MIN_MINUTE = 0;
const MAX_MINUTE = 59;
/** ARM-documented: rampUp/rampDownCapacityThresholdPct is an int, Min value 1, Max value 100. */
const MIN_CAPACITY_THRESHOLD_PCT = 1;
const MAX_CAPACITY_THRESHOLD_PCT = 100;
/** ARM-documented: rampUp/rampDownMinimumHostsPct is an int, Min value 0, Max value 100. */
const MIN_HOSTS_PCT = 0;
const MAX_HOSTS_PCT = 100;
/**
 * rampDownWaitTimeMinutes is documented by ARM only as `int` (no min/max
 * constraint published) — this upper bound is THIS APP'S OWN defensive
 * sanity cap (24 hours), not an ARM-verified limit, chosen to reject
 * obviously-wrong input (e.g. a typo'd extra digit) without guessing at a
 * real service-side ceiling.
 */
const MIN_WAIT_TIME_MINUTES = 0;
const MAX_WAIT_TIME_MINUTES = 1440;
/**
 * ARM-documented pattern/length for a pooledSchedules child-resource name
 * (Microsoft.DesktopVirtualization/scalingPlans/pooledSchedules ARM
 * template reference). Exported (peer review — AM-23 item 12) so the PATCH/
 * DELETE route handler (scalingSchedule.ts) can re-validate the
 * `{scheduleName}` route parameter against the SAME pattern CREATE enforces
 * on the request body — a route param is only guaranteed to be a non-empty
 * URL segment by Azure Functions' own routing, not a name ARM would ever
 * have accepted.
 */
export const SCHEDULE_NAME_PATTERN = /^[A-Za-z0-9@.\-_ ]{1,64}$/;
/** This app's own sanity cap for rampDownNotificationMessage — not an ARM-documented limit — same rationale/order-of-magnitude as MAX_REASON_LENGTH. */
const MAX_NOTIFICATION_MESSAGE_LENGTH = 1000;

/** AM-23's emergency "keep all hosts up" override — 15 minutes to 8 hours, this app's own operational bound (not ARM-documented) per the story's own spec. */
export const MIN_OVERRIDE_MINUTES = 15;
export const MAX_OVERRIDE_MINUTES = 480;

const DAY_NAME_SET = new Set(KNOWN_DAY_NAMES.map((day) => day.toLowerCase()));

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateInt(value: unknown, min: number, max: number, code: string, label: string): FieldValidation<number> {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    return { ok: false, response: badRequest(code, `${label} must be an integer between ${min} and ${max}.`) };
  }
  return { ok: true, value };
}

/** Validates an OPTIONAL {hour,minute} period. `undefined` is valid (field simply not being changed/set). */
export function validateOptionalPeriod(value: unknown, fieldName: string): FieldValidation<ScalingSchedulePeriod | undefined> {
  if (value === undefined) {
    return { ok: true, value: undefined };
  }
  if (!isPlainObject(value)) {
    return { ok: false, response: badRequest('invalid_period', `${fieldName}, if provided, must be an object with hour/minute.`) };
  }
  const hourResult = validateInt(value.hour, MIN_HOUR, MAX_HOUR, 'invalid_hour', `${fieldName}.hour`);
  if (!hourResult.ok) return hourResult;
  const minuteResult = validateInt(value.minute, MIN_MINUTE, MAX_MINUTE, 'invalid_minute', `${fieldName}.minute`);
  if (!minuteResult.ok) return minuteResult;
  return { ok: true, value: { hour: hourResult.value, minute: minuteResult.value } };
}

/** Same as validateOptionalPeriod, but the field itself is mandatory (used by schedule CREATE, where all four start times are required). */
export function validateRequiredPeriod(value: unknown, fieldName: string): FieldValidation<ScalingSchedulePeriod> {
  if (value === undefined) {
    return { ok: false, response: badRequest('missing_period', `${fieldName} is required.`) };
  }
  const result = validateOptionalPeriod(value, fieldName);
  if (!result.ok) return result;
  // validateOptionalPeriod only returns undefined for an undefined input, which is excluded above.
  return { ok: true, value: result.value as ScalingSchedulePeriod };
}

export function validateOptionalCapacityThresholdPct(value: unknown, fieldName: string): FieldValidation<number | undefined> {
  if (value === undefined) return { ok: true, value: undefined };
  return validateInt(value, MIN_CAPACITY_THRESHOLD_PCT, MAX_CAPACITY_THRESHOLD_PCT, 'invalid_capacity_threshold_pct', fieldName);
}

export function validateOptionalHostsPct(value: unknown, fieldName: string): FieldValidation<number | undefined> {
  if (value === undefined) return { ok: true, value: undefined };
  return validateInt(value, MIN_HOSTS_PCT, MAX_HOSTS_PCT, 'invalid_hosts_pct', fieldName);
}

export function validateOptionalLoadBalancingAlgorithm(value: unknown, fieldName: string): FieldValidation<LoadBalancingAlgorithm | undefined> {
  if (value === undefined) return { ok: true, value: undefined };
  if (typeof value !== 'string' || !(LOAD_BALANCING_ALGORITHMS as readonly string[]).includes(value)) {
    return { ok: false, response: badRequest('invalid_load_balancing_algorithm', `${fieldName}, if provided, must be one of: ${LOAD_BALANCING_ALGORITHMS.join(', ')}.`) };
  }
  return { ok: true, value: value as LoadBalancingAlgorithm };
}

export function validateOptionalStopHostsWhen(value: unknown): FieldValidation<StopHostsWhen | undefined> {
  if (value === undefined) return { ok: true, value: undefined };
  if (typeof value !== 'string' || !(STOP_HOSTS_WHEN_VALUES as readonly string[]).includes(value)) {
    return { ok: false, response: badRequest('invalid_stop_hosts_when', `rampDownStopHostsWhen, if provided, must be one of: ${STOP_HOSTS_WHEN_VALUES.join(', ')}.`) };
  }
  return { ok: true, value: value as StopHostsWhen };
}

export function validateOptionalBoolean(value: unknown, fieldName: string): FieldValidation<boolean | undefined> {
  if (value === undefined) return { ok: true, value: undefined };
  if (typeof value !== 'boolean') {
    return { ok: false, response: badRequest('invalid_boolean_field', `${fieldName}, if provided, must be a boolean.`) };
  }
  return { ok: true, value };
}

export function validateOptionalWaitTimeMinutes(value: unknown): FieldValidation<number | undefined> {
  if (value === undefined) return { ok: true, value: undefined };
  return validateInt(value, MIN_WAIT_TIME_MINUTES, MAX_WAIT_TIME_MINUTES, 'invalid_wait_time_minutes', 'rampDownWaitTimeMinutes');
}

export function validateOptionalNotificationMessage(value: unknown): FieldValidation<string | undefined> {
  if (value === undefined) return { ok: true, value: undefined };
  if (typeof value !== 'string') {
    return { ok: false, response: badRequest('invalid_notification_message', 'rampDownNotificationMessage, if provided, must be a string.') };
  }
  if (value.length > MAX_NOTIFICATION_MESSAGE_LENGTH) {
    return { ok: false, response: badRequest('notification_message_too_long', `rampDownNotificationMessage must be ${MAX_NOTIFICATION_MESSAGE_LENGTH} characters or fewer.`) };
  }
  return { ok: true, value };
}

/**
 * Validates daysOfWeek: a non-empty array of known day names
 * (case-insensitive on input, normalized to KNOWN_DAY_NAMES' canonical
 * casing on output — same vocabulary computeScalingPhase expects), no
 * duplicates. `required` controls whether an absent array is itself an
 * error (schedule CREATE) or simply "not being changed" (schedule PATCH).
 */
export function validateDaysOfWeek(value: unknown, required: boolean): FieldValidation<string[] | undefined> {
  if (value === undefined) {
    if (required) {
      return { ok: false, response: badRequest('missing_days_of_week', 'daysOfWeek is required and must be a non-empty array of day names.') };
    }
    return { ok: true, value: undefined };
  }
  if (!Array.isArray(value) || value.length === 0) {
    return { ok: false, response: badRequest('invalid_days_of_week', 'daysOfWeek must be a non-empty array of day names.') };
  }
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== 'string' || !DAY_NAME_SET.has(entry.toLowerCase())) {
      return {
        ok: false,
        response: badRequest('invalid_day_name', `daysOfWeek entries must be one of: ${KNOWN_DAY_NAMES.join(', ')}.`),
      };
    }
    const canonical = KNOWN_DAY_NAMES.find((day) => day.toLowerCase() === entry.toLowerCase())!;
    if (seen.has(canonical)) {
      return { ok: false, response: badRequest('duplicate_day_name', `daysOfWeek contains "${canonical}" more than once.`) };
    }
    seen.add(canonical);
    normalized.push(canonical);
  }
  return { ok: true, value: normalized };
}

/** Validates a schedule (ARM pooledSchedules child-resource) name — used by schedule CREATE only (PATCH/DELETE take the name from the route, already URL-decoded and never re-validated against this pattern beyond what routing itself requires). */
export function validateScheduleName(value: unknown): FieldValidation<string> {
  if (typeof value !== 'string' || !SCHEDULE_NAME_PATTERN.test(value)) {
    return {
      ok: false,
      response: badRequest('invalid_schedule_name', 'name is required, 1-64 characters, using only letters, digits, spaces, and the characters @ . - _'),
    };
  }
  return { ok: true, value };
}

/** Validates an OPTIONAL reason (schedule edits — reason is not required, matching sessionHostDrain.ts's convention). */
export function validateOptionalReason(value: unknown): FieldValidation<string | undefined> {
  if (value === undefined) return { ok: true, value: undefined };
  if (typeof value !== 'string') {
    return { ok: false, response: badRequest('invalid_reason', 'reason, if provided, must be a string.') };
  }
  if (value.length > MAX_REASON_LENGTH) {
    return { ok: false, response: badRequest('reason_too_long', `reason must be ${MAX_REASON_LENGTH} characters or fewer.`) };
  }
  return { ok: true, value };
}

/** Validates the emergency-override's mandatory `minutes` (15-480 — see MIN_OVERRIDE_MINUTES/MAX_OVERRIDE_MINUTES). */
export function validateOverrideMinutes(value: unknown): FieldValidation<number> {
  return validateInt(value, MIN_OVERRIDE_MINUTES, MAX_OVERRIDE_MINUTES, 'invalid_minutes', 'minutes');
}

/**
 * AM-23 peer-review MAJOR 1 — day-coverage guard: computes which of the 7
 * canonical days (KNOWN_DAY_NAMES) are covered by NONE of `schedules`.
 * Microsoft's own autoscale documentation is explicit that an uncovered day
 * doesn't mean "no autoscale action" — it means the scaling plan's default
 * (effectively an always-ramped-down state, i.e. hosts may be deallocated)
 * applies, which is a real behavioral change an operator editing/creating/
 * deleting a schedule needs to be blocked from doing by accident.
 *
 * Pure and schedule-shape-agnostic (only reads `daysOfWeek`) so callers can
 * pass either real ScalingScheduleDetail objects OR a simulated "what the
 * plan would look like after this mutation" array without needing every
 * other field populated — see scalingSchedule.ts/scalingScheduleCreate.ts
 * for how each of PATCH/CREATE/DELETE builds that simulated array.
 */
export function computeUncoveredDays(schedules: Array<{ daysOfWeek: string[] }>): string[] {
  const covered = new Set<string>();
  for (const schedule of schedules) {
    for (const day of schedule.daysOfWeek) {
      covered.add(day);
    }
  }
  return KNOWN_DAY_NAMES.filter((day) => !covered.has(day));
}

/** 400 response for computeUncoveredDays finding a gap — `details.uncoveredDays` lets the frontend show the same list without re-deriving it, and lets a caller with its own coverage check cross-verify against the server's authoritative view. */
export function uncoveredDaysError(uncoveredDays: string[]): HttpResponseInit {
  const apiError: ApiError = {
    status: 400,
    code: 'schedule_days_uncovered',
    message: `This change would leave the following day(s) with no scaling schedule at all: ${uncoveredDays.join(', ')}. Azure Virtual Desktop treats an uncovered day as a default ramp-down state — session hosts on that day may be deallocated. Adjust daysOfWeek, or add/keep another schedule covering ${uncoveredDays.length === 1 ? 'it' : 'them'}, before continuing.`,
    details: { uncoveredDays },
  };
  return { status: 400, jsonBody: apiError };
}

/**
 * AM-23 peer-review MAJOR 5 — phase-ordering guard: AVD's four phases are
 * meant to run in a single forward pass through the day (ramp-up, then
 * peak, then ramp-down, then off-peak — see SCALE-CONTOSO-PROD's own real
 * schedule: 08:00 < 09:00 < 18:00 < 20:00, the captured estate inventory).
 * Rejects any RESOLVED (post-patch) schedule whose four start times are not
 * strictly increasing, naming the first violated pair — this is checked
 * server-side (not just inferred from the timeline UI) because a PATCH that
 * only touches ONE time field could still put the schedule out of order
 * relative to its OTHER, unchanged times.
 */
export function validatePhaseOrdering(resolved: {
  rampUpStartTime: ScalingSchedulePeriod;
  peakStartTime: ScalingSchedulePeriod;
  rampDownStartTime: ScalingSchedulePeriod;
  offPeakStartTime: ScalingSchedulePeriod;
}): HttpResponseInit | null {
  const minutesOf = (period: ScalingSchedulePeriod) => period.hour * 60 + period.minute;
  const rampUp = minutesOf(resolved.rampUpStartTime);
  const peak = minutesOf(resolved.peakStartTime);
  const rampDown = minutesOf(resolved.rampDownStartTime);
  const offPeak = minutesOf(resolved.offPeakStartTime);

  if (!(rampUp < peak)) {
    return badRequest('invalid_phase_order', 'rampUpStartTime must be earlier than peakStartTime.');
  }
  if (!(peak < rampDown)) {
    return badRequest('invalid_phase_order', 'peakStartTime must be earlier than rampDownStartTime.');
  }
  if (!(rampDown < offPeak)) {
    return badRequest('invalid_phase_order', 'rampDownStartTime must be earlier than offPeakStartTime.');
  }
  return null;
}
