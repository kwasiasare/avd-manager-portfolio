import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hostPoolsUpdate = vi.fn();
const hostPoolsRetrieveRegistrationToken = vi.fn();
const hostPoolsGet = vi.fn();
const hostPoolsListByResourceGroup = vi.fn();
const sessionHostsGet = vi.fn();
const scalingPlansGet = vi.fn();
const scalingPlansUpdate = vi.fn();
const scalingPlansListByHostPool = vi.fn();
const workspacesGet = vi.fn();
const workspacesUpdate = vi.fn();

// Both mocked constructors use `function` (not an arrow function) — arrow
// functions have no [[Construct]] internal slot, so `new DefaultAzureCredential()`
// / `new DesktopVirtualizationAPIClient()` in avdService.ts's getClient()
// would throw "is not a constructor" against an arrow-function mock
// implementation (vitest itself warns about exactly this).
vi.mock('@azure/identity', () => ({
  DefaultAzureCredential: vi.fn().mockImplementation(function DefaultAzureCredential() {
    return {};
  }),
}));

// Only the methods this test file actually exercises (hostPools.update /
// retrieveRegistrationToken) are stubbed — generateRegistrationToken and
// getRegistrationTokenStatus (the two functions under test below) are the
// only avdService exports that need a real-ish ARM client; every other
// avdService function is covered via the handler-level mocks in
// app/api/src/functions/*.test.ts instead, so nothing else in this module
// needs a stub here.
vi.mock('@azure/arm-desktopvirtualization', () => ({
  DesktopVirtualizationAPIClient: vi.fn().mockImplementation(function DesktopVirtualizationAPIClient() {
    return {
      hostPools: {
        update: (...args: unknown[]) => hostPoolsUpdate(...args),
        retrieveRegistrationToken: (...args: unknown[]) => hostPoolsRetrieveRegistrationToken(...args),
        get: (...args: unknown[]) => hostPoolsGet(...args),
        listByResourceGroup: (...args: unknown[]) => hostPoolsListByResourceGroup(...args),
      },
      sessionHosts: { get: (...args: unknown[]) => sessionHostsGet(...args) },
      scalingPlans: {
        get: (...args: unknown[]) => scalingPlansGet(...args),
        update: (...args: unknown[]) => scalingPlansUpdate(...args),
        listByHostPool: (...args: unknown[]) => scalingPlansListByHostPool(...args),
      },
      workspaces: {
        get: (...args: unknown[]) => workspacesGet(...args),
        update: (...args: unknown[]) => workspacesUpdate(...args),
      },
    };
  }),
}));

// Imported AFTER the mocks above so the module under test picks up the
// mocked Azure SDK constructors (same convention as
// app/api/src/functions/sessionHostDrain.test.ts).
const {
  generateRegistrationToken,
  getRegistrationTokenStatus,
  parseVmTemplate,
  resolveSessionHostVm,
  VmResourceUnresolvableError,
  isNotFoundError,
  isForbiddenError,
  isConflictError,
  setScalingPlanHostPoolEnabled,
  resolveCurrentScalingPlanRef,
  getWorkspaceFriendlyName,
  updateWorkspaceFriendlyName,
  listHostPools,
  getHostPool,
} = await import('./avdService');

const CONFIGURED_SUBSCRIPTION_ID = '00000000-0000-4000-8000-000000000001';

function vmResourceId(subscriptionId: string, resourceGroup = 'RG-AVD-HostPools', vmName = 'avd-con-0'): string {
  return `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.Compute/virtualMachines/${vmName}`;
}

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  process.env.SUBSCRIPTION_ID = CONFIGURED_SUBSCRIPTION_ID;
  process.env.RG_HOSTPOOLS = 'RG-AVD-HostPools';
  process.env.HOSTPOOL_NAME = 'HP-CONTOSO-PROD';
  hostPoolsUpdate.mockReset();
  hostPoolsRetrieveRegistrationToken.mockReset();
  hostPoolsGet.mockReset();
  hostPoolsListByResourceGroup.mockReset();
  sessionHostsGet.mockReset();
  scalingPlansGet.mockReset();
  scalingPlansUpdate.mockReset();
  scalingPlansListByHostPool.mockReset();
  workspacesGet.mockReset();
  workspacesUpdate.mockReset();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.useRealTimers();
});

