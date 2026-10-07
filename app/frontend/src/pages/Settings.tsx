import { makeStyles, mergeClasses, tokens, Card, CardHeader, Text, Badge, Link, Divider, RadioGroup, Radio } from '@fluentui/react-components';
import type { ConfiguredStatus } from '@avdmgr/shared';
import { useAuth } from '../auth/useAuth';
import { useSingleFetch } from '../hooks/useSingleFetch';
import { getSettings } from '../api/avd';
import AsyncState from '../components/AsyncState';
import PageHeader from '../components/PageHeader';
import { CONFLUENCE_SPACE_URL, IS_DEMO, JIRA_PROJECT_URL, SWA_URL } from '../lib/config';
import { useCardStyles } from '../styles/shared';
import { useThemeMode, THEME_MODE_OPTIONS, type ThemeMode } from '../theme/themeMode';

const useStyles = makeStyles({
  page: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXL,
    maxWidth: '720px',
  },
  card: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalM,
  },
  row: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    gap: tokens.spacingHorizontalM,
  },
  label: {
    color: tokens.colorNeutralForeground3,
  },
  roleRow: {
    display: 'flex',
    gap: tokens.spacingHorizontalXS,
    flexWrap: 'wrap',
  },
  muted: {
    color: tokens.colorNeutralForeground3,
  },
  linkList: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalS,
  },
  footer: {
    color: tokens.colorNeutralForeground3,
  },
});

const CONFIGURED_STATUS_TONE: Record<ConfiguredStatus, 'ok' | 'warning'> = {
  configured: 'ok',
  'not-configured': 'warning',
};

function ConfigRow({ label, value }: { label: string; value: string }) {
  const styles = useStyles();
  return (
    <div className={styles.row}>
      <Text className={styles.label}>{label}</Text>
      <Text weight="semibold">{value}</Text>
    </div>
  );
}

function GroupStatusRow({ label, status }: { label: string; status: ConfiguredStatus }) {
  const styles = useStyles();
  return (
    <div className={styles.row}>
      <Text className={styles.label}>{label}</Text>
      <Badge appearance="tint" color={CONFIGURED_STATUS_TONE[status] === 'ok' ? 'success' : 'warning'}>
        {status === 'configured' ? 'Configured' : 'Not configured'}
      </Badge>
    </div>
  );
}

/**
 * AM-15 (M7) — Settings page: the signed-in user's resolved access, a
 * read-only slice of this app's own non-secret configuration, and a links
 * card to the surrounding tooling. No mutations happen from this page —
 * every value shown here is changed via a Function App setting + Bicep
 * deploy (infra/main.bicep), never through this UI (see @avdmgr/shared's
 * SettingsResponse doc comment).
 */
