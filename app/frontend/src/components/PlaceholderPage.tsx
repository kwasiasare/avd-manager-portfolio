import type { ReactNode } from 'react';
import { makeStyles, tokens, Text, MessageBar, MessageBarBody } from '@fluentui/react-components';
import { useDocumentTitle } from '../hooks/useDocumentTitle';

const useStyles = makeStyles({
  page: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalL,
  },
});

/**
 * Shared shell for pages not yet built out (later milestones — see each
 * page's TODO comment for the tracking story). Calls useDocumentTitle(title)
 * itself (peer review, Opus MINOR item 13 — AuditSettings.tsx, this
 * component's one current consumer, had no per-route document.title the
 * way PageHeader's 10-page sweep gave every other routed page) — same
 * convention as PageHeader itself, so any future placeholder page gets this
 * for free rather than needing its own call.
 */
export default function PlaceholderPage({ title, note }: { title: string; note: ReactNode }) {
  useDocumentTitle(title);
  const styles = useStyles();
  return (
    <div className={styles.page}>
      <Text as="h1" size={800} weight="semibold">
        {title}
      </Text>
      <MessageBar intent="info">
        <MessageBarBody>{note}</MessageBarBody>
      </MessageBar>
    </div>
  );
}
