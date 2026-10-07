import { randomUUID } from 'node:crypto';
import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import type { ApiError, DuplicateContainerResolveMode, DuplicateContainerResolveRequest, DuplicateContainerResolveResponse } from '@avdmgr/shared';
import { requireMinimumRole } from '../lib/auth';
import { isAuditRequiredButMissing, writeAuditEntry, type AuditLogger } from '../lib/auditLog';
import { badRequest, validateMandatoryReason } from '../lib/validation';
import { isVhdFileName } from '../lib/fslogixProfileName';
import {
  LockCheckFailedError,
  ProfileAmbiguousError,
  ProfileLockedError,
  ProfileNotDuplicateError,
  ProfileNotFoundError,
  ProfileSessionCheckFailedError,
  ProfileUserSessionActiveError,
  ProfileUserUnresolvedError,
  RootFileMutationUnsupportedError,
  resolveDuplicateContainer,
} from '../services/fslogixProfilesService';

/** Audit action ids for this route — 'profile.' prefix, distinct ids for retire vs delete so the Audit page's action-family filter and any downstream review can tell the two apart at a glance (same "one id per distinct effect" convention as profile.reset/profile.deleteRetired). See app/api/src/lib/auditActionFamilies.test.ts, which pins both against Audit.tsx's 'profile.' family prefix. */
const AUDIT_ACTION_RETIRE = 'profile.duplicateRetire';
const AUDIT_ACTION_DELETE = 'profile.duplicateDelete';

/** Same pattern as profileReset.ts's PROFILE_FOLDER_NAME_PATTERN (Unicode letters/digits allowed; `/`, `\`, control characters, and a bare `.`/`..` remain rejected). */
const PROFILE_FOLDER_NAME_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N}._@-]{0,254}$/u;

function isValidFolderName(name: string): boolean {
  return PROFILE_FOLDER_NAME_PATTERN.test(name) && name !== '.' && name !== '..';
}

const FILE_NAME_MAX_LENGTH = 512;

/**
 * Validates the operator-chosen `fileName` from the request body — this is
 * NOT a route param (unlike profileRestore.ts/profileDeleteRetired.ts's
 * retiredFileName), so it gets its own explicit checks here rather than
 * relying on Azure Functions' route-segment decoding: no path separators (a
 * `/` or `\` would let a crafted fileName address a file outside the target
 * folder once concatenated into a FileREST path), no control characters, no
 * bare `.`/`..`, bounded length, and — the one check specific to this
 * endpoint — it must actually look like a live VHD(X) container name
 * (isVhdFileName), since this flow only ever resolves ACTIVE containers,
 * never a `.retired-*` file (that's restore/deleteRetired's job).
 */
function isValidActiveFileName(name: string): boolean {
  if (name.length === 0 || name.length > FILE_NAME_MAX_LENGTH) {
    return false;
  }
  if (name === '.' || name === '..') {
    return false;
  }
  for (let i = 0; i < name.length; i += 1) {
    const codePoint = name.codePointAt(i) ?? 0;
    const char = name[i];
    if (char === '\\' || char === '/' || codePoint <= 0x20 || codePoint === 0x7f) {
      return false;
    }
  }
  return isVhdFileName(name);
}

const VALID_MODES: readonly DuplicateContainerResolveMode[] = ['retire', 'delete'];

function isValidMode(value: unknown): value is DuplicateContainerResolveMode {
  return typeof value === 'string' && (VALID_MODES as readonly string[]).includes(value);
}

/** Writes an audit row, swallowing any error the write itself throws — see profileReset.ts's identical helper for the full rationale. */
async function auditSafely(event: Parameters<typeof writeAuditEntry>[0], logger: AuditLogger, context: InvocationContext, correlationId: string, target: string): Promise<void> {
  try {
    await writeAuditEntry(event, logger);
  } catch (auditError) {
    context.warn(`audit write threw unexpectedly (ignored) | correlationId=${correlationId} target=${target} error=${String(auditError)}`);
  }
}

/**
 * AM-51: POST /v1/profiles/{profileFolderName}/duplicates/resolve —
 * admin-only, mandatory reason. Guided fix for a folder holding more than
 * one active VHD(X) container (see @avdmgr/shared's ProfileVhd.
 * duplicateContainer doc comment for the motivating 2026-08-22 incident) —
 * the operator picks exactly one of the folder's active files and either
 * RETIRES it (rename — reversible via the existing restore flow) or
 * PERMANENTLY DELETES it. See fslogixProfilesService.ts#resolveDuplicateContainer
 * for the full fail-closed gate order (re-verify not-duplicate, active-
 * session check, hard lock check) this handler defers to entirely — this
 * file's own job is auth/validation/audit/error-mapping only, same division
 * of responsibility as profileReset.ts/profileDeleteRetired.ts.
 *
 * AUDIT-BEFORE-MUTATION for 'delete' (mirrors profileDeleteRetired.ts's own
 * posture — an irreversible action gets a pre-mutation 'accepted' row in
 * addition to the post-mutation success/failure one, so a process crash
 * immediately after the delete completes still leaves a trail). 'retire' is
 * audited after only (mirrors profileReset.ts — the action is undoable via
 * restore, so the extra pre-mutation row isn't warranted).
 *
 * DELIBERATELY ADMIN-ONLY — same rationale as profileReset.ts: resolving a
 * duplicate container by deleting/renaming one of the two files is
 * destructive to that file's contents (or, for delete, irreversibly so).
 */
