import { describe, expect, it } from 'vitest';
import { evaluateConditionalAccessBreakGlass } from './conditionalAccessBreakGlass';

const BREAK_GLASS_ID = 'bg-group-guid';

describe('evaluateConditionalAccessBreakGlass', () => {
  it('is unknown ("not configured") when no break-glass group id is set', () => {
    const result = evaluateConditionalAccessBreakGlass(undefined, []);
    expect(result.status).toBe('unknown');
    expect(result.evidence).toMatchObject({ degradation: 'not-configured' });
  });

  it('is unknown ("Graph permission not granted") with grant instructions when Graph is not yet permitted — the expected default state until docs/app-registration.md section 9 is run', () => {
    const result = evaluateConditionalAccessBreakGlass(BREAK_GLASS_ID, 'graph-not-granted');
    expect(result.status).toBe('unknown');
    expect(result.evidence).toMatchObject({ degradation: 'graph-permission-not-granted' });
    expect(result.links?.[0]?.url).toContain('entra.microsoft.com');
  });

  it('passes when every ENFORCED policy excludes the break-glass group', () => {
    const result = evaluateConditionalAccessBreakGlass(BREAK_GLASS_ID, [
      { id: 'p1', displayName: 'Require MFA', state: 'enabled', conditions: { users: { excludeGroups: [BREAK_GLASS_ID] } } },
    ]);
    expect(result.status).toBe('pass');
  });

  it('warns and links each gap when an ENFORCED policy does NOT exclude the break-glass group', () => {
    const result = evaluateConditionalAccessBreakGlass(BREAK_GLASS_ID, [{ id: 'p1', displayName: 'Require MFA', state: 'enabled', conditions: { users: { excludeGroups: [] } } }]);
    expect(result.status).toBe('warn');
    expect(result.summary).toContain('Require MFA');
    expect(result.links).toHaveLength(1);
  });

  it('ignores disabled policies entirely', () => {
    const result = evaluateConditionalAccessBreakGlass(BREAK_GLASS_ID, [{ id: 'p1', displayName: 'Old draft policy', state: 'disabled', conditions: { users: { excludeGroups: [] } } }]);
    expect(result.status).toBe('warn'); // zero enforced -> warn, per peer review item 15
  });

  describe('report-only handling (peer review item 15)', () => {
    it('warns (not pass) when zero policies are enforced, even if report-only policies exist — and lists them in evidence, not the gap list', () => {
      const result = evaluateConditionalAccessBreakGlass(BREAK_GLASS_ID, [
        { id: 'p1', displayName: 'Draft MFA policy', state: 'enabledForReportingButNotEnforced', conditions: { users: { excludeGroups: [] } } },
      ]);
      expect(result.status).toBe('warn');
      expect(result.summary).toContain('report-only');
      expect(result.evidence).toMatchObject({ policies: [], reportOnlyPolicies: [{ id: 'p1', displayName: 'Draft MFA policy' }] });
      expect(result.links ?? []).toHaveLength(0);
    });

    it('does not let a report-only gap affect the enforced-policy pass/warn decision', () => {
      const result = evaluateConditionalAccessBreakGlass(BREAK_GLASS_ID, [
        { id: 'p1', displayName: 'Enforced good policy', state: 'enabled', conditions: { users: { excludeGroups: [BREAK_GLASS_ID] } } },
        { id: 'p2', displayName: 'Report-only gap policy', state: 'enabledForReportingButNotEnforced', conditions: { users: { excludeGroups: [] } } },
      ]);
      expect(result.status).toBe('pass');
      const evidence = result.evidence as { reportOnlyPolicies: Array<{ excludesBreakGlass: boolean }> };
      expect(evidence.reportOnlyPolicies[0].excludesBreakGlass).toBe(false);
    });
  });

  it('warns when zero enforced AND zero report-only policies exist at all', () => {
    const result = evaluateConditionalAccessBreakGlass(BREAK_GLASS_ID, []);
    expect(result.status).toBe('warn');
    expect(result.summary).not.toContain('report-only');
  });

  it('surfaces truncated:true from the underlying Graph list in evidence', () => {
    const result = evaluateConditionalAccessBreakGlass(BREAK_GLASS_ID, [{ id: 'p1', displayName: 'X', state: 'enabled', conditions: { users: { excludeGroups: [BREAK_GLASS_ID] } } }], true);
    expect(result.evidence).toMatchObject({ truncated: true });
  });
});
