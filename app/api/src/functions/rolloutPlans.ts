import { randomUUID } from 'node:crypto';
import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import type {
  ApiError,
  CreateRolloutPlanRequest,
  RemoveRolloutHostFailure,
  RemoveRolloutHostsRequest,
  RemoveRolloutHostsResponse,
  RemoveRolloutHostsResult,
  RolloutActionRequest,
  RolloutNewHost,
  RolloutOldHost,
  RolloutPlanListResponse,
  RolloutPlanResponse,
  RolloutState,
} from '@avdmgr/shared';
import type { ClientPrincipal } from '../lib/auth';
import { requireMinimumRole, requireRole } from '../lib/auth';
import { isAuditRequiredButMissing, writeAuditEntry, type AuditLogger } from '../lib/auditLog';
import { getConfig } from '../lib/config';
import { badRequest } from '../lib/httpErrors';
import { validateManagedHostPool } from '../lib/hostPoolScope';
import { MAX_REASON_LENGTH, SESSION_HOST_NAME_PATTERN, validateMandatoryReason, validateOptionalReason } from '../lib/validation';
import { isNotFoundError as isArmNotFoundError, removeSessionHost, resolveSessionHostVm, setSessionHostDrain } from '../services/avdService';
import { beginVmDelete, submitFslogixConfigCheck } from '../services/computeService';
import {
  allNewHostsAvailableAndHealthy,
  allNewHostsConfigVerified,
  allNewHostsImageVerified,
  canRemoveHost,
  canTransition,
  createActiveSentinel,
  createRolloutPlanEntity,
  deleteActiveSentinel,
  forceProceedNextState,
  getActiveSentinel,
  getRolloutPlanEntity,
  isConflictError,
  isPreconditionFailedError,
  isRolloutStoreRequiredButMissing,
  isTerminalState,
  listRolloutPlanEntitiesWithTruncation,
  parseConfigBaseline,
  parseNewHosts,
  parseOldHosts,
  persistWithMergeRetry,
  ROLLOUT_MAX_HOSTS,
  toRolloutPlanDetail,
  type RolloutPlanEntity,
  type RolloutPlanRecord,
} from '../services/rolloutPlanService';

/**
 * AM-28 (M4-S3) staged rollout HTTP surface — automates
 * The image-update runbook §3 ("Staged rollout to
 * HP-CONTOSO-PROD") and §4 ("Rollback to a prior version") plus
 * The session-host lifecycle runbook §5 ("Remove a host") as a
 * durable, operator-gated state machine (see
 * app/api/src/services/rolloutPlanService.ts for the state graph and Table
 * storage this module drives).
 *
 * RBAC: every route below is ADMIN-ONLY (requireMinimumRole('admin')), even
 * the read routes — unlike most of this app's viewer/operator/admin split,
 * a staged rollout is a whole-fleet, multi-step operational procedure with
 * an irreversible tail (host removal), so this story treats the entire
 * wizard as an admin surface rather than layering partial operator
 * visibility on top (contrast with, e.g., hostPoolRegistrationToken.ts's
 * operator-can-view/admin-can-generate split). See this story's RBAC report
 * for the new infra/modules/rolloutOperatorRole.bicep custom role the
 * mutating actions below (specifically remove-hosts) require, layered on
 * top of the SAME drain/power grants M2's sessionHostWriterRole/
 * vmPowerOperatorRole already provide (setSessionHostDrain below reuses
 * those, unchanged).
 *
 * AM-28 peer review (BLOCKER item 1) — DURABILITY OF IRREVERSIBLE ARM
 * MUTATIONS: handleStart, handleRollback, and handleRemoveHosts each call
 * ARM to mutate real session hosts (drain, un-drain, deregister, delete)
 * BEFORE writing their outcome to the plan's Table row. Every one of them
 * therefore follows the SAME two-part discipline:
 *   1. Write the audit row for what was ACHIEVED in ARM BEFORE attempting
 *      the plan-row state write — an audit failure must never be possible
 *      to blame on "the state write conflicted", and a state-write failure
 *      must never leave NO durable record that the ARM mutation happened.
 *   2. Use rolloutPlanService.ts#persistWithMergeRetry (not a bare
 *      replaceRolloutPlanEntity + return-409-on-412) for the state write —
 *      a 412 (the timer or a second admin racing this one) triggers a
 *      re-read + re-merge + retry, so achieved ARM progress is never
 *      silently discarded because the Table row moved out from under a
 *      stale in-memory copy.
 * If persistWithMergeRetry itself exhausts its retries, the handler still
 * returns a clear response explaining that the ARM mutation succeeded and
 * was audited even though the Table row's own state could not be updated
 * just now — never a generic error that reads as "nothing happened".
 */

const ACTION = {
  CREATE: 'rollout.create',
  START: 'rollout.start',
  FORCE_PROCEED: 'rollout.force_proceed',
  VERIFY_CONFIG: 'rollout.verify_config',
  CONFIRM_CUTOVER: 'rollout.confirm_cutover',
  START_REMOVAL: 'rollout.start_removal',
  REMOVE_HOSTS: 'rollout.remove_hosts',
  ROLLBACK: 'rollout.rollback',
  CANCEL: 'rollout.cancel',
} as const;

/** Same character set as SESSION_HOST_NAME_PATTERN (alnum + dot/hyphen/underscore) — gallery image version strings (e.g. "2.1.0") fit it without needing a second bespoke pattern; 1-100 chars is generous headroom over the "X.Y.Z" convention the image-update runbook §2 documents. */
const IMAGE_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

function makeLogger(context: InvocationContext): AuditLogger {
  return { warn: (m) => context.warn(m), error: (m) => context.error(m), log: (m) => context.log(m) };
}

function auditMissingResponse(context: InvocationContext, correlationId: string, action: string): HttpResponseInit {
  context.error(`AUDIT_MISCONFIGURED | correlationId=${correlationId} action=${action} — AUDIT_STORAGE_ACCOUNT_NAME is unset in a deployed environment; refusing to mutate.`);
  const apiError: ApiError = {
    status: 500,
    code: 'audit_not_configured',
    message: `This environment cannot record an audit trail for this action, so it was not performed. Reference: ${correlationId}`,
    details: { correlationId },
  };
  return { status: 500, jsonBody: apiError };
}

/** `to: null` covers force-proceed's ambiguous target when the current state supports no force-proceed at all (see forceProceedNextState) — rendered as "a valid next state" rather than a specific (wrong) one. */
function illegalTransitionResponse(from: RolloutState, to: RolloutState | null, correlationId: string): HttpResponseInit {
  const apiError: ApiError = {
    status: 409,
    code: 'illegal_rollout_transition',
    message: to ? `Cannot move this plan from "${from}" to "${to}". Reference: ${correlationId}` : `This action is not valid from state "${from}". Reference: ${correlationId}`,
    details: { correlationId, from, to },
  };
  return { status: 409, jsonBody: apiError };
}

/** Used only where NO ARM mutation happened before the failed write (force-proceed, confirm-cutover, start-removal, cancel with all-retries-exhausted) — nothing irreversible to explain, so a plain "try again" conflict response is honest and sufficient. Contrast with the bespoke, ARM-aware messages handleStart/handleRollback/handleRemoveHosts build for their own exhausted-retry case. */
function conflictResponse(correlationId: string): HttpResponseInit {
  const apiError: ApiError = {
    status: 409,
    code: 'rollout_plan_conflict',
    message: `This plan was modified by another request. Reload it and try again. Reference: ${correlationId}`,
    details: { correlationId },
  };
  return { status: 409, jsonBody: apiError };
}

function notFoundResponse(correlationId: string, planId: string): HttpResponseInit {
  const apiError: ApiError = {
    status: 404,
    code: 'rollout_plan_not_found',
    message: `Rollout plan "${planId}" was not found. Reference: ${correlationId}`,
    details: { correlationId },
  };
  return { status: 404, jsonBody: apiError };
}

