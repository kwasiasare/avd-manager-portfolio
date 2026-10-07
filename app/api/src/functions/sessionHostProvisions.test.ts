import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HttpRequest, InvocationContext } from '@azure/functions';
import type { SessionHostProvisionEntity } from '../services/sessionHostProvisionService';

const getHostPool = vi.fn();
const getVmTemplateInfo = vi.fn();
vi.mock('../services/avdService', () => ({
  getHostPool: (...args: unknown[]) => getHostPool(...args),
  getVmTemplateInfo: (...args: unknown[]) => getVmTemplateInfo(...args),
}));

const getCurrentImageVersion = vi.fn();
vi.mock('../services/imagesService', () => ({
  getCurrentImageVersion: (...args: unknown[]) => getCurrentImageVersion(...args),
}));

const listRolloutPlanEntities = vi.fn();
vi.mock('../services/rolloutPlanService', async () => {
  const actual = await vi.importActual<typeof import('../services/rolloutPlanService')>('../services/rolloutPlanService');
  return { ...actual, listRolloutPlanEntities: (...args: unknown[]) => listRolloutPlanEntities(...args) };
});

const assertImageVersionExists = vi.fn();
const assertSessionHostNameAvailable = vi.fn();
const submitNicCreation = vi.fn();
const submitVmCreation = vi.fn();
vi.mock('../services/sessionHostProvisionOrchestrator', async () => {
  const actual = await vi.importActual<typeof import('../services/sessionHostProvisionOrchestrator')>('../services/sessionHostProvisionOrchestrator');
  return {
    // PartialProvisionVmSubmissionError is the REAL class — the handler does
    // `error instanceof PartialProvisionVmSubmissionError`.
    PartialProvisionVmSubmissionError: actual.PartialProvisionVmSubmissionError,
    assertImageVersionExists: (...args: unknown[]) => assertImageVersionExists(...args),
    assertSessionHostNameAvailable: (...args: unknown[]) => assertSessionHostNameAvailable(...args),
    submitNicCreation: (...args: unknown[]) => submitNicCreation(...args),
    submitVmCreation: (...args: unknown[]) => submitVmCreation(...args),
  };
});

const createSessionHostProvision = vi.fn();
const getSessionHostProvision = vi.fn();
const replaceSessionHostProvision = vi.fn();
const listSessionHostProvisions = vi.fn();
const listInFlightSessionHostProvisionsForName = vi.fn();
const isProvisionStoreRequiredButMissing = vi.fn().mockReturnValue(false);
vi.mock('../services/sessionHostProvisionService', async () => {
  const actual = await vi.importActual<typeof import('../services/sessionHostProvisionService')>('../services/sessionHostProvisionService');
  return {
    ...actual,
    createSessionHostProvision: (...args: unknown[]) => createSessionHostProvision(...args),
    getSessionHostProvision: (...args: unknown[]) => getSessionHostProvision(...args),
    replaceSessionHostProvision: (...args: unknown[]) => replaceSessionHostProvision(...args),
    listSessionHostProvisions: (...args: unknown[]) => listSessionHostProvisions(...args),
    listInFlightSessionHostProvisionsForName: (...args: unknown[]) => listInFlightSessionHostProvisionsForName(...args),
    isProvisionStoreRequiredButMissing: (...args: unknown[]) => isProvisionStoreRequiredButMissing(...args),
  };
});

const writeAuditEntry = vi.fn().mockResolvedValue(undefined);
const isAuditRequiredButMissing = vi.fn().mockReturnValue(false);
vi.mock('../lib/auditLog', () => ({
  writeAuditEntry: (...args: unknown[]) => writeAuditEntry(...args),
  isAuditRequiredButMissing: (...args: unknown[]) => isAuditRequiredButMissing(...args),
}));

