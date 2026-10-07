import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import AppThemeProvider from '../theme/AppThemeProvider';
import type { AuthState } from '../auth/AuthContext';

const STORAGE_KEY = 'avdmgr.themeMode';

const useAuth = vi.fn<() => AuthState>();
vi.mock('../auth/useAuth', () => ({ useAuth: () => useAuth() }));

/**
 * Peer review (Opus, MINOR item 12) — Layout renders EstateStrip (AM-29
 * item 26) on every route, which polls GET /v1/estate/summary via
 * getEstateSummary as soon as it mounts. Without this mock, every test in
 * this file was letting that call fall through to the real apiClient
 * (unmocked fetch in jsdom) — harmless in that no test asserted on its
 * result, but noisy (an unhandled rejection per test) and not a genuine
 * exercise of anything this file's tests care about. Resolves an empty
 * (all-fields-omitted) summary — EstateStrip renders "—" for every segment
 * in that case (see EstateStrip.test.tsx's own equivalent fixture).
 */
const getEstateSummary = vi.fn();
// AM-31 items 36/45: CommandPalette (mounted by Layout, conditionally on Ctrl/Cmd+K) fetches these two on open.
const getSessionHosts = vi.fn();
const getCurrentScalingPlan = vi.fn();
// AM-32 (M8-W3): RecentActionsDrawer (mounted by Layout, conditionally on opening it) fetches this on open.
const getRecentAuditEntries = vi.fn();
vi.mock('../api/avd', () => ({
  getEstateSummary: (...args: unknown[]) => getEstateSummary(...args),
  getSessionHosts: (...args: unknown[]) => getSessionHosts(...args),
  getCurrentScalingPlan: (...args: unknown[]) => getCurrentScalingPlan(...args),
  getRecentAuditEntries: (...args: unknown[]) => getRecentAuditEntries(...args),
}));

const { default: Layout } = await import('./Layout');
const { default: PageHeader } = await import('./PageHeader');

/** AM-31 item 36 — a minimal page rendering PageHeader with a real onRefresh, to verify the `r` shortcut reaches whatever the CURRENTLY MOUNTED page registered. */
function PageHeaderProbe({ onRefresh }: { onRefresh: () => void }) {
  return (
    <div>
      <PageHeader title="Probe" onRefresh={onRefresh} />
      <div>probe content</div>
    </div>
  );
}

function authState(overrides: Partial<AuthState> = {}): AuthState {
  return { loading: false, isAuthenticated: true, userDetails: 'operator@contoso.example', roles: ['operator'], role: 'operator', ...overrides };
}

/**
 * AM-15 (M7) / AM-29 — exercises the ACTUAL Layout theme-toggle Menu (not a
 * bare `useThemeMode()` probe — see theme/AppThemeProvider.test.tsx for
 * those unit tests). Wrapped in the real AppThemeProvider (not just
 * FluentProvider, unlike renderWithProviders.tsx) since the identity menu's
 * theme submenu reads useThemeMode from it, and in a matched Route
 * (mirroring App.tsx's shape) since Layout renders an <Outlet />.
 */
function renderLayout() {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <AppThemeProvider>
        <Routes>
          <Route element={<Layout />}>
            <Route index element={<div>page content</div>} />
          </Route>
        </Routes>
      </AppThemeProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  getEstateSummary.mockReset().mockResolvedValue({ generatedAt: new Date().toISOString(), hostPoolName: 'HP-CONTOSO-PROD' });
  getSessionHosts.mockReset().mockResolvedValue([]);
  getCurrentScalingPlan.mockReset().mockResolvedValue({ id: 'p1', name: 'plan', hostPoolName: 'HP-CONTOSO-PROD', timeZone: 'UTC', enabled: true, schedules: [] });
  getRecentAuditEntries.mockReset().mockResolvedValue({ entries: [], truncated: false, sinceHours: 24 });
});

