import { useEffect, useState } from 'react';
import {
  makeStyles,
  tokens,
  Card,
  CardHeader,
  Text,
  Button,
  Field,
  Input,
  MessageBar,
  MessageBarBody,
  MessageBarTitle,
  MessageBarActions,
  Badge,
  Divider,
  Dialog,
  DialogSurface,
  DialogBody,
  DialogTitle,
  DialogContent,
  DialogActions,
  Textarea,
  Tooltip,
} from '@fluentui/react-components';
import {
  IMAGE_BUILD_CHECKLIST,
  IMAGE_BUILD_STEP_LABELS,
  IMAGE_BUILD_TERMINAL_STATES,
  type ImageBuildDetail,
  type ImageBuildPlan,
  type ImageBuildState,
  type ImageBuildStepState,
  type ImageBuildSummary,
  type StartImageBuildRequest,
} from '@avdmgr/shared';
import { OPERATOR_GATED_IMAGE_BUILD_STATES } from '../lib/imageBuildStates';
import { advanceImageBuild, cancelImageBuild, deleteImageBuildSnapshot, getImageBuild, listImageBuilds, startImageBuild, updateImageBuildChecklist } from '../api/avd';
import { usePolling } from '../hooks/usePolling';
import AsyncState from './AsyncState';
import ConfirmModal from './ConfirmModal';
import ImageBuildChecklist from './ImageBuildChecklist';
import ImpactPreview from './ImpactPreview';
import RoleGate from './RoleGate';
import StatusBadge, { type StatusTone } from './StatusBadge';
import DataTable, { type DataTableColumn } from './DataTable';
import Stepper, { type StepperStep, type StepperStepState } from './Stepper';
import { useDialogFocusRestore } from '../hooks/useDialogFocusRestore';
import { formatDateTime } from '../lib/format';
import { useCardStyles } from '../styles/shared';
import { ApiClientError } from '../api/client';

const BUILD_LIST_POLL_MS = 15_000;
const BUILD_DETAIL_POLL_MS = 5_000;
/** AM-29 item 6: effectively "stopped" — usePolling's setInterval takes a real interval, not an off switch, so a terminal build's detail poll is slowed to a cadence long enough that it's never realistically observed firing rather than torn down and rebuilt with a different mechanism. */
const BUILD_DETAIL_TERMINAL_POLL_MS = 60 * 60_000;

const useStyles = makeStyles({
  form: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalM,
    maxWidth: '480px',
  },
  /** AM-29 items 20/25: muted helper text under a stepper or a compound-disabled button. */
  hint: {
    color: tokens.colorNeutralForeground3,
  },
  actions: {
    display: 'flex',
    gap: tokens.spacingHorizontalS,
  },
  planStep: {
    padding: tokens.spacingVerticalS,
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  paramsBlock: {
    marginTop: tokens.spacingVerticalXS,
    padding: tokens.spacingHorizontalS,
    backgroundColor: tokens.colorNeutralBackground3,
    borderRadius: tokens.borderRadiusMedium,
    fontFamily: tokens.fontFamilyMonospace,
    fontSize: tokens.fontSizeBase200,
    whiteSpace: 'pre-wrap',
    overflowX: 'auto',
  },
  passwordBox: {
    fontFamily: tokens.fontFamilyMonospace,
  },
});

/** AM-53 — maps the live snapshot status to StatusBadge's tone: 'present' is the normal, expected state (nothing wrong — 'info'); 'deleted' is this feature's own successful outcome ('ok'); 'unknown' means the read itself failed, never guessed. */
function snapshotStatusTone(status: 'present' | 'deleted' | 'unknown'): StatusTone {
  if (status === 'deleted') return 'ok';
  if (status === 'unknown') return 'unknown';
  return 'info';
}

/** Maps a build/step status to StatusBadge's tone. */
function toneFor(status: string): 'ok' | 'warning' | 'error' | 'info' | 'pending' {
  if (status === 'done' || status === 'succeeded') return 'ok';
  if (status === 'failed') return 'error';
  // AM-29 item 16: 'pending' (not yet reached) gets the dedicated 'pending'
  // tone; 'cancelled'/'skipped' are terminal-but-inactive outcomes, which
  // read better as plain 'info' than as the same "still waiting" pending tone.
  if (status === 'pending') return 'pending';
  if (status === 'cancelled' || status === 'skipped') return 'info';
  return 'warning'; // in-progress / any other in-flight state
}

