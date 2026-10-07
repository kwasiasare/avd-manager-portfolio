import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RolloutNewHost, RolloutOldHost, RolloutState } from '@avdmgr/shared';
import type { RolloutPlanEntity } from './rolloutPlanService';

const getEntity = vi.fn();
const createEntity = vi.fn();
const updateEntity = vi.fn();
const deleteEntity = vi.fn();
let listEntitiesImpl: () => unknown[] = () => [];
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
    deleteEntity(...args: unknown[]) {
      return deleteEntity(...args);
    }
    listEntities() {
      const items = listEntitiesImpl();
      return (async function* () {
        for (const item of items) yield item;
      })();
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
  deleteEntity.mockReset();
  listEntitiesImpl = () => [];
  vi.resetModules();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

function oldHost(overrides: Partial<RolloutOldHost> = {}): RolloutOldHost {
  return { sessionHostName: 'avd-con-0', status: 'pending', ...overrides };
}

function newHost(overrides: Partial<RolloutNewHost> = {}): RolloutNewHost {
  return { sessionHostName: 'avd-con-1', status: 'awaiting_registration', ...overrides };
}

function entity(overrides: Partial<RolloutPlanEntity> = {}): RolloutPlanEntity {
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
    ...overrides,
  };
}

describe('canTransition — the legal transition graph', () => {
  it.each<[RolloutState, RolloutState]>([
    ['planned', 'draining_old'],
    ['planned', 'cancelled'],
    ['draining_old', 'awaiting_new_hosts'],
    ['draining_old', 'rolled_back'],
    ['awaiting_new_hosts', 'validating_new'],
    ['awaiting_new_hosts', 'rolled_back'],
    ['validating_new', 'cutover'],
    ['validating_new', 'rolled_back'],
    ['cutover', 'removing_old'],
    ['cutover', 'rolled_back'],
    ['removing_old', 'done'],
    ['removing_old', 'rolled_back'],
  ])('allows %s -> %s', async (from, to) => {
    const { canTransition } = await import('./rolloutPlanService');
    expect(canTransition(from, to)).toBe(true);
  });

  it.each<[RolloutState, RolloutState]>([
    ['planned', 'cutover'],
    ['planned', 'removing_old'],
    ['planned', 'done'],
    ['draining_old', 'cutover'],
    ['draining_old', 'planned'],
    ['awaiting_new_hosts', 'cutover'],
    ['awaiting_new_hosts', 'draining_old'],
    ['validating_new', 'removing_old'],
    ['cutover', 'validating_new'],
    ['removing_old', 'cutover'],
    ['done', 'planned'],
    ['rolled_back', 'planned'],
    ['cancelled', 'draining_old'],
  ])('rejects %s -> %s (illegal transition)', async (from, to) => {
    const { canTransition } = await import('./rolloutPlanService');
    expect(canTransition(from, to)).toBe(false);
  });

  it('rejects every outgoing transition from a terminal state', async () => {
    const { canTransition } = await import('./rolloutPlanService');
    const terminals: RolloutState[] = ['done', 'rolled_back', 'cancelled'];
    const everyState: RolloutState[] = ['planned', 'draining_old', 'awaiting_new_hosts', 'validating_new', 'cutover', 'removing_old', 'done', 'rolled_back', 'cancelled'];
    for (const from of terminals) {
      for (const to of everyState) {
        expect(canTransition(from, to)).toBe(false);
      }
    }
  });
});

describe('isTerminalState', () => {
  it('is true for done/rolled_back/cancelled', async () => {
    const { isTerminalState } = await import('./rolloutPlanService');
    expect(isTerminalState('done')).toBe(true);
    expect(isTerminalState('rolled_back')).toBe(true);
    expect(isTerminalState('cancelled')).toBe(true);
  });

  it('is false for every non-terminal state', async () => {
    const { isTerminalState } = await import('./rolloutPlanService');
    const nonTerminal: RolloutState[] = ['planned', 'draining_old', 'awaiting_new_hosts', 'validating_new', 'cutover', 'removing_old'];
    for (const state of nonTerminal) {
      expect(isTerminalState(state)).toBe(false);
    }
  });
});

describe('allOldHostsDrained', () => {
  it('is true when every host is drained', async () => {
    const { allOldHostsDrained } = await import('./rolloutPlanService');
    expect(allOldHostsDrained([oldHost({ status: 'drained' }), oldHost({ status: 'drained', sessionHostName: 'avd-con-2' })])).toBe(true);
  });

  it('is true when a host is already removed (a later stage than drained)', async () => {
    const { allOldHostsDrained } = await import('./rolloutPlanService');
    expect(allOldHostsDrained([oldHost({ status: 'removed' })])).toBe(true);
  });

  it('is false when any host is still pending/draining', async () => {
    const { allOldHostsDrained } = await import('./rolloutPlanService');
    expect(allOldHostsDrained([oldHost({ status: 'drained' }), oldHost({ status: 'draining', sessionHostName: 'avd-con-2' })])).toBe(false);
  });

  it('is vacuously true for an empty list', async () => {
    const { allOldHostsDrained } = await import('./rolloutPlanService');
    expect(allOldHostsDrained([])).toBe(true);
  });
});

