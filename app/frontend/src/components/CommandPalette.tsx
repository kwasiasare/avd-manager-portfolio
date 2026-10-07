import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { Dialog, DialogSurface, DialogBody, Input, Text, makeStyles, tokens, mergeClasses } from '@fluentui/react-components';
import { getCurrentScalingPlan, getSessionHosts } from '../api/avd';
import { useAuth } from '../auth/useAuth';
import { HOST_POOL_NAME } from '../lib/config';
import { useDialogFocusRestore } from '../hooks/useDialogFocusRestore';
import { triggerRegisteredRefresh, visibleNavShortcuts } from '../hooks/useKeyboardShortcuts';

const useStyles = makeStyles({
  surface: {
    maxWidth: '560px',
  },
  input: {
    width: '100%',
  },
  listbox: {
    listStyle: 'none',
    margin: 0,
    padding: 0,
    maxHeight: '360px',
    overflowY: 'auto',
    marginTop: tokens.spacingVerticalS,
  },
  groupLabel: {
    padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalM}`,
    color: tokens.colorNeutralForeground3,
  },
  option: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: tokens.spacingHorizontalM,
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
    borderRadius: tokens.borderRadiusMedium,
    cursor: 'pointer',
  },
  optionActive: {
    backgroundColor: tokens.colorNeutralBackground1Hover,
  },
  hint: {
    color: tokens.colorNeutralForeground3,
  },
  empty: {
    padding: tokens.spacingHorizontalM,
    color: tokens.colorNeutralForeground3,
  },
});

type PaletteGroup = 'Navigation' | 'Entities' | 'Actions';

interface PaletteItem {
  id: string;
  group: PaletteGroup;
  label: string;
  hint?: string;
  onSelect: () => void;
}

const GROUP_ORDER: PaletteGroup[] = ['Navigation', 'Entities', 'Actions'];

/**
 * AM-31 item 45 — Ctrl/Cmd+K command palette. Three groups:
 *  - Navigation: every item in the final nav (same NAV_SHORTCUTS registry
 *    the `?` help dialog and `g <letter>` chords use — one source of truth).
 *  - Entities: session hosts and scaling schedules, fetched ONCE when the
 *    palette opens (not polled — this is a "quick jump", not a live
 *    dashboard). Selecting one navigates to the page that shows it (this
 *    app has no per-host/per-schedule deep-link route). Active sessions by
 *    UPN are deliberately NOT included — this app has no cross-page session
 *    cache to draw from without adding one, which is out of scope for a
 *    ~300-line palette; see this file's own report note.
 *  - Actions: mostly scoped to what's globally safe regardless of page/role
 *    — "Refresh current page" (reuses the SAME registered handler the `r`
 *    shortcut calls) and "Show keyboard shortcuts". Selecting an action
 *    NEVER bypasses a confirm: neither of these two IS a confirm-gated
 *    mutation, and the palette does not attempt per-page mutating actions
 *    (e.g. "Drain avd-con-0") — doing that safely would mean either
 *    duplicating every page's confirm-dialog wiring here or a cross-page
 *    "open this dialog after navigating" channel, neither of which fits
 *    this item's own line budget; see this file's own report note.
 *    AM-32 (M8-W3) adds ONE role-aware exception: "Recent actions" (opens
 *    RecentActionsDrawer via `onOpenRecentActions`), included only for an
 *    operator/admin caller — GET /v1/audit/recent is operator+ only (see
 *    that endpoint's doc comment), and this palette has no other role
 *    awareness of its own, so the check lives right at this one item's
 *    inclusion rather than a broader role-filtering mechanism for the whole
 *    Actions group.
 *
 * Keyboard: ArrowUp/ArrowDown move the active option (wrapping), Enter
 * selects it, Escape closes. Typeahead is the Input itself — every
 * keystroke re-filters `items` by a case-insensitive substring match on
 * label. Roving focus is via aria-activedescendant (the Input keeps DOM
 * focus throughout — standard combobox/listbox pattern), not real DOM focus
 * moving to each option.
 */
export default function CommandPalette({ onClose, onOpenHelp, onOpenRecentActions }: { onClose: () => void; onOpenHelp?: () => void; onOpenRecentActions?: () => void }) {
  useDialogFocusRestore();
  const styles = useStyles();
  const navigate = useNavigate();
  const { role } = useAuth();
  const canOpenRecentActions = Boolean(onOpenRecentActions) && (role === 'operator' || role === 'admin');
  const listboxId = useId();
  const inputRef = useRef<HTMLInputElement>(null);

  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const [hostNames, setHostNames] = useState<string[]>([]);
  const [scheduleNames, setScheduleNames] = useState<string[]>([]);
  // Peer review MINOR 15 — the two entity fetches used to swallow a failure
  // entirely (`.catch(() => undefined)`, no state update at all), which
  // reads to an operator as "there just are no hosts/schedules" rather than
  // "this failed to load" — indistinguishable from a genuinely-empty
  // estate. These track which of the two failed so a notice row can say so.
  const [hostsFailed, setHostsFailed] = useState(false);
  const [schedulesFailed, setSchedulesFailed] = useState(false);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    let cancelled = false;
    getSessionHosts(HOST_POOL_NAME)
      .then((hosts) => {
        if (!cancelled) setHostNames(hosts.map((h) => h.name));
      })
      .catch(() => {
        if (!cancelled) setHostsFailed(true);
      });
    getCurrentScalingPlan()
      .then((plan) => {
        if (!cancelled) setScheduleNames(plan.schedules.map((s) => s.name));
      })
      .catch(() => {
        if (!cancelled) setSchedulesFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const entityLoadErrorText = hostsFailed && schedulesFailed ? "Couldn't load hosts/schedules." : hostsFailed ? "Couldn't load hosts." : schedulesFailed ? "Couldn't load schedules." : undefined;

  const items: PaletteItem[] = useMemo(() => {
    // AM-34 peer review (Opus, RULING 13) — operator-only destinations
    // (Audit, Incident — see NAV_SHORTCUTS' own minRole doc comment) are
    // filtered out of this DISCOVERABILITY list for a viewer; the routes
    // themselves stay deep-linkable (server/page still gates).
    const navItems: PaletteItem[] = visibleNavShortcuts(role).map((shortcut) => ({
      id: `nav-${shortcut.to}`,
      group: 'Navigation',
      label: shortcut.label,
      hint: shortcut.keys,
      onSelect: () => {
        navigate(shortcut.to);
        onClose();
      },
    }));
    const entityItems: PaletteItem[] = [
      ...hostNames.map((name): PaletteItem => ({ id: `host-${name}`, group: 'Entities', label: name, hint: 'Session host', onSelect: () => { navigate('/host-pools'); onClose(); } })),
      ...scheduleNames.map((name): PaletteItem => ({ id: `sched-${name}`, group: 'Entities', label: name, hint: 'Scaling schedule', onSelect: () => { navigate('/scaling'); onClose(); } })),
    ];
    const actionItems: PaletteItem[] = [
      { id: 'action-refresh', group: 'Actions', label: 'Refresh current page', onSelect: () => { onClose(); triggerRegisteredRefresh(); } },
      ...(onOpenHelp ? [{ id: 'action-help', group: 'Actions' as const, label: 'Show keyboard shortcuts', onSelect: () => { onClose(); onOpenHelp(); } }] : []),
      ...(canOpenRecentActions ? [{ id: 'action-recent-actions', group: 'Actions' as const, label: 'Recent actions', onSelect: () => { onClose(); onOpenRecentActions?.(); } }] : []),
    ];
    return [...navItems, ...entityItems, ...actionItems];
  }, [role, hostNames, scheduleNames, navigate, onClose, onOpenHelp, canOpenRecentActions, onOpenRecentActions]);

  const filtered = useMemo(() => {
    const trimmed = query.trim().toLowerCase();
    if (!trimmed) return items;
    return items.filter((item) => item.label.toLowerCase().includes(trimmed) || item.group.toLowerCase().includes(trimmed));
  }, [items, query]);

  // Clamped at RENDER time (a plain derivation), not via a separate
  // "resync activeIndex to the new filtered length" effect — react-hooks/
  // set-state-in-effect forbids a synchronous setState in an effect body,
  // and there's no need for one here: `activeIndex` can simply be read
  // through this clamp everywhere below instead of kept perpetually valid.
  const clampedActiveIndex = Math.min(activeIndex, Math.max(filtered.length - 1, 0));

  function handleKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex(filtered.length === 0 ? 0 : (clampedActiveIndex + 1) % filtered.length);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex(filtered.length === 0 ? 0 : (clampedActiveIndex - 1 + filtered.length) % filtered.length);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      filtered[clampedActiveIndex]?.onSelect();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
    }
  }

  let lastGroup: PaletteGroup | undefined;

  return (
    <Dialog open onOpenChange={(_event, data) => !data.open && onClose()}>
      <DialogSurface className={styles.surface}>
        <DialogBody>
          <Input
            ref={inputRef}
            className={styles.input}
            value={query}
            onChange={(_event, data) => setQuery(data.value)}
            onKeyDown={handleKeyDown}
            placeholder="Jump to a page, host, schedule, or action…"
            role="combobox"
            aria-expanded="true"
            aria-controls={listboxId}
            aria-activedescendant={filtered[clampedActiveIndex]?.id}
            aria-label="Command palette"
          />
          {/* Peer review MINOR 15 — a visible notice instead of the previous silent swallow; role="status" so it's announced without stealing focus from the still-usable Input above it. */}
          {entityLoadErrorText && (
            <Text size={200} className={styles.hint} role="status">
              {entityLoadErrorText}
            </Text>
          )}
          {filtered.length === 0 ? (
            <Text className={styles.empty}>No matches.</Text>
          ) : (
            <ul id={listboxId} role="listbox" aria-label="Command palette results" className={styles.listbox}>
              {GROUP_ORDER.flatMap((group) => {
                const groupItems = filtered.filter((item) => item.group === group);
                return groupItems.map((item) => {
                  const index = filtered.indexOf(item);
                  const showGroupLabel = lastGroup !== group;
                  lastGroup = group;
                  return (
                    // AM-31 peer review MAJOR 2 — role="presentation" on the
                    // <li> wrapper: <ul role="listbox"> otherwise contains
                    // <li> (an IMPLICIT role="listitem") wrapping the real
                    // role="option" <div> — listitem is not a valid listbox
                    // child per the ARIA spec, which breaks the
                    // option<->listbox relationship aria-activedescendant
                    // depends on. Stripping the <li>'s own implicit role (and
                    // the group-label wrapper's, below) makes role="option"
                    // a direct(-ish) descendant the accessibility tree
                    // actually recognizes as a listbox option.
                    <li key={item.id} role="presentation">
                      {showGroupLabel && (
                        <Text size={200} weight="semibold" className={styles.groupLabel} role="presentation">
                          {group}
                        </Text>
                      )}
                      <div
                        id={item.id}
                        role="option"
                        aria-selected={index === clampedActiveIndex}
                        className={mergeClasses(styles.option, index === clampedActiveIndex ? styles.optionActive : undefined)}
                        onMouseEnter={() => setActiveIndex(index)}
                        onClick={() => item.onSelect()}
                      >
                        <Text>{item.label}</Text>
                        {item.hint && (
                          <Text size={200} className={styles.hint}>
                            {item.hint}
                          </Text>
                        )}
                      </div>
                    </li>
                  );
                });
              })}
            </ul>
          )}
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
