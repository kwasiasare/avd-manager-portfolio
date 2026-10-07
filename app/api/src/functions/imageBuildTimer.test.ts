import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InvocationContext, Timer } from '@azure/functions';
import type { ImageBuildEntity } from '../services/imageBuildService';

const listInFlightImageBuilds = vi.fn();
const getImageBuild = vi.fn();
const replaceImageBuild = vi.fn();
vi.mock('../services/imageBuildService', async () => {
  const actual = await vi.importActual<typeof import('../services/imageBuildService')>('../services/imageBuildService');
  return {
    ...actual,
    listInFlightImageBuilds: (...args: unknown[]) => listInFlightImageBuilds(...args),
    getImageBuild: (...args: unknown[]) => getImageBuild(...args),
    replaceImageBuild: (...args: unknown[]) => replaceImageBuild(...args),
  };
});

const pollVmCreating = vi.fn();
const advanceVmReady = vi.fn();
const pollSnapshotting = vi.fn();
const submitSysprepIfNeeded = vi.fn();
const pollAwaitingStopped = vi.fn();
const pollCapturing = vi.fn();
const pollCleanup = vi.fn();
const reconcilePlanned = vi.fn();
const resolvePlanContext = vi.fn();
vi.mock('../services/imageBuildOrchestrator', () => ({
  pollVmCreating: (...args: unknown[]) => pollVmCreating(...args),
  advanceVmReady: (...args: unknown[]) => advanceVmReady(...args),
  pollSnapshotting: (...args: unknown[]) => pollSnapshotting(...args),
  submitSysprepIfNeeded: (...args: unknown[]) => submitSysprepIfNeeded(...args),
  pollAwaitingStopped: (...args: unknown[]) => pollAwaitingStopped(...args),
  pollCapturing: (...args: unknown[]) => pollCapturing(...args),
  pollCleanup: (...args: unknown[]) => pollCleanup(...args),
  reconcilePlanned: (...args: unknown[]) => reconcilePlanned(...args),
  resolvePlanContext: (...args: unknown[]) => resolvePlanContext(...args),
}));

const writeAuditEntry = vi.fn().mockResolvedValue(undefined);
vi.mock('../lib/auditLog', () => ({ writeAuditEntry: (...args: unknown[]) => writeAuditEntry(...args) }));

const { imageBuildTimer } = await import('./imageBuildTimer');

function makeContext(): InvocationContext & { errors: unknown[]; logs: string[] } {
  const errors: unknown[] = [];
  const logs: string[] = [];
  return { warn: () => {}, error: (...a: unknown[]) => errors.push(a), log: (...a: unknown[]) => logs.push(a.join(' ')), errors, logs } as unknown as InvocationContext & { errors: unknown[]; logs: string[] };
}
const FAKE_TIMER = {} as Timer;

function entity(overrides: Partial<ImageBuildEntity> = {}): ImageBuildEntity & { etag: string } {
  return {
    partitionKey: 'build',
    rowKey: 'build-1',
    buildId: 'build-1',
    version: '2.1.0',
    state: 'vm_creating',
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
    planContextJson:
      '{"subscriptionId":"sub-id","resourceGroup":"RG-AVD-Images","location":"eastus","galleryName":"ACG_AVD_CONTOSO","imageDefinitionName":"WIN11-ENT-MS-M365","subnetId":"/subscriptions/sub/resourceGroups/RG-AVD-Network/providers/Microsoft.Network/virtualNetworks/VNET/subnets/SNET-IMAGEBUILD","vmSize":"Standard_D4ads_v7"}',
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
  listInFlightImageBuilds.mockReset().mockResolvedValue([]);
  getImageBuild.mockReset();
  replaceImageBuild.mockReset().mockResolvedValue(undefined);
  for (const fn of [pollVmCreating, advanceVmReady, pollSnapshotting, submitSysprepIfNeeded, pollAwaitingStopped, pollCapturing, pollCleanup, reconcilePlanned]) fn.mockReset();
  resolvePlanContext.mockReset();
  writeAuditEntry.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
});

