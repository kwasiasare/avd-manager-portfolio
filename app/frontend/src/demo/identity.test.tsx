import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_DEMO_ROLE, DEMO_ROLE_STORAGE_KEY, demoUserDetails, getDemoRole, resetDemoRoleCache, setDemoRole, subscribeDemoRole } from './identity';

describe('demo identity store', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    resetDemoRoleCache();
  });

  it('defaults to admin when nothing is stored', () => {
    expect(getDemoRole()).toBe(DEFAULT_DEMO_ROLE);
  });

  it('hydrates from sessionStorage and ignores garbage', () => {
    window.sessionStorage.setItem(DEMO_ROLE_STORAGE_KEY, 'viewer');
    expect(getDemoRole()).toBe('viewer');
    resetDemoRoleCache();
    window.sessionStorage.setItem(DEMO_ROLE_STORAGE_KEY, 'superuser');
    expect(getDemoRole()).toBe(DEFAULT_DEMO_ROLE);
  });

  it('persists changes and notifies subscribers', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeDemoRole(listener);
    setDemoRole('operator');
    expect(getDemoRole()).toBe('operator');
    expect(window.sessionStorage.getItem(DEMO_ROLE_STORAGE_KEY)).toBe('operator');
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    setDemoRole('viewer');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('uses a fictional contoso.example UPN per role', () => {
    expect(demoUserDetails('operator')).toBe('demo.operator@contoso.example');
  });
});

describe('AuthProvider in demo mode', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('skips /.auth/me and follows the role switcher', async () => {
    vi.stubEnv('VITE_DEMO_MODE', 'true');
    vi.resetModules();
    window.sessionStorage.clear();
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const { AuthProvider, useAuth } = await import('../auth/AuthContext');
    const identity = await import('./identity');
    identity.resetDemoRoleCache();

    function Probe() {
      const auth = useAuth();
      return <div data-testid="probe">{`${auth.loading ? 'loading' : 'ready'}|${auth.role}|${auth.userDetails}`}</div>;
    }
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('probe').textContent).toBe('ready|admin|demo.admin@contoso.example'));
    act(() => identity.setDemoRole('viewer'));
    await waitFor(() => expect(screen.getByTestId('probe').textContent).toBe('ready|viewer|demo.viewer@contoso.example'));
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
