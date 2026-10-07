import { DefaultAzureCredential } from '@azure/identity';
import { ComputeManagementClient } from '@azure/arm-compute';
import { NetworkManagementClient } from '@azure/arm-network';
import type { ImageBuildPlan, ImageBuildStepId, ImageBuildStepState } from '@avdmgr/shared';
import type { AuditLogger } from '../lib/auditLog';
import { getConfig } from '../lib/config';
import { getPlanStep, type ImageBuildPlanContext } from '../lib/imageBuildPlan';
import { isPoweredOffForCapture } from '../lib/imageBuildStateMachine';
import { getVmPowerState } from './computeService';
import type { ImageBuildEntity } from './imageBuildService';

/**
 * AM-27 (M4-S2) — the ARM-calling executor. Every function here reads its
 * parameters from the SAME generated plan (imageBuildPlan.ts's
 * generateImageBuildPlan) the dry-run preview returns — never re-derives
 * them — so what a real build does can never drift from what the preview
 * showed the operator.
 *
 * RESUMABLE-BY-CONSTRUCTION DESIGN: no function here ever holds an SDK
 * poller across two separate calls/invocations (a poller is an in-memory
 * object — it cannot survive a Function App restart, deploy, or scale-in).
 * Every long-running ARM operation is instead handled as: (1) SUBMIT the
 * operation, awaiting only `poller.submitted()` (never `pollUntilDone()`)
 * — same "begin + 202 Accepted, poller not awaited" design as
 * computeService.ts#beginVmPowerAction, extended here to VM/NIC/snapshot/
 * gallery-image-version create and to delete — then (2) on a LATER,
 * independent timer tick, POLL for completion via a fresh GET of the
 * resource itself (provisioningState for a create, a 404 for a delete),
 * never the original poller object. This is what makes the state machine
 * resumable across restarts "by construction": every tick's action is
 * derived entirely from the ImageBuild Table row + a fresh ARM read, never
 * from in-memory state left over from a previous invocation.
 *
 * MACHINE-READABLE RESOURCE NAMES (Opus review MAJOR 8): every function
 * below that needs a resource's bare name reads it either from the plan
 * step's `resourceName` field (ImageBuildPlanStep — never the human-
 * readable `resource` display string) or, in the cleanup/delete path,
 * directly from the build ENTITY's own vmName/nicName/diskName fields
 * (which are the frozen, authoritative names persisted at build-start time
 * — see imageBuildService.ts's ImageBuildEntity). Neither path ever parses
 * a display string.
 *
 * ATTEMPT CEILINGS (Opus review MINOR 13c): every poll function that could
 * loop forever against a permanently-broken resource increments a
 * per-step `attempts` counter and fails the build once MAX_POLL_ATTEMPTS is
 * exceeded, with a message pointing the operator at the resource directly.
 * Deliberately NOT applied to `awaiting_stopped` — that gate is meant to
 * wait for a human (or an out-of-band process) to actually stop the VM, on
 * whatever timescale that takes; an attempt ceiling there would force-fail
 * a build purely because an operator was slow, which is a worse outcome
 * than an unbounded wait.
 *
 * runCommand HONESTY (Opus review MINOR 14): `submitSysprepIfNeeded` below
 * calls `virtualMachines.runCommand`, which is SYSTEM-level, ARBITRARY code
 * execution on the target VM — not a narrow "run Sysprep" primitive. This
 * app's own code only ever invokes it with the one documented Sysprep
 * command (imageBuildPlan.ts's run_sysprep step), but the RBAC grant behind
 * it (imageBuildOperatorRole.bicep) is exactly as broad as "this identity
 * can run anything, as SYSTEM, on any VM in RG-AVD-Images" — see that
 * module's header comment for the full account.
 */

/** ~3 hours at the timer's 1-minute cadence — generous for even a slow VM/snapshot/capture provisioning operation, while still bounded so a permanently-stuck ARM resource eventually surfaces as a failed build rather than polling forever. */
const MAX_POLL_ATTEMPTS = 180;

let computeClient: ComputeManagementClient | undefined;
let networkClient: NetworkManagementClient | undefined;

function getComputeClient(): ComputeManagementClient {
  if (!computeClient) {
    const { subscriptionId } = getConfig();
    computeClient = new ComputeManagementClient(new DefaultAzureCredential(), subscriptionId);
  }
  return computeClient;
}

function getNetworkClient(): NetworkManagementClient {
  if (!networkClient) {
    const { subscriptionId } = getConfig();
    networkClient = new NetworkManagementClient(new DefaultAzureCredential(), subscriptionId);
  }
  return networkClient;
}

/** Test-only: clears both cached clients so tests can re-mock between cases (same convention as tableStorage.ts's _resetTableClientCacheForTests). */
export function _resetOrchestratorClientsForTests(): void {
  computeClient = undefined;
  networkClient = undefined;
}

function hasStatusCode(error: unknown, statusCode: number): boolean {
  return typeof error === 'object' && error !== null && 'statusCode' in error && (error as { statusCode?: number }).statusCode === statusCode;
}

/** True for ARM's 404 (used to detect "already deleted" during cleanup polling, and "the build VM vanished out-of-band" everywhere else). */
export function isNotFoundError(error: unknown): boolean {
  return hasStatusCode(error, 404);
}

/** True for ARM's 409 (used by assertVersionAvailable / assertSnapshotNameAvailable to detect "already exists" — a real conflict, not absence). */
export function isConflictError(error: unknown): boolean {
  return hasStatusCode(error, 409);
}

function findStep(steps: ImageBuildStepState[], stepId: ImageBuildStepId): ImageBuildStepState | undefined {
  return steps.find((s) => s.stepId === stepId);
}

/**
 * Immutably updates one step's status/timestamps/error/attempts within a
 * steps array — every orchestrator function below returns a NEW array
 * rather than mutating the caller's.
 *
 * CANONICAL ORDER PRESERVED (Opus review MINOR 13a): replaces the step
 * IN PLACE at its existing array index; only a genuinely new stepId (never
 * seen before) is appended. The original implementation filtered the step
 * out and pushed the update to the END of the array, which silently
 * reordered ImageBuildDetail.steps on every single update — the frontend's
 * StepsTable (and any operator reading the raw API response) would see
 * steps jump around instead of staying in the fixed plan order the
 * checklist_gate/UI relies on for "which step comes next" framing.
 */
