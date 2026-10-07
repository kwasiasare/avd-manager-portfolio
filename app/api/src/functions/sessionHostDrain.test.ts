import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HttpRequest, InvocationContext } from '@azure/functions';
import type { SessionHost } from '@avdmgr/shared';

const setSessionHostDrain = vi.fn();
const isNotFoundError = vi.fn().mockReturnValue(false);
vi.mock('../services/avdService', () => ({
  setSessionHostDrain: (...args: unknown[]) => setSessionHostDrain(...args),
  isNotFoundError: (...args: unknown[]) => isNotFoundError(...args),
}));

const writeAuditEntry = vi.fn().mockResolvedValue(undefined);
const isAuditRequiredButMissing = vi.fn().mockReturnValue(false);
vi.mock('../lib/auditLog', () => ({
  writeAuditEntry: (...args: unknown[]) => writeAuditEntry(...args),
  isAuditRequiredButMissing: (...args: unknown[]) => isAuditRequiredButMissing(...args),
}));

// Imported AFTER the mocks above so the handler picks up the mocked modules.
const { sessionHostDrain } = await import('./sessionHostDrain');

interface FakeContext extends InvocationContext {
  warnings: string[];
  errors: unknown[];
  logs: unknown[];
}

function makeRequest(options: {
  headers?: Record<string, string>;
  hostPoolName?: string;
  sessionHostName?: string;
  body?: unknown;
  jsonThrows?: boolean;
}): HttpRequest {
  const { headers = {}, hostPoolName = 'HP-CONTOSO-PROD', sessionHostName = 'avd-con-0', body = { allowNewSession: false }, jsonThrows = false } = options;
  const lower = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  return {
    url: 'https://func-example.azurewebsites.net/api/v1/hostpools/HP-CONTOSO-PROD/sessionhosts/avd-con-0/drain',
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
  const logs: unknown[] = [];
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

function fakeSessionHost(overrides: Partial<SessionHost> = {}): SessionHost {
  return {
    id: 'id',
    name: 'avd-con-0',
    hostPoolName: 'HP-CONTOSO-PROD',
    status: 'Available',
    allowNewSession: false,
    activeSessions: 0,
    powerState: 'unknown',
    ...overrides,
  };
}

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  process.env.SUBSCRIPTION_ID = 'sub-id';
  process.env.RG_HOSTPOOLS = 'RG-AVD-HostPools';
  process.env.HOSTPOOL_NAME = 'HP-CONTOSO-PROD';
  delete process.env.REQUIRE_BACKEND_SECRET;
  setSessionHostDrain.mockReset();
  isNotFoundError.mockReset().mockReturnValue(false);
  writeAuditEntry.mockReset().mockResolvedValue(undefined);
  isAuditRequiredButMissing.mockReset().mockReturnValue(false);
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('sessionHostDrain — role rejection path', () => {
  it('returns 403 and never calls the service or writes an audit row for a viewer', async () => {
    const context = makeContext();
    const response = await sessionHostDrain(makeRequest({ headers: { 'x-ms-client-principal': viewerHeader() } }), context);

    expect(response.status).toBe(403);
    expect(setSessionHostDrain).not.toHaveBeenCalled();
    expect(writeAuditEntry).not.toHaveBeenCalled();
  });

  it('returns 401 and never calls the service for an unauthenticated caller', async () => {
    const context = makeContext();
    const response = await sessionHostDrain(makeRequest({}), context);

    expect(response.status).toBe(401);
    expect(setSessionHostDrain).not.toHaveBeenCalled();
    expect(writeAuditEntry).not.toHaveBeenCalled();
  });
});

describe('sessionHostDrain — validation', () => {
  it('returns 400 when allowNewSession is missing/not boolean', async () => {
    const context = makeContext();
    const response = await sessionHostDrain(
      makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() }, body: { allowNewSession: 'nope' } }),
      context,
    );

    expect(response.status).toBe(400);
    expect(setSessionHostDrain).not.toHaveBeenCalled();
  });

  it('returns 404 when hostPoolName does not match the configured/managed host pool', async () => {
    const context = makeContext();
    const response = await sessionHostDrain(
      makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() }, hostPoolName: 'HP-SOME-OTHER-POOL' }),
      context,
    );

    expect(response.status).toBe(404);
    expect(setSessionHostDrain).not.toHaveBeenCalled();
  });

  it('returns 400 when reason exceeds 1000 characters, and does not call the service or write an audit row', async () => {
    const context = makeContext();
    const response = await sessionHostDrain(
      makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() }, body: { allowNewSession: false, reason: 'x'.repeat(1001) } }),
      context,
    );

    expect(response.status).toBe(400);
    expect(response.jsonBody).toMatchObject({ code: 'reason_too_long' });
    expect(setSessionHostDrain).not.toHaveBeenCalled();
    expect(writeAuditEntry).not.toHaveBeenCalled();
  });

  it('accepts a reason at exactly the 1000-character bound', async () => {
    setSessionHostDrain.mockResolvedValue(fakeSessionHost());
    const context = makeContext();
    const response = await sessionHostDrain(
      makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() }, body: { allowNewSession: false, reason: 'x'.repeat(1000) } }),
      context,
    );

    expect(response.status).toBe(200);
  });

  it('returns 400 for an empty sessionHostName route param', async () => {
    const context = makeContext();
    const response = await sessionHostDrain(
      makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() }, sessionHostName: '' }),
      context,
    );

    expect(response.status).toBe(400);
    expect(setSessionHostDrain).not.toHaveBeenCalled();
  });

  it('returns 400 for a sessionHostName containing an invalid character (e.g. a path separator)', async () => {
    const context = makeContext();
    const response = await sessionHostDrain(
      makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() }, sessionHostName: '../etc/passwd' }),
      context,
    );

    expect(response.status).toBe(400);
    expect(response.jsonBody).toMatchObject({ code: 'invalid_session_host_name' });
    expect(setSessionHostDrain).not.toHaveBeenCalled();
  });

  it('accepts a dotted FQDN-style sessionHostName (domain-joined pools register the full computer name)', async () => {
    setSessionHostDrain.mockResolvedValue(fakeSessionHost({ name: 'avd-con-0.contoso.local' }));
    const context = makeContext();
    const response = await sessionHostDrain(
      makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() }, sessionHostName: 'avd-con-0.contoso.local' }),
      context,
    );

    expect(response.status).toBe(200);
    expect(setSessionHostDrain).toHaveBeenCalledWith('HP-CONTOSO-PROD', 'avd-con-0.contoso.local', false);
  });
});

