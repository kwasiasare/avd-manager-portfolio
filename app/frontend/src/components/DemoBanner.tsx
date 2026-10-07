import { Button, MessageBar, MessageBarActions, MessageBarBody, MessageBarTitle, Radio, RadioGroup, makeStyles, tokens } from '@fluentui/react-components';
import type { Role } from '@avdmgr/shared';
import { DEMO_ROLES, setDemoRole, useDemoRole } from '../demo/identity';
import { resetDemoState } from '../demo/state';

const useStyles = makeStyles({
  banner: {
    borderRadius: 0,
  },
  controls: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: tokens.spacingHorizontalM,
    marginTop: tokens.spacingVerticalXS,
  },
});

const ROLE_LABEL: Record<Role, string> = { viewer: 'Viewer', operator: 'Operator', admin: 'Admin' };

/**
 * AM-60 — persistent banner shown above every page of the public demo
 * build (Layout renders it only when IS_DEMO). Tells the visitor what they
 * are looking at, lets them switch the simulated role (which drives every
 * RoleGate in the app, exactly as the real SWA roles would) and reset the
 * in-memory data to its seeded state.
 */
export default function DemoBanner() {
  const styles = useStyles();
  const role = useDemoRole();

  function handleReset() {
    resetDemoState();
    // Simplest reliable way to make every mounted page re-fetch from the fresh state.
    window.location.reload();
  }

  return (
    <MessageBar intent="info" layout="multiline" className={styles.banner} role="region" aria-label="Public demo notice">
      <MessageBarBody>
        <MessageBarTitle>Public demo</MessageBarTitle>
        Public demo — fictional Contoso estate, in-memory data. Reversible actions are simulated; destructive ones are disabled.
        <div className={styles.controls}>
          <RadioGroup layout="horizontal" value={role} onChange={(_event, data) => setDemoRole(data.value as Role)} aria-label="Demo role">
            {DEMO_ROLES.map((candidate) => (
              <Radio key={candidate} value={candidate} label={ROLE_LABEL[candidate]} />
            ))}
          </RadioGroup>
        </div>
      </MessageBarBody>
      <MessageBarActions>
        <Button size="small" onClick={handleReset}>
          Reset demo data
        </Button>
      </MessageBarActions>
    </MessageBar>
  );
}
