import type { MouseEvent } from 'react';
import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import {
  makeStyles,
  mergeClasses,
  tokens,
  NavDrawer,
  NavDrawerHeader,
  NavDrawerBody,
  NavItem,
  NavSectionHeader,
  Text,
  Menu,
  MenuTrigger,
  MenuPopover,
  MenuList,
  MenuItem,
  MenuDivider,
  Badge,
  Toaster,
  Button,
  Tooltip,
  Skeleton,
  SkeletonItem,
} from '@fluentui/react-components';
import {
  Board20Regular,
  Board20Filled,
  Desktop20Regular,
  Desktop20Filled,
  PeopleTeam20Regular,
  PeopleTeam20Filled,
  Image20Regular,
  Image20Filled,
  Gauge20Regular,
  Gauge20Filled,
  MoneySettings20Regular,
  MoneySettings20Filled,
  PersonAccounts20Regular,
  PersonAccounts20Filled,
  FolderPerson20Regular,
  FolderPerson20Filled,
  PulseSquare20Regular,
  PulseSquare20Filled,
  ShieldCheckmark20Regular,
  ShieldCheckmark20Filled,
  DocumentBulletList20Regular,
  DocumentBulletList20Filled,
  Settings20Regular,
  Settings20Filled,
  PersonCircle24Regular,
  SignOut20Regular,
  Navigation20Regular,
  PanelLeftContract20Regular,
  PanelLeftExpand20Regular,
  Dismiss24Regular,
  bundleIcon,
  type FluentIcon,
} from '@fluentui/react-icons';
import { useAuth } from '../auth/useAuth';
import { useVisuallyHiddenStyles } from '../styles/shared';
import { useViewportWidth } from '../hooks/useViewportWidth';
import { useKeyboardShortcuts } from '../hooks/useKeyboardShortcuts';
import { readStoredNavCollapsed, writeStoredNavCollapsed } from '../lib/navCollapse';
import { TOASTER_ID } from '../lib/toaster';
import DevPreviewBanner from './DevPreviewBanner';
import EstateStrip from './EstateStrip';
import NoRoleScreen from './NoRoleScreen';
import { ColdStartHintProvider } from './ColdStartHintProvider';
import KeyboardShortcutsHelpDialog from './KeyboardShortcutsHelpDialog';
import CommandPalette from './CommandPalette';
import RecentActionsDrawer from './RecentActionsDrawer';

/**
 * AM-31 item 34 — responsive nav breakpoints. Below OVERLAY_BREAKPOINT_PX
 * the permanent NavDrawer becomes a Fluent 'overlay' drawer (closed by
 * default, opened via the hamburger button in the mobile top bar — see
 * MobileTopBar below); between that and RAIL_BREAKPOINT_PX it stays
 * permanent/inline but collapses to an icon-only rail; at or above
 * RAIL_BREAKPOINT_PX it's the full labelled nav UNLESS the operator has
 * manually collapsed it (see the hamburger toggle in NavDrawerHeader,
 * persisted via lib/navCollapse.ts the same way theme mode is).
 */
const RAIL_BREAKPOINT_PX = 1000;
const OVERLAY_BREAKPOINT_PX = 700;
type NavDisplayMode = 'full' | 'rail' | 'overlay';

const DashboardIcon = bundleIcon(Board20Filled, Board20Regular);
const HostPoolIcon = bundleIcon(Desktop20Filled, Desktop20Regular);
const SessionsIcon = bundleIcon(PeopleTeam20Filled, PeopleTeam20Regular);
const ImagesIcon = bundleIcon(Image20Filled, Image20Regular);
const ScalingIcon = bundleIcon(Gauge20Filled, Gauge20Regular);
const CostIcon = bundleIcon(MoneySettings20Filled, MoneySettings20Regular);
const UsersIcon = bundleIcon(PersonAccounts20Filled, PersonAccounts20Regular);
const ProfilesIcon = bundleIcon(FolderPerson20Filled, FolderPerson20Regular);
const MonitoringIcon = bundleIcon(PulseSquare20Filled, PulseSquare20Regular);
const GovernanceIcon = bundleIcon(ShieldCheckmark20Filled, ShieldCheckmark20Regular);
const AuditIcon = bundleIcon(DocumentBulletList20Filled, DocumentBulletList20Regular);
const SettingsIcon = bundleIcon(Settings20Filled, Settings20Regular);

