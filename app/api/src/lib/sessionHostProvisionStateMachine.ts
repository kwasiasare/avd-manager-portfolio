import { SESSION_HOST_PROVISION_TERMINAL_STATES, type SessionHostProvisionState } from '@avdmgr/shared';

/**
 * AM-50 — the pure state-transition table for the session-host provisioning
 * state machine. Deliberately mirrors app/api/src/lib/imageBuildStateMachine.ts
 * exactly in shape (same "ZERO dependency on Azure SDKs, Table storage, or
 * process.env — every function here is a plain, synchronously-testable pure
 * function" rationale — see that file's header comment) — the two are
 * DIFFERENT workflows, not variations of one, but this codebase already
 * solved "a hand-rolled, resumable, Table-backed state machine driven by a
 * 1-minute timer" once, and there is no reason to re-derive that shape from
 * scratch here.
 *
 * UNLIKE imageBuildStateMachine.ts, this workflow has NO operator-gated
 * states at all (no OPERATOR_GATED_STATES export) — see @avdmgr/shared's
 * SessionHostProvisionState doc comment: applying a VM's three extensions in
 * order has no equivalent of the image build's irreversible-Sysprep hard
 * stop or "operator validates a test host" checkpoint, so the whole pipeline
 * from `planned` to `done` runs unattended once submitted. The only
 * operator-initiated actions are POST .../provisions (start) and
 * POST .../provisions/{id}/cancel.
 *
 * Every forward edge below corresponds 1:1 to a step in
 * app/api/src/lib/sessionHostProvisionPlan.ts's generated plan — changing
 * one without the other is a bug, not a style choice; the two are
 * cross-checked in sessionHostProvisionPlan.test.ts.
 */
const TRANSITIONS: Record<SessionHostProvisionState, readonly SessionHostProvisionState[]> = {
  // planned -> nic_creating happens SYNCHRONOUSLY inside the POST
  // .../provisions handler on the happy path (submitting the NIC create is
  // the first thing a real, non-dry-run start does). It can ALSO happen via
  // the timer's reconcilePlanned (see TIMER_DRIVEN_STATES below) if that
  // synchronous write never landed — same "planned is timer-visible, not a
  // stranded state" rationale as imageBuildStateMachine.ts's own doc comment
  // on this exact edge.
  planned: ['nic_creating', 'failed', 'cancelled'],
  nic_creating: ['vm_creating', 'failed', 'cancelled'],
  vm_creating: ['ext_entra_join', 'failed', 'cancelled'],
  ext_entra_join: ['ext_guest_attestation', 'failed', 'cancelled'],
  ext_guest_attestation: ['ext_dsc', 'failed', 'cancelled'],
  ext_dsc: ['awaiting_registration', 'failed', 'cancelled'],
  awaiting_registration: ['done', 'failed', 'cancelled'],
  done: [],
  failed: [],
  cancelled: [],
};

/** Every state a provision can never leave — see @avdmgr/shared's SESSION_HOST_PROVISION_TERMINAL_STATES (re-exported here as a Set for O(1) membership checks). */
export const TERMINAL_STATES: ReadonlySet<SessionHostProvisionState> = new Set(SESSION_HOST_PROVISION_TERMINAL_STATES);

export function isTerminalState(state: SessionHostProvisionState): boolean {
  return TERMINAL_STATES.has(state);
}

/**
 * States the 1-minute timer polls in-flight Azure operations for and
 * advances on completion — every non-terminal state (see this file's header
 * comment: unlike imageBuildStateMachine.ts, there is no OPERATOR_GATED_STATES
 * subtraction here, since this workflow has none).
 *
 * `planned` IS included, same "stranded planned state" resumability
 * rationale as imageBuildStateMachine.ts's TIMER_DRIVEN_STATES doc comment —
 * see app/api/src/services/sessionHostProvisionOrchestrator.ts#reconcilePlanned.
 */
export const TIMER_DRIVEN_STATES: ReadonlySet<SessionHostProvisionState> = new Set([
  'planned',
  'nic_creating',
  'vm_creating',
  'ext_entra_join',
  'ext_guest_attestation',
  'ext_dsc',
  'awaiting_registration',
]);

/** True if `to` is a state `from` is permitted to transition into directly. */
export function canTransition(from: SessionHostProvisionState, to: SessionHostProvisionState): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Thrown by assertTransition — callers (the timer, the start/cancel handlers) catch this to turn it into a 409/500 rather than silently writing a corrupt state. */
export class IllegalSessionHostProvisionTransitionError extends Error {
  readonly from: SessionHostProvisionState;
  readonly to: SessionHostProvisionState;

  constructor(from: SessionHostProvisionState, to: SessionHostProvisionState) {
    super(`Illegal session host provision state transition: ${from} -> ${to}`);
    this.name = 'IllegalSessionHostProvisionTransitionError';
    this.from = from;
    this.to = to;
  }
}

/** Throws IllegalSessionHostProvisionTransitionError if `to` is not reachable from `from` — the enforcement counterpart to the boolean canTransition above. */
export function assertTransition(from: SessionHostProvisionState, to: SessionHostProvisionState): void {
  if (!canTransition(from, to)) {
    throw new IllegalSessionHostProvisionTransitionError(from, to);
  }
}
