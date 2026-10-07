import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../test/renderWithProviders';
import DataTable, { type DataTableColumn } from './DataTable';

interface Row {
  id: string;
  name: string;
  count: number;
}

const ROWS: Row[] = [
  { id: 'b', name: 'Bravo', count: 2 },
  { id: 'a', name: 'Alpha', count: 5 },
  { id: 'c', name: 'Charlie', count: 1 },
];

const NAME_COLUMN: DataTableColumn<Row> = {
  id: 'name',
  label: 'Name',
  renderCell: (row) => row.name,
  sortable: true,
  comparator: (a, b, direction) => (direction === 'ascending' ? a.name.localeCompare(b.name) : b.name.localeCompare(a.name)),
};

const COUNT_COLUMN: DataTableColumn<Row> = {
  id: 'count',
  label: 'Count',
  renderCell: (row) => String(row.count),
  sortable: true,
  comparator: (a, b, direction) => (direction === 'ascending' ? a.count - b.count : b.count - a.count),
};

function bodyRowTexts() {
  // First row is the header row — every test here has exactly one header row.
  return screen.getAllByRole('row').slice(1).map((row) => row.textContent);
}

/**
 * Shared csvExport test scaffolding — stubs Blob (to capture the serialized
 * CSV text without relying on jsdom's Blob.text(), which isn't implemented),
 * URL.createObjectURL/revokeObjectURL, and the download-link click, then
 * returns the captured parts array a test can assert against after
 * clicking "Export CSV" itself.
 */
function stubCsvDownload(): BlobPart[][] {
  const capturedParts: BlobPart[][] = [];
  const OriginalBlob = globalThis.Blob;
  class CapturingBlob extends OriginalBlob {
    constructor(parts: BlobPart[], options?: BlobPropertyBag) {
      super(parts, options);
      capturedParts.push(parts);
    }
  }
  vi.stubGlobal('Blob', CapturingBlob);
  vi.stubGlobal('URL', { ...URL, createObjectURL: vi.fn().mockReturnValue('blob:mock'), revokeObjectURL: vi.fn() });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  return capturedParts;
}

