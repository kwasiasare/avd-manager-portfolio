import { useEffect, useRef, useState } from 'react';
import { ApiClientError } from '../api/client';

export interface SingleFetchState<T> {
  data: T | undefined;
  error: ApiClientError | Error | undefined;
  loading: boolean;
  /**
   * True while a fetch — the initial one, a re-fetch triggered by `deps`
   * changing, or a manual `refresh()` — is in flight. AM-32 peer review
   * MINOR 5: mirrors usePolling's own `refreshing` flag (PollingState),
   * added because Audit.tsx (AM-32) drives this hook with filter state in
   * `deps` — without this, a filter change (or a manual refresh AFTER the
   * first successful load, when `loading` no longer flips) had no in-flight
   * signal at all: PageHeader's spinner stayed dark, a drawer's Refresh
   * button stayed clickable mid-request, and a table kept showing the
   * PREVIOUS filter's rows with nothing indicating they were about to be
   * replaced. Unlike `loading` (true only for the very FIRST fetch, so a
   * background refresh doesn't flash a full skeleton), `refreshing` is true
   * for every subsequent fetch too — same split usePolling's own
   * loading/refreshing pair makes.
   */
  refreshing: boolean;
  refresh: () => void;
}

interface State<T> {
  data?: T;
  error?: ApiClientError | Error;
  loading: boolean;
  refreshing: boolean;
}

/**
 * Fetches `fetcher` on mount, again whenever `deps` changes, and again on
 * manual `refresh()` — AM-15 (M7) peer review MINOR: Settings.tsx originally
 * reused `usePolling` (see that hook's own doc comment) for this, but
 * everything GET /v1/settings returns is a Function App setting that cannot
 * change without a redeploy — polling it every few minutes wakes a
 * scale-to-zero Flex Consumption plan for no reason. This hook is
 * `usePolling` with the INTERVAL removed (there is no setInterval here —
 * `deps` changing is what re-triggers a fetch for callers that need
 * filter-driven refetching, e.g. Audit.tsx), kept as its own small file
 * rather than a `usePolling(fetcher, Infinity)` call so a reader doesn't
 * have to reason about what an "infinite interval" means for `setInterval`.
 * Same AbortController-per-fetch/cancel-on-unmount behavior as usePolling.
 *
 * `refreshing` (AM-32 peer review MINOR 5) needs to flip true the instant a
 * NEW fetch starts — including one triggered purely by `deps` changing
 * (e.g. Audit.tsx's filter Dropdowns), which has no separate "trigger
 * callback" the way usePolling's interval-tick/visibilitychange/refresh()
 * triggers do (see that hook's own doc comment for why ITS `refreshing` is
 * set by the trigger, not the effect body: react-hooks/set-state-in-effect
 * flags a bare setState call inside an effect body as a "cascading
 * renders" risk — confirmed by running this exact hook past that rule).
 * Since a `deps` change has no separate trigger function to hook a
 * setState into, this uses React's own documented "adjust state while
 * rendering" pattern instead (https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes)
 * — comparing THIS render's `[tick, ...deps]` against what the fetch
 * effect last actually ran for (kept in `useState`, NOT `useRef` — this
 * codebase's react-hooks lint config additionally forbids reading/writing
 * a ref's `.current` during render at all, confirmed by running this exact
 * hook past it, stricter than the plain React docs example) and calling
 * `setState` synchronously DURING RENDER (not inside `useEffect`) when
 * they differ. React re-renders immediately when state changes during the
 * render phase itself, before committing/painting — that is the specific
 * case react-hooks/set-state-in-effect does NOT flag (it targets setState
 * calls from WITHIN an effect body/callback, not from a component's own
 * render). `prevFetchKey` is updated unconditionally inside the same
 * branch, so this bails out (no further setState) on the very next render
 * once the flag has caught up — same termination shape as the React docs'
 * example.
 */
export function useSingleFetch<T>(fetcher: (signal: AbortSignal) => Promise<T>, deps: unknown[] = []): SingleFetchState<T> {
  const [state, setState] = useState<State<T>>({ loading: true, refreshing: true });
  const [tick, setTick] = useState(0);
  const fetcherRef = useRef(fetcher);

  useEffect(() => {
    fetcherRef.current = fetcher;
  });

  const fetchKey = [tick, ...deps];
  const [prevFetchKey, setPrevFetchKey] = useState(fetchKey);
  const fetchKeyChanged = fetchKey.length !== prevFetchKey.length || fetchKey.some((value, index) => value !== prevFetchKey[index]);
  if (fetchKeyChanged) {
    setPrevFetchKey(fetchKey);
    if (!state.refreshing) {
      setState((prev) => ({ ...prev, refreshing: true }));
    }
  }

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();

    fetcherRef
      .current(controller.signal)
      .then((result) => {
        if (cancelled) return;
        setState((prev) => ({ ...prev, data: result, error: undefined }));
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setState((prev) => ({ ...prev, error: err instanceof Error ? err : new Error(String(err)) }));
      })
      .finally(() => {
        if (cancelled) return;
        setState((prev) => ({ ...prev, loading: false, refreshing: false }));
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `tick` is the intentional re-fetch trigger; `deps` lets callers add their own.
  }, [tick, ...deps]);

  const refresh = () => {
    setState((prev) => ({ ...prev, loading: prev.data === undefined, refreshing: true }));
    setTick((t) => t + 1);
  };

  return { data: state.data, error: state.error, loading: state.loading, refreshing: state.refreshing, refresh };
}
