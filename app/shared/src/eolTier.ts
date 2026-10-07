/**
 * AM-26 (M4-S1): pure EOL-countdown warning-tier classification, shared by
 * the Dashboard's existing image-version badge and the new Images page
 * version timeline so both surfaces agree on exactly when "EOL in Nd" turns
 * from informational to a warning to urgent. Lives in @avdmgr/shared (not
 * the frontend) for the same reason scalingPhase.ts does — see that file's
 * doc comment: it can be unit-tested with vitest here, since the frontend
 * workspace has no test runner configured.
 *
 * TIER BOUNDARIES: the Dashboard (app/frontend/src/pages/Dashboard.tsx,
 * AM-9/M1) already established a single threshold — daysUntilEol < 90 —
 * to decide whether to render the EOL countdown as emphasized (semibold,
 * non-muted) or not. This function REUSES that exact 90-day boundary as
 * the ok/warning split (so the Dashboard badge's existing visual meaning
 * doesn't shift), and adds one more, tighter boundary at 30 days for a
 * distinct 'critical' tier — the Dashboard's original binary threshold had
 * no way to distinguish "EOL next quarter" from "EOL next week", which the
 * Images page's per-version timeline needs for its own badges. A negative
 * daysUntilEol (already past EOL) is always 'critical', regardless of how
 * far past.
 */
export type EolTier = 'ok' | 'warning' | 'critical' | 'unknown';

const CRITICAL_THRESHOLD_DAYS = 30;
const WARNING_THRESHOLD_DAYS = 90;

/**
 * Classifies a `daysUntilEol` value (see ImageVersionCurrent/
 * ImageVersionTimelineEntry) into a warning tier for badge rendering.
 * `undefined` (EOL date not configured/known for this version) maps to
 * 'unknown' rather than being silently treated as 'ok' — an unknown EOL
 * date is not the same claim as "plenty of runway left", and the UI should
 * render them differently (see Images.tsx's EOL badge).
 */
export function eolTier(daysUntilEol: number | undefined): EolTier {
  if (daysUntilEol === undefined) return 'unknown';
  if (daysUntilEol < CRITICAL_THRESHOLD_DAYS) return 'critical';
  if (daysUntilEol < WARNING_THRESHOLD_DAYS) return 'warning';
  return 'ok';
}