export function withStepStatus(steps: ImageBuildStepState[], stepId: ImageBuildStepId, patch: Partial<ImageBuildStepState>, now: Date): ImageBuildStepState[] {
  const index = steps.findIndex((s) => s.stepId === stepId);
  const base: ImageBuildStepState = index >= 0 ? steps[index] : { stepId, status: 'pending' };
  const updated: ImageBuildStepState = { ...base, ...patch };
  if (patch.status === 'in_progress' && !updated.startedAt) {
    updated.startedAt = now.toISOString();
  }
  if ((patch.status === 'succeeded' || patch.status === 'failed') && !updated.completedAt) {
    updated.completedAt = now.toISOString();
  }
  if (index >= 0) {
    const copy = [...steps];
    copy[index] = updated;
    return copy;
  }
  return [...steps, updated];
}

function stepStatus(steps: ImageBuildStepState[], stepId: ImageBuildStepId): ImageBuildStepState['status'] {
  return findStep(steps, stepId)?.status ?? 'pending';
}

function stepAttempts(steps: ImageBuildStepState[], stepId: ImageBuildStepId): number {
  return findStep(steps, stepId)?.attempts ?? 0;
}

/** Increments a step's attempt counter, returning the updated steps array PLUS whether the ceiling has now been exceeded (the caller decides how to fail — the message differs per state). */
function bumpAttempts(steps: ImageBuildStepState[], stepId: ImageBuildStepId, now: Date): { steps: ImageBuildStepState[]; exceeded: boolean } {
  const attempts = stepAttempts(steps, stepId) + 1;
  const updated = withStepStatus(steps, stepId, { attempts }, now);
  return { steps: updated, exceeded: attempts > MAX_POLL_ATTEMPTS };
}

function parseSteps(build: Pick<ImageBuildEntity, 'stepsJson'>): ImageBuildStepState[] {
  try {
    return JSON.parse(build.stepsJson || '[]') as ImageBuildStepState[];
  } catch {
    return [];
  }
}

// --------------------------------------------------------------------------
// PRE-FLIGHT checks — called synchronously by the start/advance handlers
// BEFORE any mutating ARM call, to fail fast with a clear message rather
// than let a foreseeable ARM rejection surface as an opaque 502 later.
// --------------------------------------------------------------------------

/**
 * Opus review MAJOR 6 — refuses to start a build whose target version
 * already exists as a gallery image version (this app must never silently
 * overwrite a published version). A plain read (galleryImageVersions.get);
 * a 404 means the version is available, any other success means it exists
 * (conflict), any other error propagates.
 */
export async function assertVersionAvailable(version: string, context: ImageBuildPlanContext): Promise<{ ok: true } | { ok: false; reason: string }> {
  const compute = getComputeClient();
  try {
    await compute.galleryImageVersions.get(context.resourceGroup, context.galleryName, context.imageDefinitionName, version);
    return { ok: false, reason: `Gallery image version ${context.galleryName}/${context.imageDefinitionName}/${version} already exists — this app never overwrites a published version. Choose a different version number.` };
  } catch (error) {
    if (isNotFoundError(error)) {
      return { ok: true };
    }
    throw error;
  }
}

/**
 * Opus review MINOR 13d — refuses to submit the pre-Sysprep snapshot if a
 * snapshot with that exact name already exists (the documented naming
 * format, SNAP-WIN11-PRE-SYSPREP-{version} — the runbooks
 * §4.5 — collides across build ATTEMPTS at the same version
 * number, e.g. a prior failed/cancelled build left one behind). The
 * runbook's naming format is kept exactly as documented; this is a
 * pre-flight guard, not a rename.
 */
export async function assertSnapshotNameAvailable(snapshotName: string, context: ImageBuildPlanContext): Promise<{ ok: true } | { ok: false; reason: string }> {
  const compute = getComputeClient();
  try {
    await compute.snapshots.get(context.resourceGroup, snapshotName);
    return { ok: false, reason: `A snapshot named ${snapshotName} already exists in ${context.resourceGroup} — delete it first, or confirm it's safe to reuse, before retrying this build (see the golden-image runbook §4.5 for the naming convention and its rebuild-starting-point purpose).` };
  } catch (error) {
    if (isNotFoundError(error)) {
      return { ok: true };
    }
    throw error;
  }
}

// --------------------------------------------------------------------------
// SYNCHRONOUS submit actions — called directly by an HTTP handler at the
// moment an operator starts a build or confirms an operator gate. Each
// submits ARM operation(s) and returns the step updates to persist; the
// CALLER (imageBuilds.ts) is responsible for the state transition itself
// (via imageBuildStateMachine.ts#assertTransition) and the Table write.
// --------------------------------------------------------------------------

/**
 * Thrown by submitBuildVmCreation when the NIC create succeeded but the VM
 * create submission itself failed — carries the PARTIAL steps array (NIC
 * marked succeeded) so the caller can persist an honest record of what may
 * already exist in Azure, rather than leaving the row's steps at their
 * initial all-pending state while a real NIC sits in RG-AVD-Images (Opus
 * review MAJOR 4).
 */
export class PartialBuildVmCreationError extends Error {
  readonly steps: ImageBuildStepState[];
  constructor(message: string, steps: ImageBuildStepState[], cause: unknown) {
    super(message, { cause });
    this.name = 'PartialBuildVmCreationError';
    this.steps = steps;
  }
}

/**
 * Submits the build VM's creation: creates the NIC FIRST, awaited to full
 * completion (NIC provisioning is fast — seconds, not minutes — so
 * awaiting it fully inside the POST /v1/images/builds request is safe and
 * keeps the VM create's networkProfile trivially valid on its first
 * attempt), then submits the VM create itself via poller.submitted() ONLY
 * — the slow part (Windows provisioning, extension installs) is left for
 * the timer to poll. `adminPassword` is the FRESHLY GENERATED value (see
 * app/api/src/lib/imageBuildSecrets.ts) — injected into a COPY of the
 * plan step's parameters at this call site only, never mutating the plan
 * object itself and never persisted anywhere.
 *
 * If VM creation submission fails AFTER the NIC was successfully created,
 * throws PartialBuildVmCreationError carrying the (NIC-succeeded) partial
 * steps array — the caller persists this and leaves the row resolvable by
 * imageBuildTimer.ts#reconcilePlanned rather than guessing.
 */
