import type { AccessSearchResult, DesktopAssignment } from '@avdmgr/shared';
import { DAG_NAME, RG, SUBSCRIPTION_ID, armId, upn } from './estate';
import { fakeGuid } from './time';

export const DAG_SCOPE = armId(RG.hostPools, `Microsoft.DesktopVirtualization/applicationGroups/${DAG_NAME}`);

/** Everyone searchable in the demo "directory" (users + groups). */
export const DIRECTORY: AccessSearchResult[] = [
  { id: fakeGuid(601), principalType: 'group', displayName: 'SG-AVD-Users-Finance' },
  { id: fakeGuid(602), principalType: 'group', displayName: 'SG-AVD-Users-Engineering' },
  { id: fakeGuid(603), principalType: 'group', displayName: 'SG-AVD-Users-Support' },
  { id: fakeGuid(604), principalType: 'group', displayName: 'SG-AVD-Contractors' },
  { id: fakeGuid(611), principalType: 'user', displayName: 'Alex Rivera', userPrincipalName: upn('alex.rivera') },
  { id: fakeGuid(612), principalType: 'user', displayName: 'Priya Nair', userPrincipalName: upn('priya.nair') },
  { id: fakeGuid(613), principalType: 'user', displayName: 'Sam Okafor', userPrincipalName: upn('sam.okafor') },
  { id: fakeGuid(614), principalType: 'user', displayName: 'Li Wei', userPrincipalName: upn('li.wei') },
  { id: fakeGuid(615), principalType: 'user', displayName: 'Maria Santos', userPrincipalName: upn('maria.santos') },
  { id: fakeGuid(616), principalType: 'user', displayName: 'Tom Becker', userPrincipalName: upn('tom.becker') },
  { id: fakeGuid(617), principalType: 'user', displayName: 'Aisha Khan', userPrincipalName: upn('aisha.khan') },
  { id: fakeGuid(618), principalType: 'user', displayName: 'Jonas Lind', userPrincipalName: upn('jonas.lind') },
  { id: fakeGuid(619), principalType: 'user', displayName: 'Nina Petrova', userPrincipalName: upn('nina.petrova') },
  { id: fakeGuid(620), principalType: 'user', displayName: 'Diego Alvarez', userPrincipalName: upn('diego.alvarez') },
];

export function buildAssignments(): DesktopAssignment[] {
  const direct = (n: number, principal: AccessSearchResult): DesktopAssignment => ({
    roleAssignmentId: armId(RG.hostPools, `Microsoft.Authorization/roleAssignments/${fakeGuid(700 + n)}`),
    principalId: principal.id,
    principalType: principal.principalType === 'group' ? 'Group' : 'User',
    displayName: principal.displayName,
    userPrincipalName: principal.userPrincipalName,
    scope: DAG_SCOPE,
    assignedDirectlyOnDag: true,
    assignedVia: 'Direct on DAG',
  });
  const [finance, engineering, support, contractors] = DIRECTORY;
  return [
    direct(1, finance),
    direct(2, engineering),
    direct(3, support),
    direct(4, contractors),
    {
      roleAssignmentId: `/subscriptions/${SUBSCRIPTION_ID}/providers/Microsoft.Authorization/roleAssignments/${fakeGuid(710)}`,
      principalId: fakeGuid(612),
      principalType: 'User',
      displayName: 'Priya Nair',
      userPrincipalName: upn('priya.nair'),
      scope: `/subscriptions/${SUBSCRIPTION_ID}`,
      assignedDirectlyOnDag: false,
      assignedVia: 'Inherited from subscription',
    },
  ] satisfies DesktopAssignment[];
}
