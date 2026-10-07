import { IMAGE_BUILD_STEP_LABELS, type ImageBuildParams, type ImageBuildPlan, type ImageBuildPlanStep, type ImageBuildState, type ImageBuildStepId } from '@avdmgr/shared';

/**
 * AM-27 (M4-S2) — THE single source of truth for the golden-image build
 * plan: an ordered list of every ARM call (or operator-gate) the build will
 * make, with the exact resource and parameters each step uses. Both
 * POST /v1/images/builds?dryRun=true (a pure preview — see
 * app/api/src/functions/imageBuilds.ts, which returns this function's
 * output UNCHANGED, with zero mutations) and the real executor
 * (app/api/src/services/imageBuildOrchestrator.ts, which reads a specific
 * step's `parameters` out of this SAME generated plan rather than
 * re-deriving them) consume this function — so the dry-run preview can
 * never drift from what a real build actually does.
 *
 * Deliberately has NO Azure SDK / ARM client dependency and takes every
 * external fact (subscription, resource group, subnet, VM size, tags,
 * "now") as an explicit parameter — a plain, synchronously-testable pure
 * function (see imageBuildPlan.test.ts, which is this story's acceptance
 * test for "dry-run == the plan").
 *
 * PARAMETER/RESOURCE SOURCES (Microsoft Learn / installed SDK, verified
 * 2026-08-16 against @azure/arm-compute@25 and @azure/arm-network@37's
 * installed .d.ts):
 *   - VM create shape (storageProfile.imageReference/osDisk, osProfile,
 *     networkProfile, securityProfile.uefiSettings/securityType):
 *     @azure/arm-compute's VirtualMachine interface — flattened directly
 *     onto the resource (no `.properties` wrapper) in this SDK major.
 *   - NIC create shape (ipConfigurations[].subnet/privateIPAllocationMethod):
 *     @azure/arm-network's NetworkInterface/NetworkInterfaceIPConfiguration
 *     interfaces — same flattened style.
 *   - Snapshot create-from-disk (creationData.createOption='Copy',
 *     sourceResourceId): @azure/arm-compute's CreationData interface +
 *     KnownDiskCreateOption.Copy ("Create a new disk or snapshot by copying
 *     from a disk or snapshot specified by the given sourceResourceId").
 *   - Gallery image version create-from-VM
 *     (storageProfile.source.virtualMachineId): Microsoft Learn, "Store and
 *     share images in an Azure Compute Gallery" — RBAC Permissions required
 *     to create an ACG Image / VM as source: "For Azure SDK, use the
 *     property properties.storageProfile.source.virtualMachineId" — matches
 *     @azure/arm-compute's GalleryArtifactVersionFullSource.virtualMachineId.
 *   - Run Command shape (commandId/script): @azure/arm-compute's
 *     RunCommandInput interface; commandId 'RunPowerShellScript' is
 *     Microsoft's documented built-in command id for executing an arbitrary
 *     PowerShell script via Run Command ("Run scripts in your Windows VM by
 *     using action Run Commands").
 *   - Sysprep invocation itself: the golden-image runbook §4.7 —
 *     `sysprep.exe /generalize /oobe /shutdown` (NOT /mode:vm — that skips
 *     hardware generalization and breaks Azure deployment).
 *   - Snapshot naming (SNAP-WIN11-PRE-SYSPREP-{version}), EOL date "~18
 *     months out", and the deallocate -> generalize -> sig image-version
 *     create sequence: same document, §4.5 and §4.8.
 */

/** Sizing per the golden-image runbook §4.1: undersized default marketplace VM sizes struggle to patch Windows + Office — size up temporarily for the build. Overridable per-build via ImageBuildParams.vmSize. */
export const DEFAULT_BUILD_VM_SIZE = 'Standard_D4ads_v7';

/** The documented marketplace source image lineage (the golden-image runbook §3/§4.1) — Windows 11 Enterprise multi-session 25H2 with Microsoft 365 Apps preinstalled. Not configurable per-build: this app manages exactly one image definition (see app/api/src/lib/config.ts's imageDefinitionName), and every version of it is built from this same marketplace lineage. */
const MARKETPLACE_IMAGE = {
  publisher: 'MicrosoftWindowsDesktop',
  offer: 'office-365',
  sku: 'win11-25h2-avd-m365',
  version: 'latest',
} as const;