describe('parseVmTemplate — AM-22 (M2-S5) vmTemplate best-effort parse', () => {
  it('returns parsed:false for undefined (missing vmTemplate)', () => {
    expect(parseVmTemplate(undefined)).toEqual({ parsed: false });
  });

  it('returns parsed:false for an empty string', () => {
    expect(parseVmTemplate('')).toEqual({ parsed: false });
  });

  it('returns parsed:false for malformed JSON', () => {
    expect(parseVmTemplate('{not valid json')).toEqual({ parsed: false });
  });

  it('returns parsed:false for valid JSON that is an array, not an object', () => {
    expect(parseVmTemplate('[1,2,3]')).toEqual({ parsed: false });
  });

  it('returns parsed:false for valid JSON that is a bare primitive', () => {
    expect(parseVmTemplate('"just a string"')).toEqual({ parsed: false });
    expect(parseVmTemplate('42')).toEqual({ parsed: false });
    expect(parseVmTemplate('null')).toEqual({ parsed: false });
  });

  it('extracts known fields from a well-formed vmTemplate, and always includes raw', () => {
    const raw = JSON.stringify({
      imageType: 'Gallery',
      galleryImagePublisher: 'contoso',
      galleryImageOffer: 'win11',
      galleryImageSKU: 'ent-m365',
      galleryImageVersion: '2.0.0',
      namePrefix: 'avd-con',
      osDiskType: 'Premium_LRS',
      vmSize: { id: 'Standard_D4ads_v7', cores: 4, ram: 16 },
      domain: '',
      hibernate: false,
    });

    expect(parseVmTemplate(raw)).toEqual({
      parsed: true,
      imageType: 'Gallery',
      galleryImagePublisher: 'contoso',
      galleryImageOffer: 'win11',
      galleryImageSKU: 'ent-m365',
      galleryImageVersion: '2.0.0',
      customImageId: undefined,
      vmSizeId: 'Standard_D4ads_v7',
      osDiskType: 'Premium_LRS',
      namePrefix: 'avd-con',
      domain: '',
      ouPath: undefined,
      hibernate: false,
      raw: JSON.parse(raw),
    });
  });

  it('leaves unmodeled/unknown fields out of the typed surface but preserves them in raw', () => {
    const raw = JSON.stringify({ namePrefix: 'avd-con', someFutureField: 'xyz' });
    const result = parseVmTemplate(raw);

    expect(result.parsed).toBe(true);
    expect(result.namePrefix).toBe('avd-con');
    expect(result.raw).toEqual({ namePrefix: 'avd-con', someFutureField: 'xyz' });
  });

  it('falls back through ouPath / OUPath / hostpoolOUPath field-name variants', () => {
    expect(parseVmTemplate(JSON.stringify({ OUPath: 'OU=AVD,DC=contoso,DC=com' })).ouPath).toBe('OU=AVD,DC=contoso,DC=com');
    expect(parseVmTemplate(JSON.stringify({ hostpoolOUPath: 'OU=Other,DC=contoso,DC=com' })).ouPath).toBe('OU=Other,DC=contoso,DC=com');
  });

  it('ignores a vmSize that is not an object with a string id', () => {
    expect(parseVmTemplate(JSON.stringify({ vmSize: 'Standard_D4ads_v7' })).vmSizeId).toBeUndefined();
    expect(parseVmTemplate(JSON.stringify({ vmSize: { cores: 4 } })).vmSizeId).toBeUndefined();
  });
});

