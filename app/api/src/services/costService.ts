import { DefaultAzureCredential } from '@azure/identity';
import { CostManagementClient } from '@azure/arm-costmanagement';
import type { QueryDefinition, QueryResult } from '@azure/arm-costmanagement';
import type { CostByResourceGroup, CostSummary } from '@avdmgr/shared';
import { getConfig } from '../lib/config';

/*
 * SDK choice: @azure/arm-costmanagement (CostManagementClient.query.usage)
 * over a hand-rolled REST call.
 *
 * Verified on Microsoft Learn/npm (2026-08): @azure/arm-costmanagement is at
 * npm major version 1.0.0 — a real GA release (not the "-beta.N" state
 * app/api/src/services/alertsService.ts had to reason about for
 * @azure/arm-alertsmanagement), tracks the current Cost Management REST API
 * (api-version 2026-06-01 as of this check), and is listed on Microsoft's
 * "Azure libraries packages for JavaScript" index without a deprecation
 * notice. No reason to drop to raw REST here — contrast with
 * @azure/monitor-query below, which genuinely is deprecated.
 *
 * RBAC: this service needs Cost Management Reader (GUID
 * 72fafb9e-0641-4937-9268-a91bfd8191a3 — confirmed against Microsoft's
 * "Azure built-in roles for Management and governance" page) at each
 * resource group scope it queries — see infra/main.bicep's rbac* module
 * invocations. Cost Management Query IS documented to work at resource
 * group scope ('/subscriptions/{id}/resourceGroups/{rg}' — confirmed
 * against Microsoft's "Understand and work with scopes" page), so this
 * queries per-RG rather than once at subscription scope with a
 * ResourceGroup-dimension filter: it costs more API calls (one per tracked
 * RG per query type, below), but keeps the managed identity's grant
 * scoped to exactly the resource groups this app is meant to read, matching
 * the least-privilege posture infra/modules/rbac.bicep already established
 * for Reader.
 *
 * COST MANAGEMENT FAILURE MODES (peer review item 6) — logged distinctly
 * (see describeCostManagementError below) because they need different
 * remediation:
 *   - 403 with a message referencing "view charges" / AO (Authorized
 *     Signatory / EA Administrator) permissions: the EA enrollment's
 *     "AO view charges" setting is disabled for this subscription — an
 *     EA-level billing setting, not an RBAC problem; the managed identity
 *     can hold Cost Management Reader correctly and still get this.
 *   - 403 without that hint: RBAC role not actually applied (propagation
 *     delay after a fresh deploy — Azure RBAC can take several minutes to
 *     propagate — or the role assignment genuinely failed/was reverted).
 *   - 429: Cost Management's own rate limiting. This service does not
 *     hand-roll retry-with-backoff — @azure/arm-costmanagement's underlying
 *     @azure-rest/core-client pipeline already includes a throttlingRetryPolicy
 *     (@azure/core-rest-pipeline) that retries a 429 honoring its Retry-After
 *     header automatically (up to 3 attempts by default). AM-39/peer-review
 *     MAJOR 2 (AM-40 wave): that built-in retry is BOUNDED, not ridden out —
 *     every query.usage call passes an `abortSignal` combining
 *     AbortSignal.timeout(PER_CALL_TIMEOUT_MS) with this fetch attempt's
 *     shared AbortController (see queryMonthToDate/queryLastMonth and
 *     callSignal below), so a throttled call is CUT OFF at
 *     PER_CALL_TIMEOUT_MS regardless of how long Retry-After actually asked
 *     for or how many of the SDK's own retry attempts it was mid-cycle
 *     through — the SDK's retry is never guaranteed to complete here. The
 *     short TTL cache (see getCostSummary) plus the failure-backoff cooldown
 *     (STALE_RETRY_BACKOFF_MS) are the primary mitigations for repeat
 *     requests during a throttled/slow window.
 *   - Anything else: logged verbatim with statusCode/code for triage.
 * POST-DEPLOY VERIFICATION: see app/README.md's "Cost Management
 * verification" note — a one-off `query.usage` smoke call per tracked
 * resource group, run once after deploying the Cost Management Reader
 * grants, to confirm the above 403 cases up front rather than discovering
 * them the first time a real user loads the Cost & Scaling page.
 */

let cachedClient: CostManagementClient | undefined;