/**
 * Validates a request-supplied list of session host (or image version)
 * names: must be a non-empty array of strings, each matching `pattern`, at
 * most ROLLOUT_MAX_HOSTS entries, deduplicated (case-sensitive — ARM names
 * are case-sensitive). Bounds this app enforces itself, not an ARM limit —
 * see ROLLOUT_MAX_HOSTS's doc comment in rolloutPlanService.ts.
 */
function validateNameList(value: unknown, fieldName: string, pattern: RegExp): { ok: true; value: string[] } | { ok: false; response: HttpResponseInit } {
  if (!Array.isArray(value) || value.length === 0) {
    return { ok: false, response: badRequest(`missing_${fieldName}`, `${fieldName} (non-empty array of strings) is required.`) };
  }
  if (value.length > ROLLOUT_MAX_HOSTS) {
    return { ok: false, response: badRequest(`too_many_${fieldName}`, `${fieldName} must contain at most ${ROLLOUT_MAX_HOSTS} entries.`) };
  }
  const deduped = [...new Set(value)];
  for (const entry of deduped) {
    if (typeof entry !== 'string' || !pattern.test(entry)) {
      return { ok: false, response: badRequest(`invalid_${fieldName}`, `Every entry in ${fieldName} must be a valid name string.`) };
    }
  }
  return { ok: true, value: deduped as string[] };
}

/** Merges achieved per-host updates onto a FRESHLY-READ oldHosts array (matched by sessionHostName) — see persistWithMergeRetry's doc comment for why this must be a merge, never a blind overwrite. Any host not present in `updates` is returned unchanged. */
function mergeOldHostUpdates(freshOldHosts: readonly RolloutOldHost[], updates: ReadonlyMap<string, Partial<RolloutOldHost>>): RolloutOldHost[] {
  return freshOldHosts.map((host) => {
    const update = updates.get(host.sessionHostName);
    return update ? { ...host, ...update } : host;
  });
}

// ---------------------------------------------------------------------------
// GET /v1/hostpools/{hostPoolName}/rollout-plans  (list)
// POST /v1/hostpools/{hostPoolName}/rollout-plans  (create)
// ---------------------------------------------------------------------------

export async function listRolloutPlans(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const authResult = requireMinimumRole(request, 'admin', context);
  if (!authResult.ok) {
    return authResult.response;
  }

  const hostPoolName = request.params.hostPoolName;
  if (!hostPoolName) {
    return badRequest('missing_host_pool_name', 'hostPoolName route parameter is required.');
  }
  const scopeError = validateManagedHostPool(hostPoolName, getConfig().hostPoolName);
  if (scopeError) {
    return scopeError;
  }

  try {
    const { entities, truncated } = await listRolloutPlanEntitiesWithTruncation(hostPoolName);
    const responseBody: RolloutPlanListResponse = { plans: entities.map(toRolloutPlanDetail), truncated };
    return { status: 200, jsonBody: responseBody };
  } catch (error) {
    const correlationId = randomUUID();
    context.error(`rollout plan list failed | hostPoolName=${hostPoolName} correlationId=${correlationId}`, error);
    const apiError: ApiError = {
      status: 502,
      code: 'rollout_plan_list_failed',
      message: `Failed to list rollout plans. Reference: ${correlationId}`,
      details: { correlationId },
    };
    return { status: 502, jsonBody: apiError };
  }
}

/**
 * Creates a new plan in state 'planned'. TOCTOU-safe one-active-plan
 * enforcement (AM-28 peer review item 10): first claims the fixed-RowKey
 * "active" sentinel via rolloutPlanService.ts#createActiveSentinel — an
 * atomic createEntity that fails with a 409 if another create already won
 * the race, closing the gap a plain "list existing plans, check none are
 * active" read-then-write would leave open between two concurrent requests.
 * If the plan row itself then fails to write (rare — e.g. the Table goes
 * unavailable between the two calls), the sentinel is deleted again so the
 * host pool isn't left permanently stuck "active" with no real plan.
 */
export async function createRolloutPlan(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const correlationId = randomUUID();
  const logger = makeLogger(context);

  const authResult = requireMinimumRole(request, 'admin', context);
  if (!authResult.ok) {
    return authResult.response;
  }
  const { principal } = authResult;

  const hostPoolName = request.params.hostPoolName;
  if (!hostPoolName) {
    return badRequest('missing_host_pool_name', 'hostPoolName route parameter is required.');
  }
  const scopeError = validateManagedHostPool(hostPoolName, getConfig().hostPoolName);
  if (scopeError) {
    return scopeError;
  }

  let body: CreateRolloutPlanRequest;
  try {
    body = ((await request.json()) ?? {}) as CreateRolloutPlanRequest;
  } catch {
    return badRequest('invalid_request_body', 'Request body must be valid JSON.');
  }

  if (typeof body.targetImageVersion !== 'string' || !IMAGE_VERSION_PATTERN.test(body.targetImageVersion)) {
    return badRequest('invalid_target_image_version', 'targetImageVersion is required and must be a valid version string.');
  }
  const oldHostsResult = validateNameList(body.oldHostNames, 'oldHostNames', SESSION_HOST_NAME_PATTERN);
  if (!oldHostsResult.ok) {
    return oldHostsResult.response;
  }
  const newHostsResult = validateNameList(body.newHostNames, 'newHostNames', SESSION_HOST_NAME_PATTERN);
  if (!newHostsResult.ok) {
    return newHostsResult.response;
  }
  const reasonResult = validateMandatoryReason(body.reason);
  if (!reasonResult.ok) {
    return reasonResult.response;
  }

  if (isAuditRequiredButMissing()) {
    return auditMissingResponse(context, correlationId, ACTION.CREATE);
  }
  if (isRolloutStoreRequiredButMissing()) {
    context.error(`ROLLOUT_STORE_MISCONFIGURED | correlationId=${correlationId} — ROLLOUT_TABLE_NAME storage is unset in a deployed environment; refusing to create a plan.`);
    const apiError: ApiError = {
      status: 500,
      code: 'rollout_store_not_configured',
      message: `This environment cannot durably record a rollout plan, so it was not created. Reference: ${correlationId}`,
      details: { correlationId },
    };
    return { status: 500, jsonBody: apiError };
  }

  const actor = principal.userDetails;
  const actorId = principal.userId;
  const parameters = { targetImageVersion: body.targetImageVersion, oldHostNames: oldHostsResult.value, newHostNames: newHostsResult.value };
  const planId = randomUUID();

  try {
    await createActiveSentinel(hostPoolName, planId);
  } catch (error) {
    if (!isConflictError(error)) {
      context.error(`rollout plan create — sentinel write failed (not a 409 conflict) | hostPoolName=${hostPoolName} correlationId=${correlationId}`, error);
      const apiError: ApiError = { status: 502, code: 'rollout_plan_create_failed', message: `Failed to create the rollout plan. Reference: ${correlationId}`, details: { correlationId } };
      return { status: 502, jsonBody: apiError };
    }
    // Defensive secondary lookup for a friendlier message ONLY — the
    // createActiveSentinel call above is what actually enforces the rule;
    // this read is best-effort and never itself the source of truth.
    let activePlanId: string | undefined;
    try {
      activePlanId = (await getActiveSentinel(hostPoolName))?.activePlanId;
    } catch {
      // ignore — fall back to a generic message below.
    }
    const apiError: ApiError = {
      status: 409,
      code: 'rollout_plan_already_active',
      message: activePlanId
        ? `A rollout plan ("${activePlanId}") is already in progress for this host pool. Reference: ${correlationId}`
        : `A rollout plan is already in progress for this host pool. Reference: ${correlationId}`,
      details: { correlationId, activePlanId },
    };
    return { status: 409, jsonBody: apiError };
  }

  try {
    const now = new Date().toISOString();
    const oldHosts: RolloutOldHost[] = oldHostsResult.value.map((sessionHostName) => ({ sessionHostName, status: 'pending' }));
    const newHosts: RolloutNewHost[] = newHostsResult.value.map((sessionHostName) => ({ sessionHostName, status: 'awaiting_registration' }));

    const entity: RolloutPlanEntity = {
      partitionKey: hostPoolName,
      rowKey: planId,
      hostPoolName,
      targetImageVersion: body.targetImageVersion,
      state: 'planned',
      oldHostsJson: JSON.stringify(oldHosts),
      newHostsJson: JSON.stringify(newHosts),
      createdBy: actor,
      createdById: actorId,
      createdAt: now,
      updatedAt: now,
      reason: reasonResult.value,
    };
    await createRolloutPlanEntity(entity);

    try {
      await writeAuditEntry({ actor, actorId, action: ACTION.CREATE, target: `${hostPoolName}/${entity.rowKey}`, parameters, reason: reasonResult.value, outcome: 'success', correlationId }, logger);
    } catch (auditError) {
      context.warn(`audit write threw unexpectedly (ignored — plan already created) | correlationId=${correlationId} error=${String(auditError)}`);
    }

    const responseBody: RolloutPlanResponse = { plan: toRolloutPlanDetail(entity) };
    return { status: 201, jsonBody: responseBody };
  } catch (error) {
    context.error(`rollout plan create failed | hostPoolName=${hostPoolName} correlationId=${correlationId}`, error);
    try {
      await deleteActiveSentinel(hostPoolName);
    } catch (sentinelError) {
      context.error(`ROLLOUT_SENTINEL_CLEANUP_FAILED | hostPoolName=${hostPoolName} planId=${planId} correlationId=${correlationId} error=${String(sentinelError)}`);
    }
    await writeAuditEntry(
      { actor, actorId, action: ACTION.CREATE, target: hostPoolName, parameters, reason: reasonResult.value, outcome: 'failure', detail: error instanceof Error ? error.message : String(error), correlationId },
      logger,
    );
    const apiError: ApiError = { status: 502, code: 'rollout_plan_create_failed', message: `Failed to create the rollout plan. Reference: ${correlationId}`, details: { correlationId } };
    return { status: 502, jsonBody: apiError };
  }
}

