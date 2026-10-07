import { randomUUID } from 'node:crypto';
import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import type {
  AdvanceImageBuildResponse,
  ApiError,
  CancelImageBuildRequest,
  CancelImageBuildResponse,
  DeleteImageBuildSnapshotRequest,
  DeleteImageBuildSnapshotResponse,
  ImageBuildChecklistState,
  ImageBuildDetail,
  ImageBuildListResponse,
  ImageBuildParams,
  ImageBuildStepState,
  StartImageBuildRequest,
  StartImageBuildResponse,
  UpdateImageBuildChecklistRequest,
  UpdateImageBuildChecklistResponse,
} from '@avdmgr/shared';
import { requireMinimumRole } from '../lib/auth';
import { isAuditRequiredButMissing, writeAuditEntry, type AuditLogger } from '../lib/auditLog';
import { getConfig } from '../lib/config';
import { badRequest } from '../lib/httpErrors';
import { allRequiredChecklistItemsChecked, emptyChecklistState, isKnownChecklistItem, unchecklistedItemIds } from '../lib/imageBuildChecklist';
import { compareVersions, deriveBuildResourceNames, describeCleanupGuidance, generateImageBuildPlan, type ImageBuildPlanContext } from '../lib/imageBuildPlan';
import { generateBuildAdminPassword } from '../lib/imageBuildSecrets';
import { checkRolloutDoneForVersion } from '../lib/imageBuildSnapshotGate';
import { OPERATOR_GATED_STATES, assertTransition, isTerminalState, IllegalImageBuildTransitionError } from '../lib/imageBuildStateMachine';
import { validateMandatoryReason } from '../lib/validation';
import {
  assertSnapshotNameAvailable,
  assertVersionAvailable,
  getSnapshotStatus,
  PartialBuildVmCreationError,
  resolvePlanContext,
  submitBuildVmCreation,
  submitCleanupDeletes,
  submitPreSysprepSnapshot,
  submitSnapshotDelete,
} from '../services/imageBuildOrchestrator';
import { getCurrentImageVersion } from '../services/imagesService';
import {
  createImageBuild,
  getImageBuild,
  isImageBuildStoreRequiredButMissing,
  isPreconditionFailedError,
  listImageBuilds,
  listInFlightImageBuilds,
  replaceImageBuild,
  toDetail,
  toSummary,
  type ImageBuildEntity,
  type ImageBuildRecord,
} from '../services/imageBuildService';

/** Emits the greppable IMAGE_BUILD_STUCK marker (Opus review MAJOR 12) — used both here (an illegal-transition condition that should never happen after the timer's self-transition fix) and in imageBuildTimer.ts. AM-48 landed the Log Analytics alert rule that targets this marker — see infra/modules/alerting.bicep's imageBuildStuckAlert (wired from main.bicep; infra/modules/functionapp.bicep's ALERTING TODO comment records it as covered). */
function logStuck(context: InvocationContext, buildId: string, detail: string, correlationId: string): void {
  context.error(`IMAGE_BUILD_STUCK | buildId=${buildId} correlationId=${correlationId} detail=${detail}`);
}

/**
 * AM-27 (M4-S2) — golden image BUILD orchestration endpoints. Every route
 * here is admin-only (requireMinimumRole('admin')): a build creates
 * billable Azure resources, runs an IRREVERSIBLE Sysprep against a VM, and
 * publishes a new gallery image version that session hosts across the
 * whole estate will eventually be built from — a materially bigger blast
 * radius than the registration-token generator (AM-22, this app's previous
 * admin-only high bar), so this app reserves it for admins the same way.
 *
 * DRY-RUN (POST ?dryRun=true): returns generateImageBuildPlan's output
 * UNCHANGED, with ZERO reads or writes to the ImageBuild table and ZERO ARM
 * calls — see imageBuildsStart below. This is the acceptance criterion for
 * "dry-run is the plan" (see imageBuildPlan.test.ts).
 */

const AUDIT_ACTION_START = 'image.build.start';
const AUDIT_ACTION_CHECKLIST = 'image.build.checklist_update';
const AUDIT_ACTION_ADVANCE = 'image.build.advance';
const AUDIT_ACTION_CANCEL = 'image.build.cancel';
/** AM-53 — see auditActionFamilies.test.ts (the 'image.build.' prefix already covers this). */
const AUDIT_ACTION_SNAPSHOT_DELETE = 'image.build.snapshot_delete';

/** Bounds each handler's own read-decide-write ETag retry loop — same rationale/magnitude as scalingEmergencyOverride.ts's MAX_ACTIVATION_ATTEMPTS: contention here is low (an admin-only feature, at most a couple of operators), so a handful of attempts is generous without risking an unbounded retry storm. */
const MAX_WRITE_ATTEMPTS = 4;

function makeLogger(context: InvocationContext): AuditLogger {
  return { warn: (m) => context.warn(m), error: (m) => context.error(m), log: (m) => context.log(m) };
}

function notFound(buildId: string, correlationId: string): HttpResponseInit {
  const apiError: ApiError = { status: 404, code: 'image_build_not_found', message: `No build found with id "${buildId}". Reference: ${correlationId}`, details: { correlationId } };
  return { status: 404, jsonBody: apiError };
}

function conflict(code: string, message: string, correlationId: string, details?: unknown): HttpResponseInit {
  const apiError: ApiError = { status: 409, code, message: `${message} Reference: ${correlationId}`, details: { correlationId, ...(typeof details === 'object' && details !== null ? details : {}) } };
  return { status: 409, jsonBody: apiError };
}

