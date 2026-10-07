// Function App module — Flex Consumption (FC1).
//
// Switched from Elastic Premium (EP1) to Flex Consumption: the target
// subscription has 0 App Service VM quota in eastus
// (SubscriptionIsOverQuotaForSku, Total VMs limit 0), which made EP1
// impossible to deploy. Flex Consumption does not draw on that VM quota
// (it's a serverless, instance-pool-managed SKU) and still supports VNet
// integration, so it meets the same networking requirements EP1 was chosen
// for. Flex has no deployment-slot concept — see the removed `stagingSlot`
// resource note near the bottom of this file, and docs/app-registration.md
// DEPLOY-PREREQS for the CI-side consequence.
//
// Followed Microsoft Learn's flex-consumption-plan pivot of
// "Automate resource deployment for your function app in Azure Functions"
// (https://learn.microsoft.com/azure/azure-functions/functions-infrastructure-as-code,
// ARM template tab — the raw Microsoft.Web/sites properties shape, since
// the article's Bicep tab uses the AVM `br/public:avm/res/web/site` module
// rather than a raw resource, which this file uses instead) for the exact
// functionAppConfig/scaleAndConcurrency/runtime shape and the
// AzureWebJobsStorage__accountName identity-based host storage setting.
//
// Hosts app/api. System-assigned managed identity + VNet integration into the
// existing AVD management subnet (outbound) so the API can reach
// private-linked resources and call ARM with least-privilege RBAC (see
// rbac.bicep) instead of stored credentials.
//
// INBOUND: ipSecurityRestrictions is parameterized (see
// ipSecurityRestrictionsDefaultAction + allowedInboundIpRanges below)
// because VNet integration is outbound-only and does not by itself protect
// the public HTTPS endpoint. For the prod deployment the default action is
// 'Allow', NOT the original deny-all posture: this Function App is an SWA
// linked backend, and Microsoft's BYO-functions security constraints
// (https://learn.microsoft.com/azure/static-web-apps/functions-bring-your-own#security-constraints)
// require linked backends NOT to restrict inbound IPs — the enforcing
// control is instead the "Azure Static Web Apps (Linked)" Easy Auth
// identity provider the linking process auto-creates on this app (verified
// enabled on func-example-prod 2026-08-15: platform.enabled=true, AAD
// provider on, unauthenticatedClientAction=RedirectToLoginPage — direct
// anonymous calls are rejected by the platform auth layer). The deny +
// allowlist posture remains available via the params for any future
// deployment of this module that is not SWA-fronted.
param location string
param functionAppName string
param tags object = {}

@description('Resource ID of the existing subnet to VNet-integrate the Function App into. MUST already be delegated to Microsoft.App/environments — the Flex Consumption requirement, NOT the Microsoft.Web/serverFarms delegation other plan types use (the real deploy failed with SubnetMissingRequiredDelegation until re-delegated; see docs/app-registration.md DEPLOY-PREREQS 0.1). Outbound only.')
param subnetId string

@description('Node.js major version for the Flex Consumption runtime (functionAppConfig.runtime.version) — Flex has no linuxFxVersion siteConfig property; the runtime is declared here instead.')
// AM-25 peer review item 4: bumped from '20' to '22'. Two independent
// reasons converged: (1) @azure/arm-costmanagement@1.0.0 and
// @azure/arm-storage@20.1.0 (both added for the cost dashboard) declare
// "engines": { "node": ">=22.0.0" } in their package.json — running them
// under Node 20 is unsupported, not just untested; (2) verified on
// Microsoft Learn ("Azure Functions Flex Consumption plan hosting" —
// Supported language stack versions): Flex Consumption's Node.js support
// is now Node.js 22 and Node.js 24 ONLY — Node 20 is no longer a supported
// Flex Consumption runtime at all (Node 20 remained supported on the
// classic Linux Consumption plan for longer, per Microsoft's
// "Compare Azure Functions runtime versions" note, but that's not the plan
// this app uses — see infra/modules/functionapp.bicep's own header comment
// on why Flex Consumption was chosen). Both reasons point the same
// direction, so this bump has no real alternative — pinning the SDKs back
// to older, Node-20-compatible versions was considered and rejected: Cost
// Management's arm-costmanagement 1.0.0 is the current GA release with no
// older Node-20-compatible major to pin to instead. See
// .github/workflows/*.yml's NODE_VERSION and app/README.md's prerequisites
// for the matching bump — CI now builds/tests against Node 22 too.
param nodeVersion string = '22'

@description('Maximum function app instance count for Flex Consumption scale-out (functionAppConfig.scaleAndConcurrency.maximumInstanceCount).')
param maximumInstanceCount int = 40

@description('Per-instance memory in MB for Flex Consumption (functionAppConfig.scaleAndConcurrency.instanceMemoryMB). Valid Flex Consumption instance sizes are 2048 and 4096.')
param instanceMemoryMB int = 2048

@description('Whether the Function App is reachable over its public endpoint at all. Must stay Enabled while SWA-fronted: the M1 deploy established that linked backends cannot use inbound private endpoints or IP restrictions (see ipSecurityRestrictionsDefaultAction) — exclusive access comes from the linked Easy Auth provider.')
@allowed(['Enabled', 'Disabled'])
param publicNetworkAccess string = 'Enabled'

