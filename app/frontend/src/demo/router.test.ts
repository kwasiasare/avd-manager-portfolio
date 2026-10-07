import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionHostPowerRequest } from '@avdmgr/shared';

/**
 * AM-61 drift test (design §2.5). Every exported API wrapper must resolve to
 * a registered demo route (simulated, read, or disabled), and every
 * registered route must be exercised by some wrapper. Adding a wrapper
 * without a demo route (or a route without a wrapper) fails here — as does
 * adding a wrapper without registering an argument factory below.
 */
const calls: Array<{ method: string; path: string; body?: unknown }> = [];

vi.mock('../api/client', () => {
  const record = (method: string) => (path: string, ...rest: unknown[]) => {
    // get(path, options) | post/put/patch(path, body, options) | delete(path, options)
    const body = method === 'GET' ? undefined : method === 'DELETE' ? (rest[0] as { body?: unknown } | undefined)?.body : rest[0];
    calls.push({ method, path, body });
    return Promise.resolve(undefined);
  };
  return {
    apiClient: { get: record('GET'), post: record('POST'), put: record('PUT'), patch: record('PATCH'), delete: record('DELETE') },
    ApiClientError: class ApiClientError extends Error {},
  };
});

import { listRoutes, matchRoute, dispatch } from './router';
import { registerAllRoutes } from './routes';
import { resetDemoState } from './state';
import { setDemoRole } from './identity';
import { GATED_BUILD_ID } from './fixtures/imageBuilds';
import { fakeGuid } from './fixtures/time';

type Api = Record<string, (...args: never[]) => unknown>;
const HP = 'HP-CONTOSO-PROD';
const ALERT_ID = `/subscriptions/${fakeGuid(1)}/providers/Microsoft.AlertsManagement/alerts/${fakeGuid(101)}`;
const PLAN_ID = fakeGuid(401);
const PROVISION_ID = fakeGuid(501);
const call = (fn: unknown, ...args: unknown[]) => (fn as (...a: unknown[]) => unknown)(...args);

