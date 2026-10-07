import { IMAGE_BUILD_OPERATOR_GATED_STATES, type ImageBuildState, type PowerState } from '@avdmgr/shared';

/**
 * AM-27 (M4-S2) — the pure state-transition table for the image-build state
 * machine (see @avdmgr/shared's imageBuild.ts for the full "why a Table
 * state machine, not Durable Functions" writeup). Deliberately has ZERO
 * dependency on Azure SDKs, Table storage, or process.env — every function
 * here is a plain, synchronously-testable pure function (see
 * imageBuildStateMachine.test.ts), mirroring
 * scalingOverrideService.ts#isOverrideExpired's "extracted so the decision
 * is unit-testable without mocking a client" rationale.
 *
 * Every forward edge below corresponds 1:1 to a step in
 * app/api/src/lib/imageBuildPlan.ts's generated plan (see that file) —
 * changing one without the other is a bug, not a style choice; the two are
 * cross-checked in imageBuildPlan.test.ts.
 */
const TRANSITIONS: Record<ImageBuildState, readonly ImageBuildState[]> = {
  // planned -> vm_creating happens SYNCHRONOUSLY inside the POST
  // /v1/images/builds handler on the happy path (submitting the VM create
  // call is the very first thing a real — non-dry-run — start does). It can
  // ALSO happen via the timer's reconcilePlanned (see TIMER_DRIVEN_STATES'
  // doc comment) if that synchronous write never landed — either path ends
  // at the same edge, so no separate transition is needed for it.
  planned: ['vm_creating', 'failed', 'cancelled'],
  vm_creating: ['vm_ready', 'failed', 'cancelled'],
  // vm_ready -> checklist_gate is an immediate, unconditional timer
  // advance (nothing further to poll once the VM create succeeded) — kept
  // as its own state anyway so "the VM finished provisioning" and "the
  // operator checklist is now open" are independently visible/auditable
  // rows, matching this story's state list.
  vm_ready: ['checklist_gate', 'failed', 'cancelled'],
  checklist_gate: ['snapshotting', 'failed', 'cancelled'],
  snapshotting: ['sysprep_running', 'failed', 'cancelled'],
  sysprep_running: ['awaiting_stopped', 'failed', 'cancelled'],
  awaiting_stopped: ['capturing', 'failed', 'cancelled'],
  capturing: ['test_host_step', 'failed', 'cancelled'],
  test_host_step: ['cleanup', 'failed', 'cancelled'],
  // No cancel once cleanup has started: the build VM/NIC/disk deletes are
  // already firing at that point, and "cancel" has no coherent meaning for
  // a build that has already produced its gallery image version (capturing
  // succeeded) and is only tearing down scaffolding.
  cleanup: ['done', 'failed'],
  done: [],
  failed: [],
  cancelled: [],
};

/** Every state a build can never leave — see @avdmgr/shared's IMAGE_BUILD_TERMINAL_STATES (re-exported here as a Set for O(1) membership checks). */
export const TERMINAL_STATES: ReadonlySet<ImageBuildState> = new Set(['done', 'failed', 'cancelled']);

export function isTerminalState(state: ImageBuildState): boolean {
  return TERMINAL_STATES.has(state);
}

/**
 * States that can ONLY be advanced by an explicit operator action (POST
 * .../checklist then .../advance, or .../advance) — the 1-minute timer
 * (app/api/src/functions/imageBuildTimer.ts) must skip builds in these
 * states entirely, never attempt to auto-advance them.
 */
export const OPERATOR_GATED_STATES: ReadonlySet<ImageBuildState> = new Set(IMAGE_BUILD_OPERATOR_GATED_STATES);

/**
 * States the 1-minute timer polls in-flight Azure operations for and
 * advances on completion. Deliberately excludes the OPERATOR_GATED_STATES
 * above and every terminal state.
 *
 * `planned` IS included (Opus review BLOCKER 4 — "stranded planned state"):
 * the POST /v1/images/builds handler transitions planned -> vm_creating
 * SYNCHRONOUSLY on the happy path, but if the process crashes/restarts (or
 * the ARM submission genuinely fails) between creating the row and writing
 * that transition, a build could otherwise be stuck at 'planned' forever
 * with no timer ever looking at it — no state machine is "resumable by
 * construction" if one of its states is invisible to the resumer. See
 * imageBuildOrchestrator.ts#reconcilePlanned: it checks whether the build
 * VM actually exists in Azure (resume into vm_creating if so — the ARM
 * submission succeeded even though the row write didn't) or, once the row
 * is old enough with no evidence of a VM, marks the build failed with
 * honest guidance rather than polling forever.
 */
export const TIMER_DRIVEN_STATES: ReadonlySet<ImageBuildState> = new Set([
  'planned',
  'vm_creating',
  'vm_ready',
  'snapshotting',
  'sysprep_running',
  'awaiting_stopped',
  'capturing',
  'cleanup',
]);

/** True if `to` is a state `from` is permitted to transition into directly. */
export function canTransition(from: ImageBuildState, to: ImageBuildState): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Thrown by assertTransition — callers (the timer, the operator-action handlers) catch this to turn it into a 409/500 rather than silently writing a corrupt state. */
export class IllegalImageBuildTransitionError extends Error {
  readonly from: ImageBuildState;
  readonly to: ImageBuildState;

  constructor(from: ImageBuildState, to: ImageBuildState) {
    super(`Illegal image build state transition: ${from} -> ${to}`);
    this.name = 'IllegalImageBuildTransitionError';
    this.from = from;
    this.to = to;
  }
}

/** Throws IllegalImageBuildTransitionError if `to` is not reachable from `from` — the enforcement counterpart to the boolean canTransition above. */
export function assertTransition(from: ImageBuildState, to: ImageBuildState): void {
  if (!canTransition(from, to)) {
    throw new IllegalImageBuildTransitionError(from, to);
  }
}

/**
 * THE awaiting_stopped HARD GATE. Capture (gallery image version create
 * from the build VM) is refused unless the VM's power state is stopped OR
 * deallocated — verified against a FRESH instanceView read taken
 * IMMEDIATELY before the capture call (see
 * app/api/src/services/imageBuildOrchestrator.ts#tryCaptureImageVersion),
 * never trusted from the persisted build row's own state field. This
 * function is the pure predicate that read is checked against — kept
 * separate from the live ARM call so the gate logic itself (capture refused
 * while the VM is still running) is unit-testable without mocking
 * @azure/arm-compute (see imageBuildStateMachine.test.ts's "hard gate"
 * describe block).
 *
 * 'stopped' (in-guest shutdown, e.g. Sysprep's own `/shutdown` flag — see
 * The golden-image runbook §4.7) and 'deallocated' (after this
 * app's own ensure_deallocated step, or an operator-initiated deallocate)
 * are BOTH acceptable — Azure's galleryImageVersions create-from-VM call
 * itself only requires the VM not be running; this app's own
 * ensure_deallocated plan step (see imageBuildPlan.ts) additionally forces
 * a deallocate before generalize/capture regardless of which of the two
 * this predicate saw, so 'stopped' is a valid gate-pass, not a shortcut
 * that skips deallocation.
 */
export function isPoweredOffForCapture(powerState: PowerState): boolean {
  return powerState === 'stopped' || powerState === 'deallocated';
}