function getClient(): CostManagementClient {
  if (!cachedClient) {
    const credential = new DefaultAzureCredential();
    cachedClient = new CostManagementClient(credential);
  }
  return cachedClient;
}

/**
 * The resource groups this cost dashboard attributes AVD spend to. See
 * app/api/src/lib/config.ts's resourceGroups field comments for why this
 * is 6 RGs (RG-AVD-HostPools/Images/Monitoring/Management/Network/Storage)
 * rather than the AM-25 story's literal 5-RG list (Storage was added
 * deliberately; Security was deliberately left out).
 */
function costTrackedResourceGroups(): string[] {
  const { resourceGroups } = getConfig();
  return [resourceGroups.hostPools, resourceGroups.images, resourceGroups.monitoring, resourceGroups.management, resourceGroups.network, resourceGroups.storage];
}

function scopeForResourceGroup(subscriptionId: string, resourceGroup: string): string {
  return `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}`;
}

/**
 * Cost Management's aggregation alias ("totalCost" in the request) is NOT
 * always the column name the response comes back under. Microsoft's Cost
 * Management "Query - Usage" REST reference sample responses consistently
 * show "PreTaxCost" as the response column for a Sum(PreTaxCost)
 * aggregation — but peer review flagged that some metric/query-type
 * combinations (and, per community reports, some tenant/API-version
 * combinations) return the column literally named "Cost" instead. Both are
 * accepted here defensively; see findCostColumnIndex.
 */
const DAILY_COST_DATASET: QueryDefinition['dataset'] = {
  granularity: 'Daily',
  aggregation: { totalCost: { name: 'PreTaxCost', function: 'Sum' } },
};

const COST_COLUMN_NAMES = ['PreTaxCost', 'Cost'] as const;

/** One resource group's raw daily cost rows for both the query windows getCostSummary needs. */
export interface ResourceGroupCostRows {
  resourceGroup: string;
  /** Daily rows for the current month, 1st through the latest day Cost Management actually returned (timeframe MonthToDate). */
  monthToDateRows: DailyCostRow[];
  /** Daily rows for the entirety of last month (timeframe TheLastMonth). undefined if that query failed OR returned a shape we couldn't parse — treated as "not derivable" for this RG, not as zero. */
  lastMonthRows: DailyCostRow[] | undefined;
  currency: string | undefined;
}

export interface DailyCostRow {
  /** Day-of-month, 1-31, parsed from the API's YYYYMMDD UsageDate column. */
  dayOfMonth: number;
  cost: number;
}

/** Thrown by extractDailyRowsStrict when the response shape isn't what this service expects — see that function's doc comment for why the month-to-date path fails closed on this rather than silently reporting $0. */
export class CostQueryShapeError extends Error {}

function findColumnIndex(result: QueryResult | undefined, columnName: string): number {
  return (result?.columns ?? []).findIndex((column) => column.name === columnName);
}

function findCostColumnIndex(result: QueryResult | undefined): number {
  for (const name of COST_COLUMN_NAMES) {
    const index = findColumnIndex(result, name);
    if (index !== -1) return index;
  }
  return -1;
}

/** Parses a Cost Management API UsageDate cell (number, YYYYMMDD) into its day-of-month component. */
function dayOfMonthFromUsageDate(usageDate: number): number {
  return usageDate % 100;
}

/**
 * Strict row extraction: throws CostQueryShapeError when the response is
 * missing entirely, or is missing either the cost column (PreTaxCost/Cost)
 * or the UsageDate column, or contains a non-finite UsageDate value.
 *
 * PEER REVIEW FIX (item 1): the original version returned `[]` in all of
 * these cases, which made a genuine schema/shape problem (Cost Management
 * changed its response columns, or auth silently degraded to an empty
 * envelope) indistinguishable from "this resource group had zero cost
 * activity this month" (a real, valid `rows: []` with normal columns
 * present) — the former should fail loudly (per CostSummary's own doc
 * comment: "the frontend should render 'unavailable' rather than a
 * fabricated 0"), the latter should not. An empty `rows` array WITH valid
 * columns present is NOT an error and returns `[]` normally.
 */
