import { useEffect, useRef } from 'react';
import type { NavigateFunction } from 'react-router-dom';
import type { Role } from '@avdmgr/shared';

/**
 * AM-31 item 36 — the app-wide keyboard shortcut registry + dispatcher, plus
 * item 45's `Ctrl/Cmd+K` command-palette trigger (registered here per that
 * item's own instruction, dispatched to `openCommandPalette`).
 *
 * NAV_SHORTCUTS covers every item in the final nav (Layout.tsx's
 * NAV_GROUPS) — the coordinator's own letter list (d/h/s/m/i/c/u/p/g/a)
 * predates the AM-31 item 32b Cost & Scaling split, which added an 11th nav
 * item (Scaling) with no letter of its own; `l` (scaLing) fills that gap,
 * everything else keeps its originally-specified letter. `g` is deliberately
 * reused as BOTH the two-key chord's prefix AND (as `g g`) Governance's own
 * suffix — matches the coordinator's own list, where "g" appears twice.
 *
 * AM-32 (M8-W3): `g t` (audiT) added for the restored Audit nav item — `a`
 * is already Settings, and every other letter in "audit" (u, d, i) is also
 * already taken (Users & Access, Dashboard, Images), so `t` is the first
 * free letter in the word.
 *
 * AM-34 (M8-W5, D6): `g n` (incideNt) added for the Incident page. `i`
 * (Images) and every other letter in "incident" already spoken for by an
 * existing chord (c/Cost, d/Dashboard, t/Audit) is taken; `n` is the first
 * free letter in the word. Incident has no permanent NavDrawer entry of its
 * own (see Layout.tsx's NAV_GROUPS — it's reached via the EstateStrip
 * toggle, this chord, or the command palette, not the sidebar), but it's
 * still listed here so the command palette's Navigation group and this `?`
 * help dialog both surface it — same registry, same reasoning as every
 * other row.
 *
 * AM-34 peer review (Opus, MINOR/RULING 13) — `minRole` (optional) marks a
 * row as operator-only DISCOVERABILITY (Audit, Incident — both gate their
 * own page content behind the same floor already, see those pages' own
 * RoleGate). It affects ONLY the two display surfaces that list these rows
 * for a human to browse/discover — CommandPalette's Navigation group and
 * KeyboardShortcutsHelpDialog's `?` list (both call visibleNavShortcuts
 * below) — not this file's own `g <letter>` chord dispatcher, which
 * deliberately keeps matching against the full, UNFILTERED NAV_SHORTCUTS:
 * a keyboard chord is exactly as deep-link-equivalent as typing a URL bar
 * — the API/page itself is the actual gate either way — so a viewer typing
 * `g t`/`g n` still lands on Audit/Incident and sees that page's own
 * role-gated fallback, same as pasting the URL directly.
 */
export const NAV_SHORTCUTS: ReadonlyArray<{ keys: string; label: string; to: string; minRole?: Role }> = [
  { keys: 'g d', label: 'Dashboard', to: '/' },
  { keys: 'g h', label: 'Host Pool', to: '/host-pools' },
  { keys: 'g s', label: 'Sessions', to: '/sessions' },
  { keys: 'g m', label: 'Monitoring', to: '/monitoring' },
  { keys: 'g i', label: 'Images', to: '/images' },
  { keys: 'g l', label: 'Scaling', to: '/scaling' },
  { keys: 'g c', label: 'Cost', to: '/cost' },
  { keys: 'g u', label: 'Users & Access', to: '/users-access' },
  { keys: 'g p', label: 'Profiles', to: '/profiles' },
  { keys: 'g g', label: 'Governance', to: '/governance' },
  { keys: 'g t', label: 'Audit', to: '/audit', minRole: 'operator' },
  { keys: 'g a', label: 'Settings', to: '/settings' },
  { keys: 'g n', label: 'Incident', to: '/incident', minRole: 'operator' },
];

/** Role precedence, lowest to highest — mirrors AuthContext.tsx's own (unexported) ROLE_PRECEDENCE ordering. */
const ROLE_ORDER: readonly Role[] = ['viewer', 'operator', 'admin'];

/**
 * Filters NAV_SHORTCUTS down to the rows a caller with `role` can actually
 * use — see NAV_SHORTCUTS' own doc comment (RULING 13) for why this is a
 * DISPLAY-ONLY filter, not something the chord dispatcher below also
 * applies. `role: null` (auth still loading, or genuinely signed out) sees
 * only the rows with no `minRole` at all — the same "nothing gated yet"
 * posture RoleGate's own `loading`/no-role branches take elsewhere in this
 * app.
 */
export function visibleNavShortcuts(role: Role | null): typeof NAV_SHORTCUTS {
  if (!role) return NAV_SHORTCUTS.filter((shortcut) => !shortcut.minRole);
  const roleIndex = ROLE_ORDER.indexOf(role);
  return NAV_SHORTCUTS.filter((shortcut) => !shortcut.minRole || roleIndex >= ROLE_ORDER.indexOf(shortcut.minRole));
}

export const OTHER_SHORTCUTS: ReadonlyArray<{ keys: string; description: string }> = [
  { keys: 'r', description: 'Refresh the current page' },
  { keys: '/', description: "Focus the page's search/filter field, where one exists" },
  { keys: 'Ctrl/Cmd K', description: 'Open the command palette' },
  { keys: '?', description: 'Show this shortcuts list' },
];

