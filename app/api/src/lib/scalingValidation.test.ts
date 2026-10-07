import { describe, expect, it } from 'vitest';
import {
  computeUncoveredDays,
  MAX_OVERRIDE_MINUTES,
  MIN_OVERRIDE_MINUTES,
  SCHEDULE_NAME_PATTERN,
  uncoveredDaysError,
  validateDaysOfWeek,
  validateOptionalCapacityThresholdPct,
  validateOptionalHostsPct,
  validateOptionalLoadBalancingAlgorithm,
  validateOptionalPeriod,
  validateOptionalStopHostsWhen,
  validateOptionalWaitTimeMinutes,
  validateOverrideMinutes,
  validatePhaseOrdering,
  validateRequiredPeriod,
  validateScheduleName,
} from './scalingValidation';

describe('validateOptionalPeriod', () => {
  it('accepts undefined', () => {
    expect(validateOptionalPeriod(undefined, 'x')).toEqual({ ok: true, value: undefined });
  });
  it('accepts a valid {hour,minute}', () => {
    expect(validateOptionalPeriod({ hour: 8, minute: 30 }, 'x')).toEqual({ ok: true, value: { hour: 8, minute: 30 } });
  });
  it.each([
    { hour: -1, minute: 0 },
    { hour: 24, minute: 0 },
    { hour: 0, minute: -1 },
    { hour: 0, minute: 60 },
    { hour: 1.5, minute: 0 },
  ])('rejects out-of-range/non-integer %j', (period) => {
    const result = validateOptionalPeriod(period, 'x');
    expect(result.ok).toBe(false);
  });
  it('rejects a non-object', () => {
    expect(validateOptionalPeriod('08:00', 'x').ok).toBe(false);
  });
});

describe('validateRequiredPeriod', () => {
  it('rejects undefined (unlike validateOptionalPeriod)', () => {
    const result = validateRequiredPeriod(undefined, 'rampUpStartTime');
    expect(result.ok).toBe(false);
  });
  it('accepts a valid period', () => {
    expect(validateRequiredPeriod({ hour: 9, minute: 0 }, 'x')).toEqual({ ok: true, value: { hour: 9, minute: 0 } });
  });
});

describe('validateOptionalCapacityThresholdPct — ARM-documented 1-100', () => {
  it('accepts undefined', () => {
    expect(validateOptionalCapacityThresholdPct(undefined, 'x')).toEqual({ ok: true, value: undefined });
  });
  it('accepts the boundary values 1 and 100', () => {
    expect(validateOptionalCapacityThresholdPct(1, 'x')).toEqual({ ok: true, value: 1 });
    expect(validateOptionalCapacityThresholdPct(100, 'x')).toEqual({ ok: true, value: 100 });
  });
  it('rejects 0 (ARM documents Min value = 1, NOT 0, for capacity threshold)', () => {
    expect(validateOptionalCapacityThresholdPct(0, 'x').ok).toBe(false);
  });
  it('rejects 101', () => {
    expect(validateOptionalCapacityThresholdPct(101, 'x').ok).toBe(false);
  });
});

describe('validateOptionalHostsPct — ARM-documented 0-100', () => {
  it('accepts the boundary value 0 (unlike capacity threshold)', () => {
    expect(validateOptionalHostsPct(0, 'x')).toEqual({ ok: true, value: 0 });
  });
  it('accepts 100', () => {
    expect(validateOptionalHostsPct(100, 'x')).toEqual({ ok: true, value: 100 });
  });
  it('rejects 101 and -1', () => {
    expect(validateOptionalHostsPct(101, 'x').ok).toBe(false);
    expect(validateOptionalHostsPct(-1, 'x').ok).toBe(false);
  });
});

describe('validateOptionalLoadBalancingAlgorithm', () => {
  it('accepts BreadthFirst and DepthFirst', () => {
    expect(validateOptionalLoadBalancingAlgorithm('BreadthFirst', 'x')).toEqual({ ok: true, value: 'BreadthFirst' });
    expect(validateOptionalLoadBalancingAlgorithm('DepthFirst', 'x')).toEqual({ ok: true, value: 'DepthFirst' });
  });
  it('rejects an unknown algorithm', () => {
    expect(validateOptionalLoadBalancingAlgorithm('RoundRobin', 'x').ok).toBe(false);
  });
});

