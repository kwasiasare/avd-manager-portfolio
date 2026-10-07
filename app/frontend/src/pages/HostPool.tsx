import { useMemo, useState } from 'react';
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
} from '@fluentui/react-components';
import { ChevronDownRegular } from '@fluentui/react-icons';
import type { SessionHost, SessionHostPowerAction } from '@avdmgr/shared';
import { getHostPoolPolicyHealth, getHostPools, getSessionHosts, setSessionHostDrain, setSessionHostPower } from '../api/avd';
import { ApiClientError } from '../api/client';
import { usePolling } from '../hooks/usePolling';
import AsyncState from '../components/AsyncState';
import StatusBadge from '../components/StatusBadge';
import PageHeader from '../components/PageHeader';
import DataTable, { type DataTableColumn } from '../components/DataTable';
import AddSessionHostPanel from '../components/AddSessionHostPanel';
import RoleGate from '../components/RoleGate';
import ConfirmModal from '../components/ConfirmModal';
import ImpactPreview from '../components/ImpactPreview';
import SessionHostCard from '../components/SessionHostCard';
import HealthChecksDrawer from '../components/HealthChecksDrawer';
import SessionsWarningDialog from '../components/SessionsWarningDialog';
import { useAuth } from '../auth/useAuth';
import { HOST_POOL_NAME } from '../lib/config';
import { useCardStyles } from '../styles/shared';
import { sessionHostStatusTone } from '../lib/sessionHostStatusTone';
import { toSessionHostViewModel } from '../lib/sessionHostViewModel';
import { lookupPolicyHealth, POLICY_HEALTH_STATUS_LABEL, POLICY_HEALTH_STATUS_TONE, toPolicyHealthByHost } from '../lib/intunePolicyHealthViewModel';
import { isDisruptivePowerAction, powerActionLabel } from '../lib/sessionHostPowerActions';
import { hostPowerPreviewLines } from '../lib/impactPreview';
import { useAppToast } from '../lib/toaster';
import { formatOnOff } from '../lib/format';

const POLL_INTERVAL_MS = 60_000;

/** AM-31 item 33 — above this many hosts, the SessionHostCard grid gives way to the pre-existing plain table (kept verbatim below) — a grid of dozens of cards is worse for scanning at that scale than a table. */
const CARD_GRID_MAX_HOSTS = 6;

const useStyles = makeStyles({
  page: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXL,
  },
  propsGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
    gap: tokens.spacingVerticalM,
  },
  propLabel: {
    color: tokens.colorNeutralForeground3,
  },
  headerRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: tokens.spacingHorizontalM,
    flexWrap: 'wrap',
  },
  actionsCell: {
    display: 'flex',
    gap: tokens.spacingHorizontalXS,
  },
  // AM-31 item 33 — the SessionHostCard grid; falls back to the pre-existing
  // table below CARD_GRID_MAX_HOSTS's threshold (see that constant).
  cardGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
    gap: tokens.spacingHorizontalM,
  },
});

function summarizeRdpProperties(raw: string | undefined): string {
  if (!raw) return 'None';
  const count = raw.split(';').filter((entry) => entry.trim().length > 0).length;
  return `${count} propert${count === 1 ? 'y' : 'ies'} set`;
}

