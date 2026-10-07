import { TableClient } from '@azure/data-tables';
import { DefaultAzureCredential } from '@azure/identity';
import type { EmergencyOverrideStatus } from '@avdmgr/shared';
import { getConfig } from '../lib/config';

/**
 * AM-23 (M3-S1) emergency "keep all hosts up" override — persisted state for
 * POST/DELETE/GET /v1/scalingplans/current/emergency-override
 * (app/api/src/functions/scalingEmergencyOverride.ts) and the timer-triggered
 * auto-re-enable function (app/api/src/functions/scalingOverrideReEnable.ts).
 *
 * Lives on the SAME functions storage account as the AuditLog table (see
 * app/api/src/lib/auditLog.ts's getClient doc comment) — the Function App's
 * managed identity already holds Storage Table Data Contributor on that
 * WHOLE account (infra/modules/functionapp.bicep's
 * storageTableDataContributorAssignment is scoped to the account, not one
 * table), so a second table here needs no additional RBAC grant, only the
 * table resource itself (see that file's new `scalingOverrideTable`
 * resource) and the SCALING_OVERRIDE_TABLE_NAME app setting.
 *
 * Single-row design: this app manages exactly one host pool / one scaling
 * plan (see lib/config.ts), so there is only ever one override "in effect"
 * at a time — modeled as a single entity at a FIXED PartitionKey/RowKey
 * ('override'/'current').
 *
 * CONCURRENCY (peer review — AM-23 MAJOR 2): a blind "replace whatever is
 * there" write is UNSAFE for this row — the activation handler, the cancel
 * handler, and the timer's auto-re-enable can all legitimately race each
 * other (an operator cancels the instant the timer decides to re-enable; a
 * fresh activation lands between the timer's read and its write; two
 * operators both POST an activation). A blind overwrite in any of those
 * interleavings can silently resurrect an already-cancelled override,
 * revert a fresh activation's new expiry back to a stale one, or re-enable
 * autoscale in the middle of a still-active override. This module instead
 * exposes ETag-based optimistic concurrency: `createScalingOverride` for
 * the "no row exists yet" case (fails with a 409 if one was concurrently
 * created) and `replaceScalingOverride` for the "row exists, replace it
 * ONLY if it hasn't changed since I read it" case (fails with a 412 if it
 * has) — verified against @azure/data-tables' TableClient.updateEntity,
 * whose `options.etag` doc comment states plainly: "Match condition for an
 * entity to be updated. If specified and a matching entity is not found, an
 * error will be raised." Every caller (scalingEmergencyOverride.ts's
 * activate/cancel handlers, scalingOverrideReEnable.ts's timer) is
 * responsible for its OWN read-decide-write-retry-on-conflict loop; this
 * module only provides the primitives + the pure decision helpers.
 */
export interface ScalingOverrideEntity {
  partitionKey: string;
  rowKey: string;
  active: boolean;
  activatedBy: string;
  activatedById: string;
  activatedAt: string;
  expiresAt: string;
  minutes: number;
  reason: string;
  scalingPlanName: string;
  /** The scaling plan's OWN resource group AT ACTIVATION TIME (see avdService.ts's CurrentScalingPlanRef — never assumed to equal getConfig().resourceGroups.hostPools). Stored here so the cancel handler and the timer's auto-re-enable can call setScalingPlanHostPoolEnabled directly from this row, without a second ARM lookup (and without risking a mismatch if re-resolved fresh at a different moment). */
  resourceGroup: string;
  hostPoolId: string;
  /** Correlation id of the activation/extension request, for cross-referencing the audit row that recorded it. */
  correlationId: string;
  /**
   * Peer review MINOR 6 — true once a failure audit row has been written
   * for the CURRENT expired-but-not-yet-re-enabled episode. The timer
   * (scalingOverrideReEnable.ts) checks this before writing another
   * failure row on each 5-minute retry, so a persistently-failing ARM
   * re-enable writes ONE audit row (and one scalingHistory entry), not a
   * new one every tick. Explicitly reset to false whenever the row is
   * (re)written for a freshly ACTIVE episode (activate/extend) — a new
   * episode always starts with a clean slate.
   */
  reEnableFailureAudited?: boolean;
}

/** A row as read back from Table Storage, carrying the ETag that read was consistent with — pass into replaceScalingOverride for optimistic concurrency. */
export interface ScalingOverrideRecord extends ScalingOverrideEntity {
  etag: string;
}

const PARTITION_KEY = 'override';
const ROW_KEY = 'current';

const NOT_CONFIGURED_MESSAGE = 'Scaling override table is not configured (SCALING_OVERRIDE_TABLE_NAME / AUDIT_STORAGE_ACCOUNT_NAME).';

let cachedClient: TableClient | undefined | null;

/**
 * Lazily constructs (and caches) the TableClient against the ScalingOverride
 * table — same lazy/cached/DefaultAzureCredential/null-when-unconfigured
 * pattern as auditLog.ts's getClient (see that function's doc comment for
 * the full reasoning, including why null — not a thrown error — is the
 * unconfigured-environment contract).
 */
function getClient(): TableClient | null {
  if (cachedClient !== undefined) {
    return cachedClient;
  }
  const { audit, scalingOverride } = getConfig();
  if (!audit.storageAccountName) {
    cachedClient = null;
    return cachedClient;
  }
  const url = `https://${audit.storageAccountName}.table.core.windows.net`;
  cachedClient = new TableClient(url, scalingOverride.tableName, new DefaultAzureCredential());
  return cachedClient;
}

function hasStatusCode(error: unknown, statusCode: number): boolean {
  return typeof error === 'object' && error !== null && 'statusCode' in error && (error as { statusCode?: number }).statusCode === statusCode;
}