describe('mapHostPool (via listHostPools / getHostPool) — AM-38', () => {
  // SDK-shaped fixture: field names copied verbatim from
  // @azure/arm-desktopvirtualization's HostPool interface (types/arm-desktopvirtualization.d.ts)
  // — startVMOnConnect, ring, customRdpProperty — so this test fails if the
  // mapping ever drifts from the SDK's actual property names/casing.
  function armHostPoolFixture(overrides: Record<string, unknown> = {}) {
    return {
      id: '/subscriptions/sub/resourceGroups/RG-AVD-HostPools/providers/Microsoft.DesktopVirtualization/hostPools/HP-CONTOSO-PROD',
      name: 'HP-CONTOSO-PROD',
      friendlyName: 'Contoso Production',
      hostPoolType: 'Pooled',
      loadBalancerType: 'BreadthFirst',
      preferredAppGroupType: 'Desktop',
      maxSessionLimit: 4,
      validationEnvironment: false,
      startVMOnConnect: true,
      ring: 2,
      customRdpProperty: 'drivestoredirect:s:;redirectclipboard:i:1;',
      ...overrides,
    };
  }

  it('listHostPools surfaces startVMOnConnect: true from ARM — GET /v1/hostpools (the endpoint the Host Pool page\'s Properties card calls) must not silently drop it', async () => {
    hostPoolsListByResourceGroup.mockReturnValue(
      (async function* () {
        yield armHostPoolFixture({ startVMOnConnect: true });
      })(),
    );

    const [pool] = await listHostPools();

    expect(pool.startVMOnConnect).toBe(true);
    expect(pool.ring).toBe(2);
    expect(pool.customRdpProperty).toBe('drivestoredirect:s:;redirectclipboard:i:1;');
  });

  it('listHostPools surfaces startVMOnConnect: false from ARM (distinct from undefined)', async () => {
    hostPoolsListByResourceGroup.mockReturnValue(
      (async function* () {
        yield armHostPoolFixture({ startVMOnConnect: false });
      })(),
    );

    const [pool] = await listHostPools();

    expect(pool.startVMOnConnect).toBe(false);
  });

  it('listHostPools leaves startVMOnConnect undefined when ARM omits it (never coerces to false)', async () => {
    const fixture = armHostPoolFixture();
    delete (fixture as { startVMOnConnect?: boolean }).startVMOnConnect;
    hostPoolsListByResourceGroup.mockReturnValue(
      (async function* () {
        yield fixture;
      })(),
    );

    const [pool] = await listHostPools();

    expect(pool.startVMOnConnect).toBeUndefined();
  });

  it('getHostPool (single host pool detail) also surfaces startVMOnConnect from the same SDK field', async () => {
    hostPoolsGet.mockResolvedValue(armHostPoolFixture({ startVMOnConnect: true }));

    const pool = await getHostPool('HP-CONTOSO-PROD');

    expect(pool?.startVMOnConnect).toBe(true);
  });
});

describe('generateRegistrationToken — ARM call shape (Opus peer review, AM-22, items 9a/9b)', () => {
  it('PATCHes hostPools.update with a body containing ONLY registrationInfo — nothing else', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-15T00:00:00.000Z'));
    hostPoolsUpdate.mockResolvedValue({
      registrationInfo: { token: 'tok', expirationTime: new Date('2026-08-15T05:00:00.000Z') },
    });

    await generateRegistrationToken('HP-CONTOSO-PROD', 5);

    expect(hostPoolsUpdate).toHaveBeenCalledTimes(1);
    const [resourceGroup, hostPoolName, options] = hostPoolsUpdate.mock.calls[0];
    expect(resourceGroup).toBe('RG-AVD-HostPools');
    expect(hostPoolName).toBe('HP-CONTOSO-PROD');
    // Exact body — proves no other HostPoolPatch property (maxSessionLimit,
    // customRdpProperty, vmTemplate, etc.) is ever sent by this call.
    expect(options).toEqual({
      hostPool: {
        registrationInfo: {
          expirationTime: new Date('2026-08-15T05:00:00.000Z'),
          registrationTokenOperation: 'Update',
        },
      },
    });
  });

  it('computes expirationTime as exactly now + hoursValid', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T12:00:00.000Z'));
    hostPoolsUpdate.mockResolvedValue({
      registrationInfo: { token: 'tok', expirationTime: new Date('2026-01-01T13:00:00.000Z') },
    });

    await generateRegistrationToken('HP-CONTOSO-PROD', 1);

    const [, , options] = hostPoolsUpdate.mock.calls[0];
    expect(options.hostPool.registrationInfo.expirationTime).toEqual(new Date('2026-01-01T13:00:00.000Z'));
  });

  it('returns the token and ISO expirationTime ARM echoes back in its response', async () => {
    hostPoolsUpdate.mockResolvedValue({
      registrationInfo: { token: 'live-token-value', expirationTime: new Date('2026-08-16T00:00:00.000Z') },
    });

    const result = await generateRegistrationToken('HP-CONTOSO-PROD', 24);

    expect(result).toEqual({ token: 'live-token-value', expirationTime: '2026-08-16T00:00:00.000Z' });
  });

  it('throws (rather than returning a partial success) if ARM omits the token in its response', async () => {
    hostPoolsUpdate.mockResolvedValue({ registrationInfo: { expirationTime: new Date() } });

    await expect(generateRegistrationToken('HP-CONTOSO-PROD', 1)).rejects.toThrow();
  });
});

