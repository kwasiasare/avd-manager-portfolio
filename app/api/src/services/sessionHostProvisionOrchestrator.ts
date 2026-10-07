import { randomUUID } from 'node:crypto';
import { DefaultAzureCredential } from '@azure/identity';
import { NetworkManagementClient } from '@azure/arm-network';
import type { SessionHostProvisionPlan, SessionHostProvisionState, SessionHostProvisionStepId, SessionHostProvisionStepState } from '@avdmgr/shared';
import { writeAuditEntry, type AuditLogger } from '../lib/auditLog';
import { getComputeClient } from '../lib/computeClient';
import { getConfig } from '../lib/config';
import { getPlanStep, generateSessionHostProvisionPlan, type SessionHostProvisionPlanContext } from '../lib/sessionHostProvisionPlan';
import { generateRegistrationToken, listSessionHosts } from './avdService';
import type { SessionHostProvisionEntity } from './sessionHostProvisionService';

/**
 * AM-50 — the ARM-calling executor for guided session-host provisioning.
 * Deliberately mirrors app/api/src/services/imageBuildOrchestrator.ts's
 * idioms throughout — see that file's header comment for the full
 * "RESUMABLE-BY-CONSTRUCTION DESIGN" writeup (no SDK poller ever held
 * across two invocations; every long-running ARM op is SUBMIT
 * (poller.submitted(), never pollUntilDone() — EXCEPT the NIC create, same
 * "completes in seconds" exception imageBuildOrchestrator.ts documents)
 * then POLL via a fresh GET on a later, independent tick) — this codebase
 * already solved every hard problem this workflow has, so this module
 * reuses those solutions rather than re-deriving them.
 *
 * WHERE THIS DIFFERS FROM imageBuildOrchestrator.ts:
 *   - No operator gates, so no equivalent of submitPreSysprepSnapshot/
 *     submitCleanupDeletes triggered by a POST .../advance — every step
 *     from nic_creating through awaiting_registration is timer-driven.
 *   - The three VM extensions are polled by a SINGLE shared helper
 *     (advanceExtension below) parameterized per extension, rather than
 *     three bespoke functions the way pollSnapshotting/pollCapturing/
 *     submitSysprepIfNeeded are each bespoke in the image build — the three
 *     extensions all follow the exact same "createOrUpdate, then poll
 *     provisioningState via virtualMachineExtensions.get" shape, so one
 *     parameterized function is the honest representation, not three
 *     copies of the same logic.
 *   - The DSC extension's registration token is generated FRESH inside
 *     advanceExtension's resolveProtectedSettings callback, at the exact
 *     moment of the real ARM submit call — never before, never persisted —
 *     see submitDscExtension's doc comment below.
 *   - The password lives ONLY within the single synchronous handler
 *     request that submits the NIC (pollUntilDone, fast) and the VM
 *     (submitted() only) — see submitNicCreation/submitVmCreation. Unlike
 *     the build VM's password (also generated-once-and-never-persisted),
 *     THIS password can never be regenerated on a later timer tick if the
 *     synchronous submission is interrupted, because a different value
 *     would not match whatever the operator was shown — see
 *     pollNicCreating's doc comment for the resulting (deliberately
 *     conservative) resumability contract.
 */

/** ~3 hours at the timer's 1-minute cadence — same magnitude/rationale as imageBuildOrchestrator.ts's MAX_POLL_ATTEMPTS. */
const MAX_POLL_ATTEMPTS = 180;

/** Same grace window as imageBuildOrchestrator.ts's RECONCILE_GRACE_MINUTES — see reconcilePlanned's doc comment. */
const RECONCILE_GRACE_MINUTES = 3;

