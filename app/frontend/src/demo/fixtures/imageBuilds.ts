import {
  IMAGE_BUILD_CHECKLIST,
  IMAGE_BUILD_STEP_LABELS,
  type ImageBuildDetail,
  type ImageBuildPlan,
  type ImageBuildPlanStep,
  type ImageBuildState,
  type ImageBuildStepId,
  type ImageBuildStepState,
  type ImageBuildStepStatus,
} from '@avdmgr/shared';
import { DAY, HOUR, MINUTE, ago, fakeGuid } from './time';
import { GALLERY_NAME, IMAGE_DEFINITION, RG, armId, upn } from './estate';

export const GATED_BUILD_ID = fakeGuid(301);
export const DONE_BUILD_ID = fakeGuid(302);

const STEP_ORDER: ImageBuildStepId[] = [
  'create_build_nic',
  'create_build_vm',
  'operator_checklist_gate',
  'create_presysprep_snapshot',
  'run_sysprep',
  'await_stopped',
  'ensure_deallocated',
  'generalize_vm',
  'capture_image_version',
  'operator_test_host_step',
  'delete_build_vm',
  'delete_build_nic',
  'delete_build_disk',
];

function steps(now: number, succeededThrough: number, inProgressIndex: number | undefined, startedMinutesAgo: number): ImageBuildStepState[] {
  return STEP_ORDER.map((stepId, index): ImageBuildStepState => {
    let status: ImageBuildStepStatus = 'pending';
    if (index <= succeededThrough) status = 'succeeded';
    else if (index === inProgressIndex) status = 'in_progress';
    const stepState: ImageBuildStepState = { stepId, status };
    if (status !== 'pending') {
      stepState.startedAt = ago(now, (startedMinutesAgo - index * 4) * MINUTE);
      stepState.attempts = 1;
    }
    if (status === 'succeeded') stepState.completedAt = ago(now, (startedMinutesAgo - index * 4 - 3) * MINUTE);
    return stepState;
  });
}

const names = (shortId: string, version: string) => ({
  vmName: `VM-IMG-${shortId}`,
  nicName: `NIC-VM-IMG-${shortId}`,
  diskName: `OSDISK-VM-IMG-${shortId}`,
  snapshotName: `SNAP-WIN11-PRE-SYSPREP-${version}`,
});

/** All checklist items ticked except `unticked` ids. */
export function checklistWithout(unticked: string[]): Record<string, boolean> {
  return Object.fromEntries(IMAGE_BUILD_CHECKLIST.map((item) => [item.id, !unticked.includes(item.id)]));
}

export function buildImageBuilds(now: number): ImageBuildDetail[] {
  return [
    // In-flight build parked at the operator checklist gate; 3 items left so a visitor can tick them (simulated).
    {
      buildId: GATED_BUILD_ID,
      version: '1.4.0',
      state: 'checklist_gate',
      createdAt: ago(now, 50 * MINUTE),
      updatedAt: ago(now, 12 * MINUTE),
      createdBy: upn('li.wei'),
      ...names('A1B2C3D4', '1.4.0'),
      checklist: checklistWithout(['lob_apps_tested', 'vdot_run_last', 'no_pending_reboot']),
      steps: steps(now, 1, 2, 50),
      baseImageExactVersion: '26100.4652.250707',
      snapshotStatus: 'unknown',
      snapshotDeletable: false,
      snapshotDeleteBlockedReason: 'The build has not finished.',
    },
    // The completed build behind the current 1.3.0 gallery version.
    {
      buildId: DONE_BUILD_ID,
      version: '1.3.0',
      state: 'done',
      createdAt: ago(now, 12 * DAY + 3 * HOUR),
      updatedAt: ago(now, 12 * DAY),
      createdBy: upn('priya.nair'),
      ...names('E5F6A7B8', '1.3.0'),
      checklist: checklistWithout([]),
      steps: steps(now, STEP_ORDER.length - 1, undefined, 180).map((step) => ({ ...step, startedAt: ago(now, 12 * DAY + 3 * HOUR - 3 * MINUTE), completedAt: ago(now, 12 * DAY + 10 * MINUTE) })),
      capturedImageVersionId: armId(RG.images, `Microsoft.Compute/galleries/${GALLERY_NAME}/images/${IMAGE_DEFINITION}/versions/1.3.0`),
      baseImageExactVersion: '26100.4349.250607',
      snapshotStatus: 'present',
      snapshotDeletable: true,
    },
  ] satisfies ImageBuildDetail[];
}

const PLAN_STEPS: Array<{ stepId: ImageBuildStepId; targetState: ImageBuildState; armCall: string | null; resourceKind: string }> = [
  { stepId: 'create_build_nic', targetState: 'vm_creating', armCall: 'networkInterfaces.createOrUpdate', resourceKind: 'nic' },
  { stepId: 'create_build_vm', targetState: 'vm_creating', armCall: 'virtualMachines.createOrUpdate', resourceKind: 'vm' },
  { stepId: 'operator_checklist_gate', targetState: 'checklist_gate', armCall: null, resourceKind: 'gate' },
  { stepId: 'create_presysprep_snapshot', targetState: 'snapshotting', armCall: 'snapshots.createOrUpdate', resourceKind: 'snapshot' },
  { stepId: 'run_sysprep', targetState: 'sysprep_running', armCall: 'virtualMachines.runCommand', resourceKind: 'vm' },
  { stepId: 'await_stopped', targetState: 'awaiting_stopped', armCall: 'virtualMachines.instanceView', resourceKind: 'vm' },
  { stepId: 'ensure_deallocated', targetState: 'awaiting_stopped', armCall: 'virtualMachines.deallocate', resourceKind: 'vm' },
  { stepId: 'generalize_vm', targetState: 'capturing', armCall: 'virtualMachines.generalize', resourceKind: 'vm' },
  { stepId: 'capture_image_version', targetState: 'capturing', armCall: 'galleryImageVersions.createOrUpdate', resourceKind: 'version' },
  { stepId: 'operator_test_host_step', targetState: 'test_host_step', armCall: null, resourceKind: 'gate' },
  { stepId: 'delete_build_vm', targetState: 'cleanup', armCall: 'virtualMachines.delete', resourceKind: 'vm' },
  { stepId: 'delete_build_nic', targetState: 'cleanup', armCall: 'networkInterfaces.delete', resourceKind: 'nic' },
  { stepId: 'delete_build_disk', targetState: 'cleanup', armCall: 'disks.delete', resourceKind: 'disk' },
];

/** The ordered plan a dry-run returns — illustrative ARM calls, nothing is executed. */
export function buildDryRunPlan(version: string): ImageBuildPlan {
  const n = names('DRYRUN00', version);
  const resourceName = (kind: string) => ({ nic: n.nicName, vm: n.vmName, snapshot: n.snapshotName, version, disk: n.diskName, gate: '' })[kind] ?? '';
  const planSteps: ImageBuildPlanStep[] = PLAN_STEPS.map((step) => {
    const name = resourceName(step.resourceKind);
    return {
      stepId: step.stepId,
      label: IMAGE_BUILD_STEP_LABELS[step.stepId],
      targetState: step.targetState,
      armCall: step.armCall,
      resource: step.armCall ? `${name} (${RG.images})` : 'operator confirmation — no Azure resource',
      resourceName: name,
      parameters: step.armCall ? { location: 'eastus', note: 'Illustrative demo plan — nothing is created.' } : {},
      operatorGate: step.armCall === null,
    };
  });
  return { version, steps: planSteps };
}
