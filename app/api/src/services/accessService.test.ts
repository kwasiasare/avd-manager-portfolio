import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const armListAtScopeMock = vi.fn();
const armGetMock = vi.fn();
const armPutMock = vi.fn();
const armDeleteMock = vi.fn();
vi.mock('../lib/armRest', () => ({
  armListAtScope: (...args: unknown[]) => armListAtScopeMock(...args),
  armGet: (...args: unknown[]) => armGetMock(...args),
  armPut: (...args: unknown[]) => armPutMock(...args),
  armDelete: (...args: unknown[]) => armDeleteMock(...args),
}));

const graphGetMock = vi.fn();
class FakeGraphForbiddenError extends Error {}
vi.mock('../lib/graphRest', () => ({
  graphGet: (...args: unknown[]) => graphGetMock(...args),
  isGraphForbidden: (error: unknown) => error instanceof FakeGraphForbiddenError,
}));

const {
  DESKTOP_VIRTUALIZATION_USER_ROLE_ID,
  searchPrincipals,
  listDesktopAssignments,
  createDesktopAssignment,
  removeDesktopAssignment,
  describeScope,
} = await import('./accessService');

const CONFIGURED_SUBSCRIPTION_ID = '00000000-0000-4000-8000-000000000001';
const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  process.env.SUBSCRIPTION_ID = CONFIGURED_SUBSCRIPTION_ID;
  process.env.RG_HOSTPOOLS = 'RG-AVD-HostPools';
  process.env.HOSTPOOL_NAME = 'HP-CONTOSO-PROD';
  process.env.DAG_NAME = 'HP-CONTOSO-PROD-DAG';
  armListAtScopeMock.mockReset();
  armGetMock.mockReset();
  armPutMock.mockReset();
  armDeleteMock.mockReset();
  graphGetMock.mockReset();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('DESKTOP_VIRTUALIZATION_USER_ROLE_ID', () => {
  it('is the Microsoft Learn-verified "Desktop Virtualization User" built-in role GUID', () => {
    expect(DESKTOP_VIRTUALIZATION_USER_ROLE_ID).toBe('1d18fff3-a72a-46b5-b4a9-0b38a3cd7e63');
  });
});

