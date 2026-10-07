import { randomUUID } from 'node:crypto';
import { app, InvocationContext, Timer } from '@azure/functions';
import type { RolloutNewHost, RolloutOldHost, RolloutState } from '@avdmgr/shared';
import { isAuditRequiredButMissing, writeAuditEntry, type AuditLogger } from '../lib/auditLog';
import { getConfig } from '../lib/config';
import { computeConfigDiffs, parseCheckOutput } from '../lib/fslogixConfigCheck';
import { listSessionHosts, resolveSessionHostVm } from '../services/avdService';
import { beginVmPowerAction, getFslogixConfigCheckResult, getVmImageReference, type VmImageReferenceInfo } from '../services/computeService';
import {
  allNewHostsRegistered,
  allOldHostsDrained,
  canTransition,
  getRolloutPlanEntity,
  isPreconditionFailedError,
  isTerminalState,
  listRolloutPlanEntities,
  parseConfigBaseline,
  replaceRolloutPlanEntity,
  type RolloutPlanEntity,
} from '../services/rolloutPlanService';

/** Same "rollout." prefix as the HTTP handlers — see rolloutPlans.ts's ACTION constants. */
const AUDIT_ACTION_ADVANCE = 'rollout.timer_advance';

/** AM-49 — same "rollout." prefix, one audit row per keep-alive `start` this timer submits — see keepAliveNewHosts below. */
const AUDIT_ACTION_KEEP_ALIVE = 'rollout.keep_alive_start';

/**
 * AM-49 — after this many keep-alive restarts for a SINGLE new host, the
 * timer stops trying and surfaces `keepAliveError` instead of restarting
 * forever. A host that hits this cap is a sign the scaling plan (or
 * something else) is deallocating it faster than this timer's 1-minute tick
 * can keep up with — that needs operator investigation, not an infinite
 * restart loop.
 */
const KEEP_ALIVE_MAX_RESTARTS = 20;

