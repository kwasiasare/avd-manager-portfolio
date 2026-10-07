// AM-47 — least-privilege custom role for the staged rollout's THIRD
// cutover gate: the FSLogix config-convergence validation check
// (app/api/src/functions/rolloutPlans.ts's verify-config action, submitting
// via computeService.ts#submitFslogixConfigCheck; polled read-only by
// rolloutPlanTimer.ts via computeService.ts#getFslogixConfigCheckResult —
// see app/api/src/lib/fslogixConfigCheck.ts for the full architecture).
//
// WHY A NEW, SEPARATE ROLE (not folded into rolloutOperatorRole.bicep or
// imageBuildOperatorRole.bicep): this repo's established convention (see
// rolloutOperatorRole.bicep's own header comment) is that a NEW capability
// class gets a NEW, independently-revocable role rather than widening an
// existing one's blast radius. `runCommands/write` is a materially
// different — and materially BROADER — capability than anything
// rolloutOperatorRole.bicep grants (sessionhosts/delete + VM delete, both
// bounded, auditable, single-purpose actions): it is SYSTEM-level arbitrary
// code execution. Assigning it as its own role means staged rollouts can
// keep running host-removal (rolloutOperatorRole) even if this
// config-check capability is ever revoked on its own — e.g. during an
// incident, or if this feature is ever retired — without touching the
// removal grant every rollout still depends on.
//
// BLAST RADIUS — READ BEFORE ASSIGNING THIS ROLE ANYWHERE ELSE (same
// "state it plainly" posture as imageBuildOperatorRole.bicep's own runCommand
// warning, §55-68 of that file): `Microsoft.Compute/virtualMachines/
// runCommands/write` is NOT a narrow "read one registry key" permission —
// Run Command (v1 action OR this v2 child-resource form) executes an
// ARBITRARY PowerShell script AS SYSTEM on the target VM, with no RBAC-level
// way to restrict WHICH script runs. A principal holding this role can run
// anything, as SYSTEM, on ANY VM in the scoped resource group
// (RG-AVD-HostPools in prod) — i.e. every production AVD session host, not
// just the ones a given rollout plan names. This app's OWN code only ever
// creates the ONE run command documented in
// app/api/src/lib/fslogixConfigCheck.ts (a read-only registry dump, no
// system mutation), but the GRANT itself is exactly as broad as "this
// identity can run anything, as SYSTEM, on any VM in RG-AVD-HostPools" —
// it is not narrowed by this role definition beyond scoping WHICH resource
// group.
//
// WHY ACCEPTED ANYWAY: the config-convergence gate requires reading the
// DELIVERED FSLogix registry state on each host — there is no narrower ARM
// action for "read one registry key from a VM" than Run Command (classic OR
// v2; see the SDK-selection rationale in app/api/src/lib/fslogixConfigCheck.ts's
// header comment for why v2 specifically was chosen over the classic
// action). This role is separately revocable from every other grant this
// app holds (see above), gated behind admin-only auth
// (rolloutPlans.ts's loadAction — every rollout route is admin-only) and a
// state-machine check (verify-config is legal ONLY in validating_new), and
// every run it submits is audited (rollout.verify_config).
//
// runCommands/delete is included even though this app's own code never
// calls it — createOrUpdate is idempotent BY NAME (see
// computeService.ts#submitFslogixConfigCheck's doc comment: re-running the
// check overwrites the SAME child resource rather than accumulating one per
// attempt), so this role does not need delete for that reuse pattern to
// work. It is granted anyway purely for OPERATIONAL SELF-SUFFICIENCY — an
// operator/script cleaning up the `avdmgr-fslogix-check` child resources
// this app leaves behind on session host VMs should not need a FOURTH role
// grant just for that housekeeping. (No code path in this app calls delete
// today — this is a deliberately narrow "this role should be able to clean
// up after itself" grant, not a hidden feature.)
//
// Action strings confirmed via Microsoft Learn's Compute permissions
// reference (https://learn.microsoft.com/azure/role-based-access-control/permissions/compute#microsoftcompute) —
// `Microsoft.Compute/virtualMachines/runCommands/read`,
// `.../runCommands/write`, `.../runCommands/delete` are the RBAC actions
// backing `@azure/arm-compute`'s `virtualMachineRunCommands` operation
// group (getByVirtualMachine / createOrUpdate / delete respectively) —
// distinct from `Microsoft.Compute/virtualMachines/runCommand/action`
// (singular "runCommand" — the CLASSIC action imageBuildOperatorRole.bicep
// grants for Sysprep), which this role does NOT need since this feature
// uses the v2 child-resource form exclusively.
//
// `Microsoft.Compute/virtualMachines/read` is ALSO included —
// computeService.ts#submitFslogixConfigCheck reads the target VM's own
// `location` (required on the VirtualMachineRunCommand payload) via
// `virtualMachines.get` before submitting. This is technically redundant
// with rolloutOperatorRole.bicep's own virtualMachines/read grant (assigned
// to the SAME principal at the SAME rgHostPools scope), but included here
// anyway for the same "self-sufficient role" reasoning
// rolloutOperatorRole.bicep's own header comment gives for its
// DesktopVirtualization reads: this role should not depend on
// rolloutOperatorRole staying assigned to keep working.
//
// SCOPE: RESOURCE GROUP (RG-AVD-HostPools in prod) — same rgHostPools scope
// as rolloutOperatorRole.bicep/sessionHostWriterRole.bicep/
// vmPowerOperatorRole.bicep, the narrowest this repo's main.bicep + module
// `scope:` redirection pattern supports. Same ACCEPTED WHOLE-RESOURCE-GROUP
// RISK those modules' own header comments document: if RG-AVD-HostPools
// ever hosts VMs unrelated to HP-CONTOSO-PROD, this role's runCommands/write
// could execute arbitrary code on those too.
targetScope = 'resourceGroup'

