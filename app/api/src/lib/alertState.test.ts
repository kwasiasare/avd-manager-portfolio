import { describe, expect, it } from 'vitest';
import type { AlertSummary } from '@avdmgr/shared';
import { applyAlertState, buildAlertResourceId, extractAlertGuid, isSnoozeActive, isValidAlertGuid, resolveSnoozeUntil, type AlertStateEntity } from './alertState';

const SUBSCRIPTION_ID = '00000000-0000-4000-8000-000000000001';
const ALERT_GUID = 'a1b2c3d4-e5f6-4789-a012-3456789abcde';
const VALID_ALERT_ID = `/subscriptions/${SUBSCRIPTION_ID}/providers/Microsoft.AlertsManagement/alerts/${ALERT_GUID}`;

function alert(overrides: Partial<AlertSummary> = {}): AlertSummary {
  return {
    id: VALID_ALERT_ID,
    name: 'High CPU',
    severity: 'Sev2',
    status: 'New',
    firedAt: '2026-08-15T10:00:00.000Z',
    ...overrides,
  };
}

describe('isValidAlertGuid', () => {
  it('accepts a bare GUID', () => {
    expect(isValidAlertGuid(ALERT_GUID)).toBe(true);
  });

  it('accepts uppercase hex', () => {
    expect(isValidAlertGuid(ALERT_GUID.toUpperCase())).toBe(true);
  });

  it('rejects the full ARM resource id (peer review MAJOR 1 — routes now take ONLY the bare guid)', () => {
    expect(isValidAlertGuid(VALID_ALERT_ID)).toBe(false);
  });

  it('rejects a non-string value', () => {
    expect(isValidAlertGuid(12345)).toBe(false);
    expect(isValidAlertGuid(undefined)).toBe(false);
    expect(isValidAlertGuid(null)).toBe(false);
  });

  it('rejects a guid with extra trailing characters (path-traversal-shaped injection attempt)', () => {
    expect(isValidAlertGuid(`${ALERT_GUID}/../../something`)).toBe(false);
  });

  it('rejects an empty string', () => {
    expect(isValidAlertGuid('')).toBe(false);
  });

  it('rejects a malformed guid (wrong segment lengths)', () => {
    expect(isValidAlertGuid('a1b2c3d4-e5f6-478-a012-3456789abcde')).toBe(false);
  });
});

describe('buildAlertResourceId / extractAlertGuid', () => {
  it('round-trips a guid through buildAlertResourceId -> extractAlertGuid', () => {
    const armId = buildAlertResourceId(SUBSCRIPTION_ID, ALERT_GUID);
    expect(armId).toBe(VALID_ALERT_ID);
    expect(extractAlertGuid(armId)).toBe(ALERT_GUID);
  });

  it('extractAlertGuid is case-insensitive on the provider segment and lowercases the returned guid', () => {
    const armId = VALID_ALERT_ID.replace('Microsoft.AlertsManagement', 'microsoft.alertsmanagement').replace(ALERT_GUID, ALERT_GUID.toUpperCase());
    expect(extractAlertGuid(armId)).toBe(ALERT_GUID.toLowerCase());
  });

  it('extractAlertGuid returns undefined for an id from a different provider', () => {
    expect(extractAlertGuid(`/subscriptions/${SUBSCRIPTION_ID}/providers/Microsoft.Compute/virtualMachines/vm1`)).toBeUndefined();
  });

  it('extractAlertGuid returns undefined for a malformed id', () => {
    expect(extractAlertGuid('not-an-arm-id')).toBeUndefined();
  });
});

describe('isSnoozeActive', () => {
  const now = new Date('2026-08-15T12:00:00.000Z');

  it('returns false when snoozedUntil is undefined', () => {
    expect(isSnoozeActive(undefined, now)).toBe(false);
  });

  it('returns false when snoozedUntil is not a valid date', () => {
    expect(isSnoozeActive('not-a-date', now)).toBe(false);
  });

  it('returns true when snoozedUntil is strictly in the future', () => {
    expect(isSnoozeActive('2026-08-15T13:00:00.000Z', now)).toBe(true);
  });

  it('returns false when snoozedUntil equals now', () => {
    expect(isSnoozeActive('2026-08-15T12:00:00.000Z', now)).toBe(false);
  });

  it('returns false when snoozedUntil is in the past', () => {
    expect(isSnoozeActive('2026-08-15T11:00:00.000Z', now)).toBe(false);
  });
});

