import { describe, expect, it } from 'vitest';
import { extractGroupIds, hasGroupsOverage, mapGroupsToRoles, resolveRoles, type RolesSourceRequestBody } from './roles';

const CONFIG = {
  groupIds: {
    viewer: 'viewer-group-id',
    operator: 'operator-group-id',
    admin: 'admin-group-id',
  },
};

describe('extractGroupIds', () => {
  it('returns an empty array when claims is missing', () => {
    expect(extractGroupIds({})).toEqual([]);
  });

  it('returns an empty array when claims is not an array', () => {
    expect(extractGroupIds({ claims: undefined })).toEqual([]);
  });

  it('extracts values from "groups" typed claims', () => {
    const body: RolesSourceRequestBody = {
      claims: [
        { typ: 'groups', val: 'group-a' },
        { typ: 'groups', val: 'group-b' },
        { typ: 'name', val: 'Some User' },
      ],
    };
    expect(extractGroupIds(body)).toEqual(['group-a', 'group-b']);
  });

  it('extracts values from the long-form WS-2008 groups claim type', () => {
    const body: RolesSourceRequestBody = {
      claims: [{ typ: 'http://schemas.microsoft.com/ws/2008/06/identity/claims/groups', val: 'group-c' }],
    };
    expect(extractGroupIds(body)).toEqual(['group-c']);
  });

  it('ignores claims with a missing val', () => {
    const body: RolesSourceRequestBody = { claims: [{ typ: 'groups' }] };
    expect(extractGroupIds(body)).toEqual([]);
  });
});

describe('mapGroupsToRoles', () => {
  it('maps a known viewer group to the viewer role', () => {
    expect(mapGroupsToRoles(['viewer-group-id'], CONFIG)).toEqual(['viewer']);
  });

  it('maps a known operator group to the operator role', () => {
    expect(mapGroupsToRoles(['operator-group-id'], CONFIG)).toEqual(['operator']);
  });

  it('maps a known admin group to the admin role', () => {
    expect(mapGroupsToRoles(['admin-group-id'], CONFIG)).toEqual(['admin']);
  });

  it('maps multiple known groups to multiple roles, in viewer/operator/admin order', () => {
    expect(mapGroupsToRoles(['admin-group-id', 'viewer-group-id'], CONFIG)).toEqual(['viewer', 'admin']);
  });

  it('returns an empty array for an unknown group', () => {
    expect(mapGroupsToRoles(['some-other-group-id'], CONFIG)).toEqual([]);
  });

  it('returns an empty array for no groups', () => {
    expect(mapGroupsToRoles([], CONFIG)).toEqual([]);
  });

  it('never matches when the corresponding config group id is unset', () => {
    const partialConfig = { groupIds: { viewer: undefined, operator: 'operator-group-id', admin: undefined } };
    expect(mapGroupsToRoles(['', 'operator-group-id'], partialConfig)).toEqual(['operator']);
  });

  it('matches case-insensitively when the claim value has different casing than the configured group id', () => {
    expect(mapGroupsToRoles(['VIEWER-GROUP-ID'], CONFIG)).toEqual(['viewer']);
  });

  it('matches case-insensitively when the configured group id has different casing than the claim value', () => {
    const upperConfig = { groupIds: { viewer: 'VIEWER-GROUP-ID', operator: undefined, admin: undefined } };
    expect(mapGroupsToRoles(['viewer-group-id'], upperConfig)).toEqual(['viewer']);
  });
});

describe('hasGroupsOverage', () => {
  it('returns false when claims is missing', () => {
    expect(hasGroupsOverage({})).toBe(false);
  });

  it('returns false for a normal claims array with no overage markers', () => {
    const body: RolesSourceRequestBody = { claims: [{ typ: 'groups', val: 'group-a' }] };
    expect(hasGroupsOverage(body)).toBe(false);
  });

  it('returns true when a _claim_names claim is present (v2.0 token overage)', () => {
    const body: RolesSourceRequestBody = { claims: [{ typ: '_claim_names', val: '{"groups":"src1"}' }] };
    expect(hasGroupsOverage(body)).toBe(true);
  });

  it('returns true when a hasgroups claim is present (v1.0 token overage)', () => {
    const body: RolesSourceRequestBody = { claims: [{ typ: 'hasgroups', val: 'true' }] };
    expect(hasGroupsOverage(body)).toBe(true);
  });

  it('matches the overage claim type case-insensitively', () => {
    const body: RolesSourceRequestBody = { claims: [{ typ: 'HasGroups', val: 'true' }] };
    expect(hasGroupsOverage(body)).toBe(true);
  });
});

describe('resolveRoles', () => {
  it('goes from a full SWA rolesSource request body to Role[]', () => {
    const body: RolesSourceRequestBody = {
      identityProvider: 'aad',
      userId: 'u1',
      userDetails: 'user@example.com',
      claims: [{ typ: 'groups', val: 'operator-group-id' }],
    };
    expect(resolveRoles(body, CONFIG)).toEqual(['operator']);
  });

  it('returns an empty array when the request has no claims at all', () => {
    expect(resolveRoles({ userId: 'u1' }, CONFIG)).toEqual([]);
  });
});
