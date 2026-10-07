import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const graphListAllMock = vi.fn();
class FakeGraphForbiddenError extends Error {}
vi.mock('../lib/graphRest', () => ({
  graphListAll: (...args: unknown[]) => graphListAllMock(...args),
  isGraphForbidden: (error: unknown) => error instanceof FakeGraphForbiddenError,
}));

const { classifyConfigurationStates, computeIntunePolicyHealth, getIntunePolicyHealth, _resetIntunePolicyHealthCacheForTests, INTUNE_GRAPH_GRANT_INSTRUCTIONS } = await import(
  './intunePolicyHealthService'
);

function noopLogger() {
  return { warn: () => {}, log: () => {}, error: () => {} };
}

beforeEach(() => {
  graphListAllMock.mockReset();
  _resetIntunePolicyHealthCacheForTests();
});

afterEach(() => {
  _resetIntunePolicyHealthCacheForTests();
});

describe('classifyConfigurationStates (pure)', () => {
  it('is "ok" for a device with no error settings anywhere', () => {
    const result = classifyConfigurationStates([{ displayName: 'FSLogix Settings Catalog', state: 'compliant', settingStates: [{ setting: 'device_vendor_msft_policy_config_admx_fslogixv1~policy~fslogixv1~enabled', state: 'compliant', errorCode: 0 }] }]);
    expect(result).toMatchObject({ status: 'ok', errorSettingCount: 0, fsLogixErrorSettings: [], admxSignatureDetectable: true });
  });

  it('is "ok" (trivially detectable) for a device with zero reported configuration profiles', () => {
    const result = classifyConfigurationStates([]);
    expect(result).toMatchObject({ status: 'ok', admxSignatureDetectable: true });
  });

  it('is "missing-admx" when errorCode 65000 appears on a FSLogixv1~Policy~ setting', () => {
    const result = classifyConfigurationStates([
      {
        displayName: 'FSLogix Settings Catalog',
        settingStates: [
          { setting: 'device_vendor_msft_policy_config_admx_fslogixv1~policy~fslogixv1~vhdlocations', state: 'error', errorCode: 65000 },
          { setting: 'device_vendor_msft_policy_config_admx_fslogixv1~policy~fslogixv1~enabled', state: 'error', errorCode: 65000 },
        ],
      },
    ]);
    expect(result.status).toBe('missing-admx');
    expect(result.errorSettingCount).toBe(2);
    expect(result.fsLogixErrorSettings).toHaveLength(2);
    expect(result.admxSignatureDetectable).toBe(true);
  });

  it('does NOT treat the benign ADMXInstall/Receiver/Properties/Policy/FakePolicy signature as missing-admx', () => {
    const result = classifyConfigurationStates([
      { displayName: 'Other profile', settingStates: [{ setting: './Device/Vendor/MSFT/Policy/ConfigOperations/ADMXInstall/Receiver/Properties/Policy/FakePolicy', state: 'error', errorCode: 65000 }] },
    ]);
    // errorCode 65000 alone, without the FSLogixv1~ identifier, must not classify as missing-admx.
    expect(result.status).toBe('policy-errors');
    expect(result.fsLogixErrorSettings).toEqual([]);
  });

  it('is "policy-errors" when settings are in error but the FSLogix signature is not present', () => {
    const result = classifyConfigurationStates([{ displayName: 'Some other profile', settingStates: [{ setting: 'device_vendor_msft_policy_config_unrelated', state: 'error', errorCode: 12345 }] }]);
    expect(result.status).toBe('policy-errors');
    expect(result.errorSettingCount).toBe(1);
    expect(result.fsLogixErrorSettings).toEqual([]);
    expect(result.admxSignatureDetectable).toBe(true);
  });

  it('is "policy-errors" (never a confident missing-admx/ok) when a profile reports error state but carries no per-setting granularity at all — admxSignatureDetectable: false', () => {
    const result = classifyConfigurationStates([{ displayName: 'Legacy profile', state: 'error' }]);
    expect(result.status).toBe('policy-errors');
    expect(result.admxSignatureDetectable).toBe(false);
  });

  it('bounds fsLogixErrorSettings at MAX_FSLOGIX_ERROR_SETTINGS (10)', () => {
    const settingStates = Array.from({ length: 15 }, (_, i) => ({ setting: `fslogixv1~policy~setting${i}`, state: 'error', errorCode: 65000 }));
    const result = classifyConfigurationStates([{ displayName: 'FSLogix', settingStates }]);
    expect(result.status).toBe('missing-admx');
    expect(result.fsLogixErrorSettings).toHaveLength(10);
    expect(result.errorSettingCount).toBe(15);
  });

  it('matches the FSLogix signature case-insensitively', () => {
    const result = classifyConfigurationStates([{ displayName: 'FSLogix', settingStates: [{ setting: 'FSLOGIXV1~POLICY~ENABLED', state: 'error', errorCode: 65000 }] }]);
    expect(result.status).toBe('missing-admx');
  });
});