interface NavItemDef {
  to: string;
  label: string;
  icon: FluentIcon;
}

/**
 * AM-29 item 8 — grouped nav (Operate / Plan / Administer), rendered via
 * Fluent's NavSectionHeader between each group's NavItems.
 *
 * AM-32 (M8-W3): the Audit item (formerly AuditSettings.tsx, a placeholder
 * with nothing for a user to action — see that AM-29 item 8 backlog note
 * this now closes) is RESTORED here, in Administer, before Settings — GET
 * /v1/audit/recent now backs a real filterable page (Audit.tsx). Points at
 * the clean `/audit` route (App.tsx also keeps `/audit-settings` as a deep-
 * link alias to the same page, for any bookmark to the old placeholder
 * URL). Not role-gated at the nav-item level (same convention every other
 * item here follows, including operator+-only pages like Settings/
 * Governance's own admin-only edit affordances) — Audit.tsx itself
 * RoleGate's its content and shows a viewer an explanatory fallback instead
 * of hiding the nav entry outright.
 */
const NAV_GROUPS: Array<{ label: string; items: NavItemDef[] }> = [
  {
    label: 'Operate',
    items: [
      { to: '/', label: 'Dashboard', icon: DashboardIcon },
      { to: '/host-pools', label: 'Host Pool', icon: HostPoolIcon },
      { to: '/sessions', label: 'Sessions', icon: SessionsIcon },
      { to: '/monitoring', label: 'Monitoring', icon: MonitoringIcon },
    ],
  },
  {
    label: 'Plan',
    items: [
      { to: '/images', label: 'Images', icon: ImagesIcon },
      { to: '/scaling', label: 'Scaling', icon: ScalingIcon },
      { to: '/cost', label: 'Cost', icon: CostIcon },
    ],
  },
  {
    label: 'Administer',
    items: [
      { to: '/users-access', label: 'Users & Access', icon: UsersIcon },
      { to: '/profiles', label: 'Profiles', icon: ProfilesIcon },
      { to: '/governance', label: 'Governance', icon: GovernanceIcon },
      { to: '/audit', label: 'Audit', icon: AuditIcon },
      { to: '/settings', label: 'Settings', icon: SettingsIcon },
    ],
  },
];

const NAV_ITEMS: NavItemDef[] = NAV_GROUPS.flatMap((group) => group.items);

/**
 * Peer review MINOR fix: sorted longest-`to`-first so selectedValue's
 * `.find()` below checks the most SPECIFIC path first — `startsWith`
 * matching is otherwise fragile to declaration order (e.g. a hypothetical
 * future '/audit' item would need to be declared AFTER '/audit-settings',
 * or it would incorrectly win the match for '/audit-settings' too; sorting
 * removes that ordering trap entirely rather than relying on NAV_ITEMS
 * happening to already be listed most-specific-last).
 */
const NAV_ITEMS_BY_SPECIFICITY = [...NAV_ITEMS].sort((a, b) => b.to.length - a.to.length);

