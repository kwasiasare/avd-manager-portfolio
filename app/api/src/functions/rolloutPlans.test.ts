import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HttpRequest, InvocationContext } from '@azure/functions';
import type { RolloutNewHost, RolloutOldHost, RolloutState } from '@avdmgr/shared';
import type { RolloutPlanEntity, RolloutPlanRecord } from '../services/rolloutPlanService';

const setSessionHostDrain = vi.fn();
const resolveSessionHostVm = vi.fn();
const removeSessionHost = vi.fn();
const isArmNotFoundError = vi.fn().mockReturnValue(false);
vi.mock('../services/avdService', () => ({
  setSessionHostDrain: (...args: unknown[]) => setSessionHostDrain(...args),
  resolveSessionHostVm: (...args: unknown[]) => resolveSessionHostVm(...args),
  removeSessionHost: (...args: unknown[]) => removeSessionHost(...args),
  isNotFoundError: (...args: unknown[]) => isArmNotFoundError(...args),
}));

const beginVmDelete = vi.fn().mockResolvedValue(undefined);
const submitFslogixConfigCheck = vi.fn().mockResolvedValue(undefined);
vi.mock('../services/computeService', () => ({
  beginVmDelete: (...args: unknown[]) => beginVmDelete(...args),
  submitFslogixConfigCheck: (...args: unknown[]) => submitFslogixConfigCheck(...args),
}));

const writeAuditEntry = vi.fn().mockResolvedValue(undefined);
const isAuditRequiredButMissing = vi.fn().mockReturnValue(false);
vi.mock('../lib/auditLog', () => ({
  writeAuditEntry: (...args: unknown[]) => writeAuditEntry(...args),
  isAuditRequiredButMissing: (...args: unknown[]) => isAuditRequiredButMissing(...args),
}));

// Real canTransition/allNewHostsAvailableAndHealthy/allNewHostsImageVerified/
// canRemoveHost/forceProceedNextState/toRolloutPlanDetail/parseOldHosts/
// parseNewHosts/ROLLOUT_MAX_HOSTS/isConflictError/isPreconditionFailedError/
// isTerminalState (pure logic — exercised for real) with ONLY the
// Table/sentinel I/O primitives mocked — same "partial real module"
// approach as auditLog.test.ts's `odata: actual.odata`.
//
// persistWithMergeRetry is ALSO mocked here (not exercised for real) — its
// OWN 412-retry-and-merge mechanics are unit-tested directly in
// rolloutPlanService.test.ts (mocked Table client); this file instead tests
// what each HANDLER does with a working merge-retry primitive: what it
// passes in, in what order relative to auditing, and how it reacts if the
// primitive ultimately rejects.
const getRolloutPlanEntity = vi.fn();
const listRolloutPlanEntitiesWithTruncation = vi.fn();
const createRolloutPlanEntity = vi.fn();
const persistWithMergeRetry = vi.fn();
const createActiveSentinel = vi.fn();
const deleteActiveSentinel = vi.fn();
const getActiveSentinel = vi.fn();
const isRolloutStoreRequiredButMissing = vi.fn().mockReturnValue(false);
vi.mock('../services/rolloutPlanService', async () => {
  const actual = await vi.importActual<typeof import('../services/rolloutPlanService')>('../services/rolloutPlanService');
  return {
    ...actual,
    getRolloutPlanEntity: (...args: unknown[]) => getRolloutPlanEntity(...args),
    listRolloutPlanEntitiesWithTruncation: (...args: unknown[]) => listRolloutPlanEntitiesWithTruncation(...args),
    createRolloutPlanEntity: (...args: unknown[]) => createRolloutPlanEntity(...args),
    persistWithMergeRetry: (...args: unknown[]) => persistWithMergeRetry(...args),
    createActiveSentinel: (...args: unknown[]) => createActiveSentinel(...args),
    deleteActiveSentinel: (...args: unknown[]) => deleteActiveSentinel(...args),
    getActiveSentinel: (...args: unknown[]) => getActiveSentinel(...args),
    isRolloutStoreRequiredButMissing: (...args: unknown[]) => isRolloutStoreRequiredButMissing(...args),
  };
});

const { listRolloutPlans, createRolloutPlan, rolloutPlanDetailHandler, rolloutPlanActionHandler } = await import('./rolloutPlans');

interface FakeContext extends InvocationContext {
  warnings: string[];
  errors: unknown[];
  logs: unknown[];
}

function encodePrincipal(principal: unknown): string {
  return Buffer.from(JSON.stringify(principal), 'utf-8').toString('base64');
}

function adminHeader(userDetails = 'admin@example.com', userId = 'entra-obj-admin-1') {
  return encodePrincipal({ identityProvider: 'aad', userId, userDetails, userRoles: ['admin'] });
}

function viewerHeader() {
  return encodePrincipal({ identityProvider: 'aad', userId: 'u1', userDetails: 'viewer@example.com', userRoles: ['viewer'] });
}

function operatorHeader() {
  return encodePrincipal({ identityProvider: 'aad', userId: 'u2', userDetails: 'operator@example.com', userRoles: ['operator'] });
}

