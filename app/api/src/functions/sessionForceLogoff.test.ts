import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HttpRequest, InvocationContext } from '@azure/functions';

const forceLogoffSession = vi.fn();
const isNotFoundError = vi.fn().mockReturnValue(false);
vi.mock('../services/avdService', () => ({
  forceLogoffSession: (...args: unknown[]) => forceLogoffSession(...args),
  isNotFoundError: (...args: unknown[]) => isNotFoundError(...args),
}));

const writeAuditEntry = vi.fn().mockResolvedValue(undefined);
const isAuditRequiredButMissing = vi.fn().mockReturnValue(false);
vi.mock('../lib/auditLog', () => ({
  writeAuditEntry: (...args: unknown[]) => writeAuditEntry(...args),
  isAuditRequiredButMissing: (...args: unknown[]) => isAuditRequiredButMissing(...args),
}));

// Imported AFTER the mocks above so the handler picks up the mocked modules.
const { sessionForceLogoff } = await import('./sessionForceLogoff');

interface FakeContext extends InvocationContext {
  warnings: string[];
  errors: unknown[];
  logs: unknown[];
}

function makeRequest(options: {
  headers?: Record<string, string>;
  hostPoolName?: string;
  sessionHostName?: string;
  sessionId?: string;
  body?: unknown;
  jsonThrows?: boolean;
}): HttpRequest {
  const {
    headers = {},
    hostPoolName = 'HP-CONTOSO-PROD',
    sessionHostName = 'avd-con-0',
    sessionId = '1',
    body = { reason: 'user requested logoff' },
    jsonThrows = false,
  } = options;
  const lower = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  return {
    url: 'https://func-example.azurewebsites.net/api/v1/hostpools/HP-CONTOSO-PROD/sessionhosts/avd-con-0/sessions/1/logoff',
    headers: { get: (name: string) => lower.get(name.toLowerCase()) ?? null },
    params: { hostPoolName, sessionHostName, sessionId },
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

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  process.env.SUBSCRIPTION_ID = 'sub-id';
  process.env.RG_HOSTPOOLS = 'RG-AVD-HostPools';
  process.env.HOSTPOOL_NAME = 'HP-CONTOSO-PROD';
  delete process.env.REQUIRE_BACKEND_SECRET;
  forceLogoffSession.mockReset().mockResolvedValue(undefined);
  isNotFoundError.mockReset().mockReturnValue(false);
  writeAuditEntry.mockReset().mockResolvedValue(undefined);
  isAuditRequiredButMissing.mockReset().mockReturnValue(false);
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('sessionForceLogoff — role rejection path', () => {
  it('returns 403 and never calls the service or writes an audit row for a viewer', async () => {
    const context = makeContext();
    const response = await sessionForceLogoff(makeRequest({ headers: { 'x-ms-client-principal': viewerHeader() } }), context);

    expect(response.status).toBe(403);
    expect(forceLogoffSession).not.toHaveBeenCalled();
    expect(writeAuditEntry).not.toHaveBeenCalled();
  });

  it('returns 401 for an unauthenticated caller', async () => {
    const context = makeContext();
    const response = await sessionForceLogoff(makeRequest({}), context);

    expect(response.status).toBe(401);
    expect(forceLogoffSession).not.toHaveBeenCalled();
  });
});

describe('sessionForceLogoff — mandatory reason', () => {
  it('returns 400 when reason is missing, and does not call the service or write an audit row', async () => {
    const context = makeContext();
    const response = await sessionForceLogoff(
      makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() }, body: {} }),
      context,
    );

    expect(response.status).toBe(400);
    expect(response.jsonBody).toMatchObject({ code: 'missing_reason' });
    expect(forceLogoffSession).not.toHaveBeenCalled();
    expect(writeAuditEntry).not.toHaveBeenCalled();
  });

  it('returns 400 when reason is an empty string', async () => {
    const context = makeContext();
    const response = await sessionForceLogoff(
      makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() }, body: { reason: '' } }),
      context,
    );

    expect(response.status).toBe(400);
    expect(forceLogoffSession).not.toHaveBeenCalled();
  });

  it('returns 400 when reason exceeds 1000 characters', async () => {
    const context = makeContext();
    const response = await sessionForceLogoff(
      makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() }, body: { reason: 'x'.repeat(1001) } }),
      context,
    );

    expect(response.status).toBe(400);
    expect(response.jsonBody).toMatchObject({ code: 'reason_too_long' });
  });

  it('accepts a reason at exactly the 1000-character bound', async () => {
    const context = makeContext();
    const response = await sessionForceLogoff(
      makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() }, body: { reason: 'x'.repeat(1000) } }),
      context,
    );

    expect(response.status).toBe(200);
  });
});

