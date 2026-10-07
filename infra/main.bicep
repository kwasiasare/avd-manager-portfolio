// AVD Manager app infrastructure — resource-group scope (AM-9 / M1).
//
// Deploys the Static Web App (linked to the Function App as its backend),
// the Function App + hosting plan/storage/App Insights, and wires the
// Function App into the existing management VNet. It intentionally does NOT
// create the AVD host pools / gallery / storage account etc. — those are
// existing resources this app reads from (see app/api/src/lib/config.ts for
// the resource names/RGs it expects). RBAC (infra/modules/rbac.bicep) is
// granted per-target-resource-group via module `scope:` redirection, not at
// subscription scope, so this file is fully self-contained at RG scope —
// deploy it directly:
//
//   az deployment group create --resource-group RG-AVD-Management \
//     --name avd-manager-prod \
//     --template-file main.bicep \
//     --parameters <your-environment>.bicepparam
//
// See docs/app-registration.md's DEPLOY-PREREQS section for manual steps
// (SNET-MANAGEMENT delegation, etc.) that must happen before this deploy.
targetScope = 'resourceGroup'

@description('Azure region for all new resources in this deployment except the Static Web App (see swaLocation) — must match the region of the existing AVD estate this app reads from (eastus).')
param location string = 'eastus'

@description('Azure region for the Static Web App. SWA Standard is only available in a limited region set that does not include eastus — eastus2 is the closest supported region. Every other resource in this deployment stays in `location` (eastus).')
param swaLocation string = 'eastus2'

@allowed(['dev', 'test', 'prod'])
@description('Deployment environment. No default — must be explicit per deployment so environment-qualified resource names (below) are never accidentally deployed as "prod" by omission.')
param environmentName string

@description('Name of the Azure Static Web App hosting the frontend. No default — pass an environment-qualified name, e.g. swa-example-prod, or the empty string for a deployment that sets deployStaticWebApp false (dev). Opus review (AM-40 Option C, Architect MAJOR): dev deployments MUST pass \'\' here, never the live prod SWA name — the module guard below also requires a non-empty name, so even a future flag regression cannot make a dev deploy reconcile (and silently re-point the linkedBackend of) the production SWA.')
param staticWebAppName string

@description('AM-40 (Option C): whether to deploy the Static Web App module at all. The dev environment deliberately has NO SWA of its own — its frontend is the "dev" named preview environment on the PROD SWA (swa-example-prod), so a dev deployment passes false here to deploy only the Function App + RBAC. The dev SWA-side hookup (builds/dev/linkedBackends -> func-example-dev) is a separate post-deploy step — see docs/app-registration.md §12.1 — because Azure refuses to link a backend that already carries another environment\'s SWA auth configuration (Conflict 59366), which is why prod\'s Function App cannot be shared with the dev environment in the first place.')
param deployStaticWebApp bool = true

@description('Name of the Function App hosting the linked API backend. No default — pass an environment-qualified name, e.g. func-example-dev / func-example-prod.')
param functionAppName string

@description('Resource group containing the existing AVD management VNet.')
param networkResourceGroup string = 'RG-AVD-Network'

@description('Name of the existing VNet the Function App integrates into.')
param vnetName string

@description('Name of the existing subnet used for Function App VNet integration. MUST be delegated to Microsoft.App/environments (the Flex Consumption requirement — NOT Microsoft.Web/serverFarms, which applied to the abandoned EP1 plan). See docs/app-registration.md DEPLOY-PREREQS 0.1.')
param subnetName string

@description('Function App public network access setting. Must stay Enabled while SWA-fronted — see infra/modules/functionapp.bicep publicNetworkAccess and ipSecurityRestrictionsDefaultAction.')
@allowed(['Enabled', 'Disabled'])
param publicNetworkAccess string = 'Enabled'

@description('CIDR ranges allowed to reach the Function App publicly. Only meaningful when ipSecurityRestrictionsDefaultAction is Deny — see that param.')
param allowedInboundIpRanges array = []

@description('Default action for the Function App ipSecurityRestrictions — see infra/modules/functionapp.bicep param of the same name. Must be Allow for an SWA linked backend (prod); Deny + allowlist is the posture for any non-SWA-fronted deployment.')
@allowed(['Allow', 'Deny'])
param ipSecurityRestrictionsDefaultAction string = 'Deny'

@description('Gates app/api/src/lib/auth.ts#verifyBackendSecret. Default false — see infra/modules/functionapp.bicep param of the same purpose for the full reasoning (SWA linked-backend forwarding has no sender for a custom header today).')
param enforceSharedHeaderCheck string = 'false'

@secure()
@description('Shared secret validated by the API for every SWA-forwarded request (defense-in-depth alongside x-ms-client-principal). Supply via a secure pipeline variable / Key Vault reference — never commit a value.')
param swaBackendSecret string

@description('Subscription ID containing the existing AVD resources this API reads.')
param subscriptionId string

@description('Resource group containing the existing AVD host pools.')
param rgHostPools string = 'RG-AVD-HostPools'

@description('Name of the existing production host pool.')
param hostPoolName string

@description('Name of the existing scaling plan assigned to hostPoolName — AM-23 (M3-S1): modules/scalingPlanOperatorRole.bicep scopes its role ASSIGNMENT to this specific resource, not the whole rgHostPools resource group.')
param scalingPlanName string

@description('Name of the existing AVD workspace.')
param workspaceName string