export async function submitBuildVmCreation(plan: ImageBuildPlan, adminPassword: string): Promise<ImageBuildStepState[]> {
  const now = new Date();
  let steps: ImageBuildStepState[] = [];

  const nicStep = getPlanStep(plan, 'create_build_nic');
  steps = withStepStatus(steps, 'create_build_nic', { status: 'in_progress' }, now);
  const network = getNetworkClient();
  const { resourceGroups } = getConfig();
  const nicPoller = network.networkInterfaces.createOrUpdate(resourceGroups.images, nicStep.resourceName, nicStep.parameters as Parameters<typeof network.networkInterfaces.createOrUpdate>[2]);
  await nicPoller.pollUntilDone();
  steps = withStepStatus(steps, 'create_build_nic', { status: 'succeeded' }, now);

  const vmStep = getPlanStep(plan, 'create_build_vm');
  steps = withStepStatus(steps, 'create_build_vm', { status: 'in_progress' }, now);
  const compute = getComputeClient();
  const vmParams = { ...(vmStep.parameters as Record<string, unknown>), osProfile: { ...(vmStep.parameters as { osProfile: Record<string, unknown> }).osProfile, adminPassword } };
  try {
    const vmPoller = compute.virtualMachines.createOrUpdate(resourceGroups.images, vmStep.resourceName, vmParams as Parameters<typeof compute.virtualMachines.createOrUpdate>[2]);
    await vmPoller.submitted();
  } catch (error) {
    throw new PartialBuildVmCreationError(
      `NIC ${nicStep.resourceName} was created, but submitting the VM create for ${vmStep.resourceName} failed: ${error instanceof Error ? error.message : String(error)}`,
      steps,
      error,
    );
  }
  steps = withStepStatus(steps, 'create_build_vm', { status: 'in_progress' }, now);

  return steps;
}

/** Submits the pre-Sysprep snapshot create (operator-confirmed at checklist_gate -> snapshotting, AFTER assertSnapshotNameAvailable has passed). Submission only — the timer polls provisioningState. */
export async function submitPreSysprepSnapshot(plan: ImageBuildPlan): Promise<ImageBuildStepState[]> {
  const now = new Date();
  const step = getPlanStep(plan, 'create_presysprep_snapshot');
  const { resourceGroups } = getConfig();
  const compute = getComputeClient();
  const poller = compute.snapshots.createOrUpdate(resourceGroups.images, step.resourceName, step.parameters as unknown as Parameters<typeof compute.snapshots.createOrUpdate>[2]);
  await poller.submitted();
  return withStepStatus([], 'create_presysprep_snapshot', { status: 'in_progress' }, now);
}

/**
 * Submits the FIRST of the three build-resource deletes (operator-confirmed
 * at test_host_step -> cleanup): the build VM only. Takes the BUILD ENTITY
 * directly — not a regenerated plan (Opus review MAJOR 8/9) — since the
 * entity's own vmName/nicName/diskName fields are the frozen, authoritative
 * resource names persisted at build-start time; there is no need to
 * re-resolve a plan (with its live-config dependency) just to delete
 * resources whose names are already known.
 *
 * AM-46 — DEPENDENCY-ORDERED SUBMISSION (bug observed live in prod build
 * 2414dd61, 2026-08-22): this used to submit all three deletes (VM, NIC, OS
 * disk) back-to-back. The VM delete is a long-running ARM operation; ARM
 * synchronously REJECTS the NIC and disk deletes submitted seconds later
 * while the VM (which still references both) has not finished deleting —
 * "Nic … is used by existing resource …", "Disk … is attached to VM …".
 * Those rejections landed the nic/disk steps in `failed` at submit time,
 * and pollCleanup only ever polled `in_progress` steps, so a `failed`-at-
 * submit step was never revisited: the VM delete would eventually finish,
 * the NIC and disk were orphaned in Azure, `allDone` never became true, and
 * the build sat in `cleanup` forever — neither `done` nor `failed`.
 *
 * The fix: submit ONLY the VM delete here (same submitDelete semantics — a
 * 404 at submit means already gone, i.e. `succeeded`; any other error means
 * `failed`). delete_build_nic/delete_build_disk are left at their prior
 * status (normally `pending`) — pollCleanup below is responsible for
 * submitting them, but only once it has confirmed the VM delete has
 * actually completed. This function's returned array still carries entries
 * for all three steps (nic/disk explicitly `pending`) so the UI always has
 * something to render for every step in the plan, even though only one ARM
 * call was actually made.
 */
export async function submitCleanupDeletes(build: Pick<ImageBuildEntity, 'vmName' | 'nicName' | 'diskName'>): Promise<ImageBuildStepState[]> {
  const now = new Date();
  const { resourceGroups } = getConfig();
  const compute = getComputeClient();
  let steps: ImageBuildStepState[] = [];

  steps = withStepStatus(steps, 'delete_build_vm', await submitDelete(() => compute.virtualMachines.delete(resourceGroups.images, build.vmName)), now);
  steps = withStepStatus(steps, 'delete_build_nic', { status: 'pending' }, now);
  steps = withStepStatus(steps, 'delete_build_disk', { status: 'pending' }, now);

  return steps;
}

async function submitDelete(begin: () => { submitted: () => Promise<void> }): Promise<Partial<ImageBuildStepState>> {
  try {
    const poller = begin();
    await poller.submitted();
    return { status: 'in_progress' };
  } catch (error) {
    if (isNotFoundError(error)) {
      return { status: 'succeeded' }; // already gone — nothing to delete, that's the goal achieved.
    }
    return { status: 'failed', error: error instanceof Error ? error.message : String(error) };
  }
}

// --------------------------------------------------------------------------
// TIMER-DRIVEN poll+advance functions — each takes the CURRENT persisted
// entity plus (where needed) the plan it was started with, makes exactly
// the ARM read(s) needed to decide whether anything changed, and returns
// either `null` (nothing to do yet — re-check next tick), the SAME state
// (self-transition — progress within a state, e.g. a multi-phase capture
// sequence; the timer persists this WITHOUT a transition-table check — see
// imageBuildTimer.ts's advanceOneBuild), or a genuinely new state. Never
// throws on an expected "still in progress" condition; DOES throw on a
// genuinely unexpected ARM error, which the timer catches and logs.
// --------------------------------------------------------------------------

export interface AdvanceResult {
  nextState: ImageBuildEntity['state'];
  steps: ImageBuildStepState[];
  errorMessage?: string;
  capturedImageVersionId?: string;
  baseImageExactVersion?: string;
}

