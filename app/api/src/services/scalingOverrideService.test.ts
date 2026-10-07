import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScalingOverrideEntity } from './scalingOverrideService';

const getEntity = vi.fn();
const createEntity = vi.fn();
const updateEntity = vi.fn();
vi.mock('@azure/data-tables', () => ({
  TableClient: class {
    getEntity(...args: unknown[]) {
      return getEntity(...args);
    }
    createEntity(...args: unknown[]) {
      return createEntity(...args);
    }
    updateEntity(...args: unknown[]) {
      return updateEntity(...args);
    }
  },
}));
vi.mock('@azure/identity', () => ({ DefaultAzureCredential: vi.fn() }));

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  delete process.env.AUDIT_STORAGE_ACCOUNT_NAME;
  delete process.env.WEBSITE_SITE_NAME;
  process.env.SUBSCRIPTION_ID = 'sub-id';
  process.env.RG_HOSTPOOLS = 'RG-AVD-HostPools';
  process.env.HOSTPOOL_NAME = 'HP-CONTOSO-PROD';
  getEntity.mockReset();
  createEntity.mockReset();
  updateEntity.mockReset();
  vi.resetModules();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

function entity(overrides: Partial<ScalingOverrideEntity> = {}): ScalingOverrideEntity {
  return {
    partitionKey: 'override',
    rowKey: 'current',
    active: true,
    activatedBy: 'op@example.com',
    activatedById: 'entra-obj-1',
    activatedAt: '2026-08-15T12:00:00.000Z',
    expiresAt: '2026-08-15T13:00:00.000Z',
    minutes: 60,
    reason: 'planned maintenance window',
    scalingPlanName: 'SCALE-CONTOSO-PROD',
    resourceGroup: 'RG-AVD-HostPools',
    hostPoolId: '/subscriptions/sub/resourceGroups/RG-AVD-HostPools/providers/Microsoft.DesktopVirtualization/hostPools/HP-CONTOSO-PROD',
    correlationId: 'corr-1',
    ...overrides,
  };
}

describe('computeOverrideStatus', () => {
  it('reports inactive for a null entity', async () => {
    const { computeOverrideStatus } = await import('./scalingOverrideService');
    expect(computeOverrideStatus(null)).toEqual({ active: false });
  });

  it('reports inactive when the entity exists but active is false, even with a future expiresAt', async () => {
    const { computeOverrideStatus } = await import('./scalingOverrideService');
    expect(computeOverrideStatus(entity({ active: false, expiresAt: '2099-01-01T00:00:00.000Z' }))).toEqual({ active: false });
  });

  it('reports active with fields + minutesRemaining when active and not yet expired', async () => {
    const { computeOverrideStatus } = await import('./scalingOverrideService');
    const now = new Date('2026-08-15T12:30:00.000Z'); // 30 min into a 60-min window, expires 13:00
    const status = computeOverrideStatus(entity(), now);
    expect(status).toEqual({
      active: true,
      activatedBy: 'op@example.com',
      activatedAt: '2026-08-15T12:00:00.000Z',
      expiresAt: '2026-08-15T13:00:00.000Z',
      minutesRemaining: 30,
      minutes: 60,
      reason: 'planned maintenance window',
    });
  });

  it('clamps minutesRemaining to 0, never negative, once expiresAt is in the past (timer has not run yet)', async () => {
    const { computeOverrideStatus } = await import('./scalingOverrideService');
    const now = new Date('2026-08-15T14:00:00.000Z'); // 1 hour past expiresAt
    const status = computeOverrideStatus(entity(), now);
    expect(status.active).toBe(true);
    expect(status.minutesRemaining).toBe(0);
  });
});

describe('isOverrideExpired', () => {
  it('is false for a null entity', async () => {
    const { isOverrideExpired } = await import('./scalingOverrideService');
    expect(isOverrideExpired(null)).toBe(false);
  });

  it('is false for an inactive entity, even with a past expiresAt', async () => {
    const { isOverrideExpired } = await import('./scalingOverrideService');
    expect(isOverrideExpired(entity({ active: false, expiresAt: '2000-01-01T00:00:00.000Z' }))).toBe(false);
  });

  it('is false for an active entity whose expiresAt is still in the future', async () => {
    const { isOverrideExpired } = await import('./scalingOverrideService');
    const now = new Date('2026-08-15T12:30:00.000Z');
    expect(isOverrideExpired(entity(), now)).toBe(false);
  });

  it('is true for an active entity whose expiresAt has passed', async () => {
    const { isOverrideExpired } = await import('./scalingOverrideService');
    const now = new Date('2026-08-15T13:00:01.000Z');
    expect(isOverrideExpired(entity(), now)).toBe(true);
  });

  it('is true exactly AT expiresAt (inclusive boundary)', async () => {
    const { isOverrideExpired } = await import('./scalingOverrideService');
    const now = new Date('2026-08-15T13:00:00.000Z');
    expect(isOverrideExpired(entity(), now)).toBe(true);
  });
});

describe('getScalingOverride — unconfigured', () => {
  it('returns null without calling getEntity', async () => {
    const { getScalingOverride } = await import('./scalingOverrideService');
    await expect(getScalingOverride()).resolves.toBeNull();
    expect(getEntity).not.toHaveBeenCalled();
  });
});

