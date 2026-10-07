/**
 * Central place to read AVD resource identifiers/names out of the Function
 * App's environment (app settings in Azure, local.settings.json locally —
 * see local.settings.json.example). Keeps magic resource names out of the
 * individual function/service files.
 */
export interface AppConfig {
  subscriptionId: string;
  resourceGroups: {
    hostPools: string;
    images: string;
    monitoring: string;
    /**
     * AM-25 additions for the cost dashboard. RG-AVD-Management currently
     * hosts this app itself (see the gap register item
     * 2); RG-AVD-Network holds the estate's NSGs/private endpoints/DNS
     * zones. Neither is read by any other M1/M2 code path — they exist here
     * solely so costService can attribute spend to them.
     */
    management: string;
    network: string;
    /**
     * Hosts stcontoso001 (the FSLogix profile share's storage account) — see
     * storage.accountName below. Deliberately included in the cost RG list
     * even though the AM-25 story's own bullet list of 5 RGs omitted it:
     * The scaling-and-cost runbook §4.2 calls the PremiumV2
     * share's provisioning out as one of "the big levers on this estate" for
     * cost, so a spend-by-resource-group table that excluded it would be
     * materially misleading. RG-AVD-Security (Key Vault only) was left out —
     * negligible cost, not worth an extra RBAC grant for this dashboard.
     */
    storage: string;
    /**
     * AM-16 (M3b) addition — the Key Vault this app now reads a single
     * governance property from (purge protection). Deliberately excluded
     * from costTrackedResourceGroups() in costService.ts (see that
     * function's own comment: "negligible cost, not worth an extra RBAC
     * grant" — that reasoning predates this story; AM-16 adds the grant
     * anyway, for governance reads specifically, not cost attribution) —
     * this RG gets plain Reader only (infra/main.bicep's rbacSecurity
     * module), not Cost Management Reader.
     */
    security: string;
  };
  hostPoolName: string;
  workspaceName: string;
  dagName: string;
  galleryName: string;
  /** Image definition (Microsoft.Compute/galleries/images) name within galleryName, e.g. WIN11-ENT-MS-M365. */
  imageDefinitionName: string;
  /**
   * ISO date (YYYY-MM-DD) the current golden image's underlying OS falls out
   * of support. Azure has no API for this — it's operator-supplied (Windows
   * 11 Enterprise multi-session servicing timeline), surfaced on
   * GET /api/v1/images/current as ImageVersionCurrent.eolDate. Undefined
   * (rather than defaulted) when unset, so the UI can show "not configured"
   * instead of a fabricated countdown.
   */
  imageEolDate: string | undefined;
  storage: {
    accountName: string;
    fslogixShareName: string;
  };
  /** ARM resource ID of the Log Analytics workspace. Not consumed by any M1 code path today (App Insights workspace-based wiring is set directly in Bicep) — carried here for a future consumer. Undefined, not '', when unset. */
  logAnalyticsWorkspaceId: string | undefined;
  /**
   * The Log Analytics workspace's "Workspace ID" (its `customerId` GUID —
   * the value shown on the workspace's Agents/overview blade), NOT the ARM
   * resource ID above. @azure/monitor-query-logs's LogsQueryClient.
   * queryWorkspace() takes this GUID, not a `/subscriptions/...` resource
   * path — the two are easy to conflate since both get called "workspace
   * id" in different Microsoft docs. Resolved at Bicep deploy time from the
   * existing workspace's `properties.customerId` (see
   * infra/modules/functionapp.bicep), published as the LAW_WORKSPACE_GUID
   * app setting, so app/api never needs its own ARM call (and therefore no
   * extra RBAC) just to look this value up. Consumed by
   * app/api/src/services/hostRuntimeService.ts (AM-25), which degrades to
   * dataSource: 'none' rather than throwing when unset, and by
   * app/api/src/services/logsService.ts (AM-24), whose endpoints instead
   * fail closed with a clear 500 when unset — see
   * logsService.ts#runLogsQuery. Undefined, not '', when unset either way.
   */
  logAnalyticsWorkspaceGuid: string | undefined;
  /**
   * Entra ID (Azure AD) object IDs for the three app groups (AVDMGR-Viewers /
   * AVDMGR-Operators / AVDMGR-Admins — see docs/app-registration.md). Used
   * by the /api/roles rolesSource function to map a signed-in user's group
   * membership claims to app Role strings. Any/all may be unset in an
   * environment that hasn't finished group provisioning yet — the rolesSource
   * mapper simply won't grant that role to anyone.
   */
  groupIds: {
    viewer: string | undefined;
    operator: string | undefined;
    admin: string | undefined;
  };
  /**
   * Audit log table (see app/api/src/lib/auditLog.ts), which lives on the
   * FUNCTIONS storage account (infra/modules/functionapp.bicep's
   * `storageAccount` resource — a different account than `storage` above,
   * which is the existing FSLogix profile share). storageAccountName is
   * undefined in local dev (no such resource exists there); auditLog.ts
   * treats that as "audit writes are a no-op, logged, not thrown" rather
   * than failing every mutation locally.
   */
  audit: {
    storageAccountName: string | undefined;
    tableName: string;
  };
  /**
   * AM-24 ack/snooze state (see app/api/src/lib/alertState.ts). Lives in the
   * SAME storage account as the audit table above (audit.storageAccountName
   * — the FUNCTIONS storage account, infra/modules/functionapp.bicep) rather
   * than a separate STATE_STORAGE_ACCOUNT_NAME setting — one account, one
   * credential pattern (DefaultAzureCredential + Storage Table Data
   * Contributor), matching auditLog.ts's config/credential shape exactly;
   * only the table name differs, configurable the same way AUDIT_TABLE_NAME
   * is.
   */
  alertState: {
    tableName: string;
  };
  /**
   * AM-23 (M3-S1) emergency-override state table (see
   * app/api/src/services/scalingOverrideService.ts) — lives on the SAME
   * storage account as `audit` above (storageAccountName is shared, not
   * duplicated as its own field), just a different table name.
   */
  scalingOverride: {
    tableName: string;
  };
  /**
   * AM-16 (M3b) — Governance & security posture panel additions.
   */
  governance: {
    /** Microsoft.KeyVault/vaults name, in resourceGroups.security — the KV the purge-protection check reads (see services/governance/keyVaultPurgeProtection.ts). */
    keyVaultName: string;
    /**
     * Entra ID (Azure AD) object ID of this estate's break-glass
     * emergency-access group/account — the principal the CA-policy-exclusion
     * check (services/governance/conditionalAccessBreakGlass.ts) verifies
     * every enabled Conditional Access policy excludes. Undefined until an
     * operator sets it: no such group is captured anywhere in
     * the runbooks or the runbooks today, so this check
     * degrades to an explicit "not configured" state (distinct from the
     * separate "Graph permission not granted" degradation — see that
     * check's doc comment) rather than silently checking against an empty/
     * wrong value.
     */
    breakGlassGroupId: string | undefined;
    /**
     * Name of the existing VNet the orphan/hygiene scanner
     * (services/governance/orphanedResources.ts) reads subnets from —
     * peer review item 5: this was hard-coded 'VNET-CONTOSO-PROD' before,
     * meaning a renamed VNet would 404 and (depending on the 404 policy)
     * risk silently reporting "no empty subnets found" instead of a real
     * error. Configurable so the check fails loudly against the ACTUAL
     * configured VNet rather than a name that quietly drifted out of sync.
     */
    vnetName: string;
    /**
     * Comma-separated required tag KEYS the untagged-resource sub-scan
     * checks for (peer review item 7). Empty (the default) means "no tag
     * policy configured" — the sub-scan then reports that fact as
     * INFORMATIONAL evidence, not findings: with no configured policy,
     * this app has no basis to call any resource's tags wrong. Once set,
     * a resource missing ANY listed key is reported, naming which key(s)
     * are missing.
     */
    requiredTags: string[];
    /**
     * Expected count of private endpoints in RG-AVD-Network (peer review
     * item 16) — was hard-coded 5 (matching the runbooks
     * §3's capture) before. Configurable so a
     * deliberate estate change (a 6th PE added, one retired) doesn't
     * require a code change to stop warning.
     */
    expectedPrivateEndpointCount: number;
    /**
     * AM-56 — Entra ID object IDs of every principal EXPECTED to hold
     * "Storage File Data Privileged Contributor" on the FSLogix storage
     * account (see services/governance/storagePrivilegedAccess.ts). The
     * baseline is TWO principals on this estate today: this app's own
     * prod Function App managed identity (fslogixDataPlaneRole.bicep grants
     * it this exact role — see that module's header comment) and the dev
     * environment's Function App identity (same grant, same role, a
     * separate deployment — infra/main.bicep's `privilegedStorageBaseline*`
     * params compose this list at deploy time). Undefined (not an empty
     * array) when unset — this check must never GUESS a baseline; it
     * degrades to 'unknown' with configure-guidance instead (see that
     * check's own doc comment for why "nobody configured this yet" and
     * "the estate genuinely has zero grants" are different facts this app
     * must not conflate).
     */
    privilegedStorageBaselinePrincipalIds: string[] | undefined;
    /**
     * AM-56 — expected `Microsoft.Authorization/locks` CanNotDelete names
     * on RG-AVD-Storage / its storage account (see
     * services/governance/storageDeleteLocks.ts), matched case-insensitively
     * (documented casing variance — the FSLogix storage runbook
     * lines 344-345: `LOCK-RG-AVD-Storage`, `Lock-stcontoso001`, and the
     * auto-created `AzureBackupProtectionLock`). Defaults to those three
     * documented names; overridable for an estate change without a code
     * change, same configurability rationale as expectedPrivateEndpointCount
     * above.
     */
    expectedStorageLockNames: string[];
  };
  /**
   * AM-28 (M4-S3) staged rollout plan state table (see
   * app/api/src/services/rolloutPlanService.ts) — lives on the SAME storage
   * account as `audit` above, just a different table name, same as
   * `scalingOverride` above.
   */
  rollout: {
    tableName: string;
  };
  /**
   * AM-27 (M4-S2) golden image build orchestration. `tableName` is another
   * table on the SAME functions storage account as `audit` above (same
   * "one account, one credential pattern" rationale as scalingOverride) —
   * see app/api/src/services/imageBuildService.ts. `subnetId` is the ARM
   * resource id of the existing DEDICATED build subnet the build VM's NIC
   * joins — the golden-image runbook §4.1 documents
   * SNET-MANAGEMENT as the build-VM subnet, but on THIS estate's live
   * deployment SNET-MANAGEMENT is delegated to Microsoft.App/environments
   * for this app's OWN Flex Consumption VNet integration (see
   * docs/app-registration.md DEPLOY-PREREQS 0.1) — a delegated subnet
   * cannot also host a VM NIC, so the build uses a SEPARATE subnet instead
   * (see infra/main.bicep's `imageBuildSubnetName` param and
   * DEPLOY-PREREQS 0.5 for the estate change that creates it).
   * `defaultVmSize` mirrors that same section's sizing note ("size up
   * temporarily for the build" — undersized default marketplace VM sizes
   * struggle to patch Windows + Office). `location` must match the region
   * the gallery/RG-AVD-Images itself lives in (East US for this estate —
   * see that file's §1) since a gallery image version's source VM/snapshot
   * must be in the same region as the version being created (Microsoft
   * Learn: "Troubleshoot images in an Azure Compute Gallery" — Source
   * <resourceID> ... must be in the same region as gallery image version
   * being created).
   */
  imageBuild: {
    tableName: string;
    subnetId: string | undefined;
    defaultVmSize: string;
    location: string;
    /**
     * Hours a build may sit at checklist_gate (VM created and BILLING, but
     * not yet advanced) before the timer surfaces an audited
     * abandonedWarning — see @avdmgr/shared's ImageBuildDetail.abandonedWarning
     * doc comment (Opus review MAJOR 10). A warning, never an auto-fail —
     * the build keeps running exactly as before.
     */
    abandonmentWarningHours: number;
  };
  /**
   * AM-50 — guided session-host provisioning (see
   * app/api/src/services/sessionHostProvisionService.ts /
   * sessionHostProvisionOrchestrator.ts). `tableName` is another table on
   * the SAME functions storage account as `audit` above (same "one
   * account, one credential pattern" rationale as imageBuild.tableName).
   * `subnetId` is COMPUTED (not passed pre-resolved from Bicep the way
   * imageBuild.subnetId is) from subscriptionId/resourceGroups.network/
   * governance.vnetName/subnetName below — SNET-SESSIONHOSTS already
   * exists on this estate (session hosts have always lived there — see
   * The session-host runbook §1), so unlike the golden-image
   * build's build subnet (a NEW estate change that story had to gate behind
   * an explicit, no-default Bicep param) there is no "does this subnet even
   * exist yet" bootstrapping concern here, just a name to point at.
   * `adminUsername` is a fixed, config-driven estate convention (required — no default) — NOT operator-supplied, unlike the image
   * build's adminUsername field, since @avdmgr/shared's
   * SessionHostProvisionParams deliberately has no such field (one less
   * thing for an operator adding a routine session host to have to decide).
   * `dscModulesUrl` is the AVD agent's published DSC configuration bundle —
   * see app/api/src/lib/sessionHostProvisionPlan.ts's
   * DEFAULT_DSC_MODULES_URL doc comment for why this is env-overridable
   * (the default is duplicated here, not imported from that module, same
   * "independently-defaulted, not a shared import" convention
   * imageBuild.defaultVmSize already uses relative to
   * imageBuildPlan.ts#DEFAULT_BUILD_VM_SIZE).
   */
  sessionHostProvision: {
    tableName: string;
    subnetId: string;
    adminUsername: string;
    dscModulesUrl: string;
  };
  /**
   * AM-13 (M5) — FSLogix profile management (see
   * services/fslogixProfilesService.ts). Distinct from the `storage` block
   * above (which is read by the pre-existing management-plane
   * fslogixService.ts share-stats call) only in that these two settings are
   * specific to the profile-listing/reset feature, not the share itself.
   */
  profiles: {
    /** Profiles at or above this size (GiB) are flagged `oversized: true`. Default 5 — no documented threshold exists anywhere in the runbooks today (04-fslogix-operations.md §2.3 only says "establish a working alert threshold" without a number), so this is an operator-tunable app setting, not a hard-coded assumption. */
    oversizedGb: number;
    /**
     * Entra ID (Azure AD) object ID of the AVD-Users group — the SAME
     * cloud-only group the FSLogix storage runbook §4 documents
     * as holding Storage File Data SMB Share Contributor on this account.
     * Used by the orphan-detection cross-check (Graph GroupMember.Read.All,
     * application permission). Undefined until an operator sets it — the
     * check then degrades to its 'not-configured' state (distinct from the
     * separate 'graph-permission-not-granted' degradation — see
     * ProfileOrphanDetectionState in @avdmgr/shared), same two-degraded-
     * states pattern as governance.breakGlassGroupId above.
     */
    avdUsersGroupId: string | undefined;
  };
  /**
   * AM-47 — the expected DELIVERED `HKLM\SOFTWARE\FSLogix\Profiles`
   * registry values the staged rollout's config-convergence gate diffs
   * every new host against (see app/api/src/lib/fslogixConfigCheck.ts and
   * @avdmgr/shared's RolloutConfigDiff). Keyed by the exact registry value
   * name (not camelCase) so this object serializes directly into
   * RolloutPlanEntity.configBaselineJson / RolloutPlanDetail.configBaseline
   * with no key-renaming step. Same "documented default, env-override"
   * idiom as the `governance.*` block above — every default here is
   * LIVE-VERIFIED against a known-good host, not guessed (see
   * The FSLogix storage runbook §5.1's `Get-ItemProperty
   * HKLM:\SOFTWARE\FSLogix\Profiles` capture and "Expect: ..." line).
   * `VHDLocations`' default is COMPUTED from `storage.accountName`/
   * `storage.fslogixShareName` above (not a separate hard-coded default)
   * so the two settings can never silently drift apart — an environment
   * that overrides STORAGE_ACCOUNT_NAME/FSLOGIX_SHARE_NAME automatically
   * gets a matching computed baseline unless FSLOGIX_EXPECTED_VHD_LOCATIONS
   * is ALSO set to override it explicitly.
   */
  fslogixBaseline: {
    Enabled: string;
    VHDLocations: string;
    VolumeType: string;
    SizeInMBs: string;
    FlipFlopProfileDirectoryName: string;
  };
  apiVersion: string;
}

