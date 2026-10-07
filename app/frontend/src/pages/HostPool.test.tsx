import { describe, expect, it, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import type { HostPool as HostPoolDto } from '@avdmgr/shared';
import { renderWithProviders } from '../test/renderWithProviders';
import type { AuthState } from '../auth/AuthContext';

const getHostPools = vi.fn();
const getSessionHosts = vi.fn();
const getHostPoolPolicyHealth = vi.fn();
const setSessionHostDrain = vi.fn();
const setSessionHostPower = vi.fn();
vi.mock('../api/avd', () => ({
  getHostPools: (...args: unknown[]) => getHostPools(...args),
  getSessionHosts: (...args: unknown[]) => getSessionHosts(...args),
  getHostPoolPolicyHealth: (...args: unknown[]) => getHostPoolPolicyHealth(...args),
  setSessionHostDrain: (...args: unknown[]) => setSessionHostDrain(...args),
  setSessionHostPower: (...args: unknown[]) => setSessionHostPower(...args),
}));

const useAuth = vi.fn<() => AuthState>();
vi.mock('../auth/useAuth', () => ({ useAuth: () => useAuth() }));

const { default: HostPool } = await import('./HostPool');

/** Matches lib/config.ts's HOST_POOL_NAME default ('HP-CONTOSO-PROD') so getHostPools' result resolves to a pool on this page. */
function pool(overrides: Partial<HostPoolDto> = {}): HostPoolDto {
  return {
    id: '/subscriptions/sub/resourceGroups/RG-AVD-HostPools/providers/Microsoft.DesktopVirtualization/hostPools/HP-CONTOSO-PROD',
    name: 'HP-CONTOSO-PROD',
    friendlyName: 'Contoso Production',
    resourceGroup: 'RG-AVD-HostPools',
    hostPoolType: 'Pooled',
    loadBalancerType: 'BreadthFirst',
    maxSessionLimit: 4,
    ...overrides,
  };
}

beforeEach(() => {
  useAuth.mockReturnValue({ loading: false, isAuthenticated: true, userDetails: 'operator@contoso.example', roles: ['operator'], role: 'operator' });
  getHostPools.mockReset().mockResolvedValue([pool()]);
  getSessionHosts.mockReset().mockResolvedValue([]);
  getHostPoolPolicyHealth.mockReset().mockResolvedValue({ hosts: [], generatedAt: '2026-08-22T00:00:00Z', cached: false });
  setSessionHostDrain.mockReset();
  setSessionHostPower.mockReset();
});

describe('HostPool — Properties card "Start VM on connect" (AM-38, pins the mapper -> formatter seam the bug lived in)', () => {
  it('renders "On" when the API reports startVMOnConnect: true', async () => {
    getHostPools.mockResolvedValue([pool({ startVMOnConnect: true })]);
    renderWithProviders(<HostPool />);

    expect(await screen.findByText('Start VM on connect')).toBeInTheDocument();
    expect(screen.getByText('On')).toBeInTheDocument();
  });

  it('renders "Off" when the API reports startVMOnConnect: false', async () => {
    getHostPools.mockResolvedValue([pool({ startVMOnConnect: false })]);
    renderWithProviders(<HostPool />);

    await screen.findByText('Start VM on connect');
    expect(screen.getByText('Off')).toBeInTheDocument();
  });

  it('renders "—" (never "Off") when the API omits startVMOnConnect entirely — this was the AM-38 bug: an unknown value must not read as a definite "Off"', async () => {
    getHostPools.mockResolvedValue([pool({ startVMOnConnect: undefined })]);
    renderWithProviders(<HostPool />);

    await screen.findByText('Start VM on connect');
    expect(screen.getByText('—')).toBeInTheDocument();
    expect(screen.queryByText('Off')).not.toBeInTheDocument();
  });
});
