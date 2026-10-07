import type { SessionBatchResult } from '@avdmgr/shared';

/** Minimum shape a batch session operation's target needs — enough to identify it in the aggregate result's `failed[]` entries. */
export interface SessionBatchTarget {
  sessionId: string;
  sessionHostName: string;
  userPrincipalName: string;
}

/** Bounds how many per-session ARM calls run concurrently — see runSessionBatch's doc comment for the rationale. */
const DEFAULT_CONCURRENCY = 8;

/**
 * Server-side cap on how many sessions a single batch call
 * (logoff-all-disconnected / broadcast) will act on. Enforced by the
 * HANDLERS (sessionsLogoffDisconnected.ts, sessionsBroadcast.ts) BEFORE
 * calling runSessionBatch, not by runSessionBatch itself — the handler is
 * what can return a 400 with a clear "narrow your scope" message; by the
 * time targets reach here, it's already too late to reject cheaply. Kept
 * here (not duplicated in each handler) since it's a property of "how much
 * this batch machinery can safely take", the same reasoning as
 * DEFAULT_CONCURRENCY.
 */
export const MAX_BATCH_TARGETS = 100;

/**
 * Reduces a per-session action failure to a SHORT, SANITIZED classification
 * — never the raw error message. An ARM RestError's `.message` can embed
 * the full outbound HTTP request (method, URL, and BODY) that failed; that
 * must never reach a response body the browser renders (CWE-532 — the same
 * concern as logging a raw error object, see the handlers' context.error
 * calls). The full error is still available server-side: callers should log
 * it via runSessionBatch's `onFailure` callback (joinable by the caller's
 * own correlationId), not by threading it into this return value.
 */
function classifyBatchError(error: unknown): string {
  const statusCode = typeof error === 'object' && error !== null && 'statusCode' in error ? (error as { statusCode?: number }).statusCode : undefined;
  if (typeof statusCode === 'number') {
    return `Azure request failed (HTTP ${statusCode})`;
  }
  if (error instanceof Error && error.name && error.name !== 'Error') {
    return `Azure request failed (${error.name})`;
  }
  return 'Azure request failed';
}

export interface RunSessionBatchOptions<T extends SessionBatchTarget> {
  /**
   * Max number of `action` calls in flight at once. Defaults to 8 — an
   * unbounded `Promise.all`/`allSettled` over every target would fire
   * hundreds of parallel ARM DELETE/sendMessage calls for a busy host pool,
   * risking 429 throttling and Function App outbound SNAT port exhaustion.
   * A small worker-pool (below) bounds concurrent in-flight ARM calls
   * without serializing the whole batch.
   */
  concurrency?: number;
  /**
   * Classifies a thrown error as a hard failure ('fail', the default when
   * this option is omitted) or an expected/benign outcome ('skip') — e.g. a
   * session that already vanished (ARM 404) between enumeration and the
   * per-session action, which is the COMMON case for a disconnected session
   * a user closes client-side. Skipped targets are counted in
   * SessionBatchResult.skipped, NOT `failed`, and must not flip the
   * caller's audit outcome to 'failure'.
   */
  classifyError?: (error: unknown) => 'skip' | 'fail';
  /**
   * Called for each HARD failure (after classifyError returns 'fail'), with
   * the RAW error — before it is sanitized into the returned
   * SessionBatchFailure.message. Lets the caller log the full error
   * server-side (e.g. context.error with just `.message`, never the raw
   * error object — see the handlers) without that text ever reaching the
   * sanitized result this function returns.
   */
  onFailure?: (target: T, error: unknown) => void;
}

/**
 * Runs `action` against every target in `targets`, with concurrency BOUNDED
 * to `options.concurrency` (default 8) via a small pull-based worker pool —
 * not a single unbounded `Promise.allSettled(targets.map(...))`, which
 * would fire one ARM call per target simultaneously. One target's action
 * throwing never aborts or skips the others.
 *
 * Shared by the two AM-20 (M2-S3) batch endpoints —
 * sessionsLogoffDisconnected.ts (targets = every Disconnected session) and
 * sessionsBroadcast.ts (targets = every Active session) — so the
 * concurrency bound, skip/fail classification, and partial-failure
 * aggregation logic (and their unit tests) aren't duplicated between them.
 * Each handler is responsible for its OWN filter (Disconnected-only /
 * Active-only respectively) and its own MAX_BATCH_TARGETS cap check BEFORE
 * calling this — this function does not know or care what the targets have
 * in common, nor how many there are.
 *
 * DEFERRED (see AM-20 review): beyond MAX_BATCH_TARGETS, an async-job
 * design (enqueue + poll/webhook) is the right architecture rather than
 * raising this cap further or the caller's HTTP timeout — this synchronous
 * request/response design is only defensible up to a bounded, small target
 * count. Not implemented here.
 */
export async function runSessionBatch<T extends SessionBatchTarget>(
  targets: T[],
  action: (target: T) => Promise<void>,
  options: RunSessionBatchOptions<T> = {},
): Promise<SessionBatchResult> {
  const { concurrency = DEFAULT_CONCURRENCY, classifyError = () => 'fail', onFailure } = options;

  let succeeded = 0;
  let skipped = 0;
  const failed: SessionBatchResult['failed'] = [];

  let nextIndex = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= targets.length) {
        return;
      }
      const target = targets[index];
      try {
        await action(target);
        succeeded += 1;
      } catch (error) {
        if (classifyError(error) === 'skip') {
          skipped += 1;
          continue;
        }
        onFailure?.(target, error);
        failed.push({
          sessionId: target.sessionId,
          sessionHostName: target.sessionHostName,
          userPrincipalName: target.userPrincipalName,
          message: classifyBatchError(error),
        });
      }
    }
  }

  const workerCount = Math.max(1, Math.min(concurrency, targets.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  return { attempted: targets.length, succeeded, skipped, failed };
}