describe('sessionForceLogoff — route param validation', () => {
  it('returns 404 when hostPoolName does not match the configured pool', async () => {
    const context = makeContext();
    const response = await sessionForceLogoff(
      makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() }, hostPoolName: 'HP-OTHER' }),
      context,
    );

    expect(response.status).toBe(404);
    expect(forceLogoffSession).not.toHaveBeenCalled();
  });

  it('returns 400 for an invalid sessionHostName', async () => {
    const context = makeContext();
    const response = await sessionForceLogoff(
      makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() }, sessionHostName: '../etc/passwd' }),
      context,
    );

    expect(response.status).toBe(400);
    expect(response.jsonBody).toMatchObject({ code: 'invalid_session_host_name' });
  });

  it('returns 400 for an invalid sessionId', async () => {
    const context = makeContext();
    const response = await sessionForceLogoff(
      makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() }, sessionId: '../1' }),
      context,
    );

    expect(response.status).toBe(400);
    expect(response.jsonBody).toMatchObject({ code: 'invalid_session_id' });
  });
});

describe('sessionForceLogoff — fail-closed audit posture', () => {
  it('returns 500 and never calls the service when audit is required but not configured', async () => {
    isAuditRequiredButMissing.mockReturnValue(true);
    const context = makeContext();

    const response = await sessionForceLogoff(makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() } }), context);

    expect(response.status).toBe(500);
    expect(response.jsonBody).toMatchObject({ code: 'audit_not_configured' });
    expect(forceLogoffSession).not.toHaveBeenCalled();
    expect(writeAuditEntry).not.toHaveBeenCalled();
  });

  it('still returns 400 for a missing reason even when audit is unavailable (validation happens first)', async () => {
    isAuditRequiredButMissing.mockReturnValue(true);
    const context = makeContext();

    const response = await sessionForceLogoff(
      makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() }, body: {} }),
      context,
    );

    expect(response.status).toBe(400);
  });
});

