import { describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useSingleFetch } from './useSingleFetch';

/**
 * AM-32 peer review MINOR 5 — no prior test file existed for this hook;
 * these cover the new `refreshing` flag specifically (initial/first-load,
 * deps-change re-fetch, and manual refresh()), since that's the behavior
 * Audit.tsx and RecentActionsDrawer.tsx now depend on for their in-flight
 * UI state.
 */
describe('useSingleFetch — refreshing (AM-32 peer review MINOR 5)', () => {
  it('is true for the initial fetch, then false once it resolves', async () => {
    const fetcher = vi.fn().mockResolvedValue('first');
    const { result } = renderHook(() => useSingleFetch(fetcher));

    expect(result.current.refreshing).toBe(true);
    expect(result.current.loading).toBe(true);

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.refreshing).toBe(false);
    expect(result.current.data).toBe('first');
  });

  it('flips true again when `deps` changes, without re-showing the full-skeleton `loading` state', async () => {
    const fetcher = vi.fn().mockImplementation((_signal: AbortSignal) => Promise.resolve('value'));
    const { result, rerender } = renderHook(({ dep }: { dep: number }) => useSingleFetch(fetcher, [dep]), { initialProps: { dep: 1 } });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.refreshing).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(1);

    rerender({ dep: 2 });

    // Loading (the FIRST-load-only flag) must NOT flip back to true — data
    // is already present, so no full-skeleton flash — but refreshing must,
    // so the UI has SOME in-flight signal for the filter-driven re-fetch.
    expect(result.current.loading).toBe(false);
    expect(result.current.refreshing).toBe(true);
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.refreshing).toBe(false));
  });

  it('re-fetches exactly once per deps change, not once per render', async () => {
    const fetcher = vi.fn().mockResolvedValue('value');
    const { rerender } = renderHook(({ dep }: { dep: number }) => useSingleFetch(fetcher, [dep]), { initialProps: { dep: 1 } });
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));

    rerender({ dep: 1 }); // same dep value — must NOT trigger another fetch
    // Give any errant effect a tick to (not) fire.
    await Promise.resolve();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('manual refresh() sets refreshing true, and it clears once the re-fetch resolves', async () => {
    let resolveSecond: (value: string) => void = () => {};
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce('first')
      .mockImplementationOnce(() => new Promise<string>((resolve) => (resolveSecond = resolve)));
    const { result } = renderHook(() => useSingleFetch(fetcher));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.refreshing).toBe(false);

    result.current.refresh();
    await waitFor(() => expect(result.current.refreshing).toBe(true));
    // loading stays false on a manual refresh AFTER data already exists — same "no skeleton flash" contract loading's own doc comment describes.
    expect(result.current.loading).toBe(false);

    resolveSecond('second');
    await waitFor(() => expect(result.current.refreshing).toBe(false));
    expect(result.current.data).toBe('second');
  });
});
