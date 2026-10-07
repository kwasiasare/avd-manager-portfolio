import type { IntunePolicyHealthResponse } from '@avdmgr/shared';
import { DAY, HOUR, ago, fakeGuid } from './time';

/** 6 hosts; 2 flagged (policy errors on avd-con-3, missing FSLogix ADMX on avd-con-5). */
export function buildPolicyHealth(now: number): IntunePolicyHealthResponse {
  const ok = (name: string, n: number): IntunePolicyHealthResponse['hosts'][number] => ({
    hostName: name,
    status: 'ok',
    evidence: { deviceId: fakeGuid(800 + n), lastSyncDateTime: ago(now, (n + 1) * HOUR), errorSettingCount: 0, admxSignatureDetectable: true },
  });
  return {
    hosts: [
      ok('avd-con-0', 0),
      ok('avd-con-1', 1),
      ok('avd-con-2', 2),
      {
        hostName: 'avd-con-3',
        status: 'policy-errors',
        evidence: {
          deviceId: fakeGuid(803),
          lastSyncDateTime: ago(now, 2 * HOUR),
          errorSettingCount: 2,
          fsLogixErrorSettings: ['FSLogix > Profile Containers > VHD Locations', 'FSLogix > Profile Containers > Size in MBs'],
          admxSignatureDetectable: true,
          correlationId: fakeGuid(899),
        },
        remediation: 'Force an Intune sync on the device and confirm the FSLogix ADMX template is assigned; the two listed settings are reporting an error state.',
      },
      { hostName: 'avd-con-4', status: 'not-enrolled', evidence: { admxSignatureDetectable: false }, remediation: 'Host is deallocated, so no recent Intune check-in was found. Start it and re-check.' },
      {
        hostName: 'avd-con-5',
        status: 'missing-admx',
        evidence: { deviceId: fakeGuid(805), lastSyncDateTime: ago(now, 3 * DAY), errorSettingCount: 0, duplicateDeviceRecords: true, admxSignatureDetectable: false },
        remediation: 'The FSLogix ADMX template has not been delivered to this host and a duplicate Intune device record exists. Remove the stale record and re-sync.',
      },
    ],
    generatedAt: ago(now, 40_000),
    cached: false,
  } satisfies IntunePolicyHealthResponse;
}