@description('CIDR ranges allowed to reach the Function App over its public endpoint. Only meaningful when ipSecurityRestrictionsDefaultAction is Deny — for the SWA-linked prod deployment the default action is Allow and this stays empty (see that param).')
param allowedInboundIpRanges array = []

@description('Default action for ipSecurityRestrictions. Deny + allowedInboundIpRanges is the locked-down posture for a non-SWA-fronted Function App. For an SWA linked backend this MUST be Allow: Microsoft\'s BYO-functions security constraints (https://learn.microsoft.com/azure/static-web-apps/functions-bring-your-own#security-constraints) require linked backends not to restrict inbound IPs — exclusive access is enforced by the "Azure Static Web Apps (Linked)" Easy Auth identity provider the linking process creates on the app.')
@allowed(['Allow', 'Deny'])
param ipSecurityRestrictionsDefaultAction string = 'Deny'

@secure()
@description('Shared secret checked by app/api/src/lib/auth.ts#verifyBackendSecret ONLY when REQUIRE_BACKEND_SECRET=true (default false — see that param). No default — must be supplied at deploy time regardless, since the Function App setting must exist for the day this is turned on. TODO(AM-9): source from Key Vault reference instead of a plain secure param.')
param swaBackendSecret string

@description('Gates app/api/src/lib/auth.ts#verifyBackendSecret. Default false: SWA linked-backend request forwarding only injects x-ms-client-principal — it does not forward any custom header — so there is no real sender for x-swa-backend-secret today, and requiring it would 401 every request including the platform own /api/roles login call. The real controls are x-ms-client-principal validation and the "Azure Static Web Apps (Linked)" Easy Auth provider (in prod the ipSecurityRestrictions default action is Allow — see that param). Set true only once a sender for this header actually exists (e.g. a future non-SWA caller).')
param enforceSharedHeaderCheck string = 'false'

// --- AVD resource references consumed by app/api/src/lib/config.ts ---
param subscriptionId string
param rgHostPools string
param hostPoolName string
param workspaceName string
param dagName string
param rgImages string
param galleryName string

@description('Name of the existing gallery image definition within galleryName.')
param imageDefinitionName string = 'WIN11-ENT-MS-M365'

@description('FALLBACK ONLY (YYYY-MM-DD): app/api/src/services/imagesService.ts reads the EOL date from the gallery image version own publishingProfile.endOfLifeDate field first (the SDK/ARM already has this); this value is only used if that field is absent on the version. Empty here, with the SDK field also absent, means the Dashboard shows "not configured" instead of a countdown.')
param imageEolDate string = ''

param avdStorageAccountName string
param fslogixShareName string

// --- AM-25: cost dashboard additions ---
@description('Resource group containing the existing RG-AVD-Management (this app itself — see the gap register item 2) — read by costService.ts to attribute spend to it.')
param rgManagement string = 'RG-AVD-Management'

@description('Resource group containing the existing AVD management VNet/NSGs/private endpoints — read by costService.ts to attribute spend to it. May equal networkResourceGroup at the caller (main.bicep), but kept as its own param here since this module has no other reason to know that name.')
param rgNetwork string = 'RG-AVD-Network'

@description('Resource group containing avdStorageAccountName (the FSLogix profile storage account) — needed both by costService.ts (cost attribution) and fslogixService.ts (Microsoft.Storage/storageAccounts/fileServices/shares Get with expand=stats).')
param rgStorage string = 'RG-AVD-Storage'

// --- AM-16 (M3b): Governance & security posture panel additions ---
@description('Resource group containing the existing Key Vault — read by app/api/src/services/governance/keyVaultPurgeProtection.ts.')
param rgSecurity string = 'RG-AVD-Security'

@description('Name of the existing Key Vault whose purge-protection setting the governance panel reads.')
param keyVaultName string

@description('Entra ID object ID of this estate\'s break-glass group/account — see app/api/src/lib/config.ts governance.breakGlassGroupId doc comment. Empty = the CA-policy-exclusion check degrades to its "not configured" state.')
param breakGlassGroupId string = ''

@description('Name of the existing VNet the orphan/hygiene scanner (app/api/src/services/governance/orphanedResources.ts) reads subnets from — peer review item 5: config-driven rather than hard-coded, so a renamed VNet 404s loudly instead of silently reading as "no empty subnets."')
param vnetNameForGovernance string

@description('Comma-separated required tag KEYS the untagged-resource sub-scan (governance panel) checks for. Empty (default) = no tag policy configured — that sub-scan reports it as informational, not findings. See app/api/src/lib/config.ts governance.requiredTags doc comment.')
param requiredTags string = ''

@description('Expected count of private endpoints in RG-AVD-Network — peer review item 16, config-driven rather than hard-coded 5. See app/api/src/services/governance/privateEndpoints.ts.')
param expectedPrivateEndpointCount int = 5

@description('AM-56 — comma-separated Entra object ids expected to hold Storage File Data Privileged Contributor on the FSLogix storage account (see app/api/src/services/governance/storagePrivilegedAccess.ts). Empty = "not configured" — that check degrades to \'unknown\' with configure-guidance rather than guessing a baseline. main.bicep composes this from its own privilegedStorageBaselinePrincipalId/privilegedStorageBaselineExtraPrincipalIds params.')
param privilegedStorageBaselinePrincipalIds string = ''

