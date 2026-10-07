/**
 * AM-29 item 31 — the confirm primitive's reason field is a freeform
 * Combobox seeded with a fixed set of canned reasons PLUS the operator's own
 * last few free-typed reasons, persisted in localStorage so they carry
 * across dialogs/sessions (an operator who always types "Contoso change
 * ticket CHG-1234" shouldn't have to retype it from scratch every time).
 */

/** Fixed seed list, shown first regardless of history — every ConfirmModal reason Combobox offers these. */
export const CANNED_REASONS: readonly string[] = ['Incident response', 'Scheduled maintenance', 'User request', 'Capacity management', 'Troubleshooting', 'Other'];

const STORAGE_KEY = 'avdmgr.recentReasons';
const MAX_RECENT = 5;

function readRecent(): string[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : [];
  } catch {
    // Unavailable/corrupt localStorage (locked-down profile, private browsing
    // in some engines, or a manually-edited value) — degrade to "no history"
    // rather than throwing; the canned list alone is still fully usable.
    return [];
  }
}

function writeRecent(reasons: string[]): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(reasons));
  } catch {
    // Best-effort persistence only, same posture as theme/AppThemeProvider's writeStoredMode.
  }
}

/** Up to the 5 most recently used free-text reasons, most-recent-first, with any that duplicate a CANNED_REASONS entry filtered out (the canned list already shows those). */
export function getRecentReasons(): string[] {
  const lowerCanned = new Set(CANNED_REASONS.map((reason) => reason.toLowerCase()));
  return readRecent().filter((reason) => !lowerCanned.has(reason.toLowerCase()));
}

/**
 * Records a submitted reason into the recent-history list (most-recent-first,
 * de-duplicated case-insensitively, capped at MAX_RECENT). No-ops for a
 * blank reason or one that exactly matches a canned option (nothing new to
 * remember in either case).
 */
export function addRecentReason(reason: string): void {
  const trimmed = reason.trim();
  if (!trimmed || CANNED_REASONS.some((canned) => canned.toLowerCase() === trimmed.toLowerCase())) {
    return;
  }
  const existing = readRecent().filter((prior) => prior.toLowerCase() !== trimmed.toLowerCase());
  writeRecent([trimmed, ...existing].slice(0, MAX_RECENT));
}
