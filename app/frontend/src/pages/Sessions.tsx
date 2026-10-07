import { useRef, useState } from 'react';
import {
  makeStyles,
  tokens,
  Card,
  CardHeader,
  Text,
  Field,
  Dropdown,
  Option,
  Input,
  Button,
  Menu,
  MenuTrigger,
  MenuPopover,
  MenuList,
  MenuItem,
  Toast,
  ToastTitle,
  Toolbar,
  ToolbarButton,
  Tooltip,
  MessageBar,
  MessageBarBody,
  MessageBarTitle,
  MessageBarActions,
} from '@fluentui/react-components';
import { Search16Regular, MoreHorizontal20Regular } from '@fluentui/react-icons';
import { broadcastSessionMessage, forceLogoffSession, getSessions, logoffAllDisconnectedSessions, sendSessionMessage } from '../api/avd';
import { ApiClientError } from '../api/client';
import { usePolling } from '../hooks/usePolling';
import { useRegisterSearchShortcut } from '../hooks/useKeyboardShortcuts';
import AsyncState from '../components/AsyncState';
import StatusBadge from '../components/StatusBadge';
import SessionAgeBadge from '../components/SessionAgeBadge';
import MessageComposeDialog from '../components/MessageComposeDialog';
import ConfirmModal from '../components/ConfirmModal';
import ImpactPreview from '../components/ImpactPreview';
import PageHeader from '../components/PageHeader';
import DataTable, { type DataTableColumn } from '../components/DataTable';
import { useAuth } from '../auth/useAuth';
import { formatDateTime } from '../lib/format';
import { compareRows, SESSION_STATE_OPTIONS, selectVisibleRows, toSessionRows, type SessionRow, type StateFilter } from '../lib/sessionRows';
import { broadcastPreviewLines, forceLogoffPreviewLines, logoffAllDisconnectedPreviewLines } from '../lib/impactPreview';
import { HOST_POOL_NAME } from '../lib/config';
import { useCardStyles } from '../styles/shared';
import { useAppToast } from '../lib/toaster';
import type { SessionBatchResult, UserSession } from '@avdmgr/shared';

const POLL_INTERVAL_MS = 60_000;

const useStyles = makeStyles({
  page: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXL,
  },
  toolbar: {
    display: 'flex',
    alignItems: 'flex-end',
    gap: tokens.spacingHorizontalM,
    marginBottom: tokens.spacingVerticalM,
  },
  // Page-level bulk-action toolbar (Log off all disconnected / Broadcast),
  // rendered above the AM-21 filter row — right-aligned, distinct from the
  // filter row's flex-end/gap layout above.
  bulkToolbar: {
    display: 'flex',
    justifyContent: 'flex-end',
  },
  filterField: {
    minWidth: '200px',
  },
  rowActions: {
    display: 'flex',
    gap: tokens.spacingHorizontalXS,
  },
  failureList: {
    marginTop: tokens.spacingVerticalS,
    paddingLeft: tokens.spacingHorizontalL,
  },
  correlationId: {
    marginTop: tokens.spacingVerticalXS,
    color: tokens.colorNeutralForeground3,
  },
});

function stateTone(state: UserSession['sessionState']): 'ok' | 'warning' | 'info' | 'error' {
  switch (state) {
    case 'Active':
      return 'ok';
    case 'Disconnected':
    case 'Pending':
      return 'warning';
    case 'LogOff':
      return 'info';
    default:
      return 'info';
  }
}