describe('allNewHostsRegistered', () => {
  it('is false while empty (creation always requires >=1 — an empty list here means unexpected data, not "nothing to wait for")', async () => {
    const { allNewHostsRegistered } = await import('./rolloutPlanService');
    expect(allNewHostsRegistered([])).toBe(false);
  });

  it('is false if any host is still awaiting_registration', async () => {
    const { allNewHostsRegistered } = await import('./rolloutPlanService');
    expect(allNewHostsRegistered([newHost({ status: 'registered' }), newHost({ status: 'awaiting_registration', sessionHostName: 'avd-con-2' })])).toBe(false);
  });

  it('is true once every host has advanced past awaiting_registration, regardless of health', async () => {
    const { allNewHostsRegistered } = await import('./rolloutPlanService');
    expect(allNewHostsRegistered([newHost({ status: 'registered', healthy: false }), newHost({ status: 'available', sessionHostName: 'avd-con-2' })])).toBe(true);
  });
});

describe('allNewHostsAvailableAndHealthy', () => {
  it('is false while empty', async () => {
    const { allNewHostsAvailableAndHealthy } = await import('./rolloutPlanService');
    expect(allNewHostsAvailableAndHealthy([])).toBe(false);
  });

  it('is false if any host is registered but not yet available', async () => {
    const { allNewHostsAvailableAndHealthy } = await import('./rolloutPlanService');
    expect(allNewHostsAvailableAndHealthy([newHost({ status: 'available', healthy: true }), newHost({ status: 'registered', healthy: true, sessionHostName: 'avd-con-2' })])).toBe(false);
  });

  it('is false if a host is available but not healthy', async () => {
    const { allNewHostsAvailableAndHealthy } = await import('./rolloutPlanService');
    expect(allNewHostsAvailableAndHealthy([newHost({ status: 'available', healthy: false })])).toBe(false);
  });

  it('is false if healthy is undefined (never observed)', async () => {
    const { allNewHostsAvailableAndHealthy } = await import('./rolloutPlanService');
    expect(allNewHostsAvailableAndHealthy([newHost({ status: 'available' })])).toBe(false);
  });

  it('is true when every host is available (or already validated) and healthy', async () => {
    const { allNewHostsAvailableAndHealthy } = await import('./rolloutPlanService');
    expect(allNewHostsAvailableAndHealthy([newHost({ status: 'available', healthy: true }), newHost({ status: 'validated', healthy: true, sessionHostName: 'avd-con-2' })])).toBe(true);
  });
});

describe('canRemoveHost — THE HARD GATE', () => {
  it('is true only for exactly zero sessions', async () => {
    const { canRemoveHost } = await import('./rolloutPlanService');
    expect(canRemoveHost(0)).toBe(true);
  });

  it.each([1, 2, 100])('is false for %d active session(s) — no bypass', async (count) => {
    const { canRemoveHost } = await import('./rolloutPlanService');
    expect(canRemoveHost(count)).toBe(false);
  });
});

describe('parseOldHosts / parseNewHosts / parseRollbackNeedsReadd — defensive parsing', () => {
  it('parses well-formed JSON', async () => {
    const { parseOldHosts, parseNewHosts } = await import('./rolloutPlanService');
    expect(parseOldHosts(entity())).toEqual([oldHost()]);
    expect(parseNewHosts(entity())).toEqual([newHost()]);
  });

  it('defaults to [] for corrupt JSON rather than throwing', async () => {
    const { parseOldHosts, parseNewHosts } = await import('./rolloutPlanService');
    expect(parseOldHosts(entity({ oldHostsJson: '{not valid json' }))).toEqual([]);
    expect(parseNewHosts(entity({ newHostsJson: '{not valid json' }))).toEqual([]);
  });

  it('defaults to [] when the JSON is valid but not an array', async () => {
    const { parseOldHosts } = await import('./rolloutPlanService');
    expect(parseOldHosts(entity({ oldHostsJson: '{"not":"an array"}' }))).toEqual([]);
  });

  it('parseRollbackNeedsReadd returns undefined when unset, the parsed array when set, and undefined on corrupt JSON', async () => {
    const { parseRollbackNeedsReadd } = await import('./rolloutPlanService');
    expect(parseRollbackNeedsReadd(entity())).toBeUndefined();
    expect(parseRollbackNeedsReadd(entity({ rollbackNeedsReaddJson: JSON.stringify(['avd-con-0']) }))).toEqual(['avd-con-0']);
    expect(parseRollbackNeedsReadd(entity({ rollbackNeedsReaddJson: 'not json' }))).toBeUndefined();
  });
});

