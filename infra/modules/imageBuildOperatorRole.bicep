// AM-27 (M4-S2) — least-privilege custom role for the golden-image build
// orchestrator's Microsoft.Compute ARM writes (build VM create/delete,
// pre-Sysprep snapshot create, Sysprep Run Command, deallocate/generalize,
// gallery image version create, OS disk delete — see
// app/api/src/services/imageBuildOrchestrator.ts).
//
// SCOPE: RG-AVD-Images — every build resource (VM, NIC, OS disk, snapshot)
// AND the target Compute Gallery/image definition all live in this ONE
// resource group, per the golden-image runbook §1 (gallery),
// §4.1 (build VM), and §4.5 (snapshot). Deployed at RESOURCE GROUP scope,
// same pattern as sessionHostWriterRole.bicep/vmPowerOperatorRole.bicep
// (targetScope redirected by main.bicep's `scope: resourceGroup(rgImages)`
// module invocation).
//
// WHY a custom role instead of a built-in one: the closest built-in,
// "Desktop Virtualization Virtual Machine Contributor"
// (a959dbd1-f747-45e3-8ba6-dd80f235f97c — confirmed via Microsoft Learn's
// built-in-roles reference,
// https://learn.microsoft.com/azure/role-based-access-control/built-in-roles/compute#desktop-virtualization-virtual-machine-contributor),
// is meant for the AVD RESOURCE PROVIDER's own service principal (not this
// app's Function App identity) and over-grants relative to what this
// feature calls: it includes virtualMachines/powerOff/action (not used —
// this feature only ever deallocates), does not include
// Microsoft.Compute/snapshots/* or galleries/images/versions/* at all (both
// required here), and does not include virtualMachines/delete or
// virtualMachines/generalize/action either (both required for cleanup and
// capture). Rather than layering a second built-in role on top (which would
// ALSO grant its own unrelated actions — e.g. Virtual Machine Contributor
// additionally grants virtualMachines/write for the WHOLE resource group
// regardless of which VM), this module defines a role with exactly the
// actions app/api/src/services/imageBuildOrchestrator.ts calls.
//
// Action strings confirmed via Microsoft Learn's Compute permissions
// reference (https://learn.microsoft.com/azure/role-based-access-control/permissions/compute#microsoftcompute)
// and, for the VM-as-source gallery capture flow specifically, "Store and
// share images in an Azure Compute Gallery" — RBAC Permissions required to
// create an ACG Image / VM as source
// (https://learn.microsoft.com/azure/virtual-machines/shared-image-galleries#rbac-permissions-required-to-create-an-acg-image):
// capturing a VM into a gallery image version requires WRITE on the source
// VM (Microsoft.Compute/virtualMachines/write) in addition to
// galleries/images/versions/write on the target — both already present
// below for VM creation.
//
// ACCEPTED RISK — deferred, not implemented here, same posture as
// vmPowerOperatorRole.bicep's own header comment: this role's
// assignableScopes/assignment cover the WHOLE resource group, not just the
// specific build VM/NIC/disk/snapshot names a given build creates — Azure
// custom roles cannot scope to a dynamic, per-deployment resource name set.
// RG-AVD-Images is otherwise a fairly narrow blast radius already (image
// build VMs and the Compute Gallery only, per the estate's own resource
// group design — the golden-image runbook §1's provenance note),
// but if that resource group ever hosts unrelated Compute resources, this
// role could act on those too.
//
// runCommand HONESTY (Opus review MINOR 14 — document blast radius
// plainly, not just narrowly): `Microsoft.Compute/virtualMachines/
// runCommand/action` is NOT a narrow "run Sysprep" permission — it is
// SYSTEM-level, ARBITRARY PowerShell code execution on ANY VM in
// RG-AVD-Images this app's managed identity can reach (see Microsoft
// Learn's "Run scripts in your Windows VM by using action Run Commands" —
// the underlying mechanism runs as SYSTEM via the VM agent, with no way to
// further restrict which script it executes at the RBAC layer). This app's
// OWN code only ever calls it with the one documented Sysprep invocation
// (see app/api/src/lib/imageBuildPlan.ts's run_sysprep step), but the GRANT
// itself is exactly as broad as "this identity can run anything, as
// SYSTEM, on any VM in this resource group" — it is not narrowed by this
// role definition beyond scoping WHICH resource group. If RG-AVD-Images
// ever hosts a VM this app did not create, that VM is equally reachable.
//
// AM-53 (2026-08-23) ADDS Microsoft.Compute/snapshots/delete — operator-
// confirmed pre-Sysprep snapshot retention (app/api/src/functions/
// imageBuilds.ts's DELETE .../builds/{buildId}/snapshot handler), gated
// server-side on the build being `done` and its version having completed a
// rollout (app/api/src/lib/imageBuildSnapshotGate.ts) before this identity
// ever calls it. WHY: this role already had snapshots/read+write+
// beginGetAccess (the AM-44-era finding above) but not delete — without
// this app, SNAP-WIN11-PRE-SYSPREP-<version> snapshots in RG-AVD-Images
// accumulated with no owner able to retire them via the app itself. BLAST
// RADIUS — same posture as every other action in this role: scoped to
// RG-AVD-Images only, but NOT further scoped to a specific snapshot name —
// this identity can delete ANY snapshot in this resource group, not only
// the ones its own build feature created (Azure custom roles cannot scope
// to a dynamic, per-deployment resource name set — see this file's
// ACCEPTED RISK paragraph above, which already documents this exact
// limitation for every other action here).
targetScope = 'resourceGroup'

