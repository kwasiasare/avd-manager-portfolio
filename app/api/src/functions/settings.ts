import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import type { ConfiguredStatus, SettingsResponse } from '@avdmgr/shared';
import { requireMinimumRole } from '../lib/auth';
import { getConfig } from '../lib/config';
import { getBuildInfo } from '../lib/buildInfo';

function configuredStatus(value: string | undefined): ConfiguredStatus {
  return value ? 'configured' : 'not-configured';
}

/**
 * AM-15 (M7) — GET /v1/settings, viewer+. Backs the Settings page's
 * "app configuration" card with a deliberately NARROW, non-secret slice of
 * this app's own Function App settings (see @avdmgr/shared's
 * SettingsResponse doc comment for exactly what's excluded and why —
 * subscription id, resource group names, and the group object ids
 * themselves are never returned here, only resource NAMEs an operator
 * already sees throughout the rest of the UI, plus CONFIGURED/NOT-CONFIGURED
 * status for the three role-mapping group ids).
 *
 * No ARM/Graph call, no cache needed — this is a synchronous read of
 * process.env via getConfig(), the same source every other route already
 * trusts.
 */
export async function settings(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const authResult = requireMinimumRole(request, 'viewer', context);
  if (!authResult.ok) {
    return authResult.response;
  }

  const config = getConfig();
  const buildInfo = getBuildInfo();

  const body: SettingsResponse = {
    // AM-54: artifact-sourced when available, app-setting fallback
    // otherwise — see @avdmgr/shared's SettingsResponse doc comment.
    apiVersion: buildInfo.version,
    ...(buildInfo.gitSha !== undefined ? { gitSha: buildInfo.gitSha } : {}),
    ...(buildInfo.builtAt !== undefined ? { builtAt: buildInfo.builtAt } : {}),
    versionSource: buildInfo.source,
    hostPoolName: config.hostPoolName,
    workspaceName: config.workspaceName,
    dagName: config.dagName,
    storage: {
      accountName: config.storage.accountName,
      fslogixShareName: config.storage.fslogixShareName,
    },
    profilesOversizedGb: config.profiles.oversizedGb,
    groupIds: {
      viewer: configuredStatus(config.groupIds.viewer),
      operator: configuredStatus(config.groupIds.operator),
      admin: configuredStatus(config.groupIds.admin),
    },
  };

  return { status: 200, jsonBody: body };
}

app.http('settings', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'v1/settings',
  handler: settings,
});