/**
 * Short validity for the registration token the DSC extension consumes
 * (app/api/src/lib/sessionHostProvisionPlan.ts's ext_dsc step) — the token
 * only needs to survive the few minutes between this ARM submit and the
 * agent actually registering; 24h is generous headroom over that while
 * staying far short of AVD's own 27-day/648h maximum (see
 * app/api/src/functions/hostPoolRegistrationToken.ts's MAX_REGISTRATION_HOURS
 * doc comment for that ceiling's Microsoft Learn source).
 */
const DSC_TOKEN_HOURS_VALID = 24;

let networkClient: NetworkManagementClient | undefined;

function getNetworkClient(): NetworkManagementClient {
  if (!networkClient) {
    const { subscriptionId } = getConfig();
    networkClient = new NetworkManagementClient(new DefaultAzureCredential(), subscriptionId);
  }
  return networkClient;
}

/** Test-only: mirrors imageBuildOrchestrator.ts's _resetOrchestratorClientsForTests. */
export function _resetSessionHostProvisionOrchestratorClientsForTests(): void {
  networkClient = undefined;
}

function hasStatusCode(error: unknown, statusCode: number): boolean {
  return typeof error === 'object' && error !== null && 'statusCode' in error && (error as { statusCode?: number }).statusCode === statusCode;
}

export function isNotFoundError(error: unknown): boolean {
  return hasStatusCode(error, 404);
}

function findStep(steps: SessionHostProvisionStepState[], stepId: SessionHostProvisionStepId): SessionHostProvisionStepState | undefined {
  return steps.find((s) => s.stepId === stepId);
}

