import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HttpRequest, InvocationContext } from '@azure/functions';
import type { UserSession, UserSessionState } from '@avdmgr/shared';

const listUserSessions = vi.fn();
const forceLogoffSession = vi.fn();
const isNotFoundError = vi.fn().mockReturnValue(false);
vi.mock('../services/avdService', () => ({
  listUserSessions: (...args: unknown[]) => listUserSessions(...args),
  forceLogoffSession: (...args: unknown[]) => forceLogoffSession(...args),
  isNotFoundError: (...args: unknown[]) => isNotFoundError(...args),
}));

const writeAuditEntry = vi.fn().mockResolvedValue(undefined);
const isAuditRequiredButMissing = vi.fn().mockReturnValue(false);
vi.mock('../lib/auditLog', () => ({
  writeAuditEntry: (...args: unknown[]) => writeAuditEntry(...args),
  isAuditRequiredButMissing: (...args: unknown[]) => isAuditRequiredButMissing(...args),
}));

const { sessionsLogoffDisconnected: handler } = await import('./sessionsLogoffDisconnected');
const { MAX_BATCH_TARGETS } = await import('../lib/sessionBatch');

interface FakeContext extends InvocationContext {
  warnings: string[];
  errors: unknown[];
  logs: unknown[];
}

function makeRequest(options: { headers?: Record<string, string>; hostPoolName?: string; body?: unknown; jsonThrows?: boolean }): HttpRequest {
  const { headers = {}, hostPoolName = 'HP-CONTOSO-PROD', body = { reason: 'end of business day cleanup' }, jsonThrows = false } = options;
  const lower = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  return {
    url: 'https://func-example.azurewebsites.net/api/v1/hostpools/HP-CONTOSO-PROD/sessions/logoff-disconnected',
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
  forceLogoffSession.mockReset().mockResolvedValue(undefined);
  isNotFoundError.mockReset().mockReturnValue(false);
  writeAuditEntry.mockReset().mockResolvedValue(undefined);
  isAuditRequiredButMissing.mockReset().mockReturnValue(false);
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('sessionsLogoffDisconnected — role rejection path', () => {
  it('returns 403 for a viewer without listing or logging anyone off', async () => {
    const context = makeContext();
    const response = await handler(makeRequest({ headers: { 'x-ms-client-principal': viewerHeader() } }), context);

    expect(response.status).toBe(403);
    expect(listUserSessions).not.toHaveBeenCalled();
    expect(forceLogoffSession).not.toHaveBeenCalled();
  });
});

describe('sessionsLogoffDisconnected — mandatory reason', () => {
  it('returns 400 when reason is missing, without listing sessions', async () => {
    const context = makeContext();
    const response = await handler(makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() }, body: {} }), context);

    expect(response.status).toBe(400);
    expect(response.jsonBody).toMatchObject({ code: 'missing_reason' });
    expect(listUserSessions).not.toHaveBeenCalled();
  });
});

describe('sessionsLogoffDisconnected — route parity: non-managed host pool + malformed body', () => {
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

describe('sessionsLogoffDisconnected — fail-closed audit posture', () => {
  it('returns 500 and never lists sessions when audit is required but not configured', async () => {
    isAuditRequiredButMissing.mockReturnValue(true);
    const context = makeContext();

    const response = await handler(makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() } }), context);

    expect(response.status).toBe(500);
    expect(listUserSessions).not.toHaveBeenCalled();
  });
});

describe('sessionsLogoffDisconnected — THE Disconnected-only filter invariant (AM-10 acceptance criterion)', () => {
  it('logs off ONLY Disconnected sessions, never Active/Pending/LogOff/UserProfileDiskMounted, even when they outnumber the Disconnected ones', async () => {
    listUserSessions.mockResolvedValue([
      session({ sessionId: '1', sessionState: 'Active' }),
      session({ sessionId: '2', sessionState: 'Disconnected' }),
      session({ sessionId: '3', sessionState: 'Pending' }),
      session({ sessionId: '4', sessionState: 'Disconnected' }),
      session({ sessionId: '5', sessionState: 'LogOff' }),
      session({ sessionId: '6', sessionState: 'UserProfileDiskMounted' }),
      session({ sessionId: '7', sessionState: 'Unknown' }),
    ]);
    const context = makeContext();

    const response = await handler(makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() } }), context);

    expect(response.status).toBe(200);
    expect(forceLogoffSession).toHaveBeenCalledTimes(2);
    const targetedIds = forceLogoffSession.mock.calls.map((call) => call[2]).sort();
    expect(targetedIds).toEqual(['2', '4']);
    const body = response.jsonBody as { result: { attempted: number; succeeded: number }; correlationId: string };
    expect(body.result).toMatchObject({ attempted: 2, succeeded: 2, skipped: 0, failed: [] });
    expect(typeof body.correlationId).toBe('string');
    expect(body.correlationId.length).toBeGreaterThan(0);
  });

  it('does nothing (attempted: 0) and still writes a success audit row when there are no Disconnected sessions', async () => {
    listUserSessions.mockResolvedValue([session({ sessionId: '1', sessionState: 'Active' })]);
    const context = makeContext();

    const response = await handler(makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() } }), context);

    expect(response.status).toBe(200);
    expect(forceLogoffSession).not.toHaveBeenCalled();
    const body = response.jsonBody as { result: { attempted: number } };
    expect(body.result.attempted).toBe(0);
    expect(writeAuditEntry).toHaveBeenCalledTimes(1);
    expect(writeAuditEntry.mock.calls[0][0].outcome).toBe('success');
  });
});

