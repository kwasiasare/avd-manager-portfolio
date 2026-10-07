import { randomUUID } from 'node:crypto';
import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import type { ApiError } from '@avdmgr/shared';
import { requireRole } from '../lib/auth';
import { getConfig } from '../lib/config';
import { getHostPool, listSessionHosts } from '../services/avdService';
import { computeHealthSummary } from '../services/healthService';

/**
 * Aggregate health for the Dashboard's health ring, scoped to the
 * configured HOSTPOOL_NAME (M1 is single-host-pool; a hostPoolName query
 * param can be added once the app manages more than one pool).
 */
export async function healthSummary(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const authResult = requireRole(request, ['viewer', 'operator', 'admin'], context);
  if (!authResult.ok) {
    return authResult.response;
  }

  const { hostPoolName } = getConfig();

  try {
    const [hostPool, sessionHosts] = await Promise.all([
      getHostPool(hostPoolName),
      // resolvePowerState: false — the health ring only needs
      // status/allowNewSession/activeSessions (see computeHealthSummary),
      // so skip the extra @azure/arm-compute instanceView call per host on
      // every 60s dashboard poll.
      listSessionHosts(hostPoolName, { warn: (message) => context.warn(message), resolvePowerState: false }),
    ]);
    const summary = computeHealthSummary(hostPoolName, sessionHosts, hostPool?.maxSessionLimit);
    return { status: 200, jsonBody: summary };
  } catch (error) {
    const correlationId = randomUUID();
    context.error(`health summary failed | hostPoolName=${hostPoolName} correlationId=${correlationId}`, error);
    const apiError: ApiError = {
      status: 502,
      code: 'health_summary_failed',
      message: `Failed to compute health summary from Azure. Reference: ${correlationId}`,
      details: { correlationId },
    };
    return { status: 502, jsonBody: apiError };
  }
}

app.http('healthSummary', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'v1/health/summary',
  handler: healthSummary,
});
