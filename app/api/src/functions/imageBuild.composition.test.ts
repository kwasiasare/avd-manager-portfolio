import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HttpRequest, InvocationContext, Timer } from '@azure/functions';

/**
 * AM-27 (M4-S2) — COMPOSITION TEST (Opus review BLOCKER 1's mandatory
 * regression test). Walks a build from 'planned' all the way to 'done'
 * through the REAL imageBuilds.ts handlers, the REAL imageBuildTimer.ts,
 * the REAL imageBuildOrchestrator.ts, the REAL imageBuildService.ts, and
 * the REAL imageBuildStateMachine.ts — nothing in that stack is mocked.
 * Only the three external systems are faked:
 *   - @azure/arm-compute / @azure/arm-network (stateful in-memory fakes
 *     simulating VM/NIC/snapshot/gallery-image-version lifecycle)
 *   - @azure/data-tables (a stateful in-memory Table, with real ETag
 *     versioning, real createEntity/getEntity/updateEntity/listEntities
 *     semantics — including a real OData `state ne 'x'` filter simulation)
 *   - @azure/identity (DefaultAzureCredential — never actually used)
 *   - ../lib/auditLog (writeAuditEntry — a real Table write here would be
 *     redundant with the fake ImageBuild table's own consistency checks)
 *
 * THIS TEST FAILS BEFORE THE BLOCKER 1 FIX and PASSES AFTER IT: the
 * capturing state's real sequence self-transitions TWICE (capturing ->
 * capturing after generalize; capturing -> capturing after submitting the
 * gallery image version create) and the cleanup state self-transitions
 * once (cleanup -> cleanup once the VM delete confirms but NIC/disk are
 * still draining) — every one of those was an `assertTransition(X, X)`
 * call under the pre-fix code, which threw IllegalImageBuildTransitionError
 * every time, was silently swallowed by imageBuildTimer.ts's catch block,
 * and persisted NOTHING — so the build would loop forever re-calling
 * `generalize`/re-submitting the capture/re-polling a phantom in-progress
 * delete, never reaching 'done'. This test drives the REAL timer in a
 * bounded loop (MAX_TICKS) and asserts the build reaches 'done' within
 * that bound — pre-fix, it never does, and the assertion (or the bound
 * itself) fails; post-fix, it reaches 'done' in a small, deterministic
 * number of ticks.
 */

// ---------------------------------------------------------------------------
// Fake Azure Compute / Network — stateful, in-memory, simulate exactly the
// lifecycle transitions this build walks through.
// ---------------------------------------------------------------------------
interface FakeVm {
  name: string;
  provisioningState: string;
  powerState: 'running' | 'stopped' | 'deallocated';
  generalized: boolean;
  imageReference: { exactVersion: string };
  deleted?: boolean;
  deleteGraceRemaining: number;
}
interface FakeResource {
  name: string;
  provisioningState: string;
  deleted?: boolean;
  deleteGraceRemaining: number;
}

const vms = new Map<string, FakeVm>();
const nics = new Map<string, FakeResource>();
const disks = new Map<string, FakeResource>();
const snapshots = new Map<string, FakeResource>();
const galleryVersions = new Map<string, { id: string; provisioningState: string }>();

function notFoundError(): Error {
  return Object.assign(new Error('not found'), { statusCode: 404 });
}

/** Simulates ARM eventual-consistency on delete: the resource "exists" (get() succeeds) for `deleteGraceRemaining` more calls after delete() is submitted, then vanishes — this is what makes pollCleanup's per-resource loop take more than one tick for SOME resources, which is exactly the self-transition path Blocker 1 broke. */
function fakeGet<T extends { deleted?: boolean; deleteGraceRemaining: number }>(map: Map<string, T>, name: string): T {
  const entry = map.get(name);
  if (!entry) throw notFoundError();
  if (entry.deleted) {
    if (entry.deleteGraceRemaining > 0) {
      entry.deleteGraceRemaining -= 1;
      return entry;
    }
    map.delete(name);
    throw notFoundError();
  }
  return entry;
}

function makePoller<T>(resolve: () => T | Promise<T>) {
  return {
    submitted: async () => {
      await resolve();
    },
    pollUntilDone: async () => {
      return resolve();
    },
  };
}

