// AM-27 (M4-S2) — tiny helper module: assigns an ALREADY-DEFINED custom
// role (a full role-definition resource ID, not a bare built-in GUID — see
// rbac.bicep for that simpler case) to principalId at THIS module
// invocation's resource-group scope.
//
// WHY THIS EXISTS SEPARATELY: imageBuildNetworkRole.bicep needs a second
// role assignment (the networkInterfaces/* half of its role) at
// RG-AVD-IMAGES scope, a DIFFERENT resource group than the one it deploys
// its role DEFINITION into (RG-AVD-Network, so the subnet-scoped assignment
// can use a plain `existing` resource reference — see that file's header
// comment). A `resource` declaration's own `scope:` must match this file's
// targetScope (BCP139) for anything other than an `existing` reference to a
// specific resource; assigning at a WHOLE different resource group's scope
// requires the caller-side module `scope:` redirection this file provides —
// the same reason every *RG-scoped* cross-resource-group grant elsewhere in
// this repo (rbac.bicep, sessionHostWriterRole.bicep, etc.) is its own
// module rather than an inline resource.
targetScope = 'resourceGroup'

@description('Principal ID (object ID) of the Function App system-assigned managed identity to assign the role to.')
param principalId string

@description('Full ARM resource ID of the (already-deployed, elsewhere) custom role definition to assign.')
param roleDefinitionId string

resource roleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(resourceGroup().id, principalId, roleDefinitionId)
  properties: {
    principalId: principalId
    roleDefinitionId: roleDefinitionId
    principalType: 'ServicePrincipal'
  }
}
