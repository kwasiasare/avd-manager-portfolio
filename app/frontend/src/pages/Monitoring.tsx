import { useState } from 'react';
import {
  makeStyles,
  tokens,
  Card,
  CardHeader,
  Text,
  Button,
  Dropdown,
  Option,
  Switch,
  Textarea,
  Spinner,
  MessageBar,
  MessageBarBody,
  Tooltip,
  Toast,
  ToastTitle,
  Menu,
  MenuTrigger,
  MenuPopover,
  MenuList,
  MenuItem,
} from '@fluentui/react-components';
import { MoreHorizontal20Regular } from '@fluentui/react-icons';
import type { AlertSummary, AlertsFeedResponse, LogsQueryResponse, LogsViewSummary } from '@avdmgr/shared';
import { ackAlert, getAlerts, getLogsViews, runLogsView, runRawKql, snoozeAlert, unackAlert, unsnoozeAlert } from '../api/avd';
import { usePolling, type PollingState } from '../hooks/usePolling';
import AsyncState from '../components/AsyncState';
import StatusBadge, { type StatusTone } from '../components/StatusBadge';
import RoleGate from '../components/RoleGate';
import ConfirmModal from '../components/ConfirmModal';
import SnoozeDialog from '../components/SnoozeDialog';
import LogsResultsTable from '../components/LogsResultsTable';
import PageHeader from '../components/PageHeader';
import DataTable, { type DataTableColumn } from '../components/DataTable';
import { formatDateTime, formatRelativeToNow } from '../lib/format';
import { useCardStyles } from '../styles/shared';
import { useAppToast } from '../lib/toaster';
import { MAX_SNOOZE_HOURS, MIN_SNOOZE_HOURS } from '../lib/alertSnooze';

const ALERTS_POLL_INTERVAL_MS = 60_000;
const VIEWS_POLL_INTERVAL_MS = 300_000;

// Mirrors app/api/src/lib/logsGuard.ts's MIN/MAX_ALERT_HOURS (1..168) and
// MIN/MAX_TIMESPAN_HOURS (also 1..168) — the API independently re-validates
// every bound, this is just a sane preset list for the pickers.
const HOURS_OPTIONS = [1, 6, 12, 24, 48, 72, 168] as const;
/** Mirrors app/api/src/lib/logsGuard.ts's MAX_KQL_LENGTH — enforced client-side (maxLength on the textarea) so a caller finds out before a round-trip, and the API independently re-validates the same bound. */
const MAX_KQL_LENGTH = 8_000;

const useStyles = makeStyles({
  page: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXL,
  },
  toolbar: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalM,
    flexWrap: 'wrap',
  },
  section: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalM,
  },
  snoozedRow: {
    opacity: 0.55,
  },
  actionsCell: {
    display: 'flex',
    gap: tokens.spacingHorizontalXS,
  },
  kqlEditor: {
    fontFamily: 'ui-monospace, Consolas, monospace',
    minHeight: '120px',
  },
  errorGap: {
    marginTop: tokens.spacingVerticalS,
  },
});

function severityTone(severity: AlertSummary['severity']): StatusTone {
  switch (severity) {
    case 'Sev0':
    case 'Sev1':
      return 'error';
    case 'Sev2':
      return 'warning';
    default:
      return 'info';
  }
}

function statusTone(status: AlertSummary['status']): StatusTone {
  switch (status) {
    case 'New':
      return 'warning';
    // AM-29 item 16: an acknowledged alert is neither resolved (ok) nor
    // still actively demanding attention (warning) — 'pending' (a
    // deliberately paused/in-hand state) reads more accurately than the
    // former generic 'neutral'.
    case 'Acknowledged':
      return 'pending';
    case 'Closed':
      return 'ok';
    default:
      return 'info';
  }
}