@description('AM-56 — comma-separated expected Microsoft.Authorization/locks CanNotDelete names on RG-AVD-Storage / its storage account (see app/api/src/services/governance/storageDeleteLocks.ts). Empty (default) lets app/api/src/lib/config.ts fall back to the three documented names (the FSLogix storage runbook lines 344-345).')
param expectedStorageLockNames string = ''

@description('Resource group of the existing Log Analytics workspace used for Application Insights workspace-based ingestion and for LAW_WORKSPACE_ID.')
param logAnalyticsResourceGroup string

@description('Name of the existing Log Analytics workspace.')
param logAnalyticsWorkspaceName string

@description('Entra ID object ID of the AVDMGR-Viewers group. Empty = nobody gets that role from the roles function until group provisioning has run.')
param groupIdViewer string = ''

@description('Entra ID object ID of the AVDMGR-Operators group.')
param groupIdOperator string = ''

@description('Entra ID object ID of the AVDMGR-Admins group.')
param groupIdAdmin string = ''

// --- AM-27 (M4-S2): golden image build orchestration ---
@description('ARM resource id of the existing, DEDICATED (non-delegated) subnet the build VM\'s NIC joins — see app/api/src/services/imageBuildOrchestrator.ts and infra/modules/imageBuildNetworkRole.bicep. NEVER the Function App\'s own SNET-MANAGEMENT subnet (`subnetId` above) — that one is delegated to Microsoft.App/environments and cannot host a VM NIC (Opus review BLOCKER 2). Passed as a resource id (not name+vnet) — main.bicep resolves the dedicated subnet via its own `existingImageBuildSubnet` reference.')
param imageBuildSubnetId string = ''

@description('Default VM size for a golden-image build VM (overridable per-build via the wizard) — see the golden-image runbook §4.1\'s sizing note.')
param imageBuildVmSize string = 'Standard_D4ads_v7'

@description('Azure region the build VM/snapshot/gallery image version are created in — MUST match the gallery\'s own region (see app/api/src/lib/config.ts\'s imageBuild.location doc comment).')
param imageBuildLocation string = 'eastus'

@description('AM-13 (M5): profiles at or above this size (GiB) are flagged oversized on the Profiles page — see app/api/src/lib/config.ts profiles.oversizedGb doc comment. No documented threshold exists anywhere in the runbooks today, hence a tunable app setting rather than a hard-coded value.')
param fslogixOversizedGb int = 5

@description('AM-13 (M5): Entra ID object ID of the AVD-Users group (the same cloud-only group the FSLogix storage runbook §4 documents as holding Storage File Data SMB Share Contributor) — used by the Profiles page\'s orphan-detection cross-check (Graph GroupMember.Read.All). Empty = that check degrades to its "not configured" state, distinct from the separate "Graph permission not granted" degradation. See app/api/src/services/fslogixProfilesService.ts.')
param avdUsersGroupId string = ''

// --- AM-50: guided session-host provisioning ---
@description('Name of the existing SNET-SESSIONHOSTS subnet every session host\'s NIC joins, including new ones the guided provisioning wizard creates — see app/api/src/lib/config.ts\'s sessionHostProvision.subnetId doc comment for why this is a NAME (config computes the resource id itself), unlike imageBuildSubnetId above (passed pre-resolved).')
param sessionHostSubnetName string = 'SNET-SESSIONHOSTS'

param apiVersion string = '1.0.0'

var hostingPlanName = '${functionAppName}-plan'
// Storage account names must be globally unique across ALL Azure tenants
// (not just this subscription), so a deterministic name derived only from
// functionAppName (e.g. "stfuncavdmgrprodfn") risks colliding with an
// unrelated customer's account. uniqueString(resourceGroup().id) adds a
// stable (same RG -> same suffix on every re-deploy, so this is still
// idempotent) 13-char hash to make collision practically impossible.
// Resulting name looks like "stexampleprod<uniqueString>".
var functionsStorageAccountName = take(toLower('st${replace(replace(functionAppName, 'func-', ''), '-', '')}${uniqueString(resourceGroup().id)}'), 24)
var appInsightsName = '${functionAppName}-ai'

// Flex Consumption deployment package container — must exist before the
// function app resource is created (see the deploymentContainer resource
// below and functionAppConfig.deployment.storage, which points at it).
var deploymentStorageContainerName = toLower('${functionAppName}-deploy')

// AM-18 (M2-S1): audit log table, on this SAME functions storage account
// (not the FSLogix account — see the storage/audit param comments below).
// A hardcoded var, not a param: it's an internal implementation detail of
// this module (mirrors deploymentStorageContainerName's treatment above),
// not something a caller should be choosing per-environment.
var auditTableName = 'AuditLog'

// AM-24: ack/snooze state table — same "internal implementation detail, not
// a caller-facing param" treatment as auditTableName above.
var alertStateTableName = 'AlertState'

// AM-23 (M3-S1): emergency-override state table (see
// app/api/src/services/scalingOverrideService.ts), on the SAME functions
// storage account as auditTableName above — same "internal implementation
// detail, not a per-environment caller choice" rationale.
var scalingOverrideTableName = 'ScalingOverride'

// AM-28 (M4-S3): staged rollout plan state table (see
// app/api/src/services/rolloutPlanService.ts), on the SAME functions storage
// account as auditTableName above — same "internal implementation detail,
// not a per-environment caller choice" rationale.
var rolloutTableName = 'RolloutPlan'

