import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HttpRequest, InvocationContext } from '@azure/functions';

const resolveDuplicateContainer = vi.fn();
vi.mock('../services/fslogixProfilesService', async () => {
  const actual = await vi.importActual<typeof import('../services/fslogixProfilesService')>('../services/fslogixProfilesService');
  return {
    ...actual,
    resolveDuplicateContainer: (...args: unknown[]) => resolveDuplicateContainer(...args),
  };
});

const writeAuditEntry = vi.fn().mockResolvedValue(undefined);
const isAuditRequiredButMissing = vi.fn().mockReturnValue(false);
vi.mock('../lib/auditLog', () => ({
  writeAuditEntry: (...args: unknown[]) => writeAuditEntry(...args),
  isAuditRequiredButMissing: (...args: unknown[]) => isAuditRequiredButMissing(...args),
}));

const { profileDuplicateResolve } = await import('./profileDuplicateResolve');
const {
  ProfileAmbiguousError,
  ProfileLockedError,
  ProfileNotDuplicateError,
  ProfileNotFoundError,
  ProfileSessionCheckFailedError,
  ProfileUserSessionActiveError,
  ProfileUserUnresolvedError,
  LockCheckFailedError,
  RootFileMutationUnsupportedError,
} = await import('../services/fslogixProfilesService');

interface FakeContext extends InvocationContext {
  warnings: string[];
  errors: unknown[];
  logs: unknown[];
}

function makeRequest(options: { headers?: Record<string, string>; profileFolderName?: string; body?: unknown; jsonThrows?: boolean }): HttpRequest {
  const {
    headers = {},
    profileFolderName = 'S-1-5-21-1_jdoe',
    body = { fileName: 'Profile_jdoe.vhdx', mode: 'retire', reason: 'duplicate container cleanup' },
    jsonThrows = false,
  } = options;
  const lower = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  return {
    url: `https://func-example.azurewebsites.net/api/v1/profiles/${profileFolderName}/duplicates/resolve`,
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
  resolveDuplicateContainer.mockReset().mockResolvedValue({ mode: 'retire', fileName: 'Profile_jdoe.vhdx', retiredFileName: 'Profile_jdoe.vhdx.retired-20260823-140233', activeSiblingCount: 2 });
  writeAuditEntry.mockReset().mockResolvedValue(undefined);
  isAuditRequiredButMissing.mockReset().mockReturnValue(false);
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('profileDuplicateResolve — role gate', () => {
  it('returns 403 for an operator (this route is admin-only)', async () => {
    const context = makeContext();
    const response = await profileDuplicateResolve(makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() } }), context);
    expect(response.status).toBe(403);
    expect(resolveDuplicateContainer).not.toHaveBeenCalled();
    expect(writeAuditEntry).not.toHaveBeenCalled();
  });

  it('returns 401 for an unauthenticated caller', async () => {
    const context = makeContext();
    const response = await profileDuplicateResolve(makeRequest({}), context);
    expect(response.status).toBe(401);
  });

  it('allows an admin', async () => {
    const context = makeContext();
    const response = await profileDuplicateResolve(makeRequest({ headers: { 'x-ms-client-principal': adminHeader() } }), context);
    expect(response.status).toBe(200);
  });
});

describe('profileDuplicateResolve — route param validation', () => {
  it('returns 400 for a profileFolderName containing a path separator', async () => {
    const context = makeContext();
    const response = await profileDuplicateResolve(makeRequest({ headers: { 'x-ms-client-principal': adminHeader() }, profileFolderName: '..%2f..%2fetc' }), context);
    expect(response.status).toBe(400);
    expect(response.jsonBody).toMatchObject({ code: 'invalid_profile_folder_name' });
    expect(resolveDuplicateContainer).not.toHaveBeenCalled();
  });
});

