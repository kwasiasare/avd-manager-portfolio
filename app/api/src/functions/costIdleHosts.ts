import { randomUUID } from 'node:crypto';
import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import type { ApiError } from '@avdmgr/shared';
import { requireRole } from '../lib/auth';
import { getIdleHostFindings } from '../services/idleHostsService';

/**
 * Session hosts detected running when the scaling plan's current phase
 * expects them to be scaling in, with zero ACTIVE sessions (disconnected
 * sessions are reported as evidence, not used to gate — see
 * idleHostDetector.ts) — candidates for the idle-host leak documented in
 * The scaling-plan runbook §6 and
 * The scaling-and-cost runbook §3 (avd-con-0's known
 * history). See app/api/src/services/idleHostDetector.ts for the pure
 * detection rule (unit tested against fixture schedules).
 *
 * Response is IdleHostsResult ({ evaluated, findings }), NOT a bare array —
 * `evaluated: false` distinguishes "no scaling plan associated with this
 * host pool, detection could not run" from a genuine all-clear (evaluated:
 * true, findings: []); see that type's doc comment in @avdmgr/shared.
 */
export async function costIdleHosts(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const authResult = requireRole(request, ['viewer', 'operator', 'admin'], context);
  if (!authResult.ok) {
    return authResult.response;
  }

  try {
    const result = await getIdleHostFindings(
      (message) => context.warn(message),
      (message) => context.log(message),
    );
    return { status: 200, jsonBody: result };
  } catch (error) {
    const correlationId = randomUUID();
    context.error(`idle host detection failed | correlationId=${correlationId}`, error);
    const apiError: ApiError = {
      status: 502,
      code: 'idle_hosts_lookup_failed',
      message: `Failed to detect idle hosts. Reference: ${correlationId}`,
      details: { correlationId },
    };
    return { status: 502, jsonBody: apiError };
  }
}

app.http('costIdleHosts', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'v1/cost/idle-hosts',
  handler: costIdleHosts,
});
