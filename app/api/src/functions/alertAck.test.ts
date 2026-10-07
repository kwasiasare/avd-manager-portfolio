import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HttpRequest, InvocationContext } from '@azure/functions';

const ackAlert = vi.fn().mockResolvedValue(undefined);
const unackAlert = vi.fn().mockResolvedValue(undefined);
const isValidAlertGuid = vi.fn((value: unknown) => typeof value === 'string' && /^[0-9a-f-]{36}$/i.test(value));
const buildAlertResourceId = vi.fn((subscriptionId: string, guid: string) => `/subscriptions/${subscriptionId}/providers/Microsoft.AlertsManagement/alerts/${guid}`);

vi.mock('../lib/alertState', () => ({
  ackAlert: (...args: unknown[]) => ackAlert(...args),
  unackAlert: (...args: unknown[]) => unackAlert(...args),
  isValidAlertGuid: (...args: unknown[]) => isValidAlertGuid(...args),
  buildAlertResourceId: (...args: unknown[]) => buildAlertResourceId(...args),
}));

const writeAuditEntry = vi.fn().mockResolvedValue(undefined);
const isAuditRequiredButMissing = vi.fn().mockReturnValue(false);
vi.mock('../lib/auditLog', () => ({
  writeAuditEntry: (...args: unknown[]) => writeAuditEntry(...args),
  isAuditRequiredButMissing: (...args: unknown[]) => isAuditRequiredButMissing(...args),
}));

// Imported AFTER the mocks above so the handlers/dispatcher pick up the mocked modules.
const alertAckModule = await import('./alertAck');
const { alertAck, alertUnack } = alertAckModule;

interface FakeContext extends InvocationContext {
  warnings: string[];
  errors: unknown[];
  logs: string[];
}

const VALID_GUID = 'a1b2c3d4-e5f6-4789-a012-3456789abcde';

function makeRequest(options: { method?: string; headers?: Record<string, string>; alertGuid?: string; body?: unknown; jsonThrows?: boolean }): HttpRequest {
  const { method = 'POST', headers = {}, alertGuid = VALID_GUID, body = {}, jsonThrows = false } = options;
  const lower = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  return {
    method,
    url: `https://func-example.azurewebsites.net/api/v1/alerts/${alertGuid}/ack`,
    headers: { get: (name: string) => lower.get(name.toLowerCase()) ?? null },
    params: { alertGuid },
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

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  process.env.SUBSCRIPTION_ID = 'sub-id';
  // getConfig() (via getConfig().subscriptionId in alertAck.ts/buildAlertResourceId) requires these — readEnv has no fallback for them.
  process.env.RG_HOSTPOOLS = 'RG-AVD-HostPools';
  process.env.HOSTPOOL_NAME = 'HP-CONTOSO-PROD';
  delete process.env.REQUIRE_BACKEND_SECRET;
  ackAlert.mockReset().mockResolvedValue(undefined);
  unackAlert.mockReset().mockResolvedValue(undefined);
  isValidAlertGuid.mockReset().mockImplementation((value: unknown) => typeof value === 'string' && /^[0-9a-f-]{36}$/i.test(value));
  buildAlertResourceId.mockReset().mockImplementation((subscriptionId: string, guid: string) => `/subscriptions/${subscriptionId}/providers/Microsoft.AlertsManagement/alerts/${guid}`);
  writeAuditEntry.mockReset().mockResolvedValue(undefined);
  isAuditRequiredButMissing.mockReset().mockReturnValue(false);
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('alertAck (POST) — role rejection path', () => {
  it('returns 403 and never calls ackAlert or writes an audit row for a viewer', async () => {
    const context = makeContext();
    const response = await alertAck(makeRequest({ headers: { 'x-ms-client-principal': viewerHeader() } }), context);

    expect(response.status).toBe(403);
    expect(ackAlert).not.toHaveBeenCalled();
    expect(writeAuditEntry).not.toHaveBeenCalled();
  });

  it('returns 401 for an unauthenticated caller', async () => {
    const context = makeContext();
    const response = await alertAck(makeRequest({}), context);

    expect(response.status).toBe(401);
    expect(ackAlert).not.toHaveBeenCalled();
  });
});

describe('alertAck (POST) — validation', () => {
  it('returns 400 for an invalid alertGuid (e.g. a full ARM id, not a bare guid)', async () => {
    isValidAlertGuid.mockReturnValue(false);
    const context = makeContext();
    const response = await alertAck(makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() }, alertGuid: 'not-a-guid' }), context);

    expect(response.status).toBe(400);
    expect(response.jsonBody).toMatchObject({ code: 'invalid_alert_id' });
    expect(ackAlert).not.toHaveBeenCalled();
  });

  it('returns 400 when reason exceeds 1000 characters', async () => {
    const context = makeContext();
    const response = await alertAck(makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() }, body: { reason: 'x'.repeat(1001) } }), context);

    expect(response.status).toBe(400);
    expect(response.jsonBody).toMatchObject({ code: 'reason_too_long' });
    expect(ackAlert).not.toHaveBeenCalled();
  });

  it('returns 400 when reason is not a string', async () => {
    const context = makeContext();
    const response = await alertAck(makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() }, body: { reason: 123 } }), context);

    expect(response.status).toBe(400);
    expect(response.jsonBody).toMatchObject({ code: 'invalid_reason' });
  });

  it('tolerates a malformed JSON body (ack has no required fields)', async () => {
    const context = makeContext();
    const response = await alertAck(makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() }, jsonThrows: true }), context);

    expect(response.status).toBe(204);
    expect(ackAlert).toHaveBeenCalledWith(VALID_GUID, 'operator@example.com', undefined);
  });
});

