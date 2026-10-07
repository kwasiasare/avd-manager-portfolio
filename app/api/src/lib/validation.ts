import type { HttpResponseInit } from '@azure/functions';
import type { ApiError, PrincipalType } from '@avdmgr/shared';

/**
 * Shared request-validation helpers for every mutating handler
 * (sessionHostDrain.ts/AM-18, and the AM-20/M2-S3 session-operation
 * handlers: sessionForceLogoff.ts, sessionSendMessage.ts,
 * sessionsLogoffDisconnected.ts, sessionsBroadcast.ts). Originally AM-20
 * kept its own copy of these constants/helper to avoid touching
 * sessionHostDrain.ts's already-reviewed code — collapsed into this single
 * module per AM-20 peer review (duplicated MAX_REASON_LENGTH/
 * SESSION_HOST_NAME_PATTERN/badRequest is a maintenance risk two mutation
 * "generations" would otherwise drift apart on). sessionHostDrain.ts now
 * imports MAX_REASON_LENGTH, SESSION_HOST_NAME_PATTERN, and badRequest from
 * here; its own reason-is-OPTIONAL validation logic is unchanged (see that
 * file) — only the constants/helper moved, not the behavior.
 */

/** Well under Azure Table's 32K string cap, so an oversized reason/message is a clean 400 the caller can fix rather than a Table insert that throws (see auditLog.ts's writeAuditEntry, which never throws). */
export const MAX_REASON_LENGTH = 1000;

/** Bound for a session message body — same rationale as MAX_REASON_LENGTH. */
export const MAX_MESSAGE_BODY_LENGTH = 1000;

/** Bound for a session message title — titles are short by convention (AVD's own send-message UX treats it as a one-line heading), so a tighter cap than the body. */
export const MAX_MESSAGE_TITLE_LENGTH = 200;

/** ARM session host names: letters/digits plus dot/hyphen/underscore (dots cover the FQDN-style names AVD assigns to domain-joined hosts), 1-260 chars, must not start with a separator. */
export const SESSION_HOST_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,259}$/;

/**
 * ARM user-session ids are observed as short numeric strings (e.g. "1", "2"
 * — see app/api/src/services/avdService.ts's shortUserSessionId), but
 * validated loosely here (letters/digits/dot/hyphen/underscore, 1-100
 * chars) rather than assuming numeric-only, in case AVD ever changes the
 * format — the goal of this check is rejecting path-traversal/injection
 * shaped input before it reaches ARM, not modeling ARM's exact id grammar.
 */
export const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

export function badRequest(code: string, message: string): HttpResponseInit {
  const apiError: ApiError = { status: 400, code, message };
  return { status: 400, jsonBody: apiError };
}

/**
 * Result of validating+normalizing one request field: either the
 * TRIMMED, ready-to-persist/send value, or the HttpResponseInit to return
 * immediately. Callers must use `.value`, not the original raw field, so
 * what gets validated (length bounds) and what gets stored/sent to ARM/
 * audited are always the same string — see each validator's doc comment.
 */
export type FieldValidation<T> = { ok: true; value: T } | { ok: false; response: HttpResponseInit };

/**
 * Validates+trims a MANDATORY reason field (force logoff,
 * logoff-all-disconnected — see ForceLogoffSessionRequest/
 * LogoffAllDisconnectedRequest in @avdmgr/shared). Unlike
 * sessionHostDrain.ts's optional `reason`, an empty/whitespace-only/missing
 * reason here is itself a 400 — forcing a session off is more disruptive
 * than a drain toggle and must always be justified. The length bound is
 * checked against the TRIMMED value (what actually gets persisted/audited),
 * not the raw input.
 */
export function validateMandatoryReason(reason: unknown): FieldValidation<string> {
  if (typeof reason !== 'string' || reason.trim().length === 0) {
    return { ok: false, response: badRequest('missing_reason', 'reason is required and must be a non-empty string.') };
  }
  const trimmed = reason.trim();
  if (trimmed.length > MAX_REASON_LENGTH) {
    return { ok: false, response: badRequest('reason_too_long', `reason must be ${MAX_REASON_LENGTH} characters or fewer.`) };
  }
  return { ok: true, value: trimmed };
}

/** Validates+trims a mandatory message body (send-message, broadcast). Same trimmed-value contract as validateMandatoryReason. */
export function validateMandatoryMessageBody(body: unknown): FieldValidation<string> {
  if (typeof body !== 'string' || body.trim().length === 0) {
    return { ok: false, response: badRequest('missing_body', 'body is required and must be a non-empty string.') };
  }
  const trimmed = body.trim();
  if (trimmed.length > MAX_MESSAGE_BODY_LENGTH) {
    return { ok: false, response: badRequest('body_too_long', `body must be ${MAX_MESSAGE_BODY_LENGTH} characters or fewer.`) };
  }
  return { ok: true, value: trimmed };
}

/**
 * Validates+trims an OPTIONAL message title (send-message, broadcast).
 * `undefined` is valid. A title that is empty AFTER trimming (e.g. "   ")
 * normalizes to `undefined` too — an all-whitespace title is not a
 * meaningful title, and this keeps ARM's SendMessage.messageTitle (also
 * optional) from ever being set to a blank string.
 */
