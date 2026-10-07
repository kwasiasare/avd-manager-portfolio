import { randomUUID } from 'node:crypto';
import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import type { ApiError, ProfileResetRequest, ProfileResetResponse } from '@avdmgr/shared';
import { requireMinimumRole } from '../lib/auth';
import { isAuditRequiredButMissing, writeAuditEntry, type AuditLogger } from '../lib/auditLog';
import { badRequest, validateMandatoryReason } from '../lib/validation';
import { LockCheckFailedError, ProfileAmbiguousError, ProfileLockedError, ProfileNotFoundError, RootFileMutationUnsupportedError, resetProfile } from '../services/fslogixProfilesService';

/** Audit action id for this route — see app/api/src/lib/auditLog.ts. */
const AUDIT_ACTION = 'profile.reset';

/**
 * Same shape as sessionHostDrain.ts/sessionForceLogoff.ts's route-param
 * pattern, EXTENDED (peer review item 12) to allow Unicode letters/digits
 * (`\p{L}`/`\p{N}`) — a profile folder name's username half can be any
 * Entra display/mailNickname-derived string, which is not limited to
 * ASCII. Still explicitly excludes `/`, `\`, and control characters (they
 * are simply not members of `\p{L}`/`\p{N}` or the small punctuation set
 * below), and still rejects a bare '.' or '..' (path-traversal) outright —
 * those security-relevant exclusions are UNCHANGED by this fix.
 */
const PROFILE_FOLDER_NAME_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N}._@-]{0,254}$/u;

function isValidFolderName(name: string): boolean {
  return PROFILE_FOLDER_NAME_PATTERN.test(name) && name !== '.' && name !== '..';
}

/** Writes an audit row, swallowing any error the write itself throws — never lets a failed audit write mask (or crash out of) the caller-visible response for the action that was actually attempted. Used on both the success and failure paths (peer review nit — the failure path previously left its writeAuditEntry call unwrapped, unlike the success path). */
async function auditSafely(event: Parameters<typeof writeAuditEntry>[0], logger: AuditLogger, context: InvocationContext, correlationId: string, target: string): Promise<void> {
  try {
    await writeAuditEntry(event, logger);
  } catch (auditError) {
    context.warn(`audit write threw unexpectedly (ignored) | correlationId=${correlationId} target=${target} error=${String(auditError)}`);
  }
}

/**
 * AM-13 (M5): POST /v1/profiles/{profileFolderName}/reset — admin-only,
 * mandatory reason, audited on both success and failure (same
 * fail-closed-audit / correlationId / try-both-paths structure as
 * sessionForceLogoff.ts). Route param is named profileFolderName — see
 * services/fslogixProfilesService.ts's header comment ("PROFILE IDENTITY —
 * folder, not filename") for why a profile is addressed by its containing
 * directory, not a composite folder+file path; the server resolves the
 * single active VHD(X) file within that folder itself.
 *
 * DELIBERATELY ADMIN-ONLY (not operator+, unlike most of this app's other
 * mutating endpoints): resetting a profile is destructive to that user's
 * local customizations — an operator-level action would under-gate it
 * relative to the story's own "admin-only" instruction.
 */
export async function profileReset(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const correlationId = randomUUID();
  const logger: AuditLogger = {
    warn: (message) => context.warn(message),
    error: (message) => context.error(message),
    log: (message) => context.log(message),
  };

  const authResult = requireMinimumRole(request, 'admin', context);
  if (!authResult.ok) {
    return authResult.response;
  }
  const { principal } = authResult;

  const folderName = request.params.profileFolderName;
  if (!folderName) {
    return badRequest('missing_profile_folder_name', 'profileFolderName route parameter is required.');
  }
  if (!isValidFolderName(folderName)) {
    return badRequest(
      'invalid_profile_folder_name',
      'profileFolderName must be 1-255 characters, starting with a letter or digit, using only letters, digits, dots, hyphens, underscores, or @.',
    );
  }

  let body: ProfileResetRequest;
  try {
    body = ((await request.json()) ?? {}) as ProfileResetRequest;
  } catch {
    return badRequest('invalid_request_body', 'Request body must be valid JSON.');
  }

  const reasonResult = validateMandatoryReason(body.reason);
  if (!reasonResult.ok) {
    return reasonResult.response;
  }
  const reason = reasonResult.value;

  // Fail-closed: see sessionHostDrain.ts's identical check for the full
  // rationale. Checked after input validation, before any FileREST call.
  if (isAuditRequiredButMissing()) {
    context.error(`AUDIT_MISCONFIGURED | correlationId=${correlationId} action=${AUDIT_ACTION} — AUDIT_STORAGE_ACCOUNT_NAME is unset in a deployed environment; refusing to mutate.`);
    const apiError: ApiError = {
      status: 500,
      code: 'audit_not_configured',
      message: `This environment cannot record an audit trail for this action, so it was not performed. Reference: ${correlationId}`,
      details: { correlationId },
    };
    return { status: 500, jsonBody: apiError };
  }

  const target = folderName;
  const actor = principal.userDetails;
  const actorId = principal.userId;

  try {
    const { originalFileName, retiredFileName } = await resetProfile(folderName);

    await auditSafely(
      { actor, actorId, action: AUDIT_ACTION, target, parameters: { originalFileName, retiredFileName }, reason, outcome: 'success', correlationId },
      logger,
      context,
      correlationId,
      target,
    );

    const responseBody: ProfileResetResponse = { status: 'retired', folderName, originalFileName, retiredFileName, correlationId };
    return { status: 200, jsonBody: responseBody };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    context.error(`profile reset failed | target=${target} correlationId=${correlationId} error=${errorMessage}`);

    await auditSafely({ actor, actorId, action: AUDIT_ACTION, target, reason, outcome: 'failure', detail: errorMessage, correlationId }, logger, context, correlationId, target);

    if (error instanceof ProfileNotFoundError) {
      const apiError: ApiError = { status: 404, code: 'profile_not_found', message: `${errorMessage} Reference: ${correlationId}`, details: { correlationId } };
      return { status: 404, jsonBody: apiError };
    }
    if (error instanceof ProfileAmbiguousError) {
      const apiError: ApiError = { status: 409, code: 'profile_ambiguous', message: `${errorMessage} Reference: ${correlationId}`, details: { correlationId } };
      return { status: 409, jsonBody: apiError };
    }
    if (error instanceof RootFileMutationUnsupportedError) {
      const apiError: ApiError = { status: 400, code: 'root_file_mutation_unsupported', message: `${errorMessage} Reference: ${correlationId}`, details: { correlationId } };
      return { status: 400, jsonBody: apiError };
    }
    if (error instanceof ProfileLockedError) {
      const apiError: ApiError = {
        status: 409,
        code: 'profile_locked',
        message: `${errorMessage} Reference: ${correlationId}`,
        details: { correlationId, lockedBy: error.holder },
      };
      return { status: 409, jsonBody: apiError };
    }
    if (error instanceof LockCheckFailedError) {
      const apiError: ApiError = { status: 503, code: 'profile_lock_check_failed', message: `${errorMessage} Reference: ${correlationId}`, details: { correlationId } };
      return { status: 503, jsonBody: apiError };
    }

    const apiError: ApiError = { status: 502, code: 'profile_reset_failed', message: `Failed to reset the profile. Reference: ${correlationId}`, details: { correlationId } };
    return { status: 502, jsonBody: apiError };
  }
}

app.http('profileReset', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'v1/profiles/{profileFolderName}/reset',
  handler: profileReset,
});
