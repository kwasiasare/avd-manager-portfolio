import { MessageBar, MessageBarBody, MessageBarTitle, makeStyles } from '@fluentui/react-components';
import { IS_DEMO } from '../lib/config';

/**
 * AM-40 peer review MAJOR 4 — the "dev" named SWA preview environment
 * (a frontend deploy pipeline's `deployment_environment: 'dev'`;
 * see `docs/app-registration.md` §12) serves unreviewed dev-branch
 * FRONTEND code, but talks to the SAME production Function App / LIVE
 * Contoso estate as production — there is no separate dev backend and no
 * separate dev data. An operator poking around the dev preview can force-
 * logoff real sessions, power-cycle real VMs, or delete real FSLogix
 * profiles; none of it is simulated.
 *
 * This persistent, high-visibility bar is the in-app counterpart to the
 * bold warnings in app/README.md's "Dev testing on the preview environment"
 * section and docs/app-registration.md §12.1 — it fires purely off the
 * HOSTNAME pattern Azure Static Web Apps documents for named preview
 * environments (`<DEFAULT_HOST_NAME>-<ENVIRONMENT_NAME>.<LOCATION>.azurestaticapps.net`
 * — see https://learn.microsoft.com/azure/static-web-apps/preview-environments),
 * so it needs no build-time flag, app setting, or environment variable and
 * cannot be silently forgotten on a future redeploy — it is derived, not
 * configured.
 */
export function isDevPreviewHostname(hostname: string): boolean {
  return hostname.includes('-dev.');
}

const useStyles = makeStyles({
  banner: {
    borderRadius: 0,
  },
});

export default function DevPreviewBanner() {
  const styles = useStyles();

  // AM-60 review fix — the public demo's own "dev" preview environment shares
  // this hostname pattern, but there is no backend and nothing is real there;
  // this warning would flatly contradict DemoBanner, so the demo build never
  // shows it (IS_DEMO is a build-time constant, so this folds away in prod).
  if (IS_DEMO || typeof window === 'undefined' || !isDevPreviewHostname(window.location.hostname)) {
    return null;
  }

  return (
    <MessageBar intent="warning" role="alert" className={styles.banner}>
      <MessageBarBody>
        <MessageBarTitle>DEV PREVIEW</MessageBarTitle>
        This is the dev preview build. It connects to the SAME production API and the live Azure estate as production — session logoffs, VM power changes, profile deletes, and every other action taken here are real, not simulated.
      </MessageBarBody>
    </MessageBar>
  );
}