describe('imageBuildTimer — dispatch by state', () => {
  it('does nothing when there are no in-flight builds', async () => {
    const context = makeContext();
    await imageBuildTimer(FAKE_TIMER, context);
    expect(replaceImageBuild).not.toHaveBeenCalled();
  });

  it('NEVER calls any poll function for a build in an operator-gated state (checklist_gate, test_host_step)', async () => {
    listInFlightImageBuilds.mockResolvedValue([entity({ state: 'checklist_gate' }), entity({ buildId: 'build-2', rowKey: 'build-2', state: 'test_host_step' })]);
    const context = makeContext();
    await imageBuildTimer(FAKE_TIMER, context);
    for (const fn of [pollVmCreating, advanceVmReady, pollSnapshotting, submitSysprepIfNeeded, pollAwaitingStopped, pollCapturing, pollCleanup]) {
      expect(fn).not.toHaveBeenCalled();
    }
    expect(replaceImageBuild).not.toHaveBeenCalled();
  });

  it('dispatches vm_creating to pollVmCreating, persists the returned state, and audits with buildId/from/to', async () => {
    const row = entity({ state: 'vm_creating' });
    listInFlightImageBuilds.mockResolvedValue([row]);
    getImageBuild.mockResolvedValue(row);
    pollVmCreating.mockResolvedValue({ nextState: 'vm_ready', steps: [] });

    const context = makeContext();
    await imageBuildTimer(FAKE_TIMER, context);

    expect(pollVmCreating).toHaveBeenCalledWith(row);
    expect(replaceImageBuild).toHaveBeenCalledWith(expect.objectContaining({ buildId: 'build-1', state: 'vm_ready' }), 'W/"etag-1"');
    expect(writeAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'image.build.timer_advance',
        target: 'build-1',
        parameters: { buildId: 'build-1', from: 'vm_creating', to: 'vm_ready' },
        outcome: 'success',
      }),
      expect.anything(),
    );
  });

  it('does nothing when the poll function returns null (still waiting on Azure)', async () => {
    const row = entity({ state: 'vm_creating' });
    listInFlightImageBuilds.mockResolvedValue([row]);
    pollVmCreating.mockResolvedValue(null);

    await imageBuildTimer(FAKE_TIMER, makeContext());

    expect(getImageBuild).not.toHaveBeenCalled();
    expect(replaceImageBuild).not.toHaveBeenCalled();
  });

  it('DOUBLE-READ RACE GUARD: skips the write if a fresh read shows the build already moved on (e.g. a concurrent cancel)', async () => {
    const row = entity({ state: 'vm_creating' });
    listInFlightImageBuilds.mockResolvedValue([row]);
    pollVmCreating.mockResolvedValue({ nextState: 'vm_ready', steps: [] });
    getImageBuild.mockResolvedValue(entity({ state: 'cancelled' })); // changed since listing

    await imageBuildTimer(FAKE_TIMER, makeContext());

    expect(replaceImageBuild).not.toHaveBeenCalled();
  });

  it('an ETag conflict on write is logged and NOT fatal — other builds still get processed', async () => {
    const row1 = entity({ buildId: 'build-1', rowKey: 'build-1', state: 'vm_creating' });
    const row2 = entity({ buildId: 'build-2', rowKey: 'build-2', state: 'snapshotting', etag: 'W/"etag-2"' });
    listInFlightImageBuilds.mockResolvedValue([row1, row2]);
    pollVmCreating.mockResolvedValue({ nextState: 'vm_ready', steps: [] });
    pollSnapshotting.mockResolvedValue({ nextState: 'sysprep_running', steps: [] });
    getImageBuild.mockImplementation(async (id: string) => (id === 'build-1' ? row1 : row2));
    replaceImageBuild.mockImplementation(async (_entity: unknown, etag: string) => {
      if (etag === row1.etag) {
        throw Object.assign(new Error('precondition failed'), { statusCode: 412 });
      }
    });

    const context = makeContext();
    await imageBuildTimer(FAKE_TIMER, context);

    expect(replaceImageBuild).toHaveBeenCalledTimes(2);
    // build-2's advance still succeeded despite build-1's conflict.
    expect(writeAuditEntry).toHaveBeenCalledWith(expect.objectContaining({ target: 'build-2', outcome: 'success' }), expect.anything());
  });

  it('vm_ready advances unconditionally to checklist_gate (nothing to poll)', async () => {
    const row = entity({ state: 'vm_ready' });
    listInFlightImageBuilds.mockResolvedValue([row]);
    getImageBuild.mockResolvedValue(row);
    advanceVmReady.mockReturnValue({ nextState: 'checklist_gate', steps: [] });

    await imageBuildTimer(FAKE_TIMER, makeContext());

    expect(advanceVmReady).toHaveBeenCalledWith(row);
    expect(replaceImageBuild).toHaveBeenCalledWith(expect.objectContaining({ state: 'checklist_gate' }), row.etag);
  });

  it('cleanup dispatches to pollCleanup and can advance straight to done', async () => {
    const row = entity({ state: 'cleanup' });
    listInFlightImageBuilds.mockResolvedValue([row]);
    getImageBuild.mockResolvedValue(row);
    pollCleanup.mockResolvedValue({ nextState: 'done', steps: [] });

    await imageBuildTimer(FAKE_TIMER, makeContext());

    // AM-48 — pollCleanup now also receives the AuditLogger-shaped logger built from `context`
    // (so it can emit the IMAGE_BUILD_CLEANUP_SELFHEAL marker) as a third argument; `now` (2nd
    // arg) stays undefined so pollCleanup's own default (`new Date()`) applies.
    expect(pollCleanup).toHaveBeenCalledWith(row, undefined, expect.objectContaining({ warn: expect.any(Function), error: expect.any(Function), log: expect.any(Function) }));
    expect(replaceImageBuild).toHaveBeenCalledWith(expect.objectContaining({ state: 'done' }), row.etag);
  });

  it('a failed poll (nextState: failed) is audited with outcome failure', async () => {
    const row = entity({ state: 'vm_creating' });
    listInFlightImageBuilds.mockResolvedValue([row]);
    getImageBuild.mockResolvedValue(row);
    pollVmCreating.mockResolvedValue({ nextState: 'failed', steps: [], errorMessage: 'VM provisioning failed.' });

    await imageBuildTimer(FAKE_TIMER, makeContext());

    expect(writeAuditEntry).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failure', detail: 'VM provisioning failed.' }), expect.anything());
  });

  it('planned dispatches to reconcilePlanned (Opus review BLOCKER/MAJOR 4 — stranded planned state)', async () => {
    const row = entity({ state: 'planned' });
    listInFlightImageBuilds.mockResolvedValue([row]);
    getImageBuild.mockResolvedValue(row);
    reconcilePlanned.mockResolvedValue({ nextState: 'vm_creating', steps: [] });

    await imageBuildTimer(FAKE_TIMER, makeContext());

    expect(reconcilePlanned).toHaveBeenCalledWith(row);
    expect(replaceImageBuild).toHaveBeenCalledWith(expect.objectContaining({ state: 'vm_creating' }), row.etag);
  });

  it('SELF-TRANSITION (Opus review BLOCKER 1): a poll function returning the SAME state is persisted WITHOUT throwing/being swallowed', async () => {
    const row = entity({ state: 'capturing', stepsJson: JSON.stringify([{ stepId: 'ensure_deallocated', status: 'succeeded' }, { stepId: 'generalize_vm', status: 'succeeded' }]) });
    listInFlightImageBuilds.mockResolvedValue([row]);
    getImageBuild.mockResolvedValue(row);
    pollCapturing.mockResolvedValue({ nextState: 'capturing', steps: [{ stepId: 'capture_image_version', status: 'in_progress' }] });

    await imageBuildTimer(FAKE_TIMER, makeContext());

    // The critical assertion: this self-transition is PERSISTED (not silently dropped by a thrown-and-caught IllegalImageBuildTransitionError).
    expect(replaceImageBuild).toHaveBeenCalledWith(expect.objectContaining({ state: 'capturing', stepsJson: JSON.stringify([{ stepId: 'capture_image_version', status: 'in_progress' }]) }), row.etag);
    expect(writeAuditEntry).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'success', parameters: { buildId: row.buildId, from: 'capturing', to: 'capturing' } }), expect.anything());
  });
});

