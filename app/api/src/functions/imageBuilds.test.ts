import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HttpRequest, InvocationContext } from '@azure/functions';
import type { ImageBuildEntity } from '../services/imageBuildService';

const resolvePlanContext = vi.fn();
const submitBuildVmCreation = vi.fn();
const submitPreSysprepSnapshot = vi.fn();
const submitCleanupDeletes = vi.fn();
const assertVersionAvailable = vi.fn();
const assertSnapshotNameAvailable = vi.fn();
const getSnapshotStatus = vi.fn();
const submitSnapshotDelete = vi.fn();
vi.mock('../services/imageBuildOrchestrator', async () => {
  const actual = await vi.importActual<typeof import('../services/imageBuildOrchestrator')>('../services/imageBuildOrchestrator');
  return {
    // PartialBuildVmCreationError is the REAL class — imageBuilds.ts does
    // `error instanceof PartialBuildVmCreationError`, which only works
    // against the actual constructor, not a mock stand-in.
    PartialBuildVmCreationError: actual.PartialBuildVmCreationError,
    resolvePlanContext: (...args: unknown[]) => resolvePlanContext(...args),
    submitBuildVmCreation: (...args: unknown[]) => submitBuildVmCreation(...args),
    submitPreSysprepSnapshot: (...args: unknown[]) => submitPreSysprepSnapshot(...args),
    submitCleanupDeletes: (...args: unknown[]) => submitCleanupDeletes(...args),
    assertVersionAvailable: (...args: unknown[]) => assertVersionAvailable(...args),
    assertSnapshotNameAvailable: (...args: unknown[]) => assertSnapshotNameAvailable(...args),
    getSnapshotStatus: (...args: unknown[]) => getSnapshotStatus(...args),
    submitSnapshotDelete: (...args: unknown[]) => submitSnapshotDelete(...args),
  };
});

const checkRolloutDoneForVersion = vi.fn();
vi.mock('../lib/imageBuildSnapshotGate', () => ({
  checkRolloutDoneForVersion: (...args: unknown[]) => checkRolloutDoneForVersion(...args),
}));

const createImageBuild = vi.fn();
const getImageBuild = vi.fn();
const replaceImageBuild = vi.fn();
const listImageBuilds = vi.fn();
const listInFlightImageBuilds = vi.fn();
const isImageBuildStoreRequiredButMissing = vi.fn().mockReturnValue(false);
vi.mock('../services/imageBuildService', async () => {
  const actual = await vi.importActual<typeof import('../services/imageBuildService')>('../services/imageBuildService');
  return {
    ...actual,
    createImageBuild: (...args: unknown[]) => createImageBuild(...args),
    getImageBuild: (...args: unknown[]) => getImageBuild(...args),
    replaceImageBuild: (...args: unknown[]) => replaceImageBuild(...args),
    listImageBuilds: (...args: unknown[]) => listImageBuilds(...args),
    listInFlightImageBuilds: (...args: unknown[]) => listInFlightImageBuilds(...args),
    isImageBuildStoreRequiredButMissing: (...args: unknown[]) => isImageBuildStoreRequiredButMissing(...args),
  };
});

const getCurrentImageVersion = vi.fn();
vi.mock('../services/imagesService', () => ({
  getCurrentImageVersion: (...args: unknown[]) => getCurrentImageVersion(...args),
}));

const writeAuditEntry = vi.fn().mockResolvedValue(undefined);
const isAuditRequiredButMissing = vi.fn().mockReturnValue(false);
vi.mock('../lib/auditLog', () => ({
  writeAuditEntry: (...args: unknown[]) => writeAuditEntry(...args),
  isAuditRequiredButMissing: (...args: unknown[]) => isAuditRequiredButMissing(...args),
}));

const { imageBuildsStart, imageBuildsList, imageBuildsGet, imageBuildsChecklist, imageBuildsAdvance, imageBuildsCancel, imageBuildsSnapshotDelete } = await import('./imageBuilds');

interface FakeContext extends InvocationContext {
  errors: unknown[];
}

function makeContext(): FakeContext {
  const errors: unknown[] = [];
  return { warn: () => {}, error: (...a: unknown[]) => errors.push(a), log: () => {}, errors } as unknown as FakeContext;
}

function encodePrincipal(principal: unknown): string {
  return Buffer.from(JSON.stringify(principal), 'utf-8').toString('base64');
}
function adminHeader() {
  return encodePrincipal({ identityProvider: 'aad', userId: 'entra-admin-1', userDetails: 'admin@example.com', userRoles: ['admin'] });
}
function operatorHeader() {
  return encodePrincipal({ identityProvider: 'aad', userId: 'entra-op-1', userDetails: 'operator@example.com', userRoles: ['operator'] });
}

function makeRequest(options: { headers?: Record<string, string>; body?: unknown; jsonThrows?: boolean; method?: string; params?: Record<string, string>; query?: Record<string, string> }): HttpRequest {
  const { headers = { 'x-ms-client-principal': adminHeader() }, body = {}, jsonThrows = false, method = 'POST', params = {}, query = {} } = options;
  const lowerHeaders = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  const queryMap = new Map(Object.entries(query));
  return {
    method,
    url: 'https://func-example.azurewebsites.net/api/v1/images/builds',
    headers: { get: (name: string) => lowerHeaders.get(name.toLowerCase()) ?? null },
    params,
    query: { get: (name: string) => queryMap.get(name) ?? null },
    json: async () => {
      if (jsonThrows) throw new Error('bad json');
      return body;
    },
  } as unknown as HttpRequest;
}

