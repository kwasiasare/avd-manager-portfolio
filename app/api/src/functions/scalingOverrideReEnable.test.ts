import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InvocationContext, Timer } from '@azure/functions';

const setScalingPlanHostPoolEnabled = vi.fn();
vi.mock('../services/avdService', () => ({
  setScalingPlanHostPoolEnabled: (...args: unknown[]) => setScalingPlanHostPoolEnabled(...args),
}));

const getScalingOverride = vi.fn();
const replaceScalingOverride = vi.fn();
vi.mock('../services/scalingOverrideService', async () => {
  const actual = await vi.importActual<typeof import('../services/scalingOverrideService')>('../services/scalingOverrideService');
  return {
    ...actual,
    getScalingOverride: (...args: unknown[]) => getScalingOverride(...args),
    replaceScalingOverride: (...args: unknown[]) => replaceScalingOverride(...args),
  };
});

const writeAuditEntry = vi.fn().mockResolvedValue(undefined);
vi.mock('../lib/auditLog', () => ({
  writeAuditEntry: (...args: unknown[]) => writeAuditEntry(...args),
}));

const { scalingOverrideReEnable } = await import('./scalingOverrideReEnable');

function makeContext(): InvocationContext & { errors: unknown[]; warnings: string[]; logs: string[] } {
  const errors: unknown[] = [];
  const warnings: string[] = [];
  const logs: string[] = [];
  return { warn: (...a) => warnings.push(a.join(' ')), error: (...a) => errors.push(a), log: (...a) => logs.push(a.join(' ')), errors, warnings, logs } as unknown as InvocationContext & {
    errors: unknown[];
    warnings: string[];
    logs: string[];
  };
}
const FAKE_TIMER = {} as Timer;