describe('sessionForceLogoff — happy path', () => {
  it('calls the service, returns 200 with sessionId, and writes a success audit row with sessionId + reason', async () => {
    const context = makeContext();

    const response = await sessionForceLogoff(
      makeRequest({
        headers: { 'x-ms-client-principal': operatorHeader('op@example.com', 'entra-obj-op-1') },
        body: { reason: 'idle session cleanup' },
      }),
      context,
    );

    expect(response.status).toBe(200);
    expect(response.jsonBody).toEqual({ sessionId: '1' });
    expect(forceLogoffSession).toHaveBeenCalledWith('HP-CONTOSO-PROD', 'avd-con-0', '1');

    expect(writeAuditEntry).toHaveBeenCalledTimes(1);
    const [event] = writeAuditEntry.mock.calls[0];
    expect(event).toMatchObject({
      actor: 'op@example.com',
      actorId: 'entra-obj-op-1',
      action: 'session.forceLogoff',
      target: 'HP-CONTOSO-PROD/avd-con-0/1',
      parameters: { sessionId: '1' },
      reason: 'idle session cleanup',
      outcome: 'success',
    });
  });

  it('includes userPrincipalName in audit parameters when the caller supplies it', async () => {
    const context = makeContext();

    await sessionForceLogoff(
      makeRequest({
        headers: { 'x-ms-client-principal': operatorHeader() },
        body: { reason: 'requested', userPrincipalName: 'jdoe@example.com' },
      }),
      context,
    );

    const [event] = writeAuditEntry.mock.calls[0];
    expect(event.parameters).toEqual({ sessionId: '1', userPrincipalName: 'jdoe@example.com' });
  });

  it('omits userPrincipalName from audit parameters when not supplied', async () => {
    const context = makeContext();

    await sessionForceLogoff(makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() } }), context);

    const [event] = writeAuditEntry.mock.calls[0];
    expect(event.parameters).toEqual({ sessionId: '1' });
  });

  it('trims a padded reason before persisting/auditing it', async () => {
    const context = makeContext();

    await sessionForceLogoff(
      makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() }, body: { reason: '  padded reason  ' } }),
      context,
    );

    const [event] = writeAuditEntry.mock.calls[0];
    expect(event.reason).toBe('padded reason');
  });

  it('trims a padded userPrincipalName before auditing it', async () => {
    const context = makeContext();

    await sessionForceLogoff(
      makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() }, body: { reason: 'requested', userPrincipalName: '  jdoe@example.com  ' } }),
      context,
    );

    const [event] = writeAuditEntry.mock.calls[0];
    expect(event.parameters).toEqual({ sessionId: '1', userPrincipalName: 'jdoe@example.com' });
  });

  it('allows an admin too', async () => {
    const context = makeContext();
    const header = encodePrincipal({ identityProvider: 'aad', userId: 'u3', userDetails: 'admin@example.com', userRoles: ['admin'] });

    const response = await sessionForceLogoff(makeRequest({ headers: { 'x-ms-client-principal': header } }), context);

    expect(response.status).toBe(200);
  });
});

describe('sessionForceLogoff — failure paths', () => {
  it('writes a failure audit row and returns 502 when the service call fails', async () => {
    forceLogoffSession.mockRejectedValue(new Error('ARM timeout'));
    const context = makeContext();

    const response = await sessionForceLogoff(makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() } }), context);

    expect(response.status).toBe(502);
    expect(response.jsonBody).toMatchObject({ code: 'session_force_logoff_failed' });
    expect(writeAuditEntry).toHaveBeenCalledTimes(1);
    const [event] = writeAuditEntry.mock.calls[0];
    expect(event).toMatchObject({ outcome: 'failure', action: 'session.forceLogoff', detail: 'ARM timeout' });
  });

  it('logs only the error MESSAGE via context.error, never the raw error object (CWE-532)', async () => {
    const armError = Object.assign(new Error('secret ARM detail'), { request: { body: 'sensitive-payload' } });
    forceLogoffSession.mockRejectedValue(armError);
    const context = makeContext();

    await sessionForceLogoff(makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() } }), context);

    // Every context.error call this handler makes is a single string
    // argument — never the raw Error/RestError object as a second arg
    // (which Azure Functions/App Insights would otherwise serialize
    // wholesale, including any `request` property).
    for (const call of context.errors as unknown[][]) {
      expect(call).toHaveLength(1);
      expect(typeof call[0]).toBe('string');
    }
    expect(context.errors.some((e) => String(e).includes('secret ARM detail'))).toBe(true);
  });

  it('maps a not-found ARM error to 404 and still writes a failure audit row', async () => {
    const notFound = Object.assign(new Error('not found'), { statusCode: 404 });
    forceLogoffSession.mockRejectedValue(notFound);
    isNotFoundError.mockReturnValue(true);
    const context = makeContext();

    const response = await sessionForceLogoff(makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() } }), context);

    expect(response.status).toBe(404);
    expect(response.jsonBody).toMatchObject({ code: 'session_not_found' });
    expect(writeAuditEntry).toHaveBeenCalledTimes(1);
    expect(writeAuditEntry.mock.calls[0][0].outcome).toBe('failure');
  });

  it('still returns 200 when writeAuditEntry rejects on the success path (it should never throw in practice)', async () => {
    writeAuditEntry.mockRejectedValueOnce(new Error('table unreachable'));
    const context = makeContext();

    const response = await sessionForceLogoff(makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() } }), context);

    expect(response.status).toBe(200);
    expect(context.warnings.some((w) => w.includes('audit write threw unexpectedly'))).toBe(true);
  });
});
