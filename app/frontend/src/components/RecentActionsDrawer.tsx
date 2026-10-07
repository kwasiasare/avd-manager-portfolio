import { makeStyles, tokens, Text, Button, Tooltip, OverlayDrawer, DrawerHeader, DrawerHeaderTitle, DrawerBody } from '@fluentui/react-components';
import { Dismiss24Regular, ArrowClockwise16Regular } from '@fluentui/react-icons';
import type { AuditEntryDto } from '@avdmgr/shared';
import { getRecentAuditEntries } from '../api/avd';
import { useSingleFetch } from '../hooks/useSingleFetch';
import { useDialogFocusRestore } from '../hooks/useDialogFocusRestore';
import { formatRelativeToNow } from '../lib/format';
import AsyncState from './AsyncState';
import StatusBadge, { type StatusTone } from './StatusBadge';

/** Matches this drawer's own "did someone already do X" purpose — a quick recent-actions check, not a full audit browse (that's the Audit page, Audit.tsx, which exposes actor/actionPrefix/sinceHours as real filters). */
const TOP = 25;
const SINCE_HOURS = 24;

/**
 * AM-32 peer review MINOR 13 — 'accepted' is deliberately NOT the same tone
 * as 'success': AuditOutcome's own doc comment (auditLog.ts) is emphatic
 * that 'accepted' means only "ARM acknowledged the request", not "the VM
 * actually reached the target state" — treating it as an unqualified "ok"
 * green would overstate what's actually confirmed. 'warning' (amber) reads
 * as "in-flight / unconfirmed", not "failed" — StatusBadge has no distinct
 * "provisional success" tone, and adding one for a single outcome value
 * isn't worth the app-wide surface-area increase.
 */
const OUTCOME_TONE: Record<AuditEntryDto['outcome'], StatusTone> = {
  success: 'ok',
  accepted: 'warning',
  failure: 'error',
};

/** "op@example.com" -> "op" — the local-part reads as an identity at a glance in a 420px-wide drawer; the full value is still available via the wrapping Tooltip. Non-email actors (e.g. 'system:auto-reenable', 'unknown') pass through unchanged. */
function shortActor(actor: string): string {
  const at = actor.indexOf('@');
  return at > 0 ? actor.slice(0, at) : actor;
}

const useStyles = makeStyles({
  drawer: {
    width: '420px',
  },
  captionRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: tokens.spacingHorizontalS,
    marginBottom: tokens.spacingVerticalS,
  },
  caption: {
    color: tokens.colorNeutralForeground3,
  },
  note: {
    color: tokens.colorNeutralForeground3,
    display: 'block',
    marginBottom: tokens.spacingVerticalXS,
  },
  noteLast: {
    marginBottom: tokens.spacingVerticalM,
  },
  list: {
    listStyle: 'none',
    margin: 0,
    padding: 0,
  },
  row: {
    padding: `${tokens.spacingVerticalS} 0`,
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  rowTop: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: tokens.spacingHorizontalS,
  },
  timestamp: {
    color: tokens.colorNeutralForeground3,
  },
  actorLine: {
    display: 'flex',
    alignItems: 'baseline',
    gap: tokens.spacingHorizontalXS,
  },
  actor: {
    color: tokens.colorNeutralForeground3,
    // AM-32 peer review MINOR 15 — a dotted underline + help cursor, same
    // "there's more here on hover/focus" affordance EstateStrip's own
    // asOfError segment uses, paired with tabIndex={0} below so the full
    // actor value (behind the Tooltip) is reachable by keyboard, not just
    // mouse hover.
    textDecorationLine: 'underline',
    textDecorationStyle: 'dotted',
    textUnderlineOffset: '2px',
    cursor: 'help',
  },
  target: {
    color: tokens.colorNeutralForeground3,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  reason: {
    color: tokens.colorNeutralForeground3,
    fontStyle: 'italic',
  },
  hasParams: {
    color: tokens.colorNeutralForeground3,
  },
});

