import { describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AuditRecentResponse } from '@avdmgr/shared';
import { renderWithProviders } from '../test/renderWithProviders';

const getRecentAuditEntries = vi.fn();
vi.mock('../api/avd', () => ({
  getRecentAuditEntries: (...args: unknown[]) => getRecentAuditEntries(...args),
}));

const { default: RecentActionsDrawer } = await import('./RecentActionsDrawer');

const FIXTURE: AuditRecentResponse = {
  entries: [
    {
      id: '2026-08-16/0000000000001-aaaaaaaa',
      occurredAt: new Date().toISOString(),
      actor: 'operator@example.com',
      action: 'sessionhost.drain',
      target: 'HP-CONTOSO-PROD/avd-con-0',
      reason: 'scheduled maintenance',
      outcome: 'success',
      correlationId: 'corr-1',
      hasParameters: true,
    },
    {
      id: '2026-08-16/0000000000002-bbbbbbbb',
      occurredAt: new Date().toISOString(),
      actor: 'admin@example.com',
      action: 'access.assignment.remove',
      target: 'HP-CONTOSO-PROD-DAG',
      outcome: 'failure',
      correlationId: 'corr-2',
      hasParameters: false,
    },
  ],
  truncated: false,
  partial: false,
  sinceHours: 24,
};

