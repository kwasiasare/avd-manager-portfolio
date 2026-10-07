import { randomUUID } from 'node:crypto';
import { app, InvocationContext, Timer } from '@azure/functions';
import { writeAuditEntry, type AuditLogger } from '../lib/auditLog';
import { getConfig } from '../lib/config';
import { generateImageBuildPlan, type ImageBuildPlanContext } from '../lib/imageBuildPlan';
import { OPERATOR_GATED_STATES, TIMER_DRIVEN_STATES, assertTransition } from '../lib/imageBuildStateMachine';
import {
  advanceVmReady,
  pollAwaitingStopped,
  pollCapturing,
  pollCleanup,
  pollSnapshotting,
  pollVmCreating,
  reconcilePlanned,
  submitSysprepIfNeeded,
  type AdvanceResult,
} from '../services/imageBuildOrchestrator';
import { getImageBuild, isPreconditionFailedError, listInFlightImageBuilds, replaceImageBuild, type ImageBuildRecord } from '../services/imageBuildService';

/**
 * AM-27 (M4-S2) — 1-minute timer that polls every in-flight Azure operation
 * a build is currently waiting on (VM provisioning, snapshot provisioning,
 * the Sysprep Run Command's acceptance, the awaiting_stopped power-state
 * HARD GATE, deallocate/generalize/capture, and the cleanup deletes) and
 * advances the state machine when a step completes. Same NCRONTAB-timer
 * pattern as scalingOverrideReEnable.ts (AM-23) — Flex Consumption fully
 * supports timer triggers (see that file's doc comment for the Microsoft
 * Learn citation). RESUMABLE BY CONSTRUCTION: every tick re-reads the
 * ImageBuild Table row fresh and re-derives what (if anything) to do next
 * entirely from that row + a fresh ARM read — a restart between ticks loses
 * nothing (see imageBuildOrchestrator.ts's header comment for the full
 * "why no poller is ever held across invocations" design).
 *
 * 1-minute cadence (vs. the emergency-override timer's 5 minutes): a build
 * is a rare, actively-watched, operator-initiated workflow the wizard polls
 * live — a tighter cadence keeps the UI's observed state close to
 * real-time without meaningfully increasing cost (at most a handful of
 * in-flight builds ever exist at once).
 *
 * NEVER advances a build in an OPERATOR_GATED_STATE (checklist_gate,
 * test_host_step) — those can only advance via an explicit POST
 * .../advance (see imageBuilds.ts). It DOES still visit checklist_gate
 * builds for the abandonment-warning check below (a read-only-ish side
 * annotation, not a state transition).
 */
export async function imageBuildTimer(_myTimer: Timer, context: InvocationContext): Promise<void> {
  const logger: AuditLogger = { warn: (m) => context.warn(m), error: (m) => context.error(m), log: (m) => context.log(m) };

  const builds = await listInFlightImageBuilds().catch((error) => {
    context.error('imageBuildTimer — failed to list in-flight builds', error);
    return undefined;
  });
  if (!builds) return;

  for (const build of builds) {
    if (build.state === 'checklist_gate') {
      await checkAbandonment(build, context);
      continue; // still operator-gated for STATE advancement.
    }
    if (OPERATOR_GATED_STATES.has(build.state) || !TIMER_DRIVEN_STATES.has(build.state)) {
      continue;
    }
    await advanceOneBuild(build, logger, context);
  }
}

/**
 * Opus review MAJOR 10 — ABANDONMENT: a build sitting at checklist_gate has
 * a real, running (billing) VM with nobody advancing it. This is a WARNING,
 * never an auto-fail — the build keeps running exactly as before; only an
 * `abandonedWarning` field is set (once — checked via the field's own
 * presence, so this doesn't re-audit every single tick for a build that's
 * been abandoned for days) and one audit row is written for it.
 */
async function checkAbandonment(build: ImageBuildRecord, context: InvocationContext): Promise<void> {
  if (build.abandonedWarning) return; // already warned for this episode.
  const { imageBuild } = getConfig();
  const ageHours = (Date.now() - new Date(build.createdAt).getTime()) / 3_600_000;
  if (ageHours < imageBuild.abandonmentWarningHours) return;

  const warning = `This build has sat at checklist_gate for over ${imageBuild.abandonmentWarningHours} hours with its build VM (${build.vmName}) still running and billing. Advance it, or cancel it if it's no longer needed.`;
  const correlationId = randomUUID();
  try {
    const fresh = await getImageBuild(build.buildId);
    if (!fresh || fresh.state !== 'checklist_gate' || fresh.abandonedWarning) return;
    await replaceImageBuild({ ...fresh, abandonedWarning: warning, updatedAt: new Date().toISOString() }, fresh.etag);
    await writeAuditEntry(
      { actor: 'system:image-build-timer', actorId: 'system', action: 'image.build.abandonment_warning', target: build.buildId, parameters: { buildId: build.buildId, ageHours: Math.round(ageHours) }, outcome: 'success', correlationId },
      { warn: (m) => context.warn(m), error: (m) => context.error(m), log: (m) => context.log(m) },
    );
  } catch (error) {
    if (!isPreconditionFailedError(error)) {
      context.error(`imageBuildTimer — failed to record abandonment warning for build ${build.buildId} | correlationId=${correlationId}`, error);
    }
  }
}

