import type {
  DuplicateContainerResolveMode,
  FileRestUnavailableReason,
  ProfileContainerKind,
  ProfileOrphanDetectionState,
  ProfileOrphanStatus,
  ProfileVhd,
  ProfilesListResponse,
  RetiredProfileVhd,
} from '@avdmgr/shared';
import { getConfig } from '../lib/config';
import { buildRetiredFileName, isVhdFileName, objectIdToEntraKerberosSid, parseProfileFolderName, parseRetiredFileName, type ParsedProfileFolderName } from '../lib/fslogixProfileName';
import { getFslogixShareServiceClient } from '../lib/fslogixFileRestClient';
import { graphListAll, isGraphForbidden } from '../lib/graphRest';
import { getFslogixShareUsage } from './fslogixService';
import { listUserSessions } from './avdService';

/*
 * AM-13 (M5) — FSLogix profile management.
 *
 * DESIGN VALIDATION (this story's own first task): see
 * app/api/src/lib/fslogixFileRestClient.ts's header comment for the full
 * "why OAuth FileREST works despite allowSharedKeyAccess: false" writeup
 * with Microsoft Learn citations (x-ms-file-request-intent, the Storage
 * File Data Privileged Contributor role, SDK support, the private-endpoint
 * network path, rename-under-OAuth, List Handles). CONFIRMED CORRECT by
 * Opus peer review — not reworked here.
 *
 * PEER REVIEW FIX ROUND (this file's second pass) — see each numbered
 * section below for the specific fix; summarized here:
 *   1. fetchGroupMembers() is now exhaustive (never rethrows) AND its call
 *      site in listProfilesUncached is additionally wrapped, so a non-403
 *      Graph failure degrades ONLY orphan detection, never 502s the page.
 *   2. Orphan matching now ALSO derives and matches the Entra Kerberos
 *      cloud SID (S-1-12-1-*) from each Graph member's object id — this
 *      estate's AVD-Users group is cloud-only, so onPremisesSecurityIdentifier
 *      alone was producing false orphans for every active cloud-only user.
 *   3. The Graph membership snapshot's `truncated` flag is now propagated
 *      and used to downgrade a non-match to 'unknown' (not 'orphan') when
 *      the snapshot might be incomplete, plus $top=999 raises the
 *      per-page ceiling.
 *   4. Loose root-level VHD files (no wrapping directory) get
 *      `kind: 'root-file'`; reset/restore/delete now REFUSE (via
 *      assertMutableDirectory) whenever the target folderName doesn't
 *      resolve to an unambiguous real directory — closing the "loose file
 *      derives the same name as a real directory, mutation hits the wrong
 *      target" bug.
 *   5. (UI-side fix — see Profiles.tsx and StatusBadge.tsx.)
 *   6. listProfiles now caches its 'available' result for
 *      PROFILES_CACHE_TTL_MS, cutting the ~2N+1 FileREST calls/poll/tab
 *      cost; degraded/unavailable results are never cached (retried
 *      promptly). The reset/restore/delete lock gate is a SEPARATE code
 *      path, never cached.
 *   7. deleteRetiredProfile (new) — see its own doc comment.
 *   8. resolveLockState now follows the List Handles continuation marker
 *      instead of trusting an empty FIRST page alone.
 *   9. A 409 from the rename call itself (a TOCTOU window between this
 *      app's lock check and the rename — see resetProfile/restoreProfile's
 *      doc comments) now maps to ProfileLockedError/RestoreConflictError
 *      instead of falling through to a generic 502.
 *  10. fetchRawShareSnapshot now catches a PER-DIRECTORY listing failure
 *      (returning that directory as empty + setting `partial: true`)
 *      instead of letting one bad directory blank the whole response.
 *  11. The FileREST-unavailable path now reports orphanDetection as
 *      'not-evaluated' (this call never got far enough to check Graph),
 *      not a fabricated 'not-configured'.
 *  14. Both FileREST degradation and per-file lock-check failures are
 *      logged server-side via an optional logger (functions/profiles.ts
 *      passes `context`) — see ProfilesServiceLogger.
 *  17. fileRest.reason is now a coarse classification
 *      (network/forbidden/other), never the raw SDK error text — the raw
 *      text goes to the logger only.
 */

// ---------------------------------------------------------------------------
// Raw share snapshot (impure — the only part of this module that talks to
// Azure Files) and pure classification (heavily unit-tested against plain
// fixtures — see fslogixProfilesService.test.ts).
// ---------------------------------------------------------------------------

/** Narrow logging contract this service accepts — same "small, consumer-owned interface" pattern as services/governance/support.ts's GovernanceLogger and lib/auditLog.ts's AuditLogger. Optional everywhere (defaults to a no-op) so existing callers/tests that don't care about logging don't need to thread one through. */
export interface ProfilesServiceLogger {
  log: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string, error?: unknown) => void;
}

const noopLogger: ProfilesServiceLogger = { log: () => {}, warn: () => {}, error: () => {} };

export interface RawFileEntry {
  name: string;
  sizeBytes: number;
  /** SMB last-write time (falling back to HTTP Last-Modified); undefined when the listing returned neither. */
  lastModified: Date | undefined;
}

/** One profile "container" — normally a share-root DIRECTORY, but see deriveLooseFileContainerName for the documented fallback shape (a bare VHD file directly at the share root, no folder wrapper). `kind` (peer review item 4) is carried through to every ProfileVhd/RetiredProfileVhd row derived from it, and gates reset/restore/delete — see @avdmgr/shared's ProfileContainerKind doc comment. */
export interface RawContainer {
  containerName: string;
  kind: ProfileContainerKind;
  files: RawFileEntry[];
}

/** Strips a trailing `.vhd`/`.vhdx`, or a trailing `.retired-<suffix>` marker (recovering the pre-retirement name first), from a bare filename — used only to derive a parseable "container name" for a loose top-level file that has no wrapping directory. */
export function deriveLooseFileContainerName(fileName: string): string {
  const retired = parseRetiredFileName(fileName);
  const base = retired.isRetired && retired.originalFileName ? retired.originalFileName : fileName;
  return base.replace(/\.vhdx?$/i, '');
}

/**
 * Bounds how many per-directory/per-file FileREST calls run concurrently —
 * same "small worker-pool, not unbounded Promise.all" rationale as
 * lib/sessionBatch.ts's DEFAULT_CONCURRENCY (an unbounded fan-out over
 * every directory or every active file risks 429 throttling and outbound
 * SNAT port exhaustion on Flex Consumption). Not sessionBatch.ts's own
 * runSessionBatch — that machinery is shaped around SessionBatchResult
 * (per-target success/fail/skip aggregation for a MUTATION), a different
 * contract than the plain read-fan-out this module needs — so a small
 * local helper (mapWithConcurrency below) is used instead.
 */
const DEFAULT_FILEREST_CONCURRENCY = 8;

/** Runs `mapper` over `items` with at most `concurrency` in flight at once, preserving input order in the returned array. */
async function mapWithConcurrency<T, R>(items: readonly T[], concurrency: number, mapper: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      results[index] = await mapper(items[index], index);
    }
  }
  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

export interface RawShareSnapshot {
  containers: RawContainer[];
  /** Peer review item 10: true when at least one DIRECTORY's own listing call failed (that directory is included as `{ files: [] }` rather than dropped) — the snapshot is partial, not empty/complete. Loose root-file enumeration failing would fail the whole root listing (caught by listProfilesUncached's own try/catch), so this flag only ever concerns per-directory failures. */
  partial: boolean;
}

