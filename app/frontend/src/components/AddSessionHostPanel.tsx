import { useEffect, useState } from 'react';
import {
  makeStyles,
  tokens,
  Button,
  Text,
  OverlayDrawer,
  DrawerHeader,
  DrawerHeaderTitle,
  DrawerBody,
  Dialog,
  DialogSurface,
  DialogBody,
  DialogTitle,
  DialogContent,
  DialogActions,
  Field,
  Input,
  Textarea,
  MessageBar,
  MessageBarBody,
  MessageBarTitle,
  MessageBarActions,
} from '@fluentui/react-components';
import { Dismiss24Regular } from '@fluentui/react-icons';
import type { RegistrationTokenStatus, VmTemplateInfo } from '@avdmgr/shared';
import { generateRegistrationToken, getRegistrationTokenStatus, getVmTemplate } from '../api/avd';
import { ApiClientError } from '../api/client';
import RoleGate from './RoleGate';
import SessionHostProvisionSection from './SessionHostProvisionSection';
import { useDialogFocusRestore } from '../hooks/useDialogFocusRestore';
import { formatCountdown, formatDateTime } from '../lib/format';

export interface AddSessionHostPanelProps {
  hostPoolName: string;
  open: boolean;
  onClose: () => void;
}

const DEFAULT_HOURS_VALID = 8;
/** Mirrors the server-side bound — see app/api/src/functions/hostPoolRegistrationToken.ts's doc comment for the Microsoft Learn source (Azure Virtual Desktop's own 27-day/648-hour maximum). */
const MAX_HOURS_VALID = 648;

const useStyles = makeStyles({
  drawer: {
    width: '480px',
  },
  section: {
    marginBottom: tokens.spacingVerticalL,
  },
  label: {
    color: tokens.colorNeutralForeground3,
  },
  propsGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
    gap: tokens.spacingVerticalM,
    marginTop: tokens.spacingVerticalS,
  },
  tokenBox: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXS,
    padding: tokens.spacingHorizontalM,
    backgroundColor: tokens.colorNeutralBackground3,
    borderRadius: tokens.borderRadiusMedium,
    wordBreak: 'break-all',
    fontFamily: 'monospace',
    fontSize: tokens.fontSizeBase200,
  },
  checklist: {
    paddingLeft: tokens.spacingHorizontalXL,
    margin: 0,
  },
  checklistItem: {
    marginBottom: tokens.spacingVerticalS,
  },
});

function vmTemplateRows(template: VmTemplateInfo): Array<{ label: string; value: string }> {
  const rows: Array<{ label: string; value: string }> = [];
  if (template.namePrefix) rows.push({ label: 'Name prefix', value: template.namePrefix });
  if (template.vmSizeId) rows.push({ label: 'VM size', value: template.vmSizeId });
  if (template.osDiskType) rows.push({ label: 'OS disk type', value: template.osDiskType });
  if (template.imageType) rows.push({ label: 'Image type', value: template.imageType });
  if (template.galleryImagePublisher || template.galleryImageOffer || template.galleryImageSKU) {
    rows.push({
      label: 'Gallery image',
      value: [template.galleryImagePublisher, template.galleryImageOffer, template.galleryImageSKU].filter(Boolean).join(' / '),
    });
  }
  if (template.galleryImageVersion) rows.push({ label: 'Image version', value: template.galleryImageVersion });
  if (template.customImageId) rows.push({ label: 'Custom image ID', value: template.customImageId });
  rows.push({ label: 'Domain', value: template.domain || 'None (Microsoft Entra ID join)' });
  if (template.ouPath) rows.push({ label: 'OU path', value: template.ouPath });
  if (template.hibernate !== undefined) rows.push({ label: 'Hibernation', value: template.hibernate ? 'Enabled' : 'Disabled' });
  return rows;
}