export async function rolloutPlansDispatch(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  switch (request.method) {
    case 'GET':
      return listRolloutPlans(request, context);
    case 'POST':
      return createRolloutPlan(request, context);
    default: {
      const apiError: ApiError = { status: 405, code: 'method_not_allowed', message: `Method ${request.method} is not allowed on this route.` };
      return { status: 405, jsonBody: apiError };
    }
  }
}

app.http('rolloutPlans', {
  methods: ['GET', 'POST'],
  authLevel: 'anonymous',
  route: 'v1/hostpools/{hostPoolName}/rollout-plans',
  handler: rolloutPlansDispatch,
});

// ---------------------------------------------------------------------------
// GET /v1/hostpools/{hostPoolName}/rollout-plans/{planId}  (detail)
// ---------------------------------------------------------------------------

export async function rolloutPlanDetailHandler(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const authResult = requireRole(request, ['admin'], context);
  if (!authResult.ok) {
    return authResult.response;
  }

  const hostPoolName = request.params.hostPoolName;
  const planId = request.params.planId;
  if (!hostPoolName || !planId) {
    return badRequest('missing_route_params', 'hostPoolName and planId route parameters are required.');
  }
  const scopeError = validateManagedHostPool(hostPoolName, getConfig().hostPoolName);
  if (scopeError) {
    return scopeError;
  }

  try {
    const entity = await getRolloutPlanEntity(hostPoolName, planId);
    if (!entity) {
      return notFoundResponse(randomUUID(), planId);
    }
    const responseBody: RolloutPlanResponse = { plan: toRolloutPlanDetail(entity) };
    return { status: 200, jsonBody: responseBody };
  } catch (error) {
    const correlationId = randomUUID();
    context.error(`rollout plan read failed | planId=${planId} correlationId=${correlationId}`, error);
    const apiError: ApiError = { status: 502, code: 'rollout_plan_read_failed', message: `Failed to read the rollout plan. Reference: ${correlationId}`, details: { correlationId } };
    return { status: 502, jsonBody: apiError };
  }
}

app.http('rolloutPlanDetail', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'v1/hostpools/{hostPoolName}/rollout-plans/{planId}',
  handler: rolloutPlanDetailHandler,
});

// ---------------------------------------------------------------------------
// POST /v1/hostpools/{hostPoolName}/rollout-plans/{planId}/{action}
// ---------------------------------------------------------------------------

interface LoadedAction {
  principal: ClientPrincipal;
  hostPoolName: string;
  planId: string;
  record: RolloutPlanRecord;
  correlationId: string;
  logger: AuditLogger;
}

/** Shared boilerplate for every mutating action below: admin auth, route param presence, host pool scope, fail-closed audit/store checks, and the plan lookup. */
async function loadAction(request: HttpRequest, context: InvocationContext, auditAction: string): Promise<{ ok: true; value: LoadedAction } | { ok: false; response: HttpResponseInit }> {
  const correlationId = randomUUID();
  const logger = makeLogger(context);

  const authResult = requireMinimumRole(request, 'admin', context);
  if (!authResult.ok) {
    return { ok: false, response: authResult.response };
  }
  const { principal } = authResult;

  const hostPoolName = request.params.hostPoolName;
  const planId = request.params.planId;
  if (!hostPoolName || !planId) {
    return { ok: false, response: badRequest('missing_route_params', 'hostPoolName and planId route parameters are required.') };
  }
  const scopeError = validateManagedHostPool(hostPoolName, getConfig().hostPoolName);
  if (scopeError) {
    return { ok: false, response: scopeError };
  }

  if (isAuditRequiredButMissing()) {
    return { ok: false, response: auditMissingResponse(context, correlationId, auditAction) };
  }

  const record = await getRolloutPlanEntity(hostPoolName, planId);
  if (!record) {
    return { ok: false, response: notFoundResponse(correlationId, planId) };
  }

  return { ok: true, value: { principal, hostPoolName, planId, record, correlationId, logger } };
}

async function parseActionBody(request: HttpRequest): Promise<RolloutActionRequest | undefined> {
  try {
    return ((await request.json()) ?? {}) as RolloutActionRequest;
  } catch {
    return undefined;
  }
}

async function auditAction(logger: AuditLogger, action: string, target: string, actor: string, actorId: string, parameters: Record<string, unknown> | undefined, reason: string | undefined, outcome: 'success' | 'failure', correlationId: string, detail?: string): Promise<void> {
  await writeAuditEntry({ actor, actorId, action, target, parameters, reason, outcome, detail, correlationId }, logger);
}

/** Best-effort sentinel cleanup once a plan reaches a terminal state — logs a distinct, alertable marker on failure rather than throwing (see functionapp.bicep's ALERTING TODO list and rolloutPlanService.ts#deleteActiveSentinel's doc comment for why this must never block the state transition that triggered it). */
async function cleanupSentinelIfTerminal(hostPoolName: string, planId: string, newState: RolloutState, context: InvocationContext, correlationId: string): Promise<void> {
  if (!isTerminalState(newState)) {
    return;
  }
  try {
    await deleteActiveSentinel(hostPoolName);
  } catch (error) {
    context.error(`ROLLOUT_SENTINEL_CLEANUP_FAILED | hostPoolName=${hostPoolName} planId=${planId} correlationId=${correlationId} error=${String(error)}`);
  }
}

