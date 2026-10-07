import { useRef, useState } from 'react';
import {
  makeStyles,
  mergeClasses,
  tokens,
  Text,
  Card,
  CardHeader,
  Button,
  Spinner,
  MessageBar,
  MessageBarBody,
  Accordion,
  AccordionItem,
  AccordionHeader,
  AccordionPanel,
  Link,
  Badge,
  Switch,
  type AccordionToggleEventHandler,
} from '@fluentui/react-components';
import { ArrowClockwise20Regular, Warning16Filled } from '@fluentui/react-icons';
import type { GovernanceCheckResult, GovernanceCheckStatus, GovernanceSummary } from '@avdmgr/shared';
import { getGovernance } from '../api/avd';
import { usePolling } from '../hooks/usePolling';
import AsyncState from '../components/AsyncState';
import RoleGate from '../components/RoleGate';
import StatusBadge, { type StatusTone } from '../components/StatusBadge';
import PageHeader from '../components/PageHeader';
import { formatDateTime } from '../lib/format';
import { useCardStyles } from '../styles/shared';

/**
 * Effectively "no auto-poll" (24h — the longest interval usePolling's
 * setInterval can safely take without risking the ~24.8-day browser/Node
 * setTimeout/setInterval delay cap) rather than a real polling cadence: the
 * API's own ~10min server-side cache (app/api/src/services/
 * governanceService.ts) already bounds staleness, and this page's checks
 * are explicitly a "check on demand" surface (the refresh button — see
 * handleRefresh below), not a live dashboard that needs Dashboard.tsx/
 * Monitoring.tsx's 60s cadence.
 */
const GOVERNANCE_POLL_INTERVAL_MS = 24 * 60 * 60 * 1000;

const useStyles = makeStyles({
  page: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXL,
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    flexWrap: 'wrap',
    gap: tokens.spacingHorizontalM,
  },
  headerActions: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalM,
  },
  asOfText: {
    color: tokens.colorNeutralForeground3,
  },
  tiles: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
    gap: tokens.spacingHorizontalL,
  },
  // AM-31 item 39: was a Card, now a Button styled to look like one — Card's
  // root slot can't be polymorphed to a real <button> (see SummaryTiles'
  // own comment), so the button-specific resets below (background/border/
  // font/height/justifyContent) undo Fluent Button's own defaults to match
  // Card's original look.
  tile: {
    padding: tokens.spacingHorizontalL,
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXS,
    alignItems: 'center',
    justifyContent: 'center',
    height: 'auto',
    minHeight: 'auto',
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    fontWeight: tokens.fontWeightRegular,
    ':hover': {
      backgroundColor: tokens.colorNeutralBackground1Hover,
    },
  },
  // Griffel requires longhand border props to stay consistent with `tile`'s
  // own shorthand `border` declaration above — a plain `border` shorthand
  // here (not borderColor/borderWidth) avoids a shorthand/longhand type
  // conflict between the two merged style rules.
  tileActive: {
    border: `2px solid ${tokens.colorBrandStroke1}`,
    backgroundColor: tokens.colorBrandBackground2,
  },
  filterRow: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalM,
    flexWrap: 'wrap',
  },
  expandCollapseRow: {
    display: 'flex',
    justifyContent: 'flex-end',
  },
  tileCountRow: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalXS,
  },
  tileCount: {
    fontSize: tokens.fontSizeHero800,
    fontWeight: tokens.fontWeightBold,
  },
  tileCountFail: {
    color: tokens.colorPaletteRedForeground1,
  },
  checkHeaderRow: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalM,
    flexWrap: 'wrap',
    width: '100%',
  },
  checkTitle: {
    fontWeight: tokens.fontWeightSemibold,
    minWidth: '220px',
  },
  checkSummary: {
    color: tokens.colorNeutralForeground3,
    flex: 1,
    minWidth: '200px',
  },
  evidenceSection: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXS,
    marginBottom: tokens.spacingVerticalS,
  },
  evidenceSectionTitle: {
    fontWeight: tokens.fontWeightSemibold,
  },
  evidenceList: {
    margin: 0,
    paddingLeft: tokens.spacingHorizontalXL,
  },
  evidenceNote: {
    color: tokens.colorNeutralForeground3,
  },
  evidenceRaw: {
    fontFamily: 'ui-monospace, Consolas, monospace',
    fontSize: tokens.fontSizeBase200,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    backgroundColor: tokens.colorNeutralBackground3,
    padding: tokens.spacingHorizontalM,
    borderRadius: tokens.borderRadiusMedium,
    maxHeight: '400px',
    overflow: 'auto',
  },
  links: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXS,
    marginTop: tokens.spacingVerticalS,
  },
  checkedAtText: {
    marginTop: tokens.spacingVerticalS,
    color: tokens.colorNeutralForeground3,
  },
});

