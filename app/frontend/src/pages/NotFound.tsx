import { useNavigate } from 'react-router-dom';
import { makeStyles, tokens, Text, Button } from '@fluentui/react-components';
import { useDocumentTitle } from '../hooks/useDocumentTitle';

const useStyles = makeStyles({
  page: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    gap: tokens.spacingVerticalL,
    paddingTop: tokens.spacingVerticalXXXL,
  },
});

/**
 * AM-15 (M7) — catch-all 404 route (App.tsx's `path="*"`). Fixes a known
 * backlog item: without a wildcard route, an unmatched path (e.g. the
 * plausible-but-wrong `/hostpool` singular, instead of the real
 * `/host-pools`) rendered a completely blank white page — react-router
 * simply has nothing to render for a path with no matching <Route>, and
 * Layout's <Outlet /> renders empty rather than erroring. A friendly page
 * with a way back is a small fix with an outsized UX impact for anyone who
 * mistypes a URL or follows a stale bookmark/link.
 */
export default function NotFound() {
  const styles = useStyles();
  const navigate = useNavigate();
  // Peer review (Opus, MINOR item 13): this page isn't one of the app's 10
  // routed pages (see PageHeader's item 5/27 adoption sweep) — it's the
  // catch-all 404, so a full PageHeader (with its refresh/asOf affordances
  // that make no sense here) would be the wrong fit. useDocumentTitle
  // directly still fixes the same gap PageHeader adoption fixed elsewhere:
  // without it, the browser tab kept showing whatever the PREVIOUS page's
  // title was after landing on a bad URL.
  useDocumentTitle('Page not found');

  return (
    <div className={styles.page}>
      <Text as="h1" size={800} weight="semibold">
        Page not found
      </Text>
      <Text>The page you're looking for doesn't exist, or the link may be out of date.</Text>
      <Button appearance="primary" onClick={() => navigate('/')}>
        Back to Dashboard
      </Button>
    </div>
  );
}
