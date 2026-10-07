import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HttpRequest, InvocationContext } from '@azure/functions';

const resolveCurrentScalingPlanRef = vi.fn();
const getScalingSchedule = vi.fn();
const updateScalingSchedule = vi.fn();
const deleteScalingSchedule = vi.fn();
const listScalingSchedules = vi.fn();
const isNotFoundError = vi.fn().mockReturnValue(false);
const isForbiddenError = vi.fn().mockReturnValue(false);
const isConflictError = vi.fn().mockReturnValue(false);
const isBadRequestError = vi.fn().mockReturnValue(false);

vi.mock('../services/avdService', () => ({
  resolveCurrentScalingPlanRef: (...args: unknown[]) => resolveCurrentScalingPlanRef(...args),
  getScalingSchedule: (...args: unknown[]) => getScalingSchedule(...args),
  updateScalingSchedule: (...args: unknown[]) => updateScalingSchedule(...args),
  deleteScalingSchedule: (...args: unknown[]) => deleteScalingSchedule(...args),
  listScalingSchedules: (...args: unknown[]) => listScalingSchedules(...args),
  isNotFoundError: (...args: unknown[]) => isNotFoundError(...args),
  isForbiddenError: (...args: unknown[]) => isForbiddenError(...args),
  isConflictError: (...args: unknown[]) => isConflictError(...args),
  isBadRequestError: (...args: unknown[]) => isBadRequestError(...args),
}));

const writeAuditEntry = vi.fn().mockResolvedValue(undefined);
const isAuditRequiredButMissing = vi.fn().mockReturnValue(false);
vi.mock('../lib/auditLog', () => ({
  writeAuditEntry: (...args: unknown[]) => writeAuditEntry(...args),
  isAuditRequiredButMissing: (...args: unknown[]) => isAuditRequiredButMissing(...args),
}));

const { scalingScheduleUpdate, scalingScheduleDelete, scalingScheduleDispatch } = await import('./scalingSchedule');

function makeContext(): InvocationContext & { warnings: string[]; errors: unknown[]; logs: string[] } {
  const warnings: string[] = [];
  const errors: unknown[] = [];
  const logs: string[] = [];
  return { warn: (...a) => warnings.push(a.join(' ')), error: (...a) => errors.push(a), log: (...a) => logs.push(a.join(' ')), warnings, errors, logs } as unknown as InvocationContext & {
    warnings: string[];
    errors: unknown[];
    logs: string[];
  };
}

function encodePrincipal(principal: unknown): string {
  return Buffer.from(JSON.stringify(principal), 'utf-8').toString('base64');
}
function operatorHeader() {
  return encodePrincipal({ identityProvider: 'aad', userId: 'entra-op-1', userDetails: 'op@example.com', userRoles: ['operator'] });
}
function viewerHeader() {
  return encodePrincipal({ identityProvider: 'aad', userId: 'v1', userDetails: 'viewer@example.com', userRoles: ['viewer'] });
}

function makeRequest(options: { method?: string; headers?: Record<string, string>; scheduleName?: string; body?: unknown; jsonThrows?: boolean }): HttpRequest {
  const { method = 'PATCH', headers = {}, scheduleName = 'AllDays', body = { rampUpCapacityThresholdPct: 65 }, jsonThrows = false } = options;
  const lower = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    method,
    url: `https://func-example.azurewebsites.net/api/v1/scalingplans/current/schedules/${scheduleName}`,
    headers: { get: (name: string) => lower.get(name.toLowerCase()) ?? null },
    params: { scheduleName },
    json: async () => {
      if (jsonThrows) throw new Error('bad json');
      return body;
    },
  } as unknown as HttpRequest;
}

const PLAN_REF = { scalingPlanName: 'SCALE-CONTOSO-PROD', resourceGroup: 'RG-AVD-HostPools', hostPoolId: '/subscriptions/sub/resourceGroups/RG-AVD-HostPools/providers/Microsoft.DesktopVirtualization/hostPools/HP-CONTOSO-PROD' };

