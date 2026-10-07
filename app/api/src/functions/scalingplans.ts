import { randomUUID } from 'node:crypto';
import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import type { ApiError } from '@avdmgr/shared';
import { requireRole } from '../lib/auth';
import { getCurrentScalingPlan } from '../services/avdService';

export async function scalingPlansCurrent(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const authResult = requireRole(request, ['viewer', 'operator', 'admin'], context);
  if (!authResult.ok) {
    return authResult.response;
  }

  try {
    const plan = await getCurrentScalingPlan();
    if (!plan) {
      const apiError: ApiError = {
        status: 404,
        code: 'scaling_plan_not_found',
        message: 'No scaling plan is associated with the configured host pool.',
      };
      return { status: 404, jsonBody: apiError };
    }
    return { status: 200, jsonBody: plan };
  } catch (error) {
    const correlationId = randomUUID();
    context.error(`scaling plan lookup failed | correlationId=${correlationId}`, error);
    const apiError: ApiError = {
      status: 502,
      code: 'scaling_plan_lookup_failed',
      message: `Failed to retrieve the scaling plan from Azure. Reference: ${correlationId}`,
      details: { correlationId },
    };
    return { status: 502, jsonBody: apiError };
  }
}

app.http('scalingPlansCurrent', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'v1/scalingplans/current',
  handler: scalingPlansCurrent,
});