// AM-27 (M4-S2): golden image build state machine table (see
// app/api/src/services/imageBuildService.ts) — same "internal
// implementation detail" rationale as the two tables above.
var imageBuildTableName = 'ImageBuild'

// AM-50: guided session-host provisioning state machine table (see
// app/api/src/services/sessionHostProvisionService.ts) — same "internal
// implementation detail" rationale as the tables above.
var sessionHostProvisionTableName = 'SessionHostProvision'

var logAnalyticsWorkspaceId = resourceId(logAnalyticsResourceGroup, 'Microsoft.OperationalInsights/workspaces', logAnalyticsWorkspaceName)

// Cross-RG existing-resource reference so this module can read the
// workspace's own `customerId` (its "Workspace ID" GUID, shown on the
// workspace's Agents/overview blade) at deploy time — see
// app/api/src/lib/config.ts's logAnalyticsWorkspaceGuid doc comment for why
// this is a DIFFERENT value from logAnalyticsWorkspaceId above (that's the
// ARM resource path; @azure/monitor-query-logs's LogsQueryClient.
// queryWorkspace() needs the customerId GUID instead). Resolving it here
// means app/api never needs its own ARM call (and therefore no extra RBAC)
// just to look this value up — same reasoning as LAW_WORKSPACE_ID's
// existing resourceId() usage above. Published as the LAW_WORKSPACE_GUID
// app setting below; consumed by app/api/src/services/hostRuntimeService.ts
// (AM-25) and app/api/src/services/logsService.ts (AM-24). Same api version
// as infra/modules/logAnalyticsWorkspaceRbac.bicep's existing-resource
// reference to the same workspace.
resource existingLogAnalyticsWorkspace 'Microsoft.OperationalInsights/workspaces@2022-10-01' existing = {
  name: logAnalyticsWorkspaceName
  scope: resourceGroup(logAnalyticsResourceGroup)
}

// Allowlist layered on top of ipSecurityRestrictionsDefaultAction — it only
// takes effect when that param is 'Deny' (non-SWA-fronted posture). In the
// SWA-linked prod deployment the default action is 'Allow' and this is empty.
var ipSecurityRestrictions = [for (ipRange, i) in allowedInboundIpRanges: {
  ipAddress: ipRange
  action: 'Allow'
  priority: 100 + i
  name: 'allow-${i}'
}]

// allowSharedKeyAccess: false — Flex Consumption's host storage connection
// (AzureWebJobsStorage__accountName below) and the deployment package
// container (functionAppConfig.deployment.storage) both use the Function
// App's system-assigned managed identity, not an account key. Per
// Microsoft's guidance, this is safe (and recommended) for Flex Consumption
// specifically — unlike Elastic Premium/Consumption plans, Flex doesn't
// depend on Azure Files (WEBSITE_CONTENTAZUREFILECONNECTIONSTRING /
// WEBSITE_CONTENTSHARE), which is the thing that forces shared-key access
// to stay enabled on those other plans.
resource storageAccount 'Microsoft.Storage/storageAccounts@2023-01-01' = {
  name: functionsStorageAccountName
  location: location
  tags: tags
  sku: {
    name: 'Standard_LRS'
  }
  kind: 'StorageV2'
  properties: {
    minimumTlsVersion: 'TLS1_2'
    allowBlobPublicAccess: false
    allowSharedKeyAccess: false
  }
}

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-01-01' = {
  parent: storageAccount
  name: 'default'
}

resource deploymentContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-01-01' = {
  parent: blobService
  name: deploymentStorageContainerName
}

// AM-18 (M2-S1): AuditLog table — written by app/api/src/lib/auditLog.ts
// (via @azure/data-tables + DefaultAzureCredential, same secretless model as
// avdService.ts's ARM client) on every mutating request. tableServices is a
// required intermediate child resource (same pattern as blobServices above)
// before an individual table can be declared under it. AM-24 adds a second
// table (AlertState, below) as a sibling under this same tableService —
// both live in this one FUNCTIONS storage account.
resource tableService 'Microsoft.Storage/storageAccounts/tableServices@2023-01-01' = {
  parent: storageAccount
  name: 'default'
}

// No retention/lifecycle policy is set on this table (rows accumulate
// indefinitely). Deliberately deferred — Azure Table Storage has no native
// per-table TTL; a retention policy here would mean either a scheduled
// purge function or moving old rows to cool/archive storage, and neither is
// in scope for M2-S1. Revisit once real audit volume is observed.
resource auditLogTable 'Microsoft.Storage/storageAccounts/tableServices/tables@2023-01-01' = {
  parent: tableService
  name: auditTableName
}

// AM-24: ack/snooze app state (app/api/src/lib/alertState.ts), a second
// table on this same account/tableService — see the
// storageTableDataContributorAssignment comment below for the RBAC that
// already covers both tables (grant is account-scoped, not per-table).
resource alertStateTable 'Microsoft.Storage/storageAccounts/tableServices/tables@2023-01-01' = {
  parent: tableService
  name: alertStateTableName
}

// AM-23 (M3-S1): single-row emergency-override state (see
// app/api/src/services/scalingOverrideService.ts) — same tableService
// parent as auditLogTable above, no separate RBAC grant needed (the
// storageTableDataContributorAssignment below is scoped to the whole
// storage account, not one table).
resource scalingOverrideTable 'Microsoft.Storage/storageAccounts/tableServices/tables@2023-01-01' = {
  parent: tableService
  name: scalingOverrideTableName
}

