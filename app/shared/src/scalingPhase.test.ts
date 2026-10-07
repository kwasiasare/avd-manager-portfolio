import { describe, expect, it } from 'vitest';
import type { ScalingPlanDetail } from './index';
import { computeScalingPhase } from './scalingPhase';

/**
 * Mirrors SCALE-CONTOSO-PROD's real schedule (see
 * The estate inventory): AllDays, ramp-up 08:00, peak
 * 09:00, ramp-down 18:00, off-peak 20:00, Eastern Standard Time.
 */
const REAL_PLAN: ScalingPlanDetail = {
  id: '/subscriptions/00000000-0000-4000-8000-000000000001/resourceGroups/RG-AVD-HostPools/providers/Microsoft.DesktopVirtualization/scalingPlans/SCALE-CONTOSO-PROD',
  name: 'SCALE-CONTOSO-PROD',
  hostPoolName: 'HP-CONTOSO-PROD',
  timeZone: 'Eastern Standard Time',
  enabled: true,
  schedules: [
    {
      name: 'AllDays',
      daysOfWeek: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'],
      rampUpStartTime: { hour: 8, minute: 0 },
      peakStartTime: { hour: 9, minute: 0 },
      rampDownStartTime: { hour: 18, minute: 0 },
      offPeakStartTime: { hour: 20, minute: 0 },
    },
  ],
};

/**
 * Builds a UTC Date for a given EST wall-clock time on 2026-01-12, a known
 * Monday. January is deliberately chosen (rather than a summer month) so
 * America/New_York resolves to EST (UTC-5, no daylight saving) — verified
 * directly against Intl.DateTimeFormat, not assumed.
 */
function estMonday(hour: number, minute = 0): Date {
  return new Date(Date.UTC(2026, 0, 12, hour + 5, minute));
}

describe('computeScalingPhase — table-driven, against the real SCALE-CONTOSO-PROD schedule', () => {
  const cases: Array<{ label: string; now: Date; expected: string }> = [
    { label: 'just after midnight (still yesterday off-peak, wraps around)', now: estMonday(0, 30), expected: 'OffPeak' },
    { label: 'just before ramp-up start', now: estMonday(7, 59), expected: 'OffPeak' },
    { label: 'exactly at ramp-up start (08:00)', now: estMonday(8, 0), expected: 'RampUp' },
    { label: 'during ramp-up window', now: estMonday(8, 30), expected: 'RampUp' },
    { label: 'exactly at peak start (09:00)', now: estMonday(9, 0), expected: 'Peak' },
    { label: 'mid-afternoon, still peak', now: estMonday(14, 0), expected: 'Peak' },
    { label: 'exactly at ramp-down start (18:00)', now: estMonday(18, 0), expected: 'RampDown' },
    { label: 'during ramp-down window', now: estMonday(19, 30), expected: 'RampDown' },
    { label: 'exactly at off-peak start (20:00)', now: estMonday(20, 0), expected: 'OffPeak' },
    { label: 'late night, off-peak', now: estMonday(23, 45), expected: 'OffPeak' },
  ];

  it.each(cases)('$label -> $expected', ({ now, expected }) => {
    expect(computeScalingPhase(REAL_PLAN, now)).toBe(expected);
  });
});

describe('computeScalingPhase — edge cases', () => {
  it('returns Unscheduled when the plan is disabled, regardless of time', () => {
    const disabled: ScalingPlanDetail = { ...REAL_PLAN, enabled: false };
    expect(computeScalingPhase(disabled, estMonday(9, 0))).toBe('Unscheduled');
  });

  it('returns Unscheduled when no schedule covers the current weekday', () => {
    const weekdaysOnly: ScalingPlanDetail = {
      ...REAL_PLAN,
      schedules: [{ ...REAL_PLAN.schedules[0], daysOfWeek: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'] }],
    };
    // 2026-01-17 is a Saturday (same January/EST reasoning as estMonday above).
    const saturdayNoon = new Date(Date.UTC(2026, 0, 17, 12 + 5, 0));
    expect(computeScalingPhase(weekdaysOnly, saturdayNoon)).toBe('Unscheduled');
  });

  it('falls back to America/New_York for an unrecognized Windows timezone id', () => {
    const unknownTz: ScalingPlanDetail = { ...REAL_PLAN, timeZone: 'Some Unknown Timezone' };
    // Same wall-clock assertion as the "exactly at peak start" case above —
    // if the fallback did not resolve to America/New_York, this would
    // compute a different phase (or throw).
    expect(computeScalingPhase(unknownTz, estMonday(9, 0))).toBe('Peak');
  });

  it('matches daysOfWeek case-insensitively', () => {
    const lowercaseDays: ScalingPlanDetail = {
      ...REAL_PLAN,
      schedules: [{ ...REAL_PLAN.schedules[0], daysOfWeek: ['monday'] }],
    };
    expect(computeScalingPhase(lowercaseDays, estMonday(9, 0))).toBe('Peak');
  });
});
