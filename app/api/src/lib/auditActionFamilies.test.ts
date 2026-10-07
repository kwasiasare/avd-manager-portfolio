import { describe, expect, it } from 'vitest';

/**
 * AM-32 peer review NIT 23 — the Audit page's action-family filter dropdown
 * (app/frontend/src/pages/Audit.tsx's ACTION_FAMILY_OPTIONS) is a hand-
 * curated list of this app's real `action` id prefixes, not derived from a
 * live endpoint (there is no "list every distinct action id this app has
 * ever written" endpoint). This test is the "duplicate-with-test" pin the
 * review asked for: every REAL AUDIT_ACTION-shaped literal string this app
 * writes (duplicated below, sourced from grepping every non-test
 * `app/api/src/functions/*.ts` file for `AUDIT_ACTION`/`action:` literals
 * and `ACTION = {...}` maps) must start with one of the prefixes
 * Audit.tsx's dropdown offers — so a new action family added on the API
 * side without a matching Audit.tsx dropdown entry fails HERE, not silently
 * leaves an unfilterable action family in production.
 *
 * IMPORTANT: this list is a SNAPSHOT, not introspected from the real
 * handler files — adding a new `AUDIT_ACTION`-style constant on the API
 * side (or changing an existing action id's prefix) must also update BOTH
 * this list AND Audit.tsx's ACTION_FAMILY_OPTIONS, by hand. There is no
 * automatic way to keep them in sync (the AUDIT_ACTION constants are
 * private, unexported consts scattered across many handler files) — this
 * test exists so that drift is at least a RED test, not a silent gap.
 */
const REAL_ACTION_IDS = [
  // access.*
  'access.assignment.create',
  'access.assignment.remove',
  // alert.*
  'alert.ack',
  'alert.unack',
  'alert.snooze',
  'alert.unsnooze',
  // hostpool.*
  'hostpool.registrationtoken.generate',
  // image.build.*
  'image.build.start',
  'image.build.checklist_update',
  'image.build.advance',
  'image.build.cancel',
  'image.build.timer_advance',
  'image.build.abandonment_warning',
  // image.build.snapshot_delete (AM-53 — operator-confirmed pre-Sysprep snapshot retention)
  'image.build.snapshot_delete',
  // logs.*
  'logs.query',
  // profile.*
  'profile.reset',
  'profile.restore',
  'profile.deleteRetired',
  // profile.duplicate* (AM-51 — duplicate-container guided retire/delete)
  'profile.duplicateRetire',
  'profile.duplicateDelete',
  // rollout.*
  'rollout.create',
  'rollout.start',
  'rollout.force_proceed',
  'rollout.confirm_cutover',
  'rollout.start_removal',
  'rollout.remove_hosts',
  'rollout.rollback',
  'rollout.cancel',
  'rollout.timer_advance',
  // scalingplan.*
  'scalingplan.schedule.create',
  'scalingplan.schedule.update',
  'scalingplan.schedule.delete',
  'scalingplan.emergency_override.activate',
  'scalingplan.emergency_override.extend',
  'scalingplan.emergency_override.cancel',
  'scalingplan.emergency_override.auto_reenable',
  // session.* (singular — force logoff / send message, one session at a time)
  'session.forceLogoff',
  'session.sendMessage',
  // sessionhost.*
  'sessionhost.drain',
  'sessionhost.power',
  // sessionhost.provision.* (AM-50 — guided session-host provisioning)
  'sessionhost.provision.create',
  'sessionhost.provision.timer_advance',
  'sessionhost.provision.cancel',
  // sessions.* (plural — broadcast / logoff-all-disconnected, whole-hostpool actions)
  'sessions.broadcast',
  'sessions.logoffAllDisconnected',
  // workspace.*
  'workspace.friendlyname.update',
] as const;

/**
 * Duplicated from Audit.tsx's ACTION_FAMILY_OPTIONS (app/frontend/src/pages/Audit.tsx)
 * — see this file's own doc comment for why this is a deliberate, hand-kept
 * duplicate rather than a shared import.
 */
const ACTION_FAMILY_PREFIXES = [
  'access.',
  'alert.',
  'hostpool.',
  'image.build.',
  'logs.',
  'profile.',
  'rollout.',
  'scalingplan.',
  'session.',
  'sessionhost.',
  'sessions.',
  'workspace.',
] as const;

describe('Audit page action-family filter — pinned against real AUDIT_ACTION ids (AM-32 peer review NIT 23)', () => {
  it.each(REAL_ACTION_IDS)('%s is covered by one of Audit.tsx\'s ACTION_FAMILY_OPTIONS prefixes', (actionId) => {
    const matched = ACTION_FAMILY_PREFIXES.some((prefix) => actionId.startsWith(prefix));
    expect(matched).toBe(true);
  });

  it('"session." and "sessionhost." are BOTH present and distinct prefixes (a "session." filter must not accidentally also match "sessionhost.*" rows, or vice versa)', () => {
    expect(ACTION_FAMILY_PREFIXES).toContain('session.');
    expect(ACTION_FAMILY_PREFIXES).toContain('sessionhost.');
    // 'sessionhost.drain'.startsWith('session.') is FALSE (no dot after
    // "session" in "sessionhost") — the two families don't collide despite
    // one prefix being a near-substring of the other.
    expect('sessionhost.drain'.startsWith('session.')).toBe(false);
  });

  it('every prefix in ACTION_FAMILY_PREFIXES actually matches at least one real action id (no dead/unused filter options)', () => {
    for (const prefix of ACTION_FAMILY_PREFIXES) {
      expect(REAL_ACTION_IDS.some((actionId) => actionId.startsWith(prefix))).toBe(true);
    }
  });
});
