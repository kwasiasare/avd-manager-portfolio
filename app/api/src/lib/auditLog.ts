import { randomUUID } from 'node:crypto';
import { TableClient, odata } from '@azure/data-tables';
import { DefaultAzureCredential } from '@azure/identity';
import { getConfig } from './config';

/**
 * Whether the audited mutation itself succeeded, failed, or (AM-19/M2-S2)
 * was merely accepted by ARM without the handler waiting for it to actually
 * finish — recorded regardless, so a failed drain/power attempt still shows
 * up in the log.
 *
 * 'accepted' is distinct from 'success': it means the ARM long-running
 * operation was submitted and Azure acknowledged it (e.g. a 202), but the
 * handler did NOT await the operation's completion (see
 * app/api/src/services/computeService.ts#beginVmPowerAction) — so unlike a
 * 'success' row, an 'accepted' row does not itself confirm the VM actually
 * reached the target power state, only that the request was accepted.
 */
export type AuditOutcome = 'success' | 'failure' | 'accepted';

/**
 * Structured logger a handler passes into writeAuditEntry. Deliberately a
 * narrow shape (not the full InvocationContext) so callers can pass
 * `context` directly (its warn/error/log methods are structurally
 * compatible) or a test double.
 */
export interface AuditLogger {
  warn: (message: string) => void;
  error: (message: string) => void;
  log: (message: string) => void;
}

/** Everything a mutating handler knows about the action it just attempted, before it becomes a table entity. */
export interface AuditEvent {
  /** UPN (or 'unknown') of the caller, from the client principal — see app/api/src/lib/auth.ts's ClientPrincipal.userDetails. Human-readable; NOT stable across a UPN rename — see actorId for that. */
  actor: string;
  /** Entra object ID (ClientPrincipal.userId) of the caller — stable even if the UPN changes, so audit rows stay attributable to the same identity over time. */
  actorId: string;
  /** Short machine-readable action id, e.g. 'sessionhost.drain'. */
  action: string;
  /** The resource acted on, e.g. a "{hostPoolName}/{sessionHostName}" pair. */
  target: string;
  /** What was actually done — e.g. { allowNewSession: false } — so "drain" vs "resume" (both action=sessionhost.drain) is distinguishable from the row alone. Stored as a JSON string (Table entities can't hold nested objects — see buildAuditEntity). */
  parameters?: Record<string, unknown>;
  /** Operator-supplied justification, if the caller provided one. Server-validated to <=1000 chars before this is constructed (see sessionHostDrain.ts) — Table's 32K string cap is not itself the bound callers should rely on. */
  reason?: string;
  outcome: AuditOutcome;
  /** Extra detail for a failure (e.g. the ARM error message) — omitted on success. */
  detail?: string;
  /** Generated once at the top of the request (see sessionHostDrain.ts) — the SAME value appears in the error response body (on failure), in context.log/error lines, and in this audit row, so a support ticket referencing it can be joined back to the exact audit record. */
  correlationId: string;
}

/**
 * Shape written to the AuditLog table. PartitionKey/RowKey are lowercase per
 * @azure/data-tables' TableEntity convention (the SDK maps them to the REST
 * API's PartitionKey/RowKey itself).
 *
 * IMPORTANT: this entity must NEVER declare a property literally named
 * `timestamp` (any casing) — @azure/data-tables' propertyCaseMap reverse-
 * translates it onto the Table service's own server-managed `Timestamp`
 * system property, so a value set here would be silently discarded on
 * insert (the entity keeps the server's insert time instead, with no error).
 * The event's own occurrence time is carried in `occurredAt` instead, which
 * has no such collision.
 */
export interface AuditEntity {
  partitionKey: string;
  rowKey: string;
  actor: string;
  actorId: string;
  action: string;
  target: string;
  parametersJson?: string;
  reason?: string;
  outcome: AuditOutcome;
  detail?: string;
  correlationId: string;
  /** ISO timestamp of when the event occurred, per this app — NOT the Table service's own server-managed Timestamp (see the interface-level comment above). */
  occurredAt: string;
}