describe('RecentActionsDrawer (AM-32)', () => {
  it('fetches on mount (load-on-open) with top=25/sinceHours=24 and no filters', () => {
    getRecentAuditEntries.mockReturnValue(new Promise(() => {}));
    renderWithProviders(<RecentActionsDrawer onClose={vi.fn()} />);
    expect(getRecentAuditEntries).toHaveBeenCalledWith({ top: 25, sinceHours: 24 }, expect.anything());
  });

  it('renders each entry with relative time, short actor, action, target, an outcome badge, and reason as secondary text', async () => {
    getRecentAuditEntries.mockResolvedValue(FIXTURE);
    renderWithProviders(<RecentActionsDrawer onClose={vi.fn()} />);

    expect(await screen.findByText('sessionhost.drain')).toBeInTheDocument();
    expect(screen.getByText('HP-CONTOSO-PROD/avd-con-0')).toBeInTheDocument();
    // Short actor — local-part only, not the full email (full value is on the Tooltip).
    expect(screen.getByText('operator')).toBeInTheDocument();
    expect(screen.queryByText('operator@example.com')).not.toBeInTheDocument();
    expect(screen.getByText('scheduled maintenance')).toBeInTheDocument();
    expect(screen.getByText('success')).toBeInTheDocument();
    expect(screen.getByText('failure')).toBeInTheDocument();
  });

  it('AM-32 peer review MAJOR 1 — keys each row on the unique `id` (partitionKey/rowKey), not the non-unique correlationId', async () => {
    getRecentAuditEntries.mockResolvedValue({
      entries: [
        { ...FIXTURE.entries[0], id: 'row-a', correlationId: 'shared-corr' },
        { ...FIXTURE.entries[1], id: 'row-b', correlationId: 'shared-corr' },
      ],
      truncated: false,
      partial: false,
      sinceHours: 24,
    });
    renderWithProviders(<RecentActionsDrawer onClose={vi.fn()} />);
    // Both rows render distinctly (React wouldn't warn about a duplicate
    // key OR silently drop one if it were keyed on correlationId here) —
    // asserting both actions show up is the externally-observable proxy
    // for "both list items actually mounted".
    expect(await screen.findByText('sessionhost.drain')).toBeInTheDocument();
    expect(screen.getByText('access.assignment.remove')).toBeInTheDocument();
  });

  it('shows the "showing last Nh" caption from the response', async () => {
    getRecentAuditEntries.mockResolvedValue(FIXTURE);
    renderWithProviders(<RecentActionsDrawer onClose={vi.fn()} />);
    expect(await screen.findByText('Showing last 24h')).toBeInTheDocument();
  });

  it('shows a truncated caveat only when the response reports truncated:true', async () => {
    getRecentAuditEntries.mockResolvedValue({ ...FIXTURE, truncated: true });
    renderWithProviders(<RecentActionsDrawer onClose={vi.fn()} />);
    expect(await screen.findByText(/more actions may exist/i)).toBeInTheDocument();
  });

  it('shows no truncated caveat when truncated:false', async () => {
    getRecentAuditEntries.mockResolvedValue(FIXTURE);
    renderWithProviders(<RecentActionsDrawer onClose={vi.fn()} />);
    await screen.findByText('sessionhost.drain');
    expect(screen.queryByText(/more actions may exist/i)).not.toBeInTheDocument();
  });

  it('AM-32 peer review MAJOR 3 — shows the "query failed partway" caveat (not the plain truncated one) when partial:true', async () => {
    getRecentAuditEntries.mockResolvedValue({ ...FIXTURE, truncated: true, partial: true });
    renderWithProviders(<RecentActionsDrawer onClose={vi.fn()} />);
    expect(await screen.findByText(/audit query failed partway/i)).toBeInTheDocument();
    expect(screen.queryByText(/more actions may exist/i)).not.toBeInTheDocument();
  });

  it('shows an empty-state message when there are no recent actions', async () => {
    getRecentAuditEntries.mockResolvedValue({ entries: [], truncated: false, partial: false, sinceHours: 24 });
    renderWithProviders(<RecentActionsDrawer onClose={vi.fn()} />);
    expect(await screen.findByText('No actions recorded in this window.')).toBeInTheDocument();
  });

  it('refresh button re-fetches, and is disabled while `refreshing` (AM-32 peer review MINOR 5)', async () => {
    const user = userEvent.setup();
    let resolveSecond: (value: AuditRecentResponse) => void = () => {};
    getRecentAuditEntries.mockResolvedValueOnce(FIXTURE).mockImplementationOnce(() => new Promise<AuditRecentResponse>((resolve) => (resolveSecond = resolve)));
    renderWithProviders(<RecentActionsDrawer onClose={vi.fn()} />);
    await screen.findByText('sessionhost.drain');

    const refreshButton = screen.getByRole('button', { name: 'Refresh recent actions' });
    expect(refreshButton).not.toBeDisabled();

    await user.click(refreshButton);
    expect(getRecentAuditEntries).toHaveBeenCalledWith({ top: 25, sinceHours: 24 }, expect.anything());
    expect(refreshButton).toBeDisabled();

    resolveSecond(FIXTURE);
    await vi.waitFor(() => expect(refreshButton).not.toBeDisabled());
  });

  it('calls onClose when the header close button is clicked', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    getRecentAuditEntries.mockResolvedValue(FIXTURE);
    renderWithProviders(<RecentActionsDrawer onClose={onClose} />);
    await screen.findByText('sessionhost.drain');
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('labels the drawer "Recent actions"', async () => {
    getRecentAuditEntries.mockResolvedValue(FIXTURE);
    renderWithProviders(<RecentActionsDrawer onClose={vi.fn()} />);
    expect(await screen.findByRole('heading', { name: 'Recent actions' })).toBeInTheDocument();
  });

  it('AM-32 peer review MINOR 10 — shows a "has parameters" affordance only for entries that carry one', async () => {
    getRecentAuditEntries.mockResolvedValue(FIXTURE);
    renderWithProviders(<RecentActionsDrawer onClose={vi.fn()} />);
    await screen.findByText('sessionhost.drain');
    // Only ONE of the two fixture entries has hasParameters:true.
    expect(screen.getAllByText('· has parameters')).toHaveLength(1);
  });

  it('AM-32 peer review MINOR 13 — renders an "accepted" outcome badge with a DIFFERENT tone/class than "success" (never treated as an unqualified "ok")', async () => {
    getRecentAuditEntries.mockResolvedValue({
      entries: [
        { ...FIXTURE.entries[0], id: 'row-success', outcome: 'success' },
        { ...FIXTURE.entries[1], id: 'row-accepted', outcome: 'accepted', target: 'HP-CONTOSO-PROD/avd-con-1' },
      ],
      truncated: false,
      partial: false,
      sinceHours: 24,
    });
    renderWithProviders(<RecentActionsDrawer onClose={vi.fn()} />);
    const successBadge = await screen.findByText('success');
    const acceptedBadge = screen.getByText('accepted');
    // Same technique StatusBadge.test.tsx itself uses to prove two tones
    // differ (Fluent's Badge has no simple `color` DOM attribute to assert
    // on directly — its resolved className is the observable signal).
    expect(successBadge.className).not.toBe(acceptedBadge.className);
  });

  it('AM-32 peer review MINOR 15 — the actor tooltip trigger is keyboard-focusable (tabIndex 0)', async () => {
    getRecentAuditEntries.mockResolvedValue(FIXTURE);
    renderWithProviders(<RecentActionsDrawer onClose={vi.fn()} />);
    const actorText = await screen.findByText('operator');
    expect(actorText).toHaveAttribute('tabindex', '0');
  });
});