// Peer review (Opus, MINOR 5) — hoisted to MODULE scope: this column set
// closes over nothing component-local at all (the "Ack"/"Un-ack"/"Snooze"
// controls live in `rowActions`, a SEPARATE prop, not here) — only
// module-level tone helpers, per-row alert fields, and imported
// components — so it was a pure candidate for a stable reference, same as
// Sessions.tsx's SESSION_COLUMNS.
const ALERT_COLUMNS: DataTableColumn<AlertSummary>[] = [
  { id: 'severity', label: 'Severity', renderCell: (alertItem) => <StatusBadge label={alertItem.severity} tone={severityTone(alertItem.severity)} /> },
  {
    id: 'alert',
    label: 'Alert',
    renderCell: (alertItem) => (
      <Tooltip content={alertItem.description ?? alertItem.name} relationship="description">
        <Text>{alertItem.name}</Text>
      </Tooltip>
    ),
  },
  { id: 'status', label: 'Status', renderCell: (alertItem) => <StatusBadge label={alertItem.status} tone={statusTone(alertItem.status)} /> },
  {
    id: 'fired',
    label: 'Fired',
    renderCell: (alertItem) => (
      <Tooltip content={formatDateTime(alertItem.firedAt)} relationship="description">
        <Text>{formatRelativeToNow(alertItem.firedAt)}</Text>
      </Tooltip>
    ),
  },
  { id: 'targetResource', label: 'Target resource', renderCell: (alertItem) => alertItem.targetResource ?? '—' },
  {
    id: 'appState',
    label: 'App state',
    // Peer review (Opus, MAJOR 1): acked and snoozed are INDEPENDENT
    // server-side states — an alert can be BOTH acked AND (separately)
    // snoozed, and the snoozed badge is the only place its expiry time is
    // surfaced. An if/else here (as this cell briefly had post-AM-35
    // migration) silently dropped the snoozed badge on an already-acked
    // alert; both render, independently, same as every other migrated
    // table's cell.
    renderCell: (alertItem) => {
      const isAcked = Boolean(alertItem.ackedBy);
      const isSnoozed = Boolean(alertItem.snoozedUntil);
      if (!isAcked && !isSnoozed) return '—';
      return (
        <>
          {isAcked && (
            <Tooltip content={`Acked by ${alertItem.ackedBy} at ${formatDateTime(alertItem.ackedAt)}${alertItem.ackedReason ? `: ${alertItem.ackedReason}` : ''}`} relationship="description">
              <StatusBadge label={`Acked by ${alertItem.ackedBy}`} tone="pending" />
            </Tooltip>
          )}
          {isSnoozed && (
            <Tooltip content={`Snoozed by ${alertItem.snoozedBy ?? 'unknown'}${alertItem.snoozeReason ? `: ${alertItem.snoozeReason}` : ''}`} relationship="description">
              <StatusBadge label={`Snoozed until ${formatDateTime(alertItem.snoozedUntil)}`} tone="warning" />
            </Tooltip>
          )}
        </>
      );
    },
  },
];

interface AlertsSectionProps {
  hours: number;
  setHours: (hours: number) => void;
  alertsQuery: PollingState<AlertsFeedResponse>;
}