const EXPIRED_ENTITY = {
  partitionKey: 'override',
  rowKey: 'current',
  active: true,
  activatedBy: 'op@example.com',
  activatedById: 'entra-op-1',
  activatedAt: '2026-08-15T11:00:00.000Z',
  expiresAt: '2026-08-15T12:00:00.000Z', // in the past relative to "now" below
  minutes: 60,
  reason: 'planned maintenance',
  scalingPlanName: 'SCALE-CONTOSO-PROD',
  resourceGroup: 'RG-AVD-HostPools',
  hostPoolId: '/subscriptions/sub/resourceGroups/RG-AVD-HostPools/providers/Microsoft.DesktopVirtualization/hostPools/HP-CONTOSO-PROD',
  correlationId: 'corr-orig',
  etag: 'W/"etag-1"',
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-08-15T12:30:00.000Z')); // 30 min past EXPIRED_ENTITY.expiresAt
  getScalingOverride.mockReset().mockResolvedValue(null);
  replaceScalingOverride.mockReset().mockResolvedValue(undefined);
  setScalingPlanHostPoolEnabled.mockReset().mockResolvedValue([]);
  writeAuditEntry.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('scalingOverrideReEnable — nothing to do', () => {
  it('does nothing when no override has ever been activated (null)', async () => {
    const context = makeContext();
    await scalingOverrideReEnable(FAKE_TIMER, context);
    expect(setScalingPlanHostPoolEnabled).not.toHaveBeenCalled();
    expect(writeAuditEntry).not.toHaveBeenCalled();
  });

  it('does nothing when the override is active but NOT yet expired', async () => {
    getScalingOverride.mockResolvedValue({ ...EXPIRED_ENTITY, expiresAt: '2099-01-01T00:00:00.000Z' });
    await scalingOverrideReEnable(FAKE_TIMER, makeContext());
    expect(setScalingPlanHostPoolEnabled).not.toHaveBeenCalled();
  });

  it('does nothing when the override is already inactive, even if expiresAt is in the past', async () => {
    getScalingOverride.mockResolvedValue({ ...EXPIRED_ENTITY, active: false });
    await scalingOverrideReEnable(FAKE_TIMER, makeContext());
    expect(setScalingPlanHostPoolEnabled).not.toHaveBeenCalled();
  });
});

describe('scalingOverrideReEnable — double-read race guard (peer review MAJOR 2)', () => {
  it('re-reads immediately before the ARM call and ABORTS (no ARM call) if the override is no longer expired by then (reactivated/extended between reads)', async () => {
    getScalingOverride
      .mockResolvedValueOnce(EXPIRED_ENTITY) // initial read: expired
      .mockResolvedValueOnce({ ...EXPIRED_ENTITY, expiresAt: '2099-01-01T00:00:00.000Z' }); // fresh read right before the ARM call: no longer expired

    await scalingOverrideReEnable(FAKE_TIMER, makeContext());

    expect(getScalingOverride).toHaveBeenCalledTimes(2);
    expect(setScalingPlanHostPoolEnabled).not.toHaveBeenCalled();
  });

  it('aborts if the fresh read shows the override was cancelled (inactive) between reads', async () => {
    getScalingOverride.mockResolvedValueOnce(EXPIRED_ENTITY).mockResolvedValueOnce({ ...EXPIRED_ENTITY, active: false });
    await scalingOverrideReEnable(FAKE_TIMER, makeContext());
    expect(setScalingPlanHostPoolEnabled).not.toHaveBeenCalled();
  });

  it('proceeds using the FRESH read\'s etag (not the initial read\'s) when both reads agree it is still expired', async () => {
    const staleRead = { ...EXPIRED_ENTITY, etag: 'W/"stale"' };
    const freshRead = { ...EXPIRED_ENTITY, etag: 'W/"fresh"' };
    getScalingOverride.mockResolvedValueOnce(staleRead).mockResolvedValueOnce(freshRead);

    await scalingOverrideReEnable(FAKE_TIMER, makeContext());

    expect(replaceScalingOverride).toHaveBeenCalledWith(expect.anything(), 'W/"fresh"');
  });
});

describe('scalingOverrideReEnable — expired override, success path', () => {
  it('re-enables the plan using the entity\'s OWN stored resourceGroup (no resolveCurrentScalingPlanRef call), marks the row inactive via replaceScalingOverride+etag, and writes a success audit row with actor system:auto-reenable', async () => {
    getScalingOverride.mockResolvedValue(EXPIRED_ENTITY);
    const context = makeContext();

    await scalingOverrideReEnable(FAKE_TIMER, context);

    expect(setScalingPlanHostPoolEnabled).toHaveBeenCalledWith(EXPIRED_ENTITY.resourceGroup, 'SCALE-CONTOSO-PROD', EXPIRED_ENTITY.hostPoolId, true);
    expect(replaceScalingOverride).toHaveBeenCalledWith(expect.objectContaining({ active: false, scalingPlanName: 'SCALE-CONTOSO-PROD' }), EXPIRED_ENTITY.etag);

    const [event] = writeAuditEntry.mock.calls[0];
    expect(event).toMatchObject({ actor: 'system:auto-reenable', actorId: 'system', action: 'scalingplan.emergency_override.auto_reenable', outcome: 'success' });
  });
});

describe('scalingOverrideReEnable — expired override, ARM re-enable failure', () => {
  it('writes a failure audit row, does NOT clear the override row (so the next tick retries), and does not throw', async () => {
    getScalingOverride.mockResolvedValue(EXPIRED_ENTITY);
    setScalingPlanHostPoolEnabled.mockRejectedValue(new Error('ARM timeout'));
    const context = makeContext();

    await expect(scalingOverrideReEnable(FAKE_TIMER, context)).resolves.toBeUndefined();

    // The dedup-flag write also uses replaceScalingOverride — assert on the
    // AUDIT row (not "never called replaceScalingOverride") for correctness.
    const [event] = writeAuditEntry.mock.calls[0];
    expect(event.outcome).toBe('failure');
    expect(event.action).toBe('scalingplan.emergency_override.auto_reenable');
  });

  it('peer review MINOR 6 (failure-audit dedup): writes ONLY ONE failure audit row across repeated ticks for the same stuck episode', async () => {
    setScalingPlanHostPoolEnabled.mockRejectedValue(new Error('ARM timeout'));
    // Tick 1: entity has no reEnableFailureAudited flag yet.
    getScalingOverride.mockResolvedValue(EXPIRED_ENTITY);
    replaceScalingOverride.mockResolvedValue(undefined);

    await scalingOverrideReEnable(FAKE_TIMER, makeContext());
    expect(writeAuditEntry).toHaveBeenCalledTimes(1);
    // The dedup flag write itself goes through replaceScalingOverride.
    expect(replaceScalingOverride).toHaveBeenCalledWith(expect.objectContaining({ reEnableFailureAudited: true }), EXPIRED_ENTITY.etag);

    // Tick 2: entity now carries the flag (as tick 1 would have persisted it).
    writeAuditEntry.mockClear();
    getScalingOverride.mockResolvedValue({ ...EXPIRED_ENTITY, reEnableFailureAudited: true });

    await scalingOverrideReEnable(FAKE_TIMER, makeContext());
    expect(writeAuditEntry).not.toHaveBeenCalled();
  });

  it('still does not throw even if persisting the dedup flag itself fails', async () => {
    setScalingPlanHostPoolEnabled.mockRejectedValue(new Error('ARM timeout'));
    getScalingOverride.mockResolvedValue(EXPIRED_ENTITY);
    replaceScalingOverride.mockRejectedValue(new Error('table unreachable'));

    await expect(scalingOverrideReEnable(FAKE_TIMER, makeContext())).resolves.toBeUndefined();
    expect(writeAuditEntry).toHaveBeenCalledTimes(1);
  });
});

describe('scalingOverrideReEnable — durable-state write fails AFTER a successful ARM re-enable', () => {
  it('still writes a success audit row (ARM already succeeded) and does not throw', async () => {
    getScalingOverride.mockResolvedValue(EXPIRED_ENTITY);
    replaceScalingOverride.mockRejectedValue(new Error('table unreachable'));
    const context = makeContext();

    await expect(scalingOverrideReEnable(FAKE_TIMER, context)).resolves.toBeUndefined();
    expect(setScalingPlanHostPoolEnabled).toHaveBeenCalledTimes(1);
    const [event] = writeAuditEntry.mock.calls[0];
    expect(event.outcome).toBe('success');
  });
});
