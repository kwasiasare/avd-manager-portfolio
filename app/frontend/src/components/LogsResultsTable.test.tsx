import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { LogsTableResult } from '@avdmgr/shared';
import { renderWithProviders } from '../test/renderWithProviders';
import LogsResultsTable from './LogsResultsTable';

const TABLE: LogsTableResult = {
  columns: [{ name: 'Host', type: 'string' }, { name: 'Count', type: 'long' }],
  rows: [
    ['avd-con-1', 3],
    ['avd-con-0', 7],
  ],
  truncated: false,
};

describe('LogsResultsTable — sort-change announcement (AM-31 item 43)', () => {
  it('announces the sorted column and direction via a polite live region', async () => {
    const user = userEvent.setup();
    renderWithProviders(<LogsResultsTable table={TABLE} exportFileName="test" />);

    expect(screen.getByRole('status')).toHaveTextContent('');

    await user.click(screen.getByRole('button', { name: 'Host' }));
    expect(screen.getByRole('status')).toHaveTextContent('Sorted by Host ascending');

    await user.click(screen.getByRole('button', { name: 'Host' }));
    expect(screen.getByRole('status')).toHaveTextContent('Sorted by Host descending');
  });

  it('sorts rows by the clicked column', async () => {
    const user = userEvent.setup();
    renderWithProviders(<LogsResultsTable table={TABLE} exportFileName="test" />);

    await user.click(screen.getByRole('button', { name: 'Host' }));
    const rows = screen.getAllByRole('row').slice(1); // skip header row
    expect(rows[0]).toHaveTextContent('avd-con-0');
    expect(rows[1]).toHaveTextContent('avd-con-1');
  });
});
