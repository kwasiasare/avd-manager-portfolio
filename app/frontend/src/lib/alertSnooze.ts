/**
 * AM-34 peer review (Opus, MINOR 6) — MIN_SNOOZE_HOURS/MAX_SNOOZE_HOURS
 * lived as a page-local pair in Monitoring.tsx; Incident.tsx (AM-34) needed
 * the exact same bounds for its own SnoozeDialog and had started
 * hand-copying the literals (1/168) instead. Pulled out to one shared
 * source both pages import, rather than two places that could silently
 * drift apart.
 *
 * Mirrors app/api/src/lib/logsGuard.ts's own MIN_SNOOZE_HOURS/
 * MAX_SNOOZE_HOURS (re-exported from app/api/src/lib/alertState.ts's
 * resolveSnoozeUntil, which is what actually enforces this bound) — the API
 * independently re-validates the same range regardless of what either page
 * sends.
 */
export const MIN_SNOOZE_HOURS = 1;
export const MAX_SNOOZE_HOURS = 168;
