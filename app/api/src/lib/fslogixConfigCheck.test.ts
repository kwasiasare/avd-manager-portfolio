import { describe, expect, it } from 'vitest';
import { computeConfigDiffs, FSLOGIX_CHECK_OUTPUT_MARKER, parseCheckOutput } from './fslogixConfigCheck';

const BASELINE = {
  Enabled: '1',
  VHDLocations: '\\\\stcontoso001.file.core.windows.net\\fslogixprofiles',
  VolumeType: 'VHDX',
  SizeInMBs: '30000',
  FlipFlopProfileDirectoryName: '1',
};

function markerLine(payload: unknown): string {
  return `${FSLOGIX_CHECK_OUTPUT_MARKER}${JSON.stringify(payload)}`;
}

describe('parseCheckOutput', () => {
  it('returns null for undefined/null/empty input', () => {
    expect(parseCheckOutput(undefined)).toBeNull();
    expect(parseCheckOutput(null)).toBeNull();
    expect(parseCheckOutput('')).toBeNull();
  });

  it('parses a clean single-line marker output', () => {
    const output = markerLine({ Enabled: '1', VHDLocations: '\\\\stcontoso001.file.core.windows.net\\fslogixprofiles', VolumeType: 'VHDX', SizeInMBs: '30000', FlipFlopProfileDirectoryName: '1' });
    expect(parseCheckOutput(output)).toEqual({ Enabled: '1', VHDLocations: '\\\\stcontoso001.file.core.windows.net\\fslogixprofiles', VolumeType: 'VHDX', SizeInMBs: '30000', FlipFlopProfileDirectoryName: '1' });
  });

  it('tolerates surrounding noise before and after the marker line', () => {
    const output = ['VM Agent starting up...', 'Some banner text', markerLine({ Enabled: '1' }), 'Script completed.'].join('\r\n');
    expect(parseCheckOutput(output)).toEqual({ Enabled: '1' });
  });

  it('handles missing keys as JSON null', () => {
    const output = markerLine({ Enabled: null, VHDLocations: null, VolumeType: null, SizeInMBs: null, FlipFlopProfileDirectoryName: null });
    expect(parseCheckOutput(output)).toEqual({ Enabled: null, VHDLocations: null, VolumeType: null, SizeInMBs: null, FlipFlopProfileDirectoryName: null });
  });

  it('returns null when no line contains the marker at all', () => {
    expect(parseCheckOutput('nothing useful here\r\njust noise')).toBeNull();
  });

  it('returns null when the marker line has unparsable JSON after it', () => {
    expect(parseCheckOutput(`${FSLOGIX_CHECK_OUTPUT_MARKER}{not valid json`)).toBeNull();
  });

  it('returns null when the marker line parses to a non-object (e.g. an array or a bare string)', () => {
    expect(parseCheckOutput(`${FSLOGIX_CHECK_OUTPUT_MARKER}[1,2,3]`)).toBeNull();
    expect(parseCheckOutput(`${FSLOGIX_CHECK_OUTPUT_MARKER}"just a string"`)).toBeNull();
  });

  it('keeps scanning past a look-alike unparsable marker line to find a later valid one', () => {
    const output = [`${FSLOGIX_CHECK_OUTPUT_MARKER}{broken`, markerLine({ Enabled: '1' })].join('\n');
    expect(parseCheckOutput(output)).toEqual({ Enabled: '1' });
  });

  it('handles \\n-only line endings, not just \\r\\n', () => {
    const output = `noise\n${markerLine({ Enabled: '1' })}\nmore noise`;
    expect(parseCheckOutput(output)).toEqual({ Enabled: '1' });
  });
});

