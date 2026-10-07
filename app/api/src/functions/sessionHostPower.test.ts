import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HttpRequest, InvocationContext } from '@azure/functions';

const resolveSessionHostVm = vi.fn();
const isNotFoundError = vi.fn().mockReturnValue(false);
const isForbiddenError = vi.fn().mockReturnValue(false);
const isConflictError = vi.fn().mockReturnValue(false);

class FakeVmResourceUnresolvableError extends Error {
  constructor(sessionHostName: string, reason?: string) {
    super(reason ?? `Session host "${sessionHostName}" has no resolvable VM resource id.`);
    this.name = 'VmResourceUnresolvableError';
  }
}

vi.mock('../services/avdService', () => ({
  resolveSessionHostVm: (...args: unknown[]) => resolveSessionHostVm(...args),
  isNotFoundError: (...args: unknown[]) => isNotFoundError(...args),
  isForbiddenError: (...args: unknown[]) => isForbiddenError(...args),
  isConflictError: (...args: unknown[]) => isConflictError(...args),
  VmResourceUnresolvableError: FakeVmResourceUnresolvableError,
}));

const beginVmPowerAction = vi.fn();
vi.mock('../services/computeService', () => ({
  beginVmPowerAction: (...args: unknown[]) => beginVmPowerAction(...args),
}));

const writeAuditEntry = vi.fn().mockResolvedValue(undefined);
const isAuditRequiredButMissing = vi.fn().mockReturnValue(false);
vi.mock('../lib/auditLog', () => ({
  writeAuditEntry: (...args: unknown[]) => writeAuditEntry(...args),
  isAuditRequiredButMissing: (...args: unknown[]) => isAuditRequiredButMissing(...args),
}));

// Imported AFTER the mocks above so the handler picks up the mocked modules.
const { sessionHostPower } = await import('./sessionHostPower');

interface FakeContext extends InvocationContext {
  warnings: string[];
  errors: unknown[];
  logs: string[];
}

function makeRequest(options: {
  headers?: Record<string, string>;
  hostPoolName?: string;
  sessionHostName?: string;
  body?: unknown;
  jsonThrows?: boolean;
}): HttpRequest {
  const { headers = {}, hostPoolName = 'HP-CONTOSO-PROD', sessionHostName = 'avd-con-0', body = { action: 'restart' }, jsonThrows = false } = options;
  const lower = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  return {
    url: 'https://func-example.azurewebsites.net/api/v1/hostpools/HP-CONTOSO-PROD/sessionhosts/avd-con-0/power',
    headers: { get: (name: string) => lower.get(name.toLowerCase()) ?? null },
    params: { hostPoolName, sessionHostName },
    json: async () => {
      if (jsonThrows) throw new Error('bad json');
      return body;
    },
  } as unknown as HttpRequest;
}

function makeContext(): FakeContext {
  const warnings: string[] = [];
  const errors: unknown[] = [];
  const logs: string[] = [];
  return {
    warn: (...args: unknown[]) => warnings.push(args.join(' ')),
    error: (...args: unknown[]) => errors.push(args),
    log: (...args: unknown[]) => logs.push(args.join(' ')),
    warnings,
    errors,
    logs,
  } as unknown as FakeContext;
}

function encodePrincipal(principal: unknown): string {
  return Buffer.from(JSON.stringify(principal), 'utf-8').toString('base64');
}

function operatorHeader(userDetails = 'operator@example.com', userId = 'entra-obj-id-op') {
  return encodePrincipal({ identityProvider: 'aad', userId, userDetails, userRoles: ['operator'] });
}

function viewerHeader() {
  return encodePrincipal({ identityProvider: 'aad', userId: 'u1', userDetails: 'viewer@example.com', userRoles: ['viewer'] });
}

