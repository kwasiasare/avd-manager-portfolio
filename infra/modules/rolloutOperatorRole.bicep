// AM-28 (M4-S3) — least-privilege custom role for the staged rollout's
// host-REMOVAL step (app/api/src/functions/rolloutPlans.ts's remove-hosts
// handler: avdService.ts#removeSessionHost + computeService.ts#beginVmDelete).
//
// AM-28 PEER REVIEW ITEM 3 — NO DEALLOCATE: an earlier version of the
// remove-hosts handler deallocated each VM (via computeService.ts's shared
// beginVmPowerAction) before deleting it, and this role originally granted
// Microsoft.Compute/virtualMachines/deallocate/action for that step. That
// step and this action were BOTH removed: VM deletion does not require the
// VM to be deallocated first (Azure deletes a running or deallocated VM
// identically), the zero-sessions hard gate is what actually makes removal
// safe (not the power state), and a submitted-but-not-yet-complete
// deallocate LRO racing an immediately-following delete call risked an ARM
// "conflicting operation" error for no safety benefit — see
// computeService.ts#beginVmDelete's doc comment and rolloutPlans.ts's
// handleRemoveHosts doc comment for the full decision record. (An operator
// who wants to deallocate a session host's VM independently already has
// that capability via the EXISTING M2 power-action endpoint/
// vmPowerOperatorRole.bicep grant — this role does not need to duplicate it.)
//
// WHY A THIRD, SEPARATE ROLE (not an extension of sessionHostWriterRole.bicep
// or vmPowerOperatorRole.bicep): this role grants the ONE action each of
// those two modules' own header comments explicitly calls out as
// DELIBERATELY EXCLUDED —
//   - sessionHostWriterRole.bicep (AM-18): "no sessionhosts/delete" — that
//     role is scoped to the drain toggle (hostpools/sessionhosts/write)
//     only.
//   - vmPowerOperatorRole.bicep (AM-19): "no virtualMachines/write, no
//     virtualMachines/delete" — that role is scoped to
//     start/restart/deallocate only.
// Both exclusions were the RIGHT call at the time: M2's drain toggle and
// power-action endpoints never delete anything, so granting delete alongside
// them would have been unused, unjustifiable blast radius. AM-28's
// host-removal step is the FIRST feature in this app that actually needs to
// delete a session host's registration and its underlying VM — so it gets
// its own role with exactly those two additional actions, keeping the two
// earlier roles' "no delete" guarantee intact and independently revocable
// (this role's assignment can be removed on its own — e.g. to disable
// staged rollouts entirely — without touching the drain/power grants every
// other M2 feature still depends on).
//
// BLAST RADIUS (read before assigning this role anywhere else): a principal
// holding this role can PERMANENTLY delete any session host's AVD
// registration and its underlying VM within the scoped resource group
// (RG-AVD-HostPools in prod). This is real, standing delete capability, not
// a soft/reversible action — see
// The session-host lifecycle runbook §5.4 ("VM/NIC/disk
// deletion is not reversible"). It is deliberately narrower than that
// runbook's own full "four separate deletions" picture though: this role
// does NOT grant Microsoft.Network/networkInterfaces/delete or
// Microsoft.Compute/disks/delete (the NIC/OS disk are left in place after an
// AM-28 removal — see rolloutPlans.ts's remove-hosts handler doc comment for
// why that is a deliberate, accepted scope boundary, not an oversight), and
// it grants no Microsoft.Graph/Entra device-delete permission at all (that
// cleanup step has no captured, automatable procedure on this estate per the
// same runbook section). App-level mitigation, not a substitute for this
// RBAC narrowing: every call this role's actions back is gated behind
// rolloutPlans.ts's admin-only auth, a server-verified zero-sessions HARD
// GATE re-checked immediately before each deletion (no `force` bypass — see
// rolloutPlanService.ts#canRemoveHost), and a mandatory-reason audit row per
// batch.
//
// ESTATE CONTEXT (2026-08-16 — see
// the gap register item 20): `LOCK-HP-CONTOSO-PROD`, a
// `CanNotDelete` scope lock previously present on `HP-CONTOSO-PROD`, was
// deliberately removed specifically because ARM resource locks are
// inherited by child resources and were blocking
// `Microsoft.DesktopVirtualization/hostPools/sessionHosts/delete` — i.e.
// this role's very reason for existing. That removal is what makes this
// role's sessionhosts/delete action actually effective against the live
// host pool; it is not a workaround this module needs to account for, and
// no code here compensates for a lock that might reappear (see item 20's
// remediation note for the corresponding "do not re-add a lock at/above
// HP-CONTOSO-PROD without accounting for this" guidance).
//
// Action strings confirmed via Microsoft Learn:
//   - Microsoft.DesktopVirtualization/hostpools/sessionhosts/delete —
//     the JS SDK operation this backs (@azure/arm-desktopvirtualization's
//     SessionHosts.delete, `force?: boolean` optional param) is documented
//     at https://learn.microsoft.com/javascript/api/@azure/arm-desktopvirtualization/sessionhosts
//     and https://learn.microsoft.com/javascript/api/@azure/arm-desktopvirtualization/sessionhostsdeleteoptionalparams.
//   - Microsoft.Compute/virtualMachines/read,
//     Microsoft.Compute/virtualMachines/delete — confirmed via Microsoft
//     Learn's Compute permissions reference
//     (https://learn.microsoft.com/azure/role-based-access-control/permissions/compute#microsoftcompute)
//     and the @azure/arm-compute VirtualMachinesOperations.delete reference
//     (https://learn.microsoft.com/javascript/api/@azure/arm-compute/virtualmachinesoperations)
//     confirming `delete` returns a PollerLike the same shape as
//     start/restart/deallocate — see computeService.ts#beginVmDelete's doc
//     comment for why that means the same "submitted, not awaited" design
//     as beginVmPowerAction applies unchanged.
//   - Microsoft.DesktopVirtualization/hostpools/read and
//     Microsoft.DesktopVirtualization/hostpools/sessionhosts/read are
//     included for the SAME "self-sufficient role" reasoning
//     vmPowerOperatorRole.bicep's header comment gives for its own
//     virtualMachines/read — deliberately redundant with the plain Reader
//     grant on RG-AVD-HostPools and with sessionHostWriterRole.bicep's own
//     read actions, so this role stays independently readable/revocable
//     without depending on either of those staying assigned.
//
// SCOPE: RESOURCE GROUP (RG-AVD-HostPools in prod) — the narrowest scope
// this repo's main.bicep + module `scope:` redirection pattern supports,
// same as sessionHostWriterRole.bicep/vmPowerOperatorRole.bicep. Same
// ACCEPTED RISK as vmPowerOperatorRole.bicep's own header comment: this
// covers the WHOLE resource group, not a dynamic per-VM/per-session-host
// scope (Azure custom roles don't support that within one role definition) —
// if RG-AVD-HostPools ever hosts VMs/session hosts unrelated to HP-CONTOSO-PROD,
// this role could delete those too.
targetScope = 'resourceGroup'

