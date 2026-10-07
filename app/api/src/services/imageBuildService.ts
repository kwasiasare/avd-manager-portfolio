import { TableClient, odata } from '@azure/data-tables';
import { DefaultAzureCredential } from '@azure/identity';
import type { ImageBuildChecklistState, ImageBuildDetail, ImageBuildState, ImageBuildStepState, ImageBuildSummary } from '@avdmgr/shared';
import { getConfig } from '../lib/config';
import { emptyChecklistState } from '../lib/imageBuildChecklist';

/**
 * AM-27 (M4-S2) — Table-backed persistence for the golden-image build state
 * machine. Same ETag-optimistic-concurrency / lazy-cached-client /
 * null-when-unconfigured shape as scalingOverrideService.ts (see that
 * file's header comment for the full reasoning this module reuses
 * verbatim) — the two differ only in that this one manages a GROWING
 * COLLECTION of rows (one per build, ever), not a single fixed-key row.
 *
 * TABLE DESIGN: fixed PartitionKey ('build'), RowKey = buildId (a UUID).
 * Unlike auditLog.ts's date-sharded partitioning (built for a HIGH-volume,
 * append-only log), builds are a genuinely rare event — a handful a year,
 * not per request — so a single partition with a full-partition scan +
 * in-memory sort for listImageBuilds is the right tradeoff: it stays
 * strongly consistent (a single partition supports entity-group
 * transactions and immediate read-your-writes) and avoids inventing a
 * reverse-chronological RowKey encoding for a collection this small.
 *
 * Lives on the SAME functions storage account as AuditLog/ScalingOverride
 * (config.audit.storageAccountName) — one more table, no new RBAC grant
 * (see infra/modules/functionapp.bicep's storageTableDataContributorAssignment,
 * already account-scoped).
 */
export interface ImageBuildEntity {
  partitionKey: string;
  rowKey: string;
  buildId: string;
  version: string;
  state: ImageBuildState;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  createdById: string;
  vmName: string;
  nicName: string;
  diskName: string;
  snapshotName: string;
  /** Serialized ImageBuildChecklistState — Table entities can't hold nested objects (same reason auditLog.ts's AuditEntity stores parametersJson as a string). */
  checklistJson: string;
  /** Serialized ImageBuildStepState[], in plan order. */
  stepsJson: string;
  /** Serialized { version, vmSize, adminUsername } — the FROZEN build parameters the timer/executor replay against on every tick, so a config change mid-build (e.g. a different default VM size) can never retroactively alter an in-flight build. NEVER includes a password — this app no longer accepts one from the caller at all; see app/api/src/lib/imageBuildSecrets.ts. */
  planParamsJson: string;
  /**
   * Serialized ImageBuildPlanContext (subscriptionId/resourceGroup/
   * location/galleryName/imageDefinitionName/subnetId/vmSize), FROZEN at
   * build-start time (Opus review MAJOR 9). Every later plan regeneration
   * (the checklist_gate->snapshotting advance, and the timer's
   * sysprep_running/capturing dispatch) parses THIS field — never calls
   * imageBuildOrchestrator.ts#resolvePlanContext() live — so a config
   * change mid-build (e.g. the build subnet or default VM size changing
   * for the NEXT build) can never retroactively alter an in-flight one,
   * and so the gallery image version's endOfLifeDate is always computed
   * from the build's own createdAt, not "whenever this tick happens to
   * run" (see imageBuildPlan.ts#computeEolDate's doc comment).
   */
  planContextJson: string;
  errorMessage?: string;
  cancelReason?: string;
  capturedImageVersionId?: string;
  /** The marketplace base image's resolved `exactVersion`, recorded once the build VM is readable — see @avdmgr/shared's ImageBuildDetail.baseImageExactVersion doc comment. */
  baseImageExactVersion?: string;
  /** See @avdmgr/shared's ImageBuildDetail.abandonedWarning doc comment — an audited, non-fatal staleness warning the timer sets while a build sits at checklist_gate past the configured threshold. */
  abandonedWarning?: string;
  /** Correlation id of the request that created this build, for cross-referencing audit rows. */
  correlationId: string;
  /** AM-53 — see @avdmgr/shared's ImageBuildDetail.snapshotDeleteSubmittedAt doc comment. Undefined until an operator submits DELETE .../builds/{buildId}/snapshot. */
  snapshotDeleteSubmittedAt?: string;
}

export interface ImageBuildRecord extends ImageBuildEntity {
  etag: string;
}

const PARTITION_KEY = 'build';
const NOT_CONFIGURED_MESSAGE = 'Image build table is not configured (IMAGE_BUILD_TABLE_NAME / AUDIT_STORAGE_ACCOUNT_NAME).';
/** Bounds a single listImageBuilds() call — builds are rare; this is far above any realistic count, purely a defensive cap. */
const LIST_LIMIT = 200;

let cachedClient: TableClient | undefined | null;

function getClient(): TableClient | null {
  if (cachedClient !== undefined) {
    return cachedClient;
  }
  const { audit, imageBuild } = getConfig();
  if (!audit.storageAccountName) {
    cachedClient = null;
    return cachedClient;
  }
  const url = `https://${audit.storageAccountName}.table.core.windows.net`;
  cachedClient = new TableClient(url, imageBuild.tableName, new DefaultAzureCredential());
  return cachedClient;
}

