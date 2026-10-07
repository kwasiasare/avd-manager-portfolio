import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ImageBuildEntity } from './imageBuildService';

const getEntity = vi.fn();
const createEntity = vi.fn();
const updateEntity = vi.fn();
const listEntitiesResults: ImageBuildEntity[] = [];
// `odata` is the REAL implementation (vi.importActual) — same convention as
// auditLog.test.ts — so listInFlightImageBuilds' server-side filter string
// is real, not a stub.
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
    // Minimal async-iterable stub mirroring @azure/data-tables'
    // PagedAsyncIterableIterator — ALSO simulates the server-side `state ne
    // 'x'` OData clauses listInFlightImageBuilds' real filter produces (via
    // the REAL `odata` tag above), so this test actually exercises the
    // server-side filtering the fix introduced rather than always returning
    // every row regardless of what filter string was built.
    const filter = options?.queryOptions?.filter ?? '';
    const excluded = new Set([...filter.matchAll(/state ne '([^']+)'/g)].map((m) => m[1]));
    const filtered = listEntitiesResults.filter((e) => !excluded.has(e.state));
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

function entity(overrides: Partial<ImageBuildEntity> = {}): ImageBuildEntity {
  return {
    partitionKey: 'build',
    rowKey: 'build-1',
    buildId: 'build-1',
    version: '2.1.0',
    state: 'planned',
    createdAt: '2026-08-16T00:00:00.000Z',
    updatedAt: '2026-08-16T00:00:00.000Z',
    createdBy: 'admin@example.com',
    createdById: 'entra-obj-1',
    vmName: 'VM-IMG-AAAAAAAA',
    nicName: 'NIC-VM-IMG-AAAAAAAA',
    diskName: 'OSDISK-VM-IMG-AAAAAAAA',
    snapshotName: 'SNAP-WIN11-PRE-SYSPREP-2.1.0',
    checklistJson: '{}',
    stepsJson: '[]',
    planParamsJson: '{"version":"2.1.0","adminUsername":"ca.builder"}',
    correlationId: 'corr-1',
    ...overrides,
  };
}

describe('createImageBuild / getImageBuild / replaceImageBuild — ETag concurrency', () => {
  it('createImageBuild throws isConflictError-recognizable on a 409 (duplicate buildId)', async () => {
    const { createImageBuild, isConflictError } = await import('./imageBuildService');
    createEntity.mockRejectedValueOnce(Object.assign(new Error('conflict'), { statusCode: 409 }));
    await expect(createImageBuild(entity())).rejects.toMatchObject({ statusCode: 409 });
    expect(isConflictError({ statusCode: 409 })).toBe(true);
  });

  it('getImageBuild returns null (not throw) on a 404', async () => {
    const { getImageBuild } = await import('./imageBuildService');
    getEntity.mockRejectedValueOnce(Object.assign(new Error('not found'), { statusCode: 404 }));
    await expect(getImageBuild('missing')).resolves.toBeNull();
  });

  it('getImageBuild propagates a non-404 error', async () => {
    const { getImageBuild } = await import('./imageBuildService');
    getEntity.mockRejectedValueOnce(Object.assign(new Error('boom'), { statusCode: 500 }));
    await expect(getImageBuild('build-1')).rejects.toMatchObject({ statusCode: 500 });
  });

  it('replaceImageBuild passes the etag through as an If-Match precondition, and surfaces a 412 as isPreconditionFailedError', async () => {
    const { replaceImageBuild, isPreconditionFailedError } = await import('./imageBuildService');
    updateEntity.mockRejectedValueOnce(Object.assign(new Error('precondition failed'), { statusCode: 412 }));
    await expect(replaceImageBuild(entity(), 'W/"stale-etag"')).rejects.toMatchObject({ statusCode: 412 });
    expect(updateEntity).toHaveBeenCalledWith(expect.objectContaining({ partitionKey: 'build', rowKey: 'build-1' }), 'Replace', { etag: 'W/"stale-etag"' });
    expect(isPreconditionFailedError({ statusCode: 412 })).toBe(true);
  });

  it('createImageBuild/replaceImageBuild throw a clear error when the table is unconfigured (no AUDIT_STORAGE_ACCOUNT_NAME)', async () => {
    delete process.env.AUDIT_STORAGE_ACCOUNT_NAME;
    const { createImageBuild, replaceImageBuild } = await import('./imageBuildService');
    await expect(createImageBuild(entity())).rejects.toThrow(/not configured/i);
    await expect(replaceImageBuild(entity(), 'etag')).rejects.toThrow(/not configured/i);
  });

  it('getImageBuild/listImageBuilds return null/[] (not throw) when unconfigured — local dev posture', async () => {
    delete process.env.AUDIT_STORAGE_ACCOUNT_NAME;
    const { getImageBuild, listImageBuilds } = await import('./imageBuildService');
    await expect(getImageBuild('x')).resolves.toBeNull();
    await expect(listImageBuilds()).resolves.toEqual([]);
  });
});

describe('isImageBuildStoreRequiredButMissing — fail-closed posture', () => {
  it('is false locally (no WEBSITE_SITE_NAME) even if unconfigured', async () => {
    delete process.env.AUDIT_STORAGE_ACCOUNT_NAME;
    delete process.env.WEBSITE_SITE_NAME;
    const { isImageBuildStoreRequiredButMissing } = await import('./imageBuildService');
    expect(isImageBuildStoreRequiredButMissing()).toBe(false);
  });

  it('is true when deployed (WEBSITE_SITE_NAME set) and unconfigured — refuse to start a build', async () => {
    delete process.env.AUDIT_STORAGE_ACCOUNT_NAME;
    process.env.WEBSITE_SITE_NAME = 'func-example-prod';
    const { isImageBuildStoreRequiredButMissing } = await import('./imageBuildService');
    expect(isImageBuildStoreRequiredButMissing()).toBe(true);
  });
});

describe('listImageBuilds — newest first', () => {
  it('sorts by createdAt descending', async () => {
    listEntitiesResults.push(entity({ buildId: 'old', rowKey: 'old', createdAt: '2026-01-01T00:00:00.000Z' }));
    listEntitiesResults.push(entity({ buildId: 'newest', rowKey: 'newest', createdAt: '2026-08-16T00:00:00.000Z' }));
    listEntitiesResults.push(entity({ buildId: 'middle', rowKey: 'middle', createdAt: '2026-05-01T00:00:00.000Z' }));
    const { listImageBuilds } = await import('./imageBuildService');
    const results = await listImageBuilds();
    expect(results.map((r) => r.buildId)).toEqual(['newest', 'middle', 'old']);
  });
});

describe('listInFlightImageBuilds', () => {
  it('excludes done/failed/cancelled', async () => {
    listEntitiesResults.push(entity({ buildId: 'a', rowKey: 'a', state: 'vm_creating', createdAt: '2026-08-16T00:00:00.000Z' }));
    listEntitiesResults.push(entity({ buildId: 'b', rowKey: 'b', state: 'done', createdAt: '2026-08-15T00:00:00.000Z' }));
    listEntitiesResults.push(entity({ buildId: 'c', rowKey: 'c', state: 'failed', createdAt: '2026-08-14T00:00:00.000Z' }));
    listEntitiesResults.push(entity({ buildId: 'd', rowKey: 'd', state: 'cancelled', createdAt: '2026-08-13T00:00:00.000Z' }));
    listEntitiesResults.push(entity({ buildId: 'e', rowKey: 'e', state: 'checklist_gate', createdAt: '2026-08-12T00:00:00.000Z' }));
    const { listInFlightImageBuilds } = await import('./imageBuildService');
    const results = await listInFlightImageBuilds();
    expect(results.map((r) => r.buildId).sort()).toEqual(['a', 'e']);
  });
});

describe('toDetail / toSummary — pure projections', () => {
  it('parses checklistJson and stepsJson back into objects', async () => {
    const { toDetail } = await import('./imageBuildService');
    const detail = toDetail(
      entity({
        checklistJson: JSON.stringify({ windows_updates: true }),
        stepsJson: JSON.stringify([{ stepId: 'create_build_vm', status: 'succeeded' }]),
      }),
    );
    expect(detail.checklist.windows_updates).toBe(true);
    expect(detail.steps).toEqual([{ stepId: 'create_build_vm', status: 'succeeded' }]);
  });

  it('falls back to an empty checklist / empty steps on corrupt JSON, rather than throwing', async () => {
    const { toDetail } = await import('./imageBuildService');
    const detail = toDetail(entity({ checklistJson: '{not json', stepsJson: '[not json' }));
    expect(detail.checklist).toBeTruthy();
    expect(Object.values(detail.checklist).every((v) => v === false)).toBe(true);
    expect(detail.steps).toEqual([]);
  });

  it('toSummary omits the detail-only fields', async () => {
    const { toSummary } = await import('./imageBuildService');
    const summary = toSummary(entity());
    expect(summary).toEqual({ buildId: 'build-1', version: '2.1.0', state: 'planned', createdAt: '2026-08-16T00:00:00.000Z', updatedAt: '2026-08-16T00:00:00.000Z', createdBy: 'admin@example.com' });
  });
});
