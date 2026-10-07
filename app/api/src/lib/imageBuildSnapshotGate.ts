import { getConfig } from './config';
import { listRolloutPlanEntities, type RolloutPlanRecord } from '../services/rolloutPlanService';

/**
 * AM-53 — the rollout-done gate for pre-Sysprep snapshot deletion (the
 * DECIDED scope for AM-53: operator-confirmed deletion from the build
 * detail page once the version's rollout reached `done` — no autonomous
 * keep-last-N timer). A snapshot is the rebuild starting point for its
 * version (the golden-image runbook §4.5) — deleting it before
 * this estate has actually finished rolling that version out to session
 * hosts would remove the one artifact a botched rollout could still recover
 * from, so this gate is checked by BOTH app/api/src/functions/imageBuilds.ts's
 * DELETE .../builds/{buildId}/snapshot handler (a hard 409 refusal) and its
 * GET .../builds/{buildId} handler (the `snapshotDeletable`/
 * `snapshotDeleteBlockedReason` fields the frontend reads instead of
 * re-implementing this logic itself).
 *
 * Single source of truth: "done" per rolloutPlanService.ts's RolloutState —
 * see @avdmgr/shared's ROLLOUT_TERMINAL_STATES, of which 'done' is the one
 * successful terminal outcome ('rolled_back'/'cancelled' are the other two
 * terminal states and do NOT count as a completed rollout).
 *
 * 25-ROW CAP HONESTY (rolloutPlanService.ts#listRolloutPlanEntities bounds
 * its result to the most recent 25 plans per host pool): "no completed
 * rollout found" in that window is NOT the same fact as "this version was
 * never rolled out" — an older plan outside the cap could have completed it.
 * The refusal message below says so explicitly rather than asserting a
 * stronger claim this check cannot actually verify.
 */
export function hasCompletedRolloutForVersion(plans: readonly Pick<RolloutPlanRecord, 'targetImageVersion' | 'state'>[], version: string): boolean {
  return plans.some((plan) => plan.targetImageVersion === version && plan.state === 'done');
}

/** The exact refusal text both the DELETE handler's 409 and the GET detail's snapshotDeleteBlockedReason use — see this module's header comment for why "not found" must not be overstated as "never rolled out." */
export function describeRolloutNotCompleteReason(version: string): string {
  return (
    `No completed rollout found for version ${version} in the most recent rollout plans for this host pool — a pre-Sysprep snapshot cannot be ` +
    `deleted until this estate has actually finished rolling this version out to session hosts. Only the most recent plans are checked here; if an ` +
    `older plan completed this rollout, this message may be stale — verify directly in the Rollout page's plan history before concluding otherwise.`
  );
}

/**
 * Impure wrapper: reads this deployment's configured host pool's rollout
 * plan history (rolloutPlanService.ts — same Table-backed store the Rollout
 * page itself reads) and applies the pure predicate above. Propagates any
 * genuine read failure (never swallowed here) — callers decide how to react:
 * imageBuilds.ts's DELETE handler turns it into a 502 (fail closed, never
 * silently allow a delete the gate could not actually evaluate); its GET
 * detail handler catches it locally and degrades to an honest
 * "could not be verified" status instead of failing the whole detail read.
 */
export async function checkRolloutDoneForVersion(version: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  const { hostPoolName } = getConfig();
  const plans = await listRolloutPlanEntities(hostPoolName);
  if (hasCompletedRolloutForVersion(plans, version)) {
    return { ok: true };
  }
  return { ok: false, reason: describeRolloutNotCompleteReason(version) };
}
