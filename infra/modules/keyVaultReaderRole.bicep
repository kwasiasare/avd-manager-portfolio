// AM-16 (M3b peer review item 11): grants Reader to a single EXISTING Key
// Vault resource, not the whole containing resource group (RG-AVD-Security)
// — mirrors infra/modules/storageAccountReaderRole.bicep's exact pattern
// and rationale (see that file's header comment for the full "why a
// dedicated module, not infra/modules/rbac.bicep's RG-scoped grant" case:
// a resource's scope can't be redirected by BCP139/BCP120 constraints
// except via the caller-side `scope:` on a MODULE invocation).
// app/api/src/services/governance/keyVaultPurgeProtection.ts only ever
// reads ONE resource in RG-AVD-Security (KV-AVD-CONTOSO's own
// enablePurgeProtection/enableSoftDelete/publicNetworkAccess properties —
// Microsoft.KeyVault/vaults/read, a plain control-plane Reader action) —
// an earlier version of this story granted Reader at RG-AVD-Security's
// resource-group scope instead; this narrows that to the single resource
// actually read, tightening the blast radius of what this app's managed
// identity can see if ever compromised (RG-AVD-Security could host
// additional secrets/certificates-bearing resources in the future that
// this app has no reason to read).
targetScope = 'resourceGroup'

@description('Principal ID (object ID) of the Function App system-assigned managed identity to grant Reader to.')
param principalId string

@description('Name of the existing Key Vault (within this module invocation\'s resource group scope) to grant Reader on.')
param keyVaultName string

var readerRoleDefinitionId = 'acdd72a7-3385-48ef-bd42-f606fba81ae7'

resource existingKeyVault 'Microsoft.KeyVault/vaults@2023-07-01' existing = {
  name: keyVaultName
}

resource readerAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(existingKeyVault.id, principalId, readerRoleDefinitionId)
  scope: existingKeyVault
  properties: {
    principalId: principalId
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', readerRoleDefinitionId)
    principalType: 'ServicePrincipal'
  }
}