const STATUS_TONE: Record<GovernanceCheckStatus, StatusTone> = {
  pass: 'ok',
  warn: 'warning',
  fail: 'error',
  unknown: 'unknown',
};

const STATUS_LABEL: Record<GovernanceCheckStatus, string> = {
  pass: 'Pass',
  warn: 'Warning',
  fail: 'Fail',
  unknown: 'Unknown',
};

/** Groups checks by category, preserving each category's first-seen order (the registry's own order — app/api/src/services/governance/registry.ts) rather than sorting alphabetically, so related checks stay adjacent the way the registry author intended. */
function groupByCategory(checks: GovernanceCheckResult[]): Array<{ category: string; checks: GovernanceCheckResult[] }> {
  const groups: Array<{ category: string; checks: GovernanceCheckResult[] }> = [];
  for (const check of checks) {
    const existing = groups.find((g) => g.category === check.category);
    if (existing) {
      existing.checks.push(check);
    } else {
      groups.push({ category: check.category, checks: [check] });
    }
  }
  return groups;
}

/**
 * AM-31 item 39 — summary tiles are now clickable filters: clicking a tile
 * narrows the check list below to just that status (clicking the already-
 * active tile clears the filter back to "all" — a toggle, not a one-way
 * drill-down). `role="group"` + `aria-label` per tile (peer review item 20)
 * becomes `aria-pressed` on the underlying button once clickable — a screen
 * reader landing mid-page hears both which status each tile is AND whether
 * it's the currently-applied filter. The Fail tile also gets a warning
 * glyph (Warning16Filled) alongside its red color when count > 0 — color
 * alone is not an accessible status cue (peer review item 20).
 */
function SummaryTiles({ counts, activeFilter, onSelect }: { counts: GovernanceSummary['counts']; activeFilter: GovernanceCheckStatus | 'all'; onSelect: (status: GovernanceCheckStatus) => void }) {
  const styles = useStyles();
  const tiles: Array<{ status: GovernanceCheckStatus; label: string }> = [
    { status: 'pass', label: 'Pass' },
    { status: 'warn', label: 'Warn' },
    { status: 'fail', label: 'Fail' },
    { status: 'unknown', label: 'Unknown' },
  ];

  return (
    <div className={styles.tiles}>
      {tiles.map(({ status, label }) => {
        const count = counts[status];
        const isFailWithCount = status === 'fail' && count > 0;
        const isActive = activeFilter === status;
        return (
          // A real <button> (Fluent's Button, not Card — Card's root slot
          // doesn't support an `as="button"` polymorphic override) styled to
          // look like the tile, so click/keyboard activation and
          // aria-pressed all come from native button semantics rather than
          // a hand-rolled role="button" + onKeyDown reimplementation.
          <Button
            key={status}
            appearance="transparent"
            className={mergeClasses(styles.tile, isActive && styles.tileActive)}
            aria-pressed={isActive}
            aria-label={`${label}: ${count} check${count === 1 ? '' : 's'} — click to ${isActive ? 'clear this filter' : 'show only these'}`}
            onClick={() => onSelect(status)}
          >
            <Text size={200}>{label}</Text>
            <div className={styles.tileCountRow}>
              {isFailWithCount && <Warning16Filled aria-hidden="true" color={tokens.colorPaletteRedForeground1} />}
              <Text className={`${styles.tileCount} ${isFailWithCount ? styles.tileCountFail : ''}`}>{count}</Text>
            </div>
          </Button>
        );
      })}
    </div>
  );
}

