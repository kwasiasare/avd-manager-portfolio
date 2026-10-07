import { describe, expect, it } from 'vitest';
import { buildRetiredFileName, isVhdFileName, looksLikeSid, objectIdToEntraKerberosSid, parseProfileFolderName, parseRetiredFileName } from './fslogixProfileName';

const REAL_SID = 'S-1-5-21-853615705-2073118383-1177238915-1113';

describe('looksLikeSid', () => {
  it('matches a realistic Entra Kerberos/AD SID', () => {
    expect(looksLikeSid(REAL_SID)).toBe(true);
  });

  it('matches a short well-known SID', () => {
    expect(looksLikeSid('S-1-5-32-544')).toBe(true);
  });

  it('rejects a plain username', () => {
    expect(looksLikeSid('jdoe')).toBe(false);
  });

  it('rejects a string that merely starts with S-1 but is not dash-numeric', () => {
    expect(looksLikeSid('S-1-not-a-sid')).toBe(false);
  });

  it('rejects an empty string', () => {
    expect(looksLikeSid('')).toBe(false);
  });
});

describe('parseProfileFolderName', () => {
  it('parses sid_username order', () => {
    expect(parseProfileFolderName(`${REAL_SID}_jdoe`)).toEqual({ sid: REAL_SID, userPrincipalName: 'jdoe', quality: 'sid_username' });
  });

  it('parses username_sid order', () => {
    expect(parseProfileFolderName(`jdoe_${REAL_SID}`)).toEqual({ sid: REAL_SID, userPrincipalName: 'jdoe', quality: 'username_sid' });
  });

  it('rejoins a multi-underscore username after stripping a leading SID', () => {
    expect(parseProfileFolderName(`${REAL_SID}_j_doe_smith`)).toEqual({ sid: REAL_SID, userPrincipalName: 'j_doe_smith', quality: 'sid_username' });
  });

  it('rejoins a multi-underscore username after stripping a trailing SID', () => {
    expect(parseProfileFolderName(`j_doe_smith_${REAL_SID}`)).toEqual({ sid: REAL_SID, userPrincipalName: 'j_doe_smith', quality: 'username_sid' });
  });

  it('is unrecognized when there is no underscore at all', () => {
    expect(parseProfileFolderName('jdoe')).toEqual({ sid: undefined, userPrincipalName: undefined, quality: 'unrecognized' });
  });

  it('is unrecognized when neither end segment is a SID', () => {
    expect(parseProfileFolderName('jdoe_backup_copy')).toEqual({ sid: undefined, userPrincipalName: undefined, quality: 'unrecognized' });
  });

  it('is unrecognized for an all-underscore malformed name', () => {
    expect(parseProfileFolderName('___')).toEqual({ sid: undefined, userPrincipalName: undefined, quality: 'unrecognized' });
  });

  it('is unrecognized for an empty string', () => {
    expect(parseProfileFolderName('')).toEqual({ sid: undefined, userPrincipalName: undefined, quality: 'unrecognized' });
  });

  it('prefers the sid_username interpretation when both ends look like a SID (deterministic tie-break)', () => {
    const pathological = `${REAL_SID}_${REAL_SID}`;
    expect(parseProfileFolderName(pathological)).toEqual({ sid: REAL_SID, userPrincipalName: REAL_SID, quality: 'sid_username' });
  });

  it('trims surrounding whitespace before parsing', () => {
    expect(parseProfileFolderName(`  ${REAL_SID}_jdoe  `)).toEqual({ sid: REAL_SID, userPrincipalName: 'jdoe', quality: 'sid_username' });
  });
});

describe('isVhdFileName', () => {
  it('matches .vhd and .vhdx case-insensitively', () => {
    expect(isVhdFileName('Profile_jdoe.vhdx')).toBe(true);
    expect(isVhdFileName('Profile_jdoe.VHDX')).toBe(true);
    expect(isVhdFileName('Profile_jdoe.vhd')).toBe(true);
  });

  it('rejects a retired file', () => {
    expect(isVhdFileName('Profile_jdoe.vhdx.retired-20260816-140233')).toBe(false);
  });

  it('rejects an unrelated file', () => {
    expect(isVhdFileName('Profile_jdoe.vhdx.lock')).toBe(false);
    expect(isVhdFileName('desktop.ini')).toBe(false);
  });
});

