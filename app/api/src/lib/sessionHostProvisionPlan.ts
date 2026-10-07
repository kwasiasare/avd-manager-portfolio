import { SESSION_HOST_PROVISION_STEP_LABELS, type SessionHostProvisionParams, type SessionHostProvisionPlan, type SessionHostProvisionPlanStep, type SessionHostProvisionState, type SessionHostProvisionStepId } from '@avdmgr/shared';

/**
 * AM-50 — THE single source of truth for the guided session-host
 * provisioning plan: an ordered list of every ARM call the provision will
 * make, with the exact resource and parameters each step uses. Both
 * POST .../provisions?dryRun=true (a pure preview — see
 * app/api/src/functions/sessionHostProvisions.ts, which returns this
 * function's output UNCHANGED, with zero mutations) and the real executor
 * (app/api/src/services/sessionHostProvisionOrchestrator.ts, which reads a
 * specific step's `parameters` out of this SAME generated plan rather than
 * re-deriving them) consume this function — mirrors
 * app/api/src/lib/imageBuildPlan.ts's exact "one generator, two consumers"
 * contract so the dry-run preview can never drift from what a real
 * provision actually does.
 *
 * Deliberately has NO Azure SDK / ARM client dependency and takes every
 * external fact as an explicit parameter — a plain, synchronously-testable
 * pure function (see sessionHostProvisionPlan.test.ts).
 *
 * VM/extension shapes verified 2026-08-23 against the LIVE estate capture
 * (the session-host runbook §1-§2 and
 * The captured estate inventory — the real avd-con-0
 * host's own recorded VM properties and extension resources) and this
 * repo's installed @azure/arm-compute@25 .d.ts:
 *   - VM shape (zones/hardwareProfile/storageProfile/osProfile/
 *     networkProfile/securityProfile/diagnosticsProfile/licenseType/
 *     identity): flattened directly onto the resource, same style as
 *     imageBuildPlan.ts's VM step.
 *   - Extension shape: @azure/arm-compute's VirtualMachineExtension
 *     interface names the extension's own `type` property
 *     `typePropertiesType` (NOT `type` — that name is taken by the
 *     resource's own ARM discriminator, "Microsoft.Compute/
 *     virtualMachines/extensions", inherited from TrackedResource). This is
 *     a DEVIATION from this story's literal `"type"` field name — the SDK
 *     forces it, and the raw capture (vm-extensions-avd-con-0.json) itself
 *     stores the extension's type under `typePropertiesType`, confirming
 *     this is the real wire shape, not an SDK quirk to work around.
 */

/** Windows' NetBIOS computer-name limit — the session host's name becomes its VM's computerName VERBATIM (unlike the build VM, which derives a synthetic name from buildId), so this app enforces the same 15-character ceiling imageBuildPlan.ts's build VM name works around (see the golden-image runbook §7.2's "Computer name" row). Enforced by the handler (sessionHostProvisions.ts) before this plan is ever generated. */
export const SESSION_HOST_COMPUTER_NAME_MAX_LENGTH = 15;

/** Fallback VM size (the session-host runbook §1's avd-con-0 capture) used only when the host pool's own vmTemplate.vmSizeId isn't set/parseable — see app/api/src/services/sessionHostProvisionOrchestrator.ts#resolveVmSize. */
export const DEFAULT_SESSION_HOST_VM_SIZE = 'Standard_D4ads_v7';

/** The well-known AVD MDM app id every Entra-joined AVD host enrolls against (the session-host runbook §2) — used by BOTH the AADLoginForWindows extension's settings and the DSC extension's own `mdmId` property. */
const AVD_MDM_ID = '0000000a-0000-0000-c000-000000000000';

/**
 * The AVD agent's published DSC configuration bundle — verified against
 * The captured estate inventory live-captured DSC
 * extension settings (this is the portal's own "Add session host" flow's
 * modulesUrl, not something this app invented). Overridable via
 * SESSION_HOST_DSC_MODULES_URL (see app/api/src/lib/config.ts) for the day
 * Microsoft publishes a newer Configuration_*.zip and this estate needs to
 * move onto it without a code change.
 */
export const DEFAULT_DSC_MODULES_URL = 'https://wvdportalstorageblob.blob.core.windows.net/galleryartifacts/Configuration_1.0.03483.1387.zip';

