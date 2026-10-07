import { useEffect } from 'react';

/**
 * AM-29 item 5 — sets `document.title` to "AVD Manager — <page>" for the
 * lifetime of the calling component, restoring the previous title on
 * unmount (so navigating away — including to a route that doesn't call this
 * hook, e.g. NotFound — never leaves a stale page-specific title behind).
 *
 * Also drives item 4's route-change announcement: every page calling this
 * hook is exactly the set of "real" pages worth announcing to a screen
 * reader on navigation, so Layout's live region (src/components/Layout.tsx)
 * reads the same resolved title back out of `document.title` rather than
 * needing a second, separately-maintained source of page names.
 */
export function useDocumentTitle(pageTitle: string): void {
  useEffect(() => {
    const previousTitle = document.title;
    document.title = `AVD Manager — ${pageTitle}`;
    return () => {
      document.title = previousTitle;
    };
  }, [pageTitle]);
}