function extractDailyRowsStrict(result: QueryResult | undefined, context: string): DailyCostRow[] {
  if (!result) {
    throw new CostQueryShapeError(`Cost Management returned no result for ${context}.`);
  }

  const costIndex = findCostColumnIndex(result);
  const dateIndex = findColumnIndex(result, 'UsageDate');
  if (costIndex === -1 || dateIndex === -1) {
    const gotColumns = (result.columns ?? []).map((column) => column.name).join(', ');
    throw new CostQueryShapeError(
      `Cost Management response for ${context} is missing expected columns (need one of [${COST_COLUMN_NAMES.join(', ')}] and UsageDate) — got: [${gotColumns}]`,
    );
  }

  // result.rows is populated via QueryResult's custom deserializer
  // (queryResultDeserializer) rather than a paged operation — this service
  // never reads/follows result.nextLink. That's deliberate, not an
  // oversight: Cost Management's per-RG, single-month, Daily-granularity
  // query this service issues returns at most ~31 rows, far under any
  // page-size limit that would trigger pagination in practice. If a wider
  // query (multi-month, ungrouped subscription-scope, etc.) is ever added
  // here, nextLink-following would need to be implemented — it is NOT
  // today.
  return (result.rows ?? []).map((row) => {
    const usageDateRaw = Number(row[dateIndex]);
    if (!Number.isFinite(usageDateRaw)) {
      throw new CostQueryShapeError(`Cost Management returned a non-numeric UsageDate for ${context}: ${JSON.stringify(row[dateIndex])}`);
    }
    return { cost: Number(row[costIndex]) || 0, dayOfMonth: dayOfMonthFromUsageDate(usageDateRaw) };
  });
}

/** Lenient wrapper for the non-load-bearing (prior-month) query path — a shape problem here degrades to "not derivable" for this one resource group rather than failing the whole /v1/cost/summary request. */
function extractDailyRowsLenient(result: QueryResult | undefined, context: string, warn: (message: string) => void): DailyCostRow[] | undefined {
  try {
    return extractDailyRowsStrict(result, context);
  } catch (error) {
    warn(error instanceof Error ? error.message : String(error));
    return undefined;
  }
}

function extractCurrency(result: QueryResult | undefined): string | undefined {
  const currencyIndex = findColumnIndex(result, 'Currency');
  const firstRow = result?.rows?.[0];
  return currencyIndex !== -1 && firstRow ? String(firstRow[currencyIndex]) : undefined;
}

/**
 * Distinguishes the Cost Management failure modes worth telling apart at
 * triage time (peer review item 6) — see this file's top comment for what
 * each one usually means. Azure SDK errors from @azure-rest/core-client
 * typically carry `statusCode` and, nested under `details`/`error`, a
 * machine-readable `code` (e.g. "AuthorizationFailed",
 * "RequestThrottled") — read defensively since the exact shape varies by
 * failure path (network error vs. HTTP error response).
 */
function describeCostManagementError(error: unknown): string {
  if (!error || typeof error !== 'object') {
    return String(error);
  }
  const err = error as { statusCode?: number; code?: string; message?: string; details?: { error?: { code?: string; message?: string } } };
  const statusCode = err.statusCode;
  const code = err.code ?? err.details?.error?.code;
  const message = err.details?.error?.message ?? err.message ?? String(error);

  let hint = '';
  if (statusCode === 403 && /view charges|AO/i.test(message)) {
    hint = ' [LIKELY CAUSE: EA enrollment "AO view charges" setting disabled for this subscription — a billing-level setting, not an RBAC problem]';
  } else if (statusCode === 403) {
    hint = ' [LIKELY CAUSE: Cost Management Reader role not yet propagated (can take several minutes after a fresh deploy) or the role assignment is missing/reverted]';
  } else if (statusCode === 429) {
    hint = ' [LIKELY CAUSE: Cost Management API rate limiting]';
  }

  return `statusCode=${statusCode ?? 'unknown'} code=${code ?? 'unknown'} message=${message}${hint}`;
}

