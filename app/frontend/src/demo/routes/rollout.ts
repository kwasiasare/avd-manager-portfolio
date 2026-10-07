import type {
  RolloutPlanListResponse,
  RolloutPlanResponse,
  SessionHostProvisionDetail,
  SessionHostProvisionListResponse,
  StartSessionHostProvisionRequest,
  StartSessionHostProvisionResponse,
} from '@avdmgr/shared';
import { buildProvisionDryRunPlan, buildProvisions } from '../fixtures/provisions';
import { buildRolloutPlans } from '../fixtures/rollouts';
import { badRequest, demoDisabled, disable, notFound, read, simulate } from '../router';

const ROLLOUTS = '/v1/hostpools/:hostPoolName/rollout-plans';
const PROVISIONS = '/v1/hostpools/:hostPoolName/sessionhosts/provisions';

const ROLLOUT_ACTIONS: Array<[path: string, what: string]> = [
  ['start', 'Starting a rollout'],
  ['force-proceed', 'Forcing a rollout to proceed'],
  ['verify-config', 'Verifying rollout configuration'],
  ['confirm-cutover', 'Confirming a rollout cutover'],
  ['start-removal', 'Starting old-host removal'],
  ['remove-hosts', 'Removing old session hosts'],
  ['rollback', 'Rolling back a rollout'],
  ['cancel', 'Cancelling a rollout'],
];

/** Rollouts and guided provisioning drive real VM lifecycles, so they are browse-only: lists/details are served, every action is refused with demo_disabled. */
export function registerRolloutRoutes(): void {
  read<RolloutPlanListResponse>(ROLLOUTS, ({ state }) => ({ plans: buildRolloutPlans(state.now), truncated: false }));

  read<RolloutPlanResponse>(`${ROLLOUTS}/:planId`, ({ params, state }) => {
    const plan = buildRolloutPlans(state.now).find((candidate) => candidate.id === params.planId);
    if (!plan) throw notFound(`Rollout plan "${params.planId}" does not exist.`);
    return { plan };
  });

  disable('POST', ROLLOUTS, 'Creating a rollout plan');
  for (const [path, what] of ROLLOUT_ACTIONS) {
    disable('POST', `${ROLLOUTS}/:planId/${path}`, what);
  }

  read<SessionHostProvisionListResponse>(PROVISIONS, ({ state }) => ({
    provisions: buildProvisions(state.now).map((detail) => ({
      provisionId: detail.provisionId,
      hostPoolName: detail.hostPoolName,
      sessionHostName: detail.sessionHostName,
      zone: detail.zone,
      vmSize: detail.vmSize,
      imageVersion: detail.imageVersion,
      state: detail.state,
      createdAt: detail.createdAt,
      updatedAt: detail.updatedAt,
      createdBy: detail.createdBy,
    })),
  }));

  read<SessionHostProvisionDetail>(`${PROVISIONS}/:provisionId`, ({ params, state }) => {
    const provision = buildProvisions(state.now).find((candidate) => candidate.provisionId === params.provisionId);
    if (!provision) throw notFound(`Provision "${params.provisionId}" does not exist.`);
    return provision;
  });

  // Only the dry-run preview is served; a real provision would create a VM.
  simulate<StartSessionHostProvisionResponse, StartSessionHostProvisionRequest>('POST', PROVISIONS, ({ body, query }) => {
    if (query.get('dryRun') !== 'true') throw demoDisabled('Provisioning a session host');
    const name = body?.sessionHostName?.trim();
    if (!name) throw badRequest('sessionHostName is required.');
    return { plan: buildProvisionDryRunPlan(name), dryRun: true };
  });

  disable('POST', `${PROVISIONS}/:provisionId/cancel`, 'Cancelling a provision');
}
