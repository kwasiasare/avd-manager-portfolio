import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HttpRequest, InvocationContext } from '@azure/functions';

const generateRegistrationToken = vi.fn();
const getRegistrationTokenStatus = vi.fn();
const isNotFoundError = vi.fn().mockReturnValue(false);
vi.mock('../services/avdService', () => ({
  generateRegistrationToken: (...args: unknown[]) => generateRegistrationToken(...args),
  getRegistrationTokenStatus: (...args: unknown[]) => getRegistrationTokenStatus(...args),
  isNotFoundError: (...args: unknown[]) => isNotFoundError(...args),
}));

const writeAuditEntry = vi.fn().mockResolvedValue(undefined);
const isAuditRequiredButMissing = vi.fn().mockReturnValue(false);
vi.mock('../lib/auditLog', () => ({
  writeAuditEntry: (...args: unknown[]) => writeAuditEntry(...args),
  isAuditRequiredButMissing: (...args: unknown[]) => isAuditRequiredButMissing(...args),
}));

// Imported AFTER the mocks above so the handlers pick up the mocked modules.
const { hostPoolRegistrationTokenGenerate, hostPoolRegistrationTokenStatus, hostPoolRegistrationTokenDispatch } = await import(
  './hostPoolRegistrationToken'
);

interface FakeContext extends InvocationContext {
  warnings: string[];
  errors: unknown[];
  logs: unknown[];
}

function makeRequest(options: {
  headers?: Record<string, string>;
  hostPoolName?: string;
  body?: unknown;
  jsonThrows?: boolean;
  method?: string;
}): HttpRequest {
  const { headers = {}, hostPoolName = 'HP-CONTOSO-PROD', body = { hoursValid: 8 }, jsonThrows = false, method = 'POST' } = options;
  const lower = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  return {
    method,
    url: 'https://func-example.azurewebsites.net/api/v1/hostpools/HP-CONTOSO-PROD/registration-token',
    headers: { get: (name: string) => lower.get(name.toLowerCase()) ?? null },
    params: { hostPoolName },
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

function adminHeader(userDetails = 'admin@example.com', userId = 'entra-obj-id-admin') {
  return encodePrincipal({ identityProvider: 'aad', userId, userDetails, userRoles: ['admin'] });
}

function operatorHeader(userDetails = 'operator@example.com', userId = 'entra-obj-id-op') {
  return encodePrincipal({ identityProvider: 'aad', userId, userDetails, userRoles: ['operator'] });
}

function viewerHeader() {
  return encodePrincipal({ identityProvider: 'aad', userId: 'u1', userDetails: 'viewer@example.com', userRoles: ['viewer'] });
}

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  process.env.SUBSCRIPTION_ID = 'sub-id';
  process.env.RG_HOSTPOOLS = 'RG-AVD-HostPools';
  process.env.HOSTPOOL_NAME = 'HP-CONTOSO-PROD';
  delete process.env.REQUIRE_BACKEND_SECRET;
  generateRegistrationToken.mockReset();
  getRegistrationTokenStatus.mockReset();
  isNotFoundError.mockReset().mockReturnValue(false);
  writeAuditEntry.mockReset().mockResolvedValue(undefined);
  isAuditRequiredButMissing.mockReset().mockReturnValue(false);
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('hostPoolRegistrationTokenGenerate — admin-only enforcement', () => {
  it('returns 403 and never calls the service or writes an audit row for an operator', async () => {
    const context = makeContext();
    const response = await hostPoolRegistrationTokenGenerate(makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() } }), context);

    expect(response.status).toBe(403);
    expect(generateRegistrationToken).not.toHaveBeenCalled();
    expect(writeAuditEntry).not.toHaveBeenCalled();
  });

  it('returns 403 for a viewer', async () => {
    const context = makeContext();
    const response = await hostPoolRegistrationTokenGenerate(makeRequest({ headers: { 'x-ms-client-principal': viewerHeader() } }), context);

    expect(response.status).toBe(403);
    expect(generateRegistrationToken).not.toHaveBeenCalled();
  });

  it('returns 401 for an unauthenticated caller', async () => {
    const context = makeContext();
    const response = await hostPoolRegistrationTokenGenerate(makeRequest({}), context);

    expect(response.status).toBe(401);
    expect(generateRegistrationToken).not.toHaveBeenCalled();
  });

  it('allows an admin', async () => {
    generateRegistrationToken.mockResolvedValue({ token: 'secret-token-value', expirationTime: '2026-08-16T00:00:00.000Z' });
    const context = makeContext();
    const response = await hostPoolRegistrationTokenGenerate(makeRequest({ headers: { 'x-ms-client-principal': adminHeader() } }), context);

    expect(response.status).toBe(200);
    expect(generateRegistrationToken).toHaveBeenCalledWith('HP-CONTOSO-PROD', 8);
  });

  it('returns Cache-Control: no-store on the token-bearing success response (Opus review item 8)', async () => {
    generateRegistrationToken.mockResolvedValue({ token: 'secret-token-value', expirationTime: '2026-08-16T00:00:00.000Z' });
    const context = makeContext();
    const response = await hostPoolRegistrationTokenGenerate(makeRequest({ headers: { 'x-ms-client-principal': adminHeader() } }), context);

    expect(response.headers).toMatchObject({ 'Cache-Control': 'no-store', Pragma: 'no-cache' });
  });
});

