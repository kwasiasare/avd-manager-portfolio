import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HttpRequest, InvocationContext } from '@azure/functions';
import type { CostSummary } from '@avdmgr/shared';

const getCostSummary = vi.fn();
vi.mock('../services/costService', () => ({
  getCostSummary: (...args: unknown[]) => getCostSummary(...args),
}));

const { costSummary } = await import('./costSummary');

interface FakeContext extends InvocationContext {
  warnings: string[];
  errors: unknown[][];
}

function makeRequest(headers: Record<string, string> = {}): HttpRequest {
  const lower = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  return {
    method: 'GET',
    url: 'https://func-example.azurewebsites.net/api/v1/cost/summary',
    headers: { get: (name: string) => lower.get(name.toLowerCase()) ?? null },
    query: { get: () => null },
    params: {},
  } as unknown as HttpRequest;
}

function makeContext(): FakeContext {
  const warnings: string[] = [];
  const errors: unknown[][] = [];
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

const FRESH_SUMMARY: CostSummary = {
  currency: 'USD',
  asOfDate: '2026-08-19',
  monthToDateCost: 100,
  byResourceGroup: [],
  computedAt: '2026-08-20T00:00:00.000Z',
};

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  getCostSummary.mockReset();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('costSummary handler — AM-40 peer review MINOR 3', () => {
  it('returns 200 with the fresh summary and does NOT log COST_STALE_SERVED', async () => {
    getCostSummary.mockResolvedValue(FRESH_SUMMARY);
    const context = makeContext();

    const response = await costSummary(makeRequest({ 'x-ms-client-principal': viewerHeader() }), context);

    expect(response.status).toBe(200);
    expect(response.jsonBody).toEqual(FRESH_SUMMARY);
    expect(context.errors.some((call) => String(call[0]).includes('COST_STALE_SERVED'))).toBe(false);
  });

  it('returns 200 with a stale summary AND logs a greppable COST_STALE_SERVED marker at context.error (so it stays alertable despite being a 200, not a 5xx)', async () => {
    const staleSummary: CostSummary = { ...FRESH_SUMMARY, stale: true };
    getCostSummary.mockResolvedValue(staleSummary);
    const context = makeContext();

    const response = await costSummary(makeRequest({ 'x-ms-client-principal': viewerHeader() }), context);

    expect(response.status).toBe(200);
    expect(response.jsonBody).toEqual(staleSummary);
    expect(context.errors.some((call) => String(call[0]).includes('COST_STALE_SERVED') && String(call[0]).includes(staleSummary.computedAt))).toBe(true);
  });

  it('returns 502 (not 200) when getCostSummary itself throws — no cached value has ever existed', async () => {
    getCostSummary.mockRejectedValue(new Error('Cost Management unavailable'));
    const context = makeContext();

    const response = await costSummary(makeRequest({ 'x-ms-client-principal': viewerHeader() }), context);

    expect(response.status).toBe(502);
  });
});