function makeRequest(options: {
  headers?: Record<string, string>;
  hostPoolName?: string;
  planId?: string;
  action?: string;
  body?: unknown;
  jsonThrows?: boolean;
  method?: string;
}): HttpRequest {
  const { headers = {}, hostPoolName = 'HP-CONTOSO-PROD', planId, action, body = {}, jsonThrows = false, method = 'POST' } = options;
  const lower = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  const params: Record<string, string> = { hostPoolName };
  if (planId !== undefined) params.planId = planId;
  if (action !== undefined) params.action = action;
  return {
    method,
    url: 'https://func-example.azurewebsites.net/api/v1/hostpools/HP-CONTOSO-PROD/rollout-plans',
    headers: { get: (name: string) => lower.get(name.toLowerCase()) ?? null },
    params,
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

function oldHost(overrides: Partial<RolloutOldHost> = {}): RolloutOldHost {
  return { sessionHostName: 'avd-con-0', status: 'pending', ...overrides };
}

function newHost(overrides: Partial<RolloutNewHost> = {}): RolloutNewHost {
  return { sessionHostName: 'avd-con-1', status: 'awaiting_registration', ...overrides };
}

function record(overrides: Partial<RolloutPlanEntity> = {}): RolloutPlanRecord {
  return {
    partitionKey: 'HP-CONTOSO-PROD',
    rowKey: 'plan-1',
    hostPoolName: 'HP-CONTOSO-PROD',
    targetImageVersion: '3.0.0',
    state: 'planned',
    oldHostsJson: JSON.stringify([oldHost()]),
    newHostsJson: JSON.stringify([newHost()]),
    createdBy: 'admin@example.com',
    createdById: 'entra-obj-admin-1',
    createdAt: '2026-08-16T10:00:00.000Z',
    updatedAt: '2026-08-16T10:00:00.000Z',
    reason: 'roll out 3.0.0',
    etag: 'W/"etag-1"',
    ...overrides,
  };
}

/** Default persistWithMergeRetry behavior: applies `mutate` to the etag-stripped startingRecord and returns it — simulating a first-try, no-conflict write. Individual tests override with mockRejectedValueOnce/mockImplementationOnce to exercise a handler's exhausted-retry path. */
function defaultMergeRetry(_hostPoolName: string, _planId: string, startingRecord: RolloutPlanRecord, mutate: (fresh: RolloutPlanEntity) => RolloutPlanEntity): Promise<RolloutPlanEntity> {
  const { etag: _etag, ...base } = startingRecord;
  void _etag;
  return Promise.resolve(mutate(base));
}

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  process.env.SUBSCRIPTION_ID = 'sub-id';
  process.env.RG_HOSTPOOLS = 'RG-AVD-HostPools';
  process.env.HOSTPOOL_NAME = 'HP-CONTOSO-PROD';
  delete process.env.REQUIRE_BACKEND_SECRET;
  setSessionHostDrain.mockReset();
  resolveSessionHostVm.mockReset();
  removeSessionHost.mockReset().mockResolvedValue(undefined);
  isArmNotFoundError.mockReset().mockReturnValue(false);
  beginVmDelete.mockReset().mockResolvedValue(undefined);
  submitFslogixConfigCheck.mockReset().mockResolvedValue(undefined);
  writeAuditEntry.mockReset().mockResolvedValue(undefined);
  isAuditRequiredButMissing.mockReset().mockReturnValue(false);
  getRolloutPlanEntity.mockReset();
  listRolloutPlanEntitiesWithTruncation.mockReset().mockResolvedValue({ entities: [], truncated: false });
  createRolloutPlanEntity.mockReset().mockResolvedValue(undefined);
  persistWithMergeRetry.mockReset().mockImplementation(defaultMergeRetry);
  createActiveSentinel.mockReset().mockResolvedValue(undefined);
  deleteActiveSentinel.mockReset().mockResolvedValue(undefined);
  getActiveSentinel.mockReset().mockResolvedValue(null);
  isRolloutStoreRequiredButMissing.mockReset().mockReturnValue(false);
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('createRolloutPlan — auth', () => {
  it('returns 403 for a viewer and never touches the store', async () => {
    const response = await createRolloutPlan(makeRequest({ headers: { 'x-ms-client-principal': viewerHeader() } }), makeContext());
    expect(response.status).toBe(403);
    expect(createActiveSentinel).not.toHaveBeenCalled();
    expect(createRolloutPlanEntity).not.toHaveBeenCalled();
  });

  it('returns 403 for an operator (this wizard is admin-only, unlike most of this app)', async () => {
    const response = await createRolloutPlan(makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() } }), makeContext());
    expect(response.status).toBe(403);
  });
});

describe('createRolloutPlan — validation', () => {
  const validBody = { targetImageVersion: '3.0.0', oldHostNames: ['avd-con-0'], newHostNames: ['avd-con-1'], reason: 'roll out 3.0.0' };

  it('rejects a missing/invalid targetImageVersion', async () => {
    const response = await createRolloutPlan(makeRequest({ headers: { 'x-ms-client-principal': adminHeader() }, body: { ...validBody, targetImageVersion: '' } }), makeContext());
    expect(response.status).toBe(400);
    expect(response.jsonBody).toMatchObject({ code: 'invalid_target_image_version' });
  });

  it('rejects an empty oldHostNames array', async () => {
    const response = await createRolloutPlan(makeRequest({ headers: { 'x-ms-client-principal': adminHeader() }, body: { ...validBody, oldHostNames: [] } }), makeContext());
    expect(response.status).toBe(400);
    expect(response.jsonBody).toMatchObject({ code: 'missing_oldHostNames' });
  });

  it('rejects an oldHostNames entry with an invalid character', async () => {
    const response = await createRolloutPlan(makeRequest({ headers: { 'x-ms-client-principal': adminHeader() }, body: { ...validBody, oldHostNames: ['../etc/passwd'] } }), makeContext());
    expect(response.status).toBe(400);
    expect(response.jsonBody).toMatchObject({ code: 'invalid_oldHostNames' });
  });

  it('rejects more than ROLLOUT_MAX_HOSTS entries', async () => {
    const many = Array.from({ length: 51 }, (_, i) => `avd-con-${i}`);
    const response = await createRolloutPlan(makeRequest({ headers: { 'x-ms-client-principal': adminHeader() }, body: { ...validBody, oldHostNames: many } }), makeContext());
    expect(response.status).toBe(400);
    expect(response.jsonBody).toMatchObject({ code: 'too_many_oldHostNames' });
  });

  it('rejects a missing reason', async () => {
    const response = await createRolloutPlan(makeRequest({ headers: { 'x-ms-client-principal': adminHeader() }, body: { ...validBody, reason: '' } }), makeContext());
    expect(response.status).toBe(400);
    expect(createActiveSentinel).not.toHaveBeenCalled();
  });

  it('returns 500 and refuses to create when audit is required but missing (fail-closed)', async () => {
    isAuditRequiredButMissing.mockReturnValue(true);
    const response = await createRolloutPlan(makeRequest({ headers: { 'x-ms-client-principal': adminHeader() }, body: validBody }), makeContext());
    expect(response.status).toBe(500);
    expect(createActiveSentinel).not.toHaveBeenCalled();
  });
});

