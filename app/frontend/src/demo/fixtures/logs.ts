import type { LogsQueryResponse, LogsViewSummary } from '@avdmgr/shared';
import { HOUR, MINUTE, ago } from './time';
import { upn } from './estate';

export const LOG_VIEWS: LogsViewSummary[] = [
  { id: 'connection-failures', name: 'Connection failures', description: 'Connections that started but never reached Connected/Completed, left-joined to their WVDErrors row (a matching error is not always logged, so this still shows the failure even when no root-cause row exists).' },
  { id: 'fslogix-errors', name: 'FSLogix errors', description: 'Session hosts whose FSLogixHealthCheck agent health check has failed. Note: this check is disabled by default on the AVD service — this view may return no rows until it is enabled for the host pool.' },
  { id: 'session-disconnects', name: 'Session disconnects', description: 'Completed connections (the WVDConnections state recorded when a user or server disconnects a session), with duration where the matching Connected row is available.' },
  { id: 'host-health-history', name: 'Host health history', description: "WVDAgentHealthStatus rows over the selected window, newest first, showing each host's reported status and session counts." },
] satisfies LogsViewSummary[];

const users = ['alex.rivera', 'priya.nair', 'sam.okafor', 'li.wei', 'maria.santos', 'tom.becker', 'aisha.khan', 'jonas.lind'];
const clients = [
  ['Windows', 'Microsoft.RDInfra.RDClient'],
  ['macOS', 'Microsoft.RDInfra.RDClientMac'],
  ['Web', 'Microsoft.RDInfra.RDWebClient'],
] as const;

/** Deterministic canned result tables, one per curated view; times are relative to `now`. */
export function buildViewResult(viewId: string, now: number): LogsQueryResponse | undefined {
  switch (viewId) {
    case 'connection-failures':
      return {
        tables: [
          {
            name: 'PrimaryResult',
            columns: [
              { name: 'StartTime', type: 'datetime' },
              { name: 'UserName', type: 'string' },
              { name: 'SessionHostName', type: 'string' },
              { name: 'ClientOS', type: 'string' },
              { name: 'ClientType', type: 'string' },
              { name: 'Code', type: 'int' },
              { name: 'CodeSymbolic', type: 'string' },
              { name: 'Message', type: 'string' },
            ],
            rows: [
              [ago(now, 22 * MINUTE), upn('tom.becker'), 'avd-con-5', 'Windows 11', 'Microsoft.RDInfra.RDClient', 3019, 'ConnectionFailedClientDisconnect', 'The client disconnected before the connection completed.'],
              [ago(now, 47 * MINUTE), upn('aisha.khan'), 'avd-con-5', 'macOS 15', 'Microsoft.RDInfra.RDClientMac', 7, 'ConnectionFailedNoHealthyRdshAvailable', 'No healthy session host was available.'],
              [ago(now, 2 * HOUR), upn('jonas.lind'), 'avd-con-5', 'Windows 11', 'Microsoft.RDInfra.RDClient', 1, 'ConnectionFailedUserHasValidSessionButRdshIsUnhealthy', 'Existing session on an unhealthy host.'],
              [ago(now, 5 * HOUR), upn('li.wei'), 'avd-con-3', 'Web', 'Microsoft.RDInfra.RDWebClient', null, null, null],
            ],
            truncated: false,
          },
        ],
      };
    case 'fslogix-errors':
      return {
        tables: [
          {
            name: 'PrimaryResult',
            columns: [
              { name: 'TimeGenerated', type: 'datetime' },
              { name: 'SessionHostName', type: 'string' },
              { name: 'HealthCheckResult', type: 'string' },
              { name: 'Status', type: 'string' },
              { name: 'AgentVersion', type: 'string' },
            ],
            rows: [
              [ago(now, 3 * MINUTE), 'avd-con-5', 'HealthCheckFailed', 'Unavailable', '1.0.10602.1500'],
              [ago(now, 8 * MINUTE), 'avd-con-5', 'HealthCheckFailed', 'Unavailable', '1.0.10602.1500'],
              [ago(now, 13 * MINUTE), 'avd-con-5', 'HealthCheckFailed', 'Unavailable', '1.0.10602.1500'],
            ],
            truncated: false,
          },
        ],
      };
    case 'session-disconnects':
      return {
        tables: [
          {
            name: 'PrimaryResult',
            columns: [
              { name: 'EndTime', type: 'datetime' },
              { name: 'UserName', type: 'string' },
              { name: 'SessionHostName', type: 'string' },
              { name: 'ConnectionType', type: 'string' },
              { name: 'Duration', type: 'timespan' },
            ],
            rows: users.map((user, index) => [ago(now, (index * 37 + 12) * MINUTE), upn(user), `avd-con-${index % 4}`, clients[index % 3][1], `0${index % 4}:${String((index * 13) % 60).padStart(2, '0')}:00`]),
            truncated: false,
          },
        ],
      };
    case 'host-health-history':
      return {
        tables: [
          {
            name: 'PrimaryResult',
            columns: [
              { name: 'TimeGenerated', type: 'datetime' },
              { name: 'SessionHostName', type: 'string' },
              { name: 'Status', type: 'string' },
              { name: 'ActiveSessions', type: 'int' },
              { name: 'InactiveSessions', type: 'int' },
              { name: 'AgentVersion', type: 'string' },
              { name: 'LastHeartBeat', type: 'datetime' },
            ],
            rows: [0, 1, 2, 3, 5].flatMap((host) =>
              [0, 1, 2].map((tick) => [ago(now, (tick * 5 + host) * MINUTE), `avd-con-${host}`, host === 5 ? 'Unavailable' : 'Available', host === 5 ? 0 : 3 - (host % 2), host % 3, host === 5 ? '1.0.10602.1500' : '1.0.10863.2100', ago(now, (tick * 5 + host) * MINUTE + 20_000)]),
            ),
            truncated: false,
          },
        ],
      };
    default:
      return undefined;
  }
}

/** Raw KQL is not executed in the demo — every query returns this canned note table. */
export function buildRawKqlNote(kql: string): LogsQueryResponse {
  return {
    tables: [
      {
        name: 'Demo',
        columns: [
          { name: 'Note', type: 'string' },
          { name: 'YourQuery', type: 'string' },
        ],
        rows: [['The public demo has no Log Analytics workspace, so ad-hoc KQL is not executed. Try the curated views above for realistic sample results.', kql.length > 200 ? `${kql.slice(0, 200)}…` : kql]],
        truncated: false,
      },
    ],
  };
}
