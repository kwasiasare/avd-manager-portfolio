// AM-27 (M4-S2) — least-privilege custom role for the golden-image build
// orchestrator's Microsoft.Network ARM writes: creating and deleting the
// throwaway build VM's network interface (which lives in RG-AVD-Images,
// alongside the build VM — see imageBuildOperatorRole.bicep's header
// comment for why that RG), joined to a DEDICATED build subnet in
// RG-AVD-Network (the caller-supplied `subnetName` param — see
// infra/main.bicep's `imageBuildSubnetName` param).
//
// WHY NOT SNET-MANAGEMENT (Opus review BLOCKER 2): the runbooks
// §4.1 documents SNET-MANAGEMENT as the build-VM
// subnet, but on THIS estate's live deployment SNET-MANAGEMENT is
// delegated to Microsoft.App/environments for the Function App's OWN Flex
// Consumption VNet integration (see app-registration.md DEPLOY-PREREQS
// 0.1) — a delegated subnet refuses to host any resource type other than
// the delegated service's own, so a VM NIC create there fails with
// SubnetIsDelegatedToOtherService. The build VM needs its OWN, separate,
// non-delegated subnet — see app-registration.md DEPLOY-PREREQS 0.5 for
// the operator-approved estate change (an az CLI command) that creates it
// BEFORE this Bicep template is deployed; infra/main.bicep's
// `imageBuildSubnetName` param has NO default specifically so a deploy
// cannot silently default back to SNET-MANAGEMENT.
//
// ONE ROLE DEFINITION, TWO ROLE ASSIGNMENTS, DIFFERENT SCOPES — all in this
// single module (not two separate module invocations): a custom role's
// assignableScopes accepts MULTIPLE scopes (confirmed via Microsoft Learn,
// "Azure custom roles — AssignableScopes": the property is an array and can
// list more than one management group/subscription/resource group), so one
// role definition here declares assignableScopes = [RG-AVD-Network,
// RG-AVD-Images] and is then assigned TWICE:
//   1. Scoped to the SPECIFIC build subnet RESOURCE in RG-AVD-Network
//      (narrower than the resource group — same "author at RG scope,
//      assign at resource scope" pattern sessionUserSessionOperatorRole.bicep
//      already uses) — grants ONLY subnets/read + subnets/join/action on
//      that one subnet; NSGs, route tables, private endpoints, DNS zones,
//      and every OTHER subnet in VNET-CONTOSO-PROD (including SNET-MANAGEMENT)
//      are untouched.
//   2. Scoped to the WHOLE RG-AVD-Images resource group — because the NIC
//      resource this half of the role covers has a NEW, PER-BUILD name
//      (derived from a fresh buildId — see imageBuildPlan.ts's
//      deriveBuildResourceNames) that does not exist at role-authoring
//      time, so it cannot be scoped any narrower than the resource group a
//      custom role assignment can target (same accepted-risk posture
//      imageBuildOperatorRole.bicep already documents for its own
//      RG-AVD-Images-scoped Compute actions).
// Deploying the SAME role definition twice at two different scopes (rather
// than this single-definition-two-assignments shape) would fail ARM
// validation: a custom role's roleName must be unique across the whole
// Entra tenant, and two separately-deployed definitions with identical
// roleName/description would collide.
//
// Action strings confirmed via Microsoft Learn's Networking permissions
// reference (https://learn.microsoft.com/azure/role-based-access-control/permissions/networking#microsoftnetwork)
// and the built-in Desktop Virtualization Virtual Machine Contributor
// role's own action list, which lists networkInterfaces/write|read|delete|
// join/action together for exactly this "create a VM's NIC" purpose
// (https://learn.microsoft.com/azure/role-based-access-control/built-in-roles/compute#desktop-virtualization-virtual-machine-contributor).
// subnets/join/action itself: https://learn.microsoft.com/azure/virtual-network/virtual-network-manage-subnet#prerequisites
// ("Microsoft.Network/virtualNetworks/subnets/join/action — Join a virtual
// network").
targetScope = 'resourceGroup'

