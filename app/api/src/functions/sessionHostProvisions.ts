import { randomUUID } from 'node:crypto';
import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import type {
  ApiError,
  CancelSessionHostProvisionRequest,
  CancelSessionHostProvisionResponse,
  SessionHostProvisionListResponse,
  SessionHostProvisionParams,
  SessionHostProvisionStepState,
  StartSessionHostProvisionRequest,
  StartSessionHostProvisionResponse,
} from '@avdmgr/shared';
import { requireMinimumRole } from '../lib/auth';
import { isAuditRequiredButMissing, writeAuditEntry, type AuditLogger } from '../lib/auditLog';
import { getConfig } from '../lib/config';
import { badRequest } from '../lib/httpErrors';
import { validateManagedHostPool } from '../lib/hostPoolScope';
import { generateBuildAdminPassword } from '../lib/imageBuildSecrets';
import { deriveProvisionResourceNames, describeCleanupGuidance, generateSessionHostProvisionPlan, SESSION_HOST_COMPUTER_NAME_MAX_LENGTH, DEFAULT_SESSION_HOST_VM_SIZE, type SessionHostProvisionPlanContext } from '../lib/sessionHostProvisionPlan';
import { assertTransition, isTerminalState, IllegalSessionHostProvisionTransitionError } from '../lib/sessionHostProvisionStateMachine';
import { SESSION_HOST_NAME_PATTERN } from '../lib/validation';
import { getHostPool, getVmTemplateInfo } from '../services/avdService';
import { getCurrentImageVersion } from '../services/imagesService';
import { isTerminalState as isRolloutTerminalState, listRolloutPlanEntities } from '../services/rolloutPlanService';
import { assertImageVersionExists, assertSessionHostNameAvailable, PartialProvisionVmSubmissionError, submitNicCreation, submitVmCreation } from '../services/sessionHostProvisionOrchestrator';
import {
  createSessionHostProvision,
  getSessionHostProvision,
  isPreconditionFailedError,
  isProvisionStoreRequiredButMissing,
  listInFlightSessionHostProvisionsForName,
  listSessionHostProvisions,
  replaceSessionHostProvision,
  toDetail,
  toSummary,
  type SessionHostProvisionEntity,
  type SessionHostProvisionRecord,
} from '../services/sessionHostProvisionService';

/**
 * AM-50 — guided session-host provisioning endpoints: create the
 * session-host VM and apply its three extensions from the app itself,
 * closing the "VM provisioning itself runs outside the app" gap
 * AddSessionHostPanel.tsx has documented since AM-22.
 *
 * Every route here is admin-only (requireMinimumRole('admin')) — same bar
 * as app/api/src/functions/imageBuilds.ts: this creates a real, billable
 * Azure VM and joins it to the production host pool, a materially bigger
 * blast radius than the registration-token generator alone.
 *
 * Mirrors imageBuilds.ts's handler shape exactly: auth admin -> validate ->
 * fail-closed audit+store gates -> one-in-flight (here: PER SESSION HOST
 * NAME, not global — see sessionHostProvisionService.ts#listInFlightSessionHostProvisionsForName's
 * doc comment for why) 409 -> persist 'planned' BEFORE ARM -> submit ->
 * advance -> audit -> 201.
 *
 * DRY-RUN (POST ?dryRun=true): returns generateSessionHostProvisionPlan's
 * output UNCHANGED, with ZERO reads or writes to the SessionHostProvision
 * table and ZERO ARM mutation calls (the version/vmSize DEFAULTS below still
 * read live config/ARM/rollout state even for a dry run, same as
 * imageBuilds.ts's own dry-run path resolving planContext before returning —
 * that's a read, not a mutation).
 */

const AUDIT_ACTION_CREATE = 'sessionhost.provision.create';
const AUDIT_ACTION_CANCEL = 'sessionhost.provision.cancel';