const ALL_DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// Mirrors SCALE-CONTOSO-PROD's real "AllDays" schedule — covers all 7 days on
// its own, so PATCH/DELETE tests that don't touch daysOfWeek don't
// accidentally trip the day-coverage guard.
const BEFORE_SCHEDULE = {
  name: 'AllDays',
  daysOfWeek: ALL_DAYS,
  rampUpStartTime: { hour: 8, minute: 0 },
  rampUpCapacityThresholdPct: 60,
  peakStartTime: { hour: 9, minute: 0 },
  rampDownStartTime: { hour: 18, minute: 0 },
  rampDownCapacityThresholdPct: 90,
  offPeakStartTime: { hour: 20, minute: 0 },
};

// A second, independently-full-coverage schedule — kept in the default
// listScalingSchedules mock alongside BEFORE_SCHEDULE so a DELETE of
// BEFORE_SCHEDULE still leaves every day covered in the "happy path" tests
// (a dedicated test below removes it to exercise the guard itself).
const REDUNDANT_SCHEDULE = { ...BEFORE_SCHEDULE, name: 'Redundant' };

beforeEach(() => {
  resolveCurrentScalingPlanRef.mockReset().mockResolvedValue(PLAN_REF);
  getScalingSchedule.mockReset().mockResolvedValue(BEFORE_SCHEDULE);
  updateScalingSchedule.mockReset().mockResolvedValue({ ...BEFORE_SCHEDULE, rampUpCapacityThresholdPct: 65 });
  deleteScalingSchedule.mockReset().mockResolvedValue(undefined);
  listScalingSchedules.mockReset().mockResolvedValue([BEFORE_SCHEDULE, REDUNDANT_SCHEDULE]);
  isNotFoundError.mockReset().mockReturnValue(false);
  isForbiddenError.mockReset().mockReturnValue(false);
  isConflictError.mockReset().mockReturnValue(false);
  isBadRequestError.mockReset().mockReturnValue(false);
  writeAuditEntry.mockReset().mockResolvedValue(undefined);
  isAuditRequiredButMissing.mockReset().mockReturnValue(false);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('scalingScheduleUpdate — role rejection', () => {
  it('403s a viewer and never calls updateScalingSchedule/writes audit', async () => {
    const response = await scalingScheduleUpdate(makeRequest({ headers: { 'x-ms-client-principal': viewerHeader() } }), makeContext());
    expect(response.status).toBe(403);
    expect(updateScalingSchedule).not.toHaveBeenCalled();
    expect(writeAuditEntry).not.toHaveBeenCalled();
  });

  it('401s an unauthenticated caller', async () => {
    const response = await scalingScheduleUpdate(makeRequest({}), makeContext());
    expect(response.status).toBe(401);
  });
});

describe('scalingScheduleUpdate — validation', () => {
  it('400s on an empty patch body', async () => {
    const response = await scalingScheduleUpdate(makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() }, body: {} }), makeContext());
    expect(response.status).toBe(400);
    expect(response.jsonBody).toMatchObject({ code: 'empty_patch' });
    expect(updateScalingSchedule).not.toHaveBeenCalled();
  });

  it('400s on an out-of-range capacity threshold', async () => {
    const response = await scalingScheduleUpdate(
      makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() }, body: { rampUpCapacityThresholdPct: 0 } }),
      makeContext(),
    );
    expect(response.status).toBe(400);
    expect(response.jsonBody).toMatchObject({ code: 'invalid_capacity_threshold_pct' });
  });

  it('400s on an invalid load balancing algorithm', async () => {
    const response = await scalingScheduleUpdate(
      makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() }, body: { peakLoadBalancingAlgorithm: 'RoundRobin' } }),
      makeContext(),
    );
    expect(response.status).toBe(400);
    expect(response.jsonBody).toMatchObject({ code: 'invalid_load_balancing_algorithm' });
  });

  it('400s on a malformed JSON body', async () => {
    const response = await scalingScheduleUpdate(makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() }, jsonThrows: true }), makeContext());
    expect(response.status).toBe(400);
    expect(response.jsonBody).toMatchObject({ code: 'invalid_request_body' });
  });

  it('400s when reason exceeds 1000 characters', async () => {
    const response = await scalingScheduleUpdate(
      makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() }, body: { rampUpCapacityThresholdPct: 65, reason: 'x'.repeat(1001) } }),
      makeContext(),
    );
    expect(response.status).toBe(400);
    expect(response.jsonBody).toMatchObject({ code: 'reason_too_long' });
  });

  it('400s on an invalid {scheduleName} route parameter (peer review item 12)', async () => {
    const response = await scalingScheduleUpdate(makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() }, scheduleName: 'a%2Fb' }), makeContext());
    expect(response.status).toBe(400);
    expect(response.jsonBody).toMatchObject({ code: 'invalid_schedule_name' });
    expect(updateScalingSchedule).not.toHaveBeenCalled();
  });
});

