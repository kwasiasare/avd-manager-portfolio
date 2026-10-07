import { useEffect, useState } from 'react';
import {
  makeStyles,
  tokens,
  Card,
  Text,
  Input,
  Dropdown,
  Option,
  Switch,
  Button,
  Tooltip,
  Toast,
  ToastTitle,
  Spinner,
} from '@fluentui/react-components';
import type { AuditEntryDto } from '@avdmgr/shared';
import { getRecentAuditEntries } from '../api/avd';
import { useAuth } from '../auth/useAuth';
import { useSingleFetch } from '../hooks/useSingleFetch';
import AsyncState from '../components/AsyncState';
import PageHeader from '../components/PageHeader';
import RoleGate from '../components/RoleGate';
import StatusBadge, { type StatusTone } from '../components/StatusBadge';
import DataTable, { type DataTableColumn } from '../components/DataTable';
import { formatDateTime } from '../lib/format';
import { useAppToast } from '../lib/toaster';
import { useCardStyles } from '../styles/shared';

/** More than the "Recent actions" drawer's 25 (RecentActionsDrawer.tsx) — this page is the full browse/filter surface, the drawer is a quick glance. Still well under the server's own 100-row ceiling (see auditRecent.ts's MAX_TOP) — no client-side pagination exists yet, so this is the largest single page this UI can show without one. */
const TOP = 100;

/** Debounces the free-text actor filter so typing doesn't fire a request per keystroke — same rationale/duration class as UsersAccess.tsx's access-search debounce, just simpler (no minimum-length gate: an exact-match filter has no "too short to be useful" floor the way a fuzzy search does). */
const ACTOR_DEBOUNCE_MS = 400;

const TIME_WINDOW_OPTIONS = [
  { value: '24', label: 'Last 24h' },
  { value: '168', label: 'Last 7d' },
  { value: '720', label: 'Last 30d' },
] as const;

/**
 * Static list of this app's audit action-id FAMILIES (the `action` prefix
 * every writeAuditEntry call in app/api/src/functions uses — see e.g.
 * sessionHostDrain.ts's AUDIT_ACTION, rolloutPlans.ts's ACTION map). Curated
 * by hand rather than derived from a live endpoint (there is no "list every
 * distinct action id this app has ever written" endpoint, and building one
 * just to populate a dropdown isn't worth it) — kept in sync with the
 * backend's own action ids by convention; a new action family added on the
 * API side should get a matching entry here. Pinned against a snapshot of
 * every real AUDIT_ACTION-shaped literal this app writes by
 * app/api/src/lib/auditActionFamilies.test.ts (AM-32 peer review NIT 23) —
 * that test is a deliberate hand-kept DUPLICATE of these prefixes (not a
 * shared import), so update it alongside this list.
 */
const ACTION_FAMILY_OPTIONS = [
  { value: '', label: 'All actions' },
  { value: 'access.', label: 'Access & assignments' },
  { value: 'alert.', label: 'Alerts' },
  { value: 'hostpool.', label: 'Host pool' },
  { value: 'image.build.', label: 'Image builds' },
  { value: 'logs.', label: 'Logs' },
  { value: 'profile.', label: 'Profiles' },
  { value: 'rollout.', label: 'Rollout' },
  { value: 'scalingplan.', label: 'Scaling plan' },
  { value: 'session.', label: 'Session (force logoff / message)' },
  { value: 'sessionhost.', label: 'Session host' },
  { value: 'sessions.', label: 'Sessions (broadcast / logoff all)' },
  { value: 'workspace.', label: 'Workspace' },
] as const;

/**
 * AM-32 peer review MINOR 13 — 'accepted' is deliberately NOT the same tone
 * as 'success' — see AuditOutcome's own doc comment (auditLog.ts): it means
 * only "ARM acknowledged the request", not "confirmed complete". 'warning'
 * reads as "in-flight/unconfirmed", matching RecentActionsDrawer.tsx's own
 * mapping (both UI surfaces agree on this).
 */
const OUTCOME_TONE: Record<AuditEntryDto['outcome'], StatusTone> = {
  success: 'ok',
  accepted: 'warning',
  failure: 'error',
};

const useStyles = makeStyles({
  page: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXL,
  },
  card: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalM,
  },
  filters: {
    display: 'flex',
    gap: tokens.spacingHorizontalM,
    flexWrap: 'wrap',
    alignItems: 'center',
  },
  captionRow: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
  },
  caption: {
    color: tokens.colorNeutralForeground3,
  },
  gateNote: {
    color: tokens.colorNeutralForeground3,
  },
  reasonCell: {
    display: 'block',
    maxWidth: '260px',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  hasParams: {
    color: tokens.colorNeutralForeground3,
  },
  correlationButton: {
    minWidth: 'auto',
    padding: `0 ${tokens.spacingHorizontalXS}`,
    fontFamily: tokens.fontFamilyMonospace,
  },
});

