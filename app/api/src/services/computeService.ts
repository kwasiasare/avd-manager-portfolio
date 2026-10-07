import type { PowerState, SessionHostPowerAction } from '@avdmgr/shared';
import { getComputeClient } from '../lib/computeClient';
import { FSLOGIX_CONFIG_CHECK_RUN_COMMAND_NAME, FSLOGIX_CONFIG_CHECK_SCRIPT, FSLOGIX_CONFIG_CHECK_TIMEOUT_SECONDS } from '../lib/fslogixConfigCheck';

/**
 * Matches a full `/subscriptions/{sub}/resourceGroups/{rg}/providers/
 * Microsoft.Compute/virtualMachines/{name}` resource ID, case-insensitively.
 * Anchored at the start (`^`) — every ARM resource ID starts with
 * `/subscriptions/{id}`, so this also rejects a resourceId missing that
 * prefix rather than silently matching a suffix of some other string.
 * Captures the subscription id (AM-19 peer review item 4) so callers that
 * care about cross-subscription safety — see resolveSessionHostVm in
 * avdService.ts — can compare it against the configured subscription rather
 * than blindly trusting a same-named resource group + VM name pairing.
 */
const VM_RESOURCE_ID_PATTERN = /^\/subscriptions\/([^/]+)\/resourceGroups\/([^/]+)\/providers\/Microsoft\.Compute\/virtualMachines\/([^/]+)$/i;

export interface ParsedVmResourceId {
  subscriptionId: string;
  resourceGroup: string;
  vmName: string;
}

/**
 * Parses a session host's `resourceId` (ARM resource ID of its underlying
 * VM) into subscription id + resource group + VM name. Returns null if the
 * resourceId isn't a well-formed Microsoft.Compute/virtualMachines ID (e.g.
 * host not yet fully registered) rather than throwing — callers should
 * treat that as "power state unavailable"/"VM unresolvable", not a hard
 * failure of the whole request. Deliberately does NOT itself compare
 * subscriptionId against getConfig() — this function stays a pure regex
 * parse with no config dependency (easy to unit test in isolation); the
 * subscription-match enforcement lives in the one caller that needs it
 * (avdService.ts#resolveSessionHostVm), since a read-only power-state
 * lookup (resolvePowerState) has no need to fail hard on a hypothetical
 * cross-subscription VM the way a WRITE action does.
 */
export function parseVmResourceId(resourceId: string | undefined): ParsedVmResourceId | null {
  if (!resourceId) {
    return null;
  }
  const match = VM_RESOURCE_ID_PATTERN.exec(resourceId);
  if (!match) {
    return null;
  }
  return { subscriptionId: match[1], resourceGroup: match[2], vmName: match[3] };
}

/**
 * Maps an instanceView status code like "PowerState/running" to this app's
 * condensed PowerState union. Unrecognised/missing codes fall back to
 * 'unknown' rather than being guessed at.
 */
function mapPowerStateCode(code: string | undefined): PowerState {
  const suffix = code?.startsWith('PowerState/') ? code.slice('PowerState/'.length) : undefined;
  switch (suffix) {
    case 'running':
      return 'running';
    case 'starting':
      return 'starting';
    case 'stopping':
      return 'stopping';
    case 'stopped':
      return 'stopped';
    case 'deallocating':
      return 'deallocating';
    case 'deallocated':
      return 'deallocated';
    default:
      return 'unknown';
  }
}

/**
 * Resolves the power state of a single VM via its instanceView. Never
 * throws on a per-VM lookup failure (e.g. VM deleted out-of-band, transient
 * ARM error) — logs would be handled by the caller, which should catch and
 * fall back to 'unknown' so one bad host doesn't 502 the whole
 * sessionhosts list.
 */
export async function getVmPowerState(resourceGroup: string, vmName: string): Promise<PowerState> {
  const client = getComputeClient();
  const instanceView = await client.virtualMachines.instanceView(resourceGroup, vmName);
  const statusCode = instanceView.statuses?.find((status) => status.code?.startsWith('PowerState/'))?.code;
  return mapPowerStateCode(statusCode);
}

/**
 * The subset of `@azure/arm-compute`'s `ImageReference` this app needs for
 * AM-26's host-to-version correlation (imagesService.ts#correlateHostsToVersions)
 * — deliberately narrower than the SDK type so callers don't need to import
 * `@azure/arm-compute` types themselves.
 */