describe('createRolloutPlan — TOCTOU-safe one-active-plan-at-a-time (AM-28 peer review item 10)', () => {
  const validBody = { targetImageVersion: '3.0.0', oldHostNames: ['avd-con-0'], newHostNames: ['avd-con-1'], reason: 'roll out 3.0.0' };

  it('rejects (409) via the sentinel createEntity conflict, never via a list-then-check race', async () => {
    createActiveSentinel.mockRejectedValue(Object.assign(new Error('EntityAlreadyExists'), { statusCode: 409 }));
    getActiveSentinel.mockResolvedValue({ activePlanId: 'plan-existing' });
    const response = await createRolloutPlan(makeRequest({ headers: { 'x-ms-client-principal': adminHeader() }, body: validBody }), makeContext());
    expect(response.status).toBe(409);
    expect(response.jsonBody).toMatchObject({ code: 'rollout_plan_already_active' });
    expect((response.jsonBody as { message: string }).message).toContain('plan-existing');
    expect(createRolloutPlanEntity).not.toHaveBeenCalled();
  });

  it('reports a generic message if the informative sentinel read itself fails, without masking the 409', async () => {
    createActiveSentinel.mockRejectedValue(Object.assign(new Error('EntityAlreadyExists'), { statusCode: 409 }));
    getActiveSentinel.mockRejectedValue(new Error('table unreachable'));
    const response = await createRolloutPlan(makeRequest({ headers: { 'x-ms-client-principal': adminHeader() }, body: validBody }), makeContext());
    expect(response.status).toBe(409);
    expect(response.jsonBody).toMatchObject({ code: 'rollout_plan_already_active' });
  });

  it('returns 502 (not 409) when the sentinel write fails for a reason OTHER than a conflict', async () => {
    createActiveSentinel.mockRejectedValue(new Error('table unreachable'));
    const response = await createRolloutPlan(makeRequest({ headers: { 'x-ms-client-principal': adminHeader() }, body: validBody }), makeContext());
    expect(response.status).toBe(502);
    expect(createRolloutPlanEntity).not.toHaveBeenCalled();
  });

  it('creates the sentinel BEFORE the plan row, and deletes it again if the plan row write then fails', async () => {
    createActiveSentinel.mockResolvedValue(undefined);
    createRolloutPlanEntity.mockRejectedValue(new Error('table unreachable'));
    const response = await createRolloutPlan(makeRequest({ headers: { 'x-ms-client-principal': adminHeader() }, body: validBody }), makeContext());
    expect(response.status).toBe(502);
    expect(createActiveSentinel).toHaveBeenCalledTimes(1);
    expect(deleteActiveSentinel).toHaveBeenCalledTimes(1);
  });

  it('creates a plan in state planned with per-host pending/awaiting_registration statuses, and audits it', async () => {
    const response = await createRolloutPlan(makeRequest({ headers: { 'x-ms-client-principal': adminHeader() }, body: validBody }), makeContext());
    expect(response.status).toBe(201);
    expect(createActiveSentinel).toHaveBeenCalledWith('HP-CONTOSO-PROD', expect.any(String));
    const [entityArg] = createRolloutPlanEntity.mock.calls[0] as [RolloutPlanEntity];
    expect(entityArg.state).toBe('planned');
    expect(JSON.parse(entityArg.oldHostsJson)).toEqual([{ sessionHostName: 'avd-con-0', status: 'pending' }]);
    expect(JSON.parse(entityArg.newHostsJson)).toEqual([{ sessionHostName: 'avd-con-1', status: 'awaiting_registration' }]);
    expect(writeAuditEntry).toHaveBeenCalledTimes(1);
    const [event] = writeAuditEntry.mock.calls[0];
    expect(event).toMatchObject({ action: 'rollout.create', outcome: 'success' });
  });
});

describe('rolloutPlanDetailHandler', () => {
  it('returns 404 when the plan does not exist', async () => {
    getRolloutPlanEntity.mockResolvedValue(null);
    const response = await rolloutPlanDetailHandler(makeRequest({ headers: { 'x-ms-client-principal': adminHeader() }, planId: 'plan-1', method: 'GET' }), makeContext());
    expect(response.status).toBe(404);
  });

  it('returns the projected plan on success', async () => {
    getRolloutPlanEntity.mockResolvedValue(record());
    const response = await rolloutPlanDetailHandler(makeRequest({ headers: { 'x-ms-client-principal': adminHeader() }, planId: 'plan-1', method: 'GET' }), makeContext());
    expect(response.status).toBe(200);
    expect((response.jsonBody as { plan: { id: string } }).plan.id).toBe('plan-1');
  });
});

describe('rolloutPlanActionHandler — illegal-transition rejection', () => {
  it.each<[RolloutState, string]>([
    ['draining_old', 'start'],
    ['planned', 'force-proceed'],
    ['done', 'force-proceed'],
    ['planned', 'verify-config'],
    ['planned', 'confirm-cutover'],
    ['planned', 'start-removal'],
    ['planned', 'remove-hosts'],
    ['done', 'rollback'],
    ['draining_old', 'cancel'],
  ])('rejects action "%s" from state "%s" with 409 and makes no ARM/store write', async (fromState, action) => {
    getRolloutPlanEntity.mockResolvedValue(record({ state: fromState }));
    const response = await rolloutPlanActionHandler(
      makeRequest({ headers: { 'x-ms-client-principal': adminHeader() }, planId: 'plan-1', action, body: { reason: 'because' } }),
      makeContext(),
    );
    expect(response.status).toBe(409);
    expect(response.jsonBody).toMatchObject({ code: expect.stringMatching(/illegal_rollout_transition|rollout_new_hosts_not_ready/) });
    expect(persistWithMergeRetry).not.toHaveBeenCalled();
    expect(setSessionHostDrain).not.toHaveBeenCalled();
  });

  it('returns 400 for an unknown action name', async () => {
    getRolloutPlanEntity.mockResolvedValue(record());
    const response = await rolloutPlanActionHandler(makeRequest({ headers: { 'x-ms-client-principal': adminHeader() }, planId: 'plan-1', action: 'not-a-real-action' }), makeContext());
    expect(response.status).toBe(400);
  });
});

describe('rolloutPlanActionHandler — start (planned -> draining_old): BLOCKER audit-before-write', () => {
  it('drains every old host, audits BEFORE the state write, and transitions to draining_old on success', async () => {
    getRolloutPlanEntity.mockResolvedValue(record({ state: 'planned', oldHostsJson: JSON.stringify([oldHost({ sessionHostName: 'avd-con-0' }), oldHost({ sessionHostName: 'avd-con-2' })]) }));
    setSessionHostDrain.mockResolvedValue({});
    const callOrder: string[] = [];
    writeAuditEntry.mockImplementation(async () => {
      callOrder.push('audit');
    });
    persistWithMergeRetry.mockImplementation(async (...args: Parameters<typeof defaultMergeRetry>) => {
      callOrder.push('write');
      return defaultMergeRetry(...args);
    });

    const response = await rolloutPlanActionHandler(makeRequest({ headers: { 'x-ms-client-principal': adminHeader() }, planId: 'plan-1', action: 'start' }), makeContext());

    expect(response.status).toBe(200);
    expect(setSessionHostDrain).toHaveBeenCalledWith('HP-CONTOSO-PROD', 'avd-con-0', false);
    expect(setSessionHostDrain).toHaveBeenCalledWith('HP-CONTOSO-PROD', 'avd-con-2', false);
    expect(callOrder).toEqual(['audit', 'write']); // BLOCKER fix: audit happens BEFORE the state write.
    const [, , , mutate] = persistWithMergeRetry.mock.calls[0] as [string, string, RolloutPlanRecord, (fresh: RolloutPlanEntity) => RolloutPlanEntity];
    const updatedEntity = mutate({ ...record(), state: 'planned' });
    expect(updatedEntity.state).toBe('draining_old');
    expect(JSON.parse(updatedEntity.oldHostsJson).every((h: RolloutOldHost) => h.status === 'draining')).toBe(true);
  });

  it('does NOT persist a state change if any host fails to drain (atomic start), and audits the failure', async () => {
    getRolloutPlanEntity.mockResolvedValue(record({ state: 'planned', oldHostsJson: JSON.stringify([oldHost({ sessionHostName: 'avd-con-0' }), oldHost({ sessionHostName: 'avd-con-2' })]) }));
    setSessionHostDrain.mockImplementation(async (_hp: string, name: string) => {
      if (name === 'avd-con-2') throw new Error('ARM timeout');
      return {};
    });
    const response = await rolloutPlanActionHandler(makeRequest({ headers: { 'x-ms-client-principal': adminHeader() }, planId: 'plan-1', action: 'start' }), makeContext());
    expect(response.status).toBe(502);
    expect(persistWithMergeRetry).not.toHaveBeenCalled();
    expect(writeAuditEntry).toHaveBeenCalledWith(expect.objectContaining({ action: 'rollout.start', outcome: 'failure' }), expect.anything());
  });

  it('BLOCKER regression: if the state write is ultimately exhausted (persistWithMergeRetry rejects) AFTER ARM drain succeeded, the audit row was ALREADY written and the response is honest, not a generic "nothing happened" error', async () => {
    getRolloutPlanEntity.mockResolvedValue(record({ state: 'planned' }));
    setSessionHostDrain.mockResolvedValue({});
    persistWithMergeRetry.mockRejectedValue(new Error('PreconditionFailed after 3 retries'));

    const response = await rolloutPlanActionHandler(makeRequest({ headers: { 'x-ms-client-principal': adminHeader() }, planId: 'plan-1', action: 'start' }), makeContext());

    expect(response.status).toBe(502);
    expect(response.jsonBody).toMatchObject({ code: 'rollout_start_state_write_failed' });
    expect((response.jsonBody as { message: string }).message).toMatch(/submitted to Azure and audited/i);
    // The audit row for the ACHIEVED drain must exist regardless of the state-write outcome.
    expect(writeAuditEntry).toHaveBeenCalledWith(expect.objectContaining({ action: 'rollout.start', outcome: 'success' }), expect.anything());
  });
});