/** No password field at all — this app no longer accepts one from the caller (Opus review MAJOR 5). */
const VALID_START_BODY = { version: '2.1.0', adminUsername: 'ca.builder' };

const PLAN_CONTEXT = {
  subscriptionId: 'sub-id',
  resourceGroup: 'RG-AVD-Images',
  location: 'eastus',
  galleryName: 'ACG_AVD_CONTOSO',
  imageDefinitionName: 'WIN11-ENT-MS-M365',
  subnetId: '/subscriptions/sub/resourceGroups/RG-AVD-Network/providers/Microsoft.Network/virtualNetworks/VNET/subnets/SNET-IMAGEBUILD',
  vmSize: 'Standard_D4ads_v7',
};

function entity(overrides: Partial<ImageBuildEntity> = {}): ImageBuildEntity & { etag: string } {
  return {
    partitionKey: 'build',
    rowKey: 'build-1',
    buildId: 'build-1',
    version: '2.1.0',
    state: 'planned',
    createdAt: '2026-08-16T00:00:00.000Z',
    updatedAt: '2026-08-16T00:00:00.000Z',
    createdBy: 'admin@example.com',
    createdById: 'entra-admin-1',
    vmName: 'VM-IMG-AAAAAAAA',
    nicName: 'NIC-VM-IMG-AAAAAAAA',
    diskName: 'OSDISK-VM-IMG-AAAAAAAA',
    snapshotName: 'SNAP-WIN11-PRE-SYSPREP-2.1.0',
    checklistJson: '{}',
    stepsJson: '[]',
    planParamsJson: '{"version":"2.1.0","adminUsername":"ca.builder"}',
    planContextJson: JSON.stringify(PLAN_CONTEXT),
    correlationId: 'corr-1',
    etag: 'W/"etag-1"',
    ...overrides,
  };
}

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  process.env.SUBSCRIPTION_ID = 'sub-id';
  process.env.RG_HOSTPOOLS = 'RG-AVD-HostPools';
  process.env.HOSTPOOL_NAME = 'HP-CONTOSO-PROD';
  delete process.env.REQUIRE_BACKEND_SECRET;
  delete process.env.WEBSITE_SITE_NAME;
  resolvePlanContext.mockReset().mockReturnValue(PLAN_CONTEXT);
  submitBuildVmCreation.mockReset();
  submitPreSysprepSnapshot.mockReset();
  submitCleanupDeletes.mockReset();
  assertVersionAvailable.mockReset().mockResolvedValue({ ok: true });
  assertSnapshotNameAvailable.mockReset().mockResolvedValue({ ok: true });
  getSnapshotStatus.mockReset().mockResolvedValue('present');
  submitSnapshotDelete.mockReset().mockResolvedValue(undefined);
  checkRolloutDoneForVersion.mockReset().mockResolvedValue({ ok: true });
  createImageBuild.mockReset().mockResolvedValue(undefined);
  getImageBuild.mockReset();
  replaceImageBuild.mockReset().mockResolvedValue(undefined);
  listImageBuilds.mockReset().mockResolvedValue([]);
  listInFlightImageBuilds.mockReset().mockResolvedValue([]);
  isImageBuildStoreRequiredButMissing.mockReset().mockReturnValue(false);
  getCurrentImageVersion.mockReset().mockResolvedValue({ id: 'v-id', name: '2.0.0', imageDefinitionName: 'WIN11-ENT-MS-M365', excludeFromLatest: false });
  writeAuditEntry.mockReset().mockResolvedValue(undefined);
  isAuditRequiredButMissing.mockReset().mockReturnValue(false);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('RBAC — every route is admin-only', () => {
  const nonAdminHeader = { 'x-ms-client-principal': operatorHeader() };

  it('POST /v1/images/builds rejects an operator with 403', async () => {
    const res = await imageBuildsStart(makeRequest({ headers: nonAdminHeader, body: VALID_START_BODY }), makeContext());
    expect(res.status).toBe(403);
  });

  it('GET /v1/images/builds rejects an operator with 403', async () => {
    const res = await imageBuildsList(makeRequest({ headers: nonAdminHeader, method: 'GET' }), makeContext());
    expect(res.status).toBe(403);
  });

  it('GET /v1/images/builds/{buildId} rejects an operator with 403', async () => {
    const res = await imageBuildsGet(makeRequest({ headers: nonAdminHeader, method: 'GET', params: { buildId: 'build-1' } }), makeContext());
    expect(res.status).toBe(403);
  });

  it('PATCH .../checklist rejects an operator with 403', async () => {
    const res = await imageBuildsChecklist(makeRequest({ headers: nonAdminHeader, method: 'PATCH', params: { buildId: 'build-1' }, body: { itemId: 'windows_updates', checked: true } }), makeContext());
    expect(res.status).toBe(403);
  });

  it('POST .../advance rejects an operator with 403', async () => {
    const res = await imageBuildsAdvance(makeRequest({ headers: nonAdminHeader, params: { buildId: 'build-1' } }), makeContext());
    expect(res.status).toBe(403);
  });

  it('POST .../cancel rejects an operator with 403', async () => {
    const res = await imageBuildsCancel(makeRequest({ headers: nonAdminHeader, params: { buildId: 'build-1' } }), makeContext());
    expect(res.status).toBe(403);
  });

  it('DELETE .../snapshot rejects an operator with 403', async () => {
    const res = await imageBuildsSnapshotDelete(makeRequest({ headers: nonAdminHeader, method: 'DELETE', params: { buildId: 'build-1' }, body: { reason: 'cleanup' } }), makeContext());
    expect(res.status).toBe(403);
  });
});