/** Bounds each handler's own read-decide-write ETag retry loop — same magnitude as imageBuilds.ts's MAX_WRITE_ATTEMPTS. */
const MAX_WRITE_ATTEMPTS = 4;

const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
const VALID_ZONES = new Set(['1', '2', '3']);

function makeLogger(context: InvocationContext): AuditLogger {
  return { warn: (m) => context.warn(m), error: (m) => context.error(m), log: (m) => context.log(m) };
}

function notFound(provisionId: string, correlationId: string): HttpResponseInit {
  const apiError: ApiError = { status: 404, code: 'session_host_provision_not_found', message: `No provision found with id "${provisionId}". Reference: ${correlationId}`, details: { correlationId } };
  return { status: 404, jsonBody: apiError };
}

function conflict(code: string, message: string, correlationId: string, details?: unknown): HttpResponseInit {
  const apiError: ApiError = { status: 409, code, message: `${message} Reference: ${correlationId}`, details: { correlationId, ...(typeof details === 'object' && details !== null ? details : {}) } };
  return { status: 409, jsonBody: apiError };
}

/** Greppable marker for an unexpected state-machine/ARM condition — mirrors imageBuilds.ts#logStuck. */
function logStuck(context: InvocationContext, provisionId: string, detail: string, correlationId: string): void {
  context.error(`SESSION_HOST_PROVISION_STUCK | provisionId=${provisionId} correlationId=${correlationId} detail=${detail}`);
}

function validateStartRequest(body: Partial<StartSessionHostProvisionRequest>): { ok: true; value: { sessionHostName: string; zone: '1' | '2' | '3'; vmSize?: string; imageVersion?: string } } | { ok: false; response: HttpResponseInit } {
  if (typeof body.sessionHostName !== 'string' || !SESSION_HOST_NAME_PATTERN.test(body.sessionHostName)) {
    return { ok: false, response: badRequest('invalid_session_host_name', 'sessionHostName is required and must contain only letters, digits, dots, hyphens, or underscores.') };
  }
  const sessionHostName = body.sessionHostName.trim();
  if (sessionHostName.length === 0 || sessionHostName.length > SESSION_HOST_COMPUTER_NAME_MAX_LENGTH) {
    return { ok: false, response: badRequest('invalid_session_host_name', `sessionHostName must be 1-${SESSION_HOST_COMPUTER_NAME_MAX_LENGTH} characters — it becomes the VM's computer name verbatim, which Windows truncates beyond ${SESSION_HOST_COMPUTER_NAME_MAX_LENGTH}.`) };
  }
  if (typeof body.zone !== 'string' || !VALID_ZONES.has(body.zone)) {
    return { ok: false, response: badRequest('invalid_zone', 'zone is required and must be "1", "2", or "3".') };
  }
  if (body.vmSize !== undefined && (typeof body.vmSize !== 'string' || body.vmSize.trim().length === 0)) {
    return { ok: false, response: badRequest('invalid_vm_size', 'vmSize, if provided, must be a non-empty string.') };
  }
  if (body.imageVersion !== undefined && (typeof body.imageVersion !== 'string' || !VERSION_PATTERN.test(body.imageVersion))) {
    return { ok: false, response: badRequest('invalid_image_version', 'imageVersion, if provided, must be in major.minor.patch form, e.g. "2.2.0".') };
  }
  return { ok: true, value: { sessionHostName, zone: body.zone as '1' | '2' | '3', vmSize: body.vmSize?.trim(), imageVersion: body.imageVersion } };
}

function initialSteps(): SessionHostProvisionStepState[] {
  const ids: Array<SessionHostProvisionStepState['stepId']> = ['create_nic', 'create_vm', 'ext_entra_join', 'ext_guest_attestation', 'ext_dsc', 'await_registration'];
  return ids.map((stepId) => ({ stepId, status: 'pending' as const }));
}