/**
 * Walks the FSLogix profile share via OAuth FileREST: lists the share root,
 * then one level into every directory found there (fanned out with bounded
 * concurrency — DEFAULT_FILEREST_CONCURRENCY — since a real estate can have
 * dozens to hundreds of profile directories, and listing them one at a time
 * would make this call's latency scale linearly with profile count). Loose
 * top-level VHD/retired files (the FSLogix operations runbook
 * §3's documented "if the container is a .vhdx file directly rather than a
 * folder wrapper" fallback) each become their own single-file container
 * (`kind: 'root-file'`) so they are never silently dropped.
 *
 * A single directory's listing failing (peer review item 10) does NOT fail
 * the whole snapshot — that directory is recorded with `files: []` and
 * `partial` is set true, logged via `logger`, so a rare per-directory
 * hiccup degrades ONE row's data, not the entire page.
 *
 * Intentionally only ONE level deep — FSLogix does not nest profile
 * containers, and this app has no reason to recurse further; a directory
 * containing sub-directories would simply have those sub-directories
 * ignored (not an error).
 */
export async function fetchRawShareSnapshot(logger: ProfilesServiceLogger = noopLogger): Promise<RawShareSnapshot> {
  const { storage } = getConfig();
  const shareClient = getFslogixShareServiceClient().getShareClient(storage.fslogixShareName);
  const root = shareClient.rootDirectoryClient;

  const directoryNames: string[] = [];
  const looseFiles: RawFileEntry[] = [];

  // includeTimestamps: FileREST's List Directories and Files omits ALL
  // timestamps unless $include=Timestamps is requested — without it every
  // entry's lastModified/lastWriteTime is undefined (live-test finding:
  // the UI showed epoch zero for every profile).
  for await (const entry of root.listFilesAndDirectories({ includeTimestamps: true })) {
    if (entry.kind === 'directory') {
      directoryNames.push(entry.name);
    } else {
      looseFiles.push(toRawFileEntry(entry.name, entry.properties));
    }
  }

  let partial = false;
  const directoryContainers = await mapWithConcurrency(directoryNames, DEFAULT_FILEREST_CONCURRENCY, async (name): Promise<RawContainer> => {
    try {
      const directoryClient = root.getDirectoryClient(name);
      const files: RawFileEntry[] = [];
      for await (const child of directoryClient.listFilesAndDirectories({ includeTimestamps: true })) {
        if (child.kind === 'file') {
          files.push(toRawFileEntry(child.name, child.properties));
        }
      }
      return { containerName: name, kind: 'directory', files };
    } catch (error) {
      // Single-threaded event loop: this assignment from within a
      // concurrent worker is safe (no true parallelism, and the only
      // mutation is idempotent true-setting — never a read-modify-write
      // race).
      partial = true;
      logger.error(`FSLogix profiles: directory listing failed | folderName=${name} error=${error instanceof Error ? error.message : String(error)}`, error);
      return { containerName: name, kind: 'directory', files: [] };
    }
  });

  const looseContainers: RawContainer[] = looseFiles.map((file) => ({ containerName: deriveLooseFileContainerName(file.name), kind: 'root-file', files: [file] }));

  return { containers: [...directoryContainers, ...looseContainers], partial };
}

function toRawFileEntry(name: string, properties: { contentLength: number; lastModified?: Date; lastWriteTime?: Date }): RawFileEntry {
  return {
    name,
    sizeBytes: properties.contentLength,
    // Prefer the SMB last-write time (what "the profile changed" means to an
    // operator); undefined — NOT a fabricated epoch — when the service
    // returned neither, so the UI renders "Unknown" instead of 1969.
    lastModified: properties.lastWriteTime ?? properties.lastModified,
  };
}

export interface ClassifiedActiveProfile {
  folderName: string;
  fileName: string;
  kind: ProfileContainerKind;
  sizeBytes: number;
  lastModified: Date | undefined;
  parsed: ParsedProfileFolderName;
}

export interface ClassifiedRetiredProfile {
  folderName: string;
  kind: ProfileContainerKind;
  retiredFileName: string;
  originalFileName: string;
  sizeBytes: number;
  lastModified: Date | undefined;
  retiredAt: string | undefined;
  parsed: ParsedProfileFolderName;
}

export interface ClassifiedProfiles {
  active: ClassifiedActiveProfile[];
  retired: ClassifiedRetiredProfile[];
}

/**
 * Pure: sorts every file in every container into "active VHD(X)",
 * "retired" (matches the `.retired-<suffix>` marker), or silently ignored
 * (anything else — e.g. a stray `desktop.ini`). The container's name is
 * parsed once (parseProfileFolderName) and attached to every file found
 * inside it.
 *
 * ORDER (peer review nit): the `.vhd`/`.vhdx` extension check runs FIRST,
 * the `.retired-` marker check only for names that AREN'T a live VHD
 * extension. A real active file (e.g. "Profile.retired-user.vhdx" — an
 * unlucky but legal filename for a user literally named "retired-user")
 * must classify as ACTIVE, not retired, purely because it happens to
 * contain the literal substring ".retired-" earlier in its name — the file
 * extension is the more reliable signal than a substring match.
 */
export function classifyContainers(containers: RawContainer[]): ClassifiedProfiles {
  const active: ClassifiedActiveProfile[] = [];
  const retired: ClassifiedRetiredProfile[] = [];

  for (const container of containers) {
    const parsed = parseProfileFolderName(container.containerName);
    for (const file of container.files) {
      if (isVhdFileName(file.name)) {
        active.push({ folderName: container.containerName, fileName: file.name, kind: container.kind, sizeBytes: file.sizeBytes, lastModified: file.lastModified, parsed });
        continue;
      }
      const retiredInfo = parseRetiredFileName(file.name);
      if (retiredInfo.isRetired) {
        retired.push({
          folderName: container.containerName,
          kind: container.kind,
          retiredFileName: file.name,
          originalFileName: retiredInfo.originalFileName ?? file.name,
          sizeBytes: file.sizeBytes,
          lastModified: file.lastModified,
          retiredAt: retiredInfo.retiredAt,
          parsed,
        });
      }
    }
  }

  return { active, retired };
}

const BYTES_PER_GIB = 1024 ** 3;

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export function bytesToGib(sizeBytes: number): number {
  return round2(sizeBytes / BYTES_PER_GIB);
}

/** Pure: sizeBytes at or above thresholdGb counts as oversized (inclusive, so a profile sitting exactly on the configured threshold is flagged — an operator who set FSLOGIX_OVERSIZED_GB=5 means "5 and up", not "strictly more than 5"). */
export function isOversized(sizeBytes: number, thresholdGb: number): boolean {
  return bytesToGib(sizeBytes) >= thresholdGb;
}

// ---------------------------------------------------------------------------
// Orphan detection — Graph GroupMember.Read.All cross-check, degrading
// gracefully (see services/governance/conditionalAccessBreakGlass.ts, the
// established pattern this mirrors, per this story's own instructions).
// ---------------------------------------------------------------------------

/** AM-13's own Graph application-permission grant — see docs/app-registration.md's new section for the manual az CLI step (GroupMember.Read.All cannot be granted from Bicep, same posture as Policy.Read.All — see that file's section 9). Verified against Microsoft Learn's Graph permissions reference: GroupMember.Read.All application id 98830695-27a2-44f7-8c18-0c3ebc9698f6. */
export const GROUP_MEMBER_READ_ALL_APP_ROLE_ID = '98830695-27a2-44f7-8c18-0c3ebc9698f6';