export function validateOptionalTitle(title: unknown): FieldValidation<string | undefined> {
  if (title === undefined) {
    return { ok: true, value: undefined };
  }
  if (typeof title !== 'string') {
    return { ok: false, response: badRequest('invalid_title', 'title, if provided, must be a string.') };
  }
  const trimmed = title.trim();
  if (trimmed.length > MAX_MESSAGE_TITLE_LENGTH) {
    return { ok: false, response: badRequest('title_too_long', `title must be ${MAX_MESSAGE_TITLE_LENGTH} characters or fewer.`) };
  }
  return { ok: true, value: trimmed.length > 0 ? trimmed : undefined };
}

/**
 * Validates+trims an OPTIONAL justification reason (AM-28: the rollout
 * wizard's start/start-removal/cancel actions, where a reason is welcome
 * but not mandatory — unlike validateMandatoryReason's actions, and unlike
 * force-proceed/remove-hosts/rollback's own MANDATORY reasons). `undefined`
 * is valid; an all-whitespace reason normalizes to `undefined` too, same
 * "don't persist a blank string" rationale as validateOptionalTitle above.
 */
export function validateOptionalReason(reason: unknown): FieldValidation<string | undefined> {
  if (reason === undefined) {
    return { ok: true, value: undefined };
  }
  if (typeof reason !== 'string') {
    return { ok: false, response: badRequest('invalid_reason', 'reason, if provided, must be a string.') };
  }
  const trimmed = reason.trim();
  if (trimmed.length > MAX_REASON_LENGTH) {
    return { ok: false, response: badRequest('reason_too_long', `reason must be ${MAX_REASON_LENGTH} characters or fewer.`) };
  }
  return { ok: true, value: trimmed.length > 0 ? trimmed : undefined };
}

/**
 * AM-14 (M6): Entra object IDs (principalId, and Graph search's `id`) are
 * GUIDs — the canonical 8-4-4-4-12 hex form, case-insensitive (Entra itself
 * returns them lowercase, but this app should not reject a caller who
 * copy-pasted an uppercase one). Validated BEFORE this app ever embeds the
 * value in an ARM resourceId/URL path segment (see
 * accessService.ts#createDesktopAssignment) — rejecting anything
 * non-GUID-shaped here is this app's own defense against a malformed or
 * deliberately-crafted principalId reaching ARM at all, independent of
 * whatever ARM's own validation would otherwise do with it.
 */
export const GUID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** Validates a mandatory principalId (POST /v1/access/assignments — see CreateAssignmentRequest in @avdmgr/shared). Not trimmed — a GUID with leading/trailing whitespace is simply invalid, not a value worth normalizing. */
export function validatePrincipalId(principalId: unknown): FieldValidation<string> {
  if (typeof principalId !== 'string' || !GUID_PATTERN.test(principalId)) {
    return { ok: false, response: badRequest('invalid_principal_id', 'principalId is required and must be a valid GUID.') };
  }
  return { ok: true, value: principalId };
}

const VALID_PRINCIPAL_TYPES: readonly PrincipalType[] = ['user', 'group'];

/** Validates a mandatory principalType (POST /v1/access/assignments). Case-sensitive — 'user'/'group' only, matching @avdmgr/shared's PrincipalType exactly (no normalization of e.g. 'User'/'USER' — a caller constructing this request body controls its own casing). */
export function validatePrincipalType(principalType: unknown): FieldValidation<PrincipalType> {
  if (typeof principalType !== 'string' || !(VALID_PRINCIPAL_TYPES as readonly string[]).includes(principalType)) {
    return { ok: false, response: badRequest('invalid_principal_type', `principalType is required and must be one of: ${VALID_PRINCIPAL_TYPES.join(', ')}.`) };
  }
  return { ok: true, value: principalType as PrincipalType };
}

/**
 * Validates+trims a mandatory workspace friendlyName (PATCH
 * /v1/workspace/friendly-name — see UpdateWorkspaceFriendlyNameRequest).
 * Bounded at 64 chars — Microsoft Learn's HostPool/Workspace friendlyName
 * property documents no explicit max, but the AVD portal's own "Friendly
 * name" field caps at 64 characters in practice; matched here so this app's
 * validation never accepts a value the portal itself would reject if edited
 * there afterward.
 *
 * AM-14 peer review (fix 13): an empty (or all-whitespace) friendlyName is
 * REJECTED, not silently accepted as "clear the name" — a workspace
 * friendly name accidentally submitted blank (e.g. a UI bug, or a caller
 * that forgot to populate the field) would otherwise silently wipe the
 * portal-visible name with no explicit signal that clearing was intended.
 * There is currently no supported way to intentionally clear the friendly
 * name through this endpoint; that would need its own explicit opt-in
 * (e.g. a separate `clear: true` flag) if ever needed.
 */
const MAX_FRIENDLY_NAME_LENGTH = 64;

export function validateFriendlyName(friendlyName: unknown): FieldValidation<string> {
  if (typeof friendlyName !== 'string') {
    return { ok: false, response: badRequest('invalid_friendly_name', 'friendlyName is required and must be a string.') };
  }
  const trimmed = friendlyName.trim();
  if (trimmed.length === 0) {
    return { ok: false, response: badRequest('friendly_name_required', 'friendlyName must not be empty. Clearing the friendly name is not supported by this endpoint.') };
  }
  if (trimmed.length > MAX_FRIENDLY_NAME_LENGTH) {
    return { ok: false, response: badRequest('friendly_name_too_long', `friendlyName must be ${MAX_FRIENDLY_NAME_LENGTH} characters or fewer.`) };
  }
  return { ok: true, value: trimmed };
}
