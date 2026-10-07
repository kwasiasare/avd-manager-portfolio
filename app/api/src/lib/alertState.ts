import type { AlertSummary, ApiError, SnoozeAlertRequest } from '@avdmgr/shared';
import { getTableClient } from './tableStorage';
import { getConfig } from './config';
import { MAX_SNOOZE_HOURS, MIN_SNOOZE_HOURS } from './logsGuard';

/**
 * App-level alert acknowledgement/snooze state (AM-24), stored in an
 * 'AlertState' Azure Table — provisioned by infra/modules/functionapp.bicep
 * in the same storage account as the audit log (see tableStorage.ts).
 *
 * This is genuinely new app state, not something Azure Monitor tracks for
 * us: Alerts Management has its own `AlertState` concept (New/Acknowledged/
 * Closed — see AlertSummary.status, sourced from essentials.alertState) but
 * no "snooze" concept at all, and mutating an alert's Azure-side state would
 * require Alerts Management write RBAC this app's managed identity
 * intentionally does not have (it's Reader + read-only Log Analytics Reader
 * — see infra/main.bicep). So ack/snooze are modeled entirely as this app's
 * own opinion layered on top of the Azure-reported alert (see
 * applyAlertState below), the same way session host "drain" is this app's
 * own read of allowNewSession rather than a separate Azure state.
 *
 * KEYING (v2 — peer-review fix): a single fixed PartitionKey ('alert') with
 * RowKey = the alert's trailing GUID, lowercased. Azure Monitor alert ids
 * are full ARM resource IDs
 * ("/subscriptions/{sub}/providers/Microsoft.AlertsManagement/alerts/{guid}")
 * which contain '/' — a character Table Storage forbids in PartitionKey/
 * RowKey. The ORIGINAL version of this file percent-encoded the full ARM id
 * for the RowKey AND round-tripped that same %2F-laden string through the
 * ack/snooze route's path segment
 * (`/v1/alerts/{encodeURIComponent(fullArmId)}/ack`) — peer review caught
 * that Azure App Service/IIS normalizes and REJECTS encoded slashes
 * (%2F) in path segments before the request reaches the Function App
 * (verified on Microsoft Q&A / IIS requestFiltering docs — this is
 * documented App Service platform behavior, not a bug to work around), so
 * that route would 404 in a real deployment despite working against the
 * local Functions host (which doesn't apply the same IIS normalization).
 * Routes now carry ONLY the bare GUID (see alertAck.ts/alertSnooze.ts),
 * which needs no encoding at all — GUID characters (hex digits, hyphens)
 * are already Table-Storage-safe and URL-path-safe. No backward
 * compatibility was kept (nothing is deployed yet, per the peer review) —
 * this is a clean migration, not a dual-scheme shim.
 *
 * A single partition is intentional at this scale: alert volume for one AVD
 * estate is expected to be dozens, not thousands, so there's no
 * partition-hot-spotting concern that would justify partitioning by date or
 * severity instead.
 */
const PARTITION_KEY = 'alert';

export interface AlertStateEntity {
  partitionKey: string;
  rowKey: string;
  ackedBy?: string;
  ackedAt?: string;
  ackedReason?: string;
  snoozedBy?: string;
  snoozedUntil?: string;
  snoozeReason?: string;
}

/** Bare GUID pattern — what routes now carry (see the file-level KEYING comment) and what AlertStateEntity.rowKey holds directly, unencoded. */
const ALERT_GUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidAlertGuid(value: unknown): value is string {
  return typeof value === 'string' && ALERT_GUID_PATTERN.test(value);
}

/**
 * Builds the full ARM resource id for an Alerts Management alert from its
 * trailing GUID and this deployment's subscription id — the inverse of
 * extractAlertGuid below. Used where a fully-qualified id reads better than
 * a bare GUID (e.g. the audit `target` field for ack/snooze/unack/unsnooze).
 */
export function buildAlertResourceId(subscriptionId: string, alertGuid: string): string {
  return `/subscriptions/${subscriptionId}/providers/Microsoft.AlertsManagement/alerts/${alertGuid}`;
}

