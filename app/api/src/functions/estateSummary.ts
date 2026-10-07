import { randomUUID } from 'node:crypto';
import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import type { ApiError } from '@avdmgr/shared';
import { requireMinimumRole } from '../lib/auth';
import { getEstateSummary } from '../services/estateSummaryService';

/**
 * GET /v1/estate/summary (AM-29 item 26) — viewer+. Backs the EstateStrip
 * shown on every page: host/session health, current scaling phase, open
 * alert count, and emergency-override state, all from data this app's other
 * endpoints already compute (see estateSummaryService.ts) — no new Azure
 * calls beyond what those existing services already make.
 *
 * Unlike most of this app's GET handlers, this one does NOT 502 on a
 * sub-source failure — getEstateSummary degrades each segment
 * independently and never throws, so the strip always gets a 200 with
 * whatever segments it could resolve (see that function's own doc comment).
 * A 502 here would only ever mean something unexpected escaped that
 * function's own error handling.
 */
export async function estateSummary(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const authResult = requireMinimumRole(request, 'viewer', context);
  if (!authResult.ok) {
    return authResult.response;
  }

  try {
    const summary = await getEstateSummary((message) => context.warn(message));
    return { status: 200, jsonBody: summary };
  } catch (error) {
    const correlationId = randomUUID();
    context.error(`estate summary failed unexpectedly | correlationId=${correlationId}`, error);
    const apiError: ApiError = {
      status: 502,
      code: 'estate_summary_failed',
      message: `Failed to compute the estate summary. Reference: ${correlationId}`,
      details: { correlationId },
    };
    return { status: 502, jsonBody: apiError };
  }
}

app.http('estateSummary', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'v1/estate/summary',
  handler: estateSummary,
});
