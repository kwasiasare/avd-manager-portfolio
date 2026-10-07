import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { ApiClientError } from '../api/client';
import { demoFetch, setDemoLatency } from './transport';
import { getDemoState, resetDemoState } from './state';
import { clearSimulated, wasJustSimulated } from './simulatedSignal';
import { setDemoRole } from './identity';

describe('demo transport: disabled and dry-run-only routes', () => {
  beforeEach(() => {
    setDemoLatency(() => 0);
    setDemoRole('admin');
    resetDemoState();
    clearSimulated();
  });
  afterEach(() => setDemoLatency(undefined));

  it('refuses destructive actions with 403 demo_disabled and a friendly message, without changing state', async () => {
    const before = getDemoState().audit.length;
    const error = await demoFetch('/v1/profiles/some-folder/reset', { method: 'POST', body: { reason: 'x' } }).catch((e: unknown) => e as ApiClientError);
    expect(error).toBeInstanceOf(ApiClientError);
    expect(error).toMatchObject({ status: 403, code: 'demo_disabled' });
    expect((error as ApiClientError).message).toMatch(/disabled in the public demo/);
    expect(getDemoState().audit.length).toBe(before);
    expect(wasJustSimulated()).toBe(false);
  });

  it('refuses real image builds but serves the dry run', async () => {
    await expect(demoFetch('/v1/images/builds', { method: 'POST', body: { version: '1.4.1', adminUsername: 'a' } })).rejects.toMatchObject({ code: 'demo_disabled' });
    const dry = await demoFetch<{ dryRun: boolean; plan: { steps: unknown[] } }>('/v1/images/builds?dryRun=true', { method: 'POST', body: { version: '1.4.1', adminUsername: 'a' } });
    expect(dry.dryRun).toBe(true);
    expect(dry.plan.steps).toHaveLength(13);
  });

  it('refuses real provisioning and serves only the dry-run plan', async () => {
    const body = { sessionHostName: 'avd-con-9', zone: '1' };
    await expect(demoFetch('/v1/hostpools/HP-CONTOSO-PROD/sessionhosts/provisions', { method: 'POST', body })).rejects.toMatchObject({ code: 'demo_disabled' });
    const dry = await demoFetch<{ dryRun: boolean; plan: { steps: unknown[] } }>('/v1/hostpools/HP-CONTOSO-PROD/sessionhosts/provisions?dryRun=true', { method: 'POST', body });
    expect(dry).toMatchObject({ dryRun: true });
    expect(dry.plan.steps).toHaveLength(6);
  });

  it('refuses every rollout action', async () => {
    for (const action of ['start', 'force-proceed', 'verify-config', 'confirm-cutover', 'start-removal', 'remove-hosts', 'rollback', 'cancel']) {
      await expect(demoFetch(`/v1/hostpools/HP-CONTOSO-PROD/rollout-plans/00000000-0000-4000-8000-000000000401/${action}`, { method: 'POST', body: { reason: 'x' } }), action).rejects.toMatchObject({ status: 403, code: 'demo_disabled' });
    }
  });

  it('simulates the checklist tick on the seeded gated build and audits it', async () => {
    const gated = '00000000-0000-4000-8000-000000000301';
    const result = await demoFetch<{ checklist: Record<string, boolean>; allRequiredChecked: boolean }>(`/v1/images/builds/${gated}/checklist`, { method: 'PATCH', body: { itemId: 'lob_apps_tested', checked: true } });
    expect(result.checklist.lob_apps_tested).toBe(true);
    expect(result.allRequiredChecked).toBe(false);
    expect(wasJustSimulated()).toBe(true);
    expect(getDemoState().audit[0]).toMatchObject({ action: 'image.build.checklist' });
  });

  it('simulates access assignment create and rejects duplicates', async () => {
    const body = { principalId: '00000000-0000-4000-8000-000000000615', principalType: 'user', reason: 'demo' };
    const created = await demoFetch<{ assignment: { displayName: string } }>('/v1/access/assignments', { method: 'POST', body });
    expect(created.assignment.displayName).toBe('Maria Santos');
    await expect(demoFetch('/v1/access/assignments', { method: 'POST', body })).rejects.toMatchObject({ status: 409 });
  });

  it('simulates schedule create/patch/delete and the emergency override', async () => {
    const day = { rampUpStartTime: { hour: 7, minute: 0 }, peakStartTime: { hour: 9, minute: 0 }, rampDownStartTime: { hour: 17, minute: 0 }, offPeakStartTime: { hour: 19, minute: 0 } };
    await demoFetch('/v1/scalingplans/current/schedules', { method: 'POST', body: { name: 'Holiday', daysOfWeek: ['Monday'], ...day } });
    await expect(demoFetch('/v1/scalingplans/current/schedules', { method: 'POST', body: { name: 'Holiday', daysOfWeek: ['Monday'], ...day } })).rejects.toMatchObject({ status: 409 });
    const patched = await demoFetch<{ schedule: { rampUpMinimumHostsPct: number } }>('/v1/scalingplans/current/schedules/Holiday', { method: 'PATCH', body: { rampUpMinimumHostsPct: 55 } });
    expect(patched.schedule.rampUpMinimumHostsPct).toBe(55);
    await demoFetch('/v1/scalingplans/current/schedules/Holiday', { method: 'DELETE' });
    await expect(demoFetch('/v1/scalingplans/current/schedules/Holiday', { method: 'DELETE' })).rejects.toMatchObject({ status: 404 });

    const active = await demoFetch<{ active: boolean; minutesRemaining: number }>('/v1/scalingplans/current/emergency-override', { method: 'POST', body: { minutes: 60, reason: 'demo' } });
    expect(active).toMatchObject({ active: true });
    expect(active.minutesRemaining).toBeGreaterThan(58);
    expect(await demoFetch<{ active: boolean }>('/v1/scalingplans/current/emergency-override')).toMatchObject({ active: true });
    expect(await demoFetch<{ active: boolean }>('/v1/scalingplans/current/emergency-override', { method: 'DELETE' })).toEqual({ active: false });
    const history = await demoFetch<{ entries: Array<{ action: string }> }>('/v1/scalingplans/current/history');
    expect(history.entries.map((entry) => entry.action)).toContain('scalingplan.emergency-override.cancel');
  });
});