/** Server-observed session count is deliberately non-zero and DIFFERENT from any client-supplied value the tests below send, so audit-parameter assertions can prove the two are recorded under distinct keys (AM-19 peer review item 1). */
const VM_TARGET = { resourceGroup: 'RG-AVD-HostPools', vmName: 'avd-con-0', activeSessions: 2 };

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  process.env.SUBSCRIPTION_ID = 'sub-id';
  process.env.RG_HOSTPOOLS = 'RG-AVD-HostPools';
  process.env.HOSTPOOL_NAME = 'HP-CONTOSO-PROD';
  delete process.env.REQUIRE_BACKEND_SECRET;
  resolveSessionHostVm.mockReset().mockResolvedValue(VM_TARGET);
  beginVmPowerAction.mockReset().mockResolvedValue(undefined);
  isNotFoundError.mockReset().mockReturnValue(false);
  isForbiddenError.mockReset().mockReturnValue(false);
  isConflictError.mockReset().mockReturnValue(false);
  writeAuditEntry.mockReset().mockResolvedValue(undefined);
  isAuditRequiredButMissing.mockReset().mockReturnValue(false);
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('sessionHostPower — role rejection path', () => {
  it('returns 403 and never calls the service or writes an audit row for a viewer', async () => {
    const context = makeContext();
    const response = await sessionHostPower(makeRequest({ headers: { 'x-ms-client-principal': viewerHeader() } }), context);

    expect(response.status).toBe(403);
    expect(resolveSessionHostVm).not.toHaveBeenCalled();
    expect(beginVmPowerAction).not.toHaveBeenCalled();
    expect(writeAuditEntry).not.toHaveBeenCalled();
  });

  it('returns 401 and never calls the service for an unauthenticated caller', async () => {
    const context = makeContext();
    const response = await sessionHostPower(makeRequest({}), context);

    expect(response.status).toBe(401);
    expect(resolveSessionHostVm).not.toHaveBeenCalled();
    expect(writeAuditEntry).not.toHaveBeenCalled();
  });
});

describe('sessionHostPower — validation', () => {
  it('returns 400 when action is missing', async () => {
    const context = makeContext();
    const response = await sessionHostPower(
      makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() }, body: {} }),
      context,
    );

    expect(response.status).toBe(400);
    expect(response.jsonBody).toMatchObject({ code: 'invalid_action' });
    expect(beginVmPowerAction).not.toHaveBeenCalled();
  });

  it('returns 400 when action is not one of start/restart/deallocate', async () => {
    const context = makeContext();
    const response = await sessionHostPower(
      makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() }, body: { action: 'delete' } }),
      context,
    );

    expect(response.status).toBe(400);
    expect(response.jsonBody).toMatchObject({ code: 'invalid_action' });
    expect(beginVmPowerAction).not.toHaveBeenCalled();
  });

  it('returns 404 when hostPoolName does not match the configured/managed host pool', async () => {
    const context = makeContext();
    const response = await sessionHostPower(
      makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() }, hostPoolName: 'HP-SOME-OTHER-POOL' }),
      context,
    );

    expect(response.status).toBe(404);
    expect(beginVmPowerAction).not.toHaveBeenCalled();
  });

  it('returns 400 when reason exceeds 1000 characters, and does not call the service or write an audit row', async () => {
    const context = makeContext();
    const response = await sessionHostPower(
      makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() }, body: { action: 'restart', reason: 'x'.repeat(1001) } }),
      context,
    );

    expect(response.status).toBe(400);
    expect(response.jsonBody).toMatchObject({ code: 'reason_too_long' });
    expect(beginVmPowerAction).not.toHaveBeenCalled();
    expect(writeAuditEntry).not.toHaveBeenCalled();
  });

  it('returns 400 for a negative activeSessions', async () => {
    const context = makeContext();
    const response = await sessionHostPower(
      makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() }, body: { action: 'restart', activeSessions: -1 } }),
      context,
    );

    expect(response.status).toBe(400);
    expect(response.jsonBody).toMatchObject({ code: 'invalid_active_sessions' });
    expect(beginVmPowerAction).not.toHaveBeenCalled();
  });

  it('returns 400 for a non-integer activeSessions', async () => {
    const context = makeContext();
    const response = await sessionHostPower(
      makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() }, body: { action: 'restart', activeSessions: 1.5 } }),
      context,
    );

    expect(response.status).toBe(400);
    expect(response.jsonBody).toMatchObject({ code: 'invalid_active_sessions' });
  });

  it('returns 400 for an empty sessionHostName route param', async () => {
    const context = makeContext();
    const response = await sessionHostPower(
      makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() }, sessionHostName: '' }),
      context,
    );

    expect(response.status).toBe(400);
    expect(beginVmPowerAction).not.toHaveBeenCalled();
  });

  it('returns 400 for a sessionHostName containing an invalid character (e.g. a path separator)', async () => {
    const context = makeContext();
    const response = await sessionHostPower(
      makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() }, sessionHostName: '../etc/passwd' }),
      context,
    );

    expect(response.status).toBe(400);
    expect(response.jsonBody).toMatchObject({ code: 'invalid_session_host_name' });
    expect(beginVmPowerAction).not.toHaveBeenCalled();
  });

  it('returns 400 for a malformed JSON body', async () => {
    const context = makeContext();
    const response = await sessionHostPower(
      makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() }, jsonThrows: true }),
      context,
    );

    expect(response.status).toBe(400);
    expect(response.jsonBody).toMatchObject({ code: 'invalid_request_body' });
  });
});