const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
/** Windows-disallowed local admin usernames this app explicitly rejects up front (a small, non-exhaustive subset of @azure/arm-compute's OSProfile.adminUsername doc comment's full disallowed list — this is a helpful early 400, not a substitute for ARM's own authoritative validation). */
const DISALLOWED_USERNAMES = new Set(['administrator', 'admin', 'user', 'guest', 'root']);

function validateStartRequest(body: Partial<StartImageBuildRequest>): { ok: true; value: ImageBuildParams } | { ok: false; response: HttpResponseInit } {
  if (typeof body.version !== 'string' || !VERSION_PATTERN.test(body.version)) {
    return { ok: false, response: badRequest('invalid_version', 'version is required and must be in major.minor.patch form, e.g. "2.1.0".') };
  }
  if (typeof body.adminUsername !== 'string' || body.adminUsername.trim().length === 0 || body.adminUsername.length > 20) {
    return { ok: false, response: badRequest('invalid_admin_username', 'adminUsername is required and must be 1-20 characters.') };
  }
  if (DISALLOWED_USERNAMES.has(body.adminUsername.trim().toLowerCase())) {
    return { ok: false, response: badRequest('invalid_admin_username', 'adminUsername must not be a reserved Windows account name (e.g. "administrator", "admin").') };
  }
  if (body.vmSize !== undefined && (typeof body.vmSize !== 'string' || body.vmSize.trim().length === 0)) {
    return { ok: false, response: badRequest('invalid_vm_size', 'vmSize, if provided, must be a non-empty string.') };
  }
  // NOTE: no adminPassword field is accepted at all — see @avdmgr/shared's
  // ImageBuildParams doc comment (Opus review MAJOR 5): this app generates
  // the build VM's local admin password itself.
  return { ok: true, value: { version: body.version, adminUsername: body.adminUsername.trim(), vmSize: body.vmSize?.trim() } };
}

function initialSteps(): ImageBuildStepState[] {
  const ids: Array<ImageBuildStepState['stepId']> = [
    'create_build_nic',
    'create_build_vm',
    'operator_checklist_gate',
    'create_presysprep_snapshot',
    'run_sysprep',
    'await_stopped',
    'ensure_deallocated',
    'generalize_vm',
    'capture_image_version',
    'operator_test_host_step',
    'delete_build_vm',
    'delete_build_nic',
    'delete_build_disk',
  ];
  return ids.map((stepId) => ({ stepId, status: 'pending' as const }));
}

/**
 * POST /v1/images/builds — starts a build, or (dryRun=true) returns its
 * plan with zero mutations. GET /v1/images/builds — lists builds. Shares
 * one route (dispatched below) per the same-route-multi-method workaround
 * hostPoolRegistrationToken.ts documents.
 */