/**
 * AM-28 (M4-S3) — every minute, advances every NON-TERMINAL rollout plan for
 * this app's configured host pool by re-observing AVD state and, where the
 * plan's current state's exit condition is now met, moving it to the next
 * state (rolloutPlanService.ts's canTransition graph).
 *
 * READ-ONLY INVARIANT, NARROWED BY AM-49 (read this before adding another
 * mutation here): this timer was originally documented as never mutating a
 * session host, VM, or ARM resource at all — every WRITE lived exclusively
 * in rolloutPlans.ts, operator-initiated. AM-49 narrows that invariant to
 * exactly ONE mutation class, and no other: keepAliveNewHosts (below)
 * submits a VM `start` for a DECLARED NEW HOST of the plan this tick is
 * advancing, and ONLY while that plan is in `awaiting_new_hosts` or
 * `validating_new` — never for an old host, never for a host not declared
 * on the plan, never in any other state. Precedent for an auditable,
 * system-initiated timer mutation already exists elsewhere in this app —
 * see scalingOverrideReEnable.ts's `system:auto-reenable` ARM re-enable and
 * imageBuildTimer.ts's `system:image-build-timer` cleanup deletes — this is
 * the same posture applied here: always audited (AUDIT_ACTION_KEEP_ALIVE),
 * always behind the fail-closed audit gate below, and bounded
 * (KEEP_ALIVE_MAX_RESTARTS) so a persistently misbehaving scaling plan
 * cannot turn this into an infinite retry loop. Every OTHER read in this
 * file remains exactly as read-only against ARM as before.
 *
 * WHY NOT A SCALING-PLAN EXCLUSION TAG (decision, not an oversight): tagging
 * a new host to exclude it from `SCALE-CONTOSO-PROD`'s scope was considered and
 * rejected. It would (1) mutate SHARED estate config — the scaling plan's
 * `exclusionTag` property is deliberately left empty today, and populating
 * it changes behavior for every host in the pool that happens to carry that
 * tag, not just this plan's declared new hosts; (2) require a brand-new
 * VM-tag-write RBAC grant this app's `vmPowerOperatorRole` does not carry
 * today; and (3) need its own terminal-state reconciliation (removing the
 * exclusion tag once the host is cut over or the plan ends, including on
 * rollback/cancel — another whole state machine). Restart-on-next-tick meets
 * the AM-49 acceptance criterion directly, needs ZERO new RBAC (the app's
 * `vmPowerOperatorRole` already grants `Microsoft.Compute/virtualMachines/
 * start/action` on RG-AVD-HostPools — the same permission sessionHostPower.ts's
 * operator-initiated start already relies on), and self-terminates via the
 * restart cap rather than needing reconciliation.
 *
 * TIMER SINGLETON: Azure Functions' timer trigger uses a storage-account
 * blob lease to guarantee only ONE instance of this function runs at a
 * time, even if the Function App scales out to multiple instances (verified
 * on Microsoft Learn — "Timer trigger for Azure Functions": "The timer
 * trigger uses a storage lock to ensure that there is only one timer
 * instance when a function app scales out to multiple instances") — so this
 * code does not itself need to worry about two concurrent timer runs racing
 * each other; the 412/merge handling below exists for races against
 * OPERATOR actions (rolloutPlans.ts), not against a second copy of itself.
 *
 * States this timer can auto-advance:
 *   - draining_old -> awaiting_new_hosts, once every old host reports
 *     allowNewSession: false AND a server-observed session count of 0
 *     (allOldHostsDrained, fed by a fresh listSessionHosts read each tick —
 *     see refreshOldHosts).
 *   - awaiting_new_hosts -> validating_new, once every declared new host
 *     name has been OBSERVED at all in listSessionHosts (allNewHostsRegistered)
 *     — health/availability/image-verification is tracked but not required
 *     for THIS transition.
 *
 * States this timer updates PER-HOST detail for but does NOT itself
 * transition out of (an operator action is required — see rolloutPlans.ts):
 *   - validating_new: keeps refreshing each new host's status/healthy/
 *     imageVerified so the confirm-cutover gate
 *     (allNewHostsAvailableAndHealthy + allNewHostsImageVerified) reflects
 *     current reality, but only an operator's confirm-cutover call moves to
 *     cutover. This INCLUDES hosts already 'validated' (AM-28 peer review
 *     item 7) — their per-host observed data keeps refreshing so a host that
 *     degrades (goes Unavailable, fails a health check, or its VM is
 *     replaced with a different image) AFTER cutover-confirmation remains
 *     visible before removal, even though the plan's own STATE never
 *     regresses out of cutover/removing_old because of it.
 *
 *     AM-47 ADDITION — also polls (pollConfigChecks below) the FSLogix
 *     config-convergence check for every new host whose
 *     `configCheck.status` is 'in_progress' (submitted by rolloutPlans.ts's
 *     verify-config action, an operator-triggered MUTATION — the submit
 *     itself lives there, never here). The poll itself is a PLAIN GET
 *     (computeService.ts#getFslogixConfigCheckResult — Run Command v2's
 *     `virtualMachineRunCommands.getByVirtualMachine`), so it fits this
 *     timer's documented read-only-against-ARM invariant exactly the same
 *     way every other read in this file does — Run Command v2
 *     (`Microsoft.Compute/virtualMachines/runCommands`, a named child
 *     resource) was chosen BECAUSE its result is retrievable later by an
 *     independent GET, unlike the classic `virtualMachines.runCommand`
 *     action whose output only the original submitting poller can ever
 *     read — see app/api/src/lib/fslogixConfigCheck.ts's header comment for
 *     the full architecture this split enables.
 *   - planned, cutover, removing_old: no automatic ARM polling is useful in
 *     these states (planned hasn't drained anything yet; cutover/removing_old
 *     progress only via explicit operator actions in rolloutPlans.ts), so
 *     this timer skips them entirely (see shouldPoll below).
 *
 * AM-49 KEEP-ALIVE (keepAliveNewHosts below) — applies in BOTH
 * awaiting_new_hosts and validating_new, run after refreshNewHosts has
 * observed each declared new host's current `powerState` for this tick.
 * Motivating incident: autoscale (SCALE-CONTOSO-PROD, 0% minimum host count at
 * every phase) deallocated brand-new rollout hosts minutes after
 * provisioning, before Intune policy convergence — `startVMOnConnect` does
 * not help here, since it only cold-starts a host on a user CONNECTION
 * attempt, and nobody connects to a host that hasn't been cut over yet. For
 * every declared new host observed `'deallocated'` or `'stopped'` this
 * tick, the timer submits a `start` (computeService.ts#beginVmPowerAction,
 * the same submit-only ARM call sessionHostPower.ts's operator-initiated
 * start uses) — see this file's READ-ONLY INVARIANT note above for why this
 * one mutation class is in scope and a scaling-plan exclusion tag is not,
 * and keepAliveNewHosts' own doc comment for the per-host restart-count
 * cap, audit row, and failure-isolation detail.
 *
 * FAIL-CLOSED AUDIT POSTURE (AM-28 peer review item 12; AM-49 extends this
 * from "automatic state advance" to "automatic ARM mutation" generally):
 * mirrors every mutating HTTP handler's isAuditRequiredButMissing() check —
 * an automatic STATE ADVANCE writes an audit row (see the bottom of
 * advancePlan), and AS OF AM-49 a keep-alive `start` submission does too
 * (AUDIT_ACTION_KEEP_ALIVE) — so a deployed environment (WEBSITE_SITE_NAME
 * set) that cannot durably record that audit row must not silently
 * advance plan state OR silently start a VM either. Checked ONCE per tick,
 * before the loop — if true, the tick is skipped ENTIRELY (no plan is even
 * read, let alone polled or keep-alive-restarted) and a distinct,
 * alertable marker is logged (see infra/modules/functionapp.bicep's
 * ALERTING TODO list). This single early return is therefore also
 * keepAliveNewHosts' fail-closed gate — there is no separate check inside
 * that function, because control never reaches it when this one already
 * returned.
 *
 * CONFLICT HANDLING: like scalingOverrideReEnable.ts, each plan is read
 * fresh (with its ETag) at the top of its own iteration; if the write at the
 * end hits a 412 (isPreconditionFailedError — an operator action raced this
 * tick), that plan's update is simply skipped for this tick rather than
 * retried or erroring the whole run — the NEXT tick re-reads current state
 * and tries again, so a lost race here is a one-minute delay, never a
 * silently wrong write. AM-49: this now ALSO covers the keep-alive path — a
 * submitted `start` that fails to persist its bookkeeping (keepAliveRestartCount/
 * lastKeepAliveAt/keepAliveError) on a 412 is safe for the same reason a
 * lost state-advance write is safe: the NEXT tick re-observes the host's
 * powerState (now 'starting' or 'running', not 'deallocated'/'stopped') and
 * therefore does not double-start it — the ARM mutation itself is
 * idempotent-by-observation even though the bookkeeping write that records
 * it was lost. (This timer's only irreversible-if-lost action remains a
 * PLAN STATE ADVANCE, and that was already covered before AM-49 — a VM
 * start submission has no such "achieved but unpersisted, now stuck"
 * failure mode.)
 *
 * ERROR ISOLATION: a single plan's ARM polling failure (or write conflict)
 * is caught and recorded on THAT plan's own lastTimerError field — it does
 * not stop the loop from advancing every other plan for the tick. The
 * PERSISTED lastTimerError is a GENERIC classification (see
 * classifyTimerError), never the raw ARM/SDK error text — that raw detail
 * goes only to context.warn (Application Insights), matching this app's
 * CWE-532 posture elsewhere (e.g. SessionBatchFailure.message) of never
 * round-tripping a potentially request-shaped internal error string back
 * into a response body/persisted record the UI renders.
 */