/**
 * AM-39, revised under AM-40 peer review MINOR 2 — bounds a SINGLE Cost
 * Management query.usage call. Passed as `abortSignal` (an
 * @azure-rest/core-client OperationOptions field — see
 * QueryUsageOptionalParams) so it cuts off not just the initial request but
 * also any time the SDK's pipeline spends inside its own built-in
 * throttlingRetryPolicy honoring a 429's Retry-After header
 * (@azure/core-rest-pipeline — this app does not hand-roll 429 handling for
 * Cost Management; the SDK's default pipeline already retries 429s
 * respecting Retry-After, up to 3 attempts). Raised from an original 8s to
 * 12s (peer review MINOR 2): at 8s, a throttled call whose Retry-After asked
 * for anything beyond a few seconds could never let the SDK's own retry
 * complete even ONE cycle — this value does not exist to let that retry run
 * to completion (it usually still won't, and that's fine — a throttled call
 * is meant to be CUT OFF here, not ridden out to whatever Retry-After Cost
 * Management asks for); 12s is simply a slightly more realistic bound for a
 * single legitimately-slow-but-not-throttled call to still succeed before
 * this app gives up on it. Without this bound at all, a single slow or
 * repeatedly-throttled RG could hold the whole month-to-date/prior-month
 * fan-out open indefinitely — this is what previously let a stuck request
 * wedge getCostSummary's inFlightRequest open forever (see that function's
 * doc comment), so every subsequent manual Refresh just re-awaited the same
 * never-settling promise instead of trying again.
 */
const PER_CALL_TIMEOUT_MS = 12_000;

/**
 * AM-40 peer review MINOR 1 — combines PER_CALL_TIMEOUT_MS with `controller`,
 * the ONE AbortController shared by every query.usage call in a single
 * getCostSummary fetch ATTEMPT (see fetchResourceGroupCostRows/getCostSummary
 * below). Previously each call only had its own independent
 * AbortSignal.timeout — when the WHOLE attempt's TOTAL_FETCH_BUDGET_MS
 * elapsed (withTimeout below), the still-in-flight calls were merely
 * abandoned (their result ignored), not actually cancelled: they kept
 * running against the SDK/network until their own individual timeout fired
 * on its own schedule, meaning a new fetch attempt could end up running
 * CONCURRENTLY with straggler calls from a previous, already-timed-out
 * attempt. Aborting `controller` in withTimeout's timeout branch now
 * actually cancels every in-flight call for that attempt immediately, so no
 * overlapping fan-outs run.
 */
function callSignal(controller: AbortController): AbortSignal {
  return AbortSignal.any([controller.signal, AbortSignal.timeout(PER_CALL_TIMEOUT_MS)]);
}

async function queryMonthToDate(resourceGroup: string, controller: AbortController): Promise<QueryResult | undefined> {
  const client = getClient();
  const { subscriptionId } = getConfig();
  const definition: QueryDefinition = { type: 'ActualCost', timeframe: 'MonthToDate', dataset: DAILY_COST_DATASET };
  return client.query.usage(scopeForResourceGroup(subscriptionId, resourceGroup), definition, { abortSignal: callSignal(controller) });
}

async function queryLastMonth(resourceGroup: string, controller: AbortController): Promise<QueryResult | undefined> {
  const client = getClient();
  const { subscriptionId } = getConfig();
  const definition: QueryDefinition = { type: 'ActualCost', timeframe: 'TheLastMonth', dataset: DAILY_COST_DATASET };
  return client.query.usage(scopeForResourceGroup(subscriptionId, resourceGroup), definition, { abortSignal: callSignal(controller) });
}

/** Runs `items` through `fn` with at most `limit` in flight at once — a small hand-rolled pool rather than pulling in a dependency for this one use. Order of results matches `items`. */
async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      results[index] = await fn(items[index]);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

/** Bounded concurrency (peer review item 8) for the per-resource-group Cost Management fan-out — 6 tracked RGs x 2 query windows = up to 12 calls; capping at 4 concurrent avoids bursting a rate-limited API even though this service's own footprint is modest. */
const COST_QUERY_CONCURRENCY = 4;

/**
 * Fetches raw daily cost rows for every tracked resource group. The
 * month-to-date query is load-bearing (its failure fails the whole
 * summary — see getCostSummary's catch, and extractDailyRowsStrict's doc
 * comment on why a shape problem there also throws) since it's what
 * monthToDateCost and byResourceGroup are built from; the prior-month
 * query degrades per-RG to `undefined` on failure OR a shape problem
 * rather than failing the whole request — computeCostSummary then only
 * reports priorMonthSamePeriodCost when EVERY resource group succeeded
 * (peer review item 2 — a partial sum across only the RGs that happened to
 * succeed would silently understate the comparison).
 *
 * `controller` (AM-40 peer review MINOR 1) — the shared AbortController for
 * this one fetch ATTEMPT, threaded into every query.usage call via
 * callSignal above. Defaults to a fresh, never-aborted controller so
 * existing callers (including this file's tests) that don't care about
 * cross-attempt cancellation can omit it entirely.
 */