/** One entry per exported wrapper: how to call it with plausible args. */
const FACTORIES: Record<string, (api: Api) => unknown> = {
  getHostPools: (a) => call(a.getHostPools),
  getSessionHosts: (a) => call(a.getSessionHosts, HP),
  getHostPoolPolicyHealth: (a) => call(a.getHostPoolPolicyHealth, HP),
  setSessionHostDrain: (a) => call(a.setSessionHostDrain, HP, 'avd-con-0', { allowNewSession: false }),
  generateRegistrationToken: (a) => call(a.generateRegistrationToken, HP, { hoursValid: 4 }),
  getRegistrationTokenStatus: (a) => call(a.getRegistrationTokenStatus, HP),
  getVmTemplate: (a) => call(a.getVmTemplate, HP),
  setSessionHostPower: (a) => call(a.setSessionHostPower, HP, 'avd-con-4', { action: 'start' } satisfies SessionHostPowerRequest),
  getSessions: (a) => call(a.getSessions, HP),
  forceLogoffSession: (a) => call(a.forceLogoffSession, HP, 'avd-con-0', '1', { reason: 'test' }),
  sendSessionMessage: (a) => call(a.sendSessionMessage, HP, 'avd-con-0', '2', { body: 'hello' }),
  logoffAllDisconnectedSessions: (a) => call(a.logoffAllDisconnectedSessions, HP, { reason: 'test' }),
  broadcastSessionMessage: (a) => call(a.broadcastSessionMessage, HP, { body: 'hello' }),
  getCurrentScalingPlan: (a) => call(a.getCurrentScalingPlan),
  updateScalingSchedule: (a) => call(a.updateScalingSchedule, 'Weekdays', { rampUpMinimumHostsPct: 50 }),
  createScalingSchedule: (a) => call(a.createScalingSchedule, { name: 'Holiday', daysOfWeek: ['Monday'], rampUpStartTime: { hour: 7, minute: 0 }, peakStartTime: { hour: 9, minute: 0 }, rampDownStartTime: { hour: 17, minute: 0 }, offPeakStartTime: { hour: 19, minute: 0 } }),
  deleteScalingSchedule: (a) => call(a.deleteScalingSchedule, 'Saturday', 'cleanup'),
  getEmergencyOverrideStatus: (a) => call(a.getEmergencyOverrideStatus),
  activateEmergencyOverride: (a) => call(a.activateEmergencyOverride, { minutes: 60, reason: 'test' }),
  cancelEmergencyOverride: (a) => call(a.cancelEmergencyOverride, 'done'),
  getScalingHistory: (a) => call(a.getScalingHistory),
  getCurrentImageVersion: (a) => call(a.getCurrentImageVersion),
  getImageVersions: (a) => call(a.getImageVersions),
  getImageSnapshots: (a) => call(a.getImageSnapshots),
  startImageBuild: (a) => call(a.startImageBuild, { version: '1.4.1', adminUsername: 'buildadmin' }, true),
  listImageBuilds: (a) => call(a.listImageBuilds),
  getImageBuild: (a) => call(a.getImageBuild, GATED_BUILD_ID),
  updateImageBuildChecklist: (a) => call(a.updateImageBuildChecklist, GATED_BUILD_ID, { itemId: 'lob_apps_tested', checked: true }),
  advanceImageBuild: (a) => call(a.advanceImageBuild, GATED_BUILD_ID),
  cancelImageBuild: (a) => call(a.cancelImageBuild, GATED_BUILD_ID),
  deleteImageBuildSnapshot: (a) => call(a.deleteImageBuildSnapshot, GATED_BUILD_ID, { reason: 'test' }),
  getRecentAlerts: (a) => call(a.getRecentAlerts),
  getHealthSummary: (a) => call(a.getHealthSummary),
  getEstateSummary: (a) => call(a.getEstateSummary),
  getCostSummary: (a) => call(a.getCostSummary),
  getCostHostRuntime: (a) => call(a.getCostHostRuntime),
  getFslogixUsage: (a) => call(a.getFslogixUsage),
  getIdleHosts: (a) => call(a.getIdleHosts),
  getSavingsOpportunities: (a) => call(a.getSavingsOpportunities),
  getAlerts: (a) => call(a.getAlerts, 24),
  ackAlert: (a) => call(a.ackAlert, ALERT_ID, { reason: 'test' }),
  unackAlert: (a) => call(a.unackAlert, ALERT_ID),
  snoozeAlert: (a) => call(a.snoozeAlert, ALERT_ID, { hours: 2 }),
  unsnoozeAlert: (a) => call(a.unsnoozeAlert, ALERT_ID),
  getLogsViews: (a) => call(a.getLogsViews),
  runLogsView: (a) => call(a.runLogsView, 'connection-failures', 24),
  runRawKql: (a) => call(a.runRawKql, { kql: 'WVDConnections | take 5', timespanHours: 24 }),
  getGovernance: (a) => call(a.getGovernance),
  getProfiles: (a) => call(a.getProfiles),
  resetProfile: (a) => call(a.resetProfile, 'folder', { reason: 'test' }),
  restoreProfile: (a) => call(a.restoreProfile, 'folder', { retiredFileName: 'x.retired-20260101' }),
  deleteRetiredProfile: (a) => call(a.deleteRetiredProfile, 'folder', 'x.retired-20260101', { reason: 'test' }),
  resolveDuplicateContainer: (a) => call(a.resolveDuplicateContainer, 'folder', { fileName: 'x.vhdx', mode: 'retire', reason: 'test' }),
  searchAccess: (a) => call(a.searchAccess, 'maria'),
  getDesktopAssignments: (a) => call(a.getDesktopAssignments),
  createDesktopAssignment: (a) => call(a.createDesktopAssignment, { principalId: fakeGuid(615), principalType: 'user', reason: 'test' }),
  removeDesktopAssignment: (a) => call(a.removeDesktopAssignment, 'role-assignment-id', 'test'),
  getWorkspaceFriendlyName: (a) => call(a.getWorkspaceFriendlyName),
  updateWorkspaceFriendlyName: (a) => call(a.updateWorkspaceFriendlyName, { friendlyName: 'Contoso Desktop 2' }),
  getSettings: (a) => call(a.getSettings),
  getRecentAuditEntries: (a) => call(a.getRecentAuditEntries, { top: 10, actionPrefix: 'alert.' }),
  // rollout.ts
  listRolloutPlans: (a) => call(a.listRolloutPlans, HP),
  getRolloutPlan: (a) => call(a.getRolloutPlan, HP, PLAN_ID),
  createRolloutPlan: (a) => call(a.createRolloutPlan, HP, { targetImageVersion: '1.3.0', oldHostNames: [], newHostNames: [], reason: 'test' }),
  startRollout: (a) => call(a.startRollout, HP, PLAN_ID),
  forceProceedRollout: (a) => call(a.forceProceedRollout, HP, PLAN_ID, { reason: 'test' }),
  verifyRolloutConfig: (a) => call(a.verifyRolloutConfig, HP, PLAN_ID),
  confirmCutover: (a) => call(a.confirmCutover, HP, PLAN_ID),
  startRemoval: (a) => call(a.startRemoval, HP, PLAN_ID),
  removeRolloutHosts: (a) => call(a.removeRolloutHosts, HP, PLAN_ID, { sessionHostNames: ['x'], reason: 'test' }),
  rollbackRollout: (a) => call(a.rollbackRollout, HP, PLAN_ID, { reason: 'test' }),
  cancelRollout: (a) => call(a.cancelRollout, HP, PLAN_ID),
  // sessionHostProvisions.ts
  listSessionHostProvisions: (a) => call(a.listSessionHostProvisions, HP),
  getSessionHostProvision: (a) => call(a.getSessionHostProvision, HP, PROVISION_ID),
  startSessionHostProvision: (a) => call(a.startSessionHostProvision, HP, { sessionHostName: 'avd-con-9', zone: '1' }, true),
  cancelSessionHostProvision: (a) => call(a.cancelSessionHostProvision, HP, PROVISION_ID),
};