export default function Settings() {
  const styles = useStyles();
  const cardStyles = useCardStyles();
  const auth = useAuth();
  const { mode, setMode } = useThemeMode();
  // Peer review MINOR fix: a single fetch on mount, not a poll — see
  // useSingleFetch's doc comment for why polling this endpoint specifically
  // is pointless (nothing it returns can change without a redeploy).
  const settings = useSingleFetch(getSettings);

  return (
    <div className={styles.page}>
      {/* No asOf: GET /v1/settings is fetched once via useSingleFetch, not
          polled (see that hook's doc comment — nothing it returns can
          change without a redeploy), so there's no meaningful "as of"
          freshness instant to show. onRefresh is still wired to its
          one-shot refresh() for a manual re-check; refreshing (peer review,
          Opus MINOR item 9) reuses useSingleFetch's own `loading` — its
          only in-flight signal (no separate `refreshing` flag the way
          usePolling has). Note this only reflects the FIRST fetch
          (useSingleFetch.refresh() only sets loading back to true if no
          data has resolved yet — see that hook's own refresh()), so a
          manual re-check after data has already loaded once won't visibly
          spin; a real gap, but out of scope for this pass since it's this
          hook's behavior, not PageHeader's wiring. */}
      <PageHeader title="Settings" refreshing={settings.loading} onRefresh={() => settings.refresh()} />

      {/* AM-29 item U2: reuses useThemeMode/THEME_MODE_OPTIONS directly (see
          theme/AppThemeProvider.tsx) — the SAME state Layout's identity-menu
          theme submenu reads/writes, never a second independently-tracked
          toggle. */}
      <Card className={mergeClasses(cardStyles.card, styles.card)}>
        <CardHeader header={<Text as="h2" size={400} weight="semibold">Appearance</Text>} />
        <RadioGroup
          layout="horizontal"
          value={mode}
          onChange={(_event, data) => {
            const next = data.value as ThemeMode;
            setMode(next);
          }}
        >
          {THEME_MODE_OPTIONS.map((option) => (
            <Radio key={option.value} value={option.value} label={option.label} />
          ))}
        </RadioGroup>
      </Card>

      <Card className={mergeClasses(cardStyles.card, styles.card)}>
        <CardHeader header={<Text as="h2" size={400} weight="semibold">Your access</Text>} />
        {auth.loading ? (
          <Text className={styles.muted}>Resolving your access…</Text>
        ) : !auth.isAuthenticated ? (
          <Text className={styles.muted}>Not signed in.</Text>
        ) : (
          <>
            <ConfigRow label="Signed in as" value={auth.userDetails ?? 'unknown'} />
            <div className={styles.row}>
              <Text className={styles.label}>Roles</Text>
              <div className={styles.roleRow}>
                {auth.roles.length === 0 ? (
                  <Badge appearance="tint" color="warning">
                    None
                  </Badge>
                ) : (
                  auth.roles.map((role) => (
                    <Badge key={role} appearance={role === auth.role ? 'filled' : 'tint'} color={role === 'admin' ? 'danger' : role === 'operator' ? 'brand' : 'informative'}>
                      {role}
                    </Badge>
                  ))
                )}
              </div>
            </div>
            <Divider />
            <Text size={200} className={styles.muted}>
              Roles come from Entra ID group membership (AVDMGR-Viewers / AVDMGR-Operators / AVDMGR-Admins), resolved by the app's <code>/api/roles</code> function at sign-in and enforced server-side on every API call — this page shows what Static Web Apps resolved for your current session, not a client-side guess. A group membership change takes effect the next time you sign in, not instantly. Being in more than one group grants every corresponding role; the highest (
              <strong>{auth.role ?? 'none'}</strong>) is highlighted above. See <code>docs/app-registration.md</code> sections 1 and 4 for how group membership is set up and mapped.
            </Text>
          </>
        )}
      </Card>

      <Card className={mergeClasses(cardStyles.card, styles.card)}>
        <CardHeader header={<Text as="h2" size={400} weight="semibold">App configuration</Text>} />
        <AsyncState loading={settings.loading} error={settings.error as Error | undefined} data={settings.data}>
          {(data) => (
            <>
              <ConfigRow label="API version" value={data.apiVersion} />
              {/* AM-54 — only shown when the API actually reported a
                  build-artifact-sourced gitSha (see @avdmgr/shared's
                  SettingsResponse doc comment): an app-setting-fallback
                  apiVersion (versionSource: 'app-setting', e.g. local dev or
                  a deploy predating this story) has no commit to point at. */}
              {data.gitSha && (
                <ConfigRow
                  label="Build"
                  value={data.builtAt ? `${data.gitSha.slice(0, 7)} · ${new Date(data.builtAt).toLocaleString()}` : data.gitSha.slice(0, 7)}
                />
              )}
              <ConfigRow label="Host pool" value={data.hostPoolName} />
              <ConfigRow label="Workspace" value={data.workspaceName} />
              <ConfigRow label="Desktop application group" value={data.dagName} />
              <ConfigRow label="FSLogix storage account" value={data.storage.accountName} />
              <ConfigRow label="FSLogix share" value={data.storage.fslogixShareName} />
              <ConfigRow label="Oversized profile threshold" value={`${data.profilesOversizedGb} GiB`} />
              <Divider />
              <Text size={200} className={styles.label}>
                Role-mapping group IDs (Entra object IDs are never shown here — see docs/app-registration.md section 1)
              </Text>
              <GroupStatusRow label="Viewer group" status={data.groupIds.viewer} />
              <GroupStatusRow label="Operator group" status={data.groupIds.operator} />
              <GroupStatusRow label="Admin group" status={data.groupIds.admin} />
            </>
          )}
        </AsyncState>
      </Card>

      <Card className={mergeClasses(cardStyles.card, styles.card)}>
        <CardHeader header={<Text as="h2" size={400} weight="semibold">Links</Text>} />
        <div className={styles.linkList}>
          {/* Peer review MINOR fix: SWA_URL now falls back to '' (not a
              hardcoded prod hostname — see lib/config.ts) when
              window.location.origin isn't available (e.g. SSR/non-browser
              contexts, which don't apply to this SPA today but keep the
              type honest) — hidden rather than rendered as a broken/empty
              link, matching the Jira/Confluence not-configured treatment
              below. */}
          {SWA_URL ? (
            <>
              <Link href={SWA_URL} target="_blank" rel="noreferrer">
                Static Web App (this site)
              </Link>
              {IS_DEMO ? (
                <Text className={styles.muted}>Demo build — no Function App behind this site, so there is no health endpoint.</Text>
              ) : (
                <Link href={`${SWA_URL}/api/v1/health`} target="_blank" rel="noreferrer">
                  Function App health check
                </Link>
              )}
            </>
          ) : (
            <Text className={styles.muted}>Static Web App / health check — not configured (set VITE_SWA_URL)</Text>
          )}
          {JIRA_PROJECT_URL ? (
            <Link href={JIRA_PROJECT_URL} target="_blank" rel="noreferrer">
              Jira project (AM)
            </Link>
          ) : (
            <Text className={styles.muted}>Jira project — not configured (set VITE_JIRA_PROJECT_URL)</Text>
          )}
          {CONFLUENCE_SPACE_URL ? (
            <Link href={CONFLUENCE_SPACE_URL} target="_blank" rel="noreferrer">
              Confluence space
            </Link>
          ) : (
            <Text className={styles.muted}>Confluence space — not configured (set VITE_CONFLUENCE_SPACE_URL)</Text>
          )}
        </div>
      </Card>

      <Text size={200} className={styles.footer}>
        AVD Manager v{__APP_VERSION__}
      </Text>
    </div>
  );
}
