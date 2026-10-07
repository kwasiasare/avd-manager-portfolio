import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { Toaster } from '@fluentui/react-components';
import AppThemeProvider from '../theme/AppThemeProvider';
import { ColdStartHintProvider } from '../components/ColdStartHintProvider';
import { TOASTER_ID } from '../lib/toaster';
import type { AuthState } from '../auth/AuthContext';

const getImageVersions = vi.fn();
const getImageSnapshots = vi.fn();
const listImageBuilds = vi.fn();
const getSessionHosts = vi.fn();
vi.mock('../api/avd', () => ({
  getImageVersions: (...args: unknown[]) => getImageVersions(...args),
  getImageSnapshots: (...args: unknown[]) => getImageSnapshots(...args),
  listImageBuilds: (...args: unknown[]) => listImageBuilds(...args),
  getImageBuild: vi.fn(() => new Promise(() => {})),
  getSessionHosts: (...args: unknown[]) => getSessionHosts(...args),
}));

const listRolloutPlans = vi.fn();
vi.mock('../api/rollout', () => ({
  listRolloutPlans: (...args: unknown[]) => listRolloutPlans(...args),
}));

const useAuth = vi.fn<() => AuthState>();
vi.mock('../auth/useAuth', () => ({ useAuth: () => useAuth() }));

const { default: Images } = await import('./Images');

function authState(overrides: Partial<AuthState> = {}): AuthState {
  return { loading: false, isAuthenticated: true, userDetails: 'admin@contoso.example', roles: ['admin'], role: 'admin', ...overrides };
}

/** Mirrors App.tsx's own two Images routes exactly, so useParams()'s `:tab` behaves identically to production. */
function renderImages(initialPath: string) {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <AppThemeProvider>
        <ColdStartHintProvider>
          <Routes>
            <Route path="/images" element={<Images />} />
            <Route path="/images/:tab" element={<Images />} />
          </Routes>
        </ColdStartHintProvider>
        <Toaster toasterId={TOASTER_ID} />
      </AppThemeProvider>
    </MemoryRouter>,
  );
}

const VERSIONS_RESPONSE = { versions: [{ id: 'v1', name: '2.0.0', isCurrent: true, excludeFromLatest: false, hostCount: 1 }], hostCorrelations: [] };
const SNAPSHOTS_RESPONSE = { snapshots: [], resourceGroupsScanned: ['rg-images'], scanIncomplete: false };
const BUILDS_RESPONSE = { builds: [] };
const ROLLOUT_PLANS_RESPONSE = { plans: [], truncated: false };

beforeEach(() => {
  vi.clearAllMocks();
  useAuth.mockReturnValue(authState());
  getImageVersions.mockResolvedValue(VERSIONS_RESPONSE);
  getImageSnapshots.mockResolvedValue(SNAPSHOTS_RESPONSE);
  listImageBuilds.mockResolvedValue(BUILDS_RESPONSE);
  listRolloutPlans.mockResolvedValue(ROLLOUT_PLANS_RESPONSE);
  getSessionHosts.mockResolvedValue([]);
});

describe('Images — tabs (AM-31 item 32a)', () => {
  it('defaults to the Versions tab at /images and fetches ONLY versions — no snapshots/builds/rollout plans', async () => {
    renderImages('/images');

    expect(await screen.findByText('Version timeline')).toBeInTheDocument();
    expect(getImageVersions).toHaveBeenCalledTimes(1);
    expect(getImageSnapshots).not.toHaveBeenCalled();
    expect(listImageBuilds).not.toHaveBeenCalled();
    expect(listRolloutPlans).not.toHaveBeenCalled();
  });

  it('a deep link to /images/build mounts only the Build tab, never fetching versions/snapshots/rollout plans', async () => {
    renderImages('/images/build');

    expect(await screen.findByText('Start a new build')).toBeInTheDocument();
    expect(listImageBuilds).toHaveBeenCalledTimes(1);
    expect(getImageVersions).not.toHaveBeenCalled();
    expect(getImageSnapshots).not.toHaveBeenCalled();
    expect(listRolloutPlans).not.toHaveBeenCalled();
  });

  it('a deep link to /images/rollout mounts only the Rollout tab', async () => {
    renderImages('/images/rollout');

    expect(await screen.findByText('Staged rollout')).toBeInTheDocument();
    expect(listRolloutPlans).toHaveBeenCalledTimes(1);
    expect(getImageVersions).not.toHaveBeenCalled();
    expect(getImageSnapshots).not.toHaveBeenCalled();
    expect(listImageBuilds).not.toHaveBeenCalled();
  });

  it('an unrecognized :tab value redirects to the canonical /images (Versions) URL rather than silently rendering Versions at the bogus URL (peer review MINOR 5)', async () => {
    renderImages('/images/bogus');
    expect(await screen.findByText('Version timeline')).toBeInTheDocument();
    expect(getImageVersions).toHaveBeenCalledTimes(1);
    expect(listImageBuilds).not.toHaveBeenCalled();
    expect(listRolloutPlans).not.toHaveBeenCalled();
    expect(getImageSnapshots).not.toHaveBeenCalled();
  });

  it('clicking a tab navigates the URL and unmounts the previous tab (kills the poll storm)', async () => {
    const user = userEvent.setup();
    renderImages('/images');
    await screen.findByText('Version timeline');
    expect(getImageVersions).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('tab', { name: 'Build' }));

    expect(await screen.findByText('Start a new build')).toBeInTheDocument();
    expect(screen.queryByText('Version timeline')).not.toBeInTheDocument();
    // Switching tabs must not re-trigger the tab we just left.
    expect(getImageVersions).toHaveBeenCalledTimes(1);
  });

  it('renders one page-level PageHeader h1, not one per tab', async () => {
    renderImages('/images');
    await screen.findByText('Version timeline');
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByRole('heading', { level: 1, name: 'Images' })).toBeInTheDocument();
  });
});
