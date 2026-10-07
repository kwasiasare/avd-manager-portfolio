import type { ScalingPlanDetail, ScalingScheduleDetail } from './index';

export type ScalingPhase = 'RampUp' | 'Peak' | 'RampDown' | 'OffPeak' | 'Unscheduled';

/**
 * AVD scaling plans store `timeZone` as a Windows timezone id (e.g.
 * "Eastern Standard Time"), not an IANA zone — but `Intl.DateTimeFormat`
 * (used below to read the current wall-clock time in that zone) only
 * understands IANA zones. This maps the handful of US Windows tz ids AVD
 * commonly uses; SCALE-CONTOSO-PROD (this app's only configured plan) uses
 * "Eastern Standard Time". Falls back to America/New_York (matching the
 * story's "+ EST timezone" requirement) for any id not in this table,
 * rather than throwing.
 */
const WINDOWS_TZ_TO_IANA: Record<string, string> = {
  'Eastern Standard Time': 'America/New_York',
  'Central Standard Time': 'America/Chicago',
  'Mountain Standard Time': 'America/Denver',
  'Pacific Standard Time': 'America/Los_Angeles',
  UTC: 'UTC',
};

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function toIanaZone(windowsTimeZone: string): string {
  return WINDOWS_TZ_TO_IANA[windowsTimeZone] ?? 'America/New_York';
}

/** Reads the wall-clock hour/minute and weekday name for `now` as observed in `ianaZone`. */
function wallClockIn(now: Date, ianaZone: string): { minutesSinceMidnight: number; dayName: string } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: ianaZone,
    weekday: 'long',
    hour: 'numeric',
    minute: 'numeric',
    hourCycle: 'h23',
  }).formatToParts(now);

  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  const hour = Number.parseInt(get('hour'), 10);
  const minute = Number.parseInt(get('minute'), 10);
  const dayName = get('weekday');

  return { minutesSinceMidnight: hour * 60 + minute, dayName };
}

function minutesOf(period: { hour: number; minute: number }): number {
  return period.hour * 60 + period.minute;
}

function findScheduleForDay(schedules: ScalingScheduleDetail[], dayName: string): ScalingScheduleDetail | undefined {
  return schedules.find((schedule) => schedule.daysOfWeek.some((day) => day.toLowerCase() === dayName.toLowerCase()));
}

/**
 * Computes the scaling plan's current phase for `now` (defaults to the real
 * current time), purely from the schedule's ramp-up / peak / ramp-down /
 * off-peak start times — no server round-trip needed once the plan detail
 * has been fetched. Lives in @avdmgr/shared (not the frontend) so it can be
 * unit-tested with vitest here (the frontend workspace has no test runner
 * configured) even though its only consumer today is
 * app/frontend/src/pages/Dashboard.tsx, which computes the phase
 * client-side per the M1 story's dashboard requirement.
 *
 * Mirrors AVD's own phase semantics: whichever period's start time is the
 * latest one at-or-before the current time (with wraparound after
 * midnight, since off-peak commonly spans past 00:00).
 *
 * Returns 'Unscheduled' if the plan is disabled or no schedule covers
 * today's weekday.
 */
export function computeScalingPhase(plan: Pick<ScalingPlanDetail, 'enabled' | 'timeZone' | 'schedules'>, now: Date = new Date()): ScalingPhase {
  if (!plan.enabled) {
    return 'Unscheduled';
  }

  const ianaZone = toIanaZone(plan.timeZone);
  const { minutesSinceMidnight, dayName } = wallClockIn(now, ianaZone);
  const schedule = findScheduleForDay(plan.schedules, dayName);
  if (!schedule) {
    return 'Unscheduled';
  }

  const unsortedBoundaries: Array<{ phase: ScalingPhase; start: number }> = [
    { phase: 'RampUp', start: minutesOf(schedule.rampUpStartTime) },
    { phase: 'Peak', start: minutesOf(schedule.peakStartTime) },
    { phase: 'RampDown', start: minutesOf(schedule.rampDownStartTime) },
    { phase: 'OffPeak', start: minutesOf(schedule.offPeakStartTime) },
  ];
  const boundaries = unsortedBoundaries.sort((a, b) => a.start - b.start);

  // The phase in effect is the last boundary at-or-before `now`; if `now` is
  // before every boundary (e.g. just after midnight, before ramp-up), the
  // previous day's off-peak is still in effect, i.e. the LAST boundary of
  // the (sorted) list wraps around to cover the start of the day.
  let current: ScalingPhase = boundaries[boundaries.length - 1].phase;
  for (const boundary of boundaries) {
    if (minutesSinceMidnight >= boundary.start) {
      current = boundary.phase;
    }
  }

  return current;
}

/** Sunday-first day names, exported for tests/consumers that want the exact vocabulary this module expects in daysOfWeek. */
export const KNOWN_DAY_NAMES = DAY_NAMES;
