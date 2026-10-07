import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HttpRequest, InvocationContext } from '@azure/functions';
import type { UserSession, UserSessionState } from '@avdmgr/shared';

const listUserSessions = vi.fn();
const sendSessionMessage = vi.fn();
const isNotFoundError = vi.fn().mockReturnValue(false);
vi.mock('../services/avdService', () => ({
  listUserSessions: (...args: unknown[]) => listUserSessions(...args),
  sendSessionMessage: (...args: unknown[]) => sendSessionMessage(...args),
  isNotFoundError: (...args: unknown[]) => isNotFoundError(...args),
}));

const writeAuditEntry = vi.fn().mockResolvedValue(undefined);
const isAuditRequiredButMissing = vi.fn().mockReturnValue(false);
vi.mock('../lib/auditLog', () => ({
  writeAuditEntry: (...args: unknown[]) => writeAuditEntry(...args),
  isAuditRequiredButMissing: (...args: unknown[]) => isAuditRequiredButMissing(...args),
}));

const { sessionsBroadcast: handler } = await import('./sessionsBroadcast');
const { MAX_BATCH_TARGETS } = await import('../lib/sessionBatch');

interface FakeContext extends InvocationContext {
  warnings: string[];
  errors: unknown[];
  logs: unknown[];
}

function makeRequest(options: { headers?: Record<string, string>; hostPoolName?: string; body?: unknown; jsonThrows?: boolean }): HttpRequest {
  const { headers = {}, hostPoolName = 'HP-CONTOSO-PROD', body = { title: 'Notice', body: 'Maintenance in 10 minutes.' }, jsonThrows = false } = options;
  const lower = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  return {
    url: 'https://func-example.azurewebsites.net/api/v1/hostpools/HP-CONTOSO-PROD/sessions/broadcast',
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
    error: (...args: unknown[]) => errors.push(args.join(' ')),
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

function session(overrides: Partial<UserSession> & { sessionState: UserSessionState }): UserSession {
  return {
    id: `id-${overrides.sessionId ?? '0'}`,
    sessionId: '0',
    userPrincipalName: 'user@example.com',
    sessionHostName: 'avd-con-0',
    hostPoolName: 'HP-CONTOSO-PROD',
    createTime: new Date(0).toISOString(),
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
  listUserSessions.mockReset().mockResolvedValue([]);
  sendSessionMessage.mockReset().mockResolvedValue(undefined);
  isNotFoundError.mockReset().mockReturnValue(false);
  writeAuditEntry.mockReset().mockResolvedValue(undefined);
  isAuditRequiredButMissing.mockReset().mockReturnValue(false);
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('sessionsBroadcast — role rejection path', () => {
  it('returns 403 for a viewer without listing or messaging anyone', async () => {
    const context = makeContext();
    const response = await handler(makeRequest({ headers: { 'x-ms-client-principal': viewerHeader() } }), context);

    expect(response.status).toBe(403);
    expect(listUserSessions).not.toHaveBeenCalled();
    expect(sendSessionMessage).not.toHaveBeenCalled();
  });
});

describe('sessionsBroadcast — mandatory body / optional title', () => {
  it('returns 400 when body is missing, without listing sessions', async () => {
    const context = makeContext();
    const response = await handler(makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() }, body: { title: 'Notice' } }), context);

    expect(response.status).toBe(400);
    expect(response.jsonBody).toMatchObject({ code: 'missing_body' });
    expect(listUserSessions).not.toHaveBeenCalled();
  });

  it('trims title/body before sending and before auditing', async () => {
    listUserSessions.mockResolvedValue([session({ sessionId: '1', sessionState: 'Active' })]);
    const context = makeContext();

    await handler(
      makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() }, body: { title: '  Heads up  ', body: '  Please save your work.  ' } }),
      context,
    );

    expect(sendSessionMessage).toHaveBeenCalledWith('HP-CONTOSO-PROD', 'avd-con-0', '1', 'Heads up', 'Please save your work.');
    const [event] = writeAuditEntry.mock.calls[0];
    expect(event.parameters.title).toBe('Heads up');
    expect(event.parameters.bodyPreview).toBe('Please save your work.');
  });
});

describe('sessionsBroadcast — route parity: non-managed host pool + malformed body', () => {
  it('returns 404 for a hostPoolName that does not match the configured/managed pool, without listing sessions', async () => {
    const context = makeContext();
    const response = await handler(makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() }, hostPoolName: 'HP-OTHER' }), context);

    expect(response.status).toBe(404);
    expect(listUserSessions).not.toHaveBeenCalled();
  });

  it('returns 400 for a malformed (non-JSON) request body', async () => {
    const context = makeContext();
    const response = await handler(makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() }, jsonThrows: true }), context);

    expect(response.status).toBe(400);
    expect(response.jsonBody).toMatchObject({ code: 'invalid_request_body' });
    expect(listUserSessions).not.toHaveBeenCalled();
  });
});

