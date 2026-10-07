import { describe, expect, it } from 'vitest';
import { evaluateBudgetCheck } from './budgetCheck';

describe('evaluateBudgetCheck', () => {
  it('warns (not fails) when no RG-scoped budgets are found — mirrors gap register item 11 ("No budget configured on sub-travel-avd") and this check\'s documented subscription-scope RBAC limitation', () => {
    const result = evaluateBudgetCheck([
      { resourceGroup: 'RG-AVD-HostPools', budgets: [] },
      { resourceGroup: 'RG-AVD-Images', budgets: [] },
    ]);
    expect(result.status).toBe('warn');
    expect(result.summary).toContain('gap register item 11');
    expect(result.evidence).toHaveProperty('scopeLimitation');
  });

  it('warns on an unrealistically low budget amount', () => {
    const result = evaluateBudgetCheck([{ resourceGroup: 'RG-AVD-HostPools', budgets: [{ name: 'BUDGET-TINY', properties: { amount: 1, timeGrain: 'Monthly', notifications: { n1: { enabled: true, threshold: 80 } } } }] }]);
    expect(result.status).toBe('warn');
    expect(result.summary).toContain('unrealistically low');
  });

  it('warns when a budget has no notifications configured', () => {
    const result = evaluateBudgetCheck([{ resourceGroup: 'RG-AVD-HostPools', budgets: [{ name: 'BUDGET-SANE', properties: { amount: 5000, timeGrain: 'Monthly', notifications: {} } }] }]);
    expect(result.status).toBe('warn');
    expect(result.summary).toContain('no notifications');
  });

  it('passes when a sane budget with notifications is found', () => {
    const result = evaluateBudgetCheck([{ resourceGroup: 'RG-AVD-HostPools', budgets: [{ name: 'BUDGET-SANE', properties: { amount: 5000, timeGrain: 'Monthly', notifications: { n1: { enabled: true, threshold: 80 } } } }] }]);
    expect(result.status).toBe('pass');
  });
});