/**
 * AM-32 (M8-W3) — the "Recent actions" drawer: last 25 mutations across the
 * whole app (GET /v1/audit/recent, operator+ — see that handler's doc
 * comment), newest first, over the last 24h. Answers "did someone already
 * drain that host?" in one click, without navigating away from whatever page
 * the operator is currently on.
 *
 * Opened from the History icon-button in EstateStrip (RoleGate operator+ —
 * a viewer never sees the trigger) and from CommandPalette's "Recent
 * actions" action (same role gate, applied there since the palette itself
 * has no role awareness of its own — see that file's doc comment). Follows
 * this app's "mounting IS opening" dialog convention (Layout.tsx renders
 * `{recentActionsOpen && <RecentActionsDrawer .../>}`) — so a plain
 * useSingleFetch with no polling interval is exactly "load on open, no
 * background refresh while closed", and useDialogFocusRestore (called
 * unconditionally, matching every other dialog in this app) captures/
 * restores focus around this mount/unmount lifecycle. Fluent's OverlayDrawer
 * handles moving focus INTO the drawer on open itself (its own built-in
 * focus-trap behavior — see this app's other bare OverlayDrawer,
 * HealthChecksDrawer.tsx, which relies on the same thing).
 */
export default function RecentActionsDrawer({ onClose }: { onClose: () => void }) {
  useDialogFocusRestore();
  const styles = useStyles();
  const recent = useSingleFetch((signal) => getRecentAuditEntries({ top: TOP, sinceHours: SINCE_HOURS }, signal));

  return (
    <OverlayDrawer
      className={styles.drawer}
      open
      onOpenChange={(_event, data) => {
        if (!data.open) onClose();
      }}
      position="end"
    >
      <DrawerHeader>
        <DrawerHeaderTitle action={<Button appearance="subtle" aria-label="Close" icon={<Dismiss24Regular />} onClick={onClose} />}>Recent actions</DrawerHeaderTitle>
      </DrawerHeader>
      <DrawerBody>
        <div className={styles.captionRow}>
          <Text size={200} className={styles.caption}>
            Showing last {recent.data?.sinceHours ?? SINCE_HOURS}h
          </Text>
          <Tooltip content="Refresh" relationship="label">
            {/* AM-32 peer review MINOR 5: disabled on `refreshing`, not just the first-load-only `loading` — a manual refresh (or any future re-fetch trigger) now correctly disables the button for its own duration too, not just the initial load. */}
            <Button appearance="subtle" size="small" icon={<ArrowClockwise16Regular />} onClick={() => recent.refresh()} disabled={recent.refreshing} aria-label="Refresh recent actions" />
          </Tooltip>
        </div>
        {/* AM-32 peer review MAJOR 3: `partial` (the query itself failed partway through) is a DISTINCT, more urgent caveat than plain `truncated` (there's simply more data than `top` allows) — both can be true at once, so both render when they apply. */}
        {recent.data?.partial && (
          <Text size={200} className={`${styles.note} ${styles.noteLast}`} role="status">
            Audit query failed partway — results may be incomplete.
          </Text>
        )}
        {recent.data?.truncated && !recent.data?.partial && (
          <Text size={200} className={`${styles.note} ${styles.noteLast}`} role="status">
            More actions may exist in this window than are shown here.
          </Text>
        )}
        <AsyncState
          loading={recent.loading}
          error={recent.error as Error | undefined}
          data={recent.data?.entries}
          isEmpty={(entries) => entries.length === 0}
          emptyMessage="No actions recorded in this window."
          variant="table"
          skeletonRows={6}
        >
          {(entries) => (
            <ul className={styles.list} aria-label="Recent actions">
              {entries.map((entry) => (
                <li key={entry.id} className={styles.row}>
                  <div className={styles.rowTop}>
                    <Text size={200} className={styles.timestamp}>
                      {formatRelativeToNow(entry.occurredAt)}
                    </Text>
                    <StatusBadge label={entry.outcome} tone={OUTCOME_TONE[entry.outcome]} size="small" />
                  </div>
                  <Text block weight="semibold">
                    {entry.action}
                  </Text>
                  <Text block size={200} className={styles.target}>
                    {entry.target}
                  </Text>
                  <div className={styles.actorLine}>
                    <Tooltip content={entry.actor} relationship="label">
                      <Text size={200} className={styles.actor} tabIndex={0}>
                        {shortActor(entry.actor)}
                      </Text>
                    </Tooltip>
                    {/* AM-32 peer review MINOR 10 — a small affordance signaling this row's audit entity carried a parameters payload (not shown here — see AuditEntryDto's own doc comment for why). Just a hint that "there was more detail to this action", not a way to see it from this drawer. */}
                    {entry.hasParameters && (
                      <Text size={200} className={styles.hasParams}>
                        · has parameters
                      </Text>
                    )}
                  </div>
                  {entry.reason && (
                    <Text block size={200} className={styles.reason}>
                      {entry.reason}
                    </Text>
                  )}
                </li>
              ))}
            </ul>
          )}
        </AsyncState>
      </DrawerBody>
    </OverlayDrawer>
  );
}