/** Merges newly-submitted step updates on top of the persisted steps array (by stepId), preserving every step not touched by this call — mirrors imageBuilds.ts#mergeSteps. */
function mergeSteps(existing: SessionHostProvisionStepState[], updates: SessionHostProvisionStepState[]): SessionHostProvisionStepState[] {
  const byId = new Map(existing.map((s) => [s.stepId, s]));
  for (const update of updates) {
    byId.set(update.stepId, update);
  }
  return [...byId.values()];
}

/**
 * Resolves the target gallery image version: an explicit `imageVersion`
 * from the request body wins; otherwise defaults to the host pool's active
 * (non-terminal) rollout plan's targetImageVersion, if one exists, else the
 * currently-published gallery version (see this story's own "version
 * default" acceptance criterion). Either way, the resolved version is then
 * verified to actually exist via assertImageVersionExists.
 */
async function resolveImageVersion(hostPoolName: string, explicit: string | undefined): Promise<{ ok: true; version: string } | { ok: false; response: HttpResponseInit }> {
  if (explicit) {
    return { ok: true, version: explicit };
  }

  const rolloutPlans = await listRolloutPlanEntities(hostPoolName).catch(() => undefined);
  const activePlan = rolloutPlans?.find((plan) => !isRolloutTerminalState(plan.state));
  if (activePlan?.targetImageVersion) {
    return { ok: true, version: activePlan.targetImageVersion };
  }

  const current = await getCurrentImageVersion().catch(() => undefined);
  if (current?.name) {
    return { ok: true, version: current.name };
  }

  const apiError: ApiError = { status: 502, code: 'session_host_provision_no_version_available', message: 'Could not determine a target image version — no active rollout and no currently-published gallery version.' };
  return { ok: false, response: { status: 502, jsonBody: apiError } };
}

/**
 * POST v1/hostpools/{hostPoolName}/sessionhosts/provisions — starts a
 * provision, or (dryRun=true) returns its plan with zero mutations.
 * GET v1/hostpools/{hostPoolName}/sessionhosts/provisions — lists
 * provisions for this host pool. Shares one route (dispatched below) per
 * the same-route-multi-method workaround hostPoolRegistrationToken.ts
 * documents (Azure/azure-functions-nodejs-library#98).
 */
