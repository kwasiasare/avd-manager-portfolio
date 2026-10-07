import { useMemo, useState } from 'react';
import AppLink from '../components/AppLink';
import {
  makeStyles,
  tokens,
  Card,
  CardHeader,
  CardFooter,
  Text,
  Badge,
  Button,
  ProgressBar,
  Toast,
  ToastTitle,
  ToastBody,
  Tooltip,
  type BadgeProps,
} from '@fluentui/react-components';
import { Circle12Filled, Warning16Filled } from '@fluentui/react-icons';
import { computeScalingPhase, eolTier } from '@avdmgr/shared';
import type { SessionHost, SessionHostPowerAction } from '@avdmgr/shared';
import { ackAlert, getCostSummary, getCurrentImageVersion, getCurrentScalingPlan, getHealthSummary, getHostPools, getRecentAlerts, getSessionHosts, setSessionHostDrain, setSessionHostPower } from '../api/avd';
import { ApiClientError } from '../api/client';
import { usePolling } from '../hooks/usePolling';
import AsyncState from '../components/AsyncState';
import StatusBadge from '../components/StatusBadge';
import PageHeader from '../components/PageHeader';
import ConfirmModal from '../components/ConfirmModal';
import ImpactPreview from '../components/ImpactPreview';
import RoleGate from '../components/RoleGate';
import DeltaBadge from '../components/DeltaBadge';
import DataTable, { type DataTableColumn } from '../components/DataTable';
import StatTile from '../components/StatTile';
import SessionHostCard from '../components/SessionHostCard';
import HealthChecksDrawer from '../components/HealthChecksDrawer';
import SessionsWarningDialog from '../components/SessionsWarningDialog';
import { useAuth } from '../auth/useAuth';
import { formatCurrency, formatDateTime, formatRelativeToNow } from '../lib/format';
import { COST_POLL_INTERVAL_MS, HOST_POOL_NAME } from '../lib/config';
import { useCardStyles } from '../styles/shared';
import { sessionHostStatusTone } from '../lib/sessionHostStatusTone';
import { estateRollupCounts, STALE_HEARTBEAT_MINUTES, toSessionHostViewModel, type SessionHostViewModel } from '../lib/sessionHostViewModel';
import { isDisruptivePowerAction, powerActionLabel } from '../lib/sessionHostPowerActions';
import { hostPowerPreviewLines } from '../lib/impactPreview';
import { useAppToast } from '../lib/toaster';
import { PHASE_LABEL, PHASE_TONE } from '../lib/phaseColor';

const POLL_INTERVAL_MS = 60_000;
/** AM-31 item 33 — above this many hosts, the SessionHostCard grid gives way to this page's pre-existing heartbeat table — see HostPool.tsx's own CARD_GRID_MAX_HOSTS for the same threshold. */
const CARD_GRID_MAX_HOSTS = 6;

const useStyles = makeStyles({
  page: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXL,
  },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))',
    gap: tokens.spacingHorizontalL,
    alignItems: 'stretch',
  },
  cardGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
    gap: tokens.spacingHorizontalM,
  },
  sessionsRow: {
    display: 'flex',
    justifyContent: 'space-between',
    marginBottom: tokens.spacingVerticalS,
  },
  alertRow: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    padding: `${tokens.spacingVerticalXS} 0`,
  },
  alertRowText: {
    display: 'flex',
    alignItems: 'baseline',
    gap: tokens.spacingHorizontalS,
    flex: 1,
    minWidth: 0,
  },
  muted: {
    color: tokens.colorNeutralForeground3,
  },
  // AM-29 item 18: a left accent border instead of a full yellow row fill —
  // the existing warning icon + tooltip already carries the "why", so the
  // row itself only needs a quieter cue, not a wash of color that reads as
  // an error state at a glance.
  staleRow: {
    borderLeftWidth: '3px',
    borderLeftStyle: 'solid',
    borderLeftColor: tokens.colorStatusWarningBorder1,
  },
  warningIcon: {
    color: tokens.colorStatusWarningForeground1,
  },
  costRow: {
    display: 'flex',
    alignItems: 'baseline',
    gap: tokens.spacingHorizontalM,
    flexWrap: 'wrap',
  },
  costValue: {
    fontSize: tokens.fontSizeHero700,
    fontWeight: tokens.fontWeightSemibold,
  },
  costLabel: {
    color: tokens.colorNeutralForeground3,
  },
  // Peer review MAJOR 3 — the estate rollup line replacing the deleted HealthRing donut.
  rollupRow: {
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: tokens.spacingHorizontalM,
    marginBottom: tokens.spacingVerticalS,
  },
  rollupItem: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalXXS,
  },
  dotOk: {
    color: tokens.colorPaletteGreenForeground1,
  },
  dotDraining: {
    color: tokens.colorPaletteMarigoldForeground1,
  },
  dotUnavailable: {
    color: tokens.colorPaletteRedForeground1,
  },
});