export async function imageBuildsStart(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const correlationId = randomUUID();
  const authResult = requireMinimumRole(request, 'admin', context);
  if (!authResult.ok) return authResult.response;
  const { principal } = authResult;

  let body: Partial<StartImageBuildRequest>;
  try {
    body = ((await request.json()) ?? {}) as Partial<StartImageBuildRequest>;
  } catch {
    return badRequest('invalid_request_body', 'Request body must be valid JSON.');
  }
  const validated = validateStartRequest(body);
  if (!validated.ok) return validated.response;
  const params = validated.value;

  const dryRun = request.query.get('dryRun') === 'true';

  let planContext: ImageBuildPlanContext;
  try {
    planContext = resolvePlanContext();
  } catch (error) {
    // AM-15 (M7) sweep: no longer echoes error.message directly into the
    // response — resolvePlanContext() (imageBuildOrchestrator.ts) today
    // only ever throws its own controlled "IMAGE_BUILD_SUBNET_ID is not
    // configured" message (not upstream ARM/Graph text), but classifying
    // server-side rather than trusting/forwarding whatever the caught error
    // says is the same defense-in-depth this app applies to every other
    // caught error before it reaches a response body — a future change to
    // resolvePlanContext() that starts throwing a different (less
    // controlled) error must not silently start leaking it here.
    context.error(`image build plan context resolution failed | correlationId=${correlationId}`, error);
    const isNotConfigured = error instanceof Error && error.message.includes('IMAGE_BUILD_SUBNET_ID');
    const apiError: ApiError = {
      status: 500,
      code: 'image_build_not_configured',
      message: isNotConfigured
        ? `This environment is not configured for image builds (missing IMAGE_BUILD_SUBNET_ID — see docs/app-registration.md DEPLOY-PREREQS §0.5). Reference: ${correlationId}`
        : `Could not resolve this environment's image build configuration. Reference: ${correlationId}`,
      details: { correlationId },
    };
    return { status: 500, jsonBody: apiError };
  }

  const buildId = randomUUID();
  const now = new Date();
  const plan = generateImageBuildPlan(params, buildId, planContext, now);

  if (dryRun) {
    // ZERO reads/writes below this point — this is the whole point of dryRun=true.
    const responseBody: StartImageBuildResponse = { plan, dryRun: true };
    return { status: 200, jsonBody: responseBody };
  }

  if (isAuditRequiredButMissing() || isImageBuildStoreRequiredButMissing()) {
    context.error(`AUDIT_MISCONFIGURED | correlationId=${correlationId} action=${AUDIT_ACTION_START} — required storage is unset in a deployed environment; refusing to mutate.`);
    const apiError: ApiError = { status: 500, code: 'audit_not_configured', message: `This environment cannot record an audit trail / durable build state for this action, so it was not performed. Reference: ${correlationId}`, details: { correlationId } };
    return { status: 500, jsonBody: apiError };
  }

  // Opus review MAJOR 11 — CONCURRENCY: only one build in flight at a time.
  // Two builds racing would both try to reuse this app's single build
  // resource-name derivation window, contend over the same RG-AVD-Images
  // build subnet/VM-size assumptions, and (worse) make "which build am I
  // looking at" genuinely ambiguous for an operator mid-checklist. Checked
  // AFTER the audit/store fail-closed check (so a misconfigured environment
  // still reports THAT specific problem first) but before anything is
  // created.
  const inFlight = await listInFlightImageBuilds().catch((error) => {
    context.error(`image build in-flight check failed | correlationId=${correlationId}`, error);
    return undefined;
  });
  if (inFlight === undefined) {
    const apiError: ApiError = { status: 502, code: 'image_build_list_failed', message: `Failed to check for an in-flight build. Reference: ${correlationId}`, details: { correlationId } };
    return { status: 502, jsonBody: apiError };
  }
  if (inFlight.length > 0) {
    return conflict('image_build_already_in_flight', `Build ${inFlight[0].buildId} (version ${inFlight[0].version}, state ${inFlight[0].state}) is already in flight — only one build may run at a time.`, correlationId, { buildId: inFlight[0].buildId });
  }

  // Opus review MAJOR 6 — VERSION FLOOR: the target version must be
  // strictly greater than the currently-published version, AND must not
  // already exist as a gallery image version at all (a stray/orphaned
  // version at a number below "current", e.g. excludeFromLatest=true,
  // would otherwise be silently overwritable).
  const currentVersion = await getCurrentImageVersion().catch((error) => {
    context.error(`current image version lookup failed | correlationId=${correlationId}`, error);
    return undefined;
  });
  if (currentVersion === undefined) {
    const apiError: ApiError = { status: 502, code: 'image_build_current_version_lookup_failed', message: `Failed to read the currently-published image version. Reference: ${correlationId}`, details: { correlationId } };
    return { status: 502, jsonBody: apiError };
  }
  if (currentVersion && compareVersions(params.version, currentVersion.name) <= 0) {
    return conflict('image_build_version_not_greater', `version ${params.version} must be strictly greater than the currently-published version ${currentVersion.name}.`, correlationId);
  }
  const versionCheck = await assertVersionAvailable(params.version, planContext).catch((error) => {
    context.error(`gallery image version existence check failed | correlationId=${correlationId}`, error);
    return undefined;
  });
  if (versionCheck === undefined) {
    const apiError: ApiError = { status: 502, code: 'image_build_version_check_failed', message: `Failed to check whether version ${params.version} already exists. Reference: ${correlationId}`, details: { correlationId } };
    return { status: 502, jsonBody: apiError };
  }
  if (!versionCheck.ok) {
    return conflict('image_build_version_exists', versionCheck.reason, correlationId);
  }

  const names = deriveBuildResourceNames(buildId, params.version);
  const nowIso = now.toISOString();
  const entity: Omit<ImageBuildEntity, 'partitionKey' | 'rowKey'> = {
    buildId,
    version: params.version,
    state: 'planned',
    createdAt: nowIso,
    updatedAt: nowIso,
    createdBy: principal.userDetails,
    createdById: principal.userId,
    vmName: names.vmName,
    nicName: names.nicName,
    diskName: names.diskName,
    snapshotName: names.snapshotName,
    checklistJson: JSON.stringify(emptyChecklistState()),
    stepsJson: JSON.stringify(initialSteps()),
    planParamsJson: JSON.stringify({ version: params.version, vmSize: params.vmSize, adminUsername: params.adminUsername }),
    // Opus review MAJOR 9 — FROZEN PLAN BASIS: persisted once, here, at
    // build-start time. Every later plan regeneration reads THIS field —
    // never a live resolvePlanContext() call — see imageBuildOrchestrator.ts's
    // header comment and imageBuildTimer.ts's computeAdvance.
    planContextJson: JSON.stringify(planContext),
    correlationId,
  };

  try {
    await createImageBuild(entity);
  } catch (error) {
    context.error(`image build create failed | correlationId=${correlationId}`, error);
    const apiError: ApiError = { status: 502, code: 'image_build_create_failed', message: `Failed to persist the new build. Nothing was created in Azure. Reference: ${correlationId}`, details: { correlationId } };
    return { status: 502, jsonBody: apiError };
  }

  // Opus review MAJOR 5 — server-generated password, never accepted from
  // the caller, used exactly once here, never persisted (planParamsJson
  // above already excludes it), never audited (see the audit call below —
  // parameters never includes it), returned exactly once in the response
  // body's generatedAdminPassword.
  const adminPassword = generateBuildAdminPassword();

  const logger = makeLogger(context);
  try {
    const steps = await submitBuildVmCreation(plan, adminPassword);
    assertTransition('planned', 'vm_creating');
    const current = await getImageBuild(buildId);
    if (!current) throw new Error('image build row disappeared immediately after being created.');
    await replaceImageBuild({ ...current, state: 'vm_creating', stepsJson: JSON.stringify(mergeSteps(initialSteps(), steps)), updatedAt: new Date().toISOString() }, current.etag);
    await writeAuditEntry({ actor: principal.userDetails, actorId: principal.userId, action: AUDIT_ACTION_START, target: buildId, parameters: { buildId, from: 'planned', to: 'vm_creating', version: params.version, vmSize: params.vmSize, vmName: names.vmName }, outcome: 'success', correlationId }, logger);
  } catch (error) {
    // Opus review MAJOR 4 — record which resources may already exist. A
    // PartialBuildVmCreationError means the NIC create SUCCEEDED before the
    // VM create submission failed — persist that partial progress (merged
    // onto the full initial step list, never losing the other 11 steps —
    // Opus review MAJOR 3) and leave the row at 'planned' rather than
    // force-marking it 'failed': imageBuildTimer.ts#reconcilePlanned will
    // check whether the VM actually got created despite this error (ARM
    // sometimes accepts a request that then fails to return cleanly) and
    // either resume the build or fail it honestly after a grace period —
    // this handler genuinely does not know which happened.
    const message = error instanceof Error ? error.message : String(error);
    const partialSteps = error instanceof PartialBuildVmCreationError ? mergeSteps(initialSteps(), error.steps) : initialSteps();
    context.error(`image build VM submission failed | buildId=${buildId} correlationId=${correlationId}`, error);
    const current = await getImageBuild(buildId).catch(() => null);
    if (current) {
      await replaceImageBuild({ ...current, stepsJson: JSON.stringify(partialSteps), errorMessage: message, updatedAt: new Date().toISOString() }, current.etag).catch(() => undefined);
    }
    await writeAuditEntry({ actor: principal.userDetails, actorId: principal.userId, action: AUDIT_ACTION_START, target: buildId, parameters: { buildId, from: 'planned', to: 'planned', version: params.version }, outcome: 'failure', detail: message, correlationId }, logger);
    const apiError: ApiError = {
      status: 502,
      code: 'image_build_start_failed',
      message: `The build record was created but submitting the VM creation to Azure encountered an error (${message}). This build will be automatically reconciled (resumed if the VM was actually created, or marked failed after a few minutes if it wasn't) — check GET /v1/images/builds/${buildId} for its current status. Reference: ${correlationId}`,
      details: { correlationId, buildId },
    };
    return { status: 502, jsonBody: apiError };
  }

  const final = await getImageBuild(buildId);
  const responseBody: StartImageBuildResponse = {
    build: final ? toDetail(final) : toDetail({ ...entity, partitionKey: '', rowKey: buildId, state: 'vm_creating' }),
    plan,
    dryRun: false,
    generatedAdminPassword: adminPassword,
  };
  return { status: 201, jsonBody: responseBody };
}

