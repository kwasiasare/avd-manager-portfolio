import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import AppThemeProvider from './theme/AppThemeProvider';

/**
 * Peer review MINOR 17 — a real regression test for the /cost-scaling →
 * /scaling redirect (App.tsx's `<Route path="cost-scaling" element={<Navigate
 * to="/scaling" replace />} />`, added for AM-31 item 32b's Cost/Scaling
 * split), exercised via MemoryRouter initialEntries rather than only asserted
 * by reading the route table — this way a future edit that breaks the actual
 * redirect (not just the route declaration) fails a test.
 *
 * Mocks apiClient's four HTTP verbs the same way pages.smoke.test.tsx does —
 * every page (including Scaling, the redirect's destination, and every other
 * page Layout's nav could reach) ultimately calls through apiClient, and a
 * promise that never resolves is enough to exercise "did the route/redirect
 * itself land correctly" without needing a full response fixture for every
 * page.
 */
vi.mock('./api/client', () => ({
  apiClient: {
    get: vi.fn(() => new Promise(() => {})),
    post: vi.fn(() => new Promise(() => {})),
    put: vi.fn(() => new Promise(() => {})),
    patch: vi.fn(() => new Promise(() => {})),
    delete: vi.fn(() => new Promise(() => {})),
  },
}));

const { default: App } = await import('./App');

describe('App routing — /cost-scaling redirect (AM-31 item 32b / peer review MINOR 17)', () => {
  it('redirects /cost-scaling to /scaling', async () => {
    render(
      <MemoryRouter initialEntries={['/cost-scaling']}>
        <AppThemeProvider>
          <App />
        </AppThemeProvider>
      </MemoryRouter>,
    );

    expect(await screen.findByRole('heading', { level: 1, name: 'Scaling' })).toBeInTheDocument();
  });
});
