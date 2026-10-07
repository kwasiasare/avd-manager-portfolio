import { useEffect, useRef, useState, type ReactNode } from 'react';
import { makeStyles, tokens } from '@fluentui/react-components';

const useStyles = makeStyles({
  scroll: {
    overflowX: 'auto',
    // A visible focus ring when the scroll container itself is tabbed to
    // (Fluent's Table has no built-in scroll wrapper of its own) — matches
    // this app's other scrollable-region pattern (Profiles.tsx / Governance.tsx's
    // tabIndex={0} <pre> blocks, AM-29 item 24).
    ':focus-visible': {
      outline: `2px solid ${tokens.colorStrokeFocus2}`,
      outlineOffset: '-2px',
    },
  },
});

/**
 * AM-29 item 19 — wraps a <Table> so a wide table scrolls horizontally
 * within its own card instead of forcing the whole page to scroll
 * sideways (or, worse, silently clipping columns) on a narrow viewport.
 *
 * Peer review (Opus, MINOR item 7):
 *  - role="region" + aria-label names this as a landmark a screen-reader
 *    user can jump to directly. Callers should NOT also pass the same
 *    aria-label to the <Table> they wrap — that would announce the same
 *    name twice; this component now owns the accessible name for the
 *    scroll region.
 *  - tabIndex is only set (to 0) when the content actually overflows
 *    (scrollWidth > clientWidth) — a table narrow enough to never scroll
 *    has nothing to tab to, so adding it to tab order unconditionally was
 *    a keyboard-navigation dead stop for no benefit. Re-checked on window
 *    resize and via ResizeObserver (covers the table's own content
 *    changing size — e.g. a filtered/sorted result set — without a window
 *    resize).
 */
export default function TableScroll({ children, ariaLabel }: { children: ReactNode; ariaLabel?: string }) {
  const styles = useStyles();
  const containerRef = useRef<HTMLDivElement>(null);
  const [overflowing, setOverflowing] = useState(false);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return undefined;

    function checkOverflow(target: HTMLDivElement) {
      setOverflowing(target.scrollWidth > target.clientWidth);
    }

    checkOverflow(el);

    const observer = new ResizeObserver(() => checkOverflow(el));
    observer.observe(el);
    const handleWindowResize = () => checkOverflow(el);
    window.addEventListener('resize', handleWindowResize);

    return () => {
      observer.disconnect();
      window.removeEventListener('resize', handleWindowResize);
    };
  }, [children]);

  return (
    <div ref={containerRef} className={styles.scroll} role="region" aria-label={ariaLabel} tabIndex={overflowing ? 0 : undefined}>
      {children}
    </div>
  );
}
