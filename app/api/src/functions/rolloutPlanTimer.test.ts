import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InvocationContext, Timer } from '@azure/functions';
import type { RolloutNewHost, RolloutOldHost } from '@avdmgr/shared';
import { FSLOGIX_CHECK_OUTPUT_MARKER } from '../lib/fslogixConfigCheck';
import type { RolloutPlanEntity, RolloutPlanRecord } from '../services/rolloutPlanService';

const listSessionHosts = vi.fn();
const resolveSessionHostVm = vi.fn();
vi.mock('../services/avdService', () => ({
  listSessionHosts: (...args: unknown[]) => listSessionHosts(...args),
  resolveSessionHostVm: (...args: unknown[]) => resolveSessionHostVm(...args),
}));

const getVmImageReference = vi.fn();
const getFslogixConfigCheckResult = vi.fn();
const beginVmPowerAction = vi.fn();
vi.mock('../services/computeService', () => ({
  getVmImageReference: (...args: unknown[]) => getVmImageReference(...args),
  getFslogixConfigCheckResult: (...args: unknown[]) => getFslogixConfigCheckResult(...args),
  beginVmPowerAction: (...args: unknown[]) => beginVmPowerAction(...args),
}));

const writeAuditEntry = vi.fn().mockResolvedValue(undefined);
const isAuditRequiredButMissing = vi.fn().mockReturnValue(false);
vi.mock('../lib/auditLog', () => ({
  writeAuditEntry: (...args: unknown[]) => writeAuditEntry(...args),
  isAuditRequiredButMissing: (...args: unknown[]) => isAuditRequiredButMissing(...args),
}));

const getRolloutPlanEntity = vi.fn();
const listRolloutPlanEntities = vi.fn();
const replaceRolloutPlanEntity = vi.fn();
vi.mock('../services/rolloutPlanService', async () => {
  const actual = await vi.importActual<typeof import('../services/rolloutPlanService')>('../services/rolloutPlanService');
  return {
    ...actual,
    getRolloutPlanEntity: (...args: unknown[]) => getRolloutPlanEntity(...args),
    listRolloutPlanEntities: (...args: unknown[]) => listRolloutPlanEntities(...args),
    replaceRolloutPlanEntity: (...args: unknown[]) => replaceRolloutPlanEntity(...args),
  };
});

const { rolloutPlanTimer } = await import('./rolloutPlanTimer');

function makeContext(): InvocationContext & { warnings: string[]; errors: unknown[]; logs: unknown[] } {
  const warnings: string[] = [];
  const errors: unknown[] = [];
  const logs: unknown[] = [];
  return { warn: (m: string) => warnings.push(m), error: (...a: unknown[]) => errors.push(a), log: (m: string) => logs.push(m), warnings, errors, logs } as unknown as InvocationContext & {
    warnings: string[];
    errors: unknown[];
    logs: unknown[];
  };
}

function oldHost(overrides: Partial<RolloutOldHost> = {}): RolloutOldHost {
  return { sessionHostName: 'avd-con-0', status: 'draining', ...overrides };
}

function liveSessionHost(overrides: Record<string, unknown> = {}) {
  return { id: 'id', name: 'avd-con-0', hostPoolName: 'HP-CONTOSO-PROD', status: 'Unavailable', allowNewSession: true, activeSessions: 0, healthChecks: [], ...overrides };
}