/** Grant instructions surfaced verbatim in the degraded evidence — kept as one source of truth shared with docs/app-registration.md (copy that file's exact commands if this ever changes), same convention as conditionalAccessBreakGlass.ts's GRAPH_GRANT_INSTRUCTIONS. */
export const AVD_USERS_GRAPH_GRANT_INSTRUCTIONS = [
  '# Requires an Entra role with app-role-assignment rights (Privileged Role Administrator / Cloud Application Administrator), run once per environment:',
  'FUNC_MI_OBJECT_ID=$(az functionapp identity show --name <functionAppName> --resource-group RG-AVD-Management --query principalId -o tsv)',
  'GRAPH_SP_OBJECT_ID=$(az ad sp show --id 00000003-0000-0000-c000-000000000000 --query id -o tsv)',
  'az rest --method POST \\',
  '  --url "https://graph.microsoft.com/v1.0/servicePrincipals/$GRAPH_SP_OBJECT_ID/appRoleAssignedTo" \\',
  '  --headers "Content-Type=application/json" \\',
  `  --body "{\\"principalId\\": \\"$FUNC_MI_OBJECT_ID\\", \\"resourceId\\": \\"$GRAPH_SP_OBJECT_ID\\", \\"appRoleId\\": \\"${GROUP_MEMBER_READ_ALL_APP_ROLE_ID}\\"}"`,
] as const;

interface GraphDirectoryObject {
  '@odata.type'?: string;
  id?: string;
  userPrincipalName?: string;
  onPremisesSecurityIdentifier?: string;
}

export interface GroupMemberIdentity {
  /** Hybrid-user SID (Graph's onPremisesSecurityIdentifier) — undefined for a cloud-only member. */
  sid: string | undefined;
  /**
   * Peer review item 2: this estate's AVD-Users group is CLOUD-ONLY
   * (the FSLogix storage runbook §4), and AADKERB stamps a
   * cloud-only user's profile-folder SID as their DERIVED Entra Kerberos
   * cloud SID (S-1-12-1-*, from lib/fslogixProfileName.ts#objectIdToEntraKerberosSid
   * applied to the member's Graph object id) — NOT their (nonexistent)
   * onPremisesSecurityIdentifier. Matching against `sid` alone was
   * producing a FALSE ORPHAN verdict for every genuinely-active cloud-only
   * member.
   */
  entraKerberosSid: string | undefined;
  /** The local part of userPrincipalName (before '@') — the closest available heuristic for matching against a folder-parsed username, which is typically a mailNickname/SAM-style short name, not a full UPN. */
  userPrincipalNameLocalPart: string | undefined;
}

/**
 * Peer review items 1 and 3 combined into one discriminated union (replaces
 * the earlier `GroupMemberIdentity[] | 'not-configured' | 'graph-not-granted'`
 * shape, which had no room for "Graph was called but failed for a reason
 * OTHER than 403" — the exact gap that let a Graph 500/timeout/mistyped-
 * group-id-404 escape uncaught and 502 the whole Profiles page):
 *   - 'not-configured': AVD_USERS_GROUP_ID app setting is unset.
 *   - 'graph-not-granted': Graph returned 403 (the app role isn't granted).
 *   - 'unavailable': Graph was called and failed for any OTHER reason.
 *   - 'ok': the membership snapshot was fetched — `truncated` (peer review
 *     item 3) is true when MAX_LIST_PAGES×pageSize (lib/restClient.ts) was
 *     hit before pagination finished, meaning `members` may be missing
 *     entries; matchOrphan downgrades a non-match to 'unknown' rather than
 *     'orphan' when this is true, since an unseen member could be the real
 *     match.
 */
export type GroupMembersResult =
  | { status: 'ok'; members: GroupMemberIdentity[]; truncated: boolean }
  | { status: 'not-configured' }
  | { status: 'graph-not-granted' }
  | { status: 'unavailable'; reason: string };

/**
 * Fetches the AVD-Users group's TRANSITIVE membership (not just direct
 * members — mirrors the FSLogix operations runbook §4.1's own
 * "resolve transitive group membership" caution for offboarding checks,
 * applied here for the same reason: a nested group would otherwise hide its
 * members from a direct-members-only query). Filters to user objects only
 * (a group's members can include service principals/devices, which have no
 * userPrincipalName/onPremisesSecurityIdentifier of their own and would
 * only ever produce false "orphan" verdicts if left in).
 *
 * `$top=999` (peer review item 3) raises Graph's own per-page size toward
 * its practical ceiling, reducing how many pages MAX_LIST_PAGES (20, in
 * lib/restClient.ts) needs to cover before `truncated` trips — 20 pages ×
 * 999 ≈ 20,000 members headroom, versus the previous default page size's
 * ≈2,000.
 *
 * NEVER rethrows except is not possible: every path here returns a
 * GroupMembersResult variant, including 'unavailable' for a non-403
 * failure — peer review item 1's actual fix (the listProfilesUncached call
 * site ALSO wraps this call in try/catch as defense-in-depth, but the real
 * fix is that this function no longer has an unhandled throw path at all).
 */
export async function fetchGroupMembers(): Promise<GroupMembersResult> {
  const { profiles } = getConfig();
  if (!profiles.avdUsersGroupId) {
    return { status: 'not-configured' };
  }

  try {
    const { items, truncated } = await graphListAll<GraphDirectoryObject>(
      `/groups/${encodeURIComponent(profiles.avdUsersGroupId)}/transitiveMembers?$select=id,userPrincipalName,onPremisesSecurityIdentifier&$top=999`,
    );
    const members = items
      .filter((item) => item['@odata.type'] === undefined || item['@odata.type'] === '#microsoft.graph.user')
      .map((item) => ({
        sid: item.onPremisesSecurityIdentifier,
        entraKerberosSid: item.id ? objectIdToEntraKerberosSid(item.id) : undefined,
        userPrincipalNameLocalPart: item.userPrincipalName?.split('@')[0],
      }));
    return { status: 'ok', members, truncated };
  } catch (error) {
    if (isGraphForbidden(error)) {
      return { status: 'graph-not-granted' };
    }
    return { status: 'unavailable', reason: error instanceof Error ? error.message : String(error) };
  }
}

export interface OrphanVerdict {
  status: ProfileOrphanStatus;
  evidence: string;
}

/**
 * Pure: matches one parsed profile identity against the AVD-Users
 * membership snapshot.
 *
 * SID matching (peer review item 2) checks a profile's parsed SID against
 * EITHER a member's on-premises SID OR their derived Entra Kerberos cloud
 * SID — either is authoritative on its own.
 *
 * Username-only match wording (peer review item 2's second half): the
 * "possible SID drift" phrasing is used ONLY when the profile has a SID
 * AND at least one AVD-Users member carries SOME SID (on-prem or derived)
 * — i.e. SID matching was genuinely possible this refresh and still came
 * up empty, which is a real drift signal. When NO member in the whole
 * snapshot carries any SID at all (SID matching was never possible this
 * refresh — e.g. a transient issue deriving/reading them), the wording
 * says so explicitly instead of implying a drift that was never actually
 * checkable. Before this fix, "possible SID drift" fired on effectively
 * every row on this AADKERB estate (see entraKerberosSid's doc comment for
 * why on-premises SID alone was always empty here).
 *
 * Truncation handling (peer review item 3): a non-match against a
 * TRUNCATED snapshot downgrades to 'unknown' (not 'orphan') — an unseen
 * member past the truncation point could be the real match.
 */
