import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { FluentProvider } from '@fluentui/react-components';
import { appDarkTheme, appLightTheme } from './appThemes';
import { DEFAULT_THEME_MODE, ThemeModeContext, type ThemeMode, type ThemeModeState } from './themeMode';

const STORAGE_KEY = 'avdmgr.themeMode';
const VALID_MODES: readonly ThemeMode[] = ['system', 'light', 'dark'];

function isThemeMode(value: string | null): value is ThemeMode {
  return !!value && (VALID_MODES as readonly string[]).includes(value);
}

/** Reads the persisted theme mode, defaulting to DEFAULT_THEME_MODE (dark — see its doc comment; before 2026-08-16 this defaulted to 'system'). Guarded against localStorage being unavailable (e.g. a locked-down browser profile, private browsing in some engines) — falls back to the default rather than throwing. */
function readStoredMode(): ThemeMode {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return isThemeMode(stored) ? stored : DEFAULT_THEME_MODE;
  } catch {
    return DEFAULT_THEME_MODE;
  }
}

function writeStoredMode(mode: ThemeMode): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    // Best-effort persistence only — a write failure (quota, disabled storage)
    // must not break the in-session toggle, which still works via state.
  }
}

function prefersDark(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches === true;
}

/**
 * Wraps the app in Fluent UI's FluentProvider, switching between the
 * mockup-derived appLightTheme/appDarkTheme (theme/appThemes.ts — AM-29
 * user direction; previously Fluent's stock web themes). AM-15 (M7):
 * backed by a three-way mode (system/light/dark) persisted to
 * localStorage; since 2026-08-16 the DEFAULT is 'dark' (the mockup slate
 * look) rather than 'system' — 'system' remains selectable and still
 * live-updates if the user changes their OS theme while the app is open.
 *
 * Peer review (Opus, MINOR item 14): this file's non-component exports
 * (THEME_MODE_OPTIONS, useThemeMode, the ThemeMode/ThemeModeState types,
 * ThemeModeContext itself) moved to theme/themeMode.ts — see that file's
 * doc comment for why (react-refresh/only-export-components). This file
 * now exports ONLY the AppThemeProvider component.
 */
export default function AppThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>(readStoredMode);
  const [systemPrefersDark, setSystemPrefersDark] = useState(prefersDark);

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const handleChange = (event: MediaQueryListEvent) => setSystemPrefersDark(event.matches);
    media.addEventListener('change', handleChange);
    return () => media.removeEventListener('change', handleChange);
  }, []);

  // Peer review NIT fix: useCallback (empty deps — this closes over nothing
  // that changes between renders) so the function identity is stable across
  // renders, matching the useMemo below's own stability contract for
  // contextValue (every ThemeModeState consumer, e.g. Layout's ThemeToggle
  // Menu, gets a referentially stable setMode to depend on).
  const setMode = useCallback((next: ThemeMode) => {
    setModeState(next);
    writeStoredMode(next);
  }, []);

  const resolved: 'light' | 'dark' = mode === 'system' ? (systemPrefersDark ? 'dark' : 'light') : mode;

  const contextValue = useMemo<ThemeModeState>(() => ({ mode, resolved, setMode }), [mode, resolved, setMode]);

  return (
    <ThemeModeContext.Provider value={contextValue}>
      <FluentProvider theme={resolved === 'dark' ? appDarkTheme : appLightTheme} style={{ minHeight: '100vh', display: 'flex' }}>
        {children}
      </FluentProvider>
    </ThemeModeContext.Provider>
  );
}