describe('POST /v1/images/builds — validation', () => {
  it('400 on a malformed version', async () => {
    const res = await imageBuildsStart(makeRequest({ body: { ...VALID_START_BODY, version: 'v2' } }), makeContext());
    expect(res.status).toBe(400);
  });

  it('400 on a reserved admin username', async () => {
    const res = await imageBuildsStart(makeRequest({ body: { ...VALID_START_BODY, adminUsername: 'administrator' } }), makeContext());
    expect(res.status).toBe(400);
  });

  it('400 on invalid JSON body', async () => {
    const res = await imageBuildsStart(makeRequest({ jsonThrows: true }), makeContext());
    expect(res.status).toBe(400);
  });

  it('ignores a caller-supplied adminPassword field entirely rather than accepting/using it (Opus review MAJOR 5)', async () => {
    submitBuildVmCreation.mockResolvedValue([]);
    getImageBuild.mockImplementation(async () => entity({ state: 'vm_creating' }));

    await imageBuildsStart(makeRequest({ body: { ...VALID_START_BODY, adminPassword: 'CallerSuppliedPassw0rd!' } }), makeContext());

    const [, passwordArg] = submitBuildVmCreation.mock.calls[0] as [unknown, string];
    expect(passwordArg).not.toBe('CallerSuppliedPassw0rd!');
  });
});

describe('POST /v1/images/builds?dryRun=true — ZERO mutations (the acceptance criterion)', () => {
  it('returns the plan and touches NEITHER the Table nor any ARM submission function', async () => {
    const res = await imageBuildsStart(makeRequest({ body: VALID_START_BODY, query: { dryRun: 'true' } }), makeContext());

    expect(res.status).toBe(200);
    const body = res.jsonBody as { dryRun: boolean; build?: unknown; plan: { steps: unknown[] }; generatedAdminPassword?: string };
    expect(body.dryRun).toBe(true);
    expect(body.build).toBeUndefined();
    expect(body.generatedAdminPassword).toBeUndefined();
    expect(body.plan.steps.length).toBeGreaterThan(0);

    expect(createImageBuild).not.toHaveBeenCalled();
    expect(submitBuildVmCreation).not.toHaveBeenCalled();
    expect(replaceImageBuild).not.toHaveBeenCalled();
    expect(writeAuditEntry).not.toHaveBeenCalled();
    expect(listInFlightImageBuilds).not.toHaveBeenCalled();
    expect(getCurrentImageVersion).not.toHaveBeenCalled();
  });

  it('a dry-run still works even when the audit/build store is unconfigured (the fail-closed check is skipped for dry runs)', async () => {
    isAuditRequiredButMissing.mockReturnValue(true);
    isImageBuildStoreRequiredButMissing.mockReturnValue(true);
    const res = await imageBuildsStart(makeRequest({ body: VALID_START_BODY, query: { dryRun: 'true' } }), makeContext());
    expect(res.status).toBe(200);
  });
});

describe('POST /v1/images/builds — resolvePlanContext() throws (AM-15/M7 sweep — CWE-532)', () => {
  it('returns a sanitized "not configured" message and logs the raw error server-side, without echoing it to the caller', async () => {
    const context = makeContext();
    resolvePlanContext.mockImplementation(() => {
      throw new Error('IMAGE_BUILD_SUBNET_ID is not configured — cannot start an image build.');
    });
    const res = await imageBuildsStart(makeRequest({ body: VALID_START_BODY }), context);
    expect(res.status).toBe(500);
    expect(res.jsonBody).toMatchObject({ code: 'image_build_not_configured' });
    const body = res.jsonBody as { message: string };
    expect(body.message).toContain('IMAGE_BUILD_SUBNET_ID');
    expect(body.message).not.toContain('cannot start an image build');
    expect(context.errors.length).toBeGreaterThan(0);
  });

  it('falls back to a generic message for an unrecognized resolvePlanContext() error', async () => {
    resolvePlanContext.mockImplementation(() => {
      throw new Error('some other config problem');
    });
    const res = await imageBuildsStart(makeRequest({ body: VALID_START_BODY }), makeContext());
    expect(res.status).toBe(500);
    const body = res.jsonBody as { message: string };
    expect(body.message).not.toContain('some other config problem');
    expect(body.message).toContain('Could not resolve');
  });
});