describe('getRegistrationTokenStatus — the token value never appears in the result (Opus peer review, AM-22, item 9c)', () => {
  it('returns only { exists, expirationTime } — no `token` key anywhere in the result', async () => {
    hostPoolsRetrieveRegistrationToken.mockResolvedValue({
      token: 'super-secret-token-value',
      expirationTime: new Date(Date.now() + 60 * 60 * 1000),
    });

    const result = await getRegistrationTokenStatus('HP-CONTOSO-PROD');

    expect(result.exists).toBe(true);
    expect('token' in result).toBe(false);
    expect(Object.keys(result).sort()).toEqual(['exists', 'expirationTime']);
    expect(JSON.stringify(result)).not.toContain('super-secret-token-value');
  });
});

describe('getRegistrationTokenStatus — expiry handling (Opus peer review, AM-22, item 9d)', () => {
  it('reports exists:false for a token whose expirationTime has already passed', async () => {
    hostPoolsRetrieveRegistrationToken.mockResolvedValue({
      token: 'stale-token',
      expirationTime: new Date(Date.now() - 60 * 60 * 1000),
    });

    expect(await getRegistrationTokenStatus('HP-CONTOSO-PROD')).toEqual({ exists: false });
  });

  it('reports exists:true with the ISO expirationTime for a still-valid token', async () => {
    const future = new Date(Date.now() + 2 * 60 * 60 * 1000);
    hostPoolsRetrieveRegistrationToken.mockResolvedValue({ token: 'live-token', expirationTime: future });

    expect(await getRegistrationTokenStatus('HP-CONTOSO-PROD')).toEqual({ exists: true, expirationTime: future.toISOString() });
  });

  it('reports exists:false when no token has ever been generated (ARM 404)', async () => {
    hostPoolsRetrieveRegistrationToken.mockRejectedValue(Object.assign(new Error('not found'), { statusCode: 404 }));

    expect(await getRegistrationTokenStatus('HP-CONTOSO-PROD')).toEqual({ exists: false });
  });

  it('reports exists:false when ARM returns no token/expirationTime at all', async () => {
    hostPoolsRetrieveRegistrationToken.mockResolvedValue({});

    expect(await getRegistrationTokenStatus('HP-CONTOSO-PROD')).toEqual({ exists: false });
  });

  it('propagates a non-404 ARM error rather than reporting exists:false', async () => {
    hostPoolsRetrieveRegistrationToken.mockRejectedValue(Object.assign(new Error('forbidden'), { statusCode: 403 }));

    await expect(getRegistrationTokenStatus('HP-CONTOSO-PROD')).rejects.toThrow('forbidden');
  });
});

