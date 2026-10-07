import { useMemo } from 'react';
import {
  makeStyles,
  tokens,
  Card,
  CardHeader,
  Text,
  Button,
  ProgressBar,
  MessageBar,
  MessageBarBody,
  MessageBarTitle,
  Tooltip,
  type MessageBarIntent,
} from '@fluentui/react-components';
import { Info16Regular } from '@fluentui/react-icons';
import type { CostByResourceGroup, HostRuntimeSummary, IdleHostFinding, SavingsOpportunity } from '@avdmgr/shared';
import { getCostHostRuntime, getCostSummary, getFslogixUsage, getIdleHosts, getSavingsOpportunities } from '../api/avd';
import { usePolling } from '../hooks/usePolling';
import AsyncState from '../components/AsyncState';
import StatusBadge from '../components/StatusBadge';
import DeltaBadge from '../components/DeltaBadge';
import PageHeader from '../components/PageHeader';
import DataTable, { type DataTableColumn } from '../components/DataTable';
import { formatCurrency, formatDateTime, formatTime } from '../lib/format';
import { COST_POLL_INTERVAL_MS } from '../lib/config';
import { useCardStyles } from '../styles/shared';
import { PHASE_LABEL, PHASE_TONE } from '../lib/phaseColor';

/**
 * AM-31 item 32b — split off CostScaling.tsx's cost-dashboard half
 * (month-to-date spend, host runtime hours, FSLogix usage, savings
 * callouts, idle-host findings): the admin's slower, 5-minute-polled
 * surface. See Scaling.tsx for the operator's fast-moving 20s-polled
 * schedule/override half — see that file's own doc comment for why they
 * were split. Every widget below polls independently (see src/api/avd.ts)
 * so one failing data source degrades only that card, not the whole page.
 */
const useStyles = makeStyles({
  page: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXL,
  },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
    gap: tokens.spacingHorizontalL,
    alignItems: 'stretch',
  },
  statValue: {
    fontSize: tokens.fontSizeHero700,
    fontWeight: tokens.fontWeightSemibold,
  },
  statLabelRow: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalXXS,
  },
  statLabel: {
    color: tokens.colorNeutralForeground3,
  },
  muted: {
    color: tokens.colorNeutralForeground3,
  },
  usageRow: {
    display: 'flex',
    justifyContent: 'space-between',
    marginBottom: tokens.spacingVerticalS,
  },
  savingsList: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalS,
  },
  note: {
    marginBottom: tokens.spacingVerticalM,
    color: tokens.colorNeutralForeground3,
  },
  infoTrigger: {
    minWidth: 'auto',
    padding: 0,
  },
  columnHeaderRow: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalXXS,
  },
});

const SEVERITY_TO_INTENT: Record<SavingsOpportunity['severity'], MessageBarIntent> = {
  critical: 'error',
  warning: 'warning',
  info: 'info',
};

const IDLE_HOST_COLUMNS: DataTableColumn<IdleHostFinding>[] = [
  { id: 'host', label: 'Host', renderCell: (finding) => finding.sessionHostName },
  { id: 'powerState', label: 'Power state', renderCell: (finding) => <StatusBadge label={finding.powerState} tone="warning" /> },
  {
    id: 'phase',
    label: 'Phase',
    // AM-31 item 42: shared phase palette — see lib/phaseColor.ts.
    renderCell: (finding) => <StatusBadge label={PHASE_LABEL[finding.phase]} tone={PHASE_TONE[finding.phase]} />,
  },
  { id: 'disconnectedSessions', label: 'Disconnected sessions', renderCell: (finding) => finding.disconnectedSessions },
  { id: 'runningSince', label: 'Running since (approx)', renderCell: (finding) => (finding.runningSinceApprox ? formatDateTime(finding.runningSinceApprox) : 'Not derivable') },
];

function InfoTooltip({ content, label }: { content: string; label: string }) {
  const styles = useStyles();
  return (
    <Tooltip content={content} relationship="description">
      <Button appearance="transparent" size="small" shape="circular" icon={<Info16Regular />} aria-label={label} className={styles.infoTrigger} />
    </Tooltip>
  );
}

/**
 * Peer review (Opus, MINOR 5) — extracted into its own named component
 * (rather than a plain callback inside AsyncState's render prop, as this
 * briefly was post-AM-35 migration) specifically so it can call `useMemo`
 * safely: a bare arrow function isn't a React component/hook as far as the
 * rules of hooks are concerned, and this column set genuinely needs to
 * depend on `currency` (part of the polled data, not a module-level
 * constant), so it can't be hoisted the way Sessions'/Monitoring's fully
 * static column sets were. Fixed cost-descending order, not user-sortable
 * — no column here sets `sortable`.
 */
