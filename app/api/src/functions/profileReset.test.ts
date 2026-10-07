import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HttpRequest, InvocationContext } from '@azure/functions';

const resetProfile = vi.fn();
vi.mock('../services/fslogixProfilesService', async () => {
  const actual = await vi.importActual<typeof import('../services/fslogixProfilesService')>('../services/fslogixProfilesService');
  return {
    ...actual,
    resetProfile: (...args: unknown[]) => resetProfile(...args),
  };
});

const writeAuditEntry = vi.fn().mockResolvedValue(undefined);
const isAuditRequiredButMissing = vi.fn().mockReturnValue(false);
vi.mock('../lib/auditLog', () => ({
  writeAuditEntry: (...args: unknown[]) => writeAuditEntry(...args),
  isAuditRequiredButMissing: (...args: unknown[]) => isAuditRequiredButMissing(...args),
}));

const { profileReset } = await import('./profileReset');
const { ProfileAmbiguousError, ProfileLockedError, ProfileNotFoundError, LockCheckFailedError, RootFileMutationUnsupportedError } = await import('../services/fslogixProfilesService');

interface FakeContext extends InvocationContext {
  warnings: string[];
  errors: unknown[];
  logs: unknown[];
}

function makeRequest(options: { headers?: Record<string, string>; profileFolderName?: string; body?: unknown; jsonThrows?: boolean }): HttpRequest {
  const { headers = {}, profileFolderName = 'S-1-5-21-1_jdoe', body = { reason: 'user requested reset' }, jsonThrows = false } = options;
  const lower = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  return {
    url: `https://func-example.azurewebsites.net/api/v1/profiles/${profileFolderName}/reset`,
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
  resetProfile.mockReset().mockResolvedValue({ originalFileName: 'Profile_jdoe.vhdx', retiredFileName: 'Profile_jdoe.vhdx.retired-20260816-140233' });
  writeAuditEntry.mockReset().mockResolvedValue(undefined);
  isAuditRequiredButMissing.mockReset().mockReturnValue(false);
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('profileReset — role gate', () => {
  it('returns 403 for an operator (this route is admin-only)', async () => {
    const context = makeContext();
    const response = await profileReset(makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() } }), context);

    expect(response.status).toBe(403);
    expect(resetProfile).not.toHaveBeenCalled();
    expect(writeAuditEntry).not.toHaveBeenCalled();
  });

  it('returns 401 for an unauthenticated caller', async () => {
    const context = makeContext();
    const response = await profileReset(makeRequest({}), context);
    expect(response.status).toBe(401);
  });

  it('allows an admin', async () => {
    const context = makeContext();
    const response = await profileReset(makeRequest({ headers: { 'x-ms-client-principal': adminHeader() } }), context);
    expect(response.status).toBe(200);
  });
});

describe('profileReset — route param validation', () => {
  it('returns 400 for a profileFolderName containing a path separator', async () => {
    const context = makeContext();
    const response = await profileReset(makeRequest({ headers: { 'x-ms-client-principal': adminHeader() }, profileFolderName: '..%2f..%2fetc' }), context);
    expect(response.status).toBe(400);
    expect(response.jsonBody).toMatchObject({ code: 'invalid_profile_folder_name' });
    expect(resetProfile).not.toHaveBeenCalled();
  });

  it('accepts a Unicode folder name (peer review item 12)', async () => {
    resetProfile.mockResolvedValue({ originalFileName: 'Profile_jöhn.vhdx', retiredFileName: 'Profile_jöhn.vhdx.retired-20260816-140233' });
    const context = makeContext();
    const response = await profileReset(makeRequest({ headers: { 'x-ms-client-principal': adminHeader() }, profileFolderName: 'S-1-5-21-1_jöhn' }), context);
    expect(response.status).toBe(200);
    expect(resetProfile).toHaveBeenCalledWith('S-1-5-21-1_jöhn');
  });
});

describe('profileReset — mandatory reason', () => {
  it('returns 400 when reason is missing, and never calls the service or writes audit', async () => {
    const context = makeContext();
    const response = await profileReset(makeRequest({ headers: { 'x-ms-client-principal': adminHeader() }, body: {} }), context);

    expect(response.status).toBe(400);
    expect(response.jsonBody).toMatchObject({ code: 'missing_reason' });
    expect(resetProfile).not.toHaveBeenCalled();
    expect(writeAuditEntry).not.toHaveBeenCalled();
  });

  it('returns 400 for an empty-string reason', async () => {
    const context = makeContext();
    const response = await profileReset(makeRequest({ headers: { 'x-ms-client-principal': adminHeader() }, body: { reason: '   ' } }), context);
    expect(response.status).toBe(400);
  });
});

describe('profileReset — fail-closed audit posture', () => {
  it('returns 500 and never calls the service when audit is required but not configured', async () => {
    isAuditRequiredButMissing.mockReturnValue(true);
    const context = makeContext();

    const response = await profileReset(makeRequest({ headers: { 'x-ms-client-principal': adminHeader() } }), context);

    expect(response.status).toBe(500);
    expect(response.jsonBody).toMatchObject({ code: 'audit_not_configured' });
    expect(resetProfile).not.toHaveBeenCalled();
  });
});

