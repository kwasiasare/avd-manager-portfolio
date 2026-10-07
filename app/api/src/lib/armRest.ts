import { RestClientError, isRestConflict, isRestForbidden, isRestNotFound, restDelete, restGet, restList, restPut, type RestListOptions, type RestListResult } from './restClient';

/*
 * AM-16 (M3b) — thin ARM-flavored wrapper over lib/restClient.ts's shared
 * core (peer review item 19: dedupe armRest/graphRest onto one restClient
 * core, parameterized by base URL / token scope / 404 policy — this file
 * now owns only the ARM-specific constants and re-exports). See
 * restClient.ts's header comment for why this is a plain authenticated-
 * fetch helper rather than another @azure/arm-* SDK package: the governance
 * registry reads across five ARM resource providers this app had never
 * touched before, each a simple, infrequent (10min-cached) GET/LIST against
 * a stable REST surface.
 */

const ARM_BASE_URL = 'https://management.azure.com';
const ARM_TOKEN_SCOPE = 'https://management.azure.com/.default';

export const ArmRestError = RestClientError;
export const isArmNotFound = isRestNotFound;
export const isArmForbidden = isRestForbidden;
/** AM-14 peer review (fix 8): ARM 409 Conflict — e.g. RoleAssignmentExists when creating a role assignment that already exists for this principal/role/scope. */
export const isArmConflict = isRestConflict;

/**
 * GETs a single ARM resource. `resourcePath` is the resource id (starting
 * `/subscriptions/...`), WITHOUT a leading api-version query string —
 * supplied separately so every call site states the api-version it was
 * verified against explicitly (see each services/governance/*.ts file's
 * Microsoft Learn citation), rather than a shared default silently drifting
 * out of date for one resource type while staying correct for another.
 * Returns `undefined` on a 404; throws ArmRestError on any other non-2xx.
 */
export async function armGet<T>(resourcePath: string, apiVersion: string): Promise<T | undefined> {
  const url = `${ARM_BASE_URL}${resourcePath}?api-version=${encodeURIComponent(apiVersion)}`;
  return restGet<T>(url, ARM_TOKEN_SCOPE);
}

/**
 * LISTs an ARM collection, following `nextLink` pagination. Returns
 * `{ items, truncated }` — NEVER a bare array — so a page-ceiling cutoff is
 * never silently indistinguishable from a genuinely complete list (peer
 * review item 6); every call site must read and surface `truncated`.
 *
 * 404 handling defaults to THROW (peer review item 5): a renamed/deleted
 * resource group or resource must surface as a real error, not a silent
 * empty result a scanner would read as "nothing to report." Pass
 * `{ treat404AsEmpty: true }` only for extension-resource collections
 * scoped to a specific, already-known-to-exist parent resource
 * (diagnosticSettings, locks) where "this resource doesn't support/have
 * any of these" is itself a normal, meaningful empty state — see
 * RestListOptions.treat404AsEmpty's own doc comment for the full
 * reasoning.
 */
export async function armList<T>(resourcePath: string, apiVersion: string, options: RestListOptions = {}): Promise<RestListResult<T>> {
  const url = `${ARM_BASE_URL}${resourcePath}?api-version=${encodeURIComponent(apiVersion)}`;
  return restList<T>(url, ARM_TOKEN_SCOPE, 'nextLink', options);
}

/**
 * AM-14 (M6) — LISTs an ARM collection with an additional `$filter` query
 * parameter, e.g. `atScope()` (see Microsoft Learn's "List Azure role
 * assignments using the REST API": `$filter=atScope()` "Lists role
 * assignments for only the specified scope, not including the role
 * assignments at subscopes"). A separate function from armList above rather
 * than widening it with an optional filter param — every EXISTING armList
 * call site in this app (the governance registry) has no filter need, and
 * this app's only `$filter` consumer (accessService.ts#listDesktopAssignments)
 * wants the value validated as coming from a fixed, code-controlled set of
 * ARM filter expressions, not general query-string composition. `filter` is
 * NOT further escaped beyond encodeURIComponent — every call site in this
 * app passes a compile-time-fixed string (e.g. 'atScope()'), never
 * user-supplied input, so OData-injection is not a concern here the way it
 * would be for e.g. auditLog.ts's queryRecentAuditEntries (which uses the
 * `odata` tagged template specifically because ITS filter values include
 * caller-influenced strings).
 */
export async function armListAtScope<T>(resourcePath: string, apiVersion: string, filter: string): Promise<RestListResult<T>> {
  const url = `${ARM_BASE_URL}${resourcePath}?api-version=${encodeURIComponent(apiVersion)}&$filter=${encodeURIComponent(filter)}`;
  return restList<T>(url, ARM_TOKEN_SCOPE, 'nextLink');
}

/**
 * AM-14 (M6) — PUTs a specific-named ARM resource (e.g.
 * `.../roleAssignments/{generatedGuid}` — see Microsoft Learn's "Assign
 * Azure roles using the REST API"). Unlike armGet/armList, `resourcePath`
 * here already names the FULL resource (including its own id segment), not
 * a collection — the api-version query string is still appended the same
 * way. Throws ArmRestError on any non-2xx.
 */
export async function armPut<T>(resourcePath: string, apiVersion: string, body: unknown): Promise<T> {
  const url = `${ARM_BASE_URL}${resourcePath}?api-version=${encodeURIComponent(apiVersion)}`;
  return restPut<T>(url, ARM_TOKEN_SCOPE, body);
}

/**
 * AM-14 (M6) — DELETEs a specific-named ARM resource. A 404 is treated as
 * success (idempotent delete — see restDelete's doc comment); any other
 * non-2xx (including a 403 from an ABAC condition rejecting the delete —
 * see infra/modules/dagUserAccessAdministratorRole.bicep) throws
 * ArmRestError.
 */
export async function armDelete(resourcePath: string, apiVersion: string): Promise<void> {
  const url = `${ARM_BASE_URL}${resourcePath}?api-version=${encodeURIComponent(apiVersion)}`;
  return restDelete(url, ARM_TOKEN_SCOPE);
}