function record(overrides: Partial<RolloutPlanEntity> = {}): RolloutPlanRecord {
  return {
    partitionKey: 'HP-CONTOSO-PROD',
    rowKey: 'plan-1',
    hostPoolName: 'HP-CONTOSO-PROD',
    targetImageVersion: '3.0.0',
    state: 'draining_old',
    oldHostsJson: JSON.stringify([oldHost()]),
    newHostsJson: JSON.stringify([{ sessionHostName: 'avd-con-1', status: 'awaiting_registration' }]),
    createdBy: 'admin@example.com',
    createdById: 'entra-obj-admin-1',
    createdAt: '2026-08-16T10:00:00.000Z',
    updatedAt: '2026-08-16T10:00:00.000Z',
    reason: 'roll out 3.0.0',
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
  listSessionHosts.mockReset();
  resolveSessionHostVm.mockReset().mockResolvedValue({ resourceGroup: 'RG-AVD-HostPools', vmName: 'avd-con-1', activeSessions: 0 });
  getVmImageReference.mockReset().mockResolvedValue({ exactVersion: '3.0.0' });
  getFslogixConfigCheckResult.mockReset().mockResolvedValue(undefined);
  beginVmPowerAction.mockReset().mockResolvedValue(undefined);
  writeAuditEntry.mockReset().mockResolvedValue(undefined);
  isAuditRequiredButMissing.mockReset().mockReturnValue(false);
  getRolloutPlanEntity.mockReset();
  listRolloutPlanEntities.mockReset().mockResolvedValue([]);
  replaceRolloutPlanEntity.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

async function runTimer(context = makeContext()) {
  await rolloutPlanTimer({} as Timer, context);
  return context;
}

describe('rolloutPlanTimer — fail-closed audit posture (AM-28 peer review item 12)', () => {
  it('skips the ENTIRE tick (no plan is even listed) when audit is required but missing in a deployed environment', async () => {
    isAuditRequiredButMissing.mockReturnValue(true);
    const context = await runTimer();
    expect(listRolloutPlanEntities).not.toHaveBeenCalled();
    expect(context.errors.some((e) => String(e).includes('ROLLOUT_TIMER_AUDIT_MISCONFIGURED'))).toBe(true);
  });
});

describe('rolloutPlanTimer — skips terminal and unpolled states', () => {
  it('does nothing when there are no non-terminal plans', async () => {
    listRolloutPlanEntities.mockResolvedValue([record({ state: 'done' }), record({ state: 'rolled_back', rowKey: 'plan-2' })]);
    await runTimer();
    expect(getRolloutPlanEntity).not.toHaveBeenCalled();
  });

  it('does not poll ARM for planned/cutover/removing_old (no automatic advance from these states)', async () => {
    listRolloutPlanEntities.mockResolvedValue([record({ state: 'planned' })]);
    getRolloutPlanEntity.mockResolvedValue(record({ state: 'planned' }));
    await runTimer();
    expect(listSessionHosts).not.toHaveBeenCalled();
    expect(resolveSessionHostVm).not.toHaveBeenCalled();
    expect(replaceRolloutPlanEntity).not.toHaveBeenCalled();
  });
});

describe('rolloutPlanTimer — draining_old -> awaiting_new_hosts', () => {
  it('advances once every old host reaches zero sessions AND allowNewSession:false, via a SINGLE listSessionHosts call', async () => {
    const planRecord = record({ state: 'draining_old', oldHostsJson: JSON.stringify([oldHost()]) });
    listRolloutPlanEntities.mockResolvedValue([planRecord]);
    getRolloutPlanEntity.mockResolvedValue(planRecord);
    listSessionHosts.mockResolvedValue([liveSessionHost({ activeSessions: 0, allowNewSession: false })]);

    await runTimer();

    expect(listSessionHosts).toHaveBeenCalledTimes(1); // item 12: one list call, not a per-host resolveSessionHostVm.
    expect(resolveSessionHostVm).not.toHaveBeenCalled();
    expect(replaceRolloutPlanEntity).toHaveBeenCalledTimes(1);
    const [entityArg] = replaceRolloutPlanEntity.mock.calls[0] as [RolloutPlanEntity];
    expect(entityArg.state).toBe('awaiting_new_hosts');
    expect(JSON.parse(entityArg.oldHostsJson)).toEqual([{ ...oldHost(), status: 'drained', lastObservedSessions: 0, drainedAt: expect.any(String) }]);
    expect(writeAuditEntry).toHaveBeenCalledWith(expect.objectContaining({ action: 'rollout.timer_advance', parameters: { from: 'draining_old', to: 'awaiting_new_hosts' } }), expect.anything());
  });

  it('AM-28 peer review item 6 — a host with zero sessions but allowNewSession:true (re-enabled by an operator) does NOT count as drained', async () => {
    const planRecord = record({ state: 'draining_old', oldHostsJson: JSON.stringify([oldHost()]) });
    listRolloutPlanEntities.mockResolvedValue([planRecord]);
    getRolloutPlanEntity.mockResolvedValue(planRecord);
    listSessionHosts.mockResolvedValue([liveSessionHost({ activeSessions: 0, allowNewSession: true })]);

    await runTimer();

    const [entityArg] = replaceRolloutPlanEntity.mock.calls[0] as [RolloutPlanEntity];
    expect(entityArg.state).toBe('draining_old'); // not advanced
    expect(JSON.parse(entityArg.oldHostsJson)[0].status).toBe('draining');
  });

  it('matches host names case-insensitively against the live list', async () => {
    const planRecord = record({ state: 'draining_old', oldHostsJson: JSON.stringify([oldHost({ sessionHostName: 'AVD-CON-0' })]) });
    listRolloutPlanEntities.mockResolvedValue([planRecord]);
    getRolloutPlanEntity.mockResolvedValue(planRecord);
    listSessionHosts.mockResolvedValue([liveSessionHost({ name: 'avd-con-0', activeSessions: 0, allowNewSession: false })]);

    await runTimer();

    const [entityArg] = replaceRolloutPlanEntity.mock.calls[0] as [RolloutPlanEntity];
    expect(entityArg.state).toBe('awaiting_new_hosts');
  });

  it('does NOT advance while any old host still has sessions', async () => {
    const planRecord = record({ state: 'draining_old', oldHostsJson: JSON.stringify([oldHost(), oldHost({ sessionHostName: 'avd-con-2' })]) });
    listRolloutPlanEntities.mockResolvedValue([planRecord]);
    getRolloutPlanEntity.mockResolvedValue(planRecord);
    listSessionHosts.mockResolvedValue([
      liveSessionHost({ name: 'avd-con-0', activeSessions: 0, allowNewSession: false }),
      liveSessionHost({ name: 'avd-con-2', activeSessions: 1, allowNewSession: false }),
    ]);

    await runTimer();

    const [entityArg] = replaceRolloutPlanEntity.mock.calls[0] as [RolloutPlanEntity];
    expect(entityArg.state).toBe('draining_old');
    expect(writeAuditEntry).not.toHaveBeenCalled();
  });

  it('leaves a host not present in the live list unchanged for this tick rather than failing the whole plan', async () => {
    const planRecord = record({ state: 'draining_old', oldHostsJson: JSON.stringify([oldHost()]) });
    listRolloutPlanEntities.mockResolvedValue([planRecord]);
    getRolloutPlanEntity.mockResolvedValue(planRecord);
    listSessionHosts.mockResolvedValue([]);

    await runTimer();

    expect(replaceRolloutPlanEntity).not.toHaveBeenCalled();
  });

  it('classifies a polling failure to a GENERIC lastTimerError (raw ARM text only goes to context.warn)', async () => {
    const planRecord = record({ state: 'draining_old', oldHostsJson: JSON.stringify([oldHost()]) });
    listRolloutPlanEntities.mockResolvedValue([planRecord]);
    getRolloutPlanEntity.mockResolvedValue(planRecord);
    listSessionHosts.mockRejectedValue(Object.assign(new Error('secret internal ARM detail: subscriptionId=abc123'), { statusCode: 403 }));

    const context = await runTimer();

    const [entityArg] = replaceRolloutPlanEntity.mock.calls[0] as [RolloutPlanEntity];
    expect(entityArg.lastTimerError).toBe('Azure denied a read request (permissions).');
    expect(entityArg.lastTimerError).not.toContain('secret internal ARM detail');
    expect(context.warnings.some((w) => w.includes('secret internal ARM detail'))).toBe(true);
  });
});

describe('rolloutPlanTimer — awaiting_new_hosts -> validating_new', () => {
  it('advances once every declared new host has been observed at all (Available not required yet)', async () => {
    const planRecord = record({ state: 'awaiting_new_hosts', newHostsJson: JSON.stringify([{ sessionHostName: 'avd-con-1', status: 'awaiting_registration' }]) });
    listRolloutPlanEntities.mockResolvedValue([planRecord]);
    getRolloutPlanEntity.mockResolvedValue(planRecord);
    listSessionHosts.mockResolvedValue([liveSessionHost({ name: 'avd-con-1', status: 'Unavailable' })]);

    await runTimer();

    const [entityArg] = replaceRolloutPlanEntity.mock.calls[0] as [RolloutPlanEntity];
    expect(entityArg.state).toBe('validating_new');
    const newHosts = JSON.parse(entityArg.newHostsJson);
    expect(newHosts[0]).toMatchObject({ status: 'registered', lastObservedStatus: 'Unavailable' });
  });

  it('matches new-host names case-insensitively too', async () => {
    const planRecord = record({ state: 'awaiting_new_hosts', newHostsJson: JSON.stringify([{ sessionHostName: 'AVD-CON-1', status: 'awaiting_registration' }]) });
    listRolloutPlanEntities.mockResolvedValue([planRecord]);
    getRolloutPlanEntity.mockResolvedValue(planRecord);
    listSessionHosts.mockResolvedValue([liveSessionHost({ name: 'avd-con-1', status: 'Available', healthChecks: [{ name: 'x', healthCheckResult: 'HealthCheckSucceeded' }] })]);

    await runTimer();

    const [entityArg] = replaceRolloutPlanEntity.mock.calls[0] as [RolloutPlanEntity];
    expect(entityArg.state).toBe('validating_new');
  });

  it('marks a host available+healthy+imageVerified when AVD reports it Available with all health checks succeeded and the VM image matches', async () => {
    const planRecord = record({
      state: 'awaiting_new_hosts',
      targetImageVersion: '3.0.0',
      newHostsJson: JSON.stringify([{ sessionHostName: 'avd-con-1', status: 'awaiting_registration' }]),
    });
    listRolloutPlanEntities.mockResolvedValue([planRecord]);
    getRolloutPlanEntity.mockResolvedValue(planRecord);
    listSessionHosts.mockResolvedValue([liveSessionHost({ name: 'avd-con-1', status: 'Available', healthChecks: [{ name: 'UrlsAccessibleCheck', healthCheckResult: 'HealthCheckSucceeded' }] })]);
    resolveSessionHostVm.mockResolvedValue({ resourceGroup: 'RG-AVD-HostPools', vmName: 'avd-con-1', activeSessions: 0 });
    getVmImageReference.mockResolvedValue({ exactVersion: '3.0.0' });

    await runTimer();

    const [entityArg] = replaceRolloutPlanEntity.mock.calls[0] as [RolloutPlanEntity];
    const newHosts = JSON.parse(entityArg.newHostsJson);
    expect(newHosts[0]).toMatchObject({ status: 'available', lastObservedStatus: 'Available', healthy: true, imageVerified: true });
  });

  it('AM-28 peer review item 4 — marks imageVerified:false when the VM image version does NOT match targetImageVersion', async () => {
    const planRecord = record({
      state: 'awaiting_new_hosts',
      targetImageVersion: '3.0.0',
      newHostsJson: JSON.stringify([{ sessionHostName: 'avd-con-1', status: 'awaiting_registration' }]),
    });
    listRolloutPlanEntities.mockResolvedValue([planRecord]);
    getRolloutPlanEntity.mockResolvedValue(planRecord);
    listSessionHosts.mockResolvedValue([liveSessionHost({ name: 'avd-con-1', status: 'Available', healthChecks: [{ name: 'x', healthCheckResult: 'HealthCheckSucceeded' }] })]);
    getVmImageReference.mockResolvedValue({ exactVersion: '2.0.0' });

    await runTimer();

    const [entityArg] = replaceRolloutPlanEntity.mock.calls[0] as [RolloutPlanEntity];
    const newHosts = JSON.parse(entityArg.newHostsJson);
    expect(newHosts[0].imageVerified).toBe(false);
  });

  it('falls back to the image resource id trailing segment when exactVersion is absent', async () => {
    const planRecord = record({
      state: 'awaiting_new_hosts',
      targetImageVersion: '3.0.0',
      newHostsJson: JSON.stringify([{ sessionHostName: 'avd-con-1', status: 'awaiting_registration' }]),
    });
    listRolloutPlanEntities.mockResolvedValue([planRecord]);
    getRolloutPlanEntity.mockResolvedValue(planRecord);
    listSessionHosts.mockResolvedValue([liveSessionHost({ name: 'avd-con-1', status: 'Available', healthChecks: [{ name: 'x', healthCheckResult: 'HealthCheckSucceeded' }] })]);
    getVmImageReference.mockResolvedValue({ id: '/subscriptions/sub/.../galleries/ACG_AVD_CONTOSO/images/WIN11-ENT-MS-M365/versions/3.0.0' });

    await runTimer();

    const [entityArg] = replaceRolloutPlanEntity.mock.calls[0] as [RolloutPlanEntity];
    expect(JSON.parse(entityArg.newHostsJson)[0].imageVerified).toBe(true);
  });

  it('leaves imageVerified at its previous value when the VM image lookup fails for one host, without failing the tick', async () => {
    const planRecord = record({
      state: 'awaiting_new_hosts',
      newHostsJson: JSON.stringify([{ sessionHostName: 'avd-con-1', status: 'awaiting_registration', imageVerified: true }]),
    });
    listRolloutPlanEntities.mockResolvedValue([planRecord]);
    getRolloutPlanEntity.mockResolvedValue(planRecord);
    listSessionHosts.mockResolvedValue([liveSessionHost({ name: 'avd-con-1', status: 'Available', healthChecks: [{ name: 'x', healthCheckResult: 'HealthCheckSucceeded' }] })]);
    resolveSessionHostVm.mockRejectedValue(new Error('resolve failed'));

    await runTimer();

    const [entityArg] = replaceRolloutPlanEntity.mock.calls[0] as [RolloutPlanEntity];
    expect(JSON.parse(entityArg.newHostsJson)[0].imageVerified).toBe(true); // unchanged, not clobbered to false/undefined
  });

  it('does not advance while a declared new host has not appeared in AVD at all', async () => {
    const planRecord = record({ state: 'awaiting_new_hosts', newHostsJson: JSON.stringify([{ sessionHostName: 'avd-con-1', status: 'awaiting_registration' }]) });
    listRolloutPlanEntities.mockResolvedValue([planRecord]);
    getRolloutPlanEntity.mockResolvedValue(planRecord);
    listSessionHosts.mockResolvedValue([]);

    await runTimer();

    expect(replaceRolloutPlanEntity).not.toHaveBeenCalled();
  });
});

describe('rolloutPlanTimer — validating_new: keeps refreshing per-host data, including already-validated hosts (AM-28 peer review item 7)', () => {
  it('updates newHosts health/image data but never transitions the state itself (an operator confirm-cutover is required)', async () => {
    const planRecord = record({ state: 'validating_new', newHostsJson: JSON.stringify([{ sessionHostName: 'avd-con-1', status: 'registered' }]) });
    listRolloutPlanEntities.mockResolvedValue([planRecord]);
    getRolloutPlanEntity.mockResolvedValue(planRecord);
    listSessionHosts.mockResolvedValue([liveSessionHost({ name: 'avd-con-1', status: 'Available', healthChecks: [{ name: 'x', healthCheckResult: 'HealthCheckSucceeded' }] })]);

    await runTimer();

    const [entityArg] = replaceRolloutPlanEntity.mock.calls[0] as [RolloutPlanEntity];
    expect(entityArg.state).toBe('validating_new');
    expect(JSON.parse(entityArg.newHostsJson)[0]).toMatchObject({ status: 'available', healthy: true });
    expect(writeAuditEntry).not.toHaveBeenCalled();
  });

  it('a host already "validated" keeps that status (never regressed) but its observed health/image data still refreshes, surfacing post-cutover degradation', async () => {
    const planRecord = record({ state: 'validating_new', newHostsJson: JSON.stringify([{ sessionHostName: 'avd-con-1', status: 'validated', healthy: true, imageVerified: true }]) });
    listRolloutPlanEntities.mockResolvedValue([planRecord]);
    getRolloutPlanEntity.mockResolvedValue(planRecord);
    // The host has since gone unhealthy — the timer must still observe and record this.
    listSessionHosts.mockResolvedValue([liveSessionHost({ name: 'avd-con-1', status: 'Available', healthChecks: [{ name: 'x', healthCheckResult: 'HealthCheckFailed' }] })]);
    getVmImageReference.mockResolvedValue({ exactVersion: '3.0.0' });

    await runTimer();

    expect(replaceRolloutPlanEntity).toHaveBeenCalledTimes(1);
    const [entityArg] = replaceRolloutPlanEntity.mock.calls[0] as [RolloutPlanEntity];
    const host = JSON.parse(entityArg.newHostsJson)[0];
    expect(host.status).toBe('validated'); // NOT regressed to 'available'/'registered'
    expect(host.healthy).toBe(false); // but the degradation IS now visible
  });
});

describe('rolloutPlanTimer — AM-47 config-check poll (validating_new)', () => {
  // Matches app/api/src/lib/config.ts's fslogixBaseline defaults given the unset
  // STORAGE_ACCOUNT_NAME/FSLOGIX_SHARE_NAME env vars this file's beforeEach leaves unset.
  const DEFAULT_BASELINE = {
    Enabled: '1',
    VHDLocations: '\\\\stcontoso001.file.core.windows.net\\fslogixprofiles',
    VolumeType: 'VHDX',
    SizeInMBs: '30000',
    FlipFlopProfileDirectoryName: '1',
  };

  function markerOutput(overrides: Partial<typeof DEFAULT_BASELINE> = {}): string {
    return `${FSLOGIX_CHECK_OUTPUT_MARKER}${JSON.stringify({ ...DEFAULT_BASELINE, ...overrides })}`;
  }

  function inProgressHost(overrides: Partial<RolloutNewHost> = {}): RolloutNewHost {
    return { sessionHostName: 'avd-con-1', status: 'available', healthy: true, configCheck: { status: 'in_progress', submittedAt: '2026-08-22T10:00:00.000Z' }, ...overrides };
  }

  it('marks passed with an empty diffs array when the delivered config matches the baseline exactly', async () => {
    const planRecord = record({ state: 'validating_new', newHostsJson: JSON.stringify([inProgressHost()]) });
    listRolloutPlanEntities.mockResolvedValue([planRecord]);
    getRolloutPlanEntity.mockResolvedValue(planRecord);
    listSessionHosts.mockResolvedValue([liveSessionHost({ name: 'avd-con-1', status: 'Available', healthChecks: [{ name: 'x', healthCheckResult: 'HealthCheckSucceeded' }] })]);
    getFslogixConfigCheckResult.mockResolvedValue({ executionState: 'Succeeded', exitCode: 0, output: markerOutput() });

    await runTimer();

    const [entityArg] = replaceRolloutPlanEntity.mock.calls[0] as [RolloutPlanEntity];
    const host = JSON.parse(entityArg.newHostsJson)[0];
    expect(host.configCheck).toMatchObject({ status: 'passed', diffs: [] });
    expect(host.configCheck.completedAt).toBeDefined();
  });

  it('marks failed with the diverged keys populated in diffs when the delivered config diverges from the baseline', async () => {
    const planRecord = record({ state: 'validating_new', newHostsJson: JSON.stringify([inProgressHost()]) });
    listRolloutPlanEntities.mockResolvedValue([planRecord]);
    getRolloutPlanEntity.mockResolvedValue(planRecord);
    listSessionHosts.mockResolvedValue([liveSessionHost({ name: 'avd-con-1', status: 'Available', healthChecks: [{ name: 'x', healthCheckResult: 'HealthCheckSucceeded' }] })]);
    getFslogixConfigCheckResult.mockResolvedValue({ executionState: 'Succeeded', exitCode: 0, output: markerOutput({ VolumeType: 'VHD' }) });

    await runTimer();

    const [entityArg] = replaceRolloutPlanEntity.mock.calls[0] as [RolloutPlanEntity];
    const host = JSON.parse(entityArg.newHostsJson)[0];
    expect(host.configCheck.status).toBe('failed');
    expect(host.configCheck.diffs).toEqual([{ key: 'VolumeType', expected: 'VHDX', actual: 'VHD' }]);
  });

  it('STALE-RESULT GUARD: a terminal result whose endTime predates submittedAt stays in_progress instead of accepting the prior run\'s output', async () => {
    const recentSubmittedAt = new Date(Date.now() - 60_000).toISOString(); // 1 min ago — well inside the stuck timeout.
    const priorRunEndTime = new Date(Date.now() - 600_000); // 10 min ago — clearly the PREVIOUS execution's result.
    const planRecord = record({ state: 'validating_new', newHostsJson: JSON.stringify([inProgressHost({ configCheck: { status: 'in_progress', submittedAt: recentSubmittedAt } })]) });
    listRolloutPlanEntities.mockResolvedValue([planRecord]);
    getRolloutPlanEntity.mockResolvedValue(planRecord);
    listSessionHosts.mockResolvedValue([liveSessionHost({ name: 'avd-con-1', status: 'Available', healthChecks: [{ name: 'x', healthCheckResult: 'HealthCheckSucceeded' }] })]);
    getFslogixConfigCheckResult.mockResolvedValue({ executionState: 'Succeeded', exitCode: 0, output: markerOutput(), endTime: priorRunEndTime });

    await runTimer();

    // The host's configCheck must be UNCHANGED — still in_progress with the same submittedAt, no stale 'passed'.
    const persisted = replaceRolloutPlanEntity.mock.calls.map((call) => (call as [RolloutPlanEntity])[0]);
    for (const entityArg of persisted) {
      const host = JSON.parse(entityArg.newHostsJson)[0];
      expect(host.configCheck).toMatchObject({ status: 'in_progress', submittedAt: recentSubmittedAt });
    }
  });

  it('STALE-RESULT GUARD: a terminal result whose endTime is AFTER submittedAt is accepted normally', async () => {
    const recentSubmittedAt = new Date(Date.now() - 120_000).toISOString();
    const freshEndTime = new Date(Date.now() - 30_000); // ended after this check was submitted — genuinely this run's result.
    const planRecord = record({ state: 'validating_new', newHostsJson: JSON.stringify([inProgressHost({ configCheck: { status: 'in_progress', submittedAt: recentSubmittedAt } })]) });
    listRolloutPlanEntities.mockResolvedValue([planRecord]);
    getRolloutPlanEntity.mockResolvedValue(planRecord);
    listSessionHosts.mockResolvedValue([liveSessionHost({ name: 'avd-con-1', status: 'Available', healthChecks: [{ name: 'x', healthCheckResult: 'HealthCheckSucceeded' }] })]);
    getFslogixConfigCheckResult.mockResolvedValue({ executionState: 'Succeeded', exitCode: 0, output: markerOutput(), endTime: freshEndTime });

    await runTimer();

    const [entityArg] = replaceRolloutPlanEntity.mock.calls[0] as [RolloutPlanEntity];
    const host = JSON.parse(entityArg.newHostsJson)[0];
    expect(host.configCheck).toMatchObject({ status: 'passed', diffs: [] });
  });

  it('marks error when the run command output cannot be parsed at all', async () => {
    const planRecord = record({ state: 'validating_new', newHostsJson: JSON.stringify([inProgressHost()]) });
    listRolloutPlanEntities.mockResolvedValue([planRecord]);
    getRolloutPlanEntity.mockResolvedValue(planRecord);
    listSessionHosts.mockResolvedValue([liveSessionHost({ name: 'avd-con-1', status: 'Available', healthChecks: [{ name: 'x', healthCheckResult: 'HealthCheckSucceeded' }] })]);
    getFslogixConfigCheckResult.mockResolvedValue({ executionState: 'Succeeded', exitCode: 0, output: 'no marker line here at all' });

    await runTimer();

    const [entityArg] = replaceRolloutPlanEntity.mock.calls[0] as [RolloutPlanEntity];
    const host = JSON.parse(entityArg.newHostsJson)[0];
    expect(host.configCheck.status).toBe('error');
    expect(typeof host.configCheck.error).toBe('string');
  });

  it('marks error on a nonzero exit code even with an otherwise-parsable marker line', async () => {
    const planRecord = record({ state: 'validating_new', newHostsJson: JSON.stringify([inProgressHost()]) });
    listRolloutPlanEntities.mockResolvedValue([planRecord]);
    getRolloutPlanEntity.mockResolvedValue(planRecord);
    listSessionHosts.mockResolvedValue([liveSessionHost({ name: 'avd-con-1', status: 'Available', healthChecks: [{ name: 'x', healthCheckResult: 'HealthCheckSucceeded' }] })]);
    getFslogixConfigCheckResult.mockResolvedValue({ executionState: 'Succeeded', exitCode: 1, output: markerOutput() });

    await runTimer();

    const [entityArg] = replaceRolloutPlanEntity.mock.calls[0] as [RolloutPlanEntity];
    expect(JSON.parse(entityArg.newHostsJson)[0].configCheck.status).toBe('error');
  });

  it('marks error when the run command itself reports Failed/TimedOut/Canceled', async () => {
    const planRecord = record({ state: 'validating_new', newHostsJson: JSON.stringify([inProgressHost()]) });
    listRolloutPlanEntities.mockResolvedValue([planRecord]);
    getRolloutPlanEntity.mockResolvedValue(planRecord);
    listSessionHosts.mockResolvedValue([liveSessionHost({ name: 'avd-con-1', status: 'Available', healthChecks: [{ name: 'x', healthCheckResult: 'HealthCheckSucceeded' }] })]);
    getFslogixConfigCheckResult.mockResolvedValue({ executionState: 'Failed' });

    await runTimer();

    const [entityArg] = replaceRolloutPlanEntity.mock.calls[0] as [RolloutPlanEntity];
    expect(JSON.parse(entityArg.newHostsJson)[0].configCheck.status).toBe('error');
  });

  it('leaves the host in_progress when still Running and submittedAt is under 15 minutes old', async () => {
    const recentSubmit = new Date(Date.now() - 5 * 60_000).toISOString();
    const planRecord = record({ state: 'validating_new', newHostsJson: JSON.stringify([inProgressHost({ configCheck: { status: 'in_progress', submittedAt: recentSubmit } })]) });
    listRolloutPlanEntities.mockResolvedValue([planRecord]);
    getRolloutPlanEntity.mockResolvedValue(planRecord);
    listSessionHosts.mockResolvedValue([liveSessionHost({ name: 'avd-con-1', status: 'Available', healthChecks: [{ name: 'x', healthCheckResult: 'HealthCheckSucceeded' }] })]);
    getFslogixConfigCheckResult.mockResolvedValue({ executionState: 'Running' });

    await runTimer();

    if (replaceRolloutPlanEntity.mock.calls.length > 0) {
      const [entityArg] = replaceRolloutPlanEntity.mock.calls[0] as [RolloutPlanEntity];
      expect(JSON.parse(entityArg.newHostsJson)[0].configCheck.status).toBe('in_progress');
    }
  });

  it('marks a "timed out" error once submittedAt is older than 15 minutes and still Running', async () => {
    const staleSubmit = new Date(Date.now() - 20 * 60_000).toISOString();
    const planRecord = record({ state: 'validating_new', newHostsJson: JSON.stringify([inProgressHost({ configCheck: { status: 'in_progress', submittedAt: staleSubmit } })]) });
    listRolloutPlanEntities.mockResolvedValue([planRecord]);
    getRolloutPlanEntity.mockResolvedValue(planRecord);
    listSessionHosts.mockResolvedValue([liveSessionHost({ name: 'avd-con-1', status: 'Available', healthChecks: [{ name: 'x', healthCheckResult: 'HealthCheckSucceeded' }] })]);
    getFslogixConfigCheckResult.mockResolvedValue({ executionState: 'Running' });

    await runTimer();

    const [entityArg] = replaceRolloutPlanEntity.mock.calls[0] as [RolloutPlanEntity];
    const host = JSON.parse(entityArg.newHostsJson)[0];
    expect(host.configCheck.status).toBe('error');
    expect(host.configCheck.error).toMatch(/timed out/i);
  });

  it('leaves the prior configCheck value untouched on a transient GET failure', async () => {
    const planRecord = record({ state: 'validating_new', newHostsJson: JSON.stringify([inProgressHost()]) });
    listRolloutPlanEntities.mockResolvedValue([planRecord]);
    getRolloutPlanEntity.mockResolvedValue(planRecord);
    listSessionHosts.mockResolvedValue([liveSessionHost({ name: 'avd-con-1', status: 'Available', healthChecks: [{ name: 'x', healthCheckResult: 'HealthCheckSucceeded' }] })]);
    getFslogixConfigCheckResult.mockRejectedValue(new Error('transient ARM error'));

    await runTimer();

    // Health/status refresh from refreshNewHosts still applies (no change here since already available+healthy),
    // so the write may or may not happen — either way the configCheck itself must be untouched if it did.
    if (replaceRolloutPlanEntity.mock.calls.length > 0) {
      const [entityArg] = replaceRolloutPlanEntity.mock.calls[0] as [RolloutPlanEntity];
      expect(JSON.parse(entityArg.newHostsJson)[0].configCheck).toEqual({ status: 'in_progress', submittedAt: '2026-08-22T10:00:00.000Z' });
    }
  });

  it('does not re-poll (getFslogixConfigCheckResult not called) a host already passed', async () => {
    const planRecord = record({
      state: 'validating_new',
      newHostsJson: JSON.stringify([inProgressHost({ configCheck: { status: 'passed', diffs: [], submittedAt: '2026-08-22T09:00:00.000Z', completedAt: '2026-08-22T09:01:00.000Z' } })]),
    });
    listRolloutPlanEntities.mockResolvedValue([planRecord]);
    getRolloutPlanEntity.mockResolvedValue(planRecord);
    listSessionHosts.mockResolvedValue([liveSessionHost({ name: 'avd-con-1', status: 'Available', healthChecks: [{ name: 'x', healthCheckResult: 'HealthCheckSucceeded' }] })]);

    await runTimer();

    expect(getFslogixConfigCheckResult).not.toHaveBeenCalled();
  });

  it('does not re-poll a host already failed or errored either', async () => {
    const planRecord = record({
      state: 'validating_new',
      newHostsJson: JSON.stringify([
        inProgressHost({ sessionHostName: 'avd-con-1', configCheck: { status: 'failed', diffs: [{ key: 'Enabled', expected: '1', actual: '0' }] } }),
        inProgressHost({ sessionHostName: 'avd-con-2', configCheck: { status: 'error', error: 'Azure request failed.' } }),
      ]),
    });
    listRolloutPlanEntities.mockResolvedValue([planRecord]);
    getRolloutPlanEntity.mockResolvedValue(planRecord);
    listSessionHosts.mockResolvedValue([
      liveSessionHost({ name: 'avd-con-1', status: 'Available', healthChecks: [{ name: 'x', healthCheckResult: 'HealthCheckSucceeded' }] }),
      liveSessionHost({ name: 'avd-con-2', status: 'Available', healthChecks: [{ name: 'x', healthCheckResult: 'HealthCheckSucceeded' }] }),
    ]);

    await runTimer();

    expect(getFslogixConfigCheckResult).not.toHaveBeenCalled();
  });

  it('uses the plan\'s frozen configBaselineJson when present, not the current live config default', async () => {
    const customBaseline = { ...DEFAULT_BASELINE, SizeInMBs: '99999' };
    const planRecord = record({ state: 'validating_new', newHostsJson: JSON.stringify([inProgressHost()]), configBaselineJson: JSON.stringify(customBaseline) });
    listRolloutPlanEntities.mockResolvedValue([planRecord]);
    getRolloutPlanEntity.mockResolvedValue(planRecord);
    listSessionHosts.mockResolvedValue([liveSessionHost({ name: 'avd-con-1', status: 'Available', healthChecks: [{ name: 'x', healthCheckResult: 'HealthCheckSucceeded' }] })]);
    // Delivered output matches the DEFAULT (live-config) baseline's SizeInMBs, which now DIVERGES from the plan's frozen custom baseline.
    getFslogixConfigCheckResult.mockResolvedValue({ executionState: 'Succeeded', exitCode: 0, output: markerOutput() });

    await runTimer();

    const [entityArg] = replaceRolloutPlanEntity.mock.calls[0] as [RolloutPlanEntity];
    const host = JSON.parse(entityArg.newHostsJson)[0];
    expect(host.configCheck.status).toBe('failed');
    expect(host.configCheck.diffs).toEqual([{ key: 'SizeInMBs', expected: '99999', actual: '30000' }]);
  });
});

describe('rolloutPlanTimer — AM-49 keep-alive (restart new hosts autoscale deallocates)', () => {
  function newHost(overrides: Partial<RolloutNewHost> = {}): RolloutNewHost {
    return { sessionHostName: 'avd-con-1', status: 'registered', ...overrides };
  }

  it('submits a start for a deallocated new host in awaiting_new_hosts, increments the restart count, sets lastKeepAliveAt, and writes one accepted audit row', async () => {
    const planRecord = record({ state: 'awaiting_new_hosts', newHostsJson: JSON.stringify([newHost()]) });
    listRolloutPlanEntities.mockResolvedValue([planRecord]);
    getRolloutPlanEntity.mockResolvedValue(planRecord);
    listSessionHosts.mockResolvedValue([liveSessionHost({ name: 'avd-con-1', status: 'Available', powerState: 'deallocated', healthChecks: [{ name: 'x', healthCheckResult: 'HealthCheckSucceeded' }] })]);

    await runTimer();

    expect(beginVmPowerAction).toHaveBeenCalledWith('RG-AVD-HostPools', 'avd-con-1', 'start');
    const [entityArg] = replaceRolloutPlanEntity.mock.calls[0] as [RolloutPlanEntity];
    const host = JSON.parse(entityArg.newHostsJson)[0];
    expect(host.keepAliveRestartCount).toBe(1);
    expect(host.lastKeepAliveAt).toEqual(expect.any(String));
    expect(host.keepAliveError).toBeUndefined();
    expect(writeAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'rollout.keep_alive_start',
        actor: 'system:rollout-timer',
        actorId: 'system',
        target: 'HP-CONTOSO-PROD/plan-1',
        outcome: 'accepted',
        parameters: expect.objectContaining({ sessionHostName: 'avd-con-1', resourceGroup: 'RG-AVD-HostPools', vmName: 'avd-con-1', restartCount: 1 }),
      }),
      expect.anything(),
    );
  });

  it('submits a start for a deallocated new host in validating_new too', async () => {
    const planRecord = record({ state: 'validating_new', newHostsJson: JSON.stringify([newHost({ status: 'available', healthy: true })]) });
    listRolloutPlanEntities.mockResolvedValue([planRecord]);
    getRolloutPlanEntity.mockResolvedValue(planRecord);
    listSessionHosts.mockResolvedValue([liveSessionHost({ name: 'avd-con-1', status: 'Available', powerState: 'stopped', healthChecks: [{ name: 'x', healthCheckResult: 'HealthCheckSucceeded' }] })]);

    await runTimer();

    expect(beginVmPowerAction).toHaveBeenCalledWith('RG-AVD-HostPools', 'avd-con-1', 'start');
    const [entityArg] = replaceRolloutPlanEntity.mock.calls[0] as [RolloutPlanEntity];
    const host = JSON.parse(entityArg.newHostsJson)[0];
    expect(host.keepAliveRestartCount).toBe(1);
  });

  it.each(['running', 'starting', 'unknown'] as const)('does not start a host observed %s', async (powerState) => {
    const planRecord = record({ state: 'awaiting_new_hosts', newHostsJson: JSON.stringify([newHost()]) });
    listRolloutPlanEntities.mockResolvedValue([planRecord]);
    getRolloutPlanEntity.mockResolvedValue(planRecord);
    listSessionHosts.mockResolvedValue([liveSessionHost({ name: 'avd-con-1', status: 'Available', powerState, healthChecks: [{ name: 'x', healthCheckResult: 'HealthCheckSucceeded' }] })]);

    await runTimer();

    expect(beginVmPowerAction).not.toHaveBeenCalled();
  });

  it.each(['stopping', 'deallocating'] as const)('does not start a host mid-transition (%s) — a start now would 409', async (powerState) => {
    const planRecord = record({ state: 'awaiting_new_hosts', newHostsJson: JSON.stringify([newHost()]) });
    listRolloutPlanEntities.mockResolvedValue([planRecord]);
    getRolloutPlanEntity.mockResolvedValue(planRecord);
    listSessionHosts.mockResolvedValue([liveSessionHost({ name: 'avd-con-1', status: 'Available', powerState, healthChecks: [{ name: 'x', healthCheckResult: 'HealthCheckSucceeded' }] })]);

    await runTimer();

    expect(beginVmPowerAction).not.toHaveBeenCalled();
  });

  it('at the restart cap, does not start and sets keepAliveError exactly once (not rewritten every tick)', async () => {
    const planRecord = record({
      state: 'awaiting_new_hosts',
      newHostsJson: JSON.stringify([newHost({ keepAliveRestartCount: 20, keepAliveError: 'Keep-alive restart limit reached — autoscale keeps deallocating this host; investigate the scaling plan.' })]),
    });
    listRolloutPlanEntities.mockResolvedValue([planRecord]);
    getRolloutPlanEntity.mockResolvedValue(planRecord);
    listSessionHosts.mockResolvedValue([liveSessionHost({ name: 'avd-con-1', status: 'Available', powerState: 'deallocated', healthChecks: [{ name: 'x', healthCheckResult: 'HealthCheckSucceeded' }] })]);

    await runTimer();

    expect(beginVmPowerAction).not.toHaveBeenCalled();
    // The host's keepAliveError is already the cap message — no NEW diff should be produced from keep-alive
    // alone, so whether or not a write happens depends only on refreshNewHosts' own fields changing.
    if (replaceRolloutPlanEntity.mock.calls.length > 0) {
      const [entityArg] = replaceRolloutPlanEntity.mock.calls[0] as [RolloutPlanEntity];
      const host = JSON.parse(entityArg.newHostsJson)[0];
      expect(host.keepAliveRestartCount).toBe(20);
      expect(host.keepAliveError).toBe('Keep-alive restart limit reached — autoscale keeps deallocating this host; investigate the scaling plan.');
    }
  });

  it('reaches the cap and sets keepAliveError for the first time once keepAliveRestartCount hits 20', async () => {
    const planRecord = record({ state: 'awaiting_new_hosts', newHostsJson: JSON.stringify([newHost({ keepAliveRestartCount: 20 })]) });
    listRolloutPlanEntities.mockResolvedValue([planRecord]);
    getRolloutPlanEntity.mockResolvedValue(planRecord);
    listSessionHosts.mockResolvedValue([liveSessionHost({ name: 'avd-con-1', status: 'Available', powerState: 'deallocated', healthChecks: [{ name: 'x', healthCheckResult: 'HealthCheckSucceeded' }] })]);

    await runTimer();

    expect(beginVmPowerAction).not.toHaveBeenCalled();
    const [entityArg] = replaceRolloutPlanEntity.mock.calls[0] as [RolloutPlanEntity];
    const host = JSON.parse(entityArg.newHostsJson)[0];
    expect(host.keepAliveError).toBe('Keep-alive restart limit reached — autoscale keeps deallocating this host; investigate the scaling plan.');
  });

  it('a submit rejection persists a generic keepAliveError, increments the restart count, leaves other hosts unaffected, and does not set the plan-level lastTimerError', async () => {
    const planRecord = record({
      state: 'awaiting_new_hosts',
      newHostsJson: JSON.stringify([newHost({ sessionHostName: 'avd-con-1' }), newHost({ sessionHostName: 'avd-con-2' })]),
    });
    listRolloutPlanEntities.mockResolvedValue([planRecord]);
    getRolloutPlanEntity.mockResolvedValue(planRecord);
    listSessionHosts.mockResolvedValue([
      liveSessionHost({ name: 'avd-con-1', status: 'Available', powerState: 'deallocated', healthChecks: [{ name: 'x', healthCheckResult: 'HealthCheckSucceeded' }] }),
      liveSessionHost({ name: 'avd-con-2', status: 'Available', powerState: 'running', healthChecks: [{ name: 'x', healthCheckResult: 'HealthCheckSucceeded' }] }),
    ]);
    beginVmPowerAction.mockRejectedValue(Object.assign(new Error('secret internal ARM detail'), { statusCode: 403 }));

    const context = await runTimer();

    const [entityArg] = replaceRolloutPlanEntity.mock.calls[0] as [RolloutPlanEntity];
    const hosts = JSON.parse(entityArg.newHostsJson);
    const host1 = hosts.find((h: RolloutNewHost) => h.sessionHostName === 'avd-con-1');
    const host2 = hosts.find((h: RolloutNewHost) => h.sessionHostName === 'avd-con-2');
    expect(host1.keepAliveRestartCount).toBe(1);
    expect(host1.keepAliveError).toBe('Azure denied the automatic restart request (permissions).');
    expect(host1.keepAliveError).not.toContain('secret internal ARM detail');
    expect(context.warnings.some((w) => w.includes('secret internal ARM detail'))).toBe(true);
    expect(host2.keepAliveRestartCount ?? 0).toBe(0);
    expect(entityArg.lastTimerError).toBeUndefined();
    expect(writeAuditEntry).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'rollout.keep_alive_start' }), expect.anything());
  });

  it("persists the observed powerState onto newHostsJson every tick", async () => {
    const planRecord = record({ state: 'validating_new', newHostsJson: JSON.stringify([newHost({ status: 'available', healthy: true })]) });
    listRolloutPlanEntities.mockResolvedValue([planRecord]);
    getRolloutPlanEntity.mockResolvedValue(planRecord);
    listSessionHosts.mockResolvedValue([liveSessionHost({ name: 'avd-con-1', status: 'Available', powerState: 'running', healthChecks: [{ name: 'x', healthCheckResult: 'HealthCheckSucceeded' }] })]);

    await runTimer();

    const [entityArg] = replaceRolloutPlanEntity.mock.calls[0] as [RolloutPlanEntity];
    expect(JSON.parse(entityArg.newHostsJson)[0].powerState).toBe('running');
  });

  it('resolves new-host power state (resolvePowerState: true) but leaves the old-host pass at resolvePowerState: false', async () => {
    const planRecord = record({ state: 'awaiting_new_hosts', newHostsJson: JSON.stringify([newHost()]) });
    listRolloutPlanEntities.mockResolvedValue([planRecord]);
    getRolloutPlanEntity.mockResolvedValue(planRecord);
    listSessionHosts.mockResolvedValue([liveSessionHost({ name: 'avd-con-1', status: 'Available', powerState: 'running', healthChecks: [{ name: 'x', healthCheckResult: 'HealthCheckSucceeded' }] })]);

    await runTimer();

    expect(listSessionHosts).toHaveBeenCalledWith('HP-CONTOSO-PROD', { resolvePowerState: true });
  });

  it('never calls beginVmPowerAction for a plan in draining_old, even with a deallocated-looking old host', async () => {
    const planRecord = record({ state: 'draining_old', oldHostsJson: JSON.stringify([oldHost()]) });
    listRolloutPlanEntities.mockResolvedValue([planRecord]);
    getRolloutPlanEntity.mockResolvedValue(planRecord);
    listSessionHosts.mockResolvedValue([liveSessionHost({ activeSessions: 0, allowNewSession: false, powerState: 'deallocated' })]);

    await runTimer();

    expect(beginVmPowerAction).not.toHaveBeenCalled();
  });

  it('never calls beginVmPowerAction for a terminal plan (not polled at all)', async () => {
    listRolloutPlanEntities.mockResolvedValue([record({ state: 'done' })]);

    await runTimer();

    expect(beginVmPowerAction).not.toHaveBeenCalled();
    expect(getRolloutPlanEntity).not.toHaveBeenCalled();
  });
});

