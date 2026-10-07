import { describe, expect, it } from 'vitest';
import type { ImageBuildParams } from '@avdmgr/shared';
import { compareVersions, computeEolDate, deriveBuildResourceNames, describeCleanupGuidance, generateImageBuildPlan, getPlanStep, type ImageBuildPlanContext } from './imageBuildPlan';

const CONTEXT: ImageBuildPlanContext = {
  subscriptionId: '00000000-0000-4000-8000-000000000001',
  resourceGroup: 'RG-AVD-Images',
  location: 'eastus',
  galleryName: 'ACG_AVD_CONTOSO',
  imageDefinitionName: 'WIN11-ENT-MS-M365',
  subnetId: '/subscriptions/sub/resourceGroups/RG-AVD-Network/providers/Microsoft.Network/virtualNetworks/VNET-CONTOSO-PROD/subnets/SNET-MANAGEMENT',
  vmSize: 'Standard_D4ads_v7',
};

const BUILD_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

const PARAMS: ImageBuildParams = {
  version: '2.1.0',
  adminUsername: 'ca.builder',
};

describe('generateImageBuildPlan — dry-run IS the plan (acceptance criterion)', () => {
  it('is a pure function: identical inputs produce an identical plan', () => {
    const now = new Date('2026-08-16T00:00:00.000Z');
    const plan1 = generateImageBuildPlan(PARAMS, BUILD_ID, CONTEXT, now);
    const plan2 = generateImageBuildPlan(PARAMS, BUILD_ID, CONTEXT, now);
    expect(plan1).toEqual(plan2);
  });

  it('NEVER includes any password-shaped field anywhere in the plan output — the plan is generated before this app even generates a password (Opus review MAJOR 5)', () => {
    const plan = generateImageBuildPlan(PARAMS, BUILD_ID, CONTEXT, new Date());
    const serialized = JSON.stringify(plan);
    expect(serialized.toLowerCase()).not.toContain('adminpassword');
    expect(serialized.toLowerCase()).not.toContain('password');
  });

  it('every non-operator-gate step carries a machine-readable resourceName (Opus review MAJOR 8) — never requires parsing the human-readable `resource` string', () => {
    const plan = generateImageBuildPlan(PARAMS, BUILD_ID, CONTEXT, new Date());
    for (const step of plan.steps) {
      if (step.operatorGate) {
        expect(step.resourceName).toBe('');
      } else {
        expect(step.resourceName.length).toBeGreaterThan(0);
        expect(step.resource).toContain(step.resourceName);
      }
    }
  });

  it('includes every documented step id in build-manual order', () => {
    const plan = generateImageBuildPlan(PARAMS, BUILD_ID, CONTEXT, new Date());
    expect(plan.steps.map((s) => s.stepId)).toEqual([
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
    ]);
  });

  it('marks exactly the two operator-gate steps as operatorGate:true, with no ARM call', () => {
    const plan = generateImageBuildPlan(PARAMS, BUILD_ID, CONTEXT, new Date());
    const gated = plan.steps.filter((s) => s.operatorGate);
    expect(gated.map((s) => s.stepId)).toEqual(['operator_checklist_gate', 'operator_test_host_step']);
    for (const step of gated) {
      expect(step.armCall).toBeNull();
    }
  });

  it('every non-operator-gate step declares a concrete ARM call', () => {
    const plan = generateImageBuildPlan(PARAMS, BUILD_ID, CONTEXT, new Date());
    for (const step of plan.steps) {
      if (!step.operatorGate) {
        expect(step.armCall).toEqual(expect.any(String));
        expect(step.armCall!.length).toBeGreaterThan(0);
      }
    }
  });

  it('the VM create step uses the caller-supplied vmSize when given, else falls back to context.vmSize', () => {
    const withSize = generateImageBuildPlan({ ...PARAMS, vmSize: 'Standard_D8ads_v7' }, BUILD_ID, CONTEXT, new Date());
    const vmStep = getPlanStep(withSize, 'create_build_vm');
    expect((vmStep.parameters as { hardwareProfile: { vmSize: string } }).hardwareProfile.vmSize).toBe('Standard_D8ads_v7');

    const withoutSize = generateImageBuildPlan(PARAMS, BUILD_ID, CONTEXT, new Date());
    const defaultVmStep = getPlanStep(withoutSize, 'create_build_vm');
    expect((defaultVmStep.parameters as { hardwareProfile: { vmSize: string } }).hardwareProfile.vmSize).toBe('Standard_D4ads_v7');
  });

  it('uses TrustedLaunch + secure boot + vTPM for the build VM (matches the gallery image definition security type)', () => {
    const plan = generateImageBuildPlan(PARAMS, BUILD_ID, CONTEXT, new Date());
    const vmStep = getPlanStep(plan, 'create_build_vm');
    expect(vmStep.parameters.securityProfile).toEqual({ securityType: 'TrustedLaunch', uefiSettings: { secureBootEnabled: true, vTpmEnabled: true } });
  });

  it('the snapshot step names it SNAP-WIN11-PRE-SYSPREP-{version} and copies from the derived OS disk id', () => {
    const plan = generateImageBuildPlan(PARAMS, BUILD_ID, CONTEXT, new Date());
    const step = getPlanStep(plan, 'create_presysprep_snapshot');
    expect(step.resource).toContain('SNAP-WIN11-PRE-SYSPREP-2.1.0');
    const params = step.parameters as { creationData: { createOption: string; sourceResourceId: string } };
    expect(params.creationData.createOption).toBe('Copy');
    expect(params.creationData.sourceResourceId).toContain('/disks/OSDISK-VM-IMG-');
  });

  it('the sysprep step runs the exact documented command (irreversible — never /mode:vm)', () => {
    const plan = generateImageBuildPlan(PARAMS, BUILD_ID, CONTEXT, new Date());
    const step = getPlanStep(plan, 'run_sysprep');
    const params = step.parameters as { commandId: string; script: string[] };
    expect(params.commandId).toBe('RunPowerShellScript');
    expect(params.script).toEqual(['C:\\Windows\\System32\\Sysprep\\sysprep.exe /generalize /oobe /shutdown']);
    expect(params.script.join(' ')).not.toContain('/mode:vm');
  });

  it('the capture step sources the gallery image version from the build VM id and sets the computed EOL date', () => {
    const now = new Date('2026-08-16T00:00:00.000Z');
    const plan = generateImageBuildPlan(PARAMS, BUILD_ID, CONTEXT, now);
    const step = getPlanStep(plan, 'capture_image_version');
    expect(step.resource).toBe('ACG_AVD_CONTOSO/WIN11-ENT-MS-M365/2.1.0');
    const params = step.parameters as { storageProfile: { source: { virtualMachineId: string } }; publishingProfile: { endOfLifeDate: string; excludeFromLatest: boolean; replicaCount: number } };
    expect(params.storageProfile.source.virtualMachineId).toContain('/virtualMachines/VM-IMG-');
    expect(params.publishingProfile.excludeFromLatest).toBe(false);
    expect(params.publishingProfile.replicaCount).toBe(1);
    expect(params.publishingProfile.endOfLifeDate).toBe(computeEolDate(now));
  });

  it('the test_host_step step points at the existing registration-token flow, not a new mechanism', () => {
    const plan = generateImageBuildPlan(PARAMS, BUILD_ID, CONTEXT, new Date());
    const step = getPlanStep(plan, 'operator_test_host_step');
    expect(step.resource).toContain('registration-token');
  });
});

