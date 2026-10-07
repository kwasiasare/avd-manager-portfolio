import { describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '../test/renderWithProviders';
import type { AuthState } from '../auth/AuthContext';

const useAuth = vi.fn<() => AuthState>();
vi.mock('../auth/useAuth', () => ({ useAuth: () => useAuth() }));

const { default: RoleGate } = await import('./RoleGate');

function state(overrides: Partial<AuthState>): AuthState {
  return { loading: false, isAuthenticated: true, userDetails: 'user@example.com', roles: [], role: null, ...overrides };
}

describe('RoleGate', () => {
  it('renders children when the current role is in `allowed`', () => {
    useAuth.mockReturnValue(state({ role: 'admin', roles: ['admin'] }));
    renderWithProviders(
      <RoleGate allowed={['operator', 'admin']}>
        <div>secret controls</div>
      </RoleGate>,
    );
    expect(screen.getByText('secret controls')).toBeInTheDocument();
  });

  it('hides children and renders the fallback when the role is not in `allowed`', () => {
    useAuth.mockReturnValue(state({ role: 'viewer', roles: ['viewer'] }));
    renderWithProviders(
      <RoleGate allowed={['operator', 'admin']} fallback={<div>read-only</div>}>
        <div>secret controls</div>
      </RoleGate>,
    );
    expect(screen.queryByText('secret controls')).not.toBeInTheDocument();
    expect(screen.getByText('read-only')).toBeInTheDocument();
  });

  it('renders nothing (default fallback) when there is no role at all', () => {
    useAuth.mockReturnValue(state({ role: null, roles: [], isAuthenticated: false, userDetails: null }));
    renderWithProviders(
      <RoleGate allowed={['viewer', 'operator', 'admin']}>
        <div>secret controls</div>
      </RoleGate>,
    );
    expect(screen.queryByText('secret controls')).not.toBeInTheDocument();
  });

  it('shows the default loading placeholder (a Skeleton), not the children, while auth is still resolving', () => {
    useAuth.mockReturnValue(state({ loading: true, role: null, roles: [] }));
    const { container } = renderWithProviders(
      <RoleGate allowed={['admin']}>
        <div>secret controls</div>
      </RoleGate>,
    );
    expect(screen.queryByText('secret controls')).not.toBeInTheDocument();
    expect(container.querySelector('.fui-Skeleton')).not.toBeNull();
  });

  it('shows a caller-supplied loadingFallback instead of the default Skeleton', () => {
    useAuth.mockReturnValue(state({ loading: true, role: null, roles: [] }));
    renderWithProviders(
      <RoleGate allowed={['admin']} loadingFallback={<div>checking access…</div>}>
        <div>secret controls</div>
      </RoleGate>,
    );
    expect(screen.queryByText('secret controls')).not.toBeInTheDocument();
    expect(screen.getByText('checking access…')).toBeInTheDocument();
  });
});
