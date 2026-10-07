import { describe, expect, it, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import type { CostSummary } from '@avdmgr/shared';
import { renderWithProviders } from '../test/renderWithProviders';
import type { AuthState } from '../auth/AuthContext';

const getCostSummary = vi.fn();
const getCostHostRuntime = vi.fn();
const getFslogixUsage = vi.fn();
const getSavingsOpportunities = vi.fn();
const getIdleHosts = vi.fn();
vi.mock('../api/avd', () => ({
  getCostSummary: (...args: unknown[]) => getCostSummary(...args),
  getCostHostRuntime: (...args: unknown[]) => getCostHostRuntime(...args),
  getFslogixUsage: (...args: unknown[]) => getFslogixUsage(...args),
  getSavingsOpportunities: (...args: unknown[]) => getSavingsOpportunities(...args),
  getIdleHosts: (...args: unknown[]) => getIdleHosts(...args),
}));

const useAuth = vi.fn<() => AuthState>();
vi.mock('../auth/useAuth', () => ({ useAuth: () => useAuth() }));

const { default: Cost } = await import('./Cost');

const COST: CostSummary = {
  currency: 'USD',
  asOfDate: '2026-08-16',
  monthToDateCost: 1200,
  priorMonthSamePeriodCost: 1000,
  projectedMonthEndCost: 2400,
  byResourceGroup: [],
  computedAt: '2026-08-16T12:00:00.000Z',
};

beforeEach(() => {
  useAuth.mockReturnValue({ loading: false, isAuthenticated: true, userDetails: 'operator@contoso.example', roles: ['operator'], role: 'operator' });
  getCostSummary.mockReset().mockResolvedValue(COST);
  getCostHostRuntime.mockReset().mockResolvedValue([]);
  getFslogixUsage.mockReset().mockResolvedValue({ shareName: 'profiles', storageAccountName: 'stprofiles', usedGib: 10, provisionedGib: 100, percentUsed: 10 });
  getSavingsOpportunities.mockReset().mockResolvedValue([]);
  getIdleHosts.mockReset().mockResolvedValue({ evaluated: true, findings: [] });
});

describe('Cost (AM-31 item 32b)', () => {
  it('renders the page title and month-to-date cost', async () => {
    renderWithProviders(<Cost />);
    expect(screen.getByRole('heading', { level: 1, name: 'Cost' })).toBeInTheDocument();
    expect(await screen.findByText('$1,200.00')).toBeInTheDocument();
  });

  it('shows idle-host findings with the shared phase label (AM-31 item 42)', async () => {
    getIdleHosts.mockResolvedValue({
      evaluated: true,
      findings: [{ hostPoolName: 'HP-CONTOSO-PROD', sessionHostName: 'avd-con-0', powerState: 'running', phase: 'OffPeak', disconnectedSessions: 0, runningSinceApprox: undefined }],
    });
    renderWithProviders(<Cost />);
    expect(await screen.findByText('avd-con-0')).toBeInTheDocument();
    expect(screen.getByText('Off-peak')).toBeInTheDocument();
  });

  describe('AM-39 — stale cost-summary caveat', () => {
    it('shows the "showing cached spend data" caveat when the API returns stale:true (costService served a last-good result after an upstream failure)', async () => {
      getCostSummary.mockResolvedValue({ ...COST, stale: true });
      renderWithProviders(<Cost />);

      expect(await screen.findByText('Showing cached spend data')).toBeInTheDocument();
      // The figures themselves still render normally — stale data is shown, not hidden.
      expect(screen.getByText('$1,200.00')).toBeInTheDocument();
    });

    it('does NOT show the stale caveat for a normal, fresh (stale omitted) response', async () => {
      renderWithProviders(<Cost />);
      await screen.findByText('$1,200.00');
      expect(screen.queryByText('Showing cached spend data')).not.toBeInTheDocument();
    });

    it('AM-40 peer review MAJOR 3: renders computedAt (cache-write time), and scopes the caveat to the summary-fed cards specifically', async () => {
      getCostSummary.mockResolvedValue({ ...COST, stale: true, computedAt: '2026-08-16T09:15:00.000Z' });
      renderWithProviders(<Cost />);

      const caveat = (await screen.findByText(/latest refresh from Cost Management failed/)).closest('div');
      expect(caveat).not.toBeNull();
      // Doesn't assert the exact locale-formatted clock time (environment/timezone dependent) — just that a "cached from <time>" claim is present and the copy names exactly which cards are affected, not the whole page.
      expect(caveat).toHaveTextContent(/cached from/i);
      expect(caveat).toHaveTextContent(/month-to-date, prior-month, projected, and spend-by-resource-group/i);
      expect(caveat).toHaveTextContent(/other sections on this page are unaffected/i);
    });

    it('AM-40 peer review MAJOR 3b: a stale summary fetch never makes the page header\'s "As of" claim the page is fresh — excluded from the header when stale, other sections still contribute normally', async () => {
      getCostSummary.mockResolvedValue({ ...COST, stale: true });
      // Every OTHER independent widget also has nothing to contribute here, so if the stale summary's own fetch time were still leaking into the header, this is where it would show up.
      getCostHostRuntime.mockRejectedValue(new Error('boom'));
      getFslogixUsage.mockRejectedValue(new Error('boom'));
      getSavingsOpportunities.mockRejectedValue(new Error('boom'));
      getIdleHosts.mockRejectedValue(new Error('boom'));

      renderWithProviders(<Cost />);
      await screen.findByText('Showing cached spend data');

      // Case-sensitive and anchored: PageHeader's own freshness line reads
      // exactly "As of <time>" (capital A) — distinct from the Month-to-date
      // card's own "as of <date>" label (lowercase a, a different string
      // this test must NOT match, since that one is fine to keep showing).
      expect(screen.queryByText(/^As of/)).not.toBeInTheDocument();
    });
  });
});