@description('Name of the existing desktop application group.')
param dagName string

@description('Resource group containing the existing Azure Compute Gallery.')
param rgImages string = 'RG-AVD-Images'

@description('Name of the existing Azure Compute Gallery.')
param galleryName string

@description('Name of the existing gallery image definition within galleryName.')
param imageDefinitionName string = 'WIN11-ENT-MS-M365'

@description('ISO date (YYYY-MM-DD) the current golden image underlying OS falls out of support. Azure has no API for this — operator-supplied. Empty = not configured.')
param imageEolDate string = ''

@description('Name of the existing FSLogix profile storage account.')
param avdStorageAccountName string

@description('Name of the existing FSLogix profile file share.')
param fslogixShareName string = 'fslogixprofiles'

@description('Resource group containing RG-AVD-Management (this app itself) — AM-25 cost dashboard RG.')
param rgManagement string = 'RG-AVD-Management'

@description('Resource group containing the AVD management VNet/NSGs/private endpoints — AM-25 cost dashboard RG. Defaults to the same value as networkResourceGroup above; kept as a separate param since the two params serve different purposes (networkResourceGroup identifies where the VNet/subnet this Function App integrates into lives; rgManagement/rgNetwork/rgStorage below are purely cost-attribution RGs passed through to app/api).')
param rgNetwork string = 'RG-AVD-Network'

@description('Resource group containing the existing FSLogix profile storage account (avdStorageAccountName) — AM-25 cost dashboard RG, also used by fslogixService.ts for share usage stats.')
param rgStorage string = 'RG-AVD-Storage'

@description('Resource group containing the existing Key Vault (AM-16 governance panel — purge-protection check). Not otherwise read by this app.')
param rgSecurity string = 'RG-AVD-Security'

@description('Name of the existing Key Vault whose purge-protection setting the AM-16 governance panel reads.')
param keyVaultName string

@description('Entra ID object ID of this estate\'s break-glass (emergency-access) group/account — the principal the AM-16 governance panel\'s Conditional Access check verifies every enabled CA policy excludes. Empty until an operator identifies and sets it; no such group is captured anywhere in the runbooks or the runbooks today. See app/api/src/services/governance/conditionalAccessBreakGlass.ts.')
param breakGlassGroupId string = ''

@description('Comma-separated required tag KEYS the AM-16 governance panel\'s untagged-resource sub-scan checks for. Empty (default) = no tag policy configured — informational only, not findings. See app/api/src/lib/config.ts governance.requiredTags doc comment.')
param requiredTags string = ''

@description('Expected count of private endpoints in RG-AVD-Network (AM-16 governance panel peer review item 16) — matches the estate inventory §3\'s captured 5 by default.')
param expectedPrivateEndpointCount int = 5

@description('AM-56 — Entra object id of THIS deployment\'s own Function App managed identity, as the expected baseline holder of Storage File Data Privileged Contributor on the FSLogix storage account (app/api/src/services/governance/storagePrivilegedAccess.ts). NOT computed automatically: Bicep rejects a resource referencing its own identity output within its own properties (verified — `az bicep build` raises BCP079 "This expression is referencing its own declaration" for exactly this pattern), so unlike an RBAC role-assignment module (a SEPARATE resource, which already safely reads functionApp.outputs.principalId elsewhere in this file), an app SETTING on the Function App\'s OWN resource cannot self-reference that same way. Operator-supplied AFTER the first deploy instead — the same bootstrap pattern groupIdViewer/breakGlassGroupId above already use, since the identity is stable across re-deploys of the same resource: `az functionapp identity show --name <functionAppName> --resource-group RG-AVD-Management --query principalId -o tsv`. Empty (the default, e.g. on a first deploy) leaves the storage-privileged-access governance check at its honest \'unknown\' (not-configured) state until set.')
param privilegedStorageBaselinePrincipalId string = ''

@description('AM-56 — comma-separated EXTRA Entra object ids expected to hold Storage File Data Privileged Contributor on the FSLogix storage account, beyond privilegedStorageBaselinePrincipalId above — e.g. a DEV environment\'s own Function App identity (its parameter file resolves its own deployment\'s principal id the same operator-supplied way and passes it here) when prod and dev both hold this same grant on one shared estate (see infra/modules/fslogixDataPlaneRole.bicep). Empty by default.')
param privilegedStorageBaselineExtraPrincipalIds string = ''

@description('AM-56 — comma-separated expected Microsoft.Authorization/locks CanNotDelete names on RG-AVD-Storage / its storage account (app/api/src/services/governance/storageDeleteLocks.ts). Empty (default) lets app/api/src/lib/config.ts fall back to the three documented names (the FSLogix storage runbook lines 344-345) — only set this to override that default for a deliberate estate change.')
param expectedStorageLockNames string = ''

@description('Resource group containing the existing Log Analytics workspace.')
param logAnalyticsResourceGroup string = 'RG-AVD-Monitoring'

@description('Name of the existing Log Analytics workspace.')
param logAnalyticsWorkspaceName string

@description('Entra ID object ID of the AVDMGR-Viewers group (see docs/app-registration.md). Empty until group provisioning has run — the roles function simply grants nobody that role until then.')
param groupIdViewer string = ''

@description('Entra ID object ID of the AVDMGR-Operators group.')
param groupIdOperator string = ''