export function matchOrphan(parsed: ParsedProfileFolderName, result: GroupMembersResult): OrphanVerdict {
  if (result.status === 'not-configured') {
    return { status: 'unknown', evidence: 'Orphan detection is not configured for this environment — the AVD_USERS_GROUP_ID app setting is unset.' };
  }
  if (result.status === 'graph-not-granted') {
    return {
      status: 'unknown',
      evidence: "Microsoft Graph GroupMember.Read.All has not been granted to this app's managed identity yet — see docs/app-registration.md.",
    };
  }
  if (result.status === 'unavailable') {
    return { status: 'unknown', evidence: `Orphan detection could not run for this refresh — Microsoft Graph returned an error (${result.reason}).` };
  }
  if (parsed.quality === 'unrecognized') {
    return { status: 'unknown', evidence: 'This profile folder name could not be parsed into a SID or username, so it cannot be matched against AVD-Users group membership.' };
  }

  const { members, truncated } = result;
  const anyMemberHasSid = members.some((member) => member.sid || member.entraKerberosSid);

  if (parsed.sid) {
    const sidUpper = parsed.sid.toUpperCase();
    const sidMatch = members.some((member) => member.sid?.toUpperCase() === sidUpper || member.entraKerberosSid?.toUpperCase() === sidUpper);
    if (sidMatch) {
      return { status: 'not-orphan', evidence: `Matched AVD-Users group membership by SID (${parsed.sid}).` };
    }
  }

  const usernameLower = parsed.userPrincipalName?.toLowerCase();
  if (usernameLower && members.some((member) => member.userPrincipalNameLocalPart?.toLowerCase() === usernameLower)) {
    if (parsed.sid && anyMemberHasSid) {
      return {
        status: 'not-orphan',
        evidence: `No AVD-Users member has a matching SID (on-premises or Entra Kerberos), but one matches by username ("${parsed.userPrincipalName}") — possible SID drift; treat as a lead to verify manually, not a confirmed match.`,
      };
    }
    if (parsed.sid && !anyMemberHasSid) {
      return {
        status: 'not-orphan',
        evidence: `Matched AVD-Users group membership by username ("${parsed.userPrincipalName}") — SID matching was unavailable this refresh (no AVD-Users member's SID could be read or derived), so this profile's SID (${parsed.sid}) could not be independently verified.`,
      };
    }
    return { status: 'not-orphan', evidence: `Matched AVD-Users group membership by username ("${parsed.userPrincipalName}").` };
  }

  if (truncated) {
    return {
      status: 'unknown',
      evidence: 'The AVD-Users membership snapshot was truncated (too many members to enumerate in one refresh) and this profile did not match any member in the partial data retrieved — its true status cannot be determined this refresh.',
    };
  }

  const identityDescription = [parsed.sid ? `SID ${parsed.sid}` : undefined, parsed.userPrincipalName ? `username "${parsed.userPrincipalName}"` : undefined]
    .filter((part): part is string => Boolean(part))
    .join(' or ');
  return {
    status: 'orphan',
    evidence: `No AVD-Users group member matches this profile's ${identityDescription} — the user may have left the AVD-Users group or the estate.`,
  };
}

function orphanDetectionState(result: GroupMembersResult): ProfileOrphanDetectionState {
  if (result.status === 'not-configured') return { status: 'not-configured' };
  if (result.status === 'graph-not-granted') return { status: 'graph-permission-not-granted', grantInstructions: AVD_USERS_GRAPH_GRANT_INSTRUCTIONS };
  if (result.status === 'unavailable') return { status: 'unavailable', reason: result.reason };
  return { status: 'available' };
}

// ---------------------------------------------------------------------------
// Lock state (List Handles) — best-effort at LIST time (display only, never
// blocks the page); a HARD gate only at reset/restore(none)/delete time.
// ---------------------------------------------------------------------------

interface HandleLike {
  clientName?: string;
  clientIp?: string;
}

interface HandlesPageLike {
  handleList?: HandleLike[];
}

/**
 * Structural (not nominal) — matches both a real ShareFileClient (whose
 * `listHandles().byPage().next()` resolves an `IteratorResult<
 * FileListHandlesResponse>`, a strict superset of HandlesPageLike) and a
 * plain test double, without importing ShareFileClient's full type here.
 */
interface FileHandleLike {
  listHandles: () => { byPage: (options: { maxPageSize: number }) => AsyncIterator<HandlesPageLike> };
}

export interface LockState {
  locked: boolean;
  lockedBy: string | undefined;
}

/** Safety bound on how many List Handles pages resolveLockState will walk (at maxPageSize:1, this is 50 open handles on ONE file — realistically never hit for a single-user profile VHD) before giving up and throwing, rather than looping forever. Hitting this throws (see below) rather than returning "unlocked" — callers' existing catch blocks already treat a failed lock check as "could not verify" (fail-closed at reset/restore/delete time; best-effort-unlocked at list time), so this reuses that behavior instead of inventing a new fail mode. */
const MAX_LOCK_CHECK_PAGES = 50;

/**
 * Calls FileREST List Handles for one file, returning whether ANY open
 * handle exists and, if so, its holder's identity (clientName — "name of
 * the client machine where the share is being mounted", i.e. The session
 * host — falling back to clientIp when clientName isn't populated).
 *
 * Peer review item 8: follows the List Handles CONTINUATION MARKER across
 * pages rather than trusting a single first page alone — Azure Files' List
 * operations can return an EMPTY page with a non-exhausted continuation
 * token (an internal-partitioning artifact, not unique to this API), which
 * would otherwise make this safety gate fail OPEN (report "unlocked" when
 * a later page actually has a handle). maxPageSize: 1 is kept (this only
 * needs to know "zero or nonzero," not the full handle list) — the fix is
 * looping across `.next()` calls until either a handle is found or the
 * iterator reports `done`, bounded by MAX_LOCK_CHECK_PAGES.
 */
export async function resolveLockState(fileClient: FileHandleLike): Promise<LockState> {
  const iterator = fileClient.listHandles().byPage({ maxPageSize: 1 });
  for (let page = 0; page < MAX_LOCK_CHECK_PAGES; page += 1) {
    const result = await iterator.next();
    if (result.done) {
      return { locked: false, lockedBy: undefined };
    }
    const handles = result.value?.handleList ?? [];
    if (handles.length > 0) {
      const holder = handles[0];
      return { locked: true, lockedBy: holder.clientName || holder.clientIp || undefined };
    }
  }
  throw new Error(`List Handles did not resolve within ${MAX_LOCK_CHECK_PAGES} pages — treating the lock state as unknown rather than assuming unlocked.`);
}

// ---------------------------------------------------------------------------
// Assembly (pure) — combines classification + oversized + orphan + lock
// results into the wire response shape.
// ---------------------------------------------------------------------------

/**
 * AM-51: counts, per real DIRECTORY folderName, how many active VHD(X)
 * entries share it — the duplicate-container signal. Deliberately excludes
 * `kind: 'root-file'` entries from this grouping (see ProfileVhd.
 * activeSiblingCount's doc comment): a loose root-level file's folderName is
 * DERIVED from its own filename (deriveLooseFileContainerName) and is not a
 * real shared folder, so two unrelated loose files that happen to derive the
 * same name must never be reported as "duplicates in one folder" — each
 * root-file row always counts itself alone (see computeActiveSiblingCount
 * below, which this map is consulted through).
 */
function countActiveDirectorySiblings(active: readonly ClassifiedActiveProfile[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const entry of active) {
    if (entry.kind !== 'directory') continue;
    counts.set(entry.folderName, (counts.get(entry.folderName) ?? 0) + 1);
  }
  return counts;
}

