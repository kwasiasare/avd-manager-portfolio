import { useId } from 'react';
import { makeStyles, mergeClasses, tokens, Text, Switch, Button, Menu, MenuTrigger, MenuPopover, MenuList, MenuItem, Tooltip } from '@fluentui/react-components';
import { ChevronDownRegular, Warning16Filled } from '@fluentui/react-icons';
import type { IntunePolicyHealthHost, SessionHostPowerAction } from '@avdmgr/shared';
import StatusBadge from './StatusBadge';
import { formatRelativeToNow } from '../lib/format';
import { useVisuallyHiddenStyles } from '../styles/shared';
import type { SessionHostViewModel } from '../lib/sessionHostViewModel';
import { POLICY_HEALTH_STATUS_LABEL, POLICY_HEALTH_STATUS_TONE } from '../lib/intunePolicyHealthViewModel';

export interface SessionHostCardProps {
  host: SessionHostViewModel;
  /**
   * AM-52 — this host's Intune policy-health result, from a SEPARATE poll
   * (GET .../policy-health) than `host` itself — see
   * lib/intunePolicyHealthViewModel.ts's header comment for why this is a
   * sibling prop rather than folded into SessionHostViewModel. Undefined
   * (not a synthetic 'unknown' result) on a page that doesn't fetch policy
   * health at all (Dashboard.tsx, Incident.tsx) — the chip is omitted
   * entirely in that case, distinct from an actual 'unknown' verdict the
   * API returned, which DOES render (as the 'unknown' tone/label).
   */
  policyHealth?: IntunePolicyHealthHost;
  /**
   * Same operator+ gate every mutating control in this app mirrors — the
   * API independently re-checks. A plain boolean (not this card's own
   * RoleGate) because both callers (Dashboard.tsx/HostPool.tsx) already
   * compute this once from useAuth for their OWN page-level gating (e.g.
   * HostPool's "Add session host" button); passing it down here avoids a
   * redundant second role read/loading-flicker per card in a 6-card grid.
   */
  canMutate: boolean;
  /** Fired when the drain Switch is toggled — the CALLER owns the actual confirm (severity 'low' + optionalReason, per AM-29 item 30's rubric) and mutation call, so one ConfirmModal instance is shared across every card on the page rather than each card managing its own. */
  onToggleDrainRequest: (host: SessionHostViewModel) => void;
  onPowerActionRequest: (host: SessionHostViewModel, action: SessionHostPowerAction) => void;
  /** Opens the shared HealthChecksDrawer for this host. */
  onViewHealthChecks: (host: SessionHostViewModel) => void;
}

const useStyles = makeStyles({
  card: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalS,
    padding: tokens.spacingHorizontalM,
    borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderLeftWidth: '3px',
    borderLeftStyle: 'solid',
    borderLeftColor: tokens.colorNeutralStroke2,
    backgroundColor: tokens.colorNeutralBackground1,
  },
  // AM-31 item 33: "visually sick" — a tinted left border + a faint tinted
  // background wash for warning/danger tones, so a struggling host reads as
  // different from a healthy one even scanning the grid at a glance, not
  // just from the (smaller) status pill text.
  cardWarning: {
    borderLeftColor: tokens.colorStatusWarningBorder1,
    backgroundColor: tokens.colorStatusWarningBackground1,
  },
  cardDanger: {
    borderLeftColor: tokens.colorStatusDangerBorder1,
    backgroundColor: tokens.colorStatusDangerBackground1,
  },
  headerRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: tokens.spacingHorizontalS,
  },
  hostName: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  metaRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: tokens.spacingHorizontalS,
    flexWrap: 'wrap',
  },
  muted: {
    color: tokens.colorNeutralForeground3,
  },
  staleHeartbeat: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalXXS,
    color: tokens.colorStatusWarningForeground1,
  },
  occupancyRow: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXXS,
  },
  occupancyBarTrack: {
    height: '6px',
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground4,
    overflow: 'hidden',
  },
  occupancyBarFill: {
    height: '100%',
    // AM-68 review fix (Fable, MINOR): colorBrandBackground is the lime CTA
    // fill, which has ~1.2:1 contrast on the light theme's near-white track —
    // a 6px lime bar on white is barely visible. colorCompoundBrandBackground
    // is the control-fill role (blue in light, lime in dark), the same token
    // the Dashboard's sessions ProgressBar and this card's Switch already use.
    backgroundColor: tokens.colorCompoundBrandBackground,
    borderRadius: tokens.borderRadiusMedium,
  },
  actionsRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: tokens.spacingHorizontalS,
    flexWrap: 'wrap',
  },
  healthChip: {
    minWidth: 'auto',
  },
});

/**
 * AM-31 item 33 — the one session-host card both Dashboard and Host Pool
 * render from the SAME SessionHostViewModel, replacing Dashboard's
 * host/status/power-state/heartbeat table and Host Pool's separate (and
 * differently-columned) host/status/power-state/agent-version/sessions/
 * allow-new-session/health-checks/actions table. Dense by design (mockup
 * exhibit A) — hostname, status pill, occupancy mini-bar, a labelled drain
 * Switch, a power-action menu, heartbeat freshness, agent version, and a
 * health-checks chip, all in one compact card.
 *
 * Callers fall back to a plain table when hosts.length > 6 (see Dashboard.tsx/
 * HostPool.tsx) — a grid of dozens of cards is worse for scanning than a
 * table once the estate is that large; this card is optimized for the
 * "glance at a handful of hosts" case the mockup showed.
 */
