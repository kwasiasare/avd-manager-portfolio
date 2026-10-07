import { randomUUID } from 'node:crypto';
import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import type { ApiError, ProfileRestoreRequest, ProfileRestoreResponse } from '@avdmgr/shared';
import { requireMinimumRole } from '../lib/auth';
import { isAuditRequiredButMissing, writeAuditEntry, type AuditLogger } from '../lib/auditLog';
import { badRequest, validateOptionalReason } from '../lib/validation';
import { RestoreConflictError, RetiredProfileNotFoundError, RootFileMutationUnsupportedError, restoreProfile } from '../services/fslogixProfilesService';

/** Audit action id for this route — see app/api/src/lib/auditLog.ts. */
const AUDIT_ACTION = 'profile.restore';

/** Same pattern as profileReset.ts's PROFILE_FOLDER_NAME_PATTERN (peer review item 12: Unicode letters/digits allowed; `/`, `\`, control characters, and a bare `.`/`..` remain rejected). */
const PROFILE_FOLDER_NAME_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N}._@-]{0,254}$/u;

function isValidFolderName(name: string): boolean {
  return PROFILE_FOLDER_NAME_PATTERN.test(name) && name !== '.' && name !== '..';
}

const RETIRED_FILE_NAME_MAX_LENGTH = 512;

/**
 * A retired file name is `<original>.retired-<suffix>` — real examples
 * contain letters, digits, dots, underscores, hyphens, and `@`. This is
 * only a coarse pre-filter against path-traversal/injection-shaped input:
 * rejects a bare backslash or forward slash anywhere in the string, plus
 * any whitespace/control character, plus an over-length value. The
 * authoritative "is this actually a retired name" check is
 * parseRetiredFileName in the service, not this pre-filter.
 */
function isValidRetiredFileName(name: string): boolean {
  if (name.length === 0 || name.length > RETIRED_FILE_NAME_MAX_LENGTH) {
    return false;
  }
  for (let i = 0; i < name.length; i += 1) {
    const codePoint = name.codePointAt(i) ?? 0;
    const char = name[i];
    if (char === '\\' || char === '/' || codePoint <= 0x20 || codePoint === 0x7f) {
      return false;
    }
  }
  return true;
}

/** Writes an audit row, swallowing any error the write itself throws — see profileReset.ts's identical helper for the full rationale (peer review nit: the failure path previously left its writeAuditEntry call unwrapped, unlike the success path). */
async function auditSafely(event: Parameters<typeof writeAuditEntry>[0], logger: AuditLogger, context: InvocationContext, correlationId: string, target: string): Promise<void> {
  try {
    await writeAuditEntry(event, logger);
  } catch (auditError) {
    context.warn(`audit write threw unexpectedly (ignored) | correlationId=${correlationId} target=${target} error=${String(auditError)}`);
  }
}

/**
 * AM-13 (M5): POST /v1/profiles/{profileFolderName}/restore — admin-only,
 * audited, reason OPTIONAL (restoring is corrective, not independently
 * disruptive the way a reset is — see @avdmgr/shared's
 * ProfileRestoreRequest doc comment; the Restore dialog's own copy notes
 * this refuses on a name conflict — see Profiles.tsx). `retiredFileName` in
 * the body is REQUIRED: a folder can carry more than one `.retired-*` file
 * if reset ran more than once without an intervening restore, so the
 * caller must say exactly which one.
 */
export async function profileRestore(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
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

  let body: ProfileRestoreRequest;
  try {
    body = ((await request.json()) ?? {}) as ProfileRestoreRequest;
  } catch {
    return badRequest('invalid_request_body', 'Request body must be valid JSON.');
  }

  if (typeof body.retiredFileName !== 'string' || body.retiredFileName.trim().length === 0) {
    return badRequest('missing_retired_file_name', 'retiredFileName is required and must be a non-empty string.');
  }
  const retiredFileName = body.retiredFileName.trim();
  if (!isValidRetiredFileName(retiredFileName)) {
    return badRequest('invalid_retired_file_name', 'retiredFileName contains characters that are not allowed, or exceeds the maximum length.');
  }

  const reasonResult = validateOptionalReason(body.reason);
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
    const { restoredFileName } = await restoreProfile(folderName, retiredFileName);

    await auditSafely(
      { actor, actorId, action: AUDIT_ACTION, target, parameters: { retiredFileName, restoredFileName }, reason, outcome: 'success', correlationId },
      logger,
      context,
      correlationId,
      target,
    );

    const responseBody: ProfileRestoreResponse = { status: 'restored', folderName, retiredFileName, restoredFileName, correlationId };
    return { status: 200, jsonBody: responseBody };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    context.error(`profile restore failed | target=${target} correlationId=${correlationId} error=${errorMessage}`);

    await auditSafely(
      { actor, actorId, action: AUDIT_ACTION, target, parameters: { retiredFileName }, reason, outcome: 'failure', detail: errorMessage, correlationId },
      logger,
      context,
      correlationId,
      target,
    );

    if (error instanceof RetiredProfileNotFoundError) {
      const apiError: ApiError = { status: 404, code: 'retired_profile_not_found', message: `${errorMessage} Reference: ${correlationId}`, details: { correlationId } };
      return { status: 404, jsonBody: apiError };
    }
    if (error instanceof RestoreConflictError) {
      const apiError: ApiError = { status: 409, code: 'restore_conflict', message: `${errorMessage} Reference: ${correlationId}`, details: { correlationId } };
      return { status: 409, jsonBody: apiError };
    }
    if (error instanceof RootFileMutationUnsupportedError) {
      const apiError: ApiError = { status: 400, code: 'root_file_mutation_unsupported', message: `${errorMessage} Reference: ${correlationId}`, details: { correlationId } };
      return { status: 400, jsonBody: apiError };
    }

    const apiError: ApiError = { status: 502, code: 'profile_restore_failed', message: `Failed to restore the profile. Reference: ${correlationId}`, details: { correlationId } };
    return { status: 502, jsonBody: apiError };
  }
}

app.http('profileRestore', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'v1/profiles/{profileFolderName}/restore',
  handler: profileRestore,
});