const SEVERITY_TONE: Record<string, BadgeProps['color']> = {
  Sev0: 'danger',
  Sev1: 'danger',
  Sev2: 'severe',
  Sev3: 'warning',
  Sev4: 'informative',
};

/**
 * Peer review MAJOR 3 — HealthRing (a donut chart) was deleted in the
 * AM-31 item 33 SessionHostCard rework with no estate-wide rollup replacing
 * it; per the ruling on this item, this is NOT a chart restoration — just a
 * compact text line ("N available · N draining · N unavailable", small tone
 * dots) computed from the exact same view-model rule sessionHostViewModel.ts
 * derives per-card tone from (estateRollupCounts). Shown above BOTH the
 * SessionHostCard grid and the >6-hosts fallback table, so the estate
 * summary survives either rendering path.
 */
function EstateRollupLine({ hosts, styles }: { hosts: SessionHost[]; styles: ReturnType<typeof useStyles> }) {
  const { available, draining, unavailable } = estateRollupCounts(hosts);
  return (
    <div className={styles.rollupRow} role="status">
      <span className={styles.rollupItem}>
        <Circle12Filled className={styles.dotOk} aria-hidden="true" />
        <Text size={200}>{available} available</Text>
      </span>
      <span className={styles.rollupItem}>
        <Circle12Filled className={styles.dotDraining} aria-hidden="true" />
        <Text size={200}>{draining} draining</Text>
      </span>
      <span className={styles.rollupItem}>
        <Circle12Filled className={styles.dotUnavailable} aria-hidden="true" />
        <Text size={200}>{unavailable} unavailable</Text>
      </span>
    </div>
  );
}