describe('sessionsBroadcast — fail-closed audit posture', () => {
  it('returns 500 and never lists sessions when audit is required but not configured', async () => {
    isAuditRequiredButMissing.mockReturnValue(true);
    const context = makeContext();

    const response = await handler(makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() } }), context);

    expect(response.status).toBe(500);
    expect(listUserSessions).not.toHaveBeenCalled();
  });
});

describe('sessionsBroadcast — THE Active-only filter invariant', () => {
  it('messages ONLY Active sessions, never Disconnected/Pending/LogOff/UserProfileDiskMounted', async () => {
    listUserSessions.mockResolvedValue([
      session({ sessionId: '1', sessionState: 'Active' }),
      session({ sessionId: '2', sessionState: 'Disconnected' }),
      session({ sessionId: '3', sessionState: 'Pending' }),
      session({ sessionId: '4', sessionState: 'Active' }),
      session({ sessionId: '5', sessionState: 'LogOff' }),
      session({ sessionId: '6', sessionState: 'UserProfileDiskMounted' }),
    ]);
    const context = makeContext();

    const response = await handler(makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() } }), context);

    expect(response.status).toBe(200);
    expect(sendSessionMessage).toHaveBeenCalledTimes(2);
    const targetedIds = sendSessionMessage.mock.calls.map((call) => call[2]).sort();
    expect(targetedIds).toEqual(['1', '4']);
    const body = response.jsonBody as { correlationId: string };
    expect(typeof body.correlationId).toBe('string');
    expect(body.correlationId.length).toBeGreaterThan(0);
  });

  it('does nothing (attempted: 0) and still writes a success audit row when there are no Active sessions', async () => {
    listUserSessions.mockResolvedValue([session({ sessionId: '1', sessionState: 'Disconnected' })]);
    const context = makeContext();

    const response = await handler(makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() } }), context);

    expect(response.status).toBe(200);
    expect(sendSessionMessage).not.toHaveBeenCalled();
    const body = response.jsonBody as { result: { attempted: number } };
    expect(body.result.attempted).toBe(0);
  });
});

describe('sessionsBroadcast — 404-in-batch is skipped, not failed', () => {
  it('classifies a per-session 404 as skipped, keeps outcome success', async () => {
    listUserSessions.mockResolvedValue([
      session({ sessionId: '1', sessionState: 'Active' }),
      session({ sessionId: '2', sessionState: 'Active' }),
    ]);
    sendSessionMessage.mockImplementation(async (_hp: string, _host: string, sessionId: string) => {
      if (sessionId === '2') {
        throw Object.assign(new Error('not found'), { statusCode: 404 });
      }
    });
    isNotFoundError.mockImplementation((error: unknown) => typeof error === 'object' && error !== null && (error as { statusCode?: number }).statusCode === 404);
    const context = makeContext();

    const response = await handler(makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() } }), context);

    expect(response.status).toBe(200);
    const body = response.jsonBody as { result: { succeeded: number; skipped: number; failed: unknown[] } };
    expect(body.result).toMatchObject({ succeeded: 1, skipped: 1, failed: [] });
    expect(writeAuditEntry.mock.calls[0][0].outcome).toBe('success');
  });
});

describe('sessionsBroadcast — MAX_BATCH_TARGETS cap', () => {
  it('returns 400 without attempting anything when the Active target count exceeds the cap', async () => {
    const sessions = Array.from({ length: MAX_BATCH_TARGETS + 1 }, (_, i) => session({ sessionId: String(i), sessionState: 'Active' }));
    listUserSessions.mockResolvedValue(sessions);
    const context = makeContext();

    const response = await handler(makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() } }), context);

    expect(response.status).toBe(400);
    expect(response.jsonBody).toMatchObject({ code: 'too_many_sessions', details: { count: MAX_BATCH_TARGETS + 1, max: MAX_BATCH_TARGETS } });
    expect(sendSessionMessage).not.toHaveBeenCalled();
    expect(writeAuditEntry).not.toHaveBeenCalled();
  });
});