describe('rolloutPlanActionHandler — force-proceed (draining_old -> awaiting_new_hosts, and now awaiting_new_hosts -> validating_new)', () => {
  it('requires a mandatory reason', async () => {
    getRolloutPlanEntity.mockResolvedValue(record({ state: 'draining_old' }));
    const response = await rolloutPlanActionHandler(makeRequest({ headers: { 'x-ms-client-principal': adminHeader() }, planId: 'plan-1', action: 'force-proceed', body: {} }), makeContext());
    expect(response.status).toBe(400);
    expect(persistWithMergeRetry).not.toHaveBeenCalled();
  });

  it('transitions draining_old -> awaiting_new_hosts without mutating any host', async () => {
    getRolloutPlanEntity.mockResolvedValue(record({ state: 'draining_old' }));
    const response = await rolloutPlanActionHandler(
      makeRequest({ headers: { 'x-ms-client-principal': adminHeader() }, planId: 'plan-1', action: 'force-proceed', body: { reason: 'stuck session, proceeding' } }),
      makeContext(),
    );
    expect(response.status).toBe(200);
    expect(setSessionHostDrain).not.toHaveBeenCalled();
    const [, , , mutate] = persistWithMergeRetry.mock.calls[0] as [string, string, RolloutPlanRecord, (fresh: RolloutPlanEntity) => RolloutPlanEntity];
    const updated = mutate({ ...record(), state: 'draining_old' });
    expect(updated.state).toBe('awaiting_new_hosts');
    expect(updated.forcedProceedReason).toBe('stuck session, proceeding');
  });

  it('AM-28 peer review item 6 — escape hatch extended: also transitions awaiting_new_hosts -> validating_new', async () => {
    getRolloutPlanEntity.mockResolvedValue(record({ state: 'awaiting_new_hosts' }));
    const response = await rolloutPlanActionHandler(
      makeRequest({ headers: { 'x-ms-client-principal': adminHeader() }, planId: 'plan-1', action: 'force-proceed', body: { reason: 'one host renamed, proceeding anyway' } }),
      makeContext(),
    );
    expect(response.status).toBe(200);
    const [, , , mutate] = persistWithMergeRetry.mock.calls[0] as [string, string, RolloutPlanRecord, (fresh: RolloutPlanEntity) => RolloutPlanEntity];
    const updated = mutate({ ...record(), state: 'awaiting_new_hosts' });
    expect(updated.state).toBe('validating_new');
  });
});

describe('rolloutPlanActionHandler — confirm-cutover gate (availability/health, image verification, AND AM-47 config verification)', () => {
  it('rejects (409) when a new host is not yet available+healthy and force is not set', async () => {
    getRolloutPlanEntity.mockResolvedValue(record({ state: 'validating_new', newHostsJson: JSON.stringify([newHost({ status: 'registered' })]) }));
    const response = await rolloutPlanActionHandler(makeRequest({ headers: { 'x-ms-client-principal': adminHeader() }, planId: 'plan-1', action: 'confirm-cutover', body: {} }), makeContext());
    expect(response.status).toBe(409);
    expect(response.jsonBody).toMatchObject({ code: 'rollout_new_hosts_not_ready' });
  });

  it('AM-28 peer review item 4 — rejects (409) when hosts are available+healthy but the image version is not verified', async () => {
    getRolloutPlanEntity.mockResolvedValue(
      record({ state: 'validating_new', newHostsJson: JSON.stringify([newHost({ status: 'available', healthy: true, imageVerified: false, configCheck: { status: 'passed', diffs: [] } })]) }),
    );
    const response = await rolloutPlanActionHandler(makeRequest({ headers: { 'x-ms-client-principal': adminHeader() }, planId: 'plan-1', action: 'confirm-cutover', body: {} }), makeContext());
    expect(response.status).toBe(409);
    expect(response.jsonBody).toMatchObject({ code: 'rollout_new_hosts_not_ready' });
    expect((response.jsonBody as { message: string }).message).toMatch(/image/i);
  });

  it('AM-47 — rejects (409) when hosts are available+healthy+image-verified but the FSLogix config check has not passed', async () => {
    getRolloutPlanEntity.mockResolvedValue(record({ state: 'validating_new', newHostsJson: JSON.stringify([newHost({ status: 'available', healthy: true, imageVerified: true })]) }));
    const response = await rolloutPlanActionHandler(makeRequest({ headers: { 'x-ms-client-principal': adminHeader() }, planId: 'plan-1', action: 'confirm-cutover', body: {} }), makeContext());
    expect(response.status).toBe(409);
    expect(response.jsonBody).toMatchObject({ code: 'rollout_new_hosts_not_ready' });
    expect((response.jsonBody as { message: string; details: { readyForConfig: boolean } }).message).toMatch(/config/i);
    expect((response.jsonBody as { details: { readyForConfig: boolean } }).details.readyForConfig).toBe(false);
  });

  it('AM-47 — rejects (409) when the config check reported failed (diffs present)', async () => {
    getRolloutPlanEntity.mockResolvedValue(
      record({
        state: 'validating_new',
        newHostsJson: JSON.stringify([newHost({ status: 'available', healthy: true, imageVerified: true, configCheck: { status: 'failed', diffs: [{ key: 'VolumeType', expected: 'VHDX', actual: 'VHD' }] } })]),
      }),
    );
    const response = await rolloutPlanActionHandler(makeRequest({ headers: { 'x-ms-client-principal': adminHeader() }, planId: 'plan-1', action: 'confirm-cutover', body: {} }), makeContext());
    expect(response.status).toBe(409);
  });

  it('succeeds and marks every new host validated when force:true with a reason is supplied, even if not ready on any gate', async () => {
    getRolloutPlanEntity.mockResolvedValue(record({ state: 'validating_new', newHostsJson: JSON.stringify([newHost({ status: 'registered' })]) }));
    const response = await rolloutPlanActionHandler(
      makeRequest({ headers: { 'x-ms-client-principal': adminHeader() }, planId: 'plan-1', action: 'confirm-cutover', body: { force: true, reason: 'accepting the risk' } }),
      makeContext(),
    );
    expect(response.status).toBe(200);
    const [, , , mutate] = persistWithMergeRetry.mock.calls[0] as [string, string, RolloutPlanRecord, (fresh: RolloutPlanEntity) => RolloutPlanEntity];
    const updated = mutate({ ...record(), state: 'validating_new' });
    expect(updated.state).toBe('cutover');
    expect(JSON.parse(updated.newHostsJson)).toEqual([{ ...newHost({ status: 'registered' }), status: 'validated' }]);
  });

  it('succeeds without force when every new host is available+healthy, image-verified, AND config-verified', async () => {
    getRolloutPlanEntity.mockResolvedValue(
      record({ state: 'validating_new', newHostsJson: JSON.stringify([newHost({ status: 'available', healthy: true, imageVerified: true, configCheck: { status: 'passed', diffs: [] } })]) }),
    );
    const response = await rolloutPlanActionHandler(makeRequest({ headers: { 'x-ms-client-principal': adminHeader() }, planId: 'plan-1', action: 'confirm-cutover', body: {} }), makeContext());
    expect(response.status).toBe(200);
  });
});