describe('POST /v1/images/builds — real start', () => {
  it('fails closed (500) when audit/build storage is required but missing', async () => {
    process.env.WEBSITE_SITE_NAME = 'func-example-prod';
    isImageBuildStoreRequiredButMissing.mockReturnValue(true);
    const res = await imageBuildsStart(makeRequest({ body: VALID_START_BODY }), makeContext());
    expect(res.status).toBe(500);
    expect(createImageBuild).not.toHaveBeenCalled();
  });

  it('409 when another build is already in flight (Opus review MAJOR 11)', async () => {
    listInFlightImageBuilds.mockResolvedValue([entity({ buildId: 'other-build', state: 'sysprep_running' })]);
    const res = await imageBuildsStart(makeRequest({ body: VALID_START_BODY }), makeContext());
    expect(res.status).toBe(409);
    const body = res.jsonBody as { code: string };
    expect(body.code).toBe('image_build_already_in_flight');
    expect(createImageBuild).not.toHaveBeenCalled();
  });

  it('409 when the target version is not strictly greater than the currently-published version (Opus review MAJOR 6)', async () => {
    getCurrentImageVersion.mockResolvedValue({ id: 'v-id', name: '2.1.0', imageDefinitionName: 'WIN11-ENT-MS-M365', excludeFromLatest: false });
    const res = await imageBuildsStart(makeRequest({ body: { ...VALID_START_BODY, version: '2.1.0' } }), makeContext());
    expect(res.status).toBe(409);
    const body = res.jsonBody as { code: string };
    expect(body.code).toBe('image_build_version_not_greater');
    expect(createImageBuild).not.toHaveBeenCalled();
  });

  it('allows any version when no image version has ever been published', async () => {
    getCurrentImageVersion.mockResolvedValue(null);
    submitBuildVmCreation.mockResolvedValue([]);
    getImageBuild.mockImplementation(async () => entity({ state: 'vm_creating' }));
    const res = await imageBuildsStart(makeRequest({ body: VALID_START_BODY }), makeContext());
    expect(res.status).toBe(201);
  });

  it('409 when the target version already exists as a gallery image version (Opus review MAJOR 6)', async () => {
    assertVersionAvailable.mockResolvedValue({ ok: false, reason: 'already exists' });
    const res = await imageBuildsStart(makeRequest({ body: VALID_START_BODY }), makeContext());
    expect(res.status).toBe(409);
    const body = res.jsonBody as { code: string };
    expect(body.code).toBe('image_build_version_exists');
    expect(createImageBuild).not.toHaveBeenCalled();
  });

  it('creates the row (with a frozen planContextJson), submits the VM creation with a server-generated password, transitions planned -> vm_creating, returns generatedAdminPassword exactly once, and audits with buildId/from/to', async () => {
    submitBuildVmCreation.mockResolvedValue([{ stepId: 'create_build_nic', status: 'succeeded' }]);
    getImageBuild.mockImplementation(async () => entity({ state: 'vm_creating' }));

    const res = await imageBuildsStart(makeRequest({ body: VALID_START_BODY }), makeContext());

    expect(res.status).toBe(201);
    expect(createImageBuild).toHaveBeenCalledTimes(1);
    const createdEntity = createImageBuild.mock.calls[0][0] as ImageBuildEntity;
    expect(JSON.parse(createdEntity.planContextJson)).toEqual(PLAN_CONTEXT);

    const [, generatedPassword] = submitBuildVmCreation.mock.calls[0] as [unknown, string];
    expect(generatedPassword.length).toBeGreaterThanOrEqual(12);
    expect(replaceImageBuild).toHaveBeenCalledWith(expect.objectContaining({ state: 'vm_creating' }), expect.any(String));

    const body = res.jsonBody as { build: { state: string }; dryRun: boolean; generatedAdminPassword: string };
    expect(body.dryRun).toBe(false);
    expect(body.build.state).toBe('vm_creating');
    expect(body.generatedAdminPassword).toBe(generatedPassword);

    expect(writeAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'image.build.start', outcome: 'success', parameters: expect.objectContaining({ from: 'planned', to: 'vm_creating' }) }),
      expect.anything(),
    );
  });

  it('never includes the generated password in the audit entry', async () => {
    submitBuildVmCreation.mockResolvedValue([]);
    getImageBuild.mockImplementation(async () => entity({ state: 'vm_creating' }));

    const res = await imageBuildsStart(makeRequest({ body: VALID_START_BODY }), makeContext());
    const body = res.jsonBody as { generatedAdminPassword: string };

    const auditCall = writeAuditEntry.mock.calls.find((c) => (c[0] as { action: string }).action === 'image.build.start');
    expect(JSON.stringify(auditCall)).not.toContain(body.generatedAdminPassword);
  });

  it('on ARM submission failure: does NOT force the row to failed (the truth is unknown — reconcilePlanned resolves it), persists partial progress, and returns 502 naming the build for status tracking', async () => {
    const { PartialBuildVmCreationError } = await import('../services/imageBuildOrchestrator');
    submitBuildVmCreation.mockRejectedValue(new PartialBuildVmCreationError('NIC created, VM submit failed', [{ stepId: 'create_build_nic', status: 'succeeded' }], new Error('boom')));
    getImageBuild.mockImplementation(async () => entity({ state: 'planned' }));

    const res = await imageBuildsStart(makeRequest({ body: VALID_START_BODY }), makeContext());

    expect(res.status).toBe(502);
    const body = res.jsonBody as { details: { buildId: string } };
    expect(body.details.buildId).toBeTruthy();
    expect(replaceImageBuild).toHaveBeenCalledWith(expect.objectContaining({ errorMessage: expect.stringContaining('NIC created') }), expect.any(String));
    // state must NOT be force-set to 'failed' — the call omits `state` entirely, leaving whatever getImageBuild returned (planned).
    const replaceCallArg = replaceImageBuild.mock.calls[0][0] as { state: string };
    expect(replaceCallArg.state).toBe('planned');
    expect(writeAuditEntry).toHaveBeenCalledWith(expect.objectContaining({ action: 'image.build.start', outcome: 'failure' }), expect.anything());
  });
});

