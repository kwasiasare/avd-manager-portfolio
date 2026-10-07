import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HttpRequest, InvocationContext } from '@azure/functions';

const listDesktopAssignments = vi.fn();
const createDesktopAssignment = vi.fn();
vi.mock('../services/accessService', () => ({
  listDesktopAssignments: (...args: unknown[]) => listDesktopAssignments(...args),
  createDesktopAssignment: (...args: unknown[]) => createDesktopAssignment(...args),
}));

const isArmForbidden = vi.fn().mockReturnValue(false);
const isArmConflict = vi.fn().mockReturnValue(false);
vi.mock('../lib/armRest', () => ({
  isArmForbidden: (...args: unknown[]) => isArmForbidden(...args),
  isArmConflict: (...args: unknown[]) => isArmConflict(...args),
}));

const writeAuditEntry = vi.fn().mockResolvedValue(undefined);
const isAuditRequiredButMissing = vi.fn().mockReturnValue(false);
vi.mock('../lib/auditLog', () => ({
  writeAuditEntry: (...args: unknown[]) => writeAuditEntry(...args),
  isAuditRequiredButMissing: (...args: unknown[]) => isAuditRequiredButMissing(...args),
}));

const { accessAssignmentsDispatch } = await import('./accessAssignments');

interface FakeContext extends InvocationContext {
  errors: unknown[];
}

