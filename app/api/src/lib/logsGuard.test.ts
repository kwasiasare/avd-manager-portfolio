import { describe, expect, it } from 'vitest';
import {
  MAX_ALERT_HOURS,
  MAX_KQL_LENGTH,
  MAX_RESULT_ROWS,
  MAX_TIMESPAN_HOURS,
  MIN_ALERT_HOURS,
  MIN_TIMESPAN_HOURS,
  capRows,
  parseHoursParam,
  validateKqlLength,
  validateTimespanHours,
} from './logsGuard';

describe('parseHoursParam', () => {
  it('returns the default when raw is null (query param omitted)', () => {
    expect(parseHoursParam(null, 24, MIN_ALERT_HOURS, MAX_ALERT_HOURS)).toEqual({ ok: true, value: 24 });
  });

  it('returns the default when raw is an empty string', () => {
    expect(parseHoursParam('', 24, MIN_ALERT_HOURS, MAX_ALERT_HOURS)).toEqual({ ok: true, value: 24 });
  });

  it('accepts a valid in-range integer', () => {
    expect(parseHoursParam('48', 24, MIN_ALERT_HOURS, MAX_ALERT_HOURS)).toEqual({ ok: true, value: 48 });
  });

  it('accepts the minimum bound', () => {
    expect(parseHoursParam(String(MIN_ALERT_HOURS), 24, MIN_ALERT_HOURS, MAX_ALERT_HOURS)).toEqual({ ok: true, value: MIN_ALERT_HOURS });
  });

  it('accepts the maximum bound', () => {
    expect(parseHoursParam(String(MAX_ALERT_HOURS), 24, MIN_ALERT_HOURS, MAX_ALERT_HOURS)).toEqual({ ok: true, value: MAX_ALERT_HOURS });
  });

  it('rejects a value below the minimum', () => {
    const result = parseHoursParam('0', 24, MIN_ALERT_HOURS, MAX_ALERT_HOURS);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('hours_out_of_range');
  });

  it('rejects a value above the maximum', () => {
    const result = parseHoursParam('169', 24, MIN_ALERT_HOURS, MAX_ALERT_HOURS);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('hours_out_of_range');
  });

  it('rejects a non-integer value', () => {
    const result = parseHoursParam('12.5', 24, MIN_ALERT_HOURS, MAX_ALERT_HOURS);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid_hours');
  });

  it('rejects a non-numeric value', () => {
    const result = parseHoursParam('abc', 24, MIN_ALERT_HOURS, MAX_ALERT_HOURS);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid_hours');
  });

  // Peer review item 15: parseHoursParam now requires /^\d+$/ before calling
  // Number() at all — Number() alone accepts far more than a plain decimal
  // integer (scientific notation, hex, whitespace-padded, Infinity, a
  // leading '+'), any of which would otherwise slip past the
  // finite+integer check with a surprising parsed value.
  it('rejects scientific notation even though Number() would parse it as a finite integer', () => {
    const result = parseHoursParam('2e1', 24, MIN_ALERT_HOURS, MAX_ALERT_HOURS);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid_hours');
  });

  it('rejects hex notation', () => {
    const result = parseHoursParam('0x18', 24, MIN_ALERT_HOURS, MAX_ALERT_HOURS);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid_hours');
  });

  it('rejects whitespace-padded input even though Number() would trim and parse it', () => {
    const result = parseHoursParam(' 24 ', 24, MIN_ALERT_HOURS, MAX_ALERT_HOURS);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid_hours');
  });

  it('rejects a leading-plus-sign value', () => {
    const result = parseHoursParam('+24', 24, MIN_ALERT_HOURS, MAX_ALERT_HOURS);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid_hours');
  });

  it('rejects a negative value (the leading "-" itself fails the digits-only pattern)', () => {
    const result = parseHoursParam('-5', 24, MIN_ALERT_HOURS, MAX_ALERT_HOURS);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid_hours');
  });

  it('rejects "Infinity"', () => {
    const result = parseHoursParam('Infinity', 24, MIN_ALERT_HOURS, MAX_ALERT_HOURS);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid_hours');
  });
});

describe('validateKqlLength', () => {
  it('accepts a normal query string', () => {
    expect(validateKqlLength('WVDConnections | take 10')).toEqual({ ok: true });
  });

  it('rejects a missing kql', () => {
    const result = validateKqlLength(undefined);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('missing_kql');
  });

  it('rejects an empty/whitespace-only kql', () => {
    const result = validateKqlLength('   ');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('missing_kql');
  });

  it('rejects a non-string kql', () => {
    const result = validateKqlLength(12345);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('missing_kql');
  });

  it('accepts a query exactly at MAX_KQL_LENGTH', () => {
    expect(validateKqlLength('a'.repeat(MAX_KQL_LENGTH))).toEqual({ ok: true });
  });

  it('rejects a query over MAX_KQL_LENGTH', () => {
    const result = validateKqlLength('a'.repeat(MAX_KQL_LENGTH + 1));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('kql_too_long');
  });
});

describe('validateTimespanHours', () => {
  it('accepts a value within bounds', () => {
    expect(validateTimespanHours(24)).toEqual({ ok: true, value: 24 });
  });

  it('accepts the minimum bound', () => {
    expect(validateTimespanHours(MIN_TIMESPAN_HOURS)).toEqual({ ok: true, value: MIN_TIMESPAN_HOURS });
  });

  it('accepts the maximum bound', () => {
    expect(validateTimespanHours(MAX_TIMESPAN_HOURS)).toEqual({ ok: true, value: MAX_TIMESPAN_HOURS });
  });

  it('rejects a value below the minimum', () => {
    const result = validateTimespanHours(0);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('timespan_out_of_range');
  });

  it('rejects a value above the maximum', () => {
    const result = validateTimespanHours(MAX_TIMESPAN_HOURS + 1);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('timespan_out_of_range');
  });

  it('rejects a non-integer value', () => {
    const result = validateTimespanHours(12.5);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid_timespan');
  });

  it('rejects a missing value', () => {
    const result = validateTimespanHours(undefined);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid_timespan');
  });

  it('rejects a non-numeric value', () => {
    const result = validateTimespanHours('24');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid_timespan');
  });
});

describe('capRows', () => {
  it('returns rows unchanged and truncated=false when under the cap', () => {
    const rows = [1, 2, 3];
    expect(capRows(rows, 10)).toEqual({ rows: [1, 2, 3], truncated: false });
  });

  it('returns rows unchanged and truncated=false when exactly at the cap', () => {
    const rows = [1, 2, 3];
    expect(capRows(rows, 3)).toEqual({ rows: [1, 2, 3], truncated: false });
  });

  it('truncates and reports truncated=true when over the cap', () => {
    const rows = [1, 2, 3, 4, 5];
    expect(capRows(rows, 3)).toEqual({ rows: [1, 2, 3], truncated: true });
  });

  it('does not mutate the input array', () => {
    const rows = [1, 2, 3, 4, 5];
    capRows(rows, 2);
    expect(rows).toEqual([1, 2, 3, 4, 5]);
  });

  it('defaults to MAX_RESULT_ROWS when no cap is supplied', () => {
    const rows = new Array(MAX_RESULT_ROWS + 1).fill(0);
    const result = capRows(rows);
    expect(result.truncated).toBe(true);
    expect(result.rows).toHaveLength(MAX_RESULT_ROWS);
  });
});
