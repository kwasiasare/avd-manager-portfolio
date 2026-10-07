import { randomUUID } from 'node:crypto';
import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import type { ApiError } from '@avdmgr/shared';
import { requireRole } from '../lib/auth';
import { getSavingsOpportunities } from '../services/savingsService';

/**
 * 1-3 server-derived savings/cost-scaling callouts (typed
 * SavingsOpportunity items — see @avdmgr/shared), composed from the same
 * data as the other /v1/cost/* endpoints: idle-host findings,
 * StartVMOnConnect state, and 7-day running-hours outliers. See
 * app/api/src/services/savingsService.ts#deriveSavingsOpportunities for the
 * pure derivation logic (unit tested).
 */
export async function costSavings(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const authResult = requireRole(request, ['viewer', 'operator', 'admin'], context);
  if (!authResult.ok) {
    return authResult.response;
  }

  try {
    const opportunities = await getSavingsOpportunities(
      (message) => context.warn(message),
      (message) => context.log(message),
    );
    return { status: 200, jsonBody: opportunities };
  } catch (error) {
    const correlationId = randomUUID();
    context.error(`savings opportunities lookup failed | correlationId=${correlationId}`, error);
    const apiError: ApiError = {
      status: 502,
      code: 'savings_lookup_failed',
      message: `Failed to derive savings opportunities. Reference: ${correlationId}`,
      details: { correlationId },
    };
    return { status: 502, jsonBody: apiError };
  }
}

app.http('costSavings', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'v1/cost/savings',
  handler: costSavings,
});
