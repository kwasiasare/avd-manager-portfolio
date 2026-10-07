import { useSyncExternalStore } from 'react';
import type { Role } from '@avdmgr/shared';

/**
 * AM-60 — demo identity stub. There is no SWA auth in the public demo, so the
 * "signed-in user" is a role the visitor picks in DemoBanner. The role lives
 * in a tiny external store (read by AuthContext and the DemoBanner) persisted
 * in sessionStorage so a refresh keeps it but a new tab starts fresh.
 *
 * Nothing here runs at module load — storage is read lazily — so importing
 * this file from AuthContext costs nothing in a normal (non-demo) build.
 */
export const DEMO_ROLE_STORAGE_KEY = 'avdmgr-demo-role';
export const DEMO_ROLES: readonly Role[] = ['viewer', 'operator', 'admin'];
export const DEFAULT_DEMO_ROLE: Role = 'admin';

let currentRole: Role | undefined;
const listeners = new Set<() => void>();

function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (DEMO_ROLES as readonly string[]).includes(value);
}

function readStoredRole(): Role {
  try {
    const stored = window.sessionStorage.getItem(DEMO_ROLE_STORAGE_KEY);
    if (isRole(stored)) return stored;
  } catch {
    // sessionStorage can throw (blocked storage / private mode) — fall through to the default.
  }
  return DEFAULT_DEMO_ROLE;
}

export function getDemoRole(): Role {
  currentRole ??= readStoredRole();
  return currentRole;
}

export function setDemoRole(role: Role): void {
  if (!isRole(role)) return;
  currentRole = role;
  try {
    window.sessionStorage.setItem(DEMO_ROLE_STORAGE_KEY, role);
  } catch {
    // Persistence is a convenience only.
  }
  listeners.forEach((listener) => listener());
}

export function subscribeDemoRole(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test helper: forget the cached role so the next read re-hydrates from sessionStorage. */
export function resetDemoRoleCache(): void {
  currentRole = undefined;
}

export function useDemoRole(): Role {
  return useSyncExternalStore(subscribeDemoRole, getDemoRole, getDemoRole);
}

/** The fictional UPN shown in the identity menu and recorded as the actor on simulated audit rows. */
export function demoUserDetails(role: Role): string {
  return `demo.${role}@contoso.example`;
}