/** GET /v1/images/builds — list, newest-first. */
export async function imageBuildsList(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const authResult = requireMinimumRole(request, 'admin', context);
  if (!authResult.ok) return authResult.response;

  try {
    const builds = await listImageBuilds();
    const responseBody: ImageBuildListResponse = { builds: builds.map(toSummary) };
    return { status: 200, jsonBody: responseBody };
  } catch (error) {
    const correlationId = randomUUID();
    context.error(`image build list failed | correlationId=${correlationId}`, error);
    const apiError: ApiError = { status: 502, code: 'image_build_list_failed', message: `Failed to list builds. Reference: ${correlationId}`, details: { correlationId } };
    return { status: 502, jsonBody: apiError };
  }
}

export async function imageBuildsCollectionDispatch(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  switch (request.method) {
    case 'GET':
      return imageBuildsList(request, context);
    case 'POST':
      return imageBuildsStart(request, context);
    default: {
      const apiError: ApiError = { status: 405, code: 'method_not_allowed', message: `Method ${request.method} is not allowed on this route.` };
      return { status: 405, jsonBody: apiError };
    }
  }
}

app.http('imageBuildsCollection', {
  methods: ['GET', 'POST'],
  authLevel: 'anonymous',
  route: 'v1/images/builds',
  handler: imageBuildsCollectionDispatch,
});

/** GET /v1/images/builds/{buildId} — full detail. */
export async function imageBuildsGet(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const correlationId = randomUUID();
  const authResult = requireMinimumRole(request, 'admin', context);
  if (!authResult.ok) return authResult.response;

  const buildId = request.params.buildId;
  if (!buildId) return badRequest('missing_build_id', 'buildId route parameter is required.');

  try {
    const build = await getImageBuild(buildId);
    if (!build) return notFound(buildId, correlationId);
    let responseBody: ImageBuildDetail = toDetail(build);

    // AM-53 — live snapshot status + the server-computed delete gate, ONLY
    // once the build is `done` (the earliest state the DELETE .../snapshot
    // handler itself ever permits a delete from — see this route's own
    // gate order below). Before `done` there is nothing meaningful to
    // report: the pre-Sysprep snapshot may not have finished provisioning
    // yet, and a bare `snapshots.get` against a not-yet-created snapshot
    // would 404 in a way indistinguishable from "already deleted."
    if (build.state === 'done') {
      const snapshotStatus = await getSnapshotStatus(build.snapshotName);
      let snapshotDeletable = false;
      let snapshotDeleteBlockedReason: string | undefined;
      if (snapshotStatus === 'present') {
        try {
          const rollout = await checkRolloutDoneForVersion(build.version);
          snapshotDeletable = rollout.ok;
          snapshotDeleteBlockedReason = rollout.ok ? undefined : rollout.reason;
        } catch (error) {
          // Degrade THIS ONE FIELD, not the whole detail read — a rollout-
          // table hiccup must never take down the build detail page.
          context.error(`snapshot rollout-done gate check failed | buildId=${buildId} correlationId=${correlationId}`, error);
          snapshotDeleteBlockedReason = 'Whether this version has completed a rollout could not be verified right now — try again shortly.';
        }
      } else {
        snapshotDeleteBlockedReason =
          snapshotStatus === 'deleted' ? 'The pre-Sysprep snapshot has already been deleted.' : "The pre-Sysprep snapshot's current status could not be determined right now — try again shortly.";
      }
      responseBody = { ...responseBody, snapshotStatus, snapshotDeletable, snapshotDeleteBlockedReason };
    }

    return { status: 200, jsonBody: responseBody };
  } catch (error) {
    context.error(`image build get failed | buildId=${buildId} correlationId=${correlationId}`, error);
    const apiError: ApiError = { status: 502, code: 'image_build_get_failed', message: `Failed to read the build. Reference: ${correlationId}`, details: { correlationId } };
    return { status: 502, jsonBody: apiError };
  }
}