@description('Deployment environment (dev/test/prod). Both the role definition resource name (a GUID, generated below) and its display name (roleName) must be unique within the Microsoft Entra TENANT — not just this resource group — even though assignableScopes narrows where the role can be ASSIGNED (see https://learn.microsoft.com/azure/role-based-access-control/custom-roles#custom-role-properties). Parameterizing with environmentName keeps dev/test/prod deployments in this same tenant from colliding.')
param environmentName string

@description('Principal ID (object ID) of the Function App system-assigned managed identity to assign this role to.')
param principalId string

resource rolloutOperatorRoleDefinition 'Microsoft.Authorization/roleDefinitions@2022-04-01' = {
  name: guid(subscription().id, 'AVD Manager Rollout Operator', environmentName)
  properties: {
    roleName: 'AVD Manager Rollout Operator (${environmentName})'
    description: 'AVD Manager (AM-28/M4-S3): deregister a session host from its host pool and delete its underlying VM — for the staged rollout wizard\'s host-removal step ONLY. Deliberately holds the two DELETE actions sessionHostWriterRole/vmPowerOperatorRole each explicitly exclude; see this file\'s header comment for the full blast-radius account (no NIC/disk delete, no Entra/Graph device delete, gated behind an admin-only, server-verified zero-sessions hard gate in app code).'
    type: 'CustomRole'
    permissions: [
      {
        actions: [
          'Microsoft.DesktopVirtualization/hostpools/read'
          'Microsoft.DesktopVirtualization/hostpools/sessionhosts/read'
          'Microsoft.DesktopVirtualization/hostpools/sessionhosts/delete'
          'Microsoft.Compute/virtualMachines/read'
          'Microsoft.Compute/virtualMachines/delete'
        ]
        notActions: []
        dataActions: []
        notDataActions: []
      }
    ]
    // Narrowest scope this repo's main.bicep + module `scope:` redirection
    // supports: the specific resource group the role is deployed into
    // (RG-AVD-HostPools in prod, where session-host VMs live), not the
    // subscription. See this file's header SCOPE section for the accepted
    // whole-resource-group residual risk.
    assignableScopes: [
      resourceGroup().id
    ]
  }
}

resource rolloutOperatorAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(resourceGroup().id, principalId, rolloutOperatorRoleDefinition.id)
  properties: {
    principalId: principalId
    roleDefinitionId: rolloutOperatorRoleDefinition.id
    principalType: 'ServicePrincipal'
  }
}

output roleDefinitionId string = rolloutOperatorRoleDefinition.id
