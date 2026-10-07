import { TableClient } from '@azure/data-tables';
import { DefaultAzureCredential } from '@azure/identity';
import { ROLLOUT_TERMINAL_STATES, type RolloutNewHost, type RolloutOldHost, type RolloutPlanDetail, type RolloutState } from '@avdmgr/shared';
import { getConfig } from '../lib/config';

/**
 * AM-28 (M4-S3) staged image-version rollout — durable Table-backed state
 * machine, mirroring app/api/src/services/scalingOverrideService.ts's
 * pattern (same storage account, same DefaultAzureCredential/lazy-client/
 * ETag-optimistic-concurrency shape — see that file's doc comments for the
 * full reasoning this module does not re-derive). The key difference from
 * that single-row design: a rollout plan is a MULTI-STATE machine (planned
 * -> draining_old -> awaiting_new_hosts -> validating_new -> cutover ->
 * removing_old -> done, with rollback/cancel branches — see
 * @avdmgr/shared's RolloutState) over potentially several PLANS across the
 * estate's lifetime (not one fixed row), so this module is keyed by
 * hostPoolName (PartitionKey) + a generated plan id (RowKey) rather than a
 * single fixed PartitionKey/RowKey pair.
 *
 * SCOPE (mirrors scalingOverrideService.ts): this module is CRUD primitives
 * (create/get/list/replace, all ETag-aware) plus PURE decision/projection
 * functions. It makes no ARM calls and owns no read-decide-write orchestration
 * loop itself — that lives in the callers (app/api/src/functions/rolloutPlans.ts
 * for operator-initiated transitions, app/api/src/functions/rolloutPlanTimer.ts
 * for the 1-minute automatic-advancement timer), exactly as
 * scalingEmergencyOverride.ts/scalingOverrideReEnable.ts own that loop around
 * scalingOverrideService.ts's primitives.
 *
 * Lives on the SAME functions storage account as AuditLog/ScalingOverride
 * (see auditLog.ts's getClient doc comment) — no additional RBAC grant is
 * needed beyond the table resource itself (infra/modules/functionapp.bicep's
 * `rolloutPlanTable`) and the ROLLOUT_TABLE_NAME app setting.
 */

const NOT_CONFIGURED_MESSAGE = 'Rollout plan table is not configured (ROLLOUT_TABLE_NAME / AUDIT_STORAGE_ACCOUNT_NAME).';

/** Hard bound on oldHostNames/newHostNames/remove-hosts batch sizes — bounds audit-row parameter size and the per-tick ARM call fan-out the timer performs against each plan. A staged rollout of the single-digit-to-low-tens hosts this estate runs (see the gap register item 3) never needs more; a request naming more is almost certainly a mistake, not a legitimate large batch. */
export const ROLLOUT_MAX_HOSTS = 50;

/** Bound on how many plans listRolloutPlanEntities returns — see that function's doc comment. */
const ROLLOUT_LIST_LIMIT = 25;

/**
 * Fixed RowKey for the one-active-plan-per-host-pool sentinel row (AM-28
 * peer review item 10) — see createActiveSentinel's doc comment for the
 * TOCTOU race this closes.
 */
const ACTIVE_SENTINEL_ROW_KEY = '__active__';

/**
 * Table entity shape. Table Storage has no nested-object/array support, so
 * `oldHosts`/`newHosts` (each RolloutOldHost[]/RolloutNewHost[]) and
 * `rollbackNeedsReadd` (string[]) are stored JSON-serialized — same pattern
 * as auditLog.ts's AuditEntity.parametersJson.
 */
export interface RolloutPlanEntity {
  partitionKey: string;
  rowKey: string;
  hostPoolName: string;
  targetImageVersion: string;
  state: RolloutState;
  oldHostsJson: string;
  newHostsJson: string;
  createdBy: string;
  createdById: string;
  createdAt: string;
  updatedAt: string;
  reason: string;
  forcedProceedAt?: string;
  forcedProceedBy?: string;
  forcedProceedReason?: string;
  cutoverAt?: string;
  cutoverBy?: string;
  rollbackAt?: string;
  rollbackBy?: string;
  rollbackReason?: string;
  rollbackNeedsReaddJson?: string;
  /** New-host names rollback also drained — see @avdmgr/shared's RolloutPlanDetail.rollbackDrainedNewHosts doc comment. */
  rollbackDrainedNewHostsJson?: string;
  rollbackUndrainFailuresJson?: string;
  rollbackNewHostDrainFailuresJson?: string;
  cancelledAt?: string;
  cancelledBy?: string;
  completedAt?: string;
  lastTimerError?: string;
  /** AM-47 — the plan's FROZEN FSLogix config baseline (JSON-serialized `AppConfig.fslogixBaseline`), set at plan creation (rolloutPlans.ts's create handler) or lazily backfilled from current config on the first `verify-config` call for a pre-AM-47 row that predates this field — see @avdmgr/shared's RolloutPlanDetail.configBaseline doc comment for the freeze rationale. */
  configBaselineJson?: string;
}

