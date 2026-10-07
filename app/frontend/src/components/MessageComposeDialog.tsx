import { useId, useState, type ReactNode } from 'react';
import {
  Dialog,
  DialogSurface,
  DialogBody,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  Field,
  Input,
  Textarea,
  Text,
  MessageBar,
  MessageBarBody,
  tokens,
} from '@fluentui/react-components';
import { useDialogFocusRestore } from '../hooks/useDialogFocusRestore';

export interface MessageComposeDialogProps {
  /** Heading shown at the top of the modal, e.g. "Send message to jdoe@example.com" or "Broadcast to all active sessions". */
  title: string;
  /** Guidance shown above the fields, stating what the action does. */
  description: string;
  /**
   * Optional "blast radius" note shown between the description and the
   * fields — e.g. an ImpactPreview.tsx panel ("This will message 12 active
   * sessions.") for the page-level broadcast dialog, so the operator sees
   * the live scope BEFORE sending, not just after. Omitted for the per-row
   * send-message dialog (which always targets exactly one session — the
   * dialog title already says who). AM-33: was a plain bolded string
   * (`<Text as="p" weight="semibold">`); migrated to accept an
   * ImpactPreview panel instead for visual consistency with every other
   * action's impact preview — see the render below, which now wraps this in
   * a plain `<div>` rather than nesting block content inside a `<p>`.
   */
  impactSummary?: ReactNode;
  confirmLabel?: string;
  /** True while the send is in flight — disables both buttons and swaps the confirm label to a busy state. */
  busy?: boolean;
  /** Error message from the last failed send attempt, if any — rendered INSIDE the dialog, same rationale as ReasonConfirmDialog's `error` prop. */
  error?: string;
  /** Called with the trimmed title (undefined if left blank) and trimmed body. */
  onConfirm: (message: { title: string | undefined; body: string }) => void;
  onCancel: () => void;
}

/** Server-side bounds — see app/api/src/lib/validation.ts's MAX_MESSAGE_TITLE_LENGTH/MAX_MESSAGE_BODY_LENGTH — mirrored here so the limit is discoverable before a submit round-trips to find out. */
const MAX_TITLE_LENGTH = 200;
const MAX_BODY_LENGTH = 1000;

/**
 * Compose dialog for the AM-20 (M2-S3) session-messaging actions: per-row
 * "Send message" (Sessions page) and the page-level "Broadcast" toolbar
 * action. Both share this one component (rather than each having its own)
 * since the fields and validation are identical — only the title/
 * description/impactSummary/confirmLabel and what onConfirm does with the
 * result differ per call site.
 *
 * Same "mounting is opening" convention as ReasonConfirmDialog/ConfirmModal:
 * the caller controls visibility by conditionally rendering this component.
 */
export default function MessageComposeDialog({ title, description, impactSummary, confirmLabel = 'Send', busy = false, error, onConfirm, onCancel }: MessageComposeDialogProps) {
  useDialogFocusRestore();
  const [messageTitle, setMessageTitle] = useState('');
  const [messageBody, setMessageBody] = useState('');
  const descriptionId = useId();
  const trimmedBody = messageBody.trim();
  const canConfirm = !busy && trimmedBody.length > 0;

  return (
    <Dialog
      open
      onOpenChange={(_event, data) => {
        if (!data.open && !busy) {
          onCancel();
        }
      }}
    >
      <DialogSurface aria-describedby={descriptionId}>
        <DialogBody>
          <DialogTitle>{title}</DialogTitle>
          <DialogContent>
            <Text as="p" block id={descriptionId}>
              {description}
            </Text>
            {impactSummary && <div>{impactSummary}</div>}
            {error && (
              <MessageBar intent="error" role="alert">
                <MessageBarBody>{error}</MessageBarBody>
              </MessageBar>
            )}
            <Field label="Title (optional)">
              <Input
                value={messageTitle}
                onChange={(_event, data) => setMessageTitle(data.value)}
                placeholder="e.g. Maintenance notice"
                disabled={busy}
                maxLength={MAX_TITLE_LENGTH}
              />
            </Field>
            <Text size={200} style={{ color: tokens.colorNeutralForeground3 }}>
              {messageTitle.length}/{MAX_TITLE_LENGTH}
            </Text>
            <Field label="Message" required>
              <Textarea
                value={messageBody}
                onChange={(_event, data) => setMessageBody(data.value)}
                placeholder="What should the user see?"
                resize="vertical"
                disabled={busy}
                maxLength={MAX_BODY_LENGTH}
              />
            </Field>
            <Text size={200} style={{ color: tokens.colorNeutralForeground3 }}>
              {messageBody.length}/{MAX_BODY_LENGTH}
            </Text>
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onCancel} disabled={busy}>
              Cancel
            </Button>
            <Button
              appearance="primary"
              disabled={!canConfirm}
              onClick={() => onConfirm({ title: messageTitle.trim() || undefined, body: trimmedBody })}
            >
              {busy ? 'Sending…' : confirmLabel}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
