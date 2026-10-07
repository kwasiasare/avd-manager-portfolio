import { DefaultAzureCredential } from '@azure/identity';
import { TableClient } from '@azure/data-tables';
import { getConfig } from './config';

/**
 * Generic TableClient factory, currently used only by AlertState
 * (app/api/src/lib/alertState.ts). AuditLog (app/api/src/lib/auditLog.ts)
 * predates this file (M2 foundation) and talks to @azure/data-tables
 * directly rather than through it — not migrated here, to avoid touching a
 * table whose fail-closed-in-prod semantics (isAuditRequiredButMissing) are
 * deliberately different from AlertState's (a missing/unreachable
 * AlertState table should surface as a normal request failure — there's no
 * "the real state changed but we failed to log it" split the way there is
 * for audit rows).
 *
 * Points at the SAME storage account as the audit table
 * (config.audit.storageAccountName / AUDIT_STORAGE_ACCOUNT_NAME — the
 * FUNCTIONS storage account Flex Consumption already provisions for
 * AzureWebJobsStorage, see infra/modules/functionapp.bicep's
 * `storageAccount` resource) rather than a second env setting, so this
 * matches auditLog.ts's config/credential pattern exactly: same env
 * setting, same DefaultAzureCredential auth, same account — only the table
 * name differs (config.alertState.tableName / ALERT_STATE_TABLE_NAME).
 *
 * Auth: DefaultAzureCredential (the Function App's system-assigned managed
 * identity in deployed environments, `az login` locally — same pattern as
 * app/api/src/services/alertsService.ts and avdService.ts), never an
 * account key — `allowSharedKeyAccess: false` on the storage account
 * (functionapp.bicep) rules that out anyway.
 *
 * Cached per table name (module-level Map, mirroring alertsService.ts's
 * single cachedClient) — TableClient instances are cheap to reuse and this
 * avoids re-resolving DefaultAzureCredential on every request.
 */
const cachedClients = new Map<string, TableClient>();

export function getTableClient(tableName: string): TableClient {
  const cached = cachedClients.get(tableName);
  if (cached) {
    return cached;
  }

  const { audit } = getConfig();
  if (!audit.storageAccountName) {
    throw new Error(
      'AUDIT_STORAGE_ACCOUNT_NAME is not configured — cannot construct a Table storage endpoint. ' +
        'Set it to the Function App storage account name (see infra/modules/functionapp.bicep).',
    );
  }

  const credential = new DefaultAzureCredential();
  const client = new TableClient(`https://${audit.storageAccountName}.table.core.windows.net`, tableName, credential);
  cachedClients.set(tableName, client);
  return client;
}

/** Test-only: clears the client cache so tests can swap AUDIT_STORAGE_ACCOUNT_NAME / re-mock between cases. */
export function _resetTableClientCacheForTests(): void {
  cachedClients.clear();
}
