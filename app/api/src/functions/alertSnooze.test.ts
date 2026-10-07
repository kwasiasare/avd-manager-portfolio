import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HttpRequest, InvocationContext } from '@azure/functions';

const snoozeAlert = vi.fn().mockResolvedValue(undefined);
const unsnoozeAlert = vi.fn().mockResolvedValue(undefined);
const isValidAlertGuid = vi.fn((value: unknown) => typeof value === 'string' && /^[0-9a-f-]{36}$/i.test(value));
const buildAlertResourceId = vi.fn((subscriptionId: string, guid: string) => `/subscriptions/${subscriptionId}/providers/Microsoft.AlertsManagement/alerts/${guid}`);
const resolveSnoozeUntil = vi.fn();

vi.mock('../lib/alertState', () => ({
  snoozeAlert: (...args: unknown[]) => snoozeAlert(...args),
  unsnoozeAlert: (...args: unknown[]) => unsnoozeAlert(...args),
  isValidAlertGuid: (...args: unknown[]) => isValidAlertGuid(...args),
  buildAlertResourceId: (...args: unknown[]) => buildAlertResourceId(...args),
  resolveSnoozeUntil: (...args: unknown[]) => resolveSnoozeUntil(...args),
}));

const writeAuditEntry = vi.fn().mockResolvedValue(undefined);
const isAuditRequiredButMissing = vi.fn().mockReturnValue(false);
vi.mock('../lib/auditLog', () => ({
  writeAuditEntry: (...args: unknown[]) => writeAuditEntry(...args),
  isAuditRequiredButMissing: (...args: unknown[]) => isAuditRequiredButMissing(...args),
}));

const { alertSnooze, alertUnsnooze } = await import('./alertSnooze');

interface FakeContext extends InvocationContext {
  warnings: string[];
  errors: unknown[];
  logs: string[];
}

const VALID_GUID = 'a1b2c3d4-e5f6-4789-a012-3456789abcde';
const UNTIL_ISO = '2026-08-16T00:00:00.000Z';

function makeRequest(options: { method?: string; headers?: Record<string, string>; alertGuid?: string; body?: unknown; jsonThrows?: boolean }): HttpRequest {
  const { method = 'POST', headers = {}, alertGuid = VALID_GUID, body = { hours: 4 }, jsonThrows = false } = options;
  const lower = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  return {
    method,
    url: `https://func-example.azurewebsites.net/api/v1/alerts/${alertGuid}/snooze`,
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
  // getConfig() (via getConfig().subscriptionId in alertSnooze.ts/buildAlertResourceId) requires these — readEnv has no fallback for them.
  process.env.RG_HOSTPOOLS = 'RG-AVD-HostPools';
  process.env.HOSTPOOL_NAME = 'HP-CONTOSO-PROD';
  delete process.env.REQUIRE_BACKEND_SECRET;
  snoozeAlert.mockReset().mockResolvedValue(undefined);
  unsnoozeAlert.mockReset().mockResolvedValue(undefined);
  isValidAlertGuid.mockReset().mockImplementation((value: unknown) => typeof value === 'string' && /^[0-9a-f-]{36}$/i.test(value));
  buildAlertResourceId.mockReset().mockImplementation((subscriptionId: string, guid: string) => `/subscriptions/${subscriptionId}/providers/Microsoft.AlertsManagement/alerts/${guid}`);
  resolveSnoozeUntil.mockReset().mockReturnValue({ ok: true, untilIso: UNTIL_ISO });
  writeAuditEntry.mockReset().mockResolvedValue(undefined);
  isAuditRequiredButMissing.mockReset().mockReturnValue(false);
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('alertSnooze (POST) — role rejection path', () => {
  it('returns 403 for a viewer and never calls snoozeAlert', async () => {
    const context = makeContext();
    const response = await alertSnooze(makeRequest({ headers: { 'x-ms-client-principal': viewerHeader() } }), context);

    expect(response.status).toBe(403);
    expect(snoozeAlert).not.toHaveBeenCalled();
    expect(writeAuditEntry).not.toHaveBeenCalled();
  });

  it('returns 401 for an unauthenticated caller', async () => {
    const context = makeContext();
    const response = await alertSnooze(makeRequest({}), context);

    expect(response.status).toBe(401);
    expect(snoozeAlert).not.toHaveBeenCalled();
  });
});

describe('alertSnooze (POST) — validation', () => {
  it('returns 400 for an invalid alertGuid', async () => {
    isValidAlertGuid.mockReturnValue(false);
    const context = makeContext();
    const response = await alertSnooze(makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() }, alertGuid: 'nope' }), context);

    expect(response.status).toBe(400);
    expect(response.jsonBody).toMatchObject({ code: 'invalid_alert_id' });
    expect(snoozeAlert).not.toHaveBeenCalled();
  });

  it('returns 400 for a malformed JSON body', async () => {
    const context = makeContext();
    const response = await alertSnooze(makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() }, jsonThrows: true }), context);

    expect(response.status).toBe(400);
    expect(response.jsonBody).toMatchObject({ code: 'invalid_body' });
  });

  // Peer review item 7: reason validation was previously MISSING on this
  // route entirely (it existed on alertAck.ts but not here).
  it('returns 400 when reason exceeds 1000 characters, and never calls resolveSnoozeUntil/snoozeAlert', async () => {
    const context = makeContext();
    const response = await alertSnooze(makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() }, body: { hours: 4, reason: 'x'.repeat(1001) } }), context);

    expect(response.status).toBe(400);
    expect(response.jsonBody).toMatchObject({ code: 'reason_too_long' });
    expect(resolveSnoozeUntil).not.toHaveBeenCalled();
    expect(snoozeAlert).not.toHaveBeenCalled();
  });

  it('returns 400 when reason is not a string', async () => {
    const context = makeContext();
    const response = await alertSnooze(makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() }, body: { hours: 4, reason: 42 } }), context);

    expect(response.status).toBe(400);
    expect(response.jsonBody).toMatchObject({ code: 'invalid_reason' });
  });

  it('propagates a resolveSnoozeUntil validation failure as the response', async () => {
    resolveSnoozeUntil.mockReturnValue({ ok: false, error: { status: 400, code: 'snooze_hours_out_of_range', message: 'hours must be between 1 and 168.' } });
    const context = makeContext();
    const response = await alertSnooze(makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() }, body: { hours: 999 } }), context);

    expect(response.status).toBe(400);
    expect(response.jsonBody).toMatchObject({ code: 'snooze_hours_out_of_range' });
    expect(snoozeAlert).not.toHaveBeenCalled();
  });
});

