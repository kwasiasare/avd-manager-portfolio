import { randomUUID } from 'node:crypto';
import type { AccessSearchResponse, AccessSearchResult, AssignmentsListResponse, DesktopAssignment, GraphDegradationReason, PrincipalType } from '@avdmgr/shared';
import { getConfig } from '../lib/config';
import { armDelete, armGet, armPut, armListAtScope } from '../lib/armRest';
import { graphGet, isGraphForbidden } from '../lib/graphRest';

/*
 * AM-14 (M6) — Users & access management: search for a user/group (Graph),
 * list/create/remove "Desktop Virtualization User" ARM role assignments on
 * the configured desktop application group (config.dagName).
 *
 * WHY REST (armRest.ts/graphRest.ts) RATHER THAN AN SDK: unlike every other
 * ARM write in this app (@azure/arm-desktopvirtualization,
 * @azure/arm-compute — see avdService.ts/computeService.ts), role
 * assignment writes have no existing SDK dependency in this repo, and
 * adding @azure/arm-authorization for exactly two calls (PUT/DELETE one
 * resource) would be a heavier dependency than this feature needs — see
 * armRest.ts's own header comment for the same "plain authenticated fetch
 * over a full SDK package" reasoning the AM-16 governance registry already
 * established for read-only ARM/Graph calls, extended here to these two
 * specific writes.
 *
 * ROLE DEFINITION GUID (verified via Microsoft Learn, "Built-in Azure RBAC
 * roles for Azure Virtual Desktop" — https://learn.microsoft.com/azure/virtual-desktop/rbac#desktop-virtualization-user):
 * "Desktop Virtualization User" = 1d18fff3-a72a-46b5-b4a9-0b38a3cd7e63.
 * THIS APP NEVER ACCEPTS A CALLER-SUPPLIED roleDefinitionId — see
 * @avdmgr/shared's CreateAssignmentRequest, which has no such field —
 * createDesktopAssignment below is the ONLY place this app ever constructs
 * a roleAssignments PUT body, and it always pins this exact constant. That
 * is the acceptance-criterion proof "attempting any other role via the API
 * fails": there is no code path through this app's API that can write any
 * OTHER roleDefinitionId (see accessService.test.ts). The ABAC condition on
 * this app's own Azure RBAC grant (infra/modules/dagUserAccessAdministratorRole.bicep)
 * additionally enforces the SAME constraint at the ARM layer — defense in
 * depth, not the only line of defense.
 *
 * PEER REVIEW (BLOCKER, fix 1): `$filter=atScope()` returns role
 * assignments "at OR ABOVE" the queried scope (verified on Microsoft
 * Learn's @azure/arm-authorization RoleAssignmentsListForScopeOptionalParams
 * reference) — so listDesktopAssignments below can legitimately return an
 * INHERITED grant made at a parent resource group or subscription scope,
 * not just ones this app itself created directly on the DAG. Every
 * assignment is tagged with its real `scope`/`assignedDirectlyOnDag`/
 * `assignedVia` (see describeScope below) so the UI never mislabels an
 * inherited grant as something this app can remove. removeDesktopAssignment
 * independently re-verifies scope+role via a pre-delete GET (see its own
 * doc comment) — it does NOT trust the list's tagging alone, since the two
 * are separate reads that could race with a concurrent external change.
 */
export const DESKTOP_VIRTUALIZATION_USER_ROLE_ID = '1d18fff3-a72a-46b5-b4a9-0b38a3cd7e63';

const ROLE_ASSIGNMENTS_API_VERSION = '2022-04-01';

/**
 * Caps the result set of a search PER TYPE (users, groups) — a debounced
 * typeahead has no use for more than a handful of matches. AM-14 peer
 * review (fix 2): search fetches exactly ONE Graph page per type (via
 * graphGet on the collection directly, NOT graphListAll, which follows
 * `@odata.nextLink` pagination up to 20 pages — the wrong tool for a
 * bounded-by-design typeahead) and explicitly `.slice()`s the result to
 * this cap as defense-in-depth beyond the `$top` query parameter (Graph is
 * documented to honor `$top` as a page-size cap, but this app does not rely
 * on that alone) — so every search is AT MOST two single-page Graph calls,
 * full stop, never more regardless of how many objects actually match.
 */
