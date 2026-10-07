import { randomUUID } from 'node:crypto';
import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import type { AccessSearchResponse, ApiError } from '@avdmgr/shared';
import { requireMinimumRole } from '../lib/auth';
import { badRequest } from '../lib/validation';
import { searchPrincipals } from '../services/accessService';

/** Below this, a prefix search against a tenant's whole user/group directory is too broad to be useful and needlessly expensive on every keystroke. */
const MIN_QUERY_LENGTH = 2;
const MAX_QUERY_LENGTH = 100;

/**
 * AM-14 (M6): GET /v1/access/search?q= — user/group typeahead for the
 * Users & Access page's assign flow, backed by Microsoft Graph
 * (accessService.ts#searchPrincipals). Requires at least the 'operator'
 * role — narrower than most GETs in this app (viewer+), because this
 * endpoint's whole purpose is finding a principal to grant desktop access
 * to, a step only an operator/admin ever takes (a viewer has no use for
 * it and no route in the UI reaches it — see UsersAccess.tsx's RoleGate).
 *
 * Never audited: a directory search is not itself a mutation (see
 * app/api/src/lib/auditLog.ts's model — only POST/PATCH/DELETE handlers in
 * this app write audit rows), matching every other read-only GET here
 * (e.g. governance.ts, scalingHistory.ts).
 *
 * Degrades gracefully (200, not 5xx) when Microsoft Graph's User.Read.All /
 * GroupMember.Read.All application permissions haven't been granted yet —
 * see AccessSearchResponse.graphAvailable and docs/app-registration.md
 * section 9 for the one-time manual grant this needs.
 */
export async function accessSearch(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const correlationId = randomUUID();

  const authResult = requireMinimumRole(request, 'operator', context);
  if (!authResult.ok) {
    return authResult.response;
  }

  const rawQuery = request.query.get('q');
  if (!rawQuery || rawQuery.trim().length < MIN_QUERY_LENGTH) {
    return badRequest('query_too_short', `q is required and must be at least ${MIN_QUERY_LENGTH} characters.`);
  }
  const query = rawQuery.trim();
  if (query.length > MAX_QUERY_LENGTH) {
    return badRequest('query_too_long', `q must be ${MAX_QUERY_LENGTH} characters or fewer.`);
  }

  try {
    const responseBody: AccessSearchResponse = await searchPrincipals(query);
    return { status: 200, jsonBody: responseBody };
  } catch (error) {
    // AM-14 peer review (fix 17): never log the raw search text — it's
    // caller-supplied and can contain a name/email fragment (PII); log its
    // length only, joinable back to the actual query via correlationId in
    // Application Insights if a support investigation genuinely needs it.
    context.error(`access search failed | queryLength=${query.length} correlationId=${correlationId}`, error);
    const apiError: ApiError = {
      status: 502,
      code: 'access_search_failed',
      message: `Failed to search Microsoft Graph. Reference: ${correlationId}`,
      details: { correlationId },
    };
    return { status: 502, jsonBody: apiError };
  }
}

app.http('accessSearch', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'v1/access/search',
  handler: accessSearch,
});