/** Extra calls so the non-dry-run (disabled) branch of the dry-run routes is exercised too. */
const EXTRA = {
  startImageBuildReal: (a: Api) => call(a.startImageBuild, { version: '1.4.1', adminUsername: 'buildadmin' }, false),
  startSessionHostProvisionReal: (a: Api) => call(a.startSessionHostProvision, HP, { sessionHostName: 'avd-con-9', zone: '1' }, false),
};

const stripQuery = (path: string) => path.split('?')[0];

describe('demo router drift', () => {
  const apis: Record<string, Api> = {};
  const captured: Array<{ name: string; method: string; path: string; body?: unknown }> = [];

  beforeAll(async () => {
    registerAllRoutes();
    apis.avd = (await import('../api/avd')) as unknown as Api;
    apis.rollout = (await import('../api/rollout')) as unknown as Api;
    apis.provisions = (await import('../api/sessionHostProvisions')) as unknown as Api;
    const all: Api = { ...apis.avd, ...apis.rollout, ...apis.provisions };
    for (const [name, fn] of Object.entries(FACTORIES)) {
      calls.length = 0;
      await fn(all);
      for (const entry of calls) captured.push({ name, ...entry });
    }
    for (const [name, fn] of Object.entries(EXTRA)) {
      calls.length = 0;
      await fn(all);
      for (const entry of calls) captured.push({ name, ...entry });
    }
  });

  it('has an argument factory for every exported API wrapper (and no stale ones)', () => {
    const exported = Object.entries({ ...apis.avd, ...apis.rollout, ...apis.provisions })
      .filter(([, value]) => typeof value === 'function')
      .map(([name]) => name)
      .sort();
    expect(Object.keys(FACTORIES).sort()).toEqual(exported);
    expect(exported.length).toBeGreaterThanOrEqual(76);
  });

  it('routes every wrapper call to a registered route', () => {
    const unmatched = captured.filter((entry) => !matchRoute(entry.method, stripQuery(entry.path))).map((entry) => `${entry.name}: ${entry.method} ${entry.path}`);
    expect(unmatched).toEqual([]);
  });

  it('hits every registered route at least once', () => {
    const hit = new Set(captured.map((entry) => matchRoute(entry.method, stripQuery(entry.path))?.def.key));
    const unused = listRoutes().filter((route) => !hit.has(route.key)).map((route) => route.key);
    expect(unused).toEqual([]);
  });

  it('registers at least one route per wrapper export', () => {
    expect(listRoutes().length).toBeGreaterThanOrEqual(Object.keys(FACTORIES).length);
  });

  it('serves every GET wrapper call with JSON-serialisable data', async () => {
    resetDemoState();
    const state = (await import('./state')).getDemoState();
    for (const entry of captured.filter((candidate) => candidate.method === 'GET')) {
      const result = await dispatch('GET', entry.path, undefined, state);
      expect(() => JSON.stringify(result.data), `${entry.name} ${entry.path}`).not.toThrow();
      expect(result.data, `${entry.name} ${entry.path}`).toBeDefined();
    }
  });

  it('classifies disabled routes as 403 demo_disabled', async () => {
    resetDemoState();
    const state = (await import('./state')).getDemoState();
    const disabled = listRoutes().filter((route) => route.kind === 'disabled');
    expect(disabled.length).toBeGreaterThanOrEqual(18);
    for (const route of disabled) {
      const entry = captured.find((candidate) => matchRoute(candidate.method, stripQuery(candidate.path))?.def.key === route.key);
      expect(entry, route.key).toBeDefined();
      await expect(dispatch(entry!.method, entry!.path, entry!.body, state), route.key).rejects.toMatchObject({ status: 403, code: 'demo_disabled' });
    }
  });

  it('applies every simulated mutation against the fixtures without error', async () => {
    resetDemoState();
    setDemoRole('admin');
    const state = (await import('./state')).getDemoState();
    const simulated = captured.filter((entry) => matchRoute(entry.method, stripQuery(entry.path))?.def.kind === 'simulated' && !entry.name.endsWith('Real'));
    expect(simulated.length).toBeGreaterThanOrEqual(15);
    const auditBefore = state.audit.length;
    for (const entry of simulated) {
      await expect(dispatch(entry.method, entry.path, entry.body, state), `${entry.name} ${entry.method} ${entry.path}`).resolves.toBeDefined();
    }
    // Dry runs and the checklist/alert flows aside, real mutations must leave audit rows behind.
    expect(state.audit.length).toBeGreaterThan(auditBefore + 8);
  });
});

