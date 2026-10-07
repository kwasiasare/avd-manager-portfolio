import {
  IMAGE_BUILD_CHECKLIST,
  type ImageBuildDetail,
  type ImageBuildListResponse,
  type ImageVersionCurrent,
  type ImageVersionsResponse,
  type SnapshotReportResponse,
  type StartImageBuildRequest,
  type StartImageBuildResponse,
  type UpdateImageBuildChecklistRequest,
  type UpdateImageBuildChecklistResponse,
} from '@avdmgr/shared';
import { buildHostCorrelations } from '../fixtures/sessionHosts';
import { buildCurrentImage, buildImageVersions, buildSnapshots } from '../fixtures/images';
import { buildDryRunPlan } from '../fixtures/imageBuilds';
import { IMAGE_DEFINITION, RG } from '../fixtures/estate';
import { badRequest, conflict, demoDisabled, disable, notFound, read, simulate } from '../router';
import { recordAudit, type DemoState } from '../state';

const BUILDS = '/v1/images/builds';
const SEMVER = /^\d+\.\d+\.\d+$/;

function findBuild(state: DemoState, buildId: string): ImageBuildDetail {
  const build = state.builds.find((candidate) => candidate.buildId === buildId);
  if (!build) throw notFound(`Image build "${buildId}" does not exist.`);
  return build;
}

export function registerImageRoutes(): void {
  read<ImageVersionCurrent>('/v1/images/current', ({ state }) => buildCurrentImage(state.now));

  read<ImageVersionsResponse>('/v1/images/versions', ({ state }) => ({
    imageDefinitionName: IMAGE_DEFINITION,
    versions: buildImageVersions(state.now),
    hostCorrelations: buildHostCorrelations(),
  }));

  read<SnapshotReportResponse>('/v1/images/snapshots', ({ state }) => ({
    resourceGroupsScanned: [RG.images, RG.hostPools],
    snapshots: buildSnapshots(state.now),
    scanIncomplete: false,
  }));

  // Only the dry run is simulated; a real build would create Azure VMs/disks.
  simulate<StartImageBuildResponse, StartImageBuildRequest>('POST', BUILDS, ({ body, query }) => {
    if (query.get('dryRun') !== 'true') throw demoDisabled('Starting an image build');
    const version = body?.version?.trim();
    if (!version || !SEMVER.test(version)) throw badRequest('version must look like 1.4.0.');
    if (!body.adminUsername?.trim()) throw badRequest('adminUsername is required.');
    return { plan: buildDryRunPlan(version), dryRun: true };
  });

  read<ImageBuildListResponse>(BUILDS, ({ state }) => ({
    builds: state.builds.map(({ buildId, version, state: buildState, createdAt, updatedAt, createdBy }) => ({ buildId, version, state: buildState, createdAt, updatedAt, createdBy })),
  }));

  read<ImageBuildDetail>(`${BUILDS}/:buildId`, ({ params, state }) => structuredClone(findBuild(state, params.buildId)));

  simulate<UpdateImageBuildChecklistResponse, UpdateImageBuildChecklistRequest>('PATCH', `${BUILDS}/:buildId/checklist`, ({ params, body, state }) => {
    const build = findBuild(state, params.buildId);
    if (build.state !== 'checklist_gate') throw conflict('The checklist can only be edited while the build waits at the checklist gate.');
    if (!IMAGE_BUILD_CHECKLIST.some((item) => item.id === body?.itemId)) throw badRequest('Unknown checklist item.');
    build.checklist[body.itemId] = Boolean(body.checked);
    build.updatedAt = new Date().toISOString();
    recordAudit(state, { action: 'image.build.checklist', target: `Image build ${build.version}`, reason: `${body.itemId} = ${body.checked}`, hasParameters: true });
    return { checklist: { ...build.checklist }, allRequiredChecked: IMAGE_BUILD_CHECKLIST.every((item) => build.checklist[item.id] === true) };
  });

  disable('POST', `${BUILDS}/:buildId/advance`, 'Advancing an image build');
  disable('POST', `${BUILDS}/:buildId/cancel`, 'Cancelling an image build');
  disable('DELETE', `${BUILDS}/:buildId/snapshot`, 'Deleting a build snapshot');
}