app.http('imageBuildsDetail', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'v1/images/builds/{buildId}',
  handler: imageBuildsGet,
});

/** PATCH /v1/images/builds/{buildId}/checklist — ticks/unticks exactly one item. Only valid while the build is at checklist_gate. */
export async function imageBuildsChecklist(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const correlationId = randomUUID();
  const authResult = requireMinimumRole(request, 'admin', context);
  if (!authResult.ok) return authResult.response;
  const { principal } = authResult;

  const buildId = request.params.buildId;
  if (!buildId) return badRequest('missing_build_id', 'buildId route parameter is required.');

  let body: Partial<UpdateImageBuildChecklistRequest>;
  try {
    body = ((await request.json()) ?? {}) as Partial<UpdateImageBuildChecklistRequest>;
  } catch {
    return badRequest('invalid_request_body', 'Request body must be valid JSON.');
  }
  if (typeof body.itemId !== 'string' || !isKnownChecklistItem(body.itemId)) {
    return badRequest('invalid_item_id', 'itemId is required and must be one of the fixed checklist items.');
  }
  if (typeof body.checked !== 'boolean') {
    return badRequest('invalid_checked', 'checked is required and must be a boolean.');
  }
  const { itemId, checked } = body as UpdateImageBuildChecklistRequest;

  const logger = makeLogger(context);
  let record: ImageBuildRecord | null;
  for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt++) {
    record = await getImageBuild(buildId);
    if (!record) return notFound(buildId, correlationId);
    if (record.state !== 'checklist_gate') {
      return conflict('image_build_not_at_checklist_gate', `The checklist can only be updated while the build is at the checklist gate (current state: ${record.state}).`, correlationId);
    }
    const checklist: ImageBuildChecklistState = JSON.parse(record.checklistJson || '{}');
    checklist[itemId] = checked;
    try {
      await replaceImageBuild({ ...record, checklistJson: JSON.stringify(checklist), updatedAt: new Date().toISOString() }, record.etag);
      await writeAuditEntry({ actor: principal.userDetails, actorId: principal.userId, action: AUDIT_ACTION_CHECKLIST, target: buildId, parameters: { itemId, checked }, outcome: 'success', correlationId }, logger);
      const responseBody: UpdateImageBuildChecklistResponse = { checklist, allRequiredChecked: allRequiredChecklistItemsChecked(checklist) };
      return { status: 200, jsonBody: responseBody };
    } catch (error) {
      if (isPreconditionFailedError(error) && attempt < MAX_WRITE_ATTEMPTS - 1) {
        continue;
      }
      context.error(`image build checklist update failed | buildId=${buildId} correlationId=${correlationId}`, error);
      const apiError: ApiError = { status: 502, code: 'image_build_checklist_update_failed', message: `Failed to persist the checklist update. Reference: ${correlationId}`, details: { correlationId } };
      return { status: 502, jsonBody: apiError };
    }
  }
  const apiError: ApiError = { status: 409, code: 'image_build_conflict', message: `Gave up after repeated concurrent updates. Reference: ${correlationId}`, details: { correlationId } };
  return { status: 409, jsonBody: apiError };
}

app.http('imageBuildsChecklist', {
  methods: ['PATCH'],
  authLevel: 'anonymous',
  route: 'v1/images/builds/{buildId}/checklist',
  handler: imageBuildsChecklist,
});

/**
 * POST /v1/images/builds/{buildId}/advance — the OPERATOR-gate action.
 * Valid only from checklist_gate (requires every checklist item ticked
 * first — submits the pre-Sysprep snapshot) or test_host_step (the
 * operator has validated a deployed test host — see
 * app/api/src/functions/hostPoolRegistrationToken.ts for the
 * registration-token flow this step reuses; submits the build resource
 * cleanup deletes).
 */
