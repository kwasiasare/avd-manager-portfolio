import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AccessSearchResponse, AssignmentsListResponse, DesktopAssignment, WorkspaceFriendlyNameResponse } from '@avdmgr/shared';
import { renderWithProviders } from '../test/renderWithProviders';
import type { AuthState } from '../auth/AuthContext';

/**
 * Peer review (Opus, MINOR item 12) — at least one test asserting a
 * success TOAST actually renders end-to-end (dispatch -> Toaster -> visible
 * text), not just that the dispatching code ran. UsersAccess's grant flow
 * is the example the review named explicitly.
 */
const searchAccess = vi.fn();
const getDesktopAssignments = vi.fn();
const getWorkspaceFriendlyName = vi.fn();
const createDesktopAssignment = vi.fn();
vi.mock('../api/avd', () => ({
  searchAccess: (...args: unknown[]) => searchAccess(...args),
  getDesktopAssignments: (...args: unknown[]) => getDesktopAssignments(...args),
  getWorkspaceFriendlyName: (...args: unknown[]) => getWorkspaceFriendlyName(...args),
  createDesktopAssignment: (...args: unknown[]) => createDesktopAssignment(...args),
  removeDesktopAssignment: vi.fn(),
  updateWorkspaceFriendlyName: vi.fn(),
}));

const useAuth = vi.fn<() => AuthState>();
vi.mock('../auth/useAuth', () => ({ useAuth: () => useAuth() }));

const { default: UsersAccess } = await import('./UsersAccess');

const EMPTY_ASSIGNMENTS: AssignmentsListResponse = { assignments: [], graphResolved: true, truncated: false };
const EMPTY_WORKSPACE: WorkspaceFriendlyNameResponse = {};
const SEARCH_RESULTS: AccessSearchResponse = {
  results: [{ id: 'user-1', principalType: 'user', displayName: 'Alice Chen', userPrincipalName: 'alice@contoso.example' }],
  graphAvailable: true,
  truncated: false,
};

describe('UsersAccess — grant access success toast (peer review item 12)', () => {
  beforeEach(() => {
    useAuth.mockReturnValue({ loading: false, isAuthenticated: true, userDetails: 'admin@contoso.example', roles: ['admin'], role: 'admin' });
    getDesktopAssignments.mockReset().mockResolvedValue(EMPTY_ASSIGNMENTS);
    getWorkspaceFriendlyName.mockReset().mockResolvedValue(EMPTY_WORKSPACE);
    searchAccess.mockReset().mockResolvedValue(SEARCH_RESULTS);
    createDesktopAssignment.mockReset().mockResolvedValue(undefined);
  });

  it('shows a success toast after granting access, naming the principal', async () => {
    const user = userEvent.setup();
    renderWithProviders(<UsersAccess />);

    await user.type(screen.getByPlaceholderText(/e\.g\. alice/i), 'alice');
    await user.click(await screen.findByRole('button', { name: /grant desktop access to alice chen/i }));

    // ConfirmModal severity 'medium' — mandatory reason, no typed name.
    await user.type(screen.getByPlaceholderText('Why is this needed?'), 'New hire onboarding');
    await user.click(screen.getByRole('button', { name: /^grant access$/i }));

    expect(await screen.findByText('Granted desktop access to Alice Chen')).toBeInTheDocument();
    expect(createDesktopAssignment).toHaveBeenCalledWith({ principalId: 'user-1', principalType: 'user', reason: 'New hire onboarding' });
  });
});

function makeAssignment(overrides: Partial<DesktopAssignment> = {}): DesktopAssignment {
  return {
    roleAssignmentId: 'ra-1',
    principalId: 'user-1',
    principalType: 'User',
    displayName: 'Alice Chen',
    userPrincipalName: 'alice@contoso.example',
    scope: '/subscriptions/s/resourceGroups/rg/providers/Microsoft.DesktopVirtualization/applicationGroups/dag',
    assignedDirectlyOnDag: true,
    assignedVia: 'Direct on DAG',
    ...overrides,
  };
}

describe('UsersAccess — assignments table search (AM-31 item 38)', () => {
  const ASSIGNMENTS: AssignmentsListResponse = {
    assignments: [
      makeAssignment({ roleAssignmentId: 'ra-1', displayName: 'Alice Chen', userPrincipalName: 'alice@contoso.example', principalId: 'user-1' }),
      makeAssignment({ roleAssignmentId: 'ra-2', displayName: 'Bob Diaz', userPrincipalName: 'bob@contoso.example', principalId: 'user-2' }),
    ],
    graphResolved: true,
    truncated: false,
  };

  beforeEach(() => {
    useAuth.mockReturnValue({ loading: false, isAuthenticated: true, userDetails: 'operator@contoso.example', roles: ['operator'], role: 'operator' });
    getDesktopAssignments.mockReset().mockResolvedValue(ASSIGNMENTS);
    getWorkspaceFriendlyName.mockReset().mockResolvedValue(EMPTY_WORKSPACE);
  });

  it('narrows the table to assignments matching the search text', async () => {
    const user = userEvent.setup();
    renderWithProviders(<UsersAccess />);
    await screen.findByText('Alice Chen');
    expect(screen.getByText('Bob Diaz')).toBeInTheDocument();

    await user.type(screen.getByPlaceholderText('Search…'), 'alice');

    expect(screen.getByText('Alice Chen')).toBeInTheDocument();
    expect(screen.queryByText('Bob Diaz')).not.toBeInTheDocument();
  });

  it('matches on principal ID, not just the resolved name', async () => {
    const user = userEvent.setup();
    renderWithProviders(<UsersAccess />);
    await screen.findByText('Alice Chen');

    await user.type(screen.getByPlaceholderText('Search…'), 'user-2');

    expect(screen.getByText('Bob Diaz')).toBeInTheDocument();
    expect(screen.queryByText('Alice Chen')).not.toBeInTheDocument();
  });

  it('shows a no-matches message naming the search text', async () => {
    const user = userEvent.setup();
    renderWithProviders(<UsersAccess />);
    await screen.findByText('Alice Chen');

    await user.type(screen.getByPlaceholderText('Search…'), 'nobody-matches');
    expect(await screen.findByText(/No assignments match "nobody-matches"/)).toBeInTheDocument();
  });
});