describe('sessionHostDrain — fail-closed audit posture (AM-18 review item 8)', () => {
  it('returns 500 and never calls the service when audit is required but not configured', async () => {
    isAuditRequiredButMissing.mockReturnValue(true);
    const context = makeContext();

    const response = await sessionHostDrain(makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() } }), context);

    expect(response.status).toBe(500);
    expect(response.jsonBody).toMatchObject({ code: 'audit_not_configured' });
    expect(setSessionHostDrain).not.toHaveBeenCalled();
    expect(writeAuditEntry).not.toHaveBeenCalled();
    expect(context.errors.some((e) => String(e).includes('AUDIT_MISCONFIGURED'))).toBe(true);
  });

  it('still returns 400 for a malformed request even when audit is unavailable (validation happens first)', async () => {
    isAuditRequiredButMissing.mockReturnValue(true);
    const context = makeContext();

    const response = await sessionHostDrain(
      makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() }, body: { allowNewSession: 'nope' } }),
      context,
    );

    expect(response.status).toBe(400);
  });
});

describe('sessionHostDrain — happy path', () => {
  it('calls the service, returns the updated host, and writes a success audit row with actorId, parameters, and correlationId', async () => {
    setSessionHostDrain.mockResolvedValue(fakeSessionHost({ allowNewSession: false }));
    const context = makeContext();

    const response = await sessionHostDrain(
      makeRequest({
        headers: { 'x-ms-client-principal': operatorHeader('op@example.com', 'entra-obj-op-1') },
        body: { allowNewSession: false, reason: 'patching' },
      }),
      context,
    );

    expect(response.status).toBe(200);
    expect(response.jsonBody).toEqual({ sessionHost: fakeSessionHost({ allowNewSession: false }) });
    expect(setSessionHostDrain).toHaveBeenCalledWith('HP-CONTOSO-PROD', 'avd-con-0', false);

    expect(writeAuditEntry).toHaveBeenCalledTimes(1);
    const [event] = writeAuditEntry.mock.calls[0];
    expect(event).toMatchObject({
      actor: 'op@example.com',
      actorId: 'entra-obj-op-1',
      action: 'sessionhost.drain',
      target: 'HP-CONTOSO-PROD/avd-con-0',
      parameters: { allowNewSession: false },
      reason: 'patching',
      outcome: 'success',
    });
    expect(typeof event.correlationId).toBe('string');
    expect(event.correlationId.length).toBeGreaterThan(0);
  });

  it('records parameters.allowNewSession: true distinctly for a resume', async () => {
    setSessionHostDrain.mockResolvedValue(fakeSessionHost({ allowNewSession: true }));
    const context = makeContext();

    await sessionHostDrain(
      makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() }, body: { allowNewSession: true } }),
      context,
    );

    const [event] = writeAuditEntry.mock.calls[0];
    expect(event.parameters).toEqual({ allowNewSession: true });
  });

  it('allows an admin too (admin is above operator in the hierarchy)', async () => {
    setSessionHostDrain.mockResolvedValue(fakeSessionHost());
    const context = makeContext();
    const header = encodePrincipal({ identityProvider: 'aad', userId: 'u3', userDetails: 'admin@example.com', userRoles: ['admin'] });

    const response = await sessionHostDrain(makeRequest({ headers: { 'x-ms-client-principal': header } }), context);

    expect(response.status).toBe(200);
  });
});