// AM-28 (M4-S3): rollout plan state (see
// app/api/src/services/rolloutPlanService.ts) — same tableService parent as
// auditLogTable above, no separate RBAC grant needed (same rationale as
// scalingOverrideTable's comment: storageTableDataContributorAssignment
// below is scoped to the whole storage account, not one table).
resource rolloutTable 'Microsoft.Storage/storageAccounts/tableServices/tables@2023-01-01' = {
  parent: tableService
  name: rolloutTableName
}

// AM-27 (M4-S2): the ImageBuild state-machine table (see
// app/api/src/services/imageBuildService.ts) — same tableService parent as
// the three tables above, same account-scoped RBAC grant (no new role
// assignment needed).
resource imageBuildTable 'Microsoft.Storage/storageAccounts/tableServices/tables@2023-01-01' = {
  parent: tableService
  name: imageBuildTableName
}

// AM-50: the SessionHostProvision state-machine table (see
// app/api/src/services/sessionHostProvisionService.ts) — same tableService
// parent as the tables above, same account-scoped RBAC grant (no new role
// assignment needed).
resource sessionHostProvisionTable 'Microsoft.Storage/storageAccounts/tableServices/tables@2023-01-01' = {
  parent: tableService
  name: sessionHostProvisionTableName
}

// ALERTING TODO (peer review — AM-23 MINOR 14): this app's mutating
// handlers emit several distinct, greppable log-line MARKERS into this
// Application Insights instance (via context.error/context.warn — see
// app/api/src/lib/auditLog.ts and app/api/src/functions/scalingEmergencyOverride.ts/
// scalingOverrideReEnable.ts) that a Log Analytics alert rule SHOULD target.
// AM-48 landed the FIRST two (IMAGE_BUILD_STUCK and
// IMAGE_BUILD_CLEANUP_SELFHEAL — see infra/modules/alerting.bicep, wired
// from main.bicep) as Microsoft.Insights/scheduledQueryRules resources; the
// remaining markers below are still DEFERRED — not part of that story
// either — but, same as before, they already exist and are stable, so
// wiring each one up is additive, not a rework. The markers to alert on:
//   - AUDIT_WRITE_FAILED       — an audit row failed to persist (the
//                                mutation it describes may have already
//                                succeeded in Azure with no durable record).
//   - SCALING_OVERRIDE_STRANDED — emergency-override activation disabled
//                                autoscale in ARM, then failed to persist
//                                its expiry AND failed to roll the ARM
//                                change back — autoscale is left disabled
//                                with no automatic path to re-enable it.
//                                Treat as a page-worthy incident.
//   - repeated auto-re-enable failures — scalingOverrideReEnable.ts's timer
//                                logs `scalingOverrideReEnable — ARM
//                                re-enable failed` on every failing tick
//                                (at most 5 minutes apart) even though it
//                                only writes ONE audit row per stuck episode
//                                (see ScalingOverrideEntity.reEnableFailureAudited) —
//                                an alert rule counting these context.error
//                                lines over a window (e.g. 3+ in 30 minutes)
//                                would catch a persistently-stuck override
//                                a single audit row alone would under-represent.
//   - ROLLOUT_SENTINEL_CLEANUP_FAILED — AM-28: the one-active-plan-per-
//                                host-pool sentinel row (see
//                                rolloutPlanService.ts#deleteActiveSentinel)
//                                failed to delete after a plan reached a
//                                terminal state — the plan itself finished
//                                correctly, but the host pool is left
//                                unable to start a NEW rollout plan until
//                                this stray row is cleared manually. Not an
//                                emergency, but should page/ticket within a
//                                business day so the next legitimate
//                                rollout isn't blocked.
//   - rollout state-write-failed responses — rolloutPlans.ts's
//                                handleStart/handleRemoveHosts/
//                                handleRollback each log a distinct
//                                context.error line (containing "state
//                                write failed after ARM ... already
//                                applied") when an ACHIEVED, IRREVERSIBLE
//                                ARM mutation (drain, deregister, VM
//                                delete, un-drain) could not be persisted
//                                to the plan's Table row even after
//                                rolloutPlanService.ts#persistWithMergeRetry's
//                                bounded retries — the audit row for that
//                                mutation was still written (see that
//                                function's BLOCKER-fix doc comment), so
//                                this is a "reconcile the Table row"
//                                incident, not a lost-audit one, but should
//                                still be treated as page-worthy: an admin
//                                needs to reload/retry the same rollout
//                                action promptly.
//   - ROLLOUT_TIMER_AUDIT_MISCONFIGURED — rolloutPlanTimer.ts's fail-closed
//                                check (mirrors AUDIT_MISCONFIGURED on the
//                                HTTP handlers) tripped — the timer is
//                                skipping EVERY rollout plan's automatic
//                                advance until AUDIT_STORAGE_ACCOUNT_NAME is
//                                fixed. Any in-flight rollout stalls in
//                                draining_old/awaiting_new_hosts/
//                                validating_new until this is resolved.
//   - IMAGE_BUILD_STUCK        — AM-27 (M4-S2, Opus review MAJOR 12): the
//                                1-minute image-build timer (imageBuildTimer.ts)
//                                or an operator-gate advance
//                                (imageBuilds.ts) hit an unexpected state-
//                                machine or ARM error while advancing a
//                                build — logged via this marker AND a
//                                failure-outcome audit row
//                                (image.build.timer_advance /
//                                image.build.advance). Unlike a normal
//                                "still waiting on Azure" tick (which
//                                persists nothing and logs nothing), this
//                                marker means a build genuinely stopped
//                                making progress — treat as a page-worthy
//                                incident, since a build VM left running
//                                unattended is a real, ongoing cost.
//                                COVERED (AM-48): infra/modules/alerting.bicep's
//                                imageBuildStuckAlert fires on 3+ occurrences
//                                for the same buildId within 15 minutes.
//   - IMAGE_BUILD_CLEANUP_SELFHEAL — AM-48: imageBuildOrchestrator.ts's
//                                pollCleanup (via logCleanupSelfHeal) logs
//                                this whenever the AM-46 dependency-ordered
//                                cleanup path re-submits a previously-FAILED
//                                delete_build_vm/delete_build_nic/
//                                delete_build_disk step. Informational, not
//                                an incident — the self-heal working as
//                                designed. COVERED (AM-48):
//                                infra/modules/alerting.bicep's
//                                imageBuildCleanupSelfHealAlert fires (low
//                                severity) on any occurrence within a
//                                1-hour window.
//   - SESSION_HOST_PROVISION_STUCK — AM-50: the guided session-host
//                                provisioning timer
//                                (sessionHostProvisionTimer.ts) hit an
//                                unexpected state-machine or ARM error while
//                                advancing a provision — logged via this
//                                marker AND a failure-outcome audit row
//                                (sessionhost.provision.timer_advance).
//                                Same "genuinely stopped making progress"
//                                severity rationale as IMAGE_BUILD_STUCK
//                                above (a session-host VM left running
//                                unattended, never reaching a registered
//                                host, is a real, ongoing cost) — DEFERRED,
//                                not part of this story: no alert rule
//                                targets this marker yet.
resource appInsights 'Microsoft.Insights/components@2020-02-02' = {
  name: appInsightsName
  location: location
  tags: tags
  kind: 'web'
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: logAnalyticsWorkspaceId
  }
}

