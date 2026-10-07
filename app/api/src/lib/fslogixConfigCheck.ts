import type { RolloutConfigDiff } from '@avdmgr/shared';

/**
 * AM-47 — the config-convergence validation gate's PowerShell script,
 * marker/parse contract, and pure diff computation. Kept as one dependency
 * -free module (no Table/ARM client) so `parseCheckOutput`/
 * `computeConfigDiffs` are unit-testable in isolation — see
 * fslogixConfigCheck.test.ts.
 *
 * ARCHITECTURE (see rolloutPlans.ts's verify-config action and
 * rolloutPlanTimer.ts's validating_new poll for the two call sites):
 *   - SUBMIT (mutating, operator-triggered): rolloutPlans.ts resolves each
 *     new host's VM, then calls computeService.ts#submitFslogixConfigCheck,
 *     which creates/overwrites a Run Command v2 child resource
 *     (`Microsoft.Compute/virtualMachines/runCommands`, name
 *     FSLOGIX_CONFIG_CHECK_RUN_COMMAND_NAME below) running FSLOGIX_CONFIG_CHECK_SCRIPT.
 *     Run Command v2 (not the classic `virtualMachines.runCommand` action)
 *     is used SPECIFICALLY because its result is retrievable later by a
 *     plain GET, from ANY caller — the classic action's output is only
 *     ever readable from the original LRO poller, which cannot survive
 *     across the submit-in-an-HTTP-handler / poll-in-a-later-timer-tick
 *     split this app's "submit-only, poller not awaited" discipline
 *     requires (see computeService.ts#beginVmPowerAction's doc comment for
 *     that discipline's own rationale).
 *   - POLL (read-only, timer): rolloutPlanTimer.ts's validating_new branch
 *     calls computeService.ts#getFslogixConfigCheckResult (a GET with
 *     `expand: 'instanceView'`) for every host whose configCheck.status is
 *     'in_progress', parses `instanceView.output` via parseCheckOutput
 *     below, and diffs it against the plan's frozen `configBaseline` via
 *     computeConfigDiffs. This keeps the timer's documented
 *     read-only-against-ARM invariant intact — the ONLY ARM call this
 *     module's poll path makes is a GET (see rolloutPlanTimer.ts's header
 *     comment, which names this fact explicitly).
 */

/** Name of the Run Command v2 child resource this check creates/reads on each session host VM. Reusing the SAME name on every verify-config call is deliberate — Run Command v2's createOrUpdate is idempotent by name, so re-running the check on a host simply overwrites its own prior run rather than accumulating child resources. */
export const FSLOGIX_CONFIG_CHECK_RUN_COMMAND_NAME = 'avdmgr-fslogix-check';

/** Bound on how long the run command may execute on the VM before Azure itself marks it timed out — well over what a registry read needs, generous headroom for a busy/slow host. Distinct from rolloutPlans.ts's own submit-side ARM-accept timeout and rolloutPlanTimer.ts's SEPARATE "stuck in Running past N minutes" operator-facing timeout. */
export const FSLOGIX_CONFIG_CHECK_TIMEOUT_SECONDS = 300;

/** The exact five registry VALUE names (not this app's own field names) read from `HKLM\SOFTWARE\FSLogix\Profiles` — see FSLOGIX_CONFIG_CHECK_SCRIPT below and AppConfig.fslogixBaseline, which is keyed identically so no renaming step is needed anywhere in this pipeline. */
export const FSLOGIX_CHECK_KEYS = ['Enabled', 'VHDLocations', 'VolumeType', 'SizeInMBs', 'FlipFlopProfileDirectoryName'] as const;

/** The line prefix parseCheckOutput scans for — chosen to be extremely unlikely to collide with anything else Windows/the VM agent might write to stdout ahead of or after it. */
export const FSLOGIX_CHECK_OUTPUT_MARKER = 'AVDMGR_FSLOGIX_JSON:';

/**
 * The Run Command v2 script itself. Reads the five FSLogix keys with
 * `-ErrorAction SilentlyContinue` (the registry PATH itself may not exist
 * at all on a host Intune's ADMX ingestion never reached — see
 * The FSLogix storage runbook §5.1's live-verified 0x86000009
 * gotcha — that must read as "every key missing", not a script failure),
 * builds an ORDERED hashtable of exactly those five keys (missing key ->
 * JSON `null`; VHDLocations, which FSLogix stores as a multi-string value
 * when more than one location is configured, is joined with `;` into a
 * single string before serialization), and writes ONE line —
 * FSLOGIX_CHECK_OUTPUT_MARKER followed immediately by the hashtable's
 * `ConvertTo-Json -Compress` — to stdout. `-Compress` keeps the marker line
 * a single line (ConvertTo-Json without it would pretty-print across
 * several lines, breaking the "one line" contract parseCheckOutput below
 * relies on).
 */