function makeRequest(options: { method: string; headers?: Record<string, string>; body?: unknown; jsonThrows?: boolean }): HttpRequest {
  const { method, headers = {}, body = {}, jsonThrows = false } = options;
  const lower = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  return {
    method,
    url: 'https://func-example.azurewebsites.net/api/v1/access/assignments',
    headers: { get: (name: string) => lower.get(name.toLowerCase()) ?? null },
    query: { get: () => null },
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

function adminHeader() {
  return encodePrincipal({ identityProvider: 'aad', userId: 'u3', userDetails: 'admin@example.com', userRoles: ['admin'] });
}

const VALID_PRINCIPAL_ID = '11111111-2222-3333-4444-555555555555';
const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  process.env.SUBSCRIPTION_ID = 'sub-id';
  process.env.RG_HOSTPOOLS = 'RG-AVD-HostPools';
  process.env.HOSTPOOL_NAME = 'HP-CONTOSO-PROD';
  delete process.env.REQUIRE_BACKEND_SECRET;
  listDesktopAssignments.mockReset();
  createDesktopAssignment.mockReset();
  isArmForbidden.mockReset().mockReturnValue(false);
  isArmConflict.mockReset().mockReturnValue(false);
  writeAuditEntry.mockReset().mockResolvedValue(undefined);
  isAuditRequiredButMissing.mockReset().mockReturnValue(false);
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('GET /v1/access/assignments — viewer+', () => {
  it('returns 200 for a viewer', async () => {
    listDesktopAssignments.mockResolvedValue({ assignments: [], graphResolved: true });
    const context = makeContext();
    const response = await accessAssignmentsDispatch(makeRequest({ method: 'GET', headers: { 'x-ms-client-principal': viewerHeader() } }), context);
    expect(response.status).toBe(200);
  });

  it('returns 401 for an unauthenticated caller', async () => {
    const context = makeContext();
    const response = await accessAssignmentsDispatch(makeRequest({ method: 'GET' }), context);
    expect(response.status).toBe(401);
    expect(listDesktopAssignments).not.toHaveBeenCalled();
  });

  it('returns 502 when the service throws', async () => {
    listDesktopAssignments.mockRejectedValue(new Error('boom'));
    const context = makeContext();
    const response = await accessAssignmentsDispatch(makeRequest({ method: 'GET', headers: { 'x-ms-client-principal': viewerHeader() } }), context);
    expect(response.status).toBe(502);
  });
});

describe('POST /v1/access/assignments — ADMIN-only, audited', () => {
  it('returns 403 and never calls the service or writes an audit row for an operator (below the admin floor)', async () => {
    const context = makeContext();
    const response = await accessAssignmentsDispatch(
      makeRequest({ method: 'POST', headers: { 'x-ms-client-principal': operatorHeader() }, body: { principalId: VALID_PRINCIPAL_ID, principalType: 'user', reason: 'onboarding' } }),
      context,
    );
    expect(response.status).toBe(403);
    expect(createDesktopAssignment).not.toHaveBeenCalled();
    expect(writeAuditEntry).not.toHaveBeenCalled();
  });

  it('returns 403 for a viewer', async () => {
    const context = makeContext();
    const response = await accessAssignmentsDispatch(
      makeRequest({ method: 'POST', headers: { 'x-ms-client-principal': viewerHeader() }, body: { principalId: VALID_PRINCIPAL_ID, principalType: 'user', reason: 'onboarding' } }),
      context,
    );
    expect(response.status).toBe(403);
  });

  it('returns 400 for a malformed principalId, without calling the service', async () => {
    const context = makeContext();
    const response = await accessAssignmentsDispatch(
      makeRequest({ method: 'POST', headers: { 'x-ms-client-principal': adminHeader() }, body: { principalId: 'not-a-guid', principalType: 'user', reason: 'onboarding' } }),
      context,
    );
    expect(response.status).toBe(400);
    expect(response.jsonBody).toMatchObject({ code: 'invalid_principal_id' });
    expect(createDesktopAssignment).not.toHaveBeenCalled();
  });

  it('returns 400 for an invalid principalType', async () => {
    const context = makeContext();
    const response = await accessAssignmentsDispatch(
      makeRequest({ method: 'POST', headers: { 'x-ms-client-principal': adminHeader() }, body: { principalId: VALID_PRINCIPAL_ID, principalType: 'admin', reason: 'onboarding' } }),
      context,
    );
    expect(response.status).toBe(400);
    expect(response.jsonBody).toMatchObject({ code: 'invalid_principal_type' });
  });

  it('returns 400 when reason is missing — MANDATORY for this endpoint', async () => {
    const context = makeContext();
    const response = await accessAssignmentsDispatch(
      makeRequest({ method: 'POST', headers: { 'x-ms-client-principal': adminHeader() }, body: { principalId: VALID_PRINCIPAL_ID, principalType: 'user' } }),
      context,
    );
    expect(response.status).toBe(400);
    expect(response.jsonBody).toMatchObject({ code: 'missing_reason' });
    expect(createDesktopAssignment).not.toHaveBeenCalled();
  });

  it('fails closed (500) and does not mutate when audit is required but not configured', async () => {
    isAuditRequiredButMissing.mockReturnValue(true);
    const context = makeContext();
    const response = await accessAssignmentsDispatch(
      makeRequest({ method: 'POST', headers: { 'x-ms-client-principal': adminHeader() }, body: { principalId: VALID_PRINCIPAL_ID, principalType: 'user', reason: 'onboarding' } }),
      context,
    );
    expect(response.status).toBe(500);
    expect(createDesktopAssignment).not.toHaveBeenCalled();
  });

  it('succeeds for an admin with a valid request, calling the service with the exact validated fields and writing a success audit row', async () => {
    createDesktopAssignment.mockResolvedValue({ roleAssignmentId: 'new-guid', principalId: VALID_PRINCIPAL_ID, principalType: 'User' });
    const context = makeContext();
    const response = await accessAssignmentsDispatch(
      makeRequest({ method: 'POST', headers: { 'x-ms-client-principal': adminHeader() }, body: { principalId: VALID_PRINCIPAL_ID, principalType: 'user', reason: 'onboarding' } }),
      context,
    );

    expect(response.status).toBe(201);
    expect(createDesktopAssignment).toHaveBeenCalledWith(VALID_PRINCIPAL_ID, 'user');
    expect(writeAuditEntry).toHaveBeenCalledWith(expect.objectContaining({ action: 'access.assignment.create', outcome: 'success', reason: 'onboarding' }), expect.anything());
  });

  it('writes a failure audit row and returns 403 when ARM rejects the write (e.g. the ABAC-constrained grant has not propagated)', async () => {
    createDesktopAssignment.mockRejectedValue(new Error('forbidden'));
    isArmForbidden.mockReturnValue(true);
    const context = makeContext();
    const response = await accessAssignmentsDispatch(
      makeRequest({ method: 'POST', headers: { 'x-ms-client-principal': adminHeader() }, body: { principalId: VALID_PRINCIPAL_ID, principalType: 'user', reason: 'onboarding' } }),
      context,
    );

    expect(response.status).toBe(403);
    expect(writeAuditEntry).toHaveBeenCalledWith(expect.objectContaining({ action: 'access.assignment.create', outcome: 'failure' }), expect.anything());
  });

  it('returns 502 on an unrecognized ARM failure', async () => {
    createDesktopAssignment.mockRejectedValue(new Error('unexpected'));
    const context = makeContext();
    const response = await accessAssignmentsDispatch(
      makeRequest({ method: 'POST', headers: { 'x-ms-client-principal': adminHeader() }, body: { principalId: VALID_PRINCIPAL_ID, principalType: 'user', reason: 'onboarding' } }),
      context,
    );
    expect(response.status).toBe(502);
  });

  it('fix 8: maps an ARM 409 (RoleAssignmentExists) to a 409 with a clear "already has access" message, and still writes a failure audit row', async () => {
    createDesktopAssignment.mockRejectedValue(new Error('conflict'));
    isArmConflict.mockReturnValue(true);
    const context = makeContext();
    const response = await accessAssignmentsDispatch(
      makeRequest({ method: 'POST', headers: { 'x-ms-client-principal': adminHeader() }, body: { principalId: VALID_PRINCIPAL_ID, principalType: 'user', reason: 'onboarding' } }),
      context,
    );

    expect(response.status).toBe(409);
    expect(response.jsonBody).toMatchObject({ code: 'assignment_already_exists' });
    expect(writeAuditEntry).toHaveBeenCalledWith(expect.objectContaining({ action: 'access.assignment.create', outcome: 'failure' }), expect.anything());
  });
});

describe('method not allowed', () => {
  it('returns 405 for an unsupported method', async () => {
    const context = makeContext();
    const response = await accessAssignmentsDispatch(makeRequest({ method: 'PUT', headers: { 'x-ms-client-principal': adminHeader() } }), context);
    expect(response.status).toBe(405);
  });
});
