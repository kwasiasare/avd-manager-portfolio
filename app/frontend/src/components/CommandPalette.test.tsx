import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import { renderWithProviders } from '../test/renderWithProviders';
import CommandPalette from './CommandPalette';
import { triggerRegisteredRefresh, useRegisterRefreshShortcut } from '../hooks/useKeyboardShortcuts';
import type { AuthState } from '../auth/AuthContext';

const getSessionHosts = vi.fn();
const getCurrentScalingPlan = vi.fn();
vi.mock('../api/avd', () => ({
  getSessionHosts: (...args: unknown[]) => getSessionHosts(...args),
  getCurrentScalingPlan: (...args: unknown[]) => getCurrentScalingPlan(...args),
}));

const useAuth = vi.fn<() => AuthState>();
vi.mock('../auth/useAuth', () => ({ useAuth: () => useAuth() }));

function authState(overrides: Partial<AuthState> = {}): AuthState {
  return { loading: false, isAuthenticated: true, userDetails: 'operator@example.com', roles: ['operator'], role: 'operator', ...overrides };
}

beforeEach(() => {
  getSessionHosts.mockResolvedValue([{ id: 'h1', name: 'avd-con-0' }]);
  getCurrentScalingPlan.mockResolvedValue({ id: 'p1', name: 'plan', hostPoolName: 'HP-CONTOSO-PROD', timeZone: 'UTC', enabled: true, schedules: [{ name: 'AllDays' }] });
  useAuth.mockReturnValue({ loading: true, isAuthenticated: false, userDetails: null, roles: [], role: null });
});

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname}</div>;
}

