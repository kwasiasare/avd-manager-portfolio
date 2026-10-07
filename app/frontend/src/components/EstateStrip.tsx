import { Link, useLocation, useNavigate } from 'react-router-dom';
import { makeStyles, mergeClasses, tokens, Text, Button, Tooltip, Spinner } from '@fluentui/react-components';
import { ArrowClockwise16Regular, Circle12Filled, History16Regular, Warning16Regular } from '@fluentui/react-icons';
import { getEstateSummary } from '../api/avd';
import { usePolling } from '../hooks/usePolling';
import { formatTime } from '../lib/format';
import RoleGate from './RoleGate';
import ThemeToggle from './ThemeToggle';
import { STATIC_OK, STATIC_WARNING } from '../theme/palette';

const POLL_INTERVAL_MS = 60_000;

const useStyles = makeStyles({
  strip: {
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: tokens.spacingHorizontalM,
    padding: `${tokens.spacingVerticalSNudge} ${tokens.spacingHorizontalXXL}`,
    // AM-29 item 26: a fixed dark surface regardless of the active theme
    // (colorNeutralBackgroundStatic / colorNeutralForegroundStaticInverted
    // are Fluent's documented pairing for exactly this — a background that
    // does NOT flip with light/dark mode, paired with text guaranteed to
    // stay legible against it) — the estate strip reads as one consistent
    // "status bar" surface rather than blending into the page canvas
    // beneath it in either theme.
    backgroundColor: tokens.colorNeutralBackgroundStatic,
    color: tokens.colorNeutralForegroundStaticInverted,
  },
  // AM-68 review fix (Fable, MAJOR): the strip is a FIXED deep-navy surface
  // in both themes, so its status inks must be fixed too — the theme-relative
  // colorPaletteGreen/MarigoldForeground1 tokens resolve to the LIGHT
  // palette's dark inks in light mode (amber #7A5900 measured ~2.5:1 on the
  // navy strip; the "Incident" warning label below was near-invisible).
  // STATIC_OK / STATIC_WARNING are the dark palette's inks pinned for static
  // surfaces (see palette.ts; >= 9:1 on both static backgrounds).
  dot: {
    display: 'flex',
    alignItems: 'center',
    color: STATIC_OK,
  },
  dotAmber: {
    color: STATIC_WARNING,
  },
  segment: {
    color: 'inherit',
    textDecorationLine: 'none',
    whiteSpace: 'nowrap',
    ':hover': {
      textDecorationLine: 'underline',
    },
    ':focus-visible': {
      outline: `2px solid ${tokens.colorNeutralForegroundStaticInverted}`,
      outlineOffset: '2px',
      borderRadius: tokens.borderRadiusSmall,
    },
  },
  separator: {
    color: tokens.colorNeutralForegroundStaticInverted,
    opacity: 0.5,
  },
  // Peer review NIT (Opus) — colorPaletteMarigoldForeground1 paired with
  // colorPaletteMarigoldBackground2 measures ~2.08:1 contrast in light
  // theme (fails WCAG AA's 3:1 floor even for large/graphical text) and a
  // borderline ~3.76:1 in dark theme (still fails the 4.5:1 normal-text
  // bar) — Fluent's palette tokens pair by MATCHING index (Foreground2 with
  // Background2), not Foreground1 with Background2; Foreground2 measures a
  // consistent ~4.77:1 against Background2 in BOTH themes. (The strip's
  // amber dot, by contrast, pairs Foreground1 against the STATIC
  // colorNeutralBackgroundStatic and was already fine — 4.78:1 light /
  // 6.74:1 dark — so only this pill needed the swap.)
  overridePill: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalXXS,
    padding: `0 ${tokens.spacingHorizontalS}`,
    borderRadius: tokens.borderRadiusCircular,
    backgroundColor: tokens.colorPaletteMarigoldBackground2,
    color: tokens.colorPaletteMarigoldForeground2,
    fontWeight: tokens.fontWeightSemibold,
  },
  spacer: {
    flex: 1,
  },
  asOf: {
    color: 'inherit',
    opacity: 0.75,
  },
  // Peer review (Opus, MINOR item 11): a dotted underline + help cursor —
  // the same "there's more here on hover/focus" affordance a native title
  // attribute gives, but via Fluent's own Tooltip so it matches this app's
  // existing pattern (and is keyboard-reachable, unlike a bare title attr).
  asOfError: {
    textDecorationLine: 'underline',
    textDecorationStyle: 'dotted',
    textUnderlineOffset: '2px',
    cursor: 'help',
  },
  // AM-34 peer review (Opus, MAJOR 3) — the "Incident" entry-point toggle.
  // `color: 'inherit'` was replaced with the EXPLICIT static-inverted
  // foreground token everywhere below: this strip is a FIXED dark surface
  // in BOTH themes (see the strip's own doc comment above), so a "just
  // inherit" default is fine at rest, but `incidentToggleActive` below
  // needs its OWN explicit foreground once it also sets a background —
  // relying on inherit there would silently break the moment anything
  // between this button and the strip's own color declaration ever
  // resolves a class in a different order.
  //
  // `incidentToggleActive`'s background was originally
  // `colorNeutralBackground1Hover` — a THEME-RELATIVE token, wrong for a
  // surface that's fixed dark in both themes: in light mode it resolves to
  // a near-white tile (white-on-white against the equally static-inverted
  // near-white foreground, ~1.09:1) and in dark mode it can equal
  // `colorNeutralBackgroundStatic` itself (the highlight is then
  // literally invisible — same color as the surface behind it). A literal
  // white-alpha tint, defined relative to the static surface's own base
  // color rather than the active theme, is the correct fixed-surface
  // analogue of a hover/pressed highlight here — safe as a makeStyles
  // literal specifically BECAUSE this surface never changes with theme.
  //
  // `incidentToggleWarning` reuses the exact STATIC_WARNING-against-
  // colorNeutralBackgroundStatic pairing the strip's own amber status dot
  // already relies on (AM-68: >= 9:1 in both themes — see dotAmber's own
  // comment above and contrast.test.ts).
  //
  // `incidentToggleActiveWarning` is its OWN variant, not a merge of the
  // two above: stacking the white-alpha tint underneath
  // colorPaletteMarigoldForeground1 measured ~2.42:1 (the tint lightens
  // the effective background enough to undercut that pairing's own
  // verified ratio). Reuses this SAME file's already-verified
  // colorPaletteMarigoldBackground2/colorPaletteMarigoldForeground2 pill
  // pairing instead (see overridePill's own comment above — ~4.77:1 in
  // BOTH themes), rather than inventing a new, unverified combination.
  // incidentToggleClassName below picks exactly ONE of these four variants
  // per render (never merges two conflicting color/background rules), so
  // there is no class-order ambiguity to worry about.
  incidentToggle: {
    color: tokens.colorNeutralForegroundStaticInverted,
  },
  incidentToggleActive: {
    backgroundColor: 'rgba(255, 255, 255, 0.16)',
    color: tokens.colorNeutralForegroundStaticInverted,
  },
  incidentToggleWarning: {
    color: STATIC_WARNING,
  },
  incidentToggleActiveWarning: {
    backgroundColor: tokens.colorPaletteMarigoldBackground2,
    color: tokens.colorPaletteMarigoldForeground2,
  },
});