describe('sessionHostPower — fail-closed audit posture', () => {
  it('returns 500 and never calls the service when audit is required but not configured', async () => {
    isAuditRequiredButMissing.mockReturnValue(true);
    const context = makeContext();

    const response = await sessionHostPower(makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() } }), context);

    expect(response.status).toBe(500);
    expect(response.jsonBody).toMatchObject({ code: 'audit_not_configured' });
    expect(beginVmPowerAction).not.toHaveBeenCalled();
    expect(writeAuditEntry).not.toHaveBeenCalled();
    expect(context.errors.some((e) => String(e).includes('AUDIT_MISCONFIGURED'))).toBe(true);
  });

  it('still returns 400 for a malformed request even when audit is unavailable (validation happens first)', async () => {
    isAuditRequiredButMissing.mockReturnValue(true);
    const context = makeContext();

    const response = await sessionHostPower(
      makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() }, body: { action: 'nope' } }),
      context,
    );

    expect(response.status).toBe(400);
  });
});

describe('sessionHostPower — happy path (per action)', () => {
  it.each(['start', 'restart', 'deallocate'] as const)('%s: resolves the VM, calls beginVmPowerAction, returns 202 accepted with a correlationId, and writes an accepted audit row', async (action) => {
    const context = makeContext();

    const response = await sessionHostPower(
      makeRequest({
        headers: { 'x-ms-client-principal': operatorHeader('op@example.com', 'entra-obj-op-1') },
        body: { action, reason: 'maintenance' },
      }),
      context,
    );

    expect(response.status).toBe(202);
    expect(response.jsonBody).toEqual({ status: 'accepted', action, sessionHostName: 'avd-con-0', correlationId: expect.any(String) });
    expect(resolveSessionHostVm).toHaveBeenCalledWith('HP-CONTOSO-PROD', 'avd-con-0');
    expect(beginVmPowerAction).toHaveBeenCalledWith(VM_TARGET.resourceGroup, VM_TARGET.vmName, action);

    expect(writeAuditEntry).toHaveBeenCalledTimes(1);
    const [event] = writeAuditEntry.mock.calls[0];
    expect(event).toMatchObject({
      actor: 'op@example.com',
      actorId: 'entra-obj-op-1',
      action: 'sessionhost.power',
      target: 'HP-CONTOSO-PROD/avd-con-0',
      parameters: { action, activeSessions: VM_TARGET.activeSessions, resourceGroup: VM_TARGET.resourceGroup, vmName: VM_TARGET.vmName },
      reason: 'maintenance',
      outcome: 'accepted',
    });
    expect(typeof event.correlationId).toBe('string');
    expect(event.correlationId.length).toBeGreaterThan(0);
    // Response and audit row reference the SAME correlationId (item 6).
    expect((response.jsonBody as { correlationId: string }).correlationId).toBe(event.correlationId);

    expect(context.logs.some((l) => l.includes('sessionhost power action accepted') && l.includes(event.correlationId))).toBe(true);
  });

  it('AM-19 peer review item 1 — audit integrity: records the SERVER-OBSERVED session count under `activeSessions` and the CLIENT-supplied value separately under `clientReportedActiveSessions`, even when the client understates it', async () => {
    const context = makeContext();

    // Client claims 0 active sessions while ARM (via resolveSessionHostVm, VM_TARGET.activeSessions=2) says otherwise.
    await sessionHostPower(
      makeRequest({
        headers: { 'x-ms-client-principal': operatorHeader() },
        body: { action: 'deallocate', activeSessions: 0 },
      }),
      context,
    );

    const [event] = writeAuditEntry.mock.calls[0];
    expect(event.parameters).toEqual({
      action: 'deallocate',
      clientReportedActiveSessions: 0,
      activeSessions: VM_TARGET.activeSessions,
      resourceGroup: VM_TARGET.resourceGroup,
      vmName: VM_TARGET.vmName,
    });
    // The two counts must be distinguishable in the row, not merged/overwritten.
    expect(event.parameters.activeSessions).not.toBe(event.parameters.clientReportedActiveSessions);
  });

  it('omits clientReportedActiveSessions from audit parameters when the caller does not send activeSessions, but still records the server-observed activeSessions', async () => {
    const context = makeContext();

    await sessionHostPower(
      makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() }, body: { action: 'start' } }),
      context,
    );

    const [event] = writeAuditEntry.mock.calls[0];
    expect(event.parameters).toEqual({
      action: 'start',
      activeSessions: VM_TARGET.activeSessions,
      resourceGroup: VM_TARGET.resourceGroup,
      vmName: VM_TARGET.vmName,
    });
    expect(event.parameters).not.toHaveProperty('clientReportedActiveSessions');
  });

  it('allows an admin too (admin is above operator in the hierarchy)', async () => {
    const context = makeContext();
    const header = encodePrincipal({ identityProvider: 'aad', userId: 'u3', userDetails: 'admin@example.com', userRoles: ['admin'] });

    const response = await sessionHostPower(
      makeRequest({ headers: { 'x-ms-client-principal': header }, body: { action: 'start' } }),
      context,
    );

    expect(response.status).toBe(202);
  });

  it('does NOT block a restart/deallocate when the server-observed activeSessions > 0 — server enforces no session-count gate (operator judgment)', async () => {
    const context = makeContext();

    const response = await sessionHostPower(
      makeRequest({
        headers: { 'x-ms-client-principal': operatorHeader() },
        body: { action: 'restart', activeSessions: 5 },
      }),
      context,
    );

    expect(response.status).toBe(202);
    expect(beginVmPowerAction).toHaveBeenCalled();
  });
});

