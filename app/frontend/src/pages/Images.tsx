import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router-dom';
import {
  makeStyles,
  mergeClasses,
  tokens,
  Card,
  CardHeader,
  Text,
  Badge,
  Button,
  Tooltip,
  MessageBar,
  MessageBarBody,
  MessageBarTitle,
  TabList,
  Tab,
  type BadgeProps,
  type SelectTabData,
  type SelectTabEvent,
} from '@fluentui/react-components';
import { Info16Regular } from '@fluentui/react-icons';
import { eolTier, type EolTier, type ImageVersionTimelineEntry, type ImageSnapshot } from '@avdmgr/shared';
import { getImageSnapshots, getImageVersions } from '../api/avd';
import { usePolling, type PollingState } from '../hooks/usePolling';
import AsyncState from '../components/AsyncState';
import StatusBadge from '../components/StatusBadge';
import RolloutWizard from '../components/RolloutWizard';
import ImageBuildSection from '../components/ImageBuildSection';
import PageHeader from '../components/PageHeader';
import DataTable, { type DataTableColumn } from '../components/DataTable';
import { HOST_POOL_NAME } from '../lib/config';
import { formatDateTime } from '../lib/format';
import { useCardStyles } from '../styles/shared';

/** AM-31 item 32a — Image/gallery/snapshot data changes far less often than session/host state, same 5-minute cadence Cost.tsx's own widgets use. Only in effect while the Versions/Snapshots tab is actually mounted — see this file's own doc comment. */
const POLL_INTERVAL_MS = 5 * 60_000;

/** Fixed approximate rate this page's cost caveats reference — MUST stay in sync with snapshotsService.ts's APPROX_SNAPSHOT_GIB_MONTHLY_RATE_USD (that module is the single source of truth for the actual estimate; this is only for the caveat copy). */
const APPROX_SNAPSHOT_GIB_MONTHLY_RATE_USD = 0.05;

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
  muted: {
    color: tokens.colorNeutralForeground3,
  },
  unresolvedList: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXXS,
  },
  columnHeaderRow: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalXXS,
  },
  infoTrigger: {
    minWidth: 'auto',
    padding: 0,
  },
  reasonCell: {
    maxWidth: '320px',
  },
  tabPanel: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXL,
  },
});

/** Same tier→color mapping convention as Dashboard.tsx's PHASE_TONE lookup table. 'unknown' (no EOL date at all) is deliberately neutral, not alarming — an unconfigured EOL date is not evidence of anything urgent. */
const EOL_TIER_TONE: Record<EolTier, BadgeProps['color']> = {
  critical: 'danger',
  warning: 'warning',
  ok: 'success',
  unknown: 'informative',
};

const EOL_TIER_LABEL: Record<EolTier, string> = {
  critical: 'Critical',
  warning: 'Warning',
  ok: 'OK',
  unknown: 'Unknown',
};

/**
 * Keyboard/screen-reader-accessible info tooltip trigger — same pattern as
 * Cost.tsx's InfoTooltip (a real focusable Button, not a bare hover
 * target). Reused here for the snapshot report's cost-caveat column header.
 */
function InfoTooltip({ content, label }: { content: string; label: string }) {
  const styles = useStyles();
  return (
    <Tooltip content={content} relationship="description">
      <Button appearance="transparent" size="small" shape="circular" icon={<Info16Regular />} aria-label={label} className={styles.infoTrigger} />
    </Tooltip>
  );
}

/**
 * Renders the EOL countdown text + a warning-tier badge, mirroring the
 * Dashboard image-version card's "EOL in Nd" / "EOL Nd ago" copy, extended
 * with eolTier's extra 'critical' tier.
 *
 * AM-26 peer review MAJOR 4 (a11y): the Badge carries `tabIndex={0}` so a
 * keyboard user can actually reach the Tooltip's trigger — a plain Badge
 * renders as a non-focusable `<span>`, which would make this tier
 * information (color-only otherwise) unreachable without a mouse. The
 * visible text label already states the tier via EOL_TIER_LABEL in the
 * tooltip; the badge's own visible text (the countdown) plus its color are
 * the non-tooltip-dependent cues for sighted users.
 */