/** See the incidentToggle* styles' own doc comment for why this picks exactly one variant rather than merging two potentially-conflicting classes. */
function incidentToggleClassName(styles: ReturnType<typeof useStyles>, active: boolean, warning: boolean): string {
  if (active && warning) return mergeClasses(styles.incidentToggle, styles.incidentToggleActiveWarning);
  if (active) return mergeClasses(styles.incidentToggle, styles.incidentToggleActive);
  if (warning) return mergeClasses(styles.incidentToggle, styles.incidentToggleWarning);
  return styles.incidentToggle;
}

function Segment({ to, children }: { to: string; children: React.ReactNode }) {
  const styles = useStyles();
  return (
    <Link to={to} className={styles.segment}>
      {children}
    </Link>
  );
}

/**
 * AM-29 item 26 — a persistent estate-at-a-glance strip, shown above the
 * page outlet on every route (see Layout.tsx). Polls GET /v1/estate/summary
 * (viewer+, see app/api/src/functions/estateSummary.ts) every 60s,
 * visibility-gated (usePolling — AM-29 item 6). Every segment DEGRADES
 * independently: EstateSummaryResponse's fields are individually optional
 * (see app/shared/src/index.ts), and a missing field renders "—" here
 * rather than blanking the whole strip or hiding the segment entirely — an
 * operator should always see the FULL set of segments, even if one
 * currently has no data.
 */
