/**
 * Pure validation/guard-rail helpers for the AM-24 Log Analytics endpoints
 * (GET /v1/alerts, GET/POST /v1/logs/*, see
 * app/api/src/functions/alertsList.ts, logsViews.ts, logsViewRun.ts,
 * logsQuery.ts). Kept side-effect-free and Azure-SDK-free so they're cheap
 * to unit test (see logsGuard.test.ts) and so every route validates request
 * shape BEFORE touching AlertsManagementClient/LogsQueryClient.
 *
 * SECURITY POSTURE (raw KQL, POST /v1/logs/query — see
 * app/api/src/functions/logsQuery.ts and
 * app/api/src/services/logsService.ts), corrected after peer review:
 *
 * The Function App's managed identity holds Log Analytics Reader scoped to
 * the LAW-CONTOSO-PROD workspace RESOURCE (infra/main.bicep — narrowed from an
 * earlier resource-group-scope grant specifically because RG scope would
 * have let a query reach ANY workspace ever deployed into
 * RG-AVD-Monitoring, not just this one). That scoping change genuinely
 * bounds arbitrary KQL to "read logs in LAW-CONTOSO-PROD" — but it does NOT
 * mean only the AVD diagnostics tables (WVDConnections etc.) are reachable:
 *   - This app's own Application Insights resource is WORKSPACE-BASED
 *     (functionapp.bicep's `appInsights` resource sets
 *     WorkspaceResourceId to this same LAW), so its telemetry — AppRequests,
 *     AppTraces, AppExceptions, including OTHER USERS' request data — is
 *     ingested into LAW-CONTOSO-PROD and is therefore queryable by anyone who
 *     can run raw KQL here, workspace scoping or not (verified on Learn:
 *     "If you're using a workspace-based Application Insights resource,
 *     telemetry is stored in a Log Analytics workspace with all other log
 *     data"). There's no per-table RBAC configured on this workspace that
 *     would carve those tables out; adding one is a real option but out of
 *     scope for AM-24.
 *   - The identity's SEPARATE plain-Reader grants on RG-AVD-HostPools and
 *     RG-AVD-Images (infra/main.bicep's rbacHostPools/rbacImages modules)
 *     leave a genuine, narrower residual cross-reach: KQL's `resource()`
 *     function permits resource-context queries against anything the
 *     caller can Read (Learn: "Resource-context ... Read access to the
 *     resource"), so a query could in principle pull Monitor Logs
 *     associated with resources in those two resource groups too — this is
 *     NOT eliminated by the workspace-scope narrowing above, since it's a
 *     property of the identity's OTHER grants, not this one.
 * None of the above is a privilege-escalation or data-MODIFICATION risk —
 * KQL has no write surface (no INSERT/UPDATE/DELETE), and every avenue
 * above still requires an RBAC grant this identity already legitimately
 * holds for other reasons — but it is real read-side blast radius beyond
 * "just the AVD tables," and app/README.md's Monitoring & logs section
 * states it honestly rather than claiming an isolation that doesn't exist.
 *
 * The guard-rails below are about blast radius and cost on top of that RBAC
 * reality, not a substitute for it: a very long or very wide-ranging query
 * against a workspace with a 1 GB/day ingestion cap (see
 * app/api/src/services/alertsService.ts's top-of-file comment) could still
 * be slow, expensive, or return an unbounded number of rows to the browser.
 * Hence:
 *   - MAX_KQL_LENGTH (8 KiB): bounds query complexity / accidental paste of
 *     something huge.
 *   - MAX_TIMESPAN_HOURS (168h / 7d): bounds how much data a single query
 *     scans, well under the AlertsGetAllOptionalParams.customTimeRange /
 *     LogsQueryOptions time-range ceilings Azure itself enforces (30d).
 *   - MAX_RESULT_ROWS (1000): trims the RESPONSE sent back to the browser
 *     to a renderable size — it does NOT bound what Log Analytics itself
 *     computes or returns to the SDK first; see capRows below for the full
 *     correction on this point.
 * The query text itself is passed to LogsQueryClient as the `query`
 * argument (a distinct parameter from the time range), never string-concatenated
 * with anything this app controls — see logsService.ts.
 */

import type { ApiError } from '@avdmgr/shared';

/** GET /v1/alerts?hours= bounds — 1 hour minimum, 7 days (168h) maximum. */
export const MIN_ALERT_HOURS = 1;
export const MAX_ALERT_HOURS = 168;

/** Curated + raw KQL query time-range bounds, in hours. */
export const MIN_TIMESPAN_HOURS = 1;
export const MAX_TIMESPAN_HOURS = 168;

/** Raw KQL text length cap (characters). */
export const MAX_KQL_LENGTH = 8_000;

/** Server-side row cap applied to every logs query response, curated or raw. */
export const MAX_RESULT_ROWS = 1000;

/** Snooze duration bounds, in hours, when the caller supplies `hours` instead of an absolute `untilIso`. */
export const MIN_SNOOZE_HOURS = 1;
export const MAX_SNOOZE_HOURS = 168;