describe('parseRetiredFileName', () => {
  it('is not retired for a plain active VHD', () => {
    expect(parseRetiredFileName('Profile_jdoe.vhdx')).toEqual({ isRetired: false, originalFileName: undefined, retiredAt: undefined });
  });

  it('parses this feature\'s own compact yyyyMMdd-HHmmss format', () => {
    const result = parseRetiredFileName('Profile_jdoe.vhdx.retired-20260816-140233');
    expect(result.isRetired).toBe(true);
    expect(result.originalFileName).toBe('Profile_jdoe.vhdx');
    expect(result.retiredAt).toBe(new Date('2026-08-16T14:02:33.000Z').toISOString());
  });

  it('parses the manual runbook\'s yyyy-MM-dd (date-only) convention', () => {
    const result = parseRetiredFileName('Profile_jdoe.vhdx.retired-2026-08-16');
    expect(result.isRetired).toBe(true);
    expect(result.originalFileName).toBe('Profile_jdoe.vhdx');
    expect(result.retiredAt).toBe(new Date('2026-08-16T00:00:00.000Z').toISOString());
  });

  it('still classifies as retired with an unparseable suffix, leaving retiredAt undefined', () => {
    const result = parseRetiredFileName('Profile_jdoe.vhdx.retired-not-a-date');
    expect(result.isRetired).toBe(true);
    expect(result.originalFileName).toBe('Profile_jdoe.vhdx');
    expect(result.retiredAt).toBeUndefined();
  });

  it('matches the LAST .retired- marker when a name is somehow doubly-retired', () => {
    const result = parseRetiredFileName('Profile_jdoe.vhdx.retired-2026-08-01.retired-20260816-140233');
    expect(result.isRetired).toBe(true);
    expect(result.originalFileName).toBe('Profile_jdoe.vhdx.retired-2026-08-01');
    expect(result.retiredAt).toBe(new Date('2026-08-16T14:02:33.000Z').toISOString());
  });

  it('matches the marker case-insensitively', () => {
    const result = parseRetiredFileName('Profile_jdoe.vhdx.RETIRED-20260816-140233');
    expect(result.isRetired).toBe(true);
  });
});

describe('buildRetiredFileName', () => {
  it('formats in UTC as <fileName>.retired-yyyyMMdd-HHmmss', () => {
    const at = new Date('2026-08-16T14:02:33.000Z');
    expect(buildRetiredFileName('Profile_jdoe.vhdx', at)).toBe('Profile_jdoe.vhdx.retired-20260816-140233');
  });

  it('zero-pads every component', () => {
    const at = new Date('2026-01-02T03:04:05.000Z');
    expect(buildRetiredFileName('Profile_jdoe.vhdx', at)).toBe('Profile_jdoe.vhdx.retired-20260102-030405');
  });

  it('round-trips through parseRetiredFileName', () => {
    const at = new Date('2026-08-16T14:02:33.000Z');
    const built = buildRetiredFileName('Profile_jdoe.vhdx', at);
    const parsed = parseRetiredFileName(built);
    expect(parsed).toEqual({ isRetired: true, originalFileName: 'Profile_jdoe.vhdx', retiredAt: at.toISOString() });
  });
});

describe('objectIdToEntraKerberosSid', () => {
  // Fixture values cross-verified with an INDEPENDENT reference
  // implementation using Node's Buffer.writeUInt32LE/writeUInt16LE (rather
  // than this module's own DataView-based implementation) against the
  // algorithm Microsoft publishes at learn.microsoft.com/surface-hub/
  // surface-hub-2s-nonglobal-admin#obtain-microsoft-entra-group-sid-using-powershell
  // (Convert-ObjectIdToSid) — see this repo's peer-review fix commit
  // message for the verification script. Hand-traced for the first fixture
  // (a GUID with distinct, easy-to-trace byte values) to confirm the
  // mixed-endian .NET Guid.ToByteArray() layout (Data1/Data2/Data3
  // little-endian, Data4 as-written) was applied correctly, not just
  // internally self-consistent.
  it('derives the documented S-1-12-1-* SID for a traceable GUID', () => {
    expect(objectIdToEntraKerberosSid('00010203-0405-0607-0809-0a0b0c0d0e0f')).toBe('S-1-12-1-66051-101123077-185207048-252579084');
  });

  it('derives the documented S-1-12-1-* SID for a realistic random GUID', () => {
    expect(objectIdToEntraKerberosSid('a1b2c3d4-e5f6-4789-9abc-def012345678')).toBe('S-1-12-1-2712847316-1200219638-4041129114-2018915346');
  });

  it('is case-insensitive on hex digits', () => {
    expect(objectIdToEntraKerberosSid('A1B2C3D4-E5F6-4789-9ABC-DEF012345678')).toBe('S-1-12-1-2712847316-1200219638-4041129114-2018915346');
  });

  it('trims surrounding whitespace', () => {
    expect(objectIdToEntraKerberosSid('  a1b2c3d4-e5f6-4789-9abc-def012345678  ')).toBe('S-1-12-1-2712847316-1200219638-4041129114-2018915346');
  });

  it('returns undefined for a non-GUID-shaped input', () => {
    expect(objectIdToEntraKerberosSid('not-a-guid')).toBeUndefined();
    expect(objectIdToEntraKerberosSid('')).toBeUndefined();
    expect(objectIdToEntraKerberosSid('S-1-5-21-1-2-3-4')).toBeUndefined();
  });

  it('returns a stable value for the all-zeros GUID', () => {
    expect(objectIdToEntraKerberosSid('00000000-0000-0000-0000-000000000000')).toBe('S-1-12-1-0-0-0-0');
  });
});
