import { useEffect, useState } from 'react';
import {
  makeStyles,
  tokens,
  Text,
  Button,
  Field,
  Input,
  Dropdown,
  Option,
  MessageBar,
  MessageBarBody,
  MessageBarTitle,
  MessageBarActions,
  Divider,
  Dialog,
  DialogSurface,
  DialogBody,
  DialogTitle,
  DialogContent,
  DialogActions,
  Textarea,
} from '@fluentui/react-components';
import {
  SESSION_HOST_PROVISION_STEP_LABELS,
  SESSION_HOST_PROVISION_TERMINAL_STATES,
  type SessionHost,
  type SessionHostProvisionDetail,
  type SessionHostProvisionState,
  type SessionHostProvisionStepState,
  type SessionHostProvisionSummary,
  type VmTemplateInfo,
} from '@avdmgr/shared';
import { getImageVersions, getSessionHosts } from '../api/avd';
import { listRolloutPlans } from '../api/rollout';
import { cancelSessionHostProvision, getSessionHostProvision, listSessionHostProvisions, startSessionHostProvision } from '../api/sessionHostProvisions';
import { usePolling } from '../hooks/usePolling';
import AsyncState from './AsyncState';
import ConfirmModal from './ConfirmModal';
import DataTable, { type DataTableColumn } from './DataTable';
import Stepper, { type StepperStep, type StepperStepState } from './Stepper';
import StatusBadge from './StatusBadge';
import { useDialogFocusRestore } from '../hooks/useDialogFocusRestore';
import { formatDateTime } from '../lib/format';
import { ApiClientError } from '../api/client';

const PROVISION_LIST_POLL_MS = 15_000;
/** AM-50: same active/terminal polling shape as ImageBuildSection.tsx's BUILD_DETAIL_POLL_MS/BUILD_DETAIL_TERMINAL_POLL_MS. */
const PROVISION_DETAIL_ACTIVE_POLL_MS = 5_000;
const PROVISION_DETAIL_TERMINAL_POLL_MS = 60 * 60_000;

const ZONES: Array<'1' | '2' | '3'> = ['1', '2', '3'];

const useStyles = makeStyles({
  form: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalM,
    maxWidth: '440px',
  },
  hint: {
    color: tokens.colorNeutralForeground3,
  },
  actions: {
    display: 'flex',
    gap: tokens.spacingHorizontalS,
    marginTop: tokens.spacingVerticalS,
  },
  passwordBox: {
    fontFamily: tokens.fontFamilyMonospace,
  },
  section: {
    marginTop: tokens.spacingVerticalL,
  },
});

function toneFor(status: string): 'ok' | 'warning' | 'error' | 'info' | 'pending' {
  if (status === 'done' || status === 'succeeded') return 'ok';
  if (status === 'failed') return 'error';
  if (status === 'pending') return 'pending';
  if (status === 'cancelled' || status === 'skipped') return 'info';
  return 'warning';
}

function stepperStateFor(status: SessionHostProvisionStepState['status']): StepperStepState {
  if (status === 'succeeded') return 'done';
  if (status === 'pending') return 'upcoming';
  return 'current';
}

/** Mirrors ImageBuildSection.tsx#findCurrentIndex exactly, adapted to SessionHostProvisionStepState — see that function's doc comment for the "failed step must win 'current' over a later untouched pending step" rationale. */
function findCurrentIndex(steps: SessionHostProvisionStepState[]): number {
  const inProgress = steps.findIndex((s) => s.status === 'in_progress');
  if (inProgress !== -1) return inProgress;
  const stopped = steps.findIndex((s) => s.status === 'failed');
  if (stopped !== -1) return stopped;
  const pending = steps.findIndex((s) => s.status === 'pending');
  if (pending !== -1) return pending;
  return steps.length - 1;
}