// A Flex Consumption plan is a distinct serverfarm sku ('FC1' / tier
// 'FlexConsumption') — there is no other sku choice within this tier, so
// (unlike EP1/EP2/EP3 under ElasticPremium) it isn't exposed as a
// caller-overridable param; hardcoding it here removes a way to
// misconfigure it.
resource hostingPlan 'Microsoft.Web/serverfarms@2024-04-01' = {
  name: hostingPlanName
  location: location
  tags: tags
  kind: 'linux'
  sku: {
    name: 'FC1'
    tier: 'FlexConsumption'
  }
  properties: {
    reserved: true
  }
}

// Flex Consumption app settings. Deliberately does NOT include
// FUNCTIONS_EXTENSION_VERSION, FUNCTIONS_WORKER_RUNTIME,
// WEBSITE_CONTENTAZUREFILECONNECTIONSTRING, or WEBSITE_CONTENTSHARE —
// Flex Consumption forbids/ignores these classic settings; the runtime and
// content-share equivalents are declared in functionAppConfig instead (see
// the functionApp resource below). AzureWebJobsStorage__accountName is the
// identity-based host storage connection (Functions builds the
// blob/queue/table service URIs from the account name and authenticates
// via the Function App's system-assigned managed identity — granted
// Storage Blob Data Contributor on this same storage account below).
var appSettings = [
  { name: 'AzureWebJobsStorage__accountName', value: storageAccount.name }
  { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', value: appInsights.properties.ConnectionString }
  { name: 'SWA_BACKEND_SECRET', value: swaBackendSecret }
  { name: 'REQUIRE_BACKEND_SECRET', value: enforceSharedHeaderCheck }
  { name: 'SUBSCRIPTION_ID', value: subscriptionId }
  { name: 'RG_HOSTPOOLS', value: rgHostPools }
  { name: 'HOSTPOOL_NAME', value: hostPoolName }
  { name: 'WORKSPACE_NAME', value: workspaceName }
  { name: 'DAG_NAME', value: dagName }
  { name: 'RG_IMAGES', value: rgImages }
  { name: 'RG_MONITORING', value: logAnalyticsResourceGroup }
  { name: 'GALLERY_NAME', value: galleryName }
  { name: 'IMAGE_DEFINITION_NAME', value: imageDefinitionName }
  { name: 'IMAGE_EOL_DATE', value: imageEolDate }
  { name: 'STORAGE_ACCOUNT_NAME', value: avdStorageAccountName }
  { name: 'FSLOGIX_SHARE_NAME', value: fslogixShareName }
  // AM-25: cost dashboard resource-group additions (see config.ts's
  // resourceGroups.management/network/storage doc comments for why these
  // three, specifically).
  { name: 'RG_MANAGEMENT', value: rgManagement }
  { name: 'RG_NETWORK', value: rgNetwork }
  { name: 'RG_STORAGE', value: rgStorage }
  // AM-16 (M3b): governance panel resource-group/resource additions — see
  // app/api/src/lib/config.ts's governance block for the consumer.
  { name: 'RG_SECURITY', value: rgSecurity }
  { name: 'KEY_VAULT_NAME', value: keyVaultName }
  { name: 'BREAK_GLASS_GROUP_ID', value: breakGlassGroupId }
  { name: 'VNET_NAME', value: vnetNameForGovernance }
  { name: 'REQUIRED_TAGS', value: requiredTags }
  { name: 'EXPECTED_PRIVATE_ENDPOINT_COUNT', value: string(expectedPrivateEndpointCount) }
  // AM-56 — read by app/api/src/lib/config.ts's `governance.privilegedStorageBaselinePrincipalIds`/`expectedStorageLockNames`.
  { name: 'PRIVILEGED_STORAGE_BASELINE_PRINCIPAL_IDS', value: privilegedStorageBaselinePrincipalIds }
  { name: 'EXPECTED_STORAGE_LOCK_NAMES', value: expectedStorageLockNames }
  { name: 'LAW_WORKSPACE_ID', value: logAnalyticsWorkspaceId }
  // See existingLogAnalyticsWorkspace's comment above for why this is a
  // separate setting from LAW_WORKSPACE_ID rather than reusing it.
  { name: 'LAW_WORKSPACE_GUID', value: existingLogAnalyticsWorkspace.properties.customerId }
  { name: 'GROUP_ID_VIEWER', value: groupIdViewer }
  { name: 'GROUP_ID_OPERATOR', value: groupIdOperator }
  { name: 'GROUP_ID_ADMIN', value: groupIdAdmin }
  // AM-18 (M2-S1): read by app/api/src/lib/config.ts's `audit` block.
  // storageAccountName is THIS module's own functions storage account
  // (storageAccount.name below) — not avdStorageAccountName (the existing
  // FSLogix account) — so no new param is needed to supply it.
  { name: 'AUDIT_STORAGE_ACCOUNT_NAME', value: storageAccount.name }
  { name: 'AUDIT_TABLE_NAME', value: auditTableName }
  // AM-24: ack/snooze state. Reuses AUDIT_STORAGE_ACCOUNT_NAME above (same
  // account, see app/api/src/lib/tableStorage.ts) rather than a second
  // *_STORAGE_ACCOUNT_NAME setting — only the table name differs.
  { name: 'ALERT_STATE_TABLE_NAME', value: alertStateTableName }
  // AM-23 (M3-S1): read by app/api/src/lib/config.ts's `scalingOverride`
  // block. Shares AUDIT_STORAGE_ACCOUNT_NAME (same storage account) — only
  // the table name differs.
  { name: 'SCALING_OVERRIDE_TABLE_NAME', value: scalingOverrideTableName }
  // AM-28 (M4-S3): read by app/api/src/lib/config.ts's `rollout` block.
  // Shares AUDIT_STORAGE_ACCOUNT_NAME (same storage account) — only the
  // table name differs, same pattern as SCALING_OVERRIDE_TABLE_NAME above.
  { name: 'ROLLOUT_TABLE_NAME', value: rolloutTableName }
  // AM-27 (M4-S2): read by app/api/src/lib/config.ts's `imageBuild` block.
  // IMAGE_BUILD_TABLE_NAME shares AUDIT_STORAGE_ACCOUNT_NAME (same account)
  // — only the table name differs, same convention as the two settings
  // above. IMAGE_BUILD_SUBNET_ID is empty (not set) unless the caller
  // supplies one — see this param's own doc comment; app/api's
  // resolvePlanContext() fails closed (a clear 500, not a crash) on a
  // start-build request when it's unset, same posture as every other
  // required-in-prod-but-optional-locally setting in this file.
  { name: 'IMAGE_BUILD_TABLE_NAME', value: imageBuildTableName }
  { name: 'IMAGE_BUILD_SUBNET_ID', value: imageBuildSubnetId }
  { name: 'IMAGE_BUILD_VM_SIZE', value: imageBuildVmSize }
  { name: 'IMAGE_BUILD_LOCATION', value: imageBuildLocation }
  // AM-50: read by app/api/src/lib/config.ts's `sessionHostProvision`
  // block. SESSION_HOST_PROVISION_TABLE_NAME shares AUDIT_STORAGE_ACCOUNT_NAME
  // (same account) — only the table name differs, same convention as the
  // *_TABLE_NAME settings above. SESSION_HOST_SUBNET_NAME feeds config.ts's
  // OWN computed subnetId (subscriptionId + RG_NETWORK + VNET_NAME +
  // this name) — unlike IMAGE_BUILD_SUBNET_ID above, this is a bare NAME,
  // not a pre-resolved resource id (see sessionHostSubnetName's own param
  // doc comment for why SNET-SESSIONHOSTS needs no such pre-resolution).
  { name: 'SESSION_HOST_PROVISION_TABLE_NAME', value: sessionHostProvisionTableName }
  { name: 'SESSION_HOST_SUBNET_NAME', value: sessionHostSubnetName }
  // AM-13 (M5): read by app/api/src/lib/config.ts's `profiles` block.
  { name: 'FSLOGIX_OVERSIZED_GB', value: string(fslogixOversizedGb) }
  { name: 'AVD_USERS_GROUP_ID', value: avdUsersGroupId }
  { name: 'API_VERSION', value: apiVersion }
]

// vnetRouteAllEnabled is explicitly false. This app's network design routes
// only RFC1918-destined (private) traffic over the VNet integration path —
// private-linked resources (the FSLogix storage account, Key Vault, etc.)
// reachable from SNET-MANAGEMENT. ARM (management.azure.com) and Microsoft
// Graph calls — everything app/api/src/services actually makes today — are
// public internet endpoints; if vnetRouteAllEnabled were ever set true, ALL
// outbound traffic (including those ARM/Graph calls) would be forced over
// the VNet integration path and out through the hub firewall, which has no
// rule for management.azure.com today — that would break every ARM call
// this API makes. See DEPLOY-PREREQS in docs/app-registration.md: if
// vnetRouteAllEnabled is ever flipped to true, hub-firewall allow rules for
// ARM/Graph endpoints become a hard prerequisite, not optional.
resource functionApp 'Microsoft.Web/sites@2024-04-01' = {
  name: functionAppName
  location: location
  tags: tags
  kind: 'functionapp,linux'
  identity: {
    // System-assigned managed identity — used by app/api/src/services/avdService.ts
    // (via DefaultAzureCredential) to call ARM without stored secrets, AND
    // by functionAppConfig.deployment.storage.authentication /
    // AzureWebJobsStorage__accountName below to reach this module's own
    // storage account without an account key.
    type: 'SystemAssigned'
  }
  properties: {
    serverFarmId: hostingPlan.id
    httpsOnly: true
    virtualNetworkSubnetId: subnetId
    publicNetworkAccess: publicNetworkAccess
    vnetRouteAllEnabled: false
    functionAppConfig: {
      deployment: {
        storage: {
          type: 'blobContainer'
          value: '${storageAccount.properties.primaryEndpoints.blob}${deploymentStorageContainerName}'
          authentication: {
            type: 'SystemAssignedIdentity'
          }
        }
      }
      scaleAndConcurrency: {
        maximumInstanceCount: maximumInstanceCount
        instanceMemoryMB: instanceMemoryMB
      }
      runtime: {
        name: 'node'
        version: nodeVersion
      }
    }
    siteConfig: {
      ftpsState: 'Disabled'
      minTlsVersion: '1.2'
      ipSecurityRestrictionsDefaultAction: ipSecurityRestrictionsDefaultAction
      ipSecurityRestrictions: ipSecurityRestrictions
      appSettings: appSettings
    }
  }
}

// Grants the Function App's managed identity read/write/delete on its own
// storage account — required for both AzureWebJobsStorage__accountName
// (host storage: queues/tables/blobs the Functions runtime itself uses)
// and functionAppConfig.deployment.storage's SystemAssignedIdentity auth
// (the deployment package container). Scoped to just this one storage
// account (not the resource group), via a resource-scoped role assignment
// declared directly against `storageAccount` in this same file — no
// cross-RG module indirection needed here (contrast with
// infra/modules/rbac.bicep, which grants roles on RGs outside this one).
var storageBlobDataContributorRoleDefinitionId = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'ba92f5b4-2d11-453d-a403-e96b0029c9fe')

