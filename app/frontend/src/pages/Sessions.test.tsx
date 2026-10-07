import { describe, expect, it, vi, beforeEach } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { UserSession } from '@avdmgr/shared';
import { renderWithProviders } from '../test/renderWithProviders';
import type { AuthState } from '../auth/AuthContext';

const getSessions = vi.fn();
const forceLogoffSession = vi.fn();
const sendSessionMessage = vi.fn();
const logoffAllDisconnectedSessions = vi.fn();
const broadcastSessionMessage = vi.fn();
vi.mock('../api/avd', () => ({
  getSessions: (...args: unknown[]) => getSessions(...args),
  forceLogoffSession: (...args: unknown[]) => forceLogoffSession(...args),
  sendSessionMessage: (...args: unknown[]) => sendSessionMessage(...args),
  logoffAllDisconnectedSessions: (...args: unknown[]) => logoffAllDisconnectedSessions(...args),
  broadcastSessionMessage: (...args: unknown[]) => broadcastSessionMessage(...args),
}));

const useAuth = vi.fn<() => AuthState>();
vi.mock('../auth/useAuth', () => ({ useAuth: () => useAuth() }));

const { default: Sessions } = await import('./Sessions');

function authState(overrides: Partial<AuthState> = {}): AuthState {
  return { loading: false, isAuthenticated: true, userDetails: 'operator@contoso.example', roles: ['operator'], role: 'operator', ...overrides };
}

function makeSession(overrides: Partial<UserSession> = {}): UserSession {
  return {
    id: overrides.id ?? 's1',
    sessionHostName: 'avd-con-0',
    sessionId: 1,
    userPrincipalName: 'alice@contoso.example',
    sessionState: 'Active',
    createTime: '2026-08-16T09:00:00.000Z',
    ...overrides,
  } as UserSession;
}

const SESSIONS: UserSession[] = [
  makeSession({ id: 's1', userPrincipalName: 'alice@contoso.example', sessionHostName: 'avd-con-0', sessionState: 'Active' }),
  makeSession({ id: 's2', userPrincipalName: 'bob@contoso.example', sessionHostName: 'avd-con-1', sessionState: 'Disconnected' }),
];

beforeEach(() => {
  useAuth.mockReturnValue(authState());
  getSessions.mockResolvedValue(SESSIONS);
});

describe('Sessions — free-text search (AM-31 item 38)', () => {
  it('narrows the table to rows matching the search text', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Sessions />);
    await screen.findByText('alice@contoso.example');
    expect(screen.getByText('bob@contoso.example')).toBeInTheDocument();

    await user.type(screen.getByPlaceholderText('User or host…'), 'alice');

    expect(screen.getByText('alice@contoso.example')).toBeInTheDocument();
    expect(screen.queryByText('bob@contoso.example')).not.toBeInTheDocument();
  });

  it('shows a no-matches message naming the search text, with a way to clear it', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Sessions />);
    await screen.findByText('alice@contoso.example');

    await user.type(screen.getByPlaceholderText('User or host…'), 'nobody-matches-this');
    expect(await screen.findByText(/No sessions match/)).toBeInTheDocument();
    expect(screen.getByText(/search "nobody-matches-this"/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(await screen.findByText('alice@contoso.example')).toBeInTheDocument();
  });
});

describe('Sessions — sort-change announcement (AM-31 item 43)', () => {
  it('announces the sorted column and direction via a polite live region', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Sessions />);
    await screen.findByText('alice@contoso.example');

    await user.click(screen.getByRole('columnheader', { name: /user/i }));
    expect(await screen.findByRole('status')).toHaveTextContent('Sorted by User ascending');

    await user.click(screen.getByRole('columnheader', { name: /user/i }));
    expect(await screen.findByRole('status')).toHaveTextContent('Sorted by User descending');
  });
});

describe('Sessions — row-action overflow menu (AM-31 item 40)', () => {
  it('keeps Message inline and moves Force logoff into a per-row overflow menu', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Sessions />);
    const row = (await screen.findByText('alice@contoso.example')).closest('tr')!;

    // The Message button's accessible name comes from its wrapping Tooltip's `content` (relationship="label"), not its visible "Message" text — pre-existing behavior, unrelated to this item.
    expect(within(row).getByRole('button', { name: 'Send a message to this session.' })).toHaveTextContent('Message');
    expect(within(row).queryByRole('button', { name: 'Force logoff' })).not.toBeInTheDocument();

    const moreButton = within(row).getByRole('button', { name: /more actions for alice@contoso.example/i });
    await user.click(moreButton);
    expect(await screen.findByRole('menuitem', { name: 'Force logoff' })).toBeInTheDocument();
  });
});

describe('Sessions — force-logoff ImpactPreview panel (AM-33 MAJOR 4 integration coverage)', () => {
  it('renders the ImpactPreview panel above the (severity medium) confirm gate, naming the target session', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Sessions />);
    const row = (await screen.findByText('alice@contoso.example')).closest('tr')!;

    await user.click(within(row).getByRole('button', { name: /more actions for alice@contoso.example/i }));
    await user.click(await screen.findByRole('menuitem', { name: 'Force logoff' }));

    expect(await screen.findByText('Force alice@contoso.example to log off?')).toBeInTheDocument();
    expect(screen.getByText('What this will do')).toBeInTheDocument();
    expect(screen.getByText("Ends alice@contoso.example's Active session on avd-con-0. Unsaved work may be lost.")).toBeInTheDocument();

    // severity 'medium': a reason is required, but there's no typed-name gate.
    const confirmButton = screen.getByRole('button', { name: 'Force logoff' });
    expect(confirmButton).toBeDisabled();
    await user.type(screen.getByPlaceholderText('Why is this needed?'), 'Stuck session, user confirmed offline');
    expect(confirmButton).toBeEnabled();
  });
});
