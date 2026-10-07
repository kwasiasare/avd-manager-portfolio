import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'fs';
import type { HttpRequest, InvocationContext } from '@azure/functions';
import { settings } from './settings';
import { _resetBuildInfoForTests } from '../lib/buildInfo';

// AM-54: see health.test.ts's doc comment on this same `vi.mock('fs', ...)`
// pattern — `vi.spyOn` on the imported `fs` namespace fails under Vitest's
// ESM module loader with "Cannot redefine property".
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});

function makeRequest(headers: Record<string, string> = {}): HttpRequest {
  const lower = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  return {
    method: 'GET',
    url: 'https://func-example.azurewebsites.net/api/v1/settings',
    headers: { get: (name: string) => lower.get(name.toLowerCase()) ?? null },
    params: {},
    json: async () => ({}),
  } as unknown as HttpRequest;
}

function makeContext(): InvocationContext {
  return { warn: () => {}, error: () => {}, log: () => {} } as unknown as InvocationContext;
}

function encodePrincipal(principal: unknown): string {
  return Buffer.from(JSON.stringify(principal), 'utf-8').toString('base64');
}

function viewerHeader() {
  return encodePrincipal({ identityProvider: 'aad', userId: 'u1', userDetails: 'viewer@example.com', userRoles: ['viewer'] });
}

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  process.env.SUBSCRIPTION_ID = 'sub-id';
  process.env.RG_HOSTPOOLS = 'RG-AVD-HostPools';
  process.env.HOSTPOOL_NAME = 'HP-CONTOSO-PROD';
  delete process.env.REQUIRE_BACKEND_SECRET;
  // AM-54: no version.json on disk in this test run, so getBuildInfo()
  // falls back to the API_VERSION app setting — same as an environment
  // with no CI-assembled artifact. See health.test.ts for the
  // artifact-present/malformed cases exercised against the same lib.
  _resetBuildInfoForTests();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
  _resetBuildInfoForTests();
});

describe('GET /v1/settings — viewer+', () => {
  it('returns 401 for an unauthenticated caller', async () => {
    const response = await settings(makeRequest(), makeContext());
    expect(response.status).toBe(401);
  });

  it('returns 200 for a viewer with the expected non-secret shape', async () => {
    process.env.WORKSPACE_NAME = 'Contoso-Desktop';
    process.env.DAG_NAME = 'HP-CONTOSO-PROD-DAG';
    process.env.STORAGE_ACCOUNT_NAME = 'stcontoso001';
    process.env.FSLOGIX_SHARE_NAME = 'fslogixprofiles';
    process.env.FSLOGIX_OVERSIZED_GB = '5';
    process.env.GROUP_ID_VIEWER = 'aaaaaaaa-0000-0000-0000-000000000001';
    delete process.env.GROUP_ID_OPERATOR;
    process.env.GROUP_ID_ADMIN = 'aaaaaaaa-0000-0000-0000-000000000003';

    const response = await settings(makeRequest({ 'x-ms-client-principal': viewerHeader() }), makeContext());

    expect(response.status).toBe(200);
    expect(response.jsonBody).toEqual({
      apiVersion: expect.any(String),
      versionSource: 'app-setting',
      hostPoolName: 'HP-CONTOSO-PROD',
      workspaceName: 'Contoso-Desktop',
      dagName: 'HP-CONTOSO-PROD-DAG',
      storage: { accountName: 'stcontoso001', fslogixShareName: 'fslogixprofiles' },
      profilesOversizedGb: 5,
      groupIds: { viewer: 'configured', operator: 'not-configured', admin: 'configured' },
    });
  });

  it('never echoes the raw group object ids — only configured/not-configured status', async () => {
    const secretGroupId = 'aaaaaaaa-0000-0000-0000-000000000099';
    process.env.GROUP_ID_ADMIN = secretGroupId;

    const response = await settings(makeRequest({ 'x-ms-client-principal': viewerHeader() }), makeContext());

    expect(JSON.stringify(response.jsonBody)).not.toContain(secretGroupId);
  });

  describe('AM-54 — apiVersion sourced from the build artifact when present', () => {
    it('serves apiVersion/gitSha/builtAt from version.json when present and well-formed', async () => {
      vi.mocked(readFileSync).mockReturnValue(
        JSON.stringify({ version: '1.2.3', gitSha: 'b'.repeat(40), builtAt: '2026-08-22T00:00:00.000Z' }),
      );

      const response = await settings(makeRequest({ 'x-ms-client-principal': viewerHeader() }), makeContext());

      expect(response.status).toBe(200);
      expect(response.jsonBody).toMatchObject({
        apiVersion: '1.2.3',
        gitSha: 'b'.repeat(40),
        builtAt: '2026-08-22T00:00:00.000Z',
        versionSource: 'artifact',
      });
    });

    it('falls back to the API_VERSION app setting, with no gitSha/builtAt keys, when version.json is missing', async () => {
      process.env.API_VERSION = '9.9.9';
      vi.mocked(readFileSync).mockImplementation(() => {
        const error = new Error('ENOENT: no such file or directory') as NodeJS.ErrnoException;
        error.code = 'ENOENT';
        throw error;
      });

      const response = await settings(makeRequest({ 'x-ms-client-principal': viewerHeader() }), makeContext());

      expect(response.status).toBe(200);
      const body = response.jsonBody as Record<string, unknown>;
      expect(body.apiVersion).toBe('9.9.9');
      expect(body.versionSource).toBe('app-setting');
      expect(body).not.toHaveProperty('gitSha');
      expect(body).not.toHaveProperty('builtAt');
    });
  });
});
