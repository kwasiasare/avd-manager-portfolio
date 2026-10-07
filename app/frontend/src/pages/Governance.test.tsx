import { describe, expect, it, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { GovernanceCheckResult, GovernanceSummary } from '@avdmgr/shared';
import { renderWithProviders } from '../test/renderWithProviders';
import type { AuthState } from '../auth/AuthContext';

const getGovernance = vi.fn();
vi.mock('../api/avd', () => ({
  getGovernance: (...args: unknown[]) => getGovernance(...args),
}));

const useAuth = vi.fn<() => AuthState>();
vi.mock('../auth/useAuth', () => ({ useAuth: () => useAuth() }));

const { default: Governance } = await import('./Governance');

function makeCheck(overrides: Partial<GovernanceCheckResult> = {}): GovernanceCheckResult {
  return {
    id: 'check-1',
    title: 'Check title',
    category: 'Category A',
    status: 'pass',
    summary: 'All good.',
    evidence: {},
    checkedAt: '2026-08-16T09:00:00.000Z',
    ...overrides,
  };
}

const SUMMARY: GovernanceSummary = {
  checks: [
    makeCheck({ id: 'pass-1', title: 'Pass check', category: 'Category A', status: 'pass' }),
    makeCheck({ id: 'fail-1', title: 'Fail check', category: 'Category A', status: 'fail', summary: 'Broken.' }),
    makeCheck({ id: 'fail-2', title: 'Second fail check', category: 'Category B', status: 'fail', summary: 'Also broken.' }),
  ],
  counts: { pass: 1, warn: 0, fail: 2, unknown: 0 },
  generatedAt: '2026-08-16T09:00:00.000Z',
  cached: false,
};

beforeEach(() => {
  useAuth.mockReturnValue({ loading: false, isAuthenticated: true, userDetails: 'operator@contoso.example', roles: ['operator'], role: 'operator' });
  getGovernance.mockReset().mockResolvedValue(SUMMARY);
});

describe('Governance — clickable summary tiles (AM-31 item 39)', () => {
  it('clicking the Fail tile shows only failing checks', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Governance />);
    await screen.findByText('Pass check');
    expect(screen.getByText('Fail check')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /^Fail: 2 checks/ }));

    expect(screen.queryByText('Pass check')).not.toBeInTheDocument();
    expect(screen.getByText('Fail check')).toBeInTheDocument();
    expect(screen.getByText('Second fail check')).toBeInTheDocument();
  });

  it('clicking the active tile again clears the filter', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Governance />);
    await screen.findByText('Pass check');

    const failTile = screen.getByRole('button', { name: /^Fail: 2 checks/ });
    await user.click(failTile);
    expect(screen.queryByText('Pass check')).not.toBeInTheDocument();

    await user.click(failTile);
    expect(await screen.findByText('Pass check')).toBeInTheDocument();
  });

  it('the "Show failures only" Switch is the same filter as the Fail tile', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Governance />);
    await screen.findByText('Pass check');

    await user.click(screen.getByRole('switch', { name: 'Show failures only' }));
    expect(screen.queryByText('Pass check')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Fail: 2 checks/ })).toHaveAttribute('aria-pressed', 'true');

    await user.click(screen.getByRole('switch', { name: 'Show failures only' }));
    expect(await screen.findByText('Pass check')).toBeInTheDocument();
  });

  it('shows a "no checks match" message when the filter yields nothing', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Governance />);
    await screen.findByText('Pass check');

    await user.click(screen.getByRole('button', { name: /^Unknown: 0 checks/ }));
    expect(await screen.findByText('No checks match the current filter.')).toBeInTheDocument();
  });
});

describe('Governance — expand-all/collapse-all (AM-31 item 39)', () => {
  it('Expand all opens every check panel, Collapse all closes them again', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Governance />);
    await screen.findByText('Pass check');

    // The check's own AccordionPanel content (evidence/"Checked <date>") only renders while expanded — the summary text in the header is visible regardless, so that's not a useful signal here.
    expect(screen.queryByText(/^Checked /)).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Expand all' }));
    const checkedTexts = await screen.findAllByText(/^Checked /);
    expect(checkedTexts).toHaveLength(3);

    await user.click(screen.getByRole('button', { name: 'Collapse all' }));
    expect(screen.queryByText(/^Checked /)).not.toBeInTheDocument();
  });
});
