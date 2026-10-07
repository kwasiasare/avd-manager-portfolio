import { describe, expect, it } from 'vitest';
import { validateManagedHostPool } from './hostPoolScope';

describe('validateManagedHostPool', () => {
  it('returns null when the route hostPoolName matches the configured host pool', () => {
    expect(validateManagedHostPool('HP-CONTOSO-PROD', 'HP-CONTOSO-PROD')).toBeNull();
  });

  it('returns a 404 ApiError response when the route hostPoolName does not match', () => {
    const result = validateManagedHostPool('SOME-OTHER-POOL', 'HP-CONTOSO-PROD');
    expect(result).not.toBeNull();
    expect(result?.status).toBe(404);
    expect(result?.jsonBody).toMatchObject({ status: 404, code: 'host_pool_not_managed' });
  });

  it('is case-sensitive (route params are not normalized)', () => {
    const result = validateManagedHostPool('hp-avd-prod', 'HP-CONTOSO-PROD');
    expect(result?.status).toBe(404);
  });
});
