import { randomUUID } from 'node:crypto';
import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import type { ApiError } from '@avdmgr/shared';
import { requireRole } from '../lib/auth';
import { getImageVersionsReport } from '../services/imagesService';

/**
 * AM-26 (M4-S1): full version timeline for the configured image
 * definition — every published version (not just "latest", which GET
 * /v1/images/current already covers), newest-first, with each session
 * host's underlying VM correlated to the version it was created from. See
 * app/api/src/services/imagesService.ts#getImageVersionsReport for the
 * mapping/correlation logic and its per-host degrade-to-'unknown source'
 * behavior (never fails the whole request over one host's VM read).
 */
export async function imagesVersions(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const authResult = requireRole(request, ['viewer', 'operator', 'admin'], context);
  if (!authResult.ok) {
    return authResult.response;
  }

  try {
    const report = await getImageVersionsReport({ warn: (message) => context.warn(message) });
    return { status: 200, jsonBody: report };
  } catch (error) {
    const correlationId = randomUUID();
    context.error(`image version timeline lookup failed | correlationId=${correlationId}`, error);
    const apiError: ApiError = {
      status: 502,
      code: 'image_versions_lookup_failed',
      message: `Failed to retrieve the image version timeline from Azure. Reference: ${correlationId}`,
      details: { correlationId },
    };
    return { status: 502, jsonBody: apiError };
  }
}

app.http('imagesVersions', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'v1/images/versions',
  handler: imagesVersions,
});