/** Alert feed: 24h (default) fired alerts, ack/snooze/un-ack/un-snooze actions, snoozed rows visually muted, hide-snoozed toggle (default ON). */
function AlertsSection({ hours, setHours, alertsQuery }: AlertsSectionProps) {
  const styles = useStyles();
  const cardStyles = useCardStyles();
  const { dispatchToast } = useAppToast();
  const [hideSnoozed, setHideSnoozed] = useState(true);
  const [ackTarget, setAckTarget] = useState<AlertSummary | undefined>(undefined);
  const [snoozeTarget, setSnoozeTarget] = useState<AlertSummary | undefined>(undefined);
  // Single busy-alert-id tracker for the direct (no-dialog) un-ack/un-snooze
  // actions below — a double-submit guard without needing per-row state.
  const [busyAlertId, setBusyAlertId] = useState<string | undefined>(undefined);
  const [actionError, setActionError] = useState<string | undefined>(undefined);
  const [actionBusy, setActionBusy] = useState(false);

  const degraded = alertsQuery.data?.degraded ?? false;
  const allAlerts = alertsQuery.data?.alerts;
  const visibleAlerts = hideSnoozed ? allAlerts?.filter((alertItem) => !alertItem.snoozedUntil) : allAlerts;

  function successToast(title: string) {
    dispatchToast(
      <Toast>
        <ToastTitle>{title}</ToastTitle>
      </Toast>,
      { intent: 'success' },
    );
  }

  // AM-29 item 30: acknowledge is severity 'low' — reversible (Un-ack undoes
  // it), low blast radius. Peer review (Opus, MAJOR item 1): ackAlert DOES
  // audit a reason server-side (see AlertAckRequest) — optionalReason keeps
  // that capture available on the modal without making it mandatory.
  async function handleAck(reason: string | undefined) {
    if (!ackTarget) return;
    setActionBusy(true);
    setActionError(undefined);
    try {
      await ackAlert(ackTarget.id, { reason });
      successToast(`Acknowledged "${ackTarget.name}"`);
      setAckTarget(undefined);
      alertsQuery.refresh();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Failed to acknowledge alert.');
    } finally {
      setActionBusy(false);
    }
  }

  async function handleSnooze(hoursToSnooze: number, reason: string) {
    if (!snoozeTarget) return;
    setActionBusy(true);
    setActionError(undefined);
    try {
      await snoozeAlert(snoozeTarget.id, { hours: hoursToSnooze, reason: reason || undefined });
      successToast(`Snoozed "${snoozeTarget.name}" for ${hoursToSnooze}h`);
      setSnoozeTarget(undefined);
      alertsQuery.refresh();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Failed to snooze alert.');
    } finally {
      setActionBusy(false);
    }
  }

  async function handleUnack(alertItem: AlertSummary) {
    setBusyAlertId(alertItem.id);
    setActionError(undefined);
    try {
      await unackAlert(alertItem.id);
      successToast(`Un-acknowledged "${alertItem.name}"`);
      alertsQuery.refresh();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Failed to un-acknowledge alert.');
    } finally {
      setBusyAlertId(undefined);
    }
  }

  async function handleUnsnooze(alertItem: AlertSummary) {
    setBusyAlertId(alertItem.id);
    setActionError(undefined);
    try {
      await unsnoozeAlert(alertItem.id);
      successToast(`Un-snoozed "${alertItem.name}"`);
      alertsQuery.refresh();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Failed to un-snooze alert.');
    } finally {
      setBusyAlertId(undefined);
    }
  }
  return (
    <Card className={cardStyles.card}>
      <CardHeader header={<Text as="h2" size={400} weight="semibold">Alert feed</Text>} />
      <div className={styles.section}>
        <div className={styles.toolbar}>
          <Dropdown
            aria-label="Look-back window"
            style={{ minWidth: '140px' }}
            value={`Last ${hours}h`}
            selectedOptions={[String(hours)]}
            onOptionSelect={(_event, data) => {
              if (data.optionValue) setHours(Number(data.optionValue));
            }}
          >
            {HOURS_OPTIONS.map((option) => (
              <Option key={option} value={String(option)} text={`Last ${option}h`}>
                Last {option}h
              </Option>
            ))}
          </Dropdown>
          <Switch label="Hide snoozed" checked={hideSnoozed} onChange={(_event, data) => setHideSnoozed(data.checked)} />
          {alertsQuery.refreshing && <Spinner size="tiny" label="Refreshing…" labelPosition="after" />}
        </div>

        {degraded && (
          <MessageBar intent="warning">
            <MessageBarBody>Ack/snooze state is temporarily unavailable — alerts below may look un-acked/un-snoozed even if they aren't. Actions are disabled until this clears.</MessageBarBody>
          </MessageBar>
        )}

        {actionError && (
          <MessageBar intent="error">
            <MessageBarBody>{actionError}</MessageBarBody>
          </MessageBar>
        )}

        <AsyncState
          loading={alertsQuery.loading}
          error={alertsQuery.error as Error | undefined}
          data={visibleAlerts}
          isEmpty={(data) => data.length === 0}
          emptyMessage={hideSnoozed ? `No alerts fired in the last ${hours}h (or all are snoozed — try "Hide snoozed" off).` : `No alerts fired in the last ${hours}h.`}
        >
          {(data) => (
            <DataTable
              ariaLabel="Alerts"
              columns={ALERT_COLUMNS}
              rows={data}
              getRowKey={(alertItem) => alertItem.id}
              rowClassName={(alertItem) => (alertItem.snoozedUntil ? styles.snoozedRow : undefined)}
              emptyMessage={hideSnoozed ? `No alerts fired in the last ${hours}h (or all are snoozed — try "Hide snoozed" off).` : `No alerts fired in the last ${hours}h.`}
              rowActionsHeader="Actions"
              rowActions={(alertItem) => {
                const isSnoozed = Boolean(alertItem.snoozedUntil);
                const isAcked = Boolean(alertItem.ackedBy);
                const rowBusy = busyAlertId === alertItem.id;
                return (
                  // AM-31 item 40 — Ack/Un-ack stays the inline (most-frequent) action; Snooze/Un-snooze moves into a per-row overflow menu.
                  <RoleGate allowed={['operator', 'admin']}>
                    <div className={styles.actionsCell}>
                      {isAcked ? (
                        <Button size="small" disabled={degraded || rowBusy} onClick={() => handleUnack(alertItem)}>
                          Un-ack
                        </Button>
                      ) : (
                        <Button size="small" disabled={degraded} onClick={() => setAckTarget(alertItem)}>
                          Ack
                        </Button>
                      )}
                      <Menu>
                        <MenuTrigger disableButtonEnhancement>
                          {/* Peer review NIT 22 — `rowBusy` dropped: it tracks the Un-ack/Un-snooze double-submit guard, which is unrelated to whether the OVERFLOW menu itself should be reachable — disabling this trigger while an unrelated inline action is in flight only made the Snooze/Un-snooze option briefly unreachable for no reason. */}
                          <Button size="small" icon={<MoreHorizontal20Regular />} disabled={degraded} aria-label={`More actions for ${alertItem.name}`} />
                        </MenuTrigger>
                        <MenuPopover>
                          <MenuList>
                            {isSnoozed ? (
                              <MenuItem onClick={() => handleUnsnooze(alertItem)}>Un-snooze</MenuItem>
                            ) : (
                              <MenuItem onClick={() => setSnoozeTarget(alertItem)}>Snooze</MenuItem>
                            )}
                          </MenuList>
                        </MenuPopover>
                      </Menu>
                    </div>
                  </RoleGate>
                );
              }}
            />
          )}
        </AsyncState>
      </div>

      {/* AM-29 item 30: acknowledge is severity 'low' — reversible via Un-ack — migrated off ReasonConfirmDialog onto the primitive. optionalReason (Opus peer review MAJOR item 1) keeps the audited reason capturable without making it mandatory. */}
      {ackTarget && (
        <ConfirmModal
          title={`Acknowledge "${ackTarget.name}"?`}
          severity="low"
          optionalReason
          description="Records who acknowledged it and when — it does not close the alert in Azure Monitor. This can be undone with Un-ack."
          confirmLabel="Acknowledge"
          busy={actionBusy}
          error={actionError}
          onConfirm={handleAck}
          onCancel={() => {
            if (actionBusy) return;
            setAckTarget(undefined);
            // AM-34 peer review NIT — a failed attempt's error must not
            // silently outlive the dialog that showed it; the next ack/
            // snooze open should start clean, not carry over a stale error
            // from a previous, unrelated alert's failed attempt.
            setActionError(undefined);
          }}
        />
      )}

      {snoozeTarget && (
        <SnoozeDialog
          title={`Snooze "${snoozeTarget.name}"`}
          minHours={MIN_SNOOZE_HOURS}
          maxHours={MAX_SNOOZE_HOURS}
          busy={actionBusy}
          error={actionError}
          onConfirm={handleSnooze}
          onCancel={() => {
            if (actionBusy) return;
            setSnoozeTarget(undefined);
            setActionError(undefined);
          }}
        />
      )}
    </Card>
  );
}

