import { randomUUID } from 'node:crypto';
import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import type { ApiError, DeleteRetiredProfileRequest, DeleteRetiredProfileResponse } from '@avdmgr/shared';
import { requireMinimumRole } from '../lib/auth';
import { isAuditRequiredButMissing, writeAuditEntry, type AuditLogger } from '../lib/auditLog';
import { badRequest, validateMandatoryReason } from '../lib/validation';
import {
  LockCheckFailedError,
  ProfileAmbiguousError,
  ProfileLockedError,
  RetiredProfileNotFoundError,
  RootFileMutationUnsupportedError,
  deleteRetiredProfile,
} from '../services/fslogixProfilesService';

/** Audit action id for this route — see app/api/src/lib/auditLog.ts. */
const AUDIT_ACTION = 'profile.deleteRetired';

/** Same pattern as profileReset.ts's PROFILE_FOLDER_NAME_PATTERN (Unicode letters/digits allowed; `/`, `\`, control characters, and a bare `.`/`..` remain rejected). */
const PROFILE_FOLDER_NAME_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N}._@-]{0,254}$/u;

function isValidFolderName(name: string): boolean {
  return PROFILE_FOLDER_NAME_PATTERN.test(name) && name !== '.' && name !== '..';
}

const RETIRED_FILE_NAME_MAX_LENGTH = 512;

/** Same coarse pre-filter as profileRestore.ts's isValidRetiredFileName — see that file's doc comment. */
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

/** Writes an audit row, swallowing any error the write itself throws — see profileReset.ts's identical helper for the full rationale. Applied to ALL THREE audit writes here (pre-mutation 'accepted', post-mutation 'success'/'failure'), not just one, for consistency (peer review nit — the original asymmetry was between success/failure paths; this file's own audit-before-mutation pattern adds a third call site that gets the same treatment). */
async function auditSafely(event: Parameters<typeof writeAuditEntry>[0], logger: AuditLogger, context: InvocationContext, correlationId: string, target: string): Promise<void> {
  try {
    await writeAuditEntry(event, logger);
  } catch (auditError) {
    context.warn(`audit write threw unexpectedly (ignored) | correlationId=${correlationId} target=${target} error=${String(auditError)}`);
  }
}

/**
 * AM-13 (M5) peer review item 7: DELETE /v1/profiles/{profileFolderName}/retired/{retiredFileName}
 * — admin-only, mandatory reason.
 *
 * ⚠ IRREVERSIBLE — PERMANENTLY deletes a retired profile VHD(X). Unlike
 * reset (undoable via POST .../restore), there is no further undo once
 * this succeeds. See @avdmgr/shared's DeleteRetiredProfileRequest doc
 * comment.
 *
 * FLAGGED FOR PRODUCT SIGN-OFF: this endpoint is implemented per the peer
 * review's explicit instruction ("build it, he gates it") but has NOT been
 * exercised against the live Contoso estate as part of this story — see
 * this story's final report for the explicit call-out a reviewer should check
 * before this is used in prod.
 *
 * AUDIT-BEFORE-MUTATION (distinct from every other mutating handler in
 * this app, which audits only after attempting the ARM/FileREST call):
 * writeAuditEntry is called ONCE BEFORE deleteRetiredProfile runs (outcome
 * 'accepted' — reusing that AuditOutcome value's existing "submitted, not
 * yet confirmed complete" semantics, the closest fit for "this destructive
 * action is about to be attempted"), and AGAIN AFTER with the real outcome
 * ('success' or 'failure'). Rationale: a delete is genuinely
 * unrecoverable, so this endpoint accepts writing one extra audit row
 * (writeAuditEntry's own AUDIT_EVENT structured-log line lands in
 * Application Insights unconditionally, even if the Table write itself
 * fails — see lib/auditLog.ts) in exchange for a trail that survives even
 * a process crash occurring immediately after the delete completes but
 * before this handler could write its own after-the-fact row.
 */
export async function profileDeleteRetired(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
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

  const retiredFileNameParam = request.params.retiredFileName;
  if (!retiredFileNameParam) {
    return badRequest('missing_retired_file_name', 'retiredFileName route parameter is required.');
  }
  if (!isValidRetiredFileName(retiredFileNameParam)) {
    return badRequest('invalid_retired_file_name', 'retiredFileName contains characters that are not allowed, or exceeds the maximum length.');
  }
  const retiredFileName = retiredFileNameParam;

  let body: DeleteRetiredProfileRequest;
  try {
    body = ((await request.json()) ?? {}) as DeleteRetiredProfileRequest;
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

  const target = `${folderName}/${retiredFileName}`;
  const actor = principal.userDetails;
  const actorId = principal.userId;
  const parameters = { retiredFileName };

  // AUDIT BEFORE MUTATION — see this handler's doc comment.
  await auditSafely({ actor, actorId, action: AUDIT_ACTION, target, parameters, reason, outcome: 'accepted', correlationId }, logger, context, correlationId, target);

  try {
    await deleteRetiredProfile(folderName, retiredFileName);

    await auditSafely({ actor, actorId, action: AUDIT_ACTION, target, parameters, reason, outcome: 'success', correlationId }, logger, context, correlationId, target);

    const responseBody: DeleteRetiredProfileResponse = { status: 'deleted', folderName, retiredFileName, correlationId };
    return { status: 200, jsonBody: responseBody };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    context.error(`profile retired-file delete failed | target=${target} correlationId=${correlationId} error=${errorMessage}`);

    await auditSafely({ actor, actorId, action: AUDIT_ACTION, target, parameters, reason, outcome: 'failure', detail: errorMessage, correlationId }, logger, context, correlationId, target);

    if (error instanceof RetiredProfileNotFoundError) {
      const apiError: ApiError = { status: 404, code: 'retired_profile_not_found', message: `${errorMessage} Reference: ${correlationId}`, details: { correlationId } };
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

    const apiError: ApiError = { status: 502, code: 'profile_delete_retired_failed', message: `Failed to delete the retired profile. Reference: ${correlationId}`, details: { correlationId } };
    return { status: 502, jsonBody: apiError };
  }
}

app.http('profileDeleteRetired', {
  methods: ['DELETE'],
  authLevel: 'anonymous',
  route: 'v1/profiles/{profileFolderName}/retired/{retiredFileName}',
  handler: profileDeleteRetired,
});
