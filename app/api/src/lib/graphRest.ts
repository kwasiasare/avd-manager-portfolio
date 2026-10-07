import { RestClientError, isRestForbidden, isRestNotFound, restGet, restList } from './restClient';

/*
 * AM-16 (M3b) — thin Microsoft Graph-flavored wrapper over
 * lib/restClient.ts's shared core (peer review item 19 — see armRest.ts's
 * matching header comment for the full "why one shared core" reasoning).
 *
 * STALE NOTE (fixed AM-52): this file's doc comment used to claim a single
 * Graph consumer (the CA-policy-exclusion governance check) — that stopped
 * being true as of AM-14 (accessService.ts's user/group search + principal
 * resolution), AM-13 (fslogixProfilesService.ts's orphan-detection group
 * membership check), and now AM-52 (intunePolicyHealthService.ts's per-host
 * Intune managed-device/config-state reads). Every consumer still shares
 * this SAME plain-authenticated-fetch wrapper rather than each pulling in
 * its own @microsoft/microsoft-graph-client dependency — the "one shared
 * core, parameterized" reasoning above applies identically regardless of
 * consumer count. See docs/app-registration.md section 9 for the full,
 * consolidated table of every Graph APPLICATION permission this app now
 * holds/needs, one row per consumer.
 *
 * AUTH: DefaultAzureCredential against the Graph resource
 * (graph.microsoft.com/.default) — the SAME managed identity every other
 * service in this app authenticates as, just a different token audience.
 * Unlike every ARM-scoped grant this app holds (Azure RBAC role
 * ASSIGNMENTS — see infra/modules/rbac.bicep), every Graph permission this
 * file's callers use is an APPLICATION PERMISSION (an app role assignment
 * on the managed identity's OWN service principal against the Microsoft
 * Graph service principal) — an Entra-side grant Bicep/ARM cannot express.
 * See docs/app-registration.md section 9 for the manual az CLI grant each
 * one requires.
 */

const GRAPH_BASE_URL = 'https://graph.microsoft.com/v1.0';
const GRAPH_TOKEN_SCOPE = 'https://graph.microsoft.com/.default';

export const GraphRestError = RestClientError;
export const isGraphForbidden = isRestForbidden;
/** AM-14 (M6): distinguishes "Graph doesn't have this specific object" (e.g. a principalId on a stale role assignment whose Entra object was since deleted) from isGraphForbidden's "we don't have permission at all" — see accessService.ts#resolvePrincipal. */
export const isGraphNotFound = isRestNotFound;

/**
 * GETs a Graph collection endpoint (a `{ value: [...] }` envelope),
 * following `@odata.nextLink` pagination. Returns `{ items, truncated }` —
 * see armRest.ts#armList's doc comment for why this shape is never a bare
 * array. Throws GraphRestError on ANY non-2xx response (unlike armList's
 * default, this has no treat404AsEmpty use case: conditionalAccess/policies
 * never 404s for a valid tenant, so a 404 here would indicate a genuine
 * problem — wrong endpoint, wrong Graph version — worth surfacing loudly).
 */
export async function graphListAll<T>(path: string): Promise<{ items: T[]; truncated: boolean }> {
  const url = `${GRAPH_BASE_URL}${path}`;
  return restList<T>(url, GRAPH_TOKEN_SCOPE, '@odata.nextLink');
}

/**
 * AM-14 (M6) — GETs a single Graph resource (e.g. `/users/{id}` or
 * `/groups/{id}`), for resolving one role-assignment principalId to a
 * display name (see accessService.ts#resolvePrincipal). Returns `undefined`
 * on a 404 (the object no longer exists in Entra — see isGraphNotFound's
 * doc comment) rather than throwing; throws GraphRestError on every OTHER
 * non-2xx, same 404-is-special/everything-else-throws contract as
 * armRest.ts#armGet.
 */
export async function graphGet<T>(path: string): Promise<T | undefined> {
  const url = `${GRAPH_BASE_URL}${path}`;
  return restGet<T>(url, GRAPH_TOKEN_SCOPE);
}
