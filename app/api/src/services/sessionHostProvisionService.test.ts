import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionHostProvisionEntity } from './sessionHostProvisionService';

const getEntity = vi.fn();
const createEntity = vi.fn();
const updateEntity = vi.fn();
const listEntitiesResults: SessionHostProvisionEntity[] = [];
// `odata` is the REAL implementation (vi.importActual) — same convention as
// imageBuildService.test.ts — so the server-side filters are real, not stubs.
vi.mock('@azure/data-tables', async () => {
  const actual = await vi.importActual<typeof import('@azure/data-tables')>('@azure/data-tables');
  return { odata: actual.odata, TableClient: MockTableClient };
});
class MockTableClient {
  getEntity(...args: unknown[]) {
    return getEntity(...args);
  }
  createEntity(...args: unknown[]) {
    return createEntity(...args);
  }
  updateEntity(...args: unknown[]) {
    return updateEntity(...args);
  }
  listEntities(options?: { queryOptions?: { filter?: string } }) {
    const filter = options?.queryOptions?.filter ?? '';
    const excludedStates = new Set([...filter.matchAll(/state ne '([^']+)'/g)].map((m) => m[1]));
    const hostPoolMatch = /hostPoolName eq '([^']+)'/.exec(filter);
    const nameMatch = /and sessionHostName eq '([^']+)'/.exec(filter);
    let filtered = listEntitiesResults.filter((e) => !excludedStates.has(e.state));
    if (hostPoolMatch) filtered = filtered.filter((e) => e.hostPoolName === hostPoolMatch[1]);
    if (nameMatch) filtered = filtered.filter((e) => e.sessionHostName === nameMatch[1]);
    return {
      [Symbol.asyncIterator]: async function* () {
        for (const e of filtered) yield e;
      },
    };
  }
}
vi.mock('@azure/identity', () => ({ DefaultAzureCredential: vi.fn() }));

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  delete process.env.WEBSITE_SITE_NAME;
  process.env.AUDIT_STORAGE_ACCOUNT_NAME = 'stfuncavdmgr';
  process.env.SUBSCRIPTION_ID = 'sub-id';
  process.env.RG_HOSTPOOLS = 'RG-AVD-HostPools';
  process.env.HOSTPOOL_NAME = 'HP-CONTOSO-PROD';
  getEntity.mockReset();
  createEntity.mockReset();
  updateEntity.mockReset();
  listEntitiesResults.length = 0;
  vi.resetModules();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

function entity(overrides: Partial<SessionHostProvisionEntity> = {}): SessionHostProvisionEntity {
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
    createdById: 'entra-obj-1',
    vmName: 'avd-con-4',
    nicName: 'NIC-avd-con-4',
    stepsJson: '[]',
    planParamsJson: '{"sessionHostName":"avd-con-4","zone":"2","imageVersion":"2.2.0"}',
    planContextJson: '{}',
    correlationId: 'corr-1',
    ...overrides,
  };
}

describe('createSessionHostProvision / getSessionHostProvision / replaceSessionHostProvision — ETag concurrency', () => {
  it('createSessionHostProvision throws isConflictError-recognizable on a 409 (duplicate provisionId)', async () => {
    const { createSessionHostProvision, isConflictError } = await import('./sessionHostProvisionService');
    createEntity.mockRejectedValueOnce(Object.assign(new Error('conflict'), { statusCode: 409 }));
    await expect(createSessionHostProvision(entity())).rejects.toMatchObject({ statusCode: 409 });
    expect(isConflictError({ statusCode: 409 })).toBe(true);
  });

  it('getSessionHostProvision returns null (not throw) on a 404', async () => {
    const { getSessionHostProvision } = await import('./sessionHostProvisionService');
    getEntity.mockRejectedValueOnce(Object.assign(new Error('not found'), { statusCode: 404 }));
    await expect(getSessionHostProvision('missing')).resolves.toBeNull();
  });

  it('getSessionHostProvision propagates a non-404 error', async () => {
    const { getSessionHostProvision } = await import('./sessionHostProvisionService');
    getEntity.mockRejectedValueOnce(Object.assign(new Error('boom'), { statusCode: 500 }));
    await expect(getSessionHostProvision('provision-1')).rejects.toMatchObject({ statusCode: 500 });
  });

  it('replaceSessionHostProvision passes the etag through as an If-Match precondition, and surfaces a 412 as isPreconditionFailedError', async () => {
    const { replaceSessionHostProvision, isPreconditionFailedError } = await import('./sessionHostProvisionService');
    updateEntity.mockRejectedValueOnce(Object.assign(new Error('precondition failed'), { statusCode: 412 }));
    await expect(replaceSessionHostProvision(entity(), 'W/"stale-etag"')).rejects.toMatchObject({ statusCode: 412 });
    expect(updateEntity).toHaveBeenCalledWith(expect.objectContaining({ partitionKey: 'provision', rowKey: 'provision-1' }), 'Replace', { etag: 'W/"stale-etag"' });
    expect(isPreconditionFailedError({ statusCode: 412 })).toBe(true);
  });

  it('createSessionHostProvision/replaceSessionHostProvision throw a clear error when the table is unconfigured (no AUDIT_STORAGE_ACCOUNT_NAME)', async () => {
    delete process.env.AUDIT_STORAGE_ACCOUNT_NAME;
    const { createSessionHostProvision, replaceSessionHostProvision } = await import('./sessionHostProvisionService');
    await expect(createSessionHostProvision(entity())).rejects.toThrow(/not configured/i);
    await expect(replaceSessionHostProvision(entity(), 'etag')).rejects.toThrow(/not configured/i);
  });

  it('getSessionHostProvision/listSessionHostProvisions return null/[] (not throw) when unconfigured — local dev posture', async () => {
    delete process.env.AUDIT_STORAGE_ACCOUNT_NAME;
    const { getSessionHostProvision, listSessionHostProvisions } = await import('./sessionHostProvisionService');
    await expect(getSessionHostProvision('x')).resolves.toBeNull();
    await expect(listSessionHostProvisions('HP-CONTOSO-PROD')).resolves.toEqual([]);
  });
});