// AM-35 (item 44) — sorting itself is owned by DataTable (aria-sort + its
// own "Sorted by X ascending/descending" announcement, AM-31 item 43's
// pattern, reused there rather than hand-rolled here); this page still owns
// FILTERING (state dropdown + free-text search, AM-31 items 21/38 — see
// selectVisibleRows below, called with no sort column so it only filters)
// since that's Sessions-specific business logic DataTable has no opinion
// on. Each column's comparator calls straight into lib/sessionRows.ts's own
// compareRows, parameterized per column id — the exact same sort rules
// (e.g. unknown startTime/age always sorting last, in either direction)
// this table used before AM-35's refactor.
//
// Peer review (Opus, MINOR 5) — hoisted to MODULE scope (not rebuilt every
// render): this column set closes over nothing component-local (only
// imported/module-level functions and per-row data), so recreating it
// every render — including on every usePolling `refreshing` flip, twice per
// poll tick — needlessly busted DataTable's own sortedRows memo for no
// reason; a stable array reference fixes that for free.
const SESSION_COLUMNS: DataTableColumn<SessionRow>[] = [
  { id: 'user', label: 'User', renderCell: (row) => row.session.userPrincipalName, sortable: true, comparator: (a, b, direction) => compareRows(a, b, 'user', direction) },
  {
    id: 'state',
    label: 'State',
    renderCell: (row) => <StatusBadge label={row.session.sessionState} tone={stateTone(row.session.sessionState)} />,
    sortable: true,
    comparator: (a, b, direction) => compareRows(a, b, 'state', direction),
  },
  { id: 'host', label: 'Host', renderCell: (row) => row.session.sessionHostName, sortable: true, comparator: (a, b, direction) => compareRows(a, b, 'host', direction) },
  {
    id: 'startTime',
    label: 'Start time',
    renderCell: (row) => formatDateTime(row.session.createTime),
    sortable: true,
    comparator: (a, b, direction) => compareRows(a, b, 'startTime', direction),
  },
  { id: 'age', label: 'Age', renderCell: (row) => <SessionAgeBadge info={row.ageInfo} />, sortable: true, comparator: (a, b, direction) => compareRows(a, b, 'age', direction) },
];

/**
 * True for the AbortSignal-driven rejection apiFetch's fetch() call throws
 * when the request is aborted — either apiClient's own `timeoutMs` elapsing
 * (a `TimeoutError` DOMException, per the WHATWG fetch spec's
 * `AbortSignal.timeout()` behavior) or the caller's own signal aborting (an
 * `AbortError` DOMException). AM-20 review item 2: the two batch endpoints
 * (logoffAllDisconnectedSessions/broadcastSessionMessage) run a server-side
 * batch that can legitimately outlive even the raised 120s client timeout
 * (see api/avd.ts's BATCH_TIMEOUT_MS) for a large host pool — a timeout here
 * means "still running in Azure, unknown outcome yet", NOT "the operation
 * failed", so it must be handled distinctly from a real ApiClientError.
 */
function isTimeoutOrAbortError(error: unknown): boolean {
  return error instanceof DOMException && (error.name === 'TimeoutError' || error.name === 'AbortError');
}

interface BatchOutcome {
  label: string;
  result: SessionBatchResult;
  correlationId: string;
}

/** Renders "Logged off 3 of 3" / "Messaged 2 of 3 (1 failed)" plus a per-session failure list and the correlationId, shared by the logoff-all-disconnected and broadcast success MessageBars. */
function BatchResultSummary({ outcome, styles }: { outcome: BatchOutcome; styles: ReturnType<typeof useStyles> }) {
  const { label, result, correlationId } = outcome;
  return (
    <>
      <MessageBarTitle>{label}</MessageBarTitle>
      {result.attempted === 0
        ? 'No matching sessions were found.'
        : `${result.succeeded} of ${result.attempted} succeeded${result.skipped > 0 ? ` (${result.skipped} already gone)` : ''}${result.failed.length > 0 ? ` (${result.failed.length} failed)` : ''}.`}
      {result.failed.length > 0 && (
        <ul className={styles.failureList}>
          {result.failed.map((failure) => (
            // Keyed on host+session, not sessionId alone — ARM's
            // userSessionId is only unique WITHIN a session host (e.g. "1"
            // on two different hosts are different sessions), so
            // sessionId-only keys collide across hosts (AM-20 peer review).
            <li key={`${failure.sessionHostName}/${failure.sessionId}`}>
              {failure.userPrincipalName} on {failure.sessionHostName}: {failure.message}
            </li>
          ))}
        </ul>
      )}
      <Text size={200} block className={styles.correlationId}>
        Reference: {correlationId}
      </Text>
    </>
  );
}

