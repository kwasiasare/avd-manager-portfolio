import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionHostProvisionPlan } from '@avdmgr/shared';
import { generateSessionHostProvisionPlan, type SessionHostProvisionPlanContext } from '../lib/sessionHostProvisionPlan';
import type { SessionHostProvisionEntity } from './sessionHostProvisionService';

function makePoller(name: string, calls: string[]) {
  return {
    submitted: vi.fn(async () => {
      calls.push(`${name}.submitted`);
    }),
    pollUntilDone: vi.fn(async () => {
      calls.push(`${name}.pollUntilDone`);
    }),
  };
}

function fakeLogger() {
  return { warn: vi.fn(), error: vi.fn(), log: vi.fn() };
}

const calls: string[] = [];

const vmGet = vi.fn();
const vmCreateOrUpdate = vi.fn();
const extGet = vi.fn();
const extCreateOrUpdate = vi.fn();
const nicGet = vi.fn();
const nicCreateOrUpdate = vi.fn();

const generateRegistrationToken = vi.fn();
const listSessionHosts = vi.fn();
const writeAuditEntry = vi.fn();

vi.mock('@azure/identity', () => ({ DefaultAzureCredential: class {} }));
vi.mock('@azure/arm-compute', () => ({
  ComputeManagementClient: class {
    virtualMachines = { get: vmGet, createOrUpdate: vmCreateOrUpdate };
    virtualMachineExtensions = { get: extGet, createOrUpdate: extCreateOrUpdate };
  },
}));
vi.mock('@azure/arm-network', () => ({
  NetworkManagementClient: class {
    networkInterfaces = { get: nicGet, createOrUpdate: nicCreateOrUpdate };
  },
}));
vi.mock('./avdService', () => ({
  generateRegistrationToken: (...args: unknown[]) => generateRegistrationToken(...args),
  listSessionHosts: (...args: unknown[]) => listSessionHosts(...args),
}));
vi.mock('../lib/auditLog', () => ({
  writeAuditEntry: (...args: unknown[]) => writeAuditEntry(...args),
}));

const ORIGINAL_ENV = { ...process.env };

const CONTEXT: SessionHostProvisionPlanContext = {
  subscriptionId: 'sub-id',
  resourceGroup: 'RG-AVD-HostPools',
  location: 'eastus',
  subnetId: '/subscriptions/sub-id/resourceGroups/RG-AVD-Network/providers/Microsoft.Network/virtualNetworks/VNET-CONTOSO-PROD/subnets/SNET-SESSIONHOSTS',
  galleryImageVersionId: '/subscriptions/sub-id/resourceGroups/RG-AVD-Images/providers/Microsoft.Compute/galleries/ACG_AVD_CONTOSO/images/WIN11-ENT-MS-M365/versions/2.2.0',
  vmSize: 'Standard_D4ads_v7',
  zone: '2',
  adminUsername: 'first',
  hostPoolName: 'HP-CONTOSO-PROD',
  hostPoolResourceId: '/subscriptions/sub-id/resourceGroups/RG-AVD-HostPools/providers/Microsoft.DesktopVirtualization/hostPools/HP-CONTOSO-PROD',
  dscModulesUrl: 'https://wvdportalstorageblob.blob.core.windows.net/galleryartifacts/Configuration_1.0.03483.1387.zip',
};

function plan(): SessionHostProvisionPlan {
  return generateSessionHostProvisionPlan({ sessionHostName: 'avd-con-4', zone: '2', imageVersion: '2.2.0' }, CONTEXT);
}

function record(overrides: Partial<SessionHostProvisionEntity> = {}): SessionHostProvisionEntity {
  return {
    partitionKey: 'provision',
    rowKey: 'provision-1',
    provisionId: 'provision-1',
    hostPoolName: 'HP-CONTOSO-PROD',
    sessionHostName: 'avd-con-4',
    zone: '2',
    vmSize: 'Standard_D4ads_v7',
    imageVersion: '2.2.0',
    state: 'vm_creating',
    createdAt: '2026-08-23T00:00:00.000Z',
    updatedAt: '2026-08-23T00:00:00.000Z',
    createdBy: 'admin@example.com',
    createdById: 'entra-obj-1',
    vmName: 'avd-con-4',
    nicName: 'NIC-avd-con-4',
    stepsJson: '[]',
    planParamsJson: '{"sessionHostName":"avd-con-4","zone":"2","imageVersion":"2.2.0"}',
    planContextJson: JSON.stringify(CONTEXT),
    correlationId: 'corr-1',
    ...overrides,
  };
}