/** start: planned -> draining_old. Drains every old host (setSessionHostDrain allowNewSession:false); atomic — if any host's drain call fails, no state change is persisted and the whole action fails, so a retry starts from a clean 'planned' state rather than a plan with some hosts already draining and others not. See this file's header comment for the audit-before-write + merge-retry discipline this handler follows for its SUCCESS path. */
async function handleStart(request: HttpRequest, context: InvocationContext, loaded: LoadedAction): Promise<HttpResponseInit> {
  const { record, hostPoolName, planId, principal, correlationId, logger } = loaded;
  if (!canTransition(record.state, 'draining_old')) {
    return illegalTransitionResponse(record.state, 'draining_old', correlationId);
  }
  const body = (await parseActionBody(request)) ?? {};
  const reasonResult = validateOptionalReason(body.reason);
  if (!reasonResult.ok) {
    return reasonResult.response;
  }
  const oldHosts = parseOldHosts(record);
  const target = `${hostPoolName}/${planId}`;
  const actor = principal.userDetails;
  const actorId = principal.userId;

  const results = await Promise.allSettled(oldHosts.map((host) => setSessionHostDrain(hostPoolName, host.sessionHostName, false)));
  const failures = results.map((result, index) => ({ result, host: oldHosts[index] })).filter((entry) => entry.result.status === 'rejected');
  if (failures.length > 0) {
    const detail = failures.map((f) => `${f.host.sessionHostName}: ${f.result.status === 'rejected' ? String(f.result.reason) : ''}`).join('; ');
    context.error(`rollout start — draining failed for ${failures.length} host(s) | target=${target} correlationId=${correlationId}`, detail);
    await auditAction(logger, ACTION.START, target, actor, actorId, { oldHostNames: oldHosts.map((h) => h.sessionHostName) }, reasonResult.value, 'failure', correlationId, detail);
    const apiError: ApiError = { status: 502, code: 'rollout_start_drain_failed', message: `Failed to start draining ${failures.length} host(s) — no state change was made. Reference: ${correlationId}`, details: { correlationId } };
    return { status: 502, jsonBody: apiError };
  }

  // BLOCKER fix (item 1): audit the achieved ARM success BEFORE the state write.
  await auditAction(logger, ACTION.START, target, actor, actorId, { oldHostNames: oldHosts.map((h) => h.sessionHostName) }, reasonResult.value, 'success', correlationId);

  const drainedUpdates = new Map<string, Partial<RolloutOldHost>>(oldHosts.map((h) => [h.sessionHostName, { status: 'draining' as const }]));
  let updated: RolloutPlanEntity;
  try {
    updated = await persistWithMergeRetry(hostPoolName, planId, record, (fresh) => ({
      ...fresh,
      state: 'draining_old',
      updatedAt: new Date().toISOString(),
      oldHostsJson: JSON.stringify(mergeOldHostUpdates(parseOldHosts(fresh), drainedUpdates)),
    }));
  } catch (error) {
    context.error(`rollout start — state write failed after ARM drain already succeeded (audit already recorded) | target=${target} correlationId=${correlationId}`, error);
    const apiError: ApiError = {
      status: 502,
      code: 'rollout_start_state_write_failed',
      message: `Draining was submitted to Azure and audited, but the plan's saved state could not be updated just now. Reference: ${correlationId}. Reload the plan — it may already show "draining_old"; if it still shows "planned", retry this action (draining is idempotent).`,
      details: { correlationId },
    };
    return { status: 502, jsonBody: apiError };
  }

  const responseBody: RolloutPlanResponse = { plan: toRolloutPlanDetail(updated) };
  return { status: 200, jsonBody: responseBody };
}

/**
 * force-proceed: an escape hatch past either of the two automatic-wait
 * states (AM-28 peer review item 6 extended this beyond its original
 * single use) —
 *   - draining_old -> awaiting_new_hosts, bypassing the zero-sessions wait.
 *   - awaiting_new_hosts -> validating_new, bypassing the
 *     "every declared new host observed at all" wait.
 * See rolloutPlanService.ts#forceProceedNextState for the pure mapping.
 * MANDATORY reason either way. No ARM mutation — old/new-host statuses are
 * left AS OBSERVED (not fabricated), so a plain conflictResponse on an
 * exhausted merge-retry is fine here (nothing irreversible to explain).
 */
async function handleForceProceed(request: HttpRequest, loaded: LoadedAction): Promise<HttpResponseInit> {
  const { record, hostPoolName, planId, principal, correlationId, logger } = loaded;
  const next = forceProceedNextState(record.state);
  if (!next) {
    return illegalTransitionResponse(record.state, null, correlationId);
  }
  const body = (await parseActionBody(request)) ?? {};
  const reasonResult = validateMandatoryReason(body.reason);
  if (!reasonResult.ok) {
    return reasonResult.response;
  }
  const target = `${hostPoolName}/${planId}`;
  const actor = principal.userDetails;
  const actorId = principal.userId;
  const now = new Date().toISOString();

  let updated: RolloutPlanEntity;
  try {
    updated = await persistWithMergeRetry(hostPoolName, planId, record, (fresh) => ({
      ...fresh,
      state: next,
      updatedAt: now,
      forcedProceedAt: now,
      forcedProceedBy: actor,
      forcedProceedReason: reasonResult.value,
    }));
  } catch (error) {
    if (isPreconditionFailedError(error)) {
      return conflictResponse(correlationId);
    }
    throw error;
  }

  await auditAction(logger, ACTION.FORCE_PROCEED, target, actor, actorId, { from: record.state, to: next }, reasonResult.value, 'success', correlationId);
  const responseBody: RolloutPlanResponse = { plan: toRolloutPlanDetail(updated) };
  return { status: 200, jsonBody: responseBody };
}

/**
 * confirm-cutover: validating_new -> cutover. Gated on THREE conditions for
 * every new host, unless force:true (with a mandatory reason) —
 *   - Available + healthy (allNewHostsAvailableAndHealthy).
 *   - Its VM's image version verified against targetImageVersion
 *     (allNewHostsImageVerified — AM-28 peer review item 4; populated by
 *     the timer's refreshNewHosts via computeService.ts#getVmImageReference).
 *   - Its FSLogix config-convergence check passed (allNewHostsConfigVerified
 *     — AM-47, the third gate; populated by handleVerifyConfig below +
 *     the timer's validating_new poll via app/api/src/lib/fslogixConfigCheck.ts).
 * force:true bypasses ALL THREE together (see @avdmgr/shared's
 * RolloutActionRequest.force doc comment) — a forced cutover still marks
 * every new host 'validated' (the operator's override IS the validation).
 */
async function handleConfirmCutover(request: HttpRequest, loaded: LoadedAction): Promise<HttpResponseInit> {
  const { record, hostPoolName, planId, principal, correlationId, logger } = loaded;
  if (!canTransition(record.state, 'cutover')) {
    return illegalTransitionResponse(record.state, 'cutover', correlationId);
  }
  const body = (await parseActionBody(request)) ?? {};
  const newHosts = parseNewHosts(record);
  const target = `${hostPoolName}/${planId}`;
  const actor = principal.userDetails;
  const actorId = principal.userId;

  const readyForAvailability = allNewHostsAvailableAndHealthy(newHosts);
  const readyForImage = allNewHostsImageVerified(newHosts);
  const readyForConfig = allNewHostsConfigVerified(newHosts);
  if (!body.force && (!readyForAvailability || !readyForImage || !readyForConfig)) {
    const reasons: string[] = [];
    if (!readyForAvailability) reasons.push('not every new host is Available and healthy yet');
    if (!readyForImage) reasons.push(`not every new host's VM image has been verified against target version "${record.targetImageVersion}"`);
    if (!readyForConfig) reasons.push('not every new host passed the FSLogix config-convergence check');
    const apiError: ApiError = {
      status: 409,
      code: 'rollout_new_hosts_not_ready',
      message: `${reasons.join('; ')}. Set force:true (with a reason) to cut over anyway. Reference: ${correlationId}`,
      details: { correlationId, readyForAvailability, readyForImage, readyForConfig },
    };
    return { status: 409, jsonBody: apiError };
  }
  let reason: string | undefined;
  if (body.force) {
    const reasonResult = validateMandatoryReason(body.reason);
    if (!reasonResult.ok) {
      return reasonResult.response;
    }
    reason = reasonResult.value;
  } else if (body.reason !== undefined) {
    if (typeof body.reason !== 'string' || body.reason.length > MAX_REASON_LENGTH) {
      return badRequest('invalid_reason', `reason, if provided, must be a string of at most ${MAX_REASON_LENGTH} characters.`);
    }
    reason = body.reason;
  }

  const now = new Date().toISOString();
  // Marks every new host 'validated' at the moment of operator confirmation
  // — the terminal RolloutNewHostStatus (see @avdmgr/shared's doc comment on
  // that type), distinct from the timer's own 'available' status: 'available'
  // reflects what ARM currently reports, 'validated' records that an admin
  // explicitly signed off on cutting over to it (even a force:true cutover
  // marks hosts validated — the operator's override IS the validation).
  const validatedUpdates = new Map<string, Partial<RolloutNewHost>>(newHosts.map((h) => [h.sessionHostName, { status: 'validated' as const }]));

  let updated: RolloutPlanEntity;
  try {
    updated = await persistWithMergeRetry(hostPoolName, planId, record, (fresh) => ({
      ...fresh,
      state: 'cutover',
      updatedAt: now,
      cutoverAt: now,
      cutoverBy: actor,
      newHostsJson: JSON.stringify(mergeNewHostUpdates(parseNewHosts(fresh), validatedUpdates)),
    }));
  } catch (error) {
    if (isPreconditionFailedError(error)) {
      return conflictResponse(correlationId);
    }
    throw error;
  }

  await auditAction(logger, ACTION.CONFIRM_CUTOVER, target, actor, actorId, { forced: Boolean(body.force), readyForAvailability, readyForImage, readyForConfig }, reason, 'success', correlationId);
  const responseBody: RolloutPlanResponse = { plan: toRolloutPlanDetail(updated) };
  return { status: 200, jsonBody: responseBody };
}

