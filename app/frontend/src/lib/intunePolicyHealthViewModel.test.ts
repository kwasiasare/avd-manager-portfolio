import { describe, expect, it } from 'vitest';
import { lookupPolicyHealth, toPolicyHealthByHost, unknownPolicyHealth } from './intunePolicyHealthViewModel';
import type { IntunePolicyHealthHost } from '@avdmgr/shared';

describe('unknownPolicyHealth', () => {
  it('returns a synthetic unknown result carrying the host name', () => {
    expect(unknownPolicyHealth('avd-con-1')).toEqual({ hostName: 'avd-con-1', status: 'unknown', evidence: { admxSignatureDetectable: false } });
  });
});

describe('toPolicyHealthByHost / lookupPolicyHealth', () => {
  const hosts: IntunePolicyHealthHost[] = [
    { hostName: 'avd-con-1', status: 'ok', evidence: { admxSignatureDetectable: true } },
    { hostName: 'AVD-CON-2', status: 'missing-admx', evidence: { admxSignatureDetectable: true } },
  ];

  it('builds a case-insensitive lookup and returns a matched result', () => {
    const byHost = toPolicyHealthByHost(hosts);
    expect(lookupPolicyHealth(byHost, 'avd-con-1').status).toBe('ok');
    expect(lookupPolicyHealth(byHost, 'AVD-CON-1').status).toBe('ok');
    expect(lookupPolicyHealth(byHost, 'avd-con-2').status).toBe('missing-admx');
  });

  it('falls back to a synthetic unknown result for a host not present in the map', () => {
    const byHost = toPolicyHealthByHost(hosts);
    expect(lookupPolicyHealth(byHost, 'avd-con-9')).toEqual(unknownPolicyHealth('avd-con-9'));
  });

  it('handles an undefined hosts array (poll not yet loaded)', () => {
    const byHost = toPolicyHealthByHost(undefined);
    expect(byHost.size).toBe(0);
    expect(lookupPolicyHealth(byHost, 'avd-con-1').status).toBe('unknown');
  });
});
