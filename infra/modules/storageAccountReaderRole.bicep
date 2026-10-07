// AM-25 (peer review item 13): grants Reader to a single EXISTING storage
// account resource, not the whole containing resource group —
// app/api/src/services/fslogixService.ts's fileShares.get(expand=stats)
// call only needs Microsoft.Storage/storageAccounts/fileServices/shares/
// read (a control-plane read action fully covered by the built-in Reader
// role — no data-plane "Storage File Data..." role needed, and no SMB/
// network path to the share either). infra/modules/rbac.bicep only
// supports RG-scoped assignments (its own targetScope + the caller-side
// `scope:` redirection pattern); this module exists specifically for the
// narrower, resource-scoped grant, mirroring the pattern
// infra/modules/functionapp.bicep already uses for this Function App's OWN
// storage account (storageBlobDataContributorAssignment/
// storageTableDataContributorAssignment) — except here the target storage
// account lives in a DIFFERENT resource group (RG-AVD-Storage) than the one
// this deployment otherwise targets (RG-AVD-Management), so it must be
// deployed as its own module with `scope: resourceGroup(<rgStorage>)` on
// the MODULE invocation (see infra/main.bicep) — a resource's scope must
// match its own file's targetScope (BCP139); only the caller redirecting a
// MODULE's scope can point it at a different resource group.
targetScope = 'resourceGroup'

@description('Principal ID (object ID) of the Function App system-assigned managed identity to grant Reader to.')
param principalId string

@description('Name of the existing storage account (within this module invocation\'s resource group scope) to grant Reader on.')
param storageAccountName string

var readerRoleDefinitionId = 'acdd72a7-3385-48ef-bd42-f606fba81ae7'

resource existingStorageAccount 'Microsoft.Storage/storageAccounts@2023-01-01' existing = {
  name: storageAccountName
}

resource readerAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(existingStorageAccount.id, principalId, readerRoleDefinitionId)
  scope: existingStorageAccount
  properties: {
    principalId: principalId
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', readerRoleDefinitionId)
    principalType: 'ServicePrincipal'
  }
}
