import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiClientError } from '../api/client';
import { DEMO_FIXTURE_MARKER, demoFetch, pseudoLatencyMs, setDemoLatency } from './transport';
import { resetDemoState } from './state';
import { clearSimulated, wasJustSimulated } from './simulatedSignal';
import { setDemoRole } from './identity';
import type { AlertsFeedResponse, AuditRecentResponse, DrainSessionHostResponse, SessionHost, UserSession } from '@avdmgr/shared';

describe('demo transport', () => {
  beforeEach(() => {
    setDemoLatency(() => 0);
    setDemoRole('operator');
    resetDemoState();
    clearSimulated();
  });
  afterEach(() => {
    setDemoLatency(undefined);
    vi.useRealTimers();
  });

  it('exposes the bundle-guard marker', () => {
    expect(DEMO_FIXTURE_MARKER).toBe('DEMO_FIXTURE_MARKER_a7c1');
  });

  it('serves GETs as plain JSON copies (callers cannot mutate state)', async () => {
    const hosts = await demoFetch<SessionHost[]>('/v1/hostpools/HP-CONTOSO-PROD/sessionhosts');
    expect(hosts).toHaveLength(6);
    hosts[0].name = 'tampered';
    const again = await demoFetch<SessionHost[]>('/v1/hostpools/HP-CONTOSO-PROD/sessionhosts');
    expect(again[0].name).toBe('avd-con-0');
  });

  it('derives activeSessions from the live session list', async () => {
    const hosts = await demoFetch<SessionHost[]>('/v1/hostpools/HP-CONTOSO-PROD/sessionhosts');
    const sessions = await demoFetch<UserSession[]>('/v1/hostpools/HP-CONTOSO-PROD/sessions');
    expect(sessions).toHaveLength(14);
    expect(hosts.reduce((sum, host) => sum + host.activeSessions, 0)).toBe(14);
  });

  it('throws ApiClientError 404 demo_unmapped for unknown routes', async () => {
    const error = await demoFetch('/v1/does-not-exist').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiClientError);
    expect(error).toMatchObject({ status: 404, code: 'demo_unmapped' });
  });

  it('throws ApiClientError 404 not_found for unknown entities', async () => {
    await expect(demoFetch('/v1/hostpools/HP-CONTOSO-PROD/sessionhosts/nope/drain', { method: 'PATCH', body: { allowNewSession: false } })).rejects.toMatchObject({ status: 404, code: 'not_found' });
  });

  it('throws 400 bad_request on invalid input', async () => {
    await expect(demoFetch('/v1/hostpools/HP-CONTOSO-PROD/sessions/logoff-disconnected', { method: 'POST', body: { reason: '  ' } })).rejects.toMatchObject({ status: 400, code: 'bad_request' });
  });

  it('simulates drain: mutates state, audits as the demo identity, flags the toast signal', async () => {
    const result = await demoFetch<DrainSessionHostResponse>('/v1/hostpools/HP-CONTOSO-PROD/sessionhosts/avd-con-0/drain', { method: 'PATCH', body: { allowNewSession: false, reason: 'maintenance' } });
    expect(result.sessionHost.allowNewSession).toBe(false);
    expect(wasJustSimulated()).toBe(true);
    const audit = await demoFetch<AuditRecentResponse>('/v1/audit/recent?top=1');
    expect(audit.entries[0]).toMatchObject({ action: 'sessionhost.drain', target: 'avd-con-0', actor: 'demo.operator@contoso.example', reason: 'maintenance' });
  });

  it('simulates power with a scripted transition', async () => {
    vi.useFakeTimers();
    await demoFetch('/v1/hostpools/HP-CONTOSO-PROD/sessionhosts/avd-con-4/power', { method: 'POST', body: { action: 'start' } });
    let hosts = await demoFetch<SessionHost[]>('/v1/hostpools/HP-CONTOSO-PROD/sessionhosts');
    expect(hosts.find((host) => host.name === 'avd-con-4')?.powerState).toBe('starting');
    vi.advanceTimersByTime(3_100);
    hosts = await demoFetch<SessionHost[]>('/v1/hostpools/HP-CONTOSO-PROD/sessionhosts');
    expect(hosts.find((host) => host.name === 'avd-con-4')).toMatchObject({ powerState: 'running', status: 'Available' });
  });

  it('simulates alert ack / unack / snooze', async () => {
    const feed = await demoFetch<AlertsFeedResponse>('/v1/alerts?hours=48');
    const alert = feed.alerts.find((candidate) => candidate.status === 'New')!;
    const guid = alert.id.split('/').pop()!;
    expect(await demoFetch(`/v1/alerts/${guid}/ack`, { method: 'POST', body: { reason: 'ok' } })).toBeUndefined();
    let after = (await demoFetch<AlertsFeedResponse>('/v1/alerts?hours=48')).alerts.find((candidate) => candidate.id === alert.id)!;
    expect(after).toMatchObject({ status: 'Acknowledged', ackedBy: 'demo.operator@contoso.example' });
    await demoFetch(`/v1/alerts/${guid}/ack`, { method: 'DELETE' });
    await demoFetch(`/v1/alerts/${guid}/snooze`, { method: 'POST', body: { hours: 2 } });
    after = (await demoFetch<AlertsFeedResponse>('/v1/alerts?hours=48')).alerts.find((candidate) => candidate.id === alert.id)!;
    expect(after.status).toBe('New');
    expect(after.snoozedUntil).toBeDefined();
  });

  it('resetDemoState restores the seeded data and cancels pending transitions', async () => {
    await demoFetch('/v1/hostpools/HP-CONTOSO-PROD/sessions/logoff-disconnected', { method: 'POST', body: { reason: 'free capacity' } });
    expect(await demoFetch<UserSession[]>('/v1/hostpools/HP-CONTOSO-PROD/sessions')).toHaveLength(10);
    resetDemoState();
    expect(await demoFetch<UserSession[]>('/v1/hostpools/HP-CONTOSO-PROD/sessions')).toHaveLength(14);
  });

  it('rejects with AbortError when the caller aborts', async () => {
    setDemoLatency(() => 500);
    const controller = new AbortController();
    const pending = demoFetch('/v1/hostpools', { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('pseudo-latency is deterministic and within 120-350 ms', () => {
    const value = pseudoLatencyMs('/v1/hostpools');
    expect(pseudoLatencyMs('/v1/hostpools')).toBe(value);
    for (const path of ['/a', '/v1/alerts?hours=24', '/v1/profiles', '/v1/governance']) {
      const ms = pseudoLatencyMs(path);
      expect(ms).toBeGreaterThanOrEqual(120);
      expect(ms).toBeLessThanOrEqual(350);
    }
  });
});