/**
 * Extracts the trailing GUID from a full Azure Monitor alert ARM resource id
 * (AlertSummary.id, as returned by AlertsManagementClient — see
 * alertsService.ts). Returns undefined when `armId` doesn't match that exact
 * shape (case-insensitive on the provider segment, matching alertState.ts's
 * predecessor pattern) — callers treat a non-match as "this alert can't be
 * looked up in / written to AlertState", not a thrown error, since a
 * malformed id from Azure itself would otherwise take down the whole feed.
 */
const ALERT_RESOURCE_ID_PATTERN =
  /\/providers\/microsoft\.alertsmanagement\/alerts\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

export function extractAlertGuid(armId: string): string | undefined {
  return ALERT_RESOURCE_ID_PATTERN.exec(armId)?.[1]?.toLowerCase();
}

function toRowKey(alertGuid: string): string {
  return alertGuid.toLowerCase();
}

/**
 * True when `snoozedUntil` parses as a valid ISO timestamp strictly in the
 * future relative to `now`. Snooze expiry is evaluated here, at READ time —
 * there is no timer/cron job that clears expired snooze rows; see
 * purgeStaleEntities below for the opportunistic (not timer-driven) cleanup
 * that DOES exist.
 */
export function isSnoozeActive(snoozedUntil: string | undefined, now: Date): boolean {
  if (!snoozedUntil) {
    return false;
  }
  const until = new Date(snoozedUntil);
  if (Number.isNaN(until.getTime())) {
    return false;
  }
  return until.getTime() > now.getTime();
}

/**
 * True when an entity carries no information worth keeping: no ack, and no
 * snooze that is still active. Used both to decide what listAlertStates
 * opportunistically purges (see below) and, implicitly, by applyAlertState's
 * own per-field logic.
 */
function isStaleEntity(entity: AlertStateEntity, now: Date): boolean {
  const hasAck = Boolean(entity.ackedBy && entity.ackedAt);
  return !hasAck && !isSnoozeActive(entity.snoozedUntil, now);
}

/**
 * Merges app-level ack/snooze state onto an AlertSummary already fetched
 * from Azure Monitor. Pure — no I/O — so it's unit-testable independent of
 * Table Storage (see alertState.test.ts).
 *
 * - Ack fields are applied whenever both ackedBy and ackedAt are present on
 *   the entity — an ack never "expires" on its own (an operator would need
 *   to un-ack or act again for a re-fired alert).
 * - Snooze fields are applied ONLY while isSnoozeActive(entity.snoozedUntil,
 *   now) is true. An expired snooze is omitted entirely from the merged
 *   result, not surfaced as stale data.
 */
export function applyAlertState(alert: AlertSummary, entity: AlertStateEntity | undefined, now: Date = new Date()): AlertSummary {
  if (!entity) {
    return alert;
  }

  const merged: AlertSummary = { ...alert };

  if (entity.ackedBy && entity.ackedAt) {
    merged.ackedBy = entity.ackedBy;
    merged.ackedAt = entity.ackedAt;
    merged.ackedReason = entity.ackedReason;
  }

  if (isSnoozeActive(entity.snoozedUntil, now)) {
    merged.snoozedUntil = entity.snoozedUntil;
    merged.snoozedBy = entity.snoozedBy;
    merged.snoozeReason = entity.snoozeReason;
  }

  return merged;
}

export type ResolveSnoozeUntilResult = { ok: true; untilIso: string } | { ok: false; error: ApiError };

/**
 * Pure: validates a SnoozeAlertRequest body and resolves it to a single
 * absolute ISO timestamp. Exactly one of `untilIso` / `hours` must be
 * supplied — both or neither is rejected as ambiguous/incomplete rather
 * than silently picking one. `hours` is bounded to
 * [MIN_SNOOZE_HOURS, MAX_SNOOZE_HOURS]; `untilIso` must parse as a valid
 * date STRICTLY in the future relative to `now` (a snooze "until the past"
 * is meaningless and almost certainly a client bug, not a request to
 * immediately un-snooze — use DELETE .../snooze for that).
 */
