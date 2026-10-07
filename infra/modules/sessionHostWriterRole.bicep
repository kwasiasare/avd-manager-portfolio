// AM-18 (M2-S1) — least-privilege custom role for the session-host drain
// toggle's ARM write (app/api/src/services/avdService.ts#setSessionHostDrain).
//
// WHY a custom role instead of the built-in "Desktop Virtualization Session
// Host Operator" (2ad6aaab-ead9-4eaa-8ac5-da422f562408): that built-in role
// grants Microsoft.DesktopVirtualization/hostpools/sessionhosts/* — the
// wildcard includes sessionhosts/DELETE and the entire usersessions/*
// subtree (send-message, disconnect, log off), not just sessionhosts/write.
// Confirmed against Microsoft Learn's built-in-roles reference
// (https://learn.microsoft.com/azure/role-based-access-control/built-in-roles/compute#desktop-virtualization-session-host-operator)
// and the AVD RBAC doc's own prose
// (https://learn.microsoft.com/azure/virtual-desktop/rbac#desktop-virtualization-session-host-operator),
// which states plainly that the role "allows viewing and REMOVING session
// hosts, and changing drain mode" — i.e. it can do far more than this app's
// M2-S1 drain toggle needs. This module instead defines a role with only
// the three actions the drain toggle actually calls.
//
// Deployed at RESOURCE GROUP scope (this file's targetScope, redirected by
// main.bicep's `scope: resourceGroup(rgHostPools)` module invocation — same
// pattern already used by rbac.bicep for the built-in Reader/Log Analytics
// Reader grants). Confirmed via Microsoft Learn that
// Microsoft.Authorization/roleDefinitions supports resource-group-scoped
// deployment (its ARM template reference lists "Resource groups" as a valid
// target scope: https://learn.microsoft.com/azure/templates/microsoft.authorization/roledefinitions,
// and the Bicep RBAC how-to's example role-assignment pattern this repo
// already follows: https://learn.microsoft.com/azure/azure-resource-manager/bicep/scenarios-rbac#custom-role-definitions).
targetScope = 'resourceGroup'

@description('Deployment environment (dev/test/prod). BOTH the role definition resource name (a GUID, generated below) and its display name (roleName) must be unique within the Microsoft Entra TENANT — not just this resource group — even though assignableScopes narrows where the role can be ASSIGNED (see https://learn.microsoft.com/azure/role-based-access-control/custom-roles#custom-role-properties and https://learn.microsoft.com/azure/azure-resource-manager/bicep/scenarios-rbac#custom-role-definitions). Parameterizing with environmentName keeps dev/test/prod deployments in this same tenant from colliding.')
param environmentName string

@description('Principal ID (object ID) of the Function App system-assigned managed identity to assign this role to.')
param principalId string

resource sessionHostWriterRoleDefinition 'Microsoft.Authorization/roleDefinitions@2022-04-01' = {
  name: guid(subscription().id, 'AVD Manager Session Host Writer', environmentName)
  properties: {
    roleName: 'AVD Manager Session Host Writer (${environmentName})'
    description: 'AVD Manager (AM-18/M2-S1): read host pools, read/write session hosts only — for the session-host drain toggle. Deliberately narrower than the built-in Desktop Virtualization Session Host Operator role: no sessionhosts/delete, no usersessions/*.'
    type: 'CustomRole'
    permissions: [
      {
        actions: [
          'Microsoft.DesktopVirtualization/hostpools/read'
          'Microsoft.DesktopVirtualization/hostpools/sessionhosts/read'
          'Microsoft.DesktopVirtualization/hostpools/sessionhosts/write'
        ]
        notActions: []
        dataActions: []
        notDataActions: []
      }
    ]
    // Narrowest scope this repo's main.bicep + module `scope:` redirection
    // supports: the specific resource group the role is deployed into
    // (RG-AVD-HostPools in prod), not the subscription.
    assignableScopes: [
      resourceGroup().id
    ]
  }
}

resource sessionHostWriterAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(resourceGroup().id, principalId, sessionHostWriterRoleDefinition.id)
  properties: {
    principalId: principalId
    roleDefinitionId: sessionHostWriterRoleDefinition.id
    principalType: 'ServicePrincipal'
  }
}

output roleDefinitionId string = sessionHostWriterRoleDefinition.id