@description('Deployment environment (dev/test/prod). Both the role definition resource name (a GUID, generated below) and its display name (roleName) must be unique within the Microsoft Entra TENANT — not just this resource group — even though assignableScopes narrows where the role can be ASSIGNED (see https://learn.microsoft.com/azure/role-based-access-control/custom-roles#custom-role-properties). Parameterizing with environmentName keeps dev/test/prod deployments in this same tenant from colliding.')
param environmentName string

@description('Principal ID (object ID) of the Function App system-assigned managed identity to assign this role to.')
param principalId string

resource sessionHostConfigCheckRoleDefinition 'Microsoft.Authorization/roleDefinitions@2022-04-01' = {
  name: guid(subscription().id, 'AVD Manager Config Check Operator', environmentName)
  properties: {
    roleName: 'AVD Manager Config Check Operator (${environmentName})'
    description: 'AVD Manager (AM-47): submit and read back the staged rollout wizard\'s FSLogix config-convergence check (Run Command v2) against session host VMs. WARNING: runCommands/write grants SYSTEM-level arbitrary code execution on any VM in this resource group, not just the specific host being checked — see this file\'s header comment for the full blast-radius account and why it is accepted.'
    type: 'CustomRole'
    permissions: [
      {
        actions: [
          'Microsoft.Compute/virtualMachines/read'
          'Microsoft.Compute/virtualMachines/runCommands/write'
          'Microsoft.Compute/virtualMachines/runCommands/read'
          'Microsoft.Compute/virtualMachines/runCommands/delete'
        ]
        notActions: []
        dataActions: []
        notDataActions: []
      }
    ]
    assignableScopes: [
      resourceGroup().id
    ]
  }
}

resource sessionHostConfigCheckAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(resourceGroup().id, principalId, sessionHostConfigCheckRoleDefinition.id)
  properties: {
    principalId: principalId
    roleDefinitionId: sessionHostConfigCheckRoleDefinition.id
    principalType: 'ServicePrincipal'
  }
}

output roleDefinitionId string = sessionHostConfigCheckRoleDefinition.id