const { sessionHostProvisionsStart, sessionHostProvisionsList, sessionHostProvisionsGet, sessionHostProvisionsCancel } = await import('./sessionHostProvisions');

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
  const { headers = { 'x-ms-client-principal': adminHeader() }, body = {}, jsonThrows = false, method = 'POST', params = { hostPoolName: 'HP-CONTOSO-PROD' }, query = {} } = options;
  const lowerHeaders = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  const queryMap = new Map(Object.entries(query));
  return {
    method,
    url: 'https://func-example.azurewebsites.net/api/v1/hostpools/HP-CONTOSO-PROD/sessionhosts/provisions',
    headers: { get: (name: string) => lowerHeaders.get(name.toLowerCase()) ?? null },
    params,
    query: { get: (name: string) => queryMap.get(name) ?? null },
    json: async () => {
      if (jsonThrows) throw new Error('bad json');
      return body;
    },
  } as unknown as HttpRequest;
}

const VALID_START_BODY = { sessionHostName: 'avd-con-4', zone: '2' };

const HOST_POOL = { id: '/subscriptions/sub-id/resourceGroups/RG-AVD-HostPools/providers/Microsoft.DesktopVirtualization/hostPools/HP-CONTOSO-PROD', name: 'HP-CONTOSO-PROD', resourceGroup: 'RG-AVD-HostPools', hostPoolType: 'Pooled' as const, loadBalancerType: 'BreadthFirst', preferredAppGroupType: 'Desktop', maxSessionLimit: 10, validationEnvironment: false };

