// AM-14 (M6) — Users & access management: grants the Function App's managed
// identity the built-in **User Access Administrator** role, scoped to
// EXACTLY the desktop application group (the DAG — Microsoft.
// DesktopVirtualization/applicationGroups/{dagName}), constrained by an
// Azure ABAC role-assignment CONDITION so it can only create or delete role
// ASSIGNMENTS for the built-in "Desktop Virtualization User" role
// definition. This is the ARM-layer half of AM-14's "attempting any other
// role via the API fails" acceptance criterion — the app's own API code
// (app/api/src/services/accessService.ts) never constructs a write for any
// other roleDefinitionId either (see that file's DESKTOP_VIRTUALIZATION_USER_ROLE_ID
// constant and its header comment), so this condition is defense-IN-DEPTH,
// not the only thing standing between this managed identity and a broader
// grant — even a bug in this app's own code that somehow tried to assign a
// different role (e.g. Owner) to some other principal would still be
// rejected by Azure itself, at the platform layer, before it ever took
// effect.
//
// WHY User Access Administrator (not a narrower custom role): assigning
// Azure RBAC roles requires holding `Microsoft.Authorization/
// roleAssignments/write` (to create) and `.../roleAssignments/delete` (to
// remove) — confirmed on Microsoft Learn ("Assign Azure roles using the
// REST API": "To call this API, you must have access to the
// Microsoft.Authorization/roleAssignments/write action, such as Role Based
// Access Control Administrator"). User Access Administrator
// (18d7d88d-d35e-4fb5-a5c3-7773c20a72d9 — verified on Microsoft Learn's
// "Azure built-in roles" reference) is the standard built-in role for
// exactly this "manage user access to Azure resources" purpose (see also
// Microsoft's own AVD documentation, "Add and manage App Attach
// applications"/"Deploy Azure Virtual Desktop": "To assign users to the
// application group, you also need Microsoft.Authorization/roleAssignments/
// write permissions on the application group. Built-in RBAC roles that
// include this permission are User Access Administrator and Owner"). A
// CUSTOM role cannot be defined with ONLY roleAssignments/write|delete and
// nothing else, because those two actions are themselves part of the
// Microsoft.Authorization/* action family that only Owner/Role Based Access
// Control Administrator/User Access Administrator (or a custom role
// explicitly granting them) can hold — there is no narrower built-in role
// that grants JUST role-assignment management without also granting the
// broader Microsoft.Authorization/* actions User Access Administrator
// itself carries (`*/read` plus `Microsoft.Authorization/*` — see Microsoft
// Learn's "Azure built-in roles for Privileged"). The ABAC CONDITION below
// is what narrows this from "manage authorization broadly" down to "only
// for the Desktop Virtualization User role, only on this one DAG resource"
// — role DEFINITION scope narrows WHERE the grant applies (this module's
// `scope:` — see main.bicep's invocation), the CONDITION narrows WHAT it
// can be used to do within that scope.
//
// ABAC CONDITION SYNTAX — verified against Microsoft Learn's "Examples to
// delegate Azure role assignment management with conditions" (the
// "Example: Constrain roles" example — https://learn.microsoft.com/azure/role-based-access-control/delegate-role-assignments-examples#example-constrain-roles)
// and "Authorization actions and attributes" (the Role definition ID
// attribute: `Microsoft.Authorization/roleAssignments:RoleDefinitionId`,
// attribute source Request for the WRITE action, Resource for the DELETE
// action — https://learn.microsoft.com/azure/role-based-access-control/conditions-authorization-actions-attributes#role-definition-id).
// TWO separate `ActionMatches` guards are required (not one combined
// expression) because add and remove use different attribute SOURCES —
// `@Request[...]` for `roleAssignments/write` (what the CALLER is asking to
// create) vs. `@Resource[...]` for `roleAssignments/delete` (what the
// EXISTING assignment being removed already is) — see Microsoft Learn's
// "Symptom - No options available error" troubleshooting note for why
// combining them into one expression is not supported by the condition
// language at all, not just a portal-UI limitation.
//
// `conditionVersion: '2.0'` is, per Microsoft Learn, "Currently the only
// accepted value" — confirmed against the Microsoft.Authorization/
// roleAssignments@2022-04-01 Bicep resource reference, which also confirms
// `condition`/`conditionVersion` are valid RoleAssignmentProperties at this
// exact API version (the same one this repo already pins for every other
// roleAssignments resource — see e.g. modules/vmPowerOperatorRole.bicep).
//
// PRINCIPAL TYPE CONSTRAINT (AM-14 peer review fix 10): each guard ALSO
// requires PrincipalType to be 'User' or 'Group' — verified against
// Microsoft Learn's "Example: Constrain roles and principal types" (same
// page as the "Constrain roles" example above), which pairs
// `@Request[...:PrincipalType] ForAnyOfAnyValues:StringEqualsIgnoreCase
// {'User', 'Group'}` with the WRITE guard's `@Request[...:RoleDefinitionId]`
// (same attribute source), and `@Resource[...:PrincipalType]` with the
// DELETE guard's `@Resource[...:RoleDefinitionId]` (same attribute-source
// pairing rule as the RoleDefinitionId guards themselves — see the "TWO
// separate ActionMatches guards" paragraph above). This app's own API
// already only ever sends principalType 'User'/'Group' (see
// accessService.ts#createDesktopAssignment's armPrincipalType mapping —
// PrincipalType in @avdmgr/shared has no other values), so this is
// defense-in-depth narrowing an already-narrow caller, not a constraint
// this app's own code could otherwise violate.
//
// WHAT THIS CONDITION DOES **NOT** CONSTRAIN (fix 11): the condition only
// ever gates the TWO actions it names, `Microsoft.Authorization/
// roleAssignments/write` and `.../roleAssignments/delete` — every OTHER
// action `Microsoft.Authorization/*` on the built-in User Access
// Administrator role also grants (e.g. reading/listing role ASSIGNMENTS or
// role DEFINITIONS at this scope, `Microsoft.Authorization/*/read`, etc.)
// is completely UNCONSTRAINED by this condition. The only thing bounding
// THOSE actions' blast radius is the role ASSIGNMENT's own scope (the DAG
// resource — see `scope: existingDag` below): they can reach anything
// `Microsoft.Authorization/*` covers, but only within that one DAG's scope,
// never tenant- or subscription-wide.
targetScope = 'resourceGroup'