describe('getScalingOverride — configured', () => {
  beforeEach(() => {
    process.env.AUDIT_STORAGE_ACCOUNT_NAME = 'stavdmgrprodabc123';
  });

  it('returns the entity (with its ETag) on success', async () => {
    getEntity.mockResolvedValue({ ...entity(), etag: 'W/"etag-1"' });
    const { getScalingOverride } = await import('./scalingOverrideService');
    await expect(getScalingOverride()).resolves.toEqual({ ...entity(), etag: 'W/"etag-1"' });
  });

  it('returns null on a 404 (no override ever activated)', async () => {
    getEntity.mockRejectedValue(Object.assign(new Error('not found'), { statusCode: 404 }));
    const { getScalingOverride } = await import('./scalingOverrideService');
    await expect(getScalingOverride()).resolves.toBeNull();
  });

  it('propagates any other error', async () => {
    getEntity.mockRejectedValue(new Error('table unreachable'));
    const { getScalingOverride } = await import('./scalingOverrideService');
    await expect(getScalingOverride()).rejects.toThrow('table unreachable');
  });
});

describe('createScalingOverride — AM-23 peer review MAJOR 2 (ETag concurrency primitives)', () => {
  it('throws when unconfigured (no table client)', async () => {
    const { createScalingOverride } = await import('./scalingOverrideService');
    await expect(createScalingOverride(entity())).rejects.toThrow();
    expect(createEntity).not.toHaveBeenCalled();
  });

  it('calls TableClient.createEntity at the fixed partition/row key when configured', async () => {
    process.env.AUDIT_STORAGE_ACCOUNT_NAME = 'stavdmgrprodabc123';
    createEntity.mockResolvedValue(undefined);
    const { createScalingOverride } = await import('./scalingOverrideService');

    const { partitionKey: _pk, rowKey: _rk, ...rest } = entity();
    void _pk;
    void _rk;
    await createScalingOverride(rest);

    expect(createEntity).toHaveBeenCalledTimes(1);
    const [entityArg] = createEntity.mock.calls[0];
    expect(entityArg).toMatchObject({ partitionKey: 'override', rowKey: 'current', active: true, scalingPlanName: 'SCALE-CONTOSO-PROD' });
  });

  it('propagates a 409 (EntityAlreadyExists) rather than swallowing it — callers re-read and retry', async () => {
    process.env.AUDIT_STORAGE_ACCOUNT_NAME = 'stavdmgrprodabc123';
    const conflict = Object.assign(new Error('EntityAlreadyExists'), { statusCode: 409 });
    createEntity.mockRejectedValue(conflict);
    const { createScalingOverride, isConflictError } = await import('./scalingOverrideService');

    const { partitionKey: _pk, rowKey: _rk, ...rest } = entity();
    void _pk;
    void _rk;
    await expect(createScalingOverride(rest)).rejects.toBe(conflict);
    expect(isConflictError(conflict)).toBe(true);
  });
});

describe('replaceScalingOverride — AM-23 peer review MAJOR 2 (ETag concurrency primitives)', () => {
  it('throws when unconfigured (no table client)', async () => {
    const { replaceScalingOverride } = await import('./scalingOverrideService');
    const { partitionKey: _pk, rowKey: _rk, ...rest } = entity();
    void _pk;
    void _rk;
    await expect(replaceScalingOverride(rest, 'W/"etag-1"')).rejects.toThrow();
    expect(updateEntity).not.toHaveBeenCalled();
  });

  it('calls TableClient.updateEntity with mode Replace and the given etag', async () => {
    process.env.AUDIT_STORAGE_ACCOUNT_NAME = 'stavdmgrprodabc123';
    updateEntity.mockResolvedValue(undefined);
    const { replaceScalingOverride } = await import('./scalingOverrideService');

    const { partitionKey: _pk, rowKey: _rk, ...rest } = entity();
    void _pk;
    void _rk;
    await replaceScalingOverride(rest, 'W/"etag-1"');

    expect(updateEntity).toHaveBeenCalledTimes(1);
    const [entityArg, mode, options] = updateEntity.mock.calls[0];
    expect(mode).toBe('Replace');
    expect(options).toEqual({ etag: 'W/"etag-1"' });
    expect(entityArg).toMatchObject({ partitionKey: 'override', rowKey: 'current' });
  });

  it('propagates a 412 (PreconditionFailed) rather than swallowing it — callers re-read and retry', async () => {
    process.env.AUDIT_STORAGE_ACCOUNT_NAME = 'stavdmgrprodabc123';
    const preconditionFailed = Object.assign(new Error('PreconditionFailed'), { statusCode: 412 });
    updateEntity.mockRejectedValue(preconditionFailed);
    const { replaceScalingOverride, isPreconditionFailedError } = await import('./scalingOverrideService');

    const { partitionKey: _pk, rowKey: _rk, ...rest } = entity();
    void _pk;
    void _rk;
    await expect(replaceScalingOverride(rest, 'W/"stale-etag"')).rejects.toBe(preconditionFailed);
    expect(isPreconditionFailedError(preconditionFailed)).toBe(true);
  });
});

describe('isOverrideStoreRequiredButMissing', () => {
  it('is false in local dev (no WEBSITE_SITE_NAME) even when unconfigured', async () => {
    const { isOverrideStoreRequiredButMissing } = await import('./scalingOverrideService');
    expect(isOverrideStoreRequiredButMissing()).toBe(false);
  });

  it('is true when deployed (WEBSITE_SITE_NAME set) and unconfigured', async () => {
    process.env.WEBSITE_SITE_NAME = 'func-example-prod';
    const { isOverrideStoreRequiredButMissing } = await import('./scalingOverrideService');
    expect(isOverrideStoreRequiredButMissing()).toBe(true);
  });

  it('is false when deployed and configured', async () => {
    process.env.WEBSITE_SITE_NAME = 'func-example-prod';
    process.env.AUDIT_STORAGE_ACCOUNT_NAME = 'stavdmgrprodabc123';
    const { isOverrideStoreRequiredButMissing } = await import('./scalingOverrideService');
    expect(isOverrideStoreRequiredButMissing()).toBe(false);
  });
});