export interface VmImageReferenceInfo {
  /** The imageReference's own `id` (it extends SubResource) — a specific gallery IMAGE VERSION id, a gallery IMAGE DEFINITION id (pinned to "latest" at deploy time), a marketplace/custom image id, or undefined. */
  id?: string;
  /**
   * ARM's own record of "the actual version in use" (verified against this
   * repo's installed @azure/arm-compute@25: `ImageReference.exactVersion`,
   * readonly) — populated when `id` names a DEFINITION (no /versions/
   * segment, i.e. pinned to "latest") and ARM resolved that to a concrete
   * version at some point. AM-26 peer review MAJOR 2: an earlier version of
   * this app's doc comments incorrectly claimed "Azure does not retain
   * which concrete version was actually deployed" for the latest-pinned
   * case — exactVersion is precisely the field that CAN retain it. Still
   * undefined in some cases (e.g. the SDK/API version in use didn't
   * populate it, or `id` already names a specific version so there's
   * nothing to resolve) — callers must treat it as best-effort, not
   * guaranteed.
   */
  exactVersion?: string;
  /** Set when the VM instead references a SHARED gallery image — a DIFFERENT gallery mechanism from this app's private `id`-addressed gallery, so it can never correlate to a version of the configured definition even though it's still "gallery-image-sourced" in a general sense. */
  sharedGalleryImageId?: string;
  /** Set when the VM instead references a COMMUNITY gallery image — same distinction as sharedGalleryImageId. */
  communityGalleryImageId?: string;
}

/**
 * Resolves a single VM's gallery-image source — verified against this
 * repo's installed @azure/arm-compute@25: VirtualMachine.storageProfile?:
 * StorageProfile, StorageProfile.imageReference?: ImageReference — a plain
 * `Microsoft.Compute/virtualMachines/{name}` GET (client.virtualMachines.
 * get), NOT instanceView (which covers power state only, not
 * storageProfile).
 *
 * Used by AM-26's GET /v1/images/versions to correlate session hosts to the
 * gallery image version their VM was created from — see
 * imagesService.ts#correlateHostsToVersions for how the returned fields are
 * interpreted (including the exactVersion/sharedGalleryImageId/
 * communityGalleryImageId fields — see VmImageReferenceInfo's doc
 * comments). Returns undefined (never throws) when the VM has no
 * imageReference at all (e.g. created from a managed/custom image with no
 * gallery, or an unmanaged disk) — that is a normal, expected shape, not an
 * error. A genuine ARM failure (VM not found, transient error) DOES throw;
 * per-host degradation to "unknown source" is the caller's responsibility,
 * same convention as computeService.getVmPowerState / avdService.
 * resolvePowerState.
 */
export async function getVmImageReference(resourceGroup: string, vmName: string): Promise<VmImageReferenceInfo | undefined> {
  const client = getComputeClient();
  const vm = await client.virtualMachines.get(resourceGroup, vmName);
  const ref = vm.storageProfile?.imageReference;
  if (!ref) {
    return undefined;
  }
  return { id: ref.id, exactVersion: ref.exactVersion, sharedGalleryImageId: ref.sharedGalleryImageId, communityGalleryImageId: ref.communityGalleryImageId };
}

/**
 * Milliseconds allowed for the INITIAL ARM request (the POST that submits
 * the start/restart/deallocate) before it's aborted — see
 * beginVmPowerAction's `abortSignal` param. This bounds only that first
 * request, not the VM operation itself (see that function's doc comment for
 * why the operation is never awaited to completion). 20s is generous for a
 * synchronous ARM accept/reject while still comfortably inside a Flex
 * Consumption invocation's own timeout.
 */
const DEFAULT_SUBMIT_TIMEOUT_MS = 20_000;

