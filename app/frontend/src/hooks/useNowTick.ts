import { useEffect, useState } from 'react';

/**
 * AM-31 item 35 — a `Date` that re-renders its caller every `intervalMs`,
 * for live "elapsed since X" displays (the unified Stepper component's
 * current-step elapsed-time text) that need to keep ticking without their
 * own setInterval plumbing. Deliberately NOT built on usePolling (that hook
 * fetches data; this ticks a clock) and NOT keyed to real wall-clock
 * boundaries (a plain interval is enough for a "3m elapsed" label — nothing
 * here needs to land exactly on the minute).
 *
 * AM-31 peer review MINOR 9 — `enabled` (default true) gates the interval
 * itself: when false, no `setInterval` is ever created (or an existing one
 * is torn down), so a caller with nothing currently live to tick — e.g.
 * Stepper's steps are all done/upcoming, none `current` with a `startedAt`
 * — doesn't keep a 30s re-render loop running for no visible effect.
 */
export function useNowTick(intervalMs = 30_000, enabled = true): Date {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    if (!enabled) return undefined;
    const id = window.setInterval(() => setNow(new Date()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs, enabled]);

  return now;
}