@description('Entra ID object ID of the AVDMGR-Admins group.')
param groupIdAdmin string = ''

@description('API application version reported by GET /api/v1/health.')
param apiVersion string = '1.0.0'

@description('Default VM size for a golden-image build VM (AM-27/M4-S2) — see infra/modules/functionapp.bicep param of the same name.')
param imageBuildVmSize string = 'Standard_D4ads_v7'

@description('Azure region for golden-image build resources (VM/snapshot/gallery image version) — must match the gallery\'s own region.')
param imageBuildLocation string = 'eastus'

@description('Name of the EXISTING subnet the golden-image build VM\'s NIC joins — NO default; must be explicit. Opus review BLOCKER 2: this MUST NOT be subnetName/SNET-MANAGEMENT — that subnet is delegated to Microsoft.App/environments for this app\'s OWN Flex Consumption VNet integration (see docs/app-registration.md DEPLOY-PREREQS 0.1), and a delegated subnet refuses to host anything other than the delegated service\'s own resources — a VM NIC create there fails with SubnetIsDelegatedToOtherService. The build subnet must be a SEPARATE, non-delegated subnet (e.g. SNET-IMAGEBUILD) created as an operator-approved estate change BEFORE deploying this template — see docs/app-registration.md DEPLOY-PREREQS 0.5 for the exact az CLI command and a suggested CIDR from VNET-CONTOSO-PROD\'s documented free space.')
param imageBuildSubnetName string

@description('AM-50: name of the EXISTING SNET-SESSIONHOSTS subnet every session host\'s NIC joins, including new ones the guided provisioning wizard creates — this subnet already exists on the live estate (the session-host runbook §1), unlike imageBuildSubnetName above (a NEW estate change that story had to gate behind a no-default param), so this one is safe to default.')
param sessionHostSubnetName string = 'SNET-SESSIONHOSTS'

@description('AM-13 (M5): profiles at or above this size (GiB) are flagged oversized on the Profiles page. See app/api/src/lib/config.ts profiles.oversizedGb doc comment.')
param fslogixOversizedGb int = 5

@description('AM-13 (M5): Entra ID object ID of the AVD-Users group — used by the Profiles page\'s orphan-detection cross-check (Graph GroupMember.Read.All). Empty until an operator sets it; see docs/app-registration.md\'s new GroupMember.Read.All section.')
param avdUsersGroupId string = ''

@description('AM-48: email address notified by the golden-image build alert rules\' action group (IMAGE_BUILD_STUCK and IMAGE_BUILD_CLEANUP_SELFHEAL — see infra/modules/alerting.bicep). No default — must be explicit per deployment so an operator can never accidentally deploy with nobody actually notified.')
param alertEmailAddress string

var commonTags = {
  application: 'avd-manager'
  environment: environmentName
  managedBy: 'bicep'
}

// AM-48: same resourceId() derivation functionapp.bicep already uses
// internally for its own logAnalyticsWorkspaceId var (App Insights'
// WorkspaceResourceId) — computed again here (not read back as a module
// output) because alerting.bicep's scheduledQueryRules need this exact
// value as a plain param, and there is no functionApp module output for it
// today (see that module's own logAnalyticsWorkspaceId comment).
var logAnalyticsWorkspaceId = resourceId(logAnalyticsResourceGroup, 'Microsoft.OperationalInsights/workspaces', logAnalyticsWorkspaceName)

// AM-56 — composes the two separately-supplied baseline params above into
// the single comma-separated PRIVILEGED_STORAGE_BASELINE_PRINCIPAL_IDS app
// setting functionapp.bicep expects, dropping whichever half is empty
// (a first deploy with neither set yet still yields '' — the check's own
// "not configured" degradation, not a stray leading/trailing comma).
var privilegedStorageBaselinePrincipalIds = join(filter([privilegedStorageBaselinePrincipalId, privilegedStorageBaselineExtraPrincipalIds], (id) => !empty(id)), ',')

// Existing subnet reference for the Function App's OWN Flex Consumption
// VNet integration — resolved cross-resource-group.
resource existingSubnet 'Microsoft.Network/virtualNetworks/subnets@2023-09-01' existing = {
  name: '${vnetName}/${subnetName}'
  scope: resourceGroup(networkResourceGroup)
}

// AM-27 (M4-S2) — a SEPARATE existing subnet for the golden-image build
// VM's NIC (Opus review BLOCKER 2 — see imageBuildSubnetName's doc comment
// for why this cannot reuse existingSubnet/SNET-MANAGEMENT above).
resource existingImageBuildSubnet 'Microsoft.Network/virtualNetworks/subnets@2023-09-01' existing = {
  name: '${vnetName}/${imageBuildSubnetName}'
  scope: resourceGroup(networkResourceGroup)
}