describe('route matching', () => {
  beforeEach(() => registerAllRoutes());

  it('extracts and decodes :params', () => {
    const matched = matchRoute('PATCH', '/v1/hostpools/HP%20X/sessionhosts/avd-con-0/drain');
    expect(matched?.def.pattern).toBe('/v1/hostpools/:hostPoolName/sessionhosts/:sessionHostName/drain');
    expect(matched?.params).toEqual({ hostPoolName: 'HP X', sessionHostName: 'avd-con-0' });
  });

  it('matches on method as well as path', () => {
    expect(matchRoute('GET', '/v1/scalingplans/current/emergency-override')?.def.kind).toBe('read');
    expect(matchRoute('POST', '/v1/scalingplans/current/emergency-override')?.def.kind).toBe('simulated');
    expect(matchRoute('PUT', '/v1/scalingplans/current/emergency-override')).toBeUndefined();
  });

  it('does not let a shorter or longer path match', () => {
    expect(matchRoute('GET', '/v1/hostpools/HP/sessionhosts/extra/segments/here')).toBeUndefined();
    expect(matchRoute('GET', '/v1/hostpools/HP')).toBeUndefined();
  });

  it('prefers literal segments (provisions) over parameters', () => {
    expect(matchRoute('GET', '/v1/hostpools/HP/sessionhosts/provisions')?.def.pattern).toContain('/provisions');
  });

  it('returns 404 demo_unmapped for unknown routes', async () => {
    const state = (await import('./state')).getDemoState();
    await expect(dispatch('GET', '/v1/nope', undefined, state)).rejects.toMatchObject({ status: 404, code: 'demo_unmapped' });
  });

  it('parses the query string into ctx.query', async () => {
    const state = (await import('./state')).getDemoState();
    const result = await dispatch('GET', '/v1/audit/recent?top=3&actionPrefix=alert.', undefined, state);
    const data = result.data as { entries: Array<{ action: string }>; sinceHours: number };
    expect(data.entries.length).toBeLessThanOrEqual(3);
    expect(data.entries.every((entry) => entry.action.startsWith('alert.'))).toBe(true);
  });
});