/** Curated KQL views: named-view picker + time-range picker + results table. Viewer+. */
function LogsViewsSection() {
  const styles = useStyles();
  const cardStyles = useCardStyles();
  const views = usePolling(getLogsViews, VIEWS_POLL_INTERVAL_MS);
  // Tracks only an EXPLICIT user selection — defaults to the first loaded
  // view via a plain derived value below, not a setState-in-useEffect (an
  // effect that just mirrors already-available render-time data into state
  // causes an extra cascading render for no benefit; see
  // https://react.dev/learn/you-might-not-need-an-effect).
  const [selectedViewIdOverride, setSelectedViewIdOverride] = useState<string | undefined>(undefined);
  const [timespanHours, setTimespanHours] = useState(24);
  const [result, setResult] = useState<LogsQueryResponse | undefined>(undefined);
  const [runError, setRunError] = useState<string | undefined>(undefined);
  const [running, setRunning] = useState(false);

  const selectedViewId = selectedViewIdOverride ?? views.data?.[0]?.id;
  const selectedView: LogsViewSummary | undefined = views.data?.find((view) => view.id === selectedViewId);

  async function handleRun() {
    if (!selectedViewId) return;
    setRunning(true);
    setRunError(undefined);
    setResult(undefined);
    try {
      const response = await runLogsView(selectedViewId, timespanHours);
      setResult(response);
    } catch (error) {
      setRunError(error instanceof Error ? error.message : 'Failed to run the view.');
    } finally {
      setRunning(false);
    }
  }

  return (
    <Card className={cardStyles.card}>
      <CardHeader header={<Text as="h2" size={400} weight="semibold">Curated views</Text>} />
      <div className={styles.section}>
        <AsyncState loading={views.loading} error={views.error as Error | undefined} data={views.data} isEmpty={(data) => data.length === 0} emptyMessage="No curated views available.">
          {(data) => (
            <>
              <div className={styles.toolbar}>
                <Dropdown
                  aria-label="Curated view"
                  style={{ minWidth: '260px' }}
                  value={selectedView?.name ?? ''}
                  selectedOptions={selectedViewId ? [selectedViewId] : []}
                  onOptionSelect={(_event, optionData) => {
                    if (optionData.optionValue) setSelectedViewIdOverride(optionData.optionValue);
                  }}
                >
                  {data.map((view) => (
                    <Option key={view.id} value={view.id} text={view.name}>
                      {view.name}
                    </Option>
                  ))}
                </Dropdown>
                <Dropdown
                  aria-label="Time range"
                  style={{ minWidth: '120px' }}
                  value={`Last ${timespanHours}h`}
                  selectedOptions={[String(timespanHours)]}
                  onOptionSelect={(_event, optionData) => {
                    if (optionData.optionValue) setTimespanHours(Number(optionData.optionValue));
                  }}
                >
                  {HOURS_OPTIONS.map((option) => (
                    <Option key={option} value={String(option)} text={`Last ${option}h`}>
                      Last {option}h
                    </Option>
                  ))}
                </Dropdown>
                <Button appearance="primary" disabled={!selectedViewId || running} onClick={handleRun}>
                  {running ? <Spinner size="tiny" /> : 'Run'}
                </Button>
              </div>
              {selectedView && (
                <Text size={200} block>
                  {selectedView.description}
                </Text>
              )}
            </>
          )}
        </AsyncState>

        {runError && (
          <MessageBar intent="error" className={styles.errorGap}>
            <MessageBarBody>{runError}</MessageBarBody>
          </MessageBar>
        )}

        {result?.tables.map((table, index) => (
          // A curated view returns one primary result table in practice;
          // keyed by index since a table has no stable id of its own.
          <LogsResultsTable key={index} table={table} exportFileName={selectedView ? `${selectedView.id}-${timespanHours}h` : `logs-view-${index}`} />
        ))}
      </div>
    </Card>
  );
}

