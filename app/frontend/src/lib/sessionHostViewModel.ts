import type { HealthCheck, PowerState, SessionHost, SessionHostStatus } from '@avdmgr/shared';
import type { StatusTone } from '../components/StatusBadge';
import { sessionHostStatusTone } from './sessionHostStatusTone';
import { minutesSince } from './format';

/** Same threshold Dashboard.tsx's heartbeat table used before AM-31 item 33 — a running host with no heartbeat in over 30 minutes is stale. */
export const STALE_HEARTBEAT_MINUTES = 30;

/** Health checks where anything other than a clean "Succeeded" result should read as a warning, not a failure — mirrors HostPool.tsx's own WARN_ONLY_CHECKS (TURN relay is best-effort; a bad NAT path doesn't always block sessions). */
const WARN_ONLY_CHECKS = new Set(['TURNRelayAccessHealthCheck']);

export type HealthCheckSeverity = 'ok' | 'warn' | 'fail';

export function healthCheckSeverity(check: HealthCheck): HealthCheckSeverity {
  if (check.healthCheckResult === 'HealthCheckSucceeded') return 'ok';
  return WARN_ONLY_CHECKS.has(check.name) ? 'warn' : 'fail';
}

/**
 * AM-31 item 33 — the ONE view model both Dashboard and Host Pool build
 * their SessionHostCard grids from, replacing the two pages' previously
 * DIFFERENT column sets (Dashboard's heartbeat table had host/status/
 * power-state/heartbeat; Host Pool's table had host/status/power-state/
 * agent-version/sessions/allow-new-session/health-checks/actions — neither
 * was a subset of the other). Every field a SessionHostCard can show lives
 * here, computed once per host per render from the raw SessionHost plus
 * whatever context (host pool's maxSessionLimit, "now") the caller has.
 */
export interface SessionHostViewModel {
  id: string;
  name: string;
  status: SessionHostStatus;
  tone: StatusTone;
  allowNewSession: boolean;
  activeSessions: number;
  /** From the host pool's maxSessionLimit — undefined when the caller doesn't have host pool data loaded (the occupancy bar renders session count alone in that case). */
  maxSessions: number | undefined;
  powerState: PowerState | undefined;
  agentVersion: string | undefined;
  lastHeartBeat: string | undefined;
  /** True when the host is powered on but hasn't reported a heartbeat in over STALE_HEARTBEAT_MINUTES — same rule Dashboard's heartbeat table used. */
  heartbeatStale: boolean;
  healthChecks: HealthCheck[] | undefined;
  /** "6/7 checks" — undefined when no health checks were reported at all (distinct from "0/0", which would misleadingly read as passing). */
  healthCheckSummary: { passed: number; total: number } | undefined;
}

/**
 * Peer review MAJOR 10 — a host reporting a healthy ARM `status` (tone
 * 'ok') can still be actively sick per THIS app's own signals: a stale
 * heartbeat while running, or a failing/warning health check. Only escalates
 * FROM 'ok' — every other tone already reads as a problem (or a deliberate
 * pending/off state) from `status` alone, so there's nothing to escalate.
 * 'fail' outranks a stale heartbeat/'warn' check (reads as 'error', the more
 * urgent tone); a stale heartbeat or a 'warn' check alone reads as
 * 'warning'.
 */
function escalateTone(baseTone: StatusTone, heartbeatStale: boolean, healthChecks: HealthCheck[] | undefined): StatusTone {
  if (baseTone !== 'ok') return baseTone;
  const severities = (healthChecks ?? []).map(healthCheckSeverity);
  if (severities.includes('fail')) return 'error';
  if (heartbeatStale || severities.includes('warn')) return 'warning';
  return baseTone;
}

/**
 * Peer review MAJOR 3 — a compact estate-wide rollup ("N available · N
 * draining · N unavailable") replacing the deleted HealthRing donut, without
 * restoring a chart (per the ruling on that item). `draining` takes priority
 * over the status-derived buckets: a host with allowNewSession: false is
 * counted there regardless of its current `status`, since "administratively
 * not accepting sessions" is the more actionable fact for this rollup than
 * whatever transient status it happens to report. Everything else splits on
 * sessionHostStatusTone: 'ok' → available, anything else → unavailable.
 */
export interface EstateRollupCounts {
  available: number;
  draining: number;
  unavailable: number;
}

export function estateRollupCounts(hosts: SessionHost[]): EstateRollupCounts {
  let available = 0;
  let draining = 0;
  let unavailable = 0;
  for (const host of hosts) {
    if (!host.allowNewSession) {
      draining += 1;
    } else if (sessionHostStatusTone(host.status) === 'ok') {
      available += 1;
    } else {
      unavailable += 1;
    }
  }
  return { available, draining, unavailable };
}

export function toSessionHostViewModel(host: SessionHost, opts: { maxSessions?: number; now?: Date } = {}): SessionHostViewModel {
  const now = opts.now ?? new Date();
  const staleMinutes = minutesSince(host.lastHeartBeat, now);
  const heartbeatStale = host.powerState === 'running' && staleMinutes !== undefined && staleMinutes > STALE_HEARTBEAT_MINUTES;

  const healthChecks = host.healthChecks;
  const healthCheckSummary = healthChecks && healthChecks.length > 0 ? { passed: healthChecks.filter((c) => healthCheckSeverity(c) === 'ok').length, total: healthChecks.length } : undefined;

  return {
    id: host.id,
    name: host.name,
    status: host.status,
    tone: escalateTone(sessionHostStatusTone(host.status), heartbeatStale, healthChecks),
    allowNewSession: host.allowNewSession,
    activeSessions: host.activeSessions,
    maxSessions: opts.maxSessions,
    powerState: host.powerState,
    agentVersion: host.agentVersion,
    lastHeartBeat: host.lastHeartBeat,
    heartbeatStale,
    healthChecks,
    healthCheckSummary,
  };
}
