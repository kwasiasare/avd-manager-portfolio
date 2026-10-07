import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import {
  makeStyles,
  tokens,
  Dialog,
  DialogSurface,
  DialogBody,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  Field,
  Input,
  Combobox,
  Option,
  Text,
  MessageBar,
  MessageBarBody,
} from '@fluentui/react-components';
import { addRecentReason, CANNED_REASONS, getRecentReasons } from '../lib/reasonHistory';
import { useDialogFocusRestore } from '../hooks/useDialogFocusRestore';

const useStyles = makeStyles({
  // AM-33 peer review (Opus, MINOR 15): explicit vertical rhythm around the
  // `impact` node — this wrapper never rendered a block panel (ImpactPreview's
  // bordered box) before AM-33; DialogContent itself applies no row-gap
  // between its children (see that component's own styles), so without this
  // the panel would sit flush against the description text above it and
  // whatever error/field renders below.
  impact: {
    marginTop: tokens.spacingVerticalS,
    marginBottom: tokens.spacingVerticalS,
  },
});

/**
 * AM-29 items 29-30 — the single confirmation-severity rubric this app's
 * destructive/mutating flows should all use:
 *   - 'low':    title + body + Confirm. No reason, no typed name (unless
 *               `optionalReason` — see below). For reversible, low-blast-
 *               radius actions (drain/resume, ack, snooze, start VM, ...).
 *   - 'medium': a MANDATORY reason, no typed name. For actions that need a
 *               justification but not the extra typed-name friction (force
 *               logoff, restart, deallocate, schedule edit, ...). AM-33
 *               (D5): several 'medium' actions now also pass an `impact`
 *               node (an ImpactPreview.tsx panel) — see below.
 *   - 'high':   a typed confirmation string (confirmText) PLUS a mandatory
 *               reason, with an optional `impact` node rendered above the
 *               gate. For the smallest, highest-blast-radius set (permanent
 *               delete, remove rollout hosts, start image build, emergency
 *               override, rollout create).
 */
export type ConfirmSeverity = 'low' | 'medium' | 'high';

interface ConfirmModalBaseProps {
  /** Heading shown at the top of the modal, e.g. "Delete host pool". */
  title: string;
  /** Extra guidance shown above the input, e.g. "This cannot be undone." */
  description?: string;
  /**
   * Optional content (e.g. a list of affected resources) rendered above the
   * confirmation gate — AM-29 item 30's "optional impact node", originally
   * used only with severity 'high'. AM-33 (D5): this was never actually
   * gated to 'high' — it's a plain prop on the base shape every severity
   * shares — and every severity can now receive one; AM-33's
   * ImpactPreview.tsx is the shared component call sites pass here, wired
   * into several 'medium' actions (e.g. HostPool.tsx's restart/deallocate)
   * as well as 'high' ones.
   */
  impact?: ReactNode;
  confirmLabel?: string;
  /**
   * True while the confirmed action is in flight — disables the input and
   * both buttons and swaps the confirm label to a busy state. Optional
   * (defaults false) so callers that resolve synchronously don't need to
   * wire it up.
   */
  busy?: boolean;
  /**
   * Error message from the last failed confirm attempt, if any — rendered
   * INSIDE the dialog, same rationale as ReasonConfirmDialog's `error` prop
   * (a page-level MessageBar is invisible behind an open Dialog's modal
   * overlay — see AM-18 peer review). The dialog stays open so the caller
   * can retry.
   */
  error?: string;
  /**
   * Explicit override for whether the reason field is required. When
   * omitted, this is DERIVED from `severity`: 'low' shows no reason field
   * at all (unless `optionalReason`); 'medium'/'high' require one; the
   * legacy (no `severity`) shape defaults to optional, matching this
   * component's original behavior.
   */
  reasonRequired?: boolean;
  /**
   * AM-29 Wave 1 peer review (Opus, MAJOR item 1) — shows an OPTIONAL reason
   * field on an otherwise reason-less severity='low' dialog. Reserved for
   * the handful of 'low' actions the API actually records a reason for
   * (drain/resume, start VM, alert ack, rollout cancel) — bumping every
   * 'low' tier to always show a field would blur the rubric's low/medium
   * distinction, so this is opt-in per call site, not a severity-wide
   * default. No effect on 'medium'/'high' (already show a reason field).
   */
  optionalReason?: boolean;
  /**
   * Called with the trimmed reason (undefined when the reason field isn't
   * shown, or was left blank and not required) once every gate (typed name,
   * if shown; reason, if required) is satisfied.
   */
  onConfirm: (reason: string | undefined) => void;
  onCancel: () => void;
}

/**
 * AM-29 Wave 1 peer review (Opus, MAJOR item 6) — a discriminated union so
 * severity='high' cannot compile without confirmText: the typed-confirm
 * gate is high's whole point, and a caller passing severity="high" without
 * one is a bug, not a valid legacy shape. severity 'low'/'medium', and the
 * legacy no-severity shape (still exercised by ConfirmModal.test.tsx's own
 * "legacy shape" suite — that path always showed a typed-name gate, and
 * confirmText there is caller-supplied but not statically required), leave
 * confirmText optional.
 */
export type ConfirmModalProps = ConfirmModalBaseProps &
  ({ severity: 'high'; confirmText: string } | { severity?: 'low' | 'medium'; confirmText?: string });

/** Mirrors ReasonConfirmDialog's MAX_REASON_LENGTH / the API's server-side bound (see sessionHostDrain.ts / sessionHostPower.ts). */
const MAX_REASON_LENGTH = 1000;