describe('sessionsLogoffDisconnected — 404-in-batch is skipped, not failed', () => {
  it('classifies a per-session 404 as skipped, keeps outcome success, and does not add it to failed[]', async () => {
    listUserSessions.mockResolvedValue([
      session({ sessionId: '1', sessionState: 'Disconnected' }),
      session({ sessionId: '2', sessionState: 'Disconnected' }),
    ]);
    forceLogoffSession.mockImplementation(async (_hp: string, _host: string, sessionId: string) => {
      if (sessionId === '2') {
        const notFound = Object.assign(new Error('not found'), { statusCode: 404 });
        throw notFound;
      }
    });
    isNotFoundError.mockImplementation((error: unknown) => typeof error === 'object' && error !== null && (error as { statusCode?: number }).statusCode === 404);
    const context = makeContext();

    const response = await handler(makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() } }), context);

    expect(response.status).toBe(200);
    const body = response.jsonBody as { result: { attempted: number; succeeded: number; skipped: number; failed: unknown[] } };
    expect(body.result).toEqual({ attempted: 2, succeeded: 1, skipped: 1, failed: [] });

    const [event] = writeAuditEntry.mock.calls[0];
    expect(event.outcome).toBe('success');
    expect(event.parameters.skipped).toBe(1);
    expect(event.parameters.failedCount).toBe(0);
  });
});

describe('sessionsLogoffDisconnected — MAX_BATCH_TARGETS cap', () => {
  it('returns 400 without attempting anything when the Disconnected target count exceeds the cap', async () => {
    const sessions = Array.from({ length: MAX_BATCH_TARGETS + 1 }, (_, i) => session({ sessionId: String(i), sessionState: 'Disconnected' }));
    listUserSessions.mockResolvedValue(sessions);
    const context = makeContext();

    const response = await handler(makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() } }), context);

    expect(response.status).toBe(400);
    expect(response.jsonBody).toMatchObject({ code: 'too_many_sessions', details: { count: MAX_BATCH_TARGETS + 1, max: MAX_BATCH_TARGETS } });
    expect(forceLogoffSession).not.toHaveBeenCalled();
    expect(writeAuditEntry).not.toHaveBeenCalled();
  });

  it('proceeds normally when the target count is exactly at the cap', async () => {
    const sessions = Array.from({ length: MAX_BATCH_TARGETS }, (_, i) => session({ sessionId: String(i), sessionState: 'Disconnected' }));
    listUserSessions.mockResolvedValue(sessions);
    const context = makeContext();

    const response = await handler(makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() } }), context);

    expect(response.status).toBe(200);
    expect(forceLogoffSession).toHaveBeenCalledTimes(MAX_BATCH_TARGETS);
  });
});