/** True for the `{ items, totalCount, truncated }` shape support.ts#boundList produces — every governance check's list-style evidence uses this same convention. */
function isBoundListShape(value: unknown): value is { items: unknown[]; totalCount: number; truncated: boolean } {
  return (
    typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as Record<string, unknown>).items) &&
    typeof (value as Record<string, unknown>).totalCount === 'number' &&
    typeof (value as Record<string, unknown>).truncated === 'boolean'
  );
}

/** Humanizes a camelCase evidence key into a section title, e.g. "orphanedSnapshots" -> "Orphaned Snapshots". */
function humanizeKey(key: string): string {
  const spaced = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function stringifyItem(item: unknown): string {
  if (typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean') return String(item);
  if (item && typeof item === 'object' && 'name' in item) {
    const { name, ...rest } = item as Record<string, unknown>;
    const restEntries = Object.entries(rest);
    return restEntries.length === 0 ? String(name) : `${String(name)} (${restEntries.map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join(', ')})`;
  }
  return JSON.stringify(item);
}

/**
 * Renders one `{ items, totalCount, truncated }` evidence entry as a
 * bulleted list (peer review item 20) — the raw-JSON `<pre>` view remains
 * available via the "Show raw JSON" toggle in CheckEvidence below for
 * anything this doesn't cover.
 */
function BoundListSection({ title, value }: { title: string; value: { items: unknown[]; totalCount: number; truncated: boolean } }) {
  const styles = useStyles();
  if (value.totalCount === 0) return null;

  return (
    <div className={styles.evidenceSection}>
      <Text className={styles.evidenceSectionTitle} size={300}>
        {title} ({value.totalCount})
      </Text>
      <ul className={styles.evidenceList}>
        {value.items.map((item, index) => (
          <li key={index}>
            <Text size={200}>{stringifyItem(item)}</Text>
          </li>
        ))}
      </ul>
      {value.totalCount > value.items.length && (
        <Text className={styles.evidenceNote} size={200}>
          + {value.totalCount - value.items.length} more not shown.
        </Text>
      )}
      {value.truncated && (
        <Text className={styles.evidenceNote} size={200}>
          The underlying Azure query hit its result-page limit — this list may be incomplete even beyond the count above.
        </Text>
      )}
    </div>
  );
}

function CheckEvidence({ check }: { check: GovernanceCheckResult }) {
  const styles = useStyles();
  const [showRaw, setShowRaw] = useState(false);

  const boundListEntries = Object.entries(check.evidence).filter(([, value]) => isBoundListShape(value)) as Array<[string, { items: unknown[]; totalCount: number; truncated: boolean }]>;

  return (
    <>
      {boundListEntries.map(([key, value]) => (
        <BoundListSection key={key} title={humanizeKey(key)} value={value} />
      ))}

      <Button appearance="transparent" size="small" onClick={() => setShowRaw((prev) => !prev)}>
        {showRaw ? 'Hide raw evidence' : 'Show raw evidence'}
      </Button>
      {showRaw && (
        <pre className={styles.evidenceRaw} tabIndex={0} aria-label={`Raw evidence for ${check.title}`}>
          {JSON.stringify(check.evidence, null, 2)}
        </pre>
      )}

      {check.links && check.links.length > 0 && (
        <div className={styles.links}>
          {check.links.map((link) => (
            <Link key={link.url} href={link.url} target="_blank" rel="noreferrer">
              {link.label}
            </Link>
          ))}
        </div>
      )}
      <Text size={200} block className={styles.checkedAtText}>
        Checked {formatDateTime(check.checkedAt)}
      </Text>
    </>
  );
}

/**
 * AM-31 item 39 — expand-all/collapse-all + the (possibly status-filtered)
 * check list. `openItems` is ONE flat set of check ids shared across every
 * category's own Accordion instance below — each instance is handed the
 * subset of `openItems` that are actually its own values (Fluent ignores a
 * `value` an Accordion doesn't own, but filtering keeps `data.openItems`
 * from each instance's own onToggle callback meaningful when merged back
 * in) — see handleToggleCategory. Starts fully collapsed, matching this
 * list's pre-item-39 behavior.
 */
function CheckList({ checks }: { checks: GovernanceCheckResult[] }) {
  const styles = useStyles();
  const cardStyles = useCardStyles();
  const grouped = groupByCategory(checks);
  const [openItems, setOpenItems] = useState<string[]>([]);

  const allCheckIds = checks.map((check) => check.id);
  const allExpanded = allCheckIds.length > 0 && allCheckIds.every((id) => openItems.includes(id));

  const handleToggleCategory: (categoryCheckIds: string[]) => AccordionToggleEventHandler<string> = (categoryCheckIds) => (_event, data) => {
    setOpenItems((prev) => [...prev.filter((id) => !categoryCheckIds.includes(id)), ...data.openItems]);
  };

  if (checks.length === 0) {
    return (
      <MessageBar intent="info">
        <MessageBarBody>No checks match the current filter.</MessageBarBody>
      </MessageBar>
    );
  }

  return (
    <div className={styles.page}>
      <div className={styles.expandCollapseRow}>
        <Button appearance="secondary" size="small" onClick={() => setOpenItems(allExpanded ? [] : allCheckIds)}>
          {allExpanded ? 'Collapse all' : 'Expand all'}
        </Button>
      </div>
      {grouped.map((group) => {
        const categoryCheckIds = group.checks.map((check) => check.id);
        return (
          <Card key={group.category} className={cardStyles.card}>
            <CardHeader header={<Text as="h2" size={400} weight="semibold">{group.category}</Text>} />
            <Accordion multiple collapsible openItems={openItems.filter((id) => categoryCheckIds.includes(id))} onToggle={handleToggleCategory(categoryCheckIds)}>
              {group.checks.map((check) => (
                <AccordionItem key={check.id} value={check.id}>
                  <AccordionHeader>
                    <div className={styles.checkHeaderRow}>
                      <StatusBadge label={STATUS_LABEL[check.status]} tone={STATUS_TONE[check.status]} />
                      <Text className={styles.checkTitle}>{check.title}</Text>
                      <Text className={styles.checkSummary} size={200}>
                        {check.summary}
                      </Text>
                    </div>
                  </AccordionHeader>
                  <AccordionPanel>
                    <CheckEvidence check={check} />
                  </AccordionPanel>
                </AccordionItem>
              ))}
            </Accordion>
          </Card>
        );
      })}
    </div>
  );
}

/**
 * Governance — AM-16 (M3b): live production-readiness checklist derived
 * from read-only ARM/Graph calls (see app/api/src/services/governance/*.ts
 * for each check's evidence source). Viewer+ (read-only — this page never
 * mutates anything by itself, but the refresh button DOES trigger a
 * materially more expensive re-run — see the RoleGate around it below, and
 * app/api/src/functions/governance.ts's server-side enforcement of the
 * same operator+ floor, peer review item 10).
 *
 * Built on the SAME usePolling hook every other page uses (Dashboard.tsx,
 * Monitoring.tsx) rather than a hand-rolled fetch effect — reusing its
 * already-correct cancellation/dedupe behavior — but with
 * GOVERNANCE_POLL_INTERVAL_MS set effectively to "no meaningful auto-poll"
 * (see that constant's doc comment): this page's checks are a "check on
 * demand" surface, not a live dashboard. The refresh button below is what's
 * meant to be pressed; `forceRefreshRef` is how it tells the NEXT
 * usePolling fetch to bypass the API's own ~10min cache (?refresh=true) —
 * usePolling's fetcher signature takes no extra arguments, so a ref (read
 * once per fetch, then reset) is how a one-shot flag rides along with its
 * next-tick/next-refresh() call without changing that hook itself.
 */
export default function Governance() {
  const styles = useStyles();
  const forceRefreshRef = useRef(false);
  // AM-31 item 39 — 'all' or one specific status; set by clicking a summary
  // tile OR the "Show failures only" Switch below (the SAME state — the
  // Switch is just a fixed shortcut to the 'fail' tile, not a second,
  // independently-tracked filter that could disagree with the tiles).
  const [statusFilter, setStatusFilter] = useState<GovernanceCheckStatus | 'all'>('all');
  function toggleStatusFilter(status: GovernanceCheckStatus) {
    setStatusFilter((prev) => (prev === status ? 'all' : status));
  }

  const query = usePolling<GovernanceSummary>((signal) => {
    const forceRefresh = forceRefreshRef.current;
    forceRefreshRef.current = false;
    return getGovernance({ forceRefresh, signal });
  }, GOVERNANCE_POLL_INTERVAL_MS);

  function handleRefresh() {
    forceRefreshRef.current = true;
    query.refresh();
  }

  return (
    <div className={styles.page}>
      {/*
       * AM-29 items A/G/11: PageHeader's own refresh icon-button gives
       * EVERY viewer a plain, non-force re-fetch of whatever this endpoint
       * currently has cached — that's just `query.refresh()`, the same
       * "poll again" action the 5-minute interval already does on its own.
       * The FORCE refresh (bypasses the server's ~10min cache, see
       * handleRefresh/forceRefreshRef above) stays its own operator+-gated
       * button in the actions slot — a materially more expensive re-run
       * (see this component's own doc comment above), not something a
       * viewer should be able to trigger.
       */}
      <PageHeader
        title="Governance"
        asOf={query.data ? new Date(query.data.generatedAt) : query.lastUpdated}
        refreshing={query.refreshing}
        onRefresh={() => query.refresh()}
        actions={
          <RoleGate allowed={['operator', 'admin']}>
            <Button icon={query.refreshing ? <Spinner size="tiny" /> : <ArrowClockwise20Regular />} onClick={handleRefresh} disabled={query.refreshing || query.loading}>
              Force refresh
            </Button>
          </RoleGate>
        }
      />
      {query.data?.cached && (
        <Text size={200} className={styles.asOfText}>
          Cached result — use Force refresh (operator+) for a live re-check.
        </Text>
      )}

      <AsyncState loading={query.loading} error={query.error as Error | undefined} data={query.data} isEmpty={(data) => data.checks.length === 0} emptyMessage="No governance checks are registered.">
        {(data) => {
          const filteredChecks = statusFilter === 'all' ? data.checks : data.checks.filter((check) => check.status === statusFilter);
          return (
          <>
            <SummaryTiles counts={data.counts} activeFilter={statusFilter} onSelect={toggleStatusFilter} />
            <div className={styles.filterRow}>
              {/* AM-31 item 39 — a fixed shortcut to the 'fail' tile filter, not a second filter state (see statusFilter's own doc comment). */}
              <Switch label="Show failures only" checked={statusFilter === 'fail'} onChange={(_event, switchData) => setStatusFilter(switchData.checked ? 'fail' : 'all')} />
              {statusFilter !== 'all' && (
                <Button appearance="transparent" size="small" onClick={() => setStatusFilter('all')}>
                  Clear filter
                </Button>
              )}
            </div>
            {data.counts.fail > 0 && (
              <MessageBar intent="error">
                <MessageBarBody>
                  {data.counts.fail} check{data.counts.fail === 1 ? '' : 's'} failed — expand the affected row(s) below for evidence and remediation links.
                </MessageBarBody>
              </MessageBar>
            )}
            {data.counts.unknown > 0 && (
              <MessageBar intent="info">
                <MessageBarBody>
                  {data.counts.unknown} check{data.counts.unknown === 1 ? '' : 's'} could not run — this can mean a missing configuration value, a manual permission handoff not yet completed (see
                  each check's own evidence for exact next steps), or a transient Azure/Graph failure worth retrying.{' '}
                  <Badge appearance="tint" color="informative">
                    Unknown
                  </Badge>{' '}
                  is not the same as a failure.
                </MessageBarBody>
              </MessageBar>
            )}
            <CheckList checks={filteredChecks} />
          </>
          );
        }}
      </AsyncState>
    </div>
  );
}
