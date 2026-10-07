import { useCallback, useRef, type ReactNode } from 'react';
import { ColdStartHintContext } from '../hooks/useColdStartHintClaim';

/**
 * AM-29 item 13 — a page like the Dashboard mounts several AsyncState
 * instances that all start loading near-simultaneously; without this,
 * EVERY one of them independently notices it's been loading for 3s+ and
 * shows its own "Function App may be cold-starting" hint (see
 * AsyncState.tsx), which reads as 6 repeated copies of the same sentence
 * rather than one explanation for the whole page.
 *
 * Wrap a PAGE's content (not the persistent app shell — a fresh provider
 * per page visit is what makes "first AsyncState on THIS page" correct
 * across navigations) in <ColdStartHintProvider>; AsyncState instances
 * inside it call useColdStartHintClaim() (hooks/useColdStartHintClaim.ts —
 * peer review, Opus MINOR item 14: split out of this file so this file
 * exports only the component, see that hook's own doc comment) and only
 * the first one to actually hit the 3s threshold gets to show the hint.
 * AsyncState instances with no provider in scope (a page not yet wrapped)
 * fall back to always claiming — i.e. this component's original,
 * un-deduplicated per-instance behavior.
 */
export function ColdStartHintProvider({ children }: { children: ReactNode }) {
  const claimedRef = useRef(false);

  // Stable identity across renders (no dependencies) — every consumer gets
  // the same function reference for the lifetime of this provider instance.
  const claim = useCallback(() => {
    if (claimedRef.current) {
      return false;
    }
    claimedRef.current = true;
    return true;
  }, []);

  return <ColdStartHintContext.Provider value={claim}>{children}</ColdStartHintContext.Provider>;
}
