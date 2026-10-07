import type { ReactNode } from 'react';
import { makeStyles, tokens, Text, Button, Spinner, Tooltip } from '@fluentui/react-components';
import { ArrowClockwise20Regular } from '@fluentui/react-icons';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useRegisterRefreshShortcut } from '../hooks/useKeyboardShortcuts';
import { formatTime } from '../lib/format';

export interface PageHeaderProps {
  /** The page's h1 text — also drives the browser tab title (see useDocumentTitle) and, via Layout's route-change live region, the announcement a screen-reader user hears on navigating here (AM-29 items 4-5). */
  title: string;
  /** Page-level actions (buttons, links) rendered to the right of the title — e.g. HostPool's "Add session host" panel trigger. */
  actions?: ReactNode;
  /** When this page's data was last successfully loaded, if known (usually usePolling's implicit last-success instant — pass `new Date()` at the moment `data` last changed, or omit entirely for pages that don't track it). */
  asOf?: Date;
  /** True while a background refresh is in flight — typically usePolling's `refreshing`. Shows a small spinner and disables the refresh button so a second click can't stack a duplicate request. */
  refreshing?: boolean;
  /** Omit entirely to hide the refresh button (e.g. a page with no polled data of its own). */
  onRefresh?: () => void;
}

const useStyles = makeStyles({
  header: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXS,
  },
  titleRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: tokens.spacingHorizontalM,
    flexWrap: 'wrap',
  },
  titleGroup: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
  },
  actions: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    flexWrap: 'wrap',
  },
  asOf: {
    color: tokens.colorNeutralForeground3,
  },
});

/**
 * AM-29 item 27 — the standard page-top block: the page's h1, an optional
 * actions slot, an "as of HH:MM" freshness timestamp, and a refresh
 * affordance wired straight to usePolling's own `refreshing`/`refresh`.
 * Replaces each page's own ad hoc `<Text as="h1">` + (sometimes) its own
 * hand-rolled refresh button, so every page's header looks and behaves the
 * same way.
 *
 * Also calls useDocumentTitle(title) internally — adopting PageHeader on a
 * page automatically satisfies item 5 (per-route document.title) too,
 * rather than needing a second hook call at every page's top.
 */
export default function PageHeader({ title, actions, asOf, refreshing = false, onRefresh }: PageHeaderProps) {
  useDocumentTitle(title);
  // AM-31 item 36: registers this page's onRefresh (if any) as the target
  // of the global `r` keyboard shortcut — every page adopting PageHeader
  // gets this for free, no per-page wiring needed. A page with no
  // onRefresh (hiding the button — see this prop's own doc comment)
  // registers `undefined`, which correctly makes `r` a no-op there.
  useRegisterRefreshShortcut(onRefresh);
  const styles = useStyles();

  return (
    <div className={styles.header}>
      <div className={styles.titleRow}>
        <div className={styles.titleGroup}>
          <Text as="h1" size={800} weight="semibold">
            {title}
          </Text>
          {refreshing && <Spinner size="tiny" label="Refreshing…" labelPosition="after" />}
        </div>
        <div className={styles.actions}>
          {actions}
          {onRefresh && (
            <Tooltip content="Refresh now" relationship="label">
              <Button appearance="subtle" icon={<ArrowClockwise20Regular />} onClick={onRefresh} disabled={refreshing} aria-label="Refresh now" />
            </Tooltip>
          )}
        </div>
      </div>
      {asOf && (
        <Text size={200} className={styles.asOf}>
          As of {formatTime(asOf)}
        </Text>
      )}
    </div>
  );
}
