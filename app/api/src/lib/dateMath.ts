const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Whole days between two dates, FLOORED (truncated toward `from`), moved
 * here (AM-26 peer review item 10) from imagesService.ts so snapshotsService.ts
 * doesn't need to import that whole module graph just for date math.
 *
 * TRUNCATION-DIRECTION NOTE (AM-26 peer review item 8): floor is used
 * uniformly for BOTH "age since a past date" (ageDays — floor is the only
 * sensible choice: whole COMPLETED days elapsed) and "countdown to a future
 * date" (daysUntilEol — e.g. GET /v1/images/current, .../versions). For the
 * countdown case, flooring is the CONSERVATIVE direction: it never reports
 * more runway than truly remains (89 days 23 hours left floors to 89, not
 * 90), so a value that's about to cross an eolTier threshold (30/90 days —
 * see @avdmgr/shared's eolTier.ts) tips into the more urgent tier slightly
 * EARLY rather than late. This is intentional and is not being changed to
 * `Math.ceil` for the countdown case: ceiling would instead let a
 * near-threshold value (e.g. 89.01 days) still read as "90d" (an extra day
 * of apparent runway that isn't really there), which is the wrong direction
 * for a decommissioning-deadline warning.
 */
export function daysBetween(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / MS_PER_DAY);
}