describe('scalingScheduleUpdate — day-coverage guard (peer review MAJOR 1)', () => {
  it('400s schedule_days_uncovered, naming the uncovered days, when narrowing daysOfWeek would leave days with zero schedules', async () => {
    listScalingSchedules.mockResolvedValue([BEFORE_SCHEDULE]); // no redundant coverage this time
    const response = await scalingScheduleUpdate(
      makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() }, body: { daysOfWeek: ['Monday', 'Tuesday'] } }),
      makeContext(),
    );
    expect(response.status).toBe(400);
    expect(response.jsonBody).toMatchObject({ code: 'schedule_days_uncovered' });
    const body = response.jsonBody as { details: { uncoveredDays: string[] } };
    expect(body.details.uncoveredDays).toEqual(['Sunday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']);
    expect(updateScalingSchedule).not.toHaveBeenCalled();
  });

  it('succeeds when another schedule still covers every day the narrowed schedule gives up', async () => {
    // listScalingSchedules default already includes REDUNDANT_SCHEDULE covering everything.
    const response = await scalingScheduleUpdate(
      makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() }, body: { daysOfWeek: ['Monday'] } }),
      makeContext(),
    );
    expect(response.status).toBe(200);
    expect(updateScalingSchedule).toHaveBeenCalled();
  });
});

describe('scalingScheduleUpdate — phase-ordering guard (peer review MAJOR 5)', () => {
  it('400s invalid_phase_order when a patched time would put phases out of order relative to the UNCHANGED times', async () => {
    // rampUpStartTime patched to 19:00, but rampDownStartTime (unchanged, from BEFORE_SCHEDULE) is 18:00 — rampUp would no longer be before peak/rampDown.
    const response = await scalingScheduleUpdate(
      makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() }, body: { rampUpStartTime: { hour: 19, minute: 0 } } }),
      makeContext(),
    );
    expect(response.status).toBe(400);
    expect(response.jsonBody).toMatchObject({ code: 'invalid_phase_order' });
    expect(updateScalingSchedule).not.toHaveBeenCalled();
  });
});

describe('scalingScheduleUpdate — fail-closed audit posture', () => {
  it('500s and never calls the service when audit is required but not configured', async () => {
    isAuditRequiredButMissing.mockReturnValue(true);
    const response = await scalingScheduleUpdate(makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() } }), makeContext());
    expect(response.status).toBe(500);
    expect(response.jsonBody).toMatchObject({ code: 'audit_not_configured' });
    expect(updateScalingSchedule).not.toHaveBeenCalled();
  });
});