export default function SessionHostCard({ host, policyHealth, canMutate, onToggleDrainRequest, onPowerActionRequest, onViewHealthChecks }: SessionHostCardProps) {
  const styles = useStyles();
  const visuallyHiddenStyles = useVisuallyHiddenStyles();
  const drainHintId = useId();
  const occupancyPct = host.maxSessions && host.maxSessions > 0 ? Math.min(100, (host.activeSessions / host.maxSessions) * 100) : undefined;

  return (
    <div
      className={mergeClasses(styles.card, host.tone === 'warning' ? styles.cardWarning : undefined, host.tone === 'error' ? styles.cardDanger : undefined)}
      role="group"
      aria-label={`Session host ${host.name}`}
    >
      <div className={styles.headerRow}>
        <Text weight="semibold" className={styles.hostName} title={host.name}>
          {host.name}
        </Text>
        <StatusBadge label={host.status} tone={host.tone} size="small" />
      </div>

      <div className={styles.occupancyRow}>
        <div className={styles.metaRow}>
          <Text size={200} className={styles.muted}>
            {host.maxSessions !== undefined ? `${host.activeSessions}/${host.maxSessions} sessions` : `${host.activeSessions} session${host.activeSessions === 1 ? '' : 's'}`}
          </Text>
          {host.powerState && (
            <Text size={200} className={styles.muted}>
              {host.powerState}
            </Text>
          )}
        </div>
        {occupancyPct !== undefined && (
          <div className={styles.occupancyBarTrack} role="img" aria-label={`${host.activeSessions} of ${host.maxSessions} sessions`}>
            <div className={styles.occupancyBarFill} style={{ width: `${occupancyPct}%` }} />
          </div>
        )}
      </div>

      <div className={styles.metaRow}>
        {host.heartbeatStale ? (
          <Tooltip content="No heartbeat in over 30 minutes while the VM is running" relationship="label">
            <span className={styles.staleHeartbeat}>
              <Warning16Filled />
              <Text size={200}>{formatRelativeToNow(host.lastHeartBeat)}</Text>
            </span>
          </Tooltip>
        ) : (
          <Text size={200} className={styles.muted}>
            {formatRelativeToNow(host.lastHeartBeat)}
          </Text>
        )}
        <Text size={200} className={styles.muted}>
          {host.agentVersion ?? 'Agent unknown'}
        </Text>
      </div>

      <div className={styles.actionsRow}>
        <Button size="small" appearance="secondary" className={styles.healthChip} onClick={() => onViewHealthChecks(host)}>
          {host.healthCheckSummary ? `${host.healthCheckSummary.passed}/${host.healthCheckSummary.total} checks` : 'Checks —'}
        </Button>

        {/* AM-52 — opens the SAME drawer as the health-checks chip above (HealthChecksDrawer now has its own Intune section); omitted entirely when the caller doesn't fetch policy health at all (Dashboard.tsx, Incident.tsx) — see policyHealth's own doc comment. */}
        {policyHealth && (
          <Button size="small" appearance="secondary" className={styles.healthChip} onClick={() => onViewHealthChecks(host)}>
            <StatusBadge label={POLICY_HEALTH_STATUS_LABEL[policyHealth.status]} tone={POLICY_HEALTH_STATUS_TONE[policyHealth.status]} size="small" />
          </Button>
        )}

        {canMutate && (
          <div className={styles.actionsRow}>
            {/* Peer review MINOR 11 — aria-describedby points at a hidden hint explaining that toggling this Switch doesn't immediately change the host's drain state; the caller (Dashboard.tsx/HostPool.tsx) always opens a ConfirmModal on this callback rather than acting immediately, matching `checked` staying bound to server data (host.allowNewSession) rather than any local optimistic flip. */}
            <Switch label="Accepting sessions" checked={host.allowNewSession} onChange={() => onToggleDrainRequest(host)} aria-describedby={drainHintId} />
            <span id={drainHintId} className={visuallyHiddenStyles.visuallyHidden}>
              Opens a confirmation before changing.
            </span>
            <Menu>
              <MenuTrigger disableButtonEnhancement>
                <Button size="small" appearance="secondary" icon={<ChevronDownRegular />} iconPosition="after" aria-label={`Power actions for ${host.name}`}>
                  Power
                </Button>
              </MenuTrigger>
              <MenuPopover>
                <MenuList>
                  <MenuItem onClick={() => onPowerActionRequest(host, 'start')}>Start</MenuItem>
                  <MenuItem onClick={() => onPowerActionRequest(host, 'restart')}>Restart</MenuItem>
                  <MenuItem onClick={() => onPowerActionRequest(host, 'deallocate')}>Deallocate</MenuItem>
                </MenuList>
              </MenuPopover>
            </Menu>
          </div>
        )}
      </div>
    </div>
  );
}
