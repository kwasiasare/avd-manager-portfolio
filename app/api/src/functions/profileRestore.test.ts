import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HttpRequest, InvocationContext } from '@azure/functions';

const restoreProfile = vi.fn();
vi.mock('../services/fslogixProfilesService', async () => {
  const actual = await vi.importActual<typeof import('../services/fslogixProfilesService')>('../services/fslogixProfilesService');
  return {
    ...actual,
    restoreProfile: (...args: unknown[]) => restoreProfile(...args),
  };
});

const writeAuditEntry = vi.fn().mockResolvedValue(undefined);
const isAuditRequiredButMissing = vi.fn().mockReturnValue(false);
vi.mock('../lib/auditLog', () => ({
  writeAuditEntry: (...args: unknown[]) => writeAuditEntry(...args),
  isAuditRequiredButMissing: (...args: unknown[]) => isAuditRequiredButMissing(...args),
}));

const { profileRestore } = await import('./profileRestore');
const { RestoreConflictError, RetiredProfileNotFoundError, RootFileMutationUnsupportedError } = await import('../services/fslogixProfilesService');

interface FakeContext extends InvocationContext {
  warnings: string[];
  errors: unknown[];
  logs: unknown[];
}

function makeRequest(options: { headers?: Record<string, string>; profileFolderName?: string; body?: unknown; jsonThrows?: boolean }): HttpRequest {
  const {
    headers = {},
    profileFolderName = 'S-1-5-21-1_jdoe',
    body = { retiredFileName: 'Profile_jdoe.vhdx.retired-20260816-140233' },
    jsonThrows = false,
  } = options;
  const lower = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  return {
    url: `https://func-example.azurewebsites.net/api/v1/profiles/${profileFolderName}/restore`,
    headers: { get: (name: string) => lower.get(name.toLowerCase()) ?? null },
    params: { profileFolderName },
    json: async () => {
      if (jsonThrows) throw new Error('bad json');
      return body;
    },
  } as unknown as HttpRequest;
}

function makeContext(): FakeContext {
  const warnings: string[] = [];
  const errors: unknown[] = [];
  const logs: unknown[] = [];
  return {
    warn: (...args: unknown[]) => warnings.push(args.join(' ')),
    error: (...args: unknown[]) => errors.push(args),
    log: (...args: unknown[]) => logs.push(args.join(' ')),
    warnings,
    errors,
    logs,
  } as unknown as FakeContext;
}

function encodePrincipal(principal: unknown): string {
  return Buffer.from(JSON.stringify(principal), 'utf-8').toString('base64');
}

function adminHeader(userDetails = 'admin@example.com', userId = 'entra-obj-id-admin') {
  return encodePrincipal({ identityProvider: 'aad', userId, userDetails, userRoles: ['admin'] });
}

function operatorHeader() {
  return encodePrincipal({ identityProvider: 'aad', userId: 'u2', userDetails: 'operator@example.com', userRoles: ['operator'] });
}

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  delete process.env.REQUIRE_BACKEND_SECRET;
  restoreProfile.mockReset().mockResolvedValue({ restoredFileName: 'Profile_jdoe.vhdx' });
  writeAuditEntry.mockReset().mockResolvedValue(undefined);
  isAuditRequiredButMissing.mockReset().mockReturnValue(false);
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('profileRestore — role gate', () => {
  it('returns 403 for an operator (this route is admin-only)', async () => {
    const context = makeContext();
    const response = await profileRestore(makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() } }), context);
    expect(response.status).toBe(403);
    expect(restoreProfile).not.toHaveBeenCalled();
  });

  it('allows an admin', async () => {
    const context = makeContext();
    const response = await profileRestore(makeRequest({ headers: { 'x-ms-client-principal': adminHeader() } }), context);
    expect(response.status).toBe(200);
  });
});

describe('profileRestore — retiredFileName validation', () => {
  it('returns 400 when retiredFileName is missing', async () => {
    const context = makeContext();
    const response = await profileRestore(makeRequest({ headers: { 'x-ms-client-principal': adminHeader() }, body: {} }), context);
    expect(response.status).toBe(400);
    expect(response.jsonBody).toMatchObject({ code: 'missing_retired_file_name' });
    expect(restoreProfile).not.toHaveBeenCalled();
  });

  it('returns 400 when retiredFileName contains a path separator', async () => {
    const context = makeContext();
    const response = await profileRestore(makeRequest({ headers: { 'x-ms-client-principal': adminHeader() }, body: { retiredFileName: '../../etc/passwd' } }), context);
    expect(response.status).toBe(400);
    expect(response.jsonBody).toMatchObject({ code: 'invalid_retired_file_name' });
  });

  it('trims a padded retiredFileName before use', async () => {
    const context = makeContext();
    await profileRestore(makeRequest({ headers: { 'x-ms-client-principal': adminHeader() }, body: { retiredFileName: '  Profile_jdoe.vhdx.retired-20260816-140233  ' } }), context);
    expect(restoreProfile).toHaveBeenCalledWith('S-1-5-21-1_jdoe', 'Profile_jdoe.vhdx.retired-20260816-140233');
  });
});