/** A row as read back from Table Storage, carrying the ETag that read was consistent with — pass into replaceRolloutPlanEntity for optimistic concurrency. */
export interface RolloutPlanRecord extends RolloutPlanEntity {
  etag: string;
}

let cachedClient: TableClient | undefined | null;

/** Lazily constructs (and caches) the TableClient against the RolloutPlan table — same lazy/cached/DefaultAzureCredential/null-when-unconfigured pattern as scalingOverrideService.ts's getClient. */
function getClient(): TableClient | null {
  if (cachedClient !== undefined) {
    return cachedClient;
  }
  const { audit, rollout } = getConfig();
  if (!audit.storageAccountName) {
    cachedClient = null;
    return cachedClient;
  }
  const url = `https://${audit.storageAccountName}.table.core.windows.net`;
  cachedClient = new TableClient(url, rollout.tableName, new DefaultAzureCredential());
  return cachedClient;
}

function hasStatusCode(error: unknown, statusCode: number): boolean {
  return typeof error === 'object' && error !== null && 'statusCode' in error && (error as { statusCode?: number }).statusCode === statusCode;
}

/** True for Table Storage's 404 (ResourceNotFound). */
export function isNotFoundError(error: unknown): boolean {
  return hasStatusCode(error, 404);
}

/** True for Table Storage's 409 (EntityAlreadyExists) — thrown by createRolloutPlanEntity on a RowKey collision (practically unreachable given randomUUID ids, kept for the same defensive-primitive reasons as scalingOverrideService.ts's isConflictError). */
export function isConflictError(error: unknown): boolean {
  return hasStatusCode(error, 409);
}

/** True for Table Storage's 412 (PreconditionFailed) — thrown by replaceRolloutPlanEntity when the row changed since the ETag it was given was read. Callers must re-read via getRolloutPlanEntity and re-evaluate before retrying. */
export function isPreconditionFailedError(error: unknown): boolean {
  return hasStatusCode(error, 412);
}

/** True when the table itself is configured — fail-closed check for mutation handlers, mirroring scalingOverrideService.ts#isOverrideStoreRequiredButMissing / auditLog.ts#isAuditRequiredButMissing. */
export function isRolloutStoreRequiredButMissing(): boolean {
  const { audit } = getConfig();
  return !audit.storageAccountName && Boolean(process.env.WEBSITE_SITE_NAME);
}

/** Reads one plan by hostPoolName + id (with its ETag), or null if it doesn't exist. */
export async function getRolloutPlanEntity(hostPoolName: string, planId: string): Promise<RolloutPlanRecord | null> {
  const client = getClient();
  if (!client) {
    return null;
  }
  try {
    return await client.getEntity<RolloutPlanEntity>(hostPoolName, planId);
  } catch (error) {
    if (isNotFoundError(error)) {
      return null;
    }
    throw error;
  }
}

/**
 * Lists up to ROLLOUT_LIST_LIMIT (25) most-recent plans for a host pool,
 * newest (by createdAt) first — bounded, not an unbounded partition scan
 * (AM-28 peer review item 13): rollout plans are rare (at most a handful
 * per year on an estate this size — see
 * The image-update runbook §3), but an unbounded read is
 * still the wrong default for a Table query driven by a caller-triggered
 * HTTP request (create's one-active-plan check, list's own GET) — a bound
 * costs nothing in the common case and avoids an ever-growing response/scan
 * as plan history accumulates over the app's lifetime. The
 * ACTIVE_SENTINEL_ROW_KEY row (see createActiveSentinel) is filtered out
 * here — it is an internal locking primitive, never a plan callers should
 * see.
 */
