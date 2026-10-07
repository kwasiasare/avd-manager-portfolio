import { describe, expect, it, vi } from 'vitest';
import type { HttpRequest, InvocationContext } from '@azure/functions';

const listProfiles = vi.fn();
vi.mock('../services/fslogixProfilesService', () => ({
  listProfiles: (...args: unknown[]) => listProfiles(...args),
}));

const { profilesList } = await import('./profiles');

function makeRequest(headers: Record<string, string> = {}, query: Record<string, string> = {}): HttpRequest {
  const lower = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  const queryMap = new Map(Object.entries(query));
  return {
    url: 'https://func-example.azurewebsites.net/api/v1/profiles',
    headers: { get: (name: string) => lower.get(name.toLowerCase()) ?? null },
    query: { get: (name: string) => queryMap.get(name) ?? null },
    params: {},
  } as unknown as HttpRequest;
}

function makeContext(): InvocationContext {
  return { warn: vi.fn(), error: vi.fn(), log: vi.fn() } as unknown as InvocationContext;
}

function encodePrincipal(principal: unknown): string {
  return Buffer.from(JSON.stringify(principal), 'utf-8').toString('base64');
}

function viewerHeader() {
  return encodePrincipal({ identityProvider: 'aad', userId: 'u1', userDetails: 'viewer@example.com', userRoles: ['viewer'] });
}

describe('profilesList', () => {
  it('returns 401 for an unauthenticated caller', async () => {
    const response = await profilesList(makeRequest(), makeContext());
    expect(response.status).toBe(401);
    expect(listProfiles).not.toHaveBeenCalled();
  });

  it('returns 200 with the service result for a viewer', async () => {
    const payload = { storageAccountName: 'stcontoso001', shareName: 'fslogixprofiles', profiles: [], retired: [] };
    listProfiles.mockResolvedValue(payload);

    const response = await profilesList(makeRequest({ 'x-ms-client-principal': viewerHeader() }), makeContext());

    expect(response.status).toBe(200);
    expect(response.jsonBody).toEqual(payload);
  });

  it('returns 502 when the service throws unexpectedly', async () => {
    listProfiles.mockRejectedValue(new Error('boom'));
    const response = await profilesList(makeRequest({ 'x-ms-client-principal': viewerHeader() }), makeContext());
    expect(response.status).toBe(502);
    expect(response.jsonBody).toMatchObject({ code: 'profiles_list_failed' });
  });

  it('passes forceRefresh through from ?refresh=true', async () => {
    listProfiles.mockResolvedValue({ profiles: [], retired: [] });
    await profilesList(makeRequest({ 'x-ms-client-principal': viewerHeader() }, { refresh: 'true' }), makeContext());
    expect(listProfiles).toHaveBeenCalledWith(expect.objectContaining({ forceRefresh: true }));
  });

  it('defaults forceRefresh to false when the query param is absent', async () => {
    listProfiles.mockResolvedValue({ profiles: [], retired: [] });
    await profilesList(makeRequest({ 'x-ms-client-principal': viewerHeader() }), makeContext());
    expect(listProfiles).toHaveBeenCalledWith(expect.objectContaining({ forceRefresh: false }));
  });
});