const MAX_SEARCH_RESULTS_PER_TYPE = 10;

/**
 * AM-14 peer review (fix 7): bounds how many Graph calls
 * listDesktopAssignments's principal-name resolution can have in flight at
 * once — see resolveAllPrincipals below. Considered
 * `POST /directoryObjects/getByIds` (a single BATCHED Graph call resolving
 * every principal at once — verified request/response shape on Microsoft
 * Learn: `{ ids: string[], types?: string[] }` -> `{ value: [...] }`) as
 * the alternative, but its documented LEAST-privileged permission is
 * `Directory.Read.All` (both delegated and application — "Not available"
 * for any narrower alternative), which is a materially BROADER Graph grant
 * than the `User.Read.All` + `GroupMember.Read.All` pair this app already
 * documents and requires (see docs/app-registration.md section 9) —
 * adopting it would mean asking an operator to grant a new, wider
 * permission just for this convenience. A small concurrency limiter
 * achieves the same fan-out-bounding goal with ZERO new permissions, at the
 * cost of N calls instead of 1 — an acceptable trade for a viewer+ page
 * that is not on any hot path. Revisit if Directory.Read.All is ever
 * granted for an unrelated reason.
 */
const RESOLVE_CONCURRENCY_LIMIT = 5;

/**
 * Escapes a single quote for safe interpolation into a Graph OData `$filter`
 * string literal (the doubled-single-quote escape OData itself defines —
 * same purpose as auditLog.ts's use of the `odata` tagged template for ARM
 * Table filters, applied here by hand since graphGet takes a plain path
 * string rather than a template-literal query builder).
 */
function escapeODataLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

function dagScope(): string {
  const { subscriptionId, resourceGroups, dagName } = getConfig();
  return `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroups.hostPools}/providers/Microsoft.DesktopVirtualization/applicationGroups/${dagName}`;
}

function roleAssignmentsCollectionPath(): string {
  return `${dagScope()}/providers/Microsoft.Authorization/roleAssignments`;
}

function roleDefinitionResourceId(): string {
  const { subscriptionId } = getConfig();
  return `/subscriptions/${subscriptionId}/providers/Microsoft.Authorization/roleDefinitions/${DESKTOP_VIRTUALIZATION_USER_ROLE_ID}`;
}

interface GraphUser {
  id?: string;
  displayName?: string;
  userPrincipalName?: string;
}

interface GraphGroup {
  id?: string;
  displayName?: string;
}

/** One page of a Graph collection response — `graphGet` returns this raw shape directly (unlike graphListAll, which unwraps+paginates it). `@odata.nextLink`'s presence is this app's own truncation signal (fix 4) when this app deliberately stops at one page. */
interface GraphCollectionPage<T> {
  value?: T[];
  '@odata.nextLink'?: string;
}

/**
 * Searches Microsoft Graph for users and groups whose displayName, UPN, or
 * (AM-14 peer review fix 18) mail address starts with `query` — GET
 * /v1/access/search?q= (AM-14, operator+ — see accessSearch.ts). `mail` is
 * included alongside displayName/userPrincipalName because a B2B guest's
 * userPrincipalName is often a mangled `user_domain.com#EXT#@tenant...`
 * value that an operator would never think to type — their actual email
 * (`mail`) is what's normally at hand. Requires the Graph APPLICATION
 * permissions User.Read.All + GroupMember.Read.All (verified on Microsoft
 * Learn — see docs/app-registration.md section 9); until granted, both
 * calls 403, and this function degrades to `{ results: [], graphAvailable:
 * false, graphDegradationReason: 'graph-permission-not-granted' }` rather
 * than throwing — same "Graph permission not granted" posture as
 * governance/conditionalAccessBreakGlass.ts's fetchConditionalAccessBreakGlass.
 *
 * The two Graph calls (users, groups) run independently: if EITHER 403s (a
 * single app registration either has both application roles granted or
 * neither, per how AM-14's manual grant step is documented — see
 * docs/app-registration.md — so in practice they fail together), the WHOLE
 * search degrades rather than silently returning only users or only groups.
 * Any OTHER (non-403) Graph error propagates as 'graph-error' the same way.
 */
