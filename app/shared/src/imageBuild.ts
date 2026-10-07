/**
 * AM-27 (M4-S2) — golden image BUILD orchestration DTOs. Shared between
 * app/api (state machine + plan generator + ARM orchestration) and
 * app/frontend (the admin-only build wizard on the Images page).
 *
 * BACKGROUND — why a hand-rolled Table state machine, not Durable Functions:
 * verified on Microsoft Learn ("Azure Storage provider for Durable
 * Functions" / "Flex Consumption plan" section, and "Azure Functions Flex
 * Consumption plan hosting" / Considerations #3) that Durable Functions IS
 * now supported on Flex Consumption, backed by either the Azure Storage
 * provider or the Durable Task Scheduler — this CORRECTS the story's own
 * "expected: NOT supported" assumption, which predates that support landing.
 * Despite Durable Functions now being available, this feature still uses a
 * plain Table-backed state machine (ImageBuildEntity — see
 * app/api/src/services/imageBuildService.ts), for three reasons: (1) it
 * matches this codebase's ALREADY-ESTABLISHED pattern for exactly this kind
 * of long-running, resumable, operator-gated workflow (the emergency
 * scaling override — scalingOverrideService.ts + a 5-minute timer,
 * scalingOverrideReEnable.ts), so a reviewer/operator debugging a stuck
 * build reads the same shapes (ETag-concurrent Table row, timer polls +
 * advances, audited transitions) they already know from that feature; (2) a
 * golden-image build has no fan-out/fan-in and no need for
 * orchestrator-to-activity function calls — Durable's main value-add over a
 * plain state machine — so adopting it here would be a new, heavier
 * dependency (a durable task hub, its own storage/DTS provisioning, a
 * different debugging model) for no capability this feature actually needs;
 * (3) a hand-rolled state machine keeps the HARD GATES (the checklist gate,
 * and the awaiting_stopped power-state gate) as plain, synchronously
 * testable pure functions (see app/api/src/lib/imageBuildStateMachine.ts)
 * rather than orchestrator-replay-safe code, which is simpler to reason
 * about correctly for a workflow whose worst failure mode (an accidental
 * generalize/capture against a VM that never actually stopped) is
 * unrecoverable.
 */

/**
 * State machine states, in their normal forward order. See
 * app/api/src/lib/imageBuildStateMachine.ts for the full transition table
 * (including which states are timer-advanced vs. require an explicit
 * operator action) and for why each edge exists.
 */
export type ImageBuildState =
  | 'planned'
  | 'vm_creating'
  | 'vm_ready'
  | 'checklist_gate'
  | 'snapshotting'
  | 'sysprep_running'
  | 'awaiting_stopped'
  | 'capturing'
  | 'test_host_step'
  | 'cleanup'
  | 'done'
  | 'failed'
  | 'cancelled';

/** Every state a build can never leave. */
export const IMAGE_BUILD_TERMINAL_STATES: readonly ImageBuildState[] = ['done', 'failed', 'cancelled'];

/**
 * States that can ONLY be advanced by an explicit operator action (POST
 * .../checklist then .../advance, or .../advance) — never the 1-minute
 * timer. Single source of truth for both
 * app/api/src/lib/imageBuildStateMachine.ts's OPERATOR_GATED_STATES (a Set
 * built from this array) and the frontend wizard's own gating logic
 * (app/frontend/src/pages/Images.tsx), so the two never drift on which
 * states show an "advance" button.
 */
export const IMAGE_BUILD_OPERATOR_GATED_STATES: readonly ImageBuildState[] = ['checklist_gate', 'test_host_step'];

/**
 * Identifies one ARM-call (or operator-gate) step in the build's plan.
 * Shared by the dry-run plan generator (app/api/src/lib/imageBuildPlan.ts)
 * and the persisted per-step status on ImageBuildDetail.steps below — the
 * plan generator is the SINGLE SOURCE OF TRUTH the real executor
 * (app/api/src/services/imageBuildOrchestrator.ts) also consumes, so the
 * dry-run preview can never drift from what actually runs.
 */
export type ImageBuildStepId =
  | 'create_build_nic'
  | 'create_build_vm'
  | 'operator_checklist_gate'
  | 'create_presysprep_snapshot'
  | 'run_sysprep'
  | 'await_stopped'
  | 'ensure_deallocated'
  | 'generalize_vm'
  | 'capture_image_version'
  | 'operator_test_host_step'
  | 'delete_build_vm'
  | 'delete_build_nic'
  | 'delete_build_disk';