/**
 * Guided "Add session host" panel (AM-22/M2-S5). NOT a VM-creation flow —
 * this app deliberately does not provision the host itself (see the notice
 * rendered below); it generates the registration token an operator needs
 * and surfaces the host pool's own vmTemplate parameters so the manual/
 * scripted steps in the session-host runbook can be followed
 * without re-deriving them from the Portal.
 *
 * Visibility: opened for operator+ (see HostPool.tsx's RoleGate around the
 * trigger button) — an operator can view the current token status and the
 * vmTemplate parameters (mirrors the API's operator-minimum gate on both
 * GET routes), but only an admin can actually generate/rotate a token (the
 * "Generate token" control below is itself wrapped in RoleGate(['admin']),
 * mirroring the API's requireMinimumRole('admin') on the POST route).
 */
export default function AddSessionHostPanel({ hostPoolName, open, onClose }: AddSessionHostPanelProps) {
  const styles = useStyles();

  const [status, setStatus] = useState<RegistrationTokenStatus | undefined>(undefined);
  const [statusError, setStatusError] = useState<string | undefined>(undefined);
  // Starts true (not false): the panel's first open should show "Loading…"
  // rather than a misleading blank/"No active token" state before the
  // fetch below has had a chance to run — same "only the FIRST load shows
  // loading" convention as usePolling.ts. A later reopen quietly refreshes
  // over whatever was last shown, without resetting this back to true (see
  // the effect below, which — also matching usePolling.ts — never calls
  // setState synchronously in its own body, only from the fetch's
  // then/catch/finally callbacks).
  const [statusLoading, setStatusLoading] = useState(true);

  const [template, setTemplate] = useState<VmTemplateInfo | undefined>(undefined);
  const [templateError, setTemplateError] = useState<string | undefined>(undefined);
  const [templateLoading, setTemplateLoading] = useState(true);

  const [generateDialogOpen, setGenerateDialogOpen] = useState(false);
  const [hoursValid, setHoursValid] = useState(String(DEFAULT_HOURS_VALID));
  const [generateBusy, setGenerateBusy] = useState(false);
  const [generateError, setGenerateError] = useState<string | undefined>(undefined);
  const [newToken, setNewToken] = useState<string | undefined>(undefined);
  const [copyMessage, setCopyMessage] = useState<string | undefined>(undefined);

  // Fetched on open only (not polled) — this is an on-demand admin panel,
  // not a live dashboard widget; re-opening it re-fetches fresh state. Every
  // state update below happens inside a then/catch/finally callback, never
  // synchronously in the effect body itself (matching usePolling.ts's own
  // pattern) — a synchronous setState call here would risk cascading
  // renders per the react-hooks/set-state-in-effect rule. The stale-error
  // reset is likewise deferred to a microtask (Promise.resolve().then)
  // rather than called directly, for the same reason — see Opus review
  // item 3 ("clear stale statusError/templateError when a refetch kicks
  // off"): without this, reopening the panel after a previous failed fetch
  // would keep showing that old error message for the ~duration of the new
  // request, even though a fresh attempt is already underway.
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();

    Promise.resolve().then(() => {
      if (controller.signal.aborted) return;
      setStatusError(undefined);
      setTemplateError(undefined);
    });

    getRegistrationTokenStatus(hostPoolName, controller.signal)
      .then((result) => {
        setStatus(result);
        setStatusError(undefined);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setStatusError(error instanceof ApiClientError ? error.message : 'Failed to load registration token status.');
      })
      .finally(() => {
        if (!controller.signal.aborted) setStatusLoading(false);
      });

    getVmTemplate(hostPoolName, controller.signal)
      .then((result) => {
        setTemplate(result);
        setTemplateError(undefined);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setTemplateError(error instanceof ApiClientError ? error.message : 'Failed to load the VM template.');
      })
      .finally(() => {
        if (!controller.signal.aborted) setTemplateLoading(false);
      });

    return () => controller.abort();
  }, [open, hostPoolName]);

  // Re-renders once a minute while the drawer is open so the countdown text
  // (formatCountdown, which reads the current time at render) doesn't
  // silently freeze at whatever it read on the render that opened the
  // panel (Opus review item 2). `tick` itself is never read — only its
  // setter is used, purely to force the periodic re-render.
  const [, setCountdownTick] = useState(0);
  useEffect(() => {
    if (!open) return;
    const interval = setInterval(() => setCountdownTick((t) => t + 1), 60_000);
    return () => clearInterval(interval);
  }, [open]);

  // Defense-in-depth token hygiene (Opus review item 3, "unmount effect
  // too"): handleDrawerClose below already clears newToken on every path
  // that closes the drawer while this component stays mounted, but this
  // additionally clears it if the component instance is ever unmounted
  // directly (e.g. the HostPool page navigates away while the panel was
  // open), so the token value never outlives this component's lifetime
  // however that lifetime ends.
  useEffect(() => {
    return () => setNewToken(undefined);
  }, []);

  /**
   * Closes the drawer AND resets every piece of generate-dialog state,
   * including the shown-once token — covers the header's Close button, Esc,
   * and overlay-click (all funnel through OverlayDrawer's onOpenChange,
   * wired below), so there is no path that closes the drawer while leaving
   * a stale token/dialog behind for the next open (Opus review item 3).
   */
  function handleDrawerClose() {
    setGenerateDialogOpen(false);
    setNewToken(undefined);
    setGenerateError(undefined);
    setCopyMessage(undefined);
    onClose();
  }

  function openGenerateDialog() {
    setHoursValid(String(DEFAULT_HOURS_VALID));
    setGenerateError(undefined);
    setNewToken(undefined);
    setCopyMessage(undefined);
    setGenerateDialogOpen(true);
  }

  function closeGenerateDialog() {
    if (generateBusy) return;
    setGenerateDialogOpen(false);
    setNewToken(undefined);
    setCopyMessage(undefined);
  }

  async function confirmGenerate() {
    const parsedHours = Number(hoursValid);
    if (!Number.isInteger(parsedHours) || parsedHours < 1 || parsedHours > MAX_HOURS_VALID) {
      setGenerateError(`Enter a whole number of hours between 1 and ${MAX_HOURS_VALID}.`);
      return;
    }

    setGenerateBusy(true);
    setGenerateError(undefined);
    try {
      const result = await generateRegistrationToken(hostPoolName, { hoursValid: parsedHours });
      setNewToken(result.token);
      setStatus({ exists: true, expirationTime: result.expirationTime });
    } catch (error) {
      setGenerateError(error instanceof ApiClientError ? error.message : 'Failed to generate a registration token.');
    } finally {
      setGenerateBusy(false);
    }
  }

  async function copyToken() {
    if (!newToken) return;
    try {
      await navigator.clipboard.writeText(newToken);
      setCopyMessage('Copied to clipboard.');
    } catch {
      setCopyMessage('Could not copy automatically — select and copy the token text manually.');
    }
  }

  return (
    <>
      <OverlayDrawer className={styles.drawer} open={open} onOpenChange={(_event, data) => !data.open && handleDrawerClose()} position="end">
        <DrawerHeader>
          <DrawerHeaderTitle action={<Button appearance="subtle" aria-label="Close" icon={<Dismiss24Regular />} onClick={handleDrawerClose} />}>
            Add session host — {hostPoolName}
          </DrawerHeaderTitle>
        </DrawerHeader>
        <DrawerBody>
          <MessageBar intent="info" className={styles.section}>
            <MessageBarBody>
              <MessageBarTitle>Guided or automated</MessageBarTitle>
              Admins can provision the session host VM and its extensions directly from this app (see &quot;Provision from this
              app&quot; below) — the sections above/below remain as the manual/scripted reference path, and still generate the
              registration token and VM parameters an admin-provisioned host does not need.
            </MessageBarBody>
          </MessageBar>

          <div className={styles.section}>
            <Text weight="semibold" block>
              1. Registration token
            </Text>
            {statusError && (
              <MessageBar intent="error">
                <MessageBarBody>{statusError}</MessageBarBody>
              </MessageBar>
            )}
            {!statusError && (
              <Text block className={styles.label}>
                {statusLoading
                  ? 'Loading…'
                  : status?.exists
                    ? `Active token — ${formatCountdown(status.expirationTime)} (${formatDateTime(status.expirationTime)})`
                    : 'No active token.'}
              </Text>
            )}

            <RoleGate
              allowed={['admin']}
              fallback={
                <Text block className={styles.label} style={{ marginTop: tokens.spacingVerticalS }}>
                  Ask an admin to generate a registration token.
                </Text>
              }
            >
              <Button appearance="primary" style={{ marginTop: tokens.spacingVerticalS }} onClick={openGenerateDialog}>
                Generate new token
              </Button>
            </RoleGate>
          </div>

          <div className={styles.section}>
            <Text weight="semibold" block>
              2. VM template parameters
            </Text>
            {templateError && (
              <MessageBar intent="error">
                <MessageBarBody>{templateError}</MessageBarBody>
              </MessageBar>
            )}
            {!templateError && templateLoading && <Text className={styles.label}>Loading…</Text>}
            {!templateError && !templateLoading && template && !template.parsed && (
              <Text className={styles.label}>The host pool&apos;s vmTemplate could not be parsed — check it directly in the Portal.</Text>
            )}
            {!templateError && !templateLoading && template?.parsed && (
              <div className={styles.propsGrid}>
                {vmTemplateRows(template).map((row) => (
                  <div key={row.label}>
                    <Text block className={styles.label}>
                      {row.label}
                    </Text>
                    <Text>{row.value}</Text>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className={styles.section}>
            <Text weight="semibold" block>
              3. Add the host
            </Text>
            <ol className={styles.checklist}>
              <li className={styles.checklistItem}>
                <Text>Create the VM with the parameters above (same subnet, image version, and size as the existing hosts).</Text>
              </li>
              <li className={styles.checklistItem}>
                <Text>
                  Apply the AADLoginForWindows and GuestAttestation extensions, then run Microsoft.PowerShell.DSC with the
                  registration token from step 1 embedded in its protected settings — the token must be in place when DSC runs,
                  not applied afterward.
                </Text>
              </li>
              <li className={styles.checklistItem}>
                <Text>Confirm the host appears in Session hosts and its health checks report Succeeded.</Text>
              </li>
            </ol>
            <Text block>
              Full step-by-step (portal path, az CLI, and troubleshooting): see{' '}
              <Text weight="semibold" as="span">
                the session-host runbook
              </Text>{' '}
              in this repo.
            </Text>
          </div>

          <RoleGate allowed={['admin']}>
            <SessionHostProvisionSection hostPoolName={hostPoolName} open={open} template={template} />
          </RoleGate>
        </DrawerBody>
      </OverlayDrawer>

      {generateDialogOpen && (
        <GenerateTokenDialog
          hoursValid={hoursValid}
          setHoursValid={setHoursValid}
          generateError={generateError}
          generateBusy={generateBusy}
          newToken={newToken}
          expirationTime={status?.expirationTime}
          copyMessage={copyMessage}
          styles={styles}
          onClose={closeGenerateDialog}
          onGenerate={confirmGenerate}
          onCopy={copyToken}
          onDismissCopyMessage={() => setCopyMessage(undefined)}
        />
      )}
    </>
  );
}

/**
 * AM-31 item 37 — extracted so useDialogFocusRestore applies to this ad hoc
 * Dialog the same way it does to every ConfirmModal — the hook must run
 * inside the dialog's OWN component so its mount/unmount lifecycle matches
 * the dialog's actual open/close. AddSessionHostPanel itself stays mounted
 * for the whole time the OverlayDrawer it owns is reachable (HostPool.tsx
 * renders it unconditionally, toggling only its `open` prop), so calling
 * the hook at that level would have captured/restored focus against the
 * PANEL's own open/close, not this nested token dialog's.
 */
function GenerateTokenDialog({
  hoursValid,
  setHoursValid,
  generateError,
  generateBusy,
  newToken,
  expirationTime,
  copyMessage,
  styles,
  onClose,
  onGenerate,
  onCopy,
  onDismissCopyMessage,
}: {
  hoursValid: string;
  setHoursValid: (value: string) => void;
  generateError: string | undefined;
  generateBusy: boolean;
  newToken: string | undefined;
  expirationTime: string | undefined;
  copyMessage: string | undefined;
  styles: ReturnType<typeof useStyles>;
  onClose: () => void;
  onGenerate: () => void;
  onCopy: () => void;
  onDismissCopyMessage: () => void;
}) {
  useDialogFocusRestore();
  return (
    // modalType="alert" while a token is shown: Fluent's alert Dialog
    // cannot be dismissed via Esc or an overlay click, only via an
    // explicit action button (Done, below) — so a shown-once token
    // can't be lost to a stray keypress or misclick (Opus review item
    // 3). Before generation, it's a normal dismissible modal.
    <Dialog open modalType={newToken ? 'alert' : 'modal'} onOpenChange={(_event, data) => !data.open && onClose()}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>Generate registration token</DialogTitle>
          <DialogContent>
            {!newToken && (
              <>
                <Text as="p" block>
                  A new token replaces any currently active token — hosts mid-registration with the old token may need to
                  restart their join.
                </Text>
                {generateError && (
                  <MessageBar intent="error">
                    <MessageBarBody>{generateError}</MessageBarBody>
                  </MessageBar>
                )}
                <Field label={`Valid for how many hours? (1-${MAX_HOURS_VALID})`}>
                  <Input
                    type="number"
                    min={1}
                    max={MAX_HOURS_VALID}
                    value={hoursValid}
                    onChange={(_event, data) => setHoursValid(data.value)}
                    disabled={generateBusy}
                  />
                </Field>
              </>
            )}
            {newToken && (
              <>
                <MessageBar intent="warning">
                  <MessageBarBody>
                    <MessageBarTitle>Shown once</MessageBarTitle>
                    This token will not be shown again — copy it now. Anyone holding it can register a new session host into
                    this pool until it expires. Generating another token immediately invalidates this one. After pasting it
                    into the DSC extension&apos;s protected settings, clear it from your clipboard.
                  </MessageBarBody>
                </MessageBar>
                <Textarea
                  value={newToken}
                  readOnly
                  resize="vertical"
                  rows={4}
                  className={styles.tokenBox}
                  aria-label="Registration token"
                />
                {expirationTime && (
                  <Text block className={styles.label}>
                    {formatCountdown(expirationTime)} ({formatDateTime(expirationTime)})
                  </Text>
                )}
                {copyMessage && (
                  <div role="status" aria-live="polite">
                    <MessageBar intent="success" role="status" aria-live="polite">
                      <MessageBarBody>{copyMessage}</MessageBarBody>
                      <MessageBarActions>
                        <Button appearance="transparent" size="small" onClick={onDismissCopyMessage}>
                          Dismiss
                        </Button>
                      </MessageBarActions>
                    </MessageBar>
                  </div>
                )}
              </>
            )}
          </DialogContent>
          <DialogActions>
            {!newToken && (
              <>
                <Button appearance="secondary" onClick={onClose} disabled={generateBusy}>
                  Cancel
                </Button>
                <Button appearance="primary" onClick={onGenerate} disabled={generateBusy}>
                  {generateBusy ? 'Generating…' : 'Generate'}
                </Button>
              </>
            )}
            {newToken && (
              <>
                <Button appearance="secondary" onClick={onCopy}>
                  Copy
                </Button>
                <Button appearance="primary" onClick={onClose}>
                  Done
                </Button>
              </>
            )}
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