async function queryRolloutPlanEntities(hostPoolName: string): Promise<RolloutPlanRecord[]> {
  const client = getClient();
  if (!client) {
    return [];
  }
  const results: RolloutPlanRecord[] = [];
  for await (const entity of client.listEntities<RolloutPlanEntity & { rowKey: string }>({ queryOptions: { filter: `PartitionKey eq '${hostPoolName.replace(/'/g, "''")}'` } })) {
    if (entity.rowKey === ACTIVE_SENTINEL_ROW_KEY) {
      continue;
    }
    results.push(entity as RolloutPlanRecord);
  }
  results.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return results;
}

export async function listRolloutPlanEntities(hostPoolName: string): Promise<RolloutPlanRecord[]> {
  const results = await queryRolloutPlanEntities(hostPoolName);
  return results.slice(0, ROLLOUT_LIST_LIMIT);
}

/**
 * AM-15 (M7) sweep: same query as listRolloutPlanEntities above, but also
 * reports whether ROLLOUT_LIST_LIMIT actually cut anything off — the GET
 * /v1/hostpools/{hostPoolName}/rollout-plans list endpoint surfaces this as
 * RolloutPlanListResponse.truncated, matching this app's convention that
 * every list response backed by an app-imposed cap says so (see
 * AccessSearchResponse.truncated, AssignmentsListResponse.truncated,
 * LogsTableResult.truncated) rather than silently returning a partial list
 * indistinguishable from a complete one. A separate export (not a changed
 * signature on listRolloutPlanEntities) so the timer
 * (rolloutPlanTimer.ts) and the create-time one-active-plan check, which
 * only ever need the bounded array, are unaffected.
 */
export async function listRolloutPlanEntitiesWithTruncation(hostPoolName: string): Promise<{ entities: RolloutPlanRecord[]; truncated: boolean }> {
  const results = await queryRolloutPlanEntities(hostPoolName);
  return { entities: results.slice(0, ROLLOUT_LIST_LIMIT), truncated: results.length > ROLLOUT_LIST_LIMIT };
}

/** Creates the FIRST-EVER row for this plan id via TableClient.createEntity — fails with isConflictError (409) on a RowKey collision rather than silently overwriting. */
export async function createRolloutPlanEntity(entity: RolloutPlanEntity): Promise<void> {
  const client = getClient();
  if (!client) {
    throw new Error(NOT_CONFIGURED_MESSAGE);
  }
  await client.createEntity<RolloutPlanEntity>(entity);
}

/** Conditionally replaces the row via TableClient.updateEntity(..., 'Replace', {etag}) — fails with isPreconditionFailedError (412) if the row changed since `etag` was read. Callers own the read-decide-write-retry loop. */
export async function replaceRolloutPlanEntity(entity: RolloutPlanEntity, etag: string): Promise<void> {
  const client = getClient();
  if (!client) {
    throw new Error(NOT_CONFIGURED_MESSAGE);
  }
  await client.updateEntity<RolloutPlanEntity>(entity, 'Replace', { etag });
}

// ---------------------------------------------------------------------------
// One-active-plan-per-host-pool sentinel (AM-28 peer review item 10).
// ---------------------------------------------------------------------------

/**
 * Creates the fixed-RowKey "active plan" sentinel row for a host pool.
 * Closes a TOCTOU race the original design had: rolloutPlans.ts's create
 * handler used to list existing plans and check none were non-terminal —
 * two concurrent create requests can both pass that check before either has
 * written its plan row, both then create a plan, and now two "active"
 * rollouts exist for one host pool with no defined semantics for which
 * hosts belong to which. TableClient.createEntity fails outright (409) on a
 * RowKey collision (same primitive scalingOverrideService.ts's
 * createScalingOverride relies on) — so whichever create request's
 * createActiveSentinel call reaches the Table FIRST wins, and the loser's
 * 409 is authoritative and immediate, not a racy read-then-write. Same
 * partitioning as plan rows (PartitionKey = hostPoolName), fixed RowKey
 * (ACTIVE_SENTINEL_ROW_KEY) so there is at most one sentinel per host pool.
 *
 * The plan row itself is still created as a SEPARATE write immediately
 * after this succeeds — not a single atomic transaction (Table Storage's
 * batch/transaction support is same-partition-only, which this WOULD
 * qualify for, but the added complexity isn't warranted here: if the
 * sentinel is created and the plan-row create then fails, the sentinel is
 * simply deleted in the same catch block — see rolloutPlans.ts's create
 * handler).
 */
