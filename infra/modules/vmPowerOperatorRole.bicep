// AM-19 (M2-S2) — least-privilege custom role for the session-host power
// actions endpoint's ARM writes (app/api/src/services/computeService.ts
// #beginVmPowerAction: start/action, restart/action, deallocate/action).
//
// WHY a NEW custom role rather than extending sessionHostWriterRole.bicep
// (AM-18's Microsoft.DesktopVirtualization/hostpools/sessionhosts/* role):
// these are Microsoft.COMPUTE actions against the VM resource directly, a
// different resource provider from the DesktopVirtualization actions that
// role grants — keeping them in separate role definitions means either can
// be revoked/audited independently (e.g. if the power-action feature is
// ever disabled, only this role's assignment needs removing, without
// touching the drain toggle's grant).
//
// WHY a custom role instead of a built-in one: the closest built-ins are
// "Desktop Virtualization Power On Off Contributor" (40c5ff49-9181-41f8-
// ae61-143b0e78555e) and "Desktop Virtualization Virtual Machine
// Contributor" (a959dbd1-f747-45e3-8ba6-dd80f235f97c) — confirmed via
// Microsoft Learn's built-in-roles reference
// (https://learn.microsoft.com/azure/virtual-desktop/rbac#desktop-virtualization-power-on-off-contributor
// and https://learn.microsoft.com/azure/virtual-desktop/rbac#desktop-virtualization-virtual-machine-contributor).
// Both are meant for the AVD RESOURCE PROVIDER's own service principal (not
// this app's Function App identity) and both massively over-grant relative
// to what this endpoint calls: e.g. Power On Off Contributor also includes
// Microsoft.Compute/virtualMachines/powerOff/action (stop-but-still-billed
// — not one of this app's three power actions),
// Microsoft.DesktopVirtualization/hostpools/write, and
// hostpools/sessionhosts/usersessions/delete; VM Contributor additionally
// grants virtualMachines/write and virtualMachines/delete. This module
// instead defines a role with only the four actions the power-action
// endpoint actually needs: read the VM, and start/restart/deallocate it.
//
// Action strings confirmed via Microsoft Learn's Compute permissions
// reference (https://learn.microsoft.com/azure/role-based-access-control/permissions/compute#microsoftcompute):
// Microsoft.Compute/virtualMachines/read,
// Microsoft.Compute/virtualMachines/start/action,
// Microsoft.Compute/virtualMachines/restart/action,
// Microsoft.Compute/virtualMachines/deallocate/action — all CONTROL-PLANE
// `actions` (not `dataActions`).
//
// SCOPE: the session hosts' underlying VMs live in the SAME resource group
// as the host pool itself (RG-AVD-HostPools in prod — confirmed against
// The captured estate inventory
// `resourceId`, e.g. ".../resourceGroups/RG-AVD-HostPools/providers/
// Microsoft.Compute/virtualMachines/avd-con-0", and vm-list.json's
// `resourceGroup: "RG-AVD-HostPools"` for that same VM). Deployed at
// RESOURCE GROUP scope, same pattern as sessionHostWriterRole.bicep
// (targetScope redirected by main.bicep's `scope: resourceGroup(rgHostPools)`
// module invocation).
//
// virtualMachines/read is included here even though the Function App's MI
// already has it via the plain Reader role granted on RG-AVD-HostPools
// (main.bicep's rbacHostPools module) — deliberately redundant, so this
// role definition stays SELF-SUFFICIENT (readable/reasoned-about/revocable
// on its own; removing the Reader grant someday must not silently break VM
// reads this role's own actions imply it should cover), same rationale
// sessionHostWriterRole.bicep applies to hostpools/read there.
//
// ACCEPTED RISK — deferred, not implemented here: this role's
// assignableScopes/assignment cover the WHOLE resource group, not just the
// specific session-host VMs within it (Azure custom roles don't support
// scoping to a dynamic list of resource names inside one role definition;
// that would require a per-VM role ASSIGNMENT with an individual VM
// resource id as its `scope`, generated per session host — extra
// deployment-time complexity for a resource group this app already treats
// as "the AVD host pool's own", not shared with unrelated VMs). If
// RG-AVD-HostPools ever hosts VMs unrelated to this host pool, this role
// would be able to start/restart/deallocate those too — revisit with
// per-VM-scoped role assignments if that ever becomes true.
targetScope = 'resourceGroup'

@description('Deployment environment (dev/test/prod). Both the role definition resource name (a GUID, generated below) and its display name (roleName) must be unique within the Microsoft Entra TENANT — not just this resource group — even though assignableScopes narrows where the role can be ASSIGNED (see https://learn.microsoft.com/azure/role-based-access-control/custom-roles#custom-role-properties). Parameterizing with environmentName keeps dev/test/prod deployments in this same tenant from colliding.')
param environmentName string

@description('Principal ID (object ID) of the Function App system-assigned managed identity to assign this role to.')
param principalId string

resource vmPowerOperatorRoleDefinition 'Microsoft.Authorization/roleDefinitions@2022-04-01' = {
  name: guid(subscription().id, 'AVD Manager VM Power Operator', environmentName)
  properties: {
    roleName: 'AVD Manager VM Power Operator (${environmentName})'
    description: 'AVD Manager (AM-19/M2-S2): read, start, restart, and deallocate session-host VMs only — for the host power-action endpoint. Deliberately narrower than the built-in Desktop Virtualization Power On Off Contributor / Virtual Machine Contributor roles: no powerOff/action, no virtualMachines/write, no virtualMachines/delete, no DesktopVirtualization actions.'
    type: 'CustomRole'
    permissions: [
      {
        actions: [
          'Microsoft.Compute/virtualMachines/read'
          'Microsoft.Compute/virtualMachines/start/action'
          'Microsoft.Compute/virtualMachines/restart/action'
          'Microsoft.Compute/virtualMachines/deallocate/action'
        ]
        notActions: []
        dataActions: []
        notDataActions: []
      }
    ]
    // Narrowest scope this repo's main.bicep + module `scope:` redirection
    // supports: the specific resource group the role is deployed into
    // (RG-AVD-HostPools in prod, where the session-host VMs live — see the
    // header comment), not the subscription.
    assignableScopes: [
      resourceGroup().id
    ]
  }
}

resource vmPowerOperatorAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(resourceGroup().id, principalId, vmPowerOperatorRoleDefinition.id)
  properties: {
    principalId: principalId
    roleDefinitionId: vmPowerOperatorRoleDefinition.id
    principalType: 'ServicePrincipal'
  }
}

output roleDefinitionId string = vmPowerOperatorRoleDefinition.id