describe('toRolloutPlanDetail', () => {
  it('projects every entity field into the DTO and never leaks the ETag concept', async () => {
    const { toRolloutPlanDetail } = await import('./rolloutPlanService');
    const detail = toRolloutPlanDetail(entity());
    expect(detail).toEqual({
      id: 'plan-1',
      hostPoolName: 'HP-CONTOSO-PROD',
      targetImageVersion: '3.0.0',
      state: 'planned',
      oldHosts: [oldHost()],
      newHosts: [newHost()],
      createdBy: 'admin@example.com',
      createdAt: '2026-08-16T10:00:00.000Z',
      updatedAt: '2026-08-16T10:00:00.000Z',
      reason: 'roll out 3.0.0',
      forcedProceedAt: undefined,
      forcedProceedBy: undefined,
      forcedProceedReason: undefined,
      cutoverAt: undefined,
      cutoverBy: undefined,
      rollbackAt: undefined,
      rollbackBy: undefined,
      rollbackReason: undefined,
      rollbackNeedsReadd: undefined,
      cancelledAt: undefined,
      cancelledBy: undefined,
      completedAt: undefined,
      lastTimerError: undefined,
    });
    expect(detail).not.toHaveProperty('etag');
    expect(detail).not.toHaveProperty('createdById');
  });
});

describe('getRolloutPlanEntity', () => {
  it('returns null without calling getEntity when unconfigured', async () => {
    const { getRolloutPlanEntity } = await import('./rolloutPlanService');
    await expect(getRolloutPlanEntity('HP-CONTOSO-PROD', 'plan-1')).resolves.toBeNull();
    expect(getEntity).not.toHaveBeenCalled();
  });

  it('returns the record (with ETag) when configured and found', async () => {
    process.env.AUDIT_STORAGE_ACCOUNT_NAME = 'stavdmgrprodabc123';
    getEntity.mockResolvedValue({ ...entity(), etag: 'W/"etag-1"' });
    const { getRolloutPlanEntity } = await import('./rolloutPlanService');
    await expect(getRolloutPlanEntity('HP-CONTOSO-PROD', 'plan-1')).resolves.toEqual({ ...entity(), etag: 'W/"etag-1"' });
    expect(getEntity).toHaveBeenCalledWith('HP-CONTOSO-PROD', 'plan-1');
  });

  it('returns null on a 404', async () => {
    process.env.AUDIT_STORAGE_ACCOUNT_NAME = 'stavdmgrprodabc123';
    getEntity.mockRejectedValue(Object.assign(new Error('not found'), { statusCode: 404 }));
    const { getRolloutPlanEntity } = await import('./rolloutPlanService');
    await expect(getRolloutPlanEntity('HP-CONTOSO-PROD', 'plan-1')).resolves.toBeNull();
  });

  it('propagates any other error', async () => {
    process.env.AUDIT_STORAGE_ACCOUNT_NAME = 'stavdmgrprodabc123';
    getEntity.mockRejectedValue(new Error('table unreachable'));
    const { getRolloutPlanEntity } = await import('./rolloutPlanService');
    await expect(getRolloutPlanEntity('HP-CONTOSO-PROD', 'plan-1')).rejects.toThrow('table unreachable');
  });
});

describe('listRolloutPlanEntities', () => {
  it('returns [] without querying when unconfigured', async () => {
    const { listRolloutPlanEntities } = await import('./rolloutPlanService');
    await expect(listRolloutPlanEntities('HP-CONTOSO-PROD')).resolves.toEqual([]);
  });

  it('returns entities newest (by createdAt) first', async () => {
    process.env.AUDIT_STORAGE_ACCOUNT_NAME = 'stavdmgrprodabc123';
    listEntitiesImpl = () => [
      entity({ rowKey: 'plan-older', createdAt: '2026-08-01T00:00:00.000Z' }),
      entity({ rowKey: 'plan-newest', createdAt: '2026-08-16T00:00:00.000Z' }),
      entity({ rowKey: 'plan-middle', createdAt: '2026-08-10T00:00:00.000Z' }),
    ];
    const { listRolloutPlanEntities } = await import('./rolloutPlanService');
    const results = await listRolloutPlanEntities('HP-CONTOSO-PROD');
    expect(results.map((r) => r.rowKey)).toEqual(['plan-newest', 'plan-middle', 'plan-older']);
  });
});

