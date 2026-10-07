// AM-48 — Log Analytics-based alert rules for the golden-image build
// pipeline's two operationally-relevant log MARKERS: imageBuildTimer.ts /
// imageBuilds.ts's IMAGE_BUILD_STUCK (AM-27, Opus review MAJOR 12) and
// imageBuildOrchestrator.ts's IMAGE_BUILD_CLEANUP_SELFHEAL (AM-46's
// dependency-ordered cleanup self-heal path, added by THIS story). See
// infra/modules/functionapp.bicep's ALERTING TODO comment (trimmed by this
// story to record these two as landed) for the fuller backlog of markers
// this app emits that still have no alert rule — this module covers only
// these two.
//
// WHY Microsoft.Insights/scheduledQueryRules (a "log alert") rather than a
// metric alert: neither marker has a first-class Azure Monitor METRIC —
// both are just structured lines passed to context.error/context.warn,
// which land in this app's Application Insights instance's AppTraces table.
// This app's Application Insights is WORKSPACE-BASED (see
// functionapp.bicep's appInsights resource, WorkspaceResourceId set to the
// SAME Log Analytics workspace this module's `logAnalyticsWorkspaceId` param
// identifies), so a KQL query scoped to that workspace is the only way to
// observe either marker at all — there is no per-resource "traces" scope to
// alert on instead. Verified against Microsoft Learn's "Create, view, and
// manage log alerts using Azure Monitor"
// (https://learn.microsoft.com/azure/azure-monitor/alerts/alerts-create-log-alert-rule)
// and the Microsoft.Insights/scheduledQueryRules ARM/Bicep reference
// (https://learn.microsoft.com/azure/templates/microsoft.insights/scheduledqueryrules).
//
// PER-buildId GROUPING (IMAGE_BUILD_STUCK): the query extracts buildId out
// of the marker line and summarizes count() BY buildId; `dimensions` below
// splits the alert evaluation per buildId value and `metricMeasureColumn`
// names the count column the static threshold criteria is evaluated
// against — so "3 occurrences for the SAME build" fires, rather than 3
// occurrences total spread across three unrelated builds silently
// under-alerting (or three unrelated single-occurrence builds spuriously
// combining into one false alert). windowSize PT15M / threshold 3 matches
// the AM-48 acceptance criterion verbatim ("fires within 15 minutes of >= 3
// consecutive IMAGE_BUILD_STUCK occurrences for the same buildId");
// evaluationFrequency PT5M keeps the worst-case detection delay well inside
// that 15-minute budget (a breach anywhere in the trailing 15-minute window
// is caught on the very next 5-minute tick).
//
// SELF-HEAL IS INFORMATIONAL, NOT AN INCIDENT
// (IMAGE_BUILD_CLEANUP_SELFHEAL): see imageBuildOrchestrator.ts's
// logCleanupSelfHeal doc comment — a failed delete step being re-submitted
// is the AM-46 fix working exactly as designed, not a failure. threshold
// >= 1 (fires on the FIRST occurrence — there is no natural "consecutive"
// framing for a marker that is expected to appear at most once or twice per
// build that ever needed it) at low severity (3) with a wide 1-hour window
// and 15-minute evaluation cadence: loose enough that a single self-heal
// during a routine cleanup tick doesn't page anyone overnight, while still
// reaching the SAME action group/email as IMAGE_BUILD_STUCK so an operator
// notices during business hours and can watch for it recurring.
//
// FILTERS ON _ResourceId, NOT AN AppRoleName CLOUD-ROLE FILTER (Fable
// review fix): dev and prod BOTH send their workspace-based App Insights
// telemetry to the shared LAW-CONTOSO-PROD workspace, so a query filtering on
// the marker string alone would let each environment's rules fire on the
// OTHER environment's traces — a stuck DEV test build would page the prod
// severity-1 rule, and deploying both environments' rules would double-email
// every real incident. Every AppTraces row carries the _ResourceId of the
// App Insights component that ingested it, and functionapp.bicep now
// outputs that component's id (appInsightsResourceId) — a bicep-verifiable
// per-environment filter, unlike cloud_RoleName, which the Node.js Flex
// Consumption host derives internally with no APPINSIGHTS-side override
// pinning it. `=~` because ARM resource-id casing is not canonical.
// BICEP MECHANICS: the KQL lives in single-quoted vars below (not '''
// multi-line strings) because bicep multi-line strings cannot interpolate
// ${appInsightsResourceId}; '\n' escapes keep the query multi-line for the
// portal's rule editor.
//
// EMAIL ADDRESS IS A REQUIRED PARAM, NEVER HARDCODED: this module (and
// main.bicep, which surfaces it as its own required param) has no default —
// an operator must supply a real destination at deploy time via a params
// file or pipeline variable, never a literal committed to source.
targetScope = 'resourceGroup'

