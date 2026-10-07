import { useEffect, useState, type ReactNode } from 'react';
import { MessageBar, MessageBarBody, MessageBarTitle, Skeleton, SkeletonItem, Text, tokens, makeStyles } from '@fluentui/react-components';
import { Warning16Filled } from '@fluentui/react-icons';
import { formatTime } from '../lib/format';
import { useColdStartHintClaim } from '../hooks/useColdStartHintClaim';

/** AM-29 item 23: skeleton shape shown while `loading` is true. 'text' (default) is this component's original single bar; 'stat' fits a Dashboard-style number tile; 'table' is a header bar plus rows; 'chart' is one large block. */
export type AsyncStateVariant = 'text' | 'stat' | 'table' | 'chart';

export interface AsyncStateProps<T> {
  loading: boolean;
  error: Error | undefined;
  data: T | undefined;
  /** Returns true when `data` is present but empty (e.g. an empty array) — shown as an info MessageBar rather than the children. */
  isEmpty?: (data: T) => boolean;
  emptyMessage?: string;
  skeletonHeight?: number;
  /** Skeleton shape — see AsyncStateVariant. Defaults to 'text'. */
  variant?: AsyncStateVariant;
  /** Only meaningful for variant 'table' — number of skeleton body rows below the header bar. Defaults to 3. */
  skeletonRows?: number;
  /**
   * AM-29 item 12 — when this fetch last SUCCEEDED, if known. Shown in the
   * stale-data bar ("as of HH:MM") when `error` and `data` are both present
   * (see this component's own doc comment below). Purely cosmetic when
   * omitted — the bar still renders, just without a timestamp.
   */
  asOf?: Date;
  children: (data: T) => ReactNode;
}

/** How long the FIRST load has to be in flight before the cold-start hint appears (AM-15/M7). Flex Consumption's own documented cold-start window is a few seconds on an idle plan — 3s is long enough that a normal warm response never shows it, short enough that a genuinely cold Function App gets an explanation before a user assumes the page is broken. */
const COLD_START_HINT_DELAY_MS = 3_000;

const useStyles = makeStyles({
  staleWarning: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalXS,
    color: tokens.colorPaletteYellowForeground1,
    marginBottom: tokens.spacingVerticalXS,
  },
});

function TextSkeleton({ height }: { height: number }) {
  return <SkeletonItem style={{ height }} />;
}

function StatSkeleton() {
  return (
    <>
      <SkeletonItem style={{ height: 32, width: '55%' }} />
      <SkeletonItem style={{ height: 16, width: '35%', marginTop: tokens.spacingVerticalXS }} />
    </>
  );
}

function TableSkeleton({ rows }: { rows: number }) {
  return (
    <>
      <SkeletonItem style={{ height: 28 }} />
      {Array.from({ length: rows }, (_, index) => (
        <SkeletonItem key={index} style={{ height: 20, marginTop: tokens.spacingVerticalXS }} />
      ))}
    </>
  );
}

function ChartSkeleton({ height }: { height: number }) {
  return <SkeletonItem style={{ height }} />;
}

function renderSkeletonShape(variant: AsyncStateVariant, skeletonHeight: number, skeletonRows: number) {
  switch (variant) {
    case 'stat':
      return <StatSkeleton />;
    case 'table':
      return <TableSkeleton rows={skeletonRows} />;
    case 'chart':
      return <ChartSkeleton height={skeletonHeight} />;
    default:
      return <TextSkeleton height={skeletonHeight} />;
  }
}