/**
 * verify-config (AM-47): legal ONLY in state validating_new (409
 * illegal-transition style error otherwise, same convention as every other
 * action) — no state transition occurs; this action only kicks off/re-kicks
 * off the per-host config checks the timer's validating_new poll then
 * resolves on a later tick (see rolloutPlanTimer.ts and
 * app/api/src/lib/fslogixConfigCheck.ts).
 *
 * Re-runs for ALL new hosts every time it's called — including hosts
 * already 'passed' — so an operator who just fixed the Intune profile (see
 * The FSLogix storage runbook §5.1's ADMX 0x86000009 remediation)
 * can re-verify everyone in one click rather than needing a per-host retry
 * affordance.
 *
 * LAZY BASELINE BACKFILL: a plan row created before AM-47 has no
 * `configBaselineJson` at all (RolloutPlanEntity.configBaselineJson is
 * optional specifically for this reason). This handler backfills it from
 * the CURRENT `getConfig().fslogixBaseline` the first time verify-config
 * runs against such a row — persisted in the SAME write as the per-host
 * submit updates below. A plan that already carries a baseline (the normal
 * post-AM-47 case) keeps its ORIGINAL frozen value; this handler never
 * overwrites an existing one.
 *
 * PER-HOST PARTIAL-FAILURE ISOLATION (mirrors remove-hosts's per-host
 * isolation, not this file's audit-before-write BLOCKER discipline — see
 * below for why that discipline does not apply here): a host whose
 * resolve/submit rejects gets `configCheck = { status: 'error', error:
 * <generic classified string> }` instead of failing the whole batch. Raw
 * ARM error text goes only to context.warn (CWE-532 posture, same
 * classification shape as rolloutPlanTimer.ts#classifyTimerError — this
 * handler does not import that function since it is timer-file-local, but
 * mirrors its two-line-classification approach for consistency).
 *
 * NOT AN IRREVERSIBLE MUTATION: unlike handleStart/handleRollback/
 * handleRemoveHosts, a Run Command v2 submit here is trivially
 * re-submittable (createOrUpdate overwrites by name — see
 * computeService.ts#submitFslogixConfigCheck's doc comment), so this
 * handler does not need this file's audit-BEFORE-write BLOCKER discipline
 * for durability reasons. It still audits (once, after every host has been
 * attempted) and still uses persistWithMergeRetry rather than a bare
 * replaceRolloutPlanEntity — purely so a 412 from a concurrent timer tick
 * merges and retries instead of surfacing as a spurious "plan conflict" to
 * the operator, the same ergonomic (not durability) reasoning
 * force-proceed/start-removal apply their own persistWithMergeRetry calls
 * for.
 */
async function handleVerifyConfig(request: HttpRequest, context: InvocationContext, loaded: LoadedAction): Promise<HttpResponseInit> {
  const { record, hostPoolName, planId, principal, correlationId, logger } = loaded;
  if (record.state !== 'validating_new') {
    return illegalTransitionResponse(record.state, 'validating_new', correlationId);
  }
  // No fields of its own (see @avdmgr/shared's RolloutActionRequest doc
  // comment) — parsed only so this action shares every other action's
  // "malformed JSON body degrades to {}" convention, not a distinct 400.
  void ((await parseActionBody(request)) ?? {});

  const newHosts = parseNewHosts(record);
  const target = `${hostPoolName}/${planId}`;
  const actor = principal.userDetails;
  const actorId = principal.userId;
  const now = new Date().toISOString();
  const baseline = parseConfigBaseline(record) ?? getConfig().fslogixBaseline;

  const configCheckUpdates = new Map<string, Partial<RolloutNewHost>>();
  for (const host of newHosts) {
    try {
      const vmTarget = await resolveSessionHostVm(hostPoolName, host.sessionHostName);
      await submitFslogixConfigCheck(vmTarget.resourceGroup, vmTarget.vmName);
      configCheckUpdates.set(host.sessionHostName, { configCheck: { status: 'in_progress', submittedAt: now } });
    } catch (error) {
      context.warn(`rollout verify-config — submit failed for ${host.sessionHostName} (isolated — other hosts unaffected) | target=${target} correlationId=${correlationId} error=${String(error)}`);
      configCheckUpdates.set(host.sessionHostName, {
        configCheck: { status: 'error', error: isArmNotFoundError(error) ? 'Host or VM not found in Azure.' : 'Azure request failed while submitting the config check.' },
      });
    }
  }

  await auditAction(logger, ACTION.VERIFY_CONFIG, target, actor, actorId, { sessionHostNames: newHosts.map((h) => h.sessionHostName) }, undefined, 'success', correlationId);

  let updated: RolloutPlanEntity;
  try {
    updated = await persistWithMergeRetry(hostPoolName, planId, record, (fresh) => ({
      ...fresh,
      updatedAt: new Date().toISOString(),
      configBaselineJson: fresh.configBaselineJson ?? JSON.stringify(baseline),
      newHostsJson: JSON.stringify(mergeNewHostUpdates(parseNewHosts(fresh), configCheckUpdates)),
    }));
  } catch (error) {
    if (isPreconditionFailedError(error)) {
      return conflictResponse(correlationId);
    }
    throw error;
  }

  const responseBody: RolloutPlanResponse = { plan: toRolloutPlanDetail(updated) };
  return { status: 200, jsonBody: responseBody };
}

/** start-removal: cutover -> removing_old. No host mutation — removal itself happens via remove-hosts. */
async function handleStartRemoval(request: HttpRequest, loaded: LoadedAction): Promise<HttpResponseInit> {
  const { record, hostPoolName, planId, principal, correlationId, logger } = loaded;
  if (!canTransition(record.state, 'removing_old')) {
    return illegalTransitionResponse(record.state, 'removing_old', correlationId);
  }
  const body = (await parseActionBody(request)) ?? {};
  const reasonResult = validateOptionalReason(body.reason);
  if (!reasonResult.ok) {
    return reasonResult.response;
  }
  const target = `${hostPoolName}/${planId}`;
  const actor = principal.userDetails;
  const actorId = principal.userId;
  const now = new Date().toISOString();

  let updated: RolloutPlanEntity;
  try {
    updated = await persistWithMergeRetry(hostPoolName, planId, record, (fresh) => ({ ...fresh, state: 'removing_old', updatedAt: now }));
  } catch (error) {
    if (isPreconditionFailedError(error)) {
      return conflictResponse(correlationId);
    }
    throw error;
  }

  await auditAction(logger, ACTION.START_REMOVAL, target, actor, actorId, undefined, reasonResult.value, 'success', correlationId);
  const responseBody: RolloutPlanResponse = { plan: toRolloutPlanDetail(updated) };
  return { status: 200, jsonBody: responseBody };
}