describe('createRolloutPlanEntity', () => {
  it('throws when unconfigured (no table client)', async () => {
    const { createRolloutPlanEntity } = await import('./rolloutPlanService');
    await expect(createRolloutPlanEntity(entity())).rejects.toThrow();
    expect(createEntity).not.toHaveBeenCalled();
  });

  it('calls TableClient.createEntity with the given entity when configured', async () => {
    process.env.AUDIT_STORAGE_ACCOUNT_NAME = 'stavdmgrprodabc123';
    createEntity.mockResolvedValue(undefined);
    const { createRolloutPlanEntity } = await import('./rolloutPlanService');
    await createRolloutPlanEntity(entity());
    expect(createEntity).toHaveBeenCalledWith(entity());
  });

  it('propagates a 409 (RowKey collision) rather than swallowing it', async () => {
    process.env.AUDIT_STORAGE_ACCOUNT_NAME = 'stavdmgrprodabc123';
    const conflict = Object.assign(new Error('EntityAlreadyExists'), { statusCode: 409 });
    createEntity.mockRejectedValue(conflict);
    const { createRolloutPlanEntity, isConflictError } = await import('./rolloutPlanService');
    await expect(createRolloutPlanEntity(entity())).rejects.toBe(conflict);
    expect(isConflictError(conflict)).toBe(true);
  });
});

describe('replaceRolloutPlanEntity — ETag concurrency', () => {
  it('throws when unconfigured (no table client)', async () => {
    const { replaceRolloutPlanEntity } = await import('./rolloutPlanService');
    await expect(replaceRolloutPlanEntity(entity(), 'W/"etag-1"')).rejects.toThrow();
    expect(updateEntity).not.toHaveBeenCalled();
  });

  it('calls TableClient.updateEntity with mode Replace and the given etag', async () => {
    process.env.AUDIT_STORAGE_ACCOUNT_NAME = 'stavdmgrprodabc123';
    updateEntity.mockResolvedValue(undefined);
    const { replaceRolloutPlanEntity } = await import('./rolloutPlanService');
    await replaceRolloutPlanEntity(entity(), 'W/"etag-1"');
    expect(updateEntity).toHaveBeenCalledWith(entity(), 'Replace', { etag: 'W/"etag-1"' });
  });

  it('propagates a 412 (PreconditionFailed) rather than swallowing it — callers re-read and retry', async () => {
    process.env.AUDIT_STORAGE_ACCOUNT_NAME = 'stavdmgrprodabc123';
    const preconditionFailed = Object.assign(new Error('PreconditionFailed'), { statusCode: 412 });
    updateEntity.mockRejectedValue(preconditionFailed);
    const { replaceRolloutPlanEntity, isPreconditionFailedError } = await import('./rolloutPlanService');
    await expect(replaceRolloutPlanEntity(entity(), 'W/"stale-etag"')).rejects.toBe(preconditionFailed);
    expect(isPreconditionFailedError(preconditionFailed)).toBe(true);
  });
});

describe('isRolloutStoreRequiredButMissing', () => {
  it('is false in local dev (no WEBSITE_SITE_NAME) even when unconfigured', async () => {
    const { isRolloutStoreRequiredButMissing } = await import('./rolloutPlanService');
    expect(isRolloutStoreRequiredButMissing()).toBe(false);
  });

  it('is true when deployed (WEBSITE_SITE_NAME set) and unconfigured', async () => {
    process.env.WEBSITE_SITE_NAME = 'func-example-prod';
    const { isRolloutStoreRequiredButMissing } = await import('./rolloutPlanService');
    expect(isRolloutStoreRequiredButMissing()).toBe(true);
  });

  it('is false when deployed AND configured', async () => {
    process.env.WEBSITE_SITE_NAME = 'func-example-prod';
    process.env.AUDIT_STORAGE_ACCOUNT_NAME = 'stavdmgrprodabc123';
    const { isRolloutStoreRequiredButMissing } = await import('./rolloutPlanService');
    expect(isRolloutStoreRequiredButMissing()).toBe(false);
  });
});