@description('Principal ID (object ID) of the Function App system-assigned managed identity to grant this role to.')
param principalId string

@description('Name of the existing desktop application group (the DAG) — within this module invocation\'s resource group scope (RG-AVD-HostPools).')
param dagName string

// Built-in role GUIDs — verified against Microsoft Learn's "Azure built-in
// roles" reference (User Access Administrator) and "Built-in Azure RBAC
// roles for Azure Virtual Desktop" reference (Desktop Virtualization User —
// https://learn.microsoft.com/azure/virtual-desktop/rbac#desktop-virtualization-user).
// desktopVirtualizationUserRoleId MUST stay in sync with
// app/api/src/services/accessService.ts's DESKTOP_VIRTUALIZATION_USER_ROLE_ID
// constant — both independently pin the SAME role, at two different layers
// (this file's ABAC condition; that file's request-body construction) —
// see this file's header comment for why both exist rather than one
// replacing the other.
var userAccessAdministratorRoleId = '18d7d88d-d35e-4fb5-a5c3-7773c20a72d9'
var desktopVirtualizationUserRoleId = '1d18fff3-a72a-46b5-b4a9-0b38a3cd7e63'

// Existing-resource reference — no explicit `scope:` here: this module is
// invoked by main.bicep with `scope: resourceGroup(rgHostPools)` (see that
// file's wiring), so this file's own deployment scope already IS
// RG-AVD-HostPools, where the DAG lives — same no-explicit-scope convention
// storageAccountReaderRole.bicep/imageBuildNetworkRole.bicep already use for
// a resource in their own module's target resource group. API version
// 2024-04-03 matches this repo's installed @azure/arm-desktopvirtualization
// SDK's own default apiVersion (verified in
// node_modules/@azure/arm-desktopvirtualization — DesktopVirtualizationAPIClient's
// constructor default), the same version avdService.ts's ARM calls against
// this resource type are implicitly built against.
resource existingDag 'Microsoft.DesktopVirtualization/applicationGroups@2024-04-03' existing = {
  name: dagName
}

var pinnedRoleGuidSet = '{${desktopVirtualizationUserRoleId}}'
// AM-14 peer review (fix 10) — the literal set Microsoft Learn's "Constrain
// roles and principal types" example uses verbatim: {'User', 'Group'}.
var pinnedPrincipalTypeSet = '{\'User\', \'Group\'}'

var roleAssignmentCondition = '((!(ActionMatches{\'Microsoft.Authorization/roleAssignments/write\'})) OR (@Request[Microsoft.Authorization/roleAssignments:RoleDefinitionId] ForAnyOfAnyValues:GuidEquals ${pinnedRoleGuidSet} AND @Request[Microsoft.Authorization/roleAssignments:PrincipalType] ForAnyOfAnyValues:StringEqualsIgnoreCase ${pinnedPrincipalTypeSet})) AND ((!(ActionMatches{\'Microsoft.Authorization/roleAssignments/delete\'})) OR (@Resource[Microsoft.Authorization/roleAssignments:RoleDefinitionId] ForAnyOfAnyValues:GuidEquals ${pinnedRoleGuidSet} AND @Resource[Microsoft.Authorization/roleAssignments:PrincipalType] ForAnyOfAnyValues:StringEqualsIgnoreCase ${pinnedPrincipalTypeSet}))'

resource dagUserAccessAdministratorAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(existingDag.id, principalId, userAccessAdministratorRoleId, 'desktop-virtualization-user-only')
  scope: existingDag
  properties: {
    principalId: principalId
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', userAccessAdministratorRoleId)
    principalType: 'ServicePrincipal'
    description: 'AVD Manager (AM-14/M6): User Access Administrator on the DAG, ABAC-constrained to ONLY create/remove "Desktop Virtualization User" role assignments — see this module\'s header comment.'
    condition: roleAssignmentCondition
    conditionVersion: '2.0'
  }
}