describe('sessionsLogoffDisconnected — partial failure aggregation, single batch audit row, host-qualified ids', () => {
  it('reports partial failure in the response (with a SANITIZED message) and writes exactly ONE audit row with counts + host-qualified session ids', async () => {
    listUserSessions.mockResolvedValue([
      session({ sessionId: '10', sessionHostName: 'host-a', userPrincipalName: 'a@example.com', sessionState: 'Disconnected' }),
      session({ sessionId: '11', sessionHostName: 'host-b', userPrincipalName: 'b@example.com', sessionState: 'Disconnected' }),
    ]);
    const rawMessage = 'RestError: PUT https://management.azure.com/... body={"secret":"leak"}';
    forceLogoffSession.mockImplementation(async (_hp: string, _host: string, sessionId: string) => {
      if (sessionId === '11') throw new Error(rawMessage);
    });
    const context = makeContext();

    const response = await handler(
      makeRequest({ headers: { 'x-ms-client-principal': operatorHeader('op@example.com', 'entra-op-1') }, body: { reason: 'nightly cleanup' } }),
      context,
    );

    expect(response.status).toBe(200);
    const body = response.jsonBody as { result: { attempted: number; succeeded: number; failed: { sessionId: string; message: string }[] } };
    expect(body.result.attempted).toBe(2);
    expect(body.result.succeeded).toBe(1);
    expect(body.result.failed).toHaveLength(1);
    expect(body.result.failed[0].sessionId).toBe('11');
    expect(body.result.failed[0].message).not.toContain('leak');
    expect(body.result.failed[0].message).not.toBe(rawMessage);

    expect(writeAuditEntry).toHaveBeenCalledTimes(1);
    const [event] = writeAuditEntry.mock.calls[0];
    expect(event).toMatchObject({
      actor: 'op@example.com',
      actorId: 'entra-op-1',
      action: 'sessions.logoffAllDisconnected',
      target: 'HP-CONTOSO-PROD',
      reason: 'nightly cleanup',
      outcome: 'failure',
    });
    // HOST-QUALIFIED ids (not bare ARM-local ids, which collide across hosts).
    expect(event.parameters.sessionIds).toEqual(['host-a/10', 'host-b/11']);
    expect(event.parameters).toMatchObject({ attempted: 2, succeeded: 1, skipped: 0, failedCount: 1, sessionIdsTotal: 2, sessionIdsTruncated: false });

    // The raw error text is logged server-side, not embedded in the audit's parameters/detail.
    expect(context.errors.some((e) => String(e).includes(rawMessage))).toBe(true);
  });

  it('caps the audit parameters.sessionIds list and sets sessionIdsTruncated when the batch is large', async () => {
    const count = 60;
    const sessions = Array.from({ length: count }, (_, i) => session({ sessionId: String(i), sessionHostName: `host-${i}`, sessionState: 'Disconnected' }));
    listUserSessions.mockResolvedValue(sessions);
    const context = makeContext();

    await handler(makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() } }), context);

    const [event] = writeAuditEntry.mock.calls[0];
    expect(event.parameters.sessionIds).toHaveLength(50);
    expect(event.parameters.sessionIdsTotal).toBe(count);
    expect(event.parameters.sessionIdsTruncated).toBe(true);
  });

  it('writes outcome: success when every targeted session logs off cleanly', async () => {
    listUserSessions.mockResolvedValue([session({ sessionId: '1', sessionState: 'Disconnected' })]);
    const context = makeContext();

    await handler(makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() } }), context);

    expect(writeAuditEntry.mock.calls[0][0].outcome).toBe('success');
  });

  it('emits a SESSION_BATCH_PARTIAL_FAILURE log line when any session fails', async () => {
    listUserSessions.mockResolvedValue([
      session({ sessionId: '1', sessionState: 'Disconnected' }),
      session({ sessionId: '2', sessionState: 'Disconnected' }),
    ]);
    forceLogoffSession.mockImplementation(async (_hp: string, _host: string, sessionId: string) => {
      if (sessionId === '2') throw new Error('boom');
    });
    const context = makeContext();

    await handler(makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() } }), context);

    expect(context.warnings.some((w) => w.includes('SESSION_BATCH_PARTIAL_FAILURE'))).toBe(true);
  });

  it('does NOT emit SESSION_BATCH_PARTIAL_FAILURE when there are no failures (only skips)', async () => {
    listUserSessions.mockResolvedValue([session({ sessionId: '1', sessionState: 'Disconnected' })]);
    isNotFoundError.mockReturnValue(true);
    forceLogoffSession.mockRejectedValue(Object.assign(new Error('gone'), { statusCode: 404 }));
    const context = makeContext();

    await handler(makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() } }), context);

    expect(context.warnings.some((w) => w.includes('SESSION_BATCH_PARTIAL_FAILURE'))).toBe(false);
  });
});

describe('sessionsLogoffDisconnected — bounded concurrency (integration smoke test)', () => {
  it('never runs more than a small number of forceLogoffSession calls concurrently for a larger batch', async () => {
    const count = 20;
    listUserSessions.mockResolvedValue(Array.from({ length: count }, (_, i) => session({ sessionId: String(i), sessionState: 'Disconnected' })));
    let inFlight = 0;
    let maxInFlight = 0;
    forceLogoffSession.mockImplementation(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
    });
    const context = makeContext();

    const response = await handler(makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() } }), context);

    expect(response.status).toBe(200);
    expect(maxInFlight).toBeLessThan(count);
    expect(maxInFlight).toBeLessThanOrEqual(8);
  });
});

describe('sessionsLogoffDisconnected — enumeration failure', () => {
  it('returns 502 and writes a failure audit row when listUserSessions itself throws', async () => {
    listUserSessions.mockRejectedValue(new Error('ARM unreachable'));
    const context = makeContext();

    const response = await handler(makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() } }), context);

    expect(response.status).toBe(502);
    expect(response.jsonBody).toMatchObject({ code: 'sessions_logoff_disconnected_failed' });
    expect(forceLogoffSession).not.toHaveBeenCalled();
    expect(writeAuditEntry).toHaveBeenCalledTimes(1);
    expect(writeAuditEntry.mock.calls[0][0].outcome).toBe('failure');
  });
});