beforeEach(async () => {
  process.env = { ...ORIGINAL_ENV };
  process.env.SUBSCRIPTION_ID = 'sub-id';
  process.env.RG_HOSTPOOLS = 'RG-AVD-HostPools';
  process.env.HOSTPOOL_NAME = 'HP-CONTOSO-PROD';
  calls.length = 0;
  for (const fn of [vmGet, vmCreateOrUpdate, extGet, extCreateOrUpdate, nicGet, nicCreateOrUpdate, generateRegistrationToken, listSessionHosts, writeAuditEntry]) {
    fn.mockReset();
  }
  writeAuditEntry.mockResolvedValue(undefined);
  vi.resetModules();
  const { _resetComputeClientForTests } = await import('../lib/computeClient');
  _resetComputeClientForTests();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('submitNicCreation', () => {
  it('creates the NIC to full completion (pollUntilDone, not submitted-only) — same fast-completes-in-seconds exception as the image build', async () => {
    const nicPoller = makePoller('nic', calls);
    nicCreateOrUpdate.mockReturnValue(nicPoller);
    const { submitNicCreation } = await import('./sessionHostProvisionOrchestrator');
    const steps = await submitNicCreation(plan());
    expect(calls).toEqual(['nic.pollUntilDone']);
    expect(nicPoller.submitted).not.toHaveBeenCalled();
    expect(steps.find((s) => s.stepId === 'create_nic')?.status).toBe('succeeded');
  });

  it('throws when the NIC create itself fails', async () => {
    nicCreateOrUpdate.mockReturnValue({ pollUntilDone: vi.fn().mockRejectedValue(new Error('quota exceeded')), submitted: vi.fn() });
    const { submitNicCreation } = await import('./sessionHostProvisionOrchestrator');
    await expect(submitNicCreation(plan())).rejects.toThrow(/quota exceeded/);
  });
});

describe('submitVmCreation', () => {
  it('submits (never polls to completion) the VM create with the admin password injected', async () => {
    const vmPoller = makePoller('vm', calls);
    vmCreateOrUpdate.mockReturnValue(vmPoller);
    const { submitVmCreation, withStepStatus } = await import('./sessionHostProvisionOrchestrator');
    const nicSteps = withStepStatus([], 'create_nic', { status: 'succeeded' }, new Date());
    const steps = await submitVmCreation(plan(), nicSteps, 'Sup3rSecretPassw0rd!');
    expect(calls).toEqual(['vm.submitted']);
    expect(vmPoller.pollUntilDone).not.toHaveBeenCalled();
    const [, , vmParams] = vmCreateOrUpdate.mock.calls[0] as [string, string, { osProfile: { adminPassword: string } }];
    expect(vmParams.osProfile.adminPassword).toBe('Sup3rSecretPassw0rd!');
    expect(steps.find((s) => s.stepId === 'create_vm')?.status).toBe('in_progress');
  });

  it('throws PartialProvisionVmSubmissionError (carrying create_nic succeeded + create_vm failed) when VM submission fails', async () => {
    vmCreateOrUpdate.mockReturnValue({ submitted: vi.fn().mockRejectedValue(new Error('conflict')) });
    const { submitVmCreation, withStepStatus, PartialProvisionVmSubmissionError } = await import('./sessionHostProvisionOrchestrator');
    const nicSteps = withStepStatus([], 'create_nic', { status: 'succeeded' }, new Date());
    await expect(submitVmCreation(plan(), nicSteps, 'pw')).rejects.toBeInstanceOf(PartialProvisionVmSubmissionError);
    try {
      await submitVmCreation(plan(), nicSteps, 'pw');
    } catch (error) {
      const partial = error as InstanceType<typeof PartialProvisionVmSubmissionError>;
      expect(partial.steps.find((s) => s.stepId === 'create_nic')?.status).toBe('succeeded');
      expect(partial.steps.find((s) => s.stepId === 'create_vm')?.status).toBe('failed');
    }
  });
});

describe('reconcilePlanned', () => {
  it('resumes into nic_creating if the NIC actually exists despite no durable record', async () => {
    nicGet.mockResolvedValue({});
    const { reconcilePlanned } = await import('./sessionHostProvisionOrchestrator');
    const result = await reconcilePlanned(record({ state: 'planned' }));
    expect(result?.nextState).toBe('nic_creating');
    expect(result?.steps.find((s) => s.stepId === 'create_nic')?.status).toBe('succeeded');
  });

  it('returns null (still fresh) if the NIC does not exist and the row is young', async () => {
    nicGet.mockRejectedValue(Object.assign(new Error('not found'), { statusCode: 404 }));
    const { reconcilePlanned } = await import('./sessionHostProvisionOrchestrator');
    const result = await reconcilePlanned(record({ state: 'planned', createdAt: new Date().toISOString() }), new Date());
    expect(result).toBeNull();
  });

  it('fails honestly once the grace period elapses with no NIC found', async () => {
    nicGet.mockRejectedValue(Object.assign(new Error('not found'), { statusCode: 404 }));
    const { reconcilePlanned } = await import('./sessionHostProvisionOrchestrator');
    const old = new Date(Date.now() - 10 * 60_000).toISOString();
    const result = await reconcilePlanned(record({ state: 'planned', createdAt: old }), new Date());
    expect(result?.nextState).toBe('failed');
    expect(result?.errorMessage).toMatch(/never confirmed/);
  });
});

describe('pollNicCreating', () => {
  it('resumes into vm_creating if the VM actually exists', async () => {
    vmGet.mockResolvedValue({});
    const { pollNicCreating } = await import('./sessionHostProvisionOrchestrator');
    const result = await pollNicCreating(record({ state: 'nic_creating' }));
    expect(result?.nextState).toBe('vm_creating');
    expect(result?.steps.find((s) => s.stepId === 'create_vm')?.status).toBe('in_progress');
  });

  it('fails IMMEDIATELY (no grace period) if create_vm is already marked failed and the VM does not exist — the password cannot be safely regenerated', async () => {
    vmGet.mockRejectedValue(Object.assign(new Error('not found'), { statusCode: 404 }));
    const { pollNicCreating, withStepStatus } = await import('./sessionHostProvisionOrchestrator');
    const withFailedVm = record({ state: 'nic_creating', stepsJson: JSON.stringify(withStepStatus([], 'create_vm', { status: 'failed', error: 'boom' }, new Date())) });
    const result = await pollNicCreating(withFailedVm, new Date());
    expect(result?.nextState).toBe('failed');
    expect(result?.errorMessage).toMatch(/cannot safely retry/);
  });

  it('gives a grace period before failing when create_vm was never attempted (resumed via reconcilePlanned)', async () => {
    vmGet.mockRejectedValue(Object.assign(new Error('not found'), { statusCode: 404 }));
    const { pollNicCreating } = await import('./sessionHostProvisionOrchestrator');
    const fresh = record({ state: 'nic_creating', updatedAt: new Date().toISOString() });
    expect(await pollNicCreating(fresh, new Date())).toBeNull();

    const old = record({ state: 'nic_creating', updatedAt: new Date(Date.now() - 10 * 60_000).toISOString() });
    const result = await pollNicCreating(old, new Date());
    expect(result?.nextState).toBe('failed');
  });
});

describe('pollVmCreating', () => {
  it('advances to ext_entra_join once provisioningState is Succeeded', async () => {
    vmGet.mockResolvedValue({ provisioningState: 'Succeeded' });
    const { pollVmCreating } = await import('./sessionHostProvisionOrchestrator');
    const result = await pollVmCreating(record());
    expect(result?.nextState).toBe('ext_entra_join');
  });

  it('self-transitions (bumps attempts) while still Creating', async () => {
    vmGet.mockResolvedValue({ provisioningState: 'Creating' });
    const { pollVmCreating } = await import('./sessionHostProvisionOrchestrator');
    const result = await pollVmCreating(record());
    expect(result?.nextState).toBe('vm_creating');
    expect(result?.steps.find((s) => s.stepId === 'create_vm')?.attempts).toBe(1);
  });

  it('fails on a 404 (VM vanished out-of-band)', async () => {
    vmGet.mockRejectedValue(Object.assign(new Error('not found'), { statusCode: 404 }));
    const { pollVmCreating } = await import('./sessionHostProvisionOrchestrator');
    const result = await pollVmCreating(record());
    expect(result?.nextState).toBe('failed');
  });

  it('fails once the poll-attempt ceiling is exceeded', async () => {
    vmGet.mockResolvedValue({ provisioningState: 'Creating' });
    const { pollVmCreating, withStepStatus } = await import('./sessionHostProvisionOrchestrator');
    const nearCeiling = record({ stepsJson: JSON.stringify(withStepStatus([], 'create_vm', { status: 'in_progress', attempts: 180 }, new Date())) });
    const result = await pollVmCreating(nearCeiling);
    expect(result?.nextState).toBe('failed');
  });
});

describe('extension pollers — two-phase persist-before-submit, then poll via a fresh GET', () => {
  it('ext_entra_join: pending -> in_progress marker only, no ARM call yet', async () => {
    const { pollEntraJoinExtension } = await import('./sessionHostProvisionOrchestrator');
    const result = await pollEntraJoinExtension(record({ state: 'ext_entra_join' }), plan());
    expect(result.nextState).toBe('ext_entra_join'); // self-transition — marker only
    expect(result.steps.find((s) => s.stepId === 'ext_entra_join')?.status).toBe('in_progress');
    expect(extCreateOrUpdate).not.toHaveBeenCalled();
  });

  it('ext_entra_join: in_progress + not found in ARM yet -> submits now (submitted-only), self-transitions', async () => {
    extGet.mockRejectedValue(Object.assign(new Error('not found'), { statusCode: 404 }));
    const poller = makePoller('ext', calls);
    extCreateOrUpdate.mockReturnValue(poller);
    const { pollEntraJoinExtension, withStepStatus } = await import('./sessionHostProvisionOrchestrator');
    const inProgress = record({ state: 'ext_entra_join', stepsJson: JSON.stringify(withStepStatus([], 'ext_entra_join', { status: 'in_progress' }, new Date())) });
    const result = await pollEntraJoinExtension(inProgress, plan());
    expect(calls).toEqual(['ext.submitted']);
    expect(result.nextState).toBe('ext_entra_join'); // still not confirmed
    expect(extCreateOrUpdate).toHaveBeenCalledWith('RG-AVD-HostPools', 'avd-con-4', 'AADLoginForWindows', expect.any(Object));
  });

  it('ext_entra_join: found with provisioningState Succeeded -> advances to ext_guest_attestation', async () => {
    extGet.mockResolvedValue({ provisioningState: 'Succeeded' });
    const { pollEntraJoinExtension, withStepStatus } = await import('./sessionHostProvisionOrchestrator');
    const inProgress = record({ state: 'ext_entra_join', stepsJson: JSON.stringify(withStepStatus([], 'ext_entra_join', { status: 'in_progress' }, new Date())) });
    const result = await pollEntraJoinExtension(inProgress, plan());
    expect(result.nextState).toBe('ext_guest_attestation');
    expect(extCreateOrUpdate).not.toHaveBeenCalled();
  });

  it('ext_guest_attestation: Failed -> fails the provision', async () => {
    extGet.mockResolvedValue({ provisioningState: 'Failed' });
    const { pollGuestAttestationExtension, withStepStatus } = await import('./sessionHostProvisionOrchestrator');
    const inProgress = record({ state: 'ext_guest_attestation', stepsJson: JSON.stringify(withStepStatus([], 'ext_guest_attestation', { status: 'in_progress' }, new Date())) });
    const result = await pollGuestAttestationExtension(inProgress, plan());
    expect(result.nextState).toBe('failed');
  });

  it('ext_dsc: generates a FRESH registration token only at submit time, injects it into protectedSettings, and never returns/logs it', async () => {
    extGet.mockRejectedValue(Object.assign(new Error('not found'), { statusCode: 404 }));
    extCreateOrUpdate.mockReturnValue(makePoller('dsc', calls));
    generateRegistrationToken.mockResolvedValue({ token: 'super-secret-token-value', expirationTime: '2026-08-24T00:00:00.000Z' });
    const { pollDscExtension, withStepStatus } = await import('./sessionHostProvisionOrchestrator');
    const inProgress = record({ state: 'ext_dsc', stepsJson: JSON.stringify(withStepStatus([], 'ext_dsc', { status: 'in_progress' }, new Date())) });
    const logger = fakeLogger();
    const result = await pollDscExtension(inProgress, plan(), new Date(), logger);

    expect(generateRegistrationToken).toHaveBeenCalledWith('HP-CONTOSO-PROD', 24);
    const [, , , dscParams] = extCreateOrUpdate.mock.calls[0] as [string, string, string, { protectedSettings: { properties: { registrationInfoToken: string } } }];
    expect(dscParams.protectedSettings.properties.registrationInfoToken).toBe('super-secret-token-value');
    // the token never appears in the AdvanceResult persisted back to the row.
    expect(JSON.stringify(result)).not.toContain('super-secret-token-value');

    expect(writeAuditEntry).toHaveBeenCalledTimes(1);
    const [auditEvent] = writeAuditEntry.mock.calls[0] as [{ action: string; parameters: Record<string, unknown> }, unknown];
    expect(auditEvent.action).toBe('hostpool.registrationtoken.generate');
    expect(JSON.stringify(auditEvent.parameters)).not.toContain('super-secret-token-value');
  });

  it('extension submission that keeps failing exceeds the attempt ceiling and fails honestly', async () => {
    extGet.mockRejectedValue(Object.assign(new Error('not found'), { statusCode: 404 }));
    extCreateOrUpdate.mockReturnValue({ submitted: vi.fn().mockRejectedValue(new Error('transient ARM error')) });
    const { pollEntraJoinExtension, withStepStatus } = await import('./sessionHostProvisionOrchestrator');
    const nearCeiling = record({ state: 'ext_entra_join', stepsJson: JSON.stringify(withStepStatus([], 'ext_entra_join', { status: 'in_progress', attempts: 180 }, new Date())) });
    const result = await pollEntraJoinExtension(nearCeiling, plan());
    expect(result.nextState).toBe('failed');
    expect(result.errorMessage).toMatch(/maximum attempts/);
  });
});

describe('pollAwaitingRegistration', () => {
  it('pending -> in_progress marker only, no ARM read yet', async () => {
    const { pollAwaitingRegistration } = await import('./sessionHostProvisionOrchestrator');
    const result = await pollAwaitingRegistration(record({ state: 'awaiting_registration' }));
    expect(result.steps.find((s) => s.stepId === 'await_registration')?.status).toBe('in_progress');
    expect(listSessionHosts).not.toHaveBeenCalled();
  });

  it('advances to done once the host appears (case-insensitive match)', async () => {
    listSessionHosts.mockResolvedValue([{ name: 'AVD-CON-4' }]);
    const { pollAwaitingRegistration, withStepStatus } = await import('./sessionHostProvisionOrchestrator');
    const inProgress = record({ state: 'awaiting_registration', stepsJson: JSON.stringify(withStepStatus([], 'await_registration', { status: 'in_progress' }, new Date())) });
    const result = await pollAwaitingRegistration(inProgress);
    expect(result.nextState).toBe('done');
    expect(listSessionHosts).toHaveBeenCalledWith('HP-CONTOSO-PROD', { resolvePowerState: false });
  });

  it('fails honestly once the poll-attempt ceiling is exceeded without the host ever registering', async () => {
    listSessionHosts.mockResolvedValue([]);
    const { pollAwaitingRegistration, withStepStatus } = await import('./sessionHostProvisionOrchestrator');
    const nearCeiling = record({ state: 'awaiting_registration', stepsJson: JSON.stringify(withStepStatus([], 'await_registration', { status: 'in_progress', attempts: 180 }, new Date())) });
    const result = await pollAwaitingRegistration(nearCeiling);
    expect(result.nextState).toBe('failed');
    expect(result.errorMessage).toMatch(/never appeared registered/);
  });
});