/** Standard tag scheme this estate applies to every AVD resource (the golden-image runbook §1-§3's tag tables). */
const BUILD_RESOURCE_TAGS = {
  Application: 'Azure Virtual Desktop',
  Criticality: 'High',
  Department: 'IT',
  Owner: 'IT',
  environment: 'prod',
} as const;

/** Everything about the target environment/deployment the plan generator needs but does not itself look up — resolved once by the caller (see imageBuilds.ts) from app/api/src/lib/config.ts. */
export interface ImageBuildPlanContext {
  subscriptionId: string;
  /** RG-AVD-Images — where every build resource (VM, NIC, disk, snapshot) is created, per the golden-image runbook §4.1 (the estate's documented build resource group). */
  resourceGroup: string;
  /** Must match the gallery's own region — see config.ts's imageBuild.location doc comment. */
  location: string;
  galleryName: string;
  imageDefinitionName: string;
  /** ARM resource id of the existing, DEDICATED (non-delegated) subnet the build VM's NIC joins — see infra/main.bicep's `imageBuildSubnetName` param doc comment for why this is NOT SNET-MANAGEMENT (that subnet is delegated to Microsoft.App/environments for this app's own Flex Consumption VNet integration and cannot host a VM NIC). */
  subnetId: string;
  vmSize: string;
}

/** Derives every resource name from buildId — VM name is exactly 15 chars ("VM-IMG-" + 8 hex) to avoid Windows' NetBIOS computer-name truncation (see the golden-image runbook §7.2's "Computer name" row for why an untruncated, deliberately-chosen name matters). */
export function deriveBuildResourceNames(buildId: string, version: string) {
  const shortId = buildId.replace(/-/g, '').slice(0, 8).toUpperCase();
  const vmName = `VM-IMG-${shortId}`;
  return {
    vmName,
    nicName: `NIC-${vmName}`,
    diskName: `OSDISK-${vmName}`,
    snapshotName: `SNAP-WIN11-PRE-SYSPREP-${version}`,
  };
}

function resourceId(context: ImageBuildPlanContext, provider: string, type: string, name: string): string {
  return `/subscriptions/${context.subscriptionId}/resourceGroups/${context.resourceGroup}/providers/${provider}/${type}/${name}`;
}

/**
 * The gallery image version's end-of-life date: base date (build start)
 * plus 18 months, per the golden-image runbook §4.8's "end of
 * life date ~18 months out" — matches this app's OWN current published
 * version's real EOL (published 2026-08-13, EOL 2028-02-13 — see
 * app/api/src/services/imagesService.ts's doc comment on preferring ARM's
 * own endOfLifeDate field). Returned as an ISO date (YYYY-MM-DD), matching
 * IMAGE_EOL_DATE's format elsewhere in this app.
 *
 * MONTH-OVERFLOW CLAMPING (Opus review MAJOR 9): naively constructing
 * `Date.UTC(year, month + 18, day)` lets JS's own date-normalization roll a
 * day that doesn't exist in the target month into the FOLLOWING month
 * instead — e.g. a build started 2026-08-31 would compute a target month of
 * February 2028, but `Date.UTC(2028, 1, 31)` silently normalizes to
 * 2028-03-02 (Feb 2028 has only 29 days) rather than erroring or clamping.
 * This function instead computes the target month explicitly, finds ITS
 * actual last day, and clamps the day-of-month to it — so a build started on
 * the 31st of a long month correctly lands on the target month's own last
 * day, never spilling into the month after.
 */
export function computeEolDate(now: Date): string {
  const totalMonths = now.getUTCFullYear() * 12 + now.getUTCMonth() + 18;
  const targetYear = Math.floor(totalMonths / 12);
  const targetMonthIndex = totalMonths % 12;
  // Day 0 of the month AFTER targetMonthIndex is the last day of targetMonthIndex itself.
  const lastDayOfTargetMonth = new Date(Date.UTC(targetYear, targetMonthIndex + 1, 0)).getUTCDate();
  const day = Math.min(now.getUTCDate(), lastDayOfTargetMonth);
  const eol = new Date(Date.UTC(targetYear, targetMonthIndex, day));
  return eol.toISOString().slice(0, 10);
}