export async function profileDuplicateResolve(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
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

  let body: DuplicateContainerResolveRequest;
  try {
    body = ((await request.json()) ?? {}) as DuplicateContainerResolveRequest;
  } catch {
    return badRequest('invalid_request_body', 'Request body must be valid JSON.');
  }

  const fileName = body.fileName;
  if (typeof fileName !== 'string' || fileName.length === 0) {
    return badRequest('missing_file_name', 'fileName is required and must be a non-empty string.');
  }
  if (!isValidActiveFileName(fileName)) {
    return badRequest('invalid_file_name', 'fileName must not contain path separators or control characters, and must end in .vhd or .vhdx.');
  }

  if (!isValidMode(body.mode)) {
    return badRequest('invalid_mode', `mode is required and must be one of: ${VALID_MODES.join(', ')}.`);
  }
  const mode = body.mode;

  const reasonResult = validateMandatoryReason(body.reason);
  if (!reasonResult.ok) {
    return reasonResult.response;
  }
  const reason = reasonResult.value;

  // Fail-closed: see sessionHostDrain.ts's identical check for the full
  // rationale. Checked after input validation, before any FileREST call.
  if (isAuditRequiredButMissing()) {
    context.error(`AUDIT_MISCONFIGURED | correlationId=${correlationId} action=profile.duplicate${mode} — AUDIT_STORAGE_ACCOUNT_NAME is unset in a deployed environment; refusing to mutate.`);
    const apiError: ApiError = {
      status: 500,
      code: 'audit_not_configured',
      message: `This environment cannot record an audit trail for this action, so it was not performed. Reference: ${correlationId}`,
      details: { correlationId },
    };
    return { status: 500, jsonBody: apiError };
  }

  const auditAction = mode === 'retire' ? AUDIT_ACTION_RETIRE : AUDIT_ACTION_DELETE;
  const target = `${folderName}/${fileName}`;
  const actor = principal.userDetails;
  const actorId = principal.userId;
  const baseParameters = { folderName, fileName };

  // AUDIT BEFORE MUTATION for delete only — see this handler's doc comment.
  if (mode === 'delete') {
    await auditSafely({ actor, actorId, action: auditAction, target, parameters: baseParameters, reason, outcome: 'accepted', correlationId }, logger, context, correlationId, target);
  }

  try {
    const result = await resolveDuplicateContainer(folderName, fileName, mode);

    const parameters = { ...baseParameters, retiredFileName: result.retiredFileName, activeSiblingCount: result.activeSiblingCount };
    await auditSafely({ actor, actorId, action: auditAction, target, parameters, reason, outcome: 'success', correlationId }, logger, context, correlationId, target);

    const responseBody: DuplicateContainerResolveResponse = {
      status: mode === 'retire' ? 'retired' : 'deleted',
      folderName,
      fileName,
      retiredFileName: result.retiredFileName,
      correlationId,
    };
    return { status: 200, jsonBody: responseBody };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    context.error(`profile duplicate-container resolve failed | target=${target} mode=${mode} correlationId=${correlationId} error=${errorMessage}`);

    await auditSafely({ actor, actorId, action: auditAction, target, parameters: baseParameters, reason, outcome: 'failure', detail: errorMessage, correlationId }, logger, context, correlationId, target);

    if (error instanceof ProfileNotDuplicateError) {
      const apiError: ApiError = { status: 409, code: 'profile_not_duplicate', message: `${errorMessage} Reference: ${correlationId}`, details: { correlationId } };
      return { status: 409, jsonBody: apiError };
    }
    if (error instanceof ProfileUserUnresolvedError) {
      const apiError: ApiError = { status: 409, code: 'profile_user_unresolved', message: `${errorMessage} Reference: ${correlationId}`, details: { correlationId } };
      return { status: 409, jsonBody: apiError };
    }
    if (error instanceof ProfileUserSessionActiveError) {
      const apiError: ApiError = {
        status: 409,
        code: 'profile_user_session_active',
        message: `${errorMessage} Reference: ${correlationId}`,
        details: { correlationId, sessionHostName: error.sessionHostName },
      };
      return { status: 409, jsonBody: apiError };
    }
    if (error instanceof ProfileSessionCheckFailedError) {
      const apiError: ApiError = { status: 503, code: 'profile_session_check_failed', message: `${errorMessage} Reference: ${correlationId}`, details: { correlationId } };
      return { status: 503, jsonBody: apiError };
    }
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

    const apiError: ApiError = { status: 502, code: 'profile_duplicate_resolve_failed', message: `Failed to resolve the duplicate container. Reference: ${correlationId}`, details: { correlationId } };
    return { status: 502, jsonBody: apiError };
  }
}

app.http('profileDuplicateResolve', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'v1/profiles/{profileFolderName}/duplicates/resolve',
  handler: profileDuplicateResolve,
});