describe('allNewHostsImageVerified', () => {
  it('is false while empty', async () => {
    const { allNewHostsImageVerified } = await import('./rolloutPlanService');
    expect(allNewHostsImageVerified([])).toBe(false);
  });

  it('is false if any host has not been image-verified', async () => {
    const { allNewHostsImageVerified } = await import('./rolloutPlanService');
    expect(allNewHostsImageVerified([newHost({ imageVerified: true }), newHost({ sessionHostName: 'avd-con-2', imageVerified: false })])).toBe(false);
  });

  it('is false if imageVerified is undefined (never observed)', async () => {
    const { allNewHostsImageVerified } = await import('./rolloutPlanService');
    expect(allNewHostsImageVerified([newHost()])).toBe(false);
  });

  it('is true when every host has been image-verified', async () => {
    const { allNewHostsImageVerified } = await import('./rolloutPlanService');
    expect(allNewHostsImageVerified([newHost({ imageVerified: true }), newHost({ sessionHostName: 'avd-con-2', imageVerified: true })])).toBe(true);
  });
});

describe('allNewHostsConfigVerified (AM-47 — the third cutover gate)', () => {
  it('is false for an empty list', async () => {
    const { allNewHostsConfigVerified } = await import('./rolloutPlanService');
    expect(allNewHostsConfigVerified([])).toBe(false);
  });

  it('is false when configCheck is undefined (never run)', async () => {
    const { allNewHostsConfigVerified } = await import('./rolloutPlanService');
    expect(allNewHostsConfigVerified([newHost()])).toBe(false);
  });

  it('is false while a check is in_progress', async () => {
    const { allNewHostsConfigVerified } = await import('./rolloutPlanService');
    expect(allNewHostsConfigVerified([newHost({ configCheck: { status: 'in_progress', submittedAt: '2026-08-22T00:00:00.000Z' } })])).toBe(false);
  });

  it('is false when a check failed', async () => {
    const { allNewHostsConfigVerified } = await import('./rolloutPlanService');
    expect(allNewHostsConfigVerified([newHost({ configCheck: { status: 'failed', diffs: [{ key: 'Enabled', expected: '1', actual: '0' }] } })])).toBe(false);
  });

  it('is false when a check errored', async () => {
    const { allNewHostsConfigVerified } = await import('./rolloutPlanService');
    expect(allNewHostsConfigVerified([newHost({ configCheck: { status: 'error', error: 'Azure request failed.' } })])).toBe(false);
  });

  it('is false if ANY host has not passed, even if others have', async () => {
    const { allNewHostsConfigVerified } = await import('./rolloutPlanService');
    expect(
      allNewHostsConfigVerified([newHost({ configCheck: { status: 'passed', diffs: [] } }), newHost({ sessionHostName: 'avd-con-2', configCheck: { status: 'in_progress' } })]),
    ).toBe(false);
  });

  it('is true when every host has passed', async () => {
    const { allNewHostsConfigVerified } = await import('./rolloutPlanService');
    expect(
      allNewHostsConfigVerified([newHost({ configCheck: { status: 'passed', diffs: [] } }), newHost({ sessionHostName: 'avd-con-2', configCheck: { status: 'passed', diffs: [] } })]),
    ).toBe(true);
  });
});

describe('parseConfigBaseline (AM-47)', () => {
  it('returns undefined when configBaselineJson is unset (pre-AM-47 row)', async () => {
    const { parseConfigBaseline } = await import('./rolloutPlanService');
    expect(parseConfigBaseline({ configBaselineJson: undefined })).toBeUndefined();
  });

  it('returns undefined on corrupt JSON rather than throwing', async () => {
    const { parseConfigBaseline } = await import('./rolloutPlanService');
    expect(parseConfigBaseline({ configBaselineJson: '{not valid' })).toBeUndefined();
  });

  it('returns undefined when the JSON parses to a non-object (e.g. an array)', async () => {
    const { parseConfigBaseline } = await import('./rolloutPlanService');
    expect(parseConfigBaseline({ configBaselineJson: '[1,2,3]' })).toBeUndefined();
  });

  it('parses a well-formed baseline object', async () => {
    const { parseConfigBaseline } = await import('./rolloutPlanService');
    const baseline = { Enabled: '1', VHDLocations: '\\\\a\\b', VolumeType: 'VHDX', SizeInMBs: '30000', FlipFlopProfileDirectoryName: '1' };
    expect(parseConfigBaseline({ configBaselineJson: JSON.stringify(baseline) })).toEqual(baseline);
  });
});

describe('toRolloutPlanDetail — projects configBaseline (AM-47)', () => {
  it('projects a parsed configBaseline when present', async () => {
    const { toRolloutPlanDetail } = await import('./rolloutPlanService');
    const baseline = { Enabled: '1', VHDLocations: '\\\\a\\b', VolumeType: 'VHDX', SizeInMBs: '30000', FlipFlopProfileDirectoryName: '1' };
    const detail = toRolloutPlanDetail(entity({ configBaselineJson: JSON.stringify(baseline) }));
    expect(detail.configBaseline).toEqual(baseline);
  });

  it('projects undefined configBaseline for a pre-AM-47 row', async () => {
    const { toRolloutPlanDetail } = await import('./rolloutPlanService');
    const detail = toRolloutPlanDetail(entity({ configBaselineJson: undefined }));
    expect(detail.configBaseline).toBeUndefined();
  });
});