/**
 * RowKey ordering trick: a plain ascending Table query sorts RowKey
 * lexically, so subtracting the event's epoch-ms from a fixed ceiling and
 * zero-padding to 13 digits makes newest-first the natural sort order. The
 * ceiling (9,999,999,999,999 ms since epoch) lands around November 2286 —
 * comfortably past any realistic entry, while staying a fixed 13 digits for
 * every date between now and then. A short random suffix avoids collisions
 * when two events land in the same millisecond (see the 409 retry in
 * writeAuditEntry for the case where the suffix ALSO collides).
 */
const REVERSE_TICKS_CEILING = 9_999_999_999_999;

/** Date-based partition (UTC, YYYY-MM-DD) — keeps any one partition to a single day's worth of mutations while still supporting an efficient "today's audit log" query. */
function partitionKeyFor(occurredAt: Date): string {
  return occurredAt.toISOString().slice(0, 10);
}

/**
 * The reverse-ticks PREFIX of a RowKey (see REVERSE_TICKS_CEILING's doc
 * comment) — split out from rowKeyFor so queryAuditEntries (AM-32) can
 * compute the same 13-digit value for an arbitrary cutoff instant (not just
 * "now", the only caller rowKeyFor itself ever needed before AM-32) without
 * duplicating the ceiling-minus-epoch-ms-then-pad arithmetic.
 */
function reverseTicksFor(occurredAt: Date): string {
  return (REVERSE_TICKS_CEILING - occurredAt.getTime()).toString().padStart(13, '0');
}

function rowKeyFor(occurredAt: Date): string {
  return `${reverseTicksFor(occurredAt)}-${randomUUID().slice(0, 8)}`;
}

/** Pure entity construction, split out from writeAuditEntry so the PartitionKey/RowKey scheme and field mapping are unit-testable without a real Table client. */
export function buildAuditEntity(event: AuditEvent, occurredAt: Date = new Date()): AuditEntity {
  return {
    partitionKey: partitionKeyFor(occurredAt),
    rowKey: rowKeyFor(occurredAt),
    actor: event.actor,
    actorId: event.actorId,
    action: event.action,
    target: event.target,
    parametersJson: event.parameters !== undefined ? JSON.stringify(event.parameters) : undefined,
    reason: event.reason,
    outcome: event.outcome,
    detail: event.detail,
    correlationId: event.correlationId,
    occurredAt: occurredAt.toISOString(),
  };
}

let cachedClient: TableClient | undefined | null;

/**
 * Lazily constructs (and caches) the TableClient against the FUNCTIONS
 * storage account's AuditLog table, using DefaultAzureCredential — same
 * secretless model as avdService.ts's ARM client, granted via the Function
 * App's system-assigned MI (Storage Table Data Contributor — see
 * infra/modules/functionapp.bicep). Returns null when AUDIT_STORAGE_ACCOUNT_NAME
 * isn't configured (e.g. local dev, where no such resource exists) — callers
 * treat null as "skip the write", not an error.
 */
function getClient(): TableClient | null {
  if (cachedClient !== undefined) {
    return cachedClient;
  }
  const { audit } = getConfig();
  if (!audit.storageAccountName) {
    cachedClient = null;
    return cachedClient;
  }
  const url = `https://${audit.storageAccountName}.table.core.windows.net`;
  cachedClient = new TableClient(url, audit.tableName, new DefaultAzureCredential());
  return cachedClient;
}

/**
 * True when this Function App is running IN AZURE (WEBSITE_SITE_NAME is an
 * app setting the Azure Functions host sets automatically on every deployed
 * instance; it is never present under local `func start` or vitest) but
 * AUDIT_STORAGE_ACCOUNT_NAME is not configured. This is a misconfiguration,
 * not a supported mode — a deployed environment must be ABLE to write audit
 * rows before it is allowed to run mutations at all.
 *
 * Mutating handlers call this before touching Azure (see
 * sessionHostDrain.ts) and return 500 without mutating anything if true —
 * the fail-closed posture. Local dev (no WEBSITE_SITE_NAME) is unaffected:
 * writeAuditEntry's unconfigured branch below still just skips-and-logs
 * there, so local mutation testing doesn't require a real storage account.
 */
export function isAuditRequiredButMissing(): boolean {
  const { audit } = getConfig();
  return !audit.storageAccountName && Boolean(process.env.WEBSITE_SITE_NAME);
}

