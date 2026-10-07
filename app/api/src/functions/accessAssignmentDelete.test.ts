import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HttpRequest, InvocationContext } from '@azure/functions';

const removeDesktopAssignment = vi.fn();
vi.mock('../services/accessService', () => ({
  removeDesktopAssignment: (...args: unknown[]) => removeDesktopAssignment(...args),
}));

const isArmForbidden = vi.fn().mockReturnValue(false);
vi.mock('../lib/armRest', () => ({
  isArmForbidden: (...args: unknown[]) => isArmForbidden(...args),
}));

const writeAuditEntry = vi.fn().mockResolvedValue(undefined);
const isAuditRequiredButMissing = vi.fn().mockReturnValue(false);
vi.mock('../lib/auditLog', () => ({
  writeAuditEntry: (...args: unknown[]) => writeAuditEntry(...args),
  isAuditRequiredButMissing: (...args: unknown[]) => isAuditRequiredButMissing(...args),
}));

const { accessAssignmentDelete } = await import('./accessAssignmentDelete');

interface FakeContext extends InvocationContext {
  errors: unknown[];
}

function makeRequest(options: { headers?: Record<string, string>; roleAssignmentId?: string; body?: unknown; jsonThrows?: boolean }): HttpRequest {
  const { headers = {}, roleAssignmentId = '11111111-2222-3333-4444-555555555555', body = { reason: 'no longer needed' }, jsonThrows = false } = options;
  const lower = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  return {
    url: `https://func-example.azurewebsites.net/api/v1/access/assignments/${roleAssignmentId}`,
    headers: { get: (name: string) => lower.get(name.toLowerCase()) ?? null },
    params: { roleAssignmentId },
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

function adminHeader() {
  return encodePrincipal({ identityProvider: 'aad', userId: 'u3', userDetails: 'admin@example.com', userRoles: ['admin'] });
}

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  process.env.SUBSCRIPTION_ID = 'sub-id';
  process.env.RG_HOSTPOOLS = 'RG-AVD-HostPools';
  process.env.HOSTPOOL_NAME = 'HP-CONTOSO-PROD';
  delete process.env.REQUIRE_BACKEND_SECRET;
  removeDesktopAssignment.mockReset();
  isArmForbidden.mockReset().mockReturnValue(false);
  writeAuditEntry.mockReset().mockResolvedValue(undefined);
  isAuditRequiredButMissing.mockReset().mockReturnValue(false);
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('DELETE /v1/access/assignments/{roleAssignmentId} — ADMIN-only, audited', () => {
  it('returns 403 for a viewer, without calling the service or writing an audit row', async () => {
    const context = makeContext();
    const response = await accessAssignmentDelete(makeRequest({ headers: { 'x-ms-client-principal': viewerHeader() } }), context);
    expect(response.status).toBe(403);
    expect(removeDesktopAssignment).not.toHaveBeenCalled();
    expect(writeAuditEntry).not.toHaveBeenCalled();
  });

  it('returns 401 for an unauthenticated caller', async () => {
    const context = makeContext();
    const response = await accessAssignmentDelete(makeRequest({}), context);
    expect(response.status).toBe(401);
  });

  it('returns 400 for a malformed roleAssignmentId route parameter', async () => {
    const context = makeContext();
    const response = await accessAssignmentDelete(makeRequest({ headers: { 'x-ms-client-principal': adminHeader() }, roleAssignmentId: 'not-a-guid' }), context);
    expect(response.status).toBe(400);
    expect(response.jsonBody).toMatchObject({ code: 'invalid_role_assignment_id' });
    expect(removeDesktopAssignment).not.toHaveBeenCalled();
  });

  it('returns 400 when reason is missing — MANDATORY for removal', async () => {
    const context = makeContext();
    const response = await accessAssignmentDelete(makeRequest({ headers: { 'x-ms-client-principal': adminHeader() }, body: {} }), context);
    expect(response.status).toBe(400);
    expect(response.jsonBody).toMatchObject({ code: 'missing_reason' });
    expect(removeDesktopAssignment).not.toHaveBeenCalled();
  });

  it('fails closed (500) and does not mutate when audit is required but not configured', async () => {
    isAuditRequiredButMissing.mockReturnValue(true);
    const context = makeContext();
    const response = await accessAssignmentDelete(makeRequest({ headers: { 'x-ms-client-principal': adminHeader() } }), context);
    expect(response.status).toBe(500);
    expect(removeDesktopAssignment).not.toHaveBeenCalled();
  });

  it('succeeds for an admin, returns 204, and writes a success audit row with the mandatory reason AND the principalId/displayName read back from the pre-delete GET (fix 5)', async () => {
    removeDesktopAssignment.mockResolvedValue({ outcome: 'removed', principalId: 'p1', principalType: 'User', displayName: 'Alice Example' });
    const context = makeContext();
    const response = await accessAssignmentDelete(makeRequest({ headers: { 'x-ms-client-principal': adminHeader() }, roleAssignmentId: '11111111-2222-3333-4444-555555555555', body: { reason: 'offboarding' } }), context);

    expect(response.status).toBe(204);
    expect(removeDesktopAssignment).toHaveBeenCalledWith('11111111-2222-3333-4444-555555555555');
    expect(writeAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'access.assignment.remove',
        outcome: 'success',
        reason: 'offboarding',
        parameters: expect.objectContaining({ roleAssignmentId: '11111111-2222-3333-4444-555555555555', principalId: 'p1', principalType: 'User', displayName: 'Alice Example' }),
      }),
      expect.anything(),
    );
  });

  it('succeeds without a displayName when Graph could not resolve one — parameters omit it rather than sending undefined', async () => {
    removeDesktopAssignment.mockResolvedValue({ outcome: 'removed', principalId: 'p1', principalType: 'User' });
    const context = makeContext();
    const response = await accessAssignmentDelete(makeRequest({ headers: { 'x-ms-client-principal': adminHeader() } }), context);

    expect(response.status).toBe(204);
    const [auditEvent] = writeAuditEntry.mock.calls[0];
    expect(auditEvent.parameters).not.toHaveProperty('displayName');
  });

  it('BLOCKER fix 1: returns 404 (never 204) and writes a FAILURE audit row when the service reports outcome:"not_found" — an inherited or already-removed assignment must not be reported as successfully removed', async () => {
    removeDesktopAssignment.mockResolvedValue({ outcome: 'not_found' });
    const context = makeContext();
    const response = await accessAssignmentDelete(makeRequest({ headers: { 'x-ms-client-principal': adminHeader() } }), context);

    expect(response.status).toBe(404);
    expect(response.jsonBody).toMatchObject({ code: 'assignment_not_found' });
    expect(writeAuditEntry).toHaveBeenCalledWith(expect.objectContaining({ action: 'access.assignment.remove', outcome: 'failure' }), expect.anything());
  });

  it('writes a failure audit row and returns 403 when ARM/ABAC rejects the delete', async () => {
    removeDesktopAssignment.mockRejectedValue(new Error('forbidden'));
    isArmForbidden.mockReturnValue(true);
    const context = makeContext();
    const response = await accessAssignmentDelete(makeRequest({ headers: { 'x-ms-client-principal': adminHeader() } }), context);
    expect(response.status).toBe(403);
    expect(writeAuditEntry).toHaveBeenCalledWith(expect.objectContaining({ action: 'access.assignment.remove', outcome: 'failure' }), expect.anything());
  });

  it('returns 502 on an unrecognized ARM failure', async () => {
    removeDesktopAssignment.mockRejectedValue(new Error('unexpected'));
    const context = makeContext();
    const response = await accessAssignmentDelete(makeRequest({ headers: { 'x-ms-client-principal': adminHeader() } }), context);
    expect(response.status).toBe(502);
  });
});
