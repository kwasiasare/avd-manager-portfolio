import type { GovernanceCheckResult } from '@avdmgr/shared';
import { armGet } from '../../lib/armRest';
import { getConfig } from '../../lib/config';
import { buildResult } from './support';

/*
 * Check 1 (gap register — the estate's Key Vault posture, see
 * The estate inventory §6): KV-AVD-CONTOSO's purge
 * protection setting. The captured estate inventory already
 * captured this as `true` at inventory time — this check makes it a LIVE,
 * continuously-verified fact rather than a point-in-time document.
 *
 * API: Microsoft.KeyVault/vaults GET, api-version 2023-07-01 (current GA
 * version — verified against Microsoft Learn's Key Vault ARM template
 * reference). RBAC: plain Reader — Key Vault's `properties.
 * enablePurgeProtection` is a control-plane field on the vault's own GET
 * response, no data-plane (secrets/keys) access is needed. Reader on
 * RG-AVD-Security is a NEW grant this story adds (infra/main.bicep's
 * rbacSecurity module) — see infra/modules/rbac.bicep's header comment,
 * which used to read "RG-AVD-Security is deliberately excluded entirely
 * (nothing here reads it)" before this story.
 */

const API_VERSION = '2023-07-01';

interface ArmKeyVault {
  name?: string;
  properties?: {
    enablePurgeProtection?: boolean;
    enableSoftDelete?: boolean;
    softDeleteRetentionInDays?: number;
    publicNetworkAccess?: string;
  };
}

export function evaluateKeyVaultPurgeProtection(vaultName: string, vault: ArmKeyVault | undefined): GovernanceCheckResult {
  const base = { id: 'kv-purge-protection', title: 'Key Vault purge protection', category: 'Security' };

  if (!vault) {
    return buildResult({
      ...base,
      status: 'fail',
      summary: `Key Vault "${vaultName}" was not found.`,
      evidence: { vaultName },
    });
  }

  const enablePurgeProtection = vault.properties?.enablePurgeProtection ?? false;
  const enableSoftDelete = vault.properties?.enableSoftDelete ?? false;

  const evidence = {
    vaultName,
    enablePurgeProtection,
    enableSoftDelete,
    softDeleteRetentionInDays: vault.properties?.softDeleteRetentionInDays,
    publicNetworkAccess: vault.properties?.publicNetworkAccess,
  };

  if (enablePurgeProtection) {
    return buildResult({ ...base, status: 'pass', summary: `Purge protection is enabled on "${vaultName}".`, evidence });
  }

  // Purge protection requires soft delete — a vault with soft delete off
  // AND purge protection off is a materially worse state (a deletion is
  // both immediate AND unrecoverable) than soft-delete-only, so this is
  // called out distinctly in the summary even though both are 'fail'.
  return buildResult({
    ...base,
    status: 'fail',
    summary: enableSoftDelete
      ? `Purge protection is NOT enabled on "${vaultName}" — a deleted secret/key/certificate can be permanently purged before its soft-delete retention period expires.`
      : `Purge protection AND soft delete are both disabled on "${vaultName}" — a deletion here is immediate and unrecoverable.`,
    evidence,
  });
}

export async function fetchKeyVaultPurgeProtection(): Promise<GovernanceCheckResult> {
  const { subscriptionId, resourceGroups, governance } = getConfig();
  const vaultName = governance.keyVaultName;
  const vault = await armGet<ArmKeyVault>(`/subscriptions/${subscriptionId}/resourceGroups/${resourceGroups.security}/providers/Microsoft.KeyVault/vaults/${vaultName}`, API_VERSION);
  return evaluateKeyVaultPurgeProtection(vaultName, vault);
}
