import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const listRolloutPlanEntities = vi.fn();
vi.mock('../services/rolloutPlanService', () => ({
  listRolloutPlanEntities: (...args: unknown[]) => listRolloutPlanEntities(...args),
}));

const { hasCompletedRolloutForVersion, describeRolloutNotCompleteReason, checkRolloutDoneForVersion } = await import('./imageBuildSnapshotGate');

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  process.env.SUBSCRIPTION_ID = 'sub-id';
  process.env.RG_HOSTPOOLS = 'RG-AVD-HostPools';
  process.env.HOSTPOOL_NAME = 'HP-CONTOSO-PROD';
  listRolloutPlanEntities.mockReset();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('hasCompletedRolloutForVersion — pure predicate', () => {
  it('true when some plan targeted this version and reached done', () => {
    const plans = [
      { targetImageVersion: '2.0.0', state: 'done' as const },
      { targetImageVersion: '2.1.0', state: 'done' as const },
    ];
    expect(hasCompletedRolloutForVersion(plans, '2.1.0')).toBe(true);
  });

  it('false when the matching plan for this version has NOT reached done', () => {
    const plans = [{ targetImageVersion: '2.1.0', state: 'cutover' as const }];
    expect(hasCompletedRolloutForVersion(plans, '2.1.0')).toBe(false);
  });

  it('false when no plan targets this version at all', () => {
    const plans = [{ targetImageVersion: '2.0.0', state: 'done' as const }];
    expect(hasCompletedRolloutForVersion(plans, '2.1.0')).toBe(false);
  });

  it('a rolled_back or cancelled plan for this version does NOT count as a completed rollout', () => {
    const plans = [
      { targetImageVersion: '2.1.0', state: 'rolled_back' as const },
      { targetImageVersion: '2.1.0', state: 'cancelled' as const },
    ];
    expect(hasCompletedRolloutForVersion(plans, '2.1.0')).toBe(false);
  });

  it('vacuously false against an empty plan list', () => {
    expect(hasCompletedRolloutForVersion([], '2.1.0')).toBe(false);
  });
});

describe('describeRolloutNotCompleteReason — 25-row-cap honesty', () => {
  it('never claims the version was "never" rolled out — only that none was found in the most recent plans', () => {
    const message = describeRolloutNotCompleteReason('2.1.0');
    expect(message).toContain('2.1.0');
    expect(message).toContain('most recent');
    expect(message.toLowerCase()).not.toContain('never rolled out');
  });
});

describe('checkRolloutDoneForVersion — impure wrapper', () => {
  it('ok:true when listRolloutPlanEntities returns a completed plan for this version', async () => {
    listRolloutPlanEntities.mockResolvedValue([{ targetImageVersion: '2.1.0', state: 'done' }]);
    const result = await checkRolloutDoneForVersion('2.1.0');
    expect(result.ok).toBe(true);
    expect(listRolloutPlanEntities).toHaveBeenCalledWith('HP-CONTOSO-PROD');
  });

  it('ok:false with the cap-honest reason when nothing matches', async () => {
    listRolloutPlanEntities.mockResolvedValue([]);
    const result = await checkRolloutDoneForVersion('2.1.0');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('2.1.0');
    }
  });

  it('propagates a genuine read failure rather than swallowing it', async () => {
    listRolloutPlanEntities.mockRejectedValue(new Error('table unavailable'));
    await expect(checkRolloutDoneForVersion('2.1.0')).rejects.toThrow('table unavailable');
  });
});
