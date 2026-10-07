import { useMemo, useState } from 'react';
import {
  makeStyles,
  tokens,
  Card,
  CardHeader,
  Text,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  Checkbox,
  Button,
  Field,
  Input,
  Textarea,
  Dialog,
  DialogSurface,
  DialogBody,
  DialogTitle,
  DialogContent,
  DialogActions,
  Toast,
  ToastTitle,
  MessageBar,
  MessageBarBody,
  MessageBarTitle,
  MessageBarActions,
  Accordion,
  AccordionItem,
  AccordionHeader,
  AccordionPanel,
} from '@fluentui/react-components';
import type { RemoveRolloutHostFailure, RolloutNewHost, RolloutOldHost, RolloutPlanDetail, RolloutState } from '@avdmgr/shared';
import { Link } from 'react-router-dom';
import {
  cancelRollout,
  confirmCutover,
  createRolloutPlan,
  forceProceedRollout,
  listRolloutPlans,
  removeRolloutHosts,
  rollbackRollout,
  startRemoval,
  startRollout,
  verifyRolloutConfig,
} from '../api/rollout';
import { getSessionHosts } from '../api/avd';
import { ApiClientError } from '../api/client';
import { usePolling } from '../hooks/usePolling';
import AsyncState from '../components/AsyncState';
import StatusBadge from '../components/StatusBadge';
import ConfirmModal from '../components/ConfirmModal';
import ImpactPreview from '../components/ImpactPreview';
import AddSessionHostPanel from '../components/AddSessionHostPanel';
import RoleGate from '../components/RoleGate';
import TableScroll from '../components/TableScroll';
import DataTable, { type DataTableColumn } from '../components/DataTable';
import Stepper, { type StepperStep, type StepperStepState } from '../components/Stepper';
import { useDialogFocusRestore } from '../hooks/useDialogFocusRestore';
import { formatDateTime } from '../lib/format';
import { rollbackPreviewLines, rolloutRemoveHostsPreviewLines } from '../lib/impactPreview';
import { useCardStyles, useVisuallyHiddenStyles } from '../styles/shared';
import { useAppToast } from '../lib/toaster';

const POLL_INTERVAL_MS = 20_000;

/** Ordered so the stepper below always renders left-to-right in the happy-path sequence, regardless of which state the active plan is currently in. Terminal branches (rolled_back/cancelled) are rendered separately, not as steps on this line — see the stepper's render logic. */
const HAPPY_PATH_STATES: RolloutState[] = ['planned', 'draining_old', 'awaiting_new_hosts', 'validating_new', 'cutover', 'removing_old', 'done'];

const STATE_LABELS: Record<RolloutState, string> = {
  planned: 'Planned',
  draining_old: 'Draining old hosts',
  awaiting_new_hosts: 'Awaiting new hosts',
  validating_new: 'Validating new hosts',
  cutover: 'Cutover',
  removing_old: 'Removing old hosts',
  done: 'Done',
  rolled_back: 'Rolled back',
  cancelled: 'Cancelled',
};

/** AM-28 peer review item 14: 'removed' reads as a SUCCESSFUL, expected outcome of this flow, not a problem — tone 'ok' (success), never 'error'. AM-29 item 16: 'pending' (not yet started) gets the dedicated 'pending' tone rather than the former generic 'neutral'. */
const OLD_HOST_STATUS_TONE: Record<RolloutOldHost['status'], 'ok' | 'warning' | 'error' | 'info' | 'pending'> = {
  pending: 'pending',
  draining: 'warning',
  drained: 'ok',
  removed: 'ok',
  undrained_rollback: 'info',
};

const NEW_HOST_STATUS_TONE: Record<RolloutNewHost['status'], 'ok' | 'warning' | 'error' | 'info' | 'pending'> = {
  awaiting_registration: 'pending',
  registered: 'warning',
  available: 'ok',
  validated: 'ok',
};

/**
 * AM-49 — tone for the new-hosts table's "Power" column. 'running' is the
 * happy state; 'starting'/'stopping'/'deallocating' are in-flight
 * transitions (the muted 'pending' tone, same idiom StatusTone documents for
 * "something in-flight"); 'deallocated'/'stopped' get 'warning' — this is
 * exactly the state the AM-49 keep-alive pass watches for and restarts, so
 * it deserves to stand out, not read as a quiet/expected state; 'unknown'
 * (or the host never having been observed at all) gets the dedicated
 * 'unknown' tone, same as every other "we don't know" cell in this app.
 */
const POWER_STATE_TONE: Record<NonNullable<RolloutNewHost['powerState']>, 'ok' | 'warning' | 'pending' | 'unknown'> = {
  running: 'ok',
  starting: 'pending',
  stopping: 'pending',
  deallocating: 'pending',
  deallocated: 'warning',
  stopped: 'warning',
  unknown: 'unknown',
};

/** Peer review nit 23 — a type predicate lets callers that branch on the result (e.g. TERMINAL_STATE_TONE's index lookup below) narrow `state` to the three terminal RolloutStates without a separate `as 'done' | 'rolled_back' | 'cancelled'` cast at each call site. */
function isTerminal(state: RolloutState): state is 'done' | 'rolled_back' | 'cancelled' {
  return state === 'done' || state === 'rolled_back' || state === 'cancelled';
}

/** AM-31 item 41 — outcome tone for the "Previous rollouts" history list; every value here is one of the three RolloutStates isTerminal() above allows through. */
const TERMINAL_STATE_TONE: Record<'done' | 'rolled_back' | 'cancelled', 'ok' | 'warning' | 'info'> = {
  done: 'ok',
  rolled_back: 'warning',
  cancelled: 'info',
};

function parseNameList(raw: string): string[] {
  return [...new Set(raw.split(/[\n,]/).map((entry) => entry.trim()).filter((entry) => entry.length > 0))];
}

/** Client-side mirror of rolloutPlanService.ts#allNewHostsAvailableAndHealthy — used only to decide dialog copy/force flags; the server independently re-evaluates the same gate from its own current data, never this snapshot. */
function allNewHostsAvailableAndHealthy(newHosts: RolloutNewHost[]): boolean {
  return newHosts.length > 0 && newHosts.every((h) => (h.status === 'available' || h.status === 'validated') && h.healthy === true);
}

/** Client-side mirror of rolloutPlanService.ts#allNewHostsImageVerified (AM-28 peer review item 4). */
function allNewHostsImageVerified(newHosts: RolloutNewHost[]): boolean {
  return newHosts.length > 0 && newHosts.every((h) => h.imageVerified === true);
}

/** Client-side mirror of rolloutPlanService.ts#allNewHostsConfigVerified (AM-47 — the third cutover gate). */
function allNewHostsConfigVerified(newHosts: RolloutNewHost[]): boolean {
  return newHosts.length > 0 && newHosts.every((h) => h.configCheck?.status === 'passed');
}