describe('PATCH /v1/images/builds/{buildId}/checklist', () => {
  it('404 when the build does not exist', async () => {
    getImageBuild.mockResolvedValue(null);
    const res = await imageBuildsChecklist(makeRequest({ method: 'PATCH', params: { buildId: 'missing' }, body: { itemId: 'windows_updates', checked: true } }), makeContext());
    expect(res.status).toBe(404);
  });

  it('409 when the build is not at the checklist gate', async () => {
    getImageBuild.mockResolvedValue(entity({ state: 'vm_creating' }));
    const res = await imageBuildsChecklist(makeRequest({ method: 'PATCH', params: { buildId: 'build-1' }, body: { itemId: 'windows_updates', checked: true } }), makeContext());
    expect(res.status).toBe(409);
  });

  it('400 on an unknown itemId', async () => {
    getImageBuild.mockResolvedValue(entity({ state: 'checklist_gate' }));
    const res = await imageBuildsChecklist(makeRequest({ method: 'PATCH', params: { buildId: 'build-1' }, body: { itemId: 'not_a_real_item', checked: true } }), makeContext());
    expect(res.status).toBe(400);
  });

  it('ticks the item, persists it, reports allRequiredChecked, and audits the toggle', async () => {
    getImageBuild.mockResolvedValue(entity({ state: 'checklist_gate', checklistJson: '{}' }));
    const res = await imageBuildsChecklist(makeRequest({ method: 'PATCH', params: { buildId: 'build-1' }, body: { itemId: 'windows_updates', checked: true } }), makeContext());

    expect(res.status).toBe(200);
    const body = res.jsonBody as { checklist: Record<string, boolean>; allRequiredChecked: boolean };
    expect(body.checklist.windows_updates).toBe(true);
    expect(body.allRequiredChecked).toBe(false); // only one of many items ticked
    expect(writeAuditEntry).toHaveBeenCalledWith(expect.objectContaining({ action: 'image.build.checklist_update', parameters: { itemId: 'windows_updates', checked: true } }), expect.anything());
  });
});

