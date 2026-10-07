import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'fs';
import type { HttpRequest, InvocationContext } from '@azure/functions';
import { health } from './health';
import { _resetBuildInfoForTests } from '../lib/buildInfo';

/**
 * AM-54 — GET /v1/health now serves version/gitSha/builtAt from the
 * CI-stamped `version.json` (see `app/api/src/lib/buildInfo.ts`), falling
 * back to the API_VERSION app setting when that file is missing or
 * malformed. `fs.readFileSync` is mocked (rather than pointing
 * `getBuildInfo()` at a real temp file) — the cleanest seam buildInfo.ts
 * offers today, since it resolves version.json's path from its own
 * `__dirname`, not an injectable path. `vi.mock` (not `vi.spyOn` on the
 * imported namespace) because Vitest's ESM module loader exposes `fs` as a
 * non-configurable namespace object — `vi.spyOn(fs, 'readFileSync')` fails
 * with "Cannot redefine property" under that loader even though `fs.ts`'s
 * own `import * as fs from 'fs'` compiles to plain CJS `require('fs')`.
 */
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});
function makeRequest(): HttpRequest {
  return {
    method: 'GET',
    url: 'https://func-example.azurewebsites.net/api/v1/health',
    headers: { get: () => null },
    params: {},
    json: async () => ({}),
  } as unknown as HttpRequest;
}

function makeContext(): InvocationContext {
  return { warn: () => {}, error: () => {}, log: () => {} } as unknown as InvocationContext;
}

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  // getConfig()'s fallback path (getBuildInfo's app-setting branch) needs
  // these three — none have defaults (see config.ts's readEnv calls) —
  // same minimal setup settings.test.ts already uses.
  process.env.SUBSCRIPTION_ID = 'sub-id';
  process.env.RG_HOSTPOOLS = 'RG-AVD-HostPools';
  process.env.HOSTPOOL_NAME = 'HP-CONTOSO-PROD';
  _resetBuildInfoForTests();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
  _resetBuildInfoForTests();
});

describe('GET /v1/health', () => {
  it('serves version/gitSha/builtAt from version.json when present and well-formed', async () => {
    vi.mocked(readFileSync).mockReturnValue(
      JSON.stringify({ version: '1.2.3', gitSha: 'a'.repeat(40), builtAt: '2026-08-22T00:00:00.000Z' }),
    );

    const response = await health(makeRequest(), makeContext());

    expect(response.status).toBe(200);
    expect(response.jsonBody).toEqual({
      status: 'ok',
      version: '1.2.3',
      gitSha: 'a'.repeat(40),
      builtAt: '2026-08-22T00:00:00.000Z',
      versionSource: 'artifact',
    });
  });

  it('falls back to the API_VERSION app setting when version.json is missing', async () => {
    process.env.API_VERSION = '9.9.9';
    vi.mocked(readFileSync).mockImplementation(() => {
      const error = new Error('ENOENT: no such file or directory') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      throw error;
    });

    const response = await health(makeRequest(), makeContext());

    expect(response.status).toBe(200);
    expect(response.jsonBody).toEqual({
      status: 'ok',
      version: '9.9.9',
      versionSource: 'app-setting',
    });
  });

  it('falls back to the API_VERSION app setting when version.json is malformed JSON', async () => {
    process.env.API_VERSION = '9.9.9';
    vi.mocked(readFileSync).mockReturnValue('{ this is not valid json');

    const response = await health(makeRequest(), makeContext());

    expect(response.status).toBe(200);
    expect(response.jsonBody).toEqual({
      status: 'ok',
      version: '9.9.9',
      versionSource: 'app-setting',
    });
  });

  it('falls back to the API_VERSION app setting when version.json has the wrong shape', async () => {
    process.env.API_VERSION = '9.9.9';
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ notVersion: 'oops' }));

    const response = await health(makeRequest(), makeContext());

    expect(response.status).toBe(200);
    expect(response.jsonBody).toEqual({
      status: 'ok',
      version: '9.9.9',
      versionSource: 'app-setting',
    });
  });

  it('falls back to the API_VERSION app setting when version.json has an empty version string', async () => {
    process.env.API_VERSION = '9.9.9';
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ version: '   ' }));

    const response = await health(makeRequest(), makeContext());

    expect(response.status).toBe(200);
    expect(response.jsonBody).toMatchObject({ version: '9.9.9', versionSource: 'app-setting' });
  });

  it('never throws — an unexpected fs error still yields a 200', async () => {
    vi.mocked(readFileSync).mockImplementation(() => {
      throw new Error('disk on fire');
    });

    const response = await health(makeRequest(), makeContext());

    expect(response.status).toBe(200);
    expect(response.jsonBody).toMatchObject({ status: 'ok', versionSource: 'app-setting' });
  });
});
