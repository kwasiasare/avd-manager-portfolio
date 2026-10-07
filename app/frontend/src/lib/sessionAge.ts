import type { UserSession } from '@avdmgr/shared';

/**
 * Session-age thresholds and color-coding (AM-10 spec):
 *   green   — age < 4h
 *   yellow  — 4h <= age <= 8h
 *   red     — age > 8h, OR the session is Disconnected for > 1h
 *   unknown — age unknown (missing/unparseable/implausible createTime) —
 *             NOT green: an unknown age is not a known-healthy age.
 *
 * Kept as a pure, dependency-free module (no React/Fluent imports) so the
 * threshold logic is unit-testable in isolation once the repo gains its
 * first frontend test runner — see app/frontend/src/lib/sessionRows.ts and
 * app/frontend/src/pages/Sessions.tsx for the callers.
 */

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export const AGE_YELLOW_THRESHOLD_MS = 4 * HOUR_MS;
export const AGE_RED_THRESHOLD_MS = 8 * HOUR_MS;
export const DISCONNECTED_RED_THRESHOLD_MS = 1 * HOUR_MS;

/**
 * Ages beyond this are treated as implausible/unknown rather than genuinely
 * stale. Chiefly guards against avdService.ts's own
 * `armSession.createTime?.toISOString() ?? new Date(0).toISOString()`
 * fallback for a missing ARM createTime — without this, that sentinel
 * computes as a ~494,000 hour age and would paint bright red as though the
 * session had been running since 1970, when really the age is unknown.
 */
const MAX_PLAUSIBLE_AGE_MS = 30 * DAY_MS;

/**
 * Any createTime before this instant is almost certainly the API's
 * epoch-zero sentinel (or equally bogus), not a real AVD session creation
 * timestamp — belt-and-braces alongside MAX_PLAUSIBLE_AGE_MS above (a
 * createTime this old would already exceed MAX_PLAUSIBLE_AGE_MS today, but
 * checking the instant directly doesn't rely on `now` being sane too).
 */
const EPOCH_SENTINEL_CUTOFF_MS = Date.UTC(2000, 0, 1);

/** AM-29 item 16: matches StatusBadge's StatusTone spelling ('unknown', not 'neutral') so SessionAgeBadge can pass this straight through as StatusBadge's `tone` prop. */
export type AgeTone = 'ok' | 'warning' | 'error' | 'unknown';

/** Why a session's age tone is what it is — drives the badge's tooltip text. */
export type AgeReason = 'fresh' | 'aging' | 'stale' | 'disconnectedStale' | 'unknown';

export interface SessionAgeInfo {
  /** Milliseconds since createTime, or undefined if createTime is missing, unparseable, or implausible (see MAX_PLAUSIBLE_AGE_MS/EPOCH_SENTINEL_CUTOFF_MS). */
  ageMs: number | undefined;
  tone: AgeTone;
  reason: AgeReason;
}

function parseCreateTime(createTime: string | undefined): Date | undefined {
  if (!createTime) return undefined;
  const created = new Date(createTime);
  return Number.isNaN(created.getTime()) ? undefined : created;
}

/**
 * Epoch milliseconds for `createTime`, or undefined if missing/unparseable.
 * This is the single parse path for the createTime field — both the age
 * math below and app/frontend/src/lib/sessionRows.ts's Start-time column
 * sort go through this (directly, or via computeSessionAgeMs/
 * getSessionAgeInfo) rather than each doing their own `new Date(...)` /
 * `Date.parse(...)`. Unlike getSessionAgeInfo, this does NOT apply the
 * epoch-sentinel/implausibility filter — it's a literal parse, used where
 * the raw instant (not an age-with-health-tone) is what's needed.
 */
export function parseCreateTimeMs(createTime: string | undefined): number | undefined {
  return parseCreateTime(createTime)?.getTime();
}

/**
 * Milliseconds elapsed since `createTime` (ARM's UserSession.createTime —
 * the only session timestamp the DesktopVirtualizationAPIClient exposes;
 * there is no separate "disconnect time" field on the ARM model). Returns
 * undefined if createTime is missing or unparseable.
 */
export function computeSessionAgeMs(createTime: string | undefined, now: Date = new Date()): number | undefined {
  const created = parseCreateTime(createTime);
  return created ? now.getTime() - created.getTime() : undefined;
}

function isPlausibleAge(created: Date, ageMs: number): boolean {
  return created.getTime() >= EPOCH_SENTINEL_CUTOFF_MS && ageMs <= MAX_PLAUSIBLE_AGE_MS;
}

/**
 * Resolves the age tone + reason for a session.
 *
 * The "Disconnected for > 1h" red rule is approximated using createTime as a
 * lower bound on disconnect duration, since ARM doesn't report when a
 * session actually disconnected: a session can never have been disconnected
 * for longer than it has existed, so `now - createTime` is always >= the
 * true disconnected duration. This means the rule can only fire later than
 * the true 1h mark, never earlier — a conservative approximation, not an
 * exact one. Document this if the underlying ARM API ever adds a real
 * disconnect timestamp.
 *
 * A missing, unparseable, or implausible createTime (see
 * MAX_PLAUSIBLE_AGE_MS) is reported as tone 'unknown' / reason 'unknown' —
 * deliberately NOT 'ok': an unknown age must not read as a known-healthy
 * green badge.
 */
export function getSessionAgeInfo(session: Pick<UserSession, 'createTime' | 'sessionState'>, now: Date = new Date()): SessionAgeInfo {
  const created = parseCreateTime(session.createTime);

  if (!created) {
    return { ageMs: undefined, tone: 'unknown', reason: 'unknown' };
  }

  const ageMs = now.getTime() - created.getTime();

  if (!isPlausibleAge(created, ageMs)) {
    return { ageMs: undefined, tone: 'unknown', reason: 'unknown' };
  }

  if (session.sessionState === 'Disconnected' && ageMs > DISCONNECTED_RED_THRESHOLD_MS) {
    return { ageMs, tone: 'error', reason: 'disconnectedStale' };
  }

  if (ageMs > AGE_RED_THRESHOLD_MS) {
    return { ageMs, tone: 'error', reason: 'stale' };
  }

  if (ageMs >= AGE_YELLOW_THRESHOLD_MS) {
    return { ageMs, tone: 'warning', reason: 'aging' };
  }

  return { ageMs, tone: 'ok', reason: 'fresh' };
}

/** Formats a duration in ms as "2h 15m" / "45m" / "Unknown". */
export function formatSessionAge(ageMs: number | undefined): string {
  if (ageMs === undefined || Number.isNaN(ageMs)) return 'Unknown';
  const clampedMs = Math.max(ageMs, 0);
  const totalMinutes = Math.floor(clampedMs / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

/**
 * Human-readable explanation for a SessionAgeInfo's reason, used as the
 * badge's tooltip content. Returns undefined for 'fresh' and 'unknown' —
 * neither needs a tooltip: 'fresh' is the unremarkable default, and
 * 'unknown' already says everything via the badge's own "Unknown" text.
 */
export function describeAgeReason(info: SessionAgeInfo): string | undefined {
  switch (info.reason) {
    case 'disconnectedStale':
      return 'Disconnected for over 1 hour';
    case 'stale':
      return 'Session has existed for more than 8 hours';
    case 'aging':
      return 'Session has existed for 4 hours or more';
    default:
      return undefined;
  }
}
