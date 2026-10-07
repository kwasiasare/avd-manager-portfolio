import { makeStyles, tokens, Text, Button, OverlayDrawer, DrawerHeader, DrawerHeaderTitle, DrawerBody } from '@fluentui/react-components';
import { Dismiss24Regular, CheckmarkCircle16Filled, DismissCircle16Filled, Warning16Filled } from '@fluentui/react-icons';
import type { IntunePolicyHealthHost } from '@avdmgr/shared';
import StatusBadge from './StatusBadge';
import { formatDateTime } from '../lib/format';
import { healthCheckSeverity, type HealthCheckSeverity, type SessionHostViewModel } from '../lib/sessionHostViewModel';
import { POLICY_HEALTH_STATUS_LABEL, POLICY_HEALTH_STATUS_TONE } from '../lib/intunePolicyHealthViewModel';

const useStyles = makeStyles({
  drawer: {
    width: '420px',
  },
  drawerSection: {
    marginBottom: tokens.spacingVerticalL,
  },
  propLabel: {
    color: tokens.colorNeutralForeground3,
  },
  checkRow: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    padding: `${tokens.spacingVerticalS} 0`,
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  iconOk: { color: tokens.colorStatusSuccessForeground1, flexShrink: 0 },
  iconWarn: { color: tokens.colorStatusWarningForeground1, flexShrink: 0 },
  iconFail: { color: tokens.colorStatusDangerForeground1, flexShrink: 0 },
  policyHeaderRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: tokens.spacingVerticalS,
  },
  remediationBox: {
    marginTop: tokens.spacingVerticalS,
    padding: tokens.spacingHorizontalS,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground3,
  },
  settingsList: {
    margin: 0,
    paddingLeft: tokens.spacingHorizontalL,
  },
});

/**
 * AM-52 — the Intune policy-health section: status, per-setting error list
 * (bounded — see IntunePolicyHealthEvidence.fsLogixErrorSettings's own doc
 * comment), a duplicate-device-record note, and — for 'missing-admx' only —
 * the guided remediation text. No deep link to the Intune portal's devices
 * blade is rendered: unlike this app's Entra admin-center links (verified,
 * stable blade routes), no Microsoft-documented stable URL for a
 * SPECIFIC managed device's blade was found — per this story's own decision
 * rule ("if a stable URL exists, else omit"), it is omitted rather than
 * guessed.
 */