/**
 * Strict `major.minor.patch` comparison — returns negative if `a` < `b`,
 * positive if `a` > `b`, 0 if equal. Used by app/api/src/functions/
 * imageBuilds.ts's start handler to enforce that a new build's target
 * version is strictly greater than the currently-published version (Opus
 * review MAJOR 6). Assumes both inputs already matched VERSION_PATTERN
 * (imageBuilds.ts validates the caller-supplied one; the currently-published
 * version comes from ARM's own gallery image version name, which this app's
 * own build flow always writes in the same major.minor.patch form — an
 * unparseable currently-published version is treated as 0.0.0 by the
 * caller, not by this function, so every real version compares greater).
 */
export function compareVersions(a: string, b: string): number {
  const partsA = a.split('.').map(Number);
  const partsB = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (partsA[i] ?? 0) - (partsB[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Generates the complete ordered build plan. `buildId` is always supplied
 * by the caller (even for a dry-run preview — see imageBuilds.ts, which
 * generates a fresh random id for a dry-run too, purely so resource names
 * are deterministic within that one preview; a dry-run's id is never
 * persisted or reused if the operator goes on to start a real build).
 */
export function generateImageBuildPlan(params: ImageBuildParams, buildId: string, context: ImageBuildPlanContext, now: Date = new Date()): ImageBuildPlan {
  const names = deriveBuildResourceNames(buildId, params.version);
  const vmId = resourceId(context, 'Microsoft.Compute', 'virtualMachines', names.vmName);
  const nicId = resourceId(context, 'Microsoft.Network', 'networkInterfaces', names.nicName);
  const diskId = resourceId(context, 'Microsoft.Compute', 'disks', names.diskName);
  const vmSize = params.vmSize?.trim() || context.vmSize || DEFAULT_BUILD_VM_SIZE;

  const steps: ImageBuildPlanStep[] = [
    {
      stepId: 'create_build_nic',
      label: IMAGE_BUILD_STEP_LABELS.create_build_nic,
      targetState: 'vm_creating',
      armCall: 'networkInterfaces.createOrUpdate',
      resource: `${names.nicName} (${context.resourceGroup})`,
      resourceName: names.nicName,
      parameters: {
        location: context.location,
        ipConfigurations: [{ name: 'ipconfig1', subnet: { id: context.subnetId }, privateIPAllocationMethod: 'Dynamic' }],
        // Deliberately NO networkSecurityGroup — relies solely on the
        // build subnet's own subnet-level NSG (see docs/app-registration.md
        // DEPLOY-PREREQS 0.5, which associates NSG-MANAGEMENT with the
        // dedicated build subnet for the same posture), per
        // The golden-image runbook §4.1's warning: an
        // unspecified per-NIC NSG (via `--nsg ""`) avoids layering a
        // second, easy-to-miss NSG with its own default inbound rules
        // alongside the subnet's.
        tags: BUILD_RESOURCE_TAGS,
      },
      operatorGate: false,
    },
    {
      stepId: 'create_build_vm',
      label: IMAGE_BUILD_STEP_LABELS.create_build_vm,
      targetState: 'vm_creating',
      armCall: 'virtualMachines.createOrUpdate',
      resource: `${names.vmName} (${context.resourceGroup})`,
      resourceName: names.vmName,
      parameters: {
        location: context.location,
        hardwareProfile: { vmSize },
        storageProfile: {
          imageReference: MARKETPLACE_IMAGE,
          osDisk: { name: names.diskName, createOption: 'FromImage', managedDisk: { storageAccountType: 'Premium_LRS' } },
        },
        osProfile: {
          computerName: names.vmName,
          adminUsername: params.adminUsername,
          // adminPassword is DELIBERATELY OMITTED from this plan/preview
          // object — this app no longer accepts one from the caller at all
          // (see @avdmgr/shared's ImageBuildParams doc comment). The real
          // executor generates one (imageBuildSecrets.ts) and injects it
          // into a COPY of these parameters at the moment of the actual
          // ARM call — see imageBuildOrchestrator.ts#submitBuildVmCreation
          // — never into this plan object, a dry-run response, or anything
          // persisted to the ImageBuild table.
        },
        networkProfile: { networkInterfaces: [{ id: nicId, primary: true }] },
        securityProfile: { securityType: 'TrustedLaunch', uefiSettings: { secureBootEnabled: true, vTpmEnabled: true } },
        tags: BUILD_RESOURCE_TAGS,
      },
      operatorGate: false,
    },
    {
      stepId: 'operator_checklist_gate',
      label: IMAGE_BUILD_STEP_LABELS.operator_checklist_gate,
      targetState: 'checklist_gate',
      armCall: null,
      resource: 'operator confirmation — no Azure resource',
      resourceName: '',
      parameters: {},
      operatorGate: true,
    },
    {
      stepId: 'create_presysprep_snapshot',
      label: IMAGE_BUILD_STEP_LABELS.create_presysprep_snapshot,
      targetState: 'snapshotting',
      armCall: 'snapshots.createOrUpdate',
      resource: `${names.snapshotName} (${context.resourceGroup})`,
      resourceName: names.snapshotName,
      parameters: { location: context.location, creationData: { createOption: 'Copy', sourceResourceId: diskId }, sku: { name: 'Standard_LRS' }, tags: BUILD_RESOURCE_TAGS },
      operatorGate: false,
    },
    {
      stepId: 'run_sysprep',
      label: IMAGE_BUILD_STEP_LABELS.run_sysprep,
      targetState: 'sysprep_running',
      armCall: 'virtualMachines.runCommand',
      resource: `${names.vmName} (${context.resourceGroup})`,
      resourceName: names.vmName,
      parameters: {
        commandId: 'RunPowerShellScript',
        script: ['C:\\Windows\\System32\\Sysprep\\sysprep.exe /generalize /oobe /shutdown'],
      },
      operatorGate: false,
    },
    {
      stepId: 'await_stopped',
      label: IMAGE_BUILD_STEP_LABELS.await_stopped,
      targetState: 'awaiting_stopped',
      armCall: 'virtualMachines.instanceView (read-only poll)',
      resource: `${names.vmName} (${context.resourceGroup})`,
      resourceName: names.vmName,
      parameters: {},
      operatorGate: false,
    },
    {
      stepId: 'ensure_deallocated',
      label: IMAGE_BUILD_STEP_LABELS.ensure_deallocated,
      targetState: 'capturing',
      armCall: 'virtualMachines.deallocate',
      resource: `${names.vmName} (${context.resourceGroup})`,
      resourceName: names.vmName,
      parameters: {},
      operatorGate: false,
    },
    {
      stepId: 'generalize_vm',
      label: IMAGE_BUILD_STEP_LABELS.generalize_vm,
      targetState: 'capturing',
      armCall: 'virtualMachines.generalize',
      resource: `${names.vmName} (${context.resourceGroup})`,
      resourceName: names.vmName,
      parameters: {},
      operatorGate: false,
    },
    {
      stepId: 'capture_image_version',
      label: `${IMAGE_BUILD_STEP_LABELS.capture_image_version} ${params.version}`,
      targetState: 'capturing',
      armCall: 'galleryImageVersions.createOrUpdate',
      resource: `${context.galleryName}/${context.imageDefinitionName}/${params.version}`,
      resourceName: params.version,
      parameters: {
        location: context.location,
        publishingProfile: {
          targetRegions: [{ name: context.location, regionalReplicaCount: 1, storageAccountType: 'Standard_LRS' }],
          replicaCount: 1,
          excludeFromLatest: false,
          endOfLifeDate: computeEolDate(now),
        },
        storageProfile: { source: { virtualMachineId: vmId } },
        tags: BUILD_RESOURCE_TAGS,
      },
      operatorGate: false,
    },
    {
      stepId: 'operator_test_host_step',
      label: IMAGE_BUILD_STEP_LABELS.operator_test_host_step,
      targetState: 'test_host_step',
      armCall: null,
      resource: 'operator confirmation — reuses POST /v1/hostpools/{hostPoolName}/registration-token',
      resourceName: '',
      parameters: {},
      operatorGate: true,
    },
    {
      stepId: 'delete_build_vm',
      label: IMAGE_BUILD_STEP_LABELS.delete_build_vm,
      targetState: 'cleanup',
      armCall: 'virtualMachines.delete',
      resource: `${names.vmName} (${context.resourceGroup})`,
      resourceName: names.vmName,
      parameters: {},
      operatorGate: false,
    },
    {
      stepId: 'delete_build_nic',
      label: IMAGE_BUILD_STEP_LABELS.delete_build_nic,
      targetState: 'cleanup',
      armCall: 'networkInterfaces.delete',
      resource: `${names.nicName} (${context.resourceGroup})`,
      resourceName: names.nicName,
      parameters: {},
      operatorGate: false,
    },
    {
      stepId: 'delete_build_disk',
      label: IMAGE_BUILD_STEP_LABELS.delete_build_disk,
      targetState: 'cleanup',
      armCall: 'disks.delete',
      resource: `${names.diskName} (${context.resourceGroup})`,
      resourceName: names.diskName,
      parameters: {},
      operatorGate: false,
    },
  ];

  return { version: params.version, steps };
}

/**
 * Honest, human-readable statement of what — if anything — a CANCEL leaves
 * behind in Azure for the operator to clean up manually (see
 * app/api/src/functions/imageBuilds.ts's cancel handler: cancelling never
 * fires deletes on the operator's behalf — it only stops the state machine
 * and reports what still exists). Pure function of the state cancel was
 * called FROM and the build's derived resource names, so it's unit-testable
 * without a Table/ARM client (see imageBuildPlan.test.ts).
 */
export function describeCleanupGuidance(
  fromState: ImageBuildState,
  names: { vmName: string; nicName: string; diskName: string; snapshotName: string },
  resourceGroup: string,
): string {
  if (fromState === 'planned') {
    return '';
  }
  const vmParts = `the build VM (${names.vmName}), its network interface (${names.nicName}), and its OS disk (${names.diskName}) — all in ${resourceGroup}`;
  if (fromState === 'vm_creating' || fromState === 'vm_ready' || fromState === 'checklist_gate') {
    return `Cancelling did not delete anything in Azure. Manually delete ${vmParts} once you no longer need them.`;
  }
  if (fromState === 'snapshotting' || fromState === 'sysprep_running' || fromState === 'awaiting_stopped') {
    return (
      `Cancelling did not delete anything in Azure. Manually delete ${vmParts}. ` +
      `The pre-Sysprep snapshot (${names.snapshotName}) was left in place — it is a normal rebuild starting point ` +
      `(see the golden-image runbook §4.5), not build debris; delete it separately only if you are certain you will not restart this build from it.`
    );
  }
  if (fromState === 'capturing') {
    return (
      `Cancelling did not delete anything in Azure, and did NOT stop an in-flight gallery image version create if one was already submitted — ` +
      `check the gallery for a partially-created or stray version before republishing this version number. Manually delete ${vmParts} once you no longer need them. ` +
      `The pre-Sysprep snapshot (${names.snapshotName}) was left in place — see the golden-image runbook §4.5.`
    );
  }
  // test_host_step: capture already succeeded — the build VM/NIC/disk are
  // now ordinary leftover build resources, same guidance as any completed
  // build's pre-cleanup state.
  return `The image version was already captured successfully. Manually delete ${vmParts} — the same cleanup this build would otherwise have run automatically. The pre-Sysprep snapshot (${names.snapshotName}) was left in place — see the golden-image runbook §4.5.`;
}

/** Looks up one step's plan entry by id — the executor's single point of contact with the generated plan (never re-derives parameters itself). Throws if the plan doesn't contain that step, which would only happen if imageBuildPlan.ts and the ImageBuildStepId union in @avdmgr/shared drift apart (a bug, not a runtime condition to handle gracefully). */
export function getPlanStep(plan: ImageBuildPlan, stepId: ImageBuildStepId): ImageBuildPlanStep {
  const step = plan.steps.find((s) => s.stepId === stepId);
  if (!step) {
    throw new Error(`imageBuildPlan.ts / ImageBuildStepId drift: no plan step found for stepId="${stepId}".`);
  }
  return step;
}