export type ImageBuildStepStatus = 'pending' | 'in_progress' | 'succeeded' | 'failed' | 'skipped';

/** Persisted status/timestamps/error for one step — ImageBuildDetail.steps carries one of these per ImageBuildStepId, in plan order. */
export interface ImageBuildStepState {
  stepId: ImageBuildStepId;
  status: ImageBuildStepStatus;
  startedAt?: string;
  completedAt?: string;
  /** Short, sanitized failure classification (never a raw ARM error body — same CWE-532 rule as SessionBatchFailure.message elsewhere in this package). */
  error?: string;
  /** Number of timer ticks this step has been polled/attempted while not yet terminal — see app/api/src/services/imageBuildOrchestrator.ts's attempt-ceiling handling (Opus review MAJOR: an unbounded poll loop against a permanently-broken resource must eventually fail, not retry forever). Undefined/0 for a step that has never been polled. */
  attempts?: number;
}

/**
 * Single source of truth for a step's human label, keyed by ImageBuildStepId
 * — used both by imageBuildPlan.ts (each ImageBuildPlanStep.label below is
 * derived from this map, so the two can never drift) and directly by the
 * frontend's StepsTable (app/frontend/src/pages/Images.tsx), which only has
 * ImageBuildStepState (stepId + status, no label) and needs a display name
 * without re-fetching or re-deriving the full plan.
 */
export const IMAGE_BUILD_STEP_LABELS: Record<ImageBuildStepId, string> = {
  create_build_nic: 'Create build VM network interface',
  create_build_vm: 'Create build VM',
  operator_checklist_gate: 'Operator confirms build-manual checklist',
  create_presysprep_snapshot: 'Snapshot the build VM OS disk before Sysprep',
  run_sysprep: 'Run Sysprep on the build VM (irreversible)',
  await_stopped: 'Poll VM power state until stopped/deallocated (HARD GATE)',
  ensure_deallocated: 'Ensure the build VM is deallocated',
  generalize_vm: 'Generalize the build VM',
  capture_image_version: 'Capture gallery image version',
  operator_test_host_step: 'Operator deploys and validates a test session host from the new version',
  delete_build_vm: 'Delete build VM',
  delete_build_nic: 'Delete build VM network interface',
  delete_build_disk: 'Delete build VM OS disk',
};

/** One item on the checklist_gate's fixed, build-manual-sourced checklist. */
export interface ImageBuildChecklistItem {
  id: string;
  label: string;
  /** The build-manual section this item cites, e.g. "Golden image runbook §4.2". */
  source: string;
}

/**
 * The fixed, ORDERED checklist presented at the checklist_gate state — every
 * item is drawn directly from the golden-image runbook §4.2-§4.6
 * (the documented build order, the BitLocker trap in §4.3, the Store/MSIX
 * trap in §4.4, and the Sysprep pre-checks table in §4.6). These are
 * OPERATOR-ATTESTED (ticked, not executed by this app) — the automated
 * sysprep_running step (app/api/src/services/imageBuildOrchestrator.ts)
 * trusts that every item here is true before it runs the irreversible
 * `sysprep.exe /generalize /oobe /shutdown` Run Command. Single source of
 * truth for both the API's server-side gate check
 * (app/api/src/lib/imageBuildChecklist.ts#allRequiredChecklistItemsChecked)
 * and the frontend checklist UI.
 */
