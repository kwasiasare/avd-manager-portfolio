import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { requireMinimumRole } from '../lib/auth';
import { listCuratedViews } from '../services/logsService';

/** GET /v1/logs/views — lists the four curated KQL views (id/name/description only, not the KQL text). Viewer+. */
export async function logsViews(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const authResult = requireMinimumRole(request, 'viewer', context);
  if (!authResult.ok) {
    return authResult.response;
  }

  return { status: 200, jsonBody: listCuratedViews() };
}

app.http('logsViews', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'v1/logs/views',
  handler: logsViews,
});