describe('sessionHostPower — audit failure does not mask the accepted outcome', () => {
  it('still returns 202 when writeAuditEntry rejects (it should never throw in practice — this proves the handler survives it anyway)', async () => {
    writeAuditEntry.mockRejectedValueOnce(new Error('table unreachable'));
    const context = makeContext();

    const response = await sessionHostPower(
      makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() }, body: { action: 'start' } }),
      context,
    );

    expect(beginVmPowerAction).toHaveBeenCalled();
    expect(response.status).toBe(202);
    expect(context.warnings.some((w) => w.includes('audit write threw unexpectedly'))).toBe(true);
  });
});

describe('sessionHostPower — resolve-phase failures', () => {
  it('maps a not-found ARM error (from resolveSessionHostVm) to a 404 session_host_not_found and still writes a failure audit row', async () => {
    const notFound = Object.assign(new Error('not found'), { statusCode: 404 });
    resolveSessionHostVm.mockRejectedValue(notFound);
    isNotFoundError.mockReturnValue(true);
    const context = makeContext();

    const response = await sessionHostPower(makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() } }), context);

    expect(response.status).toBe(404);
    expect(response.jsonBody).toMatchObject({ code: 'session_host_not_found' });
    expect(beginVmPowerAction).not.toHaveBeenCalled();
    expect(writeAuditEntry).toHaveBeenCalledTimes(1);
    const [event] = writeAuditEntry.mock.calls[0];
    expect(event.outcome).toBe('failure');
    // Resolve never succeeded, so there's no resourceGroup/vmName/server activeSessions to record.
    expect(event.parameters).not.toHaveProperty('resourceGroup');
  });

  it('maps a VmResourceUnresolvableError to a distinct 502 (not the generic sessionhost_power_failed code)', async () => {
    resolveSessionHostVm.mockRejectedValue(new FakeVmResourceUnresolvableError('avd-con-0'));
    const context = makeContext();

    const response = await sessionHostPower(makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() } }), context);

    expect(response.status).toBe(502);
    expect(response.jsonBody).toMatchObject({ code: 'session_host_vm_unresolvable' });
    expect(beginVmPowerAction).not.toHaveBeenCalled();
  });

  it('maps an unexpected resolve-phase error to session_host_resolve_failed (distinct from the submit-phase generic fallback)', async () => {
    resolveSessionHostVm.mockRejectedValue(new Error('ARM transient error'));
    const context = makeContext();

    const response = await sessionHostPower(makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() } }), context);

    expect(response.status).toBe(502);
    expect(response.jsonBody).toMatchObject({ code: 'session_host_resolve_failed' });
    expect(beginVmPowerAction).not.toHaveBeenCalled();
  });
});

