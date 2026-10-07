import { createContext, useContext } from 'react';

/**
 * Peer review (Opus, MINOR item 14) — split out of
 * components/ColdStartHintProvider.tsx. That file mixing a component
 * export (ColdStartHintProvider) with a hook export (useColdStartHintClaim)
 * tripped ESLint's react-refresh/only-export-components rule: Fast Refresh
 * can only safely hot-reload a file whose exports are ALL components. The
 * context lives here too (not in ColdStartHintProvider.tsx) since the
 * provider component and this hook both need the SAME context instance —
 * see ColdStartHintProvider's own doc comment for what this whole
 * mechanism is for (AM-29 item 13, deduping the cold-start hint across a
 * page's several simultaneous AsyncState instances).
 */
export const ColdStartHintContext = createContext<(() => boolean) | undefined>(undefined);

/**
 * Returns a function that, called once, returns true for exactly the FIRST
 * caller within the nearest <ColdStartHintProvider> and false for every
 * subsequent caller — or `undefined` when there's no provider in scope, in
 * which case AsyncState treats every instance as free to claim (its
 * original behavior).
 */
export function useColdStartHintClaim(): (() => boolean) | undefined {
  return useContext(ColdStartHintContext);
}