describe('rolloutPlanActionHandler — verify-config (AM-47)', () => {
  it('returns 403 for a non-admin caller', async () => {
    getRolloutPlanEntity.mockResolvedValue(record({ state: 'validating_new' }));
    const response = await rolloutPlanActionHandler(makeRequest({ headers: { 'x-ms-client-principal': operatorHeader() }, planId: 'plan-1', action: 'verify-config' }), makeContext());
    expect(response.status).toBe(403);
    expect(submitFslogixConfigCheck).not.toHaveBeenCalled();
  });

  it('returns 409 (illegal state) from every state other than validating_new', async () => {
    getRolloutPlanEntity.mockResolvedValue(record({ state: 'awaiting_new_hosts' }));
    const response = await rolloutPlanActionHandler(makeRequest({ headers: { 'x-ms-client-principal': adminHeader() }, planId: 'plan-1', action: 'verify-config' }), makeContext());
    expect(response.status).toBe(409);
    expect(response.jsonBody).toMatchObject({ code: 'illegal_rollout_transition' });
    expect(submitFslogixConfigCheck).not.toHaveBeenCalled();
  });

  it('submits a config check for every new host, persisting in_progress per host, and audits it', async () => {
    getRolloutPlanEntity.mockResolvedValue(
      record({ state: 'validating_new', newHostsJson: JSON.stringify([newHost({ sessionHostName: 'avd-con-1' }), newHost({ sessionHostName: 'avd-con-2' })]) }),
    );
    resolveSessionHostVm.mockResolvedValue({ resourceGroup: 'RG-AVD-HostPools', vmName: 'avd-con-1', activeSessions: 0 });
    const response = await rolloutPlanActionHandler(makeRequest({ headers: { 'x-ms-client-principal': adminHeader() }, planId: 'plan-1', action: 'verify-config' }), makeContext());
    expect(response.status).toBe(200);
    expect(submitFslogixConfigCheck).toHaveBeenCalledTimes(2);
    const body = response.jsonBody as { plan: { newHosts: RolloutNewHost[] } };
    expect(body.plan.newHosts.every((h) => h.configCheck?.status === 'in_progress')).toBe(true);
    expect(body.plan.newHosts.every((h) => typeof h.configCheck?.submittedAt === 'string')).toBe(true);
    expect(writeAuditEntry).toHaveBeenCalledWith(expect.objectContaining({ action: 'rollout.verify_config', outcome: 'success' }), expect.anything());
  });

  it('isolates a per-host resolve/submit failure — the failing host gets configCheck status error, other hosts are unaffected', async () => {
    getRolloutPlanEntity.mockResolvedValue(
      record({ state: 'validating_new', newHostsJson: JSON.stringify([newHost({ sessionHostName: 'avd-con-1' }), newHost({ sessionHostName: 'avd-con-2' })]) }),
    );
    resolveSessionHostVm.mockImplementation(async (_hp: string, name: string) => {
      if (name === 'avd-con-2') throw new Error('ARM timeout');
      return { resourceGroup: 'RG-AVD-HostPools', vmName: name, activeSessions: 0 };
    });
    const response = await rolloutPlanActionHandler(makeRequest({ headers: { 'x-ms-client-principal': adminHeader() }, planId: 'plan-1', action: 'verify-config' }), makeContext());
    expect(response.status).toBe(200);
    const body = response.jsonBody as { plan: { newHosts: RolloutNewHost[] } };
    const host1 = body.plan.newHosts.find((h) => h.sessionHostName === 'avd-con-1')!;
    const host2 = body.plan.newHosts.find((h) => h.sessionHostName === 'avd-con-2')!;
    expect(host1.configCheck?.status).toBe('in_progress');
    expect(host2.configCheck?.status).toBe('error');
    expect(typeof host2.configCheck?.error).toBe('string');
    expect(host2.configCheck?.error).not.toContain('ARM timeout'); // raw ARM text never persisted (CWE-532 posture)
  });

  it('lazily backfills configBaselineJson from current config for a pre-AM-47 row that has none', async () => {
    getRolloutPlanEntity.mockResolvedValue(record({ state: 'validating_new', configBaselineJson: undefined }));
    resolveSessionHostVm.mockResolvedValue({ resourceGroup: 'RG-AVD-HostPools', vmName: 'avd-con-1', activeSessions: 0 });
    await rolloutPlanActionHandler(makeRequest({ headers: { 'x-ms-client-principal': adminHeader() }, planId: 'plan-1', action: 'verify-config' }), makeContext());
    const [, , , mutate] = persistWithMergeRetry.mock.calls[0] as [string, string, RolloutPlanRecord, (fresh: RolloutPlanEntity) => RolloutPlanEntity];
    const updated = mutate({ ...record(), configBaselineJson: undefined });
    expect(updated.configBaselineJson).toBeDefined();
    expect(JSON.parse(updated.configBaselineJson!)).toMatchObject({ Enabled: '1', VolumeType: 'VHDX', SizeInMBs: '30000', FlipFlopProfileDirectoryName: '1' });
  });

  it('does NOT overwrite an existing configBaselineJson on a plan that already has one', async () => {
    const existingBaseline = JSON.stringify({ Enabled: '1', VHDLocations: '\\\\custom\\share', VolumeType: 'VHDX', SizeInMBs: '99999', FlipFlopProfileDirectoryName: '1' });
    getRolloutPlanEntity.mockResolvedValue(record({ state: 'validating_new', configBaselineJson: existingBaseline }));
    resolveSessionHostVm.mockResolvedValue({ resourceGroup: 'RG-AVD-HostPools', vmName: 'avd-con-1', activeSessions: 0 });
    await rolloutPlanActionHandler(makeRequest({ headers: { 'x-ms-client-principal': adminHeader() }, planId: 'plan-1', action: 'verify-config' }), makeContext());
    const [, , , mutate] = persistWithMergeRetry.mock.calls[0] as [string, string, RolloutPlanRecord, (fresh: RolloutPlanEntity) => RolloutPlanEntity];
    const updated = mutate({ ...record(), configBaselineJson: existingBaseline });
    expect(updated.configBaselineJson).toBe(existingBaseline);
  });
});

