import { DefaultAzureCredential } from '@azure/identity';
import { ComputeManagementClient } from '@azure/arm-compute';
import { getConfig } from './config';

let cachedClient: ComputeManagementClient | undefined;

/**
 * AM-26 peer review (item 10): a single, shared ComputeManagementClient
 * instance for the whole API app. Before this, computeService.ts,
 * imagesService.ts, and snapshotsService.ts each lazily constructed and
 * cached their OWN client/credential — three separate
 * DefaultAzureCredential instances and three separate
 * ComputeManagementClient instances, all pointed at the same subscription
 * via the same DefaultAzureCredential chain. Harmless functionally, but
 * wasteful (three independent MSI token caches/refresh cycles) and a
 * maintenance trap (a future client-level change — retry policy,
 * telemetry, API version pin — would need updating in three places
 * instead of one). Every service module that talks to
 * Microsoft.Compute now goes through this single accessor.
 */
export function getComputeClient(): ComputeManagementClient {
  if (!cachedClient) {
    const { subscriptionId } = getConfig();
    const credential = new DefaultAzureCredential();
    cachedClient = new ComputeManagementClient(credential, subscriptionId);
  }
  return cachedClient;
}

/** Test-only: clears the module-level cached client so a test that mocks '@azure/arm-compute' differently from a previous test doesn't see a stale instance built against the old mock. */
export function _resetComputeClientForTests(): void {
  cachedClient = undefined;
}
