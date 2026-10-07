import type { ReactNode } from 'react';
import type { Role } from '@avdmgr/shared';
import { Skeleton, SkeletonItem } from '@fluentui/react-components';
import { useAuth } from '../auth/useAuth';

export interface RoleGateProps {
  /** Roles allowed to see the children, e.g. ['operator', 'admin']. */
  allowed: Role[];
  children: ReactNode;
  /** Optional content to render instead of nothing when access is denied. */
  fallback?: ReactNode;
  /** Optional content to render instead of nothing while the role is still loading. Defaults to a small disabled placeholder to avoid layout jump. */
  loadingFallback?: ReactNode;
}

/**
 * Renders its children only when the current user's role (from useAuth) is
 * included in `allowed`. Intended for hiding operator/admin-only controls
 * (e.g. drain mode toggles, image publish buttons) from viewers.
 *
 * Note: this is a UI convenience only — the API must independently enforce
 * authorization via app/api/src/lib/auth.ts#requireRole.
 */
export default function RoleGate({ allowed, children, fallback = null, loadingFallback }: RoleGateProps) {
  const { role, loading } = useAuth();

  if (loading) {
    return (
      <>
        {loadingFallback ?? (
          <Skeleton aria-hidden="true" style={{ display: 'inline-block', width: '1.5rem', height: '1.5rem' }}>
            <SkeletonItem shape="square" />
          </Skeleton>
        )}
      </>
    );
  }

  if (!role || !allowed.includes(role)) {
    return <>{fallback}</>;
  }

  return <>{children}</>;
}