const useStyles = makeStyles({
  page: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalL,
  },
  headerRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: tokens.spacingHorizontalM,
    flexWrap: 'wrap',
  },
  actionsRow: {
    display: 'flex',
    gap: tokens.spacingHorizontalS,
    flexWrap: 'wrap',
    marginTop: tokens.spacingVerticalM,
  },
  label: {
    color: tokens.colorNeutralForeground3,
  },
  propsGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
    gap: tokens.spacingVerticalM,
    marginBottom: tokens.spacingVerticalM,
  },
  formField: {
    marginBottom: tokens.spacingVerticalM,
  },
  sectionHeading: {
    marginTop: tokens.spacingVerticalL,
  },
  bannerSpacing: {
    marginTop: tokens.spacingVerticalM,
  },
  /** Renders react-router's Link with the same visual weight as a Fluent secondary Button, without nesting an <a> inside a Button's own <a> (see FluentLinkToSessions's doc comment). */
  sessionsLink: {
    display: 'inline-flex',
    alignItems: 'center',
    padding: `0 ${tokens.spacingHorizontalM}`,
    height: '32px',
    borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorNeutralStroke1}`,
    color: tokens.colorNeutralForeground1,
    textDecoration: 'none',
    fontSize: tokens.fontSizeBase300,
  },
});

/**
 * AM-28 (M4-S3): staged rollout + rollback wizard for the Images page.
 * Self-contained (own fetching, own dialogs) so it merges cleanly alongside
 * whatever image-definition/version listing AM-26 lands separately on this
 * same page — see Images.tsx for how the two sections are composed.
 *
 * Admin-only end to end: every mutating call this component makes is
 * admin-gated server-side (app/api/src/functions/rolloutPlans.ts); the whole
 * wizard is wrapped in RoleGate(['admin']) here as the UI-convenience mirror
 * of that (see RoleGate's doc comment — never the actual security boundary).
 */
export default function RolloutWizard({ hostPoolName }: { hostPoolName: string }) {
  return (
    <RoleGate allowed={['admin']} fallback={<AdminOnlyNotice />}>
      <RolloutWizardInner hostPoolName={hostPoolName} />
    </RoleGate>
  );
}

function AdminOnlyNotice() {
  const styles = useStyles();
  const cardStyles = useCardStyles();
  return (
    <Card className={cardStyles.card}>
      <CardHeader header={<Text as="h2" size={400} weight="semibold">Staged rollout</Text>} />
      <Text className={styles.label}>Ask an admin to run a staged image-version rollout.</Text>
    </Card>
  );
}

function RolloutWizardInner({ hostPoolName }: { hostPoolName: string }) {
  const styles = useStyles();
  const cardStyles = useCardStyles();
  const { dispatchToast } = useAppToast();

  const plans = usePolling((signal) => listRolloutPlans(hostPoolName, signal), POLL_INTERVAL_MS, [hostPoolName]);
  const activePlan = useMemo(() => plans.data?.plans.find((plan) => !isTerminal(plan.state)), [plans.data]);
  // AM-28 peer review item 8: the most recent TERMINAL plan (done/rolled_back/cancelled) — used
  // to render a full, persistent summary (not a one-line label) once a plan finishes, since the
  // component that WAS showing its live detail (ActivePlan) unmounts the instant it goes terminal.
  const lastPlan = useMemo(() => plans.data?.plans[0], [plans.data]);

  const [createOpen, setCreateOpen] = useState(false);

  function showSuccessToast(message: string) {
    dispatchToast(
      <Toast>
        <ToastTitle>{message}</ToastTitle>
      </Toast>,
      { intent: 'success' },
    );
  }

  return (
    <div className={styles.page}>
      <div className={styles.headerRow}>
        {/* AM-29 item 2: demoted from h2 to h3 — every CardHeader app-wide (including this file's own AdminOnlyNotice fallback above) is now a real h2, so this section title (RolloutWizardInner is embedded a level below Images.tsx's own h2-level CardHeaders) sits one level down to keep the page's heading outline strictly ordered. */}
        <Text as="h3" size={600} weight="semibold">
          Staged rollout
        </Text>
        {!activePlan && (
          <Button appearance="primary" onClick={() => setCreateOpen(true)}>
            Start new rollout
          </Button>
        )}
      </div>

      <Card className={cardStyles.card}>
        <AsyncState loading={plans.loading} error={plans.error as Error | undefined} data={plans.data}>
          {(data) => (
            <>
              {activePlan ? (
                <ActivePlan hostPoolName={hostPoolName} plan={activePlan} onRefresh={plans.refresh} onSuccessToast={showSuccessToast} />
              ) : lastPlan ? (
                <TerminalPlanSummary plan={lastPlan} />
              ) : (
                <Text className={styles.label}>No rollout has been run yet.</Text>
              )}
              {/* Peer review MINOR fix: this wizard only ever renders the
                  active or single most-recent plan (never used for older
                  history), so `truncated` cannot affect what's shown above —
                  but leaving the server's own 25-most-recent-plans cap
                  entirely unmentioned when it HAS been hit is still
                  misleading for an operator who might reasonably expect a
                  fuller history to exist somewhere in this app. Cheapest
                  honest option: a small inline caveat, not a full
                  history-browser feature (out of scope for this hardening
                  milestone). */}
              {data.truncated && (
                <Text size={200} className={styles.label}>
                  Older rollout plan history exists beyond the most recent 25 for this host pool and isn't shown here.
                </Text>
              )}
            </>
          )}
        </AsyncState>
      </Card>

      {/* AM-31 item 41 — every terminal plan the API returned OTHER than the one already shown above (as ActivePlan's most-recent predecessor context, or as TerminalPlanSummary itself) — the list endpoint already returns up to 25 most-recent plans (see `truncated` above); this wizard just wasn't surfacing anything past the single newest one until now. */}
      {plans.data && <PreviousRolloutsSection plans={plans.data.plans} excludeId={(activePlan ?? lastPlan)?.id} />}

      {createOpen && (
        <CreatePlanDialog
          hostPoolName={hostPoolName}
          onClose={() => setCreateOpen(false)}
          onCreated={() => {
            setCreateOpen(false);
            showSuccessToast('Rollout plan created.');
            plans.refresh();
          }}
        />
      )}
    </div>
  );
}

const PREVIOUS_ROLLOUTS_COLUMNS: DataTableColumn<RolloutPlanDetail>[] = [
  { id: 'targetVersion', label: 'Target version', renderCell: (plan) => plan.targetImageVersion },
  {
    id: 'outcome',
    label: 'Outcome',
    renderCell: (plan) => <StatusBadge label={STATE_LABELS[plan.state]} tone={isTerminal(plan.state) ? TERMINAL_STATE_TONE[plan.state] : 'info'} />,
  },
  { id: 'created', label: 'Created', renderCell: (plan) => formatDateTime(plan.createdAt) },
  { id: 'createdBy', label: 'Created by', renderCell: (plan) => plan.createdBy },
  { id: 'completed', label: 'Completed', renderCell: (plan) => formatDateTime(plan.completedAt ?? plan.cancelledAt ?? plan.rollbackAt) },
  { id: 'reason', label: 'Reason', renderCell: (plan) => plan.reason },
];

/**
 * AM-31 item 41 — collapsed "Previous rollouts" section: every TERMINAL plan
 * the list endpoint returned other than `excludeId` (the plan already shown
 * in full detail above, active or most-recent-terminal). Collapsed by
 * default (Fluent Accordion) — this is history, not something an operator
 * needs open by default on every page load.
 */
function PreviousRolloutsSection({ plans, excludeId }: { plans: RolloutPlanDetail[]; excludeId: string | undefined }) {
  const cardStyles = useCardStyles();
  const previous = plans.filter((plan) => plan.id !== excludeId && isTerminal(plan.state));
  if (previous.length === 0) return null;

  return (
    <Card className={cardStyles.card}>
      <Accordion collapsible>
        <AccordionItem value="previous-rollouts">
          <AccordionHeader>
            <Text weight="semibold">Previous rollouts ({previous.length})</Text>
          </AccordionHeader>
          <AccordionPanel>
            <DataTable
              ariaLabel="Previous rollouts"
              columns={PREVIOUS_ROLLOUTS_COLUMNS}
              rows={previous}
              getRowKey={(plan) => plan.id}
              emptyMessage="No previous rollouts."
            />
          </AccordionPanel>
        </AccordionItem>
      </Accordion>
    </Card>
  );
}

/**
 * Creates a NEW plan (state 'planned' — nothing is drained yet). Not built
 * on ConfirmModal (that component is typed-name-confirm ONLY, no room for
 * this form's several fields) — instead the typed-name confirm IS one of
 * this dialog's own fields (must match hostPoolName exactly to enable
 * Create), same "type the resource name" friction ConfirmModal uses
 * elsewhere in this app, just inlined alongside the rest of the form.
 */
function CreatePlanDialog({ hostPoolName, onClose, onCreated }: { hostPoolName: string; onClose: () => void; onCreated: () => void }) {
  useDialogFocusRestore();
  const styles = useStyles();
  const sessionHosts = usePolling((signal) => getSessionHosts(hostPoolName, signal), 300_000, [hostPoolName]);

  const [targetImageVersion, setTargetImageVersion] = useState('');
  const [selectedOldHosts, setSelectedOldHosts] = useState<Set<string>>(new Set());
  const [newHostNamesRaw, setNewHostNamesRaw] = useState('');
  const [reason, setReason] = useState('');
  const [confirmName, setConfirmName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  function toggleOldHost(name: string) {
    setSelectedOldHosts((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  const oldHostNames = [...selectedOldHosts];
  const newHostNames = parseNameList(newHostNamesRaw);
  const canSubmit = targetImageVersion.trim().length > 0 && oldHostNames.length > 0 && newHostNames.length > 0 && reason.trim().length > 0 && confirmName === hostPoolName && !busy;

  async function submit() {
    if (!canSubmit) return;
    setBusy(true);
    setError(undefined);
    try {
      await createRolloutPlan(hostPoolName, { targetImageVersion: targetImageVersion.trim(), oldHostNames, newHostNames, reason: reason.trim() });
      onCreated();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Failed to create the rollout plan.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(_event, data) => !data.open && !busy && onClose()}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>Start a staged rollout — {hostPoolName}</DialogTitle>
          <DialogContent>
            <Text as="p" block>
              Creates a plan only — nothing is drained yet. Draining starts on the next screen once you review and confirm.
            </Text>
            {error && (
              <MessageBar intent="error">
                <MessageBarBody>{error}</MessageBarBody>
              </MessageBar>
            )}
            <Field label="Target image version" className={styles.formField}>
              <Input value={targetImageVersion} onChange={(_e, d) => setTargetImageVersion(d.value)} placeholder="e.g. 3.0.0" disabled={busy} />
            </Field>
            <Field label="Existing hosts to retire" className={styles.formField}>
              <AsyncState loading={sessionHosts.loading} error={sessionHosts.error as Error | undefined} data={sessionHosts.data} isEmpty={(d) => d.length === 0} emptyMessage="No session hosts found.">
                {(hosts) => (
                  <div>
                    {hosts.map((host) => (
                      <Checkbox
                        key={host.id}
                        label={host.name}
                        checked={selectedOldHosts.has(host.name)}
                        onChange={() => toggleOldHost(host.name)}
                        disabled={busy}
                      />
                    ))}
                  </div>
                )}
              </AsyncState>
            </Field>
            <Field label="Expected new host names (comma or newline separated)" className={styles.formField}>
              <Textarea value={newHostNamesRaw} onChange={(_e, d) => setNewHostNamesRaw(d.value)} placeholder="avd-con-1, avd-con-2" disabled={busy} resize="vertical" />
              <Text size={200} className={styles.label}>
                These do not need to exist yet — provision them via the guided Add session host flow after starting the plan. The timer watches for these exact names to register.
              </Text>
            </Field>
            <Field label="Reason (required)" className={styles.formField}>
              <Textarea value={reason} onChange={(_e, d) => setReason(d.value)} disabled={busy} resize="vertical" />
            </Field>
            <Field label={<>Type <strong>{hostPoolName}</strong> to confirm.</>} className={styles.formField}>
              <Input value={confirmName} onChange={(_e, d) => setConfirmName(d.value)} placeholder={hostPoolName} autoComplete="off" disabled={busy} />
            </Field>
            {/* AM-29 item 25: names which unmet condition is disabling "Create plan", derived from the same booleans as canSubmit. */}
            {!canSubmit && !busy && (
              <Text size={200} className={styles.label}>
                Still needed:{' '}
                {[
                  targetImageVersion.trim().length === 0 && 'a target image version',
                  oldHostNames.length === 0 && 'at least one host to retire',
                  newHostNames.length === 0 && 'at least one expected new host name',
                  reason.trim().length === 0 && 'a reason',
                  confirmName !== hostPoolName && `the host pool name typed exactly as "${hostPoolName}"`,
                ]
                  .filter((part): part is string => Boolean(part))
                  .join(', ')}
                .
              </Text>
            )}
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button appearance="primary" onClick={() => void submit()} disabled={!canSubmit}>
              {busy ? 'Creating…' : 'Create plan'}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

/**
 * Peer review MAJOR 4 — the two per-phase instants this plan actually
 * records (RolloutPlanDetail has no dedicated "phase entered" timestamp for
 * every state — see that interface's own doc comments): `createdAt` marks
 * the start of 'planned', `cutoverAt` the start of 'cutover'. Deliberately
 * does NOT fall back to `updatedAt` for the other happy-path states —
 * rolloutPlanTimer.ts bumps `updatedAt` on every timer tick regardless of
 * whether the state actually changed, so it would reset the "elapsed in
 * step" clock every poll instead of reflecting when the phase truly began.
 */
const ROLLOUT_STEP_STARTED_AT: Partial<Record<RolloutState, (plan: RolloutPlanDetail) => string | undefined>> = {
  planned: (plan) => plan.createdAt,
  cutover: (plan) => plan.cutoverAt,
};

/** Peer review MAJOR 4 — states the timer progresses automatically (draining/registration/health checks all self-monitor server-side, per this file's own "This runs server-side" copy) get the same indeterminate `inFlight` treatment ImageBuildSection's automatic steps do. 'planned' and 'cutover' are excluded — both wait on an explicit operator click ("Start draining" / "Start removal") to advance, same as ImageBuildSection's operator-gated states; 'removing_old' is excluded too — it advances via the operator selecting and removing specific hosts, not purely automatic monitoring. */
const ROLLOUT_AUTOMATIC_STATES = new Set<RolloutState>(['draining_old', 'awaiting_new_hosts', 'validating_new']);

/**
 * AM-31 item 35 — adapts RolloutState to the shared Stepper component
 * (previously a bespoke pill list here, hand-duplicated with
 * ImageBuildSection.tsx's own separate stepper). A rolled-back/cancelled
 * plan renders as a single terminal step with its own tone (matching this
 * component's original special-cased behavior — a rolled-back/cancelled
 * plan is not "positioned" anywhere along the happy path, so showing the
 * whole path with one step highlighted would be misleading).
 *
 * Peer review MAJOR 4 — takes the full plan (not just its `state`) so the
 * current step can be wired with `startedAt`/`inFlight` the same way
 * ImageBuildSection's Stepper steps already are — see
 * ROLLOUT_STEP_STARTED_AT/ROLLOUT_AUTOMATIC_STATES above for exactly what's
 * derivable and why the rest is deliberately left unset rather than
 * guessed.
 */
function RolloutStepper({ plan }: { plan: RolloutPlanDetail }) {
  const { state } = plan;
  if (state === 'rolled_back' || state === 'cancelled') {
    const steps: StepperStep[] = [{ id: state, label: STATE_LABELS[state], state: 'current', tone: state === 'rolled_back' ? 'warning' : 'info' }];
    return <Stepper steps={steps} ariaLabel="Rollout progress" />;
  }
  const currentIndex = HAPPY_PATH_STATES.indexOf(state);
  const steps: StepperStep[] = HAPPY_PATH_STATES.map((step, index) => {
    const stepState: StepperStepState = index === currentIndex ? 'current' : index < currentIndex ? 'done' : 'upcoming';
    const isCurrent = stepState === 'current';
    return {
      id: step,
      label: STATE_LABELS[step],
      state: stepState,
      startedAt: isCurrent ? ROLLOUT_STEP_STARTED_AT[step]?.(plan) : undefined,
      inFlight: isCurrent && ROLLOUT_AUTOMATIC_STATES.has(step),
    };
  });
  return <Stepper steps={steps} ariaLabel="Rollout progress" />;
}

/** Target version / created-by / reason summary grid — shared by the live (ActivePlan) and terminal (TerminalPlanSummary) views. */
function PlanOverview({ plan }: { plan: RolloutPlanDetail }) {
  const styles = useStyles();
  return (
    <div className={styles.propsGrid}>
      <div>
        <Text block className={styles.label}>
          Target version
        </Text>
        <Text>{plan.targetImageVersion}</Text>
      </div>
      <div>
        <Text block className={styles.label}>
          Created by
        </Text>
        <Text>
          {plan.createdBy} — {formatDateTime(plan.createdAt)}
        </Text>
      </div>
      <div>
        <Text block className={styles.label}>
          Reason
        </Text>
        <Text>{plan.reason}</Text>
      </div>
    </div>
  );
}

/**
 * AM-35 (item 44) DOCUMENTED SKIP: OldHostsTable (below) and NewHostsTable
 * (further down) deliberately stay on the bare Fluent Table primitive rather
 * than migrating onto DataTable. OldHostsTable's `selectable` mode renders a
 * per-row Checkbox bound to a Set<string> selection the CALLER owns
 * (RemoveHostsDialog's `selected`/`onToggle`) — a row-SELECTION column, not
 * a row-action slot DataTable's `rowActions` already covers. No other table
 * in this app (migrated or otherwise) needs multi-row selection, so adding
 * a `rowSelection` concept to DataTable's shared API for this one caller
 * would grow that component's surface for a single, narrow use rather than
 * generalizing a pattern this codebase actually repeats. NewHostsTable has
 * no such requirement itself, but is kept alongside OldHostsTable for the
 * same visual/structural symmetry (both render inside RemovalStep/
 * CutoverStep side by side) rather than migrating just one of the pair.
 */
interface OldHostsTableProps {
  hosts: RolloutOldHost[];
  selectable?: boolean;
  selected?: Set<string>;
  onToggle?: (name: string) => void;
}

function OldHostsTable({ hosts, selectable = false, selected, onToggle }: OldHostsTableProps) {
  const styles = useStyles();
  const visuallyHiddenStyles = useVisuallyHiddenStyles();
  return (
    <>
      <Text weight="semibold" block className={styles.sectionHeading}>
        Old hosts (being retired)
      </Text>
      <TableScroll ariaLabel="Old hosts">
      <Table>
        <TableHeader>
          <TableRow>
            {selectable && (
              <TableHeaderCell>
                <span className={visuallyHiddenStyles.visuallyHidden}>Select for removal</span>
              </TableHeaderCell>
            )}
            <TableHeaderCell>Host</TableHeaderCell>
            <TableHeaderCell>Status</TableHeaderCell>
            <TableHeaderCell>Last observed sessions</TableHeaderCell>
          </TableRow>
        </TableHeader>
        <TableBody>
          {hosts.map((host) => (
            <TableRow key={host.sessionHostName}>
              {selectable && (
                <TableCell>
                  <Checkbox
                    checked={selected?.has(host.sessionHostName) ?? false}
                    onChange={() => onToggle?.(host.sessionHostName)}
                    disabled={host.status === 'removed'}
                    aria-label={`Select ${host.sessionHostName} for removal`}
                  />
                </TableCell>
              )}
              <TableCell>{host.sessionHostName}</TableCell>
              <TableCell>
                <StatusBadge label={host.status} tone={OLD_HOST_STATUS_TONE[host.status]} />
              </TableCell>
              <TableCell>{host.lastObservedSessions ?? '—'}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      </TableScroll>
    </>
  );
}

/** AM-47: tri-state "Config" cell for a new host's FSLogix config-convergence check — follows the imageVerified column's plain-text tri-state idiom (no StatusBadge — matching that column's own precedent) rather than introducing a new cell style for a single column. */
function ConfigCheckCell({ host }: { host: RolloutNewHost }) {
  switch (host.configCheck?.status) {
    case undefined:
      return <>—</>;
    case 'in_progress':
      return <>Checking…</>;
    case 'passed':
      return <>Yes</>;
    case 'failed':
      return <>No</>;
    case 'error':
      return <>Error</>;
  }
}

/**
 * AM-49 — one new host's "Power" cell: a StatusBadge for `powerState ??
 * 'unknown'` (same fallback convention as pages/HostPool.tsx's own power
 * state column), plus a subtle secondary line once this host has needed at
 * least one automatic restart — an operator glancing at the table should be
 * able to tell "this host keeps getting deallocated" without opening the
 * audit log.
 */
function PowerStateCell({ host }: { host: RolloutNewHost }) {
  const styles = useStyles();
  const powerState = host.powerState ?? 'unknown';
  return (
    <>
      <StatusBadge label={powerState} tone={POWER_STATE_TONE[powerState]} />
      {(host.keepAliveRestartCount ?? 0) > 0 && (
        <Text size={200} block className={styles.label}>
          auto-restarted ×{host.keepAliveRestartCount}
        </Text>
      )}
    </>
  );
}

/** AM-28 peer review item 4 / AM-47: includes "Image verified" and "Config" columns reflecting whether each new host's VM was confirmed to match the plan's targetImageVersion and passed the FSLogix config-convergence check, respectively. AM-49: adds the "Power" column (see PowerStateCell). */
function NewHostsTable({ hosts }: { hosts: RolloutNewHost[] }) {
  const styles = useStyles();
  return (
    <>
      <Text weight="semibold" block className={styles.sectionHeading}>
        New hosts (target version)
      </Text>
      <TableScroll ariaLabel="New hosts">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHeaderCell>Host</TableHeaderCell>
            <TableHeaderCell>Status</TableHeaderCell>
            <TableHeaderCell>AVD status</TableHeaderCell>
            <TableHeaderCell>Healthy</TableHeaderCell>
            <TableHeaderCell>Image verified</TableHeaderCell>
            <TableHeaderCell>Config</TableHeaderCell>
            <TableHeaderCell>Power</TableHeaderCell>
          </TableRow>
        </TableHeader>
        <TableBody>
          {hosts.map((host) => (
            <TableRow key={host.sessionHostName}>
              <TableCell>{host.sessionHostName}</TableCell>
              <TableCell>
                <StatusBadge label={host.status} tone={NEW_HOST_STATUS_TONE[host.status]} />
              </TableCell>
              <TableCell>{host.lastObservedStatus ?? 'Not yet seen'}</TableCell>
              <TableCell>{host.healthy === undefined ? '—' : host.healthy ? 'Yes' : 'No'}</TableCell>
              <TableCell>{host.imageVerified === undefined ? '—' : host.imageVerified ? 'Yes' : 'No'}</TableCell>
              <TableCell>
                <ConfigCheckCell host={host} />
              </TableCell>
              <TableCell>
                <PowerStateCell host={host} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      </TableScroll>
    </>
  );
}

/**
 * AM-47 — surfaces the config-convergence gate's diff/error detail beneath
 * NewHostsTable: one warning MessageBar per host whose check 'failed'
 * (listing each diverged key as `key: expected "X", host has "Y"`, `actual:
 * null` rendered as "missing" — see @avdmgr/shared's RolloutConfigDiff doc
 * comment for why that distinction matters), and one error MessageBar per
 * host whose check hit 'error' (showing the stored generic message — see
 * RolloutNewHost.configCheck's doc comment for why that string is always
 * pre-sanitized, never raw ARM text). Mirrors the removeHostsFailures
 * MessageBar precedent in ActivePlan below. Renders nothing if no host has
 * a 'failed'/'error' configCheck.
 */
function ConfigCheckDiffs({ hosts }: { hosts: RolloutNewHost[] }) {
  const styles = useStyles();
  const failed = hosts.filter((h) => h.configCheck?.status === 'failed');
  const errored = hosts.filter((h) => h.configCheck?.status === 'error');
  if (failed.length === 0 && errored.length === 0) {
    return null;
  }
  return (
    <>
      {failed.map((host) => (
        <MessageBar key={host.sessionHostName} intent="warning" className={styles.bannerSpacing}>
          <MessageBarBody>
            <MessageBarTitle>{host.sessionHostName}: FSLogix config does not match the baseline</MessageBarTitle>
            {(host.configCheck?.diffs ?? []).map((diff) => (
              <div key={diff.key}>
                {diff.key}: expected &quot;{diff.expected}&quot;, host has {diff.actual === null ? 'missing' : `"${diff.actual}"`}
              </div>
            ))}
          </MessageBarBody>
        </MessageBar>
      ))}
      {errored.map((host) => (
        <MessageBar key={host.sessionHostName} intent="error" className={styles.bannerSpacing}>
          <MessageBarBody>
            <MessageBarTitle>{host.sessionHostName}: config check failed</MessageBarTitle>
            {host.configCheck?.error ?? 'The config check could not be completed.'}
          </MessageBarBody>
        </MessageBar>
      ))}
    </>
  );
}

/**
 * AM-49 — one warning MessageBar per new host whose `keepAliveError` is set
 * (either the restart-cap message, or a submit/resolve failure — see
 * @avdmgr/shared's RolloutNewHost.keepAliveError doc comment). Mirrors the
 * ConfigCheckDiffs/removeHostsFailures MessageBar precedent above. Renders
 * nothing if no host currently has a keepAliveError.
 */
function KeepAliveWarnings({ hosts }: { hosts: RolloutNewHost[] }) {
  const styles = useStyles();
  const affected = hosts.filter((h) => h.keepAliveError);
  if (affected.length === 0) {
    return null;
  }
  return (
    <MessageBar intent="warning" className={styles.bannerSpacing}>
      <MessageBarBody>
        <MessageBarTitle>Automatic restart needs attention</MessageBarTitle>
        {affected.map((host) => (
          <div key={host.sessionHostName}>
            {host.sessionHostName}: {host.keepAliveError}
          </div>
        ))}
      </MessageBarBody>
    </MessageBar>
  );
}

/**
 * Renders every rollback-related "what still needs a human" banner
 * explicitly (AM-28 peer review items 5 and 8) — hosts needing a guided
 * re-add, new hosts drained as part of rollback, and any host where the
 * automatic un-drain/drain itself failed. Renders nothing if the plan was
 * never rolled back (all four RolloutPlanDetail fields are undefined/empty
 * in that case).
 */
function RollbackGuidance({ plan }: { plan: RolloutPlanDetail }) {
  const styles = useStyles();
  const needsReadd = plan.rollbackNeedsReadd ?? [];
  const drainedNewHosts = plan.rollbackDrainedNewHosts ?? [];
  const undrainFailures = plan.rollbackUndrainFailures ?? [];
  const newHostDrainFailures = plan.rollbackNewHostDrainFailures ?? [];
  if (needsReadd.length === 0 && drainedNewHosts.length === 0 && undrainFailures.length === 0 && newHostDrainFailures.length === 0) {
    return null;
  }
  return (
    <>
      {needsReadd.length > 0 && (
        <MessageBar intent="warning" className={styles.bannerSpacing}>
          <MessageBarBody>
            <MessageBarTitle>Guided re-add needed</MessageBarTitle>
            These hosts were already removed before rollback and cannot be un-drained — re-provision them on the prior image
            version via the guided Add session host flow: {needsReadd.join(', ')}.
          </MessageBarBody>
        </MessageBar>
      )}
      {drainedNewHosts.length > 0 && (
        <MessageBar intent="info" className={styles.bannerSpacing}>
          <MessageBarBody>
            <MessageBarTitle>New hosts drained</MessageBarTitle>
            Rollback also drained these vNext hosts so they stop accepting sessions: {drainedNewHosts.join(', ')}. Un-drain
            them manually via the HostPool page if you want them to keep serving on the abandoned version.
          </MessageBarBody>
        </MessageBar>
      )}
      {(undrainFailures.length > 0 || newHostDrainFailures.length > 0) && (
        <MessageBar intent="error" className={styles.bannerSpacing}>
          <MessageBarBody>
            <MessageBarTitle>Manual fix-up needed</MessageBarTitle>
            {undrainFailures.length > 0 && <>Un-draining failed for: {undrainFailures.join(', ')}. </>}
            {newHostDrainFailures.length > 0 && <>Draining failed for: {newHostDrainFailures.join(', ')}. </>}
            Fix these manually via the HostPool page's drain toggle.
          </MessageBarBody>
        </MessageBar>
      )}
    </>
  );
}

/**
 * AM-28 peer review item 8: a full, persistent, read-only summary for the
 * MOST RECENT plan once it reaches a terminal state (done/rolled_back/
 * cancelled) — the component that showed its live detail (ActivePlan)
 * unmounts the instant a plan goes terminal (RolloutWizardInner's activePlan
 * lookup excludes terminal states), so without this, rollback's
 * needsReadd/drainedNewHosts/undrainFailures guidance would be shown for
 * only the single render before that refetch, then vanish — exactly the bug
 * this component fixes.
 */
function TerminalPlanSummary({ plan }: { plan: RolloutPlanDetail }) {
  return (
    <div>
      {/* AM-29 item 2: demoted from h3 to h4, following the section title's own h2→h3 demotion above. */}
      <Text as="h4" size={500} weight="semibold" block>
        {STATE_LABELS[plan.state]}
      </Text>
      <PlanOverview plan={plan} />
      <RolloutStepper plan={plan} />
      <RollbackGuidance plan={plan} />
      <OldHostsTable hosts={plan.oldHosts} />
      <NewHostsTable hosts={plan.newHosts} />
      <ConfigCheckDiffs hosts={plan.newHosts} />
      <KeepAliveWarnings hosts={plan.newHosts} />
    </div>
  );
}

interface ActivePlanProps {
  hostPoolName: string;
  plan: RolloutPlanDetail;
  onRefresh: () => void;
  /** AM-29 item D: transient successes go to a toast now — the persistent per-host failure MessageBar (removeHostsFailures, below) is unaffected and stays a MessageBar. */
  onSuccessToast: (message: string) => void;
}

type ConfirmAction = 'start' | 'force-proceed' | 'cutover' | 'start-removal' | 'remove-hosts' | 'rollback' | 'cancel';

/**
 * Renders the current plan's stepper, per-host tables, and whichever
 * action(s) are valid for its CURRENT state (see
 * app/api/src/services/rolloutPlanService.ts's canTransition graph — this
 * component only offers actions the server would actually accept; the
 * server independently re-validates regardless, same "UI convenience only"
 * posture as every RoleGate use in this app).
 */
function ActivePlan({ hostPoolName, plan, onRefresh, onSuccessToast }: ActivePlanProps) {
  const styles = useStyles();
  const [confirmAction, setConfirmAction] = useState<ConfirmAction | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [selectedForRemoval, setSelectedForRemoval] = useState<Set<string>>(new Set());
  const [addHostPanelOpen, setAddHostPanelOpen] = useState(false);
  const [removeHostsFailures, setRemoveHostsFailures] = useState<RemoveRolloutHostFailure[] | undefined>(undefined);
  // AM-47: "Verify configuration" is a direct action (no confirm dialog — it only submits a read-only
  // registry check, nothing destructive), so it tracks its own busy/error state rather than reusing
  // `busy`/`error` above, which are scoped to the confirm-dialog flows.
  const [verifyConfigBusy, setVerifyConfigBusy] = useState(false);
  const [verifyConfigError, setVerifyConfigError] = useState<string | undefined>(undefined);
  // AM-28 peer review item 14: while a confirm dialog is open, the read-only
  // display (stepper/tables) is FROZEN to the plan as it looked the moment
  // the dialog opened, rather than jumping around under the operator's
  // cursor if the background poll refreshes mid-decision. The live `plan`
  // prop keeps updating in the background as normal (this does not pause
  // the network poll itself) — only what's RENDERED is held steady.
  const [dialogPlanSnapshot, setDialogPlanSnapshot] = useState<RolloutPlanDetail | undefined>(undefined);
  const displayPlan = dialogPlanSnapshot ?? plan;

  const allHostsAvailableHealthy = allNewHostsAvailableAndHealthy(displayPlan.newHosts);
  const allHostsImageVerified = allNewHostsImageVerified(displayPlan.newHosts);
  const allHostsConfigVerified = allNewHostsConfigVerified(displayPlan.newHosts);
  const allNewHostsReady = allHostsAvailableHealthy && allHostsImageVerified && allHostsConfigVerified;
  // AM-47: "Verify configuration" is disabled while any host's check is still running — re-submitting
  // mid-run would just overwrite the in-flight Run Command with an identical one, and disabling avoids
  // an operator mistaking a second click for "check faster".
  const anyConfigCheckInProgress = displayPlan.newHosts.some((h) => h.configCheck?.status === 'in_progress');

  function toggleRemoval(name: string) {
    setSelectedForRemoval((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  function openConfirm(action: ConfirmAction) {
    setDialogPlanSnapshot(plan);
    setConfirmAction(action);
    setError(undefined);
    setRemoveHostsFailures(undefined);
  }

  function closeConfirm() {
    if (busy) return;
    setConfirmAction(undefined);
    setDialogPlanSnapshot(undefined);
    setError(undefined);
  }

  /**
   * Runs a mutating action's request, on success closing the open confirm
   * dialog, surfacing a page-level success message, and refetching the plan
   * — on failure, leaving the dialog open with the error shown inside it
   * (same "error inside the still-open dialog" rationale as HostPool.tsx's
   * confirmDrainToggle). Returns whether it succeeded so callers with
   * additional post-success-only cleanup (e.g. remove-hosts clearing its
   * selection) don't run that cleanup on a failed attempt — this function
   * itself never throws/rejects, so a caller chaining `.then()` off its
   * returned promise would otherwise fire on failure too.
   */
  async function run(work: () => Promise<unknown>, successMessage: string): Promise<boolean> {
    setBusy(true);
    setError(undefined);
    try {
      await work();
      setConfirmAction(undefined);
      setDialogPlanSnapshot(undefined);
      onSuccessToast(successMessage);
      onRefresh();
      return true;
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'The action failed.');
      return false;
    } finally {
      setBusy(false);
    }
  }

  /**
   * remove-hosts gets its OWN submit path rather than the generic `run`
   * helper (AM-28 peer review item 14): its response carries a per-host
   * `result.failed` list even on an overall 200 (a batch can partially
   * fail without the whole request erroring — see rolloutPlans.ts's
   * handleRemoveHosts) that must be surfaced to the operator, not silently
   * dropped just because the HTTP call itself "succeeded".
   */
  async function submitRemoveHosts(reason: string | undefined) {
    setBusy(true);
    setError(undefined);
    try {
      const response = await removeRolloutHosts(hostPoolName, plan.id, { sessionHostNames: [...selectedForRemoval], reason: reason ?? '' });
      setConfirmAction(undefined);
      setDialogPlanSnapshot(undefined);
      setSelectedForRemoval(new Set());
      if (response.result.failed.length > 0) {
        // AM-29 item D: the dedicated removeHostsFailures MessageBar below
        // already gives the full per-host detail — no separate toast needed
        // (a batch result with per-item failures stays a MessageBar, not a
        // toast, per this item's own scope note).
        setRemoveHostsFailures(response.result.failed);
      } else {
        setRemoveHostsFailures(undefined);
        onSuccessToast(`Removed ${response.result.succeeded.length} host(s).`);
      }
      onRefresh();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'The action failed.');
    } finally {
      setBusy(false);
    }
  }

  /**
   * AM-47: submits (or re-submits) the FSLogix config check for every new
   * host — a direct action, not routed through the generic `run` helper or
   * a confirm dialog, since it only kicks off a read-only registry check
   * (nothing destructive to confirm). Results land asynchronously via the
   * timer's next poll(s), surfaced by NewHostsTable's Config column and
   * ConfigCheckDiffs once they arrive on a subsequent refresh.
   */
  async function runVerifyConfig() {
    setVerifyConfigBusy(true);
    setVerifyConfigError(undefined);
    try {
      await verifyRolloutConfig(hostPoolName, plan.id);
      onSuccessToast('Config check started.');
      onRefresh();
    } catch (err) {
      setVerifyConfigError(err instanceof ApiClientError ? err.message : 'Failed to start the config check.');
    } finally {
      setVerifyConfigBusy(false);
    }
  }

  return (
    <div>
      <PlanOverview plan={displayPlan} />

      <RolloutStepper plan={displayPlan} />
      {/* AM-29 item 20 */}
      <Text size={200} className={styles.label}>
        This runs server-side — you can close this page and come back.
      </Text>
      {/* AM-49: only relevant while the timer is actively watching these new hosts' power state. */}
      {(displayPlan.state === 'awaiting_new_hosts' || displayPlan.state === 'validating_new') && (
        <Text size={200} className={styles.label} block>
          New hosts that autoscale deallocates during this step are restarted automatically.
        </Text>
      )}

      {displayPlan.lastTimerError && (
        <MessageBar intent="warning" className={styles.bannerSpacing}>
          <MessageBarBody>
            <MessageBarTitle>Last automatic check failed</MessageBarTitle>
            {displayPlan.lastTimerError} — will retry automatically.
          </MessageBarBody>
        </MessageBar>
      )}

      {removeHostsFailures && removeHostsFailures.length > 0 && (
        <MessageBar intent="error" className={styles.bannerSpacing}>
          <MessageBarBody>
            <MessageBarTitle>Some hosts could not be removed</MessageBarTitle>
            {removeHostsFailures.map((f) => (
              <div key={f.sessionHostName}>
                {f.sessionHostName}: {f.message}
              </div>
            ))}
          </MessageBarBody>
          <MessageBarActions>
            <Button appearance="transparent" size="small" onClick={() => setRemoveHostsFailures(undefined)}>
              Dismiss
            </Button>
          </MessageBarActions>
        </MessageBar>
      )}

      {verifyConfigError && (
        <MessageBar intent="error" className={styles.bannerSpacing}>
          <MessageBarBody>
            <MessageBarTitle>Could not start the config check</MessageBarTitle>
            {verifyConfigError}
          </MessageBarBody>
          <MessageBarActions>
            <Button appearance="transparent" size="small" onClick={() => setVerifyConfigError(undefined)}>
              Dismiss
            </Button>
          </MessageBarActions>
        </MessageBar>
      )}

      <OldHostsTable
        hosts={displayPlan.oldHosts}
        selectable={displayPlan.state === 'removing_old'}
        selected={selectedForRemoval}
        onToggle={toggleRemoval}
      />
      <NewHostsTable hosts={displayPlan.newHosts} />
      <ConfigCheckDiffs hosts={displayPlan.newHosts} />
      <KeepAliveWarnings hosts={displayPlan.newHosts} />
      <RollbackGuidance plan={displayPlan} />

      <div className={styles.actionsRow}>
        {plan.state === 'planned' && (
          <>
            <Button appearance="primary" onClick={() => openConfirm('start')}>
              Start draining
            </Button>
            <Button appearance="secondary" onClick={() => openConfirm('cancel')}>
              Cancel plan
            </Button>
          </>
        )}
        {plan.state === 'draining_old' && (
          <>
            <FluentLinkToSessions />
            <Button appearance="secondary" onClick={() => openConfirm('force-proceed')}>
              Force proceed
            </Button>
          </>
        )}
        {plan.state === 'awaiting_new_hosts' && (
          <>
            <Button appearance="primary" onClick={() => setAddHostPanelOpen(true)}>
              Guided add session host
            </Button>
            <Button appearance="secondary" onClick={() => openConfirm('force-proceed')}>
              Force proceed
            </Button>
          </>
        )}
        {plan.state === 'validating_new' && (
          <>
            <Button appearance="secondary" disabled={anyConfigCheckInProgress || verifyConfigBusy} onClick={() => void runVerifyConfig()}>
              {verifyConfigBusy ? 'Starting…' : anyConfigCheckInProgress ? 'Checking…' : 'Verify configuration'}
            </Button>
            <Button appearance="primary" onClick={() => openConfirm('cutover')}>
              Confirm cutover
            </Button>
          </>
        )}
        {plan.state === 'cutover' && (
          <Button appearance="primary" onClick={() => openConfirm('start-removal')}>
            Start removal
          </Button>
        )}
        {plan.state === 'removing_old' && (
          <Button appearance="primary" disabled={selectedForRemoval.size === 0} onClick={() => openConfirm('remove-hosts')}>
            Remove selected hosts ({selectedForRemoval.size})
          </Button>
        )}
        {plan.state !== 'planned' && (
          <Button appearance="secondary" onClick={() => openConfirm('rollback')}>
            {plan.state === 'removing_old' ? 'Rollback remaining' : 'Rollback'}
          </Button>
        )}
      </div>

      {/* Peer review (Opus, MAJOR item 2): "start draining" is a fleet-wide user-visible mutation (allowNewSession: false across every old host in the plan) — the rubric places that at 'medium' (mandatory reason), not 'low'. */}
      {confirmAction === 'start' && (
        <ConfirmModal
          title="Start draining old hosts?"
          severity="medium"
          description="Sets allowNewSession: false on every old host in this plan. Existing sessions are not disconnected."
          confirmLabel="Start draining"
          busy={busy}
          error={error}
          onConfirm={(reason) => void run(() => startRollout(hostPoolName, plan.id, { reason }), 'Draining started.')}
          onCancel={closeConfirm}
        />
      )}

      {/* Peer review (Opus, MAJOR item 1): stays severity 'low' (nothing has been drained yet, cancelling here has zero blast radius) but the API still audits a reason on cancelRollout — optionalReason keeps that capture without demoting this to a mandatory-reason tier. */}
      {confirmAction === 'cancel' && (
        <ConfirmModal
          title="Cancel this plan?"
          severity="low"
          optionalReason
          description="Nothing has been drained yet — cancelling now has no effect on any host."
          confirmLabel="Cancel plan"
          busy={busy}
          error={error}
          onConfirm={(reason) => void run(() => cancelRollout(hostPoolName, plan.id, { reason }), 'Plan cancelled.')}
          onCancel={closeConfirm}
        />
      )}

      {/* AM-29 item 30: force-proceed is severity 'medium' — mandatory reason, no typed hostname. */}
      {confirmAction === 'force-proceed' && (
        <ConfirmModal
          title={displayPlan.state === 'awaiting_new_hosts' ? 'Force proceed to validation?' : 'Force proceed past draining?'}
          severity="medium"
          description={
            displayPlan.state === 'awaiting_new_hosts'
              ? 'Moves the plan forward even though not every declared new host has registered yet.'
              : 'Moves the plan forward even though not every old host has reached zero sessions. Consider force-logging-off stragglers from the Sessions page first.'
          }
          confirmLabel="Force proceed"
          busy={busy}
          error={error}
          onConfirm={(reason) => void run(() => forceProceedRollout(hostPoolName, plan.id, { reason: reason ?? '' }), 'Proceeded.')}
          onCancel={closeConfirm}
        />
      )}

      {/*
       * AM-29 item 30: "rollout cutover-when-ready" is severity 'low' per the
       * rubric — but this ONE flow has always had a genuinely conditional
       * reason requirement (mandatory only when FORCING a cutover with
       * unready hosts, not on the normal ready path), which 'low' cannot
       * express (it renders no reason field at all). Kept on 'medium' (which
       * always shows the reason field) with the existing conditional
       * reasonRequired override, rather than dropping the force-path's
       * reason requirement to match 'low' literally — see this file's final
       * report note.
       */}
      {confirmAction === 'cutover' && (
        <ConfirmModal
          title="Confirm cutover?"
          severity="medium"
          description={
            allNewHostsReady
              ? 'Every new host is Available, healthy, image-verified, and passed the FSLogix config-convergence check. Declares them ready and moves the plan to cutover.'
              : `Not every new host is ready yet (${[
                  !allHostsAvailableHealthy && 'availability/health',
                  !allHostsImageVerified && 'image version',
                  !allHostsConfigVerified && 'FSLogix config',
                ]
                  .filter((part): part is string => Boolean(part))
                  .join(', ')} unverified) — confirming now forces the cutover anyway. A reason is required.`
          }
          confirmLabel="Confirm cutover"
          reasonRequired={!allNewHostsReady}
          busy={busy}
          error={error}
          onConfirm={(reason) => void run(() => confirmCutover(hostPoolName, plan.id, { reason, force: !allNewHostsReady }), 'Cut over to the new hosts.')}
          onCancel={closeConfirm}
        />
      )}

      {/* AM-29 item 30: start-removal (moving the PLAN to the removing_old phase) is severity 'medium' — distinct from the actual per-host removal below, which stays 'high'. */}
      {confirmAction === 'start-removal' && (
        <ConfirmModal
          title="Start host removal?"
          severity="medium"
          description="Moves the plan to removing_old. Old hosts are removed individually afterward, each re-verified to have zero sessions immediately before removal."
          confirmLabel="Start removal"
          busy={busy}
          error={error}
          onConfirm={(reason) => void run(() => startRemoval(hostPoolName, plan.id, { reason }), 'Removal phase started.')}
          onCancel={closeConfirm}
        />
      )}

      {/* AM-29 item 30: remove-hosts is severity 'high' — typed REMOVE + mandatory reason (already had this exact shape; severity is now explicit). AM-33 (D5): per-host impact list computed from the operator's own selection. */}
      {confirmAction === 'remove-hosts' && (
        <ConfirmModal
          title={`Remove ${selectedForRemoval.size} host(s)?`}
          severity="high"
          confirmText="REMOVE"
          description="Refused per-host if it still has active sessions (server-verified immediately before acting). This cannot be undone — see the runbook for NIC/disk/Entra cleanup, which this action does not perform."
          impact={<ImpactPreview lines={rolloutRemoveHostsPreviewLines([...selectedForRemoval])} />}
          confirmLabel="Remove hosts"
          busy={busy}
          error={error}
          onConfirm={(reason) => void submitRemoveHosts(reason)}
          onCancel={closeConfirm}
        />
      )}

      {/* AM-29 item 30: rollback is severity 'medium' — mandatory reason, no typed hostname. AM-33 (D5): the impact panel's counts mirror the server's own handleRollback host-by-host logic — see rollbackPreviewLines' doc comment. */}
      {confirmAction === 'rollback' && (
        <ConfirmModal
          title="Roll back this plan?"
          severity="medium"
          description="Hosts already removed cannot be restored — they will be listed for a guided re-add on the prior version instead."
          impact={<ImpactPreview lines={rollbackPreviewLines(displayPlan.oldHosts, displayPlan.newHosts)} />}
          confirmLabel="Roll back"
          busy={busy}
          error={error}
          onConfirm={(reason) => void run(() => rollbackRollout(hostPoolName, plan.id, { reason: reason ?? '' }), 'Plan rolled back.')}
          onCancel={closeConfirm}
        />
      )}

      <AddSessionHostPanel hostPoolName={hostPoolName} open={addHostPanelOpen} onClose={() => setAddHostPanelOpen(false)} />
    </div>
  );
}

/** Plain navigation link styled as a secondary button — deliberately NOT a Fluent Button with `as="a"` wrapping react-router's Link, which would nest an `<a>` inside another `<a>` (invalid HTML). */
function FluentLinkToSessions() {
  const styles = useStyles();
  return (
    <Link to="/sessions" className={styles.sessionsLink}>
      Force-logoff stuck sessions
    </Link>
  );
}
