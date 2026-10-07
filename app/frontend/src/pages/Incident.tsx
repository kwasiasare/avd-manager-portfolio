import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  makeStyles,
  tokens,
  Card,
  CardHeader,
  Text,
  Button,
  Menu,
  MenuTrigger,
  MenuPopover,
  MenuList,
  MenuItem,
  Toast,
  ToastTitle,
  ToastBody,
  Tooltip,
  MessageBar,
  MessageBarBody,
} from '@fluentui/react-components';
import { MoreHorizontal20Regular } from '@fluentui/react-icons';
import type { AlertsFeedResponse, AlertSummary, AuditEntryDto, AuditRecentResponse, SessionHost, SessionHostPowerAction, UserSession } from '@avdmgr/shared';
import {
  ackAlert,
  forceLogoffSession,
  getAlerts,
  getRecentAuditEntries,
  getSessionHosts,
  getSessions,
  sendSessionMessage,
  setSessionHostDrain,
  setSessionHostPower,
  snoozeAlert,
} from '../api/avd';
import { ApiClientError } from '../api/client';
import { usePolling } from '../hooks/usePolling';
import AsyncState from '../components/AsyncState';
import StatusBadge, { type StatusTone } from '../components/StatusBadge';
import PageHeader from '../components/PageHeader';
import RoleGate from '../components/RoleGate';
import ConfirmModal from '../components/ConfirmModal';
import ImpactPreview from '../components/ImpactPreview';
import SnoozeDialog from '../components/SnoozeDialog';
import MessageComposeDialog from '../components/MessageComposeDialog';
import SessionHostCard from '../components/SessionHostCard';
import HealthChecksDrawer from '../components/HealthChecksDrawer';
import SessionsWarningDialog from '../components/SessionsWarningDialog';
import DataTable, { type DataTableColumn } from '../components/DataTable';
import { useAuth } from '../auth/useAuth';
import { HOST_POOL_NAME } from '../lib/config';
import { useCardStyles } from '../styles/shared';
import { toSessionHostViewModel } from '../lib/sessionHostViewModel';
import { isDisruptivePowerAction, powerActionLabel } from '../lib/sessionHostPowerActions';
import { forceLogoffPreviewLines, hostPowerPreviewLines } from '../lib/impactPreview';
import { selectAffectedHosts, selectSessionsOnHosts } from '../lib/incidentView';
import { formatRelativeToNow } from '../lib/format';
import { useAppToast } from '../lib/toaster';
import { MAX_SNOOZE_HOURS, MIN_SNOOZE_HOURS } from '../lib/alertSnooze';

/**
 * AM-34 (M8-W5, D6) — poll cadences per this item's own spec: tighter than
 * every other page's default 60s (this is the "moment an operator is
 * least able to navigate" screen — fresher data matters more than the
 * extra Function App wake-ups). This page mounts four of its own pollers
 * (sessionHosts/sessions/alertsQuery/audit below) — five concurrent
 * pollers once EstateStrip's own GET /v1/estate/summary poll is counted
 * (EstateStrip is mounted once in Layout.tsx, on every route including
 * this one, not owned by this page). All five are visibility-gated by
 * usePolling itself (see that hook's own doc comment) and stop entirely on
 * unmount — nothing here needs its own cleanup beyond what usePolling
 * already provides.
 */
const HOSTS_SESSIONS_POLL_INTERVAL_MS = 20_000;
const ALERTS_POLL_INTERVAL_MS = 30_000;
const AUDIT_POLL_INTERVAL_MS = 60_000;

/** Matches EstateStrip/RecentActionsDrawer's own "open" alert window (fired in the last 24h) — see estateSummaryService.ts's UNACKED_ALERT_LOOKBACK_HOURS doc comment. */
const ALERTS_LOOKBACK_HOURS = 24;

/** "last ~15" per this item's own spec — noticeably tighter than RecentActionsDrawer's 25 (a quick glance INSIDE an already-compact incident screen, not that drawer's own "did someone already do X" scan). */
const AUDIT_TOP = 15;
const AUDIT_SINCE_HOURS = 24;