export async function rolloutPlanTimer(_myTimer: Timer, context: InvocationContext): Promise<void> {
  const correlationId = randomUUID();
  const logger: AuditLogger = { warn: (m) => context.warn(m), error: (m) => context.error(m), log: (m) => context.log(m) };
  const { hostPoolName } = getConfig();

  if (isAuditRequiredButMissing()) {
    context.error(`ROLLOUT_TIMER_AUDIT_MISCONFIGURED | correlationId=${correlationId} — AUDIT_STORAGE_ACCOUNT_NAME is unset in a deployed environment; skipping this tick's advances entirely (an automatic state advance must be auditable).`);
    return;
  }

  let plans;
  try {
    plans = await listRolloutPlanEntities(hostPoolName);
  } catch (error) {
    context.error(`rolloutPlanTimer — failed to list rollout plans | correlationId=${correlationId}`, error);
    return;
  }

  const active = plans.filter((plan) => !isTerminalState(plan.state));
  for (const plan of active) {
    try {
      await advancePlan(hostPoolName, plan.rowKey, context, logger, correlationId);
    } catch (error) {
      context.error(`rolloutPlanTimer — failed to advance plan | planId=${plan.rowKey} correlationId=${correlationId}`, error);
    }
  }
}

/** True for the states this timer actively polls ARM for (see this file's doc comment for why the others are skipped). */
function shouldPoll(state: RolloutState): boolean {
  return state === 'draining_old' || state === 'awaiting_new_hosts' || state === 'validating_new';
}

/**
 * Short, generic, UI-safe classification of a polling failure — the RAW
 * error (with full detail) is logged separately via context.warn
 * (Application Insights only); this classification is what gets PERSISTED
 * to RolloutPlanEntity.lastTimerError and therefore what the frontend
 * renders (AM-28 peer review item 12).
 */
function classifyTimerError(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'statusCode' in error) {
    const statusCode = (error as { statusCode?: number }).statusCode;
    if (statusCode === 404) return 'A host or VM could not be found in Azure.';
    if (statusCode === 403) return 'Azure denied a read request (permissions).';
    if (typeof statusCode === 'number') return `Azure request failed (HTTP ${statusCode}).`;
  }
  return 'Azure request failed.';
}

