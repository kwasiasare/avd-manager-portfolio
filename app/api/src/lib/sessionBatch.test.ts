import { describe, expect, it, vi } from 'vitest';
import { MAX_BATCH_TARGETS, runSessionBatch, type SessionBatchTarget } from './sessionBatch';

function target(overrides: Partial<SessionBatchTarget> = {}): SessionBatchTarget {
  return { sessionId: '1', sessionHostName: 'avd-con-0', userPrincipalName: 'user@example.com', ...overrides };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('runSessionBatch — basic aggregation', () => {
  it('returns attempted: 0, succeeded: 0, skipped: 0, failed: [] for an empty target list without calling action', async () => {
    const action = vi.fn();
    const result = await runSessionBatch([], action);

    expect(result).toEqual({ attempted: 0, succeeded: 0, skipped: 0, failed: [] });
    expect(action).not.toHaveBeenCalled();
  });

  it('reports full success when every action resolves', async () => {
    const targets = [target({ sessionId: '1' }), target({ sessionId: '2' }), target({ sessionId: '3' })];
    const action = vi.fn().mockResolvedValue(undefined);

    const result = await runSessionBatch(targets, action);

    expect(result).toEqual({ attempted: 3, succeeded: 3, skipped: 0, failed: [] });
    expect(action).toHaveBeenCalledTimes(3);
  });

  it('aggregates partial failures with a SANITIZED message, not the raw error text', async () => {
    const targets = [
      target({ sessionId: '1', userPrincipalName: 'a@example.com' }),
      target({ sessionId: '2', userPrincipalName: 'b@example.com' }),
      target({ sessionId: '3', userPrincipalName: 'c@example.com' }),
    ];
    const rawMessage = 'RestError: PUT https://management.azure.com/... body={"secret":"do-not-leak"}';
    const action = vi.fn(async (t: SessionBatchTarget) => {
      if (t.sessionId === '2') {
        throw new Error(rawMessage);
      }
    });

    const result = await runSessionBatch(targets, action);

    expect(result.attempted).toBe(3);
    expect(result.succeeded).toBe(2);
    expect(result.skipped).toBe(0);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]).toMatchObject({ sessionId: '2', sessionHostName: 'avd-con-0', userPrincipalName: 'b@example.com' });
    expect(result.failed[0].message).not.toContain('do-not-leak');
    expect(result.failed[0].message).not.toBe(rawMessage);
    expect(result.failed[0].message).toBe('Azure request failed');
  });

  it('classifies a statusCode-bearing error as "Azure request failed (HTTP <code>)"', async () => {
    const armError = Object.assign(new Error('too many requests'), { statusCode: 429 });
    const action = vi.fn().mockRejectedValue(armError);

    const result = await runSessionBatch([target()], action);

    expect(result.failed[0].message).toBe('Azure request failed (HTTP 429)');
  });

  it('stringifies a non-Error rejection reason rather than crashing', async () => {
    const action = vi.fn().mockRejectedValue('a plain string rejection');

    const result = await runSessionBatch([target({ sessionId: '1' })], action);

    expect(result.failed[0].message).toBe('Azure request failed');
  });
});

describe('runSessionBatch — skip classification (404 / benign errors)', () => {
  it('classifyError: "skip" increments skipped, not failed, and does not affect succeeded', async () => {
    const targets = [target({ sessionId: '1' }), target({ sessionId: '2' }), target({ sessionId: '3' })];
    const action = vi.fn(async (t: SessionBatchTarget) => {
      if (t.sessionId === '2') {
        const notFound = Object.assign(new Error('not found'), { statusCode: 404 });
        throw notFound;
      }
    });

    const result = await runSessionBatch(targets, action, {
      classifyError: (error) => (typeof error === 'object' && error !== null && (error as { statusCode?: number }).statusCode === 404 ? 'skip' : 'fail'),
    });

    expect(result).toEqual({ attempted: 3, succeeded: 2, skipped: 1, failed: [] });
  });

  it('a fully-skipped batch has succeeded: 0, failed: [], skipped: attempted', async () => {
    const targets = [target({ sessionId: '1' }), target({ sessionId: '2' })];
    const action = vi.fn().mockRejectedValue(new Error('gone'));

    const result = await runSessionBatch(targets, action, { classifyError: () => 'skip' });

    expect(result).toEqual({ attempted: 2, succeeded: 0, skipped: 2, failed: [] });
  });
});