export default function Dashboard() {
  const styles = useStyles();
  const cardStyles = useCardStyles();
  const { dispatchToast } = useAppToast();
  const { role } = useAuth();
  /** AM-31 item 33 — mirrors HostPool.tsx's own gate: the API independently re-checks (requireMinimumRole('operator')) regardless of what this UI shows. */
  const canMutate = role === 'operator' || role === 'admin';

  const health = usePolling(getHealthSummary, POLL_INTERVAL_MS);
  const scalingPlan = usePolling(getCurrentScalingPlan, POLL_INTERVAL_MS);
  const image = usePolling(getCurrentImageVersion, POLL_INTERVAL_MS);
  const alerts = usePolling(getRecentAlerts, POLL_INTERVAL_MS);
  const sessionHosts = usePolling((signal) => getSessionHosts(HOST_POOL_NAME, signal), POLL_INTERVAL_MS);
  // AM-31 item 33 — needed for the SessionHostCard grid's occupancy bar
  // (n/maxSessions); Dashboard had no reason to fetch host pool properties
  // before this (HostPool.tsx already does, for its own Properties card).
  const hostPools = usePolling(getHostPools, POLL_INTERVAL_MS);
  const hostPool = useMemo(() => hostPools.data?.find((pool) => pool.name === HOST_POOL_NAME), [hostPools.data]);
  // AM-29 item 21: reuses the SAME GET /v1/cost/summary call CostScaling.tsx's
  // own cost cards make — viewer-visible, and degrades gracefully (the tile
  // just shows its own AsyncState error state) if the Cost Management query
  // fails, same as every other Dashboard tile. Peer review (Opus, MAJOR item
  // 4): polls at the shared COST_POLL_INTERVAL_MS (5min), not this page's
  // generic 60s POLL_INTERVAL_MS — cost data changes far less often than
  // session/host state, and a 60s poll needlessly woke a scale-to-zero
  // Function App for a number that doesn't meaningfully change that often.
  const cost = usePolling(getCostSummary, COST_POLL_INTERVAL_MS);

  // Computed once per render (not inside the session-host table's .map()
  // below) and passed down to both computeScalingPhase and
  // toSessionHostViewModel (which itself derives heartbeat staleness), so
  // every "how stale is this" comparison in a single render uses the same
  // instant rather than drifting across rows.
  const now = new Date();
  const phase = scalingPlan.data ? computeScalingPhase(scalingPlan.data) : undefined;

  // AM-35 (item 48 sweep): the >6-hosts heartbeat fallback table used to
  // recompute "is this host's heartbeat stale" itself (a local
  // STALE_HEARTBEAT_MINUTES constant + inline minutesSince/isStale math)
  // duplicating toSessionHostViewModel's OWN heartbeatStale field —
  // W2/item-33 already made that view model the single source for the
  // SessionHostCard grid below; this column set now reads the SAME
  // `heartbeatStale` field instead of re-deriving it. Status badge tone
  // deliberately stays on the UN-escalated sessionHostStatusTone(status) —
  // not the view model's own escalated `tone` — to keep this table's colors
  // pixel-identical to before this refactor (escalating on stale/health
  // would be a behavior change this wave doesn't make).
  // Peer review (Opus, MINOR 5) — memoized on `styles` (Griffel's makeStyles
  // hook returns a stable object reference across renders when the theme
  // hasn't changed) rather than rebuilt as a fresh array literal on every
  // render: usePolling flips `refreshing` true/false around every poll
  // tick (twice per tick, before AND after the fetch resolves) regardless
  // of whether the fetched data actually changed, and this column set
  // itself closes over nothing else that varies — a fresh array reference
  // on each of those renders needlessly busted DataTable's own sortedRows
  // memo for no reason.
  const heartbeatColumns = useMemo<DataTableColumn<SessionHostViewModel>[]>(
    () => [
      {
        id: 'host',
        label: 'Host',
        renderCell: (vm) => (
          // AM-29 item F: stale heartbeat rows link straight to the Host Pool page.
          vm.heartbeatStale ? <AppLink to="/host-pools">{vm.name}</AppLink> : vm.name
        ),
      },
      {
        id: 'status',
        label: 'Status',
        renderCell: (vm) => <StatusBadge label={vm.status} tone={sessionHostStatusTone(vm.status)} />,
      },
      { id: 'powerState', label: 'Power state', renderCell: (vm) => vm.powerState ?? 'unknown' },
      {
        id: 'lastHeartbeat',
        label: 'Last heartbeat',
        renderCell: (vm) =>
          vm.heartbeatStale ? (
            <Tooltip content={`No heartbeat in over ${STALE_HEARTBEAT_MINUTES} minutes while the VM is running`} relationship="label">
              <span>
                <Warning16Filled className={styles.warningIcon} /> {formatDateTime(vm.lastHeartBeat)}
              </span>
            </Tooltip>
          ) : (
            formatDateTime(vm.lastHeartBeat)
          ),
      },
    ],
    [styles],
  );

  // AM-29 item A: a single PageHeader asOf/refreshing summarizing all
  // independent polls — "refreshing" is true while ANY of them has a
  // background fetch in flight, "asOf" is the MOST RECENT successful fetch
  // across all of them (the freshest thing on the page right now), and
  // "refresh" re-triggers every one at once rather than picking just one
  // to represent the rest.
  const allQueries = [health, scalingPlan, image, alerts, sessionHosts, hostPools, cost];
  const anyRefreshing = allQueries.some((query) => query.refreshing);
  const latestUpdated = allQueries.reduce<Date | undefined>((latest, query) => {
    if (!query.lastUpdated) return latest;
    return !latest || query.lastUpdated > latest ? query.lastUpdated : latest;
  }, undefined);
  function refreshAll() {
    for (const query of allQueries) {
      query.refresh();
    }
  }

  // AM-29 item F: inline ack (operator+) from the alerts card — reversible
  // via un-ack on the Monitoring page, so this stays a LIGHTWEIGHT modal
  // (severity 'low', not Monitoring's own full-detail flow), rather than a
  // second per-alert investigation surface. Peer review (Opus, MAJOR item
  // 1): ackAlert audits a reason server-side — this dashboard shortcut
  // dropped that capture entirely (a bare one-click button, `{}` body) when
  // it was first added; the fix keeps it lightweight (ConfirmModal +
  // optionalReason, not a mandatory field) rather than reverting to
  // Monitoring's heavier flow.
  const [ackTarget, setAckTarget] = useState<{ id: string; name: string } | undefined>(undefined);
  const [ackBusy, setAckBusy] = useState(false);
  const [ackError, setAckError] = useState<string | undefined>(undefined);
  async function handleAck(reason: string | undefined) {
    if (!ackTarget) return;
    setAckBusy(true);
    setAckError(undefined);
    try {
      await ackAlert(ackTarget.id, { reason });
      alerts.refresh();
      dispatchToast(
        <Toast>
          <ToastTitle>Acknowledged &quot;{ackTarget.name}&quot;</ToastTitle>
        </Toast>,
        { intent: 'success' },
      );
      setAckTarget(undefined);
    } catch (error) {
      setAckError(error instanceof Error ? error.message : 'Failed to acknowledge alert.');
    } finally {
      setAckBusy(false);
    }
  }

  // --- AM-31 item 33: session-host card actions — drain toggle, power
  // actions, health-checks drawer. Mirrors HostPool.tsx's own flow (same
  // dialogs, same rubric — see that file's own comments for the full
  // rationale on each design choice referenced here) so an operator sees
  // identical behavior whether they act from the Dashboard or Host Pool.
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

  return (
    <div className={styles.page}>
      <PageHeader title="Dashboard" asOf={latestUpdated} refreshing={anyRefreshing} onRefresh={refreshAll} />

      <div className={styles.grid}>
        {/* AM-35 (item 49): each of these four tiles previously repeated the same Card + CardHeader + AsyncState(variant="stat") + optional CardFooter shape independently — now the shared StatTile primitive. */}
        <StatTile title="Sessions" loading={health.loading} error={health.error as Error | undefined} data={health.data} asOf={health.lastUpdated}>
          {(data) => (
            <>
              <div className={styles.sessionsRow}>
                <Text>
                  {data.sessionsUsed} / {data.sessionsMax || '—'} sessions used
                </Text>
              </div>
              <ProgressBar value={data.sessionsUsed} max={data.sessionsMax || 1} thickness="large" color={data.sessionsMax > 0 && data.sessionsUsed >= data.sessionsMax ? 'error' : 'brand'} />
            </>
          )}
        </StatTile>

        {/* AM-31 item 32b: Cost & Scaling split into two pages — this tile is about the SCALING phase specifically. */}
        <StatTile title="Scaling phase" loading={scalingPlan.loading} error={scalingPlan.error as Error | undefined} data={scalingPlan.data} asOf={scalingPlan.lastUpdated} footerLink={{ to: '/scaling', label: 'View scaling →' }}>
          {(data) => (
            <>
              <StatusBadge size="extra-large" label={phase ? PHASE_LABEL[phase] : 'Unknown'} tone={phase ? PHASE_TONE[phase] : 'info'} />
              <Text as="p" block className={styles.muted}>
                {data.name} · {data.timeZone} · {data.enabled ? 'enabled' : 'disabled'}
              </Text>
            </>
          )}
        </StatTile>

        {/* AM-29 item F: footer entry point to Images. */}
        <StatTile title="Image version" loading={image.loading} error={image.error as Error | undefined} data={image.data} asOf={image.lastUpdated} footerLink={{ to: '/images', label: 'View images →' }}>
          {(data) => (
            <>
              <Badge size="extra-large" appearance="tint" color="brand">
                {data.name}
              </Badge>
              <Text as="p" block className={styles.muted}>
                {data.ageDays !== undefined ? `Published ${data.ageDays}d ago` : 'Publish date unknown'}
                {data.daysUntilEol !== undefined && (
                  <>
                    {' · '}
                    {/* AM-26 peer review MINOR 5: wired to the shared eolTier
                        classifier (the same one the Images page's version
                        timeline uses) instead of this card's own hardcoded
                        <90-day threshold — 'ok' stays muted/regular weight,
                        'warning'/'critical' (eolTier's finer-grained split
                        of what used to be one <90 bucket) render emphasized. */}
                    <Text weight={eolTier(data.daysUntilEol) === 'ok' ? undefined : 'semibold'} className={eolTier(data.daysUntilEol) === 'ok' ? styles.muted : undefined}>
                      {data.daysUntilEol >= 0 ? `EOL in ${data.daysUntilEol}d` : `EOL ${Math.abs(data.daysUntilEol)}d ago`}
                    </Text>
                  </>
                )}
              </Text>
            </>
          )}
        </StatTile>

        {/* AM-29 item 21: month-to-date cost + projection + delta vs. prior month, reusing Cost.tsx's own GET /v1/cost/summary call. */}
        <StatTile title="Cost (month to date)" loading={cost.loading} error={cost.error as Error | undefined} data={cost.data} asOf={cost.lastUpdated} footerLink={{ to: '/cost', label: 'View cost →' }}>
          {(data) => (
            <>
              <div className={styles.costRow}>
                <Text className={styles.costValue}>{formatCurrency(data.monthToDateCost, data.currency)}</Text>
                <DeltaBadge current={data.monthToDateCost} comparison={data.priorMonthSamePeriodCost} />
              </div>
              <Text as="p" block className={styles.costLabel}>
                {data.projectedMonthEndCost !== undefined ? `Projected month end: ${formatCurrency(data.projectedMonthEndCost, data.currency)}` : 'Projection unavailable — not enough days of data yet.'}
              </Text>
            </>
          )}
        </StatTile>

        <Card className={cardStyles.card}>
          <CardHeader header={<Text as="h2" size={400} weight="semibold">Recent alerts</Text>} />
          <AsyncState loading={alerts.loading} error={alerts.error as Error | undefined} data={alerts.data} asOf={alerts.lastUpdated} isEmpty={(data) => data.length === 0} emptyMessage="No alerts have fired recently." variant="stat">
            {(data) => (
              <>
                {data.map((alert) => {
                  const isAcked = Boolean(alert.ackedBy);
                  return (
                    <div key={alert.id} className={styles.alertRow}>
                      <div className={styles.alertRowText}>
                        <Badge appearance="tint" color={SEVERITY_TONE[alert.severity] ?? 'informative'}>
                          {alert.severity}
                        </Badge>
                        <Text>{alert.name}</Text>
                        <Text size={200} className={styles.muted}>
                          {formatRelativeToNow(alert.firedAt)}
                        </Text>
                      </div>
                      {/* AM-29 item F: inline Ack, operator+ only — the API independently re-checks requireMinimumRole('operator'). */}
                      {isAcked ? (
                        <StatusBadge label="Acked" tone="pending" />
                      ) : (
                        <RoleGate allowed={['operator', 'admin']}>
                          <Button size="small" appearance="secondary" onClick={() => setAckTarget({ id: alert.id, name: alert.name })}>
                            Ack
                          </Button>
                        </RoleGate>
                      )}
                    </div>
                  );
                })}
              </>
            )}
          </AsyncState>
          {/* AM-29 item F: "View all →" entry point to the full Monitoring alert feed. */}
          <CardFooter>
            <AppLink to="/monitoring">View all →</AppLink>
          </CardFooter>
        </Card>
      </div>

      {/* AM-31 item 33 — replaces the former HealthRing tile + this section's
          own plain heartbeat table with the shared SessionHostCard grid (same
          view model, same card, as Host Pool's own grid). Falls back to the
          pre-existing heartbeat table above CARD_GRID_MAX_HOSTS hosts. */}
      <Card className={cardStyles.card}>
        <CardHeader header={<Text as="h2" size={400} weight="semibold">Session hosts — {HOST_POOL_NAME}</Text>} />
        <AsyncState loading={sessionHosts.loading} error={sessionHosts.error as Error | undefined} data={sessionHosts.data} asOf={sessionHosts.lastUpdated} isEmpty={(data) => data.length === 0} emptyMessage="No session hosts found." variant="table">
          {(data) =>
            data.length > CARD_GRID_MAX_HOSTS ? (
              <>
              <EstateRollupLine hosts={data} styles={styles} />
              <DataTable
                ariaLabel="Session host heartbeats"
                columns={heartbeatColumns}
                rows={data.map((host) => toSessionHostViewModel(host, { maxSessions: hostPool?.maxSessionLimit, now }))}
                getRowKey={(vm) => vm.id}
                rowClassName={(vm) => (vm.heartbeatStale ? styles.staleRow : undefined)}
                emptyMessage="No session hosts found."
              />
              </>
            ) : (
              <>
              <EstateRollupLine hosts={data} styles={styles} />
              <div className={styles.cardGrid}>
                {data.map((host) => (
                  <SessionHostCard
                    key={host.id}
                    host={toSessionHostViewModel(host, { maxSessions: hostPool?.maxSessionLimit, now })}
                    canMutate={canMutate}
                    onToggleDrainRequest={() => openDrainDialog(host)}
                    onPowerActionRequest={(_vm, action) => openPowerDialog(host, action)}
                    onViewHealthChecks={() => setSelectedHost(host)}
                  />
                ))}
              </div>
              </>
            )
          }
        </AsyncState>
        {/* AM-29 item F: footer entry point to the Host Pool page — carried over from the removed HealthRing tile's own footer link. */}
        <CardFooter>
          <AppLink to="/host-pools">View host pool →</AppLink>
        </CardFooter>
      </Card>

      <HealthChecksDrawer host={selectedHost ? toSessionHostViewModel(selectedHost, { maxSessions: hostPool?.maxSessionLimit, now }) : undefined} onClose={() => setSelectedHost(undefined)} />

      {/* AM-29 item F — lightweight ack modal (severity 'low' + optionalReason, see handleAck's doc comment above). */}
      {ackTarget && (
        <ConfirmModal
          title={`Acknowledge "${ackTarget.name}"?`}
          severity="low"
          optionalReason
          description="Records who acknowledged it and when — it does not close the alert in Azure Monitor. This can be undone with Un-ack on the Monitoring page."
          confirmLabel="Acknowledge"
          busy={ackBusy}
          error={ackError}
          onConfirm={handleAck}
          onCancel={() => {
            if (ackBusy) return;
            setAckTarget(undefined);
            setAckError(undefined);
          }}
        />
      )}

      {/* AM-31 item 33 — drain/resume, mirroring HostPool.tsx's own severity 'low' + optionalReason rubric. */}
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

      {/* AM-31 item 33 — sessions-warning intermediate step, sharing SessionsWarningDialog with HostPool.tsx's own AM-19 flow (also gets item 37's focus-restore for free — see that component). AM-33: allowNewSession passed through — see HostPool.tsx's own identical wiring for why. */}
      {powerTargetId && powerTarget && powerAction && needsSessionsWarning && !warningAcknowledged && (
        <SessionsWarningDialog hostName={powerTarget.name} activeSessions={powerTarget.activeSessions} allowNewSession={powerTarget.allowNewSession} action={powerAction} onProceed={proceedPastSessionsWarning} onCancel={cancelPowerDialog} />
      )}

      {/* AM-31 item 33 — start is severity 'low'. */}
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

      {/* AM-31 item 33 — restart/deallocate are severity 'medium', matching HostPool.tsx's rubric. AM-33 (D5): the impact panel is computed by the same hostPowerPreviewLines helper as HostPool.tsx's own — see that helper's doc comment for why this is consistent wording with the SessionsWarningDialog interstitial above, not a "mirror" of needsSessionsWarning. */}
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