vi.mock('@azure/identity', () => ({ DefaultAzureCredential: class {} }));

vi.mock('@azure/arm-compute', () => ({
  ComputeManagementClient: class {
    virtualMachines = {
      createOrUpdate: (rg: string, name: string, params: { storageProfile?: { osDisk?: { name?: string } } }) =>
        makePoller(() => {
          vms.set(name, { name, provisioningState: 'Succeeded', powerState: 'running', generalized: false, imageReference: { exactVersion: '26200.8875.260714' }, deleteGraceRemaining: 0 });
          // The real VM create implicitly provisions the OS disk named in
          // storageProfile.osDisk.name — simulated here so
          // pollCleanup's disk-delete polling has a real resource to poll.
          const diskName = params.storageProfile?.osDisk?.name;
          if (diskName) disks.set(diskName, { name: diskName, provisioningState: 'Succeeded', deleteGraceRemaining: 0 });
        }),
      get: async (_rg: string, name: string) => {
        const vm = fakeGet(vms, name);
        return { provisioningState: vm.provisioningState, storageProfile: { imageReference: vm.imageReference } };
      },
      instanceView: async (_rg: string, name: string) => {
        const vm = fakeGet(vms, name);
        return { statuses: [{ code: `PowerState/${vm.powerState}` }] };
      },
      deallocate: (_rg: string, name: string) =>
        makePoller(() => {
          const vm = vms.get(name);
          if (vm) vm.powerState = 'deallocated';
        }),
      generalize: async (_rg: string, name: string) => {
        const vm = vms.get(name);
        if (vm) vm.generalized = true;
      },
      runCommand: (_rg: string, _name: string) => makePoller(() => undefined),
      delete: (_rg: string, name: string) =>
        makePoller(() => {
          const vm = vms.get(name);
          if (vm) {
            vm.deleted = true;
            vm.deleteGraceRemaining = 0; // VM delete confirms on the very next poll.
          }
        }),
    };
    snapshots = {
      createOrUpdate: (_rg: string, name: string) =>
        makePoller(() => {
          snapshots.set(name, { name, provisioningState: 'Succeeded', deleteGraceRemaining: 0 });
        }),
      get: async (_rg: string, name: string) => {
        const snap = fakeGet(snapshots, name);
        return { provisioningState: snap.provisioningState };
      },
    };
    disks = {
      get: async (_rg: string, name: string) => fakeGet(disks, name),
      delete: (_rg: string, name: string) =>
        makePoller(() => {
          const disk = disks.get(name);
          if (disk) {
            disk.deleted = true;
            disk.deleteGraceRemaining = 1; // disk delete needs ONE extra poll — exercises the cleanup self-transition.
          }
        }),
    };
    galleryImageVersions = {
      get: async (_rg: string, _gallery: string, _def: string, version: string) => {
        const v = galleryVersions.get(version);
        if (!v) throw notFoundError();
        return v;
      },
      createOrUpdate: (_rg: string, _gallery: string, _def: string, version: string) =>
        makePoller(() => {
          galleryVersions.set(version, { id: `/subscriptions/sub/resourceGroups/RG-AVD-Images/providers/Microsoft.Compute/galleries/ACG_AVD_CONTOSO/images/WIN11-ENT-MS-M365/versions/${version}`, provisioningState: 'Succeeded' });
        }),
      listByGalleryImage: () => ({
        [Symbol.asyncIterator]: async function* () {
          /* empty gallery — getCurrentImageVersion() resolves null, so any target version is allowed */
        },
      }),
    };
  },
}));

vi.mock('@azure/arm-network', () => ({
  NetworkManagementClient: class {
    networkInterfaces = {
      createOrUpdate: (_rg: string, name: string) => makePoller(() => nics.set(name, { name, provisioningState: 'Succeeded', deleteGraceRemaining: 0 })),
      get: async (_rg: string, name: string) => fakeGet(nics, name),
      delete: (_rg: string, name: string) =>
        makePoller(() => {
          const nic = nics.get(name);
          if (nic) {
            nic.deleted = true;
            nic.deleteGraceRemaining = 1; // NIC delete needs ONE extra poll — exercises the cleanup self-transition alongside the disk.
          }
        }),
    };
  },
}));