/**
 * AM-32 (M8-W3): `onOpenRecentActions` (when supplied — Layout.tsx always
 * supplies it) wires the History icon-button next to the refresh button to
 * the shared "Recent actions" drawer state Layout owns (the same state
 * CommandPalette's own "Recent actions" action opens, so both entry points
 * open the SAME drawer instance rather than each maintaining their own).
 * RoleGate'd to operator+ — GET /v1/audit/recent is operator+ only (audit
 * rows carry actor identities), so a viewer never sees a button that would
 * just 403 for them.
 */
export default function EstateStrip({ onOpenRecentActions }: { onOpenRecentActions?: () => void }) {
  const styles = useStyles();
  const navigate = useNavigate();
  const location = useLocation();
  const estate = usePolling(getEstateSummary, POLL_INTERVAL_MS);
  const data = estate.data;

  const hostsAmber = data?.hosts !== undefined && data.hosts.available < data.hosts.total;
  const alertsAmber = data?.openAlertCount !== undefined && data.openAlertCount > 0;
  const isAmber = hostsAmber || alertsAmber;

  // AM-34 (M8-W5, D6) — a real toggle, not just a one-way navigation link:
  // clicking it from anywhere else enters Incident mode; clicking it again
  // FROM /incident exits back to the Dashboard (the same destination
  // Incident.tsx's own "Exit incident mode" PageHeader action uses — see
  // that page). `alertsAmber` (not the combined `isAmber`, which also
  // reacts to a hosts shortfall) is this button's own warning trigger — see
  // its own doc comment below.
  const onIncidentPage = location.pathname === '/incident';

  return (
    <div className={styles.strip} role="region" aria-label="Estate status">
      <span className={`${styles.dot} ${isAmber ? styles.dotAmber : ''}`} aria-hidden="true">
        <Circle12Filled />
      </span>

      <Segment to="/host-pools">
        <Text size={200}>Hosts {data?.hosts ? `${data.hosts.available}/${data.hosts.total}` : '—'}</Text>
      </Segment>
      <span className={styles.separator} aria-hidden="true">
        ·
      </span>

      <Segment to="/sessions">
        <Text size={200}>Sessions {data?.sessions ? `${data.sessions.used}/${data.sessions.capacity}` : '—'}</Text>
      </Segment>
      <span className={styles.separator} aria-hidden="true">
        ·
      </span>

      {/* AM-31 item 32b: Cost & Scaling split into two pages — the phase segment points at the scaling half. */}
      <Segment to="/scaling">
        <Text size={200}>{data?.scalingPhase ?? '—'}</Text>
      </Segment>
      <span className={styles.separator} aria-hidden="true">
        ·
      </span>

      <Segment to="/monitoring">
        <Text size={200}>{data?.openAlertCount !== undefined ? `${data.openAlertCount} open alert${data.openAlertCount === 1 ? '' : 's'}` : 'Alerts —'}</Text>
      </Segment>

      {data?.overrideActive && (
        <Segment to="/scaling">
          <span className={styles.overridePill}>Override active</span>
        </Segment>
      )}

      <span className={styles.spacer} />

      {/* AM-34 (M8-W5, D6) — the Incident mode entry point (mockup exhibit
          D on AM-29): operator+ only (RoleGate — Incident.tsx's own content
          gate mirrors this, same "UI convenience, page still gates itself"
          pattern every RoleGate in this app follows), right side, before
          the theme toggle per this item's own placement requirement. Tone
          shifts to warning when there's at least one open alert
          (alertsAmber, computed above) — the same signal the strip's own
          amber status dot already reacts to for the alerts segment — so an
          operator sees "there's something to look at" before ever clicking
          in. loadingFallback={null}, matching the History button just below:
          the button simply isn't there yet while the role resolves, rather
          than visibly loading in on this fixed dark surface. */}
      <RoleGate allowed={['operator', 'admin']} loadingFallback={null}>
        {/* AM-34 peer review NIT — no separate aria-label: Tooltip's
            relationship="label" already supplies this button's accessible
            name (via aria-labelledby, overriding the plain visible
            "Incident" text with the fuller "Enter/Exit incident mode"
            wording) — a second, identical aria-label here was pure
            redundancy. */}
        <Tooltip content={onIncidentPage ? 'Exit incident mode' : 'Enter incident mode'} relationship="label">
          <Button
            appearance="transparent"
            size="small"
            icon={<Warning16Regular />}
            onClick={() => navigate(onIncidentPage ? '/' : '/incident')}
            aria-pressed={onIncidentPage}
            className={incidentToggleClassName(styles, onIncidentPage, alertsAmber)}
          >
            Incident
          </Button>
        </Tooltip>
      </RoleGate>

      {/* AM-29 user direction 2026-08-16: the theme toggle sits here, at the
          top of every page immediately before "As of …" (relocated from the
          identity menu — see ThemeToggle.tsx). */}
      <ThemeToggle />

      {estate.refreshing && <Spinner size="tiny" appearance="inverted" />}
      {/* Peer review (Opus, MINOR item 11): estate.error was previously
          never surfaced — a failed poll leaves usePolling's last-good
          `data` in place (see that hook's own doc comment), so the strip
          kept showing an "As of" instant with no hint it was now stale.
          Unobtrusive by design: same text, just a dotted-underline +
          tooltip affordance, not a banner or a changed color that would
          fight the strip's existing amber "attention" signal. */}
      {estate.error ? (
        <Tooltip content="Last refresh failed — showing older data." relationship="label">
          <Text size={200} className={mergeClasses(styles.asOf, styles.asOfError)} tabIndex={0}>
            As of {data ? formatTime(new Date(data.generatedAt)) : '—'}
          </Text>
        </Tooltip>
      ) : (
        <Text size={200} className={styles.asOf}>
          As of {data ? formatTime(new Date(data.generatedAt)) : '—'}
        </Text>
      )}
      {onOpenRecentActions && (
        // AM-32 peer review NIT 21: loadingFallback={null} — RoleGate's
        // default loading fallback is a small Skeleton box, which looked
        // like a stray loading placeholder sitting in the fixed dark
        // estate strip (a "status bar" surface, not a content area where a
        // skeleton reads as expected) for the brief window before the
        // role resolves. The button simply isn't there yet, same as a
        // viewer's "never shows up" case, rather than visibly loading in.
        <RoleGate allowed={['operator', 'admin']} loadingFallback={null}>
          <Tooltip content="Recent actions" relationship="label">
            <Button
              appearance="transparent"
              size="small"
              icon={<History16Regular />}
              onClick={onOpenRecentActions}
              aria-label="Recent actions"
              style={{ color: 'inherit', minWidth: 'auto' }}
            />
          </Tooltip>
        </RoleGate>
      )}
      <Tooltip content="Refresh estate status" relationship="label">
        <Button
          appearance="transparent"
          size="small"
          icon={<ArrowClockwise16Regular />}
          onClick={() => estate.refresh()}
          disabled={estate.refreshing}
          aria-label="Refresh estate status"
          style={{ color: 'inherit', minWidth: 'auto' }}
        />
      </Tooltip>
    </div>
  );
}
