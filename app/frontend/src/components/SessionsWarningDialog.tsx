import { useId } from 'react';
import { Dialog, DialogSurface, DialogBody, DialogTitle, DialogContent, DialogActions, Button, MessageBar, MessageBarBody, MessageBarTitle } from '@fluentui/react-components';
import type { SessionHostPowerAction } from '@avdmgr/shared';
import { useDialogFocusRestore } from '../hooks/useDialogFocusRestore';
import { powerActionGerund } from '../lib/sessionHostPowerActions';
import { hostPowerPreviewLines } from '../lib/impactPreview';

/**
 * AM-19's "drain-first prompt", extracted so both HostPool.tsx and
 * Dashboard.tsx (AM-31 item 33 — Dashboard grew the same power-action flow
 * once it adopted SessionHostCard) share ONE copy instead of two
 * hand-duplicated Dialog blocks. AM-31 item 37: useDialogFocusRestore lives
 * HERE, inside this dialog's own component, so its mount/unmount lifecycle
 * matches the dialog's actual open/close — not the page's.
 *
 * AM-33 peer review (Opus, MAJOR 2): this dialog used to say "N active
 * sessions" — wrong per @avdmgr/shared's own SessionHost.activeSessions doc
 * comment (it's the ARM TOTAL count, not active-only) — while the
 * follow-up ConfirmModal's ImpactPreview panel, one step later, said the
 * honest "N sessions". Two different words for the same number in the same
 * flow. Fixed by computing THIS dialog's session-count sentence (and its
 * drain-state warning, folded in below) from the exact same
 * hostPowerPreviewLines helper the panel uses — the two can now never say
 * something different from each other, because they're the same call.
 */
export default function SessionsWarningDialog({
  hostName,
  activeSessions,
  allowNewSession,
  action,
  onProceed,
  onCancel,
}: {
  hostName: string;
  activeSessions: number;
  /** Live drain state — feeds the same hostPowerPreviewLines helper the follow-up ConfirmModal's panel uses, so this interstitial's drain-state warning (when it has sessions AND isn't draining) matches that panel word for word. */
  allowNewSession: boolean;
  action: SessionHostPowerAction;
  onProceed: () => void;
  onCancel: () => void;
}) {
  useDialogFocusRestore();
  const descriptionId = useId();
  const impactLines = hostPowerPreviewLines({ name: hostName, activeSessions, allowNewSession }, action);
  const drainWarning = impactLines.find((line) => line.tone === 'warning');

  return (
    <Dialog
      open
      onOpenChange={(_event, data) => {
        if (!data.open) onCancel();
      }}
    >
      <DialogSurface aria-describedby={descriptionId}>
        <DialogBody>
          <DialogTitle>{hostName} has sessions</DialogTitle>
          <DialogContent>
            <MessageBar intent="warning">
              <MessageBarBody id={descriptionId}>
                <MessageBarTitle>Draining first is recommended</MessageBarTitle>
                {hostName} currently has {activeSessions} session{activeSessions === 1 ? '' : 's'}. {powerActionGerund(action)} this host now will forcibly disconnect {activeSessions === 1 ? 'it' : 'them'} without warning.
                Consider draining the host first (see the Drain button/switch) so sessions can end gracefully, or proceed anyway if this host needs immediate attention.
                {drainWarning && <> {drainWarning.text}</>}
              </MessageBarBody>
            </MessageBar>
          </DialogContent>
          {/* Cancel is primary (the recommended path) and "Proceed anyway" is secondary — the disruptive path must not be styled as the recommended one (AM-19 peer review item 8). */}
          <DialogActions>
            <Button appearance="secondary" onClick={onProceed}>
              Proceed anyway
            </Button>
            <Button appearance="primary" onClick={onCancel}>
              Cancel
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