async function advancePlan(hostPoolName: string, planId: string, context: InvocationContext, logger: AuditLogger, correlationId: string): Promise<void> {
  const record = await getRolloutPlanEntity(hostPoolName, planId);
  if (!record || !shouldPoll(record.state)) {
    return;
  }

  const oldHosts: RolloutOldHost[] = JSON.parse(record.oldHostsJson);
  const newHosts: RolloutNewHost[] = JSON.parse(record.newHostsJson);
  const now = new Date().toISOString();
  let nextState = record.state;
  let updatedOldHosts = oldHosts;
  let updatedNewHosts = newHosts;
  let timerError: string | undefined;

  try {
    if (record.state === 'draining_old') {
      updatedOldHosts = await refreshOldHosts(hostPoolName, oldHosts);
      if (allOldHostsDrained(updatedOldHosts) && canTransition('draining_old', 'awaiting_new_hosts')) {
        nextState = 'awaiting_new_hosts';
      }
    } else if (record.state === 'awaiting_new_hosts' || record.state === 'validating_new') {
      updatedNewHosts = await refreshNewHosts(hostPoolName, newHosts, record.targetImageVersion);
      if (record.state === 'awaiting_new_hosts' && allNewHostsRegistered(updatedNewHosts) && canTransition('awaiting_new_hosts', 'validating_new')) {
        nextState = 'validating_new';
      }
      // AM-49: applies in BOTH awaiting_new_hosts and validating_new — see
      // this file's header comment (AM-49 KEEP-ALIVE) for why. Isolated to
      // its own try/catch is unnecessary here: keepAliveNewHosts never
      // throws (every per-host failure is caught internally — see its own
      // doc comment), so it cannot itself turn into a plan-level
      // classifyTimerError the way refreshNewHosts/pollConfigChecks can.
      updatedNewHosts = await keepAliveNewHosts(hostPoolName, planId, updatedNewHosts, context, logger, correlationId);
      // AM-47: config-check polling only applies once a plan has actually
      // reached validating_new — no host can have a configCheck at all
      // before then (rolloutPlans.ts's verify-config action is itself only
      // legal in validating_new), so this is a no-op (empty per-host
      // filter inside pollConfigChecks) for awaiting_new_hosts in practice;
      // gated explicitly anyway so that stays true by construction, not by
      // accident, if this function's shape ever changes.
      if (record.state === 'validating_new') {
        updatedNewHosts = await pollConfigChecks(hostPoolName, updatedNewHosts, parseConfigBaseline(record) ?? getConfig().fslogixBaseline);
      }
    }
  } catch (error) {
    timerError = classifyTimerError(error);
    context.warn(`rolloutPlanTimer — ARM polling failed for plan (will retry next tick) | planId=${planId} correlationId=${correlationId} error=${error instanceof Error ? error.message : String(error)}`);
  }

  const unchanged = nextState === record.state && JSON.stringify(updatedOldHosts) === record.oldHostsJson && JSON.stringify(updatedNewHosts) === record.newHostsJson && timerError === record.lastTimerError;
  if (unchanged) {
    return;
  }

  const { etag, ...base } = record;
  const updated: RolloutPlanEntity = {
    ...base,
    state: nextState,
    oldHostsJson: JSON.stringify(updatedOldHosts),
    newHostsJson: JSON.stringify(updatedNewHosts),
    updatedAt: now,
    lastTimerError: timerError,
  };

  try {
    await replaceRolloutPlanEntity(updated, etag);
  } catch (error) {
    if (isPreconditionFailedError(error)) {
      context.log(`rolloutPlanTimer — plan changed concurrently (operator action raced this tick) — skipping | planId=${planId} correlationId=${correlationId}`);
      return;
    }
    throw error;
  }

  if (nextState !== record.state) {
    await writeAuditEntry(
      { actor: 'system:rollout-timer', actorId: 'system', action: AUDIT_ACTION_ADVANCE, target: `${hostPoolName}/${planId}`, parameters: { from: record.state, to: nextState }, outcome: 'success', correlationId },
      logger,
    );
    context.log(`rolloutPlanTimer — advanced plan | planId=${planId} from=${record.state} to=${nextState} correlationId=${correlationId}`);
  }
}

/**
 * Re-observes every old host against a SINGLE fresh listSessionHosts call
 * per tick (AM-28 peer review item 12 — dropped the earlier per-host
 * resolveSessionHostVm design entirely; one ARM list call now serves every
 * old host in the plan instead of N single-host GETs) and marks a host
 * 'drained' once BOTH its server-observed session count is 0 AND its
 * allowNewSession flag is false (AM-28 peer review item 6 — a host an
 * operator re-enabled via the HostPool page's drain toggle, independently
 * of this plan, must never read as "drained" even while momentarily
 * empty). A host not found in this tick's list (or the whole list call
 * failing — caught by advancePlan's own try/catch) leaves that host's
 * status unchanged, retried next tick.
 */