export async function createActiveSentinel(hostPoolName: string, planId: string): Promise<void> {
  const client = getClient();
  if (!client) {
    throw new Error(NOT_CONFIGURED_MESSAGE);
  }
  await client.createEntity({ partitionKey: hostPoolName, rowKey: ACTIVE_SENTINEL_ROW_KEY, activePlanId: planId });
}

/** Reads the active-plan sentinel, if one exists — used only to build an informative "plan X is already in progress" error message on a 409 from createActiveSentinel; the create call itself (not this read) is what actually enforces the one-active-plan rule. Returns null both when unconfigured and when no sentinel exists (never throws on a 404). */
export async function getActiveSentinel(hostPoolName: string): Promise<{ activePlanId: string } | null> {
  const client = getClient();
  if (!client) {
    return null;
  }
  try {
    const entity = await client.getEntity<{ activePlanId: string }>(hostPoolName, ACTIVE_SENTINEL_ROW_KEY);
    return { activePlanId: entity.activePlanId };
  } catch (error) {
    if (isNotFoundError(error)) {
      return null;
    }
    throw error;
  }
}

/**
 * Deletes the active-plan sentinel — called once a plan reaches a terminal
 * state (done/rolled_back/cancelled), freeing the host pool for a new
 * rollout to be created. Best-effort: a delete failure is NOT retried or
 * propagated to the caller (the state transition that triggered it must
 * still succeed — see rolloutPlans.ts's ROLLOUT_SENTINEL_CLEANUP_FAILED
 * marker), since a stray sentinel is a recoverable, loudly-logged
 * operational annoyance (blocks new-plan creation until manually cleared),
 * never a correctness or data-loss issue the way losing an achieved
 * removal would be.
 */
export async function deleteActiveSentinel(hostPoolName: string): Promise<void> {
  const client = getClient();
  if (!client) {
    return;
  }
  await client.deleteEntity(hostPoolName, ACTIVE_SENTINEL_ROW_KEY);
}

/** True for Table Storage's 404 on a delete — deleteActiveSentinel's caller treats "already gone" as success, not an error (idempotent cleanup). Reuses isNotFoundError's own statusCode check; kept as a distinctly-named alias only where call sites read more clearly with it. */
export const isSentinelAlreadyGone = isNotFoundError;

// ---------------------------------------------------------------------------
// Merge-retry write helper (AM-28 peer review BLOCKER item 1).
// ---------------------------------------------------------------------------

/** Bounded retry count for persistWithMergeRetry — see that function's doc comment. Small on purpose: a genuine, persistent 412 storm after this many attempts means something structural is wrong (not a one-off race with the timer), and the caller's own fallback (log + return ARM ground truth to the operator) is the safer response at that point than looping indefinitely inside an HTTP request. */
const MAX_MERGE_RETRIES = 3;

/**
 * Writes an update to a plan row, and on a 412 (PreconditionFailed — the row
 * changed since `startingRecord` was read, most plausibly the 1-minute
 * timer ticking concurrently, or a genuinely racing second admin request),
 * RE-READS the row and re-applies `mutate` to the FRESH entity rather than
 * giving up — bounded to MAX_MERGE_RETRIES attempts.
 *
 * THIS IS THE BLOCKER FIX (AM-28 peer review item 1): handlers that perform
 * IRREVERSIBLE ARM mutations (host removal, draining, un-draining) BEFORE
 * writing their achieved per-host progress to the plan row must never let a
 * stale-ETag conflict on that write silently discard the progress ARM
 * already, actually, irreversibly made. `mutate` must therefore express
 * "apply MY achieved changes on top of whatever the row currently looks
 * like" (a per-host merge by sessionHostName — see rolloutPlans.ts's
 * mergeOldHostUpdates/mergeNewHostUpdates), never "replace the whole row
 * with a stale in-memory copy" — a `mutate` that does the latter would
 * re-introduce exactly the bug this helper exists to close.
 *
 * Rethrows if every retry is exhausted (including a non-412 error, or the
 * plan vanishing entirely — practically impossible, but not swallowed
 * either way) — the caller is still responsible for logging a distinct,
 * alertable marker and deciding how to represent the outcome to ITS OWN
 * caller (see rolloutPlans.ts's handleRemoveHosts, which falls back to
 * reporting ARM ground truth to the operator even if this ultimately
 * cannot persist it, rather than silently reporting "nothing happened" on
 * removals that already, irreversibly, happened).
 */