describe('profileDuplicateResolve — fileName validation', () => {
  it('returns 400 when fileName is missing', async () => {
    const context = makeContext();
    const response = await profileDuplicateResolve(makeRequest({ headers: { 'x-ms-client-principal': adminHeader() }, body: { mode: 'retire', reason: 'x' } }), context);
    expect(response.status).toBe(400);
    expect(response.jsonBody).toMatchObject({ code: 'missing_file_name' });
    expect(resolveDuplicateContainer).not.toHaveBeenCalled();
  });

  it('returns 400 for a fileName containing a forward slash', async () => {
    const context = makeContext();
    const response = await profileDuplicateResolve(
      makeRequest({ headers: { 'x-ms-client-principal': adminHeader() }, body: { fileName: '../secret.vhdx', mode: 'retire', reason: 'x' } }),
      context,
    );
    expect(response.status).toBe(400);
    expect(response.jsonBody).toMatchObject({ code: 'invalid_file_name' });
    expect(resolveDuplicateContainer).not.toHaveBeenCalled();
  });

  it('returns 400 for a fileName containing a backslash', async () => {
    const context = makeContext();
    const response = await profileDuplicateResolve(
      makeRequest({ headers: { 'x-ms-client-principal': adminHeader() }, body: { fileName: 'foo\\bar.vhdx', mode: 'retire', reason: 'x' } }),
      context,
    );
    expect(response.status).toBe(400);
    expect(response.jsonBody).toMatchObject({ code: 'invalid_file_name' });
  });

  it('returns 400 for a fileName that does not end in .vhd/.vhdx', async () => {
    const context = makeContext();
    const response = await profileDuplicateResolve(
      makeRequest({ headers: { 'x-ms-client-principal': adminHeader() }, body: { fileName: 'Profile_jdoe.vhdx.retired-20260816-140233', mode: 'retire', reason: 'x' } }),
      context,
    );
    expect(response.status).toBe(400);
    expect(response.jsonBody).toMatchObject({ code: 'invalid_file_name' });
  });

  it('accepts a .vhd (not just .vhdx) fileName', async () => {
    resolveDuplicateContainer.mockResolvedValue({ mode: 'retire', fileName: 'Profile_jdoe.vhd', retiredFileName: 'Profile_jdoe.vhd.retired-20260823-140233', activeSiblingCount: 2 });
    const context = makeContext();
    const response = await profileDuplicateResolve(
      makeRequest({ headers: { 'x-ms-client-principal': adminHeader() }, body: { fileName: 'Profile_jdoe.vhd', mode: 'retire', reason: 'x' } }),
      context,
    );
    expect(response.status).toBe(200);
  });
});

describe('profileDuplicateResolve — mode validation', () => {
  it('returns 400 for a missing mode', async () => {
    const context = makeContext();
    const response = await profileDuplicateResolve(
      makeRequest({ headers: { 'x-ms-client-principal': adminHeader() }, body: { fileName: 'Profile_jdoe.vhdx', reason: 'x' } }),
      context,
    );
    expect(response.status).toBe(400);
    expect(response.jsonBody).toMatchObject({ code: 'invalid_mode' });
  });

  it('returns 400 for an unrecognized mode', async () => {
    const context = makeContext();
    const response = await profileDuplicateResolve(
      makeRequest({ headers: { 'x-ms-client-principal': adminHeader() }, body: { fileName: 'Profile_jdoe.vhdx', mode: 'wipe', reason: 'x' } }),
      context,
    );
    expect(response.status).toBe(400);
    expect(response.jsonBody).toMatchObject({ code: 'invalid_mode' });
  });
});

describe('profileDuplicateResolve — mandatory reason', () => {
  it('returns 400 when reason is missing for retire mode', async () => {
    const context = makeContext();
    const response = await profileDuplicateResolve(
      makeRequest({ headers: { 'x-ms-client-principal': adminHeader() }, body: { fileName: 'Profile_jdoe.vhdx', mode: 'retire' } }),
      context,
    );
    expect(response.status).toBe(400);
    expect(response.jsonBody).toMatchObject({ code: 'missing_reason' });
    expect(resolveDuplicateContainer).not.toHaveBeenCalled();
  });

  it('returns 400 when reason is missing for delete mode', async () => {
    const context = makeContext();
    const response = await profileDuplicateResolve(
      makeRequest({ headers: { 'x-ms-client-principal': adminHeader() }, body: { fileName: 'Profile_jdoe.vhdx', mode: 'delete' } }),
      context,
    );
    expect(response.status).toBe(400);
    expect(response.jsonBody).toMatchObject({ code: 'missing_reason' });
    expect(resolveDuplicateContainer).not.toHaveBeenCalled();
    expect(writeAuditEntry).not.toHaveBeenCalled();
  });
});

describe('profileDuplicateResolve — fail-closed audit posture', () => {
  it('returns 500 and never calls the service when audit is required but not configured', async () => {
    isAuditRequiredButMissing.mockReturnValue(true);
    const context = makeContext();
    const response = await profileDuplicateResolve(makeRequest({ headers: { 'x-ms-client-principal': adminHeader() } }), context);
    expect(response.status).toBe(500);
    expect(response.jsonBody).toMatchObject({ code: 'audit_not_configured' });
    expect(resolveDuplicateContainer).not.toHaveBeenCalled();
  });
});