export async function sessionHostProvisionsStart(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const correlationId = randomUUID();
  const authResult = requireMinimumRole(request, 'admin', context);
  if (!authResult.ok) return authResult.response;
  const { principal } = authResult;

  const hostPoolName = request.params.hostPoolName;
  if (!hostPoolName) return badRequest('missing_host_pool_name', 'hostPoolName route parameter is required.');
  const scopeError = validateManagedHostPool(hostPoolName, getConfig().hostPoolName);
  if (scopeError) return scopeError;

  let body: Partial<StartSessionHostProvisionRequest>;
  try {
    body = ((await request.json()) ?? {}) as Partial<StartSessionHostProvisionRequest>;
  } catch {
    return badRequest('invalid_request_body', 'Request body must be valid JSON.');
  }
  const validated = validateStartRequest(body);
  if (!validated.ok) return validated.response;
  const input = validated.value;

  const dryRun = request.query.get('dryRun') === 'true';

  const { subscriptionId, resourceGroups, galleryName, imageDefinitionName } = getConfig();

  const hostPool = await getHostPool(hostPoolName).catch((error) => {
    context.error(`session host provision host pool lookup failed | correlationId=${correlationId}`, error);
    return undefined;
  });
  if (hostPool === undefined) {
    const apiError: ApiError = { status: 502, code: 'session_host_provision_hostpool_lookup_failed', message: `Failed to read the host pool. Reference: ${correlationId}`, details: { correlationId } };
    return { status: 502, jsonBody: apiError };
  }
  if (!hostPool) {
    const apiError: ApiError = { status: 404, code: 'host_pool_not_found', message: `Host pool "${hostPoolName}" was not found.` };
    return { status: 404, jsonBody: apiError };
  }

  const versionResult = await resolveImageVersion(hostPoolName, input.imageVersion);
  if (!versionResult.ok) return versionResult.response;

  const versionCheck = await assertImageVersionExists(versionResult.version, resourceGroups.images, galleryName, imageDefinitionName).catch((error) => {
    context.error(`session host provision image version check failed | correlationId=${correlationId}`, error);
    return undefined;
  });
  if (versionCheck === undefined) {
    const apiError: ApiError = { status: 502, code: 'session_host_provision_version_check_failed', message: `Failed to verify the target image version. Reference: ${correlationId}`, details: { correlationId } };
    return { status: 502, jsonBody: apiError };
  }
  if (!versionCheck.ok) {
    return conflict('session_host_provision_version_not_found', versionCheck.reason, correlationId);
  }

  const vmTemplate = input.vmSize ? undefined : await getVmTemplateInfo(hostPoolName).catch(() => undefined);
  const vmSize = input.vmSize || vmTemplate?.vmSizeId || DEFAULT_SESSION_HOST_VM_SIZE;

  const planContext: SessionHostProvisionPlanContext = {
    subscriptionId,
    resourceGroup: resourceGroups.hostPools,
    location: getConfig().imageBuild.location,
    subnetId: getConfig().sessionHostProvision.subnetId,
    galleryImageVersionId: versionCheck.id,
    vmSize,
    zone: input.zone,
    adminUsername: getConfig().sessionHostProvision.adminUsername,
    hostPoolName,
    hostPoolResourceId: hostPool.id,
    dscModulesUrl: getConfig().sessionHostProvision.dscModulesUrl,
  };

  const params: SessionHostProvisionParams = { sessionHostName: input.sessionHostName, zone: input.zone, vmSize, imageVersion: versionResult.version };
  const plan = generateSessionHostProvisionPlan(params, planContext);

  if (dryRun) {
    // ZERO reads/writes below this point — this is the whole point of dryRun=true.
    const responseBody: StartSessionHostProvisionResponse = { plan, dryRun: true };
    return { status: 200, jsonBody: responseBody };
  }

  if (isAuditRequiredButMissing() || isProvisionStoreRequiredButMissing()) {
    context.error(`AUDIT_MISCONFIGURED | correlationId=${correlationId} action=${AUDIT_ACTION_CREATE} — required storage is unset in a deployed environment; refusing to mutate.`);
    const apiError: ApiError = { status: 500, code: 'audit_not_configured', message: `This environment cannot record an audit trail / durable provision state for this action, so it was not performed. Reference: ${correlationId}`, details: { correlationId } };
    return { status: 500, jsonBody: apiError };
  }

  // One-in-flight PER SESSION HOST NAME — see sessionHostProvisionService.ts's
  // listInFlightSessionHostProvisionsForName doc comment for why this is
  // scoped to the name, not global (unlike the single-build-at-a-time image
  // build).
  const inFlight = await listInFlightSessionHostProvisionsForName(hostPoolName, input.sessionHostName).catch((error) => {
    context.error(`session host provision in-flight check failed | correlationId=${correlationId}`, error);
    return undefined;
  });
  if (inFlight === undefined) {
    const apiError: ApiError = { status: 502, code: 'session_host_provision_list_failed', message: `Failed to check for an in-flight provision. Reference: ${correlationId}`, details: { correlationId } };
    return { status: 502, jsonBody: apiError };
  }
  if (inFlight.length > 0) {
    return conflict('session_host_provision_already_in_flight', `A provision for session host "${input.sessionHostName}" (id ${inFlight[0].provisionId}, state ${inFlight[0].state}) is already in flight.`, correlationId, { provisionId: inFlight[0].provisionId });
  }

  const nameCheck = await assertSessionHostNameAvailable(deriveProvisionResourceNames(input.sessionHostName).vmName, resourceGroups.hostPools).catch((error) => {
    context.error(`session host provision name-availability check failed | correlationId=${correlationId}`, error);
    return undefined;
  });
  if (nameCheck === undefined) {
    const apiError: ApiError = { status: 502, code: 'session_host_provision_name_check_failed', message: `Failed to check whether "${input.sessionHostName}" is available. Reference: ${correlationId}`, details: { correlationId } };
    return { status: 502, jsonBody: apiError };
  }
  if (!nameCheck.ok) {
    return conflict('session_host_provision_name_exists', nameCheck.reason, correlationId);
  }

  const provisionId = randomUUID();
  const names = deriveProvisionResourceNames(input.sessionHostName);
  const nowIso = new Date().toISOString();
  const entity: Omit<SessionHostProvisionEntity, 'partitionKey' | 'rowKey'> = {
    provisionId,
    hostPoolName,
    sessionHostName: input.sessionHostName,
    zone: input.zone,
    vmSize,
    imageVersion: versionResult.version,
    state: 'planned',
    createdAt: nowIso,
    updatedAt: nowIso,
    createdBy: principal.userDetails,
    createdById: principal.userId,
    vmName: names.vmName,
    nicName: names.nicName,
    stepsJson: JSON.stringify(initialSteps()),
    planParamsJson: JSON.stringify(params),
    // FROZEN PLAN BASIS — persisted once, here, at provision-start time.
    // Every later plan regeneration reads THIS field — never a live config
    // resolution — see sessionHostProvisionOrchestrator.ts's
    // regeneratePlanFromFrozenBasis and sessionHostProvisionService.ts's
    // SessionHostProvisionEntity.planContextJson doc comment.
    planContextJson: JSON.stringify(planContext),
    correlationId,
  };

  try {
    await createSessionHostProvision(entity);
  } catch (error) {
    context.error(`session host provision create failed | correlationId=${correlationId}`, error);
    const apiError: ApiError = { status: 502, code: 'session_host_provision_create_failed', message: `Failed to persist the new provision. Nothing was created in Azure. Reference: ${correlationId}`, details: { correlationId } };
    return { status: 502, jsonBody: apiError };
  }

  // Server-generated password (mirrors imageBuilds.ts's own generation
  // call), used exactly once here, never persisted (planParamsJson above
  // already excludes it), never audited, returned exactly once in the
  // response body's generatedAdminPassword.
  const adminPassword = generateBuildAdminPassword();
  const logger = makeLogger(context);

  // Two persisted transitions within this one synchronous request —
  // planned -> nic_creating (right after the fast, pollUntilDone'd NIC
  // create), then nic_creating -> vm_creating (right after the VM create is
  // SUBMITTED, poller.submitted() only) — mirrors imageBuildOrchestrator.ts's
  // "NIC pollUntilDone, then VM submitted()" timing exactly, but makes
  // nic_creating an OBSERVABLE, auditable row state on every successful
  // provision (not just a rare reconciliation edge case) — see this
  // story's own "per-step progress visible" acceptance criterion.
  let lastPersistedState: 'planned' | 'nic_creating' = 'planned';
  try {
    const nicSteps = await submitNicCreation(plan);
    assertTransition('planned', 'nic_creating');
    let current = await getSessionHostProvision(provisionId);
    if (!current) throw new Error('session host provision row disappeared immediately after being created.');
    await replaceSessionHostProvision({ ...current, state: 'nic_creating', stepsJson: JSON.stringify(mergeSteps(initialSteps(), nicSteps)), updatedAt: new Date().toISOString() }, current.etag);
    lastPersistedState = 'nic_creating';

    const vmSteps = await submitVmCreation(plan, nicSteps, adminPassword);
    assertTransition('nic_creating', 'vm_creating');
    current = await getSessionHostProvision(provisionId);
    if (!current) throw new Error('session host provision row disappeared after entering nic_creating.');
    // Merge onto the FULL 6-step array the previous write just persisted
    // (current.stepsJson) — not the narrow `nicSteps`/`vmSteps` arrays
    // themselves, which only carry the one or two steps each call actually
    // touched (submitVmCreation's own output is nicSteps-plus-create_vm, but
    // still missing the four still-pending extension/registration steps).
    const priorSteps = JSON.parse(current.stepsJson || '[]') as SessionHostProvisionStepState[];
    await replaceSessionHostProvision({ ...current, state: 'vm_creating', stepsJson: JSON.stringify(mergeSteps(priorSteps, vmSteps)), updatedAt: new Date().toISOString() }, current.etag);
    await writeAuditEntry({ actor: principal.userDetails, actorId: principal.userId, action: AUDIT_ACTION_CREATE, target: provisionId, parameters: { provisionId, sessionHostName: input.sessionHostName, from: 'planned', to: 'vm_creating', zone: input.zone, vmSize, imageVersion: versionResult.version, vmName: names.vmName }, outcome: 'success', correlationId }, logger);
  } catch (error) {
    // A PartialProvisionVmSubmissionError means the NIC succeeded (the row
    // is already persisted at 'nic_creating') but VM submission failed —
    // just update that row's steps, no state change (self-transition — see
    // pollNicCreating's doc comment for how the timer resolves this from
    // here). A NIC-creation failure itself (pollUntilDone threw, before the
    // first persist above ever ran) leaves the row at 'planned' with
    // create_nic marked failed — reconcilePlanned resolves that case.
    const message = error instanceof Error ? error.message : String(error);
    const isPartialVm = error instanceof PartialProvisionVmSubmissionError;
    context.error(`session host provision submission failed | provisionId=${provisionId} correlationId=${correlationId}`, error);
    const current = await getSessionHostProvision(provisionId).catch(() => null);
    if (current) {
      const existingSteps = JSON.parse(current.stepsJson || '[]') as SessionHostProvisionStepState[];
      const partialSteps = isPartialVm ? mergeSteps(existingSteps, (error as PartialProvisionVmSubmissionError).steps) : withStepStatusFailed(existingSteps, 'create_nic', message);
      await replaceSessionHostProvision({ ...current, stepsJson: JSON.stringify(partialSteps), errorMessage: message, updatedAt: new Date().toISOString() }, current.etag).catch(() => undefined);
    }
    await writeAuditEntry({ actor: principal.userDetails, actorId: principal.userId, action: AUDIT_ACTION_CREATE, target: provisionId, parameters: { provisionId, sessionHostName: input.sessionHostName, from: 'planned', to: lastPersistedState }, outcome: 'failure', detail: message, correlationId }, logger);
    const apiError: ApiError = {
      status: 502,
      code: 'session_host_provision_start_failed',
      message: `The provision record was created but submitting it to Azure encountered an error (${message}). This will be automatically reconciled (resumed if possible, or marked failed after a few minutes if not) — check GET .../provisions/${provisionId} for its current status. Reference: ${correlationId}`,
      details: { correlationId, provisionId },
    };
    return { status: 502, jsonBody: apiError };
  }

  const final = await getSessionHostProvision(provisionId);
  const responseBody: StartSessionHostProvisionResponse = {
    provision: final ? toDetail(final) : toDetail({ ...entity, partitionKey: '', rowKey: provisionId, state: 'vm_creating' }),
    plan,
    dryRun: false,
    generatedAdminPassword: adminPassword,
  };
  // Fable review fix: this 201 carries the shown-once generatedAdminPassword —
  // same no-store posture as hostPoolRegistrationToken.ts's token-bearing 200,
  // so no intermediary or browser cache can ever retain the secret.
  return { status: 201, jsonBody: responseBody, headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } };
}