// ---------------------------------------------------------------------------
// Fake Table Storage — stateful, in-memory, REAL ETag semantics.
// ---------------------------------------------------------------------------
interface StoredEntity {
  partitionKey: string;
  rowKey: string;
  [key: string]: unknown;
}
const table = new Map<string, StoredEntity & { _etag: number }>();

function key(pk: string, rk: string): string {
  return `${pk}/${rk}`;
}

vi.mock('@azure/data-tables', async () => {
  const actual = await vi.importActual<typeof import('@azure/data-tables')>('@azure/data-tables');
  return {
    odata: actual.odata,
    TableClient: class {
      async getEntity(pk: string, rk: string) {
        const found = table.get(key(pk, rk));
        if (!found) throw notFoundError();
        return { ...found, etag: `W/"${found._etag}"` };
      }
      async createEntity(entity: StoredEntity) {
        const k = key(entity.partitionKey, entity.rowKey);
        if (table.has(k)) throw Object.assign(new Error('conflict'), { statusCode: 409 });
        table.set(k, { ...entity, _etag: 1 });
      }
      async updateEntity(entity: StoredEntity, _mode: string, options: { etag: string }) {
        const k = key(entity.partitionKey, entity.rowKey);
        const existing = table.get(k);
        if (!existing) throw notFoundError();
        if (`W/"${existing._etag}"` !== options.etag) throw Object.assign(new Error('precondition failed'), { statusCode: 412 });
        table.set(k, { ...entity, _etag: existing._etag + 1 });
      }
      listEntities(options?: { queryOptions?: { filter?: string } }) {
        const filter = options?.queryOptions?.filter ?? '';
        const excluded = new Set([...filter.matchAll(/state ne '([^']+)'/g)].map((m) => m[1]));
        const rows = [...table.values()].filter((e) => !excluded.has(e.state as string));
        return {
          [Symbol.asyncIterator]: async function* () {
            for (const row of rows) yield { ...row, etag: `W/"${row._etag}"` };
          },
        };
      }
    },
  };
});

vi.mock('../lib/auditLog', () => ({
  writeAuditEntry: async () => undefined,
  isAuditRequiredButMissing: () => false,
}));

// The rest of the stack — imageBuilds.ts, imageBuildTimer.ts,
// imageBuildOrchestrator.ts, imageBuildService.ts, imageBuildPlan.ts,
// imageBuildStateMachine.ts, imageBuildChecklist.ts — is REAL. Imported
// AFTER every vi.mock above.
const { imageBuildsStart, imageBuildsChecklist, imageBuildsAdvance } = await import('./imageBuilds');
const { imageBuildTimer } = await import('./imageBuildTimer');
const { getImageBuild } = await import('../services/imageBuildService');
const { IMAGE_BUILD_CHECKLIST } = await import('@avdmgr/shared');

function encodePrincipal(principal: unknown): string {
  return Buffer.from(JSON.stringify(principal), 'utf-8').toString('base64');
}
function adminHeader() {
  return encodePrincipal({ identityProvider: 'aad', userId: 'entra-admin-1', userDetails: 'admin@example.com', userRoles: ['admin'] });
}

function makeRequest(options: { body?: unknown; method?: string; params?: Record<string, string>; query?: Record<string, string> }): HttpRequest {
  const { body = {}, method = 'POST', params = {}, query = {} } = options;
  const queryMap = new Map(Object.entries(query));
  return {
    method,
    url: 'https://func-example.azurewebsites.net/api/v1/images/builds',
    headers: { get: (name: string) => (name.toLowerCase() === 'x-ms-client-principal' ? adminHeader() : null) },
    params,
    query: { get: (name: string) => queryMap.get(name) ?? null },
    json: async () => body,
  } as unknown as HttpRequest;
}

function makeContext(): InvocationContext {
  return { warn: () => {}, error: () => {}, log: () => {} } as unknown as InvocationContext;
}

const FAKE_TIMER = {} as Timer;
const MAX_TICKS = 30;

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  process.env.SUBSCRIPTION_ID = 'sub-id';
  process.env.RG_HOSTPOOLS = 'RG-AVD-HostPools';
  process.env.HOSTPOOL_NAME = 'HP-CONTOSO-PROD';
  process.env.AUDIT_STORAGE_ACCOUNT_NAME = 'stfuncavdmgr';
  process.env.IMAGE_BUILD_SUBNET_ID = '/subscriptions/sub/resourceGroups/RG-AVD-Network/providers/Microsoft.Network/virtualNetworks/VNET-CONTOSO-PROD/subnets/SNET-IMAGEBUILD';
  vms.clear();
  nics.clear();
  disks.clear();
  snapshots.clear();
  galleryVersions.clear();
  table.clear();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
});

