import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HttpRequest, InvocationContext } from '@azure/functions';

const resolveCurrentScalingPlanRef = vi.fn();
const setScalingPlanHostPoolEnabled = vi.fn();
vi.mock('../services/avdService', () => ({
  resolveCurrentScalingPlanRef: (...args: unknown[]) => resolveCurrentScalingPlanRef(...args),
  setScalingPlanHostPoolEnabled: (...args: unknown[]) => setScalingPlanHostPoolEnabled(...args),
}));

const getScalingOverride = vi.fn();
const createScalingOverride = vi.fn();
const replaceScalingOverride = vi.fn();
const isOverrideStoreRequiredButMissing = vi.fn().mockReturnValue(false);
vi.mock('../services/scalingOverrideService', async () => {
  const actual = await vi.importActual<typeof import('../services/scalingOverrideService')>('../services/scalingOverrideService');
  return {
    ...actual,
    getScalingOverride: (...args: unknown[]) => getScalingOverride(...args),
    createScalingOverride: (...args: unknown[]) => createScalingOverride(...args),
    replaceScalingOverride: (...args: unknown[]) => replaceScalingOverride(...args),
    isOverrideStoreRequiredButMissing: (...args: unknown[]) => isOverrideStoreRequiredButMissing(...args),
    // isConflictError / isPreconditionFailedError / computeOverrideStatus are
    // the REAL implementations (statusCode-based / pure) — no need to mock them.
  };
});

const writeAuditEntry = vi.fn().mockResolvedValue(undefined);
const isAuditRequiredButMissing = vi.fn().mockReturnValue(false);
vi.mock('../lib/auditLog', () => ({
  writeAuditEntry: (...args: unknown[]) => writeAuditEntry(...args),
  isAuditRequiredButMissing: (...args: unknown[]) => isAuditRequiredButMissing(...args),
}));

const { scalingEmergencyOverrideActivate, scalingEmergencyOverrideCancel, scalingEmergencyOverrideStatus, scalingEmergencyOverrideDispatch } = await import('./scalingEmergencyOverride');

function makeContext(): InvocationContext & { errors: unknown[] } {
  const errors: unknown[] = [];
  return { warn: () => {}, error: (...a: unknown[]) => errors.push(a), log: () => {}, errors } as unknown as InvocationContext & { errors: unknown[] };
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

function makeRequest(options: { method?: string; headers?: Record<string, string>; body?: unknown; jsonThrows?: boolean } = {}): HttpRequest {
  const { method = 'POST', headers = {}, body = { minutes: 60, reason: 'planned network maintenance' }, jsonThrows = false } = options;
  const lower = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    method,
    url: 'https://func-example.azurewebsites.net/api/v1/scalingplans/current/emergency-override',
    headers: { get: (name: string) => lower.get(name.toLowerCase()) ?? null },
    params: {},
    json: async () => {
      if (jsonThrows) throw new Error('bad json');
      return body;
    },
  } as unknown as HttpRequest;
}

const PLAN_REF = { scalingPlanName: 'SCALE-CONTOSO-PROD', resourceGroup: 'RG-AVD-HostPools', hostPoolId: '/subscriptions/sub/resourceGroups/RG-AVD-HostPools/providers/Microsoft.DesktopVirtualization/hostPools/HP-CONTOSO-PROD' };

const ACTIVE_ENTITY = {
  partitionKey: 'override',
  rowKey: 'current',
  active: true,
  activatedBy: 'op@example.com',
  activatedById: 'entra-op-1',
  activatedAt: '2026-08-15T12:00:00.000Z',
  expiresAt: '2026-08-15T13:00:00.000Z',
  minutes: 60,
  reason: 'planned network maintenance',
  scalingPlanName: 'SCALE-CONTOSO-PROD',
  resourceGroup: PLAN_REF.resourceGroup,
  hostPoolId: PLAN_REF.hostPoolId,
  correlationId: 'corr-orig',
  etag: 'W/"etag-orig"',
};

