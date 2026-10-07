// AM-20 (M2-S3) — least-privilege custom role for user-session operations:
// force logoff, send message, logoff-all-disconnected, broadcast
// (app/api/src/services/avdService.ts#forceLogoffSession / #sendSessionMessage).
//
// WHY a role SIBLING to sessionHostWriterRole.bicep's "AVD Manager Session
// Host Writer" (AM-18), not an extension of it: that role's own header
// comment and roleName/description explicitly claim "no usersessions/*" —
// bundling M2-S3's usersessions actions into it would silently invalidate
// that claim and couple two independently-revocable capabilities (drain
// toggle vs. session operations) into one role assignment. A sibling role
// keeps both roles' grants legible from their own file and independently
// revocable.
//
// WHY not the built-in "Desktop Virtualization User Session Operator"
// (ea4bfff8-7fb4-485a-aadd-d4129a0ffaa6): confirmed via Microsoft Learn
// (https://learn.microsoft.com/azure/virtual-desktop/rbac#desktop-virtualization-user-session-operator)
// that its actions grant the FULL
// `Microsoft.DesktopVirtualization/hostpools/sessionhosts/usersessions/*`
// wildcard — which includes usersessions/disconnect/action, an operation
// this app's M2-S3 endpoints never call (force logoff always uses
// userSessions.delete with force:true, not disconnect). This module grants
// only the three usersessions actions M2-S3 actually needs, confirmed
// against the same Microsoft Learn RBAC reference page, where they also
// appear verbatim in the built-in "Desktop Virtualization Power On Off
// Contributor" and "Desktop Virtualization Virtual Machine Contributor"
// roles' action lists:
//   - Microsoft.DesktopVirtualization/hostpools/sessionhosts/usersessions/read
//   - Microsoft.DesktopVirtualization/hostpools/sessionhosts/usersessions/delete
//   - Microsoft.DesktopVirtualization/hostpools/sessionhosts/usersessions/sendMessage/action
//
// The ROLE DEFINITION is deployed at RESOURCE GROUP scope (assignableScopes
// below), same pattern as sessionHostWriterRole.bicep (this file's
// targetScope, redirected by main.bicep's `scope: resourceGroup(rgHostPools)`
// module invocation) — a custom role's assignableScopes must be a
// management group, subscription, or resource group (confirmed via
// Microsoft Learn: https://learn.microsoft.com/azure/role-based-access-control/role-definitions#assignablescopes).
//
// The ROLE ASSIGNMENT itself, however, is scoped NARROWER still — to the
// specific host pool resource (see the `hostPool` existing-resource
// reference and the assignment's `scope:` below), not the whole resource
// group. Per that same Microsoft Learn page: "AssignableScopes is set to
// [a resource group, that] means the custom role is available for
// assignment at resource group scope ... or resource scope for ANY
// RESOURCE in the [resource group]" — and its own guidance is explicit:
// "create your custom roles with AssignableScopes of ... resource group,
// but ASSIGN the custom roles with narrow scope, such as resource or
// resource group." Scoping the assignment to the host pool resource means
// ARM itself — not just this app's in-process validateManagedHostPool
// string check (app/api/src/lib/hostPoolScope.ts) — bounds the managed
// identity's blast radius to this one host pool, even if RG-AVD-HostPools
// ever holds more than one.
targetScope = 'resourceGroup'

@description('Deployment environment (dev/test/prod). BOTH the role definition resource name (a GUID, generated below) and its display name (roleName) must be unique within the Microsoft Entra TENANT — not just this resource group — even though assignableScopes narrows where the role can be ASSIGNED (see https://learn.microsoft.com/azure/role-based-access-control/custom-roles#custom-role-properties and https://learn.microsoft.com/azure/azure-resource-manager/bicep/scenarios-rbac#custom-role-definitions). Parameterizing with environmentName keeps dev/test/prod deployments in this same tenant from colliding.')
param environmentName string

@description('Principal ID (object ID) of the Function App system-assigned managed identity to assign this role to.')
param principalId string

@description('Name of the AVD host pool (already deployed outside this Bicep — see app/api/src/lib/config.ts\'s HOSTPOOL_NAME) that the role ASSIGNMENT is scoped to, narrower than this module\'s resource-group-scoped assignableScopes.')
param hostPoolName string

// `existing` reference, not a new deployment — the host pool is a
// pre-existing AVD resource this app only ever reads/mutates via the SDK,
// never provisions. Confirmed 'Microsoft.DesktopVirtualization/hostPools@2024-04-03'
// is a valid, non-preview, resource-group-deployable API version via
// Microsoft Learn (https://learn.microsoft.com/azure/templates/microsoft.desktopvirtualization/2024-04-03/hostpools).
resource hostPool 'Microsoft.DesktopVirtualization/hostPools@2024-04-03' existing = {
  name: hostPoolName
}

resource sessionUserSessionOperatorRoleDefinition 'Microsoft.Authorization/roleDefinitions@2022-04-01' = {
  name: guid(subscription().id, 'AVD Manager Session Operator', environmentName)
  properties: {
    roleName: 'AVD Manager Session Operator (${environmentName})'
    description: 'AVD Manager (AM-20/M2-S3): read host pools/session hosts, plus read/delete/send-message on user sessions only — for force logoff, send message, logoff-all-disconnected, and broadcast. Deliberately narrower than the built-in Desktop Virtualization User Session Operator role: no usersessions/disconnect/action.'
    type: 'CustomRole'
    permissions: [
      {
        actions: [
          'Microsoft.DesktopVirtualization/hostpools/read'
          'Microsoft.DesktopVirtualization/hostpools/sessionhosts/read'
          'Microsoft.DesktopVirtualization/hostpools/sessionhosts/usersessions/read'
          'Microsoft.DesktopVirtualization/hostpools/sessionhosts/usersessions/delete'
          'Microsoft.DesktopVirtualization/hostpools/sessionhosts/usersessions/sendMessage/action'
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

// Scoped to the host pool RESOURCE (via the `scope:` property below), not
// the resource group — see this file's header comment for the Microsoft
// Learn confirmation that a resource-group-assignableScopes custom role can
// still be ASSIGNED at an individual resource's scope, and why that's the
// recommended, narrower choice.
resource sessionUserSessionOperatorAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(hostPool.id, principalId, sessionUserSessionOperatorRoleDefinition.id)
  scope: hostPool
  properties: {
    principalId: principalId
    roleDefinitionId: sessionUserSessionOperatorRoleDefinition.id
    principalType: 'ServicePrincipal'
  }
}

output roleDefinitionId string = sessionUserSessionOperatorRoleDefinition.id