describe('isProvisionStoreRequiredButMissing — fail-closed posture', () => {
  it('is false locally (no WEBSITE_SITE_NAME) even if unconfigured', async () => {
    delete process.env.AUDIT_STORAGE_ACCOUNT_NAME;
    delete process.env.WEBSITE_SITE_NAME;
    const { isProvisionStoreRequiredButMissing } = await import('./sessionHostProvisionService');
    expect(isProvisionStoreRequiredButMissing()).toBe(false);
  });

  it('is true when deployed (WEBSITE_SITE_NAME set) and unconfigured — refuse to start a provision', async () => {
    delete process.env.AUDIT_STORAGE_ACCOUNT_NAME;
    process.env.WEBSITE_SITE_NAME = 'func-example-prod';
    const { isProvisionStoreRequiredButMissing } = await import('./sessionHostProvisionService');
    expect(isProvisionStoreRequiredButMissing()).toBe(true);
  });
});

describe('listSessionHostProvisions — scoped to hostPoolName, newest first', () => {
  it('sorts by createdAt descending and excludes rows for a different host pool', async () => {
    listEntitiesResults.push(entity({ provisionId: 'old', rowKey: 'old', createdAt: '2026-01-01T00:00:00.000Z' }));
    listEntitiesResults.push(entity({ provisionId: 'newest', rowKey: 'newest', createdAt: '2026-08-23T00:00:00.000Z' }));
    listEntitiesResults.push(entity({ provisionId: 'other-pool', rowKey: 'other-pool', hostPoolName: 'HP-OTHER', createdAt: '2026-08-24T00:00:00.000Z' }));
    const { listSessionHostProvisions } = await import('./sessionHostProvisionService');
    const results = await listSessionHostProvisions('HP-CONTOSO-PROD');
    expect(results.map((r) => r.provisionId)).toEqual(['newest', 'old']);
  });
});

describe('listInFlightSessionHostProvisions', () => {
  it('excludes done/failed/cancelled', async () => {
    listEntitiesResults.push(entity({ provisionId: 'a', rowKey: 'a', state: 'vm_creating', createdAt: '2026-08-23T00:00:00.000Z' }));
    listEntitiesResults.push(entity({ provisionId: 'b', rowKey: 'b', state: 'done', createdAt: '2026-08-22T00:00:00.000Z' }));
    listEntitiesResults.push(entity({ provisionId: 'c', rowKey: 'c', state: 'failed', createdAt: '2026-08-21T00:00:00.000Z' }));
    listEntitiesResults.push(entity({ provisionId: 'd', rowKey: 'd', state: 'cancelled', createdAt: '2026-08-20T00:00:00.000Z' }));
    listEntitiesResults.push(entity({ provisionId: 'e', rowKey: 'e', state: 'awaiting_registration', createdAt: '2026-08-19T00:00:00.000Z' }));
    const { listInFlightSessionHostProvisions } = await import('./sessionHostProvisionService');
    const results = await listInFlightSessionHostProvisions();
    expect(results.map((r) => r.provisionId).sort()).toEqual(['a', 'e']);
  });
});

describe('listInFlightSessionHostProvisionsForName — scoped to ONE session host name (not global one-at-a-time)', () => {
  it('only returns non-terminal rows matching BOTH hostPoolName and sessionHostName', async () => {
    listEntitiesResults.push(entity({ provisionId: 'match', rowKey: 'match', sessionHostName: 'avd-con-4', state: 'vm_creating' }));
    listEntitiesResults.push(entity({ provisionId: 'other-name', rowKey: 'other-name', sessionHostName: 'avd-con-5', state: 'vm_creating' }));
    listEntitiesResults.push(entity({ provisionId: 'terminal', rowKey: 'terminal', sessionHostName: 'avd-con-4', state: 'done' }));
    const { listInFlightSessionHostProvisionsForName } = await import('./sessionHostProvisionService');
    const results = await listInFlightSessionHostProvisionsForName('HP-CONTOSO-PROD', 'avd-con-4');
    expect(results.map((r) => r.provisionId)).toEqual(['match']);
  });
});

describe('toDetail / toSummary — pure projections', () => {
  it('parses stepsJson back into an array', async () => {
    const { toDetail } = await import('./sessionHostProvisionService');
    const detail = toDetail(entity({ stepsJson: JSON.stringify([{ stepId: 'create_vm', status: 'succeeded' }]) }));
    expect(detail.steps).toEqual([{ stepId: 'create_vm', status: 'succeeded' }]);
  });

  it('falls back to empty steps on corrupt JSON, rather than throwing', async () => {
    const { toDetail } = await import('./sessionHostProvisionService');
    const detail = toDetail(entity({ stepsJson: '[not json' }));
    expect(detail.steps).toEqual([]);
  });

  it('toSummary omits the detail-only fields', async () => {
    const { toSummary } = await import('./sessionHostProvisionService');
    const summary = toSummary(entity());
    expect(summary).toEqual({
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
    });
  });
});
