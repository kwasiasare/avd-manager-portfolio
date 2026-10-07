import { DefaultAzureCredential } from '@azure/identity';
import { StorageManagementClient } from '@azure/arm-storage';
import type { FslogixShareUsage } from '@avdmgr/shared';
import { getConfig } from '../lib/config';

/*
 * Management-plane FileShares.get(expand: 'stats') over a data-plane
 * FileREST call — verified against Microsoft's "File Shares - Get" REST
 * reference: `$expand=stats` returns `shareUsageBytes` alongside the
 * existing `shareQuota` (provisioned GiB), and the operation only needs
 * Microsoft.Storage/storageAccounts/fileServices/shares/read — a plain
 * control-plane Reader action, already covered by the built-in Reader role
 * this app grants elsewhere (infra/modules/rbac.bicep). No data-plane
 * "Storage File Data..." role, and no SMB/network path to the share, is
 * needed just to read usage stats.
 */

let cachedClient: StorageManagementClient | undefined;

/**
 * Exported (peer review item 19 — AM-16) so
 * services/governance/fslogixPublicNetworkAccess.ts can reuse this SAME
 * cached StorageManagementClient for its
 * storageAccounts.getProperties(stcontoso001) call, rather than
 * constructing a second, independently-cached client for the exact same
 * SDK/credential/subscription — one client instance per process, same
 * "don't duplicate what's already cached" principle this app already
 * applies to costService.ts/avdService.ts's own module-level client
 * caches.
 */
export function getStorageManagementClient(): StorageManagementClient {
  if (!cachedClient) {
    const { subscriptionId } = getConfig();
    const credential = new DefaultAzureCredential();
    cachedClient = new StorageManagementClient(credential, subscriptionId);
  }
  return cachedClient;
}

const BYTES_PER_GIB = 1024 ** 3;

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Fetches provisioned-vs-used stats for the configured FSLogix profile
 * share (stcontoso001/fslogixprofiles). Returns usedBytes: 0 / percentUsed:
 * 0 (rather than throwing) if the API's `shareUsageBytes` field is absent —
 * that field is populated best-effort by the service ("this value might not
 * include all recently created or recently resized files" per Microsoft's
 * docs) and an FSLogix share this app doesn't otherwise mutate should never
 * 502 the whole Cost & Scaling page over a stats field being momentarily
 * unpopulated.
 */
export async function getFslogixShareUsage(): Promise<FslogixShareUsage> {
  const client = getStorageManagementClient();
  const { resourceGroups, storage } = getConfig();

  const share = await client.fileShares.get(resourceGroups.storage, storage.accountName, storage.fslogixShareName, { expand: 'stats' });

  const provisionedGib = share.shareQuota ?? 0;
  const usedBytes = share.shareUsageBytes ?? 0;
  const usedGib = round2(usedBytes / BYTES_PER_GIB);
  const percentUsed = provisionedGib > 0 ? Math.min(100, round2((usedGib / provisionedGib) * 100)) : 0;

  return {
    storageAccountName: storage.accountName,
    shareName: storage.fslogixShareName,
    provisionedGib,
    usedBytes,
    usedGib,
    percentUsed,
  };
}
