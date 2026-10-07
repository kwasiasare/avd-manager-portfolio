import { describe, expect, it } from 'vitest';
import { evaluateFslogixPublicNetworkAccess } from './fslogixPublicNetworkAccess';

describe('evaluateFslogixPublicNetworkAccess', () => {
  it('passes when Disabled — mirrors stcontoso001\'s captured live state (the estate inventory §5)', () => {
    const result = evaluateFslogixPublicNetworkAccess('stcontoso001', { publicNetworkAccess: 'Disabled' } as never);
    expect(result.status).toBe('pass');
  });

  it('fails when Enabled', () => {
    const result = evaluateFslogixPublicNetworkAccess('stcontoso001', { publicNetworkAccess: 'Enabled' } as never);
    expect(result.status).toBe('fail');
  });

  it('warns on an unrecognized value', () => {
    const result = evaluateFslogixPublicNetworkAccess('stcontoso001', { publicNetworkAccess: undefined } as never);
    expect(result.status).toBe('warn');
  });

  it('fails when the account is not found', () => {
    const result = evaluateFslogixPublicNetworkAccess('stcontoso001', undefined);
    expect(result.status).toBe('fail');
  });
});