const useStyles = makeStyles({
  layout: {
    display: 'flex',
    width: '100%',
    minHeight: '100vh',
  },
  contentColumn: {
    flex: 1,
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
  },
  content: {
    flex: 1,
    minWidth: 0,
    padding: `${tokens.spacingVerticalXXL} ${tokens.spacingHorizontalXXL}`,
    maxWidth: '1280px',
    // AM-29 item 3: the page canvas is now visibly distinct from the Cards
    // sitting on top of it, in both themes — previously both used the same
    // background, so every Card blended straight into the page.
    backgroundColor: tokens.colorNeutralBackground2,
    // Avoids a hairline seam where the strip/content meet — colorNeutralBackground2
    // is applied to the whole scrollable column, not just the padded content box.
    width: '100%',
    boxSizing: 'border-box',
    ':focus': {
      outline: 'none',
    },
  },
  brand: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: tokens.spacingHorizontalS,
    padding: `${tokens.spacingVerticalM} ${tokens.spacingHorizontalM}`,
  },
  identityRow: {
    padding: `0 ${tokens.spacingHorizontalM} ${tokens.spacingVerticalM}`,
  },
  identityTrigger: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    width: '100%',
    justifyContent: 'flex-start',
    textAlign: 'left',
  },
  identityText: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    minWidth: 0,
    overflow: 'hidden',
  },
  identityName: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    maxWidth: '160px',
  },
  /**
   * AM-29 item 4 — visually hidden until keyboard-focused: a sighted mouse
   * user never sees this; a keyboard user tabbing from the top of the page
   * sees it FIRST and can jump straight past the whole nav drawer to the
   * page content.
   */
  skipLink: {
    position: 'absolute',
    left: '-9999px',
    top: 0,
    zIndex: 1000,
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
    backgroundColor: tokens.colorNeutralBackground1,
    color: tokens.colorNeutralForeground1,
    borderRadius: tokens.borderRadiusMedium,
    boxShadow: tokens.shadow16,
    ':focus': {
      left: tokens.spacingHorizontalM,
      top: tokens.spacingVerticalM,
    },
  },
  // AM-31 item 34 — icon-only rail width, narrow enough to still fit a
  // 20px icon + comfortable padding, wide enough to stay a legitimate
  // touch/click target.
  navRail: {
    width: '64px',
  },
  navRailBrandRow: {
    justifyContent: 'center',
  },
  // The manual-collapse/close-navigation button sits in the SAME row as the
  // brand text in full/overlay mode; in rail mode it's the only thing that
  // row has room for.
  navHeaderActions: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalXXS,
  },
  // AM-31 item 34 — shown only below OVERLAY_BREAKPOINT_PX, where the
  // NavDrawer itself is closed by default (Fluent 'overlay' type) and needs
  // an always-visible trigger to open it. EstateStrip stays visible below
  // this bar in every mode, including overlay (per this item's own
  // requirement) — this bar is ADDITIONAL, not a replacement for it.
  mobileTopBar: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
  },
});

/**
 * AM-29 items 9/U1/U2 — the identity area: display name/UPN, a role Badge,
 * and a menu with a Settings link and Sign out. The theme toggle that
 * originally lived in this menu moved to the EstateStrip (user direction
 * 2026-08-16 — see components/ThemeToggle.tsx); Settings' Appearance card
 * remains the second surface for the same shared theme state.
 *
 * AM-31 item 34: `compact` (icon-rail mode) hides the visible name/role
 * text — there's no room for it in a 64px rail — and moves that same
 * information onto the trigger button's `aria-label` instead, so a
 * keyboard/screen-reader user loses nothing.
 */
function IdentityMenu({ userDetails, role, compact = false }: { userDetails: string | null; role: string | null; compact?: boolean }) {
  const styles = useStyles();
  const navigate = useNavigate();

  const identityLabel = `${userDetails ?? 'Signed in'}${role ? ` (${role})` : ''}`;

  return (
    <div className={styles.identityRow}>
      <Menu>
        <MenuTrigger disableButtonEnhancement>
          <Button appearance="subtle" className={styles.identityTrigger} icon={<PersonCircle24Regular />} aria-label={compact ? identityLabel : undefined}>
            {!compact && (
              <span className={styles.identityText}>
                <Text size={200} weight="semibold" className={styles.identityName}>
                  {userDetails ?? 'Signed in'}
                </Text>
                {role && (
                  <Badge appearance="tint" color={role === 'admin' ? 'danger' : role === 'operator' ? 'brand' : 'informative'} size="small">
                    {role}
                  </Badge>
                )}
              </span>
            )}
          </Button>
        </MenuTrigger>
        <MenuPopover>
          <MenuList>
            <MenuItem icon={<Settings20Regular />} onClick={() => navigate('/settings')}>
              Settings
            </MenuItem>
            <MenuDivider />
            {/*
             * AM-29 U1: SWA Easy Auth logout must be a FULL page navigation
             * (it's a server route SWA intercepts, not an SPA route react-router
             * knows about) — window.location.assign, not navigate(), same
             * convention api/client.ts already uses for the expired-session
             * redirect to /.auth/login/aad.
             */}
            <MenuItem icon={<SignOut20Regular />} onClick={() => window.location.assign('/.auth/logout')}>
              Sign out
            </MenuItem>
          </MenuList>
        </MenuPopover>
      </Menu>
    </div>
  );
}