/**
 * planned -> vm_creating RECONCILIATION (Opus review BLOCKER/MAJOR 4).
 * Handles the case where the start handler's synchronous
 * planned -> vm_creating write never landed (process crash/restart between
 * submitting the VM create and persisting that transition). Checks whether
 * the build VM ACTUALLY EXISTS in Azure:
 *   - VM found -> the ARM submission succeeded; resume into vm_creating
 *     (marking create_build_nic/create_build_vm succeeded/in_progress so
 *     pollVmCreating picks up cleanly next tick).
 *   - VM not found AND the row is still fresh (< RECONCILE_GRACE_MINUTES
 *     old) -> null (the start handler's own synchronous call may simply
 *     still be in flight — do nothing yet).
 *   - VM not found AND the row is old enough -> fail the build with HONEST
 *     guidance: nothing is confirmed to exist, but the NIC (created before
 *     the VM in submitBuildVmCreation) may still be there even if the VM
 *     never was — name it explicitly rather than assuming a clean slate.
 */
const RECONCILE_GRACE_MINUTES = 3;

export async function reconcilePlanned(build: ImageBuildEntity, now: Date = new Date()): Promise<AdvanceResult | null> {
  const { resourceGroups } = getConfig();
  const compute = getComputeClient();
  let vmExists = true;
  try {
    await compute.virtualMachines.get(resourceGroups.images, build.vmName);
  } catch (error) {
    if (!isNotFoundError(error)) throw error;
    vmExists = false;
  }

  if (vmExists) {
    let steps = parseSteps(build);
    steps = withStepStatus(steps, 'create_build_nic', { status: 'succeeded' }, now);
    steps = withStepStatus(steps, 'create_build_vm', { status: 'in_progress' }, now);
    return { nextState: 'vm_creating', steps };
  }

  const ageMinutes = (now.getTime() - new Date(build.createdAt).getTime()) / 60_000;
  if (ageMinutes < RECONCILE_GRACE_MINUTES) {
    return null; // the start handler's own synchronous submission may still be in flight.
  }

  return {
    nextState: 'failed',
    steps: parseSteps(build),
    errorMessage:
      `This build never confirmed its VM creation was submitted to Azure (no durable record, and the VM ${build.vmName} does not exist ` +
      `${RECONCILE_GRACE_MINUTES}+ minutes after the build was created). Its network interface (${build.nicName}) MAY have been created ` +
      `before the failure — check RG-AVD-Images for a stray resource of that name before starting a new build with this version.`,
  };
}

/** vm_creating -> vm_ready once the VM's own provisioningState reads Succeeded (recording the resolved base-image exactVersion for provenance — Opus review MINOR 13e); -> failed on Failed, a 404 (the VM vanished out-of-band), or an exhausted attempt ceiling. */
export async function pollVmCreating(build: ImageBuildEntity, now: Date = new Date()): Promise<AdvanceResult | null> {
  const { resourceGroups } = getConfig();
  const compute = getComputeClient();
  let steps = parseSteps(build);

  let vm;
  try {
    vm = await compute.virtualMachines.get(resourceGroups.images, build.vmName);
  } catch (error) {
    if (isNotFoundError(error)) {
      steps = withStepStatus(steps, 'create_build_vm', { status: 'failed', error: 'Build VM no longer exists in Azure.' }, now);
      return { nextState: 'failed', steps, errorMessage: `Build VM ${build.vmName} was deleted out-of-band while still provisioning.` };
    }
    throw error;
  }

  if (vm.provisioningState === 'Succeeded') {
    steps = withStepStatus(steps, 'create_build_vm', { status: 'succeeded' }, now);
    return { nextState: 'vm_ready', steps, baseImageExactVersion: vm.storageProfile?.imageReference?.exactVersion };
  }
  if (vm.provisioningState === 'Failed') {
    steps = withStepStatus(steps, 'create_build_vm', { status: 'failed', error: 'VM provisioning failed.' }, now);
    return { nextState: 'failed', steps, errorMessage: `Build VM ${build.vmName} provisioning failed.` };
  }

  const { steps: bumped, exceeded } = bumpAttempts(steps, 'create_build_vm', now);
  if (exceeded) {
    const failedSteps = withStepStatus(bumped, 'create_build_vm', { status: 'failed', error: 'Exceeded maximum poll attempts.' }, now);
    return { nextState: 'failed', steps: failedSteps, errorMessage: `Build VM ${build.vmName} did not finish provisioning within the maximum poll attempts — check it directly in Azure.` };
  }
  return { nextState: 'vm_creating', steps: bumped }; // still Creating/Updating — self-transition, check again next tick.
}

/** vm_ready -> checklist_gate is an immediate, unconditional advance (nothing left to poll). */
export function advanceVmReady(build: ImageBuildEntity): AdvanceResult {
  return { nextState: 'checklist_gate', steps: parseSteps(build) };
}

/** snapshotting -> sysprep_running once the pre-Sysprep snapshot's provisioningState reads Succeeded; -> failed on Failed or an exhausted attempt ceiling. */
export async function pollSnapshotting(build: ImageBuildEntity, now: Date = new Date()): Promise<AdvanceResult | null> {
  const { resourceGroups } = getConfig();
  const compute = getComputeClient();
  const snapshot = await compute.snapshots.get(resourceGroups.images, build.snapshotName);
  let steps = parseSteps(build);

  if (snapshot.provisioningState === 'Succeeded') {
    steps = withStepStatus(steps, 'create_presysprep_snapshot', { status: 'succeeded' }, now);
    return { nextState: 'sysprep_running', steps };
  }
  if (snapshot.provisioningState === 'Failed') {
    steps = withStepStatus(steps, 'create_presysprep_snapshot', { status: 'failed', error: 'Snapshot provisioning failed.' }, now);
    return { nextState: 'failed', steps, errorMessage: `Pre-Sysprep snapshot ${build.snapshotName} provisioning failed.` };
  }

  const { steps: bumped, exceeded } = bumpAttempts(steps, 'create_presysprep_snapshot', now);
  if (exceeded) {
    const failedSteps = withStepStatus(bumped, 'create_presysprep_snapshot', { status: 'failed', error: 'Exceeded maximum poll attempts.' }, now);
    return { nextState: 'failed', steps: failedSteps, errorMessage: `Snapshot ${build.snapshotName} did not finish provisioning within the maximum poll attempts — check it directly in Azure.` };
  }
  return { nextState: 'snapshotting', steps: bumped };
}

