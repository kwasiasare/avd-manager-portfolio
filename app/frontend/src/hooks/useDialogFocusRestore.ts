import { useEffect, useRef } from 'react';

/**
 * AM-31 item 37 — captures whatever element had focus the instant this
 * dialog mounted (its trigger — e.g. the row/toolbar button that opened it)
 * and restores focus to it when the dialog unmounts (closes). Every dialog
 * in this app follows the "mounting IS opening" convention (ConfirmModal,
 * MessageComposeDialog, SnoozeDialog, and the ad hoc `<Dialog open>` blocks
 * in CostScaling/RolloutWizard/ImageBuildSection/HostPool) — the parent
 * controls visibility by conditionally rendering the dialog component, so a
 * mount-time capture + unmount-time restore hook, called ONCE inside each
 * dialog component, covers every call site without any page needing its own
 * trigger-ref plumbing.
 *
 * Falls back to the page's `<h1>` (rendered by every page via PageHeader)
 * when the trigger element is no longer in the DOM by the time the dialog
 * closes — the "60s-poll-rerender" case: a background poll can re-render
 * (and replace) the exact row/button that originally opened the dialog
 * while it was still open, leaving the captured reference pointing at a
 * disconnected node.
 */
export function useDialogFocusRestore(): void {
  const triggerRef = useRef<Element | null>(null);

  useEffect(() => {
    triggerRef.current = document.activeElement;
    return () => {
      const trigger = triggerRef.current;
      if (trigger instanceof HTMLElement && document.contains(trigger)) {
        trigger.focus();
        return;
      }
      const heading = document.querySelector('main h1');
      if (heading instanceof HTMLElement) {
        // The heading has no tabIndex by default (PageHeader renders a plain
        // <Text as="h1">) — an element needs tabIndex to be programmatically
        // focusable at all. -1 matches Layout's own <main> convention
        // (focusable via script, not part of the normal Tab order).
        //
        // Peer review NIT 24 — this attribute is OURS, added purely to make
        // the one-time focus() call below possible; a plain page heading has
        // no business permanently carrying tabindex="-1" once this dialog
        // has finished closing (it's not a real part of that element's
        // markup, and it would keep the heading out of a future focus-order
        // audit's expectations). Removing it once the heading blurs again —
        // rather than immediately after focus() — still lets it hold focus
        // for as long as whatever moved focus here (e.g. a screen reader
        // announcing it) needs to.
        if (!heading.hasAttribute('tabindex')) {
          heading.setAttribute('tabindex', '-1');
          const removeTabIndexOnBlur = () => heading.removeAttribute('tabindex');
          heading.addEventListener('blur', removeTabIndexOnBlur, { once: true });
        }
        heading.focus();
      }
    };
    // Mount-once/unmount-once by design — this dialog's whole lifetime IS
    // its open state (see this hook's own doc comment above).
  }, []);
}
