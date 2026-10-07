/**
 * Pure row-sorting for LogsTableResult.rows (AM-24's curated-view/raw-KQL
 * results tables) — cheap client-side sort-by-column-click, not a
 * server-side ORDER BY. No lib/sessionRows convention exists in this
 * codebase to reuse (checked); kept this equally small and dependency-free.
 */
export type SortDirection = 'asc' | 'desc';

/**
 * ISO-8601-shaped date/datetime strings only — deliberately NOT a general
 * "does Date.parse accept this" check. V8's Date.parse is far more
 * permissive than ISO 8601 (peer review item 15): short strings like
 * "1.2.3" or "3/4" parse as dates in some engines, which would silently
 * mis-sort a numeric-looking or version-looking column through the date
 * branch below instead of falling through to a plain string compare. This
 * pattern requires a 4-digit year and a 'T' or space time separator when a
 * time-of-day is present, matching what `new Date(...).toISOString()`
 * (every timestamp this app itself produces) actually looks like.
 */
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

/** Coerces a cell value to something comparable: numbers/dates compare numerically, everything else falls back to a locale-aware string compare. */
function compareCells(a: unknown, b: unknown): number {
  if (a === null || a === undefined) return b === null || b === undefined ? 0 : -1;
  if (b === null || b === undefined) return 1;

  const numA = typeof a === 'number' ? a : Number(a);
  const numB = typeof b === 'number' ? b : Number(b);
  if (!Number.isNaN(numA) && !Number.isNaN(numB) && a !== '' && b !== '') {
    return numA - numB;
  }

  const aIsDateLike = a instanceof Date || (typeof a === 'string' && ISO_DATE_PATTERN.test(a));
  const bIsDateLike = b instanceof Date || (typeof b === 'string' && ISO_DATE_PATTERN.test(b));
  if (aIsDateLike && bIsDateLike) {
    const dateA = a instanceof Date ? a.getTime() : Date.parse(a as string);
    const dateB = b instanceof Date ? b.getTime() : Date.parse(b as string);
    if (!Number.isNaN(dateA) && !Number.isNaN(dateB)) {
      return dateA - dateB;
    }
  }

  return String(a).localeCompare(String(b));
}

/** Returns a NEW sorted array (never mutates `rows`) ordered by column index `columnIndex`. */
export function sortRows(rows: unknown[][], columnIndex: number, direction: SortDirection): unknown[][] {
  const sorted = [...rows].sort((a, b) => compareCells(a[columnIndex], b[columnIndex]));
  return direction === 'asc' ? sorted : sorted.reverse();
}
