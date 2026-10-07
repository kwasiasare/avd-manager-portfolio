import type { SessionHostProvisionDetail, SessionHostProvisionPlan, SessionHostProvisionStepId } from '@avdmgr/shared';
import { SESSION_HOST_PROVISION_STEP_LABELS } from '@avdmgr/shared';
import { DAY, MINUTE, fakeGuid } from './time';
import { HOST_POOL_NAME, RG, upn } from './estate';

export function buildProvisions(now: number): SessionHostProvisionDetail[] {
  const stepIds: SessionHostProvisionStepId[] = ['create_nic', 'create_vm', 'ext_entra_join', 'ext_guest_attestation', 'ext_dsc', 'await_registration'];
  const started = now - 20 * DAY;
  return [
    {
      provisionId: fakeGuid(501),
      hostPoolName: HOST_POOL_NAME,
      sessionHostName: 'avd-con-5',
      zone: '2',
      vmSize: 'Standard_D4ads_v7',
      imageVersion: '1.2.0',
      state: 'done',
      createdAt: new Date(started).toISOString(),
      updatedAt: new Date(started + 14 * MINUTE).toISOString(),
      createdBy: upn('priya.nair'),
      vmName: 'avd-con-5',
      nicName: 'NIC-avd-con-5',
      steps: stepIds.map((stepId, index) => ({
        stepId,
        status: 'succeeded' as const,
        startedAt: new Date(started + index * 2 * MINUTE).toISOString(),
        completedAt: new Date(started + (index * 2 + 1.5) * MINUTE).toISOString(),
        attempts: 1,
      })),
    },
  ] satisfies SessionHostProvisionDetail[];
}

export function buildProvisionDryRunPlan(sessionHostName: string): SessionHostProvisionPlan {
  const rows: Array<{ stepId: SessionHostProvisionStepId; targetState: SessionHostProvisionPlan['steps'][number]['targetState']; armCall: string; resource: string }> = [
    { stepId: 'create_nic', targetState: 'nic_creating', armCall: 'networkInterfaces.createOrUpdate', resource: `NIC-${sessionHostName}` },
    { stepId: 'create_vm', targetState: 'vm_creating', armCall: 'virtualMachines.createOrUpdate', resource: sessionHostName },
    { stepId: 'ext_entra_join', targetState: 'ext_entra_join', armCall: 'virtualMachineExtensions.createOrUpdate', resource: `${sessionHostName}/AADLoginForWindows` },
    { stepId: 'ext_guest_attestation', targetState: 'ext_guest_attestation', armCall: 'virtualMachineExtensions.createOrUpdate', resource: `${sessionHostName}/GuestAttestation` },
    { stepId: 'ext_dsc', targetState: 'ext_dsc', armCall: 'virtualMachineExtensions.createOrUpdate', resource: `${sessionHostName}/Microsoft.PowerShell.DSC` },
    { stepId: 'await_registration', targetState: 'awaiting_registration', armCall: 'sessionHosts.get', resource: `${HOST_POOL_NAME}/${sessionHostName}` },
  ];
  return {
    sessionHostName,
    steps: rows.map((row) => ({
      stepId: row.stepId,
      label: SESSION_HOST_PROVISION_STEP_LABELS[row.stepId],
      targetState: row.targetState,
      armCall: row.armCall,
      resource: `${row.resource} (${RG.hostPools})`,
      resourceName: row.resource,
      parameters: { note: 'Illustrative demo plan — nothing is created.' },
    })),
  };
}