describe('validateOptionalStopHostsWhen', () => {
  it('accepts ZeroSessions and ZeroActiveSessions', () => {
    expect(validateOptionalStopHostsWhen('ZeroSessions')).toEqual({ ok: true, value: 'ZeroSessions' });
    expect(validateOptionalStopHostsWhen('ZeroActiveSessions')).toEqual({ ok: true, value: 'ZeroActiveSessions' });
  });
  it('rejects an unknown value', () => {
    expect(validateOptionalStopHostsWhen('Never').ok).toBe(false);
  });
});

describe('validateOptionalWaitTimeMinutes', () => {
  it('accepts 0 and a large-but-bounded value', () => {
    expect(validateOptionalWaitTimeMinutes(0)).toEqual({ ok: true, value: 0 });
    expect(validateOptionalWaitTimeMinutes(1440)).toEqual({ ok: true, value: 1440 });
  });
  it('rejects a negative value and one over this app\'s own sanity cap', () => {
    expect(validateOptionalWaitTimeMinutes(-1).ok).toBe(false);
    expect(validateOptionalWaitTimeMinutes(1441).ok).toBe(false);
  });
});

describe('validateDaysOfWeek', () => {
  it('accepts a valid, case-insensitive list and normalizes casing', () => {
    const result = validateDaysOfWeek(['monday', 'TUESDAY'], true);
    expect(result).toEqual({ ok: true, value: ['Monday', 'Tuesday'] });
  });
  it('required=true rejects undefined', () => {
    expect(validateDaysOfWeek(undefined, true).ok).toBe(false);
  });
  it('required=false accepts undefined', () => {
    expect(validateDaysOfWeek(undefined, false)).toEqual({ ok: true, value: undefined });
  });
  it('rejects an empty array', () => {
    expect(validateDaysOfWeek([], true).ok).toBe(false);
  });
  it('rejects an unknown day name', () => {
    expect(validateDaysOfWeek(['Someday'], true).ok).toBe(false);
  });
  it('rejects duplicates', () => {
    expect(validateDaysOfWeek(['Monday', 'monday'], true).ok).toBe(false);
  });
});

describe('validateScheduleName', () => {
  it('accepts a valid name', () => {
    expect(validateScheduleName('Weekdays')).toEqual({ ok: true, value: 'Weekdays' });
  });
  it('accepts the full allowed character set: letters, digits, @ . - _ and spaces', () => {
    expect(validateScheduleName('Wknd-Sched_2 @site.a').ok).toBe(true);
  });
  it('rejects an empty string', () => {
    expect(validateScheduleName('').ok).toBe(false);
  });
  it('rejects a name over 64 characters', () => {
    expect(validateScheduleName('x'.repeat(65)).ok).toBe(false);
  });
  it('rejects a disallowed character (e.g. a slash)', () => {
    expect(validateScheduleName('Week/Days').ok).toBe(false);
  });
});

describe('validateOverrideMinutes', () => {
  it(`accepts the documented boundary values ${MIN_OVERRIDE_MINUTES} and ${MAX_OVERRIDE_MINUTES}`, () => {
    expect(validateOverrideMinutes(MIN_OVERRIDE_MINUTES)).toEqual({ ok: true, value: MIN_OVERRIDE_MINUTES });
    expect(validateOverrideMinutes(MAX_OVERRIDE_MINUTES)).toEqual({ ok: true, value: MAX_OVERRIDE_MINUTES });
  });
  it('rejects below the minimum and above the maximum', () => {
    expect(validateOverrideMinutes(MIN_OVERRIDE_MINUTES - 1).ok).toBe(false);
    expect(validateOverrideMinutes(MAX_OVERRIDE_MINUTES + 1).ok).toBe(false);
  });
  it('rejects a non-integer', () => {
    expect(validateOverrideMinutes(30.5).ok).toBe(false);
  });
});

