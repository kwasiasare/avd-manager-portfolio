import type {
  EmergencyOverrideRequest,
  EmergencyOverrideStatus,
  ScalingHistoryResponse,
  ScalingPlanDetail,
  ScalingScheduleCreateRequest,
  ScalingScheduleCreateResponse,
  ScalingScheduleDeleteResponse,
  ScalingScheduleDetail,
  ScalingSchedulePatchRequest,
  ScalingSchedulePatchResponse,
} from '@avdmgr/shared';
import { MINUTE } from '../fixtures/time';
import { demoUserDetails, getDemoRole } from '../identity';
import { badRequest, conflict, notFound, read, simulate } from '../router';
import { recordAudit, type DemoState } from '../state';

const PLAN = '/v1/scalingplans/current';

function overrideStatus(state: DemoState): EmergencyOverrideStatus {
  const current = state.override;
  if (!current || current.expiresAt <= Date.now()) return { active: false };
  return {
    active: true,
    activatedBy: current.activatedBy,
    activatedAt: new Date(current.activatedAt).toISOString(),
    expiresAt: new Date(current.expiresAt).toISOString(),
    minutesRemaining: Math.max(1, Math.ceil((current.expiresAt - Date.now()) / MINUTE)),
    minutes: current.minutes,
    reason: current.reason,
  };
}

function findSchedule(state: DemoState, name: string): ScalingScheduleDetail {
  const schedule = state.scalingPlan.schedules.find((candidate) => candidate.name === name);
  if (!schedule) throw notFound(`Schedule "${name}" does not exist.`);
  return schedule;
}

export function registerScalingRoutes(): void {
  read<ScalingPlanDetail>(PLAN, ({ state }) => structuredClone(state.scalingPlan));

  simulate<ScalingSchedulePatchResponse, ScalingSchedulePatchRequest>('PATCH', `${PLAN}/schedules/:scheduleName`, ({ params, body, state }) => {
    const schedule = findSchedule(state, params.scheduleName);
    const { reason, ...changes } = body ?? {};
    Object.assign(schedule, Object.fromEntries(Object.entries(changes).filter(([, value]) => value !== undefined)));
    recordAudit(state, { action: 'scalingplan.schedule.update', target: schedule.name, reason, hasParameters: true });
    return { schedule: structuredClone(schedule) };
  });

  simulate<ScalingScheduleCreateResponse, ScalingScheduleCreateRequest>('POST', `${PLAN}/schedules`, ({ body, state }) => {
    const name = body?.name?.trim();
    if (!name) throw badRequest('A schedule name is required.');
    if (state.scalingPlan.schedules.some((candidate) => candidate.name === name)) throw conflict(`A schedule named "${name}" already exists.`);
    const { reason, ...definition } = body;
    const schedule: ScalingScheduleDetail = { ...definition, name };
    state.scalingPlan.schedules.push(schedule);
    recordAudit(state, { action: 'scalingplan.schedule.create', target: name, reason, hasParameters: true });
    return { schedule: structuredClone(schedule) };
  });

  simulate<ScalingScheduleDeleteResponse, { reason?: string } | undefined>('DELETE', `${PLAN}/schedules/:scheduleName`, ({ params, body, state }) => {
    const schedule = findSchedule(state, params.scheduleName);
    state.scalingPlan.schedules = state.scalingPlan.schedules.filter((candidate) => candidate !== schedule);
    recordAudit(state, { action: 'scalingplan.schedule.delete', target: schedule.name, reason: body?.reason, hasParameters: true });
    return { deletedScheduleName: schedule.name };
  });

  read<EmergencyOverrideStatus>(`${PLAN}/emergency-override`, ({ state }) => overrideStatus(state));

  simulate<EmergencyOverrideStatus, EmergencyOverrideRequest>('POST', `${PLAN}/emergency-override`, ({ body, state }) => {
    const minutes = Number(body?.minutes);
    if (!Number.isFinite(minutes) || minutes < 15 || minutes > 480) throw badRequest('minutes must be between 15 and 480.');
    const reason = body.reason?.trim();
    if (!reason) throw badRequest('A reason is required.');
    const now = Date.now();
    const alreadyActive = overrideStatus(state).active && state.override;
    state.override = {
      activatedBy: alreadyActive && body.extend ? state.override!.activatedBy : demoUserDetails(getDemoRole()),
      activatedAt: alreadyActive && body.extend ? state.override!.activatedAt : now,
      expiresAt: now + minutes * MINUTE,
      minutes,
      reason,
    };
    recordAudit(state, { action: 'scalingplan.emergency-override.activate', target: state.scalingPlan.name, reason, hasParameters: true });
    return overrideStatus(state);
  });

  simulate<EmergencyOverrideStatus, { reason?: string } | undefined>('DELETE', `${PLAN}/emergency-override`, ({ body, state }) => {
    if (overrideStatus(state).active) {
      state.override = undefined;
      recordAudit(state, { action: 'scalingplan.emergency-override.cancel', target: state.scalingPlan.name, reason: body?.reason });
    }
    return { active: false };
  });

  read<ScalingHistoryResponse>(`${PLAN}/history`, ({ state }) => ({
    entries: state.audit
      .filter((entry) => entry.action.startsWith('scalingplan.'))
      .slice(0, 10)
      .map((entry) => ({ id: entry.id, occurredAt: entry.occurredAt, actor: entry.actor, action: entry.action, target: entry.target, outcome: entry.outcome, reason: entry.reason })),
  }));
}