export async function fetchResourceGroupCostRows(
  warn: (message: string) => void = () => {},
  log: (message: string) => void = () => {},
  controller: AbortController = new AbortController(),
): Promise<ResourceGroupCostRows[]> {
  const resourceGroups = costTrackedResourceGroups();

  return mapWithConcurrency(resourceGroups, COST_QUERY_CONCURRENCY, async (resourceGroup): Promise<ResourceGroupCostRows> => {
    const mtdStartedAt = Date.now();
    let monthToDateResult: QueryResult | undefined;
    try {
      monthToDateResult = await queryMonthToDate(resourceGroup, controller);
      log(`Cost Management month-to-date query for ${resourceGroup} completed in ${Date.now() - mtdStartedAt}ms`);
    } catch (error) {
      throw new Error(`Cost Management month-to-date query for ${resourceGroup} failed after ${Date.now() - mtdStartedAt}ms: ${describeCostManagementError(error)}`, { cause: error });
    }

    const lastMonthStartedAt = Date.now();
    const lastMonthResult = await queryLastMonth(resourceGroup, controller)
      .then((result) => {
        log(`Cost Management prior-month query for ${resourceGroup} completed in ${Date.now() - lastMonthStartedAt}ms`);
        return result;
      })
      .catch((error: unknown) => {
        warn(`Cost Management prior-month query for ${resourceGroup} failed after ${Date.now() - lastMonthStartedAt}ms: ${describeCostManagementError(error)}`);
        return undefined;
      });

    return {
      resourceGroup,
      monthToDateRows: extractDailyRowsStrict(monthToDateResult, `${resourceGroup} month-to-date`),
      lastMonthRows: lastMonthResult ? extractDailyRowsLenient(lastMonthResult, `${resourceGroup} prior-month`, warn) : undefined,
      currency: extractCurrency(monthToDateResult) ?? extractCurrency(lastMonthResult),
    };
  });
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function sumCost(rows: DailyCostRow[]): number {
  return rows.reduce((total, row) => total + row.cost, 0);
}

function daysInMonthUtc(year: number, monthIndex0: number): number {
  // Day 0 of the *next* month is the last day of this one. monthIndex0 may
  // be -1 (December of the prior year) or 12 — Date.UTC normalizes both.
  return new Date(Date.UTC(year, monthIndex0 + 1, 0)).getUTCDate();
}

/** Minimum complete days of month-to-date data required before a linear projection is reported at all (peer review item 9) — a 1-day (or 0-day) sample is too noisy to extrapolate a whole month from. */
const MIN_DAYS_FOR_PROJECTION = 2;

/**
 * Pure mapping from per-resource-group daily cost rows to the CostSummary
 * DTO — separated from fetchResourceGroupCostRows (the Azure-calling half)
 * specifically so it can be unit tested with fixture rows and no mocked
 * SDK client at all. `now` defaults to the real current time; tests pass a
 * fixed Date.
 *
 * DAY-COMPLETENESS (peer review item 9): the latest day-of-month actually
 * present in monthToDateRows is `latestReportedDay`. If that equals
 * TODAY's day-of-month, it's treated as a potentially partial/
 * not-yet-fully-ingested day and EXCLUDED from monthToDateCost, asOfDate,
 * and the day-count used for the prior-month comparison and the
 * projection — UNLESS it's the only day of data available (day 1 of the
 * month), in which case there's nothing safer to fall back to and it's
 * kept, accepting monthToDateCost may be a slight undercount that day.
 * asOfDate is therefore the last COMPLETE day, not `now`.
 *
 * PROJECTION METHOD (documented per the AM-25 story's requirement): simple
 * linear projection — (monthToDateCost / completeDaysElapsed) *
 * daysInThisMonth, using only complete days per the above. No accounting
 * for known future ramp changes or weekday/weekend usage patterns.
 *
 * PRIOR-MONTH COMPARISON (peer review item 2): only computed when EVERY
 * resource group returned prior-month data — see ResourceGroupCostRows'
 * doc comment. The comparison window is clamped to
 * min(completeDaysElapsed, daysInPriorMonth) (peer review item 9) so a
 * 31-day "same period" is never requested against a 28/29/30-day prior
 * month.
 */
export function computeCostSummary(perResourceGroup: ResourceGroupCostRows[], now: Date = new Date()): CostSummary {
  const currency = perResourceGroup.find((rg) => rg.currency)?.currency ?? 'USD';

  const allMtdDays = perResourceGroup.flatMap((rg) => rg.monthToDateRows.map((row) => row.dayOfMonth));
  const latestReportedDay = allMtdDays.length > 0 ? Math.max(...allMtdDays) : undefined;
  const todayDayOfMonth = now.getUTCDate();

  const completeDaysElapsed =
    latestReportedDay === undefined
      ? 0
      : latestReportedDay === todayDayOfMonth && latestReportedDay > 1
        ? latestReportedDay - 1
        : latestReportedDay;

  const byResourceGroup: CostByResourceGroup[] = perResourceGroup.map((rg) => ({
    resourceGroup: rg.resourceGroup,
    cost: round2(sumCost(rg.monthToDateRows.filter((row) => row.dayOfMonth <= completeDaysElapsed))),
  }));
  const monthToDateCost = round2(byResourceGroup.reduce((total, rg) => total + rg.cost, 0));

  const asOfDate =
    completeDaysElapsed > 0
      ? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), completeDaysElapsed)).toISOString().slice(0, 10)
      : now.toISOString().slice(0, 10);

  const daysInPriorMonth = daysInMonthUtc(now.getUTCFullYear(), now.getUTCMonth() - 1);
  const priorMonthWindowDays = Math.min(completeDaysElapsed, daysInPriorMonth);

  const allRgsHavePriorMonthData = perResourceGroup.length > 0 && perResourceGroup.every((rg) => rg.lastMonthRows !== undefined);
  const priorMonthSamePeriodCost =
    allRgsHavePriorMonthData && priorMonthWindowDays > 0
      ? round2(
          perResourceGroup.reduce(
            (total, rg) => total + sumCost((rg.lastMonthRows ?? []).filter((row) => row.dayOfMonth <= priorMonthWindowDays)),
            0,
          ),
        )
      : undefined;

  const daysInThisMonth = daysInMonthUtc(now.getUTCFullYear(), now.getUTCMonth());
  const projectedMonthEndCost =
    completeDaysElapsed >= MIN_DAYS_FOR_PROJECTION ? round2((monthToDateCost / completeDaysElapsed) * daysInThisMonth) : undefined;

  return {
    currency,
    asOfDate,
    monthToDateCost,
    priorMonthSamePeriodCost,
    projectedMonthEndCost,
    byResourceGroup,
    // AM-40 peer review MAJOR 3 — cache-write-time timestamp, distinct from
    // asOfDate's day-granularity DATA freshness. `now` here is the SAME
    // instant this function's caller (getCostSummary) treats as "when this
    // summary was computed" — see CostSummary.computedAt's own doc comment
    // in @avdmgr/shared for why the frontend needs this specifically for
    // the stale-cache caveat.
    computedAt: now.toISOString(),
  };
}