export const FSLOGIX_CONFIG_CHECK_SCRIPT = `$props = Get-ItemProperty -Path 'HKLM:\\SOFTWARE\\FSLogix\\Profiles' -ErrorAction SilentlyContinue

function Get-AvdmgrFslogixValue {
    param([string]$Name)
    if (-not $props) { return $null }
    $value = $props.$Name
    if ($null -eq $value) { return $null }
    if ($value -is [System.Array]) { return ($value -join ';') }
    return [string]$value
}

$result = [ordered]@{
    Enabled                      = Get-AvdmgrFslogixValue -Name 'Enabled'
    VHDLocations                 = Get-AvdmgrFslogixValue -Name 'VHDLocations'
    VolumeType                   = Get-AvdmgrFslogixValue -Name 'VolumeType'
    SizeInMBs                    = Get-AvdmgrFslogixValue -Name 'SizeInMBs'
    FlipFlopProfileDirectoryName = Get-AvdmgrFslogixValue -Name 'FlipFlopProfileDirectoryName'
}

Write-Output ('${FSLOGIX_CHECK_OUTPUT_MARKER}' + ($result | ConvertTo-Json -Compress))
`;

/** Raw parsed shape of the marker line's JSON — one entry per FSLOGIX_CHECK_KEYS name, `null` for a key absent on the host. */
export type FslogixCheckOutput = Partial<Record<(typeof FSLOGIX_CHECK_KEYS)[number], string | null>>;

/**
 * Finds FSLOGIX_CHECK_OUTPUT_MARKER within `stdout` (the run command
 * instanceView's `output` field) and JSON.parses whatever follows it on
 * that same line — tolerating surrounding noise (VM agent banners, other
 * script output before/after) by scanning line-by-line rather than
 * requiring the marker to be the very first or only content. Returns
 * `null` (never throws) when no line contains the marker, or the text
 * after it on every such line fails to parse as a JSON object — a
 * corrupt/truncated run command result must surface as
 * RolloutConfigCheckStatus 'error', not crash the timer tick.
 */
export function parseCheckOutput(stdout: string | undefined | null): FslogixCheckOutput | null {
  if (!stdout) {
    return null;
  }
  for (const line of stdout.split(/\r?\n/)) {
    const markerIndex = line.indexOf(FSLOGIX_CHECK_OUTPUT_MARKER);
    if (markerIndex === -1) {
      continue;
    }
    const jsonText = line.slice(markerIndex + FSLOGIX_CHECK_OUTPUT_MARKER.length).trim();
    try {
      const parsed: unknown = JSON.parse(jsonText);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as FslogixCheckOutput;
      }
    } catch {
      // Keep scanning — a later line might carry a valid marker even if an
      // earlier "look-alike" line didn't parse.
    }
  }
  return null;
}

/**
 * Normalizes one value for comparison: trims surrounding whitespace,
 * case-insensitive (registry string values/comparisons on Windows are
 * routinely case-insensitive, and this gate should not flag a delivered
 * value that differs only in case as a real divergence), and — for
 * VHDLocations specifically — also strips trailing backslashes (a UNC path
 * with vs. without a trailing `\` is the same location, and Intune/FSLogix
 * are not perfectly consistent about which form gets delivered).
 */
function normalizeForCompare(key: string, raw: string): string {
  const trimmed = raw.trim();
  const withoutTrailingSlash = key === 'VHDLocations' ? trimmed.replace(/\\+$/, '') : trimmed;
  return withoutTrailingSlash.toLowerCase();
}

/** True if `expected`/`actual` should be treated as equal for `key` — numeric-equal (so '30000' matches 30000 or '30000.0') when both parse as finite numbers, otherwise a normalized (trimmed, case-insensitive, VHDLocations-trailing-backslash-insensitive) string compare. */
function valuesMatch(key: string, expected: string, actual: string): boolean {
  const expectedNumber = Number(expected.trim());
  const actualNumber = Number(actual.trim());
  if (expected.trim() !== '' && actual.trim() !== '' && Number.isFinite(expectedNumber) && Number.isFinite(actualNumber)) {
    return expectedNumber === actualNumber;
  }
  return normalizeForCompare(key, expected) === normalizeForCompare(key, actual);
}

/**
 * Diffs a parsed FslogixCheckOutput against the plan's frozen
 * `configBaseline` (RolloutPlanDetail.configBaseline /
 * AppConfig.fslogixBaseline — same key names throughout this pipeline, see
 * this module's header comment) for exactly the five FSLOGIX_CHECK_KEYS.
 * `actual: null` (a RolloutConfigDiff.actual value, not this function's own
 * parameter) covers BOTH a key entirely absent from `actual` (parseCheckOutput
 * returned an object missing that property) and one explicitly `null` in
 * the parsed JSON (the script's own "key not present on this host"
 * signal) — both mean the same thing to an operator reading the diff:
 * "FSLogix never delivered this value at all", not merely "delivered the
 * wrong value". `actual === null` (the whole parse result, not one key)
 * is treated the SAME as "every key missing" — a caller with an unparsable
 * run command output should treat that as its own 'error' status (see
 * rolloutPlanTimer.ts), not call this function with a null actual at all;
 * it is accepted here anyway so the function stays total and testable on
 * that edge without a separate guard at every call site.
 */
export function computeConfigDiffs(baseline: Record<string, string>, actual: FslogixCheckOutput | null): RolloutConfigDiff[] {
  const diffs: RolloutConfigDiff[] = [];
  for (const key of FSLOGIX_CHECK_KEYS) {
    const expected = baseline[key] ?? '';
    const actualValue = actual ? actual[key] : null;
    if (actualValue === null || actualValue === undefined) {
      diffs.push({ key, expected, actual: null });
      continue;
    }
    if (!valuesMatch(key, expected, actualValue)) {
      diffs.push({ key, expected, actual: actualValue });
    }
  }
  return diffs;
}
