import { describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AlertSummary, CostSummary, HealthSummary, HostPool, ScalingPlanDetail, SessionHost } from '@avdmgr/shared';
import { renderWithProviders } from '../test/renderWithProviders';
import type { AuthState } from '../auth/AuthContext';

const getHealthSummary = vi.fn();
const getCurrentScalingPlan = vi.fn();
const getCurrentImageVersion = vi.fn();
const getRecentAlerts = vi.fn();
const getSessionHosts = vi.fn();
const getHostPools = vi.fn();
const getCostSummary = vi.fn();
const ackAlert = vi.fn();
const setSessionHostDrain = vi.fn();
const setSessionHostPower = vi.fn();
vi.mock('../api/avd', () => ({
  getHealthSummary: (...args: unknown[]) => getHealthSummary(...args),
  getCurrentScalingPlan: (...args: unknown[]) => getCurrentScalingPlan(...args),
  getCurrentImageVersion: (...args: unknown[]) => getCurrentImageVersion(...args),
  getRecentAlerts: (...args: unknown[]) => getRecentAlerts(...args),
  getSessionHosts: (...args: unknown[]) => getSessionHosts(...args),
  getHostPools: (...args: unknown[]) => getHostPools(...args),
  getCostSummary: (...args: unknown[]) => getCostSummary(...args),
  ackAlert: (...args: unknown[]) => ackAlert(...args),
  setSessionHostDrain: (...args: unknown[]) => setSessionHostDrain(...args),
  setSessionHostPower: (...args: unknown[]) => setSessionHostPower(...args),
}));

const useAuth = vi.fn<() => AuthState>();
vi.mock('../auth/useAuth', () => ({ useAuth: () => useAuth() }));

const { default: Dashboard } = await import('./Dashboard');

function authState(overrides: Partial<AuthState> = {}): AuthState {
  return { loading: false, isAuthenticated: true, userDetails: 'operator@example.com', roles: ['operator'], role: 'operator', ...overrides };
}

const HEALTH: HealthSummary = { hostPoolName: 'HP-CONTOSO-PROD', total: 2, available: 1, unavailable: 1, draining: 0, sessionsUsed: 3, sessionsMax: 16 };
const PLAN: ScalingPlanDetail = { id: 'p1', name: 'SCALE-CONTOSO-PROD', hostPoolName: 'HP-CONTOSO-PROD', timeZone: 'UTC', enabled: true, schedules: [] };
const STALE_HOST: SessionHost = {
  id: 'h1',
  name: 'avd-con-0',
  hostPoolName: 'HP-CONTOSO-PROD',
  status: 'Available',
  allowNewSession: true,
  activeSessions: 0,
  powerState: 'running',
  lastHeartBeat: new Date(Date.now() - 60 * 60_000).toISOString(),
};
const ALERT: AlertSummary = { id: '/subscriptions/s/providers/Microsoft.AlertsManagement/alerts/aaaaaaaa-0000-0000-0000-000000000001', name: 'High CPU', severity: 'Sev2', status: 'New', firedAt: new Date().toISOString() };
const COST: CostSummary = {
  currency: 'USD',
  asOfDate: '2026-08-15',
  monthToDateCost: 1200,
  priorMonthSamePeriodCost: 1000,
  projectedMonthEndCost: 2400,
  byResourceGroup: [],
  computedAt: '2026-08-15T12:00:00.000Z',
};
const HOST_POOL: HostPool = { id: '/subscriptions/s/resourceGroups/rg/providers/Microsoft.DesktopVirtualization/hostPools/HP-CONTOSO-PROD', name: 'HP-CONTOSO-PROD', resourceGroup: 'rg', hostPoolType: 'Pooled', maxSessionLimit: 16 };

function mockAllResolved() {
  getHealthSummary.mockResolvedValue(HEALTH);
  getCurrentScalingPlan.mockResolvedValue(PLAN);
  getCurrentImageVersion.mockResolvedValue({ id: 'v1', name: '2.0.0', imageDefinitionName: 'def', excludeFromLatest: false, ageDays: 10, daysUntilEol: 300 });
  getRecentAlerts.mockResolvedValue([ALERT]);
  getSessionHosts.mockResolvedValue([STALE_HOST]);
  getHostPools.mockResolvedValue([HOST_POOL]);
  getCostSummary.mockResolvedValue(COST);
}

