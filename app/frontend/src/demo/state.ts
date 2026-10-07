import type { AlertSummary, AuditEntryDto, DesktopAssignment, ImageBuildDetail, ScalingPlanDetail, SessionHost, UserSession } from '@avdmgr/shared';
import { buildAlerts } from './fixtures/alerts';
import { buildAssignments } from './fixtures/access';
import { buildAudit } from './fixtures/audit';
import { WORKSPACE_FRIENDLY_NAME } from './fixtures/estate';
import { buildImageBuilds } from './fixtures/imageBuilds';
import { buildScalingPlan } from './fixtures/scaling';
import { buildSessionHosts, buildSessions } from './fixtures/sessionHosts';
import { fakeGuid } from './fixtures/time';
import { demoUserDetails, getDemoRole } from './identity';

/**
 * AM-60 — the demo's mutable in-memory "Azure". Seeded from the (typed,
 * deterministic) fixtures with `now = Date.now()` at init, so relative
 * timestamps ("12 minutes ago") read naturally on every visit while the
 * content itself never changes. Reset with resetDemoState().
 */
export interface EmergencyOverrideState {
  activatedBy: string;
  activatedAt: number;
  expiresAt: number;
  minutes: number;
  reason: string;
}

export interface DemoState {
  now: number;
  sessionHosts: SessionHost[];
  sessions: UserSession[];
  alerts: AlertSummary[];
  scalingPlan: ScalingPlanDetail;
  override: EmergencyOverrideState | undefined;
  audit: AuditEntryDto[];
  assignments: DesktopAssignment[];
  workspaceFriendlyName: string;
  builds: ImageBuildDetail[];
  /** Pending simulated power transitions, cleared on reset. */
  timers: Set<ReturnType<typeof setTimeout>>;
  auditCounter: number;
}

function createState(now: number): DemoState {
  return {
    now,
    sessionHosts: buildSessionHosts(now),
    sessions: buildSessions(now),
    alerts: buildAlerts(now),
    scalingPlan: buildScalingPlan(),
    override: undefined,
    audit: buildAudit(now),
    assignments: buildAssignments(),
    workspaceFriendlyName: WORKSPACE_FRIENDLY_NAME,
    builds: buildImageBuilds(now),
    timers: new Set(),
    auditCounter: 0,
  };
}

let state: DemoState | undefined;

export function getDemoState(): DemoState {
  state ??= createState(Date.now());
  return state;
}

/** Re-seeds everything (and cancels pending simulated power transitions). */
export function resetDemoState(now: number = Date.now()): DemoState {
  state?.timers.forEach((timer) => clearTimeout(timer));
  state = createState(now);
  return state;
}

/** Session hosts as the API returns them: activeSessions always reflects the live session list. */
export function hostsView(current: DemoState): SessionHost[] {
  return current.sessionHosts.map((host) => ({
    ...host,
    activeSessions: current.sessions.filter((session) => session.sessionHostName === host.name).length,
  }));
}

export interface AuditInput {
  action: string;
  target: string;
  reason?: string;
  outcome?: AuditEntryDto['outcome'];
  hasParameters?: boolean;
}

/** Prepends an audit row attributed to the current demo identity, so /audit and the "Recent actions" drawer show the visitor's activity. */
export function recordAudit(current: DemoState, input: AuditInput): AuditEntryDto {
  current.auditCounter += 1;
  const entry: AuditEntryDto = {
    id: fakeGuid(5000 + current.auditCounter),
    occurredAt: new Date().toISOString(),
    actor: demoUserDetails(getDemoRole()),
    action: input.action,
    target: input.target,
    reason: input.reason,
    outcome: input.outcome ?? 'success',
    correlationId: fakeGuid(6000 + current.auditCounter),
    hasParameters: input.hasParameters ?? false,
  };
  current.audit.unshift(entry);
  return entry;
}

/** Schedules a simulated transition; tracked so reset can cancel it. */
export function later(current: DemoState, ms: number, fn: () => void): void {
  const timer = setTimeout(() => {
    current.timers.delete(timer);
    fn();
  }, ms);
  current.timers.add(timer);
}