describe('hostPoolRegistrationTokenGenerate — hoursValid validation bounds', () => {
  it.each([
    ['missing', undefined],
    ['not a number', 'eight'],
    ['zero (below minimum)', 0],
    ['negative', -1],
    ['non-integer', 4.5],
    ['above the 648-hour maximum', 649],
  ])('returns 400 for hoursValid %s', async (_label, hoursValid) => {
    const context = makeContext();
    const response = await hostPoolRegistrationTokenGenerate(
      makeRequest({ headers: { 'x-ms-client-principal': adminHeader() }, body: { hoursValid } }),
      context,
    );

    expect(response.status).toBe(400);
    expect(response.jsonBody).toMatchObject({ code: 'invalid_hours_valid' });
    expect(generateRegistrationToken).not.toHaveBeenCalled();
  });

  it('accepts hoursValid at the lower bound (1)', async () => {
    generateRegistrationToken.mockResolvedValue({ token: 't', expirationTime: '2026-08-15T09:00:00.000Z' });
    const context = makeContext();
    const response = await hostPoolRegistrationTokenGenerate(
      makeRequest({ headers: { 'x-ms-client-principal': adminHeader() }, body: { hoursValid: 1 } }),
      context,
    );

    expect(response.status).toBe(200);
    expect(generateRegistrationToken).toHaveBeenCalledWith('HP-CONTOSO-PROD', 1);
  });

  it('accepts hoursValid at the upper bound (648 — Azure Virtual Desktop\'s 27-day maximum)', async () => {
    generateRegistrationToken.mockResolvedValue({ token: 't', expirationTime: '2026-09-11T09:00:00.000Z' });
    const context = makeContext();
    const response = await hostPoolRegistrationTokenGenerate(
      makeRequest({ headers: { 'x-ms-client-principal': adminHeader() }, body: { hoursValid: 648 } }),
      context,
    );

    expect(response.status).toBe(200);
    expect(generateRegistrationToken).toHaveBeenCalledWith('HP-CONTOSO-PROD', 648);
  });

  it('returns 400 for a malformed request body', async () => {
    const context = makeContext();
    const response = await hostPoolRegistrationTokenGenerate(
      makeRequest({ headers: { 'x-ms-client-principal': adminHeader() }, jsonThrows: true }),
      context,
    );

    expect(response.status).toBe(400);
    expect(generateRegistrationToken).not.toHaveBeenCalled();
  });

  it('returns 404 when hostPoolName does not match the configured/managed host pool', async () => {
    const context = makeContext();
    const response = await hostPoolRegistrationTokenGenerate(
      makeRequest({ headers: { 'x-ms-client-principal': adminHeader() }, hostPoolName: 'HP-SOME-OTHER-POOL' }),
      context,
    );

    expect(response.status).toBe(404);
    expect(generateRegistrationToken).not.toHaveBeenCalled();
  });
});

