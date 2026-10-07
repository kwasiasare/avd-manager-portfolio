import type { StorageAccount } from '@azure/arm-storage';
import type { GovernanceCheckResult } from '@avdmgr/shared';
import { getConfig } from '../../lib/config';
import { getStorageManagementClient } from '../fslogixService';
import { buildResult } from './support';

/*
 * Check 2 (gap register — see estate-inventory.md §5): the FSLogix profile
 * share's storage account (stcontoso001) publicNetworkAccess setting.
 * Captured `Disabled` at inventory time — this makes it a live check, same
 * "point-in-time capture -> continuously verified fact" upgrade as check 1.
 *
 * Reuses services/fslogixService.ts's EXPORTED, already-cached
 * StorageManagementClient (peer review item 19) rather than constructing a
 * second independently-cached client for the exact same SDK/credential/
 * subscription — see that file's getStorageManagementClient doc comment.
 * fslogixService.ts already established that storageAccounts.getProperties
 * needs only Microsoft.Storage/storageAccounts/read (a plain Reader
 * action), and this app already holds a RESOURCE-scoped Reader grant on
 * stcontoso001 specifically (infra/main.bicep's
 * rbacFslogixStorageAccountReader module — AM-25 peer review item 13) — no
 * new RBAC needed for this check.
 */

export function evaluateFslogixPublicNetworkAccess(accountName: string, account: StorageAccount | undefined): GovernanceCheckResult {
  const base = { id: 'fslogix-public-network-access', title: 'FSLogix storage account public network access', category: 'Security' };

  if (!account) {
    return buildResult({ ...base, status: 'fail', summary: `Storage account "${accountName}" was not found.`, evidence: { accountName } });
  }

  const publicNetworkAccess = account.publicNetworkAccess ?? 'Unknown';
  const evidence = {
    accountName,
    publicNetworkAccess,
    allowSharedKeyAccess: account.allowSharedKeyAccess,
    networkRuleSetDefaultAction: account.networkRuleSet?.defaultAction,
  };

  if (publicNetworkAccess === 'Disabled') {
    return buildResult({ ...base, status: 'pass', summary: `Public network access is Disabled on "${accountName}".`, evidence });
  }
  if (publicNetworkAccess === 'Enabled') {
    return buildResult({
      ...base,
      status: 'fail',
      summary: `Public network access is Enabled on "${accountName}" — the FSLogix profile share is reachable over the public internet path in addition to its private endpoint.`,
      evidence,
    });
  }
  return buildResult({ ...base, status: 'warn', summary: `Public network access on "${accountName}" is neither Enabled nor Disabled ("${publicNetworkAccess}") — could not determine posture.`, evidence });
}

export async function fetchFslogixPublicNetworkAccess(): Promise<GovernanceCheckResult> {
  const { resourceGroups, storage } = getConfig();
  const client = getStorageManagementClient();
  let account: StorageAccount | undefined;
  try {
    account = await client.storageAccounts.getProperties(resourceGroups.storage, storage.accountName);
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'statusCode' in error && (error as { statusCode?: number }).statusCode === 404) {
      account = undefined;
    } else {
      throw error;
    }
  }
  return evaluateFslogixPublicNetworkAccess(storage.accountName, account);
}