beforeEach(() => {
  resolveCurrentScalingPlanRef.mockReset().mockResolvedValue(PLAN_REF);
  setScalingPlanHostPoolEnabled.mockReset().mockResolvedValue([{ hostPoolArmPath: PLAN_REF.hostPoolId, scalingPlanEnabled: false }]);
  getScalingOverride.mockReset().mockResolvedValue(null);
  createScalingOverride.mockReset().mockResolvedValue(undefined);
  replaceScalingOverride.mockReset().mockResolvedValue(undefined);
  isOverrideStoreRequiredButMissing.mockReset().mockReturnValue(false);
  writeAuditEntry.mockReset().mockResolvedValue(undefined);
  isAuditRequiredButMissing.mockReset().mockReturnValue(false);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('scalingEmergencyOverrideStatus — GET, viewer-readable', () => {
  it('200s for a viewer', async () => {
    const response = await scalingEmergencyOverrideStatus(makeRequest({ method: 'GET', headers: { 'x-ms-client-principal': viewerHeader() } }), makeContext());
    expect(response.status).toBe(200);
    expect(response.jsonBody).toEqual({ active: false });
  });

  it('401s an unauthenticated caller', async () => {
    const response = await scalingEmergencyOverrideStatus(makeRequest({ method: 'GET' }), makeContext());
    expect(response.status).toBe(401);
  });

  it('reports active:true with minutesRemaining for an active override', async () => {
    getScalingOverride.mockResolvedValue(ACTIVE_ENTITY);
    const response = await scalingEmergencyOverrideStatus(makeRequest({ method: 'GET', headers: { 'x-ms-client-principal': viewerHeader() } }), makeContext());
    expect(response.status).toBe(200);
    expect((response.jsonBody as { active: boolean }).active).toBe(true);
  });
});

describe('scalingEmergencyOverrideActivate — role rejection', () => {
  it('403s a viewer and never touches ARM/table', async () => {
    const response = await scalingEmergencyOverrideActivate(makeRequest({ headers: { 'x-ms-client-principal': viewerHeader() } }), makeContext());
    expect(response.status).toBe(403);
    expect(setScalingPlanHostPoolEnabled).not.toHaveBeenCalled();
    expect(createScalingOverride).not.toHaveBeenCalled();
  });
});

describe('scalingEmergencyOverrideActivate — validation', () => {
  it('400s when minutes is below the minimum (15)', async () => {
    const response = await scalingEmergencyOverrideActivate(makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() }, body: { minutes: 10, reason: 'x' } }), makeContext());
    expect(response.status).toBe(400);
    expect(response.jsonBody).toMatchObject({ code: 'invalid_minutes' });
  });

  it('400s when minutes exceeds the maximum (480)', async () => {
    const response = await scalingEmergencyOverrideActivate(makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() }, body: { minutes: 481, reason: 'x' } }), makeContext());
    expect(response.status).toBe(400);
  });

  it('400s when reason is missing — MANDATORY, unlike routine schedule edits', async () => {
    const response = await scalingEmergencyOverrideActivate(makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() }, body: { minutes: 60 } }), makeContext());
    expect(response.status).toBe(400);
    expect(response.jsonBody).toMatchObject({ code: 'missing_reason' });
    expect(setScalingPlanHostPoolEnabled).not.toHaveBeenCalled();
  });

  it('400s when reason is an empty/whitespace-only string', async () => {
    const response = await scalingEmergencyOverrideActivate(makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() }, body: { minutes: 60, reason: '   ' } }), makeContext());
    expect(response.status).toBe(400);
    expect(response.jsonBody).toMatchObject({ code: 'missing_reason' });
  });
});