describe('sessionHostPower — submit-phase failures (AM-19 peer review item 2)', () => {
  it('writes a failure audit row (including the resolved resourceGroup/vmName) and returns 502 sessionhost_power_failed for a generic beginVmPowerAction rejection', async () => {
    beginVmPowerAction.mockRejectedValue(new Error('ARM timeout'));
    const context = makeContext();

    const response = await sessionHostPower(
      makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() }, body: { action: 'restart' } }),
      context,
    );

    expect(response.status).toBe(502);
    expect(response.jsonBody).toMatchObject({ code: 'sessionhost_power_failed' });
    expect(writeAuditEntry).toHaveBeenCalledTimes(1);
    const [event] = writeAuditEntry.mock.calls[0];
    expect(event).toMatchObject({
      outcome: 'failure',
      action: 'sessionhost.power',
      target: 'HP-CONTOSO-PROD/avd-con-0',
      detail: 'ARM timeout',
      parameters: { resourceGroup: VM_TARGET.resourceGroup, vmName: VM_TARGET.vmName, activeSessions: VM_TARGET.activeSessions },
    });
    const jsonBody = response.jsonBody as { details?: { correlationId?: string } };
    expect(jsonBody.details?.correlationId).toBe(event.correlationId);
  });

  it('maps a 404 from beginVmPowerAction (submit phase — VM deleted out-of-band) to session_host_vm_not_found, NOT the resolve-phase session_host_not_found code', async () => {
    const vmNotFound = Object.assign(new Error('vm not found'), { statusCode: 404 });
    beginVmPowerAction.mockRejectedValue(vmNotFound);
    isNotFoundError.mockReturnValue(true);
    const context = makeContext();

    const response = await sessionHostPower(makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() } }), context);

    expect(response.status).toBe(404);
    expect(response.jsonBody).toMatchObject({ code: 'session_host_vm_not_found' });
    expect(resolveSessionHostVm).toHaveBeenCalled();
    const [event] = writeAuditEntry.mock.calls[0];
    expect(event.outcome).toBe('failure');
  });

  it('maps a 403 from beginVmPowerAction to vm_power_action_forbidden with a role-propagation-aware message', async () => {
    const forbidden = Object.assign(new Error('AuthorizationFailed'), { statusCode: 403 });
    beginVmPowerAction.mockRejectedValue(forbidden);
    isForbiddenError.mockReturnValue(true);
    const context = makeContext();

    const response = await sessionHostPower(makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() } }), context);

    expect(response.status).toBe(403);
    expect(response.jsonBody).toMatchObject({ code: 'vm_power_action_forbidden' });
    const jsonBody = response.jsonBody as { message: string };
    expect(jsonBody.message).toMatch(/role assignment/i);
  });

  it('maps a 409 from beginVmPowerAction to vm_power_action_conflict', async () => {
    const conflict = Object.assign(new Error('conflicting operation'), { statusCode: 409 });
    beginVmPowerAction.mockRejectedValue(conflict);
    isConflictError.mockReturnValue(true);
    const context = makeContext();

    const response = await sessionHostPower(makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() } }), context);

    expect(response.status).toBe(409);
    expect(response.jsonBody).toMatchObject({ code: 'vm_power_action_conflict' });
  });
});
