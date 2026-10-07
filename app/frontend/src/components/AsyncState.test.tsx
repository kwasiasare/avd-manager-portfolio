import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { renderWithProviders } from '../test/renderWithProviders';
import AppThemeProvider from '../theme/AppThemeProvider';
import AsyncState from './AsyncState';
import { ColdStartHintProvider } from './ColdStartHintProvider';

describe('AsyncState — loading/error/empty/success states', () => {
  it('renders a skeleton while loading', () => {
    renderWithProviders(<AsyncState loading error={undefined} data={undefined}>{() => <div>content</div>}</AsyncState>);
    expect(screen.getByLabelText('Loading')).toBeInTheDocument();
    expect(screen.queryByText('content')).not.toBeInTheDocument();
  });

  it('renders a full error state when there is no data at all', () => {
    renderWithProviders(
      <AsyncState loading={false} error={new Error('boom')} data={undefined}>
        {() => <div>content</div>}
      </AsyncState>,
    );
    expect(screen.getByText("Couldn't load this data")).toBeInTheDocument();
    expect(screen.getByText('boom')).toBeInTheDocument();
  });

  it('renders the empty message when isEmpty matches', () => {
    renderWithProviders(
      <AsyncState loading={false} error={undefined} data={[]} isEmpty={(data) => data.length === 0} emptyMessage="Nothing here.">
        {() => <div>content</div>}
      </AsyncState>,
    );
    expect(screen.getByText('Nothing here.')).toBeInTheDocument();
  });

  it('renders children when data is present and there is no error', () => {
    renderWithProviders(
      <AsyncState loading={false} error={undefined} data={{ value: 1 }}>
        {(data) => <div>value is {data.value}</div>}
      </AsyncState>,
    );
    expect(screen.getByText('value is 1')).toBeInTheDocument();
  });
});

describe('AsyncState — stale-data bar (AM-29 item 12)', () => {
  it('shows a stale-data warning bar above the children when error AND data are both present', () => {
    renderWithProviders(
      <AsyncState loading={false} error={new Error('timed out')} data={{ value: 1 }}>
        {(data) => <div>value is {data.value}</div>}
      </AsyncState>,
    );
    expect(screen.getByRole('status')).toHaveTextContent('Showing the last successful data');
    expect(screen.getByRole('status')).toHaveTextContent('timed out');
    expect(screen.getByText('value is 1')).toBeInTheDocument();
  });

  it('includes the asOf time when provided', () => {
    renderWithProviders(
      <AsyncState loading={false} error={new Error('timed out')} data={{ value: 1 }} asOf={new Date('2026-08-16T09:41:00')}>
        {(data) => <div>value is {data.value}</div>}
      </AsyncState>,
    );
    expect(screen.getByRole('status')).toHaveTextContent(/as of/i);
  });

  it('does not show the bar when there is no error', () => {
    renderWithProviders(
      <AsyncState loading={false} error={undefined} data={{ value: 1 }}>
        {(data) => <div>value is {data.value}</div>}
      </AsyncState>,
    );
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});

describe('AsyncState — skeleton variants (AM-29 item 23)', () => {
  it('renders a table-shaped skeleton (header + N rows) for variant "table"', () => {
    const { container } = renderWithProviders(
      <AsyncState loading error={undefined} data={undefined} variant="table" skeletonRows={2}>
        {() => <div>content</div>}
      </AsyncState>,
    );
    // Header bar + 2 rows = 3 skeleton items.
    expect(container.querySelectorAll('.fui-SkeletonItem').length).toBe(3);
  });

  it('renders a two-line skeleton for variant "stat"', () => {
    const { container } = renderWithProviders(
      <AsyncState loading error={undefined} data={undefined} variant="stat">
        {() => <div>content</div>}
      </AsyncState>,
    );
    expect(container.querySelectorAll('.fui-SkeletonItem').length).toBe(2);
  });

  it('renders a single block for variant "chart"', () => {
    const { container } = renderWithProviders(
      <AsyncState loading error={undefined} data={undefined} variant="chart">
        {() => <div>content</div>}
      </AsyncState>,
    );
    expect(container.querySelectorAll('.fui-SkeletonItem').length).toBe(1);
  });
});

describe('AsyncState — cold-start hint dedup (AM-29 item 13)', () => {
  it('shows the hint on every instance when there is no ColdStartHintProvider in scope', async () => {
    vi.useFakeTimers();
    try {
      // Deliberately NOT renderWithProviders here (peer review, Opus MINOR
      // item 12, added a ColdStartHintProvider to that helper by default so
      // components using useAppToast/AsyncState behave like they would on a
      // real page) — this specific test's whole point is exercising the
      // NO-provider-in-scope fallback, so it renders with the same
      // Router/theme providers minus ColdStartHintProvider.
      render(
        <MemoryRouter>
          <AppThemeProvider>
            <AsyncState loading error={undefined} data={undefined}>{() => null}</AsyncState>
            <AsyncState loading error={undefined} data={undefined}>{() => null}</AsyncState>
          </AppThemeProvider>
        </MemoryRouter>,
      );
      await vi.advanceTimersByTimeAsync(3_100);
      expect(screen.getAllByText(/cold-starting/i)).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows the hint on only the first instance inside a ColdStartHintProvider', async () => {
    vi.useFakeTimers();
    try {
      renderWithProviders(
        <ColdStartHintProvider>
          <AsyncState loading error={undefined} data={undefined}>{() => null}</AsyncState>
          <AsyncState loading error={undefined} data={undefined}>{() => null}</AsyncState>
        </ColdStartHintProvider>,
      );
      await vi.advanceTimersByTimeAsync(3_100);
      expect(screen.getAllByText(/cold-starting/i)).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