describe('alertAck (POST) — fail-closed audit posture', () => {
  it('returns 500 and never calls ackAlert when audit is required but not configured', async () => {
    isAuditRequiredButMissing.mockReturnValue(true);
    const context = makeContext();

    const response = await alertAck(makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() } }), context);

    expect(response.status).toBe(500);
    expect(response.jsonBody).toMatchObject({ code: 'audit_not_configured' });
    expect(ackAlert).not.toHaveBeenCalled();
    expect(writeAuditEntry).not.toHaveBeenCalled();
    expect(context.errors.some((e) => String(e).includes('AUDIT_MISCONFIGURED'))).toBe(true);
  });
});

describe('alertAck (POST) — happy path', () => {
  it('acks, returns 204, and writes a success audit row with the reconstructed full ARM id as target', async () => {
    const context = makeContext();
    const response = await alertAck(makeRequest({ headers: { 'x-ms-client-principal': operatorHeader('op@example.com', 'entra-obj-op-1') }, body: { reason: 'investigating' } }), context);

    expect(response.status).toBe(204);
    expect(response.jsonBody).toBeUndefined();
    expect(ackAlert).toHaveBeenCalledWith(VALID_GUID, 'op@example.com', 'investigating');
    expect(buildAlertResourceId).toHaveBeenCalledWith('sub-id', VALID_GUID);

    expect(writeAuditEntry).toHaveBeenCalledTimes(1);
    const [event] = writeAuditEntry.mock.calls[0];
    expect(event).toMatchObject({
      actor: 'op@example.com',
      actorId: 'entra-obj-op-1',
      action: 'alert.ack',
      target: `/subscriptions/sub-id/providers/Microsoft.AlertsManagement/alerts/${VALID_GUID}`,
      reason: 'investigating',
      outcome: 'success',
    });
  });

  it('still returns 204 when writeAuditEntry rejects (the ack already succeeded)', async () => {
    writeAuditEntry.mockRejectedValueOnce(new Error('table unreachable'));
    const context = makeContext();

    const response = await alertAck(makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() } }), context);

    expect(response.status).toBe(204);
    expect(context.warnings.some((w) => w.includes('audit write threw unexpectedly'))).toBe(true);
  });
});

describe('alertAck (POST) — failure path', () => {
  it('returns 502 and writes a failure audit row when ackAlert rejects', async () => {
    ackAlert.mockRejectedValue(new Error('table unreachable'));
    const context = makeContext();

    const response = await alertAck(makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() } }), context);

    expect(response.status).toBe(502);
    expect(response.jsonBody).toMatchObject({ code: 'alert_ack_failed' });
    const [event] = writeAuditEntry.mock.calls[0];
    expect(event).toMatchObject({ outcome: 'failure', detail: 'table unreachable' });
  });
});

describe('alertUnack (DELETE) — role rejection and validation', () => {
  it('returns 403 for a viewer', async () => {
    const context = makeContext();
    const response = await alertUnack(makeRequest({ method: 'DELETE', headers: { 'x-ms-client-principal': viewerHeader() } }), context);

    expect(response.status).toBe(403);
    expect(unackAlert).not.toHaveBeenCalled();
  });

  it('returns 400 for an invalid alertGuid', async () => {
    isValidAlertGuid.mockReturnValue(false);
    const context = makeContext();
    const response = await alertUnack(makeRequest({ method: 'DELETE', headers: { 'x-ms-client-principal': operatorHeader() }, alertGuid: 'nope' }), context);

    expect(response.status).toBe(400);
    expect(unackAlert).not.toHaveBeenCalled();
  });
});

describe('alertUnack (DELETE) — fail-closed audit posture', () => {
  it('returns 500 and never calls unackAlert when audit is required but not configured', async () => {
    isAuditRequiredButMissing.mockReturnValue(true);
    const context = makeContext();

    const response = await alertUnack(makeRequest({ method: 'DELETE', headers: { 'x-ms-client-principal': operatorHeader() } }), context);

    expect(response.status).toBe(500);
    expect(unackAlert).not.toHaveBeenCalled();
  });
});

describe('alertUnack (DELETE) — happy + failure paths', () => {
  it('un-acks, returns 204, and writes a success audit row', async () => {
    const context = makeContext();
    const response = await alertUnack(makeRequest({ method: 'DELETE', headers: { 'x-ms-client-principal': operatorHeader('op@example.com', 'entra-obj-op-1') } }), context);

    expect(response.status).toBe(204);
    expect(unackAlert).toHaveBeenCalledWith(VALID_GUID);
    const [event] = writeAuditEntry.mock.calls[0];
    expect(event).toMatchObject({ action: 'alert.unack', outcome: 'success', actor: 'op@example.com' });
  });

  it('returns 502 and writes a failure audit row when unackAlert rejects', async () => {
    unackAlert.mockRejectedValue(new Error('table unreachable'));
    const context = makeContext();

    const response = await alertUnack(makeRequest({ method: 'DELETE', headers: { 'x-ms-client-principal': operatorHeader() } }), context);

    expect(response.status).toBe(502);
    expect(response.jsonBody).toMatchObject({ code: 'alert_unack_failed' });
  });
});
