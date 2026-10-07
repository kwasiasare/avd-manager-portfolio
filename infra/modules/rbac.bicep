// RBAC module (AM-9 / M1, extended AM-25) — grants built-in roles to the
// Function App managed identity at this module scope.
//
// Deployed by main.bicep with an explicit `scope: resourceGroup(<rgName>)`
// on the MODULE invocation (never from within this file) — Bicep requires a
// resource scope to match its own file targetScope (BCP139); a module can
// only be redirected to a different resource group by the *caller* setting
// `scope:` on the module reference itself. As of AM-25, main.bicep invokes
// this module for SIX resource groups — RG-AVD-HostPools, RG-AVD-Images,
// RG-AVD-Monitoring (Reader, some also Log Analytics Reader/Cost Management
// Reader), plus RG-AVD-Management, RG-AVD-Network, RG-AVD-Storage
// (Cost Management Reader only — see main.bicep for the concrete
// role/scope matrix). main.bicep ALSO grants roles this module does NOT
// handle: several custom role DEFINITIONS for M2 mutation endpoints
// (modules/sessionHostWriterRole.bicep, hostPoolRegistrationRole.bicep,
// vmPowerOperatorRole.bicep, sessionUserSessionOperatorRole.bicep — each
// its own module, not this generic one, since they define bespoke
// least-privilege roles rather than assigning existing built-in ones), and
// a resource-scoped (not RG-scoped) Reader assignment directly on the
// FSLogix storage account (rbacFslogixStorageAccountReader in main.bicep) —
// this module only supports RG-scoped assignments, so a single-resource
// grant is declared as a plain `Microsoft.Authorization/roleAssignments`
// resource in main.bicep instead of going through this module.
//
// Single principal (not production + staging-slot): the Function App moved
// to a Flex Consumption plan (see infra/modules/functionapp.bicep), which
// has no deployment-slot concept at all — there is only ever one managed
// identity to grant roles to now. (An earlier version of this module
// accepted two principals for exactly that production/staging split; that
// distinction no longer exists.)
//
// Least-privilege by design: no role in this file is ever granted at
// subscription scope. Control-plane Reader (RG-AVD-HostPools/Images/
// Monitoring, plus the FSLogix storage account resource specifically — see
// above) stays scoped to exactly the resource groups/resources this app
// actually reads ARM data from. AM-16 (M3b) widened this: the governance
// panel now also holds plain Reader on RG-AVD-Management/Network/Storage
// (added to their existing Cost Management Reader-only grants). RG-AVD-
// Security is no longer excluded either — but its grant is NOT via this
// generic RG-scoped module: it's a single-RESOURCE Reader grant on
// KV-AVD-CONTOSO specifically (modules/keyVaultReaderRole.bicep, mirroring
// storageAccountReaderRole.bicep's pattern below — peer review item 11),
// narrower than what this module can express, since the governance panel's
// Key Vault check reads exactly one resource in that RG. Cost Management
// Reader (AM-25) is
// necessarily broader — six RG-AVD-* resource groups, including Management/
// Network/Storage where this app reads no OTHER ARM data — because Cost
// Management's Query API has no scope narrower than resourceGroup to grant
// it at (verified against Microsoft's "Understand and work with scopes"
// page: subscription/resourceGroup/billing-account/management-group are
// the only options, no per-resource scope).
//
// Log Analytics Reader is deliberately NOT one of the roles this module
// grants at RG-AVD-Monitoring (RG) scope — this module only ever hands
// RG-AVD-Monitoring plain Reader (+ Cost Management Reader) here. LAW
// *data-plane* query rights (Microsoft.OperationalInsights/workspaces/*/
// read actions, which plain Reader does NOT include) are granted SEPARATELY
// via a different module, infra/modules/logAnalyticsWorkspaceRbac.bicep
// (invoked from main.bicep as rbacLogAnalyticsReaderOnWorkspace), scoped to
// the LAW-CONTOSO-PROD workspace RESOURCE itself rather than the whole resource
// group — narrower than what THIS module's per-RG pattern can express.
// Consumed by both app/api/src/services/hostRuntimeService.ts (AM-25) and
// app/api/src/services/logsService.ts (AM-24, curated-views and raw-KQL).
// See that module's header comment and app/api/src/lib/logsGuard.ts's
// SECURITY POSTURE comment for the full reasoning, including an honest
// account of what that narrower scope does and doesn't isolate (verified on
// Microsoft Learn:
// https://learn.microsoft.com/azure/role-based-access-control/built-in-roles/monitor#log-analytics-reader,
// https://learn.microsoft.com/azure/azure-monitor/logs/manage-access).
targetScope = 'resourceGroup'

@description('Principal ID (object ID) of the Function App system-assigned managed identity to grant roles to.')
param principalId string

@description('Built-in role definition GUIDs (bare GUID, not a full resource ID) to grant to principalId, at the scope this module invocation targets.')
param roleDefinitionIds array

resource roleAssignments 'Microsoft.Authorization/roleAssignments@2022-04-01' = [
  for roleDefinitionId in roleDefinitionIds: {
    name: guid(resourceGroup().id, principalId, roleDefinitionId)
    properties: {
      principalId: principalId
      roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roleDefinitionId)
      principalType: 'ServicePrincipal'
    }
  }
]