export async function persistWithMergeRetry(
  hostPoolName: string,
  planId: string,
  startingRecord: RolloutPlanRecord,
  mutate: (fresh: RolloutPlanEntity) => RolloutPlanEntity,
): Promise<RolloutPlanEntity> {
  let current: RolloutPlanRecord = startingRecord;
  for (let attempt = 0; attempt < MAX_MERGE_RETRIES; attempt++) {
    const { etag, ...base } = current;
    const updated = mutate(base);
    try {
      await replaceRolloutPlanEntity(updated, etag);
      return updated;
    } catch (error) {
      if (!isPreconditionFailedError(error) || attempt === MAX_MERGE_RETRIES - 1) {
        throw error;
      }
      const fresh = await getRolloutPlanEntity(hostPoolName, planId);
      if (!fresh) {
        throw error;
      }
      current = fresh;
    }
  }
  /* istanbul ignore next -- unreachable: the loop above always returns or throws before falling out. */
  throw new Error('persistWithMergeRetry: exhausted retries without returning or throwing');
}

// ---------------------------------------------------------------------------
// Pure parse/project helpers — no Table/ARM client, unit-testable in
// isolation (see rolloutPlanService.test.ts).
// ---------------------------------------------------------------------------

/** Parses oldHostsJson, defaulting to [] on missing/corrupt data rather than throwing — a plan record must always be renderable even if a future field-shape change makes an old row's JSON unparsable. */
export function parseOldHosts(entity: Pick<RolloutPlanEntity, 'oldHostsJson'>): RolloutOldHost[] {
  try {
    const parsed: unknown = JSON.parse(entity.oldHostsJson);
    return Array.isArray(parsed) ? (parsed as RolloutOldHost[]) : [];
  } catch {
    return [];
  }
}

/** Parses newHostsJson — same defensive-default rationale as parseOldHosts. */
export function parseNewHosts(entity: Pick<RolloutPlanEntity, 'newHostsJson'>): RolloutNewHost[] {
  try {
    const parsed: unknown = JSON.parse(entity.newHostsJson);
    return Array.isArray(parsed) ? (parsed as RolloutNewHost[]) : [];
  } catch {
    return [];
  }
}

/** Defensive parse of a JSON-stringified string[] field — undefined input (never set) yields undefined, not []; corrupt JSON also yields undefined rather than throwing. Shared by parseRollbackNeedsReadd/parseRollbackDrainedNewHosts below. */
function parseOptionalStringArray(json: string | undefined): string[] | undefined {
  if (!json) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as string[]) : undefined;
  } catch {
    return undefined;
  }
}

/** Parses rollbackNeedsReaddJson. */
export function parseRollbackNeedsReadd(entity: Pick<RolloutPlanEntity, 'rollbackNeedsReaddJson'>): string[] | undefined {
  return parseOptionalStringArray(entity.rollbackNeedsReaddJson);
}

/** Parses rollbackDrainedNewHostsJson. */
export function parseRollbackDrainedNewHosts(entity: Pick<RolloutPlanEntity, 'rollbackDrainedNewHostsJson'>): string[] | undefined {
  return parseOptionalStringArray(entity.rollbackDrainedNewHostsJson);
}

/** Parses rollbackUndrainFailuresJson. */
export function parseRollbackUndrainFailures(entity: Pick<RolloutPlanEntity, 'rollbackUndrainFailuresJson'>): string[] | undefined {
  return parseOptionalStringArray(entity.rollbackUndrainFailuresJson);
}

/** Parses rollbackNewHostDrainFailuresJson. */
export function parseRollbackNewHostDrainFailures(entity: Pick<RolloutPlanEntity, 'rollbackNewHostDrainFailuresJson'>): string[] | undefined {
  return parseOptionalStringArray(entity.rollbackNewHostDrainFailuresJson);
}

/** Parses configBaselineJson (AM-47) — undefined input (a pre-AM-47 row, or one that hasn't been lazily backfilled yet — see rolloutPlans.ts's handleVerifyConfig) yields undefined, not `{}`; corrupt JSON also yields undefined rather than throwing, same defensive-default rationale as the string[] parsers above. */
export function parseConfigBaseline(entity: Pick<RolloutPlanEntity, 'configBaselineJson'>): Record<string, string> | undefined {
  if (!entity.configBaselineJson) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(entity.configBaselineJson);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, string>) : undefined;
  } catch {
    return undefined;
  }
}