export const IMAGE_BUILD_CHECKLIST: readonly ImageBuildChecklistItem[] = [
  {
    id: 'windows_updates',
    label: 'Windows fully patched — updated, rebooted, and rechecked clean.',
    source: 'Golden image runbook §4.2 step 1',
  },
  {
    id: 'office_not_reinstalled',
    label: 'Office/M365 Apps updated to the target channel — NOT reinstalled (the -avd-m365 marketplace SKU ships with Microsoft 365 Apps preinstalled).',
    source: 'Golden image runbook §4.2 step 2',
  },
  {
    id: 'fslogix_agent_updated',
    label: 'FSLogix agent binaries updated (configuration is Intune-delivered — not baked into the image).',
    source: 'Golden image runbook §4.2 step 3',
  },
  {
    id: 'teams_webrtc_installed',
    label: 'Remote Desktop WebRTC Redirector installed, then new Teams via teamsbootstrapper.exe -p, and HKLM\\SOFTWARE\\Microsoft\\Teams\\IsWVDEnvironment set to 1.',
    source: 'Golden image runbook §4.2 step 4',
  },
  {
    id: 'runtimes_installed',
    label: 'WebView2 Runtime, Visual C++ Redistributables (x86 and x64), and .NET Desktop Runtime installed.',
    source: 'Golden image runbook §4.2 step 5',
  },
  {
    id: 'lob_apps_tested',
    label: 'Line-of-business applications installed and explicitly tested for multi-session compatibility.',
    source: 'Golden image runbook §4.2 step 7',
  },
  {
    id: 'auto_updaters_disabled',
    label: 'Every auto-updater disabled (Adobe, Google Update, Microsoft Store auto-download).',
    source: 'Golden image runbook §4.2 step 8',
  },
  {
    id: 'vdot_run_last',
    label: 'Azure Virtual Desktop Optimization Tool (VDOT) run LAST, after every app is installed, immediately before Sysprep.',
    source: 'Golden image runbook §4.2 step 9',
  },
  {
    id: 'bitlocker_disabled',
    label: 'BitLocker confirmed fully off via `manage-bde -status C:` (not Control Panel — "Waiting for activation" is misleading). VolumeStatus=FullyDecrypted, EncryptionPercentage=0, ProtectionStatus=Off.',
    source: 'Golden image runbook §4.3',
  },
  {
    id: 'appx_mismatches_removed',
    label: 'Per-user Store/MSIX package mismatches removed (Get-AppxProvisionedPackage vs Get-AppxPackage -AllUsers), and the WindowsStore AutoDownload policy set to block reintroduction.',
    source: 'Golden image runbook §4.4',
  },
  {
    id: 'shared_computer_licensing',
    label: 'Office SharedComputerLicensing confirmed = 1 (required for a pooled host pool).',
    source: 'Golden image runbook §4.6 check 1',
  },
  {
    id: 'no_pending_reboot',
    label: 'No pending reboot on either path (Component Based Servicing\\RebootPending and WindowsUpdate\\Auto Update\\RebootRequired both False).',
    source: 'Golden image runbook §4.6 check 2',
  },
  {
    id: 'rearm_count_available',
    label: 'Sysprep rearm count remaining (RemainingWindowsReArmCount) is greater than 0.',
    source: 'Golden image runbook §4.6 check 3',
  },
  {
    id: 'not_domain_joined',
    label: 'VM confirmed not domain-joined (PartOfDomain = False — this estate is Entra-only).',
    source: 'Golden image runbook §4.6 check 4',
  },
];

/** Ticked state of the checklist, keyed by ImageBuildChecklistItem.id. Absent/false = not yet ticked. */
export type ImageBuildChecklistState = Record<string, boolean>;

/**
 * One ARM-call (or operator-gate) step in the build's ordered plan — the
 * SAME shape whether it appears in a dry-run preview (no buildId, nothing
 * mutated) or describes a step already executed as part of a real build.
 */
export interface ImageBuildPlanStep {
  stepId: ImageBuildStepId;
  /** Human label, e.g. "Create build VM". */
  label: string;
  /** The build state this step transitions the build INTO once it completes. */
  targetState: ImageBuildState;
  /** The ARM/SDK call this step would make, e.g. "virtualMachines.createOrUpdate". Null for a pure operator-gate step (no ARM call at all). */
  armCall: string | null;
  /** The resource this step acts on, e.g. "VM-IMG-a1b2c3d4 (RG-AVD-Images)" — HUMAN-READABLE ONLY, for display. Never parsed by code — see resourceName below. */
  resource: string;
  /**
   * The bare, machine-readable name of the resource this step acts on (e.g.
   * "VM-IMG-A1B2C3D4"), or '' for an operator-gate step with no Azure
   * resource. app/api/src/services/imageBuildOrchestrator.ts reads THIS
   * field for every real ARM call — it never parses the human-readable
   * `resource` display string (Opus review MAJOR 8: parsing a display
   * string with `.split(' ')[0]` is fragile and was flagged as a defect).
   */
  resourceName: string;
  /** The parameters that ARM call would be made with. Never includes a secret (adminPassword is generated server-side and injected only at the moment of the real ARM call — see imageBuildOrchestrator.ts#submitBuildVmCreation — never present here, in a dry-run preview, or in any persisted plan). */
  parameters: Record<string, unknown>;
  /** True when this step can ONLY be advanced by an explicit operator action (POST .../checklist + .../advance, or .../advance) — never the 1-minute timer. */
  operatorGate: boolean;
}

