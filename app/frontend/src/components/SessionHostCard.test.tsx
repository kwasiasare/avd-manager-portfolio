import { describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../test/renderWithProviders';
import SessionHostCard from './SessionHostCard';
import { toSessionHostViewModel } from '../lib/sessionHostViewModel';
import type { SessionHost } from '@avdmgr/shared';

const NOW = new Date('2026-08-16T12:00:00.000Z');

function makeHost(overrides: Partial<SessionHost> = {}): SessionHost {
  return {
    id: 'host-1',
    name: 'avd-con-0',
    hostPoolName: 'HP-CONTOSO-PROD',
    status: 'Available',
    allowNewSession: true,
    activeSessions: 3,
    agentVersion: '1.0.9',
    lastHeartBeat: '2026-08-16T11:58:00.000Z',
    powerState: 'running',
    healthChecks: [
      { name: 'CheckA', healthCheckResult: 'HealthCheckSucceeded' },
      { name: 'CheckB', healthCheckResult: 'HealthCheckSucceeded' },
    ],
    ...overrides,
  } as SessionHost;
}

describe('SessionHostCard', () => {
  it('renders hostname, status pill, occupancy, agent version', () => {
    const host = toSessionHostViewModel(makeHost(), { maxSessions: 10, now: NOW });
    renderWithProviders(<SessionHostCard host={host} canMutate={false} onToggleDrainRequest={vi.fn()} onPowerActionRequest={vi.fn()} onViewHealthChecks={vi.fn()} />);

    expect(screen.getByText('avd-con-0')).toBeInTheDocument();
    expect(screen.getByText('Available')).toBeInTheDocument();
    expect(screen.getByText('3/10 sessions')).toBeInTheDocument();
    expect(screen.getByText('1.0.9')).toBeInTheDocument();
    expect(screen.getByText('2/2 checks')).toBeInTheDocument();
  });

  it('renders session count alone when maxSessions is unknown', () => {
    const host = toSessionHostViewModel(makeHost(), { now: NOW });
    renderWithProviders(<SessionHostCard host={host} canMutate={false} onToggleDrainRequest={vi.fn()} onPowerActionRequest={vi.fn()} onViewHealthChecks={vi.fn()} />);
    expect(screen.getByText('3 sessions')).toBeInTheDocument();
  });

  it('hides drain switch and power menu when canMutate is false', () => {
    const host = toSessionHostViewModel(makeHost(), { now: NOW });
    renderWithProviders(<SessionHostCard host={host} canMutate={false} onToggleDrainRequest={vi.fn()} onPowerActionRequest={vi.fn()} onViewHealthChecks={vi.fn()} />);
    expect(screen.queryByText('Accepting sessions')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Power actions/ })).not.toBeInTheDocument();
  });

  it('shows drain switch and power menu when canMutate is true, and fires callbacks', async () => {
    const user = userEvent.setup();
    const onToggleDrainRequest = vi.fn();
    const onPowerActionRequest = vi.fn();
    const host = toSessionHostViewModel(makeHost(), { now: NOW });
    renderWithProviders(<SessionHostCard host={host} canMutate onToggleDrainRequest={onToggleDrainRequest} onPowerActionRequest={onPowerActionRequest} onViewHealthChecks={vi.fn()} />);

    const drainSwitch = screen.getByLabelText('Accepting sessions');
    await user.click(drainSwitch);
    expect(onToggleDrainRequest).toHaveBeenCalledWith(host);

    await user.click(screen.getByRole('button', { name: /Power actions/ }));
    await user.click(await screen.findByRole('menuitem', { name: 'Restart' }));
    expect(onPowerActionRequest).toHaveBeenCalledWith(host, 'restart');
  });

  it('the drain Switch stays visually unchanged after a click — checked stays bound to server data, not a local optimistic flip (peer review MINOR 17)', async () => {
    const user = userEvent.setup();
    const onToggleDrainRequest = vi.fn();
    const host = toSessionHostViewModel(makeHost({ allowNewSession: true }), { now: NOW });
    renderWithProviders(<SessionHostCard host={host} canMutate onToggleDrainRequest={onToggleDrainRequest} onPowerActionRequest={vi.fn()} onViewHealthChecks={vi.fn()} />);

    const drainSwitch = screen.getByLabelText('Accepting sessions') as HTMLInputElement;
    expect(drainSwitch.checked).toBe(true);

    await user.click(drainSwitch);
    // The callback fires (the CALLER owns the actual confirm + mutation —
    // see this component's onToggleDrainRequest doc comment), but the
    // Switch itself never flips ahead of the server: `checked` is derived
    // straight from `host.allowNewSession`, an unchanged prop, so it stays
    // exactly as it was pre-click until a real refetch supplies a new host.
    expect(onToggleDrainRequest).toHaveBeenCalledWith(host);
    expect(drainSwitch.checked).toBe(true);
  });

  it('opens the health checks drawer callback with the host on chip click', async () => {
    const user = userEvent.setup();
    const onViewHealthChecks = vi.fn();
    const host = toSessionHostViewModel(makeHost(), { now: NOW });
    renderWithProviders(<SessionHostCard host={host} canMutate={false} onToggleDrainRequest={vi.fn()} onPowerActionRequest={vi.fn()} onViewHealthChecks={onViewHealthChecks} />);

    await user.click(screen.getByText('2/2 checks'));
    expect(onViewHealthChecks).toHaveBeenCalledWith(host);
  });

  it('shows a stale-heartbeat warning for a running host with no recent heartbeat', () => {
    // `now` is only used to compute the DERIVED heartbeatStale flag (a fixed
    // instant, deterministic) — the component's own relative-time text
    // formats against the real wall clock at render time, so this doesn't
    // assert the exact "Xm/Xh ago" string, only that the stale-heartbeat
    // tooltip/icon (driven by the flag) is present.
    const staleHost = makeHost({ lastHeartBeat: '2026-08-16T11:00:00.000Z', powerState: 'running' });
    const host = toSessionHostViewModel(staleHost, { now: NOW });
    expect(host.heartbeatStale).toBe(true);
    renderWithProviders(<SessionHostCard host={host} canMutate={false} onToggleDrainRequest={vi.fn()} onPowerActionRequest={vi.fn()} onViewHealthChecks={vi.fn()} />);
    expect(screen.getByLabelText('No heartbeat in over 30 minutes while the VM is running')).toBeInTheDocument();
  });

  it('shows a "Checks —" placeholder when no health checks were reported', () => {
    const host = toSessionHostViewModel(makeHost({ healthChecks: undefined }), { now: NOW });
    renderWithProviders(<SessionHostCard host={host} canMutate={false} onToggleDrainRequest={vi.fn()} onPowerActionRequest={vi.fn()} onViewHealthChecks={vi.fn()} />);
    expect(screen.getByText('Checks —')).toBeInTheDocument();
  });

  describe('AM-52 — Intune policy-health chip', () => {
    it('renders nothing when policyHealth is not provided (a page that does not fetch it, e.g. Dashboard/Incident)', () => {
      const host = toSessionHostViewModel(makeHost(), { now: NOW });
      renderWithProviders(<SessionHostCard host={host} canMutate={false} onToggleDrainRequest={vi.fn()} onPowerActionRequest={vi.fn()} onViewHealthChecks={vi.fn()} />);
      expect(screen.queryByText('Intune: OK')).not.toBeInTheDocument();
      expect(screen.queryByText('ADMX missing')).not.toBeInTheDocument();
    });

    it('renders the "Intune: OK" chip for a clean host', () => {
      const host = toSessionHostViewModel(makeHost(), { now: NOW });
      renderWithProviders(
        <SessionHostCard
          host={host}
          policyHealth={{ hostName: 'avd-con-0', status: 'ok', evidence: { admxSignatureDetectable: true } }}
          canMutate={false}
          onToggleDrainRequest={vi.fn()}
          onPowerActionRequest={vi.fn()}
          onViewHealthChecks={vi.fn()}
        />,
      );
      expect(screen.getByText('Intune: OK')).toBeInTheDocument();
    });

    it('renders the "ADMX missing" chip for the missing-admx signature and opens the drawer callback on click', async () => {
      const user = userEvent.setup();
      const onViewHealthChecks = vi.fn();
      const host = toSessionHostViewModel(makeHost(), { now: NOW });
      renderWithProviders(
        <SessionHostCard
          host={host}
          policyHealth={{ hostName: 'avd-con-0', status: 'missing-admx', evidence: { admxSignatureDetectable: true, fsLogixErrorSettings: ['fslogixv1~policy~enabled'] } }}
          canMutate={false}
          onToggleDrainRequest={vi.fn()}
          onPowerActionRequest={vi.fn()}
          onViewHealthChecks={onViewHealthChecks}
        />,
      );
      const chip = screen.getByText('ADMX missing');
      expect(chip).toBeInTheDocument();
      await user.click(chip);
      expect(onViewHealthChecks).toHaveBeenCalledWith(host);
    });

    it('renders "Unknown" for an unknown Intune status', () => {
      const host = toSessionHostViewModel(makeHost(), { now: NOW });
      renderWithProviders(
        <SessionHostCard
          host={host}
          policyHealth={{ hostName: 'avd-con-0', status: 'unknown', evidence: { admxSignatureDetectable: false } }}
          canMutate={false}
          onToggleDrainRequest={vi.fn()}
          onPowerActionRequest={vi.fn()}
          onViewHealthChecks={vi.fn()}
        />,
      );
      expect(screen.getByText('Unknown')).toBeInTheDocument();
    });
  });
});
