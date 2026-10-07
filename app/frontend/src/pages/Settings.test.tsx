import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { SettingsResponse } from '@avdmgr/shared';
import { renderWithProviders } from '../test/renderWithProviders';
import type { AuthState } from '../auth/AuthContext';

/**
 * AM-15 (M7) peer review MINOR fix: exercises Settings.tsx with a RESOLVED
 * GET /v1/settings fixture (the page smoke suite — pages.smoke.test.tsx —
 * deliberately never resolves any fetch, so it only ever exercises the
 * loading skeleton, never the actual config card content).
 */
const SETTINGS_FIXTURE: SettingsResponse = {
  apiVersion: '1.0.0',
  hostPoolName: 'HP-CONTOSO-PROD',
  workspaceName: 'Contoso-Desktop',
  dagName: 'HP-CONTOSO-PROD-DAG',
  storage: { accountName: 'stcontoso001', fslogixShareName: 'fslogixprofiles' },
  profilesOversizedGb: 5,
  groupIds: { viewer: 'configured', operator: 'not-configured', admin: 'configured' },
};

const apiGet = vi.fn();
vi.mock('../api/client', () => ({
  apiClient: {
    get: (...args: unknown[]) => apiGet(...args),
    post: vi.fn(() => new Promise(() => {})),
    put: vi.fn(() => new Promise(() => {})),
    patch: vi.fn(() => new Promise(() => {})),
    delete: vi.fn(() => new Promise(() => {})),
  },
}));

const useAuth = vi.fn<() => AuthState>();
vi.mock('../auth/useAuth', () => ({ useAuth: () => useAuth() }));

const { default: Settings } = await import('./Settings');

describe('Settings page', () => {
  it('renders the resolved app-configuration card once GET /v1/settings resolves', async () => {
    apiGet.mockResolvedValue(SETTINGS_FIXTURE);
    useAuth.mockReturnValue({ loading: false, isAuthenticated: true, userDetails: 'operator@example.com', roles: ['operator'], role: 'operator' });

    renderWithProviders(<Settings />);

    expect(await screen.findByText('HP-CONTOSO-PROD')).toBeInTheDocument();
    expect(screen.getByText('Contoso-Desktop')).toBeInTheDocument();
    expect(screen.getByText('HP-CONTOSO-PROD-DAG')).toBeInTheDocument();
    expect(screen.getByText('stcontoso001')).toBeInTheDocument();
    expect(screen.getByText('fslogixprofiles')).toBeInTheDocument();
    expect(screen.getByText('5 GiB')).toBeInTheDocument();

    // Two "Configured" badges (viewer, admin) and one "Not configured" (operator) — never the raw group ids.
    expect(screen.getAllByText('Configured')).toHaveLength(2);
    expect(screen.getByText('Not configured')).toBeInTheDocument();

    // AM-54: no gitSha in this fixture (versionSource: 'app-setting'-shaped) — the "Build" row must not render.
    expect(screen.queryByText('Build')).not.toBeInTheDocument();
  });

  it('AM-54: shows a short gitSha + builtAt "Build" row when the API reports an artifact-sourced version', async () => {
    apiGet.mockResolvedValue({
      ...SETTINGS_FIXTURE,
      gitSha: 'abcdef1234567890abcdef1234567890abcdef12',
      builtAt: '2026-08-22T12:00:00.000Z',
      versionSource: 'artifact',
    } satisfies SettingsResponse);
    useAuth.mockReturnValue({ loading: false, isAuthenticated: true, userDetails: 'operator@example.com', roles: ['operator'], role: 'operator' });

    renderWithProviders(<Settings />);

    expect(await screen.findByText('Build')).toBeInTheDocument();
    // Short (7-char) sha, not the full 40-char one.
    expect(screen.getByText(/^abcdef1/)).toBeInTheDocument();
    expect(screen.queryByText(/abcdef1234567890abcdef1234567890abcdef12/)).not.toBeInTheDocument();
  });

  it("renders the signed-in user's resolved access", async () => {
    apiGet.mockResolvedValue(SETTINGS_FIXTURE);
    useAuth.mockReturnValue({ loading: false, isAuthenticated: true, userDetails: 'operator@example.com', roles: ['viewer', 'operator'], role: 'operator' });

    renderWithProviders(<Settings />);

    expect(screen.getByText('operator@example.com')).toBeInTheDocument();
    expect(screen.getByText('viewer')).toBeInTheDocument();
    // 'operator' appears twice — the role badge AND the "(operator) is
    // highlighted above" explanation text — so getAllByText, not getByText.
    expect(screen.getAllByText('operator').length).toBeGreaterThanOrEqual(2);
    // Resolve the config-card fetch too, so this test doesn't leave a dangling promise.
    await screen.findByText('HP-CONTOSO-PROD');
  });
});

describe('Settings page — Appearance card (AM-29 item U2)', () => {
  beforeEach(() => {
    window.localStorage.clear();
    apiGet.mockResolvedValue(SETTINGS_FIXTURE);
    useAuth.mockReturnValue({ loading: false, isAuthenticated: true, userDetails: 'operator@example.com', roles: ['operator'], role: 'operator' });
  });

  it('shows System/Light/Dark radio options, with Dark selected by default (the mockup theme — user direction 2026-08-16)', () => {
    renderWithProviders(<Settings />);
    expect(screen.getByRole('radio', { name: /^dark$/i })).toBeChecked();
    expect(screen.getByRole('radio', { name: /use system setting/i })).not.toBeChecked();
    expect(screen.getByRole('radio', { name: /^light$/i })).not.toBeChecked();
  });

  it('selecting Light persists to the SAME localStorage key the estate-strip theme toggle uses — one shared theme state, not a second toggle', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Settings />);

    await user.click(screen.getByRole('radio', { name: /^light$/i }));

    expect(screen.getByRole('radio', { name: /^light$/i })).toBeChecked();
    expect(window.localStorage.getItem('avdmgr.themeMode')).toBe('light');
  });
});