export function resolveSnoozeUntil(body: SnoozeAlertRequest, now: Date = new Date()): ResolveSnoozeUntilResult {
  const hasUntilIso = body.untilIso !== undefined && body.untilIso !== null && body.untilIso !== '';
  const hasHours = body.hours !== undefined && body.hours !== null;

  if (hasUntilIso && hasHours) {
    return { ok: false, error: { status: 400, code: 'ambiguous_snooze_duration', message: 'Supply exactly one of untilIso or hours, not both.' } };
  }

  if (!hasUntilIso && !hasHours) {
    return { ok: false, error: { status: 400, code: 'missing_snooze_duration', message: 'Supply either untilIso or hours.' } };
  }

  if (hasUntilIso) {
    const until = new Date(body.untilIso as string);
    if (Number.isNaN(until.getTime())) {
      return { ok: false, error: { status: 400, code: 'invalid_until_iso', message: 'untilIso must be a valid ISO-8601 timestamp.' } };
    }
    if (until.getTime() <= now.getTime()) {
      return { ok: false, error: { status: 400, code: 'until_iso_in_past', message: 'untilIso must be in the future.' } };
    }
    return { ok: true, untilIso: until.toISOString() };
  }

  const hours = body.hours as number;
  if (typeof hours !== 'number' || !Number.isFinite(hours) || !Number.isInteger(hours)) {
    return { ok: false, error: { status: 400, code: 'invalid_snooze_hours', message: `hours must be an integer between ${MIN_SNOOZE_HOURS} and ${MAX_SNOOZE_HOURS}.` } };
  }
  if (hours < MIN_SNOOZE_HOURS || hours > MAX_SNOOZE_HOURS) {
    return { ok: false, error: { status: 400, code: 'snooze_hours_out_of_range', message: `hours must be between ${MIN_SNOOZE_HOURS} and ${MAX_SNOOZE_HOURS}.` } };
  }

  const until = new Date(now.getTime() + hours * 60 * 60 * 1000);
  return { ok: true, untilIso: until.toISOString() };
}

function getAlertStateTableClient() {
  return getTableClient(getConfig().alertState.tableName);
}

/** True for a Table Storage 404 (EntityNotFound), used to distinguish "no row yet" from a real failure when reading before an unack/unsnooze Replace. */
function isNotFoundTableError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'statusCode' in error && (error as { statusCode?: number }).statusCode === 404;
}

async function getEntityOrUndefined(client: ReturnType<typeof getAlertStateTableClient>, rowKey: string): Promise<AlertStateEntity | undefined> {
  try {
    return await client.getEntity<AlertStateEntity>(PARTITION_KEY, rowKey);
  } catch (error) {
    if (isNotFoundTableError(error)) {
      return undefined;
    }
    throw error;
  }
}

/**
 * Loads all AlertState entities for the fixed partition in one call (rather
 * than one getEntity call per alert), keyed by GUID (rowKey, already
 * unencoded — see the file-level KEYING comment) for O(1) lookup while
 * merging a list of alerts.
 *
 * Opportunistic stale-row purge (peer review item 13): any entity that is
 * BOTH un-acked and not-actively-snoozed (i.e. isStaleEntity) is deleted
 * here, bounded to the rows this same read already fetched — no separate
 * scan, no timer. This keeps the table from accumulating rows for alerts
 * whose snooze expired long ago and were never acked; a delete failure for
 * one row is logged and skipped (best-effort cleanup, never the reason a
 * read fails).
 */
export async function listAlertStates(): Promise<Map<string, AlertStateEntity>> {
  const client = getAlertStateTableClient();
  const result = new Map<string, AlertStateEntity>();
  const now = new Date();
  const staleRowKeys: string[] = [];

  const entities = client.listEntities<AlertStateEntity>({
    queryOptions: { filter: `PartitionKey eq '${PARTITION_KEY}'` },
  });

  for await (const entity of entities) {
    if (isStaleEntity(entity, now)) {
      staleRowKeys.push(entity.rowKey);
      continue;
    }
    result.set(entity.rowKey, entity);
  }

  if (staleRowKeys.length > 0) {
    await Promise.all(
      staleRowKeys.map((rowKey) =>
        client.deleteEntity(PARTITION_KEY, rowKey).catch(() => {
          // Best-effort: a delete failure here just leaves one harmless stale
          // row for next time — never fail the read over cleanup.
        }),
      ),
    );
  }

  return result;
}