export default function HostPool() {
  const styles = useStyles();
  const cardStyles = useCardStyles();
  const { dispatchToast } = useAppToast();
  const { role } = useAuth();
  /** Mirrors the API's requireMinimumRole('operator') gate — this is a UI convenience only (see RoleGate's doc comment), not a security boundary. */
  const canMutate = role === 'operator' || role === 'admin';

  const [selectedHost, setSelectedHost] = useState<SessionHost | undefined>(undefined);

  /** The id of the host currently being confirmed for a drain/resume toggle, or undefined when the confirm dialog is closed. Deliberately just the id, not a snapshot of the SessionHost object — see drainTarget below. */
  const [drainTargetId, setDrainTargetId] = useState<string | undefined>(undefined);
  const [drainBusy, setDrainBusy] = useState(false);
  const [drainError, setDrainError] = useState<string | undefined>(undefined);

  /** AM-22 (M2-S5): Add session host guided panel — see components/AddSessionHostPanel.tsx. */
  const [addHostPanelOpen, setAddHostPanelOpen] = useState(false);

  /** The id of the host currently being confirmed for a power action (start/restart/deallocate), or undefined when no power dialog is open. Same "id, not a snapshot" rationale as drainTargetId — see powerTarget below. */
  const [powerTargetId, setPowerTargetId] = useState<string | undefined>(undefined);
  const [powerAction, setPowerAction] = useState<SessionHostPowerAction | undefined>(undefined);
  /**
   * Whether the operator has clicked "Proceed anyway" on the sessions
   * warning step for the CURRENT powerTargetId/powerAction pair. Reset to
   * false by openPowerDialog (every new menu click starts unacknowledged)
   * and by cancelPowerDialog.
   *
   * AM-19 peer review item 7: this replaced an earlier design that computed
   * a 'sessionsWarning' | 'confirm' step ONCE at click time from a snapshot
   * of activeSessions. That snapshot approach had two bugs: (a) if the host
   * had 0 sessions at click time but gained some before the operator
   * confirmed, the warning was silently skipped; (b) conversely the warning
   * text could end up describing "0 active sessions" if sessions drained
   * away between click and render. Needing only this boolean (not the step
   * itself) lets needsSessionsWarning below be recomputed from the LIVE
   * powerTarget on every render, so the warning tracks reality up to the
   * moment of submission.
   */
  const [warningAcknowledged, setWarningAcknowledged] = useState(false);
  const [powerBusy, setPowerBusy] = useState(false);
  const [powerError, setPowerError] = useState<string | undefined>(undefined);

  const hostPools = usePolling(getHostPools, POLL_INTERVAL_MS);
  const sessionHosts = usePolling((signal) => getSessionHosts(HOST_POOL_NAME, signal), POLL_INTERVAL_MS);
  /**
   * AM-52 — a SEPARATE poll from sessionHosts above (a different endpoint,
   * GET .../policy-health — see lib/intunePolicyHealthViewModel.ts's header
   * comment for why this is never folded into SessionHostViewModel). A
   * failed poll here (policyHealth.error) is deliberately NOT surfaced as a
   * page-level error and never blocks rendering sessionHosts' own data —
   * lookupPolicyHealth below falls back to a synthetic 'unknown' result per
   * host in that case (and while the very first fetch is still in flight),
   * so every host badge just reads "Unknown" rather than the page failing
   * to load.
   */
  const policyHealth = usePolling((signal) => getHostPoolPolicyHealth(HOST_POOL_NAME, signal), POLL_INTERVAL_MS);
  const policyHealthByHost = useMemo(() => toPolicyHealthByHost(policyHealth.data?.hosts), [policyHealth.data]);

  const hostPool = useMemo(() => hostPools.data?.find((pool) => pool.name === HOST_POOL_NAME), [hostPools.data]);

  // Peer review (Opus, MINOR 5) — memoized: this column set closes over
  // nothing but `setSelectedHost` (a useState setter, guaranteed stable by
  // React across renders — see the exhaustive-deps rule's own treatment of
  // destructured setState functions) and policyHealthByHost, so a stable
  // reference costs nothing and stops it from being rebuilt as a fresh
  // array on every one of usePolling's refreshing-flip re-renders, busting
  // DataTable's own sortedRows memo for no reason.
  const sessionHostTableColumns = useMemo<DataTableColumn<SessionHost>[]>(
    () => [
      { id: 'host', label: 'Host', renderCell: (host) => host.name },
      { id: 'status', label: 'Status', renderCell: (host) => <StatusBadge label={host.status} tone={sessionHostStatusTone(host.status)} /> },
      { id: 'powerState', label: 'Power state', renderCell: (host) => host.powerState ?? 'unknown' },
      { id: 'agentVersion', label: 'Agent version', renderCell: (host) => host.agentVersion ?? 'Unknown' },
      { id: 'sessions', label: 'Sessions', renderCell: (host) => host.activeSessions },
      {
        id: 'allowNewSession',
        label: 'Allow new session',
        renderCell: (host) => <StatusBadge label={host.allowNewSession ? 'Yes' : 'Draining'} tone={host.allowNewSession ? 'ok' : 'warning'} />,
      },
      {
        // AM-52 — Intune policy-health chip, same synthetic-'unknown'-on-poll-failure fallback as the SessionHostCard grid path (see policyHealth's own doc comment above).
        id: 'policyHealth',
        label: 'Policy',
        renderCell: (host) => {
          const result = lookupPolicyHealth(policyHealthByHost, host.name);
          return (
            <Button size="small" appearance="secondary" onClick={() => setSelectedHost(host)}>
              <StatusBadge label={POLICY_HEALTH_STATUS_LABEL[result.status]} tone={POLICY_HEALTH_STATUS_TONE[result.status]} size="small" />
            </Button>
          );
        },
      },
      {
        // AM-29 item 15: was an unnamed `<TableHeaderCell />` — this column holds each row's "View health checks" expand toggle, so it needs a real (if visually-hidden) label for screen-reader users navigating the table header.
        id: 'healthChecks',
        label: 'Health checks',
        visuallyHiddenHeader: true,
        renderCell: (host) => (
          <Button size="small" appearance="secondary" onClick={() => setSelectedHost(host)}>
            Health checks
          </Button>
        ),
      },
    ],
    [setSelectedHost, policyHealthByHost],
  );

  /**
   * Re-resolved from the LIVE session-host list on every render, rather than
   * captured as a snapshot at click time — the background 60s poll
   * (usePolling) can refresh sessionHosts.data while the confirm dialog is
   * open, and a stale snapshot's `allowNewSession` would compute the wrong
   * toggle direction (drain vs resume) in confirmDrainToggle below. If the
   * host disappears from the list entirely (e.g. removed) while the dialog
   * is open, drainTarget becomes undefined and the dialog closes itself
   * (see the render guard near the bottom of this component).
   */
  const drainTarget = useMemo(() => sessionHosts.data?.find((host) => host.id === drainTargetId), [sessionHosts.data, drainTargetId]);

  /** Re-resolved from the live session-host list on every render — same rationale as drainTarget above. */
  const powerTarget = useMemo(() => sessionHosts.data?.find((host) => host.id === powerTargetId), [sessionHosts.data, powerTargetId]);

  /**
   * Derived live (not a click-time snapshot — see warningAcknowledged's doc
   * comment) from powerTarget, which is itself re-resolved from the live
   * session-host list every render. True when the chosen action is
   * disruptive (restart/deallocate) AND the host CURRENTLY has one or more
   * active sessions.
   */
  const needsSessionsWarning = Boolean(powerTarget && powerAction && isDisruptivePowerAction(powerAction) && powerTarget.activeSessions > 0);

  function openDrainDialog(host: SessionHost) {
    setDrainTargetId(host.id);
    setDrainError(undefined);
  }

  function cancelDrainDialog() {
    setDrainTargetId(undefined);
    setDrainError(undefined);
  }

  /**
   * Submits the drain/resume toggle for `drainTarget`, then refetches the
   * session-host list (usePolling's refresh — see src/hooks/usePolling.ts)
   * rather than optimistically patching local state, so the table always
   * reflects what ARM actually reports back.
   *
   * On failure, the error is shown INSIDE the still-open confirm dialog
   * (ReasonConfirmDialog's `error` prop) rather than a page-level MessageBar
   * — a page-level MessageBar renders behind the Dialog's modal overlay and
   * would be invisible while the dialog is open (AM-18 peer review finding).
   * On success, the dialog closes and a page-level success MessageBar
   * confirms what happened.
   */
  async function confirmDrainToggle(reason: string | undefined) {
    if (!drainTarget) return;
    const nextAllowNewSession = !drainTarget.allowNewSession;
    const hostName = drainTarget.name;
    setDrainBusy(true);
    setDrainError(undefined);
    try {
      await setSessionHostDrain(HOST_POOL_NAME, hostName, { allowNewSession: nextAllowNewSession, reason });
      setDrainTargetId(undefined);
      // AM-29 item D: transient success -> toast, not a persistent MessageBar.
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

  /**
   * Opens the power-action flow for `host`/`action`. Does NOT decide here
   * whether the sessions-warning step is needed — that's needsSessionsWarning
   * above, recomputed live on every render — this just resets the flow's
   * per-open state (target, action, unacknowledged warning).
   */
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

  /** "Proceed anyway" out of the sessions-warning step — acknowledges it for this target/action pair without submitting anything yet. */
  function proceedPastSessionsWarning() {
    setWarningAcknowledged(true);
  }

  /**
   * Submits the power action for `powerTarget`/`powerAction`, passing the
   * host's activeSessions count through in the request body purely for the
   * audit trail (see @avdmgr/shared's SessionHostPowerRequest — the server
   * does not use it to decide anything, and re-reads the authoritative count
   * itself). On success, refetches the session-host list (same rationale as
   * confirmDrainToggle: reflect what ARM reports, not an optimistic guess)
   * and shows an "accepted" success message — including the server's
   * correlationId (AM-19 peer review item 6), so a support ticket can
   * reference the exact request/audit row — rather than claiming the action
   * is complete, since the API only confirms Azure accepted the request —
   * see setSessionHostPower's doc comment. On failure, the error is shown
   * INSIDE the still-open dialog, same as confirmDrainToggle.
   */
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
      // AM-29 item D: transient success -> toast (the correlationId is still worth keeping, so it's included in the toast body).
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

  return (
    <div className={styles.page}>
      <PageHeader
        title={`Host Pool — ${HOST_POOL_NAME}`}
        asOf={sessionHosts.lastUpdated}
        refreshing={hostPools.refreshing || sessionHosts.refreshing || policyHealth.refreshing}
        onRefresh={() => {
          hostPools.refresh();
          sessionHosts.refresh();
          policyHealth.refresh();
        }}
        actions={
          // Visible to operator+ — the panel itself further gates the actual
          // "Generate token" control to admin-only (RoleGate(['admin']) inside
          // AddSessionHostPanel), mirroring the API's own split RBAC floors
          // (operator for the two GET routes, admin for the POST route — see
          // app/api/src/functions/hostPoolRegistrationToken.ts).
          <RoleGate allowed={['operator', 'admin']}>
            <Button appearance="secondary" onClick={() => setAddHostPanelOpen(true)}>
              Add session host
            </Button>
          </RoleGate>
        }
      />

      <Card className={cardStyles.card}>
        <CardHeader header={<Text as="h2" size={400} weight="semibold">Properties</Text>} />
        <AsyncState loading={hostPools.loading} error={hostPools.error as Error | undefined} data={hostPool} emptyMessage="Host pool not found.">
          {(pool) => (
            <div className={styles.propsGrid}>
              <div>
                <Text block className={styles.propLabel}>
                  Type
                </Text>
                <Text>{pool.hostPoolType}</Text>
              </div>
              <div>
                <Text block className={styles.propLabel}>
                  Load balancer
                </Text>
                <Text>{pool.loadBalancerType ?? 'Unknown'}</Text>
              </div>
              <div>
                <Text block className={styles.propLabel}>
                  Max sessions per host
                </Text>
                <Text>{pool.maxSessionLimit ?? 'Unknown'}</Text>
              </div>
              <div>
                <Text block className={styles.propLabel}>
                  Start VM on connect
                </Text>
                <Text>{formatOnOff(pool.startVMOnConnect)}</Text>
              </div>
              <div>
                <Text block className={styles.propLabel}>
                  Update ring
                </Text>
                <Text>{pool.ring ?? 'Not set'}</Text>
              </div>
              <div>
                <Text block className={styles.propLabel}>
                  RDP properties
                </Text>
                <Tooltip content={pool.customRdpProperty ?? 'None'} relationship="description">
                  <Text>{summarizeRdpProperties(pool.customRdpProperty)}</Text>
                </Tooltip>
              </div>
            </div>
          )}
        </AsyncState>
      </Card>

      <Card className={cardStyles.card}>
        <CardHeader header={<Text as="h2" size={400} weight="semibold">Session hosts</Text>} />
        <AsyncState
          loading={sessionHosts.loading}
          error={sessionHosts.error as Error | undefined}
          data={sessionHosts.data}
          asOf={sessionHosts.lastUpdated}
          isEmpty={(data) => data.length === 0}
          emptyMessage="No session hosts found in this pool."
          variant="table"
        >
          {(hosts) =>
            hosts.length > CARD_GRID_MAX_HOSTS ? (
              <DataTable
                ariaLabel="Session hosts"
                columns={sessionHostTableColumns}
                rows={hosts}
                getRowKey={(host) => host.id}
                emptyMessage="No session hosts found in this pool."
                // Rendered ONLY for operator/admin — see RoleGate's doc comment, which names drain toggles as its motivating example. The API independently re-checks (requireMinimumRole('operator')). A viewer gets no extra column at all, not an empty one.
                rowActions={
                  canMutate
                    ? (host) => (
                        <div className={styles.actionsCell}>
                          <Button size="small" appearance="secondary" onClick={() => openDrainDialog(host)}>
                            {host.allowNewSession ? 'Drain' : 'Resume'}
                          </Button>
                          <Menu>
                            <MenuTrigger disableButtonEnhancement>
                              <Button size="small" appearance="secondary" icon={<ChevronDownRegular />} iconPosition="after">
                                Power
                              </Button>
                            </MenuTrigger>
                            <MenuPopover>
                              <MenuList>
                                <MenuItem onClick={() => openPowerDialog(host, 'start')}>Start</MenuItem>
                                <MenuItem onClick={() => openPowerDialog(host, 'restart')}>Restart</MenuItem>
                                <MenuItem onClick={() => openPowerDialog(host, 'deallocate')}>Deallocate</MenuItem>
                              </MenuList>
                            </MenuPopover>
                          </Menu>
                        </div>
                      )
                    : undefined
                }
              />
            ) : (
              // AM-31 item 33 — the shared SessionHostCard grid; see that
              // component's own doc comment. `now` computed once per render
              // so every card's heartbeat-staleness in this pass agrees.
              <div className={styles.cardGrid}>
                {hosts.map((host) => (
                  <SessionHostCard
                    key={host.id}
                    host={toSessionHostViewModel(host, { maxSessions: hostPool?.maxSessionLimit })}
                    policyHealth={lookupPolicyHealth(policyHealthByHost, host.name)}
                    canMutate={canMutate}
                    onToggleDrainRequest={() => openDrainDialog(host)}
                    onPowerActionRequest={(_vm, action) => openPowerDialog(host, action)}
                    onViewHealthChecks={() => setSelectedHost(host)}
                  />
                ))}
              </div>
            )
          }
        </AsyncState>
      </Card>

      <HealthChecksDrawer
        host={selectedHost ? toSessionHostViewModel(selectedHost, { maxSessions: hostPool?.maxSessionLimit }) : undefined}
        policyHealth={selectedHost ? lookupPolicyHealth(policyHealthByHost, selectedHost.name) : undefined}
        onClose={() => setSelectedHost(undefined)}
      />

      {/* Guarded on BOTH drainTargetId and the re-resolved drainTarget: if the
          host disappears from the live list while the dialog is open (see
          drainTarget's doc comment above), this closes the dialog rather
          than rendering it against stale/missing data. */}
      {/* AM-29 item 30: drain/resume is severity 'low' per the rubric. Peer review (Opus, MAJOR item 1): setSessionHostDrain does audit a reason server-side, so optionalReason keeps that capture available without making it mandatory. */}
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

      <AddSessionHostPanel hostPoolName={HOST_POOL_NAME} open={addHostPanelOpen} onClose={() => setAddHostPanelOpen(false)} />

      {/* AM-19 power-action flow. Guarded on powerTargetId/powerTarget/powerAction together, same "closes itself if the host vanishes from the live list" rationale as the drain dialog above. The warning-vs-confirm split is driven by needsSessionsWarning (live) and warningAcknowledged, NOT a click-time snapshot — see those declarations' doc comments. AM-31 item 37: SessionsWarningDialog (shared with Dashboard.tsx — item 33) owns its own focus-restore. AM-33: allowNewSession is passed through so the interstitial's drain-state warning line (computed via hostPowerPreviewLines, same as the follow-up ConfirmModal's panel below) stays live too. */}
      {powerTargetId && powerTarget && powerAction && needsSessionsWarning && !warningAcknowledged && (
        <SessionsWarningDialog hostName={powerTarget.name} activeSessions={powerTarget.activeSessions} allowNewSession={powerTarget.allowNewSession} action={powerAction} onProceed={proceedPastSessionsWarning} onCancel={cancelPowerDialog} />
      )}

      {/* AM-29 item 30: start VM is severity 'low'. Peer review (Opus, MAJOR item 1): setSessionHostPower audits a reason server-side too, so optionalReason keeps that capture available without making it mandatory. */}
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

      {/* AM-29 item 30 (coordinator directive): restart/deallocate move to severity 'medium' — a mandatory reason, but no typed hostname gate. AM-33 (D5): the impact panel's session-count + drain-state lines are computed by the SAME hostPowerPreviewLines helper the SessionsWarningDialog interstitial above now also calls (AM-33 peer review MAJOR 2/3) — consistent wording everywhere, not a "mirror" of needsSessionsWarning (a different, looser predicate — see that helper's own doc comment). */}
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
    </div>
  );
}
