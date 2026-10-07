import { describe, expect, it } from 'vitest';
import { evaluateStoragePrivilegedAccess, type ArmRoleAssignment } from './storagePrivilegedAccess';

const PRIVILEGED_ROLE_ID = '/subscriptions/sub-id/providers/Microsoft.Authorization/roleDefinitions/69566ab7-960f-475b-8e7c-b3118f30c6bd';
const OTHER_ROLE_ID = '/subscriptions/sub-id/providers/Microsoft.Authorization/roleDefinitions/acdd72a7-3385-48ef-bd42-f606fba81ae7'; // Reader — irrelevant to this check

const PROD_MI = 'prod-mi-guid';
const DEV_MI = 'dev-mi-guid';

function assignment(principalId: string, roleDefinitionId: string = PRIVILEGED_ROLE_ID): ArmRoleAssignment {
  return { name: `assignment-${principalId}`, properties: { principalId, roleDefinitionId } };
}

describe('evaluateStoragePrivilegedAccess', () => {
  it('is unknown ("not configured") when no baseline is set — never guesses', () => {
    const result = evaluateStoragePrivilegedAccess(undefined, [assignment(PROD_MI)]);
    expect(result.status).toBe('unknown');
    expect(result.evidence).toMatchObject({ degradation: 'not-configured' });
  });

  it('passes when only the configured baseline principal(s) hold the role', () => {
    const result = evaluateStoragePrivilegedAccess([PROD_MI, DEV_MI], [assignment(PROD_MI), assignment(DEV_MI)]);
    expect(result.status).toBe('pass');
  });

  it('WARNS when a configured baseline principal no longer holds the role (Fable review fix — over-removal strands the app\'s own profile surgery)', () => {
    const result = evaluateStoragePrivilegedAccess([PROD_MI], []);
    expect(result.status).toBe('warn');
    expect(result.summary).toContain(PROD_MI);
    expect(result.evidence).toMatchObject({ missingBaselinePrincipalIds: [PROD_MI] });
  });

  it('passes when zero assignments exist and the configured baseline is an empty list (expects none)', () => {
    const result = evaluateStoragePrivilegedAccess([], []);
    expect(result.status).toBe('pass');
  });

  it('an extra principal outranks a missing baseline one — fail takes precedence over warn', () => {
    const extra = 'unaccounted-principal-guid';
    const result = evaluateStoragePrivilegedAccess([PROD_MI], [assignment(extra)]);
    expect(result.status).toBe('fail');
  });

  it('fails when a principal beyond the baseline holds the role — a security finding, not a hygiene warning', () => {
    const extra = 'unaccounted-principal-guid';
    const result = evaluateStoragePrivilegedAccess([PROD_MI], [assignment(PROD_MI), assignment(extra)]);
    expect(result.status).toBe('fail');
    expect(result.summary).toContain(extra);
  });

  it('ignores role assignments for OTHER roles entirely', () => {
    const result = evaluateStoragePrivilegedAccess([PROD_MI], [assignment(PROD_MI), assignment('some-reader-principal', OTHER_ROLE_ID)]);
    expect(result.status).toBe('pass');
  });

  it('matches the built-in role id suffix case-insensitively', () => {
    const upperCaseRoleId = PRIVILEGED_ROLE_ID.toUpperCase();
    const result = evaluateStoragePrivilegedAccess([PROD_MI], [assignment(PROD_MI, upperCaseRoleId)]);
    expect(result.status).toBe('pass');
  });

  it('compares principal ids case-insensitively against the baseline', () => {
    const result = evaluateStoragePrivilegedAccess([PROD_MI.toUpperCase()], [assignment(PROD_MI)]);
    expect(result.status).toBe('pass');
  });

  it('de-duplicates multiple assignments of the same role to the same principal (e.g. direct + inherited)', () => {
    const result = evaluateStoragePrivilegedAccess([PROD_MI], [assignment(PROD_MI), assignment(PROD_MI)]);
    expect(result.status).toBe('pass');
    const evidence = result.evidence as { assignments: unknown[] };
    expect(evidence.assignments).toHaveLength(1);
  });
});
