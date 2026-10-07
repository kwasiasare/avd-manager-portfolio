import { describe, expect, it, vi, beforeEach } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AlertSummary, AlertsFeedResponse } from '@avdmgr/shared';
import { renderWithProviders } from '../test/renderWithProviders';
import type { AuthState } from '../auth/AuthContext';

const getAlerts = vi.fn();
const getLogsViews = vi.fn();
const ackAlert = vi.fn();
const snoozeAlert = vi.fn();
vi.mock('../api/avd', () => ({
  getAlerts: (...args: unknown[]) => getAlerts(...args),
  getLogsViews: (...args: unknown[]) => getLogsViews(...args),
  runLogsView: vi.fn(),
  runRawKql: vi.fn(),
  ackAlert: (...args: unknown[]) => ackAlert(...args),
  snoozeAlert: (...args: unknown[]) => snoozeAlert(...args),
  unackAlert: vi.fn(),
  unsnoozeAlert: vi.fn(),
}));

const useAuth = vi.fn<() => AuthState>();
vi.mock('../auth/useAuth', () => ({ useAuth: () => useAuth() }));

const { default: Monitoring } = await import('./Monitoring');

const ALERT: AlertSummary = {
  id: '/subscriptions/s/providers/Microsoft.AlertsManagement/alerts/aaaaaaaa-0000-0000-0000-000000000001',
  name: 'High CPU',
  severity: 'Sev2',
  status: 'New',
  firedAt: new Date().toISOString(),
};

const FEED: AlertsFeedResponse = { alerts: [ALERT], degraded: false };

beforeEach(() => {
  useAuth.mockReturnValue({ loading: false, isAuthenticated: true, userDetails: 'operator@contoso.example', roles: ['operator'], role: 'operator' });
  getAlerts.mockReset().mockResolvedValue(FEED);
  getLogsViews.mockReset().mockResolvedValue([]);
});

describe('Monitoring — alert row overflow menu (AM-31 item 40)', () => {
  it('keeps Ack inline and moves Snooze into a per-row overflow menu', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Monitoring />);
    // The alert name renders twice — once as the visible cell text, once as the Tooltip's (initially hidden) content div — findAllByText's first match is the visible cell.
    const row = (await screen.findAllByText('High CPU'))[0].closest('tr')!;

    expect(within(row).getByRole('button', { name: 'Ack' })).toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: 'Snooze' })).not.toBeInTheDocument();

    await user.click(within(row).getByRole('button', { name: /more actions for high cpu/i }));
    expect(await screen.findByRole('menuitem', { name: 'Snooze' })).toBeInTheDocument();
  });

  it('opens the snooze dialog from the overflow menu and submits it', async () => {
    const user = userEvent.setup();
    snoozeAlert.mockResolvedValue(undefined);
    renderWithProviders(<Monitoring />);
    // The alert name renders twice — once as the visible cell text, once as the Tooltip's (initially hidden) content div — findAllByText's first match is the visible cell.
    const row = (await screen.findAllByText('High CPU'))[0].closest('tr')!;

    await user.click(within(row).getByRole('button', { name: /more actions for high cpu/i }));
    await user.click(await screen.findByRole('menuitem', { name: 'Snooze' }));

    await user.click(screen.getByRole('button', { name: /^snooze$/i }));
    expect(snoozeAlert).toHaveBeenCalledWith(ALERT.id, { hours: 24, reason: undefined });
  });
});

describe('Monitoring — App state cell (Opus peer review MAJOR 1)', () => {
  it('renders BOTH the Acked and Snoozed badges independently when an alert is acked AND (separately) snoozed', async () => {
    const user = userEvent.setup();
    // Acked and snoozed are independent, app-level, server-side states (see
    // AlertSummary's own doc comment) — an alert can carry BOTH at once,
    // and the snoozed badge is the only place its expiry is surfaced. An
    // if/else here (as this cell briefly had post-AM-35's DataTable
    // migration) silently dropped the snoozed badge whenever an alert was
    // also acked.
    const bothStatesAlert: AlertSummary = {
      ...ALERT,
      ackedBy: 'operator@contoso.example',
      ackedAt: new Date('2026-08-17T08:00:00.000Z').toISOString(),
      snoozedUntil: new Date('2026-08-17T12:00:00.000Z').toISOString(),
      snoozedBy: 'admin@contoso.example',
    };
    getAlerts.mockResolvedValue({ alerts: [bothStatesAlert], degraded: false });
    renderWithProviders(<Monitoring />);

    // "Hide snoozed" defaults ON — turn it off so this snoozed alert's row actually renders.
    await user.click(await screen.findByRole('switch', { name: 'Hide snoozed' }));

    const row = (await screen.findAllByText('High CPU'))[0].closest('tr')!;
    expect(within(row).getByText('Acked by operator@contoso.example')).toBeInTheDocument();
    expect(within(row).getByText(/^Snoozed until/)).toBeInTheDocument();
  });

  it('renders only the Acked badge (no Snoozed badge, no dash) when acked but not snoozed', async () => {
    const ackedOnly: AlertSummary = { ...ALERT, ackedBy: 'operator@contoso.example', ackedAt: new Date().toISOString() };
    getAlerts.mockResolvedValue({ alerts: [ackedOnly], degraded: false });
    renderWithProviders(<Monitoring />);

    const row = (await screen.findAllByText('High CPU'))[0].closest('tr')!;
    expect(within(row).getByText('Acked by operator@contoso.example')).toBeInTheDocument();
    expect(within(row).queryByText(/^Snoozed until/)).not.toBeInTheDocument();
  });

  it('renders only the Snoozed badge (no Acked badge) when snoozed but not acked', async () => {
    const user = userEvent.setup();
    const snoozedOnly: AlertSummary = { ...ALERT, snoozedUntil: new Date('2026-08-17T12:00:00.000Z').toISOString(), snoozedBy: 'admin@contoso.example' };
    getAlerts.mockResolvedValue({ alerts: [snoozedOnly], degraded: false });
    renderWithProviders(<Monitoring />);

    await user.click(await screen.findByRole('switch', { name: 'Hide snoozed' }));

    const row = (await screen.findAllByText('High CPU'))[0].closest('tr')!;
    expect(within(row).getByText(/^Snoozed until/)).toBeInTheDocument();
    expect(within(row).queryByText(/^Acked by/)).not.toBeInTheDocument();
  });

  it('renders a dash in the App state column when neither acked nor snoozed', async () => {
    renderWithProviders(<Monitoring />);
    const row = (await screen.findAllByText('High CPU'))[0].closest('tr')!;
    // The row's LAST "—" cell is App state — Target resource (an earlier cell) is also unset on the fixture ALERT and renders its own "—", so this asserts there are exactly the two expected dashes rather than picking one ambiguously.
    const dashCells = within(row).getAllByText('—');
    expect(dashCells).toHaveLength(2);
  });
});