describe('Layout — grouped navigation (AM-29 item 8)', () => {
  beforeEach(() => {
    window.localStorage.clear();
    useAuth.mockReturnValue(authState());
  });

  it('groups nav items under Operate/Plan/Administer section headers', () => {
    renderLayout();
    expect(screen.getByRole('heading', { name: 'Operate' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Plan' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Administer' })).toBeInTheDocument();
  });

  it('shows an Audit nav item under Administer, before Settings (AM-32 restores it)', () => {
    renderLayout();
    const auditLink = screen.getByRole('link', { name: 'Audit' });
    expect(auditLink).toHaveAttribute('href', '/audit');
    const settingsLink = screen.getByRole('link', { name: 'Settings' });
    // DOM order within the Administer section: Audit comes before Settings — compareDocumentPosition's DOCUMENT_POSITION_FOLLOWING bit (4) set means settingsLink follows auditLink.
    expect(Boolean(auditLink.compareDocumentPosition(settingsLink) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
  });

  it('still navigates on a plain click (regression: NavItem onClick must preventDefault + navigate)', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/']}>
        <AppThemeProvider>
          <Routes>
            <Route element={<Layout />}>
              <Route index element={<div>dashboard content</div>} />
              <Route path="host-pools" element={<div>host pool content</div>} />
            </Route>
          </Routes>
        </AppThemeProvider>
      </MemoryRouter>,
    );
    await user.click(screen.getByRole('link', { name: /host pool/i }));
    expect(await screen.findByText('host pool content')).toBeInTheDocument();
  });
});

describe('Layout — identity menu (AM-29 items 9/U1/U2)', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('shows the signed-in user and their role', () => {
    useAuth.mockReturnValue(authState({ userDetails: 'operator@contoso.example', role: 'operator' }));
    renderLayout();
    expect(screen.getByText('operator@contoso.example')).toBeInTheDocument();
    expect(screen.getByText('operator')).toBeInTheDocument();
  });

  it('opens to reveal Settings and Sign out (the theme toggle moved to the estate strip — user direction 2026-08-16)', async () => {
    const user = userEvent.setup();
    useAuth.mockReturnValue(authState());
    renderLayout();

    await user.click(screen.getByText('operator@contoso.example'));
    expect(screen.getByRole('menuitem', { name: /settings/i })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /theme/i })).not.toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /sign out/i })).toBeInTheDocument();
  });

  it('the estate-strip theme toggle lists System/Light/Dark with the current (dark default) mode checked, and persists a selection', async () => {
    const user = userEvent.setup();
    useAuth.mockReturnValue(authState());
    renderLayout();

    // The toggle renders inside the EstateStrip region, before "As of".
    const strip = screen.getByRole('region', { name: /estate status/i });
    await user.click(within(strip).getByRole('button', { name: /theme:/i }));

    const themeMenu = screen.getByRole('menu');
    expect(within(themeMenu).getByRole('menuitemradio', { name: /^dark$/i })).toHaveAttribute('aria-checked', 'true');

    await user.click(within(themeMenu).getByRole('menuitemradio', { name: /^light$/i }));
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe('light');
  });

  it('Sign out navigates to /.auth/logout as a full-page navigation, not an SPA route', async () => {
    const user = userEvent.setup();
    useAuth.mockReturnValue(authState());

    // jsdom's window.location.assign is non-configurable, so vi.spyOn can't
    // wrap it directly ("Cannot redefine property: assign") — replace the
    // whole `location` object for the duration of this test instead, same
    // workaround jsdom-based test suites commonly use for this exact case.
    const originalLocation = window.location;
    const assignMock = vi.fn();
    Object.defineProperty(window, 'location', { value: { ...originalLocation, assign: assignMock }, writable: true, configurable: true });

    try {
      renderLayout();
      await user.click(screen.getByText('operator@contoso.example'));
      await user.click(screen.getByRole('menuitem', { name: /sign out/i }));
      expect(assignMock).toHaveBeenCalledWith('/.auth/logout');
    } finally {
      Object.defineProperty(window, 'location', { value: originalLocation, writable: true, configurable: true });
    }
  });
});

