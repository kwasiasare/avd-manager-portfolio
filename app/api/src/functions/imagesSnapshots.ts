import { randomUUID } from 'node:crypto';
import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import type { ApiError } from '@avdmgr/shared';
import { requireRole } from '../lib/auth';
import { getSnapshotReport } from '../services/snapshotsService';

/**
 * AM-26 (M4-S1): orphaned-snapshot report — every managed-disk snapshot in
 * RG-AVD-Images and RG-AVD-HostPools, with age/size/an approximate monthly
 * storage cost, and an orphaned heuristic (see
 * app/api/src/services/snapshotsService.ts#classifyOrphan). Read-only,
 * viewer+ — same role floor as GET /v1/images/current and .../versions.
 */
export async function imagesSnapshots(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const authResult = requireRole(request, ['viewer', 'operator', 'admin'], context);
  if (!authResult.ok) {
    return authResult.response;
  }

  try {
    const report = await getSnapshotReport({ warn: (message) => context.warn(message) });
    return { status: 200, jsonBody: report };
  } catch (error) {
    const correlationId = randomUUID();
    context.error(`snapshot report lookup failed | correlationId=${correlationId}`, error);
    const apiError: ApiError = {
      status: 502,
      code: 'image_snapshots_lookup_failed',
      message: `Failed to retrieve the snapshot report from Azure. Reference: ${correlationId}`,
      details: { correlationId },
    };
    return { status: 502, jsonBody: apiError };
  }
}

app.http('imagesSnapshots', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'v1/images/snapshots',
  handler: imagesSnapshots,
});