async function refreshOldHosts(hostPoolName: string, hosts: RolloutOldHost[]): Promise<RolloutOldHost[]> {
  const liveHosts = await listSessionHosts(hostPoolName, { resolvePowerState: false });
  const byName = new Map(liveHosts.map((host) => [host.name.toLowerCase(), host]));

  return hosts.map((host) => {
    if (host.status === 'drained' || host.status === 'removed' || host.status === 'undrained_rollback') {
      return host;
    }
    const live = byName.get(host.sessionHostName.toLowerCase());
    if (!live) {
      return host;
    }
    const status = live.activeSessions === 0 && !live.allowNewSession ? ('drained' as const) : ('draining' as const);
    return { ...host, status, lastObservedSessions: live.activeSessions, drainedAt: status === 'drained' ? (host.drainedAt ?? new Date().toISOString()) : host.drainedAt };
  });
}

/** True when a VM's resolved image reference matches `targetVersion` — prefers the ARM-populated exactVersion field; falls back to the trailing path segment of the image resource id (still meaningful even for a "latest"-pinned vmTemplate, where exactVersion is the field that actually differs from the literal string "latest" — see computeService.ts#VmImageReferenceInfo's doc comment; converged with AM-26's shared implementation at merge). False for an undefined/unresolvable reference. */
function imageVersionMatches(imageRef: VmImageReferenceInfo | undefined, targetVersion: string): boolean {
  if (!imageRef) {
    return false;
  }
  if (imageRef.exactVersion) {
    return imageRef.exactVersion === targetVersion;
  }
  if (imageRef.id) {
    const segments = imageRef.id.split('/');
    return segments[segments.length - 1] === targetVersion;
  }
  return false;
}

/**
 * Re-observes every declared new host against a single fresh
 * listSessionHosts call (one ARM list per tick per plan, not one per host —
 * cheaper than a per-host GET, and appropriate here since these hosts may
 * not exist in AVD YET at all, which a single-host GET would just 404 on
 * repeatedly). Host-name matching is CASE-INSENSITIVE (AM-28 peer review
 * item 6 — an operator's declared name and AVD's actual registered name
 * should match regardless of case; ARM itself is case-preserving but this
 * app's own comparison should not be needlessly case-sensitive here).
 *
 * A host not found in the list stays 'awaiting_registration'; once found,
 * status becomes 'registered' at minimum, 'available' if AVD reports it
 * Available, and `healthy` reflects whether every health check on it
 * succeeded. AM-28 peer review item 7: a host ALREADY 'validated' keeps its
 * status (never regressed back to 'available'/'registered' by this
 * function), but its lastObservedStatus/healthy/imageVerified fields keep
 * refreshing regardless — so a validated host that degrades before removal
 * stays visible, without the plan's own state machine treating that as
 * "back to validating".
 *
 * AM-28 peer review item 4: also resolves each observed host's VM (via
 * avdService.ts#resolveSessionHostVm + computeService.ts#getVmImageReference)
 * to verify its image version against the plan's targetImageVersion,
 * populating `imageVerified`. A resolution failure for one host leaves its
 * imageVerified at its previous value (or undefined) rather than failing
 * the whole tick.
 *
 * AM-49: unlike refreshOldHosts (which stays `resolvePowerState: false` —
 * old-host draining never needed power state), this NEW-host pass now
 * resolves power state too (`resolvePowerState: true`), persisting the
 * observed `powerState` onto every declared new host each tick. This is the
 * ONLY extra ARM cost AM-49 adds to polling: one instanceView GET per
 * declared new host per tick (bounded at 50 by RolloutNewHost's own
 * declared-name limit, realistically 1-2 for this estate), and
 * listSessionHosts already degrades a single host's power-state lookup to
 * 'unknown' internally rather than throwing (avdService.ts#resolvePowerState)
 * — so this can't turn one host's transient instanceView failure into a
 * whole-tick polling failure. `powerState` is what keepAliveNewHosts (below)
 * acts on for the same tick.
 */
async function refreshNewHosts(hostPoolName: string, hosts: RolloutNewHost[], targetImageVersion: string): Promise<RolloutNewHost[]> {
  const liveHosts = await listSessionHosts(hostPoolName, { resolvePowerState: true });
  const byName = new Map(liveHosts.map((host) => [host.name.toLowerCase(), host]));

  return Promise.all(
    hosts.map(async (host) => {
      const live = byName.get(host.sessionHostName.toLowerCase());
      if (!live) {
        return host;
      }
      const healthy = (live.healthChecks?.length ?? 0) > 0 && (live.healthChecks?.every((check) => check.healthCheckResult === 'HealthCheckSucceeded') ?? false);
      const status = host.status === 'validated' ? ('validated' as const) : live.status === 'Available' ? ('available' as const) : ('registered' as const);

      let imageVerified = host.imageVerified;
      try {
        const vmTarget = await resolveSessionHostVm(hostPoolName, live.name);
        const imageRef = await getVmImageReference(vmTarget.resourceGroup, vmTarget.vmName);
        imageVerified = imageVersionMatches(imageRef, targetImageVersion);
      } catch {
        // Leave imageVerified at its previously-observed value — a transient
        // resolve/read failure for one host must not fail the whole tick,
        // and must not silently regress a PREVIOUSLY-verified host back to
        // unverified just because this one read hiccuped.
      }

      return { ...host, status, lastObservedStatus: live.status, healthy, imageVerified, powerState: live.powerState, registeredAt: host.registeredAt ?? new Date().toISOString() };
    }),
  );
}

