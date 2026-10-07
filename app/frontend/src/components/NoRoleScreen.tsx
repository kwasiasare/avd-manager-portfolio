import { makeStyles, tokens, Text, Card, Button } from '@fluentui/react-components';
import { ShieldQuestion24Regular, SignOut20Regular } from '@fluentui/react-icons';

const useStyles = makeStyles({
  page: {
    display: 'flex',
    minHeight: '100vh',
    alignItems: 'center',
    justifyContent: 'center',
    padding: tokens.spacingHorizontalXXL,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  card: {
    maxWidth: '520px',
    padding: `${tokens.spacingVerticalXXL} ${tokens.spacingHorizontalXXL}`,
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalM,
    alignItems: 'flex-start',
  },
  icon: {
    color: tokens.colorNeutralForeground3,
    fontSize: '32px',
  },
  list: {
    margin: 0,
    paddingLeft: tokens.spacingHorizontalXL,
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXS,
  },
  muted: {
    color: tokens.colorNeutralForeground3,
  },
});

export interface NoRoleScreenProps {
  /** The signed-in user's display name/UPN, if known — used to make the "ask your admin" guidance concrete. */
  userDetails: string | null;
}

/**
 * AM-29 item 7 — shown INSTEAD of the normal app shell (nav + page content)
 * when the user is authenticated (SWA resolved an identity) but holds none
 * of the three recognized roles (useAuth().role === null) — e.g. someone
 * who signed in with a valid Entra account but was never added to any of
 * this app's three role groups. Deliberately calm, not alarming: this is an
 * expected, recoverable state for a brand-new user, not an error.
 *
 * Rendered by Layout BEFORE the routed page component ever mounts — so the
 * page's own usePolling/useSingleFetch data fetches never fire for a user
 * who has no role to see that data with (see Layout.tsx).
 *
 * Names the three Entra ID group DISPLAY NAMES (AVDMGR-Viewers/-Operators/
 * -Admins — verified against docs/app-registration.md's `az ad group
 * create` commands and already surfaced to users on Settings.tsx's "Your
 * access" card), but never a group's object ID — those are meaningless to
 * point a user at and this app treats them as internal-only (see
 * @avdmgr/shared's ConfiguredStatus / SettingsResponse.groupIds, which
 * expose only "configured"/"not-configured", never the id itself).
 */
export default function NoRoleScreen({ userDetails }: NoRoleScreenProps) {
  const styles = useStyles();

  return (
    <div className={styles.page}>
      <Card className={styles.card}>
        <ShieldQuestion24Regular className={styles.icon} />
        <Text as="h1" size={600} weight="semibold">
          You don&apos;t have access to AVD Manager yet
        </Text>
        <Text as="p">
          {userDetails ?? 'Your account'} signed in successfully, but isn&apos;t currently a member of any of the Entra ID groups this app uses to grant access. This is expected for a
          new user — an administrator just needs to add you to one of:
        </Text>
        <ul className={styles.list}>
          <li>
            <Text weight="semibold">AVDMGR-Viewers</Text> — read-only access to dashboards and reports.
          </li>
          <li>
            <Text weight="semibold">AVDMGR-Operators</Text> — viewer access, plus day-to-day actions like draining hosts, logging off sessions, and acknowledging alerts.
          </li>
          <li>
            <Text weight="semibold">AVDMGR-Admins</Text> — operator access, plus higher-impact actions like generating registration tokens and deleting profile data.
          </li>
        </ul>
        <Text as="p" className={styles.muted}>
          Ask your administrator to add you to the appropriate group, then sign out and back in — group membership changes take effect on your next sign-in.
        </Text>
        {/*
         * Peer review (Opus, MAJOR item 3): this screen's own copy instructs
         * signing out, but offered no way to actually do it — a user stuck
         * here had to know to hunt down /.auth/logout themselves. Same
         * "full page navigation, not an SPA route" convention as Layout's
         * identity-menu Sign out (SWA Easy Auth logout is a server route
         * react-router doesn't know about).
         */}
        <Button icon={<SignOut20Regular />} onClick={() => window.location.assign('/.auth/logout')}>
          Sign out
        </Button>
      </Card>
    </div>
  );
}
