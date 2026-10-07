import { Dialog, DialogSurface, DialogBody, DialogTitle, DialogContent, DialogActions, Button, Text, makeStyles, tokens } from '@fluentui/react-components';
import { useDialogFocusRestore } from '../hooks/useDialogFocusRestore';
import { OTHER_SHORTCUTS, visibleNavShortcuts } from '../hooks/useKeyboardShortcuts';
import { useAuth } from '../auth/useAuth';

const useStyles = makeStyles({
  section: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalS,
    marginBottom: tokens.spacingVerticalL,
  },
  row: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: tokens.spacingHorizontalM,
  },
  keys: {
    fontFamily: tokens.fontFamilyMonospace,
    backgroundColor: tokens.colorNeutralBackground3,
    padding: `${tokens.spacingVerticalXXS} ${tokens.spacingHorizontalS}`,
    borderRadius: tokens.borderRadiusSmall,
    whiteSpace: 'nowrap',
  },
});

/**
 * AM-31 item 36 — the `?` shortcut's help dialog: every navigation shortcut
 * plus the other three (refresh/search/command-palette), read straight from
 * the same registry useKeyboardShortcuts.ts dispatches against, so this
 * list can never drift out of sync with what actually works.
 *
 * AM-34 peer review (Opus, RULING 13) — the Navigate list is filtered by
 * the current role (visibleNavShortcuts), same as CommandPalette's own
 * Navigation group: an operator-only destination (Audit, Incident) is a
 * dead end for a viewer once there, so listing it here is a discoverability
 * trap, not an aid. The `g <letter>` chord itself still works regardless of
 * role — see NAV_SHORTCUTS' own doc comment for why that's deliberate.
 */
export default function KeyboardShortcutsHelpDialog({ onClose }: { onClose: () => void }) {
  useDialogFocusRestore();
  const styles = useStyles();
  const { role } = useAuth();

  return (
    <Dialog open onOpenChange={(_event, data) => !data.open && onClose()}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogContent>
            <div className={styles.section}>
              <Text weight="semibold">Navigate</Text>
              {visibleNavShortcuts(role).map((shortcut) => (
                <div key={shortcut.keys} className={styles.row}>
                  <Text>{shortcut.label}</Text>
                  <Text className={styles.keys}>{shortcut.keys}</Text>
                </div>
              ))}
            </div>
            <div className={styles.section}>
              <Text weight="semibold">Other</Text>
              {OTHER_SHORTCUTS.map((shortcut) => (
                <div key={shortcut.keys} className={styles.row}>
                  <Text>{shortcut.description}</Text>
                  <Text className={styles.keys}>{shortcut.keys}</Text>
                </div>
              ))}
            </div>
            <Text size={200}>Shortcuts are suppressed while typing in a field, or while a dialog is open.</Text>
          </DialogContent>
          <DialogActions>
            <Button appearance="primary" onClick={onClose}>
              Close
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