/** Maps an ImageBuildStepStatus to the shared Stepper component's StepperStepState — 'succeeded' folds into 'done'; every non-terminal/non-pending status (in_progress, or anything else the step can report while active) reads as 'current'. */
function stepperStateFor(status: ImageBuildStepState['status']): StepperStepState {
  if (status === 'succeeded') return 'done';
  if (status === 'pending') return 'upcoming';
  return 'current'; // in_progress / failed / cancelled / skipped — all "this is where things stand right now"
}

/**
 * AM-31 item 35 — sensible, approximate per-step duration constants for the
 * Stepper's optional "typically ~X min" hint, based on this build's known
 * shape (a Standard_D-series VM, Windows Server 2022 base, per
 * The golden-image runbook). These are rough operator-facing
 * guidance, not SLAs — actual timing varies with VM size/region/current
 * Azure capacity. Steps with no sensible fixed estimate (the two operator
 * gates, which are entirely operator-paced) are omitted.
 */
const BUILD_STEP_DURATION_HINTS: Partial<Record<ImageBuildStepState['stepId'], string>> = {
  create_build_nic: '1 min',
  create_build_vm: '3 min',
  create_presysprep_snapshot: '2 min',
  run_sysprep: '10 min',
  await_stopped: '2 min',
  ensure_deallocated: '1 min',
  generalize_vm: '1 min',
  capture_image_version: '15 min',
  delete_build_vm: '1 min',
  delete_build_nic: '1 min',
  delete_build_disk: '1 min',
};

/**
 * State explanations shown above the steps table — every non-terminal,
 * non-operator-gate state gets one, so the operator always knows what the
 * timer is currently doing without reading the raw steps list. The
 * sysprep_running copy is deliberately the LOUDEST here (Opus review MINOR
 * 15): Sysprep is the one irreversible point-of-no-return step in this
 * whole workflow (the golden-image runbook §4.7).
 */
function stateExplanation(state: ImageBuildState): { text: string; intent: 'info' | 'warning' } | undefined {
  switch (state) {
    case 'vm_creating':
      return { text: 'The build VM and its network interface are being created in Azure. This runs automatically.', intent: 'info' };
    case 'snapshotting':
      return { text: 'Snapshotting the build VM\'s OS disk before Sysprep runs — this is the rebuild starting point if anything goes wrong later. Runs automatically.', intent: 'info' };
    case 'sysprep_running':
      return {
        text: 'IRREVERSIBLE: Sysprep is running (or about to run) on the build VM. Once it completes, the VM is generalized and CANNOT be logged into or reused as a normal VM again — the only way back is the pre-Sysprep snapshot from the previous step. Do not manually interact with the build VM right now.',
        intent: 'warning',
      };
    case 'awaiting_stopped':
      return {
        text: 'HARD GATE: capture cannot proceed until the build VM is confirmed stopped or deallocated. The timer re-checks the VM\'s live power state every minute — this never trusts the last-known state, only a fresh read taken immediately before capture.',
        intent: 'warning',
      };
    case 'capturing':
      return { text: 'The build VM is being deallocated, generalized, and captured into the gallery as the new image version. This runs automatically.', intent: 'info' };
    case 'cleanup':
      return { text: 'Deleting the build VM, its network interface, and its OS disk now that capture has succeeded and the test host validated. This runs automatically.', intent: 'info' };
    default:
      return undefined;
  }
}

/** True only when every checklist item is explicitly ticked — derives from IMAGE_BUILD_CHECKLIST (the single source of truth), matching the server's own allRequiredChecklistItemsChecked exactly, rather than trusting whatever keys happen to be present on the checklist object (Opus review MINOR 15). */
function allChecked(build: ImageBuildDetail): boolean {
  return IMAGE_BUILD_CHECKLIST.every((item) => build.checklist[item.id] === true);
}

/**
 * AM-27 (M4-S2): golden image BUILD orchestration — start-build wizard,
 * recent-builds list, and the live build-detail view (checklist gate,
 * stepper, advance/cancel). Admin-only to mutate (RoleGate below); viewer+
 * can still see the current builds list/detail once one exists. Extracted
 * from the Images page's own component (rather than inlined there) so the
 * page itself stays a simple section-by-section composition — see
 * Images.tsx's own doc comment for where this fits among the page's other
 * sections (version timeline / rollout wizard / snapshot report).
 *
 * Self-contained: owns its own fetching/polling/state, same pattern as
 * RolloutWizard.tsx.
 */
