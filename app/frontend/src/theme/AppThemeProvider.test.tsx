import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AppThemeProvider from './AppThemeProvider';
import { useThemeMode } from './themeMode';

const STORAGE_KEY = 'avdmgr.themeMode';

/**
 * jsdom does not implement window.matchMedia (see src/test/setup.ts's
 * defensive stub, installed only when one doesn't already exist) — these
 * tests need a matchMedia they can both read the initial `matches` value
 * from AND fire a synthetic 'change' event through, which the setup.ts stub
 * deliberately doesn't support (it's a no-op fallback, not a working fake).
 * Each test installs its own on `window.matchMedia` and restores the prior
 * value in afterEach.
 */
function installMatchMedia(initialMatches: boolean) {
  let matches = initialMatches;
  let changeHandler: ((event: MediaQueryListEvent) => void) | null = null;
  const mql = {
    get matches() {
      return matches;
    },
    media: '(prefers-color-scheme: dark)',
    addEventListener: (_type: string, handler: (event: MediaQueryListEvent) => void) => {
      changeHandler = handler;
    },
    removeEventListener: () => {
      changeHandler = null;
    },
  } as unknown as MediaQueryList;

  window.matchMedia = (() => mql) as unknown as typeof window.matchMedia;

  return {
    setMatches: (value: boolean) => {
      matches = value;
      changeHandler?.({ matches: value } as MediaQueryListEvent);
    },
  };
}

function Probe() {
  const { mode, resolved, setMode } = useThemeMode();
  return (
    <div>
      <span data-testid="mode">{mode}</span>
      <span data-testid="resolved">{resolved}</span>
      <button onClick={() => setMode('dark')}>set-dark</button>
      <button onClick={() => setMode('light')}>set-light</button>
      <button onClick={() => setMode('system')}>set-system</button>
    </div>
  );
}

describe('AppThemeProvider / useThemeMode', () => {
  const originalMatchMedia = window.matchMedia;

  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    window.matchMedia = originalMatchMedia;
  });

  it('defaults to dark mode (the mockup slate theme — user direction 2026-08-16) when nothing is stored, regardless of the OS preference', () => {
    installMatchMedia(false); // OS says LIGHT — the app default must still be dark
    render(
      <AppThemeProvider>
        <Probe />
      </AppThemeProvider>,
    );
    expect(screen.getByTestId('mode')).toHaveTextContent('dark');
    expect(screen.getByTestId('resolved')).toHaveTextContent('dark');
  });

  it('reads a previously persisted explicit mode from localStorage on mount, overriding the OS preference', () => {
    window.localStorage.setItem(STORAGE_KEY, 'dark');
    installMatchMedia(false); // OS says light — persisted 'dark' must win
    render(
      <AppThemeProvider>
        <Probe />
      </AppThemeProvider>,
    );
    expect(screen.getByTestId('mode')).toHaveTextContent('dark');
    expect(screen.getByTestId('resolved')).toHaveTextContent('dark');
  });

  it('ignores an invalid persisted value and falls back to the dark default', () => {
    window.localStorage.setItem(STORAGE_KEY, 'not-a-real-mode');
    installMatchMedia(false);
    render(
      <AppThemeProvider>
        <Probe />
      </AppThemeProvider>,
    );
    expect(screen.getByTestId('mode')).toHaveTextContent('dark');
  });

  it('persists an explicit mode choice to localStorage when the user picks one', async () => {
    const user = userEvent.setup();
    installMatchMedia(false);
    render(
      <AppThemeProvider>
        <Probe />
      </AppThemeProvider>,
    );

    await user.click(screen.getByText('set-dark'));

    expect(screen.getByTestId('mode')).toHaveTextContent('dark');
    expect(screen.getByTestId('resolved')).toHaveTextContent('dark');
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe('dark');
  });

  it('live-updates the resolved theme when the OS preference changes while mode is "system"', () => {
    // 'system' is no longer the default (dark is) — persist it explicitly,
    // the way a user who picked "Use system setting" in the toggle would have.
    window.localStorage.setItem(STORAGE_KEY, 'system');
    const { setMatches } = installMatchMedia(false);
    render(
      <AppThemeProvider>
        <Probe />
      </AppThemeProvider>,
    );
    expect(screen.getByTestId('resolved')).toHaveTextContent('light');

    act(() => setMatches(true));

    expect(screen.getByTestId('resolved')).toHaveTextContent('dark');
  });

  it('throws when useThemeMode is called outside AppThemeProvider', () => {
    function Bare() {
      useThemeMode();
      return null;
    }
    expect(() => render(<Bare />)).toThrow();
  });
});
