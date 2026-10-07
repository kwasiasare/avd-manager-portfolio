import { randomUUID } from 'node:crypto';
import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import type { ApiError } from '@avdmgr/shared';
import { requireRole } from '../lib/auth';
import { getConfig } from '../lib/config';
import { validateManagedHostPool } from '../lib/hostPoolScope';
import { listSessionHosts } from '../services/avdService';

export async function sessionhosts(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const authResult = requireRole(request, ['viewer', 'operator', 'admin'], context);
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
    const hosts = await listSessionHosts(hostPoolName, { warn: (message) => context.warn(message) });
    return { status: 200, jsonBody: hosts };
  } catch (error) {
    const correlationId = randomUUID();
    context.error(`sessionhosts list failed | hostPoolName=${hostPoolName} correlationId=${correlationId}`, error);
    const apiError: ApiError = {
      status: 502,
      code: 'sessionhosts_list_failed',
      message: `Failed to retrieve session hosts from Azure. Reference: ${correlationId}`,
      details: { correlationId },
    };
    return { status: 502, jsonBody: apiError };
  }
}

app.http('sessionhosts', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'v1/hostpools/{hostPoolName}/sessionhosts',
  handler: sessionhosts,
});
