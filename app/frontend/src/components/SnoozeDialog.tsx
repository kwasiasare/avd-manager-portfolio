import { useState } from 'react';
import { Dialog, DialogSurface, DialogBody, DialogTitle, DialogContent, DialogActions, Button, Field, Input, Textarea, Text, MessageBar, MessageBarBody, makeStyles, tokens } from '@fluentui/react-components';
import { useDialogFocusRestore } from '../hooks/useDialogFocusRestore';

const useStyles = makeStyles({
  hint: {
    marginTop: tokens.spacingVerticalS,
    color: tokens.colorNeutralForeground3,
  },
  reasonField: {
    marginTop: tokens.spacingVerticalM,
  },
});

export interface SnoozeDialogProps {
  title: string;
  /** Bounds shown to the user and enforced client-side — the API independently re-validates (see app/api/src/lib/alertState.ts#resolveSnoozeUntil). */
  minHours: number;
  maxHours: number;
  /** True while the confirmed snooze is in flight — disables the input and both buttons (peer review item 9: double-submit guard, same prop shape as ConfirmModal/ReasonConfirmDialog). Optional, defaults false. */
  busy?: boolean;
  /**
   * AM-34 peer review (Opus, MINOR 5) — error message from the last failed
   * snooze attempt, if any, rendered INSIDE the dialog (same rationale as
   * ConfirmModal's own `error` prop: a page-level MessageBar renders behind
   * an open Dialog's modal overlay and is invisible while it's up — see
   * AM-18 peer review). Previously this dialog had no way to surface a
   * failure of its own at all; both call sites (Monitoring.tsx, AM-34's
   * Incident.tsx) kept the error in a page-level MessageBar that a caller
   * would never actually see while this dialog was open.
   */
  error?: string;
  onConfirm: (hours: number, reason: string) => void;
  onCancel: () => void;
}

/**
 * Companion to ConfirmModal (same Dialog/DialogSurface/DialogBody building
 * blocks and Cancel/Confirm footer layout) for the one M2-era confirm
 * pattern that doesn't fit ConfirmModal's "type the name to confirm" shape:
 * snoozing an alert needs an actual duration input, not just a yes/no
 * confirmation.
 */
export default function SnoozeDialog({ title, minHours, maxHours, busy = false, error, onConfirm, onCancel }: SnoozeDialogProps) {
  useDialogFocusRestore();
  const styles = useStyles();
  const [hoursText, setHoursText] = useState('24');
  const [reason, setReason] = useState('');

  const hours = Number(hoursText);
  const isValid = Number.isInteger(hours) && hours >= minHours && hours <= maxHours;

  return (
    <Dialog
      open
      onOpenChange={(_event, data) => {
        if (!data.open && !busy) {
          onCancel();
        }
      }}
    >
      <DialogSurface>
        <DialogBody>
          <DialogTitle>{title}</DialogTitle>
          <DialogContent>
            {error && (
              <MessageBar intent="error">
                <MessageBarBody>{error}</MessageBarBody>
              </MessageBar>
            )}
            <Field label={`Snooze for how many hours? (${minHours}–${maxHours})`} validationState={isValid ? 'none' : 'error'} validationMessage={isValid ? undefined : `Enter a whole number between ${minHours} and ${maxHours}.`}>
              <Input type="number" min={minHours} max={maxHours} value={hoursText} onChange={(_event, data) => setHoursText(data.value)} autoFocus disabled={busy} />
            </Field>
            <Field label="Reason (optional)" className={styles.reasonField}>
              <Textarea value={reason} onChange={(_event, data) => setReason(data.value)} resize="vertical" disabled={busy} />
            </Field>
            <Text size={200} block className={styles.hint}>
              The alert stays muted until it expires, or until it's un-snoozed from the feed.
            </Text>
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onCancel} disabled={busy}>
              Cancel
            </Button>
            <Button appearance="primary" disabled={!isValid || busy} onClick={() => onConfirm(hours, reason.trim() || '')}>
              {busy ? 'Working…' : 'Snooze'}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