/** True for a Table Storage 409 (used here to detect EntityAlreadyExists on a RowKey collision) — same statusCode-based check avdService.ts's isNotFoundError uses for ARM 404s. */
function isConflict(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'statusCode' in error && (error as { statusCode?: number }).statusCode === 409;
}

/**
 * AM-32 peer review MINOR 19 — strips CR/LF from a value before it's
 * interpolated into a log line (both AUDIT_QUERY_FAILED lines below take
 * caller-supplied `actor`/`actionPrefix` straight from a query-string param
 * — see auditRecent.ts). Without this, a crafted value containing a
 * newline could forge additional-looking log lines in Application
 * Insights/Log Analytics (CWE-117 log injection) — this doesn't change
 * what's queried (the `odata` tagged template already handles quoting for
 * THAT), only what a log line can be made to look like.
 */
export function sanitizeForLog(value: string | undefined): string {
  return (value ?? '').replace(/[\r\n]/g, ' ');
}

function logAuditWriteFailure(logger: AuditLogger, event: AuditEvent, error: unknown): void {
  logger.error(
    `AUDIT_WRITE_FAILED | correlationId=${event.correlationId} action=${event.action} target=${event.target} outcome=${event.outcome} ` +
      `error=${error instanceof Error ? error.message : String(error)}`,
  );
}

/**
 * Writes one audit row. Call this from every mutating handler, on BOTH the
 * success and failure path (see app/api/src/functions/sessionHostDrain.ts),
 * so the log reflects what was attempted, not just what succeeded.
 *
 * IMPORTANT: never throws. An audit write is a best-effort side effect of a
 * mutation, not a precondition for it (the precondition is enforced
 * up-front instead — see isAuditRequiredButMissing) — if the Table is
 * unreachable, misconfigured, or the MI's RBAC hasn't propagated yet, that
 * must not turn an otherwise-successful drain toggle into a 5xx for the
 * caller. A write failure is logged via `logger.error` with a distinct
 * 'AUDIT_WRITE_FAILED' marker (not thrown), and every event — success,
 * skipped, or failed-to-persist — is ALSO emitted as a structured
 * 'AUDIT_EVENT' context.log line before the Table write is even attempted.
 * That second copy lands in Application Insights / Log Analytics, which the
 * Function App's own managed identity (the same identity with write access
 * to the AuditLog table) has no delete access to — a tamper-resistant
 * fallback if the Table copy is ever altered or lost.
 */
export async function writeAuditEntry(event: AuditEvent, logger: AuditLogger): Promise<void> {
  logger.log(
    `AUDIT_EVENT ${JSON.stringify({
      actor: event.actor,
      actorId: event.actorId,
      action: event.action,
      target: event.target,
      parameters: event.parameters,
      reason: event.reason,
      outcome: event.outcome,
      detail: event.detail,
      correlationId: event.correlationId,
    })}`,
  );

  const client = getClient();
  if (!client) {
    logger.warn(
      `audit: skipped — AUDIT_STORAGE_ACCOUNT_NAME is not configured | action=${event.action} target=${event.target} correlationId=${event.correlationId}`,
    );
    return;
  }

  const entity = buildAuditEntity(event);
  try {
    await client.createEntity(entity);
  } catch (error) {
    if (isConflict(error)) {
      // RowKey collision (two events built in the same millisecond whose
      // random suffixes ALSO matched) — retry once with a freshly generated
      // RowKey rather than losing the row outright.
      try {
        await client.createEntity({ ...entity, rowKey: rowKeyFor(new Date()) });
        return;
      } catch (retryError) {
        logAuditWriteFailure(logger, event, retryError);
        return;
      }
    }
    logAuditWriteFailure(logger, event, error);
  }
}