describe('computeUncoveredDays — AM-23 peer review MAJOR 1 (day-coverage guard)', () => {
  it('returns [] when a single schedule covers all 7 days', () => {
    expect(computeUncoveredDays([{ daysOfWeek: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] }])).toEqual([]);
  });

  it('returns [] when coverage is the UNION of several schedules', () => {
    expect(
      computeUncoveredDays([{ daysOfWeek: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'] }, { daysOfWeek: ['Saturday', 'Sunday'] }]),
    ).toEqual([]);
  });

  it('names every day covered by zero schedules, in KNOWN_DAY_NAMES (Sunday-first) order', () => {
    expect(computeUncoveredDays([{ daysOfWeek: ['Monday', 'Tuesday'] }])).toEqual(['Sunday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']);
  });

  it('returns every day for an empty schedule list', () => {
    expect(computeUncoveredDays([])).toEqual(['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']);
  });

  it('treats a schedule with an empty daysOfWeek as contributing no coverage', () => {
    expect(computeUncoveredDays([{ daysOfWeek: [] }, { daysOfWeek: ['Monday'] }])).toHaveLength(6);
  });
});

describe('uncoveredDaysError', () => {
  it('returns a 400 naming the days in the message and in details.uncoveredDays', () => {
    const response = uncoveredDaysError(['Saturday', 'Sunday']);
    expect(response.status).toBe(400);
    const body = response.jsonBody as { code: string; message: string; details: { uncoveredDays: string[] } };
    expect(body.code).toBe('schedule_days_uncovered');
    expect(body.message).toContain('Saturday, Sunday');
    expect(body.details.uncoveredDays).toEqual(['Saturday', 'Sunday']);
  });

  it('uses singular phrasing for exactly one uncovered day', () => {
    const response = uncoveredDaysError(['Sunday']);
    const body = response.jsonBody as { message: string };
    expect(body.message).toMatch(/\bit\b/);
    expect(body.message).not.toMatch(/\bthem\b/);
  });
});

describe('validatePhaseOrdering — AM-23 peer review MAJOR 5', () => {
  const VALID = {
    rampUpStartTime: { hour: 8, minute: 0 },
    peakStartTime: { hour: 9, minute: 0 },
    rampDownStartTime: { hour: 18, minute: 0 },
    offPeakStartTime: { hour: 20, minute: 0 },
  };

  it('returns null (no error) for strictly increasing times — the real SCALE-CONTOSO-PROD shape', () => {
    expect(validatePhaseOrdering(VALID)).toBeNull();
  });

  it('rejects rampUpStartTime not before peakStartTime', () => {
    const response = validatePhaseOrdering({ ...VALID, rampUpStartTime: { hour: 9, minute: 0 } });
    expect(response?.status).toBe(400);
    expect((response?.jsonBody as { code: string }).code).toBe('invalid_phase_order');
  });

  it('rejects peakStartTime not before rampDownStartTime', () => {
    const response = validatePhaseOrdering({ ...VALID, peakStartTime: { hour: 18, minute: 0 } });
    expect(response?.status).toBe(400);
  });

  it('rejects rampDownStartTime not before offPeakStartTime', () => {
    const response = validatePhaseOrdering({ ...VALID, rampDownStartTime: { hour: 20, minute: 0 } });
    expect(response?.status).toBe(400);
  });

  it('rejects two EQUAL times (not strictly increasing)', () => {
    const response = validatePhaseOrdering({ ...VALID, peakStartTime: VALID.rampUpStartTime });
    expect(response?.status).toBe(400);
  });
});

describe('SCHEDULE_NAME_PATTERN — exported for route-param re-validation (peer review item 12)', () => {
  it('accepts a valid name', () => {
    expect(SCHEDULE_NAME_PATTERN.test('AllDays')).toBe(true);
  });
  it('rejects a name containing a disallowed character', () => {
    expect(SCHEDULE_NAME_PATTERN.test('All/Days')).toBe(false);
  });
});
