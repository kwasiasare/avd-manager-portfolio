import { randomUUID } from 'node:crypto';
import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import type { ApiError } from '@avdmgr/shared';
import { requireRole } from '../lib/auth';
import { listHostPools } from '../services/avdService';

export async function hostpools(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const authResult = requireRole(request, ['viewer', 'operator', 'admin'], context);
  if (!authResult.ok) {
    return authResult.response;
  }

  try {
    const pools = await listHostPools();
    return { status: 200, jsonBody: pools };
  } catch (error) {
    // Never return raw ARM error text to the client — it can leak resource
    // names/subscription details. Log the full error server-side (queryable
    // by correlationId in App Insights) and hand the client only a
    // correlation id to report back.
    const correlationId = randomUUID();
    context.error(`hostpools list failed | correlationId=${correlationId}`, error);
    const apiError: ApiError = {
      status: 502,
      code: 'hostpools_list_failed',
      message: `Failed to retrieve host pools from Azure. Reference: ${correlationId}`,
      details: { correlationId },
    };
    return { status: 502, jsonBody: apiError };
  }
}

app.http('hostpools', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'v1/hostpools',
  handler: hostpools,
});