describe('rolloutPlanTimer — ETag conflict handling', () => {
  it('skips (does not throw / does not stop the run) when replaceRolloutPlanEntity hits a 412 — an operator action raced this tick', async () => {
    const planRecord = record({ state: 'draining_old' });
    listRolloutPlanEntities.mockResolvedValue([planRecord]);
    getRolloutPlanEntity.mockResolvedValue(planRecord);
    listSessionHosts.mockResolvedValue([liveSessionHost({ activeSessions: 0, allowNewSession: false })]);
    replaceRolloutPlanEntity.mockRejectedValue(Object.assign(new Error('PreconditionFailed'), { statusCode: 412 }));

    const context = await runTimer();

    expect(context.errors.length).toBe(0);
  });
});

describe('rolloutPlanTimer — error isolation across plans', () => {
  it("one plan's polling failure does not stop the others from advancing", async () => {
    const brokenPlan = record({ rowKey: 'plan-broken', state: 'draining_old' });
    const healthyPlan = record({ rowKey: 'plan-healthy', state: 'draining_old' });
    listRolloutPlanEntities.mockResolvedValue([brokenPlan, healthyPlan]);
    getRolloutPlanEntity.mockImplementation(async (_hp: string, planId: string) => {
      if (planId === 'plan-broken') throw new Error('table unreachable');
      return healthyPlan;
    });
    listSessionHosts.mockResolvedValue([liveSessionHost({ activeSessions: 0, allowNewSession: false })]);

    const context = await runTimer();

    expect(replaceRolloutPlanEntity).toHaveBeenCalledTimes(1);
    const [entityArg] = replaceRolloutPlanEntity.mock.calls[0] as [RolloutPlanEntity];
    expect(entityArg.rowKey).toBe('plan-healthy');
    expect(context.errors.length).toBeGreaterThan(0);
  });
});
