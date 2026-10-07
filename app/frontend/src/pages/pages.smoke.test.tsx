import type { ComponentType } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '../test/renderWithProviders';

/**
 * AM-15 (M7) — the repo's known frontend test-harness gap: a
 * renders-without-crashing smoke test for every page component, with the
 * API layer and auth context mocked.
 *
 * Mocking strategy: every page ultimately calls apiClient.get/post/patch/
 * delete (src/api/client.ts) via the typed wrappers in src/api/avd.ts and
 * src/api/rollout.ts — mocking apiClient's four methods here transitively
 * covers every wrapper those two files export, without this test needing
 * to know which specific functions each page imports (that list changes
 * often; this mock does not need to). Each mocked method returns a promise
 * that never resolves, so every page renders its FIRST-load loading state
 * (via usePolling -> AsyncState) and nothing more — exactly what
 * "renders without crashing" needs to exercise, without this suite also
 * needing a full fixture for every one of this app's ~40 response shapes.
 */
vi.mock('../api/client', () => ({
  apiClient: {
    get: vi.fn(() => new Promise(() => {})),
    post: vi.fn(() => new Promise(() => {})),
    put: vi.fn(() => new Promise(() => {})),
    patch: vi.fn(() => new Promise(() => {})),
    delete: vi.fn(() => new Promise(() => {})),
  },
}));

const { default: Dashboard } = await import('./Dashboard');
const { default: HostPool } = await import('./HostPool');
const { default: Sessions } = await import('./Sessions');
const { default: Images } = await import('./Images');
const { default: Scaling } = await import('./Scaling');
const { default: Cost } = await import('./Cost');
const { default: UsersAccess } = await import('./UsersAccess');
const { default: Profiles } = await import('./Profiles');
const { default: Monitoring } = await import('./Monitoring');
const { default: Governance } = await import('./Governance');
const { default: Audit } = await import('./Audit');
const { default: Settings } = await import('./Settings');
const { default: Incident } = await import('./Incident');
const { default: NotFound } = await import('./NotFound');

const PAGES: Array<{ name: string; Component: ComponentType }> = [
  { name: 'Dashboard', Component: Dashboard },
  { name: 'HostPool', Component: HostPool },
  { name: 'Sessions', Component: Sessions },
  { name: 'Images', Component: Images },
  { name: 'Scaling', Component: Scaling },
  { name: 'Cost', Component: Cost },
  { name: 'UsersAccess', Component: UsersAccess },
  { name: 'Profiles', Component: Profiles },
  { name: 'Monitoring', Component: Monitoring },
  { name: 'Governance', Component: Governance },
  { name: 'Audit', Component: Audit },
  { name: 'Settings', Component: Settings },
  { name: 'Incident', Component: Incident },
  { name: 'NotFound', Component: NotFound },
];

describe.each(PAGES)('$name page', ({ Component }) => {
  it('renders without crashing', () => {
    const { container } = renderWithProviders(<Component />);
    expect(container).toBeInTheDocument();
  });
});

describe('NotFound page', () => {
  it('shows a friendly message and a way back to the dashboard (AM-15: closes the /hostpool white-page backlog item)', () => {
    renderWithProviders(<NotFound />);
    expect(screen.getByText(/page not found/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /back to dashboard/i })).toBeInTheDocument();
  });
});