function ResourceGroupTable({ byResourceGroup, currency }: { byResourceGroup: CostByResourceGroup[]; currency: string }) {
  const columns = useMemo<DataTableColumn<CostByResourceGroup>[]>(
    () => [
      { id: 'resourceGroup', label: 'Resource group', renderCell: (rg) => rg.resourceGroup },
      { id: 'cost', label: 'Month-to-date cost', renderCell: (rg) => formatCurrency(rg.cost, currency) },
    ],
    [currency],
  );
  const rows = useMemo(() => [...byResourceGroup].sort((a, b) => b.cost - a.cost), [byResourceGroup]);
  return <DataTable ariaLabel="Spend by resource group" columns={columns} rows={rows} getRowKey={(rg) => rg.resourceGroup} emptyMessage="No cost data available." />;
}

export default function Cost() {
  const styles = useStyles();
  const cardStyles = useCardStyles();

  const summary = usePolling(getCostSummary, COST_POLL_INTERVAL_MS);
  const hostRuntime = usePolling(getCostHostRuntime, COST_POLL_INTERVAL_MS);
  const fslogix = usePolling(getFslogixUsage, COST_POLL_INTERVAL_MS);
  const savings = usePolling(getSavingsOpportunities, COST_POLL_INTERVAL_MS);
  const idleHosts = usePolling(getIdleHosts, COST_POLL_INTERVAL_MS);

  const allQueries = [summary, hostRuntime, fslogix, savings, idleHosts];

  // Peer review (Opus, MINOR 5) — memoized on `styles` (the only thing this
  // column set closes over — `InfoTooltip`, `formatCurrency`-free cells) so
  // it isn't rebuilt as a fresh array on every one of usePolling's
  // refreshing-flip re-renders. Hoisted here to Cost()'s own top level
  // (not the nested AsyncState render prop it's used inside) specifically
  // so `useMemo` is called unconditionally on every render, same reasoning
  // as ResourceGroupTable's extraction above.
  const sessionHostActivityColumns = useMemo<DataTableColumn<HostRuntimeSummary>[]>(
    () => [
      { id: 'host', label: 'Host', renderCell: (host) => host.sessionHostName },
      {
        id: 'runningHours',
        label: 'Hours with agent telemetry',
        header: (
          <div className={styles.columnHeaderRow}>
            <span>Hours with agent telemetry</span>
            <InfoTooltip
              label="About hours with/without agent telemetry"
              content="This estate has no Azure Monitor Agent installed on session hosts, so exact power-on time (Heartbeat) isn't available. These hours are derived from WVDAgentHealthStatus presence-per-hour — a coarser, agent-reporting-based signal, not a true power-state history."
            />
          </div>
        ),
        renderCell: (host) => (host.dataSource === 'none' ? '—' : `${host.runningHours}h`),
      },
      { id: 'deallocatedHours', label: 'Hours without agent telemetry', renderCell: (host) => (host.dataSource === 'none' ? '—' : `${host.deallocatedHours}h`) },
      {
        id: 'windowHours',
        label: 'Observed window',
        renderCell: (host) => (host.dataSource === 'none' ? <StatusBadge label="No data" tone="warning" /> : `${host.windowHours}h`),
      },
    ],
    [styles],
  );

  return (
    <div className={styles.page}>
      <PageHeader
        title="Cost"
        asOf={allQueries.reduce<Date | undefined>((latest, query) => {
          // AM-40 peer review MAJOR 3b: a stale-served summary is still a
          // SUCCESSFUL fetch as far as usePolling is concerned (see
          // CostSummary.stale's own doc comment in @avdmgr/shared), so
          // summary.lastUpdated gets bumped to "now" on every stale-serve
          // just like a genuinely fresh one would. Left in the reduce below,
          // that would make this page-level "as of HH:MM" claim the summary
          // section is fresh at the exact moment it's actually showing
          // cached data — excluded here so the header never contradicts the
          // caveat MessageBar just below it. The other four independent
          // widgets (host runtime, FSLogix, savings, idle hosts) are
          // unaffected and still contribute normally.
          if (query === summary && summary.data?.stale) return latest;
          return !query.lastUpdated ? latest : !latest || query.lastUpdated > latest ? query.lastUpdated : latest;
        }, undefined)}
        refreshing={allQueries.some((query) => query.refreshing)}
        onRefresh={() => {
          for (const query of allQueries) query.refresh();
        }}
      />

      {/*
        AM-39 — costService.ts's cost-summary cache serves the last
        successful result with `stale: true` (instead of a 5xx) when a live
        Cost Management refresh fails. That's a SUCCESSFUL 200 response as
        far as usePolling is concerned (summary.error stays undefined), so
        AsyncState's own error-triggered stale-data bar never fires for this
        case — this explicit check is what surfaces the caveat to the
        operator instead of silently showing (now possibly minutes-old)
        figures with no indication they're not live.

        AM-40 peer review MAJOR 3 / MINOR 7: uses `computedAt` (an exact
        cache-write-time timestamp — see CostSummary.computedAt's doc
        comment), not `asOfDate` (day-granularity DATA freshness, useless
        for "how old is this CACHED VALUE" — see that field's own doc
        comment), and the copy is scoped explicitly to the summary-fed cards
        below (month-to-date/prior-month/projected/spend-by-resource-group)
        so it doesn't implicate the independent savings/idle-host/session-
        host-activity/FSLogix sections further down this page, which pull
        from entirely separate polling hooks and are unaffected.
      */}
      {summary.data?.stale && (
        <MessageBar intent="warning" role="status" aria-live="polite">
          <MessageBarBody>
            <MessageBarTitle>Showing cached spend data</MessageBarTitle>
            The latest refresh from Cost Management failed — the month-to-date, prior-month, projected, and spend-by-resource-group figures below are cached from {formatTime(new Date(summary.data.computedAt))}, not live. Other sections on this page are unaffected.
          </MessageBarBody>
        </MessageBar>
      )}

      <div className={styles.grid}>
        <Card className={cardStyles.card}>
          <CardHeader header={<Text as="h2" size={400} weight="semibold">Month to date</Text>} />
          <AsyncState loading={summary.loading} error={summary.error as Error | undefined} data={summary.data}>
            {(data) => (
              <>
                <Text as="p" block className={styles.statValue}>
                  {formatCurrency(data.monthToDateCost, data.currency)}
                </Text>
                <Text as="p" block className={styles.statLabel}>
                  as of {data.asOfDate}
                </Text>
              </>
            )}
          </AsyncState>
        </Card>

        <Card className={cardStyles.card}>
          <CardHeader header={<Text as="h2" size={400} weight="semibold">Prior month, same period</Text>} />
          <AsyncState loading={summary.loading} error={summary.error as Error | undefined} data={summary.data}>
            {(data) =>
              data.priorMonthSamePeriodCost === undefined ? (
                <Text className={styles.muted}>Not available</Text>
              ) : (
                <>
                  <Text as="p" block className={styles.statValue}>
                    {formatCurrency(data.priorMonthSamePeriodCost, data.currency)}
                  </Text>
                  <DeltaBadge current={data.monthToDateCost} comparison={data.priorMonthSamePeriodCost} />
                </>
              )
            }
          </AsyncState>
        </Card>

        <Card className={cardStyles.card}>
          <CardHeader header={<Text as="h2" size={400} weight="semibold">Projected month-end</Text>} />
          <AsyncState loading={summary.loading} error={summary.error as Error | undefined} data={summary.data}>
            {(data) =>
              data.projectedMonthEndCost === undefined ? (
                <Text className={styles.muted}>Not available</Text>
              ) : (
                <>
                  <Text as="p" block className={styles.statValue}>
                    {formatCurrency(data.projectedMonthEndCost, data.currency)}
                  </Text>
                  <div className={styles.statLabelRow}>
                    <Text className={styles.statLabel}>Linear projection</Text>
                    <InfoTooltip
                      label="About the month-end projection method"
                      content="Simple linear projection: (month-to-date cost / complete days elapsed) × days in month. Does not account for known ramp changes or usage patterns."
                    />
                  </div>
                </>
              )
            }
          </AsyncState>
        </Card>
      </div>

      <Card className={cardStyles.card}>
        <CardHeader header={<Text as="h2" size={400} weight="semibold">Spend by resource group (month to date)</Text>} />
        <AsyncState loading={summary.loading} error={summary.error as Error | undefined} data={summary.data} isEmpty={(data) => data.byResourceGroup.length === 0} emptyMessage="No cost data available.">
          {(data) => <ResourceGroupTable byResourceGroup={data.byResourceGroup} currency={data.currency} />}
        </AsyncState>
      </Card>

      <Card className={cardStyles.card}>
        <CardHeader header={<Text as="h2" size={400} weight="semibold">Savings opportunities</Text>} />
        <AsyncState
          loading={savings.loading}
          error={savings.error as Error | undefined}
          data={savings.data}
          isEmpty={(data) => data.length === 0}
          emptyMessage="No savings opportunities detected right now."
        >
          {(data) => (
            <div className={styles.savingsList}>
              {data.map((opportunity, index) => (
                <MessageBar key={`${opportunity.title}-${index}`} intent={SEVERITY_TO_INTENT[opportunity.severity]}>
                  <MessageBarBody>
                    <MessageBarTitle>{opportunity.title}</MessageBarTitle>
                    {opportunity.detail}
                  </MessageBarBody>
                </MessageBar>
              ))}
            </div>
          )}
        </AsyncState>
      </Card>

      <Card className={cardStyles.card}>
        <CardHeader header={<Text as="h2" size={400} weight="semibold">Idle hosts</Text>} />
        {/*
          PEER REVIEW ITEM 12: distinguishes "no scaling plan associated with
          this host pool — detection could not run" (evaluated: false) from
          a genuine all-clear (evaluated: true, findings: []).
        */}
        <AsyncState loading={idleHosts.loading} error={idleHosts.error as Error | undefined} data={idleHosts.data}>
          {(data) =>
            !data.evaluated ? (
              <MessageBar intent="warning">
                <MessageBarBody>
                  <MessageBarTitle>Idle-host detection unavailable</MessageBarTitle>
                  No scaling plan is associated with this host pool, so there is no schedule to evaluate hosts against.
                </MessageBarBody>
              </MessageBar>
            ) : data.findings.length === 0 ? (
              <MessageBar intent="success" role="status" aria-live="polite">
                <MessageBarBody>No idle hosts detected — every running host is either in an expected scaling phase or has an active session.</MessageBarBody>
              </MessageBar>
            ) : (
              <>
                <Text as="p" block className={styles.note}>
                  Hosts below are running with zero active sessions during a phase the schedule expects hosts to be scaling in. A host with one or more
                  disconnected sessions matches the documented idle-host leak (the scaling-plan runbook §6) — a disconnected-but-not-signed-out
                  session prevents deallocation. A host with zero sessions of any kind has no session-based explanation for being up at all.
                </Text>
                <DataTable ariaLabel="Idle hosts" columns={IDLE_HOST_COLUMNS} rows={data.findings} getRowKey={(finding) => `${finding.hostPoolName}/${finding.sessionHostName}`} emptyMessage="No idle hosts detected." />
              </>
            )
          }
        </AsyncState>
      </Card>

      <Card className={cardStyles.card}>
        <CardHeader header={<Text as="h2" size={400} weight="semibold">Session host activity (last 7 days)</Text>} />
        <AsyncState
          loading={hostRuntime.loading}
          error={hostRuntime.error as Error | undefined}
          data={hostRuntime.data}
          isEmpty={(data) => data.length === 0}
          emptyMessage="No session hosts found."
        >
          {(data) => (
            <>
              {data.some((h) => h.dataSource === 'none') && (
                <MessageBar intent="info">
                  <MessageBarBody>Agent telemetry could not be determined for one or more hosts (no host data available for this window).</MessageBarBody>
                </MessageBar>
              )}
              <DataTable
                ariaLabel="Session host activity"
                columns={sessionHostActivityColumns}
                rows={data}
                getRowKey={(host) => `${host.hostPoolName}/${host.sessionHostName}`}
                emptyMessage="No session hosts found."
              />
            </>
          )}
        </AsyncState>
      </Card>

      <Card className={cardStyles.card}>
        <CardHeader header={<Text as="h2" size={400} weight="semibold">FSLogix profile share</Text>} />
        <AsyncState loading={fslogix.loading} error={fslogix.error as Error | undefined} data={fslogix.data}>
          {(data) => (
            <>
              <div className={styles.usageRow}>
                <Text>
                  {data.shareName} ({data.storageAccountName})
                </Text>
                <Text>
                  {data.provisionedGib > 0 ? (
                    <>
                      {data.usedGib} GiB used / {data.provisionedGib} GiB provisioned ({data.percentUsed.toFixed(1)}%)
                    </>
                  ) : (
                    <>{data.usedGib} GiB used — provisioned size not reported</>
                  )}
                </Text>
              </div>
              <ProgressBar
                value={data.provisionedGib > 0 ? data.percentUsed : 0}
                max={100}
                thickness="large"
                color={data.percentUsed >= 90 ? 'error' : data.percentUsed >= 75 ? 'warning' : 'brand'}
              />
            </>
          )}
        </AsyncState>
      </Card>
    </div>
  );
}