/** Immutably updates one step's status/timestamps/error/attempts within a steps array, preserving canonical plan order — mirrors imageBuildOrchestrator.ts#withStepStatus exactly (see that function's doc comment for why in-place replacement, not filter+push, matters). */
export function withStepStatus(steps: SessionHostProvisionStepState[], stepId: SessionHostProvisionStepId, patch: Partial<SessionHostProvisionStepState>, now: Date): SessionHostProvisionStepState[] {
  const index = steps.findIndex((s) => s.stepId === stepId);
  const base: SessionHostProvisionStepState = index >= 0 ? steps[index] : { stepId, status: 'pending' };
  const updated: SessionHostProvisionStepState = { ...base, ...patch };
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

function stepStatus(steps: SessionHostProvisionStepState[], stepId: SessionHostProvisionStepId): SessionHostProvisionStepState['status'] {
  return findStep(steps, stepId)?.status ?? 'pending';
}

function stepAttempts(steps: SessionHostProvisionStepState[], stepId: SessionHostProvisionStepId): number {
  return findStep(steps, stepId)?.attempts ?? 0;
}

/** Increments a step's attempt counter, returning the updated steps array PLUS whether the ceiling has now been exceeded — mirrors imageBuildOrchestrator.ts#bumpAttempts. */
function bumpAttempts(steps: SessionHostProvisionStepState[], stepId: SessionHostProvisionStepId, now: Date): { steps: SessionHostProvisionStepState[]; exceeded: boolean } {
  const attempts = stepAttempts(steps, stepId) + 1;
  const updated = withStepStatus(steps, stepId, { attempts }, now);
  return { steps: updated, exceeded: attempts > MAX_POLL_ATTEMPTS };
}

export function parseSteps(record: Pick<SessionHostProvisionEntity, 'stepsJson'>): SessionHostProvisionStepState[] {
  try {
    return JSON.parse(record.stepsJson || '[]') as SessionHostProvisionStepState[];
  } catch {
    return [];
  }
}

// --------------------------------------------------------------------------
// PRE-FLIGHT checks — called synchronously by the start handler BEFORE any
// mutating ARM call, mirrors imageBuildOrchestrator.ts's
// assertVersionAvailable/assertSnapshotNameAvailable rationale exactly.
// --------------------------------------------------------------------------

/** Refuses to start a provision whose session host name already exists as a VM in RG-AVD-HostPools — a plain read; a 404 means the name is available. */
export async function assertSessionHostNameAvailable(vmName: string, resourceGroup: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  const compute = getComputeClient();
  try {
    await compute.virtualMachines.get(resourceGroup, vmName);
    return { ok: false, reason: `A virtual machine named "${vmName}" already exists in ${resourceGroup} — choose a different session host name.` };
  } catch (error) {
    if (isNotFoundError(error)) {
      return { ok: true };
    }
    throw error;
  }
}

/** Verifies the target gallery image version actually exists, and returns its full ARM resource id for the VM's storageProfile.imageReference.id (see sessionHostProvisionPlan.ts's header comment for why this must be an id, not a marketplace tuple). */
export async function assertImageVersionExists(
  version: string,
  imagesResourceGroup: string,
  galleryName: string,
  imageDefinitionName: string,
): Promise<{ ok: true; id: string } | { ok: false; reason: string }> {
  const compute = getComputeClient();
  try {
    const result = await compute.galleryImageVersions.get(imagesResourceGroup, galleryName, imageDefinitionName, version);
    if (!result.id) {
      throw new Error(`galleryImageVersions.get for ${galleryName}/${imageDefinitionName}/${version} did not return a resource id.`);
    }
    return { ok: true, id: result.id };
  } catch (error) {
    if (isNotFoundError(error)) {
      return { ok: false, reason: `Gallery image version ${galleryName}/${imageDefinitionName}/${version} does not exist.` };
    }
    throw error;
  }
}

// --------------------------------------------------------------------------
// SYNCHRONOUS submit actions — called directly by the start handler
// (sessionHostProvisions.ts) at the moment an operator starts a provision.
// --------------------------------------------------------------------------

/** Submits the session host's NIC creation, awaited to full completion (fast — same "completes in seconds" exception imageBuildOrchestrator.ts's header comment documents for its own build-VM NIC). Throws on failure — the caller persists the failure onto the still-'planned' row (see sessionHostProvisions.ts's start handler). */
export async function submitNicCreation(plan: SessionHostProvisionPlan): Promise<SessionHostProvisionStepState[]> {
  const now = new Date();
  const step = getPlanStep(plan, 'create_nic');
  const { resourceGroups } = getConfig();
  const network = getNetworkClient();
  let steps: SessionHostProvisionStepState[] = withStepStatus([], 'create_nic', { status: 'in_progress' }, now);
  const poller = network.networkInterfaces.createOrUpdate(resourceGroups.hostPools, step.resourceName, step.parameters as Parameters<typeof network.networkInterfaces.createOrUpdate>[2]);
  await poller.pollUntilDone();
  steps = withStepStatus(steps, 'create_nic', { status: 'succeeded' }, now);
  return steps;
}

/**
 * Thrown by submitVmCreation when the NIC create succeeded (nicSteps
 * reflects that) but the VM create submission itself failed — carries the
 * PARTIAL steps array (NIC succeeded, VM failed) so the caller persists an
 * honest record at state `nic_creating` (mirrors PartialBuildVmCreationError
 * in imageBuildOrchestrator.ts, adapted to this workflow's extra
 * `nic_creating` checkpoint state — see pollNicCreating's doc comment for
 * how the timer resolves this).
 */
export class PartialProvisionVmSubmissionError extends Error {
  readonly steps: SessionHostProvisionStepState[];
  constructor(message: string, steps: SessionHostProvisionStepState[], cause: unknown) {
    super(message, { cause });
    this.name = 'PartialProvisionVmSubmissionError';
    this.steps = steps;
  }
}

/** Submits the session host VM's creation (poller.submitted() only — the timer polls provisioningState from here). `adminPassword` is the FRESHLY GENERATED value (app/api/src/lib/imageBuildSecrets.ts, reused as-is), injected into a COPY of the plan step's parameters at this call site only — never mutating the plan object and never persisted. */
export async function submitVmCreation(plan: SessionHostProvisionPlan, nicSteps: SessionHostProvisionStepState[], adminPassword: string): Promise<SessionHostProvisionStepState[]> {
  const now = new Date();
  const step = getPlanStep(plan, 'create_vm');
  const { resourceGroups } = getConfig();
  const compute = getComputeClient();
  const steps = withStepStatus(nicSteps, 'create_vm', { status: 'in_progress' }, now);
  const rawParams = step.parameters as Record<string, unknown>;
  const osProfile = rawParams.osProfile as Record<string, unknown>;
  const vmParams = { ...rawParams, osProfile: { ...osProfile, adminPassword } };
  try {
    const poller = compute.virtualMachines.createOrUpdate(resourceGroups.hostPools, step.resourceName, vmParams as Parameters<typeof compute.virtualMachines.createOrUpdate>[2]);
    await poller.submitted();
  } catch (error) {
    const failedSteps = withStepStatus(steps, 'create_vm', { status: 'failed', error: error instanceof Error ? error.message : String(error) }, now);
    throw new PartialProvisionVmSubmissionError(
      `Network interface ${plan.steps.find((s) => s.stepId === 'create_nic')?.resourceName} was created, but submitting the VM create for ${step.resourceName} failed: ${error instanceof Error ? error.message : String(error)}`,
      failedSteps,
      error,
    );
  }
  return steps;
}

// --------------------------------------------------------------------------
// TIMER-DRIVEN poll+advance functions — same contract as
// imageBuildOrchestrator.ts's own poll functions: return `null` (nothing to
// do yet), the SAME state (self-transition — progress within a state), or a
// genuinely new state. Never throws on an expected "still in progress"
// condition; DOES throw on a genuinely unexpected ARM error, which the timer
// catches and logs.
// --------------------------------------------------------------------------

export interface AdvanceResult {
  nextState: SessionHostProvisionState;
  steps: SessionHostProvisionStepState[];
  errorMessage?: string;
}

/**
 * planned -> nic_creating RECONCILIATION — mirrors
 * imageBuildOrchestrator.ts#reconcilePlanned exactly: handles the case where
 * the start handler's synchronous submitNicCreation call never landed (a
 * process crash/restart before the row's first post-ARM persist). Checks
 * whether the NIC actually exists in Azure:
 *   - NIC found -> the ARM submission succeeded; resume into nic_creating
 *     (create_nic marked succeeded).
 *   - NIC not found AND the row is still fresh (< RECONCILE_GRACE_MINUTES
 *     old) -> null (the start handler's own synchronous call may simply
 *     still be in flight).
 *   - NIC not found AND the row is old enough -> fail with honest guidance.
 */
export async function reconcilePlanned(record: SessionHostProvisionEntity, now: Date = new Date()): Promise<AdvanceResult | null> {
  const { resourceGroups } = getConfig();
  const network = getNetworkClient();
  let nicExists = true;
  try {
    await network.networkInterfaces.get(resourceGroups.hostPools, record.nicName);
  } catch (error) {
    if (!isNotFoundError(error)) throw error;
    nicExists = false;
  }

  if (nicExists) {
    const steps = withStepStatus(parseSteps(record), 'create_nic', { status: 'succeeded' }, now);
    return { nextState: 'nic_creating', steps };
  }

  const ageMinutes = (now.getTime() - new Date(record.createdAt).getTime()) / 60_000;
  if (ageMinutes < RECONCILE_GRACE_MINUTES) {
    return null;
  }

  return {
    nextState: 'failed',
    steps: parseSteps(record),
    errorMessage: `This provision never confirmed its network interface was submitted to Azure (no durable record, and ${record.nicName} does not exist ${RECONCILE_GRACE_MINUTES}+ minutes after the provision was created). Start a new provision with this session host name once you've confirmed nothing was left behind.`,
  };
}

/**
 * nic_creating -> vm_creating. Reached via two edge cases only (the normal
 * happy path never persists 'nic_creating' as an observed state — the start
 * handler goes straight from a fresh 'planned' row to persisting
 * 'vm_creating' once BOTH the NIC (pollUntilDone) and the VM submit
 * (submitted()) succeed within the same request):
 *   1. reconcilePlanned resumed here (crash before the first persist) —
 *      create_vm is still 'pending' (never attempted).
 *   2. submitVmCreation failed AFTER the NIC succeeded (PartialProvisionVmSubmissionError)
 *      — create_vm is 'failed' with an error attached.
 *
 * Checks whether the VM actually exists despite either gap:
 *   - VM found -> resume into vm_creating (create_vm marked in_progress,
 *     clearing any stale error) — ARM sometimes accepts a request that then
 *     fails to return cleanly, same rationale as
 *     imageBuildOrchestrator.ts#reconcilePlanned.
 *   - VM not found, case 2 (create_vm already 'failed') -> this is
 *     UNRESUMABLE: the freshly-generated admin password shown to the
 *     operator lived only in that one request's memory and can never be
 *     safely regenerated (a different value would not match what was
 *     shown) — fail immediately, honestly, rather than waiting out a grace
 *     period that can never resolve in this app's favor.
 *   - VM not found, case 1 (create_vm still 'pending') -> apply the same
 *     grace-period pattern as reconcilePlanned, keyed off `record.updatedAt`
 *     (when this row entered nic_creating) — the VM was never even
 *     attempted in this crash scenario, so once the grace period elapses
 *     this fails with the SAME "cannot retry automatically" guidance as
 *     case 2, since there is still no password to retry with.
 */
export async function pollNicCreating(record: SessionHostProvisionEntity, now: Date = new Date()): Promise<AdvanceResult | null> {
  const { resourceGroups } = getConfig();
  const compute = getComputeClient();
  let steps = parseSteps(record);
  let vmExists = true;
  try {
    await compute.virtualMachines.get(resourceGroups.hostPools, record.vmName);
  } catch (error) {
    if (!isNotFoundError(error)) throw error;
    vmExists = false;
  }

  if (vmExists) {
    steps = withStepStatus(steps, 'create_vm', { status: 'in_progress', error: undefined }, now);
    return { nextState: 'vm_creating', steps };
  }

  const createVmStatus = stepStatus(steps, 'create_vm');
  const unresumableMessage =
    `The network interface (${record.nicName}) was created, but the session host VM (${record.vmName}) was never confirmed created and this provision cannot safely retry — ` +
    `the generated admin password shown (if any) lived only in the original request and cannot be regenerated to match it. Delete the leftover network interface if you no longer need it, then start a new provision with this session host name.`;

  if (createVmStatus === 'failed') {
    return { nextState: 'failed', steps, errorMessage: unresumableMessage };
  }

  const ageMinutes = (now.getTime() - new Date(record.updatedAt).getTime()) / 60_000;
  if (ageMinutes < RECONCILE_GRACE_MINUTES) {
    return null;
  }
  return { nextState: 'failed', steps, errorMessage: unresumableMessage };
}

/** vm_creating -> ext_entra_join once the VM's own provisioningState reads Succeeded; -> failed on Failed, a 404 (the VM vanished out-of-band), or an exhausted attempt ceiling. Mirrors imageBuildOrchestrator.ts#pollVmCreating. */
export async function pollVmCreating(record: SessionHostProvisionEntity, now: Date = new Date()): Promise<AdvanceResult | null> {
  const { resourceGroups } = getConfig();
  const compute = getComputeClient();
  let steps = parseSteps(record);

  let vm;
  try {
    vm = await compute.virtualMachines.get(resourceGroups.hostPools, record.vmName);
  } catch (error) {
    if (isNotFoundError(error)) {
      steps = withStepStatus(steps, 'create_vm', { status: 'failed', error: 'Session host VM no longer exists in Azure.' }, now);
      return { nextState: 'failed', steps, errorMessage: `Session host VM ${record.vmName} was deleted out-of-band while still provisioning.` };
    }
    throw error;
  }

  if (vm.provisioningState === 'Succeeded') {
    steps = withStepStatus(steps, 'create_vm', { status: 'succeeded' }, now);
    return { nextState: 'ext_entra_join', steps };
  }
  if (vm.provisioningState === 'Failed') {
    steps = withStepStatus(steps, 'create_vm', { status: 'failed', error: 'VM provisioning failed.' }, now);
    return { nextState: 'failed', steps, errorMessage: `Session host VM ${record.vmName} provisioning failed.` };
  }

  const { steps: bumped, exceeded } = bumpAttempts(steps, 'create_vm', now);
  if (exceeded) {
    const failedSteps = withStepStatus(bumped, 'create_vm', { status: 'failed', error: 'Exceeded maximum poll attempts.' }, now);
    return { nextState: 'failed', steps: failedSteps, errorMessage: `Session host VM ${record.vmName} did not finish provisioning within the maximum poll attempts — check it directly in Azure.` };
  }
  return { nextState: 'vm_creating', steps: bumped };
}

/**
 * Shared driver for all three VM extensions (ext_entra_join,
 * ext_guest_attestation, ext_dsc) — see this module's header comment for
 * why one parameterized function, not three bespoke ones. Two-phase
 * persist-before-submit discipline (mirrors
 * imageBuildOrchestrator.ts#submitSysprepIfNeeded's phase 1/2 split):
 *   1. step status 'pending' -> mark 'in_progress' and return WITHOUT
 *      calling ARM at all — the timer persists this marker on its OWN tick,
 *      so a crash between phase 1 and phase 2 leaves an honest "about to
 *      submit" record.
 *   2. step status 'in_progress' -> a fresh `virtualMachineExtensions.get`
 *      decides what to do: a 404 means never (successfully) submitted ->
 *      submit now (poller.submitted() only) and self-transition (submitted,
 *      not yet confirmed); found with provisioningState Succeeded/Failed ->
 *      resolve the step; found still provisioning -> bump attempts and
 *      self-transition. Every branch is derived entirely from a fresh ARM
 *      read, never from in-memory state — resumable by construction.
 *
 * `resolveProtectedSettings`, when supplied (the ext_dsc step only), is
 * called ONLY at the moment of the actual submit (never during the phase-1
 * marker tick) — see submitDscExtension below for the DSC-specific case
 * (a fresh registration token generated right there, never persisted).
 */
async function advanceExtension(
  record: SessionHostProvisionEntity,
  plan: SessionHostProvisionPlan,
  stepId: SessionHostProvisionStepId,
  nextStateOnSuccess: SessionHostProvisionState,
  now: Date,
  resolveProtectedSettings?: () => Promise<Record<string, unknown> | undefined>,
): Promise<AdvanceResult> {
  const { resourceGroups } = getConfig();
  const compute = getComputeClient();
  let steps = parseSteps(record);
  const status = stepStatus(steps, stepId);
  const planStep = getPlanStep(plan, stepId);
  const vmExtensionName = planStep.resourceName;

  if (status === 'succeeded') {
    return { nextState: nextStateOnSuccess, steps }; // idempotent resume after a restart.
  }
  if (status === 'pending') {
    const marked = withStepStatus(steps, stepId, { status: 'in_progress' }, now);
    return { nextState: record.state, steps: marked };
  }

  let existing: { provisioningState?: string } | undefined;
  try {
    existing = await compute.virtualMachineExtensions.get(resourceGroups.hostPools, record.vmName, vmExtensionName);
  } catch (error) {
    if (!isNotFoundError(error)) throw error;
    existing = undefined;
  }

  if (!existing) {
    let parameters = planStep.parameters as Record<string, unknown>;
    if (resolveProtectedSettings) {
      const protectedSettings = await resolveProtectedSettings();
      parameters = { ...parameters, protectedSettings };
    }
    try {
      const poller = compute.virtualMachineExtensions.createOrUpdate(
        resourceGroups.hostPools,
        record.vmName,
        vmExtensionName,
        parameters as unknown as Parameters<typeof compute.virtualMachineExtensions.createOrUpdate>[3],
      );
      await poller.submitted();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const { steps: bumped, exceeded } = bumpAttempts(steps, stepId, now);
      if (exceeded) {
        const failedSteps = withStepStatus(bumped, stepId, { status: 'failed', error: `Exceeded maximum submission attempts. Last error: ${errorMessage}` }, now);
        return { nextState: 'failed', steps: failedSteps, errorMessage: `${vmExtensionName} extension submission against ${record.vmName} did not succeed within the maximum attempts — check it directly in Azure.` };
      }
      return { nextState: record.state, steps: withStepStatus(bumped, stepId, { error: errorMessage }, now) };
    }
    return { nextState: record.state, steps }; // self-transition — submitted, not yet confirmed.
  }

  if (existing.provisioningState === 'Succeeded') {
    steps = withStepStatus(steps, stepId, { status: 'succeeded' }, now);
    return { nextState: nextStateOnSuccess, steps };
  }
  if (existing.provisioningState === 'Failed') {
    steps = withStepStatus(steps, stepId, { status: 'failed', error: `${vmExtensionName} extension provisioning failed.` }, now);
    return { nextState: 'failed', steps, errorMessage: `${vmExtensionName} extension on ${record.vmName} provisioning failed.` };
  }

  const { steps: bumped, exceeded } = bumpAttempts(steps, stepId, now);
  if (exceeded) {
    const failedSteps = withStepStatus(bumped, stepId, { status: 'failed', error: 'Exceeded maximum poll attempts.' }, now);
    return { nextState: 'failed', steps: failedSteps, errorMessage: `${vmExtensionName} extension on ${record.vmName} did not finish provisioning within the maximum poll attempts — check it directly in Azure.` };
  }
  return { nextState: record.state, steps: bumped };
}

/** ext_entra_join -> ext_guest_attestation once AADLoginForWindows reports Succeeded. */
export async function pollEntraJoinExtension(record: SessionHostProvisionEntity, plan: SessionHostProvisionPlan, now: Date = new Date()): Promise<AdvanceResult> {
  return advanceExtension(record, plan, 'ext_entra_join', 'ext_guest_attestation', now);
}

/** ext_guest_attestation -> ext_dsc once GuestAttestation reports Succeeded. Only ever called while the row is at 'ext_guest_attestation' — i.e. only after ext_entra_join has already succeeded — so extension ORDER is enforced structurally by the state machine's own transition table, not by an extra runtime check here. */
export async function pollGuestAttestationExtension(record: SessionHostProvisionEntity, plan: SessionHostProvisionPlan, now: Date = new Date()): Promise<AdvanceResult> {
  return advanceExtension(record, plan, 'ext_guest_attestation', 'ext_dsc', now);
}

/**
 * ext_dsc -> awaiting_registration once Microsoft.PowerShell.DSC reports
 * Succeeded. THE TOKEN: generated FRESH via
 * avdService.ts#generateRegistrationToken at the exact moment this
 * function actually submits the extension (never before, never cached,
 * never returned from this function) — passed straight into
 * protectedSettings.properties.registrationInfoToken and immediately
 * discarded from this call's own scope once the submit call returns. The
 * existing `hostpool.registrationtoken.generate` audit action covers the
 * generation event itself (same action id
 * hostPoolRegistrationToken.ts's operator-initiated generate route writes)
 * — `logger`, when supplied, lets this write that audit row; a caller with
 * no logger (e.g. a unit test calling this directly) still gets full
 * extension behavior, just without the audit side effect — mirrors
 * imageBuildOrchestrator.ts#pollCleanup's optional `logger` parameter.
 */
export async function pollDscExtension(record: SessionHostProvisionEntity, plan: SessionHostProvisionPlan, now: Date = new Date(), logger?: AuditLogger): Promise<AdvanceResult> {
  return advanceExtension(record, plan, 'ext_dsc', 'awaiting_registration', now, async () => {
    const tokenResult = await generateRegistrationToken(record.hostPoolName, DSC_TOKEN_HOURS_VALID);
    if (logger) {
      const correlationId = randomUUID();
      await writeAuditEntry(
        {
          actor: 'system:sessionhost-provision-timer',
          actorId: 'system',
          action: 'hostpool.registrationtoken.generate',
          target: record.hostPoolName,
          // NEVER include the token value here — see this function's doc
          // comment and hostPoolRegistrationToken.ts's own audit call for
          // the same rule.
          parameters: { hoursValid: DSC_TOKEN_HOURS_VALID, expirationTime: tokenResult.expirationTime, provisionId: record.provisionId, sessionHostName: record.sessionHostName },
          outcome: 'success',
          correlationId,
        },
        logger,
      ).catch(() => undefined);
    }
    return { properties: { registrationInfoToken: tokenResult.token } };
  });
}

/**
 * awaiting_registration -> done once the session host appears in
 * `sessionHosts.list` under this name (case-insensitive), with ANY status —
 * per this story's acceptance criterion, an agent that never registers
 * fails the provision honestly once the per-step ceiling is hit, same
 * "bounded, not infinite" contract as every other polled step.
 * `resolvePowerState: false` — this check only needs the host's NAME to
 * appear, not its power state, so skip the extra ARM read
 * listSessionHosts would otherwise make per host.
 */
export async function pollAwaitingRegistration(record: SessionHostProvisionEntity, now: Date = new Date()): Promise<AdvanceResult> {
  let steps = parseSteps(record);
  const status = stepStatus(steps, 'await_registration');
  if (status === 'pending') {
    steps = withStepStatus(steps, 'await_registration', { status: 'in_progress' }, now);
    return { nextState: 'awaiting_registration', steps };
  }

  const hosts = await listSessionHosts(record.hostPoolName, { resolvePowerState: false });
  const match = hosts.find((host) => host.name.toLowerCase() === record.vmName.toLowerCase());
  if (match) {
    steps = withStepStatus(steps, 'await_registration', { status: 'succeeded' }, now);
    return { nextState: 'done', steps };
  }

  const { steps: bumped, exceeded } = bumpAttempts(steps, 'await_registration', now);
  if (exceeded) {
    const failedSteps = withStepStatus(bumped, 'await_registration', { status: 'failed', error: 'Exceeded maximum poll attempts.' }, now);
    return { nextState: 'failed', steps: failedSteps, errorMessage: `${record.vmName} never appeared registered in host pool ${record.hostPoolName} within the maximum poll attempts — check the VM and AVD agent directly.` };
  }
  return { nextState: 'awaiting_registration', steps: bumped };
}

/** Regenerates the frozen plan from a persisted record's OWN planContextJson/planParamsJson — never live config — mirrors imageBuildTimer.ts#regeneratePlanFromFrozenBasis. Exported so both the timer and tests share one implementation. */
export function regeneratePlanFromFrozenBasis(record: Pick<SessionHostProvisionEntity, 'planContextJson' | 'planParamsJson' | 'sessionHostName'>): SessionHostProvisionPlan {
  const planContext = JSON.parse(record.planContextJson) as SessionHostProvisionPlanContext;
  const planParams = JSON.parse(record.planParamsJson) as { sessionHostName: string; zone: '1' | '2' | '3'; vmSize?: string; imageVersion?: string };
  return generateSessionHostProvisionPlan(planParams, planContext);
}