async function advanceOneBuild(build: ImageBuildRecord, logger: AuditLogger, context: InvocationContext): Promise<void> {
  const correlationId = randomUUID();
  try {
    const result = await computeAdvance(build, logger);
    if (!result) {
      return; // still waiting on Azure — nothing to persist this tick.
    }

    // Fresh read immediately before the write — same double-read race
    // guard rationale as scalingOverrideReEnable.ts: an operator action
    // (e.g. cancel) can land in the gap between listInFlightImageBuilds
    // and this write.
    const fresh = await getImageBuild(build.buildId);
    if (!fresh || fresh.state !== build.state) {
      context.log(`imageBuildTimer — build ${build.buildId} changed since this tick started (now ${fresh?.state ?? 'not found'}) — skipping`);
      return;
    }

    // Opus review BLOCKER 1 — SELF-TRANSITIONS: several poll functions
    // (pollCapturing's multi-phase sequence, pollCleanup's per-resource
    // progress, pollVmCreating/pollSnapshotting/submitSysprepIfNeeded's
    // attempt-bump retries, reconcilePlanned's "still too fresh to judge")
    // legitimately return the SAME state they were called with — that's
    // PROGRESS WITHIN a state (a step moved from pending to in_progress, an
    // attempt counter incremented, etc.), not a state machine transition.
    // The original implementation called assertTransition UNCONDITIONALLY,
    // which threw IllegalImageBuildTransitionError on every one of these
    // self-transitions — swallowed by the catch below with NOTHING
    // persisted, so e.g. pollCapturing's post-generalize progress was
    // silently discarded and the NEXT tick re-called `generalize` against
    // an already-generalized VM, forever. Only a GENUINE state change is
    // now checked against the transition table; a self-transition is
    // persisted unconditionally (the poll functions themselves are already
    // the source of truth for whether that progress is legal).
    if (result.nextState !== build.state) {
      assertTransition(build.state, result.nextState);
    }

    await replaceImageBuild(
      {
        ...fresh,
        state: result.nextState,
        stepsJson: JSON.stringify(result.steps),
        errorMessage: result.errorMessage ?? fresh.errorMessage,
        capturedImageVersionId: result.capturedImageVersionId ?? fresh.capturedImageVersionId,
        baseImageExactVersion: result.baseImageExactVersion ?? fresh.baseImageExactVersion,
        // vm_ready is the first state reachable after checklist_gate could
        // ever have been entered again in a future episode — clearing here
        // (not just on advance) keeps a stale warning from outliving the
        // episode it described if a build somehow revisits checklist_gate.
        abandonedWarning: result.nextState === 'checklist_gate' ? fresh.abandonedWarning : undefined,
        updatedAt: new Date().toISOString(),
      },
      fresh.etag,
    );

    await writeAuditEntry(
      {
        actor: 'system:image-build-timer',
        actorId: 'system',
        action: 'image.build.timer_advance',
        target: build.buildId,
        parameters: { buildId: build.buildId, from: build.state, to: result.nextState },
        outcome: result.nextState === 'failed' ? 'failure' : 'success',
        detail: result.errorMessage,
        correlationId,
      },
      logger,
    );
  } catch (error) {
    if (isPreconditionFailedError(error)) {
      context.log(`imageBuildTimer — ETag conflict advancing build ${build.buildId} (concurrent write) — will retry next tick`);
      return;
    }
    // Opus review MAJOR 12 — greppable marker + a failure-outcome audit row
    // for any advance that failed for a reason OTHER than an expected ETag
    // race, so a genuinely stuck build is observable (AM-48 landed the Log
    // Analytics alert rule that targets this marker — see
    // infra/modules/alerting.bicep's imageBuildStuckAlert) rather than only
    // ever visible as a quiet context.error line.
    context.error(`IMAGE_BUILD_STUCK | buildId=${build.buildId} state=${build.state} correlationId=${correlationId}`, error);
    await writeAuditEntry(
      {
        actor: 'system:image-build-timer',
        actorId: 'system',
        action: 'image.build.timer_advance',
        target: build.buildId,
        parameters: { buildId: build.buildId, from: build.state, to: build.state },
        outcome: 'failure',
        detail: error instanceof Error ? error.message : String(error),
        correlationId,
      },
      logger,
    ).catch(() => undefined);
  }
}

/** Dispatches to the right orchestrator poll function for the build's current state. sysprep_running/capturing regenerate the plan from the build's OWN frozen planContextJson + createdAt (Opus review MAJOR 9) — never a live resolvePlanContext()/new Date() call. `logger` is threaded into pollCleanup only, so it can emit the AM-48 IMAGE_BUILD_CLEANUP_SELFHEAL marker (see imageBuildOrchestrator.ts's logCleanupSelfHeal) — none of the other poll functions need it today. */
async function computeAdvance(build: ImageBuildRecord, logger: AuditLogger): Promise<AdvanceResult | null> {
  switch (build.state) {
    case 'planned':
      return reconcilePlanned(build);
    case 'vm_creating':
      return pollVmCreating(build);
    case 'vm_ready':
      return advanceVmReady(build);
    case 'snapshotting':
      return pollSnapshotting(build);
    case 'sysprep_running': {
      const plan = regeneratePlanFromFrozenBasis(build);
      return submitSysprepIfNeeded(build, plan);
    }
    case 'awaiting_stopped':
      return pollAwaitingStopped(build);
    case 'capturing': {
      const plan = regeneratePlanFromFrozenBasis(build);
      return pollCapturing(build, plan);
    }
    case 'cleanup':
      return pollCleanup(build, undefined, logger);
    default:
      return null;
  }
}

function regeneratePlanFromFrozenBasis(build: ImageBuildRecord) {
  const planContext = JSON.parse(build.planContextJson) as ImageBuildPlanContext;
  const planParams = JSON.parse(build.planParamsJson) as { version: string; vmSize?: string; adminUsername: string };
  return generateImageBuildPlan(planParams, build.buildId, planContext, new Date(build.createdAt));
}

app.timer('imageBuildTimer', {
  schedule: '0 * * * * *',
  handler: imageBuildTimer,
});
