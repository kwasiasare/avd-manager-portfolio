/**
 * Pure, dependency-free CSV serialization for client-side export (AM-24:
 * "Export CSV" on the logs/raw-KQL results table). No test harness exists
 * for app/frontend today (unlike app/api and app/shared, which run under
 * vitest) — kept pure and framework-free so it stays trivially testable
 * whenever that harness is added, without needing DOM/React fixtures.
 *
 * Quoting follows RFC 4180: a field is quoted only when it contains the
 * delimiter, a double quote, or a line break; an embedded double quote is
 * escaped by doubling it. Fields that don't need quoting are left bare,
 * matching what Excel/Sheets/etc. produce themselves — this keeps output
 * diffable and avoids surprising anyone who opens the file in a text editor.
 *
 * CSV FORMULA INJECTION (peer review MAJOR 4): cells in a logs export come
 * from Log Analytics data an operator does NOT control end-to-end — e.g.
 * ClientOS/ClientVersion (WVDConnections, ultimately client-supplied) or
 * Message (WVDErrors) could contain a value starting with `=`, `+`, `-`, or
 * `@`, which Excel/Sheets/LibreOffice will interpret as the start of a
 * FORMULA when the CSV is opened, not literal text (OWASP: "CSV Injection").
 * A leading tab or carriage return has the same effect in some spreadsheet
 * apps' auto-detection. Every such cell is neutralized by prefixing a
 * single quote (`'`) BEFORE RFC-4180 quoting is decided/applied — the
 * leading `'` is itself a widely-supported "treat as text" escape in these
 * apps and is stripped from the displayed value, so this doesn't corrupt
 * genuinely numeric/date-formatted data, only formula-shaped text.
 */

/** Leading characters that make a spreadsheet app treat a cell as a formula rather than literal text — see the CSV FORMULA INJECTION comment above. */
const FORMULA_TRIGGER_CHARS = ['=', '+', '-', '@', '\t', '\r'];

/** True when `value` needs to be wrapped in double quotes per RFC 4180. */
function needsQuoting(value: string, delimiter: string): boolean {
  return value.includes(delimiter) || value.includes('"') || value.includes('\n') || value.includes('\r');
}

/** True when `value` would be interpreted as a formula (or otherwise mis-parsed) by a spreadsheet app on open — see the CSV FORMULA INJECTION comment above. */
function needsFormulaGuard(value: string): boolean {
  return value.length > 0 && FORMULA_TRIGGER_CHARS.includes(value[0]);
}

/** Escapes and (if needed) quotes a single field value. Formula-guarding is applied FIRST (prefixing `'`) so a guarded value that also needs RFC-4180 quoting (e.g. it contains a comma) gets both, in the right order. */
export function escapeCsvField(value: unknown, delimiter = ','): string {
  let stringValue = stringifyCell(value);
  if (needsFormulaGuard(stringValue)) {
    stringValue = `'${stringValue}`;
  }
  if (!needsQuoting(stringValue, delimiter)) {
    return stringValue;
  }
  return `"${stringValue.replace(/"/g, '""')}"`;
}

/** Converts an arbitrary cell value (as found in LogsTableResult.rows) to its CSV-cell string form, before quoting. */
function stringifyCell(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'string') {
    return value;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

/**
 * Serializes a header row + data rows into a single CSV string (CRLF line
 * endings, per RFC 4180 — safest default for the widest range of
 * spreadsheet apps consuming a downloaded file). Row arrays are NOT
 * required to be the same length as `headers` — shorter rows produce empty
 * trailing cells rather than throwing, so a partial/irregular result table
 * still exports without crashing the UI over it.
 */
export function toCsv(headers: string[], rows: unknown[][], delimiter = ','): string {
  const lines = [headers.map((header) => escapeCsvField(header, delimiter)).join(delimiter)];
  for (const row of rows) {
    lines.push(row.map((cell) => escapeCsvField(cell, delimiter)).join(delimiter));
  }
  return lines.join('\r\n');
}

/**
 * Triggers a browser download of `content` as `filename` — plain Blob +
 * object URL, no server round-trip. Extracted from LogsResultsTable.tsx
 * (AM-35) so DataTable.tsx's own optional CSV export button can share it
 * rather than re-implementing the same download-a-Blob dance.
 */
export function downloadCsv(filename: string, content: string): void {
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