describe('profileDuplicateResolve — retire happy path (audit after only)', () => {
  it('calls the service, returns 200, and writes exactly ONE success audit row with action profile.duplicateRetire', async () => {
    const context = makeContext();
    const response = await profileDuplicateResolve(
      makeRequest({
        headers: { 'x-ms-client-principal': adminHeader('admin@example.com', 'obj-1') },
        profileFolderName: 'S-1-5-21-1_jdoe',
        body: { fileName: 'Profile_jdoe.vhd', mode: 'retire', reason: 'duplicate container from VolumeType misconfig' },
      }),
      context,
    );

    expect(response.status).toBe(200);
    expect(response.jsonBody).toMatchObject({ status: 'retired', folderName: 'S-1-5-21-1_jdoe', fileName: 'Profile_jdoe.vhd', retiredFileName: 'Profile_jdoe.vhdx.retired-20260823-140233' });
    expect(resolveDuplicateContainer).toHaveBeenCalledWith('S-1-5-21-1_jdoe', 'Profile_jdoe.vhd', 'retire');

    expect(writeAuditEntry).toHaveBeenCalledTimes(1);
    const [event] = writeAuditEntry.mock.calls[0];
    expect(event).toMatchObject({
      actor: 'admin@example.com',
      actorId: 'obj-1',
      action: 'profile.duplicateRetire',
      target: 'S-1-5-21-1_jdoe/Profile_jdoe.vhd',
      parameters: { folderName: 'S-1-5-21-1_jdoe', fileName: 'Profile_jdoe.vhd', retiredFileName: 'Profile_jdoe.vhdx.retired-20260823-140233', activeSiblingCount: 2 },
      reason: 'duplicate container from VolumeType misconfig',
      outcome: 'success',
    });
  });
});

describe('profileDuplicateResolve — delete happy path (audit-before-mutation)', () => {
  it('writes an "accepted" audit row BEFORE calling the service, then a "success" row after, action profile.duplicateDelete', async () => {
    resolveDuplicateContainer.mockResolvedValue({ mode: 'delete', fileName: 'Profile_jdoe.vhd', retiredFileName: undefined, activeSiblingCount: 2 });
    const context = makeContext();
    const callOrder: string[] = [];
    writeAuditEntry.mockImplementation(async (event: { outcome: string }) => {
      callOrder.push(`audit:${event.outcome}`);
    });
    resolveDuplicateContainer.mockImplementation(async () => {
      callOrder.push('service');
      return { mode: 'delete', fileName: 'Profile_jdoe.vhd', retiredFileName: undefined, activeSiblingCount: 2 };
    });

    const response = await profileDuplicateResolve(
      makeRequest({ headers: { 'x-ms-client-principal': adminHeader() }, body: { fileName: 'Profile_jdoe.vhd', mode: 'delete', reason: 'confirmed superseded copy' } }),
      context,
    );

    expect(response.status).toBe(200);
    expect(response.jsonBody).toMatchObject({ status: 'deleted', fileName: 'Profile_jdoe.vhd', retiredFileName: undefined });
    expect(callOrder).toEqual(['audit:accepted', 'service', 'audit:success']);
    expect(writeAuditEntry).toHaveBeenCalledTimes(2);
    expect(writeAuditEntry.mock.calls[0][0]).toMatchObject({ action: 'profile.duplicateDelete', outcome: 'accepted' });
    expect(writeAuditEntry.mock.calls[1][0]).toMatchObject({ action: 'profile.duplicateDelete', outcome: 'success' });
  });

  it('still writes the accepted row AND a failure row when the service rejects', async () => {
    resolveDuplicateContainer.mockRejectedValue(new ProfileLockedError('avd-con-3'));
    const context = makeContext();

    const response = await profileDuplicateResolve(
      makeRequest({ headers: { 'x-ms-client-principal': adminHeader() }, body: { fileName: 'Profile_jdoe.vhd', mode: 'delete', reason: 'x' } }),
      context,
    );

    expect(response.status).toBe(409);
    expect(writeAuditEntry).toHaveBeenCalledTimes(2);
    expect(writeAuditEntry.mock.calls[0][0]).toMatchObject({ outcome: 'accepted' });
    expect(writeAuditEntry.mock.calls[1][0]).toMatchObject({ outcome: 'failure' });
  });
});