export default function ImageBuildSection() {
  const styles = useStyles();
  const cardStyles = useCardStyles();
  const builds = usePolling((signal) => listImageBuilds(signal), BUILD_LIST_POLL_MS);

  const [selectedBuildId, setSelectedBuildId] = useState<string | undefined>(undefined);
  // AM-29 item 6: once the selected build reaches a terminal state
  // (done/failed/cancelled — see @avdmgr/shared's IMAGE_BUILD_TERMINAL_STATES),
  // there is nothing left for the 5s detail poll to ever observe changing —
  // stop it rather than polling a finished build forever. Reset to false
  // the moment a DIFFERENT build is selected (including immediately after
  // starting a new build below), so switching to a still-in-flight build
  // never inherits the previous selection's paused cadence.
  const [selectedBuildTerminal, setSelectedBuildTerminal] = useState(false);
  const selectedBuild = usePolling(
    (signal) => (selectedBuildId ? getImageBuild(selectedBuildId, signal) : Promise.resolve(undefined as unknown as ImageBuildDetail)),
    selectedBuildTerminal ? BUILD_DETAIL_TERMINAL_POLL_MS : BUILD_DETAIL_POLL_MS,
    [selectedBuildId],
  );

  // setSelectedBuildTerminal is deferred into a setTimeout(…, 0) callback,
  // not called synchronously in the effect body — same pattern (and same
  // reason) as AsyncState.tsx's own cold-start-hint timer: this repo's
  // react-hooks/set-state-in-effect lint rule flags a synchronous
  // `useEffect(() => setState(...), [dep])` body as the cascading-render
  // anti-pattern it exists to catch. The cleanup here cancels a
  // still-pending timeout if `selectedBuild.data.state` (or the busy/error
  // fields also read here indirectly via `selectedBuild`) changes again
  // before it fires, so a rapid sequence of polls never stacks multiple
  // stale updates.
  useEffect(() => {
    const nextTerminal = selectedBuild.data ? IMAGE_BUILD_TERMINAL_STATES.includes(selectedBuild.data.state) : false;
    if (nextTerminal === selectedBuildTerminal) {
      return;
    }
    const timer = window.setTimeout(() => setSelectedBuildTerminal(nextTerminal), 0);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deliberately keyed on `.state` alone, not the whole `selectedBuild.data` object, which gets a new reference every poll tick even when the state string itself hasn't changed (that would defeat the point of this effect: re-running it every 5s regardless of whether the build actually became terminal).
  }, [selectedBuild.data?.state, selectedBuildTerminal]);

  function selectBuild(buildId: string | undefined) {
    setSelectedBuildTerminal(false);
    setSelectedBuildId(buildId);
  }

  const RECENT_BUILDS_COLUMNS: DataTableColumn<ImageBuildSummary>[] = [
    { id: 'version', label: 'Version', renderCell: (build) => build.version },
    { id: 'state', label: 'State', renderCell: (build) => <StatusBadge label={build.state} tone={toneFor(build.state)} /> },
    { id: 'started', label: 'Started', renderCell: (build) => formatDateTime(build.createdAt) },
    { id: 'by', label: 'By', renderCell: (build) => build.createdBy },
    {
      // AM-29 item 15: was an unnamed `<TableHeaderCell> </TableHeaderCell>` (a lone space, not a real accessible name) — this column holds each row's "View" button.
      id: 'view',
      label: 'View build',
      visuallyHiddenHeader: true,
      renderCell: (build) => (
        <Button size="small" onClick={() => selectBuild(build.buildId)}>
          View
        </Button>
      ),
    },
  ];

  const [form, setForm] = useState<StartImageBuildRequest>({ version: '', adminUsername: '', vmSize: '' });
  const [dryRunPlan, setDryRunPlan] = useState<ImageBuildPlan | undefined>(undefined);
  const [previewError, setPreviewError] = useState<string | undefined>(undefined);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [showStartConfirm, setShowStartConfirm] = useState(false);
  const [startBusy, setStartBusy] = useState(false);
  const [startError, setStartError] = useState<string | undefined>(undefined);

  // Shown-once generated password — same "generate, show once, clear on
  // dismiss/unmount" contract as AddSessionHostPanel.tsx's registration
  // token dialog (Opus review MAJOR 5).
  const [generatedPassword, setGeneratedPassword] = useState<string | undefined>(undefined);
  const [passwordCopyMessage, setPasswordCopyMessage] = useState<string | undefined>(undefined);
  useEffect(() => {
    return () => setGeneratedPassword(undefined); // defense-in-depth: clear on unmount too, not just on explicit dismiss.
  }, []);

  const [showCancelConfirm, setShowCancelConfirm] = useState(false);
  const [cancelBusy, setCancelBusy] = useState(false);
  const [cancelError, setCancelError] = useState<string | undefined>(undefined);
  const [cleanupGuidance, setCleanupGuidance] = useState<string | undefined>(undefined);

  const [advanceBusy, setAdvanceBusy] = useState(false);
  const [advanceError, setAdvanceError] = useState<string | undefined>(undefined);
  const [checklistBusy, setChecklistBusy] = useState(false);
  const [checklistError, setChecklistError] = useState<string | undefined>(undefined);

  // AM-53 — pre-Sysprep snapshot deletion.
  const [showSnapshotDeleteConfirm, setShowSnapshotDeleteConfirm] = useState(false);
  const [snapshotDeleteBusy, setSnapshotDeleteBusy] = useState(false);
  const [snapshotDeleteError, setSnapshotDeleteError] = useState<string | undefined>(undefined);

  function requestBody(): StartImageBuildRequest {
    return { version: form.version.trim(), adminUsername: form.adminUsername.trim(), vmSize: form.vmSize?.trim() || undefined };
  }

  async function handlePreview() {
    setPreviewBusy(true);
    setPreviewError(undefined);
    try {
      const response = await startImageBuild(requestBody(), true);
      setDryRunPlan(response.plan);
    } catch (error) {
      setPreviewError(error instanceof ApiClientError ? error.message : 'Failed to preview the build plan.');
    } finally {
      setPreviewBusy(false);
    }
  }

  async function handleStart() {
    setStartBusy(true);
    setStartError(undefined);
    try {
      const response = await startImageBuild(requestBody(), false);
      setShowStartConfirm(false);
      setDryRunPlan(undefined);
      if (response.build) {
        selectBuild(response.build.buildId);
      }
      if (response.generatedAdminPassword) {
        setGeneratedPassword(response.generatedAdminPassword);
      }
      builds.refresh();
    } catch (error) {
      setStartError(error instanceof ApiClientError ? error.message : 'Failed to start the build.');
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

  async function handleToggleChecklistItem(itemId: string, checked: boolean) {
    if (!selectedBuildId) return;
    setChecklistBusy(true);
    setChecklistError(undefined);
    try {
      await updateImageBuildChecklist(selectedBuildId, { itemId, checked });
      selectedBuild.refresh();
    } catch (error) {
      setChecklistError(error instanceof ApiClientError ? error.message : 'Failed to update the checklist.');
    } finally {
      setChecklistBusy(false);
    }
  }

  async function handleAdvance() {
    if (!selectedBuildId) return;
    setAdvanceBusy(true);
    setAdvanceError(undefined);
    try {
      await advanceImageBuild(selectedBuildId);
      selectedBuild.refresh();
      builds.refresh();
    } catch (error) {
      setAdvanceError(error instanceof ApiClientError ? error.message : 'Failed to advance the build.');
    } finally {
      setAdvanceBusy(false);
    }
  }

  async function handleCancel(reason: string | undefined) {
    if (!selectedBuildId) return;
    setCancelBusy(true);
    setCancelError(undefined);
    try {
      const response = await cancelImageBuild(selectedBuildId, reason);
      setShowCancelConfirm(false);
      setCleanupGuidance(response.cleanupGuidance || undefined);
      selectedBuild.refresh();
      builds.refresh();
    } catch (error) {
      setCancelError(error instanceof ApiClientError ? error.message : 'Failed to cancel the build.');
    } finally {
      setCancelBusy(false);
    }
  }

  /** AM-53 — reason is mandatory (ConfirmModal severity 'high' already enforces this client-side; the server independently validates it too). */
  async function handleDeleteSnapshot(reason: string | undefined) {
    if (!selectedBuildId || !reason) return;
    setSnapshotDeleteBusy(true);
    setSnapshotDeleteError(undefined);
    try {
      await deleteImageBuildSnapshot(selectedBuildId, { reason });
      setShowSnapshotDeleteConfirm(false);
      selectedBuild.refresh();
    } catch (error) {
      setSnapshotDeleteError(error instanceof ApiClientError ? error.message : 'Failed to delete the snapshot.');
    } finally {
      setSnapshotDeleteBusy(false);
    }
  }

  const canStart = form.version.trim().length > 0 && form.adminUsername.trim().length > 0;

  return (
    <>
      <RoleGate allowed={['admin']} fallback={<MessageBar intent="info"><MessageBarBody>Building a new golden image version requires the admin role.</MessageBarBody></MessageBar>}>
        {!selectedBuildId && (
          <>
            <Card className={cardStyles.card}>
              <CardHeader
                header={<Text as="h2" size={400} weight="semibold">Start a new build</Text>}
                description="Runs the golden-image runbook procedure end to end: build VM, operator checklist, snapshot, Sysprep, capture, test host, cleanup. Only one build may run at a time."
              />
              <div className={styles.form}>
                <Field label="Target version" hint="major.minor.patch, e.g. 2.2.0 — must be greater than the current published version and must not already exist.">
                  <Input value={form.version} onChange={(_e, d) => setForm((f) => ({ ...f, version: d.value }))} placeholder="2.2.0" />
                </Field>
                <Field label="Build VM local admin username">
                  <Input value={form.adminUsername} onChange={(_e, d) => setForm((f) => ({ ...f, adminUsername: d.value }))} placeholder="ca.builder" />
                </Field>
                <Field label="VM size (optional)" hint="Defaults to a size sized for patching Windows + Office.">
                  <Input value={form.vmSize} onChange={(_e, d) => setForm((f) => ({ ...f, vmSize: d.value }))} placeholder="Standard_D4ads_v7" />
                </Field>
                <Text size={200}>
                  The build VM&apos;s local admin password is generated automatically and shown once when the build starts — this app never asks for or stores one.
                </Text>
                {previewError && (
                  <MessageBar intent="error"><MessageBarBody>{previewError}</MessageBarBody></MessageBar>
                )}
                <div className={styles.actions}>
                  <Button appearance="secondary" disabled={!canStart || previewBusy} onClick={handlePreview}>
                    {previewBusy ? 'Generating…' : 'Preview plan (dry run)'}
                  </Button>
                  <Button appearance="primary" disabled={!canStart} onClick={() => setShowStartConfirm(true)}>
                    Start build
                  </Button>
                </div>
                {/* AM-29 item 25: names which unmet condition is disabling the primary button, derived from the SAME booleans that compute canStart. */}
                {!canStart && (
                  <Text size={200} className={styles.hint}>
                    {form.version.trim().length === 0 && form.adminUsername.trim().length === 0
                      ? 'Enter a target version and a build VM local admin username to continue.'
                      : form.version.trim().length === 0
                        ? 'Enter a target version to continue.'
                        : 'Enter a build VM local admin username to continue.'}
                  </Text>
                )}
              </div>

              {dryRunPlan && (
                <div>
                  <Divider />
                  <Text weight="semibold">Dry-run plan — {dryRunPlan.steps.length} steps, zero mutations performed</Text>
                  {dryRunPlan.steps.map((step) => (
                    <div key={step.stepId} className={styles.planStep}>
                      <Text weight="semibold">{step.label}</Text>{' '}
                      {step.operatorGate ? <Badge appearance="tint" color="warning">operator gate</Badge> : <Badge appearance="tint" color="informative">{step.armCall}</Badge>}
                      <div>
                        <Text size={200}>{step.resource}</Text>
                      </div>
                      {!step.operatorGate && (
                        <details>
                          <summary>
                            <Text size={200}>Parameters</Text>
                          </summary>
                          {/* AM-29 item 24: tabIndex so a keyboard user can scroll this horizontally, matching Governance.tsx's scrollable <pre> pattern. */}
                          <pre className={styles.paramsBlock} tabIndex={0}>
                            {JSON.stringify(step.parameters, null, 2)}
                          </pre>
                        </details>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </Card>

            <Card className={cardStyles.card}>
              <CardHeader header={<Text as="h2" size={400} weight="semibold">Recent builds</Text>} />
              <AsyncState loading={builds.loading} error={builds.error} data={builds.data} isEmpty={(d) => d.builds.length === 0} emptyMessage="No builds yet.">
                {(data) => <DataTable ariaLabel="Recent builds" columns={RECENT_BUILDS_COLUMNS} rows={data.builds} getRowKey={(build) => build.buildId} emptyMessage="No builds yet." />}
              </AsyncState>
            </Card>
          </>
        )}

        {selectedBuildId && (
          <Card className={cardStyles.card}>
            <CardHeader
              header={<Text weight="semibold">Build detail</Text>}
              action={
                <Button
                  appearance="secondary"
                  onClick={() => {
                    selectBuild(undefined);
                    setCleanupGuidance(undefined);
                  }}
                >
                  Back to builds
                </Button>
              }
            />
            <AsyncState loading={selectedBuild.loading} error={selectedBuild.error} data={selectedBuild.data} emptyMessage="Build not found.">
              {(build) => {
                const explanation = stateExplanation(build.state);
                return (
                  <div>
                    <Text>
                      Version <strong>{build.version}</strong> — <StatusBadge label={build.state} tone={toneFor(build.state)} />
                    </Text>

                    {build.errorMessage && (
                      <MessageBar intent="error">
                        <MessageBarBody>
                          <MessageBarTitle>Build failed</MessageBarTitle>
                          {build.errorMessage}
                        </MessageBarBody>
                      </MessageBar>
                    )}

                    {build.abandonedWarning && (
                      <MessageBar intent="warning">
                        <MessageBarBody>
                          <MessageBarTitle>Possibly abandoned</MessageBarTitle>
                          {build.abandonedWarning}
                        </MessageBarBody>
                      </MessageBar>
                    )}

                    {explanation && (
                      <MessageBar intent={explanation.intent}>
                        <MessageBarBody>{explanation.text}</MessageBarBody>
                      </MessageBar>
                    )}

                    {cleanupGuidance && (
                      <MessageBar intent="warning">
                        <MessageBarBody>
                          <MessageBarTitle>Cancelled — manual cleanup</MessageBarTitle>
                          {cleanupGuidance}
                        </MessageBarBody>
                      </MessageBar>
                    )}

                    {/* AM-53 — pre-Sysprep snapshot retention, only shown once the build is done: snapshotStatus/snapshotDeletable are undefined for any earlier state (see @avdmgr/shared's ImageBuildDetail doc comments). */}
                    {build.state === 'done' && build.snapshotStatus && (
                      <div>
                        <Divider />
                        <div className={styles.actions}>
                          <Text weight="semibold">Pre-sysprep snapshot:</Text>
                          <Text>{build.snapshotName}</Text>
                          <StatusBadge label={build.snapshotStatus} tone={snapshotStatusTone(build.snapshotStatus)} />
                          {build.snapshotStatus === 'present' && (
                            <Tooltip content={build.snapshotDeletable ? 'Permanently delete this snapshot.' : build.snapshotDeleteBlockedReason ?? 'Deletion is not currently available.'} relationship="label">
                              <span tabIndex={build.snapshotDeletable ? undefined : 0}>
                                <Button size="small" appearance="secondary" disabled={!build.snapshotDeletable} onClick={() => setShowSnapshotDeleteConfirm(true)}>
                                  Delete snapshot
                                </Button>
                              </span>
                            </Tooltip>
                          )}
                        </div>
                        {build.snapshotDeleteSubmittedAt && (
                          <Text size={200} className={styles.hint}>
                            Delete submitted {formatDateTime(build.snapshotDeleteSubmittedAt)}.
                          </Text>
                        )}
                      </div>
                    )}

                    {build.state === 'checklist_gate' && (
                      <div>
                        <Divider />
                        <Text weight="semibold">Build-manual checklist — every item must be ticked before Sysprep runs</Text>
                        <Text block size={200}>
                          The build VM ({build.vmName}) is running and billing right now — advance or cancel this build once the checklist is complete; don&apos;t leave it parked here.
                        </Text>
                        {checklistError && (
                          <MessageBar intent="error">
                            <MessageBarBody>{checklistError}</MessageBarBody>
                          </MessageBar>
                        )}
                        <ImageBuildChecklist checklist={build.checklist} disabled={checklistBusy} onToggle={handleToggleChecklistItem} />
                      </div>
                    )}

                    {build.state === 'test_host_step' && (
                      <MessageBar intent="info">
                        <MessageBarBody>
                          Deploy a throwaway test session host from this version (generate a registration token from the Host Pool page) and validate it against docs/12-validation.md before advancing — advancing here deletes the build VM/NIC/disk.
                        </MessageBarBody>
                      </MessageBar>
                    )}

                    {advanceError && <MessageBar intent="error"><MessageBarBody>{advanceError}</MessageBarBody></MessageBar>}

                    <div className={styles.actions}>
                      {OPERATOR_GATED_IMAGE_BUILD_STATES.has(build.state) && (
                        <Button
                          appearance="primary"
                          disabled={advanceBusy || (build.state === 'checklist_gate' && !allChecked(build))}
                          onClick={handleAdvance}
                        >
                          {advanceBusy ? 'Working…' : build.state === 'checklist_gate' ? 'Advance to snapshotting' : 'Advance to cleanup'}
                        </Button>
                      )}
                      {build.state !== 'done' && build.state !== 'failed' && build.state !== 'cancelled' && build.state !== 'cleanup' && (
                        <Button appearance="secondary" onClick={() => setShowCancelConfirm(true)}>
                          Cancel build
                        </Button>
                      )}
                    </div>

                    <Divider />
                    <Text weight="semibold">Progress</Text>
                    <BuildStepper steps={build.steps} state={build.state} />
                    {/* AM-29 item 20 */}
                    <Text size={200} className={styles.hint}>
                      This runs server-side — you can close this page and come back.
                    </Text>
                  </div>
                );
              }}
            </AsyncState>
          </Card>
        )}
      </RoleGate>

      {/* AM-29 item 30: start image build is severity 'high' — typed target version + mandatory reason. */}
      {showStartConfirm && (
        <ConfirmModal
          title="Start image build"
          severity="high"
          confirmText={form.version.trim()}
          description="This creates a real, billable build VM in Azure and begins the golden-image build procedure. Type the target version to confirm."
          confirmLabel="Start build"
          busy={startBusy}
          error={startError}
          onConfirm={handleStart}
          onCancel={() => setShowStartConfirm(false)}
        />
      )}

      {generatedPassword && (
        <GeneratedPasswordDialog
          password={generatedPassword}
          copyMessage={passwordCopyMessage}
          styles={styles}
          onCopy={copyPassword}
          onDismissCopyMessage={() => setPasswordCopyMessage(undefined)}
          onDone={dismissPasswordDialog}
        />
      )}

      {/* AM-29 item 30: cancel build is severity 'medium' — a mandatory reason, no typed word. */}
      {showCancelConfirm && selectedBuild.data && (
        <ConfirmModal
          title="Cancel build"
          severity="medium"
          description="This stops the build state machine. It does NOT automatically delete any Azure resources already created — you will be shown exactly what still needs manual cleanup."
          confirmLabel="Cancel build"
          busy={cancelBusy}
          error={cancelError}
          onConfirm={(reason) => handleCancel(reason)}
          onCancel={() => setShowCancelConfirm(false)}
        />
      )}

      {/* AM-53 — permanent delete: severity 'high' (typed snapshot name + mandatory reason), same rubric tier as start-build. */}
      {showSnapshotDeleteConfirm && selectedBuild.data?.snapshotStatus === 'present' && (
        <ConfirmModal
          title="Delete pre-Sysprep snapshot"
          severity="high"
          confirmText={selectedBuild.data.snapshotName}
          description="This permanently deletes the pre-Sysprep snapshot in Azure. Type the snapshot name to confirm."
          impact={<ImpactPreview lines={[{ text: `${selectedBuild.data.snapshotName} will be permanently deleted from RG-AVD-Images.`, tone: 'warning' }, 'This is the rebuild starting point for this version — only delete once you no longer need it.']} />}
          confirmLabel="Delete snapshot"
          busy={snapshotDeleteBusy}
          error={snapshotDeleteError}
          onConfirm={handleDeleteSnapshot}
          onCancel={() => setShowSnapshotDeleteConfirm(false)}
        />
      )}
    </>
  );
}

/** Extracted so useDialogFocusRestore (AM-31 item 37) applies to this ad hoc `modalType="alert"` Dialog the same way it does to every ConfirmModal — the hook must run inside the dialog's OWN component so its mount/unmount lifecycle matches the dialog's open/close lifecycle, not ImageBuildSection's (which stays mounted for the whole Build tab). */
function GeneratedPasswordDialog({
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
    // modalType="alert": cannot be dismissed via Esc or overlay click — only
    // the explicit Done button below — so a shown-once credential can't be
    // lost to a stray keypress or misclick (same AM-22 pattern as
    // AddSessionHostPanel.tsx's registration-token dialog).
    <Dialog open modalType="alert">
      <DialogSurface>
        <DialogBody>
          <DialogTitle>Build VM admin password</DialogTitle>
          <DialogContent>
            <MessageBar intent="warning">
              <MessageBarBody>
                <MessageBarTitle>Shown once</MessageBarTitle>
                This password will not be shown again — copy it now if you need to sign into the build VM directly. This app never stores or logs it.
              </MessageBarBody>
            </MessageBar>
            <Textarea value={password} readOnly resize="none" rows={1} className={styles.passwordBox} aria-label="Build VM admin password" />
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

/**
 * AM-31 item 35 — adapts ImageBuildStepState[] to the shared Stepper
 * component (vertical orientation). This used to be TWO separate renderings
 * of the exact same step data: a live `<ol>` stepper (Opus review MINOR 15)
 * ABOVE a full StepsTable repeating the identical stepId/status/started/
 * completed info as a second, plain table — the duplicate table is deleted
 * outright rather than kept as a second view, since Stepper's per-step row
 * already carries everything StepsTable did: status, the live
 * elapsed-time-in-step while a step is actually running, AND (Opus peer
 * review MAJOR 1 — corrects this comment's own former false claim that the
 * live elapsed text alone covered this) a STATIC startedAt→completedAt
 * duration once a step is `done`, so a finished build's per-step timing
 * still survives the table's deletion instead of only ever being visible
 * while a step was live.
 *
 * "Current" is the first step that's actually IN PROGRESS, else the first
 * step that FAILED (see findCurrentIndex below: peer review nit 19 fix, a
 * failed step used to lose the "current" highlight/aria-current to whatever
 * LATER step was still sitting at 'pending' because the build never reached
 * it), else the first step still pending (build hasn't started yet), else
 * the last step if everything has succeeded/skipped (build genuinely
 * finished clean).
 */
function findCurrentIndex(steps: ImageBuildStepState[]): number {
  const inProgress = steps.findIndex((s) => s.status === 'in_progress');
  if (inProgress !== -1) return inProgress;
  // The step where the build actually stopped — a failed step must win the
  // "current" designation over any step AFTER it that never got a chance to
  // run and is therefore still sitting at 'pending'. (ImageBuildStepStatus
  // has no 'cancelled' member — that's a RolloutState-only concept; a
  // cancelled BUILD leaves its in-flight step's own status as whatever it
  // last reported, most often still 'in_progress' or 'pending'.)
  const stopped = steps.findIndex((s) => s.status === 'failed');
  if (stopped !== -1) return stopped;
  const pending = steps.findIndex((s) => s.status === 'pending');
  if (pending !== -1) return pending;
  return steps.length - 1;
}

function BuildStepper({ steps, state }: { steps: ImageBuildStepState[]; state: ImageBuildState }) {
  if (steps.length === 0) {
    return <Text>No steps recorded yet.</Text>;
  }
  const effectiveCurrentIndex = findCurrentIndex(steps);

  const stepperSteps: StepperStep[] = steps.map((step, index) => {
    const isCurrent = index === effectiveCurrentIndex && state !== 'done';
    return {
      id: step.stepId,
      label: IMAGE_BUILD_STEP_LABELS[step.stepId],
      state: isCurrent ? 'current' : stepperStateFor(step.status),
      tone: toneFor(step.status),
      statusLabel: step.status,
      startedAt: step.startedAt,
      completedAt: step.completedAt,
      hint: BUILD_STEP_DURATION_HINTS[step.stepId],
      // Only an actually in-flight, non-operator-gated step gets the
      // indeterminate progress bar — a step "current" only because it's
      // sitting at an operator gate (checklist_gate/test_host_step) is
      // waiting on a human, not running automatically.
      inFlight: isCurrent && step.status === 'in_progress',
      error: step.error,
    };
  });

  return <Stepper steps={stepperSteps} orientation="vertical" ariaLabel="Build progress" />;
}
