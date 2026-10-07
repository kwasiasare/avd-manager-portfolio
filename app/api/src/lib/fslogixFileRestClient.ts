import { DefaultAzureCredential } from '@azure/identity';
import { ShareServiceClient } from '@azure/storage-file-share';
import { getConfig } from './config';

/*
 * AM-13 (M5) — cached data-plane FileREST client for the FSLogix profile
 * share (stcontoso001/fslogixprofiles), mirroring lib/computeClient.ts's
 * "one shared client per process" pattern.
 *
 * DESIGN VALIDATION (this story's own first task — see fslogixProfilesService.ts's
 * header comment for the full writeup with Microsoft Learn citations):
 * `stcontoso001` has `allowSharedKeyAccess: false` (the runbooks
 * §1) — no storage-account-key/SAS data-plane auth is
 * possible. OAuth (Entra ID) FileREST is NOT blocked by that setting,
 * PROVIDED two things are both true:
 *
 *   1. The Function App's managed identity holds the
 *      "Storage File Data Privileged Contributor" RBAC role
 *      (69566ab7-960f-475b-8e7c-b3118f30c6bd), scoped to the storage
 *      account (infra/modules/fslogixDataPlaneRole.bicep) — granted
 *      because this app's OWN Entra identity is NOT a member of
 *      AVD-Users (the group holding SMB share-level access per
 *      The FSLogix storage runbook §4) and has no NTFS ACL
 *      entry on any individual profile container; "Privileged"
 *      Contributor is the role that lets an OAuth caller bypass
 *      per-file/directory NTFS ACLs entirely, which every OTHER data-plane
 *      role (including the SMB Share roles AVD-Users holds) does NOT do.
 *   2. Every request carries `x-ms-file-request-intent: backup` — the
 *      SDK's `fileRequestIntent` client option below sets this on every
 *      request the returned client issues, not just some. Without it,
 *      Azure Files rejects the OAuth-authenticated request outright, role
 *      assignment notwithstanding (Microsoft Learn: "If the API is not
 *      called with the intent header, any subsequent data operation
 *      requests will be denied").
 *
 * NETWORK PATH: `stcontoso001` has public network access Disabled — this
 * Function App reaches it via the PRIVATE ENDPOINT (PE-stcontoso001, group
 * id `file`), not the public internet. That only works because this app's
 * VNet integration (infra/modules/functionapp.bicep's `virtualNetworkSubnetId`)
 * has `vnetRouteAllEnabled: false` — RFC1918-destined traffic (which the
 * private endpoint's private IP is) is STILL routed over the VNet
 * integration path even with vnetRouteAllEnabled false (that setting only
 * controls whether traffic to PUBLIC endpoints — ARM, Graph — is forced
 * over the VNet too; it does not opt private-endpoint traffic OUT of VNet
 * routing, since name resolution for `stcontoso001.file.core.windows.net`
 * resolves to the private endpoint's private IP via the estate's private
 * DNS zone, and any RFC1918-destined packet always prefers the VNet
 * integration's route). See infra/modules/functionapp.bicep's
 * `vnetRouteAllEnabled` comment for the fuller ARM/Graph-vs-private-endpoint
 * distinction this depends on. If this Function App is ever deployed
 * WITHOUT VNet integration reaching SNET-MANAGEMENT (which peers to
 * SNET-PRIVATEENDPOINTS), every call through this client fails closed —
 * see fslogixProfilesService.ts's fallback-to-management-plane behavior for
 * how that failure is handled rather than blanking the Profiles page.
 *
 * SOURCES (Microsoft Learn, verified 2026-08 for this story):
 *   - x-ms-file-request-intent header, required value 'backup', required
 *     when Authorization carries an OAuth token — confirmed present on the
 *     List Directories and Files, Get/Create/Delete File, Rename File, and
 *     other FileREST data-plane operation reference pages
 *     (learn.microsoft.com/rest/api/storageservices/list-directories-and-files,
 *     .../rename-file, .../delete-file2, etc. — "Request Headers" tables).
 *   - Storage File Data Privileged Contributor role definition and GUID —
 *     learn.microsoft.com/azure/role-based-access-control/built-in-roles/storage#storage-file-data-privileged-contributor
 *     and learn.microsoft.com/azure/storage/files/authorize-oauth-rest#privileged-access-and-access-permissions-for-data-operations
 *     ("Allows for read, write, delete, and modify ACLs on files/directories
 *     in Azure file shares by overriding existing ACLs/NTFS permissions").
 *   - @azure/storage-file-share SDK's `ShareClientConfig.fileRequestIntent`
 *     option (type `ShareTokenIntent = string`, accepted value `'backup'`)
 *     and TokenCredential-accepting constructors — verified directly against
 *     the installed package's shipped .d.ts (ShareServiceClient's
 *     constructor accepts `credential?: Credential | TokenCredential`, and
 *     `ShareClientOptions` extends `ShareClientConfig`), plus
 *     learn.microsoft.com/javascript/api/@azure/storage-file-share/shareclientconfig.
 */

let cachedClient: ShareServiceClient | undefined;

/** The literal header value @azure/storage-file-share sends for every request this client issues — see this file's header comment. Kept as a named export so fslogixProfilesService.ts's doc comments/tests can reference the same literal rather than a second copy drifting. */
export const FILE_REQUEST_INTENT = 'backup';

/**
 * Lazily constructs (and caches) a ShareServiceClient against
 * `stcontoso001`'s FileREST endpoint, authenticated via
 * DefaultAzureCredential (the Function App's system-assigned managed
 * identity in Azure) with `fileRequestIntent: 'backup'` set on every
 * request the client issues. See this file's header comment for the full
 * "why this works despite allowSharedKeyAccess: false" reasoning.
 */
export function getFslogixShareServiceClient(): ShareServiceClient {
  if (!cachedClient) {
    const { storage } = getConfig();
    const credential = new DefaultAzureCredential();
    const url = `https://${storage.accountName}.file.core.windows.net`;
    cachedClient = new ShareServiceClient(url, credential, { fileRequestIntent: FILE_REQUEST_INTENT });
  }
  return cachedClient;
}

/** Test-only: clears the module-level cached client — same rationale as computeClient.ts's _resetComputeClientForTests. */
export function _resetFslogixShareServiceClientForTests(): void {
  cachedClient = undefined;
}
