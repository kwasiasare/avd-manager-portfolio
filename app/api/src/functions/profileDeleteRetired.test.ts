import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HttpRequest, InvocationContext } from '@azure/functions';

const deleteRetiredProfile = vi.fn();
vi.mock('../services/fslogixProfilesService', async () => {
  const actual = await vi.importActual<typeof import('../services/fslogixProfilesService')>('../services/fslogixProfilesService');
  return {
    ...actual,
    deleteRetiredProfile: (...args: unknown[]) => deleteRetiredProfile(...args),
  };
});

const writeAuditEntry = vi.fn().mockResolvedValue(undefined);
const isAuditRequiredButMissing = vi.fn().mockReturnValue(false);
vi.mock('../lib/auditLog', () => ({
  writeAuditEntry: (...args: unknown[]) => writeAuditEntry(...args),
  isAuditRequiredButMissing: (...args: unknown[]) => isAuditRequiredButMissing(...args),
}));

const { profileDeleteRetired } = await import('./profileDeleteRetired');
const {
  ProfileAmbiguousError,
  ProfileLockedError,
  RetiredProfileNotFoundError,
  LockCheckFailedError,
  RootFileMutationUnsupportedError,
} = await import('../services/fslogixProfilesService');

interface FakeContext extends InvocationContext {
  warnings: string[];
  errors: unknown[];
  logs: unknown[];
}

function makeRequest(options: {
  headers?: Record<string, string>;
  profileFolderName?: string;
  retiredFileName?: string;
  body?: unknown;
  jsonThrows?: boolean;
}): HttpRequest {
  const {
    headers = {},
    profileFolderName = 'S-1-5-21-1_jdoe',
    retiredFileName = 'Profile_jdoe.vhdx.retired-20260816-140233',
    body = { reason: 'retention window elapsed' },
    jsonThrows = false,
  } = options;
  const lower = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  return {
    url: `https://func-example.azurewebsites.net/api/v1/profiles/${profileFolderName}/retired/${retiredFileName}`,
    headers: { get: (name: string) => lower.get(name.toLowerCase()) ?? null },
    params: { profileFolderName, retiredFileName },
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
  deleteRetiredProfile.mockReset().mockResolvedValue(undefined);
  writeAuditEntry.mockReset().mockResolvedValue(undefined);
  isAuditRequiredButMissing.mockReset().mockReturnValue(false);
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('profileDeleteRetired — role gate', () => {
  it('returns 403 for an operator (this route is admin-only)', async () => {
    const context = makeContext();
    const response = await profileDeleteRetired(makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() } }), context);
    expect(response.status).toBe(403);
    expect(deleteRetiredProfile).not.toHaveBeenCalled();
    expect(writeAuditEntry).not.toHaveBeenCalled();
  });

  it('returns 401 for an unauthenticated caller', async () => {
    const context = makeContext();
    const response = await profileDeleteRetired(makeRequest({}), context);
    expect(response.status).toBe(401);
  });

  it('allows an admin', async () => {
    const context = makeContext();
    const response = await profileDeleteRetired(makeRequest({ headers: { 'x-ms-client-principal': adminHeader() } }), context);
    expect(response.status).toBe(200);
  });
});

describe('profileDeleteRetired — route param validation', () => {
  it('returns 400 for a profileFolderName containing a path separator', async () => {
    const context = makeContext();
    const response = await profileDeleteRetired(makeRequest({ headers: { 'x-ms-client-principal': adminHeader() }, profileFolderName: '..%2f..%2fetc' }), context);
    expect(response.status).toBe(400);
    expect(response.jsonBody).toMatchObject({ code: 'invalid_profile_folder_name' });
    expect(deleteRetiredProfile).not.toHaveBeenCalled();
  });

  it('returns 400 for a retiredFileName containing a path separator', async () => {
    const context = makeContext();
    const response = await profileDeleteRetired(makeRequest({ headers: { 'x-ms-client-principal': adminHeader() }, retiredFileName: '../../etc/passwd' }), context);
    expect(response.status).toBe(400);
    expect(response.jsonBody).toMatchObject({ code: 'invalid_retired_file_name' });
    expect(deleteRetiredProfile).not.toHaveBeenCalled();
  });

  it('accepts a Unicode folder name (peer review item 12)', async () => {
    const context = makeContext();
    const response = await profileDeleteRetired(makeRequest({ headers: { 'x-ms-client-principal': adminHeader() }, profileFolderName: 'S-1-5-21-1_jöhn' }), context);
    expect(response.status).toBe(200);
    expect(deleteRetiredProfile).toHaveBeenCalledWith('S-1-5-21-1_jöhn', 'Profile_jdoe.vhdx.retired-20260816-140233');
  });
});

describe('profileDeleteRetired — mandatory reason', () => {
  it('returns 400 when reason is missing, and never calls the service or writes audit', async () => {
    const context = makeContext();
    const response = await profileDeleteRetired(makeRequest({ headers: { 'x-ms-client-principal': adminHeader() }, body: {} }), context);
    expect(response.status).toBe(400);
    expect(response.jsonBody).toMatchObject({ code: 'missing_reason' });
    expect(deleteRetiredProfile).not.toHaveBeenCalled();
    expect(writeAuditEntry).not.toHaveBeenCalled();
  });
});

describe('profileDeleteRetired — fail-closed audit posture', () => {
  it('returns 500 and never calls the service when audit is required but not configured', async () => {
    isAuditRequiredButMissing.mockReturnValue(true);
    const context = makeContext();
    const response = await profileDeleteRetired(makeRequest({ headers: { 'x-ms-client-principal': adminHeader() } }), context);
    expect(response.status).toBe(500);
    expect(response.jsonBody).toMatchObject({ code: 'audit_not_configured' });
    expect(deleteRetiredProfile).not.toHaveBeenCalled();
    expect(writeAuditEntry).not.toHaveBeenCalled();
  });
});