@description('Deployment environment (dev/test/prod) — see vmPowerOperatorRole.bicep\'s identical param for why this is required (role definition name/roleName uniqueness is TENANT-wide, not RG-scoped).')
param environmentName string

@description('Principal ID (object ID) of the Function App system-assigned managed identity to assign this role to.')
param principalId string

resource imageBuildOperatorRoleDefinition 'Microsoft.Authorization/roleDefinitions@2022-04-01' = {
  name: guid(subscription().id, 'AVD Manager Image Build Operator', environmentName)
  properties: {
    roleName: 'AVD Manager Image Build Operator (${environmentName})'
    description: 'AVD Manager (AM-27/M4-S2, AM-53): create/delete the throwaway build VM and its OS disk, create the pre-Sysprep snapshot, run the Sysprep Run Command, deallocate/generalize the build VM, create the resulting gallery image version, and (AM-53) delete a pre-Sysprep snapshot once its build is done and its version has completed a rollout. Deliberately narrower than the built-in Desktop Virtualization Virtual Machine Contributor role: no powerOff/action, and adds snapshots/* and galleries/images/versions/write which that built-in role lacks. WARNING: runCommand/action grants SYSTEM-level arbitrary code execution on any VM in this resource group, not just the build VM — see this file\'s header comment.'
    type: 'CustomRole'
    permissions: [
      {
        actions: [
          'Microsoft.Compute/virtualMachines/read'
          'Microsoft.Compute/virtualMachines/write'
          'Microsoft.Compute/virtualMachines/delete'
          'Microsoft.Compute/virtualMachines/deallocate/action'
          'Microsoft.Compute/virtualMachines/generalize/action'
          'Microsoft.Compute/virtualMachines/runCommand/action'
          'Microsoft.Compute/disks/read'
          'Microsoft.Compute/disks/write'
          'Microsoft.Compute/disks/delete'
          // AM-44-era live finding (2026-08-22, correlation 31738d31): creating a
          // snapshot FROM a managed disk requires beginGetAccess on the SOURCE
          // disk — snapshots/write alone fails with "does not have permission to
          // perform 'Microsoft.Compute/disks/beginGetAccess/action' on the linked
          // scope". Never hit before because the 1.0/2.0 images were built
          // manually; the first in-app build to reach the snapshotting step
          // exposed it. snapshots/beginGetAccess is added for the same reason at
          // the capture step (gallery image version created from the disk/
          // snapshot source). NOTE: beginGetAccess grants the ability to mint a
          // read SAS over disk/snapshot CONTENT — scoped to RG-AVD-Images only,
          // where the only disks/snapshots are the throwaway build VM's.
          'Microsoft.Compute/disks/beginGetAccess/action'
          'Microsoft.Compute/snapshots/read'
          'Microsoft.Compute/snapshots/write'
          'Microsoft.Compute/snapshots/beginGetAccess/action'
          // AM-53 — operator-confirmed pre-Sysprep snapshot retention. See
          // this file's header comment for the gating/blast-radius account.
          'Microsoft.Compute/snapshots/delete'
          'Microsoft.Compute/galleries/read'
          'Microsoft.Compute/galleries/images/read'
          'Microsoft.Compute/galleries/images/versions/read'
          'Microsoft.Compute/galleries/images/versions/write'
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

resource imageBuildOperatorAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(resourceGroup().id, principalId, imageBuildOperatorRoleDefinition.id)
  properties: {
    principalId: principalId
    roleDefinitionId: imageBuildOperatorRoleDefinition.id
    principalType: 'ServicePrincipal'
  }
}

output roleDefinitionId string = imageBuildOperatorRoleDefinition.id
