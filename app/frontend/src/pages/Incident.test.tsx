import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AlertsFeedResponse, AlertSummary, AuditEntryDto, AuditRecentResponse, SessionHost, UserSession } from '@avdmgr/shared';
import { renderWithProviders } from '../test/renderWithProviders';
import type { AuthState } from '../auth/AuthContext';
import { HOST_POOL_NAME } from '../lib/config';

const getSessionHosts = vi.fn();
const getSessions = vi.fn();
const getAlerts = vi.fn();
const getRecentAuditEntries = vi.fn();
const ackAlert = vi.fn();
const snoozeAlert = vi.fn();
const setSessionHostDrain = vi.fn();
const setSessionHostPower = vi.fn();
const forceLogoffSession = vi.fn();
const sendSessionMessage = vi.fn();

vi.mock('../api/avd', () => ({
  getSessionHosts: (...args: unknown[]) => getSessionHosts(...args),
  getSessions: (...args: unknown[]) => getSessions(...args),
  getAlerts: (...args: unknown[]) => getAlerts(...args),
  getRecentAuditEntries: (...args: unknown[]) => getRecentAuditEntries(...args),
  ackAlert: (...args: unknown[]) => ackAlert(...args),
  snoozeAlert: (...args: unknown[]) => snoozeAlert(...args),
  setSessionHostDrain: (...args: unknown[]) => setSessionHostDrain(...args),
  setSessionHostPower: (...args: unknown[]) => setSessionHostPower(...args),
  forceLogoffSession: (...args: unknown[]) => forceLogoffSession(...args),
  sendSessionMessage: (...args: unknown[]) => sendSessionMessage(...args),
}));

const useAuth = vi.fn<() => AuthState>();
vi.mock('../auth/useAuth', () => ({ useAuth: () => useAuth() }));

function authState(overrides: Partial<AuthState> = {}): AuthState {
  return { loading: false, isAuthenticated: true, userDetails: 'operator@contoso.example', roles: ['operator'], role: 'operator', ...overrides };
}

const { default: Incident } = await import('./Incident');

const HEALTHY_HOST: SessionHost = {
  id: 'host-1',
  name: 'avd-con-0',
  hostPoolName: 'HP-CONTOSO-PROD',
  status: 'Available',
  allowNewSession: true,
  activeSessions: 1,
  agentVersion: '1.0.0',
  lastHeartBeat: new Date().toISOString(),
  powerState: 'running',
};

const SICK_HOST: SessionHost = {
  id: 'host-2',
  name: 'avd-con-1',
  hostPoolName: 'HP-CONTOSO-PROD',
  status: 'NoHeartbeat',
  allowNewSession: true,
  activeSessions: 2,
  agentVersion: '1.0.0',
  lastHeartBeat: new Date().toISOString(),
  powerState: 'running',
};

const SESSION_ON_SICK_HOST: UserSession = {
  id: 'sess-1',
  sessionId: '1',
  userPrincipalName: 'jdoe@contoso.example',
  sessionHostName: SICK_HOST.name,
  hostPoolName: 'HP-CONTOSO-PROD',
  sessionState: 'Active',
  createTime: new Date().toISOString(),
};

// AM-34 peer review (Opus, MINOR 8) — a session on the HEALTHY host, to
// prove it's excluded from "Sessions on affected hosts" (that list is
// derived from the affected-hosts set, not from every session in the pool).
const SESSION_ON_HEALTHY_HOST: UserSession = {
  id: 'sess-2',
  sessionId: '2',
  userPrincipalName: 'healthy-user@contoso.example',
  sessionHostName: HEALTHY_HOST.name,
  hostPoolName: 'HP-CONTOSO-PROD',
  sessionState: 'Active',
  createTime: new Date().toISOString(),
};

const ALERT: AlertSummary = {
  id: '/subscriptions/s/providers/Microsoft.AlertsManagement/alerts/aaaaaaaa-0000-0000-0000-000000000001',
  name: 'High CPU',
  severity: 'Sev2',
  status: 'New',
  firedAt: new Date().toISOString(),
};

const ALERTS_FEED: AlertsFeedResponse = { alerts: [ALERT], degraded: false };

const AUDIT_ENTRY: AuditEntryDto = {
  id: 'pk/rk-1',
  occurredAt: new Date().toISOString(),
  actor: 'operator@contoso.example',
  action: 'sessionhost.drain',
  target: SICK_HOST.name,
  outcome: 'success',
  correlationId: 'corr-1',
  hasParameters: false,
};

const AUDIT_RESPONSE: AuditRecentResponse = { entries: [AUDIT_ENTRY], truncated: false, partial: false, sinceHours: 24 };

