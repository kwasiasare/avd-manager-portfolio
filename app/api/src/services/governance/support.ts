import { randomUUID } from 'node:crypto';
import type { GovernanceCheckResult, GovernanceCheckStatus, GovernanceLink } from '@avdmgr/shared';

/**
 * AM-16 (M3b) — shared plumbing for every services/governance/*.ts check.
 *
 * Each check module follows the same two-function shape:
 *   - a PURE `evaluateXxx(data): GovernanceCheckResult` — takes already-
 *     fetched data, computes status/summary/evidence, never calls Azure.
 *     This is what governance/*.test.ts unit-tests against fixtures.
 *   - an impure `fetchXxx(): Promise<GovernanceCheckResult>` — makes the
 *     ARM/Graph call(s), then hands the result to evaluateXxx. Errors are
 *     NOT caught here (that's runCheckSafely's job below, applied uniformly
 *     by the registry) — keeping fetchXxx a plain throw-on-failure function
 *     is what lets governanceService.ts's single try/catch (via
 *     runCheckSafely) work identically for every check.
 */

export function buildResult(params: {
  id: string;
  title: string;
  category: string;
  status: GovernanceCheckStatus;
  summary: string;
  evidence: Record<string, unknown>;
  links?: GovernanceLink[];
}): GovernanceCheckResult {
  return { ...params, checkedAt: new Date().toISOString() };
}

/** Logger contract runCheckSafely needs — a thin subset of Azure Functions' InvocationContext, so this file (and every governance/*.ts test) never imports @azure/functions directly. */
export interface GovernanceLogger {
  log: (message: string) => void;
  warn: (message: string) => void;
  /** SECURITY POSTURE (peer review item 9): callers MUST pass the full, unredacted `error` here — this is the ONLY place a check's raw ARM/Graph error text is allowed to appear, and it goes to server-side logs (App Insights via context.error), never into a check's `evidence`, which every viewer+ caller reads verbatim over the wire. */
  error: (message: string, error?: unknown) => void;
}

/**
 * Peer review item 8 ("overall deadline consideration on runAllChecks"):
 * bounds a single check's total run time (which may itself be several
 * parallel ARM/Graph calls, each already bounded by lib/restClient.ts's own
 * 15s-per-request timeout — a check making N calls in parallel is bounded
 * by the slowest one, not their sum) so one anomalously slow check can
 * never hold the whole GET /v1/governance response open indefinitely.
 * Deliberately looser than any single restClient call's 15s: a check like
 * orphanedResources.ts fans out to ~13 parallel ARM calls plus a possible
 * 429/503 retry on any of them (restClient.ts, capped at +5s) — 25s gives
 * that real-but-legitimate case headroom without approaching this app's
 * overall governance-page latency budget (see api/avd.ts's
 * GOVERNANCE_TIMEOUT_MS, the frontend's matching cold-load allowance).
 */
const CHECK_TIMEOUT_MS = 25_000;

/** Races `promise` against a `ms`-timeout, clearing the timer either way so a resolved/rejected `promise` never leaves a dangling timer behind. */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms running "${label}".`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Runs one check's `fetchXxx` (bounded by CHECK_TIMEOUT_MS) and normalizes
 * ANY thrown error or timeout into an 'unknown' result rather than letting
 * it propagate — so a single check failing (transient ARM 500, a hung
 * call, a bug in the check itself) degrades ONLY that row on the
 * Governance page, not the whole GET /v1/governance response (same
 * "one bad item doesn't fail the whole batch" posture as costService.ts's
 * per-resource-group handling and healthService.ts's per-host power-state
 * resolution).
 *
 * ERROR REDACTION (peer review item 9): the full error (including any raw
 * ARM/Graph error text — resource paths, subscription ids, service error
 * messages) is logged server-side ONLY, via `logger.error`, tagged with a
 * fresh `randomUUID()` correlationId. The RETURNED check's `evidence` never
 * contains that raw text — only `{ correlationId }`, matching the same
 * "log full detail server-side, return only a correlation id" pattern
 * app/api/src/functions/*.ts's own catch-all 502 handlers already use
 * (e.g. alertsList.ts) — every governance check is viewer+ readable, so its
 * evidence must never be a vector for leaking ARM/Graph internals to every
 * signed-in user.
 */
export async function runCheckSafely(
  id: string,
  title: string,
  category: string,
  fetchFn: () => Promise<GovernanceCheckResult>,
  logger: GovernanceLogger,
): Promise<GovernanceCheckResult> {
  const startedAt = Date.now();
  try {
    const result = await withTimeout(fetchFn(), CHECK_TIMEOUT_MS, id);
    logger.log(`governance check completed | id=${id} status=${result.status} durationMs=${Date.now() - startedAt}`);
    return result;
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    const correlationId = randomUUID();
    logger.error(`governance check failed | id=${id} durationMs=${durationMs} correlationId=${correlationId}`, error);
    return buildResult({
      id,
      title,
      category,
      status: 'unknown',
      summary: `This check failed to run. Reference: ${correlationId}`,
      evidence: { correlationId },
    });
  }
}

/** Caps an evidence list array at `limit` entries, recording the true count separately so a truncated list is never silently mistaken for a complete one. */
export function boundList<T>(items: T[], limit: number): { items: T[]; totalCount: number; truncated: boolean } {
  return { items: items.slice(0, limit), totalCount: items.length, truncated: items.length > limit };
}
