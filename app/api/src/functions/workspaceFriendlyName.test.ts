import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HttpRequest, InvocationContext } from '@azure/functions';

const getWorkspaceFriendlyName = vi.fn();
const updateWorkspaceFriendlyName = vi.fn();
vi.mock('../services/avdService', () => ({
  getWorkspaceFriendlyName: (...args: unknown[]) => getWorkspaceFriendlyName(...args),
  updateWorkspaceFriendlyName: (...args: unknown[]) => updateWorkspaceFriendlyName(...args),
}));

const writeAuditEntry = vi.fn().mockResolvedValue(undefined);
const isAuditRequiredButMissing = vi.fn().mockReturnValue(false);
vi.mock('../lib/auditLog', () => ({
  writeAuditEntry: (...args: unknown[]) => writeAuditEntry(...args),
  isAuditRequiredButMissing: (...args: unknown[]) => isAuditRequiredButMissing(...args),
}));

const { workspaceFriendlyNameDispatch } = await import('./workspaceFriendlyName');

interface FakeContext extends InvocationContext {
  errors: unknown[];
}

function makeRequest(options: { method: string; headers?: Record<string, string>; body?: unknown; jsonThrows?: boolean }): HttpRequest {
  const { method, headers = {}, body = {}, jsonThrows = false } = options;
  const lower = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  return {
    method,
    url: 'https://func-example.azurewebsites.net/api/v1/workspace/friendly-name',
    headers: { get: (name: string) => lower.get(name.toLowerCase()) ?? null },
    params: {},
    json: async () => {
      if (jsonThrows) throw new Error('bad json');
      return body;
    },
  } as unknown as HttpRequest;
}

function makeContext(): FakeContext {
  const errors: unknown[] = [];
  return {
    warn: () => {},
    error: (...args: unknown[]) => errors.push(args),
    log: () => {},
    errors,
  } as unknown as FakeContext;
}

function encodePrincipal(principal: unknown): string {
  return Buffer.from(JSON.stringify(principal), 'utf-8').toString('base64');
}

function viewerHeader() {
  return encodePrincipal({ identityProvider: 'aad', userId: 'u1', userDetails: 'viewer@example.com', userRoles: ['viewer'] });
}

function operatorHeader() {
  return encodePrincipal({ identityProvider: 'aad', userId: 'u2', userDetails: 'operator@example.com', userRoles: ['operator'] });
}

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  process.env.SUBSCRIPTION_ID = 'sub-id';
  process.env.RG_HOSTPOOLS = 'RG-AVD-HostPools';
  process.env.HOSTPOOL_NAME = 'HP-CONTOSO-PROD';
  delete process.env.REQUIRE_BACKEND_SECRET;
  getWorkspaceFriendlyName.mockReset();
  updateWorkspaceFriendlyName.mockReset();
  writeAuditEntry.mockReset().mockResolvedValue(undefined);
  isAuditRequiredButMissing.mockReset().mockReturnValue(false);
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('GET /v1/workspace/friendly-name — viewer+', () => {
  it('returns 200 for a viewer', async () => {
    getWorkspaceFriendlyName.mockResolvedValue('Contoso Desktop');
    const context = makeContext();
    const response = await workspaceFriendlyNameDispatch(makeRequest({ method: 'GET', headers: { 'x-ms-client-principal': viewerHeader() } }), context);
    expect(response.status).toBe(200);
    expect(response.jsonBody).toEqual({ friendlyName: 'Contoso Desktop' });
  });

  it('returns 401 for an unauthenticated caller', async () => {
    const context = makeContext();
    const response = await workspaceFriendlyNameDispatch(makeRequest({ method: 'GET' }), context);
    expect(response.status).toBe(401);
  });

  it('returns 502 when the read fails', async () => {
    getWorkspaceFriendlyName.mockRejectedValue(new Error('boom'));
    const context = makeContext();
    const response = await workspaceFriendlyNameDispatch(makeRequest({ method: 'GET', headers: { 'x-ms-client-principal': viewerHeader() } }), context);
    expect(response.status).toBe(502);
  });
});

describe('PATCH /v1/workspace/friendly-name — operator+, audited', () => {
  it('returns 403 for a viewer (below the operator floor)', async () => {
    const context = makeContext();
    const response = await workspaceFriendlyNameDispatch(
      makeRequest({ method: 'PATCH', headers: { 'x-ms-client-principal': viewerHeader() }, body: { friendlyName: 'New Name' } }),
      context,
    );
    expect(response.status).toBe(403);
    expect(updateWorkspaceFriendlyName).not.toHaveBeenCalled();
    expect(writeAuditEntry).not.toHaveBeenCalled();
  });

  it('returns 400 for a non-string friendlyName', async () => {
    const context = makeContext();
    const response = await workspaceFriendlyNameDispatch(
      makeRequest({ method: 'PATCH', headers: { 'x-ms-client-principal': operatorHeader() }, body: { friendlyName: 42 } }),
      context,
    );
    expect(response.status).toBe(400);
    expect(updateWorkspaceFriendlyName).not.toHaveBeenCalled();
  });

  it('succeeds for an operator WITHOUT a reason — reason is optional for this endpoint', async () => {
    updateWorkspaceFriendlyName.mockResolvedValue('New Name');
    const context = makeContext();
    const response = await workspaceFriendlyNameDispatch(
      makeRequest({ method: 'PATCH', headers: { 'x-ms-client-principal': operatorHeader() }, body: { friendlyName: 'New Name' } }),
      context,
    );
    expect(response.status).toBe(200);
    expect(response.jsonBody).toEqual({ friendlyName: 'New Name' });
    expect(updateWorkspaceFriendlyName).toHaveBeenCalledWith('New Name');
    expect(writeAuditEntry).toHaveBeenCalledWith(expect.objectContaining({ action: 'workspace.friendlyname.update', outcome: 'success', reason: undefined }), expect.anything());
  });

  it('fails closed (500) and does not mutate when audit is required but not configured', async () => {
    isAuditRequiredButMissing.mockReturnValue(true);
    const context = makeContext();
    const response = await workspaceFriendlyNameDispatch(
      makeRequest({ method: 'PATCH', headers: { 'x-ms-client-principal': operatorHeader() }, body: { friendlyName: 'New Name' } }),
      context,
    );
    expect(response.status).toBe(500);
    expect(updateWorkspaceFriendlyName).not.toHaveBeenCalled();
  });

  it('writes a failure audit row and returns 502 when the update fails', async () => {
    updateWorkspaceFriendlyName.mockRejectedValue(new Error('boom'));
    const context = makeContext();
    const response = await workspaceFriendlyNameDispatch(
      makeRequest({ method: 'PATCH', headers: { 'x-ms-client-principal': operatorHeader() }, body: { friendlyName: 'New Name' } }),
      context,
    );
    expect(response.status).toBe(502);
    expect(writeAuditEntry).toHaveBeenCalledWith(expect.objectContaining({ action: 'workspace.friendlyname.update', outcome: 'failure' }), expect.anything());
  });
});

describe('method not allowed', () => {
  it('returns 405 for an unsupported method', async () => {
    const context = makeContext();
    const response = await workspaceFriendlyNameDispatch(makeRequest({ method: 'DELETE', headers: { 'x-ms-client-principal': operatorHeader() } }), context);
    expect(response.status).toBe(405);
  });
});
