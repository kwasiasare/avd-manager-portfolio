import type { AuditEntryDto } from '@avdmgr/shared';
import { MINUTE, ago, fakeGuid } from './time';
import { HOST_POOL_NAME, upn } from './estate';

interface Seed {
  minutesAgo: number;
  actor: string;
  action: string;
  target: string;
  reason?: string;
  outcome?: AuditEntryDto['outcome'];
  hasParameters?: boolean;
}

const A = upn('priya.nair');
const B = upn('sam.okafor');
const C = upn('li.wei');
const SYSTEM = 'system@contoso.example';

/** 50 rows spread over ~7 days, newest first, across every action family the Audit page filters on. */
const SEEDS: Seed[] = [
  { minutesAgo: 8, actor: B, action: 'alert.ack', target: 'Session host heartbeat missing', reason: 'Expected - host deallocated by autoscale.' },
  { minutesAgo: 30, actor: A, action: 'sessionhost.drain', target: 'avd-con-2', reason: 'Draining before the rollout window.', hasParameters: true },
  { minutesAgo: 52, actor: SYSTEM, action: 'scalingplan.schedule.update', target: 'Weekdays', reason: 'Autoscale ramp-up adjusted by plan.', hasParameters: true },
  { minutesAgo: 75, actor: C, action: 'sessions.broadcast', target: HOST_POOL_NAME, reason: 'Maintenance notice', hasParameters: true },
  { minutesAgo: 110, actor: B, action: 'session.logoff', target: 'avd-con-1 / session 7', reason: 'Stuck session reported by user.' },
  { minutesAgo: 140, actor: A, action: 'sessionhost.power', target: 'avd-con-4', reason: 'Start for testing.', outcome: 'accepted', hasParameters: true },
  { minutesAgo: 190, actor: C, action: 'image.build.start', target: 'Image build 1.4.0', reason: 'Monthly patch image.', outcome: 'accepted', hasParameters: true },
  { minutesAgo: 230, actor: C, action: 'image.build.advance', target: 'Image build 1.4.0 (vm_ready)', outcome: 'success' },
  { minutesAgo: 320, actor: A, action: 'workspace.friendlyname.update', target: 'WS-CONTOSO-PROD', reason: 'Rebrand to Contoso Desktop.', hasParameters: true },
  { minutesAgo: 400, actor: B, action: 'alert.snooze', target: 'Log Analytics ingestion near daily cap', reason: 'Known - month-end import running.', hasParameters: true },
  { minutesAgo: 480, actor: A, action: 'access.assignment.create', target: 'SG-AVD-Users-Support', reason: 'Support team onboarding.', hasParameters: true },
  { minutesAgo: 600, actor: B, action: 'sessionhost.power', target: 'avd-con-4', reason: 'Scheduled deallocate.', outcome: 'accepted', hasParameters: true },
  { minutesAgo: 780, actor: SYSTEM, action: 'scalingplan.schedule.update', target: 'Friday-early-close', hasParameters: true },
  { minutesAgo: 900, actor: C, action: 'logs.query', target: 'connection-failures', outcome: 'success' },
  { minutesAgo: 1100, actor: A, action: 'profile.reset', target: 'chloe.dubois', reason: 'Corrupt profile after a failed update.', hasParameters: true },
  { minutesAgo: 1300, actor: B, action: 'sessionhost.drain', target: 'avd-con-5', reason: 'Investigating health check failures.', hasParameters: true },
  { minutesAgo: 1500, actor: C, action: 'sessions.logoff-disconnected', target: HOST_POOL_NAME, reason: 'Free capacity before peak.', hasParameters: true },
  { minutesAgo: 1700, actor: B, action: 'alert.ack', target: 'Image version approaching end of life' },
  { minutesAgo: 2000, actor: A, action: 'scalingplan.schedule.create', target: 'Saturday', reason: 'Weekend coverage.', hasParameters: true },
  { minutesAgo: 2300, actor: A, action: 'rollout.create', target: 'Rollout to 1.3.0 (wave 2)', reason: 'Second wave: move the remaining 1.2.0 hosts to 1.3.0.', hasParameters: true },
  { minutesAgo: 2600, actor: C, action: 'sessionhost.provision.create', target: 'avd-con-5', outcome: 'accepted', hasParameters: true },
  { minutesAgo: 2900, actor: B, action: 'profile.restore', target: 'emma.clarke', reason: 'User asked for the older profile back.', hasParameters: true },
  { minutesAgo: 3200, actor: A, action: 'access.assignment.remove', target: 'SG-AVD-Interns', reason: 'Programme ended.', hasParameters: true },
  { minutesAgo: 3500, actor: C, action: 'sessionhost.drain', target: 'avd-con-3', reason: 'Resumed after patching.', hasParameters: true },
  { minutesAgo: 3800, actor: B, action: 'alert.unack', target: 'Disk space low' },
  { minutesAgo: 4100, actor: A, action: 'hostpool.registrationtoken.generate', target: HOST_POOL_NAME, reason: 'Adding a host.', hasParameters: true },
  { minutesAgo: 4400, actor: SYSTEM, action: 'scalingplan.schedule.update', target: 'Weekdays', hasParameters: true },
  { minutesAgo: 4700, actor: C, action: 'sessions.broadcast', target: HOST_POOL_NAME, reason: 'Reminder: sign out at end of day.', hasParameters: true },
  { minutesAgo: 5000, actor: B, action: 'session.message', target: 'avd-con-0 / session 2', reason: 'Please save your work.' },
  { minutesAgo: 5300, actor: A, action: 'image.build.start', target: 'Image build 1.3.0', outcome: 'accepted', hasParameters: true },
  { minutesAgo: 5600, actor: C, action: 'image.build.advance', target: 'Image build 1.3.0 (checklist_gate)', outcome: 'success' },
  { minutesAgo: 5900, actor: A, action: 'image.build.advance', target: 'Image build 1.3.0 (test_host_step)', outcome: 'success' },
  { minutesAgo: 6200, actor: B, action: 'sessionhost.power', target: 'avd-con-3', reason: 'Restart after agent update.', outcome: 'accepted', hasParameters: true },
  { minutesAgo: 6500, actor: A, action: 'rollout.start', target: 'Rollout to 1.3.0', hasParameters: true },
  { minutesAgo: 6800, actor: A, action: 'rollout.confirm-cutover', target: 'Rollout to 1.3.0', outcome: 'success' },
  { minutesAgo: 7200, actor: B, action: 'alert.snooze', target: 'Failed connection spike', reason: 'Network maintenance.', hasParameters: true },
  { minutesAgo: 7600, actor: C, action: 'logs.query', target: 'session-disconnects', outcome: 'success' },
  { minutesAgo: 8000, actor: A, action: 'scalingplan.emergency-override.activate', target: 'SCALE-CONTOSO-PROD', reason: 'All-hands demo day.', hasParameters: true },
  { minutesAgo: 8300, actor: SYSTEM, action: 'scalingplan.emergency-override.expire', target: 'SCALE-CONTOSO-PROD', outcome: 'success' },
  { minutesAgo: 8700, actor: B, action: 'profile.reset', target: 'olga.ivanova', reason: 'Oversized profile reset.', hasParameters: true },
  { minutesAgo: 9000, actor: C, action: 'access.assignment.create', target: 'SG-AVD-Users-Finance', reason: 'Finance rollout.', hasParameters: true },
  { minutesAgo: 9300, actor: A, action: 'sessionhost.drain', target: 'avd-con-1', reason: 'Resumed.', hasParameters: true },
  { minutesAgo: 9600, actor: B, action: 'session.logoff', target: 'avd-con-3 / session 12', reason: 'Locked profile.', outcome: 'failure' },
  { minutesAgo: 9900, actor: A, action: 'scalingplan.schedule.delete', target: 'Holiday-test', reason: 'Cleanup.', hasParameters: true },
  { minutesAgo: 10000, actor: SYSTEM, action: 'scalingplan.schedule.update', target: 'Sunday', hasParameters: true },
  { minutesAgo: 6 * 24 * 60, actor: C, action: 'sessionhost.provision.cancel', target: 'avd-con-6', reason: 'Wrong VM size.', outcome: 'success' },
  { minutesAgo: 6 * 24 * 60 + 90, actor: C, action: 'sessionhost.provision.create', target: 'avd-con-6', outcome: 'accepted', hasParameters: true },
  { minutesAgo: 6 * 24 * 60 + 240, actor: B, action: 'alert.ack', target: 'Monthly budget at 80%' },
  { minutesAgo: 6.5 * 24 * 60, actor: A, action: 'workspace.friendlyname.update', target: 'WS-CONTOSO-PROD', hasParameters: true },
];

export function buildAudit(now: number): AuditEntryDto[] {
  return SEEDS.map((seed, index): AuditEntryDto => ({
    id: fakeGuid(900 + index),
    occurredAt: ago(now, seed.minutesAgo * MINUTE),
    actor: seed.actor,
    action: seed.action,
    target: seed.target,
    reason: seed.reason,
    outcome: seed.outcome ?? 'success',
    correlationId: fakeGuid(1000 + index),
    hasParameters: seed.hasParameters ?? false,
  })).sort((a, b) => b.occurredAt.localeCompare(a.occurredAt)) satisfies AuditEntryDto[];
}