/**
 * Drives sysprep_running through two persisted phases (Opus review MINOR
 * 13b — "persist submitted-marker BEFORE invoking Run Command"):
 *   1. run_sysprep status 'pending' -> mark 'in_progress' and return WITHOUT
 *      calling Run Command at all. The timer persists this on ITS OWN tick,
 *      so a crash between phase 1 and phase 2 leaves an honest
 *      "we were about to submit but hadn't yet" record, not a silent gap.
 *   2. run_sysprep status 'in_progress' -> now actually call Run Command.
 *      On success, mark 'succeeded' (meaning "accepted by ARM" — the REAL
 *      completion signal is the power-state poll in pollAwaitingStopped,
 *      since Sysprep's own `/shutdown` is what actually proves the script
 *      ran) and transition to awaiting_stopped. On failure, checks the
 *      VM's live power state: if it's no longer 'running', the VM is
 *      unreachable for a fresh Run Command (it may have already run
 *      Sysprep and shut down, or been stopped some other way) — fail the
 *      build with that guidance rather than retrying a submit that can
 *      never succeed against a stopped VM. Otherwise (still running — a
 *      transient ARM error), bump the attempt counter and retry, up to the
 *      ceiling.
 *   3. run_sysprep status 'succeeded' already (resuming after a restart) ->
 *      idempotent no-op, transition to awaiting_stopped again.
 */
export async function submitSysprepIfNeeded(build: ImageBuildEntity, plan: ImageBuildPlan, now: Date = new Date()): Promise<AdvanceResult> {
  const steps = parseSteps(build);
  const status = stepStatus(steps, 'run_sysprep');

  if (status === 'succeeded') {
    return { nextState: 'awaiting_stopped', steps };
  }

  if (status === 'pending') {
    const marked = withStepStatus(steps, 'run_sysprep', { status: 'in_progress' }, now);
    return { nextState: 'sysprep_running', steps: marked }; // self-transition — persist the "about to submit" marker BEFORE the ARM call.
  }

  // status === 'in_progress': the marker is already persisted — safe to actually submit now.
  const { resourceGroups } = getConfig();
  const compute = getComputeClient();
  const step = getPlanStep(plan, 'run_sysprep');
  try {
    const poller = compute.virtualMachines.runCommand(resourceGroups.images, build.vmName, step.parameters as unknown as Parameters<typeof compute.virtualMachines.runCommand>[2]);
    await poller.submitted();
  } catch (error) {
    const powerState = await getVmPowerState(resourceGroups.images, build.vmName).catch(() => 'unknown' as const);
    if (powerState !== 'running') {
      const failedSteps = withStepStatus(steps, 'run_sysprep', { status: 'failed', error: 'VM is no longer running — cannot submit Run Command.' }, now);
      return {
        nextState: 'failed',
        steps: failedSteps,
        errorMessage: `Sysprep Run Command submission failed and the build VM ${build.vmName} is no longer running (power state: ${powerState}) — it may already have run Sysprep and shut down, or been stopped some other way. Check the VM directly before retrying.`,
      };
    }
    const errorMessage = error instanceof Error ? error.message : String(error);
    const { steps: bumped, exceeded } = bumpAttempts(steps, 'run_sysprep', now);
    if (exceeded) {
      const failedSteps = withStepStatus(bumped, 'run_sysprep', { status: 'failed', error: `Exceeded maximum submission attempts. Last error: ${errorMessage}` }, now);
      return { nextState: 'failed', steps: failedSteps, errorMessage: `Sysprep Run Command against ${build.vmName} did not succeed within the maximum attempts — check it directly in Azure.` };
    }
    const retriedSteps = withStepStatus(bumped, 'run_sysprep', { error: errorMessage }, now);
    return { nextState: 'sysprep_running', steps: retriedSteps }; // still running — transient failure, self-transition and retry.
  }

  const updated = withStepStatus(steps, 'run_sysprep', { status: 'succeeded' }, now);
  return { nextState: 'awaiting_stopped', steps: updated };
}

/**
 * Shared 404-of-build-VM handling (Opus review MINOR 13c) for every poll
 * function that reads the VM's power state — `getVmPowerState` calls
 * `virtualMachines.instanceView` directly and does not itself catch a 404
 * (the VM having been deleted out-of-band, e.g. an operator manually
 * removed it), so left unhandled that error would propagate all the way to
 * imageBuildTimer.ts's catch block as an unexpected error (logged
 * IMAGE_BUILD_STUCK, nothing persisted) rather than a clean, honest
 * 'failed' transition. Returns either the resolved power state, or a
 * ready-to-return `{ result }` the caller should return immediately.
 */
async function resolvePowerStateOrFail(build: ImageBuildEntity, currentState: string): Promise<{ powerState: Awaited<ReturnType<typeof getVmPowerState>> } | { result: AdvanceResult }> {
  const { resourceGroups } = getConfig();
  try {
    const powerState = await getVmPowerState(resourceGroups.images, build.vmName);
    return { powerState };
  } catch (error) {
    if (!isNotFoundError(error)) throw error;
    return {
      result: {
        nextState: 'failed',
        steps: parseSteps(build),
        errorMessage: `Build VM ${build.vmName} was deleted out-of-band while the build was at ${currentState}.`,
      },
    };
  }
}

/**
 * awaiting_stopped -> capturing. THE HARD GATE: reads the VM's power state
 * via a FRESH instanceView call (computeService.getVmPowerState — the same
 * function the session-host power feature already uses) on EVERY tick,
 * and only proceeds once imageBuildStateMachine.ts#isPoweredOffForCapture
 * is true. Once it is, submits `deallocate` (poller.submitted() only) so
 * the VM is DEFINITELY deallocated (not merely guest-shutdown-"stopped")
 * before generalize/capture — see pollCapturing below for the rest of that
 * sequence. Deliberately has NO attempt ceiling — see this file's header
 * comment.
 */
export async function pollAwaitingStopped(build: ImageBuildEntity, now: Date = new Date()): Promise<AdvanceResult | null> {
  const { resourceGroups } = getConfig();
  const powerStateResult = await resolvePowerStateOrFail(build, 'awaiting_stopped');
  if ('result' in powerStateResult) return powerStateResult.result;
  const { powerState } = powerStateResult;
  if (!isPoweredOffForCapture(powerState)) {
    return null; // still running/stopping — check again next tick. NEVER proceed on a stale/assumed state.
  }
  const compute = getComputeClient();
  const poller = compute.virtualMachines.deallocate(resourceGroups.images, build.vmName);
  await poller.submitted();
  const steps = withStepStatus(parseSteps(build), 'ensure_deallocated', { status: 'in_progress' }, now);
  return { nextState: 'capturing', steps };
}

