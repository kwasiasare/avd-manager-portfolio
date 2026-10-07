import type { HealthCheck, SessionHost, SessionHostImageCorrelation, UserSession } from '@avdmgr/shared';
import { HOUR, MINUTE, ago } from './time';
import { HOST_POOL_ARM_ID, HOST_POOL_NAME, upn } from './estate';

const hostId = (name: string) => `${HOST_POOL_ARM_ID}/sessionHosts/${name}`;

const HEALTHY_CHECKS: HealthCheck[] = [
  { name: 'DomainJoinedCheck', healthCheckResult: 'HealthCheckSucceeded' },
  { name: 'DomainTrustCheck', healthCheckResult: 'HealthCheckSucceeded' },
  { name: 'FSLogixHealthCheck', healthCheckResult: 'HealthCheckSucceeded' },
  { name: 'SxSStackListenerCheck', healthCheckResult: 'HealthCheckSucceeded' },
  { name: 'UrlsAccessibleCheck', healthCheckResult: 'HealthCheckSucceeded' },
  { name: 'MonitoringAgentCheck', healthCheckResult: 'HealthCheckSucceeded' },
  { name: 'MetaDataServiceCheck', healthCheckResult: 'HealthCheckSucceeded' },
  { name: 'AppAttachHealthCheck', healthCheckResult: 'HealthCheckSucceeded' },
];

const UNHEALTHY_CHECKS: HealthCheck[] = HEALTHY_CHECKS.map((check) =>
  check.name === 'FSLogixHealthCheck'
    ? { ...check, healthCheckResult: 'HealthCheckFailed', additionalFailureDetails: 'FSLogix profile container service is not running (Windows service "frxsvc" stopped).' }
    : check.name === 'SxSStackListenerCheck'
      ? { ...check, healthCheckResult: 'HealthCheckFailed', additionalFailureDetails: 'The SxS stack listener is not ready to accept connections.' }
      : check,
);

/** 6 hosts: 4 healthy (one drained), 1 deallocated, 1 unavailable with failing checks. activeSessions is recomputed from the live session list on every read (see state.ts). */
export function buildSessionHosts(now: number): SessionHost[] {
  const base = { hostPoolName: HOST_POOL_NAME, osVersion: '10.0.26100', agentVersion: '1.0.10863.2100' } as const;
  return [
    { ...base, id: hostId('avd-con-0'), name: 'avd-con-0', status: 'Available', allowNewSession: true, activeSessions: 0, lastHeartBeat: ago(now, 40_000), healthChecks: HEALTHY_CHECKS, powerState: 'running' },
    { ...base, id: hostId('avd-con-1'), name: 'avd-con-1', status: 'Available', allowNewSession: true, activeSessions: 0, lastHeartBeat: ago(now, 55_000), healthChecks: HEALTHY_CHECKS, powerState: 'running' },
    { ...base, id: hostId('avd-con-2'), name: 'avd-con-2', status: 'Available', allowNewSession: false, activeSessions: 0, lastHeartBeat: ago(now, 30_000), healthChecks: HEALTHY_CHECKS, powerState: 'running' },
    { ...base, id: hostId('avd-con-3'), name: 'avd-con-3', status: 'Available', allowNewSession: true, activeSessions: 0, lastHeartBeat: ago(now, 20_000), healthChecks: HEALTHY_CHECKS, powerState: 'running' },
    { ...base, id: hostId('avd-con-4'), name: 'avd-con-4', status: 'Shutdown', allowNewSession: true, activeSessions: 0, lastHeartBeat: ago(now, 7 * HOUR), healthChecks: [], powerState: 'deallocated' },
    { ...base, id: hostId('avd-con-5'), name: 'avd-con-5', status: 'Unavailable', allowNewSession: true, activeSessions: 0, agentVersion: '1.0.10602.1500', lastHeartBeat: ago(now, 2 * MINUTE), healthChecks: UNHEALTHY_CHECKS, powerState: 'running' },
  ] satisfies SessionHost[];
}

/** Image-version correlation for the Images page timeline (host -> gallery version it was built from). */
export function buildHostCorrelations(): SessionHostImageCorrelation[] {
  return [
    { sessionHostName: 'avd-con-0', imageVersionName: '1.3.0' },
    { sessionHostName: 'avd-con-1', imageVersionName: '1.3.0' },
    { sessionHostName: 'avd-con-2', imageVersionName: '1.2.0' },
    { sessionHostName: 'avd-con-3', imageVersionName: '1.2.0' },
    { sessionHostName: 'avd-con-4', imageVersionName: '1.2.0' },
    { sessionHostName: 'avd-con-5', unknownReason: 'Host VM was built from a marketplace image, not a gallery version.' },
  ] satisfies SessionHostImageCorrelation[];
}

interface SessionSeed {
  host: string;
  user: string;
  state: UserSession['sessionState'];
  startedMinutesAgo: number;
  app?: string;
}

const SESSION_SEEDS: SessionSeed[] = [
  { host: 'avd-con-0', user: 'alex.rivera', state: 'Active', startedMinutesAgo: 95 },
  { host: 'avd-con-0', user: 'priya.nair', state: 'Active', startedMinutesAgo: 210 },
  { host: 'avd-con-0', user: 'sam.okafor', state: 'Disconnected', startedMinutesAgo: 400 },
  { host: 'avd-con-0', user: 'li.wei', state: 'Active', startedMinutesAgo: 35 },
  { host: 'avd-con-1', user: 'maria.santos', state: 'Active', startedMinutesAgo: 120 },
  { host: 'avd-con-1', user: 'tom.becker', state: 'Active', startedMinutesAgo: 60 },
  { host: 'avd-con-1', user: 'aisha.khan', state: 'Disconnected', startedMinutesAgo: 1500 },
  { host: 'avd-con-1', user: 'jonas.lind', state: 'Active', startedMinutesAgo: 15 },
  { host: 'avd-con-2', user: 'nina.petrova', state: 'Active', startedMinutesAgo: 480 },
  { host: 'avd-con-2', user: 'diego.alvarez', state: 'Disconnected', startedMinutesAgo: 2900 },
  { host: 'avd-con-3', user: 'grace.mensah', state: 'Active', startedMinutesAgo: 75 },
  { host: 'avd-con-3', user: 'oliver.price', state: 'Active', startedMinutesAgo: 180 },
  { host: 'avd-con-3', user: 'fatima.zahra', state: 'Active', startedMinutesAgo: 25 },
  { host: 'avd-con-3', user: 'ben.hartley', state: 'Disconnected', startedMinutesAgo: 600 },
];

export function buildSessions(now: number): UserSession[] {
  return SESSION_SEEDS.map((seed, index): UserSession => {
    const sessionId = String(index + 1);
    return {
      id: `${hostId(seed.host)}/userSessions/${sessionId}`,
      sessionId,
      userPrincipalName: upn(seed.user),
      sessionHostName: seed.host,
      hostPoolName: HOST_POOL_NAME,
      sessionState: seed.state,
      createTime: new Date(now - seed.startedMinutesAgo * MINUTE).toISOString(),
      applicationType: 'Desktop',
    };
  }) satisfies UserSession[];
}