describe('scalingEmergencyOverrideActivate — happy path (fresh activation, no prior row)', () => {
  it('disables the plan for the host pool, creates the override row, returns 200 active:true, and audits with the reason + minutes', async () => {
    const response = await scalingEmergencyOverrideActivate(makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() } }), makeContext());

    expect(response.status).toBe(200);
    expect(setScalingPlanHostPoolEnabled).toHaveBeenCalledWith('RG-AVD-HostPools', 'SCALE-CONTOSO-PROD', PLAN_REF.hostPoolId, false);
    expect(createScalingOverride).toHaveBeenCalledWith(expect.objectContaining({ active: true, minutes: 60, reason: 'planned network maintenance', activatedBy: 'op@example.com', resourceGroup: 'RG-AVD-HostPools' }));
    expect(replaceScalingOverride).not.toHaveBeenCalled();

    const body = response.jsonBody as { active: boolean; minutesRemaining?: number };
    expect(body.active).toBe(true);
    expect(body.minutesRemaining).toBe(60);

    const [event] = writeAuditEntry.mock.calls[0];
    expect(event).toMatchObject({ action: 'scalingplan.emergency_override.activate', outcome: 'success', reason: 'planned network maintenance' });
    expect(event.parameters).toMatchObject({ minutes: 60 });
  });

  it('rolls back the ARM disable if persisting the override row fails, and returns 502', async () => {
    createScalingOverride.mockRejectedValue(new Error('table unreachable'));
    const response = await scalingEmergencyOverrideActivate(makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() } }), makeContext());

    expect(response.status).toBe(502);
    expect(response.jsonBody).toMatchObject({ code: 'emergency_override_state_write_failed' });
    // Called twice: once to disable, once to roll back (re-enable).
    expect(setScalingPlanHostPoolEnabled).toHaveBeenCalledTimes(2);
    expect(setScalingPlanHostPoolEnabled).toHaveBeenNthCalledWith(1, 'RG-AVD-HostPools', 'SCALE-CONTOSO-PROD', PLAN_REF.hostPoolId, false);
    expect(setScalingPlanHostPoolEnabled).toHaveBeenNthCalledWith(2, 'RG-AVD-HostPools', 'SCALE-CONTOSO-PROD', PLAN_REF.hostPoolId, true);
    const [event] = writeAuditEntry.mock.calls[0];
    expect(event.outcome).toBe('failure');
  });

  it('peer review MAJOR 3: returns a DISTINCT emergency_override_stranded error and logs SCALING_OVERRIDE_STRANDED when the ROLLBACK re-enable ALSO fails', async () => {
    createScalingOverride.mockRejectedValue(new Error('table unreachable'));
    setScalingPlanHostPoolEnabled.mockResolvedValueOnce([{ hostPoolArmPath: PLAN_REF.hostPoolId, scalingPlanEnabled: false }]).mockRejectedValueOnce(new Error('ARM also down'));
    const context = makeContext();

    const response = await scalingEmergencyOverrideActivate(makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() } }), context);

    expect(response.status).toBe(502);
    expect(response.jsonBody).toMatchObject({ code: 'emergency_override_stranded' });
    const body = response.jsonBody as { message: string };
    expect(body.message).toMatch(/disabled/i);
    expect(body.message).toMatch(/not.*restored|not restored/i);
    expect(context.errors.some((e) => String(e).includes('SCALING_OVERRIDE_STRANDED'))).toBe(true);
    const [event] = writeAuditEntry.mock.calls[0];
    expect(event.outcome).toBe('failure');
    expect(event.detail).toMatch(/STRANDED/);
  });

  it('500s fail-closed when the durable override store is required but not configured', async () => {
    isOverrideStoreRequiredButMissing.mockReturnValue(true);
    const response = await scalingEmergencyOverrideActivate(makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() } }), makeContext());
    expect(response.status).toBe(500);
    expect(setScalingPlanHostPoolEnabled).not.toHaveBeenCalled();
  });

  it('502s and audits failure if the ARM disable call itself fails', async () => {
    setScalingPlanHostPoolEnabled.mockRejectedValueOnce(new Error('ARM timeout'));
    const response = await scalingEmergencyOverrideActivate(makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() } }), makeContext());
    expect(response.status).toBe(502);
    expect(createScalingOverride).not.toHaveBeenCalled();
    const [event] = writeAuditEntry.mock.calls[0];
    expect(event.outcome).toBe('failure');
  });
});