/**
 * In-memory TTL cache (peer review item 7, revised under AM-39, revised
 * again under AM-40 peer review MAJOR 1): the resolved CostSummary is
 * cached for FULL_CACHE_TTL_MS when every resource group's prior-month
 * query succeeded, or the shorter DEGRADED_CACHE_TTL_MS when it didn't — a
 * degraded result (missing priorMonthSamePeriodCost/projectedMonthEndCost)
 * is worth re-checking sooner.
 *
 * COUPLING TO COST_POLL_INTERVAL_MS (peer review MAJOR 1 — do not re-break
 * this): the frontend's Cost page polls GET /v1/cost/summary every
 * COST_POLL_INTERVAL_MS (app/frontend/src/lib/config.ts, currently 5 min).
 * AM-39's original TTLs (5min full / 2min degraded) were WRONG for exactly
 * this reason — a 5-minute FULL_CACHE_TTL_MS sitting behind a 5-minute poll
 * means every single scheduled poll lands just as (or just after) the cache
 * expires, so EVERY poll misses the cache and triggers the full 12-call
 * Cost Management fan-out — ~12x more calls to the exact upstream whose
 * slowness/throttling caused the original AM-39 bug, on an ongoing basis,
 * not just during an incident. FULL_CACHE_TTL_MS MUST stay at least 2-3x
 * COST_POLL_INTERVAL_MS so a normal scheduled poll finds a warm cache more
 * often than not (15 min = 3x 5 min, satisfies this). DEGRADED_CACHE_TTL_MS
 * is a deliberate, documented EXCEPTION to that same rule, not an oversight:
 * a degraded result means something is ALREADY wrong (one resource group's
 * prior-month query is failing), and it's a reasonable product trade-off to
 * accept the extra fan-out cost of re-checking on every poll tick (5 min =
 * 1x COST_POLL_INTERVAL_MS) while in that abnormal state, rather than
 * leaving priorMonthSamePeriodCost/projectedMonthEndCost missing for 2-3
 * poll cycles after the underlying problem has already cleared.
 *
 * While a fetch is in flight, concurrent callers await the SAME promise
 * (inFlightRequest) instead of each starting their own — without this, N
 * requests arriving during a cold start (before the cache is populated)
 * would each independently fan out to all 6 resource groups.
 *
 * Cold-start caveat (Flex Consumption): Flex Consumption scales instances
 * to zero and spins up fresh ones on demand (see
 * infra/modules/functionapp.bicep) — a fresh instance has an empty cache,
 * so the first request to hit it after a cold start still pays the full
 * ~12-call Cost Management latency, cache or no cache (the in-flight-promise
 * dedupe above only helps CONCURRENT requests against that same cold
 * instance, not the cold start itself). This module-level cache only
 * helps subsequent requests routed to the SAME warm instance within the
 * TTL window; it provides no cross-instance or cross-cold-start benefit. A
 * durable cache (e.g. a small Table/Blob entry, or leaning on Cost
 * Management's own cached-aggregation behavior) would be needed to fix
 * that — out of scope for this story.
 */
