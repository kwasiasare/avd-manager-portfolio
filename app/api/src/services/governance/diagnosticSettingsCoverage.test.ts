import { describe, expect, it } from 'vitest';
import { evaluateDiagnosticSettingsCoverage, type DiagnosticTarget } from './diagnosticSettingsCoverage';

const HOST_POOL: DiagnosticTarget = { label: 'Host pool: HP-CONTOSO-PROD', resourceId: '/hp' };
const WORKSPACE: DiagnosticTarget = { label: 'Workspace: Contoso-Desktop', resourceId: '/ws' };
const APP_GROUP: DiagnosticTarget = { label: 'Application group: HP-CONTOSO-PROD-DAG', resourceId: '/ag' };

describe('evaluateDiagnosticSettingsCoverage', () => {
  it('passes when all three resources — mirroring the estate\'s captured DIAG-HP-CONTOSO-PROD/DIAG-CONTOSO-DESKTOP/HostPools-Diag (the estate inventory §7) — have at least one setting', () => {
    const result = evaluateDiagnosticSettingsCoverage([
      { target: HOST_POOL, settings: [{ name: 'DIAG-HP-CONTOSO-PROD', properties: { logs: [{ category: 'Checkpoint', enabled: true }] } }] },
      { target: WORKSPACE, settings: [{ name: 'DIAG-CONTOSO-DESKTOP', properties: { logs: [{ category: 'Checkpoint', enabled: true }] } }] },
      { target: APP_GROUP, settings: [{ name: 'HostPools-Diag', properties: { logs: [{ category: 'Checkpoint', enabled: true }] } }] },
    ]);
    expect(result.status).toBe('pass');
  });

  it('warns when one resource is missing diagnostic settings', () => {
    const result = evaluateDiagnosticSettingsCoverage([
      { target: HOST_POOL, settings: [{ name: 'DIAG-HP-CONTOSO-PROD' }] },
      { target: WORKSPACE, settings: [] },
      { target: APP_GROUP, settings: [{ name: 'HostPools-Diag' }] },
    ]);
    expect(result.status).toBe('warn');
    expect(result.summary).toContain('Contoso-Desktop');
  });

  it('fails when NO resource has diagnostic settings', () => {
    const result = evaluateDiagnosticSettingsCoverage([
      { target: HOST_POOL, settings: [] },
      { target: WORKSPACE, settings: [] },
      { target: APP_GROUP, settings: [] },
    ]);
    expect(result.status).toBe('fail');
  });
});