describe('profileDeleteRetired — audit-before-mutation (peer review item 7)', () => {
  it('writes an "accepted" audit row BEFORE calling the service, then a "success" row after', async () => {
    const context = makeContext();
    const callOrder: string[] = [];
    writeAuditEntry.mockImplementation(async (event: { outcome: string }) => {
      callOrder.push(`audit:${event.outcome}`);
    });
    deleteRetiredProfile.mockImplementation(async () => {
      callOrder.push('service');
    });

    const response = await profileDeleteRetired(makeRequest({ headers: { 'x-ms-client-principal': adminHeader() } }), context);

    expect(response.status).toBe(200);
    expect(callOrder).toEqual(['audit:accepted', 'service', 'audit:success']);
  });

  it('still writes the pre-mutation "accepted" row even when the service call ultimately fails', async () => {
    deleteRetiredProfile.mockRejectedValue(new Error('boom'));
    const context = makeContext();

    await profileDeleteRetired(makeRequest({ headers: { 'x-ms-client-principal': adminHeader() } }), context);

    const outcomes = writeAuditEntry.mock.calls.map((call) => call[0].outcome);
    expect(outcomes).toEqual(['accepted', 'failure']);
  });
});

describe('profileDeleteRetired — happy path', () => {
  it('calls the service, returns 200, and audits with folder/retiredFileName as target', async () => {
    const context = makeContext();

    const response = await profileDeleteRetired(
      makeRequest({
        headers: { 'x-ms-client-principal': adminHeader('admin@example.com', 'obj-1') },
        profileFolderName: 'S-1-5-21-1_jdoe',
        retiredFileName: 'Profile_jdoe.vhdx.retired-20260816-140233',
        body: { reason: 'past retention window' },
      }),
      context,
    );

    expect(response.status).toBe(200);
    expect(response.jsonBody).toMatchObject({ status: 'deleted', folderName: 'S-1-5-21-1_jdoe', retiredFileName: 'Profile_jdoe.vhdx.retired-20260816-140233' });
    expect(deleteRetiredProfile).toHaveBeenCalledWith('S-1-5-21-1_jdoe', 'Profile_jdoe.vhdx.retired-20260816-140233');

    for (const [event] of writeAuditEntry.mock.calls) {
      expect(event).toMatchObject({
        actor: 'admin@example.com',
        actorId: 'obj-1',
        action: 'profile.deleteRetired',
        target: 'S-1-5-21-1_jdoe/Profile_jdoe.vhdx.retired-20260816-140233',
        reason: 'past retention window',
      });
    }
  });
});

describe('profileDeleteRetired — failure paths', () => {
  it('maps RetiredProfileNotFoundError to 404', async () => {
    deleteRetiredProfile.mockRejectedValue(new RetiredProfileNotFoundError('not found'));
    const context = makeContext();
    const response = await profileDeleteRetired(makeRequest({ headers: { 'x-ms-client-principal': adminHeader() } }), context);
    expect(response.status).toBe(404);
    expect(response.jsonBody).toMatchObject({ code: 'retired_profile_not_found' });
  });

  it('maps ProfileAmbiguousError to 409', async () => {
    deleteRetiredProfile.mockRejectedValue(new ProfileAmbiguousError('ambiguous'));
    const context = makeContext();
    const response = await profileDeleteRetired(makeRequest({ headers: { 'x-ms-client-principal': adminHeader() } }), context);
    expect(response.status).toBe(409);
    expect(response.jsonBody).toMatchObject({ code: 'profile_ambiguous' });
  });

  it('maps RootFileMutationUnsupportedError to 400', async () => {
    deleteRetiredProfile.mockRejectedValue(new RootFileMutationUnsupportedError('loose file'));
    const context = makeContext();
    const response = await profileDeleteRetired(makeRequest({ headers: { 'x-ms-client-principal': adminHeader() } }), context);
    expect(response.status).toBe(400);
    expect(response.jsonBody).toMatchObject({ code: 'root_file_mutation_unsupported' });
  });

  it('maps ProfileLockedError to 409 with the holder in details — the retired-file lock gate', async () => {
    deleteRetiredProfile.mockRejectedValue(new ProfileLockedError('avd-con-3'));
    const context = makeContext();
    const response = await profileDeleteRetired(makeRequest({ headers: { 'x-ms-client-principal': adminHeader() } }), context);
    expect(response.status).toBe(409);
    expect(response.jsonBody).toMatchObject({ code: 'profile_locked', details: { lockedBy: 'avd-con-3' } });
  });

  it('maps LockCheckFailedError to 503', async () => {
    deleteRetiredProfile.mockRejectedValue(new LockCheckFailedError('could not verify'));
    const context = makeContext();
    const response = await profileDeleteRetired(makeRequest({ headers: { 'x-ms-client-principal': adminHeader() } }), context);
    expect(response.status).toBe(503);
    expect(response.jsonBody).toMatchObject({ code: 'profile_lock_check_failed' });
  });

  it('maps an unrecognized error to 502', async () => {
    deleteRetiredProfile.mockRejectedValue(new Error('unexpected'));
    const context = makeContext();
    const response = await profileDeleteRetired(makeRequest({ headers: { 'x-ms-client-principal': adminHeader() } }), context);
    expect(response.status).toBe(502);
    expect(response.jsonBody).toMatchObject({ code: 'profile_delete_retired_failed' });
  });
});