function entity(overrides: Partial<SessionHostProvisionEntity> = {}): SessionHostProvisionEntity & { etag: string } {
  return {
    partitionKey: 'provision',
    rowKey: 'provision-1',
    provisionId: 'provision-1',
    hostPoolName: 'HP-CONTOSO-PROD',
    sessionHostName: 'avd-con-4',
    zone: '2',
    vmSize: 'Standard_D4ads_v7',
    imageVersion: '2.2.0',
    state: 'planned',
    createdAt: '2026-08-23T00:00:00.000Z',
    updatedAt: '2026-08-23T00:00:00.000Z',
    createdBy: 'admin@example.com',
    createdById: 'entra-admin-1',
    vmName: 'avd-con-4',
    nicName: 'NIC-avd-con-4',
    stepsJson: '[]',
    planParamsJson: '{"sessionHostName":"avd-con-4","zone":"2","imageVersion":"2.2.0"}',
    planContextJson: '{}',
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
  process.env.RG_IMAGES = 'RG-AVD-Images';
  process.env.HOSTPOOL_NAME = 'HP-CONTOSO-PROD';
  delete process.env.REQUIRE_BACKEND_SECRET;
  delete process.env.WEBSITE_SITE_NAME;

  getHostPool.mockReset().mockResolvedValue(HOST_POOL);
  getVmTemplateInfo.mockReset().mockResolvedValue({ parsed: true, vmSizeId: 'Standard_D4ads_v7' });
  getCurrentImageVersion.mockReset().mockResolvedValue({ id: 'v-id', name: '2.1.0', imageDefinitionName: 'WIN11-ENT-MS-M365', excludeFromLatest: false });
  listRolloutPlanEntities.mockReset().mockResolvedValue([]);
  assertImageVersionExists.mockReset().mockResolvedValue({ ok: true, id: '/subscriptions/sub-id/resourceGroups/RG-AVD-Images/providers/Microsoft.Compute/galleries/ACG_AVD_CONTOSO/images/WIN11-ENT-MS-M365/versions/2.1.0' });
  assertSessionHostNameAvailable.mockReset().mockResolvedValue({ ok: true });
  submitNicCreation.mockReset();
  submitVmCreation.mockReset();
  createSessionHostProvision.mockReset().mockResolvedValue(undefined);
  getSessionHostProvision.mockReset();
  replaceSessionHostProvision.mockReset().mockResolvedValue(undefined);
  listSessionHostProvisions.mockReset().mockResolvedValue([]);
  listInFlightSessionHostProvisionsForName.mockReset().mockResolvedValue([]);
  isProvisionStoreRequiredButMissing.mockReset().mockReturnValue(false);
  writeAuditEntry.mockReset().mockResolvedValue(undefined);
  isAuditRequiredButMissing.mockReset().mockReturnValue(false);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('RBAC — every route is admin-only', () => {
  const nonAdminHeader = { 'x-ms-client-principal': operatorHeader() };

  it('POST .../provisions rejects an operator with 403', async () => {
    const res = await sessionHostProvisionsStart(makeRequest({ headers: nonAdminHeader, body: VALID_START_BODY }), makeContext());
    expect(res.status).toBe(403);
  });

  it('GET .../provisions rejects an operator with 403', async () => {
    const res = await sessionHostProvisionsList(makeRequest({ headers: nonAdminHeader, method: 'GET' }), makeContext());
    expect(res.status).toBe(403);
  });

  it('GET .../provisions/{id} rejects an operator with 403', async () => {
    const res = await sessionHostProvisionsGet(makeRequest({ headers: nonAdminHeader, method: 'GET', params: { hostPoolName: 'HP-CONTOSO-PROD', provisionId: 'provision-1' } }), makeContext());
    expect(res.status).toBe(403);
  });

  it('POST .../provisions/{id}/cancel rejects an operator with 403', async () => {
    const res = await sessionHostProvisionsCancel(makeRequest({ headers: nonAdminHeader, params: { hostPoolName: 'HP-CONTOSO-PROD', provisionId: 'provision-1' } }), makeContext());
    expect(res.status).toBe(403);
  });
});

describe('POST .../provisions — validation', () => {
  it('400 on a missing/invalid sessionHostName', async () => {
    const res = await sessionHostProvisionsStart(makeRequest({ body: { ...VALID_START_BODY, sessionHostName: '../etc/passwd' } }), makeContext());
    expect(res.status).toBe(400);
  });

  it('400 when sessionHostName exceeds the 15-character NetBIOS limit', async () => {
    const res = await sessionHostProvisionsStart(makeRequest({ body: { ...VALID_START_BODY, sessionHostName: 'avd-con-toolongname' } }), makeContext());
    expect(res.status).toBe(400);
  });

  it('400 on an invalid zone', async () => {
    const res = await sessionHostProvisionsStart(makeRequest({ body: { ...VALID_START_BODY, zone: '4' } }), makeContext());
    expect(res.status).toBe(400);
  });

  it('400 on a malformed imageVersion', async () => {
    const res = await sessionHostProvisionsStart(makeRequest({ body: { ...VALID_START_BODY, imageVersion: 'not-a-version' } }), makeContext());
    expect(res.status).toBe(400);
  });

  it('400 on invalid JSON body', async () => {
    const res = await sessionHostProvisionsStart(makeRequest({ jsonThrows: true }), makeContext());
    expect(res.status).toBe(400);
  });

  it('404 when hostPoolName does not match the configured pool', async () => {
    const res = await sessionHostProvisionsStart(makeRequest({ body: VALID_START_BODY, params: { hostPoolName: 'HP-OTHER' } }), makeContext());
    expect(res.status).toBe(404);
  });
});

describe('POST .../provisions?dryRun=true — ZERO mutations', () => {
  it('returns the plan and touches NEITHER the Table nor any ARM submission function', async () => {
    const res = await sessionHostProvisionsStart(makeRequest({ body: VALID_START_BODY, query: { dryRun: 'true' } }), makeContext());

    expect(res.status).toBe(200);
    const body = res.jsonBody as { dryRun: boolean; provision?: unknown; plan: { steps: unknown[] }; generatedAdminPassword?: string };
    expect(body.dryRun).toBe(true);
    expect(body.provision).toBeUndefined();
    expect(body.generatedAdminPassword).toBeUndefined();
    expect(body.plan.steps.length).toBe(6);

    expect(createSessionHostProvision).not.toHaveBeenCalled();
    expect(submitNicCreation).not.toHaveBeenCalled();
    expect(submitVmCreation).not.toHaveBeenCalled();
    expect(replaceSessionHostProvision).not.toHaveBeenCalled();
    expect(writeAuditEntry).not.toHaveBeenCalled();
    expect(listInFlightSessionHostProvisionsForName).not.toHaveBeenCalled();
  });

  it('a dry-run still works even when the audit/provision store is unconfigured (the fail-closed check is skipped for dry runs)', async () => {
    isAuditRequiredButMissing.mockReturnValue(true);
    isProvisionStoreRequiredButMissing.mockReturnValue(true);
    const res = await sessionHostProvisionsStart(makeRequest({ body: VALID_START_BODY, query: { dryRun: 'true' } }), makeContext());
    expect(res.status).toBe(200);
  });
});

describe('POST .../provisions — version default resolution', () => {
  it('defaults to the active (non-terminal) rollout plan\'s targetImageVersion when one exists', async () => {
    listRolloutPlanEntities.mockResolvedValue([{ state: 'validating_new', targetImageVersion: '2.3.0' }]);
    const res = await sessionHostProvisionsStart(makeRequest({ body: VALID_START_BODY, query: { dryRun: 'true' } }), makeContext());
    expect(res.status).toBe(200);
    expect(assertImageVersionExists).toHaveBeenCalledWith('2.3.0', 'RG-AVD-Images', expect.any(String), expect.any(String));
  });

  it('ignores a TERMINAL rollout plan and falls back to the currently-published version', async () => {
    listRolloutPlanEntities.mockResolvedValue([{ state: 'done', targetImageVersion: '2.3.0' }]);
    getCurrentImageVersion.mockResolvedValue({ id: 'v-id', name: '2.1.0', imageDefinitionName: 'WIN11-ENT-MS-M365', excludeFromLatest: false });
    const res = await sessionHostProvisionsStart(makeRequest({ body: VALID_START_BODY, query: { dryRun: 'true' } }), makeContext());
    expect(res.status).toBe(200);
    expect(assertImageVersionExists).toHaveBeenCalledWith('2.1.0', 'RG-AVD-Images', expect.any(String), expect.any(String));
  });

  it('an explicit imageVersion in the request body wins over both defaults', async () => {
    listRolloutPlanEntities.mockResolvedValue([{ state: 'validating_new', targetImageVersion: '2.3.0' }]);
    const res = await sessionHostProvisionsStart(makeRequest({ body: { ...VALID_START_BODY, imageVersion: '9.9.9' }, query: { dryRun: 'true' } }), makeContext());
    expect(res.status).toBe(200);
    expect(assertImageVersionExists).toHaveBeenCalledWith('9.9.9', 'RG-AVD-Images', expect.any(String), expect.any(String));
  });

  it('409 when the resolved version does not exist as a gallery image version', async () => {
    assertImageVersionExists.mockResolvedValue({ ok: false, reason: 'does not exist' });
    const res = await sessionHostProvisionsStart(makeRequest({ body: VALID_START_BODY }), makeContext());
    expect(res.status).toBe(409);
    expect(createSessionHostProvision).not.toHaveBeenCalled();
  });
});

describe('POST .../provisions — real start', () => {
  it('fails closed (500) when audit/provision storage is required but missing', async () => {
    process.env.WEBSITE_SITE_NAME = 'func-example-prod';
    isProvisionStoreRequiredButMissing.mockReturnValue(true);
    const res = await sessionHostProvisionsStart(makeRequest({ body: VALID_START_BODY }), makeContext());
    expect(res.status).toBe(500);
    expect(createSessionHostProvision).not.toHaveBeenCalled();
  });

  it('409 when a provision for the SAME session host name is already in flight', async () => {
    listInFlightSessionHostProvisionsForName.mockResolvedValue([entity({ provisionId: 'other', state: 'vm_creating' })]);
    const res = await sessionHostProvisionsStart(makeRequest({ body: VALID_START_BODY }), makeContext());
    expect(res.status).toBe(409);
    const body = res.jsonBody as { code: string };
    expect(body.code).toBe('session_host_provision_already_in_flight');
    expect(createSessionHostProvision).not.toHaveBeenCalled();
  });

  it('409 when a VM with this session host name already exists', async () => {
    assertSessionHostNameAvailable.mockResolvedValue({ ok: false, reason: 'already exists' });
    const res = await sessionHostProvisionsStart(makeRequest({ body: VALID_START_BODY }), makeContext());
    expect(res.status).toBe(409);
    const body = res.jsonBody as { code: string };
    expect(body.code).toBe('session_host_provision_name_exists');
    expect(createSessionHostProvision).not.toHaveBeenCalled();
  });

  it('PERSIST-BEFORE-SUBMIT: creates the planned row BEFORE calling submitNicCreation', async () => {
    const callOrder: string[] = [];
    createSessionHostProvision.mockImplementation(async () => {
      callOrder.push('create');
    });
    submitNicCreation.mockImplementation(async () => {
      callOrder.push('submitNic');
      return [];
    });
    submitVmCreation.mockImplementation(async () => {
      callOrder.push('submitVm');
      return [];
    });
    getSessionHostProvision.mockImplementation(async () => entity({ state: 'nic_creating' }));

    await sessionHostProvisionsStart(makeRequest({ body: VALID_START_BODY }), makeContext());

    expect(callOrder).toEqual(['create', 'submitNic', 'submitVm']);
  });

  it('creates the row (with a frozen planContextJson), submits NIC then VM with a server-generated password, transitions planned -> vm_creating, returns generatedAdminPassword exactly once, and audits with sessionHostName/from/to', async () => {
    submitNicCreation.mockResolvedValue([{ stepId: 'create_nic', status: 'succeeded' }]);
    submitVmCreation.mockResolvedValue([{ stepId: 'create_nic', status: 'succeeded' }, { stepId: 'create_vm', status: 'in_progress' }]);
    getSessionHostProvision.mockImplementation(async () => entity({ state: 'nic_creating' }));

    const res = await sessionHostProvisionsStart(makeRequest({ body: VALID_START_BODY }), makeContext());

    expect(res.status).toBe(201);
    expect(createSessionHostProvision).toHaveBeenCalledTimes(1);
    const createdEntity = createSessionHostProvision.mock.calls[0][0] as SessionHostProvisionEntity;
    expect(createdEntity.hostPoolName).toBe('HP-CONTOSO-PROD');
    expect(createdEntity.sessionHostName).toBe('avd-con-4');
    expect(createdEntity.vmName).toBe('avd-con-4');
    expect(createdEntity.nicName).toBe('NIC-avd-con-4');
    expect(JSON.parse(createdEntity.planContextJson)).toMatchObject({ hostPoolName: 'HP-CONTOSO-PROD', zone: '2', adminUsername: 'avdadmin' });

    const [, , generatedPassword] = submitVmCreation.mock.calls[0] as [unknown, unknown, string];
    expect(generatedPassword.length).toBeGreaterThanOrEqual(12);

    expect(replaceSessionHostProvision).toHaveBeenCalledWith(expect.objectContaining({ state: 'nic_creating' }), expect.any(String));
    expect(replaceSessionHostProvision).toHaveBeenCalledWith(expect.objectContaining({ state: 'vm_creating' }), expect.any(String));

    const body = res.jsonBody as { provision: { state: string }; dryRun: boolean; generatedAdminPassword: string };
    expect(body.dryRun).toBe(false);
    expect(body.generatedAdminPassword.length).toBeGreaterThanOrEqual(12);

    expect(writeAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'sessionhost.provision.create', outcome: 'success', parameters: expect.objectContaining({ sessionHostName: 'avd-con-4', from: 'planned', to: 'vm_creating' }) }),
      expect.anything(),
    );
  });

  it('SUBMIT-FAILURE leaves a resumable record: a NIC submission failure leaves the row at "planned" with create_nic marked failed, and returns a 502 pointing at GET .../provisions/{id}', async () => {
    submitNicCreation.mockRejectedValue(new Error('quota exceeded'));
    getSessionHostProvision.mockImplementation(async () => entity({ state: 'planned' }));

    const res = await sessionHostProvisionsStart(makeRequest({ body: VALID_START_BODY }), makeContext());

    expect(res.status).toBe(502);
    const body = res.jsonBody as { message: string; details: { provisionId: string } };
    expect(body.message).toContain('provisions/');
    expect(replaceSessionHostProvision).toHaveBeenCalledWith(expect.objectContaining({ errorMessage: expect.stringContaining('quota exceeded') }), expect.any(String));
    expect(submitVmCreation).not.toHaveBeenCalled();
    expect(writeAuditEntry).toHaveBeenCalledWith(expect.objectContaining({ action: 'sessionhost.provision.create', outcome: 'failure' }), expect.anything());
  });

  it('SUBMIT-FAILURE (VM after NIC succeeded) leaves the row at "nic_creating" — a real PartialProvisionVmSubmissionError, not a generic 502 with no state', async () => {
    submitNicCreation.mockResolvedValue([{ stepId: 'create_nic', status: 'succeeded' }]);
    submitVmCreation.mockImplementation(async () => {
      const { PartialProvisionVmSubmissionError } = await import('../services/sessionHostProvisionOrchestrator');
      throw new PartialProvisionVmSubmissionError('VM submit failed', [{ stepId: 'create_nic', status: 'succeeded' }, { stepId: 'create_vm', status: 'failed', error: 'boom' }], new Error('boom'));
    });
    getSessionHostProvision.mockImplementation(async () => entity({ state: 'nic_creating' }));

    const res = await sessionHostProvisionsStart(makeRequest({ body: VALID_START_BODY }), makeContext());

    expect(res.status).toBe(502);
    // The LAST replace call (the failure-path one) must not force the state
    // back to 'planned' — it preserves current.state ('nic_creating').
    const lastCall = replaceSessionHostProvision.mock.calls.at(-1) as [SessionHostProvisionEntity, string];
    expect(lastCall[0].state).toBe('nic_creating');
  });
});