/**
 * Begins (but deliberately does NOT wait for) a VM start/restart/deallocate
 * against `@azure/arm-compute`'s long-running operation methods. Used by
 * POST /v1/hostpools/{hostPoolName}/sessionhosts/{sessionHostName}/power
 * (app/api/src/functions/sessionHostPower.ts).
 *
 * ASYNC/POLLER DESIGN (AM-19 decision — read before changing this):
 *
 * `client.virtualMachines.start/restart/deallocate(...)` each return a
 * `PollerLike` SYNCHRONOUSLY. Constructing that poller already fires the
 * initial ARM request in the background (verified against this repo's
 * installed @azure/arm-compute@25 — `VirtualMachinesOperations.start` calls
 * `getLongRunningPoller`, whose `statePromise` kicks off `sendInitialRequest`
 * immediately, not lazily on first `.poll()`). The full VM operation itself
 * (actually reaching "running"/"deallocated") can take anywhere from ~10s to
 * several minutes — far longer than is safe to hold open inside a Flex
 * Consumption function invocation (which has its own execution timeout, and
 * ties up the caller's HTTP request the whole time for no benefit: the UI
 * already re-polls GET .../sessionhosts on its own schedule to observe the
 * eventual power state).
 *
 * So this function awaits ONLY `poller.submitted()` — the promise that
 * resolves once ARM has ACCEPTED the request (i.e. the initial POST
 * returned 202/200/201) and rejects if ARM rejected it outright (e.g. 404
 * VM not found, 409 conflicting operation, 403 authorization). It
 * deliberately never calls `poller.pollUntilDone()` or awaits the poller
 * itself (its `.then` would do the same). This is the "begin + 202
 * Accepted, poller not awaited" design named in AM-19: the caller (the
 * Function handler) gets a fast, correctly-erroring response for anything
 * ARM rejects synchronously, without blocking on however long the VM
 * transition actually takes. See @avdmgr/shared's SessionHostPowerResponse
 * doc comment for the response contract this implies.
 *
 * The `abortSignal` (default: DEFAULT_SUBMIT_TIMEOUT_MS) is passed through
 * to the SDK's `VirtualMachines{Start,Restart,Deallocate}OptionalParams`
 * (each extends `@azure-rest/core-client`'s `OperationOptions`, which
 * declares `abortSignal?: AbortSignalLike` — verified against this repo's
 * installed @azure-rest/core-client: `operationOptionsToRequestParameters`
 * forwards `options.abortSignal` straight onto the underlying HTTP request
 * parameters). This bounds only the INITIAL POST this function awaits — it
 * has no effect on the VM operation's own progress, which this function
 * never observes.
 */
export async function beginVmPowerAction(
  resourceGroup: string,
  vmName: string,
  action: SessionHostPowerAction,
  options: { abortSignal?: AbortSignal } = {},
): Promise<void> {
  const client = getComputeClient();
  const { abortSignal = AbortSignal.timeout(DEFAULT_SUBMIT_TIMEOUT_MS) } = options;
  const poller =
    action === 'start'
      ? client.virtualMachines.start(resourceGroup, vmName, { abortSignal })
      : action === 'restart'
        ? client.virtualMachines.restart(resourceGroup, vmName, { abortSignal })
        : client.virtualMachines.deallocate(resourceGroup, vmName, { abortSignal });

  await poller.submitted();
}

/**
 * AM-28 (M4-S3): begins (but deliberately does NOT wait for) a VM delete
 * against @azure/arm-compute's `virtualMachines.delete`, used by the staged
 * rollout's host-removal step (app/api/src/functions/rolloutPlans.ts's
 * remove-hosts handler). Confirmed on Microsoft Learn
 * (https://learn.microsoft.com/javascript/api/@azure/arm-compute/virtualmachinesoperations —
 * "delete") that, like start/restart/deallocate above, this returns a
 * `PollerLike<OperationState<void>, void>` SYNCHRONOUSLY (the same
 * "construction already fires the initial request" behavior documented on
 * beginVmPowerAction) — so this function follows the exact same
 * submitted()-only design for the exact same reason: a VM delete's full
 * completion can take minutes, far longer than is safe to hold open inside a
 * Flex Consumption invocation, and the caller only needs to know ARM
 * ACCEPTED the delete request, not that it has finished (the caller re-polls
 * GET .../sessionhosts / az vm list-style checks afterward to observe
 * completion — see rolloutPlans.ts's remove-hosts handler).
 *
 * `forceDeletion` is deliberately left at its SDK default (undefined/false):
 * this is called only AFTER the removal handler's hard zero-sessions gate
 * and an explicit deallocate submission (see remove-hosts' doc comment), so
 * a graceful delete is expected to succeed without needing the force-delete
 * escape hatch — surfacing that as its own opt-in would widen this
 * function's blast radius for no story-scoped benefit.
 */
export async function beginVmDelete(resourceGroup: string, vmName: string, options: { abortSignal?: AbortSignal } = {}): Promise<void> {
  const client = getComputeClient();
  const { abortSignal = AbortSignal.timeout(DEFAULT_SUBMIT_TIMEOUT_MS) } = options;
  const poller = client.virtualMachines.delete(resourceGroup, vmName, { abortSignal });
  await poller.submitted();
}

