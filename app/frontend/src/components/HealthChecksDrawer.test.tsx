import { describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '../test/renderWithProviders';
import HealthChecksDrawer from './HealthChecksDrawer';
import { toSessionHostViewModel } from '../lib/sessionHostViewModel';
import type { IntunePolicyHealthHost, SessionHost } from '@avdmgr/shared';

const NOW = new Date('2026-08-22T12:00:00.000Z');

function makeHost(overrides: Partial<SessionHost> = {}): SessionHost {
  return {
    id: 'host-1',
    name: 'avd-con-0',
    hostPoolName: 'HP-CONTOSO-PROD',
    status: 'Available',
    allowNewSession: true,
    activeSessions: 1,
    agentVersion: '1.0.9',
    lastHeartBeat: '2026-08-22T11:58:00.000Z',
    powerState: 'running',
    healthChecks: [{ name: 'CheckA', healthCheckResult: 'HealthCheckSucceeded' }],
    ...overrides,
  } as SessionHost;
}

describe('HealthChecksDrawer', () => {
  it('renders nothing (closed) when host is undefined', () => {
    renderWithProviders(<HealthChecksDrawer host={undefined} onClose={vi.fn()} />);
    expect(screen.queryByText('Health checks')).not.toBeInTheDocument();
  });

  it('renders health checks without an Intune section when policyHealth is not provided', () => {
    const host = toSessionHostViewModel(makeHost(), { now: NOW });
    renderWithProviders(<HealthChecksDrawer host={host} onClose={vi.fn()} />);
    expect(screen.getByText('Health checks')).toBeInTheDocument();
    expect(screen.queryByText('Intune policy health')).not.toBeInTheDocument();
  });

  describe('AM-52 — Intune policy health section', () => {
    it('renders an "ok" section with last sync time', () => {
      const host = toSessionHostViewModel(makeHost(), { now: NOW });
      const policyHealth: IntunePolicyHealthHost = { hostName: 'avd-con-0', status: 'ok', evidence: { deviceId: 'dev-1', lastSyncDateTime: '2026-08-22T10:00:00.000Z', errorSettingCount: 0, admxSignatureDetectable: true } };
      renderWithProviders(<HealthChecksDrawer host={host} policyHealth={policyHealth} onClose={vi.fn()} />);
      expect(screen.getByText('Intune policy health')).toBeInTheDocument();
      expect(screen.getByText('Intune: OK')).toBeInTheDocument();
    });

    it('renders the bounded fsLogixErrorSettings list and remediation text for missing-admx', () => {
      const host = toSessionHostViewModel(makeHost(), { now: NOW });
      const policyHealth: IntunePolicyHealthHost = {
        hostName: 'avd-con-0',
        status: 'missing-admx',
        evidence: { deviceId: 'dev-1', lastSyncDateTime: '2026-08-22T10:00:00.000Z', errorSettingCount: 2, fsLogixErrorSettings: ['fslogixv1~policy~vhdlocations', 'fslogixv1~policy~enabled'], admxSignatureDetectable: true },
        remediation: "Intune's one-shot third-party ADMX ingestion batch failed at enrollment (event 0x86000009)... see the FSLogix storage runbook §5.1.",
      };
      renderWithProviders(<HealthChecksDrawer host={host} policyHealth={policyHealth} onClose={vi.fn()} />);
      expect(screen.getByText('ADMX missing')).toBeInTheDocument();
      expect(screen.getByText('fslogixv1~policy~vhdlocations')).toBeInTheDocument();
      expect(screen.getByText('fslogixv1~policy~enabled')).toBeInTheDocument();
      expect(screen.getByText('Remediation')).toBeInTheDocument();
      expect(screen.getByText(/§5.1/)).toBeInTheDocument();
    });

    it('renders a duplicate-device note when duplicateDeviceRecords is true', () => {
      const host = toSessionHostViewModel(makeHost(), { now: NOW });
      const policyHealth: IntunePolicyHealthHost = {
        hostName: 'avd-con-0',
        status: 'ok',
        evidence: { deviceId: 'dev-fresh', lastSyncDateTime: '2026-08-22T10:00:00.000Z', duplicateDeviceRecords: true, admxSignatureDetectable: true },
      };
      renderWithProviders(<HealthChecksDrawer host={host} policyHealth={policyHealth} onClose={vi.fn()} />);
      expect(screen.getByText(/More than one Intune device record matches this host/)).toBeInTheDocument();
    });

    it('renders a "not-enrolled" explanation with no error-setting content', () => {
      const host = toSessionHostViewModel(makeHost(), { now: NOW });
      const policyHealth: IntunePolicyHealthHost = { hostName: 'avd-con-0', status: 'not-enrolled', evidence: { admxSignatureDetectable: false } };
      renderWithProviders(<HealthChecksDrawer host={host} policyHealth={policyHealth} onClose={vi.fn()} />);
      expect(screen.getByText('Not enrolled')).toBeInTheDocument();
      expect(screen.getByText(/No Intune managed device matches this host/)).toBeInTheDocument();
    });

    it('renders an "unknown" explanation citing the correlationId when a per-host Graph error occurred', () => {
      const host = toSessionHostViewModel(makeHost(), { now: NOW });
      const policyHealth: IntunePolicyHealthHost = { hostName: 'avd-con-0', status: 'unknown', evidence: { admxSignatureDetectable: false, correlationId: 'corr-123' } };
      renderWithProviders(<HealthChecksDrawer host={host} policyHealth={policyHealth} onClose={vi.fn()} />);
      expect(screen.getByText(/Reference: corr-123/)).toBeInTheDocument();
    });

    it('renders an "unknown" explanation pointing at the Graph grant when no correlationId is present (permission-not-granted case)', () => {
      const host = toSessionHostViewModel(makeHost(), { now: NOW });
      const policyHealth: IntunePolicyHealthHost = { hostName: 'avd-con-0', status: 'unknown', evidence: { admxSignatureDetectable: false } };
      renderWithProviders(<HealthChecksDrawer host={host} policyHealth={policyHealth} onClose={vi.fn()} />);
      expect(screen.getByText(/app-registration.md §9/)).toBeInTheDocument();
    });
  });
});