const FULL_CACHE_TTL_MS = 15 * 60 * 1000;
const DEGRADED_CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * AM-40 peer review MAJOR 2 — after a FAILED refresh, the next request must
 * not immediately re-attempt the whole 20s-bounded fan-out again (that's a
 * retry storm under sustained throttling: every request arriving during an
 * outage hammers Cost Management as fast as TOTAL_FETCH_BUDGET_MS allows,
 * back to back). Within this cooldown window after a failure (tracked via
 * lastFailureAt below), getCostSummary serves the existing stale cached
 * value WITHOUT starting a new fetch at all — see the `now - lastFailureAt`
 * check in getCostSummary. 45s: short enough that a genuinely transient
 * blip recovers quickly once it clears, long enough to meaningfully back off
 * a sustained throttling window rather than retrying every request.
 */
const STALE_RETRY_BACKOFF_MS = 45_000;

/**
 * AM-39 — hard ceiling on how long a single getCostSummary fetch attempt is
 * allowed to run, regardless of how many of the 6 tracked resource groups
 * are slow/throttled. PER_CALL_TIMEOUT_MS already bounds any ONE
 * query.usage call, but with 6 RGs at concurrency 4 (COST_QUERY_CONCURRENCY)
 * and 2 sequential queries (month-to-date then prior-month) per RG, a
 * pathological worst case could still stack up past the per-call bound.
 * This wraps the whole fetchResourceGroupCostRows() call in a race against
 * a plain setTimeout-based timeout (deliberately NOT AbortSignal.timeout —
 * this one is unit-tested with vi.useFakeTimers, which doesn't reliably
 * intercept the platform AbortSignal.timeout implementation) so a caller
 * (costSummary.ts's HTTP handler, and transitively the frontend's Cost
 * page) never blocks past ~20s total for this endpoint either way.
 */
const TOTAL_FETCH_BUDGET_MS = 20_000;

/** Distinguished (peer review NIT) via `instanceof` in getCostSummary's catch so a total-budget timeout logs distinctly from a genuine Cost Management error. */
class CostSummaryTimeoutError extends Error {}

/**
 * `controller` (AM-40 peer review MINOR 1) is aborted in the timeout branch
 * — every query.usage call sharing this attempt's controller (see
 * callSignal above) is cancelled immediately, rather than left to run to
 * its own individual PER_CALL_TIMEOUT_MS cap in the background after this
 * function has already rejected.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, message: string, controller: AbortController): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      const timeoutError = new CostSummaryTimeoutError(message);
      controller.abort(timeoutError);
      reject(timeoutError);
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

let cachedSummary: { value: CostSummary; expiresAt: number } | undefined;
let inFlightRequest: Promise<CostSummary> | undefined;
/** AM-40 peer review MAJOR 2 — wall-clock instant (Date.now()) of the most recent FAILED fetch attempt, or undefined if none has ever failed (or the cache has never existed). Cleared on the next successful fetch. See STALE_RETRY_BACKOFF_MS. */
let lastFailureAt: number | undefined;

