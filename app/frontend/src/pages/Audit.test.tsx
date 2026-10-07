import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AuditRecentResponse } from '@avdmgr/shared';
import { renderWithProviders } from '../test/renderWithProviders';
import type { AuthState } from '../auth/AuthContext';

const getRecentAuditEntries = vi.fn();
vi.mock('../api/avd', () => ({
  getRecentAuditEntries: (...args: unknown[]) => getRecentAuditEntries(...args),
}));

const useAuth = vi.fn<() => AuthState>();
vi.mock('../auth/useAuth', () => ({ useAuth: () => useAuth() }));

function authState(overrides: Partial<AuthState> = {}): AuthState {
  return { loading: false, isAuthenticated: true, userDetails: 'operator@example.com', roles: ['operator'], role: 'operator', ...overrides };
}

const { default: Audit } = await import('./Audit');

const FIXTURE: AuditRecentResponse = {
  entries: [
    {
      id: '2026-08-16/0000000000001-aaaaaaaa',
      occurredAt: '2026-08-16T12:00:00.000Z',
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
      occurredAt: '2026-08-16T11:00:00.000Z',
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

beforeEach(() => {
  getRecentAuditEntries.mockReset().mockResolvedValue(FIXTURE);
  useAuth.mockReturnValue(authState());
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Audit page (AM-32)', () => {
  it('renders the resolved table once GET /v1/audit/recent resolves', async () => {
    renderWithProviders(<Audit />);
    expect(await screen.findByText('sessionhost.drain')).toBeInTheDocument();
    expect(screen.getByText('HP-CONTOSO-PROD/avd-con-0')).toBeInTheDocument();
    expect(screen.getByText('success')).toBeInTheDocument();
    expect(screen.getByText('failure')).toBeInTheDocument();
  });

  it('AM-32 peer review MAJOR 1 — keys rows on the unique `id`, not correlationId (both rows sharing a correlationId still both render)', async () => {
    getRecentAuditEntries.mockResolvedValue({
      entries: [
        { ...FIXTURE.entries[0], id: 'row-a', correlationId: 'shared-corr' },
        { ...FIXTURE.entries[1], id: 'row-b', correlationId: 'shared-corr' },
      ],
      truncated: false,
      partial: false,
      sinceHours: 24,
    });
    renderWithProviders(<Audit />);
    expect(await screen.findByText('sessionhost.drain')).toBeInTheDocument();
    expect(screen.getByText('access.assignment.remove')).toBeInTheDocument();
  });

  it('AM-32 peer review item 6 — the actor debounce collapses several keystrokes into exactly ONE additional request, using the final value', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Audit />);
    await vi.waitFor(() => expect(getRecentAuditEntries).toHaveBeenCalledTimes(1));

    const actorInput = screen.getByRole('textbox', { name: 'Filter by actor' });
    await user.type(actorInput, 'jdoe');

    // Nothing extra fired yet — still debouncing (ACTOR_DEBOUNCE_MS is 400ms).
    expect(getRecentAuditEntries).toHaveBeenCalledTimes(1);

    // Real (short) wait past the debounce window — deliberately not using
    // fake timers here: combining them with userEvent.type's own internal
    // per-keystroke delay is a known source of test hangs/flakiness, and
    // 400ms is cheap enough to wait for real.
    await new Promise((resolve) => setTimeout(resolve, 600));

    expect(getRecentAuditEntries).toHaveBeenCalledTimes(2);
    expect(getRecentAuditEntries).toHaveBeenLastCalledWith(expect.objectContaining({ actor: 'jdoe' }), expect.anything());
  }, 10_000);

  it('AM-32 peer review item 6 — an action-family dropdown change re-fetches with the right actionPrefix', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Audit />);
    await vi.waitFor(() => expect(getRecentAuditEntries).toHaveBeenCalledTimes(1));

    await user.click(screen.getByRole('combobox', { name: 'Action' }));
    await user.click(await screen.findByRole('option', { name: 'Session host' }));

    await vi.waitFor(() => expect(getRecentAuditEntries).toHaveBeenCalledTimes(2));
    expect(getRecentAuditEntries).toHaveBeenLastCalledWith(expect.objectContaining({ actionPrefix: 'sessionhost.' }), expect.anything());
  });

  it('AM-32 peer review item 6 — a time-window dropdown change re-fetches with the right sinceHours', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Audit />);
    await vi.waitFor(() => expect(getRecentAuditEntries).toHaveBeenCalledTimes(1));

    await user.click(screen.getByRole('combobox', { name: 'Time window' }));
    await user.click(await screen.findByRole('option', { name: 'Last 7d' }));

    await vi.waitFor(() => expect(getRecentAuditEntries).toHaveBeenCalledTimes(2));
    expect(getRecentAuditEntries).toHaveBeenLastCalledWith(expect.objectContaining({ sinceHours: 168 }), expect.anything());
  });

  it('AM-32 peer review item 6 — a viewer sees the RoleGate fallback, and the fetch is never even attempted', async () => {
    useAuth.mockReturnValue(authState({ role: 'viewer', roles: ['viewer'] }));
    renderWithProviders(<Audit />);

    expect(await screen.findByText('Audit requires the operator or admin role.')).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Filter by actor' })).not.toBeInTheDocument();
    // Give any errant fetch a tick to (not) fire.
    await Promise.resolve();
    expect(getRecentAuditEntries).not.toHaveBeenCalled();
  });

  it('AM-32 peer review item 6 — shows the truncated caption when truncated:true and partial:false', async () => {
    getRecentAuditEntries.mockResolvedValue({ ...FIXTURE, truncated: true });
    renderWithProviders(<Audit />);
    expect(await screen.findByText(/more entries may exist/i)).toBeInTheDocument();
  });

  it('AM-32 peer review item 6 / MAJOR 3 — shows the partial caveat (not the plain truncated one) when partial:true', async () => {
    getRecentAuditEntries.mockResolvedValue({ ...FIXTURE, truncated: true, partial: true });
    renderWithProviders(<Audit />);
    expect(await screen.findByText(/audit query failed partway/i)).toBeInTheDocument();
    expect(screen.queryByText(/more entries may exist/i)).not.toBeInTheDocument();
  });

  it('shows no truncated/partial caption when both are false', async () => {
    renderWithProviders(<Audit />);
    await screen.findByText('sessionhost.drain');
    expect(screen.queryByText(/more entries may exist/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/audit query failed partway/i)).not.toBeInTheDocument();
  });

  it('AM-32 peer review MINOR 12 — "Show failures only" filters to just failure-outcome rows, client-side', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Audit />);
    await screen.findByText('sessionhost.drain');

    await user.click(screen.getByRole('switch', { name: 'Show failures only' }));

    expect(screen.queryByText('sessionhost.drain')).not.toBeInTheDocument();
    expect(screen.getByText('access.assignment.remove')).toBeInTheDocument();
    // A client-side filter, not a new request.
    expect(getRecentAuditEntries).toHaveBeenCalledTimes(1);
  });

  it('AM-32 peer review MINOR 12 — shows a "no failures" message when the failures-only filter empties the visible set', async () => {
    const user = userEvent.setup();
    getRecentAuditEntries.mockResolvedValue({ entries: [FIXTURE.entries[0]], truncated: false, partial: false, sinceHours: 24 });
    renderWithProviders(<Audit />);
    await screen.findByText('sessionhost.drain');

    await user.click(screen.getByRole('switch', { name: 'Show failures only' }));
    expect(await screen.findByText('No failures in this window.')).toBeInTheDocument();
  });

  it('AM-32 peer review MINOR 10 — shows a "has parameters" affordance only for entries that carry one', async () => {
    renderWithProviders(<Audit />);
    await screen.findByText('sessionhost.drain');
    expect(screen.getAllByText(/has parameters/)).toHaveLength(1);
  });

  it('AM-32 peer review MINOR 13 — "accepted" renders with a different badge class than "success"', async () => {
    getRecentAuditEntries.mockResolvedValue({
      entries: [
        { ...FIXTURE.entries[0], id: 'row-success' },
        { ...FIXTURE.entries[1], id: 'row-accepted', outcome: 'accepted' },
      ],
      truncated: false,
      partial: false,
      sinceHours: 24,
    });
    renderWithProviders(<Audit />);
    const successBadge = await screen.findByText('success');
    const acceptedBadge = screen.getByText('accepted');
    expect(successBadge.className).not.toBe(acceptedBadge.className);
  });

  it('AM-32 peer review MINOR 11 — shows the correlation ID and copies it to the clipboard on click', async () => {
    // jsdom ships its own real navigator.clipboard (a Clipboard/EventTarget
    // instance) that neither Object.defineProperty NOR vi.stubGlobal('navigator', ...)
    // reliably shadows in this environment — spying on the REAL object's
    // own writeText method is what actually intercepts the call.
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
    const user = userEvent.setup();
    renderWithProviders(<Audit />);
    await screen.findByText('sessionhost.drain');

    const copyButton = screen.getByRole('button', { name: /copy correlation id corr-1/i });
    expect(copyButton).toHaveTextContent('corr-1');
    await user.click(copyButton);
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith('corr-1'));
  });

  it('shows an empty-state message when there are no matching entries at all', async () => {
    getRecentAuditEntries.mockResolvedValue({ entries: [], truncated: false, partial: false, sinceHours: 24 });
    renderWithProviders(<Audit />);
    expect(await screen.findByText('No audit entries match these filters.')).toBeInTheDocument();
  });
});
