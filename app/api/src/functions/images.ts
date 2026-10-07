import { randomUUID } from 'node:crypto';
import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import type { ApiError } from '@avdmgr/shared';
import { requireRole } from '../lib/auth';
import { getCurrentImageVersion } from '../services/imagesService';

export async function imagesCurrent(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const authResult = requireRole(request, ['viewer', 'operator', 'admin'], context);
  if (!authResult.ok) {
    return authResult.response;
  }

  try {
    const version = await getCurrentImageVersion();
    if (!version) {
      const apiError: ApiError = {
        status: 404,
        code: 'image_version_not_found',
        message: 'The configured image definition has no published versions.',
      };
      return { status: 404, jsonBody: apiError };
    }
    return { status: 200, jsonBody: version };
  } catch (error) {
    const correlationId = randomUUID();
    context.error(`image version lookup failed | correlationId=${correlationId}`, error);
    const apiError: ApiError = {
      status: 502,
      code: 'image_version_lookup_failed',
      message: `Failed to retrieve the image version from Azure. Reference: ${correlationId}`,
      details: { correlationId },
    };
    return { status: 502, jsonBody: apiError };
  }
}

app.http('imagesCurrent', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'v1/images/current',
  handler: imagesCurrent,
});