describe('GET .../provisions/{id}', () => {
  it('404 when the provision belongs to a different host pool', async () => {
    getSessionHostProvision.mockResolvedValue(entity({ hostPoolName: 'HP-OTHER' }));
    const res = await sessionHostProvisionsGet(makeRequest({ method: 'GET', params: { hostPoolName: 'HP-CONTOSO-PROD', provisionId: 'provision-1' } }), makeContext());
    expect(res.status).toBe(404);
  });

  it('200 with the full detail otherwise', async () => {
    getSessionHostProvision.mockResolvedValue(entity());
    const res = await sessionHostProvisionsGet(makeRequest({ method: 'GET', params: { hostPoolName: 'HP-CONTOSO-PROD', provisionId: 'provision-1' } }), makeContext());
    expect(res.status).toBe(200);
    expect((res.jsonBody as { sessionHostName: string }).sessionHostName).toBe('avd-con-4');
  });
});

describe('POST .../provisions/{id}/cancel', () => {
  it('409 when already terminal', async () => {
    getSessionHostProvision.mockResolvedValue(entity({ state: 'done' }));
    const res = await sessionHostProvisionsCancel(makeRequest({ params: { hostPoolName: 'HP-CONTOSO-PROD', provisionId: 'provision-1' } }), makeContext());
    expect(res.status).toBe(409);
  });

  it('cancels a non-terminal provision, sets cleanupGuidance, and audits', async () => {
    // First read (inside the ETag retry loop) sees the live 'vm_creating'
    // row; the SECOND read (the handler's post-replace "final" re-fetch)
    // simulates the Table now reflecting the just-written 'cancelled' state.
    getSessionHostProvision.mockResolvedValueOnce(entity({ state: 'vm_creating' })).mockResolvedValueOnce(entity({ state: 'cancelled', cancelReason: undefined }));
    const res = await sessionHostProvisionsCancel(makeRequest({ params: { hostPoolName: 'HP-CONTOSO-PROD', provisionId: 'provision-1' } }), makeContext());
    expect(res.status).toBe(200);
    const body = res.jsonBody as { provision: { state: string }; cleanupGuidance: string };
    expect(body.provision.state).toBe('cancelled');
    expect(body.cleanupGuidance.length).toBeGreaterThan(0);
    expect(writeAuditEntry).toHaveBeenCalledWith(expect.objectContaining({ action: 'sessionhost.provision.cancel', outcome: 'success' }), expect.anything());
  });
});