const useStyles = makeStyles({
  page: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXL,
  },
  gateNote: {
    color: tokens.colorNeutralForeground3,
  },
  // Two columns per the mockup, collapsing to one below ~900px — same
  // "narrow viewport -> stack" idea Layout.tsx's own responsive nav
  // breakpoints use, just scoped to this page's own grid rather than the
  // whole app shell.
  grid: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: tokens.spacingHorizontalL,
    alignItems: 'start',
    '@media (max-width: 899px)': {
      gridTemplateColumns: '1fr',
    },
  },
  column: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalL,
  },
  cardGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
    gap: tokens.spacingHorizontalM,
  },
  calmNote: {
    color: tokens.colorNeutralForeground3,
    marginBottom: tokens.spacingVerticalS,
  },
  rowActions: {
    display: 'flex',
    gap: tokens.spacingHorizontalXS,
  },
  list: {
    listStyle: 'none',
    margin: 0,
    padding: 0,
  },
  row: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXXS,
    padding: `${tokens.spacingVerticalS} 0`,
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  rowTop: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: tokens.spacingHorizontalS,
  },
  muted: {
    color: tokens.colorNeutralForeground3,
  },
});

/** Mirrors Sessions.tsx's own stateTone mapping (page-local, same as that file — not shared, this app duplicates small tone-mapping functions per page; see e.g. Monitoring.tsx's severityTone/statusTone vs. Dashboard.tsx's own SEVERITY_TONE). */
function sessionStateTone(state: UserSession['sessionState']): StatusTone {
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

const INCIDENT_SESSION_COLUMNS: DataTableColumn<UserSession>[] = [
  { id: 'user', label: 'User', renderCell: (session) => session.userPrincipalName },
  { id: 'state', label: 'State', renderCell: (session) => <StatusBadge label={session.sessionState} tone={sessionStateTone(session.sessionState)} /> },
  { id: 'host', label: 'Host', renderCell: (session) => session.sessionHostName },
];

/** Mirrors Monitoring.tsx's own severityTone mapping (page-local — see this file's own doc comment above). */
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

/** Mirrors RecentActionsDrawer.tsx's own OUTCOME_TONE (also duplicated verbatim in Audit.tsx already — see those files' own doc comments for why 'accepted' isn't 'success'-toned). */
const OUTCOME_TONE: Record<AuditEntryDto['outcome'], StatusTone> = {
  success: 'ok',
  accepted: 'warning',
  failure: 'error',
};

/** Mirrors RecentActionsDrawer.tsx's own shortActor helper. */
function shortActor(actor: string): string {
  const at = actor.indexOf('@');
  return at > 0 ? actor.slice(0, at) : actor;
}

/**
 * AM-34 (M8-W5 — D6 "incident mode", mockup exhibit D on AM-29): a single
 * screen collapsing the four-page, ten-click mid-incident workflow
 * (Monitoring -> ack, Host Pool -> drain/power, Sessions -> message/logoff,
 * Audit -> what happened) for the moment an operator is least able to
 * navigate between pages. Pure COMPOSITION of existing pieces — no new
 * endpoints, no incident-state persistence, no alert routing; every
 * mutation here calls the exact same API wrapper (and shares the exact same
 * dialogs) HostPool.tsx/Dashboard.tsx/Sessions.tsx/Monitoring.tsx already
 * use for the same action, just re-scoped to the hosts/sessions/alerts that
 * matter mid-incident.
 *
 * Reached from three entry points (see the coordinating ticket): the
 * EstateStrip's own "Incident" toggle, the `g n` keyboard chord, and the
 * command palette's Navigation group (all three feed the same
 * NAV_SHORTCUTS row — see useKeyboardShortcuts.ts). "Exit incident mode" (a
 * PageHeader action, not hidden away in a menu) is the way back to the
 * Dashboard — the EstateStrip toggle ALSO acts as an exit from here (see
 * that component's own doc comment).
 *
 * operator+ only: unlike Audit.tsx (which still shows its shell/filters to
 * a viewer and only gates the table), this page's WHOLE content grid is
 * gated — every section here is either a mutation surface or feeds one, and
 * there's no meaningfully-scoped "read-only incident view" this app's RBAC
 * model draws a line at. `ready` (derived from `canView` AND auth having
 * actually finished loading — see its own doc comment below) folds into
 * every one of this page's four poller fetchers, so a viewer's fetches
 * never actually hit the network at all, not just never render — and an
 * operator's own fetches don't fire prematurely against a still-resolving
 * role either.
 */
export default function Incident() {
  const styles = useStyles();
  const cardStyles = useCardStyles();
  const navigate = useNavigate();
  const { dispatchToast } = useAppToast();
  const { role, loading: authLoading } = useAuth();
  const canView = role === 'operator' || role === 'admin';
  /**
   * AM-34 peer review (Opus, MAJOR 2) — `ready` (not `canView` alone) gates
   * every fetcher below. `canView` is false BOTH while auth is still
   * resolving (role starts `null` — see AuthContext.tsx) AND for a
   * confirmed viewer, so using it alone made the fetchers resolve their
   * empty/fallback shape IMMEDIATELY on mount even for an operator whose
   * role just hasn't loaded yet — usePolling treated that as a genuine
   * successful fetch (loading -> false, lastUpdated -> now), so an
   * operator saw a confidently-empty "No open alerts" etc. flash, with a
   * real "As of" timestamp, before their real data ever arrived. Gating on
   * `ready` = `!authLoading && canView` instead means the fetcher below
   * returns a promise that NEVER resolves while not ready — usePolling's
   * `loading` stays true (the skeleton keeps showing, no fake asOf) until
   * either the role resolves to operator/admin (a fresh fetch effect run
   * fires the real call) or — for a genuine viewer, where `ready` never
   * becomes true — forever, which is fine: RoleGate below never renders
   * anything that would show that stuck `loading` state, and the real API
   * function is still never called (a never-settling promise never
   * reaches the network), preserving the "zero fetches for a viewer"
   * requirement exactly as before.
   */
  const ready = !authLoading && canView;

  const sessionHosts = usePolling((signal) => (ready ? getSessionHosts(HOST_POOL_NAME, signal) : new Promise<SessionHost[]>(() => {})), HOSTS_SESSIONS_POLL_INTERVAL_MS, [ready]);
  const sessions = usePolling((signal) => (ready ? getSessions(HOST_POOL_NAME, signal) : new Promise<UserSession[]>(() => {})), HOSTS_SESSIONS_POLL_INTERVAL_MS, [ready]);
  const alertsQuery = usePolling(
    (signal) => (ready ? getAlerts(ALERTS_LOOKBACK_HOURS, signal) : new Promise<AlertsFeedResponse>(() => {})),
    ALERTS_POLL_INTERVAL_MS,
    [ready],
  );
  const audit = usePolling(
    (signal) => (ready ? getRecentAuditEntries({ top: AUDIT_TOP, sinceHours: AUDIT_SINCE_HOURS }, signal) : new Promise<AuditRecentResponse>(() => {})),
    AUDIT_POLL_INTERVAL_MS,
    [ready],
  );

  const allQueries = [sessionHosts, sessions, alertsQuery, audit];
  const anyRefreshing = allQueries.some((query) => query.refreshing);
  const latestUpdated = allQueries.reduce<Date | undefined>((latest, query) => (!query.lastUpdated ? latest : !latest || query.lastUpdated > latest ? query.lastUpdated : latest), undefined);
  function refreshAll() {
    for (const query of allQueries) query.refresh();
  }

  // Computed once per render — every card's heartbeat-staleness check and
  // every session-age-adjacent comparison in this pass shares one instant,
  // matching Dashboard.tsx's own convention. Deliberately NOT itself
  // wrapped in useMemo (react-hooks/exhaustive-deps suggests that below,
  // since it's used as a useMemo dep) — a memoized `now` would freeze at
  // whatever instant this component first mounted, which is wrong: every
  // poll-driven re-render needs heartbeat staleness measured against the
  // CURRENT instant, not a stale one from mount.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- see the comment above: `now` changing every render is correct/by-design here, not a bug to fix by memoizing it.
  const now = new Date();

  // AM-34 peer review (Opus, MINOR 11) — memoized (HostPool.tsx's own
  // pattern for its analogous per-render derivations), though `now`'s own
  // identity changes every render regardless (a fresh `Date` above), so
  // this doesn't skip recomputation across renders the way HostPool's
  // memoized lookups do — it exists for shape/consistency with that
  // pattern and to keep this derivation named and reusable below, not for
  // a real memoization win.
  const hostViewModels = useMemo(() => sessionHosts.data?.map((host) => toSessionHostViewModel(host, { now })), [sessionHosts.data, now]);
  const affected = hostViewModels ? selectAffectedHosts(hostViewModels) : undefined;
  // AM-34 peer review (Opus, MAJOR 1) — deliberately gated on `affected`
  // (undefined until sessionHosts has ACTUALLY resolved), not on a
  // `affectedHostNames ?? []` fallback: the earlier shape defaulted to an
  // empty host-name list whenever sessionHosts hadn't loaded yet (or had
  // FAILED to load), which made selectSessionsOnHosts return `[]` — the
  // Sessions card then rendered "No sessions on the affected hosts." as if
  // that were a confirmed, current fact, even while the affected-hosts set
  // was genuinely unknown or the hosts poll had errored outright. Passing
  // `undefined` through in both of those cases instead lets AsyncState
  // (below, driven by `sessions.loading || sessionHosts.loading` and
  // `sessions.error ?? sessionHosts.error`) show its OWN loading/error
  // state rather than a lie.
  const sessionsOnAffectedHosts = affected && sessions.data ? selectSessionsOnHosts(sessions.data, affected.hosts.map((host) => host.name)) : undefined;
  // AM-34 peer review NIT — deliberately still just `!ackedBy` (a snoozed-
  // but-unacked alert still counts as "open" here), matching
  // EstateStrip/estateSummaryService.ts's own `openAlertCount` semantics
  // exactly — an operator landing on THIS screen because the strip told
  // them N alerts are open should see the same N alerts, not a smaller,
  // differently-filtered set.
  const openAlerts = alertsQuery.data?.alerts.filter((alert) => !alert.ackedBy);

  // --- Alert ack/snooze — mirrors Monitoring.tsx's AlertsSection handlers
  // (same ackAlert/snoozeAlert calls, same ConfirmModal/SnoozeDialog),
  // re-scoped to this page's own openAlerts list. Not exported from
  // Monitoring.tsx (a page-local function there), so this is its own copy —
  // same "small page-local handler duplication calling the same shared API
  // wrapper + shared dialog" shape HostPool.tsx/Dashboard.tsx already use
  // for drain/power (see those files' own doc comments).
  const [ackTarget, setAckTarget] = useState<AlertSummary | undefined>(undefined);
  const [snoozeTarget, setSnoozeTarget] = useState<AlertSummary | undefined>(undefined);
  // Shared busy/error pair for BOTH ack and snooze — mirrors Monitoring.tsx's
  // AlertsSection exactly (its own actionBusy/actionError single pair
  // covers both flows too). Passed straight into whichever of
  // ConfirmModal's/SnoozeDialog's own `error` prop is currently open (AM-34
  // peer review MINOR 5 added SnoozeDialog's `error` prop — see that
  // component), AND rendered as a page-level MessageBar in the "Open
  // alerts" card below for the one case neither dialog covers: this app
  // has no un-ack/un-snooze affordance on THIS screen (only Monitoring.tsx
  // has those direct, no-dialog actions), so in practice the page-level
  // MessageBar here is always masked behind whichever dialog is open when
  // an error occurs — kept anyway for shape-parity with Monitoring.tsx's
  // identical pair, where it importantly is NOT always masked (that page's
  // handleUnack/handleUnsnooze act with no dialog open at all).
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState<string | undefined>(undefined);
  async function handleAck(reason: string | undefined) {
    if (!ackTarget) return;
    setActionBusy(true);
    setActionError(undefined);
    try {
      await ackAlert(ackTarget.id, { reason });
      dispatchToast(
        <Toast>
          <ToastTitle>Acknowledged &quot;{ackTarget.name}&quot;</ToastTitle>
        </Toast>,
        { intent: 'success' },
      );
      setAckTarget(undefined);
      alertsQuery.refresh();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Failed to acknowledge alert.');
    } finally {
      setActionBusy(false);
    }
  }

  async function handleSnooze(hours: number, reason: string) {
    if (!snoozeTarget) return;
    setActionBusy(true);
    setActionError(undefined);
    try {
      await snoozeAlert(snoozeTarget.id, { hours, reason: reason || undefined });
      dispatchToast(
        <Toast>
          <ToastTitle>Snoozed &quot;{snoozeTarget.name}&quot; for {hours}h</ToastTitle>
        </Toast>,
        { intent: 'success' },
      );
      setSnoozeTarget(undefined);
      alertsQuery.refresh();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Failed to snooze alert.');
    } finally {
      setActionBusy(false);
    }
  }

  // --- Session host drain/power — mirrors HostPool.tsx/Dashboard.tsx's own
  // flow verbatim (same dialogs, same severity rubric — see those files'
  // own doc comments for the full rationale). Re-resolved from the LIVE
  // sessionHosts.data list by id (not a click-time snapshot) for the same
  // reason those pages do: a background poll can refresh the list while a
  // dialog is open.
  const [selectedHost, setSelectedHost] = useState<SessionHost | undefined>(undefined);

  const [drainTargetId, setDrainTargetId] = useState<string | undefined>(undefined);
  const [drainBusy, setDrainBusy] = useState(false);
  const [drainError, setDrainError] = useState<string | undefined>(undefined);
  const drainTarget = useMemo(() => sessionHosts.data?.find((host) => host.id === drainTargetId), [sessionHosts.data, drainTargetId]);

  function openDrainDialog(host: SessionHost) {
    setDrainTargetId(host.id);
    setDrainError(undefined);
  }
  function cancelDrainDialog() {
    setDrainTargetId(undefined);
    setDrainError(undefined);
  }
  async function confirmDrainToggle(reason: string | undefined) {
    if (!drainTarget) return;
    const nextAllowNewSession = !drainTarget.allowNewSession;
    const hostName = drainTarget.name;
    setDrainBusy(true);
    setDrainError(undefined);
    try {
      await setSessionHostDrain(HOST_POOL_NAME, hostName, { allowNewSession: nextAllowNewSession, reason });
      setDrainTargetId(undefined);
      dispatchToast(
        <Toast>
          <ToastTitle>{nextAllowNewSession ? `Resumed ${hostName}` : `Drain enabled on ${hostName}`}</ToastTitle>
        </Toast>,
        { intent: 'success' },
      );
      sessionHosts.refresh();
    } catch (error) {
      setDrainError(error instanceof ApiClientError ? error.message : 'Failed to update the session host.');
    } finally {
      setDrainBusy(false);
    }
  }

  const [powerTargetId, setPowerTargetId] = useState<string | undefined>(undefined);
  const [powerAction, setPowerAction] = useState<SessionHostPowerAction | undefined>(undefined);
  const [warningAcknowledged, setWarningAcknowledged] = useState(false);
  const [powerBusy, setPowerBusy] = useState(false);
  const [powerError, setPowerError] = useState<string | undefined>(undefined);
  const powerTarget = useMemo(() => sessionHosts.data?.find((host) => host.id === powerTargetId), [sessionHosts.data, powerTargetId]);
  const needsSessionsWarning = Boolean(powerTarget && powerAction && isDisruptivePowerAction(powerAction) && powerTarget.activeSessions > 0);

  function openPowerDialog(host: SessionHost, action: SessionHostPowerAction) {
    setPowerTargetId(host.id);
    setPowerAction(action);
    setPowerError(undefined);
    setWarningAcknowledged(false);
  }
  function cancelPowerDialog() {
    setPowerTargetId(undefined);
    setPowerAction(undefined);
    setPowerError(undefined);
    setWarningAcknowledged(false);
  }
  function proceedPastSessionsWarning() {
    setWarningAcknowledged(true);
  }
  async function confirmPowerAction(reason: string | undefined) {
    if (!powerTarget || !powerAction) return;
    const hostName = powerTarget.name;
    const action = powerAction;
    const activeSessions = powerTarget.activeSessions;
    setPowerBusy(true);
    setPowerError(undefined);
    try {
      const response = await setSessionHostPower(HOST_POOL_NAME, hostName, { action, reason, activeSessions });
      setPowerTargetId(undefined);
      setPowerAction(undefined);
      setWarningAcknowledged(false);
      dispatchToast(
        <Toast>
          <ToastTitle>{powerActionLabel(action)} accepted for {hostName}</ToastTitle>
          <ToastBody>Azure is processing the request. Reference: {response.correlationId}</ToastBody>
        </Toast>,
        { intent: 'success' },
      );
      sessionHosts.refresh();
    } catch (error) {
      setPowerError(error instanceof ApiClientError ? error.message : 'Failed to submit the power action.');
    } finally {
      setPowerBusy(false);
    }
  }

  // --- Session message/force-logoff — mirrors Sessions.tsx's own handlers
  // (same sendSessionMessage/forceLogoffSession calls, same
  // MessageComposeDialog/ConfirmModal+ImpactPreview). Target is snapshotted
  // at open time (not re-derived from the live sessions.data list), same
  // rationale as Sessions.tsx's own logoffTarget/messageTarget: a session's
  // sessionHostName/sessionId don't change for its lifetime, and a
  // background poll that drops this session from the list mid-dialog must
  // not silently unmount the dialog and discard a typed reason.
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

  return (
    <div className={styles.page}>
      <PageHeader
        title="Incident"
        asOf={latestUpdated}
        refreshing={anyRefreshing}
        onRefresh={refreshAll}
        actions={
          // The escape hatch — a prominent PageHeader action, not tucked
          // into a menu. The EstateStrip's own Incident toggle also exits
          // from here (see that component's doc comment) — this is the
          // second, always-visible way back.
          <Button appearance="primary" onClick={() => navigate('/')}>
            Exit incident mode
          </Button>
        }
      />

      {/* AM-34 peer review NIT — everything inside this RoleGate is already
          operator+ only; a further `{canView && ...}` around any rendering
          decision below it would be dead code (canView is always true
          there). `canView`/`ready` are still read directly OUTSIDE this
          gate's render tree — the four poller fetchers above (which must
          resolve before any RoleGate render decision even happens) and
          SessionHostCard's `canMutate` prop below (a plain value read, not
          a conditional render — kept for parity with how
          HostPool.tsx/Dashboard.tsx pass the same boolean to the same
          shared component). */}
      <RoleGate allowed={['operator', 'admin']} fallback={<Text className={styles.gateNote}>Incident mode requires the operator or admin role.</Text>}>
        <div className={styles.grid}>
          <div className={styles.column}>
            <Card className={cardStyles.card}>
              <CardHeader header={<Text as="h2" size={400} weight="semibold">Affected hosts</Text>} />
              <AsyncState
                loading={sessionHosts.loading}
                error={sessionHosts.error as Error | undefined}
                data={affected}
                asOf={sessionHosts.lastUpdated}
                isEmpty={(data) => data.hosts.length === 0}
                emptyMessage="No session hosts found."
                variant="table"
              >
                {(data) => (
                  <>
                    {data.allHealthy && (
                      <Text size={200} className={styles.calmNote} role="status">
                        No affected hosts — showing all.
                      </Text>
                    )}
                    <div className={styles.cardGrid}>
                      {data.hosts.map((hostVm) => {
                        const raw = sessionHosts.data?.find((host) => host.id === hostVm.id);
                        return (
                          <SessionHostCard
                            key={hostVm.id}
                            host={hostVm}
                            canMutate={canView}
                            onToggleDrainRequest={() => raw && openDrainDialog(raw)}
                            onPowerActionRequest={(_vm, action) => raw && openPowerDialog(raw, action)}
                            onViewHealthChecks={() => raw && setSelectedHost(raw)}
                          />
                        );
                      })}
                    </div>
                  </>
                )}
              </AsyncState>
            </Card>

            <Card className={cardStyles.card}>
              <CardHeader header={<Text as="h2" size={400} weight="semibold">Sessions on affected hosts</Text>} />
              {/* AM-34 peer review (Opus, MAJOR 1) — loading/error fold in
                  BOTH sessions AND sessionHosts: this list is DERIVED from
                  sessionHosts (see sessionsOnAffectedHosts above), so a
                  still-loading or failed hosts poll must surface here too,
                  not just get silently treated as "confirmed zero
                  sessions". */}
              <AsyncState
                loading={sessions.loading || sessionHosts.loading}
                error={(sessions.error ?? sessionHosts.error) as Error | undefined}
                data={sessionsOnAffectedHosts}
                asOf={sessions.lastUpdated}
                isEmpty={(data) => data.length === 0}
                emptyMessage="No sessions on the affected hosts."
                variant="table"
              >
                {(rows) => (
                <DataTable
                  ariaLabel="Sessions on affected hosts"
                  size="small"
                  columns={INCIDENT_SESSION_COLUMNS}
                  rows={rows}
                  getRowKey={(session) => session.id}
                  emptyMessage="No sessions on the affected hosts."
                  rowActions={(session) => {
                    const isActive = session.sessionState === 'Active';
                    return (
                      <div className={styles.rowActions}>
                        <Tooltip content={isActive ? 'Send a message to this session.' : 'Only active sessions can receive a message.'} relationship="label">
                          <Button size="small" appearance="secondary" onClick={() => openMessageDialog(session)} disabled={!isActive}>
                            Message
                          </Button>
                        </Tooltip>
                        <Menu>
                          <MenuTrigger disableButtonEnhancement>
                            <Button
                              size="small"
                              appearance="secondary"
                              icon={<MoreHorizontal20Regular />}
                              aria-label={`More actions for ${session.userPrincipalName} on ${session.sessionHostName}`}
                            />
                          </MenuTrigger>
                          <MenuPopover>
                            <MenuList>
                              <MenuItem onClick={() => openLogoffDialog(session)}>Force logoff</MenuItem>
                            </MenuList>
                          </MenuPopover>
                        </Menu>
                      </div>
                    );
                  }}
                />
              )}
              </AsyncState>
            </Card>
          </div>

          <div className={styles.column}>
            <Card className={cardStyles.card}>
              <CardHeader header={<Text as="h2" size={400} weight="semibold">Open alerts</Text>} />
              {alertsQuery.data?.degraded && (
                <MessageBar intent="warning">
                  <MessageBarBody>Ack/snooze state is temporarily unavailable — alerts below may look un-acked/un-snoozed even if they aren&apos;t. Actions are disabled until this clears.</MessageBarBody>
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
                data={openAlerts}
                asOf={alertsQuery.lastUpdated}
                isEmpty={(data) => data.length === 0}
                emptyMessage="No open alerts."
                variant="table"
                skeletonRows={4}
              >
                {(data) => (
                  <ul className={styles.list} aria-label="Open alerts">
                    {data.map((alertItem) => (
                      <li key={alertItem.id} className={styles.row}>
                        <div className={styles.rowTop}>
                          <StatusBadge label={alertItem.severity} tone={severityTone(alertItem.severity)} size="small" />
                          <Text size={200} className={styles.muted}>
                            {formatRelativeToNow(alertItem.firedAt)}
                          </Text>
                        </div>
                        <Text block weight="semibold">
                          {alertItem.name}
                        </Text>
                        <div className={styles.rowActions}>
                          <Button size="small" disabled={alertsQuery.data?.degraded} onClick={() => setAckTarget(alertItem)}>
                            Ack
                          </Button>
                          <Menu>
                            <MenuTrigger disableButtonEnhancement>
                              <Button
                                size="small"
                                appearance="secondary"
                                icon={<MoreHorizontal20Regular />}
                                disabled={alertsQuery.data?.degraded}
                                aria-label={`More actions for ${alertItem.name}`}
                              />
                            </MenuTrigger>
                            <MenuPopover>
                              <MenuList>
                                <MenuItem onClick={() => setSnoozeTarget(alertItem)}>Snooze</MenuItem>
                              </MenuList>
                            </MenuPopover>
                          </Menu>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </AsyncState>
            </Card>

            <Card className={cardStyles.card}>
              <CardHeader header={<Text as="h2" size={400} weight="semibold">Action log</Text>} />
              <AsyncState
                loading={audit.loading}
                error={audit.error as Error | undefined}
                data={audit.data?.entries}
                asOf={audit.lastUpdated}
                isEmpty={(data) => data.length === 0}
                emptyMessage="No actions recorded in this window."
                variant="table"
                skeletonRows={4}
              >
                {(entries) => (
                  <ul className={styles.list} aria-label="Action log">
                    {entries.map((entry) => (
                      <li key={entry.id} className={styles.row}>
                        <div className={styles.rowTop}>
                          <Text size={200} className={styles.muted}>
                            {formatRelativeToNow(entry.occurredAt)}
                          </Text>
                          <StatusBadge label={entry.outcome} tone={OUTCOME_TONE[entry.outcome]} size="small" />
                        </div>
                        <Text size={200}>
                          <Text size={200} weight="semibold">
                            {shortActor(entry.actor)}
                          </Text>{' '}
                          {entry.action}
                        </Text>
                      </li>
                    ))}
                  </ul>
                )}
              </AsyncState>
            </Card>
          </div>
        </div>
      </RoleGate>

      <HealthChecksDrawer host={selectedHost ? toSessionHostViewModel(selectedHost, { now }) : undefined} onClose={() => setSelectedHost(undefined)} />

      {ackTarget && (
        <ConfirmModal
          title={`Acknowledge "${ackTarget.name}"?`}
          severity="low"
          optionalReason
          description="Records who acknowledged it and when — it does not close the alert in Azure Monitor. This can be undone with Un-ack on the Monitoring page."
          confirmLabel="Acknowledge"
          busy={actionBusy}
          error={actionError}
          onConfirm={handleAck}
          onCancel={() => {
            if (actionBusy) return;
            setAckTarget(undefined);
            // AM-34 peer review NIT — a failed attempt's error must not
            // silently outlive the dialog that showed it (same fix applied
            // to Monitoring.tsx's own identical pair — see that file).
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

      {drainTargetId && drainTarget && (
        <ConfirmModal
          title={drainTarget.allowNewSession ? `Drain ${drainTarget.name}?` : `Resume ${drainTarget.name}?`}
          severity="low"
          optionalReason
          description={
            drainTarget.allowNewSession
              ? `Draining stops ${drainTarget.name} from accepting new sessions. Existing sessions on this host are not disconnected.`
              : `Resuming allows ${drainTarget.name} to accept new sessions again.`
          }
          confirmLabel={drainTarget.allowNewSession ? 'Drain' : 'Resume'}
          busy={drainBusy}
          error={drainError}
          onConfirm={confirmDrainToggle}
          onCancel={cancelDrainDialog}
        />
      )}

      {powerTargetId && powerTarget && powerAction && needsSessionsWarning && !warningAcknowledged && (
        <SessionsWarningDialog
          hostName={powerTarget.name}
          activeSessions={powerTarget.activeSessions}
          allowNewSession={powerTarget.allowNewSession}
          action={powerAction}
          onProceed={proceedPastSessionsWarning}
          onCancel={cancelPowerDialog}
        />
      )}

      {powerTargetId && powerTarget && powerAction === 'start' && (!needsSessionsWarning || warningAcknowledged) && (
        <ConfirmModal
          title={`Start ${powerTarget.name}?`}
          severity="low"
          optionalReason
          description={`Starts ${powerTarget.name}'s underlying VM. Azure accepts the request immediately; the host's power state will update once the VM finishes starting.`}
          confirmLabel="Start"
          busy={powerBusy}
          error={powerError}
          onConfirm={confirmPowerAction}
          onCancel={cancelPowerDialog}
        />
      )}

      {powerTargetId && powerTarget && powerAction && powerAction !== 'start' && (!needsSessionsWarning || warningAcknowledged) && (
        <ConfirmModal
          title={`${powerActionLabel(powerAction)} ${powerTarget.name}?`}
          severity="medium"
          description={
            powerAction === 'restart'
              ? `Restarts ${powerTarget.name}'s underlying VM, disconnecting any active sessions without warning.`
              : `Deallocates ${powerTarget.name}'s underlying VM (stops it and releases compute resources), disconnecting any active sessions without warning. The host will not accept new sessions until it is started again.`
          }
          impact={<ImpactPreview lines={hostPowerPreviewLines(powerTarget, powerAction)} />}
          confirmLabel={powerActionLabel(powerAction)}
          busy={powerBusy}
          error={powerError}
          onConfirm={confirmPowerAction}
          onCancel={cancelPowerDialog}
        />
      )}

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
    </div>
  );
}