/**
 * remove-hosts: batch removal within removing_old. THE HARD GATE
 * (rolloutPlanService.ts#canRemoveHost) is re-checked per host via a FRESH
 * ARM read (resolveSessionHostVm) immediately before acting — never a
 * cached/stale count — and has NO force bypass anywhere in this handler.
 *
 * AM-28 peer review item 3 — DEALLOCATE DROPPED: an earlier version of this
 * handler deallocated each VM before deleting it. That step is REMOVED —
 * VM deletion does not require the VM to be deallocated first (Azure
 * deletes a running or deallocated VM identically), the hard zero-sessions
 * gate above is what actually makes removal safe, and a submitted-but-not-
 * yet-complete deallocate LRO racing an immediately-following delete call
 * risked an ARM "conflicting operation" error for no safety benefit. See
 * infra/modules/rolloutOperatorRole.bicep, which no longer grants
 * virtualMachines/deallocate/action for exactly this reason.
 *
 * AM-28 peer review item 2 — RESUMABLE REMOVAL: this handler checkpoints
 * its progress to the plan row TWICE before its own final write, so a
 * crash or failure partway through a batch never stalls or strands a host:
 *   1. Before ANY deregistration: persists each host's resolved
 *      resourceGroup/vmName (RolloutOldHost.resourceGroup/vmName).
 *   2. After deregistration succeeds, before VM deletion: persists
 *      RolloutOldHost.deregisteredAt.
 * A host already carrying `deregisteredAt` + `resourceGroup`/`vmName` on
 * retry skips resolveSessionHostVm (and re-verifying the hard gate)
 * entirely and goes straight to VM deletion using the cached target — the
 * AVD registration is already gone by then, so a fresh resolveSessionHostVm
 * call would 404 and (without this check) incorrectly report the host as
 * unresolvable/stranded. A host already `status: 'removed'` from a prior
 * batch is treated as an idempotent no-op success, not re-processed.
 *
 * Per-host, on a passing gate: deregister the session host
 * (avdService.ts#removeSessionHost, force:false), then delete the VM
 * (computeService.ts#beginVmDelete, submitted only). A failure at either
 * step fails that host's entry in the batch result
 * (RemoveRolloutHostFailure) WITHOUT aborting the remaining hosts in the
 * batch — same partial-failure posture as
 * app/api/src/lib/sessionBatch.ts's runSessionBatch.
 *
 * DELIBERATELY OUT OF SCOPE (see the session-host lifecycle runbook
 * §5's "four separate deletions" — registration, VM, NIC, disk, plus
 * Entra/Intune device cleanup which that runbook itself flags as
 * `⚠ not captured`): this handler performs the first two deletions only
 * (registration + VM). The NIC and OS disk are intentionally left in place —
 * deleting them needs Microsoft.Network/networkInterfaces/delete and
 * Microsoft.Compute/disks/delete, neither of which
 * infra/modules/rolloutOperatorRole.bicep grants (see that file's
 * blast-radius comment) — and Entra/Intune device cleanup has no captured,
 * automatable procedure on this estate at all. An operator must still run
 * The session-host lifecycle runbook §5.1 steps 2-3 by hand
 * after a batch here reports success; this is a documented, accepted
 * boundary, not an oversight.
 */
async function handleRemoveHosts(request: HttpRequest, context: InvocationContext, loaded: LoadedAction): Promise<HttpResponseInit> {
  const { record, hostPoolName, planId, principal, correlationId, logger } = loaded;
  if (record.state !== 'removing_old') {
    return illegalTransitionResponse(record.state, 'removing_old', correlationId);
  }

  let body: RemoveRolloutHostsRequest;
  try {
    body = ((await request.json()) ?? {}) as RemoveRolloutHostsRequest;
  } catch {
    return badRequest('invalid_request_body', 'Request body must be valid JSON.');
  }
  const namesResult = validateNameList(body.sessionHostNames, 'sessionHostNames', SESSION_HOST_NAME_PATTERN);
  if (!namesResult.ok) {
    return namesResult.response;
  }
  const reasonResult = validateMandatoryReason(body.reason);
  if (!reasonResult.ok) {
    return reasonResult.response;
  }

  const oldHosts = parseOldHosts(record);
  const byName = new Map(oldHosts.map((h) => [h.sessionHostName, h]));
  const unknown = namesResult.value.filter((name) => !byName.has(name));
  if (unknown.length > 0) {
    return badRequest('unknown_rollout_host', `Not part of this plan's old-host list: ${unknown.join(', ')}.`);
  }

  const target = `${hostPoolName}/${planId}`;
  const actor = principal.userDetails;
  const actorId = principal.userId;

  const succeeded: string[] = [];
  const failed: RemoveRolloutHostFailure[] = [];
  const resolvedTargets = new Map<string, { resourceGroup: string; vmName: string }>();
  const checkpoint1Updates = new Map<string, Partial<RolloutOldHost>>();

  // PHASE 0: resolve or resume, applying the hard gate for anything not already past it.
  for (const name of namesResult.value) {
    const host = byName.get(name)!;
    if (host.status === 'removed') {
      succeeded.push(name); // idempotent — already done in a prior batch.
      continue;
    }
    if (host.deregisteredAt && host.resourceGroup && host.vmName) {
      resolvedTargets.set(name, { resourceGroup: host.resourceGroup, vmName: host.vmName });
      continue; // RESUME — already deregistered; skip resolve/re-gate entirely (item 2).
    }
    try {
      const vmTarget = await resolveSessionHostVm(hostPoolName, name);
      if (!canRemoveHost(vmTarget.activeSessions)) {
        failed.push({ sessionHostName: name, message: `Refused — ${vmTarget.activeSessions} active session(s) remain (server-verified).` });
        continue;
      }
      resolvedTargets.set(name, { resourceGroup: vmTarget.resourceGroup, vmName: vmTarget.vmName });
      checkpoint1Updates.set(name, { resourceGroup: vmTarget.resourceGroup, vmName: vmTarget.vmName });
    } catch (error) {
      failed.push({
        sessionHostName: name,
        message: isArmNotFoundError(error) ? 'Host not found in Azure — if it was already deregistered outside this app, ask an admin to resolve manually.' : 'Azure request failed while resolving the host.',
      });
    }
  }

  let currentRecord: RolloutPlanRecord = record;

  // CHECKPOINT 1 (item 2): persist resourceGroup/vmName BEFORE any deregistration.
  if (checkpoint1Updates.size > 0) {
    try {
      await persistWithMergeRetry(hostPoolName, planId, currentRecord, (fresh) => ({
        ...fresh,
        updatedAt: new Date().toISOString(),
        oldHostsJson: JSON.stringify(mergeOldHostUpdates(parseOldHosts(fresh), checkpoint1Updates)),
      }));
      const reread = await getRolloutPlanEntity(hostPoolName, planId);
      if (reread) currentRecord = reread;
    } catch (error) {
      // Not fatal to this attempt — continue with the in-memory resolvedTargets. If this WHOLE
      // request later fails entirely, a retry re-resolves these hosts from ARM fresh (safe: the
      // hard gate is re-verified either way), just without the resume-straight-to-delete shortcut.
      context.error(`rollout remove-hosts — checkpoint write (resourceGroup/vmName) failed; continuing with in-memory targets for this attempt | target=${target} correlationId=${correlationId}`, error);
    }
  }

  // PHASE 2a: deregister every host not already deregistered.
  const deregisterUpdates = new Map<string, Partial<RolloutOldHost>>();
  const readyForDelete: string[] = [];
  for (const name of resolvedTargets.keys()) {
    const host = byName.get(name)!;
    if (host.deregisteredAt) {
      readyForDelete.push(name); // resumed.
      continue;
    }
    try {
      await removeSessionHost(hostPoolName, name, false);
      deregisterUpdates.set(name, { deregisteredAt: new Date().toISOString() });
      readyForDelete.push(name);
    } catch (error) {
      context.error(`rollout remove-hosts — deregistration failed | host=${name} target=${target} correlationId=${correlationId}`, error);
      failed.push({ sessionHostName: name, message: 'Azure request failed while deregistering the host.' });
    }
  }

  // CHECKPOINT 2 (item 2): persist deregisteredAt BEFORE VM deletion.
  if (deregisterUpdates.size > 0) {
    try {
      await persistWithMergeRetry(hostPoolName, planId, currentRecord, (fresh) => ({
        ...fresh,
        updatedAt: new Date().toISOString(),
        oldHostsJson: JSON.stringify(mergeOldHostUpdates(parseOldHosts(fresh), deregisterUpdates)),
      }));
      const reread = await getRolloutPlanEntity(hostPoolName, planId);
      if (reread) currentRecord = reread;
    } catch (error) {
      // Not fatal — ARM deregistration already happened regardless; the FINAL write below still
      // carries deregisterUpdates and will persist it via merge-retry even if this checkpoint didn't land.
      context.error(`rollout remove-hosts — checkpoint write (deregisteredAt) failed; proceeding to VM deletion (ARM deregistration already succeeded) | target=${target} correlationId=${correlationId}`, error);
    }
  }

  // PHASE 2b: delete VMs.
  const deleteUpdates = new Map<string, Partial<RolloutOldHost>>();
  for (const name of readyForDelete) {
    const vmTarget = resolvedTargets.get(name)!;
    try {
      await beginVmDelete(vmTarget.resourceGroup, vmTarget.vmName);
      deleteUpdates.set(name, { status: 'removed', removedAt: new Date().toISOString(), lastObservedSessions: 0 });
      succeeded.push(name);
    } catch (error) {
      context.error(`rollout remove-hosts — VM delete failed | host=${name} target=${target} correlationId=${correlationId}`, error);
      failed.push({ sessionHostName: name, message: 'Azure request failed while deleting the VM — the host was already deregistered; a retry will skip straight to VM deletion.' });
    }
  }

  // BLOCKER fix (item 1): audit the achieved ARM outcome BEFORE the final state write.
  const result: RemoveRolloutHostsResult = { attempted: namesResult.value.length, succeeded, failed };
  await auditAction(
    logger,
    ACTION.REMOVE_HOSTS,
    target,
    actor,
    actorId,
    { sessionHostNames: namesResult.value, succeeded, failedCount: failed.length },
    reasonResult.value,
    failed.length === 0 ? 'success' : 'failure',
    correlationId,
    failed.length > 0 ? JSON.stringify(failed) : undefined,
  );

  const finalUpdates = new Map<string, Partial<RolloutOldHost>>();
  for (const [name, upd] of deregisterUpdates) finalUpdates.set(name, { ...finalUpdates.get(name), ...upd });
  for (const [name, upd] of deleteUpdates) finalUpdates.set(name, { ...finalUpdates.get(name), ...upd });

  let updated: RolloutPlanEntity;
  try {
    updated = await persistWithMergeRetry(hostPoolName, planId, currentRecord, (fresh) => {
      const mergedOld = mergeOldHostUpdates(parseOldHosts(fresh), finalUpdates);
      const allRemoved = mergedOld.length > 0 && mergedOld.every((h) => h.status === 'removed');
      const now = new Date().toISOString();
      return { ...fresh, oldHostsJson: JSON.stringify(mergedOld), updatedAt: now, state: allRemoved ? 'done' : fresh.state, completedAt: allRemoved ? now : fresh.completedAt };
    });
  } catch (error) {
    context.error(`rollout remove-hosts — FINAL state write failed after ARM mutations already applied (audit already recorded) | target=${target} correlationId=${correlationId}`, error);
    const apiError: ApiError = {
      status: 502,
      code: 'rollout_remove_hosts_state_write_failed',
      message: `The removal(s) were submitted to Azure and audited, but the plan's saved progress could not be updated just now. Reference: ${correlationId}. Reload the plan and retry the SAME request — already-removed hosts are skipped safely, and hosts already deregistered resume straight to VM deletion.`,
      details: { correlationId },
    };
    return { status: 502, jsonBody: apiError };
  }

  await cleanupSentinelIfTerminal(hostPoolName, planId, updated.state, context, correlationId);

  const responseBody: RemoveRolloutHostsResponse = { plan: toRolloutPlanDetail(updated), result };
  return { status: 200, jsonBody: responseBody };
}