module functionApp 'modules/functionapp.bicep' = {
  name: 'functionAppDeploy'
  params: {
    location: location
    functionAppName: functionAppName
    subnetId: existingSubnet.id
    tags: commonTags
    publicNetworkAccess: publicNetworkAccess
    allowedInboundIpRanges: allowedInboundIpRanges
    ipSecurityRestrictionsDefaultAction: ipSecurityRestrictionsDefaultAction
    swaBackendSecret: swaBackendSecret
    enforceSharedHeaderCheck: enforceSharedHeaderCheck
    subscriptionId: subscriptionId
    rgHostPools: rgHostPools
    hostPoolName: hostPoolName
    workspaceName: workspaceName
    dagName: dagName
    rgImages: rgImages
    galleryName: galleryName
    imageDefinitionName: imageDefinitionName
    imageEolDate: imageEolDate
    avdStorageAccountName: avdStorageAccountName
    fslogixShareName: fslogixShareName
    rgManagement: rgManagement
    rgNetwork: rgNetwork
    rgStorage: rgStorage
    rgSecurity: rgSecurity
    keyVaultName: keyVaultName
    breakGlassGroupId: breakGlassGroupId
    vnetNameForGovernance: vnetName
    requiredTags: requiredTags
    expectedPrivateEndpointCount: expectedPrivateEndpointCount
    // AM-56 — see this file's own privilegedStorageBaselinePrincipalId/
    // privilegedStorageBaselineExtraPrincipalIds param doc comments above.
    privilegedStorageBaselinePrincipalIds: privilegedStorageBaselinePrincipalIds
    expectedStorageLockNames: expectedStorageLockNames
    logAnalyticsResourceGroup: logAnalyticsResourceGroup
    logAnalyticsWorkspaceName: logAnalyticsWorkspaceName
    groupIdViewer: groupIdViewer
    groupIdOperator: groupIdOperator
    groupIdAdmin: groupIdAdmin
    apiVersion: apiVersion
    // AM-27 (M4-S2) — Opus review BLOCKER 2: the build VM's NIC joins its
    // OWN dedicated subnet (existingImageBuildSubnet, resolved above), NOT
    // the Function App's SNET-MANAGEMENT (existingSubnet) — that subnet is
    // delegated to Microsoft.App/environments and cannot host a VM NIC. See
    // imageBuildSubnetName's doc comment and docs/app-registration.md
    // DEPLOY-PREREQS 0.5.
    imageBuildSubnetId: existingImageBuildSubnet.id
    imageBuildVmSize: imageBuildVmSize
    imageBuildLocation: imageBuildLocation
    // AM-50 — guided session-host provisioning: a bare subnet NAME (not a
    // pre-resolved resource id) since app/api/src/lib/config.ts computes
    // the subnet's resource id itself — see sessionHostSubnetName's own
    // param doc comment.
    sessionHostSubnetName: sessionHostSubnetName
    // AM-13 (M5) — FSLogix profile management app settings.
    fslogixOversizedGb: fslogixOversizedGb
    avdUsersGroupId: avdUsersGroupId
  }
}

// staticwebapp.bicep declared after functionApp so it can wire up the
// linkedBackends child resource in the same deployment (see that module's
// comment — the Function App must exist first).
// Double-guarded (Opus review, Architect MAJOR): the boolean AND a non-empty
// name must both hold. A dev deploy passes deployStaticWebApp=false AND
// staticWebAppName='' — flipping either alone still cannot touch prod's SWA.
module staticWebApp 'modules/staticwebapp.bicep' = if (deployStaticWebApp && !empty(staticWebAppName)) {
  name: 'staticWebAppDeploy'
  params: {
    location: swaLocation
    staticWebAppName: staticWebAppName
    tags: commonTags
    linkedBackendResourceId: functionApp.outputs.id
    linkedBackendLocation: location
  }
}

// Least-privilege RBAC: Reader is granted per-resource-group (rbacHostPools/
// rbacImages/rbacMonitoring below, plus a resource-scoped grant on the
// FSLogix storage account specifically — rbacFslogixStorageAccountReader —
// AM-25), not once at subscription scope — see infra/modules/rbac.bicep's
// comment for the full reasoning. Cost Management Reader (AM-25) is granted
// even more broadly, at six RG-AVD-* resource groups (see
// costManagementReaderRoleDefinitionId below), since Cost Management's
// Query API has no single-resource scope to narrow it to. Single
// principal: the Flex Consumption plan (see infra/modules/functionapp.bicep)
// has no deployment-slot concept, so there is only ever one Function App
// managed identity to grant roles to (an earlier EP1-based version of this
// file granted the same roles to a second, staging-slot principal — removed
// along with the slot itself). RG-AVD-HostPools additionally gets custom
// roles: AM-18/M2-S1's session-host writer (modules/sessionHostWriterRole.bicep)
// for the drain toggle, and AM-19/M2-S2's VM power operator
// (modules/vmPowerOperatorRole.bicep) for start/restart/deallocate — kept as
// separate role definitions (DesktopVirtualization vs Compute resource
// providers) so either grant can be revoked independently. Neither uses a
// built-in role, which would over-grant (see each module's header comment
// for the Microsoft Learn sources).
//
// AM-14 (M6) additionally grants the BUILT-IN User Access Administrator
// role, but ONLY resource-scoped to the DAG (not the whole resource group)
// and ABAC-constrained to the "Desktop Virtualization User" role
// definition alone — see modules/dagUserAccessAdministratorRole.bicep.
//
// RG-AVD-Monitoring gets plain Reader at RG scope (via the rbacMonitoring
// module below) PLUS Log Analytics Reader
// scoped down to just the LAW-CONTOSO-PROD workspace resource (the
// rbacLogAnalyticsReaderOnWorkspace resource below, not a rbac.bicep module
// invocation — see its comment for why the narrower scope and the honest
// account of what it does/doesn't isolate).
var readerRoleDefinitionId = 'acdd72a7-3385-48ef-bd42-f606fba81ae7'
var logAnalyticsReaderRoleDefinitionId = '73c42c96-874c-492b-b04d-ab87d138a893'
// AM-25: Cost Management Reader — GUID verified against Microsoft's "Azure
// built-in roles for Management and governance" reference
// (Microsoft.CostManagement/*/read + Microsoft.Consumption/*/read actions).
// Granted per-resource-group (six separate module invocations below, one
// per RG costService.ts queries), NOT once at subscription scope — Cost
// Management's Query API is documented to work at resource-group scope
// ('/subscriptions/{id}/resourceGroups/{name}'; see Microsoft's "Understand
// and work with scopes" page), so the same least-privilege posture Reader
// already uses above extends naturally to this role too, at the cost of
// costService.ts making one Cost Management API call per tracked RG rather
// than one at subscription scope (mitigated by that service's ~1h
// in-memory cache — see its top comment).
var costManagementReaderRoleDefinitionId = '72fafb9e-0641-4937-9268-a91bfd8191a3'
// AM-16 (M3b): the governance panel (app/api/src/services/governance/*.ts)
// widens plain Reader from three RGs (HostPools/Images/Monitoring) to all
// SEVEN RG-AVD-* resource groups (adding Management/Network/Storage/
// Security) — see each rbac* module's own comment below for the specific
// reads that need it. Still never subscription-scoped (see
// infra/modules/rbac.bicep's header comment) and still least-privilege:
// Reader alone, no write actions, added only where a specific governance
// check's read demonstrably needs it.

