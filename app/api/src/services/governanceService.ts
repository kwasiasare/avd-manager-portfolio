import type { GovernanceCheckResult, GovernanceCheckStatus, GovernanceSummary } from '@avdmgr/shared';
import { GOVERNANCE_CHECKS, runAllChecks } from './governance/registry';

/**
 * AM-16 (M3b) — GET /v1/governance's cache/orchestration layer. Same
 * in-memory TTL + in-flight-promise-dedupe pattern as
 * costService.ts#getCostSummary (see that function's doc comment for the
 * full reasoning, including the Flex-Consumption-cold-start caveat that
 * applies here identically): the check registry issues a LOT of ARM/Graph
 * calls (10 checks, several with multiple calls each — see
 * governance/orphanedResources.ts alone), so a ~10min cache is what makes
 * "load the Governance page" not mean "re-run 20+ Azure calls on every
 * page view."
 *
 * PEER REVIEW FIX (item 13): when the computed summary has ANY 'unknown'
 * check (a missing config value, an ungranted Graph permission, a
 * transient ARM failure — see support.ts's runCheckSafely), the cache TTL
 * drops to DEGRADED_CACHE_TTL_MS (60s) instead of the full 10min. An
 * 'unknown' result is far more likely to be a transient/fixable condition
 * an operator is actively working through (e.g. mid-way through granting
 * the Graph permission in docs/app-registration.md section 9) than a
 * genuinely stable pass/warn/fail state, so it's worth re-checking much
 * sooner — same "degrade the cache lifetime, don't just degrade the data"
 * posture costService.ts's own FULL_CACHE_TTL_MS/DEGRADED_CACHE_TTL_MS
 * split already established for a partially-failed cost summary.
 */
const FULL_CACHE_TTL_MS = 10 * 60 * 1000;
const DEGRADED_CACHE_TTL_MS = 60 * 1000;

/**
 * PEER REVIEW FIX (item 10): server-side floor on how often a forced
 * (?refresh=true) re-run can actually re-hit Azure/Graph, independent of
 * the role gate app/api/src/functions/governance.ts enforces on the
 * REQUEST. This registry issues dozens of ARM/Graph calls per run — a
 * well-meaning operator mashing the refresh button (or a scripted/
 * automated caller) must not be able to turn that into a hot loop against
 * Azure. Within this window, a forceRefresh request is silently served
 * from cache (cached: true) instead of rejected outright — the caller
 * still gets a fast, valid response, just not a guaranteed-fresh one.
 */
const MIN_REFRESH_INTERVAL_MS = 60 * 1000;

let cachedSummary: { value: GovernanceSummary; expiresAt: number } | undefined;
let inFlightRequest: Promise<GovernanceSummary> | undefined;
let lastForcedRunAt: number | undefined;

function computeCounts(checks: GovernanceCheckResult[]): GovernanceSummary['counts'] {
  const counts: Record<GovernanceCheckStatus, number> = { pass: 0, warn: 0, fail: 0, unknown: 0 };
  for (const check of checks) {
    counts[check.status] += 1;
  }
  return counts;
}

async function runAndCache(warn: (message: string) => void, log: (message: string) => void, error: (message: string, err?: unknown) => void): Promise<GovernanceSummary> {
  const startedAt = Date.now();
  const checks = await runAllChecks({ warn, log, error });
  const counts = computeCounts(checks);
  const summary: GovernanceSummary = { checks, counts, generatedAt: new Date().toISOString(), cached: false };
  const degraded = counts.unknown > 0;
  log(
    `Governance summary computed in ${Date.now() - startedAt}ms across ${GOVERNANCE_CHECKS.length} check(s) (pass=${counts.pass} warn=${counts.warn} fail=${counts.fail} unknown=${counts.unknown} degraded=${degraded})`,
  );
  cachedSummary = { value: summary, expiresAt: Date.now() + (degraded ? DEGRADED_CACHE_TTL_MS : FULL_CACHE_TTL_MS) };
  return summary;
}

export interface GetGovernanceSummaryOptions {
  forceRefresh?: boolean;
  warn?: (message: string) => void;
  log?: (message: string) => void;
  error?: (message: string, err?: unknown) => void;
}

/**
 * Returns the cached governance summary if fresh, else runs every check.
 * `forceRefresh` (the Governance page's refresh button —
 * app/api/src/functions/governance.ts's `?refresh=true`, already gated to
 * operator+ at the HTTP layer — see that file) bypasses a still-fresh
 * cache entry, SUBJECT TO MIN_REFRESH_INTERVAL_MS above — every other
 * read-only endpoint in this app (cost, alerts, sessions) only ever
 * re-fetches on its own TTL/poll interval, but this page's checks are
 * explicitly described as something an operator wants to re-run on demand
 * (e.g. right after fixing a flagged gap), so a plain re-request that just
 * replays the cache would defeat that button's purpose — within the
 * floor, it does.
 */
export async function getGovernanceSummary(options: GetGovernanceSummaryOptions = {}): Promise<GovernanceSummary> {
  const { forceRefresh = false, warn = () => {}, log = () => {}, error = () => {} } = options;

  const withinRefreshFloor = forceRefresh && lastForcedRunAt !== undefined && Date.now() - lastForcedRunAt < MIN_REFRESH_INTERVAL_MS;
  if (withinRefreshFloor) {
    warn(`governance refresh request arrived within the ${MIN_REFRESH_INTERVAL_MS}ms minimum re-run interval — serving cache instead of re-running`);
  }
  const effectiveForceRefresh = forceRefresh && !withinRefreshFloor;

  if (!effectiveForceRefresh && cachedSummary && cachedSummary.expiresAt > Date.now()) {
    return { ...cachedSummary.value, cached: true };
  }
  if (inFlightRequest) {
    const result = await inFlightRequest;
    return { ...result, cached: true };
  }

  if (effectiveForceRefresh) {
    lastForcedRunAt = Date.now();
  }

  inFlightRequest = (async () => {
    try {
      return await runAndCache(warn, log, error);
    } finally {
      inFlightRequest = undefined;
    }
  })();

  return inFlightRequest;
}

/** Test-only: clears the module-level cache (and any in-flight promise reference / refresh-floor timestamp) so tests don't leak state across cases. */
export function _resetGovernanceSummaryCacheForTests(): void {
  cachedSummary = undefined;
  inFlightRequest = undefined;
  lastForcedRunAt = undefined;
}
