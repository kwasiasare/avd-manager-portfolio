import { TableClient, odata } from '@azure/data-tables';
import { DefaultAzureCredential } from '@azure/identity';
import type { SessionHostProvisionDetail, SessionHostProvisionState, SessionHostProvisionStepState, SessionHostProvisionSummary } from '@avdmgr/shared';
import { getConfig } from '../lib/config';

/**
 * AM-50 — Table-backed persistence for the session-host provisioning state
 * machine. Mirrors app/api/src/services/imageBuildService.ts's shape
 * exactly (ETag-optimistic-concurrency, lazy-cached-client, null-when-
 * unconfigured, single-partition-plus-in-memory-sort) — see that file's
 * header comment for the full reasoning, which applies unchanged here:
 * session-host provisions are a rare, operator-initiated event (not a
 * per-request volume), so a single partition is the right tradeoff.
 *
 * TABLE DESIGN: fixed PartitionKey ('provision'), RowKey = provisionId (a
 * UUID). Lives on the SAME functions storage account as AuditLog/
 * ImageBuild/RolloutPlan (config.audit.storageAccountName) — one more
 * table, no new RBAC grant (storageTableDataContributorAssignment is
 * already account-scoped — see infra/modules/functionapp.bicep).
 */
export interface SessionHostProvisionEntity {
  partitionKey: string;
  rowKey: string;
  provisionId: string;
  hostPoolName: string;
  sessionHostName: string;
  zone: string;
  vmSize: string;
  imageVersion: string;
  state: SessionHostProvisionState;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  createdById: string;
  vmName: string;
  nicName: string;
  /** Serialized SessionHostProvisionStepState[], in plan order. */
  stepsJson: string;
  /** Serialized SessionHostProvisionParams — the FROZEN caller-supplied params the timer/executor replay against on every tick (mirrors ImageBuildEntity.planParamsJson). */
  planParamsJson: string;
  /**
   * Serialized SessionHostProvisionPlanContext, FROZEN at provision-start
   * time — mirrors ImageBuildEntity.planContextJson exactly: every later
   * plan regeneration (every timer tick from nic_creating onward) parses
   * THIS field, never calls the orchestrator's live resolvePlanContext(),
   * so a config change mid-provision (e.g. The session-host subnet or
   * default VM size changing for the NEXT provision) can never
   * retroactively alter an in-flight one.
   */
  planContextJson: string;
  errorMessage?: string;
  cancelReason?: string;
  cleanupGuidance?: string;
  /** Correlation id of the request that created this provision, for cross-referencing audit rows. */
  correlationId: string;
}

export interface SessionHostProvisionRecord extends SessionHostProvisionEntity {
  etag: string;
}

const PARTITION_KEY = 'provision';
const NOT_CONFIGURED_MESSAGE = 'Session host provision table is not configured (SESSION_HOST_PROVISION_TABLE_NAME / AUDIT_STORAGE_ACCOUNT_NAME).';
/** Bounds a single listSessionHostProvisions() call — provisions are rare; this is far above any realistic count, purely a defensive cap (same magnitude as imageBuildService.ts's LIST_LIMIT). */
const LIST_LIMIT = 200;

let cachedClient: TableClient | undefined | null;

function getClient(): TableClient | null {
  if (cachedClient !== undefined) {
    return cachedClient;
  }
  const { audit, sessionHostProvision } = getConfig();
  if (!audit.storageAccountName) {
    cachedClient = null;
    return cachedClient;
  }
  const url = `https://${audit.storageAccountName}.table.core.windows.net`;
  cachedClient = new TableClient(url, sessionHostProvision.tableName, new DefaultAzureCredential());
  return cachedClient;
}

/** Test-only: mirrors imageBuildService.ts's _resetImageBuildClientCacheForTests so tests can swap config / re-mock between cases. */
export function _resetSessionHostProvisionClientCacheForTests(): void {
  cachedClient = undefined;
}

function hasStatusCode(error: unknown, statusCode: number): boolean {
  return typeof error === 'object' && error !== null && 'statusCode' in error && (error as { statusCode?: number }).statusCode === statusCode;
}

export function isNotFoundError(error: unknown): boolean {
  return hasStatusCode(error, 404);
}

export function isConflictError(error: unknown): boolean {
  return hasStatusCode(error, 409);
}

export function isPreconditionFailedError(error: unknown): boolean {
  return hasStatusCode(error, 412);
}

/** Fail-closed check — same posture as imageBuildService.ts#isImageBuildStoreRequiredButMissing: a deployed environment that cannot durably persist provision state must refuse to START one (which would otherwise begin creating billable Azure resources with no durable record to resume or clean them up from). */
export function isProvisionStoreRequiredButMissing(): boolean {
  const { audit } = getConfig();
  return !audit.storageAccountName && Boolean(process.env.WEBSITE_SITE_NAME);
}

export async function getSessionHostProvision(provisionId: string): Promise<SessionHostProvisionRecord | null> {
  const client = getClient();
  if (!client) {
    return null;
  }
  try {
    return await client.getEntity<SessionHostProvisionEntity>(PARTITION_KEY, provisionId);
  } catch (error) {
    if (isNotFoundError(error)) {
      return null;
    }
    throw error;
  }
}

