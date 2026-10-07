import { describe, expect, it } from 'vitest';
import { sessionHostStatusTone } from './sessionHostStatusTone';

describe('sessionHostStatusTone', () => {
  it('maps Available to ok', () => {
    expect(sessionHostStatusTone('Available')).toBe('ok');
  });

  it.each(['Upgrading', 'NeedsAssistance'] as const)('maps %s to warning', (status) => {
    expect(sessionHostStatusTone(status)).toBe('warning');
  });

  it('maps Shutdown (deliberately powered off) to pending, not error', () => {
    expect(sessionHostStatusTone('Shutdown')).toBe('pending');
  });

  it.each(['Unavailable', 'NoHeartbeat', undefined] as const)('maps %s to error', (status) => {
    expect(sessionHostStatusTone(status)).toBe('error');
  });

  it.each(['Disconnected', 'UpgradeFailed', 'NotJoinedToDomain', 'DomainTrustRelationshipLost', 'SxSStackListenerNotReady', 'FSLogixNotHealthy', 'Unknown'] as const)(
    'maps agent-reported problem state %s to error',
    (status) => {
      expect(sessionHostStatusTone(status)).toBe('error');
    },
  );
});