/** Adapts SessionHostProvisionStepState[] to the shared Stepper component — mirrors ImageBuildSection.tsx's BuildStepper. */
function ProvisionStepper({ steps, state }: { steps: SessionHostProvisionStepState[]; state: SessionHostProvisionState }) {
  if (steps.length === 0) {
    return <Text>No steps recorded yet.</Text>;
  }
  const effectiveCurrentIndex = findCurrentIndex(steps);
  const stepperSteps: StepperStep[] = steps.map((step, index) => {
    const isCurrent = index === effectiveCurrentIndex && state !== 'done';
    return {
      id: step.stepId,
      label: SESSION_HOST_PROVISION_STEP_LABELS[step.stepId],
      state: isCurrent ? 'current' : stepperStateFor(step.status),
      tone: toneFor(step.status),
      statusLabel: step.status,
      startedAt: step.startedAt,
      completedAt: step.completedAt,
      inFlight: isCurrent && step.status === 'in_progress',
      error: step.error,
    };
  });
  return <Stepper steps={stepperSteps} orientation="vertical" ariaLabel="Provisioning progress" />;
}

function suggestNextSessionHostName(hosts: SessionHost[] | undefined, prefix: string): string {
  const safePrefix = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^${safePrefix}-(\\d+)$`, 'i');
  let max = -1;
  for (const host of hosts ?? []) {
    const match = pattern.exec(host.name);
    if (match) {
      max = Math.max(max, Number(match[1]));
    }
  }
  return `${prefix}-${max + 1}`;
}

export interface SessionHostProvisionSectionProps {
  hostPoolName: string;
  open: boolean;
  /** Already fetched by the parent panel (AddSessionHostPanel.tsx's own vmTemplate load) — reused here for the size prefill and name-prefix suggestion so this section doesn't duplicate that ARM read. */
  template: VmTemplateInfo | undefined;
}

/**
 * AM-50 — "Provision from this app" section of the guided Add session host
 * panel: creates the session-host VM and applies its three extensions
 * (Entra join, guest attestation, DSC AddSessionHost) end to end, replacing
 * the manual §3 checklist this panel used to be limited to. Admin-only
 * (parent gates this whole section with RoleGate(['admin']) — mirrors
 * ImageBuildSection.tsx's own admin-only gate for the same "creates a real,
 * billable Azure VM" reasoning).
 *
 * Self-contained: owns its own fetching/polling/state, same pattern as
 * ImageBuildSection.tsx/RolloutWizard.tsx.
 */
export default function SessionHostProvisionSection({ hostPoolName, open, template }: SessionHostProvisionSectionProps) {
  const styles = useStyles();

  const provisions = usePolling((signal) => listSessionHostProvisions(hostPoolName, signal), PROVISION_LIST_POLL_MS, [hostPoolName]);

  const [selectedProvisionId, setSelectedProvisionId] = useState<string | undefined>(undefined);
  const [selectedTerminal, setSelectedTerminal] = useState(false);
  const selectedProvision = usePolling(
    (signal) => (selectedProvisionId ? getSessionHostProvision(hostPoolName, selectedProvisionId, signal) : Promise.resolve(undefined as unknown as SessionHostProvisionDetail)),
    selectedTerminal ? PROVISION_DETAIL_TERMINAL_POLL_MS : PROVISION_DETAIL_ACTIVE_POLL_MS,
    [selectedProvisionId, hostPoolName],
  );

  // Same deferred-setState-in-effect pattern as ImageBuildSection.tsx's own
  // terminal-state slowdown effect — see that file's doc comment for why
  // this is wrapped in a setTimeout(…, 0) rather than called synchronously.
  useEffect(() => {
    const nextTerminal = selectedProvision.data ? SESSION_HOST_PROVISION_TERMINAL_STATES.includes(selectedProvision.data.state) : false;
    if (nextTerminal === selectedTerminal) return;
    const timer = window.setTimeout(() => setSelectedTerminal(nextTerminal), 0);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deliberately keyed on `.state` alone, not the whole object — see ImageBuildSection.tsx's identical comment.
  }, [selectedProvision.data?.state, selectedTerminal]);

  function selectProvision(provisionId: string | undefined) {
    setSelectedTerminal(false);
    setSelectedProvisionId(provisionId);
  }

  // Suggestion data — session hosts (for the next-sequential-name
  // suggestion) fetched once when the panel opens; not polled, matching
  // AddSessionHostPanel.tsx's own on-open-only fetch convention for its
  // token/vmTemplate sections.
  const [existingHosts, setExistingHosts] = useState<SessionHost[]>([]);
  const [versions, setVersions] = useState<string[]>([]);
  const [defaultVersion, setDefaultVersion] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();

    getSessionHosts(hostPoolName, controller.signal)
      .then((hosts) => setExistingHosts(hosts))
      .catch(() => undefined);

    getImageVersions(controller.signal)
      .then((report) => setVersions(report.versions.map((v) => v.name)))
      .catch(() => undefined);

    listRolloutPlans(hostPoolName, controller.signal)
      .then((response) => {
        const active = response.plans.find((plan) => !['done', 'rolled_back', 'cancelled'].includes(plan.state));
        setDefaultVersion(active?.targetImageVersion);
      })
      .catch(() => undefined);

    return () => controller.abort();
  }, [open, hostPoolName]);

  const [sessionHostName, setSessionHostName] = useState('');
  const [zone, setZone] = useState<'1' | '2' | '3'>('2');
  const [vmSize, setVmSize] = useState('');
  const [imageVersion, setImageVersion] = useState('');
  const [suggested, setSuggested] = useState(false);

  // Prefill the name/size/version fields once the suggestion data above has
  // actually loaded — a single one-shot prefill (guarded by `suggested`),
  // not a controlled derivation, so an operator's own edits are never
  // silently overwritten by a later-arriving fetch. Deferred into a
  // setTimeout(…, 0) callback, not called synchronously in the effect body
  // — same react-hooks/set-state-in-effect-driven convention
  // ImageBuildSection.tsx's own terminal-state effect and
  // AddSessionHostPanel.tsx's stale-error reset both already use.
  useEffect(() => {
    if (suggested || !open) return;
    if (existingHosts.length === 0 && versions.length === 0 && !template) return;
    const timer = window.setTimeout(() => {
      setSessionHostName((current) => current || suggestNextSessionHostName(existingHosts, template?.namePrefix || 'avd-con'));
      setVmSize((current) => current || template?.vmSizeId || '');
      setImageVersion((current) => current || defaultVersion || versions[0] || '');
      setSuggested(true);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [suggested, open, existingHosts, versions, defaultVersion, template]);

  const [showStartConfirm, setShowStartConfirm] = useState(false);
  const [startBusy, setStartBusy] = useState(false);
  const [startError, setStartError] = useState<string | undefined>(undefined);

  const [generatedPassword, setGeneratedPassword] = useState<string | undefined>(undefined);
  const [passwordCopyMessage, setPasswordCopyMessage] = useState<string | undefined>(undefined);
  useEffect(() => {
    return () => setGeneratedPassword(undefined); // defense-in-depth: clear on unmount too, not just on explicit dismiss — same contract as ImageBuildSection.tsx's own generatedPassword.
  }, []);

  const [showCancelConfirm, setShowCancelConfirm] = useState(false);
  const [cancelBusy, setCancelBusy] = useState(false);
  const [cancelError, setCancelError] = useState<string | undefined>(undefined);

  async function handleStart() {
    setStartBusy(true);
    setStartError(undefined);
    try {
      const response = await startSessionHostProvision(hostPoolName, { sessionHostName: sessionHostName.trim(), zone, vmSize: vmSize.trim() || undefined, imageVersion: imageVersion.trim() || undefined }, false);
      setShowStartConfirm(false);
      if (response.provision) {
        selectProvision(response.provision.provisionId);
      }
      if (response.generatedAdminPassword) {
        setGeneratedPassword(response.generatedAdminPassword);
      }
      provisions.refresh();
    } catch (error) {
      setStartError(error instanceof ApiClientError ? error.message : 'Failed to start the provision.');
    } finally {
      setStartBusy(false);
    }
  }

  function dismissPasswordDialog() {
    setGeneratedPassword(undefined);
    setPasswordCopyMessage(undefined);
  }

  async function copyPassword() {
    if (!generatedPassword) return;
    try {
      await navigator.clipboard.writeText(generatedPassword);
      setPasswordCopyMessage('Copied to clipboard.');
    } catch {
      setPasswordCopyMessage('Could not copy automatically — select and copy the text manually.');
    }
  }

  async function handleCancel(reason: string | undefined) {
    if (!selectedProvisionId) return;
    setCancelBusy(true);
    setCancelError(undefined);
    try {
      await cancelSessionHostProvision(hostPoolName, selectedProvisionId, { reason });
      setShowCancelConfirm(false);
      selectedProvision.refresh();
      provisions.refresh();
    } catch (error) {
      setCancelError(error instanceof ApiClientError ? error.message : 'Failed to cancel the provision.');
    } finally {
      setCancelBusy(false);
    }
  }

  const canStart = sessionHostName.trim().length > 0 && sessionHostName.trim().length <= 15;

  const PROVISION_COLUMNS: DataTableColumn<SessionHostProvisionSummary>[] = [
    { id: 'name', label: 'Session host', renderCell: (p) => p.sessionHostName },
    { id: 'state', label: 'State', renderCell: (p) => <StatusBadge label={p.state} tone={toneFor(p.state)} /> },
    { id: 'zone', label: 'Zone', renderCell: (p) => p.zone },
    { id: 'version', label: 'Image version', renderCell: (p) => p.imageVersion },
    { id: 'started', label: 'Started', renderCell: (p) => formatDateTime(p.createdAt) },
    { id: 'by', label: 'By', renderCell: (p) => p.createdBy },
    {
      id: 'view',
      label: 'View provision',
      visuallyHiddenHeader: true,
      renderCell: (p) => (
        <Button size="small" onClick={() => selectProvision(p.provisionId)}>
          View
        </Button>
      ),
    },
  ];

  return (
    <div className={styles.section}>
      <Divider />
      <Text weight="semibold" block className={styles.section}>
        Provision from this app
      </Text>
      <Text size={200} className={styles.hint}>
        Creates the session-host VM and applies its Entra join, guest attestation, and AVD registration extensions in order — replacing the manual §3 checklist below for hosts added this way.
      </Text>

      {!selectedProvisionId && (
        <>
          <div className={styles.form}>
            <Field label="Session host name" hint={`Becomes the VM's computer name verbatim — 1-15 characters (Windows' NetBIOS limit).`}>
              <Input value={sessionHostName} onChange={(_e, d) => setSessionHostName(d.value)} placeholder="avd-con-3" maxLength={15} />
            </Field>
            <Field label="Availability zone" hint="Live hosts occupy zones 2 and 3 — consider spreading across zones for resiliency.">
              <Dropdown
                value={zone}
                selectedOptions={[zone]}
                onOptionSelect={(_e, d) => {
                  if (d.optionValue) setZone(d.optionValue as '1' | '2' | '3');
                }}
              >
                {ZONES.map((z) => (
                  <Option key={z} value={z}>
                    {z}
                  </Option>
                ))}
              </Dropdown>
            </Field>
            <Field label="VM size" hint="Defaults to the host pool's own vmTemplate size.">
              <Input value={vmSize} onChange={(_e, d) => setVmSize(d.value)} placeholder="Standard_D4ads_v7" />
            </Field>
            <Field label="Image version" hint="Defaults to an active rollout's target version, else the currently-published version. Pinned versions can go stale — check the Images page if unsure.">
              <Dropdown
                value={imageVersion}
                selectedOptions={imageVersion ? [imageVersion] : []}
                onOptionSelect={(_e, d) => {
                  if (d.optionValue) setImageVersion(d.optionValue);
                }}
              >
                {versions.map((v) => (
                  <Option key={v} value={v} text={v}>
                    {v}
                    {v === defaultVersion ? ' (active rollout target)' : ''}
                  </Option>
                ))}
              </Dropdown>
            </Field>
            <Text size={200}>The session host's local admin password is generated automatically and shown once when provisioning starts — this app never asks for or stores one.</Text>
            {startError && (
              <MessageBar intent="error">
                <MessageBarBody>{startError}</MessageBarBody>
              </MessageBar>
            )}
            <div className={styles.actions}>
              <Button appearance="primary" disabled={!canStart} onClick={() => setShowStartConfirm(true)}>
                Provision session host
              </Button>
            </div>
          </div>

          <div className={styles.section}>
            <Text weight="semibold" block>
              In-flight and recent provisions
            </Text>
            <AsyncState loading={provisions.loading} error={provisions.error} data={provisions.data} isEmpty={(d) => d.provisions.length === 0} emptyMessage="No provisions yet.">
              {(data) => <DataTable ariaLabel="Session host provisions" columns={PROVISION_COLUMNS} rows={data.provisions} getRowKey={(p) => p.provisionId} emptyMessage="No provisions yet." />}
            </AsyncState>
          </div>
        </>
      )}

      {selectedProvisionId && (
        <div className={styles.section}>
          <Button appearance="secondary" onClick={() => selectProvision(undefined)}>
            Back to provisioning
          </Button>
          <AsyncState loading={selectedProvision.loading} error={selectedProvision.error} data={selectedProvision.data} emptyMessage="Provision not found.">
            {(provision) => (
              <div>
                <Text block>
                  <strong>{provision.sessionHostName}</strong> — <StatusBadge label={provision.state} tone={toneFor(provision.state)} />
                </Text>

                {provision.errorMessage && (
                  <MessageBar intent="error">
                    <MessageBarBody>
                      <MessageBarTitle>Provisioning failed</MessageBarTitle>
                      {provision.errorMessage}
                    </MessageBarBody>
                  </MessageBar>
                )}

                {provision.cleanupGuidance && (
                  <MessageBar intent="warning">
                    <MessageBarBody>
                      <MessageBarTitle>Cancelled — manual cleanup</MessageBarTitle>
                      {provision.cleanupGuidance}
                    </MessageBarBody>
                  </MessageBar>
                )}

                {cancelError && (
                  <MessageBar intent="error">
                    <MessageBarBody>{cancelError}</MessageBarBody>
                  </MessageBar>
                )}

                {!SESSION_HOST_PROVISION_TERMINAL_STATES.includes(provision.state) && (
                  <div className={styles.actions}>
                    <Button appearance="secondary" onClick={() => setShowCancelConfirm(true)}>
                      Cancel provision
                    </Button>
                  </div>
                )}

                <Divider />
                <Text weight="semibold">Progress</Text>
                <ProvisionStepper steps={provision.steps} state={provision.state} />
                <Text size={200} className={styles.hint}>
                  This runs server-side — you can close this panel and come back.
                </Text>
              </div>
            )}
          </AsyncState>
        </div>
      )}

      {showStartConfirm && (
        <ConfirmModal
          title="Provision session host"
          severity="high"
          confirmText={sessionHostName.trim()}
          description="This creates a real, billable session-host VM in Azure and joins it to this host pool. Type the session host name to confirm."
          confirmLabel="Provision"
          busy={startBusy}
          error={startError}
          onConfirm={handleStart}
          onCancel={() => setShowStartConfirm(false)}
        />
      )}

      {generatedPassword && (
        <GeneratedProvisionPasswordDialog
          password={generatedPassword}
          copyMessage={passwordCopyMessage}
          styles={styles}
          onCopy={copyPassword}
          onDismissCopyMessage={() => setPasswordCopyMessage(undefined)}
          onDone={dismissPasswordDialog}
        />
      )}

      {showCancelConfirm && selectedProvision.data && (
        <ConfirmModal
          title="Cancel provision"
          severity="medium"
          description="This stops the provisioning state machine. It does NOT automatically delete any Azure resources already created — you will be shown exactly what still needs manual cleanup."
          confirmLabel="Cancel provision"
          busy={cancelBusy}
          error={cancelError}
          onConfirm={(reason) => handleCancel(reason)}
          onCancel={() => setShowCancelConfirm(false)}
        />
      )}
    </div>
  );
}

/** Shown-once admin password dialog — mirrors ImageBuildSection.tsx's GeneratedPasswordDialog and AddSessionHostPanel.tsx's own GenerateTokenDialog exactly (modalType="alert" so a shown-once credential can't be lost to a stray keypress/misclick). */
function GeneratedProvisionPasswordDialog({
  password,
  copyMessage,
  styles,
  onCopy,
  onDismissCopyMessage,
  onDone,
}: {
  password: string;
  copyMessage: string | undefined;
  styles: ReturnType<typeof useStyles>;
  onCopy: () => void;
  onDismissCopyMessage: () => void;
  onDone: () => void;
}) {
  useDialogFocusRestore();
  return (
    <Dialog open modalType="alert">
      <DialogSurface>
        <DialogBody>
          <DialogTitle>Session host admin password</DialogTitle>
          <DialogContent>
            <MessageBar intent="warning">
              <MessageBarBody>
                <MessageBarTitle>Shown once</MessageBarTitle>
                This password will not be shown again — copy it now if you need to sign into the session host directly. This app never stores or logs it.
              </MessageBarBody>
            </MessageBar>
            <Textarea value={password} readOnly resize="none" rows={1} className={styles.passwordBox} aria-label="Session host admin password" />
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
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onCopy}>
              Copy
            </Button>
            <Button appearance="primary" onClick={onDone}>
              Done
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
