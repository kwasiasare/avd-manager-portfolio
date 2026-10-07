import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Verifies the AM-19 async/poller design (see beginVmPowerAction's doc
 * comment in computeService.ts): the function must await ONLY
 * poller.submitted() — never pollUntilDone()/the poller's own `.then` — so
 * a slow VM transition can never hold a Function invocation open. Each fake
 * poller below tracks which of its methods were called so a regression
 * (e.g. someone "helpfully" adding an await on the full operation) fails
 * these tests immediately.
 */
function makePoller(name: string, calls: string[]) {
  return {
    submitted: vi.fn(async () => {
      calls.push(`${name}.submitted`);
    }),
    pollUntilDone: vi.fn(async () => {
      calls.push(`${name}.pollUntilDone`);
    }),
  };
}

const calls: string[] = [];
const start = vi.fn();
const restart = vi.fn();
const deallocate = vi.fn();
const deleteVm = vi.fn();
const getVm = vi.fn();

vi.mock('@azure/identity', () => ({
  DefaultAzureCredential: class {},
}));

vi.mock('@azure/arm-compute', () => ({
  ComputeManagementClient: class {
    virtualMachines = { start, restart, deallocate, delete: deleteVm, get: getVm, instanceView: vi.fn() };
  },
}));

// Imported once, at module top level (not per-test) — same convention as
// sessionHostDrain.test.ts / sessionHostPower.test.ts, and the fix applied
// to avdService.test.ts's flaky first test: importing dynamically INSIDE
// each `it()` puts part of that test's own module-evaluation cost inside
// its 5s timeout budget instead of the file's separately-accounted "import"
// phase, which is a latent flake risk under parallel-worker CPU contention
// even for a module this size.
const { beginVmDelete, beginVmPowerAction, getVmImageReference, parseVmResourceId } = await import('./computeService');

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  process.env.SUBSCRIPTION_ID = 'sub-id';
  process.env.RG_HOSTPOOLS = 'RG-AVD-HostPools';
  process.env.HOSTPOOL_NAME = 'HP-CONTOSO-PROD';
  calls.length = 0;
  start.mockReset();
  restart.mockReset();
  deallocate.mockReset();
  deleteVm.mockReset();
  getVm.mockReset();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('beginVmPowerAction', () => {
  it.each([
    ['start', () => start],
    ['restart', () => restart],
    ['deallocate', () => deallocate],
  ] as const)('dispatches %s to the matching VirtualMachines operation and awaits only submitted(), never pollUntilDone()', async (action, getMock) => {
    const mock = getMock();
    const poller = makePoller(action, calls);
    mock.mockReturnValue(poller);

    await beginVmPowerAction('RG-AVD-HostPools', 'avd-con-0', action);

    expect(mock).toHaveBeenCalledWith('RG-AVD-HostPools', 'avd-con-0', { abortSignal: expect.any(AbortSignal) });
    expect(poller.submitted).toHaveBeenCalledTimes(1);
    expect(poller.pollUntilDone).not.toHaveBeenCalled();
    expect(calls).toEqual([`${action}.submitted`]);
  });

  it('propagates a rejection from poller.submitted() (e.g. ARM rejected the initial request) rather than swallowing it', async () => {
    const poller = {
      submitted: vi.fn().mockRejectedValue(Object.assign(new Error('not found'), { statusCode: 404 })),
      pollUntilDone: vi.fn(),
    };
    start.mockReturnValue(poller);

    await expect(beginVmPowerAction('RG-AVD-HostPools', 'avd-con-0', 'start')).rejects.toMatchObject({ statusCode: 404 });
    expect(poller.pollUntilDone).not.toHaveBeenCalled();
  });

  it('AM-19 peer review item 3: bounds the initial ARM request with a default AbortSignal.timeout() when the caller supplies no abortSignal', async () => {
    const poller = makePoller('start', calls);
    start.mockReturnValue(poller);

    await beginVmPowerAction('RG-AVD-HostPools', 'avd-con-0', 'start');

    const [, , options] = start.mock.calls[0] as [string, string, { abortSignal: AbortSignal }];
    expect(options.abortSignal).toBeInstanceOf(AbortSignal);
    expect(options.abortSignal.aborted).toBe(false);
  });

  it('forwards a caller-supplied abortSignal through to the SDK call instead of the default timeout', async () => {
    const poller = makePoller('restart', calls);
    restart.mockReturnValue(poller);
    const controller = new AbortController();

    await beginVmPowerAction('RG-AVD-HostPools', 'avd-con-0', 'restart', { abortSignal: controller.signal });

    expect(restart).toHaveBeenCalledWith('RG-AVD-HostPools', 'avd-con-0', { abortSignal: controller.signal });
  });
});