describe('scalingScheduleUpdate — happy path', () => {
  it('updates the schedule, returns 200, and writes a bounded before/after audit row containing ONLY the touched field', async () => {
    const context = makeContext();
    const response = await scalingScheduleUpdate(
      makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() }, body: { rampUpCapacityThresholdPct: 65, reason: 'tune ramp-up' } }),
      context,
    );

    expect(response.status).toBe(200);
    expect(updateScalingSchedule).toHaveBeenCalledWith('RG-AVD-HostPools', 'SCALE-CONTOSO-PROD', 'AllDays', expect.objectContaining({ rampUpCapacityThresholdPct: 65 }));

    expect(writeAuditEntry).toHaveBeenCalledTimes(1);
    const [event] = writeAuditEntry.mock.calls[0];
    expect(event).toMatchObject({
      actor: 'op@example.com',
      actorId: 'entra-op-1',
      action: 'scalingplan.schedule.update',
      target: 'SCALE-CONTOSO-PROD/AllDays',
      reason: 'tune ramp-up',
      outcome: 'success',
    });
    // Bounded: only the touched field appears, not the whole schedule.
    expect(event.parameters.before).toEqual({ rampUpCapacityThresholdPct: 60 });
    expect(event.parameters.after).toEqual({ rampUpCapacityThresholdPct: 65 });
  });

  it('404s when the scaling plan is not associated with the host pool', async () => {
    resolveCurrentScalingPlanRef.mockResolvedValue(null);
    const response = await scalingScheduleUpdate(makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() } }), makeContext());
    expect(response.status).toBe(404);
    expect(response.jsonBody).toMatchObject({ code: 'scaling_plan_not_found' });
  });

  it('404s when the schedule does not exist (before-state read fails with 404)', async () => {
    getScalingSchedule.mockRejectedValue(Object.assign(new Error('not found'), { statusCode: 404 }));
    isNotFoundError.mockReturnValue(true);
    const response = await scalingScheduleUpdate(makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() } }), makeContext());
    expect(response.status).toBe(404);
    expect(response.jsonBody).toMatchObject({ code: 'scaling_schedule_not_found' });
    expect(updateScalingSchedule).not.toHaveBeenCalled();
  });

  it('maps a 403 from updateScalingSchedule to scaling_schedule_update_forbidden and writes a failure audit row', async () => {
    updateScalingSchedule.mockRejectedValue(Object.assign(new Error('AuthorizationFailed'), { statusCode: 403 }));
    isForbiddenError.mockReturnValue(true);
    const response = await scalingScheduleUpdate(makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() } }), makeContext());
    expect(response.status).toBe(403);
    expect(response.jsonBody).toMatchObject({ code: 'scaling_schedule_update_forbidden' });
    const [event] = writeAuditEntry.mock.calls.at(-1)!;
    expect(event.outcome).toBe('failure');
  });

  it('maps a 409 from updateScalingSchedule to scaling_schedule_update_conflict', async () => {
    updateScalingSchedule.mockRejectedValue(Object.assign(new Error('conflict'), { statusCode: 409 }));
    isConflictError.mockReturnValue(true);
    const response = await scalingScheduleUpdate(makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() } }), makeContext());
    expect(response.status).toBe(409);
    expect(response.jsonBody).toMatchObject({ code: 'scaling_schedule_update_conflict' });
  });

  it('maps a 400 from ARM (isBadRequestError) to a 400 WITHOUT echoing ARM\'s raw message (AM-15/M7 sweep — CWE-532)', async () => {
    // AM-15 (M7) peer review: this test previously asserted the OPPOSITE
    // (ARM's raw message surfaced verbatim in the response, from an earlier
    // "peer review MAJOR 5" fix) — an independent later review correctly
    // flagged that as unsafe: a RestError's message can embed the full
    // outbound request, including its body (CWE-532), so it must never
    // round-trip into a response the browser renders. The raw error is
    // still logged server-side (context.error) for support/debugging,
    // joinable by the correlationId in the response.
    const context = makeContext();
    updateScalingSchedule.mockRejectedValue(new Error('ARM: rampDownWaitTimeMinutes exceeds the allowed range'));
    isBadRequestError.mockReturnValue(true);
    const response = await scalingScheduleUpdate(makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() } }), context);
    expect(response.status).toBe(400);
    expect(response.jsonBody).toMatchObject({ code: 'scaling_schedule_update_rejected' });
    const body = response.jsonBody as { message: string };
    expect(body.message).not.toContain('rampDownWaitTimeMinutes exceeds the allowed range');
    expect(body.message).toContain('check the schedule\'s field values');
    expect(context.errors.some((entry) => String(entry).includes('rampDownWaitTimeMinutes exceeds the allowed range'))).toBe(true);
  });
});

