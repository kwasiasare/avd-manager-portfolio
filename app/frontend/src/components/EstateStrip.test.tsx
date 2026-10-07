import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { EstateSummaryResponse } from '@avdmgr/shared';
import { renderWithProviders } from '../test/renderWithProviders';
import type { AuthState } from '../auth/AuthContext';

const getEstateSummary = vi.fn();
vi.mock('../api/avd', () => ({
  getEstateSummary: (...args: unknown[]) => getEstateSummary(...args),
}));

const useAuth = vi.fn<() => AuthState>();
vi.mock('../auth/useAuth', () => ({ useAuth: () => useAuth() }));

function authState(overrides: Partial<AuthState> = {}): AuthState {
  return { loading: false, isAuthenticated: true, userDetails: 'operator@example.com', roles: ['operator'], role: 'operator', ...overrides };
}

// AM-34 (M8-W5, D6): the Incident toggle's own RoleGate now calls useAuth()
// unconditionally on every render (previously this file's tests never hit
// any RoleGate at all unless they passed onOpenRecentActions — see the
// "Recent actions button" describe block below) — every test needs a
// resolved identity by default now, same as Monitoring.test.tsx's own
// beforeEach.
beforeEach(() => {
  useAuth.mockReturnValue(authState());
});

const { default: EstateStrip } = await import('./EstateStrip');

const FULL: EstateSummaryResponse = {
  generatedAt: '2026-08-16T09:41:00.000Z',
  hostPoolName: 'HP-CONTOSO-PROD',
  hosts: { available: 5, total: 6 },
  sessions: { used: 12, capacity: 48 },
  scalingPhase: 'Peak',
  openAlertCount: 2,
  overrideActive: false,
};

