import type { ProfileNameParseQuality } from '@avdmgr/shared';

/*
 * AM-13 (M5) — pure, defensively-written parsing helpers for FSLogix
 * profile folder/file naming. Deliberately isolated from
 * services/fslogixProfilesService.ts (which does the actual Azure I/O) so
 * every parsing edge case is unit-testable against plain string fixtures,
 * matching the pattern services/governance/*.ts already uses (pure
 * evaluateXxx, impure fetchXxx — see support.ts's header comment).
 *
 * WHY "parse defensively" (per this story's own instructions): the exact
 * profile-directory naming convention on THIS estate is NOT confirmed.
 * FSLogix's own default (FlipFlopProfileDirectoryName=0, the out-of-the-box
 * setting) names the container directory "%sid%_%username%" (SID first).
 * But the live diagnostic capture on this estate
 * (the FSLogix diagnostics notes, "FindFile failed for path:
 * ...\fslogixprofiles\<user>_<SID>\Profile*.VHDX") shows username FIRST —
 * which would mean FlipFlopProfileDirectoryName=1 is set via the Intune
 * profile, OR that the diagnostic doc's own placeholder ordering isn't a
 * literal transcription. The FSLogix operations runbook §1.2
 * explicitly flags this as unconfirmed too ("the exact naming pattern is
 * not captured in this inventory; confirm the live Intune profile before
 * assuming a specific format"). Given two genuinely conflicting sources and
 * no way to verify against the live Intune Settings Catalog profile from
 * this codebase, this module tries BOTH orders and never assumes either —
 * a folder that doesn't parse cleanly is surfaced as `nameParseQuality:
 * 'unrecognized'` (still listed, never dropped or crashed on) rather than
 * silently mis-attributed to the wrong user.
 */

/**
 * Windows/Entra Kerberos SID shape: "S-1-5-21-<subauth>-<subauth>-<subauth>-<rid>"
 * or a shorter well-known SID ("S-1-5-32-544", etc.) — always literal
 * "S-1-" (case-insensitive per convention, though every real SID this app
 * will see is upper-case) followed by 2-15 dash-separated decimal groups.
 * Deliberately specific (not just "looks numeric-ish") so it never
 * false-positives against a real username segment.
 */
const SID_PATTERN = /^S-1-\d+(-\d+){1,14}$/i;

export function looksLikeSid(value: string): boolean {
  return SID_PATTERN.test(value);
}

export interface ParsedProfileFolderName {
  sid: string | undefined;
  userPrincipalName: string | undefined;
  quality: ProfileNameParseQuality;
}

/**
 * Parses a profile folder name (the directory FSLogix creates directly
 * under the share root — see the header comment for why identity lives at
 * the folder level, not the VHD filename, in this app's design) into its
 * SID and username segments.
 *
 * Splits on '_' and checks whether the FIRST or LAST resulting segment is a
 * SID (see looksLikeSid) — the username segment is whatever remains,
 * rejoined with '_' (so a username that itself contains underscores, e.g.
 * a mailNickname like "j_doe", is not mangled). If NEITHER end segment is a
 * SID (or the name has no '_' at all), the name is `'unrecognized'` — both
 * fields are left undefined so no caller ever displays a fabricated
 * identity, and the raw folder name remains the only identifying string
 * (callers keep it via ProfileVhd.folderName regardless of parse quality).
 *
 * If BOTH ends look like a SID (pathological — would require an
 * underscore-only body), the FIRST-segment interpretation
 * ('sid_username') wins, deterministically.
 */
export function parseProfileFolderName(folderName: string): ParsedProfileFolderName {
  const trimmed = folderName.trim();
  const parts = trimmed.split('_').filter((part) => part.length > 0);

  if (parts.length < 2) {
    return { sid: undefined, userPrincipalName: undefined, quality: 'unrecognized' };
  }

  const [first, ...restAfterFirst] = parts;
  if (looksLikeSid(first)) {
    return { sid: first, userPrincipalName: restAfterFirst.join('_'), quality: 'sid_username' };
  }

  const last = parts[parts.length - 1];
  const restBeforeLast = parts.slice(0, -1);
  if (looksLikeSid(last)) {
    return { sid: last, userPrincipalName: restBeforeLast.join('_'), quality: 'username_sid' };
  }

  return { sid: undefined, userPrincipalName: undefined, quality: 'unrecognized' };
}

/** True for any file whose name ends in `.vhd` or `.vhdx` (case-insensitive) — FSLogix's two supported container formats. A retired file (see parseRetiredFileName) never matches this, since its name ends in the `.retired-<suffix>` marker instead of the VHD extension. */
export function isVhdFileName(fileName: string): boolean {
  return /\.vhdx?$/i.test(fileName);
}

const RETIRED_MARKER = '.retired-';

export interface ParsedRetiredFileName {
  isRetired: boolean;
  /** The name this file would be restored to — defined only when isRetired is true. */
  originalFileName: string | undefined;
  /** Best-effort ISO timestamp parsed from the retired-<suffix> marker — undefined when isRetired is true but the suffix doesn't match either recognized timestamp shape below (still correctly classified as retired; just no parsed date to show). */
  retiredAt: string | undefined;
}

/**
 * Recognizes TWO retired-suffix shapes, both matched case-insensitively on
 * the `.retired-` marker itself:
 *   - `yyyyMMdd-HHmmss` (compact, with time) — this feature's OWN format,
 *     produced by buildRetiredFileName below (see resetProfile in
 *     fslogixProfilesService.ts).
 *   - `yyyy-MM-dd` (date-only) — the manual runbook convention already
 *     documented in the FSLogix operations runbook §3
 *     ("Rename-Item ... -NewName ...retired-$today" where $today is
 *     `Get-Date -Format "yyyy-MM-dd"`). Profiles retired by hand before
 *     this feature existed must still show up in the retired list, not be
 *     silently invisible because they don't match this feature's own
 *     format.
 * Any OTHER suffix shape is still classified `isRetired: true` (the
 * `.retired-` marker itself is the classification signal) with
 * `retiredAt: undefined` — never mis-parsed into a bogus date.
 */
