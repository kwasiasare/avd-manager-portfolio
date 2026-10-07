import { describe, expect, it } from 'vitest';
import { evaluatePrivateEndpoints } from './privateEndpoints';

/** Mirrors the estate inventory §3's 5 captured private endpoints, all Approved. */
const APPROVED_FIVE = ['PE-HP-CONTOSO-PROD', 'PE-KV-AVD-PROD', 'PE-RSV-AVD-PROD', 'PE-stcontoso001', 'PE-CONTOSO-DESKTOP'].map((name) => ({
  name,
  properties: { provisioningState: 'Succeeded', privateLinkServiceConnections: [{ privateLinkServiceConnectionState: { status: 'Approved' } }] },
}));

describe('evaluatePrivateEndpoints', () => {
  it('passes when all 5 known private endpoints are Approved and Succeeded', () => {
    const result = evaluatePrivateEndpoints(APPROVED_FIVE, 5);
    expect(result.status).toBe('pass');
    expect(result.evidence).toMatchObject({ count: 5, expectedCount: 5 });
  });

  it('warns when fewer than the expected count are found', () => {
    const result = evaluatePrivateEndpoints(APPROVED_FIVE.slice(0, 3), 5);
    expect(result.status).toBe('warn');
  });

  it('respects a configured expectedCount other than 5 (peer review item 16)', () => {
    const result = evaluatePrivateEndpoints(APPROVED_FIVE.slice(0, 3), 3);
    expect(result.status).toBe('pass');
  });

  it('warns on a Pending connection', () => {
    const withPending = [...APPROVED_FIVE.slice(0, 4), { name: 'PE-PENDING', properties: { provisioningState: 'Updating', privateLinkServiceConnections: [{ privateLinkServiceConnectionState: { status: 'Pending' } }] } }];
    const result = evaluatePrivateEndpoints(withPending, 5);
    expect(result.status).toBe('warn');
  });

  it('fails on a Rejected connection', () => {
    const withRejected = [...APPROVED_FIVE.slice(0, 4), { name: 'PE-BAD', properties: { provisioningState: 'Succeeded', privateLinkServiceConnections: [{ privateLinkServiceConnectionState: { status: 'Rejected' } }] } }];
    const result = evaluatePrivateEndpoints(withRejected, 5);
    expect(result.status).toBe('fail');
  });

  it('surfaces truncated:true in evidence when the underlying ARM list hit its page ceiling (peer review item 6)', () => {
    const result = evaluatePrivateEndpoints(APPROVED_FIVE, 5, true);
    expect(result.evidence).toMatchObject({ truncated: true });
  });
});