@description('Azure region for this module\'s scheduledQueryRules resources. Deploying a workspace-scoped log alert in a DIFFERENT region from the target Log Analytics workspace is unsupported in practice (Azure Monitor log alert rules are evaluated in the same region as their target) — pass the SAME region as logAnalyticsWorkspaceId\'s own workspace (LAW-CONTOSO-PROD is eastus, same as every other resource in this deployment — see main.bicep\'s `location` param doc comment).')
param location string

@description('Resource tags, applied to every resource this module creates.')
param tags object = {}

@description('Deployment environment (dev/test/prod) — used only to keep this module\'s resource names distinct across environments that might share the same Log Analytics workspace / resource group (same rationale as sessionHostWriterRole.bicep\'s environmentName param).')
param environmentName string

@description('ARM resource id of the existing Log Analytics workspace both scheduledQueryRules below are scoped to. This app\'s Application Insights is workspace-based (see functionapp.bicep\'s appInsights resource, whose WorkspaceResourceId must be this SAME workspace) — its IMAGE_BUILD_STUCK / IMAGE_BUILD_CLEANUP_SELFHEAL traces land in this workspace\'s AppTraces table, not a separate App-Insights-only store.')
param logAnalyticsWorkspaceId string

@description('ARM resource id of THIS environment\'s Application Insights component (functionapp.bicep\'s appInsightsResourceId output). Both alert queries filter AppTraces on _ResourceId == this id so each environment\'s rules observe only their own app\'s telemetry in the shared workspace — see this file\'s header comment (FILTERS ON _ResourceId).')
param appInsightsResourceId string

@description('Email address notified by both alert rules\' shared action group. REQUIRED — no default, so a deployment can never silently ship with nobody actually notified.')
param alertEmailAddress string

// The shared query prefix/suffix for both rules — single-quoted with '\n'
// escapes, not ''' multi-line strings, because only single-quoted strings
// can interpolate ${appInsightsResourceId} (see header comment).
var appTracesScopedToThisApp = 'AppTraces\n| where _ResourceId =~ "${appInsightsResourceId}"'
var summarizeByBuildId = '| extend buildId = extract(@"buildId=([0-9a-fA-F-]+)", 1, tostring(Message))\n| where isnotempty(buildId)\n| summarize AggregatedValue = count() by buildId'
var imageBuildStuckQuery = '${appTracesScopedToThisApp}\n| where Message has "IMAGE_BUILD_STUCK"\n${summarizeByBuildId}'
var cleanupSelfHealQuery = '${appTracesScopedToThisApp}\n| where Message has "IMAGE_BUILD_CLEANUP_SELFHEAL"\n${summarizeByBuildId}'

var actionGroupName = 'ag-avdmgr-imagebuild-${environmentName}'
// Azure Monitor caps groupShortName at 12 characters (Microsoft.Insights
// actionGroups' ARM/Bicep property reference) — used for SMS/voice
// receivers this action group doesn't have today, but the field is still
// required on every action group regardless.
var actionGroupShortName = 'AVDMgrBuild'

