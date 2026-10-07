// AM-50 — least-privilege custom role for the guided session-host
// provisioning wizard's Microsoft.Network ARM writes: creating (and never
// deleting — see this file's "no delete" note below) the new session
// host's network interface, which lives in RG-AVD-HostPools alongside the
// VM itself (see sessionHostProvisionerRole.bicep's header comment for why
// that resource group), joined to the EXISTING SNET-SESSIONHOSTS subnet in
// RG-AVD-Network (the same subnet every real session host on this estate
// already uses — the session-host runbook §1 — so, unlike
// imageBuildNetworkRole.bicep's dedicated build subnet, there is no
// "does this subnet even exist yet" bootstrapping concern here).
//
// ONE ROLE DEFINITION, TWO ROLE ASSIGNMENTS, DIFFERENT SCOPES — mirrors
// imageBuildNetworkRole.bicep's exact shape and rationale (see that file's
// header comment for the full "why a custom role's assignableScopes can
// list more than one resource group, and why this must be one module with
// two assignments rather than two separately-deployed role definitions"
// account, which applies here unchanged):
//   1. Scoped to the SPECIFIC SNET-SESSIONHOSTS subnet resource in
//      RG-AVD-Network — grants ONLY subnets/read + subnets/join/action on
//      that one subnet; every other subnet in VNET-CONTOSO-PROD (including
//      SNET-MANAGEMENT and the image-build subnet) is untouched.
//   2. Scoped to the WHOLE RG-AVD-HostPools resource group — because each
//      new session host's NIC has a NEW, PER-PROVISION name
//      (`NIC-{sessionHostName}` — see
//      app/api/src/lib/sessionHostProvisionPlan.ts#deriveProvisionResourceNames)
//      that does not exist at role-authoring time, so it cannot be scoped
//      any narrower than the resource group a custom role assignment can
//      target — same accepted-risk posture sessionHostProvisionerRole.bicep
//      already documents for its own RG-AVD-HostPools-scoped Compute
//      actions (indeed, this is the SAME resource group, so this role adds
//      no NEW blast-radius surface beyond what that role already covers —
//      it exists as a separate role purely because Network and Compute
//      RBAC actions are conventionally kept in separate custom role
//      definitions across this whole repo, e.g.
//      imageBuildOperatorRole.bicep vs. imageBuildNetworkRole.bicep).
//
// NO networkInterfaces/delete — unlike imageBuildNetworkRole.bicep (whose
// build NICs are throwaway scaffolding this app deletes itself once a build
// captures), a session host's NIC is a PERMANENT resource for as long as
// the host exists; this app never deletes a session host's NIC (a
// cancelled/failed provision leaves it in place for manual cleanup — see
// sessionHostProvisionerRole.bicep's header comment for the same
// no-delete-by-design rationale applied to the VM side).
//
// Action strings confirmed against the same Microsoft Learn sources
// imageBuildNetworkRole.bicep cites (Networking permissions reference +
// the built-in Desktop Virtualization Virtual Machine Contributor role's
// own networkInterfaces/subnets action list).
targetScope = 'resourceGroup'

@description('Deployment environment (dev/test/prod).')
param environmentName string

@description('Principal ID (object ID) of the Function App system-assigned managed identity to assign this role to.')
param principalId string

@description('Resource group containing the existing SNET-SESSIONHOSTS subnet (RG-AVD-Network).')
param rgNetworkName string

@description('Resource group where the session host\'s NIC is created (RG-AVD-HostPools) — the second, resource-group-scoped assignment target.')
param rgHostPoolsName string

@description('Name of the existing VNet containing SNET-SESSIONHOSTS.')
param vnetName string

@description('Name of the existing SNET-SESSIONHOSTS subnet every session host\'s NIC joins.')
param subnetName string

// Same BCP052 workaround imageBuildNetworkRole.bicep documents: this Bicep
// CLI version's `resourceGroup(name)` has no `.id` property, so an
// arbitrary resource group's id is built via string interpolation instead.
var networkRgId = '${subscription().id}/resourceGroups/${rgNetworkName}'
var hostPoolsRgId = '${subscription().id}/resourceGroups/${rgHostPoolsName}'

resource sessionHostSubnetRoleDefinition 'Microsoft.Authorization/roleDefinitions@2022-04-01' = {
  name: guid(subscription().id, 'AVD Manager Session Host Network', environmentName)
  properties: {
    roleName: 'AVD Manager Session Host Network (${environmentName})'
    description: 'AVD Manager (AM-50): create the guided provisioning wizard\'s new session-host network interface (RG-AVD-HostPools) and join it to the existing SNET-SESSIONHOSTS subnet (RG-AVD-Network) only. No delete, no NSG/route-table, or other-subnet actions.'
    type: 'CustomRole'
    permissions: [
      {
        actions: [
          'Microsoft.Network/networkInterfaces/read'
          'Microsoft.Network/networkInterfaces/write'
          'Microsoft.Network/networkInterfaces/join/action'
          'Microsoft.Network/virtualNetworks/subnets/read'
          'Microsoft.Network/virtualNetworks/subnets/join/action'
        ]
        notActions: []
        dataActions: []
        notDataActions: []
      }
    ]
    assignableScopes: [
      networkRgId
      hostPoolsRgId
    ]
  }
}

// Existing-resource reference — NO explicit `scope:` here: this module is
// invoked by main.bicep with `scope: resourceGroup(rgNetworkName)`, so this
// file's own deployment scope already IS RG-AVD-Network — same
// no-explicit-scope convention imageBuildNetworkRole.bicep already uses.
resource existingSubnet 'Microsoft.Network/virtualNetworks/subnets@2023-09-01' existing = {
  name: '${vnetName}/${subnetName}'
}

resource sessionHostSubnetAssignmentOnSubnet 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(existingSubnet.id, principalId, sessionHostSubnetRoleDefinition.id)
  scope: existingSubnet
  properties: {
    principalId: principalId
    roleDefinitionId: sessionHostSubnetRoleDefinition.id
    principalType: 'ServicePrincipal'
  }
}

// Assignment #2 — the whole RG-AVD-HostPools resource group, for the
// networkInterfaces/* actions (see this file's header comment for why this
// one cannot be scoped any narrower). Reuses the EXISTING generic
// imageBuildNetworkRoleAssignment.bicep helper (see that file's own header
// comment — it assigns an already-defined custom role at the invoking
// module's resource-group scope) rather than a second bespoke module, since
// its logic is identical regardless of which role/resource group it's
// assigning.
module sessionHostSubnetAssignmentOnHostPoolsRg 'imageBuildNetworkRoleAssignment.bicep' = {
  name: 'sessionHostSubnetAssignmentOnHostPoolsRgDeploy'
  scope: resourceGroup(rgHostPoolsName)
  params: {
    principalId: principalId
    roleDefinitionId: sessionHostSubnetRoleDefinition.id
  }
}

output roleDefinitionId string = sessionHostSubnetRoleDefinition.id