describe('rolloutPlanActionHandler — remove-hosts: THE HARD ZERO-SESSIONS GATE', () => {
  it('refuses removal (per host) when the server-observed session count is nonzero, and does not call removeSessionHost/beginVmDelete for it', async () => {
    getRolloutPlanEntity.mockResolvedValue(record({ state: 'removing_old' }));
    resolveSessionHostVm.mockResolvedValue({ resourceGroup: 'RG-AVD-HostPools', vmName: 'avd-con-0', activeSessions: 2 });
    const response = await rolloutPlanActionHandler(
      makeRequest({ headers: { 'x-ms-client-principal': adminHeader() }, planId: 'plan-1', action: 'remove-hosts', body: { sessionHostNames: ['avd-con-0'], reason: 'decommission' } }),
      makeContext(),
    );
    expect(response.status).toBe(200);
    const body = response.jsonBody as { result: { failed: Array<{ sessionHostName: string; message: string }>; succeeded: string[] } };
    expect(body.result.succeeded).toEqual([]);
    expect(body.result.failed).toEqual([{ sessionHostName: 'avd-con-0', message: expect.stringContaining('2 active session') }]);
    expect(removeSessionHost).not.toHaveBeenCalled();
    expect(beginVmDelete).not.toHaveBeenCalled();
  });

  it('has NO force bypass for the hard gate — passing force:true in the body still refuses a host with active sessions', async () => {
    getRolloutPlanEntity.mockResolvedValue(record({ state: 'removing_old' }));
    resolveSessionHostVm.mockResolvedValue({ resourceGroup: 'RG-AVD-HostPools', vmName: 'avd-con-0', activeSessions: 1 });
    const response = await rolloutPlanActionHandler(
      makeRequest({
        headers: { 'x-ms-client-principal': adminHeader() },
        planId: 'plan-1',
        action: 'remove-hosts',
        body: { sessionHostNames: ['avd-con-0'], reason: 'decommission', force: true },
      }),
      makeContext(),
    );
    const body = response.jsonBody as { result: { succeeded: string[] } };
    expect(body.result.succeeded).toEqual([]);
    expect(removeSessionHost).not.toHaveBeenCalled();
  });

  it('removes a host with zero sessions: deregisters, deletes the VM (no deallocate — item 3), and marks it removed', async () => {
    getRolloutPlanEntity.mockResolvedValue(record({ state: 'removing_old' }));
    resolveSessionHostVm.mockResolvedValue({ resourceGroup: 'RG-AVD-HostPools', vmName: 'avd-con-0', activeSessions: 0 });
    const response = await rolloutPlanActionHandler(
      makeRequest({ headers: { 'x-ms-client-principal': adminHeader() }, planId: 'plan-1', action: 'remove-hosts', body: { sessionHostNames: ['avd-con-0'], reason: 'decommission' } }),
      makeContext(),
    );
    expect(response.status).toBe(200);
    expect(removeSessionHost).toHaveBeenCalledWith('HP-CONTOSO-PROD', 'avd-con-0', false);
    expect(beginVmDelete).toHaveBeenCalledWith('RG-AVD-HostPools', 'avd-con-0');
    const body = response.jsonBody as { plan: { oldHosts: RolloutOldHost[]; state: RolloutState }; result: { succeeded: string[] } };
    expect(body.result.succeeded).toEqual(['avd-con-0']);
    expect(body.plan.oldHosts[0]).toMatchObject({ status: 'removed', lastObservedSessions: 0 });
    expect(body.plan.state).toBe('done');
  });

  it('is idempotent for a host already marked removed in a prior batch — no re-resolve, no re-mutation, reported as succeeded', async () => {
    getRolloutPlanEntity.mockResolvedValue(record({ state: 'removing_old', oldHostsJson: JSON.stringify([oldHost({ status: 'removed', removedAt: '2026-08-16T09:00:00.000Z' })]) }));
    const response = await rolloutPlanActionHandler(
      makeRequest({ headers: { 'x-ms-client-principal': adminHeader() }, planId: 'plan-1', action: 'remove-hosts', body: { sessionHostNames: ['avd-con-0'], reason: 'retry' } }),
      makeContext(),
    );
    expect(response.status).toBe(200);
    expect(resolveSessionHostVm).not.toHaveBeenCalled();
    expect(removeSessionHost).not.toHaveBeenCalled();
    expect(beginVmDelete).not.toHaveBeenCalled();
    const body = response.jsonBody as { result: { succeeded: string[] } };
    expect(body.result.succeeded).toEqual(['avd-con-0']);
  });

  it('AM-28 peer review item 2 — RESUMABLE REMOVAL: a host with deregisteredAt + a cached target already recorded skips resolveSessionHostVm entirely and goes straight to VM delete', async () => {
    getRolloutPlanEntity.mockResolvedValue(
      record({
        state: 'removing_old',
        oldHostsJson: JSON.stringify([oldHost({ deregisteredAt: '2026-08-16T09:00:00.000Z', resourceGroup: 'RG-AVD-HostPools', vmName: 'avd-con-0' })]),
      }),
    );
    const response = await rolloutPlanActionHandler(
      makeRequest({ headers: { 'x-ms-client-principal': adminHeader() }, planId: 'plan-1', action: 'remove-hosts', body: { sessionHostNames: ['avd-con-0'], reason: 'resume' } }),
      makeContext(),
    );
    expect(response.status).toBe(200);
    expect(resolveSessionHostVm).not.toHaveBeenCalled(); // item 2: a 404 here (already deregistered) must never strand the host — so it's never even called.
    expect(removeSessionHost).not.toHaveBeenCalled(); // already deregistered — not re-attempted.
    expect(beginVmDelete).toHaveBeenCalledWith('RG-AVD-HostPools', 'avd-con-0');
    const body = response.jsonBody as { result: { succeeded: string[] } };
    expect(body.result.succeeded).toEqual(['avd-con-0']);
  });

  it('partial batch failure: one host with sessions fails, one with zero succeeds, response reports both distinctly', async () => {
    getRolloutPlanEntity.mockResolvedValue(
      record({ state: 'removing_old', oldHostsJson: JSON.stringify([oldHost({ sessionHostName: 'avd-con-0' }), oldHost({ sessionHostName: 'avd-con-2' })]) }),
    );
    resolveSessionHostVm.mockImplementation(async (_hp: string, name: string) =>
      name === 'avd-con-0' ? { resourceGroup: 'RG-AVD-HostPools', vmName: 'avd-con-0', activeSessions: 3 } : { resourceGroup: 'RG-AVD-HostPools', vmName: 'avd-con-2', activeSessions: 0 },
    );
    const response = await rolloutPlanActionHandler(
      makeRequest({
        headers: { 'x-ms-client-principal': adminHeader() },
        planId: 'plan-1',
        action: 'remove-hosts',
        body: { sessionHostNames: ['avd-con-0', 'avd-con-2'], reason: 'decommission' },
      }),
      makeContext(),
    );
    const body = response.jsonBody as { result: { succeeded: string[]; failed: Array<{ sessionHostName: string }> }; plan: { state: RolloutState } };
    expect(body.result.succeeded).toEqual(['avd-con-2']);
    expect(body.result.failed.map((f) => f.sessionHostName)).toEqual(['avd-con-0']);
    expect(body.plan.state).toBe('removing_old'); // not all removed yet
  });

  it("rejects a sessionHostName not part of this plan's old-host list", async () => {
    getRolloutPlanEntity.mockResolvedValue(record({ state: 'removing_old' }));
    const response = await rolloutPlanActionHandler(
      makeRequest({ headers: { 'x-ms-client-principal': adminHeader() }, planId: 'plan-1', action: 'remove-hosts', body: { sessionHostNames: ['avd-not-in-plan'], reason: 'x' } }),
      makeContext(),
    );
    expect(response.status).toBe(400);
    expect(resolveSessionHostVm).not.toHaveBeenCalled();
  });

  it('requires a mandatory reason', async () => {
    getRolloutPlanEntity.mockResolvedValue(record({ state: 'removing_old' }));
    const response = await rolloutPlanActionHandler(
      makeRequest({ headers: { 'x-ms-client-principal': adminHeader() }, planId: 'plan-1', action: 'remove-hosts', body: { sessionHostNames: ['avd-con-0'] } }),
      makeContext(),
    );
    expect(response.status).toBe(400);
  });

  it('regression (b): beginVmDelete rejecting AFTER removeSessionHost succeeded leaves the host deregistered-but-not-removed (resumable), not silently lost', async () => {
    getRolloutPlanEntity.mockResolvedValue(record({ state: 'removing_old' }));
    resolveSessionHostVm.mockResolvedValue({ resourceGroup: 'RG-AVD-HostPools', vmName: 'avd-con-0', activeSessions: 0 });
    removeSessionHost.mockResolvedValue(undefined);
    beginVmDelete.mockRejectedValue(new Error('ARM delete failed'));

    const response = await rolloutPlanActionHandler(
      makeRequest({ headers: { 'x-ms-client-principal': adminHeader() }, planId: 'plan-1', action: 'remove-hosts', body: { sessionHostNames: ['avd-con-0'], reason: 'decommission' } }),
      makeContext(),
    );

    expect(response.status).toBe(200);
    expect(removeSessionHost).toHaveBeenCalledTimes(1);
    expect(beginVmDelete).toHaveBeenCalledTimes(1);
    const body = response.jsonBody as { plan: { oldHosts: RolloutOldHost[] }; result: { succeeded: string[]; failed: Array<{ sessionHostName: string }> } };
    expect(body.result.succeeded).toEqual([]);
    expect(body.result.failed.map((f) => f.sessionHostName)).toEqual(['avd-con-0']);
    // The host must carry deregisteredAt (checkpointed BEFORE the failed delete) so a retry resumes at VM deletion, never re-deregisters or strands it.
    const host = body.plan.oldHosts.find((h) => h.sessionHostName === 'avd-con-0')!;
    expect(host.deregisteredAt).toBeDefined();
    expect(host.status).not.toBe('removed');
  });

  it('BLOCKER regression (a): audit is written even if the FINAL state write is ultimately exhausted (persistWithMergeRetry rejects) after successful ARM removals', async () => {
    getRolloutPlanEntity.mockResolvedValue(record({ state: 'removing_old' }));
    resolveSessionHostVm.mockResolvedValue({ resourceGroup: 'RG-AVD-HostPools', vmName: 'avd-con-0', activeSessions: 0 });
    // Checkpoint writes (resourceGroup/vmName, then deregisteredAt) succeed via the default mock;
    // only the FINAL write (after removeSessionHost + beginVmDelete both succeeded) is made to fail —
    // simulated by rejecting every persistWithMergeRetry call whose mutate() output would mark the host 'removed'.
    persistWithMergeRetry.mockImplementation(async (hostPoolName: string, planId: string, startingRecord: RolloutPlanRecord, mutate: (fresh: RolloutPlanEntity) => RolloutPlanEntity) => {
      const { etag: _etag, ...base } = startingRecord;
      void _etag;
      const result = mutate(base);
      const hosts = JSON.parse(result.oldHostsJson) as RolloutOldHost[];
      if (hosts.some((h) => h.status === 'removed')) {
        throw new Error('PreconditionFailed after 3 retries');
      }
      return result;
    });

    const response = await rolloutPlanActionHandler(
      makeRequest({ headers: { 'x-ms-client-principal': adminHeader() }, planId: 'plan-1', action: 'remove-hosts', body: { sessionHostNames: ['avd-con-0'], reason: 'decommission' } }),
      makeContext(),
    );

    expect(response.status).toBe(502);
    expect(response.jsonBody).toMatchObject({ code: 'rollout_remove_hosts_state_write_failed' });
    expect((response.jsonBody as { message: string }).message).toMatch(/submitted to Azure and audited/i);
    // ARM ground truth: the removal actually happened.
    expect(removeSessionHost).toHaveBeenCalledWith('HP-CONTOSO-PROD', 'avd-con-0', false);
    expect(beginVmDelete).toHaveBeenCalledWith('RG-AVD-HostPools', 'avd-con-0');
    // The audit row recording that success must still have been written, BEFORE the failed final write.
    expect(writeAuditEntry).toHaveBeenCalledWith(expect.objectContaining({ action: 'rollout.remove_hosts', outcome: 'success' }), expect.anything());
  });
});

