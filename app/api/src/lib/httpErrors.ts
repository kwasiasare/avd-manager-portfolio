import type { HttpResponseInit } from '@azure/functions';
import type { ApiError } from '@avdmgr/shared';

/**
 * Standard 400 response shape for a caller-fixable bad request. Lifted out
 * of individual handlers — sessionHostDrain.ts (AM-18) and
 * hostPoolRegistrationToken.ts (AM-22) each originally defined their own
 * identical copy of this — so every validating/mutating route returns the
 * exact same ApiError shape rather than N slightly-driftable duplicates.
 */
export function badRequest(code: string, message: string): HttpResponseInit {
  const apiError: ApiError = { status: 400, code, message };
  return { status: 400, jsonBody: apiError };
}
