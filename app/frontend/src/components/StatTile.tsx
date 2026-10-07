import type { ReactNode } from 'react';
import { Card, CardFooter, CardHeader, Text } from '@fluentui/react-components';
import AsyncState from './AsyncState';
import AppLink from './AppLink';
import { useCardStyles } from '../styles/shared';

export interface StatTileFooterLink {
  to: string;
  label: ReactNode;
}

export interface StatTileProps<T> {
  /** Card heading, rendered as an `<h2>` (matches every other page-level Card heading in this app). */
  title: string;
  loading: boolean;
  error: Error | undefined;
  data: T | undefined;
  asOf?: Date;
  isEmpty?: (data: T) => boolean;
  emptyMessage?: string;
  /** Renders a CardFooter with an AppLink when given — e.g. "View scaling →". Omit for a tile with no drill-down destination (e.g. Dashboard's Sessions tile). */
  footerLink?: StatTileFooterLink;
  children: (data: T) => ReactNode;
}

/**
 * AM-35 (item 49) — extracts the Card + CardHeader + AsyncState(variant="stat")
 * + optional CardFooter shape Dashboard.tsx's four summary tiles (Sessions,
 * Scaling phase, Image version, Cost) all repeated independently before this:
 * same wrapper, same "stat" skeleton, same "as of"/stale-data handling from
 * AsyncState, only the tile-specific content (and whether a "View X →"
 * footer link exists) actually varied per tile. Each caller still owns its
 * own usePolling query and renders whatever tile-specific content it needs
 * via `children`.
 */
export default function StatTile<T>({ title, loading, error, data, asOf, isEmpty, emptyMessage, footerLink, children }: StatTileProps<T>) {
  const cardStyles = useCardStyles();
  return (
    <Card className={cardStyles.card}>
      <CardHeader
        header={
          <Text as="h2" size={400} weight="semibold">
            {title}
          </Text>
        }
      />
      <AsyncState loading={loading} error={error} data={data} asOf={asOf} isEmpty={isEmpty} emptyMessage={emptyMessage} variant="stat">
        {children}
      </AsyncState>
      {footerLink && (
        <CardFooter>
          <AppLink to={footerLink.to}>{footerLink.label}</AppLink>
        </CardFooter>
      )}
    </Card>
  );
}