describe('COMPOSITION — planned to done through the REAL orchestrator + REAL timer (Opus review BLOCKER 1)', () => {
  it('walks the whole build to done, surviving BOTH real self-transitions in capturing and the real self-transition in cleanup, within a bounded number of ticks', async () => {
    const startRes = await imageBuildsStart(makeRequest({ body: { version: '9.9.9', adminUsername: 'ca.builder' } }), makeContext());
    expect(startRes.status).toBe(201);
    const buildId = (startRes.jsonBody as { build: { buildId: string } }).build.buildId;

    let build = await getImageBuild(buildId);
    expect(build?.state).toBe('vm_creating');

    // Tick until vm_ready, then checklist_gate (both are timer-driven, no operator gate blocking them).
    for (let i = 0; i < MAX_TICKS && build?.state !== 'checklist_gate'; i++) {
      await imageBuildTimer(FAKE_TIMER, makeContext());
      build = await getImageBuild(buildId);
    }
    expect(build?.state).toBe('checklist_gate');

    // Operator ticks every checklist item, then advances (submits the pre-Sysprep snapshot).
    for (const item of IMAGE_BUILD_CHECKLIST) {
      const res = await imageBuildsChecklist(makeRequest({ method: 'PATCH', params: { buildId }, body: { itemId: item.id, checked: true } }), makeContext());
      expect(res.status).toBe(200);
    }
    const advanceRes = await imageBuildsAdvance(makeRequest({ params: { buildId } }), makeContext());
    expect(advanceRes.status).toBe(200);
    build = await getImageBuild(buildId);
    expect(build?.state).toBe('snapshotting');

    // Tick through snapshotting -> sysprep_running (two-phase: mark in_progress, THEN submit) -> awaiting_stopped.
    for (let i = 0; i < MAX_TICKS && build?.state !== 'awaiting_stopped'; i++) {
      await imageBuildTimer(FAKE_TIMER, makeContext());
      build = await getImageBuild(buildId);
    }
    expect(build?.state).toBe('awaiting_stopped');

    // Simulate Sysprep's own `/shutdown` actually stopping the guest — no real Windows VM exists in this fake, so the test pokes the fake store directly (the same thing a real Sysprep run would eventually cause).
    const vm = [...vms.values()].find((v) => v.name === build!.vmName)!;
    vm.powerState = 'stopped';

    // Tick through awaiting_stopped -> capturing (BOTH real self-transitions live here: after
    // generalize, and after submitting the gallery image version create) -> test_host_step.
    // THIS is the segment that never terminates pre-fix.
    for (let i = 0; i < MAX_TICKS && build?.state !== 'test_host_step'; i++) {
      await imageBuildTimer(FAKE_TIMER, makeContext());
      build = await getImageBuild(buildId);
    }
    expect(build?.state).toBe('test_host_step');
    expect(build?.capturedImageVersionId).toContain('9.9.9');
    expect(build?.baseImageExactVersion).toBe('26200.8875.260714');

    // Operator confirms the test host validated — submits the cleanup deletes.
    const advanceRes2 = await imageBuildsAdvance(makeRequest({ params: { buildId } }), makeContext());
    expect(advanceRes2.status).toBe(200);
    build = await getImageBuild(buildId);
    expect(build?.state).toBe('cleanup');

    // Tick through cleanup (the REAL self-transition: VM delete confirms on
    // the first poll, NIC/disk need one more — cleanup -> cleanup) -> done.
    for (let i = 0; i < MAX_TICKS && build?.state !== 'done'; i++) {
      await imageBuildTimer(FAKE_TIMER, makeContext());
      build = await getImageBuild(buildId);
    }
    expect(build?.state).toBe('done');
    expect(vms.has(build!.vmName)).toBe(false);
    expect(nics.has(build!.nicName)).toBe(false);
    expect(disks.has(build!.diskName)).toBe(false);
  });
});