/**
 * AM-49 — restarts a declared new host's underlying VM when this tick's
 * refreshNewHosts observed it `'deallocated'` or `'stopped'` (see this
 * file's header comment for the READ-ONLY INVARIANT this narrows, and for
 * why a scaling-plan exclusion tag was rejected instead). Applied to every
 * host in the plan's `newHosts` list — the caller only invokes this for
 * plans in `awaiting_new_hosts`/`validating_new` (advancePlan), so "every
 * host in the plan" already means "every host of a plan in one of the two
 * states this applies to"; hosts of any other plan, and hosts not declared
 * on a plan at all, are never passed in here and so are never touched.
 *
 * PER-HOST DECISION (host.powerState, as just refreshed this tick):
 *   - 'deallocated'/'stopped': eligible for a keep-alive restart — see the
 *     cap/submit logic below.
 *   - 'starting'/'running'/'stopping'/'deallocating': never start. A
 *     'starting'/'running' host doesn't need one; 'stopping'/'deallocating'
 *     means Azure is mid-transition and a start submitted now would 409 —
 *     left alone, retried next tick once it settles into a stable state.
 *   - 'unknown'/undefined: never start — an unresolved power state must
 *     never be treated as either "needs a restart" or "already fine".
 *
 * CAP: once `keepAliveRestartCount` reaches KEEP_ALIVE_MAX_RESTARTS, no
 * further start is submitted — `keepAliveError` is set to a fixed,
 * operator-facing message, but ONLY IF NOT ALREADY SET to that same message
 * (a host already at the cap returns the SAME object reference unchanged,
 * so repeated ticks don't manufacture a spurious diff / repeated writes).
 *
 * PER-HOST FAILURE ISOLATION (mirrors refreshNewHosts' own imageVerified
 * catch block, and pollConfigChecks' per-host catch, VERBATIM in spirit): a
 * failed resolveSessionHostVm or beginVmPowerAction for ONE host is caught
 * right here, never rethrown — it does not fail this function, the calling
 * advancePlan's tick, or any OTHER host's keep-alive attempt. On failure,
 * `keepAliveRestartCount` is STILL incremented (so a persistently-failing
 * ARM call also converges on the cap instead of retrying forever) and
 * `keepAliveError` is set to a short, generic classification — the raw
 * ARM/SDK error goes only to context.warn (Application Insights), same
 * CWE-532 posture as classifyTimerError/lastTimerError elsewhere in this
 * file. Every other field on the host (status, healthy, imageVerified,
 * powerState, lastKeepAliveAt, …) is left exactly as refreshNewHosts set it
 * this tick — a keep-alive failure never touches them.
 *
 * AUDIT: exactly one `AUDIT_ACTION_KEEP_ALIVE` row per SUBMITTED start
 * (outcome 'accepted' — the same "submitted, not confirmed" semantics as
 * sessionHostPower.ts's own `start` audit rows), written best-effort (a
 * write failure is warned, not thrown — the restart itself already
 * happened and must not be undone or retried just because the audit write
 * hiccuped). No audit row is written for a host that wasn't restarted this
 * tick (already fine, at cap, or itself failed to resolve/submit) — the
 * cap-reached and failure cases are instead surfaced via the persisted
 * `keepAliveError` field, which the frontend renders directly.
 */
const KEEP_ALIVE_CAP_MESSAGE = 'Keep-alive restart limit reached — autoscale keeps deallocating this host; investigate the scaling plan.';

/** AM-49 — generic, UI-safe classification for a keep-alive resolve/submit failure (see keepAliveNewHosts' doc comment's CWE-532 note). Deliberately distinct wording from classifyTimerError's read-failure messages — this is a start SUBMISSION failing, not a read. */
function classifyKeepAliveError(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'statusCode' in error) {
    const statusCode = (error as { statusCode?: number }).statusCode;
    if (statusCode === 404) return 'The host or its VM could not be found in Azure.';
    if (statusCode === 403) return 'Azure denied the automatic restart request (permissions).';
    if (statusCode === 409) return 'Azure reported the VM as busy with another operation.';
    if (typeof statusCode === 'number') return `Azure rejected the automatic restart request (HTTP ${statusCode}).`;
  }
  return 'Azure rejected the automatic restart request.';
}