export async function imageBuildsAdvance(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const correlationId = randomUUID();
  const authResult = requireMinimumRole(request, 'admin', context);
  if (!authResult.ok) return authResult.response;
  const { principal } = authResult;

  const buildId = request.params.buildId;
  if (!buildId) return badRequest('missing_build_id', 'buildId route parameter is required.');

  let reason: string | undefined;
  try {
    const parsed = ((await request.json()) ?? {}) as { reason?: unknown };
    if (typeof parsed.reason === 'string') reason = parsed.reason;
  } catch {
    reason = undefined;
  }

  const logger = makeLogger(context);
  const record = await getImageBuild(buildId).catch((error) => {
    context.error(`image build read failed | buildId=${buildId} correlationId=${correlationId}`, error);
    return undefined;
  });
  if (record === undefined) {
    const apiError: ApiError = { status: 502, code: 'image_build_get_failed', message: `Failed to read the build. Reference: ${correlationId}`, details: { correlationId } };
    return { status: 502, jsonBody: apiError };
  }
  if (!record) return notFound(buildId, correlationId);

  if (!OPERATOR_GATED_STATES.has(record.state)) {
    return conflict('image_build_not_at_operator_gate', `This build is not at an operator gate (current state: ${record.state}).`, correlationId);
  }

  const fromState = record.state;
  const toState = fromState === 'checklist_gate' ? 'snapshotting' : 'cleanup';

  try {
    if (record.state === 'checklist_gate') {
      const checklist: ImageBuildChecklistState = JSON.parse(record.checklistJson || '{}');
      if (!allRequiredChecklistItemsChecked(checklist)) {
        return conflict('image_build_checklist_incomplete', 'Every checklist item must be ticked before advancing past the checklist gate.', correlationId, { missing: unchecklistedItemIds(checklist) });
      }
      // Opus review MAJOR 9 — FROZEN plan basis: regenerate from the row's
      // OWN persisted planContextJson/createdAt, never a live
      // resolvePlanContext()/new Date() call, so a config change mid-build
      // and "which minute this tick happens to run" can never alter this
      // build's own parameters (e.g. the gallery image version's
      // endOfLifeDate, computed from createdAt — see
      // imageBuildPlan.ts#computeEolDate).
      const planContext = JSON.parse(record.planContextJson) as ImageBuildPlanContext;
      const planParams = JSON.parse(record.planParamsJson) as { version: string; vmSize?: string; adminUsername: string };
      const plan = generateImageBuildPlan(planParams, buildId, planContext, new Date(record.createdAt));

      // Opus review MINOR 13d — snapshot-name pre-check.
      const snapshotCheck = await assertSnapshotNameAvailable(record.snapshotName, planContext);
      if (!snapshotCheck.ok) {
        return conflict('image_build_snapshot_exists', snapshotCheck.reason, correlationId);
      }

      const steps = await submitPreSysprepSnapshot(plan);
      assertTransition('checklist_gate', 'snapshotting');
      const merged = mergeSteps(JSON.parse(record.stepsJson || '[]'), steps);
      await replaceImageBuild({ ...record, state: 'snapshotting', stepsJson: JSON.stringify(merged), abandonedWarning: undefined, updatedAt: new Date().toISOString() }, record.etag);
    } else {
      // test_host_step -> cleanup. No plan regeneration needed at all —
      // submitCleanupDeletes reads the resource names straight off the
      // ENTITY's own frozen vmName/nicName/diskName fields (Opus review
      // MAJOR 8/9).
      const steps = await submitCleanupDeletes(record);
      assertTransition('test_host_step', 'cleanup');
      const merged = mergeSteps(JSON.parse(record.stepsJson || '[]'), steps);
      await replaceImageBuild({ ...record, state: 'cleanup', stepsJson: JSON.stringify(merged), updatedAt: new Date().toISOString() }, record.etag);
    }
  } catch (error) {
    if (error instanceof IllegalImageBuildTransitionError) {
      logStuck(context, buildId, error.message, correlationId);
      return conflict('image_build_illegal_transition', error.message, correlationId);
    }
    context.error(`image build advance failed | buildId=${buildId} correlationId=${correlationId}`, error);
    await writeAuditEntry({ actor: principal.userDetails, actorId: principal.userId, action: AUDIT_ACTION_ADVANCE, target: buildId, parameters: { buildId, from: fromState, to: toState }, reason, outcome: 'failure', detail: error instanceof Error ? error.message : String(error), correlationId }, logger);
    const apiError: ApiError = { status: 502, code: 'image_build_advance_failed', message: `Failed to advance the build. Reference: ${correlationId}`, details: { correlationId } };
    return { status: 502, jsonBody: apiError };
  }

  await writeAuditEntry({ actor: principal.userDetails, actorId: principal.userId, action: AUDIT_ACTION_ADVANCE, target: buildId, parameters: { buildId, from: fromState, to: toState }, reason, outcome: 'success', correlationId }, logger);
  const final = await getImageBuild(buildId);
  const responseBody: AdvanceImageBuildResponse = { build: toDetail(final ?? record) };
  return { status: 200, jsonBody: responseBody };
}

/** Merges newly-submitted step updates on top of the persisted steps array (by stepId), preserving every step not touched by this call. */
function mergeSteps(existing: ImageBuildStepState[], updates: ImageBuildStepState[]): ImageBuildStepState[] {
  const byId = new Map(existing.map((s) => [s.stepId, s]));
  for (const update of updates) {
    byId.set(update.stepId, update);
  }
  return [...byId.values()];
}

app.http('imageBuildsAdvance', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'v1/images/builds/{buildId}/advance',
  handler: imageBuildsAdvance,
});

