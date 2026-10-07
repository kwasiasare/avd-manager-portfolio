/** Formats a Date as a short local time only (e.g. "9:41 AM") — used for "as of HH:MM" displays (AsyncState's stale-data bar, PageHeader, EstateStrip). */
export function formatTime(date: Date): string {
  return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

/**
 * AM-38 — formats an optional boolean ARM/API flag as "On"/"Off"/"—".
 *
 * Never collapse `undefined` into "Off" via `value ? 'On' : 'Off'` — that
 * reads as an authoritative "this is disabled" when the truth is "we don't
 * know" (e.g. a list endpoint that hasn't been updated to surface the field
 * yet, or a transient API shape mismatch). Use this helper for any
 * on/off-flavored optional boolean surfaced to the UI (HostPool.tsx's
 * "Start VM on connect", and any future one) so the three states stay
 * distinct: true -> "On", false -> "Off", undefined -> "—".
 */
export function formatOnOff(value: boolean | undefined): string {
  if (value === undefined) return '—';
  return value ? 'On' : 'Off';
}

/** Formats an ISO timestamp as a short absolute date/time (e.g. "Aug 14, 2026, 9:41 AM"). */
export function formatDateTime(iso: string | undefined): string {
  if (!iso) return 'Unknown';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'Unknown';
  return date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

const SHORT_MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * AM-33 — formats an ISO timestamp as a short day+month date with no year or
 * time (e.g. "15 Aug"), used by lib/impactPreview.ts's profile-delete
 * preview line ("retired 15 Aug") — a full formatDateTime timestamp is more
 * precision than that one-line summary needs. Returns undefined (not
 * 'Unknown') for a missing/unparseable input so callers can cleanly omit the
 * whole "retired ..." clause rather than showing a placeholder word.
 *
 * Deliberately builds the "D MMM" string by hand rather than delegating to
 * `toLocaleDateString` (every other formatter in this file uses `undefined`
 * as the locale) — day/month ORDER is one of the things that varies by
 * locale (en-GB "15 Aug" vs. en-US "Aug 15"), and this one-line summary's
 * wording is fixed regardless of the viewer's locale, same as this app's
 * other hard-coded English copy.
 */
export function formatShortDate(iso: string | undefined): string | undefined {
  if (!iso) return undefined;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return undefined;
  return `${date.getDate()} ${SHORT_MONTH_NAMES[date.getMonth()]}`;
}

/** Formats the gap between an ISO timestamp and now as "3m ago" / "2h ago" / "5d ago". */
export function formatRelativeToNow(iso: string | undefined, now: Date = new Date()): string {
  if (!iso) return 'Unknown';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'Unknown';

  const diffMs = now.getTime() - date.getTime();
  const diffMinutes = Math.round(diffMs / 60_000);

  if (diffMinutes < 1) return 'just now';
  if (diffMinutes < 60) return `${diffMinutes}m ago`;
  const diffHours = Math.round(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.round(diffHours / 24);
  return `${diffDays}d ago`;
}

/** Whole minutes between an ISO timestamp and now (negative if the timestamp is in the future). */
export function minutesSince(iso: string | undefined, now: Date = new Date()): number | undefined {
  if (!iso) return undefined;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return undefined;
  return Math.round((now.getTime() - date.getTime()) / 60_000);
}

/** Formats a cost value as currency (e.g. "$1,234.56"). Falls back to a plain "1234.56 USD" string if `currency` isn't a valid ISO 4217 code Intl recognizes. */
export function formatCurrency(value: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(value);
  } catch {
    return `${value.toFixed(2)} ${currency}`;
  }
}

/** Formats a byte count as a human-readable size (e.g. "12.3 GiB"). Used for FSLogix share usage, which the API already reports in GiB — this is for the raw usedBytes field. */
export function formatBytes(bytes: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

/**
 * AM-31 item 35 — formats the gap between an ISO timestamp and now as a
 * live "elapsed" duration for the unified Stepper component's
 * current-step display, e.g. "3m elapsed" / "1h 12m elapsed" / "45s
 * elapsed". Returns undefined for a missing/unparseable timestamp, or a
 * FUTURE one (a step cannot have started in the future — treat that as
 * "nothing to show" rather than a negative duration).
 */
export function formatElapsed(iso: string | undefined, now: Date = new Date()): string | undefined {
  if (!iso) return undefined;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return undefined;
  const diffMs = now.getTime() - date.getTime();
  if (diffMs < 0) return undefined;

  const totalMinutes = Math.floor(diffMs / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (hours > 0) return `${hours}h ${minutes}m elapsed`;
  if (totalMinutes > 0) return `${totalMinutes}m elapsed`;
  const seconds = Math.floor(diffMs / 1000);
  return `${seconds}s elapsed`;
}

/**
 * AM-31 peer review MAJOR 1 — formats a FIXED (non-live) duration between
 * two ISO instants for a completed step's post-mortem timing, e.g. "3m" /
 * "1h 12m" / "45s". Companion to formatElapsed above (which is the LIVE
 * "still running" version of the same shape) — used by the Stepper
 * component to show how long a DONE step actually took, once both
 * startedAt and completedAt are known. Returns undefined when either
 * timestamp is missing/unparseable, or completedAt is before startedAt (a
 * negative duration is never meaningful here).
 */
export function formatDuration(startedAt: string | undefined, completedAt: string | undefined): string | undefined {
  if (!startedAt || !completedAt) return undefined;
  const start = new Date(startedAt);
  const end = new Date(completedAt);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return undefined;
  const diffMs = end.getTime() - start.getTime();
  if (diffMs < 0) return undefined;

  const totalMinutes = Math.floor(diffMs / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (hours > 0) return `${hours}h ${minutes}m`;
  if (totalMinutes > 0) return `${totalMinutes}m`;
  const seconds = Math.floor(diffMs / 1000);
  return `${seconds}s`;
}

/**
 * Formats the gap between now and a FUTURE ISO timestamp as a countdown,
 * e.g. "expires in 2d 3h" / "expires in 45m" / "expired" (once past).
 * Used by the registration-token status display
 * (app/frontend/src/components/AddSessionHostPanel.tsx) — a plain absolute
 * timestamp doesn't communicate urgency ("does this expire today?") as
 * quickly as a countdown does for a short-lived credential.
 */
export function formatCountdown(iso: string | undefined, now: Date = new Date()): string {
  if (!iso) return 'Unknown';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'Unknown';

  const diffMs = date.getTime() - now.getTime();
  if (diffMs <= 0) return 'expired';

  const totalMinutes = Math.ceil(diffMs / 60_000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;

  if (days > 0) return `expires in ${days}d ${hours}h`;
  if (hours > 0) return `expires in ${hours}h ${minutes}m`;
  return `expires in ${minutes}m`;
}
