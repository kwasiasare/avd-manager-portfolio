import { randomUUID } from 'node:crypto';
import { app, InvocationContext, Timer } from '@azure/functions';
import { writeAuditEntry, type AuditLogger } from '../lib/auditLog';
import { setScalingPlanHostPoolEnabled } from '../services/avdService';
import { getScalingOverride, isOverrideExpired, replaceScalingOverride } from '../services/scalingOverrideService';

/** Same "scalingplan." prefix as the mutating HTTP handlers — see scalingHistory.ts's ACTION_PREFIX. */
const AUDIT_ACTION = 'scalingplan.emergency_override.auto_reenable';

/**
 * AM-23 (M3-S1) — every 5 minutes, checks whether the emergency "keep all
 * hosts up" override has expired (see scalingOverrideService.ts's
 * isOverrideExpired, extracted as a pure function precisely so this
 * decision is unit-testable without a Table/ARM client — see
 * scalingOverrideService.test.ts) and, if so, re-enables autoscale for the
 * configured host pool via the same ARM mechanism the manual cancel
 * endpoint uses (setScalingPlanHostPoolEnabled), using the
 * resourceGroup/scalingPlanName/hostPoolId STORED ON THE ROW at activation
 * time (not a fresh ARM lookup).
 *
 * Flex Consumption fully supports timer triggers (confirmed on Microsoft
 * Learn: "Azure Functions Flex Consumption plan hosting" — "While all
 * triggers are fully supported in a Flex Consumption plan..."). The
 * NCRONTAB schedule below fires at the top of every 5-minute mark
 * (00:00, 00:05, 00:10, ...).
 *
 * DOUBLE-READ RACE GUARD (peer review — AM-23 MAJOR 2): expiry is checked
 * TWICE — once on the initial read, and AGAIN via a fresh read taken
 * IMMEDIATELY before the ARM re-enable call. A fresh activation (or
 * extension) can land in the gap between those two points; the second
 * check catches it and aborts without touching ARM, rather than
 * re-enabling autoscale in the middle of a still-active (just-renewed)
 * override. The final row write (marking it inactive) uses THAT SECOND
 * read's ETag, so a further concurrent change between the ARM call and the
 * row write is detected (412) rather than silently overwritten — logged
 * and left alone (see the trailing catch) since ARM is by then correctly
 * re-enabled regardless of who "owns" the row.
 *
 * IDEMPOTENT ON ARM FAILURE: if the ARM re-enable call fails, this function
 * logs and (see FAILURE-AUDIT DEDUP below) writes AT MOST one failure audit
 * row per stuck episode, but deliberately does NOT clear the override row's
 * `active` flag — isOverrideExpired will still be true on the NEXT tick (at
 * most 5 minutes later), so a transient ARM failure self-heals via retry
 * rather than leaving the plan stuck disabled with no further attempt.
 *
 * FAILURE-AUDIT DEDUP (peer review MINOR 6): a PERSISTENTLY failing
 * re-enable would otherwise write a new failure audit row (and
 * scalingHistory entry) every 5 minutes, indefinitely. This function checks
 * ScalingOverrideEntity.reEnableFailureAudited before writing a failure
 * row — true after the FIRST failure for this episode — and skips the
 * audit write (still logging via context.error) on every subsequent tick
 * until the episode resolves (success, or a fresh activation/extension
 * resets the flag).
 *
 * actor/actorId are the fixed 'system:auto-reenable' sentinel (not a real
 * ClientPrincipal — there is no caller) — per this story's spec.
 */
export async function scalingOverrideReEnable(_myTimer: Timer, context: InvocationContext): Promise<void> {
  const correlationId = randomUUID();
  const logger: AuditLogger = { warn: (m) => context.warn(m), error: (m) => context.error(m), log: (m) => context.log(m) };

  const initialEntity = await getScalingOverride().catch((error) => {
    context.error(`scalingOverrideReEnable — failed to read override state | correlationId=${correlationId}`, error);
    return undefined;
  });
  if (!initialEntity || !isOverrideExpired(initialEntity)) {
    return;
  }

  // Second, fresh read immediately before the ARM call — see this
  // function's doc comment (DOUBLE-READ RACE GUARD).
  const freshEntity = await getScalingOverride().catch((error) => {
    context.error(`scalingOverrideReEnable — failed to re-read override state before the ARM call | correlationId=${correlationId}`, error);
    return undefined;
  });
  if (!freshEntity || !isOverrideExpired(freshEntity)) {
    context.log(`scalingOverrideReEnable — override changed between reads (reactivated/extended/cancelled) — skipping this tick | correlationId=${correlationId}`);
    return;
  }
  const entity = freshEntity;
  const target = entity.scalingPlanName;

  try {
    await setScalingPlanHostPoolEnabled(entity.resourceGroup, entity.scalingPlanName, entity.hostPoolId, true);
  } catch (error) {
    context.error(`scalingOverrideReEnable — ARM re-enable failed, will retry next tick | target=${target} correlationId=${correlationId}`, error);

    if (!entity.reEnableFailureAudited) {
      await writeAuditEntry(
        {
          actor: 'system:auto-reenable',
          actorId: 'system',
          action: AUDIT_ACTION,
          target,
          parameters: { expiresAt: entity.expiresAt, minutes: entity.minutes },
          outcome: 'failure',
          detail: error instanceof Error ? error.message : String(error),
          correlationId,
        },
        logger,
      );
      // Best-effort: mark the episode as "failure already audited" so the
      // next tick's (likely-also-failing) attempt doesn't write a duplicate
      // row. A failure to persist THIS flag just means the dedup doesn't
      // take effect yet — not fatal, and not worth its own retry loop.
      try {
        await replaceScalingOverride({ ...entity, reEnableFailureAudited: true }, entity.etag);
      } catch (flagError) {
        context.warn(`scalingOverrideReEnable — could not persist reEnableFailureAudited (dedup may not take effect until next successful write) | correlationId=${correlationId} error=${String(flagError)}`);
      }
    } else {
      context.log(`scalingOverrideReEnable — repeated failure for an already-audited episode; skipping duplicate audit row (see SCALING_OVERRIDE_STRANDED-style alerting on the context.error line above) | correlationId=${correlationId}`);
    }
    return;
  }

  try {
    await replaceScalingOverride({ ...entity, active: false }, entity.etag);
  } catch (storeError) {
    // ARM is correctly re-enabled — only the durable row is stale. Safe: a
    // stale active:true row either has an already-past expiresAt (this
    // function attempts the harmless, idempotent re-enable again next
    // tick) or was concurrently changed by another writer (cancel/a fresh
    // activation), whose own write is authoritative from here.
    context.error(`scalingOverrideReEnable — durable state write failed AFTER ARM re-enable (safe: will reconcile next tick) | target=${target} correlationId=${correlationId}`, storeError);
  }

  try {
    await writeAuditEntry(
      {
        actor: 'system:auto-reenable',
        actorId: 'system',
        action: AUDIT_ACTION,
        target,
        parameters: { expiresAt: entity.expiresAt, minutes: entity.minutes },
        outcome: 'success',
        correlationId,
      },
      logger,
    );
  } catch (auditError) {
    context.warn(`audit write threw unexpectedly (ignored — re-enable already succeeded) | correlationId=${correlationId} target=${target} error=${String(auditError)}`);
  }

  context.log(`scalingOverrideReEnable — auto-re-enabled autoscale | target=${target} correlationId=${correlationId}`);
}

app.timer('scalingOverrideReEnable', {
  schedule: '0 */5 * * * *',
  handler: scalingOverrideReEnable,
});