/**
 * POST /v1/images/builds/{buildId}/cancel. Deliberately does NOT fire any
 * ARM deletes itself — see @avdmgr/shared's CancelImageBuildResponse.cleanupGuidance
 * doc comment for why: a cancel is meant to be a fast, always-safe "stop
 * the state machine" action, not a second cleanup code path with its own
 * failure modes to reason about. It reports HONESTLY what (if anything)
 * still exists in Azure via describeCleanupGuidance (imageBuildPlan.ts).
 * Rejected (409) once cleanup has started (see
 * imageBuildStateMachine.ts's TRANSITIONS — cleanup has no edge to
 * cancelled) or once the build is already terminal.
 */
export async function imageBuildsCancel(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const correlationId = randomUUID();
  const authResult = requireMinimumRole(request, 'admin', context);
  if (!authResult.ok) return authResult.response;
  const { principal } = authResult;

  const buildId = request.params.buildId;
  if (!buildId) return badRequest('missing_build_id', 'buildId route parameter is required.');

  let reason: string | undefined;
  try {
    const parsed = ((await request.json()) ?? {}) as CancelImageBuildRequest;
    if (typeof parsed.reason === 'string') reason = parsed.reason;
  } catch {
    reason = undefined;
  }

  const logger = makeLogger(context);
  let record: ImageBuildRecord | null;
  for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt++) {
    record = await getImageBuild(buildId);
    if (!record) return notFound(buildId, correlationId);
    if (isTerminalState(record.state)) {
      return conflict('image_build_already_terminal', `This build is already ${record.state} and cannot be cancelled.`, correlationId);
    }
    if (record.state === 'cleanup') {
      return conflict('image_build_cleanup_in_progress', 'Cleanup has already started and cannot be cancelled — wait for it to finish (state: done or failed).', correlationId);
    }
    try {
      assertTransition(record.state, 'cancelled');
      await replaceImageBuild({ ...record, state: 'cancelled', cancelReason: reason, updatedAt: new Date().toISOString() }, record.etag);
      const guidance = describeCleanupGuidance(record.state, { vmName: record.vmName, nicName: record.nicName, diskName: record.diskName, snapshotName: record.snapshotName }, getConfig().resourceGroups.images);
      await writeAuditEntry({ actor: principal.userDetails, actorId: principal.userId, action: AUDIT_ACTION_CANCEL, target: buildId, parameters: { buildId, from: record.state, to: 'cancelled' }, reason, outcome: 'success', correlationId }, logger);
      const final = await getImageBuild(buildId);
      const responseBody: CancelImageBuildResponse = { build: toDetail(final ?? record), cleanupGuidance: guidance };
      return { status: 200, jsonBody: responseBody };
    } catch (error) {
      if (isPreconditionFailedError(error) && attempt < MAX_WRITE_ATTEMPTS - 1) {
        continue;
      }
      if (error instanceof IllegalImageBuildTransitionError) {
        logStuck(context, buildId, error.message, correlationId);
        return conflict('image_build_illegal_transition', error.message, correlationId);
      }
      context.error(`image build cancel failed | buildId=${buildId} correlationId=${correlationId}`, error);
      await writeAuditEntry({ actor: principal.userDetails, actorId: principal.userId, action: AUDIT_ACTION_CANCEL, target: buildId, parameters: { buildId, from: record.state, to: 'cancelled' }, reason, outcome: 'failure', detail: error instanceof Error ? error.message : String(error), correlationId }, logger);
      const apiError: ApiError = { status: 502, code: 'image_build_cancel_failed', message: `Failed to cancel the build. Reference: ${correlationId}`, details: { correlationId } };
      return { status: 502, jsonBody: apiError };
    }
  }
  const apiError: ApiError = { status: 409, code: 'image_build_conflict', message: `Gave up after repeated concurrent updates. Reference: ${correlationId}`, details: { correlationId } };
  return { status: 409, jsonBody: apiError };
}

app.http('imageBuildsCancel', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'v1/images/builds/{buildId}/cancel',
  handler: imageBuildsCancel,
});

/**
 * AM-53 — DELETE /v1/images/builds/{buildId}/snapshot. Operator-confirmed
 * retirement of the pre-Sysprep snapshot, admin-only, mandatory reason.
 * DECIDED SCOPE (see @avdmgr/shared's DeleteImageBuildSnapshotRequest doc
 * comment and this story's CHANGELOG entry): this is the ONLY deletion path
 * — no autonomous keep-last-N timer.
 *
 * GATES, IN ORDER (each a distinct, honestly-worded 409 — never a generic
 * "conflict"):
 *   1. build exists AND build.state === 'done' — a snapshot for an
 *      unfinished build is never eligible; deleting it mid-build would
 *      remove the one rebuild-recovery artifact a still-running build might
 *      still need (the golden-image runbook §4.5).
 *   2. rollout-done: some rollout plan targeting this build's version has
 *      reached 'done' (app/api/src/lib/imageBuildSnapshotGate.ts) — refuses
 *      with an honest message that also covers the 25-row-cap case ("no
 *      completed rollout found ... in the most recent plans", never
 *      "never rolled out").
 *   3. the snapshot must still exist (a fresh `snapshots.get`) — a 404
 *      means someone/something already deleted it out-of-band.
 *
 * AUDIT-BEFORE-MUTATION (same posture as profileDeleteRetired.ts — a delete
 * is genuinely unrecoverable): writeAuditEntry is called ONCE with outcome
 * 'accepted' immediately before submitSnapshotDelete, and again with the
 * real outcome ('success'/'failure') after.
 */