describe('hostPoolRegistrationTokenGenerate — token value NEVER appears in the audit event', () => {
  it('audits only { hoursValid, expirationTime } on success — never the token', async () => {
    generateRegistrationToken.mockResolvedValue({ token: 'super-secret-token-value', expirationTime: '2026-08-16T00:00:00.000Z' });
    const context = makeContext();

    const response = await hostPoolRegistrationTokenGenerate(
      makeRequest({ headers: { 'x-ms-client-principal': adminHeader('admin@example.com', 'entra-obj-admin-1') }, body: { hoursValid: 8 } }),
      context,
    );

    expect(response.status).toBe(200);
    expect(response.jsonBody).toEqual({ token: 'super-secret-token-value', expirationTime: '2026-08-16T00:00:00.000Z' });

    expect(writeAuditEntry).toHaveBeenCalledTimes(1);
    const [event] = writeAuditEntry.mock.calls[0];

    // Exact-shape assertion: only these fields, and no `token` field anywhere.
    expect(event).toMatchObject({
      actor: 'admin@example.com',
      actorId: 'entra-obj-admin-1',
      action: 'hostpool.registrationtoken.generate',
      target: 'HP-CONTOSO-PROD',
      parameters: { hoursValid: 8, expirationTime: '2026-08-16T00:00:00.000Z' },
      outcome: 'success',
    });
    expect(typeof event.correlationId).toBe('string');

    // Belt-and-braces: the token value must not appear ANYWHERE in the audit event, under any key.
    expect(JSON.stringify(event)).not.toContain('super-secret-token-value');

    // And the context logger (which the AuditLogger's .log ultimately feeds
    // AUDIT_EVENT lines into via writeAuditEntry — here that's the real
    // production writeAuditEntry's job, mocked out above, so this asserts
    // this handler itself never independently logs the token either).
    expect(context.logs.some((l) => String(l).includes('super-secret-token-value'))).toBe(false);
    expect(context.warnings.some((w) => w.includes('super-secret-token-value'))).toBe(false);
    expect(context.errors.some((e) => String(e).includes('super-secret-token-value'))).toBe(false);
  });

  it('audits only { hoursValid } (no expirationTime, no token) on a failed generate', async () => {
    generateRegistrationToken.mockRejectedValue(new Error('ARM timeout'));
    const context = makeContext();

    const response = await hostPoolRegistrationTokenGenerate(
      makeRequest({ headers: { 'x-ms-client-principal': adminHeader() }, body: { hoursValid: 4 } }),
      context,
    );

    expect(response.status).toBe(502);
    expect(writeAuditEntry).toHaveBeenCalledTimes(1);
    const [event] = writeAuditEntry.mock.calls[0];
    expect(event).toMatchObject({ outcome: 'failure', parameters: { hoursValid: 4 }, detail: 'ARM timeout' });
    // Exact parameters shape — no `token`/`expirationTime` key snuck in on the failure path.
    expect(event.parameters).toEqual({ hoursValid: 4 });
  });
});

describe('hostPoolRegistrationTokenGenerate — fail-closed audit posture', () => {
  it('returns 500 and never calls the service when audit is required but not configured', async () => {
    isAuditRequiredButMissing.mockReturnValue(true);
    const context = makeContext();

    const response = await hostPoolRegistrationTokenGenerate(makeRequest({ headers: { 'x-ms-client-principal': adminHeader() } }), context);

    expect(response.status).toBe(500);
    expect(response.jsonBody).toMatchObject({ code: 'audit_not_configured' });
    expect(generateRegistrationToken).not.toHaveBeenCalled();
    expect(writeAuditEntry).not.toHaveBeenCalled();
  });

  it('still returns 400 for a malformed hoursValid even when audit is unavailable (validation happens first)', async () => {
    isAuditRequiredButMissing.mockReturnValue(true);
    const context = makeContext();

    const response = await hostPoolRegistrationTokenGenerate(
      makeRequest({ headers: { 'x-ms-client-principal': adminHeader() }, body: { hoursValid: 'nope' } }),
      context,
    );

    expect(response.status).toBe(400);
  });
});

describe('hostPoolRegistrationTokenGenerate — ARM 404 mapping', () => {
  it('maps a not-found ARM error to a 404 response and still writes a failure audit row', async () => {
    const notFound = Object.assign(new Error('not found'), { statusCode: 404 });
    generateRegistrationToken.mockRejectedValue(notFound);
    isNotFoundError.mockReturnValue(true);
    const context = makeContext();

    const response = await hostPoolRegistrationTokenGenerate(makeRequest({ headers: { 'x-ms-client-principal': adminHeader() } }), context);

    expect(response.status).toBe(404);
    expect(response.jsonBody).toMatchObject({ code: 'host_pool_not_found' });
    expect(writeAuditEntry).toHaveBeenCalledTimes(1);
  });
});