describe('profileReset — happy path', () => {
  it('calls the service, returns 200, and writes a success audit row with folder as target', async () => {
    const context = makeContext();

    const response = await profileReset(
      makeRequest({ headers: { 'x-ms-client-principal': adminHeader('admin@example.com', 'obj-1') }, profileFolderName: 'S-1-5-21-1_jdoe', body: { reason: 'user requested a fresh profile' } }),
      context,
    );

    expect(response.status).toBe(200);
    expect(response.jsonBody).toMatchObject({ status: 'retired', folderName: 'S-1-5-21-1_jdoe', originalFileName: 'Profile_jdoe.vhdx', retiredFileName: 'Profile_jdoe.vhdx.retired-20260816-140233' });
    expect(resetProfile).toHaveBeenCalledWith('S-1-5-21-1_jdoe');

    expect(writeAuditEntry).toHaveBeenCalledTimes(1);
    const [event] = writeAuditEntry.mock.calls[0];
    expect(event).toMatchObject({
      actor: 'admin@example.com',
      actorId: 'obj-1',
      action: 'profile.reset',
      target: 'S-1-5-21-1_jdoe',
      parameters: { originalFileName: 'Profile_jdoe.vhdx', retiredFileName: 'Profile_jdoe.vhdx.retired-20260816-140233' },
      reason: 'user requested a fresh profile',
      outcome: 'success',
    });
  });
});

describe('profileReset — failure paths', () => {
  it('maps ProfileNotFoundError to 404 and writes a failure audit row', async () => {
    resetProfile.mockRejectedValue(new ProfileNotFoundError('no active vhd'));
    const context = makeContext();

    const response = await profileReset(makeRequest({ headers: { 'x-ms-client-principal': adminHeader() } }), context);

    expect(response.status).toBe(404);
    expect(response.jsonBody).toMatchObject({ code: 'profile_not_found' });
    expect(writeAuditEntry.mock.calls[0][0].outcome).toBe('failure');
  });

  it('maps ProfileAmbiguousError to 409', async () => {
    resetProfile.mockRejectedValue(new ProfileAmbiguousError('ambiguous'));
    const context = makeContext();
    const response = await profileReset(makeRequest({ headers: { 'x-ms-client-principal': adminHeader() } }), context);
    expect(response.status).toBe(409);
    expect(response.jsonBody).toMatchObject({ code: 'profile_ambiguous' });
  });

  it('maps ProfileLockedError to 409 with the holder in details, and includes it in audit detail', async () => {
    resetProfile.mockRejectedValue(new ProfileLockedError('avd-con-0'));
    const context = makeContext();
    const response = await profileReset(makeRequest({ headers: { 'x-ms-client-principal': adminHeader() } }), context);

    expect(response.status).toBe(409);
    expect(response.jsonBody).toMatchObject({ code: 'profile_locked', details: { lockedBy: 'avd-con-0' } });
    expect(writeAuditEntry.mock.calls[0][0]).toMatchObject({ outcome: 'failure', detail: expect.stringContaining('avd-con-0') });
  });

  it('maps LockCheckFailedError to 503', async () => {
    resetProfile.mockRejectedValue(new LockCheckFailedError('could not verify'));
    const context = makeContext();
    const response = await profileReset(makeRequest({ headers: { 'x-ms-client-principal': adminHeader() } }), context);
    expect(response.status).toBe(503);
    expect(response.jsonBody).toMatchObject({ code: 'profile_lock_check_failed' });
  });

  it('maps RootFileMutationUnsupportedError to 400 (peer review item 4)', async () => {
    resetProfile.mockRejectedValue(new RootFileMutationUnsupportedError('loose root-level file, not a directory'));
    const context = makeContext();
    const response = await profileReset(makeRequest({ headers: { 'x-ms-client-principal': adminHeader() } }), context);
    expect(response.status).toBe(400);
    expect(response.jsonBody).toMatchObject({ code: 'root_file_mutation_unsupported' });
  });

  it('maps an unrecognized error to 502', async () => {
    resetProfile.mockRejectedValue(new Error('unexpected'));
    const context = makeContext();
    const response = await profileReset(makeRequest({ headers: { 'x-ms-client-principal': adminHeader() } }), context);
    expect(response.status).toBe(502);
    expect(response.jsonBody).toMatchObject({ code: 'profile_reset_failed' });
  });

  it('still returns 200 when writeAuditEntry rejects on the success path', async () => {
    writeAuditEntry.mockRejectedValueOnce(new Error('table unreachable'));
    const context = makeContext();
    const response = await profileReset(makeRequest({ headers: { 'x-ms-client-principal': adminHeader() } }), context);
    expect(response.status).toBe(200);
    expect(context.warnings.some((w) => w.includes('audit write threw unexpectedly'))).toBe(true);
  });

  it('still returns the mapped error status when writeAuditEntry rejects on the FAILURE path (peer review nit — audit try/catch symmetry)', async () => {
    resetProfile.mockRejectedValue(new ProfileNotFoundError('gone'));
    writeAuditEntry.mockRejectedValueOnce(new Error('table unreachable'));
    const context = makeContext();
    const response = await profileReset(makeRequest({ headers: { 'x-ms-client-principal': adminHeader() } }), context);
    expect(response.status).toBe(404);
    expect(context.warnings.some((w) => w.includes('audit write threw unexpectedly'))).toBe(true);
  });
});