describe('rolloutPlanActionHandler — rollback from each pre-removal state (BLOCKER audit-before-write + item 5 drains new hosts)', () => {
  it.each<RolloutState>(['draining_old', 'awaiting_new_hosts', 'validating_new', 'cutover'])(
    'rolls back from %s: un-drains the old host, drains any registered new host, and audits BEFORE the write',
    async (fromState) => {
      getRolloutPlanEntity.mockResolvedValue(
        record({ state: fromState, oldHostsJson: JSON.stringify([oldHost({ status: 'draining' })]), newHostsJson: JSON.stringify([newHost({ status: 'available', healthy: true })]) }),
      );
      setSessionHostDrain.mockResolvedValue({});
      const callOrder: string[] = [];
      writeAuditEntry.mockImplementation(async () => {
        callOrder.push('audit');
      });
      persistWithMergeRetry.mockImplementation(async (...args: Parameters<typeof defaultMergeRetry>) => {
        callOrder.push('write');
        return defaultMergeRetry(...args);
      });

      const response = await rolloutPlanActionHandler(
        makeRequest({ headers: { 'x-ms-client-principal': adminHeader() }, planId: 'plan-1', action: 'rollback', body: { reason: 'vNext failed smoke test' } }),
        makeContext(),
      );

      expect(response.status).toBe(200);
      expect(setSessionHostDrain).toHaveBeenCalledWith('HP-CONTOSO-PROD', 'avd-con-0', true); // old host un-drained
      expect(setSessionHostDrain).toHaveBeenCalledWith('HP-CONTOSO-PROD', 'avd-con-1', false); // item 5: new host drained
      expect(callOrder).toEqual(['audit', 'write']);
      const [, , , mutate] = persistWithMergeRetry.mock.calls[0] as [string, string, RolloutPlanRecord, (fresh: RolloutPlanEntity) => RolloutPlanEntity];
      const updated = mutate({ ...record(), state: fromState });
      expect(updated.state).toBe('rolled_back');
      expect(JSON.parse(updated.oldHostsJson)).toEqual([{ ...oldHost({ status: 'draining' }), status: 'undrained_rollback' }]);
      expect(updated.rollbackDrainedNewHostsJson).toBeDefined();
      expect(JSON.parse(updated.rollbackDrainedNewHostsJson!)).toEqual(['avd-con-1']);
      expect(deleteActiveSentinel).toHaveBeenCalledWith('HP-CONTOSO-PROD');
    },
  );

  it('post-removal rollback (from removing_old): does NOT un-drain an already-removed host and instead lists it in rollbackNeedsReadd', async () => {
    getRolloutPlanEntity.mockResolvedValue(
      record({
        state: 'removing_old',
        oldHostsJson: JSON.stringify([oldHost({ sessionHostName: 'avd-con-0', status: 'removed' }), oldHost({ sessionHostName: 'avd-con-2', status: 'draining' })]),
        newHostsJson: JSON.stringify([]),
      }),
    );
    setSessionHostDrain.mockResolvedValue({});
    const response = await rolloutPlanActionHandler(
      makeRequest({ headers: { 'x-ms-client-principal': adminHeader() }, planId: 'plan-1', action: 'rollback', body: { reason: 'stop the rollout' } }),
      makeContext(),
    );
    expect(response.status).toBe(200);
    expect(setSessionHostDrain).toHaveBeenCalledTimes(1);
    expect(setSessionHostDrain).toHaveBeenCalledWith('HP-CONTOSO-PROD', 'avd-con-2', true);
    const [, , , mutate] = persistWithMergeRetry.mock.calls[0] as [string, string, RolloutPlanRecord, (fresh: RolloutPlanEntity) => RolloutPlanEntity];
    const updated = mutate({ ...record(), state: 'removing_old' });
    expect(JSON.parse(updated.rollbackNeedsReaddJson!)).toEqual(['avd-con-0']);
  });

  it('records rollbackUndrainFailures durably (not just in the audit detail) when un-draining a host fails', async () => {
    getRolloutPlanEntity.mockResolvedValue(record({ state: 'draining_old', oldHostsJson: JSON.stringify([oldHost()]), newHostsJson: JSON.stringify([]) }));
    setSessionHostDrain.mockRejectedValue(new Error('ARM error'));
    const response = await rolloutPlanActionHandler(
      makeRequest({ headers: { 'x-ms-client-principal': adminHeader() }, planId: 'plan-1', action: 'rollback', body: { reason: 'x' } }),
      makeContext(),
    );
    expect(response.status).toBe(200); // un-drain failure does not block the rollback itself
    const body = response.jsonBody as { plan: { rollbackUndrainFailures?: string[] } };
    expect(body.plan.rollbackUndrainFailures).toEqual(['avd-con-0']);
  });

  it('requires a mandatory reason', async () => {
    getRolloutPlanEntity.mockResolvedValue(record({ state: 'draining_old' }));
    const response = await rolloutPlanActionHandler(makeRequest({ headers: { 'x-ms-client-principal': adminHeader() }, planId: 'plan-1', action: 'rollback', body: {} }), makeContext());
    expect(response.status).toBe(400);
    expect(persistWithMergeRetry).not.toHaveBeenCalled();
  });

  it('is illegal from a terminal state (done)', async () => {
    getRolloutPlanEntity.mockResolvedValue(record({ state: 'done' }));
    const response = await rolloutPlanActionHandler(
      makeRequest({ headers: { 'x-ms-client-principal': adminHeader() }, planId: 'plan-1', action: 'rollback', body: { reason: 'x' } }),
      makeContext(),
    );
    expect(response.status).toBe(409);
  });
});

