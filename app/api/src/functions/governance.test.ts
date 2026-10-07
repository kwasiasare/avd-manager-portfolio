import { describe, expect, it } from 'vitest';
import type { GovernanceCheckResult, GovernanceSummary } from '@avdmgr/shared';
import { redactConditionalAccessEvidenceForViewers } from './governance';

function fakeSummary(caCheck: GovernanceCheckResult): GovernanceSummary {
  return {
    checks: [{ id: 'kv-purge-protection', title: 'KV', category: 'Security', status: 'pass', summary: 'ok', evidence: {}, checkedAt: '2026-08-16T00:00:00Z' }, caCheck],
    counts: { pass: 1, warn: 1, fail: 0, unknown: 0 },
    generatedAt: '2026-08-16T00:00:00Z',
    cached: false,
  };
}

describe('redactConditionalAccessEvidenceForViewers (peer review item 15)', () => {
  it('replaces policy displayNames with a stable, non-reversible label, keeping status/summary/counts untouched', () => {
    const caCheck: GovernanceCheckResult = {
      id: 'ca-policy-breakglass',
      title: 'CA',
      category: 'Identity',
      status: 'warn',
      summary: '1 of 1 enforced Conditional Access policies do NOT exclude the break-glass group: Sensitive Internal Policy Name.',
      evidence: { policies: [{ id: 'p1', displayName: 'Sensitive Internal Policy Name', state: 'enabled', excludesBreakGlass: false }], reportOnlyPolicies: [] },
      links: [{ label: 'Review "Sensitive Internal Policy Name" in Entra', url: 'https://entra.microsoft.com/.../Policies/p1' }],
      checkedAt: '2026-08-16T00:00:00Z',
    };

    const redacted = redactConditionalAccessEvidenceForViewers(fakeSummary(caCheck));
    const redactedCheck = redacted.checks.find((c) => c.id === 'ca-policy-breakglass')!;
    const policies = (redactedCheck.evidence as { policies: Array<{ displayName: string; id: string }> }).policies;

    expect(policies[0].displayName).not.toContain('Sensitive Internal Policy Name');
    expect(policies[0].displayName).toMatch(/^Policy-[0-9a-f]{8}$/);
    expect(policies[0].id).toBe('p1'); // id (opaque GUID) is not redacted
    expect(redactedCheck.status).toBe('warn'); // status is never redacted
    expect(redactedCheck.links?.[0]?.label).not.toContain('Sensitive Internal Policy Name');
    expect(redactedCheck.links?.[0]?.url).toBe('https://entra.microsoft.com/.../Policies/p1'); // URL untouched
  });

  it('produces the SAME label for the same policy id across calls (stable, not random)', () => {
    const caCheck: GovernanceCheckResult = {
      id: 'ca-policy-breakglass',
      title: 'CA',
      category: 'Identity',
      status: 'pass',
      summary: 'ok',
      evidence: { policies: [{ id: 'p1', displayName: 'Name A' }], reportOnlyPolicies: [] },
      checkedAt: '2026-08-16T00:00:00Z',
    };

    const first = redactConditionalAccessEvidenceForViewers(fakeSummary(caCheck));
    const second = redactConditionalAccessEvidenceForViewers(fakeSummary(caCheck));
    const label1 = (first.checks.find((c) => c.id === 'ca-policy-breakglass')!.evidence as { policies: Array<{ displayName: string }> }).policies[0].displayName;
    const label2 = (second.checks.find((c) => c.id === 'ca-policy-breakglass')!.evidence as { policies: Array<{ displayName: string }> }).policies[0].displayName;
    expect(label1).toBe(label2);
  });

  it('does NOT mutate the original summary object (safe to share across concurrent viewer/operator requests)', () => {
    const caCheck: GovernanceCheckResult = {
      id: 'ca-policy-breakglass',
      title: 'CA',
      category: 'Identity',
      status: 'pass',
      summary: 'ok',
      evidence: { policies: [{ id: 'p1', displayName: 'Name A' }], reportOnlyPolicies: [] },
      checkedAt: '2026-08-16T00:00:00Z',
    };
    const original = fakeSummary(caCheck);
    redactConditionalAccessEvidenceForViewers(original);
    const originalPolicies = (original.checks.find((c) => c.id === 'ca-policy-breakglass')!.evidence as { policies: Array<{ displayName: string }> }).policies;
    expect(originalPolicies[0].displayName).toBe('Name A');
  });

  it('is a no-op when the CA check has a degraded/no-policies evidence shape (not-configured / graph-not-granted)', () => {
    const caCheck: GovernanceCheckResult = {
      id: 'ca-policy-breakglass',
      title: 'CA',
      category: 'Identity',
      status: 'unknown',
      summary: 'not configured',
      evidence: { degradation: 'not-configured' },
      checkedAt: '2026-08-16T00:00:00Z',
    };
    const summary = fakeSummary(caCheck);
    const redacted = redactConditionalAccessEvidenceForViewers(summary);
    expect(redacted).toBe(summary); // unchanged, same reference — nothing to redact
  });

  it('is a no-op when no CA check is present at all', () => {
    const summary: GovernanceSummary = {
      checks: [{ id: 'kv-purge-protection', title: 'KV', category: 'Security', status: 'pass', summary: 'ok', evidence: {}, checkedAt: '2026-08-16T00:00:00Z' }],
      counts: { pass: 1, warn: 0, fail: 0, unknown: 0 },
      generatedAt: '2026-08-16T00:00:00Z',
      cached: false,
    };
    expect(redactConditionalAccessEvidenceForViewers(summary)).toBe(summary);
  });
});