function EolBadge({ daysUntilEol }: { daysUntilEol: number | undefined }) {
  const tier = eolTier(daysUntilEol);
  const text = daysUntilEol === undefined ? 'EOL unknown' : daysUntilEol >= 0 ? `EOL in ${daysUntilEol}d` : `EOL ${Math.abs(daysUntilEol)}d ago`;
  return (
    <Tooltip content={`EOL warning tier: ${EOL_TIER_LABEL[tier]}`} relationship="description">
      <Badge appearance="tint" color={EOL_TIER_TONE[tier]} size="small" tabIndex={0}>
        {text}
      </Badge>
    </Tooltip>
  );
}

/** AM-26 peer review MINOR 8: pickLatest (imagesService.ts) can fall back to picking a version that is ITSELF excludeFromLatest:true when every version in the definition is excluded — a version the AVD/SIG platform would not itself consider "latest". That combination can only arise via that fallback, so it's detected here purely from the two fields already on the entry, no extra API field needed. */
function isFallbackCurrent(version: ImageVersionTimelineEntry): boolean {
  return version.isCurrent && version.excludeFromLatest;
}

const VERSION_COLUMNS: DataTableColumn<ImageVersionTimelineEntry>[] = [
  {
    id: 'version',
    label: 'Version',
    renderCell: (version) => (
      <>
        <Text weight={version.isCurrent ? 'semibold' : undefined}>{version.name}</Text>
        {version.isCurrent && !isFallbackCurrent(version) && (
          <>
            {' '}
            <Badge appearance="tint" color="brand" size="small">
              Current
            </Badge>
          </>
        )}
        {isFallbackCurrent(version) && (
          <>
            {' '}
            <Tooltip content="Every version of this definition is excluded from latest — this is a fallback pick, not a genuine 'latest' per the AVD/SIG platform's own rules." relationship="description">
              <Badge appearance="tint" color="warning" size="small" tabIndex={0}>
                Current (fallback)
              </Badge>
            </Tooltip>
          </>
        )}
        {version.excludeFromLatest && (
          <>
            {' '}
            <Badge appearance="outline" size="small">
              Excluded from latest
            </Badge>
          </>
        )}
      </>
    ),
  },
  { id: 'published', label: 'Published', renderCell: (version) => formatDateTime(version.publishedDate) },
  { id: 'age', label: 'Age', renderCell: (version) => (version.ageDays !== undefined ? `${version.ageDays}d` : '—') },
  { id: 'eol', label: 'EOL', renderCell: (version) => <EolBadge daysUntilEol={version.daysUntilEol} /> },
  { id: 'replication', label: 'Replication', renderCell: (version) => version.replicationState ?? '—' },
  {
    id: 'provisioning',
    label: 'Provisioning',
    renderCell: (version) => (
      <StatusBadge
        label={version.provisioningState ?? 'Unknown'}
        tone={version.provisioningState === 'Succeeded' ? 'ok' : version.provisioningState === 'Failed' ? 'error' : version.provisioningState === undefined ? 'unknown' : 'pending'}
      />
    ),
  },
  { id: 'size', label: 'Size', renderCell: (version) => (version.sizeGib !== undefined ? `${version.sizeGib} GiB` : '—') },
  { id: 'hostCount', label: 'Hosts in this pool (at deploy time)', renderCell: (version) => version.hostCount },
];

