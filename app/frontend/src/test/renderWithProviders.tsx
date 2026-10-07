import type { ReactElement } from 'react';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { Toaster } from '@fluentui/react-components';
import AppThemeProvider from '../theme/AppThemeProvider';
import { ColdStartHintProvider } from '../components/ColdStartHintProvider';
import { TOASTER_ID } from '../lib/toaster';

/**
 * AM-15 (M7) — shared test wrapper for anything that needs Fluent's theming
 * context (tokens/makeStyles resolve against it) and react-router's context
 * (useNavigate/Link).
 *
 * AM-29: now wraps the REAL AppThemeProvider (previously a bare
 * FluentProvider) — enough call sites read useThemeMode directly now
 * (Layout's identity-menu theme submenu, Settings' Appearance card) that a
 * page/component smoke test needs that context to exist, not just Fluent's
 * own tokens. Behaviorally equivalent for every EXISTING test: AppThemeProvider
 * defaults to mode 'system', which resolves to 'light' given
 * src/test/setup.ts's window.matchMedia stub (`matches: false`) — the exact
 * same webLightTheme this helper rendered before. theme/AppThemeProvider.test.tsx
 * still owns the theme-mode-specific unit tests (localStorage persistence,
 * live OS-preference updates, etc.) — this helper just needs the context to
 * be present and correct-by-default, not to exercise every branch of it.
 *
 * Deliberately does NOT wrap AuthContext.Provider — AuthContext's default
 * value (createContext(INITIAL_STATE), see auth/AuthContext.tsx) is already
 * `{ loading: true, isAuthenticated: false, roles: [], role: null }`, which
 * is a perfectly valid state for a component under test; callers that need
 * a resolved identity instead `vi.mock('../auth/useAuth', ...)` and control
 * the return value per test (see RoleGate.test.tsx) — mocking the HOOK
 * rather than wrapping the real AuthContext.Provider, since the latter
 * isn't exported from auth/AuthContext.tsx (only AuthProvider/useAuth are).
 *
 * Peer review (Opus, MINOR item 12) — also mounts the app's one <Toaster>
 * (same TOASTER_ID Layout's real one uses — see lib/toaster.ts) and wraps
 * children in <ColdStartHintProvider>, matching what a component under
 * test actually has available to it inside the real app shell: any
 * component that calls useAppToast()/dispatchToast can now be exercised
 * end-to-end in a test (dispatch a toast, assert it actually renders —
 * Fluent's toast portal is keyed by toasterId, not DOM ancestry, so this
 * works even though Toaster and `ui` are siblings here, same as Layout.tsx),
 * and AsyncState's cold-start-hint dedup (AM-29 item 13) behaves the same
 * as it would on a real page instead of always falling back to its
 * no-provider-in-scope "every instance claims" behavior.
 */
export function renderWithProviders(ui: ReactElement) {
  return render(
    <MemoryRouter>
      <AppThemeProvider>
        <ColdStartHintProvider>{ui}</ColdStartHintProvider>
        <Toaster toasterId={TOASTER_ID} />
      </AppThemeProvider>
    </MemoryRouter>,
  );
}
