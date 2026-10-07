import type { SessionHostStatus } from '@avdmgr/shared';
import type { StatusTone } from '../components/StatusBadge';

/**
 * AM-29 item 17: a single, shared mapping from a session host's ARM `status`
 * to StatusBadge's tone — replaces the two different ad-hoc rules Dashboard
 * and HostPool each had (`status === 'Available' ? 'ok' : 'error'`, which
 * flattened every non-Available status, including the deliberately-off
 * 'Shutdown' state, down to the same alarming red as a genuine
 * NoHeartbeat/Unavailable failure).
 *
 * NOTE: SessionHostStatus (see @avdmgr/shared) has no 'Deallocated'/
 * 'Stopped' member — those are PowerState (a separate field on SessionHost)
 * values, not `status` values; ARM's own `status` enum only distinguishes
 * 'Shutdown' for a deliberately-off host, so that's the only "pending"
 * status case below.
 *
 *   - Available                       → ok       (accepting sessions, healthy)
 *   - Upgrading / NeedsAssistance     → warning   (in-progress / needs an operator look)
 *   - Shutdown                        → pending   (deliberately powered off, not a failure)
 *   - Unavailable / NoHeartbeat /
 *     undefined                       → error     (should be up and isn't, or status unknown)
 *   - everything else (Disconnected, UpgradeFailed, NotJoinedToDomain,
 *     DomainTrustRelationshipLost, SxSStackListenerNotReady,
 *     FSLogixNotHealthy, Unknown)     → error     (agent-reported problem states)
 */
export function sessionHostStatusTone(status: SessionHostStatus | undefined): StatusTone {
  switch (status) {
    case 'Available':
      return 'ok';
    case 'Upgrading':
    case 'NeedsAssistance':
      return 'warning';
    case 'Shutdown':
      return 'pending';
    case 'Unavailable':
    case 'NoHeartbeat':
    case undefined:
      return 'error';
    default:
      return 'error';
  }
}
