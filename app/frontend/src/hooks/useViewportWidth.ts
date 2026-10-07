import { useEffect, useState } from 'react';

/**
 * AM-31 item 34 — live `window.innerWidth`, re-rendering the caller on
 * resize. Backs Layout.tsx's responsive nav breakpoints (icon-rail below
 * ~1000px, overlay drawer below ~700px). A plain resize listener (not
 * matchMedia) since Layout needs the actual width to pick between three
 * bands, not just a single above/below-a-threshold boolean.
 *
 * Peer review MINOR 8 — the resize handler is rAF-throttled: a drag-resize
 * fires the native `resize` event many times per second, and without
 * throttling each one immediately called setState, re-rendering Layout (and
 * everything below it) on every single tick. `requestAnimationFrame`
 * coalesces that down to at most one state update per painted frame — the
 * last `resize` event within a frame wins, no queued backlog of stale
 * updates once the drag stops.
 */
export function useViewportWidth(): number {
  const [width, setWidth] = useState(() => (typeof window !== 'undefined' ? window.innerWidth : 1280));

  useEffect(() => {
    let rafId: number | undefined;
    function handleResize() {
      if (rafId !== undefined) return;
      rafId = window.requestAnimationFrame(() => {
        rafId = undefined;
        setWidth(window.innerWidth);
      });
    }
    window.addEventListener('resize', handleResize);
    return () => {
      window.removeEventListener('resize', handleResize);
      if (rafId !== undefined) window.cancelAnimationFrame(rafId);
    };
  }, []);

  return width;
}