resource actionGroup 'Microsoft.Insights/actionGroups@2023-01-01' = {
  name: actionGroupName
  location: 'global' // Action groups are always global — Microsoft.Insights/actionGroups' ARM/Bicep reference documents no other valid location.
  tags: tags
  properties: {
    groupShortName: actionGroupShortName
    enabled: true
    emailReceivers: [
      {
        name: 'operator-email'
        emailAddress: alertEmailAddress
        useCommonAlertSchema: true
      }
    ]
  }
}

// AM-48 — signal 1: >= 3 IMAGE_BUILD_STUCK occurrences for the SAME buildId
// within a 15-minute window. See this file's header comment for the full
// query/threshold/cadence rationale.
resource imageBuildStuckAlert 'Microsoft.Insights/scheduledQueryRules@2023-12-01' = {
  name: 'alert-image-build-stuck-${environmentName}'
  location: location
  tags: tags
  kind: 'LogAlert'
  properties: {
    displayName: 'AVD Manager — Image build stuck (${environmentName})'
    description: 'IMAGE_BUILD_STUCK logged 3+ times for the same buildId within 15 minutes — the image-build timer (imageBuildTimer.ts) or an operator-gate advance (imageBuilds.ts) is failing to make progress on this build, and its build VM is still running and billing. First actions: open the build\'s detail page in the app, then check imageBuildTimer.ts\'s traces in this Log Analytics workspace for the correlationId on the most recent occurrence. See the golden-image runbook section 4.11 for the full response.'
    severity: 1
    enabled: true
    scopes: [
      logAnalyticsWorkspaceId
    ]
    evaluationFrequency: 'PT5M'
    windowSize: 'PT15M'
    criteria: {
      allOf: [
        {
          query: imageBuildStuckQuery
          timeAggregation: 'Maximum'
          metricMeasureColumn: 'AggregatedValue'
          dimensions: [
            {
              name: 'buildId'
              operator: 'Include'
              values: [
                '*'
              ]
            }
          ]
          operator: 'GreaterThanOrEqual'
          threshold: 3
        }
      ]
    }
    autoMitigate: true
    actions: {
      actionGroups: [
        actionGroup.id
      ]
    }
  }
}

// AM-48 — signal 2: informational. See this file's header comment and
// imageBuildOrchestrator.ts's logCleanupSelfHeal doc comment for why this
// fires at low severity on any single occurrence rather than a
// repeated-pattern threshold.
resource imageBuildCleanupSelfHealAlert 'Microsoft.Insights/scheduledQueryRules@2023-12-01' = {
  name: 'alert-image-build-cleanup-selfheal-${environmentName}'
  location: location
  tags: tags
  kind: 'LogAlert'
  properties: {
    displayName: 'AVD Manager — Image build cleanup self-heal (${environmentName})'
    description: 'IMAGE_BUILD_CLEANUP_SELFHEAL logged at least once in the last hour — the AM-46 dependency-ordered cleanup path (imageBuildOrchestrator.ts pollCleanup) re-submitted a previously-FAILED delete_build_vm/delete_build_nic/delete_build_disk step. Informational: the system is working as designed. Investigate only if this recurs persistently for the SAME build — that would suggest the underlying delete keeps failing rather than eventually succeeding.'
    severity: 3
    enabled: true
    scopes: [
      logAnalyticsWorkspaceId
    ]
    evaluationFrequency: 'PT15M'
    windowSize: 'PT1H'
    criteria: {
      allOf: [
        {
          query: cleanupSelfHealQuery
          timeAggregation: 'Maximum'
          metricMeasureColumn: 'AggregatedValue'
          dimensions: [
            {
              name: 'buildId'
              operator: 'Include'
              values: [
                '*'
              ]
            }
          ]
          operator: 'GreaterThanOrEqual'
          threshold: 1
        }
      ]
    }
    autoMitigate: true
    actions: {
      actionGroups: [
        actionGroup.id
      ]
    }
  }
}

output actionGroupId string = actionGroup.id
output imageBuildStuckAlertId string = imageBuildStuckAlert.id
output imageBuildCleanupSelfHealAlertId string = imageBuildCleanupSelfHealAlert.id