module rbacHostPools 'modules/rbac.bicep' = {
  name: 'rbacHostPoolsDeploy'
  scope: resourceGroup(rgHostPools)
  params: {
    principalId: functionApp.outputs.principalId
    roleDefinitionIds: [readerRoleDefinitionId, costManagementReaderRoleDefinitionId]
  }
}

// AM-18 (M2-S1): custom least-privilege role for the drain toggle's ARM
// write — see modules/sessionHostWriterRole.bicep for the full rationale
// and Microsoft Learn sources.
module rbacSessionHostWriter 'modules/sessionHostWriterRole.bicep' = {
  name: 'rbacSessionHostWriterDeploy'
  scope: resourceGroup(rgHostPools)
  params: {
    environmentName: environmentName
    principalId: functionApp.outputs.principalId
  }
}

// AM-22 (M2-S5): custom least-privilege role for the admin-only
// registration-token generator's ARM read/write + retrieveRegistrationToken
// action — see modules/hostPoolRegistrationRole.bicep for the full
// rationale (including why this is a SEPARATE role from
// rbacSessionHostWriter above) and Microsoft Learn sources.
module rbacHostPoolRegistration 'modules/hostPoolRegistrationRole.bicep' = {
  name: 'rbacHostPoolRegistrationDeploy'
  scope: resourceGroup(rgHostPools)
  params: {
    environmentName: environmentName
    principalId: functionApp.outputs.principalId
  }
}

// AM-19 (M2-S2): custom least-privilege role for the session-host power
// actions endpoint's ARM writes (start/restart/deallocate) — see
// modules/vmPowerOperatorRole.bicep for the full rationale and Microsoft
// Learn sources. Same rgHostPools scope as rbacSessionHostWriter above: the
// session-host VMs live in that resource group (confirmed against
// The captured estate inventory).
module rbacVmPowerOperator 'modules/vmPowerOperatorRole.bicep' = {
  name: 'rbacVmPowerOperatorDeploy'
  scope: resourceGroup(rgHostPools)
  params: {
    environmentName: environmentName
    principalId: functionApp.outputs.principalId
  }
}

// AM-20 (M2-S3): sibling custom role for user-session operations (force
// logoff, send message, logoff-all-disconnected, broadcast) — deliberately
// a SEPARATE role from rbacSessionHostWriter above, not an extension of it.
// See modules/sessionUserSessionOperatorRole.bicep for the full rationale
// and Microsoft Learn sources.
module rbacSessionUserSessionOperator 'modules/sessionUserSessionOperatorRole.bicep' = {
  name: 'rbacSessionUserSessionOperatorDeploy'
  scope: resourceGroup(rgHostPools)
  params: {
    environmentName: environmentName
    principalId: functionApp.outputs.principalId
    hostPoolName: hostPoolName
  }
}

// AM-23 (M3-S1): custom least-privilege role for the scaling-plan schedule
// editor and emergency-override endpoints' ARM writes — see
// modules/scalingPlanOperatorRole.bicep for the full rationale and
// Microsoft Learn sources.
module rbacScalingPlanOperator 'modules/scalingPlanOperatorRole.bicep' = {
  name: 'rbacScalingPlanOperatorDeploy'
  scope: resourceGroup(rgHostPools)
  params: {
    environmentName: environmentName
    principalId: functionApp.outputs.principalId
    scalingPlanName: scalingPlanName
  }
}

// AM-28 (M4-S3): custom least-privilege role for the staged rollout wizard's
// host-removal step (sessionhosts/delete + VM delete) — see
// modules/rolloutOperatorRole.bicep for the full rationale, blast-radius
// account, and Microsoft Learn sources. Same rgHostPools scope as
// rbacSessionHostWriter/rbacVmPowerOperator above — the session-host VMs and
// their AVD registrations both live in that resource group.
module rbacRolloutOperator 'modules/rolloutOperatorRole.bicep' = {
  name: 'rbacRolloutOperatorDeploy'
  scope: resourceGroup(rgHostPools)
  params: {
    environmentName: environmentName
    principalId: functionApp.outputs.principalId
  }
}