/** Standard tag scheme this estate applies to every AVD resource (same BUILD_RESOURCE_TAGS values as imageBuildPlan.ts, minus the build-specific ones) — the session-host runbook §1's tag capture. */
const SESSION_HOST_RESOURCE_TAGS = {
  Application: 'Azure Virtual Desktop',
  Criticality: 'High',
  Department: 'IT',
  Owner: 'IT',
  environment: 'prod',
} as const;

/** Everything about the target environment/host pool the plan generator needs but does not itself look up — resolved once by the caller (sessionHostProvisions.ts) from config + live reads, then FROZEN into the persisted row's planContextJson (see sessionHostProvisionService.ts's SessionHostProvisionEntity doc comment) so later timer ticks never re-resolve live config for an in-flight provision. */
export interface SessionHostProvisionPlanContext {
  subscriptionId: string;
  /** RG-AVD-HostPools — where the session host VM and NIC are created, and where its extensions apply (the session-host runbook §1-§2's captured resourceGroup). */
  resourceGroup: string;
  location: string;
  /** ARM resource id of the existing SNET-SESSIONHOSTS subnet in RG-AVD-Network (see app/api/src/lib/config.ts's sessionHostProvision.subnetId doc comment). */
  subnetId: string;
  /** Full ARM resource id of the target gallery image version, e.g. ".../galleries/ACG_AVD_CONTOSO/images/WIN11-ENT-MS-M365/versions/2.2.0" — built from config, never a hardcoded name (see resolvePlanContext in the orchestrator). */
  galleryImageVersionId: string;
  vmSize: string;
  zone: '1' | '2' | '3';
  /** Local admin username for the session host VM — a fixed, config-driven estate convention (app/api/src/lib/config.ts's sessionHostProvision.adminUsername), not operator-supplied — see @avdmgr/shared's SessionHostProvisionParams doc comment for why. */
  adminUsername: string;
  hostPoolName: string;
  /** The host pool's own ARM resource id — used ONLY for the VM's `cm-resource-parent` tag (the session-host runbook §1's tag capture), never for an ARM call itself. */
  hostPoolResourceId: string;
  /** See DEFAULT_DSC_MODULES_URL's doc comment. */
  dscModulesUrl: string;
}

/** Derives every resource name from the operator-supplied session host name — unlike imageBuildPlan.ts's synthetic build-VM naming, the VM's computerName IS the session host name verbatim (see SESSION_HOST_COMPUTER_NAME_MAX_LENGTH). */
export function deriveProvisionResourceNames(sessionHostName: string): { vmName: string; nicName: string } {
  return { vmName: sessionHostName, nicName: `NIC-${sessionHostName}` };
}

function resourceId(context: Pick<SessionHostProvisionPlanContext, 'subscriptionId' | 'resourceGroup'>, provider: string, type: string, name: string): string {
  return `/subscriptions/${context.subscriptionId}/resourceGroups/${context.resourceGroup}/providers/${provider}/${type}/${name}`;
}

/**
 * Generates the complete ordered provisioning plan. `dscToken` is
 * ALWAYS the literal placeholder string below, never a real token — see
 * this module's header comment and @avdmgr/shared's SessionHostProvisionPlanStep.parameters
 * doc comment: the real, freshly-generated registration token is injected
 * into a COPY of this step's protectedSettings at the moment of the real
 * ARM call (sessionHostProvisionOrchestrator.ts#submitDscExtension) —
 * NEVER into this plan object, a dry-run response, or anything persisted to
 * the SessionHostProvision table. Tests assert this placeholder (not a real
 * token shape) is the only value that ever appears here.
 */
const DSC_TOKEN_PLACEHOLDER = '<generated-at-submit-time-never-persisted>';