function computeActiveSiblingCount(entry: ClassifiedActiveProfile, directorySiblingCounts: ReadonlyMap<string, number>): number {
  if (entry.kind !== 'directory') return 1;
  return directorySiblingCounts.get(entry.folderName) ?? 1;
}

function toProfileVhd(entry: ClassifiedActiveProfile, thresholdGb: number, orphan: OrphanVerdict, lockState: LockState, activeSiblingCount: number): ProfileVhd {
  return {
    id: `${entry.folderName}::${entry.fileName}`,
    folderName: entry.folderName,
    fileName: entry.fileName,
    kind: entry.kind,
    sid: entry.parsed.sid,
    userPrincipalName: entry.parsed.userPrincipalName,
    nameParseQuality: entry.parsed.quality,
    sizeBytes: entry.sizeBytes,
    sizeGb: bytesToGib(entry.sizeBytes),
    lastModified: entry.lastModified?.toISOString(),
    oversized: isOversized(entry.sizeBytes, thresholdGb),
    orphanStatus: orphan.status,
    orphanEvidence: orphan.evidence,
    locked: lockState.locked,
    lockedBy: lockState.lockedBy,
    activeSiblingCount,
    duplicateContainer: activeSiblingCount > 1,
  };
}

function toRetiredProfileVhd(entry: ClassifiedRetiredProfile): RetiredProfileVhd {
  return {
    id: `${entry.folderName}::${entry.retiredFileName}`,
    folderName: entry.folderName,
    kind: entry.kind,
    sid: entry.parsed.sid,
    userPrincipalName: entry.parsed.userPrincipalName,
    nameParseQuality: entry.parsed.quality,
    retiredFileName: entry.retiredFileName,
    originalFileName: entry.originalFileName,
    sizeBytes: entry.sizeBytes,
    sizeGb: bytesToGib(entry.sizeBytes),
    lastModified: entry.lastModified?.toISOString(),
    retiredAt: entry.retiredAt,
  };
}

/**
 * Peer review item 17: classifies a FileREST listing failure into a coarse
 * reason WITHOUT exposing the raw SDK error text on the wire (that text is
 * logged server-side only — see listProfilesUncached). 'forbidden' (403)
 * usually means the Storage File Data Privileged Contributor role hasn't
 * propagated yet or is missing; 'network' covers common Node.js
 * connection-level failure codes and abort/timeout errors (the
 * private-endpoint path being unreachable); everything else is 'other'.
 */
