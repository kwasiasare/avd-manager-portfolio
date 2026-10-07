import type { HttpResponseInit } from '@azure/functions';
import type { ApiError } from '@avdmgr/shared';

/**
 * M1 is single-host-pool scoped (HOSTPOOL_NAME app setting — see
 * app/api/src/lib/config.ts). Routes that take a `{hostPoolName}` path
 * segment (sessionhosts, sessions) must still validate it against the
 * configured pool: without this check, a request for an arbitrary
 * `hostPoolName` would silently query whatever ARM lets the caller reach —
 * harmless today (the Function App's managed identity only has Reader on
 * RG-AVD-HostPools, so it would just 502 on any host pool that does not
 * exist there), but the API should say "this app does not manage that host
 * pool" (404) rather than surface a confusing downstream ARM failure for a
 * request shape it was never meant to support.
 *
 * Returns null (valid) when hostPoolName matches the configured pool, or an
 * HttpResponseInit (404) to return immediately otherwise.
 */
export function validateManagedHostPool(hostPoolName: string, configuredHostPoolName: string): HttpResponseInit | null {
  if (hostPoolName === configuredHostPoolName) {
    return null;
  }

  const apiError: ApiError = {
    status: 404,
    code: 'host_pool_not_managed',
    message: `This app only manages host pool "${configuredHostPoolName}".`,
  };
  return { status: 404, jsonBody: apiError };
}
