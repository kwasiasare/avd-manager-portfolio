import type { ComponentType } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';

/**
 * AM-61 — every routed page renders against the REAL demo transport (no
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

interface PageCase {
  name: string;
  load: () => Promise<{ default: ComponentType }>;
  expectText: RegExp;
  /** AM-61 review fix — for pages that read a route param: the <Route path> pattern and the URL to start at. */
  route?: { path: string; url: string };
}

const pages: PageCase[] = [
  { name: 'Dashboard', load: () => import('../pages/Dashboard'), expectText: /avd-con|HP-CONTOSO-PROD|Contoso/ },
  { name: 'Host pools', load: () => import('../pages/HostPool'), expectText: /avd-con-3/ },
  { name: 'Sessions', load: () => import('../pages/Sessions'), expectText: /maria\.santos@contoso\.example/ },
  { name: 'Images', load: () => import('../pages/Images'), expectText: /1\.3\.0/ },
  // The three non-default Images tabs each call their own endpoints (builds, rollout plans/provisions, snapshots).
  { name: 'Images · Build', load: () => import('../pages/Images'), expectText: /1\.4\.0/, route: { path: '/images/:tab', url: '/images/build' } },
  { name: 'Images · Rollout', load: () => import('../pages/Images'), expectText: /Second wave/, route: { path: '/images/:tab', url: '/images/rollout' } },
  { name: 'Images · Snapshots', load: () => import('../pages/Images'), expectText: /SNAP-TEST-DISK-OLD/, route: { path: '/images/:tab', url: '/images/snapshots' } },
  { name: 'Scaling', load: () => import('../pages/Scaling'), expectText: /Weekdays/ },
  { name: 'Cost', load: () => import('../pages/Cost'), expectText: /RG-AVD-HostPools/ },
  { name: 'Users & access', load: () => import('../pages/UsersAccess'), expectText: /SG-AVD-Users-Finance/ },
  { name: 'Profiles', load: () => import('../pages/Profiles'), expectText: /nina\.petrova/ },
  { name: 'Monitoring', load: () => import('../pages/Monitoring'), expectText: /Session host unhealthy/ },
  { name: 'Governance', load: () => import('../pages/Governance'), expectText: /Key Vault purge protection/ },
  { name: 'Audit', load: () => import('../pages/Audit'), expectText: /sessionhost\.drain/ },
  { name: 'Settings', load: () => import('../pages/Settings'), expectText: /WS-CONTOSO-PROD/ },
  { name: 'Incident', load: () => import('../pages/Incident'), expectText: /avd-con-5/ },
];

describe('demo mode renders every page with data', () => {
  for (const page of pages) {
    it(page.name, async () => {
      setDemoLatency(() => 0);
      window.sessionStorage.clear();
      setDemoRole('admin');
      resetDemoState();
      const { default: Page } = await page.load();
      const element = page.route ? (
        <Routes>
          <Route path={page.route.path} element={<Page />} />
        </Routes>
      ) : (
        <Page />
      );
      renderWithProviders(<AuthProvider>{element}</AuthProvider>, { initialEntries: page.route ? [page.route.url] : undefined });
      expect((await screen.findAllByText(page.expectText, {}, { timeout: 8000 })).length).toBeGreaterThan(0);
      await waitFor(() => expect(screen.queryByText("Couldn't load this data")).not.toBeInTheDocument());
    }, 20000);
  }
});
