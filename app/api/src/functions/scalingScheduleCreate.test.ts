import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HttpRequest, InvocationContext } from '@azure/functions';

const resolveCurrentScalingPlanRef = vi.fn();
const getScalingSchedule = vi.fn();
const createScalingSchedule = vi.fn();
const listScalingSchedules = vi.fn();
const isNotFoundError = vi.fn().mockReturnValue(false);
const isForbiddenError = vi.fn().mockReturnValue(false);
const isConflictError = vi.fn().mockReturnValue(false);
const isBadRequestError = vi.fn().mockReturnValue(false);

vi.mock('../services/avdService', () => ({
  resolveCurrentScalingPlanRef: (...args: unknown[]) => resolveCurrentScalingPlanRef(...args),
  getScalingSchedule: (...args: unknown[]) => getScalingSchedule(...args),
  createScalingSchedule: (...args: unknown[]) => createScalingSchedule(...args),
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

const { scalingScheduleCreate } = await import('./scalingScheduleCreate');

function makeContext(): InvocationContext {
  return { warn: () => {}, error: () => {}, log: () => {} } as unknown as InvocationContext;
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

const VALID_BODY = {
  name: 'Weekend',
  daysOfWeek: ['Saturday', 'Sunday'],
  rampUpStartTime: { hour: 9, minute: 0 },
  peakStartTime: { hour: 10, minute: 0 },
  rampDownStartTime: { hour: 20, minute: 0 },
  offPeakStartTime: { hour: 22, minute: 0 },
};

function makeRequest(options: { headers?: Record<string, string>; body?: unknown; jsonThrows?: boolean } = {}): HttpRequest {
  const { headers = {}, body = VALID_BODY, jsonThrows = false } = options;
  const lower = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    method: 'POST',
    url: 'https://func-example.azurewebsites.net/api/v1/scalingplans/current/schedules',
    headers: { get: (name: string) => lower.get(name.toLowerCase()) ?? null },
    params: {},
    json: async () => {
      if (jsonThrows) throw new Error('bad json');
      return body;
    },
  } as unknown as HttpRequest;
}

const PLAN_REF = { scalingPlanName: 'SCALE-CONTOSO-PROD', resourceGroup: 'RG-AVD-HostPools', hostPoolId: '/subscriptions/sub/resourceGroups/RG-AVD-HostPools/providers/Microsoft.DesktopVirtualization/hostPools/HP-CONTOSO-PROD' };

// An existing "Weekdays" schedule — combined with VALID_BODY's Sat/Sun, the
// full week is covered, so the day-coverage guard doesn't trip in the
// happy-path tests below (a dedicated test exercises the guard itself).
const WEEKDAY_SCHEDULE = { name: 'Weekdays', daysOfWeek: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'] };

beforeEach(() => {
  resolveCurrentScalingPlanRef.mockReset().mockResolvedValue(PLAN_REF);
  getScalingSchedule.mockReset().mockRejectedValue(Object.assign(new Error('not found'), { statusCode: 404 }));
  isNotFoundError.mockReset().mockImplementation((e: unknown) => (e as { statusCode?: number })?.statusCode === 404);
  createScalingSchedule.mockReset().mockResolvedValue({ ...VALID_BODY });
  listScalingSchedules.mockReset().mockResolvedValue([WEEKDAY_SCHEDULE]);
  isForbiddenError.mockReset().mockReturnValue(false);
  isConflictError.mockReset().mockReturnValue(false);
  isBadRequestError.mockReset().mockReturnValue(false);
  writeAuditEntry.mockReset().mockResolvedValue(undefined);
  isAuditRequiredButMissing.mockReset().mockReturnValue(false);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('scalingScheduleCreate — role rejection', () => {
  it('403s a viewer', async () => {
    const response = await scalingScheduleCreate(makeRequest({ headers: { 'x-ms-client-principal': viewerHeader() } }), makeContext());
    expect(response.status).toBe(403);
    expect(createScalingSchedule).not.toHaveBeenCalled();
  });
});

describe('scalingScheduleCreate — validation', () => {
  it('400s on a missing name', async () => {
    const response = await scalingScheduleCreate(makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() }, body: { ...VALID_BODY, name: undefined } }), makeContext());
    expect(response.status).toBe(400);
    expect(response.jsonBody).toMatchObject({ code: 'invalid_schedule_name' });
  });

  it('400s on an empty daysOfWeek array', async () => {
    const response = await scalingScheduleCreate(makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() }, body: { ...VALID_BODY, daysOfWeek: [] } }), makeContext());
    expect(response.status).toBe(400);
    expect(response.jsonBody).toMatchObject({ code: 'invalid_days_of_week' });
  });

  it('400s on a missing required start time', async () => {
    const response = await scalingScheduleCreate(makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() }, body: { ...VALID_BODY, offPeakStartTime: undefined } }), makeContext());
    expect(response.status).toBe(400);
    expect(response.jsonBody).toMatchObject({ code: 'missing_period' });
  });

  it('400s on a malformed JSON body', async () => {
    const response = await scalingScheduleCreate(makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() }, jsonThrows: true }), makeContext());
    expect(response.status).toBe(400);
  });
});

