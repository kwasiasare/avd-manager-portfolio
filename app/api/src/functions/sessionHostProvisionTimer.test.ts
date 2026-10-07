import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InvocationContext, Timer } from '@azure/functions';
import type { SessionHostProvisionEntity } from '../services/sessionHostProvisionService';

const listInFlightSessionHostProvisions = vi.fn();
const getSessionHostProvision = vi.fn();
const replaceSessionHostProvision = vi.fn();
vi.mock('../services/sessionHostProvisionService', async () => {
  const actual = await vi.importActual<typeof import('../services/sessionHostProvisionService')>('../services/sessionHostProvisionService');
  return {
    ...actual,
    listInFlightSessionHostProvisions: (...args: unknown[]) => listInFlightSessionHostProvisions(...args),
    getSessionHostProvision: (...args: unknown[]) => getSessionHostProvision(...args),
    replaceSessionHostProvision: (...args: unknown[]) => replaceSessionHostProvision(...args),
  };
});

const reconcilePlanned = vi.fn();
const pollNicCreating = vi.fn();
const pollVmCreating = vi.fn();
const pollEntraJoinExtension = vi.fn();
const pollGuestAttestationExtension = vi.fn();
const pollDscExtension = vi.fn();
const pollAwaitingRegistration = vi.fn();
vi.mock('../services/sessionHostProvisionOrchestrator', () => ({
  reconcilePlanned: (...args: unknown[]) => reconcilePlanned(...args),
  pollNicCreating: (...args: unknown[]) => pollNicCreating(...args),
  pollVmCreating: (...args: unknown[]) => pollVmCreating(...args),
  pollEntraJoinExtension: (...args: unknown[]) => pollEntraJoinExtension(...args),
  pollGuestAttestationExtension: (...args: unknown[]) => pollGuestAttestationExtension(...args),
  pollDscExtension: (...args: unknown[]) => pollDscExtension(...args),
  pollAwaitingRegistration: (...args: unknown[]) => pollAwaitingRegistration(...args),
  regeneratePlanFromFrozenBasis: vi.fn().mockReturnValue({ sessionHostName: 'avd-con-4', steps: [] }),
}));

const writeAuditEntry = vi.fn().mockResolvedValue(undefined);
vi.mock('../lib/auditLog', () => ({ writeAuditEntry: (...args: unknown[]) => writeAuditEntry(...args) }));

const { sessionHostProvisionTimer } = await import('./sessionHostProvisionTimer');

function makeContext(): InvocationContext & { errors: unknown[]; logs: string[] } {
  const errors: unknown[] = [];
  const logs: string[] = [];
  return { warn: () => {}, error: (...a: unknown[]) => errors.push(a), log: (...a: unknown[]) => logs.push(a.join(' ')), errors, logs } as unknown as InvocationContext & { errors: unknown[]; logs: string[] };
}
const FAKE_TIMER = {} as Timer;

function entity(overrides: Partial<SessionHostProvisionEntity> = {}): SessionHostProvisionEntity & { etag: string } {
  return {
    partitionKey: 'provision',
    rowKey: 'provision-1',
    provisionId: 'provision-1',
    hostPoolName: 'HP-CONTOSO-PROD',
    sessionHostName: 'avd-con-4',
    zone: '2',
    vmSize: 'Standard_D4ads_v7',
    imageVersion: '2.2.0',
    state: 'vm_creating',
    createdAt: '2026-08-23T00:00:00.000Z',
    updatedAt: '2026-08-23T00:00:00.000Z',
    createdBy: 'admin@example.com',
    createdById: 'entra-obj-1',
    vmName: 'avd-con-4',
    nicName: 'NIC-avd-con-4',
    stepsJson: '[]',
    planParamsJson: '{"sessionHostName":"avd-con-4","zone":"2","imageVersion":"2.2.0"}',
    planContextJson: '{}',
    correlationId: 'corr-1',
    etag: 'W/"etag-1"',
    ...overrides,
  };
}

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  process.env.SUBSCRIPTION_ID = 'sub-id';
  process.env.RG_HOSTPOOLS = 'RG-AVD-HostPools';
  process.env.HOSTPOOL_NAME = 'HP-CONTOSO-PROD';
  listInFlightSessionHostProvisions.mockReset().mockResolvedValue([]);
  getSessionHostProvision.mockReset();
  replaceSessionHostProvision.mockReset().mockResolvedValue(undefined);
  for (const fn of [reconcilePlanned, pollNicCreating, pollVmCreating, pollEntraJoinExtension, pollGuestAttestationExtension, pollDscExtension, pollAwaitingRegistration]) fn.mockReset();
  writeAuditEntry.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
});

