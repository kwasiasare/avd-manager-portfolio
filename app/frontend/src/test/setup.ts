/**
 * AM-15 (M7) — vitest setup, loaded once per test file (see
 * vitest.config.ts's setupFiles). Two responsibilities:
 *
 * 1. Registers @testing-library/jest-dom's matchers (toBeInTheDocument,
 *    toBeDisabled, etc.) against vitest's `expect`.
 * 2. Polyfills two browser APIs jsdom does not implement that Fluent UI v9
 *    reaches for internally — window.matchMedia (AppThemeProvider's
 *    prefers-color-scheme listener) and ResizeObserver (used by
 *    @fluentui/react-positioning for Tooltip/Menu/Popover placement,
 *    exercised by StatusBadge's Tooltip-forwarding test and Layout's theme
 *    Menu). Without these, any test that renders a component using them
 *    throws "window.matchMedia is not a function" / "ResizeObserver is not
 *    defined" — a jsdom environment gap, not an app bug.
 */
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

// testing-library's auto-cleanup-between-tests only self-registers when it
// detects test-framework globals (globalThis.afterEach) — this project
// deliberately does NOT set vitest's `test.globals: true` (keeps
// describe/it/expect explicit imports, no tsconfig "types" edit needed), so
// auto-detection never fires and the DOM from one test would otherwise leak
// into the next (e.g. two tests both asserting on <NotFound />'s text would
// see duplicate nodes). Registered explicitly instead.
afterEach(() => {
  cleanup();
});

if (typeof window !== 'undefined' && !window.matchMedia) {
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList;
}

if (typeof window !== 'undefined' && !window.ResizeObserver) {
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  window.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
}

// jsdom implements NodeFilter on its Window, but Vitest's jsdom environment
// does not copy every window property onto the bare global scope — Fluent's
// tabster dependency (focus management) references the bare global
// `NodeFilter` (not `window.NodeFilter`) inside a MutationObserver callback,
// which otherwise throws "NodeFilter is not defined" as soon as any Fluent
// component mounts (uncaught inside a MutationObserver callback, so it
// surfaces as a top-level unhandled error rather than a normal test failure).
if (typeof window !== 'undefined' && typeof globalThis.NodeFilter === 'undefined' && 'NodeFilter' in window) {
  (globalThis as unknown as { NodeFilter: unknown }).NodeFilter = (window as unknown as { NodeFilter: unknown }).NodeFilter;
}