describe('scalingScheduleCreate — SAFETY: refuses to silently overwrite an existing schedule', () => {
  it('409s when a schedule with the requested name already exists, without calling ARM create', async () => {
    getScalingSchedule.mockResolvedValue({ ...VALID_BODY });
    const response = await scalingScheduleCreate(makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() } }), makeContext());
    expect(response.status).toBe(409);
    expect(response.jsonBody).toMatchObject({ code: 'scaling_schedule_already_exists' });
    expect(createScalingSchedule).not.toHaveBeenCalled();
  });
});

describe('scalingScheduleCreate — day-coverage guard (peer review MAJOR 1)', () => {
  it('400s schedule_days_uncovered when existing schedules already leave a gap the new schedule does not fill (defensive — a create only ever ADDS coverage)', async () => {
    listScalingSchedules.mockResolvedValue([{ name: 'Weekdays', daysOfWeek: ['Monday', 'Tuesday', 'Wednesday'] }]); // Thu/Fri already uncovered before this create
    const response = await scalingScheduleCreate(makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() } }), makeContext());
    expect(response.status).toBe(400);
    expect(response.jsonBody).toMatchObject({ code: 'schedule_days_uncovered' });
    const body = response.jsonBody as { details: { uncoveredDays: string[] } };
    expect(body.details.uncoveredDays).toEqual(['Thursday', 'Friday']);
    expect(createScalingSchedule).not.toHaveBeenCalled();
  });
});

describe('scalingScheduleCreate — phase-ordering guard (peer review MAJOR 5)', () => {
  it('400s invalid_phase_order when the four required times are not strictly increasing', async () => {
    const response = await scalingScheduleCreate(
      makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() }, body: { ...VALID_BODY, peakStartTime: { hour: 8, minute: 0 } } }),
      makeContext(),
    );
    expect(response.status).toBe(400);
    expect(response.jsonBody).toMatchObject({ code: 'invalid_phase_order' });
    expect(createScalingSchedule).not.toHaveBeenCalled();
  });
});

describe('scalingScheduleCreate — happy path', () => {
  it('creates the schedule, returns 201, and writes a success audit row', async () => {
    const response = await scalingScheduleCreate(makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() } }), makeContext());

    expect(response.status).toBe(201);
    expect(createScalingSchedule).toHaveBeenCalledWith('RG-AVD-HostPools', 'SCALE-CONTOSO-PROD', 'Weekend', expect.objectContaining({ name: 'Weekend', daysOfWeek: ['Saturday', 'Sunday'] }));

    const [event] = writeAuditEntry.mock.calls[0];
    expect(event).toMatchObject({ action: 'scalingplan.schedule.create', target: 'SCALE-CONTOSO-PROD/Weekend', outcome: 'success' });
  });

  it('404s when no scaling plan is associated with the host pool', async () => {
    resolveCurrentScalingPlanRef.mockResolvedValue(null);
    const response = await scalingScheduleCreate(makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() } }), makeContext());
    expect(response.status).toBe(404);
    expect(response.jsonBody).toMatchObject({ code: 'scaling_plan_not_found' });
  });

  it('maps a 403 from ARM create to scaling_schedule_create_forbidden and writes a failure audit row', async () => {
    createScalingSchedule.mockRejectedValue(Object.assign(new Error('AuthorizationFailed'), { statusCode: 403 }));
    isForbiddenError.mockReturnValue(true);
    const response = await scalingScheduleCreate(makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() } }), makeContext());
    expect(response.status).toBe(403);
    const [event] = writeAuditEntry.mock.calls.at(-1)!;
    expect(event.outcome).toBe('failure');
  });

  it('maps a 400 from ARM (isBadRequestError) to a 400 WITHOUT echoing ARM\'s raw message (AM-15/M7 sweep — CWE-532)', async () => {
    createScalingSchedule.mockRejectedValue(new Error('ARM: invalid schedule configuration'));
    isBadRequestError.mockReturnValue(true);
    const response = await scalingScheduleCreate(makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() } }), makeContext());
    expect(response.status).toBe(400);
    expect(response.jsonBody).toMatchObject({ code: 'scaling_schedule_create_rejected' });
    const body = response.jsonBody as { message: string };
    expect(body.message).not.toContain('invalid schedule configuration');
  });
});