async function keepAliveNewHosts(
  hostPoolName: string,
  planId: string,
  hosts: RolloutNewHost[],
  context: InvocationContext,
  logger: AuditLogger,
  correlationId: string,
): Promise<RolloutNewHost[]> {
  return Promise.all(
    hosts.map(async (host) => {
      if (host.powerState !== 'deallocated' && host.powerState !== 'stopped') {
        return host;
      }

      const restartCount = host.keepAliveRestartCount ?? 0;
      if (restartCount >= KEEP_ALIVE_MAX_RESTARTS) {
        if (host.keepAliveError === KEEP_ALIVE_CAP_MESSAGE) {
          return host; // already recorded — don't rewrite every tick.
        }
        return { ...host, keepAliveError: KEEP_ALIVE_CAP_MESSAGE };
      }

      try {
        const vmTarget = await resolveSessionHostVm(hostPoolName, host.sessionHostName);
        await beginVmPowerAction(vmTarget.resourceGroup, vmTarget.vmName, 'start');
        const newCount = restartCount + 1;
        const lastKeepAliveAt = new Date().toISOString();

        try {
          await writeAuditEntry(
            {
              actor: 'system:rollout-timer',
              actorId: 'system',
              action: AUDIT_ACTION_KEEP_ALIVE,
              target: `${hostPoolName}/${planId}`,
              parameters: { sessionHostName: host.sessionHostName, resourceGroup: vmTarget.resourceGroup, vmName: vmTarget.vmName, restartCount: newCount },
              outcome: 'accepted',
              correlationId,
            },
            logger,
          );
        } catch (auditError) {
          context.warn(`rolloutPlanTimer — keep-alive audit write threw unexpectedly (ignored — the restart was already submitted) | planId=${planId} sessionHostName=${host.sessionHostName} correlationId=${correlationId} error=${String(auditError)}`);
        }

        return { ...host, keepAliveRestartCount: newCount, lastKeepAliveAt, keepAliveError: undefined };
      } catch (error) {
        context.warn(`rolloutPlanTimer — keep-alive restart failed for host (will retry next tick, up to the restart cap) | planId=${planId} sessionHostName=${host.sessionHostName} correlationId=${correlationId} error=${error instanceof Error ? error.message : String(error)}`);
        return { ...host, keepAliveRestartCount: restartCount + 1, keepAliveError: classifyKeepAliveError(error) };
      }
    }),
  );
}

/** A configCheck stuck 'in_progress' (Run Command v2 never reaches a terminal executionState — an unreachable VM, a wedged VM agent) longer than this is marked 'error' ("timed out") rather than polled forever. Well over FSLOGIX_CONFIG_CHECK_TIMEOUT_SECONDS (5 minutes — the script's OWN Azure-enforced execution timeout), giving Azure's own timeout every chance to fire first; this is the operator-facing backstop for the case where the run command resource itself never even reaches a state Azure will report as terminal. */
const CONFIG_CHECK_STUCK_MINUTES = 15;

/** Clock-skew tolerance for the stale-result guard below (instanceView.endTime is Azure's clock; configCheck.submittedAt is this app's). 30s comfortably covers real skew while remaining far smaller than the minutes-scale gap between a prior run's endTime and a genuine re-submit. */
const STALE_RESULT_SKEW_MS = 30_000;

