import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HttpRequest, InvocationContext } from '@azure/functions';
import type { IntunePolicyHealthResponse } from '@avdmgr/shared';

const listSessionHosts = vi.fn();
vi.mock('../services/avdService', () => ({
  listSessionHosts: (...args: unknown[]) => listSessionHosts(...args),
}));

const getIntunePolicyHealth = vi.fn();
vi.mock('../services/intunePolicyHealthService', () => ({
  getIntunePolicyHealth: (...args: unknown[]) => getIntunePolicyHealth(...args),
}));

// Imported AFTER the mocks above so the handler picks up the mocked modules.
const { hostPoolPolicyHealth } = await import('./hostPoolPolicyHealth');

function makeRequest(options: { headers?: Record<string, string>; hostPoolName?: string } = {}): HttpRequest {
  const { headers = {}, hostPoolName = 'HP-CONTOSO-PROD' } = options;
  const lower = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  return {
    url: 'https://func-example.azurewebsites.net/api/v1/hostpools/HP-CONTOSO-PROD/policy-health',
    headers: { get: (name: string) => lower.get(name.toLowerCase()) ?? null },
    params: { hostPoolName },
  } as unknown as HttpRequest;
}

function makeContext(): InvocationContext {
  return { warn: () => {}, error: () => {}, log: () => {} } as unknown as InvocationContext;
}

function encodePrincipal(principal: unknown): string {
  return Buffer.from(JSON.stringify(principal), 'utf-8').toString('base64');
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
  listSessionHosts.mockReset();
  getIntunePolicyHealth.mockReset();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('hostPoolPolicyHealth — RBAC (viewer+)', () => {
  it('returns 401 for an unauthenticated caller, never calling either service', async () => {
    const response = await hostPoolPolicyHealth(makeRequest(), makeContext());
    expect(response.status).toBe(401);
    expect(listSessionHosts).not.toHaveBeenCalled();
    expect(getIntunePolicyHealth).not.toHaveBeenCalled();
  });

  it('allows a viewer (read-only endpoint, no operator+ floor)', async () => {
    listSessionHosts.mockResolvedValue([{ id: '1', name: 'avd-con-1' }]);
    const result: IntunePolicyHealthResponse = { hosts: [], generatedAt: '2026-08-22T00:00:00Z', cached: false };
    getIntunePolicyHealth.mockResolvedValue(result);

    const response = await hostPoolPolicyHealth(makeRequest({ headers: { 'x-ms-client-principal': viewerHeader() } }), makeContext());

    expect(response.status).toBe(200);
    expect(response.jsonBody).toEqual(result);
  });
});

describe('hostPoolPolicyHealth — host pool scoping', () => {
  it('returns 404 (host_pool_not_managed) for an unmanaged host pool, without calling either service', async () => {
    const response = await hostPoolPolicyHealth(
      makeRequest({ headers: { 'x-ms-client-principal': viewerHeader() }, hostPoolName: 'HP-SOME-OTHER-POOL' }),
      makeContext(),
    );
    expect(response.status).toBe(404);
    expect(listSessionHosts).not.toHaveBeenCalled();
    expect(getIntunePolicyHealth).not.toHaveBeenCalled();
  });
});

describe('hostPoolPolicyHealth — composition', () => {
  it('resolves session hosts with resolvePowerState:false (this endpoint has no use for VM power state) and passes their names through', async () => {
    listSessionHosts.mockResolvedValue([{ id: '1', name: 'avd-con-1' }, { id: '2', name: 'avd-con-2' }]);
    getIntunePolicyHealth.mockResolvedValue({ hosts: [], generatedAt: '2026-08-22T00:00:00Z', cached: false });

    await hostPoolPolicyHealth(makeRequest({ headers: { 'x-ms-client-principal': viewerHeader() } }), makeContext());

    expect(listSessionHosts).toHaveBeenCalledWith('HP-CONTOSO-PROD', expect.objectContaining({ resolvePowerState: false }));
    expect(getIntunePolicyHealth).toHaveBeenCalledWith(['avd-con-1', 'avd-con-2'], expect.anything());
  });

  it('passes a degraded (graph-not-granted) result straight through as a 200, not an error', async () => {
    listSessionHosts.mockResolvedValue([{ id: '1', name: 'avd-con-1' }]);
    const degraded: IntunePolicyHealthResponse = {
      hosts: [{ hostName: 'avd-con-1', status: 'unknown', evidence: { admxSignatureDetectable: false } }],
      degradation: 'graph-permission-not-granted',
      generatedAt: '2026-08-22T00:00:00Z',
      cached: false,
    };
    getIntunePolicyHealth.mockResolvedValue(degraded);

    const response = await hostPoolPolicyHealth(makeRequest({ headers: { 'x-ms-client-principal': viewerHeader() } }), makeContext());

    expect(response.status).toBe(200);
    expect(response.jsonBody).toEqual(degraded);
  });
});

describe('hostPoolPolicyHealth — failure mapping', () => {
  it('returns 502 when listSessionHosts throws', async () => {
    listSessionHosts.mockRejectedValue(new Error('ARM unreachable'));
    const response = await hostPoolPolicyHealth(makeRequest({ headers: { 'x-ms-client-principal': viewerHeader() } }), makeContext());
    expect(response.status).toBe(502);
    expect(response.jsonBody).toMatchObject({ code: 'policy_health_failed' });
    expect(getIntunePolicyHealth).not.toHaveBeenCalled();
  });

  it('returns 502 when getIntunePolicyHealth throws unexpectedly', async () => {
    listSessionHosts.mockResolvedValue([{ id: '1', name: 'avd-con-1' }]);
    getIntunePolicyHealth.mockRejectedValue(new Error('boom'));
    const response = await hostPoolPolicyHealth(makeRequest({ headers: { 'x-ms-client-principal': viewerHeader() } }), makeContext());
    expect(response.status).toBe(502);
    expect(response.jsonBody).toMatchObject({ code: 'policy_health_failed' });
  });
});