/** AM-56 — the FSLogix storage runbook lines 344-345's documented three CanNotDelete locks on stcontoso001/RG-AVD-Storage. See AppConfig.governance.expectedStorageLockNames doc comment. */
const DEFAULT_EXPECTED_STORAGE_LOCK_NAMES = ['AzureBackupProtectionLock'];

function readEnv(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

/** Like readEnv, but returns undefined instead of throwing when unset — for genuinely optional settings. */
function readOptionalEnv(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value === '' ? undefined : value;
}

/** AM-56 — parses a comma-separated app setting into a trimmed, non-empty string[], or undefined when unset OR when every entry is blank (e.g. a stray "" / ","). Used by governance.privilegedStorageBaselinePrincipalIds, which must distinguish "not configured" from "configured empty" the same honest way governance.breakGlassGroupId already does for a single value. */
function readOptionalCsvEnv(name: string): string[] | undefined {
  const raw = readOptionalEnv(name);
  if (raw === undefined) {
    return undefined;
  }
  const values = raw
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  return values.length > 0 ? values : undefined;
}

/** Like readEnv, but parses the result as a number and falls back to `fallback` (never NaN) if the app setting is present but not a valid number — a mistyped/blank env var must not silently propagate NaN into oversized-threshold comparisons (peer review nit). */
function readNumberEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') {
    return fallback;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Reads config fresh from process.env on every call (cheap; envs don't change
 * at runtime).
 *
 * SUBSCRIPTION_ID, RG_HOSTPOOLS, HOSTPOOL_NAME, WORKSPACE_NAME, DAG_NAME, GALLERY_NAME,
 * STORAGE_ACCOUNT_NAME, KEY_VAULT_NAME, VNET_NAME and SESSION_HOST_ADMIN_USERNAME have no fallback — they
 * identify which production Azure resources this deployment talks to, so an
 * unset value must fail fast at request time rather than silently defaulting
 * to another environment's host pool. Set them explicitly (Function App
 * settings / local.settings.json) per environment.
 */