describe('resolveSessionHostVm', () => {
  it('resolves resourceGroup, vmName, and the server-observed activeSessions from ARM sessionHosts.get', async () => {
    sessionHostsGet.mockResolvedValue({
      resourceId: vmResourceId(CONFIGURED_SUBSCRIPTION_ID),
      sessions: 4,
    });

    const result = await resolveSessionHostVm('HP-CONTOSO-PROD', 'avd-con-0');

    expect(sessionHostsGet).toHaveBeenCalledWith('RG-AVD-HostPools', 'HP-CONTOSO-PROD', 'avd-con-0');
    expect(result).toEqual({ resourceGroup: 'RG-AVD-HostPools', vmName: 'avd-con-0', activeSessions: 4 });
  });

  it('defaults activeSessions to 0 when ARM omits `sessions` (mirrors avdService.mapSessionHost)', async () => {
    sessionHostsGet.mockResolvedValue({ resourceId: vmResourceId(CONFIGURED_SUBSCRIPTION_ID) });

    const result = await resolveSessionHostVm('HP-CONTOSO-PROD', 'avd-con-0');

    expect(result.activeSessions).toBe(0);
  });

  it('throws VmResourceUnresolvableError when resourceId does not parse to a VM id', async () => {
    sessionHostsGet.mockResolvedValue({ resourceId: undefined, sessions: 0 });

    await expect(resolveSessionHostVm('HP-CONTOSO-PROD', 'avd-con-0')).rejects.toBeInstanceOf(VmResourceUnresolvableError);
  });

  it('AM-19 peer review item 4 — subscription safety: throws VmResourceUnresolvableError when the VM resourceId is in a DIFFERENT subscription than configured, rather than silently returning a same-named RG/VM pair', async () => {
    const wrongSubscriptionId = '00000000-0000-0000-0000-000000000000';
    sessionHostsGet.mockResolvedValue({
      resourceId: vmResourceId(wrongSubscriptionId),
      sessions: 0,
    });

    await expect(resolveSessionHostVm('HP-CONTOSO-PROD', 'avd-con-0')).rejects.toBeInstanceOf(VmResourceUnresolvableError);
    await expect(resolveSessionHostVm('HP-CONTOSO-PROD', 'avd-con-0')).rejects.toThrow(/subscription/i);
  });

  it('AM-28 peer review item 13 — resource-group safety: throws VmResourceUnresolvableError when the VM resourceId is in a DIFFERENT resource group than configured', async () => {
    sessionHostsGet.mockResolvedValue({
      resourceId: vmResourceId(CONFIGURED_SUBSCRIPTION_ID, 'RG-SomeOtherGroup'),
      sessions: 0,
    });

    await expect(resolveSessionHostVm('HP-CONTOSO-PROD', 'avd-con-0')).rejects.toBeInstanceOf(VmResourceUnresolvableError);
    await expect(resolveSessionHostVm('HP-CONTOSO-PROD', 'avd-con-0')).rejects.toThrow(/resource group/i);
  });

  it('treats a resource group match as case-insensitive', async () => {
    sessionHostsGet.mockResolvedValue({
      resourceId: vmResourceId(CONFIGURED_SUBSCRIPTION_ID, 'RG-AVD-HOSTPOOLS'),
      sessions: 1,
    });

    await expect(resolveSessionHostVm('HP-CONTOSO-PROD', 'avd-con-0')).resolves.toMatchObject({ resourceGroup: 'RG-AVD-HOSTPOOLS', vmName: 'avd-con-0' });
  });

  it('treats a subscription id match as case-insensitive', async () => {
    sessionHostsGet.mockResolvedValue({
      resourceId: vmResourceId(CONFIGURED_SUBSCRIPTION_ID.toUpperCase()),
      sessions: 1,
    });

    await expect(resolveSessionHostVm('HP-CONTOSO-PROD', 'avd-con-0')).resolves.toMatchObject({ resourceGroup: 'RG-AVD-HostPools', vmName: 'avd-con-0' });
  });

  it('propagates a raw ARM error (e.g. 404) rather than wrapping it, so callers can map via isNotFoundError', async () => {
    const notFound = Object.assign(new Error('not found'), { statusCode: 404 });
    sessionHostsGet.mockRejectedValue(notFound);

    await expect(resolveSessionHostVm('HP-CONTOSO-PROD', 'avd-con-0')).rejects.toBe(notFound);
  });
});

describe('isNotFoundError / isForbiddenError / isConflictError', () => {
  it('each match only their own statusCode', () => {
    const err = (statusCode: number) => Object.assign(new Error('x'), { statusCode });

    expect(isNotFoundError(err(404))).toBe(true);
    expect(isNotFoundError(err(403))).toBe(false);
    expect(isForbiddenError(err(403))).toBe(true);
    expect(isForbiddenError(err(409))).toBe(false);
    expect(isConflictError(err(409))).toBe(true);
    expect(isConflictError(err(404))).toBe(false);
  });

  it('return false for non-error-shaped values', () => {
    expect(isNotFoundError(undefined)).toBe(false);
    expect(isForbiddenError('boom')).toBe(false);
    expect(isConflictError({})).toBe(false);
  });
});

