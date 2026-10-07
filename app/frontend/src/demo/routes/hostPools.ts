import type {
  BroadcastSessionMessageRequest,
  BroadcastSessionMessageResponse,
  DrainSessionHostRequest,
  DrainSessionHostResponse,
  ForceLogoffSessionRequest,
  ForceLogoffSessionResponse,
  HealthSummary,
  LogoffAllDisconnectedRequest,
  LogoffAllDisconnectedResponse,
  PowerState,
  RegistrationTokenStatus,
  SendSessionMessageRequest,
  SendSessionMessageResponse,
  SessionHost,
  SessionHostPowerRequest,
  SessionHostPowerResponse,
  UserSession,
  VmTemplateInfo,
} from '@avdmgr/shared';
import { buildHostPools, buildVmTemplate, HOST_POOL_NAME } from '../fixtures/estate';
import { buildPolicyHealth } from '../fixtures/policyHealth';
import { ahead, HOUR } from '../fixtures/time';
import { badRequest, conflict, disable, notFound, read, simulate } from '../router';
import { hostsView, later, recordAudit, type DemoState } from '../state';

const HP = '/v1/hostpools/:hostPoolName';
const BATCH_RESULT_EMPTY = { attempted: 0, succeeded: 0, skipped: 0, failed: [] } as const;

function requireHostPool(name: string): void {
  if (name !== HOST_POOL_NAME) throw notFound(`Host pool "${name}" does not exist in the demo estate.`);
}

function requireHost(state: DemoState, name: string) {
  const host = state.sessionHosts.find((candidate) => candidate.name === name);
  if (!host) throw notFound(`Session host "${name}" does not exist in the demo estate.`);
  return host;
}

function requireReason(reason: string | undefined): string {
  const trimmed = reason?.trim();
  if (!trimmed) throw badRequest('A reason is required.');
  return trimmed;
}

export function computeHealthSummary(state: DemoState): HealthSummary {
  const hosts = hostsView(state);
  const pool = buildHostPools()[0];
  return {
    hostPoolName: HOST_POOL_NAME,
    total: hosts.length,
    available: hosts.filter((host) => host.allowNewSession && host.status === 'Available').length,
    unavailable: hosts.filter((host) => host.allowNewSession && host.status !== 'Available').length,
    draining: hosts.filter((host) => !host.allowNewSession).length,
    sessionsUsed: hosts.reduce((total, host) => total + host.activeSessions, 0),
    sessionsMax: (pool.maxSessionLimit ?? 0) * hosts.length,
  } satisfies HealthSummary;
}

/** Applies a scripted ~3 s power transition: intermediate state now, final state later. */
function transitionPower(state: DemoState, host: SessionHost, transient: PowerState, final: PowerState, finalStatus: SessionHost['status']): void {
  host.powerState = transient;
  host.status = final === 'running' ? 'Unavailable' : host.status;
  later(state, 3_000, () => {
    host.powerState = final;
    host.status = finalStatus;
    if (final === 'running') host.lastHeartBeat = new Date().toISOString();
  });
}

function removeSessions(state: DemoState, predicate: (session: UserSession) => boolean): UserSession[] {
  const removed = state.sessions.filter(predicate);
  state.sessions = state.sessions.filter((session) => !predicate(session));
  return removed;
}

