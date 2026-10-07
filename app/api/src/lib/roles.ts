import type { Role } from '@avdmgr/shared';
import type { AppConfig } from './config';

/**
 * Shape of the payload Azure Static Web Apps POSTs to a configured
 * `rolesSource` function during login (before the client principal has any
 * app roles assigned). See:
 * https://learn.microsoft.com/azure/static-web-apps/authentication-custom#roles
 *
 * SWA includes a `groups` claim only when "Emit groups as role claims" /
 * the Entra app registration's group claims are enabled on the app
 * registration (see docs/app-registration.md, section 3). If group claims
 * are not enabled, `claims` will not contain a "groups" entry and this
 * mapper falls back to an empty role set — callers must enable one of the
 * two documented options (group claims, or a Graph `User.Read.All` lookup)
 * for role mapping to work at all.
 */
export interface RolesSourceRequestBody {
  identityProvider?: string;
  userId?: string;
  userDetails?: string;
  claims?: Array<{ typ?: string; val?: string }>;
}

const GROUPS_CLAIM_TYPES = new Set([
  'groups',
  'http://schemas.microsoft.com/ws/2008/06/identity/claims/groups',
  'http://schemas.microsoft.com/identity/claims/groups',
]);

/**
 * Claim types Entra/AAD substitutes for `groups` once a user is in too many
 * groups to enumerate inline in the token ("groups overage"):
 *   - `_claim_names` (v2.0 tokens): value is a JSON object like
 *     `{"groups":"src1"}`, pointing at a `_claim_sources` entry instead of
 *     listing groups directly.
 *   - `hasgroups` (v1.0 tokens): value is the literal string "true".
 * Neither carries usable group IDs — extractGroupIds intentionally does NOT
 * try to parse them (that would require a Microsoft Graph call, which this
 * function has no access to); see hasGroupsOverage below, which detects
 * this case so callers can log it distinctly rather than silently resolving
 * to zero roles and leaving an operator to guess why.
 */
const OVERAGE_CLAIM_TYPES = new Set(['_claim_names', 'hasgroups']);

/** Extracts the set of Entra group object IDs present in the SWA-forwarded claims array. */
export function extractGroupIds(body: RolesSourceRequestBody): string[] {
  if (!Array.isArray(body.claims)) {
    return [];
  }
  return body.claims
    .filter((claim) => typeof claim.typ === 'string' && GROUPS_CLAIM_TYPES.has(claim.typ) && typeof claim.val === 'string')
    .map((claim) => claim.val as string);
}

/**
 * True when the claims array shows signs of Entra's "groups overage"
 * behavior (see OVERAGE_CLAIM_TYPES) — i.e. the user IS in Entra groups, but
 * the token could not list them directly. Distinguishing this from "the
 * user just isn't in any mapped group" matters operationally: the former
 * needs a Graph-based fix (see docs/app-registration.md section 4), the
 * latter is just how the app is supposed to behave for that user.
 */
export function hasGroupsOverage(body: RolesSourceRequestBody): boolean {
  if (!Array.isArray(body.claims)) {
    return false;
  }
  return body.claims.some((claim) => typeof claim.typ === 'string' && OVERAGE_CLAIM_TYPES.has(claim.typ.toLowerCase()));
}

/**
 * Maps a set of Entra group object IDs to this app's Role set, using the
 * GROUP_ID_VIEWER / GROUP_ID_OPERATOR / GROUP_ID_ADMIN config values.
 * Compared case-insensitively — Entra object IDs (GUIDs) are conventionally
 * lowercase but are not guaranteed to arrive that way from every claim
 * source, and a config value pasted with different casing than the token
 * should still match.
 *
 * - A group ID not present in `groupIds` (unknown group) contributes no role.
 * - A user in multiple mapped groups gets all corresponding roles (e.g. an
 *   admin who is also in the operator group gets both — the frontend's
 *   RoleGate/pickPrimaryRole already handles a multi-role principal).
 * - A role whose config value is unset never matches (readOptionalEnv leaves
 *   it undefined rather than '', so it can't accidentally match an empty
 *   group id string in the claims).
 */
export function mapGroupsToRoles(groupIds: string[], config: Pick<AppConfig, 'groupIds'>): Role[] {
  const roles: Role[] = [];
  const seen = new Set(groupIds.map((id) => id.toLowerCase()));

  if (config.groupIds.viewer && seen.has(config.groupIds.viewer.toLowerCase())) {
    roles.push('viewer');
  }
  if (config.groupIds.operator && seen.has(config.groupIds.operator.toLowerCase())) {
    roles.push('operator');
  }
  if (config.groupIds.admin && seen.has(config.groupIds.admin.toLowerCase())) {
    roles.push('admin');
  }

  return roles;
}

/** End-to-end: SWA rolesSource request body -> Role[] for the response. */
export function resolveRoles(body: RolesSourceRequestBody, config: Pick<AppConfig, 'groupIds'>): Role[] {
  return mapGroupsToRoles(extractGroupIds(body), config);
}