describe('computeIntunePolicyHealth — device resolution + per-host classification', () => {
  it('reports "not-enrolled" when no Intune managed device matches the host name', async () => {
    graphListAllMock.mockResolvedValueOnce({ items: [], truncated: false }); // phase 1: no devices
    const result = await computeIntunePolicyHealth(['avd-con-9'], noopLogger());
    expect(result.hosts).toEqual([{ hostName: 'avd-con-9', status: 'not-enrolled', evidence: { admxSignatureDetectable: false } }]);
    expect(result.degradation).toBeUndefined();
  });

  it('picks the device with the newest lastSyncDateTime and flags duplicateDeviceRecords when more than one device matches', async () => {
    graphListAllMock
      .mockResolvedValueOnce({
        items: [
          { id: 'stale-device', deviceName: 'avd-con-1', lastSyncDateTime: '2026-08-01T00:00:00Z' },
          { id: 'fresh-device', deviceName: 'avd-con-1', lastSyncDateTime: '2026-08-20T00:00:00Z' },
        ],
        truncated: false,
      }) // phase 1
      .mockResolvedValueOnce({ items: [], truncated: false }); // phase 2 for fresh-device

    const result = await computeIntunePolicyHealth(['avd-con-1'], noopLogger());

    expect(result.hosts).toHaveLength(1);
    expect(result.hosts[0].status).toBe('ok');
    expect(result.hosts[0].evidence.deviceId).toBe('fresh-device');
    expect(result.hosts[0].evidence.duplicateDeviceRecords).toBe(true);
    // The phase-2 call must have been made against the NEWEST device, not the stale one.
    expect(graphListAllMock).toHaveBeenCalledWith('/deviceManagement/managedDevices/fresh-device/deviceConfigurationStates');
  });

  it('classifies a clean, a policy-error, and a missing-admx host independently in one batch', async () => {
    graphListAllMock
      .mockResolvedValueOnce({
        items: [
          { id: 'dev-clean', deviceName: 'avd-clean', lastSyncDateTime: '2026-08-22T00:00:00Z' },
          { id: 'dev-errors', deviceName: 'avd-errors', lastSyncDateTime: '2026-08-22T00:00:00Z' },
          { id: 'dev-admx', deviceName: 'avd-admx', lastSyncDateTime: '2026-08-22T00:00:00Z' },
        ],
        truncated: false,
      }) // phase 1
      .mockImplementation((path: string) => {
        if (path.includes('dev-clean')) return Promise.resolve({ items: [{ displayName: 'FSLogix', settingStates: [{ setting: 'fslogixv1~policy~enabled', state: 'compliant', errorCode: 0 }] }], truncated: false });
        if (path.includes('dev-errors')) return Promise.resolve({ items: [{ displayName: 'Other', settingStates: [{ setting: 'unrelated_setting', state: 'error', errorCode: 999 }] }], truncated: false });
        if (path.includes('dev-admx')) return Promise.resolve({ items: [{ displayName: 'FSLogix', settingStates: [{ setting: 'fslogixv1~policy~vhdlocations', state: 'error', errorCode: 65000 }] }], truncated: false });
        return Promise.resolve({ items: [], truncated: false });
      });

    const result = await computeIntunePolicyHealth(['avd-clean', 'avd-errors', 'avd-admx'], noopLogger());

    const byName = Object.fromEntries(result.hosts.map((h) => [h.hostName, h]));
    expect(byName['avd-clean'].status).toBe('ok');
    expect(byName['avd-errors'].status).toBe('policy-errors');
    expect(byName['avd-admx'].status).toBe('missing-admx');
    expect(byName['avd-admx'].remediation).toContain('§5.1');
  });

  it('degrades the whole envelope to graph-not-granted (every host unknown) on a 403 resolving devices', async () => {
    graphListAllMock.mockRejectedValueOnce(new FakeGraphForbiddenError('forbidden'));

    const result = await computeIntunePolicyHealth(['avd-con-1', 'avd-con-2'], noopLogger());

    expect(result.degradation).toBe('graph-permission-not-granted');
    expect(result.grantInstructions).toEqual(INTUNE_GRAPH_GRANT_INSTRUCTIONS);
    expect(result.hosts).toEqual([
      { hostName: 'avd-con-1', status: 'unknown', evidence: { admxSignatureDetectable: false } },
      { hostName: 'avd-con-2', status: 'unknown', evidence: { admxSignatureDetectable: false } },
    ]);
  });

  it('degrades the whole envelope to graph-error (every host unknown) on a non-403 failure resolving devices', async () => {
    graphListAllMock.mockRejectedValueOnce(new Error('ETIMEDOUT'));

    const result = await computeIntunePolicyHealth(['avd-con-1'], noopLogger());

    expect(result.degradation).toBe('graph-error');
    expect(result.hosts[0].status).toBe('unknown');
    expect(result.hosts[0].evidence.correlationId).toBeDefined();
  });

  it('degrades to graph-not-granted when the SECOND permission (config-state read) 403s, without re-throwing', async () => {
    graphListAllMock
      .mockResolvedValueOnce({ items: [{ id: 'dev-1', deviceName: 'avd-con-1', lastSyncDateTime: '2026-08-22T00:00:00Z' }], truncated: false }) // phase 1
      .mockRejectedValueOnce(new FakeGraphForbiddenError('forbidden')); // phase 2

    const result = await computeIntunePolicyHealth(['avd-con-1'], noopLogger());

    expect(result.degradation).toBe('graph-permission-not-granted');
    expect(result.hosts[0].status).toBe('unknown');
  });

  it('per-host isolation: one host\'s config-state call failing (non-403) degrades ONLY that host, not the batch', async () => {
    graphListAllMock
      .mockResolvedValueOnce({
        items: [
          { id: 'dev-ok', deviceName: 'avd-ok', lastSyncDateTime: '2026-08-22T00:00:00Z' },
          { id: 'dev-bad', deviceName: 'avd-bad', lastSyncDateTime: '2026-08-22T00:00:00Z' },
        ],
        truncated: false,
      }) // phase 1
      .mockImplementation((path: string) => {
        if (path.includes('dev-bad')) return Promise.reject(new Error('unexpected 500'));
        return Promise.resolve({ items: [], truncated: false });
      });

    const result = await computeIntunePolicyHealth(['avd-ok', 'avd-bad'], noopLogger());

    expect(result.degradation).toBeUndefined();
    const byName = Object.fromEntries(result.hosts.map((h) => [h.hostName, h]));
    expect(byName['avd-ok'].status).toBe('ok');
    expect(byName['avd-bad'].status).toBe('unknown');
    expect(byName['avd-bad'].evidence.correlationId).toBeDefined();
  });
});

