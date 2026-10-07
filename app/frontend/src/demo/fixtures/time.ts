export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** ISO timestamp `offsetMs` before (positive) `now`. */
export const ago = (now: number, offsetMs: number): string => new Date(now - offsetMs).toISOString();

/** ISO timestamp `offsetMs` after `now`. */
export const ahead = (now: number, offsetMs: number): string => new Date(now + offsetMs).toISOString();

/** Calendar date (YYYY-MM-DD) `days` before `now`. */
export const dateAgo = (now: number, days: number): string => ago(now, days * DAY).slice(0, 10);

/** Deterministic fake GUID: 00000000-0000-4000-8000-0000000000NN (the form scripts/guid-allowlist.txt permits). */
export const fakeGuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