export async function searchPrincipals(query: string): Promise<AccessSearchResponse> {
  const escaped = escapeODataLiteral(query);
  const usersPath = `/users?$filter=${encodeURIComponent(`startswith(displayName,'${escaped}') or startswith(userPrincipalName,'${escaped}') or startswith(mail,'${escaped}')`)}&$top=${MAX_SEARCH_RESULTS_PER_TYPE}&$select=id,displayName,userPrincipalName`;
  const groupsPath = `/groups?$filter=${encodeURIComponent(`startswith(displayName,'${escaped}')`)}&$top=${MAX_SEARCH_RESULTS_PER_TYPE}&$select=id,displayName`;

  let usersPage: GraphCollectionPage<GraphUser> | undefined;
  let groupsPage: GraphCollectionPage<GraphGroup> | undefined;
  try {
    [usersPage, groupsPage] = await Promise.all([graphGet<GraphCollectionPage<GraphUser>>(usersPath), graphGet<GraphCollectionPage<GraphGroup>>(groupsPath)]);
  } catch (error) {
    const reason: GraphDegradationReason = isGraphForbidden(error) ? 'graph-permission-not-granted' : 'graph-error';
    return { results: [], graphAvailable: false, graphDegradationReason: reason, truncated: false };
  }

  const userItems = (usersPage?.value ?? []).slice(0, MAX_SEARCH_RESULTS_PER_TYPE);
  const groupItems = (groupsPage?.value ?? []).slice(0, MAX_SEARCH_RESULTS_PER_TYPE);
  const truncated = Boolean(usersPage?.['@odata.nextLink']) || Boolean(groupsPage?.['@odata.nextLink']);

  const userResults: AccessSearchResult[] = userItems
    .filter((u): u is GraphUser & { id: string } => Boolean(u.id))
    .map((u) => ({ id: u.id, principalType: 'user' as PrincipalType, displayName: u.displayName ?? u.userPrincipalName ?? u.id, userPrincipalName: u.userPrincipalName }));
  const groupResults: AccessSearchResult[] = groupItems
    .filter((g): g is GraphGroup & { id: string } => Boolean(g.id))
    .map((g) => ({ id: g.id, principalType: 'group' as PrincipalType, displayName: g.displayName ?? g.id }));

  return { results: [...userResults, ...groupResults], graphAvailable: true, truncated };
}

interface ArmRoleAssignment {
  name?: string;
  properties?: {
    principalId?: string;
    principalType?: string;
    roleDefinitionId?: string;
    /** The ARM scope this assignment is actually made at — readonly on ARM's response, confirmed on Microsoft Learn ("Understand Azure role assignments" — Scope/`scope`: "The Azure resource identifier that the role assignment is scoped to"). See this module's header comment (fix 1) for why this can differ from the DAG when listing with atScope(). */
    scope?: string;
  };
}

function isDesktopVirtualizationUserAssignment(item: ArmRoleAssignment): boolean {
  const roleDefinitionId = item.properties?.roleDefinitionId;
  return typeof roleDefinitionId === 'string' && roleDefinitionId.toLowerCase().endsWith(`/roledefinitions/${DESKTOP_VIRTUALIZATION_USER_ROLE_ID.toLowerCase()}`);
}

/** Matches a bare `/subscriptions/{id}/resourceGroups/{name}` scope (no trailing segments) — used by describeScope to render an inherited grant's resource-group name without the caller needing to look it up separately. */
const RESOURCE_GROUP_SCOPE_PATTERN = /^\/subscriptions\/[^/]+\/resourceGroups\/([^/]+)$/i;
/** Matches a bare `/subscriptions/{id}` scope (no trailing segments). */
const SUBSCRIPTION_SCOPE_PATTERN = /^\/subscriptions\/[^/]+$/i;

/**
 * AM-14 peer review (fix 1): classifies one role assignment's ARM `scope`
 * against the DAG's own scope, producing the human-readable
 * DesktopAssignment.assignedVia label and assignedDirectlyOnDag flag — see
 * that DTO's doc comment in @avdmgr/shared for the full "why this exists"
 * (atScope() returns inherited grants too).
 */