/**
 * Drives the capturing state through its three phases, ALL keyed off the
 * per-step status recorded on the row (never in-memory state) so any phase
 * can resume correctly after a restart:
 *   1. ensure_deallocated in_progress -> poll power state; once genuinely
 *      'deallocated', mark succeeded and immediately call `generalize`
 *      (a plain awaited call, not a poller — see this file's Learn-verified
 *      doc comment on virtualMachines.generalize's Promise<void> shape).
 *   2. generalize_vm succeeded, capture_image_version still pending ->
 *      submit the gallery image version create (submitted() only).
 *   3. capture_image_version in_progress -> poll its provisioningState;
 *      once Succeeded, advance to test_host_step.
 */
export async function pollCapturing(build: ImageBuildEntity, plan: ImageBuildPlan, now: Date = new Date()): Promise<AdvanceResult | null> {
  const { resourceGroups, galleryName, imageDefinitionName } = getConfig();
  let steps = parseSteps(build);
  const compute = getComputeClient();

  if (stepStatus(steps, 'ensure_deallocated') !== 'succeeded') {
    const powerStateResult = await resolvePowerStateOrFail(build, 'capturing');
    if ('result' in powerStateResult) return powerStateResult.result;
    const { powerState } = powerStateResult;
    if (powerState !== 'deallocated') {
      return null; // deallocate still in flight — check again next tick.
    }
    steps = withStepStatus(steps, 'ensure_deallocated', { status: 'succeeded' }, now);
    steps = withStepStatus(steps, 'generalize_vm', { status: 'in_progress' }, now);
    await compute.virtualMachines.generalize(resourceGroups.images, build.vmName);
    steps = withStepStatus(steps, 'generalize_vm', { status: 'succeeded' }, now);
    return { nextState: 'capturing', steps }; // self-transition — progress persisted, more phases to go.
  }

  if (stepStatus(steps, 'capture_image_version') === 'pending') {
    const step = getPlanStep(plan, 'capture_image_version');
    steps = withStepStatus(steps, 'capture_image_version', { status: 'in_progress' }, now);
    // Live finding (2026-08-22, first build ever to reach this step —
    // correlation d81fe44e): the plan carries endOfLifeDate as an ISO
    // string (computeEolDate returns YYYY-MM-DD, and the whole plan is
    // JSON-persisted in the ImageBuild table anyway, so a Date could not
    // survive the round-trip either), but the SDK's publishing-profile
    // serializer requires a real Date and throws
    // "endOfLifeDate.toISOString is not a function" on a string. Revive it
    // to a Date at the SDK boundary — the one place the type actually
    // matters.
    const rawParams = step.parameters as Record<string, unknown>;
    const publishingProfile = rawParams.publishingProfile as Record<string, unknown> | undefined;
    const captureParameters = (publishingProfile?.endOfLifeDate != null
      ? { ...rawParams, publishingProfile: { ...publishingProfile, endOfLifeDate: new Date(publishingProfile.endOfLifeDate as string) } }
      : rawParams) as unknown as Parameters<typeof compute.galleryImageVersions.createOrUpdate>[4];
    const poller = compute.galleryImageVersions.createOrUpdate(
      resourceGroups.images,
      galleryName,
      imageDefinitionName,
      build.version,
      captureParameters,
    );
    await poller.submitted();
    return { nextState: 'capturing', steps }; // self-transition — submitted, not yet confirmed.
  }

  if (stepStatus(steps, 'capture_image_version') === 'in_progress') {
    const version = await compute.galleryImageVersions.get(resourceGroups.images, galleryName, imageDefinitionName, build.version);
    if (version.provisioningState === 'Succeeded') {
      steps = withStepStatus(steps, 'capture_image_version', { status: 'succeeded' }, now);
      return { nextState: 'test_host_step', steps, capturedImageVersionId: version.id };
    }
    if (version.provisioningState === 'Failed') {
      steps = withStepStatus(steps, 'capture_image_version', { status: 'failed', error: 'Gallery image version provisioning failed.' }, now);
      return { nextState: 'failed', steps, errorMessage: `Gallery image version ${build.version} provisioning failed.` };
    }
    const { steps: bumped, exceeded } = bumpAttempts(steps, 'capture_image_version', now);
    if (exceeded) {
      const failedSteps = withStepStatus(bumped, 'capture_image_version', { status: 'failed', error: 'Exceeded maximum poll attempts.' }, now);
      return { nextState: 'failed', steps: failedSteps, errorMessage: `Gallery image version ${build.version} did not finish provisioning within the maximum poll attempts — check it directly in Azure.` };
    }
    return { nextState: 'capturing', steps: bumped };
  }

  return null;
}

/**
 * Applies the outcome of a cleanup-delete (re)submission to `steps`, used by
 * pollCleanup below for BOTH a `failed`-at-submit delete_build_vm and the
 * dependent nic/disk deletes. Deliberately skips the two-phase persist-
 * before-invoke marker submitSysprepIfNeeded mandates for its (non-
 * idempotent, arbitrary-code) runCommand: an ARM DELETE is idempotent, so
 * an at-least-once re-submit here is harmless even if the process restarts
 * mid-tick.
 *
 * Clears any stale `error`/`completedAt` a PRIOR failed attempt on this
 * step left behind before applying the fresh outcome (Opus review MAJOR
 * 3): Stepper.tsx renders `step.error` in red regardless of the step's
 * current status, and a stale `completedAt` surviving from a previous
 * failure would make a step that just succeeded on retry render as having
 * completed before it started. A repeat failure bumps the SAME per-step
 * `attempts` budget the in_progress poll path uses (one budget per step,
 * whether it accrues from failed submits or in-flight polls); once
 * exceeded, mirrors submitSysprepIfNeeded's wording — the real ARM
 * rejection is attached to the step's error rather than discarded behind a
 * generic message.
 */