export async function createSessionHostProvision(entity: Omit<SessionHostProvisionEntity, 'partitionKey' | 'rowKey'>): Promise<void> {
  const client = getClient();
  if (!client) {
    throw new Error(NOT_CONFIGURED_MESSAGE);
  }
  await client.createEntity<SessionHostProvisionEntity>({ partitionKey: PARTITION_KEY, rowKey: entity.provisionId, ...entity });
}

/** Conditionally replaces the row via ETag optimistic concurrency — same isPreconditionFailedError (412) contract as imageBuildService.ts#replaceImageBuild. Every caller (the handlers, the timer) owns its own read-decide-write-retry loop. */
export async function replaceSessionHostProvision(entity: Omit<SessionHostProvisionEntity, 'partitionKey' | 'rowKey'>, etag: string): Promise<void> {
  const client = getClient();
  if (!client) {
    throw new Error(NOT_CONFIGURED_MESSAGE);
  }
  await client.updateEntity<SessionHostProvisionEntity>({ partitionKey: PARTITION_KEY, rowKey: entity.provisionId, ...entity }, 'Replace', { etag });
}

/** Lists every provision (up to LIST_LIMIT) for a host pool, newest-first by createdAt. Returns [] (never throws) when unconfigured, matching imageBuildService.ts#listImageBuilds's posture. */
export async function listSessionHostProvisions(hostPoolName: string): Promise<SessionHostProvisionRecord[]> {
  const client = getClient();
  if (!client) {
    return [];
  }
  const results: SessionHostProvisionRecord[] = [];
  const filter = odata`PartitionKey eq ${PARTITION_KEY} and hostPoolName eq ${hostPoolName}`;
  for await (const entity of client.listEntities<SessionHostProvisionEntity>({ queryOptions: { filter } })) {
    results.push(entity);
    if (results.length >= LIST_LIMIT) {
      break;
    }
  }
  results.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  return results;
}

/**
 * Every provision currently in a non-terminal state — what the 1-minute
 * timer iterates (app/api/src/functions/sessionHostProvisionTimer.ts).
 * Filters SERVER-SIDE via the Table query's own OData filter, same
 * rationale/convention as imageBuildService.ts#listInFlightImageBuilds.
 */
export async function listInFlightSessionHostProvisions(): Promise<SessionHostProvisionRecord[]> {
  const client = getClient();
  if (!client) {
    return [];
  }
  const results: SessionHostProvisionRecord[] = [];
  const filter = odata`PartitionKey eq ${PARTITION_KEY} and state ne 'done' and state ne 'failed' and state ne 'cancelled'`;
  for await (const entity of client.listEntities<SessionHostProvisionEntity>({ queryOptions: { filter } })) {
    results.push(entity);
    if (results.length >= LIST_LIMIT) {
      break;
    }
  }
  results.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  return results;
}

/**
 * Every provision currently in a non-terminal state for a GIVEN session
 * host name — the API's one-in-flight-PER-NAME 409 check (see
 * sessionHostProvisions.ts's start handler). Deliberately scoped to
 * `sessionHostName`, not global: unlike the golden-image build (a
 * single-build-at-a-time workflow), several session hosts can legitimately
 * be provisioned concurrently.
 */
export async function listInFlightSessionHostProvisionsForName(hostPoolName: string, sessionHostName: string): Promise<SessionHostProvisionRecord[]> {
  const client = getClient();
  if (!client) {
    return [];
  }
  const results: SessionHostProvisionRecord[] = [];
  const filter = odata`PartitionKey eq ${PARTITION_KEY} and hostPoolName eq ${hostPoolName} and sessionHostName eq ${sessionHostName} and state ne 'done' and state ne 'failed' and state ne 'cancelled'`;
  for await (const entity of client.listEntities<SessionHostProvisionEntity>({ queryOptions: { filter } })) {
    results.push(entity);
  }
  return results;
}

function parseStepsJson(json: string | undefined): SessionHostProvisionStepState[] {
  if (!json) {
    return [];
  }
  try {
    return JSON.parse(json) as SessionHostProvisionStepState[];
  } catch {
    return [];
  }
}

/** Pure projection from the stored entity to the wire-shape summary — split out so it's unit-testable without a Table client (mirrors imageBuildService.ts#toSummary). */
export function toSummary(entity: SessionHostProvisionEntity): SessionHostProvisionSummary {
  return {
    provisionId: entity.provisionId,
    hostPoolName: entity.hostPoolName,
    sessionHostName: entity.sessionHostName,
    zone: entity.zone,
    vmSize: entity.vmSize,
    imageVersion: entity.imageVersion,
    state: entity.state,
    createdAt: entity.createdAt,
    updatedAt: entity.updatedAt,
    createdBy: entity.createdBy,
  };
}

/** Pure projection from the stored entity to the full wire-shape detail. */
export function toDetail(entity: SessionHostProvisionEntity): SessionHostProvisionDetail {
  return {
    ...toSummary(entity),
    vmName: entity.vmName,
    nicName: entity.nicName,
    steps: parseStepsJson(entity.stepsJson),
    errorMessage: entity.errorMessage,
    cancelReason: entity.cancelReason,
    cleanupGuidance: entity.cleanupGuidance,
  };
}
