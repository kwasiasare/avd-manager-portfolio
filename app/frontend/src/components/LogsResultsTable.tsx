import { useMemo, useState } from 'react';
import { makeStyles, tokens, Button, MessageBar, MessageBarBody, Table, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow, Text, Tooltip } from '@fluentui/react-components';
import { ArrowDownload16Regular, ArrowSort16Regular, ArrowSortDown16Regular, ArrowSortUp16Regular } from '@fluentui/react-icons';
import type { LogsTableResult } from '@avdmgr/shared';
import { toCsv, downloadCsv } from '../lib/csv';
import { sortRows, type SortDirection } from '../lib/logsSort';
import { useVisuallyHiddenStyles } from '../styles/shared';

const useStyles = makeStyles({
  wrap: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalS,
  },
  toolbar: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  scroll: {
    overflowX: 'auto',
  },
  headerButton: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalXS,
    justifyContent: 'flex-start',
    minWidth: 0,
  },
  cell: {
    whiteSpace: 'nowrap',
    maxWidth: '360px',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
});

/**
 * Rough heuristic for "this cell's text is long enough that the fixed
 * 360px/nowrap/ellipsis cell (see styles.cell) is likely truncating it" —
 * cheap (no DOM measurement/ResizeObserver) and good enough to decide
 * whether a Tooltip is worth wrapping the cell in at all; a false positive
 * just means an unnecessary (harmless) Tooltip on a cell that happened not
 * to truncate, a false negative just means a truncated cell without a
 * tooltip, same as before this fix — either way strictly better than
 * either "every cell gets a Tooltip" (real cost at 1000 rows × N columns)
 * or "no cell ever does."
 */
const LIKELY_TRUNCATED_LENGTH = 40;

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

export interface LogsResultsTableProps {
  table: LogsTableResult;
  /** Base filename (without extension) used for the CSV export — e.g. the view name or "raw-kql". */
  exportFileName: string;
}

/**
 * Renders one LogsTableResult (curated view or raw KQL result) as a
 * sortable table (click a column header to sort by it — cheap client-side
 * sort, see lib/logsSort.ts; no lib/sessionRows convention existed in this
 * codebase to reuse) with a CSV export button (lib/csv.ts).
 */
export default function LogsResultsTable({ table, exportFileName }: LogsResultsTableProps) {
  const styles = useStyles();
  const visuallyHiddenStyles = useVisuallyHiddenStyles();
  const [sort, setSort] = useState<{ columnIndex: number; direction: SortDirection } | undefined>(undefined);
  // AM-31 item 43 — announces sort changes; a plain render-time derivation from `sort` state, same pattern Sessions.tsx uses.
  const sortAnnouncement = sort ? `Sorted by ${table.columns[sort.columnIndex]?.name} ${sort.direction === 'asc' ? 'ascending' : 'descending'}` : '';

  const rows = useMemo(() => {
    if (!sort) return table.rows;
    return sortRows(table.rows, sort.columnIndex, sort.direction);
  }, [table.rows, sort]);

  function toggleSort(columnIndex: number) {
    setSort((prev) => {
      if (!prev || prev.columnIndex !== columnIndex) {
        return { columnIndex, direction: 'asc' };
      }
      return { columnIndex, direction: prev.direction === 'asc' ? 'desc' : 'asc' };
    });
  }

  function sortIconFor(columnIndex: number) {
    if (!sort || sort.columnIndex !== columnIndex) return <ArrowSort16Regular />;
    return sort.direction === 'asc' ? <ArrowSortUp16Regular /> : <ArrowSortDown16Regular />;
  }

  /** aria-sort value for a given column's <th> — 'none' for every column except the one currently sorted. */
  function ariaSortFor(columnIndex: number): 'none' | 'ascending' | 'descending' {
    if (!sort || sort.columnIndex !== columnIndex) return 'none';
    return sort.direction === 'asc' ? 'ascending' : 'descending';
  }

  function handleExport() {
    const csv = toCsv(
      table.columns.map((column) => column.name),
      rows,
    );
    downloadCsv(`${exportFileName}.csv`, csv);
  }

  if (table.rows.length === 0) {
    return <Text>No rows returned.</Text>;
  }

  return (
    <div className={styles.wrap}>
      {/* AM-31 item 43 */}
      <div role="status" aria-live="polite" className={visuallyHiddenStyles.visuallyHidden}>
        {sortAnnouncement}
      </div>
      <div className={styles.toolbar}>
        <Text size={200}>
          {table.rows.length} row{table.rows.length === 1 ? '' : 's'}
          {table.truncated ? ' (truncated — server-side row cap reached)' : ''}
        </Text>
        <Button size="small" icon={<ArrowDownload16Regular />} onClick={handleExport}>
          Export CSV
        </Button>
      </div>

      {table.truncated && (
        <MessageBar intent="warning">
          <MessageBarBody>This result was truncated to the server-side row cap. Narrow the time range or query for a complete set.</MessageBarBody>
        </MessageBar>
      )}

      <div className={styles.scroll}>
        <Table aria-label="Query results" size="small">
          <TableHeader>
            <TableRow>
              {table.columns.map((column, index) => (
                <TableHeaderCell key={column.name} aria-sort={ariaSortFor(index)}>
                  <Button appearance="transparent" size="small" className={styles.headerButton} icon={sortIconFor(index)} iconPosition="after" onClick={() => toggleSort(index)}>
                    {column.name}
                  </Button>
                </TableHeaderCell>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row, rowIndex) => (
              // Rows have no stable id (raw query results, re-rendered wholesale on each run) — index key is safe here.
              <TableRow key={rowIndex}>
                {row.map((cell, cellIndex) => {
                  const text = formatCell(cell);
                  if (text.length <= LIKELY_TRUNCATED_LENGTH) {
                    return (
                      <TableCell key={cellIndex} className={styles.cell}>
                        {text}
                      </TableCell>
                    );
                  }
                  return (
                    <TableCell key={cellIndex} className={styles.cell}>
                      <Tooltip content={text} relationship="label" withArrow>
                        <span>{text}</span>
                      </Tooltip>
                    </TableCell>
                  );
                })}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
