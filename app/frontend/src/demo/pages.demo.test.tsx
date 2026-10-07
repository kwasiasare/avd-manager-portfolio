import type { ComponentType } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';

/**
 * AM-61 — the first demo pages (Host pools, Sessions, Settings; Dashboard's cost tile lands with the AM-61 cost routes) renders against the REAL demo transport (no
 * apiClient mock): no "Couldn't load this data" error state, and at least
 * one fixture-derived value on screen. Guards against a page starting to
 * call an endpoint whose demo response is missing or has the wrong shape.
 */
vi.stubEnv('VITE_DEMO_MODE', 'true');

const { renderWithProviders } = await import('../test/renderWithProviders');
const { AuthProvider } = await import('../auth/AuthContext');
const { setDemoLatency } = await import('./transport');
const { resetDemoState } = await import('./state');
const { setDemoRole } = await import('./identity');

const pages: Array<{ name: string; load: () => Promise<{ default: ComponentType }>; expectText: RegExp }> = [
  { name: 'Host pools', load: () => import('../pages/HostPool'), expectText: /avd-con-3/ },
  { name: 'Sessions', load: () => import('../pages/Sessions'), expectText: /maria\.santos@contoso\.example/ },
  { name: 'Settings', load: () => import('../pages/Settings'), expectText: /WS-CONTOSO-PROD/ },
];

describe('demo mode renders every page with data', () => {
  for (const page of pages) {
    it(page.name, async () => {
      setDemoLatency(() => 0);
      window.sessionStorage.clear();
      setDemoRole('admin');
      resetDemoState();
      const { default: Page } = await page.load();
      renderWithProviders(
        <AuthProvider>
          <Page />
        </AuthProvider>,
      );
      expect((await screen.findAllByText(page.expectText, {}, { timeout: 8000 })).length).toBeGreaterThan(0);
      await waitFor(() => expect(screen.queryByText("Couldn't load this data")).not.toBeInTheDocument());
    }, 20000);
  }
});