describe('profileDuplicateResolve — failure paths / error mapping', () => {
  it('maps ProfileNotDuplicateError to 409 profile_not_duplicate', async () => {
    resolveDuplicateContainer.mockRejectedValue(new ProfileNotDuplicateError('no longer duplicate'));
    const context = makeContext();
    const response = await profileDuplicateResolve(makeRequest({ headers: { 'x-ms-client-principal': adminHeader() } }), context);
    expect(response.status).toBe(409);
    expect(response.jsonBody).toMatchObject({ code: 'profile_not_duplicate' });
  });

  it('maps ProfileUserUnresolvedError to 409 profile_user_unresolved', async () => {
    resolveDuplicateContainer.mockRejectedValue(new ProfileUserUnresolvedError('could not parse username'));
    const context = makeContext();
    const response = await profileDuplicateResolve(makeRequest({ headers: { 'x-ms-client-principal': adminHeader() } }), context);
    expect(response.status).toBe(409);
    expect(response.jsonBody).toMatchObject({ code: 'profile_user_unresolved' });
  });

  it('maps ProfileUserSessionActiveError to 409 profile_user_session_active with sessionHostName in details', async () => {
    resolveDuplicateContainer.mockRejectedValue(new ProfileUserSessionActiveError('active session', 'avd-con-7'));
    const context = makeContext();
    const response = await profileDuplicateResolve(makeRequest({ headers: { 'x-ms-client-principal': adminHeader() } }), context);
    expect(response.status).toBe(409);
    expect(response.jsonBody).toMatchObject({ code: 'profile_user_session_active', details: { sessionHostName: 'avd-con-7' } });
  });

  it('maps ProfileSessionCheckFailedError to 503', async () => {
    resolveDuplicateContainer.mockRejectedValue(new ProfileSessionCheckFailedError('could not verify'));
    const context = makeContext();
    const response = await profileDuplicateResolve(makeRequest({ headers: { 'x-ms-client-principal': adminHeader() } }), context);
    expect(response.status).toBe(503);
    expect(response.jsonBody).toMatchObject({ code: 'profile_session_check_failed' });
  });

  it('maps ProfileNotFoundError to 404', async () => {
    resolveDuplicateContainer.mockRejectedValue(new ProfileNotFoundError('not found'));
    const context = makeContext();
    const response = await profileDuplicateResolve(makeRequest({ headers: { 'x-ms-client-principal': adminHeader() } }), context);
    expect(response.status).toBe(404);
    expect(response.jsonBody).toMatchObject({ code: 'profile_not_found' });
  });

  it('maps ProfileAmbiguousError to 409 profile_ambiguous', async () => {
    resolveDuplicateContainer.mockRejectedValue(new ProfileAmbiguousError('ambiguous'));
    const context = makeContext();
    const response = await profileDuplicateResolve(makeRequest({ headers: { 'x-ms-client-principal': adminHeader() } }), context);
    expect(response.status).toBe(409);
    expect(response.jsonBody).toMatchObject({ code: 'profile_ambiguous' });
  });

  it('maps RootFileMutationUnsupportedError to 400', async () => {
    resolveDuplicateContainer.mockRejectedValue(new RootFileMutationUnsupportedError('root file'));
    const context = makeContext();
    const response = await profileDuplicateResolve(makeRequest({ headers: { 'x-ms-client-principal': adminHeader() } }), context);
    expect(response.status).toBe(400);
    expect(response.jsonBody).toMatchObject({ code: 'root_file_mutation_unsupported' });
  });

  it('maps ProfileLockedError to 409 profile_locked with the holder in details', async () => {
    resolveDuplicateContainer.mockRejectedValue(new ProfileLockedError('avd-con-0'));
    const context = makeContext();
    const response = await profileDuplicateResolve(makeRequest({ headers: { 'x-ms-client-principal': adminHeader() } }), context);
    expect(response.status).toBe(409);
    expect(response.jsonBody).toMatchObject({ code: 'profile_locked', details: { lockedBy: 'avd-con-0' } });
  });

  it('maps LockCheckFailedError to 503', async () => {
    resolveDuplicateContainer.mockRejectedValue(new LockCheckFailedError('could not verify'));
    const context = makeContext();
    const response = await profileDuplicateResolve(makeRequest({ headers: { 'x-ms-client-principal': adminHeader() } }), context);
    expect(response.status).toBe(503);
    expect(response.jsonBody).toMatchObject({ code: 'profile_lock_check_failed' });
  });

  it('maps an unrecognized error to 502', async () => {
    resolveDuplicateContainer.mockRejectedValue(new Error('unexpected'));
    const context = makeContext();
    const response = await profileDuplicateResolve(makeRequest({ headers: { 'x-ms-client-principal': adminHeader() } }), context);
    expect(response.status).toBe(502);
    expect(response.jsonBody).toMatchObject({ code: 'profile_duplicate_resolve_failed' });
  });

  it('still returns 200 when writeAuditEntry rejects on the retire success path', async () => {
    writeAuditEntry.mockRejectedValueOnce(new Error('table unreachable'));
    const context = makeContext();
    const response = await profileDuplicateResolve(makeRequest({ headers: { 'x-ms-client-principal': adminHeader() } }), context);
    expect(response.status).toBe(200);
    expect(context.warnings.some((w) => w.includes('audit write threw unexpectedly'))).toBe(true);
  });
});
