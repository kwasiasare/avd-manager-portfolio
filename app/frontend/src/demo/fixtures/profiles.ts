import type { ProfileVhd, ProfilesListResponse, RetiredProfileVhd } from '@avdmgr/shared';
import { DAY, HOUR, ago } from './time';
import { FSLOGIX_SHARE, STORAGE_ACCOUNT, upn } from './estate';
import { buildFslogixUsage } from './cost';

const GIB = 1024 ** 3;

/** 40 fictional users. sizes are GiB; flags mark the interesting rows. */
interface Seed {
  user: string;
  sizeGb: number;
  daysAgo: number;
  orphan?: boolean;
  locked?: string;
  duplicate?: boolean;
}

const SEEDS: Seed[] = [
  { user: 'alex.rivera', sizeGb: 8.4, daysAgo: 0, locked: 'avd-con-0' },
  { user: 'priya.nair', sizeGb: 11.2, daysAgo: 0 },
  { user: 'sam.okafor', sizeGb: 6.1, daysAgo: 1 },
  { user: 'li.wei', sizeGb: 9.8, daysAgo: 0 },
  { user: 'maria.santos', sizeGb: 24.6, daysAgo: 0 },
  { user: 'tom.becker', sizeGb: 7.3, daysAgo: 0 },
  { user: 'aisha.khan', sizeGb: 13.9, daysAgo: 1 },
  { user: 'jonas.lind', sizeGb: 5.2, daysAgo: 0 },
  { user: 'nina.petrova', sizeGb: 31.5, daysAgo: 0 },
  { user: 'diego.alvarez', sizeGb: 10.7, daysAgo: 2 },
  { user: 'grace.mensah', sizeGb: 8.8, daysAgo: 0 },
  { user: 'oliver.price', sizeGb: 12.4, daysAgo: 0 },
  { user: 'fatima.zahra', sizeGb: 6.9, daysAgo: 0 },
  { user: 'ben.hartley', sizeGb: 22.3, daysAgo: 1 },
  { user: 'chloe.dubois', sizeGb: 4.8, daysAgo: 3 },
  { user: 'kofi.adjei', sizeGb: 9.1, daysAgo: 4 },
  { user: 'hannah.mueller', sizeGb: 7.7, daysAgo: 2 },
  { user: 'ravi.menon', sizeGb: 14.2, daysAgo: 5 },
  { user: 'sofia.rossi', sizeGb: 5.6, daysAgo: 1 },
  { user: 'yusuf.demir', sizeGb: 10.3, daysAgo: 6 },
  { user: 'emma.clarke', sizeGb: 8.1, daysAgo: 2 },
  { user: 'lucas.martin', sizeGb: 6.4, daysAgo: 7 },
  { user: 'zara.ahmed', sizeGb: 11.8, daysAgo: 3 },
  { user: 'henrik.berg', sizeGb: 9.5, daysAgo: 9 },
  { user: 'ines.moreau', sizeGb: 7.0, daysAgo: 4 },
  { user: 'daniel.owusu', sizeGb: 15.6, daysAgo: 1 },
  { user: 'mei.tanaka', sizeGb: 5.9, daysAgo: 8 },
  { user: 'carlos.vega', sizeGb: 12.9, daysAgo: 2 },
  { user: 'olga.ivanova', sizeGb: 6.6, daysAgo: 11 },
  { user: 'james.whitfield', sizeGb: 17.4, daysAgo: 5 },
  { user: 'amara.nwosu', sizeGb: 8.9, daysAgo: 3 },
  { user: 'felix.wagner', sizeGb: 4.4, daysAgo: 14 },
  { user: 'layla.hassan', sizeGb: 10.0, daysAgo: 6 },
  { user: 'marcus.reid', sizeGb: 13.1, daysAgo: 1 },
  { user: 'tessa.brooks', sizeGb: 7.5, daysAgo: 10 },
  { user: 'noah.fischer', sizeGb: 9.3, daysAgo: 4, duplicate: true },
  { user: 'former.contractor1', sizeGb: 3.9, daysAgo: 124, orphan: true },
  { user: 'former.contractor2', sizeGb: 6.2, daysAgo: 211, orphan: true },
  { user: 'ella.jensen', sizeGb: 8.0, daysAgo: 2 },
  { user: 'victor.lopes', sizeGb: 5.1, daysAgo: 12 },
];

const sidFor = (index: number) => `S-1-12-1-1000000000-2000000000-3000000000-${4000000000 + index * 17}`;

export function buildProfiles(now: number): ProfilesListResponse {
  const profiles: ProfileVhd[] = SEEDS.map((seed, index): ProfileVhd => {
    const sid = sidFor(index);
    const folderName = `${seed.user}_${sid}`;
    const sizeBytes = Math.round(seed.sizeGb * GIB);
    return {
      id: `${STORAGE_ACCOUNT}/${FSLOGIX_SHARE}/${folderName}/Profile_${seed.user}.vhdx`,
      folderName,
      fileName: `Profile_${seed.user}.vhdx`,
      kind: 'directory',
      sid,
      userPrincipalName: seed.orphan ? undefined : upn(seed.user),
      nameParseQuality: 'username_sid',
      sizeBytes,
      sizeGb: seed.sizeGb,
      lastModified: ago(now, seed.daysAgo * DAY + 2 * HOUR),
      oversized: seed.sizeGb >= 20,
      orphanStatus: seed.orphan ? 'orphan' : 'not-orphan',
      orphanEvidence: seed.orphan ? 'No matching user object in Microsoft Entra ID for this SID (account deleted).' : 'Matching enabled user found in Microsoft Entra ID.',
      locked: seed.locked !== undefined,
      lockedBy: seed.locked,
      activeSiblingCount: seed.duplicate ? 2 : 1,
      duplicateContainer: seed.duplicate === true,
    };
  });

  const retiredSeed = [
    { user: 'chloe.dubois', index: 14, retiredDaysAgo: 3, sizeGb: 4.1 },
    { user: 'emma.clarke', index: 20, retiredDaysAgo: 9, sizeGb: 7.8 },
    { user: 'olga.ivanova', index: 28, retiredDaysAgo: 21, sizeGb: 6.0 },
  ];
  const retired: RetiredProfileVhd[] = retiredSeed.map((entry) => {
    const sid = sidFor(entry.index);
    const retiredAt = ago(now, entry.retiredDaysAgo * DAY);
    const stamp = retiredAt.slice(0, 10).replace(/-/g, '');
    return {
      id: `${STORAGE_ACCOUNT}/${FSLOGIX_SHARE}/${entry.user}_${sid}/Profile_${entry.user}.vhdx.retired-${stamp}`,
      folderName: `${entry.user}_${sid}`,
      kind: 'directory',
      sid,
      userPrincipalName: upn(entry.user),
      nameParseQuality: 'username_sid',
      retiredFileName: `Profile_${entry.user}.vhdx.retired-${stamp}`,
      originalFileName: `Profile_${entry.user}.vhdx`,
      sizeBytes: Math.round(entry.sizeGb * GIB),
      sizeGb: entry.sizeGb,
      lastModified: retiredAt,
      retiredAt,
    };
  });

  return {
    storageAccountName: STORAGE_ACCOUNT,
    shareName: FSLOGIX_SHARE,
    oversizedThresholdGb: 20,
    generatedAt: ago(now, 30_000),
    fileRest: { status: 'available' },
    partial: false,
    profiles,
    retired,
    orphanDetection: { status: 'available' },
    fallbackShareUsage: buildFslogixUsage(),
  } satisfies ProfilesListResponse;
}
