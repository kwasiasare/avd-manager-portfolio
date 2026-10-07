/**
 * AM-50 — guided session-host provisioning DTOs: create the session-host VM
 * and apply its three extensions (Entra join, guest attestation, DSC
 * AddSessionHost) from the app itself, closing the gap AM-22's
 * AddSessionHostPanel.tsx left ("VM provisioning itself runs outside the
 * app"). Shared between app/api (state machine + plan generator + ARM
 * orchestration) and app/frontend (the admin-only provisioning section on
 * that same panel).
 *
 * DELIBERATELY MIRRORS imageBuild.ts (app/api/src/services/
 * imageBuildOrchestrator.ts's submit/poll idioms, imageBuildStateMachine.ts's
 * transition table shape, imageBuildService.ts's Table persistence) — see
 * that file's header comment for the full "why a Table state machine, not
 * Durable Functions" background, which applies here unchanged: this is the
 * SAME kind of long-running, resumable, ARM-orchestrated workflow, just
 * simpler (no operator gates at all — see SessionHostProvisionState below;
 * a session-host add has no irreversible-Sysprep-style hard stop the way a
 * golden-image build does).
 */

/**
 * State machine states, in their normal forward order. See
 * app/api/src/lib/sessionHostProvisionStateMachine.ts for the full
 * transition table. Unlike ImageBuildState, NONE of these states are
 * operator-gated — the whole pipeline runs automatically once submitted,
 * polled by app/api/src/functions/sessionHostProvisionTimer.ts every
 * minute; the only operator actions are starting it and (optionally)
 * cancelling it.
 */
export type SessionHostProvisionState =
  | 'planned'
  | 'nic_creating'
  | 'vm_creating'
  | 'ext_entra_join'
  | 'ext_guest_attestation'
  | 'ext_dsc'
  | 'awaiting_registration'
  | 'done'
  | 'failed'
  | 'cancelled';

/** Every state a provision can never leave. */
export const SESSION_HOST_PROVISION_TERMINAL_STATES: readonly SessionHostProvisionState[] = ['done', 'failed', 'cancelled'];

/**
 * Identifies one ARM-call step in the provision's plan. Shared by the
 * dry-run plan generator (app/api/src/lib/sessionHostProvisionPlan.ts) and
 * the persisted per-step status on SessionHostProvisionDetail.steps below —
 * same "single source of truth" contract as ImageBuildStepId.
 */
export type SessionHostProvisionStepId = 'create_nic' | 'create_vm' | 'ext_entra_join' | 'ext_guest_attestation' | 'ext_dsc' | 'await_registration';

export type SessionHostProvisionStepStatus = 'pending' | 'in_progress' | 'succeeded' | 'failed' | 'skipped';

/** Persisted status/timestamps/error for one step — SessionHostProvisionDetail.steps carries one of these per SessionHostProvisionStepId, in plan order. */
export interface SessionHostProvisionStepState {
  stepId: SessionHostProvisionStepId;
  status: SessionHostProvisionStepStatus;
  startedAt?: string;
  completedAt?: string;
  /** Short, sanitized failure classification (never a raw ARM error body — same CWE-532 rule as ImageBuildStepState.error). */
  error?: string;
  /** Number of timer ticks this step has been polled/attempted while not yet terminal — see the orchestrator's attempt-ceiling handling. Undefined/0 for a step never polled. */
  attempts?: number;
}

/** Single source of truth for a step's human label, keyed by SessionHostProvisionStepId — mirrors IMAGE_BUILD_STEP_LABELS exactly (see that constant's doc comment for why this exists instead of re-deriving labels from the plan on every consumer). */
export const SESSION_HOST_PROVISION_STEP_LABELS: Record<SessionHostProvisionStepId, string> = {
  create_nic: 'Create session host network interface',
  create_vm: 'Create session host VM',
  ext_entra_join: 'Apply Microsoft Entra join extension (AADLoginForWindows)',
  ext_guest_attestation: 'Apply Guest Attestation extension',
  ext_dsc: 'Register with the host pool (Microsoft.PowerShell.DSC AddSessionHost)',
  await_registration: 'Wait for the host to appear registered in the host pool',
};

/** One ARM-call step in the provision's ordered plan — the same shape whether it appears in a dry-run preview or describes a step already executed as part of a real provision. */
export interface SessionHostProvisionPlanStep {
  stepId: SessionHostProvisionStepId;
  /** Human label, e.g. "Create session host VM". */
  label: string;
  /** The provision state this step transitions the provision INTO once it completes. */
  targetState: SessionHostProvisionState;
  /** The ARM/SDK call this step makes, e.g. "virtualMachines.createOrUpdate". */
  armCall: string;
  /** The resource this step acts on, e.g. "avd-con-4 (RG-AVD-HostPools)" — HUMAN-READABLE ONLY, for display. Never parsed by code — see resourceName below. */
  resource: string;
  /** The bare, machine-readable name of the resource this step acts on. app/api/src/services/sessionHostProvisionOrchestrator.ts reads THIS field for every real ARM call — it never parses the human-readable `resource` display string (same Opus-review-MAJOR-8 rule imageBuildPlan.ts's ImageBuildPlanStep.resourceName doc comment records). */
  resourceName: string;
  /** The parameters that ARM call would be made with. NEVER includes a secret — adminPassword is generated server-side and injected only at the moment of the real ARM call, and the DSC extension's registrationInfoToken is generated FRESH at submit time and injected only into protectedSettings at that moment — neither is ever present here, in a dry-run preview, or in anything persisted to the SessionHostProvision table (see StartSessionHostProvisionResponse.generatedAdminPassword's doc comment and app/api/src/services/sessionHostProvisionOrchestrator.ts#submitDscExtension). */
  parameters: Record<string, unknown>;
}