describe('runSessionBatch — onFailure receives the RAW error before sanitization', () => {
  it('calls onFailure with the target and the original (unsanitized) error object', async () => {
    const rawError = new Error('raw ARM detail that must not leak into the response');
    const action = vi.fn().mockRejectedValue(rawError);
    const onFailure = vi.fn();

    await runSessionBatch([target({ sessionId: '7' })], action, { onFailure });

    expect(onFailure).toHaveBeenCalledTimes(1);
    const [calledTarget, calledError] = onFailure.mock.calls[0];
    expect(calledTarget.sessionId).toBe('7');
    expect(calledError).toBe(rawError);
  });

  it('does NOT call onFailure for a skipped (classified) error', async () => {
    const action = vi.fn().mockRejectedValue(new Error('gone'));
    const onFailure = vi.fn();

    await runSessionBatch([target()], action, { classifyError: () => 'skip', onFailure });

    expect(onFailure).not.toHaveBeenCalled();
  });
});

describe('runSessionBatch — bounded concurrency', () => {
  it('never runs more than `concurrency` actions in flight at once', async () => {
    const targets = Array.from({ length: 20 }, (_, i) => target({ sessionId: String(i) }));
    let inFlight = 0;
    let maxInFlight = 0;
    const action = vi.fn(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await delay(10);
      inFlight -= 1;
    });

    const result = await runSessionBatch(targets, action, { concurrency: 3 });

    expect(result.attempted).toBe(20);
    expect(result.succeeded).toBe(20);
    expect(maxInFlight).toBeLessThanOrEqual(3);
    // Also prove it actually PARALLELIZES up to the bound, not falls back to
    // fully sequential (maxInFlight === 1) — a bound that's never exercised
    // wouldn't prove the pool works.
    expect(maxInFlight).toBe(3);
  });

  it('defaults to a concurrency of 8 when not specified', async () => {
    const targets = Array.from({ length: 20 }, (_, i) => target({ sessionId: String(i) }));
    let inFlight = 0;
    let maxInFlight = 0;
    const action = vi.fn(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await delay(10);
      inFlight -= 1;
    });

    await runSessionBatch(targets, action);

    expect(maxInFlight).toBeLessThanOrEqual(8);
    expect(maxInFlight).toBe(8);
  });

  it('never exceeds the target count even when concurrency is larger than the batch', async () => {
    const targets = [target({ sessionId: '1' }), target({ sessionId: '2' })];
    let inFlight = 0;
    let maxInFlight = 0;
    const action = vi.fn(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await delay(5);
      inFlight -= 1;
    });

    await runSessionBatch(targets, action, { concurrency: 8 });

    expect(maxInFlight).toBe(2);
  });

  it('one target throwing does not prevent the others from being attempted', async () => {
    const order: string[] = [];
    const targets = [target({ sessionId: '1' }), target({ sessionId: '2' }), target({ sessionId: '3' })];
    const action = vi.fn(async (t: SessionBatchTarget) => {
      order.push(t.sessionId);
      if (t.sessionId === '1') {
        throw new Error('first one fails');
      }
    });

    await runSessionBatch(targets, action);

    expect(order.sort()).toEqual(['1', '2', '3']);
  });
});

describe('MAX_BATCH_TARGETS', () => {
  it('is exported as a sane, positive cap', () => {
    expect(MAX_BATCH_TARGETS).toBe(100);
  });
});