/**
 * AM-23 (M3-S1): reads back up to `limit` most-recent audit rows whose
 * `action` starts with `actionPrefix`, NEWEST FIRST — used by
 * GET /v1/scalingplans/current/history (app/api/src/functions/scalingHistory.ts).
 *
 * ORDERING: relies entirely on rowKeyFor's reverse-ticks scheme (see that
 * function's doc comment) — WITHIN one date partition, an ascending
 * RowKey scan (Table Storage's default query order) is already newest-first,
 * so no client-side sort is needed there. ACROSS partitions there is no such
 * guarantee (PartitionKey is a plain YYYY-MM-DD string, so a multi-partition
 * scan would return OLDEST date first if done as one filter) — this function
 * instead walks partitions one calendar day at a time, starting from today
 * and going backward, and stops as soon as `limit` rows have been collected.
 * A day with at least `limit` matching rows is therefore always sufficient
 * on its own; only a sparse day falls through to the previous one.
 *
 * The `action ge '{prefix}' and action lt '{prefix}~'` filter is the
 * standard Table Storage "starts with" idiom: '~' (0x7E) sorts after every
 * character this app's action ids use (lowercase letters, digits, '.', '_'),
 * so it bounds the range to exactly the prefix without needing to know the
 * prefix's own last character.
 *
 * PAGINATION (AM-32 peer review MAJOR 4): a single `.next()` call per
 * partition is NOT sufficient — Table Storage can hand back a page SHORTER
 * than the requested `maxPageSize` while still leaving a continuation token
 * (its own internal per-request time/size serving limits, independent of
 * `maxPageSize`), even when the partition genuinely has more matching rows
 * within `remaining`. Stopping after one `.next()` call previously treated
 * that short page as "this partition is exhausted" and moved on to the
 * PREVIOUS day, silently dropping however many matching rows were still
 * sitting behind the continuation token in the CURRENT partition — a
 * silent hole in the result, not a query failure. This now loops `.next()`
 * within one partition until either `remaining` rows are collected or the
 * iterator itself reports `done` (genuinely no continuation token left).
 *
 * Returns [] — never throws — both when unconfigured (mirrors
 * writeAuditEntry's skip-on-missing-config posture: a broken/absent Table
 * must not break the scaling plan page) and when the query itself fails
 * (logged via logger.error with a distinct marker).
 */
export async function queryRecentAuditEntries(actionPrefix: string, limit: number, logger: AuditLogger, maxDaysBack = 30): Promise<AuditEntity[]> {
  const client = getClient();
  if (!client) {
    return [];
  }

  const results: AuditEntity[] = [];
  const today = new Date();

  try {
    for (let dayOffset = 0; dayOffset < maxDaysBack && results.length < limit; dayOffset++) {
      const day = new Date(today.getTime() - dayOffset * 24 * 60 * 60 * 1000);
      const partitionKey = partitionKeyFor(day);
      const remaining = limit - results.length;

      // Peer review (AM-23 MINOR 7/10): the `odata` tagged template
      // (@azure/data-tables) both escapes/quotes every interpolated value —
      // avoiding OData filter injection via a crafted actionPrefix or
      // partitionKey (neither is user-supplied today, but this removes the
      // hand-rolled string-concatenation footgun regardless) — and keeps
      // the "starts with" upper-bound trick (`action lt '{prefix}~'`, '~'
      // sorting after every character this app's action ids use) readable.
      // `.byPage({ maxPageSize: remaining })` bounds the Table service's
      // OWN per-request page size to exactly what's still needed, instead
      // of the SDK's default (up to 1000 rows/page) — so a day partition
      // with, say, 40 matching rows when only 3 are still needed fetches
      // one ~3-row page, not a 1000-row one. This does NOT bound the
      // number of PARTITIONS (days) walked in a sparse-history worst case
      // (up to `maxDaysBack` sequential round trips) — full history
      // pagination is deferred (see this endpoint's doc comment in
      // scalingHistory.ts).
      const filter = odata`PartitionKey eq ${partitionKey} and action ge ${actionPrefix} and action lt ${actionPrefix + '~'}`;
      const pages = client.listEntities<AuditEntity>({ queryOptions: { filter } }).byPage({ maxPageSize: remaining });
      let pageResult = await pages.next();
      while (results.length < limit) {
        if (pageResult.value) {
          for (const entity of pageResult.value) {
            results.push(entity);
            if (results.length >= limit) {
              break;
            }
          }
        }
        if (pageResult.done || results.length >= limit) {
          break;
        }
        pageResult = await pages.next();
      }
    }
    return results.slice(0, limit);
  } catch (error) {
    logger.error(`AUDIT_QUERY_FAILED | actionPrefix=${sanitizeForLog(actionPrefix)} error=${error instanceof Error ? error.message : String(error)}`);
    return results.slice(0, limit);
  }
}