describe('forceProceedNextState — AM-28 peer review item 6 (awaiting_new_hosts escape hatch)', () => {
  it('maps draining_old -> awaiting_new_hosts', async () => {
    const { forceProceedNextState } = await import('./rolloutPlanService');
    expect(forceProceedNextState('draining_old')).toBe('awaiting_new_hosts');
  });

  it('maps awaiting_new_hosts -> validating_new', async () => {
    const { forceProceedNextState } = await import('./rolloutPlanService');
    expect(forceProceedNextState('awaiting_new_hosts')).toBe('validating_new');
  });

  it.each<RolloutState>(['planned', 'validating_new', 'cutover', 'removing_old', 'done', 'rolled_back', 'cancelled'])('returns null for %s (not a valid force-proceed source state)', async (state) => {
    const { forceProceedNextState } = await import('./rolloutPlanService');
    expect(forceProceedNextState(state)).toBeNull();
  });
});

describe('one-active-plan sentinel (AM-28 peer review item 10)', () => {
  it('createActiveSentinel throws when unconfigured', async () => {
    const { createActiveSentinel } = await import('./rolloutPlanService');
    await expect(createActiveSentinel('HP-CONTOSO-PROD', 'plan-1')).rejects.toThrow();
    expect(createEntity).not.toHaveBeenCalled();
  });

  it('createActiveSentinel writes a fixed-RowKey row at the configured partition', async () => {
    process.env.AUDIT_STORAGE_ACCOUNT_NAME = 'stavdmgrprodabc123';
    createEntity.mockResolvedValue(undefined);
    const { createActiveSentinel } = await import('./rolloutPlanService');
    await createActiveSentinel('HP-CONTOSO-PROD', 'plan-1');
    expect(createEntity).toHaveBeenCalledWith({ partitionKey: 'HP-CONTOSO-PROD', rowKey: '__active__', activePlanId: 'plan-1' });
  });

  it('createActiveSentinel propagates a 409 (a second create raced and lost) rather than swallowing it', async () => {
    process.env.AUDIT_STORAGE_ACCOUNT_NAME = 'stavdmgrprodabc123';
    const conflict = Object.assign(new Error('EntityAlreadyExists'), { statusCode: 409 });
    createEntity.mockRejectedValue(conflict);
    const { createActiveSentinel, isConflictError } = await import('./rolloutPlanService');
    await expect(createActiveSentinel('HP-CONTOSO-PROD', 'plan-1')).rejects.toBe(conflict);
    expect(isConflictError(conflict)).toBe(true);
  });

  it('getActiveSentinel returns null when unconfigured, without calling getEntity', async () => {
    const { getActiveSentinel } = await import('./rolloutPlanService');
    await expect(getActiveSentinel('HP-CONTOSO-PROD')).resolves.toBeNull();
    expect(getEntity).not.toHaveBeenCalled();
  });

  it('getActiveSentinel returns the activePlanId when a sentinel exists', async () => {
    process.env.AUDIT_STORAGE_ACCOUNT_NAME = 'stavdmgrprodabc123';
    getEntity.mockResolvedValue({ partitionKey: 'HP-CONTOSO-PROD', rowKey: '__active__', activePlanId: 'plan-1' });
    const { getActiveSentinel } = await import('./rolloutPlanService');
    await expect(getActiveSentinel('HP-CONTOSO-PROD')).resolves.toEqual({ activePlanId: 'plan-1' });
  });

  it('getActiveSentinel returns null (not throw) on a 404 — no sentinel exists', async () => {
    process.env.AUDIT_STORAGE_ACCOUNT_NAME = 'stavdmgrprodabc123';
    getEntity.mockRejectedValue(Object.assign(new Error('not found'), { statusCode: 404 }));
    const { getActiveSentinel } = await import('./rolloutPlanService');
    await expect(getActiveSentinel('HP-CONTOSO-PROD')).resolves.toBeNull();
  });

  it('deleteActiveSentinel is a no-op when unconfigured (never throws)', async () => {
    const { deleteActiveSentinel } = await import('./rolloutPlanService');
    await expect(deleteActiveSentinel('HP-CONTOSO-PROD')).resolves.toBeUndefined();
    expect(deleteEntity).not.toHaveBeenCalled();
  });

  it('deleteActiveSentinel calls TableClient.deleteEntity at the fixed row key', async () => {
    process.env.AUDIT_STORAGE_ACCOUNT_NAME = 'stavdmgrprodabc123';
    deleteEntity.mockResolvedValue(undefined);
    const { deleteActiveSentinel } = await import('./rolloutPlanService');
    await deleteActiveSentinel('HP-CONTOSO-PROD');
    expect(deleteEntity).toHaveBeenCalledWith('HP-CONTOSO-PROD', '__active__');
  });
});

