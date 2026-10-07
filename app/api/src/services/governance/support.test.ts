import { describe, expect, it, vi } from 'vitest';
import { boundList, runCheckSafely, type GovernanceLogger } from './support';

function fakeLogger(): GovernanceLogger & { errorCalls: unknown[][]; logCalls: unknown[][] } {
  const errorCalls: unknown[][] = [];
  const logCalls: unknown[][] = [];
  return {
    log: (...args: unknown[]) => logCalls.push(args),
    warn: vi.fn(),
    error: (...args: unknown[]) => errorCalls.push(args),
    errorCalls,
    logCalls,
  };
}

describe('runCheckSafely', () => {
  it('returns the check result unchanged when fetchFn succeeds', async () => {
    const logger = fakeLogger();
    const result = await runCheckSafely('x', 'X', 'Cat', async () => ({ id: 'x', title: 'X', category: 'Cat', status: 'pass', summary: 'ok', evidence: {}, checkedAt: new Date().toISOString() }), logger);
    expect(result.status).toBe('pass');
  });

  it('normalizes a thrown error into an unknown-status result', async () => {
    const logger = fakeLogger();
    const result = await runCheckSafely(
      'x',
      'X',
      'Cat',
      async () => {
        throw new Error('ARM said: Authorization denied for /subscriptions/1234/resourceGroups/RG-SECRET/providers/Microsoft.KeyVault/vaults/kv-secret');
      },
      logger,
    );
    expect(result.status).toBe('unknown');
  });

  it('NEVER leaks the raw error message into evidence — only a correlationId (peer review item 9)', async () => {
    const logger = fakeLogger();
    const sensitiveMessage = 'ARM said: Authorization denied for /subscriptions/1234/resourceGroups/RG-SECRET/providers/Microsoft.KeyVault/vaults/kv-secret';
    const result = await runCheckSafely(
      'x',
      'X',
      'Cat',
      async () => {
        throw new Error(sensitiveMessage);
      },
      logger,
    );

    expect(Object.keys(result.evidence)).toEqual(['correlationId']);
    expect(typeof result.evidence.correlationId).toBe('string');
    // A v4 UUID, not an echo of anything sensitive.
    expect(result.evidence.correlationId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(JSON.stringify(result.evidence)).not.toContain('RG-SECRET');
    expect(result.summary).not.toContain('RG-SECRET');
  });

  it('logs the full error server-side via logger.error, tagged with the same correlationId returned in evidence', async () => {
    const logger = fakeLogger();
    const sensitiveMessage = 'raw ARM error text';
    const result = await runCheckSafely(
      'x',
      'X',
      'Cat',
      async () => {
        throw new Error(sensitiveMessage);
      },
      logger,
    );

    expect(logger.errorCalls).toHaveLength(1);
    const [message, loggedError] = logger.errorCalls[0];
    expect(String(message)).toContain(String(result.evidence.correlationId));
    expect((loggedError as Error).message).toBe(sensitiveMessage);
  });

  it('times out a hung fetchFn rather than waiting forever, and still redacts', async () => {
    vi.useFakeTimers();
    try {
      const logger = fakeLogger();
      const hung = new Promise<never>(() => {});
      const promise = runCheckSafely('x', 'X', 'Cat', () => hung, logger);
      await vi.advanceTimersByTimeAsync(30_000);
      const result = await promise;
      expect(result.status).toBe('unknown');
      expect(Object.keys(result.evidence)).toEqual(['correlationId']);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('boundList', () => {
  it('returns totalCount and truncated:false when under the limit', () => {
    expect(boundList([1, 2, 3], 5)).toEqual({ items: [1, 2, 3], totalCount: 3, truncated: false });
  });

  it('truncates items but reports the true totalCount when over the limit', () => {
    const result = boundList([1, 2, 3, 4, 5], 2);
    expect(result).toEqual({ items: [1, 2], totalCount: 5, truncated: true });
  });
});