/** Merges achieved per-host NEW-host updates onto a FRESHLY-READ newHosts array — same rationale as mergeOldHostUpdates. */
function mergeNewHostUpdates(freshNewHosts: readonly RolloutNewHost[], updates: ReadonlyMap<string, Partial<RolloutNewHost>>): RolloutNewHost[] {
  return freshNewHosts.map((host) => {
    const update = updates.get(host.sessionHostName);
    return update ? { ...host, ...update } : host;
  });
}

/**
 * rollback: any non-terminal state -> rolled_back. MANDATORY reason.
 *
 * THE ROLLBACK SEAM (this story's central design decision — see this
 * story's report for the full rationale): rather than two separate
 * pre-/post-removal rollback endpoints, this is ONE action whose PER-HOST
 * effect depends on that host's own recorded status —
 *   - still present (any status other than 'removed'): un-drained
 *     (setSessionHostDrain allowNewSession:true), best-effort — a failure
 *     here is recorded (both in the audit detail AND durably on the plan —
 *     see RolloutPlanDetail.rollbackUndrainFailures) but does not block
 *     marking the plan rolled_back, since it is independently recoverable
 *     via the HostPool page's existing drain toggle.
 *   - already 'removed': NOT un-drained (nothing to un-drain — the host no
 *     longer exists); its name is instead collected into
 *     RolloutPlanDetail.rollbackNeedsReadd, guidance-only, pointing the
 *     operator at the guided Add Session Host flow (AM-22 —
 *     AddSessionHostPanel.tsx) to re-provision it on the PRIOR image
 *     version. AM-27's build/test-host flow is not present on this app's
 *     base as of this story (confirmed: no AM-26/AM-27 code exists in this
 *     tree) — if it lands later, this is the seam where it would plug in as
 *     a richer alternative to the AM-22 guidance, without changing this
 *     handler's contract.
 * This reconciles the spec's two rollback descriptions ("un-drain old hosts"
 * pre-removal vs. "guided re-add" post-removal) as one endpoint whose
 * behavior is honest about what actually happened to each host, rather than
 * forcing the caller to know which variant to call.
 *
 * AM-28 peer review item 5 — ALSO DRAINS NEW HOSTS: every registered new
 * (vNext) host is ALSO drained (allowNewSession: false, the SAME existing
 * drain primitive, no new RBAC) — see RolloutPlanDetail.rollbackDrainedNewHosts
 * — so a rolled-back rollout doesn't silently leave freshly-added vNext
 * hosts still accepting sessions on a version the operator just decided to
 * abandon. Un-draining them back (if the operator wants them to keep
 * serving anyway) is a documented manual follow-up via the HostPool page,
 * not something this action does automatically.
 */
