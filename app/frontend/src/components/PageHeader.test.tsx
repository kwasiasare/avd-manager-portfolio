import { describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../test/renderWithProviders';
import PageHeader from './PageHeader';

describe('PageHeader', () => {
  it('renders the title as an h1 and sets document.title', () => {
    renderWithProviders(<PageHeader title="Host Pool" />);
    expect(screen.getByRole('heading', { level: 1, name: 'Host Pool' })).toBeInTheDocument();
    expect(document.title).toBe('AVD Manager — Host Pool');
  });

  it('renders actions and an as-of timestamp when provided', () => {
    renderWithProviders(<PageHeader title="Sessions" actions={<button type="button">Broadcast</button>} asOf={new Date('2026-08-16T09:41:00')} />);
    expect(screen.getByRole('button', { name: 'Broadcast' })).toBeInTheDocument();
    expect(screen.getByText(/as of/i)).toBeInTheDocument();
  });

  it('omits the refresh button when onRefresh is not provided', () => {
    renderWithProviders(<PageHeader title="Governance" />);
    expect(screen.queryByRole('button', { name: /refresh/i })).not.toBeInTheDocument();
  });

  it('calls onRefresh when the refresh button is clicked', async () => {
    const user = userEvent.setup();
    const onRefresh = vi.fn();
    renderWithProviders(<PageHeader title="Dashboard" onRefresh={onRefresh} />);

    const refreshButton = screen.getByRole('button', { name: /refresh now/i });
    expect(refreshButton).toBeEnabled();
    await user.click(refreshButton);
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('disables the refresh button and shows a spinner while refreshing', () => {
    renderWithProviders(<PageHeader title="Dashboard" onRefresh={vi.fn()} refreshing />);
    expect(screen.getByRole('button', { name: /refresh now/i })).toBeDisabled();
    expect(screen.getByText(/refreshing/i)).toBeInTheDocument();
  });
});