describe('POST /v1/images/builds/{buildId}/advance', () => {
  it('404 when the build does not exist', async () => {
    getImageBuild.mockResolvedValue(null);
    const res = await imageBuildsAdvance(makeRequest({ params: { buildId: 'missing' } }), makeContext());
    expect(res.status).toBe(404);
  });

  it('409 when the build is not at an operator gate', async () => {
    getImageBuild.mockResolvedValue(entity({ state: 'sysprep_running' }));
    const res = await imageBuildsAdvance(makeRequest({ params: { buildId: 'build-1' } }), makeContext());
    expect(res.status).toBe(409);
  });

  it('409 with the list of missing items when the checklist is incomplete', async () => {
    getImageBuild.mockResolvedValue(entity({ state: 'checklist_gate', checklistJson: '{}' }));
    const res = await imageBuildsAdvance(makeRequest({ params: { buildId: 'build-1' } }), makeContext());
    expect(res.status).toBe(409);
    const body = res.jsonBody as { code: string; details: { missing: string[] } };
    expect(body.code).toBe('image_build_checklist_incomplete');
    expect(body.details.missing.length).toBeGreaterThan(0);
    expect(submitPreSysprepSnapshot).not.toHaveBeenCalled();
  });

  it('checklist_gate -> snapshotting: pre-checks the snapshot name, submits the pre-Sysprep snapshot once every item is ticked, and audits from/to', async () => {
    const { IMAGE_BUILD_CHECKLIST } = await import('@avdmgr/shared');
    const fullChecklist: Record<string, boolean> = {};
    for (const item of IMAGE_BUILD_CHECKLIST) fullChecklist[item.id] = true;
    getImageBuild.mockResolvedValue(entity({ state: 'checklist_gate', checklistJson: JSON.stringify(fullChecklist) }));
    submitPreSysprepSnapshot.mockResolvedValue([{ stepId: 'create_presysprep_snapshot', status: 'in_progress' }]);

    const res = await imageBuildsAdvance(makeRequest({ params: { buildId: 'build-1' } }), makeContext());

    expect(res.status).toBe(200);
    expect(assertSnapshotNameAvailable).toHaveBeenCalledWith('SNAP-WIN11-PRE-SYSPREP-2.1.0', PLAN_CONTEXT);
    expect(submitPreSysprepSnapshot).toHaveBeenCalledTimes(1);
    expect(replaceImageBuild).toHaveBeenCalledWith(expect.objectContaining({ state: 'snapshotting' }), expect.any(String));
    expect(writeAuditEntry).toHaveBeenCalledWith(expect.objectContaining({ action: 'image.build.advance', parameters: expect.objectContaining({ from: 'checklist_gate', to: 'snapshotting' }), outcome: 'success' }), expect.anything());
  });

  it('checklist_gate -> snapshotting: 409 when a snapshot with that name already exists (Opus review MINOR 13d)', async () => {
    const { IMAGE_BUILD_CHECKLIST } = await import('@avdmgr/shared');
    const fullChecklist: Record<string, boolean> = {};
    for (const item of IMAGE_BUILD_CHECKLIST) fullChecklist[item.id] = true;
    getImageBuild.mockResolvedValue(entity({ state: 'checklist_gate', checklistJson: JSON.stringify(fullChecklist) }));
    assertSnapshotNameAvailable.mockResolvedValue({ ok: false, reason: 'a snapshot with that name already exists' });

    const res = await imageBuildsAdvance(makeRequest({ params: { buildId: 'build-1' } }), makeContext());

    expect(res.status).toBe(409);
    const body = res.jsonBody as { code: string };
    expect(body.code).toBe('image_build_snapshot_exists');
    expect(submitPreSysprepSnapshot).not.toHaveBeenCalled();
  });

  it('test_host_step -> cleanup: submits the cleanup deletes using the ENTITY directly (no plan regeneration)', async () => {
    getImageBuild.mockResolvedValue(entity({ state: 'test_host_step' }));
    submitCleanupDeletes.mockResolvedValue([{ stepId: 'delete_build_vm', status: 'in_progress' }]);

    const res = await imageBuildsAdvance(makeRequest({ params: { buildId: 'build-1' } }), makeContext());

    expect(res.status).toBe(200);
    expect(submitCleanupDeletes).toHaveBeenCalledWith(expect.objectContaining({ vmName: 'VM-IMG-AAAAAAAA', nicName: 'NIC-VM-IMG-AAAAAAAA', diskName: 'OSDISK-VM-IMG-AAAAAAAA' }));
    expect(replaceImageBuild).toHaveBeenCalledWith(expect.objectContaining({ state: 'cleanup' }), expect.any(String));
  });
});

describe('POST /v1/images/builds/{buildId}/cancel', () => {
  it('404 when the build does not exist', async () => {
    getImageBuild.mockResolvedValue(null);
    const res = await imageBuildsCancel(makeRequest({ params: { buildId: 'missing' } }), makeContext());
    expect(res.status).toBe(404);
  });

  it('409 when the build is already terminal (done/failed/cancelled)', async () => {
    getImageBuild.mockResolvedValue(entity({ state: 'done' }));
    const res = await imageBuildsCancel(makeRequest({ params: { buildId: 'build-1' } }), makeContext());
    expect(res.status).toBe(409);
  });

  it('409 when cleanup has already started (deletes are already firing)', async () => {
    getImageBuild.mockResolvedValue(entity({ state: 'cleanup' }));
    const res = await imageBuildsCancel(makeRequest({ params: { buildId: 'build-1' } }), makeContext());
    expect(res.status).toBe(409);
  });

  it('cancelling while still planned returns empty cleanupGuidance (nothing was ever created)', async () => {
    getImageBuild.mockResolvedValue(entity({ state: 'planned' }));
    const res = await imageBuildsCancel(makeRequest({ params: { buildId: 'build-1' }, body: { reason: 'operator changed their mind' } }), makeContext());
    expect(res.status).toBe(200);
    const body = res.jsonBody as { cleanupGuidance: string };
    expect(body.cleanupGuidance).toBe('');
  });

  it('cancelling mid-build returns honest cleanup guidance naming the leftover resources, and audits from/to', async () => {
    getImageBuild.mockResolvedValue(entity({ state: 'vm_creating' }));
    const res = await imageBuildsCancel(makeRequest({ params: { buildId: 'build-1' } }), makeContext());
    expect(res.status).toBe(200);
    const body = res.jsonBody as { cleanupGuidance: string };
    expect(body.cleanupGuidance).toContain('VM-IMG-AAAAAAAA');
    expect(replaceImageBuild).toHaveBeenCalledWith(expect.objectContaining({ state: 'cancelled' }), expect.any(String));
    expect(writeAuditEntry).toHaveBeenCalledWith(expect.objectContaining({ action: 'image.build.cancel', parameters: expect.objectContaining({ from: 'vm_creating', to: 'cancelled' }), outcome: 'success' }), expect.anything());
  });
});

describe('GET /v1/images/builds — list', () => {
  it('returns build summaries', async () => {
    listImageBuilds.mockResolvedValue([entity({ buildId: 'a', rowKey: 'a' }), entity({ buildId: 'b', rowKey: 'b' })]);
    const res = await imageBuildsList(makeRequest({ method: 'GET' }), makeContext());
    expect(res.status).toBe(200);
    const body = res.jsonBody as { builds: Array<{ buildId: string }> };
    expect(body.builds.map((b) => b.buildId)).toEqual(['a', 'b']);
  });
});