/** Projects a stored entity (ETag dropped — an API-internal concurrency concern, never sent to the frontend) to the shared RolloutPlanDetail DTO. */
export function toRolloutPlanDetail(entity: RolloutPlanEntity): RolloutPlanDetail {
  return {
    id: entity.rowKey,
    hostPoolName: entity.hostPoolName,
    targetImageVersion: entity.targetImageVersion,
    state: entity.state,
    oldHosts: parseOldHosts(entity),
    newHosts: parseNewHosts(entity),
    createdBy: entity.createdBy,
    createdAt: entity.createdAt,
    updatedAt: entity.updatedAt,
    reason: entity.reason,
    forcedProceedAt: entity.forcedProceedAt,
    forcedProceedBy: entity.forcedProceedBy,
    forcedProceedReason: entity.forcedProceedReason,
    cutoverAt: entity.cutoverAt,
    cutoverBy: entity.cutoverBy,
    rollbackAt: entity.rollbackAt,
    rollbackBy: entity.rollbackBy,
    rollbackReason: entity.rollbackReason,
    rollbackNeedsReadd: parseRollbackNeedsReadd(entity),
    rollbackDrainedNewHosts: parseRollbackDrainedNewHosts(entity),
    rollbackUndrainFailures: parseRollbackUndrainFailures(entity),
    rollbackNewHostDrainFailures: parseRollbackNewHostDrainFailures(entity),
    cancelledAt: entity.cancelledAt,
    cancelledBy: entity.cancelledBy,
    completedAt: entity.completedAt,
    lastTimerError: entity.lastTimerError,
    configBaseline: parseConfigBaseline(entity),
  };
}

// ---------------------------------------------------------------------------
// Pure state-machine decision functions.
// ---------------------------------------------------------------------------

/**
 * The legal transition graph. Every edge here is an INTENDED move a caller
 * (an operator action in rolloutPlans.ts, or an automatic advance in
 * rolloutPlanTimer.ts) may attempt; canTransition below is the single
 * source of truth every mutation checks before writing a new `state` —
 * an illegal transition (e.g. 'planned' -> 'cutover', or any move out of a
 * terminal state) is rejected (409) rather than silently accepted.
 *
 * Rollback ('rolled_back') is reachable from every non-terminal state
 * INCLUDING removing_old (see rolloutPlanService.ts's module doc comment
 * and the rollback handler in rolloutPlans.ts for the pre- vs. post-removal
 * distinction in what rollback actually DOES to each host — the state
 * transition itself is uniform).
 */
const TRANSITIONS: Readonly<Record<RolloutState, readonly RolloutState[]>> = {
  planned: ['draining_old', 'cancelled'],
  draining_old: ['awaiting_new_hosts', 'rolled_back'],
  awaiting_new_hosts: ['validating_new', 'rolled_back'],
  validating_new: ['cutover', 'rolled_back'],
  cutover: ['removing_old', 'rolled_back'],
  removing_old: ['done', 'rolled_back'],
  done: [],
  rolled_back: [],
  cancelled: [],
};

/** True if `to` is a legal next state from `from` per the graph above. The single gate every state-changing write in rolloutPlans.ts/rolloutPlanTimer.ts must pass before persisting. */
export function canTransition(from: RolloutState, to: RolloutState): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

/** Single source of truth for "is this state terminal" — the SAME array @avdmgr/shared exports for the frontend (ROLLOUT_TERMINAL_STATES), so the API and the UI can never disagree about which states accept no further transitions. */
const TERMINAL_STATES: ReadonlySet<RolloutState> = new Set(ROLLOUT_TERMINAL_STATES);

/** True for done/rolled_back/cancelled — a plan in one of these states accepts no further transitions and the timer skips it entirely. */
export function isTerminalState(state: RolloutState): boolean {
  return TERMINAL_STATES.has(state);
}

/**
 * draining_old's exit condition: every old host has reached 'drained' (or
 * later — 'removed'). The timer (rolloutPlanTimer.ts#refreshOldHosts) only
 * sets 'drained' once BOTH a server-reported session count of 0 AND
 * allowNewSession: false have been observed for that host in the SAME
 * listSessionHosts read — checking allowNewSession matters because an
 * operator can re-enable a host (e.g. via the HostPool page's drain toggle)
 * independently of this plan; without that check, a re-enabled-but-
 * momentarily-empty host would read as "drained" and the plan would
 * advance past draining_old while that host is actually about to start
 * accepting sessions again (AM-28 peer review item 6). An empty oldHosts
 * array (should never happen — creation requires >=1) is vacuously true,
 * not a stuck-forever false.
 */
