import type { ProfilesListResponse } from '@avdmgr/shared';
import { buildProfiles } from '../fixtures/profiles';
import { disable, read } from '../router';

const PROFILES = '/v1/profiles';

/** Profile listing is read-only; every VHD-touching action is disabled (they rename/delete real files on a real share). */
export function registerProfileRoutes(): void {
  read<ProfilesListResponse>(PROFILES, ({ state }) => buildProfiles(state.now));
  disable('POST', `${PROFILES}/:profileFolderName/reset`, 'Resetting a profile');
  disable('POST', `${PROFILES}/:profileFolderName/restore`, 'Restoring a profile');
  disable('DELETE', `${PROFILES}/:profileFolderName/retired/:retiredFileName`, 'Permanently deleting a retired profile');
  disable('POST', `${PROFILES}/:profileFolderName/duplicates/resolve`, 'Resolving a duplicate profile container');
}