describe('computeEolDate', () => {
  it('is exactly 18 months after the base date, per the golden-image runbook §4.8', () => {
    expect(computeEolDate(new Date('2026-08-16T00:00:00.000Z'))).toBe('2028-02-16');
  });

  it('matches the real estate example (published 2026-08-13 -> EOL 2028-02-13)', () => {
    expect(computeEolDate(new Date('2026-08-13T15:18:13.210Z'))).toBe('2028-02-13');
  });

  it('MONTH-OVERFLOW (Opus review MAJOR 9): a build started on the 31st clamps to the target month\'s own last day, never spilling into the following month', () => {
    // Aug 31 2026 + 18 months = target month Feb 2028 (leap year, 29 days) — day 31 must clamp to 29, not roll into March.
    expect(computeEolDate(new Date('2026-08-31T00:00:00.000Z'))).toBe('2028-02-29');
  });

  it('clamps to the 28th for a non-leap-year February target', () => {
    // Aug 31 2025 + 18 months = Feb 2027 (not a leap year, 28 days).
    expect(computeEolDate(new Date('2025-08-31T00:00:00.000Z'))).toBe('2027-02-28');
  });

  it('a 30-day target month (e.g. April) still clamps a 31st correctly', () => {
    // Oct 31 2026 + 18 months = April 2028 (30 days).
    expect(computeEolDate(new Date('2026-10-31T00:00:00.000Z'))).toBe('2028-04-30');
  });
});