describe('sessionHostDrain — audit failure does not mask mutation outcome', () => {
  it('still returns 200 with the updated host when writeAuditEntry rejects (it should never throw in practice — this proves the handler survives it anyway)', async () => {
    setSessionHostDrain.mockResolvedValue(fakeSessionHost({ allowNewSession: false }));
    writeAuditEntry.mockRejectedValueOnce(new Error('table unreachable'));
    const context = makeContext();

    const response = await sessionHostDrain(
      makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() } }),
      context,
    );

    expect(setSessionHostDrain).toHaveBeenCalled();
    expect(response.status).toBe(200);
    expect(response.jsonBody).toEqual({ sessionHost: fakeSessionHost({ allowNewSession: false }) });
    expect(context.warnings.some((w) => w.includes('audit write threw unexpectedly'))).toBe(true);
  });

  it('writes a failure audit row (with detail and correlationId) and returns 502 when the service call itself fails', async () => {
    setSessionHostDrain.mockRejectedValue(new Error('ARM timeout'));
    const context = makeContext();

    const response = await sessionHostDrain(makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() } }), context);

    expect(response.status).toBe(502);
    expect(response.jsonBody).toMatchObject({ code: 'sessionhost_drain_failed' });
    expect(writeAuditEntry).toHaveBeenCalledTimes(1);
    const [event] = writeAuditEntry.mock.calls[0];
    expect(event).toMatchObject({ outcome: 'failure', action: 'sessionhost.drain', target: 'HP-CONTOSO-PROD/avd-con-0', detail: 'ARM timeout' });
    expect(typeof event.correlationId).toBe('string');
    const jsonBody = response.jsonBody as { details?: { correlationId?: string } };
    expect(jsonBody.details?.correlationId).toBe(event.correlationId);
  });
});

describe('sessionHostDrain — ARM 404 mapping (AM-18 review item 9)', () => {
  it('maps a not-found ARM error to a 404 response (not the generic 502) and still writes a failure audit row', async () => {
    const notFound = Object.assign(new Error('not found'), { statusCode: 404 });
    setSessionHostDrain.mockRejectedValue(notFound);
    isNotFoundError.mockReturnValue(true);
    const context = makeContext();

    const response = await sessionHostDrain(makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() } }), context);

    expect(response.status).toBe(404);
    expect(response.jsonBody).toMatchObject({ code: 'session_host_not_found' });
    expect(writeAuditEntry).toHaveBeenCalledTimes(1);
    const [event] = writeAuditEntry.mock.calls[0];
    expect(event.outcome).toBe('failure');
  });
});