describe('applyAlertState', () => {
  const now = new Date('2026-08-15T12:00:00.000Z');

  it('returns the alert unchanged when there is no state entity', () => {
    expect(applyAlertState(alert(), undefined, now)).toEqual(alert());
  });

  it('applies ack fields (including ackedReason) when present', () => {
    const entity: AlertStateEntity = { partitionKey: 'alert', rowKey: ALERT_GUID, ackedBy: 'op@example.com', ackedAt: '2026-08-15T09:00:00.000Z', ackedReason: 'investigating' };
    const result = applyAlertState(alert(), entity, now);
    expect(result.ackedBy).toBe('op@example.com');
    expect(result.ackedAt).toBe('2026-08-15T09:00:00.000Z');
    expect(result.ackedReason).toBe('investigating');
  });

  it('applies ack fields with ackedReason undefined when no reason was given', () => {
    const entity: AlertStateEntity = { partitionKey: 'alert', rowKey: ALERT_GUID, ackedBy: 'op@example.com', ackedAt: '2026-08-15T09:00:00.000Z' };
    const result = applyAlertState(alert(), entity, now);
    expect(result.ackedBy).toBe('op@example.com');
    expect(result.ackedReason).toBeUndefined();
  });

  it('applies snooze fields while the snooze is active', () => {
    const entity: AlertStateEntity = { partitionKey: 'alert', rowKey: ALERT_GUID, snoozedBy: 'op@example.com', snoozedUntil: '2026-08-15T13:00:00.000Z', snoozeReason: 'known issue' };
    const result = applyAlertState(alert(), entity, now);
    expect(result.snoozedUntil).toBe('2026-08-15T13:00:00.000Z');
    expect(result.snoozedBy).toBe('op@example.com');
    expect(result.snoozeReason).toBe('known issue');
  });

  it('omits snooze fields entirely once the snooze has expired', () => {
    const entity: AlertStateEntity = { partitionKey: 'alert', rowKey: ALERT_GUID, snoozedBy: 'op@example.com', snoozedUntil: '2026-08-15T11:00:00.000Z' };
    const result = applyAlertState(alert(), entity, now);
    expect(result.snoozedUntil).toBeUndefined();
    expect(result.snoozedBy).toBeUndefined();
  });

  it('applies both ack and (active) snooze together', () => {
    const entity: AlertStateEntity = {
      partitionKey: 'alert',
      rowKey: ALERT_GUID,
      ackedBy: 'op1@example.com',
      ackedAt: '2026-08-15T08:00:00.000Z',
      snoozedBy: 'op2@example.com',
      snoozedUntil: '2026-08-15T13:00:00.000Z',
    };
    const result = applyAlertState(alert(), entity, now);
    expect(result.ackedBy).toBe('op1@example.com');
    expect(result.snoozedBy).toBe('op2@example.com');
  });

  it('does not mutate the input alert', () => {
    const original = alert();
    const entity: AlertStateEntity = { partitionKey: 'alert', rowKey: ALERT_GUID, ackedBy: 'op@example.com', ackedAt: now.toISOString() };
    applyAlertState(original, entity, now);
    expect(original.ackedBy).toBeUndefined();
  });
});

describe('resolveSnoozeUntil', () => {
  const now = new Date('2026-08-15T12:00:00.000Z');

  it('resolves an hours-based snooze relative to now', () => {
    const result = resolveSnoozeUntil({ hours: 4 }, now);
    expect(result).toEqual({ ok: true, untilIso: '2026-08-15T16:00:00.000Z' });
  });

  it('resolves an untilIso-based snooze, normalized to ISO', () => {
    const result = resolveSnoozeUntil({ untilIso: '2026-08-16T00:00:00.000Z' }, now);
    expect(result).toEqual({ ok: true, untilIso: '2026-08-16T00:00:00.000Z' });
  });

  it('rejects when both untilIso and hours are supplied', () => {
    const result = resolveSnoozeUntil({ untilIso: '2026-08-16T00:00:00.000Z', hours: 4 }, now);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('ambiguous_snooze_duration');
  });

  it('rejects when neither untilIso nor hours are supplied', () => {
    const result = resolveSnoozeUntil({}, now);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('missing_snooze_duration');
  });

  it('rejects an invalid untilIso', () => {
    const result = resolveSnoozeUntil({ untilIso: 'not-a-date' }, now);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid_until_iso');
  });

  it('rejects an untilIso in the past', () => {
    const result = resolveSnoozeUntil({ untilIso: '2026-08-15T11:00:00.000Z' }, now);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('until_iso_in_past');
  });

  it('rejects hours below the minimum', () => {
    const result = resolveSnoozeUntil({ hours: 0 }, now);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('snooze_hours_out_of_range');
  });

  it('rejects hours above the maximum', () => {
    const result = resolveSnoozeUntil({ hours: 169 }, now);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('snooze_hours_out_of_range');
  });

  it('rejects a non-integer hours value', () => {
    const result = resolveSnoozeUntil({ hours: 4.5 }, now);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid_snooze_hours');
  });

  it('accepts the maximum bound (168 hours)', () => {
    const result = resolveSnoozeUntil({ hours: 168 }, now);
    expect(result).toEqual({ ok: true, untilIso: '2026-08-22T12:00:00.000Z' });
  });
});