export function allOldHostsDrained(oldHosts: readonly RolloutOldHost[]): boolean {
  return oldHosts.every((host) => host.status === 'drained' || host.status === 'removed');
}

/** awaiting_new_hosts's exit condition: every declared new host has been OBSERVED in AVD at least once (status advanced past 'awaiting_registration') — health/Available-ness is NOT required yet, that is validating_new's job. */
export function allNewHostsRegistered(newHosts: readonly RolloutNewHost[]): boolean {
  return newHosts.length > 0 && newHosts.every((host) => host.status !== 'awaiting_registration');
}

/** validating_new's readiness signal (used to gate confirm-cutover unless force:true): every new host is 'available' (or already 'validated') AND its last-observed health checks all succeeded. Does NOT check image verification — see allNewHostsImageVerified, a separate gate combined with this one at the confirm-cutover call site (rolloutPlans.ts) so each failure reason is independently reportable/testable. */
export function allNewHostsAvailableAndHealthy(newHosts: readonly RolloutNewHost[]): boolean {
  return newHosts.length > 0 && newHosts.every((host) => (host.status === 'available' || host.status === 'validated') && host.healthy === true);
}

/**
 * confirm-cutover's SECOND readiness signal (AM-28 peer review item 4):
 * every new host's underlying VM has been confirmed (via
 * rolloutPlanTimer.ts#refreshNewHosts, computeService.ts#getVmImageReference)
 * to actually be running the plan's targetImageVersion. Separate from
 * allNewHostsAvailableAndHealthy — a host can be Available and healthy
 * while still having been (mis)provisioned from the WRONG image version, a
 * failure mode this gate exists specifically to catch before cutover.
 */
export function allNewHostsImageVerified(newHosts: readonly RolloutNewHost[]): boolean {
  return newHosts.length > 0 && newHosts.every((host) => host.imageVerified === true);
}

/**
 * confirm-cutover's THIRD readiness signal (AM-47): every new host's
 * FSLogix config-convergence check (RolloutNewHost.configCheck — populated
 * by rolloutPlans.ts's verify-config action + rolloutPlanTimer.ts's
 * validating_new poll, see app/api/src/lib/fslogixConfigCheck.ts) has
 * reached status 'passed'. Mirrors allNewHostsImageVerified's placement
 * and style exactly: a separate, independently-testable/-reportable gate
 * combined with the other two at the confirm-cutover call site
 * (rolloutPlans.ts), not folded into either existing gate function.
 */
export function allNewHostsConfigVerified(newHosts: readonly RolloutNewHost[]): boolean {
  return newHosts.length > 0 && newHosts.every((host) => host.configCheck?.status === 'passed');
}

/**
 * The force-proceed action's target state, given the plan's CURRENT state —
 * AM-28 peer review item 6 extended this action beyond its original single
 * use (bypassing draining_old's zero-sessions wait) to ALSO bypass
 * awaiting_new_hosts's "every new host observed at all" wait, since an
 * operator may legitimately want to proceed to validating_new with fewer
 * than every declared new host having registered yet (e.g. one was
 * abandoned/renamed). Returns null (illegal) from any other state — the
 * caller (rolloutPlans.ts's handleForceProceed) maps null to the same
 * illegal-transition 409 every other action uses.
 */
export function forceProceedNextState(current: RolloutState): RolloutState | null {
  if (current === 'draining_old') return 'awaiting_new_hosts';
  if (current === 'awaiting_new_hosts') return 'validating_new';
  return null;
}

/**
 * THE HARD GATE (per the AM-28 spec — unlike every other gate in this
 * module, this one has no `force` bypass anywhere in the call chain):
 * removal of a session host is refused unless its server-observed session
 * count, read FRESH immediately before the removal call (see
 * avdService.ts#resolveSessionHostVm, which rolloutPlans.ts's remove-hosts
 * handler calls per host right before acting — never a cached/stale count
 * from the plan record), is exactly zero.
 */
export function canRemoveHost(sessionCount: number): boolean {
  return sessionCount === 0;
}