export function describeScope(scope: string | undefined, dagScopeValue: string): { assignedDirectlyOnDag: boolean; assignedVia: string } {
  if (!scope) {
    // Defensive only: ARM's RoleAssignmentProperties.scope is a documented,
    // always-populated readonly field on a real response — but if it were
    // ever missing, silently assuming "direct" would be exactly the
    // false-safety this fix exists to eliminate. Treat as NOT direct.
    return { assignedDirectlyOnDag: false, assignedVia: 'Unknown scope' };
  }
  if (scope.toLowerCase() === dagScopeValue.toLowerCase()) {
    return { assignedDirectlyOnDag: true, assignedVia: 'Direct on DAG' };
  }
  const rgMatch = RESOURCE_GROUP_SCOPE_PATTERN.exec(scope);
  if (rgMatch) {
    return { assignedDirectlyOnDag: false, assignedVia: `Inherited from resource group ${rgMatch[1]}` };
  }
  if (SUBSCRIPTION_SCOPE_PATTERN.test(scope)) {
    return { assignedDirectlyOnDag: false, assignedVia: 'Inherited from subscription' };
  }
  return { assignedDirectlyOnDag: false, assignedVia: `Inherited from ${scope}` };
}

/**
 * Resolves one principalId to a display name via Graph — tries `/users/{id}`
 * first, then `/groups/{id}` on a 404 (this app does not trust ARM's own
 * principalType enough to skip straight to the matching Graph endpoint: a
 * role assignment's principalType can be stale/wrong relative to what the
 * object actually is today — e.g. a user converted account — so trying
 * users-then-groups is the same defensive "don't assume, verify" posture
 * avdService.ts's VM-resolution code applies elsewhere). Returns undefined
 * (never throws) if Graph resolves NEITHER — the principal may have been
 * deleted from Entra since the assignment was made; the assignment itself
 * still lists (bare principalId), just without a name. Throws (propagates)
 * on any Graph error, including 403 — callers (resolveAllPrincipals) decide
 * how to react to that.
 */
async function resolvePrincipal(principalId: string): Promise<{ displayName?: string; userPrincipalName?: string } | undefined> {
  const user = await graphGet<GraphUser>(`/users/${encodeURIComponent(principalId)}?$select=id,displayName,userPrincipalName`);
  if (user) {
    return { displayName: user.displayName, userPrincipalName: user.userPrincipalName };
  }
  const group = await graphGet<GraphGroup>(`/groups/${encodeURIComponent(principalId)}?$select=id,displayName`);
  if (group) {
    return { displayName: group.displayName };
  }
  return undefined;
}

interface ResolveAllPrincipalsResult {
  resolved: Array<{ displayName?: string; userPrincipalName?: string } | undefined>;
  graphResolved: boolean;
  graphDegradationReason?: GraphDegradationReason;
}

/**
 * AM-14 peer review (fix 7 + fix 12): resolves every principalId's display
 * name via Graph using a small worker pool (RESOLVE_CONCURRENCY_LIMIT
 * concurrent calls at most), rather than either (a) firing all N in
 * parallel (the ORIGINAL, unbounded design this review flagged), or (b)
 * treating only the FIRST principal as a "probe" for whether Graph is
 * reachable (the review's OTHER finding, fix 12: a first principal that
 * happens to be a deleted/not-found object resolves successfully — no
 * throw — without ever proving Graph permission is actually granted, so a
 * REAL 403 on a later principal would previously be silently swallowed
 * per-item instead of degrading the whole response).
 *
 * This version checks EVERY principal uniformly: ANY 403 anywhere degrades
 * the WHOLE response to graphResolved:false (worker loops stop claiming new
 * work the moment a 403 is observed — see the `forbidden` flag below — so
 * excess calls are bounded to roughly 2×RESOLVE_CONCURRENCY_LIMIT in the
 * worst case, not 2×N). A NON-403 error for a single principal (network
 * blip, an unexpected Graph shape) leaves just that one item unresolved
 * without degrading the rest — a genuinely per-item problem, not a
 * permissions problem.
 */