/** How long a leading "g" stays "pending" waiting for its second key — generous enough for a deliberate two-key chord, short enough that an unrelated later "d" (typed well after "g") doesn't accidentally navigate. */
const CHORD_WINDOW_MS = 1500;

/**
 * AM-31 items 36/38 — module-level "current page" registration slots for
 * the `r` (refresh) and `/` (focus search) shortcuts. Only one page is ever
 * mounted at a time (react-router), so a plain module-level variable — same
 * pattern usePolling.ts's shared visibilitychange listener already uses —
 * is enough; no context provider needed. PageHeader.tsx registers its own
 * `onRefresh` automatically (see that component), so every page using
 * PageHeader gets `r` for free; pages with a primary search/filter field
 * (Sessions.tsx, UsersAccess.tsx) register their input's focus via
 * useRegisterSearchShortcut directly.
 */
let currentRefresh: (() => void) | undefined;
let currentSearchFocus: (() => void) | undefined;

export function useRegisterRefreshShortcut(handler: (() => void) | undefined): void {
  useEffect(() => {
    currentRefresh = handler;
    return () => {
      if (currentRefresh === handler) currentRefresh = undefined;
    };
  }, [handler]);
}

export function useRegisterSearchShortcut(handler: (() => void) | undefined): void {
  useEffect(() => {
    currentSearchFocus = handler;
    return () => {
      if (currentSearchFocus === handler) currentSearchFocus = undefined;
    };
  }, [handler]);
}

/** AM-31 item 45 — lets CommandPalette's own "Refresh current page" action reuse the SAME registered handler `r` dispatches to, rather than a second, separately-wired refresh path. */
export function triggerRegisteredRefresh(): void {
  currentRefresh?.();
}

/**
 * True when shortcuts should be suppressed — focus is in a text-entry
 * control, an open Fluent Menu (peer review MINOR 7 — a MenuItem's own
 * accelerator-looking letters, e.g. "R"estore/"D"elete on Profiles.tsx's
 * overflow menus, must not ALSO fire this app's global single-letter
 * shortcuts while that menu is open and the user is navigating it with the
 * keyboard), or any Fluent Dialog/Drawer is currently open.
 */
function shouldSuppressShortcuts(): boolean {
  const active = document.activeElement;
  if (active) {
    const tag = active.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if ((active as HTMLElement).isContentEditable) return true;
    const role = active.getAttribute('role');
    if (role === 'combobox' || role === 'textbox' || role === 'listbox' || role === 'spinbutton' || role === 'menu' || role === 'menuitem') return true;
  }
  // Fluent's Dialog/OverlayDrawer both render role="dialog" (or role="alertdialog") on their surface once open; Menu/MenuList renders role="menu" on its popover once open — covers the case where focus is on the menu's trigger button rather than inside the popover itself while it's still open.
  if (document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"]')) return true;
  return false;
}

/**
 * Mounted ONCE, at Layout.tsx — attaches a single document-level keydown
 * listener for the app's whole lifetime (matching this app's existing
 * "one shared listener, not one per consumer" convention — see
 * usePolling.ts's visibilitychange listener).
 */
export function useKeyboardShortcuts(navigate: NavigateFunction, openHelp: () => void, openCommandPalette: () => void): void {
  const pendingPrefixRef = useRef<{ key: string; expiresAt: number } | undefined>(undefined);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      const isCommandPalette = (event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'k';
      if (isCommandPalette) {
        if (shouldSuppressShortcuts()) return;
        event.preventDefault();
        pendingPrefixRef.current = undefined;
        openCommandPalette();
        return;
      }

      // Peer review NIT 21 — altKey is excluded EXCEPT for "?": many
      // non-US/European keyboard layouts (e.g. AltGr-based ones) produce "?"
      // only via AltGr, which browsers report as altKey (sometimes alongside
      // ctrlKey too) — without this carve-out, the shortcuts-help dialog
      // would be unreachable by keyboard on those layouts.
      if (event.ctrlKey || event.metaKey || (event.altKey && event.key !== '?')) return;
      if (shouldSuppressShortcuts()) return;

      // Peer review MINOR 6 — a pending "g" that DOESN'T resolve to a known
      // chord (e.g. "g" then "r") used to just `return` here, swallowing the
      // second key entirely — so "g r" neither navigated NOR fell through to
      // let "r" refresh the page on its own. The prefix is still cleared
      // (it's spent either way — a stale "g" must not silently outlive this
      // keypress), but on a non-match execution now CONTINUES past this
      // block into the plain-key handling below, so "r"/"/"/"?" (or a fresh
      // "g" chord) still fire normally off the same keypress that broke the
      // chord.
      const pending = pendingPrefixRef.current;
      if (pending && Date.now() < pending.expiresAt) {
        pendingPrefixRef.current = undefined;
        const match = NAV_SHORTCUTS.find((shortcut) => shortcut.keys === `${pending.key} ${event.key}`);
        if (match) {
          event.preventDefault();
          navigate(match.to);
          return;
        }
      }

      if (event.key === 'g') {
        pendingPrefixRef.current = { key: 'g', expiresAt: Date.now() + CHORD_WINDOW_MS };
        return;
      }
      pendingPrefixRef.current = undefined;

      if (event.key === 'r') {
        event.preventDefault();
        currentRefresh?.();
      } else if (event.key === '/') {
        event.preventDefault();
        currentSearchFocus?.();
      } else if (event.key === '?') {
        event.preventDefault();
        openHelp();
      }
    }

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [navigate, openHelp, openCommandPalette]);
}