/**
 * A confirmation modal covering this app's whole severity range (AM-29 items
 * 29-30) — from a plain title+body+Confirm ('low') up through a typed-name +
 * mandatory-reason gate ('high'). Built on Fluent's Dialog, which provides
 * Escape-to-close and a focus trap within the surface out of the box.
 *
 * Mounting this component IS opening it (there's no separate `open` prop) —
 * the caller controls visibility by conditionally rendering <ConfirmModal />.
 */
export default function ConfirmModal({ title, severity, confirmText, description, impact, confirmLabel = 'Confirm', busy = false, error, reasonRequired, optionalReason, onConfirm, onCancel }: ConfirmModalProps) {
  // AM-31 item 37: captures the trigger on mount, restores focus to it (or
  // the page h1) on unmount/close — see the hook's own doc comment.
  useDialogFocusRestore();
  const styles = useStyles();
  const [typed, setTyped] = useState('');
  const [reason, setReason] = useState('');
  const descriptionId = useId();
  // AM-33 peer review (Opus, MAJOR 5): the impact panel is itself part of
  // "what does confirming this do" — DialogSurface's aria-describedby now
  // references it too (space-joined alongside descriptionId, per the
  // aria-describedby spec's multi-id support), not just the plain
  // `description` string.
  const impactId = useId();
  const typedInputRef = useRef<HTMLInputElement>(null);
  const reasonComboboxRef = useRef<HTMLInputElement>(null);

  // Legacy (no `severity`) shape: always a typed-name gate, reason optional
  // unless the caller explicitly passed reasonRequired — this component's
  // exact original contract, preserved for any call site not yet migrated
  // onto the severity rubric.
  const showTypedNameField = severity === undefined || severity === 'high';
  const showReasonField = severity !== 'low' || optionalReason === true;
  const resolvedReasonRequired = reasonRequired ?? (severity !== undefined && severity !== 'low');

  const isMatch = !showTypedNameField || typed === confirmText;
  const reasonOk = !showReasonField || !resolvedReasonRequired || reason.trim().length > 0;
  const canConfirm = isMatch && !busy && reasonOk;

  // Peer review (Opus, MINOR item 8): lazy useState, not a plain `const`
  // recomputed every render — getRecentReasons reads localStorage, and this
  // dialog's own "mounting IS opening" convention means the list can only
  // usefully be read once, at mount.
  const [recentReasons] = useState<string[]>(() => (showReasonField ? getRecentReasons() : []));

  // Peer review (Opus, MINOR item 8): focus the first rendered field on
  // mount — the typed-name Input when shown (it's always first), otherwise
  // the reason Combobox when THAT'S the first (and only) field shown (e.g.
  // severity='medium', or 'low' + optionalReason). Ref access happens here,
  // inside an effect, never during render (this repo's react-hooks/refs
  // rule forbids the latter). Runs once on mount only, matching this
  // dialog's "mounting is opening" identity — no re-focus on a later
  // re-render.
  useEffect(() => {
    if (showTypedNameField) {
      typedInputRef.current?.focus();
    } else if (showReasonField) {
      reasonComboboxRef.current?.focus();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally mount-only, see comment above.
  }, []);

  function handleConfirm() {
    const trimmedReason = reason.trim();
    if (showReasonField && trimmedReason) {
      addRecentReason(trimmedReason);
    }
    onConfirm(showReasonField ? trimmedReason || undefined : undefined);
  }

  return (
    <Dialog
      open
      onOpenChange={(_event, data) => {
        if (!data.open && !busy) {
          onCancel();
        }
      }}
    >
      <DialogSurface aria-describedby={[description ? descriptionId : undefined, impact ? impactId : undefined].filter(Boolean).join(' ') || undefined}>
        <DialogBody>
          <DialogTitle>{title}</DialogTitle>
          <DialogContent>
            {description && (
              <Text as="p" block id={descriptionId}>
                {description}
              </Text>
            )}
            {impact && (
              <div id={impactId} className={styles.impact}>
                {impact}
              </div>
            )}
            {error && (
              <MessageBar intent="error">
                <MessageBarBody>{error}</MessageBarBody>
              </MessageBar>
            )}
            {showTypedNameField && (
              <Field label={<>Type <strong>{confirmText}</strong> to confirm.</>}>
                <Input
                  ref={typedInputRef}
                  value={typed}
                  onChange={(_event, data) => setTyped(data.value)}
                  placeholder={confirmText}
                  autoComplete="off"
                  disabled={busy}
                />
              </Field>
            )}
            {showReasonField && (
              <Field
                label={resolvedReasonRequired ? 'Reason (required)' : 'Reason (optional)'}
                required={resolvedReasonRequired}
              >
                <Combobox
                  ref={reasonComboboxRef}
                  freeform
                  value={reason}
                  placeholder="Why is this needed?"
                  disabled={busy}
                  onOptionSelect={(_event, data) => setReason((data.optionText ?? data.optionValue ?? '').slice(0, MAX_REASON_LENGTH))}
                  onChange={(event) => setReason((event.target as HTMLInputElement).value.slice(0, MAX_REASON_LENGTH))}
                >
                  {CANNED_REASONS.map((option) => (
                    <Option key={option} value={option}>
                      {option}
                    </Option>
                  ))}
                  {recentReasons.map((option) => (
                    <Option key={option} value={option}>
                      {option}
                    </Option>
                  ))}
                </Combobox>
              </Field>
            )}
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onCancel} disabled={busy}>
              Cancel
            </Button>
            <Button appearance="primary" disabled={!canConfirm} onClick={handleConfirm}>
              {busy ? 'Working…' : confirmLabel}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