/** The complete ordered plan for one build — the dry-run response body IS this shape, unwrapped. */
export interface ImageBuildPlan {
  version: string;
  steps: ImageBuildPlanStep[];
}

/**
 * Caller-supplied parameters for starting a build (dry-run or real).
 * Deliberately has NO password field — see Opus review MAJOR 5: an
 * operator-supplied VM admin password was a credential-handling risk this
 * app doesn't need to take on. The server GENERATES a 32-character
 * Azure-complexity-meeting password (see
 * app/api/src/lib/imageBuildSecrets.ts#generateBuildAdminPassword) at the
 * moment a REAL (non-dry-run) build starts, returns it EXACTLY ONCE in
 * StartImageBuildResponse.generatedAdminPassword below (never again, never
 * audited, never persisted to the ImageBuild table — same "write-only,
 * shown-once" contract this app already applies to the registration-token
 * value; see app/api/src/functions/hostPoolRegistrationToken.ts's doc
 * comment and the frontend's matching shown-once dialog pattern in
 * AddSessionHostPanel.tsx), and uses it once for the VM create ARM call.
 */
export interface ImageBuildParams {
  /** Target gallery image version, e.g. "2.1.0" — must be strictly greater than the current published version, and must not already exist as a gallery image version (both server-validated — see app/api/src/functions/imageBuilds.ts). */
  version: string;
  /** Build VM size override. Defaults server-side (see imageBuildPlan.ts's DEFAULT_VM_SIZE) to a size sized for patching Windows + Office, per the golden-image runbook §4.1's sizing note. */
  vmSize?: string;
  /** Local admin username for the throwaway build VM. */
  adminUsername: string;
}

/** POST /v1/images/builds request body. */
export type StartImageBuildRequest = ImageBuildParams;

/** Summary row for GET /v1/images/builds (list). */
export interface ImageBuildSummary {
  buildId: string;
  version: string;
  state: ImageBuildState;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
}

/** Full detail for GET /v1/images/builds/{buildId} and every mutation response. */
export interface ImageBuildDetail extends ImageBuildSummary {
  vmName: string;
  nicName: string;
  diskName: string;
  snapshotName: string;
  checklist: ImageBuildChecklistState;
  /** One entry per ImageBuildStepId, in plan order — see ImageBuildStepState. */
  steps: ImageBuildStepState[];
  /** Set when state === 'failed' — the last error that stopped the build. */
  errorMessage?: string;
  /** Set when state === 'cancelled' — the operator's stated reason, if given. */
  cancelReason?: string;
  /** Resource ID of the gallery image version this build produced, once capturing has succeeded. */
  capturedImageVersionId?: string;
  /** The marketplace base image's resolved `exactVersion` (e.g. "26200.8875.260714"), recorded for provenance once the build VM is readable (vm_ready) — see @azure/arm-compute's ImageReference.exactVersion doc comment ("differs from 'version' only if 'version' is 'latest'"). Undefined until then. */
  baseImageExactVersion?: string;
  /**
   * Set by the timer when a build has sat at checklist_gate (VM created,
   * running, and BILLING, but not yet advanced) longer than the configured
   * abandonment threshold (IMAGE_BUILD_ABANDONMENT_HOURS, default 24 — see
   * app/api/src/lib/config.ts) — an AUDITED WARNING, not an auto-fail (Opus
   * review MAJOR 10): the build keeps running exactly as before, this is
   * purely an observability nudge surfaced in the wizard UI so an abandoned
   * build's ongoing VM cost doesn't go unnoticed indefinitely. Cleared
   * automatically once the build advances past checklist_gate.
   */
  abandonedWarning?: string;
  /**
   * AM-53 — set once an operator successfully SUBMITS
   * DELETE /v1/images/builds/{buildId}/snapshot (accepted by ARM, not
   * necessarily confirmed complete yet — this app never polls a snapshot
   * delete to completion, same "submit and audit, don't poll" posture as
   * every other delete in this feature) — the durable, persisted paper-trail
   * counterpart to the LIVE `snapshotStatus` below. Undefined until a delete
   * has been submitted for this build.
   */
  snapshotDeleteSubmittedAt?: string;
  /**
   * AM-53 — LIVE truth read directly from Azure on every GET of this detail
   * (never cached — see app/api/src/functions/imageBuilds.ts's GET handler,
   * which is already polled by the frontend every few seconds), computed
   * ONLY once the build has reached `done` — the earliest state this
   * feature's own DELETE .../snapshot handler ever permits a delete from, so
   * there is nothing meaningful to report before then (the pre-Sysprep
   * snapshot may not even have finished provisioning yet). 'present' = a
   * fresh `snapshots.get` succeeded; 'deleted' = it 404'd; 'unknown' = the
   * read itself failed (a transient ARM error) — NEVER guessed. Undefined
   * for any build not yet `done`.
   */
  snapshotStatus?: 'present' | 'deleted' | 'unknown';
  /**
   * AM-53 — server-computed gate result (build is `done` AND the live
   * snapshotStatus above is `present` AND a completed rollout for this
   * build's version exists) so the frontend NEVER re-implements the
   * rollout-done/snapshot-status gate logic itself — see
   * app/api/src/lib/imageBuildSnapshotGate.ts, the single source of truth
   * both this field and the DELETE handler's own 409 gate read from.
   * Undefined for any build not yet `done` (same scope as snapshotStatus).
   */
  snapshotDeletable?: boolean;
  /**
   * AM-53 — set whenever snapshotDeletable is false (and the build is
   * `done`), explaining exactly which gate failed — verbatim the same
   * message a DELETE .../snapshot attempt would also be rejected with, so
   * the UI's disabled-button tooltip and the server's own 409 never drift
   * apart into two different explanations of the same refusal.
   */
  snapshotDeleteBlockedReason?: string;
}