export function generateSessionHostProvisionPlan(params: SessionHostProvisionParams, context: SessionHostProvisionPlanContext): SessionHostProvisionPlan {
  const names = deriveProvisionResourceNames(params.sessionHostName);
  const nicId = resourceId(context, 'Microsoft.Network', 'networkInterfaces', names.nicName);
  // context.vmSize is ALREADY the fully-resolved value (operator override,
  // else the host pool's own vmTemplate.vmSizeId, else
  // DEFAULT_SESSION_HOST_VM_SIZE — see the start handler's resolution step,
  // sessionHostProvisions.ts) — unlike imageBuildPlan.ts's ImageBuildParams
  // (which are raw, un-resolved operator input the plan generator itself
  // defaults), this plan never re-derives vmSize from `params` directly.
  const vmSize = context.vmSize;

  const steps: SessionHostProvisionPlanStep[] = [
    {
      stepId: 'create_nic',
      label: SESSION_HOST_PROVISION_STEP_LABELS.create_nic,
      targetState: 'nic_creating',
      armCall: 'networkInterfaces.createOrUpdate',
      resource: `${names.nicName} (${context.resourceGroup})`,
      resourceName: names.nicName,
      parameters: {
        location: context.location,
        ipConfigurations: [{ name: 'ipconfig1', subnet: { id: context.subnetId }, privateIPAllocationMethod: 'Dynamic' }],
        // Deliberately NO networkSecurityGroup — relies solely on the
        // SNET-SESSIONHOSTS subnet's own NSG (NSG-SESSIONHOSTS), same
        // "--nsg \"\"" warning as the session-host runbook §1
        // and imageBuildPlan.ts's own build NIC.
        tags: SESSION_HOST_RESOURCE_TAGS,
      },
    },
    {
      stepId: 'create_vm',
      label: SESSION_HOST_PROVISION_STEP_LABELS.create_vm,
      targetState: 'vm_creating',
      armCall: 'virtualMachines.createOrUpdate',
      resource: `${names.vmName} (${context.resourceGroup})`,
      resourceName: names.vmName,
      parameters: {
        location: context.location,
        zones: [context.zone],
        hardwareProfile: { vmSize },
        storageProfile: {
          // Gallery IMAGE VERSION resource id, not a marketplace tuple — see
          // this module's header comment and resolvePlanContext in the
          // orchestrator for how galleryImageVersionId is built/validated.
          imageReference: { id: context.galleryImageVersionId },
          // No `name` — let Azure name the OS disk (the runbooks
          // §1's "`--os-disk-name` is intentionally
          // omitted" warning).
          osDisk: { createOption: 'FromImage', managedDisk: { storageAccountType: 'Premium_LRS' }, deleteOption: 'Detach' },
        },
        osProfile: {
          computerName: names.vmName,
          adminUsername: context.adminUsername,
          // adminPassword is DELIBERATELY OMITTED from this plan/preview
          // object — see @avdmgr/shared's SessionHostProvisionParams doc
          // comment. The real executor generates one
          // (app/api/src/lib/imageBuildSecrets.ts#generateBuildAdminPassword
          // — reused as-is; a session-host VM's password has exactly the
          // same complexity/never-store requirements as a build VM's) and
          // injects it into a COPY of these parameters at the moment of the
          // actual ARM call — never into this plan object, a dry-run
          // response, or anything persisted to the SessionHostProvision
          // table.
          windowsConfiguration: { patchSettings: { patchMode: 'AutomaticByOS', assessmentMode: 'ImageDefault' } },
        },
        networkProfile: { networkInterfaces: [{ id: nicId, primary: true }] },
        securityProfile: { securityType: 'TrustedLaunch', uefiSettings: { secureBootEnabled: true, vTpmEnabled: true } },
        diagnosticsProfile: { bootDiagnostics: { enabled: true } },
        licenseType: 'Windows_Client',
        identity: { type: 'SystemAssigned' },
        tags: { ...SESSION_HOST_RESOURCE_TAGS, 'cm-resource-parent': context.hostPoolResourceId },
      },
    },
    {
      stepId: 'ext_entra_join',
      label: SESSION_HOST_PROVISION_STEP_LABELS.ext_entra_join,
      targetState: 'ext_entra_join',
      armCall: 'virtualMachineExtensions.createOrUpdate',
      resource: `AADLoginForWindows on ${names.vmName} (${context.resourceGroup})`,
      resourceName: 'AADLoginForWindows',
      parameters: {
        location: context.location,
        publisher: 'Microsoft.Azure.ActiveDirectory',
        // SDK deviation — see this module's header comment: the SDK's
        // VirtualMachineExtension.typePropertiesType, not `type`.
        typePropertiesType: 'AADLoginForWindows',
        typeHandlerVersion: '2.0',
        autoUpgradeMinorVersion: true,
        settings: { mdmId: AVD_MDM_ID },
      },
    },
    {
      stepId: 'ext_guest_attestation',
      label: SESSION_HOST_PROVISION_STEP_LABELS.ext_guest_attestation,
      targetState: 'ext_guest_attestation',
      armCall: 'virtualMachineExtensions.createOrUpdate',
      resource: `GuestAttestation on ${names.vmName} (${context.resourceGroup})`,
      resourceName: 'GuestAttestation',
      parameters: {
        location: context.location,
        publisher: 'Microsoft.Azure.Security.WindowsAttestation',
        typePropertiesType: 'GuestAttestation',
        typeHandlerVersion: '1.0',
        autoUpgradeMinorVersion: true,
        settings: {
          AttestationConfig: {
            AscSettings: { ascReportingEndpoint: '', ascReportingFrequency: '' },
            MaaSettings: { maaEndpoint: '', maaTenantName: 'GuestAttestation' },
            disableAlerts: 'false',
            useCustomToken: 'false',
          },
        },
      },
    },
    {
      stepId: 'ext_dsc',
      label: SESSION_HOST_PROVISION_STEP_LABELS.ext_dsc,
      targetState: 'ext_dsc',
      armCall: 'virtualMachineExtensions.createOrUpdate',
      resource: `Microsoft.PowerShell.DSC on ${names.vmName} (${context.resourceGroup})`,
      resourceName: 'Microsoft.PowerShell.DSC',
      parameters: {
        location: context.location,
        publisher: 'Microsoft.Powershell',
        typePropertiesType: 'DSC',
        typeHandlerVersion: '2.73',
        autoUpgradeMinorVersion: true,
        settings: {
          modulesUrl: context.dscModulesUrl,
          configurationFunction: 'Configuration.ps1\\AddSessionHost',
          properties: {
            hostPoolName: context.hostPoolName,
            aadJoin: true,
            UseAgentDownloadEndpoint: true,
            mdmId: AVD_MDM_ID,
          },
        },
        // protectedSettings.properties.registrationInfoToken is ALWAYS this
        // placeholder in the plan/preview — see DSC_TOKEN_PLACEHOLDER's doc
        // comment. Assert-tested (sessionHostProvisionPlan.test.ts) that a
        // real token value never appears here.
        protectedSettings: { properties: { registrationInfoToken: DSC_TOKEN_PLACEHOLDER } },
      },
    },
    {
      stepId: 'await_registration',
      label: SESSION_HOST_PROVISION_STEP_LABELS.await_registration,
      targetState: 'awaiting_registration',
      armCall: 'sessionHosts.list (read-only poll)',
      resource: `${context.hostPoolName} session hosts (${context.resourceGroup})`,
      resourceName: names.vmName,
      parameters: {},
    },
  ];

  return { sessionHostName: params.sessionHostName, steps };
}

