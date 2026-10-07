import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HttpRequest, InvocationContext } from '@azure/functions';
import type { VmTemplateInfo } from '@avdmgr/shared';

const getVmTemplateInfo = vi.fn();
vi.mock('../services/avdService', () => ({
  getVmTemplateInfo: (...args: unknown[]) => getVmTemplateInfo(...args),
}));

// Imported AFTER the mock above so the handler picks up the mocked module.
const { hostPoolVmTemplate } = await import('./hostPoolVmTemplate');

function makeRequest(options: { headers?: Record<string, string>; hostPoolName?: string } = {}): HttpRequest {
  const { headers = {}, hostPoolName = 'HP-CONTOSO-PROD' } = options;
  const lower = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  return {
    url: 'https://func-example.azurewebsites.net/api/v1/hostpools/HP-CONTOSO-PROD/vm-template',
    headers: { get: (name: string) => lower.get(name.toLowerCase()) ?? null },
    params: { hostPoolName },
  } as unknown as HttpRequest;
}

function makeContext(): InvocationContext {
  return {
    warn: () => {},
    error: () => {},
    log: () => {},
  } as unknown as InvocationContext;
}

function encodePrincipal(principal: unknown): string {
  return Buffer.from(JSON.stringify(principal), 'utf-8').toString('base64');
}

function operatorHeader() {
  return encodePrincipal({ identityProvider: 'aad', userId: 'u2', userDetails: 'op@example.com', userRoles: ['operator'] });
}

function adminHeader() {
  return encodePrincipal({ identityProvider: 'aad', userId: 'u3', userDetails: 'admin@example.com', userRoles: ['admin'] });
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
  getVmTemplateInfo.mockReset();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('hostPoolVmTemplate — operator-minimum RBAC (a viewer is denied)', () => {
  it('returns 403 for a viewer, never calling the service', async () => {
    const context = makeContext();
    const response = await hostPoolVmTemplate(makeRequest({ headers: { 'x-ms-client-principal': viewerHeader() } }), context);

    expect(response.status).toBe(403);
    expect(getVmTemplateInfo).not.toHaveBeenCalled();
  });

  it('returns 401 for an unauthenticated caller', async () => {
    const context = makeContext();
    const response = await hostPoolVmTemplate(makeRequest(), context);

    expect(response.status).toBe(401);
  });

  it('allows an operator', async () => {
    const template: VmTemplateInfo = { parsed: true, namePrefix: 'avd-con' };
    getVmTemplateInfo.mockResolvedValue(template);
    const context = makeContext();
    const response = await hostPoolVmTemplate(makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() } }), context);

    expect(response.status).toBe(200);
    expect(response.jsonBody).toEqual(template);
  });

  it('allows an admin', async () => {
    getVmTemplateInfo.mockResolvedValue({ parsed: false });
    const context = makeContext();
    const response = await hostPoolVmTemplate(makeRequest({ headers: { 'x-ms-client-principal': adminHeader() } }), context);

    expect(response.status).toBe(200);
  });
});

describe('hostPoolVmTemplate — host pool scoping and not-found handling', () => {
  it('returns 404 (host_pool_not_managed) when hostPoolName does not match the configured pool, without calling the service', async () => {
    const context = makeContext();
    const response = await hostPoolVmTemplate(
      makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() }, hostPoolName: 'HP-SOME-OTHER-POOL' }),
      context,
    );

    expect(response.status).toBe(404);
    expect(getVmTemplateInfo).not.toHaveBeenCalled();
  });

  it('returns 404 (host_pool_not_found) when the service reports the host pool itself was not found', async () => {
    getVmTemplateInfo.mockResolvedValue(null);
    const context = makeContext();
    const response = await hostPoolVmTemplate(makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() } }), context);

    expect(response.status).toBe(404);
    expect(response.jsonBody).toMatchObject({ code: 'host_pool_not_found' });
  });
});

describe('hostPoolVmTemplate — vmTemplate parse outcomes surfaced through the API', () => {
  it('returns 200 with parsed:true and fields for a valid vmTemplate', async () => {
    const template: VmTemplateInfo = {
      parsed: true,
      namePrefix: 'avd-con',
      vmSizeId: 'Standard_D4ads_v7',
      domain: '',
      raw: { namePrefix: 'avd-con' },
    };
    getVmTemplateInfo.mockResolvedValue(template);
    const context = makeContext();

    const response = await hostPoolVmTemplate(makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() } }), context);

    expect(response.status).toBe(200);
    expect(response.jsonBody).toEqual(template);
  });

  it('returns 200 with parsed:false for a host pool whose vmTemplate is missing', async () => {
    getVmTemplateInfo.mockResolvedValue({ parsed: false });
    const context = makeContext();

    const response = await hostPoolVmTemplate(makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() } }), context);

    expect(response.status).toBe(200);
    expect(response.jsonBody).toEqual({ parsed: false });
  });

  it('returns 200 with parsed:false for a host pool whose vmTemplate is malformed JSON', async () => {
    // avdService.getVmTemplateInfo (mocked here) is documented to return
    // { parsed: false } rather than throw for malformed JSON — see
    // avdService.test.ts for the pure-parser-level coverage of that case.
    // This test proves the handler passes that outcome straight through as
    // a 200, not a 4xx/5xx (the endpoint is read-only display, not
    // validation).
    getVmTemplateInfo.mockResolvedValue({ parsed: false });
    const context = makeContext();

    const response = await hostPoolVmTemplate(makeRequest({ headers: { 'x-ms-client-principal': adminHeader() } }), context);

    expect(response.status).toBe(200);
    expect(response.jsonBody).toEqual({ parsed: false });
  });
});

describe('hostPoolVmTemplate — service failure', () => {
  it('returns 502 when the service call throws', async () => {
    getVmTemplateInfo.mockRejectedValue(new Error('ARM unreachable'));
    const context = makeContext();

    const response = await hostPoolVmTemplate(makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() } }), context);

    expect(response.status).toBe(502);
    expect(response.jsonBody).toMatchObject({ code: 'vm_template_lookup_failed' });
  });
});