describe('scalingScheduleDelete — role rejection', () => {
  it('403s a viewer', async () => {
    const response = await scalingScheduleDelete(makeRequest({ method: 'DELETE', headers: { 'x-ms-client-principal': viewerHeader() } }), makeContext());
    expect(response.status).toBe(403);
    expect(deleteScalingSchedule).not.toHaveBeenCalled();
  });
});

describe('scalingScheduleDelete — day-coverage guard (peer review MAJOR 1)', () => {
  it('400s schedule_days_uncovered, naming the days, and never calls ARM delete when this is the only schedule covering them', async () => {
    listScalingSchedules.mockResolvedValue([BEFORE_SCHEDULE]); // no redundant coverage
    const response = await scalingScheduleDelete(makeRequest({ method: 'DELETE', headers: { 'x-ms-client-principal': operatorHeader() } }), makeContext());
    expect(response.status).toBe(400);
    expect(response.jsonBody).toMatchObject({ code: 'schedule_days_uncovered' });
    const body = response.jsonBody as { details: { uncoveredDays: string[] } };
    expect(body.details.uncoveredDays).toEqual(ALL_DAYS);
    expect(deleteScalingSchedule).not.toHaveBeenCalled();
  });
});

describe('scalingScheduleDelete — happy path', () => {
  it('deletes the schedule, returns 200 with the deleted name, and writes a success audit row', async () => {
    const context = makeContext();
    const response = await scalingScheduleDelete(makeRequest({ method: 'DELETE', headers: { 'x-ms-client-principal': operatorHeader() } }), context);

    expect(response.status).toBe(200);
    expect(response.jsonBody).toEqual({ deletedScheduleName: 'AllDays' });
    expect(deleteScalingSchedule).toHaveBeenCalledWith('RG-AVD-HostPools', 'SCALE-CONTOSO-PROD', 'AllDays');
    const [event] = writeAuditEntry.mock.calls[0];
    expect(event).toMatchObject({ action: 'scalingplan.schedule.delete', target: 'SCALE-CONTOSO-PROD/AllDays', outcome: 'success' });
  });

  it('404s when the schedule does not exist', async () => {
    getScalingSchedule.mockRejectedValue(Object.assign(new Error('not found'), { statusCode: 404 }));
    isNotFoundError.mockReturnValue(true);
    const response = await scalingScheduleDelete(makeRequest({ method: 'DELETE', headers: { 'x-ms-client-principal': operatorHeader() } }), makeContext());
    expect(response.status).toBe(404);
    expect(deleteScalingSchedule).not.toHaveBeenCalled();
  });
});

describe('scalingScheduleDispatch', () => {
  it('routes PATCH to scalingScheduleUpdate', async () => {
    const response = await scalingScheduleDispatch(makeRequest({ method: 'PATCH', headers: { 'x-ms-client-principal': operatorHeader() } }), makeContext());
    expect(response.status).toBe(200);
    expect(updateScalingSchedule).toHaveBeenCalled();
  });

  it('routes DELETE to scalingScheduleDelete', async () => {
    const response = await scalingScheduleDispatch(makeRequest({ method: 'DELETE', headers: { 'x-ms-client-principal': operatorHeader() } }), makeContext());
    expect(response.status).toBe(200);
    expect(deleteScalingSchedule).toHaveBeenCalled();
  });

  it('405s any other method', async () => {
    const response = await scalingScheduleDispatch(makeRequest({ method: 'PUT', headers: { 'x-ms-client-principal': operatorHeader() } }), makeContext());
    expect(response.status).toBe(405);
  });
});