describe('rolloutPlanActionHandler — cancel', () => {
  it('cancels a planned plan with no host mutation and cleans up the sentinel', async () => {
    getRolloutPlanEntity.mockResolvedValue(record({ state: 'planned' }));
    const response = await rolloutPlanActionHandler(makeRequest({ headers: { 'x-ms-client-principal': adminHeader() }, planId: 'plan-1', action: 'cancel', body: {} }), makeContext());
    expect(response.status).toBe(200);
    expect(setSessionHostDrain).not.toHaveBeenCalled();
    const [, , , mutate] = persistWithMergeRetry.mock.calls[0] as [string, string, RolloutPlanRecord, (fresh: RolloutPlanEntity) => RolloutPlanEntity];
    const updated = mutate({ ...record(), state: 'planned' });
    expect(updated.state).toBe('cancelled');
    expect(deleteActiveSentinel).toHaveBeenCalledWith('HP-CONTOSO-PROD');
  });
});

describe('rolloutPlanActionHandler — auth', () => {
  it('returns 401 for an unauthenticated caller and never reads the plan', async () => {
    const response = await rolloutPlanActionHandler(makeRequest({ planId: 'plan-1', action: 'start' }), makeContext());
    expect(response.status).toBe(401);
    expect(getRolloutPlanEntity).not.toHaveBeenCalled();
  });

  it('returns 404 when the plan does not exist', async () => {
    getRolloutPlanEntity.mockResolvedValue(null);
    const response = await rolloutPlanActionHandler(makeRequest({ headers: { 'x-ms-client-principal': adminHeader() }, planId: 'nope', action: 'start' }), makeContext());
    expect(response.status).toBe(404);
  });
});

describe('listRolloutPlans', () => {
  it('returns the projected plan list', async () => {
    listRolloutPlanEntitiesWithTruncation.mockResolvedValue({ entities: [record({ rowKey: 'plan-1' }), record({ rowKey: 'plan-2' })], truncated: false });
    const response = await listRolloutPlans(makeRequest({ headers: { 'x-ms-client-principal': adminHeader() }, method: 'GET' }), makeContext());
    expect(response.status).toBe(200);
    const body = response.jsonBody as { plans: Array<{ id: string }>; truncated: boolean };
    expect(body.plans.map((p) => p.id)).toEqual(['plan-1', 'plan-2']);
    expect(body.truncated).toBe(false);
  });

  it('surfaces truncated: true when the server-side history cap was hit (AM-15 sweep)', async () => {
    listRolloutPlanEntitiesWithTruncation.mockResolvedValue({ entities: [record({ rowKey: 'plan-1' })], truncated: true });
    const response = await listRolloutPlans(makeRequest({ headers: { 'x-ms-client-principal': adminHeader() }, method: 'GET' }), makeContext());
    expect(response.status).toBe(200);
    const body = response.jsonBody as { truncated: boolean };
    expect(body.truncated).toBe(true);
  });
});
