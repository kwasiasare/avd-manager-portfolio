import { describe, expect, it, vi } from 'vitest';
import type { HttpRequest, InvocationContext } from '@azure/functions';
import type { EstateSummaryResponse } from '@avdmgr/shared';

const getEstateSummary = vi.fn();
vi.mock('../services/estateSummaryService', () => ({
  getEstateSummary: (...args: unknown[]) => getEstateSummary(...args),
}));

const { estateSummary } = await import('./estateSummary');

function encodePrincipal(principal: unknown): string {
  return Buffer.from(JSON.stringify(principal), 'utf-8').toString('base64');
}

function makeRequest(headers: Record<string, string> = {}): HttpRequest {
  const lower = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  return {
    method: 'GET',
    url: 'https://func-example.azurewebsites.net/api/v1/estate/summary',
    headers: { get: (name: string) => lower.get(name.toLowerCase()) ?? null },
    params: {},
  } as unknown as HttpRequest;
}

function makeContext(): InvocationContext {
  return {
    warn: vi.fn(),
    error: vi.fn(),
    log: vi.fn(),
  } as unknown as InvocationContext;
}

const SAMPLE: EstateSummaryResponse = {
  generatedAt: '2026-08-16T00:00:00.000Z',
  hostPoolName: 'HP-CONTOSO-PROD',
  hosts: { available: 5, total: 6 },
  sessions: { used: 12, capacity: 48 },
  scalingPhase: 'Peak',
  openAlertCount: 2,
  overrideActive: false,
};

describe('estateSummary handler', () => {
  it('rejects an unauthenticated request', async () => {
    getEstateSummary.mockClear();
    const result = await estateSummary(makeRequest(), makeContext());
    expect(result.status).toBe(401);
    expect(getEstateSummary).not.toHaveBeenCalled();
  });

  it('allows a viewer (role gate is viewer+, not operator+)', async () => {
    getEstateSummary.mockClear().mockResolvedValue(SAMPLE);
    const headers = { 'x-ms-client-principal': encodePrincipal({ identityProvider: 'aad', userId: 'u1', userDetails: 'viewer@example.com', userRoles: ['viewer'] }) };
    const result = await estateSummary(makeRequest(headers), makeContext());
    expect(result.status).toBe(200);
  });

  it('returns the summary shape from the service, unmodified, for an authorized caller', async () => {
    getEstateSummary.mockClear().mockResolvedValue(SAMPLE);
    const headers = { 'x-ms-client-principal': encodePrincipal({ identityProvider: 'aad', userId: 'u1', userDetails: 'operator@example.com', userRoles: ['operator'] }) };
    const result = await estateSummary(makeRequest(headers), makeContext());
    expect(result.status).toBe(200);
    expect(result.jsonBody).toEqual(SAMPLE);
  });

  it('degrades to a 502 only if the service itself throws unexpectedly', async () => {
    getEstateSummary.mockClear().mockRejectedValue(new Error('unexpected'));
    const headers = { 'x-ms-client-principal': encodePrincipal({ identityProvider: 'aad', userId: 'u1', userDetails: 'admin@example.com', userRoles: ['admin'] }) };
    const result = await estateSummary(makeRequest(headers), makeContext());
    expect(result.status).toBe(502);
  });
});
