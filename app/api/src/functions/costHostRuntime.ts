import { randomUUID } from 'node:crypto';
import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import type { ApiError } from '@avdmgr/shared';
import { requireRole } from '../lib/auth';
import { getConfig } from '../lib/config';
import { listSessionHosts } from '../services/avdService';
import { getHostRuntimeSummaries } from '../services/hostRuntimeService';

/**
 * Running-vs-deallocated hours per session host over the trailing 7 days.
 * See app/api/src/services/hostRuntimeService.ts's top comment for the
 * data-source limitation this is derived under (no Heartbeat/AMA on this
 * estate — WVDAgentHealthStatus presence-per-hour is used instead).
 */
export async function costHostRuntime(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const authResult = requireRole(request, ['viewer', 'operator', 'admin'], context);
  if (!authResult.ok) {
    return authResult.response;
  }

  const { hostPoolName } = getConfig();

  try {
    // resolvePowerState: false — this endpoint only needs host names, not
    // current VM power state (that's the idle-hosts endpoint's job).
    const hosts = await listSessionHosts(hostPoolName, { warn: (message) => context.warn(message), resolvePowerState: false });
    const summaries = await getHostRuntimeSummaries(
      hostPoolName,
      hosts.map((host) => host.name),
      (message) => context.warn(message),
      (message) => context.log(message),
    );
    return { status: 200, jsonBody: summaries };
  } catch (error) {
    const correlationId = randomUUID();
    context.error(`host runtime lookup failed | hostPoolName=${hostPoolName} correlationId=${correlationId}`, error);
    const apiError: ApiError = {
      status: 502,
      code: 'host_runtime_lookup_failed',
      message: `Failed to compute host runtime hours. Reference: ${correlationId}`,
      details: { correlationId },
    };
    return { status: 502, jsonBody: apiError };
  }
}

app.http('costHostRuntime', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'v1/cost/host-runtime',
  handler: costHostRuntime,
});