export function getConfig(): AppConfig {
  // Read once, reused by both `storage` below and `fslogixBaseline`'s
  // computed VHDLocations default (see that field's doc comment) — a
  // second independent readEnv call for the same two settings would risk
  // the pair drifting apart if only one call site's fallback were ever
  // updated.
  const storageAccountName = readEnv('STORAGE_ACCOUNT_NAME');
  const fslogixShareName = readEnv('FSLOGIX_SHARE_NAME', 'fslogixprofiles');

  // AM-50: read once, reused by both `sessionHostProvision.subnetId` below
  // and `resourceGroups.network`/`governance.vnetName` — same
  // "computed-default pair must never drift apart" rationale as
  // storageAccountName/fslogixShareName above.
  const subscriptionId = readEnv('SUBSCRIPTION_ID');
  const rgNetwork = readEnv('RG_NETWORK', 'RG-AVD-Network');
  const vnetName = readEnv('VNET_NAME');
  const sessionHostSubnetName = readEnv('SESSION_HOST_SUBNET_NAME', 'SNET-SESSIONHOSTS');

  return {
    subscriptionId,
    resourceGroups: {
      hostPools: readEnv('RG_HOSTPOOLS'),
      images: readEnv('RG_IMAGES', 'RG-AVD-Images'),
      monitoring: readEnv('RG_MONITORING', 'RG-AVD-Monitoring'),
      management: readEnv('RG_MANAGEMENT', 'RG-AVD-Management'),
      network: rgNetwork,
      storage: readEnv('RG_STORAGE', 'RG-AVD-Storage'),
      security: readEnv('RG_SECURITY', 'RG-AVD-Security'),
    },
    hostPoolName: readEnv('HOSTPOOL_NAME'),
    workspaceName: readEnv('WORKSPACE_NAME'),
    dagName: readEnv('DAG_NAME'),
    galleryName: readEnv('GALLERY_NAME'),
    imageDefinitionName: readEnv('IMAGE_DEFINITION_NAME', 'WIN11-ENT-MS-M365'),
    imageEolDate: readOptionalEnv('IMAGE_EOL_DATE'),
    storage: {
      accountName: storageAccountName,
      fslogixShareName,
    },
    logAnalyticsWorkspaceId: readOptionalEnv('LAW_WORKSPACE_ID'),
    logAnalyticsWorkspaceGuid: readOptionalEnv('LAW_WORKSPACE_GUID'),
    groupIds: {
      viewer: readOptionalEnv('GROUP_ID_VIEWER'),
      operator: readOptionalEnv('GROUP_ID_OPERATOR'),
      admin: readOptionalEnv('GROUP_ID_ADMIN'),
    },
    audit: {
      storageAccountName: readOptionalEnv('AUDIT_STORAGE_ACCOUNT_NAME'),
      tableName: readEnv('AUDIT_TABLE_NAME', 'AuditLog'),
    },
    alertState: {
      tableName: readEnv('ALERT_STATE_TABLE_NAME', 'AlertState'),
    },
    scalingOverride: {
      tableName: readEnv('SCALING_OVERRIDE_TABLE_NAME', 'ScalingOverride'),
    },
    governance: {
      keyVaultName: readEnv('KEY_VAULT_NAME'),
      breakGlassGroupId: readOptionalEnv('BREAK_GLASS_GROUP_ID'),
      vnetName,
      requiredTags: (readOptionalEnv('REQUIRED_TAGS') ?? '')
        .split(',')
        .map((tag) => tag.trim())
        .filter((tag) => tag.length > 0),
      // AM-15 (M7) sweep: was `Number(readEnv(...))` — a misconfigured (present
      // but non-numeric) app setting would have propagated NaN into the
      // orphaned-private-endpoint-count comparison (governance/privateEndpoints.ts)
      // rather than falling back to the documented default of 5, same class of
      // bug readNumberEnv already guards against below.
      expectedPrivateEndpointCount: readNumberEnv('EXPECTED_PRIVATE_ENDPOINT_COUNT', 5),
      privilegedStorageBaselinePrincipalIds: readOptionalCsvEnv('PRIVILEGED_STORAGE_BASELINE_PRINCIPAL_IDS'),
      expectedStorageLockNames: (() => {
        const configured = readOptionalCsvEnv('EXPECTED_STORAGE_LOCK_NAMES');
        return configured ?? DEFAULT_EXPECTED_STORAGE_LOCK_NAMES;
      })(),
    },
    rollout: {
      tableName: readEnv('ROLLOUT_TABLE_NAME', 'RolloutPlan'),
    },
    imageBuild: {
      tableName: readEnv('IMAGE_BUILD_TABLE_NAME', 'ImageBuild'),
      // Undefined (not thrown) when unset: local dev / an environment mid
      // rollout can still run every OTHER route; only the build-start
      // handler itself needs to fail closed on a missing subnet (see
      // imageBuilds.ts), mirroring audit.storageAccountName's
      // optional-with-its-own-fail-closed-check treatment above.
      subnetId: readOptionalEnv('IMAGE_BUILD_SUBNET_ID'),
      defaultVmSize: readEnv('IMAGE_BUILD_VM_SIZE', 'Standard_D4ads_v7'),
      location: readEnv('IMAGE_BUILD_LOCATION', 'eastus'),
      // AM-15 (M7) sweep: same NaN-guard fix as expectedPrivateEndpointCount
      // above — a misconfigured value must fall back to the documented 24h
      // default, not silently produce a NaN abandonedWarning comparison.
      abandonmentWarningHours: readNumberEnv('IMAGE_BUILD_ABANDONMENT_HOURS', 24),
    },
    sessionHostProvision: {
      tableName: readEnv('SESSION_HOST_PROVISION_TABLE_NAME', 'SessionHostProvision'),
      subnetId: `/subscriptions/${subscriptionId}/resourceGroups/${rgNetwork}/providers/Microsoft.Network/virtualNetworks/${vnetName}/subnets/${sessionHostSubnetName}`,
      adminUsername: readEnv('SESSION_HOST_ADMIN_USERNAME'),
      // Default duplicated from sessionHostProvisionPlan.ts's
      // DEFAULT_DSC_MODULES_URL — see this field's AppConfig doc comment for
      // why (not a shared import, same convention as imageBuild.defaultVmSize).
      dscModulesUrl: readEnv('SESSION_HOST_DSC_MODULES_URL', 'https://wvdportalstorageblob.blob.core.windows.net/galleryartifacts/Configuration_1.0.03483.1387.zip'),
    },
    profiles: {
      oversizedGb: readNumberEnv('FSLOGIX_OVERSIZED_GB', 5),
      avdUsersGroupId: readOptionalEnv('AVD_USERS_GROUP_ID'),
    },
    fslogixBaseline: {
      Enabled: readEnv('FSLOGIX_EXPECTED_ENABLED', '1'),
      // Matches the UNC form the FSLogix storage runbook documents
      // Intune's Settings Catalog profile delivers for VHDLocations —
      // \\<account>.file.core.windows.net\<share> — computed from the SAME
      // storageAccountName/fslogixShareName `storage` above resolves, not a
      // second independent default (see this field's own doc comment on
      // AppConfig).
      VHDLocations: readEnv('FSLOGIX_EXPECTED_VHD_LOCATIONS', `\\\\${storageAccountName}.file.core.windows.net\\${fslogixShareName}`),
      VolumeType: readEnv('FSLOGIX_EXPECTED_VOLUME_TYPE', 'VHDX'),
      SizeInMBs: readEnv('FSLOGIX_EXPECTED_SIZE_MB', '30000'),
      FlipFlopProfileDirectoryName: readEnv('FSLOGIX_EXPECTED_FLIP_FLOP_PROFILE_DIRECTORY_NAME', '1'),
    },
    apiVersion: readEnv('API_VERSION', '1.0.0'),
  };
}