async function handleRollback(request: HttpRequest, context: InvocationContext, loaded: LoadedAction): Promise<HttpResponseInit> {
  const { record, hostPoolName, planId, principal, correlationId, logger } = loaded;
  if (!canTransition(record.state, 'rolled_back')) {
    return illegalTransitionResponse(record.state, 'rolled_back', correlationId);
  }
  const body = (await parseActionBody(request)) ?? {};
  const reasonResult = validateMandatoryReason(body.reason);
  if (!reasonResult.ok) {
    return reasonResult.response;
  }
  const target = `${hostPoolName}/${planId}`;
  const actor = principal.userDetails;
  const actorId = principal.userId;

  const oldHosts = parseOldHosts(record);
  const newHosts = parseNewHosts(record);
  const needsReadd: string[] = [];
  const undrainFailures: string[] = [];
  const oldHostUpdates = new Map<string, Partial<RolloutOldHost>>();

  for (const host of oldHosts) {
    if (host.status === 'removed') {
      needsReadd.push(host.sessionHostName);
      continue;
    }
    try {
      await setSessionHostDrain(hostPoolName, host.sessionHostName, true);
    } catch (error) {
      context.warn(`rollout rollback — un-drain failed for ${host.sessionHostName} (recoverable via HostPool drain toggle) | target=${target} correlationId=${correlationId} error=${String(error)}`);
      undrainFailures.push(host.sessionHostName);
    }
    oldHostUpdates.set(host.sessionHostName, { status: 'undrained_rollback' });
  }

  // item 5: also drain new hosts — only for hosts actually observed in AVD (a still-'awaiting_registration' host has no AVD object to drain).
  const drainedNewHostNames: string[] = [];
  const newHostDrainFailures: string[] = [];
  for (const host of newHosts) {
    if (host.status === 'awaiting_registration') {
      continue;
    }
    try {
      await setSessionHostDrain(hostPoolName, host.sessionHostName, false);
      drainedNewHostNames.push(host.sessionHostName);
    } catch (error) {
      context.warn(`rollout rollback — draining new host failed for ${host.sessionHostName} (recoverable via HostPool drain toggle) | target=${target} correlationId=${correlationId} error=${String(error)}`);
      newHostDrainFailures.push(host.sessionHostName);
    }
  }

  // BLOCKER fix (item 1): audit BEFORE the state write.
  await auditAction(
    logger,
    ACTION.ROLLBACK,
    target,
    actor,
    actorId,
    { needsReadd, undrainFailures, drainedNewHostNames, newHostDrainFailures },
    reasonResult.value,
    'success',
    correlationId,
    undrainFailures.length > 0 || newHostDrainFailures.length > 0 ? `un-drain failed for: ${undrainFailures.join(', ') || 'none'}; new-host drain failed for: ${newHostDrainFailures.join(', ') || 'none'}` : undefined,
  );

  let updated: RolloutPlanEntity;
  try {
    updated = await persistWithMergeRetry(hostPoolName, planId, record, (fresh) => {
      const now = new Date().toISOString();
      return {
        ...fresh,
        state: 'rolled_back',
        updatedAt: now,
        rollbackAt: now,
        rollbackBy: actor,
        rollbackReason: reasonResult.value,
        oldHostsJson: JSON.stringify(mergeOldHostUpdates(parseOldHosts(fresh), oldHostUpdates)),
        rollbackNeedsReaddJson: needsReadd.length > 0 ? JSON.stringify(needsReadd) : undefined,
        rollbackDrainedNewHostsJson: drainedNewHostNames.length > 0 ? JSON.stringify(drainedNewHostNames) : undefined,
        rollbackUndrainFailuresJson: undrainFailures.length > 0 ? JSON.stringify(undrainFailures) : undefined,
        rollbackNewHostDrainFailuresJson: newHostDrainFailures.length > 0 ? JSON.stringify(newHostDrainFailures) : undefined,
      };
    });
  } catch (error) {
    context.error(`rollout rollback — state write failed after ARM un-drain/drain already applied (audit already recorded) | target=${target} correlationId=${correlationId}`, error);
    const apiError: ApiError = {
      status: 502,
      code: 'rollout_rollback_state_write_failed',
      message: `Rollback actions were submitted to Azure and audited, but the plan's saved state could not be updated just now. Reference: ${correlationId}. Reload the plan and retry — already-applied host changes are safe to repeat.`,
      details: { correlationId },
    };
    return { status: 502, jsonBody: apiError };
  }

  await cleanupSentinelIfTerminal(hostPoolName, planId, updated.state, context, correlationId);

  const responseBody: RolloutPlanResponse = { plan: toRolloutPlanDetail(updated) };
  return { status: 200, jsonBody: responseBody };
}

/** cancel: planned -> cancelled only (nothing has mutated yet at that point — see the transition graph in rolloutPlanService.ts). */
async function handleCancel(request: HttpRequest, context: InvocationContext, loaded: LoadedAction): Promise<HttpResponseInit> {
  const { record, hostPoolName, planId, principal, correlationId, logger } = loaded;
  if (!canTransition(record.state, 'cancelled')) {
    return illegalTransitionResponse(record.state, 'cancelled', correlationId);
  }
  const body = (await parseActionBody(request)) ?? {};
  const reasonResult = validateOptionalReason(body.reason);
  if (!reasonResult.ok) {
    return reasonResult.response;
  }
  const target = `${hostPoolName}/${planId}`;
  const actor = principal.userDetails;
  const actorId = principal.userId;
  const now = new Date().toISOString();

  let updated: RolloutPlanEntity;
  try {
    updated = await persistWithMergeRetry(hostPoolName, planId, record, (fresh) => ({ ...fresh, state: 'cancelled', updatedAt: now, cancelledAt: now, cancelledBy: actor }));
  } catch (error) {
    if (isPreconditionFailedError(error)) {
      return conflictResponse(correlationId);
    }
    throw error;
  }

  await cleanupSentinelIfTerminal(hostPoolName, planId, updated.state, context, correlationId);

  await auditAction(logger, ACTION.CANCEL, target, actor, actorId, undefined, reasonResult.value, 'success', correlationId);
  const responseBody: RolloutPlanResponse = { plan: toRolloutPlanDetail(updated) };
  return { status: 200, jsonBody: responseBody };
}

const ACTION_AUDIT_NAMES: Record<string, string> = {
  start: ACTION.START,
  'force-proceed': ACTION.FORCE_PROCEED,
  'verify-config': ACTION.VERIFY_CONFIG,
  'confirm-cutover': ACTION.CONFIRM_CUTOVER,
  'start-removal': ACTION.START_REMOVAL,
  'remove-hosts': ACTION.REMOVE_HOSTS,
  rollback: ACTION.ROLLBACK,
  cancel: ACTION.CANCEL,
};

/**
 * Single dispatcher for every POST .../{planId}/{action} route — same
 * "one app.http registration, dispatch internally" rationale as
 * hostPoolRegistrationToken.ts's hostPoolRegistrationTokenDispatch (see that
 * file's doc comment for the Node v4 same-route-registration pitfall this
 * avoids), extended here to dispatch on a route PARAM rather than the HTTP
 * method, since every action below shares POST.
 */
export async function rolloutPlanActionHandler(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const action = request.params.action;
  const auditActionName = action ? ACTION_AUDIT_NAMES[action] : undefined;
  if (!auditActionName) {
    return badRequest('unknown_rollout_action', `Unknown rollout action "${action}".`);
  }

  const loadResult = await loadAction(request, context, auditActionName);
  if (!loadResult.ok) {
    return loadResult.response;
  }
  const loaded = loadResult.value;

  try {
    switch (action) {
      case 'start':
        return await handleStart(request, context, loaded);
      case 'force-proceed':
        return await handleForceProceed(request, loaded);
      case 'verify-config':
        return await handleVerifyConfig(request, context, loaded);
      case 'confirm-cutover':
        return await handleConfirmCutover(request, loaded);
      case 'start-removal':
        return await handleStartRemoval(request, loaded);
      case 'remove-hosts':
        return await handleRemoveHosts(request, context, loaded);
      case 'rollback':
        return await handleRollback(request, context, loaded);
      case 'cancel':
        return await handleCancel(request, context, loaded);
      default:
        return badRequest('unknown_rollout_action', `Unknown rollout action "${action}".`);
    }
  } catch (error) {
    context.error(`rollout plan action failed | action=${action} planId=${loaded.planId} correlationId=${loaded.correlationId}`, error);
    await writeAuditEntry(
      { actor: loaded.principal.userDetails, actorId: loaded.principal.userId, action: auditActionName, target: `${loaded.hostPoolName}/${loaded.planId}`, outcome: 'failure', detail: error instanceof Error ? error.message : String(error), correlationId: loaded.correlationId },
      loaded.logger,
    );
    const apiError: ApiError = { status: 502, code: 'rollout_action_failed', message: `The action could not be completed. Reference: ${loaded.correlationId}`, details: { correlationId: loaded.correlationId } };
    return { status: 502, jsonBody: apiError };
  }
}

app.http('rolloutPlanAction', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'v1/hostpools/{hostPoolName}/rollout-plans/{planId}/{action}',
  handler: rolloutPlanActionHandler,
});