/**
 * AM-32 peer review MINOR 17 — same "short pill + truncated caption +
 * Tooltip carries the full text" shape Profiles.tsx's LockBadge uses for
 * long lock-holder identities: a long reason no longer stretches the
 * Reason column (or gets silently clipped with no way to read the rest) —
 * it ellipsizes at a fixed width, with the untruncated text available via
 * hover/focus. Renders a plain "—" (no Tooltip) when there's no reason at
 * all — nothing to elaborate on.
 */
function ReasonCell({ reason }: { reason: string | undefined }) {
  const styles = useStyles();
  if (!reason) {
    return <Text>—</Text>;
  }
  return (
    <Tooltip content={reason} relationship="description">
      <Text className={styles.reasonCell} tabIndex={0}>
        {reason}
      </Text>
    </Tooltip>
  );
}

/**
 * AM-32 peer review MINOR 11 — the correlationId was not shown anywhere on
 * this page before (only in log lines / a failed mutation's error banner) —
 * this is the audit UI's own place to surface it, monospace (visually
 * distinct from prose columns) with a native `title` attribute (a
 * redundant, always-available way to read the full value) AND click-to-copy
 * (the common case: pasting it into a support ticket or an Application
 * Insights query). A clipboard failure (unsupported/insecure context,
 * permission denied) degrades silently — the id is still fully visible as
 * plain monospace text, so copying by hand is always a fallback.
 */
function CorrelationCell({ correlationId }: { correlationId: string }) {
  const styles = useStyles();
  const { dispatchToast } = useAppToast();

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(correlationId);
      dispatchToast(
        <Toast>
          <ToastTitle>Copied correlation ID</ToastTitle>
        </Toast>,
        { intent: 'success' },
      );
    } catch {
      // Clipboard API unavailable/denied — no toast, no error; the id is still readable/selectable as plain text.
    }
  }

  return (
    <Button appearance="transparent" size="small" className={styles.correlationButton} title={correlationId} onClick={handleCopy} aria-label={`Copy correlation ID ${correlationId}`}>
      {correlationId}
    </Button>
  );
}

/**
 * AM-32 (M8-W3) — Audit page: replaces the AuditSettings placeholder
 * (formerly a TODO note only). Reads GET /v1/audit/recent (operator+ — see
 * that handler's doc comment) with actor/actionPrefix/sinceHours filters,
 * newest first. Manual refresh only (PageHeader's refresh button/`r`
 * shortcut) — no polling interval; filters themselves DO re-fetch on change
 * (see useSingleFetch's deps below), the same way Monitoring.tsx's
 * alert-feed hours Dropdown re-fetches immediately on selection rather than
 * needing a separate "apply" step. "Show failures only" (peer review MINOR
 * 12) is a CLIENT-side filter over whatever's already loaded — same
 * "toggle narrows the already-fetched set" shape Governance.tsx's own
 * failures-only Switch uses — not a new server query param.
 *
 * `canView` folds into the fetch's own deps so a viewer never even attempts
 * the operator+-only GET (see api/avd.ts's doc comment on
 * getRecentAuditEntries) — the same "check once, use for both the fetch AND
 * the render gate" pattern UsersAccess.tsx's `canSearch` uses. PageHeader
 * (title/refresh button/document title) is NOT itself role-gated — only the
 * filters+table Card is (via RoleGate below), so the page's shell looks the
 * same regardless of role, matching Settings.tsx/Monitoring.tsx's convention
 * of gating just the sensitive content, not the whole page.
 *
 * Reachable at the clean route `/audit` (nav item, restored under
 * Administer — see Layout.tsx's NAV_GROUPS) and the legacy `/audit-settings`
 * deep link (kept so any existing bookmark/link to the old placeholder still
 * resolves — see App.tsx).
 */
