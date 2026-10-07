/**
 * AM-60 — tiny, fixture-free side channel between the demo transport and the
 * shared toast helper (lib/toaster.ts). The transport calls markSimulated()
 * when a simulated mutation succeeds; the toast wrapper asks
 * wasJustSimulated() to decide whether to append the "Simulated — not
 * applied" line to the toast the page is about to show (pages dispatch their
 * success toast immediately after `await`ing the mutation).
 */
export const SIMULATED_TOAST_TEXT = 'Simulated — not applied to any Azure resource';

const RECENT_WINDOW_MS = 4_000;
let lastSimulatedAt = 0;

export function markSimulated(): void {
  lastSimulatedAt = Date.now();
}

export function wasJustSimulated(): boolean {
  return Date.now() - lastSimulatedAt < RECENT_WINDOW_MS;
}

/**
 * AM-60 review fix — one-shot read: the toast wrapper consumes the signal so
 * exactly one toast per simulated mutation carries the suffix (a second
 * toast inside the 4 s window, e.g. after an unrelated action, does not).
 */
export function consumeSimulated(): boolean {
  const recent = wasJustSimulated();
  lastSimulatedAt = 0;
  return recent;
}

export function clearSimulated(): void {
  lastSimulatedAt = 0;
}