/** DELETE /v1/images/builds/{buildId}/snapshot request body — AM-53 operator-confirmed pre-Sysprep snapshot retirement, gated on the build being `done` and this version having completed a rollout (see imageBuildSnapshotGate.ts). Mandatory reason — same posture as every other irreversible delete in this app (DeleteRetiredProfileRequest, DuplicateContainerResolveRequest). */
export interface DeleteImageBuildSnapshotRequest {
  reason: string;
}

export interface DeleteImageBuildSnapshotResponse {
  build: ImageBuildDetail;
}

/** Response body for POST /v1/images/builds — same shape for both the dryRun=true preview and a real start. */
export interface StartImageBuildResponse {
  /** Absent when dryRun is true — nothing was persisted or mutated. */
  build?: ImageBuildDetail;
  /** Always present: the complete ordered plan — either the dry-run preview or the plan the real build just started executing. */
  plan: ImageBuildPlan;
  dryRun: boolean;
  /**
   * The server-generated build VM local admin password — present ONLY on a
   * successful REAL (non-dryRun) start, and ONLY in this one response body.
   * Never returned again by any other endpoint (GET .../builds/{id} never
   * includes it), never audited, never persisted — see ImageBuildParams'
   * doc comment for the full "generate once, show once" contract. The
   * frontend MUST treat this the same way AddSessionHostPanel.tsx treats a
   * freshly-generated registration token: an alert-modal "shown once"
   * dialog, cleared from React state on dismiss/unmount.
   */
  generatedAdminPassword?: string;
}

export interface ImageBuildListResponse {
  builds: ImageBuildSummary[];
}

/** PATCH /v1/images/builds/{buildId}/checklist request body — ticks (or unticks) exactly one item per call, so the audit trail records each toggle individually. */
export interface UpdateImageBuildChecklistRequest {
  itemId: string;
  checked: boolean;
}

export interface UpdateImageBuildChecklistResponse {
  checklist: ImageBuildChecklistState;
  allRequiredChecked: boolean;
}

/**
 * POST /v1/images/builds/{buildId}/advance — the OPERATOR-gate action,
 * valid only while the build is in an operatorGate state (checklist_gate:
 * requires every checklist item ticked first; test_host_step: the operator
 * confirms a deployed test host validated correctly before cleanup runs).
 */
export interface AdvanceImageBuildRequest {
  reason?: string;
}

export interface AdvanceImageBuildResponse {
  build: ImageBuildDetail;
}

/** DELETE-style cancel — POST /v1/images/builds/{buildId}/cancel. */
export interface CancelImageBuildRequest {
  reason?: string;
}

export interface CancelImageBuildResponse {
  build: ImageBuildDetail;
  /**
   * Honest, human-readable statement of what Azure resources (if any) this
   * cancel did NOT itself clean up, and must still be removed manually — a
   * cancel never fires deletes on the operator's behalf (see
   * app/api/src/functions/imageBuilds.ts's cancel handler doc comment for
   * why). Empty string when nothing was ever created (e.g. cancelled while
   * still 'planned').
   */
  cleanupGuidance: string;
}