describe('searchPrincipals', () => {
  it('combines user and group results with principalType tagged correctly, and reports truncated:false when Graph has no more pages', async () => {
    graphGetMock.mockImplementation((path: string) => {
      if (path.startsWith('/users')) {
        return Promise.resolve({ value: [{ id: 'u1', displayName: 'Alice Example', userPrincipalName: 'alice@contoso.example' }] });
      }
      return Promise.resolve({ value: [{ id: 'g1', displayName: 'Alice Fans' }] });
    });

    const result = await searchPrincipals('alice');

    expect(result.graphAvailable).toBe(true);
    expect(result.truncated).toBe(false);
    expect(result.results).toEqual([
      { id: 'u1', principalType: 'user', displayName: 'Alice Example', userPrincipalName: 'alice@contoso.example' },
      { id: 'g1', principalType: 'group', displayName: 'Alice Fans' },
    ]);
  });

  it('fetches exactly ONE page per type — at most two Graph calls total, no matter how many matches exist (fix 2)', async () => {
    graphGetMock.mockResolvedValue({ value: [] });
    await searchPrincipals('alice');
    expect(graphGetMock).toHaveBeenCalledTimes(2);
  });

  it('reports truncated:true when Graph reports a nextLink on either collection (fix 4)', async () => {
    graphGetMock.mockImplementation((path: string) => {
      if (path.startsWith('/users')) {
        return Promise.resolve({ value: [{ id: 'u1', displayName: 'Alice' }], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/users?...' });
      }
      return Promise.resolve({ value: [] });
    });
    const result = await searchPrincipals('alice');
    expect(result.truncated).toBe(true);
  });

  it('slices results to MAX_SEARCH_RESULTS_PER_TYPE even if Graph returns more than requested (defense-in-depth beyond $top, fix 2)', async () => {
    const manyUsers = Array.from({ length: 25 }, (_, i) => ({ id: `u${i}`, displayName: `User ${i}` }));
    graphGetMock.mockImplementation((path: string) => {
      if (path.startsWith('/users')) return Promise.resolve({ value: manyUsers });
      return Promise.resolve({ value: [] });
    });
    const result = await searchPrincipals('u');
    expect(result.results).toHaveLength(10);
  });

  it('also matches on mail (B2B guests whose UPN is mangled — fix 18)', async () => {
    graphGetMock.mockResolvedValue({ value: [] });
    await searchPrincipals('alice');
    const usersCall = graphGetMock.mock.calls.find(([p]) => (p as string).startsWith('/users'));
    expect(usersCall).toBeDefined();
    const decodedPath = decodeURIComponent(usersCall![0] as string);
    expect(decodedPath).toContain("startswith(mail,'alice')");
  });

  it('escapes a single quote in the query before building the OData filter (injection defense)', async () => {
    graphGetMock.mockResolvedValue({ value: [] });
    await searchPrincipals("o'brien");
    const usersCall = graphGetMock.mock.calls.find(([p]) => (p as string).startsWith('/users'));
    expect(usersCall).toBeDefined();
    const decodedPath = decodeURIComponent(usersCall![0] as string);
    expect(decodedPath).toContain("o''brien");
  });

  it('degrades to graphAvailable:false with graph-permission-not-granted on a Graph 403', async () => {
    graphGetMock.mockRejectedValue(new FakeGraphForbiddenError('forbidden'));
    const result = await searchPrincipals('alice');
    expect(result).toEqual({ results: [], graphAvailable: false, graphDegradationReason: 'graph-permission-not-granted', truncated: false });
  });

  it('degrades to graphAvailable:false with graph-error on any other Graph failure', async () => {
    graphGetMock.mockRejectedValue(new Error('network blip'));
    const result = await searchPrincipals('alice');
    expect(result).toEqual({ results: [], graphAvailable: false, graphDegradationReason: 'graph-error', truncated: false });
  });
});

const DAG_ROLE_ASSIGNMENTS_PATH_SUFFIX = '/providers/Microsoft.DesktopVirtualization/applicationGroups/HP-CONTOSO-PROD-DAG/providers/Microsoft.Authorization/roleAssignments';

const DAG_SCOPE = `/subscriptions/${CONFIGURED_SUBSCRIPTION_ID}/resourceGroups/RG-AVD-HostPools${DAG_ROLE_ASSIGNMENTS_PATH_SUFFIX.replace('/providers/Microsoft.Authorization/roleAssignments', '')}`;

describe('describeScope — BLOCKER fix 1 (atScope() returns assignments at OR ABOVE the queried scope)', () => {
  it('reports assignedDirectlyOnDag:true and "Direct on DAG" when scope matches the DAG exactly (case-insensitively)', () => {
    expect(describeScope(DAG_SCOPE, DAG_SCOPE)).toEqual({ assignedDirectlyOnDag: true, assignedVia: 'Direct on DAG' });
    expect(describeScope(DAG_SCOPE.toUpperCase(), DAG_SCOPE)).toEqual({ assignedDirectlyOnDag: true, assignedVia: 'Direct on DAG' });
  });

  it('reports an inherited resource-group-scoped assignment by name', () => {
    const result = describeScope(`/subscriptions/${CONFIGURED_SUBSCRIPTION_ID}/resourceGroups/RG-AVD-HostPools`, DAG_SCOPE);
    expect(result).toEqual({ assignedDirectlyOnDag: false, assignedVia: 'Inherited from resource group RG-AVD-HostPools' });
  });

  it('reports an inherited subscription-scoped assignment', () => {
    const result = describeScope(`/subscriptions/${CONFIGURED_SUBSCRIPTION_ID}`, DAG_SCOPE);
    expect(result).toEqual({ assignedDirectlyOnDag: false, assignedVia: 'Inherited from subscription' });
  });

  it('never claims "direct" when scope is missing from ARM response (defensive)', () => {
    expect(describeScope(undefined, DAG_SCOPE).assignedDirectlyOnDag).toBe(false);
  });
});

describe('listDesktopAssignments', () => {
  it('filters to ONLY Desktop Virtualization User role assignments, ignoring others at the same scope', async () => {
    armListAtScopeMock.mockResolvedValue({
      items: [
        { name: 'assignment-1', properties: { principalId: 'p1', principalType: 'User', roleDefinitionId: `/subscriptions/sub/providers/Microsoft.Authorization/roleDefinitions/${DESKTOP_VIRTUALIZATION_USER_ROLE_ID}`, scope: DAG_SCOPE } },
        { name: 'assignment-2', properties: { principalId: 'p2', principalType: 'User', roleDefinitionId: '/subscriptions/sub/providers/Microsoft.Authorization/roleDefinitions/00000000-0000-4000-8000-0000000000a1', scope: DAG_SCOPE } },
      ],
      truncated: false,
    });
    graphGetMock.mockResolvedValue(undefined);

    const result = await listDesktopAssignments();

    expect(result.assignments).toHaveLength(1);
    expect(result.assignments[0].principalId).toBe('p1');
  });

  it('tags a DAG-scoped assignment as assignedDirectlyOnDag:true, "Direct on DAG"', async () => {
    armListAtScopeMock.mockResolvedValue({
      items: [{ name: 'a1', properties: { principalId: 'p1', principalType: 'User', roleDefinitionId: `.../roleDefinitions/${DESKTOP_VIRTUALIZATION_USER_ROLE_ID}`, scope: DAG_SCOPE } }],
      truncated: false,
    });
    graphGetMock.mockResolvedValue(undefined);

    const result = await listDesktopAssignments();

    expect(result.assignments[0]).toMatchObject({ scope: DAG_SCOPE, assignedDirectlyOnDag: true, assignedVia: 'Direct on DAG' });
  });

  it('BLOCKER fix 1: tags an INHERITED (parent-scope) Desktop Virtualization User assignment as assignedDirectlyOnDag:false with its real scope, rather than silently labeling it "direct"', async () => {
    const rgScope = `/subscriptions/${CONFIGURED_SUBSCRIPTION_ID}/resourceGroups/RG-AVD-HostPools`;
    armListAtScopeMock.mockResolvedValue({
      items: [{ name: 'inherited-1', properties: { principalId: 'p-inherited', principalType: 'Group', roleDefinitionId: `.../roleDefinitions/${DESKTOP_VIRTUALIZATION_USER_ROLE_ID}`, scope: rgScope } }],
      truncated: false,
    });
    graphGetMock.mockResolvedValue(undefined);

    const result = await listDesktopAssignments();

    expect(result.assignments).toHaveLength(1);
    expect(result.assignments[0]).toMatchObject({ scope: rgScope, assignedDirectlyOnDag: false, assignedVia: 'Inherited from resource group RG-AVD-HostPools' });
  });

  it('calls armListAtScope against the DAG-scoped role assignments collection with atScope()', async () => {
    armListAtScopeMock.mockResolvedValue({ items: [], truncated: false });
    await listDesktopAssignments();
    const [path, apiVersion, filter] = armListAtScopeMock.mock.calls[0];
    expect(path).toContain(DAG_ROLE_ASSIGNMENTS_PATH_SUFFIX);
    expect(apiVersion).toBe('2022-04-01');
    expect(filter).toBe('atScope()');
  });

  it('returns an empty, graphResolved:true result when there are no matching assignments (no Graph calls made)', async () => {
    armListAtScopeMock.mockResolvedValue({ items: [], truncated: false });
    const result = await listDesktopAssignments();
    expect(result).toEqual({ assignments: [], graphResolved: true, truncated: false });
    expect(graphGetMock).not.toHaveBeenCalled();
  });

  it('surfaces truncated:true from the underlying ARM list call (fix 4)', async () => {
    armListAtScopeMock.mockResolvedValue({ items: [], truncated: true });
    const result = await listDesktopAssignments();
    expect(result.truncated).toBe(true);
  });

  it('resolves a user principal via /users/{id}', async () => {
    armListAtScopeMock.mockResolvedValue({
      items: [{ name: 'a1', properties: { principalId: 'p1', principalType: 'User', roleDefinitionId: `.../roleDefinitions/${DESKTOP_VIRTUALIZATION_USER_ROLE_ID}`, scope: DAG_SCOPE } }],
      truncated: false,
    });
    graphGetMock.mockResolvedValueOnce({ id: 'p1', displayName: 'Alice Example', userPrincipalName: 'alice@contoso.example' });

    const result = await listDesktopAssignments();

    expect(result.graphResolved).toBe(true);
    expect(result.assignments[0]).toMatchObject({ displayName: 'Alice Example', userPrincipalName: 'alice@contoso.example' });
  });

  it('falls back to /groups/{id} when /users/{id} 404s (graphGet returns undefined)', async () => {
    armListAtScopeMock.mockResolvedValue({
      items: [{ name: 'a1', properties: { principalId: 'g1', principalType: 'Group', roleDefinitionId: `.../roleDefinitions/${DESKTOP_VIRTUALIZATION_USER_ROLE_ID}`, scope: DAG_SCOPE } }],
      truncated: false,
    });
    graphGetMock
      .mockResolvedValueOnce(undefined) // /users/g1 -> not found
      .mockResolvedValueOnce({ id: 'g1', displayName: 'Marketing Group' }); // /groups/g1 -> found

    const result = await listDesktopAssignments();

    expect(result.assignments[0].displayName).toBe('Marketing Group');
    expect(graphGetMock).toHaveBeenNthCalledWith(1, expect.stringContaining('/users/g1'));
    expect(graphGetMock).toHaveBeenNthCalledWith(2, expect.stringContaining('/groups/g1'));
  });

  it('fix 12: degrades the WHOLE response when a 403 is hit on a LATER principal, even if an EARLIER principal resolved successfully-but-not-found (no throw) — a first "deleted principal" no longer masks a real permissions problem', async () => {
    armListAtScopeMock.mockResolvedValue({
      items: [
        { name: 'a1', properties: { principalId: 'p-deleted', principalType: 'User', roleDefinitionId: `.../roleDefinitions/${DESKTOP_VIRTUALIZATION_USER_ROLE_ID}`, scope: DAG_SCOPE } },
        { name: 'a2', properties: { principalId: 'p-real', principalType: 'User', roleDefinitionId: `.../roleDefinitions/${DESKTOP_VIRTUALIZATION_USER_ROLE_ID}`, scope: DAG_SCOPE } },
      ],
      truncated: false,
    });
    // p-deleted resolves to "not found" on BOTH endpoints (no throw at all —
    // the old "probe" design would have wrongly concluded Graph is fine).
    // p-real's /users lookup then genuinely 403s.
    graphGetMock.mockImplementation((path: string) => {
      if (path.includes('p-deleted')) return Promise.resolve(undefined);
      if (path.includes('p-real')) return Promise.reject(new FakeGraphForbiddenError('forbidden'));
      return Promise.resolve(undefined);
    });

    const result = await listDesktopAssignments();

    expect(result.graphResolved).toBe(false);
    expect(result.graphDegradationReason).toBe('graph-permission-not-granted');
    expect(result.assignments).toHaveLength(2);
  });

  it('does NOT degrade the whole response when a SINGLE principal fails to resolve with a non-403 error', async () => {
    armListAtScopeMock.mockResolvedValue({
      items: [{ name: 'a1', properties: { principalId: 'p1', principalType: 'User', roleDefinitionId: `.../roleDefinitions/${DESKTOP_VIRTUALIZATION_USER_ROLE_ID}`, scope: DAG_SCOPE } }],
      truncated: false,
    });
    graphGetMock.mockRejectedValueOnce(new Error('transient')).mockResolvedValueOnce(undefined);

    const result = await listDesktopAssignments();

    expect(result.graphResolved).toBe(true);
    expect(result.assignments[0].displayName).toBeUndefined();
  });

  it('fix 7: bounds concurrent Graph calls to RESOLVE_CONCURRENCY_LIMIT — stops dispatching new work once a 403 is observed, rather than firing up to 2×N calls', async () => {
    const items = Array.from({ length: 12 }, (_, i) => ({
      name: `a${i}`,
      properties: { principalId: `p${i}`, principalType: 'User', roleDefinitionId: `.../roleDefinitions/${DESKTOP_VIRTUALIZATION_USER_ROLE_ID}`, scope: DAG_SCOPE },
    }));
    armListAtScopeMock.mockResolvedValue({ items, truncated: false });
    graphGetMock.mockRejectedValue(new FakeGraphForbiddenError('forbidden'));

    const result = await listDesktopAssignments();

    expect(result.graphResolved).toBe(false);
    // Bounded well below 2×12=24 — the concurrency limiter (5) means only a
    // handful of workers are ever in flight before all observe the 403 and
    // stop claiming new items.
    expect(graphGetMock.mock.calls.length).toBeLessThanOrEqual(5);
    expect(graphGetMock.mock.calls.length).toBeGreaterThan(0);
  });
});

describe('createDesktopAssignment — pinned role GUID (acceptance criterion: attempting any other role via the API fails)', () => {
  it('ALWAYS pins roleDefinitionId to DESKTOP_VIRTUALIZATION_USER_ROLE_ID for principalType "user"', async () => {
    armPutMock.mockResolvedValue({ name: 'new-guid', properties: { principalId: 'p1', principalType: 'User' } });
    await createDesktopAssignment('p1', 'user');
    const [, , body] = armPutMock.mock.calls[0] as [string, string, { properties: { roleDefinitionId: string; principalId: string; principalType: string } }];
    expect(body.properties.roleDefinitionId).toBe(`/subscriptions/${CONFIGURED_SUBSCRIPTION_ID}/providers/Microsoft.Authorization/roleDefinitions/${DESKTOP_VIRTUALIZATION_USER_ROLE_ID}`);
    expect(body.properties.principalType).toBe('User');
  });

  it('ALWAYS pins roleDefinitionId to DESKTOP_VIRTUALIZATION_USER_ROLE_ID for principalType "group" too', async () => {
    armPutMock.mockResolvedValue({ name: 'new-guid', properties: { principalId: 'g1', principalType: 'Group' } });
    await createDesktopAssignment('g1', 'group');
    const [, , body] = armPutMock.mock.calls[0] as [string, string, { properties: { roleDefinitionId: string; principalType: string } }];
    expect(body.properties.roleDefinitionId).toContain(DESKTOP_VIRTUALIZATION_USER_ROLE_ID);
    expect(body.properties.principalType).toBe('Group');
  });

  it('targets the DAG-scoped role assignments collection with a freshly generated GUID name', async () => {
    armPutMock.mockResolvedValue({ name: 'whatever', properties: {} });
    await createDesktopAssignment('p1', 'user');
    const [resourcePath, apiVersion] = armPutMock.mock.calls[0] as [string, string, unknown];
    expect(resourcePath.startsWith(`/subscriptions/${CONFIGURED_SUBSCRIPTION_ID}/resourceGroups/RG-AVD-HostPools${DAG_ROLE_ASSIGNMENTS_PATH_SUFFIX}/`)).toBe(true);
    const generatedName = resourcePath.slice(resourcePath.lastIndexOf('/') + 1);
    expect(generatedName).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(apiVersion).toBe('2022-04-01');
  });

  it('maps the ARM response back to the DesktopAssignment DTO shape — always assignedDirectlyOnDag:true, "Direct on DAG" (this function has no way to create an inherited one)', async () => {
    armPutMock.mockResolvedValue({ name: 'created-guid', properties: { principalId: 'p1', principalType: 'User', scope: DAG_SCOPE } });
    const result = await createDesktopAssignment('p1', 'user');
    expect(result).toEqual({
      roleAssignmentId: 'created-guid',
      principalId: 'p1',
      principalType: 'User',
      scope: DAG_SCOPE,
      assignedDirectlyOnDag: true,
      assignedVia: 'Direct on DAG',
    });
  });

  it('defaults scope to the DAG when ARM does not echo it back', async () => {
    armPutMock.mockResolvedValue({ name: 'created-guid', properties: { principalId: 'p1', principalType: 'User' } });
    const result = await createDesktopAssignment('p1', 'user');
    expect(result.scope).toBe(DAG_SCOPE);
  });
});

describe('removeDesktopAssignment — BLOCKER fix 1: pre-delete GET, never a false success', () => {
  const RESOURCE_PATH = `/subscriptions/${CONFIGURED_SUBSCRIPTION_ID}/resourceGroups/RG-AVD-HostPools${DAG_ROLE_ASSIGNMENTS_PATH_SUFFIX}/assignment-guid-1`;

  it('GETs the assignment at the DAG scope BEFORE deleting', async () => {
    armGetMock.mockResolvedValue({ name: 'assignment-guid-1', properties: { principalId: 'p1', principalType: 'User', roleDefinitionId: `.../roleDefinitions/${DESKTOP_VIRTUALIZATION_USER_ROLE_ID}` } });
    armDeleteMock.mockResolvedValue(undefined);

    await removeDesktopAssignment('assignment-guid-1');

    expect(armGetMock).toHaveBeenCalledWith(RESOURCE_PATH, '2022-04-01');
    expect(armDeleteMock).toHaveBeenCalledWith(RESOURCE_PATH, '2022-04-01');
  });

  it('returns outcome:"removed" with the principalId/principalType read back from the pre-delete GET (fix 5)', async () => {
    armGetMock.mockResolvedValue({ name: 'assignment-guid-1', properties: { principalId: 'p1', principalType: 'User', roleDefinitionId: `.../roleDefinitions/${DESKTOP_VIRTUALIZATION_USER_ROLE_ID}` } });
    armDeleteMock.mockResolvedValue(undefined);
    graphGetMock.mockResolvedValueOnce({ id: 'p1', displayName: 'Alice Example' });

    const result = await removeDesktopAssignment('assignment-guid-1');

    expect(result).toEqual({ outcome: 'removed', principalId: 'p1', principalType: 'User', displayName: 'Alice Example' });
  });

  it('omits displayName (undefined) when Graph cannot resolve it, without failing the removal', async () => {
    armGetMock.mockResolvedValue({ name: 'assignment-guid-1', properties: { principalId: 'p1', principalType: 'User', roleDefinitionId: `.../roleDefinitions/${DESKTOP_VIRTUALIZATION_USER_ROLE_ID}` } });
    armDeleteMock.mockResolvedValue(undefined);
    graphGetMock.mockRejectedValue(new FakeGraphForbiddenError('forbidden'));

    const result = await removeDesktopAssignment('assignment-guid-1');

    expect(result).toEqual({ outcome: 'removed', principalId: 'p1', principalType: 'User', displayName: undefined });
    expect(armDeleteMock).toHaveBeenCalled();
  });

  it('BLOCKER fix 1: returns outcome:"not_found" (and NEVER calls armDelete) when the pre-delete GET 404s — an inherited or already-removed assignment must not report a false "removed" success', async () => {
    armGetMock.mockResolvedValue(undefined); // armGet's documented 404 contract
    armDeleteMock.mockResolvedValue(undefined);

    const result = await removeDesktopAssignment('assignment-guid-1');

    expect(result).toEqual({ outcome: 'not_found' });
    expect(armDeleteMock).not.toHaveBeenCalled();
  });

  it('fix 6: returns outcome:"not_found" (and NEVER calls armDelete) when the resource exists at the DAG scope but is a DIFFERENT role — defense-in-depth mirroring the create path\'s pinned GUID', async () => {
    armGetMock.mockResolvedValue({
      name: 'assignment-guid-1',
      properties: { principalId: 'p1', principalType: 'User', roleDefinitionId: '/subscriptions/sub/providers/Microsoft.Authorization/roleDefinitions/00000000-0000-4000-8000-0000000000a1' },
    });

    const result = await removeDesktopAssignment('assignment-guid-1');

    expect(result).toEqual({ outcome: 'not_found' });
    expect(armDeleteMock).not.toHaveBeenCalled();
  });
});

describe('ABAC condition text (infra/modules/dagUserAccessAdministratorRole.bicep) — pinned (peer review fix 9)', () => {
  // AM-14 peer review (fix 9): "pin the ABAC condition string in a test,
  // the way the role GUID is pinned" — since the condition lives in Bicep
  // source (not importable TS), this reads the .bicep file's own text and
  // asserts the load-bearing fragments appear VERBATIM, so any accidental
  // edit to the condition (a dropped guard, a changed GUID, a changed
  // operator) breaks this test immediately. Resolved relative to
  // process.cwd() — this test suite is always run via `vitest run` with
  // cwd = app/api (either `npm run test --workspace=app/api` from the repo
  // root, or `vitest`/`npx vitest` run directly from within app/api).
  const bicepPath = path.resolve(process.cwd(), '../../infra/modules/dagUserAccessAdministratorRole.bicep');
  const bicepSource = readFileSync(bicepPath, 'utf-8');

  it('pins the built-in role GUIDs (User Access Administrator + Desktop Virtualization User)', () => {
    expect(bicepSource).toContain("var userAccessAdministratorRoleId = '18d7d88d-d35e-4fb5-a5c3-7773c20a72d9'");
    expect(bicepSource).toContain(`var desktopVirtualizationUserRoleId = '${DESKTOP_VIRTUALIZATION_USER_ROLE_ID}'`);
  });

  it('pins conditionVersion to \'2.0\' — the only value ARM currently accepts', () => {
    expect(bicepSource).toContain("conditionVersion: '2.0'");
  });

  it('gates the write guard on Microsoft.Authorization/roleAssignments/write and the delete guard on .../roleAssignments/delete', () => {
    expect(bicepSource).toContain("ActionMatches{\\'Microsoft.Authorization/roleAssignments/write\\'}");
    expect(bicepSource).toContain("ActionMatches{\\'Microsoft.Authorization/roleAssignments/delete\\'}");
  });

  it('pins the RoleDefinitionId guard (fix 1/9) on BOTH the write (Request) and delete (Resource) actions', () => {
    expect(bicepSource).toContain('@Request[Microsoft.Authorization/roleAssignments:RoleDefinitionId] ForAnyOfAnyValues:GuidEquals ${pinnedRoleGuidSet}');
    expect(bicepSource).toContain('@Resource[Microsoft.Authorization/roleAssignments:RoleDefinitionId] ForAnyOfAnyValues:GuidEquals ${pinnedRoleGuidSet}');
  });

  it('pins the PrincipalType guard (fix 10) to User/Group on BOTH the write (Request) and delete (Resource) actions', () => {
    expect(bicepSource).toContain("var pinnedPrincipalTypeSet = '{\\'User\\', \\'Group\\'}'");
    expect(bicepSource).toContain('@Request[Microsoft.Authorization/roleAssignments:PrincipalType] ForAnyOfAnyValues:StringEqualsIgnoreCase ${pinnedPrincipalTypeSet}');
    expect(bicepSource).toContain('@Resource[Microsoft.Authorization/roleAssignments:PrincipalType] ForAnyOfAnyValues:StringEqualsIgnoreCase ${pinnedPrincipalTypeSet}');
  });

  it('joins the write and delete guards with AND (both must hold, not either)', () => {
    expect(bicepSource).toContain(
      "StringEqualsIgnoreCase ${pinnedPrincipalTypeSet})) AND ((!(ActionMatches{\\'Microsoft.Authorization/roleAssignments/delete\\'}",
    );
  });
});