/** Raw KQL escape hatch — operator+ only (RoleGate here is a UI convenience; the API independently enforces this via requireMinimumRole). */
function RawKqlSection() {
  const styles = useStyles();
  const cardStyles = useCardStyles();
  const [kql, setKql] = useState('');
  const [timespanHours, setTimespanHours] = useState(24);
  const [result, setResult] = useState<LogsQueryResponse | undefined>(undefined);
  const [runError, setRunError] = useState<string | undefined>(undefined);
  const [running, setRunning] = useState(false);

  async function handleRun() {
    setRunning(true);
    setRunError(undefined);
    setResult(undefined);
    try {
      const response = await runRawKql({ kql, timespanHours });
      setResult(response);
    } catch (error) {
      setRunError(error instanceof Error ? error.message : 'Failed to run the query.');
    } finally {
      setRunning(false);
    }
  }

  return (
    <RoleGate allowed={['operator', 'admin']}>
      <Card className={cardStyles.card}>
        <CardHeader header={<Text as="h2" size={400} weight="semibold">Raw KQL</Text>} />
        <div className={styles.section}>
          <Text size={200}>
            Queries run read-only against LAW-CONTOSO-PROD, capped at {MAX_KQL_LENGTH.toLocaleString()} characters, a {HOURS_OPTIONS[HOURS_OPTIONS.length - 1]}h time range, and 1,000 result
            rows — every run is recorded in the audit log.
          </Text>
          <Textarea
            className={styles.kqlEditor}
            value={kql}
            onChange={(_event, data) => setKql(data.value)}
            placeholder="WVDConnections | take 50"
            maxLength={MAX_KQL_LENGTH}
          />
          <div className={styles.toolbar}>
            <Dropdown
              aria-label="Time range"
              style={{ minWidth: '120px' }}
              value={`Last ${timespanHours}h`}
              selectedOptions={[String(timespanHours)]}
              onOptionSelect={(_event, optionData) => {
                if (optionData.optionValue) setTimespanHours(Number(optionData.optionValue));
              }}
            >
              {HOURS_OPTIONS.map((option) => (
                <Option key={option} value={String(option)} text={`Last ${option}h`}>
                  Last {option}h
                </Option>
              ))}
            </Dropdown>
            <Button appearance="primary" disabled={kql.trim().length === 0 || running} onClick={handleRun}>
              {running ? <Spinner size="tiny" /> : 'Run'}
            </Button>
          </div>

          {runError && (
            <MessageBar intent="error">
              <MessageBarBody>{runError}</MessageBarBody>
            </MessageBar>
          )}

          {result?.tables.map((table, index) => (
            // Raw query result table has no stable id of its own.
            <LogsResultsTable key={index} table={table} exportFileName={`raw-kql-${timespanHours}h`} />
          ))}
        </div>
      </Card>
    </RoleGate>
  );
}