describe('GET /v1/images/builds/{buildId} — AM-53 snapshotStatus/snapshotDeletable projection', () => {
  it('omits snapshot fields entirely for a build not yet done', async () => {
    getImageBuild.mockResolvedValue(entity({ state: 'checklist_gate' }));
    const res = await imageBuildsGet(makeRequest({ method: 'GET', params: { buildId: 'build-1' } }), makeContext());
    expect(res.status).toBe(200);
    const body = res.jsonBody as Record<string, unknown>;
    expect(body.snapshotStatus).toBeUndefined();
    expect(body.snapshotDeletable).toBeUndefined();
    expect(getSnapshotStatus).not.toHaveBeenCalled();
  });

  it('done + present + rollout done -> deletable:true', async () => {
    getImageBuild.mockResolvedValue(entity({ state: 'done' }));
    getSnapshotStatus.mockResolvedValue('present');
    checkRolloutDoneForVersion.mockResolvedValue({ ok: true });
    const res = await imageBuildsGet(makeRequest({ method: 'GET', params: { buildId: 'build-1' } }), makeContext());
    const body = res.jsonBody as { snapshotStatus: string; snapshotDeletable: boolean; snapshotDeleteBlockedReason?: string };
    expect(body.snapshotStatus).toBe('present');
    expect(body.snapshotDeletable).toBe(true);
    expect(body.snapshotDeleteBlockedReason).toBeUndefined();
  });

  it('done + present + rollout NOT done -> deletable:false with the gate reason', async () => {
    getImageBuild.mockResolvedValue(entity({ state: 'done' }));
    getSnapshotStatus.mockResolvedValue('present');
    checkRolloutDoneForVersion.mockResolvedValue({ ok: false, reason: 'no completed rollout found' });
    const res = await imageBuildsGet(makeRequest({ method: 'GET', params: { buildId: 'build-1' } }), makeContext());
    const body = res.jsonBody as { snapshotDeletable: boolean; snapshotDeleteBlockedReason?: string };
    expect(body.snapshotDeletable).toBe(false);
    expect(body.snapshotDeleteBlockedReason).toBe('no completed rollout found');
  });

  it('done + deleted -> deletable:false, never calls the rollout gate at all', async () => {
    getImageBuild.mockResolvedValue(entity({ state: 'done' }));
    getSnapshotStatus.mockResolvedValue('deleted');
    const res = await imageBuildsGet(makeRequest({ method: 'GET', params: { buildId: 'build-1' } }), makeContext());
    const body = res.jsonBody as { snapshotStatus: string; snapshotDeletable: boolean };
    expect(body.snapshotStatus).toBe('deleted');
    expect(body.snapshotDeletable).toBe(false);
    expect(checkRolloutDoneForVersion).not.toHaveBeenCalled();
  });

  it('done + unknown status -> deletable:false, never calls the rollout gate', async () => {
    getImageBuild.mockResolvedValue(entity({ state: 'done' }));
    getSnapshotStatus.mockResolvedValue('unknown');
    const res = await imageBuildsGet(makeRequest({ method: 'GET', params: { buildId: 'build-1' } }), makeContext());
    const body = res.jsonBody as { snapshotStatus: string; snapshotDeletable: boolean };
    expect(body.snapshotStatus).toBe('unknown');
    expect(body.snapshotDeletable).toBe(false);
    expect(checkRolloutDoneForVersion).not.toHaveBeenCalled();
  });

  it('a rollout-gate check failure degrades ONLY the snapshot fields, not the whole detail read', async () => {
    getImageBuild.mockResolvedValue(entity({ state: 'done' }));
    getSnapshotStatus.mockResolvedValue('present');
    checkRolloutDoneForVersion.mockRejectedValue(new Error('table down'));
    const res = await imageBuildsGet(makeRequest({ method: 'GET', params: { buildId: 'build-1' } }), makeContext());
    expect(res.status).toBe(200);
    const body = res.jsonBody as { snapshotDeletable: boolean; snapshotDeleteBlockedReason?: string };
    expect(body.snapshotDeletable).toBe(false);
    expect(body.snapshotDeleteBlockedReason).toBeTruthy();
  });
});

