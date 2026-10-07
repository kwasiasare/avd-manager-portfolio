import { randomUUID } from 'node:crypto';
import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import type { ApiError } from '@avdmgr/shared';
import { requireRole } from '../lib/auth';
import { getCostSummary } from '../services/costService';

/**
 * Month-to-date spend by resource group, prior-month same-period
 * comparison, and a simple linear month-end projection — see
 * app/api/src/services/costService.ts for the query design and the ~5min
 * in-memory cache (Cost Management is slow/rate-limited; see that file's
 * top comment for the cold-start caveat on Flex Consumption). AM-39: on an
 * upstream failure, getCostSummary itself falls back to serving the last
 * successful result with `stale: true` rather than throwing — the 502
 * below is now reached only when there has NEVER been a successful fetch.
 */
export async function costSummary(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const authResult = requireRole(request, ['viewer', 'operator', 'admin'], context);
  if (!authResult.ok) {
    return authResult.response;
  }

  try {
    const summary = await getCostSummary(
      (message) => context.warn(message),
      (message) => context.log(message),
    );
    // AM-40 peer review MINOR 3 — a stale-serve is a 200, not a 5xx, so it
    // would otherwise be invisible to any 5xx-based alerting on this route.
    // Logged at context.error (not warn/log) specifically so it stays
    // alertable, with a stable, greppable marker matching this repo's
    // existing MARKER_NAME | key=value idiom (see e.g. AUDIT_MISCONFIGURED,
    // IMAGE_BUILD_STUCK, ROLLOUT_SENTINEL_CLEANUP_FAILED elsewhere in
    // app/api/src/functions).
    if (summary.stale) {
      context.error(`COST_STALE_SERVED | computedAt=${summary.computedAt} — Cost Management refresh failed; serving the last successful cached cost summary instead of a 5xx.`);
    }
    return { status: 200, jsonBody: summary };
  } catch (error) {
    const correlationId = randomUUID();
    context.error(`cost summary lookup failed | correlationId=${correlationId}`, error);
    const apiError: ApiError = {
      status: 502,
      code: 'cost_summary_lookup_failed',
      message: `Failed to retrieve the cost summary from Azure. Reference: ${correlationId}`,
      details: { correlationId },
    };
    return { status: 502, jsonBody: apiError };
  }
}

app.http('costSummary', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'v1/cost/summary',
  handler: costSummary,
});