describe('DataTable', () => {
  it('renders every row via renderCell, keyed by getRowKey, in the given order when unsorted', () => {
    renderWithProviders(<DataTable columns={[NAME_COLUMN, COUNT_COLUMN]} rows={ROWS} getRowKey={(row) => row.id} ariaLabel="Test table" emptyMessage="No rows." />);

    expect(bodyRowTexts()).toEqual(['Bravo2', 'Alpha5', 'Charlie1']);
    expect(screen.getByRole('region', { name: 'Test table' })).toBeInTheDocument();
  });

  it('renders a plain (non-sortable) header cell for a column with sortable unset', () => {
    const plainColumn: DataTableColumn<Row> = { id: 'name', label: 'Name', renderCell: (row) => row.name };
    renderWithProviders(<DataTable columns={[plainColumn]} rows={ROWS} getRowKey={(row) => row.id} ariaLabel="Test table" emptyMessage="No rows." />);
    const header = screen.getByRole('columnheader', { name: 'Name' });
    // No value arg — asserts the attribute is ABSENT entirely, not just not-'ascending' (which would also pass for e.g. aria-sort="none").
    expect(header).not.toHaveAttribute('aria-sort');
  });

  describe('sorting', () => {
    it('sorts ascending on first click, descending on second, and toggles aria-sort', async () => {
      const user = userEvent.setup();
      renderWithProviders(<DataTable columns={[NAME_COLUMN, COUNT_COLUMN]} rows={ROWS} getRowKey={(row) => row.id} ariaLabel="Test table" emptyMessage="No rows." />);

      const nameHeader = screen.getByRole('columnheader', { name: 'Name' });
      await user.click(nameHeader);
      expect(bodyRowTexts()).toEqual(['Alpha5', 'Bravo2', 'Charlie1']);
      expect(nameHeader).toHaveAttribute('aria-sort', 'ascending');

      await user.click(nameHeader);
      expect(bodyRowTexts()).toEqual(['Charlie1', 'Bravo2', 'Alpha5']);
      expect(nameHeader).toHaveAttribute('aria-sort', 'descending');
    });

    it('switching the sorted column resets to ascending on the newly clicked column', async () => {
      const user = userEvent.setup();
      renderWithProviders(<DataTable columns={[NAME_COLUMN, COUNT_COLUMN]} rows={ROWS} getRowKey={(row) => row.id} ariaLabel="Test table" emptyMessage="No rows." />);

      await user.click(screen.getByRole('columnheader', { name: 'Name' }));
      await user.click(screen.getByRole('columnheader', { name: 'Name' })); // now descending
      await user.click(screen.getByRole('columnheader', { name: 'Count' }));

      expect(bodyRowTexts()).toEqual(['Charlie1', 'Bravo2', 'Alpha5']); // ascending by count
      expect(screen.getByRole('columnheader', { name: 'Count' })).toHaveAttribute('aria-sort', 'ascending');
    });

    it('announces the sorted column and direction via a polite live region (reused W2 pattern)', async () => {
      const user = userEvent.setup();
      renderWithProviders(<DataTable columns={[NAME_COLUMN, COUNT_COLUMN]} rows={ROWS} getRowKey={(row) => row.id} ariaLabel="Test table" emptyMessage="No rows." />);

      expect(screen.getByRole('status')).toHaveTextContent('');
      await user.click(screen.getByRole('columnheader', { name: 'Name' }));
      expect(screen.getByRole('status')).toHaveTextContent('Sorted by Name ascending');
      await user.click(screen.getByRole('columnheader', { name: 'Name' }));
      expect(screen.getByRole('status')).toHaveTextContent('Sorted by Name descending');
    });
  });

  describe('empty state', () => {
    it('shows emptyMessage and no Clear-filters button when there is no active filter', () => {
      renderWithProviders(<DataTable columns={[NAME_COLUMN]} rows={[]} getRowKey={(row) => row.id} ariaLabel="Test table" emptyMessage="Nothing here." />);
      expect(screen.getByText('Nothing here.')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Clear filters' })).not.toBeInTheDocument();
    });

    it('prefers activeFilterDescription over emptyMessage, and calls onClearFilters when its button is clicked', async () => {
      const user = userEvent.setup();
      const onClearFilters = vi.fn();
      renderWithProviders(
        <DataTable
          columns={[NAME_COLUMN, COUNT_COLUMN]}
          rows={[]}
          getRowKey={(row) => row.id}
          ariaLabel="Test table"
          emptyMessage="Nothing here."
          activeFilterDescription={'No rows match "Alpha".'}
          onClearFilters={onClearFilters}
        />,
      );

      expect(screen.getByText('No rows match "Alpha".')).toBeInTheDocument();
      expect(screen.queryByText('Nothing here.')).not.toBeInTheDocument();

      const clearButton = screen.getByRole('button', { name: 'Clear filters' });
      // The empty row spans every column (2 here) — regression guard for the colSpan math.
      expect(clearButton.closest('td')).toHaveAttribute('colspan', '2');

      await user.click(clearButton);
      expect(onClearFilters).toHaveBeenCalledTimes(1);
    });

    it('extends colSpan by one when rowActions is set', () => {
      renderWithProviders(
        <DataTable columns={[NAME_COLUMN]} rows={[]} getRowKey={(row) => row.id} ariaLabel="Test table" emptyMessage="Nothing here." rowActions={() => <button>Act</button>} />,
      );
      expect(screen.getByText('Nothing here.').closest('td')).toHaveAttribute('colspan', '2');
    });
  });

  describe('row actions', () => {
    it('renders a trailing cell per row and defaults its header to a visually-hidden "Actions"', () => {
      renderWithProviders(
        <DataTable
          columns={[NAME_COLUMN]}
          rows={ROWS}
          getRowKey={(row) => row.id}
          ariaLabel="Test table"
          emptyMessage="No rows."
          rowActions={(row) => <button>Delete {row.name}</button>}
        />,
      );
      expect(screen.getByRole('columnheader', { name: 'Actions' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Delete Alpha' })).toBeInTheDocument();
    });

    it('shows a visible custom rowActionsHeader when given', () => {
      renderWithProviders(
        <DataTable columns={[NAME_COLUMN]} rows={ROWS} getRowKey={(row) => row.id} ariaLabel="Test table" emptyMessage="No rows." rowActions={() => <span>x</span>} rowActionsHeader="Actions" />,
      );
      const header = screen.getByRole('columnheader', { name: 'Actions' });
      expect(header).toHaveTextContent('Actions');
    });
  });

  it('applies visuallyHiddenHeader by rendering the label off-screen instead of visibly', () => {
    const hiddenColumn: DataTableColumn<Row> = { id: 'name', label: 'Hidden Label', renderCell: (row) => row.name, visuallyHiddenHeader: true };
    renderWithProviders(<DataTable columns={[hiddenColumn]} rows={ROWS} getRowKey={(row) => row.id} ariaLabel="Test table" emptyMessage="No rows." />);
    // Still queryable by accessible name (screen readers see it)...
    const header = screen.getByRole('columnheader', { name: 'Hidden Label' });
    // ...but visually clipped (the standard 1x1px visually-hidden recipe).
    expect(header.querySelector('span')).toHaveStyle({ width: '1px', height: '1px' });
  });

  it('applies rowAppearance per row (e.g. highlighting a "current" row)', () => {
    renderWithProviders(
      <DataTable columns={[NAME_COLUMN]} rows={ROWS} getRowKey={(row) => row.id} ariaLabel="Test table" emptyMessage="No rows." rowAppearance={(row) => (row.id === 'a' ? 'brand' : 'none')} />,
    );
    const alphaRow = screen.getByText('Alpha').closest('tr');
    const bravoRow = screen.getByText('Bravo').closest('tr');
    expect(alphaRow?.className).not.toBe(bravoRow?.className);
  });

  it('applies rowClassName per row', () => {
    renderWithProviders(
      <DataTable columns={[NAME_COLUMN]} rows={ROWS} getRowKey={(row) => row.id} ariaLabel="Test table" emptyMessage="No rows." rowClassName={(row) => (row.id === 'a' ? 'flagged' : undefined)} />,
    );
    const alphaRow = screen.getByText('Alpha').closest('tr');
    const bravoRow = screen.getByText('Bravo').closest('tr');
    expect(alphaRow?.className).toContain('flagged');
    expect(bravoRow?.className).not.toContain('flagged');
  });

  describe('csvExport', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('is opt-in — no Export CSV button when csvExport is not given', () => {
      renderWithProviders(<DataTable columns={[NAME_COLUMN]} rows={ROWS} getRowKey={(row) => row.id} ariaLabel="Test table" emptyMessage="No rows." />);
      expect(screen.queryByRole('button', { name: 'Export CSV' })).not.toBeInTheDocument();
    });

    it('exports the CURRENTLY SORTED rows as a CSV download when clicked', async () => {
      const user = userEvent.setup();
      const capturedParts = stubCsvDownload();

      renderWithProviders(
        <DataTable columns={[NAME_COLUMN, COUNT_COLUMN]} rows={ROWS} getRowKey={(row) => row.id} ariaLabel="Test table" emptyMessage="No rows." csvExport={{ fileName: 'export-test' }} />,
      );

      await user.click(screen.getByRole('columnheader', { name: 'Name' })); // sort ascending by name first
      await user.click(screen.getByRole('button', { name: 'Export CSV' }));

      expect(HTMLAnchorElement.prototype.click).toHaveBeenCalledTimes(1);
      expect(capturedParts).toHaveLength(1);
      expect(capturedParts[0][0]).toBe('Name,Count\r\nAlpha,5\r\nBravo,2\r\nCharlie,1');
    });

    it('uses a column\'s csvValue override instead of its (non-plain) renderCell output', async () => {
      const user = userEvent.setup();
      const capturedParts = stubCsvDownload();
      const badgeColumn: DataTableColumn<Row> = {
        id: 'name',
        label: 'Name',
        renderCell: (row) => <span data-testid={`badge-${row.id}`}>{row.name}</span>,
        csvValue: (row) => row.name.toUpperCase(),
      };

      renderWithProviders(<DataTable columns={[badgeColumn]} rows={ROWS} getRowKey={(row) => row.id} ariaLabel="Test table" emptyMessage="No rows." csvExport={{ fileName: 'export-test' }} />);
      await user.click(screen.getByRole('button', { name: 'Export CSV' }));

      expect(capturedParts[0][0]).toBe('Name\r\nBRAVO\r\nALPHA\r\nCHARLIE');
    });

    it('exports a blank cell for a JSX renderCell result with no csvValue override', async () => {
      const user = userEvent.setup();
      const capturedParts = stubCsvDownload();
      const badgeColumn: DataTableColumn<Row> = {
        id: 'name',
        label: 'Name',
        renderCell: (row) => <span data-testid={`badge-${row.id}`}>{row.name}</span>,
        // No csvValue — defaultCsvCell only accepts plain string/number renderCell results.
      };

      renderWithProviders(<DataTable columns={[badgeColumn, COUNT_COLUMN]} rows={ROWS} getRowKey={(row) => row.id} ariaLabel="Test table" emptyMessage="No rows." csvExport={{ fileName: 'export-test' }} />);
      await user.click(screen.getByRole('button', { name: 'Export CSV' }));

      expect(capturedParts[0][0]).toBe('Name,Count\r\n,2\r\n,5\r\n,1');
    });
  });
});