// AM-47: custom least-privilege role for the staged rollout wizard's THIRD
// cutover gate — the FSLogix config-convergence check's Run Command v2
// submit/read/cleanup — see modules/sessionHostConfigCheckRole.bicep for
// the full rationale, blast-radius account (runCommands/write is
// SYSTEM-level arbitrary code execution — read that file before assigning
// this role anywhere else), and Microsoft Learn sources. Same rgHostPools
// scope as rbacRolloutOperator above — the session-host VMs this check
// targets live in that resource group.
module rbacSessionHostConfigCheck 'modules/sessionHostConfigCheckRole.bicep' = {
  name: 'rbacSessionHostConfigCheckDeploy'
  scope: resourceGroup(rgHostPools)
  params: {
    environmentName: environmentName
    principalId: functionApp.outputs.principalId
  }
}

// AM-14 (M6): ABAC-constrained User Access Administrator grant on the DAG
// for the Users & Access page's assign/remove flows — see
// modules/dagUserAccessAdministratorRole.bicep for the full rationale, the
// ABAC condition syntax + Microsoft Learn sources, and why this is the
// approved M0 design (user-assignment via ABAC-constrained User Access
// Administrator on the DAG) rather than a broader/unconstrained grant.
module rbacDagUserAccessAdministrator 'modules/dagUserAccessAdministratorRole.bicep' = {
  name: 'rbacDagUserAccessAdministratorDeploy'
  scope: resourceGroup(rgHostPools)
  params: {
    principalId: functionApp.outputs.principalId
    dagName: dagName
  }
}

module rbacImages 'modules/rbac.bicep' = {
  name: 'rbacImagesDeploy'
  scope: resourceGroup(rgImages)
  params: {
    principalId: functionApp.outputs.principalId
    roleDefinitionIds: [readerRoleDefinitionId, costManagementReaderRoleDefinitionId]
  }
}

// AM-27 (M4-S2): custom least-privilege role for the golden-image build
// orchestrator's Microsoft.Compute writes (build VM/disk/snapshot create-
// delete, Sysprep Run Command, deallocate/generalize, gallery image version
// create) — see modules/imageBuildOperatorRole.bicep for the full rationale
// and Microsoft Learn sources. Scoped to RG-AVD-Images, same resource group
// as rbacImages' plain Reader above (every build resource + the Compute
// Gallery itself live there).
module rbacImageBuildOperator 'modules/imageBuildOperatorRole.bicep' = {
  name: 'rbacImageBuildOperatorDeploy'
  scope: resourceGroup(rgImages)
  params: {
    environmentName: environmentName
    principalId: functionApp.outputs.principalId
  }
}

// AM-27 (M4-S2): custom least-privilege role for the golden-image build
// orchestrator's Microsoft.Network writes — creating/deleting the build
// VM's NIC (RG-AVD-Images) and joining it to the DEDICATED build subnet
// (RG-AVD-Network — see imageBuildSubnetName's doc comment for why this is
// NOT SNET-MANAGEMENT/subnetName, which the Function App itself uses and
// which is delegated to Microsoft.App/environments). ONE role definition,
// TWO assignments at two different scopes — see
// modules/imageBuildNetworkRole.bicep's header comment for why this is a
// single module invocation (not two) and why the subnet-scoped assignment
// is narrower than the RG-AVD-Images one.
module rbacImageBuildNetwork 'modules/imageBuildNetworkRole.bicep' = {
  name: 'rbacImageBuildNetworkDeploy'
  scope: resourceGroup(networkResourceGroup)
  params: {
    environmentName: environmentName
    principalId: functionApp.outputs.principalId
    rgNetworkName: networkResourceGroup
    rgImagesName: rgImages
    vnetName: vnetName
    subnetName: imageBuildSubnetName
  }
}

// AM-50: custom least-privilege role for the guided session-host
// provisioning wizard's Microsoft.Compute writes (create the session-host
// VM, apply its three extensions) — see
// modules/sessionHostProvisionerRole.bicep for the full rationale and
// blast-radius account. Scoped to RG-AVD-HostPools, the SAME resource group
// as rbacSessionHostWriter/rbacVmPowerOperator/rbacRolloutOperator above —
// The session-host VMs (existing and new) all live there.
module rbacSessionHostProvisioner 'modules/sessionHostProvisionerRole.bicep' = {
  name: 'rbacSessionHostProvisionerDeploy'
  scope: resourceGroup(rgHostPools)
  params: {
    environmentName: environmentName
    principalId: functionApp.outputs.principalId
  }
}

// AM-50: custom least-privilege role for the guided session-host
// provisioning wizard's Microsoft.Network writes — creating the new
// session host's NIC (RG-AVD-HostPools) and joining it to the EXISTING
// SNET-SESSIONHOSTS subnet (RG-AVD-Network). ONE role definition, TWO
// assignments at two different scopes — see
// modules/sessionHostSubnetRole.bicep's header comment for why this
// mirrors modules/imageBuildNetworkRole.bicep's exact two-scope pattern.
module rbacSessionHostSubnet 'modules/sessionHostSubnetRole.bicep' = {
  name: 'rbacSessionHostSubnetDeploy'
  scope: resourceGroup(networkResourceGroup)
  params: {
    environmentName: environmentName
    principalId: functionApp.outputs.principalId
    rgNetworkName: networkResourceGroup
    rgHostPoolsName: rgHostPools
    vnetName: vnetName
    subnetName: sessionHostSubnetName
  }
}