/**
 * AM-39 root-cause fix: the ORIGINAL bug ("Cost page sometimes times out and
 * doesn't recover on refresh") was that a slow/throttled Cost Management
 * call had no bound at all — a single stuck fetch left `inFlightRequest`
 * pointing at a promise that might never settle, so EVERY subsequent
 * request (including a manual Refresh click, well after the frontend's own
 * 30s fetch timeout had already given up and shown an error) just re-awaited
 * that same wedged promise and timed out again, forever, until the Function
 * App instance recycled. Two independent bounds now guarantee
 * `inFlightRequest` always settles within ~20s: PER_CALL_TIMEOUT_MS on each
 * individual query.usage call, and TOTAL_FETCH_BUDGET_MS on the whole
 * fetchResourceGroupCostRows() call via withTimeout above. A manual Refresh
 * therefore always gets either a fresh live result, or (see below) a stale
 * cached one — never an indefinite hang.
 *
 * On a failed fetch (upstream error OR TOTAL_FETCH_BUDGET_MS exceeded),
 * this now serves the LAST successful cachedSummary — even if its TTL has
 * already expired — with `stale: true` set, rather than propagating the
 * failure as a 502 (see costSummary.ts). Only when there has NEVER been a
 * successful fetch (cachedSummary is still undefined) does the error
 * propagate, so the very first cold call still correctly surfaces a real
 * error rather than fabricating data. A failed fetch never overwrites
 * cachedSummary — "never cache failures" (estateSummaryService pattern).
 *
 * AM-40 peer review MAJOR 2 — a cached value that's expired AND within
 * STALE_RETRY_BACKOFF_MS of the last failure is served stale IMMEDIATELY,
 * without starting a new fetch attempt at all (no inFlightRequest is ever
 * created for this case) — see the `lastFailureAt` check below, which runs
 * before the inFlightRequest dedup check.
 */
export async function getCostSummary(warn: (message: string) => void = () => {}, log: (message: string) => void = () => {}): Promise<CostSummary> {
  const now = Date.now();
  if (cachedSummary && cachedSummary.expiresAt > now) {
    return cachedSummary.value;
  }
  if (cachedSummary && lastFailureAt !== undefined && now - lastFailureAt < STALE_RETRY_BACKOFF_MS) {
    return { ...cachedSummary.value, stale: true };
  }
  if (inFlightRequest) {
    return inFlightRequest;
  }

  inFlightRequest = (async () => {
    const controller = new AbortController();
    try {
      const startedAt = Date.now();
      const perResourceGroup = await withTimeout(
        fetchResourceGroupCostRows(warn, log, controller),
        TOTAL_FETCH_BUDGET_MS,
        `Cost summary fetch exceeded its ${TOTAL_FETCH_BUDGET_MS}ms total budget`,
        controller,
      );
      const summary = computeCostSummary(perResourceGroup);
      const degraded = perResourceGroup.some((rg) => rg.lastMonthRows === undefined);
      log(`Cost summary computed in ${Date.now() - startedAt}ms across ${perResourceGroup.length} resource group(s) (degraded=${degraded})`);
      cachedSummary = { value: summary, expiresAt: Date.now() + (degraded ? DEGRADED_CACHE_TTL_MS : FULL_CACHE_TTL_MS) };
      lastFailureAt = undefined;
      return summary;
    } catch (error) {
      lastFailureAt = Date.now();
      if (cachedSummary) {
        // Peer review NIT: distinguish the total-budget-timeout case from a genuine upstream error for triage — both still fall back to serving stale.
        const reason = error instanceof CostSummaryTimeoutError ? `total fetch budget exceeded (${error.message})` : error instanceof Error ? error.message : String(error);
        warn(`Cost summary refresh failed (${reason}) — serving the last successful result with stale:true instead of failing the request.`);
        return { ...cachedSummary.value, stale: true };
      }
      throw error;
    } finally {
      inFlightRequest = undefined;
    }
  })();

  return inFlightRequest;
}

/** Test-only: clears the module-level cache (and any in-flight promise reference/failure-backoff state) so tests don't leak state across cases. */
export function _resetCostSummaryCacheForTests(): void {
  cachedSummary = undefined;
  inFlightRequest = undefined;
  lastFailureAt = undefined;
}