describe('listRolloutPlanEntities — bound + sentinel filtering (AM-28 peer review item 13)', () => {
  it('excludes the active-plan sentinel row from results', async () => {
    process.env.AUDIT_STORAGE_ACCOUNT_NAME = 'stavdmgrprodabc123';
    listEntitiesImpl = () => [entity({ rowKey: 'plan-1' }), { partitionKey: 'HP-CONTOSO-PROD', rowKey: '__active__', activePlanId: 'plan-1' }];
    const { listRolloutPlanEntities } = await import('./rolloutPlanService');
    const results = await listRolloutPlanEntities('HP-CONTOSO-PROD');
    expect(results.map((r) => r.rowKey)).toEqual(['plan-1']);
  });

  it('caps results to the 25 most recent plans', async () => {
    process.env.AUDIT_STORAGE_ACCOUNT_NAME = 'stavdmgrprodabc123';
    listEntitiesImpl = () =>
      Array.from({ length: 30 }, (_, i) => entity({ rowKey: `plan-${i}`, createdAt: new Date(2026, 0, i + 1).toISOString() }));
    const { listRolloutPlanEntities } = await import('./rolloutPlanService');
    const results = await listRolloutPlanEntities('HP-CONTOSO-PROD');
    expect(results).toHaveLength(25);
    // Newest first — the highest-numbered (latest-dated) plans win.
    expect(results[0].rowKey).toBe('plan-29');
  });
});

describe('listRolloutPlanEntitiesWithTruncation (AM-15/M7 sweep)', () => {
  it('reports truncated: false when every plan fits within the cap', async () => {
    process.env.AUDIT_STORAGE_ACCOUNT_NAME = 'stavdmgrprodabc123';
    listEntitiesImpl = () => [entity({ rowKey: 'plan-1' }), entity({ rowKey: 'plan-2' })];
    const { listRolloutPlanEntitiesWithTruncation } = await import('./rolloutPlanService');
    const { entities, truncated } = await listRolloutPlanEntitiesWithTruncation('HP-CONTOSO-PROD');
    expect(entities).toHaveLength(2);
    expect(truncated).toBe(false);
  });

  it('reports truncated: true when more than 25 plans exist for the host pool', async () => {
    process.env.AUDIT_STORAGE_ACCOUNT_NAME = 'stavdmgrprodabc123';
    listEntitiesImpl = () =>
      Array.from({ length: 30 }, (_, i) => entity({ rowKey: `plan-${i}`, createdAt: new Date(2026, 0, i + 1).toISOString() }));
    const { listRolloutPlanEntitiesWithTruncation } = await import('./rolloutPlanService');
    const { entities, truncated } = await listRolloutPlanEntitiesWithTruncation('HP-CONTOSO-PROD');
    expect(entities).toHaveLength(25);
    expect(truncated).toBe(true);
  });
});