/** Small local helper so the catch block above stays a one-liner regardless of which failure branch it's in. */
function withStepStatusFailed(steps: SessionHostProvisionStepState[], stepId: SessionHostProvisionStepState['stepId'], error: string): SessionHostProvisionStepState[] {
  const now = new Date().toISOString();
  return steps.map((step) => (step.stepId === stepId ? { ...step, status: 'failed', error, startedAt: step.startedAt ?? now, completedAt: now } : step));
}

/** GET v1/hostpools/{hostPoolName}/sessionhosts/provisions — list, newest-first. */
export async function sessionHostProvisionsList(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const authResult = requireMinimumRole(request, 'admin', context);
  if (!authResult.ok) return authResult.response;

  const hostPoolName = request.params.hostPoolName;
  if (!hostPoolName) return badRequest('missing_host_pool_name', 'hostPoolName route parameter is required.');
  const scopeError = validateManagedHostPool(hostPoolName, getConfig().hostPoolName);
  if (scopeError) return scopeError;

  try {
    const provisions = await listSessionHostProvisions(hostPoolName);
    const responseBody: SessionHostProvisionListResponse = { provisions: provisions.map(toSummary) };
    return { status: 200, jsonBody: responseBody };
  } catch (error) {
    const correlationId = randomUUID();
    context.error(`session host provision list failed | correlationId=${correlationId}`, error);
    const apiError: ApiError = { status: 502, code: 'session_host_provision_list_failed', message: `Failed to list provisions. Reference: ${correlationId}`, details: { correlationId } };
    return { status: 502, jsonBody: apiError };
  }
}

