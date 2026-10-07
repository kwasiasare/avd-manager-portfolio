// Resource-scoped RBAC module — grants a role at a SPECIFIC Log Analytics
// workspace RESOURCE, not the whole resource group it lives in (contrast
// with rbac.bicep, whose assignments are always resource-group-scoped).
//
// Added for AM-24 peer review MAJOR 3b: Log Analytics Reader was narrowed
// from RG-AVD-Monitoring (resource-group) scope down to just the
// LAW-CONTOSO-PROD workspace resource — an RG-scope grant would let a query
// reach every workspace ever deployed into that resource group, not just
// this one (verified on Microsoft Learn: a resource-scoped role assignment
// gives "access to only the specified workspace", vs. a resource-group
// scope giving "access to all workspaces in the resource group",
// https://learn.microsoft.com/azure/azure-monitor/logs/manage-access#azure-rbac).
// See infra/main.bicep's rbacLogAnalyticsReaderOnWorkspace module invocation
// for the honest account of what this narrowing does and doesn't isolate,
// and app/api/src/lib/logsGuard.ts's SECURITY POSTURE comment for the full
// reasoning.
//
// Why a separate module from rbac.bicep, and why a module at all rather
// than a plain `resource` declared inline in main.bicep: a role
// assignment's `name` (the deterministic `guid(...)` expression) must be
// calculable "at the start of deployment" (BCP120) — it cannot depend on
// ANOTHER resource's runtime OUTPUT, which functionApp.outputs.principalId
// is (functionApp is itself a module). Passing principalId in as a plain
// MODULE PARAMETER (as below) sidesteps that: from this module's own
// perspective it's just an incoming string, exactly like rbac.bicep's
// existing `principalId` param. Separately, this resource lives in
// RG-AVD-Monitoring while main.bicep's own deployment scope is
// RG-AVD-Management — a resource's `scope:` must match its own FILE's
// targetScope (BCP139), so the cross-RG redirection has to happen at the
// MODULE-invocation boundary (`scope: resourceGroup(...)` on the module
// call in main.bicep), the same mechanism every other rbac*.bicep module
// invocation in this app already relies on for cross-RG grants.
targetScope = 'resourceGroup'

@description('Name of the existing Log Analytics workspace to grant the role on (resource-scoped — this module must be invoked with `scope: resourceGroup(<the workspace\'s own RG>)`).')
param workspaceName string

@description('Principal ID (object ID) of the identity to grant the role to.')
param principalId string

@description('Built-in role definition GUID (bare GUID, not a full resource ID) to grant, scoped to just this workspace resource.')
param roleDefinitionId string

resource existingWorkspace 'Microsoft.OperationalInsights/workspaces@2022-10-01' existing = {
  name: workspaceName
}

resource roleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(existingWorkspace.id, principalId, roleDefinitionId)
  scope: existingWorkspace
  properties: {
    principalId: principalId
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roleDefinitionId)
    principalType: 'ServicePrincipal'
  }
}
