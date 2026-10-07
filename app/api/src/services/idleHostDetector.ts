import type { IdleHostFinding, PowerState, ScalingPhase, SessionHost } from '@avdmgr/shared';

/**
 * Pure idle-host detection rule (AM-25). Kept separate from
 * costService/idle-hosts data-fetching so it can be unit tested against
 * fixture schedules without any Azure SDK involved — mirrors the
 * healthService.ts / categorizeSessionHost pattern (M1/M2).
 *
 * The rule: a host is flagged when it is currently powered on (running or
 * mid-start), the scaling plan's phase for right now is RampDown or
 * OffPeak (i.e. the schedule expects hosts to be scaling IN, not up), and
 * it has zero ACTIVE sessions. This mirrors the known, documented
 * behavioral characteristic of SCALE-CONTOSO-PROD's schedule — see
 * The scaling-plan runbook §6 "Known observation — idle-host
 * leak" and the scaling-and-cost runbook §3 "Diagnosing the
 * idle-host leak": rampDownStopHostsWhen: ZeroActiveSessions combined with
 * rampDownForceLogoffUsers: false means a disconnected-but-not-signed-out
 * session can keep a host (avd-con-0 on this estate) running all night
 * despite the 20:00 off-peak transition.
 *
 * PEER REVIEW FIX (AM-25 round 2): the first version of this rule used
 * SessionHost.activeSessions (ARM's raw, undifferentiated `sessions`
 * count) as the zero-sessions gate — which meant a host stuck in EXACTLY
 * the documented leak scenario (one lingering disconnected session, zero
 * genuinely active ones) could never be flagged, directly contradicting
 * the evidence text. This version takes activeSessions/disconnectedSessions
 * as separate inputs, sourced from per-session sessionState via
 * listUserSessions (see idleHostsService.ts/savingsService.ts) — the gate
 * is activeSessions === 0 specifically, and disconnectedSessions is
 * reported as evidence, not used to gate.
 *
 * RampUp and Peak are intentionally excluded — a host running during those
 * phases is exactly what the schedule intends, regardless of session
 * count (a host can legitimately sit warm with 0 sessions right after
 * ramp-up, before the first user connects).
 */

const OFF_SCHEDULE_PHASES: readonly ScalingPhase[] = ['RampDown', 'OffPeak'];
const RUNNING_POWER_STATES: readonly PowerState[] = ['running', 'starting'];

export interface IdleHostDetectorInput {
  hostPoolName: string;
  host: Pick<SessionHost, 'name' | 'powerState'>;
  /** The scaling plan's current phase, e.g. from computeScalingPhase(plan). */
  phase: ScalingPhase;
  /** Count of sessions with sessionState === 'Active' on this host, right now — NOT SessionHost.activeSessions (see that field's doc comment in @avdmgr/shared). */
  activeSessions: number;
  /** Count of sessions with sessionState === 'Disconnected' on this host, right now. */
  disconnectedSessions: number;
}

/**
 * Builds evidence text that states only what was actually observed for
 * THIS host — never a generic boilerplate paragraph — so a reader can tell
 * at a glance whether this is (a) the documented disconnected-session leak
 * (disconnectedSessions > 0) or (b) a host with no session-based
 * explanation for being up at all (disconnectedSessions === 0), which is a
 * DIFFERENT situation (e.g. a manual/StartVMOnConnect start with nobody
 * ever connecting, or a stuck deallocation) that the leak documentation
 * does not describe.
 */
function buildReason(phase: ScalingPhase, disconnectedSessions: number): string {
  if (disconnectedSessions > 0) {
    const plural = disconnectedSessions === 1 ? 'session' : 'sessions';
    return (
      `Running during ${phase} with zero active sessions but ${disconnectedSessions} disconnected ${plural} — ` +
      'matches the documented idle-host leak (the scaling-plan runbook §6): a disconnected-but-not-signed-out ' +
      'session keeps the host up, since rampDownForceLogoffUsers is deliberately false on this estate.'
    );
  }
  return (
    `Running during ${phase} with zero sessions of any kind (no active, no disconnected) — the schedule expects hosts ` +
    'to be scaling in during this phase, and there is no session-based explanation for this one being up. Not the ' +
    'documented disconnected-session leak (the scaling-plan runbook §6) — check for a manual start or a ' +
    'StartVMOnConnect trigger with nobody having connected yet.'
  );
}

/**
 * Evaluates a single host. Returns null when the host does not meet the
 * idle criteria (not flagged) rather than a finding with a "not idle"
 * marker — callers filter out nulls (see detectIdleHosts).
 */
export function detectIdleHost(input: IdleHostDetectorInput): IdleHostFinding | null {
  const { hostPoolName, host, phase, activeSessions, disconnectedSessions } = input;

  if (!OFF_SCHEDULE_PHASES.includes(phase)) {
    return null;
  }
  if (!host.powerState || !RUNNING_POWER_STATES.includes(host.powerState)) {
    return null;
  }
  if (activeSessions > 0) {
    return null;
  }

  return {
    sessionHostName: host.name,
    hostPoolName,
    powerState: host.powerState,
    phase,
    activeSessions,
    disconnectedSessions,
    reason: buildReason(phase, disconnectedSessions),
  };
}

/** Evaluates every host in `inputs`, returning only the ones flagged as idle. */
export function detectIdleHosts(inputs: IdleHostDetectorInput[]): IdleHostFinding[] {
  return inputs.map(detectIdleHost).filter((finding): finding is IdleHostFinding => finding !== null);
}