export function classifyFileRestError(error: unknown): FileRestUnavailableReason {
  if (hasFileRestStatusCode(error, 403)) {
    return 'forbidden';
  }
  if (typeof error === 'object' && error !== null) {
    const code = (error as { code?: string }).code;
    if (typeof code === 'string' && ['ENOTFOUND', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH'].includes(code)) {
      return 'network';
    }
    const name = (error as { name?: string }).name;
    if (name === 'AbortError' || name === 'TimeoutError') {
      return 'network';
    }
  }
  return 'other';
}

/**
 * Peer review item 6: caches the last 'available' (fully successful)
 * listProfiles result for PROFILES_CACHE_TTL_MS — GET /v1/profiles costs
 * roughly 2N+1 FileREST calls (N directory listings + N lock checks + 1
 * root listing) per invocation, and the frontend polls every 60s PER OPEN
 * TAB, so multiple viewers (or a single viewer's post-mutation refresh)
 * within the same short window would otherwise each pay that full cost
 * again. A DEGRADED result (fileRest unavailable, or any other non-success
 * shape) is deliberately NEVER cached — retrying promptly is more valuable
 * than serving a stale failure for up to a minute.
 *
 * This cache is ONLY for the read path. resetProfile/restoreProfile/
 * deleteRetiredProfile never consult it — their lock-state check
 * (resolveLockState) is always a fresh, live FileREST call, which is the
 * one that actually has to be correct at the moment of mutation.
 */
const PROFILES_CACHE_TTL_MS = 45_000;
let cachedList: { value: ProfilesListResponse; expiresAt: number } | undefined;

/** Test-only: clears the module-level cache so a test that mocks the FileREST client differently from a previous test doesn't see a stale cached response. */
export function _resetProfilesCacheForTests(): void {
  cachedList = undefined;
}

/**
 * Orchestrator — the only function app/api/src/functions/profiles.ts calls.
 * Never throws: a FileREST failure degrades to the management-plane
 * fallback (see this file's header comment); a Graph failure degrades only
 * orphan detection. Wraps listProfilesUncached with the cache described
 * above (peer review item 6); `forceRefresh` bypasses it (mirrors
 * governanceService.ts's getGovernanceSummary convention).
 */
export async function listProfiles(options: { forceRefresh?: boolean; logger?: ProfilesServiceLogger } = {}): Promise<ProfilesListResponse> {
  const { forceRefresh = false, logger = noopLogger } = options;

  if (!forceRefresh && cachedList && cachedList.expiresAt > Date.now()) {
    return cachedList.value;
  }

  const result = await listProfilesUncached(logger);

  cachedList = result.fileRest.status === 'available' ? { value: result, expiresAt: Date.now() + PROFILES_CACHE_TTL_MS } : undefined;

  return result;
}

async function listProfilesUncached(logger: ProfilesServiceLogger): Promise<ProfilesListResponse> {
  const { storage, profiles } = getConfig();
  const generatedAt = new Date().toISOString();

  let snapshot: RawShareSnapshot;
  try {
    snapshot = await fetchRawShareSnapshot(logger);
  } catch (error) {
    const reasonKind = classifyFileRestError(error);
    logger.error(`FSLogix profiles: FileREST listing unavailable | reasonKind=${reasonKind} error=${error instanceof Error ? error.message : String(error)}`, error);

    let fallbackShareUsage;
    try {
      fallbackShareUsage = await getFslogixShareUsage();
    } catch (fallbackError) {
      logger.warn(`FSLogix profiles: management-plane fallback also failed | error=${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`);
      fallbackShareUsage = undefined;
    }
    return {
      storageAccountName: storage.accountName,
      shareName: storage.fslogixShareName,
      oversizedThresholdGb: profiles.oversizedGb,
      generatedAt,
      fileRest: { status: 'unavailable', reason: reasonKind },
      partial: false,
      profiles: [],
      retired: [],
      orphanDetection: { status: 'not-evaluated' },
      fallbackShareUsage,
    };
  }

  const { active, retired } = classifyContainers(snapshot.containers);

  // Peer review item 1: this call site ALSO catches, as defense-in-depth —
  // fetchGroupMembers itself is now exhaustive (never rethrows), but a
  // second layer here means a future bug in that function (or anything
  // this call transitively does) still can't 502 the whole page.
  let groupMembers: GroupMembersResult;
  try {
    groupMembers = await fetchGroupMembers();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    logger.error(`FSLogix profiles: orphan-detection Graph call failed unexpectedly | error=${reason}`, error);
    groupMembers = { status: 'unavailable', reason };
  }

  const shareClient = getFslogixShareServiceClient().getShareClient(storage.fslogixShareName);
  const lockStates = await mapWithConcurrency(active, DEFAULT_FILEREST_CONCURRENCY, async (entry): Promise<LockState> => {
    try {
      const fileClient = shareClient.rootDirectoryClient.getDirectoryClient(entry.folderName).getFileClient(entry.fileName);
      return await resolveLockState(fileClient);
    } catch (error) {
      // Best-effort at list time only — an individual failed handle check
      // must not fail the whole listing; the row simply shows unlocked.
      // (resetProfile/restoreProfile/deleteRetiredProfile apply a HARD,
      // fail-closed check instead — see resolveLockState's own callers
      // there.)
      logger.warn(
        `FSLogix profiles: lock-state check failed for one profile (showing unlocked) | folderName=${entry.folderName} fileName=${entry.fileName} error=${error instanceof Error ? error.message : String(error)}`,
      );
      return { locked: false, lockedBy: undefined };
    }
  });

  const directorySiblingCounts = countActiveDirectorySiblings(active);
  const profileRows: ProfileVhd[] = [];
  for (const [index, entry] of active.entries()) {
    const orphan = matchOrphan(entry.parsed, groupMembers);
    const activeSiblingCount = computeActiveSiblingCount(entry, directorySiblingCounts);
    profileRows.push(toProfileVhd(entry, profiles.oversizedGb, orphan, lockStates[index], activeSiblingCount));
  }

  return {
    storageAccountName: storage.accountName,
    shareName: storage.fslogixShareName,
    oversizedThresholdGb: profiles.oversizedGb,
    generatedAt,
    fileRest: { status: 'available' },
    partial: snapshot.partial,
    profiles: profileRows,
    retired: retired.map(toRetiredProfileVhd),
    orphanDetection: orphanDetectionState(groupMembers),
    fallbackShareUsage: undefined,
  };
}

// ---------------------------------------------------------------------------
// Reset (by rename) / restore / delete — the three mutations. Typed errors
// so the HTTP handlers (functions/profileReset.ts, profileRestore.ts,
// profileDeleteRetired.ts) can map each to a specific status code, same
// convention as avdService.ts's isNotFoundError/isConflictError but as
// distinct classes (this SDK's errors are RestError-shaped, not ARM's —
// see hasFileRestStatusCode).
// ---------------------------------------------------------------------------

export class ProfileNotFoundError extends Error {}
export class ProfileAmbiguousError extends Error {}
export class RetiredProfileNotFoundError extends Error {}
export class RestoreConflictError extends Error {}
export class LockCheckFailedError extends Error {}
/** Peer review item 4: thrown when a folderName does not resolve to an unambiguous, real profile directory — either it's a loose root-level file (kind: 'root-file', mutation unsupported through this app) or it doesn't exist at all. See assertMutableDirectory. */
export class RootFileMutationUnsupportedError extends Error {}
export class ProfileLockedError extends Error {
  readonly holder: string | undefined;
  constructor(holder: string | undefined) {
    super(holder ? `Profile is currently in use (open handle held by "${holder}").` : 'Profile is currently in use (an open handle was detected, but its holder could not be identified).');
    this.holder = holder;
  }
}

function hasFileRestStatusCode(error: unknown, statusCode: number): boolean {
  return typeof error === 'object' && error !== null && 'statusCode' in error && (error as { statusCode?: number }).statusCode === statusCode;
}

export function isFileRestNotFound(error: unknown): boolean {
  return hasFileRestStatusCode(error, 404);
}

export function isFileRestConflict(error: unknown): boolean {
  return hasFileRestStatusCode(error, 409);
}

/**
 * Peer review item 4's core fix: verifies `folderName` resolves to EXACTLY
 * ONE unambiguous thing before any mutation (reset/restore/delete) is
 * allowed to proceed against it — a single pass over the share root
 * checking BOTH "does a real directory named `folderName` exist" AND "does
 * any loose root-level file's DERIVED name collide with `folderName`"
 * (see deriveLooseFileContainerName). Without this, a loose file like
 * "Foo.vhdx" (derived folderName "Foo") sharing a name with a genuine
 * directory "Foo" would silently let a mutation intended for the loose row
 * hit the directory's VHD instead — there was no way to tell which the
 * caller meant from folderName alone.
 *
 * Three refusal cases, each a distinct, clearly-worded error:
 *   - directory exists AND a colliding loose file exists → ProfileAmbiguousError
 *     (409) — a human must rename one of them directly in Azure Files.
 *   - only a loose root-level file exists (kind: 'root-file') →
 *     RootFileMutationUnsupportedError (400) — this app does not support
 *     mutating that shape at all (the review's "refuse" option, chosen
 *     over implementing root-level rename semantics, which are genuinely
 *     different — no directory prefix — for a shape this estate's own
 *     docs only mention as a possible fallback, not a supported one).
 *   - neither exists → ProfileNotFoundError (404).
 *   - only the real directory exists, no collision → returns normally,
 *     the mutation proceeds exactly as before this fix.
 */
async function assertMutableDirectory(folderName: string): Promise<void> {
  const { storage } = getConfig();
  const shareClient = getFslogixShareServiceClient().getShareClient(storage.fslogixShareName);
  const root = shareClient.rootDirectoryClient;

  let directoryExists = false;
  let collidingRootFileName: string | undefined;

  for await (const entry of root.listFilesAndDirectories()) {
    if (entry.kind === 'directory' && entry.name === folderName) {
      directoryExists = true;
    } else if (entry.kind === 'file' && deriveLooseFileContainerName(entry.name) === folderName) {
      collidingRootFileName = entry.name;
    }
  }

  if (directoryExists && collidingRootFileName) {
    throw new ProfileAmbiguousError(
      `"${folderName}" is ambiguous — both a profile directory and a loose root-level file ("${collidingRootFileName}") resolve to this name. Rename one of them directly in Azure Files before retrying.`,
    );
  }
  if (directoryExists) {
    return;
  }
  if (collidingRootFileName) {
    throw new RootFileMutationUnsupportedError(
      `"${folderName}" is a loose root-level file ("${collidingRootFileName}"), not a profile directory — reset, restore, and delete are not supported for this shape through this app.`,
    );
  }
  throw new ProfileNotFoundError(`Profile "${folderName}" was not found on the ${storage.fslogixShareName} share.`);
}

async function listActiveDirectoryFiles(folderName: string): Promise<Array<{ name: string }>> {
  const { storage } = getConfig();
  const shareClient = getFslogixShareServiceClient().getShareClient(storage.fslogixShareName);
  const directoryClient = shareClient.rootDirectoryClient.getDirectoryClient(folderName);

  const files: Array<{ name: string }> = [];
  try {
    for await (const entry of directoryClient.listFilesAndDirectories()) {
      if (entry.kind === 'file') {
        files.push({ name: entry.name });
      }
    }
  } catch (error) {
    if (isFileRestNotFound(error)) {
      throw new ProfileNotFoundError(`Profile folder "${folderName}" was not found on the ${storage.fslogixShareName} share.`);
    }
    throw error;
  }
  return files;
}

/**
 * Resets a profile by renaming its single active VHD(X) file to
 * `<name>.retired-<yyyyMMdd-HHmmss>` (fslogixProfileName.ts#buildRetiredFileName)
 * WITHIN THE SAME FOLDER — the folder itself (and its sid/username
 * identity) is left untouched, only the file inside it is renamed. This is
 * a metadata-only FileREST rename (see this file's header comment,
 * validation item 1) — safe and fast regardless of the VHD's size.
 *
 * Peer review item 4: refuses up front (assertMutableDirectory) if
 * `folderName` doesn't resolve to an unambiguous real directory.
 *
 * HARD GATE (this story's own requirement): refuses with ProfileLockedError
 * if List Handles reports ANY open handle on the file. If the handle check
 * itself fails (a transient FileREST error distinct from "no handles"),
 * this refuses too (LockCheckFailedError) rather than proceeding on an
 * unverified assumption — a reset must never rename a file out from under
 * an active session just because this app couldn't confirm it was safe.
 *
 * RESIDUAL TOCTOU WINDOW (peer review item 9, documented honestly rather
 * than claimed away): the lock check and the rename below are two separate
 * FileREST calls — a new handle CAN open in the gap between them. If that
 * happens, Azure Files itself rejects the rename with a 409 (the file is
 * now in use), which this function maps to ProfileLockedError just like an
 * up-front lock detection would — so the caller-visible OUTCOME (409,
 * "profile is in use") is the same either way; only the reason and any
 * `holder` identity available differ (a rename-time 409 doesn't carry the
 * handle's holder, so `holder` is undefined in that case). This window is
 * inherent to any check-then-act pattern over a network API and is not
 * eliminable without a server-side atomic "rename if no handles" primitive,
 * which Azure Files' Rename File operation does not offer.
 */
export async function resetProfile(folderName: string): Promise<{ originalFileName: string; retiredFileName: string }> {
  await assertMutableDirectory(folderName);

  const { storage } = getConfig();
  const files = await listActiveDirectoryFiles(folderName);
  const activeFiles = files.filter((file) => isVhdFileName(file.name));

  if (activeFiles.length === 0) {
    throw new ProfileNotFoundError(`Profile folder "${folderName}" has no active VHD(X) file to reset.`);
  }
  if (activeFiles.length > 1) {
    throw new ProfileAmbiguousError(`Profile folder "${folderName}" has ${activeFiles.length} active VHD(X) files — resetting a folder with more than one active file is not supported.`);
  }

  const originalFileName = activeFiles[0].name;
  const shareClient = getFslogixShareServiceClient().getShareClient(storage.fslogixShareName);
  const fileClient = shareClient.rootDirectoryClient.getDirectoryClient(folderName).getFileClient(originalFileName);

  let lockState: LockState;
  try {
    lockState = await resolveLockState(fileClient);
  } catch {
    throw new LockCheckFailedError(`Could not verify whether "${folderName}/${originalFileName}" is currently in use — refusing to reset until this can be confirmed.`);
  }
  if (lockState.locked) {
    throw new ProfileLockedError(lockState.lockedBy);
  }

  const retiredFileName = buildRetiredFileName(originalFileName, new Date());
  try {
    await fileClient.rename(`${folderName}/${retiredFileName}`);
  } catch (error) {
    if (isFileRestConflict(error)) {
      // TOCTOU — see this function's doc comment. A new handle opened
      // between our check above and this rename call.
      throw new ProfileLockedError(undefined);
    }
    throw error;
  }

  return { originalFileName, retiredFileName };
}

/**
 * Restores a `.retired-*` file back to its pre-reset name, refusing
 * (RestoreConflictError) if a file already occupies that name — e.g. the
 * user signed in again after the reset and FSLogix created a fresh
 * container, so blindly restoring would silently clobber it.
 *
 * Peer review item 4: refuses up front (assertMutableDirectory) if
 * `folderName` doesn't resolve to an unambiguous real directory.
 *
 * Peer review item 9: a 409 from the rename call itself (the destination
 * name was created in the narrow window between this function's own
 * existence check and the rename — the same class of TOCTOU window
 * documented on resetProfile) now maps to RestoreConflictError, matching
 * the up-front existence-check's own error type, instead of falling
 * through to a generic 502.
 */
export async function restoreProfile(folderName: string, retiredFileName: string): Promise<{ restoredFileName: string }> {
  await assertMutableDirectory(folderName);

  const { storage } = getConfig();
  const parsed = parseRetiredFileName(retiredFileName);
  if (!parsed.isRetired || !parsed.originalFileName) {
    throw new RetiredProfileNotFoundError(`"${retiredFileName}" is not a recognized retired file name.`);
  }

  const shareClient = getFslogixShareServiceClient().getShareClient(storage.fslogixShareName);
  const directoryClient = shareClient.rootDirectoryClient.getDirectoryClient(folderName);
  const retiredClient = directoryClient.getFileClient(retiredFileName);
  const destinationClient = directoryClient.getFileClient(parsed.originalFileName);

  const destinationExists = await destinationClient.exists();
  if (destinationExists) {
    throw new RestoreConflictError(
      `Cannot restore — "${parsed.originalFileName}" already exists in folder "${folderName}" (the user likely signed in and received a fresh profile since the reset). Remove or rename it before restoring.`,
    );
  }

  try {
    await retiredClient.rename(`${folderName}/${parsed.originalFileName}`);
  } catch (error) {
    if (isFileRestNotFound(error)) {
      throw new RetiredProfileNotFoundError(`Retired file "${retiredFileName}" was not found in folder "${folderName}".`);
    }
    if (isFileRestConflict(error)) {
      throw new RestoreConflictError(
        `Cannot restore — "${parsed.originalFileName}" now exists in folder "${folderName}" (created in the narrow window between this app's existence check and the rename itself). Remove or rename it before retrying.`,
      );
    }
    throw error;
  }

  return { restoredFileName: parsed.originalFileName };
}

/**
 * Peer review item 7 (new endpoint): PERMANENTLY deletes a `.retired-*`
 * file. ⚠ IRREVERSIBLE — unlike reset (undoable via restore), there is no
 * further undo once this succeeds. See @avdmgr/shared's
 * DeleteRetiredProfileRequest doc comment and
 * functions/profileDeleteRetired.ts for the audit-BEFORE-mutation posture
 * this endpoint uses (distinct from reset/restore's audit-after-only
 * pattern) and the explicit product-sign-off flag.
 *
 * Same up-front ambiguity refusal (assertMutableDirectory) and HARD lock
 * gate (resolveLockState, fail-closed on a failed check) as
 * resetProfile — deleting a retired file that's somehow still open (e.g. a
 * stale handle from an interrupted restore attempt) must be refused, not
 * silently allowed.
 */
export async function deleteRetiredProfile(folderName: string, retiredFileName: string): Promise<void> {
  await assertMutableDirectory(folderName);

  const { storage } = getConfig();
  const parsed = parseRetiredFileName(retiredFileName);
  if (!parsed.isRetired) {
    throw new RetiredProfileNotFoundError(`"${retiredFileName}" is not a recognized retired file name.`);
  }

  const shareClient = getFslogixShareServiceClient().getShareClient(storage.fslogixShareName);
  const fileClient = shareClient.rootDirectoryClient.getDirectoryClient(folderName).getFileClient(retiredFileName);

  let lockState: LockState;
  try {
    lockState = await resolveLockState(fileClient);
  } catch {
    throw new LockCheckFailedError(`Could not verify whether "${folderName}/${retiredFileName}" is currently in use — refusing to delete until this can be confirmed.`);
  }
  if (lockState.locked) {
    throw new ProfileLockedError(lockState.lockedBy);
  }

  try {
    await fileClient.delete();
  } catch (error) {
    if (isFileRestNotFound(error)) {
      throw new RetiredProfileNotFoundError(`Retired file "${retiredFileName}" was not found in folder "${folderName}".`);
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// AM-51 — duplicate-container detection + guided retire/delete.
//
// Motivating incident (2026-08-22): a missing FSLogix VolumeType setting
// forked `Profile_dsmith.vhd` alongside `Profile_dsmith.VHDX` in the same
// folder — cleanup required manual Azure Files REST surgery through a VM's
// managed identity. Reset already refuses outright for this shape
// (ProfileAmbiguousError above), but nothing surfaced the condition
// proactively or offered a guided fix. See ProfileVhd.duplicateContainer's
// doc comment (@avdmgr/shared) for the listing-time signal this endpoint
// acts on.
// ---------------------------------------------------------------------------

export class ProfileNotDuplicateError extends Error {}
export class ProfileUserUnresolvedError extends Error {}
/** Thrown when the profile's user currently has an active AVD session anywhere in the host pool — see resolveDuplicateContainer's doc comment. `sessionHostName` is surfaced in the API error's `details` so the operator knows exactly where the session is. */
export class ProfileUserSessionActiveError extends Error {
  readonly sessionHostName: string;
  constructor(message: string, sessionHostName: string) {
    super(message);
    this.sessionHostName = sessionHostName;
  }
}
export class ProfileSessionCheckFailedError extends Error {}

export interface ResolveDuplicateContainerResult {
  mode: DuplicateContainerResolveMode;
  fileName: string;
  /** Present only when mode is 'retire'. */
  retiredFileName: string | undefined;
  /** The active-file count observed at the RE-VERIFY step (mutation time), for the audit row — see AUDIT_ACTION in functions/profileDuplicateResolve.ts. */
  activeSiblingCount: number;
}

/**
 * AM-51: the guided fix for a duplicate-container folder — retires
 * (renames, same as resetProfile) OR permanently deletes exactly ONE
 * operator-chosen active VHD(X) file from a folder that currently holds
 * more than one, so Reset (which refuses outright while more than one
 * active file exists — see ProfileAmbiguousError above) becomes available
 * again afterward automatically (Reset re-checks live state; no separate
 * "re-enable" step exists or is needed).
 *
 * GATE ORDER (each a distinct, fail-closed refusal — mirrors resetProfile's
 * own "refuse rather than guess" posture throughout):
 *   1. assertMutableDirectory — same ambiguity/root-file guard every other
 *      mutation in this file uses.
 *   2. RE-VERIFY at mutation time: lists the folder's active VHD(X) files
 *      FRESH and refuses (ProfileNotDuplicateError, 409) unless there
 *      currently are more than one AND `fileName` names one of them. The
 *      listing-time `duplicateContainer` flag is advisory only — this
 *      re-check is the actual invariant. Resolving the last/only active
 *      file in a folder is Reset's job, never this flow's.
 *   3. ACTIVE-SESSION CHECK (fail-closed, this story's own new gate — no
 *      prior mutation in this file checks sessions at all):
 *      parseProfileFolderName(folderName) must yield a username
 *      (ProfileUserUnresolvedError, 409, otherwise — this app has no way to
 *      confirm the profile's user has no active session without one); that
 *      username is matched, CASE-INSENSITIVELY, against every current
 *      session's UPN local part across the WHOLE host pool
 *      (listUserSessions) — the same local-part normalization
 *      matchOrphan/fetchGroupMembers use elsewhere in this file. ANY match,
 *      in ANY session state (Active, Disconnected, ...), refuses
 *      (ProfileUserSessionActiveError, 409, naming the session's host).
 *      listUserSessions itself failing refuses too
 *      (ProfileSessionCheckFailedError, 503) — mirroring
 *      LockCheckFailedError's fail-closed posture, this app must never
 *      proceed on an unverified "presumably no session" assumption.
 *   4. HARD lock check (resolveLockState) on the TARGET file only, same
 *      fail-closed contract as resetProfile/deleteRetiredProfile
 *      (LockCheckFailedError, 503 / ProfileLockedError, 409).
 *   5. The mutation itself: 'retire' renames to buildRetiredFileName (the
 *      file then appears in the existing Retired table, restorable via the
 *      existing restore flow — no new undo mechanism needed); 'delete'
 *      permanently deletes (mirrors deleteRetiredProfile — irreversible). A
 *      rename-time 409 (the same TOCTOU window resetProfile documents — a
 *      new handle can open between step 4's check and this rename) maps to
 *      ProfileLockedError, same outcome either way from the caller's
 *      perspective.
 */
export async function resolveDuplicateContainer(folderName: string, fileName: string, mode: DuplicateContainerResolveMode): Promise<ResolveDuplicateContainerResult> {
  await assertMutableDirectory(folderName);

  const { storage, hostPoolName } = getConfig();
  const files = await listActiveDirectoryFiles(folderName);
  const activeFiles = files.filter((file) => isVhdFileName(file.name));

  if (activeFiles.length <= 1 || !activeFiles.some((file) => file.name === fileName)) {
    throw new ProfileNotDuplicateError(
      `Profile folder "${folderName}" no longer has more than one active VHD(X) file including "${fileName}" — it may already have been resolved. Refresh the page and try again.`,
    );
  }

  const parsed = parseProfileFolderName(folderName);
  if (parsed.quality === 'unrecognized' || !parsed.userPrincipalName) {
    throw new ProfileUserUnresolvedError(
      `Profile folder "${folderName}" could not be parsed into a username, so this app cannot verify the profile's user has no active session — refusing to proceed.`,
    );
  }

  let sessions;
  try {
    sessions = await listUserSessions(hostPoolName);
  } catch {
    throw new ProfileSessionCheckFailedError(
      `Could not verify whether "${parsed.userPrincipalName}" currently has an active session — refusing to proceed until this can be confirmed.`,
    );
  }

  const usernameLower = parsed.userPrincipalName.toLowerCase();
  const activeSession = sessions.find((session) => session.userPrincipalName.split('@')[0].toLowerCase() === usernameLower);
  if (activeSession) {
    throw new ProfileUserSessionActiveError(
      `"${parsed.userPrincipalName}" currently has an active session on "${activeSession.sessionHostName}" — resolving this duplicate could disrupt that session. Ask the user to sign out first, then retry.`,
      activeSession.sessionHostName,
    );
  }

  const shareClient = getFslogixShareServiceClient().getShareClient(storage.fslogixShareName);
  const fileClient = shareClient.rootDirectoryClient.getDirectoryClient(folderName).getFileClient(fileName);

  let lockState: LockState;
  try {
    lockState = await resolveLockState(fileClient);
  } catch {
    throw new LockCheckFailedError(`Could not verify whether "${folderName}/${fileName}" is currently in use — refusing to proceed until this can be confirmed.`);
  }
  if (lockState.locked) {
    throw new ProfileLockedError(lockState.lockedBy);
  }

  if (mode === 'delete') {
    try {
      await fileClient.delete();
    } catch (error) {
      if (isFileRestNotFound(error)) {
        throw new ProfileNotFoundError(`"${folderName}/${fileName}" was not found — it may have been removed since this page last refreshed.`);
      }
      if (isFileRestConflict(error)) {
        // Fable review fix — same TOCTOU window as the retire branch's
        // rename below: this targets an ACTIVE container, so a user can
        // sign in (opening a handle) between gate 4's lock check and this
        // delete. Unlike deleteRetiredProfile's delete (whose retired
        // targets are never open), a sharing-violation 409 here means
        // "locked after all", not an unexpected failure.
        throw new ProfileLockedError(undefined);
      }
      throw error;
    }
    return { mode, fileName, retiredFileName: undefined, activeSiblingCount: activeFiles.length };
  }

  const retiredFileName = buildRetiredFileName(fileName, new Date());
  try {
    await fileClient.rename(`${folderName}/${retiredFileName}`);
  } catch (error) {
    if (isFileRestConflict(error)) {
      // TOCTOU — see this function's doc comment (gate 5). A new handle
      // opened between the lock check above and this rename call.
      throw new ProfileLockedError(undefined);
    }
    throw error;
  }
  return { mode, fileName, retiredFileName, activeSiblingCount: activeFiles.length };
}
