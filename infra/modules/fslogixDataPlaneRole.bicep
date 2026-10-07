// AM-13 (M5): grants "Storage File Data Privileged Contributor" — a
// BUILT-IN Azure RBAC role, GUID 69566ab7-960f-475b-8e7c-b3118f30c6bd,
// verified against Microsoft Learn's built-in-roles reference
// (learn.microsoft.com/azure/role-based-access-control/built-in-roles/storage#storage-file-data-privileged-contributor)
// — to a single EXISTING storage account resource (stcontoso001), not the
// whole containing resource group. Mirrors keyVaultReaderRole.bicep's exact
// resource-scoped assignment pattern (see that file's header comment for
// the full "why a dedicated module, not infra/modules/rbac.bicep's RG-scoped
// grant" rationale — the same BCP139/BCP120 constraints apply here).
//
// WHY THIS ROLE SPECIFICALLY (not the storageAccountReaderRole.bicep plain
// Reader this app already holds on the same account, and not one of the
// "Storage File Data SMB Share ..." roles the runbooks
// §4 documents AVD-Users/AVD-Platform-Admins holding): this
// app's Function App managed identity is not, and must never become, a
// member of AVD-Users or hold any NTFS ACL entry on an individual profile
// container — it authenticates as its own distinct identity. "Privileged"
// Contributor is the ONE Azure Files data-plane role that lets an
// OAuth-authenticated caller bypass per-file/directory NTFS ACLs entirely
// via the `x-ms-file-request-intent: backup` header
// (learn.microsoft.com/azure/storage/files/authorize-oauth-rest#privileged-access-and-access-permissions-for-data-operations)
// — every OTHER data-plane role, including the SMB Share roles, is scoped
// by the share's own NTFS permission model, which this app's identity has
// no entries in. See app/api/src/lib/fslogixFileRestClient.ts's header
// comment for the fuller "why OAuth FileREST works despite
// allowSharedKeyAccess: false" design writeup this role assignment is part
// of.
//
// Read/write/delete/rename on file data specifically (fileshares/files/*,
// writeFileBackupSemantics/action) — this role does NOT grant blob data
// access, queue/table access, or any control-plane (ARM) permission; the
// plain Reader grant this app already holds on the same account
// (storageAccountReaderRole.bicep, invoked separately in main.bicep) covers
// the pre-existing control-plane share-stats read.
targetScope = 'resourceGroup'

@description('Principal ID (object ID) of the Function App system-assigned managed identity to grant Storage File Data Privileged Contributor to.')
param principalId string

@description('Name of the existing storage account (within this module invocation\'s resource group scope) to grant the role on.')
param storageAccountName string

var storageFileDataPrivilegedContributorRoleDefinitionId = '69566ab7-960f-475b-8e7c-b3118f30c6bd'

resource existingStorageAccount 'Microsoft.Storage/storageAccounts@2023-01-01' existing = {
  name: storageAccountName
}

resource fslogixDataPlaneAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(existingStorageAccount.id, principalId, storageFileDataPrivilegedContributorRoleDefinitionId)
  scope: existingStorageAccount
  properties: {
    principalId: principalId
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', storageFileDataPrivilegedContributorRoleDefinitionId)
    principalType: 'ServicePrincipal'
  }
}