describe('persistWithMergeRetry — BLOCKER fix (AM-28 peer review item 1)', () => {
  it('writes on the first attempt when there is no conflict', async () => {
    process.env.AUDIT_STORAGE_ACCOUNT_NAME = 'stavdmgrprodabc123';
    updateEntity.mockResolvedValue(undefined);
    const { persistWithMergeRetry } = await import('./rolloutPlanService');
    const startingRecord = { ...entity(), etag: 'W/"etag-1"' };

    const result = await persistWithMergeRetry('HP-CONTOSO-PROD', 'plan-1', startingRecord, (fresh) => ({ ...fresh, state: 'draining_old' }));

    expect(result.state).toBe('draining_old');
    expect(updateEntity).toHaveBeenCalledTimes(1);
    expect(updateEntity.mock.calls[0]).toEqual([expect.objectContaining({ state: 'draining_old' }), 'Replace', { etag: 'W/"etag-1"' }]);
    expect(getEntity).not.toHaveBeenCalled();
  });

  it('REGRESSION (item 1a): on a 412, re-reads the row, re-applies mutate to the FRESH data, and retries — never discarding achieved per-host progress', async () => {
    process.env.AUDIT_STORAGE_ACCOUNT_NAME = 'stavdmgrprodabc123';
    const preconditionFailed = Object.assign(new Error('PreconditionFailed'), { statusCode: 412 });
    // First write attempt (against the STALE etag) fails; the row has meanwhile
    // changed concurrently (simulating the timer ticking mid-request) — its
    // oldHostsJson now reflects a DIFFERENT host's concurrent update that must
    // be preserved, not clobbered by our own stale copy.
    const freshAfterConflict = {
      ...entity({ oldHostsJson: JSON.stringify([oldHost({ sessionHostName: 'avd-con-0' }), oldHost({ sessionHostName: 'avd-con-9', status: 'drained' })]) }),
      etag: 'W/"etag-2"',
    };
    getEntity.mockResolvedValue(freshAfterConflict);
    updateEntity.mockRejectedValueOnce(preconditionFailed).mockResolvedValueOnce(undefined);

    const { persistWithMergeRetry } = await import('./rolloutPlanService');
    const startingRecord = { ...entity({ oldHostsJson: JSON.stringify([oldHost({ sessionHostName: 'avd-con-0' })]) }), etag: 'W/"etag-1"' };

    // mutate expresses "mark avd-con-0 removed" as a MERGE, matching rolloutPlans.ts's own mergeOldHostUpdates pattern.
    const result = await persistWithMergeRetry('HP-CONTOSO-PROD', 'plan-1', startingRecord, (fresh) => {
      const hosts = JSON.parse(fresh.oldHostsJson) as ReturnType<typeof oldHost>[];
      const merged = hosts.map((h) => (h.sessionHostName === 'avd-con-0' ? { ...h, status: 'removed' as const } : h));
      return { ...fresh, oldHostsJson: JSON.stringify(merged) };
    });

    expect(updateEntity).toHaveBeenCalledTimes(2);
    expect(getEntity).toHaveBeenCalledTimes(1);
    // The SECOND write attempt must use the FRESH etag, not the stale one.
    expect(updateEntity.mock.calls[1][2]).toEqual({ etag: 'W/"etag-2"' });
    const finalHosts = JSON.parse(result.oldHostsJson) as ReturnType<typeof oldHost>[];
    // Our own achieved change (avd-con-0 removed) is present...
    expect(finalHosts.find((h) => h.sessionHostName === 'avd-con-0')?.status).toBe('removed');
    // ...AND the concurrent writer's change (avd-con-9 drained) was NOT clobbered.
    expect(finalHosts.find((h) => h.sessionHostName === 'avd-con-9')?.status).toBe('drained');
  });

  it('is bounded — throws once MAX_MERGE_RETRIES is exhausted, rather than retrying forever', async () => {
    process.env.AUDIT_STORAGE_ACCOUNT_NAME = 'stavdmgrprodabc123';
    const preconditionFailed = Object.assign(new Error('PreconditionFailed'), { statusCode: 412 });
    getEntity.mockResolvedValue({ ...entity(), etag: 'W/"etag-fresh"' });
    updateEntity.mockRejectedValue(preconditionFailed);
    const { persistWithMergeRetry } = await import('./rolloutPlanService');
    const startingRecord = { ...entity(), etag: 'W/"etag-1"' };

    await expect(persistWithMergeRetry('HP-CONTOSO-PROD', 'plan-1', startingRecord, (fresh) => fresh)).rejects.toBe(preconditionFailed);
    // Bounded — not an unbounded/infinite retry loop.
    expect(updateEntity.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it('propagates a non-412 error immediately, without retrying', async () => {
    process.env.AUDIT_STORAGE_ACCOUNT_NAME = 'stavdmgrprodabc123';
    const otherError = new Error('table unreachable');
    updateEntity.mockRejectedValue(otherError);
    const { persistWithMergeRetry } = await import('./rolloutPlanService');
    const startingRecord = { ...entity(), etag: 'W/"etag-1"' };

    await expect(persistWithMergeRetry('HP-CONTOSO-PROD', 'plan-1', startingRecord, (fresh) => fresh)).rejects.toBe(otherError);
    expect(updateEntity).toHaveBeenCalledTimes(1);
    expect(getEntity).not.toHaveBeenCalled();
  });

  it('propagates the original 412 if the row vanishes entirely on re-read (practically impossible, not silently swallowed)', async () => {
    process.env.AUDIT_STORAGE_ACCOUNT_NAME = 'stavdmgrprodabc123';
    const preconditionFailed = Object.assign(new Error('PreconditionFailed'), { statusCode: 412 });
    updateEntity.mockRejectedValue(preconditionFailed);
    getEntity.mockRejectedValue(Object.assign(new Error('not found'), { statusCode: 404 }));
    const { persistWithMergeRetry } = await import('./rolloutPlanService');
    const startingRecord = { ...entity(), etag: 'W/"etag-1"' };

    await expect(persistWithMergeRetry('HP-CONTOSO-PROD', 'plan-1', startingRecord, (fresh) => fresh)).rejects.toBe(preconditionFailed);
  });
});