describe('scalingEmergencyOverrideActivate — already active (peer review MAJOR 2)', () => {
  it('409s emergency_override_already_active WITHOUT extend, and never calls ARM/persists anything', async () => {
    getScalingOverride.mockResolvedValue(ACTIVE_ENTITY);
    const response = await scalingEmergencyOverrideActivate(makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() }, body: { minutes: 60, reason: 'x' } }), makeContext());

    expect(response.status).toBe(409);
    expect(response.jsonBody).toMatchObject({ code: 'emergency_override_already_active' });
    expect(setScalingPlanHostPoolEnabled).not.toHaveBeenCalled();
    expect(createScalingOverride).not.toHaveBeenCalled();
    expect(replaceScalingOverride).not.toHaveBeenCalled();
  });

  it('extend:true SKIPS the ARM call (already disabled), replaces the row with the NEW expiry, keeps the ORIGINAL activatedAt, and audits as extend', async () => {
    getScalingOverride.mockResolvedValue(ACTIVE_ENTITY);
    const response = await scalingEmergencyOverrideActivate(
      makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() }, body: { minutes: 120, reason: 'extending maintenance', extend: true } }),
      makeContext(),
    );

    expect(response.status).toBe(200);
    expect(setScalingPlanHostPoolEnabled).not.toHaveBeenCalled();
    expect(replaceScalingOverride).toHaveBeenCalledWith(expect.objectContaining({ minutes: 120, reason: 'extending maintenance', activatedAt: ACTIVE_ENTITY.activatedAt }), ACTIVE_ENTITY.etag);
    expect(createScalingOverride).not.toHaveBeenCalled();

    const [event] = writeAuditEntry.mock.calls[0];
    expect(event.action).toBe('scalingplan.emergency_override.extend');
    expect(event.parameters).toMatchObject({ minutes: 120, extend: true });
  });

  it('extend:true on an INACTIVE row behaves like a fresh activation (ARM disable called, activatedAt reset)', async () => {
    getScalingOverride.mockResolvedValue({ ...ACTIVE_ENTITY, active: false });
    const response = await scalingEmergencyOverrideActivate(
      makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() }, body: { minutes: 60, reason: 'x', extend: true } }),
      makeContext(),
    );
    expect(response.status).toBe(200);
    expect(setScalingPlanHostPoolEnabled).toHaveBeenCalled();
    expect(replaceScalingOverride).toHaveBeenCalledWith(expect.objectContaining({ activatedAt: expect.not.stringMatching(ACTIVE_ENTITY.activatedAt) }), expect.any(String));
  });
});

describe('scalingEmergencyOverrideActivate — write-conflict retry (peer review MAJOR 2)', () => {
  it('re-reads and retries on a 409 from createScalingOverride (someone else created the row first), succeeding once the second read shows an inactive row', async () => {
    getScalingOverride
      .mockResolvedValueOnce(null) // initial read: no row yet
      .mockResolvedValueOnce({ ...ACTIVE_ENTITY, active: false, etag: 'W/"etag-2"' }); // retry read: a row now exists but is inactive
    createScalingOverride.mockRejectedValueOnce(Object.assign(new Error('EntityAlreadyExists'), { statusCode: 409 }));
    replaceScalingOverride.mockResolvedValue(undefined);

    const response = await scalingEmergencyOverrideActivate(makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() } }), makeContext());

    expect(response.status).toBe(200);
    expect(createScalingOverride).toHaveBeenCalledTimes(1);
    expect(replaceScalingOverride).toHaveBeenCalledWith(expect.anything(), 'W/"etag-2"');
  });

  it('409s emergency_override_already_active (without rolling back ARM) if a retry read shows someone else WON an active row', async () => {
    getScalingOverride
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ ...ACTIVE_ENTITY, etag: 'W/"etag-winner"' }); // someone else's activation won
    createScalingOverride.mockRejectedValueOnce(Object.assign(new Error('EntityAlreadyExists'), { statusCode: 409 }));

    const response = await scalingEmergencyOverrideActivate(makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() } }), makeContext());

    expect(response.status).toBe(409);
    expect(response.jsonBody).toMatchObject({ code: 'emergency_override_already_active' });
    // ARM was disabled once (correct regardless of who "wins") but NOT rolled back — the winning activation needs it to stay disabled.
    expect(setScalingPlanHostPoolEnabled).toHaveBeenCalledTimes(1);
  });
});