function renderPalette(onClose = vi.fn()) {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route path="*" element={<><CommandPalette onClose={onClose} /><LocationProbe /></>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('CommandPalette (AM-31 item 45)', () => {
  it('renders Navigation, Entities, and Actions groups', async () => {
    renderPalette();
    expect(screen.getByRole('combobox', { name: 'Command palette' })).toBeInTheDocument();
    expect(screen.getByText('Navigation')).toBeInTheDocument();
    expect(screen.getByText('Host Pool')).toBeInTheDocument();
    expect(await screen.findByText('avd-con-0')).toBeInTheDocument();
    expect(screen.getByText('AllDays')).toBeInTheDocument();
    expect(screen.getByText('Refresh current page')).toBeInTheDocument();
  });

  it('filters options by typeahead', async () => {
    const user = userEvent.setup();
    renderPalette();
    await user.type(screen.getByRole('combobox'), 'Governance');
    expect(screen.getByText('Governance')).toBeInTheDocument();
    expect(screen.queryByText('Host Pool')).not.toBeInTheDocument();
  });

  it('navigates and closes on selecting a Navigation item by keyboard', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    renderPalette(onClose);
    await user.type(screen.getByRole('combobox'), 'Sessions');
    await user.keyboard('{Enter}');
    expect(onClose).toHaveBeenCalled();
    expect(await screen.findByTestId('location')).toHaveTextContent('/sessions');
  });

  it('navigates on a mouse click too', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    renderPalette(onClose);
    await user.click(await screen.findByText('Governance'));
    expect(onClose).toHaveBeenCalled();
    expect(await screen.findByTestId('location')).toHaveTextContent('/governance');
  });

  it('closes on Escape without navigating', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    renderPalette(onClose);
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalled();
  });

  it('ArrowDown/ArrowUp move the active option, wrapping at the ends', async () => {
    const user = userEvent.setup();
    renderPalette();
    const combobox = screen.getByRole('combobox');
    await user.type(combobox, 'Dashboard');
    // Only one match — ArrowDown then ArrowUp should both land back on it (wrapping), not throw.
    await user.keyboard('{ArrowDown}{ArrowUp}');
    expect(combobox).toHaveAttribute('aria-activedescendant', 'nav-/');
  });

  it('shows "No matches." when the query matches nothing', async () => {
    const user = userEvent.setup();
    renderPalette();
    await user.type(screen.getByRole('combobox'), 'zzzznomatch');
    expect(screen.getByText('No matches.')).toBeInTheDocument();
  });

  it('the Refresh action calls whatever page refresh is currently registered (same handler `r` uses)', async () => {
    const user = userEvent.setup();
    const refreshHandler = vi.fn();
    function Registrar() {
      useRegisterRefreshShortcut(refreshHandler);
      return null;
    }
    renderWithProviders(
      <>
        <Registrar />
        <CommandPalette onClose={vi.fn()} />
      </>,
    );
    await user.click(await screen.findByText('Refresh current page'));
    expect(refreshHandler).toHaveBeenCalledTimes(1);
    // Also exercised directly, for a unit-level guarantee independent of the click path.
    triggerRegisteredRefresh();
    expect(refreshHandler).toHaveBeenCalledTimes(2);
  });

  it('shows the "Show keyboard shortcuts" action only when onOpenHelp is provided, and calls it', async () => {
    const user = userEvent.setup();
    const onOpenHelp = vi.fn();
    const onClose = vi.fn();
    render(
      <MemoryRouter>
        <CommandPalette onClose={onClose} onOpenHelp={onOpenHelp} />
      </MemoryRouter>,
    );
    const helpOption = screen.getByText('Show keyboard shortcuts');
    await user.click(helpOption);
    expect(onOpenHelp).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalled();
  });

  describe('"Recent actions" action (AM-32)', () => {
    it('is shown and opens the drawer for an operator', async () => {
      const user = userEvent.setup();
      const onOpenRecentActions = vi.fn();
      const onClose = vi.fn();
      useAuth.mockReturnValue(authState());
      render(
        <MemoryRouter>
          <CommandPalette onClose={onClose} onOpenRecentActions={onOpenRecentActions} />
        </MemoryRouter>,
      );
      const option = screen.getByText('Recent actions');
      await user.click(option);
      expect(onOpenRecentActions).toHaveBeenCalledTimes(1);
      expect(onClose).toHaveBeenCalled();
    });

    it('is shown for an admin too', () => {
      useAuth.mockReturnValue(authState({ role: 'admin', roles: ['admin'] }));
      render(
        <MemoryRouter>
          <CommandPalette onClose={vi.fn()} onOpenRecentActions={vi.fn()} />
        </MemoryRouter>,
      );
      expect(screen.getByText('Recent actions')).toBeInTheDocument();
    });

    it('is hidden for a viewer, even when onOpenRecentActions is provided', () => {
      useAuth.mockReturnValue(authState({ role: 'viewer', roles: ['viewer'] }));
      render(
        <MemoryRouter>
          <CommandPalette onClose={vi.fn()} onOpenRecentActions={vi.fn()} />
        </MemoryRouter>,
      );
      expect(screen.queryByText('Recent actions')).not.toBeInTheDocument();
    });

    it('is hidden when onOpenRecentActions is not provided, even for an operator', () => {
      useAuth.mockReturnValue(authState());
      render(
        <MemoryRouter>
          <CommandPalette onClose={vi.fn()} />
        </MemoryRouter>,
      );
      expect(screen.queryByText('Recent actions')).not.toBeInTheDocument();
    });
  });

  describe('Navigation group role filtering (AM-34 RULING 13)', () => {
    it('shows the operator-only Audit/Incident rows for an operator', () => {
      useAuth.mockReturnValue(authState());
      render(
        <MemoryRouter>
          <CommandPalette onClose={vi.fn()} />
        </MemoryRouter>,
      );
      expect(screen.getByText('Audit')).toBeInTheDocument();
      expect(screen.getByText('Incident')).toBeInTheDocument();
    });

    it('hides the operator-only Audit/Incident rows for a viewer, without hiding ordinary rows', () => {
      useAuth.mockReturnValue(authState({ role: 'viewer', roles: ['viewer'] }));
      render(
        <MemoryRouter>
          <CommandPalette onClose={vi.fn()} />
        </MemoryRouter>,
      );
      expect(screen.queryByText('Audit')).not.toBeInTheDocument();
      expect(screen.queryByText('Incident')).not.toBeInTheDocument();
      expect(screen.getByText('Host Pool')).toBeInTheDocument();
    });
  });
});