/** Test-only: mirrors tableStorage.ts's _resetTableClientCacheForTests so tests can swap config / re-mock between cases. */
export function _resetImageBuildClientCacheForTests(): void {
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

/**
 * Fail-closed check, same posture as scalingOverrideService.ts's
 * isOverrideStoreRequiredButMissing / auditLog.ts's
 * isAuditRequiredButMissing: a deployed environment that cannot durably
 * persist build state must refuse to START a build (which would otherwise
 * begin creating billable Azure resources with no durable record to resume
 * or clean them up from) rather than silently proceeding un-tracked.
 */
export function isImageBuildStoreRequiredButMissing(): boolean {
  const { audit } = getConfig();
  return !audit.storageAccountName && Boolean(process.env.WEBSITE_SITE_NAME);
}

export async function getImageBuild(buildId: string): Promise<ImageBuildRecord | null> {
  const client = getClient();
  if (!client) {
    return null;
  }
  try {
    return await client.getEntity<ImageBuildEntity>(PARTITION_KEY, buildId);
  } catch (error) {
    if (isNotFoundError(error)) {
      return null;
    }
    throw error;
  }
}

export async function createImageBuild(entity: Omit<ImageBuildEntity, 'partitionKey' | 'rowKey'>): Promise<void> {
  const client = getClient();
  if (!client) {
    throw new Error(NOT_CONFIGURED_MESSAGE);
  }
  await client.createEntity<ImageBuildEntity>({ partitionKey: PARTITION_KEY, rowKey: entity.buildId, ...entity });
}

/** Conditionally replaces the row via ETag optimistic concurrency — same isPreconditionFailedError (412) contract as scalingOverrideService.ts#replaceScalingOverride. Every caller (the operator-action handlers, the timer) owns its own read-decide-write-retry loop. */
export async function replaceImageBuild(entity: Omit<ImageBuildEntity, 'partitionKey' | 'rowKey'>, etag: string): Promise<void> {
  const client = getClient();
  if (!client) {
    throw new Error(NOT_CONFIGURED_MESSAGE);
  }
  await client.updateEntity<ImageBuildEntity>({ partitionKey: PARTITION_KEY, rowKey: entity.buildId, ...entity }, 'Replace', { etag });
}

/** Lists every build (up to LIST_LIMIT), newest-first by createdAt — see this module's header comment for why a full-partition scan + in-memory sort is the right tradeoff at this volume. Returns [] (never throws) when unconfigured, matching auditLog.ts#queryRecentAuditEntries's posture. */
export async function listImageBuilds(): Promise<ImageBuildRecord[]> {
  const client = getClient();
  if (!client) {
    return [];
  }
  const results: ImageBuildRecord[] = [];
  for await (const entity of client.listEntities<ImageBuildEntity>({ queryOptions: { filter: `PartitionKey eq '${PARTITION_KEY}'` } })) {
    results.push(entity);
    if (results.length >= LIST_LIMIT) {
      break;
    }
  }
  results.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  return results;
}

/**
 * Every build currently in a non-terminal state — what the 1-minute timer
 * iterates (app/api/src/functions/imageBuildTimer.ts). Filters SERVER-SIDE
 * via the Table query's own OData filter (Opus review MINOR 13f — the
 * original implementation fetched every build via listImageBuilds() and
 * filtered in JS, which works but does unnecessary work as build history
 * grows; a `state ne 'x'` filter on the query itself is both cheaper and
 * more directly expresses "in-flight" as a server-side predicate). Newest
 * first, same odata-tagged-template escaping convention as
 * auditLog.ts#queryRecentAuditEntries (state is never user input today, but
 * this avoids the hand-rolled string-concatenation footgun regardless).
 */
export async function listInFlightImageBuilds(): Promise<ImageBuildRecord[]> {
  const client = getClient();
  if (!client) {
    return [];
  }
  const results: ImageBuildRecord[] = [];
  const filter = odata`PartitionKey eq ${PARTITION_KEY} and state ne 'done' and state ne 'failed' and state ne 'cancelled'`;
  for await (const entity of client.listEntities<ImageBuildEntity>({ queryOptions: { filter } })) {
    results.push(entity);
    if (results.length >= LIST_LIMIT) {
      break;
    }
  }
  results.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  return results;
}

/** Safe JSON.parse with a typed fallback — a corrupt/missing checklistJson (shouldn't happen; defensive only) degrades to "nothing ticked" rather than throwing and taking the whole build detail read down with it. */
function parseChecklistJson(json: string | undefined): ImageBuildChecklistState {
  if (!json) {
    return emptyChecklistState();
  }
  try {
    return JSON.parse(json) as ImageBuildChecklistState;
  } catch {
    return emptyChecklistState();
  }
}

function parseStepsJson(json: string | undefined): ImageBuildStepState[] {
  if (!json) {
    return [];
  }
  try {
    return JSON.parse(json) as ImageBuildStepState[];
  } catch {
    return [];
  }
}

/** Pure projection from the stored entity to the wire-shape summary — split out so it's unit-testable without a Table client. */
export function toSummary(entity: ImageBuildEntity): ImageBuildSummary {
  return {
    buildId: entity.buildId,
    version: entity.version,
    state: entity.state,
    createdAt: entity.createdAt,
    updatedAt: entity.updatedAt,
    createdBy: entity.createdBy,
  };
}

/** Pure projection from the stored entity to the full wire-shape detail. */
export function toDetail(entity: ImageBuildEntity): ImageBuildDetail {
  return {
    ...toSummary(entity),
    vmName: entity.vmName,
    nicName: entity.nicName,
    diskName: entity.diskName,
    snapshotName: entity.snapshotName,
    checklist: parseChecklistJson(entity.checklistJson),
    steps: parseStepsJson(entity.stepsJson),
    errorMessage: entity.errorMessage,
    cancelReason: entity.cancelReason,
    capturedImageVersionId: entity.capturedImageVersionId,
    baseImageExactVersion: entity.baseImageExactVersion,
    abandonedWarning: entity.abandonedWarning,
    snapshotDeleteSubmittedAt: entity.snapshotDeleteSubmittedAt,
  };
}