describe('scalingEmergencyOverrideCancel — role rejection', () => {
  it('403s a viewer', async () => {
    const response = await scalingEmergencyOverrideCancel(makeRequest({ method: 'DELETE', headers: { 'x-ms-client-principal': viewerHeader() } }), makeContext());
    expect(response.status).toBe(403);
  });
});

describe('scalingEmergencyOverrideCancel', () => {
  it('404s when no override is currently active', async () => {
    getScalingOverride.mockResolvedValue(null);
    const response = await scalingEmergencyOverrideCancel(makeRequest({ method: 'DELETE', headers: { 'x-ms-client-principal': operatorHeader() } }), makeContext());
    expect(response.status).toBe(404);
    expect(response.jsonBody).toMatchObject({ code: 'emergency_override_not_active' });
    expect(setScalingPlanHostPoolEnabled).not.toHaveBeenCalled();
  });

  it('re-enables the plan (using the resourceGroup STORED ON THE ROW, not a fresh plan lookup), marks the row inactive via replaceScalingOverride+etag, returns 200 active:false, and audits with the REAL caller as actor (not system:auto-reenable)', async () => {
    getScalingOverride.mockResolvedValue(ACTIVE_ENTITY);
    const response = await scalingEmergencyOverrideCancel(makeRequest({ method: 'DELETE', headers: { 'x-ms-client-principal': operatorHeader() } }), makeContext());

    expect(response.status).toBe(200);
    expect(response.jsonBody).toEqual({ active: false });
    expect(resolveCurrentScalingPlanRef).not.toHaveBeenCalled();
    expect(setScalingPlanHostPoolEnabled).toHaveBeenCalledWith(ACTIVE_ENTITY.resourceGroup, 'SCALE-CONTOSO-PROD', PLAN_REF.hostPoolId, true);
    expect(replaceScalingOverride).toHaveBeenCalledWith(expect.objectContaining({ active: false }), ACTIVE_ENTITY.etag);

    const [event] = writeAuditEntry.mock.calls[0];
    expect(event.actor).toBe('op@example.com');
    expect(event.action).toBe('scalingplan.emergency_override.cancel');
    expect(event.outcome).toBe('success');
  });

  it('still succeeds (ARM already correctly re-enabled) even if the row write hits a 412 on every retry attempt', async () => {
    getScalingOverride.mockResolvedValue(ACTIVE_ENTITY);
    replaceScalingOverride.mockRejectedValue(Object.assign(new Error('PreconditionFailed'), { statusCode: 412 }));

    const response = await scalingEmergencyOverrideCancel(makeRequest({ method: 'DELETE', headers: { 'x-ms-client-principal': operatorHeader() } }), makeContext());

    expect(response.status).toBe(200);
    expect(setScalingPlanHostPoolEnabled).toHaveBeenCalledTimes(1);
  });
});

describe('scalingEmergencyOverrideDispatch', () => {
  it('routes GET/POST/DELETE correctly and 405s anything else', async () => {
    const get = await scalingEmergencyOverrideDispatch(makeRequest({ method: 'GET', headers: { 'x-ms-client-principal': viewerHeader() } }), makeContext());
    expect(get.status).toBe(200);

    getScalingOverride.mockResolvedValue(ACTIVE_ENTITY);
    const del = await scalingEmergencyOverrideDispatch(makeRequest({ method: 'DELETE', headers: { 'x-ms-client-principal': operatorHeader() } }), makeContext());
    expect(del.status).toBe(200);

    const other = await scalingEmergencyOverrideDispatch(makeRequest({ method: 'PATCH', headers: { 'x-ms-client-principal': operatorHeader() } }), makeContext());
    expect(other.status).toBe(405);
  });
});