/**
 * Standardizes the loading/error/empty/success states every Dashboard/
 * HostPool/Sessions widget needs, backed by Fluent's Skeleton and
 * MessageBar. Only shows the full skeleton on the FIRST load (loading=true
 * from usePolling) — a background refresh keeps showing the last-good data
 * without flashing.
 *
 * AM-15 (M7): the skeleton grows a "Function App may be cold-starting" hint
 * once the FIRST load has been in flight for COLD_START_HINT_DELAY_MS —
 * every page's first widget-level fetch after an idle period is genuinely
 * indistinguishable from a slow/stuck request without this, and this app's
 * Function App runs on Flex Consumption (infra/modules/functionapp.bicep),
 * which does have a real cold-start window on the first request after a
 * scale-to-zero. The timer is local to each AsyncState instance (not global
 * app state), and both the timer and the hint flag are cleared on
 * unmount/re-render (in the effect's cleanup, not synchronously in the
 * effect body — react-hooks/set-state-in-effect flags the latter), so a
 * hypothetical SECOND loading=true cycle for a reused instance starts the
 * hint fresh rather than showing it immediately from stale state.
 *
 * AM-29 item 13: when this instance sits inside a <ColdStartHintProvider>
 * (see that component), only the FIRST AsyncState on the page to hit the
 * delay actually shows the hint — see useColdStartHintClaim.
 *
 * AM-29 item 12: folds in what used to be a hand-rolled "StalePollWarning"
 * component duplicated in Images.tsx and Profiles.tsx — since AsyncState
 * already receives both `error` and `data`, it's the natural place for
 * this. When a background refresh fails but data from a PRIOR successful
 * load is still on screen (error && data !== undefined), a small warning
 * bar appears above the children rather than replacing them with the error
 * state (which only fires when there is NO data at all).
 *
 * AM-29 item 23: `variant` picks the skeleton's shape (see
 * AsyncStateVariant) — plain callers keep the original single-bar 'text'
 * skeleton; Dashboard-style number tiles, tables, and charts can ask for a
 * closer-fitting placeholder.
 */
export default function AsyncState<T>({
  loading,
  error,
  data,
  isEmpty,
  emptyMessage = 'No data available.',
  skeletonHeight = 24,
  variant = 'text',
  skeletonRows = 3,
  asOf,
  children,
}: AsyncStateProps<T>) {
  const [showColdStartHint, setShowColdStartHint] = useState(false);
  const claimColdStartHint = useColdStartHintClaim();
  const styles = useStyles();

  useEffect(() => {
    if (!loading) {
      return;
    }
    const timer = window.setTimeout(() => {
      // No provider in scope (claimColdStartHint undefined) preserves this
      // component's original un-deduplicated behavior — every instance is
      // free to show its own hint.
      if (claimColdStartHint === undefined || claimColdStartHint()) {
        setShowColdStartHint(true);
      }
    }, COLD_START_HINT_DELAY_MS);
    // Opus peer review MINOR fix: reset in the CLEANUP function (runs when
    // `loading` changes away from true, or on unmount) rather than
    // synchronously in the effect body — react-hooks/set-state-in-effect
    // flags the latter, and this placement also makes the reset actually
    // correct for a hypothetical second loading cycle (see this
    // component's doc comment above) rather than relying on the flag never
    // being re-read.
    return () => {
      window.clearTimeout(timer);
      setShowColdStartHint(false);
    };
  }, [loading, claimColdStartHint]);

  if (loading) {
    return (
      <>
        <Skeleton aria-label="Loading">{renderSkeletonShape(variant, skeletonHeight, skeletonRows)}</Skeleton>
        {/* Peer review MINOR fix: rendered OUTSIDE <Skeleton>, not as its child — Fluent's Skeleton sets role="progressbar" + aria-label="Loading" on its own wrapper, which (per the ARIA progressbar pattern) hides its children from the accessibility tree entirely, so a screen-reader user would never have heard this hint. aria-live="polite" announces it once it appears, without interrupting whatever the user is currently doing. */}
        {showColdStartHint && (
          <Text size={200} block aria-live="polite" style={{ color: tokens.colorNeutralForeground3, marginTop: tokens.spacingVerticalXS }}>
            Still loading — the Function App may be cold-starting after a period of inactivity. This can take a few extra seconds.
          </Text>
        )}
      </>
    );
  }

  if (error && data === undefined) {
    return (
      <MessageBar intent="error">
        <MessageBarBody>
          <MessageBarTitle>Couldn't load this data</MessageBarTitle>
          {error.message}
        </MessageBarBody>
      </MessageBar>
    );
  }

  if (data === undefined) {
    return (
      <MessageBar intent="info">
        <MessageBarBody>{emptyMessage}</MessageBarBody>
      </MessageBar>
    );
  }

  if (isEmpty?.(data)) {
    return (
      <MessageBar intent="info">
        <MessageBarBody>{emptyMessage}</MessageBarBody>
      </MessageBar>
    );
  }

  return (
    <>
      {error && (
        <div className={styles.staleWarning} role="status">
          <Warning16Filled />
          <Text size={200}>
            Showing the last successful data{asOf ? ` (as of ${formatTime(asOf)})` : ''} — the most recent refresh failed ({error.message}).
          </Text>
        </div>
      )}
      {children(data)}
    </>
  );
}
