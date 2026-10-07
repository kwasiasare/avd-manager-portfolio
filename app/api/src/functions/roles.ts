import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { verifyBackendSecret } from '../lib/auth';
import { getConfig } from '../lib/config';
import { hasGroupsOverage, resolveRoles, type RolesSourceRequestBody } from '../lib/roles';

/**
 * SWA `rolesSource` custom-roles function. Azure Static Web Apps invokes
 * this as an HTTP **POST** during login (before the client principal has
 * any app roles assigned) with a JSON body containing the user's claims —
 * see https://learn.microsoft.com/azure/static-web-apps/authentication-custom#roles.
 * (Note: this deviates from "GET /api/roles" in the story text — SWA's
 * documented rolesSource contract is POST-only; registered as POST here to
 * match what SWA actually calls. Flagged for the deploy step to confirm.)
 *
 * Anonymous-reachable by design (see app/frontend/staticwebapp.config.json's
 * `/api/roles` route + `auth.rolesSource` config) — a role-gated route would
 * be circular, since this endpoint is what *produces* the caller's roles.
 * Also calls verifyBackendSecret (app/api/src/lib/auth.ts) for consistency
 * with every other route, but that check is a no-op unless
 * REQUIRE_BACKEND_SECRET=true is explicitly set — SWA's rolesSource POST has
 * no sender for a custom header (see verifyBackendSecret's doc comment), so
 * requiring it here by default would 401 SWA's own login-time call and break
 * sign-in entirely. The real protection for this route is that Microsoft
 * Entra/SWA stops routing external HTTP requests to a configured
 * rolesSource function at all — this is platform behavior, not something
 * this code enforces.
 *
 * Requires either the Entra app registration's groups claim to be enabled,
 * or a Microsoft Graph GroupMember.Read.All lookup added later — see
 * docs/app-registration.md section 3.
 */
export async function roles(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  if (!verifyBackendSecret(request)) {
    context.warn('roles: denied — invalid or missing backend secret');
    return { status: 401, jsonBody: { status: 401, code: 'unauthenticated', message: 'Authentication required.' } };
  }

  let body: RolesSourceRequestBody;
  try {
    body = ((await request.json()) ?? {}) as RolesSourceRequestBody;
  } catch {
    context.warn('roles: request body was not valid JSON; treating as no claims');
    body = {};
  }

  if (hasGroupsOverage(body)) {
    context.warn(
      `roles: groups-overage claim detected for userId=${body.userId ?? 'unknown'} — the token could not list this user's Entra groups directly (too many memberships). ` +
        "Group-to-role mapping will resolve to zero roles for this user until a Microsoft Graph GroupMember.Read.All lookup is added — see docs/app-registration.md section 4.",
    );
  }

  const config = getConfig();
  const userRoles = resolveRoles(body, config);

  context.log(`roles: resolved ${userRoles.length} role(s) for userId=${body.userId ?? 'unknown'}`);

  return { status: 200, jsonBody: { roles: userRoles } };
}

app.http('roles', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'roles',
  handler: roles,
});
