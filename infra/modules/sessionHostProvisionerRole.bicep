// AM-50 — least-privilege custom role for the guided session-host
// provisioning wizard's Microsoft.Compute writes: create the session-host
// VM and apply its three extensions (AADLoginForWindows, GuestAttestation,
// Microsoft.PowerShell.DSC — see app/api/src/lib/sessionHostProvisionPlan.ts)
// in RG-AVD-HostPools, the SAME resource group the estate's real session
// host VMs already live in (the session-host runbook §1).
//
// WHY WRITE ACCESS IS ACCEPTED (unlike, say, rolloutOperatorRole.bicep's
// narrowly-scoped delete-only grant): this role can create a NEW,
// arbitrarily-named VM anywhere in RG-AVD-HostPools. That is real,
// standing blast radius — but it is:
//   (a) reachable ONLY via an admin-only route
//       (app/api/src/functions/sessionHostProvisions.ts's
//       requireMinimumRole('admin')) — the same bar this app already
//       applies to the golden-image build orchestrator
//       (imageBuildOperatorRole.bicep) and the registration-token
//       generator (hostPoolRegistrationRole.bicep);
//   (b) BOUNDED by the state machine — every VM/extension write this role
//       backs happens as one step in a fixed, six-step plan
//       (sessionHostProvisionStateMachine.ts), never an open-ended
//       "do anything to any VM" capability; and
//   (c) fully AUDITED — every create/advance/cancel is written to the
//       audit log (sessionhost.provision.* — see
//       app/api/src/lib/auditActionFamilies.test.ts) with the operator's
//       identity and the exact plan parameters.
//
// WHY NO DELETE ACTIONS (mirrors rolloutOperatorRole.bicep's own "no
// deallocate" exclusion rationale, applied here to VM/NIC delete instead):
// a failed or cancelled provision is DELIBERATELY left in place for the
// operator to inspect and clean up manually — see
// app/api/src/lib/sessionHostProvisionPlan.ts#describeCleanupGuidance and
// this story's "no cancel-triggered deletes" architecture decision. Adding
// delete actions here would let this role ALSO tear down an unrelated,
// perfectly healthy session host VM in the same resource group — a
// materially different (and unjustified) capability from "create one new
// host and apply its extensions." An operator who needs to delete a
// session host VM already has that capability via the EXISTING AM-28
// rollout-removal flow (rolloutOperatorRole.bicep) — this role does not
// need to duplicate it.
//
// guid()/assignableScopes idiom copied from rolloutOperatorRole.bicep — see
// that file's own param doc comment for why environmentName is threaded
// into both the role definition's resource name and its display name
// (tenant-wide uniqueness for custom role names, even though
// assignableScopes narrows where the role can be ASSIGNED).
//
// Action strings confirmed against this repo's installed
// @azure/arm-compute@25 .d.ts (VirtualMachinesOperations.createOrUpdate/get,
// VirtualMachineExtensionsOperations.createOrUpdate/get) and Microsoft
// Learn's Compute permissions reference
// (https://learn.microsoft.com/azure/role-based-access-control/permissions/compute#microsoftcompute).
targetScope = 'resourceGroup'

@description('Deployment environment (dev/test/prod) — see rolloutOperatorRole.bicep\'s own param doc comment for why this is threaded into the role definition\'s name.')
param environmentName string

@description('Principal ID (object ID) of the Function App system-assigned managed identity to assign this role to.')
param principalId string

resource sessionHostProvisionerRoleDefinition 'Microsoft.Authorization/roleDefinitions@2022-04-01' = {
  name: guid(subscription().id, 'AVD Manager Session Host Provisioner', environmentName)
  properties: {
    roleName: 'AVD Manager Session Host Provisioner (${environmentName})'
    description: 'AVD Manager (AM-50): create a session-host VM and apply its AADLoginForWindows/GuestAttestation/Microsoft.PowerShell.DSC extensions in RG-AVD-HostPools, for the guided provisioning wizard ONLY. Admin-only route, state-machine bounded, fully audited. No delete actions — a failed/cancelled provision is left in place for manual cleanup by design; see this file\'s header comment.'
    type: 'CustomRole'
    permissions: [
      {
        actions: [
          'Microsoft.Compute/virtualMachines/read'
          'Microsoft.Compute/virtualMachines/write'
          'Microsoft.Compute/virtualMachines/extensions/read'
          'Microsoft.Compute/virtualMachines/extensions/write'
          'Microsoft.Network/networkInterfaces/read'
          'Microsoft.Network/networkInterfaces/write'
          'Microsoft.Network/networkInterfaces/join/action'
          'Microsoft.Compute/disks/read'
        ]
        notActions: []
        dataActions: []
        notDataActions: []
      }
    ]
    // Narrowest scope this repo's main.bicep + module `scope:` redirection
    // supports — RG-AVD-HostPools in prod, where session-host VMs live. Same
    // accepted whole-resource-group residual risk vmPowerOperatorRole.bicep/
    // rolloutOperatorRole.bicep already document for this same resource group.
    assignableScopes: [
      resourceGroup().id
    ]
  }
}

resource sessionHostProvisionerAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(resourceGroup().id, principalId, sessionHostProvisionerRoleDefinition.id)
  properties: {
    principalId: principalId
    roleDefinitionId: sessionHostProvisionerRoleDefinition.id
    principalType: 'ServicePrincipal'
  }
}

output roleDefinitionId string = sessionHostProvisionerRoleDefinition.id