function applyDeleteSubmitResult(steps: ImageBuildStepState[], stepId: ImageBuildStepId, result: Partial<ImageBuildStepState>, now: Date): { steps: ImageBuildStepState[]; exceeded: boolean } {
  let updated = withStepStatus(steps, stepId, { ...result, error: undefined, completedAt: undefined }, now);
  if (result.status !== 'failed') {
    return { steps: updated, exceeded: false };
  }
  updated = withStepStatus(updated, stepId, { error: result.error }, now);
  const { steps: bumped, exceeded } = bumpAttempts(updated, stepId, now);
  if (!exceeded) {
    return { steps: bumped, exceeded: false };
  }
  const failedSteps = withStepStatus(bumped, stepId, { status: 'failed', error: `Exceeded maximum submission attempts. Last error: ${result.error}` }, now);
  return { steps: failedSteps, exceeded: true };
}

/**
 * AM-48 — emits the greppable IMAGE_BUILD_CLEANUP_SELFHEAL marker used by
 * infra/modules/alerting.bicep's second scheduled query rule. Deliberately
 * WARN, not ERROR (unlike IMAGE_BUILD_STUCK in imageBuilds.ts/
 * imageBuildTimer.ts): the self-heal path re-submitting a previously-failed
 * delete is the system WORKING as designed (see pollCleanup's header
 * comment, step 3) — only a repeated/persistent pattern of these across a
 * build is worth an operator's attention, which is why the alert rule fires
 * on any occurrence but at LOW severity with a wide window, rather than
 * treating a single one as urgent the way IMAGE_BUILD_STUCK is.
 *
 * `logger` is optional (pollCleanup has no InvocationContext of its own
 * today — imageBuildTimer.ts threads its own AuditLogger-shaped `context`
 * through, same structural-compatibility trick auditLog.ts's AuditLogger
 * type documents) so unit tests that call pollCleanup directly, without a
 * logger, keep working unchanged.
 */
function logCleanupSelfHeal(logger: AuditLogger | undefined, buildId: string, stepId: ImageBuildStepId): void {
  logger?.warn(`IMAGE_BUILD_CLEANUP_SELFHEAL | buildId=${buildId} step=${stepId}`);
}

/**
 * cleanup -> done once every delete step has resolved.
 *
 * AM-46 — DEPENDENCY-ORDERED CLEANUP (see submitCleanupDeletes's header for
 * the full incident account — live prod build 2414dd61, 2026-08-22): ARM
 * refuses to delete the NIC/OS disk while the VM that references them still
 * exists, so this function does three things per tick, in order:
 *
 *   1. RE-SUBMIT delete_build_vm if it is `pending` or `failed` (a `failed`
 *      status means the VM delete was itself rejected at submit time — a
 *      resource lock, a 429, a transient 5xx — Opus review MAJOR 2: without
 *      this, that's an unrecoverable dead end, since neither the poll loop
 *      below (which only touches `in_progress`) nor the nic/disk gate
 *      (which requires the VM already `succeeded`) would ever revisit it).
 *   2. POLL every step currently `in_progress` — a fresh GET per resource;
 *      a 404 means that resource is gone (succeeded), matching
 *      submitDelete's own "already gone = success" rule. Unconditional on
 *      which step it is: delete_build_vm, and (once submitted)
 *      delete_build_nic/delete_build_disk, are all polled the same way
 *      while in_progress.
 *   3. Once delete_build_vm reads `succeeded` (confirmed gone, this tick or
 *      an earlier one) — SUBMIT delete_build_nic/delete_build_disk for any
 *      of the two still `pending` OR `failed`. `pending` is the normal
 *      first submission now that the VM is out of the way; `failed`
 *      SELF-HEALS a row written by the pre-fix code, which submitted all
 *      three at once and got the nic/disk deletes synchronously rejected by
 *      ARM while the VM still existed — those are safe to retry now that
 *      the VM is confirmed gone.
 *
 * Steps 1 and 3 share applyDeleteSubmitResult's retry/attempt-ceiling
 * handling above, and stop submitting further deletes the moment one of
 * them exceeds its ceiling (so a build that's about to be failed is never
 * ALSO persisted with a freshly-submitted in_progress step). Every changed
 * step status is persisted (a non-null AdvanceResult is returned whenever
 * anything changed, INCLUDING a still-in-flight poll's incremented attempt
 * count — Opus review MAJOR 1: that increment must survive, or the poll
 * ceiling can never actually be reached) so progress survives a restart —
 * imageBuildTimer.ts only writes the row back when the poll function
 * returns non-null.
 *
 * AM-48 — every `failed`-to-re-submit branch in steps 1 and 3 above (never
 * the `pending`-to-first-submit branch) emits the greppable
 * IMAGE_BUILD_CLEANUP_SELFHEAL marker via logCleanupSelfHeal, so the exact
 * self-heal behaviour this header describes is observable outside a debugger
 * — see infra/modules/alerting.bicep's second scheduled query rule, which
 * alerts (at low severity — this is the system working, not failing) on any
 * occurrence.
 */