describe('compareVersions', () => {
  it('is negative when a < b, positive when a > b, zero when equal', () => {
    expect(compareVersions('1.0.0', '2.0.0')).toBeLessThan(0);
    expect(compareVersions('2.0.0', '1.0.0')).toBeGreaterThan(0);
    expect(compareVersions('2.1.0', '2.1.0')).toBe(0);
  });

  it('compares minor/patch correctly even when major is equal', () => {
    expect(compareVersions('2.1.0', '2.2.0')).toBeLessThan(0);
    expect(compareVersions('2.1.5', '2.1.4')).toBeGreaterThan(0);
  });
});

describe('deriveBuildResourceNames', () => {
  it('produces a VM name that is exactly 15 characters (Windows NetBIOS computer-name limit)', () => {
    const names = deriveBuildResourceNames(BUILD_ID, '2.1.0');
    expect(names.vmName).toHaveLength(15);
    expect(names.vmName).toBe('VM-IMG-AAAAAAAA');
  });

  it('is deterministic for the same buildId + version, and different for a different buildId', () => {
    const a = deriveBuildResourceNames(BUILD_ID, '2.1.0');
    const b = deriveBuildResourceNames(BUILD_ID, '2.1.0');
    const c = deriveBuildResourceNames('11111111-2222-3333-4444-555555555555', '2.1.0');
    expect(a).toEqual(b);
    expect(a.vmName).not.toBe(c.vmName);
  });
});

describe('describeCleanupGuidance', () => {
  const names = { vmName: 'VM-IMG-AAAAAAAA', nicName: 'NIC-VM-IMG-AAAAAAAA', diskName: 'OSDISK-VM-IMG-AAAAAAAA', snapshotName: 'SNAP-WIN11-PRE-SYSPREP-2.1.0' };

  it('is empty when cancelled before anything was created', () => {
    expect(describeCleanupGuidance('planned', names, 'RG-AVD-Images')).toBe('');
  });

  it('names the VM/NIC/disk when cancelled while the VM is still being created', () => {
    const guidance = describeCleanupGuidance('vm_creating', names, 'RG-AVD-Images');
    expect(guidance).toContain(names.vmName);
    expect(guidance).toContain(names.nicName);
    expect(guidance).toContain(names.diskName);
    expect(guidance).toContain('did not delete');
  });

  it('explains the pre-Sysprep snapshot is deliberately retained, not debris, once one exists', () => {
    const guidance = describeCleanupGuidance('sysprep_running', names, 'RG-AVD-Images');
    expect(guidance).toContain(names.snapshotName);
    expect(guidance).toContain('rebuild starting point');
  });

  it('warns about a possibly-partial gallery image version when cancelled mid-capture', () => {
    const guidance = describeCleanupGuidance('capturing', names, 'RG-AVD-Images');
    expect(guidance.toLowerCase()).toContain('gallery');
  });
});
