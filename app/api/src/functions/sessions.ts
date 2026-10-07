import { randomUUID } from 'node:crypto';
import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import type { ApiError } from '@avdmgr/shared';
import { requireRole } from '../lib/auth';
import { getConfig } from '../lib/config';
import { validateManagedHostPool } from '../lib/hostPoolScope';
import { listUserSessions } from '../services/avdService';

export async function sessions(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
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
    const userSessions = await listUserSessions(hostPoolName);
    return { status: 200, jsonBody: userSessions };
  } catch (error) {
    const correlationId = randomUUID();
    context.error(`sessions list failed | hostPoolName=${hostPoolName} correlationId=${correlationId}`, error);
    const apiError: ApiError = {
      status: 502,
      code: 'sessions_list_failed',
      message: `Failed to retrieve user sessions from Azure. Reference: ${correlationId}`,
      details: { correlationId },
    };
    return { status: 502, jsonBody: apiError };
  }
}

app.http('sessions', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'v1/hostpools/{hostPoolName}/sessions',
  handler: sessions,
});