resource storageBlobDataContributorAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storageAccount.id, functionApp.id, storageBlobDataContributorRoleDefinitionId)
  scope: storageAccount
  properties: {
    principalId: functionApp.identity.principalId
    roleDefinitionId: storageBlobDataContributorRoleDefinitionId
    principalType: 'ServicePrincipal'
  }
}

// AM-18 (M2-S1): grants the Function App's managed identity read/write/delete
// on the AuditLog table (and any future table on this account) — required
// for app/api/src/lib/auditLog.ts's TableClient calls. GUID verified against
// Microsoft Learn's built-in roles reference:
// https://learn.microsoft.com/azure/role-based-access-control/built-in-roles/storage#storage-table-data-contributor
// Same resource-scoped pattern as storageBlobDataContributorAssignment above
// (scoped to just this storage account, not the resource group).
//
// This grant is account-scoped (not per-table), so AM-24's AlertState table
// (above) is covered by this SAME assignment — no second role assignment
// was needed for it; see app/api/src/lib/tableStorage.ts for the consumer
// side (AlertState's TableClient, built the same DefaultAzureCredential way
// as auditLog.ts's).
var storageTableDataContributorRoleDefinitionId = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3')

resource storageTableDataContributorAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storageAccount.id, functionApp.id, storageTableDataContributorRoleDefinitionId)
  scope: storageAccount
  properties: {
    principalId: functionApp.identity.principalId
    roleDefinitionId: storageTableDataContributorRoleDefinitionId
    principalType: 'ServicePrincipal'
  }
}

// No staging slot: Flex Consumption does not support deployment slots at
// all (Microsoft.Web/sites/slots is not a valid child resource type under
// this sku/tier) — GitHub Actions' Azure/functions-action confirms this
// too ("slot-name: Not supported" for Flex Consumption). A dev environment
// therefore needs its own dedicated Flex Consumption Function App (a
// separate resource, not a slot).

// TODO(AM-9): VNet integration also typically needs a `config/virtualNetwork` or
// `networkConfig/virtualNetwork` child resource depending on API version in use;
// validate against the target subscription's provider registration before M1.

output name string = functionApp.name
output id string = functionApp.id
output principalId string = functionApp.identity.principalId
output defaultHostname string = functionApp.properties.defaultHostName
// AM-48 (review fix): alerting.bicep's scheduledQueryRules filter AppTraces
// on _ResourceId so each environment's rules see only their OWN app's
// telemetry in the shared workspace — this output is the only place that
// resource id is knowable without duplicating appInsightsName's naming rule.
output appInsightsResourceId string = appInsights.id