export interface QueryAuditEntriesOptions {
  /** Max rows to return, newest first. Callers (auditRecent.ts) validate this against their own [1,100] bound before it reaches here. */
  top: number;
  /** How far back to look, in hours, from "now". Callers validate this against their own [1,720] bound before it reaches here. */
  sinceHours: number;
  /** Exact match on AuditEntity.actor, if supplied. */
  actor?: string;
  /** "Starts with" match on AuditEntity.action (same '~'-upper-bound idiom queryRecentAuditEntries uses), if supplied. Omitted entirely = every action. */
  actionPrefix?: string;
}

/**
 * AM-32 (M8-W3): the general "what happened recently" read this app's UI
 * never had before this — GET /v1/audit/recent
 * (app/api/src/functions/auditRecent.ts). Unlike queryRecentAuditEntries
 * above (one action FAMILY, no actor filter, no truncation signal, a fixed
 * 30-day partition-walk ceiling unrelated to how far back the caller
 * actually wants to look), this reads across every action, optionally
 * narrowed by actor/actionPrefix, bounded to the last `options.sinceHours`
 * hours — newest first.
 *
 * EFFICIENCY — reuses rowKeyFor's reverse-ticks RowKey scheme (see that
 * function's doc comment) in the SAME two ways queryRecentAuditEntries
 * already does, plus one more this function adds:
 *  1. A backward day-partition walk (PartitionKey is a per-day string — see
 *     partitionKeyFor) starting today, for exactly as many days as
 *     `sinceHours` can span (`Math.ceil(sinceHours / 24) + 1` — the `+1`
 *     covers the case where "now" and the cutoff instant fall on different
 *     calendar dates, e.g. sinceHours=1 requested at 00:20 UTC), capped at
 *     31 (sinceHours' own validated ceiling of 720 / 24 = 30, +1). This
 *     is NOT a fixed 30-day ceiling regardless of the ask, the way
 *     queryRecentAuditEntries's default is — a 24h-window request walks at
 *     most 2 partitions, not 30.
 *  2. `.byPage({ maxPageSize: remaining })` per partition, exactly as
 *     queryRecentAuditEntries does — never over-fetches a partition beyond
 *     what's still needed to reach the walk's target (`top + 1` — see
 *     "PRECISE truncated" below).
 *  3. NEW: an additional `RowKey le {reverseTicksFor(cutoff)}~` filter on
 *     EVERY partition queried. This is not just an efficiency nicety, it's
 *     load-bearing for CORRECTNESS: because a plain PartitionKey-only query
 *     returns a partition's rows newest-first (ascending RowKey = newest
 *     first — see rowKeyFor's doc comment) and `byPage` truncates to
 *     `remaining` rows, an UNFILTERED page could silently include rows
 *     OLDER than the sinceHours cutoff whenever a partition holds more
 *     matching rows than `remaining` (e.g. `top=5`, `sinceHours=1`, but
 *     today's partition alone has 20 matching rows spanning many hours —
 *     without this bound, the 5 "newest" rows returned are still correct by
 *     coincidence only when the 5 newest all happen to be within the last
 *     hour). The `'~'` upper-bound-in-lexical-order idiom is the same one
 *     queryRecentAuditEntries's action-prefix filter uses, applied to
 *     RowKey's reverse-ticks prefix instead of `action`: smaller reverseTicks
 *     = more recent, so "RowKey le {reverseTicksFor(cutoff)}~" bounds the
 *     scan to exactly the rows at-or-after the cutoff instant, entirely
 *     server-side — no client-side fetch-then-discard needed.
 *
 * PAGINATION (AM-32 peer review MAJOR 4): same continuation-token loop
 * queryRecentAuditEntries above now uses — a short page with a
 * continuation token still pending is NOT "this partition is exhausted";
 * `.next()` is called repeatedly within one partition until either the
 * walk's target row count is reached or the iterator itself reports `done`.
 *
 * PRECISE `truncated` (AM-32 peer review MINOR 20): the walk actually asks
 * for `top + 1` rows (`walkTarget` below), one more than will ever be
 * RETURNED (`entities` is always sliced back to `top`). Whether that extra
 * row was found is what `truncated` reports — an EXACT "there is at least
 * one more matching row beyond `top` in this window" signal, not the
 * "happens to end exactly at `top`" heuristic most other capped-list
 * endpoints in this app accept (see restClient.ts's own `truncated` doc
 * comment) as good enough. The overfetch is one row at most per request —
 * negligible.
 *
 * Returns `{ entities, truncated, partial }`. `partial: true` (AM-32 peer
 * review MAJOR 3) means the query FAILED partway through the day-walk —
 * distinct from `truncated`, which can be true even on a fully successful
 * read (there was simply more data than `top` allows). A `partial` read
 * ALSO reports `truncated: true` unconditionally (a walk that didn't finish
 * can never positively confirm "this is everything in the window", so it
 * must not claim completeness either) — both UI surfaces (RecentActionsDrawer.tsx,
 * Audit.tsx) render an explicit "results may be incomplete" caveat when
 * `partial` is set, distinct from the plain truncated-by-`top` caveat.
 * Never throws; `{ entities: [], truncated: false, partial: false }` when
 * unconfigured (mirrors queryRecentAuditEntries's skip-on-missing-config
 * posture) — a genuinely UNCONFIGURED store is a distinct case from a
 * configured one that failed mid-query, and callers that need to tell
 * "store not configured" apart from "genuinely empty" use
 * isAuditRequiredButMissing() BEFORE calling this at all (see
 * auditRecent.ts) rather than this function inferring it after the fact.
 */