describe('computeConfigDiffs', () => {
  it('returns no diffs when every value matches exactly', () => {
    expect(computeConfigDiffs(BASELINE, { ...BASELINE })).toEqual([]);
  });

  it('reports actual: null for a key entirely missing from the parsed object', () => {
    const actual: Record<string, string | null> = { Enabled: '1', VolumeType: 'VHDX', SizeInMBs: '30000', FlipFlopProfileDirectoryName: '1' }; // VHDLocations absent
    expect(computeConfigDiffs(BASELINE, actual)).toEqual([{ key: 'VHDLocations', expected: BASELINE.VHDLocations, actual: null }]);
  });

  it('reports actual: null for a key explicitly null (registry value absent on host)', () => {
    const actual = { ...BASELINE, Enabled: null };
    expect(computeConfigDiffs(BASELINE, actual)).toEqual([{ key: 'Enabled', expected: '1', actual: null }]);
  });

  it('treats every key as missing when the whole parsed result is null', () => {
    const diffs = computeConfigDiffs(BASELINE, null);
    expect(diffs).toHaveLength(5);
    expect(diffs.every((d) => d.actual === null)).toBe(true);
  });

  it('is case-insensitive for string comparisons', () => {
    expect(computeConfigDiffs(BASELINE, { ...BASELINE, VolumeType: 'vhdx' })).toEqual([]);
  });

  it('trims surrounding whitespace before comparing', () => {
    expect(computeConfigDiffs(BASELINE, { ...BASELINE, VolumeType: '  VHDX  ' })).toEqual([]);
  });

  it('compares SizeInMBs numerically — "30000" matches 30000-as-string with different formatting', () => {
    expect(computeConfigDiffs(BASELINE, { ...BASELINE, SizeInMBs: '30000.0' })).toEqual([]);
    expect(computeConfigDiffs({ ...BASELINE, SizeInMBs: '30000' }, { ...BASELINE, SizeInMBs: '030000' })).toEqual([]);
  });

  it('reports a genuine numeric mismatch for SizeInMBs', () => {
    expect(computeConfigDiffs(BASELINE, { ...BASELINE, SizeInMBs: '5000' })).toEqual([{ key: 'SizeInMBs', expected: '30000', actual: '5000' }]);
  });

  it('ignores a trailing backslash difference on VHDLocations specifically', () => {
    expect(computeConfigDiffs(BASELINE, { ...BASELINE, VHDLocations: `${BASELINE.VHDLocations}\\` })).toEqual([]);
    expect(computeConfigDiffs(BASELINE, { ...BASELINE, VHDLocations: `${BASELINE.VHDLocations}\\\\` })).toEqual([]);
  });

  it('still reports a genuine VHDLocations mismatch (not just trailing-slash noise)', () => {
    const diffs = computeConfigDiffs(BASELINE, { ...BASELINE, VHDLocations: '\\\\other-account.file.core.windows.net\\othershare' });
    expect(diffs).toEqual([{ key: 'VHDLocations', expected: BASELINE.VHDLocations, actual: '\\\\other-account.file.core.windows.net\\othershare' }]);
  });

  it('does NOT apply the trailing-backslash rule to a non-VHDLocations key', () => {
    // VolumeType with a stray trailing backslash should NOT be silently normalized away — only VHDLocations gets that treatment.
    expect(computeConfigDiffs(BASELINE, { ...BASELINE, VolumeType: 'VHDX\\' })).toEqual([{ key: 'VolumeType', expected: 'VHDX', actual: 'VHDX\\' }]);
  });

  it('accepts a VHDLocations value already joined from multiple registry entries (the script itself joins with ";")', () => {
    const multiValueBaseline = { ...BASELINE, VHDLocations: '\\\\share1\\a;\\\\share2\\b' };
    expect(computeConfigDiffs(multiValueBaseline, { ...multiValueBaseline })).toEqual([]);
  });

  it('reports every diverged key together when multiple keys mismatch', () => {
    const diffs = computeConfigDiffs(BASELINE, { ...BASELINE, Enabled: '0', VolumeType: 'VHD' });
    expect(diffs.map((d) => d.key).sort()).toEqual(['Enabled', 'VolumeType']);
  });
});
