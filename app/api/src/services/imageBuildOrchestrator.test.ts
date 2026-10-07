import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ImageBuildPlan } from '@avdmgr/shared';
import { generateImageBuildPlan, type ImageBuildPlanContext } from '../lib/imageBuildPlan';
import type { ImageBuildEntity } from './imageBuildService';

function makePoller(name: string, calls: string[], resolvedValue: unknown = undefined) {
  return {
    submitted: vi.fn(async () => {
      calls.push(`${name}.submitted`);
    }),
    pollUntilDone: vi.fn(async () => {
      calls.push(`${name}.pollUntilDone`);
      return resolvedValue;
    }),
  };
}

/** AM-48 — a minimal AuditLogger test double so pollCleanup's optional `logger` param can be asserted on without pulling in real audit plumbing. */
function fakeLogger() {
  return { warn: vi.fn(), error: vi.fn(), log: vi.fn() };
}

const calls: string[] = [];

const vmGet = vi.fn();
const vmCreateOrUpdate = vi.fn();
const vmDeallocate = vi.fn();
const vmRunCommand = vi.fn();
const vmGeneralize = vi.fn();
const vmDelete = vi.fn();
const snapshotGet = vi.fn();
const snapshotCreateOrUpdate = vi.fn();
const snapshotDelete = vi.fn();
const diskGet = vi.fn();
const diskDelete = vi.fn();
const galleryGet = vi.fn();
const galleryCreateOrUpdate = vi.fn();

const nicGet = vi.fn();
const nicCreateOrUpdate = vi.fn();
const nicDelete = vi.fn();

const getVmPowerState = vi.fn();

vi.mock('@azure/identity', () => ({ DefaultAzureCredential: class {} }));
vi.mock('@azure/arm-compute', () => ({
  ComputeManagementClient: class {
    virtualMachines = { get: vmGet, createOrUpdate: vmCreateOrUpdate, deallocate: vmDeallocate, runCommand: vmRunCommand, generalize: vmGeneralize, delete: vmDelete };
    snapshots = { get: snapshotGet, createOrUpdate: snapshotCreateOrUpdate, delete: snapshotDelete };
    disks = { get: diskGet, delete: diskDelete };
    galleryImageVersions = { get: galleryGet, createOrUpdate: galleryCreateOrUpdate };
  },
}));
vi.mock('@azure/arm-network', () => ({
  NetworkManagementClient: class {
    networkInterfaces = { get: nicGet, createOrUpdate: nicCreateOrUpdate, delete: nicDelete };
  },
}));
vi.mock('./computeService', () => ({ getVmPowerState: (...args: unknown[]) => getVmPowerState(...args) }));

const ORIGINAL_ENV = { ...process.env };

const CONTEXT: ImageBuildPlanContext = {
  subscriptionId: 'sub-id',
  resourceGroup: 'RG-AVD-Images',
  location: 'eastus',
  galleryName: 'ACG_AVD_CONTOSO',
  imageDefinitionName: 'WIN11-ENT-MS-M365',
  subnetId: '/subscriptions/sub/resourceGroups/RG-AVD-Network/providers/Microsoft.Network/virtualNetworks/VNET/subnets/SNET-MANAGEMENT',
  vmSize: 'Standard_D4ads_v7',
};