describe('resolveCurrentScalingPlanRef — AM-23 (M3-S1)', () => {
  it('returns the scaling plan name/resource group (parsed from the PLAN\'S OWN id, not assumed)/host pool id for the configured host pool', async () => {
    hostPoolsGet.mockResolvedValue({ id: '/subscriptions/sub/resourceGroups/RG-AVD-HostPools/providers/Microsoft.DesktopVirtualization/hostPools/HP-CONTOSO-PROD' });
    scalingPlansListByHostPool.mockReturnValue(
      (async function* () {
        yield { name: 'SCALE-CONTOSO-PROD', id: '/subscriptions/sub/resourceGroups/RG-AVD-HostPools/providers/Microsoft.DesktopVirtualization/scalingPlans/SCALE-CONTOSO-PROD' };
      })(),
    );

    await expect(resolveCurrentScalingPlanRef()).resolves.toEqual({
      scalingPlanName: 'SCALE-CONTOSO-PROD',
      resourceGroup: 'RG-AVD-HostPools',
      hostPoolId: '/subscriptions/sub/resourceGroups/RG-AVD-HostPools/providers/Microsoft.DesktopVirtualization/hostPools/HP-CONTOSO-PROD',
    });
  });

  it('parses the resource group from a DIFFERENT resource group than the configured host-pools RG, if the plan lives elsewhere', async () => {
    hostPoolsGet.mockResolvedValue({ id: '/subscriptions/sub/resourceGroups/RG-AVD-HostPools/providers/Microsoft.DesktopVirtualization/hostPools/HP-CONTOSO-PROD' });
    scalingPlansListByHostPool.mockReturnValue(
      (async function* () {
        yield { name: 'SCALE-CONTOSO-PROD', id: '/subscriptions/sub/resourceGroups/RG-AVD-Scaling/providers/Microsoft.DesktopVirtualization/scalingPlans/SCALE-CONTOSO-PROD' };
      })(),
    );

    await expect(resolveCurrentScalingPlanRef()).resolves.toMatchObject({ resourceGroup: 'RG-AVD-Scaling' });
  });

  it('throws when ARM returns a plan with no name', async () => {
    hostPoolsGet.mockResolvedValue({ id: '/subscriptions/sub/resourceGroups/RG-AVD-HostPools/providers/Microsoft.DesktopVirtualization/hostPools/HP-CONTOSO-PROD' });
    scalingPlansListByHostPool.mockReturnValue(
      (async function* () {
        yield { id: '/subscriptions/sub/resourceGroups/RG-AVD-HostPools/providers/Microsoft.DesktopVirtualization/scalingPlans/SCALE-CONTOSO-PROD' };
      })(),
    );
    await expect(resolveCurrentScalingPlanRef()).rejects.toThrow(/no name/i);
  });

  it('throws when the plan\'s own resource id has no parseable resource group', async () => {
    hostPoolsGet.mockResolvedValue({ id: '/subscriptions/sub/resourceGroups/RG-AVD-HostPools/providers/Microsoft.DesktopVirtualization/hostPools/HP-CONTOSO-PROD' });
    scalingPlansListByHostPool.mockReturnValue(
      (async function* () {
        yield { name: 'SCALE-CONTOSO-PROD', id: 'not-a-real-resource-id' };
      })(),
    );
    await expect(resolveCurrentScalingPlanRef()).rejects.toThrow(/resource group/i);
  });

  it('returns null when no scaling plan is associated with the host pool', async () => {
    hostPoolsGet.mockResolvedValue({ id: '/subscriptions/sub/resourceGroups/RG-AVD-HostPools/providers/Microsoft.DesktopVirtualization/hostPools/HP-CONTOSO-PROD' });
    scalingPlansListByHostPool.mockReturnValue((async function* () {})());

    await expect(resolveCurrentScalingPlanRef()).resolves.toBeNull();
  });
});