export async function sessionHostProvisionsCollectionDispatch(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  switch (request.method) {
    case 'GET':
      return sessionHostProvisionsList(request, context);
    case 'POST':
      return sessionHostProvisionsStart(request, context);
    default: {
      const apiError: ApiError = { status: 405, code: 'method_not_allowed', message: `Method ${request.method} is not allowed on this route.` };
      return { status: 405, jsonBody: apiError };
    }
  }
}

app.http('sessionHostProvisionsCollection', {
  methods: ['GET', 'POST'],
  authLevel: 'anonymous',
  route: 'v1/hostpools/{hostPoolName}/sessionhosts/provisions',
  handler: sessionHostProvisionsCollectionDispatch,
});

/** GET .../provisions/{provisionId} — full detail. */
export async function sessionHostProvisionsGet(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const correlationId = randomUUID();
  const authResult = requireMinimumRole(request, 'admin', context);
  if (!authResult.ok) return authResult.response;

  const hostPoolName = request.params.hostPoolName;
  if (!hostPoolName) return badRequest('missing_host_pool_name', 'hostPoolName route parameter is required.');
  const scopeError = validateManagedHostPool(hostPoolName, getConfig().hostPoolName);
  if (scopeError) return scopeError;

  const provisionId = request.params.provisionId;
  if (!provisionId) return badRequest('missing_provision_id', 'provisionId route parameter is required.');

  try {
    const provision = await getSessionHostProvision(provisionId);
    if (!provision || provision.hostPoolName !== hostPoolName) return notFound(provisionId, correlationId);
    return { status: 200, jsonBody: toDetail(provision) };
  } catch (error) {
    context.error(`session host provision get failed | provisionId=${provisionId} correlationId=${correlationId}`, error);
    const apiError: ApiError = { status: 502, code: 'session_host_provision_get_failed', message: `Failed to read the provision. Reference: ${correlationId}`, details: { correlationId } };
    return { status: 502, jsonBody: apiError };
  }
}