function plan(): ImageBuildPlan {
  return generateImageBuildPlan({ version: '2.1.0', adminUsername: 'ca.builder' }, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', CONTEXT, new Date('2026-08-16T00:00:00.000Z'));
}

function build(overrides: Partial<ImageBuildEntity> = {}): ImageBuildEntity {
  return {
    partitionKey: 'build',
    rowKey: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    buildId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
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
    correlationId: 'corr-1',
    ...overrides,
  };
}

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  process.env.SUBSCRIPTION_ID = 'sub-id';
  process.env.RG_HOSTPOOLS = 'RG-AVD-HostPools';
  process.env.HOSTPOOL_NAME = 'HP-CONTOSO-PROD';
  process.env.IMAGE_BUILD_SUBNET_ID = CONTEXT.subnetId;
  calls.length = 0;
  for (const fn of [vmGet, vmCreateOrUpdate, vmDeallocate, vmRunCommand, vmGeneralize, vmDelete, snapshotGet, snapshotCreateOrUpdate, snapshotDelete, diskGet, diskDelete, galleryGet, galleryCreateOrUpdate, nicGet, nicCreateOrUpdate, nicDelete, getVmPowerState]) {
    fn.mockReset();
  }
  vi.resetModules();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('submitBuildVmCreation', () => {
  it('creates the NIC to full completion, then submits (never polls to completion) the VM create with the admin password injected', async () => {
    const nicPoller = makePoller('nic', calls);
    nicCreateOrUpdate.mockReturnValue(nicPoller);
    const vmPoller = makePoller('vm', calls);
    vmCreateOrUpdate.mockReturnValue(vmPoller);

    const { submitBuildVmCreation } = await import('./imageBuildOrchestrator');
    const steps = await submitBuildVmCreation(plan(), 'Sup3rSecretPassw0rd!');

    expect(calls).toEqual(['nic.pollUntilDone', 'vm.submitted']);
    expect(vmPoller.pollUntilDone).not.toHaveBeenCalled();
    const [, , vmParams] = vmCreateOrUpdate.mock.calls[0] as [string, string, { osProfile: { adminPassword: string } }];
    expect(vmParams.osProfile.adminPassword).toBe('Sup3rSecretPassw0rd!');
    expect(steps.find((s) => s.stepId === 'create_build_nic')?.status).toBe('succeeded');
    expect(steps.find((s) => s.stepId === 'create_build_vm')?.status).toBe('in_progress');
  });
});

describe('pollVmCreating', () => {
  it('self-transitions (same state, attempts bumped) while provisioningState is Creating — never returns null (that would silently drop the attempt-ceiling bump)', async () => {
    vmGet.mockResolvedValue({ provisioningState: 'Creating' });
    const { pollVmCreating } = await import('./imageBuildOrchestrator');
    const result = await pollVmCreating(build());
    expect(result?.nextState).toBe('vm_creating');
    expect(result?.steps.find((s) => s.stepId === 'create_build_vm')?.attempts).toBe(1);
  });

  it('advances to vm_ready once provisioningState is Succeeded, recording the resolved base image exactVersion', async () => {
    vmGet.mockResolvedValue({ provisioningState: 'Succeeded', storageProfile: { imageReference: { exactVersion: '26200.8875.260714' } } });
    const { pollVmCreating } = await import('./imageBuildOrchestrator');
    const result = await pollVmCreating(build(), new Date('2026-08-16T01:00:00.000Z'));
    expect(result?.nextState).toBe('vm_ready');
    expect(result?.steps.find((s) => s.stepId === 'create_build_vm')?.status).toBe('succeeded');
    expect(result?.baseImageExactVersion).toBe('26200.8875.260714');
  });

  it('fails the build when provisioningState is Failed', async () => {
    vmGet.mockResolvedValue({ provisioningState: 'Failed' });
    const { pollVmCreating } = await import('./imageBuildOrchestrator');
    const result = await pollVmCreating(build());
    expect(result?.nextState).toBe('failed');
    expect(result?.errorMessage).toMatch(/provisioning failed/i);
  });

  it('fails the build when the VM 404s (deleted out-of-band) rather than throwing', async () => {
    vmGet.mockRejectedValue(Object.assign(new Error('not found'), { statusCode: 404 }));
    const { pollVmCreating } = await import('./imageBuildOrchestrator');
    const result = await pollVmCreating(build());
    expect(result?.nextState).toBe('failed');
    expect(result?.errorMessage).toMatch(/deleted out-of-band/i);
  });

  it('fails the build once the attempt ceiling is exceeded', async () => {
    vmGet.mockResolvedValue({ provisioningState: 'Creating' });
    const { pollVmCreating } = await import('./imageBuildOrchestrator');
    const nearCeiling = build({ stepsJson: JSON.stringify([{ stepId: 'create_build_vm', status: 'in_progress', attempts: 180 }]) });
    const result = await pollVmCreating(nearCeiling);
    expect(result?.nextState).toBe('failed');
    expect(result?.errorMessage).toMatch(/maximum poll attempts/i);
  });
});

describe('pollAwaitingStopped — THE HARD GATE', () => {
  it('CRITICAL: refuses to proceed (returns null, never calls deallocate) while the VM is still running', async () => {
    getVmPowerState.mockResolvedValue('running');
    const { pollAwaitingStopped } = await import('./imageBuildOrchestrator');
    const result = await pollAwaitingStopped(build({ state: 'awaiting_stopped' }));
    expect(result).toBeNull();
    expect(vmDeallocate).not.toHaveBeenCalled();
  });

  it('refuses while transitional (stopping) — not yet confirmed off', async () => {
    getVmPowerState.mockResolvedValue('stopping');
    const { pollAwaitingStopped } = await import('./imageBuildOrchestrator');
    expect(await pollAwaitingStopped(build({ state: 'awaiting_stopped' }))).toBeNull();
    expect(vmDeallocate).not.toHaveBeenCalled();
  });

  it('proceeds (submits deallocate, advances to capturing) once the VM reads stopped', async () => {
    getVmPowerState.mockResolvedValue('stopped');
    const poller = makePoller('deallocate', calls);
    vmDeallocate.mockReturnValue(poller);
    const { pollAwaitingStopped } = await import('./imageBuildOrchestrator');
    const result = await pollAwaitingStopped(build({ state: 'awaiting_stopped' }), new Date('2026-08-16T02:00:00.000Z'));
    expect(result?.nextState).toBe('capturing');
    expect(vmDeallocate).toHaveBeenCalledWith('RG-AVD-Images', 'VM-IMG-AAAAAAAA');
    expect(poller.submitted).toHaveBeenCalledTimes(1);
    expect(poller.pollUntilDone).not.toHaveBeenCalled();
    expect(result?.steps.find((s) => s.stepId === 'ensure_deallocated')?.status).toBe('in_progress');
  });

  it('also proceeds when already deallocated', async () => {
    getVmPowerState.mockResolvedValue('deallocated');
    vmDeallocate.mockReturnValue(makePoller('deallocate', calls));
    const { pollAwaitingStopped } = await import('./imageBuildOrchestrator');
    const result = await pollAwaitingStopped(build({ state: 'awaiting_stopped' }));
    expect(result?.nextState).toBe('capturing');
  });

  it('fails cleanly (not an uncaught throw) when the VM 404s — deleted out-of-band (Opus review MINOR 13c)', async () => {
    getVmPowerState.mockRejectedValue(Object.assign(new Error('not found'), { statusCode: 404 }));
    const { pollAwaitingStopped } = await import('./imageBuildOrchestrator');
    const result = await pollAwaitingStopped(build({ state: 'awaiting_stopped' }));
    expect(result?.nextState).toBe('failed');
    expect(result?.errorMessage).toMatch(/deleted out-of-band/i);
    expect(vmDeallocate).not.toHaveBeenCalled();
  });
});

describe('pollCapturing — the three-phase sequence, resumable at each phase', () => {
  const buildAtEnsureDeallocated = () =>
    build({ state: 'capturing', stepsJson: JSON.stringify([{ stepId: 'ensure_deallocated', status: 'in_progress' }]) });

  it('phase 1: waits (returns null) until power state reads exactly deallocated', async () => {
    getVmPowerState.mockResolvedValue('stopped'); // stopped, but not YET deallocated
    const { pollCapturing } = await import('./imageBuildOrchestrator');
    expect(await pollCapturing(buildAtEnsureDeallocated(), plan())).toBeNull();
    expect(vmGeneralize).not.toHaveBeenCalled();
  });

  it('phase 1: fails cleanly (not an uncaught throw) when the VM 404s — deleted out-of-band (Opus review MINOR 13c)', async () => {
    getVmPowerState.mockRejectedValue(Object.assign(new Error('not found'), { statusCode: 404 }));
    const { pollCapturing } = await import('./imageBuildOrchestrator');
    const result = await pollCapturing(buildAtEnsureDeallocated(), plan());
    expect(result?.nextState).toBe('failed');
    expect(result?.errorMessage).toMatch(/deleted out-of-band/i);
    expect(vmGeneralize).not.toHaveBeenCalled();
  });

  it('phase 1->2: once deallocated, calls generalize (a plain await, not a poller) and marks both steps succeeded', async () => {
    getVmPowerState.mockResolvedValue('deallocated');
    vmGeneralize.mockResolvedValue(undefined);
    const { pollCapturing } = await import('./imageBuildOrchestrator');
    const result = await pollCapturing(buildAtEnsureDeallocated(), plan(), new Date('2026-08-16T03:00:00.000Z'));
    expect(vmGeneralize).toHaveBeenCalledWith('RG-AVD-Images', 'VM-IMG-AAAAAAAA');
    expect(result?.nextState).toBe('capturing');
    expect(result?.steps.find((s) => s.stepId === 'ensure_deallocated')?.status).toBe('succeeded');
    expect(result?.steps.find((s) => s.stepId === 'generalize_vm')?.status).toBe('succeeded');
  });

  it('phase 3: submits the gallery image version create (submitted() only) once generalize has succeeded', async () => {
    const b = build({ state: 'capturing', stepsJson: JSON.stringify([{ stepId: 'ensure_deallocated', status: 'succeeded' }, { stepId: 'generalize_vm', status: 'succeeded' }, { stepId: 'capture_image_version', status: 'pending' }]) });
    const poller = makePoller('capture', calls);
    galleryCreateOrUpdate.mockReturnValue(poller);
    const { pollCapturing } = await import('./imageBuildOrchestrator');
    const result = await pollCapturing(b, plan());
    expect(galleryCreateOrUpdate).toHaveBeenCalledWith('RG-AVD-Images', 'ACG_AVD_CONTOSO', 'WIN11-ENT-MS-M365', '2.1.0', expect.any(Object));
    expect(poller.submitted).toHaveBeenCalledTimes(1);
    expect(poller.pollUntilDone).not.toHaveBeenCalled();
    expect(result?.nextState).toBe('capturing');
    expect(result?.steps.find((s) => s.stepId === 'capture_image_version')?.status).toBe('in_progress');
  });

  it('phase 3 passes endOfLifeDate to the SDK as a real Date, never the plan\'s persisted ISO string (live regression 2026-08-22, correlation d81fe44e — the SDK serializer calls toISOString and throws on a string)', async () => {
    const b = build({ state: 'capturing', stepsJson: JSON.stringify([{ stepId: 'ensure_deallocated', status: 'succeeded' }, { stepId: 'generalize_vm', status: 'succeeded' }, { stepId: 'capture_image_version', status: 'pending' }]) });
    const poller = makePoller('capture', calls);
    galleryCreateOrUpdate.mockReturnValue(poller);
    const { pollCapturing } = await import('./imageBuildOrchestrator');
    await pollCapturing(b, plan());
    const submitted = galleryCreateOrUpdate.mock.calls[0][4] as { publishingProfile?: { endOfLifeDate?: unknown } };
    expect(submitted.publishingProfile?.endOfLifeDate).toBeInstanceOf(Date);
    expect(Number.isNaN((submitted.publishingProfile?.endOfLifeDate as Date).getTime())).toBe(false);
  });

  it('phase 4: polls provisioningState — Succeeded advances to test_host_step with the captured version id', async () => {
    const b = build({ state: 'capturing', stepsJson: JSON.stringify([{ stepId: 'ensure_deallocated', status: 'succeeded' }, { stepId: 'generalize_vm', status: 'succeeded' }, { stepId: 'capture_image_version', status: 'in_progress' }]) });
    galleryGet.mockResolvedValue({ provisioningState: 'Succeeded', id: '/subscriptions/sub/.../versions/2.1.0' });
    const { pollCapturing } = await import('./imageBuildOrchestrator');
    const result = await pollCapturing(b, plan());
    expect(result?.nextState).toBe('test_host_step');
    expect(result?.capturedImageVersionId).toBe('/subscriptions/sub/.../versions/2.1.0');
  });

  it('phase 4: Failed provisioningState fails the build', async () => {
    const b = build({ state: 'capturing', stepsJson: JSON.stringify([{ stepId: 'ensure_deallocated', status: 'succeeded' }, { stepId: 'generalize_vm', status: 'succeeded' }, { stepId: 'capture_image_version', status: 'in_progress' }]) });
    galleryGet.mockResolvedValue({ provisioningState: 'Failed' });
    const { pollCapturing } = await import('./imageBuildOrchestrator');
    const result = await pollCapturing(b, plan());
    expect(result?.nextState).toBe('failed');
  });
});

describe('pollCleanup — 404 on a fresh GET means "already deleted" (success)', () => {
  it('stays in cleanup while a resource still GETs successfully', async () => {
    const b = build({ state: 'cleanup', stepsJson: JSON.stringify([{ stepId: 'delete_build_vm', status: 'in_progress' }, { stepId: 'delete_build_nic', status: 'in_progress' }, { stepId: 'delete_build_disk', status: 'in_progress' }]) });
    vmGet.mockResolvedValue({}); // still exists
    nicGet.mockRejectedValue(Object.assign(new Error('not found'), { statusCode: 404 }));
    diskGet.mockRejectedValue(Object.assign(new Error('not found'), { statusCode: 404 }));
    const { pollCleanup } = await import('./imageBuildOrchestrator');
    const result = await pollCleanup(b);
    expect(result?.nextState).toBe('cleanup');
    expect(result?.steps.find((s) => s.stepId === 'delete_build_vm')?.status).toBe('in_progress');
    expect(result?.steps.find((s) => s.stepId === 'delete_build_nic')?.status).toBe('succeeded');
    expect(result?.steps.find((s) => s.stepId === 'delete_build_disk')?.status).toBe('succeeded');
  });

  it('advances to done once all three resources 404 (fully deleted)', async () => {
    const b = build({ state: 'cleanup', stepsJson: JSON.stringify([{ stepId: 'delete_build_vm', status: 'in_progress' }, { stepId: 'delete_build_nic', status: 'in_progress' }, { stepId: 'delete_build_disk', status: 'in_progress' }]) });
    const notFound = Object.assign(new Error('not found'), { statusCode: 404 });
    vmGet.mockRejectedValue(notFound);
    nicGet.mockRejectedValue(notFound);
    diskGet.mockRejectedValue(notFound);
    const { pollCleanup } = await import('./imageBuildOrchestrator');
    const result = await pollCleanup(b);
    expect(result?.nextState).toBe('done');
  });

  it('Opus review MAJOR 1: persists the bumped attempt count even when nothing 404s yet (all still in flight) — the ceiling could never be reached otherwise', async () => {
    const b = build({ state: 'cleanup', stepsJson: JSON.stringify([{ stepId: 'delete_build_vm', status: 'in_progress' }, { stepId: 'delete_build_nic', status: 'in_progress' }, { stepId: 'delete_build_disk', status: 'in_progress' }]) });
    vmGet.mockResolvedValue({});
    nicGet.mockResolvedValue({});
    diskGet.mockResolvedValue({});
    const { pollCleanup } = await import('./imageBuildOrchestrator');
    const result = await pollCleanup(b);
    expect(result).not.toBeNull();
    expect(result?.nextState).toBe('cleanup');
    expect(result?.steps.find((s) => s.stepId === 'delete_build_vm')?.attempts).toBe(1);
    expect(result?.steps.find((s) => s.stepId === 'delete_build_nic')?.attempts).toBe(1);
    expect(result?.steps.find((s) => s.stepId === 'delete_build_disk')?.attempts).toBe(1);
  });

  it('fails the build once a delete exceeds the attempt ceiling', async () => {
    const b = build({ state: 'cleanup', stepsJson: JSON.stringify([{ stepId: 'delete_build_vm', status: 'in_progress', attempts: 180 }, { stepId: 'delete_build_nic', status: 'succeeded' }, { stepId: 'delete_build_disk', status: 'succeeded' }]) });
    vmGet.mockResolvedValue({}); // still exists — never confirms deleted.
    const { pollCleanup } = await import('./imageBuildOrchestrator');
    const result = await pollCleanup(b);
    expect(result?.nextState).toBe('failed');
    expect(result?.errorMessage).toMatch(/maximum poll attempts/i);
  });
});

describe('pollCleanup — AM-46 dependency-ordered submission (VM delete must complete before NIC/disk deletes are submitted)', () => {
  it('does NOT submit the nic/disk deletes while the VM delete is still in flight — but the bumped VM attempt IS still persisted (non-null, Opus review MAJOR 1)', async () => {
    const b = build({
      state: 'cleanup',
      stepsJson: JSON.stringify([
        { stepId: 'delete_build_vm', status: 'in_progress' },
        { stepId: 'delete_build_nic', status: 'pending' },
        { stepId: 'delete_build_disk', status: 'pending' },
      ]),
    });
    vmGet.mockResolvedValue({}); // still exists — VM delete not yet done.
    const { pollCleanup } = await import('./imageBuildOrchestrator');
    const result = await pollCleanup(b);
    expect(result).not.toBeNull();
    expect(result?.nextState).toBe('cleanup');
    expect(result?.steps.find((s) => s.stepId === 'delete_build_vm')?.attempts).toBe(1);
    expect(nicDelete).not.toHaveBeenCalled();
    expect(diskDelete).not.toHaveBeenCalled();
  });

  it('once the VM 404s, marks it succeeded AND submits the nic/disk deletes in the SAME tick', async () => {
    const b = build({
      state: 'cleanup',
      stepsJson: JSON.stringify([
        { stepId: 'delete_build_vm', status: 'in_progress' },
        { stepId: 'delete_build_nic', status: 'pending' },
        { stepId: 'delete_build_disk', status: 'pending' },
      ]),
    });
    vmGet.mockRejectedValue(Object.assign(new Error('not found'), { statusCode: 404 }));
    nicDelete.mockReturnValue(makePoller('nic-delete', calls));
    diskDelete.mockReturnValue(makePoller('disk-delete', calls));
    const { pollCleanup } = await import('./imageBuildOrchestrator');
    const result = await pollCleanup(b);
    expect(result?.nextState).toBe('cleanup');
    expect(result?.steps.find((s) => s.stepId === 'delete_build_vm')?.status).toBe('succeeded');
    expect(nicDelete).toHaveBeenCalledWith('RG-AVD-Images', 'NIC-VM-IMG-AAAAAAAA');
    expect(diskDelete).toHaveBeenCalledWith('RG-AVD-Images', 'OSDISK-VM-IMG-AAAAAAAA');
    expect(result?.steps.find((s) => s.stepId === 'delete_build_nic')?.status).toBe('in_progress');
    expect(result?.steps.find((s) => s.stepId === 'delete_build_disk')?.status).toBe('in_progress');
  });

  it('SELF-HEALS a row whose nic/disk steps are already failed (the live prod build 2414dd61 shape) once the VM is gone, and emits the AM-48 IMAGE_BUILD_CLEANUP_SELFHEAL marker for each re-submit', async () => {
    const b = build({
      state: 'cleanup',
      stepsJson: JSON.stringify([
        { stepId: 'delete_build_vm', status: 'succeeded' },
        { stepId: 'delete_build_nic', status: 'failed', error: 'Nic NIC-VM-IMG-AAAAAAAA is used by existing resource VM-IMG-AAAAAAAA.' },
        { stepId: 'delete_build_disk', status: 'failed', error: 'Disk OSDISK-VM-IMG-AAAAAAAA is attached to VM VM-IMG-AAAAAAAA.' },
      ]),
    });
    nicDelete.mockReturnValue(makePoller('nic-delete', calls));
    diskDelete.mockReturnValue(makePoller('disk-delete', calls));
    const { pollCleanup } = await import('./imageBuildOrchestrator');
    const logger = fakeLogger();
    let result = await pollCleanup(b, undefined, logger);
    expect(result?.nextState).toBe('cleanup');
    expect(nicDelete).toHaveBeenCalledTimes(1);
    expect(diskDelete).toHaveBeenCalledTimes(1);
    expect(result?.steps.find((s) => s.stepId === 'delete_build_nic')?.status).toBe('in_progress');
    expect(result?.steps.find((s) => s.stepId === 'delete_build_disk')?.status).toBe('in_progress');
    // Opus review MAJOR 3 — the stale failure text from the pre-fix rejection must not survive onto the re-submitted (now succeeding) step.
    expect(result?.steps.find((s) => s.stepId === 'delete_build_nic')?.error).toBeUndefined();
    expect(result?.steps.find((s) => s.stepId === 'delete_build_disk')?.error).toBeUndefined();
    // AM-48 — a failed->re-submit step must emit the greppable self-heal marker, one line per re-submitted step.
    expect(logger.warn).toHaveBeenCalledWith(`IMAGE_BUILD_CLEANUP_SELFHEAL | buildId=${b.buildId} step=delete_build_nic`);
    expect(logger.warn).toHaveBeenCalledWith(`IMAGE_BUILD_CLEANUP_SELFHEAL | buildId=${b.buildId} step=delete_build_disk`);
    expect(logger.warn).toHaveBeenCalledTimes(2);

    // Next tick: both resources now 404 — proceeds to done via the normal poll path.
    const b2 = build({ state: 'cleanup', stepsJson: JSON.stringify(result?.steps) });
    const notFound = Object.assign(new Error('not found'), { statusCode: 404 });
    nicGet.mockRejectedValue(notFound);
    diskGet.mockRejectedValue(notFound);
    result = await pollCleanup(b2);
    expect(result?.nextState).toBe('done');
  });

  it('AM-48 — does NOT emit IMAGE_BUILD_CLEANUP_SELFHEAL for a normal pending->first-submit nic/disk delete', async () => {
    const b = build({
      state: 'cleanup',
      stepsJson: JSON.stringify([
        { stepId: 'delete_build_vm', status: 'succeeded' },
        { stepId: 'delete_build_nic', status: 'pending' },
        { stepId: 'delete_build_disk', status: 'pending' },
      ]),
    });
    nicDelete.mockReturnValue(makePoller('nic-delete', calls));
    diskDelete.mockReturnValue(makePoller('disk-delete', calls));
    const { pollCleanup } = await import('./imageBuildOrchestrator');
    const logger = fakeLogger();
    const result = await pollCleanup(b, undefined, logger);
    expect(result?.nextState).toBe('cleanup');
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('AM-48 — emits IMAGE_BUILD_CLEANUP_SELFHEAL for delete_build_vm on a failed->re-submit, but not for a pending->first-submit', async () => {
    const failedVm = build({
      state: 'cleanup',
      stepsJson: JSON.stringify([
        { stepId: 'delete_build_vm', status: 'failed', error: 'stale' },
        { stepId: 'delete_build_nic', status: 'pending' },
        { stepId: 'delete_build_disk', status: 'pending' },
      ]),
    });
    vmDelete.mockReturnValue(makePoller('vm-delete', calls));
    const { pollCleanup } = await import('./imageBuildOrchestrator');
    const failedLogger = fakeLogger();
    await pollCleanup(failedVm, undefined, failedLogger);
    expect(failedLogger.warn).toHaveBeenCalledWith(`IMAGE_BUILD_CLEANUP_SELFHEAL | buildId=${failedVm.buildId} step=delete_build_vm`);
    expect(failedLogger.warn).toHaveBeenCalledTimes(1);

    const pendingVm = build({
      state: 'cleanup',
      stepsJson: JSON.stringify([
        { stepId: 'delete_build_vm', status: 'pending' },
        { stepId: 'delete_build_nic', status: 'pending' },
        { stepId: 'delete_build_disk', status: 'pending' },
      ]),
    });
    vmDelete.mockReturnValue(makePoller('vm-delete-2', calls));
    const pendingLogger = fakeLogger();
    await pollCleanup(pendingVm, undefined, pendingLogger);
    expect(pendingLogger.warn).not.toHaveBeenCalled();
  });

  it('AM-48 — pollCleanup with no logger argument at all (imageBuildTimer.ts default path today) does not throw', async () => {
    const b = build({
      state: 'cleanup',
      stepsJson: JSON.stringify([
        { stepId: 'delete_build_vm', status: 'succeeded' },
        { stepId: 'delete_build_nic', status: 'failed', error: 'stale' },
        { stepId: 'delete_build_disk', status: 'failed', error: 'stale' },
      ]),
    });
    nicDelete.mockReturnValue(makePoller('nic-delete', calls));
    diskDelete.mockReturnValue(makePoller('disk-delete', calls));
    const { pollCleanup } = await import('./imageBuildOrchestrator');
    const result = await pollCleanup(b);
    expect(result?.nextState).toBe('cleanup');
  });

  it('a re-submit that keeps failing bumps the shared attempts budget and exceeds the ceiling, failing the build honestly with the real ARM rejection attached', async () => {
    const b = build({
      state: 'cleanup',
      stepsJson: JSON.stringify([
        { stepId: 'delete_build_vm', status: 'succeeded' },
        { stepId: 'delete_build_nic', status: 'failed', attempts: 180, error: 'still refused' },
        { stepId: 'delete_build_disk', status: 'succeeded' },
      ]),
    });
    nicDelete.mockImplementation(() => {
      throw Object.assign(new Error('Nic still in use.'), { statusCode: 409 });
    });
    const { pollCleanup } = await import('./imageBuildOrchestrator');
    const result = await pollCleanup(b);
    expect(result?.nextState).toBe('failed');
    expect(result?.errorMessage).toMatch(/maximum poll attempts/i); // the outer summary message — unchanged wording.
    const nicStep = result?.steps.find((s) => s.stepId === 'delete_build_nic');
    expect(nicStep?.attempts).toBe(181);
    // Opus review MINOR — the per-step message mirrors submitSysprepIfNeeded's "submission" wording and keeps the real ARM error, rather than discarding it behind a generic message.
    expect(nicStep?.error).toMatch(/Exceeded maximum submission attempts\. Last error: Nic still in use\./);
  });

  it('a re-submit that fails WITHOUT exceeding the ceiling stays in cleanup, persisting the failed status and incremented attempts (so the next tick retries)', async () => {
    const conflict409 = Object.assign(new Error('VM-IMG-AAAAAAAA is locked by a resource lock.'), { statusCode: 409 });
    vmDelete.mockImplementation(() => {
      throw conflict409;
    });
    const b = build({
      state: 'cleanup',
      stepsJson: JSON.stringify([
        { stepId: 'delete_build_vm', status: 'failed', attempts: 2, error: 'stale prior error' },
        { stepId: 'delete_build_nic', status: 'pending' },
        { stepId: 'delete_build_disk', status: 'pending' },
      ]),
    });
    const { pollCleanup } = await import('./imageBuildOrchestrator');
    const result = await pollCleanup(b);
    expect(result?.nextState).toBe('cleanup');
    const vmStep = result?.steps.find((s) => s.stepId === 'delete_build_vm');
    expect(vmStep?.status).toBe('failed');
    expect(vmStep?.attempts).toBe(3);
    expect(vmStep?.error).toMatch(/locked by a resource lock/);
    // Still gated: the VM delete hasn't succeeded, so nic/disk are never submitted.
    expect(nicDelete).not.toHaveBeenCalled();
    expect(diskDelete).not.toHaveBeenCalled();
  });

  it('a nic/disk re-submit that 404s at submit time (already gone) succeeds immediately and can reach done in the SAME tick', async () => {
    const b = build({
      state: 'cleanup',
      stepsJson: JSON.stringify([
        { stepId: 'delete_build_vm', status: 'succeeded' },
        { stepId: 'delete_build_nic', status: 'failed', error: 'stale' },
        { stepId: 'delete_build_disk', status: 'failed', error: 'stale' },
      ]),
    });
    const notFound = Object.assign(new Error('not found'), { statusCode: 404 });
    nicDelete.mockImplementation(() => {
      throw notFound;
    });
    diskDelete.mockImplementation(() => {
      throw notFound;
    });
    const { pollCleanup } = await import('./imageBuildOrchestrator');
    const result = await pollCleanup(b);
    expect(result?.nextState).toBe('done');
    expect(result?.steps.find((s) => s.stepId === 'delete_build_nic')?.status).toBe('succeeded');
    expect(result?.steps.find((s) => s.stepId === 'delete_build_disk')?.status).toBe('succeeded');
  });
});

describe('pollCleanup — AM-46 / Opus review MAJOR 2: delete_build_vm itself must not be a dead end when it fails at submit time', () => {
  it('a VM delete rejected at submit (resource lock/409) is re-submitted by pollCleanup on later ticks, and eventually exceeds the ceiling honestly if it keeps failing', async () => {
    const conflict409 = Object.assign(new Error('VM-IMG-AAAAAAAA is locked by a resource lock.'), { statusCode: 409 });
    vmDelete.mockReturnValue({ submitted: vi.fn().mockRejectedValue(conflict409) }); // AM-46 live incident's actual mechanism: the poller itself rejects on submitted(), not the factory call.

    const { submitCleanupDeletes, pollCleanup } = await import('./imageBuildOrchestrator');
    const submitted = await submitCleanupDeletes(build());
    expect(submitted.find((s) => s.stepId === 'delete_build_vm')?.status).toBe('failed');

    // Seed near the ceiling (as the other ceiling tests do) rather than looping 180 real ticks.
    const nearCeiling = build({
      state: 'cleanup',
      stepsJson: JSON.stringify(submitted.map((s) => (s.stepId === 'delete_build_vm' ? { ...s, attempts: 180 } : s))),
    });
    const result = await pollCleanup(nearCeiling);
    expect(vmDelete).toHaveBeenCalledTimes(2); // once in submitCleanupDeletes, once in pollCleanup's re-submit.
    expect(result?.nextState).toBe('failed');
    expect(result?.errorMessage).toMatch(/maximum poll attempts/i);
    const vmStep = result?.steps.find((s) => s.stepId === 'delete_build_vm');
    expect(vmStep?.attempts).toBe(181);
    expect(vmStep?.error).toMatch(/Exceeded maximum submission attempts\. Last error: VM-IMG-AAAAAAAA is locked by a resource lock\./);
  });
});

describe('submitSysprepIfNeeded — two-phase persist-before-invoke (Opus review MINOR 13b)', () => {
  it('phase 1: pending -> in_progress, self-transition, NO Run Command call at all yet', async () => {
    const b = build({ state: 'sysprep_running', stepsJson: JSON.stringify([{ stepId: 'run_sysprep', status: 'pending' }]) });
    const { submitSysprepIfNeeded } = await import('./imageBuildOrchestrator');
    const result = await submitSysprepIfNeeded(b, plan());
    expect(result.nextState).toBe('sysprep_running');
    expect(result.steps.find((s) => s.stepId === 'run_sysprep')?.status).toBe('in_progress');
    expect(vmRunCommand).not.toHaveBeenCalled();
  });

  it('phase 2: in_progress -> submits Run Command, marks succeeded, advances to awaiting_stopped', async () => {
    const b = build({ state: 'sysprep_running', stepsJson: JSON.stringify([{ stepId: 'run_sysprep', status: 'in_progress' }]) });
    const poller = makePoller('sysprep', calls);
    vmRunCommand.mockReturnValue(poller);
    const { submitSysprepIfNeeded } = await import('./imageBuildOrchestrator');
    const result = await submitSysprepIfNeeded(b, plan());
    expect(vmRunCommand).toHaveBeenCalledTimes(1);
    expect(poller.submitted).toHaveBeenCalledTimes(1);
    expect(poller.pollUntilDone).not.toHaveBeenCalled();
    expect(result.nextState).toBe('awaiting_stopped');
    expect(result.steps.find((s) => s.stepId === 'run_sysprep')?.status).toBe('succeeded');
  });

  it('phase 2 failure while the VM is still running: self-transition (retry next tick), never fails the build outright', async () => {
    const b = build({ state: 'sysprep_running', stepsJson: JSON.stringify([{ stepId: 'run_sysprep', status: 'in_progress' }]) });
    vmRunCommand.mockReturnValue({ submitted: vi.fn().mockRejectedValue(new Error('transient ARM error')) });
    getVmPowerState.mockResolvedValue('running');
    const { submitSysprepIfNeeded } = await import('./imageBuildOrchestrator');
    const result = await submitSysprepIfNeeded(b, plan());
    expect(result.nextState).toBe('sysprep_running');
    expect(result.steps.find((s) => s.stepId === 'run_sysprep')?.attempts).toBe(1);
  });

  it('phase 2 failure while the VM is NOT running: fails the build with guidance, does not retry forever', async () => {
    const b = build({ state: 'sysprep_running', stepsJson: JSON.stringify([{ stepId: 'run_sysprep', status: 'in_progress' }]) });
    vmRunCommand.mockReturnValue({ submitted: vi.fn().mockRejectedValue(new Error('VM not reachable')) });
    getVmPowerState.mockResolvedValue('stopped');
    const { submitSysprepIfNeeded } = await import('./imageBuildOrchestrator');
    const result = await submitSysprepIfNeeded(b, plan());
    expect(result.nextState).toBe('failed');
    expect(result.errorMessage).toMatch(/no longer running/i);
  });

  it('already succeeded (resuming after a restart): idempotent no-op, advances straight to awaiting_stopped without re-submitting', async () => {
    const b = build({ state: 'sysprep_running', stepsJson: JSON.stringify([{ stepId: 'run_sysprep', status: 'succeeded' }]) });
    const { submitSysprepIfNeeded } = await import('./imageBuildOrchestrator');
    const result = await submitSysprepIfNeeded(b, plan());
    expect(result.nextState).toBe('awaiting_stopped');
    expect(vmRunCommand).not.toHaveBeenCalled();
  });
});

describe('reconcilePlanned — stranded planned state (Opus review BLOCKER/MAJOR 4)', () => {
  it('resumes into vm_creating when the VM actually exists in Azure (the ARM submission succeeded, only the row write failed)', async () => {
    const b = build({ state: 'planned', stepsJson: '[]' });
    vmGet.mockResolvedValue({ provisioningState: 'Creating' });
    const { reconcilePlanned } = await import('./imageBuildOrchestrator');
    const result = await reconcilePlanned(b, new Date('2026-08-16T00:01:00.000Z'));
    expect(result?.nextState).toBe('vm_creating');
    expect(result?.steps.find((s) => s.stepId === 'create_build_nic')?.status).toBe('succeeded');
    expect(result?.steps.find((s) => s.stepId === 'create_build_vm')?.status).toBe('in_progress');
  });

  it('does nothing yet (returns null) when the VM does not exist and the row is still fresh', async () => {
    const b = build({ state: 'planned', createdAt: '2026-08-16T00:00:00.000Z' });
    vmGet.mockRejectedValue(Object.assign(new Error('not found'), { statusCode: 404 }));
    const { reconcilePlanned } = await import('./imageBuildOrchestrator');
    const result = await reconcilePlanned(b, new Date('2026-08-16T00:01:00.000Z')); // 1 minute old — under the grace period.
    expect(result).toBeNull();
  });

  it('fails the build with honest guidance once the row is old enough with no VM found', async () => {
    const b = build({ state: 'planned', createdAt: '2026-08-16T00:00:00.000Z' });
    vmGet.mockRejectedValue(Object.assign(new Error('not found'), { statusCode: 404 }));
    const { reconcilePlanned } = await import('./imageBuildOrchestrator');
    const result = await reconcilePlanned(b, new Date('2026-08-16T00:10:00.000Z')); // 10 minutes old — past the grace period.
    expect(result?.nextState).toBe('failed');
    expect(result?.errorMessage).toContain(b.nicName); // names the NIC that may still exist even though the VM doesn't.
  });
});

describe('assertVersionAvailable — pre-flight (Opus review MAJOR 6)', () => {
  it('ok when the gallery image version does not exist (404)', async () => {
    galleryGet.mockRejectedValue(Object.assign(new Error('not found'), { statusCode: 404 }));
    const { assertVersionAvailable } = await import('./imageBuildOrchestrator');
    const result = await assertVersionAvailable('2.1.0', CONTEXT);
    expect(result.ok).toBe(true);
  });

  it('not ok when the gallery image version already exists', async () => {
    galleryGet.mockResolvedValue({ name: '2.1.0' });
    const { assertVersionAvailable } = await import('./imageBuildOrchestrator');
    const result = await assertVersionAvailable('2.1.0', CONTEXT);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('already exists');
  });
});

describe('assertSnapshotNameAvailable — pre-flight (Opus review MINOR 13d)', () => {
  it('ok when no snapshot with that name exists', async () => {
    snapshotGet.mockRejectedValue(Object.assign(new Error('not found'), { statusCode: 404 }));
    const { assertSnapshotNameAvailable } = await import('./imageBuildOrchestrator');
    const result = await assertSnapshotNameAvailable('SNAP-WIN11-PRE-SYSPREP-2.1.0', CONTEXT);
    expect(result.ok).toBe(true);
  });

  it('not ok when a snapshot with that name already exists', async () => {
    snapshotGet.mockResolvedValue({ name: 'SNAP-WIN11-PRE-SYSPREP-2.1.0' });
    const { assertSnapshotNameAvailable } = await import('./imageBuildOrchestrator');
    const result = await assertSnapshotNameAvailable('SNAP-WIN11-PRE-SYSPREP-2.1.0', CONTEXT);
    expect(result.ok).toBe(false);
  });
});

describe('getSnapshotStatus — AM-53 live status read', () => {
  it('present when snapshots.get succeeds', async () => {
    snapshotGet.mockResolvedValue({ name: 'SNAP-WIN11-PRE-SYSPREP-2.1.0' });
    const { getSnapshotStatus } = await import('./imageBuildOrchestrator');
    await expect(getSnapshotStatus('SNAP-WIN11-PRE-SYSPREP-2.1.0')).resolves.toBe('present');
  });

  it('deleted on a 404', async () => {
    snapshotGet.mockRejectedValue(Object.assign(new Error('not found'), { statusCode: 404 }));
    const { getSnapshotStatus } = await import('./imageBuildOrchestrator');
    await expect(getSnapshotStatus('SNAP-WIN11-PRE-SYSPREP-2.1.0')).resolves.toBe('deleted');
  });

  it('unknown on any other read failure — never throws', async () => {
    snapshotGet.mockRejectedValue(Object.assign(new Error('transient'), { statusCode: 503 }));
    const { getSnapshotStatus } = await import('./imageBuildOrchestrator');
    await expect(getSnapshotStatus('SNAP-WIN11-PRE-SYSPREP-2.1.0')).resolves.toBe('unknown');
  });
});

describe('submitSnapshotDelete — AM-53 submission-only delete', () => {
  it('calls snapshots.delete with the resource group + name and awaits only submitted()', async () => {
    const poller = makePoller('snapshot-delete', calls);
    snapshotDelete.mockReturnValue(poller);
    const { submitSnapshotDelete } = await import('./imageBuildOrchestrator');
    await submitSnapshotDelete('SNAP-WIN11-PRE-SYSPREP-2.1.0');
    expect(snapshotDelete).toHaveBeenCalledWith('RG-AVD-Images', 'SNAP-WIN11-PRE-SYSPREP-2.1.0');
    expect(poller.submitted).toHaveBeenCalled();
    expect(poller.pollUntilDone).not.toHaveBeenCalled();
  });

  it('propagates a submit failure to the caller', async () => {
    snapshotDelete.mockImplementation(() => {
      throw new Error('boom');
    });
    const { submitSnapshotDelete } = await import('./imageBuildOrchestrator');
    await expect(submitSnapshotDelete('SNAP-WIN11-PRE-SYSPREP-2.1.0')).rejects.toThrow('boom');
  });
});

describe('submitCleanupDeletes — reads names off the ENTITY, not a regenerated plan (Opus review MAJOR 8/9); AM-46 submits ONLY the VM delete', () => {
  it('submits only the VM delete using build.vmName — nic/disk deletes are NOT called', async () => {
    const b = build({ vmName: 'VM-IMG-CUSTOM1', nicName: 'NIC-CUSTOM1', diskName: 'OSDISK-CUSTOM1' });
    vmDelete.mockReturnValue(makePoller('vm-delete', calls));
    const { submitCleanupDeletes } = await import('./imageBuildOrchestrator');
    const steps = await submitCleanupDeletes(b);
    expect(vmDelete).toHaveBeenCalledWith('RG-AVD-Images', 'VM-IMG-CUSTOM1');
    expect(nicDelete).not.toHaveBeenCalled();
    expect(diskDelete).not.toHaveBeenCalled();
    expect(steps.find((s) => s.stepId === 'delete_build_vm')?.status).toBe('in_progress');
    expect(steps.find((s) => s.stepId === 'delete_build_nic')?.status).toBe('pending');
    expect(steps.find((s) => s.stepId === 'delete_build_disk')?.status).toBe('pending');
  });

  it('treats a 404 on the VM delete as an immediate success (already gone)', async () => {
    const b = build();
    const notFound = Object.assign(new Error('not found'), { statusCode: 404 });
    vmDelete.mockImplementation(() => {
      throw notFound;
    });
    const { submitCleanupDeletes } = await import('./imageBuildOrchestrator');
    const steps = await submitCleanupDeletes(b);
    expect(steps.find((s) => s.stepId === 'delete_build_vm')?.status).toBe('succeeded');
    expect(nicDelete).not.toHaveBeenCalled();
    expect(diskDelete).not.toHaveBeenCalled();
  });
});

describe('withStepStatus — canonical order preserved (Opus review MINOR 13a)', () => {
  it('updates a step IN PLACE at its existing index rather than moving it to the end', async () => {
    const { withStepStatus } = await import('./imageBuildOrchestrator');
    const initial = [
      { stepId: 'create_build_nic' as const, status: 'pending' as const },
      { stepId: 'create_build_vm' as const, status: 'pending' as const },
      { stepId: 'operator_checklist_gate' as const, status: 'pending' as const },
    ];
    const updated = withStepStatus(initial, 'create_build_nic', { status: 'succeeded' }, new Date());
    expect(updated.map((s) => s.stepId)).toEqual(['create_build_nic', 'create_build_vm', 'operator_checklist_gate']);
    expect(updated[0].status).toBe('succeeded');
  });

  it('appends a genuinely new stepId rather than erroring', async () => {
    const { withStepStatus } = await import('./imageBuildOrchestrator');
    const updated = withStepStatus([], 'create_build_nic', { status: 'in_progress' }, new Date());
    expect(updated).toEqual([{ stepId: 'create_build_nic', status: 'in_progress', startedAt: expect.any(String) }]);
  });
});
