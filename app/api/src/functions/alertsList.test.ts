import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HttpRequest, InvocationContext } from '@azure/functions';
import type { AlertSummary } from '@avdmgr/shared';

const listAlerts = vi.fn();
vi.mock('../services/alertsService', () => ({
  listAlerts: (...args: unknown[]) => listAlerts(...args),
}));

const listAlertStates = vi.fn();
const applyAlertState = vi.fn((alert: AlertSummary, entity: unknown) => (entity ? { ...alert, ackedBy: 'merged' } : alert));
const extractAlertGuid = vi.fn((id: string) => {
  const match = /\/alerts\/([0-9a-f-]{36})$/i.exec(id);
  return match?.[1];
});
vi.mock('../lib/alertState', () => ({
  listAlertStates: (...args: unknown[]) => listAlertStates(...args),
  applyAlertState: (...args: unknown[]) => applyAlertState(...args),
  extractAlertGuid: (...args: unknown[]) => extractAlertGuid(...args),
}));

const { alertsList } = await import('./alertsList');

interface FakeContext extends InvocationContext {
  warnings: string[];
  errors: unknown[];
}

function makeRequest(options: { headers?: Record<string, string>; hours?: string }): HttpRequest {
  const { headers = {}, hours } = options;
  const lower = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  const query = new Map<string, string>();
  if (hours !== undefined) query.set('hours', hours);
  return {
    method: 'GET',
    url: 'https://func-example.azurewebsites.net/api/v1/alerts',
    headers: { get: (name: string) => lower.get(name.toLowerCase()) ?? null },
    query: { get: (name: string) => query.get(name) ?? null },
    params: {},
  } as unknown as HttpRequest;
}

function makeContext(): FakeContext {
  const warnings: string[] = [];
  const errors: unknown[] = [];
  return {
    warn: (...args: unknown[]) => warnings.push(args.join(' ')),
    error: (...args: unknown[]) => errors.push(args),
    log: () => {},
    warnings,
    errors,
  } as unknown as FakeContext;
}

function encodePrincipal(principal: unknown): string {
  return Buffer.from(JSON.stringify(principal), 'utf-8').toString('base64');
}

function viewerHeader() {
  return encodePrincipal({ identityProvider: 'aad', userId: 'u1', userDetails: 'viewer@example.com', userRoles: ['viewer'] });
}

const GUID = 'a1b2c3d4-e5f6-4789-a012-3456789abcde';
const SAMPLE_ALERT: AlertSummary = {
  id: `/subscriptions/sub-id/providers/Microsoft.AlertsManagement/alerts/${GUID}`,
  name: 'High CPU',
  severity: 'Sev2',
  status: 'New',
  firedAt: '2026-08-15T10:00:00.000Z',
};

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  delete process.env.REQUIRE_BACKEND_SECRET;
  listAlerts.mockReset().mockResolvedValue([SAMPLE_ALERT]);
  listAlertStates.mockReset().mockResolvedValue(new Map());
  applyAlertState.mockClear();
  extractAlertGuid.mockClear();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('alertsList — role gating', () => {
  it('returns 401 for an unauthenticated caller and never calls listAlerts', async () => {
    const context = makeContext();
    const response = await alertsList(makeRequest({}), context);

    expect(response.status).toBe(401);
    expect(listAlerts).not.toHaveBeenCalled();
  });

  it('allows a viewer', async () => {
    const context = makeContext();
    const response = await alertsList(makeRequest({ headers: { 'x-ms-client-principal': viewerHeader() } }), context);

    expect(response.status).toBe(200);
  });
});

describe('alertsList — hours validation', () => {
  it('returns 400 for an out-of-range hours value', async () => {
    const context = makeContext();
    const response = await alertsList(makeRequest({ headers: { 'x-ms-client-principal': viewerHeader() }, hours: '999' }), context);

    expect(response.status).toBe(400);
    expect(listAlerts).not.toHaveBeenCalled();
  });

  it('defaults to 24 when hours is omitted', async () => {
    const context = makeContext();
    await alertsList(makeRequest({ headers: { 'x-ms-client-principal': viewerHeader() } }), context);

    expect(listAlerts).toHaveBeenCalledWith(24);
  });
});

describe('alertsList — happy path', () => {
  it('returns { alerts, degraded: false } with state merged in when the Table lookup succeeds', async () => {
    listAlertStates.mockResolvedValue(new Map([[GUID, { partitionKey: 'alert', rowKey: GUID }]]));
    const context = makeContext();

    const response = await alertsList(makeRequest({ headers: { 'x-ms-client-principal': viewerHeader() } }), context);

    expect(response.status).toBe(200);
    expect(response.jsonBody).toMatchObject({ degraded: false });
    const body = response.jsonBody as { alerts: AlertSummary[]; degraded: boolean };
    expect(body.alerts).toHaveLength(1);
    expect(body.alerts[0].ackedBy).toBe('merged');
  });
});

describe('alertsList — degrade branch (peer review item 6/12)', () => {
  it('sets degraded: true and still returns the alerts (unmerged) when listAlertStates rejects', async () => {
    listAlertStates.mockRejectedValue(new Error('table unreachable'));
    const context = makeContext();

    const response = await alertsList(makeRequest({ headers: { 'x-ms-client-principal': viewerHeader() } }), context);

    expect(response.status).toBe(200);
    const body = response.jsonBody as { alerts: AlertSummary[]; degraded: boolean };
    expect(body.degraded).toBe(true);
    expect(body.alerts).toHaveLength(1);
    expect(body.alerts[0].id).toBe(SAMPLE_ALERT.id);
    expect(context.warnings.some((w) => w.includes('alert state lookup failed'))).toBe(true);
  });

  it('does NOT set degraded when listAlertStates succeeds but returns an empty map (genuinely no state yet, not a failure)', async () => {
    listAlertStates.mockResolvedValue(new Map());
    const context = makeContext();

    const response = await alertsList(makeRequest({ headers: { 'x-ms-client-principal': viewerHeader() } }), context);

    const body = response.jsonBody as { degraded: boolean };
    expect(body.degraded).toBe(false);
  });
});

describe('alertsList — malformed alert id (peer review item 12)', () => {
  it('warns and skips the ack/snooze lookup for an alert whose id does not match the expected ARM shape, without failing the request', async () => {
    const malformedAlert: AlertSummary = { ...SAMPLE_ALERT, id: '/not/a/valid/alert/id' };
    listAlerts.mockResolvedValue([malformedAlert]);
    const context = makeContext();

    const response = await alertsList(makeRequest({ headers: { 'x-ms-client-principal': viewerHeader() } }), context);

    expect(response.status).toBe(200);
    const body = response.jsonBody as { alerts: AlertSummary[] };
    expect(body.alerts).toEqual([malformedAlert]);
    expect(applyAlertState).not.toHaveBeenCalled();
    expect(context.warnings.some((w) => w.includes('alert id did not match the expected ARM resource id shape') && w.includes(malformedAlert.id))).toBe(true);
  });
});

describe('alertsList — upstream failure', () => {
  it('returns 502 when listAlerts itself rejects', async () => {
    listAlerts.mockRejectedValue(new Error('ARM unavailable'));
    const context = makeContext();

    const response = await alertsList(makeRequest({ headers: { 'x-ms-client-principal': viewerHeader() } }), context);

    expect(response.status).toBe(502);
    expect(response.jsonBody).toMatchObject({ code: 'alerts_list_failed' });
  });
});
