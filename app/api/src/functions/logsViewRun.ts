import { randomUUID } from 'node:crypto';
import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import type { ApiError } from '@avdmgr/shared';
import { requireMinimumRole } from '../lib/auth';
import { validateTimespanHours } from '../lib/logsGuard';
import { findCuratedView, runLogsQuery } from '../services/logsService';

const DEFAULT_TIMESPAN_HOURS = 24;

interface RunViewRequestBody {
  timespanHours?: number;
}

/**
 * POST /v1/logs/views/{viewId}/run — executes one of the four curated KQL
 * views against LAW-CONTOSO-PROD. Viewer+ (read-only — unlike the raw KQL
 * escape hatch, the query text itself is fixed/curated, so a viewer running
 * it carries no more risk than any other read-only report).
 */
export async function logsViewRun(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const authResult = requireMinimumRole(request, 'viewer', context);
  if (!authResult.ok) {
    return authResult.response;
  }

  const viewId = request.params.viewId;
  const view = viewId ? findCuratedView(viewId) : undefined;
  if (!view) {
    const apiError: ApiError = { status: 404, code: 'unknown_logs_view', message: `Unknown logs view id: ${viewId ?? '(missing)'}.` };
    return { status: 404, jsonBody: apiError };
  }

  let body: RunViewRequestBody = {};
  try {
    body = ((await request.json()) ?? {}) as RunViewRequestBody;
  } catch {
    // Empty body is fine — timespanHours is optional, defaulted below.
  }

  const hours = body.timespanHours ?? DEFAULT_TIMESPAN_HOURS;
  const timespanResult = validateTimespanHours(hours);
  if (!timespanResult.ok) {
    return { status: timespanResult.error.status, jsonBody: timespanResult.error };
  }

  try {
    const result = await runLogsQuery(view.kql, timespanResult.value);
    return { status: 200, jsonBody: result };
  } catch (error) {
    const correlationId = randomUUID();
    context.error(`logs view run failed | viewId=${viewId} correlationId=${correlationId}`, error);
    const apiError: ApiError = {
      status: 502,
      code: 'logs_view_run_failed',
      message: `Failed to run the "${view.name}" view against Log Analytics. Reference: ${correlationId}`,
      details: { correlationId },
    };
    return { status: 502, jsonBody: apiError };
  }
}

app.http('logsViewRun', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'v1/logs/views/{viewId}/run',
  handler: logsViewRun,
});
