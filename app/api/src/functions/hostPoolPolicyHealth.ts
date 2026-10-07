import { randomUUID } from 'node:crypto';
import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import type { ApiError, IntunePolicyHealthResponse } from '@avdmgr/shared';
import { requireMinimumRole } from '../lib/auth';
import { getConfig } from '../lib/config';
import { validateManagedHostPool } from '../lib/hostPoolScope';
import { listSessionHosts } from '../services/avdService';
import { getIntunePolicyHealth } from '../services/intunePolicyHealthService';

/**
 * GET /v1/hostpools/{hostPoolName}/policy-health — AM-52. Viewer+ (read-only
 * — this surfaces Intune policy-health findings, it never mutates anything),
 * same RBAC floor and hostPoolName-scope validation as sessionhosts.ts's GET.
 *
 * Host names come from listSessionHosts with `resolvePowerState: false` —
 * this endpoint has no use for VM power state, and skipping it avoids an
 * unneeded @azure/arm-compute call per host on every poll (see
 * avdService.ts#listSessionHosts's ListSessionHostsOptions doc comment).
 * A session host's Graph failure never reaches this handler as a thrown
 * error — see intunePolicyHealthService.ts's per-host isolation and
 * envelope-level degradation contract; only a genuinely unexpected failure
 * (e.g. listSessionHosts itself failing) reaches the 502 branch below.
 */
export async function hostPoolPolicyHealth(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const authResult = requireMinimumRole(request, 'viewer', context);
  if (!authResult.ok) {
    return authResult.response;
  }

  const hostPoolName = request.params.hostPoolName;
  if (!hostPoolName) {
    const apiError: ApiError = { status: 400, code: 'missing_host_pool_name', message: 'hostPoolName route parameter is required.' };
    return { status: 400, jsonBody: apiError };
  }

  const scopeError = validateManagedHostPool(hostPoolName, getConfig().hostPoolName);
  if (scopeError) {
    return scopeError;
  }

  try {
    const hosts = await listSessionHosts(hostPoolName, { resolvePowerState: false, warn: (message) => context.warn(message) });
    const hostNames = hosts.map((host) => host.name);
    const result: IntunePolicyHealthResponse = await getIntunePolicyHealth(hostNames, {
      warn: (message) => context.warn(message),
      log: (message) => context.log(message),
      error: (message, err) => context.error(message, err),
    });
    return { status: 200, jsonBody: result };
  } catch (error) {
    const correlationId = randomUUID();
    context.error(`hostpool policy-health failed | hostPoolName=${hostPoolName} correlationId=${correlationId}`, error);
    const apiError: ApiError = {
      status: 502,
      code: 'policy_health_failed',
      message: `Failed to retrieve Intune policy health from Azure. Reference: ${correlationId}`,
      details: { correlationId },
    };
    return { status: 502, jsonBody: apiError };
  }
}

app.http('hostPoolPolicyHealth', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'v1/hostpools/{hostPoolName}/policy-health',
  handler: hostPoolPolicyHealth,
});