describe('hostPoolRegistrationTokenStatus — operator-minimum RBAC', () => {
  it('returns 403 for a viewer', async () => {
    const context = makeContext();
    const response = await hostPoolRegistrationTokenStatus(makeRequest({ headers: { 'x-ms-client-principal': viewerHeader() } }), context);

    expect(response.status).toBe(403);
    expect(getRegistrationTokenStatus).not.toHaveBeenCalled();
  });

  it('returns 401 for an unauthenticated caller', async () => {
    const context = makeContext();
    const response = await hostPoolRegistrationTokenStatus(makeRequest({}), context);

    expect(response.status).toBe(401);
  });

  it('allows an operator and returns status without a token field', async () => {
    getRegistrationTokenStatus.mockResolvedValue({ exists: true, expirationTime: '2026-08-16T00:00:00.000Z' });
    const context = makeContext();
    const response = await hostPoolRegistrationTokenStatus(makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() } }), context);

    expect(response.status).toBe(200);
    expect(response.jsonBody).toEqual({ exists: true, expirationTime: '2026-08-16T00:00:00.000Z' });
    expect(JSON.stringify(response.jsonBody)).not.toMatch(/"token"/);
  });

  it('allows an admin too', async () => {
    getRegistrationTokenStatus.mockResolvedValue({ exists: false });
    const context = makeContext();
    const response = await hostPoolRegistrationTokenStatus(makeRequest({ headers: { 'x-ms-client-principal': adminHeader() } }), context);

    expect(response.status).toBe(200);
    expect(response.jsonBody).toEqual({ exists: false });
  });

  it('returns 404 when hostPoolName does not match the configured/managed host pool', async () => {
    const context = makeContext();
    const response = await hostPoolRegistrationTokenStatus(
      makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() }, hostPoolName: 'HP-SOME-OTHER-POOL' }),
      context,
    );

    expect(response.status).toBe(404);
    expect(getRegistrationTokenStatus).not.toHaveBeenCalled();
  });

  it('returns 502 when the service call fails', async () => {
    getRegistrationTokenStatus.mockRejectedValue(new Error('ARM unreachable'));
    const context = makeContext();
    const response = await hostPoolRegistrationTokenStatus(makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() } }), context);

    expect(response.status).toBe(502);
    expect(response.jsonBody).toMatchObject({ code: 'registration_token_status_failed' });
  });
});

describe('hostPoolRegistrationTokenDispatch — single app.http registration routing on request.method (Opus review item 1)', () => {
  it('routes GET to hostPoolRegistrationTokenStatus', async () => {
    getRegistrationTokenStatus.mockResolvedValue({ exists: false });
    const context = makeContext();

    const response = await hostPoolRegistrationTokenDispatch(
      makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() }, method: 'GET' }),
      context,
    );

    expect(response.status).toBe(200);
    expect(response.jsonBody).toEqual({ exists: false });
    expect(getRegistrationTokenStatus).toHaveBeenCalledTimes(1);
    expect(generateRegistrationToken).not.toHaveBeenCalled();
  });

  it('routes POST to hostPoolRegistrationTokenGenerate', async () => {
    generateRegistrationToken.mockResolvedValue({ token: 'tok', expirationTime: '2026-08-16T00:00:00.000Z' });
    const context = makeContext();

    const response = await hostPoolRegistrationTokenDispatch(
      makeRequest({ headers: { 'x-ms-client-principal': adminHeader() }, method: 'POST', body: { hoursValid: 8 } }),
      context,
    );

    expect(response.status).toBe(200);
    expect(generateRegistrationToken).toHaveBeenCalledTimes(1);
    expect(getRegistrationTokenStatus).not.toHaveBeenCalled();
  });

  it.each(['DELETE', 'PUT', 'PATCH'])('returns 405 for an unsupported method (%s), calling neither handler', async (method) => {
    const context = makeContext();

    const response = await hostPoolRegistrationTokenDispatch(
      makeRequest({ headers: { 'x-ms-client-principal': adminHeader() }, method }),
      context,
    );

    expect(response.status).toBe(405);
    expect(response.jsonBody).toMatchObject({ code: 'method_not_allowed' });
    expect(generateRegistrationToken).not.toHaveBeenCalled();
    expect(getRegistrationTokenStatus).not.toHaveBeenCalled();
  });
});
