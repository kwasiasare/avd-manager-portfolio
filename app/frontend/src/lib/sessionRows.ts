import { KNOWN_USER_SESSION_STATES, type UserSession, type UserSessionState } from '@avdmgr/shared';
import { getSessionAgeInfo, parseCreateTimeMs, type SessionAgeInfo } from './sessionAge';

/**
 * React-free session-table logic (row shaping, filtering, sorting) for the
 * Sessions page — kept separate from Sessions.tsx and sessionAge.ts so it's
 * directly unit-testable once the repo gains a frontend test runner.
 */

/** Options for the Sessions page's state filter: 'All' plus every state a normalized session can actually carry (KNOWN_USER_SESSION_STATES, plus 'Unknown' — the normalization fallback bucket a real session CAN land in, even though ARM itself never sends it). */
export const SESSION_STATE_OPTIONS: readonly UserSessionState[] = [...KNOWN_USER_SESSION_STATES, 'Unknown'];

export type StateFilter = UserSessionState | 'All';
export type SortColumn = 'user' | 'state' | 'host' | 'startTime' | 'age';
export type SortDirection = 'ascending' | 'descending';

export interface SessionRow {
  session: UserSession;
  ageInfo: SessionAgeInfo;
}

/** Shapes raw sessions into rows carrying their precomputed age info (all rows share one `now` instant). */
export function toSessionRows(sessions: readonly UserSession[], now: Date = new Date()): SessionRow[] {
  return sessions.map((session) => ({ session, ageInfo: getSessionAgeInfo(session, now) }));
}

export function matchesStateFilter(row: SessionRow, filter: StateFilter): boolean {
  return filter === 'All' || row.session.sessionState === filter;
}

/**
 * AM-31 item 38 — free-text search: matches a row when `query` (trimmed,
 * case-insensitive) is a substring of either the session's userPrincipalName
 * OR its sessionHostName. An empty/whitespace-only query matches every row
 * (search is a narrowing filter, not a required field). Combines with the
 * state filter via AND (see selectVisibleRows below) — search narrows
 * whatever the state dropdown already selected, not a separate mode.
 */
export function matchesSearch(row: SessionRow, query: string): boolean {
  const trimmed = query.trim().toLowerCase();
  if (!trimmed) return true;
  return row.session.userPrincipalName.toLowerCase().includes(trimmed) || row.session.sessionHostName.toLowerCase().includes(trimmed);
}

/**
 * Numeric comparison where undefined/NaN values always sort last —
 * regardless of `direction`. Without this, an unknown value flips from
 * "sorts as if 0" in ascending to "sorts as if 0" in descending too, which
 * lands it at opposite ends of the list depending on direction; pinning it
 * to "last" keeps unknowns out of the way rather than jumping around.
 */
function compareNullableNumeric(a: number | undefined, b: number | undefined, direction: SortDirection): number {
  const aUnknown = a === undefined || Number.isNaN(a);
  const bUnknown = b === undefined || Number.isNaN(b);
  if (aUnknown && bUnknown) return 0;
  if (aUnknown) return 1;
  if (bUnknown) return -1;
  const cmp = a - b;
  return direction === 'ascending' ? cmp : -cmp;
}

function compareStrings(a: string, b: string, direction: SortDirection): number {
  const cmp = a.localeCompare(b);
  return direction === 'ascending' ? cmp : -cmp;
}

/**
 * Compares two rows on a single column in the given direction. `startTime`
 * and `age` both go through compareNullableNumeric so unknown values sort
 * last on either column, in either direction — startTime and age share the
 * same underlying createTime parse path (parseCreateTimeMs /
 * getSessionAgeInfo, both in sessionAge.ts) rather than each column doing
 * its own ad hoc Date parsing.
 */
export function compareRows(a: SessionRow, b: SessionRow, column: SortColumn, direction: SortDirection): number {
  switch (column) {
    case 'user':
      return compareStrings(a.session.userPrincipalName, b.session.userPrincipalName, direction);
    case 'state':
      return compareStrings(a.session.sessionState, b.session.sessionState, direction);
    case 'host':
      return compareStrings(a.session.sessionHostName, b.session.sessionHostName, direction);
    case 'startTime':
      return compareNullableNumeric(parseCreateTimeMs(a.session.createTime), parseCreateTimeMs(b.session.createTime), direction);
    case 'age':
      return compareNullableNumeric(a.ageInfo.ageMs, b.ageInfo.ageMs, direction);
    default:
      return 0;
  }
}

/** Filters (state + AM-31 item 38's free-text search) then sorts rows; sorting is a no-op (stable, original order) when `column` is undefined — the initial, pre-click state. `searchQuery` defaults to '' (no narrowing) so every EXISTING caller keeps working unchanged. */
export function selectVisibleRows(rows: readonly SessionRow[], filter: StateFilter, column: SortColumn | undefined, direction: SortDirection, searchQuery = ''): SessionRow[] {
  const filtered = rows.filter((row) => matchesStateFilter(row, filter) && matchesSearch(row, searchQuery));
  if (!column) return filtered;
  return [...filtered].sort((a, b) => compareRows(a, b, column, direction));
}
