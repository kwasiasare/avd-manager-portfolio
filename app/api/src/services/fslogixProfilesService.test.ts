import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ParsedProfileFolderName } from '../lib/fslogixProfileName';
import { objectIdToEntraKerberosSid } from '../lib/fslogixProfileName';

const getFslogixShareServiceClient = vi.fn();
vi.mock('../lib/fslogixFileRestClient', () => ({
  getFslogixShareServiceClient: (...args: unknown[]) => getFslogixShareServiceClient(...args),
}));

const graphListAll = vi.fn();
const isGraphForbidden = vi.fn();
vi.mock('../lib/graphRest', () => ({
  graphListAll: (...args: unknown[]) => graphListAll(...args),
  isGraphForbidden: (...args: unknown[]) => isGraphForbidden(...args),
}));

const getFslogixShareUsage = vi.fn();
vi.mock('./fslogixService', () => ({
  getFslogixShareUsage: (...args: unknown[]) => getFslogixShareUsage(...args),
}));

const listUserSessions = vi.fn();
vi.mock('./avdService', () => ({
  listUserSessions: (...args: unknown[]) => listUserSessions(...args),
}));

const {
  bytesToGib,
  classifyContainers,
  classifyFileRestError,
  deriveLooseFileContainerName,
  deleteRetiredProfile,
  fetchGroupMembers,
  fetchRawShareSnapshot,
  isOversized,
  listProfiles,
  matchOrphan,
  resetProfile,
  restoreProfile,
  resolveDuplicateContainer,
  resolveLockState,
  _resetProfilesCacheForTests,
  ProfileNotFoundError,
  ProfileAmbiguousError,
  ProfileLockedError,
  ProfileNotDuplicateError,
  ProfileSessionCheckFailedError,
  ProfileUserSessionActiveError,
  ProfileUserUnresolvedError,
  LockCheckFailedError,
  RestoreConflictError,
  RetiredProfileNotFoundError,
  RootFileMutationUnsupportedError,
} = await import('./fslogixProfilesService');

const REAL_SID = 'S-1-5-21-853615705-2073118383-1177238915-1113';
const CLOUD_OBJECT_ID = 'a1b2c3d4-e5f6-4789-9abc-def012345678';
const CLOUD_KERBEROS_SID = objectIdToEntraKerberosSid(CLOUD_OBJECT_ID) as string;

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  process.env.SUBSCRIPTION_ID = 'sub-id';
  process.env.RG_HOSTPOOLS = 'RG-AVD-HostPools';
  process.env.HOSTPOOL_NAME = 'HP-CONTOSO-PROD';
  process.env.STORAGE_ACCOUNT_NAME = 'stcontoso001';
  process.env.FSLOGIX_SHARE_NAME = 'fslogixprofiles';
  process.env.FSLOGIX_OVERSIZED_GB = '5';
  delete process.env.AVD_USERS_GROUP_ID;
  getFslogixShareServiceClient.mockReset();
  graphListAll.mockReset();
  isGraphForbidden.mockReset().mockReturnValue(false);
  getFslogixShareUsage.mockReset();
  listUserSessions.mockReset().mockResolvedValue([]);
  _resetProfilesCacheForTests();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

// ---------------------------------------------------------------------------
// Fake FileREST tree — a realistic in-memory model of a share's root
// (directories + loose root files), each directory/file backed by its own
// mockable client, so tests can exercise assertMutableDirectory's root scan
// AND the per-directory/per-file operations resetProfile/restoreProfile/
// deleteRetiredProfile/listProfiles perform, from one consistent fake.
// ---------------------------------------------------------------------------

interface FakeHandle {
  clientName?: string;
  clientIp?: string;
}

interface FakeFileSpec {
  name: string;
  /** Handles returned across successive List Handles pages — [] or omitted = unlocked. Each inner array is one page; the fake's iterator reports `done` only after all pages are consumed, exercising resolveLockState's continuation-following loop. */
  handlePages?: FakeHandle[][];
  listHandlesThrows?: boolean;
  renameFn?: (dest: string) => Promise<void>;
  existsResult?: boolean;
  deleteFn?: () => Promise<void>;
}

interface FakeDirectorySpec {
  name: string;
  files: FakeFileSpec[];
}

function asyncIterableFrom<T>(items: T[]) {
  return {
    [Symbol.asyncIterator]: () => {
      let i = 0;
      return {
        next: async () => (i < items.length ? { value: items[i++], done: false } : { value: undefined, done: true }),
      };
    },
  };
}

function makeFakeFileClient(spec: FakeFileSpec | undefined, fallbackName: string) {
  const file = spec ?? { name: fallbackName };
  const pages = file.handlePages ?? [[]];
  return {
    rename: vi.fn(file.renameFn ?? (async () => undefined)),
    exists: vi.fn(async () => file.existsResult ?? false),
    delete: vi.fn(file.deleteFn ?? (async () => undefined)),
    listHandles: () => ({
      byPage: () => {
        let pageIndex = 0;
        return {
          next: async () => {
            if (file.listHandlesThrows) {
              throw new Error('listHandles failed');
            }
            if (pageIndex >= pages.length) {
              return { done: true, value: undefined };
            }
            const handleList = pages[pageIndex];
            pageIndex += 1;
            return { done: false, value: { handleList } };
          },
        };
      },
    }),
  };
}

/** Builds a fake ShareServiceClient over a tree of directories + loose root files — install via `getFslogixShareServiceClient.mockReturnValue(makeFakeShare(...))`. */
function makeFakeShare(directories: FakeDirectorySpec[], rootFiles: FakeFileSpec[] = []) {
  function directoryClientFor(dir: FakeDirectorySpec | undefined) {
    return {
      listFilesAndDirectories: () => asyncIterableFrom((dir?.files ?? []).map((f) => ({ kind: 'file' as const, name: f.name, properties: { contentLength: 1024, lastModified: new Date('2026-08-01T00:00:00Z') } }))),
      getFileClient: (fileName: string) => makeFakeFileClient(dir?.files.find((f) => f.name === fileName), fileName),
    };
  }

  const rootEntries = [
    ...directories.map((d) => ({ kind: 'directory' as const, name: d.name })),
    ...rootFiles.map((f) => ({ kind: 'file' as const, name: f.name, properties: { contentLength: 1024, lastModified: new Date('2026-08-01T00:00:00Z') } })),
  ];

  return {
    getShareClient: () => ({
      rootDirectoryClient: {
        listFilesAndDirectories: () => asyncIterableFrom(rootEntries),
        getDirectoryClient: (name: string) => directoryClientFor(directories.find((d) => d.name === name)),
        getFileClient: (fileName: string) => makeFakeFileClient(rootFiles.find((f) => f.name === fileName), fileName),
      },
    }),
  };
}

// ---------------------------------------------------------------------------
// fetchRawShareSnapshot — timestamps
// ---------------------------------------------------------------------------