describe('Dashboard — entry points (AM-29 item 10/F)', () => {
  it('renders footer links to Host Pool, Scaling, Cost, Images, and Monitoring', async () => {
    mockAllResolved();
    useAuth.mockReturnValue(authState());
    renderWithProviders(<Dashboard />);

    expect((await screen.findByText('View host pool →')).closest('a')).toHaveAttribute('href', '/host-pools');
    // AM-31 item 32b: Cost & Scaling split into two pages/nav items — the Dashboard's "Scaling phase" tile links to /scaling, its "Cost" tile links to /cost.
    expect(screen.getByText('View scaling →').closest('a')).toHaveAttribute('href', '/scaling');
    expect(screen.getByText('View cost →').closest('a')).toHaveAttribute('href', '/cost');
    expect(screen.getByText('View images →').closest('a')).toHaveAttribute('href', '/images');
    expect(screen.getByText('View all →').closest('a')).toHaveAttribute('href', '/monitoring');
  });

  it('renders a SessionHostCard for the host at 6 or fewer hosts (AM-31 item 33)', async () => {
    mockAllResolved();
    useAuth.mockReturnValue(authState());
    renderWithProviders(<Dashboard />);

    expect(await screen.findByText('avd-con-0')).toBeInTheDocument();
    expect(screen.getByText('Available')).toBeInTheDocument();
  });

  it('drains a host from its Dashboard SessionHostCard (AM-31 item 33)', async () => {
    const user = userEvent.setup();
    mockAllResolved();
    setSessionHostDrain.mockResolvedValue({ sessionHost: STALE_HOST });
    useAuth.mockReturnValue(authState());
    renderWithProviders(<Dashboard />);

    await user.click(await screen.findByLabelText('Accepting sessions'));
    await user.click(await screen.findByRole('button', { name: /^drain$/i }));

    expect(setSessionHostDrain).toHaveBeenCalledWith('HP-CONTOSO-PROD', 'avd-con-0', { allowNewSession: false, reason: undefined });
  });

  it('links a stale heartbeat row to the Host Pool page in the fallback table (>6 hosts)', async () => {
    getHealthSummary.mockResolvedValue(HEALTH);
    getCurrentScalingPlan.mockResolvedValue(PLAN);
    getCurrentImageVersion.mockResolvedValue({ id: 'v1', name: '2.0.0', imageDefinitionName: 'def', excludeFromLatest: false, ageDays: 10, daysUntilEol: 300 });
    getRecentAlerts.mockResolvedValue([ALERT]);
    // AM-31 item 33: 7 hosts forces the pre-existing table fallback (>6 = CARD_GRID_MAX_HOSTS) instead of the SessionHostCard grid, which has no such link.
    getSessionHosts.mockResolvedValue([STALE_HOST, ...Array.from({ length: 6 }, (_, i) => ({ ...STALE_HOST, id: `h${i + 2}`, name: `avd-con-${i + 1}`, lastHeartBeat: new Date().toISOString() }))]);
    getHostPools.mockResolvedValue([HOST_POOL]);
    getCostSummary.mockResolvedValue(COST);
    useAuth.mockReturnValue(authState());
    renderWithProviders(<Dashboard />);

    const hostLink = await screen.findByRole('link', { name: 'avd-con-0' });
    expect(hostLink).toHaveAttribute('href', '/host-pools');
  });
});

describe('Dashboard — inline alert ack (AM-29 item F/D, peer review item 1)', () => {
  it('shows an Ack button for operator+ that opens a lightweight confirm modal, and acknowledges on confirm', async () => {
    const user = userEvent.setup();
    mockAllResolved();
    ackAlert.mockResolvedValue(undefined);
    useAuth.mockReturnValue(authState({ role: 'operator', roles: ['operator'] }));
    renderWithProviders(<Dashboard />);

    const ackButton = await screen.findByRole('button', { name: 'Ack' });
    await user.click(ackButton);

    const confirmButton = await screen.findByRole('button', { name: /^acknowledge$/i });
    await user.click(confirmButton);

    expect(ackAlert).toHaveBeenCalledWith(ALERT.id, { reason: undefined });
  });

  it('passes an optional reason through to ackAlert when one is entered', async () => {
    const user = userEvent.setup();
    mockAllResolved();
    ackAlert.mockResolvedValue(undefined);
    useAuth.mockReturnValue(authState({ role: 'operator', roles: ['operator'] }));
    renderWithProviders(<Dashboard />);

    await user.click(await screen.findByRole('button', { name: 'Ack' }));
    await user.type(screen.getByPlaceholderText('Why is this needed?'), 'False positive');
    await user.click(screen.getByRole('button', { name: /^acknowledge$/i }));

    expect(ackAlert).toHaveBeenCalledWith(ALERT.id, { reason: 'False positive' });
  });

  it('hides the Ack button for a viewer', async () => {
    mockAllResolved();
    useAuth.mockReturnValue(authState({ role: 'viewer', roles: ['viewer'] }));
    renderWithProviders(<Dashboard />);

    await screen.findByText('High CPU');
    expect(screen.queryByRole('button', { name: 'Ack' })).not.toBeInTheDocument();
  });
});

describe('Dashboard — cost tile (AM-29 item 21)', () => {
  it('shows month-to-date cost, projection, and a delta badge', async () => {
    mockAllResolved();
    useAuth.mockReturnValue(authState());
    renderWithProviders(<Dashboard />);

    expect(await screen.findByText('$1,200.00')).toBeInTheDocument();
    expect(screen.getByText(/Projected month end/)).toBeInTheDocument();
    expect(screen.getByText('+20% vs prior period')).toBeInTheDocument();
  });

  it('degrades gracefully when the cost API fails, without affecting other tiles', async () => {
    getHealthSummary.mockResolvedValue(HEALTH);
    getCurrentScalingPlan.mockResolvedValue(PLAN);
    getCurrentImageVersion.mockResolvedValue({ id: 'v1', name: '2.0.0', imageDefinitionName: 'def', excludeFromLatest: false });
    getRecentAlerts.mockResolvedValue([]);
    getSessionHosts.mockResolvedValue([]);
    getHostPools.mockResolvedValue([HOST_POOL]);
    getCostSummary.mockRejectedValue(new Error('Cost Management unavailable'));
    useAuth.mockReturnValue(authState());
    renderWithProviders(<Dashboard />);

    expect(await screen.findByText("Couldn't load this data")).toBeInTheDocument();
    // The rest of the page still renders — e.g. The session hosts section (AM-31 item 33).
    expect(screen.getByText('Session hosts — HP-CONTOSO-PROD')).toBeInTheDocument();
  });
});

describe('Dashboard — PageHeader (AM-29 item A)', () => {
  it('renders the page title as an h1 and sets document.title', async () => {
    mockAllResolved();
    useAuth.mockReturnValue(authState());
    renderWithProviders(<Dashboard />);
    expect(screen.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeInTheDocument();
    expect(document.title).toBe('AVD Manager — Dashboard');
  });
});