describe('checklist_gate abandonment warning (Opus review MAJOR 10)', () => {
  it('does NOT poll/advance a checklist_gate build (still operator-gated for state changes)', async () => {
    const row = entity({ state: 'checklist_gate', createdAt: '2026-08-16T00:00:00.000Z' });
    listInFlightImageBuilds.mockResolvedValue([row]);
    getImageBuild.mockResolvedValue(row);

    await imageBuildTimer(FAKE_TIMER, makeContext());

    for (const fn of [pollVmCreating, advanceVmReady, pollSnapshotting, submitSysprepIfNeeded, pollAwaitingStopped, pollCapturing, pollCleanup, reconcilePlanned]) {
      expect(fn).not.toHaveBeenCalled();
    }
  });

  it('sets abandonedWarning (an audited warning, NOT a state change) once the build has sat at checklist_gate past the configured threshold', async () => {
    process.env.IMAGE_BUILD_ABANDONMENT_HOURS = '24';
    const row = entity({ state: 'checklist_gate', createdAt: '2026-08-01T00:00:00.000Z' }); // far more than 24h before "now".
    listInFlightImageBuilds.mockResolvedValue([row]);
    getImageBuild.mockResolvedValue(row);

    await imageBuildTimer(FAKE_TIMER, makeContext());

    expect(replaceImageBuild).toHaveBeenCalledWith(expect.objectContaining({ state: 'checklist_gate', abandonedWarning: expect.stringContaining('24 hours') }), row.etag);
    expect(writeAuditEntry).toHaveBeenCalledWith(expect.objectContaining({ action: 'image.build.abandonment_warning', outcome: 'success' }), expect.anything());
  });

  it('does NOT re-warn (no second write) once abandonedWarning is already set', async () => {
    const row = entity({ state: 'checklist_gate', createdAt: '2026-08-01T00:00:00.000Z', abandonedWarning: 'already warned' });
    listInFlightImageBuilds.mockResolvedValue([row]);

    await imageBuildTimer(FAKE_TIMER, makeContext());

    expect(replaceImageBuild).not.toHaveBeenCalled();
    expect(getImageBuild).not.toHaveBeenCalled();
  });

  it('does not warn while still under the threshold', async () => {
    const row = entity({ state: 'checklist_gate', createdAt: '2026-08-16T00:00:00.000Z' }); // "now" in these tests is real time — this is essentially "just now".
    listInFlightImageBuilds.mockResolvedValue([row]);

    await imageBuildTimer(FAKE_TIMER, makeContext());

    expect(replaceImageBuild).not.toHaveBeenCalled();
  });
});