/**
 * AM-47: submits (Run Command v2 create-or-update, SUBMIT-ONLY — same
 * "await poller.submitted(), never pollUntilDone()" discipline as
 * beginVmPowerAction/beginVmDelete above) the FSLogix config-convergence
 * check script against one session host VM.
 *
 * VERIFIED against this repo's installed @azure/arm-compute@25:
 * `VirtualMachineRunCommandsOperations.createOrUpdate` (the NON-deprecated
 * member of the `virtualMachineRunCommands` classic client surface — its
 * sibling `beginCreateOrUpdate` is marked `@deprecated use createOrUpdate
 * instead` in this SDK version) returns a `PollerLike` SYNCHRONOUSLY, the
 * exact same shape `virtualMachines.delete`/`start`/`restart`/`deallocate`
 * do — so this function follows their identical "submitted-only" pattern
 * rather than the plan's original `beginCreateOrUpdate` + `await
 * poller.submitted()` guess, which targeted the deprecated (and
 * differently-shaped — it resolves a `Promise<SimplePollerLike>`) member.
 *
 * `Microsoft.Compute/virtualMachines/runCommands` (the v2, child-resource
 * form) is used specifically because its result survives to be read back
 * by a LATER, independent GET (see getFslogixConfigCheckResult below) —
 * unlike the classic `virtualMachines.runCommand` action, whose output is
 * only ever obtainable from the SAME poller that submitted it, which
 * cannot survive across this app's submit-in-an-HTTP-handler /
 * poll-in-a-later-timer-tick split (see rolloutPlans.ts's verify-config
 * action and rolloutPlanTimer.ts's validating_new poll).
 *
 * Reads the VM's own `location` first via `virtualMachines.get` — required
 * on the `VirtualMachineRunCommand` payload (it extends `TrackedResource`,
 * which mandates `location: string`) and must match the parent VM's own
 * region. Same one-GET-then-act shape as getVmImageReference above.
 *
 * Reusing FSLOGIX_CONFIG_CHECK_RUN_COMMAND_NAME on every call is
 * deliberate — createOrUpdate is idempotent by name, so re-running the
 * check on an already-checked host overwrites its own prior run command
 * child resource rather than accumulating one per attempt.
 */
export async function submitFslogixConfigCheck(resourceGroup: string, vmName: string, options: { abortSignal?: AbortSignal } = {}): Promise<void> {
  const client = getComputeClient();
  const { abortSignal = AbortSignal.timeout(DEFAULT_SUBMIT_TIMEOUT_MS) } = options;
  const vm = await client.virtualMachines.get(resourceGroup, vmName);
  const poller = client.virtualMachineRunCommands.createOrUpdate(
    resourceGroup,
    vmName,
    FSLOGIX_CONFIG_CHECK_RUN_COMMAND_NAME,
    {
      location: vm.location,
      source: { script: FSLOGIX_CONFIG_CHECK_SCRIPT },
      timeoutInSeconds: FSLOGIX_CONFIG_CHECK_TIMEOUT_SECONDS,
      asyncExecution: false,
    },
    { abortSignal },
  );
  await poller.submitted();
}

/** The subset of `@azure/arm-compute`'s `VirtualMachineRunCommandInstanceView` the timer's poll needs — narrower than the SDK type for the same "callers don't need to import @azure/arm-compute types" reason as VmImageReferenceInfo above. `endTime` (Fable review fix) lets the poll reject a STALE terminal result: after a re-submitted check, the child resource's GET can briefly keep reporting the PREVIOUS execution's terminal instanceView until the new execution starts — a terminal result whose endTime predates the current check's submittedAt belongs to the prior run, not this one. */
export interface FslogixConfigCheckInstanceView {
  executionState?: string;
  exitCode?: number;
  output?: string;
  error?: string;
  endTime?: Date;
}

/**
 * AM-47: reads back the FSLogix config check's Run Command v2 result — a
 * PLAIN GET (`virtualMachineRunCommands.getByVirtualMachine` with `expand:
 * 'instanceView'`), never a mutation, so calling this from
 * rolloutPlanTimer.ts's validating_new poll does not violate that timer's
 * documented read-only-against-ARM invariant (see that file's header
 * comment). Propagates a genuine ARM failure (including a 404 if the run
 * command child resource does not exist yet, e.g. this GET raced the
 * submit) rather than swallowing it — the timer's own per-host try/catch
 * (mirroring its existing imageVerified failure posture) is what decides
 * to leave a host's prior configCheck value untouched on a transient
 * failure like this.
 */
export async function getFslogixConfigCheckResult(resourceGroup: string, vmName: string): Promise<FslogixConfigCheckInstanceView | undefined> {
  const client = getComputeClient();
  const result = await client.virtualMachineRunCommands.getByVirtualMachine(resourceGroup, vmName, FSLOGIX_CONFIG_CHECK_RUN_COMMAND_NAME, { expand: 'instanceView' });
  return result.instanceView;
}