async function resolveAllPrincipals(principalIds: string[]): Promise<ResolveAllPrincipalsResult> {
  const resolved: ResolveAllPrincipalsResult['resolved'] = new Array(principalIds.length).fill(undefined);
  let forbidden = false;
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < principalIds.length) {
      if (forbidden) return;
      const i = nextIndex++;
      try {
        resolved[i] = await resolvePrincipal(principalIds[i]);
      } catch (error) {
        if (isGraphForbidden(error)) {
          forbidden = true;
        }
        // Any other per-item error is left unresolved (resolved[i] stays
        // undefined) without setting `forbidden` — see this function's doc
        // comment.
      }
    }
  }

  const workerCount = Math.min(RESOLVE_CONCURRENCY_LIMIT, principalIds.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  if (forbidden) {
    return { resolved, graphResolved: false, graphDegradationReason: 'graph-permission-not-granted' };
  }
  return { resolved, graphResolved: true };
}

/**
 * Lists every "Desktop Virtualization User" role assignment at OR ABOVE the
 * DAG scope (ARM read, always available — no Graph permission needed for
 * this half — see this module's header comment for the atScope()
 * "at-or-above" behavior and why every row carries its own scope/
 * assignedDirectlyOnDag/assignedVia) and best-effort resolves each
 * principal's display name via Graph (degrades independently — see
 * AssignmentsListResponse's doc comment in @avdmgr/shared). GET
 * /v1/access/assignments (AM-14, viewer+).
 */
export async function listDesktopAssignments(): Promise<AssignmentsListResponse> {
  const dagScopeValue = dagScope();
  const { items, truncated } = await armListAtScope<ArmRoleAssignment>(roleAssignmentsCollectionPath(), ROLE_ASSIGNMENTS_API_VERSION, 'atScope()');
  const matched = items.filter(isDesktopVirtualizationUserAssignment);

  const base: DesktopAssignment[] = matched
    .filter((item): item is ArmRoleAssignment & { name: string; properties: { principalId: string } } => Boolean(item.name && item.properties?.principalId))
    .map((item) => {
      const { assignedDirectlyOnDag, assignedVia } = describeScope(item.properties?.scope, dagScopeValue);
      return {
        roleAssignmentId: item.name,
        principalId: item.properties.principalId,
        principalType: item.properties?.principalType ?? 'Unknown',
        scope: item.properties?.scope ?? dagScopeValue,
        assignedDirectlyOnDag,
        assignedVia,
      };
    });

  if (base.length === 0) {
    return { assignments: [], graphResolved: true, truncated };
  }

  const { resolved, graphResolved, graphDegradationReason } = await resolveAllPrincipals(base.map((assignment) => assignment.principalId));
  const assignments = base.map((assignment, index) => ({ ...assignment, ...resolved[index] }));
  return { assignments, graphResolved, graphDegradationReason, truncated };
}

/**
 * Creates a "Desktop Virtualization User" role assignment for `principalId`
 * on the DAG — POST /v1/access/assignments (AM-14, ADMIN-only). Generates a
 * fresh GUID as the role assignment resource's own name (ARM's documented
 * "use a GUID tool to generate a unique identifier" step — see Microsoft
 * Learn's "Assign Azure roles using the REST API"). ALWAYS pins
 * roleDefinitionId to DESKTOP_VIRTUALIZATION_USER_ROLE_ID — see this
 * module's header comment for why that is the acceptance-criterion proof,
 * not merely a default. Every assignment this function creates is, by
 * construction, DIRECTLY on the DAG (assignedDirectlyOnDag: true) — this
 * function has no way to create an inherited one.
 *
 * Throws (propagates) ArmRestError on failure — callers map isArmForbidden
 * (ABAC condition rejection / missing grant) and isArmConflict (ARM's
 * RoleAssignmentExists 409 — the principal already has this exact
 * assignment) to specific responses; see accessAssignments.ts.
 */
export async function createDesktopAssignment(principalId: string, principalType: PrincipalType): Promise<DesktopAssignment> {
  const roleAssignmentId = randomUUID();
  const armPrincipalType = principalType === 'user' ? 'User' : 'Group';
  const scope = dagScope();
  const body = {
    properties: {
      roleDefinitionId: roleDefinitionResourceId(),
      principalId,
      principalType: armPrincipalType,
    },
  };

  const created = await armPut<ArmRoleAssignment>(`${roleAssignmentsCollectionPath()}/${roleAssignmentId}`, ROLE_ASSIGNMENTS_API_VERSION, body);

  return {
    roleAssignmentId: created.name ?? roleAssignmentId,
    principalId: created.properties?.principalId ?? principalId,
    principalType: created.properties?.principalType ?? armPrincipalType,
    scope: created.properties?.scope ?? scope,
    assignedDirectlyOnDag: true,
    assignedVia: 'Direct on DAG',
  };
}