describe('beginVmDelete', () => {
  it('AM-28: calls virtualMachines.delete and awaits only submitted(), never pollUntilDone() — same design as beginVmPowerAction', async () => {
    const poller = makePoller('delete', calls);
    deleteVm.mockReturnValue(poller);

    await beginVmDelete('RG-AVD-HostPools', 'avd-con-0');

    expect(deleteVm).toHaveBeenCalledWith('RG-AVD-HostPools', 'avd-con-0', { abortSignal: expect.any(AbortSignal) });
    expect(poller.submitted).toHaveBeenCalledTimes(1);
    expect(poller.pollUntilDone).not.toHaveBeenCalled();
    expect(calls).toEqual(['delete.submitted']);
  });

  it('propagates a rejection from poller.submitted() rather than swallowing it', async () => {
    const poller = { submitted: vi.fn().mockRejectedValue(Object.assign(new Error('not found'), { statusCode: 404 })), pollUntilDone: vi.fn() };
    deleteVm.mockReturnValue(poller);

    await expect(beginVmDelete('RG-AVD-HostPools', 'avd-con-0')).rejects.toMatchObject({ statusCode: 404 });
    expect(poller.pollUntilDone).not.toHaveBeenCalled();
  });

  it('forwards a caller-supplied abortSignal through to the SDK call instead of the default timeout', async () => {
    const poller = makePoller('delete', calls);
    deleteVm.mockReturnValue(poller);
    const controller = new AbortController();

    await beginVmDelete('RG-AVD-HostPools', 'avd-con-0', { abortSignal: controller.signal });

    expect(deleteVm).toHaveBeenCalledWith('RG-AVD-HostPools', 'avd-con-0', { abortSignal: controller.signal });
  });
});

describe('getVmImageReference', () => {
  it('AM-28: returns exactVersion + id from storageProfile.imageReference', async () => {
    getVm.mockResolvedValue({
      storageProfile: {
        imageReference: {
          id: '/subscriptions/sub/resourceGroups/RG-AVD-Images/providers/Microsoft.Compute/galleries/ACG_AVD_CONTOSO/images/WIN11-ENT-MS-M365/versions/3.0.0',
          exactVersion: '3.0.0',
        },
      },
    });

    const result = await getVmImageReference('RG-AVD-HostPools', 'avd-con-1');

    expect(getVm).toHaveBeenCalledWith('RG-AVD-HostPools', 'avd-con-1');
    expect(result).toEqual({
      exactVersion: '3.0.0',
      id: '/subscriptions/sub/resourceGroups/RG-AVD-Images/providers/Microsoft.Compute/galleries/ACG_AVD_CONTOSO/images/WIN11-ENT-MS-M365/versions/3.0.0',
    });
  });

  it('returns undefined when imageReference is absent (e.g. a managed-image-built VM)', async () => {
    getVm.mockResolvedValue({ storageProfile: {} });

    await expect(getVmImageReference('RG-AVD-HostPools', 'avd-con-1')).resolves.toBeUndefined();
  });

  it('returns undefined when storageProfile itself is absent', async () => {
    getVm.mockResolvedValue({});

    await expect(getVmImageReference('RG-AVD-HostPools', 'avd-con-1')).resolves.toBeUndefined();
  });

  it('propagates a lookup failure (e.g. VM not found) rather than swallowing it — callers degrade per-host, not here', async () => {
    getVm.mockRejectedValue(Object.assign(new Error('not found'), { statusCode: 404 }));

    await expect(getVmImageReference('RG-AVD-HostPools', 'avd-con-1')).rejects.toThrow('not found');
  });
});

describe('parseVmResourceId', () => {
  const REAL_RESOURCE_ID =
    '/subscriptions/00000000-0000-4000-8000-000000000001/resourceGroups/RG-AVD-HostPools/providers/Microsoft.Compute/virtualMachines/avd-con-0';

  it('captures subscriptionId, resourceGroup, and vmName from a well-formed resource id (AM-19 peer review item 4)', () => {
    expect(parseVmResourceId(REAL_RESOURCE_ID)).toEqual({
      subscriptionId: '00000000-0000-4000-8000-000000000001',
      resourceGroup: 'RG-AVD-HostPools',
      vmName: 'avd-con-0',
    });
  });

  it('is case-insensitive on the provider segment', () => {
    const upper = REAL_RESOURCE_ID.replace('Microsoft.Compute', 'MICROSOFT.COMPUTE');

    expect(parseVmResourceId(upper)?.vmName).toBe('avd-con-0');
  });

  it('returns null for undefined/empty', () => {
    expect(parseVmResourceId(undefined)).toBeNull();
    expect(parseVmResourceId('')).toBeNull();
  });

  it('returns null for a malformed id missing the /subscriptions prefix (anchored match — not a suffix match)', () => {
    const suffixOnly = '/resourceGroups/RG-AVD-HostPools/providers/Microsoft.Compute/virtualMachines/avd-con-0';

    expect(parseVmResourceId(suffixOnly)).toBeNull();
  });

  it('returns null for a resourceId pointing at a different resource type (not virtualMachines)', () => {
    const notAVm = REAL_RESOURCE_ID.replace('virtualMachines', 'disks');

    expect(parseVmResourceId(notAVm)).toBeNull();
  });
});