/**
 * Monitoring — AM-24 alert & log center: 24h alert feed with ack/snooze
 * (and un-ack/un-snooze), curated KQL views, and a raw-KQL escape hatch
 * (operator+). The Dashboard still shows the last 3 fired alerts (GET
 * /api/v1/alerts/recent, actively-snoozed alerts excluded there — see
 * app/api/src/functions/alerts.ts) as a ticker; this page is the full
 * history + investigation surface.
 */
export default function Monitoring() {
  const styles = useStyles();
  // Lifted out of AlertsSection so the page-level PageHeader (item 27) can
  // surface the alert feed's own asOf/refreshing/refresh — the alert feed is
  // this page's primary polled data; the curated-views and raw-KQL sections
  // below are on-demand (Run button), not polled, so they have no asOf of
  // their own to contribute.
  const [hours, setHours] = useState(24);
  const alertsQuery = usePolling((signal) => getAlerts(hours, signal), ALERTS_POLL_INTERVAL_MS, [hours]);

  return (
    <div className={styles.page}>
      <PageHeader title="Monitoring" asOf={alertsQuery.lastUpdated} refreshing={alertsQuery.refreshing} onRefresh={() => alertsQuery.refresh()} />

      <AlertsSection hours={hours} setHours={setHours} alertsQuery={alertsQuery} />
      <LogsViewsSection />
      <RawKqlSection />
    </div>
  );
}