export async function pollCleanup(build: ImageBuildEntity, now: Date = new Date(), logger?: AuditLogger): Promise<AdvanceResult | null> {
  const { resourceGroups } = getConfig();
  const compute = getComputeClient();
  const network = getNetworkClient();
  let steps = parseSteps(build);
  let changed = false;
  let anyExceeded = false;

  // 1. Re-submit delete_build_vm if it never got past `pending`/`failed` —
  // e.g. a resource lock, 429, or transient 5xx rejected the very first
  // submit in submitCleanupDeletes (Opus review MAJOR 2).
  const initialVmStatus = stepStatus(steps, 'delete_build_vm');
  if (initialVmStatus === 'pending' || initialVmStatus === 'failed') {
    if (initialVmStatus === 'failed') logCleanupSelfHeal(logger, build.buildId, 'delete_build_vm'); // AM-48 — 'pending' is a normal first submission, not self-heal.
    const result = await submitDelete(() => compute.virtualMachines.delete(resourceGroups.images, build.vmName));
    const applied = applyDeleteSubmitResult(steps, 'delete_build_vm', result, now);
    steps = applied.steps;
    changed = true;
    if (applied.exceeded) anyExceeded = true;
  }

  // 2. Poll every step currently in_progress.
  if (!anyExceeded) {
    const checks: Array<{ stepId: ImageBuildStepId; get: () => Promise<unknown> }> = [
      { stepId: 'delete_build_vm', get: () => compute.virtualMachines.get(resourceGroups.images, build.vmName) },
      { stepId: 'delete_build_nic', get: () => network.networkInterfaces.get(resourceGroups.images, build.nicName) },
      { stepId: 'delete_build_disk', get: () => compute.disks.get(resourceGroups.images, build.diskName) },
    ];

    for (const check of checks) {
      if (stepStatus(steps, check.stepId) !== 'in_progress') continue;
      const gone = await pollDeleted(check.get);
      if (gone) {
        steps = withStepStatus(steps, check.stepId, { status: 'succeeded' }, now);
        changed = true;
        continue;
      }
      const { steps: bumped, exceeded } = bumpAttempts(steps, check.stepId, now);
      steps = bumped;
      changed = true; // Opus review MAJOR 1 — persist the incremented attempt even when still in flight, or the ceiling is never reachable.
      if (exceeded) {
        steps = withStepStatus(steps, check.stepId, { status: 'failed', error: 'Exceeded maximum poll attempts.' }, now);
        anyExceeded = true;
      }
    }
  }

  // 3. Dependency-ordered submission: only once the VM delete is CONFIRMED
  // done do we submit the NIC/disk deletes (see header comment above).
  if (!anyExceeded && stepStatus(steps, 'delete_build_vm') === 'succeeded') {
    const dependents: Array<{ stepId: ImageBuildStepId; submit: () => { submitted: () => Promise<void> } }> = [
      { stepId: 'delete_build_nic', submit: () => network.networkInterfaces.delete(resourceGroups.images, build.nicName) },
      { stepId: 'delete_build_disk', submit: () => compute.disks.delete(resourceGroups.images, build.diskName) },
    ];

    for (const dep of dependents) {
      if (anyExceeded) break; // Opus review MINOR — don't submit a fresh delete for a build we're about to fail.
      const status = stepStatus(steps, dep.stepId);
      if (status !== 'pending' && status !== 'failed') continue;
      if (status === 'failed') logCleanupSelfHeal(logger, build.buildId, dep.stepId); // AM-48 — 'pending' is a normal first submission, not self-heal.

      const result = await submitDelete(dep.submit);
      const applied = applyDeleteSubmitResult(steps, dep.stepId, result, now);
      steps = applied.steps;
      changed = true;
      if (applied.exceeded) anyExceeded = true;
    }
  }

  if (anyExceeded) {
    return { nextState: 'failed', steps, errorMessage: `One or more build cleanup deletes (${build.vmName} / ${build.nicName} / ${build.diskName}) did not finish within the maximum poll attempts — check RG-AVD-Images directly.` };
  }

  const allDone = ['delete_build_vm', 'delete_build_nic', 'delete_build_disk'].every((id) => stepStatus(steps, id as ImageBuildStepId) === 'succeeded');
  if (allDone) {
    return { nextState: 'done', steps };
  }
  return changed ? { nextState: 'cleanup', steps } : null;
}

async function pollDeleted(get: () => Promise<unknown>): Promise<boolean> {
  try {
    await get();
    return false; // still exists — delete still in flight.
  } catch (error) {
    if (isNotFoundError(error)) {
      return true;
    }
    throw error;
  }
}

// --------------------------------------------------------------------------
// AM-53 — pre-Sysprep snapshot retention (operator-confirmed delete). Both
// functions below are called directly by imageBuilds.ts's GET .../builds/{id}
// (getSnapshotStatus, for the live status shown in the detail response) and
// DELETE .../builds/{id}/snapshot (submitSnapshotDelete, only once every
// gate in that handler — build done, rollout done, snapshot still exists —
// has passed) handlers.
// --------------------------------------------------------------------------

/**
 * ONE live `snapshots.get` per call — deliberately UNCACHED (the GET detail
 * endpoint that calls this is already polled every few seconds by the
 * frontend, so a cached answer would just be stale until the next
 * unrelated poll anyway — see @avdmgr/shared's ImageBuildDetail.snapshotStatus
 * doc comment). Never throws: a 404 is the expected "already deleted"
 * outcome, and any OTHER read failure degrades to 'unknown' rather than
 * taking the whole build-detail response down with it (Opus-review-style
 * "one bad read shouldn't fail the whole page" posture this app applies
 * elsewhere — e.g. governance/support.ts's runCheckSafely).
 */
export async function getSnapshotStatus(snapshotName: string): Promise<'present' | 'deleted' | 'unknown'> {
  const { resourceGroups } = getConfig();
  const compute = getComputeClient();
  try {
    await compute.snapshots.get(resourceGroups.images, snapshotName);
    return 'present';
  } catch (error) {
    if (isNotFoundError(error)) {
      return 'deleted';
    }
    return 'unknown';
  }
}

/**
 * Submits the operator-confirmed pre-Sysprep snapshot delete — SUBMISSION
 * ONLY (`poller.submitted()`, never `pollUntilDone()`), the exact same
 * "submit and audit, don't poll to completion" idiom this file already
 * applies to submitPreSysprepSnapshot/submitCleanupDeletes above. There is
 * no further phase for a timer to poll here (nothing in the state machine
 * depends on this delete actually finishing) — the caller
 * (imageBuilds.ts's DELETE .../snapshot handler) persists
 * snapshotDeleteSubmittedAt and audits success on a successful SUBMIT, not
 * on confirmed ARM completion. Every pre-flight gate (build done, rollout
 * done, snapshot still exists) is the CALLER's responsibility — this
 * function fires the delete unconditionally once invoked.
 */
export async function submitSnapshotDelete(snapshotName: string): Promise<void> {
  const { resourceGroups } = getConfig();
  const compute = getComputeClient();
  const poller = compute.snapshots.delete(resourceGroups.images, snapshotName);
  await poller.submitted();
}

/** Re-exported for imageBuilds.ts's start handler, which needs the same ImageBuildPlanContext shape resolved from config — kept here (not duplicated) since this module already imports getConfig for every ARM call it makes. */
export function resolvePlanContext(): ImageBuildPlanContext {
  const { subscriptionId, resourceGroups, galleryName, imageDefinitionName, imageBuild } = getConfig();
  if (!imageBuild.subnetId) {
    throw new Error('IMAGE_BUILD_SUBNET_ID is not configured — cannot start an image build.');
  }
  return {
    subscriptionId,
    resourceGroup: resourceGroups.images,
    location: imageBuild.location,
    galleryName,
    imageDefinitionName,
    subnetId: imageBuild.subnetId,
    vmSize: imageBuild.defaultVmSize,
  };
}