export type RemoveDesktopAssignmentResult =
  | { outcome: 'removed'; principalId: string; principalType: string; displayName?: string }
  | { outcome: 'not_found' };

/**
 * Removes a "Desktop Virtualization User" role assignment from the DAG by
 * its roleAssignmentId — DELETE /v1/access/assignments/{roleAssignmentId}
 * (AM-14, ADMIN-only).
 *
 * AM-14 peer review (BLOCKER fix 1, + fix 5, fix 6): does a GET on the
 * SPECIFIC resource path `{dagScope}/.../roleAssignments/{roleAssignmentId}`
 * BEFORE deleting — NOT a blind DELETE relying on armDelete's generic
 * "404-as-success" idempotency (see restClient.ts#restDelete's doc
 * comment, written for callers that already KNOW the target should exist
 * at the scope they're deleting from). A role assignment's ARM identity is
 * its (scope, name) PAIR (confirmed on Microsoft Learn's "Understand Azure
 * role assignments": RoleAssignmentId "includes the name", scoped GET
 * methods take `(scope, name)`) — so a GET at the DAG's OWN scope for a
 * roleAssignmentId that actually lives at a PARENT resource group/
 * subscription scope (an INHERITED assignment atScope() surfaces in the
 * list — see this module's header comment) or that never existed at all
 * simply 404s here; this function returns `{ outcome: 'not_found' }` for
 * BOTH cases rather than calling armDelete and letting its 404-tolerant
 * behavior report a falsified 'removed'/success outcome for something that
 * was never actually a DAG-scoped resource this app could act on.
 *
 * Also re-verifies roleDefinitionId === DESKTOP_VIRTUALIZATION_USER_ROLE_ID
 * on the fetched resource (fix 6) — same defense-in-depth posture as the
 * create path's pinned GUID: even though this app's own list already
 * filters to only DVU assignments, and the ABAC-constrained RBAC grant
 * (infra/modules/dagUserAccessAdministratorRole.bicep) independently
 * refuses to delete anything else at the ARM layer, a roleAssignmentId
 * pointing at some OTHER role assigned directly on the DAG (e.g. a manual
 * portal grant) must not be reported as "not found" OR silently deleted —
 * it is treated the same as "not found" (this endpoint's whole domain is
 * DVU assignments only; anything else simply isn't something it manages),
 * which also means the ABAC condition is never even exercised for that
 * case — this app's own check catches it first.
 *
 * Returns the deleted assignment's principalId (always) and displayName
 * (best-effort via Graph, fix 5 — so the audit row records WHO lost access,
 * not just an opaque GUID) — resolution failure here never blocks the
 * already-completed removal.
 */
export async function removeDesktopAssignment(roleAssignmentId: string): Promise<RemoveDesktopAssignmentResult> {
  const resourcePath = `${roleAssignmentsCollectionPath()}/${roleAssignmentId}`;
  const existing = await armGet<ArmRoleAssignment>(resourcePath, ROLE_ASSIGNMENTS_API_VERSION);

  if (!existing?.properties?.principalId || !isDesktopVirtualizationUserAssignment(existing)) {
    return { outcome: 'not_found' };
  }

  const principalId = existing.properties.principalId;
  const principalType = existing.properties.principalType ?? 'Unknown';

  await armDelete(resourcePath, ROLE_ASSIGNMENTS_API_VERSION);

  let displayName: string | undefined;
  try {
    const resolved = await resolvePrincipal(principalId);
    displayName = resolved?.displayName;
  } catch {
    // Best-effort only (fix 5) — the audit row still records principalId
    // even when Graph can't resolve a friendly name (not granted,
    // transient error, or the principal was itself deleted from Entra);
    // never let this fail the already-completed removal.
  }

  return { outcome: 'removed', principalId, principalType, displayName };
}