export function registerHostPoolRoutes(): void {
  read('/v1/hostpools', () => buildHostPools().map((pool) => ({ ...pool, sessionHostCount: 6 })));

  read(`${HP}/sessionhosts`, ({ params, state }) => {
    requireHostPool(params.hostPoolName);
    return hostsView(state);
  });

  read(`${HP}/policy-health`, ({ params, state }) => {
    requireHostPool(params.hostPoolName);
    return buildPolicyHealth(state.now);
  });

  simulate<DrainSessionHostResponse, DrainSessionHostRequest>('PATCH', `${HP}/sessionhosts/:sessionHostName/drain`, ({ params, body, state }) => {
    requireHostPool(params.hostPoolName);
    const host = requireHost(state, params.sessionHostName);
    if (typeof body?.allowNewSession !== 'boolean') throw badRequest('allowNewSession (boolean) is required.');
    host.allowNewSession = body.allowNewSession;
    recordAudit(state, { action: 'sessionhost.drain', target: host.name, reason: body.reason, hasParameters: true });
    return { sessionHost: hostsView(state).find((candidate) => candidate.name === host.name) as SessionHost };
  });

  disable('POST', `${HP}/registration-token`, 'Generating a registration token');

  read<RegistrationTokenStatus>(`${HP}/registration-token`, ({ params, state }) => {
    requireHostPool(params.hostPoolName);
    return { exists: true, expirationTime: ahead(state.now, 20 * HOUR) };
  });

  read<VmTemplateInfo>(`${HP}/vm-template`, ({ params }) => {
    requireHostPool(params.hostPoolName);
    return buildVmTemplate();
  });

  simulate<SessionHostPowerResponse, SessionHostPowerRequest>('POST', `${HP}/sessionhosts/:sessionHostName/power`, ({ params, body, state }) => {
    requireHostPool(params.hostPoolName);
    const host = requireHost(state, params.sessionHostName);
    const action = body?.action;
    if (action === 'start') {
      if (host.powerState === 'running') throw conflict(`${host.name} is already running.`);
      transitionPower(state, host, 'starting', 'running', 'Available');
    } else if (action === 'restart') {
      removeSessions(state, (session) => session.sessionHostName === host.name);
      transitionPower(state, host, 'starting', 'running', 'Available');
    } else if (action === 'deallocate') {
      removeSessions(state, (session) => session.sessionHostName === host.name);
      transitionPower(state, host, 'deallocating', 'deallocated', 'Shutdown');
    } else {
      throw badRequest('action must be one of start, restart, deallocate.');
    }
    const entry = recordAudit(state, { action: 'sessionhost.power', target: host.name, reason: body.reason, outcome: 'accepted', hasParameters: true });
    return { status: 'accepted', action, sessionHostName: host.name, correlationId: entry.correlationId };
  });

  read<UserSession[]>(`${HP}/sessions`, ({ params, state }) => {
    requireHostPool(params.hostPoolName);
    return state.sessions.slice();
  });

  simulate<ForceLogoffSessionResponse, ForceLogoffSessionRequest>('POST', `${HP}/sessionhosts/:sessionHostName/sessions/:sessionId/logoff`, ({ params, body, state }) => {
    requireHostPool(params.hostPoolName);
    const reason = requireReason(body?.reason);
    const removed = removeSessions(state, (session) => session.sessionHostName === params.sessionHostName && session.sessionId === params.sessionId);
    if (removed.length === 0) throw notFound('That session no longer exists.');
    recordAudit(state, { action: 'session.logoff', target: `${params.sessionHostName} / session ${params.sessionId}`, reason, hasParameters: true });
    return { sessionId: params.sessionId };
  });

  simulate<SendSessionMessageResponse, SendSessionMessageRequest>('POST', `${HP}/sessionhosts/:sessionHostName/sessions/:sessionId/message`, ({ params, body, state }) => {
    requireHostPool(params.hostPoolName);
    if (!body?.body?.trim()) throw badRequest('A message body is required.');
    const exists = state.sessions.some((session) => session.sessionHostName === params.sessionHostName && session.sessionId === params.sessionId);
    if (!exists) throw notFound('That session no longer exists.');
    recordAudit(state, { action: 'session.message', target: `${params.sessionHostName} / session ${params.sessionId}`, reason: body.title, hasParameters: true });
    return { sessionId: params.sessionId };
  });

  simulate<LogoffAllDisconnectedResponse, LogoffAllDisconnectedRequest>('POST', `${HP}/sessions/logoff-disconnected`, ({ params, body, state }) => {
    requireHostPool(params.hostPoolName);
    const reason = requireReason(body?.reason);
    const removed = removeSessions(state, (session) => session.sessionState === 'Disconnected');
    const entry = recordAudit(state, { action: 'sessions.logoff-disconnected', target: HOST_POOL_NAME, reason, hasParameters: true });
    return { result: { ...BATCH_RESULT_EMPTY, attempted: removed.length, succeeded: removed.length, failed: [] }, correlationId: entry.correlationId };
  });

  simulate<BroadcastSessionMessageResponse, BroadcastSessionMessageRequest>('POST', `${HP}/sessions/broadcast`, ({ params, body, state }) => {
    requireHostPool(params.hostPoolName);
    if (!body?.body?.trim()) throw badRequest('A message body is required.');
    const active = state.sessions.filter((session) => session.sessionState === 'Active').length;
    const entry = recordAudit(state, { action: 'sessions.broadcast', target: HOST_POOL_NAME, reason: body.title, hasParameters: true });
    return { result: { ...BATCH_RESULT_EMPTY, attempted: active, succeeded: active, failed: [] }, correlationId: entry.correlationId };
  });
}