export async function imageBuildsSnapshotDelete(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const correlationId = randomUUID();
  const authResult = requireMinimumRole(request, 'admin', context);
  if (!authResult.ok) return authResult.response;
  const { principal } = authResult;

  const buildId = request.params.buildId;
  if (!buildId) return badRequest('missing_build_id', 'buildId route parameter is required.');

  let body: Partial<DeleteImageBuildSnapshotRequest>;
  try {
    body = ((await request.json()) ?? {}) as Partial<DeleteImageBuildSnapshotRequest>;
  } catch {
    return badRequest('invalid_request_body', 'Request body must be valid JSON.');
  }
  const reasonResult = validateMandatoryReason(body.reason);
  if (!reasonResult.ok) return reasonResult.response;
  const reason = reasonResult.value;

  const logger = makeLogger(context);

  const record = await getImageBuild(buildId).catch((error) => {
    context.error(`image build read failed | buildId=${buildId} correlationId=${correlationId}`, error);
    return undefined;
  });
  if (record === undefined) {
    const apiError: ApiError = { status: 502, code: 'image_build_get_failed', message: `Failed to read the build. Reference: ${correlationId}`, details: { correlationId } };
    return { status: 502, jsonBody: apiError };
  }
  if (!record) return notFound(buildId, correlationId);

  // GATE 1 — build must be done. Never delete a snapshot for an unfinished build.
  if (record.state !== 'done') {
    return conflict('image_build_not_done', `The pre-Sysprep snapshot can only be deleted once this build has reached the done state (current state: ${record.state}).`, correlationId);
  }

  // GATE 2 — rollout-done for this build's version.
  let rollout: { ok: true } | { ok: false; reason: string };
  try {
    rollout = await checkRolloutDoneForVersion(record.version);
  } catch (error) {
    context.error(`snapshot rollout-done gate check failed | buildId=${buildId} correlationId=${correlationId}`, error);
    const apiError: ApiError = { status: 502, code: 'image_build_rollout_check_failed', message: `Failed to check whether version ${record.version} has completed a rollout. Reference: ${correlationId}`, details: { correlationId } };
    return { status: 502, jsonBody: apiError };
  }
  if (!rollout.ok) {
    return conflict('snapshot_rollout_not_complete', rollout.reason, correlationId);
  }

  // GATE 3 — the snapshot must still exist.
  const snapshotStatus = await getSnapshotStatus(record.snapshotName);
  if (snapshotStatus === 'deleted') {
    return conflict('snapshot_already_deleted', `Snapshot ${record.snapshotName} no longer exists — it may already have been deleted.`, correlationId);
  }
  if (snapshotStatus === 'unknown') {
    const apiError: ApiError = { status: 502, code: 'image_build_snapshot_check_failed', message: `Failed to check whether snapshot ${record.snapshotName} still exists. Reference: ${correlationId}`, details: { correlationId } };
    return { status: 502, jsonBody: apiError };
  }

  const parameters = { snapshotName: record.snapshotName, version: record.version, reason };

  // AUDIT BEFORE MUTATION — see this handler's doc comment.
  await writeAuditEntry({ actor: principal.userDetails, actorId: principal.userId, action: AUDIT_ACTION_SNAPSHOT_DELETE, target: buildId, parameters, reason, outcome: 'accepted', correlationId }, logger);

  try {
    await submitSnapshotDelete(record.snapshotName);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    context.error(`snapshot delete submission failed | buildId=${buildId} correlationId=${correlationId}`, error);
    await writeAuditEntry({ actor: principal.userDetails, actorId: principal.userId, action: AUDIT_ACTION_SNAPSHOT_DELETE, target: buildId, parameters, reason, outcome: 'failure', detail: message, correlationId }, logger);
    const apiError: ApiError = { status: 502, code: 'image_build_snapshot_delete_failed', message: `Failed to submit the snapshot delete. Reference: ${correlationId}`, details: { correlationId } };
    return { status: 502, jsonBody: apiError };
  }

  const submittedAt = new Date().toISOString();
  let final: typeof record = record;
  try {
    await replaceImageBuild({ ...record, snapshotDeleteSubmittedAt: submittedAt, updatedAt: submittedAt }, record.etag);
    final = (await getImageBuild(buildId)) ?? { ...record, snapshotDeleteSubmittedAt: submittedAt };
  } catch (error) {
    // The delete was already submitted to Azure — a persistence hiccup here
    // must never be reported to the operator as the delete itself having
    // failed (same "the mutation already happened, don't lie about it"
    // posture as rolloutPlanService.ts's persistWithMergeRetry doc comment).
    context.warn(`image build snapshotDeleteSubmittedAt persist failed (the delete itself was already submitted) | buildId=${buildId} correlationId=${correlationId} error=${String(error)}`);
  }

  await writeAuditEntry({ actor: principal.userDetails, actorId: principal.userId, action: AUDIT_ACTION_SNAPSHOT_DELETE, target: buildId, parameters, reason, outcome: 'success', correlationId }, logger);

  const responseBody: DeleteImageBuildSnapshotResponse = { build: toDetail(final) };
  return { status: 200, jsonBody: responseBody };
}

app.http('imageBuildsSnapshotDelete', {
  methods: ['DELETE'],
  authLevel: 'anonymous',
  route: 'v1/images/builds/{buildId}/snapshot',
  handler: imageBuildsSnapshotDelete,
});
