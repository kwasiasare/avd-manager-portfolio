import type { SessionHostPowerAction } from '@avdmgr/shared';

/**
 * AM-31 item 33 — extracted out of HostPool.tsx so Dashboard.tsx's own
 * SessionHostCard-driven power-action flow (see that page) can share the
 * exact same copy/behavior rather than a second hand-copied set of these
 * three small helpers.
 */

/** Human label for a power action, used in dialog titles/buttons and success toasts. */
export function powerActionLabel(action: SessionHostPowerAction): string {
  switch (action) {
    case 'start':
      return 'Start';
    case 'restart':
      return 'Restart';
    case 'deallocate':
      return 'Deallocate';
  }
}

/** Gerund form for the sessions-warning dialog's body text (e.g. "Restarting", "Deallocating") — kept separate from powerActionLabel rather than a naive `${label}ing` concatenation, which mangles "Deallocate" into "Deallocateing". */
export function powerActionGerund(action: SessionHostPowerAction): string {
  switch (action) {
    case 'start':
      return 'Starting';
    case 'restart':
      return 'Restarting';
    case 'deallocate':
      return 'Deallocating';
  }
}

/**
 * Restart/deallocate are disruptive to any session currently on the host;
 * start is not (there's nothing running to interrupt). Used to decide
 * whether the power-action flow inserts the sessions-warning step (AM-19's
 * "drain-first prompt") before the typed-name/reason confirm.
 */
export function isDisruptivePowerAction(action: SessionHostPowerAction): boolean {
  return action === 'restart' || action === 'deallocate';
}