/** The complete ordered plan for one provision — the dry-run response body carries this shape unwrapped. */
export interface SessionHostProvisionPlan {
  sessionHostName: string;
  steps: SessionHostProvisionPlanStep[];
}

/**
 * Caller-supplied parameters for starting a provision (dry-run or real).
 * Deliberately has NO adminUsername/adminPassword field — the local admin
 * username is a fixed, config-driven estate convention (see
 * app/api/src/lib/config.ts's sessionHostProvision.adminUsername, a required
 * app setting with no default)
 * and the password is server-generated exactly once per provision, same
 * "generate, show once, never store" contract as ImageBuildParams.
 */
export interface SessionHostProvisionParams {
  /** The new session host's name — also becomes the VM's computer name verbatim, so it is bounded to 15 characters (Windows' NetBIOS computer-name limit — see the golden-image runbook §7.2's "Computer name" row, the same limit imageBuildPlan.ts's deriveBuildResourceNames works around for the build VM). Validated server-side against SESSION_HOST_NAME_PATTERN AND this 15-char bound. */
  sessionHostName: string;
  /** Availability zone the VM is pinned to. Live hosts occupy zones 2 and 3 as of 2026-08-22 (the session-host runbook) — the frontend hints at spreading across zones, but this app does not enforce any particular distribution. */
  zone: '1' | '2' | '3';
  /** VM size override. Defaults server-side to the host pool's own vmTemplate.vmSizeId (see app/api/src/services/avdService.ts#getVmTemplateInfo), falling back to Standard_D4ads_v7 if that isn't set/parseable. */
  vmSize?: string;
  /** Target gallery image version, e.g. "2.2.0". Defaults server-side to an active (non-terminal) rollout plan's targetImageVersion if one exists for this host pool, else the currently-published gallery version. Server-validated to actually exist as a gallery image version. */
  imageVersion?: string;
}

/** POST /v1/hostpools/{hostPoolName}/sessionhosts/provisions request body. */
export type StartSessionHostProvisionRequest = SessionHostProvisionParams;

/** Summary row for GET .../provisions (list). */
export interface SessionHostProvisionSummary {
  provisionId: string;
  hostPoolName: string;
  sessionHostName: string;
  zone: string;
  vmSize: string;
  imageVersion: string;
  state: SessionHostProvisionState;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
}

/** Full detail for GET .../provisions/{provisionId} and every mutation response. */
export interface SessionHostProvisionDetail extends SessionHostProvisionSummary {
  vmName: string;
  nicName: string;
  /** One entry per SessionHostProvisionStepId, in plan order — see SessionHostProvisionStepState. */
  steps: SessionHostProvisionStepState[];
  /** Set when state === 'failed' — the last error that stopped the provision. */
  errorMessage?: string;
  /** Set when state === 'cancelled' — the operator's stated reason, if given. */
  cancelReason?: string;
  /**
   * Honest, human-readable statement of what — if anything — a CANCEL left
   * behind in Azure for the operator to clean up manually. Set only once
   * state is 'cancelled' — mirrors ImageBuildPlan's describeCleanupGuidance
   * (app/api/src/lib/sessionHostProvisionPlan.ts): cancelling never fires
   * deletes on the operator's behalf.
   */
  cleanupGuidance?: string;
}

/** Response body for POST .../provisions — same shape for both the dryRun=true preview and a real start. */
export interface StartSessionHostProvisionResponse {
  /** Absent when dryRun is true — nothing was persisted or mutated. */
  provision?: SessionHostProvisionDetail;
  /** Always present: the complete ordered plan — either the dry-run preview or the plan the real provision just started executing. */
  plan: SessionHostProvisionPlan;
  dryRun: boolean;
  /**
   * The server-generated session-host VM local admin password — present
   * ONLY on a successful REAL (non-dryRun) start, and ONLY in this one
   * response body. Never returned again by any other endpoint, never
   * audited, never persisted — see SessionHostProvisionParams' doc comment.
   * The frontend MUST treat this the same way ImageBuildSection.tsx treats
   * StartImageBuildResponse.generatedAdminPassword: a "shown once" dialog,
   * cleared from React state on dismiss/unmount.
   */
  generatedAdminPassword?: string;
}

export interface SessionHostProvisionListResponse {
  provisions: SessionHostProvisionSummary[];
}

/** POST .../provisions/{provisionId}/cancel — abandons the state machine without firing any ARM deletes (see SessionHostProvisionDetail.cleanupGuidance). */
export interface CancelSessionHostProvisionRequest {
  reason?: string;
}

export interface CancelSessionHostProvisionResponse {
  provision: SessionHostProvisionDetail;
  cleanupGuidance: string;
}
