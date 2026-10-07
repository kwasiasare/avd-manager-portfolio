import { useMemo, useState, type ComponentProps, type ReactNode } from 'react';
import { Button, Table, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow, Text, makeStyles, tokens } from '@fluentui/react-components';
import { ArrowDownload16Regular } from '@fluentui/react-icons';
import TableScroll from './TableScroll';
import { useVisuallyHiddenStyles } from '../styles/shared';
import { toCsv, downloadCsv } from '../lib/csv';

export type DataTableSortDirection = 'ascending' | 'descending';

export interface DataTableColumn<T> {
  /** Stable column identifier — used as the React key and as the sort-state target. */
  id: string;
  /** Plain-text column name — drives the default header cell, the sort announcement, and (when `visuallyHiddenHeader` is set) the header cell's accessible name. */
  label: string;
  /** Custom header cell content. Defaults to a plain `label`. Ignored when `visuallyHiddenHeader` is set (label always wins there, rendered visually hidden). */
  header?: ReactNode;
  /** Renders `label` visually-hidden inside the header cell instead of showing it (or `header`) — for a column whose purpose is obvious from its cells alone (e.g. a trailing row-actions column with no visible header text in the original tables this component replaces). */
  visuallyHiddenHeader?: boolean;
  renderCell: (row: T) => ReactNode;
  /** Enables client-side sorting on this column. Requires `comparator`. */
  sortable?: boolean;
  /**
   * Direction-aware comparator for this column. Taking `direction` (rather
   * than DataTable flipping a plain ascending comparator's sign itself)
   * lets a column keep its own "where do unknown/undefined values go"
   * rule regardless of direction — e.g. lib/sessionRows.ts's
   * compareNullableNumeric always sorts unknowns last, in EITHER direction,
   * which a generic sign-flip cannot express. Required when `sortable` is
   * true.
   */
  comparator?: (a: T, b: T, direction: DataTableSortDirection) => number;
  /** Value used for this column's cell in a CSV export (see `csvExport`). Defaults to `renderCell`'s return value when that's a plain string/number, otherwise an empty cell — provide this for any column whose cell renders a component/badge/JSX. */
  csvValue?: (row: T) => unknown;
  /** Optional className applied to both the header cell and every body cell in this column (e.g. a fixed max-width for a long-text column). */
  className?: string;
}

export interface DataTableCsvExportConfig<T> {
  /** Base filename (without extension) for the downloaded CSV. */
  fileName: string;
  /** Defaults to every column's `label`. */
  headers?: string[];
  /** Defaults to every column's `csvValue` (or `renderCell`'s plain string/number result). */
  rowValues?: (row: T) => unknown[];
}

export interface DataTableProps<T> {
  columns: ReadonlyArray<DataTableColumn<T>>;
  rows: readonly T[];
  /** Stable per-row React key. */
  getRowKey: (row: T) => string;
  /** Accessible name for the scrollable table region (TableScroll) — see that component's own doc comment for why this isn't ALSO put on the inner `<Table>`. */
  ariaLabel: string;
  /** Shown (in a full-width row spanning every column) when `rows` is empty and `activeFilterDescription` is not given. */
  emptyMessage: ReactNode;
  /**
   * Shown instead of `emptyMessage` when `rows` is empty because of an
   * active filter/search (as opposed to there being no data at all) —
   * generalizes the Sessions page's "No sessions match state X and search
   * Y." pattern. Pair with `onClearFilters` to also offer a one-click way
   * out.
   */
  activeFilterDescription?: ReactNode;
  /** Renders a "Clear filters" button next to the empty-state message; only shown while `rows` is empty. */
  onClearFilters?: () => void;
  /** Renders a trailing per-row cell (e.g. an overflow menu) after every data column. */
  rowActions?: (row: T) => ReactNode;
  /** Header cell content for the `rowActions` column. Defaults to a visually-hidden "Actions" label (matching every existing per-row-action table this component replaces); pass a plain string/node to show a visible header instead (e.g. Monitoring's "Actions" column). */
  rowActionsHeader?: ReactNode;
  /** Optional per-row className (e.g. a stale/warning left-border accent). */
  rowClassName?: (row: T) => string | undefined;
  /** Optional per-row Fluent TableRow `appearance` (e.g. 'brand' to highlight a "current" row — see Images.tsx's version timeline). */
  rowAppearance?: (row: T) => ComponentProps<typeof TableRow>['appearance'];
  size?: 'extra-small' | 'small' | 'medium';
  /** Adds an "Export CSV" toolbar button above the table, reusing lib/csv.ts's RFC-4180 + formula-injection-guarded serializer. */
  csvExport?: DataTableCsvExportConfig<T>;
}

const useStyles = makeStyles({
  wrap: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalS,
  },
  toolbar: {
    display: 'flex',
    justifyContent: 'flex-end',
  },
  emptyRow: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalM,
    padding: `${tokens.spacingVerticalM} 0`,
  },
  muted: {
    color: tokens.colorNeutralForeground3,
  },
});

/** Plain string/number cell values export as-is; anything else (badges, tooltips, composite cells) exports as an empty cell unless the column provides its own `csvValue`. */
function defaultCsvCell(value: ReactNode): unknown {
  return typeof value === 'string' || typeof value === 'number' ? value : '';
}