describe('DELETE /v1/images/builds/{buildId}/snapshot — AM-53 gates + audit ordering', () => {
  function req(overrides: { params?: Record<string, string>; body?: unknown } = {}) {
    return makeRequest({ method: 'DELETE', params: { buildId: 'build-1', ...overrides.params }, body: overrides.body ?? { reason: 'rollout complete, no longer needed' } });
  }

  it('400 when reason is missing', async () => {
    getImageBuild.mockResolvedValue(entity({ state: 'done' }));
    const res = await imageBuildsSnapshotDelete(req({ body: {} }), makeContext());
    expect(res.status).toBe(400);
    expect(submitSnapshotDelete).not.toHaveBeenCalled();
  });

  it('404 when the build does not exist', async () => {
    getImageBuild.mockResolvedValue(null);
    const res = await imageBuildsSnapshotDelete(req(), makeContext());
    expect(res.status).toBe(404);
  });

  it('409 image_build_not_done when the build has not reached done', async () => {
    getImageBuild.mockResolvedValue(entity({ state: 'test_host_step' }));
    const res = await imageBuildsSnapshotDelete(req(), makeContext());
    expect(res.status).toBe(409);
    const body = res.jsonBody as { code: string };
    expect(body.code).toBe('image_build_not_done');
    expect(checkRolloutDoneForVersion).not.toHaveBeenCalled();
    expect(submitSnapshotDelete).not.toHaveBeenCalled();
  });

  it('409 snapshot_rollout_not_complete when the rollout-done gate fails, with an honest cap-aware message', async () => {
    getImageBuild.mockResolvedValue(entity({ state: 'done' }));
    checkRolloutDoneForVersion.mockResolvedValue({ ok: false, reason: 'no completed rollout found for this version in the most recent plans' });
    const res = await imageBuildsSnapshotDelete(req(), makeContext());
    expect(res.status).toBe(409);
    const body = res.jsonBody as { code: string; message: string };
    expect(body.code).toBe('snapshot_rollout_not_complete');
    expect(body.message).toContain('most recent plans');
    expect(getSnapshotStatus).not.toHaveBeenCalled();
    expect(submitSnapshotDelete).not.toHaveBeenCalled();
  });

  it('502 when the rollout-done gate check itself fails (fail closed, never silently proceeds)', async () => {
    getImageBuild.mockResolvedValue(entity({ state: 'done' }));
    checkRolloutDoneForVersion.mockRejectedValue(new Error('table down'));
    const res = await imageBuildsSnapshotDelete(req(), makeContext());
    expect(res.status).toBe(502);
    expect(submitSnapshotDelete).not.toHaveBeenCalled();
  });

  it('409 snapshot_already_deleted when the snapshot no longer exists', async () => {
    getImageBuild.mockResolvedValue(entity({ state: 'done' }));
    getSnapshotStatus.mockResolvedValue('deleted');
    const res = await imageBuildsSnapshotDelete(req(), makeContext());
    expect(res.status).toBe(409);
    const body = res.jsonBody as { code: string };
    expect(body.code).toBe('snapshot_already_deleted');
    expect(submitSnapshotDelete).not.toHaveBeenCalled();
  });

  it('502 when the snapshot existence check itself fails (fail closed)', async () => {
    getImageBuild.mockResolvedValue(entity({ state: 'done' }));
    getSnapshotStatus.mockResolvedValue('unknown');
    const res = await imageBuildsSnapshotDelete(req(), makeContext());
    expect(res.status).toBe(502);
    expect(submitSnapshotDelete).not.toHaveBeenCalled();
  });

  it('happy path: audits accepted BEFORE the delete submission, then success after, persists snapshotDeleteSubmittedAt, returns 200', async () => {
    const record = entity({ state: 'done' });
    getImageBuild.mockResolvedValueOnce(record).mockResolvedValueOnce({ ...record, snapshotDeleteSubmittedAt: '2026-08-23T00:00:00.000Z' });

    const res = await imageBuildsSnapshotDelete(req(), makeContext());

    expect(res.status).toBe(200);
    expect(submitSnapshotDelete).toHaveBeenCalledWith(record.snapshotName);

    const auditCalls = writeAuditEntry.mock.calls.map((call) => call[0] as { action: string; outcome: string });
    const snapshotAudits = auditCalls.filter((c) => c.action === 'image.build.snapshot_delete');
    expect(snapshotAudits.map((c) => c.outcome)).toEqual(['accepted', 'success']);

    // accepted must be written BEFORE submitSnapshotDelete is invoked.
    const acceptedCallIndex = writeAuditEntry.mock.invocationCallOrder[auditCalls.findIndex((c) => c.action === 'image.build.snapshot_delete' && c.outcome === 'accepted')];
    const submitCallIndex = submitSnapshotDelete.mock.invocationCallOrder[0];
    expect(acceptedCallIndex).toBeLessThan(submitCallIndex);

    expect(replaceImageBuild).toHaveBeenCalledWith(expect.objectContaining({ snapshotDeleteSubmittedAt: expect.any(String) }), expect.any(String));
    const body = res.jsonBody as { build: { snapshotDeleteSubmittedAt?: string } };
    expect(body.build.snapshotDeleteSubmittedAt).toBe('2026-08-23T00:00:00.000Z');
  });

  it('submission failure: audits accepted then failure, returns 502, never persists snapshotDeleteSubmittedAt', async () => {
    getImageBuild.mockResolvedValue(entity({ state: 'done' }));
    submitSnapshotDelete.mockRejectedValue(new Error('ARM rejected the delete'));

    const res = await imageBuildsSnapshotDelete(req(), makeContext());

    expect(res.status).toBe(502);
    const auditCalls = writeAuditEntry.mock.calls.map((call) => call[0] as { action: string; outcome: string });
    const snapshotAudits = auditCalls.filter((c) => c.action === 'image.build.snapshot_delete');
    expect(snapshotAudits.map((c) => c.outcome)).toEqual(['accepted', 'failure']);
    expect(replaceImageBuild).not.toHaveBeenCalled();
  });
});