describe('setScalingPlanHostPoolEnabled — AM-23 (M3-S1) emergency override mechanism', () => {
  const RESOURCE_GROUP = 'RG-AVD-HostPools';
  const HOST_POOL_ID = '/subscriptions/sub/resourceGroups/RG-AVD-HostPools/providers/Microsoft.DesktopVirtualization/hostPools/HP-CONTOSO-PROD';
  const OTHER_HOST_POOL_ID = '/subscriptions/sub/resourceGroups/RG-AVD-HostPools/providers/Microsoft.DesktopVirtualization/hostPools/HP-AVD-OTHER';

  it('flips scalingPlanEnabled ONLY for the matching hostPoolArmPath, preserving every other reference untouched, using the PASSED-IN resourceGroup (not getConfig())', async () => {
    scalingPlansGet.mockResolvedValue({
      hostPoolReferences: [
        { hostPoolArmPath: HOST_POOL_ID, scalingPlanEnabled: true },
        { hostPoolArmPath: OTHER_HOST_POOL_ID, scalingPlanEnabled: true },
      ],
    });
    scalingPlansUpdate.mockImplementation((_rg: string, _name: string, body: { scalingPlan: { hostPoolReferences: unknown[] } }) => Promise.resolve({ hostPoolReferences: body.scalingPlan.hostPoolReferences }));

    const result = await setScalingPlanHostPoolEnabled(RESOURCE_GROUP, 'SCALE-CONTOSO-PROD', HOST_POOL_ID, false);

    expect(scalingPlansGet).toHaveBeenCalledWith(RESOURCE_GROUP, 'SCALE-CONTOSO-PROD');
    expect(scalingPlansUpdate).toHaveBeenCalledWith(RESOURCE_GROUP, 'SCALE-CONTOSO-PROD', expect.anything());
    expect(result).toEqual([
      { hostPoolArmPath: HOST_POOL_ID, scalingPlanEnabled: false },
      { hostPoolArmPath: OTHER_HOST_POOL_ID, scalingPlanEnabled: true },
    ]);
  });

  it('matches hostPoolArmPath case-insensitively', async () => {
    scalingPlansGet.mockResolvedValue({ hostPoolReferences: [{ hostPoolArmPath: HOST_POOL_ID.toUpperCase(), scalingPlanEnabled: true }] });
    scalingPlansUpdate.mockImplementation((_rg: string, _name: string, body: { scalingPlan: { hostPoolReferences: unknown[] } }) => Promise.resolve({ hostPoolReferences: body.scalingPlan.hostPoolReferences }));

    const result = await setScalingPlanHostPoolEnabled(RESOURCE_GROUP, 'SCALE-CONTOSO-PROD', HOST_POOL_ID, false);
    expect(result).toEqual([{ hostPoolArmPath: HOST_POOL_ID.toUpperCase(), scalingPlanEnabled: false }]);
  });

  it('appends the reference (defensively) if the host pool is somehow not already present', async () => {
    scalingPlansGet.mockResolvedValue({ hostPoolReferences: [] });
    scalingPlansUpdate.mockImplementation((_rg: string, _name: string, body: { scalingPlan: { hostPoolReferences: unknown[] } }) => Promise.resolve({ hostPoolReferences: body.scalingPlan.hostPoolReferences }));

    const result = await setScalingPlanHostPoolEnabled(RESOURCE_GROUP, 'SCALE-CONTOSO-PROD', HOST_POOL_ID, true);
    expect(result).toEqual([{ hostPoolArmPath: HOST_POOL_ID, scalingPlanEnabled: true }]);
  });
});

describe('getWorkspaceFriendlyName — AM-14 (M6)', () => {
  it('reads workspaces.get against the configured resource group + workspace name and returns friendlyName', async () => {
    workspacesGet.mockResolvedValue({ friendlyName: 'Contoso Desktop' });
    const result = await getWorkspaceFriendlyName();
    expect(workspacesGet).toHaveBeenCalledWith('RG-AVD-HostPools', 'Contoso-Desktop');
    expect(result).toBe('Contoso Desktop');
  });

  it('returns undefined when ARM reports no friendlyName set', async () => {
    workspacesGet.mockResolvedValue({});
    await expect(getWorkspaceFriendlyName()).resolves.toBeUndefined();
  });
});

describe('updateWorkspaceFriendlyName — AM-14 (M6)', () => {
  it('sends ONLY friendlyName in the workspaces.update patch body (merge-patch — no other property touched)', async () => {
    workspacesUpdate.mockResolvedValue({ friendlyName: 'New Name' });
    const result = await updateWorkspaceFriendlyName('New Name');
    expect(workspacesUpdate).toHaveBeenCalledWith('RG-AVD-HostPools', 'Contoso-Desktop', { workspace: { friendlyName: 'New Name' } });
    expect(result).toBe('New Name');
  });
});
