import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { usePolling } from './usePolling';

/** Overrides the normally-readonly document.visibilityState for a test, and dispatches the visibilitychange event the hook listens for. */
function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
}

describe('usePolling — AM-29 item 6 (visibility-gated interval)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setVisibility('visible');
  });

  afterEach(() => {
    vi.useRealTimers();
    setVisibility('visible');
  });

  it('fetches immediately on mount regardless of visibility', async () => {
    const fetcher = vi.fn().mockResolvedValue('first');
    const { result } = renderHook(() => usePolling(fetcher, 60_000));

    await vi.waitFor(() => expect(result.current.loading).toBe(false));
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(result.current.data).toBe('first');
  });

  it('sets lastUpdated on a successful fetch, and leaves it untouched on a failed one (AM-29 items 21/27)', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce('first').mockRejectedValueOnce(new Error('boom'));
    const { result } = renderHook(() => usePolling(fetcher, 1_000));

    await vi.waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.lastUpdated).toBeInstanceOf(Date);
    const firstUpdated = result.current.lastUpdated;

    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(result.current.error).toBeDefined());
    // The failed poll must not clear or bump lastUpdated — last-good data stays paired with the instant it was actually good as of.
    expect(result.current.lastUpdated).toBe(firstUpdated);
    expect(result.current.data).toBe('first');
  });

  it('AM-39: manual refresh() after a failed fetch performs a genuine new fetch and clears the error on success — the failure-recovery path never wedges on the old error', async () => {
    const fetcher = vi.fn().mockRejectedValueOnce(new Error('cost summary timed out')).mockResolvedValueOnce('recovered');
    const { result } = renderHook(() => usePolling(fetcher, 60_000));

    await vi.waitFor(() => expect(result.current.error).toBeDefined());
    expect(result.current.data).toBeUndefined();
    expect(result.current.refreshing).toBe(false);

    result.current.refresh();
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(result.current.data).toBe('recovered'));

    expect(result.current.error).toBeUndefined();
    expect(result.current.refreshing).toBe(false);
    expect(result.current.loading).toBe(false);
  });

  it('AM-39: a SECOND failed refresh still tries again on the next refresh() — the error state never blocks a later refetch attempt', async () => {
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new Error('first failure'))
      .mockRejectedValueOnce(new Error('second failure'))
      .mockResolvedValueOnce('recovered');
    const { result } = renderHook(() => usePolling(fetcher, 60_000));

    await vi.waitFor(() => expect(result.current.error?.message).toBe('first failure'));

    result.current.refresh();
    await vi.waitFor(() => expect(result.current.error?.message).toBe('second failure'));
    expect(fetcher).toHaveBeenCalledTimes(2);

    result.current.refresh();
    await vi.waitFor(() => expect(result.current.data).toBe('recovered'));
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(result.current.error).toBeUndefined();
  });

  it('skips the scheduled poll while the tab is hidden', async () => {
    const fetcher = vi.fn().mockResolvedValue('data');
    renderHook(() => usePolling(fetcher, 1_000));
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));

    setVisibility('hidden');
    await vi.advanceTimersByTimeAsync(5_000);

    // Five 1s ticks elapsed while hidden — none should have triggered a fetch.
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('refetches once immediately when the tab becomes visible again', async () => {
    const fetcher = vi.fn().mockResolvedValue('data');
    renderHook(() => usePolling(fetcher, 60_000));
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));

    setVisibility('hidden');
    await vi.advanceTimersByTimeAsync(200_000); // well past the interval — must stay paused while hidden
    expect(fetcher).toHaveBeenCalledTimes(1);

    setVisibility('visible');
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
  });

  it('resumes normal interval polling once visible again', async () => {
    const fetcher = vi.fn().mockResolvedValue('data');
    renderHook(() => usePolling(fetcher, 1_000));
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));

    setVisibility('hidden');
    await vi.advanceTimersByTimeAsync(3_000);
    expect(fetcher).toHaveBeenCalledTimes(1);

    setVisibility('visible'); // catch-up fetch: call #2
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));

    await vi.advanceTimersByTimeAsync(1_000); // next regular tick: call #3
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(3));
  });
});

/**
 * Peer review (Opus, MINOR item 10) — one shared document-level
 * visibilitychange listener fanned out to every mounted instance, not one
 * registration per instance. Uses vi.resetModules() + a dynamic import per
 * test (rather than the static top-of-file import the rest of this file
 * uses) so each test gets its OWN fresh copy of usePolling's module-level
 * "listener already attached" state — otherwise a listener attached by an
 * earlier test in this file would make a later test's "exactly one
 * addEventListener call" assertion see zero.
 */
describe('usePolling — shared visibilitychange listener (peer review item 10)', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    setVisibility('visible');
  });

  afterEach(() => {
    vi.useRealTimers();
    setVisibility('visible');
    vi.resetModules();
  });

  it('registers at most one native visibilitychange listener no matter how many instances are mounted', async () => {
    const addEventListenerSpy = vi.spyOn(document, 'addEventListener');
    const { usePolling: freshUsePolling } = await import('./usePolling');
    const fetcherA = vi.fn().mockResolvedValue('a');
    const fetcherB = vi.fn().mockResolvedValue('b');
    const fetcherC = vi.fn().mockResolvedValue('c');

    renderHook(() => freshUsePolling(fetcherA, 60_000));
    renderHook(() => freshUsePolling(fetcherB, 60_000));
    renderHook(() => freshUsePolling(fetcherC, 60_000));
    await vi.waitFor(() => expect(fetcherA).toHaveBeenCalledTimes(1));

    const visibilityChangeCalls = addEventListenerSpy.mock.calls.filter(([eventName]) => eventName === 'visibilitychange');
    expect(visibilityChangeCalls).toHaveLength(1);

    addEventListenerSpy.mockRestore();
  });

  it('still refetches every mounted instance on the single shared tab-re-show event', async () => {
    const { usePolling: freshUsePolling } = await import('./usePolling');
    const fetcherA = vi.fn().mockResolvedValue('a');
    const fetcherB = vi.fn().mockResolvedValue('b');

    renderHook(() => freshUsePolling(fetcherA, 60_000));
    renderHook(() => freshUsePolling(fetcherB, 60_000));
    await vi.waitFor(() => expect(fetcherA).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(fetcherB).toHaveBeenCalledTimes(1));

    setVisibility('hidden');
    setVisibility('visible');

    await vi.waitFor(() => expect(fetcherA).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(fetcherB).toHaveBeenCalledTimes(2));
  });
});