// Plain Reader stays resource-group-scoped (RG-AVD-Monitoring) — unchanged
// by the narrowing below, and not itself the concern that narrowing
// addresses (Reader alone grants no LAW query rights at all; see
// rbac.bicep's header comment).
module rbacMonitoring 'modules/rbac.bicep' = {
  name: 'rbacMonitoringDeploy'
  scope: resourceGroup(logAnalyticsResourceGroup)
  params: {
    principalId: functionApp.outputs.principalId
    roleDefinitionIds: [readerRoleDefinitionId, costManagementReaderRoleDefinitionId]
  }
}

// AM-25 originally granted RG-AVD-Management Cost Management Reader ONLY
// (this RG hosts this app itself — see the gap register
// item 2 — and app/api read no other ARM resource here at the time).
// AM-16 (M3b) ADDS plain Reader too: the governance panel's orphaned/
// untagged-resource scanner (app/api/src/services/governance/
// orphanedResources.ts) generically lists every resource across all six
// tracked RGs — a read Cost Management Reader's Microsoft.Consumption/
// Microsoft.CostManagement actions do NOT cover
// (Microsoft.Resources/subscriptions/resourceGroups/resources/read is a
// separate action, part of plain Reader's "*/read", not of Cost Management
// Reader's narrower action set).
module rbacManagement 'modules/rbac.bicep' = {
  name: 'rbacManagementDeploy'
  scope: resourceGroup(rgManagement)
  params: {
    principalId: functionApp.outputs.principalId
    roleDefinitionIds: [readerRoleDefinitionId, costManagementReaderRoleDefinitionId]
  }
}

// AM-25 originally granted RG-AVD-Network Cost Management Reader ONLY (cost
// attribution; app/api read no other ARM resource here at the time). AM-16
// (M3b) ADDS plain Reader: the governance panel's private-endpoint-health
// check (app/api/src/services/governance/privateEndpoints.ts) and the
// orphaned-resource scanner's private-DNS-zone/subnet/NIC/public-IP
// sub-scans all read RG-AVD-Network resources for the first time — same
// "Cost Management Reader doesn't cover generic resource reads" reasoning
// as rbacManagement above.
module rbacNetwork 'modules/rbac.bicep' = {
  name: 'rbacNetworkDeploy'
  scope: resourceGroup(rgNetwork)
  params: {
    principalId: functionApp.outputs.principalId
    roleDefinitionIds: [readerRoleDefinitionId, costManagementReaderRoleDefinitionId]
  }
}

// AM-25 originally granted RG-AVD-Storage Cost Management Reader ONLY at RG
// scope (Cost Management's Query API does not support single-resource
// scope — see Microsoft's "Understand and work with scopes" page) plus a
// SEPARATE resource-scoped plain Reader on the storage account specifically
// (rbacFslogixStorageAccountReader below, for fslogixService.ts's
// fileShares.get(expand=stats) call). AM-16 (M3b) ADDS RG-scoped plain
// Reader too: the governance panel's orphaned-resource scanner lists every
// resource in this RG generically (not just the one storage account the
// existing resource-scoped grant covers) — same "Cost Management Reader
// doesn't cover generic resource reads" reasoning as rbacManagement/
// rbacNetwork above. This does NOT make rbacFslogixStorageAccountReader
// redundant — that grant predates this story and stays as documentation of
// the narrower, single-resource need fslogixService.ts actually has.
module rbacStorage 'modules/rbac.bicep' = {
  name: 'rbacStorageDeploy'
  scope: resourceGroup(rgStorage)
  params: {
    principalId: functionApp.outputs.principalId
    roleDefinitionIds: [readerRoleDefinitionId, costManagementReaderRoleDefinitionId]
  }
}

// AM-16 (M3b), NARROWED per peer review item 11: Reader scoped to the
// KEY VAULT RESOURCE ITSELF (KV-AVD-CONTOSO), not the whole RG-AVD-Security
// resource group — mirrors rbacFslogixStorageAccountReader's exact
// resource-scoped pattern below (see modules/keyVaultReaderRole.bicep's
// header comment for the full rationale). An earlier version of this
// story granted RG-scoped Reader here; narrowed because
// app/api/src/services/governance/keyVaultPurgeProtection.ts only ever
// reads ONE resource in this RG (KV-AVD-CONTOSO's own control-plane
// properties) — RG-AVD-Security could host additional secrets/
// certificates-bearing resources in the future this app has no reason to
// see. This RG was PREVIOUSLY excluded entirely — see infra/modules/
// rbac.bicep's header comment, updated by this story — because nothing
// here read it before AM-16's Key Vault purge-protection check.
module rbacSecurity 'modules/keyVaultReaderRole.bicep' = {
  name: 'rbacSecurityDeploy'
  scope: resourceGroup(rgSecurity)
  params: {
    principalId: functionApp.outputs.principalId
    keyVaultName: keyVaultName
  }
}

