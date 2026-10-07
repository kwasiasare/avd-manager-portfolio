import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HttpRequest, InvocationContext } from '@azure/functions';

const queryRecentAuditEntries = vi.fn();
vi.mock('../lib/auditLog', () => ({
  queryRecentAuditEntries: (...args: unknown[]) => queryRecentAuditEntries(...args),
}));

const { scalingHistory } = await import('./scalingHistory');

function makeContext(): InvocationContext {
  return { warn: () => {}, error: () => {}, log: () => {} } as unknown as InvocationContext;
}
function encodePrincipal(principal: unknown): string {
  return Buffer.from(JSON.stringify(principal), 'utf-8').toString('base64');
}
function viewerHeader() {
  return encodePrincipal({ identityProvider: 'aad', userId: 'v1', userDetails: 'viewer@example.com', userRoles: ['viewer'] });
}

function makeRequest(headers: Record<string, string> = {}): HttpRequest {
  const lower = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    method: 'GET',
    url: 'https://func-example.azurewebsites.net/api/v1/scalingplans/current/history',
    headers: { get: (name: string) => lower.get(name.toLowerCase()) ?? null },
    params: {},
    json: async () => undefined,
  } as unknown as HttpRequest;
}

beforeEach(() => {
  queryRecentAuditEntries.mockReset().mockResolvedValue([]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('scalingHistory — role', () => {
  it('401s an unauthenticated caller', async () => {
    const response = await scalingHistory(makeRequest(), makeContext());
    expect(response.status).toBe(401);
    expect(queryRecentAuditEntries).not.toHaveBeenCalled();
  });

  it('200s for a viewer (read-only)', async () => {
    const response = await scalingHistory(makeRequest({ 'x-ms-client-principal': viewerHeader() }), makeContext());
    expect(response.status).toBe(200);
  });
});

describe('scalingHistory — query + mapping', () => {
  it('queries with the "scalingplan." prefix and a limit of 10', async () => {
    await scalingHistory(makeRequest({ 'x-ms-client-principal': viewerHeader() }), makeContext());
    expect(queryRecentAuditEntries).toHaveBeenCalledWith('scalingplan.', 10, expect.anything());
  });

  it('maps AuditEntity rows to ScalingHistoryEntry, parsing parametersJson', async () => {
    queryRecentAuditEntries.mockResolvedValue([
      {
        partitionKey: '2026-08-15',
        rowKey: 'x',
        actor: 'op@example.com',
        actorId: 'id-1',
        action: 'scalingplan.schedule.update',
        target: 'SCALE-CONTOSO-PROD/AllDays',
        parametersJson: JSON.stringify({ before: { rampUpCapacityThresholdPct: 60 }, after: { rampUpCapacityThresholdPct: 65 } }),
        reason: 'tune ramp-up',
        outcome: 'success',
        correlationId: 'corr-1',
        occurredAt: '2026-08-15T12:00:00.000Z',
      },
    ]);

    const response = await scalingHistory(makeRequest({ 'x-ms-client-principal': viewerHeader() }), makeContext());
    expect(response.status).toBe(200);
    const body = response.jsonBody as { entries: Array<Record<string, unknown>> };
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0]).toMatchObject({
      id: 'corr-1',
      actor: 'op@example.com',
      action: 'scalingplan.schedule.update',
      target: 'SCALE-CONTOSO-PROD/AllDays',
      outcome: 'success',
      reason: 'tune ramp-up',
      parameters: { before: { rampUpCapacityThresholdPct: 60 }, after: { rampUpCapacityThresholdPct: 65 } },
    });
  });

  it('degrades parameters to undefined for malformed parametersJson rather than failing the whole read', async () => {
    queryRecentAuditEntries.mockResolvedValue([
      { partitionKey: '2026-08-15', rowKey: 'x', actor: 'a', actorId: 'id', action: 'scalingplan.schedule.update', target: 't', parametersJson: '{not json', outcome: 'success', correlationId: 'c1', occurredAt: '2026-08-15T12:00:00.000Z' },
    ]);
    const response = await scalingHistory(makeRequest({ 'x-ms-client-principal': viewerHeader() }), makeContext());
    expect(response.status).toBe(200);
    const body = response.jsonBody as { entries: Array<{ parameters?: unknown }> };
    expect(body.entries[0].parameters).toBeUndefined();
  });

  it('never includes `detail` on a mapped entry, even when the underlying AuditEntity row carries one (peer review — viewer+ surface, ARM error text stays operator-only)', async () => {
    queryRecentAuditEntries.mockResolvedValue([
      { partitionKey: '2026-08-15', rowKey: 'x', actor: 'a', actorId: 'id', action: 'scalingplan.schedule.update', target: 't', outcome: 'failure', detail: 'ARM 403: AuthorizationFailed for internal role xyz', correlationId: 'c1', occurredAt: '2026-08-15T12:00:00.000Z' },
    ]);
    const response = await scalingHistory(makeRequest({ 'x-ms-client-principal': viewerHeader() }), makeContext());
    const body = response.jsonBody as { entries: Array<Record<string, unknown>> };
    expect(body.entries[0]).not.toHaveProperty('detail');
  });

  it('excludes a FAILED auto-re-enable row from the projection', async () => {
    queryRecentAuditEntries.mockResolvedValue([
      { partitionKey: '2026-08-15', rowKey: 'x', actor: 'system:auto-reenable', actorId: 'system', action: 'scalingplan.emergency_override.auto_reenable', target: 'SCALE-CONTOSO-PROD', outcome: 'failure', correlationId: 'c1', occurredAt: '2026-08-15T12:00:00.000Z' },
    ]);
    const response = await scalingHistory(makeRequest({ 'x-ms-client-principal': viewerHeader() }), makeContext());
    const body = response.jsonBody as { entries: unknown[] };
    expect(body.entries).toHaveLength(0);
  });

  it('still includes a SUCCESSFUL auto-re-enable row (a real state change, not noise)', async () => {
    queryRecentAuditEntries.mockResolvedValue([
      { partitionKey: '2026-08-15', rowKey: 'x', actor: 'system:auto-reenable', actorId: 'system', action: 'scalingplan.emergency_override.auto_reenable', target: 'SCALE-CONTOSO-PROD', outcome: 'success', correlationId: 'c1', occurredAt: '2026-08-15T12:00:00.000Z' },
    ]);
    const response = await scalingHistory(makeRequest({ 'x-ms-client-principal': viewerHeader() }), makeContext());
    const body = response.jsonBody as { entries: unknown[] };
    expect(body.entries).toHaveLength(1);
  });
});