describe('profileRestore — reason is optional', () => {
  it('succeeds with no reason supplied', async () => {
    const context = makeContext();
    const response = await profileRestore(makeRequest({ headers: { 'x-ms-client-principal': adminHeader() }, body: { retiredFileName: 'Profile_jdoe.vhdx.retired-20260816-140233' } }), context);
    expect(response.status).toBe(200);
    expect(writeAuditEntry.mock.calls[0][0].reason).toBeUndefined();
  });

  it('returns 400 for an over-length reason even though it is optional', async () => {
    const context = makeContext();
    const response = await profileRestore(
      makeRequest({ headers: { 'x-ms-client-principal': adminHeader() }, body: { retiredFileName: 'Profile_jdoe.vhdx.retired-20260816-140233', reason: 'x'.repeat(1001) } }),
      context,
    );
    expect(response.status).toBe(400);
    expect(response.jsonBody).toMatchObject({ code: 'reason_too_long' });
  });
});

describe('profileRestore — fail-closed audit posture', () => {
  it('returns 500 and never calls the service when audit is required but not configured', async () => {
    isAuditRequiredButMissing.mockReturnValue(true);
    const context = makeContext();
    const response = await profileRestore(makeRequest({ headers: { 'x-ms-client-principal': adminHeader() } }), context);
    expect(response.status).toBe(500);
    expect(restoreProfile).not.toHaveBeenCalled();
  });
});

describe('profileRestore — happy path', () => {
  it('calls the service, returns 200, and writes a success audit row', async () => {
    const context = makeContext();
    const response = await profileRestore(
      makeRequest({ headers: { 'x-ms-client-principal': adminHeader('admin@example.com', 'obj-1') }, body: { retiredFileName: 'Profile_jdoe.vhdx.retired-20260816-140233', reason: 'reset was a mistake' } }),
      context,
    );

    expect(response.status).toBe(200);
    expect(response.jsonBody).toMatchObject({ status: 'restored', folderName: 'S-1-5-21-1_jdoe', retiredFileName: 'Profile_jdoe.vhdx.retired-20260816-140233', restoredFileName: 'Profile_jdoe.vhdx' });

    const [event] = writeAuditEntry.mock.calls[0];
    expect(event).toMatchObject({ actor: 'admin@example.com', actorId: 'obj-1', action: 'profile.restore', target: 'S-1-5-21-1_jdoe', reason: 'reset was a mistake', outcome: 'success' });
  });
});

describe('profileRestore — failure paths', () => {
  it('maps RetiredProfileNotFoundError to 404', async () => {
    restoreProfile.mockRejectedValue(new RetiredProfileNotFoundError('not found'));
    const context = makeContext();
    const response = await profileRestore(makeRequest({ headers: { 'x-ms-client-principal': adminHeader() } }), context);
    expect(response.status).toBe(404);
    expect(response.jsonBody).toMatchObject({ code: 'retired_profile_not_found' });
    expect(writeAuditEntry.mock.calls[0][0].outcome).toBe('failure');
  });

  it('maps RestoreConflictError to 409', async () => {
    restoreProfile.mockRejectedValue(new RestoreConflictError('conflict'));
    const context = makeContext();
    const response = await profileRestore(makeRequest({ headers: { 'x-ms-client-principal': adminHeader() } }), context);
    expect(response.status).toBe(409);
    expect(response.jsonBody).toMatchObject({ code: 'restore_conflict' });
  });

  it('maps RootFileMutationUnsupportedError to 400 (peer review item 4)', async () => {
    restoreProfile.mockRejectedValue(new RootFileMutationUnsupportedError('loose root-level file, not a directory'));
    const context = makeContext();
    const response = await profileRestore(makeRequest({ headers: { 'x-ms-client-principal': adminHeader() } }), context);
    expect(response.status).toBe(400);
    expect(response.jsonBody).toMatchObject({ code: 'root_file_mutation_unsupported' });
  });

  it('maps an unrecognized error to 502', async () => {
    restoreProfile.mockRejectedValue(new Error('boom'));
    const context = makeContext();
    const response = await profileRestore(makeRequest({ headers: { 'x-ms-client-principal': adminHeader() } }), context);
    expect(response.status).toBe(502);
    expect(response.jsonBody).toMatchObject({ code: 'profile_restore_failed' });
  });

  it('still returns the mapped error status when writeAuditEntry rejects on the FAILURE path (peer review nit — audit try/catch symmetry)', async () => {
    restoreProfile.mockRejectedValue(new RetiredProfileNotFoundError('gone'));
    writeAuditEntry.mockRejectedValueOnce(new Error('table unreachable'));
    const context = makeContext();
    const response = await profileRestore(makeRequest({ headers: { 'x-ms-client-principal': adminHeader() } }), context);
    expect(response.status).toBe(404);
    expect(context.warnings.some((w) => w.includes('audit write threw unexpectedly'))).toBe(true);
  });
});

describe('profileRestore — Unicode folder name (peer review item 12)', () => {
  it('accepts a Unicode folder name', async () => {
    restoreProfile.mockResolvedValue({ restoredFileName: 'Profile_jöhn.vhdx' });
    const context = makeContext();
    const response = await profileRestore(makeRequest({ headers: { 'x-ms-client-principal': adminHeader() }, profileFolderName: 'S-1-5-21-1_jöhn' }), context);
    expect(response.status).toBe(200);
    expect(restoreProfile).toHaveBeenCalledWith('S-1-5-21-1_jöhn', 'Profile_jdoe.vhdx.retired-20260816-140233');
  });
});