// AM-25 peer review item 13: Reader for fslogixService.ts's
// fileShares.get(expand=stats) call is scoped to the STORAGE ACCOUNT
// resource itself, not the whole RG-AVD-Storage resource group — see
// modules/storageAccountReaderRole.bicep's header comment for why that
// needs its own module (a direct resource declaration here can't have a
// scope different from this file's own targetScope — BCP139 — and can't
// reference functionApp.outputs.principalId in a role assignment's `name:`
// either — BCP120; both are exactly why rbac.bicep already uses the
// module + caller-side `scope:` redirection pattern for every other grant
// in this file).
module rbacFslogixStorageAccountReader 'modules/storageAccountReaderRole.bicep' = {
  name: 'rbacFslogixStorageAccountReaderDeploy'
  scope: resourceGroup(rgStorage)
  params: {
    principalId: functionApp.outputs.principalId
    storageAccountName: avdStorageAccountName
  }
}

// AM-13 (M5): DATA-PLANE grant for the Profiles page's OAuth FileREST
// calls (list/reset-by-rename/list-handles against stcontoso001) —
// distinct from, and additional to, rbacFslogixStorageAccountReader above
// (that one is a control-plane Reader grant fslogixService.ts's share-stats
// call needs; this one is the data-plane role FileREST itself needs). See
// modules/fslogixDataPlaneRole.bicep's header comment for the full "why
// Privileged Contributor specifically" reasoning and the Microsoft Learn
// citation for the role GUID.
module rbacFslogixDataPlane 'modules/fslogixDataPlaneRole.bicep' = {
  name: 'rbacFslogixDataPlaneDeploy'
  scope: resourceGroup(rgStorage)
  params: {
    principalId: functionApp.outputs.principalId
    storageAccountName: avdStorageAccountName
  }
}

// AM-24 peer review (MAJOR 3b): Log Analytics Reader narrowed from
// RG-AVD-Monitoring (resource-group) scope down to the LAW-CONTOSO-PROD
// workspace RESOURCE itself. At RG scope, the grant would have let a query
// reach EVERY Log Analytics workspace ever deployed into that resource
// group, not just this one (verified on Learn — "Resource: Access to only
// the specified workspace" vs "Resource group: Access to all workspaces in
// the resource group",
// https://learn.microsoft.com/azure/azure-monitor/logs/manage-access#azure-rbac).
// A dedicated module (modules/logAnalyticsWorkspaceRbac.bicep) rather than
// an inline `resource` here — see that file's header comment for why (a
// role assignment's `name` can't depend on functionApp.outputs.principalId
// directly at this scope — BCP120 — and the cross-RG redirection needs the
// module-invocation `scope:` mechanism — BCP139 — same as every other
// rbac*.bicep module below).
//
// What this narrowing does NOT eliminate — documented honestly rather than
// claimed away, per peer review — see
// app/api/src/lib/logsGuard.ts's SECURITY POSTURE comment for the full
// account:
//   - This app's own Application Insights is workspace-based (see
//     functionapp.bicep's `appInsights` resource, WorkspaceResourceId set
//     to this same LAW), so its telemetry lives in LAW-CONTOSO-PROD too —
//     narrowing the grant to "just this workspace" does not narrow it to
//     "just the AVD diagnostics tables" within that workspace.
//   - The plain-Reader grants on RG-AVD-HostPools/RG-AVD-Images above give
//     KQL's `resource()` function a residual, narrower cross-reach into
//     Monitor Logs for resources in THOSE resource groups — a property of
//     those other grants, not of this Log Analytics Reader assignment,
//     and not something this narrowing was meant to (or does) address.
module rbacLogAnalyticsReaderOnWorkspace 'modules/logAnalyticsWorkspaceRbac.bicep' = {
  name: 'rbacLogAnalyticsReaderOnWorkspaceDeploy'
  scope: resourceGroup(logAnalyticsResourceGroup)
  params: {
    workspaceName: logAnalyticsWorkspaceName
    principalId: functionApp.outputs.principalId
    roleDefinitionId: logAnalyticsReaderRoleDefinitionId
  }
}

// AM-48: IMAGE_BUILD_STUCK + IMAGE_BUILD_CLEANUP_SELFHEAL alert rules (see
// infra/modules/alerting.bicep's header comment for the full design
// rationale). Deployed with `scope: resourceGroup(logAnalyticsResourceGroup)`
// — same cross-RG redirection every other Log-Analytics-workspace-scoped
// module invocation in this file already uses (rbacMonitoring/
// rbacLogAnalyticsReaderOnWorkspace above) — because both scheduledQueryRules
// resources are scoped to the LAW-CONTOSO-PROD workspace resource, which lives
// in that resource group, not this file's own deployment scope.
module imageBuildAlerting 'modules/alerting.bicep' = {
  name: 'imageBuildAlertingDeploy'
  scope: resourceGroup(logAnalyticsResourceGroup)
  params: {
    location: location
    tags: commonTags
    environmentName: environmentName
    logAnalyticsWorkspaceId: logAnalyticsWorkspaceId
    appInsightsResourceId: functionApp.outputs.appInsightsResourceId
    alertEmailAddress: alertEmailAddress
  }
}

// Conditional-module output: when deployStaticWebApp is false (dev), the
// module is skipped and its outputs don't exist — the ternary guards that.
output staticWebAppHostname string = (deployStaticWebApp && !empty(staticWebAppName)) ? staticWebApp!.outputs.defaultHostname : ''
output functionAppName string = functionApp.outputs.name
output functionAppPrincipalId string = functionApp.outputs.principalId