export async function queryAuditEntries(options: QueryAuditEntriesOptions, logger: AuditLogger): Promise<{ entities: AuditEntity[]; truncated: boolean; partial: boolean }> {
  const client = getClient();
  if (!client) {
    return { entities: [], truncated: false, partial: false };
  }

  const { top, sinceHours, actor, actionPrefix } = options;
  const now = new Date();
  const cutoff = new Date(now.getTime() - sinceHours * 60 * 60 * 1000);
  const cutoffRowKeyBound = `${reverseTicksFor(cutoff)}~`;
  const daysToWalk = Math.min(31, Math.ceil(sinceHours / 24) + 1);
  // See "PRECISE truncated" above — one more than `top` so a fully-walked
  // window can positively confirm whether more matching rows exist.
  const walkTarget = top + 1;

  const results: AuditEntity[] = [];
  try {
    for (let dayOffset = 0; dayOffset < daysToWalk && results.length < walkTarget; dayOffset++) {
      const day = new Date(now.getTime() - dayOffset * 24 * 60 * 60 * 1000);
      const partitionKey = partitionKeyFor(day);
      const remaining = walkTarget - results.length;

      // Peer review note (self): `odata` must be called ONCE PER SELF-CONTAINED
      // fragment, never nested (an already-built filter string passed back
      // into `${}` would be treated as a VALUE to escape/quote, not raw
      // filter syntax — silently corrupting the query). Each fragment below
      // is independently valid OData filter text, so plain string `.join(' and ')`
      // across fragments is safe — no further escaping needed for the ' and '
      // glue itself.
      const filterParts = [odata`PartitionKey eq ${partitionKey}`, odata`RowKey le ${cutoffRowKeyBound}`];
      if (actionPrefix) {
        filterParts.push(odata`action ge ${actionPrefix} and action lt ${actionPrefix + '~'}`);
      }
      if (actor) {
        filterParts.push(odata`actor eq ${actor}`);
      }
      const filter = filterParts.join(' and ');

      const pages = client.listEntities<AuditEntity>({ queryOptions: { filter } }).byPage({ maxPageSize: remaining });
      let pageResult = await pages.next();
      while (results.length < walkTarget) {
        if (pageResult.value) {
          for (const entity of pageResult.value) {
            results.push(entity);
            if (results.length >= walkTarget) {
              break;
            }
          }
        }
        if (pageResult.done || results.length >= walkTarget) {
          break;
        }
        pageResult = await pages.next();
      }
    }
    return { entities: results.slice(0, top), truncated: results.length > top, partial: false };
  } catch (error) {
    logger.error(
      `AUDIT_QUERY_FAILED | top=${top} sinceHours=${sinceHours} actor=${sanitizeForLog(actor)} actionPrefix=${sanitizeForLog(actionPrefix)} error=${error instanceof Error ? error.message : String(error)}`,
    );
    // A mid-walk failure can never positively confirm completeness — see
    // this function's own doc comment for why `partial` implies
    // `truncated: true` unconditionally, regardless of how many rows had
    // already been collected before the failure.
    return { entities: results.slice(0, top), truncated: true, partial: true };
  }
}