describe('getIntunePolicyHealth — caching', () => {
  it('serves a cached response (cached:true) on a repeat call with the same host set, without re-hitting Graph', async () => {
    graphListAllMock.mockResolvedValue({ items: [], truncated: false });

    const first = await getIntunePolicyHealth(['avd-con-1']);
    expect(first.cached).toBe(false);
    const callsAfterFirst = graphListAllMock.mock.calls.length;

    const second = await getIntunePolicyHealth(['avd-con-1']);
    expect(second.cached).toBe(true);
    expect(graphListAllMock.mock.calls.length).toBe(callsAfterFirst);
  });

  it('does NOT serve the cached response for a different host set (cache is keyed by host set)', async () => {
    graphListAllMock.mockResolvedValue({ items: [], truncated: false });

    await getIntunePolicyHealth(['avd-con-1']);
    const callsAfterFirst = graphListAllMock.mock.calls.length;

    const second = await getIntunePolicyHealth(['avd-con-1', 'avd-con-2']);
    expect(second.cached).toBe(false);
    expect(graphListAllMock.mock.calls.length).toBeGreaterThan(callsAfterFirst);
  });

  it('dedupes concurrent in-flight requests for the same host set into one Graph fetch', async () => {
    let resolveFn: (value: unknown) => void;
    const pending = new Promise((resolve) => {
      resolveFn = resolve;
    });
    graphListAllMock.mockReturnValue(pending);

    const p1 = getIntunePolicyHealth(['avd-con-1']);
    const p2 = getIntunePolicyHealth(['avd-con-1']);

    resolveFn!({ items: [], truncated: false });
    const [r1, r2] = await Promise.all([p1, p2]);

    expect(r1.cached).toBe(false);
    expect(r2.cached).toBe(true);
    expect(graphListAllMock).toHaveBeenCalledTimes(1);
  });
});