export default function Audit() {
  const styles = useStyles();
  const cardStyles = useCardStyles();
  const { role } = useAuth();
  const canView = role === 'operator' || role === 'admin';

  const [actorInput, setActorInput] = useState('');
  const [actor, setActor] = useState('');
  const [actionPrefix, setActionPrefix] = useState('');
  const [sinceHours, setSinceHours] = useState(24);
  const [failuresOnly, setFailuresOnly] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => setActor(actorInput.trim()), ACTOR_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [actorInput]);

  const audit = useSingleFetch(
    (signal) =>
      canView
        ? getRecentAuditEntries({ top: TOP, actor: actor || undefined, actionPrefix: actionPrefix || undefined, sinceHours }, signal)
        : Promise.resolve({ entries: [], truncated: false, partial: false, sinceHours }),
    [actor, actionPrefix, sinceHours, canView],
  );

  const actionPrefixLabel = ACTION_FAMILY_OPTIONS.find((option) => option.value === actionPrefix)?.label ?? 'All actions';
  const timeWindowLabel = TIME_WINDOW_OPTIONS.find((option) => option.value === String(sinceHours))?.label ?? 'Last 24h';

  const AUDIT_COLUMNS: DataTableColumn<AuditEntryDto>[] = [
    { id: 'when', label: 'When', renderCell: (entry) => formatDateTime(entry.occurredAt) },
    { id: 'who', label: 'Who', renderCell: (entry) => entry.actor },
    {
      id: 'action',
      label: 'Action',
      renderCell: (entry) => (
        <>
          <Text>{entry.action}</Text>
          {/* AM-32 peer review MINOR 10 — a small affordance signaling this row's audit entity carried a parameters payload (not shown here — see AuditEntryDto's own doc comment for why). */}
          {entry.hasParameters && (
            <Text size={100} className={styles.hasParams}>
              {' '}
              · has parameters
            </Text>
          )}
        </>
      ),
    },
    { id: 'target', label: 'Target', renderCell: (entry) => entry.target },
    { id: 'outcome', label: 'Outcome', renderCell: (entry) => <StatusBadge label={entry.outcome} tone={OUTCOME_TONE[entry.outcome]} /> },
    { id: 'reason', label: 'Reason', renderCell: (entry) => <ReasonCell reason={entry.reason} /> },
    { id: 'correlationId', label: 'Correlation ID', renderCell: (entry) => <CorrelationCell correlationId={entry.correlationId} /> },
  ];

  return (
    <div className={styles.page}>
      {/* AM-32 peer review MINOR 5: `refreshing`, not `loading` — `loading` is only true for the FIRST fetch (AsyncState/PageHeader's existing "no skeleton flash on background refresh" convention), so without this the spinner never reappeared for a filter change or a manual refresh after the first successful load. */}
      <PageHeader title="Audit" refreshing={audit.refreshing} onRefresh={() => audit.refresh()} />

      <RoleGate allowed={['operator', 'admin']} fallback={<Text className={styles.gateNote}>Audit requires the operator or admin role.</Text>}>
        <Card className={cardStyles.card}>
          <div className={styles.filters}>
            <Input placeholder="Filter by actor" value={actorInput} onChange={(_event, data) => setActorInput(data.value)} aria-label="Filter by actor" />
            <Dropdown
              aria-label="Action"
              style={{ minWidth: '220px' }}
              value={actionPrefixLabel}
              selectedOptions={[actionPrefix]}
              onOptionSelect={(_event, data) => {
                // AM-32 peer review MINOR 22: both Dropdowns below now use
                // the SAME `!== undefined` guard shape — actionPrefix's
                // valid values legitimately include '' ("All actions"), so
                // it only excludes a genuinely absent selection; sinceHours
                // has no empty-string option, so its guard ALSO excludes ''
                // explicitly rather than relying on '' being falsy (which
                // was correct behavior before, but looked like a
                // different-shaped check for no real reason).
                if (data.optionValue !== undefined) setActionPrefix(data.optionValue);
              }}
            >
              {ACTION_FAMILY_OPTIONS.map((option) => (
                <Option key={option.value || 'all'} value={option.value} text={option.label}>
                  {option.label}
                </Option>
              ))}
            </Dropdown>
            <Dropdown
              aria-label="Time window"
              style={{ minWidth: '140px' }}
              value={timeWindowLabel}
              selectedOptions={[String(sinceHours)]}
              onOptionSelect={(_event, data) => {
                if (data.optionValue !== undefined && data.optionValue !== '') setSinceHours(Number(data.optionValue));
              }}
            >
              {TIME_WINDOW_OPTIONS.map((option) => (
                <Option key={option.value} value={option.value} text={option.label}>
                  {option.label}
                </Option>
              ))}
            </Dropdown>
            <Switch label="Show failures only" checked={failuresOnly} onChange={(_event, data) => setFailuresOnly(data.checked)} />
            {audit.refreshing && <Spinner size="tiny" label="Refreshing…" labelPosition="after" />}
          </div>

          <div className={styles.captionRow}>
            <Text size={200} className={styles.caption}>
              Showing last {audit.data?.sinceHours ?? sinceHours}h
            </Text>
            {/* AM-32 peer review MAJOR 3: `partial` (the query itself failed partway through) is a distinct, more urgent caveat than plain `truncated` — both can be true at once, but only the more specific one is shown. */}
            {audit.data?.partial ? (
              <Text size={200} className={styles.caption} role="status">
                — audit query failed partway; results may be incomplete.
              </Text>
            ) : (
              audit.data?.truncated && (
                <Text size={200} className={styles.caption} role="status">
                  — more entries may exist in this window than are shown.
                </Text>
              )
            )}
          </div>

          <AsyncState
            loading={audit.loading}
            error={audit.error as Error | undefined}
            data={audit.data?.entries}
            isEmpty={(entries) => entries.length === 0}
            emptyMessage="No audit entries match these filters."
            variant="table"
            skeletonRows={6}
          >
            {(entries) => {
              const visibleEntries = failuresOnly ? entries.filter((entry) => entry.outcome === 'failure') : entries;
              return (
                <DataTable
                  ariaLabel="Audit log"
                  columns={AUDIT_COLUMNS}
                  rows={visibleEntries}
                  getRowKey={(entry) => entry.id}
                  emptyMessage="No audit entries match these filters."
                  activeFilterDescription={failuresOnly ? 'No failures in this window.' : undefined}
                />
              );
            }}
          </AsyncState>
        </Card>
      </RoleGate>
    </div>
  );
}
