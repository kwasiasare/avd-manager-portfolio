import { randomUUID } from 'node:crypto';
import { app, InvocationContext, Timer } from '@azure/functions';
import { writeAuditEntry, type AuditLogger } from '../lib/auditLog';
import { TIMER_DRIVEN_STATES, assertTransition } from '../lib/sessionHostProvisionStateMachine';
import {
  pollAwaitingRegistration,
  pollDscExtension,
  pollEntraJoinExtension,
  pollGuestAttestationExtension,
  pollNicCreating,
  pollVmCreating,
  reconcilePlanned,
  regeneratePlanFromFrozenBasis,
  type AdvanceResult,
} from '../services/sessionHostProvisionOrchestrator';
import { getSessionHostProvision, isPreconditionFailedError, listInFlightSessionHostProvisions, replaceSessionHostProvision, type SessionHostProvisionRecord } from '../services/sessionHostProvisionService';

/**
 * AM-50 — 1-minute timer that polls every in-flight guided session-host
 * provision's currently-waiting Azure operation (NIC/VM provisioning, each
 * of the three extensions in strict order, and the final host-pool
 * registration check) and advances the state machine when a step completes.
 * Mirrors app/api/src/functions/imageBuildTimer.ts's shape and cadence
 * exactly — see that file's header comment for the full "why 1 minute, why
 * resumable by construction" rationale, which applies unchanged here.
 *
 * UNLIKE imageBuildTimer.ts, there is no OPERATOR_GATED_STATES filter (this
 * workflow has none — see sessionHostProvisionStateMachine.ts's header
 * comment) and no abandonment-warning side check (a session-host provision
 * has no equivalent of a build VM parked indefinitely at an operator
 * gate — every non-terminal state here is actively being polled toward
 * completion or failure).
 */
export async function sessionHostProvisionTimer(_myTimer: Timer, context: InvocationContext): Promise<void> {
  const logger: AuditLogger = { warn: (m) => context.warn(m), error: (m) => context.error(m), log: (m) => context.log(m) };

  const provisions = await listInFlightSessionHostProvisions().catch((error) => {
    context.error('sessionHostProvisionTimer — failed to list in-flight provisions', error);
    return undefined;
  });
  if (!provisions) return;

  for (const provision of provisions) {
    if (!TIMER_DRIVEN_STATES.has(provision.state)) {
      continue; // defensive only — every non-terminal state is timer-driven in this workflow (see state machine's header comment).
    }
    await advanceOneProvision(provision, logger, context);
  }
}

async function advanceOneProvision(record: SessionHostProvisionRecord, logger: AuditLogger, context: InvocationContext): Promise<void> {
  const correlationId = randomUUID();
  try {
    const result = await computeAdvance(record, logger);
    if (!result) {
      return; // still waiting on Azure — nothing to persist this tick.
    }

    // Fresh read immediately before the write — same double-read race guard
    // rationale as imageBuildTimer.ts#advanceOneBuild: an operator action
    // (cancel) can land in the gap between listInFlightSessionHostProvisions
    // and this write.
    const fresh = await getSessionHostProvision(record.provisionId);
    if (!fresh || fresh.state !== record.state) {
      context.log(`sessionHostProvisionTimer — provision ${record.provisionId} changed since this tick started (now ${fresh?.state ?? 'not found'}) — skipping`);
      return;
    }

    // Self-transitions (progress WITHIN a state — a step's marker/attempt
    // count changing) are persisted unconditionally; only a genuine state
    // change is checked against the transition table — mirrors
    // imageBuildTimer.ts#advanceOneBuild's own BLOCKER-fix rationale
    // exactly (see that function's doc comment for the full incident this
    // guards against).
    if (result.nextState !== record.state) {
      assertTransition(record.state, result.nextState);
    }

    await replaceSessionHostProvision(
      {
        ...fresh,
        state: result.nextState,
        stepsJson: JSON.stringify(result.steps),
        errorMessage: result.errorMessage ?? fresh.errorMessage,
        updatedAt: new Date().toISOString(),
      },
      fresh.etag,
    );

    await writeAuditEntry(
      {
        actor: 'system:sessionhost-provision-timer',
        actorId: 'system',
        action: 'sessionhost.provision.timer_advance',
        target: record.provisionId,
        parameters: { provisionId: record.provisionId, sessionHostName: record.sessionHostName, from: record.state, to: result.nextState },
        outcome: result.nextState === 'failed' ? 'failure' : 'success',
        detail: result.errorMessage,
        correlationId,
      },
      logger,
    );
  } catch (error) {
    if (isPreconditionFailedError(error)) {
      context.log(`sessionHostProvisionTimer — ETag conflict advancing provision ${record.provisionId} (concurrent write) — will retry next tick`);
      return;
    }
    // Greppable marker + a failure-outcome audit row for any advance that
    // failed for a reason OTHER than an expected ETag race — mirrors
    // imageBuildTimer.ts's IMAGE_BUILD_STUCK marker (see infra/modules/
    // functionapp.bicep's ALERTING TODO list, which now also carries this
    // one as a deferred, not-yet-wired entry — see this story's own
    // ALERTING TODO addition).
    context.error(`SESSION_HOST_PROVISION_STUCK | provisionId=${record.provisionId} state=${record.state} correlationId=${correlationId}`, error);
    await writeAuditEntry(
      {
        actor: 'system:sessionhost-provision-timer',
        actorId: 'system',
        action: 'sessionhost.provision.timer_advance',
        target: record.provisionId,
        parameters: { provisionId: record.provisionId, sessionHostName: record.sessionHostName, from: record.state, to: record.state },
        outcome: 'failure',
        detail: error instanceof Error ? error.message : String(error),
        correlationId,
      },
      logger,
    ).catch(() => undefined);
  }
}

/** Dispatches to the right orchestrator poll function for the provision's current state. Extension/registration states regenerate the plan from the record's OWN frozen planContextJson/planParamsJson (never live config) — mirrors imageBuildTimer.ts#computeAdvance's regeneratePlanFromFrozenBasis call sites. `logger` is threaded into pollDscExtension only, so it can audit the DSC step's registration-token generation (see sessionHostProvisionOrchestrator.ts#pollDscExtension). */
async function computeAdvance(record: SessionHostProvisionRecord, logger: AuditLogger): Promise<AdvanceResult | null> {
  switch (record.state) {
    case 'planned':
      return reconcilePlanned(record);
    case 'nic_creating':
      return pollNicCreating(record);
    case 'vm_creating':
      return pollVmCreating(record);
    case 'ext_entra_join':
      return pollEntraJoinExtension(record, regeneratePlanFromFrozenBasis(record));
    case 'ext_guest_attestation':
      return pollGuestAttestationExtension(record, regeneratePlanFromFrozenBasis(record));
    case 'ext_dsc':
      return pollDscExtension(record, regeneratePlanFromFrozenBasis(record), new Date(), logger);
    case 'awaiting_registration':
      return pollAwaitingRegistration(record);
    default:
      return null;
  }
}

app.timer('sessionHostProvisionTimer', {
  schedule: '0 * * * * *',
  handler: sessionHostProvisionTimer,
});