describe('alertSnooze (POST) — fail-closed audit posture', () => {
  it('returns 500 and never calls snoozeAlert when audit is required but not configured', async () => {
    isAuditRequiredButMissing.mockReturnValue(true);
    const context = makeContext();

    const response = await alertSnooze(makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() } }), context);

    expect(response.status).toBe(500);
    expect(response.jsonBody).toMatchObject({ code: 'audit_not_configured' });
    expect(snoozeAlert).not.toHaveBeenCalled();
  });
});

describe('alertSnooze (POST) — happy + failure paths', () => {
  it('snoozes, returns 204, and writes a success audit row with untilIso in parameters', async () => {
    const context = makeContext();
    const response = await alertSnooze(makeRequest({ headers: { 'x-ms-client-principal': operatorHeader('op@example.com', 'entra-obj-op-1') }, body: { hours: 4, reason: 'known issue' } }), context);

    expect(response.status).toBe(204);
    expect(snoozeAlert).toHaveBeenCalledWith(VALID_GUID, 'op@example.com', UNTIL_ISO, 'known issue');

    const [event] = writeAuditEntry.mock.calls[0];
    expect(event).toMatchObject({
      action: 'alert.snooze',
      target: `/subscriptions/sub-id/providers/Microsoft.AlertsManagement/alerts/${VALID_GUID}`,
      parameters: { untilIso: UNTIL_ISO },
      reason: 'known issue',
      outcome: 'success',
    });
  });

  it('returns 502 and writes a failure audit row when snoozeAlert rejects', async () => {
    snoozeAlert.mockRejectedValue(new Error('table unreachable'));
    const context = makeContext();

    const response = await alertSnooze(makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() } }), context);

    expect(response.status).toBe(502);
    expect(response.jsonBody).toMatchObject({ code: 'alert_snooze_failed' });
    const [event] = writeAuditEntry.mock.calls[0];
    expect(event).toMatchObject({ outcome: 'failure', detail: 'table unreachable' });
  });
});

describe('alertUnsnooze (DELETE)', () => {
  it('returns 403 for a viewer', async () => {
    const context = makeContext();
    const response = await alertUnsnooze(makeRequest({ method: 'DELETE', headers: { 'x-ms-client-principal': viewerHeader() } }), context);

    expect(response.status).toBe(403);
    expect(unsnoozeAlert).not.toHaveBeenCalled();
  });

  it('returns 400 for an invalid alertGuid', async () => {
    isValidAlertGuid.mockReturnValue(false);
    const context = makeContext();
    const response = await alertUnsnooze(makeRequest({ method: 'DELETE', headers: { 'x-ms-client-principal': operatorHeader() }, alertGuid: 'nope' }), context);

    expect(response.status).toBe(400);
    expect(unsnoozeAlert).not.toHaveBeenCalled();
  });

  it('returns 500 when audit is required but not configured', async () => {
    isAuditRequiredButMissing.mockReturnValue(true);
    const context = makeContext();
    const response = await alertUnsnooze(makeRequest({ method: 'DELETE', headers: { 'x-ms-client-principal': operatorHeader() } }), context);

    expect(response.status).toBe(500);
    expect(unsnoozeAlert).not.toHaveBeenCalled();
  });

  it('un-snoozes, returns 204, and writes a success audit row', async () => {
    const context = makeContext();
    const response = await alertUnsnooze(makeRequest({ method: 'DELETE', headers: { 'x-ms-client-principal': operatorHeader('op@example.com', 'entra-obj-op-1') } }), context);

    expect(response.status).toBe(204);
    expect(unsnoozeAlert).toHaveBeenCalledWith(VALID_GUID);
    const [event] = writeAuditEntry.mock.calls[0];
    expect(event).toMatchObject({ action: 'alert.unsnooze', outcome: 'success' });
  });

  it('returns 502 and writes a failure audit row when unsnoozeAlert rejects', async () => {
    unsnoozeAlert.mockRejectedValue(new Error('table unreachable'));
    const context = makeContext();
    const response = await alertUnsnooze(makeRequest({ method: 'DELETE', headers: { 'x-ms-client-principal': operatorHeader() } }), context);

    expect(response.status).toBe(502);
    expect(response.jsonBody).toMatchObject({ code: 'alert_unsnooze_failed' });
  });
});