@description('Deployment environment (dev/test/prod).')
param environmentName string

@description('Principal ID (object ID) of the Function App system-assigned managed identity to assign this role to.')
param principalId string

@description('Resource group containing the existing build subnet (RG-AVD-Network).')
param rgNetworkName string

@description('Resource group where the build VM\'s NIC is created (RG-AVD-Images) — the second, resource-group-scoped assignment target.')
param rgImagesName string

@description('Name of the existing VNet containing the build subnet.')
param vnetName string

@description('Name of the existing, DEDICATED (non-delegated) subnet the build VM\'s NIC joins — see this file\'s header comment for why it must NOT be SNET-MANAGEMENT.')
param subnetName string

// Manually-constructed resource-group ARM ids: this Bicep CLI version
// (0.42.1) does not expose an `.id` property on the two-argument-free
// `resourceGroup(name)` function's return type (BCP052) — string
// interpolation off `subscription().id` (which itself IS a well-formed
// `/subscriptions/{id}` value) is the documented fallback for referencing
// an ARBITRARY resource group's id by name alone.
var networkRgId = '${subscription().id}/resourceGroups/${rgNetworkName}'
var imagesRgId = '${subscription().id}/resourceGroups/${rgImagesName}'

resource imageBuildNetworkRoleDefinition 'Microsoft.Authorization/roleDefinitions@2022-04-01' = {
  name: guid(subscription().id, 'AVD Manager Image Build Network', environmentName)
  properties: {
    roleName: 'AVD Manager Image Build Network (${environmentName})'
    description: 'AVD Manager (AM-27/M4-S2): create/delete the throwaway build VM\'s network interface (RG-AVD-Images) and join it to the dedicated build subnet (RG-AVD-Network) only — never SNET-MANAGEMENT. No NSG, route table, or other subnet actions.'
    type: 'CustomRole'
    permissions: [
      {
        actions: [
          'Microsoft.Network/networkInterfaces/read'
          'Microsoft.Network/networkInterfaces/write'
          'Microsoft.Network/networkInterfaces/delete'
          'Microsoft.Network/networkInterfaces/join/action'
          'Microsoft.Network/virtualNetworks/subnets/read'
          'Microsoft.Network/virtualNetworks/subnets/join/action'
        ]
        notActions: []
        dataActions: []
        notDataActions: []
      }
    ]
    assignableScopes: [
      networkRgId
      imagesRgId
    ]
  }
}

// Existing-resource reference — NO explicit `scope:` here: this module is
// invoked by main.bicep with `scope: resourceGroup(rgNetworkName)` (see
// main.bicep's wiring), so this file's own deployment scope already IS
// RG-AVD-Network, and existingSubnet resolves within it directly (same
// no-explicit-scope convention vmPowerOperatorRole.bicep/
// sessionUserSessionOperatorRole.bicep already use for a resource in their
// own module's target resource group).
resource existingSubnet 'Microsoft.Network/virtualNetworks/subnets@2023-09-01' existing = {
  name: '${vnetName}/${subnetName}'
}

resource imageBuildNetworkAssignmentOnSubnet 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(existingSubnet.id, principalId, imageBuildNetworkRoleDefinition.id)
  scope: existingSubnet
  properties: {
    principalId: principalId
    roleDefinitionId: imageBuildNetworkRoleDefinition.id
    principalType: 'ServicePrincipal'
  }
}

// Assignment #2 — the whole RG-AVD-Images resource group, for the
// networkInterfaces/* actions (see this file's header comment for why this
// one cannot be scoped any narrower than the resource group).
module imageBuildNetworkAssignmentOnImagesRg 'imageBuildNetworkRoleAssignment.bicep' = {
  name: 'imageBuildNetworkAssignmentOnImagesRgDeploy'
  scope: resourceGroup(rgImagesName)
  params: {
    principalId: principalId
    roleDefinitionId: imageBuildNetworkRoleDefinition.id
  }
}

output roleDefinitionId string = imageBuildNetworkRoleDefinition.id
