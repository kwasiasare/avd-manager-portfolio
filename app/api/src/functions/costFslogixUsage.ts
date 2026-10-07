import { randomUUID } from 'node:crypto';
import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import type { ApiError } from '@avdmgr/shared';
import { requireRole } from '../lib/auth';
import { getFslogixShareUsage } from '../services/fslogixService';

/** Provisioned-vs-used stats for the FSLogix profile share (stcontoso001/fslogixprofiles). */
export async function costFslogixUsage(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const authResult = requireRole(request, ['viewer', 'operator', 'admin'], context);
  if (!authResult.ok) {
    return authResult.response;
  }

  try {
    const usage = await getFslogixShareUsage();
    return { status: 200, jsonBody: usage };
  } catch (error) {
    const correlationId = randomUUID();
    context.error(`fslogix share usage lookup failed | correlationId=${correlationId}`, error);
    const apiError: ApiError = {
      status: 502,
      code: 'fslogix_usage_lookup_failed',
      message: `Failed to retrieve FSLogix share usage from Azure. Reference: ${correlationId}`,
      details: { correlationId },
    };
    return { status: 502, jsonBody: apiError };
  }
}

app.http('costFslogixUsage', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'v1/cost/fslogix-usage',
  handler: costFslogixUsage,
});