app.http('sessionHostProvisionsDetail', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'v1/hostpools/{hostPoolName}/sessionhosts/provisions/{provisionId}',
  handler: sessionHostProvisionsGet,
});

/**
 * POST .../provisions/{provisionId}/cancel. Deliberately does NOT fire any
 * ARM deletes itself — mirrors imageBuilds.ts's cancel handler exactly: a
 * cancel is a fast, always-safe "stop the state machine" action, reporting
 * HONESTLY what (if anything) still exists in Azure via
 * describeCleanupGuidance (sessionHostProvisionPlan.ts).
 */
export async function sessionHostProvisionsCancel(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const correlationId = randomUUID();
  const authResult = requireMinimumRole(request, 'admin', context);
  if (!authResult.ok) return authResult.response;
  const { principal } = authResult;

  const hostPoolName = request.params.hostPoolName;
  if (!hostPoolName) return badRequest('missing_host_pool_name', 'hostPoolName route parameter is required.');
  const scopeError = validateManagedHostPool(hostPoolName, getConfig().hostPoolName);
  if (scopeError) return scopeError;

  const provisionId = request.params.provisionId;
  if (!provisionId) return badRequest('missing_provision_id', 'provisionId route parameter is required.');

  let reason: string | undefined;
  try {
    const parsed = ((await request.json()) ?? {}) as CancelSessionHostProvisionRequest;
    if (typeof parsed.reason === 'string') reason = parsed.reason;
  } catch {
    reason = undefined;
  }

  const logger = makeLogger(context);
  let record: SessionHostProvisionRecord | null;
  for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt++) {
    record = await getSessionHostProvision(provisionId);
    if (!record || record.hostPoolName !== hostPoolName) return notFound(provisionId, correlationId);
    if (isTerminalState(record.state)) {
      return conflict('session_host_provision_already_terminal', `This provision is already ${record.state} and cannot be cancelled.`, correlationId);
    }
    try {
      assertTransition(record.state, 'cancelled');
      const guidance = describeCleanupGuidance(record.state, { vmName: record.vmName, nicName: record.nicName }, getConfig().resourceGroups.hostPools);
      await replaceSessionHostProvision({ ...record, state: 'cancelled', cancelReason: reason, cleanupGuidance: guidance, updatedAt: new Date().toISOString() }, record.etag);
      await writeAuditEntry({ actor: principal.userDetails, actorId: principal.userId, action: AUDIT_ACTION_CANCEL, target: provisionId, parameters: { provisionId, sessionHostName: record.sessionHostName, from: record.state, to: 'cancelled' }, reason, outcome: 'success', correlationId }, logger);
      const final = await getSessionHostProvision(provisionId);
      const responseBody: CancelSessionHostProvisionResponse = { provision: toDetail(final ?? { ...record, state: 'cancelled', cancelReason: reason, cleanupGuidance: guidance }), cleanupGuidance: guidance };
      return { status: 200, jsonBody: responseBody };
    } catch (error) {
      if (isPreconditionFailedError(error) && attempt < MAX_WRITE_ATTEMPTS - 1) {
        continue;
      }
      if (error instanceof IllegalSessionHostProvisionTransitionError) {
        logStuck(context, provisionId, error.message, correlationId);
        return conflict('session_host_provision_illegal_transition', error.message, correlationId);
      }
      context.error(`session host provision cancel failed | provisionId=${provisionId} correlationId=${correlationId}`, error);
      await writeAuditEntry({ actor: principal.userDetails, actorId: principal.userId, action: AUDIT_ACTION_CANCEL, target: provisionId, parameters: { provisionId, from: record.state, to: 'cancelled' }, reason, outcome: 'failure', detail: error instanceof Error ? error.message : String(error), correlationId }, logger);
      const apiError: ApiError = { status: 502, code: 'session_host_provision_cancel_failed', message: `Failed to cancel the provision. Reference: ${correlationId}`, details: { correlationId } };
      return { status: 502, jsonBody: apiError };
    }
  }
  const apiError: ApiError = { status: 409, code: 'session_host_provision_conflict', message: `Gave up after repeated concurrent updates. Reference: ${correlationId}`, details: { correlationId } };
  return { status: 409, jsonBody: apiError };
}

app.http('sessionHostProvisionsCancel', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'v1/hostpools/{hostPoolName}/sessionhosts/provisions/{provisionId}/cancel',
  handler: sessionHostProvisionsCancel,
});
