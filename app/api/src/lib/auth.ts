import type { HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import type { Role } from '@avdmgr/shared';

/**
 * Shape of the decoded x-ms-client-principal header that Azure Static Web
 * Apps / EasyAuth injects into every request forwarded to a linked API.
 * See: https://learn.microsoft.com/azure/static-web-apps/user-information
 */
export interface ClientPrincipal {
  identityProvider: string;
  userId: string;
  userDetails: string;
  userRoles: string[];
}

const VALID_ROLES: readonly Role[] = ['viewer', 'operator', 'admin'];

/** Case-insensitively validates a raw role string against the Role union, or returns null. */
function normalizeRole(value: unknown): Role | null {
  if (typeof value !== 'string') {
    return null;
  }
  const lower = value.trim().toLowerCase();
  return (VALID_ROLES as readonly string[]).includes(lower) ? (lower as Role) : null;
}

/**
 * Parses the x-ms-client-principal header (base64-encoded JSON) that SWA
 * attaches to requests once a user is authenticated. Returns null if the
 * header is missing or malformed (i.e. an anonymous/direct request).
 *
 * Defensive about shape: a header that decodes to valid base64/JSON but
 * isn't actually a ClientPrincipal (e.g. `"null"`, `"[]"`, or an object
 * missing userRoles) is treated the same as "no header".
 */
export function getClientPrincipal(request: HttpRequest): ClientPrincipal | null {
  const header = request.headers.get('x-ms-client-principal');
  if (!header) {
    return null;
  }

  let decoded: string;
  try {
    decoded = Buffer.from(header, 'base64').toString('utf-8');
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }

  const candidate = parsed as Partial<ClientPrincipal>;
  if (!Array.isArray(candidate.userRoles)) {
    return null;
  }

  return {
    identityProvider: typeof candidate.identityProvider === 'string' ? candidate.identityProvider : 'unknown',
    userId: typeof candidate.userId === 'string' ? candidate.userId : 'unknown',
    userDetails: typeof candidate.userDetails === 'string' ? candidate.userDetails : 'unknown',
    userRoles: candidate.userRoles.filter((role): role is string => typeof role === 'string'),
  };
}

/**
 * Verifies the `x-swa-backend-secret` header against the SWA_BACKEND_SECRET
 * app setting — gated behind REQUIRE_BACKEND_SECRET (default/unset = false,
 * i.e. the check is SKIPPED by default).
 *
 * Why default-off: this app's Function App is a *linked backend* (BYO
 * Function App), and SWA's linked-backend request forwarding only injects
 * `x-ms-client-principal` — it does not forward any custom header, so there
 * is no sender that would ever populate `x-swa-backend-secret` on a real
 * SWA-forwarded request. Requiring it unconditionally would 401 every
 * request, including SWA's own internal call to the rolesSource function
 * (`POST /api/roles`, see app/api/src/functions/roles.ts) during login —
 * and per Microsoft's docs, once a rolesSource function is configured "it
 * can no longer be accessed by external HTTP requests" at all, so there is
 * no way to attach a shared-secret header to that call even if we wanted to.
 *
 * The REAL controls here are (a) getClientPrincipal below — a request
 * without a valid x-ms-client-principal is rejected regardless of this
 * setting — and (b) the "Azure Static Web Apps (Linked)" Easy Auth provider
 * the SWA linking process creates on the Function App (in prod the
 * ipSecurityRestrictions default action is Allow — linked backends must not
 * restrict inbound IPs; see docs/app-registration.md section 0.4). This
 * header check is additional defense-in-depth for an environment that DOES
 * have a way to send it (e.g. a future direct/non-SWA caller, or if SWA
 * ever adds custom-header forwarding for linked backends) — set
 * REQUIRE_BACKEND_SECRET=true to turn it on once such a sender exists.
 *
 * When REQUIRE_BACKEND_SECRET=true, this fails closed exactly as before: if
 * SWA_BACKEND_SECRET is unset, every request is rejected — UNLESS
 * NODE_ENV === 'development' AND ALLOW_INSECURE_LOCAL_AUTH === 'true' are
 * BOTH set (an explicit local-dev opt-in only; the deploy pipelines never
 * set ALLOW_INSECURE_LOCAL_AUTH).
 */
export function verifyBackendSecret(request: HttpRequest): boolean {
  if (process.env.REQUIRE_BACKEND_SECRET !== 'true') {
    return true;
  }

  const expected = process.env.SWA_BACKEND_SECRET;

  if (!expected) {
    return process.env.NODE_ENV === 'development' && process.env.ALLOW_INSECURE_LOCAL_AUTH === 'true';
  }

  const provided = request.headers.get('x-swa-backend-secret');
  return provided === expected;
}

export type RequireRoleResult = { ok: true; principal: ClientPrincipal } | { ok: false; response: HttpResponseInit };

function unauthenticated(): HttpResponseInit {
  return {
    status: 401,
    jsonBody: { status: 401, code: 'unauthenticated', message: 'Authentication required.' },
  };
}

function routeFromRequest(request: HttpRequest): string {
  try {
    return new URL(request.url).pathname;
  } catch {
    return request.url;
  }
}

/**
 * Enforces that the caller is authenticated (a valid x-ms-client-principal,
 * plus the backend secret when REQUIRE_BACKEND_SECRET=true — see
 * verifyBackendSecret) and holds one of `roles`. Every 401/403 denial is
 * logged via context.warn with the principal id (or 'anonymous') and route,
 * for audit/troubleshooting.
 *
 *   const authResult = requireRole(request, ['operator', 'admin'], context);
 *   if (!authResult.ok) return authResult.response; // already logged
 *   const { principal } = authResult;
 */
export function requireRole(request: HttpRequest, roles: Role[], context: InvocationContext): RequireRoleResult {
  return requireRoleImpl(request, roles, context);
}

/**
 * Role hierarchy this app enforces everywhere: viewer < operator < admin
 * (see app/README.md's Roles section). Order matters — rolesAtOrAbove below
 * slices from a role's index to the end.
 */
const ROLE_HIERARCHY: readonly Role[] = ['viewer', 'operator', 'admin'];

/** Expands a minimum role into itself plus every role above it in ROLE_HIERARCHY. */
function rolesAtOrAbove(minimumRole: Role): Role[] {
  const index = ROLE_HIERARCHY.indexOf(minimumRole);
  return index === -1 ? [minimumRole] : [...ROLE_HIERARCHY.slice(index)];
}

/**
 * The mutation guard: every M2 mutating handler (drain toggle, and whatever
 * follows it) calls this instead of requireRole directly, so the caller
 * states its policy as "at least operator" rather than re-deriving the
 * role list by hand. Built on requireRole/ROLE_HIERARCHY above — a viewer
 * (or unauthenticated caller) requesting an operator-or-higher route gets
 * the same 403/401 shape requireRole already produces, logged the same way.
 *
 *   const authResult = requireMinimumRole(request, 'operator', context);
 *   if (!authResult.ok) return authResult.response; // already logged
 *   const { principal } = authResult;
 */
export function requireMinimumRole(request: HttpRequest, minimumRole: Role, context: InvocationContext): RequireRoleResult {
  return requireRoleImpl(request, rolesAtOrAbove(minimumRole), context);
}

function requireRoleImpl(request: HttpRequest, roles: Role[], context: InvocationContext): RequireRoleResult {
  const route = routeFromRequest(request);

  if (!verifyBackendSecret(request)) {
    context.warn(`auth denied: invalid or missing backend secret | principal=anonymous route=${route}`);
    return { ok: false, response: unauthenticated() };
  }

  const principal = getClientPrincipal(request);
  if (!principal) {
    context.warn(`auth denied: missing or invalid client principal | principal=anonymous route=${route}`);
    return { ok: false, response: unauthenticated() };
  }

  const normalizedRoles = principal.userRoles.map(normalizeRole).filter((role): role is Role => role !== null);
  const hasRole = normalizedRoles.some((role) => roles.includes(role));

  if (!hasRole) {
    context.warn(
      `auth denied: insufficient role | principal=${principal.userId} route=${route} ` +
        `roles=[${principal.userRoles.join(',')}] required=[${roles.join(',')}]`,
    );
    return {
      ok: false,
      response: {
        status: 403,
        jsonBody: {
          status: 403,
          code: 'forbidden',
          message: `Requires one of roles: ${roles.join(', ')}.`,
        },
      },
    };
  }

  return { ok: true, principal };
}