beforeEach(() => {
  useAuth.mockReturnValue(authState());
  getSessionHosts.mockReset().mockResolvedValue([HEALTHY_HOST, SICK_HOST]);
  getSessions.mockReset().mockResolvedValue([SESSION_ON_SICK_HOST, SESSION_ON_HEALTHY_HOST]);
  getAlerts.mockReset().mockResolvedValue(ALERTS_FEED);
  getRecentAuditEntries.mockReset().mockResolvedValue(AUDIT_RESPONSE);
  ackAlert.mockReset().mockResolvedValue(undefined);
  snoozeAlert.mockReset().mockResolvedValue(undefined);
  setSessionHostDrain.mockReset().mockResolvedValue({ sessionHost: { ...SICK_HOST, allowNewSession: false } });
  setSessionHostPower.mockReset();
  forceLogoffSession.mockReset().mockResolvedValue({ sessionId: SESSION_ON_SICK_HOST.sessionId });
  sendSessionMessage.mockReset();
});

describe('Incident page (AM-34)', () => {
  it('an operator sees all four sections', async () => {
    renderWithProviders(<Incident />);

    expect(await screen.findByRole('heading', { name: 'Affected hosts' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Sessions on affected hosts' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Open alerts' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Action log' })).toBeInTheDocument();

    // Affected hosts: only the unhealthy host, not the healthy one. Queried
    // by the SessionHostCard's own group role/label (not plain text) since
    // the sick host's name ALSO appears in the "Sessions on affected hosts"
    // table's Host column below — plain getByText would match both.
    expect(await screen.findByRole('group', { name: `Session host ${SICK_HOST.name}` })).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: `Session host ${HEALTHY_HOST.name}` })).not.toBeInTheDocument();

    // Sessions on affected hosts.
    expect(await screen.findByText(SESSION_ON_SICK_HOST.userPrincipalName)).toBeInTheDocument();

    // Open alerts.
    expect(await screen.findByText('High CPU')).toBeInTheDocument();

    // Action log.
    expect(await screen.findByText(/sessionhost\.drain/)).toBeInTheDocument();
  });

  it('a viewer sees the gate fallback and triggers zero fetches', async () => {
    useAuth.mockReturnValue(authState({ role: 'viewer', roles: ['viewer'] }));
    renderWithProviders(<Incident />);

    expect(await screen.findByText(/incident mode requires the operator or admin role/i)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Affected hosts' })).not.toBeInTheDocument();

    expect(getSessionHosts).not.toHaveBeenCalled();
    expect(getSessions).not.toHaveBeenCalled();
    expect(getAlerts).not.toHaveBeenCalled();
    expect(getRecentAuditEntries).not.toHaveBeenCalled();
  });

  it('ack fires the existing ackAlert handler', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Incident />);

    const alertRow = (await screen.findByText('High CPU')).closest('li')!;
    await user.click(within(alertRow).getByRole('button', { name: 'Ack' }));

    await user.click(await screen.findByRole('button', { name: 'Acknowledge' }));
    expect(ackAlert).toHaveBeenCalledWith(ALERT.id, { reason: undefined });
  });

  it('renders audit entries in the action log', async () => {
    renderWithProviders(<Incident />);

    const entryRow = (await screen.findByText(/sessionhost\.drain/)).closest('li')!;
    expect(within(entryRow).getByText('operator')).toBeInTheDocument();
    expect(within(entryRow).getByText('success')).toBeInTheDocument();
  });

  it('shows the calm "no affected hosts" note and all hosts when every host is healthy', async () => {
    getSessionHosts.mockResolvedValue([HEALTHY_HOST]);
    renderWithProviders(<Incident />);

    expect(await screen.findByText(/no affected hosts — showing all/i)).toBeInTheDocument();
    // Queried by group role/label, not plain text — the healthy host's name
    // also appears in the "Sessions on affected hosts" table's Host column
    // once it's the only (therefore "affected" via the allHealthy fallback)
    // host, so plain getByText would match twice.
    expect(screen.getByRole('group', { name: `Session host ${HEALTHY_HOST.name}` })).toBeInTheDocument();
  });

  it('has an "Exit incident mode" action that navigates back to the Dashboard', async () => {
    renderWithProviders(<Incident />);
    expect(await screen.findByRole('button', { name: 'Exit incident mode' })).toBeInTheDocument();
  });

  // AM-34 peer review (Opus, MINOR 8)
  it('excludes a session on the HEALTHY host from "Sessions on affected hosts"', async () => {
    renderWithProviders(<Incident />);

    expect(await screen.findByText(SESSION_ON_SICK_HOST.userPrincipalName)).toBeInTheDocument();
    expect(screen.queryByText(SESSION_ON_HEALTHY_HOST.userPrincipalName)).not.toBeInTheDocument();
  });

  // AM-34 peer review (Opus, MINOR 7) — mirrors HostPool.tsx's/Dashboard.tsx's
  // own confirmDrainToggle call shape exactly (same setSessionHostDrain
  // wrapper, same argument shape: hostPoolName, hostName, { allowNewSession,
  // reason }).
  it('drain calls setSessionHostDrain with the exact shape HostPool.tsx/Dashboard.tsx use', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Incident />);

    const hostCard = await screen.findByRole('group', { name: `Session host ${SICK_HOST.name}` });
    await user.click(within(hostCard).getByRole('switch', { name: 'Accepting sessions' }));

    const confirmButton = await screen.findByRole('button', { name: 'Drain' });
    await user.click(confirmButton);

    expect(setSessionHostDrain).toHaveBeenCalledWith(HOST_POOL_NAME, SICK_HOST.name, { allowNewSession: false, reason: undefined });
  });

  // AM-34 peer review (Opus, MINOR 7) — mirrors Sessions.tsx's own
  // confirmLogoff call shape exactly, and (per the same review item) also
  // asserts the ImpactPreview panel's content on this destructive confirm —
  // same "What this will do" heading + exact line text as
  // Sessions.test.tsx's own AM-33 integration coverage for the identical
  // action.
  describe('force logoff', () => {
    async function openForceLogoffDialog(user: ReturnType<typeof userEvent.setup>) {
      const sessionRow = (await screen.findByText(SESSION_ON_SICK_HOST.userPrincipalName)).closest('tr')!;
      await user.click(within(sessionRow).getByRole('button', { name: /more actions for jdoe@contoso.example/i }));
      await user.click(await screen.findByRole('menuitem', { name: 'Force logoff' }));
    }

    it('renders the ImpactPreview panel above the confirm gate, naming the target session', async () => {
      const user = userEvent.setup();
      renderWithProviders(<Incident />);
      await openForceLogoffDialog(user);

      expect(await screen.findByText(`Force ${SESSION_ON_SICK_HOST.userPrincipalName} to log off?`)).toBeInTheDocument();
      expect(screen.getByText('What this will do')).toBeInTheDocument();
      expect(screen.getByText(`Ends ${SESSION_ON_SICK_HOST.userPrincipalName}'s Active session on ${SESSION_ON_SICK_HOST.sessionHostName}. Unsaved work may be lost.`)).toBeInTheDocument();
    });

    it('calls forceLogoffSession with the exact shape Sessions.tsx uses', async () => {
      const user = userEvent.setup();
      renderWithProviders(<Incident />);
      await openForceLogoffDialog(user);

      await user.type(screen.getByPlaceholderText('Why is this needed?'), 'Stuck session, user confirmed offline');
      await user.click(screen.getByRole('button', { name: 'Force logoff' }));

      expect(forceLogoffSession).toHaveBeenCalledWith(HOST_POOL_NAME, SESSION_ON_SICK_HOST.sessionHostName, SESSION_ON_SICK_HOST.sessionId, {
        reason: 'Stuck session, user confirmed offline',
        userPrincipalName: SESSION_ON_SICK_HOST.userPrincipalName,
      });
    });
  });

  // AM-34 peer review (Opus, MINOR 10) — pins the three DIFFERENT poll
  // cadences this page's own spec calls for (hosts/sessions 20s, alerts
  // 30s, audit 60s) against each other, not just against a shared default.
  describe('poll cadences', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('polls hosts/sessions every 20s, alerts every 30s, and audit every 60s', async () => {
      vi.useFakeTimers();
      renderWithProviders(<Incident />);

      // Initial fetch, synchronously triggered by usePolling's mount effect.
      expect(getSessionHosts).toHaveBeenCalledTimes(1);
      expect(getSessions).toHaveBeenCalledTimes(1);
      expect(getAlerts).toHaveBeenCalledTimes(1);
      expect(getRecentAuditEntries).toHaveBeenCalledTimes(1);

      // +20s: only the hosts/sessions pollers have ticked again.
      await vi.advanceTimersByTimeAsync(20_000);
      expect(getSessionHosts).toHaveBeenCalledTimes(2);
      expect(getSessions).toHaveBeenCalledTimes(2);
      expect(getAlerts).toHaveBeenCalledTimes(1);
      expect(getRecentAuditEntries).toHaveBeenCalledTimes(1);

      // +10s (30s total): the alerts poller has now ticked once; audit has not.
      await vi.advanceTimersByTimeAsync(10_000);
      expect(getAlerts).toHaveBeenCalledTimes(2);
      expect(getRecentAuditEntries).toHaveBeenCalledTimes(1);

      // +30s (60s total): the audit poller has now ticked once.
      await vi.advanceTimersByTimeAsync(30_000);
      expect(getRecentAuditEntries).toHaveBeenCalledTimes(2);
    });
  });
});
