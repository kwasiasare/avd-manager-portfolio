import { randomUUID } from 'node:crypto';
import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import type { ApiError, VmTemplateInfo } from '@avdmgr/shared';
import { requireRole } from '../lib/auth';
import { getConfig } from '../lib/config';
import { badRequest } from '../lib/httpErrors';
import { validateManagedHostPool } from '../lib/hostPoolScope';
import { getVmTemplateInfo } from '../services/avdService';

/**
 * GET /api/v1/hostpools/{hostPoolName}/vm-template — AM-22 (M2-S5). Read-only
 * best-effort parse of the host pool's vmTemplate property, powering the Add
 * session host panel's "prefilled parameters" display (image, VM size, name
 * prefix, domain/OU — see the VmTemplateInfo DTO in @avdmgr/shared for why
 * those field names are best-effort, not a published ARM schema).
 *
 * RBAC: operator-minimum (not viewer). This call is read-only, but what it
 * reads is squarely under "how would I administer this pool" — it exists to
 * guide an admin/operator through adding a session host, not for general
 * dashboard viewing — so it stays gated the same as the registration-token
 * status endpoint in this same feature slice
 * (app/api/src/functions/hostPoolRegistrationToken.ts), consistent with the
 * frontend's RoleGate for this panel.
 */
export async function hostPoolVmTemplate(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const authResult = requireRole(request, ['operator', 'admin'], context);
  if (!authResult.ok) {
    return authResult.response;
  }

  const hostPoolName = request.params.hostPoolName;
  if (!hostPoolName) {
    return badRequest('missing_host_pool_name', 'hostPoolName route parameter is required.');
  }

  const scopeError = validateManagedHostPool(hostPoolName, getConfig().hostPoolName);
  if (scopeError) {
    return scopeError;
  }

  try {
    const template = await getVmTemplateInfo(hostPoolName);
    if (!template) {
      const apiError: ApiError = {
        status: 404,
        code: 'host_pool_not_found',
        message: `Host pool "${hostPoolName}" was not found.`,
      };
      return { status: 404, jsonBody: apiError };
    }
    const responseBody: VmTemplateInfo = template;
    return { status: 200, jsonBody: responseBody };
  } catch (error) {
    const correlationId = randomUUID();
    context.error(`vm template lookup failed | hostPoolName=${hostPoolName} correlationId=${correlationId}`, error);
    const apiError: ApiError = {
      status: 502,
      code: 'vm_template_lookup_failed',
      message: `Failed to retrieve the host pool's VM template from Azure. Reference: ${correlationId}`,
      details: { correlationId },
    };
    return { status: 502, jsonBody: apiError };
  }
}

app.http('hostPoolVmTemplate', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'v1/hostpools/{hostPoolName}/vm-template',
  handler: hostPoolVmTemplate,
});