export async function ackAlert(alertGuid: string, actorUserPrincipalName: string, reason: string | undefined): Promise<void> {
  const client = getAlertStateTableClient();
  const entity: AlertStateEntity = {
    partitionKey: PARTITION_KEY,
    rowKey: toRowKey(alertGuid),
    ackedBy: actorUserPrincipalName,
    ackedAt: new Date().toISOString(),
    ackedReason: reason,
  };
  // 'Merge' preserves any existing snooze fields on the same entity instead
  // of clobbering them — acking a currently-snoozed alert doesn't silently
  // un-snooze it. Safe for adding/overwriting ack fields (unlike REMOVING a
  // field, Merge handles "set to a new value" correctly — see unackAlert
  // below for why removal needs Replace instead).
  await client.upsertEntity(entity, 'Merge');
}

export async function snoozeAlert(alertGuid: string, actorUserPrincipalName: string, untilIso: string, reason: string | undefined): Promise<void> {
  const client = getAlertStateTableClient();
  const entity: AlertStateEntity = {
    partitionKey: PARTITION_KEY,
    rowKey: toRowKey(alertGuid),
    snoozedBy: actorUserPrincipalName,
    snoozedUntil: untilIso,
    // Peer review item 11: explicitly write '' (not leave the key
    // undefined/omitted) when no reason is given. Table Storage's Merge
    // Entity semantics treat a null/omitted property as "leave the
    // stored value unchanged" (verified on Learn: "Specifying a property
    // with a null value is equivalent to omitting that property in the
    // request. Only properties with non-null values are updated") — so an
    // omitted snoozeReason on a RE-snooze would silently keep the PREVIOUS
    // snooze's reason instead of clearing it. An explicit '' is a real
    // (non-null) value, so Merge actually overwrites the stored reason.
    snoozeReason: reason ?? '',
  };
  await client.upsertEntity(entity, 'Merge');
}

/**
 * Clears ack state while preserving any currently-stored snooze fields.
 * DELETE /v1/alerts/{alertGuid}/ack — see alertUnack.ts.
 *
 * Table Storage's Merge Entity operation CANNOT remove a property (a null
 * or omitted value is a no-op, not a delete — same fact as snoozeAlert's
 * comment above); the REST API's own docs are explicit: "You can't remove a
 * property with a Merge Entity operation. If you need to do this, replace
 * the entity." So un-acking reads the current entity, builds a fresh one
 * that keeps only the snooze fields (if any), and REPLACES the row with it
 * — any field not included in a Replace is dropped, which is exactly what
 * "remove the ack fields" means here. Works even when the entity doesn't
 * exist yet (upsertEntity's Replace mode still upserts, per the SDK) or the
 * entity has no ack to clear (idempotent no-op).
 */
export async function unackAlert(alertGuid: string): Promise<void> {
  const client = getAlertStateTableClient();
  const rowKey = toRowKey(alertGuid);
  const existing = await getEntityOrUndefined(client, rowKey);

  const entity: AlertStateEntity = {
    partitionKey: PARTITION_KEY,
    rowKey,
    snoozedBy: existing?.snoozedBy,
    snoozedUntil: existing?.snoozedUntil,
    snoozeReason: existing?.snoozeReason,
  };
  await client.upsertEntity(entity, 'Replace');
}

/** Clears snooze state while preserving any currently-stored ack fields. DELETE /v1/alerts/{alertGuid}/snooze — see alertUnsnooze.ts. Same Replace-not-Merge rationale as unackAlert above. */
export async function unsnoozeAlert(alertGuid: string): Promise<void> {
  const client = getAlertStateTableClient();
  const rowKey = toRowKey(alertGuid);
  const existing = await getEntityOrUndefined(client, rowKey);

  const entity: AlertStateEntity = {
    partitionKey: PARTITION_KEY,
    rowKey,
    ackedBy: existing?.ackedBy,
    ackedAt: existing?.ackedAt,
    ackedReason: existing?.ackedReason,
  };
  await client.upsertEntity(entity, 'Replace');
}
