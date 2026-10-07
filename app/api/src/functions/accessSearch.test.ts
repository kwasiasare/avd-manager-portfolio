import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HttpRequest, InvocationContext } from '@azure/functions';

const searchPrincipals = vi.fn();
vi.mock('../services/accessService', () => ({
  searchPrincipals: (...args: unknown[]) => searchPrincipals(...args),
}));

const { accessSearch } = await import('./accessSearch');

interface FakeContext extends InvocationContext {
  warnings: string[];
  errors: unknown[];
}

function makeRequest(options: { headers?: Record<string, string>; q?: string | null }): HttpRequest {
  const { headers = {}, q } = options;
  const lower = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  const queryMap = new Map<string, string>();
  if (q !== undefined && q !== null) {
    queryMap.set('q', q);
  }
  return {
    url: 'https://func-example.azurewebsites.net/api/v1/access/search',
    headers: { get: (name: string) => lower.get(name.toLowerCase()) ?? null },
    query: { get: (name: string) => queryMap.get(name) ?? null },
    params: {},
  } as unknown as HttpRequest;
}

function makeContext(): FakeContext {
  const warnings: string[] = [];
  const errors: unknown[] = [];
  return {
    warn: (...args: unknown[]) => warnings.push(args.join(' ')),
    error: (...args: unknown[]) => errors.push(args),
    log: (..._args: unknown[]) => {},
    warnings,
    errors,
  } as unknown as FakeContext;
}

function encodePrincipal(principal: unknown): string {
  return Buffer.from(JSON.stringify(principal), 'utf-8').toString('base64');
}

function operatorHeader() {
  return encodePrincipal({ identityProvider: 'aad', userId: 'entra-obj-id-op', userDetails: 'operator@example.com', userRoles: ['operator'] });
}

function viewerHeader() {
  return encodePrincipal({ identityProvider: 'aad', userId: 'u1', userDetails: 'viewer@example.com', userRoles: ['viewer'] });
}

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  delete process.env.REQUIRE_BACKEND_SECRET;
  searchPrincipals.mockReset();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('accessSearch — role gate', () => {
  it('returns 403 for a viewer (this endpoint requires operator+)', async () => {
    const context = makeContext();
    const response = await accessSearch(makeRequest({ headers: { 'x-ms-client-principal': viewerHeader() }, q: 'alice' }), context);
    expect(response.status).toBe(403);
    expect(searchPrincipals).not.toHaveBeenCalled();
  });

  it('returns 401 for an unauthenticated caller', async () => {
    const context = makeContext();
    const response = await accessSearch(makeRequest({ q: 'alice' }), context);
    expect(response.status).toBe(401);
    expect(searchPrincipals).not.toHaveBeenCalled();
  });
});

describe('accessSearch — validation', () => {
  it('returns 400 when q is missing', async () => {
    const context = makeContext();
    const response = await accessSearch(makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() } }), context);
    expect(response.status).toBe(400);
    expect(searchPrincipals).not.toHaveBeenCalled();
  });

  it('returns 400 when q is shorter than the minimum length', async () => {
    const context = makeContext();
    const response = await accessSearch(makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() }, q: 'a' }), context);
    expect(response.status).toBe(400);
    expect(response.jsonBody).toMatchObject({ code: 'query_too_short' });
  });

  it('returns 400 when q exceeds the maximum length', async () => {
    const context = makeContext();
    const response = await accessSearch(makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() }, q: 'x'.repeat(101) }), context);
    expect(response.status).toBe(400);
    expect(response.jsonBody).toMatchObject({ code: 'query_too_long' });
  });
});

describe('accessSearch — success/failure', () => {
  it('returns 200 with the search service result for a valid query', async () => {
    searchPrincipals.mockResolvedValue({ results: [{ id: 'u1', principalType: 'user', displayName: 'Alice' }], graphAvailable: true });
    const context = makeContext();
    const response = await accessSearch(makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() }, q: 'alice' }), context);
    expect(response.status).toBe(200);
    expect(response.jsonBody).toMatchObject({ graphAvailable: true });
    expect(searchPrincipals).toHaveBeenCalledWith('alice');
  });

  it('passes through a graceful graph-not-granted degradation as a 200, not an error', async () => {
    searchPrincipals.mockResolvedValue({ results: [], graphAvailable: false, graphDegradationReason: 'graph-permission-not-granted' });
    const context = makeContext();
    const response = await accessSearch(makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() }, q: 'alice' }), context);
    expect(response.status).toBe(200);
    expect(response.jsonBody).toMatchObject({ graphAvailable: false, graphDegradationReason: 'graph-permission-not-granted' });
  });

  it('returns 502 when the search service throws unexpectedly', async () => {
    searchPrincipals.mockRejectedValue(new Error('boom'));
    const context = makeContext();
    const response = await accessSearch(makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() }, q: 'alice' }), context);
    expect(response.status).toBe(502);
  });
});