describe('sessionHostProvisionTimer — dispatch by state', () => {
  it('does nothing when there are no in-flight provisions', async () => {
    const context = makeContext();
    await sessionHostProvisionTimer(FAKE_TIMER, context);
    expect(replaceSessionHostProvision).not.toHaveBeenCalled();
  });

  it('dispatches vm_creating to pollVmCreating, persists the returned state, and audits with provisionId/from/to', async () => {
    const row = entity({ state: 'vm_creating' });
    listInFlightSessionHostProvisions.mockResolvedValue([row]);
    getSessionHostProvision.mockResolvedValue(row);
    pollVmCreating.mockResolvedValue({ nextState: 'ext_entra_join', steps: [] });

    const context = makeContext();
    await sessionHostProvisionTimer(FAKE_TIMER, context);

    expect(pollVmCreating).toHaveBeenCalledWith(row);
    expect(replaceSessionHostProvision).toHaveBeenCalledWith(expect.objectContaining({ provisionId: 'provision-1', state: 'ext_entra_join' }), 'W/"etag-1"');
    expect(writeAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'sessionhost.provision.timer_advance',
        target: 'provision-1',
        parameters: { provisionId: 'provision-1', sessionHostName: 'avd-con-4', from: 'vm_creating', to: 'ext_entra_join' },
        outcome: 'success',
      }),
      expect.anything(),
    );
  });

  it('EXTENSION ORDER: dispatches ext_entra_join to pollEntraJoinExtension, ext_guest_attestation to pollGuestAttestationExtension, and ext_dsc to pollDscExtension — never crossing wires', async () => {
    pollEntraJoinExtension.mockResolvedValue(null);
    pollGuestAttestationExtension.mockResolvedValue(null);
    pollDscExtension.mockResolvedValue(null);

    for (const [state, expectedFn, otherFns] of [
      ['ext_entra_join', pollEntraJoinExtension, [pollGuestAttestationExtension, pollDscExtension]],
      ['ext_guest_attestation', pollGuestAttestationExtension, [pollEntraJoinExtension, pollDscExtension]],
      ['ext_dsc', pollDscExtension, [pollEntraJoinExtension, pollGuestAttestationExtension]],
    ] as const) {
      listInFlightSessionHostProvisions.mockResolvedValue([entity({ state })]);
      const context = makeContext();
      await sessionHostProvisionTimer(FAKE_TIMER, context);
      expect(expectedFn).toHaveBeenCalledTimes(1);
      for (const other of otherFns) {
        expect(other).not.toHaveBeenCalled();
      }
      expectedFn.mockClear();
    }
  });

  it('ext_dsc dispatch threads the logger through (for the DSC step\'s registration-token audit) — the other two extension pollers do not need it', async () => {
    listInFlightSessionHostProvisions.mockResolvedValue([entity({ state: 'ext_dsc' })]);
    pollDscExtension.mockResolvedValue(null);
    const context = makeContext();
    await sessionHostProvisionTimer(FAKE_TIMER, context);
    expect(pollDscExtension).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.any(Date), expect.objectContaining({ warn: expect.any(Function), error: expect.any(Function), log: expect.any(Function) }));
  });

  it('awaiting_registration -> done: persists and audits a success outcome', async () => {
    const row = entity({ state: 'awaiting_registration' });
    listInFlightSessionHostProvisions.mockResolvedValue([row]);
    getSessionHostProvision.mockResolvedValue(row);
    pollAwaitingRegistration.mockResolvedValue({ nextState: 'done', steps: [] });

    const context = makeContext();
    await sessionHostProvisionTimer(FAKE_TIMER, context);

    expect(replaceSessionHostProvision).toHaveBeenCalledWith(expect.objectContaining({ state: 'done' }), 'W/"etag-1"');
    expect(writeAuditEntry).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'success' }), expect.anything());
  });

  it('a poll-attempt-ceiling failure persists state failed and audits a failure outcome', async () => {
    const row = entity({ state: 'awaiting_registration' });
    listInFlightSessionHostProvisions.mockResolvedValue([row]);
    getSessionHostProvision.mockResolvedValue(row);
    pollAwaitingRegistration.mockResolvedValue({ nextState: 'failed', steps: [], errorMessage: 'never appeared registered' });

    const context = makeContext();
    await sessionHostProvisionTimer(FAKE_TIMER, context);

    expect(replaceSessionHostProvision).toHaveBeenCalledWith(expect.objectContaining({ state: 'failed', errorMessage: 'never appeared registered' }), 'W/"etag-1"');
    expect(writeAuditEntry).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failure', detail: 'never appeared registered' }), expect.anything());
  });

  it('a null result (still waiting on Azure) persists nothing and audits nothing', async () => {
    const row = entity({ state: 'ext_entra_join' });
    listInFlightSessionHostProvisions.mockResolvedValue([row]);
    pollEntraJoinExtension.mockResolvedValue(null);

    const context = makeContext();
    await sessionHostProvisionTimer(FAKE_TIMER, context);

    expect(replaceSessionHostProvision).not.toHaveBeenCalled();
    expect(writeAuditEntry).not.toHaveBeenCalled();
  });

  it('a self-transition (same state, e.g. an attempt bump) is persisted WITHOUT going through assertTransition\'s illegal-edge check', async () => {
    const row = entity({ state: 'vm_creating' });
    listInFlightSessionHostProvisions.mockResolvedValue([row]);
    getSessionHostProvision.mockResolvedValue(row);
    pollVmCreating.mockResolvedValue({ nextState: 'vm_creating', steps: [{ stepId: 'create_vm', status: 'in_progress', attempts: 3 }] });

    const context = makeContext();
    await sessionHostProvisionTimer(FAKE_TIMER, context);

    expect(replaceSessionHostProvision).toHaveBeenCalledWith(expect.objectContaining({ state: 'vm_creating' }), 'W/"etag-1"');
    expect(context.errors).toEqual([]);
  });

  it('skips a tick where the fresh read shows the row already changed state (an operator action raced the timer)', async () => {
    const row = entity({ state: 'vm_creating' });
    listInFlightSessionHostProvisions.mockResolvedValue([row]);
    getSessionHostProvision.mockResolvedValue(entity({ state: 'cancelled' }));
    pollVmCreating.mockResolvedValue({ nextState: 'ext_entra_join', steps: [] });

    const context = makeContext();
    await sessionHostProvisionTimer(FAKE_TIMER, context);

    expect(replaceSessionHostProvision).not.toHaveBeenCalled();
  });

  it('a 412 (ETag conflict) is silently retried next tick — no SESSION_HOST_PROVISION_STUCK marker, no failure audit', async () => {
    const row = entity({ state: 'vm_creating' });
    listInFlightSessionHostProvisions.mockResolvedValue([row]);
    getSessionHostProvision.mockResolvedValue(row);
    pollVmCreating.mockResolvedValue({ nextState: 'ext_entra_join', steps: [] });
    replaceSessionHostProvision.mockRejectedValue(Object.assign(new Error('precondition failed'), { statusCode: 412 }));

    const context = makeContext();
    await sessionHostProvisionTimer(FAKE_TIMER, context);

    expect(context.errors).toEqual([]);
    expect(writeAuditEntry).not.toHaveBeenCalled();
  });

  it('an unexpected error emits the greppable SESSION_HOST_PROVISION_STUCK marker and a failure-outcome audit row', async () => {
    const row = entity({ state: 'vm_creating' });
    listInFlightSessionHostProvisions.mockResolvedValue([row]);
    pollVmCreating.mockRejectedValue(new Error('unexpected ARM 500'));

    const context = makeContext();
    await sessionHostProvisionTimer(FAKE_TIMER, context);

    expect(context.errors.some((call) => String((call as unknown[])[0]).includes('SESSION_HOST_PROVISION_STUCK'))).toBe(true);
    expect(writeAuditEntry).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failure', action: 'sessionhost.provision.timer_advance' }), expect.anything());
  });
});
