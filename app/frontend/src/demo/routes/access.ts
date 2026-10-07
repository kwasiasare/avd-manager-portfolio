import type {
  AccessSearchResponse,
  AssignmentsListResponse,
  CreateAssignmentRequest,
  CreateAssignmentResponse,
  DesktopAssignment,
  UpdateWorkspaceFriendlyNameRequest,
  WorkspaceFriendlyNameResponse,
} from '@avdmgr/shared';
import { DAG_SCOPE, DIRECTORY } from '../fixtures/access';
import { RG, armId } from '../fixtures/estate';
import { fakeGuid } from '../fixtures/time';
import { badRequest, conflict, disable, notFound, read, simulate } from '../router';
import { recordAudit } from '../state';

export function registerAccessRoutes(): void {
  read<AccessSearchResponse>('/v1/access/search', ({ query }) => {
    const q = (query.get('q') ?? '').trim().toLowerCase();
    const results = q ? DIRECTORY.filter((entry) => entry.displayName.toLowerCase().includes(q) || entry.userPrincipalName?.toLowerCase().includes(q)) : [];
    return { results: results.slice(0, 10), graphAvailable: true, truncated: results.length > 10 };
  });

  read<AssignmentsListResponse>('/v1/access/assignments', ({ state }) => ({ assignments: state.assignments.slice(), graphResolved: true, truncated: false }));

  simulate<CreateAssignmentResponse, CreateAssignmentRequest>('POST', '/v1/access/assignments', ({ body, state }) => {
    const principal = DIRECTORY.find((entry) => entry.id === body?.principalId);
    if (!principal) throw notFound('That user or group does not exist in the demo directory.');
    if (!body.reason?.trim()) throw badRequest('A reason is required.');
    if (state.assignments.some((assignment) => assignment.principalId === principal.id && assignment.assignedDirectlyOnDag)) {
      throw conflict(`${principal.displayName} already has "Desktop Virtualization User" directly on the application group.`);
    }
    const assignment: DesktopAssignment = {
      roleAssignmentId: armId(RG.hostPools, `Microsoft.Authorization/roleAssignments/${fakeGuid(750 + state.assignments.length)}`),
      principalId: principal.id,
      principalType: principal.principalType === 'group' ? 'Group' : 'User',
      displayName: principal.displayName,
      userPrincipalName: principal.userPrincipalName,
      scope: DAG_SCOPE,
      assignedDirectlyOnDag: true,
      assignedVia: 'Direct on DAG',
    };
    state.assignments.push(assignment);
    recordAudit(state, { action: 'access.assignment.create', target: principal.displayName, reason: body.reason, hasParameters: true });
    return { assignment };
  });

  disable('DELETE', '/v1/access/assignments/:roleAssignmentId', 'Removing an access assignment');

  read<WorkspaceFriendlyNameResponse>('/v1/workspace/friendly-name', ({ state }) => ({ friendlyName: state.workspaceFriendlyName }));

  simulate<WorkspaceFriendlyNameResponse, UpdateWorkspaceFriendlyNameRequest>('PATCH', '/v1/workspace/friendly-name', ({ body, state }) => {
    const friendlyName = body?.friendlyName?.trim();
    if (!friendlyName) throw badRequest('A friendly name is required.');
    if (friendlyName.length > 64) throw badRequest('The friendly name must be 64 characters or fewer.');
    state.workspaceFriendlyName = friendlyName;
    recordAudit(state, { action: 'workspace.friendlyname.update', target: 'WS-CONTOSO-PROD', reason: body.reason, hasParameters: true });
    return { friendlyName };
  });
}
