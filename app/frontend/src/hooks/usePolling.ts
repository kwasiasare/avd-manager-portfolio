import { useEffect, useRef, useState } from 'react';
import { ApiClientError } from '../api/client';

export interface PollingState<T> {
  data: T | undefined;
  error: ApiClientError | Error | undefined;
  /** True only for the very first (in-flight, no data yet) fetch — not set again on subsequent polls, so the UI doesn't flash a full skeleton every 60s. */
  loading: boolean;
  /** True while a background refresh (poll or manual) is in flight after the first successful load. */
  refreshing: boolean;
  /** AM-29 items 21/27: wall-clock instant of the most recent SUCCESSFUL fetch — undefined until the first one resolves. Feeds PageHeader's "as of HH:MM" display; a failed poll never updates this (last-good data stays paired with the instant it was actually good as of). */
  lastUpdated: Date | undefined;
  refresh: () => void;
}

interface State<T> {
  data?: T;
  error?: ApiClientError | Error;
  loading: boolean;
  refreshing: boolean;
  lastUpdated?: Date;
}

/**
 * Peer review (Opus, MINOR item 10) — ONE shared, module-level
 * visibilitychange listener, fanned out to every mounted usePolling
 * instance's own catch-up-refetch callback, instead of each instance
 * registering its own document.addEventListener. A page like the
 * Dashboard mounts SEVEN polling widgets at once; the tab-re-show burst
 * this was already meant to trigger a refetch for (AM-29 item 6) still
 * fires seven refetches — they poll seven different endpoints, and all
 * seven genuinely need refreshing — but that now happens via ONE native
 * listener instead of seven independently-registered ones responding to
 * the same event.
 */
const visibilityChangeSubscribers = new Set<() => void>();
let visibilityChangeListenerAttached = false;

function ensureVisibilityChangeListenerAttached(): void {
  if (visibilityChangeListenerAttached || typeof document === 'undefined') return;
  visibilityChangeListenerAttached = true;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    for (const subscriber of visibilityChangeSubscribers) {
      subscriber();
    }
  });
}

/**
 * Polls `fetcher` every `intervalMs` (default 60s, per the Dashboard's
 * polling requirement) starting immediately on mount, and again on manual
 * `refresh()`. Each poll/refresh gets its own AbortController, whose signal
 * is passed to `fetcher` (which forwards it into apiClient/fetch — see
 * src/api/avd.ts) and aborted on cleanup (unmount, or a newer poll/refresh
 * superseding an in-flight one) — the underlying HTTP request is actually
 * cancelled, not just its result ignored. A failed poll keeps the last-good
 * `data` in place (so a transient error, including a benign abort, doesn't
 * blank out the whole widget) while still surfacing `error` for a small
 * inline warning.
 *
 * `refreshing` is flipped to true by the *trigger* (the interval tick or a
 * manual refresh() call), not synchronously inside the fetch effect — the
 * fetch effect itself only calls setState from its .then/.catch/.finally
 * callbacks, keeping it compliant with react-hooks' set-state-in-effect
 * rule (calling setState synchronously in an effect body risks cascading
 * renders; here it never needs to).
 */
export function usePolling<T>(fetcher: (signal: AbortSignal) => Promise<T>, intervalMs = 60_000, deps: unknown[] = []): PollingState<T> {
  const [state, setState] = useState<State<T>>({ loading: true, refreshing: true });
  const [tick, setTick] = useState(0);
  const fetcherRef = useRef(fetcher);

  useEffect(() => {
    fetcherRef.current = fetcher;
  });

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();

    fetcherRef
      .current(controller.signal)
      .then((result) => {
        if (cancelled) return;
        setState((prev) => ({ ...prev, data: result, error: undefined, lastUpdated: new Date() }));
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

  useEffect(() => {
    const interval = setInterval(() => {
      // AM-29 item 6: skip the tick entirely while the tab/window is hidden
      // — a background tab has no reason to keep waking a scale-to-zero
      // Flex Consumption Function App (and the Dashboard's 6 polling
      // widgets specifically) every 60s when nobody can see the result. The
      // timer itself keeps running (cheap, and avoids the churn of tearing
      // down/recreating it on every visibility flip); only the fetch it
      // would trigger is paused. See the visibilitychange effect below for
      // the catch-up refetch once the tab is shown again.
      if (document.visibilityState === 'hidden') {
        return;
      }
      setState((prev) => ({ ...prev, refreshing: true }));
      setTick((t) => t + 1);
    }, intervalMs);
    return () => clearInterval(interval);
  }, [intervalMs]);

  // AM-29 item 6: one refetch immediately on re-show, rather than making the
  // user wait up to a full `intervalMs` for data that may now be stale.
  // visibilitychange only fires on an actual hidden<->visible transition, so
  // this never double-fires on mount alongside the initial fetch effect
  // above. Peer review (Opus, MINOR item 10): subscribes to the shared
  // module-level listener above instead of registering its own — see that
  // listener's doc comment.
  useEffect(() => {
    ensureVisibilityChangeListenerAttached();
    function onVisible() {
      setState((prev) => ({ ...prev, refreshing: true }));
      setTick((t) => t + 1);
    }
    visibilityChangeSubscribers.add(onVisible);
    return () => {
      visibilityChangeSubscribers.delete(onVisible);
    };
  }, []);

  const refresh = () => {
    setState((prev) => ({ ...prev, refreshing: true }));
    setTick((t) => t + 1);
  };

  return { data: state.data, error: state.error, loading: state.loading, refreshing: state.refreshing, lastUpdated: state.lastUpdated, refresh };
}