/** True for Table Storage's 404 (ResourceNotFound) — no override has ever been activated. */
export function isNotFoundError(error: unknown): boolean {
  return hasStatusCode(error, 404);
}

/** True for Table Storage's 409 (EntityAlreadyExists) — thrown by createScalingOverride when a row was concurrently created by another activation. */
export function isConflictError(error: unknown): boolean {
  return hasStatusCode(error, 409);
}

/** True for Table Storage's 412 (PreconditionFailed) — thrown by replaceScalingOverride when the row changed since the ETag it was given was read. Callers should re-read via getScalingOverride and re-evaluate before retrying. */
export function isPreconditionFailedError(error: unknown): boolean {
  return hasStatusCode(error, 412);
}

/**
 * Reads the current override row (with its ETag), or null if none exists
 * yet (a fresh environment where no override has ever been activated — NOT
 * the same as an override that exists but is inactive/expired, which still
 * returns its row with active: false). Returns null (not throw) when the
 * table isn't configured (local dev) — same posture as auditLog's
 * writeAuditEntry.
 */
export async function getScalingOverride(): Promise<ScalingOverrideRecord | null> {
  const client = getClient();
  if (!client) {
    return null;
  }
  try {
    return await client.getEntity<ScalingOverrideEntity>(PARTITION_KEY, ROW_KEY);
  } catch (error) {
    if (isNotFoundError(error)) {
      return null;
    }
    throw error;
  }
}

/**
 * Creates the FIRST-EVER override row via TableClient.createEntity, which
 * fails outright (409) rather than silently overwriting if a row already
 * exists — the correct primitive for the "no row exists yet" branch of a
 * read-decide-write loop; a concurrent activation racing this one to be
 * first is surfaced as isConflictError, not masked.
 */
export async function createScalingOverride(entity: Omit<ScalingOverrideEntity, 'partitionKey' | 'rowKey'>): Promise<void> {
  const client = getClient();
  if (!client) {
    throw new Error(NOT_CONFIGURED_MESSAGE);
  }
  await client.createEntity<ScalingOverrideEntity>({ partitionKey: PARTITION_KEY, rowKey: ROW_KEY, ...entity });
}

/**
 * Conditionally replaces the row via TableClient.updateEntity(...,'Replace',
 * {etag}) — fails with isPreconditionFailedError (412) if the row has
 * changed since `etag` was read, rather than blindly overwriting whatever
 * is there. Callers own the read-decide-write-retry loop (see
 * scalingEmergencyOverride.ts / scalingOverrideReEnable.ts).
 */
export async function replaceScalingOverride(entity: Omit<ScalingOverrideEntity, 'partitionKey' | 'rowKey'>, etag: string): Promise<void> {
  const client = getClient();
  if (!client) {
    throw new Error(NOT_CONFIGURED_MESSAGE);
  }
  await client.updateEntity<ScalingOverrideEntity>({ partitionKey: PARTITION_KEY, rowKey: ROW_KEY, ...entity }, 'Replace', { etag });
}

/**
 * True when the table itself is configured — used by the mutation handlers'
 * fail-closed check, mirroring auditLog.ts#isAuditRequiredButMissing's
 * posture: a deployed environment that cannot persist override state must
 * refuse to activate/cancel one, rather than silently disabling autoscale
 * in ARM with no durable record of when to re-enable it.
 */
export function isOverrideStoreRequiredButMissing(): boolean {
  const { audit } = getConfig();
  return !audit.storageAccountName && Boolean(process.env.WEBSITE_SITE_NAME);
}

/**
 * Pure projection from the stored entity (or null/inactive) to the shared
 * EmergencyOverrideStatus DTO — split out so it's unit-testable without a
 * Table client (see scalingOverrideService.test.ts). `now` is injectable for
 * the same reason computeScalingPhase takes one.
 *
 * `active` in the RETURNED status reflects the row's OWN `active` flag,
 * not a re-derivation from expiresAt vs now — see this module's file-level
 * comment on why: the row is the source of truth for "did we tell ARM to
 * keep hosts up", and only flips to false once the timer function (or a
 * manual cancel) has actually re-enabled the plan in ARM. `minutesRemaining`
 * is still clamped to >= 0 so the UI never shows a negative countdown even
 * in the up-to-5-minute window between expiry and the timer's next tick.
 */
export function computeOverrideStatus(entity: ScalingOverrideEntity | null, now: Date = new Date()): EmergencyOverrideStatus {
  if (!entity || !entity.active) {
    return { active: false };
  }
  const msRemaining = new Date(entity.expiresAt).getTime() - now.getTime();
  return {
    active: true,
    activatedBy: entity.activatedBy,
    activatedAt: entity.activatedAt,
    expiresAt: entity.expiresAt,
    minutesRemaining: Math.max(0, Math.ceil(msRemaining / 60_000)),
    minutes: entity.minutes,
    reason: entity.reason,
  };
}

/**
 * Pure decision function for the timer-triggered auto-re-enable
 * (app/api/src/functions/scalingOverrideReEnable.ts) — extracted so the
 * "should this run re-enable ARM right now" logic is unit-testable without
 * mocking a Table client or ARM calls (see that file's test). An override
 * is due for auto-re-enable when it exists, is marked active, AND its
 * expiresAt has passed as of `now`.
 */
export function isOverrideExpired(entity: ScalingOverrideEntity | null, now: Date = new Date()): boolean {
  if (!entity || !entity.active) {
    return false;
  }
  return new Date(entity.expiresAt).getTime() <= now.getTime();
}