export function parseRetiredFileName(fileName: string): ParsedRetiredFileName {
  const markerIndex = fileName.toLowerCase().lastIndexOf(RETIRED_MARKER);
  if (markerIndex === -1) {
    return { isRetired: false, originalFileName: undefined, retiredAt: undefined };
  }

  const originalFileName = fileName.slice(0, markerIndex);
  const suffix = fileName.slice(markerIndex + RETIRED_MARKER.length);
  return { isRetired: true, originalFileName, retiredAt: parseRetiredTimestamp(suffix) };
}

function parseRetiredTimestamp(suffix: string): string | undefined {
  const compact = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/.exec(suffix);
  if (compact) {
    const [, y, mo, d, h, mi, s] = compact;
    return toIsoOrUndefined(`${y}-${mo}-${d}T${h}:${mi}:${s}.000Z`);
  }

  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(suffix);
  if (dateOnly) {
    const [, y, mo, d] = dateOnly;
    return toIsoOrUndefined(`${y}-${mo}-${d}T00:00:00.000Z`);
  }

  return undefined;
}

function toIsoOrUndefined(isoCandidate: string): string | undefined {
  const date = new Date(isoCandidate);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function pad(value: number, width: number): string {
  return value.toString().padStart(width, '0');
}

/**
 * Builds this feature's own retired-file name — `<fileName>.retired-yyyyMMdd-HHmmss`,
 * always in UTC (so the name itself is unambiguous regardless of the
 * server's local timezone — this app runs on Azure Functions Linux, which
 * defaults to UTC, but the explicit UTC-ness here doesn't depend on that).
 */
export function buildRetiredFileName(fileName: string, at: Date): string {
  const y = pad(at.getUTCFullYear(), 4);
  const mo = pad(at.getUTCMonth() + 1, 2);
  const d = pad(at.getUTCDate(), 2);
  const h = pad(at.getUTCHours(), 2);
  const mi = pad(at.getUTCMinutes(), 2);
  const s = pad(at.getUTCSeconds(), 2);
  return `${fileName}${RETIRED_MARKER}${y}${mo}${d}-${h}${mi}${s}`;
}

const GUID_PATTERN = /^([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{12})$/i;

/**
 * AM-13 peer review item 2: derives an Entra ID (Azure AD) object's
 * "Entra Kerberos cloud SID" (S-1-12-1-<a>-<b>-<c>-<d>) from its object id
 * (a GUID) — this estate is AADKERB (Entra Kerberos), and its share-level
 * RBAC is granted to AVD-Users, a CLOUD-ONLY group (the runbooks
 * §4). Cloud-only identities have NO
 * onPremisesSecurityIdentifier — the SID FSLogix stamps into a cloud-only
 * user's profile-folder name is instead this DERIVED S-1-12-1-* form, so
 * matching orphan status by onPremisesSecurityIdentifier alone (as an
 * earlier version of this module did) would incorrectly report every
 * genuinely-active cloud-only user's profile as an orphan.
 *
 * ALGORITHM — verified against Microsoft's own published PowerShell
 * function (learn.microsoft.com/surface-hub/surface-hub-2s-nonglobal-admin
 * #obtain-microsoft-entra-group-sid-using-powershell, "Convert-ObjectIdToSid"):
 *
 *   $d=[UInt32[]]::new(4)
 *   [Buffer]::BlockCopy([Guid]::Parse($ObjectId).ToByteArray(),0,$d,0,16)
 *   "S-1-12-1-$d".Replace(' ','-')
 *
 * i.e.: take the object id's 16-byte .NET `Guid.ToByteArray()`
 * representation — Data1 (first 8 hex chars) and Data2/Data3 (next two
 * 4-hex-char groups) are each stored LITTLE-ENDIAN; Data4 (the last 16 hex
 * chars, i.e. the last two hyphen-separated groups concatenated) is stored
 * byte-for-byte AS WRITTEN (this is .NET's well-documented mixed-endian
 * GUID byte layout, NOT a straight hex-string-to-bytes conversion) — then
 * reinterpret those 16 bytes as four LITTLE-ENDIAN UInt32 values; those
 * four decimal numbers become the SID's last four sub-authorities.
 *
 * Returns undefined for a non-GUID-shaped input (defensive — Graph's own
 * `id` field is always a GUID for a real object, but this must never throw
 * on malformed data).
 */
export function objectIdToEntraKerberosSid(objectId: string): string | undefined {
  const match = GUID_PATTERN.exec(objectId.trim());
  if (!match) {
    return undefined;
  }
  const [, data1Hex, data2Hex, data3Hex, data4aHex, data4bHex] = match;

  const bytes = new Uint8Array(16);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, Number.parseInt(data1Hex, 16), true);
  view.setUint16(4, Number.parseInt(data2Hex, 16), true);
  view.setUint16(6, Number.parseInt(data3Hex, 16), true);

  const data4Hex = data4aHex + data4bHex; // 16 hex chars = 8 bytes, stored as-is (no endian flip)
  for (let i = 0; i < 8; i += 1) {
    bytes[8 + i] = Number.parseInt(data4Hex.slice(i * 2, i * 2 + 2), 16);
  }

  const subAuthorities: number[] = [];
  for (let i = 0; i < 4; i += 1) {
    subAuthorities.push(view.getUint32(i * 4, true));
  }

  return `S-1-12-1-${subAuthorities.join('-')}`;
}
