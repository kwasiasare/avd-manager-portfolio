/**
 * Re-exported from AuthContext so call sites keep importing `useAuth` from
 * this path. The actual /.auth/me fetch happens once, in <AuthProvider>
 * (mounted in main.tsx) — this hook just reads that shared context value,
 * rather than each component re-fetching /.auth/me independently.
 */
export { useAuth, AuthProvider, type AuthState } from './AuthContext';