/**
 * AM-47 — polls the Run Command v2 result (computeService.ts#getFslogixConfigCheckResult,
 * a PLAIN GET) for every host whose `configCheck.status` is 'in_progress'.
 * A host with no `configCheck` at all, or one already
 * 'passed'/'failed'/'error', is returned UNCHANGED — this function never
 * re-polls a completed check (an operator must explicitly re-run
 * verify-config to re-check a host).
 *
 * Terminal handling:
 *   - executionState 'Succeeded': parses `instanceView.output` via
 *     fslogixConfigCheck.ts#parseCheckOutput and diffs it against
 *     `baseline` via computeConfigDiffs — zero diffs -> 'passed', one or
 *     more -> 'failed' (with `diffs` populated either way, per
 *     @avdmgr/shared's RolloutNewHost.configCheck doc comment: present for
 *     both outcomes, absent only for 'in_progress'/'error'). An
 *     unparsable/missing output, OR a nonzero `exitCode`, is instead
 *     'error' — the script ran but did not produce a trustworthy result.
 *   - executionState 'Failed'/'TimedOut'/'Canceled': 'error' — the script
 *     itself did not complete successfully.
 *   - Still 'Pending'/'Running'/absent: left 'in_progress' UNLESS
 *     `submittedAt` is older than CONFIG_CHECK_STUCK_MINUTES, in which case
 *     it is marked 'error' ("timed out") instead of polled forever.
 *
 * STALE-RESULT GUARD (Fable review fix): after verify-config RE-submits a
 * check, the child resource's GET can briefly keep reporting the PREVIOUS
 * execution's terminal instanceView until the new execution actually
 * starts — without a guard, a re-verify could mark a host 'passed' from
 * the PRIOR run's output seconds after the operator asked for a fresh
 * check. Any terminal result whose `endTime` predates this check's own
 * `submittedAt` (minus STALE_RESULT_SKEW_MS of clock-skew tolerance —
 * endTime is Azure's clock, submittedAt is this app's) is therefore
 * treated as not-yet-started: left 'in_progress', still subject to the
 * stuck timeout above. A terminal result with NO endTime is accepted as
 * current (no evidence of staleness — rejecting it would wedge platforms
 * that omit the field).
 *
 * PER-HOST FAILURE ISOLATION: mirrors refreshNewHosts' own imageVerified
 * failure posture VERBATIM — a transient GET failure (network blip,
 * momentary ARM throttling, the run command child resource not existing
 * YET because this poll raced a just-submitted verify-config call) leaves
 * that host's PRIOR configCheck value completely untouched, silently
 * retried again next tick. It does not fail the whole plan's tick (the
 * error is swallowed here, exactly like refreshNewHosts' own catch block —
 * NOT rethrown for advancePlan's outer try/catch to classify into
 * lastTimerError, since a single host's transient read hiccup is not a
 * plan-level polling failure).
 */
async function pollConfigChecks(hostPoolName: string, hosts: RolloutNewHost[], baseline: Record<string, string>): Promise<RolloutNewHost[]> {
  return Promise.all(
    hosts.map(async (host) => {
      if (host.configCheck?.status !== 'in_progress') {
        return host;
      }
      const configCheck = host.configCheck;
      try {
        const vmTarget = await resolveSessionHostVm(hostPoolName, host.sessionHostName);
        const instanceView = await getFslogixConfigCheckResult(vmTarget.resourceGroup, vmTarget.vmName);
        const completedAt = new Date().toISOString();

        // STALE-RESULT GUARD — see this function's doc comment. A terminal
        // instanceView that ENDED before this check was submitted belongs to
        // a previous execution of the same-named child resource; treat the
        // current check as still in progress (the stuck timeout below still
        // applies, so a re-run whose new execution never starts cannot poll
        // forever either).
        const isTerminal = instanceView?.executionState === 'Succeeded' || instanceView?.executionState === 'Failed' || instanceView?.executionState === 'TimedOut' || instanceView?.executionState === 'Canceled';
        const staleResult =
          isTerminal &&
          instanceView?.endTime !== undefined &&
          configCheck.submittedAt !== undefined &&
          new Date(instanceView.endTime).getTime() < new Date(configCheck.submittedAt).getTime() - STALE_RESULT_SKEW_MS;

        if (!staleResult && instanceView?.executionState === 'Succeeded') {
          const parsed = parseCheckOutput(instanceView.output);
          if (parsed === null || (instanceView.exitCode !== undefined && instanceView.exitCode !== 0)) {
            return { ...host, configCheck: { status: 'error' as const, submittedAt: configCheck.submittedAt, completedAt, error: 'The config check script did not return a readable result.' } };
          }
          const diffs = computeConfigDiffs(baseline, parsed);
          return { ...host, configCheck: { status: diffs.length === 0 ? ('passed' as const) : ('failed' as const), submittedAt: configCheck.submittedAt, completedAt, diffs } };
        }

        if (!staleResult && (instanceView?.executionState === 'Failed' || instanceView?.executionState === 'TimedOut' || instanceView?.executionState === 'Canceled')) {
          return { ...host, configCheck: { status: 'error' as const, submittedAt: configCheck.submittedAt, completedAt, error: 'The config check script failed to run.' } };
        }

        // Still Pending/Running/unreported — check OUR OWN operator-facing stuck timeout.
        if (configCheck.submittedAt && Date.now() - new Date(configCheck.submittedAt).getTime() > CONFIG_CHECK_STUCK_MINUTES * 60_000) {
          return { ...host, configCheck: { status: 'error' as const, submittedAt: configCheck.submittedAt, completedAt, error: 'The config check timed out waiting for a result.' } };
        }
        return host; // still genuinely in progress — retried next tick.
      } catch {
        // Transient GET failure — leave the prior configCheck value untouched (see this function's doc comment).
        return host;
      }
    }),
  );
}

app.timer('rolloutPlanTimer', {
  schedule: '0 */1 * * * *',
  handler: rolloutPlanTimer,
});