export type ValidationResult = { ok: true; value: number } | { ok: false; error: ApiError };

function boundsError(code: string, message: string): ApiError {
  return { status: 400, code, message };
}

/**
 * Parses and validates an integer "hours"-shaped query-string value against
 * [min, max]. Returns the default when the raw value is undefined/empty
 * (query param omitted) — only an explicitly-supplied, out-of-range, or
 * non-numeric value is an error.
 *
 * AM-32 peer review MINOR 14: `fieldName` (default `'hours'`, matching every
 * pre-AM-32 caller's actual query-string param name) lets a caller whose
 * param is spelled differently — auditRecent.ts's `sinceHours` — get error
 * text that names ITS OWN param ("sinceHours must be...") instead of a
 * generic "hours must be..." that doesn't match what the caller actually
 * sent.
 */
export function parseHoursParam(raw: string | null | undefined, defaultHours: number, min: number, max: number, fieldName = 'hours'): ValidationResult {
  if (raw === null || raw === undefined || raw === '') {
    return { ok: true, value: defaultHours };
  }

  // Require a plain, unsigned decimal-integer string BEFORE handing it to
  // Number() — Number() itself is far too permissive (accepts "1e3",
  // "0x10", " 12 ", "Infinity", leading '+', etc.), any of which would
  // otherwise pass the finite+integer check below with a surprising parsed
  // value. A query-string param has no legitimate reason to be anything
  // other than plain digits.
  if (!/^\d+$/.test(raw)) {
    return { ok: false, error: boundsError('invalid_hours', `${fieldName} must be an integer between ${min} and ${max}.`) };
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    return { ok: false, error: boundsError('invalid_hours', `${fieldName} must be an integer between ${min} and ${max}.`) };
  }
  if (parsed < min || parsed > max) {
    return { ok: false, error: boundsError('hours_out_of_range', `${fieldName} must be between ${min} and ${max}.`) };
  }
  return { ok: true, value: parsed };
}

export type KqlValidationResult = { ok: true } | { ok: false; error: ApiError };

/** Validates raw KQL text length. Does not attempt to parse/lint the query itself (that's Kusto's job — a syntax error surfaces as a normal query failure). */
export function validateKqlLength(kql: unknown): KqlValidationResult {
  if (typeof kql !== 'string' || kql.trim().length === 0) {
    return { ok: false, error: boundsError('missing_kql', 'kql is required and must be a non-empty string.') };
  }
  if (kql.length > MAX_KQL_LENGTH) {
    return { ok: false, error: boundsError('kql_too_long', `kql must be at most ${MAX_KQL_LENGTH} characters.`) };
  }
  return { ok: true };
}

/** Validates timespanHours from a request body against [MIN_TIMESPAN_HOURS, MAX_TIMESPAN_HOURS]. */
export function validateTimespanHours(value: unknown): ValidationResult {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
    return { ok: false, error: boundsError('invalid_timespan', `timespanHours must be an integer between ${MIN_TIMESPAN_HOURS} and ${MAX_TIMESPAN_HOURS}.`) };
  }
  if (value < MIN_TIMESPAN_HOURS || value > MAX_TIMESPAN_HOURS) {
    return { ok: false, error: boundsError('timespan_out_of_range', `timespanHours must be between ${MIN_TIMESPAN_HOURS} and ${MAX_TIMESPAN_HOURS}.`) };
  }
  return { ok: true, value };
}

/**
 * Truncates a raw @azure/monitor-query-logs row array to MAX_RESULT_ROWS.
 * Returns a NEW array (never mutates `rows`) plus whether truncation
 * occurred, so callers can set LogsTableResult.truncated accurately.
 *
 * Peer review correction: this bounds the HTTP RESPONSE size (what the
 * Function App sends back to the browser), NOT worker memory or the query
 * itself — by the time capRows runs, LogsQueryClient has already resolved
 * the full result set into memory. Per Microsoft's documented Log Analytics
 * service limits (https://learn.microsoft.com/azure/azure-monitor/fundamentals/service-limits#log-analytics-workspaces),
 * a single query can return up to 500,000 rows / ~104 MB before Azure
 * itself caps it — MAX_RESULT_ROWS (1,000) is well under that ceiling and
 * exists purely to keep the RESPONSE small and renderable in the frontend
 * table, not to protect the Function App from an unbounded query. If a
 * genuinely huge (near-500K-row) result ever becomes a real memory/latency
 * concern for the Function App itself, the fix is query-side (a `| take` /
 * `| summarize` the caller should add, or a future server-side streaming
 * response) — not this cap, which only trims what's already been received.
 */
export function capRows<T>(rows: T[], maxRows: number = MAX_RESULT_ROWS): { rows: T[]; truncated: boolean } {
  if (rows.length <= maxRows) {
    return { rows, truncated: false };
  }
  return { rows: rows.slice(0, maxRows), truncated: true };
}