describe('EstateStrip', () => {
  it('renders every segment from a fully-populated summary', async () => {
    getEstateSummary.mockResolvedValue(FULL);
    renderWithProviders(<EstateStrip />);

    expect(await screen.findByText('Hosts 5/6')).toBeInTheDocument();
    expect(screen.getByText('Sessions 12/48')).toBeInTheDocument();
    expect(screen.getByText('Peak')).toBeInTheDocument();
    expect(screen.getByText('2 open alerts')).toBeInTheDocument();
    expect(screen.queryByText('Override active')).not.toBeInTheDocument();
  });

  it('links each segment to its page', async () => {
    getEstateSummary.mockResolvedValue(FULL);
    renderWithProviders(<EstateStrip />);

    expect((await screen.findByText('Hosts 5/6')).closest('a')).toHaveAttribute('href', '/host-pools');
    expect(screen.getByText('Sessions 12/48').closest('a')).toHaveAttribute('href', '/sessions');
    expect(screen.getByText('Peak').closest('a')).toHaveAttribute('href', '/scaling');
    expect(screen.getByText('2 open alerts').closest('a')).toHaveAttribute('href', '/monitoring');
  });

  it('shows the override pill only when active', async () => {
    getEstateSummary.mockResolvedValue({ ...FULL, overrideActive: true });
    renderWithProviders(<EstateStrip />);
    expect(await screen.findByText('Override active')).toBeInTheDocument();
  });

  it('renders "—" for segments missing from a partially-degraded response, never a fabricated value', async () => {
    getEstateSummary.mockResolvedValue({ generatedAt: FULL.generatedAt, hostPoolName: FULL.hostPoolName });
    renderWithProviders(<EstateStrip />);

    expect(await screen.findByText('Hosts —')).toBeInTheDocument();
    expect(screen.getByText('Sessions —')).toBeInTheDocument();
    expect(screen.getByText('—')).toBeInTheDocument(); // scaling phase segment
    expect(screen.getByText('Alerts —')).toBeInTheDocument();
  });

  it('renders "—" for every segment while the summary endpoint fails, without throwing', async () => {
    getEstateSummary.mockRejectedValue(new Error('network error'));
    renderWithProviders(<EstateStrip />);
    expect(await screen.findByText('Hosts —')).toBeInTheDocument();
  });

  it('is a labeled landmark region (peer review item 12)', async () => {
    getEstateSummary.mockResolvedValue(FULL);
    renderWithProviders(<EstateStrip />);
    await screen.findByText('Hosts 5/6');
    expect(screen.getByRole('region', { name: 'Estate status' })).toBeInTheDocument();
  });

  /** Peer review (Opus, MINOR item 11): a failed poll keeps usePolling's last-good data in place — this must not silently look like a fresh, healthy "As of" reading. */
  it('surfaces a failed refresh unobtrusively on the "As of" segment, without blanking the still-good data', async () => {
    const user = userEvent.setup();
    getEstateSummary.mockResolvedValueOnce(FULL).mockRejectedValueOnce(new Error('ARM unreachable'));
    renderWithProviders(<EstateStrip />);

    await screen.findByText('Hosts 5/6');
    await user.click(screen.getByRole('button', { name: 'Refresh estate status' }));

    // The last-good segment data must still be showing (not blanked by the failed refresh).
    expect(await screen.findByText('Hosts 5/6')).toBeInTheDocument();

    const asOfText = screen.getByText(/^As of/);
    expect(asOfText).toHaveAttribute('tabindex', '0');
    await user.hover(asOfText);
    expect(await screen.findByText('Last refresh failed — showing older data.')).toBeInTheDocument();
  });

  describe('Recent actions button (AM-32)', () => {
    it('does not render when onOpenRecentActions is not supplied', async () => {
      getEstateSummary.mockResolvedValue(FULL);
      renderWithProviders(<EstateStrip />);
      await screen.findByText('Hosts 5/6');
      expect(screen.queryByRole('button', { name: 'Recent actions' })).not.toBeInTheDocument();
    });

    it('renders for an operator and calls onOpenRecentActions when clicked', async () => {
      const user = userEvent.setup();
      const onOpenRecentActions = vi.fn();
      useAuth.mockReturnValue(authState({ role: 'operator', roles: ['operator'] }));
      getEstateSummary.mockResolvedValue(FULL);
      renderWithProviders(<EstateStrip onOpenRecentActions={onOpenRecentActions} />);

      const button = await screen.findByRole('button', { name: 'Recent actions' });
      await user.click(button);
      expect(onOpenRecentActions).toHaveBeenCalledTimes(1);
    });

    it('is hidden from a viewer (RoleGate operator+)', async () => {
      useAuth.mockReturnValue(authState({ role: 'viewer', roles: ['viewer'] }));
      getEstateSummary.mockResolvedValue(FULL);
      renderWithProviders(<EstateStrip onOpenRecentActions={vi.fn()} />);

      await screen.findByText('Hosts 5/6');
      expect(screen.queryByRole('button', { name: 'Recent actions' })).not.toBeInTheDocument();
    });
  });

  describe('Incident toggle (AM-34)', () => {
    it('renders for an operator and navigates to /incident when clicked', async () => {
      const user = userEvent.setup();
      getEstateSummary.mockResolvedValue(FULL);
      renderWithProviders(<EstateStrip />);

      await screen.findByText('Hosts 5/6');
      const button = screen.getByRole('button', { name: 'Enter incident mode' });
      expect(button).toHaveAttribute('aria-pressed', 'false');
      await user.click(button);
      // react-router's MemoryRouter has no visible "current path" assertion
      // without a route to render into — the toggle's own aria-pressed flip
      // (this component re-reading useLocation()) is the observable proof
      // navigate('/incident') actually happened.
      expect(await screen.findByRole('button', { name: 'Exit incident mode' })).toHaveAttribute('aria-pressed', 'true');
    });

    it('is hidden from a viewer (RoleGate operator+)', async () => {
      useAuth.mockReturnValue(authState({ role: 'viewer', roles: ['viewer'] }));
      getEstateSummary.mockResolvedValue(FULL);
      renderWithProviders(<EstateStrip />);

      await screen.findByText('Hosts 5/6');
      expect(screen.queryByRole('button', { name: 'Enter incident mode' })).not.toBeInTheDocument();
    });

    it('shifts to a warning tone (a different class) when openAlertCount is greater than zero, vs. none open', async () => {
      // Griffel (this app's CSS-in-JS engine) generates hashed atomic class
      // names, not literal "incidentToggleWarning"-shaped strings — same
      // "compare two variants' classNames for inequality" approach
      // StatusBadge.test.tsx/Audit.test.tsx already use for their own
      // tone-driven className assertions.
      getEstateSummary.mockResolvedValueOnce({ ...FULL, openAlertCount: 0 });
      const { unmount } = renderWithProviders(<EstateStrip />);
      const calmClassName = (await screen.findByRole('button', { name: 'Enter incident mode' })).className;
      unmount();

      getEstateSummary.mockResolvedValueOnce({ ...FULL, openAlertCount: 3 });
      renderWithProviders(<EstateStrip />);
      const warningClassName = (await screen.findByRole('button', { name: 'Enter incident mode' })).className;

      expect(warningClassName).not.toBe(calmClassName);
    });
  });
});
