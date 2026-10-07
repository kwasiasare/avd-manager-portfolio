import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { Role } from '@avdmgr/shared';
import { IS_DEMO } from '../lib/config';
import { demoUserDetails, getDemoRole, subscribeDemoRole } from '../demo/identity';

/** Shape returned by Azure Static Web Apps' built-in /.auth/me endpoint. */
interface ClientPrincipal {
  identityProvider: string;
  userId: string;
  userDetails: string;
  userRoles: string[];
}

interface ClientPrincipalResponse {
  clientPrincipal: ClientPrincipal | null;
}

export interface AuthState {
  /** True while the initial /.auth/me lookup is in flight. */
  loading: boolean;
  /** True once we have resolved an identity (real or dev fallback). */
  isAuthenticated: boolean;
  /** Display name / UPN of the signed-in user, if any. */
  userDetails: string | null;
  /** Roles as reported by SWA (or the dev-mode fallback role), filtered to the Role union. */
  roles: Role[];
  /** Convenience: highest-privilege role, used for simple gating. */
  role: Role | null;
}

const ROLE_PRECEDENCE: Role[] = ['admin', 'operator', 'viewer'];
const VALID_ROLES: readonly Role[] = ['viewer', 'operator', 'admin'];

function isValidRole(value: string | undefined): value is Role {
  return !!value && (VALID_ROLES as readonly string[]).includes(value);
}

function pickPrimaryRole(roles: string[]): Role | null {
  for (const candidate of ROLE_PRECEDENCE) {
    if (roles.includes(candidate)) {
      return candidate;
    }
  }
  return null;
}

const INITIAL_STATE: AuthState = {
  loading: true,
  isAuthenticated: false,
  userDetails: null,
  roles: [],
  role: null,
};

const AuthContext = createContext<AuthState>(INITIAL_STATE);

/**
 * Fetches /.auth/me exactly once for the whole app (children read the result
 * via useAuth()) and holds the resolved identity in context.
 *
 * In local development (`vite dev`), /.auth/me is not served by SWA, so on
 * fetch failure this falls back to a synthetic principal driven by
 * VITE_DEV_ROLE — but ONLY when `import.meta.env.DEV` is true (a Vite dev
 * build). A production build must never grant a role just because /.auth/me
 * failed for some other reason (network blip, SWA outage); it must resolve
 * to "not authenticated" instead.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>(INITIAL_STATE);

  // AM-60 — public demo: no SWA auth exists, so the identity is the role the
  // visitor picked in DemoBanner (demo/identity.ts). /.auth/me is never called.
  useEffect(() => {
    if (!IS_DEMO) return;
    const apply = () => {
      const demoRole = getDemoRole();
      setState({ loading: false, isAuthenticated: true, userDetails: demoUserDetails(demoRole), roles: [demoRole], role: demoRole });
    };
    apply();
    return subscribeDemoRole(apply);
  }, []);

  useEffect(() => {
    if (IS_DEMO) return;
    let cancelled = false;

    async function loadPrincipal() {
      try {
        const response = await fetch('/.auth/me');
        if (!response.ok) {
          throw new Error(`/.auth/me returned ${response.status}`);
        }
        const payload = (await response.json()) as ClientPrincipalResponse;
        if (cancelled) return;

        if (payload.clientPrincipal) {
          const roles = payload.clientPrincipal.userRoles.filter(isValidRole);
          setState({
            loading: false,
            isAuthenticated: true,
            userDetails: payload.clientPrincipal.userDetails,
            roles,
            role: pickPrimaryRole(payload.clientPrincipal.userRoles),
          });
        } else {
          setState({ loading: false, isAuthenticated: false, userDetails: null, roles: [], role: null });
        }
      } catch {
        if (cancelled) return;

        const devRole = import.meta.env.VITE_DEV_ROLE;
        if (import.meta.env.DEV && isValidRole(devRole)) {
          setState({
            loading: false,
            isAuthenticated: true,
            userDetails: 'dev-user@localhost',
            roles: [devRole],
            role: devRole,
          });
        } else {
          setState({ loading: false, isAuthenticated: false, userDetails: null, roles: [], role: null });
        }
      }
    }

    void loadPrincipal();
    return () => {
      cancelled = true;
    };
  }, []);

  return <AuthContext.Provider value={state}>{children}</AuthContext.Provider>;
}

/** Reads the identity resolved by the nearest <AuthProvider>. */
export function useAuth(): AuthState {
  return useContext(AuthContext);
}