/**
 * Honest, human-readable statement of what — if anything — a CANCEL leaves
 * behind in Azure for the operator to clean up manually. Mirrors
 * imageBuildPlan.ts#describeCleanupGuidance exactly in spirit: cancelling
 * never fires deletes on the operator's behalf, so this reports what
 * already exists depending on how far the provision got.
 */
export function describeCleanupGuidance(fromState: SessionHostProvisionState, names: { vmName: string; nicName: string }, resourceGroup: string): string {
  if (fromState === 'planned') {
    return '';
  }
  if (fromState === 'nic_creating') {
    return `Cancelling did not delete anything in Azure. A network interface (${names.nicName}) in ${resourceGroup} may already exist — check before starting a new provision with this session host name.`;
  }
  const vmParts = `the session host VM (${names.vmName}) and its network interface (${names.nicName}) — both in ${resourceGroup}`;
  if (fromState === 'vm_creating') {
    return `Cancelling did not delete anything in Azure. Manually delete ${vmParts} once you no longer need them.`;
  }
  // ext_entra_join / ext_guest_attestation / ext_dsc / awaiting_registration:
  // the VM (and possibly some of its extensions) already exist.
  return `Cancelling did not delete anything in Azure. The session host VM was created and may already have one or more extensions applied — check its Session hosts / Extensions blades before deciding what to do with it. Manually delete ${vmParts} if you no longer need them, or complete the guided flow again from the Portal if the host is otherwise usable.`;
}

/** Looks up one step's plan entry by id — the executor's single point of contact with the generated plan (never re-derives parameters itself). Throws if the plan doesn't contain that step, which would only happen if sessionHostProvisionPlan.ts and the SessionHostProvisionStepId union in @avdmgr/shared drift apart (a bug, not a runtime condition to handle gracefully) — mirrors imageBuildPlan.ts#getPlanStep. */
export function getPlanStep(plan: SessionHostProvisionPlan, stepId: SessionHostProvisionStepId): SessionHostProvisionPlanStep {
  const step = plan.steps.find((s) => s.stepId === stepId);
  if (!step) {
    throw new Error(`sessionHostProvisionPlan.ts / SessionHostProvisionStepId drift: no plan step found for stepId="${stepId}".`);
  }
  return step;
}