function IntunePolicySection({ policyHealth, styles }: { policyHealth: IntunePolicyHealthHost; styles: ReturnType<typeof useStyles> }) {
  const { status, evidence, remediation } = policyHealth;
  return (
    <div className={styles.drawerSection}>
      <div className={styles.policyHeaderRow}>
        <Text weight="semibold">Intune policy health</Text>
        <StatusBadge label={POLICY_HEALTH_STATUS_LABEL[status]} tone={POLICY_HEALTH_STATUS_TONE[status]} size="small" />
      </div>

      {status === 'not-enrolled' && <Text className={styles.propLabel}>No Intune managed device matches this host's name.</Text>}
      {status === 'unknown' && (
        <Text className={styles.propLabel}>
          {evidence.correlationId
            ? `Could not be checked right now. Reference: ${evidence.correlationId}`
            : "Could not be checked — the required Microsoft Graph permission may not be granted yet (see docs/app-registration.md §9)."}
        </Text>
      )}
      {(status === 'ok' || status === 'policy-errors' || status === 'missing-admx') && (
        <>
          <Text block className={styles.propLabel}>
            Last Intune sync
          </Text>
          <Text block>{formatDateTime(evidence.lastSyncDateTime)}</Text>
          {evidence.errorSettingCount !== undefined && evidence.errorSettingCount > 0 && (
            <Text block style={{ marginTop: tokens.spacingVerticalXS }}>
              {evidence.errorSettingCount} setting{evidence.errorSettingCount === 1 ? '' : 's'} reporting an error.
            </Text>
          )}
          {evidence.fsLogixErrorSettings && evidence.fsLogixErrorSettings.length > 0 && (
            <ul className={styles.settingsList}>
              {evidence.fsLogixErrorSettings.map((setting) => (
                <li key={setting}>
                  <Text size={200}>{setting}</Text>
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      {evidence.duplicateDeviceRecords && (
        <Text block style={{ marginTop: tokens.spacingVerticalXS }} className={styles.propLabel}>
          More than one Intune device record matches this host — the most recently synced record was used.
        </Text>
      )}

      {remediation && (
        <div className={styles.remediationBox}>
          <Text block weight="semibold" size={200}>
            Remediation
          </Text>
          <Text size={200}>{remediation}</Text>
        </div>
      )}
    </div>
  );
}

function SeverityIcon({ severity, styles }: { severity: HealthCheckSeverity; styles: ReturnType<typeof useStyles> }) {
  if (severity === 'ok') return <CheckmarkCircle16Filled className={styles.iconOk} />;
  if (severity === 'warn') return <Warning16Filled className={styles.iconWarn} />;
  return <DismissCircle16Filled className={styles.iconFail} />;
}

/**
 * AM-31 item 33 — the session host detail drawer, extracted from
 * HostPool.tsx so SessionHostCard's "N/M checks" chip can open the SAME
 * drawer from either Dashboard or Host Pool (previously HostPool-only —
 * Dashboard had no equivalent detail view at all). Takes a
 * SessionHostViewModel (the same shared view model SessionHostCard renders
 * from) rather than a raw SessionHost, so both callers feed it identically.
 */
export default function HealthChecksDrawer({
  host,
  policyHealth,
  onClose,
}: {
  host: SessionHostViewModel | undefined;
  /** AM-52 — sibling data (a separate poll from `host` — see SessionHostCard's policyHealth prop doc comment); undefined omits the Intune section entirely (a page that doesn't fetch policy health at all). */
  policyHealth?: IntunePolicyHealthHost;
  onClose: () => void;
}) {
  const styles = useStyles();
  return (
    <OverlayDrawer
      className={styles.drawer}
      open={host !== undefined}
      onOpenChange={(_event, data) => {
        if (!data.open) onClose();
      }}
      position="end"
    >
      <DrawerHeader>
        <DrawerHeaderTitle action={<Button appearance="subtle" aria-label="Close" icon={<Dismiss24Regular />} onClick={onClose} />}>{host?.name ?? 'Session host'}</DrawerHeaderTitle>
      </DrawerHeader>
      <DrawerBody>
        {host && (
          <>
            <div className={styles.drawerSection}>
              <Text block className={styles.propLabel}>
                Agent version
              </Text>
              <Text>{host.agentVersion ?? 'Unknown'}</Text>
            </div>
            <div className={styles.drawerSection}>
              <Text block className={styles.propLabel}>
                Power state
              </Text>
              <Text>{host.powerState ?? 'unknown'}</Text>
            </div>
            <div className={styles.drawerSection}>
              <Text block className={styles.propLabel}>
                Allow new session
              </Text>
              <Text>{host.allowNewSession ? 'Yes' : 'No (draining)'}</Text>
            </div>
            <div className={styles.drawerSection}>
              <Text block className={styles.propLabel}>
                Last heartbeat
              </Text>
              <Text>{formatDateTime(host.lastHeartBeat)}</Text>
            </div>

            {policyHealth && <IntunePolicySection policyHealth={policyHealth} styles={styles} />}

            <Text weight="semibold" block style={{ marginBottom: tokens.spacingVerticalS }}>
              Health checks
            </Text>
            {!host.healthChecks || host.healthChecks.length === 0 ? (
              <Text className={styles.propLabel}>No health check results reported.</Text>
            ) : (
              host.healthChecks.map((check) => {
                const severity = healthCheckSeverity(check);
                return (
                  <div key={check.name} className={styles.checkRow}>
                    <SeverityIcon severity={severity} styles={styles} />
                    <div>
                      <Text block>{check.name}</Text>
                      <Text size={200} className={styles.propLabel}>
                        {check.healthCheckResult}
                        {check.additionalFailureDetails ? ` — ${check.additionalFailureDetails}` : ''}
                      </Text>
                    </div>
                  </div>
                );
              })
            )}
          </>
        )}
      </DrawerBody>
    </OverlayDrawer>
  );
}
