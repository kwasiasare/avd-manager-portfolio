import { createContext, useContext } from 'react';
import { DarkTheme20Regular, WeatherMoon20Regular, WeatherSunny20Regular, type FluentIcon } from '@fluentui/react-icons';

/**
 * Peer review (Opus, MINOR item 14) — split out of AppThemeProvider.tsx.
 * That file mixing a component default export (AppThemeProvider) with
 * value exports (THEME_MODE_OPTIONS, useThemeMode) tripped ESLint's
 * react-refresh/only-export-components rule: Fast Refresh can only safely
 * hot-reload a file whose exports are ALL components — a non-component
 * value export forces a full reload of every consumer instead. This module
 * holds every non-component export that used to live there; the context
 * itself lives here too (not in AppThemeProvider.tsx) since useThemeMode
 * and the provider component both need the SAME context instance.
 */
export type ThemeMode = 'system' | 'light' | 'dark';

/** AM-29 user direction 2026-08-16: the app DEFAULTS to the mockup dark (slate) theme — a first-run user gets the mockup look, not their OS preference. 'system' remains selectable in the toggle for anyone who wants OS-following behavior back. */
export const DEFAULT_THEME_MODE: ThemeMode = 'dark';

/**
 * AM-29 items 9/U1/U2 — the single source of truth for the three theme
 * choices' labels/icons, shared by every UI that lets the user pick a mode:
 * Layout's identity-menu theme submenu AND Settings' "Appearance" card
 * radio group (previously only Layout's NavDrawerHeader had this list,
 * which item U1 explicitly asks to "move/share, don't duplicate"). Neither
 * consumer keeps its own copy of the option list, and both read/write the
 * SAME state via useThemeMode below — there is exactly one ThemeMode value
 * in the app, never two independently-tracked toggles.
 */
export const THEME_MODE_OPTIONS: ReadonlyArray<{ value: ThemeMode; label: string; icon: FluentIcon }> = [
  { value: 'system', label: 'Use system setting', icon: DarkTheme20Regular },
  { value: 'light', label: 'Light', icon: WeatherSunny20Regular },
  { value: 'dark', label: 'Dark', icon: WeatherMoon20Regular },
];

export interface ThemeModeState {
  /** The user's chosen preference — 'system' follows the OS, 'light'/'dark' pin it explicitly. */
  mode: ThemeMode;
  /** The theme actually rendered right now (resolves 'system' against the live OS preference). */
  resolved: 'light' | 'dark';
  setMode: (mode: ThemeMode) => void;
}

export const ThemeModeContext = createContext<ThemeModeState | undefined>(undefined);

/** Reads the theme mode / setter exposed by the nearest <AppThemeProvider> — used by Layout's theme toggle. */
export function useThemeMode(): ThemeModeState {
  const context = useContext(ThemeModeContext);
  if (!context) {
    throw new Error('useThemeMode must be used within AppThemeProvider');
  }
  return context;
}
