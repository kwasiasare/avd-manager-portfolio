import { describe, expect, it } from 'vitest';
import { evaluateLawIngestionCap } from './lawIngestionCap';

describe('evaluateLawIngestionCap', () => {
  describe('workspace-not-found vs. no-cap-configured (peer review item 18)', () => {
    it('is unknown, naming the resource id queried, when the workspace itself was not found', () => {
      const result = evaluateLawIngestionCap(false, undefined, [], '/subscriptions/sub1/resourceGroups/RG-AVD-Monitoring/providers/Microsoft.OperationalInsights/workspaces/LAW-CONTOSO-PROD');
      expect(result.status).toBe('unknown');
      expect(result.summary).toContain('/subscriptions/sub1/resourceGroups/RG-AVD-Monitoring/providers/Microsoft.OperationalInsights/workspaces/LAW-CONTOSO-PROD');
      expect(result.evidence).toMatchObject({ workspaceFound: false });
    });

    it('passes (not unknown) when the workspace WAS found but simply has no cap object configured', () => {
      const result = evaluateLawIngestionCap(true, undefined, []);
      expect(result.status).toBe('pass');
      expect(result.evidence).toMatchObject({ workspaceFound: true, dailyQuotaGb: undefined });
    });
  });

  it('is unknown when a cap is configured but recent ingestion could not be determined', () => {
    const result = evaluateLawIngestionCap(true, 1, []);
    expect(result.status).toBe('unknown');
  });

  it('passes when peak ingestion is comfortably under the 1 GB/day cap (gap register item 7)', () => {
    const result = evaluateLawIngestionCap(true, 1, [
      { date: '2026-08-14', billableGb: 0.3 },
      { date: '2026-08-13', billableGb: 0.2 },
    ]);
    expect(result.status).toBe('pass');
  });

  it('warns when peak ingestion is within 80% of the cap', () => {
    const result = evaluateLawIngestionCap(true, 1, [{ date: '2026-08-14', billableGb: 0.85 }]);
    expect(result.status).toBe('warn');
  });

  it('fails when peak ingestion met or exceeded the cap — the silent-stop scenario gap register item 7 warns about', () => {
    const result = evaluateLawIngestionCap(true, 1, [{ date: '2026-08-14', billableGb: 1.02 }]);
    expect(result.status).toBe('fail');
    expect(result.summary).toContain('gap register item 7');
  });
});