describe('fetchRawShareSnapshot timestamps (live e2e regression 2026-08-16: every profile showed epoch zero)', () => {
  it('requests includeTimestamps on both listings, prefers SMB lastWriteTime, and yields undefined — never a fabricated epoch — when the service returns no timestamps', async () => {
    const rootOptions: unknown[] = [];
    const dirOptions: unknown[] = [];
    const write = new Date('2026-08-15T10:00:00Z');
    const modified = new Date('2026-08-14T10:00:00Z');
    getFslogixShareServiceClient.mockReturnValue({
      getShareClient: () => ({
        rootDirectoryClient: {
          listFilesAndDirectories: (options?: unknown) => {
            rootOptions.push(options);
            return asyncIterableFrom([{ kind: 'directory' as const, name: `${REAL_SID}_jdoe` }]);
          },
          getDirectoryClient: () => ({
            listFilesAndDirectories: (options?: unknown) => {
              dirOptions.push(options);
              return asyncIterableFrom([
                { kind: 'file' as const, name: 'Profile_jdoe.vhdx', properties: { contentLength: 1024, lastWriteTime: write, lastModified: modified } },
                { kind: 'file' as const, name: 'Profile_jdoe.vhdx.retired-20260101-000000', properties: { contentLength: 2048 } },
              ]);
            },
          }),
        },
      }),
    });

    const snapshot = await fetchRawShareSnapshot();

    expect(rootOptions[0]).toMatchObject({ includeTimestamps: true });
    expect(dirOptions[0]).toMatchObject({ includeTimestamps: true });
    const files = snapshot.containers[0].files;
    expect(files[0].lastModified).toEqual(write);
    expect(files[1].lastModified).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('bytesToGib / isOversized', () => {
  it('converts bytes to GiB, rounded to 2 decimals', () => {
    expect(bytesToGib(5 * 1024 ** 3)).toBe(5);
    expect(bytesToGib(1.5 * 1024 ** 3)).toBe(1.5);
  });

  it('flags a profile AT the threshold as oversized (inclusive)', () => {
    expect(isOversized(5 * 1024 ** 3, 5)).toBe(true);
  });

  it('does not flag a profile below the threshold', () => {
    expect(isOversized(4.9 * 1024 ** 3, 5)).toBe(false);
  });

  it('flags a profile above the threshold', () => {
    expect(isOversized(6 * 1024 ** 3, 5)).toBe(true);
  });
});

describe('deriveLooseFileContainerName', () => {
  it('strips a .vhdx extension from an active file', () => {
    expect(deriveLooseFileContainerName(`${REAL_SID}_jdoe.vhdx`)).toBe(`${REAL_SID}_jdoe`);
  });

  it('strips a .vhd extension case-insensitively', () => {
    expect(deriveLooseFileContainerName(`${REAL_SID}_jdoe.VHD`)).toBe(`${REAL_SID}_jdoe`);
  });

  it('recovers the original name from a retired file first, then strips the extension', () => {
    expect(deriveLooseFileContainerName(`${REAL_SID}_jdoe.vhdx.retired-20260816-140233`)).toBe(`${REAL_SID}_jdoe`);
  });
});

describe('classifyContainers', () => {
  it('classifies an active VHD, carries kind through, and parses its container name', () => {
    const result = classifyContainers([
      { containerName: `${REAL_SID}_jdoe`, kind: 'directory', files: [{ name: 'Profile_jdoe.vhdx', sizeBytes: 1024, lastModified: new Date('2026-08-01T00:00:00Z') }] },
    ]);
    expect(result.active).toHaveLength(1);
    expect(result.retired).toHaveLength(0);
    expect(result.active[0]).toMatchObject({
      folderName: `${REAL_SID}_jdoe`,
      fileName: 'Profile_jdoe.vhdx',
      kind: 'directory',
      sizeBytes: 1024,
      parsed: { sid: REAL_SID, userPrincipalName: 'jdoe', quality: 'sid_username' },
    });
  });

  it('classifies a retired VHD separately from active and carries kind through', () => {
    const result = classifyContainers([
      { containerName: `${REAL_SID}_jdoe`, kind: 'root-file', files: [{ name: 'Profile_jdoe.vhdx.retired-20260816-140233', sizeBytes: 2048, lastModified: new Date('2026-08-16T14:02:33Z') }] },
    ]);
    expect(result.active).toHaveLength(0);
    expect(result.retired).toHaveLength(1);
    expect(result.retired[0]).toMatchObject({ folderName: `${REAL_SID}_jdoe`, kind: 'root-file', retiredFileName: 'Profile_jdoe.vhdx.retired-20260816-140233', originalFileName: 'Profile_jdoe.vhdx', sizeBytes: 2048 });
  });

  it('ignores a non-VHD, non-retired file (e.g. desktop.ini)', () => {
    const result = classifyContainers([{ containerName: `${REAL_SID}_jdoe`, kind: 'directory', files: [{ name: 'desktop.ini', sizeBytes: 10, lastModified: new Date() }] }]);
    expect(result.active).toHaveLength(0);
    expect(result.retired).toHaveLength(0);
  });

  it('handles both an active and a retired file in the same folder', () => {
    const result = classifyContainers([
      {
        containerName: `${REAL_SID}_jdoe`,
        kind: 'directory',
        files: [
          { name: 'Profile_jdoe.vhdx', sizeBytes: 1024, lastModified: new Date('2026-08-17T00:00:00Z') },
          { name: 'Profile_jdoe.vhdx.retired-20260816-140233', sizeBytes: 2048, lastModified: new Date('2026-08-16T14:02:33Z') },
        ],
      },
    ]);
    expect(result.active).toHaveLength(1);
    expect(result.retired).toHaveLength(1);
  });

  it('parses an unrecognized folder name but still lists its VHD', () => {
    const result = classifyContainers([{ containerName: 'randomfolder', kind: 'directory', files: [{ name: 'Profile_x.vhdx', sizeBytes: 1, lastModified: new Date() }] }]);
    expect(result.active[0].parsed).toEqual({ sid: undefined, userPrincipalName: undefined, quality: 'unrecognized' });
  });

  it('classifies a .vhdx file as ACTIVE even if its name contains ".retired-" as a substring (extension wins — peer review ordering fix)', () => {
    const result = classifyContainers([{ containerName: 'user1', kind: 'directory', files: [{ name: 'Profile.retired-user.vhdx', sizeBytes: 1, lastModified: new Date() }] }]);
    expect(result.active).toHaveLength(1);
    expect(result.active[0].fileName).toBe('Profile.retired-user.vhdx');
    expect(result.retired).toHaveLength(0);
  });
});

describe('matchOrphan', () => {
  const parsedRecognized: ParsedProfileFolderName = { sid: REAL_SID, userPrincipalName: 'jdoe', quality: 'sid_username' };
  const parsedUnrecognized: ParsedProfileFolderName = { sid: undefined, userPrincipalName: undefined, quality: 'unrecognized' };

  it('is unknown when orphan detection is not configured', () => {
    expect(matchOrphan(parsedRecognized, { status: 'not-configured' })).toMatchObject({ status: 'unknown', evidence: expect.stringContaining('not configured') });
  });

  it('is unknown when Graph permission has not been granted', () => {
    expect(matchOrphan(parsedRecognized, { status: 'graph-not-granted' })).toMatchObject({ status: 'unknown', evidence: expect.stringContaining('GroupMember.Read.All') });
  });

  it('is unknown when Graph was called but failed for a non-403 reason (peer review item 1)', () => {
    expect(matchOrphan(parsedRecognized, { status: 'unavailable', reason: 'Graph 500' })).toMatchObject({ status: 'unknown', evidence: expect.stringContaining('Graph 500') });
  });

  it('is unknown when the folder name did not parse, even with members available', () => {
    expect(matchOrphan(parsedUnrecognized, { status: 'ok', members: [{ sid: REAL_SID, entraKerberosSid: undefined, userPrincipalNameLocalPart: 'jdoe' }], truncated: false })).toMatchObject({
      status: 'unknown',
      evidence: expect.stringContaining('could not be parsed'),
    });
  });

  it('is not-orphan on an on-premises SID match', () => {
    expect(
      matchOrphan(parsedRecognized, { status: 'ok', members: [{ sid: REAL_SID, entraKerberosSid: undefined, userPrincipalNameLocalPart: 'someone-else' }], truncated: false }),
    ).toMatchObject({ status: 'not-orphan', evidence: expect.stringContaining('SID') });
  });

  it('is not-orphan on an on-premises SID match, case-insensitively', () => {
    expect(
      matchOrphan(parsedRecognized, { status: 'ok', members: [{ sid: REAL_SID.toLowerCase(), entraKerberosSid: undefined, userPrincipalNameLocalPart: undefined }], truncated: false }),
    ).toMatchObject({ status: 'not-orphan' });
  });

  it('is not-orphan on a DERIVED Entra Kerberos cloud SID match (peer review item 2 — cloud-only identities)', () => {
    const parsedCloud: ParsedProfileFolderName = { sid: CLOUD_KERBEROS_SID, userPrincipalName: 'cloudonly', quality: 'sid_username' };
    expect(
      matchOrphan(parsedCloud, { status: 'ok', members: [{ sid: undefined, entraKerberosSid: CLOUD_KERBEROS_SID, userPrincipalNameLocalPart: 'cloudonly' }], truncated: false }),
    ).toMatchObject({ status: 'not-orphan', evidence: expect.stringContaining('SID') });
  });

  it('falls back to a username match when SID does not match, wording it as possible drift WHEN some member has a SID (peer review item 2)', () => {
    const result = matchOrphan(parsedRecognized, {
      status: 'ok',
      members: [{ sid: 'S-1-5-21-999-999-999-9999', entraKerberosSid: undefined, userPrincipalNameLocalPart: 'jdoe' }],
      truncated: false,
    });
    expect(result.status).toBe('not-orphan');
    expect(result.evidence).toContain('possible SID drift');
  });

  it('does NOT say "possible SID drift" when NO member in the snapshot carries any SID at all — says SID matching was unavailable instead (peer review item 2)', () => {
    const result = matchOrphan(parsedRecognized, {
      status: 'ok',
      members: [{ sid: undefined, entraKerberosSid: undefined, userPrincipalNameLocalPart: 'jdoe' }],
      truncated: false,
    });
    expect(result.status).toBe('not-orphan');
    expect(result.evidence).not.toContain('drift');
    expect(result.evidence).toContain('SID matching was unavailable');
  });

  it('matches by username alone when the folder name has no SID', () => {
    const parsedUsernameOnly: ParsedProfileFolderName = { sid: undefined, userPrincipalName: 'jdoe', quality: 'sid_username' };
    expect(matchOrphan(parsedUsernameOnly, { status: 'ok', members: [{ sid: undefined, entraKerberosSid: undefined, userPrincipalNameLocalPart: 'jdoe' }], truncated: false })).toMatchObject({
      status: 'not-orphan',
      evidence: expect.stringContaining('username'),
    });
  });

  it('is orphan when no member matches SID or username and the snapshot is NOT truncated', () => {
    const result = matchOrphan(parsedRecognized, {
      status: 'ok',
      members: [{ sid: 'S-1-5-21-999-999-999-9999', entraKerberosSid: undefined, userPrincipalNameLocalPart: 'someone-else' }],
      truncated: false,
    });
    expect(result.status).toBe('orphan');
    expect(result.evidence).toContain('No AVD-Users group member matches');
  });

  it('is orphan against an empty, non-truncated membership list', () => {
    expect(matchOrphan(parsedRecognized, { status: 'ok', members: [], truncated: false })).toMatchObject({ status: 'orphan' });
  });

  it('downgrades a non-match to unknown (not orphan) when the snapshot is truncated (peer review item 3)', () => {
    const result = matchOrphan(parsedRecognized, { status: 'ok', members: [], truncated: true });
    expect(result.status).toBe('unknown');
    expect(result.evidence).toContain('truncated');
  });
});

// ---------------------------------------------------------------------------
// fetchGroupMembers — Graph degradation states + truncation + SID derivation
// ---------------------------------------------------------------------------

describe('fetchGroupMembers', () => {
  it('returns not-configured when AVD_USERS_GROUP_ID is unset', async () => {
    const result = await fetchGroupMembers();
    expect(result).toEqual({ status: 'not-configured' });
    expect(graphListAll).not.toHaveBeenCalled();
  });

  it('returns graph-not-granted on a Graph 403', async () => {
    process.env.AVD_USERS_GROUP_ID = 'group-1';
    graphListAll.mockRejectedValue(Object.assign(new Error('forbidden'), { statusCode: 403 }));
    isGraphForbidden.mockReturnValue(true);

    const result = await fetchGroupMembers();
    expect(result).toEqual({ status: 'graph-not-granted' });
  });

  it('returns unavailable (not a throw) on a non-403 Graph error — peer review item 1', async () => {
    process.env.AVD_USERS_GROUP_ID = 'group-1';
    graphListAll.mockRejectedValue(Object.assign(new Error('Internal Server Error'), { statusCode: 500 }));
    isGraphForbidden.mockReturnValue(false);

    const result = await fetchGroupMembers();
    expect(result).toEqual({ status: 'unavailable', reason: 'Internal Server Error' });
  });

  it('maps Graph members to sid/entraKerberosSid/userPrincipalNameLocalPart, filtering to users only, and propagates truncated', async () => {
    process.env.AVD_USERS_GROUP_ID = 'group-1';
    graphListAll.mockResolvedValue({
      items: [
        { '@odata.type': '#microsoft.graph.user', id: '1', userPrincipalName: 'jdoe@contoso.example', onPremisesSecurityIdentifier: REAL_SID },
        { '@odata.type': '#microsoft.graph.user', id: CLOUD_OBJECT_ID, userPrincipalName: 'cloudonly@contoso.example', onPremisesSecurityIdentifier: undefined },
        { '@odata.type': '#microsoft.graph.group', id: '2', userPrincipalName: undefined },
      ],
      truncated: true,
    });

    const result = await fetchGroupMembers();
    expect(result).toEqual({
      status: 'ok',
      truncated: true,
      members: [
        { sid: REAL_SID, entraKerberosSid: undefined, userPrincipalNameLocalPart: 'jdoe' },
        { sid: undefined, entraKerberosSid: CLOUD_KERBEROS_SID, userPrincipalNameLocalPart: 'cloudonly' },
      ],
    });
  });

  it('requests $top=999 to raise the per-page ceiling (peer review item 3)', async () => {
    process.env.AVD_USERS_GROUP_ID = 'group-1';
    graphListAll.mockResolvedValue({ items: [], truncated: false });

    await fetchGroupMembers();

    expect(graphListAll).toHaveBeenCalledWith(expect.stringContaining('$top=999'));
  });
});

// ---------------------------------------------------------------------------
// resolveLockState
// ---------------------------------------------------------------------------

function fakeFileClientForLockState(pages: FakeHandle[][]) {
  let pageIndex = 0;
  return {
    listHandles: () => ({
      byPage: () => ({
        next: async () => {
          if (pageIndex >= pages.length) {
            return { done: true, value: undefined };
          }
          const handleList = pages[pageIndex];
          pageIndex += 1;
          return { done: false, value: { handleList } };
        },
      }),
    }),
  };
}

describe('resolveLockState', () => {
  it('is unlocked when there are no handles (single page)', async () => {
    expect(await resolveLockState(fakeFileClientForLockState([[]]))).toEqual({ locked: false, lockedBy: undefined });
  });

  it('is locked and names the holder by clientName', async () => {
    expect(await resolveLockState(fakeFileClientForLockState([[{ clientName: 'avd-con-0', clientIp: '192.0.2.5' }]]))).toEqual({ locked: true, lockedBy: 'avd-con-0' });
  });

  it('falls back to clientIp when clientName is empty', async () => {
    expect(await resolveLockState(fakeFileClientForLockState([[{ clientName: '', clientIp: '192.0.2.5' }]]))).toEqual({ locked: true, lockedBy: '192.0.2.5' });
  });

  it('follows the continuation marker past an EMPTY first page to find a handle on a later page (peer review item 8 — the fail-open bug)', async () => {
    const result = await resolveLockState(fakeFileClientForLockState([[], [], [{ clientName: 'avd-con-1' }]]));
    expect(result).toEqual({ locked: true, lockedBy: 'avd-con-1' });
  });

  it('is unlocked only once the iterator truly reports done, not merely on one empty page', async () => {
    const result = await resolveLockState(fakeFileClientForLockState([[], [], []]));
    expect(result).toEqual({ locked: false, lockedBy: undefined });
  });

  it('throws if List Handles never resolves within the page bound (fail-closed contract for callers)', async () => {
    const manyEmptyPages: FakeHandle[][] = Array.from({ length: 51 }, () => []);
    await expect(resolveLockState(fakeFileClientForLockState(manyEmptyPages))).rejects.toThrow(/did not resolve within/);
  });
});

// ---------------------------------------------------------------------------
// classifyFileRestError
// ---------------------------------------------------------------------------

describe('classifyFileRestError', () => {
  it('classifies a 403 as forbidden', () => {
    expect(classifyFileRestError(Object.assign(new Error('x'), { statusCode: 403 }))).toBe('forbidden');
  });

  it('classifies common connection error codes as network', () => {
    expect(classifyFileRestError(Object.assign(new Error('x'), { code: 'ENOTFOUND' }))).toBe('network');
    expect(classifyFileRestError(Object.assign(new Error('x'), { code: 'ETIMEDOUT' }))).toBe('network');
  });

  it('classifies an AbortError/TimeoutError as network', () => {
    const abort = new Error('aborted');
    abort.name = 'AbortError';
    expect(classifyFileRestError(abort)).toBe('network');
  });

  it('classifies anything else as other', () => {
    expect(classifyFileRestError(new Error('mystery'))).toBe('other');
  });
});

// ---------------------------------------------------------------------------
// resetProfile / restoreProfile / deleteRetiredProfile — mocked share tree
// ---------------------------------------------------------------------------

describe('resetProfile', () => {
  it('renames the sole active VHD to a retired name when unlocked', async () => {
    getFslogixShareServiceClient.mockReturnValue(makeFakeShare([{ name: `${REAL_SID}_jdoe`, files: [{ name: 'Profile_jdoe.vhdx' }] }]));

    const result = await resetProfile(`${REAL_SID}_jdoe`);

    expect(result.originalFileName).toBe('Profile_jdoe.vhdx');
    expect(result.retiredFileName).toMatch(/^Profile_jdoe\.vhdx\.retired-\d{8}-\d{6}$/);
  });

  it('refuses with ProfileLockedError and names the holder when a handle is open', async () => {
    getFslogixShareServiceClient.mockReturnValue(
      makeFakeShare([{ name: `${REAL_SID}_jdoe`, files: [{ name: 'Profile_jdoe.vhdx', handlePages: [[{ clientName: 'avd-con-0' }]] }] }]),
    );

    const error = await resetProfile(`${REAL_SID}_jdoe`).catch((e) => e);
    expect(error).toBeInstanceOf(ProfileLockedError);
    expect(error.holder).toBe('avd-con-0');
  });

  it('refuses with LockCheckFailedError when the handle check itself fails (fail closed)', async () => {
    getFslogixShareServiceClient.mockReturnValue(makeFakeShare([{ name: `${REAL_SID}_jdoe`, files: [{ name: 'Profile_jdoe.vhdx', listHandlesThrows: true }] }]));

    await expect(resetProfile(`${REAL_SID}_jdoe`)).rejects.toThrow(LockCheckFailedError);
  });

  it('maps a rename-time 409 (TOCTOU) to ProfileLockedError instead of a generic error — peer review item 9', async () => {
    getFslogixShareServiceClient.mockReturnValue(
      makeFakeShare([
        {
          name: `${REAL_SID}_jdoe`,
          files: [
            {
              name: 'Profile_jdoe.vhdx',
              renameFn: async () => {
                throw Object.assign(new Error('conflict'), { statusCode: 409 });
              },
            },
          ],
        },
      ]),
    );

    await expect(resetProfile(`${REAL_SID}_jdoe`)).rejects.toThrow(ProfileLockedError);
  });

  it('throws ProfileNotFoundError when the folder has no active VHD', async () => {
    getFslogixShareServiceClient.mockReturnValue(makeFakeShare([{ name: `${REAL_SID}_jdoe`, files: [{ name: 'desktop.ini' }] }]));

    await expect(resetProfile(`${REAL_SID}_jdoe`)).rejects.toThrow(ProfileNotFoundError);
  });

  it('throws ProfileNotFoundError when the folder does not exist at all', async () => {
    getFslogixShareServiceClient.mockReturnValue(makeFakeShare([]));

    await expect(resetProfile(`${REAL_SID}_jdoe`)).rejects.toThrow(ProfileNotFoundError);
  });

  it('throws ProfileAmbiguousError when more than one active VHD exists in the same folder', async () => {
    getFslogixShareServiceClient.mockReturnValue(
      makeFakeShare([{ name: `${REAL_SID}_jdoe`, files: [{ name: 'Profile_jdoe.vhdx' }, { name: 'ODFC_jdoe.vhdx' }] }]),
    );

    await expect(resetProfile(`${REAL_SID}_jdoe`)).rejects.toThrow(ProfileAmbiguousError);
  });

  it('LOOSE-FILE / DIRECTORY COLLISION (peer review item 4): refuses with ProfileAmbiguousError rather than silently resetting the directory instead of the intended loose file', async () => {
    // A genuine directory "Foo" AND a loose root-level file "Foo.vhdx" (derived name "Foo") both exist.
    getFslogixShareServiceClient.mockReturnValue(
      makeFakeShare([{ name: 'Foo', files: [{ name: 'Profile_foo.vhdx' }] }], [{ name: 'Foo.vhdx' }]),
    );

    await expect(resetProfile('Foo')).rejects.toThrow(ProfileAmbiguousError);
  });

  it('LOOSE-FILE-ONLY (peer review item 4): refuses with RootFileMutationUnsupportedError when the target is only a loose root-level file, no directory of that name exists', async () => {
    getFslogixShareServiceClient.mockReturnValue(makeFakeShare([], [{ name: 'Foo.vhdx' }]));

    await expect(resetProfile('Foo')).rejects.toThrow(RootFileMutationUnsupportedError);
  });

  it('proceeds normally when only the real directory exists (no collision) — unaffected by the ambiguity guard', async () => {
    getFslogixShareServiceClient.mockReturnValue(makeFakeShare([{ name: 'Foo', files: [{ name: 'Profile_foo.vhdx' }] }]));

    const result = await resetProfile('Foo');
    expect(result.originalFileName).toBe('Profile_foo.vhdx');
  });
});

describe('restoreProfile', () => {
  it('renames a retired file back to its original name when the destination is free', async () => {
    getFslogixShareServiceClient.mockReturnValue(
      makeFakeShare([{ name: `${REAL_SID}_jdoe`, files: [{ name: 'Profile_jdoe.vhdx.retired-20260816-140233' }, { name: 'Profile_jdoe.vhdx', existsResult: false }] }]),
    );

    const result = await restoreProfile(`${REAL_SID}_jdoe`, 'Profile_jdoe.vhdx.retired-20260816-140233');

    expect(result.restoredFileName).toBe('Profile_jdoe.vhdx');
  });

  it('refuses with RestoreConflictError when the destination already exists', async () => {
    getFslogixShareServiceClient.mockReturnValue(
      makeFakeShare([{ name: `${REAL_SID}_jdoe`, files: [{ name: 'Profile_jdoe.vhdx.retired-20260816-140233' }, { name: 'Profile_jdoe.vhdx', existsResult: true }] }]),
    );

    await expect(restoreProfile(`${REAL_SID}_jdoe`, 'Profile_jdoe.vhdx.retired-20260816-140233')).rejects.toThrow(RestoreConflictError);
  });

  it('throws RetiredProfileNotFoundError for a name that does not parse as retired', async () => {
    getFslogixShareServiceClient.mockReturnValue(makeFakeShare([{ name: `${REAL_SID}_jdoe`, files: [{ name: 'Profile_jdoe.vhdx' }] }]));

    await expect(restoreProfile(`${REAL_SID}_jdoe`, 'Profile_jdoe.vhdx')).rejects.toThrow(RetiredProfileNotFoundError);
  });

  it('maps a 404 on rename to RetiredProfileNotFoundError', async () => {
    getFslogixShareServiceClient.mockReturnValue(
      makeFakeShare([
        {
          name: `${REAL_SID}_jdoe`,
          files: [
            {
              name: 'Profile_jdoe.vhdx.retired-20260816-140233',
              renameFn: async () => {
                throw Object.assign(new Error('not found'), { statusCode: 404 });
              },
            },
            { name: 'Profile_jdoe.vhdx', existsResult: false },
          ],
        },
      ]),
    );

    await expect(restoreProfile(`${REAL_SID}_jdoe`, 'Profile_jdoe.vhdx.retired-20260816-140233')).rejects.toThrow(RetiredProfileNotFoundError);
  });

  it('maps a rename-time 409 (TOCTOU) to RestoreConflictError — peer review item 9', async () => {
    getFslogixShareServiceClient.mockReturnValue(
      makeFakeShare([
        {
          name: `${REAL_SID}_jdoe`,
          files: [
            {
              name: 'Profile_jdoe.vhdx.retired-20260816-140233',
              renameFn: async () => {
                throw Object.assign(new Error('conflict'), { statusCode: 409 });
              },
            },
            { name: 'Profile_jdoe.vhdx', existsResult: false },
          ],
        },
      ]),
    );

    await expect(restoreProfile(`${REAL_SID}_jdoe`, 'Profile_jdoe.vhdx.retired-20260816-140233')).rejects.toThrow(RestoreConflictError);
  });

  it('refuses root-file targets the same as resetProfile (shared guard)', async () => {
    getFslogixShareServiceClient.mockReturnValue(makeFakeShare([], [{ name: 'Foo.vhdx' }]));

    await expect(restoreProfile('Foo', 'Foo.vhdx.retired-20260816-140233')).rejects.toThrow(RootFileMutationUnsupportedError);
  });
});

describe('deleteRetiredProfile — peer review item 7 (IRREVERSIBLE — flagged for product sign-off, see final report)', () => {
  it('deletes an unlocked retired file', async () => {
    const deleteFn = vi.fn(async () => undefined);
    getFslogixShareServiceClient.mockReturnValue(
      makeFakeShare([{ name: `${REAL_SID}_jdoe`, files: [{ name: 'Profile_jdoe.vhdx.retired-20260816-140233', deleteFn }] }]),
    );

    await deleteRetiredProfile(`${REAL_SID}_jdoe`, 'Profile_jdoe.vhdx.retired-20260816-140233');

    expect(deleteFn).toHaveBeenCalledTimes(1);
  });

  it('refuses with ProfileLockedError when the retired file has an open handle', async () => {
    getFslogixShareServiceClient.mockReturnValue(
      makeFakeShare([{ name: `${REAL_SID}_jdoe`, files: [{ name: 'Profile_jdoe.vhdx.retired-20260816-140233', handlePages: [[{ clientName: 'avd-con-2' }]] }] }]),
    );

    await expect(deleteRetiredProfile(`${REAL_SID}_jdoe`, 'Profile_jdoe.vhdx.retired-20260816-140233')).rejects.toThrow(ProfileLockedError);
  });

  it('refuses with LockCheckFailedError when the handle check fails', async () => {
    getFslogixShareServiceClient.mockReturnValue(
      makeFakeShare([{ name: `${REAL_SID}_jdoe`, files: [{ name: 'Profile_jdoe.vhdx.retired-20260816-140233', listHandlesThrows: true }] }]),
    );

    await expect(deleteRetiredProfile(`${REAL_SID}_jdoe`, 'Profile_jdoe.vhdx.retired-20260816-140233')).rejects.toThrow(LockCheckFailedError);
  });

  it('throws RetiredProfileNotFoundError for a name that does not parse as retired', async () => {
    getFslogixShareServiceClient.mockReturnValue(makeFakeShare([{ name: `${REAL_SID}_jdoe`, files: [] }]));

    await expect(deleteRetiredProfile(`${REAL_SID}_jdoe`, 'Profile_jdoe.vhdx')).rejects.toThrow(RetiredProfileNotFoundError);
  });

  it('maps a 404 on delete to RetiredProfileNotFoundError', async () => {
    getFslogixShareServiceClient.mockReturnValue(
      makeFakeShare([
        {
          name: `${REAL_SID}_jdoe`,
          files: [
            {
              name: 'Profile_jdoe.vhdx.retired-20260816-140233',
              deleteFn: async () => {
                throw Object.assign(new Error('not found'), { statusCode: 404 });
              },
            },
          ],
        },
      ]),
    );

    await expect(deleteRetiredProfile(`${REAL_SID}_jdoe`, 'Profile_jdoe.vhdx.retired-20260816-140233')).rejects.toThrow(RetiredProfileNotFoundError);
  });

  it('refuses root-file targets the same as resetProfile/restoreProfile (shared guard)', async () => {
    getFslogixShareServiceClient.mockReturnValue(makeFakeShare([], [{ name: 'Foo.vhdx.retired-20260816-140233' }]));

    await expect(deleteRetiredProfile('Foo', 'Foo.vhdx.retired-20260816-140233')).rejects.toThrow(RootFileMutationUnsupportedError);
  });
});

// ---------------------------------------------------------------------------
// listProfiles — degradation, partial listings, caching, loose-file end-to-end
// ---------------------------------------------------------------------------

function makeFailingRootShare(error: unknown) {
  return {
    getShareClient: () => ({
      rootDirectoryClient: {
        listFilesAndDirectories: () => ({
          [Symbol.asyncIterator]: () => ({
            next: async () => {
              throw error;
            },
          }),
        }),
      },
    }),
  };
}

describe('listProfiles', () => {
  it('degrades to the management-plane fallback with a CLASSIFIED reason (no raw SDK text on the wire) when FileREST listing fails — peer review item 17', async () => {
    getFslogixShareServiceClient.mockReturnValue(makeFailingRootShare(Object.assign(new Error('private endpoint unreachable, ENOTFOUND'), { code: 'ENOTFOUND' })));
    getFslogixShareUsage.mockResolvedValue({ storageAccountName: 'stcontoso001', shareName: 'fslogixprofiles', provisionedGib: 100, usedBytes: 1, usedGib: 0, percentUsed: 0 });

    const result = await listProfiles();

    expect(result.fileRest).toEqual({ status: 'unavailable', reason: 'network' });
    expect(result.profiles).toEqual([]);
    expect(result.retired).toEqual([]);
    expect(result.partial).toBe(false);
    expect(result.fallbackShareUsage).toMatchObject({ storageAccountName: 'stcontoso001' });
  });

  it('reports orphanDetection as not-evaluated (not a fabricated not-configured) on the FileREST-unavailable path — peer review item 11', async () => {
    getFslogixShareServiceClient.mockReturnValue(makeFailingRootShare(new Error('boom')));
    getFslogixShareUsage.mockResolvedValue(undefined);

    const result = await listProfiles();
    expect(result.orphanDetection).toEqual({ status: 'not-evaluated' });
  });

  it('classifies a 403 as forbidden on the wire', async () => {
    getFslogixShareServiceClient.mockReturnValue(makeFailingRootShare(Object.assign(new Error('secret internal detail'), { statusCode: 403 })));
    getFslogixShareUsage.mockResolvedValue(undefined);

    const result = await listProfiles();
    expect(result.fileRest).toEqual({ status: 'unavailable', reason: 'forbidden' });
  });

  it('still returns a response (fallbackShareUsage undefined) when BOTH FileREST and the management-plane fallback fail', async () => {
    getFslogixShareServiceClient.mockReturnValue(makeFailingRootShare(new Error('unreachable')));
    getFslogixShareUsage.mockRejectedValue(new Error('also unreachable'));

    const result = await listProfiles();
    expect(result.fileRest.status).toBe('unavailable');
    expect(result.fallbackShareUsage).toBeUndefined();
  });

  it('degrades ONLY orphan detection (never the whole page) when Graph fails with a non-403 error — peer review item 1', async () => {
    getFslogixShareServiceClient.mockReturnValue(makeFakeShare([{ name: `${REAL_SID}_jdoe`, files: [{ name: 'Profile_jdoe.vhdx' }] }]));
    process.env.AVD_USERS_GROUP_ID = 'group-1';
    graphListAll.mockRejectedValue(Object.assign(new Error('Graph 500'), { statusCode: 500 }));
    isGraphForbidden.mockReturnValue(false);

    const result = await listProfiles();

    expect(result.fileRest).toEqual({ status: 'available' });
    expect(result.profiles).toHaveLength(1);
    expect(result.profiles[0].orphanStatus).toBe('unknown');
    expect(result.orphanDetection).toEqual({ status: 'unavailable', reason: 'Graph 500' });
  });

  it('degrades ONLY orphan detection when Graph returns a 404 for a mistyped group id (peer review item 1\'s specific example)', async () => {
    getFslogixShareServiceClient.mockReturnValue(makeFakeShare([{ name: `${REAL_SID}_jdoe`, files: [{ name: 'Profile_jdoe.vhdx' }] }]));
    process.env.AVD_USERS_GROUP_ID = 'not-a-real-group-id';
    graphListAll.mockRejectedValue(Object.assign(new Error('Resource not found'), { statusCode: 404 }));
    isGraphForbidden.mockReturnValue(false);

    const result = await listProfiles();

    expect(result.fileRest).toEqual({ status: 'available' });
    expect(result.orphanDetection).toEqual({ status: 'unavailable', reason: 'Resource not found' });
  });

  it('marks the response partial (peer review item 10) when one directory fails to list, without dropping the others', async () => {
    const okDirectory = { name: 'ok-dir', files: [{ name: 'Profile_ok.vhdx' }] };
    const badDirectoryClient = {
      listFilesAndDirectories: () => ({
        [Symbol.asyncIterator]: () => ({
          next: async () => {
            throw new Error('directory listing failed');
          },
        }),
      }),
      getFileClient: () => makeFakeFileClient(undefined, 'unused'),
    };

    getFslogixShareServiceClient.mockReturnValue({
      getShareClient: () => ({
        rootDirectoryClient: {
          listFilesAndDirectories: () =>
            asyncIterableFrom([
              { kind: 'directory', name: okDirectory.name },
              { kind: 'directory', name: 'bad-dir' },
            ]),
          getDirectoryClient: (name: string) => (name === 'bad-dir' ? badDirectoryClient : makeFakeShare([okDirectory]).getShareClient().rootDirectoryClient.getDirectoryClient(name)),
        },
      }),
    });

    const result = await listProfiles();

    expect(result.fileRest).toEqual({ status: 'available' });
    expect(result.partial).toBe(true);
    expect(result.profiles.map((p) => p.folderName)).toEqual(['ok-dir']);
  });

  it('LOOSE-FILE end-to-end (peer review item 4): a root-level VHD with no wrapping directory is listed with kind root-file', async () => {
    getFslogixShareServiceClient.mockReturnValue(makeFakeShare([], [{ name: `${REAL_SID}_jdoe.vhdx` }]));

    const result = await listProfiles();

    expect(result.fileRest).toEqual({ status: 'available' });
    expect(result.profiles).toHaveLength(1);
    expect(result.profiles[0]).toMatchObject({ folderName: `${REAL_SID}_jdoe`, fileName: `${REAL_SID}_jdoe.vhdx`, kind: 'root-file' });
  });

  it('caches an available result — a second call within the TTL does not re-invoke the FileREST client (peer review item 6)', async () => {
    const shareServiceClientFactory = vi.fn(() => makeFakeShare([{ name: `${REAL_SID}_jdoe`, files: [{ name: 'Profile_jdoe.vhdx' }] }]));
    getFslogixShareServiceClient.mockImplementation(shareServiceClientFactory);

    await listProfiles();
    const callsAfterFirst = shareServiceClientFactory.mock.calls.length;
    await listProfiles();
    const callsAfterSecond = shareServiceClientFactory.mock.calls.length;

    expect(callsAfterSecond).toBe(callsAfterFirst);
  });

  it('forceRefresh bypasses the cache', async () => {
    const shareServiceClientFactory = vi.fn(() => makeFakeShare([{ name: `${REAL_SID}_jdoe`, files: [{ name: 'Profile_jdoe.vhdx' }] }]));
    getFslogixShareServiceClient.mockImplementation(shareServiceClientFactory);

    await listProfiles();
    const callsAfterFirst = shareServiceClientFactory.mock.calls.length;
    await listProfiles({ forceRefresh: true });
    const callsAfterForced = shareServiceClientFactory.mock.calls.length;

    expect(callsAfterForced).toBeGreaterThan(callsAfterFirst);
  });

  it('never caches a degraded (unavailable) response — the next call retries promptly', async () => {
    getFslogixShareServiceClient.mockReturnValueOnce(makeFailingRootShare(new Error('transient'))).mockReturnValue(makeFakeShare([{ name: `${REAL_SID}_jdoe`, files: [{ name: 'Profile_jdoe.vhdx' }] }]));
    getFslogixShareUsage.mockResolvedValue(undefined);

    const first = await listProfiles();
    expect(first.fileRest.status).toBe('unavailable');

    const second = await listProfiles();
    expect(second.fileRest.status).toBe('available');
  });

  it('logs FileREST degradation via the provided logger (peer review item 14)', async () => {
    getFslogixShareServiceClient.mockReturnValue(makeFailingRootShare(new Error('boom')));
    getFslogixShareUsage.mockResolvedValue(undefined);
    const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };

    await listProfiles({ logger });

    expect(logger.error).toHaveBeenCalled();
  });

  it('logs a per-file lock-check failure via the provided logger (peer review item 14)', async () => {
    getFslogixShareServiceClient.mockReturnValue(makeFakeShare([{ name: `${REAL_SID}_jdoe`, files: [{ name: 'Profile_jdoe.vhdx', listHandlesThrows: true }] }]));
    const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };

    const result = await listProfiles({ logger });

    expect(result.profiles[0].locked).toBe(false);
    expect(logger.warn).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// AM-51 — duplicate-container detection (listProfiles) + resolveDuplicateContainer
// ---------------------------------------------------------------------------

describe('listProfiles — duplicate-container detection (AM-51)', () => {
  it('a folder with a single active file is NOT flagged as a duplicate container', async () => {
    getFslogixShareServiceClient.mockReturnValue(makeFakeShare([{ name: `${REAL_SID}_jdoe`, files: [{ name: 'Profile_jdoe.vhdx' }] }]));

    const result = await listProfiles();

    expect(result.profiles).toHaveLength(1);
    expect(result.profiles[0]).toMatchObject({ activeSiblingCount: 1, duplicateContainer: false });
  });

  it('a folder with two active VHD(X) files (the motivating incident\'s .vhd/.VHDX fork) is flagged on BOTH rows with count 2 — a retired sibling in the same folder does not count', async () => {
    getFslogixShareServiceClient.mockReturnValue(
      makeFakeShare([
        {
          name: `${REAL_SID}_jdoe`,
          files: [{ name: 'Profile_dsmith.vhd' }, { name: 'Profile_dsmith.VHDX' }, { name: 'Profile_dsmith.vhdx.retired-20260101-000000' }],
        },
      ]),
    );

    const result = await listProfiles();

    const activeRows = result.profiles.filter((p) => p.folderName === `${REAL_SID}_jdoe`);
    expect(activeRows).toHaveLength(2);
    for (const row of activeRows) {
      expect(row.activeSiblingCount).toBe(2);
      expect(row.duplicateContainer).toBe(true);
    }
    // The retired sibling is listed separately and never counted toward activeSiblingCount.
    expect(result.retired).toHaveLength(1);
  });

  it('root-file rows always report activeSiblingCount 1, even when two unrelated loose files derive the same container name', async () => {
    getFslogixShareServiceClient.mockReturnValue(makeFakeShare([], [{ name: `${REAL_SID}_jdoe.vhdx` }, { name: `${REAL_SID}_jdoe.vhd` }]));

    const result = await listProfiles();

    expect(result.profiles).toHaveLength(2);
    for (const row of result.profiles) {
      expect(row.kind).toBe('root-file');
      expect(row.activeSiblingCount).toBe(1);
      expect(row.duplicateContainer).toBe(false);
    }
  });

  it('a third active file in the same folder reports count 3 on every row', async () => {
    getFslogixShareServiceClient.mockReturnValue(
      makeFakeShare([{ name: `${REAL_SID}_jdoe`, files: [{ name: 'Profile_jdoe.vhd' }, { name: 'Profile_jdoe.vhdx' }, { name: 'ODFC_jdoe.vhdx' }] }]),
    );

    const result = await listProfiles();

    expect(result.profiles).toHaveLength(3);
    for (const row of result.profiles) {
      expect(row.activeSiblingCount).toBe(3);
      expect(row.duplicateContainer).toBe(true);
    }
  });
});

describe('resolveDuplicateContainer — happy paths', () => {
  it('retire mode renames the chosen file to a retired name, leaving the sibling untouched', async () => {
    getFslogixShareServiceClient.mockReturnValue(
      makeFakeShare([{ name: `${REAL_SID}_jdoe`, files: [{ name: 'Profile_jdoe.vhd' }, { name: 'Profile_jdoe.vhdx' }] }]),
    );
    listUserSessions.mockResolvedValue([]);

    const result = await resolveDuplicateContainer(`${REAL_SID}_jdoe`, 'Profile_jdoe.vhd', 'retire');

    expect(result.mode).toBe('retire');
    expect(result.fileName).toBe('Profile_jdoe.vhd');
    expect(result.retiredFileName).toMatch(/^Profile_jdoe\.vhd\.retired-\d{8}-\d{6}$/);
    expect(result.activeSiblingCount).toBe(2);
  });

  it('delete mode permanently deletes the chosen file', async () => {
    const deleteFn = vi.fn(async () => undefined);
    getFslogixShareServiceClient.mockReturnValue(
      makeFakeShare([{ name: `${REAL_SID}_jdoe`, files: [{ name: 'Profile_jdoe.vhd', deleteFn }, { name: 'Profile_jdoe.vhdx' }] }]),
    );
    listUserSessions.mockResolvedValue([]);

    const result = await resolveDuplicateContainer(`${REAL_SID}_jdoe`, 'Profile_jdoe.vhd', 'delete');

    expect(result.mode).toBe('delete');
    expect(result.retiredFileName).toBeUndefined();
    expect(deleteFn).toHaveBeenCalledTimes(1);
  });

  it('matches an active session\'s UPN local part case-insensitively — proceeds when it does NOT match', async () => {
    getFslogixShareServiceClient.mockReturnValue(
      makeFakeShare([{ name: `${REAL_SID}_jdoe`, files: [{ name: 'Profile_jdoe.vhd' }, { name: 'Profile_jdoe.vhdx' }] }]),
    );
    listUserSessions.mockResolvedValue([{ userPrincipalName: 'someoneelse@contoso.example', sessionHostName: 'avd-con-1' }]);

    const result = await resolveDuplicateContainer(`${REAL_SID}_jdoe`, 'Profile_jdoe.vhd', 'retire');
    expect(result.mode).toBe('retire');
  });
});

describe('resolveDuplicateContainer — mutation-time re-verify refusals', () => {
  it('refuses with ProfileNotDuplicateError when the folder currently has only ONE active file (it may have already been resolved)', async () => {
    getFslogixShareServiceClient.mockReturnValue(makeFakeShare([{ name: `${REAL_SID}_jdoe`, files: [{ name: 'Profile_jdoe.vhdx' }] }]));

    await expect(resolveDuplicateContainer(`${REAL_SID}_jdoe`, 'Profile_jdoe.vhdx', 'retire')).rejects.toThrow(ProfileNotDuplicateError);
    expect(listUserSessions).not.toHaveBeenCalled();
  });

  it('refuses with ProfileNotDuplicateError when fileName does not name one of the folder\'s current active files', async () => {
    getFslogixShareServiceClient.mockReturnValue(
      makeFakeShare([{ name: `${REAL_SID}_jdoe`, files: [{ name: 'Profile_jdoe.vhd' }, { name: 'Profile_jdoe.vhdx' }] }]),
    );

    await expect(resolveDuplicateContainer(`${REAL_SID}_jdoe`, 'Nonexistent.vhdx', 'retire')).rejects.toThrow(ProfileNotDuplicateError);
  });

  it('refuses root-file targets the same as resetProfile/restoreProfile (shared assertMutableDirectory guard)', async () => {
    getFslogixShareServiceClient.mockReturnValue(makeFakeShare([], [{ name: 'Foo.vhdx' }]));

    await expect(resolveDuplicateContainer('Foo', 'Foo.vhdx', 'retire')).rejects.toThrow(RootFileMutationUnsupportedError);
  });
});

describe('resolveDuplicateContainer — active-session check (fail-closed)', () => {
  it('refuses with ProfileUserUnresolvedError when the folder name does not parse into a username', async () => {
    getFslogixShareServiceClient.mockReturnValue(makeFakeShare([{ name: 'randomfolder', files: [{ name: 'Profile_a.vhd' }, { name: 'Profile_a.vhdx' }] }]));

    await expect(resolveDuplicateContainer('randomfolder', 'Profile_a.vhd', 'retire')).rejects.toThrow(ProfileUserUnresolvedError);
    expect(listUserSessions).not.toHaveBeenCalled();
  });

  it('refuses with ProfileUserSessionActiveError, naming the session host, on an EXACT-case UPN local-part match', async () => {
    getFslogixShareServiceClient.mockReturnValue(
      makeFakeShare([{ name: `${REAL_SID}_jdoe`, files: [{ name: 'Profile_jdoe.vhd' }, { name: 'Profile_jdoe.vhdx' }] }]),
    );
    listUserSessions.mockResolvedValue([{ userPrincipalName: 'jdoe@contoso.example', sessionHostName: 'avd-con-7' }]);

    const error = await resolveDuplicateContainer(`${REAL_SID}_jdoe`, 'Profile_jdoe.vhd', 'retire').catch((e) => e);
    expect(error).toBeInstanceOf(ProfileUserSessionActiveError);
    expect(error.sessionHostName).toBe('avd-con-7');
  });

  it('refuses with ProfileUserSessionActiveError on a CASE-INSENSITIVE UPN local-part match', async () => {
    getFslogixShareServiceClient.mockReturnValue(
      makeFakeShare([{ name: `${REAL_SID}_jdoe`, files: [{ name: 'Profile_jdoe.vhd' }, { name: 'Profile_jdoe.vhdx' }] }]),
    );
    listUserSessions.mockResolvedValue([{ userPrincipalName: 'JDoe@contoso.example', sessionHostName: 'avd-con-9' }]);

    await expect(resolveDuplicateContainer(`${REAL_SID}_jdoe`, 'Profile_jdoe.vhd', 'retire')).rejects.toThrow(ProfileUserSessionActiveError);
  });

  it('refuses ANY session state, not just Active', async () => {
    getFslogixShareServiceClient.mockReturnValue(
      makeFakeShare([{ name: `${REAL_SID}_jdoe`, files: [{ name: 'Profile_jdoe.vhd' }, { name: 'Profile_jdoe.vhdx' }] }]),
    );
    listUserSessions.mockResolvedValue([{ userPrincipalName: 'jdoe@contoso.example', sessionHostName: 'avd-con-2', sessionState: 'Disconnected' }]);

    await expect(resolveDuplicateContainer(`${REAL_SID}_jdoe`, 'Profile_jdoe.vhd', 'retire')).rejects.toThrow(ProfileUserSessionActiveError);
  });

  it('refuses with ProfileSessionCheckFailedError (503-mapped) when listUserSessions itself fails — fail closed', async () => {
    getFslogixShareServiceClient.mockReturnValue(
      makeFakeShare([{ name: `${REAL_SID}_jdoe`, files: [{ name: 'Profile_jdoe.vhd' }, { name: 'Profile_jdoe.vhdx' }] }]),
    );
    listUserSessions.mockRejectedValue(new Error('ARM unreachable'));

    await expect(resolveDuplicateContainer(`${REAL_SID}_jdoe`, 'Profile_jdoe.vhd', 'retire')).rejects.toThrow(ProfileSessionCheckFailedError);
  });
});

describe('resolveDuplicateContainer — lock refusals (target file only)', () => {
  it('refuses with ProfileLockedError and names the holder when the TARGET file has an open handle', async () => {
    getFslogixShareServiceClient.mockReturnValue(
      makeFakeShare([{ name: `${REAL_SID}_jdoe`, files: [{ name: 'Profile_jdoe.vhd', handlePages: [[{ clientName: 'avd-con-0' }]] }, { name: 'Profile_jdoe.vhdx' }] }]),
    );
    listUserSessions.mockResolvedValue([]);

    const error = await resolveDuplicateContainer(`${REAL_SID}_jdoe`, 'Profile_jdoe.vhd', 'retire').catch((e) => e);
    expect(error).toBeInstanceOf(ProfileLockedError);
    expect(error.holder).toBe('avd-con-0');
  });

  it('does NOT check the lock state of the SIBLING file — only the target', async () => {
    getFslogixShareServiceClient.mockReturnValue(
      makeFakeShare([{ name: `${REAL_SID}_jdoe`, files: [{ name: 'Profile_jdoe.vhd' }, { name: 'Profile_jdoe.vhdx', handlePages: [[{ clientName: 'avd-con-0' }]] }] }]),
    );
    listUserSessions.mockResolvedValue([]);

    const result = await resolveDuplicateContainer(`${REAL_SID}_jdoe`, 'Profile_jdoe.vhd', 'retire');
    expect(result.mode).toBe('retire');
  });

  it('refuses with LockCheckFailedError when the handle check itself fails (fail closed)', async () => {
    getFslogixShareServiceClient.mockReturnValue(
      makeFakeShare([{ name: `${REAL_SID}_jdoe`, files: [{ name: 'Profile_jdoe.vhd', listHandlesThrows: true }, { name: 'Profile_jdoe.vhdx' }] }]),
    );
    listUserSessions.mockResolvedValue([]);

    await expect(resolveDuplicateContainer(`${REAL_SID}_jdoe`, 'Profile_jdoe.vhd', 'retire')).rejects.toThrow(LockCheckFailedError);
  });

  it('maps a rename-time 409 (TOCTOU) to ProfileLockedError, same as resetProfile', async () => {
    getFslogixShareServiceClient.mockReturnValue(
      makeFakeShare([
        {
          name: `${REAL_SID}_jdoe`,
          files: [
            {
              name: 'Profile_jdoe.vhd',
              renameFn: async () => {
                throw Object.assign(new Error('conflict'), { statusCode: 409 });
              },
            },
            { name: 'Profile_jdoe.vhdx' },
          ],
        },
      ]),
    );
    listUserSessions.mockResolvedValue([]);

    await expect(resolveDuplicateContainer(`${REAL_SID}_jdoe`, 'Profile_jdoe.vhd', 'retire')).rejects.toThrow(ProfileLockedError);
  });
});