/**
 * App shell: a permanent (inline) Fluent NavDrawer on the left, an
 * always-visible EstateStrip (AM-29 item 26), and routed page content on
 * the right. `selectedValue` is derived from the current location so
 * browser back/forward and direct links keep the nav in sync, rather than
 * NavDrawer tracking selection state independently.
 *
 * AM-29 item 7: authenticated-but-no-role users see NoRoleScreen INSTEAD of
 * the nav/EstateStrip/Outlet — this must happen here, before <Outlet />
 * ever renders a page component, so no page's usePolling/useSingleFetch
 * data fetch ever fires for a user with no role to see that data with.
 */
export default function Layout() {
  const styles = useStyles();
  const visuallyHiddenStyles = useVisuallyHiddenStyles();
  const navigate = useNavigate();
  const currentLocation = useLocation();
  const auth = useAuth();
  const mainRef = useRef<HTMLElement>(null);
  const [routeAnnouncement, setRouteAnnouncement] = useState('');
  const isFirstRender = useRef(true);

  // AM-31 item 34 — responsive nav: viewport width picks between full/rail/
  // overlay (see RAIL_BREAKPOINT_PX/OVERLAY_BREAKPOINT_PX above);
  // `manualCollapsed` is the operator's own persisted override, meaningful
  // only at full-width viewports (a narrow/overlay viewport is ALREADY
  // collapsed automatically — the manual toggle there would have nothing
  // to add). `overlayOpen` is deliberately NOT persisted — a drawer
  // reopening itself on every page load at phone width would be surprising.
  const viewportWidth = useViewportWidth();
  const [manualCollapsed, setManualCollapsed] = useState(readStoredNavCollapsed);
  const [overlayOpen, setOverlayOpen] = useState(false);

  const navMode: NavDisplayMode = viewportWidth < OVERLAY_BREAKPOINT_PX ? 'overlay' : viewportWidth < RAIL_BREAKPOINT_PX ? 'rail' : manualCollapsed ? 'rail' : 'full';
  const isRailMode = navMode === 'rail';

  function toggleManualCollapsed() {
    setManualCollapsed((prev) => {
      const next = !prev;
      writeStoredNavCollapsed(next);
      return next;
    });
  }

  // AM-31 items 36/45 — the app-wide shortcut listener (g-prefixed nav
  // chords, r/refresh, //search, ?/help, Ctrl/Cmd+K/command palette),
  // mounted once here.
  const [shortcutsHelpOpen, setShortcutsHelpOpen] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  // AM-32 (M8-W3) — shared "Recent actions" drawer state: both the History
  // icon-button in EstateStrip and CommandPalette's "Recent actions" action
  // open the SAME drawer instance via this one flag, rather than each
  // owning its own.
  const [recentActionsOpen, setRecentActionsOpen] = useState(false);
  // Peer review MINOR 8 — useCallback keeps these two callbacks
  // referentially stable across renders; useKeyboardShortcuts' own effect is
  // keyed on `[navigate, openHelp, openCommandPalette]` (see that hook), so
  // passing new inline closures here on EVERY Layout render (which happens
  // often — every route change, every viewport resize, etc.) used to tear
  // down and recreate the app-wide document keydown listener that often too.
  const openShortcutsHelp = useCallback(() => setShortcutsHelpOpen(true), []);
  const openCommandPalette = useCallback(() => setCommandPaletteOpen(true), []);
  const openRecentActions = useCallback(() => setRecentActionsOpen(true), []);
  useKeyboardShortcuts(navigate, openShortcutsHelp, openCommandPalette);

  // Peer review MINOR fix: no longer falls back to '/' when nothing matches
  // (e.g. NotFound.tsx's catch-all route) — that fallback made the 404 page
  // incorrectly highlight "Dashboard" in the nav, which is actively
  // misleading (the user is NOT on the Dashboard). `undefined` tells
  // NavDrawer nothing is selected, which is the honest state here.
  const selectedValue = NAV_ITEMS_BY_SPECIFICITY.find((item) => (item.to === '/' ? currentLocation.pathname === '/' : currentLocation.pathname.startsWith(item.to)))?.to;

  /**
   * NavItem renders its root as an `<a href>`, which would do a full page
   * reload on click — so a plain primary click is intercepted and routed
   * through SPA navigation instead. Modifier/middle clicks (ctrl/cmd+click,
   * middle-click) are left to the browser so "open in new tab" gestures
   * keep working.
   *
   * IMPORTANT (found live 2026-08-15, "nav item does nothing"): navigation
   * must happen HERE, in the click handler — NOT via NavDrawer's
   * onNavItemSelect. Passing a custom onClick to NavItem replaces the slot
   * handler Fluent uses internally to raise its select event, so
   * onNavItemSelect never fires; with preventDefault() also swallowing the
   * native link, every nav click became a no-op. Direct URLs still worked,
   * which is why this survived until someone actually clicked the sidebar.
   *
   * AM-31 item 34: this fix must keep working in EVERY nav display mode
   * (full/rail/overlay) — it's unchanged by the responsive rework below,
   * still the ONE place a nav click is handled regardless of mode. The
   * overlay-close (harmless no-op outside overlay mode) is the only
   * addition: an overlay drawer that stayed open after navigating away
   * would just be in the user's way on the page they navigated TO.
   */
  function handleNavItemClick(event: MouseEvent<HTMLAnchorElement | HTMLButtonElement>, to: string) {
    if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.button === 1) {
      return;
    }
    event.preventDefault();
    navigate(to);
    setOverlayOpen(false);
  }

  // AM-29 item 4: on every route change, move focus to <main> (so a
  // keyboard/screen-reader user lands where the new page's content starts,
  // rather than staying wherever focus was on the PREVIOUS page — e.g. a
  // nav link that may no longer even exist in the same position) and
  // announce the new page's title via a polite live region. Skipped on the
  // very first render — that's an initial load, not a "navigation", and
  // stealing focus from the page before the user has interacted with
  // anything yet would be disorienting rather than helpful.
  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }
    mainRef.current?.focus();
    // A short delay lets the newly-mounted page's own useDocumentTitle
    // effect (called directly, or via PageHeader) commit document.title
    // first — React runs a child's effects before its parent's on the same
    // commit, but the title update itself still needs a macrotask to be
    // safely readable here across every browser/test-environment timing
    // quirk, so this errs on the side of a small, deliberate delay rather
    // than a race.
    const timer = window.setTimeout(() => {
      setRouteAnnouncement(document.title);
    }, 150);
    return () => window.clearTimeout(timer);
  }, [currentLocation.pathname]);

  if (!auth.loading && auth.isAuthenticated && auth.role === null) {
    return <NoRoleScreen userDetails={auth.userDetails} />;
  }

  return (
    <div className={styles.layout}>
      <a href="#main" className={styles.skipLink}>
        Skip to main content
      </a>
      <NavDrawer
        open={navMode === 'overlay' ? overlayOpen : true}
        type={navMode === 'overlay' ? 'overlay' : 'inline'}
        selectedValue={selectedValue}
        aria-label="Primary"
        className={isRailMode ? styles.navRail : undefined}
        onOpenChange={(_event, data) => {
          if (navMode === 'overlay') setOverlayOpen(data.open);
        }}
      >
        <NavDrawerHeader>
          <div className={mergeClasses(styles.brand, isRailMode ? styles.navRailBrandRow : undefined)}>
            {!isRailMode && (
              <Text weight="semibold" size={400}>
                AVD Manager
              </Text>
            )}
            <div className={styles.navHeaderActions}>
              {navMode === 'overlay' ? (
                <Button appearance="subtle" icon={<Dismiss24Regular />} aria-label="Close navigation" onClick={() => setOverlayOpen(false)} />
              ) : (
                <Tooltip content={manualCollapsed ? 'Expand navigation' : 'Collapse navigation'} relationship="label">
                  <Button
                    appearance="subtle"
                    icon={isRailMode && manualCollapsed ? <PanelLeftExpand20Regular /> : <PanelLeftContract20Regular />}
                    aria-label={manualCollapsed ? 'Expand navigation' : 'Collapse navigation'}
                    onClick={toggleManualCollapsed}
                    // The rail band (700-999px) is ALWAYS auto-collapsed regardless of manualCollapsed — the toggle only has a visible effect at full width (>=1000px), so it's disabled there (not hidden — its label still explains what it would do) rather than pretending to do something.
                    disabled={viewportWidth < RAIL_BREAKPOINT_PX}
                  />
                </Tooltip>
              )}
            </div>
          </div>
          {auth.loading ? (
            <div className={styles.identityRow}>
              <Skeleton aria-label="Loading identity">
                <SkeletonItem style={{ height: 32 }} />
              </Skeleton>
            </div>
          ) : (
            <IdentityMenu userDetails={auth.userDetails} role={auth.role} compact={isRailMode} />
          )}
        </NavDrawerHeader>
        <NavDrawerBody>
          {NAV_GROUPS.map((group) => (
            <Fragment key={group.label}>
              <NavSectionHeader className={isRailMode ? visuallyHiddenStyles.visuallyHidden : undefined}>{group.label}</NavSectionHeader>
              {group.items.map((item) => {
                const Icon = item.icon;
                return (
                  <NavItem
                    key={item.to}
                    value={item.to}
                    href={item.to}
                    icon={<Icon />}
                    aria-label={isRailMode ? item.label : undefined}
                    onClick={(event) => handleNavItemClick(event, item.to)}
                  >
                    {isRailMode ? null : item.label}
                  </NavItem>
                );
              })}
            </Fragment>
          ))}
        </NavDrawerBody>
      </NavDrawer>
      <div className={styles.contentColumn}>
        {/* AM-40 peer review MAJOR 4 — persistent, always-first warning bar on the dev preview hostname (see DevPreviewBanner.tsx's own doc comment). Renders null (nothing) on production/localhost — see that component for the hostname check. Placed above EVERYTHING else in the content column, including the mobile top bar, so it's the first thing visible in every nav mode. */}
        <DevPreviewBanner />
        {/* AM-31 item 34 — below OVERLAY_BREAKPOINT_PX only; the NavDrawer above is closed by default there, so this is the only way to open it. EstateStrip (next) stays visible in every mode, including this one. */}
        {navMode === 'overlay' && (
          <div className={styles.mobileTopBar}>
            <Button appearance="subtle" icon={<Navigation20Regular />} aria-label="Open navigation" onClick={() => setOverlayOpen(true)} />
            <Text weight="semibold" size={400}>
              AVD Manager
            </Text>
          </div>
        )}
        <EstateStrip onOpenRecentActions={openRecentActions} />
        <main id="main" tabIndex={-1} ref={mainRef} className={styles.content}>
          {/*
           * AM-29 item 13 — keyed on the route pathname so a fresh
           * ColdStartHintProvider (and therefore a fresh "only the first
           * AsyncState claims the hint" state) is created on every
           * navigation. Layout itself never unmounts across route changes
           * (only <Outlet />'s content does), so without this key a SINGLE
           * provider instance would live for the whole app session — the
           * first page's first AsyncState would permanently claim the
           * hint, and no later page would ever be able to show it again.
           */}
          <ColdStartHintProvider key={currentLocation.pathname}>
            <Outlet />
          </ColdStartHintProvider>
        </main>
      </div>
      {/* AM-29 item 4: announces the new page's title on route change — see the effect above. Visually hidden, always present in the DOM (not conditionally rendered) so assistive tech has already registered the live region before its content changes. */}
      <div role="status" aria-live="polite" className={visuallyHiddenStyles.visuallyHidden}>
        {routeAnnouncement}
      </div>
      {/* AM-29 item 28 — the app's one Toaster; see lib/toaster.ts#useAppToast for how pages dispatch into it. */}
      <Toaster toasterId={TOASTER_ID} />
      {/* AM-31 item 36 */}
      {shortcutsHelpOpen && <KeyboardShortcutsHelpDialog onClose={() => setShortcutsHelpOpen(false)} />}
      {/* AM-31 item 45 */}
      {commandPaletteOpen && (
        <CommandPalette onClose={() => setCommandPaletteOpen(false)} onOpenHelp={() => setShortcutsHelpOpen(true)} onOpenRecentActions={openRecentActions} />
      )}
      {/* AM-32 (M8-W3) */}
      {recentActionsOpen && <RecentActionsDrawer onClose={() => setRecentActionsOpen(false)} />}
    </div>
  );
}