/**
 * Sessions — active/disconnected user sessions across the configured host
 * pool.
 *
 * State filter and column sort (AM-21/AM-10) are plain component state, so
 * they naturally survive the 60s polling refresh — usePolling only swaps
 * out `data`, it never remounts this component. Row shaping/filtering/
 * sorting itself lives in lib/sessionRows.ts (React-free, unit-testable);
 * age color-coding lives in lib/sessionAge.ts.
 *
 * M2-S3 (AM-20) adds operator/admin-gated mutations: per-row force logoff
 * (mandatory reason) and send-message, plus page-level
 * logoff-all-disconnected (typed host-pool-name confirm + mandatory reason)
 * and broadcast (compose + confirm). Viewers see the read-only table only —
 * every action column/toolbar button below is gated on `canMutate`, mirroring
 * HostPool.tsx's pattern. The API independently re-checks via
 * requireMinimumRole('operator') regardless of what the UI shows. Row
 * actions operate on the filtered/sorted row's session, and per-row dialog
 * targets are snapshotted at open time (see logoffTarget/messageTarget
 * below) rather than re-derived from `sessions.data`, so a background poll
 * can never unmount a dialog mid-interaction.
 */
export default function Sessions() {
  const styles = useStyles();
  const cardStyles = useCardStyles();
  const { dispatchToast } = useAppToast();
  const { role } = useAuth();
  const canMutate = role === 'operator' || role === 'admin';

  const sessions = usePolling((signal) => getSessions(HOST_POOL_NAME, signal), POLL_INTERVAL_MS);
  // Deliberately derived from the UNFILTERED sessions.data, not the
  // filtered/sorted table rows below — these drive the page-level toolbar's
  // disabled state and confirmation copy, and an operator who has filtered
  // the table down to (say) just "Active" sessions must still be able to see
  // and act on the true disconnected/active counts across the whole host
  // pool (AM-21's table filter is a view concern only, not a scope limiter
  // on AM-20's bulk actions).
  const disconnectedCount = sessions.data?.filter((session) => session.sessionState === 'Disconnected').length ?? 0;
  const activeCount = sessions.data?.filter((session) => session.sessionState === 'Active').length ?? 0;

  const [stillRunningMessage, setStillRunningMessage] = useState<string | undefined>(undefined);
  const [batchOutcome, setBatchOutcome] = useState<BatchOutcome | undefined>(undefined);

  // --- Force logoff (per row) ---
  // The target is SNAPSHOTTED into state at open time (not re-derived from
  // the live, polling-refreshed `sessions.data` list) — AM-20 peer review:
  // re-deriving from the polled list meant a background poll that no longer
  // includes this session (e.g. it disconnects, or the list just reorders)
  // would unmount the dialog mid-typing and silently discard whatever
  // reason the operator had already entered. A snapshot is stable for the
  // lifetime of the dialog regardless of what the poll does in the
  // background; the mutation itself still always targets the session's
  // real, current sessionHostName/sessionId (unchanged for a given
  // session's lifetime), not stale display data.
  const [logoffTarget, setLogoffTarget] = useState<UserSession | undefined>(undefined);
  const [logoffBusy, setLogoffBusy] = useState(false);
  const [logoffError, setLogoffError] = useState<string | undefined>(undefined);

  function openLogoffDialog(session: UserSession) {
    setLogoffTarget(session);
    setLogoffError(undefined);
  }
  function cancelLogoffDialog() {
    setLogoffTarget(undefined);
    setLogoffError(undefined);
  }
  async function confirmLogoff(reason: string | undefined) {
    if (!logoffTarget || !reason) return;
    setLogoffBusy(true);
    setLogoffError(undefined);
    try {
      await forceLogoffSession(HOST_POOL_NAME, logoffTarget.sessionHostName, logoffTarget.sessionId, { reason, userPrincipalName: logoffTarget.userPrincipalName });
      setLogoffTarget(undefined);
      dispatchToast(
        <Toast>
          <ToastTitle>Forced {logoffTarget.userPrincipalName} to log off {logoffTarget.sessionHostName}</ToastTitle>
        </Toast>,
        { intent: 'success' },
      );
      sessions.refresh();
    } catch (error) {
      setLogoffError(error instanceof ApiClientError ? error.message : 'Failed to force the session to log off.');
    } finally {
      setLogoffBusy(false);
    }
  }

  // --- Send message (per row) --- same snapshot-on-open rationale as logoffTarget above.
  const [messageTarget, setMessageTarget] = useState<UserSession | undefined>(undefined);
  const [messageBusy, setMessageBusy] = useState(false);
  const [messageError, setMessageError] = useState<string | undefined>(undefined);

  function openMessageDialog(session: UserSession) {
    setMessageTarget(session);
    setMessageError(undefined);
  }
  function cancelMessageDialog() {
    setMessageTarget(undefined);
    setMessageError(undefined);
  }
  async function confirmMessage(message: { title: string | undefined; body: string }) {
    if (!messageTarget) return;
    setMessageBusy(true);
    setMessageError(undefined);
    try {
      await sendSessionMessage(HOST_POOL_NAME, messageTarget.sessionHostName, messageTarget.sessionId, message);
      setMessageTarget(undefined);
      dispatchToast(
        <Toast>
          <ToastTitle>Sent a message to {messageTarget.userPrincipalName}</ToastTitle>
        </Toast>,
        { intent: 'success' },
      );
    } catch (error) {
      setMessageError(error instanceof ApiClientError ? error.message : 'Failed to send the message.');
    } finally {
      setMessageBusy(false);
    }
  }

  // --- Logoff all disconnected (page toolbar): a single ConfirmModal,
  // severity 'medium' (mandatory reason, no typed name — see AM-29 item 30's
  // rubric) submitted in one step.
  //
  // AM-29 bug fix (item 1): this used to be a two-step flow — a ConfirmModal
  // (which already renders its own reason field) followed by a SECOND,
  // separate ReasonConfirmDialog purely to collect the reason again. The
  // handler wired to ConfirmModal's onConfirm ignored the reason argument
  // ConfirmModal already hands back (`onConfirm={() => setLogoffAllStep(...)}`
  // — the reason the operator typed into step one's reason field was silently
  // thrown away), so step two existed only to recollect data step one had
  // already collected. Fixed by using the reason ConfirmModal returns
  // directly, and — per item 30's severity rubric, which classifies
  // logoff-all-disconnected as 'medium' (reason, no typed name) — dropping
  // the typed host-pool-name gate entirely rather than keeping it as an
  // interim "high" shape.
  const [logoffAllOpen, setLogoffAllOpen] = useState(false);
  const [logoffAllBusy, setLogoffAllBusy] = useState(false);
  const [logoffAllError, setLogoffAllError] = useState<string | undefined>(undefined);

  function openLogoffAllDialog() {
    setLogoffAllOpen(true);
    setLogoffAllError(undefined);
  }
  function cancelLogoffAllDialog() {
    setLogoffAllOpen(false);
    setLogoffAllError(undefined);
  }
  async function confirmLogoffAll(reason: string | undefined) {
    if (!reason) return;
    setLogoffAllBusy(true);
    setLogoffAllError(undefined);
    try {
      const response = await logoffAllDisconnectedSessions(HOST_POOL_NAME, { reason });
      setLogoffAllOpen(false);
      setBatchOutcome({ label: 'Logged off disconnected sessions', result: response.result, correlationId: response.correlationId });
      sessions.refresh();
    } catch (error) {
      if (isTimeoutOrAbortError(error)) {
        // The server may well still be working through the batch — close
        // the dialog (retrying would start a SECOND batch on top of the
        // first) and tell the operator to check back, not that it failed.
        setLogoffAllOpen(false);
        setStillRunningMessage('Logging off disconnected sessions is taking longer than expected. It may still be running in Azure — refresh in a moment to see the result. Do not retry.');
      } else {
        setLogoffAllError(error instanceof ApiClientError ? error.message : 'Failed to log off disconnected sessions.');
      }
    } finally {
      setLogoffAllBusy(false);
    }
  }

  // --- Broadcast (page toolbar): compose + confirm, no typed-name gate —
  // sending a message is reversible/non-destructive, unlike forcing sessions
  // off, so the compose dialog itself is the confirmation step.
  const [broadcastOpen, setBroadcastOpen] = useState(false);
  const [broadcastBusy, setBroadcastBusy] = useState(false);
  const [broadcastError, setBroadcastError] = useState<string | undefined>(undefined);

  function openBroadcastDialog() {
    setBroadcastOpen(true);
    setBroadcastError(undefined);
  }
  function cancelBroadcastDialog() {
    setBroadcastOpen(false);
    setBroadcastError(undefined);
  }
  async function confirmBroadcast(message: { title: string | undefined; body: string }) {
    setBroadcastBusy(true);
    setBroadcastError(undefined);
    try {
      const response = await broadcastSessionMessage(HOST_POOL_NAME, message);
      setBroadcastOpen(false);
      setBatchOutcome({ label: 'Broadcast sent to active sessions', result: response.result, correlationId: response.correlationId });
    } catch (error) {
      if (isTimeoutOrAbortError(error)) {
        setBroadcastOpen(false);
        setStillRunningMessage('The broadcast is taking longer than expected. It may still be running in Azure — refresh in a moment to see the result. Do not retry.');
      } else {
        setBroadcastError(error instanceof ApiClientError ? error.message : 'Failed to send the broadcast.');
      }
    } finally {
      setBroadcastBusy(false);
    }
  }

  const [stateFilter, setStateFilter] = useState<StateFilter>('All');
  // AM-31 item 38 — free-text search by user UPN/display name or host, combined (AND) with the state filter above — see lib/sessionRows.ts#matchesSearch.
  const [searchQuery, setSearchQuery] = useState('');
  const searchInputRef = useRef<HTMLInputElement>(null);
  // AM-31 item 36 — the `/` shortcut focuses this page's primary filter field.
  useRegisterSearchShortcut(() => searchInputRef.current?.focus());

  // Computed once per render, so every row's age badge and every sort
  // comparison in this pass uses the same instant (mirrors Dashboard.tsx's
  // `now` for lastHeartBeat staleness).
  const now = new Date();

  // The filter only ever controls a table that's on screen once real data
  // has loaded — disable it while there's nothing to filter yet (initial
  // load, or an error with no prior data to fall back to).
  const filterDisabled = sessions.data === undefined;

  return (
    <div className={styles.page}>
      <PageHeader title={`Sessions — ${HOST_POOL_NAME}`} asOf={sessions.lastUpdated} refreshing={sessions.refreshing} onRefresh={() => sessions.refresh()} />

      {stillRunningMessage && (
        <MessageBar intent="info" role="status" aria-live="polite">
          <MessageBarBody>{stillRunningMessage}</MessageBarBody>
          <MessageBarActions>
            <Button appearance="transparent" size="small" onClick={() => sessions.refresh()}>
              Refresh now
            </Button>
            <Button appearance="transparent" size="small" onClick={() => setStillRunningMessage(undefined)}>
              Dismiss
            </Button>
          </MessageBarActions>
        </MessageBar>
      )}

      {batchOutcome && (
        <MessageBar intent={batchOutcome.result.failed.length > 0 ? 'warning' : 'success'} role="status" aria-live="polite">
          <MessageBarBody>
            <BatchResultSummary outcome={batchOutcome} styles={styles} />
          </MessageBarBody>
          <MessageBarActions>
            <Button appearance="transparent" size="small" onClick={() => setBatchOutcome(undefined)}>
              Dismiss
            </Button>
          </MessageBarActions>
        </MessageBar>
      )}

      {canMutate && (
        <div className={styles.bulkToolbar}>
          <Toolbar aria-label="Session bulk actions">
            <Tooltip
              content={disconnectedCount === 0 ? 'No disconnected sessions to log off.' : `Logs off ${disconnectedCount} disconnected session(s).`}
              relationship="label"
            >
              <ToolbarButton onClick={openLogoffAllDialog} disabled={disconnectedCount === 0}>
                Log off all disconnected
              </ToolbarButton>
            </Tooltip>
            <ToolbarButton onClick={openBroadcastDialog}>Broadcast message</ToolbarButton>
          </Toolbar>
        </div>
      )}

      <Card className={cardStyles.card}>
        <CardHeader header={<Text as="h2" size={400} weight="semibold">User sessions</Text>} />

        <div className={styles.toolbar}>
          <Field label="State" className={styles.filterField}>
            <Dropdown
              disabled={filterDisabled}
              value={stateFilter}
              selectedOptions={[stateFilter]}
              onOptionSelect={(_event, data) => setStateFilter((data.optionValue as StateFilter | undefined) ?? 'All')}
            >
              <Option value="All">All</Option>
              {SESSION_STATE_OPTIONS.map((state) => (
                <Option key={state} value={state}>
                  {state}
                </Option>
              ))}
            </Dropdown>
          </Field>
          {/* AM-31 item 38 */}
          <Field label="Search" className={styles.filterField}>
            <Input
              ref={searchInputRef}
              contentBefore={<Search16Regular />}
              disabled={filterDisabled}
              value={searchQuery}
              onChange={(_event, data) => setSearchQuery(data.value)}
              placeholder="User or host…"
            />
          </Field>
        </div>

        <AsyncState
          loading={sessions.loading}
          error={sessions.error as Error | undefined}
          data={sessions.data}
          asOf={sessions.lastUpdated}
          isEmpty={(data) => data.length === 0}
          emptyMessage="No active sessions."
          variant="table"
        >
          {(data) => {
            const rows = toSessionRows(data, now);
            // Filtering only (no sort column passed) — see the comment on SESSION_COLUMNS above for why sorting itself now lives in DataTable.
            const visibleRows = selectVisibleRows(rows, stateFilter, undefined, 'ascending', searchQuery);
            // Peer review (Opus, MINOR 3) — only a GENUINELY active filter/search gets this narrower description; otherwise `emptyMessage` above stays reachable (an unfiltered table showing zero rows must not claim "No sessions match ." with a live Clear-filters button when there's nothing to clear).
            const hasActiveFilter = stateFilter !== 'All' || searchQuery.trim().length > 0;

            return (
              <DataTable
                ariaLabel="User sessions"
                columns={SESSION_COLUMNS}
                rows={visibleRows}
                getRowKey={(row) => row.session.id}
                emptyMessage="No active sessions."
                activeFilterDescription={
                  // AM-31 item 38 — `undefined` (not `false`) when inactive: DataTable's `activeFilterDescription ?? emptyMessage` only falls through on null/undefined, so a falsy-but-defined value here would silently swallow emptyMessage too.
                  hasActiveFilter ? (
                    <>
                      No sessions match {stateFilter !== 'All' && <>state &quot;{stateFilter}&quot;</>}
                      {stateFilter !== 'All' && searchQuery.trim() && ' and '}
                      {searchQuery.trim() && <>search &quot;{searchQuery.trim()}&quot;</>}.
                    </>
                  ) : undefined
                }
                onClearFilters={hasActiveFilter ? () => {
                  setStateFilter('All');
                  setSearchQuery('');
                } : undefined}
                rowActions={
                  canMutate
                    ? (row) => {
                        const { session } = row;
                        const isActive = session.sessionState === 'Active';
                        return (
                          // AM-31 item 40 — Message stays inline (the most-frequent row action); Force logoff moves into the overflow menu.
                          <div className={styles.rowActions}>
                            {/* Only Active sessions can receive a message — see sessionsBroadcast.ts's same Active-only invariant. Disabled (with a tooltip) rather than hidden, so the row layout stays consistent. */}
                            <Tooltip content={isActive ? 'Send a message to this session.' : 'Only active sessions can receive a message.'} relationship="label">
                              <Button size="small" appearance="secondary" onClick={() => openMessageDialog(session)} disabled={!isActive}>
                                Message
                              </Button>
                            </Tooltip>
                            <Menu>
                              <MenuTrigger disableButtonEnhancement>
                                <Button size="small" appearance="secondary" icon={<MoreHorizontal20Regular />} aria-label={`More actions for ${session.userPrincipalName} on ${session.sessionHostName}`} />
                              </MenuTrigger>
                              <MenuPopover>
                                <MenuList>
                                  <MenuItem onClick={() => openLogoffDialog(session)}>Force logoff</MenuItem>
                                </MenuList>
                              </MenuPopover>
                            </Menu>
                          </div>
                        );
                      }
                    : undefined
                }
              />
            );
          }}
        </AsyncState>
      </Card>

      {logoffTarget && (
        <ConfirmModal
          title={`Force ${logoffTarget.userPrincipalName} to log off?`}
          description="This immediately ends the session, even if it is still active."
          impact={<ImpactPreview lines={forceLogoffPreviewLines(logoffTarget)} />}
          severity="medium"
          confirmLabel="Force logoff"
          busy={logoffBusy}
          error={logoffError}
          onConfirm={confirmLogoff}
          onCancel={cancelLogoffDialog}
        />
      )}

      {messageTarget && (
        <MessageComposeDialog
          title={`Send message to ${messageTarget.userPrincipalName}?`}
          description={`Sends a message to ${messageTarget.userPrincipalName}'s session on ${messageTarget.sessionHostName}.`}
          confirmLabel="Send"
          busy={messageBusy}
          error={messageError}
          onConfirm={confirmMessage}
          onCancel={cancelMessageDialog}
        />
      )}

      {logoffAllOpen && (
        <ConfirmModal
          title="Log off all disconnected sessions?"
          description={`This forces every DISCONNECTED session in ${HOST_POOL_NAME} to log off. Active sessions are never affected. This reason is recorded in the audit log.`}
          impact={<ImpactPreview lines={logoffAllDisconnectedPreviewLines(sessions.data ?? [], now)} />}
          severity="medium"
          confirmLabel="Log off disconnected sessions"
          busy={logoffAllBusy}
          error={logoffAllError}
          onConfirm={confirmLogoffAll}
          onCancel={cancelLogoffAllDialog}
        />
      )}

      {broadcastOpen && (
        <MessageComposeDialog
          title={`Broadcast to all active sessions in ${HOST_POOL_NAME}?`}
          description="Sends this message to every ACTIVE session in the host pool. Disconnected sessions are never messaged."
          impactSummary={<ImpactPreview lines={broadcastPreviewLines(activeCount)} />}
          confirmLabel="Broadcast"
          busy={broadcastBusy}
          error={broadcastError}
          onConfirm={confirmBroadcast}
          onCancel={cancelBroadcastDialog}
        />
      )}
    </div>
  );
}
