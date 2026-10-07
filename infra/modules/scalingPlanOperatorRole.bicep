// AM-23 (M3-S1) — least-privilege custom role for the scaling-plan editor's
// ARM writes: schedule create/update/delete (avdService.ts's
// createScalingSchedule/updateScalingSchedule/deleteScalingSchedule) and the
// emergency-override's hostPoolReferences[].scalingPlanEnabled toggle
// (avdService.ts's setScalingPlanHostPoolEnabled).
//
// ACTION STRINGS verified against Microsoft Learn's Azure permissions
// reference for Compute (Microsoft.DesktopVirtualization) —
// https://learn.microsoft.com/azure/role-based-access-control/permissions/compute#microsoftdesktopvirtualization
// which lists (among others):
//   Microsoft.DesktopVirtualization/scalingplans/read
//   Microsoft.DesktopVirtualization/scalingplans/write
//   Microsoft.DesktopVirtualization/scalingplans/pooledSchedules/read
//   Microsoft.DesktopVirtualization/scalingplans/pooledSchedules/write
//   Microsoft.DesktopVirtualization/scalingplans/pooledSchedules/delete
// The pooledSchedules actions are confirmed as a GENUINE, separate ARM
// child-resource type (Microsoft.DesktopVirtualization/scalingPlans/
// pooledSchedules — see https://learn.microsoft.com/azure/templates/microsoft.desktopvirtualization/scalingplans/pooledschedules),
// not merely an SDK-side convenience wrapper over the parent resource — this
// app's schedule editor calls that child-resource API directly (see
// avdService.ts's updateScalingSchedule doc comment for why: a true partial
// PATCH per schedule, vs scalingPlans.update's inline schedules[] array,
// which PATCH semantics would replace wholesale).
//
// hostpools/read is DELIBERATELY NOT duplicated here: rbac.bicep's built-in
// Reader grant on RG-AVD-HostPools (main.bicep's rbacHostPools module)
// already covers `*/read` for every resource type in that RG, including
// scalingplans/read and pooledSchedules/read — this role adds only the
// WRITE (and pooledSchedules DELETE) actions Reader does not grant. The read
// actions are still listed explicitly below (not relied on implicitly via
// Reader) so this role stays self-documenting/self-contained if Reader's
// scope on that RG is ever narrowed — same defense-in-depth reasoning
// sessionHostWriterRole.bicep already applies to hostpools/read. NOTE: with
// the ASSIGNMENT below narrowed to the scaling plan resource itself (peer
// review — AM-23 MINOR 9), hostpools/read grants nothing further for THIS
// assignment specifically (a hostpools/{name} resource is outside the
// scaling plan's own resource hierarchy) — it remains in the role
// DEFINITION only so a future RG-scoped assignment of this same role
// (should one ever be needed) still carries it.
//
// SCOPE (peer review — AM-23 MINOR 9): the role DEFINITION stays
// RG-assignable (assignableScopes: resourceGroup().id, same as every other
// custom role in this repo — sessionHostWriterRole.bicep,
// vmPowerOperatorRole.bicep, etc.) but the ROLE ASSIGNMENT below is scoped
// to the SCALE-CONTOSO-PROD scaling plan resource specifically, not the whole
// resource group — this app's managed identity only ever needs to write
// schedules/hostPoolReferences on ONE scaling plan, so granting it write
// access to every current-and-future scalingPlans resource in
// RG-AVD-HostPools would be broader than necessary. RBAC scope is
// hierarchical (https://learn.microsoft.com/azure/role-based-access-control/scope-overview):
// an assignment at a parent resource's scope also covers that resource's
// CHILD resources, so scoping to the scalingPlans resource itself still
// covers the pooledSchedules child-resource writes this app performs.
targetScope = 'resourceGroup'

@description('Deployment environment (dev/test/prod) — see sessionHostWriterRole.bicep for why this must be part of both the role definition GUID and its tenant-unique display name.')
param environmentName string

@description('Principal ID (object ID) of the Function App system-assigned managed identity to assign this role to.')
param principalId string

@description('Name of the existing scaling plan this app manages — the role ASSIGNMENT is scoped to this specific resource (see this file\'s header comment), not the whole resource group. No default: pass the real scaling plan name (e.g. SCALE-CONTOSO-PROD) explicitly.')
param scalingPlanName string

resource scalingPlanOperatorRoleDefinition 'Microsoft.Authorization/roleDefinitions@2022-04-01' = {
  name: guid(subscription().id, 'AVD Manager Scaling Plan Operator', environmentName)
  properties: {
    roleName: 'AVD Manager Scaling Plan Operator (${environmentName})'
    description: 'AVD Manager (AM-23/M3-S1): read/write scaling plans and their pooled schedules, for the scaling-plan schedule editor and emergency override. No hostpools/sessionhosts/usersessions actions — narrower than any built-in Desktop Virtualization role that bundles scaling-plan access with unrelated session-host management.'
    type: 'CustomRole'
    permissions: [
      {
        actions: [
          'Microsoft.DesktopVirtualization/scalingplans/read'
          'Microsoft.DesktopVirtualization/scalingplans/write'
          'Microsoft.DesktopVirtualization/scalingplans/pooledSchedules/read'
          'Microsoft.DesktopVirtualization/scalingplans/pooledSchedules/write'
          'Microsoft.DesktopVirtualization/scalingplans/pooledSchedules/delete'
          'Microsoft.DesktopVirtualization/hostpools/read'
        ]
        notActions: []
        dataActions: []
        notDataActions: []
      }
    ]
    // Stays RG-scoped ASSIGNABILITY (not narrowed) — only the assignment
    // below is scoped down. See this file's header comment.
    assignableScopes: [
      resourceGroup().id
    ]
  }
}

// Existing resource reference — this app never creates/deletes the scaling
// plan itself (it's part of the pre-existing Contoso estate), only
// references it here so the role assignment below can target its scope.
resource existingScalingPlan 'Microsoft.DesktopVirtualization/scalingPlans@2024-04-03' existing = {
  name: scalingPlanName
}

resource scalingPlanOperatorAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(existingScalingPlan.id, principalId, scalingPlanOperatorRoleDefinition.id)
  scope: existingScalingPlan
  properties: {
    principalId: principalId
    roleDefinitionId: scalingPlanOperatorRoleDefinition.id
    principalType: 'ServicePrincipal'
  }
}

output roleDefinitionId string = scalingPlanOperatorRoleDefinition.id