function VersionTimelineCard({ versions, unresolvedHosts }: { versions: ImageVersionTimelineEntry[]; unresolvedHosts: Array<{ sessionHostName: string; unknownReason?: string }> }) {
  const styles = useStyles();
  const cardStyles = useCardStyles();

  return (
    <Card className={mergeClasses(cardStyles.card, styles.card)}>
      <CardHeader header={<Text as="h2" size={400} weight="semibold">Version timeline</Text>} description={<Text size={200} className={styles.muted}>Newest first — every published version of the configured image definition</Text>} />
      <DataTable
        ariaLabel="Image version timeline"
        columns={VERSION_COLUMNS}
        rows={versions}
        getRowKey={(version) => version.id || version.name}
        rowAppearance={(version) => (version.isCurrent ? 'brand' : 'none')}
        emptyMessage="The configured image definition has no published versions."
      />
      <Text size={200} className={styles.muted}>
        "Hosts in this pool" reflects each host's VM imageReference as read from Azure just now — the version it was DEPLOYED from, not necessarily what's running inside the VM today (e.g. in-guest updates applied after deployment aren't reflected here).
      </Text>

      {unresolvedHosts.length > 0 && (
        <div>
          <Text size={200} weight="semibold" block>
            Session hosts not attributed to a version above ({unresolvedHosts.length})
          </Text>
          <div className={styles.unresolvedList}>
            {unresolvedHosts.map((host) => (
              <Text key={host.sessionHostName} size={200} className={styles.muted} block>
                {host.sessionHostName}: {host.unknownReason ?? 'unknown source'}
              </Text>
            ))}
          </div>
        </div>
      )}
    </Card>
  );
}

/** Badge + always-visible reason text for one snapshot's orphan status — see the Orphaned/Reason columns below. `orphaned` undefined (scan incomplete) renders a distinct neutral "Unknown" state rather than defaulting to either Orphaned or In use. */
function OrphanBadge({ orphaned }: { orphaned: boolean | undefined }) {
  const label = orphaned === undefined ? 'Unknown' : orphaned ? 'Orphaned' : 'In use';
  const color: BadgeProps['color'] = orphaned === undefined ? 'informative' : orphaned ? 'warning' : 'success';
  return (
    <Badge appearance="tint" color={color} size="small">
      {label}
    </Badge>
  );
}

function SnapshotReportCard({ snapshots, resourceGroupsScanned, scanIncomplete }: { snapshots: ImageSnapshot[]; resourceGroupsScanned: string[]; scanIncomplete: boolean }) {
  const styles = useStyles();
  const cardStyles = useCardStyles();
  const scannedList = resourceGroupsScanned.join(' and ');
  const orphaned = snapshots.filter((s) => s.orphaned === true);
  const orphanedWithCost = orphaned.filter((s) => s.estMonthlyCostUsd !== undefined);
  const orphanedCostTotal = orphanedWithCost.reduce((sum, s) => sum + (s.estMonthlyCostUsd ?? 0), 0);
  const costIsPartial = orphaned.length > orphanedWithCost.length;
  // AM-26 peer review MINOR 12: verb-subject agreement — "N of M snapshots
  // APPEAR/APPEARS orphaned" agrees with N (the count actually appearing
  // orphaned), independent of the "snapshot(s)" noun below it, which
  // agrees with M (the total) instead.
  const appearVerb = orphaned.length === 1 ? 'appears' : 'appear';
  // Peer review (Opus, MINOR 5) — memoized on `styles`: buildSnapshotColumns' whole reason for existing (a function taking styles as a param, rather than a module-level constant) is that it needs Griffel's useStyles output; calling it fresh inline on every render defeated that same purpose by rebuilding the array anyway.
  const snapshotColumns = useMemo(() => buildSnapshotColumns(styles), [styles]);

  return (
    <Card className={mergeClasses(cardStyles.card, styles.card)}>
      <CardHeader
        header={<Text weight="semibold">Snapshot report</Text>}
        description={
          <Text size={200} className={styles.muted}>
            Scanned: {scannedList}
          </Text>
        }
      />

      {scanIncomplete && (
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>Orphan status could not be fully determined</MessageBarTitle>
            The disk data needed to classify snapshots as orphaned/in-use was incomplete for at least one of {scannedList} — see each snapshot's Reason column below. Orphan status is left Unknown rather than guessed.
          </MessageBarBody>
        </MessageBar>
      )}

      {!scanIncomplete && orphaned.length > 0 && (
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>
              {orphaned.length} of {snapshots.length} snapshot{snapshots.length === 1 ? '' : 's'} {appearVerb} orphaned
            </MessageBarTitle>
            Scanned {scannedList}. Estimated combined storage cost: ~${orphanedCostTotal.toFixed(2)}/month{costIsPartial ? ' (partial — some snapshots had no size data)' : ''}. Upper-bound estimate:
            provisioned size × ${APPROX_SNAPSHOT_GIB_MONTHLY_RATE_USD.toFixed(2)}/GiB-month (Standard HDD); Azure bills on used size. See the Reason column below for why each one was flagged.
          </MessageBarBody>
        </MessageBar>
      )}

      <DataTable ariaLabel="Snapshot report" size="small" columns={snapshotColumns} rows={snapshots} getRowKey={(snapshot) => snapshot.id || snapshot.name} emptyMessage="No snapshots found in the scanned resource groups." />
    </Card>
  );
}

/** Column defs need `styles` (Griffel's useStyles, only callable inside a component) for the muted-sku-text and reason-cell classNames — built by a plain function taking the caller's styles rather than a module-level constant. */
function buildSnapshotColumns(styles: ReturnType<typeof useStyles>): DataTableColumn<ImageSnapshot>[] {
  return [
    {
      id: 'name',
      label: 'Name',
      renderCell: (snapshot) => (
        <>
          <Text weight={snapshot.orphaned ? 'semibold' : undefined}>{snapshot.name}</Text>
          {snapshot.sku && (
            <>
              {' '}
              <Text size={200} className={styles.muted}>
                ({snapshot.sku})
              </Text>
            </>
          )}
        </>
      ),
    },
    { id: 'resourceGroup', label: 'Resource group', renderCell: (snapshot) => snapshot.resourceGroup },
    { id: 'created', label: 'Created', renderCell: (snapshot) => formatDateTime(snapshot.createdDate) },
    { id: 'age', label: 'Age', renderCell: (snapshot) => (snapshot.ageDays !== undefined ? `${snapshot.ageDays}d` : '—') },
    { id: 'size', label: 'Size', renderCell: (snapshot) => (snapshot.sizeGib !== undefined ? `${snapshot.sizeGib} GiB` : '—') },
    {
      id: 'estCost',
      label: 'Est. monthly cost',
      header: (
        <div className={styles.columnHeaderRow}>
          <Text>Est. monthly cost</Text>
          <InfoTooltip
            content={`Upper-bound estimate: provisioned size × $${APPROX_SNAPSHOT_GIB_MONTHLY_RATE_USD.toFixed(2)}/GiB-month (Standard HDD); Azure bills on used size, which may be lower.`}
            label="About the monthly cost estimate"
          />
        </div>
      ),
      renderCell: (snapshot) => (snapshot.estMonthlyCostUsd !== undefined ? `~$${snapshot.estMonthlyCostUsd.toFixed(2)}` : '—'),
    },
    { id: 'provisioning', label: 'Provisioning', renderCell: (snapshot) => snapshot.provisioningState ?? '—' },
    { id: 'orphaned', label: 'Orphaned', renderCell: (snapshot) => <OrphanBadge orphaned={snapshot.orphaned} /> },
    { id: 'reason', label: 'Reason', className: styles.reasonCell, renderCell: (snapshot) => <Text size={200}>{snapshot.orphanReason}</Text> },
  ];
}

/** State PageHeader needs, reported up by whichever of Versions/Snapshots is currently mounted — see this file's own doc comment for why the page-level PageHeader can't just call usePolling itself. */
interface HeaderState {
  asOf: Date | undefined;
  refreshing: boolean;
  refresh: () => void;
}

/**
 * Reports `query`'s asOf/refreshing/refresh up to the page-level PageHeader
 * on every change, via an effect (never synchronously during render — this
 * repo's react-hooks/set-state-in-effect rule). Runs the SAME effect shape
 * both VersionsTab and SnapshotsTab need, so neither duplicates it.
 *
 * Peer review MINOR 18 — `query.refresh` is a new closure every render
 * (usePolling doesn't memoize it), which used to need an
 * eslint-disable-next-line react-hooks/exhaustive-deps to keep the effect
 * from re-running on every single render just because that closure's
 * identity changed. `refreshRef` sidesteps that instead of suppressing the
 * lint rule: a dependency-array-free effect keeps it pointed at the LATEST
 * `query.refresh` after every render (this repo's react-hooks/refs rule
 * forbids mutating a ref's `.current` directly in the render body itself,
 * only inside an effect/event handler — see that rule's own message), and
 * the reporting effect below calls through it indirectly, so its own body
 * never references `query.refresh` directly — nothing left for
 * exhaustive-deps to flag as missing there.
 */
function useReportHeaderState(query: PollingState<unknown>, onReady: (state: HeaderState) => void) {
  const refreshRef = useRef(query.refresh);
  useEffect(() => {
    refreshRef.current = query.refresh;
  });

  useEffect(() => {
    onReady({ asOf: query.lastUpdated, refreshing: query.refreshing, refresh: () => refreshRef.current() });
  }, [query.lastUpdated, query.refreshing, onReady]);
}

function VersionsTab({ onReady }: { onReady: (state: HeaderState) => void }) {
  const versions = usePolling(getImageVersions, POLL_INTERVAL_MS);
  useReportHeaderState(versions, onReady);

  return (
    <AsyncState
      loading={versions.loading}
      error={versions.error as Error | undefined}
      data={versions.data}
      asOf={versions.lastUpdated}
      variant="table"
      isEmpty={(data) => data.versions.length === 0}
      emptyMessage="The configured image definition has no published versions."
    >
      {(data) => <VersionTimelineCard versions={data.versions} unresolvedHosts={data.hostCorrelations.filter((c) => !c.imageVersionName)} />}
    </AsyncState>
  );
}

function SnapshotsTab({ onReady }: { onReady: (state: HeaderState) => void }) {
  const snapshots = usePolling(getImageSnapshots, POLL_INTERVAL_MS);
  useReportHeaderState(snapshots, onReady);

  return (
    <AsyncState
      loading={snapshots.loading}
      error={snapshots.error as Error | undefined}
      data={snapshots.data}
      asOf={snapshots.lastUpdated}
      variant="table"
      isEmpty={(data) => data.snapshots.length === 0}
      emptyMessage="No snapshots found in the scanned resource groups."
    >
      {(data) => <SnapshotReportCard snapshots={data.snapshots} resourceGroupsScanned={data.resourceGroupsScanned} scanIncomplete={data.scanIncomplete} />}
    </AsyncState>
  );
}

const TAB_VALUES = ['versions', 'build', 'rollout', 'snapshots'] as const;
type ImagesTab = (typeof TAB_VALUES)[number];

const TAB_LABEL: Record<ImagesTab, string> = {
  versions: 'Versions',
  build: 'Build',
  rollout: 'Rollout',
  snapshots: 'Snapshots',
};

function isImagesTab(value: string | undefined): value is ImagesTab {
  return TAB_VALUES.includes(value as ImagesTab);
}

/**
 * Images — golden image version timeline (AM-16/AM-26), the AM-27 (M4-S2)
 * build orchestration wizard, the AM-28 (M4-S3) staged rollout wizard, and
 * an orphaned-snapshot cost-hygiene report.
 *
 * AM-31 item 32a: these four sections now live on separate Fluent Tabs
 * (Versions / Build / Rollout / Snapshots) instead of stacked on one page —
 * before this, all four polled CONCURRENTLY on every visit (version
 * timeline + snapshot report, each on their own 5-minute cadence, PLUS
 * ImageBuildSection's own 15s/5s builds-list/build-detail polls, PLUS
 * RolloutWizard's own 20s plan poll — four independent polling cadences
 * running at once regardless of which section the operator actually
 * wanted). Only the ACTIVE tab's component now mounts, so switching away
 * from a tab tears down its usePolling instance (and the interval/fetch it
 * was running) entirely — see usePolling's own cleanup behavior.
 *
 * Tab selection lives in the URL (`/images` = Versions, `/images/:tab` for
 * the other three — see App.tsx's two routes for this page) so a deep link
 * or a page refresh lands back on the same tab, not always back on
 * Versions. PageHeader stays page-level (one <h1>, not one per tab) — its
 * asOf/refreshing/onRefresh reflect whichever of Versions/Snapshots is
 * currently mounted (Build/Rollout have always self-managed their own
 * polling with no PageHeader affordance — see useReportHeaderState above).
 */
export default function Images() {
  const styles = useStyles();
  const navigate = useNavigate();
  const tabIdPrefix = useId();
  const { tab: tabParam } = useParams<{ tab?: string }>();
  // Peer review MINOR 5 — an unknown :tab value (a bad/stale deep link) used
  // to silently render the Versions tab's content while leaving the bogus
  // URL sitting in the address bar; `isValidTab` drives a redirect to the
  // canonical /images (Versions) URL instead, applied AFTER every hook below
  // has run (never as an early return before them — this route's :tab can
  // change across re-renders of the SAME mounted instance, and conditionally
  // skipping hooks based on that would violate the rules of hooks). An
  // UNDEFINED tabParam (the plain /images route) is the normal Versions case
  // and is never treated as invalid.
  const isValidTab = tabParam === undefined || isImagesTab(tabParam);
  const activeTab: ImagesTab = isImagesTab(tabParam) ? tabParam : 'versions';

  const [headerState, setHeaderState] = useState<HeaderState | undefined>(undefined);
  // Read ONLY when the tab it describes is actually the active one — Build/
  // Rollout report nothing of their own, and a tab switch away from
  // Versions/Snapshots must not keep showing that tab's now-stale asOf/
  // refresh. This is a plain render-time derivation (not a second piece of
  // state kept in sync via an effect — react-hooks/set-state-in-effect
  // forbids a setState-on-tab-change effect for exactly this), so switching
  // tabs clears it for free: `headerState` itself is left alone (still
  // holds the last real values from whichever tab set it, if any) and
  // simply isn't READ once `activeTab` no longer matches.
  const effectiveHeaderState = activeTab === 'versions' || activeTab === 'snapshots' ? headerState : undefined;

  function handleTabSelect(_event: SelectTabEvent, data: SelectTabData) {
    const next = isImagesTab(data.value as string) ? (data.value as ImagesTab) : 'versions';
    navigate(next === 'versions' ? '/images' : `/images/${next}`);
  }

  if (!isValidTab) {
    return <Navigate to="/images" replace />;
  }

  const activeTabId = `${tabIdPrefix}-tab-${activeTab}`;
  const activeTabPanelId = `${tabIdPrefix}-tabpanel-${activeTab}`;

  return (
    <div className={styles.page}>
      {/* Peer review NIT 20 — the browser tab title now reflects the active sub-tab ("AVD Manager — Images · Build"), not just the page. */}
      <PageHeader title={activeTab === 'versions' ? 'Images' : `Images · ${TAB_LABEL[activeTab]}`} asOf={effectiveHeaderState?.asOf} refreshing={effectiveHeaderState?.refreshing ?? false} onRefresh={effectiveHeaderState?.refresh} />

      <TabList selectedValue={activeTab} onTabSelect={handleTabSelect} aria-label="Images sections">
        {TAB_VALUES.map((tab) => (
          <Tab key={tab} id={`${tabIdPrefix}-tab-${tab}`} aria-controls={`${tabIdPrefix}-tabpanel-${tab}`} value={tab}>
            {TAB_LABEL[tab]}
          </Tab>
        ))}
      </TabList>

      {/* Peer review MINOR 13 — proper tab/tabpanel linkage: an id the active Tab's aria-controls points at, aria-labelledby back to that Tab (replacing the panel's own standalone aria-label), and tabIndex={0} so the panel itself is keyboard-reachable/scrollable independent of its contents. */}
      <div id={activeTabPanelId} className={styles.tabPanel} role="tabpanel" aria-labelledby={activeTabId} tabIndex={0}>
        {activeTab === 'versions' && <VersionsTab onReady={setHeaderState} />}
        {/* AM-27 (M4-S2): golden image build orchestration — deliberately self-contained (own fetching/state); see ImageBuildSection.tsx. */}
        {activeTab === 'build' && <ImageBuildSection />}
        {/* AM-28 (M4-S3): staged rollout + rollback — deliberately self-contained (own fetching/state); see RolloutWizard.tsx. */}
        {activeTab === 'rollout' && <RolloutWizard hostPoolName={HOST_POOL_NAME} />}
        {activeTab === 'snapshots' && <SnapshotsTab onReady={setHeaderState} />}
      </div>
    </div>
  );
}
