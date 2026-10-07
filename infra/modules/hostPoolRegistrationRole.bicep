// AM-22 (M2-S5) — least-privilege custom role for the registration-token
// generator (app/api/src/functions/hostPoolRegistrationToken.ts POST route,
// backed by app/api/src/services/avdService.ts#generateRegistrationToken /
// #getRegistrationTokenStatus).
//
// WHY a custom role instead of a built-in one: the narrowest built-in role
// that includes hostpools/write + hostpools/retrieveRegistrationToken/action
// is "Desktop Virtualization Virtual Machine Contributor"
// (a959dbd1-f747-45e3-8ba6-dd80f235f97c), confirmed against Microsoft
// Learn's built-in-roles reference
// (https://learn.microsoft.com/azure/role-based-access-control/built-in-roles/compute#desktop-virtualization-virtual-machine-contributor).
// That role grants far more than this feature needs — full VM
// create/delete/start/stop/runCommand, disk write/delete, NIC join/delete,
// KeyVault deploy, etc. — none of which this app's registration-token
// generator calls. This module instead defines a role with only the three
// ARM actions that route actually exercises.
//
// WHY a SEPARATE role from AVD Manager Session Host Writer
// (sessionHostWriterRole.bicep, AM-18/M2-S1), rather than widening it:
// hostpools/write is a materially broader grant than
// hostpools/sessionhosts/write — it allows changing ANY patchable host pool
// property (maxSessionLimit, customRdpProperty, vmTemplate, loadBalancerType,
// etc. — see the HostPoolPatch shape at
// https://learn.microsoft.com/azure/templates/microsoft.desktopvirtualization/2024-04-03/hostpools#hostpoolpatch),
// not just the registrationInfo sub-property this feature actually sets.
// Bundling it into the session-host writer role would silently widen what
// the drain-toggle feature's own role grants beyond what AM-18 deliberately
// scoped it to. Kept as its own role instead, so each feature's Azure
// footprint is independently auditable and revocable.
//
// Confirmed on Microsoft Learn (Azure built-in roles for Compute /
// "Desktop Virtualization Virtual Machine Contributor" action list) that
// the three actions below are exactly the ones needed:
//   - Microsoft.DesktopVirtualization/hostpools/read
//   - Microsoft.DesktopVirtualization/hostpools/write            (hostPools.update)
//   - Microsoft.DesktopVirtualization/hostpools/retrieveRegistrationToken/action (hostPools.retrieveRegistrationToken)
// (https://learn.microsoft.com/azure/role-based-access-control/built-in-roles/compute#desktop-virtualization-virtual-machine-contributor)
//
// Deployed at RESOURCE GROUP scope, same pattern as sessionHostWriterRole.bicep
// — see that module's header comment for the Microsoft Learn sources
// confirming Microsoft.Authorization/roleDefinitions supports
// resource-group-scoped deployment.
//
// NOTE on "admin-scoped": this role is granted to the Function App's single
// system-assigned managed identity — the SAME principal already holding
// AVD Manager Session Host Writer (sessionHostWriterRole.bicep) — because
// this app has only one Azure identity for all its API routes (see
// infra/main.bicep's comment on rbacHostPools). "Admin-only" for this
// feature is therefore enforced at the APPLICATION layer
// (requireMinimumRole('admin') in
// app/api/src/functions/hostPoolRegistrationToken.ts), not by a separate,
// less-privileged Azure principal. This role's own job is narrower in
// scope: least-privilege on WHAT the shared identity can do in Azure, not
// WHO can trigger it — that second question is the app's job.
targetScope = 'resourceGroup'

@description('Deployment environment (dev/test/prod). BOTH the role definition resource name (a GUID, generated below) and its display name (roleName) must be unique within the Microsoft Entra TENANT — not just this resource group — even though assignableScopes narrows where the role can be ASSIGNED (see https://learn.microsoft.com/azure/role-based-access-control/custom-roles#custom-role-properties and https://learn.microsoft.com/azure/azure-resource-manager/bicep/scenarios-rbac#custom-role-definitions). Parameterizing with environmentName keeps dev/test/prod deployments in this same tenant from colliding.')
param environmentName string

@description('Principal ID (object ID) of the Function App system-assigned managed identity to assign this role to.')
param principalId string

// TODO (deferred at AM-22 peer review — not implemented here): an Azure
// Monitor Activity Log alert rule that fires on
// Microsoft.DesktopVirtualization/hostpools/write against RG-AVD-HostPools
// would give an out-of-band signal whenever a registration token is
// generated/rotated (or any other host pool property changes), independent
// of this app's own AuditLog table — useful if the Function App's identity
// or this app's audit path were ever compromised. Out of scope for M2-S5;
// revisit as a follow-up alongside the DELETE/revoke route noted in
// app/README.md's Mutations & RBAC section.
resource hostPoolRegistrationRoleDefinition 'Microsoft.Authorization/roleDefinitions@2022-04-01' = {
  name: guid(subscription().id, 'AVD Manager Host Pool Registration', environmentName)
  properties: {
    roleName: 'AVD Manager Host Pool Registration (${environmentName})'
    description: 'AVD Manager (AM-22/M2-S5): read/write host pools and retrieve their registration token — for the admin-only registration-token generator. Deliberately narrower than the built-in Desktop Virtualization Virtual Machine Contributor role: no VM/disk/NIC/KeyVault actions, and kept separate from AVD Manager Session Host Writer (AM-18) so hostpools/write does not widen that other, narrower role grant.'
    type: 'CustomRole'
    permissions: [
      {
        actions: [
          'Microsoft.DesktopVirtualization/hostpools/read'
          'Microsoft.DesktopVirtualization/hostpools/write'
          'Microsoft.DesktopVirtualization/hostpools/retrieveRegistrationToken/action'
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

resource hostPoolRegistrationAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(resourceGroup().id, principalId, hostPoolRegistrationRoleDefinition.id)
  properties: {
    principalId: principalId
    roleDefinitionId: hostPoolRegistrationRoleDefinition.id
    principalType: 'ServicePrincipal'
  }
}

output roleDefinitionId string = hostPoolRegistrationRoleDefinition.id