describe('sessionsBroadcast — message content is passed through to every target', () => {
  it('sends the same title/body to every Active session', async () => {
    listUserSessions.mockResolvedValue([session({ sessionId: '1', sessionState: 'Active' }), session({ sessionId: '2', sessionState: 'Active' })]);
    const context = makeContext();

    await handler(makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() }, body: { title: 'Heads up', body: 'System restart in 5 minutes.' } }), context);

    const calledIds = sendSessionMessage.mock.calls.map((call) => call[2]).sort();
    expect(calledIds).toEqual(['1', '2']);
    for (const call of sendSessionMessage.mock.calls) {
      expect(call[0]).toBe('HP-CONTOSO-PROD');
      expect(call[3]).toBe('Heads up');
      expect(call[4]).toBe('System restart in 5 minutes.');
    }
  });
});

describe('sessionsBroadcast — partial failure aggregation, single batch audit row, host-qualified ids', () => {
  it('reports partial failure with a SANITIZED message and writes exactly ONE audit row with counts + host-qualified session ids + message metadata', async () => {
    listUserSessions.mockResolvedValue([
      session({ sessionId: '10', sessionHostName: 'host-a', userPrincipalName: 'a@example.com', sessionState: 'Active' }),
      session({ sessionId: '11', sessionHostName: 'host-b', userPrincipalName: 'b@example.com', sessionState: 'Active' }),
    ]);
    const rawMessage = 'RestError: PUT ... body={"secret":"leak"}';
    sendSessionMessage.mockImplementation(async (_hp: string, _host: string, sessionId: string) => {
      if (sessionId === '11') throw new Error(rawMessage);
    });
    const context = makeContext();

    const response = await handler(
      makeRequest({ headers: { 'x-ms-client-principal': operatorHeader('op@example.com', 'entra-op-1') }, body: { title: 'Notice', body: 'Please save your work.' } }),
      context,
    );

    expect(response.status).toBe(200);
    const body = response.jsonBody as { result: { attempted: number; succeeded: number; failed: { sessionId: string; message: string }[] } };
    expect(body.result.attempted).toBe(2);
    expect(body.result.succeeded).toBe(1);
    expect(body.result.failed[0].message).not.toContain('leak');
    expect(body.result.failed[0].message).not.toBe(rawMessage);

    expect(writeAuditEntry).toHaveBeenCalledTimes(1);
    const [event] = writeAuditEntry.mock.calls[0];
    expect(event).toMatchObject({
      actor: 'op@example.com',
      actorId: 'entra-op-1',
      action: 'sessions.broadcast',
      target: 'HP-CONTOSO-PROD',
      outcome: 'failure',
    });
    expect(event.parameters.sessionIds).toEqual(['host-a/10', 'host-b/11']);
    expect(event.parameters).toMatchObject({
      attempted: 2,
      succeeded: 1,
      skipped: 0,
      failedCount: 1,
      sessionIdsTotal: 2,
      sessionIdsTruncated: false,
      title: 'Notice',
      bodyLength: 'Please save your work.'.length,
    });
    expect(context.errors.some((e) => String(e).includes(rawMessage))).toBe(true);
  });

  it('emits a SESSION_BATCH_PARTIAL_FAILURE log line when any session fails', async () => {
    listUserSessions.mockResolvedValue([
      session({ sessionId: '1', sessionState: 'Active' }),
      session({ sessionId: '2', sessionState: 'Active' }),
    ]);
    sendSessionMessage.mockImplementation(async (_hp: string, _host: string, sessionId: string) => {
      if (sessionId === '2') throw new Error('boom');
    });
    const context = makeContext();

    await handler(makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() } }), context);

    expect(context.warnings.some((w) => w.includes('SESSION_BATCH_PARTIAL_FAILURE'))).toBe(true);
  });
});

describe('sessionsBroadcast — enumeration failure includes the same message metadata as the success path', () => {
  it('returns 502 and writes a failure audit row with title/bodyLength/bodyPreview when listUserSessions itself throws', async () => {
    listUserSessions.mockRejectedValue(new Error('ARM unreachable'));
    const context = makeContext();

    const response = await handler(
      makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() }, body: { title: 'Notice', body: 'Please save your work.' } }),
      context,
    );

    expect(response.status).toBe(502);
    expect(response.jsonBody).toMatchObject({ code: 'sessions_broadcast_failed' });
    expect(sendSessionMessage).not.toHaveBeenCalled();
    expect(writeAuditEntry).toHaveBeenCalledTimes(1);
    const [event] = writeAuditEntry.mock.calls[0];
    expect(event.outcome).toBe('failure');
    expect(event.parameters).toEqual({ title: 'Notice', bodyLength: 'Please save your work.'.length, bodyPreview: 'Please save your work.' });
  });
});