/**
 * The one shared wrapper over Fluent's DataGrid-shaped `<Table>` every
 * app table should render through (AM-35, item 44) — typed column defs,
 * built-in client-side sort (aria-sort + a polite sort announcement,
 * reusing the same pattern Sessions.tsx/LogsResultsTable.tsx hand-rolled
 * independently before this), a column-driven empty state (generalizing
 * Sessions' "names the active filter + one-click Clear" row), an optional
 * CSV export button (lib/csv.ts), and TableScroll + size="small" built in.
 *
 * Sorting is entirely OWNED here — a caller that also filters/searches its
 * rows (e.g. Sessions' state dropdown + free-text search) does that
 * filtering itself and passes the already-filtered `rows` in; this
 * component only ever sorts what it's given, so filter-then-sort ordering
 * is naturally preserved without either side needing to know about the
 * other's state.
 */
export default function DataTable<T>({
  columns,
  rows,
  getRowKey,
  ariaLabel,
  emptyMessage,
  activeFilterDescription,
  onClearFilters,
  rowActions,
  rowActionsHeader,
  rowClassName,
  rowAppearance,
  size = 'small',
  csvExport,
}: DataTableProps<T>) {
  const styles = useStyles();
  const visuallyHiddenStyles = useVisuallyHiddenStyles();
  const [sort, setSort] = useState<{ columnId: string; direction: DataTableSortDirection } | undefined>(undefined);

  const sortedRows = useMemo(() => {
    if (!sort) return rows;
    const column = columns.find((candidate) => candidate.id === sort.columnId);
    if (!column?.comparator) return rows;
    const { comparator } = column;
    const { direction } = sort;
    return [...rows].sort((a, b) => comparator(a, b, direction));
  }, [rows, sort, columns]);

  function handleHeaderClick(column: DataTableColumn<T>) {
    if (!column.sortable) return;
    setSort((previous) => {
      if (previous && previous.columnId === column.id) {
        return { columnId: column.id, direction: previous.direction === 'ascending' ? 'descending' : 'ascending' };
      }
      return { columnId: column.id, direction: 'ascending' };
    });
  }

  function sortDirectionFor(columnId: string): DataTableSortDirection | undefined {
    return sort?.columnId === columnId ? sort.direction : undefined;
  }

  // Reuses the same "role=status aria-live=polite, render-time derivation
  // from sort state" pattern Sessions.tsx/LogsResultsTable.tsx used
  // independently before this component existed (AM-31 item 43).
  const sortedColumnLabel = sort ? columns.find((column) => column.id === sort.columnId)?.label : undefined;
  const sortAnnouncement = sort && sortedColumnLabel ? `Sorted by ${sortedColumnLabel} ${sort.direction}` : '';

  const colSpan = columns.length + (rowActions ? 1 : 0);

  function handleExport() {
    if (!csvExport) return;
    const headers = csvExport.headers ?? columns.map((column) => column.label);
    const rowValues =
      csvExport.rowValues ?? ((row: T) => columns.map((column) => (column.csvValue ? column.csvValue(row) : defaultCsvCell(column.renderCell(row)))));
    const csv = toCsv(headers, sortedRows.map(rowValues));
    downloadCsv(`${csvExport.fileName}.csv`, csv);
  }

  return (
    <div className={styles.wrap}>
      {/* NIT: named per-table (not just a bare "status") so a page mounting more than one DataTable at once has a screen reader announce WHICH table's sort just changed. */}
      <div role="status" aria-live="polite" aria-label={`${ariaLabel} sort status`} className={visuallyHiddenStyles.visuallyHidden}>
        {sortAnnouncement}
      </div>

      {csvExport && (
        <div className={styles.toolbar}>
          <Button size="small" icon={<ArrowDownload16Regular />} onClick={handleExport}>
            Export CSV
          </Button>
        </div>
      )}

      <TableScroll ariaLabel={ariaLabel}>
        <Table size={size}>
          <TableHeader>
            <TableRow>
              {columns.map((column) => (
                <TableHeaderCell
                  key={column.id}
                  className={column.className}
                  sortable={column.sortable}
                  sortDirection={column.sortable ? sortDirectionFor(column.id) : undefined}
                  onClick={column.sortable ? () => handleHeaderClick(column) : undefined}
                >
                  {column.visuallyHiddenHeader ? <span className={visuallyHiddenStyles.visuallyHidden}>{column.label}</span> : (column.header ?? column.label)}
                </TableHeaderCell>
              ))}
              {rowActions && (
                <TableHeaderCell>
                  {rowActionsHeader ?? <span className={visuallyHiddenStyles.visuallyHidden}>Actions</span>}
                </TableHeaderCell>
              )}
            </TableRow>
          </TableHeader>
          <TableBody>
            {sortedRows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={colSpan}>
                  <div className={styles.emptyRow}>
                    <Text className={styles.muted}>{activeFilterDescription ?? emptyMessage}</Text>
                    {/* Peer review (Opus, MINOR 8): gated on BOTH — a caller passing onClearFilters without an active filter (nothing to clear right now) must not show a live button with no filter description next to it. */}
                    {activeFilterDescription && onClearFilters && (
                      <Button appearance="secondary" size="small" onClick={onClearFilters}>
                        Clear filters
                      </Button>
                    )}
                  </div>
                </TableCell>
              </TableRow>
            ) : (
              sortedRows.map((row) => (
                <TableRow key={getRowKey(row)} className={rowClassName?.(row)} appearance={rowAppearance?.(row)}>
                  {columns.map((column) => (
                    <TableCell key={column.id} className={column.className}>
                      {column.renderCell(row)}
                    </TableCell>
                  ))}
                  {rowActions && <TableCell>{rowActions(row)}</TableCell>}
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </TableScroll>
    </div>
  );
}