describe('Layout — no-role screen (AM-29 item 7)', () => {
  it('shows NoRoleScreen instead of the nav/Outlet when authenticated with no role', () => {
    useAuth.mockReturnValue(authState({ role: null, roles: [], userDetails: 'newhire@contoso.example' }));
    renderLayout();

    expect(screen.getByText(/don't have access/i)).toBeInTheDocument();
    expect(screen.queryByText('page content')).not.toBeInTheDocument();
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
  });

  it('renders the normal shell (not NoRoleScreen) while auth is still loading', () => {
    useAuth.mockReturnValue(authState({ loading: true, role: null, roles: [] }));
    renderLayout();
    expect(screen.queryByText(/don't have access/i)).not.toBeInTheDocument();
    expect(screen.getByText('page content')).toBeInTheDocument();
  });

  it('renders the normal shell for a resolved role', () => {
    useAuth.mockReturnValue(authState({ role: 'viewer', roles: ['viewer'] }));
    renderLayout();
    expect(screen.queryByText(/don't have access/i)).not.toBeInTheDocument();
    expect(screen.getByText('page content')).toBeInTheDocument();
  });
});

/** AM-31 item 34 — sets window.innerWidth and fires a resize event, same pattern useViewportWidth.ts's listener expects. */
function setViewportWidth(width: number) {
  Object.defineProperty(window, 'innerWidth', { value: width, writable: true, configurable: true });
  window.dispatchEvent(new Event('resize'));
}

describe('Layout — responsive nav (AM-31 item 34)', () => {
  const ORIGINAL_WIDTH = window.innerWidth;

  beforeEach(() => {
    window.localStorage.clear();
    useAuth.mockReturnValue(authState());
  });

  afterEach(() => {
    setViewportWidth(ORIGINAL_WIDTH);
  });

  it('shows full labelled nav at wide viewports by default', () => {
    setViewportWidth(1200);
    renderLayout();
    expect(screen.getByRole('link', { name: 'Dashboard' })).toHaveTextContent('Dashboard');
    expect(screen.getByText('AVD Manager')).toBeInTheDocument();
  });

  it('collapses to an icon-only rail below 1000px, keeping each nav item reachable by its aria-label', () => {
    setViewportWidth(800);
    renderLayout();
    const dashboardLink = screen.getByRole('link', { name: 'Dashboard' });
    expect(dashboardLink).toBeInTheDocument();
    // Icon-only: the link's accessible name comes from aria-label, not visible text content.
    expect(dashboardLink).toHaveAttribute('aria-label', 'Dashboard');
  });

  it('becomes a closed overlay drawer below 700px, with a top-bar button to open it', () => {
    setViewportWidth(500);
    renderLayout();
    // The overlay starts closed — nav items are not present until opened.
    expect(screen.queryByRole('link', { name: 'Dashboard' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open navigation' })).toBeInTheDocument();
  });

  it('opens the overlay drawer via the top-bar button, and the historical nav-click fix still navigates', async () => {
    const user = userEvent.setup();
    setViewportWidth(500);
    render(
      <MemoryRouter initialEntries={['/']}>
        <AppThemeProvider>
          <Routes>
            <Route element={<Layout />}>
              <Route index element={<div>dashboard content</div>} />
              <Route path="host-pools" element={<div>host pool content</div>} />
            </Route>
          </Routes>
        </AppThemeProvider>
      </MemoryRouter>,
    );

    await user.click(screen.getByRole('button', { name: 'Open navigation' }));
    const hostPoolLink = await screen.findByRole('link', { name: /host pool/i });
    await user.click(hostPoolLink);
    expect(await screen.findByText('host pool content')).toBeInTheDocument();
    // Navigating closes the overlay again (same click handler — see
    // handleNavItemClick) — `setOverlayOpen(false)` flips synchronously,
    // but Fluent's OverlayDrawer is a MOTION-based Presence component (see
    // @fluentui/react-drawer's useOverlayDrawer — surfaceMotion wraps
    // OverlayDrawerMotion): its content unmounts asynchronously once the
    // exit animation completes, not in the same tick as the state update.
    // Peer review (Opus, MAJOR 2) — a synchronous queryByRole here raced
    // that async unmount (reliably fine when the animation-frame callback
    // resolves quickly, flaky when system load delays it — exactly the
    // "fails under a full-suite run, passes in isolation" pattern this test
    // exhibited); `waitFor` gives the motion's own completion the room it
    // needs instead of asserting on a single synchronous tick.
    await waitFor(() => {
      expect(screen.queryByRole('link', { name: /host pool/i })).not.toBeInTheDocument();
    });
  });

  it('persists the manual collapse toggle across renders, like theme mode', async () => {
    const user = userEvent.setup();
    setViewportWidth(1200);
    const { unmount } = renderLayout();

    const collapseButton = screen.getByRole('button', { name: 'Collapse navigation' });
    expect(collapseButton).not.toBeDisabled();
    await user.click(collapseButton);

    expect(window.localStorage.getItem('avdmgr.navCollapsed')).toBe('true');
    unmount();

    renderLayout();
    expect(screen.getByRole('link', { name: 'Dashboard' })).toHaveAttribute('aria-label', 'Dashboard');
  });

  it('disables the manual-collapse toggle in the auto-collapsed rail band (700-999px)', () => {
    setViewportWidth(800);
    renderLayout();
    expect(screen.getByRole('button', { name: 'Collapse navigation' })).toBeDisabled();
  });
});

describe('Layout — keyboard shortcuts (AM-31 items 36/45)', () => {
  beforeEach(() => {
    useAuth.mockReturnValue(authState());
  });

  function renderLayoutWithPages() {
    return render(
      <MemoryRouter initialEntries={['/']}>
        <AppThemeProvider>
          <Routes>
            <Route element={<Layout />}>
              <Route index element={<div>dashboard content</div>} />
              <Route path="host-pools" element={<div>host pool content</div>} />
            </Route>
          </Routes>
        </AppThemeProvider>
      </MemoryRouter>,
    );
  }

  it('a "g h" chord navigates to Host Pool', async () => {
    const user = userEvent.setup();
    renderLayoutWithPages();
    await user.keyboard('gh');
    expect(await screen.findByText('host pool content')).toBeInTheDocument();
  });

  it('a stale "g" prefix (unrelated later key) does not navigate', async () => {
    // Peer review MINOR 16 — replaces a real 1600ms sleep (the chord window
    // is 1500ms — see useKeyboardShortcuts.ts's CHORD_WINDOW_MS) with a
    // Date.now() spy, NOT vi.useFakeTimers(): the chord's own expiry check
    // reads Date.now() directly (not a scheduled setTimeout callback), so
    // only Date.now needs to lie — full fake timers would also virtualize
    // every setTimeout/setInterval this render tree uses (usePolling,
    // userEvent's own internal delays, etc.), which hung this exact test
    // (and, worse, every test after it in this file — see this fix's own
    // history) rather than actually speeding anything up.
    const user = userEvent.setup();
    renderLayoutWithPages();
    const realNow = Date.now;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => realNow());
    try {
      await user.keyboard('g');
      // Simulate the 1500ms chord window having elapsed, without an actual sleep.
      nowSpy.mockImplementation(() => realNow() + 1600);
      await user.keyboard('h');
      expect(screen.queryByText('host pool content')).not.toBeInTheDocument();
      expect(screen.getByText('dashboard content')).toBeInTheDocument();
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('"?" opens the keyboard shortcuts help dialog, listing every nav shortcut', async () => {
    const user = userEvent.setup();
    renderLayoutWithPages();
    await user.keyboard('?');
    expect(await screen.findByRole('heading', { name: 'Keyboard shortcuts' })).toBeInTheDocument();
    expect(screen.getByText('g d')).toBeInTheDocument();
    expect(screen.getByText('g h')).toBeInTheDocument();
  });

  it('Ctrl+K opens the command palette', async () => {
    const user = userEvent.setup();
    renderLayoutWithPages();
    await user.keyboard('{Control>}k{/Control}');
    expect(await screen.findByRole('combobox', { name: 'Command palette' })).toBeInTheDocument();
  });

  it('suppresses shortcuts while focus is in a text input (e.g. does not treat typed "g" "h" as a chord)', async () => {
    const user = userEvent.setup();
    renderLayoutWithPages();
    // The identity menu's search-adjacent Input isn't present on this bare test route, so use the command-palette's own Input as the "focus is in a text field" probe instead — same suppression check.
    await user.keyboard('{Control>}k{/Control}');
    const combobox = await screen.findByRole('combobox', { name: 'Command palette' });
    await user.type(combobox, 'gh');
    // Typing "gh" while focused in the palette's own input must filter text, not trigger a "g h" navigation chord underneath it.
    expect(combobox).toHaveValue('gh');
    expect(screen.getByText('dashboard content')).toBeInTheDocument();
  });

  it('"r" refreshes the current page via PageHeader\'s registered onRefresh', async () => {
    const user = userEvent.setup();
    const onRefresh = vi.fn();
    render(
      <MemoryRouter initialEntries={['/']}>
        <AppThemeProvider>
          <Routes>
            <Route element={<Layout />}>
              <Route
                index
                element={
                  <PageHeaderProbe onRefresh={onRefresh} />
                }
              />
            </Route>
          </Routes>
        </AppThemeProvider>
      </MemoryRouter>,
    );
    await screen.findByText('probe content');
    await user.keyboard('r');
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });
});

describe('Layout — skip link and background token (AM-29 items 3-4)', () => {
  beforeEach(() => {
    useAuth.mockReturnValue(authState());
  });

  it('renders a "Skip to main content" link targeting #main', () => {
    renderLayout();
    const skipLink = screen.getByRole('link', { name: /skip to main content/i });
    expect(skipLink).toHaveAttribute('href', '#main');
  });

  it('renders <main id="main"> as a focusable landmark', () => {
    renderLayout();
    const main = document.getElementById('main');
    expect(main).not.toBeNull();
    expect(main).toHaveAttribute('tabindex', '-1');
  });
});

describe('Layout — Recent actions drawer (AM-32)', () => {
  beforeEach(() => {
    useAuth.mockReturnValue(authState());
  });

  it('the EstateStrip History button opens the drawer, fetching on open', async () => {
    const user = userEvent.setup();
    renderLayout();
    await user.click(await screen.findByRole('button', { name: 'Recent actions' }));
    expect(await screen.findByRole('heading', { name: 'Recent actions' })).toBeInTheDocument();
    expect(getRecentAuditEntries).toHaveBeenCalledWith({ top: 25, sinceHours: 24 }, expect.anything());
  });

  it('CommandPalette\'s "Recent actions" action opens the SAME drawer', async () => {
    const user = userEvent.setup();
    renderLayout();
    await user.keyboard('{Control>}k{/Control}');
    // Peer review (Opus, MAJOR 2) — role-scoped (CommandPalette.tsx renders
    // this item as `role="option"`), not a page-wide text query: a bare
    // `findByText('Recent actions')` is only ever ONE character away from
    // colliding with the EstateStrip History button's OWN "Recent actions"
    // accessible name (icon-only, aria-label + a `relationship="label"`
    // Tooltip) the moment that button's implementation details shift even
    // slightly — targeting the specific listbox option this test actually
    // means to click removes that whole class of ambiguity, not just the
    // one path that happened to hit it.
    await user.click(await screen.findByRole('option', { name: 'Recent actions' }));
    expect(await screen.findByRole('heading', { name: 'Recent actions' })).toBeInTheDocument();
  });

  it('the drawer is not present until opened, and closes on its own close button', async () => {
    const user = userEvent.setup();
    renderLayout();
    expect(screen.queryByRole('heading', { name: 'Recent actions' })).not.toBeInTheDocument();

    await user.click(await screen.findByRole('button', { name: 'Recent actions' }));
    await screen.findByRole('heading', { name: 'Recent actions' });

    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('heading', { name: 'Recent actions' })).not.toBeInTheDocument();
  });

  it('a viewer sees neither the EstateStrip trigger nor the palette action', async () => {
    const user = userEvent.setup();
    useAuth.mockReturnValue(authState({ role: 'viewer', roles: ['viewer'] }));
    renderLayout();
    await screen.findByText(/hosts/i);
    expect(screen.queryByRole('button', { name: 'Recent actions' })).not.toBeInTheDocument();

    await user.keyboard('{Control>}k{/Control}');
    await screen.findByRole('combobox', { name: 'Command palette' });
    expect(screen.queryByText('Recent actions')).not.toBeInTheDocument();
  });
});
