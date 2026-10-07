import { randomUUID } from 'node:crypto';
import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import type { ApiError } from '@avdmgr/shared';
import { requireMinimumRole } from '../lib/auth';
import { listProfiles, type ProfilesServiceLogger } from '../services/fslogixProfilesService';

/**
 * AM-13 (M5): GET /v1/profiles — viewer+ (read-only). Lists active and
 * retired FSLogix profile VHD(X) entries on the profile share, with
 * oversized/orphan/lock annotations. See
 * services/fslogixProfilesService.ts#listProfiles for the full
 * design — it NEVER throws (a FileREST failure degrades the response to a
 * management-plane fallback rather than raising), so this handler's
 * try/catch is a defense-in-depth backstop for a genuinely unexpected bug,
 * not the primary error path.
 *
 * `context` is passed straight through as listProfiles' logger (peer
 * review item 14) — its `warn`/`error`/`log` methods structurally satisfy
 * ProfilesServiceLogger, so FileREST degradation and per-file lock-check
 * failures the service recovers from are still visible in Application
 * Insights, not silently swallowed.
 *
 * `?refresh=true` bypasses the service's short in-memory cache (peer
 * review item 6) — same convention as GET /v1/governance's forceRefresh
 * query param.
 */
export async function profilesList(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const authResult = requireMinimumRole(request, 'viewer', context);
  if (!authResult.ok) {
    return authResult.response;
  }

  const forceRefresh = request.query.get('refresh') === 'true';
  const logger: ProfilesServiceLogger = {
    warn: (message) => context.warn(message),
    error: (message, error) => context.error(message, error),
    log: (message) => context.log(message),
  };

  try {
    const result = await listProfiles({ forceRefresh, logger });
    return { status: 200, jsonBody: result };
  } catch (error) {
    const correlationId = randomUUID();
    const errorMessage = error instanceof Error ? error.message : String(error);
    context.error(`profiles list failed unexpectedly | correlationId=${correlationId} error=${errorMessage}`);
    const apiError: ApiError = {
      status: 502,
      code: 'profiles_list_failed',
      message: `Failed to list FSLogix profiles. Reference: ${correlationId}`,
      details: { correlationId },
    };
    return { status: 502, jsonBody: apiError };
  }
}

app.http('profilesList', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'v1/profiles',
  handler: profilesList,
});
